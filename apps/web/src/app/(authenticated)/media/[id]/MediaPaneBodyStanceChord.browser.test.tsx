import { expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

async function focusTheExistingHighlight(view: Awaited<ReturnType<typeof renderMediaPane>>) {
  view.finishSecond();
  await screen.findByRole("button", { name: "Next section" });
  await waitFor(() => expect(screen.getByRole("region", { name: "Document reading area" })).toHaveAttribute("aria-busy", "false"));
  const mark = await screen.findByText("line", { exact: true,
    selector: `[data-active-highlight-ids="${view.existingHighlight?.id ?? ""}"]` });
  await act(async () => { mark.click(); });
  await screen.findByRole("menu", { name: "Highlight actions" });
  await userEvent.keyboard("{Escape}");
}

it("asks once whether the focused passage already holds this stance, then writes it", async () => {
  const view = await renderMediaPane({ existingHighlight: true, stanceAssociations: "empty" });
  try {
    await focusTheExistingHighlight(view);
    await userEvent.keyboard("t");
    await waitFor(() => expect(view.stanceWrites).toHaveLength(1));
    expect(view.associationRequests, "a stance press walked more of the live association list than it asked for").toEqual([null]);
    expect(view.stanceWrites[0]).toMatchObject({ target_ref: `media:${view.mediaId}`, kind: "supports" });
    expect(within(screen.getByRole("region", { name: "HUD feedback" })).queryByText("Highlight wasn’t changed"),
      "a settled stance reported a failure").toBeNull();
    expect(screen.queryByText("This pane couldn’t load"), "a settled stance took down its pane").toBeNull();
    // The settled write refreshes highlights, which re-prepares the unit; the
    // source text is legitimately absent for that tick, so wait for it back.
    await waitFor(() =>
      expect(screen.getByText(/^Home source/), "a settled stance retired the reader's source").toBeVisible(),
    );
  } finally { view.close(); }
});

it("tells the reader when a stance press fails instead of dropping its rejection", async () => {
  const view = await renderMediaPane({ existingHighlight: true, stanceAssociations: "empty", stanceWriteFails: true });
  try {
    await focusTheExistingHighlight(view);
    await userEvent.keyboard("y");
    await waitFor(() => expect(view.stanceWrites).toHaveLength(1));
    const hud = screen.getByRole("region", { name: "HUD feedback" });
    await waitFor(() => expect(within(hud).getByText("Highlight wasn’t changed"),
      "a failed stance chord left the reader with no mark and no message").toBeVisible());
  } finally { view.close(); }
});

it("stops a stance lookup whose continuation does not advance", async () => {
  const view = await renderMediaPane({ existingHighlight: true, stanceAssociations: "stuck" });
  try {
    await focusTheExistingHighlight(view);
    await userEvent.keyboard("t");
    // Page one answers `cursor-1`; page two answers `cursor-1` again, which is a
    // defect, not a branch — the press stops there and writes nothing.
    await screen.findByText("This pane couldn’t load");
    expect(view.associationRequests, "a stuck continuation kept the reader reading pages").toEqual([null, "cursor-1"]);
    expect(view.stanceWrites, "an unanswered stance lookup still wrote a stance").toEqual([]);
  } finally { view.close(); }
});
