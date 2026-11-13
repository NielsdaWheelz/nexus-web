"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Fact } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { StageAnchor } from "@/components/feedback/Slips";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useServerValue } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { commandKey, getLibrarianCommands, IDLE_COMMAND, pendingReason, sayRefusal, unsureFact } from "@/lib/chat/commands";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { unavailability } from "@/lib/chat/selection";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { useChatDraft, type Draft } from "@/lib/chat/drafts";
import { useLibrarianEntryReads } from "@/lib/panes/indexPaneEntry";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime, usePaneRouter } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, type PaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { Visit } from "@/lib/api/serverState";
import type { Catalog, Timeline, Turn } from "@/lib/chat/wire";
import ChatOperationBoundary from "./ChatOperationBoundary";
import ChatComposer from "./ChatComposer";
import LibrarianTranscript, { type LibrarianTranscriptHandle } from "./LibrarianTranscript";
import { useLibrarianSearch } from "./LibrarianSearch";
import styles from "./ChatSurface.module.css";

const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Librarian.Catalog");
const TIMELINE_VISIT: PaneVisitDataKey<Visit<Timeline>> = definePaneVisitDataKey("Librarian.Timeline");
const NO_TURNS: readonly Turn[] = [];

/** A bounded window onto the account's sole append-only timeline. The composer
 * has no reply endpoint: viewing old messages cannot change where a send lands. */
export default function Librarian() {
  const { accountId } = useAuthenticatedAccount();
  const runtime = requirePaneRuntime(usePaneRuntime(), "Librarian");
  const router = usePaneRouter();
  const workspace = useLatestWorkspace();
  const reads = useLibrarianEntryReads();
  const search = useLibrarianSearch();
  const transcript = useRef<LibrarianTranscriptHandle>(null);
  const commandOwner = useMemo(() => getLibrarianCommands(accountId), [accountId]);
  const command = useSyncExternalStore(commandOwner.subscribe, commandOwner.getSnapshot, () => IDLE_COMMAND);
  const defect = useSyncExternalStore(commandOwner.subscribe, commandOwner.getDefect, () => null);
  const draft = useChatDraft(runtime.paneId);
  const { settleAdopted } = draft;
  const memory = useChatSelection();
  const catalog = useServerValue({ ...reads.catalog, visit: CATALOG_VISIT });
  const currentCatalog = catalog.status === "ready" ? catalog.data : null;
  const selection = draft.draft.selection.kind === "Uninitialized" ? memory.fresh(currentCatalog) ?? draft.draft.selection : draft.draft.selection;
  const modelReason = currentCatalog && selection.kind !== "Uninitialized" ? unavailability(currentCatalog, selection) : null;
  const retryBlocked = pendingReason(command) ?? (currentCatalog === null ? "models haven’t loaded." : selection.kind === "Uninitialized" ? "choose a model." : modelReason);
  const history = useServerValue({ ...reads.timeline, visit: TIMELINE_VISIT, enabled: !search.searching });
  const timeline = history.status === "ready" ? history.data : null;
  const turns = timeline?.items ?? NO_TURNS;
  const fresh = history.status === "ready" && history.fresh;
  const adopted = runtime.href === "/librarian" && !fresh ? draft.adopted : NO_TURNS;
  const recall = runtime.href === "/librarian" && !search.searching && history.status === "ready"
    ? (adopted.at(-1) ?? turns.at(-1))?.user_message.content ?? null : null;
  useLayoutEffect(() => {
    if (runtime.href === "/librarian" && fresh) settleAdopted();
  }, [runtime.href, fresh, settleAdopted]);
  usePaneReturnReady(search.searching ? search.ready : history.status !== "loading");
  const [autoSend, setAutoSend] = useState<{ id: string; draft: Draft } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const { delivery, claim } = usePaneEntryDelivery();
  useLayoutEffect(() => {
    if (!delivery || (delivery.entry.kind !== "FocusLibrarian" && delivery.entry.kind !== "ComposeChat")) return;
    if (!claim(delivery)) return;
    const entry = delivery.entry;
    if (entry.kind === "ComposeChat") draft.seed(entry.text);
    if (entry.kind === "ComposeChat" || entry.send) setAutoSend({ id: delivery.activationId, draft: draft.entry.getSnapshot().draft });
    setFocus(delivery.activationId);
  }, [delivery, claim, draft]);
  const accepted = draft.accepted;
  useLayoutEffect(() => {
    if (!accepted) return;
    if (runtime.href !== "/librarian") router.push("/librarian");
    else history.revalidate();
    draft.accountFor(accepted);
  }, [accepted, runtime.href, router, history, draft]);
  const slips = useOutcome();
  const resend = useResendFeedback();
  const retryTurn = (runId: string) => {
    if (retryBlocked !== null || selection.kind !== "Selected") return;
    void commandOwner.execute({ kind: "RetryTurn", sourceRunId: runId, runId: createRandomId(), selection: selection.selection, viewId: runtime.paneId },
      receipt => {
        const visit = workspace().state.panes.find(pane => pane.id === runtime.paneId)?.current_visit;
        draft.accept(receipt, null, visit?.id === runtime.visitId && new URL(visit.href, "https://nexus.invalid").pathname === "/librarian", runtime.visitId);
      })
      .then(outcome => sayRefusal(slips, outcome))
      .catch(error => commandOwner.reportDefect(error));
  };
  const retryCommand = useCallback(() => void commandOwner.retry().then(outcome => sayRefusal(slips, outcome)), [commandOwner, slips]);
  const recovery = command.kind !== "Idle" && command.standing?.kind === "Unknown"
    ? resend({ line: { fact: unsureFact(command.command), reason: "retry sends the same request." }, resend: { label: "retry", commandKey: commandKey(command.command), busy: command.kind === "Busy", run: retryCommand } }) : null;
  usePaneChrome({ menuActions: [{
    kind: "command", id: "ReadingBrief.Edit", label: "Edit reading brief…", icon: null, restoreFocusOnClose: false,
    onSelect: ({ openIntent }) => {
      const entry = { kind: "FocusReadingBrief" } as const;
      switch (openIntent) {
        case "default": router.push("/settings/librarian", { entry }); return;
        case "new_pane": runtime.activateTarget({ target: { href: "/settings/librarian" }, disposition: { kind: "Fork" }, entry }); return;
        default: assertNever(openIntent);
      }
    },
  }], query: search.query, refresh: { kind: "Refreshable", sourceKey: search.searching ? "librarian-search" : "librarian",
    execute: async () => {
      try {
        if (search.searching) await search.refresh();
        else await history.refetch();
      } catch (error) {
        if (isAbortError(error) || !isApiError(error) || isSameSystemApiDefect(error)) throw error;
        // justify-ignore-error: the displayed read retains its failure and heals on demand.
      }
      return null;
    } } });
  const hold = recovery && command.kind !== "Idle" ? <Hold id={commandKey(command.command)} attempt={command.attempt} {...recovery} /> : null;
  const commandFeedback = defect ? <ChatOperationBoundary failure={defect} paneId={runtime.paneId} visitId={runtime.visitId}
    fallback={hold ?? <Fact line={{ fact: "this librarian action stopped unexpectedly." }} verbs={[{ label: "dismiss", commandKey: "dismiss librarian defect", run: commandOwner.clearDefect }]} />} /> : hold;
  return <div className={styles.surface} style={readerSurfaceStyle(useReaderProfile())}>
      {search.searching ? search.content : <LibrarianTranscript key={`${accountId}:${runtime.visitId}:${reads.timeline.key}`} queryKey={reads.timeline.key} ref={transcript} history={history} adopted={adopted} retryBlocked={retryBlocked} onRetry={retryTurn} />}
      <div className={styles.composerAnchor}><StageAnchor kind="Pane" paneId={runtime.paneId} /></div>
      <div className={styles.composerSlot} data-has-messages={search.searching || turns.length > 0 || adopted.length > 0 || undefined} onWheel={event => transcript.current?.onComposerWheel(event)}>
        {commandFeedback}
        {!search.searching && history.status === "ready" && history.error ? <Fact line={{ fact: "messages stopped updating." }} verbs={[{ label: "retry", commandKey: "refresh librarian", run: history.refetch }]} /> : null}
        <ChatComposer selection={selection} reason={modelReason} autoSend={autoSend} catalog={catalog} command={command} owner={commandOwner} focusKey={focus} recall={recall} />
      </div>
    </div>;
}
