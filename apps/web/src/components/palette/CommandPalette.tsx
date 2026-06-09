"use client";

import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaletteController } from "./usePaletteController";
import PaletteSurface from "./PaletteSurface";
import PaletteSheet from "./PaletteSheet";

export default function CommandPalette() {
  const controller = usePaletteController();
  const isMobile = useIsMobileViewport();
  return (
    <>
      {/* Stays mounted, gated by `active` (MobileSheet mount contract, C7):
          its history wiring must observe every close path. */}
      <PaletteSheet controller={controller} active={controller.open && isMobile} />
      {controller.open && !isMobile ? <PaletteSurface controller={controller} /> : null}
    </>
  );
}
