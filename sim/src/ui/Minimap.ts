import type { ChunkBounds, UtmCoordinate } from '../world/MapTypes.ts';

const SETTINGS_STORAGE_KEY = 'toronto_sim_minimap_settings';
const GRID_CELL_METERS = 500;

interface MinimapRoadRecord {
  n: string | null; // street_name
  h: string; // highway
  l: number; // lanes
  w: number; // width_m
  o: boolean; // oneway
  y: number; // elevation
  z: number; // layer
  p: Array<[number, number]>; // [x, z] points
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  tier: number; // 0=local, 1=tertiary, 2=secondary, 3=primary/trunk, 4=motorway
}

interface RawMinimapRoad {
  n: string | null;
  h: string;
  l: number;
  w: number;
  o: boolean;
  y: number;
  z: number;
  p: Array<[number, number]>;
}

export type MapViewStyle = 'default' | 'colored' | 'realistic' | 'terrain';

export interface AerialOverlayState {
  rect: DOMRect;
  centerMapX: number;
  centerMapZ: number;
  halfVisW: number;
  halfVisH: number;
  headingRad: number;
  rotateMap: boolean;
  activeZoom: number;
  isFullscreen: boolean;
}

export interface MinimapSettings {
  northLock: boolean;
  showLabels: boolean;
  showChunkGrid: boolean;
  arterialsOnly: boolean;
  showFovCone: boolean;
  closeOnTeleport: boolean;
  opacity: number;
  viewStyle: MapViewStyle;
}

export interface MinimapState {
  mapX: number;
  mapY: number;
  mapZ: number;
  headingRad: number;
  utm: UtmCoordinate;
  loadedChunkBounds: ChunkBounds[];
  originEasting: number;
  originNorthing: number;
}

export interface MinimapOptions {
  roadsUrl?: string;
  initialZoomMeters?: number;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  onViewStyleChange?: (style: MapViewStyle) => void;
  onTeleport?: (
    mapX: number,
    mapY: number,
    mapZ: number,
    nearestStreet: string | null,
  ) => void;
}

const DEFAULT_SETTINGS: MinimapSettings = {
  northLock: true,
  showLabels: true,
  showChunkGrid: false,
  arterialsOnly: false,
  showFovCone: true,
  closeOnTeleport: true,
  opacity: 0.92,
  viewStyle: 'default',
};

const MAP_STYLE_OPTIONS: ReadonlyArray<{
  id: MapViewStyle;
  miniLabel: string;
  fullLabel: string;
  title: string;
}> = [
  { id: 'default', miniLabel: 'Default', fullLabel: 'Default', title: 'Default simulator vector map' },
  { id: 'colored', miniLabel: 'Color', fullLabel: 'Colored', title: 'Google Maps style bright colored street map' },
  {
    id: 'realistic',
    miniLabel: 'Aerial',
    fullLabel: 'Realistic (Aerial)',
    title: 'Live aerial sky camera showing realistic textures, lane lines, crosswalks, and signals',
  },
  { id: 'terrain', miniLabel: 'Terrain', fullLabel: 'Terrain', title: 'Topographic elevation & valley relief map' },
];

const BOROUGH_PRESETS: Array<{ label: string; x: number; z: number; zoom: number }> = [
  { label: 'Downtown', x: 0, z: 350, zoom: 1100 },
  { label: 'Scarborough', x: 10000, z: -14500, zoom: 3200 },
  { label: 'Steeles E', x: 10000, z: -20260, zoom: 1600 },
  { label: 'North York', x: -2700, z: -11660, zoom: 2400 },
  { label: 'Etobicoke', x: -12000, z: 2500, zoom: 2800 },
  { label: 'York', x: -7500, z: -4500, zoom: 2200 },
  { label: 'East York', x: 3800, z: -4200, zoom: 2200 },
];

function classifyHighwayTier(hw: string): number {
  if (hw === 'motorway' || hw === 'motorway_link') return 4;
  if (hw === 'trunk' || hw === 'trunk_link' || hw === 'primary' || hw === 'primary_link') {
    return 3;
  }
  if (hw === 'secondary' || hw === 'secondary_link') return 2;
  if (hw === 'tertiary' || hw === 'tertiary_link') return 1;
  return 0;
}

function isValidMapStyle(value: unknown): value is MapViewStyle {
  return (
    value === 'default' ||
    value === 'colored' ||
    value === 'realistic' ||
    value === 'terrain'
  );
}

function readStoredSettings(): MinimapSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<MinimapSettings>;
    return {
      northLock:
        typeof parsed.northLock === 'boolean'
          ? parsed.northLock
          : DEFAULT_SETTINGS.northLock,
      showLabels:
        typeof parsed.showLabels === 'boolean'
          ? parsed.showLabels
          : DEFAULT_SETTINGS.showLabels,
      showChunkGrid:
        typeof parsed.showChunkGrid === 'boolean'
          ? parsed.showChunkGrid
          : DEFAULT_SETTINGS.showChunkGrid,
      arterialsOnly:
        typeof parsed.arterialsOnly === 'boolean'
          ? parsed.arterialsOnly
          : DEFAULT_SETTINGS.arterialsOnly,
      showFovCone:
        typeof parsed.showFovCone === 'boolean'
          ? parsed.showFovCone
          : DEFAULT_SETTINGS.showFovCone,
      closeOnTeleport:
        typeof parsed.closeOnTeleport === 'boolean'
          ? parsed.closeOnTeleport
          : DEFAULT_SETTINGS.closeOnTeleport,
      opacity:
        typeof parsed.opacity === 'number' &&
        parsed.opacity >= 0.4 &&
        parsed.opacity <= 1
          ? parsed.opacity
          : DEFAULT_SETTINGS.opacity,
      viewStyle: isValidMapStyle(parsed.viewStyle)
        ? parsed.viewStyle
        : DEFAULT_SETTINGS.viewStyle,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeStoredSettings(settings: MinimapSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore restricted storage errors
  }
}

function pointToSegmentDistSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-6) {
    const ddx = px - ax;
    const ddz = pz - az;
    return ddx * ddx + ddz * ddz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  const rx = px - cx;
  const rz = pz - cz;
  return rx * rx + rz * rz;
}

/**
 * Native game-data vector minimap & fullscreen Toronto map (`M` key) with
 * settings (North Lock, zoom, labels, chunk grid) and Developer Teleport Mode.
 */
export class Minimap {
  private zoomMeters: number;
  private fullZoomMeters = 1800;
  private settings: MinimapSettings;
  private isFullscreen = false;
  private settingsOpen = false;
  private teleportMode = false;

  private roads: MinimapRoadRecord[] = [];
  private majorRoadIndices: number[] = [];
  private readonly cellIndex = new Map<string, number[]>();
  private mapBounds = { minX: -22000, maxX: 21000, minZ: -23000, maxZ: 8500 };
  private roadsLoaded = false;

  // Fullscreen pan state in map meters
  private panX = 0;
  private panZ = 0;
  private isDragging = false;
  private dragMovedPx = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private hoverWorld: { x: number; z: number; y: number; street: string | null } | null =
    null;

  private lastState: MinimapState = {
    mapX: 0,
    mapY: 50,
    mapZ: 0,
    headingRad: 0,
    utm: { easting: 630614.6, northing: 4834952.5, elevation: 50, crs: 'EPSG:32617' },
    loadedChunkBounds: [],
    originEasting: 630614.631,
    originNorthing: 4834952.502,
  };

  private readonly onFullscreenChange:
    | ((isFullscreen: boolean) => void)
    | undefined;
  private readonly onViewStyleChange:
    | ((style: MapViewStyle) => void)
    | undefined;
  private readonly onTeleport:
    | ((
        mapX: number,
        mapY: number,
        mapZ: number,
        nearestStreet: string | null,
      ) => void)
    | undefined;

  // DOM elements
  private readonly root: HTMLDivElement;
  private readonly miniHeader: HTMLDivElement;
  private readonly miniStyleStrip: HTMLDivElement;
  private readonly miniFooter: HTMLDivElement;
  private readonly fullToolbar: HTMLDivElement;
  private readonly fullBoroughBar: HTMLDivElement;
  private readonly fullStatusBar: HTMLDivElement;
  private readonly settingsPanel: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scaleLabelEl: HTMLSpanElement;
  private readonly compassBadgeEl: HTMLSpanElement;
  private readonly teleportBtn: HTMLButtonElement;
  private northLockBtnFull: HTMLButtonElement;
  private labelsBtnFull: HTMLButtonElement;
  private gridBtnFull: HTMLButtonElement;
  private readonly miniStyleBtns = new Map<MapViewStyle, HTMLButtonElement>();
  private readonly fullStyleBtns = new Map<MapViewStyle, HTMLButtonElement>();
  private readonly toastEl: HTMLDivElement;
  private toastTimeout: number | null = null;

  constructor(container?: HTMLElement, options: MinimapOptions = {}) {
    this.zoomMeters = Math.max(80, options.initialZoomMeters ?? 260);
    this.settings = readStoredSettings();
    this.onFullscreenChange = options.onFullscreenChange;
    this.onViewStyleChange = options.onViewStyleChange;
    this.onTeleport = options.onTeleport;

    this.root = document.createElement('div');
    this.root.id = 'minimap-container';

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D canvas context for Minimap.');
    }
    this.ctx = ctx;

    this.miniHeader = document.createElement('div');
    this.miniStyleStrip = document.createElement('div');
    this.miniFooter = document.createElement('div');
    this.fullToolbar = document.createElement('div');
    this.fullBoroughBar = document.createElement('div');
    this.fullStatusBar = document.createElement('div');
    this.settingsPanel = document.createElement('div');
    this.scaleLabelEl = document.createElement('span');
    this.compassBadgeEl = document.createElement('span');
    this.teleportBtn = document.createElement('button');
    this.northLockBtnFull = document.createElement('button');
    this.labelsBtnFull = document.createElement('button');
    this.gridBtnFull = document.createElement('button');
    this.toastEl = document.createElement('div');

    if (container) {
      this.buildDom(container);
      this.applyLayoutMode();
      this.attachEvents();
      void this.loadRoads(options.roadsUrl ?? '/map_chunks/minimap_roads.json');
    }
  }

  public setZoom(zoomMeters: number): void {
    if (this.isFullscreen) {
      this.fullZoomMeters = Math.max(80, Math.min(28000, zoomMeters));
    } else {
      this.zoomMeters = Math.max(80, Math.min(2500, zoomMeters));
    }
  }

  public getZoom(): number {
    return this.isFullscreen ? this.fullZoomMeters : this.zoomMeters;
  }

  public isFullscreenOpen(): boolean {
    return this.isFullscreen;
  }

  public isTeleportModeEnabled(): boolean {
    return this.teleportMode;
  }

  public getViewStyle(): MapViewStyle {
    return this.settings.viewStyle;
  }

  public setViewStyle(style: MapViewStyle): void {
    if (this.settings.viewStyle === style) {
      return;
    }
    this.settings.viewStyle = style;
    writeStoredSettings(this.settings);
    this.updateToolbarButtons();
    this.applyLayoutMode();
    this.onViewStyleChange?.(style);
    this.render();
  }

  public getPanTargetXZ(): { x: number; z: number } {
    return { x: this.panX, z: this.panZ };
  }

  /**
   * Returns live orthographic sky-camera parameters when Realistic (Aerial) mode is active,
   * allowing the WebGL renderer to draw real 3D roads/paints/lights directly behind the canvas.
   */
  public getAerialOverlayState(): AerialOverlayState | null {
    if (this.settings.viewStyle !== 'realistic' || !this.roadsLoaded) {
      return null;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 16) {
      return null;
    }
    const activeZoom = this.isFullscreen ? this.fullZoomMeters : this.zoomMeters;
    const halfMinDim = Math.min(rect.width, rect.height) * 0.5;
    const pxPerMeter = halfMinDim / activeZoom;
    const halfVisW = (rect.width * 0.5) / pxPerMeter;
    const halfVisH = (rect.height * 0.5) / pxPerMeter;
    const rotateMap = !this.settings.northLock && !this.isFullscreen;
    return {
      rect,
      centerMapX: this.isFullscreen ? this.panX : this.lastState.mapX,
      centerMapZ: this.isFullscreen ? this.panZ : this.lastState.mapZ,
      halfVisW,
      halfVisH,
      headingRad: this.lastState.headingRad,
      rotateMap,
      activeZoom,
      isFullscreen: this.isFullscreen,
    };
  }

  public setFullscreen(open: boolean): void {
    if (this.isFullscreen === open) {
      return;
    }
    this.isFullscreen = open;
    if (open) {
      this.panX = this.lastState.mapX;
      this.panZ = this.lastState.mapZ;
      this.settingsOpen = false;
    } else {
      this.isDragging = false;
      this.hoverWorld = null;
    }
    this.applyLayoutMode();
    this.onFullscreenChange?.(open);
    this.render();
  }

  public toggleFullscreen(): boolean {
    this.setFullscreen(!this.isFullscreen);
    return this.isFullscreen;
  }

  public setTeleportMode(enabled: boolean): void {
    this.teleportMode = enabled;
    this.updateToolbarButtons();
    this.applyCursorStyle();
  }

  public update(state: MinimapState): void {
    this.lastState = state;
    this.render();
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('mouseup', this.handleWindowMouseUp);
    window.removeEventListener('mousemove', this.handleWindowMouseMove);
    if (this.toastTimeout !== null) {
      window.clearTimeout(this.toastTimeout);
    }
    this.root.remove();
    this.toastEl.remove();
  }

  private async loadRoads(url: string): Promise<void> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Failed to load minimap roads (${resp.status})`);
      }
      const payload = (await resp.json()) as { roads: RawMinimapRoad[] };
      const records: MinimapRoadRecord[] = [];
      const majors: number[] = [];
      let gMinX = Infinity;
      let gMaxX = -Infinity;
      let gMinZ = Infinity;
      let gMaxZ = -Infinity;

      for (const raw of payload.roads) {
        if (!raw.p || raw.p.length < 2) {
          continue;
        }
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const pt of raw.p) {
          if (pt[0] < minX) minX = pt[0];
          if (pt[0] > maxX) maxX = pt[0];
          if (pt[1] < minZ) minZ = pt[1];
          if (pt[1] > maxZ) maxZ = pt[1];
        }
        if (minX < gMinX) gMinX = minX;
        if (maxX > gMaxX) gMaxX = maxX;
        if (minZ < gMinZ) gMinZ = minZ;
        if (maxZ > gMaxZ) gMaxZ = maxZ;

        const tier = classifyHighwayTier(raw.h);
        const idx = records.length;
        records.push({
          ...raw,
          minX,
          maxX,
          minZ,
          maxZ,
          tier,
        });
        if (tier >= 2) {
          majors.push(idx);
        }

        const gx0 = Math.floor(minX / GRID_CELL_METERS);
        const gx1 = Math.floor(maxX / GRID_CELL_METERS);
        const gz0 = Math.floor(minZ / GRID_CELL_METERS);
        const gz1 = Math.floor(maxZ / GRID_CELL_METERS);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gz = gz0; gz <= gz1; gz++) {
            const key = `${gx}:${gz}`;
            let list = this.cellIndex.get(key);
            if (!list) {
              list = [];
              this.cellIndex.set(key, list);
            }
            list.push(idx);
          }
        }
      }

      this.roads = records;
      this.majorRoadIndices = majors;
      if (Number.isFinite(gMinX)) {
        this.mapBounds = {
          minX: gMinX,
          maxX: gMaxX,
          minZ: gMinZ,
          maxZ: gMaxZ,
        };
      }
      this.roadsLoaded = true;
      this.render();
    } catch (err) {
      console.error('Minimap road index load failed:', err);
    }
  }

  private buildDom(container: HTMLElement): void {
    this.root.style.fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    this.root.style.color = '#e2e8f0';
    this.root.style.userSelect = 'none';

    const makeBtn = (label: string, title = ''): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (title) btn.title = title;
      Object.assign(btn.style, {
        cursor: 'pointer',
        border: '1px solid rgba(148, 163, 184, 0.3)',
        background: 'rgba(30, 41, 59, 0.85)',
        color: '#e2e8f0',
        borderRadius: '6px',
        padding: '3px 8px',
        fontFamily: 'inherit',
        fontSize: '11px',
        fontWeight: '600',
      });
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      return btn;
    };

    // Mini header (top-right compact widget)
    Object.assign(this.miniHeader.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '6px 8px',
      background: 'rgba(15, 23, 42, 0.9)',
      borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
      fontSize: '10.5px',
    });

    const miniTitle = document.createElement('span');
    miniTitle.textContent = 'MAP [M]';
    miniTitle.style.color = '#38bdf8';
    miniTitle.style.fontWeight = '700';

    const miniBtns = document.createElement('div');
    miniBtns.style.display = 'flex';
    miniBtns.style.gap = '4px';

    const zoomOutMini = makeBtn('−', 'Zoom out');
    zoomOutMini.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setZoom(this.zoomMeters * 1.4);
      this.render();
    });

    const zoomInMini = makeBtn('+', 'Zoom in');
    zoomInMini.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setZoom(this.zoomMeters / 1.4);
      this.render();
    });

    const gearBtn = makeBtn('⚙', 'Minimap settings');
    gearBtn.id = 'minimap-settings-btn';
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.settingsOpen = !this.settingsOpen;
      this.settingsPanel.style.display = this.settingsOpen ? 'flex' : 'none';
    });

    const expandBtn = makeBtn('⤢', 'Open fullscreen map (M)');
    expandBtn.id = 'minimap-expand-btn';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setFullscreen(true);
    });

    miniBtns.append(zoomOutMini, zoomInMini, gearBtn, expandBtn);
    this.miniHeader.append(miniTitle, miniBtns);

    // Compact 4-mode style switcher strip inside top-right Minimap
    Object.assign(this.miniStyleStrip.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '3px',
      padding: '4px 6px',
      background: 'rgba(13, 17, 23, 0.94)',
      borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
    });
    for (const styleOpt of MAP_STYLE_OPTIONS) {
      const btn = makeBtn(styleOpt.miniLabel, styleOpt.title);
      btn.id = `minimap-style-mini-${styleOpt.id}`;
      Object.assign(btn.style, {
        flex: '1',
        padding: '2px 4px',
        fontSize: '9.5px',
        textAlign: 'center',
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setViewStyle(styleOpt.id);
      });
      this.miniStyleBtns.set(styleOpt.id, btn);
      this.miniStyleStrip.appendChild(btn);
    }

    // Mini footer
    Object.assign(this.miniFooter.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 8px',
      background: 'rgba(15, 23, 42, 0.9)',
      borderTop: '1px solid rgba(148, 163, 184, 0.2)',
      fontSize: '10px',
      color: '#94a3b8',
    });
    this.miniFooter.append(this.compassBadgeEl, this.scaleLabelEl);

    // Fullscreen top toolbar
    Object.assign(this.fullToolbar.style, {
      display: 'none',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '8px',
      padding: '10px 16px',
      background: 'rgba(13, 17, 23, 0.95)',
      borderBottom: '1px solid rgba(148, 163, 184, 0.25)',
    });

    const fullTitle = document.createElement('div');
    fullTitle.textContent = 'TORONTO CITY MAP // ALL 6 BOROUGHS';
    Object.assign(fullTitle.style, {
      fontSize: '12px',
      fontWeight: '700',
      letterSpacing: '0.06em',
      color: '#38bdf8',
    });

    const fullControls = document.createElement('div');
    Object.assign(fullControls.style, {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '6px',
    });

    this.teleportBtn.id = 'minimap-teleport-btn';
    this.teleportBtn.type = 'button';
    Object.assign(this.teleportBtn.style, {
      cursor: 'pointer',
      borderRadius: '999px',
      padding: '5px 12px',
      fontFamily: 'inherit',
      fontSize: '11.5px',
      fontWeight: '700',
    });
    this.teleportBtn.addEventListener('click', () => {
      this.setTeleportMode(!this.teleportMode);
    });

    this.northLockBtnFull = makeBtn('North Lock: ON', 'Toggle North-Up vs Heading-Up');
    this.northLockBtnFull.id = 'minimap-northlock-btn';
    this.northLockBtnFull.addEventListener('click', () => {
      this.updateSetting('northLock', !this.settings.northLock);
    });

    this.labelsBtnFull = makeBtn('Labels: ON', 'Toggle street labels');
    this.labelsBtnFull.addEventListener('click', () => {
      this.updateSetting('showLabels', !this.settings.showLabels);
    });

    this.gridBtnFull = makeBtn('Grid: OFF', 'Toggle 500m chunk grid');
    this.gridBtnFull.addEventListener('click', () => {
      this.updateSetting('showChunkGrid', !this.settings.showChunkGrid);
    });

    const centerBtn = makeBtn('Center [C]', 'Center on current position');
    centerBtn.addEventListener('click', () => {
      this.panX = this.lastState.mapX;
      this.panZ = this.lastState.mapZ;
      this.render();
    });

    const fitAllBtn = makeBtn('Fit Toronto', 'Zoom out to full 6-borough city');
    fitAllBtn.addEventListener('click', () => {
      this.panX = (this.mapBounds.minX + this.mapBounds.maxX) * 0.5;
      this.panZ = (this.mapBounds.minZ + this.mapBounds.maxZ) * 0.5;
      this.fullZoomMeters = 22000;
      this.render();
    });

    const fullZoomOut = makeBtn('−', 'Zoom out');
    fullZoomOut.addEventListener('click', () => {
      this.setZoom(this.fullZoomMeters * 1.35);
      this.render();
    });
    const fullZoomIn = makeBtn('+', 'Zoom in');
    fullZoomIn.addEventListener('click', () => {
      this.setZoom(this.fullZoomMeters / 1.35);
      this.render();
    });

    const closeBtn = makeBtn('Close [M]', 'Return to 3D view');
    closeBtn.id = 'minimap-close-btn';
    closeBtn.style.borderColor = 'rgba(248, 113, 113, 0.5)';
    closeBtn.style.color = '#fecaca';
    closeBtn.addEventListener('click', () => this.setFullscreen(false));

    fullControls.append(
      this.teleportBtn,
      this.northLockBtnFull,
      this.labelsBtnFull,
      this.gridBtnFull,
      centerBtn,
      fitAllBtn,
      fullZoomOut,
      fullZoomIn,
      closeBtn,
    );
    this.fullToolbar.append(fullTitle, fullControls);

    // Borough quick-jump bar inside fullscreen map
    Object.assign(this.fullBoroughBar.style, {
      display: 'none',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '6px',
      padding: '6px 16px',
      background: 'rgba(15, 23, 42, 0.92)',
      borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
      fontSize: '11px',
    });
    const jumpLabel = document.createElement('span');
    jumpLabel.textContent = 'Boroughs:';
    jumpLabel.style.color = '#94a3b8';
    this.fullBoroughBar.appendChild(jumpLabel);
    for (const preset of BOROUGH_PRESETS) {
      const b = makeBtn(preset.label, `Jump map view to ${preset.label}`);
      b.addEventListener('click', () => {
        this.panX = preset.x;
        this.panZ = preset.z;
        this.fullZoomMeters = preset.zoom;
        this.render();
      });
      this.fullBoroughBar.appendChild(b);
    }

    const styleDivider = document.createElement('span');
    styleDivider.textContent = '|';
    styleDivider.style.color = 'rgba(148, 163, 184, 0.35)';
    styleDivider.style.margin = '0 4px';
    this.fullBoroughBar.appendChild(styleDivider);

    const styleLabelFull = document.createElement('span');
    styleLabelFull.textContent = 'View:';
    styleLabelFull.style.color = '#94a3b8';
    this.fullBoroughBar.appendChild(styleLabelFull);

    for (const styleOpt of MAP_STYLE_OPTIONS) {
      const sb = makeBtn(styleOpt.fullLabel, styleOpt.title);
      sb.id = `minimap-style-full-${styleOpt.id}`;
      sb.addEventListener('click', () => {
        this.setViewStyle(styleOpt.id);
      });
      this.fullStyleBtns.set(styleOpt.id, sb);
      this.fullBoroughBar.appendChild(sb);
    }

    // Fullscreen bottom status bar
    Object.assign(this.fullStatusBar.style, {
      display: 'none',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '7px 16px',
      background: 'rgba(13, 17, 23, 0.95)',
      borderTop: '1px solid rgba(148, 163, 184, 0.25)',
      fontSize: '11.5px',
      color: '#cbd5e1',
    });

    // Settings popover panel (for mini & full)
    this.settingsPanel.id = 'minimap-settings-panel';
    Object.assign(this.settingsPanel.style, {
      display: 'none',
      flexDirection: 'column',
      gap: '7px',
      position: 'absolute',
      top: '36px',
      right: '6px',
      width: '215px',
      padding: '10px',
      borderRadius: '8px',
      background: 'rgba(13, 17, 23, 0.96)',
      border: '1px solid rgba(148, 163, 184, 0.32)',
      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
      zIndex: '50',
      fontSize: '11px',
    });
    this.rebuildSettingsPanel();

    this.root.append(
      this.miniHeader,
      this.miniStyleStrip,
      this.fullToolbar,
      this.fullBoroughBar,
      this.canvas,
      this.miniFooter,
      this.fullStatusBar,
      this.settingsPanel,
    );

    // Toast notification
    Object.assign(this.toastEl.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 16px',
      borderRadius: '999px',
      background: 'rgba(14, 165, 233, 0.92)',
      color: '#f8fafc',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: '12px',
      fontWeight: '700',
      zIndex: '60',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 180ms ease',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
    });

    container.appendChild(this.root);
    container.appendChild(this.toastEl);
    this.updateToolbarButtons();
  }

  private rebuildSettingsPanel(): void {
    this.settingsPanel.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.textContent = 'MINIMAP SETTINGS';
    hdr.style.color = '#38bdf8';
    hdr.style.fontWeight = '700';
    hdr.style.fontSize = '10.5px';
    this.settingsPanel.appendChild(hdr);

    const addToggle = (
      label: string,
      key:
        | 'northLock'
        | 'showLabels'
        | 'showChunkGrid'
        | 'arterialsOnly'
        | 'showFovCone'
        | 'closeOnTeleport',
    ) => {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
      });
      const text = document.createElement('span');
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.settings[key];
      input.addEventListener('change', () => {
        this.updateSetting(key, input.checked);
      });
      row.append(text, input);
      this.settingsPanel.appendChild(row);
    };

    addToggle('North Lock', 'northLock');
    addToggle('Street Names', 'showLabels');
    addToggle('Chunk Grid (500m)', 'showChunkGrid');
    addToggle('Arterials Only', 'arterialsOnly');
    addToggle('FOV Cone', 'showFovCone');
    addToggle('Close on Teleport', 'closeOnTeleport');

    const opRow = document.createElement('div');
    Object.assign(opRow.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '8px',
    });
    const opLabel = document.createElement('span');
    opLabel.textContent = 'Opacity';
    const opSlider = document.createElement('input');
    opSlider.type = 'range';
    opSlider.min = '0.5';
    opSlider.max = '1';
    opSlider.step = '0.05';
    opSlider.value = String(this.settings.opacity);
    opSlider.style.width = '90px';
    opSlider.addEventListener('input', () => {
      this.settings.opacity = Number(opSlider.value);
      writeStoredSettings(this.settings);
      if (!this.isFullscreen && this.settings.viewStyle !== 'realistic') {
        this.root.style.opacity = String(this.settings.opacity);
      }
    });
    opRow.append(opLabel, opSlider);
    this.settingsPanel.appendChild(opRow);
  }

  private updateSetting<K extends keyof MinimapSettings>(
    key: K,
    value: MinimapSettings[K],
  ): void {
    this.settings[key] = value;
    writeStoredSettings(this.settings);
    this.rebuildSettingsPanel();
    this.updateToolbarButtons();
    if (!this.isFullscreen && this.settings.viewStyle !== 'realistic') {
      this.root.style.opacity = String(this.settings.opacity);
    }
    this.render();
  }

  private updateToolbarButtons(): void {
    if (this.teleportMode) {
      this.teleportBtn.textContent = 'Teleport Mode (Dev): ON';
      this.teleportBtn.setAttribute('aria-pressed', 'true');
      Object.assign(this.teleportBtn.style, {
        background: 'rgba(16, 185, 129, 0.25)',
        border: '1px solid rgba(52, 211, 153, 0.8)',
        color: '#d1fae5',
      });
    } else {
      this.teleportBtn.textContent = 'Teleport Mode (Dev): OFF';
      this.teleportBtn.setAttribute('aria-pressed', 'false');
      Object.assign(this.teleportBtn.style, {
        background: 'rgba(51, 65, 85, 0.6)',
        border: '1px solid rgba(148, 163, 184, 0.35)',
        color: '#cbd5e1',
      });
    }

    this.northLockBtnFull.textContent = `North Lock: ${this.settings.northLock ? 'ON' : 'OFF'}`;
    this.labelsBtnFull.textContent = `Labels: ${this.settings.showLabels ? 'ON' : 'OFF'}`;
    this.gridBtnFull.textContent = `Grid: ${this.settings.showChunkGrid ? 'ON' : 'OFF'}`;

    for (const [styleId, btn] of this.miniStyleBtns.entries()) {
      const active = styleId === this.settings.viewStyle;
      btn.style.background = active
        ? 'rgba(14, 165, 233, 0.28)'
        : 'rgba(30, 41, 59, 0.72)';
      btn.style.borderColor = active
        ? '#38bdf8'
        : 'rgba(148, 163, 184, 0.22)';
      btn.style.color = active ? '#e0f2fe' : '#94a3b8';
    }
    for (const [styleId, btn] of this.fullStyleBtns.entries()) {
      const active = styleId === this.settings.viewStyle;
      btn.style.background = active
        ? 'rgba(14, 165, 233, 0.30)'
        : 'rgba(30, 41, 59, 0.85)';
      btn.style.borderColor = active
        ? '#38bdf8'
        : 'rgba(148, 163, 184, 0.3)';
      btn.style.color = active ? '#e0f2fe' : '#cbd5e1';
    }
  }

  private applyCursorStyle(): void {
    if (!this.isFullscreen) {
      this.canvas.style.cursor = 'pointer';
    } else if (this.teleportMode) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = this.isDragging ? 'grabbing' : 'grab';
    }
  }

  private applyLayoutMode(): void {
    const isRealistic = this.settings.viewStyle === 'realistic';
    if (this.isFullscreen) {
      Object.assign(this.root.style, {
        position: 'fixed',
        inset: '0',
        top: '0',
        right: '0',
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '0',
        border: 'none',
        background: isRealistic ? 'transparent' : 'rgba(9, 13, 20, 0.98)',
        opacity: '1',
        zIndex: '45',
        overflow: 'hidden',
      });
      this.miniHeader.style.display = 'none';
      this.miniStyleStrip.style.display = 'none';
      this.miniFooter.style.display = 'none';
      this.settingsPanel.style.display = 'none';
      this.fullToolbar.style.display = 'flex';
      this.fullBoroughBar.style.display = 'flex';
      this.fullStatusBar.style.display = 'flex';
      this.canvas.style.flex = '1';
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
    } else {
      Object.assign(this.root.style, {
        position: 'fixed',
        inset: 'auto',
        top: '14px',
        right: '14px',
        width: '236px',
        height: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '10px',
        border: '1px solid rgba(148, 163, 184, 0.3)',
        background: isRealistic ? 'transparent' : 'rgba(13, 17, 23, 0.88)',
        opacity: isRealistic ? '1' : String(this.settings.opacity),
        zIndex: '25',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.42)',
        overflow: 'visible',
      });
      this.miniHeader.style.display = 'flex';
      this.miniStyleStrip.style.display = 'flex';
      this.miniFooter.style.display = 'flex';
      this.fullToolbar.style.display = 'none';
      this.fullBoroughBar.style.display = 'none';
      this.fullStatusBar.style.display = 'none';
      this.canvas.style.flex = 'none';
      this.canvas.style.width = '236px';
      this.canvas.style.height = '214px';
    }
    this.resizeCanvas();
    this.applyCursorStyle();
  }

  private resizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.isFullscreen) {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(300, Math.floor(rect.width));
      const h = Math.max(200, Math.floor(rect.height));
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    } else {
      this.canvas.width = Math.floor(236 * dpr);
      this.canvas.height = Math.floor(214 * dpr);
    }
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; z: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const cx = rect.width * 0.5;
    const cy = rect.height * 0.5;
    const halfMinDim = Math.min(rect.width, rect.height) * 0.5;
    const activeZoom = this.isFullscreen ? this.fullZoomMeters : this.zoomMeters;
    const pxPerMeter = halfMinDim / activeZoom;

    let dx = (px - cx) / pxPerMeter;
    let dz = (py - cy) / pxPerMeter;

    const mapCenterX = this.isFullscreen ? this.panX : this.lastState.mapX;
    const mapCenterZ = this.isFullscreen ? this.panZ : this.lastState.mapZ;

    if (!this.settings.northLock && !this.isFullscreen) {
      const cos = Math.cos(this.lastState.headingRad);
      const sin = Math.sin(this.lastState.headingRad);
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      dx = rx;
      dz = rz;
    }

    return {
      x: mapCenterX + dx,
      z: mapCenterZ + dz,
    };
  }

  private findNearestRoadAt(
    wx: number,
    wz: number,
  ): { y: number; street: string | null } {
    const gx = Math.floor(wx / GRID_CELL_METERS);
    const gz = Math.floor(wz / GRID_CELL_METERS);
    let bestDistSq = Infinity;
    let bestRoad: MinimapRoadRecord | null = null;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.cellIndex.get(`${gx + dx}:${gz + dz}`);
        if (!list) continue;
        for (const idx of list) {
          const road = this.roads[idx]!;
          for (let i = 0; i < road.p.length - 1; i++) {
            const a = road.p[i]!;
            const b = road.p[i + 1]!;
            const dSq = pointToSegmentDistSq(wx, wz, a[0], a[1], b[0], b[1]);
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestRoad = road;
            }
          }
        }
      }
    }

    if (bestRoad) {
      return { y: bestRoad.y, street: bestRoad.n };
    }
    return { y: 30, street: null };
  }

  private showToast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.style.opacity = '1';
    if (this.toastTimeout !== null) {
      window.clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = window.setTimeout(() => {
      this.toastEl.style.opacity = '0';
    }, 2400);
  }

  private render(): void {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = width / dpr;
    const cssH = height / dpr;
    const cx = cssW * 0.5;
    const cy = cssH * 0.5;

    const activeZoom = this.isFullscreen ? this.fullZoomMeters : this.zoomMeters;
    const halfMinDim = Math.min(cssW, cssH) * 0.5;
    const pxPerMeter = halfMinDim / activeZoom;
    const centerX = this.isFullscreen ? this.panX : this.lastState.mapX;
    const centerZ = this.isFullscreen ? this.panZ : this.lastState.mapZ;
    const rotateMap = !this.settings.northLock && !this.isFullscreen;
    const mapRotation = rotateMap ? -this.lastState.headingRad : 0;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const viewStyle = this.settings.viewStyle;
    const isLightMap = viewStyle === 'colored' || viewStyle === 'terrain';

    // Background per map style
    if (viewStyle === 'colored') {
      ctx.fillStyle = '#f1efe8';
    } else if (viewStyle === 'terrain') {
      ctx.fillStyle = '#e5ece0';
    } else if (viewStyle === 'realistic') {
      ctx.fillStyle = '#202b22';
    } else {
      ctx.fillStyle = '#0b111b';
    }
    ctx.fillRect(0, 0, cssW, cssH);

    if (!this.roadsLoaded) {
      ctx.fillStyle = isLightMap ? '#475569' : '#94a3b8';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Loading Toronto road map...', cx, cy);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(cx, cy);
    if (mapRotation !== 0) {
      ctx.rotate(mapRotation);
    }
    ctx.scale(pxPerMeter, pxPerMeter);
    ctx.translate(-centerX, -centerZ);

    // Compute visible world AABB (expanded by 1.45x when rotated)
    const halfVisW = (cssW * 0.5) / pxPerMeter;
    const halfVisH = (cssH * 0.5) / pxPerMeter;
    const padFactor = rotateMap ? 1.45 : 1.05;
    const minVisX = centerX - halfVisW * padFactor;
    const maxVisX = centerX + halfVisW * padFactor;
    const minVisZ = centerZ - halfVisH * padFactor;
    const maxVisZ = centerZ + halfVisH * padFactor;

    // Subtle Lake Ontario shoreline fill for Colored / Terrain / Aerial overview
    if (viewStyle !== 'default' && maxVisZ > 1550) {
      ctx.fillStyle =
        viewStyle === 'colored'
          ? '#aadaff'
          : viewStyle === 'terrain'
            ? '#a3cfec'
            : '#142a40';
      ctx.fillRect(
        minVisX - 500,
        1550,
        maxVisX - minVisX + 1000,
        Math.max(0, maxVisZ - 1550 + 500),
      );
    }

    // Collect visible road indices (LOD: city-wide overview uses majorRoadIndices)
    const minTier =
      this.settings.arterialsOnly || activeZoom > 6500
        ? 2
        : activeZoom > 3200
          ? 1
          : 0;

    const visibleIndices: number[] = [];
    if (activeZoom > 4000) {
      for (const idx of this.majorRoadIndices) {
        const r = this.roads[idx]!;
        if (
          r.tier >= minTier &&
          r.maxX >= minVisX &&
          r.minX <= maxVisX &&
          r.maxZ >= minVisZ &&
          r.minZ <= maxVisZ
        ) {
          visibleIndices.push(idx);
        }
      }
    } else {
      const seen = new Set<number>();
      const gx0 = Math.floor(minVisX / GRID_CELL_METERS);
      const gx1 = Math.floor(maxVisX / GRID_CELL_METERS);
      const gz0 = Math.floor(minVisZ / GRID_CELL_METERS);
      const gz1 = Math.floor(maxVisZ / GRID_CELL_METERS);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
          const list = this.cellIndex.get(`${gx}:${gz}`);
          if (!list) continue;
          for (const idx of list) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const r = this.roads[idx]!;
            if (
              r.tier >= minTier &&
              r.maxX >= minVisX &&
              r.minX <= maxVisX &&
              r.maxZ >= minVisZ &&
              r.minZ <= maxVisZ
            ) {
              visibleIndices.push(idx);
            }
          }
        }
      }
    }

    // Sort ground roads before elevated overpasses, and local streets before freeways
    visibleIndices.sort((a, b) => {
      const ra = this.roads[a]!;
      const rb = this.roads[b]!;
      if (ra.z !== rb.z) return ra.z - rb.z;
      return ra.tier - rb.tier;
    });

    const minStrokeWorld = 1.15 / pxPerMeter;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Hypsometric elevation relief bands for Terrain mode using real road elevation (y_m)
    if (viewStyle === 'terrain') {
      const swathWidth = Math.max(110 / pxPerMeter, 90);
      ctx.save();
      ctx.globalAlpha = 0.32;
      let prevElevColor = '';
      ctx.lineWidth = swathWidth;
      ctx.beginPath();
      for (const idx of visibleIndices) {
        const road = this.roads[idx]!;
        const elevColor =
          road.y < 92
            ? '#a9dab2' // Low valleys & shoreline (Don / Humber / Waterfront)
            : road.y < 130
              ? '#cde6c1' // Lower midtown terraces
              : road.y < 168
                ? '#e7ecd2' // Midtown/East York upland
                : '#dfd0b2'; // High Scarborough / North York / Steeles ridges
        if (elevColor !== prevElevColor) {
          if (prevElevColor) {
            ctx.stroke();
            ctx.beginPath();
          }
          prevElevColor = elevColor;
          ctx.strokeStyle = elevColor;
        }
        const pts = road.p;
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i]![0], pts[i]![1]);
        }
      }
      if (prevElevColor) {
        ctx.stroke();
      }
      ctx.restore();
    }

    const strokeRoadBatch = (
      palette: readonly string[],
      widthPaddingWorld: number,
    ): void => {
      let currentStyle = '';
      let currentWidth = -1;
      ctx.beginPath();
      for (const idx of visibleIndices) {
        const road = this.roads[idx]!;
        const strokeW = Math.max(minStrokeWorld, road.w) + widthPaddingWorld;
        const qWidth = Math.round(strokeW * 4) * 0.25;
        const color =
          road.z > 0 && road.tier === 4
            ? palette[4]!
            : palette[road.tier] ?? palette[1]!;
        if (color !== currentStyle || qWidth !== currentWidth) {
          if (currentStyle) {
            ctx.stroke();
            ctx.beginPath();
          }
          currentStyle = color;
          currentWidth = qWidth;
          ctx.strokeStyle = color;
          ctx.lineWidth = qWidth;
        }
        const pts = road.p;
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i]![0], pts[i]![1]);
        }
      }
      if (currentStyle) {
        ctx.stroke();
      }
    };

    if (viewStyle === 'colored') {
      // Crisp Google Maps Standard Colored casing + bright fills
      strokeRoadBatch(
        ['#d1d5db', '#cbd5e1', '#eab308', '#ca8a04', '#ea580c'],
        2.0 / pxPerMeter,
      );
      strokeRoadBatch(['#ffffff', '#fef9c3', '#fde047', '#facc15', '#fb923c'], 0);
    } else if (viewStyle === 'terrain') {
      strokeRoadBatch(
        ['#b8c4b8', '#9aa89c', '#ca8a04', '#d97706', '#c2410c'],
        1.8 / pxPerMeter,
      );
      strokeRoadBatch(['#ffffff', '#fefce8', '#fef08a', '#fbbf24', '#fb923c'], 0);
    } else if (viewStyle === 'realistic') {
      // Muted satellite fallback roads ONLY visible outside live streamed 3D chunks
      strokeRoadBatch(['#37413c', '#454e49', '#575f5b', '#767a72', '#a87d32'], 0);
      // Punch transparent windows over every streamed 3D chunk so the live
      // WebGL orthographic Sky Camera shines straight through at full detail!
      for (const b of this.lastState.loadedChunkBounds) {
        if (
          b.max_x < minVisX ||
          b.min_x > maxVisX ||
          b.max_z < minVisZ ||
          b.min_z > maxVisZ
        ) {
          continue;
        }
        ctx.clearRect(
          b.min_x - 0.6,
          b.min_z - 0.6,
          b.max_x - b.min_x + 1.2,
          b.max_z - b.min_z + 1.2,
        );
      }
    } else {
      const defaultPalette = ['#334155', '#475569', '#64748b', '#cbd5e1', '#f59e0b'];
      strokeRoadBatch(defaultPalette, 0);
    }

    // Optional 500m chunk grid & loaded chunk highlight (drawn after clearRect in aerial mode)
    if (this.settings.showChunkGrid) {
      if (viewStyle !== 'realistic') {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
        for (const b of this.lastState.loadedChunkBounds) {
          if (
            b.max_x < minVisX ||
            b.min_x > maxVisX ||
            b.max_z < minVisZ ||
            b.min_z > maxVisZ
          ) {
            continue;
          }
          ctx.fillRect(
            b.min_x,
            b.min_z,
            b.max_x - b.min_x,
            b.max_z - b.min_z,
          );
        }
      }

      const gx0 = Math.floor(minVisX / GRID_CELL_METERS);
      const gx1 = Math.ceil(maxVisX / GRID_CELL_METERS);
      const gz0 = Math.floor(minVisZ / GRID_CELL_METERS);
      const gz1 = Math.ceil(maxVisZ / GRID_CELL_METERS);
      if ((gx1 - gx0) * (gz1 - gz0) < 4000) {
        ctx.strokeStyle = isLightMap
          ? 'rgba(71, 85, 105, 0.18)'
          : 'rgba(148, 163, 184, 0.16)';
        ctx.lineWidth = Math.max(0.8 / pxPerMeter, 1);
        ctx.beginPath();
        for (let gx = gx0; gx <= gx1; gx++) {
          const x = gx * GRID_CELL_METERS;
          ctx.moveTo(x, minVisZ);
          ctx.lineTo(x, maxVisZ);
        }
        for (let gz = gz0; gz <= gz1; gz++) {
          const z = gz * GRID_CELL_METERS;
          ctx.moveTo(minVisX, z);
          ctx.lineTo(maxVisX, z);
        }
        ctx.stroke();
      }
    }

    // Optional street labels on major visible streets
    if (this.settings.showLabels && activeZoom <= 5500) {
      const labelTierMin =
        activeZoom > 2600 ? 3 : activeZoom > 900 ? 2 : 1;
      const placedNames = new Set<string>();
      const fontSizeWorld = 11 / pxPerMeter;
      ctx.font = `700 ${fontSizeWorld}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const maxLabels = this.isFullscreen ? 45 : 8;
      let labelCount = 0;

      for (let k = visibleIndices.length - 1; k >= 0; k--) {
        if (labelCount >= maxLabels) break;
        const road = this.roads[visibleIndices[k]!]!;
        if (!road.n || road.tier < labelTierMin || placedNames.has(road.n)) {
          continue;
        }
        const pts = road.p;
        const mid = pts[Math.floor(pts.length * 0.5)]!;
        if (
          mid[0] < minVisX ||
          mid[0] > maxVisX ||
          mid[1] < minVisZ ||
          mid[1] > maxVisZ
        ) {
          continue;
        }
        placedNames.add(road.n);
        labelCount++;

        ctx.save();
        ctx.translate(mid[0], mid[1]);
        if (mapRotation !== 0) {
          ctx.rotate(-mapRotation);
        }
        ctx.lineWidth = 3 / pxPerMeter;
        ctx.strokeStyle = isLightMap
          ? 'rgba(255, 255, 255, 0.94)'
          : 'rgba(11, 17, 27, 0.92)';
        ctx.strokeText(road.n, 0, 0);
        ctx.fillStyle = isLightMap
          ? road.tier === 4
            ? '#9a3412'
            : '#1e293b'
          : road.tier === 4
            ? '#fde68a'
            : '#f1f5f9';
        ctx.fillText(road.n, 0, 0);
        ctx.restore();
      }
    }

    // Player / camera marker in world space
    const px = this.lastState.mapX;
    const pz = this.lastState.mapZ;
    const markerScale = 1 / pxPerMeter;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(this.lastState.headingRad);
    ctx.scale(markerScale, markerScale);

    if (this.settings.showFovCone) {
      const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 38);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 38, -Math.PI * 0.5 - 0.52, -Math.PI * 0.5 + 0.52);
      ctx.closePath();
      ctx.fill();
    }

    // Crisp player chevron pointing UP (-Z in local rotated frame)
    ctx.fillStyle = '#38bdf8';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // end world transform

    // Compass North badge on mini mode
    if (!this.isFullscreen) {
      const ringRadius = Math.min(cx, cy) - 14;
      const nAngle = rotateMap ? mapRotation - Math.PI * 0.5 : -Math.PI * 0.5;
      const nx = cx + Math.cos(nAngle) * ringRadius;
      const ny = cy + Math.sin(nAngle) * ringRadius;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.beginPath();
      ctx.arc(nx, ny, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#fca5a5';
      ctx.font = '700 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', nx, ny + 0.5);
    }

    ctx.restore();

    // Update labels & status bars
    this.compassBadgeEl.textContent = this.settings.northLock
      ? 'NORTHLOCK: ON'
      : 'HEADING-UP';
    this.scaleLabelEl.textContent = `${Math.round(this.zoomMeters)}m radius`;

    if (this.isFullscreen) {
      if (this.hoverWorld) {
        const hw = this.hoverWorld;
        const easting = this.lastState.originEasting + hw.x;
        const northing = this.lastState.originNorthing - hw.z;
        const streetPart = hw.street ? ` · ${hw.street}` : '';
        const actionHint = this.teleportMode
          ? 'CLICK TO TELEPORT HERE'
          : 'Drag: Pan · Scroll: Zoom · Toggle Teleport Mode above to click-teleport';
        this.fullStatusBar.textContent = `Cursor: E ${easting.toFixed(1)} N ${northing.toFixed(1)} (Map ${hw.x.toFixed(0)}, ${hw.z.toFixed(0)} · Y≈${hw.y.toFixed(1)}m)${streetPart}   |   ${actionHint}`;
      } else {
        this.fullStatusBar.textContent = `Map Span: ~42km × 31km (${this.roads.length.toLocaleString()} road segments) · Press M or ESC to return`;
      }
    }
  }

  private attachEvents(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('mouseup', this.handleWindowMouseUp);
    window.addEventListener('mousemove', this.handleWindowMouseMove);

    this.canvas.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      if (!this.isFullscreen) {
        return;
      }
      if (event.button === 0) {
        this.isDragging = true;
        this.dragMovedPx = 0;
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        this.applyCursorStyle();
      }
    });

    this.canvas.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!this.isFullscreen) {
        this.setFullscreen(true);
        return;
      }
      if (this.teleportMode && this.dragMovedPx <= 5) {
        const world = this.screenToWorld(event.clientX, event.clientY);
        const nearest = this.findNearestRoadAt(world.x, world.z);
        const targetY = nearest.y + 24;
        this.onTeleport?.(world.x, targetY, world.z, nearest.street);
        const label = nearest.street ?? `(${world.x.toFixed(0)}, ${world.z.toFixed(0)})`;
        this.showToast(`Teleported to ${label}`);
        if (this.settings.closeOnTeleport) {
          this.setFullscreen(false);
        } else {
          this.panX = world.x;
          this.panZ = world.z;
          this.render();
        }
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        const factor = event.deltaY > 0 ? 1.18 : 1 / 1.18;
        this.setZoom(this.getZoom() * factor);
        this.render();
      },
      { passive: false },
    );
  }

  private readonly handleWindowMouseMove = (event: MouseEvent): void => {
    if (!this.isFullscreen) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const halfMinDim = Math.min(rect.width, rect.height) * 0.5;
    if (halfMinDim <= 0) {
      return;
    }

    if (this.isDragging) {
      const dxPx = event.clientX - this.lastMouseX;
      const dyPx = event.clientY - this.lastMouseY;
      this.dragMovedPx += Math.hypot(dxPx, dyPx);
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;

      const pxPerMeter = halfMinDim / this.fullZoomMeters;
      if (pxPerMeter > 0) {
        this.panX -= dxPx / pxPerMeter;
        this.panZ -= dyPx / pxPerMeter;
      }
    }

    const overCanvas =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (overCanvas) {
      const world = this.screenToWorld(event.clientX, event.clientY);
      const nearest = this.findNearestRoadAt(world.x, world.z);
      this.hoverWorld = {
        x: world.x,
        z: world.z,
        y: nearest.y,
        street: nearest.street,
      };
      this.render();
    } else if (this.hoverWorld !== null || this.isDragging) {
      this.hoverWorld = null;
      this.render();
    }
  };

  private readonly handleWindowMouseUp = (): void => {
    if (this.isDragging) {
      this.isDragging = false;
      this.applyCursorStyle();
    }
  };

  private readonly handleResize = (): void => {
    this.resizeCanvas();
    this.render();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.code === 'KeyM') {
      event.preventDefault();
      this.toggleFullscreen();
    } else if (event.code === 'Escape' && this.isFullscreen) {
      event.preventDefault();
      this.setFullscreen(false);
    } else if (event.code === 'KeyC' && this.isFullscreen) {
      event.preventDefault();
      event.stopPropagation();
      this.panX = this.lastState.mapX;
      this.panZ = this.lastState.mapZ;
      this.render();
    }
  };
}
