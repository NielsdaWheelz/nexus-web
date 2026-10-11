"use client";

import Button from "@/components/ui/Button";
import type { Schema } from "@/lib/api/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";

export default function ConnectionCreation({ creation }: { creation: Schema<"ConnectionCreationOut"> | null }) {
  const runtime = usePaneRuntime();
  if (!creation) return null;
  const href = creation.conversation_id && creation.message_id
    ? `/conversations/${creation.conversation_id}?message=${creation.message_id}`
    : `/settings/account?generation_id=${creation.generation_id}&tool_call_id=${creation.tool_call_id}#assistant-writes`;
  return <Button variant="ghost" size="sm" asChild>
    <a href={href} onClick={(event) => activateTargetLink({ event, runtime, href, labelHint: "Creation history" })}>View creation</a>
  </Button>;
}
