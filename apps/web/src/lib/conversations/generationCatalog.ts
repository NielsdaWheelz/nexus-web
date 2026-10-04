import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  expectExactRecord,
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
export type GenerationReasoningRow = Schema<"GenerationReasoningRow">;
export type GenerationModelRow = Schema<"GenerationModelRow">;
export type GenerationCatalogRoute = Schema<"GenerationCatalogRoute">;
export type ChatSeed = Schema<"ChatSeed">;
export type GenerationCatalog = ApiJson<"/llm-catalog", "get">["data"];

export type RunSelectionOut = Schema<"RunSelectionOut">;

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
const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_REF_RE = /^[a-z0-9][a-z0-9._:/-]{0,255}$/;

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
