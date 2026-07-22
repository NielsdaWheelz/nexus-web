import type { ReactElement, ReactNode } from "react";

export interface ActionSelectDetail {
  readonly triggerEl: HTMLButtonElement | null;
}

interface ActionRenderControls extends ActionSelectDetail {
  readonly closeMenu: () => void;
  readonly closeMenuWithoutFocus: () => void;
}

export type ActionControlState =
  | { readonly kind: "toggle"; readonly pressed: boolean }
  | {
      readonly kind: "disclosure";
      readonly expanded: false;
      readonly controls?: never;
      readonly menuLabels: {
        readonly collapsed: string;
        readonly expanded: string;
      };
    }
  | {
      readonly kind: "disclosure";
      readonly expanded: true;
      readonly controls: string;
      readonly menuLabels: {
        readonly collapsed: string;
        readonly expanded: string;
      };
    };

interface ActionControlProjection {
  readonly menuLabel: string;
  readonly menuRole: "menuitem" | "menuitemcheckbox";
  readonly menuChecked: boolean | undefined;
  readonly barPressed: boolean | undefined;
  readonly barExpanded: boolean | undefined;
  readonly barControls: string | undefined;
  readonly active: boolean;
}

export function projectActionControlState(
  label: string,
  state: ActionControlState | undefined,
): ActionControlProjection {
  if (!state) {
    return {
      menuLabel: label,
      menuRole: "menuitem",
      menuChecked: undefined,
      barPressed: undefined,
      barExpanded: undefined,
      barControls: undefined,
      active: false,
    };
  }
  switch (state.kind) {
    case "toggle":
      return {
        menuLabel: label,
        menuRole: "menuitemcheckbox",
        menuChecked: state.pressed,
        barPressed: state.pressed,
        barExpanded: undefined,
        barControls: undefined,
        active: state.pressed,
      };
    case "disclosure":
      return {
        menuLabel:
          state.menuLabels[state.expanded ? "expanded" : "collapsed"],
        menuRole: "menuitem",
        menuChecked: undefined,
        barPressed: undefined,
        barExpanded: state.expanded,
        barControls: state.expanded ? state.controls : undefined,
        active: state.expanded,
      };
    default: {
      const exhaustive: never = state;
      throw new Error(
        `Unhandled action control state: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

interface ActionDescriptorBase {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactElement;
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger";
  readonly separatorBefore?: boolean;
}

interface ActionCommandDescriptor extends ActionDescriptorBase {
  readonly kind: "command";
  readonly onSelect: (detail: ActionSelectDetail) => void;
  readonly state?: ActionControlState;
  readonly restoreFocusOnClose?: boolean;
  readonly href?: never;
  readonly render?: never;
}

interface ActionLinkDescriptor extends ActionDescriptorBase {
  readonly kind: "link";
  readonly href: string;
  readonly onSelect?: (detail: ActionSelectDetail) => void;
  readonly restoreFocusOnClose?: boolean;
  readonly state?: never;
  readonly render?: never;
}

interface ActionCustomDescriptor extends ActionDescriptorBase {
  readonly kind: "custom";
  readonly render: (controls: ActionRenderControls) => ReactNode;
  readonly href?: never;
  readonly onSelect?: never;
  readonly restoreFocusOnClose?: never;
  readonly state?: never;
}

export type ActionDescriptor =
  | ActionCommandDescriptor
  | ActionLinkDescriptor
  | ActionCustomDescriptor;

type RequireIcon<Descriptor extends ActionDescriptor> = Descriptor extends ActionDescriptor
  ? Omit<Descriptor, "icon"> & { readonly icon: ReactElement }
  : never;

export type PaneHeaderAction = RequireIcon<ActionDescriptor>;
