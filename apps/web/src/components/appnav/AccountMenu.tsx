"use client";

import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Download, LogOut } from "lucide-react";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import collection from "@/components/ui/Collection.module.css";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import { isApiError } from "@/lib/api/client";
import { installedApp, publishAdmission } from "@/lib/native/admission";
import { readDeviceStartup, sessionSignOut } from "@/lib/native/client";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useGuardedSignOut } from "@/lib/unsavedWork";
import type { DestinationId } from "@/lib/navigation/destinations";
import { pauseWriting, readWriting, resumeWriting, stopWritingRuntime } from "@/lib/notes/writes";
import { unbindNativePlayer } from "@/lib/player/nativeEngine";
import { localContentAvailable, localCall } from "@/lib/offline/localContent";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { NAV_IMPORTS, NAV_SETTINGS, NAV_STATS, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";
import dialogStyles from "./AccountMenu.module.css";

const SignOutContext = createContext<{ request: () => void; busy: boolean } | null>(null);

/** One guarded exit. Failed cleanup restores writing only while the same account remains active. */
export function SignOutProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuthenticatedAccount();
  const form = useRef<HTMLFormElement>(null);
  const guardedSignOut = useGuardedSignOut();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [failure, setFailure] = useState<{ message: string; ended: boolean } | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const refreshDevice = () => window.dispatchEvent(new Event("nexus:device-settings-refreshed"));
  async function request() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setFailure(null);
    const generation = readWriting().generation;
    const sameAccount = () => live.current && readWriting().generation === generation && readWriting().account_id === accountId;
    let nativeStarted = false;
    let ended = false;
    let message = "playback couldn’t stop or save its position. your session is still open. retry sign out.";
    try {
      await guardedSignOut(async () => {
        if (!sameAccount()) throw new Error("sign-out account is no longer active");
        pauseWriting();
        await unbindNativePlayer();
        if (!sameAccount()) throw new Error("sign-out account is no longer active");
        if (installedApp) {
          nativeStarted = true;
          message = "sign out was not confirmed. retry sign out to finish removing this device’s account data.";
          await sessionSignOut();
          ended = true;
          if (sameAccount()) {
            stopWritingRuntime(generation);
            publishAdmission("SignInRequired");
          }
          return;
        }
        message = "offline data couldn’t be fully removed. your session is still open. retry sign out.";
        if (localContentAvailable) await localCall("purge");
        message = "sign out couldn’t finish. your session is still open.";
      }, () => {
        if (installedApp) { if (live.current && readWriting().account_id === null) refreshDevice(); return; }
        if (!live.current || !form.current?.isConnected) throw new Error("Sign-out form is no longer available");
        form.current.submit();
      });
    } catch (error) {
      reportError(error);
      if (nativeStarted) {
        if (isApiError(error) && error.code === "E_LOCAL_CLEANUP") ended = true;
        else try {
          const startup = await readDeviceStartup();
          ended = startup?.binding?.account.account_id !== accountId;
          if (!ended && sameAccount()) resumeWriting();
        } catch (inspection) {
          if (isApiError(inspection) && inspection.code === "E_LOCAL_CLEANUP") ended = true;
          else reportError(inspection);
        }
      } else if (sameAccount()) resumeWriting();
      if (ended) {
        const owned = sameAccount();
        stopWritingRuntime(generation);
        if (owned) publishAdmission("SignInRequired");
        message = "your account has ended on this device, but local cleanup did not finish. retry sign out to remove remaining account data.";
        if (owned) refreshDevice();
      }
      if (live.current && (sameAccount() || ended && readWriting().account_id === null)) setFailure({ message, ended });
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <SignOutContext value={{ request: () => void request(), busy }}>
      {children}
      {failure === null ? null : <Dialog open title="sign out not completed" onClose={() => setFailure(null)}>
        <div className={dialogStyles.choices}>
          <p>{failure.message}</p>
          <Button emphasis="strong" onClick={() => { if (failure.ended) refreshDevice(); else void request(); }}>{failure.ended ? "retry account cleanup" : "retry sign out"}</Button>
          <Button onClick={() => setFailure(null)}>close</Button>
        </div>
      </Dialog>}
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
  const workspace = useWorkspaceStore();
  const signOut = useContext(SignOutContext);
  // justify-defect: the authenticated shell mounts the one sign-out owner above every menu.
  if (!signOut) throw new Error("AccountMenu must be used within a SignOutProvider");

  const link = (item: NavItem, current: boolean): ActionDescriptor => ({
    kind: "custom",
    id: item.id,
    label: item.label,
    render: ({ closeMenu, closeMenuWithoutFocus, presentation }) => (
      <a
        href={item.href}
        data-workspace-rich-target="true"
        role={presentation === "menu" ? "menuitem" : undefined}
        tabIndex={presentation === "menu" ? -1 : 0}
        className={collection.row}
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
        <item.icon size={16} className={collection.adornment} aria-hidden="true" />
        {item === NAV_IMPORTS ? <ImportsBadge label={item.label} labelVisible /> : <span className={collection.content}>{item.label}</span>}
      </a>
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
  if (localContentAvailable) {
    options.splice(2, 0, {
      kind: "custom", id: "downloads", label: "Downloads",
      render: ({ closeMenu, closeMenuWithoutFocus, presentation }) => {
        const navigate = (event: TargetActivationEvent) => {
          const result = activateTargetLink({ event, target: { href: "/downloads" }, runtime: {
            activateTarget: ({ target, disposition }) => workspace.activateWorkspaceTarget({
              originPaneId: workspace.state.active_primary_pane_id, target, disposition,
            }),
          } });
          if (result === "handled-default" || result === "handled-new-pane") closeMenuWithoutFocus();
          else if (result === "consumed") closeMenu();
        };
        return <ButtonLink href="/downloads" data-workspace-rich-target="true" className={collection.row}
          role={presentation === "menu" ? "menuitem" : undefined} tabIndex={presentation === "menu" ? -1 : 0}
          onClick={navigate} onKeyDown={navigate}>
          <Download size={16} className={collection.adornment} aria-hidden="true" />
          <span className={collection.content}>Downloads</span>
        </ButtonLink>;
      },
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
