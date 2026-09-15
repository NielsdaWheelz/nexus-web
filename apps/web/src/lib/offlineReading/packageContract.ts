import { decodeEpubFragmentContent, type EpubFragmentContent } from "@/lib/media/epubFragment";
import { decodeMediaNavigation, type MediaNavigation } from "@/lib/media/readerNavigation";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { expectCanonicalRfcUuid as canonicalUuid } from "@/lib/validation";

const SAFE_ENTRY_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const NESTED_ARCHIVE_RE = /\.(?:7z|apk|bz2|epub|gz|jar|rar|tar|xz|zip)$/iu;
const MAX_READER_JSON_BYTES = 64 * 1024 * 1024;
const REMOTE_OR_EXECUTABLE_URL_RE = /(?:https?|ftp|file|data|javascript|vbscript):|\/\//iu;
const EXECUTABLE_TAGS = new Set([
  "applet", "base", "embed", "form", "frame", "frameset", "iframe", "input",
  "link", "meta", "object", "script", "style", "template",
]);
const SUBRESOURCE_TAGS = new Set(["audio", "img", "picture", "source", "track", "video"]);
const URL_ATTRIBUTES = new Set([
  "action", "background", "cite", "formaction", "href", "ping", "poster", "src", "srcset", "xlink:href",
]);

export type OfflineReaderDocument =
  | { readonly kind: "Pdf"; readonly mediaId: string; readonly title: string; readonly documentPath: string }
  | { readonly kind: "WebArticle"; readonly mediaId: string; readonly title: string;
      readonly fragments: readonly OfflineWebFragment[]; readonly navigation: MediaNavigation }
  | { readonly kind: "Epub"; readonly mediaId: string; readonly title: string;
      readonly fragments: readonly EpubFragmentContent[]; readonly navigation: MediaNavigation };

export interface OfflineWebFragment {
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly htmlSanitized: string;
  readonly canonicalText: string;
  readonly createdAt: string;
}

/**
 * The one strict JSON parser for offline-reading text: exact grammar, bounded
 * nesting, duplicate keys rejected, no trailing content. Both the package
 * reader document and the WebKit bridge frames go through it.
 */
export function parseStrictJsonValue(raw: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/\s/u.test(raw[offset] ?? "")) offset += 1;
  };
  const stringValue = (): string => {
    whitespace();
    if (raw[offset] !== '"') throw new TypeError("Expected JSON string");
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      if (raw[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (raw[offset] === '"') {
        offset += 1;
        return JSON.parse(raw.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new TypeError("Unterminated JSON string");
  };
  const value = (depth: number): unknown => {
    // Source TOCs support 32 levels; each adds an object and a children array.
    if (depth > 128) throw new TypeError("JSON is too deeply nested");
    whitespace();
    if (raw[offset] === "{") {
      offset += 1;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (raw[offset] === "}") {
        offset += 1;
        return result;
      }
      while (true) {
        const key = stringValue();
        // `Set.add` returns the set itself, so it can never be the emptiness
        // test here: ask before inserting.
        if (keys.has(key)) throw new TypeError(`Duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        if (raw[offset] !== ":") throw new TypeError("Expected JSON colon");
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (raw[offset] === "}") {
          offset += 1;
          return result;
        }
        if (raw[offset] !== ",") throw new TypeError("Expected JSON comma");
        offset += 1;
      }
    }
    if (raw[offset] === "[") {
      offset += 1;
      const result: unknown[] = [];
      whitespace();
      if (raw[offset] === "]") {
        offset += 1;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        if (raw[offset] === "]") {
          offset += 1;
          return result;
        }
        if (raw[offset] !== ",") throw new TypeError("Expected JSON comma");
        offset += 1;
      }
    }
    if (raw[offset] === '"') return stringValue();
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (raw.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const match = raw.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new TypeError("Invalid JSON value");
    offset += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) throw new TypeError("Invalid JSON number");
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (offset !== raw.length) throw new TypeError("Trailing JSON content");
  return parsed;
}

function exactRecord(
  raw: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${name} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} has an unexpected shape`);
  }
  return value;
}

function string(raw: unknown, name: string, maximum = 512): string {
  if (
    typeof raw !== "string" ||
    Array.from(raw).length === 0 ||
    Array.from(raw).length > maximum ||
    raw.trim().length === 0
  ) {
    throw new TypeError(`${name} must be bounded nonempty text`);
  }
  return raw;
}

function boundedString(raw: unknown, name: string, maximum = MAX_READER_JSON_BYTES): string {
  if (typeof raw !== "string" || Array.from(raw).length > maximum) {
    throw new TypeError(`${name} must be bounded text`);
  }
  return raw;
}

function nonnegativeInteger(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError(`${name} must be a nonnegative integer`);
  }
  return raw;
}

function array(raw: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length > 4096) {
    throw new TypeError(`${name} must be a bounded array`);
  }
  return raw;
}

function safeEntryPath(raw: unknown, name: string): string {
  const value = string(raw, name, 512);
  if (
    new TextEncoder().encode(value).length > 512 ||
    value.normalize("NFC") !== value ||
    !SAFE_ENTRY_PATH_RE.test(value) ||
    value === "manifest.json" ||
    NESTED_ARCHIVE_RE.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(`${name} must be a safe package path`);
  }
  return value;
}

function safeEpubHrefPath(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) throw new TypeError(`${name} is empty`);
  const value = raw;
  if (
    new TextEncoder().encode(value).length > 2048 ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.startsWith("//") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new TypeError(`${name} must be a safe EPUB-relative path`);
  return value;
}

function safeHtml(
  raw: unknown,
  name: string,
  webTextOnly: boolean,
): { readonly html: string; readonly referencedAssets: ReadonlySet<string> } {
  const value = boundedString(raw, name);
  const parser = new DOMParser();
  const document = parser.parseFromString(`<body>${value}</body>`, "text/html");
  const body = document.body;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ALL);
  const referencedAssets = new Set<string>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      throw new TypeError(`${name} contains comments or processing instructions`);
    }
    if (!(node instanceof Element)) continue;
    const tag = node.localName.toLocaleLowerCase();
    if (EXECUTABLE_TAGS.has(tag) || (webTextOnly && SUBRESOURCE_TAGS.has(tag))) {
      throw new TypeError(`${name} contains executable or subresource content`);
    }
    if (!webTextOnly && SUBRESOURCE_TAGS.has(tag) && tag !== "img") {
      throw new TypeError(`${name} contains an unsupported EPUB subresource`);
    }
    for (const attribute of node.getAttributeNames()) {
      const attributeName = attribute.toLocaleLowerCase();
      const attributeValue = node.getAttribute(attribute) ?? "";
      if (attributeName.startsWith("on") || attributeName === "srcdoc" || attributeName === "style") {
        throw new TypeError(`${name} contains executable attributes`);
      }
      if (!URL_ATTRIBUTES.has(attributeName)) continue;
      if (REMOTE_OR_EXECUTABLE_URL_RE.test(attributeValue)) {
        throw new TypeError(`${name} contains a remote or executable URL`);
      }
      if (tag === "a" && attributeName === "href" && attributeValue.startsWith("#")) continue;
      if (!webTextOnly && tag === "img" && attributeName === "src") {
        referencedAssets.add(safeEntryPath(attributeValue, `${name} image src`));
        continue;
      }
      throw new TypeError(`${name} contains an undeclared navigation or subresource URL`);
    }
  }
  return { html: value, referencedAssets };
}

export function decodeOfflineReaderDocument(raw: string): OfflineReaderDocument {
  if (raw.startsWith("\uFEFF")) throw new TypeError("reader.json must not contain a UTF-8 BOM");
  if (new TextEncoder().encode(raw).length > MAX_READER_JSON_BYTES) {
    throw new TypeError("reader.json exceeds the byte bound");
  }
  const parsed = parseStrictJsonValue(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("reader.json must be an object");
  }
  const kind = (parsed as Record<string, unknown>).mediaKind;
  const value = exactRecord(parsed, [
    "readerContractVersion", "mediaId", "mediaKind", "title",
    ...(kind === "Pdf" ? ["documentPath"] : ["navigation", "fragments"]),
  ], "reader document");
  if (value.readerContractVersion !== 2) throw new TypeError("Unsupported reader contract");
  const mediaId = canonicalUuid(value.mediaId, "mediaId");
  const title = string(value.title, "title");
  if (kind === "Pdf") {
    const documentPath = safeEntryPath(value.documentPath, "documentPath");
    if (documentPath !== "document.pdf") throw new TypeError("PDF path must be document.pdf");
    return { kind, mediaId, title, documentPath };
  }
  if (kind !== "Epub" && kind !== "WebArticle") throw new TypeError("Unsupported reader media kind");
  const navigation = decodeMediaNavigation(value.navigation);
  if (navigation.media_id !== mediaId || navigation.kind !== (kind === "Epub" ? "epub" : "web_article")) {
    throw new TypeError("Navigation identity must match its reader document");
  }
  const rawFragments = array(value.fragments, "fragments");
  if (rawFragments.length === 0 || rawFragments.length !== navigation.fragments.length) {
    throw new TypeError("Content and navigation require the same nonempty fragment sequence");
  }
  const validateFragment = (index: number, id: string, fragmentIdx: number, text: string) => {
    const expected = navigation.fragments[index]!;
    if (expected.fragment_id !== id || expected.fragment_idx !== fragmentIdx || expected.char_count !== canonicalCpLength(text)) {
      throw new TypeError("Navigation fragment lengths and order must match canonical content");
    }
  };
  if (kind === "WebArticle") {
    const fragments = rawFragments.map((item, index): OfflineWebFragment => {
      const fragment = exactRecord(item, ["fragmentId", "fragmentIdx", "htmlSanitized", "canonicalText", "createdAt"], `fragments[${index}]`);
      const fragmentId = canonicalUuid(fragment.fragmentId, "fragmentId");
      const fragmentIdx = nonnegativeInteger(fragment.fragmentIdx, "fragmentIdx");
      const canonicalText = boundedString(fragment.canonicalText, "canonicalText");
      validateFragment(index, fragmentId, fragmentIdx, canonicalText);
      return {
        fragmentId, fragmentIdx, canonicalText,
        htmlSanitized: safeHtml(fragment.htmlSanitized, "htmlSanitized", true).html,
        createdAt: string(fragment.createdAt, "createdAt"),
      };
    });
    return { kind, mediaId, title, navigation, fragments };
  }
  let wordStart = 0;
  const fragments = rawFragments.map((item, index): EpubFragmentContent => {
    const value = exactRecord(item, [
      "fragment_id", "fragment_idx", "href_path", "html_sanitized", "canonical_text",
      "char_count", "word_count", "document_word_start", "created_at", "generation", "asset_paths",
    ], `fragments[${index}]`);
    const { asset_paths: rawAssetPaths, ...content } = value;
    const fragment = decodeEpubFragmentContent({ data: content });
    canonicalUuid(fragment.fragment_id, "fragment_id");
    safeEpubHrefPath(fragment.href_path, "href_path");
    validateFragment(index, fragment.fragment_id, fragment.fragment_idx, fragment.canonical_text);
    if (fragment.generation !== navigation.generation || fragment.char_count !== canonicalCpLength(fragment.canonical_text)) {
      throw new TypeError("EPUB fragments must match navigation generation and canonical lengths");
    }
    if (fragment.document_word_start !== wordStart) throw new TypeError("EPUB word prefixes must follow document order");
    wordStart += fragment.word_count;
    const assetPaths = array(rawAssetPaths, "asset_paths").map((path) => safeEntryPath(path, "asset path"));
    if (new Set(assetPaths).size !== assetPaths.length || assetPaths.some((path, index) =>
      !path.startsWith("assets/") || (index > 0 && assetPaths[index - 1]! > path))) {
      throw new TypeError("EPUB asset paths must be unique, sorted, and below assets/");
    }
    const referenced = safeHtml(fragment.html_sanitized, "html_sanitized", false).referencedAssets;
    if (assetPaths.length !== referenced.size || assetPaths.some((path) => !referenced.has(path))) {
      throw new TypeError("EPUB asset declarations must match local references");
    }
    return fragment;
  });
  return { kind, mediaId, title, navigation, fragments };
}
