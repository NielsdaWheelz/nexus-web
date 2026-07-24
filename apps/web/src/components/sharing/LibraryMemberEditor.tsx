"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PeopleSearchCombobox from "@/components/sharing/PeopleSearchCombobox";
import Select from "@/components/ui/Select";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  createLibraryInvite,
  fetchEditableLibrarySharing,
  removeLibraryMember,
  revokeLibraryInvite,
  searchLibraryUsers,
  transferLibraryOwnership,
  updateLibraryMemberRole,
  type EditableLibrarySharing,
  type LibraryInvite,
  type LibraryMember,
  type LibraryRole,
  type UserSearchResult,
} from "@/lib/libraries/sharing";
import styles from "./LibraryMemberEditor.module.css";

function personLabel(person: {
  displayName: string | null;
  email: string | null;
  userHandle: string;
}): string {
  return person.displayName ?? person.email ?? person.userHandle;
}

function inviteLabel(invite: LibraryInvite): string {
  return (
    invite.inviteeDisplayName ??
    invite.inviteeEmail ??
    invite.inviteeUserHandle
  );
}

export default function LibraryMemberEditor({
  libraryId,
}: {
  libraryId: string;
}) {
  const [sharing, setSharing] = useState<EditableLibrarySharing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inviteRole, setInviteRole] = useState<LibraryRole>("member");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(
    null,
  );
  const searchSequence = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        setSharing(await fetchEditableLibrarySharing(libraryId, signal));
      } catch (loadError) {
        if (signal?.aborted || handleUnauthenticatedApiError(loadError)) return;
        setError(
          toFeedback(loadError, {
            fallback: "Library members could not be loaded.",
          }),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [libraryId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++searchSequence.current;
    if (selectedUser || trimmed.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    setResults([]);
    setSearching(false);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await searchLibraryUsers(trimmed, controller.signal);
        if (searchSequence.current === sequence) setResults(next);
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setError(
            toFeedback(searchError, {
              fallback: "People could not be searched.",
            }),
          );
        }
      } finally {
        if (searchSequence.current === sequence) setSearching(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, selectedUser]);

  if (loading) {
    return (
      <div className={styles.stableState} role="status">
        Loading members…
      </div>
    );
  }

  if (error && !sharing) {
    return (
      <div className={styles.error}>
        <FeedbackNotice feedback={error} />
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!sharing) return null;

  if (!sharing.library.canManageMembers) {
    return (
      <div className={styles.stableState}>
        <strong>Your role: {sharing.library.role}</strong>
        <span>
          {sharing.library.isDefault || sharing.library.systemKey !== null
            ? "This library is copy-only."
            : "Membership is managed by library admins."}
        </span>
      </div>
    );
  }

  const mutate = async (
    key: string,
    mutation: () => Promise<void>,
    fallback: string,
  ) => {
    if (busyKey !== null) return;
    setBusyKey(key);
    setError(null);
    try {
      await mutation();
      setConfirmKey(null);
    } catch (mutationError) {
      if (handleUnauthenticatedApiError(mutationError)) return;
      setError(toFeedback(mutationError, { fallback }));
    } finally {
      setBusyKey(null);
    }
  };

  const invite = async () => {
    if (busyKey !== null) return;
    const email = query.trim();
    if (!selectedUser && !email.includes("@")) return;
    const key = selectedUser?.userHandle ?? email;
    await mutate(
      `invite:${key}`,
      async () => {
        const created = await createLibraryInvite({
          libraryId,
          invitee: selectedUser
            ? { kind: "User", userHandle: selectedUser.userHandle }
            : { kind: "Email", email },
          role: inviteRole,
        });
        setSharing((current) =>
          current
            ? {
                ...current,
                invites: [
                  created,
                  ...current.invites.filter(
                    (invite) =>
                      invite.invitationHandle !== created.invitationHandle,
                  ),
                ],
              }
            : current,
        );
        setSelectedUser(null);
        setQuery("");
        setResults([]);
      },
      "The invitation could not be sent.",
    );
  };

  return (
    <div className={styles.editor}>
      {error ? (
        <FeedbackNotice feedback={error} />
      ) : null}

      <div className={styles.invite}>
        <PeopleSearchCombobox
          id="library-share-user-results"
          label="Invite a person by name or email"
          placeholder="Name or email…"
          query={query}
          results={results}
          searching={searching}
          disabled={busyKey !== null}
          onQueryChange={(next) => {
            setQuery(next);
            setSelectedUser(null);
          }}
          onSelect={(user) => {
            setSelectedUser(user);
            setQuery(personLabel(user));
            setResults([]);
          }}
        />
        <Select
          size="sm"
          value={inviteRole}
          aria-label="Invitation role"
          disabled={busyKey !== null}
          onChange={(event) =>
            setInviteRole(event.target.value as LibraryRole)
          }
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </Select>
        <Button
          variant="secondary"
          size="sm"
          loading={busyKey?.startsWith("invite:") === true}
          disabled={
            busyKey !== null ||
            (!selectedUser && !query.trim().includes("@"))
          }
          onClick={() => void invite()}
        >
          Invite
        </Button>
      </div>

      <div className={styles.rows}>
        {sharing.members.map((member) => (
          <MemberRow
            key={member.userHandle}
            member={member}
            libraryId={libraryId}
            ownerUserHandle={sharing.library.ownerUserHandle}
            canTransferOwnership={sharing.library.canTransferOwnership}
            busyKey={busyKey}
            confirmKey={confirmKey}
            setConfirmKey={setConfirmKey}
            onMutate={mutate}
            onChange={(next) =>
              setSharing((current) =>
                current
                  ? {
                      ...current,
                      members: current.members.map((row) =>
                        row.userHandle === next.userHandle ? next : row,
                      ),
                    }
                  : current,
              )
            }
            onRemove={(userHandle) =>
              setSharing((current) =>
                current
                  ? {
                      ...current,
                      members: current.members.filter(
                        (row) => row.userHandle !== userHandle,
                      ),
                    }
                  : current,
              )
            }
            onTransferred={() => load()}
          />
        ))}
      </div>

      {sharing.invites.some((invite) => invite.status === "pending") ? (
        <div className={styles.pending}>
          <h4>Pending invitations</h4>
          {sharing.invites
            .filter((invite) => invite.status === "pending")
            .map((invite) => (
              <div key={invite.invitationHandle} className={styles.row}>
                <span>
                  {inviteLabel(invite)} · {invite.role}
                </span>
                {confirmKey === invite.invitationHandle ? (
                  <span className={styles.confirm}>
                    <span>Revoke only this invitation?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyKey === invite.invitationHandle}
                      onClick={() =>
                        void mutate(
                          invite.invitationHandle,
                          async () => {
                            await revokeLibraryInvite(
                              invite.invitationHandle,
                            );
                            setSharing((current) =>
                              current
                                ? {
                                    ...current,
                                    invites: current.invites.filter(
                                      (row) =>
                                        row.invitationHandle !==
                                        invite.invitationHandle,
                                    ),
                                  }
                                : current,
                            );
                          },
                          "The invitation could not be revoked.",
                        )
                      }
                    >
                      Revoke
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyKey !== null}
                      onClick={() => setConfirmKey(null)}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={() => setConfirmKey(invite.invitationHandle)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
        </div>
      ) : null}

      <p className={styles.disclosure}>
        Removing a member closes only this membership path. They may retain
        access through another library or grant, including a media grant they
        created while they could read it.
      </p>
    </div>
  );
}

function MemberRow({
  member,
  libraryId,
  ownerUserHandle,
  canTransferOwnership,
  busyKey,
  confirmKey,
  setConfirmKey,
  onMutate,
  onChange,
  onRemove,
  onTransferred,
}: {
  member: LibraryMember;
  libraryId: string;
  ownerUserHandle: string;
  canTransferOwnership: boolean;
  busyKey: string | null;
  confirmKey: string | null;
  setConfirmKey: (key: string | null) => void;
  onMutate: (
    key: string,
    mutation: () => Promise<void>,
    fallback: string,
  ) => Promise<void>;
  onChange: (member: LibraryMember) => void;
  onRemove: (userHandle: string) => void;
  onTransferred: () => Promise<void>;
}) {
  const removeKey = `remove:${member.userHandle}`;
  const transferKey = `transfer:${member.userHandle}`;
  return (
    <div className={styles.row}>
      <span>
        {personLabel(member)}
        {member.isOwner ? " · owner" : ""}
      </span>
      {member.isOwner ? (
        <span className={styles.role}>admin</span>
      ) : confirmKey === removeKey ? (
        <span className={styles.confirm}>
          <span>Remove only this membership path?</span>
          <Button
            variant="danger"
            size="sm"
            loading={busyKey === removeKey}
            onClick={() =>
              void onMutate(
                removeKey,
                async () => {
                  await removeLibraryMember({
                    libraryId,
                    userHandle: member.userHandle,
                  });
                  onRemove(member.userHandle);
                },
                "The member could not be removed.",
              )
            }
          >
            Remove
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busyKey !== null}
            onClick={() => setConfirmKey(null)}
          >
            Keep
          </Button>
        </span>
      ) : confirmKey === transferKey ? (
        <span className={styles.confirm}>
          <span>Make this person the library owner?</span>
          <Button
            variant="danger"
            size="sm"
            loading={busyKey === transferKey}
            onClick={() =>
              void onMutate(
                transferKey,
                async () => {
                  await transferLibraryOwnership({
                    libraryId,
                    newOwnerUserHandle: member.userHandle,
                  });
                  await onTransferred();
                },
                "Ownership could not be transferred.",
              )
            }
          >
            Transfer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busyKey !== null}
            onClick={() => setConfirmKey(null)}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <span className={styles.memberActions}>
          <Select
            size="sm"
            value={member.role}
            aria-label={`Role for ${personLabel(member)}`}
            disabled={busyKey !== null}
            onChange={(event) => {
              const nextRole = event.target.value as LibraryRole;
              void onMutate(
                `role:${member.userHandle}`,
                async () => {
                  const next = await updateLibraryMemberRole({
                    libraryId,
                    userHandle: member.userHandle,
                    role: nextRole,
                  });
                  onChange(next);
                },
                "The member role could not be changed.",
              );
            }}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            disabled={busyKey !== null}
            onClick={() => setConfirmKey(removeKey)}
          >
            Remove
          </Button>
          {canTransferOwnership && ownerUserHandle !== member.userHandle ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busyKey !== null}
              onClick={() => setConfirmKey(transferKey)}
            >
              Transfer ownership…
            </Button>
          ) : null}
        </span>
      )}
    </div>
  );
}
