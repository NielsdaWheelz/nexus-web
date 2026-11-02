"use client";

import { remoteAttemptAllowed, subscribeAdmission, updateRemedy } from "@/lib/native/admission";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { transportVerbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import { BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
} from "@/lib/actions/ResourceActionsProvider";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { isApiError, isStaleBuild, isUnauthenticatedApiError, outcomeUnknown } from "@/lib/api/client";
import { staleBuild, TRANSPORT_LINES } from "@/lib/api/failure";
import type { Schema } from "@/lib/api/wire";
import {
  METADATA_REVIEW_HELP,
  metadataResearchLabel,
} from "@/lib/media/mediaMetadataCopy";
import { admissionTransport, unadmitted, useMediaAdmissions } from "@/lib/media/admissions";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { submitMetadataResultReview } from "@/lib/media/mediaMetadataOperations";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";

/** Where focus goes once a control leaves: its pane's landmark, else its dialog. */
function homeOf(control: HTMLElement): () => HTMLElement | null {
  const paneId = control.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  const dialog = control.closest<HTMLElement>("[role=dialog]");
  return () => findPaneLandmarkFocusTarget(paneId) ?? dialog;
}

/** Repair focus only when the control owning it actually left the document. */
async function landing(control: HTMLElement, work: () => Promise<void>) {
  const held = document.activeElement === control;
  const home = homeOf(control);
  await work();
  const active = document.activeElement;
  const target = home();
  if (held && !control.isConnected && active === document.body && target?.isConnected)
    target.focus({ preventScroll: true });
}

/** Review one exact no-findings job (history passes its own; the menu is unrelated). */
export function MetadataReviewButton({
  mediaId,
  jobId,
}: {
  readonly mediaId: string;
  readonly jobId: string;
}) {
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState<number | null>(null);
  const { say, fail } = useOutcome();
  const fact = "couldn’t mark this reviewed.";
  const review = async (trigger: HTMLElement | null) => {
    if (pending) return;
    // what admission holds back is never sent, so it is no unknown outcome.
    if (!remoteAttemptAllowed()) {
      const { line, verbs } = unadmitted(fact);
      say(line, verbs ?? undefined);
      return;
    }
    setPending(true);
    try {
      await (trigger ? landing(trigger, () => submitMetadataResultReview(mediaId, jobId)) : submitMetadataResultReview(mediaId, jobId));
      setUnknown(null);
    } catch (error) {
      handleUnauthenticatedApiError(error);
      if (isApiError(error) && (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND")) say({ fact, reason: "this result isn’t available." });
      else if (isApiError(error) && error.code === "E_RESOURCE_CONFLICT") say({ fact, reason: "this result changed." });
      else if (outcomeUnknown(error) && !isUnauthenticatedApiError(error)) setUnknown(attempt => (attempt ?? -1) + 1);
      else fail(error, fact);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
    <Button
      data-metadata-action=""
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      tooltip={{ text: METADATA_REVIEW_HELP }}
      onClick={(event) => void review(event.currentTarget)}
    >
      mark reviewed
    </Button>
    {unknown === null ? null : <Hold id={`metadata-review:${jobId}`} attempt={unknown}
      line={{ fact: "not sure that saved.", reason: "it may have gone through." }}
      verbs={[{ label: "retry", commandKey: `retry metadata-review:${jobId}`, run: () => void review(null), busy: pending }]} />}
    </>
  );
}

/**
 * Research from what this view shows (its `retry`), run as the menu's verb. A title
 * blocked on missing x source context offers the media's own source remedy (refresh,
 * retry or repair), read from its verbs while it is needed.
 * Hosts promote data-metadata-action controls; data-metadata-feedback stays visible.
 */
export default function MetadataResearchActions({
  mediaId,
  view,
  primaryOnly = false,
}: {
  readonly mediaId: string;
  readonly view: Schema<"MetadataEnrichmentView">;
  readonly primaryOnly?: boolean;
}) {
  const { ctx, run } = useActionRuntime();
  const reasonId = useId();
  const admissions = useMediaAdmissions();
  const pending = admissions.pending("MetadataResearch", mediaId);
  const { say, fail } = useOutcome();
  const remedy = useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const heldBack = admissionTransport(useRemoteAdmission());
  const ref = `media:${mediaId}`;
  const { operation, retry } = view;
  const reviewJob =
    operation?.status === "no_findings" && operation.reviewed_at === null
      ? operation.job_id
      : null;
  const remedyNeeded =
    (!primaryOnly || reviewJob === null) &&
    retry.status === "blocked" &&
    retry.reason === "source_context_missing";
  const remedies = useResourceActions(remedyNeeded ? ref : null);
  const { prepare, state } = remedies;
  const remedyRequest = useRef<AbortController | null>(null);
  const remedyFailure = state?.kind === "Failed" ? { error: state.error } : state?.kind === "Loading" ? state.failure : null;
  useEffect(() => {
    if (!remedyNeeded) return;
    const controller = new AbortController();
    remedyRequest.current = controller;
    prepare(controller.signal);
    return () => {
      if (remedyRequest.current === controller) remedyRequest.current = null;
      controller.abort();
    };
  }, [prepare, remedyNeeded]);
  const sourceRemedy = state?.kind === "Ready" ? state.options.find(
    (action) =>
      action.kind === "command" &&
      !action.disabled &&
      (action.id === "RefreshSource" ||
        action.id === "RetrySource" ||
        action.id === "RepairSource"),
  ) : undefined;
  const research = (
    trigger: HTMLButtonElement,
    retry: Schema<"MetadataRetryAllowed">,
  ) => {
    run({
      ref,
      id: "RetryMetadata",
      label: metadataResearchLabel(null, retry.purpose),
      title: "",
      confirmation: null,
      tracked: false,
      execute: () => landing(trigger, async () => {
        const result = await admissions.admit({ kind: "MetadataResearch", mediaId,
          request: { expected_job_id: retry.expected_job_id } });
        if (result.kind !== "LocalFailure") return;
        if (result.error) fail(result.error, result.line.fact);
        else say(result.line, result.verbs ?? undefined);
      }),
    });
  };
  return (
    <>
      {!ctx.online ? <span id={reasonId} className="sr-only">{BLOCKED_COPY.RequiresOnline}</span> : null}
      {reviewJob !== null ? (
        <MetadataReviewButton mediaId={mediaId} jobId={reviewJob} />
      ) : null}
      {pending !== null ? (
        isStaleBuild(pending.error) ? <Button data-metadata-action="" aria-disabled={remedy !== "Reload" || undefined}
          tooltip={remedy === "Reload" ? undefined : { text: staleBuild() }}
          onClick={() => { if (remedy === "Reload") window.location.reload(); }}>
          reload
        </Button> :
        <Button
          data-metadata-action=""
          aria-busy={pending.kind === "sending" || undefined}
          aria-disabled={pending.kind === "sending" || !ctx.online || undefined}
          aria-describedby={!ctx.online ? reasonId : undefined}
          tooltip={ctx.online ? undefined : { text: BLOCKED_COPY.RequiresOnline }}
          onClick={(event) => {
            if (pending.kind === "sending" || !ctx.online) return;
            const trigger = event.currentTarget;
            run({ ref, id: "RetryMetadata", label: "retry", title: "", confirmation: null, tracked: false,
              execute: () => landing(trigger, () => admissions.retry(pending.key)),
            });
          }}
        >retry</Button>
      ) : retry.status === "allowed" && (!primaryOnly || reviewJob === null) ? (
        <Button
          data-metadata-action=""
          aria-disabled={!ctx.online || undefined}
          aria-describedby={!ctx.online ? reasonId : undefined}
          tooltip={ctx.online ? undefined : { text: BLOCKED_COPY.RequiresOnline }}
          onClick={(event) => { if (ctx.online) research(event.currentTarget, retry); }}
        >
          {metadataResearchLabel(operation, retry.purpose)}
        </Button>
      ) : null}
      {remedyNeeded && remedyFailure ? remedyFailure.error
        ? <Failed error={remedyFailure.error} noun="source actions" retry={{ busy: state?.kind === "Loading", run: () => {
          const request = remedyRequest.current;
          if (request !== null && !request.signal.aborted) prepare(request.signal);
        } }} />
        // no request went out: admission says why, once a reason is true.
        : <Fact line={heldBack === null ? { fact: "couldn’t load source actions." } : TRANSPORT_LINES[heldBack].read("source actions")}
          verbs={heldBack === null ? undefined : transportVerbs(heldBack, { signIn: null }) ?? undefined} /> : null}
      {remedyNeeded && sourceRemedy?.kind === "command" ? (
        <Button
          data-metadata-action=""
          onClick={(event) => {
            const detail = prepareActionSelect(event, event.currentTarget);
            if (detail) sourceRemedy.onSelect(detail);
          }}
          onKeyDown={(event) => {
            const detail = prepareActionSelect(event, event.currentTarget);
            if (detail) sourceRemedy.onSelect(detail);
          }}
        >
          {sourceRemedy.label}
        </Button>
      ) : null}
    </>
  );
}
