"use client";

// Server-owned facts about one resource: citations, librarian links, chat context
// and document embeds. Authored links, highlight notes and note-body embeds are
// local and never read here. This section fails on its own; it never hides or
// replaces local results beside it. A first read that fails stands where its rows
// would; a refresh that fails over a list already shown, even an empty one, says
// nothing; a later page that fails stands beneath the rows.
import { useContext } from "react";
import { Failed } from "@/components/feedback/Fact";
import ResourceOutlineList, { ResourceBranch } from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { usePaneFreeServerList, type ServerList } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { queryConnections, type ConnectionOut } from "@/lib/resourceGraph/links";
import styles from "./ConnectionsSurface.module.css";

const REMOTE_ORIGINS: NonNullable<NonNullable<Parameters<typeof queryConnections>[0]["filters"]>["origins"]> =
  ["citation", "discovery", "assistant", "system", "document_embed"];

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
  // The fact this branch entered through comes back from a both-directions read; it is not another connection.
  const items = list.items.filter((connection) => !branch.traversedEdgeIds.has(connection.edge_id));
  const failure = list.failure;
  const retry = { run: list.retry, busy: list.running !== null };
  return <>
    {failure !== null && list.status === "failed" ? <Failed error={failure.error} noun="other connections" retry={retry} /> : null}
    {items.length ? <section aria-label="other connections">
      <h3 className={styles.subtitle}>other connections</h3>
      <ResourceOutlineList scope={`remote:${occurrencePrefix}`} ariaLabel="other connections" ancestorRef={ownerRef}>
        {items.map((connection) => <ResourceOutlineRow key={connection.edge_id} item={connection.other}
          occurrenceKey={`${occurrencePrefix}/${connection.edge_id}`} connection={connection}
          incoming={{ kind: "edge", edge_id: connection.edge_id, origin: connection.origin, mutation: connection.mutation, creation: connection.creation }}
          historical={connection.origin === "citation" && connection.ordinal !== null} onChanged={onChanged} />)}
      </ResourceOutlineList>
    </section> : null}
    {failure?.op === "More" ? <Failed error={failure.error} noun="the remaining connections" retry={retry} /> : null}
  </>;
}
