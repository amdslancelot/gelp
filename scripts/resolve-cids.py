#!/usr/bin/env python3
"""Resolve Takeout place URLs to exact coordinates with a headless browser.

Why this exists
---------------
A Takeout list CSV identifies each place unambiguously — the `!1s0x<cell>:0x<cid>`
in its URL is that place's feature id — but it carries no coordinates, and
Google publishes no supported way to turn one into the other. The import
pipeline therefore guesses, by searching for the title and checking the answer
is geographically plausible. That is right most of the time and wrong some of
the time.

This script is the exact alternative: open each place's own Maps URL in a real
browser and read the position out of the URL the page settles on. It is 100%
accurate because it never searches for anything — it opens the place itself.

Read this before running it
---------------------------
This is not an API. It drives a browser against Google Maps, which is scraping,
and Google's Terms of Service do not permit automated access to Maps. It is
also fragile: it depends on the page rewriting its own URL to `/@lat,lng`, which
Google can change without notice.

It is written to be defensible on the one axis that matters — it reads only
*your own* saved places, one at a time, slowly, with no attempt to look like
anything other than what it is. Run it on your own machine, on your own export,
and do not build anything that depends on it staying working.

Usage
-----
    python3 scripts/resolve-cids.py --takeout ~/Downloads/Takeout/Saved
    python3 scripts/resolve-cids.py --limit 20 --headful     # trial run, visible

Output
------
`data/place-coords.jsonl` — one JSON object per line:

    {"key": "<the place's Maps URL>", "title": "...", "lat": 35.003158,
     "lng": 135.770634, "source": "browser", "resolved_at": 1753900000000}

JSON Lines rather than CSV or a database, for three reasons that all matter
here: it is append-only, so the run is crash-safe and resumable — stop it with
Ctrl-C and rerun the same command and it picks up where it left off; a record
can carry an `error` field instead of coordinates without a schema change; and
a URL containing a comma needs no quoting rules, which is the exact bug that
loses coordinates out of Google's own CSV export.

`key` is the place's Maps URL, which is also the `place_cache` primary key, so
the file is a direct seed for that table — see `scripts/load-resolved.ts`.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import time
from pathlib import Path

# The place's own position, as Google writes it into the settled URL. `!3d/!4d`
# is the place; `@lat,lng` is the map viewport, which is centred on the place
# but rounded. Prefer the former and fall back to the latter.
PLACE_RE = re.compile(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)")
VIEWPORT_RE = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")

# A URL that already names its position needs no browser at all.
PINNED_RE = re.compile(r"/maps/(?:search|place|dir)/(-?\d+\.\d+),(-?\d+\.\d+)")

# A URL with no feature id and no coordinates cannot be resolved this way.
FEATURE_RE = re.compile(r"!1s0x[0-9a-f]+:0x[0-9a-f]+", re.I)


def read_urls(takeout: Path) -> list[tuple[str, str]]:
    """Every distinct (url, title) in the export, in a stable order."""
    seen: dict[str, str] = {}
    for path in sorted(takeout.glob("*.csv")):
        with path.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                url = (row.get("URL") or "").strip()
                title = (row.get("Title") or "").strip()
                if url and title and url not in seen:
                    seen[url] = title
    return list(seen.items())


def load_done(out: Path) -> set[str]:
    """Keys already written, so a restart resumes rather than repeats."""
    if not out.exists():
        return set()
    done: set[str] = set()
    with out.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["key"])
            except (ValueError, KeyError):
                continue  # A half-written last line from an interrupted run.
    return done


def coords_from(url: str) -> tuple[float, float] | None:
    for pattern in (PLACE_RE, VIEWPORT_RE, PINNED_RE):
        m = pattern.search(url)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if abs(lat) <= 90 and abs(lng) <= 180 and (lat or lng):
                return lat, lng
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--takeout", default="~/Downloads/Takeout/Saved")
    ap.add_argument("--out", default="data/place-coords.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="stop after N lookups")
    ap.add_argument(
        "--delay",
        type=float,
        default=2.0,
        help="seconds between lookups (jittered). Lower is faster and ruder.",
    )
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--headful", action="store_true", help="show the browser")
    args = ap.parse_args()

    takeout = Path(os.path.expanduser(args.takeout))
    if not takeout.is_dir():
        print(f"no such directory: {takeout}", file=sys.stderr)
        return 1

    out = Path(os.path.expanduser(args.out))
    out.parent.mkdir(parents=True, exist_ok=True)
    entries = read_urls(takeout)
    done = load_done(out)

    # Anything whose URL already names its position is written straight out;
    # only what actually needs a browser gets one.
    todo: list[tuple[str, str]] = []
    free = 0
    with out.open("a", encoding="utf-8") as fh:
        for url, title in entries:
            if url in done:
                continue
            pinned = PINNED_RE.search(url)
            if pinned:
                fh.write(
                    json.dumps(
                        {
                            "key": url,
                            "title": title,
                            "lat": float(pinned.group(1)),
                            "lng": float(pinned.group(2)),
                            "source": "url",
                            "resolved_at": int(time.time() * 1000),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                free += 1
                continue
            if not FEATURE_RE.search(url):
                fh.write(
                    json.dumps(
                        {"key": url, "title": title, "error": "no feature id"},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                continue
            todo.append((url, title))

    print(f"{len(entries)} distinct places, {len(done)} already done")
    print(f"{free} resolved from the URL itself, {len(todo)} need a browser")
    if args.limit and args.limit < len(todo):
        print(f"--limit {args.limit}: doing {args.limit} of them this run")
        todo = todo[: args.limit]
    if not todo:
        return 0
    print(f"at {args.delay}s apart this takes about {len(todo) * args.delay / 60:.0f} min\n")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "playwright is not installed:\n"
            "  pip install playwright && playwright install chromium",
            file=sys.stderr,
        )
        return 1

    ok = failed = 0
    with sync_playwright() as pw, out.open("a", encoding="utf-8") as fh:
        browser = pw.chromium.launch(headless=not args.headful)
        page = browser.new_page()
        try:
            for i, (url, title) in enumerate(todo, 1):
                record = {"key": url, "title": title}
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=args.timeout * 1000)
                    # The page rewrites its own URL to include the position once
                    # it has resolved the feature id. Poll for that rather than
                    # scraping the DOM, which changes far more often.
                    deadline = time.monotonic() + args.timeout
                    found = None
                    while time.monotonic() < deadline:
                        found = coords_from(page.url)
                        if found:
                            break
                        page.wait_for_timeout(400)

                    if found:
                        record["lat"], record["lng"] = found
                        record["source"] = "browser"
                        record["resolved_at"] = int(time.time() * 1000)
                        ok += 1
                        status = f"{found[0]:.6f},{found[1]:.6f}"
                    else:
                        # A consent wall or a place Google no longer has. Both
                        # look the same from here; the URL is worth keeping so
                        # a later run can retry it.
                        record["error"] = "no coordinates in settled URL"
                        failed += 1
                        status = "FAILED"
                except Exception as err:  # noqa: BLE001 - one bad place must not stop the run
                    record["error"] = f"{type(err).__name__}: {err}"
                    failed += 1
                    status = "ERROR"

                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                fh.flush()  # Crash-safe: the file is always a valid resume point.
                print(f"[{i}/{len(todo)}] {status}  {title[:50]}")

                if i < len(todo):
                    time.sleep(args.delay * random.uniform(0.7, 1.3))
        except KeyboardInterrupt:
            print("\ninterrupted — rerun the same command to resume")
        finally:
            browser.close()

    print(f"\nresolved {ok}, failed {failed} -> {out}")
    if failed:
        print("rerunning will NOT retry failures; delete their lines from the")
        print("file first, or filter it: grep -v '\"error\"' file > kept.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
