"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileText, Link, Plus, Upload, X } from "lucide-react";
import LibraryDestinationDisclosure from "@/components/LibraryDestinationDisclosure";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import OpmlImportPanel from "@/components/OpmlImportPanel";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Textarea from "@/components/ui/Textarea";
import type { LauncherActionTarget } from "@/lib/launcher/model";
import {
  isLibraryDestinationDefect,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
import {
  acceptedMediaIds,
  couldNotSubscribeCount,
  draftItems,
  settledAcceptedItems,
  type AddItem,
  type AddSessionState,
  type MembershipCommand,
  type MembershipState,
} from "./addContentSessionModel";
import type { AddContentSessionController } from "./useAddContentSession";
import styles from "./AddPanel.module.css";

export type AddDismissalConfirmation = {
  kind: "Discard" | "Stop";
  actionLabel: string;
} | null;

interface AddPanelProps {
  session: AddContentSessionController;
  dismissalConfirmation: AddDismissalConfirmation;
  onBack(): void;
  onClose(): void;
  onKeepWorking(): void;
  onConfirmDismissal(): void;
  onOpen(target: LauncherActionTarget): void;
  onDefect(error: unknown): void;
}

export function resolveAddPanelInitialFocus(
  container: HTMLElement,
  isMobile: boolean,
  state: Pick<AddSessionState, "branch" | "initialFocus">,
): HTMLElement | null {
  const heading = container.querySelector<HTMLElement>(
    '[data-add-heading="true"]',
  );
  if (isMobile) return heading;
  if (state.branch === "Opml") {
    return (
      container.querySelector<HTMLElement>('[data-add-focus="opml"]') ?? heading
    );
  }
  const requested = state.initialFocus === "File" ? "file" : "url";
  return (
    container.querySelector<HTMLElement>(`[data-add-focus="${requested}"]`) ??
    container.querySelector<HTMLElement>('[data-add-focus="queue"]') ??
    container.querySelector<HTMLElement>('[data-add-focus="add-more"]') ??
    heading
  );
}

type MembershipEditor =
  | {
      kind: "Row";
      mediaIds: readonly [string];
      title: string;
      anchorEl: HTMLElement;
    }
  | {
      kind: "BulkAdd" | "BulkRemove";
      mediaIds: readonly string[];
      title: string;
      anchorEl: HTMLElement;
    };

type MembershipEditorIntent =
  | {
      kind: "Row";
      mediaIds: readonly [string];
      title: string;
    }
  | {
      kind: "BulkAdd" | "BulkRemove";
      mediaIds: readonly string[];
      title: string;
    };

interface MembershipPresentation {
  libraries: LibraryTargetPickerItem[];
  loading: boolean;
  error: ReturnType<typeof feedbackForItem>;
  retryCommand: MembershipCommand | null;
}

function fileLabel(source: { name: string; sizeBytes: number }): string {
  return source.name;
}

function itemLabel(item: AddItem): string {
  switch (item.kind) {
    case "Invalid":
      return fileLabel(item.source);
    case "Draft":
      return item.source.kind === "Url"
        ? item.source.url
        : item.source.file.name;
    case "Submitting":
    case "Rejected":
    case "AcceptanceUnresolved":
    case "AcceptedUncertain":
      return item.intent.source.kind === "Url"
        ? item.intent.source.url
        : item.intent.source.file.name;
    case "Accepted":
      return item.source.kind === "Url"
        ? item.source.url
        : fileLabel(item.source);
  }
}

function isFileItem(item: AddItem): boolean {
  switch (item.kind) {
    case "Invalid":
      return true;
    case "Draft":
      return item.source.kind === "File";
    case "Submitting":
    case "Rejected":
    case "AcceptanceUnresolved":
    case "AcceptedUncertain":
      return item.intent.source.kind === "File";
    case "Accepted":
      return item.source.kind === "File";
  }
}

function acceptedStatus(item: Extract<AddItem, { kind: "Accepted" }>): string {
  const prefix = item.result.duplicate ? "Already in Nexus" : "Saved";
  if (item.result.sourceAttemptStatus === "failed") {
    return `${prefix} · processing failed`;
  }
  switch (item.result.processingStatus) {
    case "pending":
    case "extracting":
      return `${prefix} · processing`;
    case "ready_for_reading":
      return `${prefix} · ready`;
    case "failed":
      return `${prefix} · processing failed`;
  }
}

function itemStatus(item: AddItem): string {
  switch (item.kind) {
    case "Invalid":
      return "Not ready";
    case "Draft":
      return "Ready to add";
    case "Submitting":
      return item.intent.source.kind === "File" ? "Uploading…" : "Saving…";
    case "Rejected":
      return "Not added";
    case "AcceptanceUnresolved":
      return "Acceptance status unknown";
    case "AcceptedUncertain":
      return "Saved · status unknown";
    case "Accepted":
      return acceptedStatus(item);
  }
}

function feedbackForItem(item: AddItem) {
  switch (item.kind) {
    case "Invalid":
    case "Rejected":
    case "AcceptanceUnresolved":
    case "AcceptedUncertain":
      return item.feedback;
    case "Draft":
    case "Submitting":
    case "Accepted":
      return null;
  }
}

function librariesForMembership(
  membership: MembershipState | undefined,
): readonly LibraryTargetPickerItem[] {
  if (!membership) return [];
  switch (membership.kind) {
    case "Ready":
    case "Updating":
    case "Reconciling":
    case "CommandFailed":
      return membership.libraries;
    case "Unloaded":
    case "Loading":
    case "LoadFailed":
      return [];
  }
}

function projectBulkLibraries(
  memberships: readonly (MembershipState | undefined)[],
  command: "Add" | "Remove",
): LibraryTargetPickerItem[] {
  const byId = new Map<string, LibraryTargetPickerItem>();
  for (const membership of memberships) {
    for (const library of librariesForMembership(membership)) {
      const current = byId.get(library.id);
      const eligible =
        command === "Add"
          ? !library.isInLibrary && library.canAdd
          : library.isInLibrary && library.canRemove;
      byId.set(library.id, {
        id: library.id,
        name: library.name,
        color: library.color,
        isInLibrary: command === "Remove",
        canAdd: command === "Add" && (current?.canAdd === true || eligible),
        canRemove:
          command === "Remove" && (current?.canRemove === true || eligible),
      });
    }
  }
  return [...byId.values()].filter((library) =>
    command === "Add" ? library.canAdd : library.canRemove,
  );
}

function mutationLabel(session: AddContentSessionController): string {
  const mutation = session.state.mutation;
  if (mutation.kind === "Idle") return "";
  switch (mutation.operation.kind) {
    case "Submit":
      return `Adding ${mutation.operation.itemIds.length} ${mutation.operation.itemIds.length === 1 ? "item" : "items"}…`;
    case "ReconcileAcceptance":
      return "Checking…";
    case "CreateDestination":
      return "Creating library…";
    case "ImportOpml":
      return "Importing…";
    case "Membership":
      return "Updating libraries…";
  }
}

function feedbackStatus(feedback: {
  title: string;
  message?: string;
  requestId?: string;
}): string {
  return [
    feedback.title,
    feedback.message,
    feedback.requestId ? `Request ID: ${feedback.requestId}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function liveStatus(session: AddContentSessionController): string {
  const { state } = session;
  if (state.mutation.kind === "Running") return mutationLabel(session);
  if (state.branch === "Opml") {
    switch (state.opml.kind) {
      case "Empty":
        return "Choose an OPML file to import.";
      case "Ready":
        return `${state.opml.file.name} is ready to import.`;
      case "Importing":
        return "Importing OPML…";
      case "Invalid":
      case "Failed":
        return feedbackStatus(state.opml.feedback);
      case "Complete": {
        const { result } = state.opml;
        return `Import complete: ${result.total} total, ${result.imported} imported, ${result.skipped_already_subscribed} already subscribed, ${result.skipped_invalid} invalid, ${couldNotSubscribeCount(result)} could not subscribe.`;
      }
    }
  }
  if (state.intakeFeedback) return feedbackStatus(state.intakeFeedback);
  if (state.urlInput.feedback) return feedbackStatus(state.urlInput.feedback);
  const ready = draftItems(state).length;
  const accepted = settledAcceptedItems(state).length;
  const unknown = state.items.filter(
    (item) =>
      item.kind === "AcceptanceUnresolved" || item.kind === "AcceptedUncertain",
  ).length;
  const attention = state.items.filter(
    (item) => item.kind === "Rejected" || item.kind === "Invalid",
  ).length;
  return `${ready} ready, ${accepted} accepted, ${unknown} status unknown, ${attention} need attention.`;
}

function isSupportedDrop(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export default function AddPanel({
  session,
  dismissalConfirmation,
  onBack,
  onClose,
  onKeepWorking,
  onConfirmDismissal,
  onOpen,
  onDefect,
}: AddPanelProps): React.ReactElement {
  const { state } = session;
  const id = useId();
  const busy = state.mutation.kind === "Running";
  const creatingDestination =
    state.mutation.kind === "Running" &&
    state.mutation.operation.kind === "CreateDestination";
  const drafts = draftItems(state);
  const accepted = settledAcceptedItems(state);
  const uniqueAcceptedMediaIds = acceptedMediaIds(state);
  const [sourceExpanded, setSourceExpanded] = useState(
    state.items.length === 0 || state.urlInput.text.trim() !== "",
  );
  const [defaultDestinationsOpen, setDefaultDestinationsOpen] = useState(false);
  const [rowDestinationId, setRowDestinationId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [membershipEditor, setMembershipEditor] =
    useState<MembershipEditor | null>(null);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceFocusRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const addMoreRef = useRef<HTMLButtonElement>(null);
  const keepWorkingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dismissalConfirmation)
      requestAnimationFrame(() => keepWorkingRef.current?.focus());
  }, [dismissalConfirmation]);

  const membershipPresentation = useMemo<MembershipPresentation>(() => {
    if (!membershipEditor) {
      return {
        libraries: [],
        loading: false,
        error: null,
        retryCommand: null,
      };
    }
    const memberships = membershipEditor.mediaIds.map((mediaId) =>
      state.membershipByMediaId.get(mediaId),
    );
    const loading = memberships.some(
      (membership) =>
        membership === undefined ||
        membership.kind === "Unloaded" ||
        membership.kind === "Loading",
    );
    const failure = memberships.find(
      (membership) =>
        membership?.kind === "LoadFailed" ||
        membership?.kind === "CommandFailed",
    );
    const error =
      failure?.kind === "LoadFailed" || failure?.kind === "CommandFailed"
        ? failure.feedback
        : null;
    const libraries =
      membershipEditor.kind === "Row"
        ? [...librariesForMembership(memberships[0])]
        : projectBulkLibraries(
            memberships,
            membershipEditor.kind === "BulkAdd" ? "Add" : "Remove",
          );
    const retryCommand =
      failure?.kind === "CommandFailed" ? failure.command : null;
    return { libraries, loading, error, retryCommand };
  }, [membershipEditor, state.membershipByMediaId]);

  function focusQueue() {
    requestAnimationFrame(() => queueRef.current?.focus());
  }

  function reviewUrls(event: React.FormEvent) {
    event.preventDefault();
    if (!session.reviewUrls()) return;
    setSourceExpanded(false);
    focusQueue();
  }

  function stageFiles(files: readonly File[], input?: HTMLInputElement) {
    if (!session.stageFiles(files)) return;
    if (input) input.value = "";
    setSourceExpanded(false);
    focusQueue();
  }

  function removeItem(itemId: string) {
    const index = state.items.findIndex((item) => item.id === itemId);
    const focusId = state.items[index + 1]?.id ?? state.items[index - 1]?.id;
    session.removeItem(itemId);
    requestAnimationFrame(() => {
      if (focusId) {
        const row = queueRef.current?.querySelector<HTMLElement>(
          `[data-add-item-id="${focusId}"]`,
        );
        const target = row?.querySelector<HTMLElement>("button:not(:disabled)");
        if (target) {
          target.focus();
          return;
        }
      }
      (addMoreRef.current ?? sourceFocusRef.current)?.focus();
    });
  }

  function openMembershipEditor(
    editor: MembershipEditorIntent,
    anchorEl: HTMLElement,
  ) {
    setMembershipEditor({ ...editor, anchorEl });
    runSessionCommand(() => session.refreshMemberships(editor.mediaIds));
  }

  function runSessionCommand(command: () => Promise<void>): void {
    void command().catch(onDefect);
  }

  async function createDestination(
    name: string,
  ): Promise<LibraryDestinationSelection> {
    try {
      return await session.createDestination(name);
    } catch (error) {
      if (isLibraryDestinationDefect(error)) onDefect(error);
      throw error;
    }
  }

  const sourceEntry = (
    <section className={styles.sourceEntry} aria-label="Add sources">
      <form className={styles.urlForm} onSubmit={reviewUrls}>
        <label htmlFor={`${id}-urls`}>Links</label>
        <Textarea
          ref={sourceFocusRef}
          id={`${id}-urls`}
          data-add-focus="url"
          size="sm"
          className={styles.urlTextarea}
          value={state.urlInput.text}
          disabled={busy}
          aria-invalid={state.urlInput.feedback ? true : undefined}
          aria-describedby={
            state.urlInput.feedback ? `${id}-url-feedback` : `${id}-url-help`
          }
          onChange={(event) => session.setUrlText(event.target.value)}
          placeholder="Paste links to articles, videos, PDFs, or EPUBs"
          rows={3}
        />
        <div className={styles.sourceActions}>
          <p
            id={
              state.urlInput.feedback ? `${id}-url-feedback` : `${id}-url-help`
            }
          >
            {state.urlInput.feedback?.title ??
              "One per line, or paste text containing links."}
          </p>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy || !state.urlInput.text.trim()}
          >
            Review links
          </Button>
        </div>
      </form>

      <div
        className={`${styles.fileDrop}${dragActive ? ` ${styles.fileDropActive}` : ""}`}
        onDragEnter={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!isSupportedDrop(event)) return;
          event.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragActive(false);
        }}
        onDrop={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragActive(false);
          stageFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          className={styles.fileInput}
          aria-label="Choose PDF or EPUB files"
          disabled={busy}
          onChange={(event) =>
            stageFiles(
              Array.from(event.target.files ?? []),
              event.currentTarget,
            )
          }
        />
        <Button
          data-add-focus="file"
          variant="secondary"
          size="sm"
          disabled={busy}
          leadingIcon={<Upload size={15} aria-hidden="true" />}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose PDF or EPUB
        </Button>
        <span>or drop files here · PDF up to 100 MB · EPUB up to 50 MB</span>
      </div>

      {state.items.length === 0 || drafts.length === 0 ? (
        <LibraryDestinationDisclosure
          label="Libraries"
          open={defaultDestinationsOpen}
          onOpenChange={setDefaultDestinationsOpen}
          selected={state.defaultDestinations}
          onChange={session.setDefaultDestinations}
          interaction={
            creatingDestination
              ? { kind: "Creating" }
              : busy
                ? { kind: "Disabled" }
                : { kind: "Enabled" }
          }
          onCreateDestination={createDestination}
        />
      ) : null}

      <button
        type="button"
        className={styles.opmlLink}
        disabled={busy}
        onClick={session.openOpml}
      >
        Import podcast subscriptions from OPML
      </button>
    </section>
  );

  const activeMembershipMediaIds =
    state.mutation.kind === "Running" &&
    state.mutation.operation.kind === "Membership"
      ? new Set(state.mutation.operation.mediaIds)
      : new Set<string>();

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className={styles.heading}>
          <h2
            ref={headingRef}
            tabIndex={-1}
            data-add-heading="true"
            data-add-focus={state.branch === "Opml" ? "opml" : undefined}
          >
            {state.branch === "Opml" ? "Import OPML" : "Add content"}
          </h2>
          <p>
            {state.branch === "Opml"
              ? "Import podcast subscriptions from another app."
              : "Review sources, then add them when you are ready."}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onClose}
          aria-label={`Close ${state.branch === "Opml" ? "Import OPML" : "Add content"}`}
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className={styles.body}>
        {state.branch === "Opml" ? (
          <OpmlImportPanel
            state={state.opml}
            destinations={state.opmlDestinations}
            disabled={busy}
            creatingDestination={creatingDestination}
            onFileChange={session.setOpmlFile}
            onDestinationsChange={session.setOpmlDestinations}
            onCreateDestination={createDestination}
            onManagePodcasts={() =>
              onOpen({ kind: "href", href: "/podcasts", externalShell: false })
            }
          />
        ) : (
          <>
            {state.items.length === 0 || sourceExpanded ? (
              sourceEntry
            ) : (
              <Button
                ref={addMoreRef}
                data-add-focus="add-more"
                variant="ghost"
                size="sm"
                className={styles.addMore}
                disabled={busy}
                leadingIcon={<Plus size={15} aria-hidden="true" />}
                onClick={() => {
                  setSourceExpanded(true);
                  requestAnimationFrame(() => sourceFocusRef.current?.focus());
                }}
              >
                Add more
              </Button>
            )}

            {drafts.length > 0 ? (
              <section
                className={styles.draftToolbar}
                aria-label="Draft filing"
              >
                <LibraryDestinationDisclosure
                  label={`Libraries for all ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`}
                  open={defaultDestinationsOpen}
                  onOpenChange={setDefaultDestinationsOpen}
                  selected={state.defaultDestinations}
                  onChange={session.setDefaultDestinations}
                  interaction={
                    creatingDestination
                      ? { kind: "Creating" }
                      : busy
                        ? { kind: "Disabled" }
                        : { kind: "Enabled" }
                  }
                  onCreateDestination={createDestination}
                />
              </section>
            ) : null}

            {state.intakeFeedback ? (
              <p className={styles.intakeFeedback}>
                {state.intakeFeedback.title}
              </p>
            ) : null}

            {state.items.length > 0 ? (
              <div
                ref={queueRef}
                className={styles.queue}
                tabIndex={-1}
                data-add-focus="queue"
                aria-label="Items to add"
              >
                {state.items.map((item) => {
                  const feedback = feedbackForItem(item);
                  const feedbackId = feedback
                    ? `${id}-${item.id}-feedback`
                    : undefined;
                  const mediaId =
                    item.kind === "Accepted"
                      ? item.result.mediaId
                      : item.kind === "AcceptedUncertain"
                        ? item.mediaId
                        : null;
                  return (
                    <article
                      key={item.id}
                      className={styles.queueItem}
                      data-add-item-id={item.id}
                      aria-describedby={feedbackId}
                    >
                      <div className={styles.itemIcon} aria-hidden="true">
                        {isFileItem(item) ? (
                          <FileText size={16} />
                        ) : (
                          <Link size={16} />
                        )}
                      </div>
                      <div className={styles.itemMain}>
                        <span
                          className={styles.itemLabel}
                          title={itemLabel(item)}
                        >
                          {itemLabel(item)}
                        </span>
                        <span className={styles.itemStatus}>
                          {state.mutation.kind === "Running" &&
                          state.mutation.operation.kind ===
                            "ReconcileAcceptance" &&
                          state.mutation.operation.itemId === item.id
                            ? "Checking…"
                            : itemStatus(item)}
                        </span>
                        {activeMembershipMediaIds.has(mediaId ?? "") ? (
                          <span className={styles.membershipStatus}>
                            Updating libraries…
                          </span>
                        ) : null}
                        {feedback ? (
                          <span
                            id={feedbackId}
                            className={styles.itemFeedback}
                            data-severity={feedback.severity}
                          >
                            {feedback.title}
                            {feedback.message ? ` ${feedback.message}` : ""}
                            {feedback.requestId
                              ? ` Request ID: ${feedback.requestId}`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.itemActions}>
                        {item.kind === "Draft" ? (
                          <LibraryDestinationDisclosure
                            label="Libraries"
                            open={rowDestinationId === item.id}
                            onOpenChange={(open) =>
                              setRowDestinationId(open ? item.id : null)
                            }
                            selected={item.destinations}
                            onChange={(next) =>
                              session.setItemDestinations(item.id, next)
                            }
                            interaction={
                              creatingDestination
                                ? { kind: "Creating" }
                                : busy
                                  ? { kind: "Disabled" }
                                  : { kind: "Enabled" }
                            }
                            onCreateDestination={createDestination}
                          />
                        ) : null}
                        {item.kind === "Rejected" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => session.restageItem(item.id)}
                          >
                            Restage
                          </Button>
                        ) : null}
                        {item.kind === "AcceptanceUnresolved" ||
                        item.kind === "AcceptedUncertain" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              runSessionCommand(() =>
                                session.reconcileAcceptance(item.id),
                              )
                            }
                          >
                            Check status
                          </Button>
                        ) : null}
                        {item.kind === "AcceptanceUnresolved" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => session.restageItem(item.id)}
                          >
                            Restage as new
                          </Button>
                        ) : null}
                        {mediaId ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              onOpen({
                                kind: "href",
                                href:
                                  item.kind === "Accepted" &&
                                  item.result.duplicate
                                    ? `/media/${mediaId}?duplicate=true`
                                    : `/media/${mediaId}`,
                                externalShell: false,
                              })
                            }
                          >
                            Open
                          </Button>
                        ) : null}
                        {item.kind === "Accepted" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={(event) =>
                              openMembershipEditor(
                                {
                                  kind: "Row",
                                  mediaIds: [item.result.mediaId],
                                  title: `Libraries for ${itemLabel(item)}`,
                                },
                                event.currentTarget,
                              )
                            }
                          >
                            Libraries
                          </Button>
                        ) : null}
                        {item.kind === "Invalid" ||
                        item.kind === "Draft" ||
                        item.kind === "Rejected" ||
                        item.kind === "AcceptanceUnresolved" ||
                        item.kind === "AcceptedUncertain" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            disabled={busy}
                            onClick={() => removeItem(item.id)}
                            aria-label={`Remove ${itemLabel(item)}`}
                          >
                            <X size={14} aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}

            {accepted.length > 0 ? (
              <section
                className={styles.acceptedSummary}
                aria-label="Added items"
              >
                <p>
                  {accepted.length} {accepted.length === 1 ? "item" : "items"}{" "}
                  added
                </p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={(event) =>
                      openMembershipEditor(
                        {
                          kind: "BulkAdd",
                          mediaIds: uniqueAcceptedMediaIds,
                          title: "Add all to libraries",
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    Add all to…
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={(event) =>
                      openMembershipEditor(
                        {
                          kind: "BulkRemove",
                          mediaIds: uniqueAcceptedMediaIds,
                          title: "Remove all from libraries",
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    Remove all from…
                  </Button>
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.liveStatus} role="status" aria-live="polite">
        {liveStatus(session)}
      </div>

      <footer className={styles.footer}>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={
            state.branch === "Opml"
              ? !busy &&
                state.opml.kind !== "Ready" &&
                state.opml.kind !== "Failed" &&
                state.opml.kind !== "Complete"
              : false
          }
          onClick={() => {
            if (busy) return;
            if (state.branch === "Opml") {
              if (state.opml.kind === "Complete") onClose();
              else runSessionCommand(session.importOpml);
              return;
            }
            if (drafts.length > 0) runSessionCommand(session.submit);
            else onClose();
          }}
        >
          {busy
            ? mutationLabel(session)
            : state.branch === "Opml"
              ? state.opml.kind === "Complete"
                ? "Done"
                : "Import OPML"
              : drafts.length > 0
                ? `Add ${drafts.length} ${drafts.length === 1 ? "item" : "items"}`
                : "Done"}
        </Button>
      </footer>

      <Dialog
        open={dismissalConfirmation !== null}
        title={
          dismissalConfirmation?.kind === "Stop"
            ? "Stop active work?"
            : "Discard unfinished work?"
        }
        onClose={onKeepWorking}
      >
        {dismissalConfirmation ? (
          <div className={styles.confirmationBody}>
            <p>
              {dismissalConfirmation.kind === "Stop"
                ? "Server changes that already committed may remain; unfinished upload bytes may not."
                : "Unsubmitted sources and unresolved outcomes will be lost."}
            </p>
            <div className={styles.confirmationActions}>
              <Button
                ref={keepWorkingRef}
                variant="secondary"
                size="sm"
                onClick={onKeepWorking}
              >
                Keep working
              </Button>
              <Button variant="danger" size="sm" onClick={onConfirmDismissal}>
                {dismissalConfirmation.actionLabel}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <LibraryMembershipPanel
        open={membershipEditor !== null}
        title={membershipEditor?.title ?? "Libraries"}
        anchorEl={membershipEditor?.anchorEl ?? null}
        returnFocusFallback={() => headingRef.current}
        libraries={membershipPresentation.libraries}
        loading={membershipPresentation.loading}
        busy={
          state.mutation.kind === "Running" &&
          state.mutation.operation.kind === "Membership"
        }
        error={membershipPresentation.error}
        emptyMessage="No eligible libraries."
        onRetry={
          membershipPresentation.error && membershipEditor
            ? () => {
                const retryCommand = membershipPresentation.retryCommand;
                if (retryCommand) {
                  runSessionCommand(() =>
                    session.runMembership({
                      mediaIds: membershipEditor.mediaIds,
                      command: retryCommand,
                    }),
                  );
                  return;
                }
                runSessionCommand(() =>
                  session.refreshMemberships(membershipEditor.mediaIds),
                );
              }
            : undefined
        }
        onClose={() => setMembershipEditor(null)}
        onAddToLibrary={(libraryId) => {
          if (!membershipEditor) return;
          runSessionCommand(() =>
            session.runMembership({
              mediaIds: membershipEditor.mediaIds,
              command: { kind: "Add", libraryId },
            }),
          );
        }}
        onRemoveFromLibrary={(libraryId) => {
          if (!membershipEditor) return;
          runSessionCommand(() =>
            session.runMembership({
              mediaIds: membershipEditor.mediaIds,
              command: { kind: "Remove", libraryId },
            }),
          );
        }}
      />
    </div>
  );
}
