"use client";

// Reference intent is visit-owned draft state above prose persistence. Acceptance
// freezes identity and placement; only the queue head seals its causal version.
import { useEffect, useRef } from "react";
import type { Schema } from "@/lib/api/wire";
import { ApiError } from "@/lib/api/client";
import type { OutlinePosition } from "@/lib/notes/outline";
import { emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import { readText, type ReferenceBase } from "@/lib/notes/texts";
import { admitWriting, captureLane, checkpoint, claimDraft, openDraft, readDraft, readWriting, releaseDraft, resetDraftSeed, updateDraftContext, stageDraft, type AuthoredSnapshot, type DraftContext, type DraftHandle, type LaneDependency, type WritingCommand, type WritingPosition } from "@/lib/notes/journal";
import type { ResourceItem } from "@/lib/resources/items";
import {
  type InsertionSource,
} from "./links";
import {
  targetKey,
  useLinkTargets,
  type LinkTargetResult,
} from "./useLinkTargets";
import { useResourceDraft } from "./useResourceDraft";

export interface ReferenceInputHost {
  textRef?: string;
  source: InsertionSource | null;
  onSelected(target: Schema<"InsertLink">["target"], item: ResourceItem, authored: Promise<AuthoredSnapshot[]>): void;
  recoverySource?: InsertionSource;
  label: string;
  position: OutlinePosition | null;
  onActiveChange?(active: boolean): void;
}
type ReferenceContext = Extract<DraftContext, { kind: "reference" }>;
function referenceContext(host: ReferenceInputHost): ReferenceContext | null {
  const source = host.recoverySource ?? host.source;
  if (source === null) return null;
  const position = host.position;
  const ref = source.kind === "resource" ? source.ref : source.kind === "daily_page" ? `page:${source.page_id}` : source.kind === "passage" ? source.candidate_ref : `highlight:${source.highlight_id}`;
  return { kind: "reference", source: structuredClone(source), resource_ref: host.textRef ?? null, position: position === null ? null : position.expected_links_version === null
    ? { after: position.after, predecessor: { kind: "insertion", ...position.proof } }
    : { after: position.after, expected_links_version: captureLane(ref, "links", position.expected_links_version) } };
}
type State = {
  context: ReferenceContext;
  message: string | null;
  raw: string;
  base: NoteBody;
  referenceBase: ReferenceBase | null;
  host: ReferenceInputHost;
  selected: string | null;
  selectionQuery: string;
};

/** Admission freezes source, target and placement with the authored snapshots. */
export function queueReferenceInsertion({ input, prelude, authored = [], dependency = null }: {
  input: Omit<Schema<"InsertLink">, "position"> & { position: OutlinePosition | null };
  prelude: readonly WritingCommand[];
  authored?: Parameters<typeof admitWriting>[1];
  dependency?: LaneDependency | null;
}) {
  const ref = input.position?.expected_links_version === null ? input.position.proof.source_ref :
    input.source.kind === "resource" ? input.source.ref : input.source.kind === "daily_page" ? `page:${input.source.page_id}` : null;
  let position: WritingPosition | null = null;
  if (input.position !== null) {
    if (input.position.expected_links_version === null) position = {
      after: input.position.after, predecessor: { kind: "insertion", ...input.position.proof },
    };
    else {
      if (ref === null) throw new ApiError(409, "E_RESOURCE_CONFLICT", "the captured destination cannot supply a placement version");
      position = { after: input.position.after, expected_links_version: dependency ?? captureLane(ref, "links", input.position.expected_links_version) };
    }
  }
  return admitWriting({ kind: "outline", commands: [...prelude, { ...input, position }] }, authored);
}
export function useReferenceInput(
  editorKey: string,
  host: ReferenceInputHost | null,
) {
  const draft = useResourceDraft<{ state: State | null; completion: number; ready: boolean }>(
    `Resources.ReferenceDraft:${editorKey}`,
    () => ({ state: null, completion: 0, ready: false }),
  );
  const { state, completion, ready } = draft.value;
  const active = state !== null;
  const paused = readWriting().paused;
  const hasHost = host !== null;
  const currentHost = useRef(host);
  currentHost.current = host;
  const opening = useRef<Promise<DraftHandle> | null>(null);
  const opened = useRef<DraftHandle | null>(null);
  const contextChange = useRef<Promise<void>>(Promise.resolve());
  const owned = useRef(new Set<Promise<DraftHandle>>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const branches = owned.current;
    return () => {
      mounted.current = false;
      for (const branch of branches) void branch.then(releaseDraft).catch(reportError);
    };
  }, []);
  const recoveryChecked = useRef(false);
  useEffect(() => {
    const host = currentHost.current;
    const context = host ? referenceContext(host) : null;
    if (!host || context === null || opening.current !== null || readWriting().paused) return;
    const candidates = recoveryChecked.current ? [] : readWriting().drafts.filter(candidate => candidate.context.kind === "reference"
      && candidate.context.resource_ref === (host.textRef ?? null)
      && JSON.stringify(candidate.context.source) === JSON.stringify(host.recoverySource ?? host.source)
      && candidate.value.kind === "reference" && candidate.revision > 0
      && (candidate.base === null || JSON.stringify(candidate.base.value) !== JSON.stringify(candidate.value))
      && !readWriting().outbox.some(row => row.authored.some(item => item.draft_id === candidate.draft_id)));
    recoveryChecked.current = true;
    const value = host.textRef ? readText(host.textRef)?.value : null;
    const base = typeof value === "object" && value !== null ? value : emptyBody();
    const branch = (async () => {
      const recovered = candidates.length === 1 ? await claimDraft(candidates[0]!.draft_id) : null;
      return recovered ?? openDraft(context, { kind: "reference", raw: "", base_body_pm_json: base.body_pm_json }, null);
    })();
    opening.current = branch; owned.current.add(branch);
    void branch.then(handle => {
      if (!mounted.current || opening.current !== branch) return;
      opened.current = handle;
      const saved = readDraft(handle.draft_id);
      if (!saved || saved.context.kind !== "reference" || saved.value.kind !== "reference" || saved.revision === 0) {
        draft.set(value => ({ ...value, ready: true })); return;
      }
      const body = parseBody(saved.value.base_body_pm_json);
      const raw = saved.value.raw;
      const context = saved.context;
      const acknowledged = saved.base?.value.kind === "body" && typeof saved.base.version === "number"
        ? { value: parseBody(saved.base.value.body_pm_json), version: saved.base.version } : null;
      draft.set(value => ({ ...value, ready: true, state: { raw, base: body,
        context, host, referenceBase: host.textRef ? { value: body, acknowledged, consumed_reference: null } : null,
        message: null, selected: null, selectionQuery: "" } }));
    }).catch(error => {
      if (opening.current === branch) opening.current = null;
      if (!readWriting().paused) reportError(error);
    });
    // Clean local ownership is acquired once before input; no network or row is created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey, hasHost, completion, active, paused]);
  function set(next: State | null, completed = false) {
    if (readWriting().paused) return;
    if (next !== null) {
      const handle = opened.current;
      const snapshot = handle ? readDraft(handle.draft_id) : null;
      if (!handle || !snapshot) return;
      const value = { kind: "reference" as const, raw: next.raw, base_body_pm_json: next.base.body_pm_json };
      if (snapshot.revision === 0 || JSON.stringify(snapshot.value) !== JSON.stringify(value))
        void checkpoint(handle, snapshot.revision, value, null).catch(reportError);
    } else {
      opening.current = null; opened.current = null;
      contextChange.current = Promise.resolve();
    }
    draft.set(previous => ({ state: next, ready: next === null ? false : previous.ready,
      completion: previous.completion + (completed ? 1 : 0) }));
  }
  const source = state?.host.source;
  const sourceRef =
    source?.kind === "resource"
      ? source.ref
      : source?.kind === "passage"
        ? source.candidate_ref
        : null;
  const search = useLinkTargets(
    state?.raw ?? "",
    sourceRef,
    state !== null,
    sourceRef,
  );
  const query = state?.raw.slice(1).trim() ?? "";
  let selected = state?.selected ?? null;
  if (state && state.selectionQuery !== query)
    selected = search.items[0] ? targetKey(search.items[0]) : null;
  if (
    selected !== null &&
    !search.items.some((item) => targetKey(item) === selected)
  )
    selected = null;
  useEffect(() => {
    const value = draft.read().state;
    if (!value) return;
    if (value.selectionQuery !== query && !search.loading && !search.minimum) {
      set({
        ...value,
        selectionQuery: query,
        selected: search.items[0] ? targetKey(search.items[0]) : null,
      });
    } else if (
      value.selected !== null &&
      value.selectionQuery === query &&
      !search.loading &&
      !search.items.some((item) => targetKey(item) === value.selected)
    ) {
      set({ ...value, selected: null });
    }
    // The draft changes only after a current result set arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search.items, search.loading, search.minimum]);
  const activeHost = useRef(host);
  activeHost.current = host;
  useEffect(() => {
    const report = activeHost.current?.onActiveChange;
    report?.(active);
    return () => report?.(false);
  }, [active, draft.owner, hasHost]);
  function authoredReference(value: State): Promise<AuthoredSnapshot[]> {
    const branch = opening.current;
    if (branch === null) return Promise.reject(new Error("the reference branch is not ready"));
    return branch.then(async handle => {
      await contextChange.current;
      return [stageDraft(handle, { kind: "reference", raw: value.raw, base_body_pm_json: value.base.body_pm_json }, null)];
    });
  }
  function accept(target: LinkTargetResult | undefined) {
    const value = draft.read().state;
    if (
      !value ||
      value.raw !== state?.raw ||
      !target ||
      !search.items.includes(target)
    )
      return;
    if (readWriting().paused || host === null) return;
    const current = referenceContext(host);
    const saved = opened.current ? readDraft(opened.current.draft_id)?.context : null;
    const frozen = saved?.kind === "reference" ? saved : value.context;
    if (JSON.stringify(current) !== JSON.stringify(frozen)) {
      set({ ...value, message: "the outline changed. your query is kept; review its destination before linking." });
      return;
    }
    const owner = host;
    const selectedTarget =
      target.kind === "resource"
        ? { kind: "resource" as const, ref: target.item.ref }
        : { kind: "passage" as const, candidate_ref: target.candidate_ref };
    owner.onSelected(selectedTarget, target.item, authoredReference(value));
    set(null, true);
  }

  return {
    state,
    owner: draft.owner,
    completion,
    search,
    selected,
    ready: !hasHost || ready && opened.current !== null,
    reviewPosition() {
      const value = draft.read().state;
      const context = host ? referenceContext(host) : null;
      if (value && context && host && !readWriting().paused) {
        if (opened.current === null) return;
        contextChange.current = updateDraftContext(opened.current, context);
        void contextChange.current.catch(reportError);
        set({ ...value, context, host, message: null });
      }
    },
    getState: () => draft.read().state,
    begin(base: NoteBody) {
      const context = host ? referenceContext(host) : null;
      if (host && context && opened.current !== null && draft.read().state === null) {
        contextChange.current = Promise.resolve();
        const acked = host.textRef ? readText(host.textRef)?.acked : null;
        resetDraftSeed(opened.current, context, { kind: "reference", raw: "@", base_body_pm_json: base.body_pm_json },
          acked && typeof acked.value !== "string" ? { value: { kind: "body", body_pm_json: acked.value.body_pm_json }, version: acked.version } : null);
        set({
          context, message: null,
          raw: "@",
          base,
          referenceBase: host.textRef
            ? {
                value: base,
                consumed_reference: null,
                acknowledged:
                  acked && typeof acked.value !== "string"
                    ? { value: acked.value, version: acked.version }
                    : null,
              }
            : null,
            host: {
            ...host,
            source: structuredClone(host.source),
            position: structuredClone(host.position),
          },
          selected: null,
          selectionQuery: "",
        });
      }
    },
    edit(raw: string) {
      const value = draft.read().state;
      if (value) set({ ...value, raw });
    },
    literal() {
      const handle = opened.current;
      const snapshot = handle ? readDraft(handle.draft_id) : null;
      if (readWriting().paused || !handle || !snapshot) return false;
      const consumed = { draft_id: handle.draft_id, revision: snapshot.revision };
      set(null);
      return consumed;
    },
    choose(key: string) {
      const value = draft.read().state;
      if (value && search.items.some((item) => targetKey(item) === key))
        set({ ...value, selected: key, selectionQuery: query });
    },
    move(delta: number) {
      const index = search.items.findIndex(
        (item) => targetKey(item) === selected,
      );
      const next =
        search.items[
          Math.max(0, Math.min(search.items.length - 1, index + delta))
        ];
      const value = draft.read().state;
      if (next && value)
        set({ ...value, selected: targetKey(next), selectionQuery: query });
    },
    accept,
    enter() {
      accept(search.items.find((item) => targetKey(item) === selected));
    },
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
