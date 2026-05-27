from nexus.services.web_article_structure import add_heading_anchors, prepare_web_article_fragment


def test_prepare_web_article_fragment_emits_heading_navigation_blocks():
    prepared = prepare_web_article_fragment(
        html="""
            <article>
              <h1>Article Title</h1>
              <p>Intro.</p>
              <h2>First Section</h2>
              <p>Body.</p>
              <h3>Nested Section</h3>
              <p>Nested body.</p>
            </article>
        """,
        base_url="https://example.com/article",
        fragment_idx=0,
        media_title="Article Title",
    )

    assert "nexus-web-heading-0-1-first-section" in prepared.html_sanitized
    assert prepared.canonical_text.startswith("Article Title\n\nIntro.")

    heading_blocks = [block for block in prepared.index_blocks if block.block_kind == "heading"]
    assert [block.section_id for block in heading_blocks] == [
        None,
        "web-heading:0:1:first-section",
        "web-heading:0:2:nested-section",
    ]
    assert [block.depth for block in heading_blocks] == [None, 1, 2]
    assert heading_blocks[1].heading_path == ("First Section",)
    assert heading_blocks[2].heading_path == ("First Section", "Nested Section")

    first = heading_blocks[1]
    assert prepared.canonical_text[first.start_offset : first.end_offset] == ("First Section\n")
    assert (
        next(
            block for block in prepared.fragment_blocks if block.start_offset == first.start_offset
        ).block_type
        == "heading"
    )


def test_add_heading_anchors_is_idempotent_for_generated_ids():
    html = add_heading_anchors("<h2>Section</h2>", fragment_idx=0)

    assert add_heading_anchors(html, fragment_idx=0) == html
