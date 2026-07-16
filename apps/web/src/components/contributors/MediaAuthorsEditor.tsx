"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { putMediaAuthors } from "@/lib/contributors/api";
import { MAX_CREDITS_PER_MANAGED_ROLE } from "@/lib/contributors/constants";
import {
  createMutationIntent,
  type MutationIntent,
} from "@/lib/contributors/mutationIntent";
import type {
  AuthorBinding,
  ContributorSearchItem,
  MediaAuthorCredit,
  MediaAuthors,
} from "@/lib/contributors/types";
import { createRandomId } from "@/lib/createRandomId";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import AuthorSearchField, { normalizedNameKey } from "./AuthorSearchField";
import styles from "./MediaAuthorsEditor.module.css";

/**
 * `MediaAuthorsEditor` is the edit-authors dialog (content spec §2). Desktop uses
 * the shared `Dialog` (on `useDialogOverlay`); mobile uses the stay-mounted
 * `MobileSheet`, chosen by `useIsMobileViewport`. Both route Escape / backdrop /
 * history-Back / drag through one dirty guard (`onDismissRequest`).
 *
 * Mount contract: keep this component mounted across the open/close cycle and
 * drive visibility with `open` (the media pane keeps it mounted once opened), so
 * the mobile sheet's history-dismiss can observe `open` going false. It reseeds
 * its editable state from `authors` each time it opens.
 */

interface BoundRow {
  kind: "bound";
  localId: string;
  binding: AuthorBinding;
  creditedName: string;
  /** Canonical display of the bound identity — the row's context line. */
  canonicalDisplay: string;
}

interface SearchingRow {
  kind: "searching";
  localId: string;
  initialQuery: string;
  selectInitial: boolean;
  /** null → a fresh Add (abandon removes the row); else the prior bound row to revert to on abandon. */
  revertTo: BoundRow | null;
}

type EditorRow = BoundRow | SearchingRow;

type PendingFocus = { type: "add" } | { type: "input"; localId: string };

function seedRows(authors: MediaAuthorCredit[]): BoundRow[] {
  return authors.map((author) => ({
    kind: "bound",
    localId: createRandomId("author-row"),
    binding: { kind: "existing", contributorHandle: author.contributorHandle },
    creditedName: author.creditedName,
    canonicalDisplay: author.displayName,
  }));
}

function bindingIdentity(binding: AuthorBinding): string {
  return binding.kind === "existing"
    ? `existing:${binding.contributorHandle}`
    : `new:${normalizedNameKey(binding.displayName)}`;
}

// JSON-encode each (identity, creditedName) tuple so a credited name that happens
// to contain the join delimiters can never make two materially different row
// lists compare equal (which would wrongly disable Save, or collide the intent
// key). Value equality follows §2.5: existing rows by handle, new rows by the
// normalized display key.
function boundSignature(rows: BoundRow[]): string {
  return JSON.stringify(rows.map((row) => [bindingIdentity(row.binding), row.creditedName]));
}

function loadedSignature(authors: MediaAuthorCredit[]): string {
  return JSON.stringify(authors.map((a) => [`existing:${a.contributorHandle}`, a.creditedName]));
}

function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function removedAnnouncement(name: string, remaining: number): string {
  const count =
    remaining === 0 ? "No authors" : remaining === 1 ? "1 author" : `${formatCount(remaining)} authors`;
  return `Removed ${name}. ${count}.`;
}

export interface MediaAuthorsEditorProps {
  /** Visibility gate. The media pane keeps this mounted; drive with this. */
  open: boolean;
  mediaId: string;
  /**
   * The loaded author-role credits (the media pane maps the media DTO's
   * author-role credits into this camel shape). The editor reseeds from this each
   * open and diffs against it for the dirty flag.
   */
  authors: MediaAuthorCredit[];
  /** Whether authors are pinned to manual; drives the reset affordance. */
  authorMode: "automatic" | "manual";
  /** Dismiss (accepted): close without a PUT. */
  onClose: () => void;
  /** A successful PUT returned the fresh slice — the byline updates from it. */
  onSaved: (next: MediaAuthors) => void;
}

export default function MediaAuthorsEditor({
  open,
  mediaId,
  authors,
  authorMode,
  onClose,
  onSaved,
}: MediaAuthorsEditorProps) {
  const isMobile = useIsMobileViewport();
  const { show: showToast } = useFeedback();

  const intentRef = useRef<MutationIntent | null>(null);
  if (intentRef.current === null) intentRef.current = createMutationIntent();
  const intent = intentRef.current;

  const [rows, setRows] = useState<EditorRow[]>(() => seedRows(authors));
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const wasOpenRef = useRef(open);

  const idBase = useMemo(() => createRandomId("author-editor"), []);
  const capNoticeId = `${idBase}-cap`;
  const discardTitleId = `${idBase}-discard-title`;

  // Reseed the editable state on the closed→open edge; never clobber edits while
  // open (the media pane passes a fresh `authors` array each render).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setRows(seedRows(authors));
      setNotice(null);
      setSaving(false);
      setConfirmingDiscard(false);
      setAnnouncement("");
      intent.discard();
    }
    wasOpenRef.current = open;
  }, [open, authors, intent]);

  // Apply a queued focus move after the DOM settles (add/remove/bind/abandon).
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    if (target.type === "add") addButtonRef.current?.focus();
    else inputRefs.current.get(target.localId)?.focus();
  });

  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  const boundRows = rows.filter((row): row is BoundRow => row.kind === "bound");
  const boundCount = boundRows.length;
  // An in-progress Change is still visibly the row it started from until a new
  // author is chosen: fold its prior binding (`revertTo`) back into the dirty
  // diff and the save payload, so a pristine Change never enables Save and a Save
  // mid-Change never silently drops (or prunes) the row being changed (F1).
  const committedRows: BoundRow[] = rows.flatMap((row) =>
    row.kind === "bound" ? [row] : row.revertTo ? [row.revertTo] : [],
  );
  const atCap = boundCount >= MAX_CREDITS_PER_MANAGED_ROLE;
  // Every row (bound or mid-search) can become at most one author; refuse to open
  // a new search row once the total would reach the cap, so concurrent search
  // rows can never be bound past 20 (F3).
  const canAddRow = rows.length < MAX_CREDITS_PER_MANAGED_ROLE;
  const dirty = boundSignature(committedRows) !== loadedSignature(authors);
  const isPinned = authorMode === "manual";

  const takenHandles = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.kind === "bound" && row.binding.kind === "existing") {
        set.add(row.binding.contributorHandle);
      }
    }
    return set;
  }, [rows]);

  const takenNewNameKeys = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.kind === "bound" && row.binding.kind === "new") {
        set.add(normalizedNameKey(row.binding.displayName));
      }
    }
    return set;
  }, [rows]);

  function addAuthor() {
    if (!canAddRow || saving) return;
    setNotice(null);
    setRows((current) => [
      ...current,
      {
        kind: "searching",
        localId: createRandomId("author-row"),
        initialQuery: "",
        selectInitial: false,
        revertTo: null,
      },
    ]);
    // The new AuthorSearchField autofocuses on mount.
  }

  function changeRow(localId: string) {
    setRows((current) =>
      current.map((row) =>
        row.localId === localId && row.kind === "bound"
          ? {
              kind: "searching",
              localId: row.localId,
              initialQuery: row.canonicalDisplay,
              selectInitial: true,
              revertTo: row,
            }
          : row,
      ),
    );
  }

  function abandonSearching(localId: string) {
    const row = rows.find((candidate) => candidate.localId === localId);
    if (!row || row.kind !== "searching") return;
    if (row.revertTo) {
      const revert = row.revertTo;
      setRows((current) => current.map((r) => (r.localId === localId ? revert : r)));
      pendingFocusRef.current = { type: "input", localId };
    } else {
      setRows((current) => current.filter((r) => r.localId !== localId));
      pendingFocusRef.current = { type: "add" };
    }
  }

  function bindExisting(localId: string, item: ContributorSearchItem) {
    setRows((current) =>
      current.map((row) => {
        if (row.localId !== localId || row.kind !== "searching") return row;
        // N3: re-selecting the row's own author on a Change reverts verbatim (no reset).
        if (
          row.revertTo &&
          row.revertTo.binding.kind === "existing" &&
          row.revertTo.binding.contributorHandle === item.handle
        ) {
          return row.revertTo;
        }
        return {
          kind: "bound",
          localId,
          binding: { kind: "existing", contributorHandle: item.handle },
          creditedName: item.displayName,
          canonicalDisplay: item.displayName,
        };
      }),
    );
    pendingFocusRef.current = { type: "input", localId };
  }

  function bindNew(localId: string, displayName: string) {
    const cleaned = displayName.trim();
    setRows((current) =>
      current.map((row) =>
        row.localId === localId && row.kind === "searching"
          ? {
              kind: "bound",
              localId,
              binding: { kind: "new", displayName: cleaned },
              creditedName: cleaned,
              canonicalDisplay: cleaned,
            }
          : row,
      ),
    );
    pendingFocusRef.current = { type: "input", localId };
  }

  function editCreditedName(localId: string, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.localId === localId && row.kind === "bound" ? { ...row, creditedName: value } : row,
      ),
    );
  }

  function removeBound(localId: string) {
    const index = boundRows.findIndex((row) => row.localId === localId);
    if (index < 0) return;
    const removed = boundRows[index]!;
    const nextBound = boundRows[index + 1];
    setRows((current) => current.filter((row) => row.localId !== localId));
    pendingFocusRef.current = nextBound
      ? { type: "input", localId: nextBound.localId }
      : { type: "add" };
    setAnnouncement(removedAnnouncement(removed.creditedName, boundCount - 1));
  }

  function moveBound(localId: string, direction: -1 | 1) {
    const pos = boundRows.findIndex((row) => row.localId === localId);
    if (pos < 0) return;
    const targetPos = pos + direction;
    if (targetPos < 0 || targetPos >= boundRows.length) return;
    setRows((current) => {
      const boundIndices = current
        .map((row, index) => (row.kind === "bound" ? index : -1))
        .filter((index) => index >= 0);
      const a = boundIndices[pos]!;
      const b = boundIndices[targetPos]!;
      const next = current.slice();
      const tmp = next[a]!;
      next[a] = next[b]!;
      next[b] = tmp;
      return next;
    });
    setAnnouncement(
      `Moved ${boundRows[pos]!.creditedName} to position ${targetPos + 1} of ${boundRows.length}`,
    );
    // A move that lands on an extremity disables the button just pressed, so the
    // browser would drop focus to <body>. Re-home focus onto the moved row's
    // credited input so keyboard reorder keeps its place (M-1). Non-extreme moves
    // keep focus on the still-enabled pressed button via keyed reconciliation.
    if (targetPos === 0 || targetPos === boundRows.length - 1) {
      pendingFocusRef.current = { type: "input", localId };
    }
  }

  function handleClose() {
    intent.discard();
    onClose();
  }

  function requestDismiss(): DismissDecision {
    // A dismissal mid-flight would race the pending PUT (a successful onSaved/toast
    // would land in a closed editor). Block it silently — Cancel is already
    // disabled while saving, and the save resolves to either a close or an
    // in-dialog error (F7).
    if (saving) return "blocked";
    if (dirty) {
      lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
      setConfirmingDiscard(true);
      return "blocked";
    }
    return "accepted";
  }

  function attemptCancel() {
    if (requestDismiss() === "accepted") handleClose();
  }

  function keepEditing() {
    setConfirmingDiscard(false);
    const target = lastFocusRef.current;
    if (target && document.contains(target)) {
      requestAnimationFrame(() => target.focus());
    }
  }

  function handleMutationError(error: unknown) {
    setSaving(false);
    if (isApiError(error)) {
      if (handleUnauthenticatedApiError(error)) return;
      if (error.code === "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH") intent.rotate();
      setNotice(toFeedback(error, { fallback: "Couldn't save your changes." }));
      return;
    }
    // Transport/timeout: the server may have committed. Reuse the same key (no
    // rotation) so a retry replays idempotently; keep the draft intact (DP-1).
    setNotice({ severity: "error", title: "Couldn't confirm the change. Try again." });
  }

  async function save() {
    if (!dirty || saving) return;
    const payloadAuthors = committedRows.map((row) => ({
      creditedName: row.creditedName,
      binding: row.binding,
    }));
    const clientMutationId = intent.clientMutationId(`manual|${boundSignature(committedRows)}`);
    setSaving(true);
    setNotice(null);
    try {
      const result = await putMediaAuthors(mediaId, {
        clientMutationId,
        mode: "manual",
        authors: payloadAuthors,
      });
      intent.discard();
      onSaved(result);
      handleClose();
      showToast({ severity: "success", title: "Authors saved." });
    } catch (error) {
      handleMutationError(error);
    }
  }

  async function resetToAutomatic() {
    if (saving) return;
    const clientMutationId = intent.clientMutationId("automatic");
    setSaving(true);
    setNotice(null);
    try {
      const result = await putMediaAuthors(mediaId, { clientMutationId, mode: "automatic" });
      intent.discard();
      onSaved(result);
      handleClose();
      showToast({
        severity: "info",
        title: "Automatic author updates will resume on the next refresh.",
      });
    } catch (error) {
      handleMutationError(error);
    }
  }

  function renderRow(row: EditorRow) {
    if (row.kind === "searching") {
      return (
        <li key={row.localId} className={styles.row} data-searching>
          <div className={styles.searchWrap}>
            <AuthorSearchField
              initialQuery={row.initialQuery}
              selectInitial={row.selectInitial}
              takenHandles={takenHandles}
              takenNewNameKeys={takenNewNameKeys}
              onSelectExisting={(item) => bindExisting(row.localId, item)}
              onCreateNew={(name) => bindNew(row.localId, name)}
              onDismiss={() => abandonSearching(row.localId)}
            />
          </div>
          <button
            type="button"
            className={styles.textButton}
            aria-label={row.revertTo ? "Cancel changing author" : "Remove new author row"}
            onClick={() => abandonSearching(row.localId)}
          >
            {row.revertTo ? "Cancel" : "Remove"}
          </button>
        </li>
      );
    }

    const pos = boundRows.findIndex((candidate) => candidate.localId === row.localId);
    const inputId = `${idBase}-credited-${row.localId}`;
    return (
      <li key={row.localId} className={styles.row}>
        <div className={styles.rowMain}>
          <label className={styles.creditedLabel} htmlFor={inputId}>
            Credited as
          </label>
          <Input
            id={inputId}
            ref={(el) => {
              if (el) inputRefs.current.set(row.localId, el);
              else inputRefs.current.delete(row.localId);
            }}
            className={styles.creditedInput}
            value={row.creditedName}
            dir="auto"
            placeholder="Name as credited on this work"
            onChange={(event) => editCreditedName(row.localId, event.target.value)}
          />
          <div className={styles.context}>
            {row.binding.kind === "existing" ? (
              <span dir="auto">{row.canonicalDisplay}</span>
            ) : (
              "New author"
            )}
          </div>
        </div>
        <div className={styles.rowControls}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Move ${row.creditedName} up`}
            disabled={pos === 0}
            onClick={() => moveBound(row.localId, -1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Move ${row.creditedName} down`}
            disabled={pos === boundRows.length - 1}
            onClick={() => moveBound(row.localId, 1)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.textButton}
            title="Change"
            aria-label={`Change author for ${row.creditedName}`}
            onClick={() => changeRow(row.localId)}
          >
            Change
          </button>
          <button
            type="button"
            className={styles.textButton}
            title="Remove"
            aria-label={`Remove ${row.creditedName}`}
            onClick={() => removeBound(row.localId)}
          >
            Remove
          </button>
        </div>
      </li>
    );
  }

  function renderContent(showTitle: boolean) {
    return (
      <div className={styles.editor}>
        <div className={styles.head}>
          {showTitle ? <h2 className={styles.title}>Edit authors</h2> : null}
          <p className={styles.helper}>
            Your changes apply to this work and will be kept when it is refreshed or enriched again.
          </p>
          {isPinned ? (
            <div className={styles.pinnedRow}>
              <span className={styles.pinned}>Authors edited manually</span>
              <button
                type="button"
                className={styles.reset}
                onClick={() => void resetToAutomatic()}
                disabled={saving}
              >
                Reset to automatic authors
              </button>
            </div>
          ) : null}
        </div>

        {notice ? <FeedbackNotice feedback={notice} className={styles.notice} /> : null}

        <ul className={styles.rows}>{rows.map((row) => renderRow(row))}</ul>

        {/* Visual notice only — a freshly-inserted role="status" announces
            unreliably (L-3); the disabled Add button's aria-describedby points
            here so the limit is spoken on focus instead. */}
        {atCap ? (
          <p id={capNoticeId} className={styles.capNotice}>
            A work can have up to 20 authors.
          </p>
        ) : null}
        <div className={styles.addRow}>
          <button
            ref={addButtonRef}
            type="button"
            className={styles.addButton}
            onClick={addAuthor}
            disabled={!canAddRow || saving}
            aria-label={atCap ? "Add author (limit reached)" : undefined}
            aria-describedby={atCap ? capNoticeId : undefined}
          >
            <Plus size={16} aria-hidden="true" /> Add author
          </button>
        </div>

        <div className={styles.srOnly} role="status" aria-live="polite">
          {announcement}
        </div>

        {confirmingDiscard ? (
          // alertdialog + aria-labelledby so the destructive prompt is spoken when
          // focus moves to "Keep editing" (a group aria-label is not reliably
          // announced on programmatic focus-in) — H-1.
          <div className={styles.confirm} role="alertdialog" aria-labelledby={discardTitleId}>
            <p id={discardTitleId} className={styles.confirmTitle}>
              Discard changes?
            </p>
            <div className={styles.confirmActions}>
              <Button ref={keepEditingRef} variant="secondary" size="sm" onClick={keepEditing}>
                Keep editing
              </Button>
              <Button variant="danger" size="sm" onClick={handleClose}>
                Discard
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.footer}>
            <Button variant="secondary" size="sm" onClick={attemptCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || saving}
              loading={saving}
            >
              Save
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileSheet
        active={open}
        ariaLabel="Edit authors"
        onDismiss={handleClose}
        onDismissRequest={requestDismiss}
        backdropTestId="edit-authors-backdrop"
      >
        {renderContent(true)}
      </MobileSheet>
    );
  }

  return (
    <Dialog open={open} title="Edit authors" onClose={handleClose} onDismissRequest={requestDismiss}>
      {renderContent(false)}
    </Dialog>
  );
}

// The media pane lazy-imports this by name (`module.MediaAuthorsEditor`); the
// default export serves direct importers and tests.
export { MediaAuthorsEditor };
