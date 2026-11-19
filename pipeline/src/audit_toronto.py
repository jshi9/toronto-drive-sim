"""Citywide data & invariant auditor for extracted Toronto map chunks.

Cross-checks generated ``sim/public/map_chunks/chunk_*.json`` directly against
``pipeline/.cache/osmnx/Toronto.osm.pbf`` and reports directional accuracy,
fabricated TWLTLs, intersection group sanity, vertical cliffs, specialized
transit/rail/bike/school/HOV features, and corridor-by-corridor metrics.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import json
import math
from pathlib import Path
from typing import Any

PRIORITY_CORRIDORS = [
    "Steeles Avenue East",
    "Kennedy Road",
    "Birchmount Road",
    "McCowan Road",
    "Brimley Road",
    "Warden Avenue",
    "Victoria Park Avenue",
    "McNicoll Avenue",
    "Finch Avenue East",
    "Sheppard Avenue East",
    "Ellesmere Road",
    "Lawrence Avenue East",
    "Don Mills Road",
    "Leslie Street",
    "Bayview Avenue",
    "Yonge Street",
    "Highway 404",
    "Highway 401",
]


def _load_pbf_way_truth(pbf_path: Path) -> dict[int, dict[str, Any]]:
    """Read ground-truth OSM directional & lane tags per way ID from PBF."""
    import osmium  # type: ignore[import-not-found]

    way_truth: dict[int, dict[str, Any]] = {}

    class _WayReader(osmium.SimpleHandler):
        def way(self, w: Any) -> None:
            tags = w.tags
            hw = tags.get("highway")
            if not hw:
                return
            ow = str(tags.get("oneway") or "").strip().lower()
            junc = str(tags.get("junction") or "").strip().lower()
            is_osm_ow = (
                ow in {"yes", "true", "1", "-1"}
                or junc in {"roundabout", "circular"}
                or hw in {"motorway", "motorway_link", "trunk_link"}
            )
            has_both = bool(tags.get("lanes:both_ways") or tags.get("turn:lanes:both_ways"))
            way_truth[int(w.id)] = {
                "highway": str(hw),
                "name": tags.get("name") or "",
                "osm_oneway": is_osm_ow,
                "oneway_raw": ow,
                "reversible": ow == "reversible",
                "lanes_raw": tags.get("lanes"),
                "lanes_fwd": tags.get("lanes:forward"),
                "lanes_rev": tags.get("lanes:backward"),
                "has_both_ways_tag": has_both,
            }

    _WayReader().apply_file(str(pbf_path), locations=False)
    return way_truth


def _norm_street(name: str) -> str:
    tokens = []
    repl = {
        "avenue": "ave",
        "road": "rd",
        "street": "st",
        "boulevard": "blvd",
        "drive": "dr",
        "crescent": "cres",
        "parkway": "pkwy",
        "east": "e",
        "west": "w",
        "north": "n",
        "south": "s",
    }
    for tok in name.lower().replace(".", "").split():
        tokens.append(repl.get(tok, tok))
    return " ".join(tokens)


def _seg_dist_2d(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    lsq = dx * dx + dz * dz
    if lsq <= 1e-8:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lsq))
    return math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t))


def run_audit(chunks_dir: Path, pbf_path: Path) -> dict[str, Any]:
    """Run exhaustive audit over all spatial chunks and PBF ground truth."""
    manifest = json.loads((chunks_dir / "manifest.json").read_text(encoding="utf-8"))
    way_truth = _load_pbf_way_truth(pbf_path) if pbf_path.exists() else {}

    chunk_files = sorted(chunks_dir.glob("chunk_*.json"))
    all_nodes: dict[int, dict[str, Any]] = {}
    unique_edges: dict[str, dict[str, Any]] = {}
    unique_igs: dict[str, dict[str, Any]] = {}
    unique_gores: dict[tuple[int, str], dict[str, Any]] = {}
    unique_rails: dict[str, dict[str, Any]] = {}
    unique_crossings: dict[str, dict[str, Any]] = {}
    unique_bus_bays: dict[str, dict[str, Any]] = {}
    unique_islands: dict[str, dict[str, Any]] = {}
    unique_transitions: dict[str, dict[str, Any]] = {}

    for cf in chunk_files:
        doc = json.loads(cf.read_text(encoding="utf-8"))
        for nd in doc.get("nodes", []):
            nid = int(nd["id"])
            if nd.get("in_chunk") or nid not in all_nodes:
                all_nodes[nid] = nd
        for e in doc.get("edges", []):
            if e["id"] not in unique_edges:
                unique_edges[e["id"]] = e
        for ig in doc.get("intersection_groups", []):
            unique_igs.setdefault(ig["id"], ig)
        for g in doc.get("highway_gores", []):
            unique_gores.setdefault((int(g["node_id"]), str(g["mode"])), g)
        for rt in doc.get("rail_tracks", []):
            unique_rails.setdefault(rt["id"], rt)
        for rc in doc.get("rail_crossings", []):
            unique_crossings.setdefault(rc["id"], rc)
        for bb in doc.get("bus_bays", []):
            unique_bus_bays.setdefault(bb["id"], bb)
        for isl in doc.get("median_islands", []):
            cl = isl.get("centerline") or [[0, 0, 0]]
            isl_key = f"{isl.get('owner_node')}_{isl.get('layer')}_{round(float(cl[0][0]), 1)}_{round(float(cl[0][2]), 1)}"
            unique_islands.setdefault(isl_key, isl)
        for tr in doc.get("median_transitions", []):
            tr_key = f"{tr.get('split_node')}_{tr.get('layer')}"
            unique_transitions.setdefault(tr_key, tr)

    # Known downtown / Cabbagetown bounding box in simulator meters around Yonge & Dundas
    # (~Queen/King up to Bloor/Rosedale Valley, Spadina to Don River/Parliament)
    def _in_downtown_cabbagetown(x: float, z: float) -> bool:
        return -2500.0 <= x <= 2600.0 and -2200.0 <= z <= 1600.0

    false_oneways: list[dict[str, Any]] = []
    downtown_false_oneways: list[dict[str, Any]] = []
    fabricated_twltls: list[dict[str, Any]] = []
    reversible_edges: list[dict[str, Any]] = []
    odd_twoway_bare: list[dict[str, Any]] = []
    steep_12: list[dict[str, Any]] = []
    steep_15: list[dict[str, Any]] = []
    overlapping_pairs: list[tuple[str, str, str | None]] = []

    feature_counts: Counter[str] = Counter()
    corridor_stats: dict[str, dict[str, Any]] = {
        c: {
            "edges": 0,
            "length_m": 0.0,
            "oneway_true": 0,
            "oneway_false": 0,
            "false_oneways": 0,
            "twltl": 0,
            "streetcar": 0,
            "bus_lanes": 0,
            "hov_lanes": 0,
            "bike_lane": 0,
            "bike_track": 0,
            "school_zone": 0,
            "lane_hist": Counter(),
        }
        for c in PRIORITY_CORRIDORS
    }

    # Spatial grid for overlapping non-oneway physical edges
    edge_grid: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)

    for eid, e in unique_edges.items():
        geom = e.get("geometry") or []
        if len(geom) < 2:
            continue
        mid = geom[len(geom) // 2]
        mx, _, mz = float(mid[0]), float(mid[1]), float(mid[2])
        name = str(e.get("street_name") or e.get("name") or "")
        hw = str(e.get("highway") or "")
        oneway = bool(e.get("oneway"))
        lanes = int(e.get("lanes", 2))
        fwd = int(e.get("lanes_forward", 1))
        rev = int(e.get("lanes_backward", 0))
        both = int(e.get("lanes_both_ways", 0))
        rev_c = int(e.get("lanes_reversible", 0))

        # Check steep vertical slopes
        max_slope = 0.0
        for i in range(len(geom) - 1):
            dx = float(geom[i + 1][0]) - float(geom[i][0])
            dy = abs(float(geom[i + 1][1]) - float(geom[i][1]))
            dz = float(geom[i + 1][2]) - float(geom[i][2])
            ds = math.hypot(dx, dz)
            if ds >= 2.0:
                slope = dy / ds
                if slope > max_slope:
                    max_slope = slope
        if max_slope > 0.12:
            item = {"id": eid, "name": name, "hw": hw, "slope": round(max_slope, 3), "x": round(mx, 1), "z": round(mz, 1)}
            steep_12.append(item)
            if max_slope > 0.15:
                steep_15.append(item)

        # OSM cross-check
        osm_ids = [int(w) for w in (e.get("osm_way_ids") or e.get("osm_ids") or [])]
        matched_truth = [way_truth[w] for w in osm_ids if w in way_truth]
        is_dt = _in_downtown_cabbagetown(mx, mz)

        if oneway and matched_truth and all(not t["osm_oneway"] for t in matched_truth):
            info = {"id": eid, "name": name, "hw": hw, "x": round(mx, 1), "z": round(mz, 1), "osm": osm_ids[:2]}
            false_oneways.append(info)
            if is_dt:
                downtown_false_oneways.append(info)

        # Apple/Google Maps satellite-verified TWLTL corridors where OSM omitted lanes:both_ways=1
        verified_twltl_way_ids = {36518396}
        if (
            both > 0
            and matched_truth
            and all(not t["has_both_ways_tag"] for t in matched_truth)
            and not (set(osm_ids) & verified_twltl_way_ids)
        ):
            fabricated_twltls.append({"id": eid, "name": name, "hw": hw, "lanes": lanes, "x": round(mx, 1), "z": round(mz, 1)})

        if not oneway and lanes >= 3 and lanes % 2 == 1 and both == 0 and rev_c == 0 and fwd != rev:
            # Asymmetric 3-lane with explicit turn pockets is OK if turn_lanes present; otherwise flag
            if not e.get("turn_lanes_forward") and not e.get("turn_lanes_backward"):
                odd_twoway_bare.append({"id": eid, "name": name, "lanes": lanes, "fwd": fwd, "rev": rev, "x": round(mx, 1), "z": round(mz, 1)})

        if rev_c > 0:
            reversible_edges.append({"id": eid, "name": name, "lanes": lanes, "fwd": fwd, "rev": rev})

        # Specialized features count
        if both > 0:
            feature_counts["twltl_edges"] += 1
        if rev_c > 0:
            feature_counts["reversible_edges"] += 1
        if e.get("bus_lanes_forward") or e.get("bus_lanes_backward"):
            feature_counts["bus_lane_edges"] += 1
        if e.get("hov_lanes_forward"):
            feature_counts["hov_edges"] += 1
        if e.get("has_streetcar_tracks"):
            feature_counts["streetcar_edges"] += 1
        if e.get("bike_lane_left_type") == "track" or e.get("bike_lane_right_type") == "track":
            feature_counts["bike_track_edges"] += 1
        elif e.get("bike_lane_left_type") == "lane" or e.get("bike_lane_right_type") == "lane":
            feature_counts["bike_lane_edges"] += 1
        elif e.get("bike_lane_left_type") == "shared" or e.get("bike_lane_right_type") == "shared":
            feature_counts["bike_shared_edges"] += 1
        if e.get("is_school_zone"):
            feature_counts["school_zone_edges"] += 1
        for m in e.get("midblock_controls") or []:
            feature_counts[f"midblock_{m.get('type')}_{m.get('markings', 'none')}"] += 1

        # Spatial hash for physical overlap check (skip internal IG pieces)
        if not e.get("intersection_internal") and float(e.get("length_m", 0.0)) >= 12.0:
            cx, cz = int(math.floor(mx / 80.0)), int(math.floor(mz / 80.0))
            edge_grid[(cx, cz)].append(e)

        # Match priority corridors (normalized Ave/Rd/St/E/W)
        norm_name = _norm_street(name)
        for cor in PRIORITY_CORRIDORS:
            nc = _norm_street(cor)
            if norm_name == nc or nc in norm_name:
                cs = corridor_stats[cor]
                cs["edges"] += 1
                cs["length_m"] += float(e.get("length_m", 0.0))
                if oneway:
                    cs["oneway_true"] += 1
                else:
                    cs["oneway_false"] += 1
                if oneway and matched_truth and all(not t["osm_oneway"] for t in matched_truth):
                    cs["false_oneways"] += 1
                if both > 0:
                    cs["twltl"] += 1
                if e.get("has_streetcar_tracks"):
                    cs["streetcar"] += 1
                if e.get("bus_lanes_forward") or e.get("bus_lanes_backward"):
                    cs["bus_lanes"] += 1
                if e.get("hov_lanes_forward"):
                    cs["hov_lanes"] += 1
                if e.get("bike_lane_left_type") == "track" or e.get("bike_lane_right_type") == "track":
                    cs["bike_track"] += 1
                elif e.get("bike_lane_left") or e.get("bike_lane_right"):
                    cs["bike_lane"] += 1
                if e.get("is_school_zone"):
                    cs["school_zone"] += 1
                cs["lane_hist"][f"{lanes}{'ow' if oneway else 'tw'}({fwd}+{rev}+{both})"] += 1

    # Overlap check: flag ONLY true duplicate/overlapping bodies (ignore sequential same-street segments meeting cleanly at a shared endpoint)
    seen_pair_keys: set[tuple[str, str]] = set()
    for (cx, cz), cell_edges in edge_grid.items():
        if len(cell_edges) < 2:
            continue
        for i in range(len(cell_edges)):
            a = cell_edges[i]
            ag = a["geometry"]
            am = ag[len(ag) // 2]
            auv = {int(a["u"]), int(a["v"])}
            for j in range(i + 1, len(cell_edges)):
                b = cell_edges[j]
                if a.get("layer") != b.get("layer"):
                    continue
                if a.get("street_name") != b.get("street_name"):
                    continue
                buv = {int(b["u"]), int(b["v"])}
                bg = b["geometry"]
                bm = bg[len(bg) // 2]
                # Require midpoint within 1.5m of the OTHER segment's body AND check non-collinear continuation
                if math.hypot(am[0] - bm[0], am[2] - bm[2]) < 1.5 and (len(auv & buv) == 2 or auv != buv and math.hypot(ag[0][0] - bg[0][0], ag[0][2] - bg[0][2]) < 1.5 and math.hypot(ag[-1][0] - bg[-1][0], ag[-1][2] - bg[-1][2]) < 1.5):
                    pair = tuple(sorted((a["id"], b["id"])))
                    if pair not in seen_pair_keys:
                        seen_pair_keys.add(pair)
                        overlapping_pairs.append((pair[0], pair[1], a.get("street_name")))

    # IG audit
    ig_leg_hist: Counter[int] = Counter()
    weird_igs: list[dict[str, Any]] = []
    giant_igs: list[dict[str, Any]] = []
    for ig_id, ig in unique_igs.items():
        apps = ig.get("approaches") or []
        n_legs = len({int(a["leg_id"]) for a in apps if "leg_id" in a}) or len(apps)
        ig_leg_hist[n_legs] += 1
        cx, _, cz = ig["center"]
        r_m = max(
            [math.hypot(float(a["cut_point"][0]) - cx, float(a["cut_point"][2]) - cz) for a in apps],
            default=0.0,
        )
        if n_legs not in (3, 4):
            weird_igs.append({"id": ig_id, "legs": n_legs, "r": round(r_m, 1), "x": round(cx, 1), "z": round(cz, 1)})
        if r_m > 42.0:
            giant_igs.append({"id": ig_id, "legs": n_legs, "r": round(r_m, 1), "x": round(cx, 1), "z": round(cz, 1)})

    # Approach metadata check on freeways
    freeway_approaches_flagged = 0
    freeway_approaches_missing = 0
    for nid, nd in all_nodes.items():
        for ap in nd.get("approaches") or []:
            if ap.get("highway") in {"motorway", "motorway_link", "trunk", "trunk_link"}:
                if ap.get("is_freeway"):
                    freeway_approaches_flagged += 1
                else:
                    freeway_approaches_missing += 1

    # Focused Steeles & Kennedy + Gerrard/Parliament + College/Spadina spot checks
    steeles_kennedy = None
    gerrard_parl = None
    college_spadina = None
    for cor_name, target_streets, min_d in [
        ("steeles_kennedy", ("Steeles Avenue East", "Kennedy Road"), 500.0),
        ("gerrard_parl", ("Gerrard Street East", "Parliament Street"), 500.0),
        ("college_spadina", ("College Street", "Spadina Avenue"), 500.0),
    ]:
        cand_nodes = []
        for nid, nd in all_nodes.items():
            resolved_apps = []
            names: set[str] = set()
            for ap in nd.get("approaches") or []:
                eid_ap = str(ap.get("edge_id") or "")
                ed = unique_edges.get(eid_ap) or unique_edges.get(eid_ap.split("__")[0]) or {}
                st_name = str(ed.get("street_name") or ap.get("street_name") or "")
                if st_name:
                    names.add(st_name)
                resolved_apps.append((ap, ed, st_name))
            if all(any(_norm_street(t) in _norm_street(n) for n in names) for t in target_streets):
                cand_nodes.append({
                    "id": nid,
                    "x": nd["x"],
                    "y": nd["y"],
                    "z": nd["z"],
                    "signal": nd["traffic_signal"],
                    "approaches": [
                        {
                            "name": st_name,
                            "hw": ap.get("highway") or ed.get("highway"),
                            "ow": ap.get("oneway"),
                            "lanes": ap.get("lanes"),
                            "lf": ed.get("lanes_forward"),
                            "lr": ed.get("lanes_backward"),
                            "lb": ed.get("lanes_both_ways"),
                            "turn": ap.get("turn_lanes"),
                            "cw": ap.get("crosswalk_markings"),
                            "sc": ed.get("has_streetcar_tracks"),
                        }
                        for ap, ed, st_name in resolved_apps
                    ],
                })
        if cor_name == "steeles_kennedy":
            steeles_kennedy = cand_nodes
        elif cor_name == "gerrard_parl":
            gerrard_parl = cand_nodes
        else:
            college_spadina = cand_nodes

    rail_counts = Counter(str(r.get("railway_type")) for r in unique_rails.values())
    crossing_counts = Counter(str(c.get("crossing_type")) for c in unique_crossings.values())

    report = {
        "manifest_stats": manifest.get("stats"),
        "invariants": {
            "false_oneways_total": len(false_oneways),
            "false_oneways_downtown_cabbagetown": len(downtown_false_oneways),
            "false_oneways_samples": false_oneways[:12],
            "overlapping_same_street_pairs": len(overlapping_pairs),
            "overlapping_samples": overlapping_pairs[:10],
            "fabricated_twltls": len(fabricated_twltls),
            "fabricated_twltl_samples": fabricated_twltls[:10],
            "odd_twoway_bare_untagged": len(odd_twoway_bare),
            "reversible_edges_count": len(reversible_edges),
            "steep_cliffs_gt_12pct": len(steep_12),
            "steep_cliffs_gt_15pct": len(steep_15),
            "steepest_samples": sorted(steep_12, key=lambda x: -x["slope"])[:10],
            "ig_leg_histogram": dict(ig_leg_hist),
            "weird_igs_not_3_4_legs": len(weird_igs),
            "giant_igs_radius_gt_42m": len(giant_igs),
            "giant_ig_samples": giant_igs[:10],
            "freeway_approaches_flagged": freeway_approaches_flagged,
            "freeway_approaches_missing_flag": freeway_approaches_missing,
        },
        "specialized_features": {
            "edge_counts": dict(feature_counts),
            "rail_tracks_by_type": dict(rail_counts),
            "rail_crossings_by_type": dict(crossing_counts),
            "highway_gores": len(unique_gores),
            "bus_bays": len(unique_bus_bays),
            "median_islands": len(unique_islands),
            "median_transitions": len(unique_transitions),
        },
        "priority_corridors": {
            k: {**v, "length_km": round(v["length_m"] / 1000.0, 2), "lane_hist": dict(v["lane_hist"].most_common(6))}
            for k, v in corridor_stats.items()
        },
        "spot_checks": {
            "steeles_and_kennedy": steeles_kennedy,
            "gerrard_and_parliament": gerrard_parl,
            "college_and_spadina": college_spadina,
        },
    }
    return report


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    chunks_dir = repo_root / "sim" / "public" / "map_chunks"
    pbf_path = repo_root / "pipeline" / ".cache" / "osmnx" / "Toronto.osm.pbf"
    report = run_audit(chunks_dir, pbf_path)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
