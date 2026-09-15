import type { RunSelectionOut } from "./generationCatalog";

export const RUN_SELECTION: RunSelectionOut = {
  selection: {
    route: "CodexPersonal",
    model: "gpt-5.6-terra",
    reasoning: "medium",
  },
  catalog_definition_revision: "a".repeat(64),
  source_catalog_definition_revision: "b".repeat(64),
  display_at_dispatch: {
    route_label: "Codex Personal",
    model_label: "GPT-5.6 Terra",
    reasoning_label: "Medium",
    billing: { kind: "Subscription", label: "Codex subscription" },
    privacy: {
      summary: "Private account request",
      retention: "Provider retention applies",
      training: "Not used for training",
    },
    processor_chain: { processors: ["Codex Personal"] },
  },
  tool_authority: "ReadOnly",
  current_state: { kind: "Selectable" },
  current_state_observed_at: "2026-08-31T20:00:00Z",
  rerun_eligibility: true,
};
