import { describe, expect, it } from "vitest";
import {
  presentLibrary,
  type LibraryPresenterContext,
  type LibraryPresenterItem,
} from "./library";

function item(
  overrides: Partial<LibraryPresenterItem> = {},
): LibraryPresenterItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Reading Room",
    isDefault: false,
    role: "admin",
    canRename: true,
    canDelete: true,
    ...overrides,
  };
}

const ctx: LibraryPresenterContext = {
  settings: { kind: "Unavailable" },
  deleteLibrary: { kind: "Unavailable" },
  busyIds: new Set(),
};

describe("presentLibrary", () => {
  it("presents the default library as the All view", () => {
    const view = presentLibrary(
      item({ name: "My Library", isDefault: true }),
      ctx,
    );

    expect(view.title).toEqual({ text: "All" });
    expect(view.primary).toMatchObject({ paneLabelHint: "All" });
    expect(view.context).toEqual({
      kind: "Present",
      value: { kind: "Text", text: "Across your libraries" },
    });
  });

  it("presents a non-default library by name and role", () => {
    const view = presentLibrary(item({ name: "Reading Room" }), ctx);

    expect(view.title).toEqual({ text: "Reading Room" });
    expect(view.primary).toMatchObject({ paneLabelHint: "Reading Room" });
    expect(view.context).toEqual({
      kind: "Present",
      value: { kind: "Text", text: "admin" },
    });
  });
});
