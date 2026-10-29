/** Canonical token policy shared by the DOM and frozen-tree adapters. */
export interface CanonicalToken<Span> { ch: string; spans: Span[] }
export const CANONICAL_BLOCKS = new Set("p li ul ol h1 h2 h3 h4 h5 h6 blockquote pre div section article header footer nav aside figure figcaption table tr td th".split(" "));
export function isCanonicalWhitespace(cp: string): boolean { return cp !== "\uFEFF" && /[\s \u001c-\u001f]/u.test(cp); }
export function canonicalSerialization(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
function codepointLength(text: string): number {
  let length=0; for (const _ch of text) length++;
  return length;
}

/** NFC contributor queues are local to a complete extended grapheme. */
function* normalizedSources(text: string, normalized: string): Generator<{ch:string; indices:number[]}> {
  let sourceIndex=0, normalizedUtf16=0;
  for (const segment of new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text)) {
    const output=segment.segment.normalize("NFC");
    if (normalized.slice(normalizedUtf16,normalizedUtf16+output.length)!==output) throw new Error("Canonical NFC grapheme boundary drifted");
    normalizedUtf16+=output.length;
    if (output===segment.segment) {
      for (const ch of output) yield {ch,indices:[sourceIndex++]};
      continue;
    }
    const queues=new Map<string,{indices:number[];next:number}>();
    for (const ch of segment.segment) {
      for (const decomposed of ch.normalize("NFD")) {
        const queue=queues.get(decomposed);
        if (queue) queue.indices.push(sourceIndex);
        else queues.set(decomposed,{indices:[sourceIndex],next:0});
      }
      sourceIndex++;
    }
    for (const ch of output) {
      const indices:number[]=[];
      for (const decomposed of ch.normalize("NFD")) {
        const queue=queues.get(decomposed), index=queue?.indices[queue.next];
        if (!queue || index===undefined) throw new Error("Canonical NFC provenance decomposition drifted.");
        indices.push(index); queue.next++;
      }
      yield {ch,indices};
    }
    for (const queue of queues.values()) if (queue.next!==queue.indices.length) throw new Error("Canonical NFC provenance left unconsumed source text.");
  }
}

/** Trimmed line coordinates, with at most two synthetic interline newlines. */
function* canonicalCharacters(text: string): Generator<{ch:string; index:number|null}> {
  let utf16=0, scalar=0, pending=0, emitted=false;
  while (utf16<text.length) {
    const newline=text.indexOf("\n",utf16), end=newline<0?text.length:newline;
    let first=utf16, last=end;
    // Every canonical whitespace codepoint is in the BMP. A surrogate therefore
    // ends either trim scan and remains intact in the retained codepoint walk.
    while (first<last && isCanonicalWhitespace(text[first]!)) first++;
    while (last>first && isCanonicalWhitespace(text[last-1]!)) last--;
    let length=first-utf16;
    if (first<last) {
      if (emitted) for (let count=0;count<pending;count++) yield {ch:"\n",index:null};
      pending=0;
      for (const ch of text.slice(first,last)) {yield {ch,index:scalar+length};length++;}
      length+=end-last; emitted=true;
    } else length=end-utf16;
    scalar+=length;
    if (newline<0) break;
    scalar++; pending=Math.min(2,pending+1); utf16=end+1;
  }
}

/** The one canonical normalization policy; provenance is resolved only as emitted.
 * Source adapters retain strings and source runs, never a whole character graph.
 * Changed NFC needs only its current complete grapheme's numeric source queues.
 */
export function* canonicalProjection<Span>(text: string, source: (index:number)=>Span[], unique:(spans:Span[])=>Span[]): Generator<CanonicalToken<Span>> {
  const normalized=text.normalize("NFC");
  if (normalized===text) {
    for (const item of canonicalCharacters(normalized)) yield {ch:item.ch,spans:item.index===null?[]:source(item.index)};
    return;
  }
  const provenance=normalizedSources(text,normalized);
  let index=-1, current: IteratorResult<{ch:string;indices:number[]}> | null=null;
  for (const item of canonicalCharacters(normalized)) {
    if (item.index===null) {yield {ch:item.ch,spans:[]};continue;}
    while (index<item.index) {current=provenance.next();index++;}
    if (current===null || current.done || current.value.ch!==item.ch) throw new Error("Canonical NFC projection drifted");
    yield {ch:item.ch,spans:unique(current.value.indices.flatMap(source))};
  }
}

/** DOM callers retain their existing array contract around the same policy. */
export function canonicalTokens<Span>(tokens: CanonicalToken<Span>[], unique:(spans:Span[])=>Span[]): CanonicalToken<Span>[] {
  const text=tokens.map(token=>token.ch).join(""), starts:number[]=[];
  let length=0;
  for (const token of tokens) {starts.push(length);length+=codepointLength(token.ch);}
  // Joining separately authored surrogate halves was already a provenance defect.
  if (length!==codepointLength(text)) throw new Error("Canonical NFC provenance decomposition drifted.");
  return Array.from(canonicalProjection(text,index=>{
    let lo=0,hi=starts.length;
    while (lo<hi) {const mid=(lo+hi)>>>1;if(starts[mid]!<=index)lo=mid+1;else hi=mid;}
    return tokens[lo-1]!.spans;
  },unique));
}
