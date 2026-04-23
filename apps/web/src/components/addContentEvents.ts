"use client";

export type AddContentMode = "content" | "opml";

export const OPEN_ADD_CONTENT_EVENT = "nexus:open-add-content";

export function dispatchOpenAddContent(mode: AddContentMode = "content") {
  window.dispatchEvent(
    new CustomEvent(OPEN_ADD_CONTENT_EVENT, {
      detail: { mode },
    })
  );
}
