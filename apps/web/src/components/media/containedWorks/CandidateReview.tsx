"use client";

// A proposal is immutable until the reader explicitly reviews its replacement.
import { useEffect, useRef } from "react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import type { Schema } from "@/lib/api/wire";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { candidateDetail, decidePart } from "@/lib/media/parts";
import { isApiError, isRefusal, isSameSystemApiDefect } from "@/lib/api/client";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PartPreview, { usePartPreview } from "./PartPreview";
import { partBlockMessage, partError } from "./PartEditor";
import { isAbortError } from "@/lib/errors";
import styles from "./parts.module.css";

type Draft = { detail: Schema<"CandidateDetail"> | null; partId: string;
  request: Schema<"PartCandidateDecision"> | null; busy: boolean; conflict: boolean; error: string | null; retired: boolean };
export default function CandidateReview({ source, candidate, onClose, onSaved, onChoose, returnFocusTo }: {
  readonly source: string; readonly candidate: string; readonly onClose: () => void;
  readonly onSaved: (id: string | null) => Promise<void>;
  readonly onChoose: (detail: Schema<"CandidateDetail">) => void;
  readonly returnFocusTo: ReturnFocusTarget;
}) {
  const loaded = usePaneFreeServerValue({ key: `/media/${source}/part-candidates/${candidate}`, stale: "",
    load: signal => candidateDetail(source, candidate, signal) });
  const draft = useResourceDraft<Draft>(`proposal:${source}:${candidate}`, () => ({ detail: null, partId: crypto.randomUUID(), request: null, busy: false, conflict: false, error: null, retired: false }),
    value => ({ changed: false, unconfirmed: value.request !== null, stopsBrowserWork: false }));
  useEffect(() => {
    if (loaded.status === "ready" && (draft.read().detail === null || draft.read().retired)) draft.set(value => ({ ...value, detail: loaded.data, retired: false }));
  }, [loaded, draft]);
  const { detail, request, busy, conflict, error } = draft.value;
  const preview = usePartPreview(source, detail?.selection ?? null);
  const guard = useWorkGuard();
  const run = async (body: Schema<"PartCandidateDecision">, retry = false) => {
    if (draft.read().busy || draft.read().request !== null && !retry) return;
    draft.set(value => ({ ...value, request: body, busy: true, error: null }));
    try {
      await decidePart(source, candidate, body);
    } catch (failure) {
      draft.set(value => ({ ...value, request: isRefusal(failure) ? null : body, busy: false,
        conflict: isApiError(failure) && failure.status === 409, error: partError(failure) }));
      return;
    }
    draft.set(value => ({ ...value, request: null, busy: false }));
    try { await onSaved(body.part_id); } finally { draft.set(value => ({ ...value, retired: true, detail: null })); onClose(); }
  };
  const publishedRefresh = useRef(false);
  useEffect(() => {
    if ((loaded.status === "failed" && loaded.error.status === 409 || loaded.status === "ready" && loaded.error?.status === 409) && !publishedRefresh.current) { publishedRefresh.current = true; void onSaved(null); }
  }, [loaded, onSaved]);
  const stalePreview = preview.status === "failed" && preview.error.status === 409 || preview.status === "ready" && preview.error?.status === 409;
  const reviewCurrent = async () => {
    try {
      await loaded.refetch();
      draft.set(value => ({ ...value, detail: null, conflict: false, error: null }));
    } catch (failure) {
      if (isAbortError(failure)) return;
      if (!isApiError(failure) || isSameSystemApiDefect(failure)) throw failure;
      draft.set(value => ({ ...value, error: partError(failure) }));
    }
  };
  const blocking = busy || request !== null;
  const accept = detail !== null && detail.accept.allowed && detail.selection !== null && preview.status === "ready" && preview.error === null && preview.data.creation_conflict === null;
  return <Dialog open title="review suggestion" onClose={onClose} returnFocusTo={returnFocusTo}
    onDismissRequest={() => {
      if (!guard.confirmLoss({ scopes: [], ownerIds: [draft.owner] })) return "blocked";
      if (draft.read().request === null) draft.set(value => ({ ...value, retired: true, detail: null, error: null, conflict: false }));
      return "accepted";
    }}>
    <div className={styles.editor}>
      {detail === null ? loaded.status === "failed" ? <><p role="alert">couldn’t load this suggestion</p><Button onClick={() => void loaded.refetch()}>try again</Button></> : <p role="status">loading suggestion…</p> : <>
        <h3>{detail.finding.title ?? "untitled suggestion"}</h3>
        {detail.user_decision === "rejected" ? <p>dismissed</p> : null}
        {detail.finding.uncertainty_reason ? <p>{detail.finding.uncertainty_reason}</p> : null}
        {detail.finding.evidence.length > 0 ? <details><summary>source quotes</summary>{detail.finding.evidence.map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}</details> : null}
        {detail.selection !== null ? <PartPreview preview={preview} /> : null}
        {!detail.accept.allowed ? <p>{partBlockMessage(detail.accept.reason)}</p> : null}
        {preview.status === "ready" && preview.data.creation_conflict ? <p>{partBlockMessage(preview.data.creation_conflict.reason)}</p> : null}
        <div className={styles.actions}>
          <Button emphasis="strong" disabled={blocking || conflict || !accept} onClick={() => void run({ expected_version: detail.version, expected_navigation_key: detail.selection!.navigation_key, decision: "accepted", part_id: draft.value.partId })}>extract</Button>
          {detail.user_decision !== "rejected" ? <Button disabled={blocking || conflict} onClick={() => void run({ expected_version: detail.version, expected_navigation_key: null, decision: "rejected", part_id: null })}>dismiss</Button> : null}
          <Button disabled={blocking} onClick={() => { draft.set(value => ({ ...value, retired: true, detail: null, error: null, conflict: false })); onChoose(detail); }}>choose sections…</Button>
        </div>
      </>}
      {error ? <p role="alert">{error}</p> : null}
      {request !== null && !busy ? <Button onClick={() => void run(request, true)}>try same request again</Button> : null}
      {conflict || stalePreview ? <Button disabled={blocking || loaded.status === "ready" && loaded.refreshing} onClick={() => void reviewCurrent()}>review current proposal</Button> : null}
    </div>
  </Dialog>;
}
