import { render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { absent, present } from "@/lib/api/presence";
import { decodePublicationDateOnly } from "@/lib/dates/publicationDate";
import MediaInfoOverlay from "./MediaInfoOverlay";

function MediaInfoExample({ unknownOriginal }: { unknownOriginal: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        Media info…
      </button>
      <MediaInfoOverlay
        open={open}
        title="Heart of Darkness"
        creditGroups={[
          {
            kind: "Authors",
            credits: [{ label: "Joseph Conrad", href: "/authors/joseph-conrad" }],
          },
        ]}
        originalPublishedDate={
          unknownOriginal
            ? absent()
            : present(decodePublicationDateOnly("1899", "original"))
        }
        editionPublishedDate={present(
          decodePublicationDateOnly("2007-06", "edition"),
        )}
        publisher="Penguin"
        returnFocusTo={() => trigger.current}
        returnFocusFallback={() => trigger.current}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("media info", () => {
  afterEach(async () => {
    await page.viewport(1280, 800);
  });

  it.each([
    { viewport: "desktop" as const, width: 1280, unknownOriginal: false },
    { viewport: "mobile" as const, width: 390, unknownOriginal: true },
  ])(
    "shows scoped dates and credits in the $viewport overlay and returns focus",
    async ({ viewport, width, unknownOriginal }) => {
      await page.viewport(width, 800);
      render(
        withRenderEnvironment(
          <MediaInfoExample unknownOriginal={unknownOriginal} />,
          { initialViewport: viewport },
        ),
      );
      const trigger = screen.getByRole("button", { name: "Media info…" });
      await userEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "Media info" });
      const facts = within(dialog);
      expect(dialog).toHaveTextContent(
        unknownOriginal ? /First published\s*Unknown/ : /First published\s*1899/,
      );
      expect(dialog).toHaveTextContent(/This edition\s*June 2007/);
      expect(dialog).toHaveTextContent(/Publisher\s*Penguin/);
      expect(facts.getByRole("link", { name: "Joseph Conrad" })).toHaveAttribute(
        "href",
        "/authors/joseph-conrad",
      );
      expect(facts.queryByRole("textbox")).toBeNull();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Media info" })).toBeNull();
        expect(trigger).toHaveFocus();
      });
    },
  );
});
