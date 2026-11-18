"use client";

import { useMemo, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import AccountCalendarUnavailable from "@/components/notes/AccountCalendarUnavailable";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import ResourceRow from "@/components/ui/ResourceRow";
import Button from "@/components/ui/Button";
import HabitYear, { HabitYearLegend } from "@/components/work/HabitYear";
import { habitDateLabel } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredPages } from "@/lib/notes/hooks";
import { useWorkHistory, useOpenHabitHistory, WorkHistoryContext } from "@/lib/notes/work";
import type { CollectionRowView } from "@/lib/collections/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneChrome, usePaneTitleYield } from "@/lib/panes/paneChrome";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./habits.module.css";

export default function HabitsPaneBody() {
  const today=useAccountToday();
  const currentYear=today === null ? null : Number(today.slice(0,4));
  const codec=useMemo(()=>({basePath:"/habits",decode:(params:URLSearchParams)=>{
    const value=params.get("year");
    return value!==null && /^\d{4}$/u.test(value) && Number(value)>=1 && Number(value)<=9999?Number(value):currentYear;
  },encode:(value:number|null,params:URLSearchParams)=>{if (value === null) params.delete("year"); else params.set("year",String(value).padStart(4,"0"));return params;}}),[currentYear]);
  const {state:year,setState:setYear}=usePaneUrlState(codec);
  const read=useAuthoredPages({kind:"habits",cursor:null,limit:100});
  const {history,error}=useWorkHistory();
  const open=useOpenHabitHistory();
  usePaneReturnReady(read.data!==null || read.error!==null);
  const type=readerType(useReaderProfile());
  const title=useRef<HTMLParagraphElement>(null);
  usePaneTitleYield(title);
  usePaneChrome({displayTitle:"habits"});
  const rows=useMemo<CollectionRowView[]>(()=> (read.data?.rows ?? []).map(({resource})=>({
    id:resource.ref,kind:"note",presentation:"Details",title:{text:resource.body_text||"empty note"},
    primary:{kind:"link",href:`/notes/${resource.ref.slice(11)}`},resourceRef:canonicalResourceRef({scheme:"note_block",id:resource.ref.slice(11)}),
    contributors:[],publicationDate:null,context:null,selected:false,
  })),[read.data]);
  if(error)throw error;
  return <WorkHistoryContext.Provider value={history}><div {...type}>
    <div className={styles.head}>
      <p ref={title} className={styles.title}>{year === null ? "Habits" : `Habits, ${year}`}</p>
      {year === null ? null : <div role="group" aria-label="habit years" className={styles.step}>
        <Button aria-label={`previous year, ${year-1}`} disabled={year<=1} onClick={()=>setYear(year-1)}>{year-1}</Button>
        <Button aria-label={`next year, ${year+1}`} disabled={year>=Math.max(year,...(currentYear === null ? [] : [currentYear]),...(read.data?.rows.flatMap(row=>row.resource.work?.habit_dates.map(date=>Number(date.slice(0,4))) ?? []) ?? []))} onClick={()=>setYear(year+1)}>{year+1}</Button>
        <Button disabled={currentYear === null} onClick={()=>setYear(currentYear)}>today</Button>
      </div>}
    </div>
    {today === null ? <AccountCalendarUnavailable /> : null}
    <CollectionView returnScope="Habits" rows={rows} ariaLabel="habits" status={read.data!==null?"ready":read.error!==null?"error":"loading"}
      error={<AuthoredReadFailure {...read} noun="habits" />} notice={read.data!==null && read.error!==null?<AuthoredReadFailure {...read} noun="habits" />:undefined}
      empty={<p>no daily habits yet. choose repeat daily on a note.</p>}
      footer={read.data?.next_cursor!==null && read.data!==null?<Button onClick={read.more} aria-busy={read.pending}>show more habits</Button>:undefined}
      renderRow={({row,as})=>{
        const resource=read.data!.rows.find(item=>item.resource.ref===row.id)!.resource;
        const work=resource.work;
        if(!work)throw new Error("habit query lacks work state");
        const dates = work.habit_dates.filter(date => year === null || Number(date.slice(0,4)) === year);
        const start=today === null ? dates.at(-1) ?? null : year === null || year === currentYear ? today : currentYear !== null && year < currentYear ? `${String(year).padStart(4,"0")}-01-01` : dates[0] ?? today;
        return <ResourceRow key={row.id} as={as} primary={row.primary} title={row.title.text} rootProps={{"data-collection-row-id":row.id}}
          content={{kind:"Details",body:<>
            {!work.designation.enabled || work.designation.kind!=="habit"?<p className={styles.muted}>daily repetition is off</p>:null}
            {today !== null && year !== null ? <HabitYear year={year} today={today} dates={work.habit_dates} onOpen={date=>{if(history)open(resource.ref,date,history);}} />
              : <p>{dates.length ? dates.map(habitDateLabel).join(" · ") : "no recorded dates."}</p>}
            <Button data-habit-history="true" disabled={!history || start === null} onClick={()=>{if(history && start !== null)open(resource.ref,start,history);}}>habit history</Button>
          </>}} />;
      }} />
    <div className={styles.foot}><HabitYearLegend /></div>
  </div></WorkHistoryContext.Provider>;
}
