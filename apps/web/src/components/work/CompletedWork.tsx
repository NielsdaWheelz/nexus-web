"use client";

import { useContext, useLayoutEffect, useRef, useState } from "react";
import { WorkUnavailableError, type QueryResult } from "@nexus/authored/types";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import { formatDay } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredIndex } from "@/lib/notes/hooks";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkHistoryContext, workCommand } from "@/lib/notes/work";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./dailyWork.module.css";

const completed = (result: QueryResult) => result.work_index;

/** A day's completed work as one run-in line. Nothing is drawn until the read has settled with rows. */
export default function CompletedWork({date}:{date:string}) {
  const read = useAuthoredIndex({kind:"work_completed",local_date:date,start:0,limit:2048,expected_revision:null}, completed);
  const history = useContext(WorkHistoryContext);
  if (!history || (read.data?.items.length ?? 0) === 0 && read.error === null) return null;
  return <CompletedLine date={date} read={read} history={history} />;
}

// Mounted with its section, so focus recovery observes the section that exists.
function CompletedLine({date,read,history}:{date:string; read:ReturnType<typeof useAuthoredIndex<import("@nexus/authored/types").WorkIndexItem>>; history:OutlineHistory}) {
  const today = useAccountToday();
  const root = useRef<HTMLElement>(null);
  // The day's article takes focus when a focused name or `clear` leaves, here or by a clear from elsewhere. It is
  // held from layout, because a line emptied from elsewhere unmounts before recovery asks for it.
  const article = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {article.current = root.current?.closest("article") ?? null;});
  useActionFocusRecovery(root,()=>article.current?.isConnected ? article.current : null);
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  if (failure) throw failure.error;
  const rows = read.data?.items ?? [];
  const day = formatDay(date, today);
  return <section ref={root} className={styles.completed} aria-label={`completed on ${day}`}>
    <AuthoredReadFailure {...read} noun="completed work" />
    {rows.length === 0 ? null : <div>
      <span className={styles.completedLabel}>completed</span>
      <ul className={styles.completedList}>
        {rows.map((resource, index) => {
          const name = resource.label === null ? "name too large to display" : resource.label || "empty note";
          return <li key={resource.ref} className={styles.completedItem}>
            {index === 0 ? null : <span aria-hidden="true" className={styles.dot}> · </span>}
            <a href={`/notes/${resource.ref.slice(11)}`}>{name}</a>
            <Button className={styles.clear} aria-label={`clear completion on ${day}: ${name}`} onClick={event => {
              if (document.activeElement === event.currentTarget) event.currentTarget.closest("article")?.focus({preventScroll:true});
              void workCommand(history,{kind:"clear_work_day",ref:resource.ref,local_date:date}).catch(error=>{
                if (!(error instanceof WorkUnavailableError)) setFailure({error});
              });
            }}>clear</Button>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
}
