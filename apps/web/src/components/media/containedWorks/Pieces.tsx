"use client";

// Compose ordinary resource rows and the existing contents tree. Catalogue
// pagination, transient previews and authored commands have separate owners.
import { useCallback, useState } from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import { Contents } from "@/lib/documentReader/chrome/Contents";
import type { Reader } from "@/lib/documentReader/DocumentReader";
import { usePagePrefix } from "@/lib/api/pagePrefix";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useChangeStamp } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { isRefusal } from "@/lib/api/client";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { partPage, partNavigation, partDefinition, prepareParts, discoverParts, decidePart } from "@/lib/media/parts";
import PartEditor, { partError } from "./PartEditor";
import styles from "./parts.module.css";

type Command = { kind: "prepare"; body: Schema<"PartPrepare"> } |
  { kind: "discover"; body: Schema<"PartDiscovery"> } |
  { kind: "decide"; candidate: string; body: Schema<"PartCandidateDecision"> };
const reason = (choice: Schema<"PartSectionChoice">) => choice.reason === "unknown_end"
  ? "this section’s end hasn’t been identified" : choice.reason === "unproved_structure"
    ? "this section can’t yet be read separately without losing content" : "prepare sections to read this separately";

export function SourcePieces({ source, reader }: { readonly source: string; readonly reader: Reader }) {
  const stale = useChangeStamp("Metadata", "Entries");
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => partPage(source, cursor, signal), [source]);
  const { prefix, short, loadMore } = usePagePrefix(`/media/${source}/parts`, stale, fetchPage);
  const [editing, setEditing] = useState<string | null>(null);
  const commands = useResourceDraft<{ request: Command | null; busy: boolean; error: string | null }>(`piece-commands:${source}`,
    () => ({ request: null, busy: false, error: null }), value => ({ changed: false, unconfirmed: value.request !== null, stopsBrowserWork: false }));
  const pages = prefix.status === "ready" ? prefix.data.pages : null;
  const page = pages?.[0] ?? null;
  const navigation = usePaneFreeServerValue({ key: page?.capabilities.create.allowed ? `/media/${source}/navigation` : null, stale, load: signal => partNavigation(source, signal) });
  const rows = pages?.flatMap(page => page.rows) ?? [];
  const active = page?.operation?.status === "pending" || page?.operation?.status === "running" || page?.preparation?.status === "Queued" || page?.preparation?.status === "Processing";
  const refresh = useCallback(() => { prefix.refetch(); navigation.refetch(); }, [navigation, prefix]);
  useIntervalPoll({ enabled: active, onPoll: refresh, pollIntervalMs: 1500 });
  const run = async (command: Command) => {
    if (commands.read().busy) return;
    const request = commands.read().request ?? command;
    commands.set({ request, busy: true, error: null });
    try {
      switch (request.kind) {
        case "prepare": await prepareParts(source, request.body); break;
        case "discover": await discoverParts(source, request.body); break;
        case "decide": await decidePart(source, request.candidate, request.body); break;
      }
      commands.set({ request: null, busy: false, error: null });
      refresh();
    } catch (error) {
      commands.set({ request: isRefusal(error) ? null : request, busy: false, error: partError(error) });
      refresh();
    }
  };
  const choices = page?.section_choices ?? [];
  return <section className={styles.panel} aria-label="pieces">
    <h3>pieces</h3>
    {prefix.status === "failed" ? <><p role="alert">couldn’t find pieces</p><Button onClick={prefix.refetch}>try again</Button></> : null}
    {prefix.status === "loading" ? <p role="status">loading pieces…</p> : null}
    {page ? <>
      <div className={styles.actions}>
        {page.capabilities.discover.allowed && page.source_generation !== null ? <Button disabled={commands.value.busy} onClick={() => void run({ kind: "discover", body: {
          id: crypto.randomUUID(), expected_source_generation: page.source_generation!, expected_latest_job_id: page.operation?.job_id ?? null,
        } })}>{page.operation?.status === "failed" || page.operation?.status === "dead" ? "try again" : "find pieces"}</Button> : null}
        {page.capabilities.create.reason === "preparing_structure" && page.source_generation !== null ? <Button disabled={commands.value.busy} onClick={() => void run({ kind: "prepare", body: { id: crypto.randomUUID(), expected_source_generation: page.source_generation! } })}>prepare sections</Button> : null}
        {page.capabilities.create.allowed ? <Button onClick={() => { const first = choices.find(choice => choice.eligible); if (first) setEditing(first.section_id); }}>combine sections…</Button> : null}
      </div>
      {active ? <p role="status">{page.operation ? `finding pieces… ${page.operation.completed_sections} of ${page.operation.total_sections} sections` : "preparing sections…"}</p> : null}
      {page.operation?.status === "failed" || page.operation?.status === "dead" ? <p role="alert">couldn’t find pieces</p> : null}
      {page.operation?.outcome === "superseded" ? <p role="status">source details changed while finding pieces; run again</p> : null}
      {rows.length === 0 && !active && page.operation?.outcome !== "superseded" && page.operation?.status !== "failed" && page.operation?.status !== "dead" ? <p>no separate pieces found. you can still choose a section.</p> : null}
      {rows.some(row => row.kind === "part") ? <p>pieces refer to this saved text, so it can’t be replaced</p> : null}
      {rows.map(row => row.kind === "part" ? <ResourceIndexRow presentation={{ kind: "Index" }} key={row.item.ref} item={row.item} occurrenceKey={`piece:${row.item.ref}`} />
        : row.finding !== null || row.user_decision === "rejected" ? <article key={row.id}>
          <h4>{row.bound_title ?? row.finding?.title ?? "untitled piece"}</h4>
          {row.finding?.uncertainty_reason ? <p>{row.finding.uncertainty_reason}</p> : null}
          {row.finding?.evidence.map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}
          <div className={styles.actions}>
            <Button disabled={commands.value.busy} onClick={() => void run({ kind: "decide", candidate: row.id, body: { expected_version: row.version, decision: "accepted", part_id: row.part_id ?? crypto.randomUUID() } })}>{row.part_id === null ? "read separately" : "restore piece"}</Button>
            {row.part_id === null && row.user_decision !== "rejected" ? <Button disabled={commands.value.busy} onClick={() => void run({ kind: "decide", candidate: row.id, body: { expected_version: row.version, decision: "rejected", part_id: null } })}>reject</Button> : null}
          </div>
        </article> : null)}
      {prefix.status === "ready" && prefix.data.more ? <Button disabled={short} onClick={loadMore}>more pieces</Button> : null}
    </> : null}
    {commands.value.error ? <p role="alert">{commands.value.error}</p> : null}
    {commands.value.request !== null && !commands.value.busy ? <Button onClick={() => void run(commands.value.request!)}>try same request again</Button> : null}
    <Contents reader={reader} actions={section => {
      const choice = choices.find(choice => choice.section_id === section);
      return choice && page?.capabilities.create.allowed ? <span>
        <Button disabled={!choice.eligible} onClick={() => setEditing(section)}>read separately</Button>
        {!choice.eligible ? <span>{reason(choice)}</span> : null}
      </span> : null;
    }} />
    {editing !== null && page !== null && navigation.status === "ready" ? <PartEditor key={editing} source={source} initialSection={editing} navigation={navigation.data} page={page} definition={null} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
  </section>;
}

export function PieceDetails({ id, sourceHref }: { readonly id: string; readonly sourceHref: string | null }) {
  const stale = useChangeStamp("Metadata");
  const detail = usePaneFreeServerValue({ key: `/media/${id}/part`, stale, load: signal => partDefinition(id, signal) });
  const definition = detail.status === "ready" ? detail.data : null;
  const source = definition?.source_media_id ?? null;
  const navigation = usePaneFreeServerValue({ key: definition?.capabilities.edit_bounds.allowed && source !== null ? `/media/${source}/navigation` : null, stale,
    load: signal => partNavigation(source!, signal) });
  const catalogue = usePaneFreeServerValue({ key: definition?.capabilities.edit_bounds.allowed && source !== null ? `/media/${source}/parts` : null, stale,
    load: signal => partPage(source!, null, signal) });
  const [editing, setEditing] = useState(false);
  return definition ? <section className={styles.panel} aria-label="piece details">
    <p>from {definition.source_title}</p>
    {sourceHref !== null ? <ButtonLink href={sourceHref}>{definition.source_format === "epub" ? "open in book" : "open in article"}</ButtonLink> : null}
    {definition.capabilities.edit_metadata.allowed ? <Button onClick={() => setEditing(true)}>edit piece</Button> : null}
    {editing ? <PartEditor source={definition.source_media_id} initialSection={definition.selection?.section_ids[0] ?? ""}
      navigation={navigation.status === "ready" ? navigation.data : null} page={catalogue.status === "ready" ? catalogue.data : null}
      definition={definition} onClose={() => setEditing(false)} onSaved={detail.refetch} /> : null}
  </section> : null;
}
