"""One collection round: listen to aisstream.io for the ships in ships.json,
then append their latest positions to docs/data/.

Run from the repo root:
    python -m collector.collect            # uses AISSTREAM_API_KEY or data/config.json
    python -m collector.collect --demo     # simulated ships, for testing the page

GitHub Actions runs this every 30 minutes (.github/workflows/collect.yml).
"""
import argparse
import asyncio
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from server.providers.aisstream import AisStreamProvider
from server.providers.base import ProviderError
from server.providers.demo import DemoProvider

ROOT = Path(__file__).resolve().parent.parent
SHIPS_FILE = ROOT / "ships.json"
OUT = ROOT / "docs" / "data"
LATEST = OUT / "latest.json"
CSV_FILE = OUT / "positions.csv"
CSV_COLUMNS = ["time_utc", "mmsi", "name", "label", "lat", "lon", "speed_kn",
               "course", "heading", "nav_status", "destination"]

LISTEN_MAX_S = 360     # give up on silent ships after this long (moored ships report every 3 min)
LISTEN_MIN_S = 20      # keep listening a little even when all ships reported (static data)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_ships() -> dict[str, str]:
    data = json.loads(SHIPS_FILE.read_text(encoding="utf-8"))
    ships = {}
    for item in data.get("ships", []):
        mmsi = str(item.get("mmsi", "")).strip()
        if len(mmsi) == 9 and mmsi.isdigit():
            ships[mmsi] = (item.get("label") or "").strip()
        else:
            print(f"! ships.json: geçersiz MMSI atlandı: {item!r}")
    return ships


def api_key() -> str:
    key = os.environ.get("AISSTREAM_API_KEY", "").strip()
    if not key:
        try:
            key = json.loads((ROOT / "data" / "config.json").read_text())["aisstream_api_key"]
        except (FileNotFoundError, KeyError, json.JSONDecodeError):
            pass
    return key


async def listen(provider, ships: dict[str, str]) -> dict[str, dict]:
    """Collect merged updates per ship until all have a position or time runs out."""
    seen: dict[str, dict] = {}
    with_pos: set[str] = set()
    start = time.monotonic()

    async def run():
        async for upd in provider.stream(mmsis=list(ships)):
            mmsi = upd["mmsi"]
            if mmsi not in ships:
                continue
            seen.setdefault(mmsi, {}).update(upd)
            if "lat" in upd:
                with_pos.add(mmsi)
            if len(with_pos) == len(ships) and time.monotonic() - start >= LISTEN_MIN_S:
                return

    try:
        await asyncio.wait_for(run(), LISTEN_MAX_S)
    except asyncio.TimeoutError:
        pass
    return seen


def save(ships: dict[str, str], seen: dict[str, dict], now: float) -> list[str]:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        latest = json.loads(LATEST.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        latest = {"ships": {}}

    new_csv = not CSV_FILE.exists()
    reported = []
    with CSV_FILE.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new_csv:
            writer.writerow(CSV_COLUMNS)
        for mmsi, label in ships.items():
            state = latest["ships"].get(mmsi, {"mmsi": mmsi})
            upd = seen.get(mmsi, {})
            state.update({k: v for k, v in upd.items() if k != "ts"})
            state["label"] = label or None
            if "lat" in upd:
                state["last_seen"] = iso(upd["ts"])
                reported.append(mmsi)
                writer.writerow([
                    iso(upd["ts"]), mmsi, state.get("name", ""), label,
                    round(upd["lat"], 5), round(upd["lon"], 5),
                    upd.get("sog", ""), upd.get("cog", ""), upd.get("heading", ""),
                    upd.get("nav_status", ""), state.get("destination", ""),
                ])
            latest["ships"][mmsi] = state

    # forget ships removed from ships.json
    latest["ships"] = {m: s for m, s in latest["ships"].items() if m in ships}
    latest["order"] = list(ships)  # keeps ships.json order (and colors) stable in the viewer
    latest["updated"] = iso(now)
    LATEST.write_text(json.dumps(latest, ensure_ascii=False, indent=1), encoding="utf-8")
    return reported


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="simulated ships, no API key needed")
    args = parser.parse_args()

    ships = load_ships()
    if not ships:
        print("ships.json boş; takip edilecek gemi yok.")
        save({}, {}, time.time())
        return 0

    if args.demo:
        provider = DemoProvider()
    else:
        key = api_key()
        if not key:
            print("HATA: AISSTREAM_API_KEY tanımlı değil.", file=sys.stderr)
            return 1
        provider = AisStreamProvider(key)

    print(f"{len(ships)} gemi dinleniyor (en fazla {LISTEN_MAX_S} sn)…")
    try:
        seen = asyncio.run(listen(provider, ships))
    except ProviderError as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        return 1

    reported = save(ships, seen, time.time())
    for mmsi, label in ships.items():
        mark = "✓ konum" if mmsi in reported else "– sinyal yok"
        name = seen.get(mmsi, {}).get("name") or label
        print(f"  {mmsi} {name or ''}: {mark}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
