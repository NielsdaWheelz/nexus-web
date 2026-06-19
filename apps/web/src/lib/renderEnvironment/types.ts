export type PlatformKind =
  | "mac"
  | "ios"
  | "android"
  | "windows"
  | "linux"
  | "other";

export type ViewportKind = "desktop" | "mobile";

export interface RenderEnvironment {
  androidShell: boolean;
  platform: PlatformKind;
  displayLocale: string;
  displayTimeZone: string;
  currentInstant: string;
  currentLocalDate: string;
  initialViewport: ViewportKind;
}
