const ENTITY_PART = "[A-Za-z0-9_-]{22}";
const RESOURCE_GRANT_HANDLE_RE = new RegExp(`^nrg1\\.${ENTITY_PART}\\.${ENTITY_PART}$`);
const USER_HANDLE_RE = new RegExp(`^nus1\\.${ENTITY_PART}\\.${ENTITY_PART}$`);
const LIBRARY_INVITATION_HANDLE_RE = new RegExp(
  `^nli1\\.${ENTITY_PART}\\.${ENTITY_PART}$`,
);
const SHARE_TOKEN_RE = /^nxshr1_[A-Za-z0-9_-]{43}$/;

function configuredOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN ?? "";
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
  name: string,
): string {
  return canonicalAppUrl(raw, name).href;
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
