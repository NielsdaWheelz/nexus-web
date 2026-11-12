"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Fact } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { StageAnchor } from "@/components/feedback/Slips";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useServerValue } from "@/lib/api/serverState";
import { commandKey, getLibrarianCommands, IDLE_COMMAND, sayRefusal, unsureFact } from "@/lib/chat/commands";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { unavailability } from "@/lib/chat/selection";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { useChatDraft, type Draft } from "@/lib/chat/drafts";
import { useLibrarianEntryReads } from "@/lib/panes/indexPaneEntry";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime, usePaneRouter } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, type PaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import type { Visit } from "@/lib/api/serverState";
import type { Catalog, Timeline } from "@/lib/chat/wire";
import ChatOperationBoundary from "./ChatOperationBoundary";
import ChatComposer from "./ChatComposer";
import LibrarianTranscript, { type LibrarianTranscriptHandle } from "./LibrarianTranscript";
import { useLibrarianSearch } from "./LibrarianSearch";
import styles from "./ChatSurface.module.css";

const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Librarian.Catalog");
const TIMELINE_VISIT: PaneVisitDataKey<Visit<Timeline>> = definePaneVisitDataKey("Librarian.Timeline");

/** A bounded window onto the account's sole append-only timeline. The composer
 * has no reply endpoint: viewing old messages cannot change where a send lands. */
export default function Librarian() {
  const { accountId } = useAuthenticatedAccount();
  const runtime = requirePaneRuntime(usePaneRuntime(), "Librarian");
  const router = usePaneRouter();
  const reads = useLibrarianEntryReads();
  const search = useLibrarianSearch();
  const transcript = useRef<LibrarianTranscriptHandle>(null);
  const commandOwner = useMemo(() => getLibrarianCommands(accountId), [accountId]);
  const command = useSyncExternalStore(commandOwner.subscribe, commandOwner.getSnapshot, () => IDLE_COMMAND);
  const defect = useSyncExternalStore(commandOwner.subscribe, commandOwner.getDefect, () => null);
  const draft = useChatDraft(runtime.paneId);
  const memory = useChatSelection();
  const catalog = useServerValue({ ...reads.catalog, visit: CATALOG_VISIT });
  const currentCatalog = catalog.status === "ready" ? catalog.data : null;
  const selection = draft.draft.selection.kind === "Uninitialized" ? memory.fresh(currentCatalog) ?? draft.draft.selection : draft.draft.selection;
  const modelReason = currentCatalog && selection.kind !== "Uninitialized" ? unavailability(currentCatalog, selection) : null;
  const retryAvailable = command.kind === "Idle" && currentCatalog !== null && selection.kind === "Selected" && modelReason === null;
  const history = useServerValue({ ...reads.timeline, visit: TIMELINE_VISIT, enabled: !search.searching });
  const timeline = history.status === "ready" ? history.data : null;
  const turns = timeline?.items ?? [];
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
  useEffect(() => {
    if (!accepted) return;
    if (runtime.href !== "/librarian") router.push("/librarian");
    else history.revalidate();
    draft.accountFor(accepted);
  }, [accepted, runtime.href, router, history, draft]);
  const slips = useOutcome();
  const resend = useResendFeedback();
  const retryTurn = (runId: string) => {
    if (!retryAvailable || selection.kind !== "Selected") return;
    void commandOwner.execute({ kind: "RetryTurn", sourceRunId: runId, runId: createRandomId(), selection: selection.selection, viewId: runtime.paneId })
      .then(outcome => { sayRefusal(slips, outcome); if (outcome.kind === "Accepted" && runtime.href !== "/librarian") router.push("/librarian"); })
      .catch(error => commandOwner.reportDefect(error));
  };
  const retryCommand = useCallback(() => void commandOwner.retry().then(outcome => sayRefusal(slips, outcome)), [commandOwner, slips]);
  const recovery = command.kind !== "Idle" && command.standing?.kind === "Unknown"
    ? resend({ line: { fact: unsureFact(command.command), reason: "retry sends the same request." }, resend: { label: "retry", commandKey: commandKey(command.command), busy: command.kind === "Busy", run: retryCommand } }) : null;
  usePaneChrome({ query: search.query, refresh: { kind: "Refreshable", sourceKey: search.searching ? "librarian-search" : "librarian",
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
  return <div className={styles.surface}>
      {search.searching ? search.content : <LibrarianTranscript ref={transcript} history={history} retryAvailable={retryAvailable} onRetry={retryTurn} />}
      <div className={styles.composerAnchor}><StageAnchor kind="Pane" paneId={runtime.paneId} /></div>
      <div className={styles.composerSlot} data-has-messages={search.searching || turns.length > 0 || undefined} onWheel={event => transcript.current?.onComposerWheel(event)}>
        {commandFeedback}
        {!search.searching && history.status === "ready" && history.error ? <Fact line={{ fact: "messages stopped updating." }} verbs={[{ label: "retry", commandKey: "refresh librarian", run: history.refetch }]} /> : null}
        <div className={styles.lanes}><Link href="/settings/account">edit reading brief</Link></div>
        <ChatComposer selection={selection} reason={modelReason} autoSend={autoSend} catalog={catalog} command={command} owner={commandOwner} focusKey={focus} />
      </div>
    </div>;
}
