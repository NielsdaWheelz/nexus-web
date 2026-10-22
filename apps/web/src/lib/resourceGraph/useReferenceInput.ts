"use client";

// Reference intent is visit-owned draft state above prose persistence. Acceptance
// freezes identity and placement; only the queue head seals its causal version.
import { useEffect, useRef } from "react";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import type { Schema } from "@/lib/api/wire";
import { ApiError, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { useFeedback } from "@/components/feedback/Feedback";
import type { OutlinePosition } from "@/lib/notes/outline";
import type { NoteBody } from "@/lib/notes/noteBody";
import { readText, type ReferenceBase } from "@/lib/notes/texts";
import { createRandomId } from "@/lib/createRandomId";
import {
  advanceLinksVersion,
  sealOutlinePosition,
  captureWriteSerial,
  enqueueWrite,
  isWriteRejection,
  nudgeWrites,
} from "@/lib/notes/writes";
import {
  acknowledgeGraphCommands,
  commandsReferToDeletedResource,
  deleteLink,
  type InsertionOut,
  type InsertionSource,
  type Position,
} from "./links";
import {
  targetKey,
  useLinkTargets,
  type LinkTargetResult,
} from "./useLinkTargets";
import { useResourceDraft } from "./useResourceDraft";

export interface ReferenceInputHost {
  textRef?: string;
  prelude?: readonly Schema<"OutlineCommandsRequest">["commands"][number][];
  source: InsertionSource | null;
  onSelected?(target: Schema<"InsertLink">["target"]): void;
  label: string;
  position: Position | null;
  positionBasis?: Schema<"OutlineNodeOut"> | null;
  onInserted?(
    result: InsertionOut,
    source: InsertionSource,
    position: Position | null,
    outlines: Schema<"OutlineCommandsOut">["outlines"],
  ): void;
  onFocus?(result: InsertionOut): void;
  onUndoCreated?(result: InsertionOut): void;
  onActiveChange?(active: boolean): void;
}
type State = {
  raw: string;
  base: NoteBody;
  referenceBase: ReferenceBase | null;
  serial: number;
  host: ReferenceInputHost;
  selected: string | null;
  selectionQuery: string;
  phase: "search" | "submitting" | "rejected" | "unknown";
  message: string | null;
  rejectedVersion: number | null;
  rejectedBasis: Schema<"OutlineNodeOut"> | null;
};

/** Both persisted picker acceptance and delayed first-attachment children use this
 * one insertion sender. The queue seals once; only its acknowledged predecessors
 * advance a captured position. Callbacks keep recovery with the original owner. */
export function queueReferenceInsertion({
  input,
  prelude,
  serial,
  settle,
  fail,
  retrying,
}: {
  input: Omit<Schema<"InsertLink">, "position"> & {
    position: OutlinePosition | null;
  };
  prelude: readonly Schema<"OutlineCommandsRequest">["commands"][number][];
  serial: number;
  settle: (reply: Schema<"OutlineCommandsOut">, serial: number) => void;
  fail: (error: unknown) => void;
  retrying: (error: unknown) => void;
}): void {
  enqueueWrite<Schema<"OutlineCommandsOut">>({
    cancelled: () =>
      commandsReferToDeletedResource([
        ...prelude,
        { ...input, position: null },
      ]),
    cancel: () =>
      fail(
        new ApiError(404, "E_NOT_FOUND", "the source is no longer available"),
      ),
    build() {
      if (
        input.position !== null &&
        (input.source.kind === "resource" ||
          input.position.expected_links_version === null)
      ) {
        const ref =
          input.source.kind === "resource"
            ? input.source.ref
            : input.position.expected_links_version === null
              ? input.position.proof.originSourceRef
              : null;
        if (ref === null)
          throw new Error("a pending position requires its originating source");
        const sealed = sealOutlinePosition(ref, input.position, serial);
        input.position = sealed.position;
        if (input.source.kind === "resource" || sealed.sourceRef !== ref)
          input.source = { kind: "resource", ref: sealed.sourceRef };
      }
      for (const command of prelude) {
        if (
          (command.kind === "insert_note" || command.kind === "insert_link") &&
          command.position !== null &&
          command.source.kind === "resource"
        ) {
          const version = advanceLinksVersion(
            command.source.ref,
            command.position.expected_links_version,
            serial,
          );
          if (version === null)
            throw new ApiError(
              409,
              "E_RESOURCE_CONFLICT",
              "the source placement changed; refresh and try again",
            );
          command.position.expected_links_version = version;
        }
      }
      return {
        path: "/api/resource-graph/commands",
        method: "POST",
        body: { commands: [...prelude, input] },
      };
    },
    settle(reply, writeSerial) {
      acknowledgeGraphCommands(reply);
      settle(reply, writeSerial);
    },
    fail,
    retrying,
  });
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
    ({ state }) => ({ changed: false, unconfirmed: state?.phase === "submitting" || state?.phase === "unknown", stopsBrowserWork: false }),
  );
  const { state, completion } = draft.value;
  const live = useRef(true);
  const liveOwner = useRef(draft.owner);
  liveOwner.current = draft.owner;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const feedback = useFeedback();
  function set(next: State | null, completed = false) {
    draft.set((previous) => ({
      state: next,
      completion: previous.completion + (completed ? 1 : 0),
    }));
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
    state?.host.prelude?.some(
      (command) =>
        command.kind === "insert_note" &&
        sourceRef === `note_block:${command.note_id}`,
    )
      ? null
      : sourceRef,
    state?.phase === "search" || state?.phase === "rejected",
    paneActive && pickerOpen,
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
    if (!value || (value.phase !== "search" && value.phase !== "rejected"))
      return;
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
  const active = state !== null;
  const hasHost = host !== null;
  useEffect(() => {
    const report = activeHost.current?.onActiveChange;
    report?.(active);
    return () => report?.(false);
  }, [active, draft.owner, hasHost]);
  const canReviewPosition =
    state?.phase === "rejected" &&
    state.rejectedVersion !== null &&
    host !== null &&
    host.textRef === state.host.textRef &&
    JSON.stringify(host.source) === JSON.stringify(state.host.source) &&
    host.position !== null &&
    host.positionBasis !== null &&
    host.positionBasis !== undefined &&
    host.positionBasis !== state.rejectedBasis &&
    host.position.expected_links_version >= state.rejectedVersion;

  function accept(target: LinkTargetResult | undefined) {
    const value = draft.read().state;
    if (
      !value ||
      value.rejectedVersion !== null ||
      value.raw !== state?.raw ||
      !target ||
      (value.phase !== "search" && value.phase !== "rejected") ||
      !search.items.includes(target)
    )
      return;
    const owner = value.host;
    const selectedTarget =
      target.kind === "resource"
        ? { kind: "resource" as const, ref: target.item.ref }
        : { kind: "passage" as const, candidate_ref: target.candidate_ref };
    if (owner.onSelected) {
      owner.onSelected(selectedTarget);
      set(null, true);
      return;
    }
    if (owner.source === null)
      throw new Error("a persisted reference requires its source");
    const visitOwner = draft.owner;
    const input = structuredClone({
      kind: "insert_link" as const,
      require_created: false,
      link_id: createRandomId(),
      source: owner.source,
      target:
        target.kind === "resource"
          ? { kind: "resource" as const, ref: target.item.ref }
          : { kind: "passage" as const, candidate_ref: target.candidate_ref },
      position: owner.position,
    });
    const prelude = structuredClone(owner.prelude ?? []);
    const serial =
      value.phase === "rejected" ? captureWriteSerial() : value.serial;
    const frozen = {
      ...value,
      phase: "submitting" as const,
      message: "linking…",
    };
    set(frozen);
    const refused = (error: unknown) => {
      if (
        isApiError(error) &&
        error.status === 409 &&
        typeof error.details?.current_page_ref === "string" &&
        owner.source?.kind === "daily_page"
      ) {
        set({
          ...frozen,
          host: {
            ...owner,
            source: {
              ...owner.source,
              page_id: error.details.current_page_ref.slice("page:".length),
            },
            position: null,
          },
          phase: "rejected",
          rejectedVersion: null,
          message:
            "this day was saved elsewhere. choose a target again to link to its current page.",
        });
        return;
      }
      const rejected = isWriteRejection(error);
      const rejectedVersion =
        rejected &&
        isApiError(error) &&
        error.status === 409 &&
        error.code === "E_RESOURCE_CONFLICT" &&
        input.position !== null
          ? input.position.expected_links_version
          : null;
      set({
        ...frozen,
        rejectedVersion,
        rejectedBasis: activeHost.current?.positionBasis ?? null,
        phase: "rejected",
        message: rejected
          ? rejectedVersion !== null
            ? "couldn’t link. your query is kept; review this row’s refreshed position."
            : "couldn’t link. choose another target or correct the source."
          : "couldn’t prepare the link. your query is kept.",
      });
      if (rejectedVersion !== null) publishChange("Notes");
      if (!rejected) reportError(error);
    };
    queueReferenceInsertion({
      input,
      prelude,
      serial,
      settle(reply) {
        const result = reply.insertions.at(-1)!;
        const focused = document.activeElement;
        const ownedFocus =
          live.current &&
          liveOwner.current === visitOwner &&
          focused
            ?.closest("[data-reference-editor]")
            ?.getAttribute("data-reference-editor") === editorKey;
        set(null, true);
        feedback.offer({
          key: `resource-insertion:${input.link_id}`,
          announcement: "Polite",
          content: {
            tone: result.created ? "Success" : "Info",
            title: result.created ? "linked" : "already linked",
            message: `${result.connection.source.label} · ${result.connection.target.label}`,
          },
          actions: result.created
            ? [
                {
                  label: "undo",
                  onClick: () => {
                    if (owner.onUndoCreated) owner.onUndoCreated(result);
                    else
                      void deleteLink({
                        linkId: result.connection.edge_id,
                        requireUnannotated: true,
                      }).catch((error: unknown) => {
                        if (
                          !isApiError(error) ||
                          error.code !== "E_RESOURCE_CONFLICT"
                        ) {
                          reportError(error);
                          return;
                        }
                        feedback.offer({
                          key: "resource-insertion-undo",
                          announcement: "Polite",
                          content: {
                            tone: "Warning",
                            title:
                              "this link has a note. use remove link to disconnect it.",
                          },
                        });
                      });
                  },
                },
              ]
            : undefined,
        });
        owner.onInserted?.(
          result,
          input.source,
          input.position,
          reply.outlines,
        );
        if (
          ownedFocus &&
          live.current &&
          liveOwner.current === visitOwner &&
          (document.activeElement === focused ||
            (focused !== null &&
              !focused.isConnected &&
              document.activeElement === document.body))
        )
          owner.onFocus?.(result);
      },
      fail: refused,
      retrying() {
        set({
          ...frozen,
          phase: "unknown",
          message: "couldn’t confirm. retry checks the same link.",
        });
      },
    });
  }
  return {
    state,
    owner: draft.owner,
    completion,
    search,
    selected,
    canReviewPosition,
    reviewPosition() {
      const value = draft.read().state;
      if (!canReviewPosition || !value || !host || host.position === null)
        return;
      set({
        ...value,
        host: {
          ...value.host,
          position: structuredClone(host.position),
          onInserted: host.onInserted,
        },
        serial: captureWriteSerial(),
        rejectedVersion: null,
        rejectedBasis: null,
        phase: "search",
        message: null,
      });
    },
    getState: () => draft.read().state,
    begin(base: NoteBody) {
      if (host && draft.read().state === null) {
        const acked = host.textRef ? readText(host.textRef)?.acked : null;
        set({
          raw: "@",
          base,
          referenceBase: host.textRef
            ? {
                value: base,
                acknowledged:
                  acked && typeof acked.value !== "string"
                    ? { value: acked.value, version: acked.version }
                    : null,
              }
            : null,
          serial: captureWriteSerial(),
          host: {
            ...host,
            source: structuredClone(host.source),
            prelude: structuredClone(host.prelude),
            position: structuredClone(host.position),
          },
          selected: null,
          selectionQuery: "",
          phase: "search",
          message: null,
          rejectedVersion: null,
          rejectedBasis: null,
        });
      }
    },
    edit(raw: string) {
      const value = draft.read().state;
      if (value && (value.phase === "search" || value.phase === "rejected"))
        set({
          ...value,
          raw,
          serial:
            value.phase === "rejected" ? captureWriteSerial() : value.serial,
          phase: value.rejectedVersion === null ? "search" : "rejected",
          message: value.rejectedVersion === null ? null : value.message,
        });
    },
    literal() {
      const value = draft.read().state;
      if (!value || value.phase === "search" || value.phase === "rejected") {
        set(null);
        return true;
      }
      return false;
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
    retry: nudgeWrites,
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
