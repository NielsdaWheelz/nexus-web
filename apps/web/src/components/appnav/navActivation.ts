import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";

export interface AppNavActivationEvent {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  preventDefault(): void;
  shiftKey: boolean;
}

/**
 * Focus ownership after an app-navigation activation:
 *
 * - source-focus: the destination was already active, so the closing nav surface
 *   must restore its trigger;
 * - destination-focus: opening/reactivating another pane transfers focus there;
 * - unhandled: the browser owns the original link gesture.
 */
export type HandledAppNavActivation =
  | "handled-source-focus"
  | "handled-destination-focus";
export type AppNavActivationResult = "unhandled" | HandledAppNavActivation;

/**
 * Intercept only a plain primary-button activation of a supported app route.
 * Modified and non-primary clicks remain native browser link gestures.
 */
export function handleAppNavLinkActivation(
  event: AppNavActivationEvent,
  href: string,
  activate: (href: string) => HandledAppNavActivation,
): AppNavActivationResult {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    resolvePaneRouteModel(href).id === "unsupported"
  ) {
    return "unhandled";
  }

  event.preventDefault();
  return activate(href);
}
