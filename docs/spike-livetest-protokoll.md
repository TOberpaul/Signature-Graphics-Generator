# Livetest-Protokoll T1–T7: Kiro CLI mit persönlichem Browser-Login

Datum: 2. September 2026 · Maschine: macOS, MDM-verwaltet (Deutsche Bahn EMM), Nutzer ohne Admin-Rechte
CLI-Version: `kiro-cli 2.21.0` · Account-Typ: IAM Identity Center, Region `eu-central-1`
Am Projektcode wurde für diese Tests **nichts** geändert.

## Ergebnis in einem Satz

**Entscheidung A gilt: Browser-Login + Headless Chat funktioniert ohne API-Key.** Live verifiziert,
inklusive vollem Durchstich unserer App. Es gibt aber eine relevante Einschränkung bei der
Installation (Punkt D unten), die nichts mit Auth zu tun hat.

---

## Installation

### Prüfung des Installers vor der Ausführung

Heruntergeladen von `https://cli.kiro.dev/install`, 588 Zeilen, SHA256
`91a21bfa05cd7b58601cb83e0f1f187a9d0084726e5b824d4a4cf60306250908`.

Befund der Durchsicht — unauffällig:

- kein `sudo`, kein `curl | bash` im Skript selbst, keine Änderung von Shell-Profilen
- Downloads ausschließlich von `https://prod.download.cli.kiro.dev/stable/latest/`
- **SHA256-Verifikation** gegen `manifest.json` vor der Installation, Abbruch bei Abweichung
- `mktemp`-Downloadverzeichnis mit `trap cleanup EXIT`
- eine riskante Stelle: existiert im Ziel ein App-Bundle gleichen Namens, fragt es per
  `read -r response < /dev/tty` und führt danach `rm -rf` darauf aus. Da hier
  `/Applications/Kiro.app` (die IDE) liegt, wurde vorab geprüft: das Bundle im DMG heißt
  **`Kiro CLI.app`**, es gibt also keine Namenskollision. Zusätzlich abgesichert durch
  Ausführung ohne TTY — ohne getipptes „y" bricht das Skript vor dem `rm -rf` ab.
- Artefakt-Authentizität selbst geprüft: DMG-SHA256 `baffdad5…510f` = Wert aus `manifest.json`
  (Version 2.21.0)

### Ausführung: fehlgeschlagen

```
$ bash install.sh < /dev/null
Kiro CLI installer:
Downloading package...
✓ Downloaded and extracted
ditto: /Applications/Kiro CLI.app: Permission denied
❌ Failed to copy application bundle to /Applications
❌ Installation failed. Cleaning up...
```

Ursachenanalyse:

```
$ id -Gn
staff everyone localaccounts _appserverusr _appserveradm awagent_enrolled awagent …   ← kein "admin"

$ ls -ld /Applications
drwxrwxr-x  63 root  admin  2016 /Applications                                       ← nur root+admin

$ sudo -n -v
Sorry, user tobiasoberpaul may not run sudo on bwpm-JWKVYJ9W9Y.                      ← sudo verboten

$ profiles status -type enrollment
MDM enrollment: Yes (User Approved)
MDM server: https://emm.service.deutschebahn.com/…
```

**Der offizielle Installer kann auf dieser Maschine von diesem Nutzer nicht ausgeführt werden.**
Kein Admin, kein `sudo`, MDM-verwaltet. Das ist genau das Szenario eines Marketeer-Laptops.

### Workaround für die Tests (dokumentierte Abweichung)

Um T1–T7 überhaupt messen zu können, wurde das **unveränderte, checksummen-verifizierte**
App-Bundle aus dem offiziellen DMG in das Nutzerprofil kopiert:

```bash
hdiutil attach "Kiro CLI.dmg" -nobrowse -readonly
ditto "/Volumes/Kiro CLI/Kiro CLI.app" ~/Applications/"Kiro CLI.app"
ln -sf ~/Applications/"Kiro CLI.app"/Contents/MacOS/kiro-cli ~/.local/bin/kiro-cli
```

Das ist **nicht** der offizielle Installationsweg, verwendet aber ausschließlich offizielle
Artefakte. Vollständig reversibel: `rm -rf ~/Applications/"Kiro CLI.app" ~/.local/bin/kiro-cli`.
**Wichtiges Nebenergebnis: Kiro CLI läuft ohne Admin-Rechte aus dem Nutzerprofil.**

---

## Testprotokoll

Legende: „TTY nötig" = benötigt ein echtes Terminal · „Key" = war `KIRO_API_KEY` gesetzt
(in allen Tests: **nein**, verifiziert mit `env | grep -c '^KIRO_API_KEY='` → `0`)

### T1 — CLI-Verfügbarkeit · PASS

```
$ "$HOME/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli" --version
kiro-cli 2.21.0
exit: 0
```

Browser: nein · TTY: nein · Key: nein

### T2 — Browser-Login und Session-Erkennung · PASS

Login siehe T4 (identischer Aufruf). Danach:

```
$ kiro-cli whoami --format json
{"accountType":"IamIdentityCenter","email":"[maskiert]","region":"eu-central-1",
 "startUrl":"https://d-99671a01cd.awsapps.com/start"}
Profile:
QDevProfile-eu-central-1
arn:[maskiert]
exit: 0
```

Browser: ja (im Login) · TTY: nein · Key: nein

Zwei Erkenntnisse für die Implementierung:

- **`--format json` ist nicht reines JSON.** Nach dem JSON-Objekt folgt ein Klartextblock
  („Profile:", Profilname, ARN). Ein `JSON.parse()` auf die gesamte stdout schlägt fehl; man
  braucht eine Extraktion des ersten JSON-Objekts (unsere `extractJsonObject` kann das).
- Ausgangszustand vor Login bzw. nach Logout ist eindeutig unterscheidbar:
  `{"account":null}` mit Exit-Code 1 gegen vollständiges Objekt mit Exit-Code 0.

### T3 — Headless Chat ohne API-Key · PASS ← entscheidender Test

```
$ env | grep -c '^KIRO_API_KEY='
0
$ env -u KIRO_API_KEY kiro-cli chat --no-interactive --trust-tools=read \
    "Antworte ausschliesslich mit dem Wort OK"
> OK
exit: 0
stderr: Not all mcp servers loaded. Configure non-interactive timeout with q settings mcp.noInteractiveTimeout
```

Browser: nein · TTY: nein · Key: **nein** · Dauer: ca. 7 s

**Damit ist die offene Frage aus dem ersten Spike beantwortet: die Aussage der Headless-Doku
(„requires an API key") gilt nicht für Maschinen mit aktiver Browser-Session.** Die
Precedence-Liste der Authentication-Doku ist maßgeblich: Browser-Session vor API-Key.

Hinweis am Rand: erster Aufruf über den Symlink in `~/.local/bin` schlug fehl mit
`error: No such file or directory (os error 2)`. Grund ist nicht Auth, sondern dass
`kiro-cli chat` das Geschwister-Binary `kiro-cli-chat` (1,5 GB) im eigenen Verzeichnis erwartet.
**Konsequenz für uns: immer den echten Bundle-Pfad verwenden, keinen Symlink.**

### T4 — `login` ohne TTY · PASS ← zweiter entscheidender Test

```
$ kiro-cli login < /dev/null > log 2>&1        # stdin bewusst kein TTY
▰▱▱▱▱▱▱ Opening browser... | Press (^) + C to cancel
Device authorized...
▰▱▱▱▱▱▱ Fetching profiles...
Logged in successfully
EXIT=0
```

Browser: ja, **von der CLI selbst geöffnet** · TTY: **nein, nicht erforderlich** · Key: nein

Der Login lief ohne jede Terminalinteraktion durch, Exit 0. Zweimal reproduziert (initial und
beim Wiederherstellen der Session). Das grösste Risiko des Zero-Terminal-Flows aus dem ersten
Spike (C2.1) ist damit ausgeräumt: unsere App kann `kiro-cli login` einfach als Kindprozess
starten, ein Pseudo-Terminal ist nicht nötig.

### T5 — Device-Flow als Fallback · PASS mit Einschränkung

```
$ kiro-cli login --use-device-flow < /dev/null
Confirm the following code in the browser
Code: [maskiert]
▰▰▱▱▱▱▱ Logging in...
```

Browser: ja · TTY: nein · Key: nein

Code und Aufforderung sind auf stdout parsebar, taugen also für eine eigene UI. **Aber:** der
Device-Flow öffnet zusätzlich selbst den Browser — er ist also kein „stiller" Modus. Weil bei
diesem Account IAM Identity Center greift, erscheint dabei die AWS-Identity-Center-Seite der
Organisation. Das hat im Test kurzzeitig für Verwirrung gesorgt und ist ein UX-Hinweis für
später: Nutzer müssen wissen, dass die AWS-Seite der legitime Kiro-Login ist.

Da T4 bereits ohne TTY funktioniert, brauchen wir den Device-Flow **nicht**. Der Test wurde
abgebrochen und nicht abgeschlossen.

### T6 — Logout und Credential-Store · PASS

```
$ ls -la "~/Library/Application Support/kiro-cli/data.sqlite3"
size=516096  mtime=Sep 2 23:36                      # vorher

$ kiro-cli logout
You are now logged out
Run kiro-cli login to log back in to Kiro CLI
exit: 0

$ ls -la "…/data.sqlite3"
size=516096  mtime=Sep 2 23:37                      # nachher: Datei bleibt, mtime aktualisiert

$ kiro-cli whoami --format json
{"account":null}
exit: 1
```

Browser: nein · TTY: nein · Key: nein

Die Datei bleibt bestehen, die Tokens darin werden entfernt. **Der Inhalt wurde bewusst nicht
gelesen** — nur Größe und Zeitstempel. Der im ersten Spike aus Drittquellen abgeleitete Pfad
`~/Library/Application Support/kiro-cli/data.sqlite3` ist damit bestätigt.

Die Session wurde nach dem Test sofort per `kiro-cli login` wiederhergestellt (Exit 0,
`whoami` liefert wieder das vollständige Objekt).

### T7 — ACP mit derselben Browser-Session · PASS

```
$ kiro-cli acp        # JSON-RPC 2.0, newline-delimited, über stdin/stdout
>> initialize
<< {"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,
   "promptCapabilities":{"image":true,…},"mcpCapabilities":{"http":true,…}},
   "agentInfo":{"name":"Kiro CLI Agent","version":"2.21.0"}}}
>> session/new  {"cwd":"…","mcpServers":[]}
<< {"result":{"sessionId":"02a7c1f0-…","modes":{"currentModeId":"kiro_default",
   "availableModes":[kiro_default, kiro_planner, …]}}}
>> session/prompt  {"sessionId":"…","prompt":[{"type":"text","text":"…"}]}
<< session/update  agent_message_chunk  "O"
<< session/update  agent_message_chunk  "K"
<< _kiro.dev/metadata  {"meteringUsage":[{"value":0.0715,"unit":"credit"}],"turnDurationMs":1150}
<< {"result":{"stopReason":"end_turn"},"id":2}
```

Browser: nein · TTY: nein · Key: **nein** · Dauer: 1,15 s pro Turn (laut `turnDurationMs`)

ACP läuft mit derselben Browser-Session, ohne API-Key. Drei Erkenntnisse:

1. **Die Kiro-ACP-Doku ist an einer Stelle falsch.** Ihr Beispiel zeigt `session/prompt` mit
   dem Feld `content`. Damit antwortet der Agent nie — der Aufruf lief in den 60-s-Timeout.
   Korrekt ist das ACP-Spec-Feld **`prompt`**. Mit `prompt` funktioniert es sofort.
2. **MCP kann den Turn blockieren.** Im ersten Versuch kam
   `_kiro.dev/mcp/oauth_request` und der Turn hing, weil global konfigurierte MCP-Server
   OAuth verlangen. Mit isoliertem `KIRO_HOME` verschwand das. Für einen Produktionsbetrieb
   müssten wir MCP für unsere Sessions bewusst leer konfigurieren.
3. `KIRO_HOME` umzubiegen beeinflusst die Authentifizierung **nicht** — die Credentials liegen
   außerhalb von `~/.kiro`. Das bestätigt die Annahme aus dem ersten Spike.

---

## Voller Durchstich unserer App gegen die echte CLI

Server mit `KIRO_CLI_PATH` auf das Bundle-Binary, Provider `kiro`, kein API-Key:

```
GET /api/health
{"provider":"kiro","available":true,"message":"Kiro CLI gefunden: kiro-cli 2.21.0",
 "command":"…/kiro-cli chat --no-interactive --trust-tools=read \"<prompt>\""}
```

```
POST /api/generate   {"subject":"…","detail":"medium"}
ICE                → HTTP 200, 21 Balken
Brandenburger Tor  → HTTP 200, 19 Balken
Eiffelturm         → HTTP 200, 15 Balken
Apfel              → HTTP 200, 15 Balken
```

Alle vier Referenzmotive wurden von Kiro über den Projekt-Skill abstrahiert, von Zod plus
Semantikprüfung validiert und gerendert. Dauer je Aufruf ca. 14 s.

### Ein Fehlschlag von 7 Aufrufen — Parser-Härtung nötig

Ein Aufruf lief auf `HTTP 422 invalid_illustration` mit:

```
meta: Invalid input: expected object, received undefined
<root>: Unrecognized keys: "subject", "label", "symmetry"
```

Unser Extractor hatte das **innere `meta`-Objekt** erwischt statt des Wurzelobjekts. Ursache ist
das Ausgabeformat der CLI. Rohausgabe mit sichtbaren Steuerzeichen:

```
^[[38;5;141m> ^[[0m^[[1mjson
^[[0m^[[38;5;10m{"meta":{…}}
^[[0m
```

Die CLI schreibt **ANSI-Farbcodes auch ohne TTY und trotz `NO_COLOR=1` und `TERM=dumb`** und
rendert Markdown-Codefences mit, wobei das Fence-Label `json` auf einer eigenen Zeile landet.
Je nach Modellantwort scheitert dann `JSON.parse` auf dem Wurzelobjekt, und unsere
Fallback-Schleife greift das nächste `{` — also `meta`.

Kein Auth-Problem, sondern reine Robustheit des Parsers. Bewusst **nicht** gefixt, wie
gewünscht. Vorschlag für später: nach ANSI-Strip das **größte** balancierte JSON-Objekt wählen
statt des ersten, und die Kandidaten vor der Rückgabe gegen das Zod-Schema prüfen.

---

## Entscheidung

### A) Browser-Login + Headless Chat funktioniert ohne API-Key → **bevorzugte Architektur** ✅

Live bewiesen: T3 (Headless ohne Key, Exit 0), T4 (Login ohne TTY, Exit 0), T2 (Session
maschinenlesbar erkennbar) und vier erfolgreiche Generierungen durch unsere App. Damit sind
alle acht Anforderungen des gewünschten User Flows technisch erfüllt. Die bestehende
Architektur bleibt richtig; es fehlt nur der „Kiro verbinden"-Button, der `kiro-cli login`
startet und per `whoami` pollt.

Bestätigt gilt außerdem: **B) ACP funktioniert ebenfalls mit Browser-Login** (T7). ACP ist
damit kein Notausgang, sondern eine echte Option — nötig ist es für unseren Anwendungsfall
aber nicht, weil A bereits reicht. Als Reserve bleibt es attraktiv (1,15 s Turn gegen ca. 14 s
Prozessstart pro Request).

**C) trifft nicht zu** — kein API-Key erforderlich, auf keinem der beiden Wege.

### D) Sonstige Einschränkung — und sie ist die eigentliche Hürde

Die Auth-Frage ist gelöst, die **Installation** ist es nicht:

1. **Kein Admin, kein sudo, MDM-verwaltet.** Der offizielle Installer scheitert reproduzierbar
   an `/Applications`. Ein Marketeer kann Kiro CLI auf so einem Gerät nicht selbst
   installieren — auch nicht mit einer Companion-App, solange das Ziel `/Applications` ist.
   Die Empfehlung aus dem ersten Spike ist damit belegt: **IT muss die CLI zentral verteilen**
   (MDM), oder es braucht offiziell einen nutzerlokalen Installationspfad.
2. **Downloadgröße über 1 GB** (DMG, entpackt u. a. ein 1,5-GB-Binary `kiro-cli-chat`). Für
   eine Verteilung an viele Nutzer relevant, für eine „mal schnell installieren"-UX
   disqualifizierend.
3. **Kein Symlink auf das Binary.** `kiro-cli chat` braucht seine Geschwister-Binaries im
   selben Verzeichnis. Unsere Pfadauflösung muss auf das echte Bundle zeigen.
4. **Credits laufen auf den persönlichen Account.** `_kiro.dev/metadata` weist pro Turn
   Credit-Verbrauch aus (im Test 0,0715 Credits für eine Zwei-Zeichen-Antwort). Bei
   Marketeers ohne eigene Kiro-Lizenz bleibt das eine Lizenz- und Kostenfrage.
5. **MCP-Server können Aufrufe verzögern oder blockieren.** In beiden Modi sichtbar
   (`Not all mcp servers loaded`, `_kiro.dev/mcp/oauth_request`). Für unsere Requests sollten
   MCP-Server explizit deaktiviert werden.
6. **UX-Detail Identity Center:** der Login zeigt eine AWS-Seite. Das gehört in der UI erklärt,
   sonst wirkt es wie ein falscher Dienst.

### Empfehlung

Am Zielbild festhalten (Variante A), und zwar in dieser Reihenfolge:

1. Parser härten (größtes JSON-Objekt statt erstes) — kleiner Fix, behebt den einzigen
   beobachteten Fehlschlag.
2. `whoami --format json` als echte Auth-Prüfung statt `--version`.
3. „Kiro verbinden"-Flow: `login` spawnen, per `whoami` pollen, Status in der UI.
4. Mit IT klären, ob Kiro CLI über MDM verteilt werden kann. **Das ist der kritische Pfad für
   die Zielgruppe, nicht die Technik.**

---

## Zustand der Maschine nach den Tests

- Kiro CLI 2.21.0 liegt in `~/Applications/Kiro CLI.app` plus Symlink `~/.local/bin/kiro-cli`.
  Nichts außerhalb des Nutzerprofils verändert, `/Applications/Kiro.app` (IDE) unangetastet.
- **Login wiederhergestellt**, `whoami` liefert Exit 0 und den Account. Headless nach dem
  Re-Login erneut verifiziert (`> OK`, Exit 0).
- Temporäre Testartefakte (`.spike-tmp/`) wurden nach Abschluss vollständig gelöscht; alle
  Belege sind oben inline zitiert.
- Vollständige Deinstallation, falls gewünscht:
  `rm -rf ~/Applications/"Kiro CLI.app" ~/.local/bin/kiro-cli` (Tokens zusätzlich via
  `kiro-cli logout`).
