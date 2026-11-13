"use client";

import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { createRandomId } from "@/lib/createRandomId";
import type { Capture, ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { WorkGuard } from "@/lib/unsavedWork";
import { getChatDraft, type Draft } from "./drafts";
import { type SelectionEditor } from "./selection";
import type { RunCreateRequest } from "./wire";

/** A draft retains its browser capture; admission proves it before saving words. */
export interface ReaderQuote {
  readonly id: string;
  readonly attachment: RunCreateRequest["attachments"][number];
}
export function captureReaderQuote(input: {
  readonly scope: { readonly kind: "media"; readonly media_id: string } | { readonly kind: "x_capture" };
  readonly capture: Capture | null;
  readonly annotation: ReaderAnnotation | null;
}): ReaderQuote | null {
  if (input.annotation) return { id: createRandomId(), attachment: { kind: "Reference",
    reference: { resource_ref: `highlight:${input.annotation.id}`, field: null, locator: null } } };
  const { capture, scope } = input;
  if (capture === null) return null;
  return { id: createRandomId(), attachment: { kind: "Selection",
    reading_ref: scope.kind === "media" ? `media:${scope.media_id}` : capture.sourceRef,
    source_ref: capture.sourceRef, capture: capture.selection } };
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
