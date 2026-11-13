"use client";

import { useEffect, useId, useRef, useState } from "react";
import { WorkUnavailableError } from "@nexus/authored/types";
import AuthoredReadFailure from "./AuthoredReadFailure";
import AccountCalendarUnavailable from "./AccountCalendarUnavailable";
import { Ruling } from "@/components/feedback/Ruling";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { workCommand } from "@/lib/notes/work";
import type { OutlineHistory } from "@/lib/notes/structure";
import { isLocalDate, shiftLocalDate } from "@/lib/localDate";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/work/dailyWork.module.css";

const fullDate = new Intl.DateTimeFormat("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:"UTC"});
export function habitDateLabel(date:string):string {return fullDate.format(new Date(`${date}T12:00:00Z`));}

export default function HabitHistoryDialog({noteRef,local_date,history,onClose,returnFocusTo,returnFocusFallback,open}:{
  noteRef:string;local_date:string;history:OutlineHistory;onClose():void;
  returnFocusTo:ReturnFocusTarget;returnFocusFallback:ReturnFocusTarget;open:boolean;
}) {
  const today = useAccountToday();
  const read = useAuthoredQuery({kind:"resource",ref:noteRef});
  const resource = read.data?.rows[0]?.resource;
  const work = resource?.work;
  const [date,setDate] = useState(local_date);
  const [jump,setJump] = useState(local_date);
  const [busy,setBusy] = useState(false);
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string|null>(null);
  const jumpId = useId();
  const checked = new Set(work?.habit_dates ?? []);
  const activeDate = resource !== undefined && today !== null && date>today && !checked.has(date) ? today : date;
  const month = activeDate.slice(0,7);
  const first = `${month}-01`;
  const monthDate = new Date(`${first}T12:00:00Z`);
  const offset = (monthDate.getUTCDay()+6)%7;
  const dates = Array.from({length:31},(_,index)=>shiftLocalDate(first,index)).filter(day=>day.startsWith(month));
  const latest = work?.habit_dates.at(-1) ?? local_date;
  const last = today === null || latest > today ? latest : today;
  const choose = (next:string,focus:boolean) => {
    if (!isLocalDate(next) || next > last) return;
    const selected = today !== null && next>today && !checked.has(next) ? work?.habit_dates.find(day=>day.startsWith(next.slice(0,7))) : next;
    if (selected === undefined) return;
    if (focus) {
      const target=root.current?.querySelector<HTMLButtonElement>(`[data-habit-date="${selected}"]`);
      if (target && !target.disabled) target.focus(); else pendingFocus.current=selected;
    }
    setDate(selected); setJump(selected);
  };
  const moveMonth = (delta:number) => {
    const next = new Date(`${first}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth()+delta);
    choose(next.toISOString().slice(0,10),true);
  };
  useEffect(() => {
    if (date !== activeDate) {
      const active=document.activeElement;
      if (active === document.body || active instanceof HTMLElement && active.hasAttribute("data-habit-date")) pendingFocus.current=activeDate;
      setDate(activeDate); setJump(activeDate);
    }
    if (pendingFocus.current === null) return;
    const target = root.current?.querySelector<HTMLButtonElement>(`[data-habit-date="${pendingFocus.current}"]`);
    if (target && !target.disabled) {target.focus(); pendingFocus.current=null;}
  }, [date,activeDate,read.data]);
  const toggle = (day:string) => {
    if (busy || !work || today === null || day > today && !checked.has(day)) return;
    setBusy(true);
    const settled = () => setBusy(false);
    void workCommand(history,{kind:"set_habit_completion",ref:noteRef,local_date:day,completed:!checked.has(day),today}).then(settled,error=>{
      settled();
      if (!(error instanceof WorkUnavailableError)) setFailure({error});
    });
  };
  if (failure) throw failure.error;
  return <Dialog open={open} title="habit history" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}
    initialFocus={panel=>panel.querySelector<HTMLButtonElement>(`[data-habit-date="${local_date}"]:not(:disabled)`) ?? panel.querySelector('button[aria-label="previous month"]')}>
    <div ref={root} className={styles.calendar}>
      <AuthoredReadFailure {...read} noun="habit history" />
      {read.data === null && read.error === null ? <Ruling /> : null}
      {read.data !== null && !resource ? <p>this note is no longer available.</p> : null}
      {resource ? <>
        <p>{resource.body_text || "empty note"}</p>
        {today === null ? <AccountCalendarUnavailable /> : null}
        <p className={styles.muted}>checked dates record when you did this. blank dates have no record.</p>
        {work?.designation.kind !== "habit" || !work.designation.enabled ? <p className={styles.muted}>daily repetition is off. recorded dates are kept.</p> : null}
        <div className={styles.controls}>
          <Button aria-label="previous month" disabled={first <= "0001-01-01"} onClick={()=>moveMonth(-1)}>previous month</Button>
          <span>{new Intl.DateTimeFormat("en-US",{month:"long",year:"numeric",timeZone:"UTC"}).format(monthDate)}</span>
          <Button aria-label="next month" disabled={month >= last.slice(0,7)} onClick={()=>moveMonth(1)}>next month</Button>
          <Button disabled={today === null} onClick={()=>{if (today !== null) choose(today,true);}}>today</Button>
        </div>
        <form className={styles.controls} onSubmit={event=>{event.preventDefault();choose(jump,true);}}>
          <label htmlFor={jumpId}>go to date</label>
          <Input id={jumpId} type="date" min="0001-01-01" max={last} value={jump} onChange={event=>setJump(event.target.value)} required />
          <Button type="submit" disabled={!isLocalDate(jump) || jump>last}>go</Button>
        </form>
        <div className={styles.week} role="group" aria-label={`habit dates, ${month}`} aria-busy={busy}>
          {["mon","tue","wed","thu","fri","sat","sun"].map(day=><span key={day} className={styles.weekday}>{day}</span>)}
          {Array.from({length:offset},(_,index)=><span key={`blank:${index}`} />)}
          {dates.map(day=><button key={day} type="button" className={styles.day} data-habit-date={day}
            aria-label={`${habitDateLabel(day)}, ${checked.has(day)?"recorded done":"no record"}`} aria-pressed={checked.has(day)}
            disabled={today === null || read.error !== null || !work || day>today && !checked.has(day)} tabIndex={activeDate===day?0:-1}
            onFocus={()=>setDate(day)} onClick={()=>toggle(day)} onKeyDown={event=>{
              const delta = event.key==="ArrowLeft"?-1:event.key==="ArrowRight"?1:event.key==="ArrowUp"?-7:event.key==="ArrowDown"?7:0;
              if (delta!==0) {
                event.preventDefault();
                let next = shiftLocalDate(day,delta);
                while (today !== null && next>today && next<=last && !checked.has(next)) next=shiftLocalDate(next,delta>0?1:-1);
                choose(next,true);
              }
            }}>{Number(day.slice(8))}</button>)}
        </div>
      </> : null}
    </div>
  </Dialog>;
}
