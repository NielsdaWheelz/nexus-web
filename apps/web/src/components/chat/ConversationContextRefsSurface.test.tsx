import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import {
  consumePendingWorkspaceTargetActivationRequests,
  parseWorkspaceTargetActivationMessage,
  setWorkspaceTargetActivationReceiverReady,
  WORKSPACE_TARGET_ACTIVATION_EVENT,
  type WorkspaceTargetActivationIngressRequest,
} from "@/lib/workspace/workspaceTargetActivationIngress";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import type { ResourceActivation } from "@/lib/resources/activation";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import ConversationContextRefsSurface from "./ConversationContextRefsSurface";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

function contextRef(overrides: Partial<ContextRefOut> = {}): ContextRefOut {
  const activation: ResourceActivation = overrides.activation ?? {
    resourceRef: `media:${MEDIA_ID}`,
    kind: "route",
    href: `/media/${MEDIA_ID}`,
    unresolvedReason: null,
  };
  const contextRef = {
    id: "ref-1",
    conversation_id: "conv-1",
    resource_ref: `media:${MEDIA_ID}`,
    activation,
    label: "Annual report",
    summary: "Page 4",
    missing: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  return {
    ...contextRef,
    actionTarget: overrides.actionTarget ?? {
      kind: "Resource",
      ref: assumeCanonicalResourceRef(contextRef.resource_ref),
      activation: contextRef.activation,
      missing: contextRef.missing,
    },
  };
}

function renderWithShare(node: ReactNode) {
  return render(
    <ShareControllerProvider>{node}</ShareControllerProvider>,
  );
}

function renderSurface(
  props: Omit<
    ComponentProps<typeof ConversationContextRefsSurface>,
    "onOpenResource"
  > & {
    onOpenResource?: ComponentProps<
      typeof ConversationContextRefsSurface
    >["onOpenResource"];
  },
) {
  return renderWithShare(
      <ConversationContextRefsSurface
        {...props}
        onOpenResource={props.onOpenResource ?? (() => {})}
      />,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function contextRefWire(item = contextRef()) {
  return {
    id: item.id,
    conversation_id: item.conversation_id,
    resource_ref: item.resource_ref,
    activation: item.activation,
    label: item.label,
    summary: item.summary,
    missing: item.missing,
    created_at: item.created_at,
  };
}

function openedPanes() {
  const details: WorkspaceTargetActivationIngressRequest[] = [];
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      details.push(event.detail as WorkspaceTargetActivationIngressRequest);
    }
  };
  window.addEventListener(WORKSPACE_TARGET_ACTIVATION_EVENT, listener);
  const postMessage = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation((message) => {
      const detail = parseWorkspaceTargetActivationMessage(message);
      if (detail !== null) details.push(detail);
    });
  return {
    details,
    stop: () => {
      details.push(...consumePendingWorkspaceTargetActivationRequests());
      window.removeEventListener(WORKSPACE_TARGET_ACTIVATION_EVENT, listener);
      postMessage.mockRestore();
    },
  };
}

function ContextRefsOwner() {
  const owner = useConversationContextRefs(CONVERSATION_ID);
  return (
    <ConversationContextRefsSurface
      contextRefs={owner.contextRefs}
      removeContextRef={owner.removeContextRef}
      onOpenResource={() => {}}
    />
  );
}

afterEach(() => {
  setWorkspaceTargetActivationReceiverReady(false);
  consumePendingWorkspaceTargetActivationRequests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationContextRefsSurface", () => {
  it("renders a context ref label", () => {
    renderSurface({
      contextRefs: [contextRef()],
      removeContextRef: async () => {},
    });
    expect(screen.getByText("Annual report")).toBeVisible();
  });

  it("marks a missing context ref unavailable and omits resource core", async () => {
    const user = userEvent.setup();
    const onOpenResource = vi.fn();
    renderSurface({
      contextRefs: [contextRef({ missing: true })],
      removeContextRef: async () => {},
      onOpenResource,
    });

    expect(screen.getByText("Annual report")).toBeVisible();
    const primary = screen.getByRole("button", { name: "Annual report" });
    expect(primary).toBeDisabled();

    await user.click(primary);
    expect(onOpenResource).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: "Remove from conversation context",
      }),
    ).toBeVisible();
  });

  it("removes a context ref from the actions menu", async () => {
    const user = userEvent.setup();
    let finishRemoval = () => {};
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const removeContextRef = vi.fn(() => removal);
    renderSurface({
      contextRefs: [contextRef()],
      removeContextRef,
    });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      screen.getByRole("menuitem", {
        name: "Remove from conversation context",
      }),
    );
    expect(removeContextRef).toHaveBeenCalledWith("ref-1");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const removing = screen.getByRole("menuitem", { name: "Removing..." });
    expect(removing).toHaveAttribute("aria-disabled", "true");
    await user.click(removing);
    expect(removeContextRef).toHaveBeenCalledTimes(1);
    finishRemoval();
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Removing..." }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens a context ref from the body and actions menu", async () => {
    const user = userEvent.setup();
    const onOpenResource = vi.fn();
    renderSurface({
      contextRefs: [contextRef()],
      removeContextRef: async () => {},
      onOpenResource,
    });

    await user.click(screen.getByRole("button", { name: "Annual report" }));
    expect(onOpenResource).toHaveBeenCalledWith(
      expect.objectContaining({ resource_ref: `media:${MEDIA_ID}` }),
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open",
      "Share…",
      "Chat about this resource",
      "Remove from conversation context",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpenResource).toHaveBeenCalledTimes(2);
  });

  it("creates resource Chat with the canonical context and opens its conversation pane", async () => {
    const user = userEvent.setup();
    const resourceRef = `media:${MEDIA_ID}`;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: { id: CONVERSATION_ID } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setWorkspaceTargetActivationReceiverReady(true);
    const panes = openedPanes();

    try {
      renderSurface({
        contextRefs: [contextRef()],
        removeContextRef: async () => {},
      });
      await user.click(screen.getByRole("button", { name: "Actions" }));
      await user.click(
        screen.getByRole("menuitem", {
          name: "Chat about this resource",
        }),
      );

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/conversations",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              initial_context_refs: [resourceRef],
            }),
          }),
        ),
      );
      await waitFor(() =>
        expect(panes.details).toEqual([
          {
            target: { href: `/conversations/${CONVERSATION_ID}`, labelHint: "Chat" },
            disposition: { kind: "Adopt" },
            modality: "Programmatic",
          },
        ]),
      );
    } finally {
      panes.stop();
    }
  });

  it("opens the real Share presentation for the row's canonical Resource target", async () => {
    const user = userEvent.setup();
    const resourceRef = `page:${PAGE_ID}`;
    const item = contextRef({
      resource_ref: resourceRef,
      activation: {
        resourceRef,
        kind: "route",
        href: `/pages/${PAGE_ID}`,
        unresolvedReason: null,
      },
    });
    const sharePath = `/api/resource-items/${encodeURIComponent(resourceRef)}/shares`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path =
        input instanceof Request
          ? new URL(input.url).pathname
          : new URL(String(input), "http://localhost").pathname;
      if (path !== sharePath) {
        throw new Error(`Unexpected fetch: ${path}`);
      }
      return jsonResponse({
        data: {
          subject: resourceRef,
          sharing: "CopyOnly",
          authenticatedHref: `http://localhost:3000/pages/${PAGE_ID}`,
          creationAvailability: {
            user: {
              kind: "Unavailable",
              reason: "UnsupportedSubject",
            },
            link: {
              kind: "Unavailable",
              reason: "UnsupportedSubject",
            },
          },
          shares: [],
          receivedAccess: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSurface({
      contextRefs: [item],
      removeContextRef: async () => {},
    });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Share…" }));

    expect(
      await screen.findByRole("dialog", { name: "Share" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        sharePath,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeEnabled();
    expect(screen.getByText("page link")).toBeVisible();
  });

  it("removes a context row through the owning DELETE contract", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path =
          input instanceof Request
            ? new URL(input.url).pathname
            : new URL(String(input), "http://localhost").pathname;
        if (
          path ===
            `/api/conversations/${CONVERSATION_ID}/context-refs` &&
          (init?.method ?? "GET") === "GET"
        ) {
          return jsonResponse({
            data: [
              contextRefWire(
                contextRef({ conversation_id: CONVERSATION_ID }),
              ),
            ],
          });
        }
        if (
          path ===
            `/api/conversations/${CONVERSATION_ID}/context-refs/ref-1` &&
          init?.method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithShare(<ContextRefsOwner />);
    expect(await screen.findByText("Annual report")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      screen.getByRole("menuitem", {
        name: "Remove from conversation context",
      }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            String(input).includes(
              `/api/conversations/${CONVERSATION_ID}/context-refs/ref-1`,
            ) && init?.method === "DELETE",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByText("Annual report")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No context yet.")).toBeVisible();
  });

  it("shows the empty state with no context refs", () => {
    renderSurface({
      contextRefs: [],
      removeContextRef: async () => {},
    });
    expect(screen.getByText("No context yet.")).toBeVisible();
  });
});
