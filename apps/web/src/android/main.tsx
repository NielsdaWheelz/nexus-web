// Installed document entry. Resource and workspace behavior belong to shared
// owners; this entry supplies only immutable assets and the host environment.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "@/app/globals.css";
import "@/lib/documentReader/documentReader.module.css";
import "@/app/(authenticated)/media/[id]/media.module.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "./fonts.css";
import { SolarEffects } from "@/components/theme/SolarEffects";
import ShareCapture from "@/app/share/ShareCapture";
import { Failed } from "@/components/feedback/Fact";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import shareStyles from "@/app/share/share.module.css";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import BrowserWorkspace from "@/lib/authored/BrowserWorkspace";
import { installedApp } from "@/lib/native/admission";
import { hello } from "@/lib/native/client";
import { useFailedReadRepair } from "@/lib/api/serverState";
import DeviceWorkspace from "@/lib/native/DeviceWorkspace";
import { HostPolicyProvider, installedHostPolicy, type HostImageProps } from "@/lib/host/policy";
import { NAV_COLLAPSED_COOKIE, type RenderEnvironment } from "@/lib/renderEnvironment/types";
import { parseRoom, ROOM_CHROME } from "@/lib/theme/room";

const nativeHost = "nexusAuthored" in window;
const isCapture = window.location.pathname === "/share";
const theme = parseRoom(document.documentElement.dataset.theme);
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ROOM_CHROME[theme]);
const environment: RenderEnvironment = {
  androidShell: nativeHost,
  platform: nativeHost ? "android" : /Mac|iPhone|iPad/u.test(navigator.platform) ? "mac" : /Win/u.test(navigator.platform) ? "windows" : /Linux/u.test(navigator.platform) ? "linux" : "other",
  displayLocale: navigator.language,
  displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  currentInstant: new Date().toISOString(),
  navCollapsed: document.cookie.split(";").some(value => value.trim() === `${NAV_COLLAPSED_COOKIE}=1`),
};
const OriginalImage = installedHostPolicy.Image;
function PackagedImage(props: HostImageProps) {
  const src = props.src.startsWith("/brand/") || props.src.startsWith("/oracle-plates/")
    ? `/_nexus/app${props.src}` : props.src;
  return <OriginalImage {...props} src={src} />;
}

/** Main's standalone share document still needs the native session subscription. */
function ShareDocument() {
  const [ready, setReady] = useState(!installedApp);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [opening, setOpening] = useState(installedApp);
  const [attempt, retry] = useState(0);
  useFailedReadRepair(failure !== null, opening, () => { setOpening(true); retry(value => value + 1); });
  useEffect(() => {
    if (!installedApp) return;
    let active = true;
    void hello().then(() => { if (active) { setReady(true); setFailure(null); } }, error => { if (active) setFailure(error); })
      .finally(() => { if (active) setOpening(false); });
    return () => { active = false; };
  }, [attempt]);
  if (!ready) return <FeedbackProvider shell={{ signIn: { label: "sign in", href: "nexus://auth/start" } }}>
    {failure === null ? <Ruling /> : <Failed error={failure} noun="share" retry={{ busy: opening, run: () => { setOpening(true); retry(value => value + 1); } }} />}
  </FeedbackProvider>;
  const params = new URL(location.href).searchParams;
  return <ShareCapture text={params.get("text") ?? ""} files={Number(params.get("files") ?? "0")} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("installed application root missing");
createRoot(root).render(
  <HostPolicyProvider value={{ ...installedHostPolicy, Image: PackagedImage }}>
    <SolarEffects />
    {isCapture ? <RenderEnvironmentProvider value={environment}><MobileViewportProvider><div className={shareStyles.backdrop}><main className={shareStyles.card}><ShareDocument /></main></div></MobileViewportProvider></RenderEnvironmentProvider> : installedApp ? <DeviceWorkspace renderEnvironment={environment} /> : <BrowserWorkspace renderEnvironment={environment} />}
  </HostPolicyProvider>,
);
