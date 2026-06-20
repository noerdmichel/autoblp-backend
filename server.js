const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Basis-URL der neuen Hamburg OAF API
const HH_API = "https://api.hamburg.de/datasets/v1";

// ── Schritt 1: Adresse → Koordinaten ──────────────────────────────────────
// Neu: OAF API statt WFS (WFS für Adressen wurde abgeschaltet)
async function geocode(adresse) {
  const m = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:\d{5}\s*)?(?:Hamburg)?$/i);
  if (!m) throw new Error(`Adresse nicht erkennbar: "${adresse}"`);

  const strasse    = m[1].trim();
  const hausnummer = m[2].trim();

  // Versuch 1: alkis_vereinfacht OAF API – Adressen-Collection
  const url1 = `${HH_API}/alkis_vereinfacht/collections/ap_pto/items`
    + `?f=json&limit=5`
    + `&filter=strasse='${strasse}' AND hausnummer='${hausnummer}'`
    + `&filter-lang=cql-text`;

  // Versuch 2: Nominatim (OpenStreetMap) als zuverlässiger Fallback
  const url2 = `https://nominatim.openstreetmap.org/search`
    + `?street=${encodeURIComponent(strasse + ' ' + hausnummer)}`
    + `&city=Hamburg&country=Germany`
    + `&format=json&limit=1&addressdetails=1`;

  // Versuch 3: Photon (OSM-basiert, kein Rate-Limit)
  const url3 = `https://photon.komoot.io/api/`
    + `?q=${encodeURIComponent(strasse + ' ' + hausnummer + ', Hamburg')}`
    + `&limit=1&lang=de`;

  // Versuch 1: HH OAF API
  try {
    const res  = await axios.get(url1, { timeout: 20000 });
    const data = res.data;
    if (data.features && data.features.length > 0) {
      const feat  = data.features[0];
      const props = feat.properties || {};
      const coords = feat.geometry?.coordinates;
      if (coords) {
        const [lon, lat] = coords;
        return {
          lon, lat,
          adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
          bezirk:    props.bezirk    || null,
          stadtteil: props.stadtteil || null,
        };
      }
    }
  } catch (e) {
    console.warn(`[Geocode] HH OAF fehlgeschlagen: ${e.message}`);
  }

  // Versuch 2: Nominatim
  try {
    const res  = await axios.get(url2, {
      timeout: 15000,
      headers: { 'User-Agent': 'AutoBLP-Hamburg/1.0 (michel.slottag@outlook.com)' }
    });
    const data = res.data;
    if (data && data.length > 0) {
      const r = data[0];
      return {
        lon:               parseFloat(r.lon),
        lat:               parseFloat(r.lat),
        adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
        bezirk:            r.address?.suburb || r.address?.city_district || null,
        stadtteil:         r.address?.neighbourhood || r.address?.suburb || null,
      };
    }
  } catch (e) {
    console.warn(`[Geocode] Nominatim fehlgeschlagen: ${e.message}`);
  }

  // Versuch 3: Photon
  try {
    const res  = await axios.get(url3, { timeout: 15000 });
    const data = res.data;
    if (data.features && data.features.length > 0) {
      const feat  = data.features[0];
      const props = feat.properties || {};
      const [lon, lat] = feat.geometry?.coordinates || [];
      if (lon && lat) {
        return {
          lon, lat,
          adresseFormatiert: `${strasse} ${hausnummer}, Hamburg`,
          bezirk:    props.city    || null,
          stadtteil: props.district || props.suburb || null,
        };
      }
    }
  } catch (e) {
    console.warn(`[Geocode] Photon fehlgeschlagen: ${e.message}`);
  }

  throw new Error(`Adresse nicht gefunden: "${adresse}" – bitte prüfen ob die Adresse in Hamburg liegt`);
}

// ── Schritt 2: Koordinaten → B-Plan (WFS Bebauungspläne) ──────────────────
async function fetchBPlan(lon, lat) {
  const delta = 0.0002;
  const bbox  = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

  const urls = [
    // Primär: OAF API
    `${HH_API}/bebauungsplaene/collections/prosin_gesamt/items`
      + `?f=json&limit=5&bbox=${bbox}`,
    // Fallback: WFS 2.0 (noch aktiv laut CSV)
    `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:prosin_gesamt`
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
          planName:       props.planname   || props.name     || props.PLANNAME || null,
          planStatus:     props.planstatus || props.status   || 'Unbekannt',
          pdfUrl:         props.docurl     || props.pdf_url  || null,
          begruendungUrl: props.docurl_b   || null,
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
    `${HH_API}/xplan/collections/bp_plan/items`
      + `?f=json&limit=1&filter=name='${encodeURIComponent(planName)}'&filter-lang=cql-text`,
    `https://geodienste.hamburg.de/HH_WFS_xplan_dls`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=xplan:BP_Plan`
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
          name:    props.name    || planName,
          planArt: props.planart || 'BPlan',
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
  const nutzung   = props.nutzungsform || props.baugebiet || props.allgArtDerBaulNutzung || null;
  const grz       = props.grz  || props.grundflaechenzahl || null;
  const gfz       = props.gfz  || props.geschossfl_zahl   || null;
  const geschosse = props.zahl_vollgeschosse || props.maxGeschosse || null;
  if (!nutzung && !grz && !gfz) return [];
  return [{ nutzungsform: nutzung, grz, gfz, maxGeschosse: geschosse }];
}

// ── Schritt 4: Erhaltungsverordnungen ─────────────────────────────────────
async function fetchErhaltungsgebiete(lon, lat) {
  const delta = 0.0002;
  const bbox  = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;

  const urls = [
    `${HH_API}/erhaltungsverordnungen/collections/erhaltungsverordnungen/items`
      + `?f=json&limit=5&bbox=${bbox}`,
    `https://geodienste.hamburg.de/HH_WFS_Erhaltungsverordnungen`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:erhaltungsverordnungen`
      + `&outputFormat=application/json`
      + `&BBOX=${bbox},EPSG:4326`,
  ];

  for (const url of urls) {
    try {
      const res  = await axios.get(url, { timeout: 20000 });
      const data = res.data;
      if (data.features && data.features.length > 0) {
        return data.features.map(f => ({
          name:    f.properties?.name || f.properties?.gebietsname || 'Erhaltungsgebiet',
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

// ── API Endpoint: Adressanalyse ────────────────────────────────────────────
app.get('/api/analyse', async (req, res) => {
  const adresse = req.query.adresse;
  if (!adresse) {
    return res.status(400).json({ error: 'Parameter "adresse" fehlt' });
  }

  try {
    console.log(`[AutoBLP] Analyse für: ${adresse}`);

    const koordinaten = await geocode(adresse);
    console.log(`[AutoBLP] Koordinaten: ${koordinaten.lon}, ${koordinaten.lat}`);

    const [bplan, erhaltung] = await Promise.all([
      fetchBPlan(koordinaten.lon, koordinaten.lat),
      fetchErhaltungsgebiete(koordinaten.lon, koordinaten.lat),
    ]);

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
    return res.status(400).json({ error: 'Parameter "bbox" fehlt' });
  }

  try {
    const bplaene   = await fetchBPlaeneImBbox(bbox);
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
    res.status(500).json({ error: err.message });
  }
});

async function fetchBPlaeneImBbox(bbox) {
  const urls = [
    `${HH_API}/bebauungsplaene/collections/prosin_gesamt/items?f=json&limit=20&bbox=${bbox}`,
    `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene`
      + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=app:prosin_gesamt&outputFormat=application/json&BBOX=${bbox},EPSG:4326`,
  ];
  for (const url of urls) {
    try {
      const res  = await axios.get(url, { timeout: 30000 });
      const data = res.data;
      if (data.features) {
        return data.features.map(f => ({
          planName:   f.properties?.planname || f.properties?.name || 'Unbekannt',
          planStatus: f.properties?.planstatus || 'Unbekannt',
          pdfUrl:     f.properties?.docurl || null,
        }));
      }
    } catch (e) {
      console.warn(`[Polygon] fehlgeschlagen: ${e.message}`);
    }
  }
  return [];
}

// ── Health & Root ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));
app.get('/', (_, res) => res.json({
  status: 'ok',
  endpoints: ['/health', '/api/analyse?adresse=...', '/api/polygon?bbox=...']
}));

app.listen(PORT, () => console.log(`AutoBLP Backend läuft auf Port ${PORT}`));
