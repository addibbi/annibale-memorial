#!/usr/bin/env python3
"""Import a JSON dump produced by console/fb_scrape_console.js.

The console snippet collects posts inside your logged-in tab but cannot write
image files (Chrome blocks bulk automatic downloads). This importer merges the
dump into data/posts.jsonl and then reuses the tested downloader to fetch the
images while the signed CDN URLs are still fresh.

Usage:
    python3 import_console_dump.py ~/Downloads/fb_posts_2026-10-24T....json
    python3 import_console_dump.py dump.json --media none
    python3 import_console_dump.py dump.json --media all

`--media none` needs nothing beyond Python 3.10+. Downloading images needs
`playwright` for its HTTP request client (see requirements.txt) — but no
browser and no Chrome profile.

Ids are recomputed with compute_id() from fbstore.py, so a re-import of the same
posts merges into the store without duplicates.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fbstore as fbs


def load_dump(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"no such file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path.name} is not valid JSON: {exc}") from exc

    # Tolerate {posts: [...]} as well as a bare array.
    if isinstance(data, dict):
        data = data.get("posts", [])
    if not isinstance(data, list):
        raise SystemExit("expected a JSON array of posts (or {posts: [...]})")

    posts = [p for p in data if isinstance(p, dict)]
    if not posts:
        raise SystemExit("the dump contains no post objects")
    return posts


def normalise(posts: list[dict]) -> list[dict]:
    """Recompute ids and fill required fields so the rows match the tool's schema."""
    out: list[dict] = []
    for raw in posts:
        post = dict(raw)
        post["id"] = fbs.compute_id(post)
        post.setdefault("collected_at", fbs.now_iso())
        if not isinstance(post.get("media"), list):
            post["media"] = []
        out.append(post)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Merge a DevTools-console dump into posts.jsonl.")
    ap.add_argument("dump", type=Path, help="JSON file downloaded by fbScrape.saveJSON()")
    ap.add_argument(
        "--jsonl",
        type=Path,
        default=fbs.JSONL_PATH,
        help=f"target store (default: {fbs.JSONL_PATH})",
    )
    ap.add_argument(
        "--media",
        choices=["none", "images", "all"],
        default="images",
        help="download images for the imported posts (default: images)",
    )
    ap.add_argument("--media-timeout", type=int, default=30000, help="per-file download timeout in ms")
    ap.add_argument("--max-media-mb", type=int, default=50, help="skip individual files larger than this")
    args = ap.parse_args(argv)

    target: Path = args.jsonl.expanduser()

    rows = normalise(load_dump(args.dump.expanduser()))
    existing = fbs.load_seen(target)
    fresh = [r for r in rows if r["id"] not in existing]

    print(f"dump      : {len(rows)} posts")
    print(f"in store  : {len(existing)} already")
    print(f"new       : {len(fresh)}")

    if not fresh:
        print("nothing to import")
    else:
        fbs.append_jsonl(target, fresh)

    csv_path = target.with_suffix(".csv")
    written = fbs.export_csv(target, csv_path)
    print(f"jsonl     : {target}  ({written} rows)")
    print(f"csv       : {csv_path}")

    if args.media == "none" or not fresh:
        return 0

    with_media = sum(1 for r in fresh if r.get("media"))
    if not with_media:
        print("media     : none of the new posts carry media")
        return 0

    # Playwright's request client needs no browser; it gives us the same .get()
    # surface the downloader already uses.
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit(
            "Downloading the images needs playwright (no browser involved):\n"
            "  python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt\n"
            "or import the posts only with --media none."
        )

    with sync_playwright() as pw:
        http = pw.request.new_context(
            extra_http_headers={"Referer": "https://www.facebook.com/"}
        )
        try:
            fbs.backfill_media(http, args, target)  # type: ignore[arg-type]
        finally:
            http.dispose()

    print(f"media dir : {fbs.MEDIA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
