import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";

function Harness({ initial = "a" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList aria-label="Sections">
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b">Bravo</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Alpha panel</TabsContent>
      <TabsContent value="b">Bravo panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("renders a tablist with two triggers and shows initial panel", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();

    const tabA = screen.getByRole("tab", { name: "Alpha" });
    const tabB = screen.getByRole("tab", { name: "Bravo" });
    expect(tabA).toHaveAttribute("aria-selected", "true");
    expect(tabB).toHaveAttribute("aria-selected", "false");

    expect(screen.getByText("Alpha panel")).toBeInTheDocument();
    expect(screen.queryByText("Bravo panel")).not.toBeInTheDocument();
  });

  it("flips the selected panel when a different trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Bravo" }));

    expect(screen.getByRole("tab", { name: "Bravo" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("Bravo panel")).toBeInTheDocument();
    expect(screen.queryByText("Alpha panel")).not.toBeInTheDocument();
  });

  it("cycles to the next trigger and selects it on ArrowRight", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const tabA = screen.getByRole("tab", { name: "Alpha" });
    tabA.focus();

    await user.keyboard("{ArrowRight}");

    const tabB = screen.getByRole("tab", { name: "Bravo" });
    expect(tabB).toHaveFocus();
    expect(tabB).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Bravo panel")).toBeInTheDocument();
  });
});
