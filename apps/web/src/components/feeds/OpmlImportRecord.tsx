"use client";

import { useState } from "react";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { getOpmlImport } from "@/lib/feeds/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { usePaneIsPresented } from "@/lib/panes/paneRuntime";
import { OpmlImportActions } from "./OpmlBatchRow";
import OpmlImportDialog, { type OpmlReviewInput } from "./OpmlImportDialog";
import styles from "./FeedCommands.module.css";

/** A selected batch keeps its record after it settles and leaves the register. */
export default function OpmlImportRecord({ id }: { readonly id: string }) {
  const { digest, revision, summary } = useImports();
  const observing = useObservationDemand(usePaneIsPresented());
  const detail = usePaneFreeServerValue({ key: digest === null ? null : `opml:${id}`, stale: `${revision}:${digest}`,
    enabled: observing, load: signal => getOpmlImport(id, signal) });
  const [review, setReview] = useState<Extract<OpmlReviewInput, { kind: "UnresolvedRows" }> | null>(null);
  const { ctx } = useActionRuntime();
  const pending = ctx.feeds.pending(`opml:${id}`);
  if (digest === null && summary.status === "failed") return <Failed error={summary.error} noun="imports" retry={{ run: summary.refetch, busy: summary.retrying }} />;
  if (detail.status === "loading") return <Ruling />;
  if (detail.status === "failed") return <Failed error={detail.error} noun="subscription import" retry={{ run: detail.refetch, busy: detail.retrying }} />;
  const batch = detail.data;
  const unresolved = batch.items.filter(item => item.state === "failed" || item.state === "cancelled");
  const needsCancellation = batch.state !== "cancelled";
  return <section className={styles.progress}>
    <h2>subscription import</h2>
    <OpmlImportActions batch={batch} />
    <p className={styles.note}>cancelling keeps accepted subscriptions and items. their initial history continues in source details.</p>
    {detail.error === null ? null : <Failed error={detail.error} noun="the updated subscription import" retry={{ run: detail.refetch, busy: detail.refreshing }} />}
    <ul className={styles.destinations}>{batch.items.map(item => <li key={item.id}>
      <span>{item.url} · {item.state.replaceAll("_", " ")}</span>
      {item.error_detail === null ? null : <p>{item.error_detail}</p>}
    </li>)}</ul>
    {unresolved.length > 0 ? <>
      <Button disabled={pending !== null || detail.error !== null || detail.refreshing || needsCancellation}
        onClick={() => setReview({ kind: "UnresolvedRows", rows: unresolved.map(({ url, selected_kind, library_id }) => ({ url, selected_kind, library_id })) })}>review unresolved</Button>
      {needsCancellation ? <p className={styles.note}>cancel this import before reviewing unresolved sources.</p> : null}
    </> : null}
    {review === null ? null : <OpmlImportDialog input={review} onClose={() => setReview(null)} />}
  </section>;
}
