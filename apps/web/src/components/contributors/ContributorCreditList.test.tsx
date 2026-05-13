import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ContributorCreditList from "./ContributorCreditList";

describe("ContributorCreditList", () => {
  it("omits raw unlinked contributor credits", () => {
    const { container } = render(
      <ContributorCreditList
        credits={[
          {
            contributor_handle: "",
            contributor_display_name: "Raw Author",
            credited_name: "Raw Author",
            role: "author",
            source: "provider",
            href: "",
          },
        ]}
      />,
    );

    expect(screen.queryByText("Raw Author")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
