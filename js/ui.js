import { toHM } from "./util.js";
import { applyAlertLogic } from "./alerts.js";

export function renderWeather(data, timestamp){
  gulfWater.textContent = data.gulf.waterF + "°F";
  bayWater.textContent  = data.bay.waterF  + "°F";

  gulfAir.textContent = data.gulf.airF + "°F";
  bayAir.textContent  = data.bay.airF  + "°F";

  gulfWind.textContent =
    `${data.gulf.windKts}-${data.gulf.gustKts} kts ${data.gulf.windDirCardinal}`;

  bayWind.textContent =
    `${data.bay.windKts}-${data.bay.gustKts} kts ${data.bay.windDirCardinal}`;

  gulfSeas.textContent = "--";

  applyAlertLogic(data);

  updatedAt.style.color = "#e5e7eb";
  updatedAt.textContent = "UPDATED " + toHM(timestamp) + " LCL";
}

export function renderOffline(){
  updatedAt.style.color="#facc15";
  updatedAt.textContent="OFFLINE";
}
