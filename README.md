# Signature Graphics Generator

Macht aus einer Silhouette eine Signature Graphic: nur senkrechte Striche, 2 dp breit,
2 dp Abstand, konstruiert nach den Regeln der DB.

**→ [Zur Anwendung](https://toberpaul.github.io/Signature-Graphics-Generator/)**

Die Umwandlung läuft vollständig im Browser. Dein Bild wird nicht hochgeladen und verlässt
deinen Rechner nicht.

## Benutzen

1. **Bild auswählen.** Am besten eine flache, schwarze Silhouette auf weißem Grund.
   PNG, JPG, WebP oder SVG.
2. **Einstellungen anpassen**, links im Panel:
   - **Schwellwert** – ab welcher Flächendeckung eine Rasterzelle zum Strich wird.
     Niedrig lässt die Form wachsen, hoch lässt sie schrumpfen.
   - **Innenstruktur** – misst das Innere strenger als den Umriss. Damit bleibt der
     Schwellwert niedrig, die Grundform sitzt, und Fenster oder Portale kommen
     trotzdem als Lücken heraus.
   - **Kantenausgleich** – zieht Kanten, die fast auf einer Ebene liegen, auf eine gemeinsame.
     Hilft gegen Perspektive in der Vorlage.
   - **Exakte Spiegelung** – nur für echte Frontalansichten sinnvoll.
3. **Nachbearbeiten** mit den Werkzeugen:
   - **Trennlinien setzen** – Klick in die Vorschau setzt eine waagerechte Trennung,
     Ziehen verschiebt sie, Doppelklick entfernt sie. Seitwärts ziehen begrenzt sie auf
     einzelne Striche, an der Unterkante ziehen macht den Schnitt 4 dp hoch. Für Kanten,
     die die Vorlage nicht deutlich genug hergibt.
   - **Striche löschen** – Klick entfernt einen Strichabschnitt, Ziehen wischt mehrere weg,
     Shift markiert den ganzen zusammenhängenden Bereich. Gelöschtes bleibt rot sichtbar,
     ein Klick darauf holt es zurück. Praktisch gegen Bildunterschriften oder Reste in
     der Vorlage. Ergänzte Striche werden dabei ganz entfernt.
   - **Striche ergänzen** – Klick setzt einen Strich von 4 dp, beim Ziehen wächst er mit.
     An den Enden ziehen ändert die Höhe, in der Mitte ziehen verschiebt ihn, Doppelklick
     entfernt ihn. Option an den Enden lässt ihn nach beiden Seiten wachsen, Option in der
     Mitte kopiert ihn. Für Masten, Antennen oder Fahnenstangen, die zu dünn sind, um die
     Umwandlung zu überleben.
4. **Prüfen.** Die Regler unten rechts blenden Vorlage, Striche und dp-Raster ein und aus.
   **Vergleichen** stellt Strichgrafik und Vorlage nebeneinander. Zoomen über die Knöpfe
   **−** und **+** oder mit Cmd und Mausrad; die Prozentzahl setzt zurück auf 100 %.
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
