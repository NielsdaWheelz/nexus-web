/** A mounted writing surface shares one finite undo allowance. Presentation
 * leases do not consume it; only actual chronology and causal captures do. */
import * as Y from "yjs";
import type {WritingDocument} from "./runtime";

interface Member {
  documents(): readonly WritingDocument[];
  bytes(): number;
  retiring(): boolean;
  oldest(): number | null;
  retire(): void;
  changed(): void;
}

export class OutlineHistoryAllowance {
  private sequence = 0;
  private readonly members = new Set<Member>();
  stamp(): number {return ++this.sequence;}
  join(member: Member): () => void {
    this.members.add(member);
    return () => {this.members.delete(member);};
  }
  trim(): void {
    // Retirement still owns its documents until settlement calls trim again.
    if (![...this.members].some(member => member.retiring())) {
      const documents = new Set([...this.members].flatMap(member => member.documents()));
      const bytes = [...documents].reduce((total, document) => total + Y.encodeStateAsUpdate(document.doc).byteLength, 0)
        + [...this.members].reduce((total, member) => total + member.bytes(), 0);
      if (documents.size > 64 || bytes > 16 * 1024 * 1024) {
        let oldest: Member | null = null, stamp = Infinity;
        for (const member of this.members) {
          const candidate = member.oldest();
          if (candidate !== null && candidate < stamp) {oldest = member; stamp = candidate;}
        }
        oldest?.retire();
      }
    }
    for (const member of this.members) member.changed();
  }
}
