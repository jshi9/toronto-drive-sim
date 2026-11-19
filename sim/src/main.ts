import * as THREE from 'three';
import { FixedTimestepLoop, FloatingOriginManager } from './core/index.ts';
import {
  DebugHud,
  Minimap,
  VehicleSpawnHud,
  type MapViewStyle,
} from './ui/index.ts';
import {
  CameraPovController,
  DrivableCar,
  getVehicleDefinition,
  type CameraPovMode,
  type DrivingInputState,
} from './vehicle/index.ts';
import { ChunkStreamer, FreeFlyCameraController } from './world/index.ts';
import {
  createEarthTerrainTextureSet,
  type ProceduralSurfaceTextureSet,
} from './world/WorldStyleTextures.ts';

function bootstrap(): void {
  const container = document.getElementById('app');
  if (!container) {
    throw new Error('Missing #app mount element.');
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b111b);
  scene.fog = new THREE.Fog(0x0b111b, 1100, 2300);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.15,
    4000,
  );
  // Start above downtown Toronto near Yonge & Queen looking along Queen St East
  const params = new URLSearchParams(window.location.search);
  const startX = Number(params.get('x'));
  const startY = Number(params.get('y'));
  const startZ = Number(params.get('z'));
  const targetX = Number(params.get('tx'));
  const targetY = Number(params.get('ty'));
  const targetZ = Number(params.get('tz'));

  if (
    params.has('x') &&
    params.has('y') &&
    params.has('z') &&
    Number.isFinite(startX) &&
    Number.isFinite(startY) &&
    Number.isFinite(startZ)
  ) {
    camera.position.set(startX, startY, startZ);
    if (
      params.has('tx') &&
      params.has('ty') &&
      params.has('tz') &&
      Number.isFinite(targetX) &&
      Number.isFinite(targetY) &&
      Number.isFinite(targetZ)
    ) {
      camera.lookAt(targetX, targetY, targetZ);
    } else {
      camera.lookAt(startX + 40, startY - 30, startZ + 40);
    }
  } else {
    camera.position.set(60, 58, 290);
    camera.lookAt(220, 14, 360);
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.45);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.65);
  scene.add(hemiLight);

  const directionalLight = new THREE.DirectionalLight(0xfff7ed, 1.65);
  directionalLight.position.set(180, 260, 140);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.set(2048, 2048);
  directionalLight.shadow.camera.near = 10;
  directionalLight.shadow.camera.far = 900;
  const shadowExtent = 320;
  directionalLight.shadow.camera.left = -shadowExtent;
  directionalLight.shadow.camera.right = shadowExtent;
  directionalLight.shadow.camera.top = shadowExtent;
  directionalLight.shadow.camera.bottom = -shadowExtent;
  scene.add(directionalLight);
  scene.add(directionalLight.target);

  // Subtle datum ground plane below minimum elevation (-4.6m) that tracks camera XZ
  const groundGeometry = new THREE.PlaneGeometry(5000, 5000);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x111824,
    roughness: 0.96,
    metalness: 0.04,
  });
  const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = -8;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const floatingOrigin = new FloatingOriginManager(1000);
  let chunkStreamer: ChunkStreamer | null = null;
  const hud = new DebugHud(container, {
    onToggleRoadNames: (visible) => {
      chunkStreamer?.setStreetNamesVisible(visible);
    },
  });

  chunkStreamer = new ChunkStreamer({
    floatingOrigin,
    loadRadiusMeters: 1500,
    unloadRadiusMeters: 2000,
    baseUrl: '/map_chunks',
    streetNamesVisible: hud.isRoadNamesVisible(),
  });
  scene.add(chunkStreamer.worldRoot);

  const freeFly = new FreeFlyCameraController(camera, renderer.domElement, {
    baseSpeedMetersPerSec: 45,
    boostMultiplier: 4,
    floatingOrigin,
  });

  const originScratch = new THREE.Vector3();
  const mapPosScratch = new THREE.Vector3();
  const forwardScratch = new THREE.Vector3();
  const focusPosScratch = new THREE.Vector3();

  let activeCar: DrivableCar | null = null;
  let minimapFullscreenOpen = false;
  let vehicleHud: VehicleSpawnHud;

  const cameraPov = new CameraPovController(
    camera,
    renderer.domElement,
    freeFly,
    floatingOrigin,
    (mode, fov) => {
      vehicleHud?.setCameraState(mode, fov);
    },
  );

  const placeCarOnNearestRoad = (
    car: DrivableCar,
    targetMapX: number,
    targetMapY: number,
    targetMapZ: number,
    preferredDirXZ?: [number, number],
  ): void => {
    const placement = chunkStreamer!.findNearestRoadPlacement(
      targetMapX,
      targetMapY,
      targetMapZ,
      preferredDirXZ,
    );
    floatingOrigin.getWorldOrigin(originScratch);
    if (placement) {
      const localPos = placement.mapPosition.clone().sub(originScratch);
      car.placeAt(
        localPos,
        placement.headingRad,
        placement.streetName,
        placement.maxspeedKmh,
      );
    } else {
      const surf = chunkStreamer!.sampleRoadSurface(
        targetMapX,
        targetMapY,
        targetMapZ,
      );
      const localPos = new THREE.Vector3(
        targetMapX - originScratch.x,
        surf.elevationY,
        targetMapZ - originScratch.z,
      );
      const heading = preferredDirXZ
        ? Math.atan2(preferredDirXZ[0], -preferredDirXZ[1])
        : freeFly.getHeadingRadians();
      car.placeAt(localPos, heading, surf.streetName, surf.maxspeedKmh);
    }
  };

  const spawnVehicle = (vehicleId: string, colorId: string): void => {
    const def = getVehicleDefinition(vehicleId);
    if (activeCar) {
      scene.remove(activeCar.root);
      activeCar.dispose();
      activeCar = null;
    }

    const car = new DrivableCar(def, floatingOrigin, colorId);
    scene.add(car.root);
    activeCar = car;

    // Project a point slightly ahead of the camera onto road level
    camera.getWorldDirection(forwardScratch);
    const camHeading = Math.atan2(forwardScratch.x, -forwardScratch.z);
    const camMap = chunkStreamer!.getMapCoordinates(camera.position, mapPosScratch);
    const forwardStep = THREE.MathUtils.clamp(camera.position.y * 0.35, 6, 45);
    const horizLen = Math.hypot(forwardScratch.x, forwardScratch.z) || 1;
    const dirX = forwardScratch.x / horizLen;
    const dirZ = forwardScratch.z / horizLen;

    placeCarOnNearestRoad(
      car,
      camMap.x + dirX * forwardStep,
      camMap.y,
      camMap.z + dirZ * forwardStep,
      [Math.sin(camHeading), -Math.cos(camHeading)],
    );

    cameraPov.setActiveCar(car);
    const nextPov: CameraPovMode =
      cameraPov.getMode() === 'free_fly' ? 'third_person' : cameraPov.getMode();
    cameraPov.setMode(nextPov);
    vehicleHud.setVehicleActive(true);
    vehicleHud.setCameraState(cameraPov.getMode(), cameraPov.getEffectiveFov());

    car.getFocusLocalPosition(focusPosScratch);
    floatingOrigin.update(focusPosScratch);
    chunkStreamer!.update(focusPosScratch);
  };

  const despawnVehicle = (): void => {
    if (!activeCar) {
      return;
    }
    scene.remove(activeCar.root);
    activeCar.dispose();
    activeCar = null;
    cameraPov.setActiveCar(null);
    vehicleHud.setVehicleActive(false);
    vehicleHud.setCameraState('free_fly', cameraPov.getEffectiveFov());
  };

  vehicleHud = new VehicleSpawnHud(container, {
    onSpawnVehicle: spawnVehicle,
    onDespawnVehicle: despawnVehicle,
    onSelectColor: (colorId) => {
      activeCar?.setPaintColor(colorId);
    },
    onToggleExitCar: () => {
      if (!activeCar) {
        return;
      }
      activeCar.setOnFoot(!activeCar.isOnFoot(), chunkStreamer!);
      if (cameraPov.getMode() === 'free_fly') {
        cameraPov.setMode('third_person');
      }
    },
    onResetToRoad: () => {
      if (!activeCar) {
        return;
      }
      if (activeCar.isOnFoot()) {
        activeCar.setOnFoot(false);
      }
      const carMap = chunkStreamer!.getMapCoordinates(
        activeCar.getCarLocalPosition(focusPosScratch),
        mapPosScratch,
      );
      const yaw = activeCar.getCarYawRad();
      placeCarOnNearestRoad(activeCar, carMap.x, carMap.y, carMap.z, [
        -Math.sin(yaw),
        -Math.cos(yaw),
      ]);
    },
    onSelectPov: (mode) => {
      cameraPov.setMode(mode);
    },
    onSelectFov: (fovDeg) => {
      cameraPov.setFovDegrees(fovDeg);
    },
  });

  // Keyboard state for driving, avatar walking, POV cycling [V], Exit/Enter [F], FOV [[]/[]]
  const keysDown = new Set<string>();
  const isTextInputFocused = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  window.addEventListener('keydown', (event) => {
    if (isTextInputFocused(event.target) || minimapFullscreenOpen) {
      return;
    }
    keysDown.add(event.code);

    if (event.repeat) {
      return;
    }
    if (event.code === 'KeyV' && activeCar) {
      cameraPov.cycleMode();
    } else if (event.code === 'KeyC' && activeCar && cameraPov.getMode() !== 'free_fly') {
      cameraPov.cycleMode();
    } else if (event.code === 'KeyF' && activeCar) {
      activeCar.setOnFoot(!activeCar.isOnFoot(), chunkStreamer!);
      if (cameraPov.getMode() === 'free_fly') {
        cameraPov.setMode('third_person');
      }
    } else if (event.code === 'KeyR' && activeCar && cameraPov.getMode() !== 'free_fly') {
      if (activeCar.isOnFoot()) {
        activeCar.setOnFoot(false);
      }
      const carMap = chunkStreamer!.getMapCoordinates(
        activeCar.getCarLocalPosition(focusPosScratch),
        mapPosScratch,
      );
      const yaw = activeCar.getCarYawRad();
      placeCarOnNearestRoad(activeCar, carMap.x, carMap.y, carMap.z, [
        -Math.sin(yaw),
        -Math.cos(yaw),
      ]);
    } else if (event.code === 'BracketLeft') {
      cameraPov.setFovDegrees(cameraPov.getEffectiveFov() - 5);
    } else if (event.code === 'BracketRight') {
      cameraPov.setFovDegrees(cameraPov.getEffectiveFov() + 5);
    }
  });

  window.addEventListener('keyup', (event) => {
    keysDown.delete(event.code);
  });

  window.addEventListener('blur', () => {
    keysDown.clear();
  });

  const defaultBgColor = new THREE.Color(0x0b111b);
  const realisticSkyColor = new THREE.Color(0x88b4dc);
  const aerialGroundBackdrop = new THREE.Color(0x202b22);
  const defaultFog = new THREE.Fog(0x0b111b, 1100, 2300);
  const realisticFog = new THREE.Fog(0xb6cfe5, 1300, 2900);

  let groundEarthTextures: ProceduralSurfaceTextureSet | null = null;
  let currentMapStyle: MapViewStyle = 'default';

  const applyWorldVisualStyle = (style: MapViewStyle): void => {
    currentMapStyle = style;
    const realistic = style === 'realistic';
    chunkStreamer?.setRealisticMode(realistic);
    if (realistic) {
      groundEarthTextures ??= createEarthTerrainTextureSet(125);
      groundMaterial.map = groundEarthTextures.map;
      groundMaterial.roughnessMap = groundEarthTextures.roughnessMap;
      groundMaterial.color.setHex(0xc8d2be);
      groundMaterial.needsUpdate = true;

      scene.background = realisticSkyColor;
      scene.fog = realisticFog;
      ambientLight.intensity = 0.72;
      hemiLight.color.setHex(0xe0f2fe);
      hemiLight.groundColor.setHex(0x475540);
      hemiLight.intensity = 0.85;
      directionalLight.color.setHex(0xfffbeb);
      directionalLight.intensity = 2.1;
    } else {
      groundMaterial.map = null;
      groundMaterial.roughnessMap = null;
      groundMaterial.color.setHex(0x111824);
      groundMaterial.needsUpdate = true;

      scene.background = defaultBgColor;
      scene.fog = defaultFog;
      ambientLight.intensity = 0.45;
      hemiLight.color.setHex(0xdbeafe);
      hemiLight.groundColor.setHex(0x1e293b);
      hemiLight.intensity = 0.65;
      directionalLight.color.setHex(0xfff7ed);
      directionalLight.intensity = 1.65;
    }
  };

  const skyCamera = new THREE.OrthographicCamera(-260, 260, 260, -260, 10, 2200);

  const minimap = new Minimap(container, {
    roadsUrl: '/map_chunks/minimap_roads.json',
    initialZoomMeters: 260,
    onFullscreenChange: (open) => {
      minimapFullscreenOpen = open;
      if (open) {
        keysDown.clear();
      }
      hud.setVisible(!open);
      vehicleHud.setVisible(!open);
      cameraPov.setInputEnabled(!open);
      if (!open) {
        chunkStreamer!.setSecondaryMapFocus(null);
      }
    },
    onViewStyleChange: (style) => {
      applyWorldVisualStyle(style);
    },
    onTeleport: (mapX, mapY, mapZ) => {
      floatingOrigin.getWorldOrigin(originScratch);
      camera.position.set(mapX - originScratch.x, mapY, mapZ - originScratch.z);
      if (activeCar && cameraPov.getMode() !== 'free_fly') {
        if (activeCar.isOnFoot()) {
          activeCar.setOnFoot(false);
        }
        const yaw = activeCar.getCarYawRad();
        activeCar.placeAt(
          new THREE.Vector3(
            mapX - originScratch.x,
            mapY - 12,
            mapZ - originScratch.z,
          ),
          -yaw,
        );
        activeCar.getFocusLocalPosition(focusPosScratch);
        floatingOrigin.update(focusPosScratch);
        chunkStreamer!.update(focusPosScratch);
        placeCarOnNearestRoad(activeCar, mapX, mapY, mapZ, [
          -Math.sin(yaw),
          -Math.cos(yaw),
        ]);
      } else {
        floatingOrigin.update(camera.position);
        chunkStreamer!.update(camera.position);
      }
    },
  });
  applyWorldVisualStyle(minimap.getViewStyle());

  void chunkStreamer
    .init()
    .then(() => {
      chunkStreamer.update(camera.position);
    })
    .catch((err: unknown) => {
      console.error('Failed to initialize map streaming:', err);
    });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const loop = new FixedTimestepLoop(
    {
      onFixedUpdate: (fixedDeltaSeconds) => {
        const drivingModeActive =
          activeCar !== null &&
          cameraPov.getMode() !== 'free_fly' &&
          !minimapFullscreenOpen;

        if (activeCar) {
          const driveInput: DrivingInputState = drivingModeActive
            ? {
                throttle: keysDown.has('KeyW') || keysDown.has('ArrowUp'),
                brakeReverse: keysDown.has('KeyS') || keysDown.has('ArrowDown'),
                steerLeft: keysDown.has('KeyA') || keysDown.has('ArrowLeft'),
                steerRight: keysDown.has('KeyD') || keysDown.has('ArrowRight'),
                handbrake: keysDown.has('Space'),
                sprint: keysDown.has('ShiftLeft') || keysDown.has('ShiftRight'),
              }
            : {
                throttle: false,
                brakeReverse: false,
                steerLeft: false,
                steerRight: false,
                handbrake: !activeCar.isOnFoot(),
                sprint: false,
              };

          activeCar.step(
            fixedDeltaSeconds,
            driveInput,
            chunkStreamer,
            cameraPov.getWalkCameraYawHintRadians(),
          );
          vehicleHud.updateTelemetry(activeCar.getTelemetry());
        }

        cameraPov.update(fixedDeltaSeconds);

        const activeFocus =
          activeCar && cameraPov.getMode() !== 'free_fly'
            ? activeCar.getFocusLocalPosition(focusPosScratch)
            : camera.position;

        if (minimapFullscreenOpen && currentMapStyle === 'realistic') {
          chunkStreamer.setSecondaryMapFocus(minimap.getPanTargetXZ());
        } else {
          chunkStreamer.setSecondaryMapFocus(null);
        }

        floatingOrigin.update(activeFocus);
        chunkStreamer.update(activeFocus);
        chunkStreamer.updateTrafficLights(performance.now() * 0.001);

        groundMesh.position.x = activeFocus.x;
        groundMesh.position.z = activeFocus.z;
        if (groundEarthTextures && currentMapStyle === 'realistic') {
          floatingOrigin.getWorldOrigin(originScratch);
          const worldX = activeFocus.x + originScratch.x;
          const worldZ = activeFocus.z + originScratch.z;
          const tileMeters = 40;
          groundEarthTextures.map.offset.set(
            worldX / tileMeters,
            -worldZ / tileMeters,
          );
          groundEarthTextures.roughnessMap.offset.set(
            worldX / tileMeters,
            -worldZ / tileMeters,
          );
        }

        directionalLight.position.set(
          activeFocus.x + 180,
          activeFocus.y + 220,
          activeFocus.z + 140,
        );
        directionalLight.target.position.set(
          activeFocus.x,
          activeFocus.y - 40,
          activeFocus.z,
        );

        const utm = chunkStreamer.getUtmCoordinates(activeFocus);
        hud.update({
          utm,
          localPosition: activeFocus,
          loadedChunks: chunkStreamer.getLoadedChunkCount(),
          loadingChunks: chunkStreamer.getLoadingChunkCount(),
          totalChunks: chunkStreamer.getTotalChunkCount(),
          originShifts: chunkStreamer.getOriginShiftCount(),
          flySpeedMetersPerSec: freeFly.getBaseSpeedMetersPerSec(),
          pointerLocked: freeFly.isPointerLocked(),
        });

        const mapPos = chunkStreamer.getMapCoordinates(
          activeFocus,
          mapPosScratch,
        );
        const manifest = chunkStreamer.getManifest();
        minimap.update({
          mapX: mapPos.x,
          mapY: mapPos.y,
          mapZ: mapPos.z,
          headingRad: cameraPov.getActiveHeadingRadians(),
          utm,
          loadedChunkBounds: chunkStreamer.getLoadedChunkBounds(),
          originEasting: manifest?.projection.origin_utm.easting ?? 630614.631,
          originNorthing:
            manifest?.projection.origin_utm.northing ?? 4834952.502,
        });
      },
      onRender: (_alpha) => {
        renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
        renderer.setScissorTest(false);
        renderer.render(scene, camera);

        const aerial = minimap.getAerialOverlayState();
        if (aerial && aerial.activeZoom <= 4500) {
          floatingOrigin.getWorldOrigin(originScratch);
          const localCx = aerial.centerMapX - originScratch.x;
          const localCz = aerial.centerMapZ - originScratch.z;

          skyCamera.left = -aerial.halfVisW;
          skyCamera.right = aerial.halfVisW;
          skyCamera.top = aerial.halfVisH;
          skyCamera.bottom = -aerial.halfVisH;
          skyCamera.updateProjectionMatrix();

          const upAngle = aerial.rotateMap ? aerial.headingRad : 0;
          skyCamera.up.set(Math.sin(upAngle), 0, -Math.cos(upAngle));
          skyCamera.position.set(localCx, 1200, localCz);
          skyCamera.lookAt(localCx, 0, localCz);

          const vpX = aerial.rect.left;
          const vpY = window.innerHeight - aerial.rect.bottom;
          const vpW = aerial.rect.width;
          const vpH = aerial.rect.height;

          const prevGroundX = groundMesh.position.x;
          const prevGroundZ = groundMesh.position.z;
          groundMesh.position.x = localCx;
          groundMesh.position.z = localCz;

          const savedFog = scene.fog;
          const savedBg = scene.background;
          scene.fog = null;
          scene.background = aerialGroundBackdrop;

          renderer.autoClear = false;
          renderer.setScissorTest(true);
          renderer.setViewport(vpX, vpY, vpW, vpH);
          renderer.setScissor(vpX, vpY, vpW, vpH);
          renderer.clear(true, true, false);
          renderer.render(scene, skyCamera);

          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
          renderer.autoClear = true;
          scene.fog = savedFog;
          scene.background = savedBg;
          groundMesh.position.x = prevGroundX;
          groundMesh.position.z = prevGroundZ;
        }
      },
    },
    60,
  );

  loop.start();
}

bootstrap();
