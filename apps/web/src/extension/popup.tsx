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

import { StrictMode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider, Hold, useOutcome } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { StageAnchor } from "@/components/feedback/Slips";
import { sentence, type CommandVerb, type Line, type Shell, type Verbs } from "@/components/feedback/stage";
import { DestinationTrigger } from "@/components/libraries/DestinationChooser";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import Button from "@/components/ui/Button";
import ChoicePicker from "@/components/ui/ChoicePicker";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { ApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
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
import { isCaptureDefect } from "@/extension/nexusClient";
import styles from "./popup.module.css";

type LibraryDestination = Schema<"LibraryDestinationOut">;

/** A background that cannot be reached answers like any failure: the popup never guesses. */
async function command(sent: Command): Promise<CommandResult> {
  try {
    return (await browser.runtime.sendMessage(sent)) as CommandResult;
  } catch (error) {
    console.error("Capture background could not be reached:", error);
    const message = "nexus capture isn’t answering. reopen this popup.";
    return {
      kind: "failure",
      failure: { code: "E_CAPTURE_POPUP", message, requestId: null, status: null, offline: false },
    };
  }
}

/** The popup's one sign-in, wherever it shows: the account row's press, which asks firefox for
 * the origins login waits on and says a failed login. One value, so a slip's verb outlives the
 * render that raised it; the popup binds it to its latest state. */
const signIn = { current: () => {} };
const SIGN_IN: CommandVerb = { label: "sign in", commandKey: "CaptureSignIn", run: () => signIn.current() };
const SHELL: Shell = { signIn: SIGN_IN };
/** Refusals that a sign-in answers carry it. */
const SIGN_IN_CODES = new Set(["E_UNAUTHENTICATED", "E_CAPTURE_SIGNED_OUT", "E_CAPTURE_LOGIN", "E_CAPTURE_LOGIN_STATE"]);

/** Why a save asks for a new capture, by the code that asked. A superseded upload has no truer fact
 * than the save's own. */
const RECAPTURE: Partial<Record<string, string>> = {
  E_CAPTURE_TARGET_CHANGED: "this import changed since capture.",
  E_UPLOAD_CAPABILITY_EXPIRED: "this upload expired.",
  E_STORAGE_MISSING: "the uploaded file isn’t available.",
};

/** "https://nexus.example/*" -> "nexus.example" */
const patternHost = (pattern: string) =>
  /^[a-z]+:\/\/([^/]+)\//.exec(pattern)?.[1] ?? pattern;

function Popup() {
  const [state, setState] = useState<ViewState | null>(null);
  const { say } = useOutcome();
  const [stopped, setStopped] = useState<CaptureFailure | null>(null);
  const tell = useCallback((failure: CaptureFailure) => {
    if (isCaptureDefect(failure.code)) setStopped(failure);
    else say({ fact: failure.message }, SIGN_IN_CODES.has(failure.code) ? [SIGN_IN] : undefined);
  }, [say]);
  const [disconnected, setDisconnected] = useState(false);
  const [retryFailure, setRetryFailure] = useState<Extract<CapturePhase, { kind: "failed" }> | null>(null);
  const submittedSaveCaption = useRef<{ scope: string; label: string } | null>(null);
  const [pending, setPending] = useState<ViewCommand[]>([]);
  const [connected, setConnected] = useState(false);
  const connection = useRef<{
    port: browser.runtime.Port;
    sequence: number;
    pending: ViewCommand[];
  } | null>(null);

  const send = (sent: Command) => {
    setRetryFailure((sent.kind === "retry" || sent.kind === "review") && state?.draft?.phase.kind === "failed" ? state.draft.phase : null);
    void command(sent).then((result) => {
      if (result.kind === "failure") {
        tell(result.failure);
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
      if (message.failure !== null) tell(message.failure);
    });
    port.onDisconnect.addListener(() => {
      if (connection.current !== current) return;
      connection.current = null;
      setPending([]);
      setConnected(false);
      setRetryFailure(null);
      setDisconnected(true);
    });
    void command({ kind: "activate" }).then((result) => {
      if (connection.current !== current) return;
      if (result.kind === "failure") tell(result.failure);
    });
    return () => {
      if (connection.current === current) connection.current = null;
      port.disconnect();
    };
    // `say`, and so `tell`, is one value for the stage's life, so the port connects once.
  }, [tell]);

  const post = (action: { kind: "set_destination"; destination: LibraryDestination; included: boolean } | { kind: "set_recovery_target"; candidate: Schema<"RecoveryCandidate"> | null } | { kind: "save" }): boolean => {
    const current = connection.current;
    if (current === null || state === null || state.draft === null || state.account === null) return false;
    const sent: ViewCommand = { ...action, sequence: ++current.sequence, draftId: state.draft.id, accountId: state.account.userId };
    try {
      current.port.postMessage(sent);
    } catch {
      setDisconnected(true);
      return false;
    }
    current.pending = [...current.pending, sent];
    setPending(current.pending);
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
      submittedSaveCaption.current = { scope: JSON.stringify([state.account?.userId ?? null, state.draft?.id ?? null]), label: saveCaption };
    } else send(sent);
    if (origins.length === 0) return;
    void browser.permissions.request({ origins }).then(
      (granted) => {
        if (granted) return;
        setRetryFailure(null);
        const fact = `firefox didn’t allow access to ${origins.map(patternHost).join(", ")}.`;
        // The background keeps the draft whatever firefox answered.
        say(state.draft ? { fact, reason: "your capture is kept." } : { fact });
      },
      (error: unknown) => {
        console.error("Capture permission request failed:", error);
        setRetryFailure(null);
        say({ fact: "firefox didn’t allow access to this source." });
      },
    );
  };

  useLayoutEffect(() => { signIn.current = () => sendWithOrigins({ kind: "login" }); });
  // Each failure onset counts, a failed retry's too: it speaks again while its fact and verbs stand.
  const failedNow = state?.draft?.phase.kind === "failed";
  const [failures, setFailures] = useState({ failed: false, attempt: 0, occurrence: {} });
  if (failedNow !== failures.failed) setFailures(failedNow ? { failed: true, attempt: failures.attempt + 1, occurrence: {} } : { ...failures, failed: false });

  const disconnection = disconnected ? <Hold id="capture-disconnected" line={{ fact: "capture disconnected.", reason: "reopen this popup to continue." }} /> : null;
  if (stopped !== null) return <main className={styles.popup} tabIndex={-1}><div className={styles.body}><Fact line={{ fact: stopped.message }} speak /></div></main>;
  if (state === null) return <main className={styles.popup} tabIndex={-1}><StageAnchor kind="Root" />{disconnection}<div className={styles.body}><Ruling /></div></main>;

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
  const busySave = phase !== null && phase.kind !== "draft" && phase.kind !== "review";
  const captionScope = JSON.stringify([account?.userId ?? null, draft?.id ?? null]);
  const saveCaption = (saving || busySave) && submittedSaveCaption.current?.scope === captionScope ? submittedSaveCaption.current.label
    : phase?.kind === "review" ? "save" : draft?.target.kind === "document" ? "Save PDF or EPUB" : replacement !== null ? "replace saved article" : recovery !== null ? "finish import" : "Save";
  const recaptureFailure = draft?.needsRecapture || captureFailure?.recovery === "Recapture";
  const retrying = retryFailure !== null;
  const kindLabel =
    draft === null
      ? ""
      : draft.target.kind === "article"
        ? "Article"
        : draft.target.documentKind === "unknown"
          ? "Document"
          : draft.target.documentKind.toUpperCase();

  return (
    <main className={styles.popup} tabIndex={-1}>
      <StageAnchor kind="Root" />
      {disconnection}
      <div className={styles.body}>
      {draft !== null ? (
        <header className={styles.source}>
          <span className={styles.kind}>{kindLabel}</span>
          <h1 className={styles.title}>{draft.target.title}</h1>
          <span className={styles.host}>{draft.target.host}</span>
        </header>
      ) : (
        state.checkingFailed ? <Fact line={{ fact: "couldn’t check this page." }} verbs={[{ label: "retry", commandKey: "RetryChecking", run: () => sendWithOrigins({ kind: "retry_checking" }) }]} />
          : state.unsupported !== null ? <Fact line={{ fact: "this page can’t be saved.", reason: state.unsupported }} />
          : <Fact line={{ fact: "open a web page, pdf or epub to save it." }} />
      )}

      {state.revocationFailure !== null ? (
        // Revocation keeps the credential until nexus confirms it.
        <Hold id="capture-revocation" attempt={state.revocationFailure.attempt} line={state.revocationFailure.kind === "Unknown" ? { fact: "not sure disconnection finished.", reason: UNKNOWN_OUTCOME_REASON } : { fact: "couldn’t disconnect from nexus." }}
          verbs={[{ label: "retry", commandKey: "RetryDisconnect", run: () => sendWithOrigins({ kind: "disconnect" }) }]} />
      ) : null}
      {account === null ? (
        state.revocationFailure === null ? <Fact line={{ fact: "not signed in." }} verbs={[SIGN_IN]} /> : null
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
          needsReview={captureFailure?.recovery === "Review"}
          onSet={(destination, included) => post({ kind: "set_destination", destination, included })}
        />
      ) : null}

      {draft?.target.kind === "article" && draft.target.previewText !== "" ? (
        <details className={styles.preview} open={recovery !== null || undefined}>
          <summary>Preview text</summary>
          <p className={styles.previewText}>{draft.target.previewText}</p>
        </details>
      ) : null}

      {replacement !== null && phase?.kind !== "saved" ? (
        <Fact line={{ fact: replacement.title === null ? "this capture replaces a saved article." : `this capture replaces the saved article “${replacement.title}”.` }} />
      ) : null}

      {recovery !== null && phase?.kind !== "saved" ? <section className={styles.destinations}>
        <p>finish “{recovery.candidate.summary.title}”</p>
        <p>{recovery.candidate.summary.source_label} · {new Date(recovery.candidate.summary.accepted_at).toLocaleDateString()}</p>
        {recovery.candidate.binding.source_relation === "AlternativeCopy" ? <p>this page has a different address. use its captured text to finish “{recovery.candidate.summary.title}”.</p> : null}
      </section> : null}
      {captureFailure ? <CaptureFailureFact failure={captureFailure} onset={failures} account={account !== null} recapture={recaptureFailure} retrying={retrying}
        send={send} sendWithOrigins={sendWithOrigins} /> : null}

      {draft === null ||
      phase === null ||
      phase.kind === "failed" ? null : phase.kind === "saved" ? (
        <>
          {openUrl === null ? <Fact line={{ fact: "saved, then removed." }} speak />
            : <Fact line={{ fact: recovery !== null ? "import finished." : replacement !== null ? "saved article replaced." : "saved to nexus." }} speak
              verbs={[{ label: recovery !== null ? "view import" : "open in nexus", href: openUrl, target: "_blank" }]} />}
          <Button onClick={() => send({ kind: "capture_again" })}>
            capture again
          </Button>
        </>
      ) : draft.needsRecapture && account !== null ? (
        <>
          <Fact line={{ fact: "the account changed since this capture." }} />
          <Button emphasis="strong" className={styles.primary} onClick={() => send({ kind: "capture_again" })}>capture again</Button>
        </>
      ) : (
        <>
          {phase.kind === "draft" && state.requiredOrigins.length > 0 ? (
            <p className={styles.fine}>
              Firefox will ask to allow access to{" "}
              {state.requiredOrigins.map(patternHost).join(", ")}.
            </p>
          ) : null}
          <p className={styles.fine}>
            Saving sends this{" "}
            {draft.target.kind === "article" ? "page’s text" : "file"} and its
            full address, including any access parameters in it, to Nexus.
          </p>
          <Button
            emphasis="strong" className={styles.primary}
            disabled={account === null || !connected || saving || selectingRecovery || (draft.target.kind === "article" && draft.target.webMatch === "Ambiguous" && recovery === null) || (phase.kind !== "draft" && phase.kind !== "review")}
            onClick={() => sendWithOrigins({ kind: "save" })}
            aria-busy={phase.kind !== "draft" && phase.kind !== "review"}
          >
            {saveCaption}
          </Button>
        </>
      )}

      {(draft !== null && (phase?.kind === "draft" || phase?.kind === "review")) || account !== null ? (
        <div className={styles.secondary}>
          {draft !== null && (phase?.kind === "draft" || phase?.kind === "review") ? (
            <Button
              onClick={() => send({ kind: "discard" })}
            >
              discard capture
            </Button>
          ) : null}
          {account !== null ? (
            <Button
              onClick={() => sendWithOrigins({ kind: "disconnect" })}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
      </div>
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
  const [error, setError] = useState<CaptureFailure | null>(null);
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
        setCursor(result.page.next_cursor); setError(null);
      } else if (result.kind === "failure") {
        // justify-ignore-error: the background publishes host defects to Popup's stopped owner.
        if (!isCaptureDefect(result.failure.code)) setError(result.failure);
      }
    });
  };
  const choices = selected !== null && !items.some(item => item.binding.target.media_id === selected.binding.target.media_id) ? [selected, ...items] : items;
  return <section className={styles.destinations}>
    <p>{target?.webMatch === "Ambiguous" ? "choose the failed import to finish" : "finish a failed import…"}</p>
    <ChoicePicker label="failed import" value={selected?.binding.target.media_id ?? null} disabled={!enabled}
      onOpen={() => load(q, null)} onChange={id => { const item = choices.find(candidate => candidate.binding.target.media_id === id); if (item) onSet(item); }}
      options={choices.map(item => ({ id: item.binding.target.media_id, label: item.summary.title,
        detail: `${item.summary.source_label} · ${new Date(item.summary.accepted_at).toLocaleDateString()}`, unavailable_reason: null }))}
      footer={<><input aria-label="search failed imports" value={q} onChange={event => { setQ(event.target.value); load(event.target.value, null); }} />
        {error ? <Fact line={{ fact: "couldn’t load unfinished imports.", reason: error.message }} verbs={[{ label: "retry", commandKey: "RetryRecoveryTargets", busy: loading, run: () => load(q, null) }]} /> : null}
        {cursor !== null ? <Button disabled={loading} aria-busy={loading || undefined} onClick={() => load(q, cursor)}>load more</Button> : null}</>} />
    {selected !== null && target?.webMatch === "None" ? <Button disabled={!enabled} onClick={() => onSet(null)}>save as new</Button> : null}
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
  needsReview,
  onSet,
}: {
  context: string;
  chosen: LibraryDestination[];
  confirmed: LibraryDestination[];
  enabled: boolean;
  reviewing: boolean;
  needsReview: boolean;
  onSet: (destination: LibraryDestination, included: boolean) => boolean;
}) {
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useCollectionLayout(regionRef, open);
  const [catalog, setCatalog] = useState<LibraryDestination[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<CaptureFailure | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
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
      }
      else if (result.kind === "failure") {
        // justify-ignore-error: the background publishes host defects to Popup's stopped owner.
        if (!isCaptureDefect(result.failure.code)) setFailure(result.failure);
      }
      else setDefect({ error: new Error(`libraries answered ${result.kind}, not a catalog`) });
    });
    return () => { disposed = true; };
  }, [open, retry]);

  if (defect) throw defect.error;
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
      note: missing ? "unavailable" : needsReview ? "needs review" : undefined,
      action: enabled ? { kind: "Set", included: desired, label: desired ? "choose destination" : "remove destination" }
        : { kind: "Blocked", reason: "this capture can’t change now." },
    };
  });
  return (
    <section className={styles.destinations}>
      <DestinationTrigger label="Libraries" accessibleLabel="Libraries" emptyLabel="No additional libraries"
        chosen={chosen} expanded={open} disabled={!enabled} onToggle={() => setOpen(!open)}
        controls={{ kind: "region", id: regionId }} />
      {open ? <div id={regionId} ref={regionRef} className={styles.chooser} data-collection-body>
        <LibraryChooser context={context} membershipKind="Chosen" rows={rows} loading={loading} create={null}
          summary={null}
          failure={failure === null ? null : <Failed error={new ApiError(failure.status ?? 0, failure.code, failure.message, { requestId: failure.requestId ?? undefined, offline: failure.offline })} noun="libraries" retry={{ run: () => setRetry(value => value + 1), busy: loading }} />}
          empty="no libraries you can add to"
          onToggle={({ id, included }) => {
            const destination = all.get(id);
            return destination !== undefined && enabled && onSet(destination, included);
          }} />
      </div> : null}
      <p className={styles.fine}>Members of selected libraries can read this item.</p>
    </section>
  );
}

/** A failed save, by what can recover it. An unknown outcome holds; `retry` resends, `forget` drops
 * the local draft. A recapture or review names why; the others say the transport's reason. A failed
 * retry speaks its onset again, while its fact and the verb under the hand stand where they were. */
function CaptureFailureFact({ failure, onset, account, recapture, retrying, send, sendWithOrigins }: {
  failure: Extract<CapturePhase, { kind: "failed" }>; onset: { attempt: number; occurrence: object }; account: boolean; recapture: boolean; retrying: boolean;
  send(command: Command): void; sendWithOrigins(command: Command): void;
}) {
  const verb = (label: string, run: () => void, busy = false): CommandVerb => ({ label, commandKey: `Capture.${label}`, run, busy });
  const discard = verb("discard", () => send({ kind: "discard" }));
  if (failure.failure.code === "E_WIRE_MISMATCH") {
    if (failure.recovery === "Check") return <Hold id="capture-unconfirmed" attempt={onset.attempt}
      line={{ fact: "not sure that saved.", reason: failure.failure.message }} />;
    return <Fact line={{ fact: failure.failure.message }} speak />;
  }
  if (failure.recovery === "Check") {
    const forget = verb("forget", () => send({ kind: "stop_checking" }));
    return <Hold id="capture-unconfirmed" attempt={onset.attempt} line={{ fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }}
      verbs={account ? [verb("retry", () => sendWithOrigins({ kind: "retry" }), retrying), forget] : [forget]} />;
  }
  const said = (line: Line, verbs: Verbs) => <>
    <Fact line={line} verbs={verbs} />
    <Announcement text={sentence(line)} level="Polite" occurrence={onset.occurrence} />
  </>;
  // `needsRecapture` without a recapture code is the account's change.
  if (recapture && account) return said({ fact: failure.recovery === "Recapture" ? RECAPTURE[failure.failure.code] ?? "couldn’t save this capture." : "the account changed since this capture.",
    reason: "capture the page again." }, [verb("capture again", () => send({ kind: "capture_again" })), discard]);
  if (failure.recovery === "Review" && account) return said({ fact: "couldn’t save.", reason: "your save needs review." },
    [verb("review", () => sendWithOrigins({ kind: "review" }), retrying), discard]);
  return said({ fact: "couldn’t save this capture.", reason: failure.failure.message },
    failure.recovery === "Retry" && account ? [verb("retry", () => sendWithOrigins({ kind: "retry" }), retrying), discard] : [discard]);
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
      <MobileViewportProvider><FeedbackProvider shell={SHELL}><Popup /></FeedbackProvider></MobileViewportProvider>
    </RenderEnvironmentProvider>
  </StrictMode>,
);
