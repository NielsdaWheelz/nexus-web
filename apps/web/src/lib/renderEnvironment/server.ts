import "server-only";

import { cookies, headers } from "next/headers";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import {
  NAV_COLLAPSED_COOKIE,
  type PlatformKind,
  type RenderEnvironment,
} from "./types";

function platformOf(userAgent: string): PlatformKind {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Mac/.test(userAgent)) return "mac";
  if (/Android/.test(userAgent)) return "android";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux/.test(userAgent)) return "linux";
  return "other";
}

/** Display locale and zone are fixed (en-US, UTC) so server and client format identically. */
export async function loadRenderEnvironment(): Promise<RenderEnvironment> {
  const userAgent = (await headers()).get("user-agent") ?? "";
  return {
    androidShell: isAndroidShellUserAgent(userAgent),
    platform: platformOf(userAgent),
    displayLocale: "en-US",
    displayTimeZone: "UTC",
    currentInstant: new Date().toISOString(),
    navCollapsed: (await cookies()).get(NAV_COLLAPSED_COOKIE)?.value === "1",
  };
}
