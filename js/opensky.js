// OpenSky Network REST API: request URL and response parsing.
// Docs: https://openskynetwork.github.io/opensky-api/rest.html
export const API_BASE = 'https://opensky-network.org/api';

export const POSITION_SOURCES = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];
export const EMERGENCY_SQUAWKS = { 7500: 'HIJACK', 7600: 'RADIO FAILURE', 7700: 'EMERGENCY' };

export function statesUrl(box) {
  const q = new URLSearchParams({
    lamin: box.lamin.toFixed(4),
    lomin: box.lomin.toFixed(4),
    lamax: box.lamax.toFixed(4),
    lomax: box.lomax.toFixed(4),
  });
  return `${API_BASE}/states/all?${q}`;
}

/**
 * Turns the /states/all response (an array of arrays) into named objects.
 * State vector indices: 0 icao24, 1 callsign, 2 origin_country, 3 time_position,
 * 4 last_contact, 5 longitude, 6 latitude, 7 baro_altitude (m), 8 on_ground,
 * 9 velocity (m/s), 10 true_track (deg), 11 vertical_rate (m/s), 13 geo_altitude (m),
 * 14 squawk, 16 position_source.
 */
export function parseStates(json) {
  const time = json?.time ?? Math.floor(Date.now() / 1000);
  const aircraft = (json?.states ?? [])
    .filter((s) => s[5] != null && s[6] != null)
    .map((s) => ({
      icao24: s[0],
      callsign: (s[1] ?? '').trim() || null,
      country: s[2] ?? null,
      timePosition: s[3] ?? time,
      lastContact: s[4] ?? time,
      lon: s[5],
      lat: s[6],
      altitude: s[7] ?? s[13] ?? null,
      onGround: Boolean(s[8]),
      velocity: s[9] ?? null,
      track: s[10] ?? null,
      verticalRate: s[11] ?? null,
      squawk: s[14] ?? null,
      source: POSITION_SOURCES[s[16]] ?? null,
    }));
  return { time, aircraft };
}

export function emergencyLabel(squawk) {
  return EMERGENCY_SQUAWKS[squawk] ?? null;
}
