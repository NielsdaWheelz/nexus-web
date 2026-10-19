"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnectionAttachments } from "@/components/connections/useConnectionAttachments";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "@/components/resources/ResourceOutline.module.css";

const VISIT = definePaneVisitDataKey<Visit<Schema<"ContextOut">>>("Chat.Context");

/** Future prompt membership is a dedicated read; disclosure remains graph exploration. */
export default function ChatContext({ conversationId, refreshKey }: { conversationId: string; refreshKey: number }) {
  const selfRef = `conversation:${conversationId}`;
  const attachments = useConnectionAttachments(selfRef);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(changed), [changed]);
  const links = useLinkComposerHost();
  const metadata = useChangeStamp("Notes", "Metadata");
  const context = useServerValue<Schema<"ContextOut">>({
    key: conversationId, stale: `${refreshKey}:${revision}:${metadata}`, visit: VISIT,
    load: async (signal) => (await apiFetch<ApiJson<"/conversations/{conversation_id}/context", "get">>(`/api/conversations/${conversationId}/context`, { signal })).data,
  });
  const failure = context.status === "failed" ? context.error : context.status === "ready" ? context.error : null;
  return <section aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ResourceActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} label="Context actions" />{attachments.control}</div>
    {attachments.attaching ? <FeedbackStatus content={{ tone: "Neutral", title: "uploading and linking…" }} announcement="Polite" /> : null}
    <p className={styles.metadata}>available to future replies; expanding a branch does not add context</p>
    {context.status === "loading" ? <FeedbackStatus content={{ tone: "Neutral", title: "loading context…" }} announcement="Polite" /> : null}
    {failure ? <FeedbackNotice content={{ tone: "Warning", title: "context couldn’t be loaded", requestId: failure.requestId }} announcement="Assertive" actions={[{ label: "retry", onClick: context.refetch, busy: context.status === "failed" ? context.retrying : context.status === "ready" && context.refreshing }]} /> : null}
    {context.status === "ready" ? <ResourceOutlineList scope={`chat-context:${conversationId}`} ariaLabel="Chat context" ancestorRef={`conversation:${conversationId}`}>
      {context.data.items.map(({ item, mutation, admission_edge_ids }) => <ResourceOutlineRow key={item.ref} item={item} occurrenceKey={`${conversationId}/${item.ref}`} representedEdgeIds={admission_edge_ids} contextMutation={mutation} onChanged={context.refetch} />)}
      {context.data.items.length === 0 ? <li><FeedbackStatus content={{ tone: "Neutral", title: "no context yet" }} announcement="None" actions={[{ label: "link an item", onClick: () => void links.openResourceLink(`conversation:${conversationId}`) }]} /></li> : null}
    </ResourceOutlineList> : null}
  </section>;
}
