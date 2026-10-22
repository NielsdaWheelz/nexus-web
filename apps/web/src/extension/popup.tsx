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
import {
  FeedbackNotice,
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { DestinationTrigger } from "@/components/libraries/DestinationChooser";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import Button from "@/components/ui/Button";
import type { Schema } from "@/lib/api/wire";
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

/** A background that cannot be reached answers like any failure: the popup never guesses. */
async function command(sent: Command): Promise<CommandResult> {
  try {
    return (await browser.runtime.sendMessage(sent)) as CommandResult;
  } catch (error) {
    console.error("Capture background could not be reached:", error);
    const message = "nexus capture couldn’t be reached. reopen the popup to try again.";
    return {
      kind: "failure",
      failure: { code: "E_CAPTURE_POPUP", message, requestId: null },
    };
  }
}

function failureContent(
  failure: CaptureFailure,
  title?: string,
): FeedbackContent {
  return {
    tone: "Danger",
    title: title ?? failure.message,
    message: title === undefined ? undefined : failure.message,
    requestId: failure.requestId ?? undefined,
  };
}

const STATUS: Record<CapturePhase["kind"], string> = {
  draft: "",
  review: "",
  failed: "",
  acquiring: "Reading the source…",
  uploading: "Uploading…",
  confirming: "Saving…",
  saved: "added to nexus",
};

/** "https://nexus.example/*" -> "nexus.example" */
const patternHost = (pattern: string) =>
  /^[a-z]+:\/\/([^/]+)\//.exec(pattern)?.[1] ?? pattern;

function Popup() {
  const [state, setState] = useState<ViewState | null>(null);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [retryFailure, setRetryFailure] = useState<Extract<CapturePhase, { kind: "failed" }> | null>(null);
  const frame = useRef<HTMLElement>(null);
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
      if (result.kind === "failure") {
        setNotice(failureContent(result.failure));
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
      if (message.failure !== null) setNotice(failureContent(message.failure));
    });
    port.onDisconnect.addListener(() => {
      if (connection.current !== current) return;
      connection.current = null;
      setPending([]);
      setConnected(false);
      setRetryFailure(null);
      setNotice({ tone: "Danger", title: "Capture disconnected", message: "Close and reopen the popup to read the capture." });
    });
    void command({ kind: "activate" }).then((result) => {
      if (connection.current !== current) return;
      if (result.kind === "failure") setNotice(failureContent(result.failure));
    });
    return () => {
      if (connection.current === current) connection.current = null;
      port.disconnect();
    };
  }, []);

  const post = (action: { kind: "set_destination"; destination: LibraryDestination; included: boolean } | { kind: "save" }): boolean => {
    const current = connection.current;
    if (current === null || state === null || state.draft === null || state.account === null) return false;
    const sent: ViewCommand = { ...action, sequence: ++current.sequence, draftId: state.draft.id, accountId: state.account.userId };
    try {
      current.port.postMessage(sent);
    } catch (error) {
      setNotice({ tone: "Danger", title: "Capture disconnected", message: String(error) });
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
        const kept = state.draft ? " Your capture is kept." : "";
        setNotice({
          tone: "Warning",
          title: "Firefox did not allow access",
          message: `Nexus needs access to ${origins.map(patternHost).join(", ")}.${kept}`,
        });
      },
      (error: unknown) => {
        console.error("Capture permission request failed:", error);
        setRetryFailure(null);
        setNotice({ tone: "Warning", title: "source access not granted", message: "try again to request access to this source." });
      },
    );
  };

  if (state === null) {
    return (
      <main className={styles.popup} aria-busy="true">
        {notice ? (
          <FeedbackNotice content={notice} announcement="Assertive" />
        ) : (
          <FeedbackStatus content={{ tone: "Neutral", title: "opening capture…" }} announcement="Polite" />
        )}
      </main>
    );
  }

  const { account, draft } = state;
  const chosen = pending.reduce((destinations, edit) => edit.kind === "set_destination" && edit.draftId === draft?.id && edit.accountId === account?.userId
    ? setDestination(destinations, edit) : destinations, draft?.destinations ?? []);
  const saving = pending.some(edit => edit.kind === "save");
  const phase = draft?.phase ?? null;
  const openUrl = phase?.kind === "saved" ? phase.openUrl : null;
  const captureFailure = phase?.kind === "failed" ? phase : retryFailure;
  const replacement = draft?.target.kind === "article" ? draft.target.replacement : null;
  const recaptureFailure = draft?.needsRecapture || captureFailure?.recovery === "Recapture";
  const retrying = retryFailure !== null;
  const settled = phase?.kind === "saved" || phase?.kind === "failed";
  const kindLabel =
    draft === null
      ? ""
      : draft.target.kind === "article"
        ? "Article"
        : draft.target.documentKind === "unknown"
          ? "Document"
          : draft.target.documentKind.toUpperCase();

  return (
    <main className={styles.popup} ref={frame} tabIndex={-1}>
      {draft !== null ? (
        <header className={styles.source}>
          <span className={styles.kind}>{kindLabel}</span>
          <h1 className={styles.title}>{draft.target.title}</h1>
          <span className={styles.host}>{draft.target.host}</span>
        </header>
      ) : (
        <FeedbackNotice
          content={
            state.unsupported !== null
              ? {
                  tone: "Neutral",
                  title: "This page can’t be saved",
                  message: state.unsupported,
                }
              : {
                  tone: "Neutral",
                  title: "Open a web page, PDF or EPUB to save it",
                }
          }
          announcement="Polite"
        />
      )}

      {state.revocationFailure !== null ? (
        <FeedbackNotice
          content={failureContent(
            state.revocationFailure,
            "Couldn’t disconnect from Nexus",
          )}
          announcement="Assertive"
          actions={[
            {
              label: "Retry",
              onClick: () => sendWithOrigins({ kind: "disconnect" }),
            },
          ]}
        />
      ) : account === null ? (
        <div className={styles.account}>
          <span>Not signed in</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => sendWithOrigins({ kind: "login" })}
          >
            Sign in to Nexus
          </Button>
        </div>
      ) : (
        <div className={styles.account}>
          <span className={styles.accountName}>
            {account.displayName ?? account.email ?? account.userId}
          </span>
        </div>
      )}

      {draft !== null ? (
        <Destinations
          key={`${account?.userId ?? "signed-out"}:${draft.id}`}
          chosen={chosen}
          confirmed={draft.destinations}
          enabled={connected && draft.editable && !saving}
          reviewing={phase?.kind === "review"}
          needsReview={captureFailure?.recovery === "Review"}
          onSet={(destination, included) => post({ kind: "set_destination", destination, included })}
        />
      ) : null}

      {draft?.target.kind === "article" && draft.target.previewText !== "" ? (
        <details className={styles.preview}>
          <summary>Preview text</summary>
          <p className={styles.previewText}>{draft.target.previewText}</p>
        </details>
      ) : null}

      {replacement !== null && phase?.kind !== "saved" ? (
        <FeedbackNotice content={{ tone: "Neutral", title: "this capture will replace the saved article",
          message: replacement.title ?? undefined }} announcement="Polite" />
      ) : null}

      {notice !== null ? (
        <FeedbackNotice
          content={notice}
          announcement="Assertive"
          actions={[{ label: "Dismiss", onClick: () => setNotice(null) }]}
        />
      ) : null}

      {captureFailure ? (
        <FeedbackNotice
          content={failureContent(captureFailure.failure,
            captureFailure.recovery === "Check" ? "save not confirmed"
              : captureFailure.recovery === "Review" ? "save needs review" : "capture not saved")}
          announcement="Assertive"
          returnFocus={() => frame.current}
          actions={
            recaptureFailure && account !== null
              ? [{ label: "capture again", onClick: () => send({ kind: "capture_again" }) },
                  { label: "discard", onClick: () => send({ kind: "discard" }) }]
              : captureFailure.recovery === "Review" && account !== null
              ? [{ label: "review and save", onClick: () => sendWithOrigins({ kind: "review" }), busy: retrying },
                  { label: "discard", onClick: () => send({ kind: "discard" }), disabledReason: retrying ? "save is being reviewed" : undefined }]
              : (captureFailure.recovery === "Retry" || captureFailure.recovery === "Check") && account !== null
              ? [
                  {
                    label: captureFailure.recovery === "Check" ? "check save" : "retry",
                    onClick: () => sendWithOrigins({ kind: "retry" }),
                    busy: retrying,
                  },
                  {
                    label: "Discard",
                    onClick: () => send({ kind: "discard" }),
                    disabledReason: retrying ? "capture is being retried" : undefined,
                  },
                ]
              : [{ label: "Discard", onClick: () => send({ kind: "discard" }) }]
          }
        />
      ) : null}

      {phase !== null && STATUS[phase.kind] !== "" ? <FeedbackStatus content={{ tone: "Neutral", title: phase.kind === "saved"
        ? phase.openUrl === null ? "this item is no longer available" : replacement !== null ? "replacement submitted" : STATUS.saved
        : STATUS[phase.kind] }} announcement="Polite" /> : null}

      {draft === null ||
      phase === null ||
      phase.kind === "failed" ? null : phase.kind === "saved" ? (
        <>
          {openUrl !== null ? <Button className={styles.primary} onClick={() => void browser.tabs.create({ url: openUrl })}>
            Open in Nexus
          </Button> : null}
          <Button variant="secondary" onClick={() => send({ kind: "capture_again" })}>
            capture again
          </Button>
        </>
      ) : draft.needsRecapture && account !== null ? (
        <>
          <FeedbackNotice content={{ tone: "Neutral", title: "capture again for this account",
            message: "check the current saved article before uploading this page." }} announcement="Polite" />
          <Button className={styles.primary} onClick={() => send({ kind: "capture_again" })}>capture again</Button>
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
            className={styles.primary}
            loading={phase.kind !== "draft" && phase.kind !== "review"}
            disabled={account === null || !connected || saving}
            onClick={() => sendWithOrigins({ kind: "save" })}
          >
            {phase.kind === "review" ? "save" : draft.target.kind === "document" ? "Save PDF or EPUB" : replacement !== null ? "replace saved article" : "Save"}
          </Button>
        </>
      )}

      {(draft !== null && !settled) || account !== null ? (
        <div className={styles.secondary}>
          {draft !== null && !settled ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => send({ kind: "discard" })}
            >
              Discard
            </Button>
          ) : null}
          {account !== null ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sendWithOrigins({ kind: "disconnect" })}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/** Firefox owns Escape for its native popup. Opening this inline chooser owns
    input focus; its complete catalog is read once per opening and matched locally. */
function Destinations({
  chosen,
  confirmed,
  enabled,
  reviewing,
  needsReview,
  onSet,
}: {
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
  const [catalog, setCatalog] = useState<LibraryDestination[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<CaptureFailure | null>(null);
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
      else setFailure(result.kind === "failure" ? result.failure : {
        code: "E_CAPTURE_DEFECT", message: "Libraries answered without a catalog.", requestId: null,
      });
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
      progress: settled === included ? "Settled" : "Pending",
      note: missing ? "unavailable" : needsReview ? "needs review" : undefined,
      action: enabled ? { kind: "Set", included: desired, label: desired ? "add" : "remove" }
        : { kind: "Blocked", reason: "this capture cannot be changed now" },
    };
  });
  return (
    <section className={styles.destinations}>
      <DestinationTrigger label="Libraries" accessibleLabel="Libraries" emptyLabel="No additional libraries"
        chosen={chosen} expanded={open} disabled={!enabled} onToggle={() => setOpen(!open)}
        controls={{ kind: "region", id: regionId }} />
      {open ? <div id={regionId} ref={regionRef} className={styles.chooser}>
        <LibraryChooser rows={rows} loading={loading} create={null}
          summary={`selected libraries: ${chosen.map(destination => destination.name).join(", ") || "none"}`}
          error={failure === null ? null : { content: failureContent(failure), retry: () => setRetry(value => value + 1), busy: loading }}
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
