import type { ReactElement, ReactNode } from "react";
import type { TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "./targetActivation";

export interface ActionTriggerDetail {
  readonly triggerEl: HTMLButtonElement | null;
}
export interface ActionSelectDetail extends ActionTriggerDetail {
  readonly openIntent: OpenIntent;
}

/** Command presenters own native activation and pass only frozen intent onward. */
export function prepareActionSelect(
  event: TargetActivationEvent,
  triggerEl: HTMLButtonElement | null,
): ActionSelectDetail | null {
  const activation = workspaceTargetActivationIntent(event);
  if (activation.kind === "Unowned") return null;
  event.preventDefault();
  return activation.kind === "Consume" ? null : { triggerEl, openIntent: activation.intent };
}

type DisclosureLabels = {
  readonly collapsed: string;
  readonly expanded: string;
};

export type ActionControlState =
  | { readonly kind: "toggle"; readonly pressed: boolean }
  | {
      readonly kind: "disclosure";
      readonly expanded: false;
      readonly controls?: never;
      readonly menuLabels: DisclosureLabels;
    }
  | {
      readonly kind: "disclosure";
      readonly expanded: true;
      readonly controls: string;
      readonly menuLabels: DisclosureLabels;
    };

/** A control state as a menu item's role and label and as a bar button's aria. */
export function projectActionControlState(
  label: string,
  state: ActionControlState | undefined,
): {
  readonly menuLabel: string;
  readonly menuRole: "menuitem" | "menuitemcheckbox";
  readonly menuChecked?: boolean;
  readonly barPressed?: boolean;
  readonly barExpanded?: boolean;
  readonly barControls?: string;
  readonly active: boolean;
} {
  if (state?.kind === "toggle") {
    const pressed = state.pressed;
    return {
      menuLabel: label,
      menuRole: "menuitemcheckbox",
      menuChecked: pressed,
      barPressed: pressed,
      active: pressed,
    };
  }
  if (state?.kind === "disclosure") {
    const { expanded } = state;
    return {
      menuLabel: expanded
        ? state.menuLabels.expanded
        : state.menuLabels.collapsed,
      menuRole: "menuitem",
      barExpanded: expanded,
      barControls: expanded ? state.controls : undefined,
      active: expanded,
    };
  }
  return { menuLabel: label, menuRole: "menuitem", active: false };
}

interface ActionBase {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactElement;
  readonly indicator?: { readonly kind: "Status" };
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly tone?: "default" | "danger";
  readonly separatorBefore?: boolean;
}

/** One command shape for menus and the pane chrome: run a command, follow a link, or render custom controls. */
export type ActionDescriptor =
  | (ActionBase & {
      readonly kind: "command";
      readonly onSelect: (detail: ActionSelectDetail) => void;
      readonly state?: ActionControlState;
      readonly restoreFocusOnClose?: boolean;
      readonly href?: never;
      readonly render?: never;
    })
  | (ActionBase & {
      readonly kind: "link";
      readonly href: string;
      readonly onActivate?: (event: TargetActivationEvent) => TargetLinkActivationResult;
      readonly restoreFocusOnClose?: boolean;
      readonly state?: never;
      readonly render?: never;
    })
  | (ActionBase & {
      readonly kind: "custom";
      readonly render: (
        controls: ActionTriggerDetail & {
          readonly closeMenu: () => void;
          readonly closeMenuWithoutFocus: () => void;
          /** The presenter owns menu arrow focus or the bar's native tab stops. */
          readonly presentation: "menu" | "bar";
        },
      ) => ReactNode;
      readonly href?: never;
      readonly onSelect?: never;
      readonly restoreFocusOnClose?: never;
      readonly state?: never;
    });
