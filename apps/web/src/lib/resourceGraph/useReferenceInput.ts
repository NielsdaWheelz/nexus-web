"use client";

// Reference intent is visit-owned draft state above prose persistence. Acceptance
// freezes identity and placement; only the queue head seals its causal version.
import { useEffect, useId, useRef } from "react";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import type { Schema } from "@/lib/api/wire";
import { ApiError } from "@/lib/api/client";
import type { OutlinePosition } from "@/lib/notes/outline";
import { type NoteBody } from "@/lib/notes/noteBody";
import { readText, type TextEditBase } from "@/lib/notes/texts";
import { admitWriting, captureLane, readWriting, type AuthoredSnapshot, type LaneDependency, type WritingCommand, type WritingPosition } from "@/lib/notes/writes";
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
  onSelected(target: Schema<"InsertLink">["target"], item: ResourceItem, authored: readonly AuthoredSnapshot[]): void;
  label: string;
  position: OutlinePosition | null;
  onActiveChange?(active: boolean): void;
}
type ReferenceContext = { source: InsertionSource | null; resource_ref: string | null; position: OutlinePosition | null };
function referenceContext(host: ReferenceInputHost): ReferenceContext {
  return { source: structuredClone(host.source), resource_ref: host.textRef ?? null, position: host.position === null ? null : { ...host.position } };
}
type State = {
  context: ReferenceContext;
  message: string | null;
  raw: string;
  base: NoteBody;
  editBase: TextEditBase | null;
  host: ReferenceInputHost;
  active: SearchActive;
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
  pickerOpen: boolean,
) {
  const paneActive = usePaneIsActive();
  const draft = useResourceDraft<{ state: State | null; completion: number }>(
    `Resources.ReferenceDraft:${editorKey}`,
    () => ({ state: null, completion: 0 }),
  );
  const { state, completion } = draft.value;
  const listId = `reference-${useId().replaceAll(":", "")}`;
  const active = state !== null;
  const paused = readWriting().paused;
  const hasHost = host !== null;
  function set(next: State | null, completed = false) {
    if (readWriting().paused) return;
    draft.set(previous => ({ state: next, completion: previous.completion + (completed ? 1 : 0) }));
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
    paneActive && pickerOpen,
    sourceRef,
  );
  const context = JSON.stringify([draft.owner, state?.context, state?.raw]);
  const admitted = pickerOpen && state !== null && !paused && search.querySettled && !search.minimum && search.list.current;
  const options = admitted ? search.items.map(item => ({ key: targetKey(item), disabledReason: state.message })) : [];
  const reconciled = reconcileSearchActive({ context, admitted, options,
    firstExistingKey: options[0]?.key ?? null, active: state?.active ?? null });
  const selected = admitted ? reconciled?.key ?? null : null;
  useEffect(() => {
    const value = draft.read().state;
    if (value && value === state && value.active !== reconciled) set({ ...value, active: reconciled });
    // Selection belongs to the reference draft; reconciliation changes no text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reconciled]);
  const bindings = useSearchOptions({ listId, label: `link from ${state?.host.label ?? "editor"}`,
    open: pickerOpen && state !== null, options, activeKey: selected,
    onActiveChange(key) {
      const value = draft.read().state;
      if (value && value === state) set({ ...value, active: { context, key } });
    },
    onActivate(key) { accept(search.items.find(item => targetKey(item) === key)); },
  });
  const activeHost = useRef(host);
  activeHost.current = host;
  useEffect(() => {
    const report = activeHost.current?.onActiveChange;
    report?.(active);
    return () => report?.(false);
  }, [active, draft.owner, hasHost]);
  function accept(target: LinkTargetResult | undefined) {
    const value = draft.read().state;
    if (
      !value ||
      !admitted ||
      value.message !== null ||
      value.raw !== state?.raw ||
      !target ||
      !search.items.includes(target)
    )
      return;
    if (readWriting().paused || host === null) return;
    const current = referenceContext(host);
    const frozen = value.context;
    if (JSON.stringify(current) !== JSON.stringify(frozen)) {
      set({ ...value, message: "the outline changed. your query is kept; review its destination before linking." });
      return;
    }
    const owner = host;
    const selectedTarget =
      target.kind === "resource"
        ? { kind: "resource" as const, ref: target.item.ref }
        : { kind: "passage" as const, candidate_ref: target.candidate_ref, passage_target: target.target };
    owner.onSelected(selectedTarget, target.item, []);
    set(null, true);
  }

  return {
    state,
    owner: draft.owner,
    completion,
    search: { ...search, items: admitted ? search.items : [] },
    selected,
    bindings,
    isReady: () => true,
    reviewPosition() {
      const value = draft.read().state;
      const context = host ? referenceContext(host) : null;
      if (value && context && host && !readWriting().paused) {
        set({ ...value, context, host, message: null });
      }
    },
    getState: () => draft.read().state,
    begin(base: NoteBody) {
      const context = host ? referenceContext(host) : null;
      if (host && context && draft.read().state === null) {
        const acked = host.textRef ? readText(host.textRef)?.acked : null;
        set({
          context, message: null,
          raw: "@",
          base,
          editBase: host.textRef
            ? {
                value: base,
                acknowledged:
                  acked && typeof acked.value !== "string"
                    ? { value: acked.value, version: acked.version }
                    : null,
              }
            : null,
            host: {
            ...host,
            source: structuredClone(host.source),
            position: host.position === null ? null : { ...host.position },
          },
          active: null,
        });
      }
    },
    edit(raw: string) {
      const value = draft.read().state;
      if (value) set({ ...value, raw });
    },
    literal() {
      if (readWriting().paused || draft.read().state === null) return false;
      set(null);
      return true;
    },
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
