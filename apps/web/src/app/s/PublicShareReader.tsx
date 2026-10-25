"use client";

// The anonymous reader for `/s#share=<token>`: the share's title, source and
// quote over the whole shared document, read-only, opened at the shared
// highlight. Another `#share=` hash opens in place; any other hash change (an
// in-document link) leaves the reading alone.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  FeedbackState,
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  readResponse,
} from "@/lib/api/client";
import HtmlRenderer from "@/components/HtmlRenderer";
import Dialog from "@/components/ui/Dialog";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
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
  | { readonly token: string; readonly failure: FeedbackContent; readonly retrying: boolean }
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
  const shell = useRef<HTMLDivElement>(null);
  const reloadedToken = useRef<string | null>(null);
  const contentChanged = useCallback((token: string) => {
    if (reloadedToken.current === token) {
      setState({ token, retrying: false, failure: { tone: "Warning", title: "this piece changed. reload to continue." } });
      return;
    }
    reloadedToken.current = token;
    setState("Resolving");
    setAttempt(value => value + 1);
  }, []);

  useEffect(() => {
    let controller = new AbortController();
    const resolve = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const token = TOKEN.exec(window.location.hash)?.[1];
      setState((current) => token && typeof current === "object" && "failure" in current && current.token === token
        ? { ...current, retrying: true }
        : token ? "Resolving" : "Unavailable");
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
            token,
            retrying: false,
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
    typeof state === "object" && "failure" in state ? state : null;
  const title =
    ready?.share.title ??
    (state === "Unavailable" ? "Share unavailable" : "Shared reading");
  return (
    <div className={styles.shell} ref={shell} tabIndex={-1}>
      {/* The route emits no metadata title, so this is the document's only one. */}
      <title>{`${title} · Nexus`}</title>
      {ready ? (
        <SharedDocument
          key={`${ready.token}:${attempt}`}
          token={ready.token}
          share={ready.share}
          onContentChanged={contentChanged}
        />
      ) : (
        <main
          className={styles.header}
          tabIndex={-1}
        >
          <div className={styles.brand}>Nexus</div>
          {state === "Resolving" ? (
            <FeedbackStatus content={{ tone: "Neutral", title: "opening shared reading…" }} announcement="Polite" />
          ) : state === "Unavailable" ? (
            <FeedbackState content={{ tone: "Neutral", title: "share unavailable", message: "this link is invalid, revoked, or no longer readable." }} announcement="Polite" />
          ) : failure ? (
            <FeedbackNotice
              content={failure.failure}
              announcement="Assertive"
              returnFocus={() => shell.current?.querySelector<HTMLElement>("main") ?? shell.current}
              actions={[
                {
                  label: "retry",
                  busy: failure.retrying,
                  onClick: () => {
                    if (failure.retrying) return;
                    setState({ ...failure, retrying: true });
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
  onContentChanged,
}: {
  readonly token: string;
  readonly share: Share;
  readonly onContentChanged: (token: string) => void;
}) {
  const highlight = share.highlight;
  const changed = useCallback(() => onContentChanged(token), [onContentChanged, token]);
  const [note, setNote] = useState<Schema<"PublicApparatusOut"> | null>(null);
  const [noteFailure, setNoteFailure] = useState<string | null>(null);
  const noteRequest = useRef<AbortController | null>(null);
  useEffect(() => () => noteRequest.current?.abort(), []);
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
      source: publicSource(token, changed),
      progress: null,
      entry: { fresh: Promise.resolve(target), cold: null },
    };
  }, [changed, mark, token]);
  const reader = useDocumentReader(token, options);
  const identity = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document.doc.identity : null,
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

  const openNote = useCallback(async (ordinal: string) => {
    if (identity === null) return;
    noteRequest.current?.abort();
    const controller = new AbortController();
    noteRequest.current = controller;
    setNote(null);
    setNoteFailure(null);
    try {
      const response = await publicFetch(`/apparatus/${ordinal}?expected_identity=${encodeURIComponent(identity)}`,
        token, controller.signal, { "X-Nexus-Wire": String(WIRE_REVISION) });
      if (response.status === 409) { onContentChanged(token); return; }
      const body = await readResponse<ApiJson<"/public/resource-share/apparatus/{ordinal}", "get">>(response);
      if (!controller.signal.aborted) setNote(body.data);
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setNoteFailure("this note couldn’t be opened");
    }
  }, [identity, onContentChanged, token]);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.brand}>Nexus</div>
        <h1>{share.title}</h1>
        {share.bylines.length > 0 ? <p>{share.bylines.join(", ")}</p> : null}
        {share.source_label !== null ? <p>from {share.source_label}</p> : null}
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
          ) : null}
        </aside>
      ) : null}
      <main
        className={epub ? `${styles.reader} ${styles.epub}` : styles.reader}
        tabIndex={-1}
      >
        {epub ? <Contents reader={reader} /> : null}
        <DocumentReaderView
          playback={null}
          reader={reader}
          profile={PUBLIC_PROFILE}
          isMobile={false}
          showCaptureTitle={false}
          decorations={decorations}
          onApparatus={(key, _rect, event) => { if (event === "activate") void openNote(key); }}
        />
      </main>
      <Dialog open={note !== null || noteFailure !== null} title={note?.label ?? "note"}
        onClose={() => { noteRequest.current?.abort(); setNote(null); setNoteFailure(null); }}>
        {noteFailure ? <p role="alert">{noteFailure}</p> : note ?
          <PublicNote token={token} note={note} onContentChanged={changed} onReturn={(unit,anchor) => {
            setNote(null);
            void reader.inspect({ target: anchor === null ? { kind: "point", point: { kind: "text", unit, offset: 0 } } : { kind: "anchor", unit, id: anchor } });
          }} /> : null}
      </Dialog>
      <footer className={styles.footer}>
        Read-only shared view. No Nexus account is required.
      </footer>
    </>
  );
}


function PublicNote({ token, note, onContentChanged, onReturn }: {
  readonly token: string; readonly note: Schema<"PublicApparatusOut">; readonly onContentChanged: () => void;
  readonly onReturn: (unit: string, anchor: string | null) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (body.current) publicSource(token, onContentChanged).hydrate!(body.current, controller.signal);
    return () => controller.abort();
  }, [note, onContentChanged, token]);
  return <div ref={body} onClickCapture={event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;
    if (link?.dataset.nexusFragmentId) {
      event.preventDefault();
      onReturn(link.dataset.nexusFragmentId, link.dataset.nexusAnchorId ?? null);
    } else if (link?.getAttribute("href")?.startsWith("#")) {
      event.preventDefault();
      const anchor = link.getAttribute("href")!.slice(1);
      body.current?.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView();
    }
  }}>{note.content.map((content,index) => <HtmlRenderer key={index} htmlSanitized={content.html_sanitized} headingLevelOffset={2} />)}</div>;
}
