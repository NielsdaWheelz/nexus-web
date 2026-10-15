"use client";

// "Libraries…": where some media or shows sit among the viewer's libraries (All
// is Saved in Nexus), toggled one library at a time. With several targets a
// library is chosen when it holds every one; choosing it files those it lacks,
// unchoosing it unfiles them all; one deleted meanwhile is left out. Every
// write is idempotent, so Retry resends it. Filing a show where its episodes
// are filed asks first. Any filing anywhere rereads the open overlay.

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import ChooserSurface from "@/components/libraries/ChooserSurface";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import {
  addPlacement,
  createLibrary,
  placements,
  removePlacement,
  type LibraryPlacement,
  type LibraryPlacementTarget,
} from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { RESERVED_NAME, isReservedName } from "@/lib/libraries/views";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";

const BLOCKED: Record<NonNullable<LibraryPlacement["blocked"]>, string> = {
  RequiresAdmin: "Only a library admin can change this placement.",
  RequiresSubscription: "Subscribe to this podcast before adding it to a library.",
  SystemManaged: "This system library is managed automatically.",
};

export default function PlacementOverlay({
  session,
  onClose,
  inline,
  panelId,
  skipReturnFocus,
}: {
  readonly session: LibraryPlacementSession | null;
  readonly onClose: () => void;
  /** In the host's layout (ChooserSurface). */
  readonly inline?: boolean;
  readonly panelId?: string;
  readonly skipReturnFocus?: () => boolean;
}) {
  useMobileChromeHold(session !== null);
  return (
    <ChooserSurface
      active={session !== null}
      inline={inline}
      onClose={onClose}
      anchor={session?.options.anchor ?? (() => null)}
      returnFocusFallback={session?.options.returnFocusFallback ?? undefined}
      skipReturnFocus={skipReturnFocus}
      title="Libraries"
      focusKey={session?.key}
      panelId={panelId}
    >
      {session ? <Editor key={session.key} targets={session.targets} /> : null}
    </ChooserSurface>
  );
}

interface Failure {
  readonly content: FeedbackContent;
  readonly retry: (() => void) | null;
}

interface Held {
  readonly target: LibraryPlacementTarget;
  readonly placed: readonly LibraryPlacement[];
}

/** Where each target sits. A target deleted since it was chosen is left out (its
 * 404); the 404 stands when none is left. */
async function inventoryOf(targets: readonly LibraryPlacementTarget[]): Promise<Held[]> {
  const read = await Promise.allSettled(targets.map((target) => placements(target)));
  const held: Held[] = [];
  for (const [i, result] of read.entries()) {
    if (result.status === "fulfilled") held.push({ target: targets[i], placed: result.value });
    else if (!isApiError(result.reason) || result.reason.status !== 404) throw result.reason;
  }
  if (held.length === 0 && read[0]?.status === "rejected") throw read[0].reason;
  return held;
}

function Editor({ targets }: { readonly targets: readonly LibraryPlacementTarget[] }) {
  const fail = useThrowLater();
  const stamp = useChangeStamp("Libraries", "Entries");
  const [inventory, setInventory] = useState<readonly Held[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>("load");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<{
    readonly libraryId: string;
    readonly message: string;
  } | null>(null);
  const reads = useRef(0);

  const report = useCallback(
    (error: unknown, title: string, retry: () => void) => {
      const content = libraryErrorFeedback(error, title, fail);
      // A transport failure may have landed; resending is safe.
      const transport = isApiError(error) && (error.status === 0 || error.status >= 500);
      if (content) setFailure({ content, retry: transport ? retry : null });
    },
    [fail],
  );
  const load = useCallback(async () => {
    const read = ++reads.current;
    try {
      const next = await inventoryOf(targets);
      if (read === reads.current) setInventory(next);
    } catch (error) {
      if (read !== reads.current) return;
      setInventory(null);
      report(error, "Libraries couldn’t be loaded", () => void load());
    } finally {
      if (read === reads.current) setPending((step) => (step === "load" ? null : step));
    }
  }, [report, targets]);
  useEffect(() => {
    void load();
  }, [load, stamp]);

  /** Per target, its placement in one library. */
  const cells = (libraryId: string) =>
    (inventory ?? []).map(({ target, placed }) => ({
      target,
      cell: placed.find((p) => p.library_id === libraryId),
    }));

  const write = async (libraryId: string, add: boolean, replaceEpisodes = false) => {
    setPending(libraryId);
    setFailure(null);
    setConflict(null);
    try {
      for (const { target, cell } of cells(libraryId)) {
        if (add && cell?.relation === "Absent") {
          await addPlacement(target, libraryId, replaceEpisodes);
        } else if (!add && cell?.relation === "Direct") {
          await removePlacement(target, libraryId);
        }
      }
    } catch (error) {
      if (isApiError(error) && error.code === "E_PODCAST_REPLACES_EPISODES") {
        const [row] = (error.details?.conflicts ?? []) as {
          readonly library_name: string;
          readonly episode_count: number;
        }[];
        setConflict({
          libraryId,
          message: `${row?.library_name} files ${row?.episode_count} of its episodes. Adding the show replaces them; they stay in All.`,
        });
      } else {
        report(
          error,
          add ? "Not added to the library" : "Not removed from the library",
          () => void write(libraryId, add, replaceEpisodes),
        );
      }
      await load();
    } finally {
      setPending(null);
    }
  };

  const createAndAdd = async (name: string, id: string) => {
    setPending("create");
    setFailure(null);
    try {
      await createLibrary({ id, name });
      setQuery("");
      const fresh = await inventoryOf(targets);
      setInventory(fresh);
      for (const { target, placed } of fresh) {
        const cell = placed.find((p) => p.library_id === id);
        if (cell?.relation === "Absent" && cell.blocked === null) await addPlacement(target, id);
      }
    } catch (error) {
      report(error, "Library wasn’t created", () => void createAndAdd(name, id));
    } finally {
      setPending(null);
    }
  };

  // One row per library: chosen when every target is in it.
  const count = inventory?.length ?? 0;
  const rows: ChooserRow[] = (inventory?.[0]?.placed ?? []).map((first) => {
    const all = cells(first.library_id).map(({ cell }) => cell);
    const holding = all.filter((cell) => cell && cell.relation !== "Absent").length;
    const blocked = all.find((cell) => cell?.blocked)?.blocked;
    return {
      id: first.library_id,
      name: first.is_default ? "Saved in Nexus" : first.name,
      chosen: holding === count,
      readOnly: blocked
        ? BLOCKED[blocked]
        : all.every((cell) => cell?.relation === "Inherited")
          ? "Included through its show."
          : null,
      note: holding > 0 && holding < count ? `In ${holding} of ${count}` : null,
      pending: pending === first.library_id,
    };
  });
  const q = query.trim().toLowerCase();
  const name = query.trim();
  const reserved = isReservedName(name);
  const shown = rows.filter((row) => row.chosen || row.name.toLowerCase().includes(q));
  const canCreate =
    inventory !== null &&
    name.length > 0 &&
    name.length <= 100 &&
    !reserved &&
    !rows.some((row) => row.name.toLowerCase() === q);

  return (
    <>
      {conflict ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "Replace filed episodes?", message: conflict.message }}
          announcement="Assertive"
          actions={[
            {
              label: "Add the show",
              onClick: () => void write(conflict.libraryId, true, true),
            },
            { label: "Cancel", onClick: () => setConflict(null) },
          ]}
        />
      ) : null}
      <LibraryChooser
        query={query}
        onQueryChange={setQuery}
        label="Search or create a library"
        placeholder="Search or create"
        chosenLabel={targets.length > 1 ? "Holding all of these" : "In these libraries"}
        rows={shown}
        onToggle={(row) => void write(row.id, !row.chosen)}
        busy={pending !== null || conflict !== null}
        loading={pending === "load"}
        status={
          pending === "create"
            ? "Creating library…"
            : pending !== null
              ? "Updating libraries…"
              : reserved
                ? RESERVED_NAME
                : `${shown.length} ${shown.length === 1 ? "destination" : "destinations"}`
        }
        empty={
          reserved
            ? RESERVED_NAME
            : inventory === null
              ? null
              : rows.length === 0
                ? "No libraries yet. Type a name to create one."
                : "No libraries match your search."
        }
        error={failure}
        create={canCreate ? { name, run: () => void createAndAdd(name, crypto.randomUUID()) } : null}
        more={null}
      />
    </>
  );
}
