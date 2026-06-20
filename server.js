const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const HH_API  = "https://api.hamburg.de/datasets/v1";
const HH_WFS  = "https://geodienste.hamburg.de";

// ── DEBUG: zeigt verfügbare Collections ───────────────────────────────────
app.get('/debug/collections', async (req, res) => {
  const dataset = req.query.dataset || 'bebauungsplaene';
  try {
    const r = await axios.get(`${HH_API}/${dataset}/collections?f=json`, { timeout: 15000 });
    res.json(r.data);
  } catch (e) {
    res.json({ error: e.message, url: `${HH_API}/${dataset}/collections` });
  }
});

// ── DEBUG: testet WFS GetCapabilities ─────────────────────────────────────
app.get('/debug/wfs', async (req, res) => {
  const service = req.query.service || 'HH_WFS_Bebauungsplaene';
  try {
    const r = await axios.get(
      `${HH_WFS}/${service}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`,
      { timeout: 15000 }
    );
    // Nur FeatureTypes extrahieren
    const text = r.data.toString();
    const matches = text.match(/Name>(.*?)<\/.*?Name>/g) || [];
    res.json({ status: r.status, featureTypes: matches.slice(0, 20), rawLength: text.length });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status });
  }
});

// ── DEBUG: testet einen direkten BBOX-Request ─────────────────────────────
app.get('/debug/bbox', async (req, res) => {
  // Reichardtstraße 11 Hamburg: ca. lon=9.9384, lat=53.5672
  const bbox = '9.9374,53.5662,9.9394,53.5682';
  const results = {};

  // Test 1: OAF bebauungsplaene
  try {
    const r = await axios.get(
      `${HH_API}/bebauungsplaene/collections/prosin_gesamt/items?f=json&limit=5&bbox=${bbox}`,
      { timeout: 15000 }
    );
    results.oaf_prosin = { status: r.status, count: r.data.features?.length, features: r.data.features?.map(f => f.properties) };
  } catch (e) {
    results.oaf_prosin = { error: e.message, status: e.response?.status };
  }

  // Test 2: WFS Bebauungsplaene
  try {
    const r = await axios.get(
      `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=app:prosin_gesamt&outputFormat=application/json&BBOX=${bbox},EPSG:4326`,
      { timeout: 15000 }
    );
    results.wfs_bplan = { status: r.status, count: r.data.features?.length, sample: r.data.features?.[0]?.properties };
  } catch (e) {
    results.wfs_bplan = { error: e.message, status: e.response?.status };
  }

  // Test 3: OAF bebauungsplaene ohne collection name
  try {
    const r = await axios.get(
      `${HH_API}/bebauungsplaene/collections?f=json`,
      { timeout: 15000 }
    );
    results.oaf_collections = { status: r.status, collections: r.data.collections?.map(c => c.id) };
  } catch (e) {
    results.oaf_collections = { error: e.message, status: e.response?.status };
  }

  // Test 4: Nominatim für Reichardtstraße 11
  try {
    const r = await axios.get(
      'https://nominatim.openstreetmap.org/search?street=Reichardtstra%C3%9Fe+11&city=Hamburg&country=Germany&format=json&limit=1',
      { timeout: 15000, headers: { 'User-Agent': 'AutoBLP/1.0 (michel.slottag@outlook.com)' } }
    );
    results.nominatim = { status: r.status, result: r.data[0] };
  } catch (e) {
    results.nominatim = { error: e.message };
  }

  res.json(results);
});

// ── Schritt 1: Geocoding ───────────────────────────────────────────────────
async function geocode(adresse) {
  const m = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:\d{5}\s*)?(?:Hamburg)?$/i);
  if (!m) throw new Error(`Adresse nicht erkennbar: "${adresse}"`);
  const strasse = m[1].trim(), hausnummer = m[2].trim();

  // Nominatim
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { street: `${strasse} ${hausnummer}`, city: 'Hamburg', country: 'Germany', format: 'json', limit: 1, addressdetails: 1 },
      timeout: 15000,
      headers: { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' }
    });
    if (r.data?.length > 0) {
      const d = r.data[0];
      console.log(`[Geocode] Nominatim OK: ${d.lat}, ${d.lon}`);
      return {
        lon: parseFloat(d.lon), lat: parseFloat(d.lat),
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: d.address?.suburb || d.address?.city_district || null,
        stadtteil: d.address?.neighbourhood || d.address?.suburb || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Nominatim: ${e.message}`); }

  // Photon
  try {
    const r = await axios.get('https://photon.komoot.io/api/', {
      params: { q: `${strasse} ${hausnummer}, Hamburg`, limit: 1, lang: 'de' },
      timeout: 15000
    });
    const f = r.data?.features?.[0];
    if (f) {
      const [lon, lat] = f.geometry.coordinates;
      console.log(`[Geocode] Photon OK: ${lat}, ${lon}`);
      return {
        lon, lat,
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk: f.properties?.city || null,
        stadtteil: f.properties?.district || null,
      };
    }
  } catch(e) { console.warn(`[Geocode] Photon: ${e.message}`); }

  throw new Error(`Adresse nicht gefunden: "${adresse}"`);
}

// ── Schritt 2: B-Plan ─────────────────────────────────────────────────────
async function fetchBPlan(lon, lat) {
  const d = 0.0003;
  const bbox = `${lon-d},${lat-d},${lon+d},${lat+d}`;

  // Versuche werden in den Logs sichtbar sein
  const versuche = [
    { name: 'WFS prosin_gesamt', url: `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=app:prosin_gesamt&outputFormat=application/json&BBOX=${bbox},EPSG:4326` },
    { name: 'WFS prosin_in_aufst', url: `${HH_WFS}/HH_WFS_Bebauungsplaene?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=app:prosin_in_aufst&outputFormat=application/json&BBOX=${bbox},EPSG:4326` },
    { name: 'OAF bebauungsplaene', url: `${HH_API}/bebauungsplaene/collections/prosin_gesamt/items?f=json&limit=5&bbox=${bbox}` },
  ];

  for (const v of versuche) {
    try {
      const r = await axios.get(v.url, { timeout: 20000 });
      const feats = r.data.features || [];
      console.log(`[BPlan] ${v.name}: ${feats.length} Features`);
      if (feats.length > 0) {
        const p = feats[0].properties || {};
        return {
          planName: p.planname || p.name || p.PLANNAME || null,
          planStatus: p.planstatus || p.status || 'festgesetzt',
          pdfUrl: p.docurl || null,
        };
      }
    } catch(e) {
      console.warn(`[BPlan] ${v.name} fehlgeschlagen (${e.response?.status || e.message})`);
    }
  }
  return null;
}

// ── Schritt 3: XPlanung ───────────────────────────────────────────────────
async function fetchXPlanungsDaten(planName) {
  if (!planName) return null;
  const urls = [
    `${HH_WFS}/HH_WFS_xplan_dls?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=xplan:BP_Plan&outputFormat=application/json&CQL_FILTER=name='${encodeURIComponent(planName)}'`,
    `${HH_API}/xplan/collections/bp_plan/items?f=json&limit=1&filter=name='${encodeURIComponent(planName)}'&filter-lang=cql-text`,
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 20000 });
      const f = r.data.features?.[0];
      if (f) {
        const p = f.properties || {};
        return {
          name: p.name || planName,
          planArt: p.planart || 'BPlan',
          baugebiete: [{ nutzungsform: p.nutzungsform || null, grz: p.grz || null, gfz: p.gfz || null }],
        };
      }
    } catch(e) { console.warn(`[XPlanung] ${e.message}`); }
  }
  return null;
}

// ── Schritt 4: Erhaltungsverordnungen ─────────────────────────────────────
async function fetchErhaltungsgebiete(lon, lat) {
  const d = 0.0003;
  const bbox = `${lon-d},${lat-d},${lon+d},${lat+d}`;
  const urls = [
    `${HH_WFS}/HH_WFS_Erhaltungsverordnungen?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=app:erhaltungsverordnungen&outputFormat=application/json&BBOX=${bbox},EPSG:4326`,
    `${HH_API}/erhaltungsverordnungen/collections/erhaltungsverordnungen/items?f=json&limit=5&bbox=${bbox}`,
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { timeout: 15000 });
      const feats = r.data.features || [];
      if (feats.length > 0) return feats.map(f => ({
        name: f.properties?.name || 'Erhaltungsgebiet',
        paragraf: '§ 172 BauGB',
        hinweis: 'Bauliche Veränderungen genehmigungspflichtig',
      }));
      return [];
    } catch(e) { console.warn(`[Erhaltung] ${e.message}`); }
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

app.get('/api/polygon', async (req, res) => {
  res.json({ bebauungsplaene: [], erhaltungsgebiete: [], anzahl: 0 });
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));
app.get('/', (_, res) => res.json({ status: 'ok', endpoints: ['/health', '/api/analyse?adresse=...', '/debug/bbox', '/debug/wfs', '/debug/collections?dataset=bebauungsplaene'] }));

app.listen(PORT, () => console.log(`AutoBLP Backend läuft auf Port ${PORT}`));
