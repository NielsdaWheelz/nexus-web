"use client";

// Edit authors (media creator only). Loads the media's author slice, edits an
// ordered list of credited names each bound to an existing visible author or a
// new one, and saves it as a pinned manual list; "Reset to automatic authors"
// releases the pin. A saved PUT is the commit point: the PUT is absolute, so a
// retry re-applies the same list, and a new author carries the id minted when it
// was added, so a resend that landed binds the person it created instead of
// creating another. A failure after the PUT succeeded never re-sends it.

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import {
  FeedbackNotice,
  FeedbackState,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  getMediaAuthors,
  putMediaAuthors,
  type AuthorBinding,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import { contributorNameKey } from "@/lib/contributors/credits";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isRefusal } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { publishChange } from "@/lib/api/changes";
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

type Draft =
  Schema<"ManualMediaAuthorsRequest"> | Schema<"AutomaticMediaAuthorsRequest">;

const bound = (row: Bound): Row => ({ kind: "Bound", ...row });
const identity = (binding: AuthorBinding) =>
  binding.kind === "existing"
    ? `existing:${binding.contributor_handle}`
    : `new:${contributorNameKey(binding.display_name)}`;
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
};

export default function MediaAuthorsEditor({
  mediaId,
  returnFocusTo,
  onClose,
}: {
  readonly mediaId: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const source = usePaneFreeServerValue({
    key: `media-authors:${mediaId}`,
    stale: "",
    load: (signal) => getMediaAuthors(mediaId, signal),
  });
  if (source.status !== "ready") {
    const content = source.status === "failed" ? (
      <FeedbackState content={{ tone: "Danger", title: "couldn't load authors", requestId: source.error.requestId }} announcement="Polite" actions={[{ label: "retry loading", busy: source.retrying, onClick: source.refetch }]} />
    ) : <PaneLoadingState label="loading authors…" announcement="Polite" />;
    return isMobile ? (
      <MobileSheet active ariaLabel="edit authors" onDismiss={onClose} returnFocusTo={returnFocusTo}>{content}</MobileSheet>
    ) : <Dialog open title="Edit authors" onClose={onClose} returnFocusTo={returnFocusTo}>{content}</Dialog>;
  }
  const loaded = source.data.authors.map((credit): Bound => ({
    id: createRandomId("author-row"),
    binding: {
      kind: "existing",
      contributor_handle: credit.contributor_handle!,
    },
    creditedName: credit.credited_name,
    canonical: credit.contributor_display_name ?? credit.credited_name,
  }));
  return (
    <Editor
      mediaId={mediaId}
      loaded={loaded}
      manual={source.data.manual}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    />
  );
}

function Editor({
  mediaId,
  loaded,
  manual,
  returnFocusTo,
  onClose,
}: {
  readonly mediaId: string;
  readonly loaded: readonly Bound[];
  readonly manual: boolean;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const throwLater = useThrowLater();
  const guard = useWorkGuard();
  const { ctx } = useActionRuntime();
  const draft = useResourceDraft<{
    rows: readonly Row[]; baseline: string; request: Draft | null; saving: boolean; notice: FeedbackContent | null;
  }>(`MediaAuthors:${mediaId}`, () => ({ rows: loaded.map(bound), baseline: signature(loaded), request: null, saving: false, notice: null }), value => ({
    changed: signature(value.rows.flatMap(row => row.kind === "Bound" ? [row] : row.revert ? [row.revert] : [])) !== value.baseline,
    unconfirmed: value.request !== null,
    stopsBrowserWork: false,
  }));
  const { rows, saving, notice } = draft.value;
  const setRows = (change: readonly Row[] | ((value: readonly Row[]) => readonly Row[])) => draft.set(value => ({
    ...value, rows: typeof change === "function" ? change(value.rows) : change,
  }));
  const setNotice = (notice: FeedbackContent | null) => draft.set(value => ({ ...value, notice }));
  const [announcement, setAnnouncement] = useState("");
  const focusTarget = useRef<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
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

  const boundRows = rows.filter((row) => row.kind === "Bound");
  // A row mid-Change still counts as the row it started from, so a pristine
  // Change never enables Save and a Save mid-Change never drops the row.
  const committed = rows.flatMap((row): Bound[] =>
    row.kind === "Bound" ? [row] : row.revert ? [row.revert] : [],
  );
  const dirty = signature(committed) !== draft.value.baseline;
  const takenHandles = new Set(
    boundRows.flatMap((row) =>
      row.binding.kind === "existing" ? [row.binding.contributor_handle] : [],
    ),
  );
  const takenNewKeys = new Set(
    boundRows.flatMap((row) =>
      row.binding.kind === "new"
        ? [contributorNameKey(row.binding.display_name)]
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
    const value = draft.read();
    if (value.saving) return;
    if (body.mode === "automatic" && value.request === null && !guard.confirmLoss({ scopes: [], ownerIds: [draft.owner] })) return;
    const request = value.request ?? body;
    const signal = ctx.sessionSignal();
    draft.set({ ...value, request, saving: true, notice: null });
    try {
      await putMediaAuthors(mediaId, request);
    } catch (error) {
      if (signal.aborted) return;
      draft.set(latest => ({ ...latest, saving: false, request: isRefusal(error) && value.request === null ? null : request }));
      if (handleUnauthenticatedApiError(error)) return;
      const copy = isApiError(error) && !isSameSystemApiDefect(error) ? ERRORS[error.code] : undefined;
      if (copy === undefined || !isApiError(error)) return throwLater({ error });
      setNotice({ tone: "Danger", title: copy[0], message: copy[1], requestId: error.requestId });
      return;
    }
    if (signal.aborted) return;
    draft.set(latest => ({ ...latest, request: null, saving: false,
      baseline: request.mode === "manual" ? signature(committed) : latest.baseline }));
    publishChange("Metadata");
    onClose();
  }

  function requestDismiss(): DismissDecision {
    return guard.confirmLoss({ scopes: [], ownerIds: [draft.owner] }) ? "accepted" : "blocked";
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
                binding: { kind: "existing", contributor_handle: item.handle },
                creditedName: item.display_name,
                canonical: item.display_name,
              })
            }
            onCreateNew={(name) =>
              bind(row.id, row.revert, {
                id: row.id,
                binding: {
                  kind: "new",
                  id: createRandomId(),
                  display_name: name,
                },
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
            disabled={draft.value.request !== null}
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
            disabled={draft.value.request !== null || position === 0}
            onClick={() => move(row, -1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Move ${row.creditedName} down`}
            disabled={draft.value.request !== null || position === boundRows.length - 1}
            onClick={() => move(row, 1)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Change author for ${row.creditedName}`}
            disabled={draft.value.request !== null}
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
            disabled={draft.value.request !== null}
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
            disabled={saving || draft.value.request !== null}
            onClick={() => void submit({ mode: "automatic" })}
          >
            Reset to automatic authors
          </Button>
        </div>
      ) : null}
      {notice ? (
        <FeedbackNotice content={notice} announcement="Assertive" actions={draft.value.request === null ? undefined : [{
          label: "retry same request", busy: saving, onClick: () => { const request = draft.read().request; if (request !== null) void submit(request); },
        }]} />
      ) : null}
      <ul className={styles.rows} inert={draft.value.request !== null}>{rows.map(renderRow)}</ul>
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
        disabled={rows.length >= MAX_AUTHORS || draft.value.request !== null}
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
      <div className={styles.footer}>
        <Button
            variant="secondary"
            size="sm"
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
                  credited_name: row.creditedName,
                  binding: row.binding,
                })),
              })
            }
          >
            Save
          </Button>
      </div>
    </div>
  );
  return isMobile ? (
    <MobileSheet
      active
      ariaLabel="edit authors"
      onDismiss={onClose}
      onDismissRequest={requestDismiss}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() => null}
    >
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
