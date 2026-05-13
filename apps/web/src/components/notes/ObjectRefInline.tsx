import { hrefForObject } from "@/lib/objectLinks";
import type { HydratedObjectRef } from "@/lib/objectRefs";

export default function ObjectRefInline({ object }: { object: HydratedObjectRef }) {
  const href = hrefForObject(object);
  if (!href) {
    return <span>{object.label}</span>;
  }
  return <a href={href}>{object.label}</a>;
}
