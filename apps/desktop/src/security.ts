import type { BrowserWindow, Session } from "electron";

export function hardenRenderer(
  window: BrowserWindow,
  runtimeOrigin: () => string,
  bootstrapUrl: string
): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, runtimeOrigin(), bootstrapUrl))
      event.preventDefault();
  });
}

export function denyRendererPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
}

export function isAllowedNavigation(
  url: string,
  runtimeOrigin: string,
  bootstrapUrl: string
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const allowed = new URL(bootstrapUrl);
      return (
        parsed.protocol === allowed.protocol &&
        parsed.pathname === allowed.pathname
      );
    }
    return Boolean(runtimeOrigin) && parsed.origin === runtimeOrigin;
  } catch {
    return false;
  }
}
