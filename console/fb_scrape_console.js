/* ============================================================================
 * fb_scrape_console.js — scrape a Facebook feed from the DevTools console.
 *
 * WHY THIS EXISTS
 *   Runs inside the tab you are already logged into, so there is no browser to
 *   relaunch, no profile to copy, and no CDP/protocol surface to fight. This is
 *   the canonical parser: `import_console_dump.py` only stores and downloads
 *   what this file collects.
 *
 * HOW TO USE
 *   1. Open the Facebook page you want (feed, search results, group, profile).
 *   2. Cmd-Opt-J to open DevTools -> Console.
 *   3. Chrome blocks pasted code the first time: type  allow pasting  <Enter>.
 *   4. Paste this whole file. It only defines the API — nothing runs yet.
 *
 *   Already scrolled, and just want the file?
 *        fbScrape.dump()      parses the posts currently in the DOM and downloads JSON
 *
 *   Need to scroll for more?
 *        fbScrape.run()       scrolls and collects, then:
 *        fbScrape.saveJSON()
 *        fbScrape.saveCSV()
 *
 *   5. Import the JSON into the Python tool for images:
 *        ./.venv/bin/python import_console_dump.py <file>.json
 *
 *   Stop early:   fbScrape.stop()
 *   Inspect:      window.__fbPosts
 *   Re-run:       fbScrape.run({ maxPosts: 200 })   (dedupes against this run)
 *   Start over:   fbScrape.reset()
 *
 *   NOTE: `dump()` only sees what is mounted. Facebook unmounts posts that are
 *   far off-screen, so after a long scroll the DOM may hold far fewer posts than
 *   you passed. dump() prints how many it found before saving. If that number is
 *   lower than expected, use run() instead — it collects as it scrolls.
 *
 * CAVEATS
 *   - Never reload or navigate the tab while it runs: the loop dies with the page.
 *   - Images are NOT downloaded here (Chrome blocks bulk automatic downloads).
 *     Signed CDN URLs expire in days, so import the JSON promptly and let
 *     import_console_dump.py fetch the bytes while they are still valid.
 *   - Chrome throttles timers in background tabs: keep the tab visible.
 * ==========================================================================*/

(() => {
  'use strict';

  const CFG = {
    maxPosts: 500,      // stop after this many collected posts
    maxScrolls: 300,    // hard cap on scroll rounds
    idleLimit: 8,       // stop after N rounds in a row with nothing new
    delayMin: 1200,     // ms between scrolls (lower bound)
    delayMax: 2800,     // ms between scrolls (upper bound)
    persist: true,      // mirror progress into localStorage between rounds
    startFromTop: true, // rewind before scrolling: virtualised feeds only render
                        // posts that pass through the viewport
    stepRatio: 0.9,     // scroll by this fraction of one viewport per round
    expand: true,       // click "See more" first, or long posts stay truncated
    expandWait: 900,    // ms to wait after expanding before reading
  };

  /* --------------------------------------------------------------------------
   * Which elements are post containers?
   * role="article" covers feeds, profiles and groups. Search results instead
   * render posts as bare children of the feed with NO article role, so those
   * are collected too (they still carry the message node).
   * ------------------------------------------------------------------------ */
  function postContainers() {
    const out = [];
    for (const a of document.querySelectorAll('div[role="article"]')) {
      // Comments are also role=article; keep only the outermost one per post.
      if (a.parentElement && a.parentElement.closest('div[role="article"]')) continue;
      out.push(a);
    }

    const feedEl = document.querySelector('div[role="feed"]');
    if (feedEl) {
      for (const child of feedEl.children) {
        if (child.querySelector('[role="article"]')) continue;      // handled above
        if (!child.querySelector('[data-ad-preview], [data-ad-comet-preview], h3 a, h4 a')) continue;
        // textContent, not innerText: innerText forces layout, and on a feed with
        // hundreds of placeholder children that made every round take seconds.
        if ((child.textContent || '').trim().length < 40) continue; // empty placeholder
        out.push(child);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * Extraction. The one and only parser — there is no second implementation
   * to keep in sync any more.
   * ------------------------------------------------------------------------ */
  function fbExtractPosts() {
    // FB sprinkles invisible characters (word joiner, combining grapheme joiner,
    // zero-width space) between letters to defeat scrapers. If they survive,
    // every string picks up junk that breaks search and comparisons.
    const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u3164\ufeff\uffa0]/g;
    // Keep newlines (post bodies are multi-paragraph) but drop the junk.
    const stripInvisible = (s) => (s || '').replace(INVISIBLE, '');
    const clean = (s) => stripInvisible(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    // FB clips long posts and appends an inline "… See more" inside the same text
    // node, so it survives the NOISE filter. After expanding, a trailing
    // "See less" appears instead. Drop either marker.
    const stripSeeMore = (t) => (t || '').replace(/\s*(?:\u2026+|\.{3,})?\s*see (?:more|less)\s*$/i, '').trim();

    const NOISE = /^(see more|see less|like|comment|share|reply|edited|all reactions:?|write a comment|top comments|most relevant|view more comments|view \d+ (more )?repl(y|ies)|hide|follow|join|suggested for you|sponsored|active now)$/i;
    const COUNTER = /^[\d.,\s]*\d[\d.,\s]*\s*[KMB]?\s*(comments?|shares?|reactions?|views?|replies)$/i;

    const numFrom = (raw) => {
      if (!raw) return null;
      const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
      if (!m) return null;
      let v = parseFloat(m[1]);
      const suf = (m[2] || '').toLowerCase();
      if (suf === 'k') v *= 1e3;
      else if (suf === 'm') v *= 1e6;
      else if (suf === 'b') v *= 1e9;
      return Math.round(v);
    };

    // Strip FB's tracking params but keep the ones that identify the post.
    const normalizeUrl = (href) => {
      if (!href) return null;
      try {
        const u = new URL(href, location.origin);
        const keep = ['story_fbid', 'id', 'fbid', 'v', 'set'];
        const q = new URLSearchParams();
        for (const k of keep) if (u.searchParams.has(k)) q.set(k, u.searchParams.get(k));
        const qs = q.toString();
        return u.origin + u.pathname + (qs ? '?' + qs : '');
      } catch (e) {
        return href;
      }
    };

    const posts = [];
    const containers = postContainers();

    for (const a of containers) {

      const posinset = a.getAttribute('aria-posinset');

      // Comments are nested role=article nodes. Everything below must read from
      // the post itself only, never from a comment or a nested share preview.
      const nested = Array.from(a.querySelectorAll('div[role="article"]'));
      const inNested = (el) => nested.some((n) => n.contains(el));
      const qs = (sel) => Array.from(a.querySelectorAll(sel)).filter((el) => !inNested(el));

      // ---------------- author ----------------
      let author = null;
      let authorUrl = null;
      const heads = [
        a.querySelector('h2 a[role="link"]'),
        a.querySelector('h3 a[role="link"]'),
        a.querySelector('h4 a[role="link"]'),
        a.querySelector('strong a[role="link"]'),
      ].filter(Boolean);

      if (!heads.length) {
        for (const l of qs('a[role="link"]')) {
          const h = l.getAttribute('href') || '';
          if (/\/(user|profile\.php|pages)\//.test(h) && clean(l.innerText)) {
            heads.push(l);
            break;
          }
        }
      }
      if (heads.length) {
        author = clean(heads[0].innerText) || null;
        const h = heads[0].getAttribute('href') || '';
        authorUrl = h ? normalizeUrl(h) : null;
      }

      // ---------------- body text ----------------
      let text = '';
      const msgEl = qs(
        'div[data-ad-comet-preview="message"], div[data-ad-preview="message"], div[data-ad-rendering-role="story_message"]'
      )[0];

      if (msgEl) {
        text = stripInvisible(msgEl.innerText || '').trim();
      } else {
        // Fallback: take the leaf text nodes, drop chrome (author line, counters,
        // button labels) and stitch the rest back together in DOM order.
        const all = qs('div[dir="auto"]');
        const leaves = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
        const lines = [];
        for (const el of leaves) {
          if (el.closest('a, [role="button"], [aria-hidden="true"]')) continue;
          const t = clean(el.innerText);
          if (!t || t.length > 20000) continue;
          if (NOISE.test(t) || COUNTER.test(t)) continue;
          if (lines[lines.length - 1] !== t) lines.push(t);
        }
        text = lines.join('\n');
      }
      text = stripSeeMore(text);

      // ---------------- permalink + timestamp ----------------
      const linkEl = qs(
        'a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"], a[href*="?fbid="], a[href*="/reel/"], a[href*="/videos/"]'
      )[0];
      const permalink = linkEl ? normalizeUrl(linkEl.getAttribute('href')) : null;

      let timeText = null;
      const TIME_RE = /(\d{1,2}:\d{2})|(yesterday|just now|about an hour|hrs?\b|mins?\b|hours? ago|minutes? ago|days? ago|weeks? ago|months? ago|years? ago)|(^\w{3,9} \d{1,2}(,? \d{4})?$)|(\d{4}-\d{2}-\d{2})/i;
      for (const el of qs('[aria-label]')) {
        const l = clean(el.getAttribute('aria-label'));
        if (!l || l.length > 90) continue;
        if (TIME_RE.test(l)) {
          timeText = l;
          break;
        }
      }
      if (!timeText && linkEl) {
        timeText = clean(linkEl.getAttribute('aria-label')) || clean(linkEl.innerText) || null;
      }

      // ---------------- media ----------------
      const media = [];
      const seenMedia = new Set();
      const pushMedia = (o) => {
        const key = o.type + '|' + (o.url || o.poster || '');
        if (!(o.url || o.poster) || seenMedia.has(key)) return;
        seenMedia.add(key);
        media.push(o);
      };

      for (const img of qs('img')) {
        const src = img.currentSrc || img.src || '';
        if (!/scontent|fbcdn/.test(src)) continue;
        // naturalWidth is 0 until a lazy image decodes, so fall back to the
        // declared width attribute before the (possibly unsized) layout box.
        const attrW = parseInt(img.getAttribute('width') || '0', 10) || 0;
        const w = img.naturalWidth || attrW || img.getBoundingClientRect().width || 0;
        if (w && w < 150) continue; // avatars, reaction icons
        pushMedia({ type: 'image', url: src, width: Math.round(w), alt: clean(img.getAttribute('alt')).slice(0, 300) });
      }
      for (const v of qs('video')) {
        pushMedia({
          type: 'video',
          url: v.currentSrc || v.src || '',
          poster: v.getAttribute('poster') || '',
          duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        });
      }

      // ---------------- engagement ----------------
      const bodyText = nested.reduce((acc, n) => acc.replace(n.innerText || '', ''), a.innerText || '');
      let reactionsSummary = null;
      for (const el of qs('[aria-label]')) {
        const l = clean(el.getAttribute('aria-label'));
        if (/reactions?/i.test(l) && l.length <= 120) {
          reactionsSummary = l;
          break;
        }
      }

      const cMatch = bodyText.match(/([\d.,]+\s*[KMB]?)\s+comments?/i);
      const sMatch = bodyText.match(/([\d.,]+\s*[KMB]?)\s+shares?/i);
      const rMatch = bodyText.match(/([\d.,]+\s*[KMB]?)\s+(?:reactions?|people)/i);

      posts.push({
        dom_index: posts.length,
        posinset: posinset ? parseInt(posinset, 10) : null,
        author: author,
        author_url: authorUrl,
        time_text: timeText,
        permalink: permalink,
        text: text,
        reactions: numFrom(rMatch && rMatch[1]) ?? numFrom(reactionsSummary),
        reactions_summary: reactionsSummary,
        comments: numFrom(cMatch && cMatch[1]),
        shares: numFrom(sMatch && sMatch[1]),
        media: media,
        is_ad: /(^|\n)\s*Sponsored\s*(\n|$)/i.test(bodyText) || !!a.querySelector('a[href*="/ads/"]'),
      });
    }

    return posts;
  }

  /* ---------------------------------------------------------------- state -- */
  const posts = [];          // accumulate across runs; same array identity
  const seen = new Set();    // dedupe keys
  let running = false;
  let stopFlag = false;

  const LS_KEY = 'fbScrape:v1';
  const LS_MAX = 4 * 1024 * 1024;   // localStorage gives ~5 MB per origin
  let lastPersist = 0;
  let persistWarned = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 32-bit FNV-1a. Only a within-session dedupe key: the importer recomputes
  // ids with compute_id() in fbstore.py, which keeps the canonical id.
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function computeId(p) {
    const m = /(\d{6,})/.exec(p.permalink || '');
    if (m) return 'fb_' + m[1];
    const first = (p.media && p.media[0]) || {};
    const basis = [p.author || '', (p.text || '').slice(0, 400), (first.url || first.poster || '').slice(0, 120)].join('|');
    return 'h_' + hash32(basis);
  }

  // Dedupe + stamp a batch into the collection. Returns how many were new.
  function ingest(batch) {
    let fresh = 0;
    for (const p of batch) {
      const id = computeId(p);
      if (seen.has(id)) continue;
      seen.add(id);
      p.id = id;
      p.collected_at = new Date().toISOString();
      posts.push(p);
      fresh++;
    }
    return fresh;
  }

  /* ----------------------------------------------------------- durability -- */
  // A 500-post run takes a while; if the tab reloads or crashes you lose the
  // in-memory array. Mirror it into localStorage between rounds so a reload is
  // recoverable. Throttled: serialising the whole array every round is wasteful.
  function persist(force = false) {
    const now = Date.now();
    if (!force && now - lastPersist < 5000) return false;
    try {
      const payload = JSON.stringify({ savedAt: new Date().toISOString(), url: location.href, posts });
      if (payload.length > LS_MAX) {
        if (!persistWarned) {
          persistWarned = true;
          console.warn('[fbScrape] collection outgrew localStorage — call saveJSON() now');
        }
        return false;
      }
      localStorage.setItem(LS_KEY, payload);
      lastPersist = now;
      return true;
    } catch (e) {
      if (!persistWarned) {
        persistWarned = true;
        console.warn('[fbScrape] could not persist (quota/private mode) — call saveJSON()', e);
      }
      return false;
    }
  }

  function savedInfo() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return { count: (data.posts || []).length, savedAt: data.savedAt, url: data.url };
    } catch (e) {
      return null;
    }
  }

  function restore() {
    const info = savedInfo();
    if (!info) {
      console.log('[fbScrape] nothing saved in localStorage');
      return 0;
    }
    if (info.url && info.url !== location.href) {
      console.warn(`[fbScrape] saved copy came from a different page: ${info.url}`);
    }
    try {
      const data = JSON.parse(localStorage.getItem(LS_KEY));
      return ingest(data.posts || []);
    } catch (e) {
      console.warn('[fbScrape] restore failed', e);
      return 0;
    }
  }

  function clearSaved() {
    try {
      localStorage.removeItem(LS_KEY);
      console.log('[fbScrape] saved copy cleared');
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------------- expand -- */
  // Facebook ships a CLIPPED body plus a "See more" button; the full text only
  // exists in the DOM after the click. Measured on a real post: 658 -> 1124
  // characters. Without this step every long post is silently truncated.
  const SEE_MORE_LABEL = /^(see more|vedi altro|leggi tutto|mostra altro|altro)$/i;

  async function expandPosts(waitMs = 900) {
    let clicked = 0;
    for (const c of postContainers()) {
      for (const el of c.querySelectorAll('[role="button"]')) {
        // textContent for the same reason as above: no layout, much faster.
        if (SEE_MORE_LABEL.test((el.textContent || '').trim())) {
          el.click();
          clicked++;
        }
      }
    }
    if (clicked) await sleep(waitMs); // let the expanded body render
    return clicked;
  }

  /* ---------------------------------------------------------------- files -- */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function saveJSON(name = 'fb_posts') {
    const blob = new Blob([JSON.stringify(posts, null, 2)], { type: 'application/json' });
    download(blob, `${name}_${stamp()}.json`);
    console.log(`[fbScrape] saved ${posts.length} posts -> ${name}_${stamp()}.json`);
    return posts.length;
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function saveCSV(name = 'fb_posts') {
    const cols = ['id', 'collected_at', 'author', 'author_url', 'time_text', 'permalink',
      'reactions', 'comments', 'shares', 'media_count', 'media_urls', 'is_ad', 'posinset', 'text'];
    const rows = [cols.join(',')];
    for (const p of posts) {
      const media = p.media || [];
      rows.push([
        p.id, p.collected_at, p.author, p.author_url, p.time_text, p.permalink,
        p.reactions, p.comments, p.shares, media.length,
        media.map((m) => m.url || m.poster || '').join(' | '),
        p.is_ad, p.posinset, p.text,
      ].map(csvCell).join(','));
    }
    // BOM so Excel reads the UTF-8 correctly.
    const blob = new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    download(blob, `${name}_${stamp()}.csv`);
    console.log(`[fbScrape] saved ${posts.length} rows -> ${name}_${stamp()}.csv`);
    return posts.length;
  }

  function copyJSON() {
    const s = JSON.stringify(posts, null, 2);
    if (typeof copy === 'function') {
      copy(s);
      console.log(`[fbScrape] ${posts.length} posts copied to clipboard`);
    } else {
      console.log(s);
    }
  }

  // One-shot: take whatever is mounted right now, no scrolling, and download it.
  // This is the "I already scrolled the page myself" path. It reports how many
  // posts it actually found, because Facebook unmounts off-screen posts and the
  // DOM may hold far fewer than you scrolled past.
  function dump(name = 'fb_posts') {
    // Expanding is what makes the difference between a clipped preview and the
    // actual post, so do it even in the one-shot path.
    return expandPosts().then(() => {
      const batch = fbExtractPosts();
      if (!batch.length) {
        console.warn('[fbScrape] no div[role="article"] on this page — nothing to dump');
        return 0;
      }
      const added = ingest(batch);
      persist(true);
      const total = saveJSON(name);
      console.log(
        `[fbScrape] dump: ${batch.length} in the DOM, ${added} new, ${posts.length} collected in total`
      );
      if (batch.length < 10) {
        console.warn(
          '[fbScrape] only a handful of posts were mounted. Facebook unmounts posts ' +
          'far off-screen, so use fbScrape.run() to collect while scrolling.'
        );
      }
      return total;
    });
  }

  /* -------------------------------------------------------------- scroller -- */
  // The scroll container is not always the document: on search results and some
  // feed surfaces an ancestor div owns the overflow. Walk up from the last post
  // and pick the first genuinely scrollable ancestor.
  function pickScroller(anchor) {
    let n = anchor;
    while (n && n !== document.body && n !== document.documentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 20) {
        return n;
      }
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Advance by roughly one viewport. Jumping straight to scrollHeight is wrong
  // on virtualised feeds: the posts in between never enter the viewport, so they
  // are never rendered and can never be read.
  function scrollDown(stepRatio = 0.9) {
    const arts = document.querySelectorAll('div[role="article"]');
    const anchor = arts.length ? arts[arts.length - 1] : null;
    const scroller = pickScroller(anchor);
    const before = scroller.scrollTop;
    const step = Math.max(300, Math.round(scroller.clientHeight * stepRatio));
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    scroller.scrollTop = Math.min(before + step, max);
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      window.scrollTo(0, scroller.scrollTop);
    }
    return scroller.scrollTop !== before;
  }

  function rewind() {
    const scroller = pickScroller(null);
    scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ run -- */
  async function run(opts = {}) {
    if (running) {
      console.warn('[fbScrape] already running — call fbScrape.stop() first');
      return posts;
    }

    const cfg = Object.assign({}, CFG, opts);
    running = true;
    stopFlag = false;
    const startedAt = Date.now();
    let idle = 0;
    let round = 0;
    let added = 0;
    let stuck = 0;

    console.log('%c[fbScrape] start', 'color:#0a0;font-weight:bold', cfg);

    // A hidden tab is a silent trap: Chrome pauses rendering and clamps timers,
    // so the virtualised feed never materialises the posts we scroll past.
    if (document.visibilityState === 'hidden') {
      console.warn(
        '[fbScrape] questa tab è nascosta: Chrome sospende il rendering e rallenta i ' +
        'timer, quindi il feed non carica nuovi post. Portala in primo piano.'
      );
    }

    try {
      if (cfg.startFromTop) {
        rewind();
        await sleep(800); // let the first screenful render
      }

      while (round < cfg.maxScrolls) {
        const expanded = cfg.expand ? await expandPosts(cfg.expandWait) : 0;

        const batch = fbExtractPosts();
        const fresh = ingest(batch);
        added += fresh;
        idle = fresh ? 0 : idle + 1;

        console.log(
          `[fbScrape] round ${String(round).padStart(3, '0')}  +${fresh}  ` +
          `total ${posts.length}  idle ${idle}/${cfg.idleLimit}` +
          (expanded ? `  (expanded ${expanded})` : '')
        );
        if (cfg.persist) persist();

        if (posts.length >= cfg.maxPosts) {
          console.log('[fbScrape] reached maxPosts');
          break;
        }
        if (stopFlag) break;

        round++;
        const moved = scrollDown(cfg.stepRatio);
        stuck = moved ? 0 : stuck + 1;

        if (!moved && idle >= 2) {
          console.log('[fbScrape] reached the bottom of the page — stopping');
          break;
        }
        if (document.visibilityState === 'hidden' && idle >= 3) {
          console.warn(
            '[fbScrape] tab nascosta e nessun post nuovo: mi fermo. ' +
            'Porta la tab in primo piano e rilancia.'
          );
          break;
        }
        if (idle >= cfg.idleLimit && stuck >= 2) {
          console.log(`[fbScrape] nothing new and no movement for ${idle} rounds — stopping`);
          break;
        }
        await sleep(cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin));
      }
    } finally {
      running = false;
      if (cfg.persist) persist(true);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(
        `%c[fbScrape] done — ${added} new, ${posts.length} total in ${secs}s`,
        'color:#0a0;font-weight:bold'
      );
      console.log('[fbScrape] next: fbScrape.saveJSON()  |  fbScrape.saveCSV()  |  window.__fbPosts');
    }

    return posts;
  }

  /* ----------------------------------------------------------------- api -- */
  window.fbScrape = {
    run,
    stop() {
      stopFlag = true;
      console.log('[fbScrape] stopping after the current round…');
    },
    reset(opts = {}) {
      if (running) {
        console.warn('[fbScrape] running — stop() first');
        return 0;
      }
      posts.length = 0;
      seen.clear();
      if (opts.wipeStorage !== false) clearSaved();
      console.log('[fbScrape] state cleared');
      return 0;
    },
    persist: () => persist(true),
    restore,
    clearSaved,
    savedInfo,
    extract: fbExtractPosts,     // one-off parse of the current DOM
    ingest,
    expand: expandPosts,         // click every "See more" on screen
    scroller: pickScroller,      // debug helper: which element owns the overflow
    posts: () => posts,
    saveJSON,
    saveCSV,
    copyJSON,
    dump,
    config: CFG,
  };
  window.__fbPosts = posts;      // survives a cleared console (same array)

  const saved = savedInfo();
  if (saved && saved.count) {
    console.log(
      `[fbScrape] ${saved.count} posts already saved from ${saved.savedAt} — fbScrape.restore() to reload them`
    );
  }

  // Nothing runs on paste. Acting on its own would scroll the page away from
  // wherever you left it, which is the opposite of what you want if you already
  // did the scrolling yourself.
  if (window.__FB_AUTORUN) {
    run();
  } else {
    console.log(
      '%c[fbScrape] ready',
      'color:#0a0;font-weight:bold',
      '— fbScrape.dump() saves what is already loaded, fbScrape.run() scrolls and collects'
    );
  }
})();
