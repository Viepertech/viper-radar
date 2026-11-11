import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REGIONS, MAX_RANGE_NM, boundingBox, boxAreaSqDeg } from '../js/regions.js';
import { toLocalNm, rangeBearing, deadReckon, formatAltitude, knots } from '../js/geo.js';
import { parseStates, statesUrl, emergencyLabel } from '../js/opensky.js';
import { createSimTraffic, advanceSim } from '../js/sim.js';
import { run } from '../scripts/fetch-snapshot.mjs';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const DC = REGIONS[0];

// A realistic /states/all response: one airborne jet, one aircraft on the ground, one without a position.
const SAMPLE = {
  time: 1762880000,
  states: [
    ['a1b2c3', 'AAL123  ', 'United States', 1762879998, 1762879999, -77.0, 39.0, 10668, false, 231.5, 90, 0, null, 10800, '3512', false, 0],
    ['d4e5f6', 'N123AB  ', 'United States', 1762879990, 1762879995, -77.04, 38.85, null, true, 5, 180, null, null, null, null, false, 0],
    ['abcdef', null, 'Canada', null, 1762879900, null, null, null, false, null, null, null, null, null, null, false, 0],
  ],
};

test('every site box stays within 1 OpenSky credit (25 sq deg)', () => {
  for (const r of REGIONS) assert.ok(boxAreaSqDeg(boundingBox(r, MAX_RANGE_NM)) <= 25, r.id);
});

test('statesUrl encodes the bounding box', () => {
  const url = new URL(statesUrl(boundingBox(DC)));
  assert.equal(url.pathname, '/api/states/all');
  near(Number(url.searchParams.get('lamin')), DC.lat - 2, 1e-3);
});

test('one degree of latitude north is 60 nm on bearing 000', () => {
  const { x, y } = toLocalNm(DC.lat + 1, DC.lon, DC);
  const { range, bearing } = rangeBearing(x, y);
  near(range, 60, 1e-9);
  near(bearing, 0, 1e-9);
});

test('a point due east is on bearing 090', () => {
  const { x, y } = toLocalNm(DC.lat, DC.lon + 0.5, DC);
  near(rangeBearing(x, y).bearing, 90, 1e-9);
});

test('dead reckoning: 480 kt for 15 minutes due east covers 120 nm', () => {
  const speedMs = (480 * 1852) / 3600;
  const p = deadReckon(DC.lat, DC.lon, speedMs, 90, 15 * 60);
  const { x, y } = toLocalNm(p.lat, p.lon, DC);
  near(x, 120, 0.5);
  near(y, 0, 1e-9);
});

test('dead reckoning with no speed or track stays put', () => {
  assert.deepEqual(deadReckon(1, 2, null, 90, 60), { lat: 1, lon: 2 });
  assert.deepEqual(deadReckon(1, 2, 200, null, 60), { lat: 1, lon: 2 });
});

test('altitudes use flight levels at and above 18,000 ft', () => {
  assert.equal(formatAltitude(10668), 'FL350');
  assert.equal(formatAltitude(1219.2), '4000 ft');
  assert.equal(formatAltitude(null), '---');
  assert.equal(knots(231.5), 450);
});

test('parseStates names the fields and drops aircraft without a position', () => {
  const { time, aircraft } = parseStates(SAMPLE);
  assert.equal(time, SAMPLE.time);
  assert.equal(aircraft.length, 2);
  assert.equal(aircraft[0].callsign, 'AAL123');
  assert.equal(aircraft[0].altitude, 10668);
  assert.equal(aircraft[0].source, 'ADS-B');
  assert.equal(aircraft[1].onGround, true);
  assert.equal(aircraft[1].altitude, null);
});

test('parseStates tolerates an empty response', () => {
  assert.deepEqual(parseStates({ time: 5, states: null }).aircraft, []);
});

test('emergency squawks are recognised', () => {
  assert.equal(emergencyLabel('7700'), 'EMERGENCY');
  assert.equal(emergencyLabel('7600'), 'RADIO FAILURE');
  assert.equal(emergencyLabel('1200'), null);
});

test('simulation is reproducible and keeps every aircraft on the scope', () => {
  const a = createSimTraffic(DC, { seed: 3, nowSec: 0 });
  const b = createSimTraffic(DC, { seed: 3, nowSec: 0 });
  assert.deepEqual(a.aircraft, b.aircraft);
  for (let t = 60; t <= 3600; t += 60) advanceSim(a, DC, t);
  for (const ac of a.aircraft) {
    const { x, y } = toLocalNm(ac.lat, ac.lon, DC);
    assert.ok(rangeBearing(x, y).range <= 118);
  }
});

test('snapshot script writes one file per site from a mocked API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-'));
  const fakeFetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'x-rate-limit-remaining': '397' }), json: async () => SAMPLE });
  const files = await run({ outDir: dir, env: {}, fetchImpl: fakeFetch, log: () => {} });
  assert.equal(files.length, REGIONS.length);
  const snap = JSON.parse(await readFile(join(dir, 'dc.json'), 'utf8'));
  assert.equal(snap.region, 'dc');
  assert.equal(snap.aircraft.length, 2);
});

test('snapshot script survives API errors without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-'));
  const failing = async () => ({ ok: false, status: 429, headers: new Headers({ 'x-rate-limit-retry-after-seconds': '3600' }) });
  const files = await run({ outDir: dir, env: {}, fetchImpl: failing, log: () => {} });
  assert.deepEqual(files, []);
});
