import type { ReactElement } from "react";
import * as Icon from "@/lib/ui/icons";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

/** Podcast discovery is global; explicit organization chooses its destination afterward. */
export const PODCAST_BROWSE_ACTION = {
  kind: "link",
  id: "Podcasts.Browse",
  label: "Browse podcasts",
  icon: <Icon.Browse aria-hidden="true" />,
  href: "/browse?kind=Podcast",
} satisfies Extract<ActionDescriptor, { kind: "link" }> & { readonly icon: ReactElement };
