"""temporary: assert the containerized background lane extracted the last captured article faithfully."""

import time

import db

deadline = time.monotonic() + 90
while True:
    media = [m for m in db.media_for_user() if m["kind"] == "web_article"]
    assert media, "no article media"
    m = media[-1]
    if m["processing_status"] == "ready_for_reading":
        break
    assert time.monotonic() < deadline, f"extraction did not finish: {m['processing_status']}"
    time.sleep(2)
fragments = db.fragments_for_media(m["id"])
assert len(fragments) == 1, fragments
text, html = fragments[0]["canonical_text"], fragments[0]["html_sanitized"]
assert "BEGIN-SENTINEL-8a1f" in text and "END-SENTINEL-c2d9" in text, text[:200]
leaked = [s for s in ("SCRIPT-SECRET", "ACCOUNT-SECRET", "DATA-SECRET", "FORM-SECRET", "HIDDEN-SECRET") if s in html or s in text]
assert not leaked, leaked
assert "notes/green.html" in html, "article link lost"
apparatus = db.rows("select kind, confidence from reader_apparatus_items where media_id = %s", m["id"])
edges = db.rows("select relation from reader_apparatus_edges where media_id = %s", m["id"])
embeds = db.rows("select provider, resolution_status, source_shape from document_embeds where media_id = %s", m["id"])
print("extraction ok:", m["title"], "| chars", len(text), "| apparatus", [(a["kind"], a["confidence"]) for a in apparatus], "| edges", [e["relation"] for e in edges], "| embeds", [(e["provider"], e["source_shape"], e["resolution_status"]) for e in embeds])
assert any(a["kind"] == "footnote" for a in apparatus), "footnote apparatus missing"
assert any(e["provider"] == "youtube" for e in embeds) and any(e["provider"] == "x" for e in embeds), "embed evidence missing"
