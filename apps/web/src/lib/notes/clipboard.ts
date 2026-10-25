/** Block clipboard carries canonical bodies and explicit parent indices. Notes are
 * copied by value; other resources are copied by reference. No durable format or
 * old clipboard grammar is read here. */
import { DOMParser as PMParser, Fragment, type Node as PMNode } from "prosemirror-model";
import { bodyText, noteBodySchema, parseBody, type NoteBody } from "@nexus/authored/body";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { RESOURCE_CLIPBOARD_TYPE } from "@/lib/ui/copyText";
export const OUTLINE_CLIPBOARD = "application/x-nexus-authored-outline+json";
export type ClipItem = {kind:"note";body:NoteBody;parent:number|null}|{kind:"resource";ref:string;label:string;parent:number|null};
export function writeOutlineClipboard(clipboard:DataTransfer,items:readonly ClipItem[]):void {
  clipboard.setData(OUTLINE_CLIPBOARD,JSON.stringify(items));
  const depths:number[]=[];
  clipboard.setData("text/plain",items.map((item,index)=>{
    depths[index]=item.parent===null?0:depths[item.parent]!+1;
    return `${"  ".repeat(depths[index]!)}- ${item.kind==="note"?item.body.body_text:item.label}`;
  }).join("\n"));
}
export function readOutlineClipboard(clipboard:DataTransfer):ClipItem[] {
  const own=clipboard.getData(OUTLINE_CLIPBOARD);
  if(own){
    const items:unknown=JSON.parse(own);
    if(!Array.isArray(items))throw new TypeError("Invalid copied outline");
    return items.map((item:unknown,index):ClipItem=>{
      if(!item||typeof item!=="object"||!("parent" in item)||!("kind" in item))throw new TypeError("Invalid copied item");
      const parent=item.parent;
      if(parent!==null&&!(typeof parent==="number"&&Number.isInteger(parent)&&parent>=0&&parent<index))throw new TypeError("Copied parents must precede children");
      if(item.kind==="note"&&"body" in item&&item.body&&typeof item.body==="object"&&"body_pm_json" in item.body)return {kind:"note",parent,body:parseBody(item.body.body_pm_json)};
      if(item.kind==="resource"&&"ref" in item&&typeof item.ref==="string"&&parseResourceRef(item.ref)&&"label" in item&&typeof item.label==="string")return {kind:"resource",parent,ref:item.ref,label:item.label};
      throw new TypeError("Invalid copied resource");
    });
  }
  const reference=clipboard.getData(RESOURCE_CLIPBOARD_TYPE);
  if(reference){
    const value:unknown=JSON.parse(reference);
    if(!value||typeof value!=="object"||!("ref" in value)||typeof value.ref!=="string"||!parseResourceRef(value.ref))throw new TypeError("Invalid copied reference");
    return [{kind:"resource",ref:value.ref,label:value.ref,parent:null}];
  }
  const html=clipboard.getData("text/html");
  if(html){
    const body=new DOMParser().parseFromString(html,"text/html").body;
    const roots=[...body.querySelectorAll("ul,ol")].filter(list=>!list.parentElement?.closest("ul,ol"));
    const rest=body.cloneNode(true) as HTMLElement;
    rest.querySelectorAll("ul,ol").forEach(list=>list.remove());
    if(roots.length&&!rest.textContent?.trim()){
      const items:ClipItem[]=[];
      const visit=(list:Element,parent:number|null)=>{
        for(const li of list.children){
          if(li.tagName!=="LI")continue;
          const own=li.cloneNode(true) as HTMLElement;own.querySelectorAll("ul,ol").forEach(list=>list.remove());
          const nodes:PMNode[]=[];
          const slice=PMParser.fromSchema(noteBodySchema).parseSlice(own);
          slice.content.forEach(node=>{
            if(node.isInline)nodes.push(node);
            else {if(nodes.length)nodes.push(noteBodySchema.nodes.hard_break!.create());node.content.forEach(child=>nodes.push(child));}
          });
          const only=slice.content.firstChild;
          const node=slice.content.childCount===1&&only?.type===noteBodySchema.nodes.body?only:noteBodySchema.nodes.body!.create(null,Fragment.fromArray(nodes));
          items.push({kind:"note",parent,body:parseBody(node.toJSON())});
          const index=items.length-1;
          for(const nested of li.querySelectorAll(":scope > ul,:scope > ol"))visit(nested,index);
        }
      };
      roots.forEach(list=>visit(list,null));return items;
    }
  }
  const parents:{indent:number;index:number}[]=[];
  return clipboard.getData("text/plain").split(/\r?\n/u).filter(line=>line.trim()).map((line,index)=>{
    const [,space="",text=""]=/^(\s*)(?:[-*+]\s+)?(.*)$/u.exec(line)!;
    const indent=space.replaceAll("\t","  ").length;
    while(parents.length&&parents.at(-1)!.indent>=indent)parents.pop();
    const parent=parents.at(-1)?.index??null;parents.push({indent,index});
    return {kind:"note",parent,body:bodyText(text)};
  });
}
