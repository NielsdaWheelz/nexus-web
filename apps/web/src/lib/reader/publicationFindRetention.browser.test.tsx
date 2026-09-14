import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { renderPublicationFind } from "./publicationFindFixture";

it("keeps replaced result rows charged until their pending preview settles", async () => {
  const view = await renderPublicationFind({ maxUnits: 3, maxQueryLeases: 1 });
  try {
    await screen.findByText("HOME");
    await userEvent.click(screen.getByRole("button", { name: "Find beacon" }));
    await waitFor(() => expect(view.tailRequested()).toBe(true));
    await screen.findByText("BEA");
    // The replaced result stays charged to the single query lease until its
    // pending preview settles, so the second query has no pool to take.
    await userEvent.click(screen.getByRole("button", { name: "Find prefix" }));
    await waitFor(() => expect(screen.getByLabelText("Find state"), "pending preview rows were released before settlement").toHaveTextContent("Failed"));
    view.finishTail();
    await screen.findByText("CON");
    await userEvent.click(screen.getByRole("button", { name: "Retry find" }));
    await waitFor(() => expect(screen.getByLabelText("Find state")).toHaveTextContent("Ready"));
    await waitFor(() => expect([...CSS.highlights.get("nexus-find-active")!].map((range) => range.toString()).join("")).toBe("BEA"));
  } finally { view.close(); }
});
