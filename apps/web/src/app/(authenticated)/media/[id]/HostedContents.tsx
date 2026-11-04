"use client";

// Only the active hosted contents body owns inspection. A failed jump is the reader's to say; it
// raises while the contents modal is topmost, so it shows there.
// The reader owns departure/progress; the shell owns presentation and focus.
import { useLayoutEffect, useRef } from "react";
import { assertNever } from "@/lib/assertNever";
import { PieceDetails, SourcePieces } from "@/components/media/containedWorks/Pieces";
import { Contents, SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderDestination } from "@/lib/documentReader/location";
import { localTarget } from "@/lib/documentReader/model";
import type { MediaDetail } from "@/lib/media/mediaDetail";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { getInteractionGeneration, getInteractionOwner } from "@/lib/ui/overlay";

export default function HostedContents({ id, media, reader, focusTarget }: {
  readonly id: string;
  readonly media: MediaDetail | null;
  readonly reader: Reader;
  readonly focusTarget: () => HTMLElement | null;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "HostedContents");
  const doc = useReaderState(reader, state => state.document.status === "ready" && state.document.doc.kind === "text" ? state.document.doc : null);
  const request = useRef<AbortController | null>(null);
  const publication = doc ? JSON.stringify([doc.identity, doc.generation, doc.part]) : null;
  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [publication, reader, runtime.visitId]);

  const navigate = async (destination: ReaderDestination) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const owner = getInteractionOwner();
    const generation = getInteractionGeneration();
    const current = () => {
      const state = reader.getState().document;
      return request.current === controller && !controller.signal.aborted && state.status === "ready"
        && state.doc.kind === "text" && JSON.stringify([state.doc.identity, state.doc.generation, state.doc.part]) === publication
        && getInteractionOwner() === owner && getInteractionGeneration() === generation;
    };
    const outcome = await reader.inspect({ signal: controller.signal, target: () => {
      const state = reader.getState().document;
      if (!current() || state.status !== "ready" || state.doc.identity !== destination.source_identity) return null;
      const target = localTarget(state.doc, destination.target);
      return target?.kind === "evidence_item" ? null : target;
    } });
    if (!current()) {
      controller.abort();
      if (request.current === controller) request.current = null;
      return;
    }
    // A successful inspection's paint outlives this body. Release before dismissal.
    request.current = null;
    switch (outcome.kind) {
      case "Arrived":
      case "Unchanged": {
        const target = focusTarget();
        if (target) runtime.revealPrimary({ focusTarget: target });
        break;
      }
      case "Unavailable":
      case "Cancelled": break;
      default: assertNever(outcome);
    }
  };
  if (!doc) return null;
  const onNavigate = (destination: ReaderDestination) => { void navigate(destination); };
  const rich = media?.kind === "epub" || media?.kind === "web_article" && media.provider !== "x"
    && !doc.embeds.some(embed => embed.provider === "x" && embed.kind === "post");
  return <>
    <SourceIssuesNotice issues={doc.sourceIssues} />
    {media?.kind === "text_part" ? <><PieceDetails id={id} sourceHref={media.part_source?.href ?? null} /><Contents reader={reader} onNavigate={onNavigate} /></>
      : rich ? <SourcePieces source={id} reader={reader} onNavigate={onNavigate} /> : <Contents reader={reader} onNavigate={onNavigate} />}
  </>;
}
