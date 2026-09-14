import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { renderPublicationFind } from "./publicationFindFixture";

it("withdraws source-note navigation when genuine reader input precedes the location response", async () => {
  const view = await renderPublicationFind({ maxUnits: 4, maxQueryLeases: 4 }, false, true);
  try {
    const viewport = screen.getByRole("region", { name: "Document reading area" });
    await within(viewport).findByText("HOME");
    await userEvent.click(screen.getByRole("button", { name: "Open source note link" }));
    await waitFor(() => expect(view.locationRequested()).toBe(true));
    await userEvent.click(viewport);
    await userEvent.keyboard("{PageDown}");
    await waitFor(() => expect(screen.getByLabelText("Trusted reader input")).toHaveTextContent("true"));
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    view.finishLocation();
    await waitFor(() => expect(screen.getByLabelText("Location settlement"),
      "late source-note read overrode genuine reader input").toHaveTextContent("Unavailable"));
    expect(screen.getByLabelText("Resident units")).toHaveTextContent("HOME");
    expect(within(viewport).queryByText("BEA")).toBeNull();
    expect(await view.pendingIntent()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Locate source note" }));
    await waitFor(() => expect(screen.getByLabelText("Location settlement")).toHaveTextContent("Located"));
    expect((await view.pendingIntent())?.desired.locator.locations.text_offset).toBe(4);
  } finally { view.close(); }
});
