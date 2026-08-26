import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalknoteSessionProvider } from "./walknoteSession";

describe("Walknote session rendering boundary", () => {
  it("does not read browser storage during server rendering", () => {
    expect(() =>
      renderToString(
        createElement(
          WalknoteSessionProvider,
          null,
          createElement("p", null, "Workspace"),
        ),
      ),
    ).not.toThrow();
  });
});
