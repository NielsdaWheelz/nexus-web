"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Intent } from "@nexus/authored/commands";
import { Ruling } from "@/components/feedback/Ruling";
import { useOutcome } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { useLocalOutlineRoot, type LocalOutlineHandle } from "@/components/notes/LocalOutline";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useAuthoredAccountId } from "@/lib/authored/provider";
import { formatDay, isLocalDate } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { dailyPage } from "@/lib/notes/api";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { useJournalWindow } from "@/lib/notes/journalWindow";
import { OutlineHistoryAllowance } from "@/lib/notes/outlineHistoryAllowance";
import { OutlinePresentationAllowance } from "@/lib/notes/outlinePresentationAllowance";
import { isAuthoredStorageFailure, LocalCommitError, type WritingRuntime } from "@/lib/notes/runtime";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { cx } from "@/lib/ui/cx";
import * as Icon from "@/lib/ui/icons";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { PaneRefreshAnchor, usePaneAnchorGeometry, usePaneInputLease, usePaneReturnReady, usePaneRevealAnchor } from "@/lib/workspace/paneReturnMemento";
import { useWorkspaceStore } from "@/lib/workspace/store";
import WorkSection from "@/components/work/WorkSection";
import CompletedWork from "@/components/work/CompletedWork";
import { WorkHistoryContext, useWorkHistory } from "@/lib/notes/work";
import styles from "./journal.module.css";

const EMPTY_INTENTS: readonly Intent[] = [];
type Day = { local_date: string; ref: string | null };
type RetainedDay = { day: Day; presented: boolean };
type Resolved = { ref: string; prelude: readonly Intent[] };

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
  const writing = useWritingRuntime();
  const today = useAccountToday();
  const profile = useReaderProfile();
  const type = useMemo(() => readerType(profile), [profile]);
  const { delivery } = usePaneEntryDelivery();
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
  const root = useRef<HTMLDivElement>(null);
  // The one head the running head repeats, bound as a node: a stub replaced by its editing leaf without a render here is still seen.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  // Today's day menu is lent to the band's date line; the slot is state so today's leaf re-renders into it.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [allowance] = useState(() => new OutlineHistoryAllowance());
  const work = useWorkHistory(allowance);
  if (work.error) throw work.error;
  const [, presentationChanged] = useState(0);
  const [presentationAllowance] = useState(() => new OutlinePresentationAllowance(() => presentationChanged(value => value + 1)));
  const [retained, setRetained] = useState<ReadonlyMap<string, RetainedDay>>(() => new Map());
  const [picker, setPicker] = useState(false);
  const [picked, setPicked] = useState(arrival);
  const pickerId = useId();
  const members = index.data?.daily_index ?? null;
  if (index.data !== null && members === null) throw new Error("daily index result is missing");
  const days = useMemo<Day[]>(() => {
    if (members === null) return [];
    const days: Day[] = [...members];
    // Membership loss must not replace a retained editor with a latent arrival.
    for (const value of retained.values()) if ((value.presented || value.day.local_date === arrival) && !days.some(day => day.local_date === value.day.local_date)) days.push(value.day);
    if (!days.some(day => day.local_date === arrival)) days.push({ local_date: arrival, ref: null });
    return days.sort((a, b) => b.local_date.localeCompare(a.local_date));
  }, [members, arrival, retained]);
  const dates = useMemo(() => days.map(day => day.local_date), [days]);
  const window = useJournalWindow(dates, root, members !== null ? "ready" : index.error !== null ? "failed" : "pending",
    presentationAllowance.pressured ? 0 : 1);
  usePaneAnchorGeometry({ scope: "journal", geometry: window.geometry, ready: true });
  usePaneReturnReady(members !== null || index.error !== null);
  const retain = useCallback((day: Day, keep: boolean, presented: boolean) => setRetained(previous => {
    const old = previous.get(day.local_date);
    if (!keep && old === undefined || keep && old?.day.ref === day.ref && old.presented === presented) return previous;
    const next = new Map(previous);
    if (keep) next.set(day.local_date, { day, presented }); else next.delete(day.local_date);
    return next;
  }), []);
  const activateTarget = pane.activateTarget;
  const go = useCallback((href: string) => activateTarget({ target: { href }, disposition: { kind: "Follow" } }), [activateTarget]);
  // A headless today is drawn by the band; its own head stays for the accessibility tree and journalWindow.
  const headless = today !== null && days[0]?.local_date === today;
  const date = window.visible ?? arrival;
  const name = formatDay(date, today);
  // The running head yields while the head it repeats is in the scrollport. Presentation only: no geometry reads it.
  // A headless today is repeated from the band; any other day from its own head.
  const watchBand = headless && date === today;
  const [seen, setSeen] = useState<{ target: Element; intersecting: boolean } | null>(null);
  useLayoutEffect(() => {
    const port = target?.closest<HTMLElement>("[data-pane-content]") ?? null;
    if (target === null || port === null) return;
    // Any part of the head in the port's visible band yields.
    const see = (intersecting: boolean) =>
      setSeen(previous => previous?.target === target && previous.intersecting === intersecting ? previous : { target, intersecting });
    // Before paint, once. After that the browser reports the intersection itself, so a row or the agenda
    // reflowing above the head is seen though nothing scrolled and the head kept its size.
    const band = paneVisibleBand(port), head = target.getBoundingClientRect();
    see(head.bottom > band.top && head.top < band.bottom);
    // The band's top is the port's top padding (the phone's opaque chrome), carried as a negative root margin
    // and rebuilt only when that padding changes; a padding change resizes the port's content box.
    let inset: number | null = null, observer: IntersectionObserver | null = null;
    const observe = () => {
      const next = parseFloat(getComputedStyle(port).paddingTop);
      if (next === inset) return;
      inset = next;
      observer?.disconnect();
      observer = new IntersectionObserver(entries => see(entries[entries.length - 1]!.isIntersecting), { root: port, rootMargin: `${-next}px 0px 0px 0px` });
      observer.observe(target);
    };
    observe();
    const sizes = new ResizeObserver(observe);
    sizes.observe(port);
    return () => { sizes.disconnect(); observer?.disconnect(); };
  }, [target]);
  const yielded = seen !== null && seen.target === target && seen.intersecting;
  const chrome = useMemo(() => ({ displayTitle: "journal", navigation: { label: "journal dates", content: <div {...type} className={styles.navigation}>
    <Button className={styles.runningHead} data-yielded={yielded || undefined} aria-haspopup="dialog" aria-expanded={picker}
      onClick={() => { setPicked(date); setPicker(true); }} aria-label={`go to date: ${name}`}>
      <span className={styles.runningName}>{name}</span><Icon.Choose size={12} />
    </Button>
    {date === today ? null : <Button onClick={() => go("/daily")}>today</Button>}
  </div> } }), [type, yielded, picker, date, name, today, go]);
  usePaneChrome(chrome);
  const receiving = delivery !== null && ["RevealDailyDate", "AppendNote", "FocusNote", "EditPageTitle"].includes(delivery.entry.kind);
  // A headless today is always admitted: the band's date line holds its menu even when a tall agenda puts the leaf below the fold.
  const lending = headless ? today : null;
  const mounted = new Map([...[...retained].map(([date, value]) => [date, value.day] as const),
    ...days.filter(day => window.dates.includes(day.local_date) || receiving && day.local_date === arrival || day.local_date === lending)
      .map(day => [day.local_date, day] as const)]);
  const shown = [...mounted.values()].sort((a, b) => b.local_date.localeCompare(a.local_date));
  return <WorkHistoryContext.Provider value={work.history}><div {...type}>
    {/* The band is today's reveal anchor: its .5lh top space is inside its box, so its top is the pane's start. */}
    {today === null ? null : <div ref={watchBand ? setTarget : undefined} className={styles.band} data-pane-return-scope="journal-band" data-collection-row-id="band">
      <p className={cx(styles.bandDate, "reader-display")}><time dateTime={today}>{formatDay(today, today)}</time></p>
      <span ref={setSlot} className={styles.menu} />
    </div>}
    {work.history ? <WorkSection history={work.history} /> : null}
    {index.error === null ? null : <AuthoredReadFailure error={index.error} pending={index.pending} retry={index.retry} noun="your journal" />}
      <PaneRefreshAnchor identity="journal" value={days} ready={members !== null}><div ref={root} role="feed" aria-label="journal" data-pane-return-scope="journal"
        className={styles.feed} style={{ height: members === null ? undefined : window.height }}>
        {members === null && index.error === null ? <Ruling /> : null}
        {shown.map(day => {
          const rank = dates.indexOf(day.local_date);
          return <JournalDay key={day.local_date} day={day} arrival={arrival} writing={writing} allowance={allowance} presentationAllowance={presentationAllowance}
            attached={(day.local_date === arrival || members !== null && members.some(member => member.local_date === day.local_date)) &&
              (window.dates.includes(day.local_date) || receiving && day.local_date === arrival || day.local_date === lending)}
            rank={rank} count={days.length} top={rank < 0 ? 0 : window.tops[rank]}
            today={today} headless={headless && day.local_date === today} slot={slot}
            headRef={!watchBand && day.local_date === date ? setTarget : undefined}
            measure={window.measure} admit={window.admit} retain={retain} mayArrive={mayArrive}
            newer={rank === 0 ? null : dates[rank - 1]} older={rank + 1 === dates.length ? null : dates[rank + 1]} />;
        })}
      </div></PaneRefreshAnchor>
    <Dialog open={picker} title="go to date" onClose={() => setPicker(false)}>
      <form className={styles.picker} onSubmit={event => {
        event.preventDefault();
        if (isLocalDate(picked) && go(`/daily/${picked}`).kind !== "Cancelled") setPicker(false);
      }}>
        <label htmlFor={pickerId}>date</label>
        <Input id={pickerId} type="date" required value={picked} onChange={event => setPicked(event.target.value)} />
        <Button type="submit" disabled={!isLocalDate(picked)}>go</Button>
      </form>
    </Dialog>
  </div></WorkHistoryContext.Provider>;
}

function JournalDay(props: {
  day: Day; arrival: string; writing: WritingRuntime; allowance: OutlineHistoryAllowance; presentationAllowance: OutlinePresentationAllowance;
  attached: boolean; rank: number; count: number; top: number;
  today: string | null; headless: boolean; slot: HTMLElement | null;
  headRef: ((node: HTMLElement | null) => void) | undefined;
  measure(date: string, element: HTMLElement | null): void; retain(day: Day, keep: boolean, presented: boolean): void;
  admit(date: string, state: "pending" | "ready" | "failed"): void;
  mayArrive(activation: string): boolean | null;
  newer: string | null; older: string | null;
}) {
  const { day, writing } = props;
  const heading = useId();
  const stub = useRef<HTMLElement>(null);
  const reveal = usePaneRevealAnchor();
  const [attempt, retry] = useState(0);
  const [resolved, setResolved] = useState<{ value: Resolved | null; error: unknown | null; pending: boolean }>({ value: null, error: null, pending: true });
  useEffect(() => {
    if (day.ref !== null) return;
    let retired = false;
    setResolved(previous => ({ ...previous, pending: true }));
    void dailyPage(writing, day.local_date).then(value => {
      if (!retired) setResolved({ value, error: null, pending: false });
    }, error => { if (!retired) setResolved(previous => ({ ...previous, error, pending: false })); });
    return () => { retired = true; };
  }, [day.local_date, day.ref, writing, attempt]);
  const value = useMemo<Resolved | null>(() => day.ref === null ? resolved.value : { ref: day.ref, prelude: EMPTY_INTENTS }, [day.ref, resolved.value]);
  const { measure, admit } = props;
  useLayoutEffect(() => {
    if (value !== null) return;
    measure(day.local_date, stub.current);
    admit(day.local_date, resolved.error === null ? "pending" : "failed");
    return () => measure(day.local_date, null);
  }, [value, day.local_date, measure, admit, resolved.error]);
  return value === null ? <article ref={stub} className={styles.day} style={{ top: props.top }} data-journal-date={day.local_date}
    data-last={props.rank >= 0 && props.rank + 1 === props.count || undefined}
    data-pane-return-scope="journal" data-collection-row-id={day.local_date} data-row-focusable="true" tabIndex={0}
    aria-labelledby={heading} aria-posinset={props.rank + 1} aria-setsize={props.count} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      const date = event.key === "PageUp" ? props.newer : event.key === "PageDown" ? props.older : null;
      if (date !== null) { event.preventDefault(); reveal("journal", date, true); }
    }}>
    <div ref={props.headRef} className={cx(styles.heading, props.headless && "sr-only")}><h2 id={heading}>
      <time dateTime={day.local_date} className={styles.dayName}>{formatDay(day.local_date, props.today)}</time></h2></div>
    {resolved.error === null ? <Ruling /> : <AuthoredReadFailure error={resolved.error} pending={resolved.pending} retry={() => retry(value => value + 1)} noun="this day" />}
  </article> : <DayEditing {...props} resolved={value} />;
}

function DayEditing({ day, arrival, resolved, allowance, presentationAllowance, attached, rank, count, top, today, headless, slot, headRef, measure, admit, retain, mayArrive, newer, older }: Parameters<typeof JournalDay>[0] & { resolved: Resolved }) {
  const { delivery, claim } = usePaneEntryDelivery();
  const { say } = useOutcome();
  const reveal = usePaneRevealAnchor();
  const article = useRef<HTMLElement>(null);
  const api = useRef<LocalOutlineHandle | null>(null);
  const hold = useRef<(() => void) | null>(null);
  const heading = useId();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused,setFocused] = useState(false);
  const rootField = useMemo(() => ({ label: "page title", placeholder: "" }), []);
  const outline = useLocalOutlineRoot({ rootRef: resolved.ref, prelude: resolved.prelude, rootField, apiRef: api,
    occurrencePrefix: `journal:${day.local_date}:outline`, attached, historyAllowance: allowance, presentationAllowance, rootPresentation: "inline", initialRows: 1 });
  const controller = outline.controller;
  const { rootReady, showTitle } = outline;
  useLayoutEffect(() => {
    admit(day.local_date, outline.rootRead.known && outline.ready ? "ready" : outline.error !== null ? "failed" : "pending");
  }, [day.local_date, outline.rootRead.known, outline.ready, outline.error, admit]);
  const visible = attached || outline.view !== null || menuOpen || focused;
  useLayoutEffect(() => {
    retain({ local_date: day.local_date, ref: resolved.ref }, outline.retainSession || menuOpen || focused, visible);
  }, [day.local_date, resolved.ref, outline.retainSession, menuOpen, focused, visible, retain]);
  useLayoutEffect(() => {
    const node = article.current;
    measure(day.local_date, visible ? node : null);
    return () => measure(day.local_date, null);
  }, [day.local_date, measure, visible]);
  useEffect(() => () => { hold.current?.(); hold.current = null; }, []);
  const failed = useCallback((error: unknown) => {
    if (isAuthoredStorageFailure(error)) say({ fact: "couldn’t open this writing." });
    else if (!(error instanceof LocalCommitError)) setDefect({ error });
  }, [say]);
  useEffect(() => {
    if (!delivery || day.local_date !== arrival || !rootReady || !api.current) return;
    const entry = delivery.entry;
    const admitted = mayArrive(delivery.activationId);
    if (admitted === null) return;
    if (!admitted) { claim(delivery); return; }
    if (entry.kind === "RevealDailyDate") {
      // Today opens on the band, wherever today's leaf stands; another date opens on its own day.
      if (claim(delivery)) { if (day.local_date === today) reveal("journal-band", "band", false); else reveal("journal", day.local_date, false); }
    } else if (entry.kind === "AppendNote") {
      if (!claim(delivery)) return;
      // Memento demand retains an offscreen day after its delivery is claimed.
      reveal("journal", day.local_date, false);
      void api.current.append().catch(failed);
    } else if (entry.kind === "EditPageTitle") {
      if (!claim(delivery)) return;
      if (`page:${entry.pageId}` !== resolved.ref) { say({ fact: "this page is no longer available." }); return; }
      reveal("journal", day.local_date, false);
      showTitle();
      void api.current.focusRoot().catch(failed);
    } else if (entry.kind === "FocusNote") {
      const abort = new AbortController();
      void api.current.focusNote(`note_block:${entry.noteBlockId}`, abort.signal).then(found => {
        if (!abort.signal.aborted && claim(delivery) && !found) say({ fact: "this note is no longer on this page." });
      }, error => { if (!abort.signal.aborted) failed(error); });
      return () => abort.abort();
    }
  }, [delivery, claim, day.local_date, arrival, today, rootReady, showTitle, resolved.ref, reveal, failed, say, mayArrive]);
  if (defect !== null) throw defect.error;
  const reading = (date: string | null) => {
    if (date === null) return;
    hold.current?.(); hold.current = null;
    reveal("journal", date, true);
  };
  const name = formatDay(day.local_date, today);
  // The lent menu stays a React child of this leaf: its focus and open state retain the day, though its node is in the band.
  // It is lent only while the leaf is shown, so a hidden retained leaf leaves no focusable trigger in the band.
  const lent = headless && slot !== null && visible;
  // Focus ownership is the leaf's article and, while lent, the band's slot: a portal's React ancestry is not its place.
  const owns = (node: EventTarget | null) => node instanceof Node && (article.current?.contains(node) === true || lent && slot !== null && slot.contains(node));
  const menu = <ContextualActionMenu title={name} subjectKey={`journal:${day.local_date}`}
    onOpenChange={setMenuOpen}
    label={`actions for ${name}`} navigation={null} resourceRef={canonicalResourceRef({ scheme: "page", id: resolved.ref.slice(5) })}
    omitResourceActions={["EditPageTitle"]} sections={[{ id: "View", actions: [
      { kind: "link", id: "Journal.OpenPage", label: "Open page", icon: null, href: `/pages/${resolved.ref.slice(5)}` },
      { kind: "command", id: "Journal.EditTitle", label: "Edit title", icon: null, restoreFocusOnClose: false, onSelect: () => {
        showTitle(); void api.current?.focusRoot().catch(failed);
      } },
    ] }]} />;
  return <article ref={article} hidden={!visible} className={styles.day} style={{ top }} data-journal-date={day.local_date}
    data-last={rank >= 0 && rank + 1 === count || undefined} data-pane-return-scope="journal" data-collection-row-id={day.local_date} data-row-focusable="true"
    tabIndex={0} aria-labelledby={heading} aria-posinset={rank < 0 ? undefined : rank + 1} aria-setsize={count}
    onFocus={event => {
      setFocused(true);
      retain({local_date:day.local_date,ref:resolved.ref},true,true);
      if (event.target === event.currentTarget && controller) { hold.current?.(); hold.current = controller.holdReadingWindow(null); }
    }} onBlur={event => {
      if (event.relatedTarget === null && controller?.ownsReadingHandoff()) return;
      if (!owns(event.relatedTarget)) {
        hold.current?.(); hold.current = null;
        if (event.relatedTarget !== null) setFocused(false);
      }
    }} onKeyDown={event => {
      if (event.target !== event.currentTarget || !["PageUp", "PageDown"].includes(event.key)) return;
      event.preventDefault(); reading(event.key === "PageUp" ? newer : older);
    }}>
    <div ref={headRef} className={cx(styles.heading, headless && "sr-only")}>
      <h2 id={heading}><time dateTime={day.local_date} className={styles.dayName}>{name}</time></h2>
      {lent ? null : <span className={styles.menu}>{menu}</span>}
    </div>
    {lent ? createPortal(menu, slot) : null}
    {outline.rootEditor === null ? null : <div className={styles.title}>{outline.rootEditor}</div>}
    {outline.view}
    <CompletedWork date={day.local_date} />
    <nav className={`${styles.continuation} sr-only`} aria-label="journal reading">
      {newer === null ? null : <Button onClick={() => reading(newer)}>newer day</Button>}
      {older === null ? null : <Button onClick={() => reading(older)}>older day</Button>}
    </nav>
  </article>;
}
