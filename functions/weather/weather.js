// weather.js — FINAL VERSION
// ------------------------------------------------------------
// Backend used by SPI Marine Board
// Loads:
//   • Buoys (live)
//   • NOAA tides (frontend)
//   • Sunrise/sunset (frontend)
//   • Waves from stormglass.json on GitHub
// ------------------------------------------------------------

const fetch = require("node-fetch");

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = "nottbob/wave-proxy";
const GITHUB_BRANCH = "main";

// -------------------------------
// GITHUB LOADER
// -------------------------------
async function githubGet(path) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  if (!res.ok) return null;

  const j = await res.json();
  return Buffer.from(j.content, "base64").toString("utf8");
}

// -------------------------------
// WAVES (from GitHub only)
// -------------------------------
function pickWaveForLocalTime(waves) {
  const now = new Date();

  // Convert local SPI hour to UTC hour index
  const localOffsetMin  = now.getTimezoneOffset(); // CST/CDT aware
  const localToUTCms    = now.getTime() + localOffsetMin * 60000;
  const localAsUTC      = new Date(localToUTCms);

  const targetHour = localAsUTC.getUTCHours();

  // Find wave whose UTC time matches current local hour slot
  let best = null;
  let bestDiff = Infinity;

  for (const w of waves) {
    if (!w.waveFt) continue;
    const t = new Date(w.time);
    const diff = Math.abs(t.getUTCHours() - targetHour);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = w;
    }
  }

  return best ? { waveFt: Number(best.waveFt) } : { waveFt: null };
}

// -------------------------------
// NOAA BUOYS
// -------------------------------
function cToF(c) { return (c * 9) / 5 + 32; }
function mpsToKts(m) { return m * 1.94384; }
function parseNum(x) { const n = parseFloat(x); return isNaN(n) ? null : n; }

function degToCard(d) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.floor((d % 360) / 22.5 + 0.5) % 16];
}

async function fetchBuoy(id) {
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Buoy fetch failed");

  const raw = await res.text();
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const headerLine = lines.find(x => x.startsWith("#"));
  const header = headerLine.replace(/^#\s*/, "").split(/\s+/);

  const idx = {
    WDIR: header.indexOf("WDIR"),
    WSPD: header.indexOf("WSPD"),
    GST:  header.indexOf("GST"),
    ATMP: header.indexOf("ATMP"),
    WTMP: header.indexOf("WTMP")
  };

  const rows = lines.filter(x => !x.startsWith("#")).map(x => x.split(/\s+/));

  let air=null, water=null, wind=null, gust=null, wdir=null;

  for (const r of rows) {
    if (air   == null && idx.ATMP !== -1) air   = parseNum(r[idx.ATMP]);
    if (water == null && idx.WTMP !== -1) water = parseNum(r[idx.WTMP]);
    if (wind  == null && idx.WSPD !== -1) wind  = parseNum(r[idx.WSPD]);
    if (gust  == null && idx.GST  !== -1) gust  = parseNum(r[idx.GST]);
    if (wdir  == null && idx.WDIR !== -1) {
      const dd = parseNum(r[idx.WDIR]);
      if (dd != null) wdir = dd;
    }
    if (air && water && wind && gust && wdir) break;
  }

  return {
    airF: air ? Number((cToF(air)).toFixed(1)) : null,
    waterF: water ? Number((cToF(water)).toFixed(1)) : null,
    windKts: wind ? Number((mpsToKts(wind)).toFixed(1)) : null,
    gustKts: gust ? Number((mpsToKts(gust)).toFixed(1)) : null,
    windDirCardinal: wdir != null ? degToCard(wdir) : "--"
  };
}

async function safeBuoy(id) {
  try { return await fetchBuoy(id); }
  catch { return { airF:null, waterF:null, windKts:null, gustKts:null, windDirCardinal:"--" }; }
}

// -------------------------------
// MAIN HANDLER
// -------------------------------
exports.handler = async () => {
  try {
    // 1. Load waves from GitHub
    const wavesRaw = await githubGet("stormglass.json");
    let waves = [];
    if (wavesRaw) {
      const parsed = JSON.parse(wavesRaw);
      waves = parsed.waves || [];
    }

    const waveObj = pickWaveForLocalTime(waves);

    // 2. Load buoys
    const [gulf, bay] = await Promise.all([
      safeBuoy("BZST2"),
      safeBuoy("PCGT2")
    ]);

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({
        gulf,
        bay,
        waves: waveObj,
        tides: { high:null, low:null },     // frontend handles tides
        sun: { sunrise:null, sunset:null }, // frontend handles sun
        usharborsOutdated: false
      })
    };

  } catch (err) {
    return {
      statusCode: 200,
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
