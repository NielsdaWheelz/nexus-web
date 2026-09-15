import type {
  GenerationCatalog,
  RunSelectionOut,
} from "@/lib/conversations/generationCatalog";

export const CATALOG_REVISION = "a".repeat(64);
export const SOURCE_CATALOG_REVISION = "b".repeat(64);
export const READY_AT = "2026-08-31T20:00:00Z";

const ready = { kind: "Ready" as const, last_checked: READY_AT };
const privacy = {
  summary: "Private account request",
  retention: "Provider retention applies",
  training: "Not used for training",
};

export const GENERATION_CATALOG: GenerationCatalog = {
  definition_revision: CATALOG_REVISION,
  observed_at: READY_AT,
  chat_seed: {
    policy_revision: "chat-seed.v1",
    selection: {
      route: "CodexPersonal",
      model: "gpt-5.6-terra",
      reasoning: "medium",
    },
    state: { kind: "Selectable" },
    presentation: {
      route_label: "Codex Personal",
      model_label: "GPT-5.6 Terra",
      reasoning_label: "Medium",
      billing: { kind: "Subscription", label: "Codex subscription" },
      privacy,
      processor_chain: { processors: ["Codex Personal"] },
    },
  },
  routes: [
    {
      route: { kind: "CodexPersonal" },
      label: "Codex Personal",
      readiness: ready,
      billing: { kind: "Subscription", label: "Codex subscription" },
      privacy,
      processor_chain: { processors: ["Nexus", "Codex Personal"] },
      models: [
        {
          key: "gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          description: "General-purpose Codex model.",
          source_context_window: { kind: "Absent" },
          source_max_output_tokens: { kind: "Absent" },
          effective_chat_context_budget_tokens: 32_000,
          effective_chat_output_budget_tokens: 8_000,
          lifecycle: "Active",
          retires_at: { kind: "Absent" },
          upgrade_selection: { kind: "Absent" },
          readiness: ready,
          input_modalities: ["text"],
          qualified_capabilities: ["Text", "ToolsContinuation"],
          source_default_reasoning: { kind: "Present", value: "medium" },
          reasoning: [
            {
              key: "medium",
              label: "Medium",
              readiness: ready,
              chat_state: { kind: "Selectable" },
              target_qualification_revision: {
                kind: "Present",
                value: "target-medium-v1",
              },
              reasoning_wire_qualification_revision: {
                kind: "Present",
                value: "wire-medium-v1",
              },
            },
            {
              key: "high",
              label: "High",
              readiness: ready,
              chat_state: { kind: "Selectable" },
              target_qualification_revision: {
                kind: "Present",
                value: "target-high-v1",
              },
              reasoning_wire_qualification_revision: {
                kind: "Present",
                value: "wire-high-v1",
              },
            },
          ],
        },
        {
          key: "gpt-5.5-retired",
          label: "GPT-5.5 Retired",
          description: "A retired model retained for transparent history.",
          source_context_window: { kind: "Absent" },
          source_max_output_tokens: { kind: "Absent" },
          effective_chat_context_budget_tokens: 24_000,
          effective_chat_output_budget_tokens: 6_000,
          lifecycle: "Retired",
          retires_at: { kind: "Present", value: READY_AT },
          upgrade_selection: {
            kind: "Present",
            value: {
              route: "ProviderApi",
              model_ref: "anthropic:claude-sonnet-4-5",
              reasoning: "high",
            },
          },
          readiness: ready,
          input_modalities: ["text"],
          qualified_capabilities: ["Text"],
          source_default_reasoning: { kind: "Absent" },
          reasoning: [
            {
              key: "high",
              label: "High",
              readiness: ready,
              chat_state: {
                kind: "Retired",
                explanation: "This model is retired.",
                upgrade_target: {
                  kind: "Present",
                  value: {
                    route: "ProviderApi",
                    model_ref: "anthropic:claude-sonnet-4-5",
                    reasoning: "high",
                  },
                },
              },
              target_qualification_revision: { kind: "Absent" },
              reasoning_wire_qualification_revision: { kind: "Absent" },
            },
          ],
        },
      ],
    },
    {
      route: { kind: "ProviderApi", provider: "anthropic" },
      label: "Anthropic API",
      readiness: ready,
      billing: { kind: "MeteredApi", label: "Metered API" },
      privacy,
      processor_chain: { processors: ["Nexus", "Anthropic API"] },
      models: [
        {
          key: "anthropic:claude-sonnet-4-5",
          label: "Claude Sonnet 4.5",
          description: "Provider API model.",
          source_context_window: { kind: "Present", value: 200_000 },
          source_max_output_tokens: { kind: "Present", value: 64_000 },
          effective_chat_context_budget_tokens: 48_000,
          effective_chat_output_budget_tokens: 12_000,
          lifecycle: "Active",
          retires_at: { kind: "Absent" },
          upgrade_selection: { kind: "Absent" },
          readiness: ready,
          input_modalities: ["text", "image"],
          qualified_capabilities: ["Text", "ToolsContinuation"],
          source_default_reasoning: { kind: "Present", value: "high" },
          reasoning: [
            {
              key: "high",
              label: "High",
              readiness: ready,
              chat_state: { kind: "Selectable" },
              target_qualification_revision: {
                kind: "Present",
                value: "target-claude-v1",
              },
              reasoning_wire_qualification_revision: {
                kind: "Present",
                value: "wire-claude-high-v1",
              },
            },
          ],
        },
      ],
    },
  ],
};

export const RUN_SELECTION: RunSelectionOut = {
  selection: GENERATION_CATALOG.chat_seed.selection,
  catalog_definition_revision: CATALOG_REVISION,
  source_catalog_definition_revision: SOURCE_CATALOG_REVISION,
  display_at_dispatch: GENERATION_CATALOG.chat_seed.presentation,
  tool_authority: "ReadOnly",
  current_state: { kind: "Selectable" },
  current_state_observed_at: READY_AT,
  rerun_eligibility: true,
};

export const GENERATION_CATALOG_RESPONSE = { data: GENERATION_CATALOG };
