import type { Schema } from "@/lib/api/wire";
import type { Catalog, Selection } from "./wire";

// The exact generation a draft will run: chosen from the catalog, never
// substituted. The browser owns no allowlist; the server rejects stale choices.

export const CHOICE_UNAVAILABLE = "this choice isn’t available now.";

export type Route = Schema<"CodexPersonalRoute"> | Schema<"ProviderApiRoute">;
type CatalogRoute = Catalog["routes"][number];
type CatalogModel = CatalogRoute["models"][number];
export type ReasoningChoice = CatalogModel["reasoning"][number];
type Unready = Exclude<ReasoningChoice["chat_state"], { kind: "Selectable" }> | Exclude<CatalogRoute["readiness"], { kind: "Ready" }>;
/** A draft keeps incomplete intent; only `Selected` can be sent. */
export type SelectionEditor =
  | { readonly kind: "Uninitialized" }
  | { readonly kind: "DefaultUnavailable"; readonly route: Route; readonly model_key: string; readonly mode: string | null }
  | { readonly kind: "Selected"; readonly selection: Selection; readonly route: Route };
export type ModelVariant = {
  key: string;
  model: CatalogModel;
  mode: string | null;
  reasoning: ReasoningChoice[];
  selectable: ReasoningChoice[];
  unavailable: string | null;
};

const modelKeyOf = (selection: Selection) =>
  selection.route === "CodexPersonal" ? selection.model : selection.model_ref;

export const routeKey = (route: Route) =>
  route.kind === "CodexPersonal"
    ? "CodexPersonal"
    : `ProviderApi:${route.provider}`;

export const selectionKey = (selection: Selection) =>
  JSON.stringify([selection.route, modelKeyOf(selection), selection.reasoning]);

const variantKey = (modelKey: string, mode: string | null) =>
  JSON.stringify([modelKey, mode]);

/** Only actual model/mode combinations become options, in source order. */
export function modelVariants(row: CatalogRoute, refused: (selection: Selection) => boolean): ModelVariant[] {
  return row.models.flatMap((model) =>
    [...new Set(model.reasoning.map((choice) => choice.mode))].flatMap((mode) => {
      const reasoning = model.reasoning
        .filter((choice) => choice.mode === mode)
        .sort((a, b) => a.effort_order - b.effort_order);
      const selectable = row.readiness.kind === "Ready" ? reasoning.filter(choice =>
        choice.chat_state.kind === "Selectable" && !refused(chooseThinking(row.route, model.key, choice.key).selection)) : [];
      const unavailable = row.readiness.kind !== "Ready" ? unreadyReason(row.readiness)
        : selectable.length > 0 ? null : choiceUnavailable(reasoning[0]) ?? CHOICE_UNAVAILABLE;
      return [{ key: variantKey(model.key, mode), model, mode, reasoning, selectable, unavailable }];
    }),
  );
}

/** Why a route or choice can't run, by kind and code. Closed: the server's explanation is
 * operator voice and never reaches the screen. */
export function unreadyReason(state: Unready): string {
  switch (state.kind) {
    case "TemporarilyUnavailable":
      return "this provider isn’t reachable now.";
    case "OperatorActionRequired":
      switch (state.code) {
        case "codex_host_unavailable": return "this provider needs repair.";
        case "required_tool_unavailable": return "chat tools aren’t set up.";
      }
    case "Ineligible":
      switch (state.code) {
        case "unsupported_capability": return "this model can’t run chat.";
        case "selection_not_configured": return "the default model isn’t set up.";
      }
  }
}

export function choiceUnavailable(choice: ReasoningChoice): string | null {
  return choice.chat_state.kind === "Selectable" ? null : unreadyReason(choice.chat_state);
}

/** An explicit model activation chooses its declared runnable default or waits for effort. */
export function chooseModel(route: Route, variant: ModelVariant): SelectionEditor {
  const choice = variant.selectable.find(row => row.chat_default);
  return choice ? chooseThinking(route, variant.model.key, choice.key)
    : { kind: "DefaultUnavailable", route, model_key: variant.model.key, mode: variant.mode };
}

export function chooseThinking(
  route: Route,
  modelKey: string,
  reasoningKey: string,
): Extract<SelectionEditor, { kind: "Selected" }> {
  return {
    kind: "Selected",
    route,
    selection:
      route.kind === "CodexPersonal"
        ? { route: "CodexPersonal", model: modelKey, reasoning: reasoningKey }
        : {
            route: "ProviderApi",
            model_ref: modelKey,
            reasoning: reasoningKey,
          },
  };
}

/** Resolve saved identities at their own level. An absent opaque reasoning key
 * supplies neither a mode nor a substitute effort. */
export function resolveSelection(catalog: Catalog | null, value: SelectionEditor, refused: (selection: Selection) => boolean) {
  const route = value.kind === "Uninitialized" ? null : value.route;
  const row = route ? catalog?.routes.find(item => routeKey(item.route) === routeKey(route)) ?? null : null;
  const modelKey = value.kind === "Selected" ? modelKeyOf(value.selection)
    : value.kind === "DefaultUnavailable" ? value.model_key : null;
  const model = row?.models.find(item => item.key === modelKey) ?? null;
  const effort = value.kind === "Selected" ? model?.reasoning.find(item => item.key === value.selection.reasoning) ?? null : null;
  const mode = value.kind === "DefaultUnavailable" ? value.mode : effort?.mode;
  const variant = !row || mode === undefined ? null : modelVariants(row, refused).find(item => item.model.key === modelKey && item.mode === mode) ?? null;

  let reason: string | null = null;
  if (catalog && value.kind !== "Uninitialized") {
    if (value.kind === "Selected" && refused(value.selection)) reason = CHOICE_UNAVAILABLE;
    else if (!row) reason = "this provider isn’t available now.";
    else if (row.readiness.kind !== "Ready") reason = unreadyReason(row.readiness);
    else if (value.kind === "DefaultUnavailable") reason = variant ? variant.unavailable ?? "your default effort isn’t available now." : "your default model isn’t available now.";
    else if (!model) reason = "this model isn’t available now.";
    else if (!effort) reason = "this setting isn’t available for this model.";
    else reason = choiceUnavailable(effort);
  }
  return { value, route, modelKey, model, effort, variant, reason };
}
export type ResolvedSelection = ReturnType<typeof resolveSelection>;
