"use client";

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ResourceProjection } from "@nexus/authored/types";
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
import { WorkOverlayContext } from "@/lib/notes/work";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useWorkGuard } from "@/lib/unsavedWork";
import { PaneRefreshAnchor } from "@/lib/workspace/paneReturnMemento";
import styles from "./dailyWork.module.css";

export default function WorkSection({history}:{history:OutlineHistory}) {
  const today = useAccountToday();
  const read = useAuthoredPages(today === null ? null : {kind:"work_pending", local_date:today, cursor:null, limit:100});
  const {value:open,set:setOpen} = useResourceDraft("Work.Open",()=>true);
  const [adding, setAdding] = useState(false);
  const [held, setHeld] = useState<ReadonlyMap<string, ResourceProjection>>(() => new Map());
  const list = useRef<HTMLUListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const hold = useCallback((resource:ResourceProjection, keep:boolean) => setHeld(previous => {
    if (keep ? previous.get(resource.ref) === resource : !previous.has(resource.ref)) return previous;
    const next = new Map(previous);
    if (keep) next.set(resource.ref,resource); else next.delete(resource.ref);
    return next;
  }), []);
  const layout = useMemo(() => ({rows:read.data?.rows ?? null,held,open,adding}),[read.data?.rows,held,open,adding]);
  const rows = [...(read.data?.rows.map(row => row.resource) ?? [])];
  const present = new Set(rows.map(row => row.ref));
  for (const [ref, resource] of held) if (!present.has(ref)) rows.push(resource);
  rows.sort((a,b) => {
    if (!a.work || !b.work) throw new Error("work list lacks capture state");
    const left=BigInt(a.work.captured.lamport), right=BigInt(b.work.captured.lamport);
    return left < right ? -1 : left > right ? 1 : a.work.captured.replica_id.localeCompare(b.work.captured.replica_id) || a.ref.localeCompare(b.ref);
  });
  return <PaneRefreshAnchor identity="work" value={layout} ready={today === null || read.data !== null}><section className={styles.work} aria-label="work" data-pane-return-scope="work">
    <div className={styles.header} data-collection-row-id="header">
      <Button aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>work</Button>
      <ButtonLink href="/habits">habits</ButtonLink>
      <Button ref={add} disabled={today === null} onClick={() => {setOpen(true); setAdding(true);}}>add task</Button>
    </div>
    <div id={contentId} hidden={!open}>
      {today === null ? <AccountCalendarUnavailable /> : null}
      <AuthoredReadFailure {...read} noun="unfinished work" />
        {adding ? <TaskCapture history={history} onClose={() => {setAdding(false); add.current?.focus({preventScroll:true});}} /> : null}
        <ResourceList ref={list} ariaLabel="unfinished work" busy={read.pending && read.data === null}>
          {rows.map((resource,index) => <WorkRow key={resource.ref} resource={resource} retained={!present.has(resource.ref)} today={today} history={history} hold={hold}
            returnFocus={() => {
              const items = [...(list.current?.querySelectorAll<HTMLElement>('input[type="checkbox"]') ?? [])];
              const next = [...rows.slice(index+1),...rows.slice(0,index).reverse()]
                .map(row => items.find(item => item.closest<HTMLElement>('[data-work-ref]')?.dataset.workRef === row.ref)).find(item => item !== undefined);
              return next ?? add.current;
            }} />)}
        </ResourceList>
        {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={read.more} aria-busy={read.pending}>show more work</Button> : null}
    </div>
  </section></PaneRefreshAnchor>;
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

function WorkRow({resource:initial,retained,today,history,hold,returnFocus}:{
  resource:ResourceProjection;retained:boolean;today:string|null;history:OutlineHistory;
  hold(resource:ResourceProjection,keep:boolean):void;returnFocus():HTMLElement|null;
}) {
  const read = useAuthoredQuery(retained ? {kind:"resource",ref:initial.ref} : null);
  const resource = retained ? read.data?.rows[0]?.resource ?? initial : initial;
  const deleted = retained && read.data !== null && read.data.rows.length === 0;
  const overlay = useContext(WorkOverlayContext);
  const opened = useWritingDocument(resource.ref);
  const document = opened.document;
  const [focused,setFocused] = useState(false);
  const [pins,setPins] = useState(0);
  const [attachment,setAttachment] = useState(false);
  const [reference,setReference] = useState(false);
  const root = useRef<HTMLLIElement>(null);
  const captured = useRef(initial);
  useActionFocusRecovery(root,returnFocus);
  const rowWindow = useMemo(() => ({
    interact: () => {},
    pin: () => {
      setPins(value => value + 1);
      return () => setPins(value => value - 1);
    },
  }),[]);
  useLayoutEffect(() => {hold(resource,focused || pins > 0 || attachment || reference || overlay === resource.ref);},[resource,focused,pins,attachment,reference,overlay,hold]);
  useEffect(() => () => hold(captured.current,false),[hold]);
  return <IndexRowWindow window={rowWindow} id={resource.ref}><li ref={root} className={styles.row} data-work-ref={resource.ref} data-collection-row-id={resource.ref}
    onFocusCapture={event => {if (event.currentTarget.contains(event.target)) setFocused(true);}}
    onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
      queueMicrotask(() => {if (!root.current?.contains(window.document.activeElement)) setFocused(false);});
    }}>
    {deleted ? null : <WorkCheckbox resource={resource} today={today} history={history} onCompleted={() => returnFocus()?.focus({preventScroll:true})} />}
    <div className={styles.writing}>
      {deleted ? <p className={styles.muted}>this note was deleted.</p> : null}
      <AuthoredReadFailure {...opened} noun="this task" />
      <AuthoredReadFailure {...read} noun="this work" />
      {document ? <BoundNoteEditor noteRef={resource.ref} document={document} session={history} onAttachmentActiveChange={setAttachment} onLinkInputActiveChange={setReference} /> : null}
      {resource.work?.designation.kind === "habit" ? <span className={styles.muted}>daily</span> : null}
    </div>
    {deleted ? null : <ContextualActionMenu subjectKey={`work:${resource.ref}`} resourceRef={canonicalResourceRef({scheme:"note_block",id:resource.ref.slice(11)})}
      title={resource.body_text || "note"} navigation={null} sections={[]} />}
  </li></IndexRowWindow>;
}
