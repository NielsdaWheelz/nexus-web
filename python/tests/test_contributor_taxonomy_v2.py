"""Unit coverage for the v2 author-deduplication taxonomy foundations.

Covers the match key, display cleanup, ContributorHandle brand + candidate
ladder, identity-key canonicalization, observation values, and the shared
adapter builder. Pure logic, no DB/network.
"""

import pytest

from nexus.services.contributor_taxonomy import (
    CONTRIBUTOR_KEY_AUTHORITIES,
    CONTRIBUTOR_ROLES_ORDERED,
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    NOT_OBSERVED,
    ContributorIdentityKey,
    ContributorObservation,
    KeyDistinctSeed,
    ManualDistinctSeed,
    NotObserved,
    ObservedRoleSlices,
    RawCreditEntry,
    RawIdentityClaim,
    assume_contributor_handle,
    build_observation,
    canonicalize_identity_key,
    clean_contributor_display,
    contributor_handle_candidates,
    contributor_match_key,
    parse_contributor_handle,
    strip_embedded_email_addresses,
    try_parse_contributor_handle,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Role vocabulary
# ---------------------------------------------------------------------------


def test_roles_ordered_has_author_first_and_twelve_members() -> None:
    assert CONTRIBUTOR_ROLES_ORDERED[0] == "author"
    assert len(CONTRIBUTOR_ROLES_ORDERED) == 12
    assert len(set(CONTRIBUTOR_ROLES_ORDERED)) == 12
    assert CONTRIBUTOR_ROLES_ORDERED[-1] == "unknown"


# ---------------------------------------------------------------------------
# Match key: normalization strips, but punctuation/order/diacritics remain
# ---------------------------------------------------------------------------


def test_match_key_is_case_insensitive() -> None:
    assert contributor_match_key("Jane Doe") == contributor_match_key("JANE DOE")
    assert contributor_match_key("Jane Doe") == "jane doe"


def test_match_key_applies_nfkc_compatibility_folding() -> None:
    assert contributor_match_key("ﬁle") == contributor_match_key("file")  # ﬁ ligature
    assert contributor_match_key("Ａlice") == "alice"  # fullwidth A
    assert contributor_match_key("H²O") == contributor_match_key("H2O")  # superscript 2


def test_match_key_uses_casefold_not_lowercase() -> None:
    # ``str.casefold()`` folds ß -> ss; ``str.lower()`` would leave "straße".
    assert contributor_match_key("Straße") == "strasse"
    assert contributor_match_key("Straße") == contributor_match_key("STRASSE")


def test_match_key_reapplies_nfkc_after_casefold() -> None:
    # U+01F0 (ǰ) casefolds to "j" + combining caron; the second NFKC recomposes
    # it to the single precomposed code point. Dropping that second NFKC would
    # leave the two-code-point form and desync from the display/migration copies.
    assert contributor_match_key("ǰ") == "ǰ"
    assert len(contributor_match_key("ǰ")) == 1


def test_match_key_strips_default_ignorable_characters() -> None:
    assert contributor_match_key("Jo​hn") == "john"  # ZWSP
    assert contributor_match_key("Jo‍hn") == "john"  # ZWJ
    assert contributor_match_key("Jane­Doe") == "janedoe"  # soft hyphen
    assert contributor_match_key("﻿Jane") == "jane"  # BOM
    assert contributor_match_key("A\U000e0101B") == "ab"  # variation selector supplement


def test_match_key_collapses_unicode_whitespace() -> None:
    assert contributor_match_key("  Jane   Doe  ") == "jane doe"
    assert contributor_match_key("a b") == "a b"  # NBSP
    assert contributor_match_key("a　b") == "a b"  # ideographic space


def test_match_key_keeps_punctuation_order_and_diacritics_distinct() -> None:
    assert contributor_match_key("O'Brien") != contributor_match_key("OBrien")
    assert contributor_match_key("Jane Doe") != contributor_match_key("Doe Jane")
    assert contributor_match_key("José") != contributor_match_key("Jose")


# ---------------------------------------------------------------------------
# Display cleanup: NFC + trim + collapse, everything else preserved
# ---------------------------------------------------------------------------


def test_clean_display_normalizes_to_nfc_without_losing_content() -> None:
    assert clean_contributor_display("é") == "é"  # combining -> composed é
    assert len(clean_contributor_display("é")) == 1
    assert clean_contributor_display("  Jane   Q.  Doe ") == "Jane Q. Doe"


def test_clean_display_preserves_default_ignorable_that_match_key_strips() -> None:
    # Soft hyphen survives display cleanup but is removed from the match key.
    assert clean_contributor_display("Jane­Doe") == "Jane­Doe"
    assert contributor_match_key("Jane­Doe") == "janedoe"


def test_clean_display_preserves_case_punctuation_and_diacritics() -> None:
    assert clean_contributor_display("José O'Brien") == "José O'Brien"


# ---------------------------------------------------------------------------
# strip_embedded_email_addresses: §5 privacy — no address survives as a name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        # embedded address with a human remainder -> remainder kept, wrappers gone
        ("Jane Doe <jane@x.com>", "Jane Doe"),
        ("Jane (jane@x.com) Doe", "Jane Doe"),
        ("Jane [jane@x.com] Doe", "Jane Doe"),
        # the prod-blocking shape: name phrase + trailing separator + <address>
        ("Dr. Jane Doe. <j@x.co>", "Dr. Jane Doe"),
        ("Word Word of Word. <someone@domain.tld>", "Word Word of Word"),
        # address-only values (any wrapper) -> empty; caller drops / falls back
        ("jane@x.com", ""),
        ("mailto:jane@x.com", ""),
        (" <a@b.c> ", ""),
        ("(jane@x.com)", ""),
        # internal name punctuation is preserved when an address is removed
        ("Jean-Paul Q. <jp@x.io>", "Jean-Paul Q"),
        ("O'Brien <ob@x.io>", "O'Brien"),
    ],
)
def test_strip_embedded_email_addresses_vectors(value: str, expected: str) -> None:
    result = strip_embedded_email_addresses(value)
    assert result == expected
    # The result never carries an embedded (dotted) address.
    assert "@" not in result or "." not in result.split("@", 1)[1]


@pytest.mark.parametrize(
    "value",
    [
        "user@ handle-like non-domain",  # space after @ -> not a domain
        "name @ home",  # spaces around @ -> not an address
        "Jane Doe",  # ordinary name, no @ at all
        "R&B @ Night",  # @ with no dotted domain
        "Jane Q. Doe",  # trailing "." must survive when NO address is present
    ],
)
def test_strip_embedded_email_addresses_leaves_non_addresses_untouched(value: str) -> None:
    assert strip_embedded_email_addresses(value) == value


# ---------------------------------------------------------------------------
# ContributorHandle brand
# ---------------------------------------------------------------------------


def test_parse_contributor_handle_accepts_canonical_handles() -> None:
    assert parse_contributor_handle("jane-doe-abc123") == "jane-doe-abc123"
    assert parse_contributor_handle("abc") == "abc"


@pytest.mark.parametrize(
    "value",
    [
        "Jane",  # uppercase
        "-jane",  # leading hyphen
        "jane-",  # trailing hyphen
        "a--b",  # double hyphen
        "ab",  # too short
        "a" * 81,  # too long
        "jane doe",  # space
        "directory",  # reserved
        "reconciliation-candidates",  # reserved
        "",
    ],
)
def test_parse_contributor_handle_rejects_invalid(value: str) -> None:
    with pytest.raises(ValueError):
        parse_contributor_handle(value)
    assert try_parse_contributor_handle(value) is None


def test_try_parse_returns_value_for_valid_handle() -> None:
    assert try_parse_contributor_handle("jane-doe-abc123") == "jane-doe-abc123"


def test_assume_contributor_handle_defects_on_non_canonical() -> None:
    with pytest.raises(RuntimeError):
        assume_contributor_handle("Not A Handle")
    assert assume_contributor_handle("jane-doe-abc123") == "jane-doe-abc123"


# ---------------------------------------------------------------------------
# Handle candidate ladder: deterministic, stable, valid, never bare base for seeds
# ---------------------------------------------------------------------------


def test_base_handle_is_single_deterministic_valid_candidate() -> None:
    first = list(contributor_handle_candidates("Jane Doe"))
    second = list(contributor_handle_candidates("Jane Doe"))
    assert first == second
    assert len(first) == 1
    assert try_parse_contributor_handle(first[0]) is not None
    assert first[0].startswith("jane-doe-")


def test_base_handle_pins_exact_bytes_for_s2_frozen_copy() -> None:
    # Byte-identity anchor: S2's migration 0179 embeds a frozen copy of this
    # handle logic (D-7/D-12/§8) and must produce the identical handle. These
    # literals encode the D-7 preimage (version-tagged prefix + NUL + fields).
    assert list(contributor_handle_candidates("Jane Doe")) == ["jane-doe-a2d827ab5c23"]
    assert (
        list(
            contributor_handle_candidates(
                "Jane Doe", distinct_seed=KeyDistinctSeed("orcid", "0000-0002-1825-0097")
            )
        )[0]
        == "jane-doe-a2d827ab5c23-9c5401e2ffbf"
    )
    assert list(contributor_handle_candidates("李明")) == ["676ef87a0313"]


def test_base_handle_collapses_hyphens_and_strips_slug_edges() -> None:
    # Consecutive non-alphanumerics collapse to one hyphen; leading/trailing
    # hyphens are stripped from the slug before the digest suffix is appended.
    assert list(contributor_handle_candidates("A  &  B"))[0].startswith("a-b-")
    assert list(contributor_handle_candidates("!!!Jane!!!"))[0].startswith("jane-")


def test_base_handle_truncates_slug_to_thirty_two_characters() -> None:
    handle = list(contributor_handle_candidates("x" * 60))[0]
    slug = handle.rsplit("-", 1)[0]
    assert slug == "x" * 32


def test_base_handle_for_non_latin_name_is_digest_only() -> None:
    candidates = list(contributor_handle_candidates("李明"))  # 李明
    assert len(candidates) == 1
    handle = candidates[0]
    assert "-" not in handle  # digest-only, no slug prefix
    assert try_parse_contributor_handle(handle) is not None


def test_key_distinct_ladder_is_deterministic_and_never_bare_base() -> None:
    seed = KeyDistinctSeed("orcid", "0000-0002-1825-0097")
    base = list(contributor_handle_candidates("Jane Doe"))[0]
    ladder = list(contributor_handle_candidates("Jane Doe", distinct_seed=seed))
    assert ladder == list(contributor_handle_candidates("Jane Doe", distinct_seed=seed))
    assert len(ladder) == 4
    assert base not in ladder
    assert all(handle.startswith(base + "-") for handle in ladder)
    assert all(try_parse_contributor_handle(handle) is not None for handle in ladder)
    # Successively longer digest prefixes.
    assert [len(h) for h in ladder] == sorted(len(h) for h in ladder)
    assert len(set(ladder)) == 4


def test_manual_distinct_ladder_differs_by_seed() -> None:
    seed_a = ManualDistinctSeed("user-1", "media-1", "cm-1", 0)
    seed_b = ManualDistinctSeed("user-1", "media-1", "cm-1", 1)
    ladder_a = list(contributor_handle_candidates("Jane Doe", distinct_seed=seed_a))
    ladder_b = list(contributor_handle_candidates("Jane Doe", distinct_seed=seed_b))
    assert ladder_a != ladder_b
    assert set(ladder_a).isdisjoint(ladder_b)


def test_key_and_manual_seeds_are_domain_separated() -> None:
    key_seed = KeyDistinctSeed("orcid", "shared")
    manual_seed = ManualDistinctSeed("shared", "", "", 0)
    key_ladder = list(contributor_handle_candidates("Jane Doe", distinct_seed=key_seed))
    manual_ladder = list(contributor_handle_candidates("Jane Doe", distinct_seed=manual_seed))
    assert set(key_ladder).isdisjoint(manual_ladder)


# ---------------------------------------------------------------------------
# Identity-key canonicalization matrix
# ---------------------------------------------------------------------------


def test_canonicalize_orcid_forms_and_checksum() -> None:
    assert canonicalize_identity_key("orcid", "0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert canonicalize_identity_key("orcid", "0000000218250097") == "0000-0002-1825-0097"
    assert (
        canonicalize_identity_key("orcid", "https://orcid.org/0000-0002-1825-0097")
        == "0000-0002-1825-0097"
    )
    # X checksum character is preserved.
    assert canonicalize_identity_key("orcid", "0000-0002-1694-233X") == "0000-0002-1694-233X"
    # Wrong check digit is invalid.
    assert canonicalize_identity_key("orcid", "0000-0002-1825-0098") is None
    assert canonicalize_identity_key("orcid", "not-an-orcid") is None


def test_canonicalize_email_address() -> None:
    assert canonicalize_identity_key("email_address", "  Foo@Example.COM ") == "foo@example.com"
    assert canonicalize_identity_key("email_address", "no-at-sign") is None
    assert canonicalize_identity_key("email_address", "a@b@c") is None
    assert canonicalize_identity_key("email_address", "a b@c.com") is None
    assert canonicalize_identity_key("email_address", "@example.com") is None
    assert canonicalize_identity_key("email_address", "user@") is None


def test_canonicalize_x_user_requires_decimal_digits() -> None:
    assert canonicalize_identity_key("x_user", " 12345 ") == "12345"
    assert canonicalize_identity_key("x_user", "not-digits") is None
    assert canonicalize_identity_key("x_user", "") is None


def test_canonicalize_youtube_channel_requires_uc_grammar() -> None:
    valid = "UC" + "a" * 22
    assert canonicalize_identity_key("youtube_channel", valid) == valid
    assert canonicalize_identity_key("youtube_channel", "XX" + "a" * 22) is None
    assert canonicalize_identity_key("youtube_channel", "UCshort") is None


def test_canonicalize_bibliographic_authorities_are_trimmed_exact() -> None:
    assert canonicalize_identity_key("isni", " 0000 0001 2103 2683 ") == "0000 0001 2103 2683"
    assert canonicalize_identity_key("wikidata", " Q42 ") == "Q42"
    assert canonicalize_identity_key("viaf", "  ") is None


def test_canonicalize_unknown_authority_is_none() -> None:
    assert canonicalize_identity_key("podcast_index", "anything") is None


# ---------------------------------------------------------------------------
# Observation value validation
# ---------------------------------------------------------------------------


def test_contributor_observation_rejects_empty_name_and_unknown_role() -> None:
    with pytest.raises(ValueError):
        ContributorObservation(credited_name="  ", role="author", raw_role=None, identity_key=None)
    with pytest.raises(ValueError):
        ContributorObservation(
            credited_name="Jane", role="co-author", raw_role=None, identity_key=None
        )
    with pytest.raises(ValueError):
        ContributorObservation(
            credited_name="Jane", role="author", raw_role="x" * 81, identity_key=None
        )


def test_contributor_observation_rejects_over_length_name() -> None:
    ContributorObservation("x" * 200, "author", None, None)  # exactly at the cap is fine
    with pytest.raises(ValueError):
        ContributorObservation("x" * 201, "author", None, None)


def test_observed_role_slices_rejects_empty_managed_set() -> None:
    with pytest.raises(ValueError):
        ObservedRoleSlices(frozenset(), ())


def test_observed_role_slices_rejects_unknown_managed_role() -> None:
    with pytest.raises(ValueError):
        ObservedRoleSlices(frozenset({"villain"}), ())


def test_observed_role_slices_rejects_credit_role_outside_managed_set() -> None:
    author = ContributorObservation("Jane", "author", None, None)
    editor = ContributorObservation("Ed", "editor", None, None)
    with pytest.raises(ValueError):
        ObservedRoleSlices(frozenset({"author"}), (author, editor))


def test_observed_role_slices_requires_one_to_twenty_per_declared_role() -> None:
    with pytest.raises(ValueError):  # declared but zero credits
        ObservedRoleSlices(frozenset({"author"}), ())
    twenty_one = tuple(
        ContributorObservation(f"Author {i}", "author", None, None) for i in range(21)
    )
    with pytest.raises(ValueError):
        ObservedRoleSlices(frozenset({"author"}), twenty_one)


def test_observed_role_slices_accepts_valid_multi_role_batch() -> None:
    batch = ObservedRoleSlices(
        frozenset({"author", "editor"}),
        (
            ContributorObservation("Jane", "author", None, None),
            ContributorObservation("Ed", "editor", "Series Editor", None),
        ),
    )
    assert batch.managed_roles == frozenset({"author", "editor"})


# ---------------------------------------------------------------------------
# build_observation
# ---------------------------------------------------------------------------


def test_build_observation_empty_input_is_not_observed() -> None:
    batch, truncated = build_observation({})
    assert batch is NOT_OBSERVED
    assert isinstance(batch, NotObserved)
    assert truncated == {}


def test_build_observation_all_blank_names_is_not_observed() -> None:
    batch, truncated = build_observation({"author": [RawCreditEntry("  "), RawCreditEntry("")]})
    assert batch is NOT_OBSERVED
    assert truncated == {}


def test_build_observation_dedupes_by_match_key_first_wins() -> None:
    batch, truncated = build_observation(
        {"author": [RawCreditEntry("Jane Doe"), RawCreditEntry("jane   doe")]}
    )
    assert isinstance(batch, ObservedRoleSlices)
    assert len(batch.credits) == 1
    assert batch.credits[0].credited_name == "Jane Doe"  # first spelling wins
    assert truncated == {}


def test_build_observation_truncates_to_twenty_with_counts() -> None:
    entries = [RawCreditEntry(f"Author {i}") for i in range(25)]
    batch, truncated = build_observation({"author": entries})
    assert isinstance(batch, ObservedRoleSlices)
    assert sum(1 for c in batch.credits if c.role == "author") == MAX_CREDITS_PER_MANAGED_ROLE
    assert truncated == {"author": 5}


def test_build_observation_truncates_name_to_two_hundred_code_points() -> None:
    batch, _ = build_observation({"author": [RawCreditEntry("x" * 260)]})
    assert isinstance(batch, ObservedRoleSlices)
    assert len(batch.credits[0].credited_name) == MAX_CONTRIBUTOR_NAME_CODE_POINTS


def test_build_observation_selects_highest_precedence_valid_key() -> None:
    entry = RawCreditEntry(
        "Jane Doe",
        identity_claims=(
            RawIdentityClaim("isni", "0000 0001 2103 2683"),
            RawIdentityClaim("orcid", "0000-0002-1825-0097"),
        ),
    )
    batch, _ = build_observation({"author": [entry]})
    assert isinstance(batch, ObservedRoleSlices)
    key = batch.credits[0].identity_key
    assert key == ContributorIdentityKey("orcid", "0000-0002-1825-0097")


def test_build_observation_skips_invalid_key_and_falls_to_next_authority() -> None:
    entry = RawCreditEntry(
        "Jane Doe",
        identity_claims=(
            RawIdentityClaim("orcid", "not-valid"),
            RawIdentityClaim("email_address", "jane@example.com"),
        ),
    )
    batch, _ = build_observation({"author": [entry]})
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.credits[0].identity_key == ContributorIdentityKey(
        "email_address", "jane@example.com"
    )


def test_build_observation_email_beats_x_user_by_precedence() -> None:
    entry = RawCreditEntry(
        "Jane Doe",
        identity_claims=(
            RawIdentityClaim("x_user", "12345"),
            RawIdentityClaim("email_address", "jane@example.com"),
        ),
    )
    batch, _ = build_observation({"author": [entry]})
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.credits[0].identity_key is not None
    assert batch.credits[0].identity_key.authority == "email_address"
    # Precedence is defined by CONTRIBUTOR_KEY_AUTHORITIES ordering.
    assert CONTRIBUTOR_KEY_AUTHORITIES.index("email_address") < CONTRIBUTOR_KEY_AUTHORITIES.index(
        "x_user"
    )


def test_build_observation_no_valid_key_leaves_identity_absent() -> None:
    entry = RawCreditEntry("Jane Doe", identity_claims=(RawIdentityClaim("orcid", "bad"),))
    batch, _ = build_observation({"author": [entry]})
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.credits[0].identity_key is None


def test_build_observation_cleans_raw_role_and_reports_managed_roles() -> None:
    batch, _ = build_observation(
        {
            "author": [RawCreditEntry("Jane Doe", raw_role="  Lead  Author ")],
            "editor": [RawCreditEntry("Ed")],
        }
    )
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.managed_roles == frozenset({"author", "editor"})
    author_credit = next(c for c in batch.credits if c.role == "author")
    assert author_credit.raw_role == "Lead Author"


def test_build_observation_dedup_is_per_role_not_global() -> None:
    # Same person credited as both author and editor keeps both.
    batch, _ = build_observation(
        {"author": [RawCreditEntry("Jane Doe")], "editor": [RawCreditEntry("Jane Doe")]}
    )
    assert isinstance(batch, ObservedRoleSlices)
    assert len(batch.credits) == 2


def test_build_observation_strips_embedded_address_from_credited_name() -> None:
    # §5 privacy: an embedded address is stripped; the human remainder is kept.
    batch, _ = build_observation({"author": [RawCreditEntry("Jane Doe <jane@x.com>")]})
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.credits[0].credited_name == "Jane Doe"
    assert "@" not in batch.credits[0].credited_name


def test_build_observation_drops_address_only_credited_name() -> None:
    # A credited name that is only an address yields nothing and is omitted.
    batch, _ = build_observation({"author": [RawCreditEntry("jane@x.com")]})
    assert batch is NOT_OBSERVED
    batch2, _ = build_observation({"author": [RawCreditEntry("mailto:jane@x.com")]})
    assert batch2 is NOT_OBSERVED


def test_build_observation_keeps_email_lane_local_part_untouched() -> None:
    # The email adapter's sanitized local-part fallback carries no "@" and must
    # pass through unchanged (the strip never touches a non-address name).
    batch, _ = build_observation({"author": [RawCreditEntry("jane.doe")]})
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.credits[0].credited_name == "jane.doe"
