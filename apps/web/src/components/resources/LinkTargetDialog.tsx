"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useResourceTargetSearch } from "@/lib/resources/useResourceTargetSearch";
import ResourceTargetListbox, {
  resourceTargetKey,
  resourceTargetOptionId,
} from "@/components/resources/ResourceTargetListbox";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import type { LinkTarget } from "@/lib/resourceGraph/links";
import styles from "./LinkTargetDialog.module.css";

const LISTBOX_ID = "link-target-listbox";

function toLinkTarget(target: ResourceTarget): LinkTarget {
  return target.kind === "resource"
    ? { kind: "resource", ref: target.item.ref }
    : { kind: "passage", candidate_ref: target.candidateRef };
}

function targetLabel(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.label : target.label;
}

export interface LinkTargetDialogProps {
  open: boolean;
  /** An existing durable Link source, for already-linked dedupe. Omitted for a
   * fresh selection that has no Highlight yet. */
  sourceRef?: string;
  excludeRefs?: readonly string[];
  /** True while the caller's `createLink` is in flight — the dialog goes busy
   * and blocks a second pick (§ Target Behavior item 4). */
  busy?: boolean;
  /**
   * Fires with the picked target's ref, mapped straight onto the `Link`
   * mutation's own `LinkTarget` shape, plus the picked row's display `label`
   * (the confirmation toast names the target the user chose — the server
   * response can't, since a canonically-reordered pair loses which endpoint was
   * the target). This dialog performs zero writes — the caller (a Link
   * composer) owns the actual `createLink` call.
   */
  onPick: (target: LinkTarget, label: string) => void;
  onClose: () => void;
}

/**
 * Reader-owned modal search surface for choosing a Link target. Wraps the
 * shared `useResourceTargetSearch(purpose="link")` controller and
 * `ResourceTargetListbox` in a `useDialogOverlay`-governed overlay (focus
 * trap, body-scroll lock, return focus, Escape) — the CitePicker precedent
 * hand-rolled all of this (universal-link-authoring-hard-cutover.md
 * §Consolidation And Deletion; this file replaces it).
 */
export default function LinkTargetDialog({
  open,
  sourceRef,
  excludeRefs,
  busy = false,
  onPick,
  onClose,
}: LinkTargetDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const { targets, loading, error } = useResourceTargetSearch({
    purpose: "link",
    query,
    sourceRef,
    excludeRefs,
  });

  // Derived during render (never via an effect) so an in-flight Arrow move
  // can't be clobbered by a stale "initialize" effect: an explicit `activeKey`
  // wins while it still names a live target, otherwise the first target is
  // active by default.
  const effectiveActiveKey =
    activeKey && targets.some((target) => resourceTargetKey(target) === activeKey)
      ? activeKey
      : (targets[0] ? resourceTargetKey(targets[0]) : null);

  useDialogOverlay({
    ref: panelRef,
    active: open,
    onDismiss: onClose,
    initialFocus: () => inputRef.current,
  });

  if (!open) return null;

  function pick(target: ResourceTarget | undefined) {
    if (!target || busy) return;
    onPick(toLinkTarget(target), targetLabel(target));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      if (targets.length === 0) return;
      const current = targets.findIndex((target) => resourceTargetKey(target) === effectiveActiveKey);
      const start = current >= 0 ? current : 0;
      const last = targets.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveKey(resourceTargetKey(targets[next]!));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(targets.find((target) => resourceTargetKey(target) === effectiveActiveKey) ?? targets[0]);
    }
  }

  return createPortal(
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Link"
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          role="combobox"
          aria-expanded
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          disabled={busy}
          aria-activedescendant={
            effectiveActiveKey
              ? resourceTargetOptionId(
                  LISTBOX_ID,
                  targets.find((target) => resourceTargetKey(target) === effectiveActiveKey)!,
                )
              : undefined
          }
          placeholder="Search to link…"
          aria-label="Link search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ResourceTargetListbox
          id={LISTBOX_ID}
          ariaLabel="Link targets"
          targets={targets}
          activeKey={effectiveActiveKey}
          loading={loading}
          error={error}
          busy={busy}
          emptyMessage={query.trim().length === 0 ? "Type to search" : "No matches"}
          onHover={(target) => setActiveKey(resourceTargetKey(target))}
          onPick={pick}
        />
      </div>
    </div>,
    document.body,
  );
}
