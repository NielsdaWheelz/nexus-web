import type { EpubSectionContent } from "@/lib/media/epubFind";
import type { ReaderNavigation } from "@/lib/reader/ReaderDocumentSource";

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  "action", "background", "cite", "formaction", "href", "poster", "src", "srcset", "xlink:href",
]);

export type OfflineReaderDocument =
  | {
      readonly kind: "Pdf";
      readonly mediaId: string;
      readonly title: string;
      readonly documentPath: string;
    }
  | {
      readonly kind: "WebArticle";
      readonly mediaId: string;
      readonly title: string;
      readonly fragments: readonly OfflineWebFragment[];
      readonly navigation: readonly OfflineWebNavigationItem[];
    }
  | {
      readonly kind: "Epub";
      readonly mediaId: string;
      readonly title: string;
      readonly sections: readonly OfflineEpubSection[];
      readonly navigation: readonly OfflineEpubNavigationItem[];
    };

export interface OfflineWebFragment {
  readonly fragmentId: string;
  readonly ordinal: number;
  readonly htmlSanitized: string;
  readonly canonicalText: string;
}

export interface OfflineWebNavigationItem {
  readonly fragmentId: string;
  readonly label: string;
}

export interface OfflineEpubSection {
  readonly sectionId: string;
  readonly ordinal: number;
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly hrefPath: string;
  readonly anchorId: string | null;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly htmlSanitized: string;
  readonly canonicalText: string;
  readonly assetPaths: readonly string[];
}

export interface OfflineEpubNavigationItem {
  readonly sectionId: string;
  readonly label: string;
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
    if (depth > 16) throw new TypeError("JSON is too deeply nested");
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

function canonicalUuid(raw: unknown, name: string): string {
  const value = string(raw, name, 36);
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return value;
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

function webNavigation(raw: unknown): readonly OfflineWebNavigationItem[] {
  return array(raw, "navigation").map((item, index) => {
    const value = exactRecord(item, ["fragmentId", "label"], `navigation[${index}]`);
    return {
      fragmentId: string(value.fragmentId, `navigation[${index}].fragmentId`, 256),
      label: string(value.label, `navigation[${index}].label`),
    };
  });
}

function epubNavigation(raw: unknown): readonly OfflineEpubNavigationItem[] {
  return array(raw, "navigation").map((item, index) => {
    const value = exactRecord(item, ["sectionId", "label"], `navigation[${index}]`);
    return {
      sectionId: string(value.sectionId, `navigation[${index}].sectionId`, 256),
      label: string(value.label, `navigation[${index}].label`),
    };
  });
}

export function decodeOfflineReaderDocument(raw: string): OfflineReaderDocument {
  if (raw.startsWith("\uFEFF")) throw new TypeError("reader.json must not contain a UTF-8 BOM");
  if (new TextEncoder().encode(raw).length > MAX_READER_JSON_BYTES) {
    throw new TypeError("reader.json exceeds the V1 byte bound");
  }
  const parsed = parseStrictJsonValue(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("reader.json must be an object");
  }
  const kind = (parsed as Record<string, unknown>).mediaKind;
  if (kind === "Pdf") {
    const value = exactRecord(
      parsed,
      ["readerContractVersion", "mediaId", "mediaKind", "title", "documentPath"],
      "PDF reader document",
    );
    if (value.readerContractVersion !== 1) throw new TypeError("Unsupported reader contract");
    const documentPath = safeEntryPath(value.documentPath, "documentPath");
    if (documentPath !== "document.pdf") throw new TypeError("PDF path must be document.pdf");
    return {
      kind,
      mediaId: canonicalUuid(value.mediaId, "mediaId"),
      title: string(value.title, "title"),
      documentPath,
    };
  }
  if (kind === "WebArticle") {
    const value = exactRecord(
      parsed,
      ["readerContractVersion", "mediaId", "mediaKind", "title", "navigation", "fragments"],
      "web reader document",
    );
    if (value.readerContractVersion !== 1) throw new TypeError("Unsupported reader contract");
    const rawFragments = array(value.fragments, "fragments");
    if (rawFragments.length === 0) throw new TypeError("Web articles require at least one fragment");
    const fragments = rawFragments.map((item, index) => {
      const fragment = exactRecord(
        item,
        ["fragmentId", "ordinal", "htmlSanitized", "canonicalText"],
        `fragments[${index}]`,
      );
      const ordinal = nonnegativeInteger(fragment.ordinal, `fragments[${index}].ordinal`);
      if (ordinal !== index) throw new TypeError("Web fragments must be canonically ordered");
      const sanitized = safeHtml(fragment.htmlSanitized, `fragments[${index}].htmlSanitized`, true);
      return {
        fragmentId: string(fragment.fragmentId, `fragments[${index}].fragmentId`, 256),
        ordinal,
        htmlSanitized: sanitized.html,
        canonicalText: boundedString(fragment.canonicalText, `fragments[${index}].canonicalText`),
      };
    });
    const navigation = webNavigation(value.navigation);
    const fragmentIds = fragments.map((fragment) => fragment.fragmentId);
    const navigationIds = navigation.map((item) => item.fragmentId);
    if (new Set(fragmentIds).size !== fragmentIds.length || new Set(navigationIds).size !== navigationIds.length) {
      throw new TypeError("Web fragment and navigation IDs must be unique");
    }
    if (navigationIds.some((fragmentId) => !fragmentIds.includes(fragmentId))) {
      throw new TypeError("Web navigation must reference a declared fragment");
    }
    return {
      kind,
      mediaId: canonicalUuid(value.mediaId, "mediaId"),
      title: string(value.title, "title"),
      navigation,
      fragments,
    };
  }
  if (kind === "Epub") {
    const value = exactRecord(
      parsed,
      ["readerContractVersion", "mediaId", "mediaKind", "title", "navigation", "sections"],
      "EPUB reader document",
    );
    if (value.readerContractVersion !== 1) throw new TypeError("Unsupported reader contract");
    const rawSections = array(value.sections, "sections");
    if (rawSections.length === 0) throw new TypeError("EPUBs require at least one section");
    const sections = rawSections.map((item, index) => {
      const section = exactRecord(
        item,
        [
          "sectionId",
          "ordinal",
          "fragmentId",
          "fragmentIdx",
          "hrefPath",
          "anchorId",
          "startOffset",
          "endOffset",
          "htmlSanitized",
          "canonicalText",
          "assetPaths",
        ],
        `sections[${index}]`,
      );
      const ordinal = nonnegativeInteger(section.ordinal, `sections[${index}].ordinal`);
      if (ordinal !== index) throw new TypeError("EPUB sections must be canonically ordered");
      const startOffset = nonnegativeInteger(
        section.startOffset,
        `sections[${index}].startOffset`,
      );
      const endOffset = nonnegativeInteger(
        section.endOffset,
        `sections[${index}].endOffset`,
      );
      if (endOffset < startOffset) throw new TypeError("EPUB section offsets are reversed");
      const anchorId = section.anchorId;
      if (
        anchorId !== null &&
        (typeof anchorId !== "string" || Array.from(anchorId).length > 256 || anchorId.trim().length === 0)
      ) {
        throw new TypeError("EPUB anchorId must be nonempty text or null");
      }
      const assetPaths = array(section.assetPaths, `sections[${index}].assetPaths`).map(
        (path, assetIndex) => safeEntryPath(path, `sections[${index}].assetPaths[${assetIndex}]`),
      );
      if (
        new Set(assetPaths).size !== assetPaths.length ||
        assetPaths.some((path) => !path.startsWith("assets/")) ||
        assetPaths.some((path, assetIndex) => assetIndex > 0 && assetPaths[assetIndex - 1]! > path)
      ) {
        throw new TypeError("EPUB assetPaths must be unique, sorted, and below assets/");
      }
      const sanitized = safeHtml(section.htmlSanitized, `sections[${index}].htmlSanitized`, false);
      const canonicalText = boundedString(section.canonicalText, `sections[${index}].canonicalText`);
      if (endOffset > Array.from(canonicalText).length) {
        throw new TypeError("EPUB section offsets must be within canonicalText");
      }
      const referencedAssets = sanitized.referencedAssets;
      if (
        [...referencedAssets].some((path) => !assetPaths.includes(path)) ||
        assetPaths.some((path) => !referencedAssets.has(path))
      ) {
        throw new TypeError("EPUB asset declarations must match local references");
      }
      return {
        sectionId: string(section.sectionId, `sections[${index}].sectionId`, 256),
        ordinal,
        fragmentId: canonicalUuid(section.fragmentId, `sections[${index}].fragmentId`),
        fragmentIdx: nonnegativeInteger(section.fragmentIdx, `sections[${index}].fragmentIdx`),
        hrefPath: safeEpubHrefPath(section.hrefPath, `sections[${index}].hrefPath`),
        anchorId,
        startOffset,
        endOffset,
        htmlSanitized: sanitized.html,
        canonicalText,
        assetPaths,
      };
    });
    const navigation = epubNavigation(value.navigation);
    const sectionIds = sections.map((section) => section.sectionId);
    const navigationIds = navigation.map((item) => item.sectionId);
    if (new Set(sectionIds).size !== sectionIds.length || new Set(navigationIds).size !== navigationIds.length) {
      throw new TypeError("EPUB section and navigation IDs must be unique");
    }
    if (navigationIds.some((sectionId) => !sectionIds.includes(sectionId))) {
      throw new TypeError("EPUB navigation must reference a declared section");
    }
    return {
      kind,
      mediaId: canonicalUuid(value.mediaId, "mediaId"),
      title: string(value.title, "title"),
      navigation,
      sections,
    };
  }
  throw new TypeError("Unsupported reader media kind");
}

export function offlineEpubNavigation(document: Extract<OfflineReaderDocument, { kind: "Epub" }>): ReaderNavigation {
  const fragments = new Map<number, { fragment_id: string; fragment_idx: number; char_count: number }>();
  const fragmentIndexes = new Map<string, number>();
  for (const section of document.sections) {
    const existing = fragments.get(section.fragmentIdx);
    const charCount = Array.from(section.canonicalText).length;
    if (
      existing !== undefined &&
      (existing.fragment_id !== section.fragmentId || existing.char_count !== charCount)
    ) {
      throw new TypeError("EPUB fragment index maps to inconsistent canonical content");
    }
    const existingIndex = fragmentIndexes.get(section.fragmentId);
    if (existingIndex !== undefined && existingIndex !== section.fragmentIdx) {
      throw new TypeError("EPUB fragment identity maps to multiple indexes");
    }
    fragmentIndexes.set(section.fragmentId, section.fragmentIdx);
    fragments.set(section.fragmentIdx, {
      fragment_id: section.fragmentId,
      fragment_idx: section.fragmentIdx,
      char_count: charCount,
    });
  }
  const orderedFragments = [...fragments.values()].sort(
    (left, right) => left.fragment_idx - right.fragment_idx,
  );
  return {
    media_id: document.mediaId,
    kind: "epub",
    fragments: orderedFragments,
    sections: document.sections.map((section) => ({
      section_id: section.sectionId,
      label:
        document.navigation.find((item) => item.sectionId === section.sectionId)?.label ??
        section.sectionId,
      ordinal: section.ordinal,
      fragment_id: section.fragmentId,
      fragment_idx: section.fragmentIdx,
      level: null,
      depth: null,
      start_offset: section.startOffset,
      end_offset: section.endOffset,
      href_path: section.hrefPath,
      href_fragment: null,
      anchor_id: section.anchorId,
    })),
    toc_nodes: [],
    landmarks: [],
    page_list: [],
  };
}

export function offlineEpubSection(
  document: Extract<OfflineReaderDocument, { kind: "Epub" }>,
  sectionId: string,
): EpubSectionContent {
  const index = document.sections.findIndex((section) => section.sectionId === sectionId);
  const section = document.sections[index];
  if (section === undefined) throw new Error(`Unknown EPUB section ${sectionId}`);
  return {
    section_id: section.sectionId,
    label: document.navigation.find((item) => item.sectionId === section.sectionId)?.label ?? section.sectionId,
    fragment_id: section.fragmentId,
    fragment_idx: section.fragmentIdx,
    href_path: section.hrefPath,
    anchor_id: section.anchorId,
    source_node_id: null,
    source: "spine",
    ordinal: section.ordinal,
    prev_section_id: document.sections[index - 1]?.sectionId ?? null,
    next_section_id: document.sections[index + 1]?.sectionId ?? null,
    html_sanitized: section.htmlSanitized,
    canonical_text: section.canonicalText,
    char_count: Array.from(section.canonicalText).length,
    word_count: canonicalWordCount(section.canonicalText),
    document_word_start: [...new Map(
      document.sections
        .filter((item) => item.fragmentIdx < section.fragmentIdx)
        .map((item) => [item.fragmentIdx, item.canonicalText] as const),
    ).values()].reduce(
      (count, text) => count + canonicalWordCount(text),
      0,
    ),
    created_at: "1980-01-01T00:00:00Z",
  };
}

function canonicalWordCount(text: string): number {
  const normalized = text.trim();
  return normalized.length === 0 ? 0 : normalized.split(/\s+/u).length;
}
