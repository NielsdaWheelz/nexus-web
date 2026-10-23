"use client";
import { createContext, useContext } from "react";
import type { WritingRuntime } from "./useWritingRuntime";
export const WritingReadyContext = createContext<WritingRuntime["state"]>("starting");
export const useWritingState = () => useContext(WritingReadyContext);
export const useWritingReady = () => useWritingState() === "ready";
