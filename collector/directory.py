"""Ship name directory for the search box.

Each collection round listens briefly to the worldwide *static* AIS messages
(name, type, IMO, call sign; every ship sends one about every 6 minutes) and
merges them into docs/data/directory.json. The file only grows, one ship per
line and sorted by MMSI, so git diffs stay small.
"""
import asyncio
import json
from pathlib import Path

from server.providers.aisstream import AisStreamProvider

STATIC_TYPES = ["ShipStaticData", "StaticDataReport"]
WORLD = [[-90, -180], [90, 180]]
FIELDS = ["mmsi", "name", "ship_type", "imo", "callsign"]


def load(path: Path) -> dict[str, list]:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {r[0]: r for r in rows}


def save(path: Path, entries: dict[str, list]) -> None:
    lines = [json.dumps(entries[m], ensure_ascii=False, separators=(",", ":")) for m in sorted(entries)]
    path.write_text("[\n" + ",\n".join(lines) + "\n]\n", encoding="utf-8")


def merge(entries: dict[str, list], upd: dict) -> bool:
    """Merge one normalized update. Returns True if anything changed."""
    name = upd.get("name")
    if not name:
        return False
    mmsi = upd["mmsi"]
    old = entries.get(mmsi) or [mmsi, None, None, None, None]
    new = [mmsi, name,
           upd.get("ship_type") or old[2],
           upd.get("imo") or old[3],
           upd.get("callsign") or old[4]]
    if new != old:
        entries[mmsi] = new
        return True
    return False


async def scan(api_key: str, seconds: float, entries: dict[str, list]) -> tuple[int, int]:
    """Listen for `seconds`; returns (messages seen, entries added or changed)."""
    provider = AisStreamProvider(api_key)
    seen = changed = 0

    async def run():
        nonlocal seen, changed
        async for upd in provider.stream(bbox=WORLD, message_types=STATIC_TYPES):
            seen += 1
            changed += merge(entries, upd)

    try:
        await asyncio.wait_for(run(), seconds)
    except asyncio.TimeoutError:
        pass
    return seen, changed
