# AutoBLP Backend – Einrichtung & Deployment

## Was ist das?
Ein einfacher Proxy-Server, der das CORS-Problem löst:
Browser → dieser Server → Hamburger Geodienste (UDP) → Browser

## Lokal testen (5 Minuten)

```bash
# 1. Node.js installieren (falls noch nicht vorhanden)
#    → https://nodejs.org (LTS-Version nehmen)

# 2. Abhängigkeiten installieren
npm install

# 3. Server starten
npm run dev

# 4. Test-Aufruf im Browser oder Terminal:
curl "http://localhost:3001/api/analyse?adresse=Reichardtstraße%2011%2C%20Hamburg"
```

## Auf Render.com deployen (kostenlos, 10 Minuten)

### Schritt 1 – GitHub Repository anlegen
1. github.com → "New repository" → Name: `autoblp-backend`
2. Diesen Ordner hochladen:
   ```bash
   git init
   git add .
   git commit -m "AutoBLP Backend initial"
   git remote add origin https://github.com/DEIN-USERNAME/autoblp-backend.git
   git push -u origin main
   ```

### Schritt 2 – Render.com einrichten
1. render.com → kostenlos registrieren (GitHub-Login möglich)
2. "New +" → "Web Service"
3. GitHub-Repo `autoblp-backend` auswählen
4. Einstellungen (werden aus render.yaml automatisch gelesen):
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. "Create Web Service" klicken

### Schritt 3 – URL ins Frontend eintragen
Nach dem Deploy bekommst du eine URL wie:
`https://autoblp-backend.onrender.com`

Diese URL im Frontend als API-Endpunkt eintragen:
```js
const API_BASE = 'https://autoblp-backend.onrender.com';
const response = await fetch(`${API_BASE}/api/analyse?adresse=${encodeURIComponent(adresse)}`);
```

### Wichtige Hinweise zum Free-Plan
- Der Server "schläft" nach 15 Minuten Inaktivität
- Erster Request nach Schlaf dauert ~30 Sekunden (Cold Start)
- Für Produktion: Upgrade auf $7/Monat (immer aktiv)

## API-Dokumentation

### GET /api/analyse

**Parameter:**
- `adresse` (required): Hamburger Adresse, z. B. `Reichardtstraße 11, Hamburg`

**Beispiel-Response:**
```json
{
  "meta": {
    "abfragezeit": "2026-01-15T10:30:00.000Z",
    "quelle": "Urban Data Platform Hamburg (LGV)",
    "lizenz": "Datenlizenz Deutschland Namensnennung 2.0"
  },
  "adresse": {
    "lon": 9.9281,
    "lat": 53.5690,
    "adresseFormatiert": "Reichardtstraße 11, Hamburg",
    "bezirk": "Altona",
    "stadtteil": "Bahrenfeld"
  },
  "bebauungsplan": {
    "planName": "Bahrenfeld50",
    "planStatus": "Rechtskräftig",
    "pdfUrl": "https://daten-hamburg.de/.../Bahrenfeld50.pdf",
    "begruendungUrl": "https://daten-hamburg.de/.../Bahrenfeld50.pdf"
  },
  "xplanung": {
    "name": "Bahrenfeld 50",
    "planArt": "BPlan",
    "baugebiete": [
      {
        "nutzungsform": "WohnBauflaeche",
        "grz": "0.4",
        "gfz": "1.2",
        "maxGeschosse": "4"
      }
    ]
  },
  "erhaltungsgebiete": [
    {
      "name": "Bahrenfeld-Süd",
      "paragraf": "§ 172 BauGB",
      "hinweis": "Bauliche Veränderungen an Wohngebäuden genehmigungspflichtig"
    }
  ]
}
```

### GET /health
Gibt `{ "status": "ok" }` zurück – für Monitoring.

## Datenquellen (alle kostenlos & öffentlich)

| Dienst | URL |
|--------|-----|
| ALKIS Adressen | `geodienste.hamburg.de/HH_WFS_ALKIS_Adressen` |
| Bebauungspläne WFS | `geodienste.hamburg.de/HH_WFS_Bebauungsplaene` |
| XPlanungsdaten | `geodienste.hamburg.de/HH_WFS_xplan_dls` |
| Erhaltungsverordnungen | `geodienste.hamburg.de/HH_WFS_Erhaltungsverordnungen` |

Lizenz: Datenlizenz Deutschland Namensnennung 2.0
Quelle: Freie und Hansestadt Hamburg, LGV
