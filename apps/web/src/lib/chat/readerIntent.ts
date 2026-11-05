"use client";

import type { ResourceQuotationCapture } from "@/components/resources/ResourceQuotation";
import { excerptView } from "@nexus/authored/excerpt";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retry";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { placeSelection, type Capture, type ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { sourceTarget, type ReaderDocument } from "@/lib/documentReader/model";
import type { SourceArrivalTarget } from "@/lib/resources/sourceTarget";
import type { WorkGuard } from "@/lib/unsavedWork";
import type { WorkspaceStoreValue } from "@/lib/workspace/store";
import { findChatDraft, getChatDraft, type Draft } from "./drafts";
import { getConversationCommands, getNewChatCommands, type SendPreparation } from "./commands";
import { isSelectable, type SelectionEditor } from "./selection";
import { conversationViewHref } from "./view";
import type { Catalog, RunCreateRequest } from "./wire";

type PassageInput = Extract<RunCreateRequest["reader_selection"], { kind: "passage" }>;
type HighlightInput = Omit<Extract<RunCreateRequest["reader_selection"], { kind: "highlight" }>, "revision">;
/** A draft owns its quote before any read or send. Preview never changes its input. */
export interface ReaderQuote {
  readonly id: string;
  readonly input: PassageInput | HighlightInput;
  readonly presentation: ResourceQuotationCapture | null;
  readonly inspection: { readonly href: string; readonly target: SourceArrivalTarget };
  readonly stale: boolean;
}
export interface ReaderQuoteReturn {
  readonly pane_id: string;
  readonly visit_id: string;
  readonly draft_owner_id: string;
  readonly attachment_id: string;
}
export const QUOTE_CHANGED = "the passage changed. review it before sending.";

/** Freeze the displayed saved capture or the complete native selection, without a read. */
export function captureReaderQuote(input: {
  readonly doc: ReaderDocument;
  readonly scope: { readonly kind: "media"; readonly media_id: string } | { readonly kind: "x_capture"; readonly capture_id: string };
  readonly anchor: MarkAnchor | null;
  readonly capture: Capture | null;
  readonly annotation: ReaderAnnotation | null;
  readonly source: ResourceQuotationCapture["source"];
}): ReaderQuote | null {
  const { doc, scope, capture, annotation } = input;
  const shown = annotation?.display?.projection;
  const placed = shown?.selection ? placeSelection(doc, scope.kind === "media" ? scope.media_id : scope.capture_id, shown.selection) : null;
  const anchor = placed?.kind === "placed" ? placed.anchor : input.anchor;
  const target = !anchor || annotation && placed?.kind !== "placed" ? null : sourceTarget(doc, anchor.kind === "text"
    ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end }
    : { kind: "quads", page: anchor.page, quads: anchor.quads });
  if (!annotation && (!target || !capture)) return null;
  const sourceRef = scope.kind === "media" ? `media:${scope.media_id}` : shown?.source_ref ?? capture?.sourceRef;
  if (!target && !sourceRef) return null;
  const captureId = !target && shown?.selection?.locator.type === "x_capture_offsets" ? shown.selection.locator.capture_id : null;
  const href = scope.kind === "media" ? `/media/${scope.media_id}` : `/x/captures/${captureId ?? scope.capture_id}`;
  let selection: ReaderQuote["input"];
  if (annotation) {
    if (!shown?.capture_revision) return null;
    selection = { kind: "highlight", key: { media_id: scope.kind === "media" ? scope.media_id : null,
      capture_id: scope.kind === "x_capture" ? shown.selection?.locator.type === "x_capture_offsets" ? shown.selection.locator.capture_id : scope.capture_id : null,
      highlight_id: annotation.id }, expected_capture_revision: shown.capture_revision };
  } else {
    selection = { kind: "passage", reading_ref: scope.kind === "media" ? `media:${scope.media_id}` : capture!.sourceRef,
      source_ref: capture!.sourceRef, capture: { ...capture!.selection, passage_ref: null } };
  }
  const excerpt = annotation ? shown?.excerpt ?? null : capture ? excerptView(capture.selection.excerpt, "full", { kind: "capture" }) : null;
  return { id: createRandomId(), input: selection, stale: false,
    presentation: excerpt ? { excerpt, source: input.source, href } : null,
    inspection: { href, target: target ? { kind: "reader_destination", destination: { source_identity: doc.identity, target } }
      : { kind: "resource", resource_ref: sourceRef!, field: null } } };
}

export async function getReaderQuotePreview(input: HighlightInput, signal?: AbortSignal): Promise<Schema<"ReaderSelectionPreview">> {
  return (await apiFetch<ApiJson<"/chat-reader-selections/preview", "post">>("/api/chat-reader-selections/preview", {
    method: "POST", body: JSON.stringify({ key: input.key, expected_capture_revision: input.expected_capture_revision }), signal,
  })).data;
}

/** One quote preparation path for reader gestures and ordinary sends. */
export function prepareDraftQuote(quote: ReaderQuote | null): SendPreparation {
  return { attachmentId: quote?.id ?? null, authored: quote?.input.kind === "highlight", quote: async signal => {
    if (quote === null) return null;
    if (quote.input.kind === "passage") return quote.input;
    const input = quote.input;
    const preview = await requestWithRetry(attempt => getReaderQuotePreview(input, attempt), signal);
    return { kind: "highlight", key: preview.key, expected_capture_revision: preview.expected_capture_revision, revision: preview.revision };
  }};
}

/** Replace the exact retained attachment before retiring the reviewer's source. */
export function replaceReaderQuote(workspace: WorkspaceStoreValue, target: ReaderQuoteReturn, quote: ReaderQuote): boolean {
  const pane = workspace.state.panes.find(value => value.id === target.pane_id);
  const draft = findChatDraft(target.draft_owner_id);
  if (pane?.current_visit.id !== target.visit_id || !draft || draft.viewId !== pane.id ||
    new URL(pane.current_visit.href, "https://nexus.invalid").pathname !== `/conversations/${draft.getScope()}` ||
    draft.getSnapshot().draft.quote?.id !== target.attachment_id) return false;
  draft.setQuote(quote);
  workspace.activatePane(pane.id);
  return true;
}

export type ReaderChatLaunchInput = {
  ctx: Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "isActive">;
  guard: WorkGuard;
  originPaneId: string;
  question: string;
  quote: ReaderQuote;
  selection: SelectionEditor;
  catalog: Catalog | null;
  destination: { kind: "New" } | { kind: "Existing"; conversationId: string; write: {
    expected_revision: number;
    insertion: Extract<RunCreateRequest["destination"], { kind: "Existing" }>["insertion"];
  } | null };
};

/** Adoption, loss protection and optional reservation belong to the same gesture. */
export function launchReaderChat(input: ReaderChatLaunchInput): { kind: "Opened"; paneId: string } | { kind: "Cancelled" } {
  return launchChatDraft({ ctx: input.ctx, guard: input.guard, originPaneId: input.originPaneId,
    draft: { text: input.question, selection: input.selection, quote: input.quote }, catalog: input.catalog, destination: input.destination });
}

/** A new destination takes the complete draft before its gesture starts a write. */
export function launchChatDraft(input: {
  ctx: ReaderChatLaunchInput["ctx"];
  guard: WorkGuard;
  originPaneId: string;
  draft: Draft;
  catalog: Catalog | null;
  destination: ReaderChatLaunchInput["destination"];
}): { kind: "Opened"; paneId: string } | { kind: "Cancelled" } {
  const { ctx, destination } = input;
  if (!ctx.isActive() || ctx.sessionSignal().aborted) return { kind: "Cancelled" };
  const submitted = input.draft;
  const { quote, selection } = submitted;
  const scope = destination.kind === "New" ? "new" : destination.conversationId;
  const href = `/conversations/${scope}`;
  const activated = ctx.workspace().activateWorkspaceTarget({ originPaneId: input.originPaneId, target: { href }, disposition: { kind: "Fork" } });
  if (activated.kind === "Cancelled") return activated;
  const { paneId } = activated;
  const visitId = ctx.workspace().state.panes.find(pane => pane.id === paneId)!.current_visit.id;
  const draft = getChatDraft(ctx.accountId, paneId, scope, input.guard);
  try {
    draft.setDraft(submitted);
    const owner = destination.kind === "New" ? getNewChatCommands(ctx.accountId, paneId) : getConversationCommands(ctx.accountId, destination.conversationId);
    if (!submitted.text.trim() || quote?.stale || selection.kind !== "Selected" || input.catalog === null ||
      !isSelectable(input.catalog, selection.selection, selection.route) || !owner.canExecute() ||
      destination.kind === "Existing" && destination.write === null) return { kind: "Opened", paneId };
    const currentVisit = () => {
      const current = ctx.workspace().state.panes.find(pane => pane.id === paneId)?.current_visit;
      return ctx.isActive() && !ctx.sessionSignal().aborted && current?.id === visitId && new URL(current.href, "https://nexus.invalid").pathname === href;
    };
    const request = { destination: destination.kind === "New" ? { kind: "New" as const }
      : { kind: "Existing" as const, conversation_id: destination.conversationId, ...destination.write! },
      content: submitted.text, selection: selection.selection, reader_selection: null };
    // execute reserves synchronously; its promise observes every async failure at the destination.
    void owner.execute({ kind: "Send", request, selectionRoute: selection.route, runId: createRandomId(), viewId: paneId, openIntent: "default" }, receipt => {
      const current = currentVisit();
      draft.accept(receipt, submitted, current, visitId);
      if (!current) return;
      const target = conversationViewHref(receipt.outcome.conversation_id, receipt.outcome.assistant_message_id);
      if (destination.kind === "New") ctx.workspace().navigatePane(paneId, target, { replace: true, activate: false });
      else {
        const visit = ctx.workspace().state.panes.find(pane => pane.id === paneId)!.current_visit;
        const leaf = new URL(visit.href, "https://nexus.invalid").searchParams.get("leaf");
        const previous = destination.write!.insertion;
        if (leaf === null || leaf === (previous.kind === "Empty" ? "empty" : previous.parent_message_id))
          ctx.workspace().updatePaneViewHref({ paneId, visitId, href: target, arrival: "clear" });
      }
    }, prepareDraftQuote(quote), failure => draft.reportDefect(failure, visitId)).then(outcome => {
      if (outcome.kind === "Failed") {
        if (quote && (outcome.rejection === "E_READER_SELECTION_STALE" || outcome.error?.code === "E_READER_SELECTION_STALE")) draft.markQuoteStale(quote.id);
        else draft.refuse({ line: outcome.line, error: outcome.error });
      }
    });
  } catch (error) { draft.reportDefect({ error, occurrence: 1 }, visitId); }
  return { kind: "Opened", paneId };
}
