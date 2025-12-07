// functions/weather/weather.js
//
// *** COMMONJS VERSION ***
// Works in Netlify Dev + Production (Node 18)
// No import/export — uses require() + module.exports
//

const fetch = require("node-fetch");
const { Buffer } = require("buffer");

// ---------- ENV ----------
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH;
const STORMGLASS_KEY = process.env.STORMGLASS_KEY;

// ---------- CONSTANTS ----------
const STORMGLASS_URL =
  "https://api.stormglass.io/v2/weather/point?lat=26.071389&lng=-97.128722&params=waveHeight&source=sg";

const USHARBOR_BASE =
  "https://www.usharbors.com/harbor/texas/padre-island-tx/pdf/";

// ======================================================================
//  GITHUB HELPERS
// ======================================================================

async function githubGet(path) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) return null;

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "spi-weather-board",
      Accept: "application/vnd.github+json",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);

  const json = await res.json();
  const content = Buffer.from(json.content, "base64").toString("utf8");
  return { sha: json.sha, content };
}

async function githubWrite(path, text, sha = null) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) return null;

  const body = {
    message: `update ${path}`,
    content: Buffer.from(text, "utf8").toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "spi-weather-board",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`GitHub WRITE failed: ${res.status}`);
  return await res.json();
}

// ======================================================================
//  WAVES — StormGlass (update only at noon/midnight)
// ======================================================================

function shouldUpdateStormglass(lastTimestamp) {
  if (!lastTimestamp) return true;

  const last = new Date(lastTimestamp);
  const now = new Date();

  return (
    now.getDate() !== last.getDate() || // crossed midnight
    (last.getHours() < 12 && now.getHours() >= 12) // crossed noon
  );
}

async function fetchStormglassFresh() {
  const res = await fetch(STORMGLASS_URL, {
    headers: { Authorization: STORMGLASS_KEY },
  });

  if (!res.ok) throw new Error("StormGlass fetch failed");

  const json = await res.json();
  if (!json.hours) throw new Error("Malformed StormGlass hours");

  const waves = json.hours.map(h => {
    const m = h.waveHeight?.sg;
    const ft = typeof m === "number"
      ? Math.round(m * 3.28084 * 10) / 10
      : null;
    return { time: h.time, waveFt: ft };
  });

  return { timestamp: Date.now(), waves };
}

async function getStormglassForecast() {
  const file = await githubGet("stormglass.json");

  let stored = null;
  if (file) {
    try { stored = JSON.parse(file.content); } catch {}
  }

  if (!stored || shouldUpdateStormglass(stored.timestamp)) {
    const fresh = await fetchStormglassFresh();
    await githubWrite("stormglass.json", JSON.stringify(fresh, null, 2), file?.sha || null);
    return fresh;
  }

  return stored;
}

function pickCurrentWave(forecast) {
  if (!forecast || !forecast.waves?.length) return { waveFt: null };

  const now = Date.now();
  let best = null;
  let bestDiff = Infinity;

  for (const w of forecast.waves) {
    if (w.waveFt == null) continue;
    const diff = Math.abs(new Date(w.time).getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = w;
    }
  }

  return { waveFt: best ? best.waveFt : null };
}

// ======================================================================
//  USHARBORS (text mode PDF → tide/sun)
// ======================================================================

async function fetchUsharborsText(year, month) {
  const mm = String(month).padStart(2, "0");
  const url = `${USHARBOR_BASE}?tide=${year}-${mm}&text=1`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain,*/*",
      Referer: "https://www.usharbors.com/",
    },
  });

  if (!res.ok) throw new Error("USHarbors text fetch failed");
  return await res.text();
}

function parseUsharborsTextToMonth(text, year, month) {
  const lines = text.split(/\r?\n/);
  const days = {};

  const timeRegex = /^\d{1,2}:\d{2}$/;
  const numRegex  = /^-?\d+(\.\d+)?$/;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const day = parseInt(parts[0], 10);
    if (!day || day < 1 || day > 31) continue;

    let i = 2;
    const rec = { high: [], low: [], sunrise: null, sunset: null };

    // High AM
    if (timeRegex.test(parts[i]) && numRegex.test(parts[i+1])) {
      rec.high.push({ time: parts[i], ft: parseFloat(parts[i+1]) });
      i += 2;
    }
    // High PM
    if (timeRegex.test(parts[i]) && numRegex.test(parts[i+1])) {
      rec.high.push({ time: parts[i], ft: parseFloat(parts[i+1]) });
      i += 2;
    }
    // Low AM
    if (timeRegex.test(parts[i]) && numRegex.test(parts[i+1])) {
      rec.low.push({ time: parts[i], ft: parseFloat(parts[i+1]) });
      i += 2;
    }
    // Low PM
    if (timeRegex.test(parts[i]) && numRegex.test(parts[i+1])) {
      rec.low.push({ time: parts[i], ft: parseFloat(parts[i+1]) });
      i += 2;
    }
    // Sunrise
    if (timeRegex.test(parts[i])) rec.sunrise = parts[i++];
    // Sunset
    if (timeRegex.test(parts[i])) rec.sunset = parts[i++];

    days[day] = rec;
  }

  return { year, month, days };
}

async function getUsharborsMonth() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const fname = `usharbors-${year}-${String(month).padStart(2,"0")}.json`;

  const cached = await githubGet(fname);
  if (cached) {
    try { return JSON.parse(cached.content); } catch {}
  }

  const txt = await fetchUsharborsText(year, month);
  const parsed = parseUsharborsTextToMonth(txt, year, month);
  await githubWrite(fname, JSON.stringify(parsed, null, 2), cached?.sha || null);

  return parsed;
}

function chooseTideForNow(dayRecord, kind) {
  const list = dayRecord?.[kind];
  if (!list?.length) return null;

  const hour = new Date().getHours();
  return hour < 12 ? list[0] : (list[1] ?? list[0]);
}

function buildTodayTidesAndSun(monthData) {
  const now = new Date();
  const day = now.getDate();

  const rec = monthData?.days?.[day];
  if (!rec) {
    return {
      tides: { low: null, high: null },
      sun: { sunrise: null, sunset: null },
    };
  }

  const mkISO = t =>
    t
      ? new Date(
          monthData.year,
          monthData.month - 1,
          day,
          Number(t.time.split(":")[0]),
          Number(t.time.split(":")[1])
        ).toISOString()
      : null;

  const high = chooseTideForNow(rec, "high");
  const low  = chooseTideForNow(rec, "low");

  return {
    tides: {
      high: high ? { t: mkISO(high), v: high.ft } : null,
      low:  low  ? { t: mkISO(low),  v: low.ft }  : null,
    },
    sun: {
      sunrise: rec.sunrise ?? null,
      sunset:  rec.sunset ?? null,
    },
  };
}

// ======================================================================
//  BUOYS (fallback logic)
// ======================================================================

function cToF(c) { return (c * 9) / 5 + 32; }
function mpsToKts(m){ return m * 1.94384; }

function parseNum(x) {
  if (x == null || x === "--") return null;
  const n = parseFloat(x);
  return Number.isNaN(n) ? null : n;
}

function degToCardinal(d) {
  if (d == null) return "--";
  const dirs = [
    "N","NNE","NE","ENE","E","ESE","SE","SSE",
    "S","SSW","SW","WSW","W","WNW","NW","NNW"
  ];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

async function fetchBuoy(id) {
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Buoy fetch failed ${id}`);

  const lines = (await res.text())
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("#"));

  const rows = lines.map(l => l.trim().split(/\s+/));
  const header = rows[0];
  const dataRows = rows.slice(1);

  const idx = {
    WDIR: header.indexOf("WDIR"),
    WSPD: header.indexOf("WSPD"),
    GST:  header.indexOf("GST"),
    ATMP: header.indexOf("ATMP"),
    WTMP: header.indexOf("WTMP"),
  };

  let airC = null, waterC = null, wspd = null, gust = null, wdir = null;
  for (const r of dataRows) {
    if (airC   == null && idx.ATMP !== -1) airC   = parseNum(r[idx.ATMP]);
    if (waterC == null && idx.WTMP !== -1) waterC = parseNum(r[idx.WTMP]);
    if (wspd   == null && idx.WSPD !== -1) wspd   = parseNum(r[idx.WSPD]);
    if (gust   == null && idx.GST  !== -1) gust   = parseNum(r[idx.GST]);
    if (wdir   == null && idx.WDIR !== -1) wdir   = parseNum(r[idx.WDIR]);

    if (airC!=null && waterC!=null && wspd!=null && gust!=null && wdir!=null)
      break;
  }

  return {
    airF:  airC   != null ? Math.round(cToF(airC)   * 10) / 10 : null,
    waterF:waterC!= null ? Math.round(cToF(waterC) * 10) / 10 : null,
    windKts:wspd != null ? Math.round(mpsToKts(wspd) * 10) / 10 : null,
    gustKts:gust != null ? Math.round(mpsToKts(gust) * 10) / 10 : null,
    windDirCardinal: wdir != null ? degToCardinal(wdir) : "--",
  };
}

async function safeFetchBuoy(id) {
  try {
    return await fetchBuoy(id);
  } catch (e) {
    console.error("Buoy error", id, e.message);
    return {
      airF: null, waterF: null,
      windKts: null, gustKts: null,
      windDirCardinal: "--",
    };
  }
}

// ======================================================================
//  NETLIFY HANDLER (CommonJS)
// ======================================================================

module.exports.handler = async () => {
  try {
    const [gulf, bay, sgForecast, monthData] = await Promise.all([
      safeFetchBuoy("BZST2"),
      safeFetchBuoy("PCGT2"),
      getStormglassForecast().catch(e => (console.error("Stormglass", e), null)),
      getUsharborsMonth().catch(e => (console.error("USHarbors", e), null)),
    ]);

    const wave = pickCurrentWave(sgForecast);
    const { tides, sun } = buildTodayTidesAndSun(monthData);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gulf,
        bay,
        waves: wave,
        tides,
        sun,
      }),
    };
  } catch (err) {
    console.error("WEATHER FATAL:", err);
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: String(err),
        gulf: null,
        bay: null,
        waves: { waveFt: null },
        tides: { low: null, high: null },
        sun: { sunrise: null, sunset: null },
      }),
    };
  }
};
