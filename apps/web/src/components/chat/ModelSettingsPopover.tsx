/**
 * ModelSettingsPopover - the provider / model / reasoning / "use my keys" panel.
 *
 * Renders a summary trigger button plus a settings panel that behaves as a
 * desktop popover (dismiss on outside-click or Escape) and, on mobile, as the
 * shared MobileSheet bottom sheet (modal contract, backdrop / Escape /
 * back-button dismissal owned by the primitive).
 */

"use client";

import { useCallback, useRef, type RefObject } from "react";
import { ChevronDown, X } from "lucide-react";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import Select from "@/components/ui/Select";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  getModelSourceLabel,
  isReasoningMode,
  KEY_MODE_LABELS,
  REASONING_LABELS,
  type UseChatModels,
} from "./useChatModels";
import styles from "./ModelSettingsPopover.module.css";

interface ModelSettingsPopoverProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  models: UseChatModels;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export default function ModelSettingsPopover({
  open,
  setOpen,
  models,
  disabled,
  buttonRef,
}: ModelSettingsPopoverProps) {
  const isMobile = useIsMobileViewport();
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const closeOnDesktop = useCallback(() => {
    if (!isMobile) setOpen(false);
  }, [isMobile, setOpen]);

  useDismissOnOutsideOrEscape({
    enabled: open && !isMobile,
    refs: [panelRef, buttonRef],
    onDismiss: close,
  });

  const {
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
  } = models;

  const settingsContent = (
    <>
      <header className={styles.settingsHeader}>
        <h2 className={styles.settingsTitle}>Model settings</h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={close}
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
                {getModelSourceLabel(model, selectedKeyMode)}
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

      <label className={styles.settingsField}>
        <span className={styles.settingsLabel}>Key mode</span>
        <Select
          value={selectedKeyMode}
          onChange={(e) => {
            const mode = e.target.value;
            if (mode in KEY_MODE_LABELS) {
              setKeyMode(mode as keyof typeof KEY_MODE_LABELS);
            }
            closeOnDesktop();
          }}
          disabled={disabled || keyModeOptions.length === 0}
        >
          {keyModeOptions.length === 0 && (
            <option value="">No key modes available</option>
          )}
          {keyModeOptions.map((mode) => (
            <option key={mode} value={mode}>
              {KEY_MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </label>
    </>
  );

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

      {open && !isMobile && (
        <div className={styles.settingsLayer}>
          <div
            ref={panelRef}
            className={styles.settingsPanel}
            role="dialog"
            aria-label="Model settings"
          >
            {settingsContent}
          </div>
        </div>
      )}

      <MobileSheet
        active={open && isMobile}
        onDismiss={close}
        ariaLabel="Model settings"
        layer="modal"
        scrim="soft"
      >
        <div className={styles.sheetContent}>{settingsContent}</div>
      </MobileSheet>
    </>
  );
}
