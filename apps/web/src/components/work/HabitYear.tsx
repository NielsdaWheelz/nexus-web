"use client";

import { useEffect, useRef, useState } from "react";
import { habitDateLabel, shiftLocalDate } from "@/lib/localDate";
import styles from "./HabitYear.module.css";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The year is a compact index of dots in Monday-first weeks, placed explicitly: row 1 holds the
 * months and column 1 the weekdays, both unspoken. Activation opens correction; it never writes. */
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
  return <div className={styles.scroll}><div ref={root} className={styles.year} role="group" aria-label={`recorded habit dates, ${year}`}>
    {days.flatMap((day,index)=>day.endsWith("-01")
      ? [<span key={`month:${day}`} className={styles.month} aria-hidden="true" style={{gridColumn:Math.floor((offset+index)/7)+2}}>{MONTHS[Number(day.slice(5,7))-1]}</span>] : [])}
    {(["mon","wed","fri"] as const).map((name,index)=><span key={name} className={styles.weekday} aria-hidden="true" style={{gridRow:index*2+2}}>{name}</span>)}
    {days.map((day,index)=><button key={day} type="button" className={styles.day} style={{gridColumn:Math.floor((offset+index)/7)+2,gridRow:(offset+index)%7+2}}
      data-date={day} data-checked={checks.has(day)} data-today={day===today || undefined} aria-current={day===today ? "date" : undefined} title={`${habitDateLabel(day)}, ${checks.has(day)?"recorded done":"no record"}`}
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

/** The year's key, drawn with the year's own dots. The words are read; the sample shapes are not. */
export function HabitYearLegend() {
  return <ul className={styles.legend}>
    <li><span className={styles.day} data-checked="true" aria-hidden="true" />recorded</li>
    <li><span className={styles.day} aria-hidden="true" />no record</li>
    <li><span className={styles.day} data-today="true" aria-hidden="true" />today</li>
  </ul>;
}
