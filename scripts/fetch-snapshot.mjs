#!/usr/bin/env node
// Fetches one OpenSky snapshot per radar site and writes data/<site>.json.
// Runs in GitHub Actions on a schedule, so the deployed page always has recent data
// even when a visitor's browser cannot call the OpenSky API directly.
//
// Optional: set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (repository secrets) to use a free
// OpenSky account (4,000 credits/day) instead of anonymous access (400/day, shared per IP).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REGIONS, MAX_RANGE_NM, boundingBox } from '../js/regions.js';
import { statesUrl, parseStates } from '../js/opensky.js';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

async function getToken(env, fetchImpl) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

export async function run({ outDir = 'data', env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  await mkdir(outDir, { recursive: true });
  let token = null;
  try {
    token = await getToken(env, fetchImpl);
    log(token ? 'Using OpenSky OAuth client credentials.' : 'No credentials set: anonymous access.');
  } catch (err) {
    log(`Auth failed (${err.message}); continuing anonymously.`);
  }

  const written = [];
  for (const region of REGIONS) {
    try {
      const res = await fetchImpl(statesUrl(boundingBox(region, MAX_RANGE_NM)), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20000),
      });
      const remaining = res.headers?.get?.('x-rate-limit-remaining');
      if (!res.ok) {
        const retry = res.headers?.get?.('x-rate-limit-retry-after-seconds');
        log(`${region.id}: HTTP ${res.status}${retry ? ` (retry after ${retry} s)` : ''}; keeping no snapshot.`);
        continue;
      }
      const { time, aircraft } = parseStates(await res.json());
      const snapshot = { region: region.id, fetchedAt: new Date().toISOString(), time, aircraft };
      const file = join(outDir, `${region.id}.json`);
      await writeFile(file, JSON.stringify(snapshot));
      written.push(file);
      log(`${region.id}: ${aircraft.length} aircraft -> ${file}${remaining ? ` (credits left: ${remaining})` : ''}`);
    } catch (err) {
      log(`${region.id}: ${err.message}; keeping no snapshot.`);
    }
  }
  return written;
}

// Never fail the workflow: without a snapshot the site simply falls back to simulation.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => console.log(`Snapshot run failed: ${err.message}`));
}
