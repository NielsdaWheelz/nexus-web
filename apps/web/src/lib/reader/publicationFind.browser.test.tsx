import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { renderPublicationFind } from "./publicationFindFixture";

it.each(["Complete", "Capacity"] as const)("preserves the reading origin when a cross-unit preview ends with %s", async (outcome) => {
  // The Capacity case starves content residency: the preview holds one query
  // lease for its whole run and takes no second one, so only the unit pool can
  // refuse the neighbour the cross-unit match needs.
  const view = await renderPublicationFind({ maxUnits: outcome === "Capacity" ? 1 : 4, maxQueryLeases: 4 });
  try {
    await screen.findByText("HOME");
    await userEvent.click(screen.getByRole("button", { name: "Find beacon" }));
    expect(await screen.findByLabelText("Find scopes")).toHaveTextContent("Entire article, This section");
    await screen.findByText("BEA");
    if (outcome === "Complete") {
      await waitFor(() => expect(view.tailRequested(), "required match tail was never requested").toBe(true));
      expect(screen.queryByText("CON")).not.toBeInTheDocument();
      view.finishTail();
      await screen.findByText("CON");
      await waitFor(() => expect([...CSS.highlights.get("nexus-find-active")!].map((range) => range.toString()).join("")).toBe("BEACON"));
    } else {
      await waitFor(() => expect(screen.getByLabelText("Find state")).toHaveTextContent("Failed"));
      expect(screen.queryByText("CON")).not.toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByLabelText("Return state"), "displaced preview lost its reading origin").toHaveTextContent("Available"));
    await userEvent.click(screen.getByRole("button", { name: "Return to reading" }));
    await screen.findByText("HOME");
    await waitFor(() => expect(screen.getByLabelText("Return state")).toHaveTextContent("Unavailable"));
  } finally { view.close(); }
});
