"use client";

import { useLayoutEffect, useMemo } from "react";
import Button from "@/components/ui/Button";
import ResourceRow from "@/components/ui/ResourceRow";
import CollectionView from "@/components/collections/CollectionView";
import type { CollectionRowView } from "@/lib/collections/types";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { apiFetch, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { publishChange } from "@/lib/api/changes";
import { useServerValue, useThrowLater, type Visit } from "@/lib/api/serverState";
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
type SittingIndex = ApiJson<"/consumption/sittings", "get">["data"];
const SCOPE = "Stats.Sittings";
const SITTINGS = definePaneVisitDataKey<Visit<SittingIndex>>(SCOPE);
const NO_SITTINGS: readonly Sitting[] = [];
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
  const key = visible || draft.value.held.length > 0 ? "/consumption/sittings" : null;
  const list = useServerValue({
    key, stale, enabled: active || draft.value.held.length > 0, visit: SITTINGS,
    load: async signal => (await apiFetch<ApiJson<"/consumption/sittings", "get">>("/api/consumption/sittings", { signal })).data,
  });
  const sittings = list.status === "ready" ? list.data.items : NO_SITTINGS;
  const landed = (correction: Corrections["held"][number]) => list.status === "ready" && list.fresh && (
    correction.kind === "Exclude" ? sittings.some(row => row.exclusion_id === correction.id)
      : !sittings.some(row => row.exclusion_id === correction.id)
  );
  useLayoutEffect(() => {
    if (draft.value.held.some(landed)) draft.set(value => ({ ...value, held: value.held.filter(correction => !landed(correction)) }));
  });
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
  const { rows, entries, heads } = useMemo(() => {
    const entries = new Map<string, Sitting>();
    const heads = new Map<string, string>();
    const rows: CollectionRowView[] = [];
    let day: string | null = null;
    for (const sitting of sittings) {
      const id = sittingKey(sitting);
      entries.set(id, sitting);
      if (sitting.day !== day) heads.set(id, sitting.day);
      day = sitting.day;
      rows.push({ id, kind: "settings_row", presentation: "Index", title: { text: sitting.title }, primary: { kind: "static" },
        contributors: [], publicationDate: null, context: null, resourceRef: null, selected: false });
    }
    return { rows, entries, heads };
  }, [sittings]);
  return <>
    {draft.value.held.map(correction => <Hold key={correction.id} id={correction.id} attempt={correction.attempt}
      {...resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }, resend: {
        label: "retry", commandKey: `retry ${correction.id}`, run: () => void send(correction), busy: sending,
      } })} />)}
    {visible ? <div className={styles.sittings}>
      {list.status === "loading" ? <Ruling /> : null}
      {list.status !== "loading" && list.error !== null
        ? <Failed error={list.error} noun="sittings" retry={{ run: list.refetch, busy: list.status === "ready" ? list.refreshing : list.retrying }} /> : null}
      {list.status === "ready" && sittings.length === 0 ? <Fact line={{ fact: "no sittings yet." }} /> : null}
      {!rows.length ? null : <CollectionView returnScope={SCOPE} rows={rows} ariaLabel="sittings" status="ready" surface={false} geometry="UniformIndex"
        headBefore={row => {
          const day = heads.get(row.id);
          return day === undefined ? null : <h3><time dateTime={day}>{recordDate(day)}</time></h3>;
        }}
        renderRow={({row: view, as, listPosition, rowActionsAvailable}) => {
          const row = entries.get(view.id)!;
          const held = draft.value.held.some(correction => correction.kind === "Restore"
            ? correction.id === row.exclusion_id : sittingKey(correction.body) === view.id);
          return <ResourceRow as={as} title={row.exclusion_id === null ? row.title : <s>{row.title}</s>} primary={view.primary}
            rootProps={{"data-collection-row-id":view.id, "aria-posinset":listPosition ? listPosition.index + 1 : undefined, "aria-setsize":listPosition?.count}}
            content={{kind:"Index", metadata:<span className={styles.time}>
              {row.exclusion_id === null ? null : "not counted · "}{recordTime(row.active_ms)}
              {row.from_place !== null && row.to_place !== null ? ` · ${Math.round(row.from_place * 100)} → ${Math.round(row.to_place * 100)}%` : null}
            </span>}}
            controls={!rowActionsAvailable ? null : <Button data-row-primary-control="" disabled={sending || held || list.status !== "ready" || !list.fresh} onClick={() => {
              if (row.exclusion_id !== null) void send({ kind: "Restore", id: row.exclusion_id });
              else void send({ kind: "Exclude", id: crypto.randomUUID(), body: {
                media_id: row.media_id, modality: row.modality, device_id: row.device_id,
                started_at: row.started_at, ended_at: row.ended_at,
              } });
            }}>{row.exclusion_id !== null ? "Restore" : "Don’t count"}</Button>} />;
        }} />}
    </div> : null}
  </>;
}
