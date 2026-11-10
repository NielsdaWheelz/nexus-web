/** One mounted writing surface shares a soft presentation allowance. Pressure
 * removes prefetch for the visit; visible/protected writing and undo stay owned. */
import * as Y from "yjs";
import type {WritingDocument} from "./runtime";

interface Member {
  read(): {documents: readonly WritingDocument[]; bytes: number};
  shrink(): void;
}

export class OutlinePresentationAllowance {
  private readonly members = new Set<Member>();
  private pressure = false;
  constructor(private readonly onPressure: () => void) {}
  get pressured(): boolean {return this.pressure;}
  join(member: Member): () => void {
    this.members.add(member);
    if (this.pressure) member.shrink();
    return () => {this.members.delete(member);};
  }
  changed(): void {
    if (this.pressure) return;
    const presentations = [...this.members].map(member => member.read());
    const documents = new Map(presentations.flatMap(value => value.documents.map(document => [document.ref, document] as const)));
    const bytes = [...documents.values()].reduce((total, document) => total + Y.encodeStateAsUpdate(document.doc).byteLength, 0)
      + presentations.reduce((total, value) => total + value.bytes, 0);
    if (documents.size <= 64 && bytes <= 16 * 1024 * 1024) return;
    this.pressure = true;
    this.onPressure();
    for (const member of [...this.members]) member.shrink();
  }
}
