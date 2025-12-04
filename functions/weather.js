// ======================================================================
// SPI WEATHER — Buoys + Stormglass Waves + NOAA SPA Sun + NOAA Tides
// ======================================================================

// No imports needed — Netlify includes fetch + fs works in /tmp
import fs from "fs";

// ---------- CONFIG ----------
const STORMGLASS_KEY =
  "190fede0-cfd3-11f0-b4de-0242ac130003-190fee6c-cfd3-11f0-b4de-0242ac130003";

const WAVES_LAT = 26.071389;
const WAVES_LON = -97.128722;

// SPI tide station coordinates
const SUN_LAT = 26.07139;
const SUN_LON = -97.12872;

// Cache stored in ephemeral function memory
const CACHE_PATH = "/tmp/stormglass_cache.json";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors() };
  }

  try {
    // ----- BUOYS -----
    const gulf = await safeBuoy("BZST2");
    const bay  = await safeBuoy("PCGT2");

    // ----- WAVES (Stormglass 48h, cached 12h) -----
    const waves = await getStormglassWaves();

    // ----- SUNRISE/SUNSET -----
    const sun = computeSunriseSunset(SUN_LAT, SUN_LON, new Date());

    // ----- TIDES -----
    const tides = await safeTides();

    return json({ gulf, bay, waves, sun, tides });

  } catch (err) {
    return json({
      error: String(err),
      gulf: null,
      bay: null,
      waves: { waveM: null, waveFt: null },
      sun: { sunrise: null, sunset: null },
      tides: { low: null, high: null }
    }, 500);
  }
}

// ======================================================================
// HELPERS
// ======================================================================
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { ...cors(), "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

const oneDec = n => (n == null ? null : Number(n.toFixed(1)));
const CtoF = c => (c * 9) / 5 + 32;
const mpsToKts = v => v * 1.94384;

// ======================================================================
// BUOYS — Safe Wrapper
// ======================================================================
async function safeBuoy(id) {
  try { return await fetchBuoy(id); }
  catch {
    return {
      airF: null, waterF: null,
      windKts: null, gustKts: null,
      windDirCardinal: "--"
    };
  }
}

async function fetchBuoy(id) {
  const r = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`);
  const text = await r.text();

  const lines = text.split(/\r?\n/).filter(x => x.trim());

  // Parse header
  const headerLine = lines.find(l => l.startsWith("#") && l.includes("WDIR"));
  const header = headerLine.replace("#","").trim().split(/\s+/);

  const colIndex = name => header.indexOf(name);

  const idx = {
    WDIR: colIndex("WDIR"),
    WSPD: colIndex("WSPD"),
    GST:  colIndex("GST"),
    ATMP: colIndex("ATMP"),
    WTMP: colIndex("WTMP")
  };

  const rows = lines
    .filter(l => !l.startsWith("#"))
    .map(line => {
      const c = line.trim().split(/\s+/);
      const get = i => (i >= 0 && i < c.length ? parseFloat(c[i]) : null);
      return {
        WDIR: get(idx.WDIR),
        WSPD: get(idx.WSPD),
        GST:  get(idx.GST),
        ATMP: get(idx.ATMP),
        WTMP: get(idx.WTMP)
      };
    });

  const newest = fn => {
    for (const r of rows) {
      const v = fn(r);
      if (v != null && !isNaN(v)) return v;
    }
    return null;
  };

  const airC   = newest(r => r.ATMP);
  const waterC = newest(r => r.WTMP);
  const wspd   = newest(r => r.WSPD);
  const gust   = newest(r => r.GST);
  const wdir   = newest(r => r.WDIR);

  return {
    airF:    airC   != null ? oneDec(CtoF(airC)) : null,
    waterF:  waterC != null ? oneDec(CtoF(waterC)) : null,
    windKts: wspd   != null ? oneDec(mpsToKts(wspd)) : null,
    gustKts: gust   != null ? oneDec(mpsToKts(gust)) : null,
    windDirCardinal: degToCardinal(wdir)
  };
}

function degToCardinal(d) {
  if (d == null) return "--";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

// ======================================================================
// TIDES
// ======================================================================
async function safeTides() {
  try { return await fetchTides(); }
  catch { return { low: null, high: null }; }
}

async function fetchTides() {
  const r = await fetch(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
    `&station=8779750&interval=hilo&units=english&datum=MLLW&time_zone=lst_ldt&format=json`
  );

  const j = await r.json();

  return {
    low:  j.predictions.find(p => p.type === "L") ?? null,
    high: j.predictions.find(p => p.type === "H") ?? null
  };
}

// ======================================================================
// STORMGLASS — 48h forecast, cached 12 hours
// ======================================================================
async function getStormglassWaves() {
  // load cache if exists
  if (fs.existsSync(CACHE_PATH)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const ageMs = Date.now() - cache.timestamp;

    // 12-hour cache
    if (ageMs < 12 * 60 * 60 * 1000) {
      return getClosestWave(cache.hours);
    }
  }

  // fetch fresh data
  const hours = await fetchStormglassHours();

  // save cache
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify({ timestamp: Date.now(), hours })
  );

  return getClosestWave(hours);
}

async function fetchStormglassHours() {
  try {
    const url =
      `https://api.stormglass.io/v2/weather/point?lat=${WAVES_LAT}&lng=${WAVES_LON}` +
      `&params=waveHeight&source=sg`;

    const resp = await fetch(url, {
      headers: { Authorization: STORMGLASS_KEY }
    });

    if (!resp.ok) return [];

    const data = await resp.json();
    return data.hours || [];

  } catch (e) {
    return [];
  }
}

function getClosestWave(hours) {
  if (!hours || hours.length === 0)
    return { waveM: null, waveFt: null };

  let best = Infinity;
  let closest = hours[0];
  const now = Date.now();

  for (const h of hours) {
    const t = new Date(h.time).getTime();
    const diff = Math.abs(t - now);
    if (diff < best) {
      best = diff;
      closest = h;
    }
  }

  const m = closest.waveHeight?.sg ?? null;

  return {
    waveM: m,
    waveFt: m != null ? oneDec(m * 3.28084) : null
  };
}

// ======================================================================
// SUNRISE / SUNSET — NOAA SPA
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

  if (cosH > 1) return { sunrise: null, sunset: null };
  if (cosH < -1) return { sunrise: null, sunset: null };

  const Hrise = (360 - Math.acos(cosH)*180/Math.PI) / 15;
  const Hset  = (Math.acos(cosH)*180/Math.PI) / 15;

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
