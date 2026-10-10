#!/usr/bin/env node
// Readability filter, protocol 2. argv: the page's final URL and its raw
// Content-Type header; stdin: the page bytes, already fetched and bounded by the
// Python egress. stdout: one JSON result. Defects use stderr and a nonzero exit.
import { JSDOM } from "jsdom";
import { extractArticle } from "./article_extraction.mjs";

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const CHARSET_ALIASES = {
  latin1: "iso-8859-1",
  "latin-1": "iso-8859-1",
  iso8859_1: "iso-8859-1",
  "iso8859-1": "iso-8859-1",
  cp1252: "windows-1252",
  win1252: "windows-1252",
  "win-1252": "windows-1252",
};

function normalizeCharset(charset) {
  const cleaned = charset
    ?.trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
  return cleaned ? CHARSET_ALIASES[cleaned] || cleaned : null;
}

function contentTypeCharset(contentType) {
  return normalizeCharset(
    contentType.match(/charset\s*=\s*"?([^";,\s]+)"?/i)?.[1],
  );
}

// A <meta> declaration in the first 2048 bytes, as a browser's prescan finds it.
function metaCharset(bytes) {
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 2048));
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const charset = normalizeCharset(
      tag.match(/charset\s*=\s*["']?\s*([^"'>\s/;]+)/i)?.[1],
    );
    if (charset) return charset;
    if (!/http-equiv\s*=\s*["']?\s*content-type\s*["']?/i.test(tag)) continue;
    const content =
      tag.match(/content\s*=\s*["']([^"']*)["']/i) ||
      tag.match(/content\s*=\s*([^>\s]+)/i);
    const declared = content && contentTypeCharset(content[1]);
    if (declared) return declared;
  }
  return null;
}

// Header charset, then <meta>, then UTF-8 (WHATWG labels); an unknown label falls through.
function decode(bytes, contentType) {
  for (const charset of [contentTypeCharset(contentType), metaCharset(bytes)]) {
    if (!charset) continue;
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // An unsupported declaration leaves the next declaration or UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function extract(bytes, url, contentType) {
  const html = decode(bytes, contentType);
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    return { tag: "Failure", failure: "TooLarge" };
  }
  const { document } = new JSDOM(html, { url }).window;
  const article = extractArticle(document);
  if (!article?.content) return { tag: "Failure", failure: "Readability" };
  if (Buffer.byteLength(article.content, "utf8") > MAX_HTML_BYTES) {
    return { tag: "Failure", failure: "TooLarge" };
  }
  return {
    tag: "Success",
    final_url: document.URL,
    base_url: document.baseURI,
    title: article.title ?? "",
    content_html: article.content,
    source_html: html,
    byline: article.byline ?? "",
    excerpt: article.excerpt ?? "",
    site_name: article.siteName ?? "",
    published_time: article.publishedTime ?? "",
  };
}

const [url, contentType] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const result = extract(Buffer.concat(chunks), url, contentType ?? "");
process.stdout.write(JSON.stringify({ version: 2, ...result }) + "\n");
