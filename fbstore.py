#!/usr/bin/env python3
"""Store + media helpers for the DevTools-console workflow.

The console scraper (`console/fb_scrape_console.js`) collects posts inside your
logged-in tab but cannot write image files, because Chrome blocks bulk automatic
downloads. `import_console_dump.py` therefore merges the dump into
`data/posts.jsonl` and fetches the images while the signed CDN URLs still work.

Everything here is plain standard library — no browser, no profile, no CDP.
Saving the images also needs `playwright`, but only its HTTP request client
(never a browser), so `pip install playwright` is enough; `playwright install`
is not required.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
JSONL_PATH = DATA_DIR / "posts.jsonl"
CSV_PATH = DATA_DIR / "posts.csv"
MEDIA_DIR = DATA_DIR / "media"

MEDIA_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}
URL_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".mp4", ".webm", ".mov"}


# --------------------------------------------------------------------------- #
# identity
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def compute_id(post: dict) -> str:
    """Stable identity: the numeric post id when we have a permalink, else a hash."""
    m = re.search(r"(\d{6,})", post.get("permalink") or "")
    if m:
        return "fb_" + m.group(1)
    first_media = (post.get("media") or [{}])[0]
    basis = "|".join(
        [
            post.get("author") or "",
            (post.get("text") or "")[:400],
            (first_media.get("url") or first_media.get("poster") or "")[:120],
        ]
    )
    return "h_" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# media
# --------------------------------------------------------------------------- #
def guess_ext(url: str, content_type: str) -> str:
    """Pick a file extension from the response type, falling back to the URL path."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in MEDIA_EXT:
        return MEDIA_EXT[ct]
    suffix = Path(urlsplit(url).path).suffix.lower()
    if suffix in URL_SUFFIXES:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".bin"


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def download_post_media(
    http, post: dict, which: str, timeout_ms: int, max_bytes: int
) -> tuple[int, int]:
    """Save one post's media under data/media/<post id>/ and annotate each item.

    `http` is anything with a Playwright-style .get(url, timeout=, headers=) —
    the standalone request client the importer opens is enough.

    Returns (files_written, bytes_written). Problems are recorded per item as
    `download_error` so one dead CDN link never costs us the post itself.

    Files are named from a hash of the URL rather than the original name, which
    makes re-runs idempotent: an already-downloaded file is skipped, not
    re-fetched or duplicated.
    """
    files = 0
    written = 0
    media = post.get("media") or []
    if which == "none" or not media:
        return files, written

    dest = MEDIA_DIR / str(post.get("id") or "unknown")

    for idx, item in enumerate(media, 1):
        kind = item.get("type")
        if kind not in ("image", "video"):
            continue
        if kind == "video" and which != "all":
            continue  # feed videos are usually blob:/DASH, not fetchable

        url = item.get("url") or ""
        if not url.startswith(("http://", "https://")):
            item.setdefault("download_error", "no direct url (blob or stream)")
            continue

        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
        ext = guess_ext(url, "")
        path = dest / f"{idx:02d}_{digest}{ext}"

        if path.exists() and path.stat().st_size > 0:
            item["local_path"] = _rel(path)
            item.setdefault("bytes", path.stat().st_size)
            continue

        try:
            resp = http.get(
                url, timeout=timeout_ms, headers={"Referer": "https://www.facebook.com/"}
            )
        except Exception as exc:  # network/DNS/timeout
            item["download_error"] = f"request failed ({type(exc).__name__})"
            continue

        if not resp.ok:
            item["download_error"] = f"http {resp.status}"
            continue

        ctype = resp.headers.get("content-type", "")
        if ctype and not ctype.startswith(("image/", "video/", "application/octet-stream")):
            item["download_error"] = f"unexpected content-type: {ctype[:60]}"
            continue

        body = resp.body()
        if not body:
            item["download_error"] = "empty response"
            continue
        if len(body) > max_bytes:
            item["download_error"] = f"too large ({len(body) // 1024} KB)"
            continue

        if ext == ".bin":  # no usable suffix in the URL; trust the response
            ext = guess_ext(url, ctype)
            path = dest / f"{idx:02d}_{digest}{ext}"

        dest.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        item["local_path"] = _rel(path)
        item["bytes"] = len(body)
        files += 1
        written += len(body)

    return files, written


def row_needs_media(row: dict, which: str) -> bool:
    """True when a stored post still has a fetchable item we haven't saved."""
    for item in row.get("media") or []:
        kind = item.get("type")
        if kind not in ("image", "video"):
            continue
        if kind == "video" and which != "all":
            continue
        if item.get("local_path") or item.get("download_error"):
            continue
        if (item.get("url") or "").startswith(("http://", "https://")):
            return True
    return False


def backfill_media(http, args: argparse.Namespace, jsonl_path: Path | None = None) -> None:
    """Download media for posts already in posts.jsonl (rows are rewritten in place).

    Items that previously failed are skipped, so a permanently dead blob: URL
    isn't retried on every run.
    """
    path = jsonl_path or JSONL_PATH
    if not path.exists():
        print(f"backfill: no {path.name} yet, nothing to do")
        return

    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    todo = [r for r in rows if r.get("id") and row_needs_media(r, args.media)]
    if not todo:
        print("backfill: every stored post already has its media")
        return

    print(f"backfill: fetching media for {len(todo)} posts")
    files = 0
    size = 0
    max_bytes = args.max_media_mb * 1024 * 1024
    for n, row in enumerate(todo, 1):
        f, b = download_post_media(http, row, args.media, args.media_timeout, max_bytes)
        files += f
        size += b
        if n % 25 == 0:
            print(f"  {n}/{len(todo)} posts...")

    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        fh.flush()
    tmp.replace(path)
    print(f"backfill: saved {files} files ({size / 1048576:.1f} MB)")


# --------------------------------------------------------------------------- #
# store
# --------------------------------------------------------------------------- #
def load_seen(path: Path) -> set[str]:
    seen: set[str] = set()
    if not path.exists():
        return seen
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                seen.add(json.loads(line)["id"])
            except (json.JSONDecodeError, KeyError):
                continue
    return seen


def append_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        fh.flush()


def export_csv(jsonl_path: Path, csv_path: Path) -> int:
    if not jsonl_path.exists():
        return 0
    rows = []
    with jsonl_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not rows:
        return 0

    cols = [
        "id", "collected_at", "author", "author_url", "time_text", "permalink",
        "reactions", "comments", "shares", "media_count", "media_local", "media_urls",
        "is_ad", "posinset", "shared_author", "text", "shared_text",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            media = r.get("media") or []
            w.writerow(
                {
                    **r,
                    "media_count": len(media),
                    "media_local": " | ".join(m.get("local_path") or "" for m in media),
                    "media_urls": " | ".join(m.get("url") or m.get("poster") or "" for m in media),
                }
            )
    return len(rows)
