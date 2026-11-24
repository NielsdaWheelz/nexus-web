"use client";

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueryResult, WorkIndexItem } from "@nexus/authored/types";
import { useOutcome } from "@/components/feedback/Feedback";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import WorkCheckbox, { type WorkCompletion } from "@/components/notes/WorkCheckbox";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Input from "@/components/ui/Input";
import ResourceList from "@/components/ui/ResourceList";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { useAccountToday } from "@/lib/notes/accountDay";
import { captureTaskToday } from "@/lib/notes/api";
import { useAuthoredIndex, useAuthoredQuery, useWritingDocument, useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError, type LocalCommit } from "@/lib/notes/runtime";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkOverlayContext, tryWorkCommand } from "@/lib/notes/work";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { localResourceLabel } from "@/lib/resources/localResource";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import * as Icon from "@/lib/ui/icons";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useWorkGuard } from "@/lib/unsavedWork";
import { PaneRefreshAnchor } from "@/lib/workspace/paneReturnMemento";
import styles from "./dailyWork.module.css";

/** The row stands drawn done this long after the press, measured from the press's own input timestamp. Holds are
 * waits: reduced motion keeps them, and neither waits for the local write. */
const DWELL_MS = 600;
/** The receipt stands this long from its display, then leaves. A pressed undo keeps it until the undo settles. */
const RECEIPT_MS = 5000;

/** An agenda completion. This section owns its durable `write`, so a refusal or a defect is not lost with the row or
 * the receipt. `press` names the gesture: a late promise or timer for an older press of the same row changes
 * nothing. `commit` is the write's commit once it is durable.
 * dwell: the row stands drawn done until DWELL_MS after the press, and while the reader is using it; then receipt.
 * receipt: `completed · {line}` and `undo`, RECEIPT_MS from its display; then expired.
 * expired: drawn nowhere. The pending read may list the row until it reaches the commit; this keeps it hidden.
 * restored: the undo is durable; the open row stands from its snapshot until the pending read reaches the undo.
 * A record is deleted when its write is refused (the row returns); when a pending page at or after its commit
 * lists the row again (a later change outranks it); when expired, by a page at or after its commit; and when
 * restored, by a page at or after the undo. */
type Pressed = { press: symbol; date: string; snapshot: WorkIndexItem; write: Promise<LocalCommit | null>; commit: LocalCommit | null };
type Completion =
  | Pressed & { phase: "dwell"; at: number }
  | Pressed & { phase: "receipt"; undoing: boolean }
  | Pressed & { phase: "expired" }
  | { phase: "restored"; press: symbol; snapshot: WorkIndexItem; undo: LocalCommit };
type Step = (ref: string, press: symbol, next: (completion: Completion) => Completion | null) => void;

const workIndex = (result: QueryResult) => result.work_index;
const pressed = ({press, date, snapshot, write, commit}: Pressed): Pressed => ({press, date, snapshot, write, commit});
const reached = (revision: string, commit: LocalCommit) => BigInt(revision) >= BigInt(commit.store_revision);

export default function WorkSection({history}:{history:OutlineHistory}) {
  const today = useAccountToday();
  const read = useAuthoredIndex(today === null ? null : {kind:"work_pending", local_date:today, start:0, limit:2048, expected_revision:null}, workIndex);
  const {say} = useOutcome();
  const {value:open,set:setOpen} = useResourceDraft("Work.Open",()=>true);
  const [adding, setAdding] = useState(false);
  const [held, setHeld] = useState<ReadonlyMap<string, WorkIndexItem>>(() => new Map());
  const [completions, setCompletions] = useState<ReadonlyMap<string, Completion>>(() => new Map());
  const [failure, setFailure] = useState<{error:unknown}|null>(null);
  const list = useRef<HTMLUListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  const contentId = useId();
  const hold = useCallback((resource:WorkIndexItem, keep:boolean) => setHeld(previous => {
    if (keep ? previous.get(resource.ref) === resource : !previous.has(resource.ref)) return previous;
    const next = new Map(previous);
    if (keep) next.set(resource.ref,resource); else next.delete(resource.ref);
    return next;
  }), []);
  // The one writer of an existing record.
  const step = useCallback<Step>((ref, press, next) => setCompletions(previous => {
    const current = previous.get(ref);
    if (current?.press !== press) return previous;
    const value = next(current);
    if (value === current) return previous;
    const map = new Map(previous);
    if (value === null) map.delete(ref); else map.set(ref, value);
    return map;
  }), []);
  const fail = useCallback((error:unknown) => setFailure({error}), []);
  useLayoutEffect(() => {
    const page = read.data;
    if (page === null) return;
    const listed = new Set(page.items.map(row => row.ref));
    setCompletions(previous => {
      let next: Map<string, Completion> | null = null;
      for (const [ref, completion] of previous) {
        const ended = completion.phase === "restored" ? reached(page.revision, completion.undo)
          : completion.commit !== null && reached(page.revision, completion.commit) && (completion.phase === "expired" || listed.has(ref));
        if (ended) (next ??= new Map(previous)).delete(ref);
      }
      return next ?? previous;
    });
  }, [read.data, completions]);
  useLayoutEffect(() => {
    if (adding || !refocusAdd.current) return;
    refocusAdd.current = false;
    add.current?.focus({preventScroll:true});
  }, [adding]);
  // The first live sign among `refs`, in order, else `add a task`.
  const signOf = useCallback((refs:readonly string[]) => {
    for (const ref of refs) {
      const sign = list.current?.querySelector<HTMLElement>(`[data-work-ref="${CSS.escape(ref)}"] [role="checkbox"]:not([aria-disabled="true"])`);
      if (sign) return sign;
    }
    return add.current;
  }, []);
  const layout = useMemo(() => ({rows:read.data?.items ?? null,held,completions,open,adding}),[read.data?.items,held,completions,open,adding]);
  if (failure) throw failure.error;
  const pending = new Map((read.data?.items ?? []).map(resource => [resource.ref, resource] as const));
  const visible = new Map([...held, ...pending]);
  for (const [ref, completion] of completions) {
    if (completion.phase === "expired") visible.delete(ref);
    else if (!visible.has(ref)) visible.set(ref, completion.snapshot);
  }
  const rows = [...visible.values()];
  rows.sort((a,b) => {
    if (!a.work || !b.work) throw new Error("work list lacks capture state");
    const left=BigInt(a.work.captured.lamport), right=BigInt(b.work.captured.lamport);
    return left < right ? -1 : left > right ? 1 : a.work.captured.replica_id.localeCompare(b.work.captured.replica_id) || a.ref.localeCompare(b.ref);
  });
  const refs = rows.map(row => row.ref);
  // Focus after a row: the next live sign, else the nearest before it, else `add a task`.
  const around = (index:number) => [...refs.slice(index+1), ...refs.slice(0,index).reverse()];
  // A completing press, in its own event. The write is sent first; nothing it does reaches the pending query before
  // this event ends, so the record holds the row from here. A keyboard completion moves focus to the next sign now.
  const complete = (resource:WorkIndexItem, index:number, {intent, keyboard, at}:WorkCompletion) => {
    if (today === null) return;
    const ref = resource.ref, press = Symbol(ref);
    const write = tryWorkCommand(history, intent, say);
    setCompletions(previous => new Map(previous).set(ref, {phase:"dwell", press, date:today, snapshot:resource, write, commit:null, at}));
    void write.then(
      commit => step(ref, press, current => current.phase === "restored" ? current : commit === null ? null : {...current, commit}),
      error => {step(ref, press, () => null); fail(error);});
    if (keyboard) signOf(around(index))?.focus({preventScroll:true});
  };
  return <PaneRefreshAnchor identity="work" value={layout} ready={today === null || read.data !== null}><section className={styles.work} aria-label="work" data-pane-return-scope="work">
    <div className={styles.header} data-collection-row-id="header">
      <Button className={styles.disclosure} icon={<Icon.Disclose open={open} size={12} className={styles.chevron} />}
        aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>work</Button>
      <ButtonLink className={styles.habits} href="/habits">habits</ButtonLink>
    </div>
    <div id={contentId} hidden={!open}>
      {today === null ? <AccountCalendarUnavailable /> : null}
      <AuthoredReadFailure {...read} noun="unfinished work" />
      <ResourceList ref={list} ariaLabel="unfinished work" busy={read.pending && read.data === null}>
        {rows.map((resource, index) => {
          const completion = completions.get(resource.ref);
          return completion?.phase === "receipt"
            ? <Receipt key={resource.ref} completion={completion} history={history} step={step} fail={fail}
              recover={() => signOf([resource.ref, ...around(index)])} />
            : <WorkRow key={resource.ref} resource={resource} retained={!pending.has(resource.ref)} today={today} history={history} hold={hold}
              completion={completion} step={step} onComplete={press => complete(resource, index, press)}
              recover={() => list.current?.querySelector<HTMLElement>(`[data-work-ref="${CSS.escape(resource.ref)}"] [data-receipt-undo]`) ?? signOf(around(index))} />;
        })}
      </ResourceList>
      {adding ? <TaskCapture history={history} onClose={() => {refocusAdd.current = true; setAdding(false);}} />
        : <div className={styles.add} data-collection-row-id="capture">
          <Button ref={add} disabled={today === null} onClick={() => setAdding(true)}>add a task</Button>
        </div>}
    </div>
  </section></PaneRefreshAnchor>;
}

function Receipt({completion, history, step, fail, recover}:{
  completion:Extract<Completion, {phase:"receipt"}>; history:OutlineHistory; step:Step; fail(error:unknown):void; recover():HTMLElement | null;
}) {
  const {say} = useOutcome();
  const root = useRef<HTMLLIElement>(null);
  const {press, date, snapshot, write, undoing} = completion, ref = snapshot.ref;
  // Removed while focused (expiry, undo, refusal, or a later change), the receipt hands focus to this row's sign, else the next.
  useActionFocusRecovery(root, recover);
  // RECEIPT_MS from display. A pressed undo owns settlement and focus until it settles; refused, it is offered again.
  useLayoutEffect(() => {
    if (undoing) return;
    const timer = setTimeout(() => step(ref, press, current => current.phase === "receipt" && !current.undoing ? {...pressed(current), phase:"expired"} : current), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [ref, press, undoing, step]);
  const line = snapshot.label === null ? "name too large to display" : snapshot.label || "empty note";
  // The inverse is the completion's own civil day cleared, sent only once the completion itself is durable. A refused
  // completion sends nothing: its record is already gone and the row is back. A completion's defect is the section's.
  const undo = () => {
    if (undoing) return;
    step(ref, press, current => current.phase === "receipt" ? {...current, undoing:true} : current);
    void write.then(commit => commit === null ? null : tryWorkCommand(history, {kind:"clear_work_day", ref, local_date:date}, say), () => null).then(
      undone => step(ref, press, current => current.phase !== "receipt" ? current
        : undone === null ? {...current, undoing:false} : {phase:"restored", press, snapshot:current.snapshot, undo:undone}),
      error => {step(ref, press, current => current.phase === "receipt" ? {...current, undoing:false} : current); fail(error);});
  };
  return <li ref={root} className={styles.receipt} data-work-ref={ref} data-collection-row-id={ref}>
    <span className={styles.receiptLine}>completed<span aria-hidden="true"> · </span>{line}</span>
    <Button className={styles.undo} data-receipt-undo="" aria-label={`undo: ${line}`} aria-busy={undoing} onClick={undo}>undo</Button>
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

function WorkRow({resource:initial,retained,today,history,hold,completion,step,onComplete,recover}:{
  resource:WorkIndexItem;retained:boolean;today:string|null;history:OutlineHistory;
  hold(resource:WorkIndexItem,keep:boolean):void;completion:Completion | undefined;step:Step;
  onComplete(completion:WorkCompletion):void;
  /** Where focus goes when the focused control leaves with the row: its own receipt's undo, in place, else the next sign. */
  recover():HTMLElement|null;
}) {
  const read = useAuthoredQuery(retained ? {kind:"resource",ref:initial.ref} : null);
  const resource = retained ? read.data?.items[0]?.resource ?? initial : initial;
  const deleted = retained && read.data !== null && read.data.rows.length === 0;
  const overlay = useContext(WorkOverlayContext);
  const opened = useWritingDocument(resource.ref);
  const document = opened.document;
  // Where focus is in this row. Focus on the sign alone is not a use of the row: the receipt replaces it and takes it.
  const [focus,setFocus] = useState<"none" | "sign" | "other">("none");
  const [pins,setPins] = useState(0);
  const [attachment,setAttachment] = useState(false);
  const [reference,setReference] = useState(false);
  const [menuOpen,setMenuOpen] = useState(false);
  const root = useRef<HTMLLIElement>(null);
  const captured = useRef(initial);
  useActionFocusRecovery(root,recover);
  const rowWindow = useMemo(() => ({
    interact: () => {},
    pin: () => {
      setPins(value => value + 1);
      return () => setPins(value => value - 1);
    },
  }),[]);
  // What the reader is using in this row: focus in its writing or menu, an editor's pending edits or open inputs, the menu, an
  // overlay. None of it is removed from under them. The row stays listed for these and for focus on its sign.
  const retaining = focus === "other" || pins > 0 || attachment || reference || menuOpen || overlay === resource.ref;
  const listed = retaining || focus === "sign";
  useLayoutEffect(() => {hold(resource,listed);},[resource,listed,hold]);
  useEffect(() => () => hold(captured.current,false),[hold]);
  // The dwell: DWELL_MS from the press's own timestamp, whatever the local write is doing. The timer re-arms rather
  // than fire early. Then the row becomes its receipt, unless the reader is using it.
  const dwell = completion?.phase === "dwell" ? completion : null;
  const press = dwell === null ? null : dwell.press, at = dwell === null ? 0 : dwell.at;
  const [dwelt,setDwelt] = useState<symbol | null>(null);
  useEffect(() => {
    if (press === null) return;
    let timer = 0;
    const wait = () => {
      const left = DWELL_MS - (performance.now() - at);
      if (left > 0) timer = window.setTimeout(wait, left); else setDwelt(press);
    };
    wait();
    return () => clearTimeout(timer);
  }, [press, at]);
  const ref = resource.ref;
  useLayoutEffect(() => {
    if (press === null || dwelt !== press || retaining) return;
    step(ref, press, current => current.phase === "dwell" ? {...pressed(current), phase:"receipt", undoing:false} : current);
  }, [ref, press, dwelt, retaining, step]);
  // The journal's paint of a completion until a projection at or after its commit is in hand: then the row is canonical.
  const presentDone = dwell !== null && !(dwell.commit !== null && retained && read.data !== null && reached(read.data.store_revision, dwell.commit));
  return <IndexRowWindow window={rowWindow} id={resource.ref}><li ref={root} className={styles.row} data-work-ref={resource.ref} data-collection-row-id={resource.ref}
    onFocusCapture={event => {if (event.currentTarget.contains(event.target)) setFocus(event.target.closest('[role="checkbox"]') ? "sign" : "other");}}
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      queueMicrotask(() => {if (!root.current?.contains(window.document.activeElement)) setFocus("none");});
    }}>
    <span className={styles.sign}>{deleted ? null : <WorkCheckbox resource={resource} today={today} history={history} presentDone={presentDone} onComplete={onComplete} />}</span>
    <div className={styles.writing}>
      {deleted ? <p className={styles.muted}>this note was deleted.</p> : null}
      <AuthoredReadFailure {...opened} noun="this task" />
      <AuthoredReadFailure {...read} noun="this work" />
      {document ? <BoundNoteEditor noteRef={resource.ref} document={document} session={history} onAttachmentActiveChange={setAttachment} onLinkInputActiveChange={setReference} /> : null}
    </div>
    {resource.work?.designation.kind === "habit" ? <span className={styles.tail}>daily</span> : null}
    <span className={styles.menu}>{deleted ? null : <ContextualActionMenu subjectKey={`work:${resource.ref}`} resourceRef={canonicalResourceRef({scheme:"note_block",id:resource.ref.slice(11)})}
      title={resource.label || "note"} navigation={null} sections={[]} onOpenChange={setMenuOpen} />}</span>
  </li></IndexRowWindow>;
}
