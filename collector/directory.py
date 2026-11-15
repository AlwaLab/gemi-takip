"""Ship name directory for the search box.

Each collection round listens to the worldwide AIS feed for one full static
cycle (every ship sends name/type/IMO about every 6 minutes) and merges what
it hears into docs/data/directory.json. Position reports are included too:
aisstream attaches the ship name to them, which catches ships whose static
message fell outside the window. The file only grows, one ship per line and
sorted by MMSI, so git diffs stay small.
"""
import asyncio
import json
from pathlib import Path

from server.providers.aisstream import AisStreamProvider

SCAN_TYPES = ["ShipStaticData", "StaticDataReport",
              "PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"]
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
    is_static = any(upd.get(k) for k in ("ship_type", "imo", "callsign"))
    if old[1] and not is_static:
        return False  # position reports only fill gaps; static data owns the name
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
        async for upd in provider.stream(bbox=WORLD, message_types=SCAN_TYPES):
            seen += 1
            changed += merge(entries, upd)

    try:
        await asyncio.wait_for(run(), seconds)
    except asyncio.TimeoutError:
        pass
    return seen, changed
