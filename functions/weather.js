import fs from "fs";
import path from "path";

const CACHE_PATH = "/tmp/stormglass_cache.json";
const STORMGLASS_KEY =
  "190fede0-cfd3-11f0-b4de-0242ac130003-190fee6c-cfd3-11f0-b4de-0242ac130003";

const WAVES_LAT = 26.071389;
const WAVES_LON = -97.128722;

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors() };
  }

  try {
    const gulf = await fetchBuoy("BZST2");
    const bay  = await fetchBuoy("PCGT2");

    const waves = await getStormglassCached();

    return json({ gulf, bay, waves });

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// -------- HELPERS --------

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

// -------- BUOY FETCH --------

async function fetchBuoy(id) {
  const r = await fetch(
    `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`
  );
  const text = await r.text();

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headerLine = lines.find(l => l.startsWith("#") && l.includes("WDIR"));
  const header = headerLine.replace("#", "").trim().split(/\s+/);

  const col = n => header.indexOf(n);
  const idx = {
    WDIR: col("WDIR"),
    WSPD: col("WSPD"),
    GST: col("GST"),
    ATMP: col("ATMP"),
    WTMP: col("WTMP")
  };

  const rows = lines
    .filter(l => !l.startsWith("#"))
    .map(line => {
      const c = line.trim().split(/\s+/);
      const get = i => (i >= 0 && i < c.length ? parseFloat(c[i]) : null);
      return {
        WDIR: get(idx.WDIR),
        WSPD: get(idx.WSPD),
        GST: get(idx.GST),
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
    airF: airC != null ? oneDec(CtoF(airC)) : null,
    waterF: waterC != null ? oneDec(CtoF(waterC)) : null,
    windKts: wspd != null ? oneDec(mpsToKts(wspd)) : null,
    gustKts: gust != null ? oneDec(mpsToKts(gust)) : null,
    windDirCardinal: degToCardinal(wdir)
  };
}

function degToCardinal(d) {
  if (d == null) return null;
  const dirs = [
    "N","NNE","NE","ENE","E","ESE","SE","SSE",
    "S","SSW","SW","WSW","W","WNW","NW","NNW"
  ];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

// -------- STORMGLASS CACHED --------

async function getStormglassCached() {
  if (fs.existsSync(CACHE_PATH)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const age = Date.now() - cache.timestamp;

    if (age < 4 * 60 * 60 * 1000) {
      return cache.waves;
    }
  }

  const waves = await fetchStormglass();
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify({ timestamp: Date.now(), waves })
  );

  return waves;
}

async function fetchStormglass() {
  try {
    const resp = await fetch(
      `https://api.stormglass.io/v2/weather/point?lat=${WAVES_LAT}&lng=${WAVES_LON}&params=waveHeight&source=sg`,
      { headers: { Authorization: STORMGLASS_KEY } }
    );

    if (!resp.ok) return { waveFt: null, waveM: null };

    const data = await resp.json();
    const h = data.hours?.[0];
    const m = h?.waveHeight?.sg ?? null;

    return {
      waveM: m,
      waveFt: m ? oneDec(m * 3.28084) : null
    };

  } catch (e) {
    return { waveM: null, waveFt: null };
  }
}
