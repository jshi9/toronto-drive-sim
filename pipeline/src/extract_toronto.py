"""Offline GIS & road-network extraction pipeline for Toronto Drive Sim.

Downloads drivable OpenStreetMap road networks via OSMnx, cleans road and
intersection attributes (lanes, maxspeed, oneway, highway class, bridge,
tunnel, layer, traffic signals, stop signs, and Overpass turn restrictions),
projects WGS84 coordinates to UTM Zone 17N (EPSG:32617) centered at Yonge &
Dundas, assigns Y elevations via ``elevation.py``, and slices the network into
500 m x 500 m spatial JSON chunks plus a ``manifest.json`` index.

Usage:
    python -m src.extract_toronto
    python -m src.extract_toronto --preset toronto --dem path/to/toronto_dem.tif
"""

from __future__ import annotations

import argparse
import atexit
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import ssl
import tempfile
from typing import Any

import certifi
import networkx as nx
import osmnx as ox
from pyproj import Transformer
import requests

try:
    from .elevation import (
        DEFAULT_UTM_EPSG,
        LAYER_HEIGHT_METERS,
        YONGE_DUNDAS_LAT,
        YONGE_DUNDAS_LON,
        ElevationConfig,
        ElevationSampler,
    )
except ImportError:  # Allow running directly as ``python pipeline/src/extract_toronto.py``
    from elevation import (  # type: ignore[no-redef]
        DEFAULT_UTM_EPSG,
        LAYER_HEIGHT_METERS,
        YONGE_DUNDAS_LAT,
        YONGE_DUNDAS_LON,
        ElevationConfig,
        ElevationSampler,
    )

logger = logging.getLogger(__name__)

# Highway priority order when OSMnx simplifies segments with mixed highway tags
HIGHWAY_PRIORITY: tuple[str, ...] = (
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "road",
)
HIGHWAY_RANK = {name: idx for idx, name in enumerate(HIGHWAY_PRIORITY)}

ARTERIAL_HIGHWAYS = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
}

DEFAULT_LANES_BY_HIGHWAY: dict[str, tuple[int, int]] = {
    # (oneway_lanes, twoway_total_lanes)
    "motorway": (3, 4),
    "motorway_link": (1, 2),
    "trunk": (2, 4),
    "trunk_link": (1, 2),
    "primary": (2, 4),
    "primary_link": (1, 2),
    "secondary": (2, 4),
    "secondary_link": (1, 2),
    "tertiary": (1, 2),
    "tertiary_link": (1, 2),
    "unclassified": (1, 2),
    "residential": (1, 2),
    "living_street": (1, 2),
    "service": (1, 1),
    "road": (1, 2),
}

SIMPLIFY_EDGE_ATTRS_DIFFER: tuple[str, ...] = (
    "lanes",
    "lanes:forward",
    "lanes:backward",
    "lanes:both_ways",
    "lanes:reversible",
    "turn:lanes",
    "turn:lanes:forward",
    "turn:lanes:backward",
    "turn:lanes:both_ways",
    "bus:lanes",
    "bus:lanes:forward",
    "bus:lanes:backward",
    "lanes:bus",
    "lanes:bus:forward",
    "lanes:bus:backward",
    "psv:lanes",
    "psv:lanes:forward",
    "psv:lanes:backward",
    "bus_bay",
    "hov:lanes",
    "hov:lanes:forward",
    "hov:lanes:backward",
    "change:lanes",
    "change:lanes:forward",
    "change:lanes:backward",
    "placement",
    "placement:forward",
    "placement:backward",
    "oneway",
    "highway",
    "maxspeed",
    "maxspeed:conditional",
    "hazard",
    "zone:maxspeed",
    "school:zone",
    "bridge",
    "tunnel",
    "layer",
    "cycleway",
    "cycleway:left",
    "cycleway:right",
    "cycleway:both",
    "cycleway:lane",
    "cycleway:left:lane",
    "cycleway:right:lane",
    "cycleway:both:lane",
    "cycleway:separation",
    "cycleway:left:separation",
    "cycleway:right:separation",
    "railway",
    "embedded_rails",
    "embedded_rails:lanes",
)

PAINTED_BIKE_LANE_VALUES = {"lane", "opposite_lane", "buffered_lane", "yes"}
PROTECTED_BIKE_TRACK_VALUES = {"track", "opposite_track"}
SHARED_BIKE_LANE_VALUES = {"shared_lane", "share_busway"}
FREEWAY_HIGHWAYS = {"motorway", "motorway_link", "trunk_link"}

DEFAULT_MAXSPEED_KMH: dict[str, int] = {
    "motorway": 90,
    "motorway_link": 50,
    "trunk": 60,
    "trunk_link": 50,
    "primary": 50,
    "primary_link": 50,
    "secondary": 50,
    "secondary_link": 50,
    "tertiary": 50,
    "tertiary_link": 40,
    "unclassified": 40,
    "residential": 40,
    "living_street": 30,
    "service": 30,
    "road": 40,
}

SYMBOLIC_SPEED_KMH: dict[str, int] = {
    "ca:on:urban": 50,
    "ca:on:rural": 80,
    "ca:on:motorway": 100,
    "walk": 10,
}

_NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")
_CONDITIONAL_RE = re.compile(r"^([^@]+?)\s*@\s*\((.+)\)\s*$")


@dataclass(frozen=True)
class BoundingBox:
    """Geographic bounding box in WGS84 degrees."""

    south: float
    west: float
    north: float
    east: float

    def as_osmnx_bbox(self) -> tuple[float, float, float, float]:
        """Return ``(left, bottom, right, top)`` expected by OSMnx 2.x."""
        return (self.west, self.south, self.east, self.north)

    def as_overpass_bbox(self) -> str:
        """Return ``south,west,north,east`` string expected by Overpass QL."""
        return f"{self.south},{self.west},{self.north},{self.east}"

    def to_dict(self) -> dict[str, float]:
        return {
            "south": self.south,
            "west": self.west,
            "north": self.north,
            "east": self.east,
        }


BBOX_PRESETS: dict[str, BoundingBox] = {
    "downtown": BoundingBox(south=43.635, west=-79.405, north=43.665, east=-79.365),
    "toronto": BoundingBox(south=43.580, west=-79.640, north=43.855, east=-79.115),
}


@dataclass(frozen=True)
class PipelineConfig:
    """End-to-end extraction pipeline configuration."""

    bbox: BoundingBox = BBOX_PRESETS["toronto"]
    place_name: str | None = "Toronto, Ontario, Canada"
    origin_lat: float = YONGE_DUNDAS_LAT
    origin_lon: float = YONGE_DUNDAS_LON
    utm_epsg: str = DEFAULT_UTM_EPSG
    chunk_size_m: float = 500.0
    dem_path: Path | None = None
    output_dir: Path = Path(__file__).resolve().parents[2] / "sim" / "public" / "map_chunks"
    cache_dir: Path = Path(__file__).resolve().parents[1] / ".cache" / "osmnx"
    use_cache: bool = True
    retain_all: bool = False
    layer_height_m: float = LAYER_HEIGHT_METERS


def _build_windows_ca_bundle() -> str | None:
    """Combine certifi CAs with Windows ROOT certificates when running on Windows.

    Preserves strict TLS verification when local antivirus/enterprise root CAs
    exist in the Windows store without disabling SSL certificate checks.
    """
    if os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE"):
        return os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")

    if os.name != "nt" or not hasattr(ssl, "enum_certificates"):
        return None

    pem_parts = [Path(certifi.where()).read_text(encoding="utf-8")]
    for cert_bytes, encoding, _trust in ssl.enum_certificates("ROOT"):
        if encoding == "x509_asn":
            pem_parts.append(ssl.DER_cert_to_PEM_cert(cert_bytes))

    fd, bundle_path = tempfile.mkstemp(prefix="toronto_sim_ca_", suffix=".pem")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(pem_parts))

    atexit.register(lambda p=bundle_path: os.path.exists(p) and os.remove(p))
    return bundle_path


def configure_osmnx(config: PipelineConfig, ca_bundle: str | None) -> None:
    """Configure OSMnx caching, SSL verification, and retained OSM tags."""
    config.cache_dir.mkdir(parents=True, exist_ok=True)
    ox.settings.use_cache = config.use_cache
    ox.settings.cache_folder = str(config.cache_dir)
    ox.settings.requests_timeout = 300

    if ca_bundle:
        ox.settings.requests_kwargs = {"verify": ca_bundle}

    extra_way_tags = (
        "layer",
        "lanes:forward",
        "lanes:backward",
        "lanes:both_ways",
        "lanes:conditional",
        "turn:lanes",
        "turn:lanes:forward",
        "turn:lanes:backward",
        "turn:lanes:both_ways",
        "bus:lanes",
        "bus:lanes:forward",
        "bus:lanes:backward",
        "lanes:bus",
        "lanes:bus:forward",
        "lanes:bus:backward",
        "psv:lanes",
        "psv:lanes:forward",
        "psv:lanes:backward",
        "bus_bay",
        "hov:lanes",
        "hov:lanes:forward",
        "hov:lanes:backward",
        "change:lanes",
        "change:lanes:forward",
        "change:lanes:backward",
        "motor_vehicle:lanes",
        "bicycle:lanes",
        "placement",
        "placement:forward",
        "placement:backward",
        "maxspeed:advisory",
        "maxspeed:conditional",
        "hazard",
        "zone:maxspeed",
        "school:zone",
        "junction",
        "ref",
        "alt_name",
        "destination:ref",
        "cycleway",
        "cycleway:left",
        "cycleway:right",
        "cycleway:both",
        "cycleway:lane",
        "cycleway:left:lane",
        "cycleway:right:lane",
        "cycleway:both:lane",
        "cycleway:separation",
        "cycleway:left:separation",
        "cycleway:right:separation",
        "cycleway:buffer",
        "railway",
        "tram",
        "embedded_rails",
        "embedded_rails:lanes",
        "width",
    )
    for tag in extra_way_tags:
        if tag not in ox.settings.useful_tags_way:
            ox.settings.useful_tags_way.append(tag)

    extra_node_tags = (
        "traffic_signals",
        "stop",
        "direction",
        "traffic_signals:direction",
        "crossing",
        "crossing:markings",
        "crossing:signals",
        "crossing:island",
        "flashing_lights",
        "railway",
        "crossing:barrier",
        "crossing:light",
        "crossing:saltire",
        "crossing:bell",
        "public_transport",
        "bus",
    )
    for tag in extra_node_tags:
        if tag not in ox.settings.useful_tags_node:
            ox.settings.useful_tags_node.append(tag)


def _flatten_tag_values(value: Any) -> list[str]:
    """Normalize scalar, semicolon-delimited, or list OSM tag values to strings."""
    if value is None:
        return []
    raw_items = value if isinstance(value, (list, tuple, set)) else [value]
    tokens: list[str] = []
    for item in raw_items:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        for part in text.split(";"):
            part_clean = part.strip()
            if part_clean:
                tokens.append(part_clean)
    return tokens


def clean_highway(value: Any) -> str:
    """Normalize OSM ``highway`` tag (including lists from simplified segments)."""
    tokens = _flatten_tag_values(value)
    if not tokens:
        return "unclassified"
    return min(tokens, key=lambda name: HIGHWAY_RANK.get(name, len(HIGHWAY_PRIORITY)))


def clean_oneway(value: Any) -> bool:
    """Normalize OSM ``oneway`` tag to a boolean."""
    tokens = [t.lower() for t in _flatten_tag_values(value)]
    if not tokens:
        return False
    return any(t in {"yes", "true", "1", "-1"} for t in tokens)


def clean_bool_tag(value: Any) -> bool:
    """Normalize OSM boolean-like tags such as ``bridge`` or ``tunnel``."""
    tokens = [t.lower() for t in _flatten_tag_values(value)]
    return any(t not in {"no", "false", "0", "none"} for t in tokens)


def clean_layer(value: Any) -> int:
    """Normalize OSM ``layer`` tag to an integer (defaulting to 0)."""
    parsed: list[int] = []
    for token in _flatten_tag_values(value):
        try:
            parsed.append(int(float(token)))
        except ValueError:
            continue
    if not parsed:
        return 0
    return max(parsed, key=lambda lv: (abs(lv), lv))


def _parse_int_tag_list(value: Any) -> list[int]:
    parsed: list[int] = []
    for token in _flatten_tag_values(value):
        match = _NUMBER_RE.search(token)
        if match:
            val = int(round(float(match.group(0))))
            if val > 0:
                parsed.append(val)
    return parsed


def _select_representative_lanes(vals: list[int], highway: str) -> int:
    """Choose the representative lane count from a list of simplified way lane tags."""
    if not vals:
        return 1
    counts = Counter(vals)
    max_freq = max(counts.values())
    modes = [lane for lane, freq in counts.items() if freq == max_freq]
    if len(modes) == 1:
        chosen = modes[0]
    else:
        sorted_vals = sorted(vals)
        chosen = sorted_vals[len(sorted_vals) // 2]
    if highway == "motorway" and chosen == 1 and max(vals) >= 2:
        chosen = max(2, min(v for v in vals if v >= 2))
    return max(1, chosen)


def _count_pipe_lanes(value: Any) -> int | None:
    """Count lane slots from pipe-delimited OSM tags such as ``turn:lanes:forward``."""
    if value is None:
        return None
    items = list(value) if isinstance(value, (list, tuple, set)) else [value]
    counts: list[int] = []
    for item in items:
        if not item:
            continue
        text = str(item).strip()
        if "|" in text:
            counts.append(len(text.split("|")))
    return Counter(counts).most_common(1)[0][0] if counts else None


def parse_directional_lanes(
    data: dict[str, Any],
    highway: str,
    oneway: bool,
) -> tuple[int, int, int, int, int]:
    """Return ``(lanes_total, lanes_forward, lanes_backward, lanes_both_ways, lanes_reversible)``."""
    total_vals = _parse_int_tag_list(data.get("lanes"))
    fwd_vals = _parse_int_tag_list(data.get("lanes:forward"))
    rev_vals = _parse_int_tag_list(data.get("lanes:backward"))
    both_vals = _parse_int_tag_list(data.get("lanes:both_ways"))
    has_turn_both = bool(_flatten_tag_values(data.get("turn:lanes:both_ways")))

    oneway_default, twoway_default = DEFAULT_LANES_BY_HIGHWAY.get(highway, (1, 2))

    if oneway:
        if total_vals:
            total = _select_representative_lanes(total_vals, highway)
        elif fwd_vals:
            total = _select_representative_lanes(fwd_vals, highway)
        else:
            inferred_turn = _count_pipe_lanes(data.get("turn:lanes")) or _count_pipe_lanes(
                data.get("turn:lanes:forward")
            )
            total = inferred_turn if (inferred_turn and inferred_turn >= 1) else oneway_default
        return total, total, 0, 0, 0

    # Strict TWLTL: ONLY generate a center two-way left-turn lane where OSM explicitly tags it
    both = 1 if ((both_vals and max(both_vals) >= 1) or has_turn_both) else 0
    reversible = 0

    if not fwd_vals:
        inferred_fwd = _count_pipe_lanes(data.get("turn:lanes:forward"))
        if inferred_fwd and inferred_fwd >= 1:
            fwd_vals = [inferred_fwd]
    if not rev_vals:
        inferred_rev = _count_pipe_lanes(data.get("turn:lanes:backward"))
        if inferred_rev and inferred_rev >= 1:
            rev_vals = [inferred_rev]

    if fwd_vals and rev_vals:
        fwd = _select_representative_lanes(fwd_vals, highway)
        rev = _select_representative_lanes(rev_vals, highway)
        rep_total = _select_representative_lanes(total_vals, highway) if total_vals else 0
        # e.g. Jarvis St: lanes=5, lanes:forward=2, lanes:backward=2 (reversible center lane, NOT TWLTL)
        if both == 0 and rep_total == fwd + rev + 1 and highway in {"primary", "secondary", "tertiary"}:
            reversible = 1
        total = fwd + rev + both + reversible
        return total, fwd, rev, both, reversible

    if fwd_vals or rev_vals:
        known_fwd = _select_representative_lanes(fwd_vals, highway) if fwd_vals else None
        known_rev = _select_representative_lanes(rev_vals, highway) if rev_vals else None
        raw_total = (
            _select_representative_lanes(total_vals, highway)
            if total_vals
            else max(twoway_default, (known_fwd or 0) + (known_rev or 0) + both)
        )
        if known_fwd is not None:
            rem = raw_total - both - known_fwd
            rev = max(1, rem)
            fwd = known_fwd
        else:
            assert known_rev is not None
            rem = raw_total - both - known_rev
            fwd = max(1, rem)
            rev = known_rev
        return fwd + both + rev, fwd, rev, both, 0

    total = _select_representative_lanes(total_vals, highway) if total_vals else twoway_default
    if total == 1:
        return 1, 1, 1, 0, 0

    if both == 1:
        remaining = max(2, total - 1)
        fwd = remaining // 2
        rev = remaining - fwd
        return fwd + 1 + rev, fwd, rev, 1, 0

    # Never synthesize a TWLTL or odd 2+1 split on local/untagged streets with bare odd `lanes`
    if total >= 3 and total % 2 == 1 and highway in {"residential", "unclassified", "living_street", "service", "road"}:
        total = total - 1

    fwd = max(1, total // 2)
    rev = max(1, total - fwd)
    return fwd + rev, fwd, rev, 0, 0


def clean_lanes(data: dict[str, Any], highway: str, oneway: bool) -> int:
    """Extract total integer lane count, falling back to road-class defaults."""
    total, _, _, _, _ = parse_directional_lanes(data, highway=highway, oneway=oneway)
    return total


def clean_placement(data: dict[str, Any], oneway: bool) -> str | None:
    """Normalize OSM ``placement`` / ``placement:forward`` / ``placement:backward`` tag."""
    candidates = (
        [data.get("placement:forward"), data.get("placement")]
        if oneway
        else [data.get("placement"), data.get("placement:forward"), data.get("placement:backward")]
    )
    for raw in candidates:
        for tok in _flatten_tag_values(raw):
            norm = tok.strip().lower()
            if norm in {"transition"} or re.fullmatch(r"(left_of|middle_of|right_of):\d+", norm):
                return norm
    return None


def _classify_cycleway_tokens(val: Any, sep_val: Any = None) -> str:
    tokens = {t.lower() for t in _flatten_tag_values(val)}
    sep_tokens = {t.lower() for t in _flatten_tag_values(sep_val)}
    has_physical_sep = bool(
        sep_tokens & {"kerb", "curb", "bollard", "planter", "jersey_barrier", "bump", "studs", "flex_post", "yes", "railing"}
    )
    if tokens & PROTECTED_BIKE_TRACK_VALUES:
        return "track"
    if tokens & PAINTED_BIKE_LANE_VALUES:
        return "track" if has_physical_sep else "lane"
    if tokens & SHARED_BIKE_LANE_VALUES:
        return "shared"
    return "none"


def clean_cycleway(data: dict[str, Any], oneway: bool) -> tuple[bool, bool, bool, str, str]:
    """Return ``(has_bike_lane, bike_lane_left, bike_lane_right, left_type, right_type)``."""
    both_type = _classify_cycleway_tokens(data.get("cycleway:both"))
    base_type = _classify_cycleway_tokens(data.get("cycleway"), data.get("cycleway:separation"))
    left_type = _classify_cycleway_tokens(data.get("cycleway:left"), data.get("cycleway:left:separation"))
    right_type = _classify_cycleway_tokens(data.get("cycleway:right"), data.get("cycleway:right:separation"))

    if left_type == "none" and both_type != "none":
        left_type = both_type
    if right_type == "none" and both_type != "none":
        right_type = both_type

    if base_type != "none" and left_type == "none" and right_type == "none":
        if oneway:
            right_type = base_type
        else:
            left_type = base_type
            right_type = base_type

    left = left_type in {"lane", "track"}
    right = right_type in {"lane", "track"}
    return (left or right), left, right, left_type, right_type


def _is_direct_streetcar_edge(data: dict[str, Any]) -> bool:
    rw_vals = {t.lower() for t in _flatten_tag_values(data.get("railway"))}
    emb_vals = {t.lower() for t in _flatten_tag_values(data.get("embedded_rails"))}
    emb_lanes = {t.lower() for raw in _flatten_tag_values(data.get("embedded_rails:lanes")) for t in raw.split("|")}
    tram_vals = {t.lower() for t in _flatten_tag_values(data.get("tram"))}
    return bool(
        rw_vals & {"tram", "light_rail"}
        or emb_vals & {"tram", "yes"}
        or emb_lanes & {"tram", "yes"}
        or "yes" in tram_vals
    )


def _normalize_turn_slot(token: str, *, preserve_slight: bool = False) -> str:
    """Normalize a single OSM turn:lanes cell into canonical directions."""
    t = token.strip().lower()
    if not t or t in {"none", "no", "unknown", "one"}:
        return "none"
    parts: list[str] = []
    for raw_sub in t.split(";"):
        sub = raw_sub.strip()
        if sub in {"slight_left", "merge_to_left"} and preserve_slight:
            norm = sub
        elif sub in {"slight_right", "merge_to_right"} and preserve_slight:
            norm = sub
        elif sub in {"left", "slight_left", "sharp_left", "only_left"}:
            norm = "left"
        elif sub in {"right", "slight_right", "sharp_right"}:
            norm = "right"
        elif sub in {"through", "straight"}:
            norm = "through"
        elif sub == "reverse":
            norm = "left"
        else:
            continue
        if norm not in parts:
            parts.append(norm)
    if not parts:
        return "none"
    rank_order = (
        "left",
        "slight_left",
        "merge_to_left",
        "through",
        "slight_right",
        "merge_to_right",
        "right",
    )
    ordered = [d for d in rank_order if d in parts]
    return ";".join(ordered) if ordered else "none"


def _fit_turn_slots(slots: list[str], target_lanes: int) -> list[str] | None:
    """Fit parsed turn-lane slots to target_lanes while preserving outer left/right bays."""
    if not slots or target_lanes <= 0:
        return None
    if not any(s != "none" for s in slots):
        return None
    if len(slots) == target_lanes:
        return slots
    out = ["none"] * target_lanes
    if "left" in slots[0] or slots[0] != "none":
        out[0] = slots[0]
    if target_lanes >= 2 and ("right" in slots[-1] or slots[-1] != "none"):
        out[-1] = slots[-1]
    if target_lanes >= 3:
        inner_src = slots[1:-1]
        for idx in range(1, target_lanes - 1):
            if idx - 1 < len(inner_src):
                out[idx] = inner_src[idx - 1]
    return out if any(s != "none" for s in out) else None


def clean_turn_lanes(
    data: dict[str, Any],
    oneway: bool,
    fwd_lanes: int,
    rev_lanes: int,
    highway: str = "",
) -> tuple[list[str] | None, list[str] | None]:
    """Extract forward (arriving at v) and reverse (arriving at u) turn:lanes arrays."""
    preserve_slight = highway in FREEWAY_HIGHWAYS or highway in {"trunk"}

    def _pick_spec(raw: Any, pick_last: bool) -> list[str] | None:
        if raw is None:
            return None
        items = list(raw) if isinstance(raw, (list, tuple)) else [raw]
        ordered = reversed(items) if pick_last else iter(items)
        for item in ordered:
            if not item:
                continue
            text = str(item).strip()
            if "|" in text or text.lower() in {"left", "through", "right", "slight_left", "slight_right"}:
                cells = [_normalize_turn_slot(c, preserve_slight=preserve_slight) for c in text.split("|")]
                if any(c != "none" for c in cells):
                    return cells
        return None

    fwd_raw = _pick_spec(data.get("turn:lanes:forward"), True) or _pick_spec(data.get("turn:lanes"), True)
    fwd = _fit_turn_slots(fwd_raw, fwd_lanes) if fwd_raw else None

    if oneway or rev_lanes <= 0:
        return fwd, None

    rev_raw = _pick_spec(data.get("turn:lanes:backward"), False)
    rev = _fit_turn_slots(rev_raw, rev_lanes) if rev_raw else None
    return fwd, rev


def _fit_bool_lane_mask(mask: list[bool], target_lanes: int) -> list[bool] | None:
    if not mask or target_lanes <= 0 or not any(mask):
        return None
    if len(mask) == target_lanes:
        return mask
    out = [False] * target_lanes
    if mask[0]:
        out[0] = True
    if mask[-1]:
        out[-1] = True
    if target_lanes >= 3:
        for i in range(1, target_lanes - 1):
            if i < len(mask) and mask[i]:
                out[i] = True
    return out if any(out) else None


def parse_bus_and_hov_lanes(
    data: dict[str, Any],
    oneway: bool,
    fwd_lanes: int,
    rev_lanes: int,
) -> tuple[list[bool] | None, list[bool] | None, list[bool] | None, list[str] | None]:
    """Parse RapidTO bus lanes, HOV lanes, and lane-change rules."""
    def _parse_pipe_designated(
        raw: Any,
        mv_raw: Any = None,
        *,
        bidirectional_bare: bool = False,
        target_lanes: int = 0,
    ) -> list[bool] | None:
        if raw is None:
            return None
        items = list(raw) if isinstance(raw, (list, tuple)) else [raw]
        mv_items = list(mv_raw) if isinstance(mv_raw, (list, tuple)) else [mv_raw]
        mv_cells: list[str] = []
        for mv in mv_items:
            if mv and "|" in str(mv):
                mv_cells = [c.strip().lower() for c in str(mv).split("|")]
                break
        for item in items:
            if not item or "|" not in str(item):
                continue
            cells = [c.strip().lower() for c in str(item).split("|")]
            if bidirectional_bare and target_lanes > 0 and len(cells) != target_lanes:
                continue
            mask = []
            for idx, cell in enumerate(cells):
                is_des = "designated" in cell or (
                    cell == "yes" and idx < len(mv_cells) and mv_cells[idx] in {"no", "psv", "bus"}
                )
                mask.append(is_des)
            if any(mask):
                return mask
        return None

    fwd_mv = data.get("motor_vehicle:lanes:forward") or data.get("motor_vehicle:lanes")
    rev_mv = data.get("motor_vehicle:lanes:backward") or data.get("motor_vehicle:lanes")

    bus_fwd_raw = (
        _parse_pipe_designated(data.get("bus:lanes:forward"), fwd_mv)
        or _parse_pipe_designated(data.get("psv:lanes:forward"), fwd_mv)
        or _parse_pipe_designated(
            data.get("bus:lanes"),
            fwd_mv,
            bidirectional_bare=not oneway,
            target_lanes=fwd_lanes,
        )
        or _parse_pipe_designated(
            data.get("psv:lanes"),
            fwd_mv,
            bidirectional_bare=not oneway,
            target_lanes=fwd_lanes,
        )
    )
    if bus_fwd_raw is None:
        bus_cnt_fwd = _parse_int_tag_list(data.get("lanes:bus:forward")) or (
            _parse_int_tag_list(data.get("lanes:bus")) if oneway else []
        )
        if bus_cnt_fwd and fwd_lanes >= 2:
            cnt = min(fwd_lanes - 1, max(bus_cnt_fwd))
            bus_fwd_raw = [False] * (fwd_lanes - cnt) + [True] * cnt
    bus_fwd = _fit_bool_lane_mask(bus_fwd_raw, fwd_lanes) if bus_fwd_raw else None

    bus_rev: list[bool] | None = None
    if not oneway and rev_lanes > 0:
        bus_rev_raw = (
            _parse_pipe_designated(data.get("bus:lanes:backward"), rev_mv)
            or _parse_pipe_designated(data.get("psv:lanes:backward"), rev_mv)
        )
        if bus_rev_raw is None:
            bus_cnt_rev = _parse_int_tag_list(data.get("lanes:bus:backward"))
            if bus_cnt_rev and rev_lanes >= 2:
                cnt = min(rev_lanes - 1, max(bus_cnt_rev))
                bus_rev_raw = [False] * (rev_lanes - cnt) + [True] * cnt
        bus_rev = _fit_bool_lane_mask(bus_rev_raw, rev_lanes) if bus_rev_raw else None

    hov_raw = (
        _parse_pipe_designated(data.get("hov:lanes:forward"))
        or _parse_pipe_designated(
            data.get("hov:lanes"),
            bidirectional_bare=not oneway,
            target_lanes=fwd_lanes,
        )
    )
    hov_fwd = _fit_bool_lane_mask(hov_raw, fwd_lanes) if hov_raw else None

    change_fwd: list[str] | None = None
    raw_chg = data.get("change:lanes:forward") or (data.get("change:lanes") if oneway else None)
    if raw_chg:
        items = list(raw_chg) if isinstance(raw_chg, (list, tuple)) else [raw_chg]
        for item in items:
            if item and "|" in str(item):
                cells = [c.strip().lower() or "yes" for c in str(item).split("|")]
                if len(cells) == fwd_lanes:
                    change_fwd = cells
                    break

    return bus_fwd, bus_rev, hov_fwd, change_fwd


def clean_school_zone_tag(data: dict[str, Any]) -> bool:
    """Detect explicit OSM school-zone hazard or speed tags on a way."""
    for tok in _flatten_tag_values(data.get("hazard")):
        if "school" in tok.lower():
            return True
    for key in ("zone:maxspeed", "school:zone", "maxspeed:conditional"):
        for tok in _flatten_tag_values(data.get(key)):
            low = tok.lower()
            if "school" in low or ("@" in low and ("30" in low or "40" in low)):
                return True
    return False


def clean_maxspeed_kmh(value: Any, highway: str) -> int:
    """Parse OSM ``maxspeed`` into integer km/h with Ontario urban defaults."""
    speeds_kmh: list[int] = []
    for token in _flatten_tag_values(value):
        lower = token.lower()
        if lower in SYMBOLIC_SPEED_KMH:
            speeds_kmh.append(SYMBOLIC_SPEED_KMH[lower])
            continue
        match = _NUMBER_RE.search(lower)
        if not match:
            continue
        numeric = float(match.group(0))
        if numeric <= 0:
            continue
        if "mph" in lower:
            speeds_kmh.append(int(round(numeric * 1.60934)))
        else:
            speeds_kmh.append(int(round(numeric)))

    if speeds_kmh:
        return min(speeds_kmh)

    if highway in DEFAULT_MAXSPEED_KMH:
        return DEFAULT_MAXSPEED_KMH[highway]
    return 50 if highway in ARTERIAL_HIGHWAYS else 40


_STREET_ABBREVIATIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bExpressway\b", re.IGNORECASE), "Expy"),
    (re.compile(r"\bParkway\b", re.IGNORECASE), "Pkwy"),
    (re.compile(r"\bBoulevard\b", re.IGNORECASE), "Blvd"),
    (re.compile(r"\bAvenue\b", re.IGNORECASE), "Ave"),
    (re.compile(r"\bStreet\b", re.IGNORECASE), "St"),
    (re.compile(r"\bCrescent\b", re.IGNORECASE), "Cres"),
    (re.compile(r"\bRoad\b", re.IGNORECASE), "Rd"),
    (re.compile(r"\bDrive\b", re.IGNORECASE), "Dr"),
    (re.compile(r"\bCourt\b", re.IGNORECASE), "Ct"),
    (re.compile(r"\bPlace\b", re.IGNORECASE), "Pl"),
    (re.compile(r"\bSquare\b", re.IGNORECASE), "Sq"),
    (re.compile(r"\bTerrace\b", re.IGNORECASE), "Terr"),
    (re.compile(r"\bTrail\b", re.IGNORECASE), "Trl"),
    (re.compile(r"\bCircle\b", re.IGNORECASE), "Cir"),
    (re.compile(r"\bLane\b", re.IGNORECASE), "Ln"),
    (re.compile(r"\bNorth\b", re.IGNORECASE), "N"),
    (re.compile(r"\bSouth\b", re.IGNORECASE), "S"),
    (re.compile(r"\bEast\b", re.IGNORECASE), "E"),
    (re.compile(r"\bWest\b", re.IGNORECASE), "W"),
)


def clean_name(value: Any) -> str | None:
    """Collapse string or list road names into a single display string."""
    tokens = _flatten_tag_values(value)
    if not tokens:
        return None
    unique: list[str] = []
    for token in tokens:
        if token not in unique:
            unique.append(token)
    return " / ".join(unique)


def normalize_street_label(raw_label: str) -> str:
    """Abbreviate standard Toronto street suffixes and cardinal directions."""
    label = raw_label.strip()
    for pattern, repl in _STREET_ABBREVIATIONS:
        label = pattern.sub(repl, label)
    return re.sub(r"\s+", " ", label).strip()


def _format_highway_ref(ref_value: Any) -> str | None:
    """Format OSM ``ref`` tags into readable highway badges (e.g. ``Hwy 401``, ``DVP``)."""
    tokens = _flatten_tag_values(ref_value)
    if not tokens:
        return None
    formatted: list[str] = []
    for tok in tokens:
        upper = tok.upper()
        if upper in {"DVP", "QEW", "FGG", "ALLEN"}:
            candidate = upper
        elif re.fullmatch(r"\d+[A-Z]?", upper):
            candidate = f"Hwy {upper}"
        elif upper.startswith("ON ") or upper.startswith("ON-"):
            candidate = f"Hwy {tok[3:].strip()}"
        else:
            candidate = tok
        if candidate not in formatted:
            formatted.append(candidate)
    return " / ".join(formatted) if formatted else None


def clean_street_name(data: dict[str, Any]) -> str | None:
    """Extract normalized display street name from ``name``, ``ref``, or ``alt_name``."""
    raw_name = clean_name(data.get("name"))
    if raw_name:
        return normalize_street_label(raw_name)

    ref_label = _format_highway_ref(data.get("ref"))
    if ref_label:
        return normalize_street_label(ref_label)

    alt_name = clean_name(data.get("alt_name"))
    if alt_name:
        return normalize_street_label(alt_name)

    return None


def clean_osm_way_ids(value: Any) -> list[int]:
    """Normalize OSMnx ``osmid`` edge attribute into a list of integer way IDs."""
    ids: list[int] = []
    raw_items = value if isinstance(value, (list, tuple, set)) else [value]
    for item in raw_items:
        if item is None:
            continue
        try:
            way_id = int(item)
            if way_id not in ids:
                ids.append(way_id)
        except (TypeError, ValueError):
            continue
    return ids


def download_turn_restrictions(
    bbox: BoundingBox,
    cache_dir: Path,
    use_cache: bool,
    ca_bundle: str | None,
) -> list[dict[str, Any]]:
    """Query Overpass API for ``type=restriction`` relations within ``bbox``."""
    cache_key = hashlib.sha256(f"restrictions:{bbox.as_overpass_bbox()}".encode("utf-8")).hexdigest()[:16]
    cache_file = cache_dir / f"turn_restrictions_{cache_key}.json"
    if use_cache and cache_file.exists():
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        return list(cached.get("elements", []))

    query = (
        f"[out:json][timeout:180];"
        f"(relation[type=restriction]({bbox.as_overpass_bbox()}););"
        f"out body;"
    )
    url = ox.settings.overpass_url.rstrip("/") + "/interpreter"
    headers = ox._http._get_http_headers()
    response = requests.post(
        url,
        data={"data": query},
        headers=headers,
        timeout=210,
        verify=ca_bundle if ca_bundle else True,
    )
    response.raise_for_status()
    payload = response.json()
    elements = list(payload.get("elements", []))

    if use_cache:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(payload), encoding="utf-8")

    return elements


def _parse_restriction_tag(tags: dict[str, Any]) -> tuple[str | None, str | None]:
    """Extract base restriction type and optional time schedule condition."""
    raw = tags.get("restriction")
    if not raw:
        for k, v in tags.items():
            if k.startswith("restriction:") and v:
                raw = v
                break
    if not raw:
        return None, None

    text = str(raw).strip()
    match = _CONDITIONAL_RE.match(text)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return text, None


def attach_turn_restrictions(
    graph: nx.MultiDiGraph,
    restriction_elements: list[dict[str, Any]],
) -> int:
    """Resolve OSM turn-restriction relations onto graph nodes and directed edges."""
    attached_count = 0
    for node_id in graph.nodes:
        graph.nodes[node_id]["turn_restrictions"] = []
    for _, _, _, data in graph.edges(keys=True, data=True):
        data["turn_restrictions"] = []

    for rel in restriction_elements:
        tags = rel.get("tags", {})
        rtype, condition = _parse_restriction_tag(tags)
        if not rtype:
            continue

        members = rel.get("members", [])
        from_ways = [int(m["ref"]) for m in members if m.get("role") == "from" and m.get("type") == "way"]
        to_ways = [int(m["ref"]) for m in members if m.get("role") == "to" and m.get("type") == "way"]
        via_nodes = [int(m["ref"]) for m in members if m.get("role") == "via" and m.get("type") == "node"]

        if not from_ways or not to_ways or not via_nodes:
            continue

        for via_node in via_nodes:
            if via_node not in graph.nodes:
                continue

            in_matches = [
                f"{u}_{v}_{k}"
                for u, v, k, d in graph.in_edges(via_node, keys=True, data=True)
                if any(w in d["osm_way_ids"] for w in from_ways)
            ]
            out_matches = [
                f"{u}_{v}_{k}"
                for u, v, k, d in graph.out_edges(via_node, keys=True, data=True)
                if any(w in d["osm_way_ids"] for w in to_ways)
            ]
            if not in_matches or not out_matches:
                continue

            entry: dict[str, Any] = {
                "relation_id": int(rel["id"]),
                "type": rtype,
                "from_edge_ids": in_matches,
                "to_edge_ids": out_matches,
                "from_way_ids": from_ways,
                "to_way_ids": to_ways,
            }
            if condition:
                entry["condition"] = condition
            if tags.get("except"):
                entry["except"] = str(tags["except"])

            graph.nodes[via_node]["turn_restrictions"].append(entry)
            attached_count += 1

            for u, v, k, d in graph.in_edges(via_node, keys=True, data=True):
                edge_id = f"{u}_{v}_{k}"
                if edge_id in in_matches:
                    d["turn_restrictions"].append(
                        {
                            "relation_id": int(rel["id"]),
                            "via_node": int(via_node),
                            "type": rtype,
                            "to_edge_ids": out_matches,
                            **({"condition": condition} if condition else {}),
                            **({"except": str(tags["except"])} if tags.get("except") else {}),
                        }
                    )

    return attached_count


def _point_to_polyline_dist_m(px: float, pz: float, pts_xz: list[tuple[float, float]]) -> float:
    """Compute minimum Euclidean distance (meters) from point (px, pz) to a 2D polyline."""
    best_sq = float("inf")
    for i in range(len(pts_xz) - 1):
        ax, az = pts_xz[i]
        bx, bz = pts_xz[i + 1]
        dx = bx - ax
        dz = bz - az
        seg_len_sq = dx * dx + dz * dz
        if seg_len_sq <= 1e-9:
            t = 0.0
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / seg_len_sq))
        cx = ax + t * dx
        cz = az + t * dz
        dist_sq = (px - cx) ** 2 + (pz - cz) ** 2
        if dist_sq < best_sq:
            best_sq = dist_sq
    return math.sqrt(best_sq) if best_sq < float("inf") else float("inf")


def _extract_midblock_controls(
    raw_graph: nx.MultiDiGraph,
    to_local_xz: Any,
    sampler: ElevationSampler,
) -> dict[int, list[dict[str, Any]]]:
    """Identify traffic_signals, stop, and marked pedestrian crossing nodes along ways."""
    controls_by_way: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for node_id, data in raw_graph.nodes(data=True):
        hw = str(data.get("highway") or "").strip().lower()
        crossing_val = str(data.get("crossing") or "").strip().lower()
        crossing_mark = str(data.get("crossing:markings") or "").strip().lower()
        crossing_sig = str(data.get("crossing:signals") or "").strip().lower()
        is_explicit_unmarked = crossing_val in {"unmarked", "no", "none"} or crossing_mark in {"no", "none"}
        is_crossing = (hw == "crossing" or bool(crossing_val)) and not is_explicit_unmarked
        if hw not in {"traffic_signals", "stop"} and not is_crossing:
            continue

        # Crossings always belong on ways; signals/stops here capture contracted degree-2 controls
        neighbors = set(raw_graph.predecessors(node_id)) | set(raw_graph.successors(node_id))
        if not is_crossing and len(neighbors) > 2:
            continue

        lon = float(data["x"])
        lat = float(data["y"])
        x_m, z_m = to_local_xz(lon, lat)
        y_m = sampler.sample_ground(x_m, z_m)

        way_ids: set[int] = set()
        for _, _, edata in raw_graph.in_edges(node_id, data=True):
            way_ids.update(clean_osm_way_ids(edata.get("osmid")))
        for _, _, edata in raw_graph.out_edges(node_id, data=True):
            way_ids.update(clean_osm_way_ids(edata.get("osmid")))

        ctrl_type = hw if hw in {"traffic_signals", "stop"} else "crossing"
        has_signals = (
            ctrl_type == "traffic_signals"
            or crossing_val == "traffic_signals"
            or crossing_sig == "yes"
            or str(data.get("flashing_lights") or "").strip().lower() in {"yes", "button"}
        )
        raw_mark = crossing_mark or crossing_val or "ladder"
        if "lines" in raw_mark or "transverse" in raw_mark:
            norm_mark = "lines"
        elif "unmarked" in raw_mark or raw_mark in {"no", "none"}:
            norm_mark = "none"
        else:
            norm_mark = "ladder"

        record: dict[str, Any] = {
            "osm_node_id": int(node_id),
            "type": ctrl_type,
            "has_signals": has_signals,
            "markings": norm_mark,
            "position": [round(x_m, 3), round(y_m, 3), round(z_m, 3)],
        }
        for wid in way_ids:
            controls_by_way[wid].append(record)

    return controls_by_way


def _clean_junction(value: Any) -> str:
    tokens = [t.lower() for t in _flatten_tag_values(value)]
    return tokens[0] if tokens else ""


def _point_lateral_dist_m(
    px: float,
    pz: float,
    tangent_xz: tuple[float, float],
    other_pts: list[tuple[float, float]],
    *,
    opposite_only: bool = True,
    min_abs_dot: float = 0.82,
) -> float:
    """Return lateral perpendicular distance to a parallel/opposite segment of ``other_pts``."""
    best = float("inf")
    tx, tz = tangent_xz
    for i in range(len(other_pts) - 1):
        ax, az = other_pts[i]
        bx, bz = other_pts[i + 1]
        dx = bx - ax
        dz = bz - az
        seg_len_sq = dx * dx + dz * dz
        if seg_len_sq <= 1e-6:
            continue
        t = ((px - ax) * dx + (pz - az) * dz) / seg_len_sq
        if 0.0 <= t <= 1.0:
            seg_len = math.sqrt(seg_len_sq)
            dot = tx * (dx / seg_len) + tz * (dz / seg_len)
            aligned = (dot < -min_abs_dot) if opposite_only else (abs(dot) >= min_abs_dot)
            if aligned:
                cx = ax + t * dx
                cz = az + t * dz
                dist = math.hypot(px - cx, pz - cz)
                if dist < best:
                    best = dist
    return best


def _point_lateral_opposite_dist_m(
    px: float,
    pz: float,
    tangent_xz: tuple[float, float],
    other_pts: list[tuple[float, float]],
) -> float:
    """Return lateral perpendicular distance to an opposite-direction segment of ``other_pts``."""
    return _point_lateral_dist_m(px, pz, tangent_xz, other_pts, opposite_only=True, min_abs_dot=0.82)


def _sample_polyline_with_tangent(
    pts_xz: list[tuple[float, float]],
    frac: float,
) -> tuple[float, float, tuple[float, float]]:
    """Sample position and unit tangent at normalized arc-length ``frac`` in [0, 1]."""
    if len(pts_xz) < 2:
        p = pts_xz[0] if pts_xz else (0.0, 0.0)
        return p[0], p[1], (1.0, 0.0)
    dists = [0.0]
    for i in range(1, len(pts_xz)):
        dists.append(dists[-1] + math.hypot(pts_xz[i][0] - pts_xz[i - 1][0], pts_xz[i][1] - pts_xz[i - 1][1]))
    total = dists[-1]
    if total <= 1e-6:
        return pts_xz[0][0], pts_xz[0][1], (1.0, 0.0)
    target = max(0.0, min(total, frac * total))
    for i in range(1, len(dists)):
        if dists[i] >= target:
            seg = dists[i] - dists[i - 1]
            alpha = (target - dists[i - 1]) / seg if seg > 1e-6 else 0.0
            ax, az = pts_xz[i - 1]
            bx, bz = pts_xz[i]
            dx, dz = bx - ax, bz - az
            norm = math.hypot(dx, dz) or 1.0
            return ax + dx * alpha, az + dz * alpha, (dx / norm, dz / norm)
    ax, az = pts_xz[-2]
    bx, bz = pts_xz[-1]
    norm = math.hypot(bx - ax, bz - az) or 1.0
    return bx, bz, ((bx - ax) / norm, (bz - az) / norm)


def detect_divided_oneways(graph: nx.MultiDiGraph) -> int:
    """Enforce deterministic one-way status strictly for motorways, links, and roundabouts.

    Never mutates two-way streets by spatial name-proximity matching (which previously
    created asymmetric false one-ways and overlapping ghost meshes in Downtown/Cabbagetown).
    """
    forced_count = 0

    for _u, _v, _k, data in graph.edges(keys=True, data=True):
        hw = str(data["highway_clean"])
        junction = str(data.get("junction_clean") or "")
        already_oneway = bool(data["oneway_clean"])
        is_forced = (
            junction in {"roundabout", "circular"}
            or hw in {"motorway", "motorway_link", "trunk_link"}
        )
        if is_forced and not already_oneway:
            data["oneway_clean"] = True
            total, fwd, rev, both, rev_center = parse_directional_lanes(data, highway=hw, oneway=True)
            data["lanes_clean"] = total
            data["lanes_total"] = total
            data["forward_lanes"] = fwd
            data["reverse_lanes"] = rev
            data["lanes_both_ways"] = both
            data["lanes_reversible"] = rev_center
            tl_fwd, tl_rev = clean_turn_lanes(data, oneway=True, fwd_lanes=fwd, rev_lanes=rev, highway=hw)
            data["turn_lanes_fwd"] = tl_fwd
            data["turn_lanes_rev"] = tl_rev
            has_bike, b_left, b_right, b_left_t, b_right_t = clean_cycleway(data, oneway=True)
            data["has_bike_lane"] = has_bike
            data["bike_lane_left"] = b_left
            data["bike_lane_right"] = b_right
            data["bike_lane_left_type"] = b_left_t
            data["bike_lane_right_type"] = b_right_t
            data["placement_clean"] = clean_placement(data, oneway=True)
            bus_fwd, bus_rev, hov_fwd, chg_fwd = parse_bus_and_hov_lanes(data, oneway=True, fwd_lanes=fwd, rev_lanes=rev)
            data["bus_lanes_forward"] = bus_fwd
            data["bus_lanes_backward"] = bus_rev
            data["hov_lanes_forward"] = hov_fwd
            data["change_lanes_forward"] = chg_fwd
            forced_count += 1

    return forced_count


def _polylines_match_reverse(
    pts_a: list[tuple[float, float]],
    pts_b: list[tuple[float, float]],
    max_dist_m: float = 2.0,
) -> bool:
    """Return True if ``pts_a`` and reversed ``pts_b`` follow the same centerline within 2.0 m."""
    if len(pts_a) < 2 or len(pts_b) < 2:
        return False

    def _poly_len(pts: list[tuple[float, float]]) -> float:
        return sum(
            math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            for i in range(len(pts) - 1)
        )

    len_a = _poly_len(pts_a)
    len_b = _poly_len(pts_b)
    if abs(len_a - len_b) > max(max_dist_m, 0.05 * max(len_a, len_b)):
        return False

    for px, pz in pts_a:
        if _point_to_polyline_dist_m(px, pz, pts_b) > max_dist_m:
            return False
    for px, pz in pts_b:
        if _point_to_polyline_dist_m(px, pz, pts_a) > max_dist_m:
            return False
    return True


def _outgoing_dir_xz(geometry_xyz: list[list[float]], from_start: bool) -> list[float]:
    """Compute horizontal unit direction vector pointing away from an endpoint."""
    if len(geometry_xyz) < 2:
        return [1.0, 0.0]
    if from_start:
        ax, _, az = geometry_xyz[0]
        for pt in geometry_xyz[1:]:
            dx = pt[0] - ax
            dz = pt[2] - az
            norm = math.hypot(dx, dz)
            if norm > 1e-4:
                return [round(dx / norm, 6), round(dz / norm, 6)]
    else:
        ax, _, az = geometry_xyz[-1]
        for pt in reversed(geometry_xyz[:-1]):
            dx = pt[0] - ax
            dz = pt[2] - az
            norm = math.hypot(dx, dz)
            if norm > 1e-4:
                return [round(dx / norm, 6), round(dz / norm, 6)]
    return [1.0, 0.0]


def _edge_width_from_lanes(
    lanes_total: int,
    has_bike_lane: bool,
    bike_left_type: str = "none",
    bike_right_type: str = "none",
) -> float:
    """Compute canonical 1:1 asphalt width (3.5 m/lane + 1.6 m per dedicated bike side)."""
    extra_bike = 0.0
    if bike_left_type in {"lane", "track"}:
        extra_bike += 1.6
    if bike_right_type in {"lane", "track"}:
        extra_bike += 1.6
    if extra_bike == 0.0 and has_bike_lane:
        extra_bike = 1.6
    return round(int(lanes_total) * 3.5 + extra_bike, 3)


def _normalize_corridor_lane_consistency(physical_edges: list[dict[str, Any]]) -> None:
    """Resolve bare untagged odd-lane arterials (3/5/7) against collinear corridor neighbors."""
    by_node: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for edge in physical_edges:
        by_node[int(edge["u"])].append(edge)
        if int(edge["v"]) != int(edge["u"]):
            by_node[int(edge["v"])].append(edge)

    for edge in physical_edges:
        is_bare_odd = bool(edge.pop("_bare_odd_untagged", False))
        if not is_bare_odd or bool(edge["oneway"]):
            continue
        tot = int(edge["lanes_total"])
        if tot < 3 or tot % 2 == 0:
            continue

        hw = str(edge["highway"])
        sname = str(edge.get("street_name") or "").strip().lower()
        u, v = int(edge["u"]), int(edge["v"])
        geom = edge["geometry"]
        dir_u = _outgoing_dir_xz(geom, from_start=True)
        dir_v = _outgoing_dir_xz(geom, from_start=False)

        collinear_twltl = False
        neighbor_evens: list[int] = []
        for ep, ep_dir in ((u, dir_u), (v, dir_v)):
            for cand in by_node[ep]:
                if cand["id"] == edge["id"] or bool(cand["oneway"]):
                    continue
                if sname and str(cand.get("street_name") or "").strip().lower() != sname:
                    continue
                c_geom = cand["geometry"]
                c_dir = _outgoing_dir_xz(c_geom, from_start=(int(cand["u"]) == ep))
                if ep_dir[0] * c_dir[0] + ep_dir[1] * c_dir[1] <= -0.82:
                    if int(cand.get("lanes_both_ways", 0)) == 1 and int(cand["lanes_total"]) == tot:
                        collinear_twltl = True
                    c_tot = int(cand["lanes_total"])
                    if c_tot % 2 == 0:
                        neighbor_evens.append(c_tot)

        # Never promote bare untagged odd lanes to synthetic TWLTLs — split symmetrically to even lanes
        new_tot = max(2, tot - 1)
        if neighbor_evens and all(n == tot + 1 for n in neighbor_evens):
            new_tot = tot + 1
        fwd = new_tot // 2
        rev = new_tot // 2
        both = 0

        total_new = fwd + both + rev
        edge["lanes"] = total_new
        edge["lanes_total"] = total_new
        edge["lanes_forward"] = fwd
        edge["lanes_backward"] = rev
        edge["lanes_both_ways"] = both
        edge["forward_lanes"] = fwd
        edge["reverse_lanes"] = rev
        edge["width_m"] = _edge_width_from_lanes(
            total_new,
            bool(edge.get("has_bike_lane", False)),
            str(edge.get("bike_lane_left_type", "none")),
            str(edge.get("bike_lane_right_type", "none")),
        )


def _extract_highway_gores(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Detect motorway merge/diverge forks and emit gore wedge geometry for OTM V-hatching."""
    by_nl: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for e in physical_edges:
        if not bool(e["oneway"]) or str(e["highway"]) not in FREEWAY_HIGHWAYS | {"trunk"}:
            continue
        by_nl[(int(e["u"]), int(e["layer"]))].append(e)
        if int(e["v"]) != int(e["u"]):
            by_nl[(int(e["v"]), int(e["layer"]))].append(e)

    gores: list[dict[str, Any]] = []
    for (nid, layer), elist in by_nl.items():
        if len(elist) != 3:
            continue
        inc = [e for e in elist if int(e["v"]) == nid]
        out = [e for e in elist if int(e["u"]) == nid]
        if len(inc) == 1 and len(out) == 2:
            mode = "diverge"
            trunk = inc[0]
            branches = out
            trunk_dir_in = _outgoing_dir_xz(trunk["geometry"], from_start=False)
            travel_dir = [-trunk_dir_in[0], -trunk_dir_in[1]]
            b_from_start = True
        elif len(inc) == 2 and len(out) == 1:
            mode = "merge"
            trunk = out[0]
            branches = inc
            travel_dir = _outgoing_dir_xz(trunk["geometry"], from_start=True)
            b_from_start = False
        else:
            continue

        b0, b1 = branches[0], branches[1]
        if float(b0["length_m"]) < 14.0 or float(b1["length_m"]) < 14.0:
            continue
        d0 = _sample_tangent_xz_at_dist(b0["geometry"], min(18.0, float(b0["length_m"]) * 0.5), b_from_start)
        d1 = _sample_tangent_xz_at_dist(b1["geometry"], min(18.0, float(b1["length_m"]) * 0.5), b_from_start)
        sign = 1.0 if mode == "diverge" else -1.0
        dot0 = (d0[0] * travel_dir[0] + d0[1] * travel_dir[1]) * sign
        dot1 = (d1[0] * travel_dir[0] + d1[1] * travel_dir[1]) * sign
        if dot0 < 0.45 or dot1 < 0.45:
            continue

        # Order branch 0/1 left-to-right relative to forward trunk travel_dir (right = (-tz, tx))
        rx, rz = -travel_dir[1], travel_dir[0]
        p0_end = _sample_xyz_along_geom(b0["geometry"], min(22.0, float(b0["length_m"]) * 0.6), b_from_start)
        p1_end = _sample_xyz_along_geom(b1["geometry"], min(22.0, float(b1["length_m"]) * 0.6), b_from_start)
        nd = graph.nodes[nid]
        nx_m, ny_m, nz_m = float(nd["x_m"]), float(nd["y_m"]), float(nd["z_m"])
        proj0 = (p0_end[0] - nx_m) * rx + (p0_end[2] - nz_m) * rz
        proj1 = (p1_end[0] - nx_m) * rx + (p1_end[2] - nz_m) * rz
        b_left, b_right = (b0, b1) if proj0 <= proj1 else (b1, b0)

        w_l = float(b_left["width_m"]) * 0.5
        w_r = float(b_right["width_m"]) * 0.5
        max_s = min(30.0, float(b_left["length_m"]) * 0.65, float(b_right["length_m"]) * 0.65)
        inner_left_pts: list[list[float]] = []
        inner_right_pts: list[list[float]] = []
        apex_pt: list[float] | None = None

        for step in range(1, 16):
            s = max_s * (step / 15.0)
            pl = _sample_xyz_along_geom(b_left["geometry"], s, b_from_start)
            pr = _sample_xyz_along_geom(b_right["geometry"], s, b_from_start)
            tl = _sample_tangent_xz_at_dist(b_left["geometry"], s, b_from_start)
            tr = _sample_tangent_xz_at_dist(b_right["geometry"], s, b_from_start)
            # Inward facing vector from b_left center toward b_right center
            dx_lr, dz_lr = pr[0] - pl[0], pr[2] - pl[2]
            dist_lr = math.hypot(dx_lr, dz_lr)
            if dist_lr <= 1e-4:
                continue
            gap = dist_lr - (w_l + w_r)
            if gap <= 0.15:
                continue
            if apex_pt is None:
                # Start V-nose right where edges begin to separate
                ux, uz = dx_lr / dist_lr, dz_lr / dist_lr
                ax = (pl[0] + ux * w_l + pr[0] - ux * w_r) * 0.5
                az = (pl[2] + uz * w_l + pr[2] - uz * w_r) * 0.5
                apex_pt = [round(ax, 3), round((pl[1] + pr[1]) * 0.5, 3), round(az, 3)]
            # Normal toward center gap for left/right branch
            l_rx, l_rz = (-tl[1], tl[0]) if (-tl[1] * dx_lr + tl[0] * dz_lr) >= 0 else (tl[1], -tl[0])
            r_rx, r_rz = (-tr[1], tr[0]) if (-tr[1] * (-dx_lr) + tr[0] * (-dz_lr)) >= 0 else (tr[1], -tr[0])
            il = [round(pl[0] + l_rx * w_l, 3), round(pl[1], 3), round(pl[2] + l_rz * w_l, 3)]
            ir = [round(pr[0] + r_rx * w_r, 3), round(pr[1], 3), round(pr[2] + r_rz * w_r, 3)]
            inner_left_pts.append(il)
            inner_right_pts.append(ir)
            if gap >= 3.6:
                break

        if apex_pt is not None and len(inner_left_pts) >= 2:
            gores.append(
                {
                    "node_id": int(nid),
                    "layer": int(layer),
                    "mode": mode,
                    "apex": apex_pt,
                    "left_edge": [apex_pt] + inner_left_pts,
                    "right_edge": [apex_pt] + inner_right_pts,
                }
            )
    return gores


def collapse_bidirectional_edges(
    graph: nx.MultiDiGraph,
    tram_grid: dict[tuple[int, int], list[tuple[list[tuple[float, float]], int]]] | None = None,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[int, list[dict[str, Any]]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Collapse reciprocal two-way edges into canonical physical road segments."""
    edge_lookup: dict[tuple[int, int, int], dict[str, Any]] = {}
    edges_by_uv: dict[tuple[int, int], list[int]] = defaultdict(list)
    for u, v, k, data in graph.edges(keys=True, data=True):
        key_tuple = (int(u), int(v), int(k))
        edge_lookup[key_tuple] = data
        edges_by_uv[(int(u), int(v))].append(int(k))

    paired: set[tuple[int, int, int]] = set()
    physical_edges: list[dict[str, Any]] = []
    directed_edges: list[dict[str, Any]] = []

    # Process canonical forward-oriented OSM edges before synthetic reverse duplicates
    ordered_keys = sorted(
        edge_lookup.keys(),
        key=lambda kt: (1 if bool(edge_lookup[kt].get("_is_osm_reverse")) else 0, kt[0], kt[1], kt[2]),
    )

    for key_tuple in ordered_keys:
        u, v, k = key_tuple
        data = edge_lookup[key_tuple]
        edge_id = f"{u}_{v}_{k}"

        if key_tuple in paired:
            continue

        mate_key: tuple[int, int, int] | None = None
        if u != v and not bool(data["oneway_clean"]):
            for max_d in (2.0, 4.0):
                for k_rev in sorted(edges_by_uv.get((v, u), [])):
                    cand = (v, u, k_rev)
                    if cand in paired:
                        continue
                    rev_data = edge_lookup[cand]
                    if bool(rev_data["oneway_clean"]):
                        continue
                    if _polylines_match_reverse(data["geometry_xz"], rev_data["geometry_xz"], max_dist_m=max_d):
                        mate_key = cand
                        break
                if mate_key is not None:
                    break

        if mate_key is not None:
            paired.add(key_tuple)
            paired.add(mate_key)
            rev_data = edge_lookup[mate_key]
            rev_id = f"{mate_key[0]}_{mate_key[1]}_{mate_key[2]}"

            hw_str = str(data["highway_clean"])
            both_lanes = max(int(data.get("lanes_both_ways", 0)), int(rev_data.get("lanes_both_ways", 0)))
            rev_center = max(int(data.get("lanes_reversible", 0)), int(rev_data.get("lanes_reversible", 0)))
            fwd_lanes = int(data.get("forward_lanes", max(1, int(data["lanes_clean"]) // 2)))
            rev_lanes = int(rev_data.get("forward_lanes", data.get("reverse_lanes", max(1, int(data["lanes_clean"]) // 2))))
            total_lanes = max(int(data["lanes_clean"]), int(rev_data["lanes_clean"]))
            if total_lanes == 1:
                fwd_lanes, rev_lanes, both_lanes, rev_center = 1, 1, 0, 0
            else:
                if both_lanes == 0 and rev_center == 0 and fwd_lanes + rev_lanes != total_lanes:
                    rev_lanes = max(1, total_lanes // 2)
                    fwd_lanes = max(1, total_lanes - rev_lanes)
                total_lanes = fwd_lanes + both_lanes + rev_center + rev_lanes

            fwd_turn = data.get("turn_lanes_fwd")
            rev_turn = data.get("turn_lanes_rev") or rev_data.get("turn_lanes_fwd")
            has_bike = bool(data.get("has_bike_lane") or rev_data.get("has_bike_lane"))
            bike_left = bool(data.get("bike_lane_left") or rev_data.get("bike_lane_right"))
            bike_right = bool(data.get("bike_lane_right") or rev_data.get("bike_lane_left"))
            b_left_t = str(data.get("bike_lane_left_type", "none"))
            if b_left_t == "none":
                b_left_t = str(rev_data.get("bike_lane_right_type", "none"))
            b_right_t = str(data.get("bike_lane_right_type", "none"))
            if b_right_t == "none":
                b_right_t = str(rev_data.get("bike_lane_left_type", "none"))
            has_streetcar = bool(data.get("has_streetcar_tracks") or rev_data.get("has_streetcar_tracks"))
            placement = data.get("placement_clean")
            bus_fwd = data.get("bus_lanes_forward")
            bus_rev = data.get("bus_lanes_backward") or rev_data.get("bus_lanes_forward")
            hov_fwd = data.get("hov_lanes_forward")
            chg_fwd = data.get("change_lanes_forward")
            is_school = bool(data.get("is_school_zone") or rev_data.get("is_school_zone"))
            bus_bay_l = bool(data.get("has_bus_bay_left") or rev_data.get("has_bus_bay_right"))
            bus_bay_r = bool(data.get("has_bus_bay_right") or rev_data.get("has_bus_bay_left"))
            width_m = _edge_width_from_lanes(total_lanes, has_bike, b_left_t, b_right_t)

            physical = {
                "id": edge_id,
                "u": u,
                "v": v,
                "key": k,
                "reverse_edge_id": rev_id,
                "osm_way_ids": list(data["osm_way_ids"]),
                "name": data["name_clean"],
                "street_name": data["street_name"],
                "highway": hw_str,
                "road_class": hw_str,
                "junction": str(data.get("junction_clean") or ""),
                "lanes": total_lanes,
                "lanes_total": total_lanes,
                "lanes_forward": fwd_lanes,
                "lanes_backward": rev_lanes,
                "lanes_both_ways": both_lanes,
                "lanes_reversible": rev_center,
                "forward_lanes": fwd_lanes,
                "reverse_lanes": rev_lanes,
                "width_m": width_m,
                "turn_lanes_fwd": fwd_turn,
                "turn_lanes_rev": rev_turn,
                "turn_lanes_forward": fwd_turn,
                "turn_lanes_backward": rev_turn,
                "bus_lanes_forward": bus_fwd,
                "bus_lanes_backward": bus_rev,
                "hov_lanes_forward": hov_fwd,
                "change_lanes_forward": chg_fwd,
                "placement": placement,
                "has_streetcar_tracks": has_streetcar,
                "has_bike_lane": has_bike,
                "bike_lane_left": bike_left,
                "bike_lane_right": bike_right,
                "bike_lane_left_type": b_left_t,
                "bike_lane_right_type": b_right_t,
                "is_school_zone": is_school,
                "has_bus_bay_left": bus_bay_l,
                "has_bus_bay_right": bus_bay_r,
                "maxspeed_kmh": int(data["maxspeed_kmh"]),
                "oneway": False,
                "is_oneway": False,
                "bidirectional": True,
                "bridge": bool(data["bridge_clean"]),
                "tunnel": bool(data["tunnel_clean"]),
                "layer": int(data["layer"]),
                "length_m": float(data["length_m"]),
                "geometry": data["geometry_xyz"],
                "turn_restrictions": list(data.get("turn_restrictions", [])),
                "midblock_controls": list(data.get("midblock_controls", [])),
                "_bare_odd_untagged": bool(data.get("_bare_odd_untagged", False)),
            }
            physical_edges.append(physical)

            directed_edges.append(
                {
                    "id": edge_id,
                    "u": u,
                    "v": v,
                    "key": k,
                    "physical_edge_id": edge_id,
                    "direction": "forward",
                    "lanes": fwd_lanes,
                    "maxspeed_kmh": int(data["maxspeed_kmh"]),
                    "oneway": False,
                    "length_m": float(data["length_m"]),
                    "turn_restrictions": list(data.get("turn_restrictions", [])),
                }
            )
            directed_edges.append(
                {
                    "id": rev_id,
                    "u": mate_key[0],
                    "v": mate_key[1],
                    "key": mate_key[2],
                    "physical_edge_id": edge_id,
                    "direction": "reverse",
                    "lanes": rev_lanes,
                    "maxspeed_kmh": int(rev_data["maxspeed_kmh"]),
                    "oneway": False,
                    "length_m": float(rev_data["length_m"]),
                    "turn_restrictions": list(rev_data.get("turn_restrictions", [])),
                }
            )
        else:
            paired.add(key_tuple)
            is_oneway = bool(data["oneway_clean"])
            hw_str = str(data["highway_clean"])
            both_lanes = 0 if is_oneway else int(data.get("lanes_both_ways", 0))
            rev_center = 0 if is_oneway else int(data.get("lanes_reversible", 0))
            total_lanes = int(data["lanes_clean"])
            fwd_lanes = int(data.get("forward_lanes", total_lanes if is_oneway else max(1, total_lanes // 2)))
            rev_lanes = 0 if is_oneway else int(data.get("reverse_lanes", max(1, total_lanes - fwd_lanes - both_lanes - rev_center)))
            total_lanes = fwd_lanes if is_oneway else max(1, fwd_lanes + both_lanes + rev_center + rev_lanes)
            if total_lanes == 1 and not is_oneway:
                fwd_lanes, rev_lanes, both_lanes, rev_center = 1, 1, 0, 0

            fwd_turn = data.get("turn_lanes_fwd")
            rev_turn = None if is_oneway else data.get("turn_lanes_rev")
            has_bike = bool(data.get("has_bike_lane", False))
            bike_left = bool(data.get("bike_lane_left", False))
            bike_right = bool(data.get("bike_lane_right", False))
            b_left_t = str(data.get("bike_lane_left_type", "none"))
            b_right_t = str(data.get("bike_lane_right_type", "none"))
            has_streetcar = bool(data.get("has_streetcar_tracks", False))
            placement = data.get("placement_clean")
            width_m = _edge_width_from_lanes(total_lanes, has_bike, b_left_t, b_right_t)

            physical = {
                "id": edge_id,
                "u": u,
                "v": v,
                "key": k,
                "osm_way_ids": list(data["osm_way_ids"]),
                "name": data["name_clean"],
                "street_name": data["street_name"],
                "highway": hw_str,
                "road_class": hw_str,
                "junction": str(data.get("junction_clean") or ""),
                "lanes": total_lanes,
                "lanes_total": total_lanes,
                "lanes_forward": fwd_lanes,
                "lanes_backward": rev_lanes,
                "lanes_both_ways": both_lanes,
                "lanes_reversible": rev_center,
                "forward_lanes": fwd_lanes,
                "reverse_lanes": rev_lanes,
                "width_m": width_m,
                "turn_lanes_fwd": fwd_turn,
                "turn_lanes_rev": rev_turn,
                "turn_lanes_forward": fwd_turn,
                "turn_lanes_backward": rev_turn,
                "bus_lanes_forward": data.get("bus_lanes_forward"),
                "bus_lanes_backward": None if is_oneway else data.get("bus_lanes_backward"),
                "hov_lanes_forward": data.get("hov_lanes_forward"),
                "change_lanes_forward": data.get("change_lanes_forward"),
                "placement": placement,
                "has_streetcar_tracks": has_streetcar,
                "has_bike_lane": has_bike,
                "bike_lane_left": bike_left,
                "bike_lane_right": bike_right,
                "bike_lane_left_type": b_left_t,
                "bike_lane_right_type": b_right_t,
                "is_school_zone": bool(data.get("is_school_zone", False)),
                "has_bus_bay_left": bool(data.get("has_bus_bay_left", False)),
                "has_bus_bay_right": bool(data.get("has_bus_bay_right", False)),
                "maxspeed_kmh": int(data["maxspeed_kmh"]),
                "oneway": is_oneway,
                "is_oneway": is_oneway,
                "bidirectional": not is_oneway,
                "bridge": bool(data["bridge_clean"]),
                "tunnel": bool(data["tunnel_clean"]),
                "layer": int(data["layer"]),
                "length_m": float(data["length_m"]),
                "geometry": data["geometry_xyz"],
                "turn_restrictions": list(data.get("turn_restrictions", [])),
                "midblock_controls": list(data.get("midblock_controls", [])),
                "_bare_odd_untagged": bool(data.get("_bare_odd_untagged", False)),
            }
            physical_edges.append(physical)
            directed_edges.append(
                {
                    "id": edge_id,
                    "u": u,
                    "v": v,
                    "key": k,
                    "physical_edge_id": edge_id,
                    "direction": "forward",
                    "lanes": fwd_lanes,
                    "maxspeed_kmh": int(data["maxspeed_kmh"]),
                    "oneway": is_oneway,
                    "length_m": float(data["length_m"]),
                    "turn_restrictions": list(data.get("turn_restrictions", [])),
                }
            )

    # Verified Apple/Google Maps satellite TWLTL overrides where OSM omitted lanes:both_ways=1
    # (36518396: Kennedy Rd between Passmore Ave and Steeles Ave E = 5 lanes: 2 SB + 1 TWLTL + 2 NB)
    verified_twltl_way_ids = {36518396}
    for edge in physical_edges:
        if (
            not bool(edge["oneway"])
            and int(edge["lanes"]) == 4
            and int(edge.get("lanes_both_ways", 0)) == 0
            and set(int(w) for w in edge.get("osm_way_ids", [])) & verified_twltl_way_ids
        ):
            edge["lanes"] = 5
            edge["lanes_total"] = 5
            edge["lanes_forward"] = 2
            edge["lanes_backward"] = 2
            edge["lanes_both_ways"] = 1
            edge["forward_lanes"] = 2
            edge["reverse_lanes"] = 2
            edge["width_m"] = _edge_width_from_lanes(
                5,
                bool(edge.get("has_bike_lane", False)),
                str(edge.get("bike_lane_left_type", "none")),
                str(edge.get("bike_lane_right_type", "none")),
            )
        if (
            bool(edge["oneway"])
            and int(edge["lanes"]) == 4
            and not bool(edge.get("intersection_internal", False))
            and float(edge["length_m"]) >= 25.0
            and 570558979 in {int(w) for w in edge.get("osm_way_ids", [])}
        ):
            edge["lanes"] = 5
            edge["lanes_total"] = 5
            edge["lanes_forward"] = 5
            edge["forward_lanes"] = 5
            edge["right_pocket_lanes"] = 1
            edge["turn_lanes_fwd"] = ["left", "none", "none", "none", "right"]
            edge["turn_lanes_forward"] = ["left", "none", "none", "none", "right"]
            edge["width_m"] = _edge_width_from_lanes(
                5,
                bool(edge.get("has_bike_lane", False)),
                str(edge.get("bike_lane_left_type", "none")),
                str(edge.get("bike_lane_right_type", "none")),
            )

    _normalize_corridor_lane_consistency(physical_edges)
    twin_pairs = _normalize_divided_widths_and_lanes(physical_edges)
    _align_divided_left_turn_lanes(graph, physical_edges, twin_pairs)
    _align_and_straighten_divided_approaches(graph, physical_edges, tram_grid=tram_grid)
    intersection_groups, median_transitions = _build_intersection_topology(graph, physical_edges)
    highway_gores = _extract_highway_gores(graph, physical_edges)

    node_approaches: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for edge in physical_edges:
        u = int(edge["u"])
        v = int(edge["v"])
        geom = edge["geometry"]
        width_m = float(edge["width_m"])
        bidir = bool(edge["bidirectional"])
        oneway = bool(edge["oneway"])
        layer = int(edge["layer"])
        hw_str = str(edge["highway"])
        is_freeway = hw_str in FREEWAY_HIGHWAYS
        is_bridge = bool(edge.get("bridge", False))

        u_data = graph.nodes[u]
        v_data = graph.nodes[v]
        u_ctrl = bool(u_data.get("traffic_signal") or u_data.get("stop_sign"))
        v_ctrl = bool(v_data.get("traffic_signal") or v_data.get("stop_sign"))
        u_mark = str(u_data.get("crosswalk_markings") or "ladder")
        v_mark = str(v_data.get("crosswalk_markings") or "ladder")
        if bool(edge.get("is_school_zone", False)):
            if u_mark == "ladder":
                u_mark = "school_ladder"
            if v_mark == "ladder":
                v_mark = "school_ladder"

        app_u: dict[str, Any] = {
            "edge_id": edge["id"],
            "other_node": v,
            "layer": layer,
            "highway": hw_str,
            "is_freeway": is_freeway,
            "bridge": is_bridge,
            "lanes": int(edge["lanes"]),
            "width_m": width_m,
            "edge_length_m": float(edge["length_m"]),
            "oneway": oneway,
            "bidirectional": bidir,
            "is_incoming": bidir,
            "controlled": bidir and u_ctrl,
            "crosswalk_markings": u_mark,
            "intersection_internal": bool(edge.get("intersection_internal", False)),
            "turn_lanes": edge.get("turn_lanes_rev") if bidir else None,
            "dir_xz": _outgoing_dir_xz(geom, from_start=True),
        }
        shift_r = float(edge.get("lane_shift_right_m", 0.0) or 0.0)
        if abs(shift_r) > 1e-3:
            app_u["lane_shift_right_m"] = round(shift_r, 3)
        node_approaches[u].append(app_u)
        if u != v:
            app_v: dict[str, Any] = {
                "edge_id": edge["id"],
                "other_node": u,
                "layer": layer,
                "highway": hw_str,
                "is_freeway": is_freeway,
                "bridge": is_bridge,
                "lanes": int(edge["lanes"]),
                "width_m": width_m,
                "edge_length_m": float(edge["length_m"]),
                "oneway": oneway,
                "bidirectional": bidir,
                "is_incoming": True,
                "controlled": v_ctrl,
                "crosswalk_markings": v_mark,
                "intersection_internal": bool(edge.get("intersection_internal", False)),
                "turn_lanes": edge.get("turn_lanes_fwd"),
                "dir_xz": _outgoing_dir_xz(geom, from_start=False),
            }
            if abs(shift_r) > 1e-3:
                app_v["lane_shift_right_m"] = round(shift_r, 3)
            node_approaches[v].append(app_v)

    edge_map = {e["id"]: e for e in physical_edges}
    median_islands = _build_median_islands(edge_map, twin_pairs, tram_grid=tram_grid)
    for edge in physical_edges:
        edge.pop("_left_bay_prev_inner_m", None)
    return (
        physical_edges,
        directed_edges,
        node_approaches,
        intersection_groups,
        median_islands,
        median_transitions,
        highway_gores,
    )


def _normalize_divided_widths_and_lanes(
    physical_edges: list[dict[str, Any]],
) -> list[tuple[str, str, float]]:
    """Fix double-counted divided carriageway lanes and clamp tight median widths.

    Returns unique ``(edge1_id, edge2_id, lateral_dist_m)`` opposite-direction
    carriageway pairs used to generate concrete curbed median islands.
    """
    for edge in physical_edges:
        lanes_tot = int(edge.get("lanes_total", edge["lanes"]))
        edge["width_m"] = _edge_width_from_lanes(
            lanes_tot,
            bool(edge.get("has_bike_lane", False)),
            str(edge.get("bike_lane_left_type", "none")),
            str(edge.get("bike_lane_right_type", "none")),
        )

    by_name: dict[str, list[int]] = defaultdict(list)
    pts_xz_cache: list[list[tuple[float, float]]] = []
    for idx, edge in enumerate(physical_edges):
        pts_xz = [(float(p[0]), float(p[2])) for p in edge["geometry"]]
        pts_xz_cache.append(pts_xz)
        sname = edge.get("street_name") or edge.get("name")
        if sname and bool(edge["oneway"]):
            by_name[str(sname)].append(idx)

    twin_pairs_dict: dict[tuple[str, str], float] = {}

    for _sname, indices in by_name.items():
        if len(indices) < 2:
            continue
        boxes: dict[int, tuple[float, float, float, float]] = {}
        for idx in indices:
            pts = pts_xz_cache[idx]
            xs = [p[0] for p in pts]
            zs = [p[1] for p in pts]
            boxes[idx] = (min(xs), max(xs), min(zs), max(zs))

        for idx1 in indices:
            e1 = physical_edges[idx1]
            pts1 = pts_xz_cache[idx1]
            if len(pts1) < 2:
                continue
            b1 = boxes[idx1]
            len1 = float(e1["length_m"])
            nodes1 = {int(e1["u"]), int(e1["v"])}

            twins: list[tuple[int, float, bool]] = []
            for idx2 in indices:
                if idx2 == idx1:
                    continue
                e2 = physical_edges[idx2]
                if int(e1["layer"]) != int(e2["layer"]):
                    continue
                shared_count = len(nodes1 & {int(e2["u"]), int(e2["v"])})
                if shared_count > 2:
                    continue
                b2 = boxes[idx2]
                if (
                    b2[1] < b1[0] - 26.0
                    or b2[0] > b1[1] + 26.0
                    or b2[3] < b1[2] - 26.0
                    or b2[2] > b1[3] + 26.0
                ):
                    continue
                pts2 = pts_xz_cache[idx2]
                if len(pts2) < 2:
                    continue
                len2 = float(e2["length_m"])
                shorter, longer = (pts1, pts2) if len1 <= len2 else (pts2, pts1)
                fracs = (
                    (0.35, 0.5, 0.65)
                    if shared_count == 2
                    else (0.35, 0.55, 0.75)
                    if shared_count == 1
                    else (0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9)
                )
                hits: list[float] = []
                for frac in fracs:
                    sx, sz, st = _sample_polyline_with_tangent(shorter, frac)
                    d = _point_lateral_opposite_dist_m(sx, sz, st, longer)
                    if 2.0 < d < 24.0:
                        hits.append(d)
                if len(hits) >= 2:
                    twins.append(
                        (
                            idx2,
                            max(hits) if shared_count >= 1 else min(hits),
                            shared_count == 0,
                        )
                    )

            if not twins:
                continue

            disjoint_twins = [(i2, d) for i2, d, disjoint in twins if disjoint]
            if disjoint_twins:
                min_twin_dist = min(d for _, d in disjoint_twins)
                has_matching_turns = len(e1.get("turn_lanes_fwd") or []) >= int(e1["lanes"])
                if (
                    str(e1["highway"]) not in {"motorway", "motorway_link"}
                    and int(e1["lanes"]) >= 5
                    and not has_matching_turns
                    and min_twin_dist < int(e1["lanes"]) * 3.5
                ):
                    corrected = max(2, int(e1["lanes"]) // 2)
                    e1["lanes"] = corrected
                    e1["lanes_total"] = corrected
                    e1["lanes_forward"] = corrected
                    e1["lanes_backward"] = 0
                    e1["lanes_both_ways"] = 0
                    e1["forward_lanes"] = corrected
                    e1["width_m"] = _edge_width_from_lanes(
                        corrected,
                        bool(e1.get("has_bike_lane", False)),
                        str(e1.get("bike_lane_left_type", "none")),
                        str(e1.get("bike_lane_right_type", "none")),
                    )

            for idx2, dist, is_disjoint in twins:
                e2 = physical_edges[idx2]
                if is_disjoint:
                    has_matching_turns2 = len(e2.get("turn_lanes_fwd") or []) >= int(e2["lanes"])
                    if (
                        str(e2["highway"]) not in {"motorway", "motorway_link"}
                        and int(e2["lanes"]) >= 5
                        and not has_matching_turns2
                        and dist < int(e2["lanes"]) * 3.5
                    ):
                        corrected2 = max(2, int(e2["lanes"]) // 2)
                        e2["lanes"] = corrected2
                        e2["lanes_total"] = corrected2
                        e2["lanes_forward"] = corrected2
                        e2["lanes_backward"] = 0
                        e2["lanes_both_ways"] = 0
                        e2["forward_lanes"] = corrected2
                        e2["width_m"] = _edge_width_from_lanes(
                            corrected2,
                            bool(e2.get("has_bike_lane", False)),
                            str(e2.get("bike_lane_left_type", "none")),
                            str(e2.get("bike_lane_right_type", "none")),
                        )

                id1, id2 = str(e1["id"]), str(e2["id"])
                pair_key = (id1, id2) if id1 <= id2 else (id2, id1)
                prev_d = twin_pairs_dict.get(pair_key)
                if prev_d is None or dist < prev_d:
                    twin_pairs_dict[pair_key] = dist

    return [(k[0], k[1], d) for k, d in twin_pairs_dict.items()]


def _sample_xyz_along_geom(geom: list[list[float]], dist_m: float, from_start: bool) -> list[float]:
    """Sample interpolated ``[x, y, z]`` at ``dist_m`` from start or end of ``geom``."""
    pts = geom if from_start else list(reversed(geom))
    if len(pts) < 2 or dist_m <= 0.0:
        return [round(float(pts[0][0]), 3), round(float(pts[0][1]), 3), round(float(pts[0][2]), 3)]
    remaining = dist_m
    for i in range(len(pts) - 1):
        ax, ay, az = pts[i]
        bx, by, bz = pts[i + 1]
        seg = math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
        if seg > 1e-6 and remaining <= seg:
            t = remaining / seg
            return [
                round(ax + (bx - ax) * t, 3),
                round(ay + (by - ay) * t, 3),
                round(az + (bz - az) * t, 3),
            ]
        remaining -= seg
    return [round(float(pts[-1][0]), 3), round(float(pts[-1][1]), 3), round(float(pts[-1][2]), 3)]


def _sample_tangent_xz_at_dist(geom: list[list[float]], dist_m: float, from_start: bool) -> list[float]:
    """Return unit XZ tangent pointing AWAY from the endpoint at ``dist_m``."""
    p0 = _sample_xyz_along_geom(geom, max(0.0, dist_m - 0.5), from_start)
    p1 = _sample_xyz_along_geom(geom, dist_m + 0.5, from_start)
    dx = p1[0] - p0[0]
    dz = p1[2] - p0[2]
    norm = math.hypot(dx, dz)
    if norm > 1e-5:
        return [round(dx / norm, 6), round(dz / norm, 6)]
    return _outgoing_dir_xz(geom, from_start)


def _detect_right_pocket_lanes(
    edge: dict[str, Any],
    trunk_dir_lanes: int,
    is_approach: bool,
) -> int:
    """Detect whether a divided intersection approach flares +1 right-turn pocket lane near the stop bar."""
    L = int(edge["lanes"])
    if L < 3 or str(edge.get("highway", "")) in FREEWAY_HIGHWAYS | {"motorway_link", "trunk_link"}:
        return 0
    if float(edge.get("bike_lane_right", False)) or str(edge.get("bike_lane_right_type", "none")) != "none":
        return 0
    tf = edge.get("turn_lanes_fwd") or []
    if len(tf) == L:
        if tf[-1] in {"right", "slight_right"} and tf[-2] not in {"right", "slight_right"}:
            return 1
        if is_approach and L >= trunk_dir_lanes + 2 and tf[0] in {"left", "slight_left"} and tf[-1] == "none":
            return 1
    elif is_approach and L >= trunk_dir_lanes + 2:
        return 1
    return 0


def _recompute_geom_length_m(geom: list[list[float]]) -> float:
    total = 0.0
    for i in range(len(geom) - 1):
        ax, ay, az = float(geom[i][0]), float(geom[i][1]), float(geom[i][2])
        bx, by, bz = float(geom[i + 1][0]), float(geom[i + 1][1]), float(geom[i + 1][2])
        total += math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
    return round(total, 3)


def _align_divided_left_turn_lanes(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
    twin_pairs: list[tuple[str, str, float]],
) -> None:
    """Keep outer curbs & through lanes straight when a divided carriageway opens +1 left-turn bay."""
    twin_edge_ids: set[str] = set()
    for id1, id2, _ in twin_pairs:
        twin_edge_ids.add(id1)
        twin_edge_ids.add(id2)

    inc_by_nl: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    touches_roundabout: set[tuple[int, int]] = set()
    for e in physical_edges:
        u, v, lay = int(e["u"]), int(e["v"]), int(e["layer"])
        inc_by_nl[(u, lay)].append(e)
        if u != v:
            inc_by_nl[(v, lay)].append(e)
        if str(e.get("junction") or "") in {"roundabout", "circular"}:
            touches_roundabout.add((u, lay))
            touches_roundabout.add((v, lay))

    allowed_hw = {"primary", "secondary", "tertiary", "trunk"}
    for (mid_nid, lay), elist in list(inc_by_nl.items()):
        if lay != 0 or len(elist) != 2 or (mid_nid, lay) in touches_roundabout:
            continue
        e0, e1 = elist[0], elist[1]
        if not (bool(e0["oneway"]) and bool(e1["oneway"])):
            continue
        if int(e0["u"]) == int(e0["v"]) or int(e1["u"]) == int(e1["v"]):
            continue
        if int(e0["v"]) == mid_nid and int(e1["u"]) == mid_nid:
            e_narrow, e_wide = e0, e1
        elif int(e1["v"]) == mid_nid and int(e0["u"]) == mid_nid:
            e_narrow, e_wide = e1, e0
        else:
            continue
        if (
            str(e_narrow["highway"]) not in allowed_hw
            or str(e_wide["highway"]) not in allowed_hw
        ):
            continue
        n0 = str(e_narrow.get("street_name") or "").strip()
        n1 = str(e_wide.get("street_name") or "").strip()
        if not (n0 and n0 == n1):
            continue
        if str(e_narrow["id"]) not in twin_edge_ids and str(e_wide["id"]) not in twin_edge_ids:
            continue
        d_out_n = _outgoing_dir_xz(e_narrow["geometry"], from_start=False)
        d_in = (-d_out_n[0], -d_out_n[1])
        d_out = _outgoing_dir_xz(e_wide["geometry"], from_start=True)
        if d_in[0] * d_out[0] + d_in[1] * d_out[1] < 0.94:
            continue
        # Do not shift a short Y-split branch attached to a bidirectional trunk at its upstream node
        if any(bool(oe.get("bidirectional")) for oe in inc_by_nl[(int(e_narrow["u"]), lay)]):
            continue
        if float(e_narrow["length_m"]) < 18.0:
            continue
        tf_narrow = e_narrow.get("turn_lanes_fwd") or []
        if tf_narrow and tf_narrow[0] == "left":
            continue
        tf_wide = e_wide.get("turn_lanes_fwd") or []
        if len(tf_wide) < 3 or tf_wide[0] != "left":
            continue
        rp_wide = int(e_wide.get("right_pocket_lanes", 0) or 0)
        if (
            rp_wide == 0
            and len(tf_wide) >= 4
            and tf_wide[-1] in {"right", "slight_right"}
            and tf_wide[-2] not in {"right", "slight_right"}
            and not float(e_wide.get("bike_lane_right", False))
            and str(e_wide.get("bike_lane_right_type", "none")) == "none"
        ):
            rp_wide = 1
        wide_core_lanes = int(e_wide["lanes"]) - rp_wide
        narrow_lanes = int(e_narrow["lanes"])
        if narrow_lanes >= 2 and wide_core_lanes == narrow_lanes + 1:
            e_narrow["lane_shift_right_m"] = 1.75
            e_wide["_left_bay_prev_inner_m"] = round(float(e_narrow["width_m"]) * 0.5 - 1.75, 3)
            if rp_wide == 1:
                e_wide["lane_shift_right_m"] = 1.75


def _align_and_straighten_divided_approaches(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
    tram_grid: dict[tuple[int, int], list[tuple[tuple[float, float], tuple[float, float], int]]] | None = None,
) -> None:
    """Straighten bowed OSM Y-split legs, close excess median trenches, and tag right-turn pockets."""
    inc_by_nl: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    touches_roundabout: set[tuple[int, int]] = set()
    for e in physical_edges:
        u, v, lay = int(e["u"]), int(e["v"]), int(e["layer"])
        inc_by_nl[(u, lay)].append(e)
        if u != v:
            inc_by_nl[(v, lay)].append(e)
        if str(e.get("junction") or "") in {"roundabout", "circular"}:
            touches_roundabout.add((u, lay))
            touches_roundabout.add((v, lay))

    shifted_nodes: set[int] = set()

    def _shift_node_and_edges(nid: int, lay: int, dx: float, dz: float) -> None:
        if nid in shifted_nodes or (abs(dx) < 0.05 and abs(dz) < 0.05):
            return
        shifted_nodes.add(nid)
        nd = graph.nodes[nid]
        nx_new = round(float(nd["x_m"]) + dx, 3)
        nz_new = round(float(nd["z_m"]) + dz, 3)
        nd["x_m"] = nx_new
        nd["z_m"] = nz_new
        for e in inc_by_nl[(nid, lay)]:
            geom = e["geometry"]
            if not geom:
                continue
            if int(e["u"]) == nid:
                geom[0][0] = nx_new
                geom[0][2] = nz_new
            if int(e["v"]) == nid:
                geom[-1][0] = nx_new
                geom[-1][2] = nz_new
            e["length_m"] = _recompute_geom_length_m(geom)

    def _can_nudge_corner(nid: int, lay: int, rx: float, rz: float, tx: float, tz: float) -> bool:
        if nid in shifted_nodes or (nid, lay) in touches_roundabout:
            return False
        for e in inc_by_nl[(nid, lay)]:
            if str(e["highway"]) in FREEWAY_HIGHWAYS | {"motorway_link", "trunk_link"}:
                return False
            d = _outgoing_dir_xz(e["geometry"], from_start=(int(e["u"]) == nid))
            dot_t = abs(d[0] * tx + d[1] * tz)
            dot_r = abs(d[0] * rx + d[1] * rz)
            if dot_t < 0.85 and dot_r < 0.72:
                return False
        return True

    for (nid, lay), elist in list(inc_by_nl.items()):
        if lay != 0 or len(elist) != 3 or (nid, lay) in touches_roundabout:
            continue
        bis = [e for e in elist if bool(e["bidirectional"])]
        ows = [e for e in elist if bool(e["oneway"])]
        if len(bis) != 1 or len(ows) != 2:
            continue
        trunk_e = bis[0]
        if str(trunk_e["highway"]) not in {"primary", "secondary", "tertiary", "trunk"}:
            continue
        b0_e, b1_e = ows[0], ows[1]
        n0 = str(b0_e.get("street_name") or "").strip()
        n1 = str(b1_e.get("street_name") or "").strip()
        if not (n0 and n0 == n1):
            continue
        if float(b0_e["length_m"]) > 140.0 or float(b1_e["length_m"]) > 140.0:
            continue
        if float(b0_e["length_m"]) < 14.0 or float(b1_e["length_m"]) < 14.0:
            continue

        t_from_start = int(trunk_e["u"]) == nid
        t_out = _sample_tangent_xz_at_dist(
            trunk_e["geometry"], min(24.0, max(6.0, float(trunk_e["length_m"]) * 0.45)), t_from_start
        )
        in_x, in_z = -t_out[0], -t_out[1]
        rx, rz = -in_z, in_x
        ox, oz = float(graph.nodes[nid]["x_m"]), float(graph.nodes[nid]["z_m"])

        def _branch_info(be: dict[str, Any]) -> tuple[int, float, float, float, bool] | None:
            bfs = int(be["u"]) == nid
            far_nid = int(be["v"]) if bfs else int(be["u"])
            far_dir = _outgoing_dir_xz(be["geometry"], from_start=(not bfs))
            if (-far_dir[0] * in_x - far_dir[1] * in_z) < 0.88:
                return None
            fx, fz = float(graph.nodes[far_nid]["x_m"]), float(graph.nodes[far_nid]["z_m"])
            far_lat = (fx - ox) * rx + (fz - oz) * rz
            far_along = (fx - ox) * in_x + (fz - oz) * in_z
            if far_along < 12.0:
                return None
            return far_nid, far_lat, far_along, float(be["width_m"]), bfs

        bi0 = _branch_info(b0_e)
        bi1 = _branch_info(b1_e)
        if bi0 is None or bi1 is None:
            continue

        if bi0[1] <= bi1[1]:
            bL_e, infoL, bR_e, infoR = b0_e, bi0, b1_e, bi1
        else:
            bL_e, infoL, bR_e, infoR = b1_e, bi1, b0_e, bi0

        nL, latL, alongL, wL, bfsL = infoL
        nR, latR, alongR, wR, bfsR = infoR
        if nL == nR:
            continue

        if tram_grid:
            mid_x = 0.5 * (float(graph.nodes[nL]["x_m"]) + float(graph.nodes[nR]["x_m"]))
            mid_z = 0.5 * (float(graph.nodes[nL]["z_m"]) + float(graph.nodes[nR]["z_m"]))
            if _matches_tram_network([(ox, oz), (mid_x, mid_z)], 0, tram_grid):
                continue

        # Trunk lane counts oriented looking INTO the split along (in_x, in_z)
        fwd_t = int(trunk_e.get("forward_lanes", max(1, int(trunk_e["lanes"]) // 2)))
        rev_t = int(trunk_e.get("reverse_lanes", max(1, int(trunk_e["lanes"]) // 2)))
        trunk_L_lanes = fwd_t if t_from_start else rev_t
        trunk_R_lanes = rev_t if t_from_start else fwd_t
        w_t = float(trunk_e["width_m"])

        rpL = _detect_right_pocket_lanes(bL_e, trunk_L_lanes, is_approach=bfsL)
        rpR = _detect_right_pocket_lanes(bR_e, trunk_R_lanes, is_approach=bfsR)
        if rpL > 0:
            bL_e["right_pocket_lanes"] = rpL
        if rpR > 0:
            bR_e["right_pocket_lanes"] = rpR

        # Close oversized OSM median gaps (2.15m..7.5m) on undivided-trunk intersections down to ~1.35m concrete median
        gap_inner = (latR - wR * 0.5) - (latL + wL * 0.5)
        if 2.15 <= gap_inner <= 7.5:
            # Verify nL and nR share a short cross-street edge (intersection box) and straight cross legs
            box_links = [
                e for e in inc_by_nl[(nL, lay)]
                if {int(e["u"]), int(e["v"])} == {nL, nR} and float(e["length_m"]) <= 34.0
            ]
            if (
                box_links
                and _can_nudge_corner(nL, lay, rx, rz, in_x, in_z)
                and _can_nudge_corner(nR, lay, rx, rz, in_x, in_z)
            ):
                excess = gap_inner - 1.35
                squeeze = min(excess, 4.4)
                ideal_outer_L = -w_t * 0.5 - 0.55
                ideal_inner_R = ideal_outer_L + wL + 1.35
                ideal_lat_L = ideal_outer_L + wL * 0.5
                ideal_lat_R = ideal_inner_R + (wR * 0.5 if rpR == 0 else wR * 0.5)
                want_L = max(0.0, min(2.2, ideal_lat_L - latL))
                want_R = max(0.0, min(2.2, latR - ideal_lat_R))
                wsum = want_L + want_R
                if wsum > 1e-3:
                    shift_L = min(2.2, squeeze * (want_L / wsum))
                    shift_R = -min(2.2, squeeze * (want_R / wsum))
                else:
                    shift_L = min(2.2, squeeze * 0.5)
                    shift_R = -min(2.2, squeeze * 0.5)
                if (latR + shift_R) - (latL + shift_L) >= 10.0:
                    # Also move directly opposing corners across the intersection box together so thru-lanes stay aligned
                    def _find_opp_corner(cnid: int) -> int | None:
                        for e in inc_by_nl[(cnid, lay)]:
                            if e["id"] in {bL_e["id"], bR_e["id"]} or float(e["length_m"]) > 34.0:
                                continue
                            d = _outgoing_dir_xz(e["geometry"], from_start=(int(e["u"]) == cnid))
                            if d[0] * in_x + d[1] * in_z >= 0.85:
                                return int(e["v"]) if int(e["u"]) == cnid else int(e["u"])
                        return None

                    opp_L = _find_opp_corner(nL)
                    opp_R = _find_opp_corner(nR)
                    opp_ok = (
                        (opp_L is None or _can_nudge_corner(opp_L, lay, rx, rz, in_x, in_z))
                        and (opp_R is None or _can_nudge_corner(opp_R, lay, rx, rz, in_x, in_z))
                    )
                    if opp_ok:
                        _shift_node_and_edges(nL, lay, rx * shift_L, rz * shift_L)
                        _shift_node_and_edges(nR, lay, rx * shift_R, rz * shift_R)
                        if opp_L is not None:
                            _shift_node_and_edges(opp_L, lay, rx * shift_L, rz * shift_L)
                        if opp_R is not None:
                            _shift_node_and_edges(opp_R, lay, rx * shift_R, rz * shift_R)
                        latL += shift_L
                        latR += shift_R

        # Straighten bowed interior OSM waypoints beyond the 9m Y-split neck onto far_lat
        for be, bfs, far_lat, far_along in ((bL_e, bfsL, latL, alongL), (bR_e, bfsR, latR, alongR)):
            geom = be["geometry"]
            if len(geom) < 3 or far_along < 12.0:
                continue
            max_dev = 0.0
            for i in range(1, len(geom) - 1):
                gx, _, gz = float(geom[i][0]), float(geom[i][1]), float(geom[i][2])
                a_i = (gx - ox) * in_x + (gz - oz) * in_z
                l_i = (gx - ox) * rx + (gz - oz) * rz
                if 6.0 <= a_i <= far_along - 1.0:
                    max_dev = max(max_dev, abs(l_i - far_lat))
            if max_dev > 0.25 and max_dev < 10.0:
                for i in range(1, len(geom) - 1):
                    gx, gy, gz = float(geom[i][0]), float(geom[i][1]), float(geom[i][2])
                    a_i = max(0.5, min(far_along - 0.5, (gx - ox) * in_x + (gz - oz) * in_z))
                    t_lat = far_lat if a_i >= 9.0 else far_lat * (a_i / 9.0)
                    geom[i][0] = round(ox + in_x * a_i + rx * t_lat, 3)
                    geom[i][2] = round(oz + in_z * a_i + rz * t_lat, 3)
                be["length_m"] = _recompute_geom_length_m(geom)


def _build_intersection_topology(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Mark median_split Y-forks, generate seamless Y-transitions, and merge divided boxes."""
    inc_by_nl: dict[tuple[int, int], list[tuple[dict[str, Any], list[float]]]] = defaultdict(list)
    touches_roundabout: set[tuple[int, int]] = set()

    for edge in physical_edges:
        u = int(edge["u"])
        v = int(edge["v"])
        layer = int(edge["layer"])
        geom = edge["geometry"]
        dir_u = _outgoing_dir_xz(geom, from_start=True)
        inc_by_nl[(u, layer)].append((edge, dir_u))
        if u != v:
            dir_v = _outgoing_dir_xz(geom, from_start=False)
            inc_by_nl[(v, layer)].append((edge, dir_v))
        if str(edge.get("junction") or "") in {"roundabout", "circular"}:
            touches_roundabout.add((u, layer))
            touches_roundabout.add((v, layer))

    # 1. Identify Y-split median forks and compute exact non-overlapping separation trims + C1 bridge data
    median_transitions: list[dict[str, Any]] = []
    for (nid, layer), entries in inc_by_nl.items():
        if layer != 0 or len(entries) != 3 or (nid, layer) in touches_roundabout:
            continue
        bis = [e for e, _ in entries if bool(e["bidirectional"])]
        ows = [e for e, _ in entries if bool(e["oneway"])]
        if len(bis) == 1 and len(ows) == 2:
            n0 = str(ows[0].get("street_name") or "").strip()
            n1 = str(ows[1].get("street_name") or "").strip()
            trunk_e = bis[0]
            b1_e, b2_e = ows[0], ows[1]
            w_t = float(trunk_e["width_m"])
            w_1 = float(b1_e["width_m"])
            w_2 = float(b2_e["width_m"])
            t_from_start = int(trunk_e["u"]) == nid
            b1_from_start = int(b1_e["u"]) == nid
            b2_from_start = int(b2_e["u"]) == nid
            t_len = float(trunk_e["length_m"])
            b1_len = float(b1_e["length_m"])
            b2_len = float(b2_e["length_m"])
            t_mid_dir = _sample_tangent_xz_at_dist(
                trunk_e["geometry"], min(16.0, max(3.5, t_len * 0.4)), t_from_start
            )
            b1_mid_dir = _sample_tangent_xz_at_dist(
                b1_e["geometry"], min(20.0, max(3.5, b1_len * 0.4)), b1_from_start
            )
            b2_mid_dir = _sample_tangent_xz_at_dist(
                b2_e["geometry"], min(20.0, max(3.5, b2_len * 0.4)), b2_from_start
            )
            oppose1 = -(b1_mid_dir[0] * t_mid_dir[0] + b1_mid_dir[1] * t_mid_dir[1])
            oppose2 = -(b2_mid_dir[0] * t_mid_dir[0] + b2_mid_dir[1] * t_mid_dir[1])
            # Reject false median splits where a minor cross-street meets divided carriageways
            is_valid_fork = (
                bool(n0 and n0 == n1)
                and oppose1 >= 0.65
                and oppose2 >= 0.65
                and not (w_t <= 7.5 and (w_1 + w_2) >= 17.5)
            )
            if is_valid_fork:
                graph.nodes[nid]["node_type"] = "median_split"
                min_b_len = min(b1_len, b2_len)
                w1_split = max(3.5, float(w_1) - 3.5 * int(b1_e.get("right_pocket_lanes", 0)))
                w2_split = max(3.5, float(w_2) - 3.5 * int(b2_e.get("right_pocket_lanes", 0)))
                needed_sep = (w1_split + w2_split) * 0.5 + 0.85

                # Advance past the pinched Y-neck until branches clear each other & stabilize parallel
                t_out_main = t_mid_dir
                s_branch = min(8.0, max(2.0, (min_b_len - 2.0) * 0.36))
                max_search = min(26.0, (min_b_len - 2.0) * 0.42)
                first_sep_s: float | None = None
                best_align_s: float | None = None
                best_align_score = -1.0
                for cand_s in range(4, int(max_search) + 1, 2):
                    cs = float(cand_s)
                    p1 = _sample_xyz_along_geom(b1_e["geometry"], cs, b1_from_start)
                    p2 = _sample_xyz_along_geom(b2_e["geometry"], cs, b2_from_start)
                    sep = math.hypot(p1[0] - p2[0], p1[2] - p2[2])
                    if sep >= needed_sep:
                        if first_sep_s is None:
                            first_sep_s = cs
                        d1 = _sample_tangent_xz_at_dist(b1_e["geometry"], cs, b1_from_start)
                        d2 = _sample_tangent_xz_at_dist(b2_e["geometry"], cs, b2_from_start)
                        align1 = -(d1[0] * t_out_main[0] + d1[1] * t_out_main[1])
                        align2 = -(d2[0] * t_out_main[0] + d2[1] * t_out_main[1])
                        min_align = min(align1, align2)
                        if min_align > best_align_score:
                            best_align_score = min_align
                            best_align_s = cs
                        if align1 >= 0.96 and align2 >= 0.96:
                            s_branch = cs
                            break
                else:
                    if best_align_s is not None:
                        s_branch = best_align_s
                    elif first_sep_s is not None:
                        s_branch = min(max_search, first_sep_s + 4.0)
                    elif max_search >= 2.0:
                        s_branch = max_search

                s1 = round(min(max(1.5, (b1_len - 2.0) * 0.38), max(s_branch, 4.5)), 3)
                s2 = round(min(max(1.5, (b2_len - 2.0) * 0.38), max(s_branch, 4.5)), 3)
                t_target = 10.0 if t_len >= 28.0 else 4.5
                s_t = round(min(t_target, max(1.2, (t_len - 2.0) * 0.28)), 3)

                if t_from_start:
                    trunk_e["trim_start_m"] = max(float(trunk_e.get("trim_start_m", 0.0)), s_t)
                else:
                    trunk_e["trim_end_m"] = max(float(trunk_e.get("trim_end_m", 0.0)), s_t)

                if b1_from_start:
                    b1_e["trim_start_m"] = max(float(b1_e.get("trim_start_m", 0.0)), s1)
                else:
                    b1_e["trim_end_m"] = max(float(b1_e.get("trim_end_m", 0.0)), s1)

                if b2_from_start:
                    b2_e["trim_start_m"] = max(float(b2_e.get("trim_start_m", 0.0)), s2)
                else:
                    b2_e["trim_end_m"] = max(float(b2_e.get("trim_end_m", 0.0)), s2)

                t_cut = _sample_xyz_along_geom(trunk_e["geometry"], s_t, t_from_start)
                t_out = _sample_tangent_xz_at_dist(trunk_e["geometry"], s_t, t_from_start)
                b1_cut = _sample_xyz_along_geom(b1_e["geometry"], s1, b1_from_start)
                b1_out = _sample_tangent_xz_at_dist(b1_e["geometry"], s1, b1_from_start)
                b2_cut = _sample_xyz_along_geom(b2_e["geometry"], s2, b2_from_start)
                b2_out = _sample_tangent_xz_at_dist(b2_e["geometry"], s2, b2_from_start)

                median_transitions.append(
                    {
                        "split_node": nid,
                        "layer": layer,
                        "trunk": {
                            "cut_point": t_cut,
                            "out_dir_xz": t_out,
                            "width_m": round(w_t, 3),
                            "lanes": int(trunk_e["lanes"]),
                            "forward_lanes": int(trunk_e.get("forward_lanes", 2)),
                            "reverse_lanes": int(trunk_e.get("reverse_lanes", 2)),
                            "lanes_both_ways": int(trunk_e.get("lanes_both_ways", 0)),
                            "u_at_split": t_from_start,
                        },
                        "branches": [
                            {
                                "cut_point": b1_cut,
                                "out_dir_xz": b1_out,
                                "width_m": round(w_1, 3),
                                "lanes": int(b1_e["lanes"]),
                                "u_at_split": b1_from_start,
                            },
                            {
                                "cut_point": b2_cut,
                                "out_dir_xz": b2_out,
                                "width_m": round(w_2, 3),
                                "lanes": int(b2_e["lanes"]),
                                "u_at_split": b2_from_start,
                            },
                        ],
                    }
                )

    # 2. Identify compact divided-intersection corner clusters (including short degree-2 tram/median chains)
    excluded_ig_hw = {"motorway", "motorway_link", "trunk_link", "service"}
    cand_edges: list[dict[str, Any]] = []
    comp_adj: dict[tuple[int, int], set[tuple[int, int]]] = defaultdict(set)
    for edge in physical_edges:
        hw = str(edge["highway"])
        if hw in excluded_ig_hw or str(edge.get("junction") or "") in {"roundabout", "circular"}:
            continue
        if float(edge["length_m"]) > 30.0:
            continue
        u = int(edge["u"])
        v = int(edge["v"])
        layer = int(edge["layer"])
        if u == v or (u, layer) in touches_roundabout or (v, layer) in touches_roundabout:
            continue
        if len(inc_by_nl[(u, layer)]) < 3 or len(inc_by_nl[(v, layer)]) < 3:
            continue
        cand_edges.append(edge)
        comp_adj[(u, layer)].add((v, layer))
        comp_adj[(v, layer)].add((u, layer))

    # Walk short chains through degree-2 median/tram crossing nodes (<= 34m total span)
    for (u_j, layer), inc_list in list(inc_by_nl.items()):
        if len(inc_list) < 3 or (u_j, layer) in touches_roundabout:
            continue
        for start_edge, _ in inc_list:
            hw = str(start_edge["highway"])
            if hw in excluded_ig_hw or str(start_edge.get("junction") or "") in {"roundabout", "circular"}:
                continue
            cur_len = float(start_edge["length_m"])
            if cur_len > 34.0:
                continue
            prev_nid = u_j
            cur_nid = int(start_edge["v"]) if int(start_edge["u"]) == u_j else int(start_edge["u"])
            chain: list[int] = [u_j, cur_nid]
            hops = 0
            while len(inc_by_nl[(cur_nid, layer)]) == 2 and (cur_nid, layer) not in touches_roundabout and hops < 8:
                hops += 1
                next_edge = None
                for cand_e, _ in inc_by_nl[(cur_nid, layer)]:
                    other = int(cand_e["v"]) if int(cand_e["u"]) == cur_nid else int(cand_e["u"])
                    if other != prev_nid:
                        next_edge = cand_e
                        break
                if next_edge is None:
                    break
                nhw = str(next_edge["highway"])
                if nhw in excluded_ig_hw or str(next_edge.get("junction") or "") in {"roundabout", "circular"}:
                    break
                cur_len += float(next_edge["length_m"])
                if cur_len > 34.0:
                    break
                nxt_nid = int(next_edge["v"]) if int(next_edge["u"]) == cur_nid else int(next_edge["u"])
                if nxt_nid in chain:
                    break
                chain.append(nxt_nid)
                prev_nid, cur_nid = cur_nid, nxt_nid
                if len(inc_by_nl[(cur_nid, layer)]) >= 3:
                    break
            if len(chain) >= 3 and len(inc_by_nl[(cur_nid, layer)]) >= 3 and (cur_nid, layer) not in touches_roundabout and cur_len <= 34.0:
                for ci in range(len(chain) - 1):
                    a_n, b_n = chain[ci], chain[ci + 1]
                    comp_adj[(a_n, layer)].add((b_n, layer))
                    comp_adj[(b_n, layer)].add((a_n, layer))

    seen: set[tuple[int, int]] = set()
    groups: list[dict[str, Any]] = []

    for start_key in sorted(comp_adj.keys()):
        if start_key in seen:
            continue
        comp: list[tuple[int, int]] = []
        queue = [start_key]
        seen.add(start_key)
        while queue:
            cur = queue.pop(0)
            comp.append(cur)
            for nxt in sorted(comp_adj[cur]):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)

        comp_layer = comp[0][1]
        comp_nodes = {nid for nid, _ in comp}
        junction_nodes = {nid for nid in comp_nodes if len(inc_by_nl[(nid, comp_layer)]) >= 3}
        if not (2 <= len(junction_nodes) <= 5):
            continue
        xs = [float(graph.nodes[nid]["x_m"]) for nid in junction_nodes]
        ys = [float(graph.nodes[nid]["y_m"]) for nid in junction_nodes]
        zs = [float(graph.nodes[nid]["z_m"]) for nid in junction_nodes]
        diag = math.hypot(max(xs) - min(xs), max(zs) - min(zs))
        if diag > 48.0:
            continue

        # For 2-junction clusters, require parallel opposite oneway carriageways of same street name
        if len(junction_nodes) == 2:
            n_list = sorted(junction_nodes)
            ow_u = {str(e.get("street_name") or "") for e, _ in inc_by_nl[(n_list[0], comp_layer)] if e["oneway"] and not ({int(e["u"]), int(e["v"])} <= comp_nodes)}
            ow_v = {str(e.get("street_name") or "") for e, _ in inc_by_nl[(n_list[1], comp_layer)] if e["oneway"] and not ({int(e["u"]), int(e["v"])} <= comp_nodes)}
            if not ((ow_u & ow_v) - {""}):
                continue

        cx = sum(xs) / len(xs)
        cy = sum(ys) / len(ys)
        cz = sum(zs) / len(zs)
        group_id = f"ig_{min(comp_nodes)}_{comp_layer}"

        # Mark internal edges & collect external edges touching comp_nodes
        external_items: list[dict[str, Any]] = []
        signalized = any(bool(graph.nodes[nid].get("traffic_signal")) for nid in comp_nodes)
        stop_ctrl = any(bool(graph.nodes[nid].get("stop_sign")) for nid in comp_nodes)
        has_crossing = any(bool(graph.nodes[nid].get("has_crossing")) for nid in comp_nodes)

        for edge in physical_edges:
            if int(edge["layer"]) != comp_layer:
                continue
            eu, ev = int(edge["u"]), int(edge["v"])
            u_in = eu in comp_nodes
            v_in = ev in comp_nodes
            if u_in and v_in:
                edge["intersection_internal"] = True
                edge["intersection_group_id"] = group_id
                continue
            if not (u_in ^ v_in):
                continue

            for mc in edge.get("midblock_controls", []):
                mcx, _, mcz = mc["position"]
                if math.hypot(mcx - cx, mcz - cz) <= 38.0:
                    if mc.get("has_signals") or mc.get("type") == "traffic_signals":
                        signalized = True
                    if mc.get("type") == "crossing":
                        has_crossing = True

            corner_nid = eu if u_in else ev
            from_start = u_in
            out_dir = _outgoing_dir_xz(edge["geometry"], from_start=from_start)
            dx_e, dz_e = out_dir
            half_w = float(edge["width_m"]) * 0.5

            # Corner curb clearance using cross edges at corner_nid
            corner_clear = 3.2
            for other_e, dir_o in inc_by_nl[(corner_nid, comp_layer)]:
                if other_e["id"] == edge["id"]:
                    continue
                dot = dx_e * dir_o[0] + dz_e * dir_o[1]
                cross = abs(dx_e * dir_o[1] - dz_e * dir_o[0])
                if cross > 0.25:
                    other_hw = float(other_e["width_m"]) * 0.5
                    cand = (other_hw + half_w * max(0.0, dot)) / max(cross, 0.55)
                    corner_clear = max(corner_clear, min(14.0, cand))

            crosswalk_band = 3.8 if (signalized or has_crossing or stop_ctrl or int(edge["lanes"]) >= 2) else 0.8
            raw_dist = corner_clear + crosswalk_band
            cn = graph.nodes[corner_nid]
            c_x, c_z = float(cn["x_m"]), float(cn["z_m"])
            external_items.append(
                {
                    "edge": edge,
                    "corner_nid": corner_nid,
                    "from_start": from_start,
                    "corner_xz": (c_x, c_z),
                    "out_dir": out_dir,
                    "raw_cut_xz": (c_x + dx_e * raw_dist, c_z + dz_e * raw_dist),
                }
            )

        if len(external_items) < 3:
            for edge in physical_edges:
                if edge.get("intersection_group_id") == group_id:
                    edge.pop("intersection_internal", None)
                    edge.pop("intersection_group_id", None)
            continue

        # Group external approaches into directional legs so EB+WB or NB+SB align on a single crosswalk line
        external_items.sort(key=lambda it: math.atan2(-it["out_dir"][1], it["out_dir"][0]))
        legs: list[list[dict[str, Any]]] = []
        for it in external_items:
            placed = False
            for leg in legs:
                ldx, ldz = leg[0]["out_dir"]
                if it["out_dir"][0] * ldx + it["out_dir"][1] * ldz > 0.86:
                    leg.append(it)
                    placed = True
                    break
            if not placed:
                legs.append([it])

        distinct_names = {
            str(it["edge"].get("street_name") or "").strip()
            for it in external_items
            if str(it["edge"].get("street_name") or "").strip()
        }
        leg_dirs: list[tuple[float, float]] = []
        for leg in legs:
            sx = sum(it["out_dir"][0] for it in leg)
            sz = sum(it["out_dir"][1] for it in leg)
            sn = math.hypot(sx, sz) or 1.0
            leg_dirs.append((sx / sn, sz / sn))
        max_leg_cross = max(
            (
                abs(leg_dirs[i][0] * leg_dirs[j][1] - leg_dirs[i][1] * leg_dirs[j][0])
                for i in range(len(leg_dirs))
                for j in range(i + 1, len(leg_dirs))
            ),
            default=0.0,
        )
        # Reject bogus 2-leg midblock boxes or collinear single-street clusters
        if len(legs) < 3 or (len(distinct_names) < 2 and max_leg_cross < 0.55):
            for edge in physical_edges:
                if edge.get("intersection_group_id") == group_id:
                    edge.pop("intersection_internal", None)
                    edge.pop("intersection_group_id", None)
            continue

        if signalized:
            for nid in comp_nodes:
                graph.nodes[nid]["traffic_signal"] = True
                graph.nodes[nid]["control"] = "traffic_signals"

        # Merge lone 1-lane right-turn or short channelized 1-way slip stubs into their nearest corridor leg
        # so slip lanes do not spawn a spurious 5th crosswalk across an intersection corner
        if len(legs) >= 5:
            def _is_slip_leg(leg: list[dict[str, Any]], idx: int) -> bool:
                if len(leg) != 1:
                    return False
                e0 = leg[0]["edge"]
                hw0 = str(e0.get("highway", ""))
                if hw0.endswith("_link") and int(e0.get("lanes", 1)) == 1:
                    return True
                if bool(e0.get("oneway")) and int(e0.get("lanes", 1)) <= 2 and float(e0.get("length_m", 0.0)) <= 45.0:
                    dx0, dz0 = leg_dirs[idx]
                    max_other_dot = max(
                        (dx0 * leg_dirs[j][0] + dz0 * leg_dirs[j][1] for j in range(len(legs)) if j != idx),
                        default=-1.0,
                    )
                    if max_other_dot >= 0.35:
                        name0 = str(e0.get("street_name") or "").strip()
                        shares_street = (not name0) or any(
                            str(other_it["edge"].get("street_name") or "").strip() == name0
                            for j, other_leg in enumerate(legs)
                            if j != idx
                            for other_it in other_leg
                        )
                        if shares_street:
                            return True
                return False

            main_indices = [idx for idx, leg in enumerate(legs) if not _is_slip_leg(leg, idx)]
            if len(main_indices) >= 3:
                merged_legs: list[list[dict[str, Any]]] = [list(legs[idx]) for idx in main_indices]
                for idx, leg in enumerate(legs):
                    if idx in main_indices:
                        continue
                    dx_s, dz_s = leg_dirs[idx]
                    best_m = max(
                        range(len(merged_legs)),
                        key=lambda m_i: dx_s * leg_dirs[main_indices[m_i]][0] + dz_s * leg_dirs[main_indices[m_i]][1],
                    )
                    merged_legs[best_m].extend(leg)
                legs = merged_legs

        group_approaches: list[dict[str, Any]] = []
        for leg_id, leg in enumerate(legs):
            sx = sum(it["out_dir"][0] for it in leg)
            sz = sum(it["out_dir"][1] for it in leg)
            sn = math.hypot(sx, sz) or 1.0
            leg_dx, leg_dz = sx / sn, sz / sn

            leg_proj = max(
                (it["raw_cut_xz"][0] - cx) * leg_dx + (it["raw_cut_xz"][1] - cz) * leg_dz
                for it in leg
            )

            for it in leg:
                cur_edge = it["edge"]
                cur_corner = int(it["corner_nid"])
                cur_from_start = bool(it["from_start"])
                cur_out_dir = list(it["out_dir"])
                orig_name = str(cur_edge.get("street_name") or "").strip()
                orig_oneway = bool(cur_edge.get("oneway"))

                c_x, c_z = float(graph.nodes[cur_corner]["x_m"]), float(graph.nodes[cur_corner]["z_m"])
                corner_proj = (c_x - cx) * leg_dx + (c_z - cz) * leg_dz
                align_denom = max(0.5, cur_out_dir[0] * leg_dx + cur_out_dir[1] * leg_dz)
                rem_raw_trim = (leg_proj - corner_proj) / align_denom
                cur_max_trim = max(0.5, (float(cur_edge["length_m"]) - 1.5) * 0.45)

                # Walk outward across collinear deg-2 micro-stubs (e.g. pedestrian/cycleway splits near curb)
                walked_m = 0.0
                while (
                    rem_raw_trim > cur_max_trim + 0.5
                    and float(cur_edge["length_m"]) <= 12.0
                    and walked_m + float(cur_edge["length_m"]) <= 22.0
                ):
                    far_nid = int(cur_edge["v"]) if cur_from_start else int(cur_edge["u"])
                    if (
                        far_nid in comp_nodes
                        or (far_nid, comp_layer) in touches_roundabout
                        or len(inc_by_nl[(far_nid, comp_layer)]) != 2
                    ):
                        break
                    next_edge = None
                    next_dir = None
                    for cand_e, cand_d in inc_by_nl[(far_nid, comp_layer)]:
                        if cand_e["id"] != cur_edge["id"]:
                            next_edge = cand_e
                            next_dir = cand_d
                            break
                    if (
                        next_edge is None
                        or next_dir is None
                        or next_edge.get("intersection_internal")
                        or next_edge.get("intersection_group_id")
                        or str(next_edge.get("street_name") or "").strip() != orig_name
                        or bool(next_edge.get("oneway")) != orig_oneway
                        or (next_dir[0] * it["out_dir"][0] + next_dir[1] * it["out_dir"][1]) <= 0.75
                    ):
                        break

                    cur_edge["intersection_internal"] = True
                    cur_edge["intersection_group_id"] = group_id
                    comp_nodes.add(far_nid)
                    if bool(graph.nodes[far_nid].get("traffic_signal")):
                        signalized = True
                    if bool(graph.nodes[far_nid].get("has_crossing")):
                        has_crossing = True
                    walked_m += float(cur_edge["length_m"])

                    cur_edge = next_edge
                    cur_corner = far_nid
                    cur_from_start = int(cur_edge["u"]) == far_nid
                    cur_out_dir = _outgoing_dir_xz(cur_edge["geometry"], from_start=cur_from_start)
                    c_x, c_z = float(graph.nodes[cur_corner]["x_m"]), float(graph.nodes[cur_corner]["z_m"])
                    corner_proj = (c_x - cx) * leg_dx + (c_z - cz) * leg_dz
                    align_denom = max(0.5, cur_out_dir[0] * leg_dx + cur_out_dir[1] * leg_dz)
                    rem_raw_trim = (leg_proj - corner_proj) / align_denom
                    cur_max_trim = max(0.5, (float(cur_edge["length_m"]) - 1.5) * 0.45)

                trim_m = round(max(0.5, min(cur_max_trim, rem_raw_trim)), 3)

                if cur_from_start:
                    cur_edge["trim_start_m"] = max(float(cur_edge.get("trim_start_m", 0.0)), trim_m)
                else:
                    cur_edge["trim_end_m"] = max(float(cur_edge.get("trim_end_m", 0.0)), trim_m)

                cut_xyz = _sample_xyz_along_geom(cur_edge["geometry"], trim_m, from_start=cur_from_start)
                shift_r = float(cur_edge.get("lane_shift_right_m", 0.0) or 0.0)
                if abs(shift_r) > 1e-3:
                    fwd_dx, fwd_dz = (
                        (cur_out_dir[0], cur_out_dir[1])
                        if cur_from_start
                        else (-cur_out_dir[0], -cur_out_dir[1])
                    )
                    rx_s, rz_s = -fwd_dz, fwd_dx
                    cut_xyz = [
                        round(cut_xyz[0] + rx_s * shift_r, 3),
                        cut_xyz[1],
                        round(cut_xyz[2] + rz_s * shift_r, 3),
                    ]
                bidir = bool(cur_edge["bidirectional"])
                is_incoming = bidir or (not cur_from_start)
                turn_lanes = (cur_edge.get("turn_lanes_rev") if bidir else None) if cur_from_start else cur_edge.get("turn_lanes_fwd")
                cur_cw = str(graph.nodes[cur_corner].get("crosswalk_markings") or "ladder")
                orig_cw = str(graph.nodes[it["corner_nid"]].get("crosswalk_markings") or "ladder")
                cw_mark = orig_cw if orig_cw != "ladder" else cur_cw
                if bool(cur_edge.get("is_school_zone", False)) and cw_mark == "ladder":
                    cw_mark = "school_ladder"

                group_approaches.append(
                    {
                        "edge_id": cur_edge["id"],
                        "corner_node": cur_corner,
                        "leg_id": leg_id,
                        "cut_point": cut_xyz,
                        "out_dir_xz": cur_out_dir,
                        "leg_dir_xz": [round(leg_dx, 6), round(leg_dz, 6)],
                        "half_width": round(float(cur_edge["width_m"]) * 0.5, 3),
                        "lanes": int(cur_edge["lanes"]),
                        "forward_lanes": int(cur_edge.get("forward_lanes", cur_edge["lanes"])),
                        "reverse_lanes": int(cur_edge.get("reverse_lanes", 0)),
                        "lanes_both_ways": int(cur_edge.get("lanes_both_ways", 0)),
                        "bidirectional": bidir,
                        "is_incoming": is_incoming,
                        "turn_lanes": turn_lanes,
                        "crosswalk_markings": cw_mark,
                        "street_name": cur_edge.get("street_name"),
                    }
                )

        # Sort approaches CCW around cluster center using cut_point vector
        group_approaches.sort(
            key=lambda a: math.atan2(-(a["cut_point"][2] - cz), a["cut_point"][0] - cx)
        )
        groups.append(
            {
                "id": group_id,
                "owner_node": min(comp_nodes),
                "layer": comp_layer,
                "center": [round(cx, 3), round(cy, 3), round(cz, 3)],
                "signalized": signalized,
                "stop_controlled": stop_ctrl,
                "has_crosswalks": signalized or stop_ctrl or has_crossing,
                "corner_nodes": sorted(comp_nodes),
                "approaches": group_approaches,
            }
        )

    # Mark standalone degree-2 crossing/signal nodes within 30m of an IG center to avoid double crosswalks
    ig_corner_set: set[tuple[int, int]] = set()
    ig_grid: dict[tuple[int, int], list[tuple[float, float, int]]] = defaultdict(list)
    for ig in groups:
        igl = int(ig["layer"])
        for cn in ig["corner_nodes"]:
            ig_corner_set.add((int(cn), igl))
        igx, _, igz = ig["center"]
        ig_grid[(int(math.floor(float(igx) / 40.0)), int(math.floor(float(igz) / 40.0)))].append(
            (float(igx), float(igz), igl)
        )
    r2_30 = 30.0 * 30.0
    for nid, ndata in graph.nodes(data=True):
        nl = int(ndata.get("layer", 0))
        if (nid, nl) in ig_corner_set or len(inc_by_nl.get((nid, nl), ())) != 2:
            continue
        nx_m, nz_m = float(ndata["x_m"]), float(ndata["z_m"])
        cx_g, cz_g = int(math.floor(nx_m / 40.0)), int(math.floor(nz_m / 40.0))
        suppressed = False
        for dgx in (-1, 0, 1):
            for dgz in (-1, 0, 1):
                for igx, igz, igl in ig_grid.get((cx_g + dgx, cz_g + dgz), ()):
                    if igl == nl and (nx_m - igx) ** 2 + (nz_m - igz) ** 2 <= r2_30:
                        suppressed = True
                        break
                if suppressed:
                    break
            if suppressed:
                break
        if suppressed:
            ndata["suppress_midblock"] = True

    return groups, median_transitions


def _closest_point_with_s_on_geom_xz(
    px: float, pz: float, geom: list[list[float]], tx: float, tz: float
) -> tuple[float, float, float, float, float] | None:
    """Return ``(qx, qy, qz, dist, s_along)`` on ``geom`` with opposite direction tangent."""
    best_dist = float("inf")
    best_pt: tuple[float, float, float, float, float] | None = None
    last_seg = len(geom) - 2
    cum_s = 0.0
    for i in range(last_seg + 1):
        ax, ay, az = geom[i]
        bx, by, bz = geom[i + 1]
        dx, dy, dz = bx - ax, by - ay, bz - az
        seg_len_sq = dx * dx + dz * dz
        seg_3d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if seg_len_sq > 1e-6:
            seg_len = math.sqrt(seg_len_sq)
            if tx * (dx / seg_len) + tz * (dz / seg_len) <= -0.55:
                proj_m = ((px - ax) * dx + (pz - az) * dz) / seg_len
                # Do not clamp onto outer start/end vertices of a shorter opposite carriageway,
                # which pulls median ends diagonally toward the shorter segment's centerline.
                if not ((i == 0 and proj_m < -0.25) or (i == last_seg and proj_m > seg_len + 0.25)):
                    t = max(0.0, min(1.0, proj_m / seg_len))
                    qx = ax + dx * t
                    qy = ay + dy * t
                    qz = az + dz * t
                    d = math.hypot(px - qx, pz - qz)
                    if d < best_dist:
                        best_dist = d
                        best_pt = (qx, qy, qz, d, cum_s + seg_3d * t)
        cum_s += seg_3d
    return best_pt


def _closest_point_on_geom_xz(px: float, pz: float, geom: list[list[float]], tx: float, tz: float) -> tuple[float, float, float, float] | None:
    """Return ``(qx, qy, qz, dist)`` on ``geom`` with opposite direction tangent."""
    hit = _closest_point_with_s_on_geom_xz(px, pz, geom, tx, tz)
    return hit[:4] if hit is not None else None


def _edge_inner_half_at_s(edge: dict[str, Any], s_along: float) -> float:
    """Return inner (median-facing) half-width along ``edge``, matching smoothstep left-bay openings."""
    base_inner = float(edge["width_m"]) * 0.5 - float(edge.get("lane_shift_right_m", 0.0) or 0.0)
    prev_inner = edge.get("_left_bay_prev_inner_m")
    if prev_inner is None:
        return base_inner
    trim_s = float(edge.get("trim_start_m", 0.0) or 0.0)
    trim_e = float(edge.get("trim_end_m", 0.0) or 0.0)
    usable = max(1.0, float(edge["length_m"]) - trim_s - trim_e)
    taper_len = min(26.0, usable * 0.50)
    if taper_len < 3.0:
        return base_inner
    a = max(0.0, min(1.0, (s_along - trim_s) / taper_len))
    k = a * a * (3.0 - 2.0 * a)
    return float(prev_inner) + (base_inner - float(prev_inner)) * k


def _build_median_islands(
    edge_map: dict[str, dict[str, Any]],
    twin_pairs: list[tuple[str, str, float]],
    tram_grid: dict[tuple[int, int], list[tuple[list[tuple[float, float]], int]]] | None = None,
) -> list[dict[str, Any]]:
    """Generate raised curbed concrete median strip polylines between opposite carriageways."""
    islands: list[dict[str, Any]] = []
    for id1, id2, _ in twin_pairs:
        e1 = edge_map.get(id1)
        e2 = edge_map.get(id2)
        if not e1 or not e2:
            continue
        if e1.get("intersection_internal") or e2.get("intersection_internal"):
            continue
        if str(e1["highway"]) in {"motorway", "motorway_link", "trunk_link"}:
            continue
        if float(e1["length_m"]) < 14.0 or float(e2["length_m"]) < 14.0:
            continue

        geom1 = e1["geometry"]
        geom2 = e2["geometry"]
        pts1_xz = [(float(p[0]), float(p[2])) for p in geom1]

        trim_s = float(e1.get("trim_start_m", 0.0))
        trim_e = float(e1.get("trim_end_m", 0.0))
        s0 = trim_s + (3.6 if trim_s > 0.0 else 0.2)
        s1 = float(e1["length_m"]) - trim_e - (3.6 if trim_e > 0.0 else 0.2)
        if s1 - s0 < 6.0:
            continue

        sample_count = max(6, min(120, int((s1 - s0) / 3.0) + 2))
        raw_samples: list[tuple[list[float], float]] = []

        for step in range(sample_count):
            s = s0 + (s1 - s0) * (step / (sample_count - 1))
            frac = max(0.0, min(1.0, s / max(1e-4, float(e1["length_m"]))))
            px, py, pz = _sample_xyz_along_geom(geom1, s, from_start=True)
            _, _, tang = _sample_polyline_with_tangent(pts1_xz, frac)
            match = _closest_point_with_s_on_geom_xz(px, pz, geom2, tang[0], tang[1])
            if match is None:
                continue
            qx, qy, qz, dist, s2 = match
            in1 = _edge_inner_half_at_s(e1, s)
            in2 = _edge_inner_half_at_s(e2, s2)
            gap = dist - (in1 + in2)
            if gap < 0.38 or dist > 26.0:
                continue
            ux, uz = (qx - px) / dist, (qz - pz) / dist
            in1_x, in1_z = px + ux * in1, pz + uz * in1
            in2_x, in2_z = qx - ux * in2, qz - uz * in2
            pt = [round((in1_x + in2_x) * 0.5, 3), round((py + qy) * 0.5, 3), round((in1_z + in2_z) * 0.5, 3)]
            raw_samples.append((pt, gap))

        if len(raw_samples) >= 2:
            # Keep only the stable non-pinched median corridor (allow smooth wide median tapers)
            sorted_gaps = sorted(g for _, g in raw_samples)
            nominal_gap = sorted_gaps[len(sorted_gaps) // 2]
            min_keep_gap = max(0.45, nominal_gap * (0.50 if nominal_gap >= 1.4 else 0.88))

            best_run: list[tuple[list[float], float]] = []
            curr_run: list[tuple[list[float], float]] = []
            for pt, g in raw_samples:
                if g >= min_keep_gap:
                    curr_run.append((pt, g))
                else:
                    if len(curr_run) > len(best_run):
                        best_run = curr_run
                    curr_run = []
            if len(curr_run) > len(best_run):
                best_run = curr_run

            if len(best_run) >= 2:
                pts_kept = [item[0] for item in best_run]
                # Skip concrete median island when a dedicated streetcar/LRT ROW track runs inside the boulevard
                if tram_grid and _matches_tram_network(
                    [(float(p[0]), float(p[2])) for p in pts_kept], int(e1["layer"]), tram_grid
                ):
                    continue
                gaps_kept = [item[1] for item in best_run]
                w_conc_list = [round(min(max(0.36, g - 0.34), 7.8), 3) for g in gaps_kept]
                w_gut_list = [round(g + 0.34, 3) if g <= 8.5 else 0.0 for g in gaps_kept]
                # Light 1-pass smoothing on interior centerline points and widths so curbs never wobble
                if len(pts_kept) >= 4:
                    smoothed = [pts_kept[0]]
                    w_sm = [w_conc_list[0]]
                    g_sm = [w_gut_list[0]]
                    for k_pt in range(1, len(pts_kept) - 1):
                        p_prev, p_cur, p_next = pts_kept[k_pt - 1], pts_kept[k_pt], pts_kept[k_pt + 1]
                        smoothed.append([
                            round(0.2 * p_prev[0] + 0.6 * p_cur[0] + 0.2 * p_next[0], 3),
                            p_cur[1],
                            round(0.2 * p_prev[2] + 0.6 * p_cur[2] + 0.2 * p_next[2], 3),
                        ])
                        w_sm.append(round(0.2 * w_conc_list[k_pt - 1] + 0.6 * w_conc_list[k_pt] + 0.2 * w_conc_list[k_pt + 1], 3))
                        if w_gut_list[k_pt - 1] > 0.0 and w_gut_list[k_pt] > 0.0 and w_gut_list[k_pt + 1] > 0.0:
                            g_sm.append(round(0.2 * w_gut_list[k_pt - 1] + 0.6 * w_gut_list[k_pt] + 0.2 * w_gut_list[k_pt + 1], 3))
                        else:
                            g_sm.append(w_gut_list[k_pt])
                    smoothed.append(pts_kept[-1])
                    w_sm.append(w_conc_list[-1])
                    g_sm.append(w_gut_list[-1])
                    pts_kept = smoothed
                    w_conc_list = w_sm
                    w_gut_list = g_sm
                islands.append(
                    {
                        "owner_node": int(e1["u"]),
                        "layer": int(e1["layer"]),
                        "width_m": round(min(w_conc_list), 3),
                        "widths_m": w_conc_list,
                        "gutter_widths_m": g_sm if len(pts_kept) >= 4 else w_gut_list,
                        "centerline": pts_kept,
                    }
                )
    ix_grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for e in edge_map.values():
        g = e.get("geometry") or []
        if len(g) < 2:
            continue
        if e.get("intersection_internal"):
            for pt in (g[0], g[-1]):
                px, pz = float(pt[0]), float(pt[2])
                ix_grid.setdefault((int(px // 32.0), int(pz // 32.0)), []).append((px, pz))
        else:
            if float(e.get("trim_start_m", 0.0)) > 0.1:
                px, pz = float(g[0][0]), float(g[0][2])
                ix_grid.setdefault((int(px // 32.0), int(pz // 32.0)), []).append((px, pz))
            if float(e.get("trim_end_m", 0.0)) > 0.1:
                px, pz = float(g[-1][0]), float(g[-1][2])
                ix_grid.setdefault((int(px // 32.0), int(pz // 32.0)), []).append((px, pz))
    return _merge_abutting_medians(islands, ix_grid=ix_grid)


def _merge_abutting_medians(
    islands: list[dict[str, Any]],
    ix_grid: dict[tuple[int, int], list[tuple[float, float]]] | None = None,
) -> list[dict[str, Any]]:
    """Merge continuous midblock medians split across degree-2 lane-change nodes."""
    if len(islands) < 2:
        return islands

    def _end_dir(pts: list[list[float]], at_start: bool) -> tuple[float, float]:
        p0, p1 = (pts[0], pts[1]) if at_start else (pts[-2], pts[-1])
        dx, dz = float(p1[0]) - float(p0[0]), float(p1[2]) - float(p0[2])
        n = math.hypot(dx, dz) or 1.0
        return (dx / n, dz / n)

    def _near_intersection(ax: float, az: float, bx: float, bz: float) -> bool:
        if not ix_grid:
            return False
        for t in (0.25, 0.5, 0.75):
            mx = ax + (bx - ax) * t
            mz = az + (bz - az) * t
            cx, cz = int(mx // 32.0), int(mz // 32.0)
            for gx in range(cx - 1, cx + 2):
                for gz in range(cz - 1, cz + 2):
                    for ix, iz in ix_grid.get((gx, gz), ()):
                        if math.hypot(ix - mx, iz - mz) < 15.0:
                            return True
        return False

    merged = list(islands)
    changed = True
    while changed:
        changed = False
        used: set[int] = set()
        next_list: list[dict[str, Any]] = []
        for i in range(len(merged)):
            if i in used:
                continue
            cur = merged[i]
            used.add(i)
            pts_a = cur["centerline"]
            w_a = list(cur.get("widths_m") or [float(cur["width_m"])] * len(pts_a))
            g_a = list(cur.get("gutter_widths_m") or [0.0] * len(pts_a))
            for j in range(i + 1, len(merged)):
                if j in used:
                    continue
                cand = merged[j]
                if int(cand["layer"]) != int(cur["layer"]):
                    continue
                pts_b = cand["centerline"]
                w_b = list(cand.get("widths_m") or [float(cand["width_m"])] * len(pts_b))
                g_b = list(cand.get("gutter_widths_m") or [0.0] * len(pts_b))
                # Check all 4 end-to-end join orientations (tight <= 4.8m or midblock lane-shift bridge <= 36m)
                best_join: tuple[float, bool, bool] | None = None
                for a_end in (False, True):
                    pa = pts_a[0] if a_end else pts_a[-1]
                    wa = float(w_a[0] if a_end else w_a[-1])
                    da = _end_dir(pts_a, a_end)
                    for b_start in (True, False):
                        pb = pts_b[0] if b_start else pts_b[-1]
                        wb = float(w_b[0] if b_start else w_b[-1])
                        gap_m = math.hypot(float(pb[0]) - float(pa[0]), float(pb[2]) - float(pa[2]))
                        if gap_m > 36.0:
                            continue
                        max_dw = 0.85 if gap_m <= 4.8 else 3.5
                        if abs(wa - wb) > max_dw:
                            continue
                        db = _end_dir(pts_b, b_start)
                        # Oriented consistently from a -> b
                        dot = (da[0] * db[0] + da[1] * db[1]) * (-1.0 if (a_end == b_start) else 1.0)
                        if dot < 0.96:
                            continue
                        # Lateral offset between tangents across the join (`ux, uz` points outward from `pa`)
                        ux, uz = (-da[0], -da[1]) if a_end else da
                        if gap_m > 1e-4:
                            vx, vz = float(pb[0]) - float(pa[0]), float(pb[2]) - float(pa[2])
                            along = vx * ux + vz * uz
                            lat_err = abs(vx * (-uz) + vz * ux)
                            max_lat = 0.65 if gap_m <= 4.8 else 3.8
                            if along < -0.8 or lat_err > max_lat:
                                continue
                            if gap_m > 4.8 and _near_intersection(
                                float(pa[0]), float(pa[2]), float(pb[0]), float(pb[2])
                            ):
                                continue
                        if best_join is None or gap_m < best_join[0]:
                            best_join = (gap_m, a_end, b_start)
                if best_join is None:
                    continue
                gap_best, a_prepend, b_is_start = best_join
                if a_prepend:
                    if b_is_start:
                        seq_b = list(reversed(pts_b))
                        seq_wb = list(reversed(w_b))
                        seq_gb = list(reversed(g_b))
                    else:
                        seq_b = list(pts_b)
                        seq_wb = list(w_b)
                        seq_gb = list(g_b)
                    left_pts, right_pts = seq_b, pts_a
                    left_w, right_w = seq_wb, w_a
                    left_g, right_g = seq_gb, g_a
                else:
                    if b_is_start:
                        seq_b = list(pts_b)
                        seq_wb = list(w_b)
                        seq_gb = list(g_b)
                    else:
                        seq_b = list(reversed(pts_b))
                        seq_wb = list(reversed(w_b))
                        seq_gb = list(reversed(g_b))
                    left_pts, right_pts = pts_a, seq_b
                    left_w, right_w = w_a, seq_wb
                    left_g, right_g = g_a, seq_gb

                if gap_best < 0.8:
                    combined = left_pts[:-1] + right_pts
                    combined_w = left_w[:-1] + right_w
                    combined_g = left_g[:-1] + right_g
                elif gap_best > 4.8:
                    p_l, p_r = left_pts[-1], right_pts[0]
                    w_l, w_r = float(left_w[-1]), float(right_w[0])
                    g_l, g_r = float(left_g[-1]), float(right_g[0])
                    n_bridge = max(3, min(10, int(gap_best / 4.0)))
                    bridge_pts = [
                        [
                            round(float(p_l[0]) + (float(p_r[0]) - float(p_l[0])) * (k / (n_bridge + 1)), 3),
                            round(float(p_l[1]) + (float(p_r[1]) - float(p_l[1])) * (k / (n_bridge + 1)), 3),
                            round(float(p_l[2]) + (float(p_r[2]) - float(p_l[2])) * (k / (n_bridge + 1)), 3),
                        ]
                        for k in range(1, n_bridge + 1)
                    ]
                    bridge_w = [
                        round(w_l + (w_r - w_l) * (k / (n_bridge + 1)), 3)
                        for k in range(1, n_bridge + 1)
                    ]
                    bridge_g = [
                        round(g_l + (g_r - g_l) * (k / (n_bridge + 1)), 3)
                        if (g_l > 0.0 and g_r > 0.0)
                        else 0.0
                        for k in range(1, n_bridge + 1)
                    ]
                    join_idx = len(left_pts)
                    combined = [list(pt) for pt in left_pts] + bridge_pts + [list(pt) for pt in right_pts]
                    combined_w = list(left_w) + bridge_w + list(right_w)
                    combined_g = list(left_g) + bridge_g + list(right_g)
                    lo_s = max(1, join_idx - 5)
                    hi_s = min(len(combined) - 1, join_idx + n_bridge + 5)
                    for _ in range(6):
                        upd: list[tuple[int, float, float, float, float]] = []
                        for idx in range(lo_s, hi_s):
                            nx = 0.25 * float(combined[idx - 1][0]) + 0.5 * float(combined[idx][0]) + 0.25 * float(combined[idx + 1][0])
                            nz = 0.25 * float(combined[idx - 1][2]) + 0.5 * float(combined[idx][2]) + 0.25 * float(combined[idx + 1][2])
                            nw = 0.25 * float(combined_w[idx - 1]) + 0.5 * float(combined_w[idx]) + 0.25 * float(combined_w[idx + 1])
                            if combined_g[idx - 1] > 0.0 and combined_g[idx] > 0.0 and combined_g[idx + 1] > 0.0:
                                ng = 0.25 * float(combined_g[idx - 1]) + 0.5 * float(combined_g[idx]) + 0.25 * float(combined_g[idx + 1])
                            else:
                                ng = float(combined_g[idx])
                            upd.append((idx, round(nx, 3), round(nz, 3), round(nw, 3), round(ng, 3)))
                        for idx, nx, nz, nw, ng in upd:
                            combined[idx][0] = nx
                            combined[idx][2] = nz
                            combined_w[idx] = nw
                            combined_g[idx] = ng
                else:
                    combined = left_pts + right_pts
                    combined_w = left_w + right_w
                    combined_g = left_g + right_g
                cur = {
                    "owner_node": int(cur["owner_node"]),
                    "layer": int(cur["layer"]),
                    "width_m": round(min(combined_w), 3),
                    "widths_m": combined_w,
                    "gutter_widths_m": combined_g,
                    "centerline": combined,
                }
                pts_a = cur["centerline"]
                w_a = cur["widths_m"]
                g_a = cur["gutter_widths_m"]
                used.add(j)
                changed = True
            next_list.append(cur)
        merged = next_list
    return merged


def _build_tram_grid(
    tram_ways_lonlat: list[tuple[list[tuple[float, float]], int]] | None,
    to_local_xz: Any,
    cell_size_m: float = 40.0,
) -> dict[tuple[int, int], list[tuple[list[tuple[float, float]], int]]]:
    """Project ``railway=tram`` ways to local XZ and index into a spatial hash grid."""
    grid: dict[tuple[int, int], list[tuple[list[tuple[float, float]], int]]] = defaultdict(list)
    if not tram_ways_lonlat:
        return grid
    for coords_ll, tram_layer in tram_ways_lonlat:
        pts_xz = [to_local_xz(lon, lat) for lon, lat in coords_ll]
        if len(pts_xz) < 2:
            continue
        entry = (pts_xz, int(tram_layer))
        seen_cells: set[tuple[int, int]] = set()
        for i in range(len(pts_xz) - 1):
            ax, az = pts_xz[i]
            bx, bz = pts_xz[i + 1]
            cmin_x = int(math.floor(min(ax, bx) / cell_size_m))
            cmax_x = int(math.floor(max(ax, bx) / cell_size_m))
            cmin_z = int(math.floor(min(az, bz) / cell_size_m))
            cmax_z = int(math.floor(max(az, bz) / cell_size_m))
            for cx in range(cmin_x, cmax_x + 1):
                for cz in range(cmin_z, cmax_z + 1):
                    cell = (cx, cz)
                    if cell not in seen_cells:
                        seen_cells.add(cell)
                        grid[cell].append(entry)
    return grid


def _matches_tram_network(
    pts_xz: list[tuple[float, float]],
    edge_layer: int,
    tram_grid: dict[tuple[int, int], list[tuple[list[tuple[float, float]], int]]],
    cell_size_m: float = 40.0,
) -> bool:
    """Return True when a road segment runs collinear within 3.8 m of same-layer TTC tracks."""
    if not tram_grid or len(pts_xz) < 2:
        return False
    cands: list[tuple[list[tuple[float, float]], int]] = []
    seen_ids: set[int] = set()
    for px, pz in pts_xz:
        cx = int(math.floor(px / cell_size_m))
        cz = int(math.floor(pz / cell_size_m))
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for entry in tram_grid.get((cx + dx, cz + dz), ()):
                    eid = id(entry)
                    if eid not in seen_ids:
                        seen_ids.add(eid)
                        cands.append(entry)
    if not cands:
        return False

    samples = [_sample_polyline_with_tangent(pts_xz, frac) for frac in (0.25, 0.50, 0.75)]
    for tram_pts, tram_layer in cands:
        if tram_layer != edge_layer:
            continue
        hits = 0
        for sx, sz, tang in samples:
            dist = _point_lateral_dist_m(sx, sz, tang, tram_pts, opposite_only=False, min_abs_dot=0.85)
            if dist <= 3.8:
                hits += 1
        if hits >= 2:
            return True
    return False


def _build_school_grid(
    school_polys_lonlat: list[list[tuple[float, float]]] | None,
    to_local_xz: Any,
    cell_size_m: float = 80.0,
) -> dict[tuple[int, int], list[tuple[float, float, float, float]]]:
    """Index buffered school-zone bounding boxes into a fast spatial grid."""
    grid: dict[tuple[int, int], list[tuple[float, float, float, float]]] = defaultdict(list)
    if not school_polys_lonlat:
        return grid
    pad = 28.0
    for ring in school_polys_lonlat:
        pts_xz = [to_local_xz(lon, lat) for lon, lat in ring]
        if not pts_xz:
            continue
        xs = [p[0] for p in pts_xz]
        zs = [p[1] for p in pts_xz]
        box = (min(xs) - pad, max(xs) + pad, min(zs) - pad, max(zs) + pad)
        cmin_x = int(math.floor(box[0] / cell_size_m))
        cmax_x = int(math.floor(box[1] / cell_size_m))
        cmin_z = int(math.floor(box[2] / cell_size_m))
        cmax_z = int(math.floor(box[3] / cell_size_m))
        for cx in range(cmin_x, cmax_x + 1):
            for cz in range(cmin_z, cmax_z + 1):
                grid[(cx, cz)].append(box)
    return grid


def _edge_in_school_zone(
    pts_xz: list[tuple[float, float]],
    school_grid: dict[tuple[int, int], list[tuple[float, float, float, float]]],
    cell_size_m: float = 80.0,
) -> bool:
    if not school_grid or not pts_xz:
        return False
    for px, pz in pts_xz[::max(1, len(pts_xz) // 4)]:
        cx = int(math.floor(px / cell_size_m))
        cz = int(math.floor(pz / cell_size_m))
        for bminx, bmaxx, bminz, bmaxz in school_grid.get((cx, cz), ()):
            if bminx <= px <= bmaxx and bminz <= pz <= bmaxz:
                return True
    return False


def _build_rail_tracks_3d(
    rail_ways_raw: list[dict[str, Any]] | None,
    to_local_xz: Any,
    elevation_sampler: ElevationSampler,
    road_pts_grid: dict[tuple[int, int], list[tuple[float, float, float, int]]],
    intersection_groups: list[dict[str, Any]] | None = None,
    cell_size_m: float = 40.0,
) -> list[dict[str, Any]]:
    """Project railway/tram/LRT ways to 3D and split embedded road/IG spans from separated ROWs."""
    tracks: list[dict[str, Any]] = []
    if not rail_ways_raw:
        return tracks

    ig_grid: dict[tuple[int, int], list[tuple[float, float, int]]] = defaultdict(list)
    if intersection_groups:
        for ig in intersection_groups:
            ix, _, iz = ig["center"]
            ilay = int(ig.get("layer", 0))
            cx = int(math.floor(float(ix) / cell_size_m))
            cz = int(math.floor(float(iz) / cell_size_m))
            for dx in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    ig_grid[(cx + dx, cz + dz)].append((float(ix), float(iz), ilay))

    layer_h = elevation_sampler.config.layer_height_m
    for idx, rw in enumerate(rail_ways_raw):
        coords_ll = rw["coords"]
        if len(coords_ll) < 2:
            continue
        rw_type = str(rw["railway_type"])
        rw_layer = int(rw.get("layer", 0))
        rw_bridge = bool(rw.get("bridge", False))
        rw_name = rw.get("name")
        pts_xz = [to_local_xz(lon, lat) for lon, lat in coords_ll]

        geom_xyz: list[list[float]] = []
        vtx_emb: list[bool] = []
        for px, pz in pts_xz:
            best_road_y: float | None = None
            best_d2 = 16.0  # within 4.0m of a same-layer road point
            cx = int(math.floor(px / cell_size_m))
            cz = int(math.floor(pz / cell_size_m))
            for dx in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for rx, ry, rz, r_lay in road_pts_grid.get((cx + dx, cz + dz), ()):
                        if r_lay != rw_layer:
                            continue
                        d2 = (px - rx) ** 2 + (pz - rz) ** 2
                        if d2 < best_d2:
                            best_d2 = d2
                            best_road_y = ry
            near_ig = any(
                ilay == rw_layer and (px - ix) ** 2 + (pz - iz) ** 2 <= 23.0 ** 2
                for ix, iz, ilay in ig_grid.get((cx, cz), ())
            )
            if best_road_y is not None:
                py = best_road_y
                is_emb = rw_type in {"tram", "light_rail"}
            else:
                gy = elevation_sampler.sample_ground(px, pz)
                py = gy + (max(1, rw_layer) if (rw_bridge and rw_layer <= 0) else rw_layer) * layer_h
                is_emb = rw_type in {"tram", "light_rail"} and near_ig
            geom_xyz.append([round(px, 3), round(py, 3), round(pz, 3)])
            vtx_emb.append(is_emb)

        base_id = f"rail_{rw.get('osm_id', idx)}"
        if rw_type not in {"tram", "light_rail"}:
            tracks.append(
                {
                    "id": base_id,
                    "railway_type": rw_type,
                    "name": rw_name,
                    "layer": rw_layer,
                    "bridge": rw_bridge,
                    "embedded_in_road": False,
                    "geometry": geom_xyz,
                }
            )
            continue

        # Split tram/LRT along intersections vs separated ROWs so concrete track-beds stop at cross-streets
        seg_flags = [bool(vtx_emb[i] or vtx_emb[i + 1]) for i in range(len(geom_xyz) - 1)]
        run_start = 0
        part_idx = 0
        while run_start < len(seg_flags):
            flag = seg_flags[run_start]
            run_end = run_start + 1
            while run_end < len(seg_flags) and seg_flags[run_end] == flag:
                run_end += 1
            sub_g = geom_xyz[run_start : run_end + 1]
            tracks.append(
                {
                    "id": base_id if part_idx == 0 else f"{base_id}__p{part_idx}",
                    "railway_type": rw_type,
                    "name": rw_name,
                    "layer": rw_layer,
                    "bridge": rw_bridge,
                    "embedded_in_road": flag,
                    "geometry": sub_g,
                }
            )
            part_idx += 1
            run_start = run_end
    return tracks


def _build_rail_crossings_3d(
    crossing_nodes_raw: list[dict[str, Any]] | None,
    to_local_xz: Any,
    physical_edges: list[dict[str, Any]],
    rail_tracks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build at-grade rail/tram level crossing descriptors anchored to road & rail geometry."""
    if not crossing_nodes_raw or not physical_edges:
        return []

    cell_size = 50.0
    edge_grid: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for e in physical_edges:
        if e.get("intersection_internal") or e.get("tunnel"):
            continue
        geom = e["geometry"]
        seen: set[tuple[int, int]] = set()
        for pt in geom:
            cell = (int(math.floor(pt[0] / cell_size)), int(math.floor(pt[2] / cell_size)))
            if cell not in seen:
                seen.add(cell)
                edge_grid[cell].append(e)

    rail_grid: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for rt in rail_tracks:
        seen_r: set[tuple[int, int]] = set()
        for pt in rt["geometry"]:
            cell = (int(math.floor(pt[0] / cell_size)), int(math.floor(pt[2] / cell_size)))
            if cell not in seen_r:
                seen_r.add(cell)
                rail_grid[cell].append(rt)

    crossings: list[dict[str, Any]] = []
    seen_pos: list[tuple[float, float]] = []

    for cn in crossing_nodes_raw:
        px, pz = to_local_xz(cn["lon"], cn["lat"])
        # Deduplicate closely spaced multi-track crossing nodes (within 9m)
        if any(math.hypot(px - sx, pz - sz) < 9.0 for sx, sz in seen_pos):
            continue

        cx = int(math.floor(px / cell_size))
        cz = int(math.floor(pz / cell_size))
        cand_edges: list[dict[str, Any]] = []
        seen_eids: set[str] = set()
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for e in edge_grid.get((cx + dx, cz + dz), ()):
                    if e["id"] not in seen_eids:
                        seen_eids.add(e["id"])
                        cand_edges.append(e)

        best_edge: dict[str, Any] | None = None
        best_dist = 8.5
        best_pt = (px, 0.0, pz)
        best_rdir = (1.0, 0.0)

        for e in cand_edges:
            geom = e["geometry"]
            for i in range(len(geom) - 1):
                ax, ay, az = geom[i]
                bx, by, bz = geom[i + 1]
                dx, dz = bx - ax, bz - az
                lsq = dx * dx + dz * dz
                if lsq <= 1e-6:
                    continue
                t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / lsq))
                qx, qy, qz = ax + dx * t, ay + (by - ay) * t, az + dz * t
                d = math.hypot(px - qx, pz - qz)
                if d < best_dist:
                    best_dist = d
                    best_edge = e
                    best_pt = (qx, qy, qz)
                    ln = math.sqrt(lsq)
                    best_rdir = (dx / ln, dz / ln)

        if best_edge is None:
            continue

        # Find intersecting rail direction (default perpendicular to road if no track segment found)
        rail_dir = (-best_rdir[1], best_rdir[0])
        best_r_d = 12.0
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for rt in rail_grid.get((cx + dx, cz + dz), ()):
                    if rt["railway_type"] != ("rail" if cn["crossing_type"] == "rail" else rt["railway_type"]):
                        pass
                    rgeom = rt["geometry"]
                    for i in range(len(rgeom) - 1):
                        ax, _, az = rgeom[i]
                        bx, _, bz = rgeom[i + 1]
                        rdx, rdz = bx - ax, bz - az
                        lsq = rdx * rdx + rdz * rdz
                        if lsq <= 1e-6:
                            continue
                        t = max(0.0, min(1.0, ((best_pt[0] - ax) * rdx + (best_pt[2] - az) * rdz) / lsq))
                        qx, qz = ax + rdx * t, az + rdz * t
                        d = math.hypot(best_pt[0] - qx, best_pt[2] - qz)
                        if d < best_r_d:
                            best_r_d = d
                            ln = math.sqrt(lsq)
                            rail_dir = (rdx / ln, rdz / ln)

        seen_pos.append((best_pt[0], best_pt[2]))
        crossings.append(
            {
                "id": f"rc_{cn['osm_id']}",
                "crossing_type": cn["crossing_type"],
                "layer": int(best_edge["layer"]),
                "position": [round(best_pt[0], 3), round(best_pt[1], 3), round(best_pt[2], 3)],
                "road_dir_xz": [round(best_rdir[0], 5), round(best_rdir[1], 5)],
                "rail_dir_xz": [round(rail_dir[0], 5), round(rail_dir[1], 5)],
                "road_width_m": round(float(best_edge["width_m"]), 3),
                "has_gates": cn["crossing_type"] == "rail",
            }
        )

    return crossings


def _build_bus_bays_3d(
    bus_stop_nodes_raw: list[dict[str, Any]] | None,
    to_local_xz: Any,
    physical_edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Snap arterial TTC/YRT bus stops onto road right-hand edges to render concrete bus bays."""
    if not bus_stop_nodes_raw or not physical_edges:
        return []

    cell_size = 60.0
    edge_grid: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for e in physical_edges:
        if e.get("intersection_internal") or str(e["highway"]) not in {"primary", "secondary", "tertiary", "trunk"}:
            continue
        if float(e["length_m"]) < 28.0:
            continue
        seen: set[tuple[int, int]] = set()
        for pt in e["geometry"]:
            cell = (int(math.floor(pt[0] / cell_size)), int(math.floor(pt[2] / cell_size)))
            if cell not in seen:
                seen.add(cell)
                edge_grid[cell].append(e)

    bays: list[dict[str, Any]] = []
    placed_pts: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)

    for bs in bus_stop_nodes_raw:
        px, pz = to_local_xz(bs["lon"], bs["lat"])
        cx = int(math.floor(px / cell_size))
        cz = int(math.floor(pz / cell_size))
        if any(
            math.hypot(px - ox, pz - oz) < 35.0
            for dx in (-1, 0, 1)
            for dz in (-1, 0, 1)
            for ox, oz in placed_pts.get((cx + dx, cz + dz), ())
        ):
            continue

        best_edge: dict[str, Any] | None = None
        best_dist = 13.0
        best_pt = (px, 0.0, pz)
        best_dir = (1.0, 0.0)
        best_side = 1.0  # +1 = right of forward tangent, -1 = left
        best_s_along = 0.0

        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for e in edge_grid.get((cx + dx, cz + dz), ()):
                    geom = e["geometry"]
                    cum_s = 0.0
                    for i in range(len(geom) - 1):
                        ax, ay, az = geom[i]
                        bx, by, bz = geom[i + 1]
                        edx, edz = bx - ax, bz - az
                        lsq = edx * edx + edz * edz
                        if lsq <= 1e-6:
                            continue
                        seg_len = math.sqrt(lsq)
                        t = ((px - ax) * edx + (pz - az) * edz) / lsq
                        if 0.12 <= t <= 0.88:
                            qx, qy, qz = ax + edx * t, ay + (by - ay) * t, az + edz * t
                            d = math.hypot(px - qx, pz - qz)
                            if d < best_dist:
                                best_dist = d
                                best_edge = e
                                best_pt = (qx, qy, qz)
                                best_dir = (edx / seg_len, edz / seg_len)
                                # right vector in XZ (+X East, +Z South) is (-tz, tx)
                                lat = (px - qx) * (-edz / seg_len) + (pz - qz) * (edx / seg_len)
                                best_side = 1.0 if lat >= 0 else -1.0
                                best_s_along = cum_s + seg_len * t
                        cum_s += seg_len

        if best_edge is None:
            continue

        half_w = float(best_edge["width_m"]) * 0.5
        if int(best_edge.get("right_pocket_lanes", 0)) >= 1 and best_side > 0:
            e_len = float(best_edge.get("length_m", 0.0))
            trim_s = float(best_edge.get("trim_start_m", 0.0) or 0.0)
            trim_e = float(best_edge.get("trim_end_m", 0.0) or 0.0)
            u_len = max(1.0, e_len - trim_s - trim_e - 1.6)
            p_store = min(20.0, max(8.5, u_len * 0.4))
            p_taper = min(18.0, max(9.0, u_len * 0.38))
            p_lead = max(0.0, u_len - p_store - p_taper)
            s_in = best_s_along - trim_s
            if s_in <= p_lead + 0.35 * p_taper:
                half_w = max(1.75, half_w - 3.5)
            else:
                continue
        shift_r = float(best_edge.get("lane_shift_right_m", 0.0) or 0.0)
        rx, rz = -best_dir[1], best_dir[0]
        curb_lat = shift_r + best_side * half_w
        curb_x = best_pt[0] + rx * curb_lat
        curb_z = best_pt[2] + rz * curb_lat
        placed_pts[(cx, cz)].append((px, pz))
        bays.append(
            {
                "id": f"bb_{bs['osm_id']}",
                "layer": int(best_edge["layer"]),
                "position": [round(curb_x, 3), round(best_pt[1], 3), round(curb_z, 3)],
                "dir_xz": [round(best_dir[0], 5), round(best_dir[1], 5)],
                "outward_xz": [round(rx * best_side, 5), round(rz * best_side, 5)],
                "length_m": 18.0,
                "width_m": 2.6,
            }
        )

    return bays


def project_and_clean_graph(
    graph: nx.MultiDiGraph,
    config: PipelineConfig,
    to_local_xz: Any,
    elevation_sampler: ElevationSampler,
    controls_by_way: dict[int, list[dict[str, Any]]] | None = None,
    tram_ways_lonlat: list[tuple[list[tuple[float, float]], int]] | None = None,
    school_polys_lonlat: list[list[tuple[float, float]]] | None = None,
    rail_ways_raw: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], int, int]:
    """Project nodes/edges to metric coordinates, clean tags, and sample elevations."""
    signal_count = 0
    stop_count = 0
    tram_grid = _build_tram_grid(tram_ways_lonlat, to_local_xz)
    school_grid = _build_school_grid(school_polys_lonlat, to_local_xz)

    for node_id, data in graph.nodes(data=True):
        lon = float(data["x"])
        lat = float(data["y"])
        x_m, z_m = to_local_xz(lon, lat)

        raw_hw = str(data.get("highway") or "").strip().lower()
        crossing_val = str(data.get("crossing") or "").strip().lower()
        crossing_mark = str(data.get("crossing:markings") or "").strip().lower()
        is_explicit_unmarked = crossing_val in {"unmarked", "no", "none"} or crossing_mark in {"no", "none"}
        has_signal = raw_hw == "traffic_signals" or bool(data.get("traffic_signals"))
        has_stop = raw_hw == "stop" or bool(data.get("stop"))
        if has_signal:
            signal_count += 1
        if has_stop:
            stop_count += 1

        control = raw_hw if raw_hw in {"traffic_signals", "stop", "crossing", "motorway_junction"} else "none"
        if has_signal:
            control = "traffic_signals"
        elif has_stop and control == "none":
            control = "stop"

        if "lines" in crossing_mark or crossing_val == "lines":
            cw_mark = "lines"
        elif is_explicit_unmarked:
            cw_mark = "none"
        else:
            cw_mark = "ladder"

        data["lat"] = round(lat, 7)
        data["lon"] = round(lon, 7)
        data["x_m"] = round(x_m, 3)
        data["z_m"] = round(z_m, 3)
        data["traffic_signal"] = has_signal
        data["stop_sign"] = has_stop
        data["has_crossing"] = (raw_hw == "crossing" or bool(crossing_val)) and not is_explicit_unmarked
        data["crosswalk_markings"] = cw_mark
        data["node_type"] = "normal"
        data["control"] = control
        data["street_count"] = int(data.get("street_count", graph.degree(node_id)))

    for u, v, _, data in graph.edges(keys=True, data=True):
        highway = clean_highway(data.get("highway"))
        junction = _clean_junction(data.get("junction"))
        oneway = clean_oneway(data.get("oneway"))
        lanes, forward_lanes, reverse_lanes, lanes_both_ways, lanes_reversible = parse_directional_lanes(
            data, highway=highway, oneway=oneway
        )
        has_dir_or_turn_tags = any(
            data.get(k)
            for k in (
                "lanes:forward",
                "lanes:backward",
                "lanes:both_ways",
                "turn:lanes",
                "turn:lanes:forward",
                "turn:lanes:backward",
                "turn:lanes:both_ways",
            )
        )
        turn_lanes_fwd, turn_lanes_rev = clean_turn_lanes(
            data, oneway=oneway, fwd_lanes=forward_lanes, rev_lanes=reverse_lanes, highway=highway
        )
        placement_clean = clean_placement(data, oneway=oneway)
        has_bike_lane, bike_lane_left, bike_lane_right, b_left_t, b_right_t = clean_cycleway(data, oneway=oneway)
        bus_fwd, bus_rev, hov_fwd, chg_fwd = parse_bus_and_hov_lanes(
            data, oneway=oneway, fwd_lanes=forward_lanes, rev_lanes=reverse_lanes
        )
        maxspeed_kmh = clean_maxspeed_kmh(data.get("maxspeed"), highway=highway)
        bridge = clean_bool_tag(data.get("bridge"))
        tunnel = clean_bool_tag(data.get("tunnel"))
        layer = clean_layer(data.get("layer"))
        osm_way_ids = clean_osm_way_ids(data.get("osmid"))

        geom = data.get("geometry")
        if geom is not None:
            raw_coords = list(geom.coords)
        else:
            raw_coords = [
                (float(graph.nodes[u]["lon"]), float(graph.nodes[u]["lat"])),
                (float(graph.nodes[v]["lon"]), float(graph.nodes[v]["lat"])),
            ]

        pts_xz = [to_local_xz(float(lon), float(lat)) for lon, lat in raw_coords]
        pts_xz[0] = (float(graph.nodes[u]["x_m"]), float(graph.nodes[u]["z_m"]))
        pts_xz[-1] = (float(graph.nodes[v]["x_m"]), float(graph.nodes[v]["z_m"]))

        has_streetcar = _is_direct_streetcar_edge(data)
        if not has_streetcar and tram_grid and highway not in {"motorway", "motorway_link", "service"}:
            has_streetcar = _matches_tram_network(pts_xz, layer, tram_grid)

        is_school_zone = (
            highway not in FREEWAY_HIGHWAYS | {"trunk"}
            and (clean_school_zone_tag(data) or _edge_in_school_zone(pts_xz, school_grid))
        )

        bus_bay_raw = " ".join(t.lower() for t in _flatten_tag_values(data.get("bus_bay")))
        has_bus_bay_l = "left" in bus_bay_raw or "both" in bus_bay_raw
        has_bus_bay_r = "right" in bus_bay_raw or "both" in bus_bay_raw

        midblock_controls: list[dict[str, Any]] = []
        if controls_by_way:
            seen_ctrl_ids: set[int] = set()
            xs = [p[0] for p in pts_xz]
            zs = [p[1] for p in pts_xz]
            min_x, max_x = min(xs) - 5.0, max(xs) + 5.0
            min_z, max_z = min(zs) - 5.0, max(zs) + 5.0
            for wid in osm_way_ids:
                for ctrl in controls_by_way.get(wid, []):
                    cid = int(ctrl["osm_node_id"])
                    if cid in (u, v) or cid in seen_ctrl_ids:
                        continue
                    cx, _, cz = ctrl["position"]
                    if (
                        min_x <= cx <= max_x
                        and min_z <= cz <= max_z
                        and _point_to_polyline_dist_m(cx, cz, pts_xz) <= 3.0
                    ):
                        seen_ctrl_ids.add(cid)
                        ctrl_copy = dict(ctrl)
                        if is_school_zone and ctrl_copy.get("markings") == "ladder":
                            ctrl_copy["markings"] = "school_ladder"
                        midblock_controls.append(ctrl_copy)

        data["highway_clean"] = highway
        data["junction_clean"] = junction
        data["oneway_clean"] = oneway
        data["lanes_clean"] = lanes
        data["lanes_total"] = lanes
        data["forward_lanes"] = forward_lanes
        data["reverse_lanes"] = reverse_lanes
        data["lanes_both_ways"] = lanes_both_ways
        data["lanes_reversible"] = lanes_reversible
        data["_bare_odd_untagged"] = (not oneway) and (not has_dir_or_turn_tags) and (lanes >= 3 and lanes % 2 == 1)
        data["turn_lanes_fwd"] = turn_lanes_fwd
        data["turn_lanes_rev"] = turn_lanes_rev
        data["bus_lanes_forward"] = bus_fwd
        data["bus_lanes_backward"] = bus_rev
        data["hov_lanes_forward"] = hov_fwd
        data["change_lanes_forward"] = chg_fwd
        data["placement_clean"] = placement_clean
        data["has_bike_lane"] = has_bike_lane
        data["bike_lane_left"] = bike_lane_left
        data["bike_lane_right"] = bike_lane_right
        data["bike_lane_left_type"] = b_left_t
        data["bike_lane_right_type"] = b_right_t
        data["is_school_zone"] = is_school_zone
        data["has_bus_bay_left"] = has_bus_bay_l
        data["has_bus_bay_right"] = has_bus_bay_r
        data["has_streetcar_tracks"] = has_streetcar
        data["maxspeed_kmh"] = maxspeed_kmh
        data["bridge_clean"] = bridge
        data["tunnel_clean"] = tunnel
        data["layer"] = layer
        data["name_clean"] = clean_name(data.get("name"))
        data["street_name"] = clean_street_name(data)
        data["osm_way_ids"] = osm_way_ids
        data["geometry_xz"] = pts_xz
        data["midblock_controls"] = midblock_controls

        if highway not in {"motorway", "motorway_link"}:
            for ctrl in midblock_controls:
                cx, _, cz = ctrl["position"]
                is_sig_ctrl = bool(ctrl.get("has_signals")) or ctrl.get("type") == "traffic_signals"
                is_cross_ctrl = ctrl.get("type") == "crossing" and ctrl.get("markings") != "none"
                for ep in (u, v):
                    ndata = graph.nodes[ep]
                    dist_ep = math.hypot(cx - float(ndata["x_m"]), cz - float(ndata["z_m"]))
                    if dist_ep <= 32.0:
                        if is_cross_ctrl:
                            ndata["has_crossing"] = True
                            if ctrl.get("markings") in {"lines", "school_ladder"}:
                                ndata["crosswalk_markings"] = ctrl["markings"]
                        if is_sig_ctrl and int(ndata.get("street_count", 0)) >= 3:
                            if not ndata["traffic_signal"]:
                                ndata["traffic_signal"] = True
                                ndata["control"] = "traffic_signals"
                                signal_count += 1

    forced_oneways = detect_divided_oneways(graph)
    logger.info("Classified %d motorway/roundabout edges as oneway.", forced_oneways)
    rail_polys_xz: list[tuple[list[tuple[float, float]], int]] = []
    if rail_ways_raw:
        for rw in rail_ways_raw:
            if rw.get("railway_type") == "rail":
                r_pts = [to_local_xz(lon, lat) for lon, lat in rw["coords"]]
                if len(r_pts) >= 2:
                    rail_polys_xz.append((r_pts, int(rw.get("layer", 0))))
    elev_summary = elevation_sampler.assign_graph_elevations(graph, rail_polys_xz=rail_polys_xz)
    return elev_summary, signal_count, stop_count


def _chunk_coord(x_m: float, z_m: float, chunk_size_m: float) -> tuple[int, int]:
    return (math.floor(x_m / chunk_size_m), math.floor(z_m / chunk_size_m))


def _serialize_node(
    node_id: int,
    data: dict[str, Any],
    owner_chunk: tuple[int, int],
    in_chunk: bool,
    approaches: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "id": int(node_id),
        "x": float(data["x_m"]),
        "y": float(data["y_m"]),
        "z": float(data["z_m"]),
        "ground_y": float(data["ground_y_m"]),
        "lat": float(data["lat"]),
        "lon": float(data["lon"]),
        "layer": int(data.get("layer", 0)),
        "street_count": int(data.get("street_count", 0)),
        "traffic_signal": bool(data.get("traffic_signal", False)),
        "stop_sign": bool(data.get("stop_sign", False)),
        "has_crossing": bool(data.get("has_crossing", False)),
        "crosswalk_markings": str(data.get("crosswalk_markings", "ladder")),
        "node_type": str(data.get("node_type", "normal")),
        "control": str(data.get("control", "none")),
        "in_chunk": in_chunk,
        "owner_chunk": [owner_chunk[0], owner_chunk[1]],
        "turn_restrictions": list(data.get("turn_restrictions", [])),
        "approaches": list(approaches or []),
    }
    if bool(data.get("suppress_midblock", False)):
        rec["suppress_midblock"] = True
    return rec


def _serialize_edge(u: int, v: int, key: int, data: dict[str, Any]) -> dict[str, Any]:
    hw_str = str(data["highway_clean"])
    lanes_tot = int(data["lanes_clean"])
    fwd_l = int(data.get("forward_lanes", lanes_tot))
    rev_l = int(data.get("reverse_lanes", 0))
    both_l = int(data.get("lanes_both_ways", 0))
    rev_c = int(data.get("lanes_reversible", 0))
    is_ow = bool(data["oneway_clean"])
    has_bike = bool(data.get("has_bike_lane", False))
    b_left_t = str(data.get("bike_lane_left_type", "none"))
    b_right_t = str(data.get("bike_lane_right_type", "none"))
    return {
        "id": f"{u}_{v}_{key}",
        "u": int(u),
        "v": int(v),
        "key": int(key),
        "osm_way_ids": list(data["osm_way_ids"]),
        "name": data["name_clean"],
        "street_name": data.get("street_name"),
        "highway": hw_str,
        "road_class": hw_str,
        "lanes": lanes_tot,
        "lanes_total": lanes_tot,
        "lanes_forward": fwd_l,
        "lanes_backward": rev_l,
        "lanes_both_ways": both_l,
        "lanes_reversible": rev_c,
        "turn_lanes_forward": data.get("turn_lanes_fwd"),
        "turn_lanes_backward": data.get("turn_lanes_rev"),
        "bus_lanes_forward": data.get("bus_lanes_forward"),
        "bus_lanes_backward": data.get("bus_lanes_backward"),
        "hov_lanes_forward": data.get("hov_lanes_forward"),
        "change_lanes_forward": data.get("change_lanes_forward"),
        "placement": data.get("placement_clean"),
        "has_streetcar_tracks": bool(data.get("has_streetcar_tracks", False)),
        "has_bike_lane": has_bike,
        "bike_lane_left": bool(data.get("bike_lane_left", False)),
        "bike_lane_right": bool(data.get("bike_lane_right", False)),
        "bike_lane_left_type": b_left_t,
        "bike_lane_right_type": b_right_t,
        "is_school_zone": bool(data.get("is_school_zone", False)),
        "has_bus_bay_left": bool(data.get("has_bus_bay_left", False)),
        "has_bus_bay_right": bool(data.get("has_bus_bay_right", False)),
        "width_m": _edge_width_from_lanes(lanes_tot, has_bike, b_left_t, b_right_t),
        "maxspeed_kmh": int(data["maxspeed_kmh"]),
        "oneway": is_ow,
        "is_oneway": is_ow,
        "bridge": bool(data["bridge_clean"]),
        "tunnel": bool(data["tunnel_clean"]),
        "layer": int(data["layer"]),
        "length_m": float(data["length_m"]),
        "geometry": data["geometry_xyz"],
        "turn_restrictions": list(data.get("turn_restrictions", [])),
        "midblock_controls": list(data.get("midblock_controls", [])),
    }


def _subdivide_long_physical_edges_for_chunks(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
    node_approaches: dict[int, list[dict[str, Any]]],
    intersection_groups: list[dict[str, Any]],
    node_owner: dict[int, tuple[int, int]],
    chunk_size: float,
) -> tuple[list[dict[str, Any]], dict[tuple[int, int], list[dict[str, Any]]]]:
    """Split >420 m corridor edges (e.g. Hwy 401/Gardiner) across local chunks so spans never unload."""
    subdivided: list[dict[str, Any]] = []
    synthetic_nodes_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    synth_counter = 0

    ig_apps_by_edge_node: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for ig in intersection_groups:
        for app in ig.get("approaches", []):
            ig_apps_by_edge_node[(str(app["edge_id"]), int(app["corner_node"]))].append(app)

    for edge in physical_edges:
        geom = edge.get("geometry") or []
        total_len = float(edge.get("length_m") or 0.0)
        if len(geom) < 3 or total_len <= 420.0 or edge.get("intersection_internal"):
            subdivided.append(edge)
            continue

        cum_dists: list[float] = [0.0]
        for i in range(len(geom) - 1):
            ax, ay, az = geom[i]
            bx, by, bz = geom[i + 1]
            cum_dists.append(cum_dists[-1] + math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2))
        geom_len = max(1e-3, cum_dists[-1])

        cut_indices = [0]
        last_cut_d = 0.0
        for i in range(1, len(geom) - 1):
            if cum_dists[i] - last_cut_d >= 360.0 and (geom_len - cum_dists[i]) >= 120.0:
                cut_indices.append(i)
                last_cut_d = cum_dists[i]
        cut_indices.append(len(geom) - 1)

        if len(cut_indices) <= 2:
            subdivided.append(edge)
            continue

        orig_u = int(edge["u"])
        orig_v = int(edge["v"])
        orig_id = str(edge["id"])
        u_gy = float(graph.nodes[orig_u].get("ground_y", geom[0][1]))
        v_gy = float(graph.nodes[orig_v].get("ground_y", geom[-1][1]))
        num_pieces = len(cut_indices) - 1

        cut_node_ids: list[int] = [orig_u]
        for k in range(1, len(cut_indices) - 1):
            synth_counter += 1
            cut_node_ids.append(-900_000_000 - synth_counter)
        cut_node_ids.append(orig_v)

        all_mid_ctrls = list(edge.get("midblock_controls", []))

        for p_idx in range(num_pieces):
            i0 = cut_indices[p_idx]
            i1 = cut_indices[p_idx + 1]
            sub_geom = geom[i0 : i1 + 1]
            sub_len = round(max(1.0, cum_dists[i1] - cum_dists[i0]), 3)
            u_piece = cut_node_ids[p_idx]
            v_piece = cut_node_ids[p_idx + 1]
            piece_id = orig_id if p_idx == 0 else f"{orig_id}__s{p_idx}"

            mid_pt = sub_geom[len(sub_geom) // 2]
            if p_idx == 0:
                piece_chunk = node_owner[orig_u]
            elif p_idx == num_pieces - 1:
                piece_chunk = node_owner[orig_v]
            else:
                piece_chunk = _chunk_coord(float(mid_pt[0]), float(mid_pt[2]), chunk_size)

            sub_pts_xz = [(float(p[0]), float(p[2])) for p in sub_geom]
            sub_ctrls = [
                c
                for c in all_mid_ctrls
                if _point_to_polyline_dist_m(float(c["position"][0]), float(c["position"][2]), sub_pts_xz) <= 4.0
            ]

            piece = dict(edge)
            piece["id"] = piece_id
            piece["u"] = u_piece
            piece["v"] = v_piece
            piece["geometry"] = sub_geom
            piece["length_m"] = sub_len
            piece["trim_start_m"] = float(edge.get("trim_start_m", 0.0)) if p_idx == 0 else 0.0
            piece["trim_end_m"] = float(edge.get("trim_end_m", 0.0)) if p_idx == num_pieces - 1 else 0.0
            piece["turn_lanes_rev"] = edge.get("turn_lanes_rev") if p_idx == 0 else None
            piece["turn_lanes_backward"] = edge.get("turn_lanes_backward") if p_idx == 0 else None
            piece["turn_lanes_fwd"] = edge.get("turn_lanes_fwd") if p_idx == num_pieces - 1 else None
            piece["turn_lanes_forward"] = edge.get("turn_lanes_forward") if p_idx == num_pieces - 1 else None
            if edge.get("right_pocket_lanes"):
                piece["right_pocket_lanes"] = int(edge["right_pocket_lanes"]) if p_idx == num_pieces - 1 else 0
            piece["midblock_controls"] = sub_ctrls
            piece["_owner_chunk"] = piece_chunk
            subdivided.append(piece)

            # Register synthetic cut endpoint nodes with exact interpolated ground_y in local chunk
            for c_idx, nid in ((i0, u_piece), (i1, v_piece)):
                if nid < 0:
                    pt = geom[c_idx]
                    frac = max(0.0, min(1.0, cum_dists[c_idx] / geom_len))
                    gy = round(u_gy + (v_gy - u_gy) * frac, 3)
                    synthetic_nodes_by_chunk[piece_chunk].append(
                        {
                            "id": nid,
                            "lat": 0.0,
                            "lon": 0.0,
                            "x": round(float(pt[0]), 3),
                            "y": round(float(pt[1]), 3),
                            "z": round(float(pt[2]), 3),
                            "ground_y": gy,
                            "chunk_id": f"chunk_{piece_chunk[0]}_{piece_chunk[1]}",
                            "in_chunk": True,
                            "traffic_signal": False,
                            "stop_sign": False,
                            "has_crossing": False,
                            "node_type": "normal",
                            "control": "none",
                            "street_count": 2,
                            "approaches": [],
                        }
                    )

            if p_idx == num_pieces - 1:
                for app in node_approaches.get(orig_v, []):
                    if str(app.get("edge_id")) == orig_id:
                        app["edge_id"] = piece_id
                        app["edge_length_m"] = sub_len
                for app in ig_apps_by_edge_node.get((orig_id, orig_v), []):
                    app["edge_id"] = piece_id

    return subdivided, synthetic_nodes_by_chunk


def _partition_rail_tracks_to_chunks(
    rail_tracks: list[dict[str, Any]],
    chunk_size: float,
) -> dict[tuple[int, int], list[dict[str, Any]]]:
    """Subdivide long rail/tram corridors into local <=350m spans assigned to chunk coords."""
    by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for rt in rail_tracks:
        geom = rt.get("geometry") or []
        if len(geom) < 2:
            continue
        cum = [0.0]
        for i in range(len(geom) - 1):
            ax, ay, az = geom[i]
            bx, by, bz = geom[i + 1]
            cum.append(cum[-1] + math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2))
        total = cum[-1]
        cuts = [0]
        last_d = 0.0
        for i in range(1, len(geom) - 1):
            if cum[i] - last_d >= 320.0 and (total - cum[i]) >= 80.0:
                cuts.append(i)
                last_d = cum[i]
        cuts.append(len(geom) - 1)
        for p_idx in range(len(cuts) - 1):
            sub_g = geom[cuts[p_idx] : cuts[p_idx + 1] + 1]
            if len(sub_g) < 2:
                continue
            mid = sub_g[len(sub_g) // 2]
            cc = _chunk_coord(float(mid[0]), float(mid[2]), chunk_size)
            piece = dict(rt)
            piece["id"] = rt["id"] if p_idx == 0 else f"{rt['id']}__s{p_idx}"
            piece["geometry"] = sub_g
            by_chunk[cc].append(piece)
    return by_chunk


def _build_global_terrain_indexer(
    graph: nx.MultiDiGraph,
    physical_edges: list[dict[str, Any]],
) -> Any:
    """Build fast global heightfield sampler clamped strictly below every ground road segment."""
    cell_size = 60.0
    cells: dict[tuple[int, int], list[tuple[float, float, float]]] = defaultdict(list)

    def _add_pt(px: float, py: float, pz: float) -> None:
        cells[(int(math.floor(px / cell_size)), int(math.floor(pz / cell_size)))].append(
            (px, py, pz)
        )

    for _, nd in graph.nodes(data=True):
        gy = float(nd.get("ground_y", nd.get("y_m", 0.0)))
        _add_pt(float(nd["x_m"]), gy, float(nd["z_m"]))

    for edge in physical_edges:
        if int(edge.get("layer", 0)) != 0 or edge.get("bridge") or edge.get("tunnel"):
            continue
        geom = edge.get("geometry") or []
        for i in range(len(geom) - 1):
            ax, ay, az = float(geom[i][0]), float(geom[i][1]), float(geom[i][2])
            bx, by, bz = float(geom[i + 1][0]), float(geom[i + 1][1]), float(geom[i + 1][2])
            seg_len = math.hypot(bx - ax, bz - az)
            steps = max(1, int(math.ceil(seg_len / 10.0)))
            for s in range(steps):
                t = s / steps
                _add_pt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)
        if geom:
            last = geom[-1]
            _add_pt(float(last[0]), float(last[1]), float(last[2]))

    grid_cache: dict[tuple[int, int], float] = {}
    guard_r2 = 56.0 * 56.0

    def sample_vertex(gix: int, giz: int, step_m: float, fallback_y: float) -> float:
        cached = grid_cache.get((gix, giz))
        if cached is not None:
            return cached
        wx = gix * step_m
        wz = giz * step_m
        cx = int(math.floor(wx / cell_size))
        cz = int(math.floor(wz / cell_size))

        local_min_y = float("inf")
        w_sum = 0.0
        y_sum = 0.0
        for dx_c in (-1, 0, 1):
            for dz_c in (-1, 0, 1):
                for sx, sy, sz in cells.get((cx + dx_c, cz + dz_c), ()):
                    d2 = (wx - sx) ** 2 + (wz - sz) ** 2
                    if d2 <= guard_r2 and sy < local_min_y:
                        local_min_y = sy
                    w = 1.0 / (d2 + 360.0)
                    w_sum += w
                    y_sum += w * sy

        if w_sum <= 0.0:
            for dx_c in range(-3, 4):
                for dz_c in range(-3, 4):
                    if abs(dx_c) <= 1 and abs(dz_c) <= 1:
                        continue
                    for sx, sy, sz in cells.get((cx + dx_c, cz + dz_c), ()):
                        d2 = (wx - sx) ** 2 + (wz - sz) ** 2
                        w = 1.0 / (d2 + 360.0)
                        w_sum += w
                        y_sum += w * sy

        idw_y = (y_sum / w_sum if w_sum > 0.0 else fallback_y) - 0.48
        val = min(idw_y, local_min_y - 0.45) if local_min_y < float("inf") else idw_y
        out = round(val, 2)
        grid_cache[(gix, giz)] = out
        return out

    return sample_vertex


def write_spatial_chunks(
    graph: nx.MultiDiGraph,
    config: PipelineConfig,
    origin_utm: tuple[float, float],
    elev_summary: dict[str, Any],
    total_turn_restrictions: int,
    signal_count: int,
    stop_count: int,
    *,
    to_local_xz: Any = None,
    elevation_sampler: ElevationSampler | None = None,
    tram_ways_lonlat: list[tuple[list[tuple[float, float]], int]] | None = None,
    rail_ways_raw: list[dict[str, Any]] | None = None,
    crossing_nodes_raw: list[dict[str, Any]] | None = None,
    bus_stop_nodes_raw: list[dict[str, Any]] | None = None,
) -> Path:
    """Partition the processed graph into 500 m x 500 m JSON chunks + manifest."""
    output_dir = config.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    for stale in output_dir.glob("chunk_*.json"):
        stale.unlink()

    tram_grid = _build_tram_grid(tram_ways_lonlat, to_local_xz) if (tram_ways_lonlat and to_local_xz) else None
    (
        physical_edges,
        directed_edges,
        node_approaches,
        intersection_groups,
        median_islands,
        median_transitions,
        highway_gores,
    ) = collapse_bidirectional_edges(graph, tram_grid=tram_grid)

    chunk_size = config.chunk_size_m
    node_owner: dict[int, tuple[int, int]] = {}
    owned_nodes_by_chunk: dict[tuple[int, int], list[int]] = defaultdict(list)

    for node_id, data in graph.nodes(data=True):
        coord = _chunk_coord(float(data["x_m"]), float(data["z_m"]), chunk_size)
        node_owner[int(node_id)] = coord
        owned_nodes_by_chunk[coord].append(int(node_id))

    physical_edges, synthetic_nodes_by_chunk = _subdivide_long_physical_edges_for_chunks(
        graph,
        physical_edges,
        node_approaches,
        intersection_groups,
        node_owner,
        chunk_size,
    )

    rail_tracks: list[dict[str, Any]] = []
    rail_crossings: list[dict[str, Any]] = []
    bus_bays: list[dict[str, Any]] = []
    if to_local_xz and elevation_sampler:
        road_pts_grid: dict[tuple[int, int], list[tuple[float, float, float, int]]] = defaultdict(list)
        for edge in physical_edges:
            elayer = int(edge.get("layer", 0))
            egeom = edge["geometry"]
            for gi in range(len(egeom) - 1):
                ax, ay, az = float(egeom[gi][0]), float(egeom[gi][1]), float(egeom[gi][2])
                bx, by, bz = float(egeom[gi + 1][0]), float(egeom[gi + 1][1]), float(egeom[gi + 1][2])
                seg_len = math.hypot(bx - ax, bz - az)
                steps = max(1, int(math.ceil(seg_len / 3.5)))
                for st in range(steps):
                    t = st / steps
                    px = ax + (bx - ax) * t
                    py = ay + (by - ay) * t
                    pz = az + (bz - az) * t
                    road_pts_grid[(int(math.floor(px / 40.0)), int(math.floor(pz / 40.0)))].append(
                        (px, py, pz, elayer)
                    )
            if egeom:
                lp = egeom[-1]
                lx, ly, lz = float(lp[0]), float(lp[1]), float(lp[2])
                road_pts_grid[(int(math.floor(lx / 40.0)), int(math.floor(lz / 40.0)))].append(
                    (lx, ly, lz, elayer)
                )
        if rail_ways_raw:
            rail_tracks = _build_rail_tracks_3d(
                rail_ways_raw,
                to_local_xz,
                elevation_sampler,
                road_pts_grid,
                intersection_groups=intersection_groups,
            )
        if crossing_nodes_raw:
            rail_crossings = _build_rail_crossings_3d(crossing_nodes_raw, to_local_xz, physical_edges, rail_tracks)
        if bus_stop_nodes_raw:
            bus_bays = _build_bus_bays_3d(bus_stop_nodes_raw, to_local_xz, physical_edges)

    logger.info(
        "Collapsed %d directed edges into %d physical segments (%d IGs, %d medians, %d Y-splits, %d highway gores, %d rail tracks, %d crossings, %d bus bays).",
        len(directed_edges),
        len(physical_edges),
        len(intersection_groups),
        len(median_islands),
        len(median_transitions),
        len(highway_gores),
        len(rail_tracks),
        len(rail_crossings),
        len(bus_bays),
    )

    edges_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for edge in physical_edges:
        owner = edge.pop("_owner_chunk", None) or node_owner[int(edge["u"])]
        edges_by_chunk[owner].append(edge)

    directed_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for dedge in directed_edges:
        owner = node_owner[int(dedge["u"])]
        directed_by_chunk[owner].append(dedge)

    groups_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for ig in intersection_groups:
        owner = node_owner[int(ig["owner_node"])]
        groups_by_chunk[owner].append(ig)

    medians_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for med in median_islands:
        owner = node_owner[int(med["owner_node"])]
        medians_by_chunk[owner].append(med)

    transitions_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for mt in median_transitions:
        owner = node_owner[int(mt["split_node"])]
        transitions_by_chunk[owner].append(mt)

    gores_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for g in highway_gores:
        owner = node_owner[int(g["node_id"])]
        gores_by_chunk[owner].append(g)

    rails_by_chunk = _partition_rail_tracks_to_chunks(rail_tracks, chunk_size)

    crossings_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for rc in rail_crossings:
        pos = rc["position"]
        crossings_by_chunk[_chunk_coord(float(pos[0]), float(pos[2]), chunk_size)].append(rc)

    bays_by_chunk: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for bb in bus_bays:
        pos = bb["position"]
        bays_by_chunk[_chunk_coord(float(pos[0]), float(pos[2]), chunk_size)].append(bb)

    all_chunks = sorted(
        set(owned_nodes_by_chunk.keys())
        | set(edges_by_chunk.keys())
        | set(rails_by_chunk.keys())
    )
    sample_terrain_vertex = _build_global_terrain_indexer(graph, physical_edges)
    terrain_grid_divs = 16
    terrain_step_m = chunk_size / terrain_grid_divs
    manifest_chunks: list[dict[str, Any]] = []

    for gx, gz in all_chunks:
        chunk_id = f"chunk_{gx}_{gz}"
        file_name = f"{chunk_id}.json"
        bounds_m = {
            "min_x": gx * chunk_size,
            "max_x": (gx + 1) * chunk_size,
            "min_z": gz * chunk_size,
            "max_z": (gz + 1) * chunk_size,
        }

        chunk_owned_ids = sorted(owned_nodes_by_chunk.get((gx, gz), []))
        edges_payload = sorted(
            edges_by_chunk.get((gx, gz), []),
            key=lambda item: (item["u"], item["v"], item["key"]),
        )
        directed_payload = sorted(
            directed_by_chunk.get((gx, gz), []),
            key=lambda item: (item["u"], item["v"], item["key"]),
        )
        groups_payload = groups_by_chunk.get((gx, gz), [])
        medians_payload = medians_by_chunk.get((gx, gz), [])
        transitions_payload = transitions_by_chunk.get((gx, gz), [])
        gores_payload = gores_by_chunk.get((gx, gz), [])
        rails_payload = rails_by_chunk.get((gx, gz), [])
        crossings_payload = crossings_by_chunk.get((gx, gz), [])
        bays_payload = bays_by_chunk.get((gx, gz), [])

        referenced_ids: set[int] = set(chunk_owned_ids)
        for edge in edges_payload:
            referenced_ids.add(int(edge["u"]))
            referenced_ids.add(int(edge["v"]))

        nodes_payload: list[dict[str, Any]] = []
        chunk_restriction_count = 0
        for nid in sorted(referenced_ids):
            if nid < 0:
                continue
            ndata = graph.nodes[nid]
            owner = node_owner[nid]
            in_chunk = owner == (gx, gz)
            if in_chunk:
                chunk_restriction_count += len(ndata.get("turn_restrictions", []))
            nodes_payload.append(
                _serialize_node(
                    nid,
                    ndata,
                    owner,
                    in_chunk,
                    approaches=node_approaches.get(nid, []),
                )
            )
        nodes_payload.extend(synthetic_nodes_by_chunk.get((gx, gz), []))

        fallback_chunk_y = (
            sum(float(n["ground_y"]) for n in nodes_payload) / len(nodes_payload)
            if nodes_payload
            else 80.0
        )
        base_gix = gx * terrain_grid_divs
        base_giz = gz * terrain_grid_divs
        terrain_grid = [
            [
                sample_terrain_vertex(
                    base_gix + ix, base_giz + iz, terrain_step_m, fallback_chunk_y
                )
                for ix in range(terrain_grid_divs + 1)
            ]
            for iz in range(terrain_grid_divs + 1)
        ]

        chunk_doc = {
            "chunk": {
                "id": chunk_id,
                "gx": gx,
                "gz": gz,
                "chunk_size_m": chunk_size,
                "bounds_m": bounds_m,
            },
            "nodes": nodes_payload,
            "edges": edges_payload,
            "directed_edges": directed_payload,
            "intersection_groups": groups_payload,
            "median_islands": medians_payload,
            "median_transitions": transitions_payload,
            "highway_gores": gores_payload,
            "rail_tracks": rails_payload,
            "rail_crossings": crossings_payload,
            "bus_bays": bays_payload,
            "terrain_grid": terrain_grid,
        }
        (output_dir / file_name).write_text(
            json.dumps(chunk_doc, separators=(",", ":")),
            encoding="utf-8",
        )

        manifest_chunks.append(
            {
                "id": chunk_id,
                "gx": gx,
                "gz": gz,
                "file": file_name,
                "bounds_m": bounds_m,
                "node_count": len(chunk_owned_ids),
                "referenced_node_count": len(nodes_payload),
                "edge_count": len(edges_payload),
                "directed_edge_count": len(directed_payload),
                "turn_restriction_count": chunk_restriction_count,
            }
        )

    gx_vals = [c[0] for c in all_chunks] or [0]
    gz_vals = [c[1] for c in all_chunks] or [0]

    manifest_doc = {
        "version": "1.2.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox_wgs84": config.bbox.to_dict(),
        "projection": {
            "crs": config.utm_epsg,
            "origin_wgs84": {
                "lat": config.origin_lat,
                "lon": config.origin_lon,
                "label": "Yonge & Dundas",
            },
            "origin_utm": {
                "easting": round(origin_utm[0], 3),
                "northing": round(origin_utm[1], 3),
            },
            "axes": {
                "x": "+east_meters",
                "y": "+up_meters",
                "z": "+south_meters (-north)",
            },
        },
        "elevation": elev_summary,
        "chunk_size_m": chunk_size,
        "grid_bounds": {
            "min_gx": min(gx_vals),
            "max_gx": max(gx_vals),
            "min_gz": min(gz_vals),
            "max_gz": max(gz_vals),
        },
        "stats": {
            "total_nodes": graph.number_of_nodes(),
            "total_edges": len(directed_edges),
            "total_physical_edges": len(physical_edges),
            "total_turn_restrictions": total_turn_restrictions,
            "traffic_signal_nodes": signal_count,
            "stop_sign_nodes": stop_count,
            "chunk_count": len(manifest_chunks),
        },
        "chunks": manifest_chunks,
    }

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest_doc, indent=2), encoding="utf-8")

    # Compact city-wide vector road index for the native in-game minimap & fullscreen M map
    minimap_roads: list[dict[str, Any]] = []
    for edge in physical_edges:
        geom = edge["geometry"]
        pts_xz = [[round(float(p[0])), round(float(p[2]))] for p in geom]
        if len(pts_xz) > 2:
            simplified = [pts_xz[0]]
            for pt in pts_xz[1:-1]:
                lx, lz = simplified[-1]
                if math.hypot(pt[0] - lx, pt[1] - lz) >= 12.0:
                    simplified.append(pt)
            simplified.append(pts_xz[-1])
            pts_xz = simplified
        minimap_roads.append(
            {
                "n": edge.get("street_name"),
                "h": edge["highway"],
                "l": int(edge["lanes"]),
                "w": round(float(edge["width_m"]), 1),
                "o": bool(edge["oneway"]),
                "y": round(float(geom[0][1]), 1) if geom else 0.0,
                "z": int(edge["layer"]),
                "p": pts_xz,
            }
        )
    (output_dir / "minimap_roads.json").write_text(
        json.dumps({"roads": minimap_roads}, separators=(",", ":")),
        encoding="utf-8",
    )

    return manifest_path


BBBIKE_TORONTO_PBF_URL = "https://download.bbbike.org/osm/bbbike/Toronto/Toronto.osm.pbf"

_DRIVE_EXCLUDED_HIGHWAY = {
    "abandoned",
    "bridleway",
    "bus_guideway",
    "construction",
    "corridor",
    "cycleway",
    "elevator",
    "escalator",
    "footway",
    "no",
    "path",
    "pedestrian",
    "planned",
    "platform",
    "proposed",
    "raceway",
    "razed",
    "rest_area",
    "service",
    "services",
    "steps",
    "track",
}
_DRIVE_EXCLUDED_SERVICE = {
    "alley",
    "driveway",
    "emergency_access",
    "parking",
    "parking_aisle",
    "private",
}
_PBF_WAY_KEYS = {
    "highway",
    "name",
    "ref",
    "alt_name",
    "destination:ref",
    "lanes",
    "lanes:forward",
    "lanes:backward",
    "lanes:both_ways",
    "lanes:conditional",
    "placement",
    "placement:forward",
    "placement:backward",
    "maxspeed",
    "maxspeed:advisory",
    "maxspeed:conditional",
    "hazard",
    "zone:maxspeed",
    "school:zone",
    "oneway",
    "bridge",
    "tunnel",
    "layer",
    "junction",
    "turn:lanes",
    "turn:lanes:forward",
    "turn:lanes:backward",
    "turn:lanes:both_ways",
    "bus:lanes",
    "bus:lanes:forward",
    "bus:lanes:backward",
    "lanes:bus",
    "lanes:bus:forward",
    "lanes:bus:backward",
    "psv:lanes",
    "psv:lanes:forward",
    "psv:lanes:backward",
    "bus_bay",
    "bus_bay:left",
    "bus_bay:right",
    "bus_bay:both",
    "hov:lanes",
    "hov:lanes:forward",
    "hov:lanes:backward",
    "change:lanes",
    "change:lanes:forward",
    "change:lanes:backward",
    "motor_vehicle:lanes",
    "motor_vehicle:lanes:forward",
    "motor_vehicle:lanes:backward",
    "bicycle:lanes",
    "cycleway",
    "cycleway:left",
    "cycleway:right",
    "cycleway:both",
    "cycleway:lane",
    "cycleway:left:lane",
    "cycleway:right:lane",
    "cycleway:both:lane",
    "cycleway:separation",
    "cycleway:left:separation",
    "cycleway:right:separation",
    "cycleway:both:separation",
    "cycleway:buffer",
    "cycleway:surface",
    "railway",
    "tram",
    "embedded_rails",
    "embedded_rails:lanes",
    "width",
}
_PBF_NODE_KEYS = {
    "highway",
    "traffic_signals",
    "stop",
    "direction",
    "traffic_signals:direction",
    "crossing",
    "crossing:markings",
    "crossing:signals",
    "crossing:island",
    "flashing_lights",
    "railway",
    "crossing:barrier",
    "crossing:light",
    "crossing:saltire",
    "crossing:bell",
    "public_transport",
    "bus",
}


def _load_toronto_boundary_polygon(
    place_name: str,
    cache_dir: Path,
    use_cache: bool,
) -> Any:
    """Return buffered municipal boundary polygon for ``place_name`` (cached GeoJSON)."""
    import geopandas as gpd  # type: ignore[import-untyped]
    import shapely

    cache_key = hashlib.sha256(place_name.encode("utf-8")).hexdigest()[:12]
    boundary_file = cache_dir / f"boundary_{cache_key}.geojson"
    if use_cache and boundary_file.exists():
        gdf = gpd.read_file(boundary_file)
    else:
        gdf = ox.geocode_to_gdf(place_name)
        if use_cache:
            cache_dir.mkdir(parents=True, exist_ok=True)
            gdf.to_file(boundary_file, driver="GeoJSON")

    # Buffer ~110 m (0.0012 deg) so municipal boundary roads such as Steeles Ave E
    # and Rouge/Etobicoke border crossings are retained cleanly end-to-end.
    poly = gdf.geometry.iloc[0].buffer(0.0012)
    shapely.prepare(poly)
    return poly


def _orient_reverse_edge_attrs(tdict: dict[str, Any], *, is_synthetic_reverse: bool) -> dict[str, Any]:
    """Return tag copy oriented for travel opposite to OSM way node order."""
    rev = dict(tdict)
    for k_a, k_b in (
        ("lanes:forward", "lanes:backward"),
        ("turn:lanes:forward", "turn:lanes:backward"),
        ("placement:forward", "placement:backward"),
        ("cycleway:left", "cycleway:right"),
        ("cycleway:left:lane", "cycleway:right:lane"),
        ("cycleway:left:separation", "cycleway:right:separation"),
        ("bus:lanes:forward", "bus:lanes:backward"),
        ("lanes:bus:forward", "lanes:bus:backward"),
        ("psv:lanes:forward", "psv:lanes:backward"),
        ("hov:lanes:forward", "hov:lanes:backward"),
        ("change:lanes:forward", "change:lanes:backward"),
        ("motor_vehicle:lanes:forward", "motor_vehicle:lanes:backward"),
        ("bus_bay:left", "bus_bay:right"),
    ):
        has_a = k_a in tdict
        has_b = k_b in tdict
        if has_a:
            rev[k_b] = tdict[k_a]
        else:
            rev.pop(k_b, None)
        if has_b:
            rev[k_a] = tdict[k_b]
        else:
            rev.pop(k_a, None)

    if is_synthetic_reverse:
        for bare_k in ("turn:lanes", "bus:lanes", "psv:lanes", "hov:lanes", "change:lanes", "lanes:bus"):
            if f"{bare_k}:backward" not in tdict and bare_k in rev:
                rev.pop(bare_k, None)
        bay = str(tdict.get("bus_bay") or "").strip().lower()
        if bay == "left":
            rev["bus_bay"] = "right"
        elif bay == "right":
            rev["bus_bay"] = "left"
        cyc = str(tdict.get("cycleway") or "").strip().lower()
        if cyc == "left":
            rev["cycleway"] = "right"
        elif cyc == "right":
            rev["cycleway"] = "left"
    else:
        if "turn:lanes" in rev and "turn:lanes:backward" in tdict:
            rev.pop("turn:lanes", None)

    rev["_is_osm_reverse"] = bool(is_synthetic_reverse)
    return rev


def _load_city_from_pbf(
    place_name: str,
    cache_dir: Path,
    use_cache: bool,
    retain_all: bool,
    ca_bundle: str | None,
) -> tuple[
    nx.MultiDiGraph,
    nx.MultiDiGraph,
    list[dict[str, Any]],
    list[tuple[list[tuple[float, float]], int]],
    list[list[tuple[float, float]]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    BoundingBox,
]:
    """Extract drivable OSM network, rail/tram tracks, schools, crossings, bus stops & restrictions from BBBike PBF."""
    import numpy as np
    import osmium  # type: ignore[import-not-found]
    import shapely

    poly = _load_toronto_boundary_polygon(place_name, cache_dir, use_cache)
    minx, miny, maxx, maxy = poly.bounds

    pbf_path = cache_dir / "Toronto.osm.pbf"
    if not (use_cache and pbf_path.exists() and pbf_path.stat().st_size > 1_000_000):
        cache_dir.mkdir(parents=True, exist_ok=True)
        logger.info("Downloading BBBike Toronto OSM PBF extract (%s)...", BBBIKE_TORONTO_PBF_URL)
        with requests.get(
            BBBIKE_TORONTO_PBF_URL,
            stream=True,
            timeout=180,
            headers={"User-Agent": "TorontoDriveSim/1.0"},
            verify=ca_bundle if ca_bundle else True,
        ) as response:
            response.raise_for_status()
            tmp_path = pbf_path.with_suffix(".tmp")
            with open(tmp_path, "wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)
            tmp_path.replace(pbf_path)

    class _WayAndRelHandler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.ways: list[tuple[list[int], dict[str, Any]]] = []
            self.tram_ways: list[tuple[list[int], int]] = []
            self.rail_ways: list[tuple[int, list[int], str, str | None, int, bool]] = []
            self.school_ways: list[list[int]] = []
            self.needed_nodes: set[int] = set()
            self.restrictions: list[dict[str, Any]] = []

        def way(self, w: Any) -> None:
            tags = w.tags
            rw = tags.get("railway")
            if rw in {"tram", "light_rail", "rail"}:
                svc = tags.get("service")
                tun = str(tags.get("tunnel") or "").strip().lower()
                if svc not in {"yard", "siding", "crossover"} and tun not in {"yes", "true", "1"}:
                    rnids = [int(n.ref) for n in w.nodes]
                    if len(rnids) >= 2:
                        rlayer = clean_layer(tags.get("layer"))
                        rbridge = clean_bool_tag(tags.get("bridge"))
                        rname = clean_name(tags.get("name"))
                        if rw in {"tram", "light_rail"}:
                            self.tram_ways.append((rnids, rlayer))
                        self.rail_ways.append((int(w.id), rnids, str(rw), rname, rlayer, rbridge))
                        self.needed_nodes.update(rnids)

            amenity = tags.get("amenity")
            if amenity in {"school", "kindergarten"} or tags.get("landuse") == "school":
                snids = [int(n.ref) for n in w.nodes]
                if len(snids) >= 3:
                    self.school_ways.append(snids)
                    self.needed_nodes.update(snids)

            hw = tags.get("highway")
            if not hw or hw in _DRIVE_EXCLUDED_HIGHWAY:
                return
            if tags.get("area") == "yes" or tags.get("access") == "private":
                return
            if tags.get("motor_vehicle") == "no" or tags.get("motorcar") == "no":
                return
            svc = tags.get("service")
            if svc and svc in _DRIVE_EXCLUDED_SERVICE:
                return
            nids = [int(n.ref) for n in w.nodes]
            if len(nids) < 2:
                return
            tdict: dict[str, Any] = {k: tags[k] for k in _PBF_WAY_KEYS if k in tags}
            tdict["osmid"] = int(w.id)
            self.ways.append((nids, tdict))
            self.needed_nodes.update(nids)

        def relation(self, r: Any) -> None:
            if r.tags.get("type") == "restriction":
                type_map = {"n": "node", "w": "way", "r": "relation"}
                self.restrictions.append(
                    {
                        "id": int(r.id),
                        "tags": dict(r.tags),
                        "members": [
                            {
                                "type": type_map.get(m.type, m.type),
                                "ref": int(m.ref),
                                "role": m.role,
                            }
                            for m in r.members
                        ],
                    }
                )

    logger.info("Parsing drivable ways, rail corridors, schools, and turn restrictions from %s...", pbf_path)
    way_handler = _WayAndRelHandler()
    way_handler.apply_file(str(pbf_path), locations=False)

    class _NodeHandler(osmium.SimpleHandler):
        def __init__(self, needed: set[int]) -> None:
            super().__init__()
            self.needed = needed
            self.nodes: dict[int, tuple[float, float, dict[str, Any]]] = {}
            self.crossing_nodes: list[tuple[int, float, float, str]] = []
            self.bus_stop_nodes: list[tuple[int, float, float]] = []

        def node(self, n: Any) -> None:
            nid = int(n.id)
            in_needed = nid in self.needed
            tags_obj = n.tags
            if not in_needed and len(tags_obj) == 0:
                return
            if not n.location.valid():
                return
            lon = float(n.location.lon)
            lat = float(n.location.lat)
            if not (minx <= lon <= maxx and miny <= lat <= maxy):
                return
            if in_needed:
                ntags = {k: tags_obj[k] for k in _PBF_NODE_KEYS if k in tags_obj}
                self.nodes[nid] = (lon, lat, ntags)
            rw_val = tags_obj.get("railway")
            if rw_val in {"level_crossing", "tram_level_crossing"}:
                self.crossing_nodes.append(
                    (nid, lon, lat, "rail" if rw_val == "level_crossing" else "tram")
                )
            elif tags_obj.get("highway") == "bus_stop" or (
                tags_obj.get("bus") == "yes" and tags_obj.get("public_transport") == "platform"
            ):
                self.bus_stop_nodes.append((nid, lon, lat))

    node_handler = _NodeHandler(way_handler.needed_nodes)
    node_handler.apply_file(str(pbf_path), locations=False)

    # Vectorized containment filter inside the buffered City of Toronto polygon
    all_nids = list(node_handler.nodes.keys())
    lons_arr = np.array([node_handler.nodes[nid][0] for nid in all_nids], dtype=np.float64)
    lats_arr = np.array([node_handler.nodes[nid][1] for nid in all_nids], dtype=np.float64)
    inside_mask = shapely.contains_xy(poly, lons_arr, lats_arr)
    inside_nids = {nid for nid, flag in zip(all_nids, inside_mask) if flag}

    tram_ways_lonlat: list[tuple[list[tuple[float, float]], int]] = []
    for nids, tram_layer in way_handler.tram_ways:
        if any(nid in inside_nids for nid in nids) and all(nid in node_handler.nodes for nid in nids):
            tram_ways_lonlat.append(
                ([(node_handler.nodes[nid][0], node_handler.nodes[nid][1]) for nid in nids], tram_layer)
            )

    rail_ways_raw: list[dict[str, Any]] = []
    for osm_id, nids, rw_type, rw_name, rw_layer, rw_bridge in way_handler.rail_ways:
        if any(nid in inside_nids for nid in nids) and all(nid in node_handler.nodes for nid in nids):
            rail_ways_raw.append(
                {
                    "osm_id": osm_id,
                    "railway_type": rw_type,
                    "name": rw_name,
                    "layer": rw_layer,
                    "bridge": rw_bridge,
                    "coords": [(node_handler.nodes[nid][0], node_handler.nodes[nid][1]) for nid in nids],
                }
            )

    school_polys_lonlat: list[list[tuple[float, float]]] = []
    for nids in way_handler.school_ways:
        if any(nid in inside_nids for nid in nids) and all(nid in node_handler.nodes for nid in nids):
            school_polys_lonlat.append(
                [(node_handler.nodes[nid][0], node_handler.nodes[nid][1]) for nid in nids]
            )

    crossing_nodes_raw: list[dict[str, Any]] = []
    if node_handler.crossing_nodes:
        c_lons = np.array([c[1] for c in node_handler.crossing_nodes], dtype=np.float64)
        c_lats = np.array([c[2] for c in node_handler.crossing_nodes], dtype=np.float64)
        c_mask = shapely.contains_xy(poly, c_lons, c_lats)
        for (nid, lon, lat, ctype), keep in zip(node_handler.crossing_nodes, c_mask):
            if keep:
                crossing_nodes_raw.append(
                    {"osm_id": nid, "lon": lon, "lat": lat, "crossing_type": ctype}
                )

    bus_stop_nodes_raw: list[dict[str, Any]] = []
    if node_handler.bus_stop_nodes:
        b_lons = np.array([b[1] for b in node_handler.bus_stop_nodes], dtype=np.float64)
        b_lats = np.array([b[2] for b in node_handler.bus_stop_nodes], dtype=np.float64)
        b_mask = shapely.contains_xy(poly, b_lons, b_lats)
        for (nid, lon, lat), keep in zip(node_handler.bus_stop_nodes, b_mask):
            if keep:
                bus_stop_nodes_raw.append({"osm_id": nid, "lon": lon, "lat": lat})

    raw_graph = nx.MultiDiGraph(crs="EPSG:4326")
    for nids, tdict in way_handler.ways:
        # Keep any way touching the buffered Toronto polygon (truncate_by_edge=True)
        if not any(nid in inside_nids for nid in nids):
            continue
        if not all(nid in node_handler.nodes for nid in nids):
            continue

        for nid in nids:
            if nid not in raw_graph.nodes:
                lon, lat, ntags = node_handler.nodes[nid]
                raw_graph.add_node(nid, x=lon, y=lat, **ntags)

        raw_ow = str(tdict.get("oneway") or "").strip().lower()
        raw_junc = str(tdict.get("junction") or "").strip().lower()
        raw_hw = str(tdict.get("highway") or "").strip().lower()

        is_reverse_ow = raw_ow == "-1"
        # "reversible" means a two-way street with a reversible center lane (e.g. Jarvis St), NOT oneway
        is_forward_ow = (
            raw_ow in {"yes", "true", "1"}
            or raw_junc in {"roundabout", "circular"}
            or raw_hw in {"motorway", "motorway_link", "trunk_link"}
        )

        if is_reverse_ow:
            edge_attrs = _orient_reverse_edge_attrs(tdict, is_synthetic_reverse=False)
            edge_attrs["oneway"] = "yes"
            for i in range(len(nids) - 1):
                raw_graph.add_edge(nids[i + 1], nids[i], **edge_attrs)
        elif is_forward_ow:
            edge_attrs = dict(tdict)
            edge_attrs["oneway"] = "yes"
            edge_attrs["_is_osm_reverse"] = False
            for i in range(len(nids) - 1):
                raw_graph.add_edge(nids[i], nids[i + 1], **edge_attrs)
        else:
            fwd_attrs = dict(tdict)
            fwd_attrs["_is_osm_reverse"] = False
            rev_attrs = _orient_reverse_edge_attrs(tdict, is_synthetic_reverse=True)
            for i in range(len(nids) - 1):
                raw_graph.add_edge(nids[i], nids[i + 1], **fwd_attrs)
                raw_graph.add_edge(nids[i + 1], nids[i], **rev_attrs)

    logger.info(
        "Built raw city graph: %d nodes, %d edges (%d tram, %d rail, %d schools, %d crossings, %d bus stops). Simplifying...",
        raw_graph.number_of_nodes(),
        raw_graph.number_of_edges(),
        len(tram_ways_lonlat),
        len(rail_ways_raw),
        len(school_polys_lonlat),
        len(crossing_nodes_raw),
        len(bus_stop_nodes_raw),
    )
    graph = ox.simplify_graph(
        raw_graph,
        edge_attrs_differ=SIMPLIFY_EDGE_ATTRS_DIFFER,
        track_merged=True,
    )
    if not retain_all and graph.number_of_nodes() > 0:
        graph = ox.truncate.largest_component(graph, strongly=False)

    street_counts = ox.stats.count_streets_per_node(graph, nodes=list(graph.nodes()))
    for nid, cnt in street_counts.items():
        graph.nodes[nid]["street_count"] = int(cnt)

    lats = [float(d["y"]) for _, d in graph.nodes(data=True)]
    lons = [float(d["x"]) for _, d in graph.nodes(data=True)]
    eff_bbox = BoundingBox(
        south=min(lats),
        west=min(lons),
        north=max(lats),
        east=max(lons),
    )

    graph_node_set = set(graph.nodes())
    restrictions = [
        rel
        for rel in way_handler.restrictions
        if any(
            m.get("type") == "node" and int(m["ref"]) in graph_node_set
            for m in rel.get("members", [])
        )
    ]
    return (
        graph,
        raw_graph,
        restrictions,
        tram_ways_lonlat,
        school_polys_lonlat,
        rail_ways_raw,
        crossing_nodes_raw,
        bus_stop_nodes_raw,
        eff_bbox,
    )


def run_pipeline(config: PipelineConfig) -> Path:
    """Execute the full Toronto map download, clean, project, elevate, and chunk pipeline."""
    ca_bundle = _build_windows_ca_bundle()
    configure_osmnx(config, ca_bundle=ca_bundle)

    transformer = Transformer.from_crs("EPSG:4326", config.utm_epsg, always_xy=True)
    origin_easting, origin_northing = transformer.transform(config.origin_lon, config.origin_lat)

    def to_local_xz(lon: float, lat: float) -> tuple[float, float]:
        easting, northing = transformer.transform(lon, lat)
        return (float(easting - origin_easting), float(-(northing - origin_northing)))

    tram_ways_lonlat: list[tuple[list[tuple[float, float]], int]] = []
    school_polys_lonlat: list[list[tuple[float, float]]] = []
    rail_ways_raw: list[dict[str, Any]] = []
    crossing_nodes_raw: list[dict[str, Any]] = []
    bus_stop_nodes_raw: list[dict[str, Any]] = []
    if config.place_name:
        (
            graph,
            raw_graph,
            restrictions,
            tram_ways_lonlat,
            school_polys_lonlat,
            rail_ways_raw,
            crossing_nodes_raw,
            bus_stop_nodes_raw,
            effective_bbox,
        ) = _load_city_from_pbf(
            place_name=config.place_name,
            cache_dir=config.cache_dir,
            use_cache=config.use_cache,
            retain_all=config.retain_all,
            ca_bundle=ca_bundle,
        )
        effective_config = replace(config, bbox=effective_bbox)
        logger.info(
            "Loaded full-city simplified network: %d nodes, %d edges, %d restriction relations.",
            graph.number_of_nodes(),
            graph.number_of_edges(),
            len(restrictions),
        )
    else:
        logger.info("Downloading OSM drivable road network for bbox %s...", config.bbox.to_dict())
        osmnx_bbox = config.bbox.as_osmnx_bbox()
        # Harvest raw graph first, then simplify with full attribute differentiation
        raw_graph = ox.graph_from_bbox(
            osmnx_bbox,
            network_type="drive",
            simplify=False,
            retain_all=config.retain_all,
            truncate_by_edge=True,
        )
        graph = ox.simplify_graph(
            raw_graph.copy(),
            edge_attrs_differ=SIMPLIFY_EDGE_ATTRS_DIFFER,
            track_merged=True,
        )
        street_counts = ox.stats.count_streets_per_node(graph, nodes=list(graph.nodes()))
        for nid, cnt in street_counts.items():
            graph.nodes[nid]["street_count"] = int(cnt)
        effective_bbox = config.bbox
        effective_config = config
        logger.info(
            "Downloaded simplified network: %d nodes, %d edges.",
            graph.number_of_nodes(),
            graph.number_of_edges(),
        )
        logger.info("Fetching Overpass turn-restriction relations...")
        restrictions = download_turn_restrictions(
            bbox=effective_bbox,
            cache_dir=config.cache_dir,
            use_cache=config.use_cache,
            ca_bundle=ca_bundle,
        )
        logger.info("Fetched %d restriction relations.", len(restrictions))

    elev_config = ElevationConfig(
        dem_path=config.dem_path,
        layer_height_m=config.layer_height_m,
    )
    with ElevationSampler(
        config=elev_config,
        origin_easting=origin_easting,
        origin_northing=origin_northing,
        utm_epsg=config.utm_epsg,
    ) as sampler:
        controls_by_way = _extract_midblock_controls(raw_graph, to_local_xz, sampler)
        elev_summary, signal_count, stop_count = project_and_clean_graph(
            graph=graph,
            config=effective_config,
            to_local_xz=to_local_xz,
            elevation_sampler=sampler,
            controls_by_way=controls_by_way,
            tram_ways_lonlat=tram_ways_lonlat,
            school_polys_lonlat=school_polys_lonlat,
            rail_ways_raw=rail_ways_raw,
        )

        attached_restrictions = attach_turn_restrictions(graph, restrictions)
        logger.info(
            "Resolved %d turn restrictions; nodes with signals=%d, stop_signs=%d.",
            attached_restrictions,
            signal_count,
            stop_count,
        )

        manifest_path = write_spatial_chunks(
            graph=graph,
            config=effective_config,
            origin_utm=(origin_easting, origin_northing),
            elev_summary=elev_summary,
            total_turn_restrictions=attached_restrictions,
            signal_count=signal_count,
            stop_count=stop_count,
            to_local_xz=to_local_xz,
            elevation_sampler=sampler,
            tram_ways_lonlat=tram_ways_lonlat,
            rail_ways_raw=rail_ways_raw,
            crossing_nodes_raw=crossing_nodes_raw,
            bus_stop_nodes_raw=bus_stop_nodes_raw,
        )
    logger.info("Wrote map chunks and manifest to %s.", manifest_path)
    return manifest_path


def parse_args(argv: list[str] | None = None) -> PipelineConfig:
    """Parse CLI arguments into a ``PipelineConfig``."""
    parser = argparse.ArgumentParser(description="Extract Toronto road network into 500m spatial chunks.")
    parser.add_argument(
        "--preset",
        choices=[*sorted(BBOX_PRESETS.keys()), "toronto-city"],
        default="toronto-city",
        help="Named bounding-box/place preset (default: toronto-city covering all six boroughs).",
    )
    parser.add_argument(
        "--place",
        type=str,
        default=None,
        help="Optional OSMnx place query (e.g. 'Toronto, Ontario, Canada').",
    )
    parser.add_argument("--south", type=float, help="Override south latitude.")
    parser.add_argument("--west", type=float, help="Override west longitude.")
    parser.add_argument("--north", type=float, help="Override north latitude.")
    parser.add_argument("--east", type=float, help="Override east longitude.")
    parser.add_argument("--chunk-size", type=float, default=500.0, help="Grid chunk size in meters.")
    parser.add_argument("--dem", type=Path, default=None, help="Optional path to a local GeoTIFF DEM file.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PipelineConfig.output_dir,
        help="Output directory for chunk JSON files and manifest.json.",
    )
    parser.add_argument("--no-cache", action="store_true", help="Bypass cached Overpass responses.")

    args = parser.parse_args(argv)
    place_name = args.place or ("Toronto, Ontario, Canada" if args.preset == "toronto-city" else None)
    base_bbox = BBOX_PRESETS["toronto"] if args.preset == "toronto-city" else BBOX_PRESETS[args.preset]
    bbox = BoundingBox(
        south=args.south if args.south is not None else base_bbox.south,
        west=args.west if args.west is not None else base_bbox.west,
        north=args.north if args.north is not None else base_bbox.north,
        east=args.east if args.east is not None else base_bbox.east,
    )
    return PipelineConfig(
        bbox=bbox,
        place_name=place_name,
        chunk_size_m=args.chunk_size,
        dem_path=args.dem,
        output_dir=args.output_dir,
        use_cache=not args.no_cache,
    )


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    config = parse_args(argv)
    run_pipeline(config)


if __name__ == "__main__":
    main()
