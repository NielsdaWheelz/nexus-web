"use client";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useRef, type KeyboardEvent, type MouseEvent, type MouseEventHandler } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {
  useMobileChrome,
  useMobileChromeState,
  useMobileChromeSurface,
} from "@/lib/mobileShell/chrome";
import type { PaneCompanionAction, PanePrimaryAction } from "@/lib/panes/paneChrome";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import Button from "./Button";
import OverflowMenuButton from "./OverflowMenuButton";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import Tooltip from "./Tooltip";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

const RECOVERY = {
  Shown: { label: "hide reader controls", expanded: true, disabled: false },
  Hidden: { label: "show reader controls", expanded: false, disabled: false },
  Held: { label: "hide reader controls", expanded: true, disabled: true },
};

/**
 * A pane's chrome bar: back and forward, the identity (which yields width
 * first), a primary action, passive subscription status, one More menu
 * (pane, view, then the resource's own actions) and the
 * icon-only Inspector. Desktop: the pane's top row. Mobile: the fixed top bar
 * the reader chrome hides and shows, after its visually hidden recovery toggle.
 */
export default function SurfaceHeader({
  projection,
  header,
  identityId,
  primaryAction,
  companionAction: companion,
  paneActions = [],
  menuActions = [],
  resourceRef,
  navigation,
  onMouseDown,
}: {
  projection: "Desktop" | "Mobile";
  header: PaneHeaderModel;
  identityId: string;
  primaryAction?: {
    readonly action: PanePrimaryAction;
    readonly onActivate: (event:
      MouseEvent<HTMLButtonElement | HTMLAnchorElement> |
      KeyboardEvent<HTMLButtonElement | HTMLAnchorElement>
    ) => void;
  };
  companionAction?: PaneCompanionAction;
  paneActions?: readonly ActionDescriptor[];
  menuActions?: readonly ActionDescriptor[];
  resourceRef?: CanonicalResourceRef;
  navigation: SurfaceHeaderNavigation;
  onMouseDown?: MouseEventHandler<HTMLElement>;
}) {
  const reasonId = useId();
  const mobile = projection === "Mobile";
  const ref = useRef<HTMLElement>(null);
  const mobileChrome = useMobileChrome();
  const visibility = useMobileChromeState();
  useMobileChromeSurface(ref, mobile);
  const recovery = mobile && visibility !== null ? RECOVERY[visibility] : null;
  const actions = [...paneActions, ...menuActions];
  const companionState =
    companion && projectActionControlState(companion.label, companion.state);
  const primary = primaryAction?.action;
  const primaryState = primary && projectActionControlState(
    primary.label, primary.kind === "command" ? primary.state : undefined,
  );
  const subscription = header.kind === "Section" && header.meta.kind === "Subscription"
    ? header.meta : null;
  const scope = mobile ? "" : " in this pane";
  return (
    <>
      {recovery ? (
        <Button
          variant="secondary"
          className={cx("sr-only", styles.readerChromeToggle)}
          aria-expanded={recovery.expanded}
          disabled={recovery.disabled}
          onClick={mobileChrome.toggleReaderChrome}
        >
          {recovery.label}
        </Button>
      ) : null}
      <header
        ref={ref}
        className={mobile ? styles.mobile : styles.header}
        onMouseDown={onMouseDown}
      >
        <div className={styles.navigation}>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={navigation.onBack}
            disabled={!navigation.canGoBack}
            aria-label={`Go back${scope}`}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.navigationButton}
            onClick={navigation.onForward}
            disabled={!navigation.canGoForward}
            aria-label={`Go forward${scope}`}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.identity}>
          <PaneHeaderIdentity
            id={identityId}
            model={header}
            projection={projection}
          />
        </div>
        <div className={styles.trailing}>
          {primaryAction && primary && primaryState ? (
            <>
              <Tooltip
                text={primary.disabledReason ? `${primary.label}: ${primary.disabledReason}` : primary.label}
                renderTrigger={(props) => {
                  const shared = {
                    ...props,
                    "aria-label": primary.label,
                    "aria-disabled": primary.disabled || undefined,
                    "aria-describedby": [props["aria-describedby"], primary.disabledReason ? reasonId : undefined].filter(Boolean).join(" ") || undefined,
                    "data-action-id": primary.id,
                    onClick: primaryAction.onActivate,
                    onKeyDown: primaryAction.onActivate,
                  };
                  const className = cx(styles.headerButton, primaryState.active && styles.pressed);
                  return primary.kind === "link" ? (
                    <Button asChild variant="ghost" size="sm" iconOnly className={className}>
                      <a
                        {...shared}
                        href={primary.href}
                        data-workspace-rich-target="true"
                        onAuxClick={(event) => { if (primary.disabled) event.preventDefault(); }}
                      >
                        {primary.icon}
                      </a>
                    </Button>
                  ) : (
                    <Button
                      {...shared}
                      variant="ghost"
                      size="sm"
                      iconOnly
                      className={className}
                      aria-pressed={primaryState.barPressed}
                      aria-expanded={primaryState.barExpanded}
                      aria-controls={primaryState.barControls}
                    >
                      {primary.icon}
                    </Button>
                  );
                }}
              />
              {primary.disabledReason ? <span id={reasonId} className="sr-only">{primary.disabledReason}</span> : null}
            </>
          ) : null}
          {subscription ? subscription.subscribed ? (
            <span className={styles.subscription}>
              <Check size={20} aria-hidden="true" />
              <span className="sr-only">subscribed</span>
            </span>
          ) : <span className="sr-only">not subscribed</span> : null}
          {actions.length > 0 || resourceRef !== undefined ? (
            <ContextualActionMenu
              title={header.title}
              subjectKey={identityId}
              label={`more actions for ${header.title}`}
              placement={mobile ? undefined : "below"}
              align={mobile ? undefined : "end"}
              sections={[
                { id: "Pane", actions: paneActions },
                { id: "View", actions: menuActions },
              ]}
              resourceRef={resourceRef}
              triggerAttributes={
                mobile ? { "data-pane-chrome-focus": "true" } : undefined
              }
              renderTrigger={(props) => (
                <OverflowMenuButton
                  {...props}
                  className={mobile ? styles.mobileOverflow : undefined}
                >
                  {actions.some(
                    (action) => action.indicator?.kind === "Status",
                  ) ? (
                    <span className={styles.statusMarker} aria-hidden="true" />
                  ) : null}
                </OverflowMenuButton>
              )}
            />
          ) : null}
          {companion && companionState ? (
            <Tooltip
              text={companionState.menuLabel}
              renderTrigger={(props) => {
                const shared = {
                  ...props,
                  disabled: companion.disabled,
                  "aria-label": companion.label,
                  "aria-expanded": companionState.barExpanded,
                  "aria-controls": companionState.barControls,
                  "data-action-id": companion.id,
                  onClick: (event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    companion.onSelect({
                      triggerEl: event.currentTarget,
                      openIntent: "default",
                    });
                  },
                };
                return (
                  <Button
                    {...shared}
                    variant="ghost"
                    size="sm"
                    iconOnly
                    className={cx(
                      styles.headerButton,
                      companionState.active && styles.pressed,
                    )}
                  >
                    {companion.icon}
                  </Button>
                );
              }}
            />
          ) : null}
        </div>
      </header>
    </>
  );
}
