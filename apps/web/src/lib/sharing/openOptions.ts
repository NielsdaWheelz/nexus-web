import { present } from "@/lib/api/presence";
import type { ShareOpenOptions } from "@/lib/sharing/types";

export function anchoredShareOpenOptions(
  triggerEl: HTMLButtonElement | null,
  fallback: () => HTMLElement | null,
): ShareOpenOptions {
  return {
    returnFocusTo: () => triggerEl,
    returnFocusFallback: present(fallback),
  };
}
