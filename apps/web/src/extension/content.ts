// The script background.ts injects into a pinned document: a self-contained
// classic bundle whose only exports are types. Each injection connects one
// port named "nexus-capture-content", serves exactly one request on it, and
// disconnects; background.ts addresses an injection by that port and the
// document identity Firefox attaches to its sender. The script can read this
// document, find the element under a context-menu click, and download a
// same-origin link in the page's own principal. It never receives a nexus
// credential or an arbitrary fetch.

import { extractArticle } from "@nexus-ingest/article_extraction";
import { absent, present, type Presence } from "@/lib/api/presence";
import {
  ARTICLE_CONTENT_MAX_BYTES,
  ARTICLE_SOURCE_MAX_BYTES,
  CONTENT_PORT,
  captureFailure,
  fetchFailure,
  readDocumentResponse,
  type ArticlePacket,
  type DocumentKind,
  type DocumentRead,
} from "@/extension/captureContract";

/** Firefox MV2 content scripts: fetch in the page's principal, with its cookies. */
declare const content: { fetch: typeof fetch };

export type ContentRequest =
  | { kind: "extract" }
  | { kind: "bind"; targetElementId: number; linkUrl: string }
  | { kind: "download"; url: string; limits: Record<DocumentKind, number> }
  /** background's acknowledgement of a `document` reply, after its store committed */
  | { kind: "stored" }
  | { kind: "store_failed" };

export type ContentReply =
  | { kind: "article"; packet: ArticlePacket; previewText: string }
  | { kind: "unreadable"; message: string }
  | { kind: "bound"; sameOrigin: boolean }
  | { kind: "unbound" }
  /** `document` is held by this script until the background acknowledges it */
  | DocumentRead;

const PREVIEW_MAX_CHARS = 1200;
const TWEET_TEXT_MAX_CHARS = 500;

const port = browser.runtime.connect({ name: CONTENT_PORT });
const aborter = new AbortController();
let acknowledged: (() => void) | null = null;

port.onDisconnect.addListener(() => {
  aborter.abort();
  acknowledged?.();
});
port.onMessage.addListener((message) => {
  void serve(message as ContentRequest);
});

async function serve(request: ContentRequest): Promise<void> {
  if (request.kind === "stored" || request.kind === "store_failed") {
    acknowledged?.();
    acknowledged = null;
    return;
  }
  let reply: ContentReply;
  try {
    reply =
      request.kind === "extract"
        ? extract()
        : request.kind === "bind"
          ? bind(request.targetElementId, request.linkUrl)
          : await download(request.url, request.limits);
  } catch (error) {
    if (aborter.signal.aborted) return;
    reply = {
      kind: "failed",
      failure: captureFailure(
        "E_CAPTURE_CONTENT",
        `Nexus could not read this page: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  if (reply.kind === "document") {
    // keep the blob referenced until the background has stored it durably
    const stored = new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    port.postMessage(reply);
    await stored;
  } else {
    port.postMessage(reply);
  }
  port.disconnect();
}

// --- extract ----------------------------------------------------------------

function extract(): ContentReply {
  const clone = document.cloneNode(true) as Document;
  const baseUri = document.baseURI;
  // evidence first: the extractor mutates the clone
  const sourceHtml = sourceEvidence(clone, baseUri);
  const article = extractArticle(clone);
  if (article === null || typeof article.content !== "string" || article.content === "") {
    return { kind: "unreadable", message: "This page has no readable article." };
  }
  const parsed = new DOMParser().parseFromString(article.content, "text/html");
  project(parsed.body, baseUri);
  const contentHtml = parsed.body.innerHTML;
  const text = collapse(parsed.body.textContent ?? "");
  if (text === "") return { kind: "unreadable", message: "This page has no readable text." };
  if (utf8Length(contentHtml) > ARTICLE_CONTENT_MAX_BYTES) {
    return { kind: "unreadable", message: "The article is too large to capture." };
  }
  return {
    kind: "article",
    packet: {
      url: location.href,
      base_url: baseUri,
      title: bounded(article.title, 1024),
      content_html: contentHtml,
      source_html: sourceHtml,
      byline: presence(article.byline, 1024),
      excerpt: presence(article.excerpt, 4000),
      site_name: presence(article.siteName, 1024),
      published_time: presence(article.publishedTime, 128),
    },
    previewText: text.slice(0, PREVIEW_MAX_CHARS),
  };
}

// What leaves the browser is content-bearing markup only. Dropped with their
// content: scripts, styles, templates, forms and every control, hidden
// elements, and embeds the server drops anyway. Kept per element: the
// attributes sanitize_html admits (a: href/title; img: src/alt; th/td:
// colspan/rowspan), the ids/classes/link/apparatus attributes html_apparatus
// and web_article_structure read, and iframe src/title for embed evidence.
// Everything else — event handlers, style, data-*, aria, srcset — goes.
const DROPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "form",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "textarea",
  "fieldset",
  "datalist",
  "output",
  "object",
  "embed",
  "svg",
  "meta",
  "link",
  "base",
]);
const KEPT_ATTRIBUTES = new Set(["id", "class", "role", "epub:type", "rid", "ref-type"]);
const KEPT_BY_TAG: Record<string, readonly string[]> = {
  a: ["href", "title", "name"],
  img: ["src", "alt"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
  iframe: ["src", "title"],
};
const DROPPED_SCHEMES = new Set(["javascript:", "vbscript:", "data:", "file:"]);

function project(root: HTMLElement, baseUri: string): void {
  for (const element of root.querySelectorAll("*")) {
    if (!element.isConnected) continue; // removed with an ancestor
    const tag = element.localName;
    if (DROPPED_TAGS.has(tag) || element.hasAttribute("hidden")) {
      element.remove();
      continue;
    }
    for (const name of element.getAttributeNames()) {
      if (!KEPT_ATTRIBUTES.has(name) && !(KEPT_BY_TAG[tag]?.includes(name) ?? false)) {
        element.removeAttribute(name);
        continue;
      }
      if (name !== "href" && name !== "src") continue;
      const value = element.getAttribute(name) ?? "";
      // in-document links carry the apparatus graph; the server reads them as "#id"
      if (name === "href" && value.startsWith("#")) continue;
      const resolved = absolute(value, baseUri, name === "src");
      if (resolved === null) element.removeAttribute(name);
      else element.setAttribute(name, resolved);
    }
  }
}

/** `value` against `baseUri`, or null when it does not parse or names a
    scheme that never leaves the browser; `src` must be http(s). */
function absolute(value: string, baseUri: string, httpOnly: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value, baseUri);
  } catch {
    return null;
  }
  if (DROPPED_SCHEMES.has(url.protocol)) return null;
  if (httpOnly && url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/** Bounded rebuilt embed evidence from the whole document, in document order:
    iframe src/title, and twitter-quote text plus link hrefs — exactly what
    document_embed_extraction reads. Whole elements only, ≤ 64 KiB. */
function sourceEvidence(clone: Document, baseUri: string): string {
  let html = "";
  let bytes = 0;
  for (const element of clone.querySelectorAll("iframe[src], blockquote.twitter-tweet")) {
    const piece = element.localName === "iframe" ? iframeEvidence(element, baseUri) : tweetEvidence(clone, element, baseUri);
    if (piece === null) continue;
    const size = utf8Length(piece);
    if (bytes + size > ARTICLE_SOURCE_MAX_BYTES) break;
    html += piece;
    bytes += size;
  }
  return html;
}

function iframeEvidence(iframe: Element, baseUri: string): string | null {
  const src = absolute(iframe.getAttribute("src") ?? "", baseUri, true);
  if (src === null) return null;
  const title = iframe.getAttribute("title");
  return `<iframe src="${escapeAttribute(src)}"${title ? ` title="${escapeAttribute(title)}"` : ""}></iframe>`;
}

function tweetEvidence(clone: Document, quote: Element, baseUri: string): string | null {
  const hrefs: string[] = [];
  for (const anchor of quote.querySelectorAll("a[href]")) {
    const href = absolute(anchor.getAttribute("href") ?? "", baseUri, true);
    if (href !== null) hrefs.push(href);
  }
  if (hrefs.length === 0) return null;
  // the server joins text nodes with spaces (lxml itertext)
  const texts: string[] = [];
  const walker = clone.createTreeWalker(quote, 0x4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    texts.push(node.nodeValue ?? "");
  }
  const text = collapse(texts.join(" ")).slice(0, TWEET_TEXT_MAX_CHARS);
  return `<blockquote class="twitter-tweet">${escapeText(text)}${hrefs.map((href) => `<a href="${escapeAttribute(href)}"></a>`).join("")}</blockquote>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** the first `limit` code points, like the server ingest's bounded metadata */
function bounded(value: string | null | undefined, limit: number): string {
  return Array.from(value ?? "").slice(0, limit).join("");
}

function presence(value: string | null | undefined, limit: number): Presence<string> {
  return typeof value === "string" && value.trim() !== "" ? present(bounded(value, limit)) : absent();
}

// --- bind -------------------------------------------------------------------

/** The element under the context-menu click must still be in this document
    and inside a link; the clicked url itself stays as Firefox reported it. */
function bind(targetElementId: number, linkUrl: string): ContentReply {
  const element = browser.menus.getTargetElement(targetElementId);
  if (!element || element.closest("a[href]") === null) return { kind: "unbound" };
  let sameOrigin: boolean;
  try {
    sameOrigin = new URL(linkUrl).origin === location.origin;
  } catch {
    return { kind: "unbound" };
  }
  return { kind: "bound", sameOrigin };
}

// --- download ---------------------------------------------------------------

async function download(url: string, limits: Record<DocumentKind, number>): Promise<DocumentRead> {
  let response: Response;
  try {
    response = await content.fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: aborter.signal,
    });
  } catch (error) {
    if (aborter.signal.aborted) throw error;
    return { kind: "failed", failure: fetchFailure() };
  }
  return readDocumentResponse(response, limits);
}
