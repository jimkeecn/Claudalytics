<div align="center">

[English](../README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | Deutsch

# Analytic Claude

**Lokales Analytics-Dashboard fuer Claude Code**

Verfolge Kosten, Tokens, Tool-Nutzung und Session-Aktivitaeten ueber alle deine Projekte hinweg.
Keine Cloud-Abhaengigkeiten. Deine Daten bleiben auf deinem Rechner.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)]()
[![ClickHouse](https://img.shields.io/badge/ClickHouse-24.8-yellow)]()
[![Grafana](https://img.shields.io/badge/Grafana-11.4-orange)]()

[Installation](#installation) · [Funktionen](#funktionen) · [Aktualisierung](#aktualisierung) · [Teamnutzung](#teamnutzung) · [Sprachen](#sprachen)

</div>

---

![Dashboard-Uebersicht](../images/heroshot.png)

## Installation

### 1. Analytics-Stack starten

```bash
git clone https://github.com/jimkeecn/Analytic_Claude.git
cd Analytic_Claude/docker-stack
docker compose up -d --build
```

Warte ca. 30 Sekunden. Gehe dann zurueck ins Repository-Stammverzeichnis und oeffne Claude Code:

```bash
cd ..
claude
```

Fuehre `/validate-infra` aus, um zu pruefen, ob alle 4 Container, Tabellen und Materialized Views ordnungsgemaess funktionieren.

### 2. Plugin in deinem Projekt installieren

Oeffne ein beliebiges Projekt in Claude Code und installiere das Plugin:

```
/install-plugin /full/path/to/Analytic_Claude/plugin
```

### 3. Initialisieren

```
/init-claude-analytics
```

Folge den Eingabeaufforderungen — bestatige deinen Projektnamen, und der Skill konfiguriert alles automatisch.

### 4. Claude Code neu starten und Dashboards oeffnen

Starte deine Session neu, damit die Telemetrie wirksam wird, und oeffne dann:

**http://localhost:3000** (admin / admin)

Navigiere zu: **Home > Dashboards > Claude Analytics > Claude Analytics - OTel Overview**

Das war's. Daten fliessen sofort.

---

## Funktionen

### Session-Zeitleiste

Jede Aktion in einer einzigen Ansicht — Prompts, API-Aufrufe, Tool-Ausfuehrungen, Subagent-Dispatches, Berechtigungsanfragen, Compaction-Ereignisse — aus OTel und Hooks zu einer chronologischen Zeitleiste zusammengefuehrt.

![Session-Verlauf](../images/sectionHistory.png)

### Kosten- & Token-Analyse

Verfolge Ausgaben ueber Sessions, Modelle und Projekte hinweg. Sieh Kosten pro 1K Output-Tokens, Token-Nutzung im Zeitverlauf, Cache-Trefferquoten und identifiziere deine teuersten Sessions und Prompts.

### Skill- & Subagent-Tracking

Ueberwache, welche Skills und Subagents Claude verwendet, ihre Erfolgsquoten, Dauer und Modellauswahl. Erkenne Ineffizienzen — hohe Wiederaufrufquoten bedeuten, dass der erste Versuch wahrscheinlich fehlgeschlagen ist.

<div align="center">
<img src="../images/skillUsed.png" width="320" />
<img src="../images/subAgents.png" width="640" />
</div>

### Erkennung von Zugangsdaten-Exposition

Erkennt automatisch, wenn Claude sensible Dateien liest — `.env`, AWS-Zugangsdaten, SSH-Schluessel, Zertifikate, Datenbank-Konfigurationen — ueber 38 Muster in 13 Kategorien. Keine Konfiguration noetig. Basiert auf einer ClickHouse Materialized View, die in Echtzeit Pattern-Matching durchfuehrt.

![Zugangsdaten-Expositionen](../images/credentialExposure.png)

### Dateimodifikations-Tracking

Jede Datei, die Claude bearbeitet, schreibt oder loescht, wird mit Aktionstyp, Dateiendung und Verzeichnis erfasst. Sieh, welche Dateien am haeufigsten geaendert werden, und erkenne unerwartete Loeschungen.

![Am haeufigsten geaenderte Dateien](../images/mostModifiedFiles.png)

### Erkennung blockierter Aktionen

Tool-Aufrufe, die abgelehnt oder abgebrochen wurden, werden automatisch erkannt, indem PreToolUse-Ereignisse verfolgt werden, die nie eine PostToolUse-Antwort erhalten haben. Nuetzlich fuer die Ueberpruefung, was Claude versucht hat, aber daran gehindert wurde.

### Tool-Latenz & Langsame URLs

Identifiziere Performance-Engpaesse — welche Tools bei p50/p95 am langsamsten sind und welche URLs am laengsten zum Abrufen brauchen.

![Tool-Latenz und langsame WebFetch-Aufrufe](../images/slowAgentAndWebFetch.png)

### 37 Dashboard-Panels

| Kategorie | Panels |
|-----------|--------|
| KPIs | Sessions, Ereignisse, Kosten/1K Tokens, Gesamt-Tokens, Kosten pro Benutzer |
| Kosten | Kosten im Zeitverlauf, teuerste Sessions/Prompts, Kosten pro aktiver Minute, Commits vs. Kosten |
| Tools | Tool-Nutzung, Modell-Nutzung, Akzeptieren/Ablehnen-Quoten, Cache-Trefferquote |
| Latenz | API-Latenz-Perzentile, Tool-Ausfuehrungslatenz, langsamste WebFetch-URLs |
| Zeitleiste | Vollstaendiger Session-Ereignisverlauf (Limit: 2000 Zeilen) |
| Workflow | Verwendete Skills, besuchte Websites, MCP-Server-Aufrufe, Subagent-Nutzung |
| Dateien | Am haeufigsten geaenderte Dateien mit Aktionsaufschluesselung |
| Code | Codezeilen pro Benutzer, Prompt-Laengenverteilung |
| Sicherheit | Blockierte Aktionen, Blockierungsrate im Zeitverlauf, Zugangsdaten-Expositionen |
| Betrieb | Konfigurationsaenderungen, Compaction-Ereignisse/-Haeufigkeit, aktuelle Fehler |
| Feedback | Umfrage-Trichter |

---

## Aktualisierung

```bash
cd Analytic_Claude
git pull
cd docker-stack
docker compose up -d --build
```

Additive Schema-Aenderungen (neue Tabellen, neue Materialized Views) werden beim Start des hooks-server automatisch angewendet. Wenn ein Release destruktive Schema-Aenderungen enthaelt (Spaltentyp-Aenderungen, Neu-Partitionierung), fuehre `/migrate-db` im Analytic_Claude-Projekt aus — es fuehrt dich durch eine sichere Side-by-Side-Migration mit Backup-Aufforderungen.

Fuehre anschliessend `/init-claude-analytics` in jedem Projekt erneut aus, um Hook-Skripte und Konfiguration zu aktualisieren, falls eine neue Version verfuegbar ist. Der Skill aktualisiert nur veraltete Teile — bereits aktuelle werden nicht veraendert.

---

## Teamnutzung

Dieses Projekt ist fuer einzelne Entwickler konzipiert. Um es fuer ein Team anzupassen:

1. **Auf einem gemeinsamen Server bereitstellen** — der Docker-Stack funktioniert auf jedem Server. Jeder Entwickler richtet seinen OTel-Endpunkt und die Hooks-URL auf die Serveradresse statt auf localhost
2. **Team-Attribut hinzufuegen** — `team.name` in `OTEL_RESOURCE_ATTRIBUTES` neben `project.name` einfuegen
3. **ClickHouse-Tabellen aktualisieren** — eine `team_name`-Spalte zu den Zieltabellen und Materialized Views hinzufuegen
4. **Grafana aktualisieren** — eine Team-Dropdown-Variable hinzufuegen und alle Panels danach filtern

**Bevor du den Stack auf einem Server bereitstellst, musst du ihn absichern:**

- ClickHouse-Passwort setzen (die Standardkonfiguration hat keine Authentifizierung)
- Grafana-Admin-Passwort aendern
- Port-Zugriff mit einer Firewall einschraenken — nur Ports 4317 (OTel gRPC), 4319 (hooks) und 3000 (Grafana) freigeben
- TLS fuer verschluesselte Uebertragung einrichten

Die Docker Compose-Datei funktioniert auf einem Cloud-Server ohne Aenderungen — aber ohne diese Sicherheitsmassnahmen sind deine Telemetriedaten fuer jeden zugaenglich, der die Ports erreichen kann.

---

<div align="center">

**Erstellt mit [Claude Code](https://claude.ai/code)**

Wenn dieses Projekt deinen Workflow verbessert, gib ihm einen Stern!

</div>
