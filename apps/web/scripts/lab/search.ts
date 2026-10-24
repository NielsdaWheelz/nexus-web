// three retained search checks; invoke only through the disposable runtime.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { components } from "@/lib/api/wire.gen";
import { browserRequest } from "./browser";
import { readLabContext } from "./context";

const context = readLabContext();
const python = String.raw`import asyncio, json, os, sys
from pathlib import Path
from uuid import UUID, uuid4
context = json.loads(Path(os.environ["NEXUS_LAB_CONTEXT"]).read_text())
os.environ.update(DATABASE_URL=context["database_url"], NEXUS_ENV="test", DATABASE_STATEMENT_TIMEOUT_MS="8000", PGOPTIONS="-c lock_timeout=5000")
from sqlalchemy import text
from nexus.db.session import get_session_factory, get_repeatable_read_db
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_chunking import Chunk, IndexableBlock
from nexus.services.content_indexing import IndexOwner, index_phase, publish_text_index
from nexus.services.contributor_taxonomy import ContributorObservation, ObservedRoleSlices
from nexus.services.contributor_writes import MediaTarget, create_contributor
from nexus.services.contributors import replace_observed_role_slices_batch
from nexus.services.search import discovery, projection
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.reader_publication import advance_reader_publications
from nexus.services.reader_document import read_reader_document
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.search.query import build_discovery_query, scope_from_uri
factory = get_session_factory()
fixture_file = Path(context["artifacts_dir"]) / "search-fixture.json"
mode = sys.argv[1]

def ids(db, owner):
    return set(db.scalars(text("SELECT id FROM content_chunks WHERE owner_kind='media' AND owner_id=:id"), {"id": owner}))

def projected(db, owner, native=False):
    predicate = "search_id @@@ paradedb.term('owner_ref',CAST(:ref AS text))" if native else "owner_ref=:ref"
    return set(db.scalars(text("SELECT ref FROM keyword_occurrences WHERE family='content_chunk' AND " + predicate), {"ref": "media:" + str(owner)}))

def publish(db, owner, passages):
    fragment = db.scalar(text("SELECT id FROM fragments WHERE media_id=:id"), {"id": owner})
    blocks, chunks, offset = [], [], 0
    for i, body in enumerate(passages):
        locator = {"type": "web_text_offsets", "kind": "web_text", "fragment_id": str(fragment), "fragment_idx": 0,
                   "start_offset": offset, "end_offset": offset + len(body)}
        blocks.append(IndexableBlock(body, offset, locator))
        chunks.append(Chunk(i, body, locator))
        offset += len(body) + 2
    return publish_text_index(db, owner=IndexOwner("media", owner), source_kind="web_article",
                              blocks=blocks, chunks=chunks, reason="oracle_corpus_seed")

def terminal(owner, passages):
    def attempt(db):
        return publish(db, owner, passages)
    return index_phase("lab_search_text_publication", attempt)

async def read(viewer, scope="all", q="labneedle", view="resources"):
    query = build_discovery_query(text=q, raw_kinds=["documents"],
        raw_formats=None, raw_authors=None, raw_roles=None, scope=scope_from_uri(scope))
    return (await discovery.search(viewer, query, phase="lexical", view=view, cursor=None,
        limit=50, deadline=asyncio.get_running_loop().time()+10)).model_dump(mode="json")

if mode == "seed":
    viewer = UUID(context["seed"]["user_id"])
    other, a, b, hidden, left, right = [uuid4() for _ in range(6)]
    bodies = ["labneedle " + " ".join(["filler"] * 200),
              "labneedle labneedle strongest literal evidence", "labneedle labneedle strongest literal evidence"]
    with factory() as db:
        ensure_user_and_default_library(db, other, None)
        for library, owner in [(left, viewer), (right, viewer)]:
            db.execute(text("INSERT INTO libraries(id,owner_user_id,name) VALUES (:id,:owner,'search fixture')"), {"id":library,"owner":owner})
            db.execute(text("INSERT INTO memberships(library_id,user_id,role) VALUES (:id,:owner,'admin')"), {"id":library,"owner":owner})
        private = db.scalar(text("SELECT id FROM libraries WHERE owner_user_id=:id AND is_default"), {"id":other})
        for media, owner, library, body in [(a,viewer,left,"\n\n".join(bodies)),(b,viewer,right,"labneedle second visible work"),(hidden,other,private,"labneedle secret forbidden evidence")]:
            db.execute(text("INSERT INTO media(id,kind,title,processing_status,created_by_user_id,plain_text) VALUES (:id,'web_article','fixture work','ready_for_reading',:owner,:body)"), {"id":media,"owner":owner,"body":body})
            db.execute(text("INSERT INTO fragments(media_id,idx,canonical_text,html_sanitized) VALUES (:id,0,:body,:html)"), {"id":media,"body":body,"html":"<p>"+body.replace("\n","<br>")+"</p>"})
            db.execute(text("INSERT INTO library_entries(library_id,media_id) VALUES (:library,:id)"), {"library":library,"id":media})
            assert generate_canonical_text("<p>"+body.replace("\n","<br>")+"</p>")==body, "fixture HTML differs from canonical body"
            replace_media_apparatus(db,media_id=media,note_groups=[])
            advance_reader_publications(db,media_ids=[media])
            document=read_reader_document(db,owner,media)
            assert document.kind=="web_article" and len(document.units)==1, "fixture has no canonical reader publication"
            assert document.units[0].canonical_text==body, "reader publication changed fixture body"
            if media==a:
                fragment_id=str(document.units[0].id)
            publish(db,media,bodies if media==a else [body])
        person = create_contributor(db, display_name="fixture writer")
        for media in (a,b):
            db.execute(text("INSERT INTO contributor_credits(contributor_id,media_id,credited_name,role,ordinal,source) VALUES (:person,:media,'fixture writer','author',0,'user')"), {"person":person.contributor_id,"media":media})
        # Only fixture initialization refreshes manually. Changed writers below must own it.
        projection.refresh(db,"media",[a,b,hidden])
        projection.refresh(db,"fragment",db.scalars(text("SELECT id FROM fragments WHERE media_id=ANY(:ids)"), {"ids":[a,b,hidden]}).all())
        db.commit()
    fixture={"viewer":str(viewer),"other":str(other),"a":str(a),"b":str(b),"hidden":str(hidden),"left":str(left),"right":str(right),"person":str(person.contributor_id),"handle":person.handle,"bodies":bodies,"fragment_id":fragment_id}
    fixture_file.write_text(json.dumps(fixture)); fixture_file.chmod(0o600)
    print(json.dumps(fixture))
else:
    f=json.loads(fixture_file.read_text()); a,b=UUID(f["a"]),UUID(f["b"])
    if mode == "scope":
        async def scope_check():
            for viewer, expected in [(f["viewer"],{f["a"],f["b"]}),(f["other"],{f["hidden"]})]:
                result=await read(UUID(viewer))
                assert {r["item"]["ref"] for r in result["results"]}=={"media:"+x for x in expected}, "viewer isolation"
            for scope, expected in [(f["left"],f["a"]),(f["right"],f["b"])]:
                result=await read(UUID(f["viewer"]),"library:"+scope)
                assert [r["item"]["ref"] for r in result["results"]]==["media:"+expected], "scope isolation"
            from nexus.errors import NotFoundError
            try:
                await read(UUID(f["viewer"]), "media:"+f["hidden"])
            except NotFoundError:
                pass
            else:
                raise AssertionError("hidden scope was admitted")
        asyncio.run(scope_check())
    elif mode == "atomic":
        with factory() as old:
            get_repeatable_read_db(old)
            before=ids(old,a); refs={"content_chunk:"+str(x) for x in before}
            assert projected(old,a,True)==refs
            terminal(a,["\n\n".join(f["bodies"])])
            assert ids(old,a)==before and projected(old,a,True)==refs, "old native snapshot changed"
        with factory() as db:
            after=ids(db,a)
            assert after and not before.intersection(after)
            assert projected(db,a)==projected(db,a,True)=={"content_chunk:"+str(x) for x in after}, "replacement retained old ids"
        with factory() as db:
            publish(db,a,f["bodies"]); db.rollback()
            assert ids(db,a)==after and projected(db,a,True)=={"content_chunk:"+str(x) for x in after}, "rollback leaked"
        terminal(a,[])
        with factory() as db:
            assert not ids(db,a) and not projected(db,a,True), "empty replacement retained text"
        observation=ObservedRoleSlices(frozenset({"author"}), (ContributorObservation("aliasdependencytoken","author",None,None,f["handle"]),))
        replace_observed_role_slices_batch([(MediaTarget(a),observation,"user")])
        with factory() as db:
            for owner in (a,b):
                row=db.execute(text("SELECT contributors FROM keyword_occurrences WHERE doc_key=:ref"), {"ref":"media:"+str(owner)}).scalar_one()
                assert "aliasdependencytoken" in row, "real alias publisher missed credited sibling"
            assert db.scalar(text("SELECT count(*) FROM keyword_occurrences WHERE search_id @@@ paradedb.term('contributors','aliasdependencytoken') AND doc_key=ANY(:refs)"), {"refs":["media:"+str(a),"media:"+str(b)]})==2
        terminal(a,f["bodies"])
    elif mode == "evidence":
        async def evidence_check():
            # One stable post-publication corpus. The oracle independently scores every
            # eligible fixture occurrence, including the full fragment; no family is hidden.
            with factory() as db:
                oracle=db.execute(text('''
                    SELECT ref,family,pdb.score(search_id) AS score FROM keyword_occurrences
                    WHERE search_id @@@ paradedb.boolean(must=>ARRAY[
                        paradedb.parse('body:("labneedle")',conjunction_mode=>true),
                        paradedb.const_score(0,paradedb.term('owner_ref',CAST(:owner AS text)))])
                    ORDER BY score DESC,ref COLLATE "C"
                '''), {"owner":"media:"+str(a)}).mappings().all()
                assert {r["family"] for r in oracle}=={"fragment","content_chunk"}, "oracle omitted competing family"
                dense=db.scalars(text("SELECT id FROM content_chunks WHERE owner_id=:id AND chunk_text=:body ORDER BY id"), {"id":a,"body":f["bodies"][1]}).all()
                dense_refs=["content_chunk:"+str(x) for x in dense]
                tied=[r for r in oracle if r["ref"] in dense_refs]
                assert len(tied)==2 and tied[0]["score"]==tied[1]["score"], "identical dense passages did not tie"
                assert tied[0]["ref"]==min(dense_refs), "canonical tie order differs"
                top_refs=[r["ref"] for r in oracle if r["score"]==oracle[0]["score"]]
                assert len(top_refs)>=2 and set(top_refs)==set(dense_refs), "fixture has no global strongest tie"
                winner=oracle[0]
                assert winner["ref"]==min(top_refs), "global strongest tie winner differs"
                scheme, identity=winner["ref"].split(":")
                table,column=("content_chunks","chunk_text") if scheme=="content_chunk" else ("fragments","canonical_text")
                literal=db.scalar(text("SELECT "+column+" FROM "+table+" WHERE id=:id"), {"id":UUID(identity)})
                locator=db.scalar(text("SELECT summary_locator FROM content_chunks WHERE id=:id"), {"id":UUID(identity)}) if scheme=="content_chunk" else {"start_offset":0,"end_offset":len(literal)}
                assert db.scalar(text("SELECT canonical_text FROM fragments WHERE media_id=:id"), {"id":a})=="\n\n".join(f["bodies"])
                assert db.scalar(text("SELECT plain_text FROM media WHERE id=:id"), {"id":a})=="\n\n".join(f["bodies"])
            result=await read(UUID(f["viewer"]),"media:"+str(a))
            assert len(result["results"])==1
            passage=result["results"][0]["matching_passage"]
            assert passage["item"]["ref"]==winner["ref"], "application winner differs from independent native oracle"
            assert passage["match"]["excerpt"]["text"]==literal
            assert passage["match"]["ranges"] and passage["item"]["activation"]["kind"]=="route"
            anchor="chunk" if scheme=="content_chunk" else "fragment"
            assert passage["item"]["activation"]["href"]=="/media/"+str(a)+"#"+anchor+"-"+identity, "canonical occurrence activation differs"
            return {"passage":passage,"start":locator["start_offset"],"end":locator["end_offset"]}
        print(json.dumps(asyncio.run(evidence_check())))
    else:
        raise AssertionError("unknown retained check")`;
const execute = promisify(execFile);
async function run(mode: string): Promise<string> {
  try {
    const { stdout } = await execute(join(context.worktree, "python/.venv/bin/python"), ["-c", python, mode], {
      cwd: context.worktree, env: process.env, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const diagnostic = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const assertion = diagnostic.split("\n").find(line => line.startsWith("AssertionError:"));
    throw new Error(`search ${mode} failed${assertion ? `: ${assertion}` : ""}`);
  }
}
// justify-type-assertion: the owned fixture emits exactly these public ids.
const fixture = JSON.parse(await run("seed")) as { a: string; b: string; left: string; right: string; fragment_id: string };
const browser = await chromium.launch({
  args: [`--ignore-certificate-errors-spki-list=${context.web_tls.leaf_spki_sha256}`],
});
try {
  const session = await browser.newContext({ storageState: context.browser_state_file });
  const page = await session.newPage();
  await page.goto(context.web_origin, { waitUntil: "domcontentloaded" });
  async function search(scope = "all") {
    const query = new URLSearchParams({ q: "labneedle", phase: "lexical", view: "resources", scope,
      kinds: "documents", limit: "50" });
    const response = await browserRequest(page, {
      web_origin: context.web_origin,
      path: `/api/search?${query}`,
      method: "GET",
      headers: {},
      body: null,
    });
    assert.equal(response.status, 200, "browser search request failed");
    // justify-type-assertion: the search route returns the generated page directly; the BFF preserves its body.
    const body = JSON.parse(response.body) as components["schemas"]["SearchResourcesResponse"];
    assert.equal(body.phase, "lexical", "browser returned the wrong search phase");
    assert.equal(body.view, "resources", "browser returned the wrong search view");
    assert.ok(Array.isArray(body.results), "browser search page has no results array");
    return body;
  }
  await run("scope");
  assert.deepEqual(new Set((await search()).results.map(row => row.item.ref)), new Set([`media:${fixture.a}`, `media:${fixture.b}`]));
  assert.deepEqual((await search(`library:${fixture.left}`)).results.map(row => row.item.ref), [`media:${fixture.a}`]);
  assert.deepEqual((await search(`library:${fixture.right}`)).results.map(row => row.item.ref), [`media:${fixture.b}`]);
  console.log("scope isolation passed");
  await run("atomic");
  console.log("atomic replacement passed (canonical text attempt and contributor batch; worker fences separate)");
  // justify-type-assertion: the fixture emits the canonical generated occurrence shape.
  const proof = JSON.parse(await run("evidence")) as {
    passage: components["schemas"]["SearchOccurrenceOut"]; start: number; end: number;
  };
  const evidence = proof.passage;
  const row = (await search(`media:${fixture.a}`)).results[0];
  assert.deepEqual(row.matching_passage, evidence, "browser evidence differs from canonical reader");
  await page.goto(`${context.web_origin}/search?${new URLSearchParams({ q: "labneedle", kinds: "documents", scope: `media:${fixture.a}` })}`, { waitUntil: "domcontentloaded" });
  assert.ok(evidence.match, "oracle passage has no literal evidence");
  await page.getByText(evidence.match.excerpt.text, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  const target = evidence.item.activation.href;
  assert.ok(target, "canonical passage route missing");
  // Match the actual occurrence link, not the owner's separate title route.
  const link = page.locator(`a[href="${target}"]`).first();
  await link.waitFor({ state: "visible", timeout: 15_000 });
  await link.click();
  await page.waitForURL(url => url.pathname + url.hash === target, { timeout: 15_000 });
  const reader = page.locator(`[data-reader-unit="${fixture.fragment_id}"] [data-reader-text]`).filter({ hasText: evidence.match.excerpt.text }).first();
  await reader.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(({ fragment, literal, start, end }) => {
    const highlight = CSS.highlights.get("source-inspection");
    if (!highlight) return false;
    return [...highlight].some(span => {
      const startUnit = span.startContainer.parentElement?.closest("[data-reader-unit]");
      const endUnit = span.endContainer.parentElement?.closest("[data-reader-unit]");
      if (startUnit?.getAttribute("data-reader-unit") !== fragment || endUnit !== startUnit) return false;
      const range = document.createRange();
      range.setStart(span.startContainer, span.startOffset);
      range.setEnd(span.endContainer, span.endOffset);
      if (range.toString() !== literal) return false;
      const text = startUnit.querySelector("[data-reader-text]");
      if (!text) return false;
      const prefix = document.createRange();
      prefix.selectNodeContents(text);
      prefix.setEnd(span.startContainer, span.startOffset);
      const before = prefix.cloneContents();
      // This owned fixture uses only one paragraph and explicit <br> newlines.
      const actualStart = Array.from(before.textContent ?? "").length + before.querySelectorAll("br").length;
      return actualStart === start && actualStart + Array.from(literal).length === end;
    });
  }, { fragment: fixture.fragment_id, literal: evidence.match.excerpt.text, start: proof.start, end: proof.end }, { timeout: 15_000 });
  console.log("owner evidence passed");
} finally {
  await browser.close();
}
