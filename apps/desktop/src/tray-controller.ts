import {
  BrowserWindow,
  Menu,
  nativeImage,
  screen,
  Tray,
  type Point,
  type Rectangle
} from "electron";
import type { DesktopProfile } from "./profile.js";

const TRAY_WINDOW_SIZE = Object.freeze({ width: 360, height: 420 });
const TRAY_WINDOW_GAP = 8;
const WORK_AREA_INSET = 6;

export type TrayShellAction = "open-main" | "quit";

export class TrayController {
  readonly #appName: string;
  readonly #profile: DesktopProfile;
  readonly #iconPath: string;
  readonly #showMainWindow: () => void;
  readonly #quit: () => void;
  #origin = "";
  #tray: Tray | undefined;
  #window: BrowserWindow | undefined;

  constructor(input: {
    readonly appName: string;
    readonly profile: DesktopProfile;
    readonly iconPath: string;
    readonly showMainWindow: () => void;
    readonly quit: () => void;
  }) {
    this.#appName = input.appName;
    this.#profile = input.profile;
    this.#iconPath = input.iconPath;
    this.#showMainWindow = input.showMainWindow;
    this.#quit = input.quit;
  }

  start(): void {
    const icon = nativeImage.createFromPath(this.#iconPath);
    const trayIcon = icon.isEmpty()
      ? nativeImage.createEmpty()
      : icon.resize({ width: 18, height: 18, quality: "best" });
    this.#tray = new Tray(trayIcon);
    this.#tray.setToolTip(this.#appName);
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${this.#appName}`, click: this.#showMainWindow },
        { type: "separator" },
        { label: `Quit ${this.#appName}`, click: this.#quit }
      ])
    );

    this.#window = this.#createWindow();
    this.#tray.on("click", (_event, bounds, position) => {
      this.#toggleWindow(bounds, position);
    });
  }

  setRuntimeOrigin(origin: string): void {
    this.#origin = origin;
    if (!this.#window || this.#window.isDestroyed()) return;
    const url = new URL("/", origin);
    url.searchParams.set("surface", "menu-bar");
    url.searchParams.set("desktopProfile", this.#profile);
    void this.#window.loadURL(url.href);
  }

  #createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: TRAY_WINDOW_SIZE.width,
      height: TRAY_WINDOW_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      autoHideMenuBar: true,
      title: `${this.#appName} Menu`,
      icon: this.#iconPath,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      const action = parseTrayShellAction(url);
      if (action) {
        event.preventDefault();
        this.#runAction(action);
        return;
      }
      if (!isRuntimeNavigation(url, this.#origin)) event.preventDefault();
    });
    window.on("blur", () => window.hide());
    return window;
  }

  #toggleWindow(bounds: Rectangle, position: Point): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    if (!this.#origin) {
      this.#showMainWindow();
      return;
    }
    if (window.isVisible()) {
      window.hide();
      return;
    }
    const display = screen.getDisplayNearestPoint(position);
    const next = calculateTrayWindowPosition(
      bounds,
      display.workArea,
      TRAY_WINDOW_SIZE
    );
    window.setPosition(next.x, next.y, false);
    window.show();
    window.focus();
  }

  #runAction(action: TrayShellAction): void {
    this.#window?.hide();
    if (action === "open-main") this.#showMainWindow();
    else this.#quit();
  }
}

export function parseTrayShellAction(url: string): TrayShellAction | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "nexum-shell:") return undefined;
    if (parsed.hostname === "open-main") return "open-main";
    if (parsed.hostname === "quit") return "quit";
    return undefined;
  } catch {
    return undefined;
  }
}

export function calculateTrayWindowPosition(
  trayBounds: Rectangle,
  workArea: Rectangle,
  windowSize: { readonly width: number; readonly height: number }
): Point {
  const centerX = trayBounds.x + trayBounds.width / 2;
  const minX = workArea.x + WORK_AREA_INSET;
  const maxX = Math.max(
    minX,
    workArea.x + workArea.width - windowSize.width - WORK_AREA_INSET
  );
  const x = clamp(Math.round(centerX - windowSize.width / 2), minX, maxX);
  const below = trayBounds.y + trayBounds.height + TRAY_WINDOW_GAP;
  const above = trayBounds.y - windowSize.height - TRAY_WINDOW_GAP;
  const workBottom = workArea.y + workArea.height;
  const y =
    below + windowSize.height <= workBottom
      ? below
      : Math.max(workArea.y + WORK_AREA_INSET, above);
  return { x, y: Math.round(y) };
}

function isRuntimeNavigation(url: string, origin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
