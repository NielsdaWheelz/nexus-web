"use client";

import { useRef } from "react";
import Link from "next/link";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { useAccountToday } from "@/lib/notes/accountDay";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneIsActive, usePaneRouter } from "@/lib/panes/paneRuntime";
import { usePaneUrlState, type PaneUrlStateCodec } from "@/lib/panes/usePaneUrlState";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import { isCanonicalUuid } from "@/lib/validation";
import { definePaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import RecordView from "./Stack";
import Sittings, { type Corrections } from "./Sittings";
import styles from "./Stack.module.css";

type View =
  | { kind: "Record"; work: string | null; year: number | null }
  | { kind: "Sittings" }
  | { kind: "Invalid" };
const VIEW: PaneUrlStateCodec<View> = {
  basePath: "/stats",
  decode(params) {
    for (const key of params.keys()) {
      if (!["view", "work", "year"].includes(key) || params.getAll(key).length !== 1) return { kind: "Invalid" };
    }
    if (params.has("view")) return params.size === 1 && params.get("view") === "sittings"
      ? { kind: "Sittings" } : { kind: "Invalid" };
    const work = params.get("work"), year = params.get("year");
    if (work !== null && !isCanonicalUuid(work) || year !== null && (!/^[0-9]{4}$/.test(year) || Number(year) === 0)) return { kind: "Invalid" };
    return { kind: "Record", work, year: year === null ? null : Number(year) };
  },
  encode(view) {
    const params = new URLSearchParams();
    if (view.kind === "Sittings") params.set("view", "sittings");
    if (view.kind === "Record") {
      if (view.work !== null) params.set("work", view.work);
      if (view.year !== null) params.set("year", String(view.year).padStart(4, "0"));
    }
    return params;
  },
};
const RECORD = definePaneVisitDataKey<Visit<Schema<"RecordOut">>>("Stats.Record");

/** URL, read and correction ownership stay with the pane; the objects own their presentation. */
export default function StatsPaneBody() {
  const { state: view, setState } = usePaneUrlState(VIEW);
  const router = usePaneRouter();
  if (view.kind === "Invalid") return <Fact line={{ fact: "this view doesn’t exist." }} speak
    verbs={[{ label: "reset view", commandKey: "stats-view-reset", run: () => router.replace("/stats") }]} />;
  return <StatsContent view={view} setView={setState} />;
}

function StatsContent({ view, setView }: { view: Exclude<View, { kind: "Invalid" }>; setView: (view: View) => void }) {
  const active = usePaneIsActive();
  const today = useAccountToday();
  const browserZone = useHydratedBrowserTimeZone();
  const refresh = useRefreshStamp(active, 0);
  const consumption = useChangeStamp("Consumption");
  const followed = useRef(consumption);
  if (active) followed.current = consumption;
  const stale = `${refresh}:${followed.current}:${today}`;
  const record = useServerValue({ key: "/consumption/record", stale, visit: RECORD,
    load: async signal => (await apiFetch<ApiJson<"/consumption/record", "get">>("/api/consumption/record", { signal })).data });
  const draft = useResourceDraft<Corrections>("Stats.Corrections", () => ({ sending: null, held: [] }), value => ({
    changed: false, unconfirmed: value.sending !== null || value.held.length > 0, stopsBrowserWork: false,
  }));
  usePaneChrome({ views: {
    label: "stats view", value: view.kind === "Record" ? "record" : "sittings",
    items: [{ value: "record", label: "record" }, { value: "sittings", label: "sittings" }],
    onSelect: value => {
      if (value === "record") setView({ kind: "Record", work: null, year: null });
      else if (value === "sittings") setView({ kind: "Sittings" });
      // justify-defect: chrome invokes only the two published view values.
      else throw new Error("unknown stats view");
    },
  } });
  usePaneReturnReady(record.status !== "loading");
  return <main className={styles.pane}>
    <Sittings visible={view.kind === "Sittings"} active={active} stale={stale} draft={draft} />
    {view.kind === "Record" ? <>
      {record.status === "loading" ? <Ruling /> : record.status === "failed"
        ? <Failed error={record.error} noun="statistics" retry={{ run: () => void record.refetch(), busy: record.retrying }} />
        : record.data.slip.days.length === 0 && view.work === null
          ? <Fact line={{ fact: "nothing recorded yet. reading is recorded while the page is in front of you." }} />
          : <RecordView record={record.data} workId={view.work} year={view.year} stale={stale}
            onWork={work => setView({ ...view, work })} onYear={year => setView({ kind: "Record", year, work: null })} />}
    </> : null}
    {record.status === "ready" && (view.kind === "Sittings" || record.data.slip.days.length > 0) ? <p className={styles.foot}>
      days in {record.data.time_zone}. observed, focused time only; a sitting you chose not to count is left out.
      {record.data.time_zone === "UTC" && browserZone !== null && browserZone !== "UTC" ? <> <Link href="/settings/account">account settings</Link></> : null}
    </p> : null}
  </main>;
}
