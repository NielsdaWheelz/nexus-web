import { Component, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { useLinkComposer } from "./useLinkComposer";

// This suite renders the REAL FeedbackProvider around the composer and stubs only
// the fetch transport boundary, so createLink/deleteLink exercise the real
// `apiFetch` ApiError taxonomy (E_NETWORK from a rejected fetch, E_NOT_FOUND /
// unknown codes from real error envelopes) and feedback is asserted on the real
// user-visible DOM (the "HUD feedback" / "Persistent feedback" regions), not on a
// mocked `publish`.

const LINKS_PATH = "/api/resource-graph/links";
const SOURCE_MEDIA = "11111111-1111-4111-8111-111111111111";
const TARGET_MEDIA = "22222222-2222-4222-8222-222222222222";

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** A minimal but schema-valid `ConnectionActionEndpointOut` wire endpoint. */
function wireEndpoint(ref: string, label: string) {
  const [scheme, id] = ref.split(":");
  const href = `/${scheme}/${id}`;
  return {
    ref,
    scheme,
    id,
    label,
    description: null,
    activation: {
      resource_ref: ref,
      kind: "route",
      href,
      unresolved_reason: null,
    },
    href,
    missing: false,
  };
}

/** A schema-valid `CreateLinkOut` wire body the real `createLink` decoder accepts. */
function wireCreateLinkOut({
  created,
  edgeId,
}: {
  created: boolean;
  edgeId: string;
}) {
  const sourceRef = `media:${SOURCE_MEDIA}`;
  const targetRef = `media:${TARGET_MEDIA}`;
  const target = wireEndpoint(targetRef, "Target");
  return {
    created,
    created_source_ref: null,
    connection: {
      edge_id: edgeId,
      direction: "undirected",
      kind: "context",
      origin: "user",
      snapshot: null,
      source_order_key: null,
      target_order_key: null,
      ordinal: null,
      source_ref: sourceRef,
      target_ref: targetRef,
      source: wireEndpoint(sourceRef, "Source"),
      target,
      other: target,
      citation: null,
      link_note: null,
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}

const hudRegion = () => screen.getByRole("region", { name: "HUD feedback" });
const persistentRegion = () =>
  screen.getByRole("region", { name: "Persistent feedback" });

/** Every visual feedback article across both detached lanes (announcers excluded). */
function detachedFeedbackTitles(matcher: string | RegExp): HTMLElement[] {
  return [hudRegion(), persistentRegion()].flatMap((region) =>
    within(region).queryAllByText(matcher),
  );
}

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
      <output aria-label="link boundary">{this.state.error.message}</output>
    ) : (
      this.props.children
    );
  }
}

function Probe() {
  const composer = useLinkComposer({ onLinked: vi.fn() });
  return (
    <>
      <button
        onClick={() =>
          composer.openLink({
            source: { kind: "resource", ref: `media:${SOURCE_MEDIA}` },
            sourceRef: `media:${SOURCE_MEDIA}`,
          })
        }
      >
        Open Link
      </button>
      <button
        onClick={() =>
          void composer.confirm(
            { kind: "resource", ref: `media:${TARGET_MEDIA}` },
            "Target",
          )
        }
      >
        Confirm Link
      </button>
      {composer.failure ? (
        <div role="alert" aria-label="link composer failure">
          {composer.failure.content.title}
          <button onClick={composer.failure.actions[0].onClick}>
            {composer.failure.actions[0].label}
          </button>
        </div>
      ) : null}
    </>
  );
}

function renderProbe(withBoundary = false) {
  const probe = withBoundary ? (
    <TestBoundary>
      <Probe />
    </TestBoundary>
  ) : (
    <Probe />
  );
  return render(<FeedbackProvider>{probe}</FeedbackProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLinkComposer defect routing", () => {
  it("keeps a modeled create failure local with an exact Retry and detaches nothing", async () => {
    stubFetch(async (input, init) => {
      if (fetchInputPath(input) === LINKS_PATH && init?.method === "POST") {
        // A rejected fetch is the only network failure: the real client maps it
        // to ApiError E_NETWORK.
        throw new TypeError("Failed to fetch");
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    renderProbe();
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

    // The uncertain create outcome stays inside the open Link surface with its
    // exact Retry.
    const failure = await screen.findByRole("alert", {
      name: "link composer failure",
    });
    expect(failure).toHaveTextContent("Link outcome not confirmed");
    expect(
      within(failure).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();

    // A modeled create failure never detaches to a HUD or the persistent rail.
    expect(detachedFeedbackTitles(/Link outcome not confirmed/)).toHaveLength(0);
    expect(within(hudRegion()).queryByRole("article")).toBeNull();
    expect(within(persistentRegion()).queryByRole("article")).toBeNull();
  });

  it("replays create Retry with the frozen client mutation id", async () => {
    const bodies: { client_mutation_id?: string }[] = [];
    let attempt = 0;
    stubFetch(async (input, init) => {
      if (fetchInputPath(input) === LINKS_PATH && init?.method === "POST") {
        bodies.push(
          JSON.parse(String(init.body)) as { client_mutation_id?: string },
        );
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return jsonResponse({
          data: wireCreateLinkOut({ created: false, edgeId: "edge-1" }),
        });
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    renderProbe();
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

    await screen.findByRole("alert", { name: "link composer failure" });
    expect(bodies).toHaveLength(1);
    const firstMutationId = bodies[0].client_mutation_id;
    expect(firstMutationId).toMatch(/^link-/);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Retry replays the SAME frozen client_mutation_id so the write is idempotent.
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].client_mutation_id).toBe(firstMutationId);
  });

  it("keeps an uncertain Undo durable and treats not-found on Retry as resolved", async () => {
    let deleteCalls = 0;
    stubFetch(async (input, init) => {
      const path = fetchInputPath(input);
      const method = init?.method ?? "GET";
      if (path === LINKS_PATH && method === "POST") {
        return jsonResponse({
          data: wireCreateLinkOut({ created: true, edgeId: "edge-1" }),
        });
      }
      if (path === `${LINKS_PATH}/edge-1` && method === "DELETE") {
        deleteCalls += 1;
        // First removal is lost in the network (uncertain); the retry finds the
        // link already gone (E_NOT_FOUND), which the composer treats as resolved.
        if (deleteCalls === 1) throw new TypeError("Failed to fetch");
        return errorResponse(404, "E_NOT_FOUND", "already absent");
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });

    renderProbe();
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

    // Success detaches a HUD offering Undo.
    const undoButton = await within(hudRegion()).findByRole("button", {
      name: "Undo",
    });
    expect(within(hudRegion()).getByText("Linked to Target")).toBeInTheDocument();
    fireEvent.click(undoButton);

    // An uncertain removal keeps a durable persistent record with its own Retry.
    expect(
      await within(persistentRegion()).findByText(
        "Removal outcome not confirmed",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(persistentRegion()).getByRole("button", { name: "Retry" }),
    );

    // Retry that finds the link already gone resolves the durable record.
    await waitFor(() =>
      expect(
        within(persistentRegion()).queryByText("Removal outcome not confirmed"),
      ).toBeNull(),
    );
    expect(deleteCalls).toBe(2);
  });

  it("captures an unknown endpoint code and throws it into the boundary without detaching feedback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(async (input, init) => {
      if (fetchInputPath(input) === LINKS_PATH && init?.method === "POST") {
        return errorResponse(409, "E_NEW_LINK_FAILURE", "unknown link failure");
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    try {
      renderProbe(true);
      fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

      await waitFor(() =>
        expect(screen.getByLabelText("link boundary")).toHaveTextContent(
          "unknown link failure",
        ),
      );
      // A render-thrown defect must never have published user feedback.
      expect(within(hudRegion()).queryByRole("article")).toBeNull();
      expect(within(persistentRegion()).queryByRole("article")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});
