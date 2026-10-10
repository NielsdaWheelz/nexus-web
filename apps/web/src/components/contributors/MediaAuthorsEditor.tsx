"use client";

// Edit authors (media creator only). Loads the media's author slice, edits an
// ordered list of credited names each bound to an existing visible author or a
// new one, and saves it as a pinned manual list; "Reset to automatic authors"
// releases the pin. A saved PUT is the commit point: a retry of an unchanged
// draft reuses its client mutation id, and a failure after the PUT succeeded
// never re-sends it.

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import {
  FeedbackNotice,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { useResource } from "@/lib/api/useResource";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  getMediaAuthors,
  putMediaAuthors,
  type AuthorBinding,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import { contributorNameKey } from "@/lib/contributors/credits";
import { createRandomId } from "@/lib/createRandomId";
import { useMediaBibliographyInvalidation } from "@/lib/media/MediaSummaryProvider";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { DismissDecision, ReturnFocusTarget } from "@/lib/ui/overlay";
import AuthorSearchField from "./AuthorSearchField";
import styles from "./MediaAuthorsEditor.module.css";

const MAX_AUTHORS = 20;

interface Bound {
  readonly id: string;
  readonly binding: AuthorBinding;
  readonly creditedName: string;
  /** The bound person's canonical name: the row's context line. */
  readonly canonical: string;
}
type Row =
  | ({ readonly kind: "Bound" } & Bound)
  | {
      readonly kind: "Searching";
      readonly id: string;
      /** Change: the row to restore on abandon; Add: null (abandon removes it). */
      readonly revert: Bound | null;
    };

/** A PUT body before its client mutation id is chosen. */
type Draft =
  | Omit<Schema<"ManualMediaAuthorsRequest">, "clientMutationId">
  | Omit<Schema<"AutomaticMediaAuthorsRequest">, "clientMutationId">;

const bound = (row: Bound): Row => ({ kind: "Bound", ...row });
const identity = (binding: AuthorBinding) =>
  binding.kind === "existing"
    ? `existing:${binding.contributorHandle}`
    : `new:${contributorNameKey(binding.displayName)}`;
// JSON, so a credited name holding a delimiter can never collide two lists.
const signature = (rows: readonly Bound[]) =>
  JSON.stringify(rows.map((row) => [identity(row.binding), row.creditedName]));
const authorCount = (n: number) =>
  n === 0 ? "No authors" : n === 1 ? "1 author" : `${n} authors`;

const ERRORS: Readonly<Record<string, readonly [string, string?]>> = {
  E_NETWORK: [
    "The change couldn’t be confirmed",
    "Retry to safely check whether it was saved.",
  ],
  E_NOT_FOUND: ["This work is no longer available"],
  E_FORBIDDEN: ["You can’t edit authors for this work"],
  E_INVALID_REQUEST: [
    "The authors weren’t updated",
    "Review every credited name and retry.",
  ],
  E_AUTHOR_ALREADY_LISTED: [
    "That author is already listed",
    "Choose each author once.",
  ],
  E_AUTHOR_NOT_SELECTABLE: [
    "That author can’t be selected",
    "Choose another author and retry.",
  ],
  E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: [
    "The authors weren’t updated",
    "Retry the saved draft.",
  ],
};

export default function MediaAuthorsEditor({
  mediaId,
  mutation,
  returnFocusTo,
  onClose,
}: {
  readonly mediaId: string;
  /** The canonical action boundary, begun immediately before each PUT. */
  readonly mutation: ResourceActionMutationBoundary;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const feedback = useFeedback();
  const source = useResource({
    cacheKey: `media-authors:${mediaId}`,
    load: (signal) => getMediaAuthors(mediaId, signal),
  });
  useEffect(() => {
    if (source.status !== "error") return;
    feedback.publish({
      kind: "Hud",
      key: `media-authors:${mediaId}`,
      content: {
        tone: "Danger",
        title: "Authors couldn’t be loaded",
        requestId: source.error.requestId,
      },
    });
    onClose();
  }, [feedback, mediaId, onClose, source]);
  if (source.status !== "ready") return null;
  const loaded = source.data.authors.map((credit): Bound => ({
    id: createRandomId("author-row"),
    binding: {
      kind: "existing",
      contributorHandle: credit.contributor_handle!,
    },
    creditedName: credit.credited_name,
    canonical: credit.contributor_display_name ?? credit.credited_name,
  }));
  return (
    <Editor
      mediaId={mediaId}
      loaded={loaded}
      manual={source.data.manual}
      mutation={mutation}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    />
  );
}

function Editor({
  mediaId,
  loaded,
  manual,
  mutation,
  returnFocusTo,
  onClose,
}: {
  readonly mediaId: string;
  readonly loaded: readonly Bound[];
  readonly manual: boolean;
  readonly mutation: ResourceActionMutationBoundary;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const feedback = useFeedback();
  const invalidateBibliography = useMediaBibliographyInvalidation();
  const throwLater = useThrowLater();
  const [rows, setRows] = useState<readonly Row[]>(() => loaded.map(bound));
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const mutationId = useRef<{
    readonly payload: string;
    readonly id: string;
  } | null>(null);
  const focusTarget = useRef<string | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const capId = `${baseId}-cap`;

  // Move focus after the DOM settles: to a row's credited input, or to Add.
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === "add") addRef.current?.focus();
    else if (target !== null)
      document.getElementById(`${baseId}-${target}`)?.focus();
  });
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  const boundRows = rows.filter((row) => row.kind === "Bound");
  // A row mid-Change still counts as the row it started from, so a pristine
  // Change never enables Save and a Save mid-Change never drops the row.
  const committed = rows.flatMap((row): Bound[] =>
    row.kind === "Bound" ? [row] : row.revert ? [row.revert] : [],
  );
  const dirty = signature(committed) !== signature(loaded);
  const takenHandles = new Set(
    boundRows.flatMap((row) =>
      row.binding.kind === "existing" ? [row.binding.contributorHandle] : [],
    ),
  );
  const takenNewKeys = new Set(
    boundRows.flatMap((row) =>
      row.binding.kind === "new"
        ? [contributorNameKey(row.binding.displayName)]
        : [],
    ),
  );

  const replace = (id: string, next: Row | null) =>
    setRows((current) =>
      current.flatMap((row) => (row.id !== id ? [row] : next ? [next] : [])),
    );

  function bind(id: string, revert: Bound | null, next: Bound) {
    // Re-choosing the row's own author on a Change restores it verbatim.
    const same =
      revert !== null && identity(revert.binding) === identity(next.binding);
    replace(id, bound(same ? revert : next));
    focusTarget.current = id;
  }

  function abandon(id: string, revert: Bound | null) {
    replace(id, revert ? bound(revert) : null);
    focusTarget.current = revert ? id : "add";
  }

  function remove(row: Bound) {
    const index = boundRows.findIndex((other) => other.id === row.id);
    replace(row.id, null);
    focusTarget.current = boundRows[index + 1]?.id ?? "add";
    setAnnouncement(
      `Removed ${row.creditedName}. ${authorCount(boundRows.length - 1)}.`,
    );
  }

  function move(row: Bound, by: -1 | 1) {
    const position = boundRows.findIndex((other) => other.id === row.id);
    const target = position + by;
    const from = rows.findIndex((other) => other.id === row.id);
    const to = rows.findIndex((other) => other.id === boundRows[target]!.id);
    const next = rows.slice();
    [next[from], next[to]] = [next[to]!, next[from]!];
    setRows(next);
    setAnnouncement(
      `Moved ${row.creditedName} to position ${target + 1} of ${boundRows.length}`,
    );
    // An extreme move disables the pressed button; keep focus on the row.
    if (target === 0 || target === boundRows.length - 1)
      focusTarget.current = row.id;
  }

  async function submit(body: Draft) {
    if (saving) return;
    const lease = mutation.begin();
    if (lease === null) return;
    const payload = JSON.stringify(body);
    if (mutationId.current?.payload !== payload) {
      mutationId.current = { payload, id: createRandomId("media-authors") };
    }
    setSaving(true);
    setNotice(null);
    try {
      await putMediaAuthors(mediaId, {
        ...body,
        clientMutationId: mutationId.current.id,
      });
    } catch (error) {
      lease.abort();
      setSaving(false);
      if (handleUnauthenticatedApiError(error)) return;
      const copy =
        isApiError(error) && !isSameSystemApiDefect(error)
          ? ERRORS[error.code]
          : undefined;
      if (copy === undefined || !isApiError(error))
        return throwLater({ error });
      // The key now names another request server-side: the next Save mints one.
      if (error.code === "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH")
        mutationId.current = null;
      setNotice({
        tone: "Danger",
        title: copy[0],
        message: copy[1],
        requestId: error.requestId,
      });
      return;
    }
    // Saved. Refreshing other views is best effort and never re-sends the PUT.
    invalidateBibliography(mediaId);
    try {
      await lease.reconcile({
        kind: "Subjects",
        refs: [assumeCanonicalResourceRef(`media:${mediaId}`)],
      });
      await lease.commit();
    } catch (error) {
      if (!isApiError(error) || isSameSystemApiDefect(error))
        return throwLater({ error });
      feedback.publish({
        kind: "Hud",
        content: {
          tone: "Neutral",
          title: "Authors saved",
          message: "Some views will update when they next refresh.",
          requestId: error.requestId,
        },
      });
    }
    onClose();
  }

  function requestDismiss(): DismissDecision {
    // A dismissal mid-save would race the PUT; Cancel is disabled meanwhile.
    if (saving) return "blocked";
    if (!dirty) return "accepted";
    lastFocus.current = document.activeElement as HTMLElement | null;
    setConfirmingDiscard(true);
    return "blocked";
  }

  function keepEditing() {
    setConfirmingDiscard(false);
    const target = lastFocus.current;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  function renderRow(row: Row) {
    if (row.kind === "Searching") {
      return (
        <li key={row.id} className={styles.row}>
          <AuthorSearchField
            initialQuery={row.revert?.canonical ?? ""}
            selectInitial={row.revert !== null}
            takenHandles={takenHandles}
            takenNewKeys={takenNewKeys}
            onSelectExisting={(item: ContributorSearchItem) =>
              bind(row.id, row.revert, {
                id: row.id,
                binding: { kind: "existing", contributorHandle: item.handle },
                creditedName: item.displayName,
                canonical: item.displayName,
              })
            }
            onCreateNew={(name) =>
              bind(row.id, row.revert, {
                id: row.id,
                binding: { kind: "new", displayName: name },
                creditedName: name,
                canonical: name,
              })
            }
            onDismiss={() => abandon(row.id, row.revert)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={
              row.revert ? "Cancel changing author" : "Remove new author row"
            }
            onClick={() => abandon(row.id, row.revert)}
          >
            {row.revert ? "Cancel" : "Remove"}
          </Button>
        </li>
      );
    }
    const position = boundRows.indexOf(row);
    return (
      <li key={row.id} className={styles.row}>
        <div className={styles.rowMain}>
          <label className={styles.label} htmlFor={`${baseId}-${row.id}`}>
            Credited as
          </label>
          <Input
            id={`${baseId}-${row.id}`}
            className={styles.input}
            value={row.creditedName}
            dir="auto"
            placeholder="Name as credited on this work"
            onChange={(event) =>
              replace(row.id, { ...row, creditedName: event.target.value })
            }
          />
          <div className={styles.meta}>
            {row.binding.kind === "existing" ? (
              <span dir="auto">{row.canonical}</span>
            ) : (
              "New author"
            )}
          </div>
        </div>
        <div className={styles.rowControls}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move ${row.creditedName} up`}
            disabled={position === 0}
            onClick={() => move(row, -1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move ${row.creditedName} down`}
            disabled={position === boundRows.length - 1}
            onClick={() => move(row, 1)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Change author for ${row.creditedName}`}
            onClick={() =>
              replace(row.id, { kind: "Searching", id: row.id, revert: row })
            }
          >
            Change
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${row.creditedName}`}
            onClick={() => remove(row)}
          >
            Remove
          </Button>
        </div>
      </li>
    );
  }

  const atCap = boundRows.length >= MAX_AUTHORS;
  const content = (
    <div className={styles.editor}>
      <p className={styles.helper}>
        Your changes apply to this work and will be kept when it is refreshed or
        enriched again.
      </p>
      {manual ? (
        <div className={styles.pinned}>
          <span>Authors edited manually</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void submit({ mode: "automatic" })}
          >
            Reset to automatic authors
          </Button>
        </div>
      ) : null}
      {notice ? (
        <FeedbackNotice content={notice} announcement="Assertive" />
      ) : null}
      <ul className={styles.rows}>{rows.map(renderRow)}</ul>
      {/* Visual only: the disabled Add button speaks the limit on focus. */}
      {atCap ? (
        <p id={capId} className={styles.meta}>
          A work can have up to 20 authors.
        </p>
      ) : null}
      <Button
        ref={addRef}
        variant="ghost"
        size="sm"
        leadingIcon={<Plus size={16} aria-hidden="true" />}
        // Every row can become one author: no new search past the cap.
        disabled={rows.length >= MAX_AUTHORS || saving}
        aria-label={atCap ? "Add author (limit reached)" : undefined}
        aria-describedby={atCap ? capId : undefined}
        onClick={() => {
          setNotice(null);
          setRows([
            ...rows,
            {
              kind: "Searching",
              id: createRandomId("author-row"),
              revert: null,
            },
          ]);
        }}
      >
        Add author
      </Button>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {confirmingDiscard ? (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-labelledby={`${baseId}-discard`}
        >
          <p id={`${baseId}-discard`} className={styles.confirmTitle}>
            Discard changes?
          </p>
          <div className={styles.footer}>
            <Button
              ref={keepEditingRef}
              variant="secondary"
              size="sm"
              onClick={keepEditing}
            >
              Keep editing
            </Button>
            <Button variant="danger" size="sm" onClick={onClose}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.footer}>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => requestDismiss() === "accepted" && onClose()}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!dirty || saving}
            onClick={() =>
              void submit({
                mode: "manual",
                authors: committed.map((row) => ({
                  creditedName: row.creditedName,
                  binding: row.binding,
                })),
              })
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
  return isMobile ? (
    <MobileSheet
      active
      ariaLabel="Edit authors"
      onDismiss={onClose}
      onDismissRequest={requestDismiss}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() => null}
    >
      <h2 className={styles.title}>Edit authors</h2>
      {content}
    </MobileSheet>
  ) : (
    <Dialog
      open
      title="Edit authors"
      onClose={onClose}
      onDismissRequest={requestDismiss}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() => null}
    >
      {content}
    </Dialog>
  );
}
