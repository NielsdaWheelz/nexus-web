// The script background.ts injects into a pinned document: a classic bundle whose
// only exports are types. Each injection connects one port, serves one request
// and disconnects; the background addresses it by that port and the document id
// Firefox attaches. It reads this document, finds the element under a context
// click, and downloads a same-origin link in the page's own principal. It never
// sees a nexus credential.
//
// What leaves the browser is reduced for privacy and size, not sanitized: the
// server's one sanitizer decides what is kept (Q5). Removed here: scripts,
// styles, form controls and hidden subtrees; handler, style and data-*
// attributes and srcdoc; urls in schemes that never leave the browser.

import { extractArticle, extractXArticle } from "@nexus-ingest/article_extraction";
import {
  ARTICLE_CONTENT_MAX_BYTES,
  ARTICLE_SOURCE_MAX_BYTES,
  CONTENT_PORT,
  CaptureFailureError,
  failure,
  readDocument,
  type ArticlePacket,
  type DocumentKind,
  type DocumentRead,
} from "@/extension/capture";

declare const content: { fetch: typeof fetch }; // Firefox MV2: fetch in the page's principal

export type ContentRequest =
  | { kind: "extract"; source_url: string; x_article: boolean }
  | { kind: "bind"; targetElementId: number; linkUrl: string }
  | { kind: "download"; url: string; limits: Record<DocumentKind, number> };

export type ContentReply =
  | { kind: "article"; packet: ArticlePacket; previewText: string }
  | { kind: "unreadable"; message: string }
  | { kind: "bound"; sameOrigin: boolean }
  | { kind: "unbound" }
  | DocumentRead;

const PREVIEW_MAX_CHARS = 1200;
const TWEET_TEXT_MAX_CHARS = 500;
const PRIVATE =
  "script,style,noscript,template,form,input,button,select,option,optgroup,textarea," +
  "fieldset,datalist,output,[hidden]";
const NEVER_SENT = new Set([
  "javascript:",
  "vbscript:",
  "data:",
  "file:",
  "blob:",
]);
/** The single-url attributes of html and svg markup that PRIVATE leaves. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "poster",
  "cite",
  "data",
  "background",
  "longdesc",
  "xlink:href",
]);
/** srcset candidates: a url (it may hold commas, never ends in one), then its
    descriptors up to the next comma. */
const SRCSET_CANDIDATES = /[\s,]*(\S*[^\s,])(?:,+|([^,]*))/g;
const EVIDENCE =
  'iframe[src], blockquote.twitter-tweet, [role="doc-footnote"], [role="doc-endnote"], ' +
  '[role="doc-endnotes"], [role="doc-biblioentry"], [role="doc-bibliography"], ' +
  '[epub\\:type~="footnote"], [epub\\:type~="endnote"], .references, .reflist, ' +
  ".marginnote, fn, ref-list";

const port = browser.runtime.connect({ name: CONTENT_PORT });
const aborter = new AbortController();
port.onDisconnect.addListener(() => aborter.abort());
port.onMessage.addListener((message) => void serve(message as ContentRequest));

async function serve(request: ContentRequest): Promise<void> {
  let reply: ContentReply;
  try {
    reply =
      request.kind === "extract"
        ? extract(request)
        : request.kind === "bind"
          ? bind(request.targetElementId, request.linkUrl)
          : await download(request.url, request.limits);
  } catch (error) {
    if (aborter.signal.aborted) return;
    const message = `Nexus could not read this page: ${error instanceof Error ? error.message : String(error)}`;
    reply = {
      kind: "failed",
      failure:
        error instanceof CaptureFailureError
          ? error.failure
          : { code: "E_CAPTURE_CONTENT", message, requestId: null },
    };
  }
  // a document's blob is copied by the background on receipt
  port.postMessage(reply);
  port.disconnect();
}

// --- extract -------------------------------------------------------------------

function extract(request: Extract<ContentRequest, { kind: "extract" }>): ContentReply {
  if (location.href !== request.source_url)
    return { kind: "unreadable", message: "The page changed. Capture it again." };
  const clone = document.cloneNode(true) as Document;
  const baseUri = document.baseURI;
  const xArticle = request.x_article ? extractXArticle(clone, request.source_url) : null;
  if (request.x_article && xArticle === null)
    return { kind: "unreadable", message: "Open the article’s reading view, wait for it to load, then capture again. Nexus could not verify this article layout." };
  const sourceHtml = sourceEvidence(clone, baseUri, xArticle?.sourceRoot ?? clone); // first: Readability mutates the clone
  const article = xArticle ?? extractArticle(clone);
  if (!article?.content) {
    return {
      kind: "unreadable",
      message: "This page has no readable article.",
    };
  }
  const body = new DOMParser().parseFromString(
    article.content,
    "text/html",
  ).body;
  reduce(body, baseUri);
  const text = collapse(body.textContent ?? "");
  if (text === "")
    return { kind: "unreadable", message: "This page has no readable text." };
  if (utf8Length(body.innerHTML) > ARTICLE_CONTENT_MAX_BYTES) {
    return {
      kind: "unreadable",
      message: "The article is too large to capture.",
    };
  }
  return {
    kind: "article",
    packet: {
      url: location.href,
      base_url: baseUri,
      title: bounded(article.title, 1024),
      content_html: body.innerHTML,
      source_html: sourceHtml,
      byline: nonblank(article.byline, 1024),
      excerpt: nonblank(article.excerpt, 4000),
      site_name: nonblank(article.siteName, 1024),
      published_time: nonblank(article.publishedTime, 128),
    },
    previewText: text.slice(0, PREVIEW_MAX_CHARS),
  };
}

/** Privacy and size, in place, for everything below `root` (a container the
    caller does not send): drop private subtrees and attributes, make every url
    absolute, drop urls that never leave the browser. In-document "#id" links
    stay (the server reads the apparatus graph from them). */
function reduce(root: Element, baseUri: string): void {
  for (const element of root.querySelectorAll(PRIVATE)) element.remove();
  for (const element of root.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      if (
        name.startsWith("on") ||
        name.startsWith("data-") ||
        name === "style" ||
        name === "srcdoc"
      ) {
        element.removeAttribute(name);
      } else if (URL_ATTRIBUTES.has(name) && !value.startsWith("#")) {
        const url = absolute(value, baseUri);
        if (url === null) element.removeAttribute(name);
        else element.setAttribute(name, url);
      } else if (name === "srcset" || name === "ping") {
        // lists: each url absolute, one that never leaves the browser dropped
        const srcset = name === "srcset";
        const items = value.matchAll(srcset ? SRCSET_CANDIDATES : /(\S+)()/g);
        const kept = Array.from(items, ([, url, rest = ""]) => {
          const resolved = absolute(url, baseUri);
          return resolved === null ? "" : resolved + rest;
        });
        element.setAttribute(
          name,
          kept.filter(Boolean).join(srcset ? ", " : " "),
        );
      }
    }
  }
}

function absolute(value: string, baseUri: string): string | null {
  try {
    const url = new URL(value, baseUri);
    return NEVER_SENT.has(url.protocol) ? null : url.href;
  } catch {
    return null;
  }
}

/** Source notes and embeds article extraction omits: complete subtrees only, and
    overflow refuses the capture rather than publish incomplete evidence. */
function sourceEvidence(clone: Document, baseUri: string, root: Document | Element): string {
  let html = "";
  for (const element of root.querySelectorAll(EVIDENCE)) {
    // hidden evidence, or evidence under a hidden ancestor, never leaves
    if (element.parentElement?.closest(EVIDENCE) || element.closest("[hidden]"))
      continue;
    let piece: string | null;
    if (element.localName === "iframe") {
      // an embed is an http(s) document; an about:blank ad slot is not
      const src = absolute(element.getAttribute("src") ?? "", baseUri) ?? "";
      const title = element.getAttribute("title");
      piece = /^https?:/.test(src)
        ? `<iframe src="${escape(src, true)}"${title ? ` title="${escape(title, true)}"` : ""}></iframe>`
        : null;
    } else if (element.matches("blockquote.twitter-tweet")) {
      piece = tweetEvidence(clone, element, baseUri);
    } else {
      // a holder, so the subtree's own root is reduced too
      const holder = clone.createElement("div");
      holder.append(element.cloneNode(true));
      reduce(holder, baseUri);
      piece = holder.innerHTML;
    }
    if (!piece) continue;
    if (utf8Length(html) + utf8Length(piece) > ARTICLE_SOURCE_MAX_BYTES) {
      throw failure(
        "E_RESOURCE_LIMIT",
        "The page's source notes and embeds exceed the capture limit.",
      );
    }
    html += piece;
  }
  return html;
}

/** A tweet as the server reads it: its text (joined like lxml itertext) and its links. */
function tweetEvidence(
  clone: Document,
  quote: Element,
  baseUri: string,
): string | null {
  const hrefs = Array.from(quote.querySelectorAll("a[href]"), (a) =>
    absolute(a.getAttribute("href") ?? "", baseUri),
  ).filter((href): href is string => href !== null && /^https?:/.test(href));
  if (hrefs.length === 0) return null;
  const texts: string[] = [];
  const walker = clone.createTreeWalker(quote, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    texts.push(node.nodeValue ?? "");
  }
  const text = escape(
    collapse(texts.join(" ")).slice(0, TWEET_TEXT_MAX_CHARS),
    false,
  );
  const links = hrefs
    .map((href) => `<a href="${escape(href, true)}"></a>`)
    .join("");
  return `<blockquote class="twitter-tweet">${text}${links}</blockquote>`;
}

function escape(value: string, attribute: boolean): string {
  const text = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return attribute ? text.replace(/"/g, "&quot;") : text;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The first `limit` code points, like the server's bounded metadata. */
function bounded(value: string | null | undefined, limit: number): string {
  return Array.from(value ?? "")
    .slice(0, limit)
    .join("");
}

function nonblank(
  value: string | null | undefined,
  limit: number,
): string | null {
  return value?.trim() ? bounded(value, limit) : null;
}

// --- bind and download ---------------------------------------------------------

/** The clicked element must still be in this document and inside a link; the
    url itself stays as Firefox reported it. */
function bind(targetElementId: number, linkUrl: string): ContentReply {
  const element = browser.menus.getTargetElement(targetElementId);
  if (!element?.closest("a[href]") || !URL.canParse(linkUrl))
    return { kind: "unbound" };
  return {
    kind: "bound",
    sameOrigin: new URL(linkUrl).origin === location.origin,
  };
}

async function download(
  url: string,
  limits: Record<DocumentKind, number>,
): Promise<DocumentRead> {
  let response: Response;
  try {
    response = await content.fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: aborter.signal,
    });
  } catch (error) {
    if (aborter.signal.aborted) throw error;
    const message =
      "The link could not be downloaded. Check the connection and retry.";
    return {
      kind: "failed",
      failure: { code: "E_CAPTURE_FETCH", message, requestId: null },
    };
  }
  return readDocument(response, limits);
}
