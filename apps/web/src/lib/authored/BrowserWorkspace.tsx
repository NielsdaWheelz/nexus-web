"use client";
/** Desktop adapter for the shared installed shell. A confirmed local binding
 * opens without credentials; first provisioning requires verified server data. */
import { useEffect, useState } from "react";
import AuthenticatedShell from "@/app/(authenticated)/AuthenticatedShell";
import { AuthenticatedWorkspaceErrorBoundary } from "@/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary";
import { FeedbackState } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { parseNexusOpenUrl } from "@/lib/nexus/urlIntent";
import { normalizeWorkspaceHref, resolveTodayHref, MAX_WORKSPACE_HREF_LENGTH } from "@/lib/workspace/workspaceHref";
import { enterWorkspace } from "@/lib/workspace/model";
import { beginBrowserSignIn, browserSignedOut, readBrowserBinding, writeBrowserBinding, type BrowserBinding } from "./binding";
import { admitAuthoredAccount } from "./client";
import { finishBrowserRetirement } from "./signOut";
import { prepareShell } from "./shell";
export default function BrowserWorkspace({ renderEnvironment }: { renderEnvironment: RenderEnvironment }) {
  const [signedOut, setSignedOut] = useState(false);
  const [binding, setBinding] = useState<BrowserBinding | null>(null);
  const [locationFailure, setLocationFailure] = useState<"TooLong" | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      await prepareShell();
      await finishBrowserRetirement();
      if (await browserSignedOut()) { if (live) setSignedOut(true); return; }
      let saved = await readBrowserBinding();
      if (saved === null) {
        const [me, profile, workspace] = await Promise.all([
          apiFetch<ApiJson<"/me", "get">>("/api/me"),
          apiFetch<ApiJson<"/me/reader-profile", "get">>("/api/me/reader-profile"),
          apiFetch<ApiJson<"/me/workspace-session", "get">>("/api/me/workspace-session"),
        ]);
        saved = { account: { account_id: me.data.user_id, calendar_time_zone: me.data.calendar_time_zone }, reader_profile: profile.data, workspace: enterWorkspace(workspace.data.own, workspace.data.most_recent_elsewhere, null) };
        await writeBrowserBinding(saved);
        admitAuthoredAccount(saved.account.account_id);
      }
      const url = new URL(window.location.href);
      const raw = `${url.pathname}${url.search}${url.hash}`;
      const tooLong = raw.length > MAX_WORKSPACE_HREF_LENGTH;
      const canonical = url.pathname === "/" || tooLong ? null : normalizeWorkspaceHref(parseNexusOpenUrl(url)?.href ?? raw);
      const href = canonical === null ? null : resolveTodayHref(canonical, saved.account.calendar_time_zone);
      if (live) { setBinding({ ...saved, workspace: enterWorkspace(saved.workspace, null, href) }); setLocationFailure(tooLong && url.searchParams.has("loc") ? "TooLong" : null); setFailure(null); }
    })().catch(error => { if (live) setFailure(error instanceof Error ? error : new Error("couldn’t open your workspace")); });
    const retired = () => { setBinding(null); setSignedOut(true); };
    window.addEventListener("nexus:authored-retired", retired);
    return () => { live = false; window.removeEventListener("nexus:authored-retired", retired); };
  }, [attempt]);
  const signIn = () => { void beginBrowserSignIn().then(() => window.location.assign("/login?switch_account=1")).catch(error => setFailure(error)); };
  if (signedOut) return <FeedbackState content={{ tone: "Neutral", title: "signed out on this device", message: failure?.message }} announcement="None" actions={[{ label: "sign in", onClick: signIn }]} />;
  if (failure) return <FeedbackState content={{ tone: "Danger", title: "couldn’t open your workspace", message: failure.message }} announcement="Polite" actions={[{ label: "retry", onClick: () => retry(value => value + 1) }, { label: "sign in", onClick: signIn }]} />;
  if (!binding) return <FeedbackState content={{ tone: "Neutral", title: "opening your workspace…" }} announcement="None" />;
  return <AuthenticatedWorkspaceErrorBoundary><AuthenticatedShell
    account={{ accountId: binding.account.account_id, calendarTimeZone: binding.account.calendar_time_zone }}
    readerProfile={binding.reader_profile} renderEnvironment={renderEnvironment} initialState={binding.workspace}
    seeds={{}} entryFailure={null} locationLinkFailure={locationFailure}
  /></AuthenticatedWorkspaceErrorBoundary>;
}
