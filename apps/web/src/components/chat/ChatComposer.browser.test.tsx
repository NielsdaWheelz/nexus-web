/// <reference types="vite/client" />

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { cdp, page, userEvent } from "vitest/browser";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import { ApiError } from "@/lib/api/client";
import type { ChatDraftKey } from "@/lib/conversations/chatDraftKey";
import type { PaneVisitId } from "@/lib/workspace/schema";
import ChatComposerComponent from "./ChatComposer";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";

interface ChatRunCall {
  body: ChatRunCreateRequest;
  key: string;
}

interface GenerationFixtureModule {
  readonly GENERATION_CATALOG_RESPONSE: unknown;
}

interface CutoverSupport {
  readonly adoptComposerAdmission: NonNullable<
    ComponentProps<typeof ChatComposerComponent>["onAdmitted"]
  >;
  readonly fixtures: GenerationFixtureModule;
  readonly invalidateGenerationCatalogCache: () => void;
}

// Vite returns an empty map at BASE instead of failing import analysis on files
// that exist only in the candidate. The scenarios then own behavioral RED.
const cutoverModules = import.meta.glob([
  "../../__tests__/helpers/generationCatalog.ts",
  "./useGenerationCatalog.ts",
]);
const admissionModules = import.meta.glob<
  typeof import("../../__tests__/helpers/chatAdmission")
>("../../__tests__/helpers/chatAdmission.ts");
let cutoverSupport: CutoverSupport | null = null;

function requireCutoverSupport(): CutoverSupport {
  if (cutoverSupport === null) {
    expect(
      cutoverSupport,
      "the final exact-generation Chat composer owners are absent",
    ).not.toBeNull();
    throw new Error("unreachable after the BASE sensitivity assertion");
  }
  return cutoverSupport;
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

// The BFF is stubbed at the fetch boundary: the strict catalog resolves, and every chat-run
// POST records its exact request + idempotency key, then throws a synthetic
// network loss to drive the reconciliation ("Retry send") path.
function installBff(calls: ChatRunCall[]) {
  const { GENERATION_CATALOG_RESPONSE } = requireCutoverSupport().fixtures;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/llm-catalog") return json(GENERATION_CATALOG_RESPONSE);
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
    <AuthenticatedAccountProvider
      account={{
        accountId: "11111111-1111-4111-8111-111111111111",
        calendarTimeZone: "UTC",
      }}
    >
      <ChatComposerComponent
        viewIdentity="composer-browser-visit"
        isPaneActive={true}
        onAdmitted={requireCutoverSupport().adoptComposerAdmission}
        conversationId="00000000-0000-4000-8000-000000000001"
        draftKey={pathKey("00000000-0000-4000-8000-000000000001")}
        inheritedRunSelection={null}
        sendCapability={{ kind: "Available" }}
        {...props}
      />
    </AuthenticatedAccountProvider>
  );
}

describe("ChatComposer browser contract", () => {
  beforeAll(async () => {
    const loadFixtures =
      cutoverModules["../../__tests__/helpers/generationCatalog.ts"];
    const loadCatalogOwner = cutoverModules["./useGenerationCatalog.ts"];
    const loadAdmission =
      admissionModules["../../__tests__/helpers/chatAdmission.ts"];
    if (
      loadFixtures === undefined ||
      loadCatalogOwner === undefined ||
      loadAdmission === undefined
    )
      return;
    const [fixtures, catalogOwner, admission] = await Promise.all([
      loadFixtures(),
      loadCatalogOwner(),
      loadAdmission(),
    ]);
    cutoverSupport = {
      adoptComposerAdmission: admission.adoptComposerAdmission,
      fixtures: fixtures as GenerationFixtureModule,
      invalidateGenerationCatalogCache: (
        catalogOwner as {
          readonly invalidateGenerationCatalogCache: () => void;
        }
      ).invalidateGenerationCatalogCache,
    };
  });

  beforeEach(async () => {
    cutoverSupport?.invalidateGenerationCatalogCache();
    sessionStorage.clear();
    cutoverSupport?.invalidateGenerationCatalogCache();
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
    await userEvent.click(
      await screen.findByRole("button", { name: /Change model/u }),
    );
    const high = await screen.findByRole("radio", { name: "High" });
    fireEvent.click(high);
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm selection" }),
    );

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
      catalog_definition_revision: "a".repeat(64),
      selection: {
        route: "CodexPersonal",
        model: "gpt-5.6-terra",
        reasoning: "high",
      },
      tool_authority: "ReadOnly",
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
    await screen.findByRole("button", { name: /Change model/u });
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

  it("preserves an edited launch draft across remount and accepts a deliberate new launch", async () => {
    installBff([]);
    const draftKey = newConversationKey("hydration-draft-proof");
    const view = render(
      withRenderEnvironment(
        <Composer
          conversationId={null}
          draftKey={draftKey}
          initialContent="Launch seed"
        />,
      ),
    );
    const input = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await waitFor(() => expect(input).toHaveValue("Launch seed"));
    await userEvent.fill(input, "draft survives hydration");
    expect(input.value).toBe("draft survives hydration");
    view.unmount();

    const { rerender } = render(
      withRenderEnvironment(
        <Composer
          conversationId={null}
          draftKey={draftKey}
          initialContent="Launch seed"
        />,
      ),
    );
    const restored = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await waitFor(() =>
      expect(restored.value).toBe("draft survives hydration"),
    );
    rerender(
      withRenderEnvironment(
        <Composer
          conversationId={null}
          draftKey={draftKey}
          initialContent="Deliberate new launch"
        />,
      ),
    );
    await waitFor(() =>
      expect(restored).toHaveValue("Deliberate new launch"),
    );
  });

  it("keeps the server-rendered composer inert until its draft is restored, so hydration drops no keystroke", async () => {
    installBff([]);
    sessionStorage.setItem(
      "nx_chat_draft.v3:path:00000000-0000-4000-8000-00000000000c",
      JSON.stringify({
        text: "",
        selection: {
          route: "CodexPersonal",
          model: "gpt-5.6-terra",
          reasoning: "high",
        },
        toolAuthority: "ReadOnly",
        operation: { kind: "Absent" },
      }),
    );
    const composer = () =>
      withRenderEnvironment(
        <Composer draftKey={pathKey("00000000-0000-4000-8000-00000000000c")} />,
      );
    const container = document.createElement("div");
    container.innerHTML = renderToString(composer());
    document.body.append(container);
    const textbox = within(container).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    // A keystroke into the server markup never reaches React: hydration adopts
    // the already-changed value silently and the next update wipes it.
    expect(textbox).toBeDisabled();

    const root = hydrateRoot(container, composer());
    try {
      await waitFor(() => expect(textbox).toBeEnabled());
      expect(
        await within(container).findByRole("button", {
          name: /Change model.*High/u,
        }),
      ).toBeVisible();
      await userEvent.type(textbox, "Typed once editable");
      expect(textbox).toHaveValue("Typed once editable");
    } finally {
      root.unmount();
      container.remove();
    }
  });

  it("keeps a locked reconciliation intact when a re-key and a new initialContent land in one commit", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    const lockedKey = pathKey("00000000-0000-4000-8000-00000000000b");
    const lockedStorageKey =
      "nx_chat_draft.v3:path:00000000-0000-4000-8000-00000000000b";
    const persisted = {
      text: "in-flight message",
      selection: {
        route: "CodexPersonal",
        model: "gpt-5.6-terra",
        reasoning: "medium",
      },
      toolAuthority: "ReadOnly",
      operation: {
        kind: "ReconcileRequired",
        command: {
          idempotencyKey: "locked-command-key",
          origin: {
            identity: "composer-browser-visit",
            accountId: "11111111-1111-4111-8111-111111111111",
          },
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
            catalog_definition_revision: "a".repeat(64),
            selection: {
              route: "CodexPersonal",
              model: "gpt-5.6-terra",
              reasoning: "medium",
            },
            tool_authority: "ReadOnly",
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
    expect(() =>
      view.rerender(
        withRenderEnvironment(
          <Composer draftKey={lockedKey} initialContent="quoted passage" />,
        ),
      ),
    ).not.toThrow();

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

  it("reloads an in-flight new-chat send as a locked Retry that replays the exact key and request", async () => {
    const calls: ChatRunCall[] = [];
    installBff(calls);
    const draftKey = newConversationKey("3f2504e0-4f89-41d3-9a0c-0305e82c3301");

    const view = render(
      withRenderEnvironment(
        <Composer conversationId={null} draftKey={draftKey} />,
      ),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Change model/u }),
    );
    const high = await screen.findByRole("radio", { name: "High" });
    fireEvent.click(high);
    await waitFor(() => expect(high).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm selection" }),
    );
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(input);
    await userEvent.keyboard("summarize this{Enter}");
    await screen.findByRole("button", { name: "Retry send" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.destination).toEqual({ kind: "New" });
    expect(calls[0].body).toMatchObject({
      selection: {
        route: "CodexPersonal",
        model: "gpt-5.6-terra",
        reasoning: "high",
      },
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
    const modelTrigger = await screen.findByRole("button", {
      name: /Change model/u,
    });
    const stop = screen.getByRole("button", { name: "Stop response" });
    const socketWidth = stop.getBoundingClientRect().width;

    expect(modelTrigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(stop.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    );

    await userEvent.click(stop);
    const stopping = await screen.findByRole("button", {
      name: "Stopping response",
    });
    expect(stopping.getBoundingClientRect().width).toBe(socketWidth);
    expect(cancelCalls).toBe(1);
    releaseCancellation?.();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop response" }),
      ).toBeVisible(),
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

    await screen.findByRole("button", { name: /Change model/u });
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
