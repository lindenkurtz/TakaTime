#!/usr/bin/env python3
"""Write one TakaTime heartbeat for the current Mathematica notebook.

Invoked by TakatimePalette.wl on a throttle. Writes straight to MongoDB rather
than going through taka-upload, because Mathematica already has a Python bridge
and the Go binary would add a process spawn for no benefit.

A heartbeat is an OBSERVATION -- "this notebook was being edited at this instant"
-- not a duration. Nothing about elapsed time is written. Durations are derived at
query time from timestamps by analytics/duration.mjs. See METHODOLOGY.md.
"""

import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

import certifi
from pymongo import MongoClient

# ── Configuration ─────────────────────────────────────────────────────────────
DB_NAME = "takatime"
COLLECTION_NAME = "logs"
LOG_PATH = "/tmp/takatime_python.log"

# Tracker config regime in force. MUST match the open-ended entry in
# CONFIG_REGISTRY (analytics/duration.mjs) and the interval in TakatimePalette.wl.
#
# This tracker has always shared the VS Code regime timeline: it ran at 120s
# through v1 and 300s through v2, flipping on the same boundaries. Keep it that
# way -- a divergence would force the config registry to become per-tracker.
CONFIG_VERSION = 3
# ──────────────────────────────────────────────────────────────────────────────


def get_mongo_uri() -> str:
    """Resolve the MongoDB URI.

    NEVER hardcode the URI here -- this file is in a git repository, and a
    connection string carries the password in plaintext. Resolution order matches
    analytics/scripts/_mongo.mjs so every component reads the same config:

      1. $TAKATIME_MONGO_URI / $MONGO_URI
      2. MONGO_URI in ~/.takatime.json (what the VS Code extension writes)
    """
    for var in ("TAKATIME_MONGO_URI", "MONGO_URI"):
        if os.environ.get(var):
            return os.environ[var]

    config_path = Path.home() / ".takatime.json"
    if config_path.exists():
        try:
            uri = json.loads(config_path.read_text()).get("MONGO_URI")
            if uri:
                return uri
        except (json.JSONDecodeError, OSError):
            pass

    raise RuntimeError(
        "No MongoDB URI found. Set $TAKATIME_MONGO_URI or put MONGO_URI in ~/.takatime.json"
    )


def get_os() -> str:
    """Return an OS string that mirrors the takatime convention."""
    system = platform.system().lower()
    if system == "darwin":
        return "darwin"
    elif system == "windows":
        return "win32"
    else:
        return "linux"


def log(message: str) -> None:
    try:
        with open(LOG_PATH, "a") as f:
            f.write(f"{datetime.now()}: {message}\n")
    except OSError:
        pass  # Logging must never break tracking.


def send_heartbeat(notebook_path: str) -> None:
    now = datetime.now(timezone.utc)

    # Derive project name from the notebook's name
    project = os.path.splitext(os.path.basename(notebook_path))[0]
    if not project or notebook_path == "unknown":
        project = "untitled"

    # NOTE: no `duration` key. It is retired as of config regime v3 -- it only ever
    # held the throttle interval frozen at write time, which made it an
    # interpretation baked into the raw log rather than a measurement.
    doc = {
        "name": notebook_path,
        "project": project,
        "timestamp": now,  # Stored as BSON Date (matches existing entries)
        "date": now.strftime("%Y-%m-%d"),  # Legacy convenience string; timestamp is the record
        "language": "wolframlanguage",
        "os": get_os(),
        "gitBranch": "none",
        "editor": "Mathematica",
        "configVersion": CONFIG_VERSION,
    }

    try:
        client = MongoClient(get_mongo_uri(), tlsCAFile=certifi.where())
    except Exception as e:
        log(f"ERROR connecting: {type(e).__name__}: {e}")
        return

    try:
        result = client[DB_NAME][COLLECTION_NAME].insert_one(doc)
        log(f"Inserted {result.inserted_id} into {DB_NAME}.{COLLECTION_NAME}")
    except Exception as e:
        log(f"ERROR {type(e).__name__}: {e}")
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python takatime_mathematica.py <notebook_path>", file=sys.stderr)
        sys.exit(1)
    send_heartbeat(sys.argv[1])
