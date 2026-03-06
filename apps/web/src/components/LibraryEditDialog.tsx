"use client";

import { useState } from "react";
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
  created_at: string;
}

export interface LibraryInvite {
  id: string;
  library_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  role: string;
  status: string;
  created_at: string;
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
  onCreateInvite: (inviteeUserId: string, role: string) => Promise<void>;
  onRevokeInvite: (inviteId: string) => Promise<void>;
  onDelete: () => Promise<void>;
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
}: LibraryEditDialogProps) {
  const isAdmin = library.role === "admin";

  const [draftName, setDraftName] = useState(library.name);
  const [saving, setSaving] = useState(false);
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);

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

  const handleInvite = async () => {
    const uid = inviteUserId.trim();
    if (!uid) return;
    setInviting(true);
    try {
      await onCreateInvite(uid, inviteRole);
      setInviteUserId("");
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
                <span className={styles.memberId}>{m.user_id}</span>

                {m.is_owner ? (
                  <span className={styles.ownerBadge}>owner</span>
                ) : isAdmin ? (
                  <>
                    <select
                      className={styles.roleSelect}
                      value={m.role}
                      aria-label={`Role for ${m.user_id}`}
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
                      aria-label={`Remove ${m.user_id}`}
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
              <input
                type="text"
                className={styles.input}
                value={inviteUserId}
                onChange={(e) => setInviteUserId(e.target.value)}
                placeholder="User ID to invite"
                aria-label="User ID"
              />
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
                disabled={!inviteUserId.trim() || inviting}
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
                      {inv.invitee_user_id}
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
