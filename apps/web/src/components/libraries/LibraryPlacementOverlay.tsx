"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLibrary } from "@/lib/libraries/client";
import {
  addLibraryPlacement,
  libraryPlacementDestinationKey,
  listLibraryPlacements,
  removeLibraryPlacement,
  type LibraryPlacementDestination,
  type LibraryPlacementDestinationKey,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import {
  libraryPlacementSnapshot,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";

export default function LibraryPlacementOverlay({
  session,
  onClose,
}: {
  session: LibraryPlacementSession | null;
  onClose: () => void;
}) {
  const fallback = session?.options.returnFocusFallback;
  useMobileChromeHold(session !== null);

  return (
    <LibraryChooserSurface
      active={session !== null}
      onClose={onClose}
      layer="modal"
      anchor={session ? session.options.anchor : () => null}
      returnFocusFallback={fallback?.kind === "Present" ? fallback.value : undefined}
      title="Libraries"
      focusKey={session?.key}
    >
      {session ? <PlacementEditor key={session.key} session={session} /> : null}
    </LibraryChooserSurface>
  );
}

/**
 * One target's placement inventory. It runs one step at a time (a read, a toggle's write, or
 * create-and-add) and shows the rows of the last successful read. A write that succeeded, or
 * whose outcome is unknown, reconciles the subject's action snapshot.
 */
function PlacementEditor({ session: { target, options } }: { session: LibraryPlacementSession }) {
  const [rows, setRows] = useState<LibraryPlacementOption[] | null>(null);
  const [pending, setPending] = useState<
    "Load" | "Create" | LibraryPlacementDestinationKey | null
  >("Load");
  const [failure, setFailure] = useState<{
    content: FeedbackContent;
    onRetry: (() => void) | null;
  } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const { revision } = useLibraryPlacementRevision();
  // The placement bus revision when the rows' read was sent.
  const readRevision = useRef(revision);

  // Shows why a step failed, or sends an unexpected error to the pane boundary, and says what
  // the failure means for the step. "Transport": the outcome is unknown, and Retry resends the
  // step, which is safe because every step is idempotent. "Refused": resending would repeat
  // the refusal, so there is no Retry. null: nothing more to do (signed out, a defect, or the
  // target is gone, which ends the session with no rows).
  const fail = useCallback(
    (
      error: unknown,
      title: string,
      request: LibraryRequest,
      retry: () => void,
    ): "Transport" | "Refused" | null => {
      setPending(null);
      if (handleUnauthenticatedApiError(error)) return null;
      if (!isApiError(error)) {
        setDefect({ error });
        return null;
      }
      const transport = apiTransportFeedback(error, title);
      if (transport) {
        setFailure({ content: transport, onRetry: retry });
        return "Transport";
      }
      let content: FeedbackContent;
      try {
        content = libraryRequestErrorMessage(error, { title, request });
      } catch {
        setDefect({ error });
        return null;
      }
      if (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND") {
        // The table's copy asks for a refresh, which cannot bring the target back.
        setRows(null);
        setFailure({
          content: { ...content, message: "This item is no longer available." },
          onRetry: null,
        });
        return null;
      }
      setFailure({ content, onRetry: null });
      return "Refused";
    },
    [],
  );

  const reread = useCallback(
    async function reread() {
      readRevision.current = libraryPlacementSnapshot().revision;
      try {
        setRows(await listLibraryPlacements(target));
        setPending(null);
      } catch (error) {
        fail(error, "Libraries couldn’t be loaded", "EntryRead", () => {
          setPending("Load");
          setFailure(null);
          void reread();
        });
      }
    },
    [fail, target],
  );

  useEffect(() => {
    void reread();
  }, [reread]);

  // Another surface, or a write sent before this overlay was closed and reopened, can change
  // placements after the rows were read. Only an idle editor rereads: every step ends in a
  // read or a failure, and the step after a failure reads again.
  useEffect(() => {
    if (pending !== null || failure !== null || revision <= readRevision.current) return;
    setPending("Load");
    void reread();
  }, [pending, failure, revision, reread]);

  async function command(op: "Add" | "Remove", destination: LibraryPlacementDestination) {
    setPending(libraryPlacementDestinationKey(destination));
    setFailure(null);
    try {
      const write = op === "Add" ? addLibraryPlacement : removeLibraryPlacement;
      await write({ target, destination });
    } catch (error) {
      const title =
        op === "Add" ? "Item wasn’t added to the library" : "Item wasn’t removed from the library";
      const outcome = fail(error, title, "PlacementMutation", () => void command(op, destination));
      if (outcome === "Transport") {
        // The write may have committed, and the subject's actions depend on its placements.
        void options.reconcileActions().catch((error: unknown) => setDefect({ error }));
      } else if (outcome === "Refused") {
        // A refusal can come from stale rows: a deleted library, a changed role or subscription.
        setPending("Load");
        await reread();
      }
      return;
    }
    void options.reconcileActions().catch((error: unknown) => setDefect({ error }));
    await reread();
  }

  async function createAndAdd(name: string, libraryId: string) {
    // A retry resends the same id; creating a library is idempotent by id.
    const retry = () => void createAndAdd(name, libraryId);
    setPending("Create");
    setFailure(null);
    try {
      await createLibrary({ libraryId, name });
    } catch (error) {
      fail(error, "Library wasn’t created", "LibraryCreate", retry);
      return;
    }
    let fresh: LibraryPlacementOption[];
    readRevision.current = libraryPlacementSnapshot().revision;
    try {
      fresh = await listLibraryPlacements(target);
    } catch (error) {
      fail(error, "Libraries couldn’t be loaded", "EntryRead", retry);
      return;
    }
    setRows(fresh);
    // The fresh inventory reauthorizes the add: an unsubscribed podcast lists the new library as
    // RequiresSubscription.
    const created = fresh.find(
      ({ destination }) => destination.kind === "Library" && destination.library.id === libraryId,
    );
    if (created?.availability.kind === "Available" && created.relation.kind === "Absent") {
      await command("Add", created.destination);
    } else {
      setPending(null);
    }
  }

  if (defect) throw defect.error;

  return (
    <LibraryEntryEditor
      placements={rows ?? []}
      loading={pending === "Load"}
      busy={pending !== null}
      creating={pending === "Create"}
      pendingDestinationKey={pending === "Load" || pending === "Create" ? null : pending}
      error={failure}
      onToggle={(destination) => {
        const key = libraryPlacementDestinationKey(destination);
        const row = rows?.find(({ destination: d }) => libraryPlacementDestinationKey(d) === key);
        if (row?.availability.kind !== "Available" || row.relation.kind === "Inherited") return;
        void command(row.relation.kind === "Absent" ? "Add" : "Remove", destination);
      }}
      onCreateLibrary={(name) => void createAndAdd(name, crypto.randomUUID())}
      selectedGroupLabel="In these libraries"
      otherGroupLabel="Other libraries"
      searchLabel="Search or create a library"
      searchPlaceholder="Search or create"
      listLabel="Library options"
      emptyInventory="No libraries yet. Type a name to create one."
    />
  );
}
