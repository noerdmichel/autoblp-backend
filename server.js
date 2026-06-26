const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const HH_WFS = "https://geodienste.hamburg.de";

// ── WGS84 → UTM32N (EPSG:25832) Näherungsformel für Hamburg ──────────────
function wgs84ToUtm32(lon, lat) {
  const a = 6378137.0, f = 1/298.257223563;
  const b = a*(1-f), e2 = 1-(b/a)**2;
  const k0 = 0.9996, lon0 = 9 * Math.PI/180;
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
// Fix: PLZ-Erkennung + Photon Hamburg-Bounding-Box + Nominatim structured search
async function geocode(adresse) {
  // PLZ optional: "Marktstraße 20a, 20357 Hamburg" oder "Marktstraße 20a, Hamburg"
  const m = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:(\d{5})\s*)?(?:Hamburg)?$/i);
  if (!m) throw new Error(`Adresse nicht erkennbar: "${adresse}"`);
  const strasse = m[1].trim(), hausnummer = m[2].trim(), plz = m[3] || null;

  const query = plz
    ? `${strasse} ${hausnummer}, ${plz} Hamburg, Germany`
    : `${strasse} ${hausnummer}, Hamburg, Germany`;

  // Strategie 0: Nominatim — bevorzuge echte Gebäude-Koordinaten (nicht highway)
  try {
    const buildingUrl = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=de&limit=5&q=${encodeURIComponent(strasse + ' ' + hausnummer + ', Hamburg')}`;
    const br = await axios.get(buildingUrl, { timeout: 8000, headers: { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' } });
    const data = br.data || [];
    // Bevorzuge Gebäude, POIs, historic — nicht Straßen (highway)
    const best = data.find(x => x.class !== 'highway') || data[0];
    if (best) {
      const isExact = best.class !== 'highway';
      console.log(`[Geocode] Nominatim: lat=${best.lat}, lon=${best.lon}, class=${best.class}, exact=${isExact}`);
      return {
        lon: parseFloat(best.lon), lat: parseFloat(best.lat),
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: best.address?.city_district || best.address?.suburb || null,
        stadtteil: best.address?.suburb || null,
        positionExakt: isExact, // Signal fürs Frontend: Marker-Hinweis
      };
    }
  } catch(e) { console.warn(`[Geocode] Gebäude-Suche: ${e.message}`); }

  // Photon Strategie 1: gezielt nach Gebäude/Hausnummer suchen (place:house)
  // Das liefert die exakten Gebäude-Koordinaten, nicht die Straßenmitte
  try {
    const r = await axios.get('https://photon.komoot.io/api/', {
      params: {
        q: query,
        limit: 10,
        lang: 'de',
        bbox: '8.4,53.3,10.3,53.75',
        osm_tag: 'place:house',
      },
      timeout: 12000
    });
    const feats = r.data?.features || [];
    const feat = feats.find(f => {
      const p = f.properties;
      const inHH = p?.country === 'Germany' && (p?.city === 'Hamburg' || p?.state === 'Hamburg');
      const hnMatch = p?.housenumber && (
        p.housenumber.toLowerCase() === hausnummer.toLowerCase() ||
        p.housenumber.toLowerCase().startsWith(hausnummer.toLowerCase())
      );
      return inHH && hnMatch;
    });
    if (feat) {
      const [lon, lat] = feat.geometry.coordinates;
      console.log(`[Geocode] Photon house OK: lat=${lat}, lon=${lon}, hn=${feat.properties?.housenumber}`);
      return {
        lon, lat,
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: feat.properties?.district || feat.properties?.city || null,
        stadtteil: feat.properties?.suburb || feat.properties?.district || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Photon house: ${e.message}`); }

  // Photon Strategie 2: allgemeine Suche mit Hamburg-BBox
  try {
    const r = await axios.get('https://photon.komoot.io/api/', {
      params: { q: query, limit: 5, lang: 'de', bbox: '8.4,53.3,10.3,53.75' },
      timeout: 12000
    });
    const feats = r.data?.features || [];
    const feat = feats.find(f => {
      const p = f.properties;
      const inHH = p?.country === 'Germany' && (p?.city === 'Hamburg' || p?.state === 'Hamburg');
      const hnMatch = p?.housenumber && p.housenumber.toLowerCase().startsWith(hausnummer.toLowerCase());
      return inHH && hnMatch;
    }) || feats.find(f => {
      const p = f.properties;
      return p?.country === 'Germany' && (p?.city === 'Hamburg' || p?.state === 'Hamburg');
    });
    if (feat) {
      const [lon, lat] = feat.geometry.coordinates;
      console.log(`[Geocode] Photon general OK: lat=${lat}, lon=${lon}, suburb=${feat.properties?.suburb}`);
      return {
        lon, lat,
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: feat.properties?.district || feat.properties?.city || null,
        stadtteil: feat.properties?.suburb || feat.properties?.district || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Photon: ${e.message}`); }

  // Nominatim Fallback — structured search für bessere Eindeutigkeit
  try {
    const params = plz
      ? { street: `${hausnummer} ${strasse}`, postalcode: plz, city: 'Hamburg', country: 'de', format: 'json', limit: 1, addressdetails: 1 }
      : { street: `${hausnummer} ${strasse}`, city: 'Hamburg', country: 'de', format: 'json', limit: 1, addressdetails: 1 };

    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params,
      timeout: 12000,
      headers: { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' }
    });
    if (r.data?.length > 0) {
      const d = r.data[0];
      console.log(`[Geocode] Nominatim OK: lat=${d.lat}, lon=${d.lon}`);
      return {
        lon: parseFloat(d.lon), lat: parseFloat(d.lat),
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: d.address?.city_district || d.address?.suburb || null,
        stadtteil: d.address?.suburb || d.address?.neighbourhood || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Nominatim: ${e.message}`); }

  throw new Error(`Adresse nicht gefunden: "${adresse}"`);
}

// ── ALKIS Hauskoordinaten Hamburg ────────────────────────────────────────────
// Offizielle Hamburger Adressdaten mit exakten Gebäude-Koordinaten
async function fetchAlkisKoordinaten(strasse, hausnummer) {
  try {
    // Hausnummer in Zahl und Zusatz trennen: "20a" → "20" + "a"
    const m = hausnummer.match(/^(\d+)([a-zA-Z]?)$/);
    if (!m) return null;
    const hn = m[1], zusatz = m[2] || '';

    // INSPIRE WFS: Adressen Hauskoordinaten Hamburg
    // Gibt amtliche ALKIS-Koordinaten zurück — exakter als OSM
    let filter = `strassenname='${strasse}' AND hausnummer='${hn}'`;
    if (zusatz) filter += ` AND hausnummernzusatz='${zusatz}'`;
    
    const url = `https://geodienste.hamburg.de/HH_WFS_INSPIRE_Adressen?service=WFS&version=2.0.0&request=GetFeature&typeNames=ad:Address&count=1&CQL_FILTER=${encodeURIComponent(filter)}`;
    const r = await axios.get(url, { timeout: 8000 });
    const text = r.data;

    // GML Koordinaten extrahieren (ETRS89/UTM32 → WGS84)
    const posMatch = text.match(/<gml:pos[^>]*>([\d.]+ [\d.]+)<\/gml:pos>/);
    if (posMatch) {
      const [x, y] = posMatch[1].split(' ').map(Number);
      // INSPIRE nutzt Lat/Lon Reihenfolge in EPSG:4326
      if (x > 50 && y > 5) { // Lat > 50, Lon > 5 = Hamburg
        console.log(`[ALKIS] ${strasse} ${hausnummer}: lat=${x}, lon=${y}`);
        return { lat: x, lon: y };
      }
      if (y > 50 && x > 5) {
        console.log(`[ALKIS] ${strasse} ${hausnummer}: lat=${y}, lon=${x}`);
        return { lat: y, lon: x };
      }
    }
  } catch(e) {
    console.warn(`[ALKIS] ${e.message}`);
  }
  return null;
}

// ── Google Drive: PDFs beim Start laden ──────────────────────────────────
let driveSystemContext = '';

// Drive-Datei als base64 laden
async function loadDriveFile(fileId) {
  const key = process.env.GOOGLE_API_KEY;
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${key}`;
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(r.data).toString('base64');
}

// Drive-Index: planName → fileId für schnellen Lookup
let driveBplanIndex = {}; // z.B. { 'StPauli37': '1abc...', ... }

async function buildDriveIndex() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return;
  try {
    // BPläne-Ordner indexieren (ID: 15J2KkY3ajqBl7Pg-usqWRb64HO53IQiA)
    const BPLANE_FOLDER = '15J2KkY3ajqBl7Pg-usqWRb64HO53IQiA';
    const url = `https://www.googleapis.com/drive/v3/files?q='${BPLANE_FOLDER}'+in+parents&fields=files(id,name)&pageSize=200&key=${key}`;
    const r = await axios.get(url, { timeout: 15000 });
    for (const f of (r.data.files || [])) {
      // Dateiname z.B. "StPauli37.pdf" oder "StPauli37(1).pdf" → Key "StPauli37"
      const key2 = f.name.replace(/\([^)]*\)/g, '').replace('.pdf', '').trim();
      if (!driveBplanIndex[key2]) driveBplanIndex[key2] = f.id;
    }
    console.log('[Drive] B-Plan Index:', Object.keys(driveBplanIndex).length, 'Einträge');
  } catch(e) { console.warn('[Drive] Index-Fehler:', e.message); }
}

async function loadDriveContext() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) { console.log('[Drive] Kein API Key'); return; }

  // Wichtigste Rechtstexte + Hamburg Grundlagen (kleine Dateien priorisiert)
  const fileIds = [
    // Bundesrecht (Kerngesetze)
    { id: '1gEa_qNIFkp6BtYBFF__qoI4zcGwxbOr6', name: 'BauNVO' },
    // Hamburg Grundlagen
    { id: '1BKx1vJA-bJFX0AdQz4VyfSXqXppQ6voK', name: 'Regelung Kostenbeteiligung Hamburg' },
    { id: '1xn6EdBoUK_6ma4F8mU9fQX1uxuLneCeH', name: 'Handreichung Verschattungsstudien Hamburg' },
    { id: '1AfNzmJu1-tDPYwNLUM8yaXYtuLfV345s', name: 'Hamburger Klimaplan 2. Fortschreibung' },
    { id: '17LvTo0I-wqz7Th9X27UeXY8A5OKrP_EZ', name: 'Bürgerbeteiligung Hamburg Planungsverfahren' },
    { id: '1vQLaJNsM-7Dc4pgT4WPBqMnuspWUrBat', name: 'Hamburg macht Pläne - Planungsverfahren' },
    // Hamburg Recht
    { id: '1jXREkO_CxaaoJ1feiY7IIa7dxjetaC9R', name: 'Hamburgische Bauordnung (HBauO)' },
    { id: '1VnUmHYfGn4nYVOcVylOBRH k0zptEluaF', name: 'BauleitplG Hamburg § 3' },
  ];

  try {
    const content = [];
    for (const f of fileIds) {
      try {
        console.log('[Drive] Lade:', f.name);
        const b64 = await loadDriveFile(f.id);
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }, title: f.name });
      } catch(e) { console.warn('[Drive] Fehler bei', f.name, ':', e.message); }
    }
    if (content.length === 0) return;
    content.push({ type: 'text', text: 'Extrahiere die wichtigsten Regelungen, Kennzahlen, Grenzwerte und Verfahrensanforderungen aus diesen Dokumenten als kompakten Referenztext für einen KI-Assistenten zur Hamburger Bauleitplanung. Max 2000 Wörter, strukturierte Stichpunkte nach Thema.' });
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 2500,
      messages: [{ role: 'user', content }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 180000 });
    driveSystemContext = resp.data.content[0].text;
    console.log('[Drive] Kontext geladen:', driveSystemContext.length, 'Zeichen');
  } catch(e) { console.warn('[Drive] Fehler:', e.message); }
}

// Beim Server-Start
buildDriveIndex();
loadDriveContext();

// ── B-Plan: WFS mit UTM32-BBOX ────────────────────────────────────────────
async function fetchBPlan(lon, lat) {
  const bbox = bboxUtm(lon, lat, 30);
  console.log(`[BPlan] UTM32-BBOX: ${bbox}`);

  const versuche = [
    `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:hh_hh_festgestellt&outputFormat=application/geo%2Bjson`
      + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
    `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:prosin_gesamt&outputFormat=application/geo%2Bjson`
      + `&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
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
          planName:           p.geltendes_planrecht || p.planname || p.name || null,
          planStatus:         p.planstatus || p.status || 'festgesetzt',
          pdfUrl:             p.planrecht || p.docurl || null,
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
  // delta=500: Erhaltungsverordnungen sind große Gebiete, kleine BBOX verfehlt sie
  const bbox = bboxUtm(lon, lat, 500);
  // Korrekter Endpoint (Stand 2025): HH_WFS_Erhaltungsverordnung (ohne 'en')
  // Layer: de.hh.up:erhaltungsverordnung
  const urls = [
    `${HH_WFS}/HH_WFS_Erhaltungsverordnung?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=de.hh.up:erhaltungsverordnung&outputFormat=application/geo%2Bjson&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
    `${HH_WFS}/HH_WFS_Erhaltungsverordnung?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=app:erhaltungsverordnung&outputFormat=application/geo%2Bjson&BBOX=${bbox},urn:ogc:def:crs:EPSG::25832`,
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 15000 });
      const feats = r.data?.features || [];
      console.log(`[Erhaltung] ${feats.length} Features gefunden`);
      if (feats.length >= 0) { // auch leere Antwort ist valide
        return feats.map(f => ({
          name: f.properties?.verordnung || f.properties?.kurzbezeichnung || f.properties?.name || 'Erhaltungsgebiet',
          kurzbezeichnung: f.properties?.kurzbezeichnung || null,
          pdfUrl: f.properties?.erhaltungsverordnung || null,
          paragraf: '§ 172 BauGB',
          hinweis: 'Bauliche Veränderungen an Wohngebäuden genehmigungspflichtig',
        }));
      }
    } catch(e) {
      console.warn(`[Erhaltung] Versuch fehlgeschlagen (${e.response?.status}): ${e.message}`);
    }
  }
  return [];
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

// ── Debug: Geocoding testen ───────────────────────────────────────────────
// ── Debug: Google Drive Ordner-Inhalt ────────────────────────────────────
app.get('/api/drive-files', async (req, res) => {
  const folderId = req.query.folderId || '19YUdzbMBqEoBdR2xTxLxvReivPYZ0Nrr';
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return res.json({ error: 'GOOGLE_API_KEY nicht gesetzt' });
  try {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType,size)&pageSize=100&key=${key}`;
    const r = await axios.get(url, { timeout: 10000 });
    res.json(r.data);
  } catch(e) {
    res.json({ error: e.message, status: e.response?.status, detail: e.response?.data });
  }
});

// ── Training: PDFs von URL laden und analysieren ────────────────────────
app.post('/api/extract-training-url', async (req, res) => {
  const { urls } = req.body; // Array von {name, url}
  if (!urls?.length) return res.status(400).json({ error: 'Keine URLs' });
  try {
    const content = [];
    for (const item of urls) {
      console.log(`[Training] Lade: ${item.name}`);
      const r = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
      const b64 = Buffer.from(r.data).toString('base64');
      content.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data: b64 }, title: item.name });
    }
    content.push({ type:'text', text:`Extrahiere aus diesen Hamburger Planungsdokumenten alle konkreten Regelungen, Kennzahlen und Anforderungen für die Analyse von Bebauungsplänen. Strukturiere als kompakten Referenztext. Fokus: Klimaanforderungen, Dachbegrünung, Verschattung, Fassadengestaltung, Kostenbeteiligung, Planungsverfahren Hamburg. Max 2000 Wörter, strukturierte Stichpunkte.` });
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 3000,
      messages: [{ role: 'user', content }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
    res.json({ text: response.data.content[0].text });
  } catch(e) { res.json({ error: e.message, detail: e.response?.data }); }
});

// ── Training: PDF-Inhalte für Systemprompt extrahieren ──────────────────
app.post('/api/extract-training', async (req, res) => {
  const { pdfs } = req.body; // Array von {name, base64}
  if (!pdfs?.length) return res.status(400).json({ error: 'Keine PDFs' });
  try {
    const content = [];
    for (const pdf of pdfs) {
      content.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data:pdf.base64 }, title: pdf.name });
    }
    content.push({ type:'text', text:`Extrahiere aus diesen Hamburger Planungsdokumenten alle konkreten Regelungen, Kennzahlen und Anforderungen die für die Analyse von Bebauungsplänen relevant sind. Strukturiere als kompakten Referenztext für einen KI-Systemprompt. Fokus: Klimaanforderungen, Dachbegrünung, Verschattung, Fassadengestaltung, Kostenbeteiligung, Planungsverfahren Hamburg. Max 2000 Wörter, kein Fließtext sondern strukturierte Stichpunkte.` });
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 3000,
      messages: [{ role: 'user', content }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
    res.json({ text: response.data.content[0].text });
  } catch(e) { res.json({ error: e.message }); }
});

// ── Debug: Rohe Autocomplete-Antwort von Nominatim ──────────────────────
app.get('/debug/autocomplete', async (req, res) => {
  const q = req.query.q || 'Marktstraße';
  const headers = { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' };
  const base = 'https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1&countrycodes=de';
  const url = `${base}&q=${encodeURIComponent(q + ', Hamburg, Germany')}`;
  try {
    const r = await axios.get(url, { headers, timeout: 8000 });
    res.json({ url, count: r.data.length, results: r.data });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Debug: ALKIS direkt testen
app.get('/debug/alkis', async (req, res) => {
  const { strasse, hausnummer, zusatz } = req.query;
  try {
    const result = await fetchAlkisKoordinaten(strasse || 'Marktstraße', hausnummer || '20', zusatz || 'a');
    // Auch rohen WFS-Response zurückgeben
    let hn = hausnummer || '20', zus = zusatz || 'a';
    let filter = `strassenname='${strasse || 'Marktstraße'}' AND hausnummer='${hn}'`;
    if (zus) filter += ` AND hausnummernzusatz='${zus}'`;
    const url = `https://geodienste.hamburg.de/HH_WFS_INSPIRE_Adressen?service=WFS&version=2.0.0&request=GetFeature&typeNames=ad:Address&count=1&CQL_FILTER=${encodeURIComponent(filter)}`;
    const r = await axios.get(url, { timeout: 10000 });
    res.json({ alkisResult: result, rawPreview: r.data.substring(0, 500), url });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/debug/geocode', async (req, res) => {
  const adresse = req.query.adresse || 'Marktstraße 20a, Hamburg';
  try {
    const result = await geocode(adresse);
    res.json({ adresse, result });
  } catch(e) {
    res.json({ adresse, error: e.message });
  }
});

// ── Autocomplete Endpoint ─────────────────────────────────────────────────
app.get('/api/autocomplete', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 3) return res.json([]);

  const headers = { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' };
  const base = 'https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1&countrycodes=de';

  // Query parsen: Straße + Hausnummer trennen
  const hasNumber = /\d/.test(q);
  const mParse = q.trim().match(/^(.+?)\s+(\d+\w*)$/);
  const streetPart = mParse ? mParse[1].trim() : q.trim();
  const hnPart = mParse ? mParse[2] : null;

  try {
    let items = [];
    const seen = new Set();

    if (hasNumber) {
      // Mit Hausnummer: mehrere Query-Varianten versuchen
      const queries = [q];
      // Fallback 1: ohne Buchstaben-Suffix (20a → 20)
      const noSuffix = q.replace(/([a-zA-Z])$/, '').trim();
      if (noSuffix !== q) queries.push(noSuffix);
      // Fallback 2: nur Straßenname
      if (streetPart !== q) queries.push(streetPart);

      for (const query of queries) {
        const url = `${base}&q=${encodeURIComponent(query + ', Hamburg')}`;
        const r = await axios.get(url, { headers, timeout: 8000 });
        const data = r.data || [];
        console.log(`[AC] Adresse "${query}" → ${data.length} Treffer`);

        for (const result of data) {
          const a = result.address || {};
          const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway || '';
          if (!road) continue;
          // Hausnummer: aus Nominatim oder aus Original-Query
          const nomHn = a.house_number || '';
          const hn = nomHn ? ` ${nomHn}` : (hnPart ? ` ${hnPart}` : '');
          const label = `${road}${hn}, Hamburg`;
          if (seen.has(label)) continue;
          seen.add(label);
          const sub = a.suburb || a.neighbourhood || a.borough || 'Hamburg';
          items.push({ label, sub: sub === 'Hamburg' ? 'Hamburg' : sub });
          if (items.length >= 7) break;
        }
        if (items.length > 0) break;
      }
    } else {
      // Nur Straßenname: Straßen suchen und als Vorschlag anbieten
      const url = `${base}&q=${encodeURIComponent(q + ', Hamburg')}`;
      const r = await axios.get(url, { headers, timeout: 8000 });
      const data = r.data || [];
      console.log(`[AC] Straße "${q}" → ${data.length} Treffer`);

      for (const result of data) {
        const a = result.address || {};
        const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway || '';
        if (!road) continue;
        // Straßenvorschlag ohne Nummer — Sub zeigt Stadtteil
        const label = `${road}, Hamburg`;
        if (seen.has(label)) continue;
        seen.add(label);
        const sub = a.suburb || a.neighbourhood || a.borough || 'Hamburg';
        items.push({
          label,
          sub: (sub === 'Hamburg' ? '' : sub + ' · ') + 'Hausnummer eingeben',
          streetOnly: true  // Signal fürs Frontend: nur Straße, noch keine Analyse
        });
        if (items.length >= 5) break;
      }
    }

    console.log(`[Autocomplete] "${q}" → ${items.length} Items`);
    res.json(items);
  } catch (err) {
    console.error(`[Autocomplete] Fehler: ${err.message}`);
    res.json([]);
  }
});

app.get('/api/polygon', async (req, res) => res.json({ bebauungsplaene: [], erhaltungsgebiete: [], anzahl: 0 }));
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));
app.get('/', (_, res) => res.json({ status: 'ok', endpoints: ['/health', '/api/analyse?adresse=...', '/debug/bplan', '/debug/geocode?adresse=...'] }));

app.listen(PORT, () => console.log(`AutoBLP Backend läuft auf Port ${PORT}`));

// ── B-Plan PDF Analyse via Claude API ─────────────────────────────────────
const DRIVE_FOLDER_ID = '19YUdzbMBqEoBdR2xTxLxvReivPYZ0Nrr';

async function downloadPdfAsBase64(planName) {
  try {
    if (process.env.GOOGLE_API_KEY) {
      const listUrl = `https://www.googleapis.com/drive/v3/files?q='${DRIVE_FOLDER_ID}'+in+parents+and+name+contains+'${planName}'&key=${process.env.GOOGLE_API_KEY}&fields=files(id,name)`;
      const listRes = await axios.get(listUrl, { timeout: 10000 });
      const files = listRes.data.files || [];
      const match = files.find(f => f.name.toLowerCase().startsWith(planName.toLowerCase()));
      if (match) {
        const downloadUrl = `https://drive.google.com/uc?export=download&id=${match.id}`;
        const pdfRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
        return Buffer.from(pdfRes.data).toString('base64');
      }
    }

    // Fallback: direkter Download über daten-hamburg.de
    const hamburgUrl = `https://daten-hamburg.de/infrastruktur_bauen_wohnen/bebauungsplaene/pdfs/bplan/${planName}.pdf`;
    console.log(`[BPlanAnalyse] Lade PDF von Hamburg: ${hamburgUrl}`);
    const pdfRes = await axios.get(hamburgUrl, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(pdfRes.data).toString('base64');

  } catch(e) {
    console.warn(`[BPlanAnalyse] PDF-Download fehlgeschlagen: ${e.message}`);
    return null;
  }
}

async function analysePlanMitClaude(planName, pdfBase64, frage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const systemPrompt = `Du bist ein erfahrener Stadtplaner und Jurist für Baurecht in Hamburg. Du analysierst Bebauungspläne und Baustufenpläne der Freien und Hansestadt Hamburg und gibst konkrete, rechtlich fundierte Einschätzungen für Bauvorhaben.

## Rechtliche Grundlagen

**Bundesrecht:**
- BauGB § 1-13: Bauleitplanung, Aufstellungsverfahren, Bürgerbeteiligung (§ 3 BauGB)
- BauGB § 172: Erhaltungssatzungen — Genehmigungspflicht für Rückbau, Änderung, Nutzungsänderung
- BauGB § 233: Überleitung von Baustufenplänen (BSP) als qualifizierte Bebauungspläne
- BauGB § 34: Zulässigkeit im unbeplanten Innenbereich (Einfügegebot)
- BauNVO: Gebietsarten (WA, WR, MI, MK, GE, GI, SO), GRZ/GFZ-Obergrenzen (§ 17 BauNVO)
- BauNVO § 19: GRZ-Überschreitung bis 50% durch Nebenanlagen zulässig
- BauNVO § 20: GFZ als Höchstmaß

**Hamburgisches Recht:**
- HBauO § 6: Abstandsflächen (0,4H, mind. 2,5m in Hamburg)
- HBauO § 48: Stellplatzpflicht
- § 172 BauGB i.V.m. HmbWoSchG: Soziale Erhaltungsverordnungen (Milieuschutz)

## Hamburger Planungspraxis

**Bebauungsplanverfahren:**
- Aufstellung durch Bezirksamt, Feststellung durch Senat
- Bürgerbeteiligung: § 3 Abs. 1 (frühzeitig) + § 3 Abs. 2 BauGB (Auslegung)
- Städtebauliche Verträge § 11 BauGB: Kostenbeteiligung an Erschließung, Grünflächen, sozialer Infrastruktur
- Erschließungskosten: bis 90% auf Eigentümer umlegbar (§ 127 ff. BauGB)

**Hamburger Klimaplan (2. Fortschreibung 2022):**
- Klimaschutzziel: Hamburg klimaneutral bis 2045
- Dachbegrünung, Fassadenbegrünung, Versickerungsflächen als B-Plan-Festsetzung (§ 9 Abs. 1 Nr. 25 BauGB)
- Hitzeminderung durch Begrünung und Kaltluftschneisen
- PV-Pflicht auf Neubauten ab 2023 in Hamburg
- Starkregenrisiko: Retentionsflächen, Mulden-Rigolen-Systeme

**Dachbegrünung:**
- Extensiv: ab 15° Neigung, Substrat 6-15cm, kein Pflegeaufwand, 50% Regenwasser-Rückhalt
- Intensiv: Flachdächer, Substrat >15cm, begehbar
- Förderung durch IFB Hamburg

**Verschattung (Handreichung Hamburg):**
- Mindestbesonnung Wohnnutzung: 1,5h/Tag zur Tagundnachtgleiche (21. März)
- Simulationspflicht ab bestimmten Gebäudehöhen
- DIN 5034 für Solar- und Tageslichtanalyse

**Fassadengestaltung:**
- Gestaltungssatzungen in Erhaltungsbereichen: Klinker, Putz, Naturstein
- Werbeanlagen eingeschränkt in WA-Gebieten (§ 13 BauNVO)

**Hamburger Zentrenkonzept:**
- Hierarchie: Hauptzentren → Stadtteilzentren → Nahversorgungszentren
- Großflächiger Einzelhandel (>800m² VK) nur in ausgewiesenen Zentren
- Einzelhandelsausschluss in GE für zentrenrelevante Sortimente

**Soziale Erhaltungsverordnungen Hamburg:**
- Gebiete: St. Pauli, Altona-Altstadt, Ottensen, Eimsbüttel, Barmbek, Eilbek, Hamm u.a.
- Genehmigungspflicht: Rückbau, Nutzungsänderung, aufwertende Maßnahmen
- Versagungsgrund: Verdrängung der angestammten Wohnbevölkerung
- Luxusmodernisierungen grundsätzlich versagbar

## Ausgabeformat

Antworte strukturiert:
1. **Gebietsausweisung und Nutzungsart**
2. **Bauliche Kennzahlen** (GRZ, GFZ, Geschosse, Bauweise — mit konkreten Werten aus dem Plan)
3. **Besondere Festsetzungen** (Erhaltungsbereich, Lärmschutz, Stellplätze, Dachbegrünung etc.)
4. **Gestaltungsrichtlinien**
5. **Relevante Planungskonzepte** (Klimaplan, Zentrenkonzept, Milieuschutz)
6. **Rechtliche Einschätzung**
7. **Nächste Schritte**

Orientierungsanalyse — keine Rechtsberatung. Für verbindliche Auskünfte: zuständiges Bezirksamt Hamburg.`
    + (driveSystemContext ? '\n\n## Aus den Hamburger Planungsgrundlagen\n' + driveSystemContext : '');

  const userMessage = frage
    ? `Analysiere den Bebauungsplan "${planName}" und beantworte folgende Frage: ${frage}`
    : `Analysiere den Bebauungsplan "${planName}" vollständig und extrahiere alle relevanten Festsetzungen.`;

  const messages = [{
    role: 'user',
    content: pdfBase64 ? [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: userMessage }
    ] : [
      { type: 'text', text: userMessage + `\n\nHinweis: Das PDF konnte nicht geladen werden. Bitte gib eine allgemeine Einschätzung basierend auf deinem Wissen über Hamburger Baustufenpläne.` }
    ]
  }];

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages,
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 60000,
  });

  return response.data.content[0].text;
}

// ── API Endpoint: Kennzahlen als JSON ────────────────────────────────────────
app.get('/api/bplan-kennzahlen', async (req, res) => {
  const { planName } = req.query;
  if (!planName) return res.status(400).json({ error: 'planName fehlt' });
  try {
    // Versuche zuerst Drive-PDF (exakter Match), dann Hamburg-Fallback
  let pdfBase64 = null;
  const driveFileId = driveBplanIndex[planName];
  if (driveFileId) {
    try {
      console.log('[BPlanAnalyse] Lade PDF aus Drive:', planName);
      pdfBase64 = await loadDriveFile(driveFileId);
      console.log('[BPlanAnalyse] Drive PDF geladen:', Math.round(pdfBase64.length * 0.75 / 1024), 'KB');
    } catch(e) { console.warn('[BPlanAnalyse] Drive Fehler, fallback:', e.message); }
  }
  if (!pdfBase64) pdfBase64 = await downloadPdfAsBase64(planName);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    const messages = [{
      role: 'user',
      content: pdfBase64 ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: `Extrahiere aus dem Bebauungsplan "${planName}" folgende Werte und antworte NUR mit einem JSON-Objekt, ohne Erklärung, ohne Markdown:
{"nutzungsart": "z.B. WA – Allgemeines Wohngebiet", "grz": "z.B. 0.4", "gfz": "z.B. 1.2", "geschosse": "z.B. IV"}
Wenn ein Wert nicht eindeutig bestimmbar ist, nutze den häufigsten/typischen Wert für das Plangebiet. Gib immer Werte an, nie null.` }
      ] : [
        { type: 'text', text: `Für den Hamburger Bebauungsplan "${planName}": Gib typische Werte als JSON: {"nutzungsart": "...", "grz": "...", "gfz": "...", "geschosse": "..."}` }
      ]
    }];

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 200, messages,
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 60000,
    });

    const rawText = response.data.content[0].text.trim();
    const jsonMatch = rawText.match(/\{[^}]+\}/);
    const kennzahlen = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    console.log(`[Kennzahlen] ${planName}:`, kennzahlen);
    res.json(kennzahlen);
  } catch(err) {
    console.error('[Kennzahlen] Fehler:', err.message);
    res.json({ nutzungsart: '', grz: '', gfz: '', geschosse: '' });
  }
});

// ── API Endpoint: B-Plan PDF Analyse ──────────────────────────────────────
app.get('/api/bplan-analyse', async (req, res) => {
  const { planName, frage } = req.query;
  if (!planName) return res.status(400).json({ error: 'Parameter "planName" fehlt' });

  try {
    console.log(`[BPlanAnalyse] Starte Analyse für: ${planName}`);
    const pdfBase64 = await downloadPdfAsBase64(planName);
    console.log(`[BPlanAnalyse] PDF geladen: ${pdfBase64 ? 'ja (' + Math.round(pdfBase64.length/1024) + ' KB base64)' : 'nein'}`);

    const analyse = await analysePlanMitClaude(planName, pdfBase64, frage);

    res.json({
      planName,
      frage: frage || null,
      pdfGeladen: !!pdfBase64,
      analyse,
      hinweis: 'Orientierungsanalyse — keine Rechtsberatung. Für verbindliche Auskünfte: Bezirksamt Hamburg.',
    });
  } catch(err) {
    console.error(`[BPlanAnalyse] Fehler:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
