import type { ComponentType } from "react";

export interface PaletteSection {
  id: string;
  label: string;
  order: number;
}

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
  shortcutActionId?: string;
  shortcutLabel?: string;
  disabled?: { reason: string };
  danger?: boolean;
}
