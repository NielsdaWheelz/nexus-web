"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useWorkspaceCondition,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { apiTransportFeedback } from "@/lib/api/client";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { modeledApiError, usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import {
  createAdmissionRecovery,
  EMPTY_ADMISSIONS,
  type AdmissionEntry,
  type AdmissionRecovery,
} from "@/lib/media/admissionRecovery";
import { startMetadataAccount } from "@/lib/media/mediaMetadataOperations";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import { openAsyncResult } from "@/lib/panes/openResult";
import { resolveResourceItem } from "@/lib/resources/items";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useLatestWorkspace } from "@/lib/workspace/store";

const Context = createContext<AdmissionRecovery | null>(null);

/** Account-keyed shell owner; neither a pane nor Imports controls its lifetime. */
export function AdmissionRecoveryProvider({ accountId, children }: {
  accountId: string;
  children: ReactNode;
}) {
  const owner = useMemo(() => createAdmissionRecovery(accountId), [accountId]);
  useLayoutEffect(() => {
    const stopMetadata = startMetadataAccount(accountId);
    const stopRecovery = owner.start();
    return () => {
      stopRecovery();
      stopMetadata();
    };
  }, [accountId, owner]);
  return <Context value={owner}>{children}</Context>;
}

export function useAdmissionRecovery() {
  const owner = useContext(Context);
  if (owner === null) throw new Error("AdmissionRecoveryProvider is missing");
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, () => EMPTY_ADMISSIONS);
  return useMemo(() => ({
    admit: owner.admit,
    confirm: owner.confirm,
    retryCleanup: owner.retryCleanup,
    pending: owner.pending,
    snapshot,
  }), [owner, snapshot]);
}

/** Presentation sits inside WorkspaceStore; the high owner has no navigation dependency. */
export function AdmissionRecoveryHost() {
  const { snapshot } = useAdmissionRecovery();
  useWorkspaceCondition("media-admission-storage", snapshot.problem === null ? null : {
    priority: "Action",
    announcement: "Polite",
    content: snapshot.problem.content,
  });
  return snapshot.entries.map(entry => <AdmissionCondition key={entry.key} entry={entry} />);
}

function AdmissionCondition({ entry }: { entry: AdmissionEntry }) {
  const { ctx } = useActionRuntime();
  const owner = useAdmissionRecovery();
  const fail = useThrowLater();
  const workspace = useLatestWorkspace();
  const { isMobile } = useViewportState();
  const scope = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState<FeedbackContent | null>(null);
  useLayoutEffect(() => {
    const current = new AbortController();
    scope.current = current;
    return () => {
      current.abort();
      if (scope.current === current) scope.current = null;
    };
  }, []);
  const resource = usePaneFreeServerValue({
    key: `admission-resource:${entry.intent.mediaId}`,
    stale: "",
    load: signal => resolveResourceItem(`media:${entry.intent.mediaId}`, signal),
  });
  const label = resource.status === "ready" && !resource.data.missing ? resource.data.label : null;
  const subject = entry.intent.kind === "SourceRefresh" ? "source refresh" : "metadata request";
  let content: FeedbackContent;
  switch (entry.kind) {
    case "Sending":
      content = { tone: "Neutral", title: `sending ${subject}` };
      break;
    case "Unconfirmed":
      content = {
        tone: "Warning", title: `${subject} unconfirmed`,
        message: "the request may have started. confirming can start it if it did not; it always uses the original request.",
        requestId: entry.requestId,
      };
      break;
    case "Blocked":
      content = entry.content;
      break;
    case "Cleanup":
      content = {
        tone: "Warning",
        title: `${subject} ${entry.settlement === "Accepted" ? "confirmed" : "not started"}`,
        message: "the browser couldn't remove its recovery record. cleanup only removes that record; it sends no request.",
      };
      break;
  }
  if (label !== null) content = { ...content, title: `${content.title} · ${label}` };
  if (openFailure !== null) content = { ...content,
    message: [content.message, openFailure.title, openFailure.message].filter(Boolean).join(" "),
    requestId: openFailure.requestId ?? content.requestId,
  };

  const openItem = async (intent: OpenIntent) => {
    const current = scope.current;
    if (current === null || opening) return;
    setOpening(true);
    try {
      await openAsyncResult({
        ctx, intent, disposition: isMobile ? "Follow" : "Adopt",
        create: async () => {
          const item = await resolveResourceItem(`media:${entry.intent.mediaId}`, ctx.sessionSignal());
          if (item.missing || item.activation.kind !== "route" || item.activation.href === null) {
            if (scope.current === current) setOpenFailure({ tone: "Warning", title: "this item can't be opened from its current state." });
            return null;
          }
          if (scope.current === current) setOpenFailure(null);
          return { target: { href: item.activation.href, labelHint: item.label }, title: "item available", openLabel: "open item" };
        },
      });
    } catch (error) {
      if (scope.current !== current || current.signal.aborted) return;
      const modeled = modeledApiError(error, fail);
      if (modeled !== null) {
        const feedback = apiTransportFeedback(modeled, "couldn't open this item.");
        if (feedback === null) fail({ error });
        else setOpenFailure(feedback);
      }
    } finally {
      if (scope.current === current && !current.signal.aborted) setOpening(false);
    }
  };
  const open = {
    label: "open item", href: `/media/${entry.intent.mediaId}`, busy: opening,
    onActivate: (event: TargetActivationEvent) => {
      const activation = workspaceTargetActivationIntent(event);
      if (activation.kind === "Unowned") return "unhandled" as const;
      event.preventDefault();
      if (activation.kind === "Consume" || opening) return "consumed" as const;
      void openItem(activation.intent);
      return activation.intent === "new_pane" ? "handled-new-pane" as const : "handled-default" as const;
    },
  };
  let actions: FeedbackActions;
  if (entry.kind === "Cleanup") {
    actions = [{ label: "retry cleanup", onClick: () => {
      void owner.retryCleanup(entry.key).catch(error => fail({ error }));
    } }, open];
  } else if (entry.kind === "Blocked" && !entry.canConfirm) {
    actions = [open];
  } else {
    actions = [{ label: "confirm request", busy: entry.kind === "Sending", onClick: () => {
      void owner.confirm(entry.key).catch(error => fail({ error }));
    } }, open];
  }
  useWorkspaceCondition(`media-admission:${entry.key}`, {
    priority: entry.kind === "Cleanup" ? "Action" : "Write",
    content,
    announcement: "Polite",
    actions,
    returnFocus: () => findPaneLandmarkFocusTarget(workspace().state.active_primary_pane_id),
  });
  return null;
}
