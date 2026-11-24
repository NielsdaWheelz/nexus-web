"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Intent } from "@nexus/authored/commands";
import type { DailyIndexEntry, DailyIndexSource, QueryResult } from "@nexus/authored/types";
import { Ruling, RulingRegion } from "@/components/feedback/Ruling";
import { useOutcome } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { useLocalOutlineRoot, type LocalOutlineHandle } from "@/components/notes/LocalOutline";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import CompletedWork from "@/components/work/CompletedWork";
import WorkSection from "@/components/work/WorkSection";
import { useWorkRegister } from "@/components/work/workRegister";
import { useAuthoredAccountId } from "@/lib/authored/provider";
import { formatDay, isLocalDate } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { dailyPage } from "@/lib/notes/api";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { JOURNAL_DAY_ESTIMATE, journalOrder, useJournalWindow } from "@/lib/notes/journalWindow";
import { useRankedAuthoredWindow } from "@/lib/notes/rankedAuthoredWindow";
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
import { PaneRefreshAnchor, usePaneAnchorGeometry, usePaneInputLease, usePaneReturnReady, usePaneRevealAnchor, usePaneScrollMotion } from "@/lib/workspace/paneReturnMemento";
import { useWorkspaceStore, type WorkspaceNavigationResult } from "@/lib/workspace/store";
import JournalDates from "./JournalDates";
import styles from "./journal.module.css";

type Day = { local_date: string; ref: string | null };
const dailyIndex = (result: QueryResult) => result.daily_index;
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
  const retainedDates = [...retained.keys()].filter(date => date !== arrival).sort().join(",");
  const source = useMemo<DailyIndexSource>(() => ({kind: "daily_index", arrival, retained: retainedDates === "" ? [] : retainedDates.split(",")}), [arrival, retainedDates]);
  const index = useAuthoredQuery({...source, at: {kind: "describe"}, expected_revision: null});
  const last = useRef<QueryResult | null>(null);
  const admitted = index.data ?? last.current;
  useLayoutEffect(() => { if (index.data !== null) last.current = index.data; }, [index.data]);
  const description = admitted?.daily_index;
  if (admitted !== null && description?.kind !== "description") throw new Error("daily index description is missing");
  const revision = admitted?.store_revision ?? null;
  // Durable dates already belong to the union. Focusing one need not retire its admitted ranges.
  const syntheticDates = description?.kind === "description" ? description.attachments
    .filter(day => !day.recorded && day.local_date !== arrival).map(day => day.local_date).sort().join(",") : "";
  const rankedSource = useMemo<DailyIndexSource>(() => ({kind: "daily_index", arrival,
    retained: syntheticDates === "" ? [] : syntheticDates.split(",")}), [arrival, syntheticDates]);
  const ranked = useRankedAuthoredWindow(rankedSource, revision,
    description?.kind === "description" ? description : null, dailyIndex);
  const byDate = useMemo(() => description?.kind === "description"
    ? new Map([...description.items, ...description.attachments, ...ranked.items.values()].map(day => [day.local_date, day]))
    : new Map<string, DailyIndexEntry>(), [description, ranked.items]);
  const current = useMemo(() => journalOrder(description?.kind === "description" ? description : null), [description]);
  const motion = usePaneScrollMotion();
  const presented = useRef(current);
  const before = presented.current;
  const held = motion !== "still" && before.count > 0;
  const append = motion === "travel" && current.count > before.count &&
    before.dates.every((date, rank) => date === current.dateAt(rank));
  const order = held && !append && (before.observation === null || before.observation !== current.observation) ? before : current;
  useLayoutEffect(() => { presented.current = order; }, [order]);
  const error = index.error ?? ranked.error;
  const retry = index.error === null ? ranked.retry : index.retry;
  const indexState = error !== null ? "failed" : admitted === null ? "pending" : "ready";
  const window = useJournalWindow(order, root, indexState, presentationAllowance.pressured ? 0 : 1, type, held);
  const { opening, settle } = window;
  useLayoutEffect(() => {
    if (opening !== null && current.rankOf(opening) === null && !retained.has(opening)) settle(opening);
  }, [current, opening, retained, settle]);
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
  const headless = today !== null && order.dateAt(0) === today;
  const readingDate = window.reading ?? (admitted !== null && window.viewport.from < 0 ? today : null) ?? arrival;
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
    if (headless) dates.add(today);
    return [...dates].filter(date => order.rankOf(date) !== null || retained.has(date)).sort().reverse();
  }, [arrival, headless, order, receivingArrival, retained, today, window.opening, window.requested]);
  useLayoutEffect(() => {
    if (current.observation === null) return;
    const rankOf = current.rankOf;
    const ranks = window.nearby.flatMap(date => {
      const rank = rankOf(date);
      return rank === null ? [] : [rank - 1, rank, rank + 1];
    });
    ranked.request(ranks, pinned.filter(date => rankOf(date) !== null));
  });
  const recordedDates = useMemo(() => {
    if (pickerDate === null || description?.kind !== "description") return null;
    const unrecorded = new Set([...description.items, ...description.attachments].filter(day => !day.recorded).map(day => day.local_date));
    return current.dates.filter(date => !unrecorded.has(date));
  }, [current, description, pickerDate]);
  const shown = mergeDates(window.nearby, pinned);
  const lastDate = order.dateAt(order.count - 1);
  useLayoutEffect(() => {
    const port = root.current?.closest<HTMLElement>("[data-pane-content]");
    if (!port || lastDate === undefined) return;
    const end = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.defaultPrevented || event.target !== port || event.key !== "End" ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      reveal("journal", lastDate, false);
    };
    port.addEventListener("keydown", end, true);
    return () => port.removeEventListener("keydown", end, true);
  }, [lastDate, reveal]);
  const nearby = new Set(window.nearby);
  const visible = new Set(window.visible);
  const bandBox = bandRef.current?.getBoundingClientRect();
  const port = window.geometry.read()?.scrollport;
  const portBand = port && paneVisibleBand(port);
  const bandVisible = Boolean(today && bandBox && portBand && bandBox.bottom > portBand.top && bandBox.top < portBand.bottom);
  return <WorkHistoryContext.Provider value={work.history}><div {...type}>
    {today === null ? null : <div ref={bandRef} tabIndex={-1} data-row-focusable="true" className={styles.band} data-pane-return-scope="journal-band" data-collection-row-id="band">
      <p className={cx(styles.bandDate, "reader-display")}><time dateTime={today}>{formatDay(today, today)}</time></p>
      <JournalBandMenu key={today} date={today} refId={byDate.get(today)?.ref ?? null} visible={bandVisible} />
    </div>}
    {work.history ? <WorkSection history={work.history} /> : null}
    <AuthoredReadFailure error={error} pending={index.pending} retry={retry} noun="your journal" />
    <PaneRefreshAnchor identity="journal" value={order.observation ?? order.dates} ready={directoryReady}><div ref={root} role="feed" aria-label="journal" data-pane-return-scope="journal"
      className={styles.feed} style={{ height: admitted === null ? undefined : window.height }}>
      {indexState === "pending" ? <Ruling /> : null}
      {shown.map(date => {
        const rank = order.rankOf(date) ?? -1;
        if (rank >= 0 && current.rankOf(date) === null && !retained.has(date))
          return <div key={date} className={styles.day} aria-hidden="true" style={{ top: window.tops[rank], height: window.sizes.get(date) ?? JOURNAL_DAY_ESTIMATE }} />;
        const member = byDate.get(date);
        const day = member?.recorded ? member : retained.get(date) ?? member ?? null;
        const receiving = date === arrival && receivingArrival;
        const attached = nearby.has(date) && (window.opening !== date || visible.has(date));
        return <JournalDay key={date} date={date} day={day} arrival={arrival} today={today} rank={rank} window={window}
          count={order.count} attached={attached || window.requested.has(date) || receiving}
          visible={visible.has(date)} headless={headless && date === today} menuInBand={bandVisible && date === today}
          headRef={!showBand && date === readingDate ? setTarget : undefined}
          forced={editingEntry && date === arrival || window.bodies.has(date)} mayArrive={mayArrive}
          allowance={allowance} presentationAllowance={presentationAllowance} retain={retain}
          newer={rank < 0 ? null : order.dateAt(rank - 1) ?? null} older={rank < 0 ? null : order.dateAt(rank + 1) ?? null} />;
      })}
    </div></PaneRefreshAnchor>
    {pickerDate === null ? null : <JournalDates readingDate={pickerDate} today={today}
      directory={{ dates: recordedDates, error: index.error, pending: index.pending, retry: index.retry }}
      choose={choose} dismiss={() => setPickerDate(null)} returnFocusTo={() => datesTrigger.current} />}
  </div></WorkHistoryContext.Provider>;
}

function JournalDay({ day, date, arrival, today, window, rank, count, visible, attached, headless, menuInBand, forced, headRef,
  allowance, presentationAllowance, retain, mayArrive, newer, older }: {
  day: Day | null; date: string; arrival: string; today: string | null; window: ReturnType<typeof useJournalWindow>; rank: number; count: number;
  visible: boolean; attached: boolean; headless: boolean; menuInBand: boolean; forced: boolean;
  headRef: ((node: HTMLElement | null) => void) | undefined;
  allowance: OutlineHistoryAllowance; presentationAllowance: OutlinePresentationAllowance;
  retain(date: string, ref: string | null, keep: boolean): void;
  mayArrive(activation: string): boolean | null; newer: string | null; older: string | null;
}) {
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
  const request = day !== null && (forced || focused || editTitle || passive && visible);
  const { begin, release, settle, measure, descendant, article: register } = window;
  const ref = useCallback((element: HTMLElement | null) => {
    article.current = element;
    register(date, element);
  }, [date, register]);
  const bound = useJournalBinding(date, day?.ref ?? null, started && day !== null);
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
  const completed = useWorkRegister("work_completed", started && day !== null ? date : null);
  const completedError = completed.read.error ?? completed.error;
  const completedFirst = completed.presentation !== null || completedError !== null;
  const bindingFailed = value === null && bound.error !== null;
  const outlineFirst = bindingFailed || outlineStarted && opening !== "pending";
  const descendantState = !outlineFirst || !completedFirst ? "pending"
    : bindingFailed || opening === "failed" || completedError !== null ? "failed" : "ready";
  useLayoutEffect(() => descendant(date, descendantState), [date, descendantState, descendant]);
  const abandoned = !request && !outlineStarted && (value !== null || bindingFailed);
  const settled = completedFirst && (outlineFirst || abandoned);
  useLayoutEffect(() => {
    if (day === null || !passive || !settled && (started || request)) return;
    if (abandoned) setStarted(false);
    settle(date);
  }, [day, passive, settled, started, request, abandoned, date, settle]);
  const shown = rank >= 0 && (attached || focused || menuOpen || editTitle);
  const protectedDay = protectedSession || focused || menuOpen || editTitle;
  useLayoutEffect(() => retain(date, value?.ref ?? day?.ref ?? null, day !== null && (started && !settled || protectedDay)),
    [date, value, day, started, settled, protectedDay, retain]);
  useLayoutEffect(() => {
    if (started && settled && !shown && !passive) setStarted(false);
  }, [started, settled, shown, passive]);
  useLayoutEffect(() => {
    if (controller === null || !focused || document.activeElement !== article.current) return;
    return controller.holdReadingWindow(null);
  }, [controller, focused]);
  const hasWriting = opening === "ready";
  const hasWork = (completed.presentation?.count ?? 0) > 0;
  const fullyMeasured = hasWriting && completedError === null && completed.presentation !== null;
  useLayoutEffect(() => {
    if (!shown || (!hasWriting && !hasWork) || !natural.current) return;
    return measure(date, natural.current, fullyMeasured);
  }, [shown, hasWriting, hasWork, fullyMeasured, date, measure]);

  const reading = (next: string | null) => { if (next !== null) reveal("journal", next, true); };
  const failedRead = bindingFailed || outlineResult.error !== null || completedError !== null;
  const waiting = started && !failedRead && (!outlineFirst || !completedFirst);
  const showStatus = visible && (passive || request || window.reading === date) && (waiting || failedRead);
  const size = window.sizes.get(date) ?? JOURNAL_DAY_ESTIMATE;
  const top = rank < 0 ? 0 : window.tops[rank];
  const statusTop = Math.max(0, window.viewport.from - top);
  return <article ref={ref} hidden={!shown} className={styles.day} style={{ top, height: size }} data-journal-date={date}
      data-last={rank + 1 === count || undefined}
      data-pane-return-scope="journal" data-collection-row-id={date} data-row-focusable="true"
      tabIndex={0} aria-labelledby={heading} aria-posinset={rank < 0 ? undefined : rank + 1} aria-setsize={count}
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
        <CompletedWork date={date} work={completed} />
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
          <AuthoredReadFailure error={completedError} pending={completed.read.pending} retry={completed.read.error === null ? completed.retry : completed.read.retry} noun="completed work" />
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
    linkSource={{ ref: refId, label: name, target: { kind: "resource", ref: refId }, journalDate: date }}
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
