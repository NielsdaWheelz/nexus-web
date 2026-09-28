// Sealed-handle grammar checks for the users and library decoders, until those slices type their routes.
const USER_HANDLE_RE = /^nus1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const LIBRARY_INVITATION_HANDLE_RE = /^nli1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;

function expectGrammar(raw: unknown, name: string, pattern: RegExp): string {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new TypeError(`${name} has invalid sealed-handle grammar`);
  }
  return raw;
}

export function expectUserHandle(raw: unknown, name: string): string {
  return expectGrammar(raw, name, USER_HANDLE_RE);
}

export function expectLibraryInvitationHandle(raw: unknown, name: string): string {
  return expectGrammar(raw, name, LIBRARY_INVITATION_HANDLE_RE);
}
