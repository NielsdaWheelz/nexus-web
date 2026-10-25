// three retained search checks; invoke only through the disposable runtime.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { components } from "@/lib/api/wire.gen";
import { browserRequest, openLabBrowser } from "./browser";
import { readLabContext } from "./context";

const context = readLabContext();
const fixturePath = join(context.artifacts_dir, "search-fixture.json");
const evidencePath = join(context.artifacts_dir, "search-evidence.private.json");
const resultPath = join(context.artifacts_dir, "search-retained.private.json");
const facts: Record<string, unknown> = { scope: null, atomic: null, evidence: null };
async function saveFacts() {
  const pending = `${resultPath}.pending`;
  await writeFile(pending, JSON.stringify(facts), { mode: 0o600 });
  await rename(pending, resultPath);
}
await saveFacts();
const python = String.raw`import asyncio, json, os, sys, time
from pathlib import Path
from uuid import UUID, uuid4
context = json.loads(Path(os.environ["NEXUS_LAB_CONTEXT"]).read_text())
os.environ.update(DATABASE_URL=context["database_url"], NEXUS_ENV="test", DATABASE_STATEMENT_TIMEOUT_MS="8000", PGOPTIONS="-c lock_timeout=5000")
from sqlalchemy import text
from nexus.db.session import get_session_factory, get_repeatable_read_db
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_chunking import Chunk, IndexableBlock
from nexus.services.content_indexing import IndexOwner, _read_sections, index_phase, prepare_media_parts, publish_text_index
from nexus.services.contributor_taxonomy import ContributorObservation, ObservedRoleSlices
from nexus.services.contributor_writes import MediaTarget, create_contributor
from nexus.services.contributors import replace_observed_role_slices_batch
from nexus.services.search import discovery, projection
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.reader_publication import advance_reader_publications
from nexus.services.reader_document import read_reader_document
from nexus.services.reader_navigation import read_media_navigation_proof
from nexus.services.media import get_media_for_viewer, read_processing_snapshot
from nexus.services import authored, highlights, library_entries, library_members, libraries
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.web_article_structure import prepare_web_article_fragment
from nexus.services.media_parts import create_part
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.library_members import CreateInvitationRequest
from nexus.schemas.media_parts import PartCreate, PartPrepare, SectionSelection
from nexus.services.search.query import build_discovery_query, scope_from_uri
factory = get_session_factory()
fixture_file = Path(context["artifacts_dir"]) / "search-fixture.json"
evidence_file = Path(context["artifacts_dir"]) / "search-evidence.private.json"
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

async def read(viewer, scope="all", q="labneedle", view="resources", kinds=("documents",)):
    query = build_discovery_query(text=q, raw_kinds=list(kinds),
        raw_formats=None, raw_authors=None, raw_roles=None, scope=scope_from_uri(scope))
    return (await discovery.search(viewer, query, phase="lexical", view=view, cursor=None,
        limit=50, deadline=asyncio.get_running_loop().time()+10)).model_dump(mode="json")

def await_current_text(owner, *, witness):
    until = time.monotonic() + 45
    while time.monotonic() < until:
        with factory() as db:
            sections = _read_sections(db, owner)
            state = db.execute(text("SELECT revision, lexical_revision, section_witness_key, section_bounds_key FROM content_index_states WHERE owner_kind='media' AND owner_id=:id"), {"id":owner}).one_or_none()
            if sections is not None and state is not None and state.lexical_revision == state.revision and state.section_bounds_key == sections.bounds_key and (not witness or state.section_witness_key == sections.witness_key):
                return
        time.sleep(.25)
    raise AssertionError("source lexical revision, witness or partition did not publish")

def create_highlight(db, viewer, *, highlight_id, media_id, fragment_id, start, end, words, prefix, suffix, publication):
    """One canonical authored highlight; its projection owns rows and search publication."""
    selection = {"publication": publication, "quote_exact": words, "prefix": prefix, "suffix": suffix, "passage_ref": None,
                 "locator": {"type": "web_text_offsets", "media_id": str(media_id), "fragment_id": str(fragment_id),
                             "start_offset": start, "end_offset": end, "media_kind": "web_article",
                             "text_quote_selector": {"exact": words, "prefix": prefix, "suffix": suffix}}}
    authored.server_command(db, viewer, command={"kind": "create_highlight", "ref": "highlight:" + str(highlight_id),
                            "source_ref": "media:" + str(media_id), "selection": selection, "color": "yellow"},
                            resource_refs=[], link_ids=[])

if mode == "seed":
    print("seed_stage=fixture_rows", file=sys.stderr, flush=True)
    viewer = UUID(context["seed"]["user_id"])
    other, a, b, hidden, left, right = [uuid4() for _ in range(6)]
    source, part, stale, crossing_highlight, shared_library = [uuid4() for _ in range(5)]
    inside, neighbour = "ochrepartneedle", "cobaltneighbourneedle"
    stale_term = "vermilionmargin"
    stale_quote = stale_term + " remembers an absent passage"
    source_html = "<section><h2>chosen passage</h2><p>" + inside + " belongs to this small section.</p></section><section><h2>neighbour passage</h2><p>" + neighbour + " stays outside the piece.</p></section>"
    prepared = prepare_web_article_fragment(html=source_html, base_url="https://example.invalid/lab-piece", document_url="https://example.invalid/lab-piece", fragment_idx=0)
    source_body = prepared.canonical_text
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
            assert library_entries.ensure_entry(db,library,library_entries.media_target(media))
            assert generate_canonical_text("<p>"+body.replace("\n","<br>")+"</p>")==body, "fixture HTML differs from canonical body"
            replace_media_apparatus(db,media_id=media,note_groups=[])
            advance_reader_publications(db,media_ids=[media])
            document=read_reader_document(db,owner,media)
            assert document.kind=="web_article" and len(document.units)==1, "fixture has no canonical reader publication"
            assert document.units[0].canonical_text==body, "reader publication changed fixture body"
            if media==a:
                fragment_id=str(document.units[0].id)
            publish(db,media,bodies if media==a else [body])
        db.execute(text("INSERT INTO media(id,kind,title,processing_status,created_by_user_id,plain_text) VALUES (:id,'web_article','fixture source','ready_for_reading',:owner,:body)"), {"id":source,"owner":viewer,"body":source_body})
        db.execute(text("INSERT INTO fragments(media_id,idx,canonical_text,html_sanitized) VALUES (:id,0,:body,:html)"), {"id":source,"body":source_body,"html":prepared.html_sanitized})
        assert library_entries.ensure_entry(db,left,library_entries.media_target(source))
        replace_media_apparatus(db,media_id=source,note_groups=[])
        advance_reader_publications(db,media_ids=[source])
        assert read_reader_document(db,viewer,source).units[0].canonical_text==source_body
        # A persisted quote can outlive its locator: its captured fragment no longer exists.
        create_highlight(db, viewer, highlight_id=stale, media_id=source, fragment_id=uuid4(), start=0, end=len(stale_quote),
                         words=stale_quote, prefix="", suffix="", publication=None)
        person = create_contributor(db, display_name="fixture writer")
        for media in (a,b):
            db.execute(text("INSERT INTO contributor_credits(contributor_id,media_id,credited_name,role,ordinal,source) VALUES (:person,:media,'fixture writer','author',0,'user')"), {"person":person.contributor_id,"media":media})
        # Only fixture initialization refreshes manually. Changed writers below must own it.
        projection.refresh(db,"media",[a,b,hidden,source])
        projection.refresh(db,"fragment",db.scalars(text("SELECT id FROM fragments WHERE media_id=ANY(:ids)"), {"ids":[a,b,hidden,source]}).all())
        db.commit()
    print("seed_stage=section_choice", file=sys.stderr, flush=True)
    with factory() as db:
        generation=db.scalar(text("SELECT generation FROM reader_publications WHERE media_id=:id"), {"id":source})
        proof=read_media_navigation_proof(db,media_id=source,kind="web_article",generation=generation)
        choice=next(section for section in proof.sections if section.label=="chosen passage")
        assert choice.end is not None and choice.start_cut is not None and choice.end_cut is not None
        assert choice.start.fragment_idx==choice.end.fragment_idx==0
        chosen=source_body[choice.start.offset:choice.end.offset]
        assert inside in chosen and neighbour not in chosen, "fixture section boundary is not isolated"
        section_id, navigation_key = choice.section_id, proof.key
        start, end = choice.start.offset, choice.end.offset
        source_fragment=db.scalar(text("SELECT id FROM fragments WHERE media_id=:id"),{"id":source})
        assert source_fragment is not None
    print("seed_stage=source_highlight", file=sys.stderr, flush=True)
    highlight_start=source_body.index("small section.",start,end)
    highlight_end=highlight_start+len("small section.")
    with factory() as db:
        create_highlight(db, viewer, highlight_id=crossing_highlight, media_id=source, fragment_id=source_fragment,
                         start=highlight_start, end=highlight_end, words=source_body[highlight_start:highlight_end],
                         prefix=source_body[max(0,highlight_start-64):highlight_start], suffix=source_body[highlight_end:highlight_end+64],
                         publication={"kind":"reader","generation":generation})
        db.commit()
    with factory() as db:
        saved=next(h for h in highlights.list_highlights_for_media(db,viewer,source,mine_only=False) if h.id==crossing_highlight)
        assert neighbour in saved.suffix and saved.exact=="small section.", "source highlight lacks crossing context"
    print("seed_stage=prepare_parts", file=sys.stderr, flush=True)
    with factory() as db:
        preparation=prepare_media_parts(db,viewer_id=viewer,source_media_id=source,request=PartPrepare(id=uuid4(),expected_source_generation=generation))
        assert preparation.media_id==source
    print("seed_stage=await_initial_text", file=sys.stderr, flush=True)
    await_current_text(source,witness=True)
    print("seed_stage=create_part", file=sys.stderr, flush=True)
    with factory() as db:
        receipt=create_part(db,viewer_id=viewer,source_media_id=source,request=PartCreate(id=part,selection=SectionSelection(source_generation=generation,navigation_key=navigation_key,section_ids=[section_id]),title=inside+" piece",form=None))
        assert receipt.media_id==part
    print("seed_stage=await_partition_text", file=sys.stderr, flush=True)
    await_current_text(source,witness=True)
    print("seed_stage=share_part", file=sys.stderr, flush=True)
    with factory() as db:
        removal_revision=str(db.scalar(text("SELECT removal_revision FROM users WHERE id=:id"),{"id":viewer}))
    with factory() as db:
        libraries.create_library(db,viewer,CreateLibraryRequest(id=shared_library,name="shared fixture piece",initial_items=["media:"+str(part)],expected_removal_revision=removal_revision))
    invitation=uuid4()
    with factory() as db:
        library_members.create_invitation(db,viewer,shared_library,CreateInvitationRequest(id=invitation,invitee_user_id=other,invitee_email=None,role="member"))
    with factory() as db:
        library_members.respond_to_invitation(db,other,invitation,accept=True)
    fixture={"viewer":str(viewer),"other":str(other),"a":str(a),"b":str(b),"hidden":str(hidden),"left":str(left),"right":str(right),"person":str(person.contributor_id),"handle":person.handle,"bodies":bodies,"fragment_id":fragment_id,"source":str(source),"part":str(part),"shared_library":str(shared_library),"crossing_highlight":str(crossing_highlight),"inside":inside,"neighbour":neighbour,"chosen":chosen,"part_start":start,"part_end":end,"stale":str(stale),"stale_quote":stale_quote,"stale_term":stale_term}
    fixture_file.write_text(json.dumps(fixture)); fixture_file.chmod(0o600)
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
            piece=await read(UUID(f["viewer"]),"media:"+f["part"],f["inside"])
            assert [r["item"]["ref"] for r in piece["results"]]==["media:"+f["part"]], "piece scope admitted the source"
            assert f["neighbour"] not in json.dumps(piece), "piece result leaked neighbouring text"
            assert (await read(UUID(f["viewer"]),"media:"+f["part"],f["neighbour"]))["results"]==[], "piece scope admitted neighbouring text"
            granted=await read(UUID(f["other"]),"media:"+f["part"],f["inside"])
            assert [r["item"]["ref"] for r in granted["results"]]==["media:"+f["part"]], "part-only grantee cannot search the piece"
            shared=(await read(UUID(f["other"]),"library:"+f["shared_library"],f["inside"]))["results"]
            assert [r["item"]["ref"] for r in shared]==["media:"+f["part"]], "shared library search did not isolate the piece"
            assert (await read(UUID(f["other"]),"media:"+f["part"],f["neighbour"]))["results"]==[], "part-only grantee found neighbouring text in the piece"
            assert (await read(UUID(f["other"]),q=f["neighbour"]))["results"]==[], "part-only grantee found neighbouring text globally"
            with factory() as db:
                assert set(db.scalars(text("SELECT media_id FROM library_entries WHERE library_id=:id"),{"id":UUID(f["shared_library"])}))=={UUID(f["part"])}, "shared library filed the source"
                assert get_media_for_viewer(db,UUID(f["other"]),UUID(f["part"])).id==UUID(f["part"]), "part-only grantee cannot read the piece"
                reader=read_reader_document(db,UUID(f["other"]),UUID(f["part"]))
                assert reader.kind=="text_part" and len(reader.units)==1 and reader.units[0].canonical_text==f["chosen"].strip() and f["inside"] in reader.units[0].canonical_text and f["neighbour"] not in reader.units[0].canonical_text, "part-only grantee's reader escaped its section"
                try:
                    get_media_for_viewer(db,UUID(f["other"]),UUID(f["source"]))
                except NotFoundError:
                    pass
                else:
                    raise AssertionError("part-only grantee can read the source")
                try:
                    read_reader_document(db,UUID(f["other"]),UUID(f["source"]))
                except NotFoundError:
                    pass
                else:
                    raise AssertionError("part-only grantee can open the source reader")
            try:
                await read(UUID(f["other"]),"media:"+f["source"],f["inside"])
            except NotFoundError:
                pass
            else:
                raise AssertionError("part-only grantee can search the source")
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
            canonical=db.execute(text("""SELECT 'content_chunk:' || c.id::text AS ref,c.chunk_text AS body,
                s.lexical_revision AS revision FROM content_chunks c
                JOIN content_index_states s ON s.owner_kind=c.owner_kind AND s.owner_id=c.owner_id
                WHERE c.owner_kind='media' AND c.owner_id=:id
                AND c.primary_evidence_span_id IS NOT NULL AND c.chunk_text<>''"""),{"id":a}).mappings().all()
            assert len(canonical)==len(after) and len({r["revision"] for r in canonical})==1, "canonical replacement lacks one current revision"
            revision=canonical[0]["revision"]
            assert revision is not None, "replacement lacks lexical readiness"
            admission=f"content_chunk:{a}:{revision}"
            scalar=db.execute(text("""SELECT ref,body,source_revision,admission_key FROM keyword_occurrences
                WHERE family='content_chunk' AND owner_ref=:owner"""),{"owner":"media:"+str(a)}).mappings().all()
            assert len(scalar)==len(canonical) and {r["ref"]:(r["body"],r["source_revision"],r["admission_key"]) for r in scalar}=={r["ref"]:(r["body"],revision,admission) for r in canonical}, "published chunks differ from canonical text or revision"
            native=set(db.scalars(text("""SELECT ref FROM keyword_occurrences
                WHERE search_id @@@ paradedb.term('admission_key',CAST(:admission AS text))"""),{"admission":admission}))
            assert native=={r["ref"] for r in canonical}, "native admission missed current canonical chunks"
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
            piece=(await read(UUID(f["viewer"]),"media:"+f["part"],f["inside"]))["results"]
            assert len(piece)==1 and piece[0]["item"]["ref"]=="media:"+f["part"]
            bounded=piece[0]["matching_passage"]
            assert bounded is not None and bounded["item"]["ref"].startswith("content_chunk:"), "piece evidence lost canonical source chunk"
            assert bounded["match"] is not None and bounded["match"]["ranges"], "piece evidence has no literal match"
            exact=bounded["match"]["excerpt"]["text"]
            assert f["inside"] in exact and exact in f["chosen"] and f["neighbour"] not in exact, "piece evidence escaped its proved section"
            chunk=bounded["item"]["ref"].split(":",1)[1]
            activation=bounded["item"]["activation"]
            assert activation["resource_ref"]=="media:"+f["part"] and activation["href"]=="/media/"+f["part"]+"#chunk-"+chunk, "piece activation targets the source or an unproved location"
            all_inside=(await read(UUID(f["viewer"]),q=f["inside"]))["results"]
            roots=[r for r in all_inside if r["item"]["ref"]=="media:"+f["source"]]
            assert len(roots)==1 and roots[0]["matching_passage"] is not None, "all-scope root lost its eligible body child"
            root_activation=roots[0]["matching_passage"]["item"]["activation"]
            root_href=root_activation["href"]
            assert root_activation["kind"]=="route" and root_activation["resource_ref"]=="media:"+f["source"] and isinstance(root_href,str) and root_href.split("#",1)[0].split("?",1)[0]=="/media/"+f["source"], "all-scope root child activated another reading"
            titled_parts=[r for r in all_inside if r["item"]["ref"]=="media:"+f["part"]]
            assert len(titled_parts)==1 and titled_parts[0]["matching_passage"] is not None, "title-selected part lost its eligible body child"
            titled_child=titled_parts[0]["matching_passage"]
            assert titled_child["item"]["ref"]==bounded["item"]["ref"] and titled_child["item"]["activation"]["resource_ref"]=="media:"+f["part"] and titled_child["item"]["activation"]["href"]=="/media/"+f["part"]+"#chunk-"+chunk, "title-selected part used the root reading for its child"
            with factory() as db:
                source_chunks=ids(db,UUID(f["source"]))
                assert UUID(chunk) in source_chunks, "piece occurrence is not a current source chunk"
                sections=_read_sections(db,UUID(f["source"]))
                state=db.execute(text("SELECT revision,lexical_revision,section_bounds_key,status FROM content_index_states WHERE owner_kind='media' AND owner_id=:id"), {"id":UUID(f["source"])}).one()
                assert sections is not None and state.lexical_revision==state.revision and state.section_bounds_key==sections.bounds_key, "piece result used an obsolete partition"
                detail=get_media_for_viewer(db,UUID(f["viewer"]),UUID(f["part"]))
                processing=read_processing_snapshot(db,viewer_id=UUID(f["viewer"]),media_id=UUID(f["part"]))
                assert detail.text_search_ready and processing.text_search_ready, "piece lost current lexical capability"
                # A real provider can finish vectors before this later evidence read.
                # Observe the actual lexical-only publication phase under its owner locks;
                # roll it back so the independently scored occurrence ids stay unchanged.
                source_id=UUID(f["source"])
                db.execute(text("SELECT id FROM media WHERE id=:id FOR UPDATE"), {"id":source_id})
                db.execute(text("SELECT owner_id FROM content_index_states WHERE owner_kind='media' AND owner_id=:id FOR UPDATE"), {"id":source_id})
                existing=db.execute(text("SELECT chunk_text,summary_locator,heading_path FROM content_chunks WHERE owner_kind='media' AND owner_id=:id ORDER BY chunk_idx"), {"id":source_id}).mappings().all()
                assert existing, "lexical-only fixture has no canonical chunks"
                with db.begin_nested() as publication:
                    blocks=[IndexableBlock(row["chunk_text"],int(row["summary_locator"].get("start_offset",0)),row["summary_locator"],tuple(row["heading_path"])) for row in existing]
                    chunks=[Chunk(index,row["chunk_text"],row["summary_locator"]) for index,row in enumerate(existing)]
                    published=publish_text_index(db,owner=IndexOwner("media",source_id),source_kind="web_article",blocks=blocks,chunks=chunks,reason="oracle_corpus_seed")
                    assert published.status=="indexing", "publisher did not expose the lexical-only phase"
                    lexical_detail=get_media_for_viewer(db,UUID(f["viewer"]),UUID(f["part"]))
                    lexical_processing=read_processing_snapshot(db,viewer_id=UUID(f["viewer"]),media_id=UUID(f["part"]))
                    assert lexical_detail.text_search_ready and lexical_processing.text_search_ready, "piece lost lexical capability while vectors are not ready"
                    publication.rollback()
            root_context=(await read(UUID(f["viewer"]),"media:"+f["source"],f["neighbour"],kinds=("highlights",)))["results"]
            assert [r["item"]["ref"] for r in root_context]==["highlight:"+f["crossing_highlight"]], "source highlight lost its stored neighbouring context"
            piece_context=(await read(UUID(f["viewer"]),"media:"+f["part"],f["inside"],kinds=("highlights",)))["results"]
            assert [r["item"]["ref"] for r in piece_context]==["highlight:"+f["crossing_highlight"]], "piece highlight lost its canonical identity or bounded context"
            assert f["neighbour"] not in json.dumps(piece_context), "piece highlight leaked source context beyond its section"
            piece_activation=piece_context[0]["item"]["activation"]
            assert piece_activation["resource_ref"]=="media:"+f["part"] and piece_activation["href"]=="/media/"+f["part"]+"#highlight-"+f["crossing_highlight"], "piece highlight activates outside its reading"
            granted_context=(await read(UUID(f["other"]),"media:"+f["part"],f["inside"],kinds=("highlights",)))["results"]
            assert [r["item"]["ref"] for r in granted_context]==["highlight:"+f["crossing_highlight"]] and f["neighbour"] not in json.dumps(granted_context), "part-only grantee lost the bounded source highlight"
            assert (await read(UUID(f["viewer"]),"media:"+f["part"],f["neighbour"],kinds=("highlights",)))["results"]==[], "piece highlight indexed source context beyond its section"
            stale=(await read(UUID(f["viewer"]),"media:"+f["source"],f["stale_term"],kinds=("highlights",)))["results"]
            assert len(stale)==1 and stale[0]["item"]["ref"]=="highlight:"+f["stale"], "stored unlocated quote is not searchable from its source"
            item=stale[0]["item"]
            assert not item["missing"] and item["preview"]["body"]["kind"]=="passage" and item["preview"]["body"]["exact"]["text"]==f["stale_quote"]
            assert item["activation"]["kind"]=="none" and item["activation"]["href"] is None and item["activation"]["unavailable_reason"]=="location_unavailable", "unlocated quote invented a destination"
            assert item["preview"]["source"]["ref"]=="media:"+f["source"], "stored quote lost its readable source"
            assert (await read(UUID(f["viewer"]),"media:"+f["part"],f["stale_term"],kinds=("highlights",)))["results"]==[], "piece admitted a source-only unlocated quote"
            return {"passage":passage,"start":locator["start_offset"],"end":locator["end_offset"],"piece_passage":bounded,"stale_item":item}
        proof=asyncio.run(evidence_check())
        descriptor=os.open(evidence_file,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(descriptor,"w") as handle:
            json.dump(proof,handle)
    else:
        raise AssertionError("unknown retained check")`;
const execute = promisify(execFile);
async function run(mode: string): Promise<void> {
  facts[mode] = { started: true };
  await saveFacts();
  const started = Date.now();
  try {
    await execute(join(context.worktree, "python/.venv/bin/python"), ["-c", python, mode], {
      cwd: context.worktree, env: process.env, encoding: "utf8",
      timeout: mode === "seed" ? 120_000 : 60_000, maxBuffer: 1024 * 1024,
    });
    facts[mode] = { python_complete: true };
    await saveFacts();
  } catch (error) {
    // justify-type-assertion: promisified execFile attaches these child facts to its error.
    const child = error instanceof Error ? error as Error & { stdout?: unknown; stderr?: unknown;
      code?: number | string | null; signal?: string | null; killed?: boolean } : null;
    const diagnosticText = (value: unknown) => typeof value === "string" ? value
      : value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
    const stdout = join(context.artifacts_dir, `search-${mode}.stdout.private.log`);
    const stderr = join(context.artifacts_dir, `search-${mode}.stderr.private.log`);
    await writeFile(stdout, diagnosticText(child?.stdout), { mode: 0o600, flag: "wx" });
    await writeFile(stderr, diagnosticText(child?.stderr), { mode: 0o600, flag: "wx" });
    facts[mode] = { python_complete: false, error_type: error instanceof Error ? error.name : "unknown",
      child_code: child?.code ?? null, child_signal: child?.signal ?? null,
      child_killed: child?.killed === true, elapsed_ms: Date.now() - started,
      timeout_ms: mode === "seed" ? 120_000 : 60_000, stdout_file: stdout, stderr_file: stderr };
    await saveFacts();
    throw new Error(`search ${mode} failed; private child diagnostics retained`);
  }
}
// justify-type-assertion: the owned fixture emits exactly these public ids.
await run("seed");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { a: string; b: string; left: string; right: string; fragment_id: string; source: string; part: string; inside: string; neighbour: string; stale_term: string; stale_quote: string };
const browser = await openLabBrowser({ web_origin: context.web_origin, web_tls: context.web_tls,
  storage_state: context.browser_state_file });
let diagnosticPage: Page | null = null;
try {
  const browserRequests: Array<Record<string, unknown>> = [];
  facts.browser_requests = browserRequests;
  const { page } = browser;
  diagnosticPage = page;
  await page.goto(context.web_origin, { waitUntil: "domcontentloaded" });
  async function search(scope = "all", text = "labneedle", kinds = "documents") {
    const query = new URLSearchParams({ q: text, phase: "lexical", view: "resources", scope,
      kinds, limit: "50" });
    const response = await browserRequest(page, {
      web_origin: context.web_origin,
      path: `/api/search?${query}`,
      method: "GET",
      headers: {},
      body: null,
    });
    const observed: Record<string, unknown> = { scope, status: response.status };
    browserRequests.push(observed);
    await saveFacts();
    assert.equal(response.status, 200, "browser search request failed");
    // justify-type-assertion: the search route returns the generated page directly; the BFF preserves its body.
    const body = JSON.parse(response.body) as components["schemas"]["SearchResourcesResponse"];
    Object.assign(observed, { phase: body.phase, view: body.view,
      refs: Array.isArray(body.results) ? body.results.map(row => row.item.ref) : null });
    await saveFacts();
    assert.equal(body.phase, "lexical", "browser returned the wrong search phase");
    assert.equal(body.view, "resources", "browser returned the wrong search view");
    assert.ok(Array.isArray(body.results), "browser search page has no results array");
    return body;
  }
  await run("scope");
  const all = await search();
  const left = await search(`library:${fixture.left}`);
  const right = await search(`library:${fixture.right}`);
  facts.scope = { python_complete: true, browser_observed: true };
  await saveFacts();
  assert.deepEqual(new Set(all.results.map(row => row.item.ref)), new Set([`media:${fixture.a}`, `media:${fixture.b}`]));
  assert.deepEqual(left.results.map(row => row.item.ref), [`media:${fixture.a}`]);
  assert.deepEqual(right.results.map(row => row.item.ref), [`media:${fixture.b}`]);
  const piece = await search(`media:${fixture.part}`, fixture.inside);
  const neighbour = await search(`media:${fixture.part}`, fixture.neighbour);
  assert.deepEqual(piece.results.map(row => row.item.ref), [`media:${fixture.part}`]);
  assert.deepEqual(neighbour.results, [], "browser piece scope admitted neighbouring text");
  facts.scope = { python_complete: true, passed: true };
  await saveFacts();
  console.log("scope isolation passed");
  await run("atomic");
  console.log("atomic replacement passed (canonical text attempt and contributor batch; worker fences separate)");
  // justify-type-assertion: the fixture emits the canonical generated occurrence shape.
  await run("evidence");
  const proof = JSON.parse(await readFile(evidencePath, "utf8")) as {
    passage: components["schemas"]["SearchOccurrenceOut"]; start: number; end: number;
    piece_passage: components["schemas"]["SearchOccurrenceOut"];
    stale_item: components["schemas"]["ResourceItemOut"];
  };
  const evidence = proof.passage;
  const row = (await search(`media:${fixture.a}`)).results[0];
  facts.evidence = { python_complete: true, oracle_ref: evidence.item.ref,
    browser_passage_matches: isDeepStrictEqual(row.matching_passage, evidence) };
  await saveFacts();
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
  facts.evidence = { ...(facts.evidence as Record<string, unknown>), reader_highlight_complete: true };
  await saveFacts();
  const pieceRow = (await search(`media:${fixture.part}`, fixture.inside)).results[0];
  assert.deepEqual(pieceRow.matching_passage, proof.piece_passage, "browser piece evidence differs from bounded server evidence");
  const pieceDetail = await browserRequest(page, { web_origin: context.web_origin,
    path: `/api/media/${fixture.part}`, method: "GET", headers: {}, body: null });
  assert.equal(pieceDetail.status, 200, "piece detail is not readable");
  assert.equal((JSON.parse(pieceDetail.body) as { data: { text_search_ready: boolean } }).data.text_search_ready,
    true, "piece detail lost current lexical capability");
  const staleRows = (await search(`media:${fixture.source}`, fixture.stale_term, "highlights")).results;
  assert.deepEqual(staleRows.map(row => row.item.ref), [proof.stale_item.ref]);
  assert.deepEqual(staleRows[0].item, proof.stale_item, "browser lost the stored unavailable quote");
  assert.deepEqual((await search(`media:${fixture.part}`, fixture.stale_term, "highlights")).results, [], "browser piece admitted a source-only unlocated quote");
  await page.goto(`${context.web_origin}/search?${new URLSearchParams({ q: fixture.stale_term, kinds: "highlights", scope: `media:${fixture.source}` })}`, { waitUntil: "domcontentloaded" });
  await page.getByText(fixture.stale_quote, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  facts.evidence = { ...(facts.evidence as Record<string, unknown>), unlocated_quote_visible: true };
  await saveFacts();
  const piecePassage = proof.piece_passage;
  assert.ok(piecePassage.match, "piece passage has no literal match");
  const pieceTarget = piecePassage.item.activation.href;
  assert.ok(pieceTarget, "piece passage has no canonical route");
  await page.goto(`${context.web_origin}/search?${new URLSearchParams({ q: fixture.inside, kinds: "documents", scope: `media:${fixture.part}` })}`, { waitUntil: "domcontentloaded" });
  await page.getByText(piecePassage.match.excerpt.text, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  const pieceLink = page.locator(`a[href="${pieceTarget}"]`).first();
  await pieceLink.waitFor({ state: "visible", timeout: 15_000 });
  await pieceLink.click();
  await page.waitForURL(url => url.pathname + url.hash === pieceTarget, { timeout: 15_000 });
  await page.locator('[data-pane-shell="true"][data-active="true"] [data-reader-text]').filter({ hasText: fixture.inside }).first().waitFor({ state: "visible", timeout: 15_000 });
  facts.evidence = { ...(facts.evidence as Record<string, unknown>), piece_route_opened: true,
    piece_reader_text_visible: true, piece_inspection_wait_started: true };
  await saveFacts();
  await page.waitForFunction(({ inside, neighbour }) => {
    const active = document.querySelector('[data-pane-shell="true"][data-active="true"]');
    if (!active) return false;
    const texts = [...active.querySelectorAll("[data-reader-text]")].map(node => node.textContent ?? "");
    if (!texts.some(text => text.includes(inside)) || texts.some(text => text.includes(neighbour))) return false;
    const highlight = CSS.highlights.get("source-inspection");
    return highlight !== undefined && [...highlight].some(span => {
      if (!span.startContainer.isConnected || !span.endContainer.isConnected) return false;
      const unit = span.startContainer.parentElement?.closest("[data-reader-unit]");
      if (!unit || span.endContainer.parentElement?.closest("[data-reader-unit]") !== unit || !active.contains(unit)) return false;
      try {
        const range = document.createRange();
        range.setStart(span.startContainer, span.startOffset);
        range.setEnd(span.endContainer, span.endOffset);
        return range.toString().includes(inside);
      } catch { return false; }
    });
  }, { inside: fixture.inside, neighbour: fixture.neighbour }, { timeout: 15_000 });
  facts.evidence = { ...(facts.evidence as Record<string, unknown>), piece_reader_highlight_complete: true, passed: true };
  await saveFacts();
  console.log("owner evidence passed");
} catch (error) {
  facts.browser_error_type = error instanceof Error ? error.name : "unknown";
  facts.browser_error_message = error instanceof Error ? error.message : String(error);
  if (diagnosticPage) {
    facts.browser_current_url = diagnosticPage.url();
    try {
      const dom = await diagnosticPage.evaluate(({ inside, neighbour }) => {
        const active = document.querySelector('[data-pane-shell="true"][data-active="true"]');
        const readingText = [...(active?.querySelectorAll("[data-reader-text]") ?? [])].map(node => node.textContent ?? "");
        const ranges = (name: string) => [...(CSS.highlights.get(name) ?? [])].map(span => {
          const connected = span.startContainer.isConnected && span.endContainer.isConnected;
          let literal: string | null = null;
          let rangeError: string | null = null;
          if (connected) {
            try {
              const range = document.createRange();
              range.setStart(span.startContainer, span.startOffset);
              range.setEnd(span.endContainer, span.endOffset);
              literal = range.toString();
            } catch (error) {
              rangeError = error instanceof Error ? error.name : "unknown";
            }
          }
          const startUnit = span.startContainer.parentElement?.closest("[data-reader-unit]");
          const endUnit = span.endContainer.parentElement?.closest("[data-reader-unit]");
          return { connected, start_unit: startUnit?.getAttribute("data-reader-unit") ?? null,
            end_unit: endUnit?.getAttribute("data-reader-unit") ?? null, in_active_pane: Boolean(active && startUnit && endUnit && active.contains(startUnit) && active.contains(endUnit)),
            start_offset: span.startOffset, end_offset: span.endOffset, literal, range_error: rangeError };
        });
        return { url: location.href, active_pane_found: Boolean(active), reader_units: [...(active?.querySelectorAll("[data-reader-unit]") ?? [])].map(node => node.outerHTML),
          reading_text: readingText, inside_present: readingText.some(text => text.includes(inside)),
          neighbour_present: readingText.some(text => text.includes(neighbour)),
          source_inspection: ranges("source-inspection"), source_inspection_coarse: ranges("source-inspection-coarse") };
      }, { inside: fixture.inside, neighbour: fixture.neighbour });
      const path = join(context.artifacts_dir, "search-browser-failure-dom.private.json");
      await writeFile(path, JSON.stringify(dom), { mode: 0o600, flag: "wx" });
      facts.browser_failure_dom_file = path;
    } catch (capture) {
      facts.browser_failure_dom_error = capture instanceof Error ? capture.name : "unknown";
    }
    try {
      const path = join(context.artifacts_dir, "search-browser-failure.private.png");
      await writeFile(path, await diagnosticPage.screenshot({ timeout: 5_000 }), { mode: 0o600, flag: "wx" });
      facts.browser_failure_screenshot_file = path;
    } catch (capture) {
      facts.browser_failure_screenshot_error = capture instanceof Error ? capture.name : "unknown";
    }
  }
  await saveFacts();
  throw error;
} finally {
  await browser.close();
}
