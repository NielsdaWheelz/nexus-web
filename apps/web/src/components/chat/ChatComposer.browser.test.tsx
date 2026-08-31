import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ComponentProps, type ReactNode } from "react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import { ApiError } from "@/lib/api/client";
import type { ChatDraftKey } from "@/lib/conversations/chatDraftKey";
import type { PaneVisitId } from "@/lib/workspace/schema";
import ChatComposerComponent from "./ChatComposer";

const PROFILES = {
  default_profile_id: "balanced",
  profiles: [
    {
      id: "fast",
      label: "Fast",
      description: "Quick responses for everyday questions.",
      model_label: "GPT-5.6 Luna",
      effort_label: "Low",
    },
    {
      id: "balanced",
      label: "Balanced",
      description: "The default profile: strong general-purpose reasoning.",
      model_label: "GPT-5.6 Terra",
      effort_label: "Medium",
    },
    {
      id: "deep",
      label: "Deep",
      description: "Slower, deeper reasoning for hard problems.",
      model_label: "GPT-5.6 Sol",
      effort_label: "High",
    },
  ],
};

interface ChatRunCall {
  body: ChatRunCreateRequest;
  key: string;
}

class DraftDefectBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p role="alert">Persisted draft rejected</p>
    ) : (
      this.props.children
    );
  }
}

const pathKey = (targetId: string): ChatDraftKey => ({
  kind: "Path",
  targetId,
});
const newConversationKey = (visitId: string): ChatDraftKey => ({
  kind: "NewConversation",
  visitId: visitId as unknown as PaneVisitId,
});

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin).pathname;
}

// The BFF is stubbed at the fetch boundary: profiles resolve, and every chat-run
// POST records its exact request + idempotency key, then throws a synthetic
// network loss to drive the reconciliation ("Retry send") path.
function installBff(calls: ChatRunCall[]) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/llm-profiles") return json({ data: PROFILES });
      if (path === "/api/chat-runs" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        calls.push({
          body: JSON.parse(String(init.body)) as ChatRunCreateRequest,
          key: headers.get("Idempotency-Key") ?? "",
        });
        throw new TypeError("synthetic ambiguous browser boundary");
      }
      throw new Error(`Unexpected composer BFF request: ${path}`);
    },
  );
}

function Composer(
  props: Partial<ComponentProps<typeof ChatComposerComponent>> = {},
) {
  return (
    <ChatComposerComponent
      conversationId="00000000-0000-4000-8000-000000000001"
      draftKey={pathKey("00000000-0000-4000-8000-000000000001")}
      inheritedProfileSelection={null}
      sendCapability={{ kind: "Available" }}
      {...props}
    />
  );
}

describe("ChatComposer browser contract", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await page.viewport(1_024, 768);
  });

  afterEach(async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    sessionStorage.clear();
    vi.unstubAllGlobals();
    await page.viewport(1_024, 768);
  });

  it("sends one exact desktop selection while mobile and IME Enter remain text", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    const view = render(withRenderEnvironment(<Composer />));
    const deep = await screen.findByRole("radio", { name: /Deep/ });
    await userEvent.click(deep);
    expect(deep).toBeChecked();

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(input);
    await userEvent.keyboard("First{Shift>}{Enter}{/Shift}Second{Enter}");
    await screen.findByRole("button", { name: "Retry send" });
    expect(
      calls,
      "desktop Enter did not dispatch exactly one chat run",
    ).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      content: "First\nSecond",
      profile_id: "deep",
    });
    view.unmount();

    sessionStorage.clear();
    await page.viewport(390, 800);
    render(
      withRenderEnvironment(
        <Composer draftKey={pathKey("mobile-enter-proof")} />,
        { initialViewport: "mobile" },
      ),
    );
    await screen.findByRole("radio", { name: /Fast/ });
    const mobileInput = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(mobileInput);
    await userEvent.keyboard(
      "Plain{Enter}Shift{Shift>}{Enter}{/Shift}Ctrl{Control>}{Enter}{/Control}Done",
    );
    fireEvent.compositionStart(mobileInput);
    fireEvent.keyDown(mobileInput, { key: "Enter" });
    fireEvent.compositionEnd(mobileInput);
    fireEvent.keyDown(mobileInput, { key: "Enter", isComposing: true });
    fireEvent.keyDown(mobileInput, { key: "Enter", keyCode: 229 });

    expect(calls, "mobile or IME Enter dispatched a chat run").toHaveLength(1);
    expect(mobileInput.value).toContain("Plain\nShift\nCtrl\nDone");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("restores a persisted draft after the hydrated browser boundary", async () => {
    const draftKey = newConversationKey("hydration-draft-proof");
    const view = render(
      withRenderEnvironment(
        <Composer conversationId={null} draftKey={draftKey} />,
      ),
    );
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.type(input, "draft survives hydration");
    expect(input.value).toBe("draft survives hydration");
    view.unmount();

    render(
      withRenderEnvironment(
        <Composer conversationId={null} draftKey={draftKey} />,
      ),
    );
    const restored = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await waitFor(() =>
      expect(restored.value).toBe("draft survives hydration"),
    );
  });

  it("keeps a locked reconciliation intact when a re-key and a new initialContent land in one commit", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    const lockedKey = pathKey("00000000-0000-4000-8000-00000000000b");
    const lockedStorageKey = "nx_chat_draft.v2:path:00000000-0000-4000-8000-00000000000b";
    const persisted = {
      text: "in-flight message",
      profile: null,
      operation: {
        kind: "ReconcileRequired",
        command: {
          idempotencyKey: "locked-command-key",
          request: {
            destination: {
              kind: "Existing",
              conversation_id: "00000000-0000-4000-8000-00000000000b",
              insertion: {
                kind: "Reply",
                parent_message_id: "00000000-0000-4000-8000-00000000000c",
                branch_anchor: {
                  kind: "assistant_message",
                  message_id: "00000000-0000-4000-8000-00000000000c",
                },
              },
            },
            content: "in-flight message",
            profile_id: "balanced",
            reader_selection: { kind: "Absent" },
          },
        },
      },
    };
    sessionStorage.setItem(lockedStorageKey, JSON.stringify(persisted));

    const view = render(
      withRenderEnvironment(
        <Composer
          draftKey={pathKey("00000000-0000-4000-8000-00000000000a")}
          initialContent=""
        />,
      ),
    );
    await screen.findByRole("textbox", { name: "Ask anything" });

    // One commit changes both the draft key and the seeded initialContent
    // (quote-to-chat navigation shape). The locked ReconcileRequired command
    // must survive: the seed may never overwrite a locked reconciliation.
    view.rerender(
      withRenderEnvironment(
        <Composer draftKey={lockedKey} initialContent="quoted passage" />,
      ),
    );

    await screen.findByRole("button", { name: "Retry send" });
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Ask anything",
      }).value,
    ).toBe("in-flight message");
    const stored = JSON.parse(
      sessionStorage.getItem(lockedStorageKey) ?? "null",
    ) as typeof persisted | null;
    expect(
      stored?.operation,
      "re-key + initialContent race destroyed the in-flight send command",
    ).toEqual(persisted.operation);
  });

  it("surfaces a widened persisted v2 request as a browser defect", async () => {
    const draftKey = newConversationKey(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    );
    sessionStorage.setItem(
      "nx_chat_draft.v2:new:3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      JSON.stringify({
        text: "do not silently replay this",
        profile: { profileId: "fast" },
        operation: {
          kind: "ReconcileRequired",
          command: {
            idempotencyKey: "selector-smuggling-key",
            request: {
              destination: { kind: "New" },
              content: "do not silently replay this",
              profile_id: "fast",
              reasoning_option_id: "high",
              reader_selection: { kind: "Absent" },
            },
          },
        },
      }),
    );

    render(
      withRenderEnvironment(
        <DraftDefectBoundary>
          <Composer conversationId={null} draftKey={draftKey} />
        </DraftDefectBoundary>,
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Persisted draft rejected",
    );
    expect(screen.queryByRole("button", { name: "Retry send" })).toBeNull();
  });

  it("reloads an in-flight new-chat send as a locked Retry that replays the exact key and request", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    const draftKey = newConversationKey(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );

    const view = render(
      withRenderEnvironment(
        <Composer conversationId={null} draftKey={draftKey} />,
      ),
    );
    await userEvent.click(await screen.findByRole("radio", { name: /Deep/ }));
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(input);
    await userEvent.keyboard("summarize this{Enter}");
    await screen.findByRole("button", { name: "Retry send" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.destination).toEqual({ kind: "New" });
    expect(calls[0].body).toMatchObject({
      profile_id: "deep",
    });

    // Simulate a full reload: unmount and remount a FRESH composer on the same
    // pane-visit draft key. The persisted in-flight command restores as a locked
    // Retry send with the draft text preserved (AC-4/AC-5).
    view.unmount();
    render(
      withRenderEnvironment(
        <Composer conversationId={null} draftKey={draftKey} />,
      ),
    );
    const retry = await screen.findByRole("button", { name: "Retry send" });
    const reloadedInput = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    expect(reloadedInput.value).toBe("summarize this");
    expect(reloadedInput).toBeDisabled();

    await userEvent.click(retry);
    await waitFor(() => expect(calls).toHaveLength(2));
    // AC-4/AC-6: byte-for-byte the same request and the same idempotency key.
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[1].key).toBe(calls[0].key);
    expect(calls[1].key).not.toBe("");
  });

  it("keeps one action socket and coarse mobile controls inside 320px", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "any-pointer", value: "coarse" }],
    });
    await cdp().send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await page.viewport(320, 720);
    let cancelCalls = 0;
    let releaseCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    render(
      withRenderEnvironment(
        <div style={{ width: 320 }}>
          <Composer
            activeRunId="00000000-0000-4000-8000-000000000002"
            onCancelRun={() => {
              cancelCalls += 1;
              return cancellation;
            }}
          />
        </div>,
        { initialViewport: "mobile" },
      ),
    );
    const fast = await screen.findByRole("radio", { name: /Fast/ });
    const stop = screen.getByRole("button", { name: "Stop response" });
    const socketWidth = stop.getBoundingClientRect().width;

    expect(fast.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(stop.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    await userEvent.click(stop);
    const stopping = await screen.findByRole("button", {
      name: "Stopping response",
    });
    expect(stopping.getBoundingClientRect().width).toBe(socketWidth);
    expect(cancelCalls).toBe(1);
    releaseCancellation?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop response" })).toBeVisible(),
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces a scoped cancellation transport failure", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    render(
      withRenderEnvironment(
        <Composer
          activeRunId="00000000-0000-4000-8000-000000000002"
          onCancelRun={() =>
            Promise.reject(
              new ApiError(0, "E_NETWORK", "Synthetic cancellation loss"),
            )
          }
        />,
      ),
    );

    await screen.findByRole("radio", { name: /Fast/ });
    await userEvent.click(
      screen.getByRole("button", { name: "Stop response" }),
    );
    expect(
      await screen.findByText("This response couldn’t be stopped."),
    ).toBeVisible();
    expect(screen.getByText("Check your connection and try again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeEnabled();
  });
});
