"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { formatClock } from "@/lib/formatClock";
import { applyHighlightsToHtml } from "@/lib/highlights/applySegments";
import PublicPdf from "./PublicPdf";
import styles from "./publicShare.module.css";

type Share = Schema<"PublicShareOut">;
type Section = Schema<"PublicSectionEntryOut">;
/** The shared highlight's text anchor: codepoint offsets into the canonical text of `ordinal`. */
type Mark = Schema<"PublicTextAnchorOut"> & { color: Schema<"PublicHighlightOut">["color"] };

/**
 * The token lives in the URL fragment, so the page request never carries it. It travels only
 * in this header, on requests that send no credentials, skip every cache, and refuse redirects.
 */
function publicFetch(path: string, token: string, signal: AbortSignal): Promise<Response> {
  return fetch(`/api/public/resource-share${path}`, {
    headers: { "X-Nexus-Share-Token": token },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
}

function focusTarget(element: HTMLElement | null) {
  element?.scrollIntoView({ behavior: "smooth", block: "center" });
  element?.focus({ preventScroll: true });
}

/** The anonymous reader for `/s#share=<token>`; a hash change opens the new link in place. */
export default function PublicShareReader() {
  const [state, setState] = useState<"Resolving" | "Unavailable" | { token: string; share: Share }>(
    "Resolving",
  );

  useEffect(() => {
    let controller = new AbortController();
    const resolve = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const token = /^#share=(nxshr1_[A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1];
      setState(token ? "Resolving" : "Unavailable");
      if (!token) return;
      try {
        const response = await publicFetch("", token, signal);
        if (!response.ok) throw new Error(`public share responded ${response.status}`);
        const body = (await response.json()) as ApiJson<"/public/resource-share", "get">;
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
    ready?.share.title ?? (state === "Resolving" ? "Shared reading" : "Share unavailable");
  return (
    <div className={styles.shell}>
      {/* The route emits no metadata title, so this is the document's only one. */}
      <title>{`${title} · Nexus`}</title>
      {ready ? (
        <SharedDocument token={ready.token} share={ready.share} />
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

function SharedDocument({ token, share }: { token: string; share: Share }) {
  const highlight = share.highlight.kind === "Present" ? share.highlight.value : null;
  const mark =
    highlight?.anchor.kind === "Text" ? { ...highlight.anchor, color: highlight.color } : null;
  const markAt = (ordinal: number) => (mark?.ordinal === ordinal ? mark : null);
  const { reader } = share;
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
      <main className={styles.reader}>
        {highlight ? (
          <aside className={styles.callout} aria-label="Shared highlight">
            <span>Shared highlight</span>
            {highlight.quote.kind === "Present" ? (
              <blockquote>{highlight.quote.value}</blockquote>
            ) : (
              <p>The highlighted area is shown in the document below.</p>
            )}
          </aside>
        ) : null}
        {reader.kind === "Article" ? (
          <article className={styles.column}>
            {reader.fragments.map((fragment) => (
              <MarkedHtml
                key={fragment.ordinal}
                html={fragment.html_sanitized}
                text={fragment.canonical_text}
                mark={markAt(fragment.ordinal)}
              />
            ))}
          </article>
        ) : reader.kind === "Transcript" ? (
          <div className={styles.column}>
            <ol className={styles.transcript}>
              {reader.segments.map((segment) => (
                <Segment key={segment.ordinal} segment={segment} mark={markAt(segment.ordinal)} />
              ))}
            </ol>
          </div>
        ) : reader.kind === "Epub" ? (
          <PublicEpub token={token} sections={reader.sections} mark={mark} />
        ) : (
          <PublicPdf token={token} highlight={highlight} />
        )}
      </main>
      <footer className={styles.footer}>
        Read-only shared view. No Nexus account is required.
      </footer>
    </>
  );
}

function Segment({ segment, mark }: { segment: Schema<"PublicSegmentOut">; mark: Mark | null }) {
  const chars = Array.from(segment.canonical_text);
  return (
    <li
      className={mark ? styles.target : undefined}
      tabIndex={mark ? -1 : undefined}
      ref={mark ? focusTarget : undefined}
    >
      <span className={styles.meta}>
        {segment.start_ms.kind === "Present" ? formatClock(segment.start_ms.value / 1000) : null}
        {segment.speaker.kind === "Present" ? ` · ${segment.speaker.value}` : null}
      </span>
      <p>
        {mark ? (
          <>
            {chars.slice(0, mark.start_offset).join("")}
            <mark className={`hl-${mark.color}`}>
              {chars.slice(mark.start_offset, mark.end_offset).join("")}
            </mark>
            {chars.slice(mark.end_offset).join("")}
          </>
        ) : (
          segment.canonical_text
        )}
      </p>
    </li>
  );
}

function PublicEpub(props: { token: string; sections: Section[]; mark: Mark | null }) {
  const { token, sections, mark } = props;
  const [selected, setSelected] = useState(
    () => sections.find((section) => section.ordinal === mark?.ordinal) ?? sections[0],
  );
  // The loaded body names its section, so a body never renders under another selection.
  const [loaded, setLoaded] = useState<{
    section: Section;
    body: Schema<"PublicSectionOut"> | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void publicFetch(`/sections/${selected.section_handle}`, token, controller.signal)
      .then(async (response) => {
        type Json = ApiJson<"/public/resource-share/sections/{section_handle}", "get">;
        return response.ok ? ((await response.json()) as Json).data : null;
      })
      .catch(() => null)
      .then((body) => {
        if (!controller.signal.aborted) setLoaded({ section: selected, body });
      });
    return () => controller.abort();
  }, [selected, token]);

  return (
    <div className={styles.epub}>
      <nav aria-label="Book contents">
        {sections.map((section) => (
          <button
            key={section.section_handle}
            type="button"
            aria-current={section === selected ? "location" : undefined}
            style={{ paddingInlineStart: `${12 + section.depth * 12}px` }}
            onClick={() => setSelected(section)}
          >
            {section.label || `Section ${section.ordinal + 1}`}
          </button>
        ))}
      </nav>
      <article className={styles.column}>
        {loaded?.section !== selected ? (
          <p className={styles.note}>Loading section…</p>
        ) : loaded.body === null ? (
          <p className={styles.note}>Section unavailable.</p>
        ) : (
          <MarkedHtml
            key={selected.section_handle}
            token={token}
            html={loaded.body.html_sanitized}
            text={loaded.body.canonical_text}
            mark={mark?.ordinal === selected.ordinal ? mark : null}
          />
        )}
      </article>
    </div>
  );
}

/**
 * Sanitized HTML with the shared highlight marked by the reader's own applyHighlightsToHtml,
 * scrolled to and focused. With a token, EPUB images load by handle as blob URLs.
 */
function MarkedHtml(props: { html: string; text: string; mark: Mark | null; token?: string }) {
  const { html, text, mark, token } = props;
  const rootRef = useRef<HTMLElement>(null);
  const marked = useMemo(
    () =>
      mark &&
      applyHighlightsToHtml(html, text, [
        {
          id: "shared",
          start_offset: mark.start_offset,
          end_offset: mark.end_offset,
          color: mark.color,
          created_at: "",
        },
      ]),
    [html, mark, text],
  );
  const markedOk = marked !== null && marked.failedIds.length === 0;
  const rendered = markedOk ? marked.html : html;

  useEffect(() => {
    if (!markedOk || !rootRef.current) return;
    rootRef.current.querySelector("[data-active-highlight-ids]")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    rootRef.current.focus({ preventScroll: true });
  }, [markedOk, rendered]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !token) return;
    const controller = new AbortController();
    const objectUrls: string[] = [];
    const images = root.querySelectorAll<HTMLImageElement>("img[data-nexus-public-asset-handle]");
    for (const image of images) {
      void publicFetch(`/assets/${image.dataset.nexusPublicAssetHandle}`, token, controller.signal)
        .then((response) => (response.ok ? response.blob() : null))
        .then((blob) => {
          if (!blob || controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          image.src = url;
        })
        .catch(() => undefined);
    }
    return () => {
      controller.abort();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [rendered, token]);

  return (
    <section
      ref={rootRef}
      className={markedOk ? styles.target : undefined}
      tabIndex={markedOk ? -1 : undefined}
    >
      <HtmlRenderer htmlSanitized={rendered} headingLevelOffset={1} />
      {marked !== null && !markedOk ? (
        <p className={styles.note} role="status">
          Highlight unavailable.
        </p>
      ) : null}
    </section>
  );
}
