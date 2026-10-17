"use client";

// The anonymous reader for `/s#share=<token>`: the share's title, source and
// quote over the whole shared document, read-only, opened at the shared
// highlight. Another `#share=` hash opens in place; any other hash change (an
// in-document link) leaves the reading alone.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  readResponse,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { Contents } from "@/lib/documentReader/chrome/Contents";
import DocumentReaderView, {
  useDocumentReader,
  useReaderState,
  type Decorations,
  type Mark,
} from "@/lib/documentReader/DocumentReader";
import type { ReaderTarget } from "@/lib/documentReader/model";
import { isAbortError } from "@/lib/errors";
import { publicFetch, publicSource } from "./publicSource";
import styles from "./publicShare.module.css";

type Share = Schema<"PublicShareOut">;
type State =
  | "Resolving"
  | "Unavailable"
  | { readonly failure: FeedbackContent }
  | { readonly token: string; readonly share: Share };

const TOKEN = /^#share=(nxshr1_[A-Za-z0-9_-]{43})$/;
const PUBLIC_PROFILE: Schema<"ReaderProfileOut"> = {
  theme: "light",
  font_family: "serif",
  font_size_px: 18,
  line_height: 1.6,
  column_width_ch: 68,
  focus_mode: "off",
  hyphenation: "auto",
};

export default function PublicShareReader() {
  const [state, setState] = useState<State>("Resolving");
  const [attempt, setAttempt] = useState(0);
  const status = useRef<HTMLElement>(null);

  useEffect(() => {
    let controller = new AbortController();
    const resolve = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const token = TOKEN.exec(window.location.hash)?.[1];
      setState(token ? "Resolving" : "Unavailable");
      if (!token) return;
      try {
        const body = await readResponse<
          ApiJson<"/public/resource-share", "get">
        >(await publicFetch("", token, signal));
        if (!signal.aborted) setState({ token, share: body.data });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // Only the server's masked 404 means the link is dead.
        if (!isApiError(error) || error.status === 404) setState("Unavailable");
        else {
          const title = "This shared reading couldn’t be opened";
          setState({
            failure: apiTransportFeedback(error, title) ?? {
              tone: "Danger",
              title,
              message: "Something went wrong. Try again.",
              requestId: error.requestId,
            },
          });
        }
      }
    };
    void resolve();
    const changed = () => {
      if (window.location.hash.startsWith("#share=")) void resolve();
    };
    window.addEventListener("hashchange", changed);
    return () => {
      controller.abort();
      window.removeEventListener("hashchange", changed);
    };
  }, [attempt]);

  const ready = typeof state === "object" && "share" in state ? state : null;
  const failure =
    typeof state === "object" && "failure" in state ? state.failure : null;
  const title =
    ready?.share.title ??
    (state === "Unavailable" ? "Share unavailable" : "Shared reading");
  return (
    <div className={styles.shell}>
      {/* The route emits no metadata title, so this is the document's only one. */}
      <title>{`${title} · Nexus`}</title>
      {ready ? (
        <SharedDocument
          key={ready.token}
          token={ready.token}
          share={ready.share}
        />
      ) : (
        // The failure notice is its own alert (live regions must not nest);
        // Retry drops it, so focus waits on this region.
        <main
          className={styles.header}
          role={failure ? undefined : "status"}
          ref={status}
          tabIndex={-1}
        >
          <div className={styles.brand}>Nexus</div>
          {state === "Resolving" ? (
            <p>Opening shared reading…</p>
          ) : state === "Unavailable" ? (
            <>
              <h1>Share unavailable</h1>
              <p>This link is invalid, revoked, or no longer readable.</p>
            </>
          ) : failure ? (
            <FeedbackNotice
              content={failure}
              announcement="Assertive"
              actions={[
                {
                  label: "Retry",
                  onClick: () => {
                    status.current?.focus();
                    setAttempt((n) => n + 1);
                  },
                },
              ]}
            />
          ) : null}
        </main>
      )}
    </div>
  );
}

/** The shared highlight as the reader's one mark, addressed by unit ordinal. */
function sharedMark(share: Share): Mark | null {
  if (share.highlight === null) return null;
  const { color, anchor } = share.highlight;
  return {
    id: "shared",
    color,
    anchor:
      anchor.kind === "Text"
        ? {
            kind: "text",
            unit: String(anchor.ordinal),
            start: anchor.start_offset,
            end: anchor.end_offset,
          }
        : { kind: "pdf", page: anchor.page_number, quads: anchor.quads },
  };
}

function SharedDocument({
  token,
  share,
}: {
  readonly token: string;
  readonly share: Share;
}) {
  const highlight = share.highlight;
  const mark = useMemo(() => sharedMark(share), [share]);
  const options = useMemo(() => {
    const target: ReaderTarget | null =
      mark === null
        ? null
        : mark.anchor.kind === "text"
          ? {
              kind: "range",
              unit: mark.anchor.unit,
              start: mark.anchor.start,
              end: mark.anchor.end,
            }
          : { kind: "quads", page: mark.anchor.page, quads: mark.anchor.quads };
    return {
      source: publicSource(token),
      progress: null,
      entry: { fresh: Promise.resolve(target), cold: null },
    };
  }, [mark, token]);
  const reader = useDocumentReader(token, options);
  const identity = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document.doc.identity : null,
  );
  const missed = useReaderState(
    reader,
    (state) => state.restored && state.navigation.failure !== null,
  );
  const epub = useReaderState(
    reader,
    (state) =>
      state.document.status === "ready" &&
      state.document.doc.kind === "text" &&
      state.document.doc.format === "epub",
  );
  const decorations = useMemo<Decorations | undefined>(
    () =>
      identity && mark
        ? {
            identity,
            marks: [mark],
            noteRefs: [],
            focused: mark.id,
            hovered: null,
          }
        : undefined,
    [identity, mark],
  );

  return (
    <>
      <header className={styles.header}>
        <div className={styles.brand}>Nexus</div>
        <h1>{share.title}</h1>
        {share.bylines.length > 0 ? <p>{share.bylines.join(", ")}</p> : null}
        {share.source_url !== null ? (
          <a
            href={share.source_url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            View original source
          </a>
        ) : null}
      </header>
      {highlight ? (
        <aside className={styles.callout} aria-label="Shared highlight">
          <span>Shared highlight</span>
          {highlight.quote !== null ? (
            <blockquote>{highlight.quote}</blockquote>
          ) : (
            <p>The highlighted area is shown in the document below.</p>
          )}
          {missed ? <p role="status">Highlight unavailable.</p> : null}
        </aside>
      ) : null}
      <main
        className={epub ? `${styles.reader} ${styles.epub}` : styles.reader}
      >
        {epub ? <Contents reader={reader} /> : null}
        <DocumentReaderView
          reader={reader}
          profile={PUBLIC_PROFILE}
          isMobile={false}
          decorations={decorations}
        />
      </main>
      <footer className={styles.footer}>
        Read-only shared view. No Nexus account is required.
      </footer>
    </>
  );
}
