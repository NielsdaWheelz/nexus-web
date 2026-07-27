import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LauncherItem } from "@/lib/launcher/model";
import { KEYBOARD_LAUNCHER_TARGET_ACTIVATION } from "@/lib/launcher/dispatch";
import type { LauncherController } from "./useLauncherController";
import LauncherInput from "./LauncherInput";

const item: LauncherItem = {
  id: "libraries",
  title: "Libraries",
  keywords: [],
  sectionId: "go",
  icon: () => null,
  target: { kind: "href", href: "/libraries", externalShell: false },
  source: "static",
  rank: {},
};

function controller(select: ReturnType<typeof vi.fn>): LauncherController {
  return {
    view: { state: "querying", results: [item] },
    input: { text: "libraries", explicitLane: null },
    lane: "all",
    query: "libraries",
    activeId: item.id,
    select,
  } as unknown as LauncherController;
}

describe("LauncherInput activation intent", () => {
  it("sends Enter selection to the controller as Follow/Keyboard", () => {
    const select = vi.fn();
    render(<LauncherInput controller={controller(select)} />);

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search, add, or ask" }),
      { key: "Enter" },
    );

    expect(select).toHaveBeenCalledWith(
      item,
      KEYBOARD_LAUNCHER_TARGET_ACTIVATION,
    );
  });
});
