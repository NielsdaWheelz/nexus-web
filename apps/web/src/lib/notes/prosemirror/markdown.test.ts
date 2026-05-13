import { describe, expect, it } from "vitest";
import { outlineDocToMarkdown } from "@/lib/notes/prosemirror/markdown";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";

describe("outlineDocToMarkdown", () => {
  it("projects marks, images, and object refs into readable Markdown", () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const paragraph = outlineSchema.nodes.paragraph!.create(null, [
      outlineSchema.text("Read "),
      outlineSchema.text("docs", [outlineSchema.marks.link!.create({ href: "https://example.com" })]),
      outlineSchema.text(" "),
      outlineSchema.nodes.object_ref!.create({
        objectType: "media",
        objectId,
        label: "Source",
      }),
      outlineSchema.text(" "),
      outlineSchema.nodes.image!.create({ src: "/image.png", alt: "diagram" }),
    ]);
    const block = outlineSchema.nodes.outline_block!.create(
      { id: "block-1", kind: "bullet", collapsed: false },
      [paragraph]
    );
    const doc = outlineSchema.nodes.outline_doc!.create(null, [block]);

    expect(outlineDocToMarkdown(doc)).toBe(
      `- Read [docs](https://example.com) [[media:${objectId}|Source]] ![diagram](/image.png) ^block-1`
    );
  });
});
