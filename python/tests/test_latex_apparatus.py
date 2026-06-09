import io
import tarfile
from collections import Counter

import pytest

from nexus.services.latex_apparatus import (
    LatexSourceArchiveSafetyConfig,
    LatexSourceArchiveUnsafe,
    extract_latex_biblatex_apparatus,
    extract_latex_biblatex_apparatus_from_archive,
)
from tests.reader_apparatus_latex_verifiers import latex_source_graph_from_archive

pytestmark = pytest.mark.unit


def _tar_bytes(entries: list[tuple[str, bytes]], *, gzip: bool = False) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz" if gzip else "w") as archive:
        for name, content in entries:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return data.getvalue()


def _tar_symlink_bytes(name: str, linkname: str) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.type = tarfile.SYMTYPE
        info.linkname = linkname
        archive.addfile(info)
    return data.getvalue()


def test_latex_biblatex_apparatus_extracts_multikey_citations_and_footnotes():
    result = extract_latex_biblatex_apparatus(
        r"""
        \section{Intro}
        Claim~\parencite[see][p.~4]{alpha,beta}.
        Another claim \textcite{alpha}.
        \footnotetext[1]{These authors contributed equally.}
        """,
        r"""
        @article{alpha,
          title = {Alpha Reference},
          author = {Ada Lovelace},
          year = {1843}
        }
        @book{beta,
          title = {Beta Reference},
          author = {Grace Hopper},
          date = {1952}
        }
        @misc{uncited,
          title = {Uncited Reference}
        }
        """,
        source_kind="latex:test",
        source_ref={"format": "latex"},
    )

    assert result.status == "ready"
    assert Counter(item["kind"] for item in result.items) == {
        "bibliography_entry": 2,
        "bibliography_ref": 2,
        "footnote": 1,
    }
    assert Counter(edge["relation"] for edge in result.edges) == {"cites_bibliography_entry": 3}
    assert Counter(edge["extraction_method"] for edge in result.edges) == {
        "latex_biblatex_citation": 3
    }
    assert result.diagnostics["latex_biblatex"] == {
        "status": "ready",
        "citation_marker_count": 2,
        "citation_edge_count": 3,
        "cited_bibliography_entry_count": 2,
        "bib_entry_count": 3,
        "uncited_bib_entry_count": 1,
        "footnote_count": 1,
        "missing_citation_keys": [],
    }
    body_text = "\n".join(str(item.get("body_text") or "") for item in result.items)
    assert "Alpha Reference" in body_text
    assert "Beta Reference" in body_text
    assert "These authors contributed equally." in body_text


def test_latex_biblatex_apparatus_reports_missing_citation_keys_as_partial():
    result = extract_latex_biblatex_apparatus(
        r"Claim \parencite{missing}.",
        "",
        source_kind="latex:test",
        source_ref={"format": "latex"},
    )

    assert result.status == "partial"
    assert Counter(item["kind"] for item in result.items) == {"bibliography_ref": 1}
    assert result.edges == []
    assert result.diagnostics["latex_biblatex"]["missing_citation_keys"] == ["missing"]


def test_latex_independent_verifier_recognizes_supported_citation_commands():
    source_bytes = _tar_bytes(
        [
            (
                "main.tex",
                br"""
                \begin{document}
                One \cite{alpha}.
                Two \parencite[see][p.~4]{beta,gamma}.
                Three \textcite{alpha}.
                Four \autocite{delta}.
                Escaped percent \% keeps \cite{epsilon}.
                Commented citation % \cite{ignored}
                \footnote{A source note.}
                \end{document}
                """,
            ),
            (
                "refs.bib",
                br"""
                @article{alpha, title = {Alpha}}
                @article{beta, title = {Beta}}
                @article{gamma, title = {Gamma}}
                @article{delta, title = {Delta}}
                @article{epsilon, title = {Epsilon}}
                """,
            ),
        ]
    )

    graph = latex_source_graph_from_archive(source_bytes)

    assert graph.marker_keys == (
        ("alpha",),
        ("beta", "gamma"),
        ("alpha",),
        ("delta",),
        ("epsilon",),
    )
    assert graph.cited_keys == ("alpha", "beta", "gamma", "alpha", "delta", "epsilon")
    assert graph.footnote_count == 1


@pytest.mark.parametrize(
    ("source_bytes", "safety_cfg", "reason"),
    [
        (
            _tar_bytes([("../main.tex", b"\\begin{document}\\cite{a}\\end{document}")]),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10_000,
                max_compression_ratio=100,
            ),
            "path_traversal",
        ),
        (
            _tar_bytes([("/main.tex", b"\\begin{document}\\cite{a}\\end{document}")]),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10_000,
                max_compression_ratio=100,
            ),
            "absolute_path",
        ),
        (
            _tar_bytes([("main.tex", b"a"), ("./main.tex", b"b")]),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10_000,
                max_compression_ratio=100,
            ),
            "duplicate_path",
        ),
        (
            _tar_bytes([("main.tex", b"a"), ("refs.bib", b"b")]),
            LatexSourceArchiveSafetyConfig(
                max_entries=1,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10_000,
                max_compression_ratio=100,
            ),
            "too_many_entries",
        ),
        (
            _tar_bytes([("main.tex", b"a" * 20)]),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10,
                max_compression_ratio=100,
            ),
            "single_entry_too_large",
        ),
        (
            _tar_bytes([("main.tex", b"a" * 20)]),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10,
                max_single_entry_uncompressed_bytes=100,
                max_compression_ratio=100,
            ),
            "total_uncompressed_too_large",
        ),
        (
            _tar_bytes([("main.tex", b"a" * 20_000)], gzip=True),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=100_000,
                max_single_entry_uncompressed_bytes=100_000,
                max_compression_ratio=1,
            ),
            "compression_ratio_too_high",
        ),
        (
            _tar_symlink_bytes("main.tex", "other.tex"),
            LatexSourceArchiveSafetyConfig(
                max_entries=10,
                max_total_uncompressed_bytes=10_000,
                max_single_entry_uncompressed_bytes=10_000,
                max_compression_ratio=100,
            ),
            "unsupported_member_type",
        ),
    ],
)
def test_latex_source_archive_safety_rejects_unsafe_archives(
    source_bytes,
    safety_cfg,
    reason,
):
    with pytest.raises(LatexSourceArchiveUnsafe) as exc:
        extract_latex_biblatex_apparatus_from_archive(
            source_bytes,
            source_kind="latex:test",
            source_ref={"format": "arxiv_source"},
            safety_cfg=safety_cfg,
        )

    assert exc.value.reason == reason
