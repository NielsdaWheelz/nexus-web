import { describe, expect, it } from "vitest";
import { pluralize } from "./pluralize";

describe("pluralize", () => {
  it("uses the plural form for zero", () => {
    expect(pluralize(0, "chat")).toBe("0 chats");
  });

  it("uses the singular form for one", () => {
    expect(pluralize(1, "linked chat")).toBe("1 linked chat");
  });

  it("uses the plural form for many", () => {
    expect(pluralize(2, "chat")).toBe("2 chats");
  });

  it("uses an explicit irregular plural", () => {
    expect(pluralize(3, "entry", "entries")).toBe("3 entries");
  });
});
