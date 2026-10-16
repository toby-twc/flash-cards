# Flash Cards

A minimal, text-only flashcard app using the [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) scheduler ("Anki cards using FSRS online"). It runs fully client-side, with no backend and no build step, and works on desktop and mobile (iPhone) browsers.

## Features

- **Anki-style home screen**: a pill nav bar (Decks, Add, Browse, Stats, Sync) and a deck table with **New / Learn / Due** counts (blue / red / green when above 0, grey otherwise). Counts come from the real FSRS state and the daily limits.
- Click a deck to **study it straight away**. Each deck row has a gear menu (Rename, Options, Export, Delete) that appears on hover (always visible on touch devices).
- "Studied N cards in X seconds today" is tracked per local day.
- **Get Shared**, **Create Deck** and **Import File** buttons below the table.
- **Add** a card to a deck, **Browse** (search, edit, delete) all cards, simple **Stats**, and **Sync**, which exports/imports a JSON backup of all app data (data is stored on this device only).
- **Include option**: every card has an **Include** checkbox in **Browse**. It is **off by default** for new cards (Add, imports, Get Shared, card picking). Cards that are not included are skipped in study and are not counted in New / Learn / Due, daily limits, next intervals or Stats. Browse has "Include all shown" / "Exclude all shown", an All / Included / Not included filter, a deck filter and an "X of Y included" count; changes save immediately. Excluding keeps a card's FSRS progress, and re-including resumes it. Existing data without the flag is treated as included only if the card already has a schedule. The flag is part of deck exports and backups.
- Study always shows the **front first**, then **Show Answer** reveals the back, then Again / Hard / Good / Easy (FSRS default parameters, next-interval labels). Shortcuts: Space = show answer, 1-4 = Again/Hard/Good/Easy.
- There is **no direction choice** any more. Data saved by older versions still loads: `cardId|f` schedules are used, `cardId|r` (reverse) entries are ignored and kept untouched.
- Anki-like defaults: 20 new cards/day, 200 reviews/day (deck Options). Day rollover at **local midnight** of the device.
- Light/dark mode toggle (top-right corner). Works on desktop and iPhone.

## Get Shared (provided decks)

Press **Get Shared** on the home screen (or choose a provided deck from **Create Deck**) to see the decks listed in `decks/index.json`. Pick one, tick the cards you want (search, select all/none), edit the deck name and confirm. No file upload is needed.

To add a provided deck, drop a CSV (header row, `front` and `back` columns) into `decks/` and list it in `decks/index.json`:

```json
[{"name": "My deck", "file": "my-deck.csv", "description": "Short description"}]
```

Paths are relative, so this works on GitHub Pages and on a local server. Opening `index.html` via `file://` cannot load them; the app shows a message explaining that it must be served over http(s).

**Import File** (CSV / Excel / Anki `.apkg`) remains available as a secondary option.

## Testing locally

The app uses `fetch`, so serve it over http. From the folder containing `index.html` (Windows PowerShell or any OS):

```
py -m http.server 8000
```

or `python -m http.server 8000`, or `npx serve .`, then open http://localhost:8000. (`python3` may not work on Windows.) Opening the file directly (`file://`) will not work for provided decks.

## Hosting on GitHub Pages

Either Settings → Pages → "Deploy from a branch" (`main`, `/ (root)`), or Source "GitHub Actions": `.github/workflows/pages.yml` deploys the repository root on every push to `main`. Paths are relative, so it works under `https://<user>.github.io/<repo>/`. Browser storage is tied to the site URL; if the URL changes, progress does not follow (Export first).

## Import formats

| Format | Notes |
| --- | --- |
| CSV / TSV | **Header row required.** Uses columns named `front` and `back` (case-insensitive), otherwise the first two columns. Delimiter (`,` `;` or tab) detected from the header. UTF-8. |
| Excel | **Header row required.** First sheet only; same column rules as CSV. |
| Anki `.apkg` | Only the first two note fields become front/back; HTML is stripped. Scheduling/history is **not** imported. Media, cloze and extra fields are ignored. The newest zstd-compressed format (`collection.anki21b`) is unsupported: export with "Support older Anki versions" ticked. |
| Provided decks | CSV files in `decks/`, listed in `decks/index.json` (`[{"name", "file", "description"}]`). |

Cards get an ID derived from their front+back text; cards already in a deck are not added twice.

## Third-party libraries (`libs/`, vendored for static hosting)

ts-fsrs 5.4.2 (FSRS), SheetJS `xlsx` 0.18.5 (mini build), JSZip and sql.js (SQLite WASM, for `.apkg`). Files are parsed in your browser and never uploaded.

## Status

Implemented: everything above. Deferred: Anki scheduling/history import, media/cloze, FSRS parameter optimisation, re-importing single-deck exported JSON, sync, offline service worker.
