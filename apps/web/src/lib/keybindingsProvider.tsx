"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_KEYBINDINGS,
  formatKeyCombo,
  loadStoredKeybindings,
  saveStoredKeybindings,
} from "@/lib/keybindings";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";

interface KeybindingsContextValue {
  bindings: Record<string, string>;
  setBinding(actionId: string, combo: string | null): void;
  resetBindings(): void;
  labelFor(actionId: string): string | null;
}

const KeybindingsContext = createContext<KeybindingsContextValue | null>(null);

export function KeybindingsProvider({ children }: { children: ReactNode }) {
  const { platform } = useRenderEnvironment();
  const [bindings, setBindings] = useState<Record<string, string>>({
    ...DEFAULT_KEYBINDINGS,
  });

  useEffect(() => {
    setBindings(loadStoredKeybindings());
  }, []);

  const persist = useCallback((next: Record<string, string>) => {
    setBindings(next);
    saveStoredKeybindings(next);
  }, []);

  const setBinding = useCallback(
    (actionId: string, combo: string | null) => {
      const next = { ...bindings };
      if (combo) next[actionId] = combo;
      else if (DEFAULT_KEYBINDINGS[actionId]) next[actionId] = DEFAULT_KEYBINDINGS[actionId];
      else delete next[actionId];
      persist(next);
    },
    [bindings, persist],
  );

  const resetBindings = useCallback(() => {
    persist({ ...DEFAULT_KEYBINDINGS });
  }, [persist]);

  const labelFor = useCallback(
    (actionId: string) => {
      const combo = bindings[actionId];
      return combo ? formatKeyCombo(combo, platform) : null;
    },
    [bindings, platform],
  );

  return (
    <KeybindingsContext.Provider
      value={{ bindings, setBinding, resetBindings, labelFor }}
    >
      {children}
    </KeybindingsContext.Provider>
  );
}

function useKeybindingsContext(): KeybindingsContextValue {
  const value = useContext(KeybindingsContext);
  if (!value) {
    throw new Error("KeybindingsProvider is missing");
  }
  return value;
}

export function useKeybindings(): Record<string, string> {
  return useKeybindingsContext().bindings;
}

export function useKeybinding(actionId: string): string | null {
  return useKeybindingsContext().bindings[actionId] ?? null;
}

export function useKeybindingLabel(actionId: string): string | null {
  return useKeybindingsContext().labelFor(actionId);
}

export function useKeybindingsController() {
  return useKeybindingsContext();
}
