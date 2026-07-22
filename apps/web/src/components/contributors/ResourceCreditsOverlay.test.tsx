import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import ResourceCreditsOverlay from "./ResourceCreditsOverlay";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("ResourceCreditsOverlay", () => {
  it("shows the complete wrapping title, groups, and links", () => {
    vi.stubGlobal("innerWidth", 1280);
    render(
      <ResourceCreditsOverlay
        open
        title="The Left Hand of Darkness"
        creditGroups={[
          {
            kind: "authors",
            credits: [
              { label: "Ursula K. Le Guin", href: "/authors/ursula-le-guin" },
              { label: "Brian Attebery" },
            ],
          },
          {
            kind: "role",
            label: "Translator",
            credits: [{ label: "Margaret Chodos-Irvine" }],
          },
        ]}
        returnFocusTo={() => null}
        returnFocusFallback={() => null}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("The Left Hand of Darkness")).toBeVisible();
    expect(screen.getByText("Authors")).toBeVisible();
    expect(screen.getByText("Translator")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Ursula K. Le Guin" }),
    ).toHaveAttribute("href", "/authors/ursula-le-guin");
    expect(screen.getByText("Brian Attebery")).toBeVisible();
  });

  it("keeps the complete title inspectable when no credits exist", () => {
    vi.stubGlobal("innerWidth", 1280);
    render(
      <ResourceCreditsOverlay
        open
        title="A deliberately long title with no credited contributors"
        creditGroups={[]}
        returnFocusTo={() => null}
        returnFocusFallback={() => null}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("A deliberately long title with no credited contributors"),
    ).toBeVisible();
    expect(screen.queryByText("Authors")).not.toBeInTheDocument();
  });

  it("dismisses through the shared overlay", async () => {
    vi.stubGlobal("innerWidth", 1280);
    const onClose = vi.fn();
    render(
      <ResourceCreditsOverlay
        open
        title="Dune"
        creditGroups={[
          {
            kind: "authors",
            credits: [{ label: "Frank Herbert" }],
          },
        ]}
        returnFocusTo={() => null}
        returnFocusFallback={() => null}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps long mobile credits wrapping inside the sheet scroll owner", () => {
    const credits = Array.from({ length: 40 }, (_, index) => ({
      label: `Contributor ${index + 1} with an intentionally long credited name`,
    }));
    render(
      withRenderEnvironment(
        <ResourceCreditsOverlay
          open
          title="A complete resource title that must remain inspectable"
          creditGroups={[{ kind: "authors", credits }]}
          returnFocusTo={() => null}
          returnFocusFallback={() => null}
          onClose={vi.fn()}
        />,
        { initialViewport: "mobile" },
      ),
    );

    const content = screen.getByTestId("resource-credits-complete");
    expect(getComputedStyle(content).overflowY).toBe("auto");
    expect(
      getComputedStyle(screen.getByText(credits[0].label)).whiteSpace,
    ).not.toBe("nowrap");
    expect(screen.getByText(credits.at(-1)!.label)).toBeVisible();
  });
});
