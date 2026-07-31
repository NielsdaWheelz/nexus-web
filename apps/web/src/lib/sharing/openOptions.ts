import { present } from "@/lib/api/presence";
import type { ShareOpenOptions } from "@/lib/sharing/types";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

export function paneShareOpenOptions(
  triggerEl: HTMLButtonElement | null,
  paneId: string,
): ShareOpenOptions {
  return {
    returnFocusTo: () => triggerEl,
    returnFocusFallback: present(() => findPaneLandmarkFocusTarget(paneId)),
  };
}

export function anchoredShareOpenOptions(
  triggerEl: HTMLButtonElement | null,
  fallback: () => HTMLElement | null,
): ShareOpenOptions {
  return {
    returnFocusTo: () => triggerEl,
    returnFocusFallback: present(fallback),
  };
}
