from uuid import UUID

import pytest

from nexus.services.artifacts.document_html import (
    DocumentHtmlError,
    accept_model_article,
    compile_learning_document,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot

pytestmark = pytest.mark.unit


def _citation(ordinal: int) -> CitationInput:
    return CitationInput(
        target=ResourceRef(
            scheme="media",
            id=UUID("11111111-1111-4111-8111-111111111111"),
        ),
        ordinal=ordinal,
        kind="supports",
        snapshot=CitationSnapshot(title="Source"),
    )


def test_accepts_and_canonicalizes_one_semantic_article() -> None:
    accepted = accept_model_article(
        """
        <article>
          <section id="mental-model">
            <h2>Mental model</h2>
            <p class="dossier-definition">A clear explanation
              <cite data-nexus-citation="1"></cite>.
            </p>
          </section>
        </article>
        """
    )

    assert accepted.citation_ordinals == (1,)
    assert accepted.content_html.startswith("<article>")
    assert accepted.content_html.endswith("</article>")

    compiled = compile_learning_document(accepted, [_citation(1)])
    assert (
        '<button type="button" class="dossier-citation" '
        'data-nexus-citation="1" aria-label="Open citation 1">'
        "<sup>1</sup></button>"
    ) in compiled.content_html
    assert compiled.content_text == "Mental model A clear explanation ."


@pytest.mark.parametrize(
    "source",
    [
        "<html><article><p>x</p></article></html>",
        "<head><title>x</title></head><article><p>x</p></article>",
        "<article><title>x</title></article>",
        "<article><script>alert(1)</script></article>",
        "<article><style>p{color:red}</style></article>",
        "<article><meta http-equiv='refresh' content='0;url=https://example.com'></article>",
        "<article><link rel='stylesheet' href='https://example.com/x.css'></article>",
        "<article><base href='https://example.com/'></article>",
        "<article><a href='https://example.com'>escape</a></article>",
        "<article><img src='https://example.com/x.png'></article>",
        "<article><iframe src='https://example.com'></iframe></article>",
        "<article><form action='https://example.com'><input></form></article>",
        "<article><input value='x'></article>",
        "<article><button type='button'>x</button></article>",
        "<article><object data='https://example.com'></object></article>",
        "<article><embed src='https://example.com'></article>",
        "<article><svg><title>x</title></svg></article>",
        "<article><math><mi>x</mi></math></article>",
        "<article><template><p>hidden</p></template></article>",
        "<article><p onclick='alert(1)'>x</p></article>",
        "<article><p onmouseover='alert(1)'>x</p></article>",
        "<article><p style='color:red'>x</p></article>",
        "<article><p hidden>x</p></article>",
        "<article><p inert>x</p></article>",
        "<article><p role='button'>x</p></article>",
        "<article><p aria-label='x'>x</p></article>",
        "<article><p data-extra='x'>x</p></article>",
        "<article><p xml:lang='en'>x</p></article>",
        "<article xmlns='http://www.w3.org/2000/svg'><p>x</p></article>",
        "<article><!-- hidden --><p>x</p></article>",
        "<!doctype html><article><p>x</p></article>",
        "<?xml version='1.0'?><article><p>x</p></article>",
        "<article><p x='1' x='2'>x</p></article>",
        "<article><cite>source</cite></article>",
        "<article><cite data-nexus-citation='01'></cite></article>",
        "<article><cite data-nexus-citation='1'>x</cite></article>",
        "<article><section><p>x</p></section></article>",
        "<article><section id='A'><p>x</p></section></article>",
        "<article><section id='x'></section><section id='x'></section></article>",
        "<article><h1>Model title</h1></article>",
        "<article><p></style><meta http-equiv=refresh></p></article>",
        "<article><table><div>fostered</div></table></article>",
        "<article><table><tbody><tr><th scope='all'>h</th></tr></tbody></table></article>",
        "<article><table><tbody><tr><td colspan='0'>x</td></tr></tbody></table></article>",
        "<article><table><tbody><tr><td colspan='17'>x</td></tr></tbody></table></article>",
        "<article><table><tbody><tr><td colspan='01'>x</td></tr></tbody></table></article>",
        "<article><table><tbody><tr><td rowspan='x'>x</td></tr></tbody></table></article>",
        "outside<article><p>x</p></article>",
        "<article><p>x</p></article><article><p>y</p></article>",
    ],
)
def test_rejects_active_ambiguous_or_out_of_grammar_markup(source: str) -> None:
    with pytest.raises(DocumentHtmlError):
        accept_model_article(source)


def test_entity_encoded_markup_remains_text_across_canonical_reparse() -> None:
    accepted = accept_model_article(
        "<article><p>&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
        "&#x3c;img src=x onerror=alert(1)&#x3e;</p></article>"
    )

    assert "<script>" not in accepted.content_html
    assert "<img " not in accepted.content_html
    reparsed = accept_model_article(accepted.content_html)
    assert reparsed == accepted


def test_rejects_quota_violations() -> None:
    with pytest.raises(DocumentHtmlError, match="byte"):
        accept_model_article(f"<article><p>{'x' * 160_001}</p></article>")

    nested = "<article>" + "<div>" * 25 + "x" + "</div>" * 25 + "</article>"
    with pytest.raises(DocumentHtmlError, match="depth"):
        accept_model_article(nested)

    with pytest.raises(DocumentHtmlError, match="4000-node"):
        accept_model_article("<article>" + "<span>x</span>" * 2_000 + "</article>")

    with pytest.raises(DocumentHtmlError, match="attribute limit"):
        accept_model_article(
            "<article><p "
            + " ".join(f"data-{index}='x'" for index in range(9))
            + ">x</p></article>"
        )

    with pytest.raises(DocumentHtmlError, match="citation-token"):
        accept_model_article(
            "<article>"
            + "".join(f'<cite data-nexus-citation="{ordinal}"></cite>' for ordinal in range(1, 258))
            + "</article>"
        )


def test_accepts_well_formed_table_with_scope_and_span() -> None:
    accepted = accept_model_article(
        '<article><section id="data"><h2>Data</h2><table><thead><tr>'
        '<th scope="col">A</th><th scope="col">B</th></tr></thead><tbody>'
        '<tr><td colspan="2" rowspan="1">merged</td></tr></tbody>'
        "</table></section></article>"
    )

    assert 'scope="col"' in accepted.content_html
    assert 'colspan="2"' in accepted.content_html
    assert 'rowspan="1"' in accepted.content_html


def test_rejects_reparse_shape_divergence(monkeypatch: pytest.MonkeyPatch) -> None:
    # The double-parse structural-equivalence guard is the central mXSS defense:
    # a fragment that is grammar-valid on first parse but whose canonical
    # serialization reparses to a different tree must be rejected, never persisted.
    import nexus.services.artifacts.document_html as document_html

    real_serialize = document_html._serialize
    state = {"calls": 0}

    def diverging_serialize(fragment: object) -> str:
        state["calls"] += 1
        canonical = real_serialize(fragment)
        # Corrupt only the accept-path serialization so the canonical string
        # reparses to a structurally different (but still grammar-valid) tree.
        if state["calls"] == 1:
            return canonical.replace("</article>", "<p>injected</p></article>", 1)
        return canonical

    monkeypatch.setattr(document_html, "_serialize", diverging_serialize)
    with pytest.raises(DocumentHtmlError, match="changes shape when reparsed"):
        accept_model_article(
            '<article><section id="s"><h2>H</h2><p>A</p></section></article>'
        )


def test_compile_requires_exact_citation_order() -> None:
    accepted = accept_model_article(
        '<article><p>A<cite data-nexus-citation="1"></cite>'
        ' B<cite data-nexus-citation="2"></cite></p></article>'
    )

    with pytest.raises(AssertionError, match="do not match"):
        compile_learning_document(accepted, [_citation(2), _citation(1)])
