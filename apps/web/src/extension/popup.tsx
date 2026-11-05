// A receipt over the background owner. Module lifetime owns the activation;
// React mounts and reconnects only subscribe. Firefox can preload this document
// on mousedown: only actual focus may admit its single toolbar invocation.
import "@/app/globals.css";
import "@/app/packagedFonts.css";
import { StrictMode, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import { Fact } from "@/components/feedback/Fact";
import type { Shell } from "@/components/feedback/stage";
import { DestinationTrigger } from "@/components/libraries/DestinationChooser";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import Button from "@/components/ui/Button";
import { selectMediaAuthors, creditName } from "@/lib/contributors/credits";
import { MEDIA_REMOVAL_CONFIRMATION } from "@/lib/media/removalCopy";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { VIEW_PORT, type ItemCommand, type ViewCommand, type ViewMessage, type ViewState } from "@/extension/capture";
import styles from "./popup.module.css";

const activationId = crypto.randomUUID();
let admission: "unbound" | "opening" | "attached" = "unbound";
let operationId: string | null = null;
let port: browser.runtime.Port | null = null;
let snapshot: { state: ViewState | null; failure: string | null } = { state: null, failure: null };
const listeners = new Set<() => void>();
const ownWindow = browser.windows.getCurrent().then(value => {
  if (value.id === undefined) throw new Error("popup has no browser window");
  return value.id;
});
function emit(): void { for (const listener of listeners) listener(); }
function post(command: ViewCommand): void {
  try { if (port === null) throw new Error("popup disconnected"); port.postMessage(command); }
  catch { snapshot = { ...snapshot, failure: "nexus isn’t answering. reconnect to this receipt." }; emit(); }
}
function connect(): void {
  if (port !== null) return;
  const connected = browser.runtime.connect({ name: VIEW_PORT });
  port = connected;
  connected.onMessage.addListener((message: object) => {
    if (port !== connected) return;
    // justify-type-assertion: the port reaches our same-build background only.
    const raw = message as ViewMessage;
    if (raw.attached) admission = "attached";
    if (raw.attached || raw.operation_id !== null) operationId = raw.operation_id;
    snapshot = { state: raw.state, failure: null }; emit();
  });
  connected.onDisconnect.addListener(() => {
    if (port !== connected) return;
    if (admission === "opening") admission = "attached";
    port = null; snapshot = { ...snapshot, failure: "nexus isn’t answering. reconnect to this receipt." }; emit();
  });
  void ownWindow.then(window_id => {
    if (port !== connected) return;
    post({ kind: "connect", activation_id: activationId, window_id });
    if (admission === "attached") post({ kind: "attach", activation_id: activationId, window_id, operation_id: operationId });
    else if (admission === "unbound" && document.hasFocus()) void focusAdmission();
  }).catch(() => { snapshot = { ...snapshot, failure: "nexus can’t identify this browser window." }; emit(); });
}
async function focusAdmission(): Promise<void> {
  if (!document.hasFocus()) return;
  if (port === null) { connect(); return; }
  if (admission !== "unbound") return;
  admission = "opening";
  try {
    const window_id = await ownWindow;
    const [tab] = await browser.tabs.query({ active: true, windowId: window_id });
    // A programmatic attachment may have consumed this activation while the
    // native tab snapshot was in flight.
    if (admission !== "opening") return;
    if (tab?.id === undefined || tab.url === undefined) throw new Error("source tab unavailable");
    post({ kind: "open", activation_id: activationId, window_id, tab_id: tab.id, source_url: tab.url });
  } catch { admission = "attached"; snapshot = { ...snapshot, failure: "nexus can’t read this tab." }; emit(); }
}
window.addEventListener("focus", () => { void focusAdmission(); });
connect();
function send(action: ItemCommand): void {
  if (operationId === null) return;
  post({ kind: "command", activation_id: activationId, operation_id: operationId, account_id: snapshot.state?.account_id ?? null, action });
}
async function allowAccess(): Promise<void> {
  const state = snapshot.state;
  if (state === null) return;
  // Invoke request synchronously from the click; only its result is asynchronous.
  const result = browser.permissions.request({ origins: state.required_origins });
  const owner = operationId;
  let granted = false;
  try { granted = await result; } catch { /* justify-ignore-error: cancellation is an ungranted permission */ }
  if (operationId === owner) send({ kind: "permission", granted });
}
const SHELL: Shell = { signIn: { label: "sign in", commandKey: "ExtensionSignIn", run: () => send({ kind: "login" }) } };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const getSnapshot = () => snapshot;

function status(op: NonNullable<ViewState["operation"]>): string {
  if (op.removal === "unknown") return "not sure this was removed.";
  if (op.removal === "sending") return "removing from nexus…";
  if (op.placement?.unknown) return "not sure this library change finished.";
  switch (op.phase) {
    case "saving": return "saving to nexus…";
    case "permission": return "allow access to save this item.";
    case "auth": return "sign in to save this item.";
    case "unknown": return "not sure this save finished.";
    case "failed": return op.failure?.offline ? "you’re offline. this save hasn’t started." : "couldn’t save this copy.";
    case "unavailable": return "this item is no longer available.";
    case "removed": return "removed from nexus.";
    case "saved": return op.item?.placements.all_membership.included ? "in nexus" : op.item === null ? "saved. reading the receipt…" : "this item is not in your libraries.";
  }
}
function Popup() {
  const current = useSyncExternalStore(subscribe, getSnapshot);
  const state = current.state;
  const op = state?.operation ?? null;
  return <main className={styles.popup}><div className={styles.body}>
    {current.failure !== null ? <Fact line={{ fact: current.failure }} verbs={[{ label: "reconnect", commandKey: "ExtensionReconnect", run: connect }]} speak /> : null}
    {state?.notice ? <Fact line={{ fact: state.notice }} speak /> : null}
    {state?.revocation_failure ? <Fact line={{ fact: "couldn’t confirm disconnection.", reason: state.revocation_failure.message }}
      verbs={[{ label: "check again", commandKey: "ExtensionDisconnect", run: () => post({ kind: "retry_disconnect", activation_id: activationId }) }]} /> : null}
    {op === null ? state?.notice ? null : <p className={styles.fine}>opening nexus…</p>
      : <Receipt key={op.id} op={op} signedIn={state?.account_id != null} />}
  </div></main>;
}
function Receipt({ op, signedIn }: { op: NonNullable<ViewState["operation"]>; signedIn: boolean }) {
  const removalTrigger = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const priorRemoval = useRef<string | null>(null);
  const priorPhase = useRef(op.phase);
  useLayoutEffect(() => {
    if (op.removal === "reviewing" && priorRemoval.current !== "reviewing") keep.current?.focus();
    else if (op.phase === "removed" && priorPhase.current !== "removed") result.current?.focus();
    else if (op.removal === "idle" && priorRemoval.current !== null && priorRemoval.current !== "idle") removalTrigger.current?.focus();
    else if (op.removal === "unknown" && priorRemoval.current !== null && priorRemoval.current !== "unknown" && document.activeElement === document.body) result.current?.focus();
    priorRemoval.current = op.removal; priorPhase.current = op.phase;
  }, [op.phase, op.removal]);
  const canonical = op.item?.has_readable_copy ? op.item.summary : null;
  const removalPreview = op.removal_preview;
  const title = canonical?.title ?? op.preview.title ?? op.item?.summary.title ?? op.host;
  const authors = canonical === null ? op.preview.byline : selectMediaAuthors(canonical.contributors).map(creditName).filter(value => value !== null).map(value => value.label).join(", ");
  const line = status(op);
  const preparation = op.phase !== "saved" ? null : op.item?.source_attempt?.status === "failed"
    ? `couldn’t prepare this copy.${op.item.has_readable_copy ? " your previous readable copy is kept." : ""}`
    : op.item?.source_attempt && ["accepted", "queued", "running"].includes(op.item.source_attempt.status)
      ? op.item.has_readable_copy ? "preparing updated copy." : "preparing to read." : null;
  const unknown = op.phase === "unknown" || op.removal === "unknown" || op.placement?.unknown === true;
  const editable = op.phase === "saved" && op.account_matches && signedIn && !op.busy && !unknown && op.removal === "idle";
  const canLogin = (!signedIn || !op.account_matches) && op.phase !== "removed";
  return <>
    <div className={styles.source}>
      <h1 className={styles.title}>{op.open_url === null ? title : <a href={op.open_url} target="_blank" rel="noreferrer">{title}</a>}</h1>
      {authors ? <p className={styles.authors}>{authors}</p> : null}
    </div>
    <p className={styles.fine} ref={result} tabIndex={-1}>{line}</p>
    <Announcement text={[
      line.endsWith(".") || line.endsWith("…") ? line : `${line}.`,
      preparation, op.failure?.message,
    ].filter(Boolean).join(" ")} level="Polite" />
    {preparation !== null ? <p className={styles.fine}>{preparation}</p> : null}
    {op.failure !== null ? <Fact line={{ fact: op.failure.message }} /> : null}
    {!op.account_matches && signedIn ? <Fact line={{ fact: "this request belongs to another account.", reason: "switch to the original account in nexus, then sign in here." }} /> : null}
    {op.phase === "permission" ? <Button onClick={() => { void allowAccess(); }} disabled={op.busy}>allow access</Button>
      : canLogin ? <Button onClick={() => send({ kind: "login" })} disabled={op.busy}>sign in</Button> : null}
    {unknown || op.retryable ? <Button disabled={op.busy || !op.account_matches || !signedIn} onClick={() => send({ kind: "retry" })}>
      {unknown || op.phase === "unavailable" || op.phase === "saved" ? "check again" : "retry"}
    </Button> : null}
    {unknown ? <details className={styles.forget}><summary>stop checking this request</summary><p className={styles.fine}>this only forgets the request here. a change already sent may still finish.</p>
      <Button disabled={op.busy} onClick={() => send({ kind: "forget" })}>forget request</Button></details> : null}
    {op.item !== null && op.phase !== "removed" ? <Libraries op={op} editable={editable} /> : null}
    {op.phase === "saved" && op.item !== null && op.removal === "idle" ? <Button ref={removalTrigger} disabled={!editable}
      onClick={() => send({ kind: "review_removal" })}>remove from nexus…</Button> : null}
    {removalPreview !== null && op.removal !== "unknown" ? <section className={styles.review} aria-label="review removal">
      <p className={styles.fine}>{MEDIA_REMOVAL_CONFIRMATION.body.replaceAll("{title}", () => removalPreview.title)}</p>
      <div className={styles.actions}><Button ref={keep} disabled={op.busy} onClick={() => send({ kind: "cancel_removal" })}>keep item</Button>
        <Button emphasis="strong" tone="danger" disabled={op.busy || op.phase !== "saved" || !op.account_matches} onClick={() => send({ kind: "remove" })}>{MEDIA_REMOVAL_CONFIRMATION.title}</Button></div>
    </section> : null}
  </>;
}
function Libraries({ op, editable }: { op: NonNullable<ViewState["operation"]>; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const placements = op.item!.placements.placements.filter(row => row.blocked !== "SystemManaged");
  const chosen = placements.filter(row => row.relation !== "Absent").map(row => ({ id: row.library_id, name: row.name }));
  const rows: ChooserRow[] = placements.map(row => {
    const change = op.placement?.library_id === row.library_id ? op.placement : null;
    return { id: row.library_id, name: row.name, confirmed: { included: row.relation === "Absent" ? 0 : 1, total: 1 },
      intended: change === null ? null : { included: change.included ? 1 : 0, total: 1 },
      progress: change?.unknown ? "Uncertain" : change === null ? "Settled" : "Pending",
      action: row.blocked !== null ? { kind: "Locked", reason: row.blocked === "RequiresAdmin" ? "only an administrator can change this library" : "managed by a podcast subscription" }
        : editable ? { kind: "Set", included: row.relation === "Absent", label: row.relation === "Absent" ? "add to library" : "remove from library" }
          : { kind: "Blocked", reason: "finish the current change first" } };
  });
  return <section className={styles.libraries}>
    <DestinationTrigger label="libraries" emptyLabel="no additional libraries" chosen={chosen} expanded={open} disabled={false}
      controls={{ kind: "region", id }} onToggle={() => { setOpen(value => !value); if (!open) send({ kind: "read" }); }} />
    {open ? <div className={styles.chooser} id={id} data-collection-body>
      <LibraryChooser context={op.id} membershipKind="Confirmed" rows={rows} loading={false} create={null} summary={null}
        empty="no additional libraries" onToggle={({ id: library_id, included }) => {
          if (!editable) return false; send({ kind: "place", library_id, included }); return true;
        }} />
    </div> : null}
  </section>;
}
createRoot(document.getElementById("root")!).render(<StrictMode>
  <RenderEnvironmentProvider value={{ androidShell: false,
    platform: /Mac|iPhone|iPad/u.test(navigator.platform) ? "mac" : /Win/u.test(navigator.platform) ? "windows" : /Linux/u.test(navigator.platform) ? "linux" : "other",
    displayLocale: navigator.language, displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentInstant: new Date().toISOString(), navCollapsed: false }}>
    <MobileViewportProvider><FeedbackProvider shell={SHELL}><Popup /></FeedbackProvider></MobileViewportProvider>
  </RenderEnvironmentProvider>
</StrictMode>);
