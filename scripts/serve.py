#!/usr/bin/env python3
"""Local dev server for the EDEKA offers viewer.

Drop-in replacement for `python3 -m http.server`: it serves the repo root
statically AND adds one write endpoint the static server cannot offer —

    POST /api/preferences   body = the exported preferences JSON

which stores the body straight into data/preferences.json, the file
generate_prospekt.py reads to personalise the weekly Prospekt. That lets the
Prospekt page's "Für Montag exportieren" button save in place instead of
dropping a download you have to move into data/ by hand.

Usage:

    python3 scripts/serve.py            # http://127.0.0.1:8888
    python3 scripts/serve.py 9000       # pick another port

The save target defaults to data/preferences.json. Override it with the
EDEKA_PREFS_PATH env var (absolute, ~-expanded, or relative to the repo root) —
keep it in ~/.env so a personal path never lands in this public repo, e.g.

    export EDEKA_PREFS_PATH=~/edeka-prefs/preferences.json

Bound to 127.0.0.1 only: the write endpoint is for your own machine, never the
LAN. If you serve the site some other way (plain http.server), the page's export
button still works — it just falls back to a normal download.
"""

import json
import os
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 2 * 1024 * 1024  # 2 MB — preferences are a few KB; cap abuse/runaways.


def _resolve_prefs_path():
    """Where to store the posted preferences. Override via the EDEKA_PREFS_PATH
    env var (absolute, ~-expanded, or relative to the repo root); defaults to
    data/preferences.json. Keeping a personal path in an env var rather than this
    tracked, public source avoids leaking a home path into the repo."""
    raw = os.environ.get("EDEKA_PREFS_PATH", "").strip()
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


class DevHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/preferences":
            self.send_error(404, "Unknown endpoint")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0:
            self.send_error(400, "Empty body")
            return
        if length > MAX_BODY:
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
        body = json.dumps({
            "ok": True,
            "path": display_path(PREFS_PATH),
            "votes": n_votes,
            "bought": n_bought,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print(f"saved {display_path(PREFS_PATH)} "
              f"({n_votes} votes, {n_bought} bought)")


def main():
    port = 8888
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            sys.exit(f"serve: port must be a number, got {sys.argv[1]!r}")
    handler = partial(DevHandler, directory=str(REPO_ROOT))
    server = HTTPServer(("127.0.0.1", port), handler)
    print(f"Serving {REPO_ROOT} at http://127.0.0.1:{port}")
    src = "EDEKA_PREFS_PATH" if os.environ.get("EDEKA_PREFS_PATH", "").strip() else "default"
    print(f"  POST /api/preferences -> {display_path(PREFS_PATH)}  ({src})")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
