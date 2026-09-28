import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectIsoInstant,
  expectNonemptyString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export type GenerationApiProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "xai";

export type GenerationSelectionSpec =
  | {
      readonly route: "CodexPersonal";
      readonly model: string;
      readonly reasoning: string;
    }
  | {
      readonly route: "ProviderApi";
      readonly model_ref: string;
      readonly reasoning: string;
    };

export type GenerationRoute =
  | { readonly kind: "CodexPersonal" }
  | {
      readonly kind: "ProviderApi";
      readonly provider: GenerationApiProvider;
    };

export type GenerationReadiness =
  | { readonly kind: "Ready"; readonly last_checked: string }
  | {
      readonly kind: "OperatorActionRequired";
      readonly code: GenerationReadinessCode;
      readonly explanation: string;
      readonly action: string;
      readonly last_checked: string;
    }
  | {
      readonly kind: "TemporarilyUnavailable";
      readonly code: GenerationReadinessCode;
      readonly explanation: string;
      readonly action: string;
      readonly last_checked: string;
    };

export type GenerationReadinessCode =
  | "catalog_refresh_failed"
  | "codex_host_unavailable"
  | "credential_unavailable"
  | "required_tool_unavailable";

export type GenerationSelectionState =
  | { readonly kind: "Selectable" }
  | {
      readonly kind: "Ineligible";
      readonly code: "unsupported_capability" | "selection_not_configured";
      readonly explanation: string;
    }
  | Extract<GenerationReadiness, { readonly kind: "OperatorActionRequired" }>
  | Extract<GenerationReadiness, { readonly kind: "TemporarilyUnavailable" }>;

export type BillingDisclosure =
  | { readonly kind: "Subscription"; readonly label: "Codex subscription" }
  | { readonly kind: "MeteredApi"; readonly label: "Metered API" };

export interface PrivacyDisclosure {
  readonly summary: string;
  readonly retention: string;
  readonly training: string;
}

export interface ProcessorChain {
  readonly processors: readonly string[];
}

export interface SelectionPresentation {
  readonly route_label: string;
  readonly model_label: string;
  readonly reasoning_label: string;
  readonly billing: BillingDisclosure;
  readonly privacy: PrivacyDisclosure;
  readonly processor_chain: ProcessorChain;
}

export interface GenerationReasoningRow {
  readonly key: string;
  readonly label: string;
  readonly readiness: GenerationReadiness;
  readonly chat_state: GenerationSelectionState;
}

export interface GenerationModelRow {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly source_context_window: Presence<number>;
  readonly source_max_output_tokens: Presence<number>;
  readonly effective_chat_context_budget_tokens: number;
  readonly effective_chat_output_budget_tokens: number;
  readonly readiness: GenerationReadiness;
  readonly input_modalities: readonly ("text" | "image")[];
  readonly source_default_reasoning: Presence<string>;
  readonly reasoning: readonly GenerationReasoningRow[];
}

export interface GenerationCatalogRoute {
  readonly route: GenerationRoute;
  readonly label: string;
  readonly readiness: GenerationReadiness;
  readonly billing: BillingDisclosure;
  readonly privacy: PrivacyDisclosure;
  readonly processor_chain: ProcessorChain;
  readonly models: readonly GenerationModelRow[];
}

export interface ChatSeed {
  readonly policy_revision: string;
  readonly selection: GenerationSelectionSpec;
  readonly state: GenerationSelectionState;
  readonly presentation: SelectionPresentation;
}

export interface GenerationCatalog {
  readonly definition_revision: string;
  readonly observed_at: string;
  readonly chat_seed: ChatSeed;
  readonly routes: readonly GenerationCatalogRoute[];
}

export interface RunSelectionOut {
  readonly selection: GenerationSelectionSpec;
  readonly catalog_definition_revision: string;
  readonly source_catalog_definition_revision: string;
  readonly display_at_dispatch: SelectionPresentation;
  readonly tool_authority: "ReadOnly" | "AdditiveWrites";
  readonly current_state: GenerationSelectionState;
  readonly current_state_observed_at: string;
  readonly rerun_eligibility: boolean;
}

export interface GenerationCandidate {
  readonly route: GenerationCatalogRoute;
  readonly model: GenerationModelRow;
  readonly reasoning: GenerationReasoningRow;
  readonly selection: GenerationSelectionSpec;
}

export interface GenerationModelCandidate {
  readonly route: GenerationCatalogRoute;
  readonly model: GenerationModelRow;
}

const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "xai",
] as const;
const READINESS_CODES = [
  "catalog_refresh_failed",
  "codex_host_unavailable",
  "credential_unavailable",
  "required_tool_unavailable",
] as const;
const INELIGIBLE_CODES = [
  "unsupported_capability",
  "selection_not_configured",
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_REF_RE = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;

function expectSha256(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.length !== 64 || !SHA256_RE.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function expectPositiveInteger(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return raw;
}

function expectPattern(raw: unknown, name: string, pattern: RegExp): string {
  const value = expectString(raw, name);
  const match = pattern.exec(value);
  if (match === null || match.index !== 0 || match[0].length !== value.length) {
    throw new TypeError(`${name} has an invalid format`);
  }
  return value;
}

function expectReasoningKey(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.length === 0 || value.length > 64 || /[^!-~]/.test(value)) {
    throw new TypeError(`${name} must be 1–64 printable non-space ascii characters`);
  }
  return value;
}

export function decodeGenerationSelectionSpec(
  raw: unknown,
  name = "generation selection",
): GenerationSelectionSpec {
  const base = expectExactRecord(
    raw,
    typeof raw === "object" && raw !== null && "route" in raw && raw.route === "CodexPersonal"
      ? ["route", "model", "reasoning"]
      : ["route", "model_ref", "reasoning"],
    name,
  );
  if (base.route === "CodexPersonal") {
    return {
      route: "CodexPersonal",
      model: expectPattern(base.model, `${name}.model`, CODEX_MODEL_RE),
      reasoning: expectReasoningKey(base.reasoning, `${name}.reasoning`),
    };
  }
  if (base.route !== "ProviderApi") {
    throw new TypeError(`${name}.route must be CodexPersonal or ProviderApi`);
  }
  return {
    route: "ProviderApi",
    model_ref: expectPattern(base.model_ref, `${name}.model_ref`, MODEL_REF_RE),
    reasoning: expectReasoningKey(base.reasoning, `${name}.reasoning`),
  };
}

function decodeReadiness(raw: unknown, name: string): GenerationReadiness {
  if (typeof raw !== "object" || raw === null || !("kind" in raw)) {
    throw new TypeError(`${name} must be a readiness object`);
  }
  if (raw.kind === "Ready") {
    const value = expectExactRecord(raw, ["kind", "last_checked"], name);
    return {
      kind: "Ready",
      last_checked: expectIsoInstant(value.last_checked, `${name}.last_checked`),
    };
  }
  if (raw.kind !== "OperatorActionRequired" && raw.kind !== "TemporarilyUnavailable") {
    throw new TypeError(`${name}.kind is not a supported readiness variant`);
  }
  const value = expectExactRecord(
    raw,
    ["kind", "code", "explanation", "action", "last_checked"],
    name,
  );
  return {
    kind: raw.kind,
    code: expectOneOf(value.code, READINESS_CODES, `${name}.code`),
    explanation: expectNonemptyString(value.explanation, `${name}.explanation`),
    action: expectNonemptyString(value.action, `${name}.action`),
    last_checked: expectIsoInstant(value.last_checked, `${name}.last_checked`),
  };
}

function decodeSelectionState(
  raw: unknown,
  name: string,
): GenerationSelectionState {
  if (typeof raw !== "object" || raw === null || !("kind" in raw)) {
    throw new TypeError(`${name} must be a selection-state object`);
  }
  if (raw.kind === "Selectable") {
    expectExactRecord(raw, ["kind"], name);
    return { kind: "Selectable" };
  }
  if (raw.kind === "Ineligible") {
    const value = expectExactRecord(raw, ["kind", "code", "explanation"], name);
    return {
      kind: "Ineligible",
      code: expectOneOf(value.code, INELIGIBLE_CODES, `${name}.code`),
      explanation: expectNonemptyString(value.explanation, `${name}.explanation`),
    };
  }
  const readiness = decodeReadiness(raw, name);
  if (readiness.kind === "Ready") {
    throw new TypeError(`${name}.kind Ready is not a selection-state variant`);
  }
  return readiness;
}

function decodeBilling(raw: unknown, name: string): BillingDisclosure {
  const value = expectExactRecord(raw, ["kind", "label"], name);
  if (value.kind === "Subscription" && value.label === "Codex subscription") {
    return { kind: "Subscription", label: "Codex subscription" };
  }
  if (value.kind === "MeteredApi" && value.label === "Metered API") {
    return { kind: "MeteredApi", label: "Metered API" };
  }
  throw new TypeError(`${name} must be a supported billing disclosure`);
}

function decodePrivacy(raw: unknown, name: string): PrivacyDisclosure {
  const value = expectExactRecord(raw, ["summary", "retention", "training"], name);
  return {
    summary: expectNonemptyString(value.summary, `${name}.summary`),
    retention: expectNonemptyString(value.retention, `${name}.retention`),
    training: expectNonemptyString(value.training, `${name}.training`),
  };
}

function decodeProcessorChain(raw: unknown, name: string): ProcessorChain {
  const value = expectExactRecord(raw, ["processors"], name);
  const processors = expectArray(
    value.processors,
    (processor, index) =>
      expectNonemptyString(processor, `${name}.processors[${index}]`),
    `${name}.processors`,
  );
  if (processors.length === 0 || processors.length > 4) {
    throw new TypeError(`${name}.processors must contain one to four rows`);
  }
  return { processors };
}

export function decodeSelectionPresentation(
  raw: unknown,
  name: string,
): SelectionPresentation {
  const value = expectExactRecord(
    raw,
    [
      "route_label",
      "model_label",
      "reasoning_label",
      "billing",
      "privacy",
      "processor_chain",
    ],
    name,
  );
  return {
    route_label: expectNonemptyString(value.route_label, `${name}.route_label`),
    model_label: expectNonemptyString(value.model_label, `${name}.model_label`),
    reasoning_label: expectNonemptyString(
      value.reasoning_label,
      `${name}.reasoning_label`,
    ),
    billing: decodeBilling(value.billing, `${name}.billing`),
    privacy: decodePrivacy(value.privacy, `${name}.privacy`),
    processor_chain: decodeProcessorChain(
      value.processor_chain,
      `${name}.processor_chain`,
    ),
  };
}

function decodeReasoning(
  raw: unknown,
  name: string,
): GenerationReasoningRow {
  const value = expectExactRecord(
    raw,
    [
      "key",
      "label",
      "readiness",
      "chat_state",
    ],
    name,
  );
  return {
    key: expectReasoningKey(value.key, `${name}.key`),
    label: expectNonemptyString(value.label, `${name}.label`),
    readiness: decodeReadiness(value.readiness, `${name}.readiness`),
    chat_state: decodeSelectionState(value.chat_state, `${name}.chat_state`),
  };
}

function decodeModel(raw: unknown, name: string): GenerationModelRow {
  const value = expectExactRecord(
    raw,
    [
      "key",
      "label",
      "description",
      "source_context_window",
      "source_max_output_tokens",
      "effective_chat_context_budget_tokens",
      "effective_chat_output_budget_tokens",
      "readiness",
      "input_modalities",
      "source_default_reasoning",
      "reasoning",
    ],
    name,
  );
  const reasoning = expectArray(
    value.reasoning,
    (entry, index) => decodeReasoning(entry, `${name}.reasoning[${index}]`),
    `${name}.reasoning`,
  );
  if (reasoning.length === 0) {
    throw new TypeError(`${name}.reasoning must not be empty`);
  }
  if (new Set(reasoning.map((option) => option.key)).size !== reasoning.length) {
    throw new TypeError(`${name}.reasoning contains duplicate keys`);
  }
  const sourceDefaultReasoning = decodePresence(
    value.source_default_reasoning,
    (reasoningKey) =>
      expectReasoningKey(reasoningKey, `${name}.source_default_reasoning.value`),
  );
  if (
    sourceDefaultReasoning.kind === "Present" &&
    !reasoning.some((option) => option.key === sourceDefaultReasoning.value)
  ) {
    throw new TypeError(`${name}.source_default_reasoning is absent from reasoning`);
  }
  return {
    key: expectNonemptyString(value.key, `${name}.key`),
    label: expectNonemptyString(value.label, `${name}.label`),
    description: expectNonemptyString(value.description, `${name}.description`),
    source_context_window: decodePresence(value.source_context_window, (capacity) =>
      expectPositiveInteger(capacity, `${name}.source_context_window.value`),
    ),
    source_max_output_tokens: decodePresence(
      value.source_max_output_tokens,
      (capacity) =>
        expectPositiveInteger(capacity, `${name}.source_max_output_tokens.value`),
    ),
    effective_chat_context_budget_tokens: expectPositiveInteger(
      value.effective_chat_context_budget_tokens,
      `${name}.effective_chat_context_budget_tokens`,
    ),
    effective_chat_output_budget_tokens: expectPositiveInteger(
      value.effective_chat_output_budget_tokens,
      `${name}.effective_chat_output_budget_tokens`,
    ),
    readiness: decodeReadiness(value.readiness, `${name}.readiness`),
    input_modalities: expectArray(
      value.input_modalities,
      (modality, index) =>
        expectOneOf(
          modality,
          ["text", "image"] as const,
          `${name}.input_modalities[${index}]`,
        ),
      `${name}.input_modalities`,
    ),
    source_default_reasoning: sourceDefaultReasoning,
    reasoning,
  };
}

export function decodeGenerationRoute(raw: unknown, name: string): GenerationRoute {
  const routeValue = expectExactRecord(
    raw,
    typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "CodexPersonal"
      ? ["kind"]
      : ["kind", "provider"],
    name,
  );
  if (routeValue.kind === "CodexPersonal") return { kind: "CodexPersonal" };
  if (routeValue.kind !== "ProviderApi") {
    throw new TypeError(`${name}.kind must be CodexPersonal or ProviderApi`);
  }
  return {
    kind: "ProviderApi",
    provider: expectOneOf(routeValue.provider, PROVIDERS, `${name}.provider`),
  };
}

function decodeRoute(raw: unknown, name: string): GenerationCatalogRoute {
  const value = expectExactRecord(
    raw,
    ["route", "label", "readiness", "billing", "privacy", "processor_chain", "models"],
    name,
  );
  const route = decodeGenerationRoute(value.route, `${name}.route`);
  const models = expectArray(
    value.models,
    (model, index) => decodeModel(model, `${name}.models[${index}]`),
    `${name}.models`,
  );
  if (models.length === 0) throw new TypeError(`${name}.models must not be empty`);
  return {
    route,
    label: expectNonemptyString(value.label, `${name}.label`),
    readiness: decodeReadiness(value.readiness, `${name}.readiness`),
    billing: decodeBilling(value.billing, `${name}.billing`),
    privacy: decodePrivacy(value.privacy, `${name}.privacy`),
    processor_chain: decodeProcessorChain(
      value.processor_chain,
      `${name}.processor_chain`,
    ),
    models,
  };
}

function decodeGenerationCatalog(raw: unknown): GenerationCatalog {
  const value = expectExactRecord(
    raw,
    ["definition_revision", "observed_at", "chat_seed", "routes"],
    "generation catalog",
  );
  const seed = expectExactRecord(
    value.chat_seed,
    ["policy_revision", "selection", "state", "presentation"],
    "generation catalog.chat_seed",
  );
  const routes = expectArray(
    value.routes,
    (route, index) => decodeRoute(route, `generation catalog.routes[${index}]`),
    "generation catalog.routes",
  );
  if (routes.length === 0) {
    throw new TypeError("generation catalog.routes must not be empty");
  }
  const modelRefs = new Set<string>();
  for (const route of routes) {
    for (const model of route.models) {
      const identity = `${route.route.kind}\u0000${model.key}`;
      if (modelRefs.has(identity)) {
        throw new TypeError(`generation catalog contains duplicate model ${model.key}`);
      }
      modelRefs.add(identity);
    }
  }
  const catalog: GenerationCatalog = {
    definition_revision: expectSha256(
      value.definition_revision,
      "generation catalog.definition_revision",
    ),
    observed_at: expectIsoInstant(
      value.observed_at,
      "generation catalog.observed_at",
    ),
    chat_seed: {
      policy_revision: expectNonemptyString(
        seed.policy_revision,
        "generation catalog.chat_seed.policy_revision",
      ),
      selection: decodeGenerationSelectionSpec(
        seed.selection,
        "generation catalog.chat_seed.selection",
      ),
      state: decodeSelectionState(
        seed.state,
        "generation catalog.chat_seed.state",
      ),
      presentation: decodeSelectionPresentation(
        seed.presentation,
        "generation catalog.chat_seed.presentation",
      ),
    },
    routes,
  };
  if (findGenerationCandidate(catalog, catalog.chat_seed.selection) === null) {
    throw new TypeError("generation catalog.chat_seed is absent from routes");
  }
  return catalog;
}

export function decodeGenerationCatalogResponse(raw: unknown): GenerationCatalog {
  const envelope = expectExactRecord(raw, ["data"], "generation catalog response");
  return decodeGenerationCatalog(envelope.data);
}

export function decodeRunSelectionOut(raw: unknown, name: string): RunSelectionOut {
  const value = expectExactRecord(
    raw,
    [
      "selection",
      "catalog_definition_revision",
      "source_catalog_definition_revision",
      "display_at_dispatch",
      "tool_authority",
      "current_state",
      "current_state_observed_at",
      "rerun_eligibility",
    ],
    name,
  );
  return {
    selection: decodeGenerationSelectionSpec(value.selection, `${name}.selection`),
    catalog_definition_revision: expectSha256(
      value.catalog_definition_revision,
      `${name}.catalog_definition_revision`,
    ),
    source_catalog_definition_revision: expectSha256(
      value.source_catalog_definition_revision,
      `${name}.source_catalog_definition_revision`,
    ),
    display_at_dispatch: decodeSelectionPresentation(
      value.display_at_dispatch,
      `${name}.display_at_dispatch`,
    ),
    tool_authority: expectOneOf(
      value.tool_authority,
      ["ReadOnly", "AdditiveWrites"] as const,
      `${name}.tool_authority`,
    ),
    current_state: decodeSelectionState(
      value.current_state,
      `${name}.current_state`,
    ),
    current_state_observed_at: expectIsoInstant(
      value.current_state_observed_at,
      `${name}.current_state_observed_at`,
    ),
    rerun_eligibility: expectBoolean(
      value.rerun_eligibility,
      `${name}.rerun_eligibility`,
    ),
  };
}

function generationSelectionKey(selection: GenerationSelectionSpec): string {
  return selection.route === "CodexPersonal"
    ? `CodexPersonal\u0000${selection.model}\u0000${selection.reasoning}`
    : `ProviderApi\u0000${selection.model_ref}\u0000${selection.reasoning}`;
}

export function sameGenerationSelection(
  left: GenerationSelectionSpec,
  right: GenerationSelectionSpec,
): boolean {
  return generationSelectionKey(left) === generationSelectionKey(right);
}

export function selectionFor(
  route: GenerationCatalogRoute,
  model: GenerationModelRow,
  reasoning: GenerationReasoningRow,
): GenerationSelectionSpec {
  return route.route.kind === "CodexPersonal"
    ? { route: "CodexPersonal", model: model.key, reasoning: reasoning.key }
    : {
        route: "ProviderApi",
        model_ref: model.key,
        reasoning: reasoning.key,
      };
}

export function findGenerationModel(
  catalog: GenerationCatalog,
  selection: GenerationSelectionSpec,
): GenerationModelCandidate | null {
  const modelKey = selection.route === "CodexPersonal" ? selection.model : selection.model_ref;
  for (const route of catalog.routes) {
    if (route.route.kind !== selection.route) continue;
    const model = route.models.find((row) => row.key === modelKey);
    if (model) return { route, model };
  }
  return null;
}

export function findGenerationCandidate(
  catalog: GenerationCatalog,
  selection: GenerationSelectionSpec,
): GenerationCandidate | null {
  const candidate = findGenerationModel(catalog, selection);
  const reasoning = candidate?.model.reasoning.find((row) => row.key === selection.reasoning);
  return candidate && reasoning ? { ...candidate, reasoning, selection } : null;
}

export function hasSelectableCandidate(catalog: GenerationCatalog): boolean {
  return catalog.routes.some((route) =>
    route.models.some((model) =>
      model.reasoning.some((reasoning) => reasoning.chat_state.kind === "Selectable"),
    ),
  );
}

export function selectionStateExplanation(state: GenerationSelectionState): string {
  switch (state.kind) {
    case "Selectable":
      return "Ready to use.";
    case "Ineligible":
    case "OperatorActionRequired":
    case "TemporarilyUnavailable":
      return state.explanation;
  }
}

export function readinessAction(readiness: GenerationReadiness): string | null {
  switch (readiness.kind) {
    case "Ready":
      return null;
    case "OperatorActionRequired":
    case "TemporarilyUnavailable":
      return readiness.action;
  }
}
