import { describe, expect, it } from "vitest";
import {
  collectionDisplayHref,
  collectionDisplayStateFromParams,
  collectionDisplayStateToParams,
  collectionViewStateFromParams,
  collectionViewStateToParams,
  withCollectionDisplayHref,
} from "./collectionViewState";

describe("collection display URL state", () => {
  it("serializes compact density and omits default display state", () => {
    const compact = collectionDisplayStateToParams({
      view: "list",
      density: "compact",
    });
    expect(compact.toString()).toBe("density=compact");

    const defaults = collectionDisplayStateToParams({
      view: "list",
      density: "comfortable",
    });
    expect(defaults.toString()).toBe("");
  });

  it("preserves unrelated query params when replacing display state", () => {
    const params = new URLSearchParams("q=borges&view=gallery&sort=title");
    expect(
      collectionDisplayHref("/search", params, {
        view: "list",
        density: "compact",
      }),
    ).toBe("/search?q=borges&sort=title&density=compact");
  });

  it("round-trips display state through href helpers", () => {
    const href = withCollectionDisplayHref("/browse?q=audio&sort=recent", {
      view: "gallery",
      density: "compact",
    });
    expect(href).toBe("/browse?q=audio&sort=recent&view=gallery&density=compact");

    const parsed = new URLSearchParams(href.split("?")[1]);
    expect(collectionDisplayStateFromParams(parsed)).toEqual({
      view: "gallery",
      density: "compact",
    });
  });
});

describe("collection view URL state", () => {
  it.each([
    ["recent"],
    ["resonance"],
    ["title"],
  ] as const)("round-trips %s sort state", (sort) => {
    const params = collectionViewStateToParams({
      view: "gallery",
      density: "compact",
      sort,
    });

    expect(params.toString()).toBe(`view=gallery&density=compact&sort=${sort}`);
    expect(collectionViewStateFromParams(params)).toEqual({
      view: "gallery",
      density: "compact",
      sort,
    });
  });

  it("omits default sort and preserves unrelated query params", () => {
    const params = new URLSearchParams("q=borges&sort=title&view=gallery");
    const next = collectionViewStateToParams(
      {
        view: "list",
        density: "compact",
        sort: "default",
      },
      params,
    );

    expect(next.toString()).toBe("q=borges&density=compact");
    expect(collectionViewStateFromParams(next)).toEqual({
      view: "list",
      density: "compact",
      sort: "default",
    });
  });

  it("falls back to default sort for unknown URL values", () => {
    expect(collectionViewStateFromParams(new URLSearchParams("sort=random"))).toEqual({
      view: "list",
      density: "comfortable",
      sort: "default",
    });
  });
});
