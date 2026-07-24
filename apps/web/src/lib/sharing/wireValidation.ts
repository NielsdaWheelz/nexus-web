import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";

const ENTITY_PART = "[A-Za-z0-9_-]{22}";
const RESOURCE_GRANT_HANDLE_RE = new RegExp(`^nrg1\\.${ENTITY_PART}\\.${ENTITY_PART}$`);
const USER_HANDLE_RE = new RegExp(`^nus1\\.${ENTITY_PART}\\.${ENTITY_PART}$`);
const LIBRARY_INVITATION_HANDLE_RE = new RegExp(
  `^nli1\\.${ENTITY_PART}\\.${ENTITY_PART}$`,
);
const SHARE_TOKEN_RE = /^nxshr1_[A-Za-z0-9_-]{43}$/;
const UUID_PATH_PART =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MEDIA_PATH_RE = new RegExp(`^/media/${UUID_PATH_PART}$`);

function configuredOrigin(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN ??
    (process.env.NODE_ENV === "test" ? "http://localhost:3000" : "");
  if (!raw) throw new TypeError("canonical app origin is unavailable");
  const url = new URL(raw);
  if (url.origin !== raw || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("canonical app origin is invalid");
  }
  return url.origin;
}

function expectGrammar(
  raw: unknown,
  name: string,
  pattern: RegExp,
): string {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new TypeError(`${name} has invalid sealed-handle grammar`);
  }
  return raw;
}

export function expectResourceGrantHandle(
  raw: unknown,
  name: string,
): string {
  return expectGrammar(raw, name, RESOURCE_GRANT_HANDLE_RE);
}

export function expectUserHandle(raw: unknown, name: string): string {
  return expectGrammar(raw, name, USER_HANDLE_RE);
}

export function expectLibraryInvitationHandle(
  raw: unknown,
  name: string,
): string {
  return expectGrammar(raw, name, LIBRARY_INVITATION_HANDLE_RE);
}

function canonicalAppUrl(raw: unknown, name: string): URL {
  if (typeof raw !== "string") {
    throw new TypeError(`${name} must be a URL`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a URL`);
  }
  if (
    url.origin !== configuredOrigin() ||
    url.username ||
    url.password ||
    url.href !== raw
  ) {
    throw new TypeError(`${name} must use the canonical app origin`);
  }
  return url;
}

export function expectAuthenticatedShareHref(
  raw: unknown,
  subject: string,
  name: string,
): string {
  const ref = parseResourceRef(subject);
  if (!ref) throw new TypeError(`${name} subject is invalid`);
  const url = canonicalAppUrl(raw, name);
  if (url.search) {
    throw new TypeError(`${name} must not contain a query`);
  }

  const prefixes: Partial<Record<typeof ref.scheme, string>> = {
    media: "/media",
    library: "/libraries",
    page: "/pages",
    note_block: "/notes",
    conversation: "/conversations",
    oracle_reading: "/oracle",
    podcast: "/podcasts",
  };
  if (ref.scheme === "highlight") {
    if (
      !MEDIA_PATH_RE.test(url.pathname) ||
      url.hash !== `#highlight-${ref.id}`
    ) {
      throw new TypeError(`${name} does not match its highlight subject`);
    }
    return url.href;
  }
  if (ref.scheme === "artifact") {
    if (
      url.search ||
      url.hash ||
      resolvePaneRoute(url.pathname).id === "unsupported"
    ) {
      throw new TypeError(`${name} is not a canonical artifact target`);
    }
    return url.href;
  }
  if (ref.scheme === "contributor") {
    if (
      url.search ||
      url.hash ||
      resolvePaneRoute(url.pathname).id !== "author"
    ) {
      throw new TypeError(`${name} is not a canonical contributor target`);
    }
    return url.href;
  }
  const prefix = prefixes[ref.scheme];
  if (!prefix || url.pathname !== `${prefix}/${ref.id}` || url.hash) {
    throw new TypeError(`${name} does not match its resource subject`);
  }
  return url.href;
}

export function expectPublicShareHref(raw: unknown, name: string): string {
  const url = canonicalAppUrl(raw, name);
  if (
    url.pathname !== "/s" ||
    url.search ||
    !url.hash.startsWith("#share=") ||
    !SHARE_TOKEN_RE.test(url.hash.slice("#share=".length))
  ) {
    throw new TypeError(`${name} must be a canonical public bearer link`);
  }
  return url.href;
}
