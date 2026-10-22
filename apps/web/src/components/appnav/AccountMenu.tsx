"use client";

import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Download, LogOut } from "lucide-react";
import Link from "next/link";
import ImportsBadge from "@/components/imports/ImportsBadge";
import { saveWritingFile, writingFileName } from "@/components/notes/NoteNotices";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useGuardedSignOut } from "@/lib/unsavedWork";
import type { DestinationId } from "@/lib/navigation/destinations";
import {
  commitSignOut,
  finishSignOut,
  prepareSignOut,
  WritingDecisionError,
  writingRuntimeToken,
  type SignOutResult,
  type WritingRuntimeToken,
} from "@/lib/notes/journal";
import { nudgeWrites, syncForSignOut } from "@/lib/notes/writes";
import { offlineAvailable, offlineCall } from "@/lib/offline/bridge";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { NAV_IMPORTS, NAV_SETTINGS, NAV_STATS, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";
import dialogStyles from "./AccountMenu.module.css";

/** Active steps carry one runtime token; refusal retry starts a new review. */
type SignOutStep =
  | { kind: "Idle" }
  | { kind: "Refused"; title: string; message: string | null }
  | { kind: "Checking"; token: WritingRuntimeToken }
  | { kind: "Choosing"; token: WritingRuntimeToken; note: string | null }
  | { kind: "Working"; token: WritingRuntimeToken; choice: "sync" | "download" | "discard" | "cancel" }
  | { kind: "ConfirmingDiscard"; token: WritingRuntimeToken }
  | { kind: "ConfirmingReceipt"; token: WritingRuntimeToken };
type DialogStep = Exclude<SignOutStep, { kind: "Idle" } | { kind: "Checking" }>;

const SignOutContext = createContext<{ request: () => void; busy: boolean } | null>(null);
const OTHER_TABS = "save or download writing in the other tabs, then close them before signing out.";
const UNRESOLVED = "some writing still needs a decision. download it, discard it, or cancel and review it in notes.";

/**
 * The tab's one deliberate sign-out, above every account menu: unsynced writing is
 * synced, downloaded or explicitly discarded first; then Android's offline data,
 * the journal and the session end, in that order. One runtime token, captured
 * before the first await, binds every journal call of the flow: a stale token is
 * refused and changes nothing. The journal holds sign-out exclusivity from the
 * first check until cancellation, failure or the document leaving; `ready`
 * freezes it without purging.
 */
export function SignOutProvider({ children }: { children: ReactNode }) {
  const form = useRef<HTMLFormElement>(null);
  const guardedSignOut = useGuardedSignOut();
  const [step, setStepState] = useState<SignOutStep>({ kind: "Idle" });
  const current = useRef<SignOutStep>(step);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const setStep = (next: SignOutStep) => {
    current.current = next;
    if (live.current) setStepState(next);
  };
  const report = (content: { title: string; message: string | null }) => {
    if (live.current) setStep({ kind: "Refused", ...content });
  };
  // A refused or failed step hands the journal back to the runtime that granted
  // the token, which resumes admission and delivery; a stale token changes nothing.
  const restore = async (token: WritingRuntimeToken, message: string) => {
    try {
      await finishSignOut(token, false);
      nudgeWrites();
    } catch (error) {
      if (!(error instanceof WritingDecisionError)) reportError(error);
    }
    report({ title: "sign out not completed", message });
  };
  // Checks, sync and export remove nothing; only `leave` purges, phase by phase.
  const run = async (token: WritingRuntimeToken, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof WritingDecisionError)) reportError(error);
      await restore(token, "nothing was removed. your session is still open.");
    }
  };
  // Android's offline reading copies go first: they can be downloaded again. The
  // journal's writing cannot, so it is purged only after them, then the session.
  const leave = async (token: WritingRuntimeToken) => {
    let message = "offline data couldn’t be fully removed. your writing stays on this device and your session is still open.";
    try {
      const completed = await guardedSignOut(async () => {
        if (offlineAvailable) await offlineCall("purge");
        message = offlineAvailable
          ? "offline data was removed, but writing on this device couldn’t be. it stays here and your session is still open."
          : "writing on this device couldn’t be removed. it stays here and your session is still open.";
        await commitSignOut(token);
        message = "sign out couldn’t finish. your session is still open.";
      }, () => {
        if (!live.current || !form.current?.isConnected) throw new Error("Sign-out form is no longer available");
        form.current.submit();
      }, { reviewedOwnerIds: [`writing:${token.account_id}`] });
      if (!completed) {
        await finishSignOut(token, false);
        nudgeWrites();
        setStep({ kind: "Idle" });
      }
    } catch (error) {
      if (!(error instanceof WritingDecisionError)) reportError(error);
      await restore(token, message);
    }
  };
  const decide = async (token: WritingRuntimeToken, result: SignOutResult, note: string | null) => {
    switch (result.kind) {
      case "ready": return leave(token);
      case "other_tabs":
        nudgeWrites();
        return report({ title: "sign out not completed", message: OTHER_TABS });
      case "needs_resolution": return setStep({ kind: "Choosing", token, note });
      case "needs_download_receipt": return setStep({ kind: "ConfirmingReceipt", token });
      case "cancelled":
        nudgeWrites();
        return setStep({ kind: "Idle" });
    }
  };
  function request() {
    if (current.current.kind !== "Idle") return;
    const token = writingRuntimeToken();
    setStep({ kind: "Checking", token });
    void run(token, async () => decide(token, await prepareSignOut(token, "sync"), null));
  }
  const sync = (token: WritingRuntimeToken) => {
    setStep({ kind: "Working", token, choice: "sync" });
    void run(token, async () => {
      await syncForSignOut(token);
      await decide(token, await prepareSignOut(token, "sync"), UNRESOLVED);
    });
  };
  const download = (token: WritingRuntimeToken) => {
    setStep({ kind: "Working", token, choice: "download" });
    void run(token, async () => {
      let saved: "saved" | "started" | "cancelled";
      try {
        saved = await saveWritingFile(token);
      } catch (error) {
        reportError(error);
        return setStep({ kind: "Choosing", token, note: "the file couldn’t be saved. nothing was removed." });
      }
      if (saved === "saved") await decide(token, await prepareSignOut(token, "download", true), null);
      else if (saved === "started") setStep({ kind: "ConfirmingReceipt", token });
      else setStep({ kind: "Choosing", token, note: null });
    });
  };
  const receipt = (token: WritingRuntimeToken) => {
    setStep({ kind: "Working", token, choice: "download" });
    void run(token, async () => decide(token, await prepareSignOut(token, "download", true), null));
  };
  const discard = (token: WritingRuntimeToken) => {
    setStep({ kind: "Working", token, choice: "discard" });
    void run(token, async () => decide(token, await prepareSignOut(token, "discard"), null));
  };
  const cancel = (token: WritingRuntimeToken) => {
    if (current.current.kind === "Working") return;
    setStep({ kind: "Working", token, choice: "cancel" });
    void run(token, async () => decide(token, await prepareSignOut(token, "cancel"), null));
  };

  const dialog = (shown: DialogStep) => {
    if (shown.kind === "Refused") return (
      <Dialog open title={shown.title} onClose={() => setStep({ kind: "Idle" })}>
        <div className={dialogStyles.choices}>
          {shown.message === null ? null : <p>{shown.message}</p>}
          <Button variant="primary" onClick={() => { setStep({ kind: "Idle" }); request(); }}>retry sign out</Button>
          <Button variant="ghost" onClick={() => setStep({ kind: "Idle" })}>cancel</Button>
        </div>
      </Dialog>
    );
    const { token } = shown;
    const working = shown.kind === "Working" ? shown.choice : null;
    const choice = (label: string, onClick: () => void, variant: "primary" | "secondary" | "danger" | "ghost", busy: boolean) => (
      <Button
        variant={variant}
        aria-busy={busy || undefined}
        aria-disabled={working !== null || undefined}
        onClick={() => { if (current.current.kind !== "Working") onClick(); }}
      >{label}</Button>
    );
    const discarding = shown.kind === "ConfirmingDiscard" || working === "discard";
    return (
      <Dialog
        open
        title={discarding ? "discard unsynced writing?" : shown.kind === "ConfirmingReceipt" ? "did the download finish?" : "some writing hasn’t synced."}
        onClose={() => cancel(token)}
        onDismissRequest={() => (current.current.kind === "Working" ? "blocked" : "accepted")}
      >
        {discarding ? (
          <div className={dialogStyles.choices}>
            <p>this removes unsynced writing from this device. changes already sent may still finish.</p>
            {choice("discard and sign out", () => discard(token), "danger", working === "discard")}
            {choice("back", () => setStep({ kind: "Choosing", token, note: null }), "ghost", false)}
          </div>
        ) : shown.kind === "ConfirmingReceipt" ? (
          <div className={dialogStyles.choices}>
            <p>check that {writingFileName()} finished downloading. sign out only once you have the file.</p>
            {choice("i have the file, sign out", () => receipt(token), "primary", false)}
            {choice("download again", () => download(token), "secondary", false)}
            {choice("cancel", () => cancel(token), "ghost", false)}
          </div>
        ) : (
          <div className={dialogStyles.choices}>
            <p>{shown.kind === "Choosing" && shown.note !== null ? shown.note : "choose what happens to it before you sign out."}</p>
            {choice("sync and sign out", () => sync(token), "primary", working === "sync")}
            {choice("download and sign out", () => download(token), "secondary", working === "download")}
            {choice("discard and sign out", () => setStep({ kind: "ConfirmingDiscard", token }), "danger", false)}
            {choice("cancel", () => cancel(token), "ghost", working === "cancel")}
          </div>
        )}
      </Dialog>
    );
  };
  return (
    <SignOutContext value={{ request, busy: step.kind !== "Idle" }}>
      {children}
      {step.kind === "Idle" || step.kind === "Checking" ? null : dialog(step)}
      <form ref={form} action="/auth/signout" method="post" hidden />
    </SignOutContext>
  );
}

/** Stats, Imports, Downloads (Android), Settings, Sign Out: the rail's and mobile Nexus's. */
export default function AccountMenu(props: {
  activeId: DestinationId | null;
  importsActive: boolean;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: ComponentProps<typeof ActionMenu>["renderTrigger"];
  onNavigate: (event: TargetActivationEvent, item: NavItem) => AppNavActivationResult;
}) {
  const signOut = useContext(SignOutContext);
  // justify-defect: the authenticated shell mounts the one sign-out owner above every menu.
  if (!signOut) throw new Error("AccountMenu must be used within a SignOutProvider");

  const link = (item: NavItem, current: boolean): ActionDescriptor => ({
    kind: "custom",
    id: item.id,
    label: item.label,
    render: ({ closeMenu, closeMenuWithoutFocus, presentation }) => (
      <Link
        href={item.href}
        data-workspace-rich-target="true"
        role={presentation === "menu" ? "menuitem" : undefined}
        tabIndex={presentation === "menu" ? -1 : 0}
        className={styles.menuItem}
        aria-current={current ? "page" : undefined}
        onClick={(event) => {
          const result = props.onNavigate(event, item);
          if (result === "handled-source-focus") closeMenu();
          else if (result === "handled-destination-focus") closeMenuWithoutFocus();
        }}
        onKeyDown={(event) => {
          const result = props.onNavigate(event, item);
          if (result === "handled-source-focus") closeMenu();
          else if (result === "handled-destination-focus") closeMenuWithoutFocus();
        }}
      >
        <item.icon size={16} aria-hidden="true" />
        {item === NAV_IMPORTS ? <ImportsBadge label={item.label} labelVisible /> : item.label}
      </Link>
    ),
  });

  const options: ActionDescriptor[] = [
    link(NAV_STATS, props.activeId === "stats"),
    link(NAV_IMPORTS, props.importsActive),
    link(NAV_SETTINGS, props.activeId === "settings"),
    {
      kind: "command",
      id: "signout",
      label: "Sign Out",
      tone: "danger",
      icon: <LogOut size={16} aria-hidden="true" />,
      separatorBefore: true,
      onSelect: signOut.request,
      disabled: signOut.busy,
    },
  ];
  // Android's packaged shelf; the bridge loads it in place of the workspace.
  if (offlineAvailable) {
    options.splice(2, 0, {
      kind: "command",
      id: "downloads",
      label: "Downloads",
      icon: <Download size={16} aria-hidden="true" />,
      onSelect: () => void offlineCall("showDownloads"),
    });
  }

  return (
    <ActionMenu
      className={styles.account}
      label="account"
      placement={props.placement}
      align={props.align}
      renderTrigger={props.renderTrigger}
      source={{ kind: "Immediate", subjectKey: "account", title: "account", content: { sections: [{ id: "Account", label: null, options }] } }}
    />
  );
}
