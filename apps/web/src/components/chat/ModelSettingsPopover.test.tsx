import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import ModelSettingsPopover from "@/components/chat/ModelSettingsPopover";
import type { UseChatModels } from "@/components/chat/useChatModels";
import type { ConversationModel } from "@/lib/conversations/types";

const MODEL: ConversationModel = {
  id: "anthropic/claude",
  provider: "anthropic",
  provider_display_name: "Anthropic",
  model_name: "claude",
  model_display_name: "Claude",
  model_tier: "sota",
  reasoning_modes: ["default", "high"],
  max_context_tokens: 200_000,
  available_via: "platform",
};

const MODELS: UseChatModels = {
  availableModels: [MODEL],
  selectedModel: MODEL,
  selectedProvider: "anthropic",
  selectedModelId: MODEL.id,
  selectedReasoning: "default",
  providerOptions: ["anthropic"],
  reasoningOptions: ["default", "high"],
  modelSummary: "Claude / Default",
  setProvider: () => {},
  setModel: () => {},
  setReasoning: () => {},
};

function Harness() {
  const [open, setOpen] = useState(false);
  const [onlyUseMyKeys, setOnlyUseMyKeys] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <ModelSettingsPopover
      open={open}
      setOpen={setOpen}
      models={MODELS}
      onlyUseMyKeys={onlyUseMyKeys}
      setOnlyUseMyKeys={setOnlyUseMyKeys}
      disabled={false}
      buttonRef={buttonRef}
    />
  );
}

const renderPopover = (viewport: "desktop" | "mobile") =>
  render(withRenderEnvironment(<Harness />, { initialViewport: viewport }));

const trigger = () =>
  screen.getByRole("button", { name: "Model settings: Claude / Default" });
const dialog = () => screen.getByRole("dialog", { name: "Model settings" });
const dialogGone = () =>
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

// The synthetic-entry pop is deferred to a microtask (useHistoryDismiss); flush it.
const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("ModelSettingsPopover", () => {
  // Model history.state locally (MobileSheet.test.tsx pattern) so the mobile
  // sheet's history wiring never mutates the real test-runner history stack.
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  describe("desktop popover", () => {
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 1280); // desktop surface drives useIsMobileViewport=false
    });

    it("opens from the trigger and closes on outside pointerdown", () => {
      renderPopover("desktop");
      fireEvent.click(trigger());
      expect(dialog()).toBeVisible();
      expect(trigger()).toHaveAttribute("aria-expanded", "true");

      fireEvent.pointerDown(dialog());
      expect(dialog()).toBeVisible();

      fireEvent.pointerDown(document.body);
      dialogGone();
      expect(trigger()).toHaveAttribute("aria-expanded", "false");
    });

    it("closes on Escape", () => {
      renderPopover("desktop");
      fireEvent.click(trigger());
      expect(dialog()).toBeVisible();

      fireEvent.keyDown(document, { key: "Escape" });
      dialogGone();
    });
  });

  describe("mobile sheet", () => {
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 390); // mobile viewport drives useIsMobileViewport=true
    });

    it("opens as a modal dialog, locks body overflow, and restores it on close", async () => {
      renderPopover("mobile");
      fireEvent.click(trigger());
      expect(dialog()).toHaveAttribute("aria-modal", "true");
      await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

      fireEvent.click(screen.getByRole("button", { name: "Close model settings" }));
      dialogGone();
      expect(document.body.style.overflow).toBe("");
    });

    it("closes on Escape", () => {
      renderPopover("mobile");
      fireEvent.click(trigger());
      expect(dialog()).toBeVisible();

      fireEvent.keyDown(document, { key: "Escape" });
      dialogGone();
    });

    it("backdrop tap dismisses; panel tap does not", () => {
      renderPopover("mobile");
      fireEvent.click(trigger());

      fireEvent.click(dialog());
      expect(dialog()).toBeVisible();

      // eslint-disable-next-line testing-library/no-node-access -- the backdrop is presentational (no role/label); it is the panel's parent layer
      fireEvent.click(dialog().parentElement!);
      dialogGone();
    });

    it("browser back (popstate) dismisses without popping history again", async () => {
      renderPopover("mobile");
      fireEvent.click(trigger());
      expect(history.pushState).toHaveBeenCalledTimes(1);

      act(() => window.dispatchEvent(new PopStateEvent("popstate")));
      await flushMicrotasks();

      dialogGone();
      expect(history.back).not.toHaveBeenCalled();
    });
  });
});
