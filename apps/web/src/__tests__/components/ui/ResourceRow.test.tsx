import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText("Media title")).toHaveAttribute("dir", "auto");
    expect(title).not.toContainElement(contributor);
    expect(title).not.toContainElement(
      screen.getByRole("button", { name: "Primary control" }),
    );
    expect(title).not.toContainElement(
      screen.getByRole("button", { name: "More actions" }),
    );
  });

  it("derives an exact Dossier revision command from a resource activation", () => {
    const revisionRef =
      "artifact_revision:11111111-1111-4111-8111-111111111111";
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{
            kind: "link",
            href: "/conversations/22222222-2222-4222-8222-222222222222",
            resourceActivation: {
              resourceRef: revisionRef,
              kind: "route",
              href: "/conversations/22222222-2222-4222-8222-222222222222",
              unresolvedReason: null,
            },
          }}
          title="Historical Dossier"
        />
      </ResourceList>,
    );

    expect(
      screen.getByRole("link", { name: "Historical Dossier" }),
    ).toHaveAttribute("data-pane-secondary-activation", "DossierRevision");
    expect(
      screen.getByRole("link", { name: "Historical Dossier" }),
    ).toHaveAttribute("data-pane-dossier-revision", revisionRef);
  });

  it("renders one exceptional state instead of normal activity", () => {
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{ kind: "static" }}
          title="Static item"
          activity={<span>Finished</span>}
          exceptionalStatus={<span>Failed</span>}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("keeps action activation independent from button primary activation", async () => {
    const onActivate = vi.fn();
    const onAction = vi.fn();
    render(
      <ResourceList ariaLabel="Resources">
        <ResourceRow
          primary={{ kind: "button", label: "Open item", onActivate }}
          title="Item title"
          actions={<button onClick={onAction}>Row action</button>}
        />
      </ResourceList>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Row action" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open item" }));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it.each([320, 390, 960])(
    "stays within a populated %ipx container with the correct title clamp",
    (width) => {
      const titleText =
        "A very long resource title that can occupy two lines without widening its container";
      render(
        <div data-testid="host" style={{ width: `${width}px`, maxWidth: `${width}px` }}>
          <ResourceList ariaLabel="Resources">
            <ResourceRow
              primary={{ kind: "link", href: "/media/long-row" }}
              title={titleText}
              supporting="Ada Author · February 2025 · A long compact context that must truncate"
              activity={<span>42% · ≈5 min left</span>}
              primaryControl={<button type="button">Open</button>}
              actions={<button type="button">…</button>}
            />
          </ResourceList>
        </div>,
      );

      const host = screen.getByTestId("host");
      expect(host.clientWidth).toBe(width);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(horizontallyScrollableElements(host)).toEqual([]);
      expect(screen.queryByRole("img")).toBeNull();
      const title = screen.getByText(titleText);
      const titleStyle = getComputedStyle(title);
      const titleLineHeight = computedLineHeightPx(titleStyle);
      expect(titleStyle.webkitLineClamp).toBe(
        width <= 520 ? "2" : "none",
      );
      expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(
        titleLineHeight * (width <= 520 ? 2 : 1) + 1,
      );

      const support = screen.getByText(
        "Ada Author · February 2025 · A long compact context that must truncate",
      );
      const supportStyle = getComputedStyle(support);
      expect(supportStyle.whiteSpace).toBe("nowrap");
      expect(support.getBoundingClientRect().height).toBeLessThanOrEqual(
        computedLineHeightPx(supportStyle) + 1,
      );

      const state = screen.getByText("42% · ≈5 min left");
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
      expect(screen.getByText("…").getBoundingClientRect().right).toBeLessThanOrEqual(
        host.getBoundingClientRect().right + 1,
      );
    },
  );

  it("left-aligns a state-only narrow secondary line", () => {
    render(
      <div data-testid="host" style={{ width: "320px", maxWidth: "320px" }}>
        <ResourceList ariaLabel="Resources">
          <ResourceRow
            primary={{ kind: "link", href: "/media/processing" }}
            title="A processing item with a title that uses two lines"
            exceptionalStatus={<span>Processing</span>}
            actions={<button type="button">…</button>}
          />
        </ResourceList>
      </div>,
    );

    const title = screen.getByText(
      "A processing item with a title that uses two lines",
    );
    const state = screen.getByText("Processing");
    expect(Math.abs(
      title.getBoundingClientRect().left - state.getBoundingClientRect().left,
    )).toBeLessThanOrEqual(1);
    expect(screen.getByTestId("host").scrollWidth).toBeLessThanOrEqual(321);
  });
});
