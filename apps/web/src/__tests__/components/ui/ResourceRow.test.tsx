import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";

function computedLineHeightPx(style: CSSStyleDeclaration): number {
  const lineHeight = Number.parseFloat(style.lineHeight);
  return Number.isFinite(lineHeight)
    ? lineHeight
    : Number.parseFloat(style.fontSize) * 1.2;
}

describe("ResourceRow", () => {
  it("keeps supporting links and controls outside the title activation", () => {
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{
            kind: "link",
            href: "/media/media-1",
            paneLabelHint: "Media title",
          }}
          title="Media title"
          supporting={<a href="https://example.test/authors/ada">Ada Author</a>}
          primaryControl={<button type="button">Primary control</button>}
          actions={<button type="button">More actions</button>}
        />
      </ResourceList>,
    );

    const title = screen.getByRole("link", { name: "Media title" });
    const contributor = screen.getByRole("link", { name: "Ada Author" });
    expect(title).toHaveAttribute("href", "/media/media-1");
    expect(title).toHaveAttribute("data-pane-label-hint", "Media title");
    expect(within(title).getByText("Media title")).toHaveAttribute("dir", "auto");
    expect(title).not.toContainElement(contributor);
    expect(title).not.toContainElement(
      screen.getByRole("button", { name: "Primary control" }),
    );
    expect(title).not.toContainElement(
      screen.getByRole("button", { name: "More actions" }),
    );
  });

  it("keeps an Artifact Revision on its canonical standalone route", () => {
    const revisionRef =
      "artifact_revision:11111111-1111-4111-8111-111111111111";
    const href =
      `/artifacts/${encodeURIComponent("artifact:22222222-2222-4222-8222-222222222222")}` +
      `?revision=${encodeURIComponent(revisionRef)}`;
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{
            kind: "link",
            href,
            resourceActivation: {
              resourceRef: revisionRef,
              kind: "route",
              href,
              unresolvedReason: null,
            },
          }}
          title="Historical Dossier"
        />
      </ResourceList>,
    );

    const link = screen.getByRole("link", { name: "Historical Dossier" });
    expect(link).toHaveAttribute("href", href);
    expect(link).not.toHaveAttribute("data-pane-secondary-activation");
    expect(link).not.toHaveAttribute("data-pane-dossier-revision");
  });

  it("renders the one caller-owned status", () => {
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{ kind: "static" }}
          title="Static item"
          status={<span>Failed</span>}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Failed")).toBeVisible();
  });

  it("does not activate a disabled primary from inert row chrome", () => {
    const onActivate = vi.fn();
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{
            kind: "button",
            label: "Unavailable item",
            disabled: true,
            onActivate,
          }}
          title="Unavailable item"
          supporting="Unavailable metadata"
        />
      </ResourceList>,
    );

    expect(
      screen.getByRole("button", { name: "Unavailable item" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("Unavailable metadata"));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps independent controls above inert row activation", async () => {
    const onActivate = vi.fn();
    const onPrimaryControl = vi.fn();
    const onAction = vi.fn();
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{ kind: "button", label: "Open item", onActivate }}
          title="Item title"
          supporting="Updated just now"
          primaryControl={
            <button type="button" onClick={onPrimaryControl}>
              Play
            </button>
          }
          actions={<button onClick={onAction}>Row action</button>}
        />
      </ResourceList>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onPrimaryControl).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Row action" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();

    const primary = screen.getByRole("button", { name: "Open item" });
    const primaryRect = primary.getBoundingClientRect();
    const supportingRect = screen
      .getByText("Updated just now")
      .getBoundingClientRect();
    await userEvent.click(primary, {
      position: {
        x: supportingRect.left - primaryRect.left + supportingRect.width / 2,
        y: supportingRect.top - primaryRect.top + supportingRect.height / 2,
      },
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("keeps supporting links above the row activation target", async () => {
    const onActivate = vi.fn();
    const onSupporting = vi.fn();
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{ kind: "button", label: "Open item", onActivate }}
          title="Item title"
          supporting={
            <a
              href="https://example.test/messages"
              onClick={(event) => {
                event.preventDefault();
                onSupporting();
              }}
            >
              1 message
            </a>
          }
        />
      </ResourceList>,
    );

    const supporting = screen.getByRole("link", { name: "1 message" });
    expect(supporting).toHaveAttribute("href", "https://example.test/messages");
    await userEvent.click(supporting);
    expect(onSupporting).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each([320, 390, 640, 960])(
    "allocates a long title before independent controls in a %ipx container",
    (width) => {
      const titleText =
        "The Architecture of Attention: A Field Guide to Reading, Listening, and Remembering Across Decades";
      render(
        <div
          data-testid="host"
          style={{ width: `${width}px`, maxWidth: `${width}px` }}
        >
          <span
            data-testid="canonical-gap"
            aria-hidden="true"
            style={{ position: "absolute", width: "var(--space-2)" }}
          />
          <ResourceList ariaLabel="Resources">
            <ResourceRow
              primary={{ kind: "link", href: "/media/long-row" }}
              title={titleText}
              supporting="Mina Okafor · Longform essay · Updated yesterday"
              status={<span>42% read · 18 min left</span>}
              primaryControl={<button type="button">Play</button>}
              actions={
                <button type="button" aria-label="More actions">
                  •••
                </button>
              }
            />
          </ResourceList>
        </div>,
      );

      const host = screen.getByTestId("host");
      expect(host.clientWidth).toBe(width);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(horizontallyScrollableElements(host)).toEqual([]);
      const title = within(
        screen.getByRole("link", { name: titleText }),
      ).getByText(titleText);
      const titleStyle = getComputedStyle(title);
      const titleLineHeight = computedLineHeightPx(titleStyle);
      expect(titleStyle.webkitLineClamp).toBe(
        width <= 520 ? "2" : "none",
      );
      expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(
        titleLineHeight * (width <= 520 ? 2 : 1) + 1,
      );

      const canonicalGap = screen
        .getByTestId("canonical-gap")
        .getBoundingClientRect().width;
      expect(canonicalGap).toBeGreaterThan(0);
      const firstControlLeft = Math.min(
        screen
          .getByRole("button", { name: "Play" })
          .getBoundingClientRect().left,
        screen
          .getByRole("button", { name: "More actions" })
          .getBoundingClientRect().left,
      );
      expect(
        firstControlLeft - title.getBoundingClientRect().right,
      ).toBeGreaterThanOrEqual(canonicalGap);

      const support = screen.getByText(
        "Mina Okafor · Longform essay · Updated yesterday",
      );
      const supportStyle = getComputedStyle(support);
      expect(supportStyle.whiteSpace).toBe("nowrap");
      expect(support.getBoundingClientRect().height).toBeLessThanOrEqual(
        computedLineHeightPx(supportStyle) + 1,
      );

      const state = screen.getByText("42% read · 18 min left");
      const stateStyle = getComputedStyle(state);
      expect(stateStyle.whiteSpace).toBe("nowrap");
      expect(state.getBoundingClientRect().height).toBeLessThanOrEqual(
        computedLineHeightPx(stateStyle) + 1,
      );
      if (width <= 520) {
        expect(Math.abs(
          support.getBoundingClientRect().top - state.getBoundingClientRect().top,
        )).toBeLessThanOrEqual(2);
      }
      expect(
        screen
          .getByRole("button", { name: "More actions" })
          .getBoundingClientRect().right,
      ).toBeLessThanOrEqual(host.getBoundingClientRect().right + 1);
    },
  );

  it("left-aligns a state-only narrow secondary line", () => {
    render(
      <div data-testid="host" style={{ width: "320px", maxWidth: "320px" }}>
        <ResourceList ariaLabel="Resources">
          <ResourceRow
            primary={{ kind: "link", href: "/media/processing" }}
            title="A processing item with a title that uses two lines"
            status={<span>Processing</span>}
            actions={<button type="button">…</button>}
          />
        </ResourceList>
      </div>,
    );

    const title = within(
      screen.getByRole("link", {
        name: "A processing item with a title that uses two lines",
      }),
    ).getByText("A processing item with a title that uses two lines");
    const state = screen.getByText("Processing");
    expect(Math.abs(
      title.getBoundingClientRect().left - state.getBoundingClientRect().left,
    )).toBeLessThanOrEqual(1);
    expect(screen.getByTestId("host").scrollWidth).toBeLessThanOrEqual(321);
  });
});
