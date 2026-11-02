"use client";

// The anonymous reader for `/s#share=<token>`: the share's title, source and
// quote over the whole shared document, read-only, opened at the shared
// highlight. Another `#share=` hash opens in place; any other hash change (an
// in-document link) leaves the reading alone. What a read finds stands where the
// reading would; slips stand at the page's root, over the viewport. Focus inside
// the share's main, gate or reading, moves to whichever main replaces it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import { Ruling } from "@/components/feedback/Ruling";
import { StageAnchor } from "@/components/feedback/Slips";
import type { Shell } from "@/components/feedback/stage";
import { isApiError, readResponse, type ApiError } from "@/lib/api/client";
import { useFailedReadRepair, useThrowLater } from "@/lib/api/serverState";
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
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { publicFetch, publicSource } from "./publicSource";
import styles from "./publicShare.module.css";

type Share = Schema<"PublicShareOut">;
type State =
  | { readonly kind: "Resolving" }
  /** No token, or the server's masked 404: nothing is shared at this link. */
  | { readonly kind: "Absent" }
  /** The share's identity changed under the reading again, after one reread. */
  | { readonly kind: "Changed"; readonly token: string; readonly retrying: boolean }
  | { readonly kind: "Failed"; readonly token: string; readonly error: ApiError; readonly retrying: boolean }
  | { readonly kind: "Ready"; readonly token: string; readonly share: Share };
const RESOLVING: State = { kind: "Resolving" };
const ABSENT: State = { kind: "Absent" };
/** Every share read sends no credentials, so no verb here signs in. */
const SHELL: Shell = { signIn: null };

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
  const [state, setState] = useState<State>(RESOLVING);
  const [attempt, setAttempt] = useState(0);
  const throwLater = useThrowLater();
  const shell = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null);
  const bindShell = useCallback((element: HTMLDivElement | null) => { shell.current = element; setBounds(element); }, []);
  const reloadedToken = useRef<string | null>(null);
  const contentChanged = useCallback((token: string) => {
    if (reloadedToken.current === token) {
      setState({ kind: "Changed", token, retrying: false });
      return;
    }
    reloadedToken.current = token;
    setState(RESOLVING);
    setAttempt(value => value + 1);
  }, []);
  const reread = () => setAttempt(value => value + 1);
  // A ref's cleanup runs before react removes its element, so focus is still where it was.
  // Each kind has its own main, so every change of kind replaces it.
  const mainHeldFocus = useRef(false);
  const main = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    return () => { mainHeldFocus.current = element.contains(document.activeElement); };
  }, []);
  useLayoutEffect(() => {
    if (!mainHeldFocus.current) return;
    mainHeldFocus.current = false;
    shell.current?.querySelector("main")?.focus({ preventScroll: true });
  }, [state.kind]);

  useEffect(() => {
    let controller = new AbortController();
    const resolve = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const token = TOKEN.exec(window.location.hash)?.[1];
      setState((current) => !token ? ABSENT
        : (current.kind === "Failed" || current.kind === "Changed") && current.token === token ? { ...current, retrying: true }
        : RESOLVING);
      if (!token) return;
      try {
        const body = await readResponse<
          ApiJson<"/public/resource-share", "get">
        >(await publicFetch("", token, signal));
        if (!signal.aborted) setState({ kind: "Ready", token, share: body.data });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // A defect is not a dead link: it reaches the route's boundary.
        if (!isApiError(error)) { throwLater({ error }); return; }
        // Only the server's masked 404 means the link is dead.
        setState(error.status === 404 ? ABSENT : { kind: "Failed", token, error, retrying: false });
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
  }, [attempt, throwLater]);
  useFailedReadRepair(state.kind === "Failed", state.kind === "Failed" && state.retrying, reread);

  const title = state.kind === "Ready" ? state.share.title : state.kind === "Absent" ? "Share unavailable" : "Shared reading";
  return (
    <FeedbackProvider shell={SHELL}><div className={styles.shell} ref={bindShell} tabIndex={-1}>
      <FeedbackSurface bounds={bounds} interaction={null} modal={null} active
        protectedTargets={() => bounds ? [...bounds.querySelectorAll<HTMLElement>("header, main." + styles.header)] : []}
        returnFocus={() => shell.current}>
      {/* The route emits no metadata title, so this is the document's only one. */}
      <title>{`${title} · Nexus`}</title>
      {state.kind === "Ready" ? (
        <SharedDocument
          key={`${state.token}:${attempt}`}
          token={state.token}
          share={state.share}
          onContentChanged={contentChanged}
          mainRef={main}
        />
      ) : (
        <main
          key={state.kind}
          ref={main}
          className={`${styles.header} ${styles.gate}`}
          style={readerSurfaceStyle(PUBLIC_PROFILE)}
          tabIndex={-1}
        >
          <div className={styles.brand}>Nexus</div>
          <Gate state={state} reread={reread} />
        </main>
      )}
      </FeedbackSurface>
      <div className={styles.stage}><StageAnchor kind="Root" /></div>
    </div></FeedbackProvider>
  );
}

/** What stands where the reading would, until it opens. */
function Gate({ state, reread }: { readonly state: Exclude<State, { kind: "Ready" }>; readonly reread: () => void }) {
  switch (state.kind) {
    case "Resolving": return <Ruling />;
    case "Absent": return <Fact line={{ fact: "nothing is shared at this link." }} speak />;
    case "Changed": return <Fact line={{ fact: "this reading changed since it opened." }} speak
      verbs={[{ label: "retry", commandKey: "PublicShare.reread", run: reread, busy: state.retrying }]} />;
    case "Failed": return <Failed error={state.error} noun="the shared pages" retry={{ run: reread, busy: state.retrying }} />;
  }
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
  mainRef,
}: {
  readonly token: string;
  readonly share: Share;
  readonly onContentChanged: (token: string) => void;
  readonly mainRef: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  const highlight = share.highlight;
  const changed = useCallback(() => onContentChanged(token), [onContentChanged, token]);
  const throwLater = useThrowLater();
  const [note, setNote] = useState<Schema<"PublicApparatusOut"> | null>(null);
  const [noteFailure, setNoteFailure] = useState<{ readonly ordinal: string; readonly error: ApiError; readonly retrying: boolean } | null>(null);
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
    setNoteFailure(current => current?.ordinal === ordinal ? { ...current, retrying: true } : null);
    try {
      const response = await publicFetch(`/apparatus/${ordinal}?expected_identity=${encodeURIComponent(identity)}`,
        token, controller.signal, { "X-Nexus-Wire": String(WIRE_REVISION) });
      if (response.status === 409) { onContentChanged(token); return; }
      const body = await readResponse<ApiJson<"/public/resource-share/apparatus/{ordinal}", "get">>(response);
      if (!controller.signal.aborted) { setNote(body.data); setNoteFailure(null); }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (!isApiError(error)) { throwLater({ error }); return; }
      setNoteFailure({ ordinal, error, retrying: false });
    }
  }, [identity, onContentChanged, token, throwLater]);
  useFailedReadRepair(noteFailure !== null, noteFailure?.retrying ?? false, () => { if (noteFailure) void openNote(noteFailure.ordinal); });

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
        ref={mainRef}
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
        {noteFailure ? <Failed error={noteFailure.error} noun="this note’s contents"
          retry={{ run: () => void openNote(noteFailure.ordinal), busy: noteFailure.retrying }} /> : note ?
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
