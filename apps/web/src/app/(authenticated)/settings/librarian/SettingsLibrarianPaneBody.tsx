"use client";

import { Failed } from "@/components/feedback/Fact";
import PaneSurface from "@/components/ui/PaneSurface";
import type { Visit } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { useProfile } from "../useProfile";
import ReadingBrief from "./ReadingBrief";
import Writes from "./Writes";

const VISIT = definePaneVisitDataKey<Visit<ApiJson<"/me", "get">["data"]>>("Settings.Librarian");

export default function SettingsLibrarianPaneBody() {
  const { profile, failure, accept, reload } = useProfile(VISIT);
  const params = usePaneSearchParams();
  const generationId = params.get("generation_id");
  const toolCallId = params.get("tool_call_id");
  return <PaneSurface measured brief="what you’ve asked of the librarian, and what it has written in your name.">
    {failure ? <Failed error={failure.error} noun="librarian settings" retry={{ run: failure.retry, busy: failure.retrying }} /> : null}
    <ReadingBrief profile={profile} onSaved={accept} reload={reload} />
    <Writes key={`${generationId ?? "all"}:${toolCallId ?? "none"}`} generationId={generationId} toolCallId={toolCallId} />
  </PaneSurface>;
}
