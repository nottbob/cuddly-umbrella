// js/tides_sun.js
// EXACT same behavior as your old inline code.
// Provides: getTideData(), getSunData(), getTideDate()

// NOAA tide station for SPI
const NOAA_TIDE_STATION = "8779750";

// SPI coordinates
const LAT = 26.07139;
const LON = -97.12872;

/* --------------------------- */
/* UTIL — SAME AS BEFORE       */
/* --------------------------- */
function pad(n) {
  return String(n).padStart(2, "0");
}

function toMil(d) {
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* --------------------------- */
/* TIDE DATA (unchanged)       */
/* --------------------------- */
export async function getTideData() {
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?product=predictions` +
    `&station=${NOAA_TIDE_STATION}` +
    `&date=today&interval=hilo&units=english` +
    `&time_zone=lst_ldt&datum=MLLW&format=json`;

  try {
    const r = await fetch(url);
    const t = await r.json();

    const low = t.predictions.find(x => x.type === "L");
    const high = t.predictions.find(x => x.type === "H");

    return {
      low: low
        ? {
            time: toMil(new Date(low.t)),
            height: Number(low.v).toFixed(1)
          }
        : null,

      high: high
        ? {
            time: toMil(new Date(high.t)),
            height: Number(high.v).toFixed(1)
          }
        : null
    };

  } catch (e) {
    console.error("[TIDE ERROR]", e);
    return { low: null, high: null };
  }
}

/* --------------------------- */
/* SUNRISE + SUNSET (unchanged)*/
/* --------------------------- */
export async function getSunData() {
  const url = `https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LON}&formatted=0`;

  try {
    const r = await fetch(url);
    const s = await r.json();
    const res = s.results;

    return {
      sunrise: toMil(new Date(res.sunrise)),
      sunset: toMil(new Date(res.sunset))
    };

  } catch (e) {
    console.error("[SUN ERROR]", e);
    return { sunrise: "--", sunset: "--" };
  }
}

/* --------------------------- */
/* DATE FORMAT (unchanged)     */
/* --------------------------- */
export function getTideDate() {
  const now = new Date();
  const dd = pad(now.getDate());
  const mm = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][now.getMonth()];
  const yy = String(now.getFullYear()).slice(2);

  return `${dd} ${mm} ${yy}`;
}
