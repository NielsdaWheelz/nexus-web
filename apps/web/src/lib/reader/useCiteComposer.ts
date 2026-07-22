"use client";

import { useCallback, useState } from "react";
import { createUserEdge } from "@/lib/resourceGraph/edges";
import type { HighlightActionTarget } from "@/components/highlights/highlightActions";

/**
 * Owns the Cite verb (§4.5): opens the CitePicker over a resolved source
 * highlight, then mints a cross-document footnote edge
 * (`highlight → evidence_span | media`, kind `context`, origin `user`) through
 * the one user-edge writer (createUserEdge sends only source/target/kind — the
 * server forbids any edge payload on user origins, N-3). No AI (N-2).
 */
export interface CiteComposer {
  open: boolean;
  sourceHighlightId: string | null;
  openCite: (target: HighlightActionTarget) => Promise<void>;
  close: () => void;
  cite: (targetRef: string) => Promise<void>;
}

export function useCiteComposer({
  createHighlightForSelection,
  onCited,
}: {
  /** Create a highlight from the live selection; returns its id (or null). */
  createHighlightForSelection: () => Promise<string | null>;
  /** Refresh canonical Reader Evidence so the footnote appears. */
  onCited: () => void;
}): CiteComposer {
  const [open, setOpen] = useState(false);
  const [sourceHighlightId, setSourceHighlightId] = useState<string | null>(
    null,
  );

  const openCite = useCallback(
    async (target: HighlightActionTarget) => {
      const highlightId =
        target.kind === "existing"
          ? target.highlight.id
          : await createHighlightForSelection();
      if (!highlightId) return;
      setSourceHighlightId(highlightId);
      setOpen(true);
    },
    [createHighlightForSelection],
  );

  const close = useCallback(() => {
    setOpen(false);
    setSourceHighlightId(null);
  }, []);

  const cite = useCallback(
    async (targetRef: string) => {
      if (!sourceHighlightId) return;
      await createUserEdge({
        sourceRef: `highlight:${sourceHighlightId}`,
        targetRef,
        kind: "context",
      });
      onCited();
      close();
    },
    [close, onCited, sourceHighlightId],
  );

  return { open, sourceHighlightId, openCite, close, cite };
}
