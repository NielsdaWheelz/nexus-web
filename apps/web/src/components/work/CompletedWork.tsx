"use client";

import { useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { WorkUnavailableError, type WorkIndexItem } from "@nexus/authored/types";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import {useVariableIndex} from "@/lib/collections/variableIndex";
import { formatDay } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { useWorkLabel } from "@/lib/notes/hooks";
import type { OutlineHistory } from "@/lib/notes/structure";
import { WorkHistoryContext, workCommand } from "@/lib/notes/work";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import {PaneRefreshAnchor, usePaneIndexRevision} from "@/lib/workspace/paneReturnMemento";
import {useWorkRegister} from "./workRegister";
import styles from "./dailyWork.module.css";

/** Ordinary batches remain a run-in line. Large days have seekable ranks in the journal's port. */
export default function CompletedWork({date}:{date:string}) {
  const work = useWorkRegister("work_completed", date);
  const history = useContext(WorkHistoryContext);
  const presentation = work.presentation;
  usePaneIndexRevision(`completed:${date}`, presentation?.revision ?? null, presentation !== null);
  if (!history || (presentation?.count ?? 0) === 0 && work.read.error === null && work.error === null) return null;
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
  const ranked = work.presentation?.ranked;
  const index = useVariableIndex({scope, list, ids, ranked, windowed: ranked !== undefined,
    estimate: 32, pinned: pins});
  const layout = useMemo(() => ({read: work.read.data, windowed: index.windowed}), [work.read.data, index.windowed]);
  if (failure) throw failure.error;
  const day = formatDay(date, today);
  const read = work.read.error !== null ? work.read : {error:work.error, retry:work.retry};
  return <PaneRefreshAnchor identity={scope} value={layout} ready={work.revision !== null}>
    <section ref={root} className={styles.completed} aria-label={`completed on ${day}`} data-pane-return-scope={scope}>
      <AuthoredReadFailure {...read} noun="completed work" />
      {(work.presentation?.count ?? 0) === 0 ? null : <div>
        <span className={styles.completedLabel}>completed</span>
        <ul ref={list} className={index.windowed ? styles.completedWindow : styles.completedList} aria-label={`completed work on ${day}`}
          style={index.windowed ? {height:index.height} : undefined}
          onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);}}>
          {index.slots.map(({id, rank, top, size}) => {
            const resource = work.rows.get(id);
            if (resource === undefined) return null;
            const style = top === undefined ? undefined : {position:"absolute", insetInline:0, top, blockSize:size,
              overflow:size === undefined ? undefined : "clip"} as CSSProperties;
            return <li key={id} ref={index.measure} data-index={rank} data-collection-row-id={id}
              aria-posinset={index.windowed ? rank+1 : undefined} aria-setsize={index.windowed ? index.count : undefined}
              onFocus={() => setFocused(id)} style={style} className={styles.completedItem}>
              {index.windowed || rank === 0 ? null : <span aria-hidden="true" className={styles.dot}> · </span>}
              <CompletedName resource={resource} date={date} day={day} history={history} fail={error => setFailure({error})} />
            </li>;
          })}
        </ul>
      </div>}
    </section>
  </PaneRefreshAnchor>;
}

function CompletedName({resource,date,day,history,fail}: {
  resource: WorkIndexItem; date: string; day: string; history: OutlineHistory; fail(error: unknown): void;
}) {
  const {label, read} = useWorkLabel(resource);
  return <>
    <a href={`/notes/${resource.ref.slice(11)}`}>{label}</a>
    <AuthoredReadFailure {...read} noun="this task name" />
    <Button className={styles.clear} aria-label={`clear completion on ${day}: ${label}`} onClick={event => {
      if (document.activeElement === event.currentTarget) event.currentTarget.closest("article")?.focus({preventScroll:true});
      void workCommand(history,{kind:"clear_work_day",ref:resource.ref,local_date:date}).catch(error=>{
        if (!(error instanceof WorkUnavailableError)) fail(error);
      });
    }}>clear</Button>
  </>;
}
