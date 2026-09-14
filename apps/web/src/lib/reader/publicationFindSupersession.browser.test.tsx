import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { renderPublicationFind } from "./publicationFindFixture";

it("withdraws a completed preview when newer navigation leaves its old unit resident", async () => {
  const view = await renderPublicationFind({ maxUnits: 4, maxQueryLeases: 4 }, true);
  try {
    const viewport = screen.getByLabelText("Reader viewport");
    await within(viewport).findByText("HOME");
    await userEvent.click(screen.getByRole("button", { name: "Preview uncommitted prefix" }));
    await waitFor(() => expect(screen.getByLabelText("Preview settlement")).toHaveTextContent("Waiting for commit"));
    expect(within(viewport).queryByText("BEA")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Navigate home" }));
    await waitFor(() => expect(screen.getByLabelText("Navigation settlement")).toHaveTextContent("Ready"));
    expect(screen.getByLabelText("Resident units")).toHaveTextContent("HOME, BEA");
    const scrollTop = viewport.scrollTop;
    await userEvent.click(screen.getByRole("button", { name: "Commit prefix" }));
    await within(viewport).findByText("BEA");
    await waitFor(() => expect(screen.getByLabelText("Preview settlement"),
      "completed navigation retained obsolete activation").toHaveTextContent("Superseded"));
    expect(CSS.highlights.get("nexus-find-active")?.size ?? 0).toBe(0);
    expect(viewport.scrollTop).toBe(scrollTop);
  } finally { view.close(); }
});
