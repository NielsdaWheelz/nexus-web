// The capture popup: one compact form over the background's capture. It renders
// the ViewState pushed on its port (Firefox does not order a sendMessage reply
// against port messages, so the push is the only state) and sends Commands,
// reading replies only for a destination page or a failure. It owns nothing
// but presentation: the open chooser and the notice of its last command.
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
import DestinationChooser, {
  DestinationTrigger,
  type DestinationSource,
} from "@/components/libraries/DestinationChooser";
import Button from "@/components/ui/Button";
import type { LibraryDestination } from "@/lib/libraries/api";
import {
  VIEW_PORT,
  type CaptureFailure,
  type CapturePhase,
  type Command,
  type CommandResult,
  type ViewState,
} from "@/extension/capture";
import styles from "./popup.module.css";

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

  const send = (sent: Command) => {
    setNotice(null);
    setRetryFailure(sent.kind === "retry" && state?.draft?.phase.kind === "failed" ? state.draft.phase : null);
    void command(sent).then((result) => {
      if (result.kind === "failure") {
        setNotice(failureContent(result.failure));
        setRetryFailure(null);
      }
    });
  };

  useEffect(() => {
    const port = browser.runtime.connect({ name: VIEW_PORT });
    port.onMessage.addListener((message) => {
      const next = message as ViewState;
      setState(next);
      const phase = next.draft?.phase.kind;
      if (phase !== "acquiring" && phase !== "uploading" && phase !== "confirming") setRetryFailure(null);
    });
    void command({ kind: "activate" }).then((result) => {
      if (result.kind === "failure") setNotice(failureContent(result.failure));
    });
    return () => port.disconnect();
  }, []);

  // Firefox grants optional origins only inside the click, and its doorhanger may
  // close this popup, so the command goes first and the background waits for the
  // grant (permissions.onAdded); a denial fires nothing there, so this is its notice.
  const sendWithOrigins = (sent: Command) => {
    if (state === null) return;
    const origins = state.requiredOrigins;
    send(sent);
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
  const phase = draft?.phase ?? null;
  const captureFailure = phase?.kind === "failed" ? phase : retryFailure;
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
          chosen={draft.destinations}
          enabled={account !== null && !draft.locked}
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

      {captureFailure ? (
        <FeedbackNotice
          content={failureContent(captureFailure.failure, "capture not saved")}
          announcement="Assertive"
          returnFocus={() => frame.current}
          actions={
            captureFailure.retryable && account !== null
              ? [
                  {
                    label: "Retry",
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

      {phase !== null && STATUS[phase.kind] !== "" ? <FeedbackStatus content={{ tone: "Neutral", title: STATUS[phase.kind] }} announcement="Polite" /> : null}

      {draft === null ||
      phase === null ||
      phase.kind === "failed" ? null : phase.kind === "saved" ? (
        <Button
          className={styles.primary}
          onClick={() => void browser.tabs.create({ url: phase.openUrl })}
        >
          Open in Nexus
        </Button>
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
            loading={phase.kind !== "draft"}
            disabled={account === null}
            onClick={() => sendWithOrigins({ kind: "save" })}
          >
            {draft.target.kind === "document" ? "Save PDF or EPUB" : "Save"}
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

/** Destination pages through the background (sendMessage cannot be aborted; the
    chooser drops a superseded reply). */
const BACKGROUND_DESTINATIONS: DestinationSource = {
  search: async (q, cursor) => {
    const result = await command({ kind: "search_destinations", q, cursor });
    if (result.kind === "page") return result.page;
    throw result.kind === "failure"
      ? result.failure
      : new Error("search answered without a page");
  },
  // justify-type-assertion: the background search rejects only with a CaptureFailure
  describe: (error) => failureContent(error as CaptureFailure),
};

/** The libraries trigger and its inline chooser. A toggle sends the whole next
    selection; the chooser is busy until the next push (each arrives as a fresh
    array) or the command fails. It closes through its trigger only: Firefox
    closes a browser-action popup on Escape before any key event reaches this
    document. */
function Destinations({
  chosen,
  enabled,
  onFailure,
}: {
  chosen: LibraryDestination[];
  enabled: boolean;
  onFailure: (failure: CaptureFailure) => void;
}) {
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [sentFrom, setSentFrom] = useState<LibraryDestination[] | null>(null);
  // a chooser that loses its enablement closes for good: it never reopens unasked
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => {
    if (open)
      regionRef.current
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus();
  }, [open]);

  const change = (destinations: readonly LibraryDestination[]) => {
    setSentFrom(chosen);
    void command({
      kind: "set_destinations",
      destinations: [...destinations],
    }).then((result) => {
      if (result.kind !== "failure") return;
      setSentFrom(null);
      onFailure(result.failure);
    });
  };

  return (
    <section className={styles.destinations}>
      <DestinationTrigger
        label="Libraries"
        accessibleLabel="Libraries"
        emptyLabel="No additional libraries"
        chosen={chosen}
        expanded={open}
        disabled={!enabled}
        onToggle={() => setOpen(!open)}
        controls={{ kind: "region", id: regionId }}
      />
      {open ? (
        <div id={regionId} ref={regionRef} className={styles.chooser}>
          <DestinationChooser
            chosen={chosen}
            onChange={change}
            source={BACKGROUND_DESTINATIONS}
            onCreate={null}
            disabled={sentFrom === chosen}
            emptyLabel="No other libraries you can add to."
          />
        </div>
      ) : null}
      <p className={styles.fine}>
        Members of selected libraries can read this item.
      </p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
