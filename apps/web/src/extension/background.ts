// The one owner of a Firefox capture: a persistent MV2 background page that
// pins a target by native document identity, reads it through content.ts,
// holds the nexus credential, drives the upload lifecycle through
// captureClient and persists every step in captureStore, so a restart resumes
// the same operation instead of repeating it. The popup renders the view
// state pushed on the "nexus-capture-view" port and sends CaptureCommands;
// content scripts speak ContentRequest/ContentReply on their own port and
// never see the credential.
//
// invariants:
// - one active draft; a second activation resumes it, never replaces it
// - a target is pinned by document id; a replacement document (even a
//   same-url reload) fails every later operation instead of being read
// - save freezes bytes, operation key, destinations and account, and persists
//   `prepared` before the first capture mutation; every replay reuses them
// - the draft's session generation is one nexus named (an UploadRequired, or
//   the current one a retry conflict reported), never inferred; a frozen
//   operation continues by reading status first, so no request is replayed
// - when no work runs for a stored draft (after a restart, or once discard or
//   disconnect aborted it) the persisted state says so: an interrupted
//   download is a draft again, a frozen draft is `resumable`; no capture
//   mutation (create, put, confirm, retry, delete) happens until an explicit
//   `resume`, and the identity read is the only network call a popup open
//   performs; there are no timers, keepalives or offline resubmission
// - a command that needs origins Firefox has not granted waits for the grant
//   the popup requests, before its first mutation; a denial changes nothing;
//   only a repeated such command takes that wait over, and pinning never
//   pre-empts running work
// - the credential is forgotten only on confirmed revocation, or when nexus
//   answers 401 (it is already invalid); a frozen draft it leaves behind is
//   `resumable`, because both its continuation and its discard go through
//   nexus as its bound account

import { isAbortError } from "@/lib/errors";
import {
  decodeLibraryDestinationSelection,
  type LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";
import type { PublishedUpload, UploadResponse } from "@/lib/media/uploadSessionContract";
import { UPLOAD_VERIFICATION_CODES } from "@/lib/media/uploadVerification";
import {
  expectArray,
  expectExactRecord,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import { captureClient, isFailureCode, putCaptureBytes, type CaptureClient } from "@/extension/captureClient";
import {
  ARTICLE_PACKET_MAX_BYTES,
  CAPTURE_CONTENT_TYPE,
  CONTENT_PORT,
  CaptureFailureError,
  VIEW_PORT,
  captureFailure,
  fetchFailure,
  readDocumentResponse,
  serializeArticlePacket,
  sha256Hex,
  urlFilename,
  type CaptureCommand,
  type CaptureFailure,
  type CaptureIntent,
  type CapturePhase,
  type CaptureTargetView,
  type CaptureViewState,
  type CommandResult,
  type DocumentKind,
  type DocumentRead,
  type ExtensionSession,
} from "@/extension/captureContract";
import {
  captureStore,
  type CaptureBytes,
  type CaptureCredential,
  type CaptureDraftRecord,
  type CaptureTarget,
  type DocumentSource,
} from "@/extension/captureStore";
import type { ContentReply, ContentRequest } from "@/extension/content";

// pinned by the build (apps/web/scripts/build-extension.mjs)
declare const __NEXUS_ORIGIN__: string;
declare const __NEXUS_STORAGE_ORIGIN__: string;

const NEXUS_ORIGIN = __NEXUS_ORIGIN__;
const STORAGE_ORIGIN = __NEXUS_STORAGE_ORIGIN__;
const MENU_ID = "nexus-capture-link";
const ARTICLE_FILENAME = "article.json";

// Codes after which the same intent can never succeed; every other failure is
// offered a retry of the same operation.
const TERMINAL_CODES = new Set<string>([
  ...UPLOAD_VERIFICATION_CODES,
  "E_INVALID_REQUEST",
  "E_IDEMPOTENCY_CONFLICT",
  "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH",
  "E_UPLOAD_INTENT_MISMATCH",
  "E_UPLOAD_SESSION_NOT_FOUND",
  "E_LIBRARY_FORBIDDEN",
  "E_FORBIDDEN",
  "E_CAPTURE_PAGE_GONE",
  "E_CAPTURE_ACCOUNT_MISMATCH",
]);

// --- state ------------------------------------------------------------------

/** signed in means both an identity and the client its credential authorizes, never one */
type ConnectedSession = ExtensionSession & { client: CaptureClient };

let draft: CaptureDraftRecord | null = null;
let bytes: CaptureBytes | null = null;
/** why the last activation pinned nothing; shown while no draft exists */
let unsupported: string | null = null;
/** a frozen draft no work runs for awaits an explicit `resume` */
let resumable = false;
let credential: CaptureCredential | null = null;
/** the identity nexus confirmed for the credential */
let session: ConnectedSession | null = null;
let revocationFailure: CaptureFailure | null = null;
/** the one long-running command, abortable by discard/disconnect */
let active: { controller: AbortController; settled: Promise<void> } | null = null;
/** `active` awaits an origin grant (set only by `awaitOrigins`): a repeated
    command takes the wait over instead of being refused */
let awaitingGrant = false;
/** the injection currently waiting for its content port */
let contentWaiter: {
  accepts: (sender: browser.runtime.MessageSender) => boolean;
  resolve: (port: browser.runtime.Port) => void;
} | null = null;
const viewPorts = new Set<browser.runtime.Port>();

// Firefox never persists menu items of a persistent background page: create on
// every load, unconditionally.
browser.menus.create({
  id: MENU_ID,
  title: "Add link to Nexus…",
  contexts: ["link"],
  targetUrlPatterns: ["http://*/*", "https://*/*"],
});

const ready = start();

async function start(): Promise<void> {
  draft = await captureStore.draft.read();
  bytes = await captureStore.bytes.read();
  credential = await captureStore.credential.read();
  await recover();
}

/** No work runs for the stored draft: an interrupted download left nothing
    frozen, so the target is a draft again; a frozen draft waits for an
    explicit resume. */
async function recover(): Promise<void> {
  resumable = draft !== null && draft.intent !== null && draft.phase.kind !== "saved";
  if (draft?.phase.kind === "acquiring") await setDraft({ ...draft, phase: { kind: "draft" } });
  else await pushState();
}

// --- messaging --------------------------------------------------------------

browser.runtime.onMessage.addListener((message: unknown, sender: browser.runtime.MessageSender) => {
  // commands come from this extension's popup only: our id, no tab
  if (sender.id !== browser.runtime.id || sender.tab !== undefined) return undefined;
  return handle(message);
});

browser.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (sender?.id !== browser.runtime.id) {
    port.disconnect();
    return;
  }
  if (port.name === VIEW_PORT && sender.tab === undefined) {
    void attachView(port);
    return;
  }
  if (port.name === CONTENT_PORT && sender.tab !== undefined && contentWaiter?.accepts(sender)) {
    const { resolve } = contentWaiter;
    contentWaiter = null;
    resolve(port);
    return;
  }
  port.disconnect();
});

browser.menus.onClicked.addListener((info, tab) => {
  void menuClick(info, tab);
});

async function attachView(port: browser.runtime.Port): Promise<void> {
  viewPorts.add(port);
  port.onDisconnect.addListener(() => viewPorts.delete(port));
  await ready;
  try {
    await ensureSession();
  } catch (error) {
    // the popup shows signed-out; the next open tries again
    await recordFailure(error);
  }
  await pushState();
}

async function handle(message: unknown): Promise<CommandResult> {
  await ready;
  try {
    return await command(decodeCommand(message));
  } catch (error) {
    return { kind: "failure", failure: await recordFailure(error), state: await viewState() };
  }
}

async function command(sent: CaptureCommand): Promise<CommandResult> {
  switch (sent.kind) {
    case "activate":
      await activate();
      break;
    case "resume":
      await exclusive(resume, true);
      break;
    case "set_destinations":
      await setDestinations(sent.destinations);
      break;
    case "search_destinations":
      return {
        kind: "page",
        page: await requireClient().searchDestinations(sent.q, sent.cursor),
        state: await viewState(),
      };
    case "login":
      await login();
      break;
    case "save":
      await exclusive(save, true);
      break;
    case "retry":
      await exclusive(retry, true);
      break;
    case "discard":
      await interrupting(discard);
      break;
    case "disconnect":
      await interrupting(disconnect);
      break;
  }
  return { kind: "state", state: await viewState() };
}

function decodeCommand(raw: unknown): CaptureCommand {
  const kind = expectOneOf(
    expectRecord(raw, "command").kind,
    ["activate", "resume", "set_destinations", "search_destinations", "login", "save", "retry", "discard", "disconnect"],
    "command.kind",
  );
  switch (kind) {
    case "set_destinations": {
      const sent = expectExactRecord(raw, ["kind", "destinations"], "command");
      return {
        kind,
        destinations: expectArray(
          sent.destinations,
          (value, index) => decodeLibraryDestinationSelection(value, `command.destinations[${index}]`),
          "command.destinations",
        ),
      };
    }
    case "search_destinations": {
      const sent = expectExactRecord(raw, ["kind", "q", "cursor"], "command");
      return {
        kind,
        q: expectString(sent.q, "command.q"),
        cursor: expectNullableString(sent.cursor, "command.cursor"),
      };
    }
    default:
      expectExactRecord(raw, ["kind"], "command");
      return { kind };
  }
}

/** Runs one long command; a second one while it runs is refused. A command
    that awaits origins itself (`awaitsOrigins`) may instead take over a running
    one that awaits its grant: the popup asked again, and nothing was mutated
    before it. Pinning never takes anything over. */
async function exclusive(run: (signal: AbortSignal) => Promise<void>, awaitsOrigins = false): Promise<void> {
  if (active !== null) {
    if (!awaitingGrant || !awaitsOrigins) throw failure("E_CAPTURE_BUSY", "Nexus is still working on this capture.");
    active.controller.abort();
    await active.settled;
    active = null;
  }
  const controller = new AbortController();
  const settled = run(controller.signal).catch((error: unknown) => {
    if (!isAbortError(error)) throw error;
  });
  active = { controller, settled };
  try {
    await settled;
  } finally {
    active = null;
  }
}

/** Aborts the running command, waits for it to settle, records that nothing
    runs for the draft any more, then runs `run`. */
async function interrupting(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (active !== null) {
    active.controller.abort();
    await active.settled.catch(() => undefined);
    active = null;
    await recover();
  }
  await exclusive(run);
}

// --- view state -------------------------------------------------------------

async function viewState(): Promise<CaptureViewState> {
  return {
    connection:
      session !== null
        ? { kind: "connected", account: session.account }
        : revocationFailure !== null
          ? { kind: "revocation_failed", failure: revocationFailure }
          : { kind: "signed_out" },
    requiredOrigins: await requiredOrigins(),
    view:
      draft !== null
        ? {
            kind: "draft",
            draft: {
              id: draft.id,
              target: draft.view,
              phase: draft.phase,
              destinations: draft.destinations,
              resumable,
            },
          }
        : unsupported !== null
          ? { kind: "unsupported", reason: unsupported }
          : { kind: "empty" },
  };
}

/** nexus and storage always; the target origin while the background itself
    still has to download the document (frozen bytes need no publisher);
    minus what Firefox already granted */
async function requiredOrigins(): Promise<string[]> {
  const patterns = [originPattern(NEXUS_ORIGIN), originPattern(STORAGE_ORIGIN)];
  if (draft?.target.kind === "document" && draft.intent === null && downloadsInBackground(draft.target.source)) {
    patterns.push(originPattern(draft.target.url));
  }
  const missing: string[] = [];
  for (const pattern of patterns) {
    if (!(await browser.permissions.contains({ origins: [pattern] }))) missing.push(pattern);
  }
  return missing;
}

/** Firefox match patterns carry no port: the host matches every port. */
function originPattern(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function downloadsInBackground(source: DocumentSource): boolean {
  return source.kind === "extension" || !source.sameOrigin;
}

/** Waits until Firefox reports every required origin. The popup asks in its
    click handler right after sending the command, and the grant arrives here
    as `permissions.onAdded`, whether or not the popup outlived the doorhanger;
    a denial fires nothing, so the wait ends only with a grant or an abort.
    Meanwhile nothing is mutated: the phase is unchanged and `requiredOrigins`
    stays listed, so a reopened popup asks again. No timers. The listener is
    installed before the check, so a grant landing between them is seen. */
async function awaitOrigins(signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    let settled = (): void => undefined;
    const outcome = new Promise<void>((resolve) => {
      settled = () => resolve();
    });
    browser.permissions.onAdded.addListener(settled);
    signal.addEventListener("abort", settled, { once: true });
    try {
      if ((await requiredOrigins()).length === 0) return;
      awaitingGrant = true;
      await outcome;
    } finally {
      awaitingGrant = false;
      browser.permissions.onAdded.removeListener(settled);
      signal.removeEventListener("abort", settled);
    }
  }
}

/** Best effort: a popup that closed is dropped, never a reason for a lifecycle
    step to fail; the durable record carries the state for its next connect. */
async function pushState(): Promise<void> {
  const state = await viewState();
  for (const port of viewPorts) {
    try {
      port.postMessage({ kind: "state", state });
    } catch {
      // justify-ignore-error: Firefox marks a port disconnected before it
      // delivers onDisconnect, so a dead port can still sit in the set.
      viewPorts.delete(port);
    }
  }
}

async function setDraft(next: CaptureDraftRecord): Promise<void> {
  await captureStore.draft.write(next);
  draft = next;
  await pushState();
}

async function setPhase(phase: CapturePhase): Promise<void> {
  await setDraft({ ...requireDraft(), phase });
}

/** A new draft replaces whatever the slot held (a receipt, or nothing);
    memory never outruns the store, so a failed write leaves an empty slot. */
async function replaceDraft(next: CaptureDraftRecord, nextBytes: CaptureBytes | null): Promise<void> {
  await captureStore.draft.clear();
  draft = null;
  bytes = null;
  unsupported = null;
  resumable = false;
  if (nextBytes !== null) await captureStore.bytes.write(nextBytes);
  bytes = nextBytes;
  await setDraft(next);
}

/** Empties the slot; `reason` is why nothing could be pinned in its place,
    shown while no draft exists. */
async function clearDraft(reason: string | null = null): Promise<void> {
  await captureStore.draft.clear();
  draft = null;
  bytes = null;
  unsupported = reason;
  resumable = false;
  await pushState();
}

function newDraft(target: CaptureTarget, view: CaptureTargetView): CaptureDraftRecord {
  return {
    id: crypto.randomUUID(),
    target,
    view,
    phase: { kind: "draft" },
    destinations: [],
    account: session?.account ?? null,
    intent: null,
    session: null,
  };
}

// --- failures ---------------------------------------------------------------

function failure(code: string, message: string, requestId: string | null = null): CaptureFailureError {
  return new CaptureFailureError(captureFailure(code, message, requestId));
}

/** The failure to show for `error`; a 401 also forgets the credential nexus
    no longer honours. */
async function recordFailure(error: unknown): Promise<CaptureFailure> {
  if (error instanceof CaptureFailureError) {
    if (error.status === 401) await forgetCredential();
    return error.failure;
  }
  if (isAbortError(error)) return captureFailure("E_CAPTURE_INTERRUPTED", "The capture was interrupted.");
  return captureFailure(
    "E_CAPTURE_DEFECT",
    `Nexus capture stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Records a failed phase for an error inside save/retry/resume; aborts
    propagate. So does a 401: every nexus call here follows the freeze, so it
    signs the draft out from under a frozen operation nexus never judged, which
    is no phase failure. The command answers it, and forgetting the credential
    leaves the draft resumable. */
async function recordPhaseFailure(error: unknown): Promise<void> {
  if (isAbortError(error) || (error instanceof CaptureFailureError && error.status === 401)) throw error;
  const recorded = await recordFailure(error);
  await setPhase({ kind: "failed", failure: recorded, retryable: !TERMINAL_CODES.has(recorded.code) });
}

function contentDefect(reply: ContentReply): CaptureFailureError {
  return failure("E_CAPTURE_CONTENT", `The page script answered ${reply.kind} out of turn.`);
}

function requireDraft(): CaptureDraftRecord {
  if (draft === null) throw failure("E_CAPTURE_NO_DRAFT", "Nothing is pinned. Open a page and try again.");
  return draft;
}

function requireBytes(): CaptureBytes {
  if (bytes === null) throw failure("E_CAPTURE_BYTES_LOST", "The captured bytes are no longer stored. Discard and capture again.");
  return bytes;
}

function requireSession(): ConnectedSession {
  if (session === null) throw failure("E_CAPTURE_SIGNED_OUT", "Sign in to Nexus first.");
  if (draft !== null && draft.account !== null && draft.account.userHandle !== session.account.userHandle) {
    throw failure(
      "E_CAPTURE_ACCOUNT_MISMATCH",
      "This capture belongs to another Nexus account. Sign in as that account to continue.",
    );
  }
  return session;
}

function requireClient(): CaptureClient {
  return requireSession().client;
}

// --- identity ---------------------------------------------------------------

/** The first successful identity lookup binds an unbound draft to its account. */
async function ensureSession(signal?: AbortSignal): Promise<void> {
  if (session !== null || credential === null) return;
  const client = captureClient(credential.token);
  session = { ...(await client.session(signal)), client };
  if (draft !== null && draft.account === null) await setDraft({ ...draft, account: session.account });
}

/** The credential leaves (confirmed revocation, or a 401). A frozen draft is
    continued and discarded through nexus by its bound account, so with the
    account gone no work can run for it: it is normalized as after any
    interruption and waits, resumable, for the sign-in. */
async function forgetCredential(): Promise<void> {
  await captureStore.credential.clear();
  credential = null;
  session = null;
  revocationFailure = null;
  await recover();
}

async function login(): Promise<void> {
  if (revocationFailure !== null) {
    throw failure("E_CAPTURE_REVOCATION_PENDING", "Finish disconnecting before signing in again.");
  }
  // a held credential is confirmed, never replaced: only a confirmed revocation
  // or a 401 forgets it, so a token nexus still honours is never orphaned by a
  // second sign-in after an identity read that merely could not be reached
  if (credential !== null) {
    await exclusive(async (signal) => {
      await awaitOrigins(signal);
      await ensureSession(signal);
    }, true);
    return;
  }
  // the window to return to: the pinned target's, else the one the popup is in
  const windowId = draft?.target.windowId ?? (await browser.windows.getLastFocused()).id ?? null;
  // only a flow that opened the auth window took the focus and owes a reopen,
  // which follows the command's end so the reopened popup's activation runs
  let opened = false;
  await exclusive(async (signal) => {
    // the nexus host permission covers the identity read after the flow
    await awaitOrigins(signal);
    opened = true;
    const state = crypto.randomUUID();
    const redirectUri = browser.identity.getRedirectURL();
    let finalUrl: string;
    try {
      finalUrl = await browser.identity.launchWebAuthFlow({
        url: `${NEXUS_ORIGIN}/extension/connect/start?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
        interactive: true,
      });
    } catch (error) {
      throw failure("E_CAPTURE_LOGIN", `Sign-in did not complete: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reply = new URLSearchParams(new URL(finalUrl).hash.slice(1));
    if (reply.get("state") !== state) {
      throw failure("E_CAPTURE_LOGIN_STATE", "The sign-in reply did not match this sign-in attempt.");
    }
    const error = reply.get("error");
    if (error !== null) throw failure("E_CAPTURE_LOGIN", `Nexus sign-in failed: ${error}.`, reply.get("request_id"));
    const token = reply.get("token");
    if (token === null || token === "") throw failure("E_CAPTURE_LOGIN", "Nexus sign-in returned no token.");
    credential = { token };
    session = null;
    await captureStore.credential.write(credential);
    await ensureSession(signal);
  }, true).finally(() => (opened && windowId !== null ? reopenPopup(windowId) : undefined));
}

/** Firefox ≥ 149 opens the popup without a gesture but only in the focused
    window. If it cannot, the work waits for the next activation. */
async function reopenPopup(windowId: number): Promise<void> {
  try {
    await browser.windows.update(windowId, { focused: true });
    await browser.browserAction.openPopup({ windowId });
  } catch {
    // justify-ignore-error: the window may be gone; the draft is persisted
    // and the next toolbar click resumes it.
  }
}

/** Revocation is a nexus call, so it waits for the origin grant like every
    other; a denial leaves the credential and the draft as they were. */
async function disconnect(signal: AbortSignal): Promise<void> {
  if (credential === null) throw failure("E_CAPTURE_SIGNED_OUT", "Not connected to Nexus.");
  await awaitOrigins(signal);
  try {
    await captureClient(credential.token).revokeSession(signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // keep the credential: it is the only handle on the token nexus still honours
    revocationFailure = await recordFailure(error);
    session = null;
    await pushState();
    return;
  }
  await forgetCredential();
}

// --- pinning ----------------------------------------------------------------

async function activate(): Promise<void> {
  // running work (a login awaiting its grant, a pin) is never pre-empted:
  // the popup renders what the port pushes
  if (active !== null) return;
  if (draft !== null && draft.phase.kind !== "saved") return;
  const tab = await activeTab();
  if (typeof tab === "string") {
    // a receipt outlives an unsupported tab; an empty popup learns the reason
    if (draft === null) {
      unsupported = tab;
      await pushState();
    }
    return;
  }
  // the receipt for this very page stays until the user leaves it
  if (draft !== null) {
    const page = draft.target.kind === "document" && draft.target.source.kind === "page" ? draft.target.source.pageUrl : draft.target.url;
    if (page === tab.url) return;
  }
  await exclusive((signal) => pinTab(tab, signal));
}

interface ActiveTab {
  id: number;
  windowId: number;
  url: string;
}

async function activeTab(): Promise<ActiveTab | string> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined || tab.windowId === undefined || !tab.url) return "Nexus cannot read this tab.";
  const scheme = new URL(tab.url).protocol;
  if (scheme !== "http:" && scheme !== "https:") return "Only http(s) pages can be saved.";
  return { id: tab.id, windowId: tab.windowId, url: tab.url };
}

/** Toolbar activation: extract the article now, from the live document; an
    http(s) tab Firefox will not let us inject is a document to download. */
async function pinTab(tab: ActiveTab, signal: AbortSignal): Promise<void> {
  let injection: Injection;
  try {
    injection = await inject({ tabId: tab.id }, (sender) => sender.tab?.id === tab.id && sender.frameId === 0, signal);
  } catch (error) {
    if (!isFailureCode(error, "E_CAPTURE_INJECTION")) throw error;
    await replaceDraft(documentDraft(tab.windowId, tab.url, { kind: "extension" }, urlFilename(tab.url)), null);
    return;
  }
  const reply = await injection.request({ kind: "extract" });
  // the page cannot be pinned: a receipt for another page makes way for the reason
  if (reply.kind === "unreadable") {
    await clearDraft(reply.message);
    return;
  }
  if (reply.kind !== "article") throw contentDefect(reply);
  const serialized = serializeArticlePacket(reply.packet);
  if (serialized.byteLength > ARTICLE_PACKET_MAX_BYTES) {
    await clearDraft("The article is too large to capture.");
    return;
  }
  const url = reply.packet.url;
  // the host stands in for a missing title: a url may carry signed access
  // parameters, which are retained as data and never displayed
  const host = new URL(url).hostname;
  await replaceDraft(
    newDraft(
      { kind: "article", windowId: tab.windowId, url },
      { kind: "article", title: reply.packet.title || host, host, previewText: reply.previewText },
    ),
    {
      kind: "web_article",
      blob: new Blob([serialized], { type: CAPTURE_CONTENT_TYPE.web_article }),
      filename: ARTICLE_FILENAME,
      contentType: CAPTURE_CONTENT_TYPE.web_article,
      sizeBytes: serialized.byteLength,
    },
  );
}

function documentDraft(windowId: number, url: string, source: DocumentSource, label: string | null): CaptureDraftRecord {
  const host = new URL(url).hostname;
  return newDraft(
    { kind: "document", windowId, url, source },
    { kind: "document", title: label || host, host, documentKind: "unknown" },
  );
}

/** Context menu: bind the clicked element in its frame now, retain that
    document's identity, then bring the popup up on it. */
async function menuClick(info: browser.menus.OnClickData, tab: browser.tabs.Tab | undefined): Promise<void> {
  await ready;
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || tab.windowId === undefined) return;
  const { windowId } = tab;
  const tabId = tab.id;
  // the slot is pinned only when it is free and idle; otherwise the popup
  // shows the work in progress
  if (active === null && (draft === null || draft.phase.kind === "saved")) {
    try {
      await exclusive((signal) => pinLink(tabId, windowId, info, signal));
    } catch (error) {
      await clearDraft((await recordFailure(error)).message);
    }
  }
  await reopenPopup(windowId);
}

async function pinLink(tabId: number, windowId: number, info: browser.menus.OnClickData, signal: AbortSignal): Promise<void> {
  const { linkUrl, targetElementId } = info;
  const frameId = info.frameId ?? 0;
  if (typeof linkUrl !== "string" || typeof targetElementId !== "number") {
    throw failure("E_CAPTURE_LINK", "Firefox did not report the clicked link.");
  }
  const injection = await inject(
    { tabId, frameIds: [frameId] },
    (sender) => sender.tab?.id === tabId && sender.frameId === frameId,
    signal,
  );
  const reply = await injection.request({ kind: "bind", targetElementId, linkUrl });
  if (reply.kind === "unbound") {
    await clearDraft("The clicked link is no longer on the page. Right-click it again.");
    return;
  }
  if (reply.kind !== "bound") throw contentDefect(reply);
  await replaceDraft(
    documentDraft(
      windowId,
      linkUrl,
      { kind: "page", tabId, frameId, documentId: injection.documentId, pageUrl: info.pageUrl ?? "", sameOrigin: reply.sameOrigin },
      info.linkText?.trim() || urlFilename(linkUrl),
    ),
    null,
  );
}

// --- content injection ------------------------------------------------------

interface Injection {
  /** the native id Firefox attached to the connecting document */
  documentId: string;
  port: browser.runtime.Port;
  request(message: ContentRequest): Promise<ContentReply>;
}

/** Injects content.js into `target` and waits for the one port that
    injection opens; `accepts` names the sender it may come from. */
async function inject(
  target: browser.scripting.InjectionTarget,
  accepts: (sender: browser.runtime.MessageSender) => boolean,
  signal: AbortSignal,
): Promise<Injection> {
  const arrival = new Promise<browser.runtime.Port>((resolve, reject) => {
    contentWaiter = { accepts, resolve };
    signal.addEventListener(
      "abort",
      () => {
        contentWaiter = null;
        reject(signal.reason);
      },
      { once: true },
    );
  });
  let results: browser.scripting.InjectionResult[];
  try {
    results = await browser.scripting.executeScript({ target, files: ["content.js"] });
  } catch (error) {
    contentWaiter = null;
    throw failure(
      "E_CAPTURE_INJECTION",
      `Firefox did not let Nexus read this page: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = results[0];
  if (result === undefined || result.error !== undefined) {
    contentWaiter = null;
    throw failure("E_CAPTURE_CONTENT", `The page script failed: ${String(result?.error?.message ?? result?.error ?? "no result")}`);
  }
  const port = await arrival;
  const documentId = port.sender?.documentId;
  if (typeof documentId !== "string") {
    port.disconnect();
    throw failure("E_CAPTURE_CONTENT", "Firefox attached no document identity to the page script.");
  }
  return {
    documentId,
    port,
    request: (message) =>
      new Promise<ContentReply>((resolve, reject) => {
        port.onMessage.addListener((reply) => resolve(reply as ContentReply));
        port.onDisconnect.addListener(() =>
          reject(failure("E_CAPTURE_PAGE_GONE", "The page changed before Nexus finished reading it.")),
        );
        signal.addEventListener(
          "abort",
          () => {
            port.disconnect();
            reject(signal.reason);
          },
          { once: true },
        );
        port.postMessage(message);
      }),
  };
}

// --- save / transfer --------------------------------------------------------

async function setDestinations(destinations: readonly LibraryDestinationSelection[]): Promise<void> {
  const current = requireDraft();
  if (current.phase.kind !== "draft") throw failure("E_CAPTURE_FROZEN", "Libraries cannot change once a capture is saved.");
  await setDraft({ ...current, destinations });
}

async function save(signal: AbortSignal): Promise<void> {
  const current = requireDraft();
  if (current.phase.kind !== "draft") throw failure("E_CAPTURE_PHASE", "This capture is already being saved.");
  const { client, account, limits } = requireSession();
  await awaitOrigins(signal);
  try {
    if (current.target.kind === "document") {
      await setPhase({ kind: "acquiring" });
      const acquired = await acquireDocument(current.target, { pdf: limits.maxPdfBytes, epub: limits.maxEpubBytes }, signal);
      bytes = acquired;
      await setDraft({ ...requireDraft(), view: { ...current.view, kind: "document", documentKind: acquired.kind } });
    }
    const frozen = requireBytes();
    const limit = frozen.kind === "pdf" ? limits.maxPdfBytes : frozen.kind === "epub" ? limits.maxEpubBytes : limits.maxArticlePacketBytes;
    if (frozen.sizeBytes > limit) {
      throw failure("E_FILE_TOO_LARGE", `This ${frozen.kind} is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    const intent = { operationKey: crypto.randomUUID(), sha256: await sha256Hex(await frozen.blob.arrayBuffer()) };
    // the intent is durable before the first capture mutation
    await setDraft({ ...requireDraft(), account, intent, phase: { kind: "prepared" } });
    await settle(client, await client.createCapture(captureIntent(), intent.operationKey, signal), signal);
  } catch (error) {
    await recordPhaseFailure(error);
  }
}

function captureIntent(): CaptureIntent {
  const current = requireDraft();
  const frozen = requireBytes();
  if (current.intent === null) throw failure("E_CAPTURE_PHASE", "This capture has not been saved yet.");
  return {
    kind: frozen.kind,
    sourceUrl: current.target.url,
    filename: frozen.filename,
    contentType: frozen.contentType,
    sizeBytes: frozen.sizeBytes,
    sha256: current.intent.sha256,
    libraryIds: current.destinations.map((destination) => destination.id),
  };
}

type DocumentBytes = CaptureBytes & { kind: DocumentKind };

/** One bounded get in the context chosen at pinning: the page principal for a
    same-origin link, else the background with the granted origin. */
async function acquireDocument(
  target: Extract<CaptureTarget, { kind: "document" }>,
  limits: Record<DocumentKind, number>,
  signal: AbortSignal,
): Promise<DocumentBytes> {
  if (downloadsInBackground(target.source)) {
    let response: Response;
    try {
      response = await fetch(target.url, { credentials: "include", redirect: "follow", signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new CaptureFailureError(fetchFailure());
    }
    return storeDocument(await readDocumentResponse(response, limits));
  }
  const source = target.source as Extract<DocumentSource, { kind: "page" }>;
  let injection: Injection;
  try {
    injection = await inject(
      { tabId: source.tabId, documentIds: [source.documentId] },
      (sender) => sender.documentId === source.documentId,
      signal,
    );
  } catch (error) {
    if (!isFailureCode(error, "E_CAPTURE_INJECTION")) throw error;
    throw failure("E_CAPTURE_PAGE_GONE", "The page holding this link is gone. Right-click the link again.");
  }
  const reply = await injection.request({ kind: "download", url: target.url, limits });
  if (reply.kind !== "document") return storeDocument(reply);
  // the page keeps its blob until the store committed
  let stored = false;
  try {
    const acquired = await storeDocument(reply);
    stored = true;
    return acquired;
  } finally {
    try {
      injection.port.postMessage({ kind: stored ? "stored" : "store_failed" } satisfies ContentRequest);
    } catch {
      // justify-ignore-error: the page closed its port first; the handed-over
      // blob is the background's own copy, so nothing depends on the ack.
    }
  }
}

async function storeDocument(read: ContentReply | DocumentRead): Promise<DocumentBytes> {
  if (read.kind === "failed") throw new CaptureFailureError(read.failure);
  if (read.kind !== "document") throw contentDefect(read);
  const acquired: DocumentBytes = {
    kind: read.documentKind,
    blob: read.blob,
    filename: read.filename,
    contentType: CAPTURE_CONTENT_TYPE[read.documentKind],
    sizeBytes: read.sizeBytes,
  };
  await captureStore.bytes.write(acquired);
  return acquired;
}

/** Drives one upload answer to its end: PUT the frozen bytes to a capability,
    confirm, and keep the receipt; attention and publication are recorded. */
async function settle(client: CaptureClient, response: UploadResponse, signal: AbortSignal): Promise<void> {
  switch (response.kind) {
    case "Published":
      await published(response);
      return;
    case "NeedsAttention": {
      const attention = response.failure;
      await setPhase({
        kind: "failed",
        failure:
          attention.kind === "VerificationFailed"
            ? captureFailure(attention.code, `Nexus rejected the captured bytes (${attention.code}).`)
            : attention.kind === "TransportFailed"
              ? captureFailure("E_UPLOAD_TRANSPORT", `The upload did not complete (${attention.reason.kind}). Retry to send it again.`)
              : captureFailure("E_CAPTURE_CAPABILITY_EXPIRED", "The upload window expired. Retry to open a new one."),
        retryable: response.capabilities.canRetryUpload,
      });
      return;
    }
    case "UploadRequired": {
      const { sessionHandle: handle, generation } = response;
      await setDraft({ ...requireDraft(), session: { handle, generation }, phase: { kind: "transferring" } });
      const put = await putCaptureBytes(response, requireBytes().blob, signal);
      if (put.kind === "expired") {
        throw failure("E_CAPTURE_CAPABILITY_EXPIRED", "The upload window closed before the upload started. Retry to open a new one.");
      }
      if (put.kind === "failed") {
        await client.reportTransportFailure(
          handle,
          { ...put.reason, generation, duration_ms: put.durationMs, request_id: crypto.randomUUID() },
          signal,
        );
        throw failure("E_UPLOAD_TRANSPORT", `The upload did not complete (${put.reason.kind}). Retry to send it again.`);
      }
      await setPhase({ kind: "confirming" });
      await published(await client.confirmCapture(handle, generation, signal));
    }
  }
}

/** Publication releases the bytes and keeps a small receipt in the slot. The
    receipt names the media only: `idempotency_outcome` says whether this
    answer was a replay, not whether the media was matched, and nexus reports
    no content match. */
async function published(receipt: PublishedUpload): Promise<void> {
  await captureStore.bytes.clear();
  bytes = null;
  await setDraft({
    ...requireDraft(),
    phase: {
      kind: "saved",
      mediaId: receipt.mediaId,
      openUrl: `${NEXUS_ORIGIN}/media/${encodeURIComponent(receipt.mediaId)}`,
    },
  });
}

/** Explicit retry of the same operation: with nothing frozen the draft is
    acquired and saved again; a frozen one continues from nexus's view of it. */
async function retry(signal: AbortSignal): Promise<void> {
  const current = requireDraft();
  if (current.phase.kind !== "failed" || resumable) throw failure("E_CAPTURE_PHASE", "There is nothing to retry.");
  if (current.intent !== null) {
    await proceed(signal);
    return;
  }
  requireClient();
  await awaitOrigins(signal);
  await setPhase({ kind: "draft" });
  await save(signal);
}

/** After a restart or an interruption, the frozen draft continues only when
    asked: the popup shows explicit "resume". */
async function resume(signal: AbortSignal): Promise<void> {
  if (!resumable) throw failure("E_CAPTURE_PHASE", "There is nothing to resume.");
  await proceed(signal);
}

/** Continues the frozen operation from nexus's view of it. Every guard runs
    before `resumable` clears and the first mutation, so an early throw (signed
    out, another account) leaves a resumable draft resumable. Without a
    session handle the create is replayed with the same key; nexus answers by
    the session's current state and advances a dead generation itself. With
    one, status decides: a receipt is accepted; a live capability is confirmed
    first and the bytes are sent only when nexus finds none staged; a dead
    generation is advanced once, fenced by the generation last seen, then the
    bytes are sent and confirmed. */
async function proceed(signal: AbortSignal): Promise<void> {
  const current = requireDraft();
  const client = requireClient();
  if (current.intent === null) throw failure("E_CAPTURE_PHASE", "This capture has not been saved yet.");
  await awaitOrigins(signal);
  resumable = false;
  try {
    await setPhase({ kind: "prepared" });
    if (current.session === null) {
      await settle(client, await client.createCapture(captureIntent(), current.intent.operationKey, signal), signal);
      return;
    }
    const { handle, generation } = current.session;
    const status = await client.captureStatus(handle, signal);
    if (status.kind === "UploadRequired") {
      await setDraft({ ...requireDraft(), session: { handle, generation: status.generation }, phase: { kind: "confirming" } });
      try {
        await published(await client.confirmCapture(handle, status.generation, signal));
      } catch (error) {
        if (!isFailureCode(error, "E_STORAGE_MISSING")) throw error;
        await settle(client, status, signal);
      }
      return;
    }
    if (status.kind === "Published" || !status.capabilities.canRetryUpload) {
      await settle(client, status, signal);
      return;
    }
    const frozen = requireBytes();
    const advanced = await client.retryCapture(
      handle,
      {
        filename: frozen.filename,
        content_type: frozen.contentType,
        size_bytes: frozen.sizeBytes,
        client_mutation_id: crypto.randomUUID(),
        expected_generation: generation,
      },
      signal,
    );
    if (advanced.kind === "GenerationConflict") {
      // nexus holds a generation this draft never saw (an admitted retry whose
      // answer was lost): adopt it, so the next press fences on the truth
      await setDraft({ ...requireDraft(), session: { handle, generation: advanced.generation } });
      throw failure("E_RESOURCE_CONFLICT", "Nexus had already moved this upload on. Retry once more.");
    }
    await settle(client, advanced, signal);
  } catch (error) {
    await recordPhaseFailure(error);
  }
}

/** Discard settles what it interrupts: an unsubmitted draft is cleared; a
    frozen one resolves its uncertain create and deletes the unpublished
    session; a session that turns out published is reported saved instead. A
    create nexus refuses for good (a terminal code: a destination lost, the
    intent no longer accepted) names nothing this client can delete, so the
    slot is released; any other refusal keeps the draft for another attempt.
    The frozen path calls nexus, so it waits for the origin grant first; a
    denial leaves the draft as it was. */
async function discard(signal: AbortSignal): Promise<void> {
  const current = draft;
  if (current === null) {
    unsupported = null;
    await pushState();
    return;
  }
  if (current.phase.kind === "saved" || current.intent === null) {
    await clearDraft();
    return;
  }
  const client = requireClient();
  await awaitOrigins(signal);
  let handle = current.session?.handle ?? null;
  if (handle === null) {
    let response: UploadResponse;
    try {
      response = await client.createCapture(captureIntent(), current.intent.operationKey, signal);
    } catch (error) {
      if (!(error instanceof CaptureFailureError) || !TERMINAL_CODES.has(error.failure.code)) throw error;
      await clearDraft();
      return;
    }
    if (response.kind === "Published") {
      await published(response);
      return;
    }
    handle = response.sessionHandle;
  }
  try {
    await client.deleteCapture(handle, signal);
  } catch (error) {
    if (isFailureCode(error, "E_UPLOAD_ALREADY_PUBLISHED")) {
      // published means saved, never cancelled: status must show the receipt
      const status = await client.captureStatus(handle, signal);
      if (status.kind !== "Published") throw failure("E_CAPTURE_STATUS", "Nexus reports this capture as published but shows no receipt.");
      await published(status);
      return;
    }
    if (!isFailureCode(error, "E_UPLOAD_SESSION_NOT_FOUND")) throw error;
  }
  await clearDraft();
}
