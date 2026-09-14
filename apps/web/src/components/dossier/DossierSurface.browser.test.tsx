// Background run detail (spec 3.4, AC 15): a Codex-quota-parked Dossier build
// shows "Waiting for Codex capacity" with the existing Cancel, and the admitted
// selection/tool plan renders as read-only text. The BFF is stubbed at the
// fetch boundary with schema-valid head, stream-token, stream, and cancel
// responses; the store, decoders, view model, and surface are all real.
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import DossierSurface from "@/components/dossier/DossierSurface";
import {
  createDossierControllerStore,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";

const ARTIFACT_ID = "0f6a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const ARTIFACT_REF = `artifact:${ARTIFACT_ID}`;
const USER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const BUILD_HANDLE = "artifact-build-handle-1";
const HEAD_PATH = `/api/artifacts/${encodeURIComponent(ARTIFACT_REF)}`;
const CANCEL_PATH = `/api/artifact-builds/${BUILD_HANDLE}/cancel`;
const STREAM_PATH = `/stream/artifact-builds/${BUILD_HANDLE}/events`;
const ABSENT = { kind: "Absent" } as const;
const encoder = new TextEncoder();

function present<T>(value: T): { kind: "Present"; value: T } {
  return { kind: "Present", value };
}

const ADMITTED_GENERATION = {
  selection: { route: "CodexPersonal", model: "gpt-5.6-terra", reasoning: "high" },
  display_at_dispatch: {
    route_label: "Codex Personal",
    model_label: "GPT-5.6 Terra",
    reasoning_label: "High",
    billing: { kind: "Subscription", label: "Codex subscription" },
    privacy: {
      summary: "Processed by OpenAI under the Codex subscription.",
      retention: "Retained per the subscription agreement.",
      training: "Not used for training.",
    },
    processor_chain: { processors: ["Codex Personal"] },
  },
  tool_plan: {
    kind: "ExactModelTools",
    plan_id: "LibraryDossierRead",
    plan_revision: "b".repeat(64),
    effect_mode: "ReadOnly",
  },
  tool_positions: 3,
};

const CAPACITY_PAUSE = {
  kind: "CapacityPaused",
  code: "quota_unavailable",
  explanation: "Codex subscription capacity is exhausted.",
  reset_at: present("2026-09-05T14:00:00Z"),
  next_check_at: "2026-09-05T12:15:00Z",
  last_checked: "2026-09-05T12:00:00Z",
};

function head(activeBuild: unknown, latestUnsuccessfulBuild: unknown) {
  return {
    data: {
      artifact_id: present(ARTIFACT_ID),
      artifact_ref: present(ARTIFACT_REF),
      identity: present({ kind: "Idea", title: "Capacity-paused dossier" }),
      current_revision: ABSENT,
      freshness: ABSENT,
      active_build: activeBuild,
      latest_unsuccessful_build: latestUnsuccessfulBuild,
      revision_count: 0,
      media_abstract: ABSENT,
    },
  };
}

const PAUSED_HEAD = head(
  present({
    handle: BUILD_HANDLE,
    requester_user_id: present(USER_ID),
    instruction: ABSENT,
    created_at: "2026-09-05T11:59:00Z",
    execution: present({ phase: "Queued" }),
    failure: ABSENT,
    cancellation: ABSENT,
    admitted_generation: present(ADMITTED_GENERATION),
    capacity_pause: present(CAPACITY_PAUSE),
  }),
  ABSENT,
);

const CANCELLED_HEAD = head(
  ABSENT,
  present({
    handle: BUILD_HANDLE,
    requester_user_id: present(USER_ID),
    instruction: ABSENT,
    created_at: "2026-09-05T11:59:00Z",
    execution: ABSENT,
    failure: ABSENT,
    cancellation: present({ actor: present(USER_ID), at: "2026-09-05T12:05:00Z" }),
    admitted_generation: present(ADMITTED_GENERATION),
    capacity_pause: ABSENT,
  }),
);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.origin);
}

let store: DossierControllerStore | null = null;

afterEach(() => {
  store?.dispose();
  store = null;
  vi.unstubAllGlobals();
});

it("shows Waiting for Codex capacity with Cancel and the admitted selection read-only", async () => {
  let cancelled = false;
  const cancelRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/stream-token") {
        return json({
          data: {
            token: "stream-token-1",
            stream_base_url: "https://stream.nexus.test",
            expires_at: "2026-09-05T12:01:00Z",
          },
        });
      }
      if (url.pathname === HEAD_PATH) {
        return json(cancelled ? CANCELLED_HEAD : PAUSED_HEAD);
      }
      if (url.pathname === CANCEL_PATH && init?.method === "POST") {
        cancelled = true;
        cancelRequests.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === STREAM_PATH) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("retry: 0\n\n"));
            init?.signal?.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("Stream aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected Dossier request: ${url.pathname}`);
    },
  );

  store = createDossierControllerStore({ kind: "Artifact", artifactRef: ARTIFACT_REF });
  render(
    withRenderEnvironment(
      <DossierSurface store={store} onViewMediaEvidence={() => {}} onCitationActivate={() => {}} />,
    ),
  );

  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Codex capacity",
    );
  });
  expect(
    screen.getByText("Codex reports capacity returning at Sep 5, 2026, 2:00 PM."),
  ).toBeVisible();

  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: /Generate dossier|Regenerate|Retry/ }),
  ).toBeNull();

  const detail = screen.getByRole("note", { name: "Generation detail" });
  expect(detail).toHaveTextContent(
    "Codex Personal · GPT-5.6 Terra · High reasoning · Codex subscription · LibraryDossierRead (read-only) · 3 tool calls",
  );
  for (const role of ["button", "textbox", "combobox", "checkbox", "link"]) {
    expect(within(detail).queryAllByRole(role)).toHaveLength(0);
  }
  expect(detail.textContent).not.toMatch(/\$|price|cost|key|token/i);

  await userEvent.click(cancel);
  await waitFor(() => {
    expect(cancelRequests).toEqual([CANCEL_PATH]);
  });
  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent(
      "The last generation was canceled.",
    );
  });
  expect(screen.queryByText("Waiting for Codex capacity")).toBeNull();
  expect(screen.getByRole("note", { name: "Generation detail" })).toHaveTextContent(
    "GPT-5.6 Terra",
  );
});
