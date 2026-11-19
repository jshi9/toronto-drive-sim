import {
  CAMERA_POV_LIST,
  FOV_PRESETS,
  type CameraPovMode,
} from '../vehicle/CameraPovController.ts';
import type { VehicleTelemetry } from '../vehicle/DrivableCar.ts';
import {
  VEHICLE_CATALOG,
  VEHICLE_PAINT_OPTIONS,
} from '../vehicle/VehicleCatalog.ts';
import { Speedometer } from './Speedometer.ts';
import { Tachometer } from './Tachometer.ts';

export interface VehicleSpawnHudOptions {
  onSpawnVehicle: (vehicleId: string, colorId: string) => void;
  onDespawnVehicle: () => void;
  onSelectColor: (colorId: string) => void;
  onToggleExitCar: () => void;
  onResetToRoad: () => void;
  onSelectPov: (mode: CameraPovMode) => void;
  onSelectFov: (fovDeg: number) => void;
}

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/**
 * Vehicle spawner tray ("Add +" trigger + selectable vehicle popup),
 * POV/FOV bar ("First Person", "Third Person", etc.), and compact driving gauge.
 */
export class VehicleSpawnHud {
  private readonly options: VehicleSpawnHudOptions;

  private readonly dockRoot: HTMLDivElement;
  private readonly addButton: HTMLButtonElement;
  private readonly activeActionsRow: HTMLDivElement;
  private readonly enterExitBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly despawnBtn: HTMLButtonElement;
  private readonly popupEl: HTMLDivElement;

  private readonly povBarEl: HTMLDivElement;
  private readonly povButtons = new Map<CameraPovMode, HTMLButtonElement>();
  private readonly fovButtons = new Map<number, HTMLButtonElement>();

  private readonly gaugeEl: HTMLDivElement;
  private readonly speedValueEl: HTMLSpanElement;
  private readonly speedUnitEl: HTMLSpanElement;
  private readonly gearValueEl: HTMLSpanElement;
  private readonly streetValueEl: HTMLDivElement;
  private readonly rpmFillEl: HTMLDivElement;

  private readonly speedometer = new Speedometer();
  private readonly tachometer = new Tachometer();
  private readonly colorButtons = new Map<string, HTMLButtonElement>();

  private popupOpen = false;
  private selectedColorId = VEHICLE_PAINT_OPTIONS[0]!.id;
  private hasVehicle = false;
  private activePov: CameraPovMode = 'free_fly';
  private activeFov = 60;

  constructor(container: HTMLElement, options: VehicleSpawnHudOptions) {
    this.options = options;

    // 1. Bottom-Left Dock ("Add +" Trigger + Quick Controls + Selection Popup)
    this.dockRoot = document.createElement('div');
    this.dockRoot.id = 'vehicle-spawn-dock';
    Object.assign(this.dockRoot.style, {
      position: 'fixed',
      bottom: '14px',
      left: '14px',
      zIndex: '25',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '8px',
      fontFamily: MONO_FONT,
      pointerEvents: 'none',
    });

    this.popupEl = this.buildPopup();
    this.dockRoot.appendChild(this.popupEl);

    const triggerRow = document.createElement('div');
    Object.assign(triggerRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      pointerEvents: 'auto',
    });

    this.addButton = document.createElement('button');
    this.addButton.id = 'vehicle-add-button';
    this.addButton.type = 'button';
    this.addButton.innerHTML =
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#38bdf8;color:#082f49;font-weight:900;font-size:14px;line-height:1;">+</span><span>Add +</span>';
    Object.assign(this.addButton.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 14px',
      borderRadius: '999px',
      border: '1px solid rgba(56, 189, 248, 0.55)',
      background: 'rgba(13, 17, 23, 0.90)',
      backdropFilter: 'blur(10px)',
      color: '#f8fafc',
      fontFamily: MONO_FONT,
      fontSize: '12.5px',
      fontWeight: '700',
      letterSpacing: '0.03em',
      cursor: 'pointer',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    });
    this.stopPointerPropagation(this.addButton);
    this.addButton.addEventListener('click', () => {
      this.setPopupOpen(!this.popupOpen);
    });
    triggerRow.appendChild(this.addButton);

    this.activeActionsRow = document.createElement('div');
    Object.assign(this.activeActionsRow.style, {
      display: 'none',
      alignItems: 'center',
      gap: '6px',
    });

    this.enterExitBtn = this.makePillButton('Exit Car [F]', () => {
      this.options.onToggleExitCar();
    });
    this.enterExitBtn.id = 'toggle-exit-car-btn';
    this.resetBtn = this.makePillButton('Road [R]', () => {
      this.options.onResetToRoad();
    });
    this.despawnBtn = this.makePillButton('Remove', () => {
      this.options.onDespawnVehicle();
    });
    this.despawnBtn.style.borderColor = 'rgba(248, 113, 113, 0.45)';
    this.despawnBtn.style.color = '#fca5a5';

    this.activeActionsRow.append(
      this.enterExitBtn,
      this.resetBtn,
      this.despawnBtn,
    );
    triggerRow.appendChild(this.activeActionsRow);
    this.dockRoot.appendChild(triggerRow);
    container.appendChild(this.dockRoot);

    // 2. Bottom-Center Camera POV + FOV Bar
    this.povBarEl = this.buildPovBar();
    container.appendChild(this.povBarEl);

    // 3. Bottom-Right Digital Speed / Gear / RPM Gauge
    const gauge = this.buildGauge();
    this.gaugeEl = gauge.root;
    this.speedValueEl = gauge.speedEl;
    this.speedUnitEl = gauge.unitEl;
    this.gearValueEl = gauge.gearEl;
    this.streetValueEl = gauge.streetEl;
    this.rpmFillEl = gauge.rpmFillEl;
    container.appendChild(this.gaugeEl);

    this.syncColorButtons();
    this.syncPovAndFovButtons();
  }

  public isPopupOpen(): boolean {
    return this.popupOpen;
  }

  public setPopupOpen(open: boolean): void {
    this.popupOpen = open;
    this.popupEl.style.display = open ? 'flex' : 'none';
    this.addButton.style.background = open
      ? 'rgba(14, 116, 144, 0.85)'
      : 'rgba(13, 17, 23, 0.90)';
  }

  public setVehicleActive(active: boolean): void {
    this.hasVehicle = active;
    this.activeActionsRow.style.display = active ? 'flex' : 'none';
    this.povBarEl.style.display = active ? 'flex' : 'none';
    this.gaugeEl.style.display = active ? 'block' : 'none';
  }

  public setVisible(visible: boolean): void {
    this.dockRoot.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      this.povBarEl.style.display = 'none';
      this.gaugeEl.style.display = 'none';
    } else if (this.hasVehicle) {
      this.povBarEl.style.display = 'flex';
      this.gaugeEl.style.display = 'block';
    }
  }

  public setCameraState(mode: CameraPovMode, fovDeg: number): void {
    this.activePov = mode;
    this.activeFov = fovDeg;
    this.syncPovAndFovButtons();
  }

  public updateTelemetry(telemetry: VehicleTelemetry): void {
    if (!this.hasVehicle) {
      return;
    }
    this.speedometer.update(Math.abs(telemetry.signedSpeedMps));
    const gearNum =
      telemetry.gearLabel === 'R'
        ? -1
        : parseInt(telemetry.gearLabel.replace(/\D/g, ''), 10) || 1;
    this.tachometer.update(telemetry.engineRpm, gearNum);

    if (telemetry.onFoot) {
      this.enterExitBtn.textContent = 'Enter Car [F]';
      this.speedValueEl.textContent = 'WALK';
      this.speedUnitEl.textContent = '';
      this.gearValueEl.textContent = 'ON FOOT';
      this.rpmFillEl.style.width = '18%';
    } else {
      this.enterExitBtn.textContent = 'Exit Car [F]';
      this.speedValueEl.textContent = `${Math.round(this.speedometer.getSpeedKmh())}`;
      this.speedUnitEl.textContent = ' km/h';
      this.gearValueEl.textContent = telemetry.gearLabel;
      const rpmPct = Math.min(
        100,
        Math.max(8, ((this.tachometer.getRpm() - 750) / 5750) * 100),
      );
      this.rpmFillEl.style.width = `${rpmPct.toFixed(1)}%`;
    }

    const street = telemetry.streetName ?? 'Toronto Road Network';
    const surfaceTag = telemetry.onRoad ? '' : ' · OFF ROAD';
    this.streetValueEl.textContent = `${street} · ${telemetry.speedLimitKmh} km/h${surfaceTag}`;
  }

  private buildPopup(): HTMLDivElement {
    const popup = document.createElement('div');
    popup.id = 'vehicle-selection-popup';
    Object.assign(popup.style, {
      display: 'none',
      flexDirection: 'column',
      gap: '10px',
      width: '305px',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(13, 17, 23, 0.94)',
      border: '1px solid rgba(56, 189, 248, 0.40)',
      backdropFilter: 'blur(12px)',
      color: '#e2e8f0',
      boxShadow: '0 14px 36px rgba(0, 0, 0, 0.55)',
      pointerEvents: 'auto',
    });
    this.stopPointerPropagation(popup);

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    });
    const title = document.createElement('span');
    title.textContent = 'SPAWN VEHICLE';
    Object.assign(title.style, {
      fontSize: '11px',
      fontWeight: '800',
      letterSpacing: '0.08em',
      color: '#38bdf8',
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#94a3b8',
      fontSize: '17px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 4px',
    });
    closeBtn.addEventListener('click', () => this.setPopupOpen(false));
    header.append(title, closeBtn);
    popup.appendChild(header);

    // Paint swatches
    const swatchRow = document.createElement('div');
    Object.assign(swatchRow.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '4px 0',
      borderBottom: '1px solid rgba(148, 163, 184, 0.16)',
    });
    const swatchLabel = document.createElement('span');
    swatchLabel.textContent = 'Paint';
    swatchLabel.style.fontSize = '11px';
    swatchLabel.style.color = '#94a3b8';
    const swatchDots = document.createElement('div');
    Object.assign(swatchDots.style, { display: 'flex', gap: '6px' });

    for (const colorOpt of VEHICLE_PAINT_OPTIONS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.title = colorOpt.label;
      Object.assign(dot.style, {
        width: '18px',
        height: '18px',
        borderRadius: '50%',
        background: colorOpt.css,
        cursor: 'pointer',
        padding: '0',
      });
      dot.addEventListener('click', () => {
        this.selectedColorId = colorOpt.id;
        this.syncColorButtons();
        this.options.onSelectColor(colorOpt.id);
      });
      this.colorButtons.set(colorOpt.id, dot);
      swatchDots.appendChild(dot);
    }
    swatchRow.append(swatchLabel, swatchDots);
    popup.appendChild(swatchRow);

    // Selectable car cards
    for (const vehicle of VEHICLE_CATALOG) {
      const card = document.createElement('button');
      card.id = `spawn-card-${vehicle.id}`;
      card.type = 'button';
      Object.assign(card.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        textAlign: 'left',
        padding: '10px',
        borderRadius: '9px',
        border: '1px solid rgba(56, 189, 248, 0.35)',
        background: 'rgba(30, 41, 59, 0.65)',
        color: '#f8fafc',
        fontFamily: MONO_FONT,
        cursor: 'pointer',
      });
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:13px;font-weight:700;">${vehicle.name}</span>
          <span style="font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(56,189,248,0.18);color:#7dd3fc;">${vehicle.category}</span>
        </div>
        <svg viewBox="0 0 180 54" style="width:100%;height:46px;margin:2px 0;">
          <path d="M16 36 L22 24 L54 22 L76 10 L128 10 L152 23 L166 26 L166 36 Z" fill="#2563eb" stroke="#93c5fd" stroke-width="1.5"/>
          <path d="M59 22 L78 13 L123 13 L143 22 Z" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
          <circle cx="48" cy="38" r="9.5" fill="#0f172a" stroke="#cbd5e1" stroke-width="2"/>
          <circle cx="136" cy="38" r="9.5" fill="#0f172a" stroke="#cbd5e1" stroke-width="2"/>
        </svg>
        <div style="font-size:10.5px;color:#cbd5e1;">${vehicle.tagline}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:#94a3b8;padding-top:4px;border-top:1px solid rgba(148,163,184,0.15);">
          <span>${vehicle.dimensions.lengthMeters.toFixed(2)}m × ${vehicle.dimensions.widthMeters.toFixed(2)}m</span>
          <span style="color:#38bdf8;font-weight:700;">Click to Spawn →</span>
        </div>
      `;
      card.addEventListener('click', () => {
        this.options.onSpawnVehicle(vehicle.id, this.selectedColorId);
        this.setPopupOpen(false);
      });
      popup.appendChild(card);
    }

    return popup;
  }

  private buildPovBar(): HTMLDivElement {
    const bar = document.createElement('div');
    bar.id = 'pov-controls-bar';
    Object.assign(bar.style, {
      position: 'fixed',
      bottom: '14px',
      left: 'calc(50% + 46px)',
      transform: 'translateX(-50%)',
      zIndex: '24',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
      padding: '6px 9px',
      borderRadius: '11px',
      background: 'rgba(13, 17, 23, 0.86)',
      border: '1px solid rgba(148, 163, 184, 0.28)',
      backdropFilter: 'blur(10px)',
      fontFamily: MONO_FONT,
      fontSize: '10.5px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.42)',
    });
    this.stopPointerPropagation(bar);

    const povRow = document.createElement('div');
    Object.assign(povRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      flexWrap: 'wrap',
      justifyContent: 'center',
    });

    const povLabel = document.createElement('span');
    povLabel.textContent = 'POV [V]';
    povLabel.style.color = '#94a3b8';
    povLabel.style.fontWeight = '700';
    povLabel.style.marginRight = '2px';
    povRow.appendChild(povLabel);

    for (const pov of CAMERA_POV_LIST) {
      const btn = this.makePillButton(pov.label, () => {
        this.options.onSelectPov(pov.id);
      });
      btn.id = `pov-btn-${pov.id}`;
      btn.style.padding = '3px 7px';
      btn.style.fontSize = '10.5px';
      this.povButtons.set(pov.id, btn);
      povRow.appendChild(btn);
    }

    const fovRow = document.createElement('div');
    Object.assign(fovRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      paddingTop: '4px',
      borderTop: '1px solid rgba(148, 163, 184, 0.16)',
    });

    const fovLabel = document.createElement('span');
    fovLabel.textContent = 'FOV [ [ / ] ]';
    fovLabel.style.color = '#94a3b8';
    fovLabel.style.fontWeight = '700';
    fovLabel.style.marginRight = '2px';
    fovRow.appendChild(fovLabel);

    for (const fov of FOV_PRESETS) {
      const btn = this.makePillButton(`${fov}°`, () => {
        this.options.onSelectFov(fov);
      });
      btn.id = `fov-btn-${fov}`;
      this.fovButtons.set(fov, btn);
      fovRow.appendChild(btn);
    }

    bar.append(povRow, fovRow);
    return bar;
  }

  private buildGauge(): {
    root: HTMLDivElement;
    speedEl: HTMLSpanElement;
    unitEl: HTMLSpanElement;
    gearEl: HTMLSpanElement;
    streetEl: HTMLDivElement;
    rpmFillEl: HTMLDivElement;
  } {
    const root = document.createElement('div');
    root.id = 'vehicle-gauge-hud';
    Object.assign(root.style, {
      position: 'fixed',
      bottom: '14px',
      right: '14px',
      zIndex: '24',
      display: 'none',
      minWidth: '215px',
      padding: '10px 14px',
      borderRadius: '11px',
      background: 'rgba(13, 17, 23, 0.88)',
      border: '1px solid rgba(148, 163, 184, 0.28)',
      backdropFilter: 'blur(10px)',
      color: '#f8fafc',
      fontFamily: MONO_FONT,
      pointerEvents: 'none',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.42)',
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '12px',
    });

    const speedWrap = document.createElement('div');
    const speedEl = document.createElement('span');
    speedEl.textContent = '0';
    Object.assign(speedEl.style, {
      fontSize: '26px',
      fontWeight: '800',
      letterSpacing: '-0.02em',
    });
    const unitEl = document.createElement('span');
    unitEl.textContent = ' km/h';
    unitEl.style.fontSize = '11px';
    unitEl.style.color = '#94a3b8';
    speedWrap.append(speedEl, unitEl);

    const gearEl = document.createElement('span');
    gearEl.textContent = 'P';
    Object.assign(gearEl.style, {
      fontSize: '13px',
      fontWeight: '800',
      padding: '2px 8px',
      borderRadius: '6px',
      background: 'rgba(56, 189, 248, 0.18)',
      color: '#38bdf8',
    });

    topRow.append(speedWrap, gearEl);
    root.appendChild(topRow);

    const rpmTrack = document.createElement('div');
    Object.assign(rpmTrack.style, {
      height: '5px',
      borderRadius: '999px',
      background: 'rgba(51, 65, 85, 0.75)',
      overflow: 'hidden',
      margin: '6px 0',
    });
    const rpmFillEl = document.createElement('div');
    Object.assign(rpmFillEl.style, {
      height: '100%',
      width: '12%',
      background: 'linear-gradient(90deg, #38bdf8, #22d3ee, #f59e0b)',
      transition: 'width 60ms linear',
    });
    rpmTrack.appendChild(rpmFillEl);
    root.appendChild(rpmTrack);

    const streetEl = document.createElement('div');
    streetEl.textContent = 'Toronto Road Network';
    Object.assign(streetEl.style, {
      fontSize: '10.5px',
      color: '#cbd5e1',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '230px',
    });
    root.appendChild(streetEl);

    const controlsHint = document.createElement('div');
    controlsHint.textContent = 'WASD Drive · Space Brake · [ ] FOV';
    Object.assign(controlsHint.style, {
      fontSize: '10px',
      color: '#64748b',
      marginTop: '3px',
    });
    root.appendChild(controlsHint);

    return { root, speedEl, unitEl, gearEl, streetEl, rpmFillEl };
  }

  private makePillButton(
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '5px 10px',
      borderRadius: '999px',
      border: '1px solid rgba(148, 163, 184, 0.3)',
      background: 'rgba(30, 41, 59, 0.75)',
      color: '#cbd5e1',
      fontFamily: MONO_FONT,
      fontSize: '11px',
      fontWeight: '700',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });
    this.stopPointerPropagation(btn);
    btn.addEventListener('click', onClick);
    return btn;
  }

  private stopPointerPropagation(el: HTMLElement): void {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
  }

  private syncColorButtons(): void {
    for (const [id, btn] of this.colorButtons.entries()) {
      const selected = id === this.selectedColorId;
      btn.style.border = selected ? '2px solid #f8fafc' : '1px solid rgba(255,255,255,0.28)';
      btn.style.transform = selected ? 'scale(1.15)' : 'scale(1)';
    }
  }

  private syncPovAndFovButtons(): void {
    for (const [mode, btn] of this.povButtons.entries()) {
      const active = mode === this.activePov;
      btn.style.background = active
        ? 'rgba(14, 165, 233, 0.28)'
        : 'rgba(30, 41, 59, 0.75)';
      btn.style.borderColor = active
        ? '#38bdf8'
        : 'rgba(148, 163, 184, 0.25)';
      btn.style.color = active ? '#e0f2fe' : '#cbd5e1';
    }
    for (const [fov, btn] of this.fovButtons.entries()) {
      const active = Math.abs(this.activeFov - fov) <= 2;
      btn.style.background = active
        ? 'rgba(14, 165, 233, 0.28)'
        : 'rgba(30, 41, 59, 0.75)';
      btn.style.borderColor = active
        ? '#38bdf8'
        : 'rgba(148, 163, 184, 0.25)';
      btn.style.color = active ? '#e0f2fe' : '#cbd5e1';
    }
  }
}
