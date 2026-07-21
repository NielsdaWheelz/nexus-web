"use client";

import type { ReactElement } from "react";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import ResourceHead from "./ResourceHead";
import RunningHead from "./RunningHead";

interface PaneHeaderIdentityProps {
  readonly id: string;
  readonly model: PaneHeaderModel;
}

export default function PaneHeaderIdentity({
  id,
  model,
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
      return <ResourceHead id={id} resource={model.resource} />;
    default: {
      const exhaustive: never = model;
      throw new Error(
        `Unhandled pane header model: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
