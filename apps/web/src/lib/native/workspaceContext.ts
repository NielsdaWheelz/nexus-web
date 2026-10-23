"use client";
import { createContext, useContext } from "react";
import type { WorkspaceState } from "@/lib/workspace/model";
export const DeviceWorkspaceContext = createContext<{ initial: WorkspaceState; revision: { current: string } } | null>(null);
export const useDeviceWorkspace = () => useContext(DeviceWorkspaceContext);
