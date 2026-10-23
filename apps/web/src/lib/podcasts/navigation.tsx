import type { ReactElement } from "react";
import { Plus } from "lucide-react";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

/** Podcast discovery is global; explicit organization chooses its destination afterward. */
export const PODCAST_BROWSE_ACTION: Extract<ActionDescriptor, { kind: "link" }> & { readonly icon: ReactElement } = {
  kind: "link",
  id: "Podcasts.Browse",
  label: "browse podcasts",
  icon: <Plus size={20} aria-hidden="true" />,
  href: "/browse?kind=Podcast",
};
