const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const xml2js  = require("xml2js");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Hilfsfunktionen ────────────────────────────────────────────────────────

async function fetchXML(url) {
  const res = await axios.get(url, { timeout: 25000 });
  return xml2js.parseStringPromise(res.data, { explicitArray: false });
}

function dig(obj, ...keys) {
  return keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
}

// ── Schritt 1: Adresse → Koordinaten (ALKIS) ──────────────────────────────
// FIX: typename war "app:AX_Adresse" → jetzt "ave:AX_Adresse"
// FIX: Filter-Felder angepasst an AAA-Schema 7.1 (seit Dez 2025)
async function geocode(adresse) {
  const m = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:\d{5}\s*)?(?:Hamburg)?$/i);
  if (!m) throw new Error(`Adresse nicht erkennbar: "${adresse}"`);

  const strasse    = m[1].trim();
  const hausnummer = m[2].trim();

  // Versuch 1: neuer Endpoint mit WFS 2.0 + CQL_FILTER
  const url1 = `https://geodienste.hamburg.de/HH_WFS_ALKIS_Adressen`
    + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=ave:AX_Adresse`
    + `&outputFormat=application/json`
    + `&COUNT=1`
    + `&CQL_FILTER=strasse='${encodeURIComponent(strasse)}'`
    + `%20AND%20hausnummer='${encodeURIComponent(hausnummer)}'`;

  // Versuch 2: Fallback mit altem typename (app:AX_Adresse)
  const url2 = `https://geodienste.hamburg.de/HH_WFS_ALKIS_Adressen`
    + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=app:AX_Adresse`
    + `&outputFormat=application/json`
    + `&COUNT=1`
    + `&CQL_FILTER=strasse='${encodeURIComponent(strasse)}'`
    + `%20AND%20hausnummer='${encodeURIComponent(hausnummer)}'`;

  // Versuch 3: OGC API Features (neuer Standard seit 2025)
  const url3 = `https://geodienste.hamburg.de/lgv-alkis-adressen/collections/adresse/items`
    + `?strasse=${encodeURIComponent(strasse)}`
    + `&hausnummer=${encodeURIComponent(hausnummer)}`
    + `&f=json&limit=1`;

  for (const url of [url1, url2, url3]) {
    try {
      const res = await axios.get(url, { timeout: 25000 });
      const data = res.data;

      // GeoJSON FeatureCollection
      if (data.features && data.features.length > 0) {
        const feat  = data.features[0];
        const props = feat.properties || {};
        const [lon, lat] = feat.geometry?.coordinates || [null, null];
        if (lon && lat) {
          return {
            lon,
            lat,
            adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
            bezirk:    props.bezirk    || props.Bezirk    || null,
            stadtteil: props.stadtteil || props.Stadtteil || null,
          };
        }
      }
    } catch (e) {
      console.warn(`[Geocode] Versuch fehlgeschlagen: ${url.substring(0, 80)}… → ${e.message}`);
    }
  }

  throw new Error(`Adresse nicht gefunden: "${adresse}" – bitte Hamburger Adresse ohne PLZ angeben`);
}

// ── Schritt 2: Koordinaten → B-Plan (WFS Bebauungspläne) ──────────────────
async function fetchBPlan(lon, lat) {
  // Punkt-in-Polygon: welcher B-Plan enthält diesen Punkt?
  const bbox = `${lon - 0.0001},${lat - 0.0001},${lon + 0.0001},${lat + 0.0001}`;

  const urls = [
    // Primär: WFS 2.0
    `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:prosin_gesamt`
      + `&outputFormat=application/json`
      + `&BBOX=${bbox},EPSG:4326`,
    // Fallback: WFS 1.1.0
    `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene`
      + `?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature`
      + `&TYPENAME=app:prosin_gesamt`
      + `&outputFormat=application/json`
      + `&BBOX=${bbox},EPSG:4326`,
  ];

  for (const url of urls) {
    try {
      const res  = await axios.get(url, { timeout: 25000 });
      const data = res.data;
      if (data.features && data.features.length > 0) {
        const props = data.features[0].properties || {};
        return {
          planName:      props.planname   || props.name     || props.PLANNAME || null,
          planStatus:    props.planstatus || props.STATUS   || 'Unbekannt',
          pdfUrl:        props.docurl     || props.pdf_url  || null,
          begruendungUrl:props.docurl_b   || null,
        };
      }
    } catch (e) {
      console.warn(`[BPlan] Versuch fehlgeschlagen: ${e.message}`);
    }
  }
  return null;
}

// ── Schritt 3: B-Plan → XPlanungsdaten ────────────────────────────────────
async function fetchXPlanungsDaten(planName) {
  if (!planName) return null;

  const urls = [
    `https://geodienste.hamburg.de/HH_WFS_xplan_dls`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=xplan:BP_Plan`
      + `&outputFormat=application/json`
      + `&CQL_FILTER=name='${encodeURIComponent(planName)}'`,
    `https://geodienste.hamburg.de/HH_WFS_xplan_dls`
      + `?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature`
      + `&TYPENAME=xplan:BP_Plan`
      + `&outputFormat=application/json`
      + `&CQL_FILTER=name='${encodeURIComponent(planName)}'`,
  ];

  for (const url of urls) {
    try {
      const res  = await axios.get(url, { timeout: 25000 });
      const data = res.data;
      if (data.features && data.features.length > 0) {
        const props = data.features[0].properties || {};
        return {
          name:       props.name     || planName,
          planArt:    props.planart  || 'BPlan',
          baugebiete: parseBaugebiete(props),
        };
      }
    } catch (e) {
      console.warn(`[XPlanung] Versuch fehlgeschlagen: ${e.message}`);
    }
  }
  return null;
}

function parseBaugebiete(props) {
  // Versuche verschiedene Feldnamen die nach dem Schema-Update existieren könnten
  const nutzung = props.nutzungsform || props.baugebiet || props.allgArtDerBaulNutzung || null;
  const grz     = props.grz  || props.grundflaechenzahl || null;
  const gfz     = props.gfz  || props.geschossfl_zahl   || null;
  const hoehe   = props.hoehe || props.max_hoehe         || null;
  const geschosse = props.zahl_vollgeschosse || props.maxGeschosse || null;

  if (!nutzung && !grz && !gfz) return [];
  return [{ nutzungsform: nutzung, grz, gfz, maxGeschosse: geschosse, maxHoehe: hoehe }];
}

// ── Schritt 4: Erhaltungsverordnungen ────────────────────────────────────
async function fetchErhaltungsgebiete(lon, lat) {
  const bbox = `${lon - 0.0001},${lat - 0.0001},${lon + 0.0001},${lat + 0.0001}`;

  const urls = [
    `https://geodienste.hamburg.de/HH_WFS_Erhaltungsverordnungen`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:erhaltungsverordnungen`
      + `&outputFormat=application/json`
      + `&BBOX=${bbox},EPSG:4326`,
    `https://geodienste.hamburg.de/HH_WFS_Erhaltungsverordnungen`
      + `?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature`
      + `&TYPENAME=app:erhaltungsverordnungen`
      + `&outputFormat=application/json`
      + `&BBOX=${bbox},EPSG:4326`,
  ];

  for (const url of urls) {
    try {
      const res  = await axios.get(url, { timeout: 25000 });
      const data = res.data;
      if (data.features && data.features.length > 0) {
        return data.features.map(f => ({
          name:    f.properties?.name    || f.properties?.gebietsname || 'Erhaltungsgebiet',
          paragraf:'§ 172 BauGB',
          hinweis: 'Bauliche Veränderungen an Wohngebäuden genehmigungspflichtig',
        }));
      }
      return [];
    } catch (e) {
      console.warn(`[Erhaltung] Versuch fehlgeschlagen: ${e.message}`);
    }
  }
  return [];
}

// ── Polygon-Analyse: alle B-Pläne im Bereich ─────────────────────────────
async function fetchBPlaeneImPolygon(bbox) {
  const url = `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene`
    + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
    + `&TYPENAMES=app:prosin_gesamt`
    + `&outputFormat=application/json`
    + `&BBOX=${bbox},EPSG:4326`;

  try {
    const res  = await axios.get(url, { timeout: 30000 });
    const data = res.data;
    return (data.features || []).map(f => ({
      planName:   f.properties?.planname || f.properties?.name || 'Unbekannt',
      planStatus: f.properties?.planstatus || 'Unbekannt',
      flaeche:    f.properties?.flaeche || null,
      pdfUrl:     f.properties?.docurl  || null,
    }));
  } catch (e) {
    console.warn(`[Polygon] BPläne fehlgeschlagen: ${e.message}`);
    return [];
  }
}

// ── API Endpoint: Adressanalyse ────────────────────────────────────────────
app.get('/api/analyse', async (req, res) => {
  const adresse = req.query.adresse;
  if (!adresse) {
    return res.status(400).json({ error: 'Parameter "adresse" fehlt' });
  }

  try {
    console.log(`[AutoBLP] Analyse für: ${adresse}`);

    // Schritt 1: Geocoding
    const koordinaten = await geocode(adresse);
    console.log(`[AutoBLP] Koordinaten: ${koordinaten.lon}, ${koordinaten.lat}`);

    // Schritte 2-4 parallel
    const [bplan, erhaltung] = await Promise.all([
      fetchBPlan(koordinaten.lon, koordinaten.lat),
      fetchErhaltungsgebiete(koordinaten.lon, koordinaten.lat),
    ]);

    // Schritt 3: XPlanung (braucht B-Plan-Name)
    const xplanung = bplan?.planName
      ? await fetchXPlanungsDaten(bplan.planName)
      : null;

    res.json({
      meta: {
        abfragezeit: new Date().toISOString(),
        quelle:      'Urban Data Platform Hamburg (LGV)',
        lizenz:      'Datenlizenz Deutschland Namensnennung 2.0',
      },
      adresse:           koordinaten,
      bebauungsplan:     bplan,
      xplanung:          xplanung,
      erhaltungsgebiete: erhaltung,
    });

  } catch (err) {
    console.error(`[AutoBLP] Fehler:`, err.message);
    res.status(500).json({
      error:   err.message,
      hinweis: 'Hamburger Adresse im Format "Straßenname Hausnummer, Hamburg" angeben',
    });
  }
});

// ── API Endpoint: Polygon-Analyse ──────────────────────────────────────────
app.get('/api/polygon', async (req, res) => {
  const { bbox, lat, lon } = req.query;
  if (!bbox) {
    return res.status(400).json({ error: 'Parameter "bbox" fehlt (minLon,minLat,maxLon,maxLat)' });
  }

  try {
    const bplaene = await fetchBPlaeneImPolygon(bbox);
    const erhaltung = lat && lon
      ? await fetchErhaltungsgebiete(parseFloat(lon), parseFloat(lat))
      : [];

    res.json({
      meta: {
        abfragezeit: new Date().toISOString(),
        quelle:      'Urban Data Platform Hamburg (LGV)',
        lizenz:      'Datenlizenz Deutschland Namensnennung 2.0',
      },
      bebauungsplaene:   bplaene,
      erhaltungsgebiete: erhaltung,
      anzahl:            bplaene.length,
    });

  } catch (err) {
    console.error(`[AutoBLP Polygon] Fehler:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check ───────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));

app.get('/', (_, res) => res.json({ 
  status: 'ok', 
  endpoints: ['/health', '/api/analyse?adresse=...', '/api/polygon?bbox=...'] 
}));

app.listen(PORT, () => {
  console.log(`AutoBLP Backend läuft auf Port ${PORT}`);
});
