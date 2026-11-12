"use client";

import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { createRandomId } from "@/lib/createRandomId";
import type { Capture, ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { sourceTarget, type ReaderDocument } from "@/lib/documentReader/model";
import type { WorkGuard } from "@/lib/unsavedWork";
import { getChatDraft, type Draft } from "./drafts";
import { type SelectionEditor } from "./selection";
import type { LiveReference } from "./wire";

/** Only live identity and coordinates travel with a draft. */
export interface ReaderQuote {
  readonly id: string;
  readonly reference: LiveReference;
}
export function captureReaderQuote(input: {
  readonly doc: ReaderDocument;
  readonly scope: { readonly kind: "media"; readonly media_id: string } | { readonly kind: "x_capture"; readonly capture_id: string };
  readonly anchor: MarkAnchor | null;
  readonly capture: Capture | null;
  readonly annotation: ReaderAnnotation | null;
}): ReaderQuote | null {
  const { doc, scope, anchor, annotation } = input;
  if (annotation) {
    const reference: LiveReference = { resource_ref: `highlight:${annotation.id}`, field: null, locator: null };
    return { id: createRandomId(), reference };
  }
  if (anchor === null) return null;
  const target = sourceTarget(doc, anchor.kind === "text" ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end }
    : { kind: "quads", page: anchor.page, quads: anchor.quads });
  if (target === null) return null;
  const resourceRef = input.capture?.sourceRef ?? (scope.kind === "media" ? `media:${scope.media_id}` : null);
  if (resourceRef === null) return null;
  const captured = input.capture?.selection.locator;
  if (!captured) return null;
  let locator: LiveReference["locator"];
  if (captured.type === "pdf_page_geometry") locator = { kind: "PdfPageGeometry", page_number: captured.page_number, quads: [...captured.quads] };
  else if ("fragment_id" in captured && "start_offset" in captured && "end_offset" in captured) {
    const coordinates = { fragment_id: captured.fragment_id, start_offset: captured.start_offset, end_offset: captured.end_offset };
    locator = captured.type === "epub_fragment_offsets" ? { kind: "EpubTextOffsets", ...coordinates }
      : doc.kind === "text" && doc.format === "transcript" ? { kind: "TranscriptTextOffsets", ...coordinates, time_range: null }
        : { kind: "WebTextOffsets", ...coordinates };
  } else return null;
  return { id: createRandomId(), reference: { resource_ref: resourceRef, field: null, locator } };
}

type LaunchContext = Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "isActive">;
export function launchReaderChat(input: {
  ctx: LaunchContext; guard: WorkGuard; originPaneId: string; question: string;
  quote: ReaderQuote; selection: SelectionEditor;
}): { kind: "Opened"; paneId: string } | { kind: "Cancelled" } {
  return launchChatDraft({ ...input, draft: { text: input.question, selection: input.selection, quote: input.quote } });
}

/** The same timeline receives every gesture. Empty questions only focus a draft. */
export function launchChatDraft(input: {
  ctx: LaunchContext; guard: WorkGuard; originPaneId: string; draft: Draft;
}): { kind: "Opened"; paneId: string } | { kind: "Cancelled" } {
  const { ctx } = input;
  if (!ctx.isActive() || ctx.sessionSignal().aborted) return { kind: "Cancelled" };
  const activated = ctx.workspace().activateWorkspaceTarget({ originPaneId: input.originPaneId, target: { href: "/librarian" }, disposition: { kind: "Fork" }, entry: { kind: "FocusLibrarian", send: !!input.draft.text.trim() } });
  if (activated.kind === "Cancelled") return activated;
  const { paneId } = activated;
  const draft = getChatDraft(ctx.accountId, paneId, input.guard);
  draft.setDraft(input.draft);
  return { kind: "Opened", paneId };
}
