export function noteBodyHasContent(input: {
  bodyText: string;
  bodyPmJson: Record<string, unknown>;
}): boolean {
  if (input.bodyText.trim()) {
    return true;
  }
  return bodyPmJsonHasProjectedAtomContent(input.bodyPmJson);
}

function bodyPmJsonHasProjectedAtomContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "object_ref" || node.type === "object_embed") {
    const attrs =
      typeof node.attrs === "object" && node.attrs !== null
        ? (node.attrs as Record<string, unknown>)
        : null;
    if (!attrs) return false;
    if (typeof attrs.label === "string" && attrs.label.length > 0) {
      return Boolean(attrs.label.trim());
    }
    return (
      typeof attrs.objectType === "string" &&
      attrs.objectType.length > 0 &&
      typeof attrs.objectId === "string" &&
      attrs.objectId.length > 0
    );
  }
  if (node.type === "image") {
    const attrs =
      typeof node.attrs === "object" && node.attrs !== null
        ? (node.attrs as Record<string, unknown>)
        : null;
    return Boolean(
      attrs && typeof attrs.alt === "string" && attrs.alt.trim(),
    );
  }
  if (!Array.isArray(node.content)) {
    return false;
  }
  return node.content.some((child) =>
    bodyPmJsonHasProjectedAtomContent(child),
  );
}
