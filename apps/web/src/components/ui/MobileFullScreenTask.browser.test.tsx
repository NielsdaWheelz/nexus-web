import { render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import MobileFullScreenTask from "./MobileFullScreenTask";

function StatefulTask() {
  const [active, setActive] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={openerRef} type="button" onClick={() => setActive(true)}>
        Open editor
      </button>
      <MobileFullScreenTask
        active={active}
        onDismiss={() => setActive(false)}
        onDismissRequest={() => "accepted"}
        ariaLabel="Mobile editor"
        initialFocus={(container) =>
          container.querySelector<HTMLInputElement>("input")
        }
        returnFocusTo={() => openerRef.current}
        focusKey="editor"
      >
        <label>
          Draft
          <input aria-label="Draft" />
        </label>
      </MobileFullScreenTask>
    </>
  );
}

describe("MobileFullScreenTask lifecycle", () => {
  it("keeps an opened task mounted but inaccessible while closed, then restores its state and focus contract", async () => {
    await page.viewport(390, 800);
    render(
      withRenderEnvironment(<StatefulTask />, {
        initialViewport: "mobile",
      }),
    );

    const opener = screen.getByRole("button", { name: "Open editor" });
    expect(
      screen.queryByRole("dialog", { name: "Mobile editor", hidden: true }),
    ).toBeNull();

    await userEvent.click(opener);
    await screen.findByRole("dialog", {
      name: "Mobile editor",
    });
    const draft = screen.getByRole("textbox", { name: "Draft" });
    await waitFor(() => expect(draft).toHaveFocus());
    await userEvent.type(draft, "Keep this work");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Mobile editor" }),
      ).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
      expect(opener).toHaveFocus();
    });

    const retainedDraft = screen.queryByRole("textbox", {
      name: "Draft",
      hidden: true,
    });
    expect(
      retainedDraft,
      "dismissal unmounted the retained mobile task subtree",
    ).not.toBeNull();
    expect(retainedDraft).toHaveValue("Keep this work");
    const hiddenProjection = screen.getByRole("presentation", {
      hidden: true,
    });
    expect(hiddenProjection).toHaveAttribute("hidden");
    expect(hiddenProjection).toHaveAttribute("inert");

    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Mobile editor" });
    const reopenedDraft = screen.getByRole("textbox", { name: "Draft" });
    expect(reopenedDraft).toHaveValue("Keep this work");
    await waitFor(() => expect(reopenedDraft).toHaveFocus());
  });
});
