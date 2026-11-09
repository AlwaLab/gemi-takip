"""aisstream.io live AIS feed (free API key: https://aisstream.io).

Coverage comes mostly from terrestrial receivers, so ships near coasts and
ports report well; mid-ocean ships may go quiet until they near land.
"""
import asyncio
import json
import logging
import time

import aiohttp

from .base import (ProviderError, clean_text, valid_cog, valid_heading,
                   valid_lat_lon, valid_sog)

log = logging.getLogger("aisstream")

URL = "wss://stream.aisstream.io/v0/stream"
MAX_MMSI_FILTER = 50  # aisstream limit per subscription
WORLD = [[[-90, -180], [90, 180]]]
MESSAGE_TYPES = [
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
    "ShipStaticData",
    "StaticDataReport",
]


class AisStreamProvider:
    name = "aisstream.io"
    is_demo = False

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def stream(self, mmsis: list[str] | None = None, bbox=None):
        """Yield normalized updates forever, reconnecting on network errors.

        mmsis: only these vessels (max 50).  bbox: [[lat1, lon1], [lat2, lon2]].
        """
        sub = {
            "APIKey": self.api_key,
            "BoundingBoxes": [bbox] if bbox else WORLD,
            "FilterMessageTypes": MESSAGE_TYPES,
        }
        if mmsis:
            sub["FiltersShipMMSI"] = [str(m) for m in mmsis[:MAX_MMSI_FILTER]]

        backoff = 2
        quick_rejects = 0  # aisstream drops bad keys silently (close 1006, no message)
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(URL, heartbeat=30) as ws:
                        # aisstream requires the subscription within 3 s of connecting
                        await ws.send_str(json.dumps(sub))
                        log.info("connected (%s)", "watch" if mmsis else "explore")
                        opened, received = time.monotonic(), 0
                        async for msg in ws:
                            if msg.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                                break
                            received += 1
                            data = json.loads(msg.data)
                            if "error" in data:
                                raise ProviderError(f"aisstream.io: {data['error']}")
                            update = normalize(data)
                            if update:
                                yield update
                if received == 0 and time.monotonic() - opened < 15:
                    quick_rejects += 1
                    if quick_rejects >= 3:
                        raise ProviderError(
                            "aisstream.io bağlantıyı reddetti. API anahtarı geçersiz olabilir; "
                            "Ayarlar'dan kontrol edin.")
                else:
                    quick_rejects, backoff = 0, 2
                log.warning("connection closed, reconnecting")
            except ProviderError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
                log.warning("stream error: %s; retry in %ss", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def normalize(data: dict) -> dict | None:
    meta = data.get("MetaData") or {}
    mtype = data.get("MessageType")
    body = (data.get("Message") or {}).get(mtype) or {}
    mmsi = meta.get("MMSI") or body.get("UserID")
    if not mmsi:
        return None

    out = {"mmsi": str(mmsi), "ts": time.time()}
    name = clean_text(meta.get("ShipName"))
    if name:
        out["name"] = name

    if mtype in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
        lat, lon = body.get("Latitude"), body.get("Longitude")
        if valid_lat_lon(lat, lon):
            out.update(lat=lat, lon=lon)
        out["sog"] = valid_sog(body.get("Sog"))
        out["cog"] = valid_cog(body.get("Cog"))
        out["heading"] = valid_heading(body.get("TrueHeading"))
        out["msg_class"] = "A" if mtype == "PositionReport" else "B"
        if mtype == "PositionReport":
            out["nav_status"] = body.get("NavigationalStatus")
        if mtype == "ExtendedClassBPositionReport":
            out["name"] = clean_text(body.get("Name")) or out.get("name")
            out["ship_type"] = body.get("Type") or None
            out.update(_dims(body.get("Dimension")))

    elif mtype == "ShipStaticData":
        out["name"] = clean_text(body.get("Name")) or out.get("name")
        out["callsign"] = clean_text(body.get("CallSign"))
        out["imo"] = body.get("ImoNumber") or None
        out["ship_type"] = body.get("Type") or None
        out["destination"] = clean_text(body.get("Destination"))
        draught = body.get("MaximumStaticDraught")
        out["draught"] = draught if draught else None
        out.update(_dims(body.get("Dimension")))
        eta = body.get("Eta") or {}
        if eta.get("Month") and eta.get("Day"):
            out["eta"] = (f"{eta['Day']:02d}.{eta['Month']:02d} "
                          f"{eta.get('Hour', 0):02d}:{eta.get('Minute', 0):02d} UTC")

    elif mtype == "StaticDataReport":
        a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
        if a.get("Valid"):
            out["name"] = clean_text(a.get("Name")) or out.get("name")
        if b.get("Valid"):
            out["callsign"] = clean_text(b.get("CallSign"))
            out["ship_type"] = b.get("ShipType") or None
            out.update(_dims(b.get("Dimension")))

    return {k: v for k, v in out.items() if v is not None}


def _dims(dim) -> dict:
    if not isinstance(dim, dict):
        return {}
    length = (dim.get("A") or 0) + (dim.get("B") or 0)
    width = (dim.get("C") or 0) + (dim.get("D") or 0)
    return {"length": length or None, "width": width or None}
