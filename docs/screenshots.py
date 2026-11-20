#!/usr/bin/env python3
"""Regenerates every README screenshot:  python docs/screenshots.py [name ...]

Each shot runs a real Claude Code session offscreen with the capture script shared by
the whole set (claude-boxed-messages docs/capture.py, downloaded at CAPTURE_REF; set
CAPTURE_PY to a local copy to skip the download). It uses your login in a throwaway
config folder, so none of your own settings, plugins or history show up.
Needs `pip install pyte pillow pywinpty` (ptyprocess instead of pywinpty off Windows).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.request

CAPTURE_REF = 'main'
DOCS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(DOCS)
PLUGIN = os.path.join(REPO, 'plugins', 'limit-revive')

# file name -> (limit-revive options, what to type)
SHOTS = {
    'status.png': ({}, '/limit-revive status'),
    'status-stop-now.png': ({'mode': 'stop-now', 'thresholdPercent': 80, 'delayMinutes': 2}, '/limit-revive status'),
}


def capture_script(tmp: str) -> str:
    if os.environ.get('CAPTURE_PY'):
        return os.environ['CAPTURE_PY']
    url = f'https://raw.githubusercontent.com/lucaslobasso/claude-boxed-messages/{CAPTURE_REF}/docs/capture.py'
    path = os.path.join(tmp, 'capture.py')
    urllib.request.urlretrieve(url, path)
    return path


def shoot(capture: str, name: str, options: dict, typed: str, work: str) -> None:
    settings = {'promptSuggestionEnabled': False, 'pluginConfigs': {'limit-revive@inline': {'options': options}}}
    subprocess.run([
        sys.executable, capture, '--out', os.path.join(DOCS, name), '--cwd', work,
        '--sandbox', json.dumps(settings), '--wait', '14', '--cols', '100', '--rows', '24',
        '--from-text', re_escape(typed), '--title', 'claude',
        '--send', f'{typed}@5', '--send', '\\r@6',
        '--', 'claude', '--plugin-dir', PLUGIN,
    ], check=True)


def re_escape(text: str) -> str:
    import re
    return re.escape(text)


def main() -> int:
    wanted = sys.argv[1:] or list(SHOTS)
    with tempfile.TemporaryDirectory(prefix='revive-shots-') as work:
        capture = capture_script(work)
        for name in wanted:
            options, typed = SHOTS[name]
            shoot(capture, name, options, typed, work)
    return 0


if __name__ == '__main__':
    sys.exit(main())
