"""Shared bits for providers.

Normalized update keys (all optional except mmsi and ts):
    mmsi, ts, lat, lon, sog (knots), cog (deg), heading (deg), nav_status (int),
    name, callsign, imo, ship_type (int), destination, eta (str),
    length (m), width (m), draught (m), msg_class ("A" | "B")
"""


class ProviderError(Exception):
    """Fatal provider error (e.g. invalid API key). Not retried."""


def clean_text(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.replace("@", " ").strip()
    return value or None


def valid_lat_lon(lat, lon) -> bool:
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
            and -90 <= lat <= 90 and -180 <= lon <= 180
            and not (lat == 0 and lon == 0))


def valid_sog(sog):
    return sog if isinstance(sog, (int, float)) and 0 <= sog < 102.2 else None


def valid_cog(cog):
    return cog if isinstance(cog, (int, float)) and 0 <= cog < 360 else None


def valid_heading(hdg):
    return hdg if isinstance(hdg, (int, float)) and 0 <= hdg < 360 else None
