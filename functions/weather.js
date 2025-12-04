// ======================================================================
// WEATHER FUNCTION WITH NOAA SPA SUNRISE/SUNSET + STORMGLASS CACHE
// ======================================================================

// ❌ REMOVE THIS — Netlify already provides fetch natively
// import fetch from "node-fetch";

import { getStore } from "@netlify/blobs";

// -------------------- CONFIG --------------------
const STORMGLASS_KEY = "190fede0-cfd3-11f0-b4de-0242ac130003-190fee6c-cfd3-11f0-b4de-0242ac130003";
const WAVES_LAT = 26.071389;
const WAVES_LON = -97.128722;

const SUN_LAT = 26.07139;
const SUN_LON = -97.12872;

const store = getStore("wave-cache");   // persistent Netlify blob store


export const handler = async () => {
  try {

    // -------- WAVES WITH 4-HOUR CACHE --------
    const waves = await getWavesCached();

    // -------- BUOY DATA --------
    const gulf = await safeFetchBuoy("BZST2");
    const bay  = await safeFetchBuoy("PCGT2");

    // -------- SUNRISE / SUNSET --------
    const sun = computeSunriseSunset(SUN_LAT, SUN_LON, new Date());

    // -------- TIDES --------
    const tides = await safeFetchTides();

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ gulf, bay, waves, sun, tides })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: String(err),
        gulf: null, bay: null,
        waves: { waveFt: null, waveM: null },
        sun: { sunrise: null, sunset: null },
        tides: { low: null, high: null }
      })
    };
  }
};

// ======================================================================
//  SAFE WRAPPERS (NEVER THROW → HTML will never crash)
// ======================================================================
async function safeFetchBuoy(id) {
  try { return await fetchBuoy(id); }
  catch { return { airF:null, waterF:null, windKts:null, gustKts:null, windDirCardinal:"--" }; }
}

async function safeFetchTides() {
  try { return await fetchTides(); }
  catch { return { low:null, high:null }; }
}

// ======================================================================
//  BUOY FETCH
// ======================================================================
async function fetchBuoy(id) {
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Buoy fetch failed");

  const text = await resp.text();

  const lines = text.split(/\r?\n/)
    .filter(x => x.trim() && !x.startsWith("#"));

  if (!lines.length) throw new Error("No buoy rows");

  const rows = lines.map(line => {
    const c = line.trim().split(/\s+/);
    return {
      WDIR: parseFloat(c[5]),
      WSPD: parseFloat(c[6]),
      GST:  parseFloat(c[7]),
      ATMP: parseFloat(c[13]),
      WTMP: parseFloat(c[14])
    };
  });

  const fallback = fn => {
    for (const r of rows) {
      const v = fn(r);
      if (!isNaN(v)) return v;
    }
    return null;
  };

  const CtoF = c => c * 9/5 + 32;
  const mpsToKts = m => m * 1.94384;

  const airC   = fallback(r => r.ATMP);
  const waterC = fallback(r => r.WTMP);
  const wspd   = fallback(r => r.WSPD);
  const gust   = fallback(r => r.GST);
  const wdir   = fallback(r => r.WDIR);

  return {
    airF:    airC   != null ? round(CtoF(airC)) : null,
    waterF:  waterC != null ? round(CtoF(waterC)) : null,
    windKts: wspd   != null ? round(mpsToKts(wspd)) : null,
    gustKts: gust   != null ? round(mpsToKts(gust)) : null,
    windDirCardinal: degToCardinal(wdir)
  };
}

function round(n) { return Math.round(n * 10) / 10; }

function degToCardinal(d) {
  if (d == null) return "--";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

// ======================================================================
//  WAVES — Stormglass + Netlify Blobs Cache
// ======================================================================
async function getWavesCached() {
  const cached = await store.get("waves.json", { type: "json" });

  if (cached && Date.now() - cached.timestamp < 4 * 60 * 60 * 1000) {
    return cached.waves;
  }

  const waves = await fetchStormglass();

  await store.setJSON("waves.json", {
    timestamp: Date.now(),
    waves
  });

  return waves;
}

async function fetchStormglass() {
  try {
    const url = `https://api.stormglass.io/v2/weather/point?lat=${WAVES_LAT}&lng=${WAVES_LON}&params=waveHeight&source=sg`;

    const resp = await fetch(url, {
      headers: { "Authorization": STORMGLASS_KEY }
    });

    if (!resp.ok) return { waveM:null, waveFt:null };

    const data = await resp.json();
    if (!data.hours?.length) return { waveM:null, waveFt:null };

    let closest = data.hours[0];
    let best = 999999999;
    const now = Date.now();

    for (const h of data.hours) {
      const t = new Date(h.time).getTime();
      const diff = Math.abs(t - now);
      if (diff < best) {
        best = diff;
        closest = h;
      }
    }

    const m = closest.waveHeight?.sg ?? null;
    return {
      waveM:  m,
      waveFt: m != null ? round(m * 3.28084) : null
    };

  } catch {
    return { waveM:null, waveFt:null };
  }
}

// ======================================================================
//  NOAA TIDES
// ======================================================================
async function fetchTides() {
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
    `&station=8779750&interval=hilo&units=english&time_zone=lst_ldt&datum=MLLW&format=json`;

  const resp = await fetch(url);
  const data = await resp.json();

  return {
    low:  data.predictions.find(p => p.type === "L") ?? null,
    high: data.predictions.find(p => p.type === "H") ?? null
  };
}

// ======================================================================
//  NOAA SPA — Accurate sunrise/sunset
// ======================================================================
function computeSunriseSunset(lat, lon, date) {
  const rad = d => d * Math.PI/180;

  const N = Math.floor((date - new Date(date.getFullYear(),0,0)) / 86400000);
  const lngHour = lon / 15;
  const t = N + ((6 - lngHour) / 24);

  const M = (0.9856 * t) - 3.289;

  let L = M + 1.916*Math.sin(rad(M)) + 0.020*Math.sin(rad(2*M)) + 282.634;
  L = (L + 360) % 360;

  let RA = Math.atan(0.91764 * Math.tan(rad(L))) * 180/Math.PI;
  RA = (RA + 360) % 360;

  const Lq = Math.floor(L/90) * 90;
  const RAq = Math.floor(RA/90) * 90;
  RA = (RA + (Lq - RAq)) / 15;

  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));

  const cosH =
    (Math.cos(rad(90.833)) - (sinDec * Math.sin(rad(lat)))) /
    (cosDec * Math.cos(rad(lat)));

  if (cosH > 1) return { sunrise:null, sunset:null };
  if (cosH < -1) return { sunrise:null, sunset:null };

  const Hrise = (360 - Math.acos(cosH)*180/Math.PI) / 15;
  const Hset  = (Math.acos(cosH) * 180/Math.PI) / 15;

  const Trise = Hrise + RA - (0.06571*t) - 6.622;
  const Tset  = Hset  + RA - (0.06571*t) - 6.622;

  return {
    sunrise: toLocalTime(Trise, lngHour, date),
    sunset:  toLocalTime(Tset, lngHour, date)
  };
}

function toLocalTime(T, lngHour, date) {
  const hoursUTC = T - lngHour;
  let h = Math.floor(hoursUTC);
  let m = Math.floor((hoursUTC - h) * 60);

  if (h < 0) h += 24;
  if (h >= 24) h -= 24;

  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
