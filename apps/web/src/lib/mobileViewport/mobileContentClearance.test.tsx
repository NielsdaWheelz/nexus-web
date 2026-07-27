import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import chatStyles from "@/components/chat/ChatSurface.module.css";
import pdfStyles from "@/components/PdfReader.module.css";
import paneStyles from "@/components/workspace/PaneShell.module.css";
import readerStyles from "@/app/(authenticated)/media/[id]/page.module.css";

describe("mobile content bottom clearance consumers", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(
      "--mobile-content-bottom-clearance",
    );
  });

  it("applies the provider-published clearance to primary mobile scroll owners", () => {
    document.documentElement.style.setProperty(
      "--mobile-content-bottom-clearance",
      "73px",
    );
    render(
      <>
        <div className={paneStyles.paneShell} data-mobile="true">
          <div
            className={paneStyles.body}
            data-body-mode="standard"
            data-testid="shell-scroll"
          />
        </div>
        <div className={chatStyles.surface} data-testid="chat-surface">
          <div className={chatStyles.scrollport} data-testid="chat-scrollport" />
        </div>
        <div
          className={readerStyles.documentViewport}
          data-testid="document-scrollport"
        />
        <div
          className={pdfStyles.viewerContainer}
          data-testid="pdf-scrollport"
        />
      </>,
    );

    expect(getComputedStyle(screen.getByTestId("shell-scroll")).paddingBottom)
      .toBe("73px");
    expect(
      getComputedStyle(screen.getByTestId("shell-scroll")).scrollPaddingBottom,
    ).toBe("73px");
    expect(getComputedStyle(screen.getByTestId("chat-surface")).paddingBottom)
      .toBe("73px");
    expect(
      getComputedStyle(screen.getByTestId("chat-scrollport"))
        .scrollPaddingBottom,
    ).toBe("73px");
    expect(
      getComputedStyle(screen.getByTestId("document-scrollport")).paddingBottom,
    ).toBe("73px");
    expect(
      getComputedStyle(screen.getByTestId("pdf-scrollport")).paddingBottom,
    ).toBe("73px");
  });
});
