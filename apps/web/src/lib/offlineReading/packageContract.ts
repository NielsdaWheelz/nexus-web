/** Strict bridge JSON: bounded nesting, duplicate keys rejected, no trailing content. */
export function parseStrictJsonValue(raw: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/\s/u.test(raw[offset] ?? "")) offset += 1;
  };
  const stringValue = (): string => {
    whitespace();
    if (raw[offset] !== '"') throw new TypeError("Expected JSON string");
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      if (raw[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (raw[offset] === '"') {
        offset += 1;
        return JSON.parse(raw.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new TypeError("Unterminated JSON string");
  };
  const value = (depth: number): unknown => {
    if (depth > 16) throw new TypeError("JSON is too deeply nested");
    whitespace();
    if (raw[offset] === "{") {
      offset += 1;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (raw[offset] === "}") {
        offset += 1;
        return result;
      }
      while (true) {
        const key = stringValue();
        // `Set.add` returns the set itself, so it can never be the emptiness
        // test here: ask before inserting.
        if (keys.has(key)) throw new TypeError(`Duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        if (raw[offset] !== ":") throw new TypeError("Expected JSON colon");
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (raw[offset] === "}") {
          offset += 1;
          return result;
        }
        if (raw[offset] !== ",") throw new TypeError("Expected JSON comma");
        offset += 1;
      }
    }
    if (raw[offset] === "[") {
      offset += 1;
      const result: unknown[] = [];
      whitespace();
      if (raw[offset] === "]") {
        offset += 1;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        if (raw[offset] === "]") {
          offset += 1;
          return result;
        }
        if (raw[offset] !== ",") throw new TypeError("Expected JSON comma");
        offset += 1;
      }
    }
    if (raw[offset] === '"') return stringValue();
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (raw.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const match = raw
      .slice(offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new TypeError("Invalid JSON value");
    offset += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) throw new TypeError("Invalid JSON number");
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (offset !== raw.length) throw new TypeError("Trailing JSON content");
  return parsed;
}
