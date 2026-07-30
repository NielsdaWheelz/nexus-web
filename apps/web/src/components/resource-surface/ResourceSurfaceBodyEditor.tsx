"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Link2, Plus, Trash2 } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import NoteBodyEditor, {
  type NoteBodyChange,
  type NoteBodySplit,
} from "@/components/notes/NoteBodyEditor";
import ResourceTargetListbox, {
  resourceTargetKey,
  resourceTargetOptionId,
} from "@/components/resources/ResourceTargetListbox";
import Button from "@/components/ui/Button";
import type {
  ResourceItem,
  ResourceSurfaceOccurrence,
  SurfacePosition,
} from "@/lib/resources/resourceItems";
import { useResourceTargetSearch } from "@/lib/resources/useResourceTargetSearch";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { resourceSurfaceFilterFields } from "./resourceSurfaceFilterFields";
import styles from "./ResourceSurfaceBodyEditor.module.css";

export interface ResourceSurfaceBodyFocusRequest {
  occurrenceId: string | null;
  serial: number;
}

export interface ResourceSurfaceBodyChange extends NoteBodyChange {
  occurrenceId: string;
}

export interface ResourceSurfaceSplitRequest {
  occurrenceId: string;
  leftBodyPmJson: Record<string, unknown>;
  rightBodyPmJson: Record<string, unknown>;
}

export interface ResourceSurfaceMoveRequest {
  occurrenceId: string;
  position: SurfacePosition;
}

export interface ResourceSurfaceInsertResourceRequest {
  targetRef: string;
  position: SurfacePosition;
}

export interface ResourceSurfaceBodyEditorProps {
  sourceRef: string;
  orderedItems: ResourceSurfaceOccurrence[];
  rowFilterQuery?: string;
  editable?: boolean;
  focusRequest?: ResourceSurfaceBodyFocusRequest;
  onInsertNote: (position: SurfacePosition) => void;
  onSplitNote: (request: ResourceSurfaceSplitRequest) => void;
  onMoveOccurrence: (request: ResourceSurfaceMoveRequest) => void;
  onRemoveOccurrence: (occurrenceId: string) => void;
  onInsertResource: (request: ResourceSurfaceInsertResourceRequest) => void;
  onBodyChange: (change: ResourceSurfaceBodyChange) => void;
  onBodyBlur: (change: ResourceSurfaceBodyChange) => void;
  onActivate: (
    item: ResourceItem,
    disposition: WorkspaceTargetDisposition,
  ) => void;
  onOpenObject: (
    objectType: string,
    objectId: string,
    disposition: WorkspaceTargetDisposition,
  ) => void;
  onFeedback?: (feedback: FeedbackContent) => void;
  onError?: (error: unknown) => void;
}

interface LocalFocusRequest {
  occurrenceId: string;
  serial: number;
}

export default function ResourceSurfaceBodyEditor({
  sourceRef,
  orderedItems,
  rowFilterQuery = "",
  editable = true,
  focusRequest,
  onInsertNote,
  onSplitNote,
  onMoveOccurrence,
  onRemoveOccurrence,
  onInsertResource,
  onBodyChange,
  onBodyBlur,
  onActivate,
  onOpenObject,
  onFeedback,
  onError,
}: ResourceSurfaceBodyEditorProps) {
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);
  const [localFocusRequest, setLocalFocusRequest] =
    useState<LocalFocusRequest | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const addItemInputId = useId();
  const addItemListboxId = useId();
  const filtering = rowFilterQuery.trim().length > 0;
  const directEditingAvailable = editable && !filtering;
  const presentRefs = useMemo(
    () => [
      sourceRef,
      ...orderedItems.map((occurrence) => occurrence.target.item.ref),
    ],
    [orderedItems, sourceRef],
  );
  const visibleRows = useMemo(() => {
    if (!filtering) {
      return orderedItems.map((occurrence, sourceIndex) => ({
        occurrence,
        sourceIndex,
      }));
    }
    return orderedItems.flatMap((occurrence, sourceIndex) =>
      matchesPaneFilterQuery(
        rowFilterQuery,
        resourceSurfaceFilterFields(occurrence),
      )
        ? [{ occurrence, sourceIndex }]
        : [],
    );
  }, [filtering, orderedItems, rowFilterQuery]);
  const { targets, loading, error } = useResourceTargetSearch({
    purpose: "link",
    query,
    sourceRef,
    excludeRefs: presentRefs,
  });
  const directTargets = useMemo(
    () =>
      targets.filter(
        (target) =>
          target.kind === "resource" &&
          target.item.capabilities.adjacencyTarget &&
          !presentRefs.includes(target.item.ref),
      ),
    [presentRefs, targets],
  );

  useEffect(() => {
    if (addItemOpen) searchInputRef.current?.focus();
  }, [addItemOpen]);

  useEffect(() => {
    const keys = directTargets.map(resourceTargetKey);
    setActiveTargetKey((current) =>
      current && keys.includes(current) ? current : (keys[0] ?? null),
    );
  }, [directTargets]);

  const activeTarget = directTargets.find(
    (target) => resourceTargetKey(target) === activeTargetKey,
  );

  const pickTarget = (target: (typeof directTargets)[number]) => {
    if (target.kind !== "resource") return;
    onInsertResource({
      targetRef: target.item.ref,
      position: endPosition(orderedItems),
    });
    setQuery("");
    setActiveTargetKey(null);
    setAddItemOpen(false);
  };

  const focusForOccurrence = (occurrenceId: string): number => {
    if (
      focusRequest?.occurrenceId === occurrenceId &&
      focusRequest.serial > 0
    ) {
      return focusRequest.serial;
    }
    return localFocusRequest?.occurrenceId === occurrenceId
      ? localFocusRequest.serial
      : 0;
  };

  const focusPreviousEditableRow = (index: number) => {
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const occurrence = orderedItems[candidate];
      if (occurrence?.target.content.kind === "note_body") {
        setLocalFocusRequest((current) => ({
          occurrenceId: occurrence.occurrenceId,
          serial: (current?.serial ?? 0) + 1,
        }));
        return;
      }
    }
  };

  return (
    <section
      className={styles.body}
      aria-label="Ordered resources"
      data-pane-return-scope="Notes.EditorBlocks"
    >
      {filtering ? (
        <p className={styles.inspectionNotice} role="status">
          Filtered view is inspection only — clear Filter to edit.
        </p>
      ) : null}
      <ol className={styles.rows}>
        {visibleRows.map(({ occurrence, sourceIndex }) => {
          const { item, content } = occurrence.target;
          const label = item.label.trim() || item.scheme.replaceAll("_", " ");
          if (content.kind === "note_body") {
            return (
              <li
                key={item.ref}
                className={styles.noteRow}
                data-occurrence-id={occurrence.occurrenceId}
                data-collection-row-id={occurrence.occurrenceId}
              >
                <div className={styles.noteEditor}>
                  <NoteBodyEditor
                    resourceKey={`${sourceRef}:${item.ref}`}
                    initialBodyPmJson={content.bodyPmJson}
                    fallbackBodyText={content.bodyText}
                    editable={directEditingAvailable}
                    ariaLabel={`Edit note ${sourceIndex + 1}`}
                    focusRequest={focusForOccurrence(occurrence.occurrenceId)}
                    onBodyChange={(body) =>
                      onBodyChange({
                        occurrenceId: occurrence.occurrenceId,
                        ...body,
                      })
                    }
                    onBlurFlush={(body) =>
                      onBodyBlur({
                        occurrenceId: occurrence.occurrenceId,
                        ...body,
                      })
                    }
                    onSplit={
                      directEditingAvailable
                        ? (split) =>
                      onSplitNoteRequest(
                        occurrence.occurrenceId,
                        split,
                        onSplitNote,
                      )
                        : undefined
                    }
                    onEmptyBackspace={
                      directEditingAvailable
                        ? () => {
                      focusPreviousEditableRow(sourceIndex);
                      onRemoveOccurrence(occurrence.occurrenceId);
                          }
                        : undefined
                    }
                    onMove={
                      directEditingAvailable
                        ? (direction) => {
                      const position = positionForMove(
                        orderedItems,
                        sourceIndex,
                        direction,
                      );
                      if (position) {
                        onMoveOccurrence({
                          occurrenceId: occurrence.occurrenceId,
                          position,
                        });
                      }
                          }
                        : undefined
                    }
                    onOpenObject={onOpenObject}
                    onFeedback={onFeedback}
                    onError={onError}
                  />
                </div>
                {directEditingAvailable ? (
                  <RowActions
                    label={label || `note ${sourceIndex + 1}`}
                    canMoveUp={sourceIndex > 0}
                    canMoveDown={sourceIndex < orderedItems.length - 1}
                    onMoveUp={() => {
                      const position = positionForMove(
                        orderedItems,
                        sourceIndex,
                        "up",
                      );
                      if (position) {
                        onMoveOccurrence({
                          occurrenceId: occurrence.occurrenceId,
                          position,
                        });
                      }
                    }}
                    onMoveDown={() => {
                      const position = positionForMove(
                        orderedItems,
                        sourceIndex,
                        "down",
                      );
                      if (position) {
                        onMoveOccurrence({
                          occurrenceId: occurrence.occurrenceId,
                          position,
                        });
                      }
                    }}
                    onRemove={() => onRemoveOccurrence(occurrence.occurrenceId)}
                  />
                ) : null}
              </li>
            );
          }

          return (
            <li
              key={item.ref}
              className={styles.resourceRow}
              data-occurrence-id={occurrence.occurrenceId}
              data-collection-row-id={occurrence.occurrenceId}
            >
              <button
                type="button"
                className={styles.resourceActivation}
                aria-label={`Open ${label}`}
                onClick={(event) =>
                  onActivate(
                    item,
                    workspaceTargetClickIntent(event).disposition,
                  )
                }
              >
                <span className={styles.resourceLabel}>{label}</span>
                {item.summary ? (
                  <span className={styles.resourceSummary}>{item.summary}</span>
                ) : null}
              </button>
              {directEditingAvailable ? (
                <RowActions
                  label={label}
                  canMoveUp={sourceIndex > 0}
                  canMoveDown={sourceIndex < orderedItems.length - 1}
                  onMoveUp={() => {
                    const position = positionForMove(
                      orderedItems,
                      sourceIndex,
                      "up",
                    );
                    if (position) {
                      onMoveOccurrence({
                        occurrenceId: occurrence.occurrenceId,
                        position,
                      });
                    }
                  }}
                  onMoveDown={() => {
                    const position = positionForMove(
                      orderedItems,
                      sourceIndex,
                      "down",
                    );
                    if (position) {
                      onMoveOccurrence({
                        occurrenceId: occurrence.occurrenceId,
                        position,
                      });
                    }
                  }}
                  onRemove={() => onRemoveOccurrence(occurrence.occurrenceId)}
                />
              ) : null}
            </li>
          );
        })}
        {filtering && visibleRows.length === 0 ? (
          <li className={styles.emptyRow} role="status">
            No items match this filter.
          </li>
        ) : null}
        {directEditingAvailable ? (
          <li className={styles.insertionRow}>
            <button
              type="button"
              className={styles.insertNote}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                }
              }}
              onClick={() => onInsertNote(endPosition(orderedItems))}
            >
              <Plus size={16} aria-hidden="true" />
              <span>Add a note</span>
            </button>
          </li>
        ) : null}
      </ol>

      {directEditingAvailable ? (
        <div className={styles.addItem}>
          {addItemOpen ? (
            <div className={styles.addItemSearch}>
              <label htmlFor={addItemInputId}>Add item</label>
              <input
                ref={searchInputRef}
                id={addItemInputId}
                type="search"
                value={query}
                role="combobox"
                aria-autocomplete="list"
                aria-controls={addItemListboxId}
                aria-expanded={Boolean(query.trim())}
                aria-activedescendant={
                  activeTarget
                    ? resourceTargetOptionId(addItemListboxId, activeTarget)
                    : undefined
                }
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setAddItemOpen(false);
                    setQuery("");
                    setActiveTargetKey(null);
                    return;
                  }
                  if (!query.trim() || directTargets.length === 0) return;
                  const currentIndex = Math.max(
                    0,
                    directTargets.findIndex(
                      (target) => resourceTargetKey(target) === activeTargetKey,
                    ),
                  );
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    const target =
                      directTargets[
                        (currentIndex + delta + directTargets.length) %
                          directTargets.length
                      ];
                    setActiveTargetKey(
                      target ? resourceTargetKey(target) : null,
                    );
                    return;
                  }
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey
                  ) {
                    event.preventDefault();
                    const target =
                      directTargets.find(
                        (candidate) =>
                          resourceTargetKey(candidate) === activeTargetKey,
                      ) ?? directTargets[0];
                    if (target) pickTarget(target);
                  }
                }}
              />
              {query.trim() ? (
                <ResourceTargetListbox
                  id={addItemListboxId}
                  ariaLabel="Resources to add"
                  targets={directTargets}
                  activeKey={activeTargetKey}
                  loading={loading}
                  error={error}
                  onHover={(target) =>
                    setActiveTargetKey(resourceTargetKey(target))
                  }
                  onPick={pickTarget}
                />
              ) : null}
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Link2 size={16} aria-hidden="true" />}
              onClick={() => setAddItemOpen(true)}
            >
              Add item
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function RowActions({
  label,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const options: readonly ActionDescriptor[] = [
    {
      kind: "command",
      id: "ResourceSurface.MoveEarlier",
      label: `Move ${label} earlier`,
      icon: <ChevronUp size={16} aria-hidden="true" />,
      disabled: !canMoveUp,
      onSelect: onMoveUp,
    },
    {
      kind: "command",
      id: "ResourceSurface.MoveLater",
      label: `Move ${label} later`,
      icon: <ChevronDown size={16} aria-hidden="true" />,
      disabled: !canMoveDown,
      onSelect: onMoveDown,
    },
    {
      kind: "command",
      id: "ResourceSurface.Remove",
      label: `Remove ${label} from this surface`,
      icon: <Trash2 size={16} aria-hidden="true" />,
      tone: "danger",
      separatorBefore: true,
      onSelect: onRemove,
    },
  ];
  return (
    <ActionMenu
      className={styles.rowActions}
      label={`Actions for ${label}`}
      options={options}
    />
  );
}

function onSplitNoteRequest(
  occurrenceId: string,
  split: NoteBodySplit,
  onSplitNote: (request: ResourceSurfaceSplitRequest) => void,
) {
  onSplitNote({
    occurrenceId,
    leftBodyPmJson: split.leftBodyPmJson,
    rightBodyPmJson: split.rightBodyPmJson,
  });
}

function endPosition(
  orderedItems: ResourceSurfaceOccurrence[],
): SurfacePosition {
  const last = orderedItems.at(-1);
  return last
    ? { kind: "after", occurrenceId: last.occurrenceId }
    : { kind: "start" };
}

function positionForMove(
  orderedItems: ResourceSurfaceOccurrence[],
  index: number,
  direction: "up" | "down",
): SurfacePosition | null {
  if (direction === "up") {
    if (index <= 0) return null;
    const beforePrevious = orderedItems[index - 2];
    return beforePrevious
      ? { kind: "after", occurrenceId: beforePrevious.occurrenceId }
      : { kind: "start" };
  }
  const next = orderedItems[index + 1];
  return next ? { kind: "after", occurrenceId: next.occurrenceId } : null;
}
