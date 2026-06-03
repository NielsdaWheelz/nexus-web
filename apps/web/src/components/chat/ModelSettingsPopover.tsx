/**
 * ModelSettingsPopover - the provider / model / reasoning / "use my keys" panel.
 *
 * Renders a summary trigger button plus a settings panel that behaves as a
 * desktop popover (dismiss on outside-click or Escape) and a mobile bottom
 * sheet (backdrop dismiss, body-overflow lock, Escape; outside-click ignored).
 */

"use client";

import { useCallback, useRef, type RefObject } from "react";
import { ChevronDown, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useReturnFocus } from "@/lib/ui/useReturnFocus";
import {
  getModelSourceLabel,
  isReasoningMode,
  REASONING_LABELS,
  type UseChatModels,
} from "./useChatModels";
import styles from "./ModelSettingsPopover.module.css";

interface ModelSettingsPopoverProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  models: UseChatModels;
  onlyUseMyKeys: boolean;
  setOnlyUseMyKeys: (next: boolean) => void;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export default function ModelSettingsPopover({
  open,
  setOpen,
  models,
  onlyUseMyKeys,
  setOnlyUseMyKeys,
  disabled,
  buttonRef,
}: ModelSettingsPopoverProps) {
  const isMobile = useIsMobileViewport();
  const panelRef = useRef<HTMLDivElement>(null);

  const closeOnDesktop = useCallback(() => {
    if (!isMobile) setOpen(false);
  }, [isMobile, setOpen]);

  useDismissOnOutsideOrEscape({
    enabled: open,
    refs: [panelRef, buttonRef],
    onDismiss: (reason) => {
      // Mobile: full-screen panel, outside-click is impossible/unintended;
      // Escape still closes.
      if (reason === "outside-click" && isMobile) return;
      setOpen(false);
    },
  });

  useBodyOverflowLock(open && isMobile);
  useFocusTrap(panelRef, open && isMobile);
  useReturnFocus(open && isMobile);
  useInitialFocus(panelRef, open && isMobile);

  const {
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
    setReasoning,
  } = models;

  return (
    <>
      <Button
        ref={buttonRef}
        variant="pill"
        size="sm"
        className={styles.modelSummaryButton}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model settings: ${modelSummary}`}
        title={modelSummary}
        trailingIcon={<ChevronDown size={14} aria-hidden="true" />}
      >
        <span className={styles.modelSummary}>{modelSummary}</span>
      </Button>

      {open && (
        <div className={styles.settingsLayer} data-mobile={isMobile ? "true" : "false"}>
          {isMobile && (
            <div
              className={styles.settingsBackdrop}
              onClick={() => setOpen(false)}
            />
          )}

          <div
            ref={panelRef}
            className={styles.settingsPanel}
            role="dialog"
            aria-modal={isMobile ? "true" : undefined}
            aria-label="Model settings"
          >
            <header className={styles.settingsHeader}>
              <h2 className={styles.settingsTitle}>Model settings</h2>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => setOpen(false)}
                aria-label="Close model settings"
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </header>

            <label className={styles.settingsField}>
              <span className={styles.settingsLabel}>Provider</span>
              <Select
                value={selectedProvider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  closeOnDesktop();
                }}
                disabled={disabled || providerOptions.length === 0}
              >
                {availableModels.length === 0 && (
                  <option value="">No providers available</option>
                )}
                {providerOptions.map((provider) => {
                  const model = availableModels.find(
                    (item) => item.provider === provider
                  );
                  return (
                    <option key={provider} value={provider}>
                      {model?.provider_display_name ?? provider}
                    </option>
                  );
                })}
              </Select>
            </label>

            <label className={styles.settingsField}>
              <span className={styles.settingsLabel}>Model</span>
              <Select
                value={selectedModelId}
                onChange={(e) => {
                  setModel(e.target.value);
                  closeOnDesktop();
                }}
                disabled={disabled || availableModels.length === 0}
              >
                {availableModels.length === 0 && (
                  <option value="">No models available</option>
                )}
                {availableModels
                  .filter((model) => model.provider === selectedProvider)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.model_display_name} ({model.model_tier}) -{" "}
                      {getModelSourceLabel(model)}
                    </option>
                  ))}
              </Select>
            </label>

            <label className={styles.settingsField}>
              <span className={styles.settingsLabel}>Reasoning</span>
              <Select
                value={selectedReasoning}
                onChange={(e) => {
                  if (isReasoningMode(e.target.value)) {
                    setReasoning(e.target.value);
                  }
                  closeOnDesktop();
                }}
                disabled={disabled || !selectedModel}
              >
                {!selectedModel && <option value="">No reasoning modes</option>}
                {reasoningOptions.map((mode) => (
                  <option key={mode} value={mode}>
                    {REASONING_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </label>

            <Toggle
              checked={onlyUseMyKeys}
              onCheckedChange={(next) => {
                setOnlyUseMyKeys(next);
                closeOnDesktop();
              }}
              disabled={disabled}
              label="Use my keys only"
            />
          </div>
        </div>
      )}
    </>
  );
}
