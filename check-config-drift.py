#!/usr/bin/env python3
"""Checks that the deployment files agree about every environment variable.

A new setting has to land in the app, in BOTH compose files, and in
.env.example. Nothing enforces that, and two of the ways it can go wrong are
silent:

  * A variable documented in .env.example that no compose file forwards does
    nothing under Docker — no error, just the app's default. MEAL_HISTORY_
    RETENTION_DAYS was like that for its whole life.
  * A variable added to one compose file and not the other works in dev and
    not in the published stack, or the reverse.

Run from the repo root. Exits non-zero if anything drifted, so it can gate a
commit or a CI step.
"""

import re
import sys
from pathlib import Path

# Consumed by compose itself rather than passed to the container, so these
# are expected to appear in .env.example without being forwarded.
COMPOSE_LEVEL = {
    'APP_PORT', 'APP_VERSION', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'TZ',
}

PROD = Path('docker-compose.yml')
DEV = Path('docker-compose-dev.yml')
EXAMPLE = Path('.env.example')


def read(path: Path) -> str:
    if not path.exists():
        sys.exit(f'{path} not found — run this from the repo root')
    return path.read_text(encoding='utf-8')


def interpolated(text: str) -> set[str]:
    """Variables the file reads as ${VAR} or ${VAR:-default}."""
    return set(re.findall(r'\$\{([A-Z0-9_]+)', text))


def forwarded(text: str) -> set[str]:
    """Keys the file passes to the container (an `environment:` entry)."""
    return set(re.findall(r'^      ([A-Z0-9_]+):', text, re.M))


def documented(text: str) -> set[str]:
    return set(re.findall(r'^([A-Z0-9_]+)=', text, re.M))


def main() -> int:
    prod, dev, example = read(PROD), read(DEV), read(EXAMPLE)
    doc = documented(example)

    problems = []

    undocumented = sorted((interpolated(prod) | interpolated(dev)) - doc)
    if undocumented:
        problems.append(
            f'read by a compose file but absent from {EXAMPLE}: {", ".join(undocumented)}\n'
            f'  -> document each one, with a comment saying what it is for'
        )

    inert = sorted(
        v for v in doc - COMPOSE_LEVEL
        if '${%s' % v not in prod and '${%s' % v not in dev
    )
    if inert:
        problems.append(
            f'documented but forwarded by neither compose file: {", ".join(inert)}\n'
            f'  -> setting these does nothing under Docker, silently; add\n'
            f'     `{inert[0]}: ${{{inert[0]}:-<default>}}` to both files\n'
            f'     (or list it in COMPOSE_LEVEL here if compose itself consumes it)'
        )

    drift = sorted(forwarded(prod) ^ forwarded(dev))
    if drift:
        problems.append(
            f'forwarded by one compose file but not the other: {", ".join(drift)}\n'
            f'  -> every app-facing variable belongs in both'
        )

    if problems:
        print('config drift:\n')
        for p in problems:
            print(f'- {p}\n')
        return 1

    print('config files agree: every variable is read, forwarded and documented')
    return 0


if __name__ == '__main__':
    sys.exit(main())
