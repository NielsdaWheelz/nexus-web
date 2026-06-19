import "server-only";

import { headers } from "next/headers";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import type { PlatformKind, RenderEnvironment } from "./types";

function platformFromUserAgent(userAgent: string): PlatformKind {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Mac/.test(userAgent)) return "mac";
  if (/Android/.test(userAgent)) return "android";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux/.test(userAgent)) return "linux";
  return "other";
}

export async function loadRenderEnvironment(): Promise<RenderEnvironment> {
  const userAgent = (await headers()).get("user-agent") ?? "";
  const displayLocale = "en-US";
  const displayTimeZone = "UTC";
  const now = new Date();
  return {
    androidShell: isAndroidShellUserAgent(userAgent),
    platform: platformFromUserAgent(userAgent),
    displayLocale,
    displayTimeZone,
    currentInstant: now.toISOString(),
    currentLocalDate: formatLocalDateInTimeZone(now, displayTimeZone),
    initialViewport: "desktop",
  };
}
