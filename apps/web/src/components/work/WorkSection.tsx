"use client";

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResourceProjection } from "@nexus/authored/types";
import { WorkUnavailableError } from "@nexus/authored/types";
import { useOutcome } from "@/components/feedback/Feedback";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import WorkCheckbox from "@/components/notes/WorkCheckbox";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Input from "@/components/ui/Input";
import ResourceList from "@/components/ui/ResourceList";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { useAccountToday } from "@/lib/notes/accountDay";
import { captureTaskToday } from "@/lib/notes/api";
import { useAuthoredPages, useAuthoredQuery, useWritingDocument, useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkOverlayContext, workCommand } from "@/lib/notes/work";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { localResourceLabel } from "@/lib/resources/localResource";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import * as Icon from "@/lib/ui/icons";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useWorkGuard } from "@/lib/unsavedWork";
import { PaneRefreshAnchor } from "@/lib/workspace/paneReturnMemento";
import styles from "./dailyWork.module.css";

/** A completed row holds its place this long, filled, before its receipt. Holds are waits: reduced motion keeps them. */
const DWELL_MS = 600;
/** The receipt stands this long, then leaves. */
const RECEIPT_MS = 5000;

/** A completion pressed in the agenda, held from the press so the commit cannot remove its row first.
 * dwell: the row stands, drawn done, until DWELL_MS have passed and the commit has landed, and while focus edits it.
 * receipt: the row's place reads `completed · {line}` with `undo`. restored: undo committed; the open row
 * stands from its snapshot until the pending page catches up. `seen` is the pending page when the commit (or the
 * undo's) landed: a later page that still lists the ref outranks this completion, and the row returns as it is. */
type Completion = {
  id: symbol; date: string; resource: ResourceProjection; phase: "dwell" | "receipt" | "restored";
  committed: boolean; dwelt: boolean; seen: unknown; undoing: boolean; focus: boolean;
};

export default function WorkSection({history}:{history:OutlineHistory}) {
  const today = useAccountToday();
  const read = useAuthoredPages(today === null ? null : {kind:"work_pending", local_date:today, cursor:null, limit:100});
  const {say} = useOutcome();
  const {value:open,set:setOpen} = useResourceDraft("Work.Open",()=>true);
  const [adding, setAdding] = useState(false);
  const [held, setHeld] = useState<ReadonlyMap<string, ResourceProjection>>(() => new Map());
  const [completions, setCompletions] = useState<ReadonlyMap<string, Completion>>(() => new Map());
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<{error:unknown}|null>(null);
  const list = useRef<HTMLUListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  const page = useRef(read.data);
  useLayoutEffect(() => {page.current = read.data;});
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => {for (const timer of pending.values()) clearTimeout(timer); pending.clear();};
  }, []);
  const contentId = useId();
  const hold = useCallback((resource:ResourceProjection, keep:boolean) => setHeld(previous => {
    if (keep ? previous.get(resource.ref) === resource : !previous.has(resource.ref)) return previous;
    const next = new Map(previous);
    if (keep) next.set(resource.ref,resource); else next.delete(resource.ref);
    return next;
  }), []);
  const lease = useCallback((ref:string, active:boolean) => setEditing(previous => {
    if (previous.has(ref) === active) return previous;
    const next = new Set(previous);
    if (active) next.add(ref); else next.delete(ref);
    return next;
  }), []);
  const change = useCallback((ref:string, id:symbol, next:(completion:Completion) => Completion | null) => setCompletions(previous => {
    const completion = previous.get(ref);
    if (completion?.id !== id) return previous;
    const value = next(completion), map = new Map(previous);
    if (value === null) map.delete(ref); else map.set(ref,value);
    return map;
  }), []);
  const after = useCallback((ref:string, ms:number, run:() => void) => {
    clearTimeout(timers.current.get(ref));
    timers.current.set(ref, window.setTimeout(() => {timers.current.delete(ref); run();}, ms));
  }, []);
  // Called in the press's own event, before the commit can reach the pending query: the row is held from here.
  const start = useCallback((resource:ResourceProjection, date:string, committed:Promise<boolean>) => {
    const ref = resource.ref, id = Symbol(ref);
    setCompletions(previous => new Map(previous).set(ref, {id, date, resource, phase:"dwell", committed:false, dwelt:false, seen:null, undoing:false, focus:false}));
    after(ref, DWELL_MS, () => change(ref, id, completion => ({...completion, dwelt:true})));
    void committed.then(done => change(ref, id, completion => done ? {...completion, committed:true, seen:page.current} : null));
  }, [after, change]);
  // The receipt's inverse is the completion's own civil day, cleared: never a toggle of whatever state the row now shows.
  const undo = (ref:string, completion:Completion, focused:boolean) => {
    if (completion.undoing) return;
    clearTimeout(timers.current.get(ref)); timers.current.delete(ref);
    change(ref, completion.id, value => ({...value, undoing:true}));
    void workCommand(history, {kind:"clear_work_day", ref, local_date:completion.date}).then(
      () => change(ref, completion.id, value => ({...value, phase:"restored", undoing:false, seen:page.current, focus:focused})),
      error => {
        change(ref, completion.id, value => ({...value, undoing:false}));
        after(ref, RECEIPT_MS, () => change(ref, completion.id, () => null));
        if (error instanceof WorkUnavailableError) say({fact:error.message}); else setFailure({error});
      });
  };
  useLayoutEffect(() => {
    const listed = new Set(read.data?.rows.map(row => row.resource.ref) ?? []);
    for (const [ref, completion] of completions) {
      if (completion.seen !== null && read.data !== null && read.data !== completion.seen && (completion.phase === "restored" || listed.has(ref))) {
        change(ref, completion.id, () => null);
      } else if (completion.phase === "dwell" && completion.committed && completion.dwelt && !editing.has(ref)) {
        const sign = list.current?.querySelector(`[data-work-ref="${CSS.escape(ref)}"] [role="checkbox"]`) ?? null;
        // A sign holding focus is replaced by the receipt in place; focus goes to its undo rather than the body.
        change(ref, completion.id, value => ({...value, phase:"receipt", focus:sign !== null && sign === document.activeElement}));
        after(ref, RECEIPT_MS, () => change(ref, completion.id, () => null));
      } else if (completion.phase === "restored" && completion.focus) {
        list.current?.querySelector<HTMLElement>(`[data-work-ref="${CSS.escape(ref)}"] [role="checkbox"]`)?.focus({preventScroll:true});
        change(ref, completion.id, value => ({...value, focus:false}));
      }
    }
  }, [completions, editing, read.data, change, after]);
  useLayoutEffect(() => {
    if (adding || !refocusAdd.current) return;
    refocusAdd.current = false;
    add.current?.focus({preventScroll:true});
  }, [adding]);
  // The next live sign after this row, else the nearest before it, else `add a task`.
  const nextSign = useCallback((from:HTMLElement | null) => {
    const signs = [...(list.current?.querySelectorAll<HTMLElement>('[role="checkbox"]:not([aria-disabled="true"])') ?? [])];
    if (from === null) return add.current;
    const following = signs.find(sign => !from.contains(sign) && (from.compareDocumentPosition(sign) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    const preceding = signs.filter(sign => (from.compareDocumentPosition(sign) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);
    return following ?? preceding[preceding.length - 1] ?? add.current;
  }, []);
  const layout = useMemo(() => ({rows:read.data?.rows ?? null,held,completions,open,adding}),[read.data?.rows,held,completions,open,adding]);
  if (failure) throw failure.error;
  const rows = [...(read.data?.rows.map(row => row.resource) ?? [])];
  const present = new Set(rows.map(row => row.ref));
  for (const [ref, resource] of held) if (!present.has(ref)) rows.push(resource);
  for (const [ref, completion] of completions) if (!present.has(ref) && !held.has(ref)) rows.push(completion.resource);
  rows.sort((a,b) => {
    if (!a.work || !b.work) throw new Error("work list lacks capture state");
    const left=BigInt(a.work.captured.lamport), right=BigInt(b.work.captured.lamport);
    return left < right ? -1 : left > right ? 1 : a.work.captured.replica_id.localeCompare(b.work.captured.replica_id) || a.ref.localeCompare(b.ref);
  });
  return <PaneRefreshAnchor identity="work" value={layout} ready={today === null || read.data !== null}><section className={styles.work} aria-label="work" data-pane-return-scope="work">
    <div className={styles.header} data-collection-row-id="header">
      <Button className={styles.disclosure} aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>
        <Icon.Disclose open={open} size={12} className={styles.chevron} />work
      </Button>
      <ButtonLink className={styles.habits} href="/habits">habits</ButtonLink>
    </div>
    <div id={contentId} hidden={!open}>
      {today === null ? <AccountCalendarUnavailable /> : null}
      <AuthoredReadFailure {...read} noun="unfinished work" />
      <ResourceList ref={list} ariaLabel="unfinished work" busy={read.pending && read.data === null}>
        {rows.map(resource => {
          const completion = completions.get(resource.ref);
          return completion?.phase === "receipt"
            ? <Receipt key={resource.ref} completion={completion} onUndo={focused => undo(resource.ref, completion, focused)} />
            : <WorkRow key={resource.ref} resource={resource} retained={!present.has(resource.ref)} today={today} history={history} hold={hold} lease={lease}
              completing={completion?.phase === "dwell"} onCompleting={committed => {if (today !== null) start(resource, today, committed);}}
              returnFocus={nextSign} />;
        })}
      </ResourceList>
      {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={read.more} aria-busy={read.pending}>show more work</Button> : null}
      {adding ? <TaskCapture history={history} onClose={() => {refocusAdd.current = true; setAdding(false);}} />
        : <div className={styles.add} data-collection-row-id="capture">
          <Button ref={add} disabled={today === null} onClick={() => setAdding(true)}>add a task</Button>
        </div>}
    </div>
  </section></PaneRefreshAnchor>;
}

function Receipt({completion, onUndo}:{completion:Completion; onUndo(focused:boolean):void}) {
  const undo = useRef<HTMLButtonElement>(null);
  const line = localResourceLabel(completion.resource);
  useLayoutEffect(() => {if (completion.focus) undo.current?.focus({preventScroll:true});}, [completion.focus]);
  return <li className={styles.receipt} data-work-ref={completion.resource.ref} data-collection-row-id={completion.resource.ref}>
    <span className={styles.receiptLine}>completed<span aria-hidden="true"> · </span>{line}</span>
    <Button ref={undo} className={styles.undo} aria-label={`undo: ${line}`} aria-busy={completion.undoing}
      onClick={event => onUndo(document.activeElement === event.currentTarget)}>undo</Button>
  </li>;
}

function TaskCapture({history,onClose}:{history:OutlineHistory;onClose():void}) {
  const runtime = useWritingRuntime();
  const draft = useResourceDraft("Work.Capture", () => ({text:""}), value => ({changed:value.text.length>0,unconfirmed:false,stopsBrowserWork:false}), value => value.text);
  const guard = useWorkGuard();
  const [busy,setBusy] = useState(false);
  const submit = () => {
    const submitted = draft.read();
    const text = submitted.text;
    if (!text.trim() || busy || today === null) return;
    setBusy(true);
    const accepted = () => {
      setBusy(false);
      if (draft.read() === submitted) {draft.set({text:""}); onClose();}
    };
    void captureTaskToday(runtime, today, crypto.randomUUID(), text, history).then(accepted, error => {
      if (error instanceof LocalCommitError) void error.completion.then(accepted, () => setBusy(false));
      else {setBusy(false); setFailure({error});}
    });
  };
  const today = useAccountToday();
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  if (failure) throw failure.error;
  return <form className={styles.capture} data-collection-row-id="capture" onSubmit={event => {event.preventDefault(); submit();}}>
    <Input autoFocus aria-label="task" placeholder="task" value={draft.value.text} onChange={event => draft.set({text:event.target.value})} />
    <Button type="submit" disabled={!draft.value.text.trim() || busy || today === null} aria-busy={busy}>add</Button>
    <Button disabled={busy} onClick={() => {if (guard.confirmLoss({scopes:[],ownerIds:[draft.owner]})) {draft.set({text:""}); onClose();}}}>cancel</Button>
  </form>;
}

function WorkRow({resource:initial,retained,today,history,hold,lease,completing,onCompleting,returnFocus}:{
  resource:ResourceProjection;retained:boolean;today:string|null;history:OutlineHistory;
  hold(resource:ResourceProjection,keep:boolean):void;lease(ref:string,active:boolean):void;
  completing:boolean;onCompleting(committed:Promise<boolean>):void;returnFocus(from:HTMLElement|null):HTMLElement|null;
}) {
  const read = useAuthoredQuery(retained ? {kind:"resource",ref:initial.ref} : null);
  const resource = retained ? read.data?.rows[0]?.resource ?? initial : initial;
  const deleted = retained && read.data !== null && read.data.rows.length === 0;
  const overlay = useContext(WorkOverlayContext);
  const opened = useWritingDocument(resource.ref);
  const document = opened.document;
  const [focused,setFocused] = useState(false);
  const [writingFocused,setWritingFocused] = useState(false);
  const [pins,setPins] = useState(0);
  const [attachment,setAttachment] = useState(false);
  const [reference,setReference] = useState(false);
  // The read in hand when this row's completion was pressed; only a later one shows the commit.
  const [pressedRead,setPressedRead] = useState<unknown>(null);
  const root = useRef<HTMLLIElement>(null);
  const writing = useRef<HTMLDivElement>(null);
  const captured = useRef(initial);
  useActionFocusRecovery(root,() => returnFocus(root.current));
  const rowWindow = useMemo(() => ({
    interact: () => {},
    pin: () => {
      setPins(value => value + 1);
      return () => setPins(value => value - 1);
    },
  }),[]);
  useLayoutEffect(() => {hold(resource,focused || pins > 0 || attachment || reference || overlay === resource.ref);},[resource,focused,pins,attachment,reference,overlay,hold]);
  useEffect(() => () => hold(captured.current,false),[hold]);
  // The real editing lease: focus in this row's writing, or one of its editor's own inputs open.
  const ref = resource.ref, editing = writingFocused || attachment || reference;
  useLayoutEffect(() => {lease(ref,editing);},[ref,editing,lease]);
  useEffect(() => () => lease(ref,false),[ref,lease]);
  // The journal's paint of a completion its projection has not shown: until this row's own read reports after the press.
  const presentDone = completing && !(retained && read.data !== null && read.data !== pressedRead);
  return <IndexRowWindow window={rowWindow} id={resource.ref}><li ref={root} className={styles.row} data-work-ref={resource.ref} data-collection-row-id={resource.ref}
    onFocusCapture={event => {
      if (!event.currentTarget.contains(event.target)) return;
      setFocused(true);
      setWritingFocused(writing.current?.contains(event.target) ?? false);
    }}
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      queueMicrotask(() => {if (!root.current?.contains(window.document.activeElement)) {setFocused(false); setWritingFocused(false);}});
    }}>
    <span className={styles.sign}>{deleted ? null : <WorkCheckbox resource={resource} today={today} history={history} presentDone={presentDone}
      onCompleting={committed => {setPressedRead(read.data); onCompleting(committed);}}
      onCompleted={({keyboard}) => {if (keyboard) returnFocus(root.current)?.focus({preventScroll:true});}} />}</span>
    <div ref={writing} className={styles.writing}>
      {deleted ? <p className={styles.muted}>this note was deleted.</p> : null}
      <AuthoredReadFailure {...opened} noun="this task" />
      <AuthoredReadFailure {...read} noun="this work" />
      {document ? <BoundNoteEditor noteRef={resource.ref} document={document} session={history} onAttachmentActiveChange={setAttachment} onLinkInputActiveChange={setReference} /> : null}
    </div>
    {resource.work?.designation.kind === "habit" ? <span className={styles.tail}>daily</span> : null}
    <span className={styles.menu}>{deleted ? null : <ContextualActionMenu subjectKey={`work:${resource.ref}`} resourceRef={canonicalResourceRef({scheme:"note_block",id:resource.ref.slice(11)})}
      title={resource.body_text || "note"} navigation={null} sections={[]} />}</span>
  </li></IndexRowWindow>;
}
