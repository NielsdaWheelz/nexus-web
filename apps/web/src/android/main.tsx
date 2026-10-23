// Installed document entry. Resource and workspace behavior belong to shared
// owners; this entry supplies only immutable assets and the host environment.
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "./fonts.css";
import { SolarEffects } from "@/components/theme/SolarEffects";
import DeviceWorkspace from "@/lib/native/DeviceWorkspace";
import { HostPolicyProvider, installedHostPolicy, type HostImageProps } from "@/lib/host/policy";
import { NAV_COLLAPSED_COOKIE, type RenderEnvironment } from "@/lib/renderEnvironment/types";
import { parseRoom, ROOM_CHROME } from "@/lib/theme/room";

const theme = parseRoom(document.documentElement.dataset.theme);
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ROOM_CHROME[theme]);
const environment: RenderEnvironment = {
  androidShell: true,
  platform: "android",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: new Date().toISOString(),
  navCollapsed: document.cookie.split(";").some(value => value.trim() === `${NAV_COLLAPSED_COOKIE}=1`),
};
const OriginalImage = installedHostPolicy.Image;
function PackagedImage(props: HostImageProps) {
  const src = props.src.startsWith("/brand/") || props.src.startsWith("/oracle-plates/")
    ? `/_nexus/app${props.src}` : props.src;
  return <OriginalImage {...props} src={src} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("installed application root missing");
createRoot(root).render(
  <HostPolicyProvider value={{ ...installedHostPolicy, Image: PackagedImage }}>
    <SolarEffects />
    <DeviceWorkspace renderEnvironment={environment} />
  </HostPolicyProvider>,
);
