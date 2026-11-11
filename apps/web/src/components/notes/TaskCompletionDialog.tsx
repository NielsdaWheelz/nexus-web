"use client";

import {useEffect, useId, useRef, useState} from "react";
import {WorkUnavailableError, type ResourceProjection} from "@nexus/authored/types";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {useAccountToday} from "@/lib/notes/accountDay";
import {workCommand} from "@/lib/notes/work";
import type {OutlineHistory} from "@/lib/notes/structure";
import type {ReturnFocusTarget} from "@/lib/ui/overlay";
import {isLocalDate} from "@/lib/localDate";
import {localResourceLabel} from "@/lib/resources/localResource";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import {Ruling} from "@/components/feedback/Ruling";
import AuthoredReadFailure from "./AuthoredReadFailure";

export default function TaskCompletionDialog({noteRef,history,onClose,returnFocusTo,returnFocusFallback}: {
  noteRef:string; history:OutlineHistory; onClose():void; returnFocusTo:ReturnFocusTarget; returnFocusFallback:ReturnFocusTarget;
}) {
  const read = useAuthoredQuery({kind:"resource",ref:noteRef});
  const resource = read.data?.rows[0]?.resource ?? null;
  return <Dialog open title="completion date" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <AuthoredReadFailure {...read} noun="this task"/>
    {resource ? <CompletionForm resource={resource} history={history} onClose={onClose}/>
      : read.data ? <p>this note is no longer available.</p> : read.error === null ? <Ruling/> : null}
  </Dialog>;
}

function CompletionForm({resource,history,onClose}: {resource:ResourceProjection;history:OutlineHistory;onClose():void}) {
  const today = useAccountToday(), id = useId();
  const [date,setDate] = useState(resource.work?.task_completed_on ?? today);
  const [busy,setBusy] = useState(false), [defect,setDefect] = useState<{error:unknown}|null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const valid = isLocalDate(date) && date <= today;
  if (defect) throw defect.error;
  return <form onSubmit={event => {
    event.preventDefault(); if (!valid || busy) return;
    setBusy(true);
    void workCommand(history,{kind:"set_task_completion",ref:resource.ref,local_date:date,today}).then(() => {
      if (mounted.current) onClose();
    }, error => {if (mounted.current && !(error instanceof WorkUnavailableError)) setDefect({error});}).finally(() => {if (mounted.current) setBusy(false);});
  }}>
    <p>{localResourceLabel(resource)}</p>
    <label htmlFor={id}>completed on</label>
    <Input id={id} type="date" required max={today} value={date} disabled={busy} onChange={event => setDate(event.target.value)} aria-invalid={!valid}/>
    {!valid ? <p>choose today or an earlier date.</p> : null}
    <Button type="submit" disabled={!valid || busy}>save</Button>{" "}<Button type="button" onClick={onClose}>cancel</Button>
  </form>;
}
