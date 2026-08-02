import { Component, type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { assumeMediaId, type MediaId } from "@/lib/lectern/contract";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import {
  CompletionUndoFeedbackOwner,
  useCompletionUndo,
} from "./useCompletionUndo";

// This suite drives the REAL LecternProvider and the REAL FeedbackProvider,
// stubbing only the BFF fetch transport. Completion Undo therefore exercises the
// real consumption/lectern FIFO and the real ApiError taxonomy, and every
// assertion is against the real user-visible feedback DOM (the "HUD feedback" and
// "Persistent feedback" regions) rather than a mocked feedback owner.

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const RESTORED_ITEM = "aaaaaaaa-1111-4111-8111-111111111111";
const LECTERN_PATH = "/api/lectern";
const CONSUMPTION_COMMANDS = "/api/consumption/commands";
const LECTERN_COMMANDS = "/api/lectern/commands";

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** A schema-valid `LecternItem` the real snapshot decoder accepts. */
function wireItem(itemId: string, mediaId: string, title = "Restored media") {
  return {
    itemId,
    mediaId,
    kind: "web_article",
    title,
    subtitle: { kind: "Absent" },
    href: `/media/${mediaId}`,
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
    activation: { kind: "Readable" },
  };
}

/** A schema-valid `ConsumptionResult` for a status-only (SetUnread) success. */
function consumptionResultWire(items: unknown[] = []) {
  return {
    outcome: { kind: "StateOnly" },
    lectern: { items },
    nextItem: { kind: "Absent" },
    progressState: { kind: "Absent" },
    completionHandle: { kind: "Absent" },
    libraryEntriesCollectionRevision: 0,
  };
}

/** A schema-valid `LecternResult` for a PlaceItems success. */
function lecternResultWire(items: unknown[], itemIds: string[]) {
  return {
    outcome: { kind: "Placed", itemIds },
    lectern: { items },
  };
}

const hudRegion = () => screen.getByRole("region", { name: "HUD feedback" });
const persistentRegion = () =>
  screen.getByRole("region", { name: "Persistent feedback" });

class TestBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <output aria-label="completion boundary">{this.state.error.message}</output>
    ) : (
      this.props.children
    );
  }
}

function LecternReadout() {
  const { resource } = useLectern();
  return <span>lectern:{resource.status}</span>;
}

function Probe({ mediaId }: { mediaId: MediaId }) {
  const offerUndo = useCompletionUndo();
  const { placeItems } = useLectern();
  return (
    <>
      <button
        onClick={() =>
          offerUndo({
            mediaId,
            preCompletionSnapshot: { items: [] },
            completedItemId: null,
            completionHandle: { kind: "Absent" },
          })
        }
      >
        Offer Undo
      </button>
      <button
        onClick={() => {
          void placeItems({
            mediaIds: [mediaId],
            placement: { kind: "First" },
          }).catch(() => {});
        }}
      >
        External place
      </button>
    </>
  );
}

function renderHarness(mediaId: MediaId) {
  return render(
    <FeedbackProvider>
      <LecternProvider>
        <CompletionUndoFeedbackOwner />
        <LecternReadout />
        <TestBoundary>
          <Probe mediaId={mediaId} />
        </TestBoundary>
      </LecternProvider>
    </FeedbackProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCompletionUndo defect routing", () => {
  it("offers one provider-timed ten-second Undo HUD, not a five-second passive one", () => {
    vi.useFakeTimers();
    stubFetch(async (input) => {
      if (fetchInputPath(input) === LECTERN_PATH) {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    renderHarness(assumeMediaId(MEDIA_ID));
    fireEvent.click(screen.getByRole("button", { name: "Offer Undo" }));

    // The offer publishes exactly one action HUD; the provider — not the caller —
    // owns its lifetime.
    expect(within(hudRegion()).getByText("Marked as finished")).toBeInTheDocument();
    expect(
      within(hudRegion()).getByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();

    // A HUD carrying actions lives for the ten-second constant, not the
    // five-second passive lifetime: present just before 10s...
    act(() => vi.advanceTimersByTime(9_999));
    expect(within(hudRegion()).getByText("Marked as finished")).toBeInTheDocument();
    // ...and gone once the tenth second elapses.
    act(() => vi.advanceTimersByTime(2));
    expect(
      within(hudRegion()).queryByText("Marked as finished"),
    ).toBeNull();
  });

  it("routes an unknown mark-unread code to the boundary without a second signal", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      stubFetch(async (input, init) => {
        const path = fetchInputPath(input);
        const method = init?.method ?? "GET";
        if (path === LECTERN_PATH && method === "GET") {
          return jsonResponse({ data: { items: [] } });
        }
        if (path === CONSUMPTION_COMMANDS && method === "POST") {
          return errorResponse(
            409,
            "E_NEW_COMPLETION_FAILURE",
            "unknown completion failure",
          );
        }
        throw new Error(`Unexpected fetch: ${method} ${path}`);
      });

      renderHarness(assumeMediaId(MEDIA_ID));
      await screen.findByText("lectern:ready");

      fireEvent.click(screen.getByRole("button", { name: "Offer Undo" }));
      fireEvent.click(within(hudRegion()).getByRole("button", { name: "Undo" }));

      expect(
        await screen.findByLabelText("completion boundary"),
      ).toHaveTextContent("unknown completion failure");

      // The action HUD was consumed on click and nothing replaced it: the
      // unknown code became a render-thrown defect, never a second signal.
      expect(within(hudRegion()).queryByRole("article")).toBeNull();
      expect(within(persistentRegion()).queryByRole("article")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resolves the durable restore record when a canonical install relists the media", async () => {
    let placeCalls = 0;
    stubFetch(async (input, init) => {
      const path = fetchInputPath(input);
      const method = init?.method ?? "GET";
      if (path === LECTERN_PATH && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      if (path === CONSUMPTION_COMMANDS && method === "POST") {
        // The mark-unread half of Undo succeeds.
        return jsonResponse({ data: consumptionResultWire([]) });
      }
      if (path === LECTERN_COMMANDS && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { kind?: string };
        if (body.kind !== "PlaceItems") {
          throw new Error(`Unexpected Lectern command ${String(body.kind)}`);
        }
        placeCalls += 1;
        if (placeCalls === 1) {
          // The restore half fails definitively → durable persistent record.
          return errorResponse(409, "E_LIMIT", "Lectern is full");
        }
        // A later external canonical install relists the media.
        return jsonResponse({
          data: lecternResultWire(
            [wireItem(RESTORED_ITEM, MEDIA_ID)],
            [RESTORED_ITEM],
          ),
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });

    renderHarness(assumeMediaId(MEDIA_ID));
    await screen.findByText("lectern:ready");

    fireEvent.click(screen.getByRole("button", { name: "Offer Undo" }));
    fireEvent.click(within(hudRegion()).getByRole("button", { name: "Undo" }));

    // Marked unread, but the restore failed: a durable record retains only the
    // remaining restore step.
    const restoreRecord = await within(persistentRegion()).findByText(
      "Marked unread; Lectern wasn’t restored",
    );
    expect(restoreRecord).toBeInTheDocument();
    expect(
      within(persistentRegion()).getByRole("button", { name: "Restore" }),
    ).toBeInTheDocument();

    // An external canonical install that relists the media resolves the stale
    // restore record through the CompletionUndoFeedbackOwner.
    fireEvent.click(screen.getByRole("button", { name: "External place" }));
    await waitFor(() =>
      expect(
        within(persistentRegion()).queryByText(
          "Marked unread; Lectern wasn’t restored",
        ),
      ).toBeNull(),
    );
  });
});
