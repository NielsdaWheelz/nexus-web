"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { MeasuredIndexWindow } from "./measuredIndexWindow";

const RowWindow = createContext<{ interact(): void; pin(): () => void } | null>(null);

/** Only an actual row invocation retains extra mounted demand. */
export function IndexRowWindow({ window, id, children }: {
  readonly window: MeasuredIndexWindow;
  readonly id: string;
  readonly children: ReactNode;
}) {
  const { interact, pin } = window;
  const value = useMemo(() => ({ interact: () => interact(id), pin: () => pin(id) }), [id, interact, pin]);
  return <RowWindow.Provider value={value}>{children}</RowWindow.Provider>;
}

export const useIndexRowWindow = () => useContext(RowWindow);
