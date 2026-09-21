"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MobileSheet from "@/components/ui/MobileSheet";
import {
  findGenerationCandidate,
  readinessAction,
  sameGenerationSelection,
  selectionFor,
  selectionStateExplanation,
  type GenerationCatalog,
  type GenerationCatalogRoute,
  type GenerationModelRow,
  type GenerationReasoningRow,
  type GenerationSelectionSpec,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./GenerationSelectionPicker.module.css";

interface GenerationSelectionPickerProps {
  readonly catalog: GenerationCatalog;
  readonly value: GenerationSelectionSpec | null;
  readonly contextualSelection?: RunSelectionOut | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (
    selection: GenerationSelectionSpec,
  ) => void | boolean | Promise<void | boolean>;
  readonly disabled?: boolean;
  readonly refreshing?: boolean;
  readonly refreshError?: Error | null;
  readonly onRetryRefresh?: () => void;
  readonly writeAuthority: "ReadOnly" | "AdditiveWrites";
  readonly label?: string;
  readonly triggerActionLabel?: string;
}

interface ModelCandidate {
  readonly route: GenerationCatalogRoute;
  readonly model: GenerationModelRow;
  readonly key: string;
}

function routeKey(route: GenerationCatalogRoute): string {
  return route.route.kind === "CodexPersonal"
    ? "CodexPersonal"
    : `ProviderApi:${route.route.provider}`;
}

function modelCandidateKey(
  route: GenerationCatalogRoute,
  model: GenerationModelRow,
): string {
  return `${routeKey(route)}\u0000${model.key}`;
}

function modelReadinessLabel(model: GenerationModelRow): string {
  if (model.readiness.kind !== "Ready") return "Unavailable";
  return model.reasoning.some(
    (reasoning) => reasoning.chat_state.kind === "Selectable",
  )
    ? "Ready"
    : "Unavailable";
}

function candidateForModelKey(
  candidates: readonly ModelCandidate[],
  key: string | null,
): ModelCandidate | null {
  return candidates.find((candidate) => candidate.key === key) ?? null;
}

function filterModelCandidates(
  candidates: readonly ModelCandidate[],
  query: string,
): readonly ModelCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return candidates;
  return candidates.filter(({ route, model }) =>
    [model.key, model.label, route.label, route.route.kind]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

function modelSearchStatus(
  candidates: readonly ModelCandidate[],
  active: ModelCandidate | null,
): string {
  return `${candidates.length} ${candidates.length === 1 ? "model" : "models"}. ${
    active === null
      ? "No active model."
      : `${active.model.label}, ${modelReadinessLabel(active.model)}.`
  }`;
}

function modelUnavailableExplanation(model: GenerationModelRow): string | null {
  if (model.readiness.kind !== "Ready") return model.readiness.explanation;
  if (
    model.reasoning.some(
      (reasoning) => reasoning.chat_state.kind === "Selectable",
    )
  ) {
    return null;
  }
  const unavailable = model.reasoning.find(
    (reasoning) => reasoning.chat_state.kind !== "Selectable",
  );
  return unavailable === undefined
    ? null
    : selectionStateExplanation(unavailable.chat_state);
}

function triggerCopy(
  catalog: GenerationCatalog,
  selection: GenerationSelectionSpec | null,
  contextualSelection: RunSelectionOut | null,
): {
  readonly accessibleName: string;
  readonly route: string;
  readonly model: string;
  readonly reasoning: string;
  readonly billing: string;
} {
  const candidate =
    selection === null ? null : findGenerationCandidate(catalog, selection);
  if (candidate !== null) {
    return {
      accessibleName: `Change model. ${candidate.route.label}, ${candidate.model.label}, ${candidate.reasoning.label}, ${candidate.route.billing.label}`,
      route: candidate.route.label,
      model: candidate.model.label,
      reasoning: candidate.reasoning.label,
      billing: candidate.route.billing.label,
    };
  }
  if (
    contextualSelection !== null &&
    selection !== null &&
    sameGenerationSelection(contextualSelection.selection, selection)
  ) {
    const display = contextualSelection.display_at_dispatch;
    return {
      accessibleName: `Choose model. Previous selection unavailable: ${display.route_label}, ${display.model_label}, ${display.reasoning_label}, ${display.billing.label}`,
      route: display.route_label,
      model: display.model_label,
      reasoning: display.reasoning_label,
      billing: display.billing.label,
    };
  }
  return {
    accessibleName: "Choose model",
    route: "Model",
    model: "Choose model",
    reasoning: "No reasoning selected",
    billing: "Selection required",
  };
}

function capacityLabel(
  value: { kind: "Absent" } | { kind: "Present"; value: number },
  formatter: (value: number) => string,
): string {
  return value.kind === "Present" ? `${formatter(value.value)} tokens` : "Not reported";
}

export default function GenerationSelectionPicker({
  catalog,
  value,
  contextualSelection = null,
  open,
  onOpenChange,
  onConfirm,
  disabled = false,
  refreshing = false,
  refreshError = null,
  onRetryRefresh,
  writeAuthority,
  label = "Model and reasoning",
  triggerActionLabel,
}: GenerationSelectionPickerProps) {
  const display = useRenderEnvironment();
  const mobile = useIsMobileViewport();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const desktopPanelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const observedPendingStateRef = useRef<{
    readonly identity: string;
    readonly kind: string;
  } | null>(null);
  const id = useId().replaceAll(":", "");
  const dialogId = `${id}-dialog`;
  const listboxId = `${id}-models`;
  const detailsId = `${id}-details`;
  const blockerId = `${id}-blocker`;
  const [query, setQuery] = useState("");
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null);
  const [activeReasoningKey, setActiveReasoningKey] = useState<string | null>(
    null,
  );
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null);
  const [pendingReasoningKey, setPendingReasoningKey] = useState<string | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const allCandidates = useMemo<ModelCandidate[]>(
    () =>
      catalog.routes.flatMap((route) =>
        route.models.map((model) => ({
          route,
          model,
          key: modelCandidateKey(route, model),
        })),
      ),
    [catalog],
  );
  const filteredCandidates = useMemo(() => {
    return filterModelCandidates(allCandidates, query);
  }, [allCandidates, query]);

  const pendingModel = candidateForModelKey(allCandidates, pendingModelKey);
  const pendingReasoning =
    pendingModel?.model.reasoning.find(
      (reasoning) => reasoning.key === pendingReasoningKey,
    ) ?? null;
  const rovingReasoningKey =
    pendingModel?.model.reasoning.some(
      (reasoning) => reasoning.key === activeReasoningKey,
    ) === true
      ? activeReasoningKey
      : pendingModel?.model.reasoning[0]?.key ?? null;
  const pendingSelection =
    pendingModel !== null && pendingReasoning !== null
      ? selectionFor(pendingModel.route, pendingModel.model, pendingReasoning)
      : null;
  const pendingSelectable = pendingReasoning?.chat_state.kind === "Selectable";
  const pendingBlocker =
    pendingReasoning !== null
      ? selectionStateExplanation(pendingReasoning.chat_state)
      : pendingModel === null
        ? "Choose a model and reasoning level before confirming."
        : (modelUnavailableExplanation(pendingModel.model) ??
          "Choose a reasoning level before confirming.");
  const activeModel =
    candidateForModelKey(filteredCandidates, activeModelKey) ??
    filteredCandidates[0] ??
    null;
  const trigger = triggerCopy(catalog, value, contextualSelection);

  const resetUncommittedChoice = useCallback(() => {
    const selected =
      value === null ? null : findGenerationCandidate(catalog, value);
    const initialCandidate =
      selected ?? findGenerationCandidate(catalog, catalog.chat_seed.selection);
    const modelKey =
      initialCandidate === null
        ? allCandidates[0]?.key ?? null
        : modelCandidateKey(initialCandidate.route, initialCandidate.model);
    const reasoningKey =
      selected?.reasoning.key ?? initialCandidate?.reasoning.key ?? null;
    setQuery("");
    setActiveModelKey(modelKey);
    setPendingModelKey(modelKey);
    setActiveReasoningKey(
      reasoningKey ?? initialCandidate?.model.reasoning[0]?.key ?? null,
    );
    setPendingReasoningKey(reasoningKey);
    setStatus("");
  }, [allCandidates, catalog, value]);

  useEffect(() => {
    if (open && !wasOpenRef.current) resetUncommittedChoice();
    wasOpenRef.current = open;
  }, [open, resetUncommittedChoice]);

  useEffect(() => {
    if (!open || pendingModel === null || pendingReasoning === null) {
      observedPendingStateRef.current = null;
      return;
    }
    const current = {
      identity: `${pendingModel.key}\u0000${pendingReasoning.key}`,
      kind: pendingReasoning.chat_state.kind,
    };
    const previous = observedPendingStateRef.current;
    observedPendingStateRef.current = current;
    if (
      previous !== null &&
      previous.identity === current.identity &&
      previous.kind !== current.kind
    ) {
      setStatus(
        `Availability changed. ${selectionStateExplanation(pendingReasoning.chat_state)}`,
      );
    }
  }, [open, pendingModel, pendingReasoning]);

  useLayoutEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [mobile, open]);

  const dismiss = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open || mobile) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        desktopPanelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      dismiss(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [dismiss, mobile, open]);

  const chooseModel = useCallback((candidate: ModelCandidate) => {
    setActiveModelKey(candidate.key);
    setPendingModelKey(candidate.key);
    const defaultKey =
      candidate.model.source_default_reasoning.kind === "Present"
        ? candidate.model.source_default_reasoning.value
        : null;
    const defaultReasoning = candidate.model.reasoning.find(
      (reasoning) => reasoning.key === defaultKey,
    );
    setActiveReasoningKey(
      defaultReasoning?.key ?? candidate.model.reasoning[0]?.key ?? null,
    );
    setPendingReasoningKey(defaultKey);
    const unavailableExplanation = modelUnavailableExplanation(candidate.model);
    if (unavailableExplanation !== null) {
      setStatus(unavailableExplanation);
    } else if (defaultReasoning === undefined) {
      setStatus(
        `${candidate.model.label} has no source-reported default. Choose a reasoning level.`,
      );
    } else if (defaultReasoning.chat_state.kind !== "Selectable") {
      setStatus(selectionStateExplanation(defaultReasoning.chat_state));
    } else {
      setStatus(
        `${candidate.model.label}; ${defaultReasoning.label} reasoning selected from the source default.`,
      );
    }
  }, []);

  const chooseReasoning = useCallback((reasoning: GenerationReasoningRow) => {
    setActiveReasoningKey(reasoning.key);
    if (reasoning.chat_state.kind !== "Selectable") {
      setStatus(selectionStateExplanation(reasoning.chat_state));
      return;
    }
    setPendingReasoningKey(reasoning.key);
    setStatus(`${reasoning.label} reasoning selected.`);
  }, []);

  const confirmSelection = useCallback(
    async (selection: GenerationSelectionSpec) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const accepted = await onConfirm(selection);
        if (accepted !== false) {
          dismiss(true);
          return;
        }
        setStatus(
          "That run was not created. Your exact selection is still pending; review availability and confirm again.",
        );
      } catch {
        setStatus(
          "That run was not created. Your exact selection is still pending; review availability and confirm again.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [dismiss, onConfirm, submitting],
  );

  const commit = useCallback(
    (selection: GenerationSelectionSpec | null) => {
      if (selection === null || !pendingSelectable) {
        setStatus(pendingBlocker);
        return;
      }
      void confirmSelection(selection);
    },
    [confirmSelection, pendingBlocker, pendingSelectable],
  );

  const moveActiveModel = useCallback(
    (movement: "Next" | "Previous" | "First" | "Last") => {
      if (filteredCandidates.length === 0) return;
      const current = filteredCandidates.findIndex(
        (candidate) => candidate.key === activeModel?.key,
      );
      const index =
        movement === "First"
          ? 0
          : movement === "Last"
            ? filteredCandidates.length - 1
            : movement === "Next"
              ? (Math.max(current, -1) + 1) % filteredCandidates.length
              : (current <= 0 ? filteredCandidates.length : current) - 1;
      const next = filteredCandidates[index] ?? null;
      setActiveModelKey(next?.key ?? null);
      setStatus(modelSearchStatus(filteredCandidates, next));
    },
    [activeModel?.key, filteredCandidates],
  );

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveActiveModel("Next");
          return;
        case "ArrowUp":
          event.preventDefault();
          moveActiveModel("Previous");
          return;
        case "Home":
          event.preventDefault();
          moveActiveModel("First");
          return;
        case "End":
          event.preventDefault();
          moveActiveModel("Last");
          return;
        case "Enter": {
          event.preventDefault();
          if (activeModel === null) return;
          const unavailableExplanation = modelUnavailableExplanation(
            activeModel.model,
          );
          chooseModel(activeModel);
          if (unavailableExplanation !== null) {
            setStatus(unavailableExplanation);
            return;
          }
          const defaultKey =
            activeModel.model.source_default_reasoning.kind === "Present"
              ? activeModel.model.source_default_reasoning.value
              : null;
          const defaultReasoning = activeModel.model.reasoning.find(
            (reasoning) => reasoning.key === defaultKey,
          );
          if (defaultReasoning?.chat_state.kind === "Selectable") {
            void confirmSelection(
              selectionFor(
                activeModel.route,
                activeModel.model,
                defaultReasoning,
              ),
            );
          } else {
            requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>(`#${id}-reasoning [role='radio']`)
                ?.focus();
            });
          }
          return;
        }
      }
    },
    [activeModel, chooseModel, confirmSelection, id, moveActiveModel],
  );

  const clearSearch = useCallback(() => {
    const nextActive =
      candidateForModelKey(allCandidates, activeModelKey) ??
      allCandidates[0] ??
      null;
    setQuery("");
    setActiveModelKey(nextActive?.key ?? null);
    setStatus(`Search cleared. ${modelSearchStatus(allCandidates, nextActive)}`);
  }, [activeModelKey, allCandidates]);

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query !== "") {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (mobile) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    },
    [clearSearch, dismiss, mobile, query],
  );

  const onDesktopDialogBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      const dialog = event.currentTarget;
      // Let the browser complete sequential focus navigation before removing
      // the popover. Synchronous unmount here strands focus on <body> when Tab
      // exits from the final control instead of reaching the next page control.
      window.setTimeout(() => {
        if (!dialog.contains(document.activeElement)) onOpenChange(false);
      }, 0);
    },
    [onOpenChange],
  );

  const content = (
    <div className={styles.content} onKeyDown={onPanelKeyDown}>
      <div className={styles.heading}>
        <div>
          <h2>{label}</h2>
          <p>Choose the exact model and reasoning for this run.</p>
        </div>
        {refreshing ? <span role="status">Refreshing availability…</span> : null}
      </div>

      {refreshError !== null ? (
        <div className={styles.refreshNotice} role="status">
          <span>
            Availability could not be refreshed. Showing the last valid catalog as stale.
          </span>
          {onRetryRefresh ? (
            <Button variant="secondary" size="sm" onClick={onRetryRefresh}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <label className={styles.searchLabel}>
        <span className="sr-only">Search models</span>
        <Search size={16} aria-hidden="true" />
        <Input
          ref={searchRef}
          variant="bare"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            const nextCandidates = filterModelCandidates(
              allCandidates,
              nextQuery,
            );
            const nextActive = nextCandidates[0] ?? null;
            setQuery(nextQuery);
            setActiveModelKey(nextActive?.key ?? null);
            setStatus(modelSearchStatus(nextCandidates, nextActive));
          }}
          onKeyDown={onSearchKeyDown}
          role="combobox"
          aria-label="Search models"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={
            activeModel === null ? undefined : `${id}-model-${allCandidates.indexOf(activeModel)}`
          }
          aria-describedby={detailsId}
          placeholder="Search models and providers"
        />
      </label>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status || modelSearchStatus(filteredCandidates, activeModel)}
      </p>

      <div className={styles.body}>
        <div className={styles.modelViewport}>
          <ul id={listboxId} className={styles.modelList} role="listbox" aria-label="Models">
            {catalog.routes.map((route) => {
              const routeCandidates = filteredCandidates.filter(
                (candidate) => candidate.route === route,
              );
              if (routeCandidates.length === 0) return null;
              const groupId = `${id}-group-${catalog.routes.indexOf(route)}`;
              return (
                <li key={routeKey(route)} role="group" aria-labelledby={groupId}>
                  <header className={styles.routeHeader} id={groupId}>
                    <strong>{route.label}</strong>
                    <span>{route.billing.label}</span>
                    <small>
                      {route.processor_chain.processors.join(" → ")} · {route.privacy.summary} {route.privacy.retention} {route.privacy.training}
                    </small>
                  </header>
                  <ul role="presentation">
                    {routeCandidates.map((candidate) => {
                      const active = candidate.key === activeModel?.key;
                      const selected = candidate.key === pendingModelKey;
                      const readiness = modelReadinessLabel(candidate.model);
                      const unavailable = readiness !== "Ready";
                      const modelIndex = allCandidates.indexOf(candidate);
                      const explanationId = `${id}-model-${modelIndex}-explanation`;
                      return (
                        <li
                          id={`${id}-model-${modelIndex}`}
                          key={candidate.key}
                          role="option"
                          aria-label={`${candidate.model.label}, ${readiness}`}
                          aria-selected={selected}
                          aria-disabled={unavailable ? "true" : undefined}
                          aria-describedby={unavailable ? explanationId : undefined}
                          data-active={active ? "true" : undefined}
                          className={styles.modelOption}
                          onPointerMove={() => setActiveModelKey(candidate.key)}
                          onClick={() => chooseModel(candidate)}
                        >
                          <span>
                            <strong>{candidate.model.label}</strong>
                            <small>{candidate.model.key}</small>
                          </span>
                          <span className={styles.modelState}>
                            {selected ? <Check size={14} aria-hidden="true" /> : null}
                            {readiness}
                          </span>
                          {unavailable ? (
                            <span id={explanationId} className="sr-only">
                              {modelUnavailableExplanation(candidate.model) ??
                                "No reasoning option is currently selectable."}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>

        <div className={styles.candidatePanel}>
          {pendingModel === null ? (
            <p>Select a model to inspect its reasoning and disclosure.</p>
          ) : (
            <>
              <fieldset id={`${id}-reasoning`} className={styles.reasoningGroup}>
                <legend>Reasoning for {pendingModel.model.label}</legend>
                <div role="radiogroup" aria-label={`Reasoning for ${pendingModel.model.label}`}>
                  {pendingModel.model.reasoning.map((reasoning, index) => {
                    const checked = reasoning.key === pendingReasoningKey;
                    const selectable = reasoning.chat_state.kind === "Selectable";
                    return (
                      <button
                        key={reasoning.key}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-disabled={selectable ? undefined : "true"}
                        aria-describedby={
                          selectable ? undefined : `${id}-reasoning-${index}-explanation`
                        }
                        tabIndex={
                          reasoning.key === rovingReasoningKey
                            ? 0
                            : -1
                        }
                        data-checked={checked ? "true" : undefined}
                        onFocus={() => setActiveReasoningKey(reasoning.key)}
                        onClick={() => chooseReasoning(reasoning)}
                        onKeyDown={(event) => {
                          if (![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                          ].includes(event.key)) return;
                          event.preventDefault();
                          const rows = pendingModel.model.reasoning;
                          const current = rows.indexOf(reasoning);
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? rows.length - 1
                                : event.key === "ArrowRight" || event.key === "ArrowDown"
                                  ? (current + 1) % rows.length
                                  : (current <= 0 ? rows.length : current) - 1;
                          const nextReasoning = rows[next];
                          if (nextReasoning === undefined) return;
                          chooseReasoning(nextReasoning);
                          const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='radio']");
                          radios?.[next]?.focus();
                        }}
                      >
                        {reasoning.label}
                        {!selectable ? <span aria-hidden="true"> · Unavailable</span> : null}
                        {!selectable ? (
                          <span id={`${id}-reasoning-${index}-explanation`} className="sr-only">
                            {selectionStateExplanation(reasoning.chat_state)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <section id={detailsId} className={styles.details} aria-label="Selection details">
                <h3>{pendingModel.model.label}</h3>
                <p>{pendingModel.model.description}</p>
                <dl>
                  <div><dt>Route / provider</dt><dd>{pendingModel.route.label}</dd></div>
                  <div><dt>Model</dt><dd>{pendingModel.model.key}</dd></div>
                  <div><dt>Reasoning</dt><dd>{pendingReasoning?.label ?? "Choose a level"}</dd></div>
                  <div><dt>Billing</dt><dd>{pendingModel.route.billing.label}</dd></div>
                  <div><dt>Processors</dt><dd>{pendingModel.route.processor_chain.processors.join(" → ")}</dd></div>
                  <div><dt>Privacy</dt><dd>{pendingModel.route.privacy.summary}</dd></div>
                  <div><dt>Retention</dt><dd>{pendingModel.route.privacy.retention}</dd></div>
                  <div><dt>Training</dt><dd>{pendingModel.route.privacy.training}</dd></div>
                  <div><dt>Source context</dt><dd>{capacityLabel(pendingModel.model.source_context_window, (number) => formatDisplayNumber(number, display))}</dd></div>
                  <div><dt>Source output</dt><dd>{capacityLabel(pendingModel.model.source_max_output_tokens, (number) => formatDisplayNumber(number, display))}</dd></div>
                  <div><dt>Effective context budget</dt><dd>{formatDisplayNumber(pendingModel.model.effective_chat_context_budget_tokens, display)} tokens</dd></div>
                  <div><dt>Effective output budget</dt><dd>{formatDisplayNumber(pendingModel.model.effective_chat_output_budget_tokens, display)} tokens</dd></div>
                  <div><dt>Readiness</dt><dd>{pendingReasoning === null ? modelReadinessLabel(pendingModel.model) : selectionStateExplanation(pendingReasoning.chat_state)}</dd></div>
                  <div><dt>Last checked</dt><dd>{pendingModel.model.readiness.last_checked}</dd></div>
                  <div><dt>Recovery</dt><dd>{readinessAction(pendingModel.model.readiness) ?? (pendingReasoning?.chat_state.kind === "OperatorActionRequired" || pendingReasoning?.chat_state.kind === "TemporarilyUnavailable" ? pendingReasoning.chat_state.action : "No action required")}</dd></div>
                  <div><dt>Write authority</dt><dd>{writeAuthority === "AdditiveWrites" ? "Allowed for this reply" : "Read-only"}</dd></div>
                </dl>
              </section>
            </>
          )}
        </div>
      </div>

      {value !== null && findGenerationCandidate(catalog, value) === null ? (
        <div className={styles.unavailableSelection} role="status">
          The previous exact selection is no longer available. Choose and confirm a replacement; nothing was substituted.
        </div>
      ) : null}

      <div className={styles.footer}>
        <Button variant="ghost" size="sm" onClick={() => dismiss(true)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={submitting}
          aria-disabled={pendingSelectable && !submitting ? undefined : "true"}
          aria-describedby={pendingSelectable ? undefined : blockerId}
          onClick={() => commit(pendingSelection)}
        >
          Confirm selection
        </Button>
        <p id={blockerId} className="sr-only">
          {pendingSelectable ? "Selection is ready." : pendingBlocker}
        </p>
      </div>
    </div>
  );

  return (
    <div className={styles.root}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className={styles.trigger}
        disabled={disabled}
        aria-label={
          triggerActionLabel === undefined
            ? trigger.accessibleName
            : `${triggerActionLabel}. Current: ${trigger.route}, ${trigger.model}, ${trigger.reasoning}, ${trigger.billing}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => onOpenChange(!open)}
        trailingIcon={<ChevronDown size={14} aria-hidden="true" />}
      >
        <span className={styles.triggerCopy}>
          <strong>{triggerActionLabel ?? trigger.model}</strong>
          <small>{trigger.route} · {trigger.reasoning} · {trigger.billing}</small>
        </span>
      </Button>
      <MobileSheet
        active={open && mobile}
        onDismiss={() => dismiss(true)}
        onEscape={() => dismiss(true)}
        ariaLabel={label}
        panelId={dialogId}
        initialFocus={() => searchRef.current}
        returnFocusTo={() => triggerRef.current}
        focusKey={catalog.definition_revision}
      >
        {content}
      </MobileSheet>
      {open && !mobile ? (
        <div
          ref={desktopPanelRef}
          id={dialogId}
          className={styles.desktopDialog}
          role="dialog"
          aria-label={label}
          onBlur={onDesktopDialogBlur}
        >
          {content}
        </div>
      ) : null}
    </div>
  );
}
