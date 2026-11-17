"use client";

import { Failed } from "@/components/feedback/Fact";
import { apiFetch } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import RecordCopyButton from "@/lib/consumption/RecordCopyButton";
import { recordDateClause, recordTime, workRecordText } from "@/lib/consumption/recordText";
import { pluralize } from "@/lib/text/pluralize";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./HereEnds.module.css";

const VISIT = definePaneVisitDataKey<Visit<Schema<"WorkRecordOut">>>("media.hereEnds");

/** Mounted only while finished; the reader's ordinary position saves do not reread it. */
export default function HereEnds({ mediaId, title }: { readonly mediaId: string; readonly title: string }) {
  const record = useServerValue({
    key: `/consumption/works/${mediaId}`,
    stale: "",
    // A stats pane's Consumption invalidations must not reach this read owner.
    readPolicy: "reader-end:retry3",
    visit: VISIT,
    load: async signal => (await apiFetch<ApiJson<"/consumption/works/{media_id}", "get">>(
      `/api/consumption/works/${mediaId}`, { signal },
    )).data,
  });
  const completed = record.status === "ready" ? record.data : null;
  return <div className={styles.end}>
    <p className={styles.title}>here ends <cite>{title}</cite></p>
    {record.status === "failed" ? <Failed error={record.error} noun="record" retry={{ run: record.refetch, busy: record.retrying }} /> : null}
    {completed !== null && completed.finished_on !== null ? <>
      {completed.sittings > 0 && completed.first_read_on !== null ? <p className={styles.facts}>
        {pluralize(completed.sittings, "sitting")}, {recordDateClause(completed.first_read_on, completed.finished_on, "to")}. {recordTime(completed.active_ms)}.
      </p> : null}
      <RecordCopyButton className={styles.copy} text={workRecordText(completed, title)} />
    </> : null}
  </div>;
}
