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
from urllib.parse import unquote

# The place's own position, as Google writes it into the settled URL.
#
# `@lat,lng` also appears there and is tempting, but it is the map *viewport*,
# not the place. When a page resolves, the viewport is centred on the place and
# the two agree to within rounding; when it does not — the id is dead, the load
# timed out, a consent wall appeared — the viewport is wherever the map opened
# by default, which is near whoever is running this. Reading it then produces a
# confident coordinate for a place the browser never actually found.
#
# That is not a hypothetical: an earlier run of this script resolved 110 places
# to a single point, identical to seven decimal places, a few miles from this
# laptop. Angkor Thom came back in San Jose. So only `!3d/!4d` counts, and a
# page that does not produce it is reported as a failure — which is recoverable,
# where a plausible wrong answer written into an authoritative table is not.
PLACE_RE = re.compile(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)")

# A URL that already names its position needs no browser at all.
PINNED_RE = re.compile(r"/maps/(?:search|place|dir)/(-?\d+\.\d+),(-?\d+\.\d+)")

# A URL with no feature id and no coordinates cannot be resolved this way.
FEATURE_RE = re.compile(r"!1s0x[0-9a-f]+:0x[0-9a-f]+", re.I)


def read_queue(path: Path) -> list[tuple[str, str]]:
    """Every (url, title) in a work list written by `dump-queue.ts`."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            url = (row.get("key") or "").strip()
            if url and url not in seen:
                seen.add(url)
                out.append((url, (row.get("title") or "").strip()))
    return out


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
    for pattern in (PLACE_RE, PINNED_RE):
        m = pattern.search(url)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if abs(lat) <= 90 and abs(lng) <= 180 and (lat or lng):
                return lat, lng
    return None


# The name Google settled on, out of the URL rather than the page: a resolved
# place page is `/maps/place/<name>/@…`. Kept to the same standard as the
# coordinates — read from the address bar, which changes far less often than
# the document — so it can be trusted as a check that the right page loaded.
NAME_RE = re.compile(r"/maps/place/([^/@]+)/")


def name_from(url: str) -> str | None:
    m = NAME_RE.search(url)
    if not m:
        return None
    name = unquote(m.group(1).replace("+", " ")).strip()
    return name or None


# The address and the category are not in the URL, so these are the one place
# this script reads the document. Both are best-effort by design: the position
# is the job, and a page that has rearranged itself should cost us an address,
# never a coordinate and never a wrong answer.
#
# `data-item-id` is a semantic attribute Google puts on the address row, which
# makes it the sturdiest handle available. The category button has no such
# attribute and is matched on its `jsaction`, which is frankly fragile — if it
# starts coming back empty, that is the reason.
def details_from(page) -> tuple[str | None, str | None]:
    address = None
    category = None
    # The URL gains its coordinates before the panel finishes rendering, so the
    # caller arrives here early. Wait for the address row specifically rather
    # than sleeping a fixed amount: pages that are ready cost nothing, and one
    # that never renders it costs the timeout once instead of on every place.
    try:
        page.wait_for_selector('[data-item-id="address"]', timeout=8000)
    except Exception:  # noqa: BLE001 - carry on and take whatever is there
        pass
    try:
        el = page.query_selector('[data-item-id="address"]')
        if el:
            label = el.get_attribute("aria-label") or ""
            # Rendered as "Address: 1 Example St, …".
            address = label.split(":", 1)[-1].strip() or None
    except Exception:  # noqa: BLE001 - a missing detail is not a failed place
        pass
    try:
        el = page.query_selector('button[jsaction*="category"]')
        if el:
            category = (el.inner_text() or "").strip() or None
    except Exception:  # noqa: BLE001
        pass
    return address, category


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--takeout", default="~/Downloads/Takeout/Saved")
    ap.add_argument(
        "--details",
        action="store_true",
        help=(
            "also read the name, address and category off the page. Off by "
            "default: the position comes from the URL and is sturdy, these come "
            "from the document and are not, so a run that only needs "
            "coordinates should not depend on them."
        ),
    )
    ap.add_argument(
        "--input",
        help=(
            "a work list from dump-queue.ts, instead of a whole Takeout. "
            "Resume is taken from the queue rather than the output file, so a "
            "place flagged after it was already resolved is resolved again."
        ),
    )
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

    out = Path(os.path.expanduser(args.out))
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.input:
        work_list = Path(os.path.expanduser(args.input))
        if not work_list.is_file():
            print(f"no such file: {work_list}", file=sys.stderr)
            return 1
        entries = read_queue(work_list)
        # The queue is the authority on what still needs doing — a row stays
        # pending until coordinates were actually written for it — so a place
        # already in the output file is deliberately not skipped. That is what
        # lets a place be re-resolved after someone reports its pin as wrong.
        done = set()
    else:
        takeout = Path(os.path.expanduser(args.takeout))
        if not takeout.is_dir():
            print(f"no such directory: {takeout}", file=sys.stderr)
            return 1
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
    if not entries:
        print("nothing to do")
        return 0
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
                        # Only worth reading once the page has resolved: before
                        # that the panel belongs to no place, or to the last one.
                        if args.details:
                            name = name_from(page.url)
                            if name:
                                record["name"] = name
                            address, category = details_from(page)
                            if address:
                                record["address"] = address
                            if category:
                                record["category"] = category
                        ok += 1
                        status = f"{found[0]:.6f},{found[1]:.6f}"
                    else:
                        # Two different failures, and they want opposite
                        # handling, so tell them apart by what Google did with
                        # the feature id we asked about.
                        #
                        # Still in the settled URL: the page is Google's answer
                        # for this place and something else went wrong — a
                        # consent wall, a slow load, a network blip. Worth
                        # retrying.
                        #
                        # Gone from it: Google was asked for that id, dropped
                        # it, and settled on a blank map. It has no entry under
                        # that id, and no amount of retrying will produce one.
                        #
                        # The settled URL is recorded either way, because this
                        # distinction rests on an undocumented URL shape and a
                        # later reader deserves the evidence, not the verdict.
                        settled = page.url
                        record["settled"] = settled
                        if FEATURE_RE.search(url) and not FEATURE_RE.search(settled):
                            record["error"] = "no such place"
                            status = "GONE"
                        else:
                            record["error"] = "no coordinates in settled URL"
                            status = "FAILED"
                        failed += 1
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
