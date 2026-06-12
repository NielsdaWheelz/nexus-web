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
import { useResource } from "@/lib/api/useResource";

type ReasoningMode = ChatRunCreateRequest["reasoning"];
type KeyMode = NonNullable<ChatRunCreateRequest["key_mode"]>;

const INITIAL_REASONING: ReasoningMode = "default";
const INITIAL_KEY_MODE: KeyMode = "auto";

export const REASONING_LABELS = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
} satisfies Record<ReasoningMode, string>;

export const KEY_MODE_LABELS = {
  auto: "Auto",
  byok_only: "Your keys",
  platform_only: "Nexus AI",
} satisfies Record<KeyMode, string>;

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return typeof value === "string" && value in REASONING_LABELS;
}

let cachedModels: ConversationModel[] | null = null;
let modelLoadPromise: Promise<ConversationModel[]> | null = null;
let modelCacheEpoch = 0;
const modelCacheListeners = new Set<() => void>();

export function __resetChatModelsCacheForTests(): void {
  cachedModels = null;
  modelLoadPromise = null;
  modelCacheEpoch = 0;
  modelCacheListeners.clear();
}

export function invalidateChatModelsCache(): void {
  cachedModels = null;
  modelLoadPromise = null;
  modelCacheEpoch += 1;
  for (const listener of modelCacheListeners) {
    listener();
  }
}

function loadComposerModels(): Promise<ConversationModel[]> {
  if (cachedModels) {
    return Promise.resolve(cachedModels);
  }
  if (!modelLoadPromise) {
    const requestEpoch = modelCacheEpoch;
    modelLoadPromise = apiFetch<{ data: ConversationModel[] }>("/api/models")
      .then((response) => {
        if (requestEpoch === modelCacheEpoch) {
          cachedModels = response.data;
        }
        return response.data;
      });
  }
  return modelLoadPromise;
}

export function getModelSourceLabel(
  model: ConversationModel,
  keyMode: KeyMode
): string {
  if (keyMode === "byok_only") {
    return "Your key";
  }
  if (keyMode === "platform_only") {
    return "Nexus AI";
  }
  if (model.available_via === "byok") {
    return "Your key";
  }
  if (model.available_via === "both") {
    return "Your key first";
  }
  return "Nexus AI";
}

function isAvailableForKeyMode(model: ConversationModel, keyMode: KeyMode): boolean {
  return model.available_key_modes.includes(keyMode);
}

function serverDefaultModel(
  models: ConversationModel[]
): ConversationModel | undefined {
  return models.find((model) => model.is_default);
}

function modelForProviderSelection(
  models: ConversationModel[]
): ConversationModel | undefined {
  return serverDefaultModel(models);
}

function reasoningOptionsForModel(
  model: ConversationModel | undefined
): ReasoningMode[] {
  return model?.reasoning_modes ?? [];
}

function defaultReasoningForModel(
  model: ConversationModel
): ReasoningMode {
  const firstMode = model.reasoning_modes[0];
  if (!firstMode) {
    throw new Error(`Model ${model.id} has no reasoning modes`);
  }
  return firstMode;
}

export interface UseChatModels {
  availableModels: ConversationModel[];
  selectedModel: ConversationModel | undefined;
  selectedProvider: string;
  selectedModelId: string;
  selectedReasoning: ReasoningMode;
  selectedKeyMode: KeyMode;
  providerOptions: string[];
  reasoningOptions: ReasoningMode[];
  keyModeOptions: KeyMode[];
  modelSummary: string;
  setProvider: (provider: string) => void;
  setModel: (modelId: string) => void;
  setReasoning: (mode: ReasoningMode) => void;
  setKeyMode: (mode: KeyMode) => void;
}

export function useChatModels(): UseChatModels {
  const [cacheEpoch, setCacheEpoch] = useState(modelCacheEpoch);
  const [models, setModels] = useState<ConversationModel[]>(
    () => cachedModels ?? []
  );
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedReasoning, setSelectedReasoning] =
    useState<ReasoningMode>(INITIAL_REASONING);
  const [selectedKeyMode, setSelectedKeyMode] =
    useState<KeyMode>(INITIAL_KEY_MODE);

  const modelsResource = useResource<ConversationModel[]>({
    cacheKey: cachedModels ? null : `chat-composer-models:${cacheEpoch}`,
    load: () => loadComposerModels(),
  });

  useEffect(() => {
    const onInvalidated = () => setCacheEpoch(modelCacheEpoch);
    modelCacheListeners.add(onInvalidated);
    return () => {
      modelCacheListeners.delete(onInvalidated);
    };
  }, []);

  useEffect(() => {
    if (modelsResource.status === "ready") {
      setModels(modelsResource.data);
      return;
    }
    if (modelsResource.status === "error") {
      console.error("Failed to load models:", modelsResource.error);
    }
  }, [modelsResource]);

  const keyModeOptions = useMemo(() => {
    const modes = new Set<KeyMode>();
    for (const model of models) {
      for (const mode of model.available_key_modes) {
        modes.add(mode);
      }
    }
    return (["auto", "byok_only", "platform_only"] as const).filter((mode) =>
      modes.has(mode)
    );
  }, [models]);

  const availableModels = useMemo(
    () => models.filter((model) => isAvailableForKeyMode(model, selectedKeyMode)),
    [models, selectedKeyMode]
  );

  useEffect(() => {
    if (models.length > 0 && !keyModeOptions.includes(selectedKeyMode)) {
      const firstKeyMode = keyModeOptions[0];
      if (!firstKeyMode) {
        throw new Error("Model catalog response did not include any key modes");
      }
      setSelectedKeyMode(firstKeyMode);
      return;
    }

    const selected = availableModels.find((model) => model.id === selectedModelId);
    if (selected && selected.provider === selectedProvider) {
      if (!selected.reasoning_modes.includes(selectedReasoning)) {
        setSelectedReasoning(defaultReasoningForModel(selected));
      }
      return;
    }

    if (selectedProvider) {
      const providerModels = availableModels.filter(
        (model) => model.provider === selectedProvider
      );
      if (providerModels.length > 0) {
        const nextProviderDefault = serverDefaultModel(providerModels);
        setSelectedModelId(nextProviderDefault?.id ?? "");
        if (nextProviderDefault) {
          setSelectedReasoning(defaultReasoningForModel(nextProviderDefault));
        }
        return;
      }
    }

    const nextDefault = serverDefaultModel(availableModels);
    setSelectedProvider(nextDefault?.provider ?? "");
    setSelectedModelId(nextDefault?.id ?? "");
    if (nextDefault) {
      setSelectedReasoning(defaultReasoningForModel(nextDefault));
    }
  }, [
    availableModels,
    keyModeOptions,
    models.length,
    selectedKeyMode,
    selectedModelId,
    selectedProvider,
    selectedReasoning,
  ]);

  const selectedModel = availableModels.find(
    (model) => model.id === selectedModelId
  );
  const reasoningOptions = reasoningOptionsForModel(selectedModel);
  const providerOptions = Array.from(
    new Set(availableModels.map((model) => model.provider))
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
      const nextModel = modelForProviderSelection(providerModels);
      setSelectedModelId(nextModel?.id ?? "");
      if (nextModel) {
        setSelectedReasoning(defaultReasoningForModel(nextModel));
      }
    },
    [availableModels]
  );

  const setModel = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);

      const model = availableModels.find((item) => item.id === modelId);
      if (!model) {
        setSelectedProvider("");
        return;
      }
      setSelectedProvider(model.provider);

      if (!model.reasoning_modes.includes(selectedReasoning)) {
        setSelectedReasoning(defaultReasoningForModel(model));
      }
    },
    [availableModels, selectedReasoning]
  );

  const setKeyMode = useCallback(
    (mode: KeyMode) => {
      const nextAvailableModels = models.filter((model) =>
        isAvailableForKeyMode(model, mode)
      );
      const currentModel = nextAvailableModels.find(
        (model) => model.id === selectedModelId
      );

      setSelectedKeyMode(mode);

      if (currentModel && currentModel.provider === selectedProvider) {
        if (!currentModel.reasoning_modes.includes(selectedReasoning)) {
          setSelectedReasoning(defaultReasoningForModel(currentModel));
        }
        return;
      }

      if (selectedProvider) {
        const providerModels = nextAvailableModels.filter(
          (model) => model.provider === selectedProvider
        );
        const nextProviderDefault = serverDefaultModel(providerModels);
        if (nextProviderDefault) {
          setSelectedModelId(nextProviderDefault.id);
          setSelectedReasoning(defaultReasoningForModel(nextProviderDefault));
          return;
        }
      }

      const nextDefault = serverDefaultModel(nextAvailableModels);
      setSelectedProvider(nextDefault?.provider ?? "");
      setSelectedModelId(nextDefault?.id ?? "");
      if (nextDefault) {
        setSelectedReasoning(defaultReasoningForModel(nextDefault));
      }
    },
    [models, selectedModelId, selectedProvider, selectedReasoning]
  );

  const setReasoning = useCallback(
    (mode: ReasoningMode) => {
      if (selectedModel?.reasoning_modes.includes(mode)) {
        setSelectedReasoning(mode);
      }
    },
    [selectedModel]
  );

  return {
    availableModels,
    selectedModel,
    selectedProvider,
    selectedModelId,
    selectedReasoning,
    selectedKeyMode,
    providerOptions,
    reasoningOptions,
    keyModeOptions,
    modelSummary,
    setProvider,
    setModel,
    setReasoning,
    setKeyMode,
  };
}
