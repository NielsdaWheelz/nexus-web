"""The confined host's resolver admits EDNS without widening DNS authority."""

import ipaddress
import struct

import pytest
from apps.codex_agent.egress_policy import EgressPolicy, PolicyError, dns_response

_POLICY = EgressPolicy(ipaddress.IPv4Address("172.30.0.2"), "api.nexus.example")
_GLIBC_OPT = bytes.fromhex("00 0029 04b0 00000000 0000")
_RESPONSE_OPT = bytes.fromhex("00 0029 1000 00000000 0000")
_A_ANSWER = bytes.fromhex("c00c 0001 0001 0000001e 0004 ac1e0002")


def _question(host: str, query_type: int = 1, query_class: int = 1) -> bytes:
    return (
        b"".join(bytes([len(label)]) + label.encode("ascii") for label in host.split("."))
        + b"\x00"
        + struct.pack("!HH", query_type, query_class)
    )


def _query(question: bytes, additional: bytes = _GLIBC_OPT, count: int = 1) -> bytes:
    # glibc's edns0/trust-ad query requests AD; synthetic answers must not claim it.
    return struct.pack("!6H", 0x1234, 0x0120, 1, 0, 0, count) + question + additional


@pytest.mark.parametrize("host", ["chatgpt.com", "api.nexus.example", "auth.openai.com"])
@pytest.mark.parametrize("query_type", [1, 28])
def test_edns_queries_keep_the_exact_allowed_a_and_empty_aaaa_answers(
    host: str, query_type: int
) -> None:
    question = _question(host, query_type)
    answer = _A_ANSWER if query_type == 1 else b""
    assert dns_response(_query(question), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8180, 1, int(query_type == 1), 0, 1)
        + question
        + answer
        + _RESPONSE_OPT
    )


@pytest.mark.parametrize(("host", "query_class"), [("untrusted.example", 1), ("chatgpt.com", 3)])
def test_edns_does_not_admit_forbidden_names_or_classes(host: str, query_class: int) -> None:
    question = _question(host, query_class=query_class)
    assert dns_response(_query(question), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8185, 1, 0, 0, 1) + question + _RESPONSE_OPT
    )


@pytest.mark.parametrize(
    ("host", "query_type", "rcode", "answer"),
    [
        ("chatgpt.com", 1, 0, _A_ANSWER),
        ("chatgpt.com", 28, 0, b""),
        ("untrusted.example", 1, 5, b""),
    ],
)
def test_queries_without_edns_retain_their_original_wire_answers(
    host: str, query_type: int, rcode: int, answer: bytes
) -> None:
    question = _question(host, query_type)
    assert dns_response(_query(question, b"", 0), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8180 | rcode, 1, int(bool(answer)), 0, 0) + question + answer
    )


def test_unknown_well_formed_options_are_ignored_without_echoing_their_data() -> None:
    question = _question("chatgpt.com")
    # Two unknown options, one containing three arbitrary bytes and one empty.
    opt = bytes.fromhex("00 0029 04b0 00000000 000b ffde 0003 010203 ffdf 0000")
    assert dns_response(_query(question, opt), _POLICY) == dns_response(_query(question), _POLICY)


@pytest.mark.parametrize("flags", [0, 0x7FFF, 0x8000, 0xFFFF])
def test_edns_copies_do_and_clears_unknown_flags(flags: int) -> None:
    question = _question("chatgpt.com")
    opt = struct.pack("!BHHIH", 0, 41, 1200, flags, 0)
    response = dns_response(_query(question, opt), _POLICY)
    assert response == (
        struct.pack("!6H", 0x1234, 0x8180, 1, 1, 0, 1)
        + question
        + _A_ANSWER
        + struct.pack("!BHHIH", 0, 41, 4096, flags & 0x8000, 0)
    )


@pytest.mark.parametrize("payload_size", [0, 511, 512, 65535])
def test_answer_fits_the_dns_minimum_and_advertises_the_responder_receive_bound(
    payload_size: int,
) -> None:
    question = _question("chatgpt.com")
    opt = struct.pack("!BHHIH", 0, 41, payload_size, 0, 0)
    response = dns_response(_query(question, opt), _POLICY)
    assert len(response) < 512
    assert response.endswith(_RESPONSE_OPT)


@pytest.mark.parametrize("version", [1, 255])
def test_unsupported_edns_version_returns_badvers_and_version_zero(version: int) -> None:
    question = _question("chatgpt.com")
    opt = struct.pack("!BHHIH", 0, 41, 1200, (version << 16) | 0x8000, 0)
    assert dns_response(_query(question, opt), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8180, 1, 0, 0, 1)
        + question
        + bytes.fromhex("00 0029 1000 01008000 0000")
    )


@pytest.mark.parametrize(
    ("additional", "count"),
    [
        (_GLIBC_OPT[:-1], 1),
        (bytes.fromhex("00 0029 04b0 00000000 0001"), 1),
        (bytes.fromhex("00 0029 04b0 00000000 0003 ffde00"), 1),
        (bytes.fromhex("00 0029 04b0 00000000 0005 ffde0002 01"), 1),
        (_GLIBC_OPT + b"\x00", 1),
        (_GLIBC_OPT + _GLIBC_OPT, 1),
        (_GLIBC_OPT + _GLIBC_OPT, 2),
    ],
)
def test_malformed_or_duplicate_opt_records_return_formerr_with_edns_support(
    additional: bytes, count: int
) -> None:
    question = _question("chatgpt.com")
    assert dns_response(_query(question, additional, count), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8181, 1, 0, 0, 1) + question + _RESPONSE_OPT
    )


@pytest.mark.parametrize(
    ("additional", "count"),
    [
        (bytes.fromhex("01 0029 04b0 00000000 0000"), 1),
        (bytes.fromhex("00 002a 04b0 00000000 0000"), 1),
        (_GLIBC_OPT, 0),
    ],
)
def test_other_additional_records_and_undeclared_edns_return_formerr(
    additional: bytes, count: int
) -> None:
    assert dns_response(_query(_question("chatgpt.com"), additional, count), _POLICY) == (
        struct.pack("!6H", 0x1234, 0x8181, 0, 0, 0, 0)
    )


@pytest.mark.parametrize("query", [b"\x00" * 11, b"\x00" * 4097])
def test_dns_packet_size_stays_bounded(query: bytes) -> None:
    with pytest.raises(PolicyError, match="query size"):
        dns_response(query, _POLICY)
