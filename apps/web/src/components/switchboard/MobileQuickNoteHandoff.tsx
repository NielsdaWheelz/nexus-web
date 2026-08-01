"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type SyntheticEvent,
} from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type {
  MaterializedNexusTarget,
  NexusDispatchOutcome,
} from "@/lib/nexus/dispatch";
import {
  DAILY_DRAFT_HANDOFF_CLAIM_EVENT,
  clearDailyDraft,
  readDailyDraft,
  writeDailyDraft,
  type DailyDraft,
} from "@/lib/notes/dailyDraftStore";
import {
  appendDailyDraftText,
  createDailyDraft,
  dailyDraftAcceptsText,
} from "@/lib/resourceSurface/dailySurfacePersistence";
import { isRecord } from "@/lib/validation";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./switchboard.module.css";

type MaterializedDailyPageTarget = Extract<
  MaterializedNexusTarget,
  { kind: "OpenDailyPage" }
>;

export type MaterializedDailyTextHandoffTarget = Omit<
  MaterializedDailyPageTarget,
  "entry"
> & {
  readonly entry: Extract<
    MaterializedDailyPageTarget["entry"],
    { kind: "AppendNote" }
  >;
};

export type DailyTextHandoffAccepted = Extract<
  NexusDispatchOutcome,
  { kind: "DailyPageAccepted" }
>;

export interface MobileQuickNoteHandoffHandle {
  /** Must be the first side effect of a mobile gesture activation. */
  focus(): void;
  prepare(target: MaterializedDailyTextHandoffTarget): void;
  accept(
    target: MaterializedDailyTextHandoffTarget,
    outcome: DailyTextHandoffAccepted,
  ): void;
  cancel(returnFocus: HTMLElement | null): void;
}

interface ActiveHandoff {
  accountId: string;
  localDate: string;
  activationId: string | null;
  handoffId: string;
  noteId: string;
  clientMutationId: string;
  appendBase: DailyDraft;
  previousDraft: DailyDraft | null;
}

interface OpenOnlyHandoff {
  localDate: string;
  noteId: string;
  clientMutationId: string;
}

function appendOrDefect(base: DailyDraft, text: string): DailyDraft {
  const appended = appendDailyDraftText(base, text);
  if (appended.kind === "Unavailable") {
    throw new Error(
      "Prepared mobile daily text handoff cannot append to its draft",
    );
  }
  return appended.draft;
}

const MobileQuickNoteHandoff = forwardRef<
  MobileQuickNoteHandoffHandle
>(function MobileQuickNoteHandoff(_props, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef<ActiveHandoff | null>(null);
  const openOnlyRef = useRef<OpenOnlyHandoff | null>(null);
  const composingRef = useRef(false);
  const [activeHandoffId, setActiveHandoffId] = useState<string | null>(null);
  const { accountId } = useAuthenticatedAccount();
  const { cancelledPaneEntryActivationIds } = useWorkspaceStore();

  const checkpoint = useCallback((composition: "Composing" | "Complete") => {
    const active = activeRef.current;
    const input = inputRef.current;
    if (!active || !input) return;
    const current = readDailyDraft(active.accountId, active.localDate);
    if (
      !current ||
      current.noteId !== active.noteId ||
      current.clientMutationId !== active.clientMutationId ||
      current.handoff.kind !== "Buffered" ||
      current.handoff.handoffId !== active.handoffId
    ) {
      activeRef.current = null;
      setActiveHandoffId(null);
      if (document.activeElement === input) input.blur();
      return;
    }
    const next = appendOrDefect(active.appendBase, input.value);
    const selectionOffset = active.appendBase.bodyText.length;
    writeDailyDraft({
      ...next,
      handoff: {
        kind: "Buffered",
        handoffId: active.handoffId,
        text: next.bodyText,
        selectionStart:
          selectionOffset + (input.selectionStart ?? input.value.length),
        selectionEnd:
          selectionOffset + (input.selectionEnd ?? input.value.length),
        composition,
      },
    });
  }, []);

  const retireActiveHandoff = useCallback(
    (blur: boolean) => {
      const active = activeRef.current;
      const input = inputRef.current;
      if (!active || !input) return;
      checkpoint(composingRef.current ? "Composing" : "Complete");
      const current = readDailyDraft(active.accountId, active.localDate);
      if (
        current?.noteId === active.noteId &&
        current.clientMutationId === active.clientMutationId &&
        current.handoff.kind === "Buffered" &&
        current.handoff.handoffId === active.handoffId
      ) {
        writeDailyDraft({ ...current, handoff: { kind: "None" } });
      }
      if (activeRef.current?.handoffId === active.handoffId) {
        activeRef.current = null;
        setActiveHandoffId(null);
      }
      if (blur && document.activeElement === input) input.blur();
    },
    [checkpoint],
  );

  const focus = useCallback(() => {
    const input = inputRef.current;
    if (!input) {
      throw new Error("Mobile daily text handoff input is not mounted");
    }

    // This is deliberately the first gesture-time side effect. iOS transfers
    // keyboard authority only while the activating event still owns focus.
    input.focus({ preventScroll: true });
    retireActiveHandoff(false);
    openOnlyRef.current = null;
    input.value = "";
    composingRef.current = false;
  }, [retireActiveHandoff]);

  const prepare = useCallback(
    (target: MaterializedDailyTextHandoffTarget) => {
      const input = inputRef.current;
      if (!input) {
        throw new Error("Mobile daily text handoff input is not mounted");
      }
      if (target.date.kind !== "LocalDate") {
        throw new Error("Materialized daily text handoff date is not frozen");
      }
      const localDate = target.date.value;
      const existing = readDailyDraft(accountId, localDate);
      if (
        existing &&
        (existing.noteId !== target.entry.noteId ||
          existing.clientMutationId !== target.entry.clientMutationId)
      ) {
        throw new Error(
          "Materialized mobile daily text identity drifted before staging",
        );
      }
      const appendBase =
        existing ??
        createDailyDraft(
          { accountId, localDate },
          target.entry.noteId,
          target.entry.clientMutationId,
        );
      input.value = target.entry.initialText;
      input.setSelectionRange(input.value.length, input.value.length);

      if (!dailyDraftAcceptsText(appendBase)) {
        if (input.value.length > 0) {
          throw new Error(
            "A nonempty mobile daily text seed reached an atomic draft",
          );
        }
        openOnlyRef.current = {
          localDate,
          noteId: target.entry.noteId,
          clientMutationId: target.entry.clientMutationId,
        };
        return;
      }

      const handoffId = crypto.randomUUID();
      const next = appendOrDefect(appendBase, input.value);
      const selectionOffset = appendBase.bodyText.length;
      activeRef.current = {
        accountId,
        localDate,
        activationId: null,
        handoffId,
        noteId: target.entry.noteId,
        clientMutationId: target.entry.clientMutationId,
        appendBase,
        previousDraft: existing,
      };
      setActiveHandoffId(handoffId);
      writeDailyDraft({
        ...next,
        handoff: {
          kind: "Buffered",
          handoffId,
          text: next.bodyText,
          selectionStart: selectionOffset + input.selectionStart,
          selectionEnd: selectionOffset + input.selectionEnd,
          composition: "Complete",
        },
      });
    },
    [accountId],
  );

  const accept = useCallback(
    (
      target: MaterializedDailyTextHandoffTarget,
      outcome: DailyTextHandoffAccepted,
    ) => {
      const input = inputRef.current;
      if (!input) {
        throw new Error("Mobile daily text handoff input is not mounted");
      }
      const openOnly = openOnlyRef.current;
      if (openOnly) {
        if (
          openOnly.localDate !== outcome.localDate ||
          openOnly.noteId !== target.entry.noteId ||
          openOnly.clientMutationId !== target.entry.clientMutationId
        ) {
          throw new Error(
            "Accepted mobile daily open-only identity does not match its preparation",
          );
        }
        openOnlyRef.current = null;
        input.blur();
        input.value = "";
        return;
      }
      const active = activeRef.current;
      if (
        !active ||
        active.localDate !== outcome.localDate ||
        active.noteId !== target.entry.noteId ||
        active.clientMutationId !== target.entry.clientMutationId
      ) {
        throw new Error(
          "Accepted mobile daily text identity does not match its staged buffer",
        );
      }
      active.activationId = outcome.activationId;
    },
    [],
  );

  const cancel = useCallback(
    (returnFocus: HTMLElement | null) => {
      const active = activeRef.current;
      if (active?.activationId === null) {
        const current = readDailyDraft(active.accountId, active.localDate);
        if (
          current?.noteId === active.noteId &&
          current.clientMutationId === active.clientMutationId &&
          current.handoff.kind === "Buffered" &&
          current.handoff.handoffId === active.handoffId
        ) {
          if (active.previousDraft) {
            writeDailyDraft(active.previousDraft);
          } else {
            clearDailyDraft(active.accountId, active.localDate);
          }
        }
        activeRef.current = null;
        setActiveHandoffId(null);
      } else {
        retireActiveHandoff(true);
      }
      openOnlyRef.current = null;
      const input = inputRef.current;
      if (input && document.activeElement === input) input.blur();
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    },
    [retireActiveHandoff],
  );

  useImperativeHandle(
    ref,
    () => ({ focus, prepare, accept, cancel }),
    [accept, cancel, focus, prepare],
  );

  useEffect(() => {
    const active = activeRef.current;
    if (
      !active ||
      active.activationId === null ||
      !cancelledPaneEntryActivationIds.has(active.activationId)
    ) {
      return;
    }
    retireActiveHandoff(true);
  }, [cancelledPaneEntryActivationIds, retireActiveHandoff]);

  useEffect(() => {
    const onClaim = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const active = activeRef.current;
      if (
        !active ||
        !isRecord(detail) ||
        detail.accountId !== active.accountId ||
        detail.localDate !== active.localDate ||
        detail.handoffId !== active.handoffId
      ) {
        return;
      }
      activeRef.current = null;
      setActiveHandoffId(null);
      const input = inputRef.current;
      if (input) {
        input.value = "";
        if (document.activeElement === input) input.blur();
      }
    };
    window.addEventListener(DAILY_DRAFT_HANDOFF_CLAIM_EVENT, onClaim);
    return () =>
      window.removeEventListener(DAILY_DRAFT_HANDOFF_CLAIM_EVENT, onClaim);
  }, []);

  const checkpointFromInput = (
    event: FormEvent<HTMLTextAreaElement> | SyntheticEvent<HTMLTextAreaElement>,
  ) => {
    if (event.currentTarget !== inputRef.current) return;
    checkpoint(composingRef.current ? "Composing" : "Complete");
  };

  const handleCompositionStart = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ) => {
    composingRef.current = true;
    checkpointFromInput(event);
  };
  const handleCompositionEnd = (
    event: CompositionEvent<HTMLTextAreaElement>,
  ) => {
    composingRef.current = false;
    checkpointFromInput(event);
  };

  return (
    <textarea
      ref={inputRef}
      className={styles.quickNoteHandoffInput}
      tabIndex={-1}
      aria-label="Daily note input handoff"
      data-handoff-id={activeHandoffId ?? undefined}
      autoCapitalize="sentences"
      autoCorrect="on"
      enterKeyHint="enter"
      onInput={checkpointFromInput}
      onSelect={checkpointFromInput}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  );
});

export default MobileQuickNoteHandoff;
