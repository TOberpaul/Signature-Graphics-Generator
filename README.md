# Signature Graphics Generator

Aus einer Silhouette (PNG, JPG, WebP, SVG) entsteht eine regelkonforme Signature Graphic:
ausschließlich senkrechte Striche, 2 dp breit, 2 dp Abstand, konstruiert nach den offiziellen
Regeln.

Die Umwandlung läuft **vollständig im Browser**. Es wird kein Bild hochgeladen, es gibt keinen
Server-Aufruf, keinen API-Key und keine KI im Pfad. Das Ergebnis ist deterministisch:
dieselbe Vorlage mit denselben Einstellungen liefert immer dieselbe Grafik.

## Architektur

```
Browser (React)
  └─ Bildvorlage -> Canvas -> RGBA
       └─ imageToMask          Schwellwert -> binäre Formmaske
       └─ cleanMask            Fragmente entfernen, Pinholes füllen
       └─ trimGrid             auf die befüllte Fläche zuschneiden
       └─ chooseFormat         96×96, sonst 144×96 / 96×144
       └─ planSignatureCanvas  Zeichenfläche + seitenverhältnistreue Einpassung
       └─ resampleMaskTo       Abtastung: 1 dp vertikal, 1 Spalte pro Strich
       └─ placeInDrawable      zentriert, Schutzraum bleibt frei
       └─ constructStrokes     Konstruktionsregeln
       └─ Zod-Schema + semantische Validierung
  └─ deterministischer SVG-Renderer (Preview identisch zum Export)
  └─ Export als SVG oder PNG
```

Die Reihenfolge ist bewusst so: **putzen vor zuschneiden**. Würde zuerst zugeschnitten,
könnte ein einzelnes Staubkorn in einer Ecke die Bounding-Box aufziehen und das Motiv würde
viel zu klein eingepasst.

Geometrie, Pixelkoordinaten und Skalierung berechnet ausschließlich der Renderer.

## Voraussetzungen

- Node.js ≥ 20.9
- npm

## Installation und Start

```bash
cp .env.example .env.local   # Werte für die DB-Assets eintragen
npm install
npm run dev                  # http://127.0.0.1:3000
```

Weitere Skripte:

```bash
npm test               # Vitest, einmaliger Durchlauf
npm run build          # Produktionsbuild inkl. TypeScript-Check
npm run lint           # nur tsc --noEmit
npm run templates      # Testvorlagen als PNG nach ./templates
```

## Design System

Das UI nutzt das **DB UX Design System v3** mit offiziellen React-Komponenten:

```tsx
import { DBButton, DBInput, DBSelect, DBInfotext } from "@db-ux/react-core-components";
```

Alle Farben, Abstände und Typografie kommen aus `var(--db-*)`-Tokens; `src/app/globals.css`
enthält nur Layout.

### Zwei Fallen bei der Einbindung

**1. LightningCSS zerlegt `light-dark()`.** Die Farbtokens des Design Systems sind über
`light-dark(hell, dunkel)` definiert. Next.js verarbeitet CSS mit LightningCSS, das diese
Funktion bei alten Browser-Targets in ein `var(--lightningcss-light, …) var(--lightningcss-dark, …)`
Konstrukt übersetzt – das als Farbwert ungültig ist. Ergebnis: das UI rendert ungestylt.

Deshalb steht in `package.json` eine `browserslist` mit Targets, die `light-dark()` native
unterstützen. **Nicht entfernen**, sonst sind alle Farben wieder weg. Gegenprobe:

```bash
# im ausgelieferten CSS muss light-dark( vorkommen und --lightningcss-light nicht
curl -s "http://127.0.0.1:3000$(curl -s http://127.0.0.1:3000 \
  | grep -o 'href="[^"]*\.css[^"]*"' | head -1 | sed 's/href="//;s/"//')" \
  | grep -c 'light-dark('
```

**2. DB-Brand-Assets sind verschlüsselt.** Schrift (DB Neo Screen Sans) und DB-Farben liegen
in `@db-ux/db-theme`. Dessen `postinstall` entschlüsselt sie mit `ASSET_INIT_VECTOR` und
`ASSET_PASSWORD` aus der Umgebung. Fehlen die Werte, läuft das UI im White-Label-Theme.
Die Layer-Reihenfolge in `globals.css` ist relevant: `db-theme` vor `db-ux`.

**3. `DBStack` scrollt selbst.** Die Komponente setzt `overflow: auto`, um ihren Container zu
füllen. In einem eigenen Scroll-Container schneidet das den Focus-Ring ab, weil ein
Scroll-Container seine Kinder an der Padding-Box klippt. `globals.css` setzt den Stack in der
Steuerspalte deshalb auf `overflow: visible`.

## Signature-Graphics-Konstruktion

`src/lib/illustration/signature.ts` setzt die offiziellen Konstruktionsregeln um. Die Ausgabe
ist keine roh gesampelte Silhouette, sondern eine regelkonforme Strichgrafik.

**Einheit:** In dieser Schicht ist **1 Unit = 1 dp**. Das ist die einzige Zuordnung, in der
alle Regelwerte ganzzahlig sind – bei 1 Unit = 2 dp ließen sich weder der 1 dp vertikale
Abstand noch der 3 dp Schutzraum darstellen.

| Regel                      | Wert                            | Umsetzung              |
| -------------------------- | ------------------------------- | ---------------------- |
| Grundfläche                | 96×96 dp (ideal)                | `planSignatureCanvas`  |
| Schutzraum                 | 3 dp                            | `canvas.paddingUnits`  |
| Strichstärke               | 2 dp                            | `system.barWidthUnits` |
| horizontaler Abstand       | 2 dp (Pitch 4 dp)               | `system.gapUnits`      |
| Mindestlänge               | 4 dp                            | `removeFragments`      |
| vertikaler Abstand         | 1 dp, bewusste Lücke ≥ 4 dp     | `snapGaps`             |
| horizontaler Versatz       | 2 dp                            | `staggerLevelBands`    |
| nicht bündig nebeneinander | –                               | `bar.xOffsetUnits`     |
| horizontale Merkmale       | Reihe kurzer vertikaler Striche | `markLevels`           |
| kleine Fragmente entfernen | –                               | `cleanMask`            |

`snapGaps` lässt genau zwei vertikale Abstände zu: 1 dp als normale Trennung und ≥ 4 dp als
bewusste Lücke. Die dazwischenliegenden 2–3 dp werden auf 1 dp gezogen, weil sie sonst wie
ein Fehler wirken. Große Negativräume liegen deutlich über 4 dp und bleiben unberührt.

`markLevels` erkennt horizontale Merkmale daran, dass ein Lauf kürzer als 4 dp ist, sich aber
über mindestens 3 Nachbarspalten wiederholt. Das ist eine Ebene, kein Fragment, und wird auf
4 dp gewachsen statt gelöscht – daraus entsteht die Reihe kurzer vertikaler Striche.

### Extremformen

Das Motiv wird **nie** gestaucht, um in 96×96 dp zu passen:

- Das Seitenverhältnis der Maske wird exakt übernommen.
- Die Fläche wird auf die Grundfläche normiert (`Breite × Höhe ≈ 96²`). Ein hohes Motiv wird
  dadurch höher **und** schmaler, ein breites breiter und flacher – die visuelle Größe bleibt
  im Verhältnis zu normalen Signature Graphics harmonisch.
- Die lange Seite ist auf den doppelten Basiswert begrenzt; darüber wird das Motiv als Ganzes
  verkleinert, das Seitenverhältnis bleibt erhalten.
- Strichstärke und Rasterabstand bleiben davon unberührt und sind immer 2 dp / 2 dp. Die
  Erweiterung entsteht ausschließlich durch zusätzliche Spalten bzw. zusätzliche Höhe.

Eiffelturm → `extension: "vertical"`, Zug oder breite Architektur → `extension: "horizontal"`.
Die UI weist auf eine Erweiterung hin.

### Bewusste Abweichungen

**`bar.xOffsetUnits` ist neu.** Der 2-dp-Versatz ließ sich im bisherigen Modell nicht
ausdrücken, weil `bar.x` ein ganzzahliger Index auf einem 4-dp-Raster ist. Die Validierung
erzwingt `xOffsetUnits < pitch` und erlaubt zwei Striche im selben Slot nur bei
unterschiedlichem Versatz.

**„Nicht bündig nebeneinander" gilt zwischen Elementen, nicht für die Außenkante.** Die Regel
wird von `staggerLevelBands` umgesetzt: ein Band wandert einen halben Pitch zur Seite, damit
seine Striche nicht dieselben Spaltenpositionen wie das Element darüber oder darunter belegen.

Eine frühere Fassung hat zusätzlich jede Kontur-Kante aufgebrochen, die sich über mehrere
Spalten auf einer Zeile befand. Das war falsch: eine gerade Unterkante – Eisboden, Sockel,
Standlinie – ist ein charakteristischer Teil der Form, und Striche, die auf derselben Linie
enden, sind weiterhin nichts als senkrechte Striche. Die Richtlinie verbietet horizontale
*Linien* als Geometrie, nicht bündige Strichenden. Der Kontur-Versatz hat aus jeder geraden
Kante optisches Rauschen gemacht und entfällt deshalb bewusst.

**Detailgrad weicht bewusst ab.** Nur `medium` entspricht der Ideal-Grundfläche von 96 dp;
`low` (64 dp) und `high` (128 dp) verändern die Fläche und damit die Strichanzahl. Bei fixem
4-dp-Pitch sind Fläche und Strichanzahl dieselbe Schraube.

## Einstellungen

| Einstellung                   | Wirkung                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Schwellwert                   | Ab welcher mittleren Tintendeckung eine Zelle als belegt gilt. Start per Otsu.       |
| Maskenauflösung               | Auflösung der Zwischenmaske, **nicht** die Strichanzahl. Höher = genauer gemessen.   |
| Helle Form auf dunklem Grund  | Dreht um, welche Luminanz als Tinte gilt. Setzt den Schwellwert neu vor.              |
| Exakte Spiegelung             | Spiegelt die Maske vor der Konstruktion: linke Hälfte, rechte Hälfte oder vereinen.   |
| Detailgrad                    | Wählt die Grundfläche: 64 / 96 / 128 dp.                                              |

Transparente Pixel zählen immer als Hintergrund, freigestellte PNGs funktionieren ohne Zutun.

## Datenmodell

```ts
type BarSegment = { y: number; height: number };
type Bar = { x: number; xOffsetUnits?: number; segments: BarSegment[] };

type BarIllustration = {
  meta: { subject: string; label?: string; symmetry?: "none" | "vertical" };
  canvas: { widthUnits: number; heightUnits: number; paddingUnits: number };
  system: { barWidthUnits: number; gapUnits: number };
  bars: Bar[];
};
```

- `x` ist der **logische Strichindex**, keine Pixelposition.
- Der Renderer berechnet `svgX = (padding + x * pitch + xOffsetUnits) * unitSize`.
- Alle Werte sind ganzzahlige Units. In der Signature-Pipeline ist eine Unit ein dp und
  `system` ist `{ barWidthUnits: 2, gapUnits: 2 }`.

### Validierung

Zod-Schema (strikt, keine unbekannten Properties) plus semantische Prüfungen: Integer für
`x`, `y`, `height`; `height > 0`; keine negativen Positionen; kein Strich außerhalb der
Canvas-Breite; keine Segmente außerhalb der Canvas-Höhe; keine doppelten `x`-Werte bei
gleichem Versatz; `xOffsetUnits < pitch`; keine überlappenden oder unsortierten Segmente;
Limits für Strich- und Segmentzahl; `barWidthUnits === gapUnits`. Ungültige Daten werden nie
gerendert.

## Renderer

`src/lib/illustration/renderer.ts` ist rein und deterministisch: ein `<rect>` pro Segment,
keine Paths, Kurven, Diagonalen, Schatten, Gradients oder Transformationen. Preview und
Export nutzen dieselbe Funktion, können also nicht abweichen.

Die Vorschau rendert immer mit fester Unit-Größe und skaliert per CSS in ihre Fläche – sie
kann dadurch nicht überlaufen. Die Ausgabegröße ist ausschließlich Sache des Exports.

## Export

Über den Export-CTA oben rechts, deaktiviert solange keine Grafik vorliegt:

- **SVG** – Vektor, auflösungsunabhängig
- **PNG** – 512 / 1024 / 2048 / 4096 px Breite, Seitenverhältnis bleibt erhalten

Das PNG entsteht durch Rasterisierung des SVG über Canvas. Das SVG wird als Data-URL
geladen, damit die Canvas nicht „tainted" wird und `toBlob` verfügbar bleibt.

## Vorlagen

Am besten funktioniert eine flache Silhouette auf hellem Grund, etwa ein schwarzes
Piktogramm. Drei Quellen, in dieser Reihenfolge sinnvoll:

**1. DB Icon Set** – rund 400 offizielle Vektor-Silhouetten. Markenkonform und
deterministisch reproduzierbar.

**2. Bildwerkzeug** (z. B. Firefly) – für Motive außerhalb des Icon-Sets. Bewährter Prompt:
„Minimal black silhouette icon of a pear, centered, pure white background, no shadows, no
gradients, no texture, flat 2D vector-like pictogram."

**3. Eingebauter Generator** – handgebaute parametrische Formen, keine KI:

```bash
npm run templates        # PNG nach ./templates
npm run templates:jpg    # zusätzlich JPG (nutzt sips, nur macOS)
```

Erzeugt `birne`, `apfel`, `herz`, `wolke`, `sonne`, `baum`, `flasche` als 512×512 Silhouetten
(`tools/silhouettes.mjs`). Form eines PNG als ASCII prüfen, ohne Bildbetrachter:

```bash
node tools/preview-png.mjs templates/birne.png 44
```

## Sicherheit

- Kein Server-Endpunkt, kein Datei-Upload, keine ausgehende Verbindung im Konvertierungspfad.
- Es werden keine Credentials gelesen, protokolliert oder ausgegeben. `ASSET_INIT_VECTOR` und
  `ASSET_PASSWORD` werden nur vom `postinstall` des Theme-Pakets gelesen.
- Das SVG wird aus validierten Integer-Daten erzeugt; Text wird XML-escaped.
- `npm run dev` und `npm start` binden ausschließlich an `127.0.0.1`.

## Tests

```bash
npm test
```

108 Tests in fünf Dateien:

- `illustration.test.ts` – Schema- und Semantikvalidierung, Unit/Pitch-Berechnung, Renderer:
  identische Strichbreiten, identische Abstände, lineare Skalierung, Determinismus, keine
  Paths/Gradients, Escaping
- `signature.test.ts` – Konstruktionsregeln: Mindestlänge, nur legale vertikale Abstände,
  erhaltene Negativräume, Ebenen als kurze Striche, Bandversatz, Grundfläche und
  Extremform-Erweiterung, Determinismus, sowie gerade Konturkanten bleiben gerade
  (Regressionstest mit Eisform)
- `shapeMask.test.ts` – Abtastung, Spiegelmodi, Auflösung
- `imageMask.test.ts` – Schwellwert, Otsu, Alpha-Behandlung
- `occupancy.test.ts` – Grid-Normalisierung, Trimmen, Run-Length-Mapping, Limits

## Bekannte Einschränkungen

- Die Schwellwerte in `cleanMask` (2 % Fragmentgröße, 1 % Lochgröße) und
  `LEVEL_MIN_COLUMNS = 3` sind begründete Startwerte, nicht an einer breiten Motivsammlung
  kalibriert. Bei verschluckten Ebenen oder behaltenen Fragmenten sind das die Schrauben.
- Die Flächennormierung koppelt Strichanzahl an das Seitenverhältnis: ein sehr hohes Motiv
  wird schmaler und bekommt dadurch weniger Striche. Ein Eis mit Seitenverhältnis 1:2,8
  landet bei 14 Strichen. Wer für hohe Motive mehr Auflösung will, erhöht den Detailgrad.
- Unter 60 rem wechselt das Layout auf eine Spalte und die Seite scrollt.
- Kein Persistieren von Ergebnissen, keine Historie.
