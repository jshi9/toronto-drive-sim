export interface Wgs84Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ManifestProjection {
  crs: string;
  origin_wgs84: {
    lat: number;
    lon: number;
    label: string;
  };
  origin_utm: {
    easting: number;
    northing: number;
  };
  axes: {
    x: string;
    y: string;
    z: string;
  };
}

export interface ManifestElevation {
  source: string;
  layer_height_m: number;
  min_y_m: number;
  max_y_m: number;
}

export interface ChunkBounds {
  min_x: number;
  max_x: number;
  min_z: number;
  max_z: number;
}

export interface ManifestChunkEntry {
  id: string;
  gx: number;
  gz: number;
  file: string;
  bounds_m: ChunkBounds;
  node_count: number;
  referenced_node_count: number;
  edge_count: number;
  directed_edge_count?: number;
  turn_restriction_count: number;
}

export interface MapManifest {
  version: string;
  generated_at: string;
  bbox_wgs84: Wgs84Bbox;
  projection: ManifestProjection;
  elevation: ManifestElevation;
  chunk_size_m: number;
  grid_bounds: {
    min_gx: number;
    max_gx: number;
    min_gz: number;
    max_gz: number;
  };
  stats: {
    total_nodes: number;
    total_edges: number;
    total_physical_edges?: number;
    total_turn_restrictions: number;
    traffic_signal_nodes: number;
    stop_sign_nodes: number;
    chunk_count: number;
  };
  chunks: ManifestChunkEntry[];
}

export interface TurnRestriction {
  relation_id: number;
  type: string;
  via_node?: number;
  from_edge_ids?: string[];
  to_edge_ids: string[];
  from_way_ids?: number[];
  to_way_ids?: number[];
  condition?: string;
  except?: string;
}

export interface NodeApproach {
  edge_id: string;
  other_node: number;
  layer: number;
  highway?: string;
  is_freeway?: boolean;
  bridge?: boolean;
  lanes: number;
  forward_lanes?: number;
  reverse_lanes?: number;
  lanes_both_ways?: number;
  width_m: number;
  edge_length_m?: number;
  oneway: boolean;
  bidirectional: boolean;
  is_incoming: boolean;
  controlled: boolean;
  crosswalk_markings?: 'ladder' | 'lines' | 'school_ladder' | 'none' | string;
  intersection_internal?: boolean;
  turn_lanes?: string[] | null;
  lane_shift_right_m?: number;
  left_offset_m?: number;
  right_offset_m?: number;
  yellow_offset_right?: number;
  dir_xz: [number, number];
}

export interface MapNode {
  id: number;
  x: number;
  y: number;
  z: number;
  ground_y: number;
  lat: number;
  lon: number;
  layer: number;
  street_count: number;
  traffic_signal: boolean;
  stop_sign: boolean;
  has_crossing?: boolean;
  crosswalk_markings?: 'ladder' | 'lines' | 'school_ladder' | 'none' | string;
  suppress_midblock?: boolean;
  node_type?: 'normal' | 'median_split' | string;
  control: string;
  in_chunk: boolean;
  owner_chunk: [number, number];
  turn_restrictions: TurnRestriction[];
  approaches?: NodeApproach[];
}

export interface MidblockControl {
  osm_node_id: number;
  type: string;
  has_signals?: boolean;
  markings?: string;
  position: [number, number, number];
}

export type Vec3Tuple = [number, number, number];

export interface MapEdge {
  id: string;
  u: number;
  v: number;
  key: number;
  reverse_edge_id?: string;
  osm_way_ids: number[];
  name: string | string[] | null;
  street_name?: string | null;
  highway: string | string[];
  road_class?: string;
  junction?: string;
  lanes: number;
  lanes_total?: number;
  lanes_forward?: number;
  lanes_backward?: number;
  lanes_both_ways?: number;
  lanes_reversible?: number;
  width_m?: number;
  forward_lanes?: number;
  reverse_lanes?: number;
  turn_lanes_fwd?: string[] | null;
  turn_lanes_rev?: string[] | null;
  turn_lanes_forward?: string[] | null;
  turn_lanes_backward?: string[] | null;
  bus_lanes_forward?: boolean[] | null;
  bus_lanes_backward?: boolean[] | null;
  hov_lanes_forward?: boolean[] | null;
  change_lanes_forward?: string[] | null;
  placement?: string | null;
  right_pocket_lanes?: number;
  lane_shift_right_m?: number;
  has_streetcar_tracks?: boolean;
  has_bike_lane?: boolean;
  bike_lane_left?: boolean;
  bike_lane_right?: boolean;
  bike_lane_left_type?: 'none' | 'shared' | 'lane' | 'track' | string;
  bike_lane_right_type?: 'none' | 'shared' | 'lane' | 'track' | string;
  is_school_zone?: boolean;
  has_bus_bay_left?: boolean;
  has_bus_bay_right?: boolean;
  is_oneway?: boolean;
  trim_start_m?: number;
  trim_end_m?: number;
  intersection_internal?: boolean;
  intersection_group_id?: string;
  maxspeed_kmh: number | null;
  oneway: boolean;
  bidirectional?: boolean;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  length_m: number;
  geometry: Vec3Tuple[];
  turn_restrictions: TurnRestriction[];
  midblock_controls: MidblockControl[];
}

export interface IntersectionGroupApproach {
  edge_id: string;
  corner_node: number;
  leg_id: number;
  cut_point: Vec3Tuple;
  out_dir_xz: [number, number];
  leg_dir_xz: [number, number];
  half_width: number;
  lanes: number;
  forward_lanes: number;
  reverse_lanes: number;
  lanes_both_ways?: number;
  bidirectional: boolean;
  is_incoming: boolean;
  turn_lanes?: string[] | null;
  crosswalk_markings?: 'ladder' | 'lines' | 'school_ladder' | 'none' | string;
  street_name?: string | null;
  yellow_offset_right?: number;
  incoming_span_offset?: [number, number] | null;
  traffic_left_offset?: number;
  traffic_right_offset?: number;
}

export interface IntersectionGroup {
  id: string;
  owner_node: number;
  layer: number;
  center: Vec3Tuple;
  signalized: boolean;
  stop_controlled: boolean;
  has_crosswalks: boolean;
  corner_nodes: number[];
  approaches: IntersectionGroupApproach[];
}

export interface MedianIsland {
  owner_node: number;
  layer: number;
  width_m: number;
  widths_m?: number[];
  gutter_widths_m?: number[];
  centerline: Vec3Tuple[];
}

export interface MedianTransitionTrunk {
  cut_point: Vec3Tuple;
  out_dir_xz: [number, number];
  width_m: number;
  lanes: number;
  forward_lanes: number;
  reverse_lanes: number;
  lanes_both_ways?: number;
  u_at_split: boolean;
  yellow_offset_right?: number;
}

export interface MedianTransitionBranch {
  cut_point: Vec3Tuple;
  out_dir_xz: [number, number];
  width_m: number;
  lanes: number;
  u_at_split: boolean;
}

export interface MedianTransition {
  split_node: number;
  layer: number;
  trunk: MedianTransitionTrunk;
  branches: [MedianTransitionBranch, MedianTransitionBranch] | MedianTransitionBranch[];
}

export interface DirectedEdge {
  id: string;
  u: number;
  v: number;
  key: number;
  physical_edge_id: string;
  direction: 'forward' | 'reverse';
  lanes: number;
  maxspeed_kmh: number | null;
  oneway: boolean;
  length_m: number;
  turn_restrictions: TurnRestriction[];
}

export interface ChunkHeader {
  id: string;
  gx: number;
  gz: number;
  chunk_size_m: number;
  bounds_m: ChunkBounds;
}

export interface RailTrack {
  id: string;
  railway_type: 'tram' | 'light_rail' | 'rail' | string;
  name: string | null;
  layer: number;
  bridge: boolean;
  embedded_in_road: boolean;
  geometry: Vec3Tuple[];
}

export interface RailCrossing {
  id: string;
  crossing_type: 'rail' | 'tram' | string;
  layer: number;
  position: Vec3Tuple;
  road_dir_xz: [number, number];
  rail_dir_xz: [number, number];
  road_width_m: number;
  has_gates: boolean;
}

export interface HighwayGore {
  node_id: number;
  layer: number;
  mode: 'diverge' | 'merge' | string;
  apex: Vec3Tuple;
  left_edge: Vec3Tuple[];
  right_edge: Vec3Tuple[];
}

export interface BusBay {
  id: string;
  layer: number;
  position: Vec3Tuple;
  dir_xz: [number, number];
  outward_xz: [number, number];
  length_m: number;
  width_m: number;
}

export interface ChunkData {
  chunk: ChunkHeader;
  nodes: MapNode[];
  edges: MapEdge[];
  directed_edges?: DirectedEdge[];
  intersection_groups?: IntersectionGroup[];
  median_islands?: MedianIsland[];
  median_transitions?: MedianTransition[];
  highway_gores?: HighwayGore[];
  rail_tracks?: RailTrack[];
  rail_crossings?: RailCrossing[];
  bus_bays?: BusBay[];
  terrain_grid?: number[][];
}

export interface UtmCoordinate {
  easting: number;
  northing: number;
  elevation: number;
  crs: string;
}
