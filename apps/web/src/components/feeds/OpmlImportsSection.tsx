"use client";

/** Durable batches belong beside imports. The list is compact; rows are read only
 * after disclosure, and the existing Imports observation clock owns refreshes. */
import { useState } from "react";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import * as Icon from "@/lib/ui/icons";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getOpmlImport, listOpmlImports } from "@/lib/feeds/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { usePaneIsPresented } from "@/lib/panes/paneRuntime";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import type { Schema } from "@/lib/api/wire";
import OpmlImportDialog, { type OpmlReviewInput } from "./OpmlImportDialog";
import styles from "./FeedCommands.module.css";

function Batch({ batch, stale, observing }: { batch: Schema<"OpmlImportSummaryOut">; stale: string; observing: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [review, setReview] = useState<Extract<OpmlReviewInput, { kind: "UnresolvedRows" }> | null>(null);
  const { ctx } = useActionRuntime();
  const detail = usePaneFreeServerValue({ key: expanded ? `opml:${batch.id}` : null, stale, enabled: observing,
    load: signal => getOpmlImport(batch.id, signal) });
  const subject = `opml:${batch.id}`;
  const pending = ctx.feeds.pending(subject);
  const change = (action: "cancel" | "retry") => void ctx.feeds.submit({ subject, title: "subscription import", command: {
    kind: "OpmlChange", importId: batch.id, action, body: { expected_attempt_version: batch.attempt_version },
  } });
  const unresolved = detail.status === "ready" ? detail.data.items.filter(item => item.state === "failed" || item.state === "cancelled") : [];
  const needsCancellation = detail.status === "ready" && detail.data.state !== "cancelled";
  return <div className={styles.progress}>
    <div className={styles.actions}>
      <Button icon={<Icon.Disclose open={expanded} />} aria-expanded={expanded} aria-controls={`opml-rows-${batch.id}`} onClick={() => setExpanded(!expanded)}>
        subscription import · {batch.state.replaceAll("_", " ")} · {batch.admitted_count} subscribed · {batch.remaining_count} remaining{batch.failed_count > 0 ? ` · ${batch.failed_count} need attention` : ""}
      </Button>
      {batch.can_cancel ? <Button disabled={pending !== null} onClick={() => change("cancel")}>cancel import</Button> : null}
      {batch.can_retry ? <Button disabled={pending !== null} onClick={() => change("retry")}>retry import</Button> : null}
    </div>
    {expanded ? <div id={`opml-rows-${batch.id}`}>
      <p className={styles.note}>cancelling keeps accepted subscriptions and items. their initial history continues in source details.</p>
      {detail.status === "loading" ? <Ruling /> : detail.status === "failed" ? <Failed error={detail.error} noun="subscription import" retry={{ run: detail.refetch, busy: detail.retrying }} />
        : <>
          {detail.error === null ? null : <Failed error={detail.error} noun="the updated subscription import" retry={{ run: detail.refetch, busy: detail.refreshing }} />}
          <ul className={styles.destinations}>{detail.data.items.map(item => <li key={item.id}>
            <span>{item.url} · {item.state.replaceAll("_", " ")}</span>
            {item.error_detail === null ? null : <p>{item.error_detail}</p>}
          </li>)}</ul>
          {unresolved.length > 0 ? <>
            <Button disabled={pending !== null || detail.error !== null || detail.refreshing || needsCancellation}
              onClick={() => setReview({ kind: "UnresolvedRows", rows: unresolved.map(({ url, selected_kind, library_id }) => ({ url, selected_kind, library_id })) })}>review unresolved</Button>
            {needsCancellation ? <p className={styles.note}>cancel this import before reviewing unresolved sources.</p> : null}
          </> : null}
        </>}
    </div> : null}
    {review === null ? null : <OpmlImportDialog input={review} onClose={() => setReview(null)} />}
  </div>;
}

export default function OpmlImportsSection() {
  const { observation } = useImports();
  const observing = useObservationDemand(usePaneIsPresented());
  const stale = `${observation}:${useChangeStamp("Feeds")}`;
  const read = usePaneFreeServerValue({ key: "opml-imports", stale, enabled: observing, load: listOpmlImports });
  if (read.status === "ready" && read.data.length === 0 && read.error === null) return null;
  return <PaneSection title="subscription imports" aria-label="subscription imports">
    {read.status === "loading" ? <Ruling /> : read.status === "failed" ? <Failed error={read.error} noun="subscription imports" retry={{ run: read.refetch, busy: read.retrying }} />
      : <>{read.error === null ? null : <Fact line={{ fact: "couldn’t refresh subscription imports." }} verbs={[{ label: "retry", commandKey: "retry subscription imports", run: read.refetch }]} />}
        {read.data.map(batch => <Batch key={batch.id} batch={batch} stale={stale} observing={observing} />)}</>}
  </PaneSection>;
}
