"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Download, LogOut } from "lucide-react";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import collection from "@/components/ui/Collection.module.css";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { isApiError } from "@/lib/api/client";
import { installedApp, publishAdmission } from "@/lib/native/admission";
import { readDeviceStartup, sessionSignOut } from "@/lib/native/client";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useAuthoredStatus, useAuthoredSyncDetail } from "@/lib/authored/provider";
import { prepareAuthoredSignOut } from "@/lib/authored/signOut";
import { importAttentionDescription } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { useGuardedSignOut } from "@/lib/unsavedWork";
import type { DestinationId } from "@/lib/navigation/destinations";
import { unbindNativePlayer } from "@/lib/player/nativeEngine";
import { localContentAvailable, localCall } from "@/lib/offline/localContent";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { cx } from "@/lib/ui/cx";
import { NAV_IMPORTS, NAV_SETTINGS, NAV_STATS, type NavItem } from "./navModel";
import { syncStatusOption, syncStatusText } from "./SyncStatus";
import styles from "./AppNav.module.css";
import accountStyles from "./AccountMenu.module.css";

const SignOutContext = createContext<{ request: () => void; busy: boolean } | null>(null);

/** The person declined discarding device-only writing; nothing was retired. */
class SignOutDeclined extends Error {}

/** One guarded exit. Authored writing drains or is deliberately discarded and its
 * account retired before the session ends; declining leaves everything intact. */
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
    let nativeStarted = false;
    let ended = false;
    let message = "playback couldn’t stop or save its position. your session is still open. retry sign out.";
    try {
      await guardedSignOut(async () => {
        if (!live.current) throw new Error("sign-out account is no longer active");
        await unbindNativePlayer();
        if (!live.current) throw new Error("sign-out account is no longer active");
        message = "your notes on this device couldn’t be closed for sign out. your session is still open. retry sign out.";
        if (!await prepareAuthoredSignOut(accountId)) throw new SignOutDeclined();
        if (installedApp) {
          nativeStarted = true;
          message = "sign out was not confirmed. retry sign out to finish removing this device’s account data.";
          // prepareAuthoredSignOut has drained or obtained the discard this carries.
          await sessionSignOut(true);
          ended = true;
          if (live.current) publishAdmission("SignInRequired");
          return;
        }
        message = "offline data couldn’t be fully removed. your session is still open. retry sign out.";
        if (localContentAvailable) await localCall("purge");
        message = "sign out couldn’t finish. your session is still open.";
      }, () => {
        if (installedApp) { if (live.current) refreshDevice(); return; }
        if (!live.current || !form.current?.isConnected) throw new Error("Sign-out form is no longer available");
        form.current.submit();
      });
    } catch (error) {
      if (error instanceof SignOutDeclined) return;
      reportError(error);
      if (nativeStarted) {
        if (isApiError(error) && error.code === "E_LOCAL_CLEANUP") ended = true;
        else try {
          const startup = await readDeviceStartup();
          ended = startup?.binding?.account.account_id !== accountId;
        } catch (inspection) {
          if (isApiError(inspection) && inspection.code === "E_LOCAL_CLEANUP") ended = true;
          else reportError(inspection);
        }
      }
      if (ended) {
        message = "your account has ended on this device, but local cleanup did not finish. retry sign out to remove remaining account data.";
        if (live.current) {
          publishAdmission("SignInRequired");
          refreshDevice();
        }
      }
      if (live.current) setFailure({ message, ended });
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <SignOutContext value={{ request: () => void request(), busy }}>
      {children}
      {failure === null ? null : <Dialog open title="sign out not completed" onClose={() => setFailure(null)}>
        <div className={accountStyles.choices}>
          <p>{failure.message}</p>
          <Button emphasis="strong" onClick={() => { if (failure.ended) refreshDevice(); else void request(); }}>{failure.ended ? "retry account cleanup" : "retry sign out"}</Button>
          <Button onClick={() => setFailure(null)}>close</Button>
        </div>
      </Dialog>}
      <form ref={form} action="/auth/signout" method="post" hidden />
    </SignOutContext>
  );
}

/** Account navigation, the one sync status and passive Imports attention, shared by the
 * rail and mobile Nexus. The trigger is described by the current status. */
export default function AccountMenu(props: {
  activeId: DestinationId | null;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: (
    trigger: Parameters<NonNullable<ComponentProps<typeof ActionMenu>["renderTrigger"]>>[0],
    attention: ReactNode,
  ) => ReactNode;
  onNavigate: (event: TargetActivationEvent, item: NavItem) => AppNavActivationResult;
}) {
  const workspace = useWorkspaceStore();
  const signOut = useContext(SignOutContext);
  const { summary } = useImports();
  const status = useAuthoredStatus();
  const cause = useAuthoredSyncDetail();
  const descriptionId = useId();
  const count = summary.status === "ready" ? summary.data.needs_attention_count : null;
  const refresh_failed = summary.status === "ready" && summary.error !== null;
  const description = count !== null && count > 0
    ? importAttentionDescription(count, refresh_failed) : null;
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
        {item === NAV_IMPORTS ? <ImportsBadge label={item.label} count={count} refresh_failed={refresh_failed} /> : <span className={collection.content}>{item.label}</span>}
      </a>
    ),
  });

  const options: ActionDescriptor[] = [
    syncStatusOption(status, cause),
    link(NAV_STATS, props.activeId === "stats"),
    link(NAV_IMPORTS, props.activeId === "imports"),
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
    options.splice(3, 0, {
      kind: "link",
      id: "downloads",
      label: "Downloads",
      href: "/downloads",
      icon: <Download size={16} aria-hidden="true" />,
      onActivate: (event) => activateTargetLink({
        event, target: { href: "/downloads" }, runtime: {
          activateTarget: ({ target, disposition }) => workspace.activateWorkspaceTarget({
            originPaneId: workspace.state.active_primary_pane_id, target, disposition,
          }),
        },
      }),
    });
  }

  return (
    <>
      <ActionMenu
        className={styles.account}
        label="account"
        placement={props.placement}
        align={props.align}
        renderTrigger={(trigger) => props.renderTrigger({
          ...trigger,
          "aria-describedby": cx(trigger["aria-describedby"], descriptionId),
        }, <span className={accountStyles.attention} data-visible={description !== null} aria-hidden="true" />)}
        source={{ kind: "Immediate", subjectKey: "account", title: "account", content: { sections: [{ id: "Account", label: null, options }] } }}
      />
      <span id={descriptionId} className="sr-only">{description === null ? syncStatusText(status, cause) : `${syncStatusText(status, cause)}; ${description}`}</span>
    </>
  );
}
