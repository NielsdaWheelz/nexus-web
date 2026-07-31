"use client";

import type { ReactElement } from "react";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import ResourceHead from "./ResourceHead";
import RunningHead from "./RunningHead";

type PaneHeaderProjection = "Desktop" | "Mobile";

interface PaneHeaderIdentityProps {
  readonly creditsInert?: boolean;
  readonly id: string;
  readonly model: PaneHeaderModel;
  readonly projection: PaneHeaderProjection;
}

function maxVisibleCredits(projection: PaneHeaderProjection): 1 | 2 {
  switch (projection) {
    case "Desktop":
      return 2;
    case "Mobile":
      return 1;
  }
}

export default function PaneHeaderIdentity({
  creditsInert = false,
  id,
  model,
  projection,
}: PaneHeaderIdentityProps): ReactElement {
  switch (model.kind) {
    case "section":
      return (
        <RunningHead
          id={id}
          standingHead={model.standingHead}
          folio={model.folio}
          folioPending={model.pending}
        />
      );
    case "resource":
      return (
        <ResourceHead
          creditsInert={creditsInert}
          id={id}
          maxVisibleCredits={maxVisibleCredits(projection)}
          resource={model.resource}
        />
      );
    default: {
      const exhaustive: never = model;
      throw new Error(
        `Unhandled pane header model: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
