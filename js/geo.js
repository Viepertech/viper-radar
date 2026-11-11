// Small-area navigation maths. Within ~120 nm a flat (equirectangular) projection is accurate
// to well under a pixel on the scope, so no map library is needed.
export const M_PER_NM = 1852;
export const MS_TO_KT = 3600 / M_PER_NM;
export const M_TO_FT = 3.28084;
export const MS_TO_FPM = M_TO_FT * 60;
const RAD = Math.PI / 180;

/** Position relative to the radar centre in nautical miles (x = east, y = north). */
export function toLocalNm(lat, lon, origin) {
  return {
    x: (lon - origin.lon) * 60 * Math.cos(origin.lat * RAD),
    y: (lat - origin.lat) * 60,
  };
}

/** Range (nm) and bearing (degrees clockwise from north, 0-360) of a local position. */
export function rangeBearing(x, y) {
  return { range: Math.hypot(x, y), bearing: ((Math.atan2(x, y) / RAD) + 360) % 360 };
}

/**
 * Dead reckoning: where an aircraft is `dtSec` after a fix, assuming it holds
 * its ground speed (m/s) and true track (degrees). Returns { lat, lon }.
 */
export function deadReckon(lat, lon, speedMs, trackDeg, dtSec) {
  if (!speedMs || trackDeg == null || !dtSec) return { lat, lon };
  const distNm = (speedMs * dtSec) / M_PER_NM;
  const t = trackDeg * RAD;
  const newLat = lat + (distNm * Math.cos(t)) / 60;
  const midLat = ((lat + newLat) / 2) * RAD;
  return { lat: newLat, lon: lon + (distNm * Math.sin(t)) / (60 * Math.cos(midLat)) };
}

/** US style: flight levels at or above the 18,000 ft transition altitude, feet below it. */
export function formatAltitude(meters) {
  if (meters == null) return '---';
  const ft = meters * M_TO_FT;
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${Math.round(ft / 100) * 100} ft`;
}

export function knots(speedMs) {
  return speedMs == null ? null : Math.round(speedMs * MS_TO_KT);
}
