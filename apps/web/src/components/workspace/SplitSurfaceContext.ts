"use client";

import { createContext } from "react";

/**
 * When true, the consuming component is rendered inside a SplitSurface mobile
 * overlay which already provides its own header. Children (e.g. Pane) should
 * suppress their own chrome to avoid duplicate headers.
 */
export const SplitSurfaceOverlayContext = createContext(false);
