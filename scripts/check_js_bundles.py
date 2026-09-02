#!/usr/bin/env python3
"""Parse-check each page's scripts the way the browser sees them: concatenated.

`node --check` reads one file at a time, so it cannot see the failure mode
CLAUDE.md warns about — moving a helper into a shared file and forgetting to
delete the local copy. Two `const X` at global scope in two files each parse
fine alone and throw `SyntaxError: Identifier 'X' has already been declared`
the moment a page loads both, which takes the page down with a blank screen.

The script sets are read out of the HTML rather than hardcoded, so adding a
<script src> to a page extends this check automatically instead of silently
leaving the new pair unguarded. External sources (the ECharts CDN) are skipped.

stdlib only; exits non-zero with the offending page and node's message.
"""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PAGES = ("table.html", "dashboard.html", "prospekt.html")
SRC_RE = re.compile(r"""<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']""", re.I)


def local_scripts(page):
    """The page's own <script src> files, in document order."""
    html = (REPO_ROOT / page).read_text(encoding="utf-8")
    return [s for s in SRC_RE.findall(html) if not s.startswith(("http:", "https:", "//"))]


def main():
    failed = False
    for page in PAGES:
        srcs = local_scripts(page)
        if not srcs:
            print(f"FAIL {page}: no local <script src> found — has the page changed?")
            failed = True
            continue
        bundle = "\n".join((REPO_ROOT / s).read_text(encoding="utf-8") for s in srcs)
        # node --check reads a file, not stdin, so the bundle needs a real path.
        tmp = REPO_ROOT / f".bundle-check-{page}.js"
        try:
            tmp.write_text(bundle, encoding="utf-8")
            proc = subprocess.run(["node", "--check", str(tmp)],
                                  capture_output=True, text=True)
        finally:
            tmp.unlink(missing_ok=True)
        if proc.returncode == 0:
            print(f"ok   {page}: {' + '.join(srcs)} parse together")
        else:
            failed = True
            # node names the temp file; say which page it stands for.
            print(f"FAIL {page}: {' + '.join(srcs)} do NOT parse together")
            print(proc.stderr.strip().replace(str(tmp), f"<{page} bundle>"))
    if failed:
        sys.exit("Bundle check failed — most likely a declaration that exists "
                 "in both a shared file and a page script.")
    print(f"PASS: all {len(PAGES)} page bundles parse.")


if __name__ == "__main__":
    main()
