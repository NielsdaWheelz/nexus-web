import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import ChatComposerComponent from "./ChatComposer";

const PROFILES = {
  default_profile_id: "balanced",
  profiles: [
    {
      id: "balanced",
      label: "Balanced",
      description: "Everyday profile",
      provider_label: "Nexus AI",
      model_label: "Balanced model",
      reasoning_options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      default_reasoning_option_id: "medium",
      privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
    },
    {
      id: "fast",
      label: "Fast",
      description: "Fast profile",
      provider_label: "Nexus AI",
      model_label: "Fast model",
      reasoning_options: [{ id: "low", label: "Low" }],
      default_reasoning_option_id: "low",
      privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
    },
  ],
};

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

function installBff(chatBodies: ChatRunCreateRequest[]) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/llm-profiles") return json({ data: PROFILES });
      if (path === "/api/chat-runs" && init?.method === "POST") {
        chatBodies.push(JSON.parse(String(init.body)) as ChatRunCreateRequest);
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
    const chatBodies: ChatRunCreateRequest[] = [];
    installBff(chatBodies);
    const view = render(withRenderEnvironment(<Composer />));
    const model = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.selectOptions(model, "fast");
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();

    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(input);
    await userEvent.keyboard("First{Shift>}{Enter}{/Shift}Second{Enter}");
    await screen.findByRole("button", { name: "Retry send" });
    expect(
      chatBodies,
      "desktop Enter did not dispatch exactly one chat run",
    ).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      content: "First\nSecond",
      profile_id: "fast",
      reasoning_option_id: "low",
    });
    view.unmount();

    sessionStorage.clear();
    await page.viewport(390, 800);
    render(
      withRenderEnvironment(<Composer draftKey="mobile-enter-proof" />, {
        initialViewport: "mobile",
      }),
    );
    await screen.findByRole("combobox", { name: "Model" });
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

    expect(
      chatBodies,
      "mobile or IME Enter dispatched a chat run",
    ).toHaveLength(1);
    expect(mobileInput.value).toContain("Plain\nShift\nCtrl\nDone");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("keeps one action socket and coarse mobile controls inside 320px", async () => {
    const chatBodies: ChatRunCreateRequest[] = [];
    installBff(chatBodies);
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
    const model = await screen.findByRole("combobox", { name: "Model" });
    const effort = screen.getByRole("combobox", { name: "Effort" });
    const stop = screen.getByRole("button", { name: "Stop response" });
    const socketWidth = stop.getBoundingClientRect().width;

    expect(model.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(effort.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
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
    expect(chatBodies).toHaveLength(0);
  });
});
