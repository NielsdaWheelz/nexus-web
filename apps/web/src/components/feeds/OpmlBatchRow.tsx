"use client";

import Button from "@/components/ui/Button";
import ResourceRow from "@/components/ui/ResourceRow";
import { ResourceIndexTitle } from "@/components/resources/ResourceType";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue, type ServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { listOpmlImports } from "@/lib/feeds/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { usePaneIsPresented } from "@/lib/panes/paneRuntime";
import styles from "./FeedCommands.module.css";

/** Imports' digest and revision own all batch observations. */
export function useOpmlBatches(): ServerValue<readonly Schema<"OpmlImportSummaryOut">[]> {
  const { digest, revision } = useImports();
  const observing = useObservationDemand(usePaneIsPresented());
  return usePaneFreeServerValue({ key: digest === null ? null : "opml-imports", stale: `${revision}:${digest}`,
    enabled: observing, load: listOpmlImports });
}

/** The row and record submit the same versioned command to the feeds owner. */
export function OpmlImportActions({ batch }: {
  readonly batch: Pick<Schema<"OpmlImportSummaryOut">, "id" | "attempt_version" | "can_cancel" | "can_retry">;
}) {
  const { ctx } = useActionRuntime();
  const subject = `opml:${batch.id}`;
  const pending = ctx.feeds.pending(subject);
  const change = (action: "cancel" | "retry") => void ctx.feeds.submit({ subject, title: "subscription import", command: {
    kind: "OpmlChange", importId: batch.id, action, body: { expected_attempt_version: batch.attempt_version },
  } });
  return <span className={styles.actions} data-row-primary-control="">
    {batch.can_cancel ? <Button disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => change("cancel")}>cancel</Button> : null}
    {batch.can_retry ? <Button disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => change("retry")}>retry</Button> : null}
  </span>;
}

export default function OpmlBatchRow({ batch, selected, onSelect, className }: {
  readonly batch: Schema<"OpmlImportSummaryOut">;
  readonly selected: boolean;
  readonly onSelect: (ref: string, trigger: HTMLButtonElement) => void;
  readonly className?: string;
}) {
  const ref = `opml:${batch.id}`;
  const attention = batch.state === "needs_attention";
  return <ResourceRow selected={selected}
    rootProps={{ className, "data-collection-row-id": ref, "aria-current": selected ? "true" : undefined }}
    primary={{ kind: "button", label: "subscription import", onActivate: trigger => onSelect(ref, trigger) }}
    title={<ResourceIndexTitle type={{ scheme: "feed", mediaKind: null }} hasArtwork={false}>subscription import</ResourceIndexTitle>}
    content={{ kind: "Index", metadata: <span className={styles.batchLine} data-tone={attention ? "Warning" : "Neutral"}>
      {attention && batch.failed_count > 0 ? `${batch.failed_count} couldn’t subscribe` : `${batch.admitted_count} subscribed · ${batch.remaining_count} remaining`}
    </span> }}
    controls={<OpmlImportActions batch={batch} />}
  />;
}
