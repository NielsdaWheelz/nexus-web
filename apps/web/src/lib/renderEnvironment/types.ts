export type PlatformKind =
  | "mac"
  | "ios"
  | "android"
  | "windows"
  | "linux"
  | "other";

export type ViewportKind = "desktop" | "mobile";

/** The rail's collapse, per browser: "1" collapsed, else expanded. Read on the server for first paint. */
export const NAV_COLLAPSED_COOKIE = "nexus.nav.collapsed";

export interface RenderEnvironment {
  androidShell: boolean;
  platform: PlatformKind;
  displayLocale: string;
  displayTimeZone: string;
  currentInstant: string;
  navCollapsed: boolean;
}
