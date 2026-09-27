/** A canonical body is empty only when its one block has no user nodes. */
export function noteBodyHasContent(input: {
  bodyPmJson: Record<string, unknown>;
}): boolean {
  const body = input.bodyPmJson;
  return body.type === "object_embed" ||
    (Array.isArray(body.content) && body.content.length > 0);
}
