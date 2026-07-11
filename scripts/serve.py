#!/usr/bin/env python3
"""Local dev server for the EDEKA offers viewer.

Drop-in replacement for `python3 -m http.server`: it serves the repo root
statically AND adds two endpoints the static server cannot offer —

    POST /api/preferences          body = the exported preferences JSON
    POST /api/shopping             body = this week's shopping list JSON
    POST /api/mealplan/regenerate  (no body) runs scripts/generate_mealplan.py

The first stores the body straight into data/preferences.json, the file the
generators read to personalise the weekly Prospekt. That lets the Prospekt
page's "Für Montag exportieren" button save in place instead of dropping a
download you have to move into data/ by hand.

The second powers the meal plan's "↻ Neu generieren" button: it runs the
vegan-meal-plan generator live (`claude -p`) and rewrites data/mealplan.json,
so the page can rebuild the plan on demand instead of waiting for Monday.

Usage:

    python3 scripts/serve.py                        # http://127.0.0.1:8888
    python3 scripts/serve.py 9000                   # pick another port
    python3 scripts/serve.py --prefs ~/p.json       # save elsewhere this run

The save target defaults to data/preferences.json (option 1). Switch it to a
different location (option 2) two ways, in precedence order:

  1. --prefs <path> on the command line — an ad-hoc switch for one run.
  2. the EDEKA_PREFS_PATH env var — a persistent default; keep it in ~/.env so a
     personal path never lands in this public repo, e.g.
         export EDEKA_PREFS_PATH=~/edeka-prefs/preferences.json

A path may be absolute, ~-expanded, or relative to the repo root.

Bound to 127.0.0.1 only: the write endpoint is for your own machine, never the
LAN. If you serve the site some other way (plain http.server), the page's export
button still works — it just falls back to a normal download.
"""

import json
import os
import re
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 2 * 1024 * 1024  # 2 MB — preferences are a few KB; cap abuse/runaways.


def _resolve_prefs_path(override=None):
    """Where to store the posted preferences. Precedence: the `override` (the
    --prefs switch) wins, else the EDEKA_PREFS_PATH env var, else the default
    data/preferences.json. A path may be absolute, ~-expanded, or relative to the
    repo root. Keeping a personal path in a switch/env var rather than this
    tracked, public source avoids leaking a home path into the repo."""
    raw = (override if override is not None else os.environ.get("EDEKA_PREFS_PATH", "")).strip()
    if not raw:
        return REPO_ROOT / "data" / "preferences.json"
    p = Path(raw).expanduser()
    return p if p.is_absolute() else (REPO_ROOT / p)


PREFS_PATH = _resolve_prefs_path()


def display_path(path):
    """Repo-relative for the common case, absolute when the target lives outside
    the repo (a custom EDEKA_PREFS_PATH), so logging never crashes on relative_to."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def write_preferences(raw):
    """Validate `raw` (bytes) as a preferences object and write it atomically to
    data/preferences.json. Returns the parsed dict. Raises ValueError with an
    actionable message on any malformed input — the caller turns it into a 4xx.

    Kept socket-free so it can be unit-tested without binding a port."""
    if len(raw) > MAX_BODY:
        raise ValueError(f"body too large ({len(raw)} bytes, max {MAX_BODY})")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"body is not valid UTF-8 JSON: {exc}")
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    # Mirror the shape prospekt.js builds; tolerate missing keys (older exports)
    # but reject a wrong type so a corrupt file can't reach generate_prospekt.py.
    for key in ("interests", "votes", "bought"):
        if key in data and not isinstance(data[key], dict):
            raise ValueError(f"'{key}' must be an object, got {type(data[key]).__name__}")

    PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # Atomic write: a crash mid-write must not leave a half-file that breaks the
    # next generate_prospekt.py run. tmp sibling + os.replace is atomic on POSIX.
    tmp = PREFS_PATH.with_name(PREFS_PATH.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, PREFS_PATH)
    return data


# Shopping-list file name is the week's date — unique across years and sortable,
# matching the data/{YEAR}/KW{XX}/{DATE}.json scheme. A strict pattern (digits +
# dashes only) doubles as the path-traversal guard: the name comes from the
# client, so nothing but YYYY-MM-DD may reach the filesystem.
SHOPPING_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def write_shopping(raw):
    """Validate `raw` (bytes) as a weekly shopping list and write it atomically to
    data/shopping/<date>.json (gitignored — it's personal). Returns the parsed
    dict. Raises ValueError with an actionable message on malformed input.

    Socket-free so it can be unit-tested without binding a port."""
    if len(raw) > MAX_BODY:
        raise ValueError(f"body too large ({len(raw)} bytes, max {MAX_BODY})")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"body is not valid UTF-8 JSON: {exc}")
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    date = data.get("date")
    if not isinstance(date, str) or not SHOPPING_DATE_RE.match(date):
        raise ValueError("'date' must be a YYYY-MM-DD string (it names the file)")
    for key in ("offers", "pantry", "custom"):
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"'{key}' must be an array, got {type(data[key]).__name__}")

    target = REPO_ROOT / "data" / "shopping" / f"{date}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
    return data, target


def run_mealplan_regen(timeout=660):
    """Run scripts/generate_mealplan.py and return (ok: bool, message: str). The
    generator reads data/preferences.json (the page POSTs /api/preferences first)
    and calls `claude -p`, so this can take a while — the threading server keeps
    serving other requests meanwhile. Kept socket-free for isolated testing."""
    script = REPO_ROOT / "scripts" / "generate_mealplan.py"
    try:
        # Point the generator at the SAME prefs file this server writes (which may
        # be redirected via --prefs / EDEKA_PREFS_PATH), so a live regen honours
        # the freshly-exported votes rather than a stale data/preferences.json.
        proc = subprocess.run(
            [sys.executable, str(script), "--prefs", str(PREFS_PATH)],
            cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"generate_mealplan.py timed out after {timeout}s"
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        return False, (err[-400:] or f"generate_mealplan.py exited {proc.returncode}")
    return True, (proc.stdout or "").strip()[-400:]


class DevHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # Health probe so the page can tell THIS dev server (which has the write
        # endpoints) apart from a plain `http.server` at localhost — a GET to
        # /api/health returns 200 here but 404 there. Lets the page hide the
        # "↻ Neu generieren" button when the API isn't actually available.
        if self.path.split("?", 1)[0] == "/api/health":
            self._send_json(200, {"ok": True, "service": "edeka-dev-server"})
            return
        super().do_GET()

    def end_headers(self):
        # Dev server only: never cache the app's own source (HTML/JS/CSS) or the
        # JSON it reads, so edits show on a plain reload — no hard-refresh. The
        # archived product images keep their default caching (they don't change).
        path = self.path.split("?", 1)[0]
        if path == "/" or path.startswith("/api/") or path.endswith((".html", ".js", ".css", ".json")):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route == "/api/preferences":
            self._handle_preferences()
        elif route == "/api/shopping":
            self._handle_shopping()
        elif route == "/api/mealplan/regenerate":
            self._handle_mealplan_regen()
        else:
            self.send_error(404, "Unknown endpoint")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_preferences(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0:
            self.send_error(400, "Empty body")
            return
        if length > MAX_BODY:
            # Don't read the oversized body; close the connection so its undrained
            # bytes can't desync the next keep-alive request on this socket.
            self.close_connection = True
            self.send_error(413, f"Body too large (max {MAX_BODY} bytes)")
            return
        raw = self.rfile.read(length)
        try:
            data = write_preferences(raw)
        except ValueError as exc:
            self.send_error(400, str(exc))
            return
        n_votes = len(data.get("votes", {}))
        n_bought = len(data.get("bought", {}))
        self._send_json(200, {
            "ok": True,
            "path": display_path(PREFS_PATH),
            "votes": n_votes,
            "bought": n_bought,
        })
        print(f"saved {display_path(PREFS_PATH)} "
              f"({n_votes} votes, {n_bought} bought)")

    def _handle_shopping(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0:
            self.send_error(400, "Empty body")
            return
        if length > MAX_BODY:
            self.close_connection = True
            self.send_error(413, f"Body too large (max {MAX_BODY} bytes)")
            return
        raw = self.rfile.read(length)
        try:
            data, target = write_shopping(raw)
        except ValueError as exc:
            self.send_error(400, str(exc))
            return
        n_offers = len(data.get("offers", []))
        n_pantry = len(data.get("pantry", []))
        self._send_json(200, {
            "ok": True,
            "path": display_path(target),
            "offers": n_offers,
            "pantry": n_pantry,
        })
        print(f"saved {display_path(target)} ({n_offers} offers, {n_pantry} pantry)")

    def _handle_mealplan_regen(self):
        # The generator ignores the request body (it reads data/preferences.json,
        # which the page POSTs first). Drain any body so keep-alive stays in sync.
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length > 0:
            self.rfile.read(min(length, MAX_BODY))
            if length > MAX_BODY:
                # Couldn't fully drain an abusive body — close to stay aligned.
                self.close_connection = True
        print("regenerate mealplan: running generate_mealplan.py …")
        ok, message = run_mealplan_regen()
        self._send_json(200 if ok else 500,
                        {"ok": ok, "message": message} if ok else {"ok": ok, "error": message})
        print(f"regenerate mealplan: {'ok' if ok else 'FAILED — ' + message}")


def parse_args(argv):
    """Parse an optional port number and an optional `--prefs <path>` switch, in
    any order. Returns (port, prefs_override). Exits with an actionable message
    on a bad argument."""
    port = 8888
    prefs_override = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--prefs":
            if i + 1 >= len(argv):
                sys.exit("serve: --prefs needs a path, e.g. --prefs ~/edeka-prefs/preferences.json")
            prefs_override = argv[i + 1]
            i += 2
            continue
        try:
            port = int(a)
        except ValueError:
            sys.exit(f"serve: unexpected argument {a!r} (expected a port number or --prefs <path>)")
        i += 1
    return port, prefs_override


def main():
    global PREFS_PATH
    port, prefs_override = parse_args(sys.argv[1:])
    if prefs_override is not None:
        PREFS_PATH = _resolve_prefs_path(prefs_override)
        src = "--prefs"
    elif os.environ.get("EDEKA_PREFS_PATH", "").strip():
        src = "EDEKA_PREFS_PATH"
    else:
        src = "default"
    handler = partial(DevHandler, directory=str(REPO_ROOT))
    # Threading so a long `claude -p` meal-plan regeneration doesn't block the
    # static assets the page needs to keep loading.
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"Serving {REPO_ROOT} at http://127.0.0.1:{port}")
    print(f"  POST /api/preferences          -> {display_path(PREFS_PATH)}  ({src})")
    print(f"  POST /api/shopping             -> data/shopping/<date>.json")
    print(f"  POST /api/mealplan/regenerate  -> runs scripts/generate_mealplan.py")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
