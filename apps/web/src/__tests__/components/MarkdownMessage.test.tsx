import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard"
);

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    return;
  }

  Reflect.deleteProperty(navigator, "clipboard");
});

describe("MarkdownMessage", () => {
  it("copies the clicked code block when languages repeat", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.resolve());

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MarkdownMessage
        content={[
          "```ts",
          "const selected = 'first';",
          "```",
          "",
          "```ts",
          "const selected = 'second';",
          "```",
        ].join("\n")}
      />
    );

    await user.click(screen.getAllByRole("button", { name: "copy" })[1]);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    const copiedText = writeText.mock.calls[0]?.[0];
    expect(copiedText).toContain("second");
    expect(copiedText).not.toContain("first");
  });
});
