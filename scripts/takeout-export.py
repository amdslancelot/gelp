#!/usr/bin/env python3
"""Request a Google Takeout export of Saved + Maps (your places) and download the zip, unattended.

Why this exists
---------------
Google has no API for saved lists, so the export is the only source — and
asking for one is a form on takeout.google.com that a person clicks through.
This script clicks through it in a real browser, waits for Google to build the
archive, and downloads it to `data/takeout/`. `scripts/sync-maps.sh` then hands
that zip to the import.

The browser profile lives in `data/chrome-profile/` (gitignored), so you sign in
to Google once, by hand, in the window this opens; later runs reuse the session.
The window is always visible: Google refuses sign-in in a headless browser, and
a re-auth prompt in front of the download needs a person anyway.

Asking a model before clicking
------------------------------
Takeout's markup is Google's to change, and a click that lands on the wrong
element is worse than one that fails — this is a signed-in account. So before
acting on each page, the script sends a screenshot and the page's accessibility
tree to Claude (via `claude -p`) along with the elements it expects, and asks whether each is
still there.

  - all present           → proceed with the known locators
  - moved or renamed      → use the model's locator for this run and write it to
                            data/takeout-locators.json, printing what changed
  - missing / not sure    → stop, leaving a screenshot, and click nothing

The model only answers that question. Playwright does every click, and only on
role + accessible-name locators, so the model never drives the account.

Usage
-----
    python3 scripts/takeout-export.py              # prints the zip path last
    python3 scripts/takeout-export.py --no-check   # skip the model preflight

Needs `pip install playwright` and a signed-in Claude Code CLI (`claude`).
"""

from __future__ import annotations

import argparse
import json
import shutil
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = REPO_ROOT / "data" / "chrome-profile"
OUT_DIR = REPO_ROOT / "data" / "takeout"
SHOTS_DIR = OUT_DIR / "screenshots"
LOCATORS_FILE = REPO_ROOT / "data" / "takeout-locators.json"

CHROME = os.environ.get(
    "GELP_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
CDP_PORT = 9333

TAKEOUT_URL = "https://takeout.google.com/"
MANAGE_URL = "https://takeout.google.com/manage"

# Unset → whatever model the Claude Code CLI defaults to.
MODEL = os.environ.get("TAKEOUT_CHECK_MODEL")

# How long Google may take to build an export holding only Saved. Usually a few
# minutes; the ceiling is generous because a slow day is not a failure.
EXPORT_TIMEOUT_S = 60 * 60
POLL_INTERVAL_S = 30

# The elements each page must have, as role + accessible name. These are the
# defaults; data/takeout-locators.json overrides any the model has re-found.
DEFAULT_LOCATORS: dict[str, dict[str, dict[str, str]]] = {
    "select": {
        "deselect_all": {"role": "button", "name": "Deselect all",
                         "purpose": "clears every product so only Saved is exported"},
        "saved": {"role": "checkbox", "name": "Select Saved",
                  "purpose": "the product row for Google Maps saved lists ('Saved')"},
        "your_places": {"role": "checkbox", "name": "Select Maps (your places)",
                        "purpose": "the product row for 'Maps (your places)', which holds"
                                   " Saved Places.json (starred places)"},
        "next_step": {"role": "button", "name": "Next step",
                      "purpose": "advances from product selection to delivery options"},
    },
    "deliver": {
        "create_export": {"role": "button", "name": "Create export",
                          "purpose": "submits the export request"},
    },
    # The manage page lists one link per archive, newest first; the Download
    # link is on each archive's own page, and only once it has finished.
    "manage": {
        "archive": {"role": "link",
                    "name": "See the details and actions available for this archive, including downloads",
                    "purpose": "opens an export archive's detail page. One link per archive, so"
                               " several matching is expected; the script takes the first,"
                               " which is the newest — that is the intended target"},
    },
    "archive": {
        "download": {"role": "link", "name": "Download",
                     "purpose": "downloads this finished export archive"},
    },
}


def die(msg: str) -> None:
    print(f"takeout-export: {msg}", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    print(f"takeout-export: {msg}", file=sys.stderr)


def load_locators() -> dict:
    locators = json.loads(json.dumps(DEFAULT_LOCATORS))
    if LOCATORS_FILE.exists():
        for step, items in json.loads(LOCATORS_FILE.read_text()).items():
            for key, loc in items.items():
                if step in locators and key in locators[step]:
                    locators[step][key].update(loc)
    return locators


def save_override(step: str, key: str, loc: dict) -> None:
    current = json.loads(LOCATORS_FILE.read_text()) if LOCATORS_FILE.exists() else {}
    current.setdefault(step, {})[key] = {"role": loc["role"], "name": loc["name"]}
    LOCATORS_FILE.write_text(json.dumps(current, indent=2) + "\n")


def screenshot(page, label: str) -> Path:
    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    path = SHOTS_DIR / f"{int(time.time())}-{label}.png"
    page.screenshot(path=str(path), full_page=True)
    return path


CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "elements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "status": {"type": "string", "enum": ["present", "moved", "missing"]},
                    "role": {"type": "string"},
                    "name": {"type": "string"},
                    "confident": {"type": "boolean"},
                    "note": {"type": "string"},
                },
                "required": ["key", "status", "role", "name", "confident", "note"],
                "additionalProperties": False,
            },
        },
        "page_matches": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "required": ["elements", "page_matches", "summary"],
    "additionalProperties": False,
}


def preflight(page, step: str, locators: dict, enabled: bool) -> dict:
    """Ask the model whether this page still has what we are about to click.

    Returns the locators to use for this step, with any re-found ones swapped in.
    Exits without clicking anything when an element cannot be placed.
    """
    expected = locators[step]
    if not enabled:
        return expected

    shot = screenshot(page, f"preflight-{step}")
    tree_file = shot.with_suffix(".aria.txt")
    tree_file.write_text(page.locator("body").aria_snapshot())
    wanted = [
        {"key": k, "role": v["role"], "name": v["name"], "purpose": v["purpose"]}
        for k, v in expected.items()
    ]

    prompt = (
        "This is a page of Google Takeout (takeout.google.com) in a script that "
        f"exports Google Maps saved lists. Step: '{step}'.\n\n"
        f"Read the screenshot {shot.name} and the accessibility tree {tree_file.name}.\n\n"
        "The script is about to locate these elements with Playwright "
        "get_by_role(role, name=name, exact=True):\n"
        f"{json.dumps(wanted, indent=2)}\n\n"
        "Report for each key whether that exact role+name is on the page "
        "('present'), the same control now has a different role or accessible "
        "name ('moved' — give the new role and exact name as they appear in the "
        "tree), or it is not there ('missing'). Set confident=false if more than "
        "one element could match or you are unsure it does the stated purpose. "
        "Set page_matches=false if this is not the expected Takeout page at all "
        "(e.g. a sign-in or error page)."
    )

    # Claude Code in print mode, not the API: it uses the CLI's own login, so
    # there is no key to keep. Read is the only tool it gets, and it runs in
    # the screenshots folder, so it can look at the two files and nothing else.
    cmd = ["claude", "-p", prompt, "--output-format", "json",
           "--json-schema", json.dumps(CHECK_SCHEMA),
           "--tools", "Read", "--allowedTools", "Read"]
    if MODEL:
        cmd += ["--model", MODEL]
    proc = subprocess.run(cmd, cwd=SHOTS_DIR, capture_output=True, text=True, timeout=600)
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        die(f"claude -p failed at '{step}': {proc.stderr.strip()[:500]} — screenshot at {shot}")
    if out.get("is_error") or not out.get("structured_output"):
        die(f"claude -p gave no verdict at '{step}': {out.get('result', '')[:500]} — screenshot at {shot}")

    verdict = out["structured_output"]
    log(f"check '{step}': {verdict['summary']}")

    if not verdict["page_matches"]:
        die(f"not the expected Takeout page at '{step}' — nothing clicked. Screenshot: {shot}")

    resolved = dict(expected)
    by_key = {e["key"]: e for e in verdict["elements"]}
    for key, loc in expected.items():
        e = by_key.get(key)
        if e is None or e["status"] == "missing" or not e["confident"]:
            why = e["note"] if e else "not reported"
            die(f"cannot place '{key}' at '{step}' ({why}) — nothing clicked. Screenshot: {shot}")
        if e["status"] == "moved":
            log(f"  ⚠️ {step}.{key}: {loc['role']} '{loc['name']}' → {e['role']} '{e['name']}'"
                f" (saved to {LOCATORS_FILE.relative_to(REPO_ROOT)}) — {e['note']}")
            resolved[key] = {**loc, "role": e["role"], "name": e["name"]}
            save_override(step, key, resolved[key])
    return resolved


def start_chrome() -> subprocess.Popen:
    """Launch the installed Chrome as an ordinary process, for Playwright to attach to.

    Not Playwright's own launch: Google refuses sign-in ("Couldn't sign you in")
    in a browser started with automation flags, which is what launch() always
    passes. A plain Chrome with a debugging port is a browser Google accepts,
    and Playwright drives it over CDP all the same. A separate --user-data-dir
    keeps this off your everyday Chrome profile (Chrome also refuses a
    debugging port on the default one).
    """
    if not Path(CHROME).exists():
        die(f"Chrome not found at {CHROME} — set GELP_CHROME to its binary")
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [CHROME, f"--user-data-dir={PROFILE_DIR}", f"--remote-debugging-port={CDP_PORT}",
         "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1)
            return proc
        except OSError:
            if proc.poll() is not None:
                die("Chrome exited at start — is another Chrome already using data/chrome-profile?")
            time.sleep(0.5)
    proc.terminate()
    die(f"Chrome never opened its debugging port {CDP_PORT}")


def preflight_at(page, url: str, step: str, locators: dict, enabled: bool) -> dict:
    page.goto(url)
    settle(page)
    return preflight(page, step, locators, enabled)


def notify(msg: str) -> None:
    subprocess.run(["osascript", "-e",
                    f'display notification "{msg}" with title "Gelp sync" sound name "Glass"'],
                   check=False)


def find(page, loc: dict):
    return page.get_by_role(loc["role"], name=loc["name"], exact=True)


def wait_for_sign_in(page) -> None:
    """Hand the window to the person until Takeout itself has loaded."""
    page.goto(TAKEOUT_URL)
    if "accounts.google.com" not in page.url:
        return
    log("sign in to Google in the Chrome window — waiting up to 10 minutes")
    page.bring_to_front()
    page.wait_for_url("https://takeout.google.com/**", timeout=10 * 60 * 1000)


def settle(page) -> None:
    # Not "networkidle": Google's pages keep a connection open for good, so the
    # network never goes quiet and that wait always times out.
    page.wait_for_load_state("load")
    page.wait_for_timeout(3000)


def count_archives(page, loc: dict) -> int:
    page.goto(MANAGE_URL)
    settle(page)
    return find(page, loc).count()


def newest_is_ready(page, locators: dict, before: int) -> bool:
    """Open the newest archive, if it is a new one, and see if it can be downloaded."""
    if count_archives(page, locators["manage"]["archive"]) <= before:
        return False
    find(page, locators["manage"]["archive"]).first.click()
    settle(page)
    return find(page, locators["archive"]["download"]).count() > 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--download-only", action="store_true",
                    help="request nothing; download the newest finished export")
    ap.add_argument("--no-check", action="store_true",
                    help="skip asking the model whether the page changed")
    args = ap.parse_args()
    check = not args.no_check

    if check and shutil.which("claude") is None:
        die("the Claude Code CLI ('claude') is not on PATH (or pass --no-check)")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("playwright not installed:\n  pip install playwright && playwright install chromium")

    locators = load_locators()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        chrome = start_chrome()
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        ctx = browser.contexts[0]
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            wait_for_sign_in(page)

            # Counted before asking, so the export this run creates is told
            # apart from older ones still listed (they stay for about a week).
            mng = preflight_at(page, MANAGE_URL, "manage", locators, check)
            locators["manage"] = mng
            before = -1 if args.download_only else count_archives(page, mng["archive"])

            if not args.download_only:
                # --- select only Saved ----------------------------------------
                page.goto(TAKEOUT_URL)
                settle(page)
                sel = preflight(page, "select", locators, check)
                find(page, sel["deselect_all"]).click()
                # Saved holds the lists (one CSV each); Maps (your places)
                # holds Saved Places.json, the starred places. My Maps is left
                # out on purpose: nothing in Gelp reads its .kmz files.
                for key in ("saved", "your_places"):
                    box = find(page, sel[key])
                    box.scroll_into_view_if_needed()
                    box.check()
                    if not box.is_checked():
                        die(f"the {key} checkbox did not stay checked — nothing submitted")
                find(page, sel["next_step"]).click()

                # --- delivery: the defaults (email link, once, .zip) are what
                # we want, so only the submit button is touched ---------------
                settle(page)
                dlv = preflight(page, "deliver", locators, check)
                find(page, dlv["create_export"]).click()
                log("export requested — waiting for Google to build it")

            # --- wait, then download the newest archive -------------------
            deadline = time.time() + EXPORT_TIMEOUT_S
            while True:
                if newest_is_ready(page, locators, before):
                    break
                if time.time() > deadline:
                    die(f"export not ready after {EXPORT_TIMEOUT_S // 60} min — "
                        f"it will still arrive by email; import it from /import")
                log(f"not ready yet, checking again in {POLL_INTERVAL_S}s")
                time.sleep(POLL_INTERVAL_S)

            arc = preflight(page, "archive", locators, check)
            with page.expect_download(timeout=10 * 60 * 1000) as dl:
                find(page, arc["download"]).first.click()
                # Google re-confirms identity (password or passkey) before
                # handing over an archive. That is the person's to answer, so
                # say so loudly rather than wait silently behind other windows.
                page.wait_for_timeout(3000)
                if "accounts.google.com" in page.url:
                    page.bring_to_front()
                    notify("Google wants you to confirm it's you, in the Chrome window")
                    log("Google asks you to confirm it's you — answer in the Chrome window (10 min)")
            download = dl.value
            dest = OUT_DIR / f"takeout-{time.strftime('%Y%m%d-%H%M%S')}.zip"
            download.save_as(str(dest))
        except SystemExit:
            raise
        except Exception as exc:  # leave evidence for whoever fixes the selector
            shot = screenshot(page, "error")
            die(f"{type(exc).__name__}: {exc}\nScreenshot: {shot}")
        finally:
            browser.close()
            chrome.terminate()

    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
