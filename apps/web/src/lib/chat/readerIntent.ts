import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { placeSelection, type Capture, type ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { sourceTarget, type ReaderDocument } from "@/lib/documentReader/model";
import type { SourceArrivalTarget } from "@/lib/resources/sourceTarget";
import type { WritingRuntime } from "@/lib/notes/runtime";
import type { WorkspaceStoreValue } from "@/lib/workspace/store";

// A quote is unsent writing owned by an existing draft. Its source input and
// inspection target are frozen together; preview never creates an authored object.
export type ReaderQuoteState =
  | { readonly kind: "Unprepared" | "Loading" }
  | { readonly kind: "Ready"; readonly preview: Schema<"ReaderSelectionPreview"> }
  | { readonly kind: "Failed"; readonly failure: { readonly kind: "Read"; readonly error: unknown } | { readonly kind: "Stale" }; readonly preview: Schema<"ReaderSelectionPreview"> | null };
export interface ReaderQuote {
  readonly id: string;
  readonly selection: Schema<"ReaderSelectionInput">["selection"];
  readonly inspection: { readonly href: string; readonly target: SourceArrivalTarget };
  readonly state: ReaderQuoteState;
}
export interface ReaderQuoteReturn {
  readonly pane_id: string;
  readonly visit_id: string;
  readonly draft_owner_id: string;
  readonly attachment_id: string;
}
export const QUOTE_CHANGED = "the passage changed. review it before sending.";

/** Freeze the displayed projection before any await, including its authored upload. */
export function captureReaderQuote(input: {
  readonly doc: ReaderDocument;
  readonly scope: { readonly kind: "media"; readonly media_id: string } | { readonly kind: "x_capture"; readonly capture_id: string };
  readonly anchor: MarkAnchor | null;
  readonly capture: Capture | null;
  readonly annotation: ReaderAnnotation | null;
}): ReaderQuote | null {
  const { doc, scope, capture, annotation } = input;
  const shown = annotation?.display?.projection;
  const placed = shown?.selection ? placeSelection(doc, scope.kind === "media" ? scope.media_id : scope.capture_id, shown.selection) : null;
  const anchor = placed?.kind === "placed" ? placed.anchor : input.anchor;
  const target = !anchor || annotation && placed?.kind !== "placed" ? null : sourceTarget(doc, anchor.kind === "text"
    ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end }
    : { kind: "quads", page: anchor.page, quads: anchor.quads });
  if (!target && !annotation) return null;
  const reading = { ...scope, document_identity: doc.identity };
  const revision = shown?.capture_revision;
  let selection: ReaderQuote["selection"];
  if (annotation) {
    if (!revision) return null;
    selection = { kind: "highlight", scope: reading, highlight_id: annotation.id, expected_capture_revision: revision };
  } else {
    const locator = capture?.selection.locator;
    const text_quote_selector = locator?.text_quote_selector;
    if (!locator || !text_quote_selector) return null;
    switch (locator.type) {
      case "web_text_offsets":
        selection = { kind: "source", scope: reading, locator: { ...locator, media_kind: null, text_quote_selector } }; break;
      case "epub_fragment_offsets":
        selection = { kind: "source", scope: reading, locator: { ...locator, media_kind: null, section_id: null, text_quote_selector } }; break;
      case "x_capture_offsets":
        selection = { kind: "source", scope: reading, locator: { ...locator, text_quote_selector } }; break;
      case "pdf_page_geometry":
        selection = { kind: "source", scope: reading, locator: { ...locator, projection: null, text_quote_selector } }; break;
    }
  }
  const sourceRef = scope.kind === "media" ? `media:${scope.media_id}` : shown?.source_ref;
  if (!target && !sourceRef) return null;
  const captureId = !target && shown?.selection?.locator.type === "x_capture_offsets" ? shown.selection.locator.capture_id : null;
  const inspection: ReaderQuote["inspection"] = {
    href: scope.kind === "media" ? `/media/${scope.media_id}` : `/x/captures/${captureId ?? scope.capture_id}`,
    target: target ? { kind: "reader_destination", destination: { source_identity: doc.identity, target } }
      : { kind: "resource", resource_ref: sourceRef!, field: null },
  };
  return { id: createRandomId(), selection, inspection, state: { kind: "Unprepared" } };
}

/** Both composers use this read. The caller installs only into its unchanged attachment. */
export async function prepareReaderQuote(quote: ReaderQuote, writing: WritingRuntime, signal: AbortSignal): Promise<Schema<"ReaderSelectionPreview">> {
  if (quote.selection.kind === "highlight") {
    const committed = (await (await writing.store).readReplica()).command_seq;
    await writing.whenUploaded(committed, signal);
  }
  return (await apiFetch<ApiJson<"/chat-reader-selections/preview", "post">>(
    "/api/chat-reader-selections/preview", { method: "POST", body: JSON.stringify({ selection: quote.selection }), signal },
  )).data;
}

/** Return to this exact visit, including an unsent /new pane; href alone is ambiguous. */
export function replaceReaderQuote(workspace: WorkspaceStoreValue, target: ReaderQuoteReturn, quote: ReaderQuote): boolean {
  const pane = workspace.state.panes.find(pane => pane.id === target.pane_id);
  if (pane?.current_visit.id !== target.visit_id) return false;
  return workspace.activateWorkspaceTarget({ originPaneId: pane.id, target: { href: pane.current_visit.href },
    disposition: { kind: "Follow" }, entry: { kind: "ReplaceReaderQuote", target, quote } }).kind !== "Cancelled";
}
