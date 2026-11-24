"use client";

import { useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { WorkUnavailableError } from "@nexus/authored/types";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import {useVariableIndex} from "@/lib/collections/variableIndex";
import { formatDay } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkHistoryContext, workCommand } from "@/lib/notes/work";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import {PaneRefreshAnchor} from "@/lib/workspace/paneReturnMemento";
import {useWorkRegister} from "./workRegister";
import styles from "./dailyWork.module.css";

/** Ordinary batches remain a run-in line. Large days have seekable ranks in the journal's port. */
export default function CompletedWork({date}:{date:string}) {
  const work = useWorkRegister("work_completed", date);
  const history = useContext(WorkHistoryContext);
  if (!history || work.count === 0 && work.read.error === null) return null;
  return <CompletedLine date={date} work={work} history={history} />;
}

function CompletedLine({date,work,history}:{date:string; work:ReturnType<typeof useWorkRegister>; history:OutlineHistory}) {
  const today = useAccountToday();
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Capture the article while the line exists; clearing its last completion unmounts it.
  const article = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {article.current = root.current?.closest("article") ?? null;});
  useActionFocusRecovery(root,()=>article.current?.isConnected ? article.current : null);
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  const [focused,setFocused] = useState<string | null>(null);
  const pins = useMemo(() => new Set(focused === null ? [] : [focused]), [focused]);
  const ids = useMemo(() => [...work.rows.keys()], [work.rows]);
  const scope = `completed:${date}`;
  const index = useVariableIndex({scope, list, ids, ranked: work.sparse ? work.ranked : undefined, windowed: work.sparse,
    estimate: 32, pinned: pins});
  if (failure) throw failure.error;
  const day = formatDay(date, today);
  const read = work.read.error !== null ? work.read : {error:work.error, retry:work.retry};
  return <PaneRefreshAnchor identity={scope} value={work.read.data} ready={work.revision !== null}>
    <section ref={root} className={styles.completed} aria-label={`completed on ${day}`} data-pane-return-scope={scope}>
      <AuthoredReadFailure {...read} noun="completed work" />
      {work.count === 0 ? null : <div>
        <span className={styles.completedLabel}>completed</span>
        <ul ref={list} className={work.sparse ? styles.completedWindow : styles.completedList} aria-label={`completed work on ${day}`}
          style={work.sparse ? {height:index.height} : undefined}
          onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);}}>
          {index.slots.map(({id, rank, top, size}) => {
            const resource = work.rows.get(id);
            if (resource === undefined) return null;
            const name = resource.label === null ? "name too large to display" : resource.label || "empty note";
            const style = top === undefined ? undefined : {position:"absolute", insetInline:0, top, blockSize:size,
              overflow:size === undefined ? undefined : "clip"} as CSSProperties;
            return <li key={id} ref={index.measure} data-index={rank} data-collection-row-id={id}
              aria-posinset={index.windowed ? rank+1 : undefined} aria-setsize={index.windowed ? index.count : undefined}
              onFocus={() => setFocused(id)} style={style} className={styles.completedItem}>
              {index.windowed || rank === 0 ? null : <span aria-hidden="true" className={styles.dot}> · </span>}
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
    </section>
  </PaneRefreshAnchor>;
}
