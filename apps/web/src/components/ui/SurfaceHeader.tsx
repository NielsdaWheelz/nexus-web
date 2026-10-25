"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type KeyboardEvent, type MouseEvent, type MouseEventHandler } from "react";
import { podcastTargetKey } from "@/lib/podcasts/api";
import ResourceActions from "@/components/resources/ResourceActions";
import { useMediaActions } from "@/lib/actions/useMediaActions";
import type { ResourceActionSubject } from "@/lib/actions/inlineActions";
import PodcastMenu from "@/components/podcasts/PodcastMenu";
import { truncateText } from "@/lib/display/format";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
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
import { NEW_PANE_HINT } from "@/lib/shortcuts";
import {
  projectActionControlState,
  type ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import Button from "./Button";
import ButtonLink from "./ButtonLink";
import OverflowMenuButton from "./OverflowMenuButton";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import styles from "./SurfaceHeader.module.css";

export interface SurfaceHeaderNavigation {
  /** null: no adjacent visit (control disabled). title null: no name to show yet. */
  back: { readonly title: string | null } | null;
  forward: { readonly title: string | null } | null;
  onBack: (event: TargetActivationEvent) => void;
  onForward: (event: TargetActivationEvent) => void;
}

const RECOVERY = {
  Shown: { label: "hide reader controls", expanded: true, disabled: false },
  Hidden: { label: "show reader controls", expanded: false, disabled: false },
  Held: { label: "hide reader controls", expanded: true, disabled: true },
};

/**
 * A pane's chrome bar: back and forward, the identity (which yields width
 * first), resource shortcuts, a primary action, More and Inspector. Narrow
 * phones keep back, forward, More and the workspace action; other commands
 * retain their identity in More. Desktop: the pane's top row. Mobile: a stationary frame
 * around the hideable top bar, after its visually hidden recovery toggle.
 */
export default function SurfaceHeader({
  projection,
  header,
  identityId,
  primaryAction,
  resourceActions,
  podcastMetadata,
  companionAction: companion,
  paneActions = [],
  menuActions = [],
  resourceRef,
  navigation,
  workspaceAction,
  onMouseDown,
}: {
  projection: "Desktop" | "Mobile";
  header: PaneHeaderModel;
  identityId: string;
  resourceActions?: PaneChrome["resourceActions"];
  podcastMetadata?: PaneChrome["podcastMetadata"];
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
  workspaceAction?: ReactNode;
  onMouseDown?: MouseEventHandler<HTMLElement>;
}) {
  const reasonId = useId();
  const paneId = usePaneRuntime()?.paneId;
  const mobile = projection === "Mobile";
  const [narrowViewport, setNarrow] = useState(false);
  const narrow = mobile && narrowViewport;
  useLayoutEffect(() => {
    const query = window.matchMedia("(max-width: 479px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const frameRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLElement>(null);
  const actionSubjectKey = resourceActions?.kind === "Podcast" ? podcastTargetKey(resourceActions.subject.target)
    : resourceActions?.kind === "Media" ? resourceActions.subject.kind === "Stored" ? `media:${resourceActions.subject.summary.media_id}` : `external:${resourceActions.subject.target}`
    : resourceRef ?? identityId;
  const more = useRef<{ readonly element: HTMLButtonElement; readonly resourceRef: CanonicalResourceRef | null; readonly subjectKey: string } | null>(null);
  const setMore = useCallback((node: HTMLButtonElement | null) => {
    more.current = node ? { element: node, resourceRef: resourceRef ?? null, subjectKey: actionSubjectKey } : null;
  }, [resourceRef, actionSubjectKey]);
  const returnFocus = () => more.current?.subjectKey === actionSubjectKey && more.current.resourceRef === (resourceRef ?? null) &&
    more.current.element.isConnected && more.current.element.getClientRects().length
    ? more.current.element : findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
  const actionFocus = { get trigger() { return more.current?.element ?? null; }, returnFocus, afterRemoval: () => findPaneLandmarkFocusTarget(paneId) };
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
  const displaced = narrow ? [primaryAction?.action, companion].filter((action): action is PanePrimaryAction | PaneCompanionAction => action !== undefined) : [];
  const seen = new Set(actions.map(action => action.id));
  const projectedPaneActions = [...paneActions, ...displaced.filter(action => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  })];
  const sections = [{ id: "Pane" as const, actions: projectedPaneActions }, { id: "View" as const, actions: menuActions }];
  const companionState =
    companion && projectActionControlState(companion.label, companion.state);
  const primary = primaryAction?.action;
  const primaryState = primary && projectActionControlState(
    primary.label, primary.kind === "command" ? primary.state : undefined,
  );

  const scope = mobile ? "" : " in this pane";
  const historyHint = (verb: "back" | "forward", visit: SurfaceHeaderNavigation["back"]) =>
    visit?.title ? `${verb} to ${truncateText(visit.title, 60)} · ${NEW_PANE_HINT}` : NEW_PANE_HINT;
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
        >
          <div className={styles.navigation}>
            <Button
              iconOnly
              icon={<ChevronLeft />}
              className={styles.navigationButton}
              onClick={navigation.onBack}
              onKeyDown={navigation.onBack}
              tooltip={{ text: historyHint("back", navigation.back) }}
              disabled={navigation.back === null}
              aria-label={`Go back${scope}`}
            />
            <Button
              iconOnly
              icon={<ChevronRight />}
              className={styles.navigationButton}
              onClick={navigation.onForward}
              onKeyDown={navigation.onForward}
              tooltip={{ text: historyHint("forward", navigation.forward) }}
              disabled={navigation.forward === null}
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
            {resourceActions ? <ResourceActions subject={resourceActions} density="Header"
              returnFocus={returnFocus} afterRemoval={actionFocus.afterRemoval} /> : null}
            {!narrow && primaryAction && primary && primaryState ? (
              <>
                {primary.kind === "link" ? (
                  <ButtonLink
                    {...(primary.href === null ? { href: null, "aria-disabled": true as const }
                      : { href: primary.href, "aria-disabled": primary.disabled || undefined })}
                    iconOnly
                    icon={primary.icon}
                    className={styles.headerButton}
                    aria-label={primary.label}
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
            {narrow && resourceActions?.kind === "Media" ? (
              <MediaHeaderMenu subject={resourceActions} title={header.title} subjectKey={identityId}
                sections={sections} resourceRef={resourceRef} actionFocus={actionFocus}
                triggerRef={setMore} triggerAttributes={{ "data-pane-chrome-focus": "true" }}
                renderTrigger={props => <span className={styles.overflow}><OverflowMenuButton {...props} className={styles.mobileOverflow} /></span>} />
            ) : resourceActions?.kind === "Podcast" && resourceRef === undefined ? (
              <PodcastMenu subject={resourceActions.subject} metadataSubject={podcastMetadata} actionFocus={actionFocus}
                subjectKey={identityId} placement={mobile ? undefined : "below"} align={mobile ? undefined : "end"}
                sections={sections} omitResourceActions={narrow ? [...seen] : undefined}
                triggerRef={setMore} triggerAttributes={mobile ? { "data-pane-chrome-focus": "true" } : undefined}
                renderTrigger={props => <span className={styles.overflow}><OverflowMenuButton {...props} className={mobile ? styles.mobileOverflow : undefined} /></span>} />
            ) : projectedPaneActions.length > 0 || menuActions.length > 0 || resourceRef !== undefined ? (
              <ContextualActionMenu title={header.title} subjectKey={identityId}
                label={`more actions for ${header.title}`} placement={mobile ? undefined : "below"} align={mobile ? undefined : "end"}
                sections={sections}
                resourceRef={resourceRef} actionFocus={actionFocus} omitResourceActions={narrow ? [...seen] : undefined} triggerRef={setMore}
                triggerAttributes={mobile ? { "data-pane-chrome-focus": "true" } : undefined}
                renderTrigger={props => <span className={styles.overflow}>
                  <OverflowMenuButton {...props} className={mobile ? styles.mobileOverflow : undefined} />
                  {actions.some(action => action.indicator?.kind === "Status") ? <span className={styles.statusMarker} aria-hidden="true" /> : null}
                </span>} />
            ) : null}
            {!narrow && companion && companionState ? (
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
            {workspaceAction ? <div className={styles.workspaceAction}>{workspaceAction}</div> : null}
          </div>
        </header>
      </div>
    </>
  );
}

/** The narrow menu invokes the same media capabilities as the hidden shortcuts. */
function MediaHeaderMenu({ subject, actionFocus, sections, ...props }: Omit<ComponentProps<typeof ContextualActionMenu>, "actionFocus"> & {
  subject: Extract<ResourceActionSubject, { kind: "Media" }>;
  actionFocus: { trigger: HTMLElement | null; returnFocus: () => HTMLElement | null; afterRemoval: () => HTMLElement | null };
}) {
  const shortcuts = useMediaActions(subject.subject, subject.knownDescriptor);
  const present = new Set(sections.flatMap(section => section.actions.map(action => action.id)));
  const actions: ActionDescriptor[] = shortcuts.filter(action => !present.has(action.id)).map(action => ({
    kind: "command", id: action.id, label: action.menuLabel, icon: action.icon,
    disabled: action.disabled, disabledReason: action.disabledReason ?? undefined, busy: action.busy, hasPopup: action.hasPopup ?? undefined,
    restoreFocusOnClose: action.hasPopup === null,
    onSelect: ({ triggerEl }) => action.invoke({ ...actionFocus, trigger: triggerEl }),
  }));
  return <ContextualActionMenu {...props} actionFocus={actionFocus}
    omitResourceActions={[...present, ...shortcuts.map(action => action.id)]}
    sections={sections.map(section => section.id === "View" ? { ...section, actions: [...section.actions, ...actions] } : section)} />;
}
