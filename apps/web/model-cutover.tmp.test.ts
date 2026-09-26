// @ts-nocheck -- disposable bun proof; removed after live qualification.
import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "../../node/ingest/node_modules/jsdom/lib/api.js";
import GenerationSelectionPicker from "./src/components/chat/GenerationSelectionPicker";
import { useChatDraft } from "./src/components/chat/useChatDraft";
import {
  decodeGenerationCatalogResponse,
  decodeGenerationSelectionSpec,
  type GenerationCatalog,
} from "./src/lib/conversations/generationCatalog";
import {
  changeGenerationModel,
  routeForSelection,
  selectionUnavailabilityMessage,
} from "./src/lib/conversations/generationSelection";
import {
  CHAT_DRAFT_STORAGE_PREFIX,
  chatDraftStorageKeyForView,
  readRecoveredChatDrafts,
  recoverPreviousChatDrafts,
} from "./src/lib/conversations/chatDraftStore";

test("accepts a complete opaque provider thinking key", () => {
  expect(decodeGenerationSelectionSpec({
    route: "ProviderApi",
    model_ref: "openai:gpt-6-sol",
    reasoning: "pro/high",
  })).toEqual({
    route: "ProviderApi",
    model_ref: "openai:gpt-6-sol",
    reasoning: "pro/high",
  });
  expect(() => decodeGenerationSelectionSpec({
    route: "ProviderApi",
    model_ref: "openai:gpt-6-sol",
    reasoning: "pro/high\n",
  })).toThrow();
});

const route = { kind: "ProviderApi", provider: "openai" } as const;
function catalog(defaultKey: "Present" | "Absent"): GenerationCatalog {
  return {
    definition_revision: "a".repeat(64),
    observed_at: "2026-09-25T00:00:00Z",
    chat_seed: {
      policy_revision: "current",
      selection: {
        route: "ProviderApi", model_ref: "openai:gpt-6-sol", reasoning: "pro/high",
      },
      state: { kind: "Selectable" },
      presentation: {
        route_label: "openai",
        model_label: "gpt-6-sol",
        reasoning_label: "pro · high",
        billing: { kind: "MeteredApi", label: "Metered API" },
        privacy: { summary: "s", retention: "r", training: "t" },
        processor_chain: { processors: ["openai"] },
      },
    },
    routes: [{
      route,
      label: "openai",
      readiness: { kind: "Ready", last_checked: "2026-09-25T00:00:00Z" },
      billing: { kind: "MeteredApi", label: "Metered API" },
      privacy: { summary: "s", retention: "r", training: "t" },
      processor_chain: { processors: ["openai"] },
      models: [{
        key: "openai:gpt-6-sol",
        label: "gpt-6-sol",
        description: "test",
        source_context_window: { kind: "Absent" },
        source_max_output_tokens: { kind: "Absent" },
        effective_chat_context_budget_tokens: 100,
        effective_chat_output_budget_tokens: 100,
        readiness: { kind: "Ready", last_checked: "2026-09-25T00:00:00Z" },
        input_modalities: ["text"],
        source_default_reasoning: defaultKey === "Present"
          ? { kind: "Present", value: "pro/high" }
          : { kind: "Absent" },
        reasoning: ["standard/high", "pro/high"].map((key) => ({
          key,
          label: key,
          readiness: { kind: "Ready", last_checked: "2026-09-25T00:00:00Z" },
          chat_state: { kind: "Selectable" },
        })),
      }],
    }],
  };
}

test("catalog ingress validates opaque defaults and unique choices", () => {
  expect(decodeGenerationCatalogResponse({ data: catalog("Present") }).routes[0]
    .models[0].reasoning[1].key).toBe("pro/high");
  const invalidDefault = structuredClone(catalog("Present"));
  invalidDefault.routes[0].models[0].source_default_reasoning.value = "retired";
  expect(() => decodeGenerationCatalogResponse({ data: invalidDefault })).toThrow();
  const duplicate = structuredClone(catalog("Present"));
  duplicate.routes[0].models[0].reasoning[1].key = "standard/high";
  expect(() => decodeGenerationCatalogResponse({ data: duplicate })).toThrow();
});

test("model change chooses only a sourced default", () => {
  expect(changeGenerationModel(catalog("Present"), route, "openai:gpt-6-sol"))
    .toEqual({
      kind: "Selected",
      selection: { route: "ProviderApi", model_ref: "openai:gpt-6-sol", reasoning: "pro/high" },
    });
  expect(changeGenerationModel(catalog("Absent"), route, "openai:gpt-6-sol"))
    .toEqual({ kind: "ThinkingRequired", route, modelKey: "openai:gpt-6-sol" });
});

test("picker renders ordered opaque choices in a native thinking select", () => {
  const markup = renderToStaticMarkup(createElement(GenerationSelectionPicker, {
    catalog: catalog("Absent"),
    value: { kind: "ThinkingRequired", route, modelKey: "openai:gpt-6-sol" },
    onChange: () => {},
  }));
  expect(markup).toContain("choose thinking");
  expect(markup.indexOf("standard/high")).toBeLessThan(markup.indexOf("pro/high"));
  expect(markup).not.toContain('type="radio"');
  expect(markup.match(/<select/g)?.length).toBe(2);
});

test("focus moves to an enabled control when thinking becomes a single value", async () => {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", {
    url: "https://nexus.test/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const full = catalog("Absent");
  await act(async () => root.render(createElement(GenerationSelectionPicker, {
    catalog: full,
    value: { kind: "ThinkingRequired", route, modelKey: "openai:gpt-6-sol" },
    onChange: () => {},
  })));
  const thinking = [...dom.window.document.querySelectorAll("select")].at(-1);
  expect(thinking).toBeDefined();
  thinking!.focus();
  expect(dom.window.document.activeElement).toBe(thinking);
  const single = catalog("Present");
  single.routes[0].models[0].reasoning.splice(0, 1);
  await act(async () => root.render(createElement(GenerationSelectionPicker, {
    catalog: single,
    value: { kind: "Selected", selection: {
      route: "ProviderApi", model_ref: "openai:gpt-6-sol", reasoning: "pro/high",
    } },
    onChange: () => {},
  })));
  expect((dom.window.document.activeElement as HTMLSelectElement).disabled).toBe(false);
  expect(dom.window.document.activeElement?.textContent).toContain("openai");
  await act(async () => root.unmount());
  dom.window.close();
});

test("stale model and thinking keys have distinct copy", () => {
  const current = catalog("Present");
  expect(routeForSelection(current, {
    route: "ProviderApi", model_ref: "openai:retired", reasoning: "pro/high",
  })).toBeNull();
  expect(selectionUnavailabilityMessage(current, {
    route: "ProviderApi", model_ref: "openai:retired", reasoning: "pro/high",
  })).toBe("this model is no longer available. choose a current model.");
  expect(selectionUnavailabilityMessage(current, {
    route: "ProviderApi", model_ref: "openai:gpt-6-sol", reasoning: "retired",
  })).toBe("this thinking setting is no longer available. choose another.");
});

test("old send commands are discarded without disclosing another account's draft", () => {
  const items = new Map<string, string>([
    ["nx_chat_draft.v4:path:account-a", JSON.stringify({
      text: "account a text",
      selection: { route: "ProviderApi", model_ref: "openai:retired", reasoning: "high" },
      operation: { kind: "ReconcileRequired", command: {
        idempotencyKey: "old", origin: { identity: "old visit", accountId: "account-a" },
      } },
    })],
    ["nx_chat_draft.v4:path:account-b", JSON.stringify({
      text: "account b text",
      operation: { kind: "Submitting", command: {
        origin: { identity: "another visit", accountId: "account-b" },
      } },
    })],
    ["nx_chat_draft.v4:branch:unowned", JSON.stringify({
      text: "unowned text", operation: { kind: "Absent" },
    })],
  ]);
  const storage = {
    get length() { return items.size; },
    key(index: number) { return [...items.keys()][index] ?? null; },
    getItem(key: string) { return items.get(key) ?? null; },
    setItem(key: string, value: string) { items.set(key, value); },
    removeItem(key: string) { items.delete(key); },
  };
  Object.assign(globalThis, { window: { sessionStorage: storage } });
  recoverPreviousChatDrafts("account-b");
  expect(readRecoveredChatDrafts("account-b")).toEqual(["account b text"]);
  expect(readRecoveredChatDrafts("account-a")).toEqual([]);
  expect(items.has("nx_chat_draft.v4:path:account-a")).toBe(true);
  recoverPreviousChatDrafts("account-a");
  expect(chatDraftStorageKeyForView(
    `${CHAT_DRAFT_STORAGE_PREFIX}new:current`,
    { identity: "visit", accountId: "account" as never },
    null,
  )).toBe(`${CHAT_DRAFT_STORAGE_PREFIX}new:current`);
  expect(readRecoveredChatDrafts("account-a")).toEqual(["account a text"]);
  expect(readRecoveredChatDrafts("account-b")).toEqual(["account b text"]);
  expect(items.has("nx_chat_draft.v4:branch:unowned")).toBe(false);
  expect([...items.keys()].filter((key) => key.startsWith("nx_chat_draft.v4:")))
    .toEqual([]);
});

test("a text-only current draft stays with its authenticated account", async () => {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", {
    url: "https://nexus.test/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  function DraftProbe({ accountId }: { accountId: string }) {
    const draft = useChatDraft({
      draftKey: { kind: "NewConversation", visitId: "00000000-0000-4000-8000-000000000001" as never },
      view: { identity: "visit", accountId },
      conversationId: null,
    });
    return createElement("button", {
      onClick: () => draft.setContent("private account a text"),
    }, draft.content || "empty");
  }
  await act(async () => root.render(createElement(DraftProbe, { accountId: "account-a" })));
  await act(async () => (dom.window.document.querySelector("button") as HTMLButtonElement).click());
  expect(dom.window.document.querySelector("button")?.textContent).toBe("private account a text");
  await act(async () => root.render(createElement(DraftProbe, { accountId: "account-b" })));
  expect(dom.window.document.querySelector("button")?.textContent).toBe("empty");
  await act(async () => root.unmount());
  dom.window.close();
});
