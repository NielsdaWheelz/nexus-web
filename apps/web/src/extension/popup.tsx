// The capture popup: one compact form over the background's capture. It renders
// the ViewState pushed on its port (Firefox does not order a sendMessage reply
// against port messages, so the push is the only state) and sends Commands,
// reading replies only for a catalog or a failure. Selection and Save share the
// port; the popup overlays only the posted edits its pushes have not acknowledged.
//
// Import order is load order: the token owner and packaged fonts precede every
// component module, so popup.module.css is emitted last and owns the overrides.
import "@/app/globals.css";
import "@/app/packagedFonts.css";

import { StrictMode, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Announcement, FeedbackProvider } from "@/components/feedback/Feedback";
import { Fact } from "@/components/feedback/Fact";
import type { Line } from "@/components/feedback/stage";
import { DestinationTrigger } from "@/components/libraries/DestinationChooser";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import ChoicePicker from "@/components/ui/ChoicePicker";
import type { Schema } from "@/lib/api/wire";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useCollectionLayout } from "@/lib/ui/collection";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import {
  VIEW_PORT,
  setDestination,
  type CaptureFailure,
  type CapturePhase,
  type Command,
  type CommandResult,
  type ViewState,
  type ViewCommand,
  type ViewMessage,
} from "@/extension/capture";
import styles from "./popup.module.css";

type LibraryDestination = Schema<"LibraryDestinationOut">;

/** A command's reply, or the background unreachable: the popup never guesses. */
type Reply = CommandResult | { kind: "unreachable" };

async function command(sent: Command): Promise<Reply> {
  try {
    return (await browser.runtime.sendMessage(sent)) as CommandResult;
  } catch (error) {
    console.error("the extension's background could not be reached:", error);
    return { kind: "unreachable" };
  }
}

/** A lost background or port; opening the popup again reconnects it. */
const NOT_ANSWERING: Line = { fact: "the extension isn’t answering.", reason: "reopening this popup retries." };

/** The notice for a command that did not run, else null. */
function replyNotice(reply: Reply): Line | null {
  return reply.kind === "failure" ? failureLine(reply.failure) : reply.kind === "unreachable" ? NOT_ANSWERING : null;
}

function failureLine(
  failure: CaptureFailure,
  title?: string,
): Line {
  return {
    fact: title ?? failure.message,
    reason: title === undefined ? undefined : failure.message,
  };
}

const STATUS: Record<CapturePhase["kind"], string> = {
  draft: "",
  review: "",
  failed: "",
  acquiring: "reading the source…",
  uploading: "uploading…",
  confirming: "checking…",
  saved: "sent",
};

/** "https://nexus.example/*" -> "nexus.example" */
const patternHost = (pattern: string) =>
  /^[a-z]+:\/\/([^/]+)\//.exec(pattern)?.[1] ?? pattern;

function Popup() {
  const [state, setState] = useState<ViewState | null>(null);
  const [notice, setNotice] = useState<Line | null>(null);
  const [retryFailure, setRetryFailure] = useState<Extract<CapturePhase, { kind: "failed" }> | null>(null);
  const frame = useRef<HTMLElement>(null);
  useActionFocusRecovery(frame, () => frame.current);
  const [pending, setPending] = useState<ViewCommand[]>([]);
  const [connected, setConnected] = useState(false);
  const connection = useRef<{
    port: browser.runtime.Port;
    sequence: number;
    pending: ViewCommand[];
  } | null>(null);

  const send = (sent: Command) => {
    setNotice(null);
    setRetryFailure((sent.kind === "retry" || sent.kind === "review") && state?.draft?.phase.kind === "failed" ? state.draft.phase : null);
    void command(sent).then((result) => {
      const failed = replyNotice(result);
      if (failed !== null) {
        setNotice(failed);
        setRetryFailure(null);
      }
    });
  };

  useEffect(() => {
    const port = browser.runtime.connect({ name: VIEW_PORT });
    const current: NonNullable<typeof connection.current> = { port, sequence: 0, pending: [] };
    connection.current = current;
    setConnected(true);
    port.onMessage.addListener((incoming: object) => {
      // justify-type-assertion: this port is connected to our same-build background
      const message = incoming as ViewMessage;
      if (connection.current !== current) return;
      current.pending = current.pending.filter(edit => edit.sequence > message.acknowledged);
      setPending(current.pending);
      setState(message.state);
      const phase = message.state.draft?.phase.kind;
      if (phase !== "acquiring" && phase !== "uploading" && phase !== "confirming") setRetryFailure(null);
      if (message.failure !== null) setNotice(failureLine(message.failure));
    });
    port.onDisconnect.addListener(() => {
      if (connection.current !== current) return;
      connection.current = null;
      setPending([]);
      setConnected(false);
      setRetryFailure(null);
      setNotice(NOT_ANSWERING);
    });
    void command({ kind: "activate" }).then((result) => {
      if (connection.current !== current) return;
      const failed = replyNotice(result);
      if (failed !== null) setNotice(failed);
    });
    return () => {
      if (connection.current === current) connection.current = null;
      port.disconnect();
    };
  }, []);

  const post = (action: { kind: "set_destination"; destination: LibraryDestination; included: boolean } | { kind: "set_recovery_target"; candidate: Schema<"RecoveryCandidate"> | null } | { kind: "save" }): boolean => {
    const current = connection.current;
    if (current === null || state === null || state.draft === null || state.account === null) return false;
    const sent: ViewCommand = { ...action, sequence: ++current.sequence, draftId: state.draft.id, accountId: state.account.userId };
    try {
      current.port.postMessage(sent);
    } catch (error) {
      console.error("the extension's port is lost:", error);
      setNotice(NOT_ANSWERING);
      return false;
    }
    current.pending = [...current.pending, sent];
    setPending(current.pending);
    setNotice(null);
    return true;
  };

  // Firefox grants optional origins only inside the click, and its doorhanger may
  // close this popup, so the command goes first and the background waits for the
  // grant (permissions.onAdded); a denial fires nothing there, so this is its notice.
  const sendWithOrigins = (sent: Command | { kind: "save" }) => {
    if (state === null) return;
    const origins = state.requiredOrigins;
    if (sent.kind === "save") {
      if (!post(sent)) return;
    } else send(sent);
    if (origins.length === 0) return;
    void browser.permissions.request({ origins }).then(
      (granted) => {
        if (granted) return;
        setRetryFailure(null);
        setNotice({ fact: `firefox didn’t allow access to ${origins.map(patternHost).join(", ")}.`, reason: "nothing was sent." });
      },
      (error: unknown) => {
        console.error("the access request failed:", error);
        setRetryFailure(null);
        setNotice({ fact: "couldn’t ask firefox for access.", reason: "nothing was sent." });
      },
    );
  };

  if (state === null) {
    const line = notice ?? { fact: "opening…" };
    return <main className={styles.popup} ref={frame} tabIndex={-1} aria-busy="true">
      <Fact line={line} />
      <Announcement text={line.reason ? `${line.fact} ${line.reason}` : line.fact} level="Polite" />
    </main>;
  }

  const { account, draft } = state;
  const chosen = pending.reduce((destinations, edit) => edit.kind === "set_destination" && edit.draftId === draft?.id && edit.accountId === account?.userId
    ? setDestination(destinations, edit) : destinations, draft?.destinations ?? []);
  const saving = pending.some(edit => edit.kind === "save");
  const selectingRecovery = pending.some(edit => edit.kind === "set_recovery_target" && edit.draftId === draft?.id && edit.accountId === account?.userId);
  const phase = draft?.phase ?? null;
  const openUrl = phase?.kind === "saved" ? phase.openUrl : null;
  const captureFailure = phase?.kind === "failed" ? phase : retryFailure;
  const purpose = draft?.target.kind === "article" ? draft.target.purpose : { kind: "New" } as const;
  const replacement = purpose.kind === "Replacement" ? purpose : null;
  const recovery = purpose.kind === "Recovery" ? purpose : null;
  const showRecoveryPicker = draft?.target.kind === "article" && draft.target.webChoice;
  // a draft's purpose cannot change while it sends, so neither does its press
  const pressCaption = replacement !== null ? "replace article" : recovery !== null ? "finish import" : "import";
  const recaptureFailure = draft?.needsRecapture || captureFailure?.recovery === "Recapture";
  const retrying = retryFailure !== null;
  const kindLabel =
    draft === null
      ? ""
      : draft.target.kind === "article"
        ? "article"
        : draft.target.documentKind === "unknown"
          ? "document"
          : draft.target.documentKind;

  const sourceLine: Line | null = draft !== null ? null : state.unsupported === null
    ? { fact: "nothing here to import." }
    : { fact: state.checkingFailed ? "couldn’t check this page." : "this page can’t be imported.", reason: state.unsupported };
  const revocationLine = state.revocationFailure === null ? null
    : failureLine(state.revocationFailure, "couldn’t disconnect from nexus.");
  const captureLine: Line | null = captureFailure === null ? null
    : captureFailure.recovery === "Check"
      ? { fact: "not sure that imported.", reason: "it may have gone through." }
      : failureLine(captureFailure.failure, captureFailure.recovery === "Review" ? undefined : "couldn’t import this.");
  const statusLine = phase === null || STATUS[phase.kind] === "" ? null
    : { fact: phase.kind === "saved" && phase.openUrl === null ? "removed since" : STATUS[phase.kind] };
  const accountLine = draft?.needsRecapture && account !== null && phase?.kind !== "failed"
    ? { fact: "the account changed since this page was read." } : null;
  const replacementLine = replacement !== null && phase?.kind !== "saved"
    ? { fact: "this replaces the imported article.", reason: replacement.title ?? undefined } : null;
  // one popup speaker; the fact controls stay mounted when their sentence changes.
  const spoken: Line | null = notice ?? revocationLine ?? captureLine ?? accountLine ?? statusLine ?? sourceLine ?? replacementLine;

  return (
    <main className={styles.popup} ref={frame} tabIndex={-1}>
      <Announcement text={spoken === null ? "" : spoken.reason ? `${spoken.fact} ${spoken.reason}` : spoken.fact} level="Polite" />
      {draft !== null ? (
        <header className={styles.source}>
          <span className={styles.kind}>{kindLabel}</span>
          <h1 className={styles.title}>{draft.target.title}</h1>
          <span className={styles.host}>{draft.target.host}</span>
        </header>
      ) : sourceLine !== null ? (
        <Fact line={sourceLine} verbs={state.checkingFailed ? [{ label: "retry", commandKey: "check page", run: () => sendWithOrigins({ kind: "retry_checking" }) }] : undefined} />
      ) : null}

      {revocationLine !== null ? (
        <Fact line={revocationLine} verbs={[{ label: "retry", commandKey: "disconnect", run: () => sendWithOrigins({ kind: "disconnect" }) }]} />
      ) : account === null ? (
        <div className={styles.account}>
          <span>not signed in</span>
          <Button
            emphasis="strong"
            onClick={() => sendWithOrigins({ kind: "login" })}
          >
            sign in
          </Button>
        </div>
      ) : (
        <div className={styles.account}>
          <span className={styles.accountName}>
            {account.displayName ?? account.email ?? account.userId}
          </span>
        </div>
      )}

      {draft !== null && showRecoveryPicker ? <RecoveryPicker
        key={`recovery:${account?.userId}:${draft.id}`} draft={draft} accountId={account?.userId ?? null} enabled={connected && draft.editable && !saving}
        onSet={candidate => post({ kind: "set_recovery_target", candidate })} /> : null}
      {draft !== null && recovery === null ? (
        <Destinations
          context={JSON.stringify([account?.userId ?? null, draft.id])}
          key={`destinations:${account?.userId ?? "signed-out"}:${draft.id}`}
          chosen={chosen}
          confirmed={draft.destinations}
          enabled={connected && draft.editable && !saving}
          reviewing={phase?.kind === "review"}
          onSet={(destination, included) => post({ kind: "set_destination", destination, included })}
        />
      ) : null}

      {draft?.target.kind === "article" && draft.target.previewText !== "" ? (
        <details className={styles.preview} open={recovery !== null || undefined}>
          <summary>preview</summary>
          <p className={styles.previewText}>{draft.target.previewText}</p>
        </details>
      ) : null}

      {replacementLine !== null ? <Fact line={replacementLine} /> : null}

      {recovery !== null && phase?.kind !== "saved" ? <section className={styles.destinations}>
        <p>finish “{recovery.candidate.summary.title}”</p>
        <p>{recovery.candidate.summary.source_label} · {new Date(recovery.candidate.summary.accepted_at).toLocaleDateString()}</p>
        {recovery.candidate.binding.source_relation === "AlternativeCopy" ? <p>this page has a different address; its text will finish “{recovery.candidate.summary.title}”.</p> : null}
      </section> : null}
      {notice !== null ? <Fact line={notice} verbs={[{ label: "dismiss", commandKey: "dismiss notice", run: () => setNotice(null) }]} /> : null}

      {captureFailure && captureLine ? (
        <Fact line={captureLine} verbs={
          captureFailure.recovery === "Check"
            ? account !== null && !draft?.needsRecapture
              ? [{ label: "retry", commandKey: `retry:${draft?.id}`, run: () => sendWithOrigins({ kind: "retry" }), busy: retrying },
                  { label: "discard", commandKey: `stop checking:${draft?.id}`, run: () => send({ kind: "stop_checking" }), disabledReason: retrying ? "a retry is running" : undefined }]
              : [{ label: "discard", commandKey: `stop checking:${draft?.id}`, run: () => send({ kind: "stop_checking" }) }]
            : recaptureFailure && account !== null
            ? [{ label: "start over", commandKey: `recapture:${draft?.id}`, run: () => send({ kind: "capture_again" }) },
                { label: "discard", commandKey: `discard:${draft?.id}`, run: () => send({ kind: "discard" }) }]
            : captureFailure.recovery === "Review" && account !== null
            ? [{ label: "review", commandKey: `review:${draft?.id}`, run: () => sendWithOrigins({ kind: "review" }), busy: retrying },
                { label: "discard", commandKey: `discard:${draft?.id}`, run: () => send({ kind: "discard" }), disabledReason: retrying ? "a review is running" : undefined }]
            : captureFailure.recovery === "Retry" && account !== null
            ? [{ label: "retry", commandKey: `retry:${draft?.id}`, run: () => sendWithOrigins({ kind: "retry" }), busy: retrying },
                { label: "discard", commandKey: `discard:${draft?.id}`, run: () => send({ kind: "discard" }), disabledReason: retrying ? "a retry is running" : undefined }]
            : [{ label: "discard", commandKey: `discard:${draft?.id}`, run: () => send({ kind: "discard" }) }]
        } />
      ) : null}

      {statusLine !== null ? <Fact line={statusLine} /> : null}

      {draft === null ||
      phase === null ||
      phase.kind === "failed" ? null : phase.kind === "saved" ? (
        <>
          {openUrl !== null ? <ButtonLink href={openUrl} target="_blank" rel="noopener noreferrer" emphasis="strong" className={styles.primary}>
            open
          </ButtonLink> : null}
          <Button onClick={() => send({ kind: "capture_again" })}>
            start over
          </Button>
        </>
      ) : accountLine !== null ? (
        <>
          <Fact line={accountLine} />
          <Button emphasis="strong" className={styles.primary} onClick={() => send({ kind: "capture_again" })}>start over</Button>
        </>
      ) : (
        <>
          {phase.kind === "draft" && state.requiredOrigins.length > 0 ? (
            <p className={styles.fine}>
              {`firefox will ask for access to ${state.requiredOrigins.map(patternHost).join(", ")}.`}
            </p>
          ) : null}
          <p className={styles.fine}>
            {`importing sends ${draft.target.kind === "article" ? "this page’s text and full address" : "this file and its full address"}, access parameters included, to nexus.`}
          </p>
          <Button
            emphasis="strong" className={styles.primary}
            disabled={account === null || !connected || saving || selectingRecovery || (draft.target.kind === "article" && draft.target.webMatch === "Ambiguous" && recovery === null) || (phase.kind !== "draft" && phase.kind !== "review")}
            onClick={() => sendWithOrigins({ kind: "save" })}
            aria-busy={phase.kind !== "draft" && phase.kind !== "review"}
          >
            {pressCaption}
          </Button>
        </>
      )}

      {(draft !== null && (phase?.kind === "draft" || phase?.kind === "review")) || account !== null ? (
        <div className={styles.secondary}>
          {draft !== null && (phase?.kind === "draft" || phase?.kind === "review") ? (
            <Button
              onClick={() => send({ kind: "discard" })}
            >
              discard
            </Button>
          ) : null}
          {account !== null ? (
            <Button
              onClick={() => sendWithOrigins({ kind: "disconnect" })}
            >
              disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}


function RecoveryPicker({ draft, accountId, enabled, onSet }: {
  draft: NonNullable<ViewState["draft"]>; accountId: string | null; enabled: boolean;
  onSet: (candidate: Schema<"RecoveryCandidate"> | null) => boolean;
}) {
  const [items, setItems] = useState<Schema<"RecoveryCandidate">[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const serial = useRef(0);
  const target = draft.target.kind === "article" ? draft.target : null;
  const selected = target?.purpose.kind === "Recovery" ? target.purpose.candidate : null;
  const load = (query: string, next: string | null) => {
    if (accountId === null) return;
    const request = ++serial.current;
    setLoading(true);
    void command({ kind: "list_recovery_targets", draftId: draft.id, accountId, q: query, cursor: next }).then(result => {
      if (request !== serial.current) return;
      setLoading(false);
      if (result.kind === "recovery_targets") {
        setItems(previous => next === null ? result.page.items : [...previous, ...result.page.items]);
        setCursor(result.page.next_cursor); setFailed(false);
      } else if (result.kind === "failure" || result.kind === "unreachable") setFailed(true);
    });
  };
  const choices = selected !== null && !items.some(item => item.binding.target.media_id === selected.binding.target.media_id) ? [selected, ...items] : items;
  return <section className={styles.destinations}>
    <p>{target?.webMatch === "Ambiguous" ? "choose which import this finishes" : "finish an earlier import…"}</p>
    <ChoicePicker label="import to finish" value={selected?.binding.target.media_id ?? null} disabled={!enabled}
      onOpen={() => load(q, null)} onChange={id => { const item = choices.find(candidate => candidate.binding.target.media_id === id); if (item) onSet(item); }}
      options={choices.map(item => ({ id: item.binding.target.media_id, label: item.summary.title,
        detail: `${item.summary.source_label} · ${new Date(item.summary.accepted_at).toLocaleDateString()}`, unavailable_reason: null }))}
      footer={<><input aria-label="search imports to finish" value={q} onChange={event => { setQ(event.target.value); load(event.target.value, null); }} />
        {failed ? <Button onClick={() => load(q, null)}>retry</Button> : null}
        {cursor !== null ? <Button disabled={loading} onClick={() => load(q, cursor)}>load more</Button> : null}</>} />
    {selected !== null && target?.webMatch === "None" ? <Button disabled={!enabled} onClick={() => onSet(null)}>as new</Button> : null}
  </section>;
}

/** Firefox owns Escape for its native popup. Opening this inline chooser owns
    input focus; its complete catalog is read once per opening and matched locally. */
function Destinations({
  context,
  chosen,
  confirmed,
  enabled,
  reviewing,
  onSet,
}: {
  context: string;
  chosen: LibraryDestination[];
  confirmed: LibraryDestination[];
  enabled: boolean;
  reviewing: boolean;
  onSet: (destination: LibraryDestination, included: boolean) => boolean;
}) {
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useCollectionLayout(regionRef, open);
  const [catalog, setCatalog] = useState<LibraryDestination[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Line | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (reviewing && enabled) setOpen(true);
  }, [reviewing, enabled]);
  useEffect(() => {
    if (open) regionRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    void command({ kind: "list_destinations" }).then(result => {
      if (disposed) return;
      setLoading(false);
      if (result.kind === "destinations") {
        setCatalog(result.snapshot.destinations);
        setFailure(null);
      } else {
        const reason = replyNotice(result);
        setFailure({ fact: "couldn’t load libraries.", reason: reason?.fact });
      }
    });
    return () => { disposed = true; };
  }, [open, retry]);

  const available = new Map(catalog?.map(destination => [destination.id, destination]) ?? []);
  const all = new Map(available);
  for (const destination of [...confirmed, ...chosen]) {
    if (!all.has(destination.id)) all.set(destination.id, destination);
  }
  const selected = new Set(chosen.map(destination => destination.id));
  const accepted = new Set(confirmed.map(destination => destination.id));
  const rows: ChooserRow[] = [...all.values()].map(destination => {
    const included = selected.has(destination.id);
    const settled = accepted.has(destination.id);
    const missing = catalog !== null && !available.has(destination.id);
    const desired = !missing && !included;
    return {
      id: destination.id, name: destination.name,
      confirmed: { included: Number(settled), total: 1 },
      intended: { included: Number(included), total: 1 },
      progress: "Settled",
      note: missing ? "unavailable" : undefined,
      action: enabled ? { kind: "Set", included: desired, label: desired ? "choose destination" : "remove destination" }
        : { kind: "Blocked", reason: "this can’t change while it sends" },
    };
  });
  return (
    <section className={styles.destinations}>
      <DestinationTrigger label="into" accessibleLabel="import into" emptyLabel="All"
        chosen={chosen} expanded={open} disabled={!enabled} onToggle={() => setOpen(!open)}
        controls={{ kind: "region", id: regionId }} />
      {open ? <div id={regionId} ref={regionRef} className={styles.chooser} data-collection-body>
        {failure !== null ? <Fact line={failure} speak verbs={[{ label: "retry", commandKey: `libraries:${context}`, run: () => setRetry(value => value + 1), busy: loading }]} /> : null}
        <LibraryChooser context={context} membershipKind="Chosen" rows={rows} loading={loading} create={null}
          summary={null}
          error={null}
          empty={failure === null ? "no libraries you can file to" : ""}
          onToggle={({ id, included }) => {
            const destination = all.get(id);
            return destination !== undefined && enabled && onSet(destination, included);
          }} />
      </div> : null}
      <p className={styles.fine}>members of these libraries can read it.</p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RenderEnvironmentProvider value={{
      androidShell: false,
      platform: /Mac|iPhone|iPad/u.test(navigator.platform) ? "mac" : /Win/u.test(navigator.platform) ? "windows" : /Linux/u.test(navigator.platform) ? "linux" : "other",
      displayLocale: navigator.language,
      displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      currentInstant: new Date().toISOString(),
      navCollapsed: false,
    }}>
      <MobileViewportProvider><FeedbackProvider><Popup /></FeedbackProvider></MobileViewportProvider>
    </RenderEnvironmentProvider>
  </StrictMode>,
);
