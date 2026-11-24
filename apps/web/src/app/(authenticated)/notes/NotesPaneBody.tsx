"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pageTitle } from "@nexus/authored/queries";
import CollectionView from "@/components/collections/CollectionView";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSurface from "@/components/ui/PaneSurface";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { presentNote } from "@/lib/collections/presenters/note";
import { calendarDateAtUtcNoon, formatDay, formatLocalDateInTimeZone } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useNotesRegister } from "@/lib/notes/hooks";
import { truncatePaneSearchQuery, usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import * as Icon from "@/lib/ui/icons";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import styles from "./NotesPaneBody.module.css";

type RegisterVisit = { filter: string; order: "worked" | "title"; depth: number; shownRefs: readonly string[] };
const REGISTER = definePaneVisitDataKey<RegisterVisit>("Notes.Register");
const FIRST: RegisterVisit = { filter: "", order: "worked", depth: 100, shownRefs: [] };
const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const type = readerType(useReaderProfile());
  const { calendarTimeZone } = useAuthenticatedAccount();
  const today = useAccountToday();
  const saved = usePaneVisitData(REGISTER, (): RegisterVisit => ({ ...visit, shownRefs }));
  const [visit, setVisit] = useState<RegisterVisit>(saved ?? FIRST);
  const committed = useRef(visit.shownRefs);
  const getRetainedRefs = useCallback(() => committed.current, []);
  const read = useNotesRegister({ query: visit.filter, order: visit.order, depth: visit.depth, getRetainedRefs });
  const shownRefs = useMemo(() => read.data?.rows.map(page => page.ref) ?? visit.shownRefs, [read.data, visit.shownRefs]);
  useLayoutEffect(() => { committed.current = shownRefs; }, [shownRefs]);
  // A failed cold read cannot establish that a remembered page disappeared.
  usePaneReturnReady(read.data !== null);

  const rows = useMemo(() => {
    let previousDay: string | null = null;
    return (read.data?.rows ?? []).map(page => {
      const day = today !== null && page.last_work_at_ms !== null
        ? formatLocalDateInTimeZone(new Date(page.last_work_at_ms), calendarTimeZone) : null;
      let mark: string | null = null;
      if (visit.order === "worked" && day !== null && day !== previousDay && today !== null) {
        const month = shortMonth.format(calendarDateAtUtcNoon(day)).toLowerCase();
        const year = day.slice(0, -6);
        mark = day === today ? "today" : `${Number(day.slice(-2))} ${month}${year === today.slice(0, -6) ? "" : ` ${year}`}`;
      }
      previousDay = day;
      return presentNote({ id: page.ref.slice("page:".length), title: pageTitle(page.title ?? "", null) }, day, mark);
    });
  }, [read.data, calendarTimeZone, today, visit.order]);

  const changeFilter = (value: string) => {
    const filter = truncatePaneSearchQuery(value);
    if (filter !== visit.filter) setVisit({ ...FIRST, filter, order: visit.order });
  };
  const complete = read.data !== null && !read.data.more && read.error === null && !read.pending;
  usePaneChrome({
    primaryAction: { kind: "link", id: "NewPage", label: "new page", icon: <Icon.Add aria-hidden="true" />,
      keepOnNarrowHeader: true, href: "/pages/new",
      onActivate: event => activateTargetLink({ event, runtime, target: { href: "/pages/new" }, entry: { kind: "ComposePage", title: "" } }) },
    query: { kind: "Collation", collation: {
      words: { label: "filter pages", value: visit.filter, applied: visit.filter,
        onChange: changeFilter, onClear: () => changeFilter(""), standing: false,
        onSubmit: null, rows: null, notice: null, verbs: [] },
      dimensions: [], order: { value: visit.order === "worked" ? null : "title", rest: "last worked in",
        keys: [{ label: "title", ways: [{ value: "title", label: null, word: "by title" }] }],
        onChange: value => setVisit({ ...FIRST, filter: visit.filter, order: value === "title" ? "title" : "worked" }), note: null },
      reset: visit.order === "title" || visit.filter !== "" ? () => setVisit(FIRST) : null,
    } },
    header: { kind: "Section", meta: complete ? { kind: "Count", value: rows.length, unit: "page" } : { kind: "None" } },
  });

  const daily = today === null ? { href: null, "aria-disabled": true } as const : { href: "/daily" } as const;
  const openJournal = (event: TargetActivationEvent, kind: "RevealDailyDate" | "AppendNote") =>
    activateTargetLink({ event, runtime, target: { href: "/daily" }, entry: { kind } });
  const failure = <AuthoredReadFailure {...read} noun="pages" />;
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
        <CollectionView surface={false} returnScope="Notes.Pages" rows={rows} ariaLabel="pages"
          status={read.data !== null ? "ready" : read.error !== null ? "error" : "loading"}
          collectionBusy={read.pending} anchorKey={JSON.stringify([visit.filter, visit.order])}
          notice={read.data !== null && read.error !== null ? failure : null} error={failure}
          empty={complete ? <Fact line={{ fact: visit.filter.trim() ? "no pages match this filter." : "no pages yet." }} /> : read.pending ? <Ruling /> : null}
          footer={read.data?.more ? <div className={styles.footer}><Button aria-busy={read.pending} disabled={read.pending}
            onClick={() => setVisit({ ...visit, depth: visit.depth + 100, shownRefs })}>show more pages</Button></div> : null}
        />
      </section>
    </PaneSurface>
  </div>;
}
