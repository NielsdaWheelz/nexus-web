import type { ComponentType } from "react";

export type PaletteTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "action"; actionId: string }
  | { kind: "prefill"; surface: "conversation"; text: string };

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  target: PaletteTarget;
  source: "static" | "workspace" | "recent" | "oracle" | "search" | "ai";
  rank: {
    searchScore?: number;
    frecencyBoost?: number;
    recencyBoost?: number;
    scopeBoost?: number;
  };
  shortcutLabel?: string;
  disabled?: { reason: string };
  danger?: boolean;
  scopeAffinity?: string[];
  pin?: "last";
}

export interface PaletteGroup {
  sectionId: string;
  label: string;
  commands: PaletteCommand[];
}

export type PaletteView =
  | { state: "resting"; groups: PaletteGroup[] }
  | { state: "querying"; results: PaletteCommand[] };
