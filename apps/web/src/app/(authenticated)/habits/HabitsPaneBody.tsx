"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { QueryResult, WorkIndexItem } from "@nexus/authored/types";
import CollectionView, { type CollectionViewRowRenderProps } from "@/components/collections/CollectionView";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import ResourceRow from "@/components/ui/ResourceRow";
import Button from "@/components/ui/Button";
import HabitYear, { HabitYearLegend } from "@/components/work/HabitYear";
import { habitDateLabel } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredIndex, useAuthoredQuery } from "@/lib/notes/hooks";
import { useWorkHistory, useOpenHabitHistory, WorkHistoryContext } from "@/lib/notes/work";
import type { CollectionRowView } from "@/lib/collections/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneChrome, usePaneTitleYield } from "@/lib/panes/paneChrome";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./habits.module.css";

const habits = (result: QueryResult) => result.work_index;

export default function HabitsPaneBody() {
  const today = useAccountToday();
  const currentYear = today === null ? null : Number(today.slice(0, 4));
  const latest = useAuthoredQuery({kind: "latest_habit_date"});
  const latestYear = latest.data?.latest_habit_date ? Number(latest.data.latest_habit_date.slice(0, 4)) : null;
  const defaultYear = currentYear ?? latestYear;
  const codec = useMemo(() => ({basePath: "/habits", decode: (params: URLSearchParams) => {
    const value = params.get("year");
    return value !== null && /^\d{4}$/u.test(value) && Number(value) >= 1 ? Number(value) : defaultYear;
  }, encode: (value: number | null, params: URLSearchParams) => {
    if (value === null) params.delete("year"); else params.set("year", String(value).padStart(4, "0"));
    return params;
  }}), [defaultYear]);
  const {state: year, setState: setYear} = usePaneUrlState(codec);
  const read = useAuthoredIndex({kind: "habits", start: 0, limit: 2048, expected_revision: null}, habits);
  const {history, error} = useWorkHistory();
  usePaneReturnReady(read.data !== null || read.error !== null);
  const type = readerType(useReaderProfile());
  const title = useRef<HTMLParagraphElement>(null);
  usePaneTitleYield(title);
  usePaneChrome({displayTitle: "habits"});
  const index = useMemo(() => {
    const rows: CollectionRowView[] = [], items = new Map<string, WorkIndexItem>();
    for (const item of read.data?.items ?? []) {
      rows.push({id: item.ref, kind: "note", presentation: "Details",
        title: {text: item.label === null ? "name too large to display" : item.label || "empty note"},
        primary: {kind: "link", href: `/notes/${item.ref.slice(11)}`},
        resourceRef: canonicalResourceRef({scheme: "note_block", id: item.ref.slice(11)}),
        contributors: [], publicationDate: null, context: null, selected: false});
      items.set(item.ref, item);
    }
    return {rows, items};
  }, [read.data]);
  if (error) throw error;
  return <WorkHistoryContext.Provider value={history}><div {...type}>
    <div className={styles.head}>
      <p ref={title} className="reader-display">{year === null ? "Habits" : `Habits, ${year}`}</p>
      {year === null ? null : <div role="group" aria-label="habit years" className={styles.step}>
        <Button aria-label={`previous year, ${year - 1}`} disabled={year <= 1} onClick={() => setYear(year - 1)}>{year - 1}</Button>
        <Button aria-label={`next year, ${year + 1}`} disabled={year >= Math.max(currentYear ?? 0, latestYear ?? 0)} onClick={() => setYear(year + 1)}>{year + 1}</Button>
        <Button disabled={currentYear === null} onClick={() => setYear(currentYear)}>today</Button>
      </div>}
    </div>
    {today === null ? <AccountCalendarUnavailable/> : null}
    <AuthoredReadFailure {...latest} noun="the latest habit year"/>
    <CollectionView returnScope="Habits" rows={index.rows} ariaLabel="habits" status={read.data !== null ? "ready" : read.error !== null ? "error" : "loading"}
      error={<AuthoredReadFailure {...read} noun="habits"/>} notice={read.data !== null && read.error !== null ? <AuthoredReadFailure {...read} noun="habits"/> : undefined}
      empty={<p>no daily habits yet. choose repeat daily on a note.</p>}
      renderRow={props => <HabitRow {...props} item={index.items.get(props.row.id)!} today={today} year={year} history={history}/>}/>
    <div className={styles.foot}><HabitYearLegend/></div>
  </div></WorkHistoryContext.Provider>;
}

function HabitRow({row, as, item, today, year, history}: CollectionViewRowRenderProps & {
  item: WorkIndexItem; today: string | null; year: number | null; history: ReturnType<typeof useWorkHistory>["history"];
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = marker.current?.closest("[data-collection-row-id]");
    if (!target) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting === true));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const read = useAuthoredQuery(visible && year !== null ? {kind: "habit_days", ref: item.ref, year} : null);
  const [shown, setShown] = useState<{year: number | null; dates: string[]} | null>(null);
  const dates = read.data?.habit_days ?? (shown?.year === year ? shown.dates : []);
  if (read.data?.habit_days && (shown?.year !== year || shown.dates !== read.data.habit_days))
    setShown({year, dates: read.data.habit_days});
  const resolved = shown?.year === year || read.data !== null;
  const open = useOpenHabitHistory();
  const currentYear = today === null ? null : Number(today.slice(0, 4));
  const start = today === null ? dates.at(-1) ?? null :
    year === null || year === currentYear ? today : currentYear !== null && year < currentYear ? `${String(year).padStart(4, "0")}-01-01` : dates[0] ?? today;
  return <ResourceRow as={as} primary={row.primary} title={row.title.text} rootProps={{"data-collection-row-id": row.id}}
    content={{kind: "Details", body: <>
      <span ref={marker} hidden/>
      {!item.work.designation.enabled || item.work.designation.kind !== "habit" ? <p className={styles.muted}>daily repetition is off</p> : null}
      <AuthoredReadFailure {...read} noun="this habit’s dates"/>
      {today !== null && year !== null ? <div inert={!resolved} aria-busy={!resolved}>
        <HabitYear year={year} today={today} dates={dates} onOpen={date => {if (history) open(item.ref, date, history);}}/>
      </div> : resolved ? <p>{dates.length ? dates.map(habitDateLabel).join(" · ") : "no recorded dates."}</p> : null}
      <Button data-habit-history="true" disabled={!history || start === null} onClick={() => {if (history && start !== null) open(item.ref, start, history);}}>habit history</Button>
    </>}}/>;
}
