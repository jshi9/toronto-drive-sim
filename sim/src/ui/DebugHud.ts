import type * as THREE from 'three';
import type { UtmCoordinate } from '../world/MapTypes.ts';

const ROAD_NAMES_STORAGE_KEY = 'toronto_sim_road_names';

export interface DebugHudState {
  utm: UtmCoordinate;
  localPosition: THREE.Vector3;
  loadedChunks: number;
  loadingChunks: number;
  totalChunks: number;
  originShifts: number;
  flySpeedMetersPerSec: number;
  pointerLocked: boolean;
}

export interface DebugHudOptions {
  onToggleRoadNames?: (visible: boolean) => void;
}

function readStoredRoadNamesPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(ROAD_NAMES_STORAGE_KEY);
    if (raw === 'false') {
      return false;
    }
    if (raw === 'true') {
      return true;
    }
  } catch {
    // Ignore storage access failures in restricted environments
  }
  return true;
}

function writeStoredRoadNamesPreference(visible: boolean): void {
  try {
    window.localStorage.setItem(ROAD_NAMES_STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage access failures in restricted environments
  }
}

/**
 * Lightweight DOM HUD readout displaying current UTM coordinates, elevation,
 * loaded chunk count, road name visibility toggle, and free-fly camera controls.
 */
export class DebugHud {
  private readonly root: HTMLDivElement;
  private readonly utmValueEl: HTMLSpanElement;
  private readonly elevationValueEl: HTMLSpanElement;
  private readonly chunksValueEl: HTMLSpanElement;
  private readonly originValueEl: HTMLSpanElement;
  private readonly roadNamesButton: HTMLButtonElement;
  private readonly modeHintEl: HTMLDivElement;
  private readonly onToggleRoadNames:
    | ((visible: boolean) => void)
    | undefined;
  private roadNamesVisible: boolean;

  constructor(container: HTMLElement, options: DebugHudOptions = {}) {
    this.onToggleRoadNames = options.onToggleRoadNames;
    this.roadNamesVisible = readStoredRoadNamesPreference();

    this.root = document.createElement('div');
    this.root.id = 'debug-hud';
    Object.assign(this.root.style, {
      position: 'fixed',
      top: '14px',
      left: '14px',
      zIndex: '20',
      pointerEvents: 'none',
      padding: '12px 14px',
      borderRadius: '10px',
      background: 'rgba(13, 17, 23, 0.82)',
      border: '1px solid rgba(148, 163, 184, 0.25)',
      backdropFilter: 'blur(8px)',
      color: '#e2e8f0',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.55',
      minWidth: '305px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    });

    const title = document.createElement('div');
    title.textContent = 'TORONTO SIM // WORLD DEBUG HUD';
    Object.assign(title.style, {
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.08em',
      color: '#38bdf8',
      marginBottom: '6px',
    });
    this.root.appendChild(title);

    const createRow = (labelText: string): HTMLSpanElement => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '14px',
      });
      const label = document.createElement('span');
      label.textContent = labelText;
      label.style.color = '#94a3b8';
      const val = document.createElement('span');
      val.style.color = '#f8fafc';
      val.style.fontWeight = '600';
      row.appendChild(label);
      row.appendChild(val);
      this.root.appendChild(row);
      return val;
    };

    this.utmValueEl = createRow('UTM (EPSG:32617)');
    this.elevationValueEl = createRow('ELEVATION');
    this.chunksValueEl = createRow('LOADED CHUNKS');
    this.originValueEl = createRow('LOCAL / SHIFTS');

    const toggleRow = document.createElement('div');
    Object.assign(toggleRow.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: '8px',
      paddingTop: '7px',
      borderTop: '1px solid rgba(148, 163, 184, 0.18)',
      gap: '12px',
    });

    const toggleHint = document.createElement('span');
    toggleHint.textContent = 'KEY [N]';
    Object.assign(toggleHint.style, {
      fontSize: '10.5px',
      color: '#94a3b8',
    });

    this.roadNamesButton = document.createElement('button');
    this.roadNamesButton.id = 'toggle-road-names';
    this.roadNamesButton.type = 'button';
    Object.assign(this.roadNamesButton.style, {
      pointerEvents: 'auto',
      cursor: 'pointer',
      padding: '4px 10px',
      borderRadius: '999px',
      fontFamily: 'inherit',
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.03em',
      transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
    });
    this.roadNamesButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleRoadNames();
    });
    this.roadNamesButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });

    toggleRow.appendChild(this.roadNamesButton);
    toggleRow.appendChild(toggleHint);
    this.root.appendChild(toggleRow);

    this.modeHintEl = document.createElement('div');
    Object.assign(this.modeHintEl.style, {
      marginTop: '8px',
      paddingTop: '7px',
      borderTop: '1px solid rgba(148, 163, 184, 0.18)',
      fontSize: '10.5px',
      color: '#94a3b8',
    });
    this.root.appendChild(this.modeHintEl);

    this.renderRoadNamesButton();
    window.addEventListener('keydown', this.handleKeyDown);
    container.appendChild(this.root);
  }

  public isRoadNamesVisible(): boolean {
    return this.roadNamesVisible;
  }

  public setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  public setRoadNamesVisible(visible: boolean): void {
    if (this.roadNamesVisible === visible) {
      return;
    }
    this.roadNamesVisible = visible;
    writeStoredRoadNamesPreference(visible);
    this.renderRoadNamesButton();
    this.onToggleRoadNames?.(visible);
  }

  public toggleRoadNames(): boolean {
    this.setRoadNamesVisible(!this.roadNamesVisible);
    return this.roadNamesVisible;
  }

  public update(state: DebugHudState): void {
    this.utmValueEl.textContent = `E ${state.utm.easting.toFixed(1)}  N ${state.utm.northing.toFixed(1)}`;
    this.elevationValueEl.textContent = `${state.utm.elevation.toFixed(2)} m`;

    const loadingSuffix =
      state.loadingChunks > 0 ? ` (+${state.loadingChunks} loading)` : '';
    const totalSuffix =
      state.totalChunks > 0 ? ` / ${state.totalChunks}` : '';
    this.chunksValueEl.textContent = `${state.loadedChunks}${totalSuffix}${loadingSuffix}`;

    this.originValueEl.textContent = `(${state.localPosition.x.toFixed(0)}, ${state.localPosition.z.toFixed(0)}) m · ${state.originShifts} shifts`;

    const lookMode = state.pointerLocked
      ? 'Mouse Locked (ESC unlock)'
      : 'Click/Drag: Look';
    this.modeHintEl.textContent = `${lookMode} · WASD: Fly · E/Q: Up/Down · Shift: Boost · Speed: ${state.flySpeedMetersPerSec.toFixed(0)} m/s`;
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    this.root.remove();
  }

  private renderRoadNamesButton(): void {
    if (this.roadNamesVisible) {
      this.roadNamesButton.textContent = 'Road Names: ON';
      this.roadNamesButton.setAttribute('aria-pressed', 'true');
      Object.assign(this.roadNamesButton.style, {
        background: 'rgba(14, 165, 233, 0.22)',
        border: '1px solid rgba(56, 189, 248, 0.65)',
        color: '#e0f2fe',
      });
    } else {
      this.roadNamesButton.textContent = 'Road Names: OFF';
      this.roadNamesButton.setAttribute('aria-pressed', 'false');
      Object.assign(this.roadNamesButton.style, {
        background: 'rgba(51, 65, 85, 0.45)',
        border: '1px solid rgba(148, 163, 184, 0.35)',
        color: '#94a3b8',
      });
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (event.code === 'KeyN') {
      this.toggleRoadNames();
    }
  };
}
