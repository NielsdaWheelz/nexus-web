"use client";

import { useCallback, useMemo, useState } from "react";
import type { QueryResult } from "@nexus/authored/types";
import CollectionRow from "@/components/collections/CollectionRow";
import CollectionView, { type CollectionViewRowRenderProps } from "@/components/collections/CollectionView";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSurface from "@/components/ui/PaneSurface";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { RankedIndex } from "@/lib/collections/measuredIndexWindow";
import { presentNote } from "@/lib/collections/presenters/note";
import type { CollectionRowView } from "@/lib/collections/types";
import { calendarDateAtUtcNoon, formatDay, formatLocalDateInTimeZone } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useCapturedIndex } from "@/lib/notes/capturedIndex";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { useRankedAuthoredWindow } from "@/lib/notes/rankedAuthoredWindow";
import { truncatePaneSearchQuery, usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import * as Icon from "@/lib/ui/icons";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import styles from "./NotesPaneBody.module.css";

type RegisterVisit = { filter: string; order: "worked" | "title" };
const REGISTER = definePaneVisitDataKey<RegisterVisit>("Notes.Register");
const FIRST: RegisterVisit = { filter: "", order: "worked" };
const UNIT = {singular: "page", plural: "pages"};
const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

const selectRegister = (result: QueryResult) => result.page_register;
const register = (result: QueryResult) => {
  const value = selectRegister(result);
  return value?.kind === "range" || value?.kind === "locations" ? value : null;
};

/** Only mounted oversized titles need a read. The ranked row already supplies its link and work date. */
function LongTitleRow(props: CollectionViewRowRenderProps) {
  const ref = props.row.resourceRef!;
  const read = useAuthoredQuery({kind: "register_label", ref});
  const result = read.data?.register_label;
  const title = result?.label ?? (result?.oversized ? "title too large to display" : read.error ? "couldn’t read title" : "page");
  const primary = props.row.primary;
  return <CollectionRow {...props} row={{...props.row, title: {...props.row.title, text: title},
    primary: primary.kind === "link" ? {...primary, paneLabelHint: title} : primary}}
    primaryControl={read.error ? <AuthoredReadFailure {...read} noun="this title"/> : props.primaryControl}/>;
}

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const type = readerType(useReaderProfile());
  const { calendarTimeZone } = useAuthenticatedAccount();
  const today = useAccountToday();
  const saved = usePaneVisitData(REGISTER, (): RegisterVisit => visit);
  const [visit, setVisit] = useState(saved ?? FIRST);
  const text = visit.filter.trim();
  const source = useMemo(() => ({kind: "page_register" as const, text, order: visit.order}), [text, visit.order]);
  const {read, order, admitted, observation, shownOrder, source: shownSource, revision, held} =
    useCapturedIndex(source, selectRegister);
  const shown = observation?.page_register;
  const description = shown?.kind === "description" ? shown : null;
  const sparse = description !== null && description.total > description.items.length;
  const {items, positions, request, error: rangeError, retry: retryRange} = useRankedAuthoredWindow(
    shownSource, revision, description, register, held);
  const worked = shownSource.order === "worked";
  const list = useMemo(() => {
    const ordered = sparse ? [...items].sort(([left], [right]) => left - right) : [...(description?.items ?? []).entries()];
    const days = new Map(ordered.map(([rank, item]) => [rank, today !== null && item.last_work_at_ms !== null
      ? formatLocalDateInTimeZone(new Date(item.last_work_at_ms), calendarTimeZone) : null]));
    const rows: CollectionRowView[] = [];
    const heads = new Map<string, string>();
    const long = new Set<string>();
    const ids = new Map<number, string>(), ranks = new Map<string, number>();
    let previousGroup: string | null = null;
    for (const [rank, item] of ordered) {
      const day = days.get(rank) ?? null;
      let mark: string | null = null;
      if (worked && today !== null && day !== null &&
        (rank === 0 || days.has(rank - 1) && days.get(rank - 1) !== day)) {
        const month = shortMonth.format(calendarDateAtUtcNoon(day)).toLowerCase();
        const year = day.slice(0, -6);
        mark = day === today ? "today" : `${Number(day.slice(-2))} ${month}${year === today.slice(0, -6) ? "" : ` ${year}`}`;
      }
      const id = item.ref.slice(5);
      rows.push(presentNote({id, title: item.label ?? "page"}, day, mark));
      if (item.label === null) long.add(id);
      if (sparse) {
        ids.set(rank, id);
        ranks.set(id, rank);
      } else if (!worked && item.group !== previousGroup) {
        heads.set(id, item.group);
      }
      previousGroup = item.group;
    }
    return {rows, heads, long, ids, ranks};
  }, [calendarTimeZone, description?.items, items, sparse, today, worked]);

  const returnOrder = useMemo(() => shownOrder === null ? undefined : {...shownOrder, prefix: []}, [shownOrder]);
  const ranked = useMemo(() => {
    if (!sparse || description === null || revision === null) return undefined;
    const heads = new Map<number, string>();
    let start = 0;
    for (const size of description.groups) {
      heads.set(start, "letter");
      start += size;
    }
    const geometry: RankedIndex = {
      count: description.total,
      revision,
      heads,
      returnOrder,
      failed: rangeError !== null,
      idAt: rank => list.ids.get(rank),
      rankOf: id => list.ranks.get(id) ?? positions?.get(`page:${id}`),
      request(ranks, ids) {
        // A date mark belongs only to the first rank of its civil day.
        request(worked ? [...ranks, ...ranks.map(rank => rank - 1)] : ranks, ids.map(id => `page:${id}`));
      },
    };
    return {source: geometry, headSamples: new Map(heads.size === 0 ? [] : [["letter", <h3 key="letter" className={styles.pages}>A</h3>]]),
      headAt(rank: number) {
        const label = items.get(rank)?.group;
        return <h3 className={styles.pages} aria-hidden={label === undefined || undefined}>{label ?? "\u00a0"}</h3>;
      }};
  }, [description, items, list, positions, rangeError, request, returnOrder, revision, sparse, worked]);
  const headBefore = useCallback((row: CollectionRowView) => {
    const label = list.heads.get(row.id);
    return label === undefined ? null : <h3 className={styles.pages}>{label}</h3>;
  }, [list.heads]);

  const error = read.error ?? order.error;
  // A failed cold read cannot establish that a remembered page disappeared.
  usePaneReturnReady(admitted !== null, revision);
  const current = admitted?.page_register;
  const complete = current?.kind === "description" && error === null && !read.pending;
  const changeFilter = (value: string) => setVisit(previous => {
    const filter = truncatePaneSearchQuery(value);
    return filter === previous.filter ? previous : {...previous, filter};
  });
  usePaneChrome({
    primaryAction: { kind: "link", id: "NewPage", label: "new page", icon: <Icon.Add aria-hidden="true" />,
      keepOnNarrowHeader: true, href: "/pages/new",
      onActivate: event => activateTargetLink({ event, runtime, target: { href: "/pages/new" }, entry: { kind: "ComposePage", title: "" } }) },
    query: { kind: "Collation", collation: {
      words: { label: "filter pages", value: visit.filter, applied: visit.filter,
        onChange: changeFilter, onClear: () => changeFilter(""), standing: false,
        onSubmit: null, rows: {status: complete
          ? {kind: "Complete", visibleCount: current.total, totalCount: current.source_total, unit: UNIT}
          : {kind: error === null ? "Partial" : "Failed", visibleCount: 0, loadedCount: 0, unit: UNIT},
        announce: complete}, notice: null, verbs: [] },
      dimensions: [], order: { value: visit.order === "worked" ? null : "title", rest: "last worked in",
        keys: [{ label: "title", ways: [{ value: "title", label: null, word: "by title" }] }],
        onChange: value => setVisit(previous => ({...previous, order: value === "title" ? "title" : "worked"})), note: null },
      reset: visit.order === "title" || visit.filter !== "" ? () => setVisit(FIRST) : null,
    } },
    header: { kind: "Section", meta: complete ? { kind: "Count", value: current.total, unit: "page" } : { kind: "None" } },
  });

  const daily = today === null ? { href: null, "aria-disabled": true } as const : { href: "/daily" } as const;
  const openJournal = (event: TargetActivationEvent, kind: "RevealDailyDate" | "AppendNote") =>
    activateTargetLink({ event, runtime, target: { href: "/daily" }, entry: { kind } });
  const failure = <AuthoredReadFailure {...(read.error ? read : order.error ? order : {error: rangeError, retry: retryRange})} noun="pages" />;
  return <div {...type}>
    <PaneSurface className={styles.register}>
      <div data-pane-return-scope="Notes.Journal" className={styles.journal}>
        <div className={styles.band}>
          <ButtonLink {...daily} className={styles.journalLink} data-collection-row-id="journal" data-row-focusable=""
            data-workspace-rich-target="true" onClick={event => openJournal(event, "RevealDailyDate")} onKeyDown={event => openJournal(event, "RevealDailyDate")}>
            <span className={styles.journalLabel}><span className={styles.journalName}>journal</span>{" "}
              {today !== null ? <time dateTime={today} className={styles.journalDate}>{formatDay(today, today)}</time> : null}
            </span>
          </ButtonLink>
          <ButtonLink {...daily} className={styles.add} data-collection-row-id="entry" data-row-focusable=""
            data-workspace-rich-target="true" onClick={event => openJournal(event, "AppendNote")} onKeyDown={event => openJournal(event, "AppendNote")}>add entry</ButtonLink>
        </div>
        {today === null ? <AccountCalendarUnavailable /> : null}
      </div>
      <section aria-label="pages">
        <h2 className={styles.pages}>pages</h2>
        <CollectionView surface={false} returnScope="Notes.Pages" rows={list.rows} ariaLabel="pages"
          status={description !== null ? "ready" : error !== null ? "error" : "loading"}
          geometry="UniformIndex" ranked={ranked}
          collectionBusy={!complete && error === null} anchorKey={JSON.stringify([shownSource.text, shownSource.order])}
          notice={description !== null && (error !== null || rangeError !== null) ? failure : null} error={failure}
          empty={complete ? <Fact line={{ fact: text ? "no pages match this filter." : "no pages yet." }} /> : error === null ? <Ruling /> : null}
          renderRow={props => list.long.has(props.row.id) ? <LongTitleRow {...props}/> : <CollectionRow {...props}/>}
          headBefore={!sparse && !worked ? headBefore : undefined}
        />
      </section>
    </PaneSurface>
  </div>;
}
