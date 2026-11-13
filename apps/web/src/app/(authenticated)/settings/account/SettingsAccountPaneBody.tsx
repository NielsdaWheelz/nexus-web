"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useSignOut } from "@/components/appnav/AccountMenu";
import { Failed, Field, useFocusReturn } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import type { Line } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Input from "@/components/ui/Input";
import PaneSurface from "@/components/ui/PaneSurface";
import Textarea from "@/components/ui/Textarea";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { EmailChangeResult, IdentityDeleteResult, SettingsIdentity } from "@/lib/account/settingsWire";
import { apiFetch, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { OAUTH_PROVIDERS, oauthPath, PROVIDER_NAMES } from "@/lib/auth/urls";
import { compareStableString, formatDisplayDate } from "@/lib/display/format";
import { installedApp } from "@/lib/native/admission";
import { accountEmailChange, accountIdentitiesGet, accountIdentityDelete } from "@/lib/native/client";
import { useSettingsRefresh } from "@/lib/native/settingsRefresh";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import { zoneClock, zoneOf } from "@/lib/time/zones";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { useProfile } from "../useProfile";
import { useProfileField, type Outcome } from "./useProfileField";
import ZonePicker from "./ZonePicker";
import styles from "./page.module.css";

type Profile = ApiJson<"/me", "get">["data"];
type Patch = { display_name: string | null } | { calendar_time_zone: string };
type Save = (value: string | null) => Promise<Outcome>;
type UnlinkCommand = { identity: SettingsIdentity; phase: "Sending" | "Unknown" | "Retrying"; attempt: number };
const VISIT = definePaneVisitDataKey<Visit<Profile>>("Settings.Account");
const IDENTITIES = definePaneVisitDataKey<Visit<SettingsIdentity[]>>("Settings.Account.Identities");
const MINUTE_MS = 60_000;
const normalizeName = (text: string) => text.trim() || null;
const normalizeEmail = (text: string) => text.trim().toLowerCase() || null;

export default function SettingsAccountPaneBody() {
  const waysIn = useRef<HTMLDListElement>(null);
  const { profile, failure, accept } = useProfile(VISIT);
  const { displayLocale } = useRenderEnvironment();
  const { setCalendarTimeZone } = useAuthenticatedAccount();
  const refreshSettings = useSettingsRefresh();
  const { fail } = useOutcome();
  async function patch(body: Patch, invalid: Line): Promise<Outcome> {
    try {
      const { data } = await apiFetch<ApiJson<"/me", "patch">>("/api/me", { method: "PATCH", body: JSON.stringify(body) });
      accept(data);
      if ("calendar_time_zone" in body) { setCalendarTimeZone(data.calendar_time_zone); await refreshSettings(); }
      return { kind: "Saved" };
    } catch (error) {
      if (isApiError(error) && error.code === "E_INVALID_REQUEST") return { kind: "Refused", line: invalid };
      if (outcomeUnknown(error)) return { kind: "Unknown" };
      fail(error, "couldn’t save that.");
      return { kind: "Told" };
    }
  }
  const since = profile === null ? null : formatDisplayDate(profile.created_at, {
    displayLocale, displayTimeZone: profile.calendar_time_zone,
  }, { day: "numeric", month: "long", year: "numeric" });
  return <PaneSurface measured>
    {failure ? <Failed error={failure.error} noun="account settings" retry={{ run: failure.retry, busy: failure.retrying }} /> : null}
    <div className={styles.bookplate}>
      <div className={styles.eyebrow}><span>ex libris</span><span>{since === null ? null : `since ${since.toLowerCase()}`}</span></div>
      {profile ? <DisplayName saved={profile.display_name} save={value => patch({ display_name: value }, { fact: "enter a display name of at most 100 characters." })} /> : <>
        <Textarea bare disabled aria-label="display name" className={styles.name} value="" autoGrow={{ minRows: 1, maxRows: 8 }} />
        <div className={styles.nameRule} />
        <div className={styles.foot}><p className={styles.note}>the name people see on libraries you share.</p><span className={styles.verbSlot} /></div>
      </>}
    </div>
    <div role="group" aria-label="ways in"><dl ref={waysIn} className={styles.ledger}>
      {profile ? <>
        <Email saved={profile.email} />
        <Password email={profile.email} />
        <Identities calendarTimeZone={profile.calendar_time_zone} container={waysIn} />
      </> : ["email", "password", ...OAUTH_PROVIDERS.map(provider => PROVIDER_NAMES[provider])].map(label => <div className={styles.row} key={label}>
        <dt>{label}</dt><dd className={styles.value} />
      </div>)}
    </dl></div>
    <div role="group" aria-label="calendar"><dl className={styles.ledger}>
      {profile ? <Calendar saved={profile.calendar_time_zone} save={value => {
        // justify-defect: calendar picks and device offers always carry a zone.
        if (value === null) throw new Error("calendar command requires a zone");
        return patch({ calendar_time_zone: value }, { fact: "enter a recognized time zone." });
      }} /> : <div className={styles.row}><dt>calendar</dt><dd className={styles.value} /></div>}
    </dl></div>
    <div role="group" aria-label="session"><dl className={styles.ledger}>
      {profile ? <Session /> : <div className={styles.row}><dt>session</dt><dd className={styles.value} /></div>}
    </dl></div>
  </PaneSurface>;
}

function DisplayName({ saved, save }: { saved: string | null; save: Save }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef(false);
  const composing = useRef(false);
  const refusalId = useId();
  const helpId = useId();
  const [settled, setSettled] = useState(false);
  const field = useProfileField({ key: "Name", saved, normalize: normalizeName, save: async value => {
    const result = await save(value);
    if (result.kind === "Saved") setSettled(true);
    return result;
  } });
  const value = field.draft ?? saved ?? "";
  const next = normalizeName(value);
  const changed = next !== saved;
  const busy = field.phase === "Sending" || field.phase === "Retrying";
  useLayoutEffect(() => {
    if (busy || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) input.current?.focus({ preventScroll: true });
  }, [busy]);
  const commit = () => {
    if (field.phase !== "Idle" || !changed) return;
    returnFocus.current = document.activeElement === input.current;
    field.commit(next);
  };
  const edit = (text: string) => { setSettled(false); field.edit(text); };
  return <>
    <Textarea bare ref={input} aria-label="display name" placeholder="add your name" autoComplete="name"
      aria-describedby={`${helpId}${field.refusal ? ` ${refusalId}` : ""}`} className={styles.name}
      value={value} disabled={busy} autoGrow={{ minRows: 1, maxRows: 8 }} data-settled={settled && !changed || undefined}
      onAnimationEnd={() => setSettled(false)} onChange={event => edit(event.target.value)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onPaste={event => {
        const text = event.clipboardData.getData("text/plain");
        if (!/[\r\n]/.test(text)) return;
        event.preventDefault();
        const target = event.currentTarget;
        target.setRangeText(text.replace(/\r\n|[\r\n]/g, " "), target.selectionStart, target.selectionEnd, "end");
        edit(target.value);
      }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault(); event.stopPropagation();
          if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat) commit();
        } else if (event.key === "Escape" && changed) { event.preventDefault(); event.stopPropagation(); setSettled(false); field.revert(); }
      }} />
    <div className={styles.nameRule} />
    <div className={styles.foot}><p id={helpId} className={styles.note}>the name people see on libraries you share.</p>
      <span className={styles.verbSlot}>{changed ? <NameVerbs target={input} disabled={field.phase !== "Idle"} busy={busy} save={commit} revert={() => { returnFocus.current = busy; setSettled(false); field.revert(); }} /> : null}</span>
    </div>
    {field.refusal ? <Field id={refusalId} line={field.refusal} /> : null}
    {field.hold}
  </>;
}

function NameVerbs({ target, disabled, busy, save, revert }: {
  target: RefObject<HTMLTextAreaElement | null>; disabled: boolean; busy: boolean; save(): void; revert(): void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  useFocusReturn(root, () => target.current);
  return <span ref={root} className={styles.verbs}>
    <Button onClick={revert}>revert</Button><Button emphasis="strong" aria-disabled={disabled} aria-busy={busy} onClick={save}>save</Button>
  </span>;
}

function Email({ saved }: { saved: string | null }) {
  const change = useRef<HTMLButtonElement>(null);
  const read = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const [height, setHeight] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const sent = useResourceDraft<string | null>("Settings.Account.EmailSent", () => null);
  const { fail } = useOutcome();
  const field = useProfileField({ key: "Email", saved, normalize: normalizeEmail, save: async email => {
    // justify-defect: the editor admits only nonblank email commands.
    if (email === null) throw new Error("email command requires an address");
    try {
      const { data: { outcome } } = installedApp ? await accountEmailChange(email)
        : await apiFetch<{ data: EmailChangeResult }>("/api/me/email-change", { method: "POST", body: JSON.stringify({ email }) });
      switch (outcome) {
        case "Sent": sent.set(email); return { kind: "Saved" };
        case "InUse": return { kind: "Refused", line: { fact: "another account already uses this email." } };
        case "Invalid": return { kind: "Refused", line: { fact: "enter a valid email address." } };
        case "Failed": return { kind: "Unknown" };
      }
    } catch (error) {
      if (outcomeUnknown(error)) return { kind: "Unknown" };
      fail(error, "couldn’t update your email.");
      return { kind: "Told" };
    }
  } });
  const editing = field.draft !== null || field.phase !== "Idle" && !dismissed;
  useLayoutEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) change.current?.focus({ preventScroll: true });
  }, [editing]);
  return <div className={styles.row} data-editing={editing || undefined}>
    <dt>email</dt>
    {editing ? <dd className={styles.emailEditor}><EmailEditor field={field} saved={saved} change={change} height={height} returnFocus={returnFocus}
      cancel={() => { setDismissed(true); field.revert(); }} /></dd> : <>
      <dd ref={read} className={styles.value}>{saved ?? "none"}</dd>
      <dd className={styles.verbs}><Button ref={change} onClick={() => {
        setHeight(read.current?.getBoundingClientRect().height ?? null);
        setDismissed(false); field.edit(saved ?? "");
      }}>{saved === null ? "add" : "change"}</Button></dd>
    </>}
    {sent.value !== null && sent.value !== saved ? <dd className={styles.notes}>confirmation sent to {sent.value}. your email changes when you follow its link.</dd> : null}
    {field.hold ? <dd className={styles.notes}>{field.hold}</dd> : null}
  </div>;
}

function EmailEditor({ field, saved, change, cancel, height, returnFocus }: {
  field: ReturnType<typeof useProfileField>; saved: string | null; change: RefObject<HTMLButtonElement | null>; cancel(): void; height: number | null; returnFocus: RefObject<boolean>;
}) {
  const root = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const note = useId();
  const refusal = useId();
  useFocusReturn(root, () => change.current);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, []);
  const value = field.draft ?? saved ?? "";
  const next = normalizeEmail(value);
  const busy = field.phase === "Sending" || field.phase === "Retrying";
  useLayoutEffect(() => {
    if (busy || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) input.current?.focus({ preventScroll: true });
  }, [busy, returnFocus]);
  return <form ref={root} className={styles.emailForm} noValidate onSubmit={event => {
    event.preventDefault();
    if (field.phase === "Idle" && next !== null && next !== saved) {
      returnFocus.current = document.activeElement === input.current;
      field.commit(next);
    }
  }}>
    <Input ref={input} bare type="text" inputMode="email" aria-label="new email" autoComplete="email" className={styles.emailInput}
      style={height === null ? undefined : { blockSize: height, minBlockSize: height }}
      aria-describedby={`${note}${field.refusal ? ` ${refusal}` : ""}`} value={value} disabled={busy}
      onChange={event => field.edit(event.target.value)} onKeyDown={event => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
          event.preventDefault(); event.stopPropagation(); cancel();
        }
      }} />
    <p id={note} className={styles.emailNote}>we’ll send a link to the new address. your email changes when you follow it.</p>
    <span className={styles.emailVerbs}><Button onClick={cancel}>cancel</Button>
      <Button type="submit" emphasis="strong" aria-disabled={field.phase !== "Idle" || next === null || next === saved} aria-busy={busy}>send confirmation</Button>
    </span>
    {field.refusal ? <div className={styles.emailFeedback}><Field id={refusal} line={field.refusal} /></div> : null}
  </form>;
}

function Password({ email }: { email: string | null }) {
  const { accountId } = useAuthenticatedAccount();
  return <div className={styles.row}><dt>password</dt><dd className={styles.value}>{email === null ? "needs an email first." : "used with your email."}</dd>
    <dd className={styles.verbs}>{email === null ? null : <ButtonLink href={installedApp
      ? `/account/password?expected_account_id=${encodeURIComponent(accountId)}&next=%2Fsettings%2Faccount`
      : "/account/password?next=%2Fsettings%2Faccount"}>set or replace…</ButtonLink>}</dd>
  </div>;
}

function Identities({ calendarTimeZone, container }: { calendarTimeZone: string; container: RefObject<HTMLDListElement | null> }) {
  const { displayLocale } = useRenderEnvironment();
  const { accountId } = useAuthenticatedAccount();
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const identities = useServerValue({ key: "identities", stale: "", visit: IDENTITIES, load: async () =>
    (installedApp ? await accountIdentitiesGet() : await apiFetch<{ data: SettingsIdentity[] }>("/api/me/identities")).data,
  });
  const draft = useResourceDraft<{ command: UnlinkCommand | null }>("Settings.Account.Unlink", () => ({ command: null }), value => ({
    changed: false, unconfirmed: value.command !== null, stopsBrowserWork: false,
  }));
  const command = draft.value.command;
  useEffect(() => {
    if (identities.status !== "ready" || identities.refreshing || identities.error !== null) return;
    const pending = draft.read().command;
    if (pending !== null && pending.phase !== "Sending" && !identities.data.some(identity => identity.id === pending.identity.id)) draft.set({ command: null });
  }, [identities, draft]);
  async function unlink(identity: SettingsIdentity) {
    const previous = draft.read().command;
    if (previous !== null && (previous.phase !== "Unknown" || previous.identity.id !== identity.id)) return;
    const running: UnlinkCommand = { identity: previous?.identity ?? identity, phase: previous === null ? "Sending" : "Retrying", attempt: previous?.attempt ?? 0 };
    draft.set({ command: running });
    try {
      const { data: { outcome } } = installedApp ? await accountIdentityDelete(running.identity.id)
        : await apiFetch<{ data: IdentityDeleteResult }>(`/api/me/identities/${encodeURIComponent(running.identity.id)}`, { method: "DELETE" });
      if (draft.read().command !== running) return;
      if (outcome === "Unlinked") { draft.set({ command: null }); void identities.refetch(); }
      else draft.set({ command: { ...running, phase: "Unknown", attempt: running.attempt + 1 } });
    } catch (error) {
      if (draft.read().command !== running) return;
      if (previous !== null || outcomeUnknown(error)) {
        draft.set({ command: { ...running, phase: "Unknown", attempt: running.attempt + 1 } });
        if (!isApiError(error) || isSameSystemApiDefect(error)) fail(error, "couldn’t unlink this identity.");
      } else { draft.set({ command: null }); fail(error, "couldn’t unlink this identity."); }
    }
  }
  const held = command === null || command.phase === "Sending" ? null : resendFeedback({
    line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: `UnlinkIdentity:${command.identity.id}`, busy: command.phase === "Retrying", run: () => { void unlink(command.identity); } },
  });
  if (identities.status === "failed") return <div className={styles.row}><dt className="sr-only">linked identities</dt><dd className={styles.notes}>
    <Failed error={identities.error} noun="linked identities" retry={{ run: identities.refetch, busy: identities.retrying }} />
    {held && command ? <Hold id={`${draft.owner}:unlink:${command.identity.id}`} attempt={command.attempt} {...held} /> : null}
  </dd></div>;
  return <>{OAUTH_PROVIDERS.flatMap(provider => {
    const linked = identities.status === "ready" ? identities.data.filter(identity => identity.provider === provider)
      .sort((a, b) => compareStableString(a.created_at ?? "", b.created_at ?? "") || compareStableString(a.id, b.id)) : [];
    if (linked.length === 0) return <div className={styles.row} key={provider} tabIndex={-1} data-account-provider={provider} aria-busy={identities.status === "loading" || undefined}>
      <dt>{PROVIDER_NAMES[provider]}</dt><dd className={styles.value}>{identities.status === "ready" ? "not linked" : null}</dd>
      <dd className={styles.verbs}>{identities.status === "ready" ? <ButtonLink href={installedApp ? `/account/identities?expected_account_id=${encodeURIComponent(accountId)}` : oauthPath(provider, "link")}>connect</ButtonLink> : null}</dd>
    </div>;
    return linked.map(identity => {
      const date = identity.created_at === null ? null : formatDisplayDate(identity.created_at, { displayLocale, displayTimeZone: calendarTimeZone }, { day: "numeric", month: "short", year: "numeric" });
      return <LinkedIdentityRow key={identity.id} identity={identity} date={date} container={container}
        canUnlink={identities.status === "ready" && identities.data.length >= 2}
        blocked={command !== null || identities.status !== "ready" || identities.refreshing || identities.error !== null}
        unlink={() => void unlink(identity)}
        hold={held && command?.identity.id === identity.id ? <Hold id={`${draft.owner}:unlink:${identity.id}`} attempt={command.attempt} {...held} /> : null} />;
    });
  })}</>;
}

/** the row gives its withdrawing unlink a stable focus target. */
function LinkedIdentityRow({ identity, date, canUnlink, blocked, unlink, hold, container }: {
  identity: SettingsIdentity; date: string | null; canUnlink: boolean; blocked: boolean; unlink(): void; hold: ReactNode; container: RefObject<HTMLDListElement | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  useFocusReturn(root, () => container.current?.querySelector<HTMLElement>(`[data-account-provider="${identity.provider}"]`) ?? null);
  return <div ref={root} className={styles.row} tabIndex={-1} data-account-provider={identity.provider}><dt>{PROVIDER_NAMES[identity.provider]}</dt>
    <dd className={styles.value}>{identity.email ?? "provider did not return an email"}{date === null ? null : ` · linked ${date.toLowerCase()}`}</dd>
    <dd className={styles.verbs}>{canUnlink ? <UnlinkVerb row={root} container={container} provider={identity.provider} blocked={blocked} unlink={unlink} /> : null}</dd>
    {hold ? <dd className={styles.notes}>{hold}</dd> : null}
  </div>;
}

function UnlinkVerb({ row, provider, blocked, unlink, container }: {
  row: RefObject<HTMLDivElement | null>; provider: SettingsIdentity["provider"]; blocked: boolean; unlink(): void; container: RefObject<HTMLDListElement | null>;
}) {
  const root = useRef<HTMLSpanElement>(null);
  useFocusReturn(root, () => row.current ?? container.current?.querySelector<HTMLElement>(`[data-account-provider="${provider}"]`) ?? null);
  return <span ref={root}><Button tone="danger" aria-disabled={blocked} onClick={unlink}>unlink</Button></span>;
}

function Calendar({ saved, save }: { saved: string; save: Save }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const { displayLocale } = useRenderEnvironment();
  const deviceId = useHydratedBrowserTimeZone();
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(false);
  const refusalId = useId();
  const field = useProfileField({ key: "Zone", saved, normalize: String, save: async value => {
    const result = await save(value);
    if (result.kind === "Saved") setSettled(true);
    return result;
  } });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { setNow(new Date()); timer = setTimeout(tick, MINUTE_MS - Date.now() % MINUTE_MS); };
    timer = setTimeout(tick, MINUTE_MS - Date.now() % MINUTE_MS);
    return () => clearTimeout(timer);
  }, []);
  const zone = zoneOf(saved);
  const device = deviceId === null ? null : zoneOf(deviceId);
  const offered = device !== null && device.id !== zone.id;
  const clock = zoneClock(saved, now, displayLocale);
  const commit = (id: string) => { setSettled(false); setOpen(false); field.commit(id); };
  return <div className={styles.row}><dt>calendar</dt>
    <dd className={styles.value}><span data-settled={settled || undefined} onAnimationEnd={() => setSettled(false)}>{zone.city}</span>{clock === null ? null : ` · ${clock.text.toLowerCase()}`}</dd>
    <dd className={styles.verbs}><Button ref={anchor} aria-disabled={field.phase !== "Idle"} onClick={() => setOpen(true)} aria-describedby={field.refusal ? refusalId : undefined}>change</Button></dd>
    <dd className={styles.notes}><p>the journal’s day turns at midnight there.</p>
      {offered ? <CalendarOffer city={device.city} target={anchor} blocked={field.phase !== "Idle"} commit={() => commit(device.id)} /> : null}
      {field.refusal ? <Field id={refusalId} line={field.refusal} /> : null}{field.hold}
    </dd>
    {open ? <ZonePicker current={saved} device={deviceId} anchor={anchor} onPick={commit} onClose={() => setOpen(false)} /> : null}
  </div>;
}

function CalendarOffer({ city, target, blocked, commit }: {
  city: string; target: RefObject<HTMLButtonElement | null>; blocked: boolean; commit(): void;
}) {
  const root = useRef<HTMLParagraphElement>(null);
  useFocusReturn(root, () => target.current);
  return <p ref={root}><span>this device is on {city} time.</span> <Button aria-disabled={blocked} onClick={commit}>use {city}</Button></p>;
}

function Session() {
  const { request, busy } = useSignOut();
  return <div className={styles.row}><dt>session</dt><dd className={styles.value}>{installedApp ? "this device" : "this browser"}</dd>
    <dd className={styles.verbs}><Button tone="danger" disabled={busy} aria-busy={busy} onClick={request}>sign out</Button></dd>
  </div>;
}
