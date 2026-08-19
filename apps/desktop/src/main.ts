import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, Menu, nativeImage, session } from "electron";
import { mkdir } from "node:fs/promises";
import {
  desktopUserDataRoot,
  profileDefaults,
  resolveDesktopProfile
} from "./profile.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { denyRendererPermissions, hardenRenderer } from "./security.js";
import { TrayController } from "./tray-controller.js";
import { readWindowBounds, writeWindowBounds } from "./window-state.js";

const profile = resolveDesktopProfile({
  isPackaged: app.isPackaged,
  ...(process.env.NEXUM_DESKTOP_PROFILE
    ? { environmentProfile: process.env.NEXUM_DESKTOP_PROFILE }
    : {})
});
const defaults = profileDefaults(profile);
app.setName(defaults.appName);
app.setAppUserModelId(defaults.appUserModelId);
app.setPath("userData", desktopUserDataRoot(profile));
desktopDiagnostic(
  `profile=${profile} packaged=${String(app.isPackaged)} userData=${app.getPath("userData")} stateRoot=${defaults.stateRoot}`
);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
desktopDiagnostic(`singleInstanceLock=${String(hasSingleInstanceLock)}`);
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | undefined;
let trayController: TrayController | undefined;
let quitting = false;
let runtime: RuntimeSupervisor | undefined;

if (hasSingleInstanceLock) {
  app.on("second-instance", () => showMainWindow());
  app
    .whenReady()
    .then(startDesktop)
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}

app.on("activate", () => showMainWindow());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && quitting) app.quit();
});
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", (event) => {
  if (!runtime || runtime.ownership !== "desktop") return;
  event.preventDefault();
  const owned = runtime;
  runtime = undefined;
  void owned.stopOwned().finally(() => app.exit(0));
});

async function startDesktop(): Promise<void> {
  desktopDiagnostic("app ready; starting Desktop shell");
  await mkdir(app.getPath("userData"), { recursive: true });
  const iconPath = resolve(__dirname, "..", "icons", "icon.png");
  applyDevelopmentAppIcon(iconPath);
  denyRendererPermissions(session.defaultSession);
  mainWindow = await createMainWindow(iconPath);
  setupApplicationMenu();
  trayController = new TrayController({
    appName: defaults.appName,
    profile,
    iconPath,
    showMainWindow,
    quit: quitNexum
  });
  trayController.start();

  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : resolve(__dirname, "..", "resources");
  runtime = new RuntimeSupervisor({ profile, resourcesRoot });
  runtime.on("ready", (origin: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = new URL("/", origin);
    url.searchParams.set("desktopProfile", profile);
    void mainWindow.loadURL(url.href);
    trayController?.setRuntimeOrigin(origin);
  });
  runtime.on("error", (error: Error) => {
    void showBootstrap(error.message, "error");
  });

  await showBootstrap("Starting local Runtime…");
  try {
    await runtime.ensureReady();
  } catch (error) {
    desktopDiagnostic(
      `Runtime startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    await showBootstrap(
      error instanceof Error ? error.message : String(error),
      "error"
    );
  }
}

function desktopDiagnostic(message: string): void {
  if (process.env.NEXUM_DESKTOP_DIAGNOSTICS === "1") {
    console.log(`[nexum] ${message}`);
  }
}

async function createMainWindow(iconPath: string): Promise<BrowserWindow> {
  const statePath = join(app.getPath("userData"), "window-state.json");
  const bounds = await readWindowBounds(statePath);
  const window = new BrowserWindow({
    ...bounds,
    title: defaults.appName,
    minWidth: 900,
    minHeight: 620,
    show: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  const bootstrapPath = resolve(__dirname, "..", "assets", "bootstrap.html");
  hardenRenderer(
    window,
    () => runtime?.origin ?? "",
    pathToFileURL(bootstrapPath).href
  );
  observeRendererDiagnostics(window);
  window.webContents.on("did-finish-load", () => {
    if (process.env.NEXUM_DESKTOP_DIAGNOSTICS === "1") {
      console.log(`[nexum] Desktop UI loaded: ${window.webContents.getURL()}`);
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("resized", () => {
    void writeWindowBounds(statePath, window.getBounds()).catch(
      () => undefined
    );
  });
  window.on("moved", () => {
    void writeWindowBounds(statePath, window.getBounds()).catch(
      () => undefined
    );
  });
  return window;
}

function applyDevelopmentAppIcon(iconPath: string): void {
  if (app.isPackaged || process.platform !== "darwin") return;
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

function observeRendererDiagnostics(window: BrowserWindow): void {
  if (process.env.NEXUM_DESKTOP_DIAGNOSTICS !== "1") return;
  const expectedPaths = new Set([
    "/api/v1/health",
    "/api/v1/projects",
    "/api/v1/management/state"
  ]);
  session.defaultSession.webRequest.onCompleted(
    { urls: ["<all_urls>"] },
    (details) => {
      if (
        details.webContentsId !== window.webContents.id ||
        details.statusCode >= 400
      ) {
        return;
      }
      try {
        const url = new URL(details.url);
        if (!expectedPaths.has(url.pathname)) return;
        console.log(
          `[nexum] Renderer HTTP succeeded: ${details.method} ${url.pathname} ${details.statusCode}`
        );
      } catch {
        // Ignore malformed diagnostics-only URLs.
      }
    }
  );
}

function setupApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: defaults.appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: `Quit ${defaults.appName}`,
            accelerator: "CmdOrCtrl+Q",
            click: quitNexum
          }
        ]
      },
      { role: "editMenu" },
      { role: "windowMenu" }
    ])
  );
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitNexum(): void {
  quitting = true;
  app.quit();
}

async function showBootstrap(
  message: string,
  tone: "normal" | "error" = "normal"
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadFile(
    resolve(__dirname, "..", "assets", "bootstrap.html"),
    {
      query: {
        title: defaults.appName,
        message,
        tone
      }
    }
  );
}
