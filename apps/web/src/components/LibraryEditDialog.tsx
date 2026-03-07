"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Dialog from "@/components/ui/Dialog";
import styles from "./LibraryEditDialog.module.css";

/* ------------------------------------------------------------------ */
/*  Public types                                                      */
/* ------------------------------------------------------------------ */

export interface LibraryForEdit {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
  owner_user_id: string;
}

export interface LibraryMember {
  user_id: string;
  role: string;
  is_owner: boolean;
  email?: string | null;
  display_name?: string | null;
  created_at: string;
}

export interface LibraryInvite {
  id: string;
  library_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  role: string;
  status: string;
  invitee_email?: string | null;
  invitee_display_name?: string | null;
  created_at: string;
}

export interface UserSearchResult {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */

interface LibraryEditDialogProps {
  open: boolean;
  onClose: () => void;
  library: LibraryForEdit;
  members: LibraryMember[];
  invites: LibraryInvite[];
  onRename: (name: string) => Promise<void>;
  onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onCreateInvite: (inviteeIdentifier: string, role: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onSearchUsers?: (query: string) => Promise<UserSearchResult[]>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function memberDisplayLabel(m: LibraryMember): string {
  if (m.display_name) return m.display_name;
  if (m.email) return m.email;
  return m.user_id;
}

function inviteeDisplayLabel(inv: LibraryInvite): string {
  if (inv.invitee_display_name) return inv.invitee_display_name;
  if (inv.invitee_email) return inv.invitee_email;
  return inv.invitee_user_id;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function LibraryEditDialog({
  open,
  onClose,
  library,
  members,
  invites,
  onRename,
  onUpdateMemberRole,
  onRemoveMember,
  onCreateInvite,
  onRevokeInvite,
  onDelete,
  onSearchUsers,
}: LibraryEditDialogProps) {
  const isAdmin = library.role === "admin";

  const [draftName, setDraftName] = useState(library.name);
  const [saving, setSaving] = useState(false);
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);

  // Search state
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(
    null
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLUListElement>(null);

  const nameChanged = draftName.trim() !== library.name;

  const handleSaveName = async () => {
    const trimmed = draftName.trim();
    if (!trimmed || !nameChanged) return;
    setSaving(true);
    try {
      await onRename(trimmed);
    } finally {
      setSaving(false);
    }
  };

  // Debounced search
  const doSearch = useCallback(
    async (q: string) => {
      if (!onSearchUsers || q.length < 3) {
        setSearchResults([]);
        setShowResults(false);
        return;
      }
      setSearching(true);
      try {
        const results = await onSearchUsers(q);
        setSearchResults(results);
        setShowResults(results.length > 0);
      } catch {
        setSearchResults([]);
        setShowResults(false);
      } finally {
        setSearching(false);
      }
    },
    [onSearchUsers]
  );

  useEffect(() => {
    if (selectedUser) return; // Don't search while a user is selected
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doSearch(inviteQuery);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inviteQuery, doSearch, selectedUser]);

  const handleSelectUser = (user: UserSearchResult) => {
    setSelectedUser(user);
    setInviteQuery(user.email || user.user_id);
    setShowResults(false);
    setSearchResults([]);
  };

  const handleInviteQueryChange = (value: string) => {
    setInviteQuery(value);
    if (selectedUser) {
      setSelectedUser(null);
    }
  };

  const handleInvite = async () => {
    const identifier = selectedUser
      ? selectedUser.email || selectedUser.user_id
      : inviteQuery.trim();
    if (!identifier) return;
    setInviting(true);
    try {
      await onCreateInvite(identifier, inviteRole);
      setInviteQuery("");
      setSelectedUser(null);
      setSearchResults([]);
    } finally {
      setInviting(false);
    }
  };

  const pendingInvites = invites.filter((inv) => inv.status === "pending");

  return (
    <Dialog open={open} onClose={onClose} title="Edit library">
      <div className={styles.sections}>
        {/* ---- Name ---- */}
        <section className={styles.section}>
          <label className={styles.label} htmlFor="library-name">
            Library name
          </label>
          <div className={styles.row}>
            <input
              id="library-name"
              type="text"
              className={styles.input}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              disabled={!isAdmin}
            />
            {isAdmin && (
              <button
                type="button"
                className={styles.btn}
                onClick={handleSaveName}
                disabled={!nameChanged || saving}
                aria-label="Save name"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </section>

        {/* ---- Members ---- */}
        <section
          className={styles.section}
          role="region"
          aria-label="Members"
        >
          <h3 className={styles.sectionTitle}>Members</h3>
          <ul className={styles.memberList}>
            {members.map((m) => (
              <li key={m.user_id} className={styles.memberRow}>
                <span className={styles.memberId}>
                  {memberDisplayLabel(m)}
                </span>

                {m.is_owner ? (
                  <span className={styles.ownerBadge}>owner</span>
                ) : isAdmin ? (
                  <>
                    <select
                      className={styles.roleSelect}
                      value={m.role}
                      aria-label={`Role for ${memberDisplayLabel(m)}`}
                      onChange={(e) =>
                        void onUpdateMemberRole(m.user_id, e.target.value)
                      }
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      aria-label={`Remove ${memberDisplayLabel(m)}`}
                      onClick={() => void onRemoveMember(m.user_id)}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className={styles.roleBadge}>{m.role}</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* ---- Invitations (admin only) ---- */}
        {isAdmin && (
          <section
            className={styles.section}
            role="region"
            aria-label="Invitations"
          >
            <h3 className={styles.sectionTitle}>Invitations</h3>

            <div className={styles.inviteForm}>
              <div className={styles.searchWrapper}>
                <input
                  type="text"
                  className={styles.input}
                  value={inviteQuery}
                  onChange={(e) => handleInviteQueryChange(e.target.value)}
                  onFocus={() => {
                    if (searchResults.length > 0 && !selectedUser)
                      setShowResults(true);
                  }}
                  onBlur={() => {
                    // Delay to allow click on results
                    setTimeout(() => setShowResults(false), 200);
                  }}
                  placeholder="Search by email or name"
                  aria-label="Invitee email"
                />
                {showResults && searchResults.length > 0 && (
                  <ul
                    ref={resultsRef}
                    className={styles.searchResults}
                    role="listbox"
                    aria-label="User search results"
                  >
                    {searchResults.map((user) => (
                      <li
                        key={user.user_id}
                        role="option"
                        aria-selected={false}
                        className={styles.searchResultItem}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSelectUser(user);
                        }}
                      >
                        <span className={styles.searchResultEmail}>
                          {user.email}
                        </span>
                        {user.display_name && (
                          <span className={styles.searchResultName}>
                            {user.display_name}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {searching && (
                  <span className={styles.searchingIndicator}>
                    Searching…
                  </span>
                )}
              </div>
              <select
                className={styles.roleSelect}
                value={inviteRole}
                aria-label="Invite role"
                onChange={(e) =>
                  setInviteRole(e.target.value as "admin" | "member")
                }
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <button
                type="button"
                className={styles.btn}
                onClick={handleInvite}
                disabled={!inviteQuery.trim() || inviting}
                aria-label="Invite"
              >
                {inviting ? "Inviting…" : "Invite"}
              </button>
            </div>

            {pendingInvites.length > 0 && (
              <ul className={styles.inviteList}>
                {pendingInvites.map((inv) => (
                  <li key={inv.id} className={styles.inviteRow}>
                    <span className={styles.memberId}>
                      {inviteeDisplayLabel(inv)}
                    </span>
                    <span className={styles.roleBadge}>{inv.role}</span>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => void onRevokeInvite(inv.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ---- Danger zone (admin only) ---- */}
        {isAdmin && (
          <section className={styles.dangerZone}>
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={() => void onDelete()}
              aria-label="Delete library"
            >
              Delete library
            </button>
          </section>
        )}
      </div>
    </Dialog>
  );
}
