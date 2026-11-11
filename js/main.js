import { REGIONS, MAX_RANGE_NM, regionById, boundingBox } from './regions.js';
import { toLocalNm, deadReckon, formatAltitude, knots, M_TO_FT, MS_TO_FPM } from './geo.js';
import { statesUrl, parseStates, emergencyLabel } from './opensky.js';
import { createSimTraffic, advanceSim } from './sim.js';
import { Radar } from './radar.js';

const LIVE_POLL_MS = 20_000; // anonymous OpenSky data refreshes every 10 s; 20 s saves credits
const SNAPSHOT_RELOAD_MS = 5 * 60_000;
const SIM_STEP_MS = 5_000;
const MAX_SNAPSHOT_AGE_S = 6 * 3600;
const MAX_EXTRAPOLATION_S = { live: 90, snapshot: 300, sim: 10 };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const radar = new Radar($('scope'));

const state = {
  region: regionById(params.get('region') ?? 'dc'),
  source: params.get('source') === 'sim' ? 'sim' : 'auto',
  mode: null, // 'live' | 'snapshot' | 'sim'
  aircraft: [],
  dataTime: null,
  rebase: 0, // seconds added to snapshot timestamps so a replay starts "now"
  sim: null,
  timer: null,
  liveFailures: 0,
  loadToken: 0,
};

// ── data sources ──────────────────────────────────────────────────────────────
async function fetchLive(region) {
  const res = await fetch(statesUrl(boundingBox(region, MAX_RANGE_NM)), { signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  return parseStates(await res.json());
}

async function fetchSnapshot(region) {
  const res = await fetch(`data/${region.id}.json`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const snap = await res.json();
  if (Date.now() / 1000 - snap.time > MAX_SNAPSHOT_AGE_S) throw new Error('snapshot too old');
  return snap;
}

function useData(mode, data) {
  state.mode = mode;
  state.aircraft = data.aircraft.filter((a) => !a.onGround);
  state.dataTime = data.time;
  state.rebase = mode === 'snapshot' ? Date.now() / 1000 - data.time : 0;
}

function startSim() {
  state.sim = createSimTraffic(state.region, { nowSec: Date.now() / 1000, seed: 7 + REGIONS.indexOf(state.region) });
  useData('sim', { time: Date.now() / 1000, aircraft: state.sim.aircraft });
  schedule(() => {
    advanceSim(state.sim, state.region, Date.now() / 1000);
    useData('sim', { time: Date.now() / 1000, aircraft: state.sim.aircraft });
  }, SIM_STEP_MS);
}

function schedule(fn, ms) {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!document.hidden) fn(); // pause polling in background tabs to save API credits
  }, ms);
}

/** Live data if the browser can reach OpenSky, else the latest GitHub Actions snapshot, else simulation. */
async function load() {
  const token = ++state.loadToken;
  clearInterval(state.timer);
  radar.reset();
  radar.centerLabel = state.region.code;
  setStatus('acquiring', 'Contacting OpenSky…');
  const stale = () => token !== state.loadToken;

  if (state.source === 'sim') return startSim();
  try {
    const data = await fetchLive(state.region);
    if (stale()) return;
    useData('live', data);
    state.liveFailures = 0;
    schedule(pollLive, LIVE_POLL_MS);
    return;
  } catch (err) {
    console.info('Live feed unavailable:', err.message);
  }
  if (stale()) return;
  try {
    const snap = await fetchSnapshot(state.region);
    if (stale()) return;
    useData('snapshot', snap);
    schedule(async () => {
      try {
        useData('snapshot', await fetchSnapshot(state.region));
      } catch (err) {
        console.info('Snapshot reload failed:', err.message);
      }
    }, SNAPSHOT_RELOAD_MS);
    return;
  } catch (err) {
    console.info('Snapshot unavailable:', err.message);
  }
  if (!stale()) startSim();
}

async function pollLive() {
  try {
    useData('live', await fetchLive(state.region));
    state.liveFailures = 0;
  } catch (err) {
    state.liveFailures += 1;
    console.info('Live poll failed:', err.message);
    if (state.liveFailures >= 3) load(); // e.g. daily credits used up: fall back
  }
}

// ── per-frame targets ─────────────────────────────────────────────────────────
function targetsAt(nowSec) {
  const maxDt = MAX_EXTRAPOLATION_S[state.mode] ?? 60;
  return state.aircraft.map((a) => {
    const dt = Math.min(Math.max(nowSec - (a.timePosition + state.rebase), 0), maxDt);
    const p = deadReckon(a.lat, a.lon, a.velocity, a.track, dt);
    const { x, y } = toLocalNm(p.lat, p.lon, state.region);
    const vs = a.verticalRate ?? 0;
    return {
      id: a.icao24,
      x,
      y,
      data: {
        ...a,
        id: a.icao24,
        alt: formatAltitude(a.altitude),
        kt: knots(a.velocity),
        vsArrow: vs > 1 ? '↑' : vs < -1 ? '↓' : '',
        emergency: emergencyLabel(a.squawk),
      },
    };
  });
}

function frame(nowMs) {
  radar.update(nowMs, state.mode ? targetsAt(Date.now() / 1000) : []);
  radar.draw(nowMs);
  requestAnimationFrame(frame);
}

// ── side panel ────────────────────────────────────────────────────────────────
const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 19) + 'Z';

function setStatus(kind, detail) {
  const labels = { acquiring: 'ACQUIRING', live: 'LIVE', snapshot: 'SNAPSHOT', sim: 'SIMULATED' };
  $('status').className = `status ${kind}`;
  $('status').textContent = `● ${labels[kind]}`;
  $('status-detail').textContent = detail;
}

function refreshStatus() {
  if (!state.mode) return;
  if (state.mode === 'live') {
    setStatus('live', `OpenSky Network live ADS-B · data time ${hhmm(state.dataTime)} · refresh every ${LIVE_POLL_MS / 1000} s`);
  } else if (state.mode === 'snapshot') {
    const ageMin = Math.round((Date.now() / 1000 - state.dataTime) / 60);
    setStatus('snapshot', `Live feed not reachable from this browser. Replaying the snapshot taken ${hhmm(state.dataTime)} (${ageMin} min ago), positions dead-reckoned.`);
  } else {
    setStatus('sim', state.source === 'sim'
      ? 'Simulated traffic with fictional callsigns.'
      : 'Live data and snapshot unavailable, showing simulated traffic with fictional callsigns.');
  }
}

function refreshContacts() {
  const rows = [...radar.contacts.entries()]
    .filter(([, c]) => c.trail.length && c.range <= radar.rangeNm)
    .sort((a, b) => a[1].range - b[1].range);
  $('count').textContent = rows.length ? `(${rows.length})` : '';
  $('contacts-body').replaceChildren(...rows.slice(0, 40).map(([id, c]) => {
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    if (id === radar.selectedId) tr.className = 'selected';
    if (c.data.emergency) tr.classList.add('emergency');
    for (const text of [c.data.callsign ?? id, c.data.alt, c.data.kt ?? '--', `${c.range.toFixed(0)}/${String(Math.round(c.bearing) % 360).padStart(3, '0')}`]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
  refreshDetail();
}

function refreshDetail() {
  const c = radar.contacts.get(radar.selectedId);
  if (!c) {
    $('detail').className = 'muted';
    $('detail').textContent = 'Click a blip or a row below.';
    return;
  }
  const d = c.data;
  const ft = d.altitude == null ? null : Math.round(d.altitude * M_TO_FT);
  const fpm = d.verticalRate == null ? null : Math.round(d.verticalRate * MS_TO_FPM / 50) * 50;
  const ageS = Math.max(0, Math.round(Date.now() / 1000 - (d.lastContact + state.rebase)));
  const fields = [
    ['Callsign', d.callsign ?? '—'],
    ['ICAO 24-bit', d.icao24.toUpperCase()],
    ['Country', d.country ?? '—'],
    ['Altitude', ft == null ? '—' : `${ft.toLocaleString()} ft (${d.alt})`],
    ['Ground speed', d.kt == null ? '—' : `${d.kt} kt`],
    ['Track', d.track == null ? '—' : `${String(Math.round(d.track) % 360).padStart(3, '0')}°`],
    ['Vertical rate', fpm == null ? '—' : `${fpm > 0 ? '+' : ''}${fpm} ft/min`],
    ['Squawk', d.squawk ? `${d.squawk}${d.emergency ? ` · ${d.emergency}` : ''}` : '—'],
    ['Range / bearing', `${c.range.toFixed(1)} nm / ${String(Math.round(c.bearing) % 360).padStart(3, '0')}°`],
    ['Source', `${d.source ?? '—'} · last contact ${ageS} s ago`],
  ];
  const dl = document.createElement('dl');
  for (const [k, v] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (k === 'Squawk' && d.emergency) dd.className = 'emergency';
    dl.append(dt, dd);
  }
  $('detail').className = '';
  $('detail').replaceChildren(dl);
}

// ── controls ──────────────────────────────────────────────────────────────────
function setRange(nm) {
  radar.rangeNm = nm;
  for (const b of $('range').querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.nm) === nm);
}

function initControls() {
  $('region').replaceChildren(...REGIONS.map((r) => new Option(`${r.name} (${r.code})`, r.id, false, r === state.region)));
  $('region').addEventListener('change', (e) => {
    state.region = regionById(e.target.value);
    load();
  });
  $('source').value = state.source;
  $('source').addEventListener('change', (e) => {
    state.source = e.target.value;
    load();
  });
  $('range').addEventListener('click', (e) => {
    if (e.target.dataset.nm) setRange(Number(e.target.dataset.nm));
  });
  $('labels').addEventListener('change', (e) => {
    radar.showLabels = e.target.checked;
  });
  $('scope').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect();
    radar.selectedId = radar.pick(e.clientX - r.left, e.clientY - r.top, performance.now());
    refreshContacts();
  });
  $('scope').addEventListener('wheel', (e) => {
    e.preventDefault();
    const steps = [20, 40, 80, 120];
    const i = steps.indexOf(radar.rangeNm);
    setRange(steps[Math.min(steps.length - 1, Math.max(0, i + (e.deltaY > 0 ? 1 : -1)))]);
  }, { passive: false });
  $('contacts-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) {
      radar.selectedId = tr.dataset.id;
      refreshContacts();
    }
  });
  const nm = Number(params.get('range'));
  setRange([20, 40, 80, 120].includes(nm) ? nm : 80);
}

initControls();
load();
requestAnimationFrame(frame);
setInterval(() => {
  refreshStatus();
  refreshContacts();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.mode === 'live') pollLive();
});
