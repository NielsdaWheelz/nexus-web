import { describe, expect, it } from "vitest";
import { hrefForObject, type ObjectLink } from "@/lib/objectLinks";

describe("hrefForObject", () => {
  it("uses hydrated routes and does not invent routes from raw ids", () => {
    expect(
      hrefForObject({ objectType: "page", objectId: "raw-page-id", route: "/pages/alpha" })
    ).toBe("/pages/alpha");
    expect(hrefForObject({ objectType: "page", objectId: "raw-page-id" })).toBeNull();
  });

  it("keeps located object-link anchors on the frontend contract", () => {
    const link: ObjectLink = {
      id: "link-id",
      relationType: "related",
      a: {
        objectType: "page",
        objectId: "11111111-1111-4111-8111-111111111111",
        label: "Page",
        route: "/pages/11111111-1111-4111-8111-111111111111",
      },
      b: {
        objectType: "note_block",
        objectId: "22222222-2222-4222-8222-222222222222",
        label: "Block",
        route: "/notes/22222222-2222-4222-8222-222222222222",
      },
      aLocator: { section: "intro" },
      bLocator: { offset: 12 },
    };

    expect(link.aLocator).toEqual({ section: "intro" });
    expect(link.bLocator).toEqual({ offset: 12 });
  });
});
