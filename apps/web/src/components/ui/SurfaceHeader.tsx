"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type MouseEventHandler } from "react";
import MediaActions from "@/components/media/MediaActions";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { PaneChrome } from "@/lib/panes/paneChrome";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {
  useMobileChrome,
  useMobileChromeState,
  useMobileChromeSurface,
} from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import type { PaneCompanionAction, PanePrimaryAction } from "@/lib/panes/paneChrome";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import Button from "./Button";
import ButtonLink from "./ButtonLink";
import OverflowMenuButton from "./OverflowMenuButton";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
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
 * icon-only Inspector. Desktop: the pane's top row. Mobile: a stationary frame
 * around the hideable top bar, after its visually hidden recovery toggle.
 */
export default function SurfaceHeader({
  projection,
  header,
  identityId,
  primaryAction,
  mediaActions,
  mediaRoute = false,
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
  mediaActions?: PaneChrome["mediaActions"];
  mediaRoute?: boolean;
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
  const paneId = usePaneRuntime()?.paneId;
  const mobile = projection === "Mobile";
  const frameRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLElement>(null);
  const viewport = useMobileViewport();
  const mobileChrome = useMobileChrome();
  const visibility = useMobileChromeState();
  useMobileChromeSurface(ref, mobile);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const surface = ref.current;
    if (!mobile || !frame || !surface) return;
    return viewport.registerTopSurface("Header", frame, surface);
  }, [mobile, viewport]);
  const recovery = mobile && visibility !== null ? RECOVERY[visibility] : null;
  const actions = [...paneActions, ...menuActions];
  const companionState =
    companion && projectActionControlState(companion.label, companion.state);
  const primary = primaryAction?.action;
  const primaryState = primary && projectActionControlState(
    primary.label, primary.kind === "command" ? primary.state : undefined,
  );

  const scope = mobile ? "" : " in this pane";
  return (
    <>
      {recovery ? (
        <Button
          className={cx("sr-only", styles.readerChromeToggle)}
          aria-expanded={recovery.expanded}
          disabled={recovery.disabled}
          onClick={mobileChrome.toggleReaderChrome}
        >
          {recovery.label}
        </Button>
      ) : null}
      <div ref={frameRef} className={mobile ? styles.mobileFrame : styles.frame}>
        <header
          ref={ref}
          className={mobile ? styles.mobile : styles.header}
          onMouseDown={onMouseDown}
          data-media-header={mediaRoute || undefined}
        >
          <div className={styles.navigation}>
            <Button
              iconOnly
              icon={<ChevronLeft />}
              className={styles.navigationButton}
              onClick={navigation.onBack}
              disabled={!navigation.canGoBack}
              aria-label={`Go back${scope}`}
            />
            <Button
              iconOnly
              icon={<ChevronRight />}
              className={styles.navigationButton}
              onClick={navigation.onForward}
              disabled={!navigation.canGoForward}
              aria-label={`Go forward${scope}`}
            />
          </div>
          <div className={styles.identity}>
            <PaneHeaderIdentity
              id={identityId}
              model={header}
              projection={projection}
            />
          </div>
          <div className={styles.trailing}>
            {mediaActions ? (
              <MediaActions
                subject={mediaActions.subject}
                knownDescriptor={mediaActions.knownDescriptor}
                density="Header"
                returnFocus={() => findPaneLandmarkFocusTarget(paneId)}
              />
            ) : null}
            {primaryAction && primary && primaryState ? (
              <>
                {primary.kind === "link" ? (
                  <ButtonLink
                    href={primary.href}
                    iconOnly
                    icon={primary.icon}
                    className={styles.headerButton}
                    aria-label={primary.label}
                    aria-disabled={primary.disabled || undefined}
                    aria-describedby={primary.disabledReason ? reasonId : undefined}
                    tooltip={{ text: primary.disabledReason ? `${primary.label}: ${primary.disabledReason}` : primary.label }}
                    data-action-id={primary.id}
                    data-workspace-rich-target="true"
                    onClick={primaryAction.onActivate}
                    onKeyDown={primaryAction.onActivate}
                  />
                ) : (
                  <Button
                    iconOnly
                    icon={primary.icon}
                    className={styles.headerButton}
                    tone={primary.tone === "danger" ? "danger" : undefined}
                    aria-label={primary.label}
                    aria-disabled={primary.disabled || undefined}
                    aria-describedby={primary.disabledReason ? reasonId : undefined}
                    aria-pressed={primaryState.barPressed}
                    aria-expanded={primaryState.barExpanded}
                    aria-controls={primaryState.barControls}
                    tooltip={{ text: primary.disabledReason ? `${primary.label}: ${primary.disabledReason}` : primary.label }}
                    data-action-id={primary.id}
                    onClick={primaryAction.onActivate}
                    onKeyDown={primaryAction.onActivate}
                  />
                )}
                {primary.disabledReason ? <span id={reasonId} className="sr-only">{primary.disabledReason}</span> : null}
              </>
            ) : null}
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
                  <span className={styles.overflow}>
                    <OverflowMenuButton
                      {...props}
                      className={mobile ? styles.mobileOverflow : undefined}
                    />
                    {actions.some(action => action.indicator?.kind === "Status") ? (
                      <span className={styles.statusMarker} aria-hidden="true" />
                    ) : null}
                  </span>
                )}
              />
            ) : null}
            {companion && companionState ? (
              <Button
                iconOnly
                icon={companion.icon}
                className={styles.headerButton}
                disabled={companion.disabled}
                aria-label={companion.label}
                aria-expanded={companionState.barExpanded}
                aria-controls={companionState.barControls}
                tooltip={{ text: companionState.menuLabel }}
                data-action-id={companion.id}
                onClick={(event) => {
                  event.stopPropagation();
                  companion.onSelect({ triggerEl: event.currentTarget, openIntent: "default" });
                }}
              />
            ) : null}
          </div>
        </header>
      </div>
    </>
  );
}
