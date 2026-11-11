// Radar sites. Each one is the centre of the scope; aircraft are fetched inside a box around it.
// Keeping the box at or under 25 square degrees makes each OpenSky request cost 1 credit.
export const MAX_RANGE_NM = 120;

export const REGIONS = [
  { id: 'dc', name: 'Washington, DC', code: 'DCA', lat: 38.8512, lon: -77.0402 },
  { id: 'nyc', name: 'New York', code: 'JFK', lat: 40.6413, lon: -73.7781 },
  { id: 'lax', name: 'Los Angeles', code: 'LAX', lat: 33.9416, lon: -118.4085 },
];

export function regionById(id) {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}

/** Latitude/longitude box that contains a circle of `rangeNm` around the region centre. */
export function boundingBox(region, rangeNm = MAX_RANGE_NM) {
  const dLat = rangeNm / 60;
  const dLon = rangeNm / (60 * Math.cos((region.lat * Math.PI) / 180));
  return {
    lamin: region.lat - dLat,
    lamax: region.lat + dLat,
    lomin: region.lon - dLon,
    lomax: region.lon + dLon,
  };
}

export function boxAreaSqDeg(box) {
  return (box.lamax - box.lamin) * (box.lomax - box.lomin);
}
