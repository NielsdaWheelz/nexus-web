import type { ComponentType } from "react";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import "@/app/globals.css";

it("discloses every generation billing class without reviving account-wide selection", async () => {
  const billingModule = (await import(
    "./SettingsBillingPaneBody"
  )) as unknown as Record<string, unknown>;
  const candidate = billingModule["GenerationBillingDisclosure"];
  expect(
    typeof candidate,
    "the candidate hard cut must expose a focused generation-billing disclosure",
  ).toBe("function");
  if (typeof candidate !== "function") return;

  const Disclosure = candidate as ComponentType;
  render(<Disclosure />);

  const disclosure = screen.getByRole("region", {
    name: "AI generation billing",
  });
  const view = within(disclosure);
  expect(view.getByText("Codex Personal", { selector: "dt" })).toBeVisible();
  expect(view.getByText("Codex subscription", { exact: true })).toBeVisible();
  expect(view.getByText("Provider API", { selector: "dt" })).toBeVisible();
  expect(view.getByText("Metered API", { exact: true })).toBeVisible();
  expect(disclosure).toHaveTextContent(
    "Background generation and Codex Personal Chat use the operator-managed ChatGPT/Codex subscription.",
  );
  expect(disclosure).toHaveTextContent(
    "Provider API Chat runs are billed to the operator-managed account for the selected provider.",
  );
  expect(disclosure).toHaveTextContent(
    "You select the model and reasoning level in Chat for each run.",
  );

  for (const role of ["button", "checkbox", "combobox", "radio"] as const) {
    expect(
      view.queryByRole(role),
      `billing disclosure must not own a ${role} selection control`,
    ).not.toBeInTheDocument();
  }
  expect(disclosure.textContent).not.toMatch(
    /\b(?:profile|fast|balanced|deep)\b/iu,
  );
});
