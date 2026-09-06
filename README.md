# Signature Graphics Generator

Macht aus einer Silhouette eine Signature Graphic: nur senkrechte Striche, 2 dp breit,
2 dp Abstand, konstruiert nach den Regeln des DB UX Design System v3.

**→ [Zur Anwendung](https://toberpaul.github.io/Signature-Graphics-Generator/)**

Die Umwandlung läuft vollständig im Browser. Dein Bild wird nicht hochgeladen und verlässt
deinen Rechner nicht.

## Benutzen

1. **Bild auswählen.** Am besten eine flache, schwarze Silhouette auf weißem Grund.
   PNG, JPG, WebP oder SVG.
2. **Einstellungen anpassen**, links im Panel:
   - **Schwellwert** – ab welcher Flächendeckung eine Rasterzelle zum Strich wird.
     Niedrig lässt die Form wachsen, hoch lässt sie schrumpfen.
   - **Bereinigung** – entfernt kleine freistehende Flecken und schließt winzige Löcher.
   - **Kantenausgleich** – zieht Kanten, die fast auf einer Ebene liegen, auf eine gemeinsame.
     Hilft gegen Perspektive in der Vorlage.
   - **Exakte Spiegelung** – nur für echte Frontalansichten sinnvoll.
3. **Nachbearbeiten** mit den Werkzeugen:
   - **Trennlinien setzen** – Klick in die Vorschau setzt eine waagerechte Trennung,
     Ziehen verschiebt sie, Doppelklick entfernt sie. Für Kanten, die die Vorlage nicht
     deutlich genug hergibt.
   - **Striche löschen** – Klick entfernt einen Strichabschnitt, Ziehen wischt mehrere weg,
     Shift markiert den ganzen zusammenhängenden Bereich. Praktisch gegen Bildunterschriften
     oder Reste in der Vorlage.
4. **Prüfen.** Die Regler unten rechts blenden Vorlage, Striche und dp-Raster ein und aus.
   **Vergleichen** stellt Strichgrafik und Vorlage nebeneinander.
5. **Exportieren** oben rechts, als SVG oder als PNG in 512 bis 4096 px Breite.
   Farbe wählbar: Schwarz, Rot oder Lilac.

## Gute Vorlagen

Entscheidend ist der Umriss, denn nur er wird ausgelesen. Farbe, Verläufe und Schatten
werden verworfen.

- **Flache Silhouette**, reines Schwarz auf reinem Weiß.
- **Kräftige, einfache Formen.** Bei 23 Strichen über die Breite verschwindet alles,
  was schmaler als etwa ein Dreiundzwanzigstel der Breite ist.
- **Innenstruktur nur als weiße Aussparung.** Fenster oder Durchgänge müssen aus der
  schwarzen Fläche ausgeschnitten sein, sonst können sie nicht entstehen.
- **Spitzen und Masten etwas dicker zeichnen.** Was dünner als ein Strich ist, wird
  flach abgeschnitten.

Das DB Icon Set ist die zuverlässigste Quelle. Für Motive außerhalb davon eignet sich ein
Bildwerkzeug wie Firefly.

## Lokal starten

Node.js ≥ 20.9 vorausgesetzt.

```bash
cp .env.example .env.local   # Werte für die DB-Brand-Assets eintragen
npm install
npm run dev                  # http://127.0.0.1:3000
```

Ohne die Werte in `.env.local` läuft die Anwendung im White-Label-Theme, also ohne
DB-Schrift und DB-Farben.

```bash
npm test        # Tests
npm run build   # Produktionsbuild inklusive TypeScript-Check
```
