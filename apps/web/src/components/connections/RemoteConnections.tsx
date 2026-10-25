"use client";

// Server-owned facts about one resource: citations, librarian links, chat context
// and document embeds. Authored links, highlight notes and note-body embeds are
// local and never read here. This section fails on its own; it never hides or
// replaces local results beside it.
import { useContext } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import ResourceOutlineList, { ResourceBranch } from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerList, type ServerList } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { queryConnections, type ConnectionOut } from "@/lib/resourceGraph/links";
import styles from "./ConnectionsSurface.module.css";

const REMOTE_ORIGINS: NonNullable<NonNullable<Parameters<typeof queryConnections>[0]["filters"]>["origins"]> =
  ["citation", "discovery", "assistant", "system", "document_embed"];

export function remoteConnectionsError(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const title = "couldn’t refresh connections";
  const transport = apiTransportFeedback(error, title);
  if (transport !== null) return transport;
  if (!["E_NOT_FOUND", "E_FORBIDDEN", "E_INVALID_REQUEST"].includes(error.code)) throw error;
  return { tone: "Danger", title, message: "This item or connection is no longer available. Refresh Connections.", requestId: error.requestId };
}

/** One read per mounted section: `occurrencePrefix` keeps sections with different invalidation apart. */
export function useRemoteConnections(ownerRef: string, occurrencePrefix: string, stale: string): ServerList<ConnectionOut> {
  const active = usePaneIsActive();
  return usePaneFreeServerList<ConnectionOut>({
    key: `connections:remote:${occurrencePrefix}:${ownerRef}`,
    stale,
    pageSize: 100,
    active,
    id: (connection) => connection.edge_id,
    fetchPage: async (cursor, limit, signal) => {
      const page = await queryConnections({ refs: [ownerRef], direction: "both", rollup: "owner",
        filters: { origins: REMOTE_ORIGINS }, limit: Math.min(limit, 100), cursor }, signal);
      return { items: page.items, next_cursor: page.next_cursor };
    },
  });
}

export default function RemoteConnections({ ownerRef, occurrencePrefix, list, onChanged }: {
  ownerRef: string;
  occurrencePrefix: string;
  list: ServerList<ConnectionOut>;
  onChanged: () => void;
}) {
  const branch = useContext(ResourceBranch);
  const loading = list.running === "Load" || list.running === "Refetch";
  const error = list.failure?.op === "More" ? null : list.failure?.error ?? null;
  // The fact this branch entered through comes back from a both-directions read; it is not another connection.
  const items = list.items.filter((connection) => !branch.traversedEdgeIds.has(connection.edge_id));
  return <>
    {loading && error === null ? <FeedbackStatus content={{ tone: "Neutral", title: list.status === "ready" ? "refreshing connections…" : "loading connections…" }} announcement="None" /> : null}
    {error ? <FeedbackNotice content={remoteConnectionsError(error)} announcement="Polite" actions={[{ label: "retry refresh", onClick: list.retry, busy: list.running !== null }]} /> : null}
    {items.length ? <section aria-label="other connections">
      <h3 className={styles.subtitle}>other connections</h3>
      <ResourceOutlineList scope={`remote:${occurrencePrefix}`} ariaLabel="other connections" ancestorRef={ownerRef}>
        {items.map((connection) => <ResourceOutlineRow key={connection.edge_id} item={connection.other}
          occurrenceKey={`${occurrencePrefix}/${connection.edge_id}`} connection={connection}
          incoming={{ kind: "edge", edge_id: connection.edge_id, origin: connection.origin, mutation: connection.mutation, creation: connection.creation }}
          historical={connection.origin === "citation" && connection.ordinal !== null} onChanged={onChanged} />)}
      </ResourceOutlineList>
    </section> : null}
  </>;
}
