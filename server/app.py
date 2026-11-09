"""Vessel tracking server.

Run:  python -m server.app   (or start.bat)
Then open http://localhost:8765
"""
import asyncio
import json
import logging
import re
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from .providers import ProviderError, make_provider
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATIC = ROOT / "static"
CONFIG_PATH = DATA / "config.json"
PORT = 8765
MAX_EXPLORE_AREA_DEG2 = 40  # keeps the unfiltered feed to a manageable size
EXPLORE_FLUSH_S = 1.5

log = logging.getLogger("app")


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config(cfg: dict) -> None:
    DATA.mkdir(exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


class Hub:
    """Owns the provider streams and fans updates out to browser sockets."""

    def __init__(self, store: Store):
        self.store = store
        self.config = load_config()
        self.provider = make_provider(self.config)
        self.clients: set[web.WebSocketResponse] = set()
        self.watch_task: asyncio.Task | None = None
        self.explore_task: asyncio.Task | None = None
        self.explore_bbox = None
        self.explore_seen: dict[str, dict] = {}
        self.explore_pending: dict[str, dict] = {}
        self.status = {"watch": "idle", "explore": "off", "error": None}

    # ---- lifecycle -------------------------------------------------------
    def start(self):
        self.restart_watch()
        asyncio.get_running_loop().create_task(self._explore_flusher())

    def set_api_key(self, key: str):
        self.config["aisstream_api_key"] = key.strip()
        save_config(self.config)
        self.provider = make_provider(self.config)
        self.status["error"] = None
        self.restart_watch()
        self.set_explore(self.explore_bbox)

    def restart_watch(self):
        if self.watch_task:
            self.watch_task.cancel()
        mmsis = self.store.watched_mmsis()
        if not mmsis:
            self._set_status(watch="idle")
            self.watch_task = None
            return
        self.watch_task = asyncio.get_running_loop().create_task(self._run_watch(mmsis))

    def set_explore(self, bbox):
        if self.explore_task:
            self.explore_task.cancel()
            self.explore_task = None
        self.explore_bbox = bbox
        self.explore_seen.clear()
        self.explore_pending.clear()
        if not bbox or not self.clients:
            self._set_status(explore="off")
            return
        self.explore_task = asyncio.get_running_loop().create_task(self._run_explore(bbox))

    # ---- stream workers --------------------------------------------------
    async def _run_watch(self, mmsis):
        self._set_status(watch="connecting")
        try:
            first = True
            async for upd in self.provider.stream(mmsis=mmsis):
                if first:
                    self._set_status(watch="live", error=None)
                    first = False
                if upd["mmsi"] not in mmsis:
                    continue
                state = self.store.merge_vessel(upd["mmsi"], upd)
                await self.broadcast({"type": "vessel", "vessel": state,
                                      "point": [upd["ts"], upd["lat"], upd["lon"]] if "lat" in upd else None})
        except asyncio.CancelledError:
            raise
        except ProviderError as exc:
            self._set_status(watch="error", error=str(exc))
        except Exception as exc:  # keep the server alive, surface the problem
            log.exception("watch stream crashed")
            self._set_status(watch="error", error=f"Beklenmeyen hata: {exc}")

    async def _run_explore(self, bbox):
        self._set_status(explore="connecting")
        watched = set(self.store.watched_mmsis())
        try:
            first = True
            async for upd in self.provider.stream(bbox=bbox):
                if first:
                    self._set_status(explore="live")
                    first = False
                mmsi = upd["mmsi"]
                if mmsi in watched:
                    continue
                merged = self.explore_seen.setdefault(mmsi, {"mmsi": mmsi})
                merged.update(upd)
                if "lat" in merged:
                    self.explore_pending[mmsi] = merged
        except asyncio.CancelledError:
            raise
        except ProviderError as exc:
            self._set_status(explore="error", error=str(exc))
        except Exception as exc:
            log.exception("explore stream crashed")
            self._set_status(explore="error", error=f"Beklenmeyen hata: {exc}")

    async def _explore_flusher(self):
        while True:
            await asyncio.sleep(EXPLORE_FLUSH_S)
            if self.explore_pending:
                batch = list(self.explore_pending.values())
                self.explore_pending.clear()
                await self.broadcast({"type": "explore", "vessels": batch})

    # ---- clients ---------------------------------------------------------
    def _set_status(self, **kw):
        self.status.update(kw)
        asyncio.get_running_loop().create_task(self.broadcast(self.status_msg()))

    def status_msg(self):
        return {"type": "status", **self.status,
                "provider": self.provider.name, "demo": self.provider.is_demo}

    async def broadcast(self, msg: dict):
        if not self.clients:
            return
        text = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_str(text)
            except (ConnectionError, RuntimeError):
                self.clients.discard(ws)


# ---- HTTP handlers ---------------------------------------------------------
MMSI_RE = re.compile(r"^\d{9}$")


def hub_of(request) -> Hub:
    return request.app["hub"]


async def index(request):
    return web.FileResponse(STATIC / "index.html")


async def get_config(request):
    hub = hub_of(request)
    key = hub.config.get("aisstream_api_key") or ""
    return web.json_response({
        "provider": hub.provider.name, "demo": hub.provider.is_demo,
        "has_key": bool(key), "key_hint": f"…{key[-4:]}" if len(key) > 8 else "",
    })


async def post_config(request):
    body = await request.json()
    hub_of(request).set_api_key(str(body.get("aisstream_api_key") or ""))
    return await get_config(request)


async def get_watchlist(request):
    hub = hub_of(request)
    items = []
    for w in hub.store.watchlist():
        w["vessel"] = hub.store.vessel(w["mmsi"])
        items.append(w)
    return web.json_response(items)


async def add_watch(request):
    hub = hub_of(request)
    body = await request.json()
    mmsi = str(body.get("mmsi") or "").strip()
    if not MMSI_RE.match(mmsi):
        return web.json_response({"error": "MMSI 9 haneli bir sayı olmalı."}, status=400)
    if mmsi not in hub.store.watched_mmsis() and len(hub.store.watched_mmsis()) >= 50:
        return web.json_response({"error": "En fazla 50 gemi takip edilebilir."}, status=400)
    label = (body.get("label") or "").strip()[:60]
    item = hub.store.add(mmsi, label)
    # carry over what explore mode already knows about this ship
    if mmsi in hub.explore_seen:
        hub.store.merge_vessel(mmsi, hub.explore_seen.pop(mmsi))
    item["vessel"] = hub.store.vessel(mmsi)
    hub.restart_watch()
    return web.json_response(item)


async def remove_watch(request):
    hub = hub_of(request)
    hub.store.remove(request.match_info["mmsi"])
    hub.restart_watch()
    return web.json_response({"ok": True})


async def rename_watch(request):
    hub = hub_of(request)
    body = await request.json()
    hub.store.rename(request.match_info["mmsi"], (body.get("label") or "").strip()[:60])
    return web.json_response({"ok": True})


async def get_track(request):
    hours = float(request.query.get("hours", 72))
    return web.json_response(hub_of(request).store.track(request.match_info["mmsi"], hours))


async def websocket(request):
    hub = hub_of(request)
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    hub.clients.add(ws)
    await ws.send_str(json.dumps(hub.status_msg()))
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            if data.get("type") == "explore":
                hub.set_explore(_checked_bbox(data.get("bbox")))
    finally:
        hub.clients.discard(ws)
        if not hub.clients:
            hub.set_explore(None)
    return ws


def _checked_bbox(bbox):
    try:
        (la1, lo1), (la2, lo2) = bbox
        if abs(la2 - la1) * abs(lo2 - lo1) > MAX_EXPLORE_AREA_DEG2:
            return None
        return [[float(la1), float(lo1)], [float(la2), float(lo2)]]
    except (TypeError, ValueError):
        return None


def make_app() -> web.Application:
    app = web.Application()
    store = Store(DATA / "vessels.db")
    hub = Hub(store)
    app["hub"] = hub

    async def on_startup(_):
        hub.start()

    app.on_startup.append(on_startup)
    app.router.add_get("/", index)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/api/config", get_config)
    app.router.add_post("/api/config", post_config)
    app.router.add_get("/api/watchlist", get_watchlist)
    app.router.add_post("/api/watchlist", add_watch)
    app.router.add_delete("/api/watchlist/{mmsi}", remove_watch)
    app.router.add_patch("/api/watchlist/{mmsi}", rename_watch)
    app.router.add_get("/api/track/{mmsi}", get_track)
    app.router.add_static("/static", STATIC)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    print(f"\n  Gemi Takip çalışıyor:  http://localhost:{PORT}\n")
    web.run_app(make_app(), host="127.0.0.1", port=PORT, print=None)
