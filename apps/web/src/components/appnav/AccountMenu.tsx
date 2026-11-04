"use client";
import * as Icon from "@/lib/ui/icons";

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import collection from "@/components/ui/Collection.module.css";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { CommandVerb, Line, Verb } from "@/components/feedback/stage";
import { isApiError } from "@/lib/api/client";
import { conditionLine, MARK, useCondition, type Condition, type Mark } from "@/lib/account/condition";
import { installedApp, publishAdmission, subscribeAdmission, updateRemedy } from "@/lib/native/admission";
import { readDeviceStartup, sessionSignOut } from "@/lib/native/client";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useAuthoredSignIn, useAuthoredStatus, useAuthoredSyncDetail, useCommitFailed } from "@/lib/authored/provider";
import { prepareAuthoredSignOut } from "@/lib/authored/signOut";
import { STATUS_COPY } from "@/lib/authored/status";
import { importAttentionDescription } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { useGuardedSignOut } from "@/lib/unsavedWork";
import type { DestinationId } from "@/lib/navigation/destinations";
import { unbindNativePlayer } from "@/lib/player/nativeEngine";
import { localContentAvailable } from "@/lib/offline/localContent";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor, ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { cx } from "@/lib/ui/cx";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useWorkGuard } from "@/lib/unsavedWork";
import { NAV_IMPORTS, NAV_SETTINGS, NAV_STATS, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";
import accountStyles from "./AccountMenu.module.css";

const SignOutContext = createContext<{ request: () => void; busy: boolean } | null>(null);

/** The person declined discarding device-only writing; nothing was retired. */
class SignOutDeclined extends Error {}
const NOT_SIGNED_OUT = { fact: "couldn’t sign out.", reason: "you’re still signed in." };
const UNKNOWN = { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON };

/** One guarded exit. Authored writing drains or is deliberately discarded and its
 * account retired before the session ends; declining leaves everything intact. A sign-out
 * that did not end the session says so; one whose end is unknown holds until a retry settles. */
export function SignOutProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuthenticatedAccount();
  const guardedSignOut = useGuardedSignOut();
  const { say } = useOutcome();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [unknown, setUnknown] = useState<{ attempt: number } | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const refreshDevice = () => window.dispatchEvent(new Event("nexus:device-settings-refreshed"));
  const retry: CommandVerb = { label: "retry", commandKey: "RetrySignOut", busy, run: () => void request() };
  async function request() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    let nativeStarted = false;
    try {
      await guardedSignOut(async confirm => {
        if (!live.current) throw new Error("sign-out account is no longer active");
        await unbindNativePlayer();
        if (!live.current) throw new Error("sign-out account is no longer active");
        if (!await prepareAuthoredSignOut(accountId, confirm)) throw new SignOutDeclined();
        if (installedApp) {
          nativeStarted = true;
          // prepareAuthoredSignOut has drained or obtained the discard this carries.
          await sessionSignOut(true);
          if (live.current) publishAdmission("SignInRequired");
          return;
        }
        // BrowserWorkspace owns purge and session clearing beyond this unmount.
      }, () => {
        if (installedApp && live.current) refreshDevice();
      });
      if (live.current) setUnknown(null);
    } catch (error) {
      if (error instanceof SignOutDeclined) return;
      reportError(error);
      // Ended: the session is over, and the device's startup owns any unfinished cleanup.
      let ended: boolean | "Unknown" = false;
      if (nativeStarted) {
        if (isApiError(error) && error.code === "E_LOCAL_CLEANUP") ended = true;
        else try {
          const startup = await readDeviceStartup();
          ended = startup?.binding?.account.account_id !== accountId;
        } catch (inspection) {
          if (isApiError(inspection) && inspection.code === "E_LOCAL_CLEANUP") ended = true;
          else { reportError(inspection); ended = "Unknown"; }
        }
      }
      if (!live.current) return;
      if (ended === "Unknown") { setUnknown(current => ({ attempt: current === null ? 0 : current.attempt + 1 })); return; }
      setUnknown(null);
      if (ended) { publishAdmission("SignInRequired"); refreshDevice(); }
      else say(NOT_SIGNED_OUT, [retry]);
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <SignOutContext value={{ request: () => void request(), busy }}>
      {children}
      {unknown === null ? null : <Hold id="sign-out" attempt={unknown.attempt} line={UNKNOWN} verbs={[retry]} />}
    </SignOutContext>
  );
}

/** Account navigation, the account's condition and import attention, shared by the rail and
 * mobile Nexus. The mark says, by shape, whether something here needs a person; phones have
 * none. The trigger's description is the current state, pulled only. Rows are live while the
 * menu is closed; opening latches the last rendered ones, so a status change cannot move a
 * published row under the hand. */
export default function AccountMenu(props: {
  activeId: DestinationId | null;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: (
    trigger: Parameters<NonNullable<ComponentProps<typeof ActionMenu>["renderTrigger"]>>[0],
    accountMark: ReactElement,
  ) => ReactNode;
  onNavigate: (event: TargetActivationEvent, item: NavItem) => AppNavActivationResult;
}) {
  const updateVerb = useTransportVerbs()("Update")?.[0] ?? null;
  const workspace = useWorkspaceStore();
  const { signIn, busy: signingIn } = useAuthoredSignIn();
  const signOut = useContext(SignOutContext);
  const guard = useWorkGuard();
  const { summary } = useImports();
  const status = useAuthoredStatus();
  const detail = useAuthoredSyncDetail();
  const condition = useCondition();
  const commitFailed = useCommitFailed();
  const mobile = useIsMobileViewport();
  // `Update`'s line and verb read the remedy; a change of remedy re-renders them.
  useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const descriptionId = useId();
  const count = summary.status === "ready" ? summary.data.needs_attention_count : null;
  const attention = count !== null && count > 0 ? importAttentionDescription(count) : null;
  const mark = mobile ? null : condition !== null && MARK[condition] === "Solid" || attention !== null ? "Solid" : condition !== null ? "Hollow" : null;
  // The dot keeps its last shape through its fade out, so a healing mark never reads as another.
  const [shape, setShape] = useState<Mark>("Solid");
  if (mark !== null && mark !== shape) setShape(mark);
  const state = condition !== null ? conditionLine(condition, commitFailed).fact : STATUS_COPY[status];
  // `syncDetail` gives `syncing` no detail but a running preparation's clause.
  const preparation = status === "syncing" ? detail : null;
  const live = accountRows(condition, commitFailed, preparation, {
    signIn: { busy: signingIn || (signOut?.busy ?? false), run: signIn },
    update: updateVerb,
    restart: () => { if (guard.confirmDocumentExit()) window.location.reload(); },
  });
  const [latched, setLatched] = useState<readonly ActionDescriptor[] | null>(null);
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
        {item === NAV_IMPORTS ? <ImportsBadge label={item.label} count={count} /> : <span className={collection.content}>{item.label}</span>}
      </a>
    ),
  });


  const options: ActionDescriptor[] = [
    ...latched ?? live,
    link(NAV_STATS, props.activeId === "stats"),
    link(NAV_IMPORTS, props.activeId === "imports"),
    link(NAV_SETTINGS, props.activeId === "settings"),
    {
      kind: "command",
      id: "signout",
      label: "Sign out",
      tone: "danger",
      icon: null,
      separatorBefore: true,
      onSelect: signOut.request,
      disabled: signOut.busy,
    },
  ];
  if (localContentAvailable) {
    options.splice(options.length - 2, 0, {
      kind: "link",
      id: "downloads",
      label: "Downloads",
      href: "/downloads",
      icon: <Icon.Download aria-hidden="true" />,
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
        onOpenChange={open => setLatched(open ? live : null)}
        renderTrigger={(trigger) => props.renderTrigger({
          ...trigger,
          "aria-describedby": cx(trigger["aria-describedby"], descriptionId),
        }, <span className={accountStyles.mark} aria-hidden="true">
          <Icon.Account size={20} />
          <span className={accountStyles.attention} data-shape={shape} data-mark={mark ?? undefined} />
        </span>)}
        source={{ kind: "Immediate", subjectKey: "account", title: "account", content: { sections: [{ id: "Account", label: null, options }] } }}
      />
      <span id={descriptionId} className="sr-only">{attention === null ? state : `${state}; ${attention}`}</span>
    </>
  );
}

type RowVerbs = { update: Verb | null; signIn: { busy: boolean; run: () => void }; restart: () => void };

/** The condition's row and its verb, then a running preparation's row: each holds a row of its own. */
function accountRows(condition: Condition | null, commitFailed: boolean, preparation: string | null, verbs: RowVerbs): ActionDescriptor[] {
  const statusRow = (id: string, line: Line): ActionDescriptor => ({ kind: "custom", id, label: line.fact, render: () => <p className={accountStyles.status}>
    {line.fact}{line.reason ? <span className={accountStyles.reason}> {line.reason}</span> : null}
  </p> });
  const prepared = preparation === null ? [] : [statusRow("account-preparation", { fact: preparation })];
  if (condition === null) return prepared;
  const verb = conditionVerb(condition, verbs);
  return [statusRow("account-state", conditionLine(condition, commitFailed)), ...verb === null ? [] : [verb], ...prepared];
}

/** A condition's verb row is an ordinary command, so the menu closes before it runs. */
function conditionVerb(condition: Condition, verbs: RowVerbs): ActionDescriptor | null {
  const verb = (id: string, label: string, onSelect: (detail: ActionSelectDetail) => void, busy = false): ActionDescriptor =>
    ({ kind: "command", id, label, icon: null, disabled: busy, onSelect });
  switch (condition) {
    case "Stopped":
    case "SyncLocal": return verb("restart", "restart nexus", verbs.restart);
    case "Update": {
      const reload = verbs.update;
      return reload && "run" in reload ? verb("reload", reload.label, detail => reload.run(detail.openIntent)) : null;
    }
    case "SignIn": return verb("sign-in", "sign in", verbs.signIn.run, verbs.signIn.busy);
    case "Refused":
    case "Lagging":
    case "UpdateReady":
    case "Offline": return null;
  }
}
