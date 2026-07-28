import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LauncherItem } from "@/lib/launcher/model";
import LauncherRow from "./LauncherRow";

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

function mountLauncherRow() {
  const onSelect = vi.fn();
  render(
    <LauncherRow
      item={item}
      selected={false}
      onSelect={onSelect}
      onDrill={vi.fn()}
      onTrailing={vi.fn()}
      onHover={vi.fn()}
    />,
  );
  return onSelect;
}

describe("LauncherRow activation intent", () => {
  it("derives Follow/Pointer from a plain pointer click", () => {
    const onSelect = mountLauncherRow();

    fireEvent.click(screen.getByRole("option", { name: "Libraries" }), {
      detail: 1,
    });

    expect(onSelect).toHaveBeenCalledWith(item, {
      disposition: { kind: "Follow" },
      modality: "Pointer",
    });
  });

  it("derives Fork/Pointer only for Shift pointer clicks", () => {
    const onSelect = mountLauncherRow();

    fireEvent.click(screen.getByRole("option", { name: "Libraries" }), {
      detail: 1,
      shiftKey: true,
    });

    expect(onSelect).toHaveBeenCalledWith(item, {
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
  });

  it("keeps Shift keyboard activation as Follow/Keyboard", () => {
    const onSelect = mountLauncherRow();

    fireEvent.click(screen.getByRole("option", { name: "Libraries" }), {
      detail: 0,
      shiftKey: true,
    });

    expect(onSelect).toHaveBeenCalledWith(item, {
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });
  });
});
