import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  expectArray,
  expectExactRecord,
  expectNonemptyString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export type GenerationApiProvider = Schema<"GenerationApiProvider">;
export type GenerationSelectionSpec =
  | Schema<"CodexPersonalSelection">
  | Schema<"ProviderApiSelection">;
export type GenerationRoute =
  | Schema<"CodexPersonalRoute">
  | Schema<"ProviderApiRoute">;
export type GenerationReadiness =
  | Schema<"Ready">
  | Schema<"OperatorActionRequired">
  | Schema<"TemporarilyUnavailable">;
export type GenerationSelectionState =
  | Schema<"Selectable">
  | Schema<"Ineligible">
  | Schema<"OperatorActionRequired">
  | Schema<"TemporarilyUnavailable">;
type BillingDisclosure = Schema<"SubscriptionBilling"> | Schema<"MeteredApiBilling">;
export type PrivacyDisclosure = Schema<"PrivacyDisclosure">;
export type ProcessorChain = Schema<"ProcessorChain">;
export type SelectionPresentation = Schema<"SelectionPresentation">;
export type GenerationReasoningRow = Schema<"GenerationReasoningRow">;
export type GenerationModelRow = Schema<"GenerationModelRow">;
export type GenerationCatalogRoute = Schema<"GenerationCatalogRoute">;
export type ChatSeed = Schema<"ChatSeed">;
export type GenerationCatalog = ApiJson<"/llm-catalog", "get">["data"];

export interface RunSelectionOut {
  readonly selection: GenerationSelectionSpec;
  readonly catalog_definition_revision: string;
  readonly source_catalog_definition_revision: string;
  readonly display_at_dispatch: SelectionPresentation;
  readonly tool_authority: "ReadOnly" | "AdditiveWrites";
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

export function decodeRunSelectionOut(raw: unknown, name: string): RunSelectionOut {
  const value = expectExactRecord(
    raw,
    [
      "selection",
      "catalog_definition_revision",
      "source_catalog_definition_revision",
      "display_at_dispatch",
      "tool_authority",
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
