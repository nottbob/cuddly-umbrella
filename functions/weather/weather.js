import fetch from "node-fetch";
import pdf from "pdf-parse-es5";
import { getStore } from "@netlify/blobs";

// ------------------------ CONFIG ------------------------
const STORMGLASS_KEY = "190fede0-cfd3-11f0-b4de-0242ac130003-190fee6c-cfd3-11f0-b4de-0242ac130003";

const WAVES_LAT = 26.071389;
const WAVES_LON = -97.128722;

const store = getStore("wave-cache");   // persistent Netlify blob store


// ------------------------ MAIN HANDLER ------------------------
export const handler = async () => {
  try {

    // Waves with 12 hr cache
    const waves = await getWavesCached();

    // Buoys
    const gulf = await safeFetchBuoy("BZST2");
    const bay  = await safeFetchBuoy("PCGT2");

    // Tides + Sunrise/Sunset from USHarbors PDF
    const tideSun = await safeFetchUsharbors();

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
        tides: tideSun.tides,
        sun: tideSun.sun
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: String(err),
        gulf: null,
        bay: null,
        waves: { waveFt: null, waveM: null },
        tides: { low: [], high: [] },
        sun: { sunrise: null, sunset: null }
      })
    };
  }
};


// ======================================================================
//  SAFE WRAPPERS
// ======================================================================
async function safeFetchBuoy(id) {
  try { return await fetchBuoy(id); }
  catch { return { airF:null, waterF:null, windKts:null, gustKts:null, windDirCardinal:"--" }; }
}

async function safeFetchUsharbors() {
  try { return await fetchUsharborsTidesSun(); }
  catch (e) {
    return {
      tides: { high: [], low: [] },
      sun: { sunrise: null, sunset: null }
    };
  }
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
//  WAVES (StormGlass) — 12 HOUR CACHE
// ======================================================================
async function getWavesCached() {
  const cached = await store.get("waves.json", { type: "json" });

  // 12 hours
  if (cached && Date.now() - cached.timestamp < 12 * 60 * 60 * 1000) {
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

    // closest hour to now
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
//  USHARBORS PDF — TIDES + SUNRISE/SUNSET
// ======================================================================
async function fetchUsharborsTidesSun() {

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm   = String(today.getMonth()+1).padStart(2,"0");

  const pdfUrl =
    `https://www.usharbors.com/harbor/texas/padre-island-tx/pdf/?tide=${yyyy}-${mm}`;

  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error("USHarbors PDF fetch failed");

  const buf = await resp.arrayBuffer();
  const parsed = await pdf(Buffer.from(buf));

  const text = parsed.text;

  // PDF format puts each day like:
  // "1 High 2.1ft 01:44 AM  Low 0.3ft 11:02 AM  Sunrise 07:03 AM  Sunset 05:47 PM"
  // We extract by matching today's date at line start.

  const day = today.getDate();
  const regex = new RegExp(`\\b${day}\\b[\\s\\S]*?(?=\\n|$)`, "i");
  const line = text.match(regex)?.[0] ?? "";

  const high = [...line.matchAll(/High\s+([\d.]+)ft\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/gi)]
    .map(m => `${m[1]} ft ${m[2]}`);

  const low = [...line.matchAll(/Low\s+([\d.]+)ft\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/gi)]
    .map(m => `${m[1]} ft ${m[2]}`);

  const sunrise = line.match(/Sunrise\s+(\d{1,2}:\d{2}\s*(AM|PM))/i)?.[1] ?? null;
  const sunset  = line.match(/Sunset\s+(\d{1,2}:\d{2}\s*(AM|PM))/i)?.[1] ?? null;

  return {
    tides: { high, low },
    sun: { sunrise, sunset }
  };
}
