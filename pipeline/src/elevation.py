"""Elevation sampling and vertical spline offsets for Toronto Drive Sim.

Supports reading a local GeoTIFF DEM (via ``rasterio`` if available) and falls
back to a procedural Toronto terrain model capturing the city's southward slope
toward Lake Ontario, plus C1-smooth vertical spline offsets (+6.5 m per OSM
``layer``) for elevated structures such as the Gardiner Expressway, ramps,
bridges, and underpasses.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import logging
import math
from pathlib import Path
from typing import Any

import networkx as nx
from pyproj import Transformer

logger = logging.getLogger(__name__)

LAYER_HEIGHT_METERS = 6.5
MIN_OVERPASS_CLEARANCE_METERS = 6.2
MIN_RAMP_SMOOTH_LENGTH_METERS = 80.0
DEFAULT_UTM_EPSG = "EPSG:32617"
# Yonge & Dundas reference origin in WGS84
YONGE_DUNDAS_LAT = 43.6561
YONGE_DUNDAS_LON = -79.3802


def _hermite_eval(y0: float, y1: float, m0: float, m1: float, t: float) -> float:
    """Evaluate cubic Hermite spline with endpoint values (y0, y1) and tangents (m0, m1)."""
    t_c = max(0.0, min(1.0, t))
    t2 = t_c * t_c
    t3 = t2 * t_c
    h00 = 2.0 * t3 - 3.0 * t2 + 1.0
    h10 = t3 - 2.0 * t2 + t_c
    h01 = -2.0 * t3 + 3.0 * t2
    h11 = t3 - t2
    return h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1


@dataclass(frozen=True)
class ElevationConfig:
    """Configuration for ground DEM sampling and vertical layer splines."""

    dem_path: Path | None = None
    layer_height_m: float = LAYER_HEIGHT_METERS
    dem_datum_offset_m: float = 0.0
    apply_layer_spline_to_dem: bool = True
    spline_subdivision_m: float = 8.0
    min_overpass_clearance_m: float = MIN_OVERPASS_CLEARANCE_METERS
    min_ramp_length_m: float = MIN_RAMP_SMOOTH_LENGTH_METERS


def procedural_ground_elevation(x: float, z: float) -> float:
    """Estimate Toronto ground elevation (meters above Lake Ontario) at (x, z).

    Coordinate convention (centered at Yonge & Dundas):
      - ``+x`` points East (meters)
      - ``+z`` points South (meters), ``-z`` points North
    """
    shore_z = 2050.0 - 0.25 * x
    inland_m = max(0.0, shore_z - z)

    base_y = 1.2
    downtown_slope = 0.0085 * inland_m - 1.2 * (1.0 - math.exp(-inland_m / 300.0))

    bluff_center_m = 5200.0
    bluff_rise = 22.0 / (1.0 + math.exp(-(inland_m - bluff_center_m) / 350.0))

    don_center_x = 3000.0 - 0.12 * z
    don_dist = (x - don_center_x) / 450.0
    don_valley = -9.0 * math.exp(-(don_dist * don_dist)) * (
        1.0 / (1.0 + math.exp(-(inland_m - 600.0) / 250.0))
    )

    micro_relief = 0.6 * math.sin(x / 650.0) * math.cos(z / 750.0)

    elevation = base_y + downtown_slope + bluff_rise + don_valley + micro_relief
    return max(1.0, float(elevation))


def _smoothstep(t: float) -> float:
    """Cubic Hermite S-curve with zero derivatives at t=0 and t=1."""
    t_clamped = max(0.0, min(1.0, t))
    return t_clamped * t_clamped * (3.0 - 2.0 * t_clamped)


def _polyline_cumulative_distances(points_xz: list[tuple[float, float]]) -> list[float]:
    """Return cumulative Euclidean distances along a 2D (x, z) polyline."""
    if not points_xz:
        return []
    dists = [0.0]
    for i in range(1, len(points_xz)):
        dx = points_xz[i][0] - points_xz[i - 1][0]
        dz = points_xz[i][1] - points_xz[i - 1][1]
        dists.append(dists[-1] + math.hypot(dx, dz))
    return dists


def _subdivide_polyline(
    points_xz: list[tuple[float, float]],
    max_segment_m: float,
) -> list[tuple[float, float]]:
    """Subdivide polyline segments longer than ``max_segment_m`` for smooth splines."""
    if len(points_xz) < 2 or max_segment_m <= 0.0:
        return list(points_xz)

    result: list[tuple[float, float]] = [points_xz[0]]
    for i in range(1, len(points_xz)):
        x0, z0 = points_xz[i - 1]
        x1, z1 = points_xz[i]
        seg_len = math.hypot(x1 - x0, z1 - z0)
        if seg_len > max_segment_m:
            steps = max(2, int(math.ceil(seg_len / max_segment_m)))
            for s in range(1, steps):
                alpha = s / steps
                result.append((x0 + (x1 - x0) * alpha, z0 + (z1 - z0) * alpha))
        result.append((x1, z1))
    return result


def _segment_intersect_2d(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> tuple[float, float] | None:
    """Return (t_ab, t_cd) in (0.01, 0.99) if 2D segments AB and CD intersect."""
    rx = b[0] - a[0]
    rz = b[1] - a[1]
    sx = d[0] - c[0]
    sz = d[1] - c[1]
    denom = rx * sz - rz * sx
    if abs(denom) < 1e-8:
        return None
    qpx = c[0] - a[0]
    qpz = c[1] - a[1]
    t = (qpx * sz - qpz * sx) / denom
    u = (qpx * rz - qpz * rx) / denom
    if 0.005 < t < 0.995 and 0.005 < u < 0.995:
        return (t, u)
    return None


class ElevationSampler:
    """Samples ground heights (GeoTIFF DEM or procedural fallback) and layer splines."""

    def __init__(
        self,
        config: ElevationConfig | None = None,
        origin_easting: float = 0.0,
        origin_northing: float = 0.0,
        utm_epsg: str = DEFAULT_UTM_EPSG,
    ) -> None:
        self.config = config or ElevationConfig()
        self.origin_easting = origin_easting
        self.origin_northing = origin_northing
        self.utm_epsg = utm_epsg

        self._dem_dataset: Any = None
        self._dem_transformer: Transformer | None = None
        self._dem_nodata: float | None = None
        self.dem_active = False

        self._open_dem_if_available()

    def _open_dem_if_available(self) -> None:
        dem_path = self.config.dem_path
        if dem_path is None:
            return
        dem_path = Path(dem_path)
        if not dem_path.exists():
            logger.info("DEM file %s not found; using procedural Toronto elevation.", dem_path)
            return

        try:
            import rasterio  # type: ignore[import-not-found]
        except ImportError:
            logger.warning(
                "DEM file %s exists, but 'rasterio' is not installed; falling back to procedural elevation.",
                dem_path,
            )
            return

        dataset = rasterio.open(dem_path)
        self._dem_dataset = dataset
        self._dem_nodata = dataset.nodata
        if dataset.crs is not None and str(dataset.crs) != self.utm_epsg:
            self._dem_transformer = Transformer.from_crs(
                self.utm_epsg, dataset.crs, always_xy=True
            )
        self.dem_active = True
        logger.info("Loaded GeoTIFF DEM from %s (CRS=%s).", dem_path, dataset.crs)

    def close(self) -> None:
        """Close any opened GeoTIFF dataset."""
        if self._dem_dataset is not None:
            self._dem_dataset.close()
            self._dem_dataset = None
            self.dem_active = False

    def __enter__(self) -> ElevationSampler:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def sample_ground(self, x: float, z: float) -> float:
        """Sample ground elevation Y (meters) at local Cartesian coordinates (x, z)."""
        if self._dem_dataset is not None:
            easting = self.origin_easting + x
            northing = self.origin_northing - z
            if self._dem_transformer is not None:
                sample_x, sample_y = self._dem_transformer.transform(easting, northing)
            else:
                sample_x, sample_y = easting, northing

            bounds = self._dem_dataset.bounds
            if bounds.left <= sample_x <= bounds.right and bounds.bottom <= sample_y <= bounds.top:
                value = float(next(self._dem_dataset.sample([(sample_x, sample_y)]))[0])
                nodata = self._dem_nodata
                is_nodata = (
                    math.isnan(value)
                    or (nodata is not None and math.isclose(value, float(nodata), rel_tol=1e-6))
                )
                if not is_nodata:
                    return value - self.config.dem_datum_offset_m

        return procedural_ground_elevation(x, z)

    def propagate_layer_and_bridge_continuity(self, graph: nx.MultiDiGraph) -> None:
        """Propagate ``layer`` and ``bridge`` continuously across elevated corridors.

        Prevents elevated highways, bridges, and multi-segment ramps from dropping
        to ``layer = 0`` mid-span at intermediate junctions or short link segments.
        """
        highway_elevated_classes = {"motorway", "motorway_link", "trunk", "trunk_link"}

        for _, _, _, data in graph.edges(keys=True, data=True):
            layer = int(data.get("layer", 0))
            bridge = bool(data.get("bridge_clean", False))
            tunnel = bool(data.get("tunnel_clean", False))

            if bridge and layer <= 0 and not tunnel:
                layer = 1
            if layer > 0 and not tunnel:
                bridge = True

            data["layer"] = layer
            data["bridge_clean"] = bridge

        changed = True
        max_iters = 8
        for _ in range(max_iters):
            if not changed:
                break
            changed = False

            for node_id in graph.nodes:
                incident = []
                for u, v, k, d in graph.in_edges(node_id, keys=True, data=True):
                    incident.append((u, v, k, d))
                for u, v, k, d in graph.out_edges(node_id, keys=True, data=True):
                    incident.append((u, v, k, d))
                if not incident:
                    continue

                has_surface_anchor = any(
                    int(d.get("layer", 0)) <= 0
                    and str(d.get("highway_clean") or "") not in highway_elevated_classes
                    for _, _, _, d in incident
                )
                if has_surface_anchor:
                    continue

                layers = [int(d.get("layer", 0)) for _, _, _, d in incident]
                bridges = [bool(d.get("bridge_clean", False)) for _, _, _, d in incident]
                elevated_layers = [lv for lv in layers if lv > 0]
                if not elevated_layers:
                    continue

                distinct_neighbors = {u for u, _, _, _ in incident if u != node_id} | {
                    v for _, v, _, _ in incident if v != node_id
                }
                elevated_neighbors = {
                    (u if u != node_id else v)
                    for u, v, _, d in incident
                    if int(d.get("layer", 0)) > 0
                }
                if len(elevated_neighbors) >= 2 or (
                    len(distinct_neighbors) == 2 and any(lv > 0 for lv in layers)
                ):
                    target_layer = min(elevated_layers)
                    for _, _, _, d in incident:
                        if int(d.get("layer", 0)) == 0 and not bool(d.get("tunnel_clean", False)):
                            hw = str(d.get("highway_clean") or "")
                            if (hw in highway_elevated_classes or any(bridges)) and len(elevated_neighbors) >= 2:
                                d["layer"] = target_layer
                                d["bridge_clean"] = True
                                changed = True

    def _compute_node_corridor_slopes(
        self,
        graph: nx.MultiDiGraph,
        node_y_map: dict[Any, float],
    ) -> dict[tuple[Any, Any, int], tuple[float, float]]:
        """Estimate Catmull-Rom C1 vertical slopes (dy/ds) at each edge's u and v endpoints."""
        slopes: dict[tuple[Any, Any, int], tuple[float, float]] = {}
        max_grade = 0.080

        def _edge_chord_dir(a: Any, b: Any) -> tuple[float, float, float]:
            ax, az = float(graph.nodes[a]["x_m"]), float(graph.nodes[a]["z_m"])
            bx, bz = float(graph.nodes[b]["x_m"]), float(graph.nodes[b]["z_m"])
            dx, dz = bx - ax, bz - az
            d = math.hypot(dx, dz)
            if d < 1e-4:
                return (1.0, 0.0, 0.0)
            return (dx / d, dz / d, d)

        for u, v, k, data in graph.edges(keys=True, data=True):
            ux, uz, chord_len = _edge_chord_dir(u, v)
            if chord_len < 1.0:
                slopes[(u, v, k)] = (0.0, 0.0)
                continue
            yu = node_y_map.get(u, 0.0)
            yv = node_y_map.get(v, 0.0)

            slope_u = (yv - yu) / chord_len
            best_prev_dot = 0.72
            for p_u in set(graph.predecessors(u)) | set(graph.successors(u)):
                if p_u == v or p_u == u:
                    continue
                px, pz, p_len = _edge_chord_dir(p_u, u)
                if p_len < 1.0:
                    continue
                dot = px * ux + pz * uz
                if dot > best_prev_dot:
                    best_prev_dot = dot
                    yp = node_y_map.get(p_u, yu)
                    slope_u = (yv - yp) / max(1.0, p_len + chord_len)

            slope_v = (yv - yu) / chord_len
            best_next_dot = 0.72
            for n_v in set(graph.successors(v)) | set(graph.predecessors(v)):
                if n_v == u or n_v == v:
                    continue
                nx_d, nz_d, n_len = _edge_chord_dir(v, n_v)
                if n_len < 1.0:
                    continue
                dot = ux * nx_d + uz * nz_d
                if dot > best_next_dot:
                    best_next_dot = dot
                    yn = node_y_map.get(n_v, yv)
                    slope_v = (yn - yu) / max(1.0, chord_len + n_len)

            # Damp extreme slopes on short connectors to keep vertical transitions gentle
            hw = str(data.get("highway_clean") or "")
            eff_max = 0.088 if hw in {"motorway_link", "trunk_link"} else max_grade
            slope_u = max(-eff_max, min(eff_max, slope_u))
            slope_v = max(-eff_max, min(eff_max, slope_v))
            slopes[(u, v, k)] = (slope_u, slope_v)

        return slopes

    def _build_edge_elevation(
        self,
        pts_xz: list[tuple[float, float]],
        y_u: float,
        y_v: float,
        ground_y_u: float,
        ground_y_v: float,
        mid_arch_bump_m: float,
        crossing_reqs: list[tuple[float, float]],
        slope_u: float = 0.0,
        slope_v: float = 0.0,
        follow_ground: bool = True,
    ) -> tuple[list[list[float]], float]:
        """Compute C1-smooth cubic Hermite 3D XYZ polyline honoring continuous grades & clearances."""
        cum_dists = _polyline_cumulative_distances(pts_xz)
        total_len = cum_dists[-1] if cum_dists else 0.0
        base_g = [self.sample_ground(px, pz) for px, pz in pts_xz]

        if len(pts_xz) < 2 or total_len <= 1e-3:
            geometry_xyz = [[round(px, 3), round(y_u, 3), round(pz, 3)] for (px, pz) in pts_xz]
            return geometry_xyz, total_len

        ys: list[float] = []
        if follow_ground and mid_arch_bump_m <= 1e-3 and abs(y_u - ground_y_u) <= 0.15 and abs(y_v - ground_y_v) <= 0.15:
            # Ground-level road: match exact ground elevation relief with endpoint continuity
            for i, s in enumerate(cum_dists):
                t = max(0.0, min(1.0, s / total_len))
                g_end_blend = (y_u - base_g[0]) * (1.0 - t) + (y_v - base_g[-1]) * t
                ys.append(base_g[i] + g_end_blend)
        else:
            for i, s in enumerate(cum_dists):
                t = max(0.0, min(1.0, s / total_len))
                herm_y = _hermite_eval(y_u, y_v, slope_u * total_len, slope_v * total_len, t)
                g_chord = base_g[0] + (base_g[-1] - base_g[0]) * t
                g_detail = (base_g[i] - g_chord) * (0.30 if not follow_ground else 0.70)
                bump = 0.0
                if mid_arch_bump_m > 1e-3:
                    ramp_span = min(max(self.config.min_ramp_length_m, total_len * 0.24), total_len * 0.44)
                    if s < ramp_span:
                        alpha = _smoothstep(s / ramp_span)
                    elif s > total_len - ramp_span:
                        alpha = _smoothstep((total_len - s) / ramp_span)
                    else:
                        alpha = 1.0
                    bump = mid_arch_bump_m * alpha
                ys.append(herm_y + g_detail + bump)

        ys[0] = y_u
        ys[-1] = y_v

        if crossing_reqs and total_len > 1e-3:
            extra_bumps: list[tuple[float, float]] = []
            for t_cross, required_upper_y in crossing_reqs:
                s_cross = t_cross * total_len
                cur_y = ys[0]
                for idx in range(1, len(cum_dists)):
                    if cum_dists[idx] >= s_cross:
                        seg = cum_dists[idx] - cum_dists[idx - 1]
                        frac = (s_cross - cum_dists[idx - 1]) / seg if seg > 1e-6 else 0.0
                        cur_y = ys[idx - 1] + (ys[idx] - ys[idx - 1]) * frac
                        break
                deficit = required_upper_y - cur_y
                if deficit > 0.0:
                    extra_bumps.append((s_cross, deficit))

            if extra_bumps:
                max_def = max(d for _, d in extra_bumps)
                half_env = max(self.config.min_ramp_length_m * 0.85, max_def / 0.065, total_len * 0.35)
                min_cross_s = min(s_c for s_c, _ in extra_bumps)
                max_cross_s = max(s_c for s_c, _ in extra_bumps)
                fade_start = min(total_len * 0.25, 22.0, min_cross_s * 0.75)
                fade_end = min(total_len * 0.25, 22.0, (total_len - max_cross_s) * 0.75)
                for i, s in enumerate(cum_dists):
                    endpoint_fade = 1.0
                    if fade_start > 1e-3 and s < fade_start:
                        endpoint_fade = _smoothstep(s / fade_start)
                    elif fade_end > 1e-3 and s > total_len - fade_end:
                        endpoint_fade = _smoothstep((total_len - s) / fade_end)
                    lift = 0.0
                    for s_cross, deficit in extra_bumps:
                        d = abs(s - s_cross)
                        if d < half_env:
                            w = _smoothstep(1.0 - d / half_env)
                            lift = max(lift, deficit * w)
                    ys[i] += lift * endpoint_fade
                ys[0] = y_u
                ys[-1] = y_v

        # Post-smooth interior polyline vertices so single 8m segments never form vertical walls
        if len(ys) >= 3 and total_len > 1e-3:
            max_vert_grade = 0.095
            locked = {0, len(ys) - 1}
            for _ in range(10):
                moved = False
                for i in range(1, len(ys) - 1):
                    if i in locked:
                        continue
                    ds_l = max(0.5, cum_dists[i] - cum_dists[i - 1])
                    ds_r = max(0.5, cum_dists[i + 1] - cum_dists[i])
                    hi = min(ys[i - 1] + max_vert_grade * ds_l, ys[i + 1] + max_vert_grade * ds_r)
                    lo = max(ys[i - 1] - max_vert_grade * ds_l, ys[i + 1] - max_vert_grade * ds_r)
                    # Only average/clamp down extreme spike cliffs without sinking crossing clearances
                    if lo <= hi:
                        clamped = max(lo, min(hi, ys[i]))
                        if abs(clamped - ys[i]) > 1e-4:
                            ys[i] = clamped
                            moved = True
                    else:
                        target_y = 0.5 * (lo + hi)
                        nudged = 0.65 * ys[i] + 0.35 * target_y
                        if abs(nudged - ys[i]) > 1e-4:
                            ys[i] = nudged
                            moved = True
                if not moved:
                    break
            ys[0] = y_u
            ys[-1] = y_v

        geometry_xyz = [
            [round(px, 3), round(py, 3), round(pz, 3)]
            for (px, pz), py in zip(pts_xz, ys)
        ]
        return geometry_xyz, total_len

    def assign_graph_elevations(
        self,
        graph: nx.MultiDiGraph,
        rail_polys_xz: list[tuple[list[tuple[float, float]], int]] | None = None,
    ) -> dict[str, Any]:
        """Assign grade-relaxed Y heights to every node and C1 polylines to every edge."""
        self.propagate_layer_and_bridge_continuity(graph)
        apply_layers = self.config.apply_layer_spline_to_dem or not self.dem_active
        layer_h = self.config.layer_height_m if apply_layers else 0.0
        step_clear = max(6.2, self.config.min_overpass_clearance_m) + 0.1

        ground_y_map: dict[Any, float] = {}
        node_y_map: dict[Any, float] = {}
        for node_id, data in graph.nodes(data=True):
            gy = self.sample_ground(float(data["x_m"]), float(data["z_m"]))
            ground_y_map[node_id] = gy
            node_y_map[node_id] = gy

        # Precompute 2D chords, polylines, and bounding boxes for all road edges
        edge_infos: dict[tuple[Any, Any, int], dict[str, Any]] = {}
        grid_cell_m = 220.0
        edge_grid: dict[tuple[int, int], list[tuple[Any, Any, int]]] = {}

        for u, v, k, data in graph.edges(keys=True, data=True):
            pts_xz = list(data["geometry_xz"])
            cum = _polyline_cumulative_distances(pts_xz)
            total_len = cum[-1] if cum else 0.0
            xs = [p[0] for p in pts_xz]
            zs = [p[1] for p in pts_xz]
            bbox = (min(xs), max(xs), min(zs), max(zs)) if pts_xz else (0.0, 0.0, 0.0, 0.0)
            edge_layer = int(data.get("layer", 0))
            bridge = bool(data.get("bridge_clean", False))
            tunnel = bool(data.get("tunnel_clean", False))
            hw = str(data.get("highway_clean") or "")
            key = (u, v, k)
            edge_infos[key] = {
                "pts": pts_xz,
                "cum": cum,
                "len": total_len,
                "bbox": bbox,
                "layer": edge_layer,
                "bridge": bridge,
                "tunnel": tunnel,
                "hw": hw,
            }
            for gx in range(math.floor(bbox[0] / grid_cell_m), math.floor(bbox[1] / grid_cell_m) + 1):
                for gz in range(math.floor(bbox[2] / grid_cell_m), math.floor(bbox[3] / grid_cell_m) + 1):
                    edge_grid.setdefault((gx, gz), []).append(key)

        rail_grid: dict[tuple[int, int], list[int]] = {}
        rail_items: list[tuple[list[tuple[float, float]], int, tuple[float, float, float, float]]] = []
        if rail_polys_xz:
            for rpts, rlayer in rail_polys_xz:
                if len(rpts) < 2:
                    continue
                rxs = [p[0] for p in rpts]
                rzs = [p[1] for p in rpts]
                rbbox = (min(rxs), max(rxs), min(rzs), max(rzs))
                ridx = len(rail_items)
                rail_items.append((rpts, int(rlayer), rbbox))
                for gx in range(math.floor(rbbox[0] / grid_cell_m), math.floor(rbbox[1] / grid_cell_m) + 1):
                    for gz in range(math.floor(rbbox[2] / grid_cell_m), math.floor(rbbox[3] / grid_cell_m) + 1):
                        rail_grid.setdefault((gx, gz), []).append(ridx)

        # Find all geometric crossings between upper edges and lower road/rail segments
        # crossings_for_upper[(u,v,k)] = list of (t_upper, lower_key_or_None, t_lower, lower_layer, rail_base_y, layer_delta)
        crossings_for_upper: dict[tuple[Any, Any, int], list[tuple[float, Any, float, int, float, int]]] = {}
        under_pinned_nodes: set[Any] = set()

        for ekey, info in edge_infos.items():
            u, v, k = ekey
            elayer = info["layer"]
            ebridge = info["bridge"]
            etunnel = info["tunnel"]
            if etunnel or (elayer <= 0 and not ebridge):
                continue
            pts_xz = info["pts"]
            cum = info["cum"]
            total_len = info["len"]
            if total_len <= 1e-3:
                continue
            ux0, ux1, uz0, uz1 = info["bbox"]

            cands: set[tuple[Any, Any, int]] = set()
            for gx in range(math.floor(ux0 / grid_cell_m), math.floor(ux1 / grid_cell_m) + 1):
                for gz in range(math.floor(uz0 / grid_cell_m), math.floor(uz1 / grid_cell_m) + 1):
                    cands.update(edge_grid.get((gx, gz), ()))

            for lkey in cands:
                lu, lv, _ = lkey
                if lkey == ekey or ({u, v} & {lu, lv}):
                    continue
                linfo = edge_infos[lkey]
                if linfo["tunnel"]:
                    continue
                llayer = linfo["layer"]
                # Upper crosses strictly lower layer, OR bridge over non-bridge same-layer surface street
                is_over = (elayer > llayer) or (ebridge and not linfo["bridge"] and elayer >= llayer)
                if not is_over:
                    continue
                lx0, lx1, lz0, lz1 = linfo["bbox"]
                if lx1 < ux0 or lx0 > ux1 or lz1 < uz0 or lz0 > uz1:
                    continue
                lpts = linfo["pts"]
                ldelta = max(1, max(1, elayer) - llayer)
                for i in range(len(pts_xz) - 1):
                    for j in range(len(lpts) - 1):
                        hit = _segment_intersect_2d(pts_xz[i], pts_xz[i + 1], lpts[j], lpts[j + 1])
                        if hit is not None:
                            t_seg, u_seg = hit
                            s_up = cum[i] + t_seg * (cum[i + 1] - cum[i])
                            t_up = s_up / total_len
                            l_t = (linfo["cum"][j] + u_seg * (linfo["cum"][j + 1] - linfo["cum"][j])) / max(1e-3, linfo["len"])
                            crossings_for_upper.setdefault(ekey, []).append(
                                (t_up, lkey, l_t, llayer, 0.0, ldelta)
                            )
                            if llayer <= 0:
                                l_len = max(1e-3, linfo["len"])
                                if l_t * l_len < 25.0:
                                    under_pinned_nodes.add(lu)
                                if (1.0 - l_t) * l_len < 25.0:
                                    under_pinned_nodes.add(lv)

            if rail_items:
                rcands: set[int] = set()
                for gx in range(math.floor(ux0 / grid_cell_m), math.floor(ux1 / grid_cell_m) + 1):
                    for gz in range(math.floor(uz0 / grid_cell_m), math.floor(uz1 / grid_cell_m) + 1):
                        rcands.update(rail_grid.get((gx, gz), ()))
                for ridx in rcands:
                    rpts, rlayer, rbbox = rail_items[ridx]
                    if rbbox[1] < ux0 or rbbox[0] > ux1 or rbbox[3] < uz0 or rbbox[2] > uz1:
                        continue
                    if not ((elayer > rlayer) or (ebridge and elayer >= rlayer)):
                        continue
                    ldelta = max(1, max(1, elayer) - rlayer)
                    for i in range(len(pts_xz) - 1):
                        for j in range(len(rpts) - 1):
                            hit = _segment_intersect_2d(pts_xz[i], pts_xz[i + 1], rpts[j], rpts[j + 1])
                            if hit is not None:
                                t_seg, u_seg = hit
                                s_up = cum[i] + t_seg * (cum[i + 1] - cum[i])
                                t_up = s_up / total_len
                                rx = rpts[j][0] + u_seg * (rpts[j + 1][0] - rpts[j][0])
                                rz = rpts[j][1] + u_seg * (rpts[j + 1][1] - rpts[j][1])
                                ry = self.sample_ground(rx, rz) + rlayer * layer_h
                                crossings_for_upper.setdefault(ekey, []).append(
                                    (t_up, None, 0.0, rlayer, ry, ldelta)
                                )

        # Identify which elevated/bridge edges belong to components with REAL road/rail crossings
        # (vs creek/ravine bridges that should stay low over valleys instead of spiking +6.5m)
        highway_elevated_classes = {"motorway", "motorway_link", "trunk", "trunk_link"}
        elevated_edges = [
            ek for ek, info in edge_infos.items()
            if (info["layer"] > 0 or info["bridge"]) and not info["tunnel"]
        ]
        node_to_elev_edges: dict[Any, list[tuple[Any, Any, int]]] = {}
        for u, v, k in elevated_edges:
            node_to_elev_edges.setdefault(u, []).append((u, v, k))
            node_to_elev_edges.setdefault(v, []).append((u, v, k))

        true_lift_edges: set[tuple[Any, Any, int]] = set()
        visited_e: set[tuple[Any, Any, int]] = set()
        for start_ek in elevated_edges:
            if start_ek in visited_e:
                continue
            comp: list[tuple[Any, Any, int]] = []
            stack = [start_ek]
            visited_e.add(start_ek)
            while stack:
                cur = stack.pop()
                comp.append(cur)
                for ep in (cur[0], cur[1]):
                    for nb_e in node_to_elev_edges.get(ep, ()):
                        if nb_e not in visited_e:
                            visited_e.add(nb_e)
                            stack.append(nb_e)
            has_real_cross = any(ek in crossings_for_upper for ek in comp)
            has_multi_stack = any(edge_infos[ek]["layer"] >= 2 for ek in comp)
            comp_hw_len = sum(edge_infos[ek]["len"] for ek in comp if edge_infos[ek]["hw"] in highway_elevated_classes)
            if has_real_cross or has_multi_stack or comp_hw_len >= 85.0:
                true_lift_edges.update(comp)

        # An endpoint of an overpass/crossing upper bridge span cannot simultaneously be pinned to ground
        for u_up, v_up, _ in crossings_for_upper:
            under_pinned_nodes.discard(u_up)
            under_pinned_nodes.discard(v_up)
        for u_up, v_up, _ in true_lift_edges:
            if (u_up, v_up, 0) in crossings_for_upper:
                under_pinned_nodes.discard(u_up)
                under_pinned_nodes.discard(v_up)

        # Solve vertical heights layer by layer so multi-level stack overpasses stack cleanly
        # while grading down smoothly at <= 6.5% (8.5% on motorway_link ramps)
        node_min_y = dict(ground_y_map)

        # Keep true multi-level bridge deck interior nodes (all incident edges lifted, no ground streets)
        # elevated smoothly without sagging between piers
        for nid in graph.nodes:
            if nid in under_pinned_nodes:
                continue
            inc = list(graph.in_edges(nid, keys=True)) + list(graph.out_edges(nid, keys=True))
            if not inc:
                continue
            if all(ek in true_lift_edges for ek in inc):
                min_lay = min(max(1, edge_infos[ek]["layer"]) for ek in inc)
                node_min_y[nid] = max(node_min_y[nid], ground_y_map[nid] + min(2, min_lay) * layer_h)

        # Propagate required crossing heights in ascending layer order + relax grades
        edges_by_layer = sorted(
            [ek for ek in crossings_for_upper],
            key=lambda ek: edge_infos[ek]["layer"],
        )

        def _relax_grades(lower_floors: dict[Any, float]) -> dict[Any, float]:
            y_cur = dict(lower_floors)
            # Build undirected edge list with chord lengths and permissible grades
            adj_segs: list[tuple[Any, Any, float, float]] = []
            for eu, ev, ek in graph.edges(keys=True):
                info = edge_infos[(eu, ev, ek)]
                if info["tunnel"]:
                    continue
                ax, az = float(graph.nodes[eu]["x_m"]), float(graph.nodes[eu]["z_m"])
                bx, bz = float(graph.nodes[ev]["x_m"]), float(graph.nodes[ev]["z_m"])
                chord = math.hypot(bx - ax, bz - az)
                if chord < 0.5:
                    continue
                g_max = 0.085 if info["hw"] in {"motorway_link", "trunk_link"} else 0.065
                adj_segs.append((eu, ev, chord, g_max))

            for _ in range(28):
                moved = False
                for eu, ev, chord, g_max in adj_segs:
                    max_dy = g_max * chord
                    if ev not in under_pinned_nodes and y_cur[ev] < y_cur[eu] - max_dy - 1e-4:
                        y_cur[ev] = y_cur[eu] - max_dy
                        moved = True
                    if eu not in under_pinned_nodes and y_cur[eu] < y_cur[ev] - max_dy - 1e-4:
                        y_cur[eu] = y_cur[ev] - max_dy
                        moved = True
                if not moved:
                    break
            return y_cur

        # Multi-sweep crossing enforcement: layer <=1, layer == 2, then layer >= 3 (two sweeps so raised bridges propagate to higher tiers)
        if apply_layers:
            for _sweep in range(2):
                for pass_lv in (1, 2, 99):
                    for ek in edges_by_layer:
                        elayer = edge_infos[ek]["layer"]
                        if (
                            (pass_lv == 1 and elayer > 1)
                            or (pass_lv == 2 and elayer != 2)
                            or (pass_lv == 99 and elayer <= 2)
                        ):
                            continue
                        u, v, _ = ek
                        L = max(1.0, edge_infos[ek]["len"])
                        for t_up, lkey, l_t, _, rail_base_y, ldelta in crossings_for_upper[ek]:
                            if lkey is not None:
                                lu, lv, _ = lkey
                                lower_y = node_y_map[lu] + (node_y_map[lv] - node_y_map[lu]) * l_t
                            else:
                                lower_y = rail_base_y
                            req_y = lower_y + ldelta * step_clear
                            s_up = t_up * L
                            d_u = max(0.0, s_up - 8.0)
                            d_v = max(0.0, (L - s_up) - 8.0)
                            floor_u = req_y - 0.065 * d_u
                            floor_v = req_y - 0.065 * d_v
                            if u not in under_pinned_nodes:
                                node_min_y[u] = max(node_min_y[u], floor_u)
                            if v not in under_pinned_nodes:
                                node_min_y[v] = max(node_min_y[v], floor_v)
                    node_y_map = _relax_grades(node_min_y)

            # Tunnels: depress strictly interior tunnel nodes gently along portal ramps
            tunnel_floors = dict(node_y_map)
            for nid in graph.nodes:
                inc = list(graph.in_edges(nid, keys=True)) + list(graph.out_edges(nid, keys=True))
                if inc and all(edge_infos[ek]["tunnel"] for ek in inc):
                    t_lay = min(-1, min(edge_infos[ek]["layer"] for ek in inc))
                    target_ty = ground_y_map[nid] + max(-2, t_lay) * layer_h
                    if target_ty < tunnel_floors[nid]:
                        tunnel_floors[nid] = target_ty
            # Clamp tunnel portals back up smoothly toward non-tunnel portals at <= 7%
            for _ in range(18):
                changed_t = False
                for eu, ev, ek in graph.edges(keys=True):
                    info = edge_infos[(eu, ev, ek)]
                    if not info["tunnel"]:
                        continue
                    max_dy = 0.070 * max(1.0, info["len"])
                    if tunnel_floors[eu] > tunnel_floors[ev] + max_dy:
                        pass
                    if tunnel_floors[ev] < tunnel_floors[eu] - max_dy:
                        tunnel_floors[ev] = tunnel_floors[eu] - max_dy
                        changed_t = True
                    if tunnel_floors[eu] < tunnel_floors[ev] - max_dy:
                        tunnel_floors[eu] = tunnel_floors[ev] - max_dy
                        changed_t = True
                if not changed_t:
                    break
            # Enforce ground nodes cannot drop above tunnel interior except gradually along portal edges
            node_y_map = tunnel_floors

        min_y = float("inf")
        max_y = float("-inf")
        for node_id, data in graph.nodes(data=True):
            gy = ground_y_map[node_id]
            ym = node_y_map[node_id]
            data["ground_y_m"] = round(gy, 3)
            data["y_m"] = round(ym, 3)
            rel_layer = int(round((ym - gy) / max(1.0, layer_h))) if apply_layers else 0
            data["layer"] = rel_layer
            min_y = min(min_y, ym)
            max_y = max(max_y, ym)

        node_slopes = self._compute_node_corridor_slopes(graph, node_y_map)

        # Build lower edges first so upper crossing clearances use actual serialized lower deck heights
        built_lower: dict[tuple[Any, Any, int], tuple[list[tuple[float, float]], list[float], list[list[float]]]] = {}
        upper_order: list[tuple[Any, Any, int]] = []
        subdivided_pts: dict[tuple[Any, Any, int], list[tuple[float, float]]] = {}

        for u, v, k, data in graph.edges(keys=True, data=True):
            ek = (u, v, k)
            info = edge_infos[ek]
            pts_xz = info["pts"]
            yu = node_y_map[u]
            yv = node_y_map[v]
            gy_u = ground_y_map[u]
            gy_v = ground_y_map[v]
            su, sv = node_slopes.get(ek, (0.0, 0.0))

            needs_sub = (
                abs((yu - gy_u) - (yv - gy_v)) > 0.35
                or ek in crossings_for_upper
                or info["bridge"]
                or info["tunnel"]
                or abs(su - sv) > 0.004
            )
            if needs_sub:
                sub_step = self.config.spline_subdivision_m if (ek in true_lift_edges or info["tunnel"]) else 14.0
                pts_xz = _subdivide_polyline(pts_xz, sub_step)
            subdivided_pts[ek] = pts_xz

            if ek in crossings_for_upper:
                upper_order.append(ek)
            else:
                # Non-crossing creek bridge gets a subtle +0.40m crown instead of +6.5m spike
                mid_bump = 0.40 if (info["bridge"] and ek not in true_lift_edges and info["len"] >= 16.0) else 0.0
                follow_g = (abs(yu - gy_u) <= 0.15 and abs(yv - gy_v) <= 0.15 and not info["bridge"] and not info["tunnel"])
                geom_xyz, total_len = self._build_edge_elevation(
                    pts_xz,
                    yu,
                    yv,
                    gy_u,
                    gy_v,
                    mid_bump,
                    [],
                    slope_u=su,
                    slope_v=sv,
                    follow_ground=follow_g,
                )
                data["geometry_xyz"] = geom_xyz
                data["length_m"] = round(total_len, 3)
                built_lower[ek] = (pts_xz, _polyline_cumulative_distances(pts_xz), geom_xyz)
                for _, py, _ in geom_xyz:
                    min_y = min(min_y, py)
                    max_y = max(max_y, py)

        # Now build crossing overpasses ascending by layer against actual lower geometry
        upper_order.sort(key=lambda ek: edge_infos[ek]["layer"])
        for ek in upper_order:
            u, v, k = ek
            data = graph.edges[u, v, k]
            info = edge_infos[ek]
            pts_xz = subdivided_pts[ek]
            yu = node_y_map[u]
            yv = node_y_map[v]
            gy_u = ground_y_map[u]
            gy_v = ground_y_map[v]
            su, sv = node_slopes.get(ek, (0.0, 0.0))

            c_reqs: list[tuple[float, float]] = []
            for t_up, lkey, l_t, _, rail_base_y, ldelta in crossings_for_upper[ek]:
                if lkey is not None and lkey in built_lower:
                    _, lcum, lxyz = built_lower[lkey]
                    ltot = lcum[-1] if lcum else 0.0
                    lower_y = lxyz[0][1]
                    if ltot > 1e-3:
                        ls = l_t * ltot
                        for idx in range(1, len(lcum)):
                            if lcum[idx] >= ls:
                                seg = lcum[idx] - lcum[idx - 1]
                                frac = (ls - lcum[idx - 1]) / seg if seg > 1e-6 else 0.0
                                lower_y = lxyz[idx - 1][1] + (lxyz[idx][1] - lxyz[idx - 1][1]) * frac
                                break
                elif lkey is not None:
                    lu, lv, _ = lkey
                    lower_y = node_y_map[lu] + (node_y_map[lv] - node_y_map[lu]) * l_t
                else:
                    lower_y = rail_base_y
                c_reqs.append((t_up, lower_y + ldelta * step_clear))

            geom_xyz, total_len = self._build_edge_elevation(
                pts_xz,
                yu,
                yv,
                gy_u,
                gy_v,
                0.0,
                c_reqs,
                slope_u=su,
                slope_v=sv,
                follow_ground=False,
            )
            data["geometry_xyz"] = geom_xyz
            data["length_m"] = round(total_len, 3)
            built_lower[ek] = (pts_xz, _polyline_cumulative_distances(pts_xz), geom_xyz)
            for _, py, _ in geom_xyz:
                min_y = min(min_y, py)
                max_y = max(max_y, py)

        if min_y == float("inf"):
            min_y = 0.0
            max_y = 0.0

        return {
            "source": "geotiff_dem" if self.dem_active else "procedural_toronto",
            "layer_height_m": self.config.layer_height_m,
            "min_y_m": round(min_y, 3),
            "max_y_m": round(max_y, 3),
        }
