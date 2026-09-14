/**
 * One reader-publication member representation, spelled as the API's
 * `_member_response` (python/nexus/api/routes/reader_publications.py) spells it:
 * the JSON media type, the member's byte length, its SHA-256 content digest and
 * the generation the member was published under. `readPublicationMember`
 * refuses a representation missing any of them, so no test fixture may omit one.
 */
export async function readerPublicationMemberResponse<T extends { readonly reader_generation: number }>(
  member: T,
): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(member));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return new Response(bytes, { status: 200, headers: {
    "Content-Type": "application/json",
    "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`,
    "X-Nexus-Reader-Generation": String(member.reader_generation),
  } });
}
