// One memory-only operation owner. Source/document/account are pinned before
// acquisition; only credentials survive restart. The popup is a view, never a
// writer. Unknown sends retain exact ids, bytes and guards until acknowledged,
// fenced, or explicitly forgotten. There is no command queue.
import { writeRefused } from "@/lib/api/writeOutcome";
import { placementSettlement } from "@/lib/libraries/placementSettlement";
import type { Schema } from "@/lib/api/wire";
import { expectCanonicalRfcUuid, expectExactRecord, expectNullableString, expectString } from "@/lib/validation";
import { CONTENT_PORT, CONTENT_TYPE, CaptureFailureError, VIEW_PORT, failure, readDocument, serializePacket, sha256Hex,
  xTarget, type CaptureFailure, type CapturePhase, type DocumentKind, type DocumentRead, type ExtensionItem,
  type Preview, type SaveTarget, type ViewState, type ViewCommand, type ViewMessage, type ItemCommand } from "@/extension/capture";
import { nexus, isCaptureDefect, putBytes, type ExtensionSession, type Nexus } from "@/extension/nexusClient";
import type { ContentReply, ContentRequest } from "@/extension/content";

declare const __NEXUS_ORIGIN__: string;
declare const __NEXUS_STORAGE_ORIGIN__: string;
const MENU_ID = "nexus-capture-link";
const DISCONNECT_ID = "nexus-disconnect";
const CREDENTIAL_KEY = "nexusCaptureCredential";
const REQUEST_TIMEOUT_MS = 30_000;
// justify-polling: processing has no extension push. Only a displayed receipt
// polls, at a bounded backoff; reopening or Check again starts a fresh read.
const RECEIPT_POLL_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
const VERIFICATION_REJECTIONS = new Set(["E_SOURCE_INTEGRITY", "E_INVALID_FILE_TYPE", "E_FILE_TOO_LARGE", "E_CAPTURE_TOO_LARGE"]);
const TERMINAL = new Set(["E_WIRE_MISMATCH", ...VERIFICATION_REJECTIONS,
  "E_INVALID_REQUEST", "E_UPLOAD_INTENT_MISMATCH", "E_RESOURCE_CONFLICT", "E_FORBIDDEN", "E_CAPTURE_PAGE_GONE", "E_CAPTURE_TARGET_CHANGED",
  "E_SOURCE_TARGET_AMBIGUOUS", "E_UPLOAD_GENERATION_STALE", "E_UPLOAD_CAPABILITY_EXPIRED", "E_UPLOAD_SESSION_NOT_FOUND", "E_STORAGE_MISSING"]);
interface PinnedSource {
  kind: "page" | "link" | "x";
  window_id: number;
  tab_id: number;
  document_id: string | null;
  frame_id: number;
  source_url: string;
  target_url: string;
  same_origin: boolean;
}
type Bytes = { kind: "web_article" | DocumentKind; blob: Blob; filename: string; size: number; sha256: string };
type Write =
  | { kind: "source"; request: Schema<"CreateExtensionSourceRequest"> }
  | { kind: "capture"; request: Schema<"CreateCaptureRequest">; upload: Schema<"UploadRequired"> | null; uploaded: boolean; confirmation: Schema<"ConfirmCaptureRequest"> | null }
  | { kind: "placement"; library_id: string; request: Schema<"PlaceItemRequest">; retaining: boolean }
  | { kind: "removal"; request: Schema<"RemoveMediaRequest"> };
interface Operation {
  id: string;
  activation_id: string;
  source: PinnedSource;
  preview: Preview;
  phase: CapturePhase;
  account_id: string | null;
  lookup: SaveTarget | null;
  bytes: Bytes | null;
  write: Write | null;
  sent: boolean;
  unknown: boolean;
  failure: CaptureFailure | null;
  failure_attempt: number;
  retryable: boolean;
  item: ExtensionItem | null;
  destination: { media_id: string; source_attempt_id: string | null; settled: boolean } | null;
  removal_preview: Schema<"MediaRemovalPreviewOut"> | null;
  required_origins: string[];
  running: boolean;
  reading: AbortController | null;
  poll_index: number;
}
let token: string | null = null;
let session: (ExtensionSession & { client: Nexus }) | null = null;
let operation: Operation | null = null;
let stopped: CaptureFailure | null = null;
let notice: string | null = null;
let revocationFailure: CaptureFailure | null = null;
let revoking = false;
let contentWaiter: { accepts(sender: browser.runtime.MessageSender): boolean; resolve(port: browser.runtime.Port): void } | null = null;
type View = { activation_id: string | null; window_id: number | null; operation_id: string | null; focused: boolean };
const views = new Map<browser.runtime.Port, View>();
let presentation: { id: string; window_id: number; operation_id: string | null } | null = null;
const ready = browser.storage.local.get(CREDENTIAL_KEY).then(stored => {
  const credential: unknown = stored[CREDENTIAL_KEY];
  if (typeof credential === "object" && credential !== null && "token" in credential && typeof credential.token === "string") token = credential.token;
});

browser.menus.create({ id: MENU_ID, title: "add link to nexus", contexts: ["link"], targetUrlPatterns: ["http://*/*", "https://*/*"] });
browser.menus.create({ id: DISCONNECT_ID, title: "disconnect from nexus", contexts: ["browser_action"] });
browser.menus.onClicked.addListener((info, tab) => { void menuClick(info, tab); });
browser.runtime.onConnect.addListener(port => {
  if (port.name === CONTENT_PORT) {
    if (port.sender?.id === browser.runtime.id && contentWaiter !== null && contentWaiter.accepts(port.sender)) {
      const waiter = contentWaiter; contentWaiter = null; waiter.resolve(port);
    } else port.disconnect();
    return;
  }
  if (port.name !== VIEW_PORT || port.sender?.id !== browser.runtime.id || port.sender.tab !== undefined) { port.disconnect(); return; }
  const view: View = { activation_id: null, window_id: null, operation_id: null, focused: false };
  views.set(port, view);
  port.onDisconnect.addListener(() => {
    views.delete(port);
    // A closed permission/auth view owns no sent mutation. A later grant may
    // resume this same source, but cannot prevent a fresh explicit admission.
    if (operation !== null && !operation.running && !operation.unknown
      && (operation.phase === "permission" || operation.phase === "auth")) operation.retryable = true;
  });
  port.onMessage.addListener(raw => { void viewCommand(port, view, raw as ViewCommand).catch(error => { void report(error).then(shown => { notice = shown.message; push(); }); }); });
  push();
});
browser.runtime.onMessage.addListener((raw: unknown, sender) => {
  if (sender.tab === undefined) return undefined;
  return addX(raw, sender);
});
browser.permissions.onAdded.addListener(() => {
  const op = operation;
  if (op !== null && op.phase === "permission" && !op.running && !revoking && revocationFailure === null) void run(op, () => resume(op));
});

function unresolved(op: Operation | null): boolean {
  return op !== null && (op.running || op.unknown || (op.phase === "auth" || op.phase === "permission")
    && [...views.values()].some(view => view.operation_id === op.id));
}
function matches(op: Operation): boolean { return op.account_id === null || op.account_id === session?.user_id; }
function current(op: Operation): void {
  if (operation !== op || session !== null && !matches(op)) throw failure("E_CAPTURE_TARGET_CHANGED", "the item or account changed. this request has not continued.");
}
function state(): ViewState {
  const op = operation;
  return { account_id: session?.user_id ?? null, required_origins: op?.required_origins ?? [], notice, revocation_failure: revocationFailure,
    operation: op === null ? null : { id: op.id, phase: op.phase, preview: op.preview, host: new URL(op.source.target_url).hostname,
      item: op.item, open_url: op.destination === null || op.phase === "unavailable" || op.phase === "removed" || !matches(op) ? null
        : op.item?.has_readable_copy ? `${__NEXUS_ORIGIN__}/media/${op.destination.media_id}`
          : `${__NEXUS_ORIGIN__}/imports?selected=${encodeURIComponent(`media:${op.destination.media_id}`)}`,
      failure: stopped ?? op.failure, failure_attempt: op.failure_attempt, retryable: op.retryable, busy: op.running, account_matches: matches(op),
      placement: op.write?.kind === "placement" ? { library_id: op.write.library_id, included: op.write.request.included, unknown: op.unknown } : null,
      removal: op.write?.kind === "removal" ? op.unknown ? "unknown" : "sending" : op.removal_preview === null ? "idle" : "reviewing",
      removal_preview: op.removal_preview } };
}
function push(attachedPort: browser.runtime.Port | null = null): void {
  const snapshot = state();
  for (const [port, view] of views) {
    const bound = view.operation_id === snapshot.operation?.id;
    const visible = bound ? snapshot : { ...snapshot, operation: null, required_origins: [],
      notice: view.operation_id === null ? snapshot.notice : "this receipt is no longer available. click add to nexus for a new request." };
    try { const message: ViewMessage = { state: visible, operation_id: view.operation_id, attached: port === attachedPort }; port.postMessage(message); }
    catch { views.delete(port); } // justify-ignore-error: a native port may close before onDisconnect
  }
}
function attach(port: browser.runtime.Port, view: View, id: string | null): void {
  view.operation_id = id;
  view.focused = true;
  push(port);
  if (operation?.id === id && operation.phase === "saved") { operation.poll_index = 0; void readReceipt(operation); }
}
async function viewCommand(port: browser.runtime.Port, view: View, command: ViewCommand): Promise<void> {
  await ready;
  if (!views.has(port)) return;
  if (command.kind === "connect") {
    if (view.activation_id !== null) return;
    view.activation_id = command.activation_id; view.window_id = command.window_id;
    push(); return;
  }
  if (view.activation_id !== command.activation_id) throw failure("E_CAPTURE_VIEW", "reopen this popup.");
  if (command.kind === "attach") {
    if (command.operation_id !== null && command.operation_id !== operation?.id) throw failure("E_CAPTURE_VIEW", "this save is no longer available.");
    view.window_id = command.window_id;
    attach(port, view, command.operation_id ?? (operation?.activation_id === command.activation_id ? operation.id : null)); return;
  }
  if (command.kind === "open") {
    if (view.focused) return;
    view.focused = true;
    view.window_id = command.window_id;
    if (presentation?.window_id === command.window_id) {
      const pending = presentation; presentation = null;
      attach(port, view, pending.operation_id === operation?.id ? pending.operation_id : null); return;
    }
    const source: PinnedSource = { kind: "page", window_id: command.window_id, tab_id: command.tab_id, document_id: null,
      frame_id: 0, source_url: command.source_url, target_url: command.source_url, same_origin: true };
    const op = admit(source, { title: null, byline: null }, command.activation_id);
    attach(port, view, op?.id ?? operation?.id ?? null);
    if (op !== null) void run(op, () => add(op, true));
    return;
  }
  if (command.kind === "retry_disconnect") { await disconnect(view.window_id); return; }
  const op = operation;
  if (op === null || view.operation_id !== op.id || command.operation_id !== op.id || command.account_id !== (session?.user_id ?? null))
    throw failure("E_CAPTURE_CHANGED", "the item or account changed. reopen this popup.");
  await itemCommand(op, command.action);
}
function admit(source: PinnedSource, preview: Preview, activationId: string): Operation | null {
  if (!/^https?:$/u.test(new URL(source.target_url).protocol)) { notice = "only http and https pages can be saved."; push(); return null; }
  if (stopped !== null || revoking || revocationFailure !== null) { notice = stopped?.message ?? "finish disconnecting first."; push(); return null; }
  if (unresolved(operation)) {
    if (operation?.source.target_url !== source.target_url) notice = `another change is in progress for “${operation?.preview.title ?? "the current item"}”. this request has not started.`;
    push(); return null;
  }
  const op: Operation = { id: crypto.randomUUID(), activation_id: activationId, source, preview, phase: "saving", account_id: null,
    lookup: null, bytes: null, write: null, sent: false, unknown: false, failure: null, failure_attempt: 0, retryable: false, item: null, destination: null,
    removal_preview: null, required_origins: [], running: false, reading: null, poll_index: 0 };
  operation = op; notice = null; push(); return op;
}
async function present(windowId: number, op: Operation | null): Promise<void> {
  const pending = { id: crypto.randomUUID(), window_id: windowId, operation_id: op?.id ?? null };
  for (const [port, view] of views) {
    if (view.focused && view.window_id === windowId) { attach(port, view, pending.operation_id); return; }
  }
  presentation = pending;
  try {
    if (!(await browser.windows.get(windowId)).focused) throw failure("E_POPUP_FOCUS", "the source window is no longer focused.");
    await browser.browserAction.openPopup({ windowId });
  } catch {
    // justify-ignore-error: presentation is optional; acquisition remains owned.
    if (presentation === pending) presentation = null;
  }
}
async function report(error: unknown): Promise<CaptureFailure> {
  const timedOut = error instanceof DOMException && error.name === "TimeoutError";
  const shown = error instanceof CaptureFailureError ? error.failure : timedOut
    ? failure("E_CAPTURE_TIMEOUT", "the request did not finish in time.").failure : {
    code: "E_CAPTURE_DEFECT", message: "the extension stopped unexpectedly.", requestId: null, status: null, offline: false,
  };
  if (!(error instanceof CaptureFailureError) && !timedOut) console.error("extension defect:", error);
  if (isCaptureDefect(shown.code)) stopped ??= shown;
  if (shown.status === 401) { token = null; session = null; await browser.storage.local.remove(CREDENTIAL_KEY); }
  return shown;
}
async function run(op: Operation, action: () => Promise<void>): Promise<void> {
  if (op.running || operation !== op) return;
  op.reading?.abort(); op.reading = null;
  op.running = true; op.failure = null; push();
  try { if (stopped !== null) throw new CaptureFailureError(stopped); await action(); }
  catch (error) {
    if (operation !== op) return;
    const shown = await report(error);
    if (operation !== op) return;
    if (op.sent && !writeRefused({ sent: true, status: shown.status, code: shown.code })) op.unknown = true;
    op.failure = shown; op.failure_attempt += 1;
    if (op.write?.kind === "placement" || op.write?.kind === "removal" || op.destination !== null) {
      if (!op.unknown) op.write = null;
      if (op.phase !== "unavailable") op.phase = op.destination === null ? "failed" : "saved";
    } else op.phase = op.unknown ? "unknown" : "failed";
    op.retryable = op.phase === "unavailable" || !TERMINAL.has(shown.code) && !isCaptureDefect(shown.code);
  } finally { op.running = false; op.sent = false; push(); }
}
async function requireOrigins(op: Operation, extra: string[] = []): Promise<boolean> {
  const missing: string[] = [];
  for (const url of [__NEXUS_ORIGIN__, __NEXUS_STORAGE_ORIGIN__, ...extra]) {
    const parsed = new URL(url); const origin = `${parsed.protocol}//${parsed.hostname}/*`;
    if (!missing.includes(origin) && !await browser.permissions.contains({ origins: [origin] })) missing.push(origin);
  }
  if (operation !== op) throw failure("E_CAPTURE_CHANGED", "this request is no longer current.");
  op.required_origins = missing;
  if (missing.length > 0) { op.phase = "permission"; push(); return false; }
  return true;
}
async function ensureSession(op: Operation): Promise<boolean> {
  if (session === null && token !== null) {
    const credential = token; const client = nexus(credential);
    const identity = await client.session(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (credential !== token) throw failure("E_CAPTURE_CHANGED", "the account changed.");
    session = { ...identity, client };
  }
  if (session === null) { op.phase = "auth"; push(); return false; }
  current(op); op.account_id ??= session.user_id; return true;
}
function account(op: Operation): NonNullable<typeof session> {
  current(op);
  if (session === null || op.account_id !== session.user_id) throw failure("E_UNAUTHENTICATED", "sign in to save this item.");
  return session;
}
async function pin(op: Operation): Promise<void> {
  const source = op.source;
  const tab = await browser.tabs.get(source.tab_id);
  if (tab.windowId !== source.window_id || source.frame_id === 0 && tab.url !== source.source_url)
    throw failure("E_CAPTURE_PAGE_GONE", "the source page changed. click add to nexus again.");
  if (source.document_id !== null) return;
  let injection: Injection;
  try { injection = await inject({ tabId: source.tab_id }, sender => sender.tab?.id === source.tab_id && sender.frameId === 0 && sender.url === source.source_url, AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
  catch (error) {
    if (error instanceof CaptureFailureError && error.failure.code === "E_CAPTURE_INJECTION") return;
    throw error;
  }
  source.document_id = injection.documentId;
  const reply = await injection.request({ kind: "pin", source_url: source.source_url });
  if (reply.kind !== "pinned") throw failure("E_CAPTURE_PAGE_GONE", "the source page changed. click add to nexus again.");
  op.preview.title = reply.title && reply.title !== source.source_url ? reply.title : null;
}
async function add(op: Operation, needsPin = false): Promise<void> {
  if (needsPin) await pin(op);
  if (!await requireOrigins(op) || !await ensureSession(op)) return;
  current(op);
  if (navigator.onLine === false && op.write === null) throw failure("E_NETWORK", "you’re offline. this save hasn’t started.", null, null, true);
  op.phase = "saving"; push();
  const { client } = account(op);
  op.lookup ??= await client.saveTarget(op.source.target_url, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  current(op);
  if (op.lookup.item?.has_readable_copy && op.write === null) {
    op.item = op.lookup.item;
    const all = op.item.placements.all_membership;
    op.write = { kind: "placement", library_id: all.library_id, retaining: true,
      request: { included: true, expected_order_revision: all.order_revision, expected_removal_revision: op.lookup.expected_removal_revision } };
  }
  if (op.write?.kind === "placement") { await sendPlacement(op); return; }
  if (op.write === null && op.lookup.source.kind === "XStatus") {
    op.write = { kind: "source", request: { id: crypto.randomUUID(), url: op.source.target_url,
      expected_target: op.lookup.target, expected_removal_revision: op.lookup.expected_removal_revision } };
  }
  if (op.write?.kind === "source") {
    op.sent = true;
    const result = await client.source(op.write.request, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    accepted(op, result.media_id, result.source_attempt_id); void readReceipt(op); return;
  }
  if (op.bytes === null) {
    const acquired = await acquire(op);
    if (acquired === null) return;
    op.bytes = acquired;
  }
  const bytes = op.bytes;
  if (op.lookup.source.kind !== "Browser") throw new Error("browser capture requires browser source");
  op.write ??= { kind: "capture", request: { id: crypto.randomUUID(), kind: bytes.kind, source_url: op.source.target_url,
    filename: bytes.filename, content_type: CONTENT_TYPE[bytes.kind], size_bytes: bytes.size, sha256: bytes.sha256,
    source_binding: { x_article_id: op.lookup.source.x_article_id, target: op.lookup.target } }, upload: null, uploaded: false, confirmation: null };
  const write = op.write;
  if (write.kind !== "capture") throw new Error("capture write required");
  if (!write.uploaded) {
    op.sent = true;
    const answer = await client.create(write.request, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    op.sent = false; op.unknown = false;
    if (answer.kind === "Rejected") throw failure(answer.code, "nexus refused what arrived.", null, 422);
    if (answer.kind === "Published") { accepted(op, answer.media_id, answer.source_attempt_id); void readReceipt(op); return; }
    write.upload = answer;
    await putBytes(answer, bytes.blob, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    write.uploaded = true;
  }
  if (write.upload === null) throw new Error("uploaded bytes have no generation");
  write.confirmation ??= { generation: write.upload.generation, expected_removal_revision: op.lookup.expected_removal_revision };
  op.sent = true;
  let result: Schema<"Published">;
  try { result = await client.confirm(write.request.id, write.confirmation, AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
  catch (error) {
    // This owner checks the same session's persisted receipt before its guards.
    // Its conflicts and persisted verification refusals fence that confirmation,
    // including an unanswered send. Auth, wire and busy refusals prove nothing.
    if (error instanceof CaptureFailureError && error.status !== null
      && (error.status === 409 || VERIFICATION_REJECTIONS.has(error.failure.code))) { op.unknown = false; op.sent = false; }
    throw error;
  }
  accepted(op, result.media_id, result.source_attempt_id); void readReceipt(op);
}
function accepted(op: Operation, mediaId: string, attemptId: string | null): void {
  current(op); op.phase = "saved"; op.write = null; op.bytes = null; op.unknown = false; op.sent = false; op.failure = null;
  op.destination = { media_id: mediaId, source_attempt_id: attemptId, settled: attemptId === null };
  push();
}
async function acquire(op: Operation): Promise<Bytes | null> {
  const { source, lookup } = op;
  const { limits } = account(op);
  if (source.kind !== "link" && source.document_id !== null) {
    const injection = await inject({ tabId: source.tab_id, documentIds: [source.document_id] }, sender => sender.documentId === source.document_id, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const reply = await injection.request({ kind: "extract", source_url: source.source_url,
      x_article: lookup?.source.kind === "Browser" && lookup.source.x_article_id !== null });
    if (reply.kind === "unreadable") throw failure("E_CAPTURE_UNREADABLE", reply.message, null, 422);
    if (reply.kind === "failed") throw new CaptureFailureError(reply.failure);
    if (reply.kind !== "article") throw outsideContract(`answered ${reply.kind}`);
    const bytes = serializePacket(reply.packet);
    if (bytes.byteLength > limits.max_article_packet_bytes) throw failure("E_CAPTURE_TOO_LARGE", "this article is too large.");
    current(op); op.preview = { title: reply.packet.title || op.preview.title, byline: reply.packet.byline };
    return { kind: "web_article", blob: new Blob([bytes], { type: CONTENT_TYPE.web_article }), filename: "article.json", size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }
  const documentLimits = { pdf: limits.max_pdf_bytes, epub: limits.max_epub_bytes };
  let result: DocumentRead;
  if (source.document_id !== null && source.same_origin) {
    const injection = await inject({ tabId: source.tab_id, documentIds: [source.document_id] }, sender => sender.documentId === source.document_id, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const reply = await injection.request({ kind: "download", url: source.target_url, limits: documentLimits });
    if (reply.kind !== "document" && reply.kind !== "failed") throw outsideContract(`answered ${reply.kind}`);
    result = reply;
  } else {
    if (!await requireOrigins(op, [source.target_url])) return null;
    let response: Response;
    try { response = await fetch(source.target_url, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
    catch { throw failure("E_CAPTURE_FETCH", "couldn’t download this link."); }
    result = await readDocument(response, documentLimits);
  }
  if (result.kind === "failed") throw new CaptureFailureError(result.failure);
  const buffer = await result.blob.arrayBuffer(); current(op);
  op.preview.title ??= result.filename;
  return { kind: result.documentKind, blob: new Blob([buffer], { type: CONTENT_TYPE[result.documentKind] }), filename: result.filename,
    size: result.sizeBytes, sha256: await sha256Hex(buffer) };
}
interface Injection {
  documentId: string;
  request(message: ContentRequest): Promise<ContentReply>;
}

/** The native connecting document, not the script result, owns this request. */
async function inject(target: browser.scripting.InjectionTarget,
  accepts: (sender: browser.runtime.MessageSender) => boolean, signal: AbortSignal): Promise<Injection> {
  signal.throwIfAborted();
  const arrived: { port: browser.runtime.Port | null } = { port: null };
  let refuseArrival = (_reason: unknown): void => {};
  const waiter = { accepts, resolve: (_port: browser.runtime.Port): void => {} };
  const arrival = new Promise<browser.runtime.Port>((resolve, reject) => {
    refuseArrival = reject;
    waiter.resolve = port => { arrived.port = port; resolve(port); };
  });
  const abort = () => refuseArrival(failure("E_CAPTURE_TIMEOUT", "reading this page did not finish in time."));
  contentWaiter = waiter;
  signal.addEventListener("abort", abort, { once: true });
  let port: browser.runtime.Port;
  try {
    const [results, connected] = await Promise.all([
      browser.scripting.executeScript({ target, files: ["content.js"] }), arrival,
    ]);
    port = connected;
    const [result] = results;
    if (result === undefined || result.error !== undefined) throw outsideContract(`failed: ${String(result?.error ?? "no result")}`);
  } catch (error) {
    arrived.port?.disconnect();
    if (error instanceof CaptureFailureError) throw error;
    throw failure("E_CAPTURE_INJECTION", "firefox didn’t let nexus read this page.");
  } finally {
    if (contentWaiter === waiter) contentWaiter = null;
    signal.removeEventListener("abort", abort);
  }
  const documentId = port.sender?.documentId;
  if (typeof documentId !== "string") { port.disconnect(); throw outsideContract("arrived with no document identity"); }
  return { documentId, request: message => new Promise<ContentReply>((resolve, reject) => {
    const clean = () => {
      port.onMessage.removeListener(answer);
      port.onDisconnect.removeListener(disconnected);
      signal.removeEventListener("abort", timedOut);
    };
    const answer = (reply: object) => {
      // justify-type-assertion: this port is bound to our same-build injected script.
      clean(); resolve(reply as ContentReply);
    };
    const disconnected = () => { clean(); reject(failure("E_CAPTURE_PAGE_GONE", "couldn’t finish reading this page.")); };
    const timedOut = () => { clean(); port.disconnect(); reject(failure("E_CAPTURE_TIMEOUT", "reading this page did not finish in time.")); };
    port.onMessage.addListener(answer);
    port.onDisconnect.addListener(disconnected);
    signal.addEventListener("abort", timedOut, { once: true });
    if (signal.aborted) timedOut(); else port.postMessage(message);
  }) };
}

function outsideContract(detail: string): CaptureFailureError {
  console.error(`capture page script ${detail}`);
  return failure("E_CAPTURE_CONTENT", "nexus couldn’t read this page.");
}
async function readReceipt(op: Operation): Promise<void> {
  if (operation !== op || op.destination === null || op.reading !== null || op.write !== null || op.phase !== "saved" || !matches(op)) return;
  const identity = session;
  if (identity === null) return;
  const destination = op.destination;
  const controller = new AbortController();
  op.reading = controller;
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const resolved = destination.source_attempt_id === null ? destination : await identity.client.sourceAttempt(destination.source_attempt_id, signal);
    const snapshot = await identity.client.item(resolved.media_id, signal);
    if (operation !== op || session !== identity || op.destination !== destination || op.phase !== "saved" || op.write !== null || op.reading !== controller) return;
    if (snapshot.summary.media_id !== destination.media_id && op.removal_preview !== null) {
      op.phase = "unavailable";
      op.failure = failure("E_CAPTURE_TARGET_CHANGED", "this item’s destination changed. keep the item, then check its current destination.").failure;
      op.failure_attempt += 1;
      op.retryable = true;
      return;
    }
    op.destination = { media_id: snapshot.summary.media_id, source_attempt_id: resolved.source_attempt_id, settled: resolved.settled };
    op.item = snapshot; op.failure = null; op.retryable = false;
  } catch (error) {
    if (operation !== op || session !== identity || op.destination !== destination || op.reading !== controller || controller.signal.aborted) return;
    op.failure = await report(error); op.failure_attempt += 1; op.retryable = true;
    if (op.failure.status === 404) { op.phase = "unavailable"; op.removal_preview = null; }
  } finally { if (op.reading === controller) op.reading = null; push(); }
  if (operation === op && op.phase === "saved" && op.failure === null && op.destination?.settled === false
    && [...views.values()].some(view => view.operation_id === op.id) && op.poll_index < RECEIPT_POLL_MS.length) {
    const delay = RECEIPT_POLL_MS[op.poll_index++];
    setTimeout(() => {
      if ([...views.values()].some(view => view.operation_id === op.id)) void readReceipt(op);
    }, delay);
  }
}
async function sendPlacement(op: Operation): Promise<void> {
  const write = op.write;
  if (write?.kind !== "placement" || op.item === null) throw new Error("placement requires its frozen item");
  const client = account(op).client;
  const mediaId = op.item.summary.media_id;
  const wasUnknown = op.unknown;
  op.sent = true;
  push();
  try {
    await client.place(write.library_id, mediaId, write.request, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    if (!wasUnknown || !(error instanceof CaptureFailureError) || !writeRefused({ sent: true, status: error.status, code: error.failure.code })) throw error;
    let snapshot: ExtensionItem;
    try { snapshot = await client.item(mediaId, AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
    catch { throw error; } // justify-ignore-error: failed observation cannot settle the earlier unanswered write
    current(op);
    const cell = snapshot.placements.placements.find(value => value.library_id === write.library_id);
    const all = snapshot.placements.all_membership;
    const settlement = placementSettlement({ desired: write.request.included, expected_revision: write.request.expected_order_revision,
      expected_removal_revision: write.request.expected_removal_revision,
      observed: write.retaining ? { included: all.retained, revision: all.order_revision }
        : cell === undefined ? null : { included: cell.relation !== "Absent", revision: cell.order_revision },
      removal_revision: snapshot.placements.removal_revision });
    op.item = snapshot;
    if (settlement === "Unknown") throw error;
    op.unknown = false; op.sent = false;
    if (settlement === "Superseded") throw error;
  }
  current(op);
  op.unknown = false; op.sent = false; op.write = null; op.failure = null;
  if (write.retaining) accepted(op, mediaId, op.item.source_attempt?.id ?? null);
  else op.phase = "saved";
  void readReceipt(op);
}
async function itemCommand(op: Operation, command: ItemCommand): Promise<void> {
  if (op.running && command.kind === "permission") return;
  if (op.running) { notice = "another change is in progress. this request has not started."; push(); return; }
  if (command.kind === "forget") {
    operation = null; notice = "forgot this request. a change already sent may still finish."; push(); return;
  }
  if (command.kind === "permission") {
    if (op.phase !== "permission") return;
    if (!command.granted) { op.phase = "failed"; op.retryable = true; op.failure = failure("E_CAPTURE_PERMISSION", "access was not granted. this save hasn’t started.").failure; op.failure_attempt += 1; push(); return; }
    await run(op, () => resume(op)); return;
  }
  if (command.kind === "login") { await run(op, () => login(op)); return; }
  current(op);
  if (command.kind === "retry") {
    if (op.destination !== null && op.write === null) { op.phase = "saved"; void readReceipt(op); return; }
    await run(op, () => resume(op)); return;
  }
  if (op.unknown) throw failure("E_CAPTURE_BUSY", "check the unconfirmed change first.");
  if (command.kind === "read") {
    if (op.phase === "unavailable") op.phase = "saved";
    op.poll_index = 0; void readReceipt(op); return;
  }
  if (command.kind === "cancel_removal") { op.removal_preview = null; push(); return; }
  if (op.phase !== "saved" || op.item === null || op.destination === null) throw failure("E_CAPTURE_PHASE", "this item is not available to change.");
  if (command.kind === "place") {
    const cell = op.item.placements.placements.find(value => value.library_id === command.library_id);
    if (cell === undefined || cell.blocked !== null) throw failure("E_LIBRARY_FORBIDDEN", "this library can’t be changed here.");
    const request = { included: command.included, expected_order_revision: cell.order_revision,
      expected_removal_revision: command.included ? op.item.placements.removal_revision : null };
    await run(op, async () => {
      await requireDestination(op);
      op.removal_preview = null;
      op.write = { kind: "placement", library_id: cell.library_id, retaining: false, request };
      await sendPlacement(op);
    }); return;
  }
  if (command.kind === "review_removal") {
    await run(op, async () => {
      await requireDestination(op);
      const preview = await account(op).client.removalPreview(op.item!.summary.media_id, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      current(op); op.removal_preview = preview;
    }); return;
  }
  if (op.removal_preview === null || op.removal_preview.media_id !== op.item.summary.media_id) throw failure("E_CAPTURE_CHANGED", "review this removal again.");
  const request = { expected_acquisition_revision: op.removal_preview.acquisition_revision };
  await run(op, async () => {
    await requireDestination(op);
    op.write = { kind: "removal", request };
    await sendRemoval(op);
  });
}
/** A fresh choice cannot silently address a source's superseded holder. Reads
 * validate the frozen choice; they never replace its library/removal guards. */
async function requireDestination(op: Operation): Promise<void> {
  const destination = op.destination;
  if (destination === null) throw new Error("saved control requires a destination");
  if (destination.source_attempt_id === null) return;
  const latest = await account(op).client.sourceAttempt(destination.source_attempt_id, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  current(op);
  if (latest.media_id !== destination.media_id) {
    op.phase = "unavailable";
    throw failure("E_CAPTURE_TARGET_CHANGED", "this item’s destination changed. check its current destination before making a new choice.");
  }
}
/** Every return from auth, permission or retry resumes the same command. An
 * accepted receipt only rereads; it can never become another add by resuming. */
async function resume(op: Operation): Promise<void> {
  if (!await requireOrigins(op) || !await ensureSession(op)) return;
  if (op.write?.kind === "removal") await sendRemoval(op);
  else if (op.write?.kind === "placement") await sendPlacement(op);
  else if (op.destination !== null && op.write === null) { op.phase = "saved"; void readReceipt(op); }
  else await add(op);
}
async function sendRemoval(op: Operation): Promise<void> {
  if (op.write?.kind !== "removal" || op.item === null) throw new Error("removal requires its frozen item");
  op.sent = true;
  push();
  try { await account(op).client.removeItem(op.item.summary.media_id, op.write.request, AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
  catch (error) {
    // A newer acquisition fences this exact removal, including an unanswered
    // predecessor. It requires a new review; never borrow the new revision.
    if (error instanceof CaptureFailureError && error.status === 409) { op.unknown = false; op.sent = false; op.removal_preview = null; }
    throw error;
  }
  current(op); op.phase = "removed"; op.write = null; op.unknown = false; op.sent = false; op.removal_preview = null; op.failure = null; push();
}
async function login(op: Operation): Promise<void> {
  if (!await requireOrigins(op)) return;
  const identityOp = op;
  try {
    // Auth recovery must not force forgetting an unanswered original-account
    // command. Retire only the wrong account's credential, keeping that command.
    if (session !== null && op.account_id !== null && session.user_id !== op.account_id) {
      if (token !== null) await nexus(token).revoke(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      token = null; session = null;
      await browser.storage.local.remove(CREDENTIAL_KEY);
    }
    if (token === null) {
      const state = crypto.randomUUID();
      let returned: string;
      try { returned = await browser.identity.launchWebAuthFlow({ interactive: true,
        url: `${__NEXUS_ORIGIN__}/extension/connect/start?redirect_uri=${encodeURIComponent(browser.identity.getRedirectURL())}&state=${state}` }); }
      catch { throw failure("E_CAPTURE_LOGIN", "sign-in didn’t finish."); }
      if (operation !== identityOp) return;
      const reply = new URLSearchParams(new URL(returned).hash.slice(1));
      const issued = reply.get("token");
      if (reply.get("state") !== state || issued === null) throw failure("E_CAPTURE_LOGIN", "sign-in didn’t finish.");
      await browser.storage.local.set({ [CREDENTIAL_KEY]: { token: issued } });
      token = issued; session = null;
    }
    await resume(op);
  } finally { if (operation === identityOp) await present(op.source.window_id, op); }
}
async function disconnect(windowId: number | null): Promise<void> {
  await ready;
  if (unresolved(operation) || revoking) { notice = "another change is in progress. disconnect has not started."; push(); if (windowId !== null) await present(windowId, operation); return; }
  revoking = true;
  if (operation !== null && (operation.phase === "permission" || operation.phase === "auth")) {
    operation.phase = "failed";
    operation.required_origins = [];
    operation.retryable = false;
  }
  const credential = token;
  try {
    if (credential !== null) await nexus(credential).revoke(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (token === credential) { token = null; session = null; await browser.storage.local.remove(CREDENTIAL_KEY); }
    revocationFailure = null; notice = "disconnected from nexus.";
  } catch (error) { revocationFailure = await report(error); session = null; notice = "couldn’t confirm disconnection."; }
  finally { revoking = false; push(); if (windowId !== null) await present(windowId, null); }
}
async function menuClick(info: browser.menus.OnClickData, tab: browser.tabs.Tab | undefined): Promise<void> {
  await ready;
  const windowId = tab?.windowId ?? (await browser.windows.getLastFocused()).id ?? null;
  if (info.menuItemId === DISCONNECT_ID) { await disconnect(windowId); return; }
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || windowId === null || typeof info.linkUrl !== "string") return;
  const frameId = info.frameId ?? 0;
  const sourceUrl = info.frameUrl ?? info.pageUrl ?? tab.url;
  if (sourceUrl === undefined) return;
  const op = admit({ kind: "link", window_id: windowId, tab_id: tab.id, document_id: null, frame_id: frameId,
    source_url: sourceUrl, target_url: info.linkUrl, same_origin: false }, { title: info.linkText?.trim() || null, byline: null }, crypto.randomUUID());
  if (op !== null) void run(op, async () => {
    if (typeof info.targetElementId !== "number") throw failure("E_CAPTURE_LINK", "that link is gone. right-click it again.");
    const injection = await inject({ tabId: op.source.tab_id, frameIds: [frameId] }, sender => sender.tab?.id === op.source.tab_id && sender.frameId === frameId && sender.url === sourceUrl,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    op.source.document_id = injection.documentId;
    const reply = await injection.request({ kind: "bind", targetElementId: info.targetElementId, linkUrl: op.source.target_url });
    if (reply.kind !== "bound") throw failure("E_CAPTURE_LINK", "that link is gone. right-click it again.");
    op.source.same_origin = reply.sameOrigin; await add(op);
  });
  await present(windowId, op ?? operation);
}
async function addX(raw: unknown, sender: browser.runtime.MessageSender): Promise<{ accepted: boolean; message: string | null }> {
  await ready;
  try {
    if (sender.id !== browser.runtime.id || sender.frameId !== 0 || typeof sender.documentId !== "string"
      || sender.tab?.id === undefined || sender.tab.windowId === undefined || sender.url === undefined)
      throw failure("E_CAPTURE_SOURCE", "nexus couldn’t identify this source.");
    const v = expectExactRecord(raw, ["kind", "activation_id", "source_url", "target_url", "preview"], "x command");
    const sourceUrl = expectString(v.source_url, "source url");
    const source = new URL(sourceUrl);
    const targetUrl = expectString(v.target_url, "target url");
    if (v.kind !== "add_x" || sourceUrl !== sender.url || source.protocol !== "https:" || !["x.com", "twitter.com", "mobile.twitter.com"].includes(source.hostname) || xTarget(targetUrl) === null)
      throw failure("E_CAPTURE_SOURCE", "nexus couldn’t identify this source.");
    const preview = expectExactRecord(v.preview, ["title", "byline"], "preview");
    const title = expectNullableString(preview.title, "title"); const byline = expectNullableString(preview.byline, "byline");
    if ((title?.length ?? 0) > 1024 || (byline?.length ?? 0) > 1024) throw failure("E_CAPTURE_SOURCE", "nexus couldn’t identify this source.");
    const op = admit({ kind: "x", window_id: sender.tab.windowId, tab_id: sender.tab.id, document_id: sender.documentId,
      frame_id: 0, source_url: sourceUrl, target_url: targetUrl, same_origin: true }, { title, byline }, expectCanonicalRfcUuid(v.activation_id, "activation id"));
    if (op !== null) void run(op, () => add(op, true));
    await present(sender.tab.windowId, op ?? operation);
    return { accepted: op !== null || operation?.source.target_url === targetUrl, message: notice };
  } catch (error) { const shown = await report(error); return { accepted: false, message: shown.message }; }
}
