"use client";

import Button from "@/components/ui/Button";
import type { Schema } from "@/lib/api/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";

export default function ConnectionCreation({ creation }: { creation: Schema<"ConnectionCreationOut"> | null }) {
  const runtime = usePaneRuntime();
  if (!creation) return null;
  const record = creation.record;
  if (record.kind === "unavailable") return <span>Creation history unavailable · {creation.authorship.position_path}</span>;
  const href = record.kind === "chat"
    ? `/conversations/${record.conversation_id}?message=${record.message_id}`
    : `/settings/account?generation_id=${record.generation_id}&position_id=${record.position_id}#background-writes`;
  return <Button variant="ghost" size="sm" asChild>
    <a href={href} onClick={(event) => activateTargetLink({ event, runtime, href, labelHint: "Creation history" })}>View creation</a>
  </Button>;
}
