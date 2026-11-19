export {
  VEHICLE_CATALOG,
  VEHICLE_PAINT_OPTIONS,
  getVehicleDefinition,
  getPaintColorHex,
} from './VehicleCatalog.ts';
export type {
  VehicleColorOption,
  VehicleDefinition,
  VehicleDimensions,
  VehicleHandlingSpec,
} from './VehicleCatalog.ts';
export { PlayerAvatar } from './PlayerAvatar.ts';
export type { AvatarPoseMode } from './PlayerAvatar.ts';
export { DrivableCar } from './DrivableCar.ts';
export type { DrivingInputState, VehicleTelemetry } from './DrivableCar.ts';
export {
  CameraPovController,
  CAMERA_POV_LIST,
  FOV_PRESETS,
} from './CameraPovController.ts';
export type { CameraPovMode, PovPresetInfo } from './CameraPovController.ts';
