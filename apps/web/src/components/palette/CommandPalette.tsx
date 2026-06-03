"use client";

import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import { usePaletteController } from "./usePaletteController";
import PaletteSurface from "./PaletteSurface";
import PaletteSheet from "./PaletteSheet";

export default function CommandPalette() {
  const controller = usePaletteController();
  const isMobile = useIsMobileViewport();
  // On mobile, the Android/browser back button closes the palette (C7). Owned here
  // (always mounted) so every close path pops the synthetic entry exactly once.
  useHistoryDismiss(controller.open && isMobile, controller.close);
  if (!controller.open) return null;
  return isMobile ? (
    <PaletteSheet controller={controller} />
  ) : (
    <PaletteSurface controller={controller} />
  );
}
