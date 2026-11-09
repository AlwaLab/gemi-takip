"""AIS data providers.

Every provider exposes the same async generator:

    async for update in provider.stream(mmsis=[...], bbox=None):
        ...

`update` is a normalized dict (see base.normalize keys). To add a paid
satellite source (Spire, Datalastic, MarineTraffic...), write a new class
with the same `stream` signature and register it in `make_provider`.
"""
from .aisstream import AisStreamProvider
from .base import ProviderError
from .demo import DemoProvider


def make_provider(config: dict):
    key = (config.get("aisstream_api_key") or "").strip()
    if key:
        return AisStreamProvider(key)
    return DemoProvider()


__all__ = ["make_provider", "ProviderError", "AisStreamProvider", "DemoProvider"]
