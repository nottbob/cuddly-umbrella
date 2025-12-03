import { renderWeather, renderOffline } from "./ui.js";

export function saveData(data){
  localStorage.setItem("lastWeather", JSON.stringify(data));
}

export function loadData(){
  const raw = localStorage.getItem("lastWeather");
  if(!raw) return null;
  return JSON.parse(raw);
}

export function applyOfflineData(){
  const data = loadData();
  if(!data){
    renderOffline();
    return;
  }
  renderWeather(data, new Date());
  renderOffline();
}
