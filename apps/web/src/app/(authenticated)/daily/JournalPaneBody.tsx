"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Intent } from "@nexus/authored/commands";
import { Ruling, RulingRegion } from "@/components/feedback/Ruling";
import { useOutcome } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { useLocalOutlineRoot, type LocalOutlineHandle } from "@/components/notes/LocalOutline";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import CompletedWork from "@/components/work/CompletedWork";
import WorkSection from "@/components/work/WorkSection";
import { useAuthoredAccountId } from "@/lib/authored/provider";
import { formatDay, isLocalDate } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { dailyPage } from "@/lib/notes/api";
import { useAuthoredPages, useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { JOURNAL_DAY_ESTIMATE, useJournalWindow } from "@/lib/notes/journalWindow";
import type { OutlineController } from "@/lib/notes/outlineController";
import { OutlineHistoryAllowance } from "@/lib/notes/outlineHistoryAllowance";
import { OutlinePresentationAllowance } from "@/lib/notes/outlinePresentationAllowance";
import { isAuthoredStorageFailure, LocalCommitError } from "@/lib/notes/runtime";
import { WorkHistoryContext, useWorkHistory } from "@/lib/notes/work";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { cx } from "@/lib/ui/cx";
import { PaneRefreshAnchor, usePaneAnchorGeometry, usePaneInputLease, usePaneReturnReady, usePaneRevealAnchor } from "@/lib/workspace/paneReturnMemento";
import { useWorkspaceStore, type WorkspaceNavigationResult } from "@/lib/workspace/store";
import JournalDates from "./JournalDates";
import styles from "./journal.module.css";

type Day = { local_date: string; ref: string | null };
type Binding = { ref: string; prelude: readonly Intent[] };
const EMPTY_INTENTS: readonly Intent[] = [];
const TITLE = { label: "page title", placeholder: "" };
type Opening = "pending" | "ready" | "failed";

function mergeDates(ordered: readonly string[], extra: readonly string[]): string[] {
  const dates: string[] = [];
  let rank = 0;
  for (const date of extra) {
    while (rank < ordered.length && ordered[rank] > date) dates.push(ordered[rank++]);
    if (ordered[rank] === date) rank++;
    dates.push(date);
  }
  return dates.concat(ordered.slice(rank));
}

export default function JournalPaneBody() {
  const account = useAuthoredAccountId();
  const pane = requirePaneRuntime(usePaneRuntime(), "JournalPaneBody");
  const date = usePaneParam("localDate");
  if (date === null || !isLocalDate(date)) throw new Error("journal route requires a civil date");
  return <Journal key={`${account}:${pane.visitId}:${pane.routeKey}`} arrival={date} />;
}

function Journal({ arrival }: { arrival: string }) {
  const pane = requirePaneRuntime(usePaneRuntime(), "JournalPaneBody");
  const index = useAuthoredQuery({ kind: "daily_index" });
  const today = useAccountToday();
  const profile = useReaderProfile();
  const type = useMemo(() => readerType(profile), [profile]);
  const { delivery, claim } = usePaneEntryDelivery();
  const reveal = usePaneRevealAnchor();
  const inputLease = usePaneInputLease();
  const foreground = useWorkspaceStore().foregroundGeneration;
  const currentForeground = useRef(foreground);
  useLayoutEffect(() => { currentForeground.current = foreground; }, [foreground]);
  const [arrivalLease, setArrivalLease] = useState<{ activation: string; valid(): boolean } | null>(null);
  useEffect(() => {
    if (delivery === null) { setArrivalLease(null); return; }
    const generation = currentForeground.current, valid = inputLease();
    setArrivalLease({ activation: delivery.activationId, valid: () => currentForeground.current === generation && valid() });
  }, [delivery, inputLease]);
  const mayArrive = useCallback((activation: string) => arrivalLease?.activation === activation ? arrivalLease.valid() : null, [arrivalLease]);
  useEffect(() => {
    if (delivery?.entry.kind !== "RevealDailyDate") return;
    const allowed = mayArrive(delivery.activationId);
    if (allowed === null || !claim(delivery) || !allowed) return;
    if (arrival === today) reveal("journal-band", "band", delivery.entry.focus === true);
    else reveal("journal", arrival, delivery.entry.focus === true);
  }, [delivery, claim, mayArrive, arrival, today, reveal]);

  const root = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const datesTrigger = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [pickerDate, setPickerDate] = useState<string | null>(null);
  const [allowance] = useState(() => new OutlineHistoryAllowance());
  const work = useWorkHistory(allowance);
  if (work.error) throw work.error;
  const [, presentationChanged] = useState(0);
  const [presentationAllowance] = useState(() => new OutlinePresentationAllowance(() => presentationChanged(value => value + 1)));
  const [retained, setRetained] = useState<ReadonlyMap<string, Day>>(() => new Map());
  const members = index.data?.daily_index ?? null;
  if (index.data !== null && members === null) throw new Error("daily index result is missing");
  const recordedDates = useMemo(() => members?.map(day => day.local_date) ?? null, [members]);
  const directory = useMemo(() => {
    const byDate = new Map<string, Day>(members?.map(day => [day.local_date, day]));
    const extra: string[] = [];
    for (const [date, day] of retained) {
      if (byDate.has(date)) continue;
      byDate.set(date, day);
      extra.push(date);
    }
    if (!byDate.has(arrival)) {
      byDate.set(arrival, { local_date: arrival, ref: null });
      extra.push(arrival);
    }
    const recorded = recordedDates ?? [];
    return { byDate, dates: extra.length ? mergeDates(recorded, extra.sort().reverse()) : recorded };
  }, [members, recordedDates, arrival, retained]);
  const indexState = members !== null ? "ready" : index.error !== null ? "failed" : "pending";
  const window = useJournalWindow(directory.dates, root, indexState, presentationAllowance.pressured ? 0 : 1, type);
  const directoryReady = indexState !== "pending";
  usePaneAnchorGeometry({ scope: "journal", geometry: window.geometry, ready: directoryReady });
  usePaneReturnReady(directoryReady);

  const retain = useCallback((date: string, ref: string | null, keep: boolean) => setRetained(previous => {
    const old = previous.get(date);
    if (!keep && old === undefined || keep && old?.ref === ref) return previous;
    const next = new Map(previous);
    if (keep) next.set(date, { local_date: date, ref }); else next.delete(date);
    return next;
  }), []);
  const headless = today !== null && directory.dates[0] === today;
  const readingDate = window.reading ?? (members !== null && window.viewport.from < 0 ? today : null) ?? arrival;
  const name = formatDay(readingDate, today);
  const showBand = today !== null && readingDate === today && (headless || window.reading === null);
  const [seen, setSeen] = useState<{ target: Element; intersecting: boolean } | null>(null);
  useLayoutEffect(() => {
    const head = showBand ? bandRef.current : target;
    const port = head?.closest<HTMLElement>("[data-pane-content]");
    if (!head || !port) return;
    const see = (intersecting: boolean) =>
      setSeen(previous => previous?.target === head && previous.intersecting === intersecting ? previous : { target: head, intersecting });
    let inset: number | null = null, observer: IntersectionObserver | null = null;
    const observe = () => {
      const band = paneVisibleBand(port), box = head.getBoundingClientRect();
      see(box.bottom > band.top && box.top < band.bottom);
      const next = parseFloat(getComputedStyle(port).paddingTop);
      if (next === inset) return;
      inset = next;
      observer?.disconnect();
      observer = new IntersectionObserver(entries => see(entries[entries.length - 1]!.isIntersecting), { root: port, rootMargin: `${-next}px 0px 0px 0px` });
      observer.observe(head);
    };
    observe();
    const sizes = new ResizeObserver(observe);
    sizes.observe(port);
    return () => { sizes.disconnect(); observer?.disconnect(); };
  }, [target, showBand]);
  const yielded = seen !== null && seen.target === (showBand ? bandRef.current : target) && seen.intersecting;
  const choose = useCallback((chosen: string): WorkspaceNavigationResult => {
    const actual = chosen === today ? bandRef.current : window.geometry.element(chosen);
    const port = actual?.closest<HTMLElement>("[data-pane-content]");
    if (actual && !actual.hidden && port) {
      const top = port.scrollTop + actual.getBoundingClientRect().top - paneVisibleBand(port).top;
      const landing = Math.min(Math.max(0, top), port.scrollHeight - port.clientHeight);
      if (Math.abs(port.scrollTop - landing) <= 1) {
        const valid = inputLease();
        requestAnimationFrame(() => {
          if (valid()) actual.focus({preventScroll: true});
        });
        return "unchanged";
      }
    }
    return pane.router.push(`/daily/${chosen}`, { newVisit: true, entry: { kind: "RevealDailyDate", focus: true } });
  }, [window.geometry, pane.router, today, inputLease]);
  const chrome = useMemo(() => ({ displayTitle: "journal", navigation: { label: "journal dates", content: <div {...type} className={styles.navigation}>
    <Button ref={datesTrigger} aria-haspopup="dialog" aria-expanded={pickerDate !== null} aria-description={name} onClick={() => setPickerDate(readingDate)}>
      dates <span className={styles.runningName} aria-hidden="true" data-yielded={yielded || undefined}>{name}</span>
    </Button>
    {today === null ? null : <Button onClick={() => choose(today)}>today</Button>}
  </div> } }), [type, readingDate, name, yielded, pickerDate, today, choose]);
  usePaneChrome(chrome);

  const editingEntry = delivery?.entry.kind === "AppendNote" || delivery?.entry.kind === "FocusNote" || delivery?.entry.kind === "EditPageTitle";
  const receivingArrival = editingEntry || delivery?.entry.kind === "RevealDailyDate";
  const pinned = useMemo(() => {
    const dates = new Set([...retained.keys(), ...window.requested]);
    if (window.opening !== null) dates.add(window.opening);
    if (receivingArrival) dates.add(arrival);
    return [...dates].filter(date => directory.byDate.has(date)).sort().reverse();
  }, [arrival, directory.byDate, receivingArrival, retained, window.opening, window.requested]);
  const shown = mergeDates(window.nearby, pinned);
  const nearby = new Set(window.nearby);
  const visible = new Set(window.visible);
  const bandBox = bandRef.current?.getBoundingClientRect();
  const port = window.geometry.read()?.scrollport;
  const portBand = port && paneVisibleBand(port);
  const bandVisible = Boolean(today && bandBox && portBand && bandBox.bottom > portBand.top && bandBox.top < portBand.bottom);
  return <WorkHistoryContext.Provider value={work.history}><div {...type}>
    {today === null ? null : <div ref={bandRef} tabIndex={-1} data-row-focusable="true" className={styles.band} data-pane-return-scope="journal-band" data-collection-row-id="band">
      <p className={cx(styles.bandDate, "reader-display")}><time dateTime={today}>{formatDay(today, today)}</time></p>
      <JournalBandMenu key={today} date={today} refId={directory.byDate.get(today)?.ref ?? null} visible={bandVisible} />
    </div>}
    {work.history ? <WorkSection history={work.history} /> : null}
    {index.error === null ? null : <AuthoredReadFailure error={index.error} pending={index.pending} retry={index.retry} noun="your journal" />}
    <PaneRefreshAnchor identity="journal" value={directory.dates} ready={true}><div ref={root} role="feed" aria-label="journal" data-pane-return-scope="journal"
      className={styles.feed} style={{ height: window.height }}>
      {shown.map(date => {
        const rank = window.ranks.get(date)!;
        const receiving = date === arrival && receivingArrival;
        const attached = nearby.has(date) && (window.opening !== date || visible.has(date));
        return <JournalDay key={date} day={directory.byDate.get(date)!} arrival={arrival} today={today} rank={rank} window={window}
          count={members === null ? null : directory.dates.length} attached={attached || window.requested.has(date) || receiving}
          visible={visible.has(date)} headless={headless && date === today} menuInBand={bandVisible && date === today}
          headRef={!showBand && date === readingDate ? setTarget : undefined}
          forced={editingEntry && date === arrival || window.bodies.has(date)} mayArrive={mayArrive}
          allowance={allowance} presentationAllowance={presentationAllowance} retain={retain}
          newer={directory.dates[rank - 1] ?? null} older={directory.dates[rank + 1] ?? null} />;
      })}
    </div></PaneRefreshAnchor>
    {pickerDate === null ? null : <JournalDates readingDate={pickerDate} today={today}
      directory={{ dates: recordedDates, error: index.error, pending: index.pending, retry: index.retry }}
      choose={choose} dismiss={() => setPickerDate(null)} returnFocusTo={() => datesTrigger.current} />}
  </div></WorkHistoryContext.Provider>;
}

function JournalDay({ day, arrival, today, window, rank, count, visible, attached, headless, menuInBand, forced, headRef,
  allowance, presentationAllowance, retain, mayArrive, newer, older }: {
  day: Day; arrival: string; today: string | null; window: ReturnType<typeof useJournalWindow>; rank: number; count: number | null;
  visible: boolean; attached: boolean; headless: boolean; menuInBand: boolean; forced: boolean;
  headRef: ((node: HTMLElement | null) => void) | undefined;
  allowance: OutlineHistoryAllowance; presentationAllowance: OutlinePresentationAllowance;
  retain(date: string, ref: string | null, keep: boolean): void;
  mayArrive(activation: string): boolean | null; newer: string | null; older: string | null;
}) {
  const date = day.local_date;
  const heading = useId();
  const name = formatDay(date, today);
  const reveal = usePaneRevealAnchor();
  const article = useRef<HTMLElement | null>(null);
  const natural = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [outlineStarted, setOutlineStarted] = useState(false);
  const [outlineResult, setOutlineResult] = useState<{ state: Opening; error: unknown | null }>({ state: "pending", error: null });
  const onOpening = useCallback((state: Opening, error: unknown | null) => setOutlineResult({ state, error }), []);
  const outlineRetry = useRef<() => void>(() => {});
  const opening = outlineResult.state;
  const [protectedSession, setProtectedSession] = useState(false);
  const [controller, setController] = useState<OutlineController | null>(null);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editTitle, setEditTitle] = useState(false);
  const passive = window.opening === date;
  const request = forced || focused || editTitle || passive && visible;
  const { begin, release, settle, measure, descendant, article: register } = window;
  const ref = useCallback((element: HTMLElement | null) => {
    article.current = element;
    register(date, element);
  }, [date, register]);
  const bound = useJournalBinding(date, day.ref, started);
  // The opener remains mounted until its issued binding and completed-work reads settle.
  const value = bound.value;
  if (!started && request) setStarted(true);
  if (!outlineStarted && started && value !== null && request) setOutlineStarted(true);
  // A completed binding without an issued outline can reenter passive selection.
  const ownsOpening = started && (request || outlineStarted || value === null);
  useLayoutEffect(() => {
    if (!ownsOpening) return;
    begin(date);
    return () => release(date);
  }, [date, ownsOpening, begin, release]);
  const completed = useAuthoredPages(started ? { kind: "work_completed", local_date: date, cursor: null, limit: 100 } : null);
  const completedFirst = completed.data !== null || completed.error !== null;
  const bindingFailed = value === null && bound.error !== null;
  const outlineFirst = bindingFailed || outlineStarted && opening !== "pending";
  useLayoutEffect(() => descendant(date, bindingFailed ? "failed" : opening), [date, bindingFailed, opening, descendant]);
  const abandoned = !request && !outlineStarted && (value !== null || bindingFailed);
  const settled = completedFirst && (outlineFirst || abandoned);
  useLayoutEffect(() => {
    if (!passive || !settled && (started || request)) return;
    if (abandoned) setStarted(false);
    settle(date);
  }, [passive, settled, started, request, abandoned, date, settle]);
  const shown = attached || focused || menuOpen || editTitle;
  const protectedDay = protectedSession || focused || menuOpen || editTitle;
  useLayoutEffect(() => retain(date, value?.ref ?? day.ref, started && !settled || protectedDay),
    [date, value, day.ref, started, settled, protectedDay, retain]);
  useLayoutEffect(() => {
    if (started && settled && !shown && !passive) setStarted(false);
  }, [started, settled, shown, passive]);
  useLayoutEffect(() => {
    if (controller === null || !focused || document.activeElement !== article.current) return;
    return controller.holdReadingWindow(null);
  }, [controller, focused]);
  const hasWriting = opening === "ready";
  const hasWork = Boolean(completed.data?.rows.length);
  const fullyMeasured = hasWriting && completed.error === null && completed.data !== null;
  useLayoutEffect(() => {
    if (!shown || (!hasWriting && !hasWork) || !natural.current) return;
    return measure(date, natural.current, fullyMeasured);
  }, [shown, hasWriting, hasWork, fullyMeasured, date, measure]);

  const reading = (next: string | null) => { if (next !== null) reveal("journal", next, true); };
  const failedRead = bindingFailed || outlineResult.error !== null || completed.error !== null;
  const waiting = started && !failedRead && (!outlineFirst || !completedFirst);
  const showStatus = visible && (passive || request || window.reading === date) && (waiting || failedRead);
  const size = window.sizes.get(date) ?? JOURNAL_DAY_ESTIMATE;
  const top = window.tops[rank];
  const statusTop = Math.max(0, window.viewport.from - top);
  return <article ref={ref} hidden={!shown} className={styles.day} style={{ top, height: size }} data-journal-date={date}
      data-last={count === null || rank + 1 === count || undefined}
      data-pane-return-scope="journal" data-collection-row-id={date} data-row-focusable="true"
      tabIndex={0} aria-labelledby={heading} aria-posinset={count === null ? undefined : rank + 1} aria-setsize={count ?? undefined}
      onFocus={() => setFocused(true)}
      onBlur={event => {
        const next = event.relatedTarget;
        if (next === null && controller?.ownsReadingHandoff()) return;
        if (!(next instanceof Node && article.current?.contains(next))) setFocused(false);
      }} onKeyDown={event => {
        if (event.target !== event.currentTarget || !["PageUp", "PageDown"].includes(event.key)) return;
        event.preventDefault();
        reading(event.key === "PageUp" ? newer : older);
      }}>
      <div className={styles.natural} ref={natural}>
        <div ref={headRef} data-journal-heading={headless ? undefined : ""} className={cx(styles.heading, headless && "sr-only")}>
          <h2 id={heading}><time dateTime={date} className={styles.dayName}>{name}</time></h2>
          {!headless && (!menuInBand || menuOpen) && value !== null ? <DayMenu date={date} name={name} refId={value.ref} onOpen={setMenuOpen} edit={() => setEditTitle(true)} /> : null}
        </div>
        {outlineStarted && value !== null ? <DayWriting binding={value} date={date} arrival={arrival} attached={started}
          allowance={allowance} presentationAllowance={presentationAllowance} mayArrive={mayArrive}
          onOpening={onOpening} retryRef={outlineRetry} onRetain={setProtectedSession} onController={setController}
          editTitle={editTitle} onEditTitle={() => setEditTitle(false)} /> : null}
        <CompletedWork date={date} read={completed} />
        <nav className={`${styles.continuation} sr-only`} aria-label="journal reading">
          {newer === null ? null : <Button onClick={() => reading(newer)}>newer day</Button>}
          {older === null ? null : <Button onClick={() => reading(older)}>older day</Button>}
        </nav>
      </div>
      {showStatus ? <div className={styles.status} style={{ top: `min(${statusTop}px, max(0px, calc(100% - 7lh)))` }}>
        <RulingRegion value={`journal-day:${heading}`}>
          {bindingFailed ? <AuthoredReadFailure error={bound.error} pending={bound.pending} retry={bound.retry} noun="this day" />
            : waiting ? <Ruling /> : null}
          <AuthoredReadFailure error={outlineResult.error} retry={() => outlineRetry.current()} noun="linked items" />
          <AuthoredReadFailure error={completed.error} pending={completed.pending} retry={completed.retry} noun="completed work" />
        </RulingRegion>
      </div> : null}
    </article>;
}

function useJournalBinding(date: string, refId: string | null, enabled: boolean) {
  const writing = useWritingRuntime();
  const [attempt, setAttempt] = useState(0);
  const [bound, setBound] = useState<{ value: Binding | null; error: unknown | null; pending: boolean }>({
    value: null, error: null, pending: false,
  });
  const read = enabled && refId === null && bound.value === null;
  useEffect(() => {
    if (!read) return;
    let retired = false;
    setBound(previous => ({ ...previous, pending: true }));
    void dailyPage(writing, date).then(value => {
      if (!retired) setBound({ value, error: null, pending: false });
    }, error => { if (!retired) setBound(previous => ({ ...previous, error, pending: false })); });
    return () => { retired = true; };
  }, [read, writing, date, attempt]);
  const value = useMemo<Binding | null>(() => refId === null ? bound.value : { ref: refId, prelude: EMPTY_INTENTS }, [refId, bound.value]);
  return { value, error: refId === null ? bound.error : null, pending: read && bound.pending, retry: () => setAttempt(value => value + 1) };
}

function JournalBandMenu({ date, refId, visible }: { date: string; refId: string | null; visible: boolean }) {
  const pane = requirePaneRuntime(usePaneRuntime(), "JournalBandMenu");
  const [open, setOpen] = useState(false);
  const active = visible || open;
  const bound = useJournalBinding(date, refId, active);
  if (!active || bound.value === null) return null;
  const ref = bound.value.ref;
  return <DayMenu date={date} name={formatDay(date, date)} refId={ref} onOpen={setOpen}
    edit={() => pane.router.push(`/daily/${date}`, { entry: { kind: "EditPageTitle", pageId: ref.slice(5) } })} />;
}

function DayMenu({ date, name, refId, onOpen, edit }: {
  date: string; name: string; refId: string; onOpen(open: boolean): void; edit(): void;
}) {
  const pageId = refId.slice(5);
  return <span className={styles.menu}><ContextualActionMenu title={name} subjectKey={`journal:${date}`}
    onOpenChange={onOpen} label={`actions for ${name}`} navigation={null}
    resourceRef={canonicalResourceRef({ scheme: "page", id: pageId })}
    omitResourceActions={["EditPageTitle"]} sections={[{ id: "View", actions: [
      { kind: "link", id: "Journal.OpenPage", label: "Open page", icon: null, href: `/pages/${pageId}` },
      { kind: "command", id: "Journal.EditTitle", label: "Edit title", icon: null, restoreFocusOnClose: false, onSelect: edit },
    ] }]} /></span>;
}

function DayWriting({ binding, date, arrival, attached, allowance, presentationAllowance, mayArrive, onOpening, onRetain, onController, editTitle, onEditTitle, retryRef }: {
  binding: Binding; date: string; arrival: string; attached: boolean; allowance: OutlineHistoryAllowance; presentationAllowance: OutlinePresentationAllowance;
  mayArrive(activation: string): boolean | null; onOpening(state: Opening, error: unknown | null): void; retryRef: React.RefObject<() => void>; onRetain(keep: boolean): void;
  onController(controller: OutlineController | null): void; editTitle: boolean; onEditTitle(): void;
}) {
  const { delivery, claim } = usePaneEntryDelivery();
  const { say } = useOutcome();
  const reveal = usePaneRevealAnchor();
  const api = useRef<LocalOutlineHandle | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const outline = useLocalOutlineRoot({ rootRef: binding.ref, prelude: binding.prelude, rootField: TITLE, apiRef: api,
    occurrencePrefix: `journal:${date}:outline`, attached, historyAllowance: allowance, presentationAllowance, rootPresentation: "inline", initialRows: 1, quietOpening: true });
  const { rootReady, showTitle } = outline;
  useLayoutEffect(() => { onOpening(outline.opening, outline.error); }, [outline.opening, outline.error, onOpening]);
  useLayoutEffect(() => { retryRef.current = outline.retry; });
  useLayoutEffect(() => { onRetain(outline.retainSession); }, [outline.retainSession, onRetain]);
  useLayoutEffect(() => { onController(outline.controller); return () => onController(null); }, [outline.controller, onController]);
  const failed = useCallback((error: unknown) => {
    if (isAuthoredStorageFailure(error)) say({ fact: "couldn’t open this writing." });
    else if (!(error instanceof LocalCommitError)) setDefect({ error });
  }, [say]);
  useEffect(() => {
    if (!editTitle || !rootReady || !api.current) return;
    onEditTitle();
    showTitle();
    void api.current.focusRoot().catch(failed);
  }, [editTitle, rootReady, onEditTitle, showTitle, failed]);
  useEffect(() => {
    if (!delivery || date !== arrival || !rootReady || !api.current) return;
    const entry = delivery.entry;
    if (entry.kind !== "AppendNote" && entry.kind !== "EditPageTitle" && entry.kind !== "FocusNote") return;
    const admitted = mayArrive(delivery.activationId);
    if (admitted === null) return;
    if (!admitted) { claim(delivery); return; }
    if (entry.kind === "AppendNote") {
      if (!claim(delivery)) return;
      reveal("journal", date, false);
      void api.current.append().catch(failed);
    } else if (entry.kind === "EditPageTitle") {
      if (!claim(delivery)) return;
      if (`page:${entry.pageId}` !== binding.ref) { say({ fact: "this page is no longer available." }); return; }
      reveal("journal", date, false);
      showTitle();
      void api.current.focusRoot().catch(failed);
    } else {
      const abort = new AbortController();
      void api.current.focusNote(`note_block:${entry.noteBlockId}`, abort.signal).then(found => {
        if (!abort.signal.aborted && claim(delivery) && !found) say({ fact: "this note is no longer on this page." });
      }, error => { if (!abort.signal.aborted) failed(error); });
      return () => abort.abort();
    }
  }, [delivery, claim, date, arrival, rootReady, showTitle, binding.ref, reveal, failed, say, mayArrive]);
  if (defect !== null) throw defect.error;
  return <>
    {outline.rootEditor === null ? null : <div className={styles.title}>{outline.rootEditor}</div>}
    {outline.view}
  </>;
}
