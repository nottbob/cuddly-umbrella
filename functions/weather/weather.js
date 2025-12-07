// ======================================================================
// SPI WEATHER BOARD — BACKEND (NO TIDES HERE — FRONTEND HANDLES NOAA TIDES)
// Gulf/Bay NOAA buoys + Stormglass waves + USHarbors sun TSV
// ======================================================================

// ----------------------------------------------------------
// ENV
// ----------------------------------------------------------
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = process.env.GITHUB_REPO;      // "nottbob/wave-proxy"
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH;    // "main"
const STORMGLASS_KEY = process.env.STORMGLASS_KEY;

const STORMGLASS_URL =
  "https://api.stormglass.io/v2/weather/point?lat=26.071389&lng=-97.128722&params=waveHeight&source=sg";


// ----------------------------------------------------------
// GITHUB FETCH
// ----------------------------------------------------------
async function githubGet(path) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_BRANCH) return null;

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "spi-weather-board",
      Accept: "application/vnd.github+json"
    }
  });

  if (!res.ok) return null;

  const json = await res.json();
  const txt = Buffer.from(json.content, "base64").toString("utf8");
  return txt;
}


// ----------------------------------------------------------
// SUN DATA FROM TSV (ONLY SUNRISE/SUNSET)
// ----------------------------------------------------------
function parseSunTSV(tsv) {
  const lines = tsv.split(/\r?\n/).map(l => l.trim());
  const today = new Date().getDate();

  for (const line of lines) {
    const cols = line.split("\t");
    const day = parseInt(cols[0], 10);
    if (day === today) {
      const sunrise = cols[10] ?? null;
      const sunset  = cols[11] ?? null;
      return { sunrise, sunset };
    }
  }

  return { sunrise:null, sunset:null };
}

async function getSunToday() {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = String(now.getMonth() + 1).padStart(2,"0");

  const filename = `usharbors-${y}-${m}.tsv`;
  const raw = await githubGet(filename);

  if (!raw) return { sunrise:null, sunset:null };

  return parseSunTSV(raw);
}


// ----------------------------------------------------------
// STORMGLASS WAVES
// ----------------------------------------------------------
async function fetchStormglass() {
  const res = await fetch(STORMGLASS_URL, {
    headers: { Authorization: STORMGLASS_KEY }
  });

  if (!res.ok) throw new Error("Stormglass failed");

  const json = await res.json();

  const waves = json.hours.map(h => {
    const m = h.waveHeight?.sg;
    const ft =
      typeof m === "number" ? Math.round(m * 3.28084 * 10) / 10 : null;

    return { time: h.time, waveFt: ft };
  });

  // pick nearest
  const now = Date.now();
  let best = null, diff = Infinity;

  for (const w of waves) {
    if (w.waveFt == null) continue;
    const d = Math.abs(new Date(w.time).getTime() - now);
    if (d < diff) { diff = d; best = w; }
  }

  return best ? { waveFt: best.waveFt } : { waveFt:null };
}


// ----------------------------------------------------------
// NOAA BUOYS
// ----------------------------------------------------------
function cToF(c){ return (c*9)/5+32; }
function mpsToKts(m){ return m*1.94384; }
function parseNum(x){ const n=parseFloat(x); return isNaN(n)?null:n; }

function degToCard(d){
  const dirs=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.floor((d % 360)/22.5 + 0.5) % 16];
}

async function fetchBuoy(id){
  const url=`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("buoy fail");

  const raw = await res.text();
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const headerLine = lines.find(l=>l.startsWith("#"));
  const header = headerLine.replace(/^#\s*/,"").split(/\s+/);

  const idx = {
    WDIR: header.indexOf("WDIR"),
    WSPD: header.indexOf("WSPD"),
    GST:  header.indexOf("GST"),
    ATMP: header.indexOf("ATMP"),
    WTMP: header.indexOf("WTMP"),
  };

  let air=null, water=null, wspd=null, gust=null, wdir=null;

  for (const L of lines) {
    if (L.startsWith("#")) continue;
    const r = L.split(/\s+/);

    if (air==null   && idx.ATMP>-1) air   = parseNum(r[idx.ATMP]);
    if (water==null && idx.WTMP>-1) water = parseNum(r[idx.WTMP]);
    if (wspd==null  && idx.WSPD>-1) wspd  = parseNum(r[idx.WSPD]);
    if (gust==null  && idx.GST >-1) gust  = parseNum(r[idx.GST]);
    if (wdir==null  && idx.WDIR>-1){
      const d=parseNum(r[idx.WDIR]);
      if (d!=null) wdir=d;
    }

    if (air && water && wspd && gust && wdir) break;
  }

  return {
    airF: air!=null ? Math.round(cToF(air)*10)/10 : null,
    waterF:water!=null?Math.round(cToF(water)*10)/10:null,
    windKts:wspd!=null?Math.round(mpsToKts(wspd)*10)/10:null,
    gustKts:gust!=null?Math.round(mpsToKts(gust)*10)/10:null,
    windDirCardinal:wdir!=null?degToCard(wdir):"--"
  };
}

async function safeBuoy(id){
  try { return await fetchBuoy(id); }
  catch { return { airF:null, waterF:null, windKts:null, gustKts:null, windDirCardinal:"--" }; }
}


// ----------------------------------------------------------
// HANDLER
// ----------------------------------------------------------
exports.handler = async () => {
  try {
    const [gulf, bay, waves, sun] = await Promise.all([
      safeBuoy("BZST2"),
      safeBuoy("PCGT2"),
      fetchStormglass(),
      getSunToday()
    ]);

    return {
      statusCode:200,
      headers:{
        "Access-Control-Allow-Origin":"*",
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        gulf,
        bay,
        waves,
        sun,
        tides:{ high:null, low:null }, // FRONTEND handles this
        usharborsOutdated:false
      })
    };

  } catch (err) {
    return {
      statusCode:200,
      headers:{ "Access-Control-Allow-Origin":"*", "Content-Type":"application/json" },
      body:JSON.stringify({
        error:String(err),
        gulf:null, bay:null, waves:{waveFt:null},
        sun:{sunrise:null, sunset:null},
        tides:{high:null, low:null},
        usharborsOutdated:true
      })
    };
  }
};
