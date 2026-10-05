"use client";

// The anonymous reader for `/s#share=<token>`: the share's title, source and
// quote over the whole shared document, read-only, opened at the shared
// highlight. A hash change opens the new link in place.
import { useEffect, useMemo, useState } from "react";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { Contents } from "@/lib/documentReader/chrome/Contents";
import DocumentReaderView, {
  useDocumentReader,
  useReaderState,
  type Decorations,
  type Mark,
} from "@/lib/documentReader/DocumentReader";
import type { ReaderTarget } from "@/lib/documentReader/model";
import { publicFetch, publicSource } from "./publicSource";
import styles from "./publicShare.module.css";

type Share = Schema<"PublicShareOut">;

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
  const [state, setState] = useState<
    "Resolving" | "Unavailable" | { token: string; share: Share }
  >("Resolving");

  useEffect(() => {
    let controller = new AbortController();
    const resolve = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const token = /^#share=(nxshr1_[A-Za-z0-9_-]{43})$/.exec(
        window.location.hash,
      )?.[1];
      setState(token ? "Resolving" : "Unavailable");
      if (!token) return;
      try {
        const response = await publicFetch("", token, signal);
        if (!response.ok)
          throw new Error(`public share responded ${response.status}`);
        const body = (await response.json()) as ApiJson<
          "/public/resource-share",
          "get"
        >;
        if (!signal.aborted) setState({ token, share: body.data });
      } catch (error) {
        if (signal.aborted) return;
        console.error("public_share_resolution_failed", {
          reason: error instanceof Error ? error.name : "UnknownError",
        });
        setState("Unavailable");
      }
    };
    void resolve();
    window.addEventListener("hashchange", resolve);
    return () => {
      controller.abort();
      window.removeEventListener("hashchange", resolve);
    };
  }, []);

  const ready = typeof state === "object" ? state : null;
  const title =
    ready?.share.title ??
    (state === "Resolving" ? "Shared reading" : "Share unavailable");
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
        <main className={styles.header} role="status">
          <div className={styles.brand}>Nexus</div>
          {state === "Resolving" ? (
            <p>Opening shared reading…</p>
          ) : (
            <>
              <h1>Share unavailable</h1>
              <p>This link is invalid, revoked, or no longer readable.</p>
            </>
          )}
        </main>
      )}
    </div>
  );
}

/** The shared highlight as the reader's one mark, addressed by unit ordinal. */
function sharedMark(share: Share): Mark | null {
  if (share.highlight.kind !== "Present") return null;
  const { color, anchor } = share.highlight.value;
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
  const highlight =
    share.highlight.kind === "Present" ? share.highlight.value : null;
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
            evidence: null,
            pulse: null,
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
        {share.source_url.kind === "Present" ? (
          <a
            href={share.source_url.value}
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
          {highlight.quote.kind === "Present" ? (
            <blockquote>{highlight.quote.value}</blockquote>
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
