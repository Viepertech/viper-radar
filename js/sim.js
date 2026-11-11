// Simulated traffic: used when neither live data nor a snapshot is available.
// Callsigns are fictional and every simulated contact is labelled as such in the UI.
import { deadReckon, toLocalNm, rangeBearing } from './geo.js';

const PREFIXES = ['VPR', 'NVX', 'ZEP', 'KRT'];
const KT_TO_MS = 1852 / 3600;

/** Small seeded random generator so the simulation is reproducible (and testable). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offset(region, rangeNm, bearingDeg) {
  const b = (bearingDeg * Math.PI) / 180;
  const y = rangeNm * Math.cos(b);
  const x = rangeNm * Math.sin(b);
  return { lat: region.lat + y / 60, lon: region.lon + x / (60 * Math.cos((region.lat * Math.PI) / 180)) };
}

function spawn(region, rand, nowSec, index, atEdge) {
  const bearing = rand() * 360;
  const range = atEdge ? 110 : 8 + rand() * 100;
  const pos = offset(region, range, bearing);
  const kt = 140 + rand() * 340;
  const track = atEdge ? (bearing + 180 + (rand() - 0.5) * 80 + 360) % 360 : rand() * 360;
  const altFt = Math.round((1500 + ((kt - 140) / 340) * 35000 + (rand() - 0.5) * 4000) / 100) * 100;
  const climbing = rand();
  return {
    icao24: Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0'),
    callsign: `${PREFIXES[index % PREFIXES.length]}${100 + Math.floor(rand() * 900)}`,
    country: 'Simulated',
    timePosition: nowSec,
    lastContact: nowSec,
    lat: pos.lat,
    lon: pos.lon,
    altitude: Math.max(altFt, 1000) / 3.28084,
    onGround: false,
    velocity: kt * KT_TO_MS,
    track,
    verticalRate: climbing < 0.2 ? 7 : climbing > 0.85 ? -6 : 0,
    squawk: index === 3 ? '7700' : String(1000 + Math.floor(rand() * 6000)).replace(/[89]/g, '7'),
    source: 'SIM',
  };
}

export function createSimTraffic(region, { count = 26, seed = 7, nowSec = Date.now() / 1000 } = {}) {
  const rand = mulberry32(seed);
  const aircraft = Array.from({ length: count }, (_, i) => spawn(region, rand, nowSec, i, false));
  return { aircraft, rand };
}

/** Moves every simulated aircraft to `nowSec`; any that left the scope re-enter from the edge. */
export function advanceSim(sim, region, nowSec, maxRangeNm = 118) {
  sim.aircraft = sim.aircraft.map((a, i) => {
    const p = deadReckon(a.lat, a.lon, a.velocity, a.track, nowSec - a.timePosition);
    const { x, y } = toLocalNm(p.lat, p.lon, region);
    if (rangeBearing(x, y).range > maxRangeNm) return spawn(region, sim.rand, nowSec, i, true);
    return { ...a, lat: p.lat, lon: p.lon, timePosition: nowSec, lastContact: nowSec };
  });
  return sim;
}
