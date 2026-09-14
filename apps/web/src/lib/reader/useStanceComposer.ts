"use client";

import { useCallback, useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { deleteStance, putStance } from "@/lib/resourceGraph/stances";
import type { ReaderCapacityReason } from "./readerCapacity";

export type StanceKind = "supports" | "contradicts";

/**
 * A reader-local single-key chord, parameterized on the key — the modal
 * "focus-a-passage + one dedicated key" stance shape (D-11), mirroring
 * useHighlightNoteChord. Fires only while enabled (a passage is focused), never
 * inside an editable target, never with a modifier.
 */
export function useReaderKeyChord(args: {
  enabled: boolean;
  key: string;
  onTrigger: () => void;
}): void {
  const onTriggerRef = useRef(args.onTrigger);
  onTriggerRef.current = args.onTrigger;

  useEffect(() => {
    if (!args.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== args.key) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onTriggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [args.enabled, args.key]);
}

/** What a stance press found to act on. */
export type StanceTarget =
  | { readonly kind: "Target"; readonly highlightId: string; readonly targetRef: string; readonly currentStanceId: string | null }
  /** The reader refused the lookup it needed; the press wrote nothing. */
  | { readonly kind: "Capacity"; readonly reason: ReaderCapacityReason }
  /** No passage survived the press — its creation failed or the selection went. */
  | { readonly kind: "Absent" };

/**
 * What one press did. The chord's owner routes `Failed` to the reader's failure
 * publisher and `Capacity` to its capacity notice; the rest wrote nothing a
 * reader must be told about beyond the mark itself.
 */
export type StanceOutcome =
  | { readonly kind: "Saved" }
  | { readonly kind: "Removed" }
  | { readonly kind: "Superseded" }
  | { readonly kind: "Capacity"; readonly reason: ReaderCapacityReason }
  | { readonly kind: "Absent" }
  | { readonly kind: "Failed"; readonly error: unknown };

/**
 * Owns the two stance chords (Take a Side, §4.6): concede (`supports`) and doubt
 * (`contradicts`) drive the stance command from the focused passage with no
 * dialog and no AI (N-2). The server materializes a passage anchor when the
 * focused passage resolves, falling back to durable media. Pressing the same key
 * again toggles the mark off through DELETE; the opposite key is ONE `putStance`
 * that transactionally replaces the single directed stance — never a client
 * delete-then-create (§ Stance).
 *
 * The composer owns one press at a time: a new press (and unmount) aborts the
 * previous press's target resolution, and a superseded press writes nothing.
 */
export function useStanceComposer({
  resolveTarget,
  onChanged,
}: {
  /** Resolve the focused/created source highlight + its media-grain target ref. */
  resolveTarget: (kind: StanceKind, signal: AbortSignal) => Promise<StanceTarget>;
  onChanged: () => void;
}): { mintStance: (kind: StanceKind) => Promise<StanceOutcome> } {
  const pressRef = useRef<AbortController | null>(null);
  useEffect(() => () => pressRef.current?.abort(), []);

  const mintStance = useCallback(
    async (kind: StanceKind): Promise<StanceOutcome> => {
      pressRef.current?.abort();
      const press = new AbortController();
      pressRef.current = press;
      try {
        const resolved = await resolveTarget(kind, press.signal);
        // A later press (or unmount) now owns the stance; this one writes nothing.
        if (press.signal.aborted) return { kind: "Superseded" };
        if (resolved.kind !== "Target") return resolved;

        if (resolved.currentStanceId !== null) {
          await deleteStance(resolved.currentStanceId);
          onChanged();
          return { kind: "Removed" };
        }
        // The opposite stance is one transactional putStance, never a client
        // delete-then-create: putStance replaces the single directed stance.
        await putStance({ sourceRef: `highlight:${resolved.highlightId}`, targetRef: resolved.targetRef, kind });
        onChanged();
        return { kind: "Saved" };
      } catch (error) {
        return press.signal.aborted ? { kind: "Superseded" } : { kind: "Failed", error };
      }
    },
    [onChanged, resolveTarget],
  );

  return { mintStance };
}
