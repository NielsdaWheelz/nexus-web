"use client";
/** Desktop adapter for the shared installed shell. A confirmed local binding
 * opens without credentials; first provisioning requires verified server data. */
import { useEffect, useRef, useState } from "react";
import AuthenticatedShell from "@/app/(authenticated)/AuthenticatedShell";
import { AuthenticatedWorkspaceErrorBoundary } from "@/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary";
import { WorkProvider } from "@/lib/unsavedWork";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import { apiFetch, isApiError } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import type { ApiJson } from "@/lib/api/wire";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { parseNexusOpenUrl } from "@/lib/nexus/urlIntent";
import { normalizeWorkspaceHref, resolveTodayHref, MAX_WORKSPACE_HREF_LENGTH } from "@/lib/workspace/workspaceHref";
import { enterWorkspace } from "@/lib/workspace/model";
import { readBrowserAdmission, beginBrowserSignIn, browserSignedOut, readBrowserRetiring, writeBrowserBinding, type BrowserBinding } from "./binding";
import { admitAuthoredAccount } from "./client";
import { finishBrowserRetirement, type BrowserRetirementPending } from "./signOut";
const OPEN_FAILED = "couldn’t open your workspace.";
export default function BrowserWorkspace({ renderEnvironment }: { renderEnvironment: RenderEnvironment }) {
  const [signedOut, setSignedOut] = useState(false);
  const [binding, setBinding] = useState<(BrowserBinding & { lifetime: string }) | null>(null);
  const [locationFailure, setLocationFailure] = useState<"TooLong" | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [retirementPending, setRetirementPending] = useState<BrowserRetirementPending | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [attempt, retry] = useState(0);
  const retiredReceipt = useRef(false);
  useEffect(() => {
    let live = true;
    let handlingRetirement = false;
    const finishRetirement = async () => {
      handlingRetirement = true;
      if (live) { setBinding(null); setRetiring(true); setRetirementPending(null); setFailure(null); }
      await finishBrowserRetirement(retiredReceipt.current, phase => { if (live) setRetirementPending(phase); });
      if (live) { setRetiring(false); setSignedOut(true); }
    };
    void (async () => {
      if (await readBrowserRetiring() !== null) { await finishRetirement(); return; }
      if (await browserSignedOut()) { if (live) { setRetiring(false); setSignedOut(true); setFailure(null); } return; }
      const admission = await readBrowserAdmission();
      let saved = admission.binding;
      const lifetime = admission.lifetime;
      if (saved === null) {
        const [me, profile, workspace] = await Promise.all([
          apiFetch<ApiJson<"/me", "get">>("/api/me"),
          apiFetch<ApiJson<"/me/reader-profile", "get">>("/api/me/reader-profile"),
          apiFetch<ApiJson<"/me/workspace-session", "get">>("/api/me/workspace-session"),
        ]);
        saved = { account: { account_id: me.data.user_id, calendar_time_zone: me.data.calendar_time_zone }, reader_profile: profile.data, workspace: enterWorkspace(workspace.data.own, workspace.data.most_recent_elsewhere, null) };
        if (handlingRetirement) return;
        await writeBrowserBinding(saved, lifetime);
        admitAuthoredAccount(saved.account.account_id);
      }
      if (handlingRetirement) return;
      const url = new URL(window.location.href);
      const raw = `${url.pathname}${url.search}${url.hash}`;
      const tooLong = raw.length > MAX_WORKSPACE_HREF_LENGTH;
      const canonical = url.pathname === "/" || tooLong ? null : normalizeWorkspaceHref(parseNexusOpenUrl(url)?.href ?? raw);
      const href = canonical === null ? null : resolveTodayHref(canonical, saved.account.calendar_time_zone);
      if (live) { setBinding({ ...saved, lifetime, workspace: enterWorkspace(saved.workspace, null, href) }); setLocationFailure(tooLong && url.searchParams.has("loc") ? "TooLong" : null); setFailure(null); }
    })().catch(async error => {
      let ended = false;
      try { ended = await browserSignedOut(); } catch { /* Preserve the original startup failure. */ }
      if (!live) return;
      if (ended) { setBinding(null); setRetiring(false); setSignedOut(true); setFailure(null); }
      else setFailure(error instanceof Error ? error : new Error("couldn’t open your workspace"));
    });
    const retired = () => {
      retiredReceipt.current = true;
      if (handlingRetirement) return;
      void finishRetirement().catch(error => { if (live) setFailure(error instanceof Error ? error : new Error("local notes could not be removed")); });
    };
    window.addEventListener("nexus:authored-retired", retired);
    return () => { live = false; window.removeEventListener("nexus:authored-retired", retired); };
  }, [attempt]);
  const signIn = () => { void beginBrowserSignIn().then(() => window.location.assign("/login?switch_account=1")).catch(error => setFailure(error)); };
  const signInVerb: CommandVerb = { label: "sign in", commandKey: "BrowserSignIn", run: signIn };
  const retryVerb: CommandVerb = { label: "retry", commandKey: "RetryBrowserWorkspace", run: () => retry(value => value + 1) };
  const fact = (line: Line, verbs?: Verbs) => <Fact line={line} verbs={verbs} speak />;
  // Retiring is no opening: a ruling's `still opening` would be false here.
  if (retiring) return failure !== null ? fact({ fact: "couldn’t finish signing out." }, [retryVerb])
    : retirementPending === "blocked_database" ? fact({ fact: "sign out is waiting on other nexus tabs.", reason: "close them to finish." })
    : retirementPending === "another_tab" ? fact({ fact: "another nexus tab is finishing sign out.", reason: "this page continues when it’s done." })
    : <Fact line={{ fact: "signing out on this device." }} />;
  if (signedOut) return <Fact line={{ fact: "signed out on this device." }} verbs={[signInVerb]} />;
  if (failure) return fact(isApiError(failure) ? TRANSPORT_LINES[transportOf(failure)].command(OPEN_FAILED) : { fact: OPEN_FAILED }, [retryVerb, signInVerb]);
  if (!binding) return <Ruling />;
  return <WorkProvider key={binding.account.account_id}><AuthenticatedWorkspaceErrorBoundary accountId={binding.account.account_id}><AuthenticatedShell
    account={{ accountId: binding.account.account_id, calendarTimeZone: binding.account.calendar_time_zone }}
    browserLifetime={binding.lifetime} readerProfile={binding.reader_profile} renderEnvironment={renderEnvironment} initialState={binding.workspace}
    seeds={{}} entryFailure={null} locationLinkFailure={locationFailure}
  /></AuthenticatedWorkspaceErrorBoundary></WorkProvider>;
}
