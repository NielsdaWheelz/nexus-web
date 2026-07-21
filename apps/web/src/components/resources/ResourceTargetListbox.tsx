"use client";

import { resourceIconForScheme } from "@/lib/resources/resourceKind";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import styles from "./ResourceTargetListbox.module.css";

/**
 * The one shared target-search result list — Connections, `LinkTargetDialog`,
 * and notes `@`/Mod-K/`[[` autocomplete all render through this component
 * (universal-link-authoring-hard-cutover.md §Resource Target Search /
 * "shared controller/listbox"). It owns rows, loading/empty/error states, and
 * `role="option"` ids; it does NOT assume an `<input>` exists — notes drives
 * this from a contenteditable combobox host — so it takes an already-computed
 * `activeKey` and reports hover/pick by target, leaving keyboard handling,
 * `aria-activedescendant`, and positioning to the caller.
 */

interface SnippetSegment {
  text: string;
  emphasized: boolean;
}

// Mirrors the private `parseSnippetSegments` in `lib/search/searchViewModel.ts`:
// splits the backend's `<b>…</b>` match markup into safe React segments — no
// `dangerouslySetInnerHTML`. Duplicated rather than imported because that
// function isn't exported and belongs to a sibling subsystem's owned file.
function parseSnippetSegments(snippet: string): SnippetSegment[] {
  if (!snippet) return [];
  const segments: SnippetSegment[] = [];
  const parts = snippet.split(/(<\/?b>)/gi);
  let emphasized = false;
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "<b>") {
      emphasized = true;
      continue;
    }
    if (normalized === "</b>") {
      emphasized = false;
      continue;
    }
    if (!part) continue;
    segments.push({ text: part, emphasized });
  }
  return segments;
}

/** Stable row identity: the item's own ref for a resource target, its
 * transient candidate ref for a passage target. */
export function resourceTargetKey(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.ref : target.candidateRef;
}

/** The DOM id a caller sets as `aria-activedescendant` to point at `target`'s
 * row. Callers own the combobox host (`<input>` or contenteditable) so they
 * compute this themselves rather than reading it off a listbox DOM node. */
export function resourceTargetOptionId(listboxId: string, target: ResourceTarget): string {
  return `${listboxId}-option-${resourceTargetKey(target)}`;
}

export interface ResourceTargetListboxProps {
  id: string;
  ariaLabel: string;
  targets: ResourceTarget[];
  /** The `resourceTargetKey` of the active row, or `null` for none active. */
  activeKey: string | null;
  loading: boolean;
  error: unknown | null;
  /** While a caller's commit is in flight the rows go visually busy and stop
   * accepting picks/hover, so a second click can't fire a duplicate submit. */
  busy?: boolean;
  emptyMessage?: string;
  onHover: (target: ResourceTarget) => void;
  onPick: (target: ResourceTarget) => void;
  /** Omit to hide the retry affordance (caller has no retry path). */
  onRetry?: () => void;
}

export default function ResourceTargetListbox({
  id,
  ariaLabel,
  targets,
  activeKey,
  loading,
  error,
  busy = false,
  emptyMessage = "No matches",
  onHover,
  onPick,
  onRetry,
}: ResourceTargetListboxProps) {
  const settled = !loading && !error;
  return (
    <div
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      className={styles.list}
    >
      {loading ? <div className={styles.status}>Searching…</div> : null}
      {!loading && error ? (
        <div className={styles.errorRow}>
          <span className={styles.errorText}>Couldn&rsquo;t load results</span>
          {onRetry ? (
            <button
              type="button"
              className={styles.tryAgain}
              // Not a listbox tab stop: the combobox host owns keyboard focus.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRetry}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {settled && targets.length === 0 ? <div className={styles.status}>{emptyMessage}</div> : null}
      {settled
        ? targets.map((target) => {
            const key = resourceTargetKey(target);
            const active = key === activeKey;
            const scheme = target.kind === "resource" ? target.item.scheme : target.source.scheme;
            const label = target.kind === "resource" ? target.item.label : target.label;
            const Icon = resourceIconForScheme(scheme);
            const segments = target.kind === "passage" ? parseSnippetSegments(target.excerpt) : [];
            return (
              <div
                key={key}
                id={resourceTargetOptionId(id, target)}
                role="option"
                aria-selected={active}
                className={styles.option}
                data-active={active || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (busy) return;
                  onHover(target);
                }}
                onClick={() => {
                  if (busy) return;
                  onPick(target);
                }}
              >
                <Icon size={16} aria-hidden="true" className={styles.icon} />
                <span className={styles.body}>
                  <span className={styles.label} dir="auto">
                    {label}
                  </span>
                  {target.kind === "passage" ? (
                    <span className={styles.meta} dir="auto">
                      <span>{target.source.label}</span>
                      {segments.length > 0 ? " · " : null}
                      {segments.map((segment, index) =>
                        segment.emphasized ? (
                          <b key={index}>{segment.text}</b>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        ),
                      )}
                    </span>
                  ) : target.item.summary ? (
                    <span className={styles.meta} dir="auto">
                      {target.item.summary}
                    </span>
                  ) : null}
                </span>
                {target.existingLinkId ? <span className={styles.linkedBadge}>Linked</span> : null}
              </div>
            );
          })
        : null}
    </div>
  );
}
