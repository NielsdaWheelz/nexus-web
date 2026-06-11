export function noteBodyHasContent(input: {
  bodyText: string;
  bodyPmJson: Record<string, unknown>;
}): boolean {
  if (input.bodyText.trim()) {
    return true;
  }
  return bodyPmJsonHasAtomContent(input.bodyPmJson);
}

function bodyPmJsonHasAtomContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "object_ref" || node.type === "object_embed" || node.type === "image") {
    return true;
  }
  if (!Array.isArray(node.content)) {
    return false;
  }
  return node.content.some((child) => bodyPmJsonHasAtomContent(child));
}
