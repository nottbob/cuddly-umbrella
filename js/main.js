// main.js
// SPI WEATHER BOARD CONTROLLER

import { getTideData, getSunData, getTideDate } from "./tides_sun.js";
import { getBuoyData } from "./buoys.js";

// DOM refs
const updatedAt = document.getElementById("updatedAt");
const tideDate = document.getElementById("tideDate");

const gulfWater = document.getElementById("gulfWater");
const bayWater = document.getElementById("bayWater");
const gulfAir = document.getElementById("gulfAir");
const bayAir = document.getElementById("bayAir");
const gulfWind = document.getElementById("gulfWind");
const bayWind = document.getElementById("bayWind");
const gulfSeas = document.getElementById("gulfSeas");

const tideLow = document.getElementById("tideLow");
const tideHigh = document.getElementById("tideHigh");
const sunrise = document.getElementById("sunrise");
const sunset = document.getElementById("sunset");

// OFFLINE MEMORY
let lastGoodData = null;
let offlineSince = null;

// UTIL
function pad(n) { return String(n).padStart(2, "0"); }
function toMil(d) {
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// OFFLINE UI SETTER
function setOfflineMode() {
  if (!offlineSince) offlineSince = new Date();

  updatedAt.classList.add("offline");
  updatedAt.textContent = `OFFLINE ${toMil(offlineSince)}`;

  if (lastGoodData) {
    applyData(lastGoodData);
  }
}

// APPLY DATA TO BOARD (UI)
function applyData(data) {
  gulfWater.textContent = data.gulf.waterF + "°F";
  bayWater.textContent  = data.bay.waterF + "°F";
  gulfAir.textContent   = data.gulf.airF + "°F";
  bayAir.textContent    = data.bay.airF + "°F";

  gulfWind.textContent = data.gulf.wind;
  bayWind.textContent  = data.bay.wind;

  gulfSeas.textContent = "--"; // Waves removed for now

  tideLow.textContent  = data.tides.low
    ? `${data.tides.low.time} / ${data.tides.low.height} ft` 
    : "--";

  tideHigh.textContent = data.tides.high
    ? `${data.tides.high.time} / ${data.tides.high.height} ft`
    : "--";

  sunrise.textContent = data.sun.sunrise;
  sunset.textContent  = data.sun.sunset;

  tideDate.textContent = data.date;
}

// MAIN UPDATE FUNCTION
async function updateBoard() {
  try {
    // Fetch all data in parallel
    const [buoys, tides, sun] = await Promise.all([
      getBuoyData(),
      getTideData(),
      getSunData()
    ]);

    // Prepare final structured data
    const payload = {
      gulf: {
        waterF: buoys.gulf.water,
        airF: buoys.gulf.air,
        wind: `${buoys.gulf.windKts}-${buoys.gulf.gustKts} kts ${buoys.gulf.dir}`
      },
      bay: {
        waterF: buoys.bay.water,
        airF: buoys.bay.air,
        wind: `${buoys.bay.windKts}-${buoys.bay.gustKts} kts ${buoys.bay.dir}`
      },
      tides,
      sun,
      date: getTideDate()
    };

    // Save good data
    lastGoodData = payload;
    offlineSince = null;

    // Update UI
    updatedAt.classList.remove("offline");
    updatedAt.textContent = `UPDATED ${toMil(new Date())} LCL`;

    applyData(payload);

  } catch (e) {
    console.error("UPDATE FAILED, USING OFFLINE:", e);
    setOfflineMode();
  }
}

// AUTO-REFRESH LOGIC — EXACT :00 and :30 SYNC
function scheduleRefresh() {
  const now = new Date();
  const sec = now.getSeconds();

  let delay;
  if (sec < 30) {
    delay = (30 - sec) * 1000;
  } else {
    delay = (60 - sec) * 1000;
  }

  setTimeout(() => {
    updateBoard();
    scheduleRefresh(); // chain next refresh
  }, delay);
}

// INITIAL RUN
updateBoard();
scheduleRefresh();

// Update timestamp every 10 seconds (if online)
setInterval(() => {
  if (!offlineSince) {
    updatedAt.textContent = `UPDATED ${toMil(new Date())} LCL`;
  }
}, 10000);
