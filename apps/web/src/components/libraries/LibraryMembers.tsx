"use client";

import * as Icon from "@/lib/ui/icons";
import { assertNever } from "@/lib/assertNever";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";

/** The library visit owns one exact member command across inspector mounts. Pending
 * dispatch and unknown outcomes hold the loss guard; fresh opposite lists prove nothing.
 * Only acknowledgement, an observed desired state or an exact terminal fence settles it. */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Failed, Fact } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import Select from "@/components/ui/Select";
import PeopleSearch, { personLabel, type Person } from "@/components/users/PeopleSearch";
import { useServerList, type ListSnapshot, type ServerList } from "@/lib/api/useServerList";
import {
  invitationsPage,
  invite,
  membersPage,
  removeMember,
  revokeInvitation,
  setMemberRole,
  transferOwnership,
  type Library,
  type LibraryInvitation,
  type LibraryMember,
  type LibraryRole,
} from "@/lib/libraries/api";
import { isApiError, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { refuseLibrary } from "@/lib/libraries/errors";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import type { Schema } from "@/lib/api/wire";
import { remoteAdmission, remoteAttemptAllowed } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./LibraryMembers.module.css";

const MEMBERS = definePaneVisitDataKey<ListSnapshot<LibraryMember>>("Library.Members");
const INVITATIONS = definePaneVisitDataKey<ListSnapshot<LibraryInvitation>>("Library.Invitations");

/** A row's pending confirmation: its question and the command it confirms. */
interface Question {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly yes: string;
  readonly yesLabel: string;
  readonly cancelLabel: string;
  readonly run: () => Promise<boolean>;
}

type Command = { readonly libraryId: string; readonly fact: string } & (
  | { readonly kind: "Invite"; readonly body: Schema<"CreateInvitationRequest"> }
  | { readonly kind: "Role"; readonly userId: string; readonly role: LibraryRole; readonly expectedRole: LibraryRole }
  | { readonly kind: "Remove" | "Transfer"; readonly userId: string }
  | { readonly kind: "Revoke"; readonly invitationId: string }
);
type Pending = { readonly key: string; readonly command: Command; readonly running: boolean; readonly unknown: number };

/** The pane mounts this owner even while its management body is unavailable. */
export function useLibraryMembers(library: Library | null, open: boolean, reread: () => void) {
  const pane = requirePaneRuntime(usePaneRuntime(), "library members");
  const { ctx } = useActionRuntime();
  const account = ctx.sessionSignal();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const admission = useRemoteAdmission();
  const connectivity = useConnectivity();
  const active = usePaneIsActive() && open;
  const [version, setVersion] = useState(0);
  const owner = useResourceDraft<Pending | null>("Library.MemberCommand", () => null, value => ({
    changed: false, unconfirmed: value !== null, stopsBrowserWork: false,
  }));
  const { read, set } = owner;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const id = pane.pathParams.id;
  if (id === undefined) throw new Error("library members require a library route");
  const owns = () => !account.aborted && ctx.workspace().state.panes.some(current => {
    const route = resolvePaneRouteModel(current.current_visit.href);
    return current.id === pane.paneId && current.current_visit.id === pane.visitId && route.id === "library" && route.params.id === id;
  });
  const key = library?.can_manage && open ? id : null;
  const members = useServerList<LibraryMember>({
    key: key && `members:${key}`, stale: String(version), pageSize: 100, active, visit: MEMBERS,
    id: member => member.user_id, fetchPage: (cursor, limit, signal) => membersPage(id, cursor, limit, signal),
  });
  const invitations = useServerList<LibraryInvitation>({
    key: key && `invitations:${key}`, stale: String(version), pageSize: 100, active, visit: INVITATIONS,
    id: invitation => invitation.id, fetchPage: (cursor, limit, signal) => invitationsPage(id, cursor, limit, signal),
  });
  const pending = owner.value;
  let observed = false;
  if (pending !== null && !pending.running && pending.unknown > 0) {
    const command = pending.command;
    switch (command.kind) {
      case "Invite": observed = invitations.fresh && invitations.complete && invitations.items.some(invitation => invitation.id === command.body.id &&
        invitation.invitee_user_id === command.body.invitee_user_id && invitation.role === command.body.role &&
        invitation.invitee_email === command.body.invitee_email); break;
      case "Role": observed = members.fresh && members.complete && members.items.some(member => member.user_id === command.userId && member.role === command.role); break;
      case "Transfer": observed = members.fresh && members.complete && members.items.some(member => member.user_id === command.userId && member.is_owner); break;
      // Pending-only invitation absence does not identify its terminal status.
      // Removed membership could be recreated. Exact accepted replay owns these.
      case "Remove": case "Revoke": break;
      default: assertNever(command);
    }
  }
  useEffect(() => { if (observed) set(value => value === pending ? null : value); }, [observed, pending, set]);
  async function send(command: Command, previous: Pending | null): Promise<boolean> {
    if (!mounted.current || !owns() || read() !== previous || previous?.running ||
      remoteAdmission() === "Checking" || !remoteAttemptAllowed() || !navigator.onLine) return false;
    const key = previous?.key ?? crypto.randomUUID();
    set({ key, command, running: true, unknown: previous?.unknown ?? 0 });
    const current = () => owns() && read()?.command === command;
    try {
      switch (command.kind) {
        case "Invite": await invite(command.libraryId, command.body); break;
        case "Role": await setMemberRole(command.libraryId, command.userId, command.role, command.expectedRole); break;
        case "Remove": await removeMember(command.libraryId, command.userId); break;
        case "Transfer": await transferOwnership(command.libraryId, command.userId); break;
        case "Revoke": await revokeInvitation(command.invitationId); break;
        default: assertNever(command);
      }
      if (!current()) return false;
      set(null);
      return true;
    } catch (error) {
      if (!current()) return false;
      handleUnauthenticatedApiError(error);
      const fenced = command.kind === "Revoke" && isApiError(error) && error.code === "E_INVITE_NOT_PENDING";
      if (!fenced && (outcomeUnknown(error) || (previous?.unknown ?? 0) > 0))
        set({ key, command, running: true, unknown: (previous?.unknown ?? 0) + 1 });
      else set(null);
      if (!outcomeUnknown(error)) refuseLibrary(outcome, error, previous?.unknown ? "couldn’t retry that change." : command.fact);
      return false;
    } finally {
      set(value => value?.command !== command ? value : owns() ? { ...value, running: false } : null);
      if (mounted.current && owns()) { setVersion(n => n + 1); reread(); }
    }
  }
  const held: ReactNode = pending === null || pending.unknown === 0 ? null : <Hold
    id={`${owner.owner}:${pending.key}`} attempt={pending.unknown}
    {...resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
      resend: { label: "retry", commandKey: `${owner.owner}:${pending.key}:retry`, busy: pending.running,
        run: () => { void send(pending.command, pending); } } })} />;
  const busy = pending !== null || admission === "Checking" || !remoteAttemptAllowed() || connectivity === "Offline";
  return { held, shown: library?.can_manage ? { library, members, invitations, busy,
    run: (command: Command) => send(command, null) } : null };
}

export type LibraryMembersState = NonNullable<ReturnType<typeof useLibraryMembers>["shown"]>;

export default function LibraryMembers({ state }: { readonly state: LibraryMembersState }) {
  const { library, members, invitations, busy, run } = state;
  const [person, setPerson] = useState<Person | null>(null);
  const [role, setRole] = useState<LibraryRole>("member");
  const [question, setQuestion] = useState<Question | null>(null);
  // Each row's own trigger, so a closed question returns focus to its row.
  const triggers = useRef(new Map<string, HTMLElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const memberFeedback = useCollectionReadFeedback({
    list: members, unit: { singular: "member", plural: "members" },
    waiting: members.status === "loading", outcome: null,
    returnFocus: () => heading.current,
  });
  const invitationsEmpty = invitations.complete && invitations.items.length === 0;
  const invitationFeedback = useCollectionReadFeedback({
    list: invitations, unit: { singular: "invitation", plural: "invitations" },
    waiting: invitations.status === "loading", outcome: invitationsEmpty ? "no pending invitations." : null,
    returnFocus: () => heading.current,
  });
  const trigger = (key: string) => (node: HTMLElement | null) => {
    if (node) triggers.current.set(key, node);
    else triggers.current.delete(key);
  };
  const close = (key: string) => {
    setQuestion(null);
    requestAnimationFrame(() => (triggers.current.get(key) ?? heading.current)?.focus());
  };

  const sendInvite = async () => {
    if (person === null) return;
    const sent = await run({ kind: "Invite", libraryId: library.id,
      fact: `couldn’t invite ${personLabel(person)}.`, body: {
        id: crypto.randomUUID(), invitee_user_id: person.user_id, invitee_email: person.email, role,
      } });
    if (sent) setPerson(null);
  };

  const confirmation = (q: Question) => (
    <div
      className={styles.confirm}
      role="alertdialog"
      aria-label={q.title}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        event.stopPropagation();
        close(q.key);
      }}
    >
      <strong>{q.title}</strong>
      <span>{q.description}</span>
      <span className={styles.actions}>
        <Button
          autoFocus
          disabled={busy}
          aria-label={q.cancelLabel}
          onClick={() => close(q.key)}
        >
          Cancel
        </Button>
        <Button
          emphasis="strong" tone="danger"
          aria-label={q.yesLabel}
          onClick={async () => {
            if (await q.run()) close(q.key);
          }}
          disabled={busy}
          aria-busy={busy}
        >
          {q.yes}
        </Button>
      </span>
    </div>
  );

  /** A cold read waits or fails where its rows would stand; a failed reread over rows says nothing. */
  const footer = (list: ServerList<unknown>, noun: string) => list.status === "loading" ? <Ruling />
    : list.status === "failed" ? <Failed error={list.failure?.error} noun={noun} retry={{ run: list.retry, busy: list.running !== null }} /> : null;

  return (
    <section className={styles.surface} aria-labelledby={headingId}>
      <div>
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          Members
        </h3>
        <p>Manage who can open {library.name}.</p>
      </div>
      <div className={styles.invite}>
        <PeopleSearch
          context={library.id}
          label="Find an existing Nexus user by name or account email"
          placeholder="Name or email…"
          description="Search display names, or enter an account’s exact email."
          disabled={busy}
          selected={person}
          onSelect={setPerson}
        />
        <span className={styles.actions}>
          <Select
            size="sm"
            aria-label="Invitation role"
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as LibraryRole)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
          <Button
            emphasis="strong"
            disabled={busy || person === null}
            onClick={() => void sendInvite()}
          >
            Invite
          </Button>
        </span>
      </div>

      <div className={styles.section}>
        <h4>People</h4>
        {members.items.map((member) => {
          const key = `member:${member.user_id}`;
          const name = personLabel(member);
          const ask = (q: Omit<Question, "key">) => () => setQuestion({ key, ...q });
          return (
            <div key={key} className={styles.row}>
              <span className={styles.identity}>
                <strong>{name}</strong>
                {member.display_name !== null && member.email !== null ? (
                  <span>{member.email}</span>
                ) : null}
                {member.is_owner ? <span>Owner · Admin</span> : null}
              </span>
              {question?.key === key ? (
                confirmation(question)
              ) : member.is_owner ? null : (
                <span className={styles.actions}>
                  <Select
                    size="sm"
                    aria-label={`Role for ${name}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value as LibraryRole;
                      void run({ kind: "Role", libraryId: library.id, userId: member.user_id,
                        role: next, expectedRole: member.role, fact: `couldn’t change ${name}’s role.` });
                    }}
                  >
                    <option value="member">Role: Member</option>
                    <option value="admin">Role: Admin</option>
                  </Select>
                  <ActionMenu
                    label={`more actions for ${name}`}
                    triggerRef={trigger(key)}
                    triggerDisabled={busy}
                    source={{ kind: "Immediate", subjectKey: `library:${library.id}:${key}`, title: name, content: { sections: [{ id: "Member", label: null, options: [
                      {
                        kind: "command",
                        id: `LibraryMember.Remove.${member.user_id}`,
                        label: "Remove member…", icon: <Icon.Remove aria-hidden="true" />,
                        tone: "danger",
                        restoreFocusOnClose: false,
                        onSelect: ask({
                          title: "Remove member?",
                          description: `Remove ${name} from this library? Other access they have is unchanged.`,
                          yes: "Remove",
                          yesLabel: `Remove ${name}`,
                          cancelLabel: `Cancel removing ${name}`,
                          run: () =>
                            run({ kind: "Remove", libraryId: library.id, userId: member.user_id, fact: `couldn’t remove ${name}.` }),
                        }),
                      },
                      ...(library.can_transfer_ownership
                        ? [
                            {
                              kind: "command" as const,
                              id: `LibraryMember.Transfer.${member.user_id}`,
                              label: "Transfer ownership…", icon: null,
                              tone: "danger" as const,
                              restoreFocusOnClose: false,
                              onSelect: ask({
                                title: "Transfer library ownership?",
                                description: `Make ${name} the owner? You stay an admin.`,
                                yes: "Transfer",
                                yesLabel: `Transfer Library ownership to ${name}`,
                                cancelLabel: `Cancel transferring Library ownership to ${name}`,
                                run: () =>
                                  run({ kind: "Transfer", libraryId: library.id, userId: member.user_id, fact: `couldn’t make ${name} the owner.` }),
                              }),
                            },
                          ]
                        : []),
                    ] }] } }}
                  />
                </span>
              )}
            </div>
          );
        })}
        {footer(members, "members")}
        {memberFeedback.notice}
      </div>

      <div className={styles.section}>
        <h4>Pending invitations</h4>
        {invitations.current && invitations.failure === null && invitationsEmpty ? <Fact line={{ fact: "no pending invitations." }} /> : null}
        {invitations.items.map((invitation) => {
          const key = `invitation:${invitation.id}`;
          const name = personLabel({
            display_name: invitation.invitee_display_name,
            email: invitation.invitee_email,
          });
          return (
            <div key={key} className={styles.row}>
              <span className={styles.identity}>
                <strong>{name}</strong>
                <span>Pending invitation · {invitation.role === "admin" ? "Admin" : "Member"}</span>
              </span>
              {question?.key === key ? (
                confirmation(question)
              ) : (
                <Button
                  ref={trigger(key)}
                  disabled={busy}
                  aria-label={`Revoke invitation for ${name}`}
                  onClick={() =>
                    setQuestion({
                      key,
                      title: "Revoke invitation?",
                      description: `Revoke the pending invitation for ${name}?`,
                      yes: "Revoke",
                      yesLabel: `Revoke invitation for ${name}`,
                      cancelLabel: `Cancel revoking invitation for ${name}`,
                      run: () =>
                        run({ kind: "Revoke", libraryId: library.id, invitationId: invitation.id, fact: `couldn’t revoke ${name}’s invitation.` }),
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
        {footer(invitations, "pending invitations")}
        {invitationFeedback.notice}
      </div>
      <p className={styles.note}>
        Removing a member closes only this library’s access; they may keep access through another
        library or a direct share.
      </p>
      {memberFeedback.announcement}
      {invitationFeedback.announcement}
    </section>
  );
}
