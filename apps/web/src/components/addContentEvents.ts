"use client";

export const ADD_CONTENT_MODES = ["content", "quick-note", "opml"] as const;

export type AddContentMode = (typeof ADD_CONTENT_MODES)[number];

export const OPEN_ADD_CONTENT_EVENT = "nexus:open-add-content";

const ADD_CONTENT_MODE_SET: ReadonlySet<string> = new Set(ADD_CONTENT_MODES);

export function isAddContentMode(value: unknown): value is AddContentMode {
  return typeof value === "string" && ADD_CONTENT_MODE_SET.has(value);
}

export function dispatchOpenAddContent(mode: AddContentMode = "content") {
  window.dispatchEvent(
    new CustomEvent(OPEN_ADD_CONTENT_EVENT, {
      detail: { mode },
    })
  );
}
