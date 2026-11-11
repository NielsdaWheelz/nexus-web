"use client";

import { useContext, useRef, useState } from "react";
import { WorkUnavailableError } from "@nexus/authored/types";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import { useAuthoredPages } from "@/lib/notes/hooks";
import { WorkHistoryContext, workCommand } from "@/lib/notes/work";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./dailyWork.module.css";

export default function CompletedWork({date}:{date:string}) {
  const read = useAuthoredPages({kind:"work_completed",local_date:date,cursor:null,limit:100});
  const history = useContext(WorkHistoryContext);
  const root = useRef<HTMLElement>(null);
  useActionFocusRecovery(root,()=>root.current?.closest("article") ?? null);
  const [failure,setFailure] = useState<{error:unknown}|null>(null);
  if (failure) throw failure.error;
  if (!history) return null;
  return <section ref={root} className={styles.completed} aria-label={`completed on ${date}`}>
    <h3>completed</h3>
    <AuthoredReadFailure {...read} noun="completed work" />
    <ResourceList ariaLabel={`completed on ${date}`} busy={read.pending && read.data === null}>
      {(read.data?.rows ?? []).map(({resource}) => <ResourceRow key={resource.ref}
        primary={{kind:"link",href:`/notes/${resource.ref.slice(11)}`}}
        title={resource.body_text || "empty note"} content={{kind:"Index",metadata:null}}
        controls={<Button aria-label={`clear completion on ${date}: ${resource.body_text || "empty note"}`} onClick={event => {
          if (document.activeElement === event.currentTarget) event.currentTarget.closest("article")?.focus({preventScroll:true});
          void workCommand(history,{kind:"clear_work_day",ref:resource.ref,local_date:date}).catch(error=>{
            if (!(error instanceof WorkUnavailableError)) setFailure({error});
          });
        }}>clear</Button>} />)}
    </ResourceList>
    {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={read.more} aria-busy={read.pending}>show more completed</Button> : null}
  </section>;
}
