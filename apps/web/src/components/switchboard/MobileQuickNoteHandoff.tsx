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
import { Fragment } from "prosemirror-model";
import { useFeedback } from "@/components/feedback/Feedback";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  DAILY_DRAFT_HANDOFF_CLAIM_EVENT,
  readDailyDraft,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import {
  createDailyAppendNoteEntry,
  useOpenDailyPage,
  useResolveDailyLocalDate,
} from "@/lib/notes/openDailyPage";
import { useWorkspaceStore } from "@/lib/workspace/store";
import {
  createNoteBodyDoc,
  emptyNoteBody,
  noteBodySchema,
  noteBodyValueFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { isRecord } from "@/lib/validation";
import styles from "./switchboard.module.css";

export interface MobileQuickNoteHandoffHandle {
  begin(returnFocus: HTMLElement): void;
}

interface ActiveHandoff {
  accountId: string;
  localDate: string;
  activationId: string;
  handoffId: string;
  noteId: string;
  clientMutationId: string;
  richAppendBase:
    | {
        bodyPmJson: Record<string, unknown>;
        textOffset: number;
      }
    | null;
}

type RecoveredBodyIngress =
  | { kind: "Plain" }
  | {
      kind: "AppendRich";
      base: NonNullable<ActiveHandoff["richAppendBase"]>;
    }
  | { kind: "OpenAtomicEditor" };

function bodyForText(text: string) {
  return noteBodyValueFromDoc(
    createNoteBodyDoc({ fallbackBodyText: text }),
  );
}

function recoveredBodyIngress(
  bodyPmJson: Record<string, unknown>,
  bodyText: string,
): RecoveredBodyIngress {
  if (
    JSON.stringify(bodyPmJson) ===
    JSON.stringify(bodyForText(bodyText).bodyPmJson)
  ) {
    return { kind: "Plain" };
  }
  const doc = createNoteBodyDoc({ bodyPmJson, fallbackBodyText: bodyText });
  if (!doc.firstChild?.inlineContent) {
    return { kind: "OpenAtomicEditor" };
  }
  let textOffset = 0;
  doc.descendants((node) => {
    if (node.isText) textOffset += node.text?.length ?? 0;
    return true;
  });
  return {
    kind: "AppendRich",
    base: { bodyPmJson, textOffset },
  };
}

function bodyWithRichAppend(
  base: NonNullable<ActiveHandoff["richAppendBase"]>,
  text: string,
) {
  const doc = createNoteBodyDoc({ bodyPmJson: base.bodyPmJson });
  const body = doc.firstChild;
  if (!body?.inlineContent) {
    // justify-defect: richAppendBase is minted only for inline-capable bodies.
    throw new Error("Rich Quick Note append body cannot accept inline text");
  }
  const content = text
    ? body.content.append(Fragment.from(noteBodySchema.text(text)))
    : body.content;
  return noteBodyValueFromDoc(
    noteBodySchema.nodes.note_body_doc!.create(
      null,
      body.type.create(body.attrs, content, body.marks),
    ),
  );
}

const MobileQuickNoteHandoff = forwardRef<
  MobileQuickNoteHandoffHandle,
  { onNavigationAccepted(): void }
>(function MobileQuickNoteHandoff({ onNavigationAccepted }, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef<ActiveHandoff | null>(null);
  const composingRef = useRef(false);
  const [activeHandoffId, setActiveHandoffId] = useState<string | null>(null);
  const { accountId } = useAuthenticatedAccount();
  const openDailyPage = useOpenDailyPage();
  const resolveDailyLocalDate = useResolveDailyLocalDate();
  const { cancelledPaneEntryActivationIds } = useWorkspaceStore();
  const feedback = useFeedback();

  const checkpoint = useCallback((composition: "Composing" | "Complete") => {
    const active = activeRef.current;
    const input = inputRef.current;
    if (!active || !input) return;
    const current = readDailyDraft(active.accountId, active.localDate);
    if (
      !current ||
      current.noteId !== active.noteId ||
      current.handoff.kind !== "Buffered" ||
      current.handoff.handoffId !== active.handoffId
    ) {
      activeRef.current = null;
      setActiveHandoffId(null);
      if (document.activeElement === input) input.blur();
      return;
    }
    const body = active.richAppendBase
      ? bodyWithRichAppend(active.richAppendBase, input.value)
      : bodyForText(input.value);
    const selectionOffset = active.richAppendBase?.textOffset ?? 0;
    writeDailyDraft({
      ...current,
      ...body,
      handoff: {
        kind: "Buffered",
        handoffId: active.handoffId,
        text: body.bodyText,
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

  const begin = useCallback((returnFocus: HTMLElement) => {
    const input = inputRef.current;
    if (!input) {
      throw new Error("Mobile Quick Note handoff input is not mounted");
    }

    // This focus is deliberately the first gesture-time side effect. On iOS,
    // delaying it until pane activation or hydration loses keyboard authority.
    input.focus({ preventScroll: true });
    retireActiveHandoff(false);

    const localDate = resolveDailyLocalDate("Today");
    const existing = readDailyDraft(accountId, localDate);
    const pendingEntry = existing
      ? {
          kind: "AppendNote" as const,
          noteId: existing.noteId,
          clientMutationId: existing.clientMutationId,
        }
      : createDailyAppendNoteEntry();
    const handoffId = crypto.randomUUID();
    const recoveredIngress = existing
      ? recoveredBodyIngress(existing.bodyPmJson, existing.bodyText)
      : ({ kind: "Plain" } as const);
    input.value =
      recoveredIngress.kind === "Plain" ? (existing?.bodyText ?? "") : "";
    input.setSelectionRange(input.value.length, input.value.length);
    composingRef.current = false;

    const opened = openDailyPage(
      {
        kind: "OpenDailyPage",
        localDate,
        entry: pendingEntry,
      },
      {
        disposition: { kind: "Adopt" },
        modality: "Pointer",
      },
    );
    if (opened.activation.kind === "Rejected") {
      input.blur();
      if (returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
      activeRef.current = null;
      setActiveHandoffId(null);
      feedback.show({
        severity: "warning",
        title: "Tab limit reached",
        message: "Close a tab, then try Quick Note again.",
      });
      return;
    }

    const identity = existing ?? {
      version: 1 as const,
      accountId,
      localDate: opened.localDate,
      noteId: pendingEntry.noteId,
      clientMutationId: pendingEntry.clientMutationId,
      ...emptyNoteBody(),
      handoff: { kind: "None" as const },
    };
    if (recoveredIngress.kind === "OpenAtomicEditor") {
      writeDailyDraft({ ...identity, handoff: { kind: "None" } });
      input.blur();
      feedback.show({
        severity: "info",
        title: "Opened your existing note",
        message: "Continue editing it in Today.",
      });
      onNavigationAccepted();
      return;
    }
    const richAppendBase =
      recoveredIngress.kind === "AppendRich" ? recoveredIngress.base : null;
    const active = {
      accountId,
      localDate: opened.localDate,
      activationId: opened.activationId,
      handoffId,
      noteId: identity.noteId,
      clientMutationId: identity.clientMutationId,
      richAppendBase,
    };
    activeRef.current = active;
    setActiveHandoffId(handoffId);
    writeDailyDraft({
      ...identity,
      handoff: {
        kind: "Buffered",
        handoffId,
        text: richAppendBase ? identity.bodyText : input.value,
        selectionStart:
          (richAppendBase?.textOffset ?? 0) + input.selectionStart,
        selectionEnd: (richAppendBase?.textOffset ?? 0) + input.selectionEnd,
        composition: "Complete",
      },
    });
    onNavigationAccepted();
  }, [
    accountId,
    feedback,
    onNavigationAccepted,
    openDailyPage,
    retireActiveHandoff,
    resolveDailyLocalDate,
  ]);

  useImperativeHandle(ref, () => ({ begin }), [begin]);

  useEffect(() => {
    const active = activeRef.current;
    if (
      !active ||
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
      aria-label="Quick Note input handoff"
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
