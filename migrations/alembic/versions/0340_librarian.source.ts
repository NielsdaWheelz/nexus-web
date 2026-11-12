/** Frozen 0340 conversion of typed body references. The sibling bundle is the
 * runtime dependency; it imports no application code and preserves Yjs clocks.
 * Rebuild: bun build migrations/alembic/versions/0340_librarian.source.ts
 * --target=node --minify --outfile=migrations/alembic/versions/0340_librarian.mjs */
import * as Y from '../../../node/authored/node_modules/yjs/dist/yjs.mjs';

let input='';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input)>32*1024*1024) throw new Error('body batch exceeds 32 MiB');
}
const request=JSON.parse(input);
const mapping: Record<string,string> = request.mapping;
function href(value:string):string {
  if(value==='/conversations' || value==='/conversations/new') return '/librarian';
  const match=/^\/conversations\/([0-9a-f-]{36})(?:\?[^#]*)?(?:#message-([0-9a-f-]{36}))?$/u.exec(value);
  if (!match) {
    if(value.startsWith('/conversations/')) throw new Error(`unsupported conversation destination ${value}`);
    return value;
  }
  const ref=mapping[`conversation:${match[1]}`];
  if (!ref) throw new Error('a linked empty conversation cannot be converted');
  const anchors=new URL(value,'https://nexus.invalid').searchParams.getAll('message');
  if(anchors.length>1 || (anchors.length===1 && !/^[0-9a-f-]{36}$/u.test(anchors[0]!))) throw new Error(`invalid message destination ${value}`);
  return `/librarian?message=${anchors[0] ?? match[2] ?? ref.slice(8)}`;
}
/** The converted atom, or null when it names no conversation. A missing label stays missing. */
function atom(raw:Record<string,any>):Record<string,any>|null {
  if (raw.type!=='resource_embed' || !String(raw.attrs.resource_ref).startsWith('conversation:')) return null;
  const old=raw.attrs.resource_ref, target=mapping[old];
  if (!target) throw new Error(`unmappable embed ${old}`);
  const value=structuredClone(raw);
  value.attrs={...value.attrs,resource_ref:target};
  return value;
}
/** Only a body whose typed refs or link marks changed is re-encoded; every other body
 * returns its input state and projection untouched. */
const bodies=request.bodies.map((body:any)=>{
  const doc=new Y.Doc({gc:false});
  try {
    Y.applyUpdate(doc,Buffer.from(body.state,'base64url'));
    if(doc.store.pendingStructs!==null || doc.store.pendingDs!==null) throw new Error('body has missing causal state');
    const vector=Buffer.from(Y.encodeStateVector(doc)).toString('base64url');
    let changed=false;
    for(const structs of doc.store.clients.values()) for(const struct of structs) {
      if(!(struct instanceof Y.Item)) continue;
      if(struct.content instanceof Y.ContentEmbed) {
        const converted=atom(struct.content.embed);
        if(converted!==null) { struct.content.embed=converted; changed=true; }
      } else if(struct.content instanceof Y.ContentFormat && struct.content.key==='link' && struct.content.value!==null) {
        const mark=struct.content.value, converted=href(mark.href);
        if(converted!==mark.href) { struct.content.value={...mark,href:converted}; changed=true; }
      }
    }
    let projection=body.projection;
    if(projection!==null && Array.isArray(projection.content)) {
      let projected=false;
      const content=projection.content.map((node:any)=>{
        let converted=atom(node);
        const marks=node.marks?.map((mark:any)=>{
          if(mark.type!=='link') return mark;
          const target=href(mark.attrs.href);
          if(target===mark.attrs.href) return mark;
          converted ??= structuredClone(node);
          return {...mark,attrs:{...mark.attrs,href:target}};
        });
        if(converted===null) return node;
        if(marks) converted.marks=marks;
        projected=true;
        return converted;
      });
      if(projected) { projection={...projection,content}; changed=true; }
    }
    if(!changed) return {ref:body.ref,state:body.state,projection:body.projection,changed:false};
    if(Buffer.from(Y.encodeStateVector(doc)).toString('base64url')!==vector) throw new Error('body causal vector changed');
    return {ref:body.ref,state:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64url'),projection,changed:true};
  } finally {doc.destroy();}
});
process.stdout.write(JSON.stringify({bodies}));
