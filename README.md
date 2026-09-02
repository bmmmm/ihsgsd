# EDEKA Wochenangebote

Wöchentliche Supermarkt-Angebote durchsuchen, filtern und visualisieren.

**[Zur Seite](https://bmmmm.github.io/ihsgsd/)**

Eine statische Seite ohne Build-Schritt und ohne Abhängigkeiten: reines
HTML/CSS/JS, direkt aus `main` über GitHub Pages ausgeliefert. Die Angebote
werden wöchentlich per GitHub Actions abgeholt und als JSON-Schnappschüsse ins
Repo committet, das Archiv reicht über 88 Wochen.

## Die drei Ansichten

| Seite | Was sie zeigt |
|---|---|
| [`table.html`](https://bmmmm.github.io/ihsgsd/table.html) | Die Angebotstabelle — Suche, Filter, Grundpreis-Vergleich, Preisverlauf pro Produkt |
| [`dashboard.html`](https://bmmmm.github.io/ihsgsd/dashboard.html) | Auswertung — Kategorieverteilung, KPIs pro Woche, Grundpreis-Zeitreihen |
| [`prospekt.html`](https://bmmmm.github.io/ihsgsd/prospekt.html) | Kuratierter Prospekt — Wochenplan, Einkaufsliste, Interessens-Chips, Votes |

Persönliche Einstellungen (Interessen, Votes, Einkaufsliste) liegen im
`localStorage` des Browsers und verlassen das Gerät nicht.

## Lokal laufen lassen

```bash
python3 -m http.server 8888      # nur statisch
python3 scripts/serve.py         # zusätzlich die POST-Endpunkte für
                                 # Einstellungen, Einkaufsliste, Wochenplan
```

## Daten

`data/{Jahr}/KW{XX}/{Datum}.json` — ein Schnappschuss pro Woche, indiziert über
`data/folder-structure.json`. Ein Schnappschuss wird unter der Woche abgelegt, in
der die Angebote **beginnen** (EDEKAs eigenes `validFrom`), nicht unter dem
Datum des Abrufs. Deshalb ist ein zu früher Lauf harmlos: er landet entweder in
der nächsten Woche oder schreibt gar nichts.

EDEKA ist die einzige Quelle mit Oberfläche. Zwei weitere sammeln nur:
`data-aldi/` (direkte ALDI-API) und `data-kaufda/{Händler}/` (REWE, Lidl, ALDI
über kaufda). Jede hat ihren eigenen Fetcher unter `scripts/` und ihren eigenen
Workflow.

`data/prospekt.json`, `data/mealplan.json` und `data/insights.json` sind
optionale, per Modell erzeugte Redaktion. Die Seiten rendern additiv — eine
fehlende oder veraltete Datei bricht nichts, sie blendet den Block nur aus.

## Skripte

| Skript | Zweck |
|---|---|
| `scripts/fetch_aldi.py`, `scripts/fetch_kaufda.py` | Abruf der Zusatzquellen |
| `scripts/build_indexes.py` | Baut die drei Indexdateien, die die Seiten statt der ~17 MB Wochendaten laden |
| `scripts/generate_prospekt.py`, `generate_mealplan.py`, `generate_insights.py` | Erzeugen die redaktionellen Dateien. Laufen von Hand, nie in CI |
| `scripts/audit_data.py` | Datenqualität über alle Archive; ein Exit ≠ 0 heißt: etwas Neues und Behebbares |
| `scripts/test_parity.py` | Der Paritätstest (siehe unten) |

Die Generatoren rufen zuerst die `claude`-CLI und fallen, wenn die fehlt oder
scheitert, auf eine **lokale** OpenAI-kompatible Engine zurück. Der Fallback ist
mit Absicht lokal: Diät-Vetos werden angewandt, *bevor* der Digest gebaut wird,
die überlebende Auswahl verrät also die Ernährungsweise der lesenden Person auch
ohne den Präferenzblock — die Auswahl *ist* das Profil.

## Vor Änderungen

Die geteilte Logik — Grundpreis-Herleitung, Diät-Erkenner, die
Bier-/Spezi-/Vegan-Tests — existiert **doppelt**, in JavaScript und in Python.
Sie kann lautlos auseinanderlaufen: ein Produktschlüssel, der um ein Zeichen
abweicht, liefert einfach keine Historie mehr. Deshalb:

```bash
python3 scripts/test_parity.py   # voller Lauf, nie --quick
```

`.github/workflows/checks.yml` fährt diesen und die übrigen Gates bei jedem Push,
jedem Pull Request und nach jedem Daten-Commit der Fetch-Workflows.

Mehr Kontext steht in [`CLAUDE.md`](CLAUDE.md); die Begründung einer einzelnen
Regel steht jeweils als Kommentar an dem Code, den sie betrifft.

## Lizenz

[GPL-3.0-or-later](LICENSE).
