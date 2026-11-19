export interface VehicleColorOption {
  id: string;
  label: string;
  hex: number;
  css: string;
}

export interface VehicleDimensions {
  lengthMeters: number;
  widthMeters: number;
  heightMeters: number;
  wheelbaseMeters: number;
  trackWidthMeters: number;
  wheelRadiusMeters: number;
  wheelWidthMeters: number;
}

export interface VehicleHandlingSpec {
  massKg: number;
  maxSteerRad: number;
  peakGripCoeff: number;
  maxSpeedKmh: number;
  maxReverseSpeedKmh: number;
  engineForceGain: number;
  brakeDecelMps2: number;
  dragArea: number;
}

export interface VehicleDefinition {
  id: string;
  name: string;
  category: string;
  tagline: string;
  dimensions: VehicleDimensions;
  handling: VehicleHandlingSpec;
  defaultColorId: string;
}

export const VEHICLE_PAINT_OPTIONS: readonly VehicleColorOption[] = [
  { id: 'cobalt', label: 'Cobalt', hex: 0x2563eb, css: '#2563eb' },
  { id: 'crimson', label: 'Crimson', hex: 0xdc2626, css: '#dc2626' },
  { id: 'pearl', label: 'Pearl', hex: 0xe2e8f0, css: '#e2e8f0' },
  { id: 'emerald', label: 'Emerald', hex: 0x059669, css: '#059669' },
  { id: 'graphite', label: 'Graphite', hex: 0x475569, css: '#475569' },
];

/**
 * Spawnable vehicle definitions scaled strictly 1:1 in world meters
 * (e.g., 1.80 m wide inside a 3.50 m Toronto lane).
 */
export const VEHICLE_CATALOG: readonly VehicleDefinition[] = [
  {
    id: 'toronto_compact',
    name: 'Compact Sedan',
    category: 'City Car',
    tagline: '1:1 scaled daily driver · responsive city & highway steering',
    dimensions: {
      lengthMeters: 4.35,
      widthMeters: 1.80,
      heightMeters: 1.42,
      wheelbaseMeters: 2.66,
      trackWidthMeters: 1.56,
      wheelRadiusMeters: 0.32,
      wheelWidthMeters: 0.22,
    },
    handling: {
      massKg: 1380,
      maxSteerRad: 0.60,
      peakGripCoeff: 1.12,
      maxSpeedKmh: 140,
      maxReverseSpeedKmh: 28,
      engineForceGain: 15.8,
      brakeDecelMps2: 14.5,
      dragArea: 0.68,
    },
    defaultColorId: 'cobalt',
  },
];

export function getVehicleDefinition(id: string): VehicleDefinition {
  return VEHICLE_CATALOG.find((item) => item.id === id) ?? VEHICLE_CATALOG[0]!;
}

export function getPaintColorHex(colorId: string): number {
  return (
    VEHICLE_PAINT_OPTIONS.find((c) => c.id === colorId)?.hex ??
    VEHICLE_PAINT_OPTIONS[0]!.hex
  );
}
