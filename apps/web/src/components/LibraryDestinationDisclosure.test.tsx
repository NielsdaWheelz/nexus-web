import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LibraryDestinationDisclosure from "./LibraryDestinationDisclosure";

function Harness({ creating = false }: { creating?: boolean }) {
  const [open, setOpen] = useState(creating);
  return (
    <LibraryDestinationDisclosure
      label="Libraries"
      open={open}
      onOpenChange={setOpen}
      selected={[]}
      onChange={() => undefined}
      interaction={creating ? { kind: "Creating" } : { kind: "Enabled" }}
      onCreateDestination={async (name) => ({
        id: "created",
        name,
        color: null,
      })}
    />
  );
}

describe("LibraryDestinationDisclosure", () => {
  it("opens from its compact trigger and Escape closes with focus restored", async () => {
    render(<Harness />);

    const trigger = screen.getByRole("button", {
      name: "Libraries My Library only Change",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("combobox", { name: "Libraries" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false"),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("stays mounted and consumes Escape while destination creation is active", () => {
    render(<Harness creating />);

    const trigger = screen.getByRole("button", {
      name: "Libraries My Library only Close",
    });
    expect(trigger).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Libraries" })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("combobox", { name: "Libraries" }),
    ).toBeInTheDocument();
  });
});
