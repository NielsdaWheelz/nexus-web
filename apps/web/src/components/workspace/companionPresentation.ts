"use client";

import { createContext, useContext } from "react";

export type CompanionPresentation = "Column" | "Sheet" | "FullScreen";

export const CompanionPresentationContext = createContext<CompanionPresentation | null>(null);

/** The pane shell's retained Companion presentation, shared by primary and margin content. */
export function useCompanionPresentation(): CompanionPresentation {
  const presentation = useContext(CompanionPresentationContext);
  if (presentation === null) throw new Error("useCompanionPresentation requires a PaneShell");
  return presentation;
}
