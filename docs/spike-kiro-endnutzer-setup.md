# Spike: Kiro als AI-Backend mit dem persönlichen Account nicht-technischer Nutzer

Stand: 2. September 2026 · Status: Recherche + lokale Messungen, keine Architekturänderung
Umfang der Codeänderung in diesem Spike: **ausschließlich** das Binding des lokalen Servers (Punkt E).

## Methodik und Beweislage

| Quelle                                                             | Verwendung                                     |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Offizielle Docs (Authentication, Headless, ACP, CLI-Commands, Exit Codes, Installation) | Flags, Auth-Precedence, ACP-Methoden           |
| Lokale Messungen auf diesem Rechner                                 | CLI-Verfügbarkeit, Credential-Pfade, Port-Binding |
| Drittquellen (GitHub Issues, Docker Docs)                           | nur für den Speicherort der Tokens             |

**Nicht live verifizierbar:** Auf diesem Rechner ist `kiro-cli` nicht installiert (nur die IDE
unter `/Applications/Kiro.app`). Ein echter `kiro-cli login` und ein echter Headless-Aufruf
konnten daher **nicht** ausgeführt werden. Alles, was unten mit ⚠️ markiert ist, ist
dokumentationsbasiert und braucht einen 5-Minuten-Livetest (Testplan am Ende).
Inhalte aus Websuchen wurden für die Lizenzkonformität paraphrasiert.

---

## A. Authentication

### A1. Funktioniert `kiro-cli login` über einen normalen Browser-Login?

**Ja.** Laut [CLI-Command-Referenz](https://kiro.dev/docs/reference/cli-commands/) verhält sich
`kiro-cli login` lokal so:

- Es öffnet den Browser mit dem Auth-Portal.
- Die Auswahl der Login-Methode passiert **im Browser**, nicht im Terminal. Die Doku sagt
  ausdrücklich, dass die Auswahl-Flags (`--license`, `--social`) lokal in der Regel ignoriert
  werden, weil der Browser-Flow die Methode steuert.
- Unterstützte Provider: GitHub, Google, AWS Builder ID, IAM Identity Center, externer IdP.

Für unsere Zielgruppe relevant: Es gibt **keinen** terminalseitigen Auswahldialog, den ein
Marketeer bedienen müsste. ⚠️ Offen ist nur, ob der Prozess ein TTY erwartet (siehe C2).

### A2. Welche Credentials/Session werden lokal gespeichert?

Kiro CLI legt den Auth-Zustand in einer SQLite-Datei im Nutzerprofil ab:

| Plattform | Pfad                                                    |
| --------- | ------------------------------------------------------- |
| macOS     | `~/Library/Application Support/kiro-cli/data.sqlite3`   |
| Linux     | `~/.local/share/kiro-cli/data.sqlite3`                  |

Beleg: [Docker Docs zu Kiro-Sandboxes](https://docs.docker.com/ai/sandboxes/agents/kiro/) und
[kirodotdev/Kiro Issue #4847](https://github.com/kirodotdev/Kiro/issues/4847), das genau diese
Datei als Token-Speicher benennt. Es sind OAuth-Tokens, kein API-Key.
Inhalt: Auth-Tokens, Session-Credentials, Profilinformationen — laut Doku genau das, was
`kiro-cli logout` wieder löscht.

Auf diesem Rechner existiert keiner der beiden Pfade — konsistent damit, dass die CLI fehlt:

```
kein ~/.local/share/kiro-cli
kein ~/Library/Application Support/kiro-cli
```

Wichtig für uns: Der Speicher ist **nutzergebunden**, nicht projektgebunden. Ein Login gilt
maschinenweit für alle Workspaces. Unsere App muss also nichts speichern und nichts verwalten.
`KIRO_HOME` kann `~/.kiro` umbiegen, betrifft aber Agents/Skills/Sessions, nicht diesen Store.

> Sicherheitshinweis: Diese Datei ist ein Credential-Store. Unsere App darf sie nie lesen,
> kopieren oder loggen — der Zugriff läuft ausschließlich implizit über den CLI-Prozess.

### A3. Kann `kiro-cli chat --no-interactive` die bestehende Login-Session nutzen?

**Sehr wahrscheinlich ja** — aber die Doku widerspricht sich an dieser Stelle, deshalb hier die
Beweislage im Detail:

**Dafür (belastbar):** Die [Authentication-Seite](https://kiro.dev/docs/getting-started/authentication/)
definiert eine Precedence-Reihenfolge, wenn mehrere Credentials vorhanden sind:

1. aktive Browser-Session aus `kiro-cli login`
2. `KIRO_API_KEY`
3. keine Credentials → CLI fordert Login an

Die Browser-Session steht also **vor** dem API-Key. Eine Precedence-Liste wäre sinnlos, wenn im
Headless-Modus nur Variante 2 zulässig wäre.

**Dafür (zusätzlich):** Der [Headless-Blogpost](https://kiro.dev/blog/introducing-headless-mode/)
beschreibt `--no-interactive` rein als Ausgabeverhalten — Antwort auf stdout ausgeben und
beenden statt eine interaktive Sitzung zu starten. Der API-Key wird dort als Lösung für
Umgebungen **ohne Browser** eingeordnet (CI, Cron, Container). Beides ist orthogonal: das Flag
steuert die Ausgabe, der Key die Authentifizierung.

**Dagegen:** Die [Headless-Doku](https://kiro.dev/docs/cli/headless/) formuliert kategorisch,
der Headless-Modus verlange einen API-Key in `KIRO_API_KEY`. Zusätzlich ist API-Key-Auth laut
Doku auf Pro/Pro+/Pro Max/Power beschränkt und kann von Admins gesperrt sein.

**Bewertung:** Wir lesen die Headless-Doku als CI-zentrierte Formulierung, nicht als technische
Einschränkung. ⚠️ Das ist die **eine** Annahme, die den ganzen Zero-Terminal-Flow trägt, und
gehört als erstes live geprüft (Testplan T3).

### A4. Braucht genau dieser Modus zwingend `KIRO_API_KEY`?

Nach aktueller Beweislage: **nein**, der Key ist eine Alternative für browserlose Umgebungen,
keine Voraussetzung. Sollte T3 das widerlegen, ist der Key für unsere Zielgruppe doppelt
problematisch: kostenpflichtige Tarifstufe erforderlich **und** ein langlebiges Secret, das
Marketeers selbst im Web-Portal erzeugen und in eine Umgebungsvariable eintragen müssten. Das
verletzt „kein Terminal" und „kein separater Key" gleichzeitig.

---

## B. ACP als Alternative

### B1. Bietet die CLI einen ACP-Modus?

**Ja**, dokumentiert und nicht experimentell: `kiro-cli acp` startet die CLI als ACP-Agent
([ACP-Doku](https://kiro.dev/docs/cli/acp/)). Kommunikation über **JSON-RPC 2.0 auf stdin/stdout**.
Verfügbare Methoden: `initialize`, `session/new`, `session/load`, `session/prompt`,
`session/cancel`, `session/set_mode`, `session/set_model`. Antworten kommen als
`session/notification` mit `AgentMessageChunk` (Streaming), `ToolCall`, `ToolCallUpdate`, `TurnEnd`.
Kiro-Erweiterungen mit Präfix `_kiro.dev/` (Slash-Commands, MCP-OAuth, Compaction) sind als
experimentell markiert — die brauchen wir nicht.

### B2. Arbeitet ACP mit der normalen Login-Session?

**Ja.** ACP ist dasselbe Binary mit demselben Credential-Store; es gibt keinen separaten
Auth-Pfad. Die Doku nennt für ACP an keiner Stelle einen API-Key. Interessanter Punkt: laut
ACP-Doku nutzt der interaktive Chat ACP intern — also genau der Pfad, der garantiert mit
Browser-Login funktioniert. **Damit ist ACP bezüglich Auth das risikoärmere Verfahren als
Headless-Chat**, weil hier keine widersprüchliche API-Key-Aussage existiert.

### B3. Als langlebiger lokaler Prozess aus unserer App startbar?

**Ja**, genau dafür ist es gebaut: Editoren wie Zed und JetBrains starten `kiro-cli acp` als
Kindprozess und sprechen über stdio. Wir würden es identisch machen — ein Prozess pro
App-Instanz, nicht pro Request. Sessions werden unter `~/.kiro/sessions/cli/` persistiert, Logs
unter `$TMPDIR/kiro-log/kiro-chat.log` (macOS), Verbosity über `KIRO_LOG_LEVEL`.

Praktischer Hinweis aus der Doku: Immer den **vollen Pfad** zum Binary verwenden, weil GUI-Apps
den Shell-PATH häufig nicht erben (typisch `~/.local/bin/kiro-cli`). Genau der Fall trifft auf
unseren Server zu, wenn er später aus einer GUI gestartet wird — unser `resolveCliBinary()` deckt
das schon ab.

### B4. Können wir Prompts senden und Antworten empfangen?

Ja: `initialize` → `session/new` (mit `cwd`) → `session/prompt` (Textcontent) → Chunks
einsammeln bis `TurnEnd`. Für uns bedeutet das: JSON-Text aus den `AgentMessageChunk`s
konkatenieren, dann derselbe Extraktions- und Zod-Validierungsschritt wie heute. Renderer,
Datenmodell und Validierung bleiben unberührt.

Aufwand: Wir bräuchten einen JSON-RPC-Client mit Content-Length-Framing plus
Session-Lifecycle-Verwaltung. Fertige ACP-Client-Libraries für TypeScript existieren im
npm-Ökosystem (z. B. `@zed-industries/agent-client-protocol`, aktuell 0.4.5) — Version < 1.0,
also mit Vorsicht zu bewerten. Eigenimplementierung ist realistisch, aber deutlich mehr Code als
der heutige Einzeiler-Spawn.

### B5. Ist ACP für unser Szenario geeigneter?

Differenziert:

| Kriterium                   | `chat --no-interactive` pro Request | `acp` als Dauerprozess          |
| --------------------------- | ----------------------------------- | ------------------------------- |
| Auth-Risiko                 | ⚠️ API-Key-Frage offen (A3)         | ✅ kein API-Key-Thema in der Doku |
| Latenz                      | Prozessstart pro Request            | einmalig, danach warm           |
| Streaming/Progress in der UI | nein                                | ja (`AgentMessageChunk`)        |
| Implementierungsaufwand      | bereits fertig                      | JSON-RPC-Client + Lifecycle     |
| Fehlerisolation              | ✅ jeder Request unabhängig          | Prozess-Crash betrifft alle     |
| Prozessverwaltung            | keine                               | Supervision, Restart, Zombies   |

**Empfehlung:** Für den MVP bleibt Headless-Chat richtig — ein Request ist bei uns zustandslos
und dauert einmalig ein paar Sekunden; Streaming brauchen wir für ein SVG nicht. ACP wird
relevant, wenn (a) T3 zeigt, dass Headless-Chat den API-Key erzwingt, oder (b) die Kaltstartzeit
die UX spürbar stört. Der bestehende `AbstractionService` ist die passende Naht dafür: ein
dritter Provider `AcpAbstractionService` neben Kiro und Mock, ohne Änderung an Renderer,
Datenmodell oder UI.

---

## C. Zero-Terminal User Experience

### C1. Machbarkeitsbewertung

Der gewünschte Flow ist mit den dokumentierten Bausteinen abbildbar, weil `kiro-cli login` den
Browser **selbst** öffnet und `kiro-cli whoami` maschinenlesbar ist:

```
[ Kiro verbinden ]  →  POST /api/kiro/login
                          spawn(kiro-cli, ["login"])        ← öffnet Browser selbst
User meldet sich im Browser an
                       →  Polling GET /api/kiro/status
                          spawn(kiro-cli, ["whoami","--format","json"])
                       →  exit 0  →  UI: „Kiro verbunden als <E-Mail>"
```

Bausteine, alle dokumentiert und ohne erfundene Flags:

| Zweck                   | Kommando                             |
| ----------------------- | ------------------------------------ |
| Status/Erkennung        | `kiro-cli whoami --format json`      |
| Login starten           | `kiro-cli login`                     |
| Trennen                 | `kiro-cli logout`                    |
| Installation prüfen     | `kiro-cli doctor --format json`      |
| Vorhandensein prüfen    | `kiro-cli --version`                 |

`whoami` liefert laut Doku Nutzername/ID, Auth-Methode, Session-Status und Profil; bei
fehlendem Login schlägt es fehl. Damit ersetzen wir unsere heutige `--version`-Prüfung später
durch eine echte Auth-Prüfung — `--version` beantwortet nur „installiert", nicht „angemeldet".
Exit Code 1 deckt laut Doku Auth-Fehler mit ab, deshalb ist `whoami` die verlässliche Quelle
statt Textmustern in stderr (unsere aktuelle Heuristik).

### C2. Risiken, die vor einer Umsetzung geklärt sein müssen

1. **TTY-Anforderung** ⚠️ Wenn `kiro-cli login` ein Terminal erwartet, scheitert ein einfacher
   `spawn` mit `stdio: pipe`. Gegenmittel: Pseudo-Terminal (z. B. `node-pty`) oder Fallback (2).
   Das ist das größte offene technische Risiko des Flows.
2. **Device-Flow als eleganter Fallback.** `kiro-cli login --use-device-flow` gibt URL und
   Einmalcode auf stdout aus und pollt selbst. Unsere UI könnte beides anzeigen — Button
   „Im Browser anmelden" plus Code zum Kopieren. Das ist immer noch zero-terminal und robuster
   gegen TTY-Probleme, kostet den Nutzer aber einen Copy-Paste-Schritt. Einschränkung: mit
   Device-Flow ist Login über einen externen Unternehmens-IdP laut Doku derzeit nicht möglich.
3. **Prozess-Lebensdauer.** Der Login-Prozess läuft, bis der Nutzer im Browser fertig ist.
   Braucht Timeout (z. B. 5 Minuten), Abbruch-Möglichkeit und Schutz gegen Doppelklicks
   (nur ein Login-Prozess gleichzeitig).
4. **Sicherheitsgrenze.** Ein Endpoint, der Prozesse startet, gehört hinter dieselbe
   localhost-Bindung wie alles andere (Punkt E) — sonst könnte ein Dritter im Netz einen Login
   oder Logout auf dem Rechner des Nutzers auslösen.

### C3. Was der Flow nicht löst

Der Nutzer braucht weiterhin einen **eigenen Kiro-Account mit ausreichenden Credits**, und die
Nutzung läuft auf sein persönliches Kontingent. Bei Marketeers ohne Kiro-Lizenz hilft kein
UX-Trick — das ist eine Lizenz- und Kostenfrage, keine technische. Ebenso zu klären: ob euer
Kiro-Admin Social-Login bzw. den benötigten Auth-Weg für diese Nutzergruppe überhaupt zulässt.

---

## D. CLI-Installation

### D1. Technisch automatisierbar?

Ja, grundsätzlich. Dokumentierte Wege:

| Plattform      | Methode                                                  |
| -------------- | -------------------------------------------------------- |
| macOS / Linux  | `curl -fsSL https://cli.kiro.dev/install \| bash`        |
| Windows 11     | `irm 'https://cli.kiro.dev/install.ps1' \| iex`          |
| Linux (Paket)  | `kiro-cli.deb`, AppImage, musl-Variante                  |

Zwei relevante Einschränkungen aus der Doku: **Homebrew ist ausdrücklich nicht unterstützt**
(fällt als Verteilweg auf Macs also weg), und Windows setzt Windows 11 mit PowerShell/Windows
Terminal voraus. Die Installation landet im Nutzerprofil (typisch `~/.local/bin/kiro-cli`),
braucht also keine Admin-Rechte — technisch könnte eine Companion-App das Skript ausführen.

### D2. Bewertung: besser zentral verteilen

Trotz technischer Machbarkeit empfehle ich **zentrale Verteilung durch IT/MDM**:

- Ein Skript aus dem Netz herunterladen und ausführen ist genau das Muster, das
  Endpoint-Security blockiert oder als Vorfall meldet — auf einem Firmen-Mac wahrscheinlich.
- Unsere App müsste Rollback, Versionspinning, Proxy-Konfiguration und Update-Pfad
  (`kiro-cli update`) mit abdecken. Das ist ein eigenes Produkt, kein Feature.
- Bei zentraler Verteilung ist die CLI schon da, wenn der Nutzer die App zum ersten Mal öffnet.
  Dann reduziert sich unser Onboarding auf genau einen Schritt: „Kiro verbinden".
- Firmenumgebungen mit Proxy brauchen ohnehin `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` und
  Allowlisting — das gehört ins IT-Setup, nicht in unsere App.

Sinnvolle Arbeitsteilung: **IT verteilt die CLI, unsere App übernimmt nur den Login.** Falls die
CLI fehlt, zeigt die App eine verständliche Meldung mit Verweis auf den IT-Self-Service statt
selbst zu installieren. Keine Implementierung in diesem Spike — wie gefordert.

---

## E. Security: Binding auf localhost

### Befund vorher (gemessen)

Der Dev-Server lauschte auf allen Interfaces, und `/api/generate` war aus dem LAN erreichbar:

```
$ lsof -nP -iTCP:3211 -sTCP:LISTEN
node  67090  ...  TCP *:3211 (LISTEN)

$ curl http://172.16.48.205:3211/api/health
HTTP 200 via LAN-IP
```

Das ist ernst: Der Endpoint startet lokale Prozesse und verbraucht die Kiro-Credits des
angemeldeten Nutzers. Jeder im selben Netz — Büro-WLAN, Gastnetz, Coworking — konnte
`/api/generate` aufrufen.

### Änderung

Nur die Bindung, in `package.json`:

```json
"dev": "next dev -H 127.0.0.1",
"start": "next start -H 127.0.0.1",
```

### Befund nachher (gemessen)

```
$ lsof -nP -iTCP:3212 -sTCP:LISTEN
node  68019  ...  TCP 127.0.0.1:3212 (LISTEN)

$ curl http://127.0.0.1:3212/api/health      → HTTP 200
$ curl http://172.16.48.205:3212/api/health  → HTTP 000 (blockiert)
```

Renderer, Datenmodell und UI unverändert; 64 Tests und der Build laufen weiter durch.

### Empfehlung für später (nicht umgesetzt)

Localhost-Bindung schützt nicht gegen DNS-Rebinding oder gegen eine beliebige Webseite, die im
Browser des Nutzers `POST http://127.0.0.1:3000/api/generate` auslöst. Sobald der Login-Endpoint
dazukommt, sollten wir zusätzlich `Origin`/`Host` prüfen und einen State-Changing-Endpoint nicht
ohne CSRF-Schutz anbieten.

---

## Decision Matrix

| # | Variante                                        | Technisch möglich?                     | API-Key nötig?              | Terminal für Endnutzer? | Browser-Login? | Für Marketeers geeignet?          |
| - | ----------------------------------------------- | -------------------------------------- | --------------------------- | ----------------------- | -------------- | --------------------------------- |
| 1 | Headless Chat + bestehender Login               | ✅ ja, heute implementiert · ⚠️ Auth-Pfad ungetestet | nein (nach Precedence-Liste) | nein, sofern Login aus der App startet | ✅ ja           | ✅ ja, wenn A3 bestätigt wird      |
| 2 | Headless Chat + API-Key                         | ✅ ja, eindeutig dokumentiert           | ✅ ja                        | nein, aber Key-Handling nötig | nein           | ❌ nein                            |
| 3 | ACP + bestehender Login                         | ✅ ja, dokumentierter Modus             | nein                        | nein                    | ✅ ja           | ✅ ja, aber mehr Eigenkomplexität  |
| 4 | Kiro IDE als Backend (`.../bin/code`)           | ❌ nein                                 | –                           | –                       | –              | ❌ nein                            |
| 5 | Kiro Web / Mobile als Backend                   | ❌ keine dokumentierte lokale API       | –                           | –                       | –              | ❌ nein                            |

Zu Variante 4: gemessen, das IDE-Binary ist ein reiner Fenster-Launcher (Dateien öffnen, Diff,
Extensions) und kennt keinen Chat- oder Headless-Modus. Variante 5 ist keine offiziell
unterstützte Programmierschnittstelle für lokale Apps.

### Empfehlung

**Variante 1 als Zielbild, Variante 3 als vorbereiteter Fallback, Variante 2 nur als Notausgang
für Poweruser.**

Begründung: Variante 1 erfüllt alle acht Anforderungen des Wunsch-Flows und ist bereits
implementiert — es fehlt nur der Login-Trigger in der UI. Ihr einziges echtes Risiko ist die
API-Key-Frage aus A3, und die klärt ein Test in wenigen Minuten. Fällt der Test negativ aus,
ist Variante 3 die richtige Antwort, weil ACP dasselbe Auth-Modell ohne die widersprüchliche
Key-Aussage nutzt; die Provider-Abstraktion macht den Wechsel zu einer additiven Änderung.
Variante 2 widerspricht der Zielgruppe an zwei Stellen (bezahlte Tarifstufe, manuelles Secret)
und sollte höchstens als optionaler Override existieren.

**Beweislücke, die als nächstes geschlossen werden muss:** ob `--no-interactive` mit reinem
Browser-Login läuft (T3) und ob `kiro-cli login` ohne TTY startbar ist (T4). Beides entscheidet
über den ganzen Flow und ist ohne installierte CLI nicht beantwortbar.

---

## Livetest-Plan (auf einem Rechner mit installierter CLI, ca. 10 Minuten)

| #  | Test                                                                      | Erwartung                          | Klärt   |
| -- | ------------------------------------------------------------------------- | ---------------------------------- | ------- |
| T1 | `kiro-cli --version`                                                      | Version, Exit 0                    | Setup   |
| T2 | `kiro-cli login` im Terminal, dann `kiro-cli whoami --format json`        | Browser öffnet, danach JSON mit Account | A1, C1  |
| T3 | `env -u KIRO_API_KEY kiro-cli chat --no-interactive --trust-tools=read "Antworte nur mit OK"` | „OK", Exit 0 **ohne** Key         | **A3, A4** |
| T4 | `kiro-cli login < /dev/null > out.txt 2>&1 &` — ohne TTY                   | Browser öffnet trotzdem            | **C2.1** |
| T5 | `kiro-cli login --use-device-flow`, stdout prüfen                          | URL + Code parsebar                | C2.2    |
| T6 | Datei `data.sqlite3` vor/nach `logout` vergleichen (nur Existenz/mtime)    | Tokens werden entfernt             | A2      |
| T7 | `printf '{"jsonrpc":"2.0","id":0,"method":"initialize",...}' \| kiro-cli acp` | JSON-RPC-Antwort mit Capabilities  | B1–B4   |

T3 und T4 sind die beiden entscheidenden Tests. T6 nur beobachtend — Inhalt der Datei nicht
auslesen.
