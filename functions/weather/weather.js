// functions/weather/weather.js

export default async (req, res) => {
  try {
    // -----------------------------
    // CONSTANTS
    // -----------------------------
    const NOAA_TIDE_STATION = "8779750";
    const LAT = 26.07139, LON = -97.12872;

    // -----------------------------
    // UTIL FUNCTIONS
    // -----------------------------
    const toLocal = (d) => {
      // d = Date object (UTC)
      return new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    };

    const toHM = (d) => {
      const h = d.getHours().toString().padStart(2, "0");
      const m = d.getMinutes().toString().padStart(2, "0");
      return `${h}:${m}`;
    };

    // -----------------------------
    // FETCH NOAA BUOY AND AIR/WATER DATA
    // -----------------------------
    async function getBuoy(station) {
      try {
        const url = `https://www.ndbc.noaa.gov/data/realtime2/${station}.txt`;
        const txt = await fetch(url).then(r => r.text());
        const lines = txt.trim().split("\n");
        const last = lines[lines.length - 1].split(/\s+/);

        return {
          airF: parseFloat(last[5]),
          waterF: parseFloat(last[6]),
          windKts: parseFloat(last[3]),
          gustKts: parseFloat(last[4]),
          windDirCardinal: last[2]
        };
      } catch (e) {
        return null;
      }
    }

    const gulfData = await getBuoy("PCGT2");
    const bayData  = await getBuoy("BZST2");

    // -----------------------------
    // TIDES (NOAA)
    // -----------------------------
    let tides = { high: null, low: null };

    try {
      const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&station=${NOAA_TIDE_STATION}&date=today&interval=hilo&units=english&time_zone=gmt&datum=MLLW&format=json`;

      const t = await fetch(url).then(r => r.json());

      const H = t.predictions.find(p => p.type === "H");
      const L = t.predictions.find(p => p.type === "L");

      if (H) {
        const d = toLocal(new Date(H.t));
        tides.high = { t: toHM(d), v: parseFloat(H.v).toFixed(1) };
      }
      if (L) {
        const d = toLocal(new Date(L.t));
        tides.low = { t: toHM(d), v: parseFloat(L.v).toFixed(1) };
      }

    } catch (e) {
      tides = { high: null, low: null };
    }

    // -----------------------------
    // SUNRISE / SUNSET
    // -----------------------------
    let sun = { sunrise: null, sunset: null };

    try {
      const s = await fetch(`https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LON}&formatted=0`)
        .then(r => r.json());

      const sr = toLocal(new Date(s.results.sunrise));
      const ss = toLocal(new Date(s.results.sunset));

      sun.sunrise = toHM(sr);
      sun.sunset = toHM(ss);

    } catch (e) {
      sun = { sunrise: null, sunset: null };
    }

    // -----------------------------
    // WAVES (FROM GITHUB JSON — NEVER STORMGLASS DIRECT)
    // -----------------------------
    let waves = { waveFt: null };
    try {
      const sg = await fetch(
        "https://raw.githubusercontent.com/nottbob/wave-proxy/refs/heads/main/stormglass.json",
        { cache: "no-store" }
      ).then(r => r.json());

      const arr = sg.waves; // array of { time, waveFt }

      // get local time
      const nowLocal = toLocal(new Date());

      // find the entry with closest hour <= now
      let best = null;

      for (const w of arr) {
        const tLocal = toLocal(new Date(w.time));
        if (tLocal <= nowLocal) {
          best = w;
        } else {
          break;
        }
      }

      if (best) {
        waves.waveFt = parseFloat(best.waveFt).toFixed(1);
      }

    } catch (e) {
      waves.waveFt = null;
    }

    // -----------------------------
    // FINAL OUTPUT
    // -----------------------------
    res.setHeader("Content-Type", "application/json");
    res.status(200).json({
      gulf: gulfData,
      bay: bayData,
      waves,
      tides,
      sun,
      usharborsOutdated: false
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
};
