"use client";

// One source snapshot supplies publisher navigation and complete work bindings.
// Dialogs own their drafts; this mounted owner serializes discovery/restoration.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import { Contents, ContentsList } from "@/lib/documentReader/chrome/Contents";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { textSectionLookup, type TocNode, type TextPoint } from "@/lib/documentReader/model";
import { ReaderLink } from "@/lib/documentReader/navigation";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useChangeStamp } from "@/lib/api/changes";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import type { Schema } from "@/lib/api/wire";
import { isApiError, isRefusal, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { sourceContents, partDefinition, discoverParts, decidePart } from "@/lib/media/parts";
import PartEditor, { partBlockMessage, partError } from "./PartEditor";
import CandidateReview from "./CandidateReview";
import styles from "./parts.module.css";

type Work = Schema<"SourceContentsOut">["works"][number];
type Intent = { kind: "manual"; section: string | null; title: string; selection: Schema<"SectionSelection"> | null; node: string | null }
  | { kind: "review"; candidate: string; node: string | null }
  | { kind: "unavailable"; message: string; media: string | null; node: string | null };
type Command = { kind: "discover"; body: Schema<"PartDiscovery"> }
  | { kind: "restore"; candidate: string; body: Schema<"PartCandidateDecision"> };

export function SourcePieces({ source, reader }: { readonly source: string; readonly reader: Reader }) {
  const stale = `${useChangeStamp("Metadata", "Entries")}:${useRefreshStamp(usePaneIsActive(), 0)}`;
  const contents = usePaneFreeServerValue({ key: `/media/${source}/parts`, stale, load: signal => sourceContents(source, signal) });
  const page = contents.status === "ready" ? contents.data : null;
  const navigation = page?.navigation ?? null;
  const [intent, setIntent] = useState<Intent | null>(null);
  const root = useRef<HTMLElement>(null);
  const returnedPart = useRef<string | null>(null);
  const capturedLink = useRef<HTMLElement | null>(null);
  const commands = useResourceDraft<{ request: Command | null; busy: boolean; error: string | null }>(`contents-commands:${source}`,
    () => ({ request: null, busy: false, error: null }), value => ({ changed: false, unconfirmed: value.request !== null, stopsBrowserWork: false }));
  const mounted = useReaderState(reader, state => state.document);
  const viewport = useReaderState(reader, state => state.viewport);
  const matched = navigation !== null && navigation.media_id === source && mounted.status === "ready" && mounted.doc.kind === "text" && mounted.doc.generation === navigation.generation;
  const requestedGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (!navigation || navigation.media_id !== source || matched || requestedGeneration.current === navigation.generation) return;
    requestedGeneration.current = navigation.generation;
    reader.reload(navigation.generation);
  }, [matched, navigation, reader, source]);
  const snapshot = useMemo(() => {
    if (navigation === null) return null;
    const offsets = new Map<string, number>();
    let length = 0;
    for (const fragment of navigation.fragments) { offsets.set(fragment.fragment_id, length); length += fragment.char_count; }
    const offset = (point: TextPoint) => (offsets.get(point.unit) ?? 0) + point.offset;
    const sectionAt = textSectionLookup(navigation.sections.map(section => ({ id: section.section_id, at: { unit: section.target.fragment_id, offset: section.target.offset } })), offset);
    const node = (value: Schema<"ReaderNavigationTocNodeOut">): TocNode => ({ id: value.id, label: value.label, sectionId: value.section_id,
      at: value.target === null ? null : { unit: value.target.fragment_id, offset: value.target.offset }, children: value.children.map(node) });
    return { nodes: navigation.toc_nodes.map(node), sectionAt, offset };
  }, [navigation]);
  const current = matched && mounted.status === "ready" && viewport?.identity === mounted.doc.identity && viewport.primary.kind === "text" ? snapshot?.sectionAt(viewport.primary)?.id ?? null : null;
  const preparationActive = page?.capabilities.create.reason === "preparing_structure" && (page.preparation?.status === "Queued" || page.preparation?.status === "Processing");
  const operationActive = page?.operation?.status === "pending" || page?.operation?.status === "running" || page?.operation?.status === "failed";
  const active = operationActive || preparationActive;
  useIntervalPoll({ enabled: active, pollIntervalMs: 1500, onPoll: () => {
    if (!(contents.status === "ready" && contents.refreshing || contents.status === "failed" && contents.retrying)) contents.revalidate();
  } });
  const refresh = useCallback(async () => {
    try { await contents.refetch(); }
    catch (error) { if (!isAbortError(error) && (!isApiError(error) || isSameSystemApiDefect(error))) throw error; }
  }, [contents]);
  const [completed, setCompleted] = useState(false);
  const previousOperation = useRef<string | null>(null);
  useEffect(() => {
    const operation = page?.operation;
    if (operation?.outcome === "completed" && previousOperation.current === operation.job_id) { setCompleted(true); previousOperation.current = null; }
    if (operationActive && operation) { previousOperation.current = operation.job_id; setCompleted(false); }
  }, [operationActive, page?.operation]);
  useEffect(() => {
    if (!completed) return;
    const timer = setTimeout(() => setCompleted(false), 4000);
    return () => clearTimeout(timer);
  }, [completed]);
  const focusTarget = () => {
    const node = intent?.node ?? null;
    const row = node === null ? null : root.current?.querySelector<HTMLElement>(`[data-contents-node="${CSS.escape(node)}"]`);
    const partSelector = returnedPart.current === null ? null : `[data-contents-work="${CSS.escape(returnedPart.current)}"]`;
    const part = partSelector === null ? null : row?.querySelector<HTMLElement>(partSelector) ?? root.current?.querySelector<HTMLElement>(partSelector);
    const candidate = intent?.kind === "review" ? root.current?.querySelector<HTMLElement>(`[data-contents-candidate="${CSS.escape(intent.candidate)}"]`) : null;
    const target = part ?? candidate ?? row?.querySelector<HTMLElement>("[data-contents-action]") ?? row?.querySelector<HTMLElement>("[data-contents-source]")
      ?? (capturedLink.current?.isConnected ? capturedLink.current : null) ?? root.current?.querySelector<HTMLElement>("[data-contents-top]") ?? root.current;
    return target ? { element: target, preventScroll: true as const } : null;
  };
  const openIntent = (next: Intent) => {
    returnedPart.current = null;
    capturedLink.current = next.node === null ? null : root.current?.querySelector<HTMLElement>(`[data-contents-node="${CSS.escape(next.node)}"] [data-contents-source]`) ?? null;
    setIntent(next);
  };
  const saved = async (id: string | null) => { returnedPart.current = id; await refresh(); };
  const run = async (request: Command, retry = false) => {
    if (commands.read().busy || commands.read().request !== null && !retry) return;
    commands.set({ request, busy: true, error: null });
    try {
      if (request.kind === "discover") await discoverParts(source, request.body);
      else await decidePart(source, request.candidate, request.body);
    } catch (error) {
      commands.set({ request: isRefusal(error) ? null : request, busy: false, error: partError(error) });
      contents.revalidate();
      return;
    }
      commands.set({ request: null, busy: false, error: null });
      await refresh();
      if (request.kind === "restore" && request.body.part_id !== null) {
        const id = request.body.part_id;
        if (intent?.kind === "unavailable" && intent.media === id) {
          returnedPart.current = id;
          setIntent(current => current === intent ? null : current);
        } else root.current?.querySelector<HTMLElement>(`[data-contents-work="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      }
  };
  const blocking = commands.value.busy || commands.value.request !== null;
  const creator = page !== null && page.capabilities.create.reason !== "not_creator" && page.capabilities.discover.reason !== "not_creator";
  const works = page?.works ?? [];
  const workAction = (work: Work): ReactNode => work.kind === "part" ? work.activation.href !== null
    ? <ButtonLink href={work.activation.href} data-contents-work={work.media_id} data-contents-action="true" aria-label={`open ${work.title}`}>open</ButtonLink> : null
    : <Button data-contents-work={work.media_id} data-contents-action="true" aria-label={`restore ${work.title}`} disabled={blocking} onClick={() => {
      if (!blocking) void run({ kind: "restore", candidate: work.candidate_id, body: { expected_version: work.candidate_version, expected_navigation_key: null, decision: "accepted", part_id: work.media_id } });
    }}>restore</Button>;
  const exactWork = (section: string) => works.find(work => work.placement.section_ids?.length === 1 && work.placement.section_ids[0] === section) ?? null;
  const exactCandidate = (section: string) => page?.candidates.find(candidate => candidate.placement.section_ids?.length === 1 && candidate.placement.section_ids[0] === section) ?? null;
  const actions = (node: TocNode): ReactNode => {
    if (node.sectionId === null) return null;
    const work = exactWork(node.sectionId);
    if (work) return workAction(work);
    if (!creator) return null;
    const choice = page?.section_choices.find(choice => choice.section_id === node.sectionId);
    if (!choice) return null;
    if (choice.creation_conflict !== null) return <Button data-contents-action="true" aria-label={`unavailable: ${node.label}`} onClick={() => openIntent({ kind: "unavailable", node: node.id, message: partBlockMessage(choice.creation_conflict!.reason), media: choice.creation_conflict!.media_id })}>unavailable</Button>;
    const candidate = exactCandidate(node.sectionId);
    if (candidate) return <Button data-contents-candidate={candidate.id} data-contents-action="true" aria-label={`review ${candidate.title ?? "untitled suggestion"}`} onClick={() => openIntent({ kind: "review", candidate: candidate.id, node: node.id })}>review</Button>;
    if (choice.eligible || choice.reason === "preparing_structure") return <Button data-contents-action="true" aria-label={`extract ${node.label}`} disabled={blocking} onClick={() => openIntent({ kind: "manual", section: node.sectionId, title: node.label, selection: null, node: node.id })}>extract…</Button>;
    return <Button data-contents-action="true" aria-label={`unavailable: ${node.label}`} onClick={() => openIntent({ kind: "unavailable", node: node.id, message: partBlockMessage(choice.reason), media: null })}>unavailable</Button>;
  };
  const attachments = new Map<string | null, { id: string; content: ReactNode; placement: Schema<"ContentsPlacement"> }[]>();
  const attach = (id: string, title: string, placement: Schema<"ContentsPlacement">, action: ReactNode, dismissed: boolean) => {
    const sections = placement.section_ids;
    const first = sections === null ? null : navigation?.sections.find(section => section.section_id === sections[0])?.label ?? null;
    const last = sections === null ? null : navigation?.sections.find(section => section.section_id === sections.at(-1))?.label ?? null;
    const rows = attachments.get(placement.anchor_node_id) ?? [];
    rows.push({ id, placement, content: <div className={styles.rangeRow}><div className={styles.rangeTitle}>
      <ReaderLink reader={reader} disabled={!matched} target={{ kind: "point", point: { kind: "text", unit: placement.extent.start.fragment_id, offset: placement.extent.start.offset } }}>{title}</ReaderLink>
      <small>{first !== null && last !== null ? `from ${first} through ${last}` : "saved range"}{dismissed ? "; dismissed" : ""}</small>
    </div>{action}</div> });
    attachments.set(placement.anchor_node_id, rows);
  };
  const represented = new Set<string>();
  const collectSections = (nodes: readonly TocNode[]) => { for (const node of nodes) { if (node.sectionId !== null) represented.add(node.sectionId); collectSections(node.children); } };
  collectSections(snapshot?.nodes ?? []);
  for (const work of works) {
    const section = work.placement.section_ids?.length === 1 ? work.placement.section_ids[0] : null;
    if (section !== null && represented.has(section) && exactWork(section)?.media_id === work.media_id) continue;
    attach(work.media_id, work.title, work.placement, workAction(work), false);
  }
  for (const candidate of page?.candidates ?? []) {
    if (candidate.placement.section_ids?.length === 1 && represented.has(candidate.placement.section_ids[0])) continue;
    attach(candidate.id, candidate.title ?? "untitled suggestion", candidate.placement,
      <Button data-contents-candidate={candidate.id} data-contents-action="true" aria-label={`review ${candidate.title ?? "untitled suggestion"}`} onClick={() => openIntent({ kind: "review", candidate: candidate.id, node: candidate.placement.anchor_node_id })}>review</Button>, candidate.user_decision === "rejected");
  }
  const position = (point: Schema<"NavigationTextPointOut">) => snapshot?.offset({ unit: point.fragment_id, offset: point.offset }) ?? 0;
  for (const rows of attachments.values()) rows.sort((a, b) => position(a.placement.extent.start) - position(b.placement.extent.start) || position(b.placement.extent.end) - position(a.placement.extent.end) || a.id.localeCompare(b.id));
  const operation = page?.operation;
  const operationText = preparationActive ? "preparing text…" : operation?.status === "pending" ? "waiting to start"
    : operation?.status === "running" ? `checking ${operation.completed_sections} of ${operation.total_sections} sections`
    : operation?.status === "failed" ? "retrying automatically…" : operation?.status === "dead" ? "couldn’t extract independent works"
    : operation?.outcome === "superseded" ? "the source changed. run extraction again." : completed ? "extraction complete" : null;
  return <section ref={root} className={styles.panel} aria-label="contents" tabIndex={-1}>
    {contents.status === "loading" ? <p role="status">loading contents…</p> : null}
    {contents.status === "failed" || contents.status === "ready" && contents.error !== null ? <><p role="alert">couldn’t refresh contents</p><Button onClick={() => void refresh()}>try again</Button></> : null}
    {page ? <>
      {creator && (page.capabilities.discover.allowed || operationActive || operation?.status === "dead") && navigation ? <Button data-contents-top="true" disabled={blocking || operationActive} onClick={() => {
        if (!blocking && page.capabilities.discover.allowed) void run({ kind: "discover", body: { id: crypto.randomUUID(), expected_source_generation: navigation.generation, expected_latest_job_id: operation?.job_id ?? null } });
      }}>{commands.value.busy ? "starting…" : operation?.status === "dead" || operation?.outcome === "superseded" ? "try again" : "extract independent works"}</Button> : null}
      {operationText ? <p role={operation?.status === "dead" ? "alert" : "status"}>{operationText}</p> : null}
      {navigation === null ? <><p>{partBlockMessage(page.capabilities.create.reason)}</p><Contents reader={reader} /></> : snapshot ? <>
        {!matched ? <><p role={mounted.status === "failed" || mounted.status === "ready" && mounted.refreshFailure !== null ? "alert" : "status"}>{mounted.status === "failed" || mounted.status === "ready" && mounted.refreshFailure !== null ? "couldn’t reload the source text" : "loading current source text…"}</p>
          <Button onClick={() => reader.reload(navigation.generation)}>try again</Button></> : null}
        <nav aria-label="Contents"><ContentsList reader={reader} nodes={snapshot.nodes} current={current} disabled={!matched}
          target={node => node.at === null ? null : { kind: "point", point: { kind: "text", ...node.at } }} actions={actions}
          detail={node => { const work = node.sectionId === null ? null : exactWork(node.sectionId); const candidate = node.sectionId === null ? null : exactCandidate(node.sectionId);
            return work && work.title !== node.label ? <small className={styles.rowNote}>extracted as {work.title}</small>
              : candidate?.user_decision === "rejected" ? <small className={styles.rowNote}>dismissed</small> : null; }}
          attachments={id => attachments.get(id) ?? []} /></nav>
        {snapshot.nodes.length === 0 && works.length === 0 && page.candidates.length === 0 ? <p>no sections available</p> : null}
      </> : null}
    </> : null}
    {commands.value.error ? <p role="alert">{commands.value.error}</p> : null}
    {commands.value.request !== null && !commands.value.busy ? <Button onClick={() => void run(commands.value.request!, true)}>try same request again</Button> : null}
    {intent?.kind === "manual" ? <PartEditor key={`manual:${source}:${intent.section}`} source={source} initialSection={intent.section} initialTitle={intent.title} initialSelection={intent.selection} page={page} definition={null}
      onClose={() => setIntent(current => current === intent ? null : current)} onSaved={saved} onRefresh={refresh} readFailure={contents.status === "failed" || contents.status === "ready" && contents.error !== null} readPending={contents.status === "ready" && contents.refreshing} returnFocusTo={focusTarget} /> : null}
    {intent?.kind === "review" ? <CandidateReview key={`${source}:${intent.candidate}`} source={source} candidate={intent.candidate} onClose={() => setIntent(current => current === intent ? null : current)} onSaved={saved} returnFocusTo={focusTarget}
      onChoose={detail => {
        const valid = detail.selection !== null && detail.selection.source_generation === navigation?.generation && detail.selection.navigation_key === page?.navigation_key;
        setIntent({ kind: "manual", section: valid ? detail.selection!.section_ids[0] ?? null : null, selection: valid ? detail.selection : null, title: detail.finding.title ?? "", node: intent.node });
      }} /> : null}
    {intent?.kind === "unavailable" ? <Dialog open title="unavailable" onClose={() => setIntent(current => current === intent ? null : current)} returnFocusTo={focusTarget}><p>{intent.message}</p>{intent.media === null ? null : works.filter(work => work.media_id === intent.media).map(work => <div key={work.media_id}><p>{work.title}</p>{workAction(work)}</div>)}</Dialog> : null}
  </section>;
}

export function PieceDetails({ id, sourceHref }: { readonly id: string; readonly sourceHref: string | null }) {
  const stale = `${useChangeStamp("Metadata", "Entries")}:${useRefreshStamp(usePaneIsActive(), 0)}`;
  const detail = usePaneFreeServerValue({ key: `/media/${id}/part`, stale, load: signal => partDefinition(id, signal) });
  const definition = detail.status === "ready" ? detail.data : null;
  const source = definition?.source_media_id ?? null;
  const contents = usePaneFreeServerValue({ key: definition?.capabilities.edit_bounds.allowed && source !== null ? `/media/${source}/parts` : null, stale,
    load: signal => sourceContents(source!, signal) });
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    try { await Promise.all([detail.refetch(), ...(definition?.capabilities.edit_bounds.allowed ? [contents.refetch()] : [])]); }
    catch (error) { if (!isAbortError(error) && (!isApiError(error) || isSameSystemApiDefect(error))) throw error; }
  };
  return definition ? <section className={styles.panel} aria-label="work details">
    <p>from {definition.source_title}</p>
    {sourceHref !== null ? <ButtonLink href={sourceHref}>{definition.source_format === "epub" ? "open in book" : "open in article"}</ButtonLink> : null}
    {definition.capabilities.edit_metadata.allowed ? <Button ref={editButton} onClick={() => setEditing(true)}>edit work</Button> : null}
    {editing ? <PartEditor key={id} source={definition.source_media_id} initialSection={definition.selection?.section_ids[0] ?? null} initialTitle={definition.title}
      page={contents.status === "ready" ? contents.data : null} definition={definition} onClose={() => setEditing(false)} onSaved={refresh} onRefresh={refresh} readFailure={detail.status === "failed" || detail.status === "ready" && detail.error !== null || contents.status === "failed" || contents.status === "ready" && contents.error !== null} readPending={detail.status === "ready" && detail.refreshing || contents.status === "ready" && contents.refreshing} returnFocusTo={() => editButton.current} /> : null}
  </section> : null;
}
