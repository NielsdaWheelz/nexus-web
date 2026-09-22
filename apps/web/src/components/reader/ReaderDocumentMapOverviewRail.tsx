"use client";

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { absent, type Presence } from "@/lib/api/presence";
import {
  type ReaderDocumentMapMarker,
  type ReaderMapMarkerPresentation,
} from "@/lib/reader/documentMap";
import {
  projectReaderLocalPoint,
  projectReaderLocalRange,
  type ReaderDocumentOverviewRange,
  type ReaderDocumentStructure,
} from "@/lib/reader/readerDocumentPosition";
import { cx } from "@/lib/ui/cx";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import {
  useContainingModalLayer,
  useTopmostModalLayerToken,
} from "@/lib/ui/useModalLayer";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import ReaderDocumentMapDestination, {
  readerDocumentMapMarkerTypeLabel,
} from "./ReaderDocumentMapDestination";
import ReaderDocumentMapPopup, {
  type ReaderDocumentMapPopupDismissReason,
} from "./ReaderDocumentMapPopup";
import {
  layoutReaderDocumentMap,
  type ReaderDocumentMapLane,
} from "./readerDocumentMapLayout";
import styles from "./ReaderDocumentMapOverviewRail.module.css";

interface ReaderDocumentMapOverviewRailProps {
  destinations: readonly ReaderMapMarkerPresentation[];
  structure: Presence<ReaderDocumentStructure>;
  visibleRange: Presence<ReaderDocumentOverviewRange>;
  currentPosition: Presence<number>;
  scope: ReaderDocumentOverviewRange & { label: string };
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
  onRevealCurrent: () => void;
  onOpenDetail?: () => void;
}

type Destination =
  | {
      kind: "Marker";
      presentation: ReaderMapMarkerPresentation;
      position: number;
      clippedStart: boolean;
    }
  | { kind: "Current"; position: number };

interface DestinationGroup {
  id: string;
  lane: ReaderDocumentMapLane;
  members: readonly Destination[];
  anchorPosition: number;
  hitTop: number;
  hitHeight: number;
}

type PopupState = {
  kind: "Preview" | "Chooser";
  groupId: string;
};

interface TrackMeasurement {
  height: number;
  nominalHitHeight: number;
}

export default function ReaderDocumentMapOverviewRail({
  destinations,
  structure,
  visibleRange,
  currentPosition,
  scope,
  onActivateMarker,
  onRevealCurrent,
  onOpenDetail,
}: ReaderDocumentMapOverviewRailProps) {
  const popupId = `${useId()}-reader-map-popup`;
  const railRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const previousDestinationIdsRef = useRef<readonly string[]>([]);
  const previousGroupByDestinationRef = useRef(new Map<string, string>());
  const activeDestinationIdRef = useRef<string | null>(null);
  const focusedDestinationIdRef = useRef<string | null>(null);
  const hoveredGroupIdRef = useRef<string | null>(null);
  const repairFocusGroupIdRef = useRef<string | null>(null);
  const historyFocusRef = useRef<{
    target: HTMLElement;
    groupId: string | null;
  } | null>(null);
  const suppressedGroupIdRef = useRef<string | null>(null);
  const [measurement, setMeasurement] = useState<TrackMeasurement | null>(null);
  const [activeDestinationId, setActiveDestinationId] = useState<string | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  activeDestinationIdRef.current = activeDestinationId;
  const containingModal = useContainingModalLayer();
  const topmostModal = useTopmostModalLayerToken();

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const nominalHitHeight = Number.parseFloat(
        getComputedStyle(track).getPropertyValue("--reader-map-hit-height"),
      );
      if (!Number.isFinite(nominalHitHeight) || nominalHitHeight <= 0) {
        throw new Error("Reader map hit height must be a positive CSS length.");
      }
      const next = {
        height: track.getBoundingClientRect().height,
        nominalHitHeight,
      };
      setMeasurement((current) =>
        current?.height === next.height &&
        current.nominalHitHeight === next.nominalHitHeight
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const projected = useMemo(() => destinations.flatMap((presentation) => {
    const { marker } = presentation;
    const position = projectReaderLocalPoint({
      scope,
      position: marker.position,
      documentLength: 1,
    });
    if (position.kind === "Present") {
      return [{ presentation, position: position.value, clippedStart: false }];
    }
    if (scope.end > scope.start && marker.position === scope.end) {
      return [{ presentation, position: 1, clippedStart: false }];
    }
    if (marker.kind !== "Contents" && marker.end_position.kind === "Present") {
      const range = projectReaderLocalRange({
        scope,
        range: { start: marker.position, end: marker.end_position.value },
        documentLength: 1,
      });
      if (range.kind === "Present") {
        return [{ presentation, position: range.value.start, clippedStart: true }];
      }
    }
    return [];
  }), [destinations, scope]);
  const current = useMemo(() => currentPosition.kind === "Present"
    ? projectReaderLocalPoint({ scope, position: currentPosition.value, documentLength: 1 })
    : absent<number>(), [currentPosition, scope]);
  const band = visibleRange.kind === "Present"
    ? projectReaderLocalRange({ scope, range: visibleRange.value, documentLength: 1 })
    : absent<ReaderDocumentOverviewRange>();
  const groups = useMemo<readonly DestinationGroup[]>(() => {
    if (measurement === null) return [];
    const byId = new Map<string, Destination>();
    for (const entry of projected) {
      const destination: Destination = { kind: "Marker", ...entry };
      const id = destinationKey(destination);
      if (byId.has(id)) throw new Error("Reader map destination ids must be unique.");
      byId.set(id, destination);
    }
    if (current.kind === "Present") {
      const destination: Destination = { kind: "Current", position: current.value };
      byId.set(destinationKey(destination), destination);
    }
    return layoutReaderDocumentMap({
      points: [...byId.entries()].map(([id, destination]) => ({
        id,
        lane: destinationLane(destination),
        y: destination.position * measurement.height,
      })),
      trackHeight: measurement.height,
      nominalHitHeight: measurement.nominalHitHeight,
    }).map((group) => ({
      id: group.id,
      lane: group.lane,
      members: group.memberIds.map((id) => {
        const destination = byId.get(id);
        if (!destination) throw new Error("Reader map layout returned an unknown destination.");
        return destination;
      }),
      anchorPosition: group.anchorY / measurement.height,
      hitTop: group.hitTop,
      hitHeight: group.hitHeight,
    }));
  }, [current, measurement, projected]);
  const orderedDestinationIds = useMemo(
    () => groups.flatMap((group) => group.members.map(destinationKey)),
    [groups],
  );
  const activeGroupIndex = activeDestinationId === null
    ? -1
    : groups.findIndex((group) => group.members.some(
      (destination) => destinationKey(destination) === activeDestinationId,
    ));
  const rovingGroupIndex = activeGroupIndex < 0 ? 0 : activeGroupIndex;
  const popupGroup = popup === null
    ? null
    : groups.find((group) => group.id === popup.groupId) ?? null;
  const popupAnchor = popupGroup ? buttonsRef.current.get(popupGroup.id) ?? null : null;

  useLayoutEffect(() => {
    const hoveredGroupId = hoveredGroupIdRef.current;
    if (hoveredGroupId !== null && !groups.some((group) => group.id === hoveredGroupId)) {
      hoveredGroupIdRef.current = null;
    }
    const previousIds = previousDestinationIdsRef.current;
    previousDestinationIdsRef.current = orderedDestinationIds;
    const previousGroups = previousGroupByDestinationRef.current;
    const nextGroups = new Map<string, string>();
    for (const group of groups) {
      for (const destination of group.members) {
        nextGroups.set(destinationKey(destination), group.id);
      }
    }
    previousGroupByDestinationRef.current = nextGroups;
    const activeDestinationId = activeDestinationIdRef.current;
    if (activeDestinationId === null) return;
    const survives = orderedDestinationIds.includes(activeDestinationId);
    if (
      survives &&
      previousGroups.get(activeDestinationId) === nextGroups.get(activeDestinationId)
    ) return;
    const previousIndex = previousIds.indexOf(activeDestinationId);
    const following = previousIds.slice(previousIndex + 1)
      .find((id) => orderedDestinationIds.includes(id));
    const preceding = previousIds.slice(0, Math.max(previousIndex, 0)).reverse()
      .find((id) => orderedDestinationIds.includes(id));
    const replacement = survives ? activeDestinationId : following ?? preceding ?? null;
    const ownedFocus = focusedDestinationIdRef.current === activeDestinationId;
    activeDestinationIdRef.current = replacement;
    setActiveDestinationId(replacement);
    if (!ownedFocus) {
      setPopup(null);
      return;
    }
    const replacementGroup = replacement === null
      ? null
      : groups.find((group) => group.members.some(
        (destination) => destinationKey(destination) === replacement,
      ));
    const focusTarget = replacementGroup
      ? focusGroupTrigger(replacementGroup.id)
      : railRef.current;
    if (!replacementGroup) focusTarget?.focus({ preventScroll: true });
    if (popup?.kind === "Chooser" && containingModal !== null && focusTarget) {
      historyFocusRef.current = {
        target: focusTarget,
        groupId: replacementGroup?.id ?? null,
      };
    }
    focusedDestinationIdRef.current = replacement;
    setPopup(null);
  }, [containingModal, groups, orderedDestinationIds, popup?.kind]);

  useLayoutEffect(() => {
    if (popup !== null && popupGroup === null) setPopup(null);
  }, [popup, popupGroup]);

  const previousSourceRef = useRef({ destinations, start: scope.start, end: scope.end, label: scope.label });
  useLayoutEffect(() => {
    const previous = previousSourceRef.current;
    previousSourceRef.current = { destinations, start: scope.start, end: scope.end, label: scope.label };
    if (
      previous.destinations !== destinations ||
      previous.start !== scope.start ||
      previous.end !== scope.end ||
      previous.label !== scope.label
    ) {
      hoveredGroupIdRef.current = null;
      const focusedDestinationId = focusedDestinationIdRef.current;
      const ownsFocus = popupGroup !== null &&
        focusedDestinationId !== null &&
        popupGroup.members.some(
          (destination) => destinationKey(destination) === focusedDestinationId,
        ) &&
        railRef.current?.contains(document.activeElement) === true;
      if (ownsFocus) {
        const trigger = focusGroupTrigger(popupGroup.id);
        if (popup?.kind === "Chooser" && containingModal !== null && trigger) {
          historyFocusRef.current = { target: trigger, groupId: popupGroup.id };
        }
      } else suppressedGroupIdRef.current = null;
      setPopup(null);
    }
  }, [
    containingModal,
    destinations,
    popup?.kind,
    popupGroup,
    scope.end,
    scope.label,
    scope.start,
  ]);

  function closePopup(
    group: DestinationGroup,
    reason: ReaderDocumentMapPopupDismissReason | "toggle",
  ) {
    historyFocusRef.current = null;
    if (reason !== "escape" && reason !== "toggle") {
      if (hoveredGroupIdRef.current === group.id) hoveredGroupIdRef.current = null;
    }
    if (reason === "escape" || reason === "toggle") {
      if (popup?.kind === "Chooser") {
        const trigger = focusGroupTrigger(group.id);
        if (containingModal !== null && trigger) {
          historyFocusRef.current = { target: trigger, groupId: group.id };
        }
      } else suppressedGroupIdRef.current = group.id;
    }
    setPopup(null);
  }

  useHistoryDismiss(
    popup?.kind === "Chooser" && containingModal !== null,
    () => {
      if (popupGroup) closePopup(popupGroup, "escape");
      return "accepted";
    },
    {
      isTopmost: containingModal === topmostModal,
      onHistorySettled: () => {
        const pendingFocus = historyFocusRef.current;
        historyFocusRef.current = null;
        if (!pendingFocus?.target.isConnected || pendingFocus.target.closest("[inert]")) return;
        if (document.activeElement === pendingFocus.target) return;
        if (
          document.activeElement !== document.body &&
          document.activeElement !== document.documentElement
        ) return;
        if (pendingFocus.groupId !== null) {
          suppressedGroupIdRef.current = pendingFocus.groupId;
          repairFocusGroupIdRef.current = pendingFocus.groupId;
        }
        pendingFocus.target.focus({ preventScroll: true });
        repairFocusGroupIdRef.current = null;
      },
    },
  );

  const boundaries = structure.kind === "Present" && structure.value.length > 0
    ? [...new Set(structure.value.coverage.flatMap((span) => [span.start, span.end]))]
        .map((offset) => offset / structure.value.length)
        .filter((position) => scope.start <= position && position <= scope.end)
    : [];

  function activate(destination: Destination, group: DestinationGroup) {
    historyFocusRef.current = null;
    focusGroupTrigger(group.id);
    setPopup(null);
    if (destination.kind === "Current") onRevealCurrent();
    else onActivateMarker(destination.presentation.marker);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRovingIndexForKey({
      key: event.key,
      currentIndex: index,
      itemCount: groups.length,
      orientation: "vertical",
    });
    if (next === null) return;
    event.preventDefault();
    const group = groups[next];
    if (!group) return;
    const id = destinationKey(group.members[0]!);
    activeDestinationIdRef.current = id;
    setActiveDestinationId(id);
    buttonsRef.current.get(group.id)?.focus();
  }

  function focusGroupTrigger(groupId: string): HTMLButtonElement | null {
    const trigger = buttonsRef.current.get(groupId) ?? null;
    if (!trigger) return null;
    suppressedGroupIdRef.current = groupId;
    repairFocusGroupIdRef.current = groupId;
    trigger.focus({ preventScroll: true });
    repairFocusGroupIdRef.current = null;
    return trigger;
  }

  return (
    <div
      ref={railRef}
      className={styles.rail}
      role="region"
      aria-label="Document Map overview"
      tabIndex={-1}
      onBlurCapture={(event) => {
        const rail = event.currentTarget;
        if (event.relatedTarget instanceof Node && !rail.contains(event.relatedTarget)) {
          focusedDestinationIdRef.current = null;
        } else if (event.relatedTarget === null) {
          queueMicrotask(() => {
            if (!rail.contains(document.activeElement)) focusedDestinationIdRef.current = null;
          });
        }
      }}
    >
      {onOpenDetail ? (
        <button
          type="button"
          className={styles.openDetail}
          onFocus={() => {
            focusedDestinationIdRef.current = null;
          }}
          onClick={onOpenDetail}
          aria-label="Open document map"
        >
          ≡
        </button>
      ) : null}
      <div ref={trackRef} className={styles.track} role="toolbar" aria-orientation="vertical" aria-label="Document Map destinations">
        {boundaries.map((position) => (
          <span key={position} className={styles.boundary} aria-hidden="true" style={{ top: `${((position - scope.start) / (scope.end - scope.start)) * 100}%` }} />
        ))}
        {band.kind === "Present" ? (
          <div className={styles.band} aria-hidden="true" style={{ top: `${band.value.start * 100}%`, height: `${(band.value.end - band.value.start) * 100}%` }} />
        ) : null}
        {destinations.map(({ marker }) => {
          if (marker.kind === "Contents" || marker.end_position.kind === "Absent") return null;
          const range = projectReaderLocalRange({ scope, range: { start: marker.position, end: marker.end_position.value }, documentLength: 1 });
          return range.kind === "Present" ? (
            <span key={marker.id} className={styles.evidenceRange} aria-hidden="true" style={{ top: `${range.value.start * 100}%`, height: `${(range.value.end - range.value.start) * 100}%`, "--marker-color": markerColor(marker) } as CSSProperties} />
          ) : null;
        })}
        {projected.map(({ presentation, position }) => (
          <span
            key={presentation.marker.id}
            className={cx(styles.exactMarker, presentation.marker.kind === "Contents" ? styles.structureLane : styles.evidenceLane)}
            aria-hidden="true"
            style={{ top: `${position * 100}%` }}
          >
            <MarkerGlyph marker={presentation.marker} />
          </span>
        ))}
        {current.kind === "Present" ? <span className={styles.current} aria-hidden="true" style={{ top: `${current.value * 100}%` }} /> : null}
        {groups.map((group, index) => {
          const chooserOpen = popup?.kind === "Chooser" && popup.groupId === group.id;
          const previewOpen = popup?.kind === "Preview" && popup.groupId === group.id;
          return (
            <div
              key={group.id}
              className={cx(styles.groupSlot, group.lane === "structure" ? styles.structureLane : styles.evidenceLane)}
              style={{ top: group.hitTop, height: group.hitHeight }}
            >
              <button
                ref={(button) => {
                  if (button) buttonsRef.current.set(group.id, button);
                  else buttonsRef.current.delete(group.id);
                }}
                type="button"
                className={styles.markerButton}
                tabIndex={index === rovingGroupIndex ? 0 : -1}
                aria-label={groupName(group, scope.label)}
                aria-describedby={previewOpen ? popupId : undefined}
                aria-expanded={group.members.length > 1 ? chooserOpen : undefined}
                aria-controls={chooserOpen ? popupId : undefined}
                onPointerEnter={() => {
                  hoveredGroupIdRef.current = group.id;
                  const focusedDestinationId = focusedDestinationIdRef.current;
                  if (
                    popup?.kind === "Chooser" ||
                    suppressedGroupIdRef.current === group.id ||
                    (focusedDestinationId !== null && !group.members.some(
                      (destination) => destinationKey(destination) === focusedDestinationId,
                    ))
                  ) return;
                  setPopup({ kind: "Preview", groupId: group.id });
                }}
                onPointerLeave={(event) => {
                  if (suppressedGroupIdRef.current === group.id) {
                    suppressedGroupIdRef.current = null;
                  }
                  const popupElement = document.getElementById(popupId);
                  if (
                    event.relatedTarget instanceof Node &&
                    popupElement?.contains(event.relatedTarget)
                  ) return;
                  if (hoveredGroupIdRef.current === group.id) {
                    hoveredGroupIdRef.current = null;
                    if (focusedDestinationIdRef.current === null) setPopup(null);
                  }
                }}
                onFocus={() => {
                  const activeDestinationId = activeDestinationIdRef.current;
                  const focusedId = activeDestinationId !== null && group.members.some(
                    (destination) => destinationKey(destination) === activeDestinationId,
                  )
                    ? activeDestinationId
                    : destinationKey(group.members[0]!);
                  focusedDestinationIdRef.current = focusedId;
                  activeDestinationIdRef.current = focusedId;
                  setActiveDestinationId(focusedId);
                  if (repairFocusGroupIdRef.current === group.id) return;
                  if (popup?.kind === "Chooser" && popup.groupId === group.id) return;
                  if (suppressedGroupIdRef.current === group.id) {
                    suppressedGroupIdRef.current = null;
                  }
                  setPopup({ kind: "Preview", groupId: group.id });
                }}
                onBlur={(event) => {
                  if (
                    suppressedGroupIdRef.current === group.id &&
                    hoveredGroupIdRef.current !== group.id
                  ) {
                    suppressedGroupIdRef.current = null;
                  }
                  const popupElement = document.getElementById(popupId);
                  if (
                    event.relatedTarget instanceof Node &&
                    popupElement?.contains(event.relatedTarget)
                  ) return;
                  if (group.members.some(
                    (destination) =>
                      destinationKey(destination) === focusedDestinationIdRef.current,
                  )) {
                    focusedDestinationIdRef.current = null;
                  }
                  if (popup?.kind === "Chooser") return;
                  const hoveredGroupId = hoveredGroupIdRef.current;
                  if (
                    hoveredGroupId !== null &&
                    suppressedGroupIdRef.current !== hoveredGroupId &&
                    groups.some((candidate) => candidate.id === hoveredGroupId)
                  ) {
                    setPopup({ kind: "Preview", groupId: hoveredGroupId });
                  } else setPopup(null);
                }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onClick={() => {
                  if (group.members.length === 1) {
                    activate(group.members[0]!, group);
                  } else if (chooserOpen) {
                    closePopup(group, "toggle");
                  } else {
                    setPopup({ kind: "Chooser", groupId: group.id });
                  }
                }}
              >
                {group.members.length > 1 ? <span className={styles.groupBracket} aria-hidden="true" /> : null}
              </button>
              {(previewOpen || chooserOpen) && popupAnchor ? (
                <ReaderDocumentMapPopup
                  anchor={popupAnchor}
                  mode={previewOpen ? "Preview" : "Chooser"}
                  id={popupId}
                  label={group.members.length === 1 ? "destination preview" : `${group.members.length} destinations`}
                  onDismiss={(reason) => closePopup(group, reason)}
                >
                  {previewOpen ? (
                    <>
                      <ul className={styles.destinationList}>
                        {group.members.slice(0, 3).map((destination) => (
                          <li key={destinationKey(destination)}>
                            <DestinationContent destination={destination} scopeLabel={scope.label} />
                          </li>
                        ))}
                      </ul>
                      {group.members.length > 3 ? (
                        <p className={styles.omission}>{group.members.length - 3} more destinations — activate to choose</p>
                      ) : null}
                    </>
                  ) : (
                    <ul className={styles.destinationList}>
                      {group.members.map((destination) => (
                        <li key={destinationKey(destination)}>
                          <button
                            type="button"
                            onFocus={() => {
                              const id = destinationKey(destination);
                              focusedDestinationIdRef.current = id;
                              activeDestinationIdRef.current = id;
                              setActiveDestinationId(id);
                            }}
                            onClick={() => activate(destination, group)}
                          >
                            <DestinationContent destination={destination} scopeLabel={scope.label} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ReaderDocumentMapPopup>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function destinationKey(destination: Destination): string {
  return destination.kind === "Current"
    ? "current"
    : `marker:${destination.presentation.marker.id}`;
}

function destinationLane(destination: Destination): ReaderDocumentMapLane {
  return destination.kind === "Marker" && destination.presentation.marker.kind !== "Contents"
    ? "evidence"
    : "structure";
}

function destinationPositionLabel(destination: Destination, scopeLabel: string): string {
  if (destination.kind === "Marker" && destination.clippedStart) {
    return `continues from before ${scopeLabel}`;
  }
  return `${Math.round(destination.position * 100)}% through ${scopeLabel}`;
}

function destinationName(destination: Destination, scopeLabel: string): string {
  if (destination.kind === "Current") return `Current position, ${destinationPositionLabel(destination, scopeLabel)}`;
  const { marker } = destination.presentation;
  return `${readerDocumentMapMarkerTypeLabel(marker.kind)}, ${destinationPositionLabel(destination, scopeLabel)}`;
}

function groupName(group: DestinationGroup, scopeLabel: string): string {
  if (group.members.length === 1) return destinationName(group.members[0]!, scopeLabel);
  return `${group.members.length} destinations near ${Math.round(group.anchorPosition * 100)}% through ${scopeLabel}`;
}

function MarkerGlyph({ marker }: { marker: ReaderDocumentMapMarker }) {
  return <span className={cx(styles.markerGlyph, markerShapeClass(marker), marker.tone === "Warning" && styles.markerWarning)} style={{ "--marker-color": markerColor(marker) } as CSSProperties} />;
}

function markerShapeClass(marker: ReaderDocumentMapMarker): string {
  switch (marker.kind) {
    case "Contents": return styles.markerContents;
    case "Embed": return styles.markerEmbed;
    case "Highlight": return styles.markerHighlight;
    case "SourceReference":
    case "GeneratedCitation": return styles.markerCitation;
    case "Link":
    case "Synapse": return styles.markerConnection;
  }
}

function markerColor(marker: ReaderDocumentMapMarker): string {
  switch (marker.tone) {
    case "Highlight": return "var(--highlight-yellow)";
    case "Citation": return "var(--highlight-purple)";
    case "Link": return "var(--highlight-blue)";
    case "Synapse": return "var(--highlight-green)";
    case "Warning": return "var(--highlight-pink)";
    case "Neutral": return "var(--edge-strong)";
  }
}

function DestinationContent({
  destination,
  scopeLabel,
}: {
  destination: Destination;
  scopeLabel: string;
}) {
  const positionLabel = destinationPositionLabel(destination, scopeLabel);
  return destination.kind === "Current"
    ? <ReaderDocumentMapDestination kind="Current" positionLabel={positionLabel} />
    : (
        <ReaderDocumentMapDestination
          kind="Marker"
          destination={destination.presentation}
          positionLabel={positionLabel}
        />
      );
}
