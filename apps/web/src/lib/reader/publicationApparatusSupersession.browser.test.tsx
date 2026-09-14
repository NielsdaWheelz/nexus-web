import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { renderPublicationFind } from "./publicationFindFixture";

it("keeps newer durable movement when an old source-note root commits late", async () => {
  const view = await renderPublicationFind({ maxUnits: 4, maxQueryLeases: 4 }, true);
  try {
    const viewport = screen.getByLabelText("Reader viewport");
    await within(viewport).findByText("HOME");
    await userEvent.click(screen.getByRole("button", { name: "Open source note link" }));
    await waitFor(() => expect(screen.getByLabelText("Preview settlement")).toHaveTextContent("Waiting for commit"));
    await userEvent.click(screen.getByRole("button", { name: "Navigate home" }));
    await waitFor(() => expect(screen.getByLabelText("Navigation settlement")).toHaveTextContent("Ready"));
    expect(screen.getByLabelText("Resident units")).toHaveTextContent("HOME, BEA");
    expect((await view.pendingIntent())?.desired.locator.locations.text_offset).toBe(0);
    const scrollTop = viewport.scrollTop;
    await userEvent.click(screen.getByRole("button", { name: "Commit prefix" }));
    await within(viewport).findByText("BEA");
    await waitFor(() => expect(screen.getByLabelText("Location settlement"),
      "completed navigation retained obsolete activation").toHaveTextContent("Unavailable"));
    expect(viewport.scrollTop).toBe(scrollTop);
    expect((await view.pendingIntent())?.desired.locator.locations.text_offset).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Locate source note" }));
    await waitFor(() => expect(screen.getByLabelText("Location settlement")).toHaveTextContent("Located"));
    const saved = await view.pendingIntent();
    expect(saved?.desired.source).toEqual({ kind: "Publication", reader_generation: 7 });
    expect(saved?.desired.locator.locations.text_offset).toBe(4);
  } finally { view.close(); }
});
