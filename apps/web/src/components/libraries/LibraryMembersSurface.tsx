"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import PeopleSearchCombobox from "@/components/users/PeopleSearchCombobox";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import Select from "@/components/ui/Select";
import type {
  LibraryInvitation,
  LibraryMember,
  LibraryRole,
} from "@/lib/libraries/contract";
import type {
  LibraryMembersConfirmation,
  LibraryMembersController,
} from "@/lib/libraries/useLibraryMembers";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./LibraryMembersSurface.module.css";

function memberLabel(member: LibraryMember): string {
  return (
    member.display_name ??
    member.email ??
    member.user_handle
  );
}

function memberSecondary(member: LibraryMember): string | null {
  return member.display_name !== null
    ? member.email
    : null;
}

function invitationLabel(invitation: LibraryInvitation): string {
  return (
    invitation.invitee_display_name ??
    invitation.invitee_email ??
    invitation.invitee_user_handle
  );
}

function invitationSecondary(invitation: LibraryInvitation): string | null {
  return invitation.invitee_display_name !== null
    ? invitation.invitee_email
    : null;
}

function confirmationKey(
  confirmation: LibraryMembersConfirmation | null,
): string | null {
  if (!confirmation) return null;
  return confirmation.kind === "Revoke"
    ? `revoke:${confirmation.invitationHandle}`
    : `${confirmation.kind.toLowerCase()}:${confirmation.userHandle}`;
}

function confirmationSubject(
  confirmation: LibraryMembersConfirmation,
): string {
  return confirmation.kind === "Revoke"
    ? confirmation.invitationHandle
    : confirmation.userHandle;
}

function rowFocusFallback(row: HTMLElement | null): HTMLElement | null {
  const section = row?.closest<HTMLElement>(`.${styles.section}`) ?? null;
  const rows = Array.from(
    section?.querySelectorAll<HTMLElement>(`.${styles.row}`) ?? [],
  );
  const index = row ? rows.indexOf(row) : -1;
  const focusable = (candidate: HTMLElement | undefined) =>
    candidate?.querySelector<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? null;
  return (
    (index >= 0 ? focusable(rows[index + 1]) : null) ??
    (index > 0 ? focusable(rows[index - 1]) : null) ??
    section?.querySelector<HTMLElement>("h4") ??
    null
  );
}

function pageFeedback(
  pageLoad: { kind: string; feedback?: FeedbackContent },
): FeedbackContent | null {
  return pageLoad.kind === "Failed" && pageLoad.feedback
    ? pageLoad.feedback
    : null;
}

export default function LibraryMembersSurface({
  controller,
}: {
  controller: LibraryMembersController;
}) {
  const headingId = useId();
  const surfaceRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const confirmationFallbackRef = useRef<HTMLElement | null>(null);
  const priorConfirmationRef = useRef<string | null>(null);
  const priorCommandRunningRef = useRef(false);

  const currentConfirmationKey = confirmationKey(
    controller.draft.confirmation,
  );
  useEffect(() => {
    const confirmation = controller.draft.confirmation;
    if (
      confirmation === null ||
      confirmationFallbackRef.current?.isConnected
    ) {
      return;
    }
    confirmationTriggerRef.current = confirmation.returnFocusTarget;
    const subject = confirmationSubject(confirmation);
    const row =
      Array.from(
        surfaceRef.current?.querySelectorAll<HTMLElement>(
          `.${styles.row}`,
        ) ?? [],
      ).find(
        (candidate) => candidate.dataset.confirmationSubject === subject,
      ) ?? null;
    confirmationFallbackRef.current = rowFocusFallback(row);
  }, [controller.draft.confirmation]);
  useEffect(() => {
    const commandRunning = controller.command.kind === "Running";
    if (
      priorCommandRunningRef.current &&
      !commandRunning &&
      priorConfirmationRef.current !== null &&
      currentConfirmationKey === null
    ) {
      requestAnimationFrame(() => {
        const trigger = confirmationTriggerRef.current;
        if (trigger?.isConnected) trigger.focus();
        else if (confirmationFallbackRef.current?.isConnected) {
          confirmationFallbackRef.current.focus();
        }
      });
    }
    priorCommandRunningRef.current = commandRunning;
    priorConfirmationRef.current = currentConfirmationKey;
  }, [controller.command.kind, currentConfirmationKey]);

  const cancelConfirmation = () => {
    controller.setConfirmation(null);
    requestAnimationFrame(() => {
      const trigger = confirmationTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else if (confirmationFallbackRef.current?.isConnected) {
        confirmationFallbackRef.current.focus();
      }
    });
  };
  const captureConfirmationFocus = (trigger: HTMLElement | null) => {
    confirmationTriggerRef.current = trigger;
    const row = trigger?.closest<HTMLElement>(`.${styles.row}`) ?? null;
    confirmationFallbackRef.current = rowFocusFallback(row);
  };

  if (controller.snapshot.kind === "Idle") {
    return (
      <div className={styles.surface} role="status">
        Open Members to load Library governance.
      </div>
    );
  }

  if (controller.snapshot.kind === "Loading") {
    return (
      <div className={styles.surface} role="status">
        Loading members…
      </div>
    );
  }

  if (controller.snapshot.kind === "Failed") {
    return (
      <div className={styles.surface}>
        <FeedbackNotice
          content={controller.snapshot.feedback}
          announcement="Assertive"
          actions={[
            {
              label: "Retry",
              onClick: () => void controller.ensureFresh(),
            },
          ]}
        />
      </div>
    );
  }

  const {
    members,
    pendingInvites,
    refreshFeedback,
    reconciliation,
  } = controller.snapshot;
  const unconfirmedFeedback =
    reconciliation.kind === "Unconfirmed"
      ? refreshFeedback ?? {
          tone: "Warning" as const,
          title: "The last change is not confirmed.",
          message:
            "Member changes stay disabled until authoritative Library state is reconciled.",
        }
      : null;
  const searchResults =
    controller.search.kind === "Ready" ? controller.search.results : [];
  const searchFeedback =
    controller.search.kind === "Failed" ? controller.search.feedback : null;
  const searchStatus =
    controller.search.kind === "Failed"
      ? controller.search.feedback.title
      : controller.search.kind === "Loading"
      ? "Searching…"
      : controller.search.kind === "Ready"
        ? controller.search.results.length === 0
          ? "No matching Nexus users."
          : `${controller.search.results.length} ${
              controller.search.results.length === 1 ? "result" : "results"
            }`
        : controller.draft.query.trim().length > 0 &&
            controller.draft.query.trim().length < 3
          ? "Enter at least 3 characters."
          : undefined;
  const inviteRunning =
    controller.command.kind === "Running" &&
    controller.command.operation.kind === "Invite";

  return (
    <section
      ref={surfaceRef}
      className={styles.surface}
      aria-labelledby={headingId}
    >
      <div className={styles.header}>
        <div>
          <h3
            id={headingId}
          >
            Members
          </h3>
          <p>Manage access to {controller.library.name}.</p>
        </div>
      </div>

      {unconfirmedFeedback ? (
        <FeedbackNotice
          content={unconfirmedFeedback}
          announcement="Assertive"
          actions={[
            {
              label: "Retry reconciliation",
              onClick: () => void controller.retryReconciliation(),
            },
          ]}
        />
      ) : refreshFeedback ? (
        <FeedbackNotice
          content={refreshFeedback}
          announcement="Assertive"
        />
      ) : null}

      <div className={styles.invite}>
        <PeopleSearchCombobox
          label="Find an existing Nexus user by name or account email"
          placeholder="Name or email…"
          description="Find an existing Nexus user by name or account email."
          status={searchStatus}
          query={controller.draft.query}
          results={searchResults}
          searching={controller.search.kind === "Loading"}
          disabled={controller.mutationsDisabled}
          onQueryChange={controller.setQuery}
          onSelect={controller.selectUser}
        />
        <div className={styles.inviteActions}>
          <Select
            size="sm"
            value={controller.draft.inviteRole}
            aria-label="Invitation role"
            disabled={controller.mutationsDisabled}
            onChange={(event) =>
              controller.setInviteRole(event.target.value as LibraryRole)
            }
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
          <Button
            variant="secondary"
            size="sm"
            loading={inviteRunning}
            disabled={
              controller.mutationsDisabled ||
              controller.draft.selectedUser === null
            }
            onClick={() => void controller.inviteSelectedUser()}
          >
            Invite
          </Button>
        </div>
        {searchFeedback ? (
          <FeedbackNotice
            content={searchFeedback}
            announcement="None"
          />
        ) : null}
      </div>

      <div className={styles.section}>
        <h4 tabIndex={-1}>People</h4>
        <div className={styles.rows}>
          {members.rows.map((member) => (
            <MemberRow
              key={member.user_handle}
              member={member}
              canTransferOwnership={
                controller.library.can_transfer_ownership &&
                !member.is_owner
              }
              disabled={controller.mutationsDisabled}
              confirmation={controller.draft.confirmation}
              onOpenConfirmation={(confirmation, trigger) => {
                captureConfirmationFocus(trigger);
                controller.setConfirmation(confirmation);
              }}
              onCancelConfirmation={cancelConfirmation}
              onUpdateRole={(role) =>
                void controller.updateRole(
                  member.user_handle,
                  role,
                )
              }
              onRemove={() =>
                void controller.removeMember(member.user_handle)
              }
              onTransfer={() =>
                void controller.transferOwnership(member.user_handle)
              }
              command={controller.command}
            />
          ))}
        </div>
        {pageFeedback(members.pageLoad) ? (
          <div className={styles.pageError}>
            <FeedbackNotice
              content={pageFeedback(members.pageLoad)!}
              announcement="Assertive"
              actions={reconciliation.kind === "Confirmed" ? [
                {
                  label: "Retry",
                  onClick: () => void controller.loadMoreMembers(),
                },
              ] : undefined}
            />
          </div>
        ) : (
          <LoadMoreFooter
            hasMore={members.nextCursor !== null}
            loading={members.pageLoad.kind === "Loading"}
            disabled={reconciliation.kind !== "Confirmed"}
            onLoadMore={() => void controller.loadMoreMembers()}
            label="Load more members"
          />
        )}
      </div>

      <div className={styles.section}>
        <h4 tabIndex={-1}>Pending invitations</h4>
        <div className={styles.rows}>
          {pendingInvites.rows.length === 0 ? (
            <p className={styles.empty}>No pending invitations.</p>
          ) : null}
          {pendingInvites.rows.map((invitation) => {
              const confirmed =
                controller.draft.confirmation?.kind === "Revoke" &&
                controller.draft.confirmation.invitationHandle ===
                  invitation.invitation_handle;
              return (
                <div
                  key={invitation.invitation_handle}
                  className={styles.row}
                  data-confirmation-subject={invitation.invitation_handle}
                >
                  <div className={styles.identity}>
                    <strong>{invitationLabel(invitation)}</strong>
                    {invitationSecondary(invitation) ? (
                      <span>{invitationSecondary(invitation)}</span>
                    ) : null}
                    <span className={styles.fact}>
                      Pending invitation · {invitation.role}
                    </span>
                  </div>
                  {confirmed ? (
                    <InlineConfirmation
                      title="Revoke invitation?"
                      description={`Revoke the pending invitation for ${invitationLabel(invitation)}?`}
                      confirmLabel="Revoke"
                      confirmAriaLabel={`Revoke invitation for ${invitationLabel(invitation)}`}
                      cancelAriaLabel={`Cancel revoking invitation for ${invitationLabel(invitation)}`}
                      busy={
                        controller.command.kind === "Running" &&
                        controller.command.operation.kind === "Revoke"
                      }
                      onConfirm={() =>
                        void controller.revokeInvite(
                          invitation.invitation_handle,
                        )
                      }
                      onCancel={cancelConfirmation}
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={controller.mutationsDisabled}
                      aria-label={`Revoke invitation for ${invitationLabel(invitation)}`}
                      onClick={(event) => {
                        captureConfirmationFocus(event.currentTarget);
                        controller.setConfirmation({
                          kind: "Revoke",
                          invitationHandle: invitation.invitation_handle,
                          label: invitationLabel(invitation),
                          returnFocusTarget: event.currentTarget,
                        });
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              );
          })}
        </div>
        {pageFeedback(pendingInvites.pageLoad) ? (
          <div className={styles.pageError}>
            <FeedbackNotice
              content={pageFeedback(pendingInvites.pageLoad)!}
              announcement="Assertive"
              actions={reconciliation.kind === "Confirmed" ? [
                {
                  label: "Retry",
                  onClick: () => void controller.loadMoreInvites(),
                },
              ] : undefined}
            />
          </div>
        ) : (
          <LoadMoreFooter
            hasMore={pendingInvites.nextCursor !== null}
            loading={pendingInvites.pageLoad.kind === "Loading"}
            disabled={reconciliation.kind !== "Confirmed"}
            onLoadMore={() => void controller.loadMoreInvites()}
            label="Load more invitations"
          />
        )}
      </div>

      <p className={styles.disclosure}>
        Removing a member closes only this Library membership path. They may
        retain access through another Library or direct grant.
      </p>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {refreshFeedback === null ? controller.announcement : ""}
      </div>
    </section>
  );
}

function MemberRow({
  member,
  canTransferOwnership,
  disabled,
  confirmation,
  onOpenConfirmation,
  onCancelConfirmation,
  onUpdateRole,
  onRemove,
  onTransfer,
  command,
}: {
  member: LibraryMember;
  canTransferOwnership: boolean;
  disabled: boolean;
  confirmation: LibraryMembersConfirmation | null;
  onOpenConfirmation: (
    confirmation: LibraryMembersConfirmation,
    trigger: HTMLElement | null,
  ) => void;
  onCancelConfirmation: () => void;
  onUpdateRole: (role: LibraryRole) => void;
  onRemove: () => void;
  onTransfer: () => void;
  command: LibraryMembersController["command"];
}) {
  const label = memberLabel(member);
  const secondary = memberSecondary(member);
  const removeConfirmed =
    confirmation?.kind === "Remove" &&
    confirmation.userHandle === member.user_handle;
  const transferConfirmed =
    confirmation?.kind === "Transfer" &&
    confirmation.userHandle === member.user_handle;
  const options = useMemo<ActionDescriptor[]>(() => {
    if (member.is_owner) return [];
    const actions: ActionDescriptor[] = [
      {
        kind: "command",
        id: `LibraryMember.Remove.${member.user_handle}`,
        label: "Remove member…",
        tone: "danger",
        disabled,
        restoreFocusOnClose: false,
        onSelect: ({ triggerEl }) =>
          onOpenConfirmation(
            {
              kind: "Remove",
              userHandle: member.user_handle,
              label,
              returnFocusTarget: triggerEl,
            },
            triggerEl,
          ),
      },
    ];
    if (canTransferOwnership) {
      actions.push({
        kind: "command",
        id: `LibraryMember.Transfer.${member.user_handle}`,
        label: "Transfer ownership…",
        tone: "danger",
        disabled,
        restoreFocusOnClose: false,
        onSelect: ({ triggerEl }) =>
          onOpenConfirmation(
            {
              kind: "Transfer",
              userHandle: member.user_handle,
              label,
              returnFocusTarget: triggerEl,
            },
            triggerEl,
          ),
      });
    }
    return actions;
  }, [
    canTransferOwnership,
    disabled,
    label,
    member.is_owner,
    member.user_handle,
    onOpenConfirmation,
  ]);

  return (
    <div
      className={styles.row}
      data-confirmation-subject={member.user_handle}
    >
      <div className={styles.identity}>
        <strong>{label}</strong>
        {secondary ? <span>{secondary}</span> : null}
        {member.is_owner ? (
          <>
            <span className={styles.fact}>Owner</span>
            <span className={styles.fact}>Role: Admin</span>
          </>
        ) : null}
      </div>
      {removeConfirmed ? (
        <InlineConfirmation
          title="Remove member?"
          description={`Remove ${label} from this Library? Other access paths are not changed.`}
          confirmLabel="Remove"
          confirmAriaLabel={`Remove ${label}`}
          cancelAriaLabel={`Cancel removing ${label}`}
          busy={
            command.kind === "Running" &&
            command.operation.kind === "Remove"
          }
          onConfirm={onRemove}
          onCancel={onCancelConfirmation}
        />
      ) : transferConfirmed ? (
        <InlineConfirmation
          title="Transfer Library ownership?"
          description={`Make ${label} the owner? You will remain an admin.`}
          confirmLabel="Transfer"
          confirmAriaLabel={`Transfer Library ownership to ${label}`}
          cancelAriaLabel={`Cancel transferring Library ownership to ${label}`}
          busy={
            command.kind === "Running" &&
            command.operation.kind === "Transfer"
          }
          onConfirm={onTransfer}
          onCancel={onCancelConfirmation}
        />
      ) : member.is_owner ? null : (
        <div className={styles.memberActions}>
          <Select
            size="sm"
            value={member.role}
            aria-label={`Role for ${label}`}
            disabled={disabled}
            onChange={(event) =>
              onUpdateRole(event.target.value as LibraryRole)
            }
          >
            <option value="member">Role: Member</option>
            <option value="admin">Role: Admin</option>
          </Select>
          <ActionMenu
            label={`Actions for ${label}`}
            options={options}
          />
        </div>
      )}
    </div>
  );
}

function InlineConfirmation({
  title,
  description,
  confirmLabel,
  confirmAriaLabel,
  cancelAriaLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  confirmAriaLabel: string;
  cancelAriaLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  return (
    <div
      className={styles.confirmation}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={onKeyDown}
    >
      <strong id={titleId}>{title}</strong>
      <span id={descriptionId}>{description}</span>
      <div className={styles.confirmationActions}>
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onCancel}
          aria-label={cancelAriaLabel}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          onClick={onConfirm}
          aria-label={confirmAriaLabel}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
