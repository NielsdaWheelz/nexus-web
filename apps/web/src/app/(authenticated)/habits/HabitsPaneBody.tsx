"use client";

import { useMemo } from "react";
import CollectionView from "@/components/collections/CollectionView";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import ResourceRow from "@/components/ui/ResourceRow";
import Button from "@/components/ui/Button";
import HabitYear from "@/components/work/HabitYear";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredPages } from "@/lib/notes/hooks";
import { useWorkHistory, useOpenHabitHistory, WorkHistoryContext } from "@/lib/notes/work";
import type { CollectionRowView } from "@/lib/collections/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "@/components/work/dailyWork.module.css";

export default function HabitsPaneBody() {
  const today=useAccountToday();
  const currentYear=Number(today.slice(0,4));
  const codec=useMemo(()=>({basePath:"/habits",decode:(params:URLSearchParams)=>{
    const value=params.get("year");
    return value!==null && /^\d{4}$/u.test(value) && Number(value)>=1 && Number(value)<=9999?Number(value):currentYear;
  },encode:(value:number,params:URLSearchParams)=>{params.set("year",String(value).padStart(4,"0"));return params;}}),[currentYear]);
  const {state:year,setState:setYear}=usePaneUrlState(codec);
  const read=useAuthoredPages({kind:"habits",cursor:null,limit:100});
  const {history,error}=useWorkHistory();
  const open=useOpenHabitHistory();
  usePaneReturnReady(read.data!==null || read.error!==null);
  usePaneChrome({displayTitle:"habits",navigation:{label:"habit years",content:<div className={styles.controls}>
    <Button aria-label="previous year" disabled={year<=1} onClick={()=>setYear(year-1)}>previous year</Button>
    <span>{year}</span>
    <Button aria-label="next year" disabled={year>=Math.max(currentYear,...(read.data?.rows.flatMap(row=>row.resource.work?.habit_dates.map(date=>Number(date.slice(0,4))) ?? []) ?? []))} onClick={()=>setYear(year+1)}>next year</Button>
    <Button onClick={()=>setYear(currentYear)}>today</Button>
  </div>}});
  const rows=useMemo<CollectionRowView[]>(()=> (read.data?.rows ?? []).map(({resource})=>({
    id:resource.ref,kind:"note",presentation:"Details",title:{text:resource.body_text||"empty note"},
    primary:{kind:"link",href:`/notes/${resource.ref.slice(11)}`},resourceRef:canonicalResourceRef({scheme:"note_block",id:resource.ref.slice(11)}),
    contributors:[],publicationDate:null,context:null,activity:null,exceptionalStatus:null,selected:false,
  })),[read.data]);
  if(error)throw error;
  return <WorkHistoryContext.Provider value={history}>
    <CollectionView returnScope="Habits" rows={rows} ariaLabel="habits" status={read.data!==null?"ready":read.error!==null?"error":"loading"}
      error={<AuthoredReadFailure {...read} noun="habits" />} notice={read.data!==null && read.error!==null?<AuthoredReadFailure {...read} noun="habits" />:undefined}
      empty={<p>no daily habits yet. choose repeat daily on a note.</p>}
      footer={read.data?.next_cursor!==null && read.data!==null?<Button onClick={read.more} aria-busy={read.pending}>show more habits</Button>:undefined}
      renderRow={({row,as})=>{
        const resource=read.data!.rows.find(item=>item.resource.ref===row.id)!.resource;
        const work=resource.work;
        if(!work)throw new Error("habit query lacks work state");
        const start=year===currentYear?today:year<currentYear?`${String(year).padStart(4,"0")}-01-01`:work.habit_dates.find(date=>Number(date.slice(0,4))===year) ?? today;
        return <ResourceRow key={row.id} as={as} primary={row.primary} title={row.title.text} rootProps={{"data-collection-row-id":row.id}}
          content={{kind:"Details",body:<>
            {!work.designation.enabled || work.designation.kind!=="habit"?<p className={styles.muted}>daily repetition is off</p>:null}
            <HabitYear year={year} today={today} dates={work.habit_dates} onOpen={date=>{if(history)open(resource.ref,date,history);}} />
            <Button data-habit-history="true" disabled={!history} onClick={()=>{if(history)open(resource.ref,start,history);}}>habit history</Button>
          </>}} />;
      }} />
  </WorkHistoryContext.Provider>;
}
