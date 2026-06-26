// hamburgKontext.js
// Lädt die kuratierte hamburg_kontext_kompakt.json in den RAM (winzig, kein PDF-Parsing)
// und wählt pro Analyse die thematisch passenden Dokumente fürs KI-Prompt aus.
//
// Einbau in server.js:
//   const { selectKontext, buildKontextBlock } = require("./hamburgKontext");
//   ... im /api/bplan-analyse-Handler:
//   const block = buildKontextBlock(`${planName} ${analyseText} ${frage || ""}`);
//   ... block VOR die eigentliche Aufgabe in den system-Prompt hängen.

const fs = require("fs");
const path = require("path");

// einmal beim Require in den Speicher (8 KB Text, unkritisch)
let KONTEXT = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, "hamburg_kontext_kompakt.json"), "utf8");
  KONTEXT = JSON.parse(raw).docs || [];
  console.log(`[hamburgKontext] ${KONTEXT.length} Dokumente geladen`);
} catch (e) {
  console.error("[hamburgKontext] konnte hamburg_kontext_kompakt.json nicht laden:", e.message);
}

// Query-Text -> Tags. Bewusst dieselbe Logik wie im Extraktor, plus ein paar
// Synonyme, damit B-Plan-Text/Frage auf die Doc-Tags mappt.
const QUERY_TAGS = {
  dachbegruenung:    ["dachbegrünung", "gründach", "begrüntes dach", "solargründach"],
  fassade:           ["fassadenbegrünung", "grüne fassade", "begrünte fassade"],
  verschattung:      ["verschattung", "besonnung", "belichtung", "verschattungsgutachten"],
  kostenbeteiligung: ["kostenbeteiligung", "städtebaulicher vertrag", "folgekosten", "kostenübernahme"],
  buergerbeteiligung:["bürgerbeteiligung", "öffentlichkeitsbeteiligung", "beteiligungsverfahren"],
  klima:             ["klima", "klimaschutz", "klimaanpassung", "co2", "treibhausgas", "starkregen", "hitze"],
  solargruendach:    ["solargründach", "photovoltaik", "pv-anlage", "solaranlage", "solarpflicht"],
  photovoltaik:      ["photovoltaik", "pv", "solar"],
  wohnungsbau:       ["wohnungsbau", "wohnen", "wohnungsneubau", "geförderter wohnraum", "mietwohn"],
  zentren:           ["zentren", "einzelhandel", "nahversorgung", "geschäft", "ladengeschäft"],
  einzelhandel:      ["einzelhandel", "verkaufsfläche", "sortiment"],
  naturschutz:       ["naturschutz", "biotop", "eingriffsregelung", "ausgleich", "kompensation"],
  artenschutz:       ["artenschutz", "art", "fledermaus", "brutvogel", "fällverbot"],
  baumschutz:        ["baumschutz", "baum", "bäum", "gehölz", "baumfäll", "baumbestand", "hecke"],
  wasser:            ["wasser", "regenwasser", "niederschlag", "entwässerung", "gewässer", "retention", "siel"],
  denkmalschutz:     ["denkmal", "denkmalschutz", "ensemble"],
  bodenschutz:       ["boden", "altlast", "bodenschutz", "kontamination"],
  immissionsschutz:  ["lärm", "immission", "schallschutz", "gewerbelärm", "verkehrslärm"],
  abstandsflaeche:   ["abstandsfläche", "gebäudehöhe", "grenzabstand"],
  gruenes_netz:      ["grünes netz", "stadtgrün", "freiraum", "grünverbindung"],
  fnp:               ["flächennutzungsplan", "fnp", "vorbereitender bauleitplan"],
  baunvo:            ["grz", "gfz", "grundflächenzahl", "geschossflächenzahl", "baunvo", "art der nutzung", "maß der nutzung", "wa", "wr", "mi", "ge"],
  verfahren:         ["bebauungsplanverfahren", "aufstellungsbeschluss", "abwägung", "13a", "13b", "§13"],
  xplanung:          ["xplanung", "xbau"],
};

const FALLBACK_KW = {}; // (Platzhalter, falls du später Volltext-Snippets dazunehmen willst)

function deriveQueryTags(text) {
  const h = (text || "").toLowerCase();
  const tags = new Set();
  for (const [tag, kws] of Object.entries(QUERY_TAGS)) {
    if (kws.some(kw => h.includes(kw))) tags.add(tag);
  }
  return tags;
}

// leichte Priorisierung: praxisnahe Dokumente vor Gesetzestexten
const KAT_BONUS = { leitfaden: 3, programm: 2, verfahren: 1, gesetz_hh: 1, gesetz_bund: 0 };

/**
 * Wählt die thematisch passenden Dokumente.
 * @param {string} text  - B-Plan-Name + Analyse + ggf. Nutzerfrage
 * @param {number} maxDocs
 * @returns {Array} ausgewählte Doc-Objekte
 */
function selectKontext(text, maxDocs = 6) {
  if (!KONTEXT.length) return [];
  const qtags = deriveQueryTags(text);

  const scored = KONTEXT.map(doc => {
    const overlap = doc.tags.filter(t => qtags.has(t)).length;
    const score = overlap * 10 + (KAT_BONUS[doc.kategorie] || 0);
    return { doc, overlap, score };
  });

  let hits = scored.filter(s => s.overlap > 0).sort((a, b) => b.score - a.score);

  // Immer-dabei-Basis, falls die Query kaum greift: Verfahren + Kostenbeteiligung
  if (hits.length === 0) {
    const baseFiles = ["hamburg-macht-plaene-data.pdf", "regelung-kostenbeteiligung-data(1).pdf"];
    hits = scored.filter(s => baseFiles.includes(s.doc.file));
  }

  return hits.slice(0, maxDocs).map(s => s.doc);
}

/**
 * Fertiger Textblock fürs system-Prompt. Leerstring, wenn nichts passt.
 */
function buildKontextBlock(text, maxDocs = 6) {
  const docs = selectKontext(text, maxDocs);
  if (!docs.length) return "";
  const items = docs.map(d => `• ${d.title}\n  ${d.kontext}`).join("\n\n");
  return (
    "Hamburg-spezifischer Fachkontext (kuratierte Grundlagen, nur nutzen wo einschlägig; " +
    "keine Quellen erfinden):\n\n" + items
  );
}

module.exports = { selectKontext, buildKontextBlock, _all: () => KONTEXT };
