/**
 * AutoBLP – Hamburg WFS Proxy
 * ============================
 * Löst das CORS-Problem: Browser → dieser Server → Hamburger Geodienste
 *
 * Ablauf pro Anfrage:
 *   1. Adresse → Koordinaten  (ALKIS AdressService)
 *   2. Koordinaten → B-Plan   (WFS Bebauungspläne, Punkt-in-Polygon)
 *   3. B-Plan-Name → Details  (XPlanungsdaten WFS)
 *   4. Alles als JSON ans Frontend
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const xml2js  = require('xml2js');

const app  = express();
const PORT = process.env.PORT || 3001;

// CORS: In Produktion auf deine Domain einschränken
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

async function fetchXML(url) {
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'Accept': 'application/xml, text/xml' }
  });
  return xml2js.parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: false });
}

function safeGet(obj, path, fallback = null) {
  return path.reduce((acc, key) =>
    acc && acc[key] !== undefined ? acc[key] : fallback, obj);
}

// ─── Schritt 1: Adresse → Koordinaten ────────────────────────────────────────

async function geocodeAddress(adresse) {
  // Adresse aufteilen: "Reichardtstraße 11, Hamburg" → Straße + Hausnummer
  const match = adresse.match(/^(.+?)\s+(\d+\w*),?\s*(?:Hamburg)?$/i);
  if (!match) throw new Error('Adresse konnte nicht geparst werden. Format: "Straßenname Hausnummer, Hamburg"');

  const [, strasse, hausnummer] = match;

  const url = `https://geodienste.hamburg.de/HH_WFS_ALKIS_Adressen` +
    `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=app:HHAdresse` +
    `&CQL_FILTER=strasse='${encodeURIComponent(strasse)}'` +
    `%20AND%20hausnummer='${hausnummer}'` +
    `&outputFormat=application/json` +
    `&count=1`;

  const res = await axios.get(url, { timeout: 10000 });
  const data = res.data;

  if (!data.features || data.features.length === 0) {
    throw new Error(`Adresse nicht gefunden: "${adresse}". Bitte Hamburger Adresse angeben.`);
  }

  const coords = data.features[0].geometry.coordinates;
  // ALKIS liefert EPSG:25832 (UTM) – wir brauchen WGS84 für spätere Anzeige
  // Für WFS-Abfragen nutzen wir die Originalkoordinaten
  return {
    lon: coords[0],
    lat: coords[1],
    adresseFormatiert: data.features[0].properties.strasse + ' ' +
                       data.features[0].properties.hausnummer + ', Hamburg',
    bezirk: data.features[0].properties.bezirk || null,
    stadtteil: data.features[0].properties.stadtteil || null,
  };
}

// ─── Schritt 2: Koordinaten → B-Plan (Punkt-in-Polygon) ──────────────────────

async function findBebauungsplan(lon, lat) {
  // WFS Bebauungspläne: Punkt-in-Polygon mit INTERSECTS
  const url = `https://geodienste.hamburg.de/HH_WFS_Bebauungsplaene` +
    `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=app:proRequest` +
    `&CQL_FILTER=INTERSECTS(geom,POINT(${lon}%20${lat}))` +
    `&outputFormat=application/json` +
    `&count=5`;

  const res = await axios.get(url, { timeout: 10000 });
  const data = res.data;

  if (!data.features || data.features.length === 0) {
    // Fallback: Kein B-Plan → evtl. Baustufenplan oder unbeplanter Innenbereich
    return {
      planName: null,
      planStatus: 'Kein rechtskräftiger Bebauungsplan gefunden',
      geltungsbereich: null,
      pdfUrl: null,
      verfahrensstand: '§ 34 BauGB (unbeplanter Innenbereich) wahrscheinlich'
    };
  }

  // Ersten rechtskräftigen Plan nehmen
  const plan = data.features.find(f =>
    f.properties.verfahrensstand === 'Rechtskräftig'
  ) || data.features[0];

  const props = plan.properties;

  return {
    planName:         props.plannummer || props.planname || 'Unbekannt',
    planStatus:       props.verfahrensstand || 'Unbekannt',
    geltungsbereich:  props.geltungsbereich || null,
    pdfUrl:           props.pdf_url || `https://daten-hamburg.de/infrastruktur_bauen_wohnen/bebauungsplaene/pdfs/bplan/${props.plannummer}.pdf`,
    begruendungUrl:   `https://daten-hamburg.de/infrastruktur_bauen_wohnen/bebauungsplaene/pdfs/bplan_begr/${props.plannummer}.pdf`,
    feststellungsdatum: props.feststellungsdatum || null,
    alleVarianten:    data.features.map(f => f.properties.plannummer || f.properties.planname),
  };
}

// ─── Schritt 3: B-Plan-Name → XPlanungsdaten (Festsetzungen) ─────────────────

async function fetchXPlanungsDaten(planName) {
  if (!planName) return null;

  // Leerzeichen und Sonderzeichen entfernen für den Query
  const planNameClean = planName.replace(/\s+/g, '');

  const url = `https://geodienste.hamburg.de/HH_WFS_xplan_dls` +
    `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&StoredQuery_ID=urn:ogc:def:query:OGC-WFS::PlanName` +
    `&planName=${encodeURIComponent(planNameClean)}`;

  try {
    const parsed = await fetchXML(url);

    // XPlanGML-Struktur navigieren
    const collection = parsed['wfs:FeatureCollection'];
    const members    = safeGet(collection, ['wfs:member'], []);
    const memberList = Array.isArray(members) ? members : [members];

    // BP_Plan Objekt finden
    const bpPlan = memberList.find(m =>
      m['xplan:BP_Plan'] || m['BP_Plan']
    );

    if (!bpPlan) return { hinweis: 'XPlanungsdaten vorhanden, aber Struktur nicht erkannt' };

    const plan = bpPlan['xplan:BP_Plan'] || bpPlan['BP_Plan'];

    return {
      name:           safeGet(plan, ['xplan:name', '_']),
      beschreibung:   safeGet(plan, ['xplan:beschreibung', '_']),
      planArt:        safeGet(plan, ['xplan:planArt', '_']),
      rechtsstand:    safeGet(plan, ['xplan:rechtsstand', '_']),
      // Baugebiete aus den Teilplänen
      baugebiete:     extractBaugebiete(memberList),
    };
  } catch (err) {
    // XPlanung nicht verfügbar → kein hartes Scheitern
    return { hinweis: 'XPlanungsdaten konnten nicht abgerufen werden', fehler: err.message };
  }
}

function extractBaugebiete(members) {
  const gebiete = [];
  for (const m of members) {
    const bp = m['xplan:BP_BaugebietsTeilflaeche'] || m['BP_BaugebietsTeilflaeche'];
    if (!bp) continue;
    gebiete.push({
      nutzungsform: safeGet(bp, ['xplan:allgArtDerBaulNutzung', '_']),
      besondereNutzung: safeGet(bp, ['xplan:besondereArtDerBaulNutzung', '_']),
      grz:          safeGet(bp, ['xplan:GRZ', '_']),
      gfz:          safeGet(bp, ['xplan:GFZ', '_']),
      bmz:          safeGet(bp, ['xplan:BMZ', '_']),
      maxGeschosse: safeGet(bp, ['xplan:Z', '_']),
    });
  }
  return gebiete;
}

// ─── Schritt 4: Erhaltungsverordnungen prüfen ─────────────────────────────────

async function checkErhaltungsgebiet(lon, lat) {
  try {
    const url = `https://geodienste.hamburg.de/HH_WFS_Erhaltungsverordnungen` +
      `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
      `&TYPENAMES=app:Erhaltungsverordnung` +
      `&CQL_FILTER=INTERSECTS(geom,POINT(${lon}%20${lat}))` +
      `&outputFormat=application/json&count=3`;

    const res  = await axios.get(url, { timeout: 8000 });
    const data = res.data;

    if (!data.features || data.features.length === 0) return null;

    return data.features.map(f => ({
      name:      f.properties.bezeichnung || f.properties.name,
      paragraf:  '§ 172 BauGB',
      hinweis:   'Bauliche Veränderungen an Wohngebäuden genehmigungspflichtig',
    }));
  } catch {
    return null; // Dienst nicht erreichbar → Soft-Fail
  }
}

// ─── Haupt-Endpunkt ───────────────────────────────────────────────────────────

app.get('/api/analyse', async (req, res) => {
  const { adresse } = req.query;

  if (!adresse) {
    return res.status(400).json({ error: 'Parameter "adresse" fehlt' });
  }

  try {
    console.log(`[AutoBLP] Analyse für: ${adresse}`);

    // Alle Schritte sequenziell (jeder baut auf dem vorherigen auf)
    const koordinaten   = await geocodeAddress(adresse);
    console.log(`[AutoBLP] Koordinaten: ${koordinaten.lon}, ${koordinaten.lat}`);

    const [bplan, erhaltung] = await Promise.all([
      findBebauungsplan(koordinaten.lon, koordinaten.lat),
      checkErhaltungsgebiet(koordinaten.lon, koordinaten.lat),
    ]);
    console.log(`[AutoBLP] B-Plan: ${bplan.planName}`);

    const xplanung = bplan.planName
      ? await fetchXPlanungsDaten(bplan.planName)
      : null;

    // Ergebnis zusammenbauen
    const ergebnis = {
      meta: {
        abfragezeit:  new Date().toISOString(),
        quelle:       'Urban Data Platform Hamburg (LGV)',
        lizenz:       'Datenlizenz Deutschland Namensnennung 2.0',
      },
      adresse:      koordinaten,
      bebauungsplan: bplan,
      xplanung:     xplanung,
      erhaltungsgebiete: erhaltung,
    };

    res.json(ergebnis);

  } catch (err) {
    console.error(`[AutoBLP] Fehler:`, err.message);
    res.status(500).json({
      error:   err.message,
      hinweis: 'Hamburger Adresse im Format "Straßenname Hausnummer, Hamburg" angeben',
    });
  }
});

// Health-Check für Hosting-Anbieter
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'AutoBLP WFS Proxy' }));

app.listen(PORT, () => {
  console.log(`AutoBLP Backend läuft auf Port ${PORT}`);
});
