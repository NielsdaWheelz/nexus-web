import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Sidenote from "./Sidenote";

describe("Sidenote", () => {
  it("starts collapsed: aria-expanded false, data-open false", () => {
    render(<Sidenote>Note text</Sidenote>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("data-open", "false");
  });

  it("expands on click: aria-expanded true, data-open true", async () => {
    render(<Sidenote>Note text</Sidenote>);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary")).toHaveAttribute("data-open", "true");
  });

  it("collapses on second click: returns to false", async () => {
    render(<Sidenote>Note text</Sidenote>);
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("data-open", "false");
  });

  it("renders children inside the aside", () => {
    render(<Sidenote><span>Marginal note</span></Sidenote>);
    expect(screen.getByRole("complementary", { hidden: true })).toHaveTextContent("Marginal note");
  });
});
