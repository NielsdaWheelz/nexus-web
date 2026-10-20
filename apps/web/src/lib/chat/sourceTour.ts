"use client";

// One account-local source walk. A read can replace the ready walk only while its
// request and originating pane still own attention; route arrivals own their focus.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedbackContextValue, FeedbackOffer } from "@/components/feedback/Feedback";
import { readConversationTree, type ConversationTree } from "@/lib/chat/commands";
import { readForNavigation } from "@/lib/panes/openResult";
import { activateResource, type ResourceActivation } from "@/lib/resources/activation";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { WorkspaceStoreValue } from "@/lib/workspace/store";

export interface SourceTourStep {
  readonly title: string;
  readonly sentence: string | null;
  readonly activation: ResourceActivation;
}

export interface ReadySourceTour {
  readonly steps: readonly SourceTourStep[];
  readonly index: number;
}

/** The sentence holding `[ordinal]`, unless the marker lies inside inline code. */
function citingSentence(text: string, ordinal: number): string | null {
  const marker = `[^.\\n]*\\[${ordinal}\\](?!\\()[^.\\n]*\\.?`;
  const sentence = new RegExp(marker).exec(text)?.[0].trim();
  return sentence && sentence.split("`").length % 2 ? sentence : null;
}

export function useSourceTour(input: {
  workspace: () => WorkspaceStoreValue;
  sessionSignal: () => AbortSignal;
  feedback: FeedbackContextValue;
}) {
  const latest = useRef(input);
  latest.current = input;
  const [tour, setTour] = useState<ReadySourceTour | null>(null);
  const current = useRef<ReadySourceTour | null>(null);
  const request = useRef(0);
  const restartOffer = useRef<FeedbackOffer | null>(null);
  const initialFocus = useRef<{ tour: ReadySourceTour; from: Element | null } | null>(null);

  const navigate = useCallback((step: SourceTourStep, originPaneId: string, intent: OpenIntent) => {
    if (step.activation.kind !== "route") return;
    const workspace = latest.current.workspace();
    activateResource(step.activation, {
      labelHint: step.title,
      disposition: { kind: intent === "new_pane" ? "Fork" : "Follow" },
      activateTarget: target => workspace.activateWorkspaceTarget({ originPaneId, ...target }),
    });
  }, []);

  const install = useCallback((steps: readonly SourceTourStep[], originPaneId: string, intent: OpenIntent) => {
    const next: ReadySourceTour = { steps, index: 0 };
    initialFocus.current = steps[0].activation.kind === "route" ? null : { tour: next, from: document.activeElement };
    current.current = next;
    setTour(next);
    navigate(steps[0], originPaneId, intent);
  }, [navigate]);

  const start = useCallback(async ({ conversationId, messageId, originPaneId, intent }: {
    conversationId: string;
    messageId: string;
    originPaneId: string;
    intent: OpenIntent;
  }): Promise<void> => {
    const identity = ++request.current;
    restartOffer.current?.withdraw();
    restartOffer.current = null;
    const ctx = latest.current;
    const signal = ctx.sessionSignal();
    let result: { kind: "Aborted" } | { kind: "Ready"; value: ConversationTree | null; mayOpen: boolean };
    try {
      result = await readForNavigation({
        ctx, originPaneId, initiatingLayer: null,
        read: () => readConversationTree(conversationId),
      });
    } catch (error) {
      if (identity !== request.current || signal.aborted) return;
      throw error;
    }
    if (identity !== request.current || signal.aborted || result.kind === "Aborted") return;
    const message = result.value?.messages.find(item => item.id === messageId);
    if (!message || message.role !== "assistant" || message.citations.length < 2) {
      ctx.feedback.offer({
        key: `source-tour:${messageId}`,
        content: { tone: "Neutral", title: message ? "source walk unavailable" : "This message is no longer available." },
        announcement: "Polite",
      });
      return;
    }
    const steps: SourceTourStep[] = [...message.citations].sort((a, b) => a.ordinal - b.ordinal).map(citation => ({
      title: citation.item.preview.source?.title ?? citation.item.label,
      sentence: citingSentence(message.content, citation.ordinal),
      activation: citation.item.activation,
    }));
    if (result.mayOpen) {
      install(steps, originPaneId, intent);
      return;
    }
    const offer = ctx.feedback.offer({
      key: `source-tour:${messageId}`,
      content: { tone: "Success", title: "source walk ready" },
      announcement: "Polite",
      actions: [{ label: "start source walk", onClick: freshIntent => {
        if (identity !== request.current || signal.aborted) return;
        offer.withdraw();
        restartOffer.current = null;
        const paneId = latest.current.workspace().state.active_primary_pane_id;
        install(steps, paneId, freshIntent);
      } }],
      returnFocus: () => {
        const paneId = latest.current.workspace().state.active_primary_pane_id;
        return findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
      },
    });
    restartOffer.current = offer;
  }, [install]);

  const move = useCallback((direction: "previous" | "next", intent: OpenIntent = "default") => {
    const before = current.current;
    if (!before) return;
    const index = before.index + (direction === "next" ? 1 : -1);
    if (index < 0 || index >= before.steps.length) return;
    const next = { ...before, index };
    initialFocus.current = null;
    current.current = next;
    setTour(next);
    const originPaneId = latest.current.workspace().state.active_primary_pane_id;
    navigate(next.steps[index], originPaneId, intent);
  }, [navigate]);

  const leave = useCallback(() => {
    ++request.current;
    restartOffer.current?.withdraw();
    restartOffer.current = null;
    initialFocus.current = null;
    if (document.activeElement?.closest("[data-source-tour-band]") && !hasActiveInteractionOwner()) {
      const paneId = latest.current.workspace().state.active_primary_pane_id;
      (findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId))?.focus({ preventScroll: true });
    }
    current.current = null;
    setTour(null);
  }, []);

  const consumeStartFocus = useCallback((ready: ReadySourceTour): boolean => {
    const pending = initialFocus.current;
    if (pending?.tour !== ready) return false;
    initialFocus.current = null;
    return document.activeElement === pending.from && !hasActiveInteractionOwner();
  }, []);

  const openExternal = useCallback((intent: OpenIntent) => {
    const step = current.current?.steps[current.current.index];
    if (!step || step.activation.kind !== "external") return;
    const workspace = latest.current.workspace();
    activateResource(step.activation, {
      disposition: { kind: intent === "new_pane" ? "Fork" : "Follow" },
      activateTarget: target => workspace.activateWorkspaceTarget({
        originPaneId: workspace.state.active_primary_pane_id, ...target,
      }),
    });
  }, []);

  useEffect(() => {
    const signal = latest.current.sessionSignal();
    const retire = () => {
      ++request.current;
      restartOffer.current?.withdraw();
      restartOffer.current = null;
      initialFocus.current = null;
    };
    signal.addEventListener("abort", retire, { once: true });
    return () => {
      signal.removeEventListener("abort", retire);
      retire();
    };
  }, []);

  return useMemo(() => ({ tour, start, move, leave, consumeStartFocus, openExternal }),
    [tour, start, move, leave, consumeStartFocus, openExternal]);
}
