/// <reference types="vite/client" />

import { render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { useState, type ComponentType } from "react";
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
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { absent } from "@/lib/api/presence";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import {
  chatDraftKeyFor,
  type ChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import type { GenerationSelectionSpec } from "@/lib/conversations/generationCatalog";
import ChatComposer from "./ChatComposer";
import ChatFailureCard from "./ChatFailureCard";
import { useConversation } from "./useConversation";

interface RunSelectionFixture extends Readonly<Record<string, unknown>> {
  readonly selection: Readonly<Record<string, unknown>>;
  readonly current_state: Readonly<Record<string, unknown>>;
}

interface GenerationFixtureModule {
  readonly CATALOG_REVISION: string;
  readonly GENERATION_CATALOG: unknown;
  readonly GENERATION_CATALOG_RESPONSE: unknown;
  readonly RUN_SELECTION: RunSelectionFixture;
}

interface GenerationSelectionPickerProps {
  readonly catalog: unknown;
  readonly value: unknown;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (selection: unknown) => Promise<boolean>;
  readonly writeAuthority: "ReadOnly" | "AdditiveWrites";
}

interface CandidateGenerationPickerProps {
  readonly operation: "Rerun" | "Regenerate";
  readonly runSelection: RunSelectionFixture;
  readonly disabled?: boolean;
  readonly openRequestVersion?: number;
  readonly onConfirm: (
    selection: unknown,
    catalogDefinitionRevision: string,
  ) => Promise<boolean>;
}

interface CutoverSupport {
  readonly fixtures: GenerationFixtureModule;
  readonly CandidateGenerationPicker: ComponentType<CandidateGenerationPickerProps>;
  readonly GenerationSelectionPicker: ComponentType<GenerationSelectionPickerProps>;
  readonly invalidateGenerationCatalogCache: () => void;
}

// Vite returns an empty map at BASE instead of failing import analysis on files
// that exist only in the candidate. The first scenario then owns behavioral RED.
const cutoverModules = import.meta.glob([
  "../../__tests__/helpers/generationCatalog.ts",
  "./CandidateGenerationPicker.tsx",
  "./GenerationSelectionPicker.tsx",
  "./useGenerationCatalog.ts",
]);
let cutoverSupport: CutoverSupport | null = null;

function requireCutoverSupport(): CutoverSupport {
  if (cutoverSupport === null) {
    expect(
      cutoverSupport,
      "the final generation-selection browser owners are absent",
    ).not.toBeNull();
    throw new Error("unreachable after the BASE sensitivity assertion");
  }
  return cutoverSupport;
}

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const ASSISTANT_ID = "00000000-0000-4000-8000-000000000003";
const RUN_ID = "00000000-0000-4000-8000-000000000004";
const NOW = "2026-08-31T20:00:00Z";

const draftKey: ChatDraftKey = {
  kind: "Path",
  targetId: CONVERSATION_ID,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input);
  return new URL(value, window.location.origin).pathname;
}

function mutableRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function catalogWithNoSelectableChatPair(response: unknown): unknown {
  const clone = mutableRecord(structuredClone(response), "catalog response");
  const catalog = mutableRecord(clone.data, "catalog response.data");
  const chatSeed = mutableRecord(catalog.chat_seed, "catalog chat seed");
  const routes = mutableArray(catalog.routes, "catalog routes");
  // The two operator-action states production readiness can emit: the Codex
  // host contract mismatch, and an absent credential on a configured API route.
  const codexBlocked = {
    kind: "OperatorActionRequired",
    code: "codex_host_unavailable",
    explanation:
      "The Codex generation host contract does not match this Nexus build.",
    action: "Repair or redeploy the pinned Codex generation host before sending.",
    last_checked: NOW,
  } as const;
  const credentialBlocked = {
    kind: "OperatorActionRequired",
    code: "credential_unavailable",
    explanation: "The configured Anthropic API credential is absent.",
    action: "Configure the route-specific generation credential before sending.",
    last_checked: NOW,
  } as const;

  chatSeed.state = codexBlocked;
  for (const [routeIndex, routeValue] of routes.entries()) {
    const route = mutableRecord(routeValue, `catalog route ${routeIndex}`);
    const blocked =
      route.label === "Codex Personal" ? codexBlocked : credentialBlocked;
    route.readiness = blocked;
    const models = mutableArray(route.models, `catalog route ${routeIndex} models`);
    for (const [modelIndex, modelValue] of models.entries()) {
      const model = mutableRecord(
        modelValue,
        `catalog route ${routeIndex} model ${modelIndex}`,
      );
      model.readiness = blocked;
      const reasoningRows = mutableArray(
        model.reasoning,
        `catalog route ${routeIndex} model ${modelIndex} reasoning`,
      );
      for (const [reasoningIndex, reasoningValue] of reasoningRows.entries()) {
        const reasoning = mutableRecord(
          reasoningValue,
          `catalog route ${routeIndex} model ${modelIndex} reasoning ${reasoningIndex}`,
        );
        reasoning.readiness = blocked;
        reasoning.chat_state = blocked;
      }
    }
  }
  return clone;
}

function catalogWithTerraReasoningState(
  catalogValue: unknown,
  reasoningKey: "medium" | "high",
  chatState: Readonly<Record<string, unknown>>,
): unknown {
  const clone = mutableRecord(structuredClone(catalogValue), "generation catalog");
  const routes = mutableArray(clone.routes, "generation catalog routes");
  const codexRoute = routes
    .map((route, index) => mutableRecord(route, `generation catalog route ${index}`))
    .find((route) => route.label === "Codex Personal");
  if (codexRoute === undefined) throw new Error("Codex Personal fixture route is absent");
  const models = mutableArray(codexRoute.models, "Codex Personal models");
  const terra = models
    .map((model, index) => mutableRecord(model, `Codex model ${index}`))
    .find((model) => model.key === "gpt-5.6-terra");
  if (terra === undefined) throw new Error("GPT-5.6 Terra fixture model is absent");
  const reasoningRows = mutableArray(terra.reasoning, "GPT-5.6 Terra reasoning");
  const reasoning = reasoningRows
    .map((row, index) => mutableRecord(row, `GPT-5.6 Terra reasoning ${index}`))
    .find((row) => row.key === reasoningKey);
  if (reasoning === undefined) {
    throw new Error(`GPT-5.6 Terra ${reasoningKey} reasoning fixture is absent`);
  }
  reasoning.chat_state = chatState;
  return clone;
}

function message(id: string, role: "user" | "assistant") {
  return {
    id,
    seq: role === "user" ? 1 : 2,
    role,
    message_document: { type: "message_document", blocks: [] },
    parent_message_id: role === "assistant" ? USER_ID : null,
    trust_trail: null,
    citations: [],
    reader_selection: { kind: "Absent" },
    status: role === "assistant" ? "pending" : "complete",
    can_rerun: false,
    can_regenerate: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

function admittedRun(toolAuthority: "ReadOnly" | "AdditiveWrites") {
  const { RUN_SELECTION } = requireCutoverSupport().fixtures;
  return {
    data: {
      run: {
        id: RUN_ID,
        status: "queued",
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_ID,
        assistant_message_id: ASSISTANT_ID,
        run_selection: { ...RUN_SELECTION, tool_authority: toolAuthority },
        support_id: { kind: "Absent" },
        publication_warning: { kind: "Absent" },
        failure: null,
        execution: { kind: "Absent" },
        cancel_requested_at: null,
        started_at: null,
        completed_at: null,
        error_code: null,
        created_at: NOW,
        updated_at: NOW,
      },
      conversation: {
        id: CONVERSATION_ID,
        title: "Selection proof",
        sharing: "private",
        message_count: 2,
        created_at: NOW,
        updated_at: NOW,
      },
      user_message: message(USER_ID, "user"),
      assistant_message: message(ASSISTANT_ID, "assistant"),
      stream_state: {
        status: "queued",
        last_event_seq: 0,
        folded_event_seq: 0,
        assistant_current_text: "",
        tool_calls: [],
        activity: null,
        reconnectable: true,
        terminal: false,
      },
    },
  };
}

function Composer() {
  return (
    <ChatComposer
      conversationId={CONVERSATION_ID}
      draftKey={draftKey}
      inheritedRunSelection={null}
      sendCapability={{ kind: "Available" }}
    />
  );
}

function PickerHarness({
  catalog,
  onConfirm,
}: {
  readonly catalog: unknown;
  readonly onConfirm: (selection: unknown) => Promise<boolean>;
}) {
  const { fixtures, GenerationSelectionPicker } = requireCutoverSupport();
  const [open, setOpen] = useState(false);
  return (
    <>
      <GenerationSelectionPicker
        catalog={catalog}
        value={fixtures.RUN_SELECTION.selection}
        open={open}
        onOpenChange={setOpen}
        onConfirm={onConfirm}
        writeAuthority="ReadOnly"
      />
      <section aria-label="Transcript">
        <button type="button">Transcript action</button>
      </section>
    </>
  );
}

const FIRST_USER_ID = "00000000-0000-4000-8000-000000000011";
const FIRST_ASSISTANT_ID = "00000000-0000-4000-8000-000000000012";
const SECOND_USER_ID = "00000000-0000-4000-8000-000000000013";
const SECOND_ASSISTANT_ID = "00000000-0000-4000-8000-000000000014";
const RERUN_ASSISTANT_ID = "00000000-0000-4000-8000-000000000015";
const CLAUDE_HIGH = {
  route: "ProviderApi",
  model_ref: "anthropic:claude-sonnet-4-5",
  reasoning: "high",
} as const;
const TERRA_HIGH = {
  route: "CodexPersonal",
  model: "gpt-5.6-terra",
  reasoning: "high",
} as const;

function dispatchedRunSelection(
  selection: Readonly<Record<string, unknown>>,
  display: Readonly<{
    route_label: string;
    model_label: string;
    reasoning_label: string;
    billing: Readonly<Record<string, unknown>>;
  }>,
): RunSelectionFixture {
  return {
    ...requireCutoverSupport().fixtures.RUN_SELECTION,
    selection,
    display_at_dispatch: {
      ...display,
      privacy: {
        summary: "Private account request",
        retention: "Provider retention applies",
        training: "Not used for training",
      },
      processor_chain: { processors: [display.route_label] },
    },
  };
}

function transcriptMessage(input: {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly parentMessageId: string | null;
  readonly text: string;
  readonly status?: "complete" | "error" | "pending";
  readonly runSelection?: RunSelectionFixture;
}) {
  const status = input.status ?? "complete";
  return {
    id: input.id,
    seq: input.seq,
    role: input.role,
    message_document: {
      type: "message_document",
      blocks:
        input.text === ""
          ? []
          : [{ type: "text", format: "markdown", text: input.text }],
    },
    parent_message_id: input.parentMessageId,
    trust_trail: input.runSelection
      ? {
          schema_version: "assistant_trust_trail.v1",
          assistant_message_id: input.id,
          conversation_id: CONVERSATION_ID,
          chat_run_id: `${input.id}-run`,
          status,
          run: {
            run_id: `${input.id}-run`,
            run_selection: input.runSelection,
            status,
            usage: null,
            error_code: status === "error" ? "assistant_unavailable" : null,
            support_id: { kind: "Absent" },
            publication_warning: { kind: "Absent" },
            failure:
              status === "error"
                ? { code: "assistant_unavailable", can_rerun: true }
                : null,
            execution: { kind: "Absent" },
            final_chars: null,
            started_at: NOW,
            completed_at: NOW,
          },
          prompt: null,
          tool_calls: [],
          citations: [],
          context_refs_added: [],
          integrity_notices: [],
          created_at: NOW,
          updated_at: NOW,
        }
      : null,
    citations: [],
    reader_selection: { kind: "Absent" },
    status,
    can_rerun: status === "error",
    can_regenerate: false,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Two turns: the first answer ran on Claude/high, the second on Terra/high. */
function twoTurnTree(secondAnswerStatus: "complete" | "error") {
  const selectedPath = [
    transcriptMessage({
      id: FIRST_USER_ID,
      seq: 1,
      role: "user",
      parentMessageId: null,
      text: "First question",
    }),
    transcriptMessage({
      id: FIRST_ASSISTANT_ID,
      seq: 2,
      role: "assistant",
      parentMessageId: FIRST_USER_ID,
      text: "First answer",
      runSelection: dispatchedRunSelection(CLAUDE_HIGH, {
        route_label: "Anthropic API",
        model_label: "Claude Sonnet 4.5",
        reasoning_label: "High",
        billing: { kind: "MeteredApi", label: "Metered API" },
      }),
    }),
    transcriptMessage({
      id: SECOND_USER_ID,
      seq: 3,
      role: "user",
      parentMessageId: FIRST_ASSISTANT_ID,
      text: "Second question",
    }),
    transcriptMessage({
      id: SECOND_ASSISTANT_ID,
      seq: 4,
      role: "assistant",
      parentMessageId: SECOND_USER_ID,
      text: "Second answer",
      status: secondAnswerStatus,
      runSelection: dispatchedRunSelection(TERRA_HIGH, {
        route_label: "Codex Personal",
        model_label: "GPT-5.6 Terra",
        reasoning_label: "High",
        billing: { kind: "Subscription", label: "Codex subscription" },
      }),
    }),
  ];
  return {
    data: {
      conversation: {
        id: CONVERSATION_ID,
        title: "Selection proof",
        sharing: "private",
        message_count: selectedPath.length,
        created_at: NOW,
        updated_at: NOW,
      },
      selected_path: selectedPath,
      active_leaf_message_id: SECOND_ASSISTANT_ID,
      fork_options_by_parent_id: {},
      path_cache_by_leaf_id: { [SECOND_ASSISTANT_ID]: selectedPath },
      branch_graph: { nodes: [], edges: [], root_message_id: null },
      page: { before_cursor: null },
    },
  };
}

/** The admitted sibling candidate a rerun of the second answer creates. */
function admittedRerun() {
  const admitted = admittedRun("ReadOnly");
  return {
    data: {
      ...admitted.data,
      run: {
        ...admitted.data.run,
        user_message_id: SECOND_USER_ID,
        assistant_message_id: RERUN_ASSISTANT_ID,
      },
      user_message: transcriptMessage({
        id: SECOND_USER_ID,
        seq: 3,
        role: "user",
        parentMessageId: FIRST_ASSISTANT_ID,
        text: "Second question",
      }),
      assistant_message: transcriptMessage({
        id: RERUN_ASSISTANT_ID,
        seq: 4,
        role: "assistant",
        parentMessageId: SECOND_USER_ID,
        text: "",
        status: "pending",
      }),
    },
  };
}

/** The BFF surface a loaded conversation touches; `handle` owns the scenario. */
function stubConversationFetch(
  tree: unknown,
  handle: (
    pathname: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response> | undefined,
): void {
  const { GENERATION_CATALOG_RESPONSE } = requireCutoverSupport().fixtures;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = requestPath(input);
      const handled = handle(pathname, init);
      if (handled !== undefined) return handled;
      if (pathname === `/api/conversations/${CONVERSATION_ID}/tree`) {
        return json(tree);
      }
      if (pathname === "/api/chat-runs" && init?.method !== "POST") {
        return json({ data: [] });
      }
      if (pathname === "/api/llm-catalog") return json(GENERATION_CATALOG_RESPONSE);
      if (pathname === "/api/stream-token") {
        return json({
          data: {
            token: "stream-token",
            stream_base_url: "https://stream.nexus.test",
            expires_at: "2026-08-31T20:01:00Z",
          },
        });
      }
      if (pathname === `/stream/chat-runs/${RUN_ID}/events`) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Stream aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`Unexpected conversation request: ${pathname}`);
    },
  );
}

/**
 * The real engine, the candidate controls AssistantMessage mounts for a failed
 * answer (primary Rerun and the replacement picker), and the composer, wired
 * the way Conversation wires them.
 */
function ConversationHarness() {
  const { CandidateGenerationPicker } = requireCutoverSupport();
  const convo = useConversation({
    conversationId: CONVERSATION_ID,
    branching: true,
  });
  const branch = convo.branch;
  const branchDraft = branch?.branchDraft ?? null;
  return (
    <>
      {convo.error ? (
        <FeedbackNotice content={convo.error} announcement="Assertive" />
      ) : null}
      {convo.messages
        .filter((message) => message.status === "error")
        .map((message) => {
          const run = message.trust_trail?.run;
          if (!run) throw new Error(`Failed answer ${message.id} has no run projection`);
          const rerunning = convo.rerunningAssistantMessageIds.has(message.id);
          return (
            <div key={message.id}>
              <ChatFailureCard
                failure={run.failure}
                supportId={absent()}
                canRerun={message.can_rerun}
                onRerun={() => void convo.rerunAssistantResponse(message.id)}
                rerunning={rerunning}
              />
              <CandidateGenerationPicker
                operation="Rerun"
                runSelection={run.run_selection as unknown as RunSelectionFixture}
                disabled={rerunning}
                onConfirm={async (selection, catalogDefinitionRevision) =>
                  (await convo.rerunAssistantResponseWithSelection(
                    message.id,
                    selection as GenerationSelectionSpec,
                    catalogDefinitionRevision,
                  )) === "Committed"
                }
              />
            </div>
          );
        })}
      {branch ? (
        <button
          type="button"
          onClick={() =>
            branch.setBranchDraft({
              parentMessageId: FIRST_ASSISTANT_ID,
              parentMessageSeq: 2,
              parentMessagePreview: "First answer",
              anchor: { kind: "assistant_message", message_id: FIRST_ASSISTANT_ID },
            })
          }
        >
          Fork from the first answer
        </button>
      ) : null}
      <ChatComposer
        conversationId={convo.conversationId}
        draftKey={
          branchDraft
            ? chatDraftKeyFor({ kind: "Branch", branchDraft })
            : chatDraftKeyFor({
                kind: "Path",
                targetId:
                  branch?.activeLeafMessageId ??
                  convo.replyParentMessageId ??
                  CONVERSATION_ID,
              })
        }
        branchDraft={branchDraft}
        parentMessageId={convo.replyParentMessageId}
        inheritedRunSelection={convo.inheritedRunSelection}
        sendCapability={convo.sendCapability}
        onChatRunCreated={convo.onChatRunCreated}
        onClearBranchDraft={branch ? () => branch.setBranchDraft(null) : undefined}
      />
    </>
  );
}

describe("Generation selection browser contract", () => {
  beforeAll(async () => {
    const loadFixtures =
      cutoverModules["../../__tests__/helpers/generationCatalog.ts"];
    const loadCandidatePicker =
      cutoverModules["./CandidateGenerationPicker.tsx"];
    const loadGenerationSelectionPicker =
      cutoverModules["./GenerationSelectionPicker.tsx"];
    const loadCatalogOwner = cutoverModules["./useGenerationCatalog.ts"];
    if (
      loadFixtures === undefined ||
      loadCandidatePicker === undefined ||
      loadGenerationSelectionPicker === undefined ||
      loadCatalogOwner === undefined
    ) {
      return;
    }
    const [fixtures, candidatePicker, generationSelectionPicker, catalogOwner] =
      await Promise.all([
        loadFixtures(),
        loadCandidatePicker(),
        loadGenerationSelectionPicker(),
        loadCatalogOwner(),
      ]);
    cutoverSupport = {
      fixtures: fixtures as GenerationFixtureModule,
      CandidateGenerationPicker: (
        candidatePicker as {
          readonly default: ComponentType<CandidateGenerationPickerProps>;
        }
      ).default,
      GenerationSelectionPicker: (
        generationSelectionPicker as {
          readonly default: ComponentType<GenerationSelectionPickerProps>;
        }
      ).default,
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
    await page.viewport(1_024, 768);
  });

  afterEach(() => {
    cutoverSupport?.invalidateGenerationCatalogCache();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("selects an exact provider/model/reasoning pair and resets the one-run write grant", async () => {
    const { CATALOG_REVISION, GENERATION_CATALOG_RESPONSE } =
      requireCutoverSupport().fixtures;
    const requests: ChatRunCreateRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/llm-catalog") {
          return json(GENERATION_CATALOG_RESPONSE);
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          requests.push(JSON.parse(String(init.body)) as ChatRunCreateRequest);
          return json(admittedRun("AdditiveWrites"));
        }
        throw new Error(`Unexpected generation request: ${path}`);
      },
    );

    render(withRenderEnvironment(<Composer />));
    const trigger = await screen.findByRole("button", {
      name: /Change model.*Codex Personal.*GPT-5\.6 Terra.*Medium.*Codex subscription/u,
    });
    const writeGrant = screen.getByRole("checkbox", {
      name: "Allow this reply to add to Nexus",
    });
    expect(writeGrant).not.toBeChecked();
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    for (const retiredShortcut of ["Fast", "Balanced", "Deep"]) {
      expect(
        within(dialog).queryByRole("button", { name: retiredShortcut }),
      ).toBeNull();
    }
    expect(
      within(dialog).getByRole("combobox", { name: "Search models" }),
    ).toHaveFocus();
    expect(
      within(dialog).getByRole("group", { name: /Anthropic API/u }),
    ).toBeVisible();
    expect(
      within(dialog).getAllByText("Not reported", { exact: true }),
    ).toHaveLength(2);
    expect(
      within(dialog).getAllByText("Codex subscription", { exact: true }),
    ).toHaveLength(2);
    const details = within(dialog).getByRole("region", {
      name: "Selection details",
    });
    expect(
      within(details).getByText("Provider retention applies", { exact: true }),
    ).toBeVisible();
    expect(
      within(details).getByText("Nexus → Codex Personal", { exact: true }),
    ).toBeVisible();

    const retired = within(dialog).getByRole("option", {
      name: "GPT-5.5 Retired, Retired, Retired",
    });
    expect(retired).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "This model is retired.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /Switch to anthropic:claude-sonnet-4-5/u,
      }),
    );
    const confirm = within(dialog).getByRole("button", {
      name: "Confirm selection",
    });
    confirm.scrollIntoView({ block: "center" });
    await userEvent.click(confirm);

    await userEvent.click(writeGrant);
    expect(writeGrant).toBeChecked();
    for (const clause of [
      /This reply only/u,
      /nexus\.library\.add/u,
      /nexus\.note\.create/u,
      /nexus\.highlight\.create/u,
      /nexus\.edge\.create/u,
      /nexus\.queue\.add/u,
      /Trust details and Undo/u,
    ]) {
      expect(writeGrant).toHaveAccessibleDescription(clause);
    }
    // Browsers resolve a describedby referent through accname step 2C, so an
    // aria-label on it would replace this description with the label text.
    expect(screen.getByRole("note")).not.toHaveAttribute("aria-label");
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    await userEvent.type(input, "Use the exact route");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      catalog_definition_revision: CATALOG_REVISION,
      selection: {
        route: "ProviderApi",
        model_ref: "anthropic:claude-sonnet-4-5",
        reasoning: "high",
      },
      tool_authority: "AdditiveWrites",
    });
    await waitFor(() => expect(writeGrant).not.toBeChecked());
    expect(
      await screen.findByText("Writes are off for the next reply."),
    ).toBeVisible();
  });

  it("keeps the draft and exact choice when the catalog revision is rejected", async () => {
    const { GENERATION_CATALOG_RESPONSE } = requireCutoverSupport().fixtures;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/llm-catalog") {
          return json(GENERATION_CATALOG_RESPONSE);
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          return json(
            {
              error: {
                code: "E_CATALOG_DEFINITION_STALE",
                message: "stale catalog",
                request_id: "catalog-stale-proof",
              },
            },
            409,
          );
        }
        throw new Error(`Unexpected generation request: ${path}`);
      },
    );

    render(withRenderEnvironment(<Composer />));
    const input = await screen.findByRole("textbox", { name: "Ask anything" });
    await userEvent.type(input, "Preserve this exact draft");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByText(
        "Model availability changed — review and confirm again.",
      ),
    ).toBeVisible();
    expect(input).toHaveValue("Preserve this exact draft");
    expect(
      screen.getByRole("dialog", { name: "Model and reasoning" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("blocks dispatch and preserves the draft when no Chat pair is selectable", async () => {
    const { GENERATION_CATALOG_RESPONSE } = requireCutoverSupport().fixtures;
    let dispatchCount = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/llm-catalog") {
          return json(catalogWithNoSelectableChatPair(GENERATION_CATALOG_RESPONSE));
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          dispatchCount += 1;
          return json(admittedRun("ReadOnly"));
        }
        throw new Error(`Unexpected generation request: ${path}`);
      },
    );

    render(withRenderEnvironment(<Composer />));
    const input = await screen.findByRole("textbox", { name: "Ask anything" });
    await userEvent.type(input, "Keep this draft editable");

    const blockedStatus = await screen.findByText(
      "No model and reasoning pair is currently available for Chat. Repair or redeploy the pinned Codex generation host before sending.",
    );
    expect(blockedStatus).toHaveTextContent(
      "No model and reasoning pair is currently available for Chat. Repair or redeploy the pinned Codex generation host before sending.",
    );
    expect(blockedStatus).toHaveAttribute("aria-live", "polite");
    expect(input).toBeEnabled();
    expect(input).toHaveValue("Keep this draft editable");

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    send.click();
    await userEvent.keyboard("{Enter}");
    expect(dispatchCount).toBe(0);
    expect(input).toHaveValue("Keep this draft editable");
  });

  it("uses a nonmodal desktop dialog and returns focus on dismissal", async () => {
    const { GENERATION_CATALOG_RESPONSE } = requireCutoverSupport().fixtures;
    vi.stubGlobal("fetch", async () => json(GENERATION_CATALOG_RESPONSE));
    render(
      withRenderEnvironment(
        <>
          <button type="button">Transcript action</button>
          <Composer />
        </>,
      ),
    );
    const transcriptAction = screen.getByRole("button", {
      name: "Transcript action",
    });
    const trigger = await screen.findByRole("button", {
      name: /Change model/u,
    });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(transcriptAction).not.toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Model and reasoning" }),
    ).toBeNull();
  });

  it("implements the complete desktop combobox keyboard and outside-dismiss contract", async () => {
    const { GENERATION_CATALOG } = requireCutoverSupport().fixtures;
    const onConfirm = vi.fn(async () => false);
    render(
      withRenderEnvironment(
        <PickerHarness catalog={GENERATION_CATALOG} onConfirm={onConfirm} />,
      ),
    );

    const transcriptAction = screen.getByRole("button", {
      name: "Transcript action",
    });
    const trigger = screen.getByRole("button", { name: /Change model/u });
    await userEvent.click(trigger);
    let dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    const search = within(dialog).getByRole("combobox", {
      name: "Search models",
    });
    const listbox = within(dialog).getByRole("listbox", { name: "Models" });
    const terra = within(dialog).getByRole("option", {
      name: "GPT-5.6 Terra, Active, Ready",
    });
    const retired = within(dialog).getByRole("option", {
      name: "GPT-5.5 Retired, Retired, Retired",
    });
    const claude = within(dialog).getByRole("option", {
      name: "Claude Sonnet 4.5, Active, Ready",
    });
    const status = within(dialog).getByRole("status");

    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(search).toHaveAttribute("aria-activedescendant", terra.id);
    await userEvent.keyboard("{End}");
    expect(search).toHaveAttribute("aria-activedescendant", claude.id);
    expect(status).toHaveTextContent("3 models. Claude Sonnet 4.5, Ready.");
    await userEvent.keyboard("{Home}{ArrowDown}{Enter}");
    expect(search).toHaveAttribute("aria-activedescendant", retired.id);
    expect(search).toHaveFocus();
    expect(status).toHaveTextContent("This model is retired.");
    expect(onConfirm).not.toHaveBeenCalled();

    const confirm = within(dialog).getByRole("button", {
      name: "Confirm selection",
    });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).toHaveAccessibleDescription("This model is retired.");
    confirm.focus();
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(status).toHaveTextContent("This model is retired.");

    search.focus();
    await userEvent.type(search, "claude");
    expect(search).toHaveValue("claude");
    expect(status).toHaveTextContent("1 model. Claude Sonnet 4.5, Ready.");
    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(dialog).toBeVisible();
    expect(status).toHaveTextContent("Search cleared. 3 models.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Model and reasoning" }),
    ).toBeNull();

    await userEvent.click(trigger);
    dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    const reopenedSearch = within(dialog).getByRole("combobox", {
      name: "Search models",
    });
    expect(reopenedSearch).toHaveFocus();
    await userEvent.tab();
    expect(
      within(dialog).getByRole("radio", { name: "Medium" }),
    ).toHaveFocus();
    await userEvent.tab();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    await userEvent.tab();
    expect(
      within(dialog).getByRole("button", { name: "Confirm selection" }),
    ).toHaveFocus();
    await userEvent.tab();
    await waitFor(() => expect(transcriptAction).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Model and reasoning" }),
    ).toBeNull();

    await userEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Model and reasoning" }),
    ).toBeVisible();
    await userEvent.click(transcriptAction);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Model and reasoning" }),
      ).toBeNull(),
    );
  });

  it("keeps disabled reasoning in the roving sequence without selecting it", async () => {
    const { GENERATION_CATALOG } = requireCutoverSupport().fixtures;
    const catalog = catalogWithTerraReasoningState(
      GENERATION_CATALOG,
      "high",
      {
        kind: "Ineligible",
        code: "missing_reasoning_qualification",
        explanation: "High reasoning is not qualified for Chat.",
      },
    );
    const onConfirm = vi.fn(async () => false);
    render(
      withRenderEnvironment(
        <PickerHarness catalog={catalog} onConfirm={onConfirm} />,
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change model/u }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    expect(
      within(dialog).getByRole("option", {
        name: "GPT-5.6 Terra, Active, Ready",
      }),
    ).toHaveAttribute("aria-selected", "true");
    const medium = within(dialog).getByRole("radio", { name: "Medium" });
    const high = within(dialog).getByRole("radio", {
      name: /^High/u,
    });
    const status = within(dialog).getByRole("status");

    expect(medium).toHaveAttribute("aria-checked", "true");
    expect(medium).toHaveAttribute("tabindex", "0");
    expect(high).toHaveAttribute("aria-disabled", "true");
    expect(high).toHaveAttribute("aria-checked", "false");
    medium.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(high).toHaveFocus();
    expect(high).toHaveAttribute("tabindex", "0");
    expect(medium).toHaveAttribute("tabindex", "-1");
    expect(medium).toHaveAttribute("aria-checked", "true");
    expect(high).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{Enter}");
    expect(status).toHaveTextContent(
      "High reasoning is not qualified for Chat.",
    );
    expect(high).toHaveAttribute("aria-checked", "false");
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.keyboard("{Home}");
    expect(medium).toHaveFocus();
    expect(medium).toHaveAttribute("aria-checked", "true");
  });

  it("announces only a current selection readiness transition", async () => {
    const { GENERATION_CATALOG } = requireCutoverSupport().fixtures;
    const onConfirm = vi.fn(async () => false);
    const view = render(
      withRenderEnvironment(
        <PickerHarness catalog={GENERATION_CATALOG} onConfirm={onConfirm} />,
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change model/u }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    const status = within(dialog).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).not.toHaveTextContent("Availability changed.");

    const changedCatalog = catalogWithTerraReasoningState(
      GENERATION_CATALOG,
      "medium",
      {
        kind: "TemporarilyUnavailable",
        code: "provider_unavailable",
        explanation: "Medium reasoning is temporarily unavailable.",
        action: "Retry after provider recovery.",
        last_checked: NOW,
      },
    );
    view.rerender(
      withRenderEnvironment(
        <PickerHarness catalog={changedCatalog} onConfirm={onConfirm} />,
      ),
    );
    await waitFor(() =>
      expect(status).toHaveTextContent(
        "Availability changed. Medium reasoning is temporarily unavailable.",
      ),
    );
  });

  it("uses the mobile sheet lifecycle without inerting the transcript", async () => {
    const { GENERATION_CATALOG } = requireCutoverSupport().fixtures;
    const onConfirm = vi.fn(async () => false);
    await page.viewport(390, 844);
    render(
      withRenderEnvironment(
        <PickerHarness catalog={GENERATION_CATALOG} onConfirm={onConfirm} />,
        { initialViewport: "mobile" },
      ),
    );
    const transcript = screen.getByRole("region", { name: "Transcript" });
    const trigger = screen.getByRole("button", { name: /Change model/u });
    await userEvent.click(trigger);
    let dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(transcript).not.toHaveAttribute("inert");
    const search = within(dialog).getByRole("combobox", {
      name: "Search models",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Confirm selection",
    });
    await waitFor(() => expect(search).toHaveFocus());
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(search).toHaveFocus();

    await userEvent.type(search, "claude");
    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(dialog).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Model and reasoning" }),
    ).toBeNull();

    await userEvent.click(trigger);
    dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    await userEvent.click(screen.getByTestId("generation-selection-backdrop"));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Model and reasoning" }),
    ).toBeNull();
  });

  it("opens an unavailable rerun replacement and preserves it after a rejected mutation", async () => {
    const {
      fixtures: { GENERATION_CATALOG_RESPONSE, RUN_SELECTION },
      CandidateGenerationPicker,
    } = requireCutoverSupport();
    vi.stubGlobal("fetch", async () => json(GENERATION_CATALOG_RESPONSE));
    const onConfirm = vi.fn(async () => false);
    render(
      withRenderEnvironment(
        <div style={{ position: "fixed", insetInlineStart: 16, insetBlockEnd: 16 }}>
          <CandidateGenerationPicker
            operation="Rerun"
            runSelection={{
              ...RUN_SELECTION,
              selection: {
                route: "CodexPersonal",
                model: "retired-history-only",
                reasoning: "high",
              },
              current_state: {
                kind: "Retired",
                explanation: "This historical target is retired.",
                upgrade_target: { kind: "Absent" },
              },
              rerun_eligibility: false,
            }}
            openRequestVersion={1}
            onConfirm={onConfirm}
          />
        </div>,
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Rerun with a different model",
    });
    expect(
      within(dialog).getByText(/previous exact selection is no longer available/u),
    ).toBeVisible();
    const replacementConfirm = within(dialog).getByRole("button", {
      name: "Confirm selection",
    });
    replacementConfirm.scrollIntoView({ block: "center" });
    await userEvent.click(replacementConfirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByText(/exact selection is still pending/u),
    ).toBeVisible();
  });

  it("keeps the picker usable and requires an explicit replacement when only the seed is unavailable", async () => {
    const { CATALOG_REVISION, GENERATION_CATALOG } =
      requireCutoverSupport().fixtures;
    const seedUnavailable = {
      kind: "Ineligible",
      code: "missing_chat_tool_qualification",
      explanation: "GPT-5.6 Terra medium is not qualified for both current Chat tool plans.",
    } as const;
    const catalog = mutableRecord(
      catalogWithTerraReasoningState(GENERATION_CATALOG, "medium", seedUnavailable),
      "generation catalog",
    );
    mutableRecord(catalog.chat_seed, "generation catalog chat seed").state =
      seedUnavailable;
    const requests: ChatRunCreateRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/llm-catalog") return json({ data: catalog });
        if (path === "/api/chat-runs" && init?.method === "POST") {
          requests.push(JSON.parse(String(init.body)) as ChatRunCreateRequest);
          return json(admittedRun("ReadOnly"));
        }
        throw new Error(`Unexpected generation request: ${path}`);
      },
    );

    render(withRenderEnvironment(<Composer />));
    const input = await screen.findByRole("textbox", { name: "Ask anything" });
    await userEvent.type(input, "Answer with a replacement model");
    expect(
      await screen.findByText(
        "The exact selection is unavailable. Open the model picker to review the reason and choose a replacement; nothing was substituted.",
      ),
    ).toBeVisible();
    const trigger = screen.getByRole("button", {
      name: "Change model. Codex Personal, GPT-5.6 Terra, Medium, Codex subscription",
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Model and reasoning",
    });
    expect(
      within(dialog).getByRole("radio", { name: /^Medium/u }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(dialog).getByRole("option", { name: "Claude Sonnet 4.5, Active, Ready" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(requests).toHaveLength(0);
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search models" }),
      "claude",
    );
    await userEvent.keyboard("{Enter}");

    expect(
      await screen.findByRole("button", {
        name: "Change model. Anthropic API, Claude Sonnet 4.5, High, Metered API",
      }),
    ).toBeVisible();
    const send = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      catalog_definition_revision: CATALOG_REVISION,
      selection: {
        route: "ProviderApi",
        model_ref: "anthropic:claude-sonnet-4-5",
        reasoning: "high",
      },
      tool_authority: "ReadOnly",
    });
  });


  it("inherits the selected-path leaf pair for a continuation and the branch parent pair for a fork reply", async () => {
    const requests: ChatRunCreateRequest[] = [];
    stubConversationFetch(twoTurnTree("complete"), (pathname, init) => {
      if (pathname === "/api/chat-runs" && init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)) as ChatRunCreateRequest);
        return json(admittedRun("ReadOnly"));
      }
      return undefined;
    });

    render(withRenderEnvironment(<ConversationHarness />));
    expect(
      await screen.findByRole("button", {
        name: "Change model. Codex Personal, GPT-5.6 Terra, High, Codex subscription",
      }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Fork from the first answer" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Change model. Anthropic API, Claude Sonnet 4.5, High, Metered API",
      }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Fork reply" })).toBeVisible();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask anything" }),
      "Continue from the first answer",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      selection: CLAUDE_HIGH,
      destination: {
        kind: "Existing",
        insertion: { kind: "Reply", parent_message_id: FIRST_ASSISTANT_ID },
      },
    });
  });

});
