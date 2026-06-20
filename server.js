const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const HH_WFS = "https://geodienste.hamburg.de";

// ── WGS84 → UTM32N (EPSG:25832) Näherungsformel für Hamburg ──────────────
// Genau genug für BBOX-Abfragen (Fehler < 1m)
function wgs84ToUtm32(lon, lat) {
  const a = 6378137.0, f = 1/298.257223563;
  const b = a*(1-f), e2 = 1-(b/a)**2;
  const k0 = 0.9996, lon0 = 9 * Math.PI/180; // Zone 32
  const phi = lat*Math.PI/180, lam = lon*Math.PI/180;
  const N = a/Math.sqrt(1-e2*Math.sin(phi)**2);
  const T = Math.tan(phi)**2, C = e2/(1-e2)*Math.cos(phi)**2;
  const A = (lam-lon0)*Math.cos(phi);
  const e4 = e2**2, e6 = e2**3;
  const M = a*((1-e2/4-3*e4/64-5*e6/256)*phi
    -(3*e2/8+3*e4/32+45*e6/1024)*Math.sin(2*phi)
    +(15*e4/256+45*e6/1024)*Math.sin(4*phi)
    -(35*e6/3072)*Math.sin(6*phi));
  const x = k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120) + 500000;
  const y = k0*(M+N*Math.tan(phi)*(A**2/2+(5-T+9*C+4*C**2)*A**4/24+(61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720));
  return { x: Math.round(x), y: Math.round(y) };
}

function bboxUtm(lon, lat, delta=30) {
  const c = wgs84ToUtm32(lon, lat);
  return `${c.x-delta},${c.y-delta},${c.x+delta},${c.y+delta}`;
}

// ── Geocoding: Photon → Nominatim ─────────────────────────────────────────
async function geocode(adresse) {
  const m = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:\d{5}\s*)?(?:Hamburg)?$/i);
  if (!m) throw new Error(`Adresse nicht erkennbar: "${adresse}"`);
  const strasse = m[1].trim(), hausnummer = m[2].trim();

  // Photon (kein Rate-Limit, schnell)
  try {
    const r = await axios.get('https://photon.komoot.io/api/', {
      params: { q: `${strasse} ${hausnummer}, Hamburg, Germany`, limit: 3, lang: 'de' },
      timeout: 12000
    });
    const feat = r.data?.features?.find(f =>
      f.properties?.country === 'Germany' &&
      (f.properties?.city === 'Hamburg' || f.properties?.state === 'Hamburg')
    ) || r.data?.features?.[0];
    if (feat) {
      const [lon, lat] = feat.geometry.coordinates;
      console.log(`[Geocode] Photon OK: lat=${lat}, lon=${lon}`);
      return {
        lon, lat,
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: feat.properties?.district || feat.properties?.city || null,
        stadtteil: feat.properties?.suburb || feat.properties?.district || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Photon: ${e.message}`); }

  // Nominatim Fallback
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: `${strasse} ${hausnummer}, Hamburg`, format: 'json', limit: 1, addressdetails: 1, countrycodes: 'de' },
      timeout: 12000,
      headers: { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' }
    });
    if (r.data?.length > 0) {
      const d = r.data[0];
      console.log(`[Geocode] Nominatim OK: lat=${d.lat}, lon=${d.lon}`);
      return {
        lon: parseFloat(d.lon), lat: parseFloat(d.lat),
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: d.address?.suburb || d.address?.city_district || null,
        stadtteil: d.address?.neighbourhood || d.address?.suburb || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Nominatim: ${e.message}`); }

  throw new Error(`Adresse nicht gefunden: "${adresse}"`);
}

// ── B-Plan: WFS mit UTM32-BBOX ────────────────────────────────────────────
async function fetchBPlan(lon, lat) {
  const bbox = bboxUtm(lon, lat, 30);
  console.log(`[BPlan] UTM32-BBOX: ${bbox}`);

  const versuche = [
    // Festgestellte B-Pläne (primär)
    `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:hh_hh_festgestellt&outputFormat=application/geo%2Bjson`
      + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
    // prosin_gesamt (alle)
    `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:prosin_gesamt&outputFormat=application/geo%2Bjson`
      + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
    // WFS 1.1.0 Fallback
    `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature`
      + `&TYPENAME=app:prosin_gesamt&outputFormat=application/geo%2Bjson`
      + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
  ];

  for (const url of versuche) {
    try {
      const r = await axios.get(url, { timeout: 25000 });
      const feats = r.data?.features || [];
      console.log(`[BPlan] Versuch: ${feats.length} Features`);
      if (feats.length > 0) {
        const p = feats[0].properties || {};
        console.log(`[BPlan] Props:`, JSON.stringify(p).substring(0, 200));
        return {
          planName:          p.geltendes_planrecht || p.planname || p.name || null,
          planStatus:        p.planstatus || p.status || 'festgesetzt',
          pdfUrl:            p.planrecht || p.docurl || null,
          feststellungsdatum: p.feststellungsdatum || null,
        };
      }
    } catch(e) {
      console.warn(`[BPlan] Versuch fehlgeschlagen: ${e.response?.status} – ${e.message}`);
    }
  }
  return null;
}

// ── XPlanung ──────────────────────────────────────────────────────────────
async function fetchXPlanungsDaten(planName) {
  if (!planName) return null;
  const url = `${HH_WFS}/HH_WFS_xplan_dls?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=xplan:BP_Plan&outputFormat=application/geo%2Bjson`
    + `&CQL_FILTER=name='${encodeURIComponent(planName)}'`;
  try {
    const r = await axios.get(url, { timeout: 20000 });
    const f = r.data?.features?.[0];
    if (f) {
      const p = f.properties || {};
      console.log(`[XPlanung] Props:`, JSON.stringify(p).substring(0, 300));
      return {
        name: p.name || planName,
        planArt: p.planart || 'BPlan',
        baugebiete: [{ nutzungsform: p.nutzungsform || null, grz: p.grz || null, gfz: p.gfz || null, maxGeschosse: p.zahl_vollgeschosse || null }],
      };
    }
  } catch(e) { console.warn(`[XPlanung] ${e.message}`); }
  return null;
}

// ── Erhaltungsverordnungen ────────────────────────────────────────────────
async function fetchErhaltungsgebiete(lon, lat) {
  const bbox = bboxUtm(lon, lat, 30);
  const url = `${HH_WFS}/HH_WFS_Erhaltungsverordnungen?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=app:erhaltungsverordnungen&outputFormat=application/geo%2Bjson`
    + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`;
  try {
    const r = await axios.get(url, { timeout: 15000 });
    const feats = r.data?.features || [];
    return feats.map(f => ({
      name: f.properties?.name || f.properties?.gebietsname || 'Erhaltungsgebiet',
      paragraf: '§ 172 BauGB',
      hinweis: 'Bauliche Veränderungen an Wohngebäuden genehmigungspflichtig',
    }));
  } catch(e) {
    console.warn(`[Erhaltung] ${e.message}`);
    return [];
  }
}

// ── Haupt-Endpoint ────────────────────────────────────────────────────────
app.get('/api/analyse', async (req, res) => {
  const adresse = req.query.adresse;
  if (!adresse) return res.status(400).json({ error: 'Parameter "adresse" fehlt' });
  try {
    console.log(`[AutoBLP] Analyse für: ${adresse}`);
    const koordinaten = await geocode(adresse);
    console.log(`[AutoBLP] Koordinaten: lon=${koordinaten.lon}, lat=${koordinaten.lat}`);
    const utm = wgs84ToUtm32(koordinaten.lon, koordinaten.lat);
    console.log(`[AutoBLP] UTM32: x=${utm.x}, y=${utm.y}`);

    const [bplan, erhaltung] = await Promise.all([
      fetchBPlan(koordinaten.lon, koordinaten.lat),
      fetchErhaltungsgebiete(koordinaten.lon, koordinaten.lat),
    ]);
    const xplanung = bplan?.planName ? await fetchXPlanungsDaten(bplan.planName) : null;

    res.json({
      meta: { abfragezeit: new Date().toISOString(), quelle: 'Urban Data Platform Hamburg (LGV)', lizenz: 'Datenlizenz Deutschland Namensnennung 2.0' },
      adresse: koordinaten,
      bebauungsplan: bplan,
      xplanung,
      erhaltungsgebiete: erhaltung,
    });
  } catch (err) {
    console.error(`[AutoBLP] Fehler:`, err.message);
    res.status(500).json({ error: err.message, hinweis: 'Hamburger Adresse im Format "Straßenname Hausnummer, Hamburg" angeben' });
  }
});

// ── Debug: zeigt rohe B-Plan-Antwort ─────────────────────────────────────
app.get('/debug/bplan', async (req, res) => {
  const lon = parseFloat(req.query.lon || '9.9384');
  const lat = parseFloat(req.query.lat || '53.5672');
  const bbox = bboxUtm(lon, lat, 50);
  const url = `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=app:hh_hh_festgestellt&outputFormat=application/geo%2Bjson`
    + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`;
  try {
    const r = await axios.get(url, { timeout: 15000 });
    res.json({ utm_bbox: bbox, status: r.status, data: r.data });
  } catch(e) {
    res.json({ utm_bbox: bbox, error: e.message, status: e.response?.status, data: e.response?.data });
  }
});

app.get('/api/polygon', async (req, res) => res.json({ bebauungsplaene: [], erhaltungsgebiete: [], anzahl: 0 }));
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));
app.get('/', (_, res) => res.json({ status: 'ok', endpoints: ['/health', '/api/analyse?adresse=...', '/debug/bplan?lon=9.9384&lat=53.5672'] }));

app.listen(PORT, () => console.log(`AutoBLP Backend läuft auf Port ${PORT}`));
