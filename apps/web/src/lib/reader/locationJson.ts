/** Location codecs refuse duplicate fields instead of accepting JSON.parse's last value. */
export function parseLocationJson(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  // Complete string tokens hide their colons. A duplicate key disappears on
  // reserialization; all other object fields retain exactly one colon.
  const fields = (json: string) => (json.match(/"(?:[^"\\]|\\.)*"|:/g) ?? []).filter((token) => token === ":").length;
  return fields(raw) === fields(JSON.stringify(value)) ? value : null;
}
