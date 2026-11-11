"use client";

import { useEffect, useRef, useState } from "react";
import { shiftLocalDate } from "@/lib/localDate";
import { habitDateLabel } from "@/components/notes/HabitHistoryDialog";
import styles from "./dailyWork.module.css";

/** The year is a compact index. Activation opens correction; it never writes. */
export default function HabitYear({year,today,dates,onOpen}:{year:number;today:string;dates:readonly string[];onOpen(date:string):void}) {
  const first=`${year.toString().padStart(4,"0")}-01-01`;
  const last=`${year.toString().padStart(4,"0")}-12-31`;
  const days=Array.from({length:366},(_,index)=>shiftLocalDate(first,index)).filter(day=>day>=first && day<=last);
  const offset=(new Date(`${first}T12:00:00Z`).getUTCDay()+6)%7;
  const checks=new Set(dates);
  const initial=today>=first && today<=last?today:first<=today?first:days.find(day=>checks.has(day)) ?? first;
  const [selected,setSelected]=useState(initial);
  const selectedDay=selected>=first && selected<=last && (selected<=today || checks.has(selected))?selected:initial;
  const root=useRef<HTMLDivElement>(null);
  const move=useRef<string|null>(null);
  useEffect(()=>{
    if (selected !== selectedDay) setSelected(selectedDay);
    if (move.current===null) return;
    root.current?.querySelector<HTMLButtonElement>(`[data-date="${move.current}"]`)?.focus();
    move.current=null;
  },[selected,selectedDay]);
  return <div className={styles.yearScroll}><div ref={root} className={styles.year} role="group" aria-label={`recorded habit dates, ${year}`}>
    {Array.from({length:offset},(_,index)=><span key={`blank:${index}`} />)}
    {days.map(day=><button key={day} type="button" className={styles.yearDay} data-date={day} data-checked={checks.has(day)} title={`${habitDateLabel(day)}, ${checks.has(day)?"recorded done":"no record"}`}
      aria-label={`${habitDateLabel(day)}, ${checks.has(day)?"recorded done":"no record"}`} tabIndex={day===selectedDay?0:-1}
      disabled={day>today && !checks.has(day)} onFocus={()=>setSelected(day)} onClick={()=>onOpen(day)} onKeyDown={event=>{
        const delta=event.key==="ArrowUp"?-1:event.key==="ArrowDown"?1:event.key==="ArrowLeft"?-7:event.key==="ArrowRight"?7:0;
        if (!delta) return;
        event.preventDefault();
        const next=shiftLocalDate(day,delta);
        if(next<first || next>last || next>today && !checks.has(next)) return;
        move.current=next;setSelected(next);
      }} />)}
  </div></div>;
}
