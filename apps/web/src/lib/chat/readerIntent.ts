"use client";

import type { ResourceQuotationCapture } from "@/components/resources/ResourceQuotation";
import type { Line } from "@/components/feedback/stage";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import type { Capture } from "@/lib/documentReader/annotations";
import type { WorkGuard } from "@/lib/unsavedWork";
import { requestWithRetry } from "@/lib/api/retry";
import { createRandomId } from "@/lib/createRandomId";
import { getChatDraft, type Draft, type DraftQuote } from "./drafts";
import { getConversationCommands, getNewChatCommands, type SendPreparation } from "./commands";
import { isSelectable, type SelectionEditor } from "./selection";
import { conversationViewHref } from "./view";
import type { Catalog, RunCreateRequest } from "./wire";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { isCanonicalUuid } from "@/lib/validation";

// Saved-highlight links name a key; raw passage launches transfer their capture
// directly into the destination's retained draft.

export type ReaderSelectionKey = Readonly<{
  mediaId: string | null;
  captureId: string | null;
  highlightId: string;
}>;
export type ReaderHighlightChatIntent = Readonly<{
  destination: { kind: "New" } | { kind: "Existing"; conversationId: string };
  key: ReaderSelectionKey;
}>;

export async function getReaderQuotePreview(input: {
  key: ReaderSelectionKey;
  signal?: AbortSignal;
}): Promise<Schema<"ReaderSelectionPreview">> {
  const query = input.key.captureId ? `capture_id=${input.key.captureId}` : `media_id=${input.key.mediaId}`;
  const path = `/api/chat-reader-selections/highlights/${input.key.highlightId}?${query}`;
  // justify-type-assertion: the query string extends the generated route literal.
  return (await apiFetch<ApiJson<"/chat-reader-selections/highlights/{highlight_id}", "get">>(
    path as ApiPath, { signal: input.signal },
  )).data;
}

/** A trusted value that is not canonical is a programmer error. */
export function assumeReaderSelectionKey(raw: {
  mediaId?: string | null;
  captureId?: string | null;
  highlightId: string;
}): ReaderSelectionKey {
  const mediaId = raw.mediaId ?? null, captureId = raw.captureId ?? null;
  if ((mediaId === null) === (captureId === null) || !isCanonicalUuid(mediaId ?? captureId) || !isCanonicalUuid(raw.highlightId))
    throw new Error(`Noncanonical reader selection key ${JSON.stringify(raw)}`);
  return { mediaId, captureId, highlightId: raw.highlightId };
}

/** An empty hash is no intent; any other non-canonical hash is a route error. */
export function parseReaderSelectionHash(
  hash: string,
):
  | { kind: "none" }
  | { kind: "key"; key: ReaderSelectionKey }
  | { kind: "invalid" } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { kind: "none" };
  // A canonical uuid encodes to itself, so the raw text is the value.
  const match = /^(mediaId|captureId)=([^&]*)&highlightId=([^&]*)$/.exec(raw);
  const [kind, source, highlightId] = match ? [match[1], match[2], match[3]] : [null, null, null];
  return isCanonicalUuid(source) && isCanonicalUuid(highlightId)
    ? { kind: "key", key: { mediaId: kind === "mediaId" ? source : null, captureId: kind === "captureId" ? source : null, highlightId } }
    : { kind: "invalid" };
}

export function readerHighlightChatIntentHref(
  intent: ReaderHighlightChatIntent,
): string {
  const path =
    intent.destination.kind === "New"
      ? "/conversations/new"
      : `/conversations/${intent.destination.conversationId}`;
  return `${path}#${intent.key.captureId ? `captureId=${intent.key.captureId}` : `mediaId=${intent.key.mediaId}`}&highlightId=${intent.key.highlightId}`;
}

export type ReaderChatLaunchInput = {
  ctx: Pick<ActionContext, "accountId" | "workspace" | "sessionSignal" | "isActive">;
  guard: WorkGuard;
  originPaneId: string;
  question: string;
  capture: Capture | null;
  sourceMediaId: string | null;
  captureId: string | null;
  highlightId: string | null;
  selection: SelectionEditor;
  catalog: Catalog | null;
  destination: { kind: "New" } | { kind: "Existing"; conversationId: string; write: {
    expected_revision: number;
    insertion: Extract<RunCreateRequest["destination"], { kind: "Existing" }>["insertion"];
  } | null };
  source: ResourceQuotationCapture["source"];
  href: string | null;
};

/** One quote preparation owner, shared by a reader gesture and the ordinary composer. */
export function prepareDraftQuote(quote: DraftQuote | null): SendPreparation {
  return { authored: quote?.kind === "Highlight", quote: async signal => {
    if (quote === null) return null;
    if (quote.kind === "Passage") return { kind: "passage", reading_ref: quote.readingRef,
      source_ref: quote.sourceRef, capture: { ...quote.capture, passage_ref: null } };
    const preview = await requestWithRetry(attempt => getReaderQuotePreview({ key: quote.key, signal: attempt }), signal);
    return { kind: "highlight", key: preview.key, revision: preview.revision };
  }};
}

/** The same gesture transfers input, protects it, and optionally starts its command.
 * Once adopted, all asynchronous outcomes belong to that destination. */
export function launchReaderChat(input: ReaderChatLaunchInput):
  { kind: "Opened"; paneId: string } | { kind: "Cancelled" } | { kind: "Refused"; line: Line } {
  const { ctx, destination, capture, selection } = input;
  if (!ctx.isActive() || ctx.sessionSignal().aborted) return { kind: "Cancelled" };
  if (input.highlightId === null && capture === null)
    return { kind: "Refused", line: { fact: "this passage can’t be quoted." } };
  const presentation = capture ? { capture: capture.selection, source: input.source, href: input.href } : null;
  const quote: DraftQuote = input.highlightId !== null
    ? { kind: "Highlight", key: assumeReaderSelectionKey({ mediaId: input.sourceMediaId, captureId: input.sourceMediaId === null ? input.captureId : null, highlightId: input.highlightId }), presentation }
    : { kind: "Passage", capture: capture!.selection, source: input.source, href: input.href,
        readingRef: input.sourceMediaId === null ? capture!.sourceRef : `media:${input.sourceMediaId}`, sourceRef: capture!.sourceRef };
  return launchChatDraft({ ctx, guard: input.guard, originPaneId: input.originPaneId,
    draft: { text: input.question, selection, quote }, catalog: input.catalog, destination });
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
    if (!submitted.text.trim() || selection.kind !== "Selected" || input.catalog === null ||
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
      if (outcome.kind === "Failed") draft.refuse({ line: outcome.line, error: outcome.error });
    });
  } catch (error) { draft.reportDefect({ error, occurrence: 1 }, visitId); }
  return { kind: "Opened", paneId };
}
