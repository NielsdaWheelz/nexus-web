import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Component,
  useEffect,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import type { ResourceActionReconciliationScope } from "@/lib/actions/resourceActionSnapshotCache";
import { ApiError } from "@/lib/api/client";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
  useResourceOverlaysController,
} from "@/lib/resources/resourceOverlaysController";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PODCAST_ID = "22222222-2222-4222-8222-222222222222";
const BACKFILL_ID = "33333333-3333-4333-8333-333333333333";

function statusData() {
  return {
    user_id: USER_ID,
    podcast_id: PODCAST_ID,
    default_playback_speed: { kind: "Present", value: 1.25 },
    pause_shortening_mode: { kind: "Present", value: "Natural" },
    auto_queue: true,
    sync_status: "Complete",
    sync_error_code: null,
    sync_error_message: null,
    sync_attempts: 1,
    sync_started_at: "2026-08-25T10:00:00Z",
    sync_completed_at: "2026-08-25T10:00:01Z",
    last_checked_at: "2026-08-25T10:00:01Z",
    updated_at: "2026-08-25T10:00:01Z",
    backfill: {
      id: BACKFILL_ID,
      state: "Complete",
      processed_count: 4,
      added_count: 3,
    },
  };
}

function settingsData() {
  const status = statusData();
  return {
    ...status,
    default_playback_speed: { kind: "Present", value: 1.5 },
    pause_shortening_mode: { kind: "Present", value: "Off" },
    auto_queue: false,
    backfill: {
      id: status.backfill.id,
      state: status.backfill.state,
      processedCount: status.backfill.processed_count,
      addedCount: status.backfill.added_count,
    },
    collectionRevision: 7,
    libraryEntriesCollectionRevision: 11,
  };
}

function createMutationBoundary() {
  let active = false;
  let commitCount = 0;
  const reconciliations: ResourceActionReconciliationScope[] = [];
  const boundary: ResourceActionMutationBoundary = {
    begin: () => {
      if (active) return null;
      active = true;
      return {
        reconcile: async (scope) => {
          reconciliations.push(scope);
        },
        commit: async () => {
          active = false;
          commitCount += 1;
        },
        abort: () => {
          active = false;
        },
      };
    },
    isActive: () => active,
  };
  return {
    boundary,
    reconciliations,
    commitCount: () => commitCount,
  };
}

function PodcastSettingsOwnerProbe({
  mutation,
}: {
  mutation: ResourceActionMutationBoundary;
}) {
  const { openPodcastSettings } = useResourceOverlaysController();
  useEffect(() => {
    openPodcastSettings(PODCAST_ID, mutation);
  }, [mutation, openPodcastSettings]);
  return <ResourceActionOverlays />;
}

class DefectBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly onDefect: (error: Error) => void;
  },
  { readonly error: Error | null }
> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <p role="alert">Podcast settings defect</p>
    );
  }
}

function renderPodcastSettings(input: {
  readonly mutation: ResourceActionMutationBoundary;
  readonly onDefect?: (error: Error) => void;
}) {
  return render(
    withRenderEnvironment(
      <FeedbackProvider>
        <LecternProvider>
          <GlobalPlayerProvider>
            <ResourceOverlaysProvider>
              <DefectBoundary onDefect={input.onDefect ?? (() => {})}>
                <PodcastSettingsOwnerProbe mutation={input.mutation} />
              </DefectBoundary>
            </ResourceOverlaysProvider>
          </GlobalPlayerProvider>
        </LecternProvider>
      </FeedbackProvider>,
    ),
  );
}

describe("Podcast settings resource overlay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("self-loads, owns one draft, and closes only after command reconciliation", async () => {
    const mutation = createMutationBoundary();
    const patchBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        const method = init?.method ?? "GET";
        if (
          url.pathname === `/api/podcasts/subscriptions/${PODCAST_ID}` &&
          method === "GET"
        ) {
          return Response.json({ data: statusData() });
        }
        if (
          url.pathname ===
            `/api/podcasts/subscriptions/${PODCAST_ID}/settings` &&
          method === "PATCH"
        ) {
          patchBodies.push(
            typeof init?.body === "string" ? JSON.parse(init.body) : null,
          );
          return Response.json({ data: settingsData() });
        }
        return Response.json({ data: null });
      }),
    );

    renderPodcastSettings({ mutation: mutation.boundary });

    const dialog = await screen.findByRole("dialog", {
      name: "Subscription settings",
    });
    expect(
      within(dialog).getByRole("slider", { name: "Default playback speed" }),
    ).toHaveValue("1.25");
    expect(
      within(dialog).getByRole("combobox", { name: "Shorten pauses" }),
    ).toHaveValue("Natural");
    const autoQueue = within(dialog).getByRole("checkbox", {
      name: "Automatically add new episodes to my queue",
    });
    expect(autoQueue).toBeChecked();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "1.5x" }),
    );
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Shorten pauses" }),
      "Off",
    );
    await userEvent.click(autoQueue);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Save subscription settings",
      }),
    );

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies).toEqual([
      {
        default_playback_speed: { kind: "Present", value: 1.5 },
        pause_shortening_mode: { kind: "Present", value: "Off" },
        auto_queue: false,
      },
    ]);
    await waitFor(() => expect(mutation.commitCount()).toBe(1));
    expect(mutation.reconciliations).toEqual([
      { kind: "Subjects", refs: [`podcast:${PODCAST_ID}`] },
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Subscription settings" }),
      ).toBeNull(),
    );
  });

  it("keeps the editor open with specific recovery after an expected save failure", async () => {
    const mutation = createMutationBoundary();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        const method = init?.method ?? "GET";
        if (
          url.pathname === `/api/podcasts/subscriptions/${PODCAST_ID}` &&
          method === "GET"
        ) {
          return Response.json({ data: statusData() });
        }
        if (
          url.pathname ===
            `/api/podcasts/subscriptions/${PODCAST_ID}/settings` &&
          method === "PATCH"
        ) {
          return Response.json(
            {
              error: {
                code: "E_RATE_LIMITED",
                message: "Settings capacity exhausted",
                request_id: "request-podcast-settings",
              },
            },
            { status: 429 },
          );
        }
        return Response.json({ data: null });
      }),
    );

    renderPodcastSettings({ mutation: mutation.boundary });
    const dialog = await screen.findByRole("dialog", {
      name: "Subscription settings",
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Save subscription settings",
      }),
    );

    await within(dialog).findByText("Subscription settings weren’t saved");
    expect(within(dialog).getByText("Wait a moment, then retry.")).toBeVisible();
    expect(mutation.commitCount()).toBe(0);
    expect(mutation.boundary.isActive()).toBe(false);
    expect(
      within(dialog).getByRole("button", {
        name: "Save subscription settings",
      }),
    ).toBeEnabled();
  });

  it("propagates a malformed same-system source instead of masking it as load feedback", async () => {
    const defects: Error[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === `/api/podcasts/subscriptions/${PODCAST_ID}`) {
          return Response.json({
            data: { ...statusData(), compatibility: true },
          });
        }
        return Response.json({ data: null });
      }),
    );

    renderPodcastSettings({
      mutation: createMutationBoundary().boundary,
      onDefect: (error) => defects.push(error),
    });

    await screen.findByRole("alert", { name: "" });
    await waitFor(() => expect(defects).toHaveLength(1));
    expect(defects[0]).toBeInstanceOf(ApiError);
    expect((defects[0] as ApiError).code).toBe("E_INVALID_RESPONSE");
    expect(screen.queryByText("Subscription settings couldn’t be loaded")).toBeNull();
  });
});
