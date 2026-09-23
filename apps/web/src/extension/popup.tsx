// The capture popup: one compact form over the background-owned capture.
//
// The background owns every capture fact, credential and network call. The
// popup renders the CaptureViewState the background pushes on the
// "nexus-capture-view" port -- the sole source of view state, because Firefox
// does not order a sendMessage reply against port messages -- and sends
// CaptureCommand messages whose replies it reads only for a destination page
// or a failure. It owns nothing but presentation: the open chooser, its search
// results, and the notice of its last command.
//
// Import order is load order: the token owner and the packaged font families
// precede every component module, so popup.module.css is emitted last and owns
// every popup-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";

import { StrictMode, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import LibraryChooser from "@/components/libraries/LibraryChooser";
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
  type CaptureViewState,
  type CommandResult,
} from "@/extension/captureContract";
import { useLibraryDestinationSearch } from "@/components/libraries/useLibraryDestinationSearch";
import {
  decodeLibraryDestinationSelection,
  decodeWritableLibraryDestinationPage,
  type LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectNonemptyString,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import styles from "./popup.module.css";

function Popup() {
  const [state, setState] = useState<CaptureViewState | null>(null);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: VIEW_PORT });
    port.onMessage.addListener((message: unknown) => {
      try {
        setState(decodeViewMessage(message).state);
      } catch (error) {
        setNotice(failureContent(popupFailure(error)));
      }
    });
    void command({ kind: "activate" }).then((result) => {
      if (result.kind === "failure") setNotice(failureContent(result.failure));
    });
    return () => port.disconnect();
  }, []);

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
  function sendWithOrigins(sent: Exclude<CaptureCommand, { kind: "activate" | "set_destinations" | "search_destinations" }>) {
    if (state === null) return;
    const origins = [...state.requiredOrigins];
    const hasDraft = state.view.kind === "draft";
    send(sent);
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
          selected={draft.destinations}
          enabled={connected && phase?.kind === "draft" && !draft.resumable}
          onFailure={(failure) => setNotice(failureContent(failure))}
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

/**
 * The additional-library trigger and its inline chooser. It runs the shared
 * destination search over the background (sendMessage cannot be aborted; the
 * search's generation drops stale replies) and turns a toggle into the whole
 * next selection for the background. Toggles are serialized: each is computed
 * from the selection the background last pushed, so the chooser stays busy
 * from a toggle until the next pushed selection arrives (every push decodes
 * into a fresh array) or the command fails.
 */
function Destinations({
  selected,
  enabled,
  onFailure,
}: {
  selected: readonly LibraryDestinationSelection[];
  enabled: boolean;
  onFailure: (failure: CaptureFailure) => void;
}) {
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [toggledFrom, setToggledFrom] = useState<
    readonly LibraryDestinationSelection[] | null
  >(null);
  const search = useLibraryDestinationSearch<CaptureFailure>({
    active: open,
    search: ({ q, cursor }) =>
      command({ kind: "search_destinations", q, cursor }).then((result) =>
        result.kind === "state"
          ? { kind: "failure", failure: popupFailure(new Error("search answered without a page")) }
          : result,
      ),
  });

  // A chooser that loses its enablement closes for good: it never reopens
  // unasked. Focus it held is not moved; the trigger is disabled with it.
  useEffect(() => {
    if (enabled) return;
    setOpen(false);
  }, [enabled]);

  useEffect(() => {
    if (open) regionRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [open]);

  function toggle(id: string) {
    const added = search.results.find((destination) => destination.id === id);
    const destinations = selected.some((destination) => destination.id === id)
      ? selected.filter((destination) => destination.id !== id)
      : added === undefined
        ? null
        : [...selected, { id: added.id, name: added.name }];
    if (destinations === null) return;
    setToggledFrom(selected);
    void command({ kind: "set_destinations", destinations }).then((result) => {
      if (result.kind !== "failure") return;
      setToggledFrom(null);
      onFailure(result.failure);
    });
  }

  const selectedIds = new Set(selected.map((destination) => destination.id));
  const others = search.results.filter((destination) => !selectedIds.has(destination.id));
  const count = selected.length + others.length;

  return (
    <section className={styles.destinations}>
      {/* The chooser closes through its trigger only: Firefox closes a
          browser-action popup on Escape at the chrome level, before any key
          event reaches this document. */}
      <LibraryDestinationTrigger
        label="Libraries"
        emptyLabel="No additional libraries"
        selected={selected}
        expanded={open}
        disabled={!enabled}
        onToggle={() => setOpen(!open)}
        discloses={{ kind: "region", id: regionId }}
      />
      {open ? (
        <div id={regionId} ref={regionRef} className={styles.chooser}>
          <LibraryChooser
            query={search.query}
            onQueryChange={search.setQuery}
            searchPlaceholder="Search libraries"
            searchLabel="Search libraries"
            listLabel="Library options"
            selectedGroup={{
              label: "Selected",
              items: selected.map((destination) => ({
                id: destination.id,
                name: destination.name,
                selected: true,
                interaction: { kind: "Enabled" },
              })),
            }}
            otherGroup={{
              label: "Other libraries",
              items: others.map((destination) => ({
                id: destination.id,
                name: destination.name,
                selected: false,
                interaction: { kind: "Enabled" },
              })),
            }}
            onToggle={toggle}
            busy={toggledFrom === selected}
            loading={search.loading}
            status={
              search.loading
                ? "Loading libraries…"
                : search.loadingMore
                  ? "Loading more libraries…"
                  : count === 1
                    ? "1 library"
                    : `${count} libraries`
            }
            emptyState={
              search.loading || count > 0
                ? null
                : search.normalizedQuery === ""
                  ? "No other libraries you can add to."
                  : "No libraries match your search."
            }
            error={
              search.failure === null
                ? null
                : { content: failureContent(search.failure), onRetry: search.retry }
            }
            create={null}
            loadMore={
              search.nextCursor === null
                ? null
                : { pending: search.loadingMore, onLoadMore: search.loadMore }
            }
          />
        </div>
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
  const push = expectExactRecord(raw, ["kind", "state"], "view message");
  return {
    kind: expectOneOf(push.kind, ["state"], "view message.kind"),
    state: decodeViewState(push.state),
  };
}

function decodeCommandResult(raw: unknown): CommandResult {
  const kind = expectOneOf(
    expectRecord(raw, "command result").kind,
    ["state", "page", "failure"],
    "command result.kind",
  );
  switch (kind) {
    case "state": {
      const result = expectExactRecord(raw, ["kind", "state"], "command result");
      return { kind, state: decodeViewState(result.state) };
    }
    case "page": {
      const result = expectExactRecord(raw, ["kind", "state", "page"], "command result");
      return {
        kind,
        state: decodeViewState(result.state),
        page: decodeWritableLibraryDestinationPage(result.page),
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
  const draft = expectExactRecord(raw, ["id", "target", "phase", "destinations", "resumable"], "draft");
  return {
    id: expectNonemptyString(draft.id, "draft.id"),
    target: decodeTarget(draft.target),
    phase: decodePhase(draft.phase),
    destinations: expectArray(
      draft.destinations,
      (value, index) => decodeLibraryDestinationSelection(value, `draft.destinations[${index}]`),
      "draft.destinations",
    ),
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
