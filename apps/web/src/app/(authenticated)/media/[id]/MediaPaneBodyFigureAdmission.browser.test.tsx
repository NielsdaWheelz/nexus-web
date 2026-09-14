import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it("supplies an admitted figure from the selected generation's own member", async () => {
  const view = await renderMediaPane();
  try {
    await screen.findByRole("button", { name: "Next section" });
    const figure = await screen.findByAltText("authored figure");
    // Never the deferred key, and never another generation: the reader resolves
    // it against exactly the publication whose unit bytes it mounted.
    expect(figure.getAttribute("src"),
      "an authored figure mounted with its member key unresolved").toBe(
      `/api/media/${view.mediaId}/reader-publications/7/${view.figure.key}`);
  } finally { view.close(); }
});
