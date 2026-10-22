// The one owner of a Firefox capture: a persistent MV2 background page. It pins a
// target by native document identity, reads it through content.ts, holds the
// credential (storage.local) and the draft (memory only: a Firefox restart
// forgets it), and saves in three steps: create the session (the draft's id) ->
// PUT the bytes to the signed url -> confirm. A missing confirmation retries its
// frozen command; a revision refusal requires explicit review, then confirms the
// same generation and bytes. A failed byte PUT recreates only the upload window.
// The popup renders the state
// pushed on its port and sends Commands; content scripts never see the bearer.
//
// invariants:
// - one draft; activation pins only an empty slot or replaces a saved receipt
// - a target is pinned by document id; a replacement document (even a same-url
//   reload) fails every later read instead of being read
// - unknown confirmation keeps its exact guards; reads never settle or rebase it
// - reviewed final confirmation owns placement; receipts display current facts
// - session, generation, guards and bytes are memory-only; owner loss recaptures
// - a command that needs origins waits for the grant the popup requests, before
//   its first network call; a denial changes nothing; one long command at a time

import { isAbortError } from "@/lib/errors";
import type { Schema } from "@/lib/api/wire";
import {
  CONTENT_PORT,
  CONTENT_TYPE,
  CaptureFailureError,
  VIEW_PORT,
  failure,
  readDocument,
  serializePacket,
  setDestination,
  sha256Hex,
  urlFilename,
  type CaptureFailure,
  type CapturePhase,
  type Command,
  type CommandResult,
  type DocumentKind,
  type DocumentRead,
  type TargetView,
  type ViewState,
  type ViewCommand,
  type ViewMessage,
} from "@/extension/capture";
import {
  nexus,
  putBytes,
  type ExtensionSession,
  type CaptureTarget,
  type Nexus,
  type UploadAnswer,
} from "@/extension/nexusClient";
import type { ContentReply, ContentRequest } from "@/extension/content";

declare const __NEXUS_ORIGIN__: string;
declare const __NEXUS_STORAGE_ORIGIN__: string;

const MENU_ID = "nexus-capture-link";
const CREDENTIAL_KEY = "nexusCaptureCredential";
/** Codes after which the same request can never succeed: no Retry. */
const TERMINAL = new Set([
  "E_SOURCE_INTEGRITY",
  "E_INVALID_FILE_TYPE",
  "E_FILE_TOO_LARGE",
  "E_CAPTURE_TOO_LARGE",
  "E_INVALID_REQUEST",
  "E_UPLOAD_INTENT_MISMATCH",
  "E_RESOURCE_CONFLICT",
  "E_LIBRARY_FORBIDDEN",
  "E_FORBIDDEN",
  "E_CAPTURE_PAGE_GONE",
]);

const INTERRUPTED: CaptureFailure = {
  code: "E_CAPTURE_INTERRUPTED",
  message: "The capture was interrupted.",
  requestId: null,
};

type DocumentSource =
  | {
      kind: "page";
      tabId: number;
      documentId: string;
      pageUrl: string;
      sameOrigin: boolean;
    }
  | { kind: "extension" };

type DocumentTarget = {
  kind: "document";
  windowId: number;
  url: string;
  source: DocumentSource;
};

interface Draft {
  /** the capture session's id: minted at pin, sent by every save of this draft */
  id: string;
  target: { kind: "article"; windowId: number; url: string } | DocumentTarget;
  view: TargetView;
  phase: CapturePhase;
  destinations: Schema<"LibraryDestinationOut">[];
  locked: boolean;
  submission: {
    accountId: string;
    /** Creation retries retain the original draft; confirm owns final choices. */
    initialLibraryIds: string[];
    removalRevision: string;
    upload: Schema<"UploadRequired"> | null;
    bytesUploaded: boolean;
    confirmation: Schema<"ConfirmUploadRequest"> | null;
  } | null;
  /** Frozen with the article bytes; null is an unsigned preview or a document. */
  captureTarget: (CaptureTarget & { accountId: string }) | null;
  /** what a save sends; a document's arrive with its first save */
  bytes: {
    kind: "web_article" | DocumentKind;
    blob: Blob;
    filename: string;
    sizeBytes: number;
    sha256: string;
  } | null;
}

let token: string | null = null;
let session: (ExtensionSession & { client: Nexus }) | null = null;
let revocationFailure: CaptureFailure | null = null;
let draft: Draft | null = null;
let unsupported: string | null = null;
let active: { controller: AbortController; done: Promise<void> } | null = null;
/** `active` waits for an origin grant: a repeated command may take it over */
let awaitingGrant = false;
let contentWaiter: {
  accepts: (sender: browser.runtime.MessageSender) => boolean;
  resolve: (port: browser.runtime.Port) => void;
} | null = null;
const viewPorts = new Map<browser.runtime.Port, { acknowledged: number }>();
let pushing = Promise.resolve();

// a persistent background page's menu items are not persisted: create on load
browser.menus.create({
  id: MENU_ID,
  title: "Add link to Nexus…",
  contexts: ["link"],
  targetUrlPatterns: ["http://*/*", "https://*/*"],
});

const ready = browser.storage.local.get(CREDENTIAL_KEY).then((stored) => {
  token =
    (stored[CREDENTIAL_KEY] as { token?: string } | undefined)?.token ?? null;
});

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.runtime.MessageSender) => {
    // commands come from this extension's popup only: our id, no tab
    if (sender.id !== browser.runtime.id || sender.tab !== undefined)
      return undefined;
    return handle(message as Command);
  },
);

browser.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  const ours = sender?.id === browser.runtime.id;
  if (ours && port.name === VIEW_PORT && sender?.tab === undefined) {
    const view = { acknowledged: 0 };
    viewPorts.set(port, view);
    port.onMessage.addListener((message: object) => {
      // justify-type-assertion: this sender and port belong to the same extension build
      const sent = message as ViewCommand;
      view.acknowledged = sent.sequence;
      if (draft?.id !== sent.draftId || session?.user_id !== sent.accountId) {
        pushState(port, failure("E_CAPTURE_CHANGED", "This capture or account changed. Open the chooser again.").failure);
        return;
      }
      if (sent.kind === "set_destination") {
        if (draft.locked || active !== null) {
          pushState(port, failure("E_CAPTURE_LOCKED", "Libraries cannot change while this capture is saving.").failure);
          return;
        }
        setDraft({ ...draft, destinations: setDestination(draft.destinations, sent) });
      } else {
        // exclusive claims its slot synchronously: every earlier delta is now
        // applied, and every later one is refused before save's first await.
        void exclusive(save, true).catch(async error => pushState(port, await describe(error)));
        pushState();
      }
    });
    port.onDisconnect.addListener(() => viewPorts.delete(port));
    void ready.then(() => pushState());
  } else if (
    ours &&
    port.name === CONTENT_PORT &&
    sender &&
    contentWaiter?.accepts(sender)
  ) {
    contentWaiter.resolve(port);
    contentWaiter = null;
  } else {
    port.disconnect();
  }
});

browser.menus.onClicked.addListener((info, tab) => void menuClick(info, tab));

async function handle(sent: Command): Promise<CommandResult> {
  await ready;
  const credential = token;
  try {
    switch (sent.kind) {
      case "activate":
        await activate();
        break;
      case "list_destinations": {
        const snapshot = await requireSession().client.destinations();
        return { kind: "destinations", snapshot };
      }
      case "login":
        await login();
        break;
      case "retry":
        await exclusive(save, true);
        break;
      case "review":
        await exclusive(review, true);
        break;
      case "discard":
        await interrupt();
        discard();
        break;
      case "capture_again":
        await interrupt();
        discard();
        await activate();
        break;
      case "disconnect":
        await interrupt();
        await exclusive(disconnect, true);
        break;
    }
    return { kind: "state", state: await viewState() };
  } catch (error) {
    return { kind: "failure", failure: await describe(error, sent.kind === "list_destinations" ? credential : token) };
  }
}

/** One long command at a time. A command that waits for origins may take over a
    running one still waiting for its grant (nothing was sent yet). */
async function exclusive(
  run: (signal: AbortSignal) => Promise<void>,
  takesOverGrantWait = false,
): Promise<void> {
  if (active !== null && awaitingGrant && takesOverGrantWait) await interrupt();
  // Another takeover may have claimed the slot while this one awaited release.
  if (active !== null) {
    throw failure("E_CAPTURE_BUSY", "Nexus is still working on this capture.");
  }
  const controller = new AbortController();
  const done = Promise.resolve().then(() => run(controller.signal)).catch((error: unknown) => {
    if (!isAbortError(error)) throw error;
  });
  active = { controller, done };
  pushState();
  try {
    await done;
  } finally {
    if (active?.controller === controller) {
      active = null;
      pushState();
    }
  }
}

/** Abort the running command and wait for it; a save it cut short reads failed. */
async function interrupt(): Promise<void> {
  const current = active;
  if (current === null) return;
  current.controller.abort();
  await current.done.catch(() => undefined);
  if (active === current) active = null;
  if (active !== null) return;
  const phase = draft?.phase.kind;
  if (
    phase === "acquiring" ||
    phase === "uploading" ||
    phase === "confirming"
  ) {
    setPhase({ kind: "failed", failure: INTERRUPTED,
      recovery: (draft?.submission?.confirmation ?? null) !== null ? "Check" : "Retry" });
  }
}

// --- view state ----------------------------------------------------------------

async function viewState(): Promise<ViewState> {
  const needsRecapture = draft?.target.kind === "article" &&
    (draft.captureTarget === null || draft.captureTarget.accountId !== session?.user_id);
  const state = {
    account:
      session === null
        ? null
        : {
            userId: session.user_id,
            email: session.email,
            displayName: session.display_name,
          },
    revocationFailure,
    draft:
      draft === null
        ? null
        : {
            id: draft.id,
            target: draft.view,
            phase: draft.phase,
            destinations: draft.destinations,
            locked: draft.locked,
            editable: session !== null && !draft.locked && active === null && !needsRecapture,
            needsRecapture,
          },
    unsupported,
  };
  return { ...state, requiredOrigins: await requiredOrigins() };
}

/** Pushes go out in order, each with the state as it is when it is sent. */
function pushState(failedPort?: browser.runtime.Port, failure: CaptureFailure | null = null): void {
  pushing = pushing
    .then(async () => {
      // Capture the acknowledged prefix with the same facts as viewState,
      // before its permission lookup yields to another edit.
      const views = [...viewPorts].map(([port, view]) => ({ port, acknowledged: view.acknowledged }));
      const state = await viewState();
      for (const { port, acknowledged } of views) {
        try {
          const message: ViewMessage = { state, acknowledged, failure: port === failedPort ? failure : null };
          port.postMessage(message);
        } catch {
          // justify-ignore-error: Firefox marks a port dead before onDisconnect fires
          viewPorts.delete(port);
        }
      }
    })
    // justify-ignore-error: a push that cannot be read is replaced by the next one
    .catch(() => undefined);
}

function setDraft(next: Draft | null, reason: string | null = null): void {
  draft = next;
  unsupported = next === null ? reason : null;
  pushState();
}

function setPhase(phase: CapturePhase): void {
  if (draft !== null) setDraft({ ...draft, phase });
}

/** nexus and storage always; the target's origin while the background must still
    download the document itself; minus what Firefox already granted. Match
    patterns carry no port: the host matches every port. */
async function requiredOrigins(): Promise<string[]> {
  const origins = [__NEXUS_ORIGIN__, __NEXUS_STORAGE_ORIGIN__];
  const target = draft?.target;
  if (
    target?.kind === "document" &&
    draft?.bytes === null &&
    downloadsInBackground(target.source)
  ) {
    origins.push(target.url);
  }
  const missing: string[] = [];
  for (const origin of origins) {
    const { protocol, hostname } = new URL(origin);
    const pattern = `${protocol}//${hostname}/*`;
    if (!(await browser.permissions.contains({ origins: [pattern] })))
      missing.push(pattern);
  }
  return missing;
}

function downloadsInBackground(source: DocumentSource): boolean {
  return source.kind === "extension" || !source.sameOrigin;
}

/** Wait until Firefox reports every required origin. The popup asks inside its
    click and may close under the doorhanger, so the grant arrives here as
    `permissions.onAdded`; a denial fires nothing and the wait ends only with a
    grant or an abort. The listener is installed before the check. */
async function awaitOrigins(signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    let wake = (): void => undefined;
    const granted = new Promise<void>((resolve) => (wake = resolve));
    browser.permissions.onAdded.addListener(wake);
    signal.addEventListener("abort", wake, { once: true });
    try {
      if ((await requiredOrigins()).length === 0) return;
      awaitingGrant = true;
      await granted;
    } finally {
      awaitingGrant = false;
      browser.permissions.onAdded.removeListener(wake);
      signal.removeEventListener("abort", wake);
    }
  }
}

// --- failures ------------------------------------------------------------------

/** The failure to show; a 401 also forgets the credential nexus no longer honours. */
async function describe(error: unknown, credential = token): Promise<CaptureFailure> {
  if (error instanceof CaptureFailureError) {
    if (error.status === 401 && credential === token) await forgetCredential();
    return error.failure;
  }
  if (isAbortError(error)) return INTERRUPTED;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "E_CAPTURE_DEFECT",
    message: `Nexus capture stopped unexpectedly: ${detail}`,
    requestId: null,
  };
}

function requireSession(): NonNullable<typeof session> {
  if (session === null)
    throw failure("E_CAPTURE_SIGNED_OUT", "Sign in to Nexus first.");
  return session;
}

function requireDraft(): Draft {
  if (draft === null)
    throw failure("E_CAPTURE_PHASE", "There is nothing to save.");
  return draft;
}

// --- identity ------------------------------------------------------------------

async function ensureSession(signal?: AbortSignal): Promise<void> {
  if (session !== null || token === null || revocationFailure !== null) return;
  const credential = token;
  const client = nexus(credential);
  let identity: ExtensionSession;
  try {
    identity = await client.session(signal);
  } catch (error) {
    if (token !== credential || signal?.aborted) return;
    throw error;
  }
  if (token !== credential || signal?.aborted) return;
  session = { ...identity, client };
  pushState();
}

async function forgetCredential(): Promise<void> {
  await browser.storage.local.remove(CREDENTIAL_KEY);
  token = null;
  session = null;
  revocationFailure = null;
  pushState();
}

async function login(): Promise<void> {
  if (revocationFailure !== null) {
    throw failure(
      "E_CAPTURE_REVOCATION_PENDING",
      "Finish disconnecting before signing in again.",
    );
  }
  if (token !== null) {
    // a held credential is confirmed, never replaced: only a revocation or a 401
    // forgets it, so a token nexus still honours is never orphaned
    await exclusive(async (signal) => {
      await awaitOrigins(signal);
      await ensureSession(signal);
    }, true);
    return;
  }
  // the window to come back to: the pinned target's, else the popup's
  const windowId =
    draft?.target.windowId ??
    (await browser.windows.getLastFocused()).id ??
    null;
  // only a flow that opened the sign-in window took the focus and owes a reopen
  let opened = false;
  try {
    await exclusive(async (signal) => {
      await awaitOrigins(signal);
      opened = true;
      const state = crypto.randomUUID();
      const redirect = encodeURIComponent(browser.identity.getRedirectURL());
      let reply: URLSearchParams;
      try {
        const finalUrl = await browser.identity.launchWebAuthFlow({
          url: `${__NEXUS_ORIGIN__}/extension/connect/start?redirect_uri=${redirect}&state=${state}`,
          interactive: true,
        });
        reply = new URLSearchParams(new URL(finalUrl).hash.slice(1));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw failure("E_CAPTURE_LOGIN", `Sign-in did not complete: ${detail}`);
      }
      if (reply.get("state") !== state) {
        throw failure(
          "E_CAPTURE_LOGIN_STATE",
          "The sign-in reply did not match this sign-in.",
        );
      }
      const issued = reply.get("token");
      if (!issued) {
        const reason = reply.get("error") ?? "no token";
        throw failure(
          "E_CAPTURE_LOGIN",
          `Nexus sign-in failed: ${reason}.`,
          reply.get("request_id"),
        );
      }
      await browser.storage.local.set({ [CREDENTIAL_KEY]: { token: issued } });
      token = issued;
      session = null;
      await ensureSession(signal);
    }, true);
  } finally {
    if (opened && windowId !== null) await reopenPopup(windowId);
  }
}

/** Firefox ≥ 149 reopens the popup without a gesture, in the focused window only. */
async function reopenPopup(windowId: number): Promise<void> {
  try {
    await browser.windows.update(windowId, { focused: true });
    await browser.browserAction.openPopup({ windowId });
  } catch {
    // justify-ignore-error: the window may be gone; the next toolbar click shows the state
  }
}

/** Revocation keeps the credential until nexus confirms it (the only handle on a
    token it still honours); a failure is shown with Retry. */
async function disconnect(signal: AbortSignal): Promise<void> {
  if (token === null)
    throw failure("E_CAPTURE_SIGNED_OUT", "Not connected to Nexus.");
  await awaitOrigins(signal);
  try {
    await nexus(token).revoke(signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    revocationFailure = await describe(error);
    session = null;
    pushState();
    return;
  }
  await forgetCredential();
}

// --- pinning -------------------------------------------------------------------

async function activate(): Promise<void> {
  if (active !== null) return;
  await exclusive(async (signal) => {
    // Identity uses the same owner as disconnect, so a late read cannot reconnect
    // a revoked credential. An unreachable account still permits source preview.
    await ensureSession(signal).catch(describe);
    signal.throwIfAborted();
    if (draft !== null && draft.phase.kind !== "saved") return;
    const [tab] = await browser.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id === undefined || tab.windowId === undefined || !tab.url) {
      return setDraft(draft, "Nexus cannot read this tab.");
    }
    if (!/^https?:$/.test(new URL(tab.url).protocol)) {
      return setDraft(draft, "Only http(s) pages can be saved.");
    }
    // the receipt stays until the user leaves its page
    if (draft !== null && pageOf(draft) === tab.url) return;
    const { id: tabId, windowId, url } = tab;
    let injection: Injection;
    try {
      injection = await inject(
        { tabId },
        (sender) => sender.tab?.id === tabId && sender.frameId === 0,
        signal,
      );
    } catch (error) {
      // an http(s) tab Firefox will not script is a document the background downloads
      if (!(
        error instanceof CaptureFailureError &&
        error.failure.code === "E_CAPTURE_INJECTION"
      )) {
        throw error;
      }
      return setDraft(
        documentDraft(windowId, url, { kind: "extension" }, urlFilename(url)),
      );
    }
    let captureTarget: Draft["captureTarget"];
    let reply: ContentReply;
    try {
      const account = session;
      captureTarget = account === null ? null : {
        ...await account.client.captureTarget(url, signal),
        accountId: account.user_id,
      };
      reply = await injection.request({ kind: "extract", source_url: url,
        x_article: captureTarget !== null && captureTarget.x_article_binding !== null });
    } finally {
      injection.close();
    }
    if (reply.kind === "unreadable") return setDraft(null, reply.message);
    if (reply.kind !== "article") {
      throw failure(
        "E_CAPTURE_CONTENT",
        `The page script answered ${reply.kind}.`,
      );
    }
    const bytes = serializePacket(reply.packet);
    // a url may carry signed access parameters: the host stands in for a title
    const host = new URL(reply.packet.url).hostname;
    setDraft({
      id: crypto.randomUUID(),
      target: { kind: "article", windowId, url: reply.packet.url },
      view: {
        kind: "article",
        title: reply.packet.title || host,
        host,
        previewText: reply.previewText,
        replacement: captureTarget?.x_article_binding?.native_target
          ? { title: captureTarget.target_title } : null,
      },
      phase: { kind: "draft" },
      destinations: [],
      locked: false,
      submission: null,
      captureTarget,
      bytes: {
        kind: "web_article",
        blob: new Blob([bytes], { type: CONTENT_TYPE.web_article }),
        filename: "article.json",
        sizeBytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      },
    });
  });
}

function pageOf(current: Draft): string {
  const target = current.target;
  return target.kind === "document" && target.source.kind === "page"
    ? target.source.pageUrl
    : target.url;
}

function documentDraft(
  windowId: number,
  url: string,
  source: DocumentSource,
  label: string | null,
): Draft {
  const host = new URL(url).hostname;
  return {
    id: crypto.randomUUID(),
    target: { kind: "document", windowId, url, source },
    view: {
      kind: "document",
      title: label || host,
      host,
      documentKind: "unknown",
    },
    phase: { kind: "draft" },
    destinations: [],
    locked: false,
    submission: null,
    captureTarget: null,
    bytes: null,
  };
}

/** Context menu: bind the clicked link in its frame now, keep that document's id,
    then bring the popup up on it. A busy or unsaved slot is left alone. */
async function menuClick(
  info: browser.menus.OnClickData,
  tab: browser.tabs.Tab | undefined,
): Promise<void> {
  await ready;
  if (
    info.menuItemId !== MENU_ID ||
    tab?.id === undefined ||
    tab.windowId === undefined
  )
    return;
  const { id: tabId, windowId } = tab;
  const frameId = info.frameId ?? 0;
  if (active === null && (draft === null || draft.phase.kind === "saved")) {
    try {
      await exclusive(async (signal) => {
        const { linkUrl, targetElementId } = info;
        if (
          typeof linkUrl !== "string" ||
          typeof targetElementId !== "number"
        ) {
          throw failure(
            "E_CAPTURE_LINK",
            "Firefox did not report the clicked link.",
          );
        }
        const injection = await inject(
          { tabId, frameIds: [frameId] },
          (sender) => sender.tab?.id === tabId && sender.frameId === frameId,
          signal,
        );
        const reply = await injection.request({
          kind: "bind",
          targetElementId,
          linkUrl,
        });
        if (reply.kind !== "bound") {
          return setDraft(
            null,
            "The clicked link is no longer on the page. Right-click it again.",
          );
        }
        const source: DocumentSource = {
          kind: "page",
          tabId,
          documentId: injection.documentId,
          pageUrl: info.pageUrl ?? "",
          sameOrigin: reply.sameOrigin,
        };
        const label = info.linkText?.trim() || urlFilename(linkUrl);
        setDraft(documentDraft(windowId, linkUrl, source, label));
      });
    } catch (error) {
      setDraft(null, (await describe(error)).message);
    }
  }
  await reopenPopup(windowId);
}

// --- page scripts --------------------------------------------------------------

interface Injection {
  /** the native id Firefox attached to the connecting document */
  documentId: string;
  request(message: ContentRequest): Promise<ContentReply>;
  close(): void;
}

/** Inject content.js into `target` and wait for the one port it opens. */
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
  let result: browser.scripting.InjectionResult | undefined;
  try {
    [result] = await browser.scripting.executeScript({
      target,
      files: ["content.js"],
    });
  } catch (error) {
    contentWaiter = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw failure(
      "E_CAPTURE_INJECTION",
      `Firefox did not let Nexus read this page: ${detail}`,
    );
  }
  if (result === undefined || result.error !== undefined) {
    contentWaiter = null;
    throw failure(
      "E_CAPTURE_CONTENT",
      `The page script failed: ${String(result?.error ?? "no result")}`,
    );
  }
  const port = await arrival;
  const documentId = port.sender?.documentId;
  if (typeof documentId !== "string") {
    port.disconnect();
    throw failure(
      "E_CAPTURE_CONTENT",
      "Firefox attached no document identity to the page script.",
    );
  }
  return {
    documentId,
    close: () => port.disconnect(),
    request: (message) =>
      new Promise<ContentReply>((resolve, reject) => {
        port.onMessage.addListener((reply) => resolve(reply as ContentReply));
        port.onDisconnect.addListener(() =>
          reject(
            failure(
              "E_CAPTURE_PAGE_GONE",
              "The page changed before Nexus finished reading it.",
            ),
          ),
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

// --- save ----------------------------------------------------------------------

/** Only an explicit review may refresh refused guards. It retains the choices
    for inspection, including unavailable ones, and requires a separate Save. */
async function review(signal: AbortSignal): Promise<void> {
  const current = requireDraft();
  if (current.phase.kind !== "failed" || current.phase.recovery !== "Review" || current.submission === null) {
    throw failure("E_CAPTURE_PHASE", "There is no save to review.");
  }
  const account = requireSession();
  if (current.submission.accountId !== account.user_id) {
    throw failure("E_CAPTURE_TARGET_CHANGED", "Capture this page again for this account.");
  }
  await awaitOrigins(signal);
  const snapshot = await account.client.destinations(signal);
  const available = new Map(snapshot.destinations.map(item => [item.id, item]));
  setDraft({
    ...current,
    phase: { kind: "review" },
    locked: false,
    destinations: current.destinations.map(item => available.get(item.id) ?? item),
    submission: { ...current.submission, removalRevision: snapshot.removal_revision, confirmation: null },
  });
}

/** Freeze guards at original submission. After bytes land, retry only the exact
    confirmation. A definitive revision refusal permits review and confirm-only
    reuse; expiry or loss of this owner requires recapture. */
async function save(signal: AbortSignal): Promise<void> {
  if (draft === null || draft.phase.kind === "saved") {
    throw failure("E_CAPTURE_PHASE", "There is nothing to save.");
  }
  if (draft.phase.kind === "failed" && draft.phase.recovery !== "Retry" && draft.phase.recovery !== "Check") {
    throw failure("E_CAPTURE_PHASE", "Review this save or capture the page again.");
  }
  const { client, limits, user_id: accountId } = requireSession();
  await awaitOrigins(signal);
  setDraft({ ...requireDraft(), locked: true });
  try {
    const current = requireDraft();
    if ((current.submission !== null && current.submission.accountId !== accountId) ||
        (current.target.kind === "article" &&
        (current.captureTarget === null || current.captureTarget.accountId !== accountId))) {
      throw failure("E_CAPTURE_TARGET_CHANGED", "Capture this page again before saving it to this account.");
    }
    if (current.submission === null) {
      const snapshot = await client.destinations(signal);
      setDraft({ ...requireDraft(), submission: {
        accountId,
        initialLibraryIds: current.destinations.map(item => item.id),
        removalRevision: snapshot.removal_revision,
        upload: null,
        bytesUploaded: false,
        confirmation: null,
      } });
    }
    let bytes = requireDraft().bytes;
    if (bytes === null) {
      setPhase({ kind: "acquiring" });
      const { target, view } = requireDraft();
      const documentLimits = {
        pdf: limits.max_pdf_bytes,
        epub: limits.max_epub_bytes,
      };
      const read = await acquireDocument(
        target as DocumentTarget,
        documentLimits,
        signal,
      );
      if (read.kind === "failed") throw new CaptureFailureError(read.failure);
      // a background-owned copy: the page that handed the blob over may go away
      const buffer = await read.blob.arrayBuffer();
      bytes = {
        kind: read.documentKind,
        blob: new Blob([buffer], { type: CONTENT_TYPE[read.documentKind] }),
        filename: read.filename,
        sizeBytes: read.sizeBytes,
        sha256: await sha256Hex(buffer),
      };
      const classified: TargetView = {
        kind: "document",
        title: view.title,
        host: view.host,
        documentKind: read.documentKind,
      };
      setDraft({ ...requireDraft(), bytes, view: classified });
    }
    const limit =
      bytes.kind === "pdf"
        ? limits.max_pdf_bytes
        : bytes.kind === "epub"
          ? limits.max_epub_bytes
          : limits.max_article_packet_bytes;
    if (bytes.sizeBytes > limit) {
      const megabytes = Math.round(limit / 2 ** 20);
      throw failure(
        "E_FILE_TOO_LARGE",
        `This ${bytes.kind} is larger than ${megabytes} MB.`,
      );
    }
    const { id, target, destinations, captureTarget, submission } = requireDraft();
    if (submission === null) throw new Error("Capture submission was not frozen.");
    let answer: UploadAnswer;
    if (!submission.bytesUploaded) {
      setPhase({ kind: "uploading" });
      answer = await client.create(
        {
          id,
          kind: bytes.kind,
          source_url: target.url,
          filename: bytes.filename,
          content_type: CONTENT_TYPE[bytes.kind],
          size_bytes: bytes.sizeBytes,
          sha256: bytes.sha256,
          x_article_binding: captureTarget?.x_article_binding ?? null,
          library_ids: submission.initialLibraryIds,
        },
        signal,
      );
      if (answer.kind === "UploadRequired") {
        submission.upload = answer;
        await putBytes(answer, bytes.blob, signal);
        submission.bytesUploaded = true;
      }
    } else {
      if (submission.upload === null) throw new Error("Uploaded capture has no generation.");
      answer = submission.upload;
    }
    if (answer.kind === "UploadRequired") {
      submission.confirmation ??= {
        generation: answer.generation,
        expected_removal_revision: submission.removalRevision,
        destinations: destinations.map(item => ({
          library_id: item.id,
          expected_order_revision: item.order_revision,
        })),
      };
      setPhase({ kind: "confirming" });
      answer = await client.confirm(id, submission.confirmation, signal);
    }
    if (answer.kind === "Rejected") {
      throw failure(
        answer.code,
        `Nexus rejected the captured bytes (${answer.code}).`,
      );
    }
    const openUrl = answer.current_placements === null ? null
      : `${__NEXUS_ORIGIN__}/media/${encodeURIComponent(answer.media_id)}`;
    setDraft({
      ...requireDraft(),
      phase: { kind: "saved", openUrl },
      destinations: answer.current_placements?.placements
        .filter(item => item.relation !== "Absent")
        .map(item => ({ id: item.library_id, name: item.name, order_revision: item.order_revision })) ?? [],
      bytes: null,
      submission: null,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    // a 401 forgets the credential; Retry returns with the account
    const shown = await describe(error);
    const current = requireDraft();
    const confirming = (current.submission?.confirmation ?? null) !== null;
    let recovery: Extract<CapturePhase, { kind: "failed" }>["recovery"];
    if (shown.code === "E_RESOURCE_CONFLICT" && confirming) {
      if (current.submission === null) throw new Error("Refused confirmation has no owner.");
      current.submission.confirmation = null;
      recovery = "Review";
    } else if (shown.code === "E_UPLOAD_CAPABILITY_EXPIRED" || shown.code === "E_UPLOAD_GENERATION_STALE" || shown.code === "E_STORAGE_MISSING" ||
               shown.code === "E_UPLOAD_SESSION_NOT_FOUND" || shown.code === "E_CAPTURE_TARGET_CHANGED" ||
               shown.code === "E_WIRE_MISMATCH") {
      recovery = "Recapture";
    } else if (confirming && (!(error instanceof CaptureFailureError) || error.status === null || error.status === 401 || error.status >= 500 || shown.code === "E_UNKNOWN")) {
      recovery = "Check";
    } else {
      recovery = TERMINAL.has(shown.code) ? "Discard" : "Retry";
    }
    setPhase({
      kind: "failed",
      failure: recovery === "Review" ? { ...shown, message: "save needs review. review your choices and save again." }
        : shown.code === "E_UPLOAD_CAPABILITY_EXPIRED" ? { ...shown, message: "upload expired. capture the page again." } : shown,
      recovery,
    });
  }
}

/** One bounded get in the context chosen at pinning: the page's own principal for
    a same-origin link (its cookies), else the background with the granted origin. */
async function acquireDocument(
  target: DocumentTarget,
  limits: Record<DocumentKind, number>,
  signal: AbortSignal,
): Promise<DocumentRead> {
  const source = target.source;
  if (source.kind === "extension" || downloadsInBackground(source)) {
    let response: Response;
    try {
      response = await fetch(target.url, {
        credentials: "include",
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw failure(
        "E_CAPTURE_FETCH",
        "The link could not be downloaded. Check the connection and retry.",
      );
    }
    return readDocument(response, limits);
  }
  let injection: Injection;
  try {
    injection = await inject(
      { tabId: source.tabId, documentIds: [source.documentId] },
      (sender) => sender.documentId === source.documentId,
      signal,
    );
  } catch (error) {
    if (!(
      error instanceof CaptureFailureError &&
      error.failure.code === "E_CAPTURE_INJECTION"
    )) {
      throw error;
    }
    throw failure(
      "E_CAPTURE_PAGE_GONE",
      "The page holding this link is gone. Right-click the link again.",
    );
  }
  const reply = await injection.request({
    kind: "download",
    url: target.url,
    limits,
  });
  if (reply.kind !== "document" && reply.kind !== "failed") {
    throw failure(
      "E_CAPTURE_CONTENT",
      `The page script answered ${reply.kind}.`,
    );
  }
  return reply;
}

/** Discard forgets the draft now. A session nexus created is removed in passing;
    if that fails, Imports still offers Remove. */
function discard(): void {
  const current = draft;
  setDraft(null);
  if (
    current !== null &&
    current.locked &&
    current.phase.kind !== "saved" &&
    session !== null
  ) {
    void session.client.remove(current.id).catch(() => undefined);
  }
}
