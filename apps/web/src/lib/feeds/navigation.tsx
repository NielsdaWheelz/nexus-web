import type { ReactElement } from "react";
import * as Icon from "@/lib/ui/icons";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

/** Source discovery has no library scope; organization chooses its destination afterward. */
export const feedBrowseAction = (kind: "podcast" | "article") => ({
  kind: "link",
  id: kind === "podcast" ? "Podcasts.Browse" : "Feeds.Browse",
  label: kind === "podcast" ? "Browse podcasts" : "Browse feeds",
  icon: <Icon.Browse aria-hidden="true" />,
  href: kind === "podcast" ? "/browse?kind=Podcast" : "/browse?kind=Feed",
} satisfies Extract<ActionDescriptor, { kind: "link" }> & { readonly icon: ReactElement });
