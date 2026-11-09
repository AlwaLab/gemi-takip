"""Simulated vessels, used when no API key is configured.

Lets you try the interface before signing up. Everything it produces is
fake and the UI shows a DEMO banner while it is active.
"""
import asyncio
import hashlib
import math
import random
import time

# Starting areas (lat, lon) - all at sea
SEAS = [
    (40.85, 28.90),   # Marmara
    (38.60, 25.40),   # Aegean
    (35.50, 18.00),   # Ionian / central Med
    (36.20, 33.50),   # Eastern Med
    (42.80, 33.50),   # Black Sea
    (54.80, 4.50),    # North Sea
    (30.00, 32.56),   # near Suez
]
TYPES = [70, 71, 80, 60, 79, 84]
DESTS = ["ISTANBUL", "IZMIR", "PIRAEUS", "ROTTERDAM", "CONSTANTA", "MERSIN", "GENOVA"]
TICK_S = 2.0
SPEEDUP = 30  # move 30x faster than real time so motion is visible


def _rng(seed: str) -> random.Random:
    return random.Random(int(hashlib.md5(seed.encode()).hexdigest()[:8], 16))


class _Ship:
    def __init__(self, mmsi: str, lat=None, lon=None):
        r = _rng(mmsi)
        base = SEAS[r.randrange(len(SEAS))]
        self.mmsi = mmsi
        self.lat = lat if lat is not None else base[0] + r.uniform(-0.4, 0.4)
        self.lon = lon if lon is not None else base[1] + r.uniform(-0.6, 0.6)
        self.cog = r.uniform(0, 360)
        self.sog = r.uniform(6, 16)
        self.static = {
            "name": f"DEMO {r.choice(['ATLAS', 'MARMARA', 'POYRAZ', 'YILDIZ', 'KARADENIZ', 'ANADOLU'])} {mmsi[-3:]}",
            "callsign": f"TC{r.randint(1000, 9999)}",
            "imo": r.randint(9000000, 9899999),
            "ship_type": r.choice(TYPES),
            "destination": r.choice(DESTS),
            "length": r.choice([120, 180, 225, 290]),
            "width": r.choice([20, 28, 32, 45]),
            "draught": round(r.uniform(5, 13), 1),
            "eta": f"{r.randint(1, 28):02d}.{r.randint(1, 12):02d} 08:00 UTC",
        }
        self.box = None

    def step(self):
        self.cog = (self.cog + random.uniform(-4, 4)) % 360
        dist_nm = self.sog * (TICK_S * SPEEDUP) / 3600
        rad = math.radians(self.cog)
        self.lat += dist_nm / 60 * math.cos(rad)
        self.lon += dist_nm / 60 * math.sin(rad) / max(math.cos(math.radians(self.lat)), 0.1)
        if self.box:  # bounce inside explore box
            (la1, lo1), (la2, lo2) = self.box
            if not (min(la1, la2) < self.lat < max(la1, la2)) or not (min(lo1, lo2) < self.lon < max(lo1, lo2)):
                self.cog = (self.cog + 180) % 360

    def update(self, with_static: bool) -> dict:
        out = {"mmsi": self.mmsi, "ts": time.time(), "lat": self.lat, "lon": self.lon,
               "sog": round(self.sog, 1), "cog": round(self.cog, 1), "heading": round(self.cog),
               "nav_status": 0, "msg_class": "A", "name": self.static["name"]}
        if with_static:
            out.update(self.static)
        return out


class DemoProvider:
    name = "Demo (simülasyon)"
    is_demo = True

    async def stream(self, mmsis: list[str] | None = None, bbox=None):
        if mmsis:
            ships = [_Ship(m) for m in mmsis]
        elif bbox:
            (la1, lo1), (la2, lo2) = bbox
            r = _rng(f"{la1:.1f}{lo1:.1f}")
            ships = []
            for _ in range(25):
                s = _Ship(str(r.randint(200000000, 799999999)),
                          r.uniform(min(la1, la2), max(la1, la2)),
                          r.uniform(min(lo1, lo2), max(lo1, lo2)))
                s.box = bbox
                ships.append(s)
        else:
            return

        tick = 0
        while True:
            for s in ships:
                if tick:
                    s.step()
                yield s.update(with_static=tick % 30 == 0)
            tick += 1
            await asyncio.sleep(TICK_S)
