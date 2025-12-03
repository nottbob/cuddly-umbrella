import { oneDec, CtoF, mpsToKts, degToCardinal } from "./util.js";

export async function fetchBuoy(id){
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
  const resp = await fetch(url);

  if(!resp.ok) throw new Error("Buoy fetch failed");

  const text = await resp.text();
  const lines = text
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("#"));

  const rows = lines.map(line=>{
    const c = line.trim().split(/\s+/);
    return {
      WDIR: parseFloat(c[5]),
      WSPD: parseFloat(c[6]),
      GST:  parseFloat(c[7]),
      ATMP: parseFloat(c[13]),
      WTMP: parseFloat(c[14])
    };
  });

  const fallback = getter => {
    for(const r of rows){
      const v = getter(r);
      if(!isNaN(v)) return v;
    }
    return null;
  };

  const airC   = fallback(r=>r.ATMP);
  const waterC = fallback(r=>r.WTMP);
  const wspd   = fallback(r=>r.WSPD);
  const gust   = fallback(r=>r.GST);
  const wdir   = fallback(r=>r.WDIR);

  return {
    airF:   airC   != null ? oneDec(CtoF(airC)) : null,
    waterF: waterC != null ? oneDec(CtoF(waterC)) : null,
    windKts: wspd  != null ? oneDec(mpsToKts(wspd)) : null,
    gustKts: gust  != null ? oneDec(mpsToKts(gust)) : null,
    windDirCardinal: degToCardinal(wdir)
  };
}
