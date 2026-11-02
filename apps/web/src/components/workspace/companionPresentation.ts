"use client";

import { createContext, useContext } from "react";

export type CompanionPresentation = "Column" | "Sheet" | "FullScreen";

export const CompanionPresentationContext = createContext<CompanionPresentation | null>(null);

/** The presentation of the Companion hosting this subtree. */
export function useCompanionPresentation(): CompanionPresentation {
  const presentation = useContext(CompanionPresentationContext);
  if (presentation === null) throw new Error("useCompanionPresentation requires a Companion");
  return presentation;
}
