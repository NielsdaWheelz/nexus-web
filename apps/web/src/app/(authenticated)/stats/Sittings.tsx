"use client";

import { useLayoutEffect } from "react";
import Button from "@/components/ui/Button";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { apiFetch, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { publishChange } from "@/lib/api/changes";
import { useThrowLater } from "@/lib/api/serverState";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { recordDate, recordTime } from "@/lib/consumption/recordText";
import styles from "./Sittings.module.css";

type Sitting = Schema<"SittingOut">;
type Correction =
  | { readonly kind: "Exclude"; readonly id: string; readonly body: Schema<"ExcludeSessionIn"> }
  | { readonly kind: "Restore"; readonly id: string };
export type Corrections = {
  readonly sending: Correction | null;
  readonly held: readonly (Correction & { readonly attempt: number })[];
};
const SITTINGS = definePaneVisitDataKey<ListSnapshot<Sitting>>("Stats.Sittings");
const sittingKey = (row: Schema<"ExcludeSessionIn">) =>
  [row.media_id, row.modality, row.device_id, row.started_at, row.ended_at].join();
const FACT = {
  Exclude: "couldn’t stop counting this sitting.",
  Restore: "couldn’t restore this sitting.",
} as const;

/** Corrections keep their exact payload and id until the server's answer or reread settles them. */
export default function Sittings({ visible, active, stale, draft }: {
  visible: boolean;
  active: boolean;
  stale: string;
  draft: ReturnType<typeof useResourceDraft<Corrections>>;
}) {
  const pane = requirePaneRuntime(usePaneRuntime(), "Stats.Sittings");
  const { ctx } = useActionRuntime();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const throwLater = useThrowLater();
  const list = useServerList<Sitting>({
    key: visible || draft.value.held.length > 0 ? "/consumption/sittings" : null,
    stale, pageSize: 50, active,
    visit: SITTINGS,
    id: sittingKey,
    fetchPage: async (cursor, limit, signal) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) params.set("cursor", cursor);
      return (await apiFetch<ApiJson<"/consumption/sittings", "get">>(`/api/consumption/sittings?${params}`, { signal })).data;
    },
  });
  const landed = (correction: Corrections["held"][number]) => list.fresh && (
    correction.kind === "Exclude" ? list.items.some(row => row.exclusion_id === correction.id)
      : list.complete && !list.items.some(row => row.exclusion_id === correction.id)
  );
  useLayoutEffect(() => {
    if (draft.value.held.some(landed)) draft.set(value => ({ ...value, held: value.held.filter(correction => !landed(correction)) }));
  });
  const feedback = useCollectionReadFeedback({ list, unit: { singular: "sitting", plural: "sittings" },
    waiting: visible && list.status === "loading", outcome: list.items.length === 0 ? "no sittings yet." : null });
  const sending = draft.value.sending !== null;
  const send = async (correction: Correction) => {
    if (!ctx.isActive() || draft.read().sending !== null) return;
    const visit = ctx.workspace().state.panes.find(item => item.id === pane.paneId)?.current_visit;
    if (visit?.id !== pane.visitId || resolvePaneRouteModel(visit.href).id !== "stats") return;
    draft.set(value => ({ ...value, sending: correction }));
    try {
      await apiFetch<void>(`/api/consumption/exclusions/${correction.id}`, correction.kind === "Exclude"
        ? { method: "PUT", body: JSON.stringify(correction.body) } : { method: "DELETE" });
      draft.set(value => ({ ...value, held: value.held.filter(item => item.id !== correction.id) }));
      publishChange("Consumption");
    } catch (error) {
      if (!ctx.isActive() || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) return throwLater({ error });
      if (outcomeUnknown(error)) {
        draft.set(value => ({ ...value, held: [...value.held.filter(item => item.id !== correction.id), {
          ...correction, attempt: (value.held.find(item => item.id === correction.id)?.attempt ?? -1) + 1,
        }] }));
        return;
      }
      const transport = transportOf(error);
      // A terminal refusal settles this command; contention cannot settle a prior lost answer.
      if (transport === "Refused" && (error.status === 400 || error.status === 404)) {
        draft.set(value => ({ ...value, held: value.held.filter(item => item.id !== correction.id) }));
      }
      const fact = FACT[correction.kind];
      if (transport !== "Refused") outcome.fail(error, fact, {
        label: "retry", commandKey: `retry ${correction.id}`, run: () => void send(correction),
      });
      else if (error.status === 404) outcome.say(correction.kind === "Exclude"
        ? { fact, reason: "its work isn’t available anymore." } : { fact });
      else if (error.status === 400 || error.status === 409) {
        outcome.say(correction.kind === "Exclude" && error.status === 400
          ? { fact, reason: "its activity changed since this view loaded." } : { fact });
        publishChange("Consumption");
      } else throwLater({ error });
    } finally {
      draft.set(value => ({ ...value, sending: null }));
    }
  };
  const groups = new Map<string, Sitting[]>();
  for (const row of list.items) {
    const group = groups.get(row.day);
    if (group === undefined) groups.set(row.day, [row]);
    else group.push(row);
  }
  return <>
    {draft.value.held.map(correction => <Hold key={correction.id} id={correction.id} attempt={correction.attempt}
      {...resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }, resend: {
        label: "retry", commandKey: `retry ${correction.id}`, run: () => void send(correction), busy: sending,
      } })} />)}
    {visible ? <div className={styles.sittings}>
      {feedback.announcement}
      {list.status === "loading" ? <Ruling /> : null}
      {list.status === "failed" && list.items.length === 0 && list.failure !== null
        ? <Failed error={list.failure.error} noun="sittings" retry={{ run: list.retry, busy: list.running !== null }} /> : null}
      {list.current && list.complete && list.items.length === 0 ? <Fact line={{ fact: "no sittings yet." }} /> : null}
      {[...groups].map(([day, rows]) => <section key={day} aria-label={recordDate(day)}>
        <h2 className={styles.day}><time dateTime={day}>{recordDate(day)}</time></h2>
        <ul className={styles.rows}>{rows.map(row => {
          const held = draft.value.held.some(correction => correction.kind === "Restore"
            ? correction.id === row.exclusion_id : sittingKey(correction.body) === sittingKey(row));
          return <li key={sittingKey(row)} className={styles.row}>
            {row.exclusion_id !== null ? <s>not counted · {row.title} · {recordTime(row.active_ms)}</s>
              : <span>{row.title} · {recordTime(row.active_ms)}{row.from_place !== null && row.to_place !== null
                ? ` · ${Math.round(row.from_place * 100)} → ${Math.round(row.to_place * 100)}%` : null}</span>}
            <Button disabled={sending || held || !list.fresh} onClick={() => {
              if (row.exclusion_id !== null) void send({ kind: "Restore", id: row.exclusion_id });
              else void send({ kind: "Exclude", id: crypto.randomUUID(), body: {
                media_id: row.media_id, modality: row.modality, device_id: row.device_id,
                started_at: row.started_at, ended_at: row.ended_at,
              } });
            }}>{row.exclusion_id !== null ? "Restore" : "Don’t count"}</Button>
          </li>;
        })}</ul>
      </section>)}
      {feedback.notice}
    </div> : null}
  </>;
}
