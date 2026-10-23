"use client";
import { createContext, useContext } from "react";
export const WritingReadyContext = createContext(false);
export const useWritingReady = () => useContext(WritingReadyContext);
