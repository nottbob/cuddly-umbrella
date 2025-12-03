export function pad(n){ return String(n).padStart(2,"0"); }

export function toHM(date){
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

export const oneDec = n => (n == null ? null : Number(n.toFixed(1)));
export const CtoF = c => (c * 9) / 5 + 32;
export const mpsToKts = ms => ms * 1.94384;

export function degToCardinal(deg){
  if (deg == null || isNaN(deg)) return null;
  const dirs = [
    "N","NNE","NE","ENE","E","ESE","SE","SSE",
    "S","SSW","SW","WSW","W","WNW","NW","NNW"
  ];
  return dirs[Math.floor((deg % 360) / 22.5 + 0.5) % 16];
}
