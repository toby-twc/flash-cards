# Flash Cards

A minimal, text-only flashcard app using the [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) scheduler ("Anki cards using FSRS online"). It runs fully client-side, with no backend and no build step, and works on desktop and mobile (iPhone) browsers.

## Features

- Multiple decks, each with generic **Front / Back** text cards.
- Import from **CSV**, **Excel** (`.xlsx`/`.xls`), **Anki** `.apkg` (text only) or the **provided decks** in `decks/`.
- Checkbox selection screen (search, select all/none) before cards are added to a deck.
- Study direction chosen when you open a deck: front→back, back→front or both. Each direction has its **own independent FSRS schedule** (stored under `cardId|f` and `cardId|r`).
- Again / Hard / Good / Easy buttons, FSRS default parameters.
- Anki-like defaults: 20 new cards/day, 200 reviews/day (changeable in deck settings).
- Day rollover at **local midnight** of the device (not server time).
- All data is stored in the browser's `localStorage` on that device. There is no sync.
- **Export** button in deck settings: downloads JSON with cards, settings and schedule/progress.
- Light/dark mode toggle.

## Running locally

Use any static file server (the app uses `fetch`, so don't open `index.html` via `file://`):

```
python3 -m http.server 8000
```

then open http://localhost:8000.

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

Implemented: everything above. Deferred: Anki scheduling/history import, media/cloze, FSRS parameter optimisation, re-importing exported JSON, editing individual cards, sync, offline service worker.
