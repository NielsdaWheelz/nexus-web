import { describe, expect, it } from "vitest";
import { noteBodyHasContent } from "./bodyContent";

describe("noteBodyHasContent", () => {
  it.each([
    ["object reference label", {
      type: "object_ref",
      attrs: { objectType: "page", objectId: "page-id", label: "Project" },
    }],
    ["object reference fallback", {
      type: "object_ref",
      attrs: { objectType: "page", objectId: "page-id", label: "" },
    }],
    ["object embed fallback", {
      type: "object_embed",
      attrs: { objectType: "media", objectId: "media-id", label: "" },
    }],
    ["image alt", {
      type: "image",
      attrs: { src: "blob:image", alt: "Diagram" },
    }],
  ])("counts projected %s content", (_name, atom) => {
    expect(
      noteBodyHasContent({
        bodyText: "",
        bodyPmJson: { type: "paragraph", content: [atom] },
      }),
    ).toBe(true);
  });

  it.each([
    ["missing image alt", { type: "image", attrs: { src: "blob:image" } }],
    ["empty image alt", {
      type: "image",
      attrs: { src: "blob:image", alt: "  " },
    }],
    ["invalid object fallback", {
      type: "object_ref",
      attrs: { label: "" },
    }],
    ["whitespace object label", {
      type: "object_ref",
      attrs: { objectType: "page", objectId: "page-id", label: "  " },
    }],
  ])("does not count %s as meaningful", (_name, atom) => {
    expect(
      noteBodyHasContent({
        bodyText: "",
        bodyPmJson: { type: "paragraph", content: [atom] },
      }),
    ).toBe(false);
  });
});
