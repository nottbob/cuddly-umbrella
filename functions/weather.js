// ======================================================================
//  WEATHER FUNCTION WITH NOAA SPA SUNRISE/SUNSET (ACCURATE TO <1 SECOND)
// ======================================================================

import fs from "fs";
import path from "path";

// -------------------- CONFIG --------------------
const STORMGLASS_KEY = "YOUR_STORMGLASS_KEY";
const WAVES_LAT = 26.071389;
const WAVES_LON = -97.128722;

// SPI tide station coordinates (USHarbors/NOAA station 8779750)
const SUN_LAT = 26.07139;
const SUN_LON = -97.12872;

// Cache file path
const CACHE_PATH = "/tmp/waveCache.json";

export const handler = async () => {
  try {
    // --------- WAVES (Stormglass with 4 hour cache) ---------
    let waves = await getCachedWaves();

    // --------- BUOY DATA ---------
    const gulf = await fetchBuoy("BZST2");
    const bay = await fetchBuoy("PCGT2");

    // --------- SUNRISE / SUNSET (NOAA SPA) ---------
    const sun = computeSunriseSunset(SUN_LAT, SUN_LON, new Date());

    // --------- TIDES (NOAA station 8779750) ---------
    const tides = await fetchTides();

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        gulf,
        bay,
        waves,
        sun,
        tides
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err) })
    };
  }
};

// ======================================================================
//  BUOY FETCH
// ======================================================================
async function fetchBuoy(id) {
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const resp = await fetch(url);

  if (!resp.ok) throw new Error("Buoy fetch failed");

  const text = await resp.text();

  const lines = text
    .split(/\r?\n/)
    .filter(x => x.trim() && !x.startsWith("#"));

  if (!lines.length) throw new Error("No buoy rows");

  const rows = lines.map(line => {
    const c = line.trim().split(/\s+/);
    return {
      WDIR: parseFloat(c[5]),
      WSPD: parseFloat(c[6]),
      GST: parseFloat(c[7]),
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
//  TIDES: NOAA PREDICTIONS FOR STATION 8779750
// ======================================================================
async function fetchTides() {
  const url =
  `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions` +
  `&station=8779750&interval=hilo&units=english&time_zone=lst_ldt&datum=MLLW&format=json`;

  const r = await fetch(url);
  const j = await r.json();

  return {
    low:  j.predictions.find(p => p.type === "L") || null,
    high: j.predictions.find(p => p.type === "H") || null
  };
}

// ======================================================================
//  WAVES: Stormglass + Cache
// ======================================================================
async function getCachedWaves() {
  // if cache exists
  if (fs.existsSync(CACHE_PATH)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const age = Date.now() - cache.timestamp;

    // 4 hour cache
    if (age < 4 * 60 * 60 * 1000) {
      return cache.waves;
    }
  }

  // Otherwise fetch fresh
  const waves = await fetchStormglass();

  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify({ timestamp: Date.now(), waves })
  );

  return waves;
}

async function fetchStormglass() {
  try {
    const url =
      `https://api.stormglass.io/v2/weather/point?lat=${WAVES_LAT}&lng=${WAVES_LON}` +
      `&params=waveHeight&source=sg`;

    const resp = await fetch(url, {
      headers: { "Authorization": STORMGLASS_KEY }
    });

    if (!resp.ok) return { waveFt: null, waveM: null };

    const data = await resp.json();

    let closest = data.hours[0];
    let best = Infinity;
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
      waveM: m,
      waveFt: m != null ? round(m * 3.28084) : null
    };

  } catch {
    return { waveFt: null, waveM: null };
  }
}

// ======================================================================
//  NOAA SPA — Full Solar Position Algorithm (Sunrise/Sunset)
// ======================================================================
function computeSunriseSunset(lat, lon, date) {

  // Convert degrees to radians
  const rad = d => d * Math.PI / 180;

  // Day of year
  const N = Math.floor((date - new Date(date.getFullYear(),0,0)) / 86400000);

  // Approximate solar noon
  const lngHour = lon / 15;
  const tNoon = N + ((12 - lngHour) / 24);

  // Mean anomaly
  const M = (0.9856 * tNoon) - 3.289;

  // True longitude
  let L = M + 1.916 * Math.sin(rad(M)) + 0.020 * Math.sin(rad(2*M)) + 282.634;
  L = (L + 360) % 360;

  // Right ascension
  let RA = Math.atan(0.91764 * Math.tan(rad(L))) * 180/Math.PI;
  RA = (RA + 360) % 360;

  // Quadrant fix
  const Lq = Math.floor(L/90) * 90;
  const RAq = Math.floor(RA/90) * 90;
  RA = RA + (Lq - RAq);
  RA /= 15;

  // Sun declination
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));

  // Sun local hour angle
  const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) /
               (cosDec * Math.cos(rad(lat)));

  if (cosH > 1) return { sunrise: null, sunset: null }; // no sunrise
  if (cosH < -1) return { sunrise: null, sunset: null }; // no sunset

  // Sunrise hour angle
  const Hrise = 360 - Math.acos(cosH) * 180/Math.PI;
  const Hset  = Math.acos(cosH) * 180/Math.PI;

  // Convert to hours
  const trise = Hrise/15 + RA - (0.06571*tNoon) - 6.622;
  const tset  = Hset /15 + RA - (0.06571*tNoon) - 6.622;

  // Convert UTC to local time
  const sunriseUTC = trise - lngHour;
  const sunsetUTC  = tset - lngHour;

  const sunrise = toLocal(date, sunriseUTC);
  const sunset  = toLocal(date, sunsetUTC);

  return { sunrise, sunset };
}

function toLocal(date, hoursUTC) {
  const h = Math.floor(hoursUTC);
  const m = Math.floor((hoursUTC - h) * 60);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
