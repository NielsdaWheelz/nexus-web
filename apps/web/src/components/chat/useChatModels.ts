/**
 * useChatModels - loads the available chat models, derives the provider/model/
 * reasoning selection, and owns the auto-select logic for the composer.
 *
 * The model list is cached at module scope (`cachedModels`/`modelLoadPromise`)
 * so it survives composer remounts across surfaces — a single `/api/models`
 * fetch is shared by every mounted composer.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { ConversationModel } from "@/lib/conversations/types";

type ReasoningMode = ChatRunCreateRequest["reasoning"];

const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const;
const DEFAULT_REASONING: ReasoningMode = "default";

export const REASONING_LABELS = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
} satisfies Record<ReasoningMode, string>;

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return typeof value === "string" && value in REASONING_LABELS;
}

let cachedModels: ConversationModel[] | null = null;
let modelLoadPromise: Promise<ConversationModel[]> | null = null;

function loadComposerModels(): Promise<ConversationModel[]> {
  if (cachedModels) {
    return Promise.resolve(cachedModels);
  }
  if (!modelLoadPromise) {
    modelLoadPromise = apiFetch<{ data: ConversationModel[] }>("/api/models")
      .then((response) => {
        cachedModels = response.data;
        return response.data;
      })
      .catch((error) => {
        modelLoadPromise = null;
        throw error;
      });
  }
  return modelLoadPromise;
}

export function getModelSourceLabel(model: ConversationModel): string {
  if (model.available_via === "byok") {
    return "Your key";
  }
  if (model.available_via === "both") {
    return "Your key first";
  }
  return "Nexus AI";
}

function isAvailableViaUserKey(model: ConversationModel): boolean {
  return model.available_via === "byok" || model.available_via === "both";
}

function firstModelForProviderOrder(
  models: ConversationModel[]
): ConversationModel | undefined {
  for (const provider of PROVIDER_ORDER) {
    const lightModel = models.find(
      (item) => item.provider === provider && item.model_tier === "light"
    );
    if (lightModel) return lightModel;

    const firstProviderModel = models.find((item) => item.provider === provider);
    if (firstProviderModel) return firstProviderModel;
  }
  return models[0];
}

function reasoningOptionsForModel(
  model: ConversationModel | undefined
): ReasoningMode[] {
  if (!model) return [];
  const options: ReasoningMode[] = [DEFAULT_REASONING];
  for (const mode of model.reasoning_modes) {
    if (!options.includes(mode)) {
      options.push(mode);
    }
  }
  return options;
}

export interface UseChatModels {
  availableModels: ConversationModel[];
  selectedModel: ConversationModel | undefined;
  selectedProvider: string;
  selectedModelId: string;
  selectedReasoning: ReasoningMode;
  providerOptions: string[];
  reasoningOptions: ReasoningMode[];
  modelSummary: string;
  setProvider: (provider: string) => void;
  setModel: (modelId: string) => void;
  setReasoning: (mode: ReasoningMode) => void;
}

export function useChatModels({
  onlyUseMyKeys,
}: {
  onlyUseMyKeys: boolean;
}): UseChatModels {
  const [models, setModels] = useState<ConversationModel[]>(
    () => cachedModels ?? []
  );
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedReasoning, setSelectedReasoning] =
    useState<ReasoningMode>(DEFAULT_REASONING);

  useEffect(() => {
    let cancelled = false;
    void loadComposerModels()
      .then((nextModels) => {
        if (!cancelled) {
          setModels(nextModels);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load models:", err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const availableModels = useMemo(
    () => (onlyUseMyKeys ? models.filter(isAvailableViaUserKey) : models),
    [models, onlyUseMyKeys]
  );

  useEffect(() => {
    const selected = availableModels.find((model) => model.id === selectedModelId);
    if (selected && selected.provider === selectedProvider) return;

    const firstModel = firstModelForProviderOrder(availableModels);
    setSelectedProvider(firstModel?.provider ?? "");
    setSelectedModelId(firstModel?.id ?? "");
    setSelectedReasoning(DEFAULT_REASONING);
  }, [availableModels, selectedModelId, selectedProvider]);

  const selectedModel = availableModels.find(
    (model) => model.id === selectedModelId
  );
  const reasoningOptions = reasoningOptionsForModel(selectedModel);
  const providerOptions = PROVIDER_ORDER.filter((provider) =>
    availableModels.some((model) => model.provider === provider)
  );
  const modelSummary = selectedModel
    ? `${selectedModel.model_display_name} / ${REASONING_LABELS[selectedReasoning]}`
    : "Model";

  const setProvider = useCallback(
    (provider: string) => {
      setSelectedProvider(provider);

      const providerModels = availableModels.filter(
        (model) => model.provider === provider
      );
      const nextModel = providerModels[0];
      setSelectedModelId(nextModel?.id ?? "");
      setSelectedReasoning(DEFAULT_REASONING);
    },
    [availableModels]
  );

  const setModel = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);

      const model = availableModels.find((item) => item.id === modelId);
      if (!model) {
        setSelectedReasoning(DEFAULT_REASONING);
        return;
      }
      setSelectedProvider(model.provider);

      if (
        selectedReasoning !== DEFAULT_REASONING &&
        !model.reasoning_modes.includes(selectedReasoning)
      ) {
        setSelectedReasoning(DEFAULT_REASONING);
      }
    },
    [availableModels, selectedReasoning]
  );

  return {
    availableModels,
    selectedModel,
    selectedProvider,
    selectedModelId,
    selectedReasoning,
    providerOptions,
    reasoningOptions,
    modelSummary,
    setProvider,
    setModel,
    setReasoning: setSelectedReasoning,
  };
}
