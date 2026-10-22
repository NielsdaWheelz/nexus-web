"use client";

// The Members tab for an admin of a named library: invite an existing user, the
// people (role, remove, transfer ownership) and the pending invitations (revoke).
// Every command is request, then reread: one command at a time, and after any
// outcome both lists and the library are read again, so a refused command shows
// its copy and the tab goes once the reread says the viewer no longer manages the
// library. The hook runs in the library pane (its lists keep that pane's visit);
// the tab renders its state wherever the inspector puts it.

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import Select from "@/components/ui/Select";
import PeopleSearch, { personLabel, type Person } from "@/components/users/PeopleSearch";
import { useThrowLater } from "@/lib/api/serverState";
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
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
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

/** Null unless the viewer manages the library; lists load while `open`. */
export function useLibraryMembers(library: Library | null, open: boolean, reread: () => void) {
  const fail = useThrowLater();
  const active = usePaneIsActive() && open;
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const shown = library?.can_manage === true;
  const id = library?.id ?? "";
  const key = shown && open ? id : null;
  const members = useServerList<LibraryMember>({
    key: key && `members:${key}`,
    stale: String(version),
    pageSize: 100,
    active,
    visit: MEMBERS,
    id: (member) => member.user_id,
    fetchPage: (cursor, limit, signal) => membersPage(id, cursor, limit, signal),
  });
  const invitations = useServerList<LibraryInvitation>({
    key: key && `invitations:${key}`,
    stale: String(version),
    pageSize: 100,
    active,
    visit: INVITATIONS,
    id: (invitation) => invitation.id,
    fetchPage: (cursor, limit, signal) => invitationsPage(id, cursor, limit, signal),
  });
  /** Runs one command; true when it landed. */
  const run = async (title: string, done: string, command: () => Promise<void>) => {
    if (busy) return false;
    setBusy(true);
    setFeedback(null);
    try {
      await command();
      setAnnouncement(done);
      return true;
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, title, fail));
      return false;
    } finally {
      setVersion((n) => n + 1);
      reread();
      setBusy(false);
    }
  };
  if (!shown || library === null) return null;
  return { library, members, invitations, busy, feedback, announcement, run };
}

export type LibraryMembersState = NonNullable<ReturnType<typeof useLibraryMembers>>;

export default function LibraryMembers({ state }: { readonly state: LibraryMembersState }) {
  const { library, members, invitations, busy, run } = state;
  const [person, setPerson] = useState<Person | null>(null);
  const [role, setRole] = useState<LibraryRole>("member");
  const [question, setQuestion] = useState<Question | null>(null);
  // A retried invitation resends its id; another person or role mints a new one.
  const attempt = useRef<{ readonly key: string; readonly id: string } | null>(null);
  // Each row's own trigger, so a closed question returns focus to its row.
  const triggers = useRef(new Map<string, HTMLElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
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
    const key = `${person.user_id}:${role}`;
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const body = {
      id: attempt.current.id,
      invitee_user_id: person.user_id,
      invitee_email: person.email,
      role,
    };
    const sent = await run(
      "Invitation wasn’t sent",
      "Invitation sent. They’ll see it when they next open Libraries; no email was sent.",
      () => invite(library.id, body),
    );
    if (sent) {
      attempt.current = null;
      setPerson(null);
    }
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
          variant="secondary"
          size="sm"
          autoFocus
          disabled={busy}
          aria-label={q.cancelLabel}
          onClick={() => close(q.key)}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          aria-label={q.yesLabel}
          onClick={async () => {
            if (await q.run()) close(q.key);
          }}
        >
          {q.yes}
        </Button>
      </span>
    </div>
  );

  const footer = (list: ServerList<unknown>, singular: string, what: string) => <>
    {list.status === "loading" ? (
      <FeedbackStatus content={{ tone: "Neutral", title: `loading ${what}…` }} announcement="Polite" />
    ) : list.failure && list.failure.op !== "More" ? (
      <FeedbackNotice
        content={
          libraryErrorFeedback(list.failure.error, `The ${what} couldn’t be loaded`, throwDefect) ?? {
            tone: "Danger",
            title: `The ${what} couldn’t be loaded`,
          }
        }
        announcement="Polite"
        actions={[{ label: "Retry", onClick: list.retry, busy: list.running !== null }]}
      />
    ) : null}
    <CollectionExhaustionNotice list={list} unit={{ singular, plural: what }} returnFocus={() => heading.current} />
  </>;

  return (
    <section className={styles.surface} aria-labelledby={headingId}>
      <div>
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          Members
        </h3>
        <p>Manage who can open {library.name}.</p>
      </div>
      {state.feedback ? <FeedbackNotice content={state.feedback} announcement="Assertive" /> : null}
      <div className={styles.invite}>
        <PeopleSearch
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
            variant="secondary"
            size="sm"
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
                      void run("Role wasn’t changed", `Role changed to ${next}.`, () =>
                        setMemberRole(library.id, member.user_id, next, member.role),
                      );
                    }}
                  >
                    <option value="member">Role: Member</option>
                    <option value="admin">Role: Admin</option>
                  </Select>
                  <ActionMenu
                    label={`more actions for ${name}`}
                    triggerRef={trigger(key)}
                    triggerDisabled={busy}
                    triggerDisabledReason="Another change is in progress."
                    source={{ kind: "Immediate", subjectKey: `library:${library.id}:${key}`, title: name, content: { sections: [{ id: "Member", label: null, options: [
                      {
                        kind: "command",
                        id: `LibraryMember.Remove.${member.user_id}`,
                        label: "Remove member…",
                        tone: "danger",
                        restoreFocusOnClose: false,
                        onSelect: ask({
                          title: "Remove member?",
                          description: `Remove ${name} from this library? Other access they have is unchanged.`,
                          yes: "Remove",
                          yesLabel: `Remove ${name}`,
                          cancelLabel: `Cancel removing ${name}`,
                          run: () =>
                            run("Member wasn’t removed", "Member removed.", () =>
                              removeMember(library.id, member.user_id),
                            ),
                        }),
                      },
                      ...(library.can_transfer_ownership
                        ? [
                            {
                              kind: "command" as const,
                              id: `LibraryMember.Transfer.${member.user_id}`,
                              label: "Transfer ownership…",
                              tone: "danger" as const,
                              restoreFocusOnClose: false,
                              onSelect: ask({
                                title: "Transfer library ownership?",
                                description: `Make ${name} the owner? You stay an admin.`,
                                yes: "Transfer",
                                yesLabel: `Transfer Library ownership to ${name}`,
                                cancelLabel: `Cancel transferring Library ownership to ${name}`,
                                run: () =>
                                  run("Ownership wasn’t transferred", "Ownership transferred.", () =>
                                    transferOwnership(library.id, member.user_id),
                                  ),
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
        {footer(members, "member", "members")}
      </div>

      <div className={styles.section}>
        <h4>Pending invitations</h4>
        {invitations.complete && invitations.items.length === 0 ? (
          <p className={styles.note}>No pending invitations.</p>
        ) : null}
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
                  variant="ghost"
                  size="sm"
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
                        run("Invitation wasn’t revoked", "Invitation revoked.", () =>
                          revokeInvitation(invitation.id),
                        ),
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
        {footer(invitations, "invitation", "invitations")}
      </div>
      <p className={styles.note}>
        Removing a member closes only this library’s access; they may keep access through another
        library or a direct share.
      </p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.announcement}
      </div>
    </section>
  );
}
