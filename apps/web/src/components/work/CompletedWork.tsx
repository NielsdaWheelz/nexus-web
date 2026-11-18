"use client";

import { useContext, useRef, useState } from "react";
import { WorkUnavailableError } from "@nexus/authored/types";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import { formatDay } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useAuthoredPages } from "@/lib/notes/hooks";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkHistoryContext, workCommand } from "@/lib/notes/work";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./dailyWork.module.css";

/** A day's completed work as one run-in line. Nothing is drawn until the read has settled with rows. */
export default function CompletedWork({date}:{date:string}) {
  const read = useAuthoredPages({kind:"work_completed",local_date:date,cursor:null,limit:100});
  const history = useContext(WorkHistoryContext);
  if (!history || (read.data?.rows.length ?? 0) === 0 && read.error === null) return null;
  return <CompletedLine date={date} read={read} history={history} />;
}

// Mounted with its section, so focus recovery observes the section that exists.
function CompletedLine({date,read,history}:{date:string; read:ReturnType<typeof useAuthoredPages>; history:OutlineHistory}) {
  const today = useAccountToday();
  const root = useRef<HTMLElement>(null);
  useActionFocusRecovery(root,()=>root.current?.closest("article") ?? null);
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  if (failure) throw failure.error;
  const rows = read.data?.rows ?? [];
  const day = formatDay(date, today);
  return <section ref={root} className={styles.completed} aria-label={`completed on ${day}`}>
    <AuthoredReadFailure {...read} noun="completed work" />
    {rows.length === 0 ? null : <div>
      <span className={styles.completedLabel}>completed</span>
      <ul className={styles.completedList}>
        {rows.map(({resource}, index) => {
          const name = resource.body_text || "empty note";
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
    {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={read.more} aria-busy={read.pending}>show more completed</Button> : null}
  </section>;
}
