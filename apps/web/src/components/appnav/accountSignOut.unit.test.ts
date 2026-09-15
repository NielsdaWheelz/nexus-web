import { describe, expect, it } from "vitest";
import { accountSignOutOwner } from "./accountSignOut";

describe("account sign-out ownership", () => {
  it("owns Android sign-out natively from first render and fails closed without its bridge", () => {
    expect(accountSignOutOwner(false, "Unavailable")).toBe("WebPost");
    expect(accountSignOutOwner(true, "Ready")).toBe("Native");
    expect(accountSignOutOwner(true, "Connecting")).toBe("Unavailable");
    expect(accountSignOutOwner(true, "Unavailable")).toBe("Unavailable");
  });
});
