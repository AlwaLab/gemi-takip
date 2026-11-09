"""SQLite storage: watchlist, latest vessel state and position history."""
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS watchlist (
    mmsi      TEXT PRIMARY KEY,
    label     TEXT,
    color     TEXT,
    added_at  REAL
);
CREATE TABLE IF NOT EXISTS vessel (
    mmsi       TEXT PRIMARY KEY,
    data       TEXT,          -- JSON blob with latest merged state
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS position (
    mmsi  TEXT,
    ts    REAL,
    lat   REAL,
    lon   REAL,
    sog   REAL,
    cog   REAL
);
CREATE INDEX IF NOT EXISTS idx_position_mmsi_ts ON position (mmsi, ts);
"""

PALETTE = ["#2f7df6", "#e8590c", "#2b8a3e", "#c2255c", "#7048e8",
           "#0c8599", "#e67700", "#5c940d", "#a61e4d", "#1864ab"]

# Keep a point at most this often per vessel, to stop the track table ballooning
MIN_TRACK_INTERVAL_S = 30


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()
        self._last_track_ts: dict[str, float] = {}

    # ---- watchlist -------------------------------------------------------
    def watchlist(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT mmsi, label, color, added_at FROM watchlist ORDER BY added_at").fetchall()
        return [dict(r) for r in rows]

    def watched_mmsis(self) -> list[str]:
        return [r["mmsi"] for r in self.watchlist()]

    def add(self, mmsi: str, label: str | None) -> dict:
        count = self.db.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0]
        color = PALETTE[count % len(PALETTE)]
        self.db.execute(
            "INSERT OR IGNORE INTO watchlist (mmsi, label, color, added_at) VALUES (?, ?, ?, ?)",
            (mmsi, label or None, color, time.time()))
        if label:
            self.db.execute("UPDATE watchlist SET label = ? WHERE mmsi = ?", (label, mmsi))
        self.db.commit()
        row = self.db.execute("SELECT * FROM watchlist WHERE mmsi = ?", (mmsi,)).fetchone()
        return dict(row)

    def remove(self, mmsi: str) -> None:
        self.db.execute("DELETE FROM watchlist WHERE mmsi = ?", (mmsi,))
        self.db.commit()

    def rename(self, mmsi: str, label: str | None) -> None:
        self.db.execute("UPDATE watchlist SET label = ? WHERE mmsi = ?", (label or None, mmsi))
        self.db.commit()

    # ---- vessel state ----------------------------------------------------
    def vessel(self, mmsi: str) -> dict | None:
        row = self.db.execute("SELECT data FROM vessel WHERE mmsi = ?", (mmsi,)).fetchone()
        return json.loads(row["data"]) if row else None

    def merge_vessel(self, mmsi: str, patch: dict) -> dict:
        current = self.vessel(mmsi) or {"mmsi": mmsi}
        current.update({k: v for k, v in patch.items() if v is not None})
        self.db.execute(
            "INSERT INTO vessel (mmsi, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(mmsi) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (mmsi, json.dumps(current), time.time()))

        if "lat" in patch and "lon" in patch:
            ts = patch.get("ts") or time.time()
            if ts - self._last_track_ts.get(mmsi, 0) >= MIN_TRACK_INTERVAL_S:
                self.db.execute(
                    "INSERT INTO position (mmsi, ts, lat, lon, sog, cog) VALUES (?, ?, ?, ?, ?, ?)",
                    (mmsi, ts, patch["lat"], patch["lon"], patch.get("sog"), patch.get("cog")))
                self._last_track_ts[mmsi] = ts
        self.db.commit()
        return current

    def track(self, mmsi: str, since_hours: float = 72) -> list[list[float]]:
        since = time.time() - since_hours * 3600
        rows = self.db.execute(
            "SELECT ts, lat, lon FROM position WHERE mmsi = ? AND ts >= ? ORDER BY ts",
            (mmsi, since)).fetchall()
        return [[r["ts"], r["lat"], r["lon"]] for r in rows]
