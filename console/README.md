# DevTools console scraper

`fb_scrape_console.js` collects posts from whatever Facebook page you already
have open, using the tab's own session. No Playwright, no relaunch, no profile
copying, no debugging port.

## Quickstart

1. Open the page you want to scrape (home feed, search results, group, profile).
2. <kbd>Cmd</kbd>+<kbd>Opt</kbd>+<kbd>J</kbd> to open DevTools → **Console**.
3. Chrome blocks pasted code on the first use. Type `allow pasting` and press
   <kbd>Enter</kbd>.
4. Paste the whole of `fb_scrape_console.js` and press <kbd>Enter</kbd>. It only
   defines the API — nothing runs until you ask it to.

**Option A — the page is already scrolled, you just want the file:**

```js
fbScrape.dump()      // parses what is mounted and downloads the JSON
```

**Option B — let it scroll and collect:**

```js
fbScrape.run()       // logs: [fbScrape] round 004  +6  total 31  idle 0/8
```

5. Then merge it into the store and pull the images:

   ```bash
   python3 import_console_dump.py ~/Downloads/fb_posts_....json
   ```

   Fetching the images needs `playwright` (`pip install -r requirements.txt`) for
   its HTTP request client only — no browser, no Chrome profile. Without it,
   `--media none` still merges the posts and skips the files.

`dump()` writes the JSON only; call `fbScrape.saveCSV()` afterwards if you want the
spreadsheet version of the same data.

## Already scrolled the page yourself?

Use `fbScrape.dump()`. It parses the DOM as it stands, no scrolling, and downloads
the JSON.

**But check the number it prints first.** Facebook unmounts posts that are far
off-screen, so the DOM usually holds a window of posts — often 15–40 — not
everything you passed on the way down. `dump()` logs:

```
[fbScrape] dump: 24 in the DOM, 24 new, 24 collected in total
```

If that is fewer than you expected, the rest is no longer in the page and cannot be
read; use `fbScrape.run()` so posts are captured while they are still mounted.

## Console API

| call | does |
| --- | --- |
| `fbScrape.run(opts)` | start (or resume) collecting; merges into the same list |
| `fbScrape.dump()` | one-shot: parse the DOM as-is, persist, download JSON |
| `fbScrape.stop()` | stop after the current round |
| `fbScrape.reset()` | clear the collection, dedupe set **and** the saved copy |
| `fbScrape.posts()` | the live array (`window.__fbPosts`) |
| `fbScrape.saveJSON()` / `saveCSV()` / `copyJSON()` | export |
| `fbScrape.persist()` | force a write to `localStorage` now |
| `fbScrape.restore()` | reload a saved collection after a reload/crash |
| `fbScrape.savedInfo()` | `{ count, savedAt, url }` or `null` |
| `fbScrape.clearSaved()` | drop the saved copy without touching memory |
| `fbScrape.extract()` | one-off parse of the current DOM, no scrolling |
| `fbScrape.ingest(batch)` | dedupe + stamp a batch (what `run()` uses internally) |
| `fbScrape.config` | default limits |

Tune a run:

```js
fbScrape.run({ maxPosts: 200, idleLimit: 5, delayMin: 2000, delayMax: 4000 })
```

Defaults: `maxPosts` 500, `maxScrolls` 300, `idleLimit` 8, delay 1.2–2.8 s.

## Scaling to hundreds of posts

The defaults already allow 500. For a longer run:

```js
fbScrape.run({ maxPosts: 1000, idleLimit: 15, delayMin: 2000, delayMax: 3500 })
```

- **`idleLimit` matters more than `maxPosts`.** Search results and slow feeds often
  go several scrolls with nothing new while the next batch loads; if a run stops
  early, raise this first.
- **`maxScrolls`** (default 300) is the backstop when each scroll only yields 1–2 posts.
  Raise it for tall pages: a 190,000 px search page needs ~200 rounds.
- **Slower is safer.** Stretch the delay for long sessions rather than hammering.
- **Keep the tab visible** — Chrome throttles timers in background tabs.

Two settings exist because feeds are virtualised:

| option | default | why |
| --- | --- | --- |
| `startFromTop` | `true` | rewinds first; posts only render when they pass through the viewport, so starting mid-page silently loses everything above |
| `stepRatio` | `0.9` | scrolls by one viewport per round — jumping to `scrollHeight` skips the posts in between and they never render |

Search results need one extra behaviour, which the extractor already handles: they
render posts as bare children of `div[role="feed"]` with **no `role="article"`**, so
`role="article"` alone finds only the first few. Children carrying a post message
node (`[data-ad-preview]` / `[data-ad-comet-preview]`) are picked up too.

## Driving it from the terminal

If you'd rather not paste, enable **View → Developer → Allow JavaScript from Apple
Events**, then Chrome will execute JS on your behalf:

```bash
osascript -e 'tell application "Google Chrome" to execute (active tab of front window) javascript "fbScrape.posts().length"'
```

That's how this repo's collection was actually run: load the snippet from disk with
`(read POSIX file ".../console/fb_scrape_console.js" as «class utf8»)`, start
`fbScrape.run(...)`, poll `fbScrape.posts().length`, then write
`JSON.stringify(fbScrape.posts())` straight to a file. Turn the setting back off
afterwards — while it is on, any script on the machine can drive that tab.

Progress is mirrored into `localStorage` between rounds (throttled to every 5 s), so
a reload or crash doesn't cost you the run:

```js
fbScrape.restore()    // after reloading the page, bring back what was collected
fbScrape.savedInfo()  // { count, savedAt, url }
```

The saved copy is capped at ~4 MB of JSON (roughly 1000–2000 posts depending on
text length). Beyond that the snippet warns once and points you at `saveJSON()`.

The practical ceiling is what the page will give you: a search eventually runs out
of matches and a feed tail stops loading, so the `idleLimit` stop is usually
Facebook's limit rather than the script's. Use `saveJSON()` + `import_console_dump.py`
and start another run if you need more.

## Why images are imported rather than downloaded here

The snippet runs in the page, so it *can* see the image URLs, but Chrome blocks
bulk automatic downloads from script without a permission prompt, and canvas
export depends on CORS headers from `scontent`. Instead the JSON is imported and
`import_console_dump.py` fetches the bytes with `fbstore.py`'s downloader.

FB's CDN links are signed and expire within days, so import the JSON the same
day. If you sit on it, expect `http 403` in `download_error`.

## Limits

- **Long posts stay clipped.** Facebook renders `… See more` and the body ends
  there; the snippet strips that marker so it doesn't pollute `text`, but it does
  not click it. Clicking every one would fight the scroll and is much slower.
- **If a run stops early**, watch for
  `[fbScrape] the page stopped scrolling`. That's Facebook ending the results, not
  a parse failure — scroll once by hand and call `fbScrape.run()` again to continue.
- **Reloading or navigating kills the loop.** The JavaScript context dies with the page.
  Progress is mirrored to `localStorage`, so `fbScrape.restore()` gets it back — but
  `saveJSON()` is still the only durable export.
- **No resume across browser restarts.** `localStorage` is per-origin and survives
  relaunches, so restore usually works — but treat the JSON dump as the source of truth.
- **Background tabs are throttled** by Chrome; keep the tab visible or the
  delays stretch out.
- **Re-pasting is safe.** The whole file is an IIFE, so you won't hit
  `Identifier ... has already been declared`.
- **DevTools Snippets** also work (Sources → Snippets): persist the file there
  for one-click re-runs. Snippets are classic scripts, so there's no top-level
  `await` — the IIFE shape already handles that.
