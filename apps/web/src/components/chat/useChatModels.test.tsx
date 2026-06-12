import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationModel } from "@/lib/conversations/types";
import {
  __resetChatModelsCacheForTests,
  getModelSourceLabel,
  invalidateChatModelsCache,
  useChatModels,
} from "./useChatModels";

function model(overrides: Partial<ConversationModel> = {}): ConversationModel {
  return {
    id: "openai/gpt-test",
    provider: "openai",
    provider_display_name: "OpenAI",
    model_name: "gpt-test",
    model_display_name: "GPT Test",
    model_tier: "light",
    reasoning_modes: ["default", "medium"],
    max_context_tokens: 128_000,
    available_via: "platform",
    provider_rank: 0,
    model_rank: 0,
    is_default: false,
    available_key_modes: ["auto", "platform_only"],
    capabilities: {
      prompt_cache: {
        mode: "keyed_ttl",
        supported: true,
        key_required: true,
        ttl_options: ["5m", "1h"],
      },
      streaming: true,
      tool_calling: true,
      structured_output: true,
      structured_output_streaming: false,
      reasoning_continuation: true,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

describe("useChatModels", () => {
  afterEach(() => {
    __resetChatModelsCacheForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a failed model load terminal across remounts", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse(
          { error: { code: "E_INTERNAL", message: "Models unavailable" } },
          500,
        );
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() =>
      useChatModels(),
    );
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    unmount();

    renderHook(() => useChatModels());
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(2));

    expect(
      fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/models"),
    ).toHaveLength(1);
  });

  it("selects the server-marked default model", async () => {
    const defaultModel = model({
      id: "anthropic/claude-default",
      provider: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "claude-default",
      model_display_name: "Claude Default",
      is_default: true,
      provider_rank: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [model(), defaultModel] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() =>
      useChatModels(),
    );

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(defaultModel.id),
    );
    expect(result.current.selectedProvider).toBe("anthropic");
    expect(result.current.selectedReasoning).toBe("default");
  });

  it("does not synthesize a default from the first returned model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [model()] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() =>
      useChatModels(),
    );

    await waitFor(() => expect(result.current.availableModels).toHaveLength(1));
    expect(result.current.selectedModel).toBeUndefined();
    expect(result.current.selectedProvider).toBe("");
    expect(result.current.selectedModelId).toBe("");
  });

  it("filters providers and models by the selected key mode", async () => {
    const platformModel = model({
      id: "openai/platform",
      is_default: true,
      available_key_modes: ["auto", "platform_only"],
    });
    const byokModel = model({
      id: "anthropic/byok",
      provider: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "byok",
      model_display_name: "BYOK",
      available_via: "byok",
      provider_rank: 1,
      is_default: true,
      available_key_modes: ["auto", "byok_only"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [platformModel, byokModel] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() => useChatModels());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(platformModel.id),
    );
    expect(result.current.keyModeOptions).toEqual([
      "auto",
      "byok_only",
      "platform_only",
    ]);

    act(() => result.current.setKeyMode("byok_only"));

    expect(result.current.availableModels).toEqual([byokModel]);
    expect(result.current.providerOptions).toEqual(["anthropic"]);
    expect(result.current.selectedModel).toEqual(byokModel);
    expect(result.current.selectedProvider).toBe("anthropic");
    expect(result.current.selectedModelId).toBe(byokModel.id);
  });

  it("refetches the server model contract after cache invalidation", async () => {
    const firstModel = model({ id: "openai/first", is_default: true });
    const secondModel = model({
      id: "anthropic/second",
      provider: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "second",
      model_display_name: "Second",
      available_via: "byok",
      available_key_modes: ["auto", "byok_only"],
      is_default: true,
    });
    let responseVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse({
          data: responseVersion === 0 ? [firstModel] : [secondModel],
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChatModels());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(firstModel.id),
    );

    responseVersion = 1;
    act(() => invalidateChatModelsCache());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(secondModel.id),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/models"),
    ).toHaveLength(2);
    expect(result.current.keyModeOptions).toEqual(["auto", "byok_only"]);
  });

  it("selects the provider's server-marked default model when switching providers", async () => {
    const openAiDefault = model({ id: "openai/default", is_default: true });
    const anthropicModel = model({
      id: "anthropic/first",
      provider: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "first",
      model_display_name: "Anthropic First",
      reasoning_modes: ["default", "high"],
      provider_rank: 1,
      is_default: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [openAiDefault, anthropicModel] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() => useChatModels());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(openAiDefault.id),
    );

    act(() => result.current.setProvider("anthropic"));

    expect(result.current.selectedProvider).toBe("anthropic");
    expect(result.current.selectedModelId).toBe(anthropicModel.id);
    expect(result.current.selectedReasoning).toBe("default");
  });

  it("does not synthesize a provider default when switching providers", async () => {
    const openAiDefault = model({ id: "openai/default", is_default: true });
    const anthropicModel = model({
      id: "anthropic/first",
      provider: "anthropic",
      provider_display_name: "Anthropic",
      model_name: "first",
      model_display_name: "Anthropic First",
      reasoning_modes: ["default", "high"],
      provider_rank: 1,
      is_default: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [openAiDefault, anthropicModel] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() => useChatModels());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(openAiDefault.id),
    );

    act(() => result.current.setProvider("anthropic"));

    expect(result.current.selectedProvider).toBe("anthropic");
    expect(result.current.selectedModel).toBeUndefined();
    expect(result.current.selectedModelId).toBe("");
  });

  it("labels model source by selected key mode", () => {
    const both = model({
      available_via: "both",
      available_key_modes: ["auto", "byok_only", "platform_only"],
    });

    expect(getModelSourceLabel(both, "auto")).toBe("Your key first");
    expect(getModelSourceLabel(both, "byok_only")).toBe("Your key");
    expect(getModelSourceLabel(both, "platform_only")).toBe("Nexus AI");
  });

  it("ignores reasoning modes that the selected model did not advertise", async () => {
    const selected = model({
      id: "openai/default",
      is_default: true,
      reasoning_modes: ["default", "medium"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return jsonResponse({ data: [selected] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result } = renderHook(() => useChatModels());

    await waitFor(() =>
      expect(result.current.selectedModelId).toBe(selected.id),
    );

    act(() => result.current.setReasoning("max"));
    expect(result.current.selectedReasoning).toBe("default");

    act(() => result.current.setReasoning("medium"));
    expect(result.current.selectedReasoning).toBe("medium");
  });
});
