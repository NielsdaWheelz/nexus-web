import { describe, expect, it, vi } from "vitest";
import { documentMapAction } from "./documentMapAction";

describe("documentMapAction", () => {
  it("omits a controlled-region reference while collapsed", () => {
    const action = documentMapAction({
      expanded: false,
      regionId: "reader-region",
      onToggle: vi.fn(),
    });

    expect(action.state).toEqual({
      kind: "disclosure",
      expanded: false,
      menuLabels: {
        collapsed: "Show Document Map",
        expanded: "Hide Document Map",
      },
    });
    expect(action.restoreFocusOnClose).toBe(false);
  });

  it("references the mounted region while expanded", () => {
    const onToggle = vi.fn();
    const action = documentMapAction({
      expanded: true,
      regionId: "reader-region",
      onToggle,
    });

    expect(action.state).toMatchObject({
      kind: "disclosure",
      expanded: true,
      controls: "reader-region",
    });
    const detail = { triggerEl: document.createElement("button") };
    if (action.kind === "command") action.onSelect(detail);
    expect(onToggle).toHaveBeenCalledWith(detail);
  });
});
