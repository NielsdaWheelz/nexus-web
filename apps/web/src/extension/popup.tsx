// The capture popup: one compact form over the background-owned capture.
//
// The background owns every capture fact, credential and network call. The
// popup renders the CaptureViewState the background pushes on the
// "nexus-capture-view" port -- the sole source of view state, because Firefox
// does not order a sendMessage reply against port messages -- and sends
// CaptureCommand messages whose replies it reads only for the catalog or a
// failure. Posted edit deltas remain provisional until their acknowledged
// pushed revision arrives; no accepted edit waits here before being posted.
//
// Import order is load order: the token owner and the packaged font families
// precede every component module, so popup.module.css is emitted last and owns
// every popup-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";

import { StrictMode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import LibraryChooser, { type LibraryChooserAdmission } from "@/components/libraries/LibraryChooser";
import LibraryDestinationTrigger from "@/components/libraries/LibraryDestinationTrigger";
import Button from "@/components/ui/Button";
import {
  VIEW_PORT,
  type CaptureCommand,
  type CaptureConnection,
  type CaptureDraftView,
  type CaptureFailure,
  type CapturePhase,
  type CaptureTargetView,
  type CaptureViewMessage,
  type CaptureViewCommand,
  type CaptureViewState,
  type CommandResult,
} from "@/extension/captureContract";
import { useLibraryDestinationCatalog } from "@/components/libraries/useLibraryDestinationCatalog";
import {
  decodeLibraryDestinationSelection,
  decodeWritableLibraryDestinationCatalog,
  type LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";
import { setLibraryDestination } from "@/lib/libraries/destinationSelection";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectNonemptyString,
  expectNullableString,
  expectOneOf,
  expectPositiveInteger,
  expectRecord,
  expectString,
} from "@/lib/validation";
import styles from "./popup.module.css";

type PostedCommand = { command: CaptureViewCommand; revision: number | null };
type ViewConnection = {
  port: browser.runtime.Port;
  sequence: number;
  revision: number;
  state: CaptureViewState | null;
  posted: PostedCommand[];
};

function Popup() {
  const [state, setState] = useState<CaptureViewState | null>(null);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const connectionRef = useRef<ViewConnection | null>(null);

  function renderView(connection: ViewConnection) {
    for (;;) {
      const first = connection.posted[0];
      if (first === undefined || first.revision === null || first.revision > connection.revision) break;
      connection.posted.shift();
    }
    const current = connection.state;
    if (current?.view.kind !== "draft") {
      setState(current);
      return;
    }
    const draft = current.view.draft;
    let selected = draft.intendedDestinations;
    let saving = false;
    for (const { command } of connection.posted) {
      if (command.draftId !== draft.id) continue;
      if (command.kind === "save") saving = true;
      else selected = setLibraryDestination(selected, command);
    }
    setState({ ...current, view: { kind: "draft", draft: {
      ...draft, intendedDestinations: selected,
      destinationsEditable: draft.destinationsEditable && !saving,
    } } });
  }

  useEffect(() => {
    const port = browser.runtime.connect({ name: VIEW_PORT });
    const connection: ViewConnection = { port, sequence: 0, revision: 0, state: null, posted: [] };
    connectionRef.current = connection;
    port.onMessage.addListener((message: unknown) => {
      if (connectionRef.current !== connection) return;
      try {
        const decoded = decodeViewMessage(message);
        if (decoded.kind === "state") {
          if (decoded.revision <= connection.revision) return;
          connection.revision = decoded.revision;
          connection.state = decoded.state;
        } else {
          const index = connection.posted.findIndex((entry) => entry.command.sequence === decoded.sequence);
          if (index < 0) throw new Error("Background acknowledged an unknown command");
          if (decoded.outcome.kind === "Rejected") {
            connection.posted.splice(index, 1);
            setNotice(failureContent(decoded.outcome.failure));
          } else {
            connection.posted[index].revision = decoded.revision;
          }
        }
        renderView(connection);
      } catch (error) {
        setNotice(failureContent(popupFailure(error)));
      }
    });
    port.onDisconnect.addListener(() => {
      if (connectionRef.current !== connection) return;
      connectionRef.current = null;
      setNotice(failureContent(popupFailure(new Error("Capture connection closed. Reopen the popup."))));
    });
    void command({ kind: "activate" }).then((result) => {
      if (connectionRef.current === connection && result.kind === "failure") setNotice(failureContent(result.failure));
    });
    return () => {
      if (connectionRef.current === connection) connectionRef.current = null;
      port.disconnect();
    };
  }, []);

  function post(sent: Omit<Extract<CaptureViewCommand, { kind: "set_destination" }>, "sequence"> | Omit<Extract<CaptureViewCommand, { kind: "save" }>, "sequence">): LibraryChooserAdmission {
    const connection = connectionRef.current;
    if (connection === null || connection.state?.view.kind !== "draft" || connection.state.view.draft.id !== sent.draftId) return "Rejected";
    if (sent.kind === "set_destination" && (!connection.state.view.draft.destinationsEditable || connection.posted.some((entry) => entry.command.kind === "save"))) return "Rejected";
    if (sent.kind === "save" && (connection.state.view.draft.phase.kind !== "draft" || connection.state.view.draft.resumable)) return "Rejected";
    const command: CaptureViewCommand = { ...sent, sequence: connection.sequence + 1 };
    try {
      connection.port.postMessage(command);
    } catch (error) {
      setNotice(failureContent(popupFailure(error)));
      return "Rejected";
    }
    connection.sequence = command.sequence;
    connection.posted.push({ command, revision: null });
    setNotice(null);
    renderView(connection);
    return "Accepted";
  }

  function send(sent: CaptureCommand) {
    setNotice(null);
    void command(sent).then((result) => {
      if (result.kind === "failure") setNotice(failureContent(result.failure));
    });
  }

  // A command that needs origins is sent first and the grant asked for right
  // after, synchronously, still inside the click: Firefox grants optional
  // origins only there, and its doorhanger may close this popup, so the grant
  // is observed by the background (permissions.onAdded), which waits for it
  // and then continues without us. A denial fires nothing there and keeps
  // the draft; the `false` here is its only notice.
  function sendWithOrigins(sent: Exclude<CaptureCommand, { kind: "activate" | "list_destinations" | "retry_destinations" }> | { kind: "save" }) {
    if (state === null) return;
    const origins = [...state.requiredOrigins];
    const hasDraft = state.view.kind === "draft";
    if (sent.kind === "save") {
      if (state.view.kind !== "draft" || post({ kind: "save", draftId: state.view.draft.id }) === "Rejected") return;
    } else send(sent);
    if (origins.length === 0) return;
    void browser.permissions.request({ origins }).then(
      (granted) => {
        if (granted) return;
        setNotice({
          tone: "Warning",
          title: "Firefox did not allow access",
          message: `Nexus needs access to ${origins.map(patternHost).join(", ")}.${hasDraft ? " Your capture is kept." : ""}`,
        });
      },
      (error: unknown) => setNotice(failureContent(popupFailure(error))),
    );
  }

  if (state === null) {
    return (
      <main className={styles.popup} aria-busy="true">
        {notice !== null ? (
          <FeedbackNotice content={notice} announcement="Assertive" />
        ) : (
          <div role="status" className={styles.status}>
            Loading…
          </div>
        )}
      </main>
    );
  }

  const { connection, view, requiredOrigins } = state;
  const draft = view.kind === "draft" ? view.draft : null;
  const phase = draft?.phase ?? null;
  const connected = connection.kind === "connected";
  const settled = phase?.kind === "saved" || phase?.kind === "failed";
  // A frozen (resumable) draft is discarded through nexus by its bound
  // account, so signed out the popup offers sign-in and no Discard.
  const discardable = draft !== null && (connected || !draft.resumable);
  // An unsubmitted draft is cleared locally; a frozen one is discarded through
  // nexus, so its click asks for the origins as Resume does. A failed draft
  // may be either (the view does not say), so it asks: the one spare prompt
  // is a failed acquisition discarded after a manual revocation.
  const discard = () =>
    phase?.kind === "draft" || phase?.kind === "acquiring"
      ? send({ kind: "discard" })
      : sendWithOrigins({ kind: "discard" });

  return (
    <main className={styles.popup}>
      {draft !== null ? (
        <header className={styles.source}>
          <span className={styles.kind}>{targetKindLabel(draft.target)}</span>
          <h1 className={styles.title}>{draft.target.title}</h1>
          <span className={styles.host}>{draft.target.host}</span>
        </header>
      ) : view.kind === "unsupported" ? (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "This page can’t be saved", message: view.reason }}
          announcement="Polite"
        />
      ) : (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Open a web page, PDF or EPUB to save it" }}
          announcement="Polite"
        />
      )}

      {connection.kind === "signed_out" ? (
        <div className={styles.account}>
          <span>Not signed in</span>
          <Button variant="secondary" size="sm" onClick={() => sendWithOrigins({ kind: "login" })}>
            Sign in to Nexus
          </Button>
        </div>
      ) : connection.kind === "connected" ? (
        <div className={styles.account}>
          <span className={styles.accountName}>
            {connection.account.displayName ??
              connection.account.email ??
              connection.account.userHandle}
          </span>
        </div>
      ) : (
        <FeedbackNotice
          content={failureContent(connection.failure, "Couldn’t disconnect from Nexus")}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: () => sendWithOrigins({ kind: "disconnect" }) }]}
        />
      )}

      {draft !== null ? (
        <Destinations
          key={draft.id}
          draft={draft}
          accountStamp={connection.kind === "connected" ? connection.account.userHandle : connection.kind}
          onCommit={(destination, included) => post({ kind: "set_destination", draftId: draft.id, destination, included })}
          onRetry={() => send({ kind: "retry_destinations" })}
        />
      ) : null}

      {draft?.target.kind === "article" && draft.target.previewText !== "" ? (
        <details className={styles.preview}>
          <summary>Preview text</summary>
          <p className={styles.previewText}>{draft.target.previewText}</p>
        </details>
      ) : null}

      {notice !== null ? (
        <FeedbackNotice
          content={notice}
          announcement="Assertive"
          actions={[{ label: "Dismiss", onClick: () => setNotice(null) }]}
        />
      ) : null}

      {draft !== null && draft.phase.kind === "failed" ? (
        <FeedbackNotice
          content={failureContent(draft.phase.failure, "Couldn’t save")}
          announcement="Assertive"
          actions={
            draft.phase.retryable && !draft.resumable && connected
              ? [
                  { label: "Retry", onClick: () => sendWithOrigins({ kind: "retry" }) },
                  { label: "Discard", onClick: discard },
                ]
              : discardable
                ? [{ label: "Discard", onClick: discard }]
                : undefined
          }
        />
      ) : null}

      <div role="status" className={styles.status}>
        {phase === null ? "" : phaseStatus(phase)}
      </div>

      {/* A frozen draft resumes after a restart, or after discard/disconnect
          aborted its work, even one that had failed: resume is the only
          command the background accepts for it. */}
      {draft === null || phase === null ? null : draft.resumable ? (
        <Button className={styles.primary} disabled={!connected} onClick={() => sendWithOrigins({ kind: "resume" })}>
          Resume
        </Button>
      ) : phase.kind === "failed" ? null : phase.kind === "saved" ? (
        <Button className={styles.primary} onClick={() => void browser.tabs.create({ url: phase.openUrl })}>
          Open in Nexus
        </Button>
      ) : (
        <>
          {phase.kind === "draft" && requiredOrigins.length > 0 ? (
            <p className={styles.fine}>
              Firefox will ask to allow access to {requiredOrigins.map(patternHost).join(", ")}.
            </p>
          ) : null}
          <p className={styles.fine}>
            Saving sends this {draft.target.kind === "article" ? "page’s text" : "file"} and its
            full address, including any access parameters in it, to Nexus.
          </p>
          <Button
            className={styles.primary}
            loading={phase.kind !== "draft"}
            disabled={!connected}
            onClick={() => sendWithOrigins({ kind: "save" })}
          >
            {draft.target.kind === "document" ? "Save PDF or EPUB" : "Save"}
          </Button>
        </>
      )}

      {(discardable && !settled) || connected ? (
        <div className={styles.secondary}>
          {discardable && !settled ? (
            <Button variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
          ) : null}
          {connected ? (
            <Button variant="ghost" size="sm" onClick={() => sendWithOrigins({ kind: "disconnect" })}>
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/** The inline draft adapter. The background owns accepted deltas and storage;
    this surface owns disclosure and the shared chooser owns query/focus. */
function Destinations({
  draft,
  accountStamp,
  onCommit,
  onRetry,
}: {
  draft: CaptureDraftView;
  accountStamp: string;
  onCommit: (destination: LibraryDestinationSelection, included: boolean) => LibraryChooserAdmission;
  onRetry: () => void;
}) {
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const read = useCallback(async () => {
    const result = await command({ kind: "list_destinations" });
    if (result.kind === "failure") return result;
    if (result.kind === "catalog") return { kind: "catalog" as const, destinations: result.catalog.data };
    return { kind: "failure" as const, failure: popupFailure(new Error("library list answered without a catalog")) };
  }, []);
  const catalog = useLibraryDestinationCatalog<CaptureFailure>({
    active: open,
    changeStamp: accountStamp,
    read,
  });
  const enabled = draft.destinationsEditable;
  const selected = draft.intendedDestinations;

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  useEffect(() => {
    if (open) regionRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [open]);

  const availableIds = new Set(catalog.destinations?.map((destination) => destination.id));
  const destinations = catalog.destinations === null ? [] : [
    ...catalog.destinations,
    ...selected.filter((destination) => !availableIds.has(destination.id)),
  ];
  const confirmedIds = new Set(draft.destinations.map((destination) => destination.id));
  const intendedIds = new Set(selected.map((destination) => destination.id));

  return (
    <section className={styles.destinations}>
      {/* Firefox owns Escape for a browser-action popup, before content sees it. */}
      <LibraryDestinationTrigger
        label="libraries"
        accessibleLabel="libraries"
        emptyLabel="none"
        selected={selected}
        expanded={open}
        disabled={!enabled}
        onToggle={() => setOpen(!open)}
        discloses={{ kind: "region", id: regionId }}
      />
      {open ? (
        <div id={regionId} ref={regionRef} className={styles.chooser}>
          <LibraryChooser
            items={destinations.map((destination) => {
              const confirmed = confirmedIds.has(destination.id);
              const intended = intendedIds.has(destination.id);
              return {
                ...destination,
                confirmed: { included: confirmed ? 1 : 0, total: 1 },
                intended: { included: intended ? 1 : 0, total: 1 },
                progress: confirmed === intended ? "Settled" : "Pending",
                exclusions: [],
                provenance: [],
                note: availableIds.has(destination.id) ? undefined : "unavailable",
                action: { kind: "Set", included: !intended, targetCount: 1 },
              };
            })}
            onCommit={({ choiceId, included }) => {
              const destination = destinations.find((entry) => entry.id === choiceId);
              return destination === undefined ? "Rejected" : onCommit(destination, included);
            }}
            loading={catalog.loading}
            summary={`selected libraries: ${selected.length === 0 ? "none" : selected.map((destination) => destination.name).join(", ")}`}
            emptyInventory="no libraries yet"
            error={catalog.failure === null ? null : { content: failureContent(catalog.failure), onRetry: catalog.retry }}
            creation={null}
          />
        </div>
      ) : null}
      {draft.destinationFailure !== null ? (
        <FeedbackNotice
          content={failureContent(draft.destinationFailure, "couldn’t store library choices")}
          announcement="Assertive"
          actions={[{ label: "retry", onClick: onRetry }]}
        />
      ) : null}
      <p className={styles.fine}>Members of selected libraries can read this item.</p>
    </section>
  );
}

/** A command that cannot reach the background, or whose reply breaks the
    contract, answers as a failure like any other: the popup never guesses. */
async function command(sent: CaptureCommand): Promise<CommandResult | { kind: "failure"; failure: CaptureFailure }> {
  try {
    return decodeCommandResult(await browser.runtime.sendMessage(sent));
  } catch (error) {
    return { kind: "failure", failure: popupFailure(error) };
  }
}

function popupFailure(error: unknown): CaptureFailure {
  return {
    code: "E_CAPTURE_POPUP",
    message: `Nexus capture stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    requestId: null,
  };
}

function targetKindLabel(target: CaptureTargetView): string {
  if (target.kind === "article") return "Article";
  if (target.documentKind === "pdf") return "PDF";
  if (target.documentKind === "epub") return "EPUB";
  return "Document";
}

function phaseStatus(phase: CapturePhase): string {
  switch (phase.kind) {
    case "draft":
    case "failed":
      return "";
    case "acquiring":
      return "Reading the source…";
    case "prepared":
    case "transferring":
      return "Uploading…";
    case "confirming":
      return "Saving…";
    case "saved":
      return "Saved.";
  }
}

function failureContent(failure: CaptureFailure, title?: string): FeedbackContent {
  return {
    tone: "Danger",
    title: title ?? failure.message,
    message: title === undefined ? undefined : failure.message,
    requestId: failure.requestId ?? undefined,
  };
}

/** "https://nexus.example/*" → "nexus.example" */
function patternHost(pattern: string): string {
  return /^[a-z]+:\/\/([^/]+)\//.exec(pattern)?.[1] ?? pattern;
}

// Strict decoders for the background → popup boundary: unknown keys or
// variants are contract failures; the destination page reuses its one decoder.

function decodeViewMessage(raw: unknown): CaptureViewMessage {
  const kind = expectOneOf(expectRecord(raw, "view message").kind, ["state", "acknowledgement"], "view message.kind");
  if (kind === "acknowledgement") {
    const message = expectExactRecord(raw, ["kind", "sequence", "revision", "outcome"], "acknowledgement");
    const outcome = expectOneOf(expectRecord(message.outcome, "outcome").kind, ["Accepted", "Rejected"], "outcome.kind");
    const result = expectExactRecord(message.outcome, outcome === "Accepted" ? ["kind"] : ["kind", "failure"], "outcome");
    return {
      kind,
      sequence: expectPositiveInteger(message.sequence, "acknowledgement.sequence"),
      revision: expectPositiveInteger(message.revision, "acknowledgement.revision"),
      outcome: outcome === "Accepted" ? { kind: outcome } : { kind: outcome, failure: decodeFailure(result.failure, "outcome.failure") },
    };
  }
  const push = expectExactRecord(raw, ["kind", "revision", "state"], "view message");
  return {
    kind,
    revision: expectPositiveInteger(push.revision, "view message.revision"),
    state: decodeViewState(push.state),
  };
}

function decodeCommandResult(raw: unknown): CommandResult {
  const kind = expectOneOf(
    expectRecord(raw, "command result").kind,
    ["state", "catalog", "failure"],
    "command result.kind",
  );
  switch (kind) {
    case "state": {
      const result = expectExactRecord(raw, ["kind", "state"], "command result");
      return { kind, state: decodeViewState(result.state) };
    }
    case "catalog": {
      const result = expectExactRecord(raw, ["kind", "state", "catalog"], "command result");
      return {
        kind,
        state: decodeViewState(result.state),
        catalog: decodeWritableLibraryDestinationCatalog(result.catalog),
      };
    }
    case "failure": {
      const result = expectExactRecord(raw, ["kind", "failure", "state"], "command result");
      return {
        kind,
        failure: decodeFailure(result.failure, "command result.failure"),
        state: decodeViewState(result.state),
      };
    }
  }
}

function decodeViewState(raw: unknown): CaptureViewState {
  const state = expectExactRecord(raw, ["connection", "requiredOrigins", "view"], "state");
  return {
    connection: decodeConnection(state.connection),
    requiredOrigins: expectArray(
      state.requiredOrigins,
      (value, index) => expectNonemptyString(value, `state.requiredOrigins[${index}]`),
      "state.requiredOrigins",
    ),
    view: decodeView(state.view),
  };
}

function decodeConnection(raw: unknown): CaptureConnection {
  const kind = expectOneOf(
    expectRecord(raw, "connection").kind,
    ["signed_out", "connected", "revocation_failed"],
    "connection.kind",
  );
  switch (kind) {
    case "signed_out":
      expectExactRecord(raw, ["kind"], "connection");
      return { kind };
    case "connected": {
      const connection = expectExactRecord(raw, ["kind", "account"], "connection");
      const account = expectExactRecord(
        connection.account,
        ["userHandle", "email", "displayName"],
        "connection.account",
      );
      return {
        kind,
        account: {
          userHandle: expectNonemptyString(account.userHandle, "account.userHandle"),
          email: expectNullableString(account.email, "account.email"),
          displayName: expectNullableString(account.displayName, "account.displayName"),
        },
      };
    }
    case "revocation_failed": {
      const connection = expectExactRecord(raw, ["kind", "failure"], "connection");
      return { kind, failure: decodeFailure(connection.failure, "connection.failure") };
    }
  }
}

function decodeView(raw: unknown): CaptureViewState["view"] {
  const kind = expectOneOf(
    expectRecord(raw, "view").kind,
    ["empty", "unsupported", "draft"],
    "view.kind",
  );
  switch (kind) {
    case "empty":
      expectExactRecord(raw, ["kind"], "view");
      return { kind };
    case "unsupported": {
      const view = expectExactRecord(raw, ["kind", "reason"], "view");
      return { kind, reason: expectNonemptyString(view.reason, "view.reason") };
    }
    case "draft": {
      const view = expectExactRecord(raw, ["kind", "draft"], "view");
      return { kind, draft: decodeDraft(view.draft) };
    }
  }
}

function decodeDraft(raw: unknown): CaptureDraftView {
  const draft = expectExactRecord(raw, ["id", "target", "phase", "destinations", "intendedDestinations", "destinationsEditable", "destinationFailure", "resumable"], "draft");
  return {
    id: expectNonemptyString(draft.id, "draft.id"),
    target: decodeTarget(draft.target),
    phase: decodePhase(draft.phase),
    destinations: expectArray(
      draft.destinations,
      (value, index) => decodeLibraryDestinationSelection(value, `draft.destinations[${index}]`),
      "draft.destinations",
    ),
    intendedDestinations: expectArray(
      draft.intendedDestinations,
      (value, index) => decodeLibraryDestinationSelection(value, `draft.intendedDestinations[${index}]`),
      "draft.intendedDestinations",
    ),
    destinationsEditable: expectBoolean(draft.destinationsEditable, "draft.destinationsEditable"),
    destinationFailure: draft.destinationFailure === null ? null : decodeFailure(draft.destinationFailure, "draft.destinationFailure"),
    resumable: expectBoolean(draft.resumable, "draft.resumable"),
  };
}

function decodeTarget(raw: unknown): CaptureTargetView {
  const kind = expectOneOf(expectRecord(raw, "target").kind, ["article", "document"], "target.kind");
  if (kind === "article") {
    const target = expectExactRecord(raw, ["kind", "title", "host", "previewText"], "target");
    return {
      kind,
      title: expectNonemptyString(target.title, "target.title"),
      host: expectString(target.host, "target.host"),
      previewText: expectString(target.previewText, "target.previewText"),
    };
  }
  const target = expectExactRecord(raw, ["kind", "title", "host", "documentKind"], "target");
  return {
    kind,
    title: expectNonemptyString(target.title, "target.title"),
    host: expectString(target.host, "target.host"),
    documentKind: expectOneOf(target.documentKind, ["unknown", "pdf", "epub"], "target.documentKind"),
  };
}

function decodePhase(raw: unknown): CapturePhase {
  const kind = expectOneOf(
    expectRecord(raw, "phase").kind,
    ["draft", "acquiring", "prepared", "transferring", "confirming", "saved", "failed"],
    "phase.kind",
  );
  switch (kind) {
    case "draft":
    case "acquiring":
    case "prepared":
    case "transferring":
    case "confirming":
      expectExactRecord(raw, ["kind"], "phase");
      return { kind };
    case "saved": {
      const phase = expectExactRecord(raw, ["kind", "mediaId", "openUrl"], "phase");
      return {
        kind,
        mediaId: expectNonemptyString(phase.mediaId, "phase.mediaId"),
        openUrl: expectNonemptyString(phase.openUrl, "phase.openUrl"),
      };
    }
    case "failed": {
      const phase = expectExactRecord(raw, ["kind", "failure", "retryable"], "phase");
      return {
        kind,
        failure: decodeFailure(phase.failure, "phase.failure"),
        retryable: expectBoolean(phase.retryable, "phase.retryable"),
      };
    }
  }
}

function decodeFailure(raw: unknown, name: string): CaptureFailure {
  const failure = expectExactRecord(raw, ["code", "message", "requestId"], name);
  return {
    code: expectNonemptyString(failure.code, `${name}.code`),
    message: expectNonemptyString(failure.message, `${name}.message`),
    requestId: expectNullableString(failure.requestId, `${name}.requestId`),
  };
}

const root = document.getElementById("root");
if (root === null) throw new Error("Popup root is missing");

createRoot(root).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
