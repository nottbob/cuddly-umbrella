export function clearAlerts(){
  document.querySelectorAll('.alert-red,.alert-yellow')
    .forEach(el=>el.classList.remove("alert-red","alert-yellow"));
}

export function mark(id, cls){
  document.getElementById(id).classList.add(cls);
}

export function applyAlertLogic(data){
  clearAlerts();

  const gw=data.gulf.waterF, bw=data.bay.waterF;
  const ga=data.gulf.airF,   ba=data.bay.airF;

  const seas = null; // waves removed for now

  const waterLow = gw < 60 || bw < 60;
  const airLow   = ga < 60 || ba < 60;

  if(waterLow){
    mark("waterLabel","alert-red");
    mark("gulfWater","alert-red");
    mark("bayWater","alert-red");
  }

  if(airLow && !waterLow){
    mark("airLabel","alert-yellow");
    mark("gulfAir","alert-yellow");
    mark("bayAir","alert-yellow");
  }

  if(airLow && waterLow){
    mark("airLabel","alert-red");
    mark("gulfAir","alert-red");
    mark("bayAir","alert-red");
  }

  if(data.gulf.gustKts >= 25 || data.bay.gustKts >= 25 ||
     data.gulf.windKts >= 25 || data.bay.windKts >= 25){
    mark("windLabel","alert-red");
    mark("gulfWind","alert-red");
    mark("bayWind","alert-red");
  }

  // seas removed for now
}
