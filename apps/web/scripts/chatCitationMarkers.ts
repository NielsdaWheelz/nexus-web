/** Raw UTF-8 markdown on stdin; JSON markers in original codepoint offsets. */
import { readFileSync } from "node:fs";
import { parseCitationMarkers } from "../src/lib/chat/markdownCitations";

const markdown = readFileSync(0, "utf8");
const codepoints: number[] = [];
let offset = 0;
let count = 0;
for (const character of markdown) {
  codepoints[offset] = count++;
  offset += character.length;
}
codepoints[offset] = count;
const markers = parseCitationMarkers(markdown).map((marker) => {
  const start = codepoints[marker.start];
  const end = codepoints[marker.end];
  if (start === undefined || end === undefined) throw new Error("Citation adapter: marker splits a codepoint");
  return { ordinal_text: marker.ordinal_text, start, end };
});
process.stdout.write(JSON.stringify(markers));
