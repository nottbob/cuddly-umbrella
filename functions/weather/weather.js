// ======================================================================
// SPI WEATHER BOARD — FULL SERVER FUNCTION (TIDE FIX: HH:MM STRINGS)
// ======================================================================

// ----------------------------------------------------------
// ENV VARS
// ----------------------------------------------------------
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = process.env.GITHUB_REPO;      // "nottbob/wave-proxy"
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH;    // "main"
const STORMGLASS_KEY = process.env.STORMGLASS_KEY;

const STORMGLASS_URL =
  "https://api.stormglass.io/v2/weather/point?lat=26.071389&lng=-97.128722&params=waveHeight&source=sg";


// ----------------------------------------------------------
// GITHUB LOADER
// ----------------------------------------------------------
async function githubGet(path) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) {
    console.log("[GitHub] Missing env vars");
    return null;
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
  console.log("[GitHub] GET:", url);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "spi-weather-board",
      Accept: "application/vnd.github+json"
    }
  });

  if (res.status === 404) {
    console.log("[GitHub] File not found:", path);
    return null;
  }

  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);

  const json = await res.json();
  const txt  = Buffer.from(json.content, "base64").toString("utf8");

  return { sha: json.sha, content: txt };
}



// ======================================================================
// STORMGLASS — DAILY/NOON REFRESH
// ======================================================================
function shouldUpdateStormglass(lastTimestamp) {
  if (!lastTimestamp) return true;
  const last = new Date(lastTimestamp);
  const now  = new Date();

  const crossedMidnight = now.getDate() !== last.getDate();
  const crossedNoon     = last.getHours() < 12 && now.getHours() >= 12;

  return crossedMidnight || crossedNoon;
}

async function fetchStormglassFresh() {
  const res = await fetch(STORMGLASS_URL, {
    headers: { Authorization: STORMGLASS_KEY }
  });

  if (!res.ok) throw new Error("Stormglass fetch failed");

  const json = await res.json();

  const waves = json.hours.map(h => {
    const m = h.waveHeight?.sg;
    const ft =
      typeof m === "number" ? Math.round(m * 3.28084 * 10) / 10 : null;
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
    console.log("[Stormglass] Fetching fresh data");
    return await fetchStormglassFresh();
  }

  return stored;
}

function pickCurrentWave(f) {
  if (!f || !f.waves || !f.waves.length) return { waveFt: null };

  const now = Date.now();
  let best = null;
  let diff = Infinity;

  for (const w of f.waves) {
    if (w.waveFt == null) continue;
    const t = new Date(w.time).getTime();
    const d = Math.abs(t - now);
    if (d < diff) { diff = d; best = w; }
  }

  return best ? { waveFt: best.waveFt } : { waveFt: null };
}



// ======================================================================
// USHARBORS — TSV PARSER (RETURNS "HH:MM" STRINGS — **NO TIMEZONE**)
// ======================================================================
function parseUsharborsTSV(tsv) {
  console.log("[USHarbors] Parsing TSV…");

  const lines = tsv.split(/\r?\n/).map(l => l.trim());
  const days = {};

  for (const line of lines) {
    if (!line) continue;

    const cols = line.split("\t");   // ← FULL PRESERVATION OF EMPTY CELLS

    const day = parseInt(cols[0], 10);
    if (!Number.isInteger(day)) continue;

    const [
      _day,
      _dow,
      highAMt, highAMv,
      highPMt, highPMv,
      lowAMt, lowAMv,
      lowPMt, lowPMv,
      sunrise, sunset
    ] = cols;

    const rec = {
      high: [],
      low: [],
      sunrise: null,
      sunset: null
    };

    const validTime = t => /^\d{1,2}:\d{2}$/.test(t);
    const validNum  = v => /^-?\d+(\.\d+)?$/.test(v);

    if (validTime(highAMt) && validNum(highAMv))
      rec.high.push({ t: highAMt, v: parseFloat(highAMv) });

    if (validTime(highPMt) && validNum(highPMv))
      rec.high.push({ t: highPMt, v: parseFloat(highPMv) });

    if (validTime(lowAMt) && validNum(lowAMv))
      rec.low.push({ t: lowAMt, v: parseFloat(lowAMv) });

    if (validTime(lowPMt) && validNum(lowPMv))
      rec.low.push({ t: lowPMt, v: parseFloat(lowPMv) });

    rec.sunrise = validTime(sunrise) ? sunrise : null;
    rec.sunset  = validTime(sunset)  ? sunset  : null;

    days[day] = rec;
  }

  console.log("[USHarbors] Parsed", Object.keys(days).length, "days");
  return days;
}

function chooseTideTSV(rec, kind) {
  const arr = rec[kind];
  if (!arr || arr.length === 0) return null;
  if (arr.length === 1) return arr[0];

  const now = new Date();
  const pm = now.getHours() >= 12;
  return pm ? arr[1] : arr[0];
}

async function getUsharborsToday() {
  const now = new Date();
  const y  = now.getFullYear();
  const m  = now.getMonth() + 1;
  const mm = String(m).padStart(2, "0");

  const filename = `usharbors-${y}-${mm}.tsv`;
  console.log("[USHarbors] Loading:", filename);

  const file = await githubGet(filename);

  if (!file) {
    return {
      outdated: true,
      tides: { high: null, low: null },
      sun: { sunrise: null, sunset: null }
    };
  }

  const days = parseUsharborsTSV(file.content);
  const rec  = days[now.getDate()];

  if (!rec) {
    return {
      outdated: false,
      tides: { high: null, low: null },
      sun: { sunrise: null, sunset: null }
    };
  }

  const high = chooseTideTSV(rec, "high");
  const low  = chooseTideTSV(rec, "low");

  return {
    outdated: false,
    tides: {
      high: high ? { t: high.t, v: high.v } : null,
      low:  low  ? { t: low.t,  v: low.v  } : null
    },
    sun: {
      sunrise: rec.sunrise,
      sunset:  rec.sunset
    }
  };
}



// ======================================================================
// NOAA BUOYS
// ======================================================================
function cToF(c) { return (c * 9) / 5 + 32; }
function mpsToKts(m) { return m * 1.94384; }

function parseNum(x) {
  const n = parseFloat(x);
  return isNaN(n) ? null : n;
}

function degToCard(d) {
  const dirs = [
    "N","NNE","NE","ENE","E","ESE","SE","SSE",
    "S","SSW","SW","WSW","W","WNW","NW","NNW"
  ];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

async function fetchBuoy(id) {
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Buoy fetch failed");

  const raw = await res.text();
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const headerLine = lines.find(l => l.startsWith("#"));
  if (!headerLine) throw new Error("Missing header");

  const header = headerLine.replace(/^#\s*/, "").split(/\s+/);

  const getIdx = (f) => header.indexOf(f);
  const idx = {
    WDIR: getIdx("WDIR"),
    WSPD: getIdx("WSPD"),
    GST:  getIdx("GST"),
    ATMP: getIdx("ATMP"),
    WTMP: getIdx("WTMP")
  };

  const data = lines.filter(l => !l.startsWith("#")).map(l => l.split(/\s+/));

  let air=null, water=null, wspd=null, gust=null, wdir=null;

  for (const r of data) {
    if (air   == null && idx.ATMP !== -1) air   = parseNum(r[idx.ATMP]);
    if (water == null && idx.WTMP !== -1) water = parseNum(r[idx.WTMP]);
    if (wspd  == null && idx.WSPD !== -1) wspd  = parseNum(r[idx.WSPD]);
    if (gust  == null && idx.GST  !== -1) gust  = parseNum(r[idx.GST]);
    if (wdir  == null && idx.WDIR !== -1) {
      const d = parseNum(r[idx.WDIR]);
      if (d != null) wdir = d;
    }

    if (air && water && wspd && gust && wdir) break;
  }

  return {
    airF:    air   != null ? Math.round(cToF(air)   * 10) / 10 : null,
    waterF:  water != null ? Math.round(cToF(water) * 10) / 10 : null,
    windKts: wspd  != null ? Math.round(mpsToKts(wspd) * 10) / 10 : null,
    gustKts: gust  != null ? Math.round(mpsToKts(gust) * 10) / 10 : null,
    windDirCardinal: wdir != null ? degToCard(wdir) : "--"
  };
}

async function safeBuoy(id) {
  try { return await fetchBuoy(id); }
  catch {
    return {
      airF:null, waterF:null, windKts:null,
      gustKts:null, windDirCardinal:"--"
    };
  }
}



// ======================================================================
// MAIN HANDLER
// ======================================================================
exports.handler = async () => {
  console.log("=== WEATHER HANDLER START ===");

  try {
    const [gulf, bay, sg, ush] = await Promise.all([
      safeBuoy("BZST2"),
      safeBuoy("PCGT2"),
      getStormglassForecast(),
      getUsharborsToday()
    ]);

    const wave = pickCurrentWave(sg);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        gulf,
        bay,
        waves: wave,
        tides: ush.tides,     // ← now simple HH:MM strings
        sun: ush.sun,
        usharborsOutdated: ush.outdated
      })
    };

  } catch (err) {
    console.error("FATAL WEATHER ERROR:", err);
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: String(err),
        gulf:null,
        bay:null,
        waves:{ waveFt:null },
        tides:{ high:null, low:null },
        sun:{ sunrise:null, sunset:null },
        usharborsOutdated:true
      })
    };
  }
};
