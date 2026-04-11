#!/usr/bin/env python
"""Seed development database with comprehensive fixture data.

Creates a realistic dev workspace: articles, PDFs, EPUBs, videos, podcasts,
highlights, annotations, conversations, and messages. All media is seeded as
ready_for_reading with synthetic content (no network calls, no real ingestion).

Also creates a Supabase auth user (dev@nexus.local / devdevdev) so a dev can
log in immediately and see the seeded data.

Constraints:
- Refuses to run in staging or prod (NEXUS_ENV check)
- Idempotent via SELECT-then-INSERT (re-runnable, no duplicates)
- Never runs automatically (manual `make seed` invocation only)

Usage:
    make seed
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    Annotation,
    Conversation,
    ConversationMedia,
    DefaultLibraryIntrinsic,
    EpubTocNode,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Library,
    LibraryMedia,
    Media,
    MediaKind,
    Membership,
    Message,
    Model,
    PdfPageTextSpan,
    Podcast,
    PodcastEpisode,
    PodcastSubscription,
    PodcastSubscriptionCategory,
    ProcessingStatus,
)
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library

DEV_EMAIL = "dev@nexus.local"
DEV_PASSWORD = "devdevdev"


def _sid(name: str) -> UUID:
    """Deterministic seed UUID from a human-readable name."""
    return uuid5(NAMESPACE_URL, f"seed:dev:{name}")


def _exists(db: Session, model: type, id_val: UUID) -> bool:
    return db.get(model, id_val) is not None


def _ensure_supabase_auth_user(supabase_url: str, service_key: str) -> UUID:
    """Create or find the dev auth user in Supabase. Returns user ID."""
    headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
    # Search existing users
    with httpx.Client() as client:
        resp = client.get(
            f"{supabase_url.rstrip('/')}/auth/v1/admin/users",
            headers=headers,
            timeout=30.0,
        )
    if resp.status_code != 200:
        print(f"ERROR: Failed to list Supabase auth users: {resp.status_code}")
        sys.exit(1)
    for user in resp.json().get("users", []):
        if user.get("email") == DEV_EMAIL:
            return UUID(user["id"])

    # Create new user
    with httpx.Client() as client:
        resp = client.post(
            f"{supabase_url.rstrip('/')}/auth/v1/admin/users",
            headers={**headers, "Content-Type": "application/json"},
            json={"email": DEV_EMAIL, "password": DEV_PASSWORD, "email_confirm": True},
            timeout=30.0,
        )
    if resp.status_code in (200, 201):
        return UUID(resp.json()["id"])
    # Race: another process created it
    if resp.status_code in (409, 422):
        with httpx.Client() as client:
            resp2 = client.get(
                f"{supabase_url.rstrip('/')}/auth/v1/admin/users",
                headers=headers,
                timeout=30.0,
            )
        for user in resp2.json().get("users", []):
            if user.get("email") == DEV_EMAIL:
                return UUID(user["id"])
    print(f"ERROR: Failed to create Supabase auth user: {resp.status_code} {resp.text}")
    sys.exit(1)


def main() -> None:
    # ── Guards ────────────────────────────────────────────────────────
    nexus_env = os.getenv("NEXUS_ENV", "local")
    if nexus_env not in ("local", "test"):
        print(f"ERROR: seed_dev.py refuses to run in NEXUS_ENV={nexus_env}")
        sys.exit(1)
    if not os.getenv("DATABASE_URL"):
        print("ERROR: DATABASE_URL must be set. Run: make seed")
        sys.exit(1)

    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    created: list[str] = []
    skipped: list[str] = []

    def track(label: str, was_created: bool) -> None:
        (created if was_created else skipped).append(label)

    # ── Auth user ─────────────────────────────────────────────────────
    print("Setting up dev auth user...")
    user_id = _ensure_supabase_auth_user(settings.supabase_url, settings.supabase_service_key)
    print(f"  Auth user: {DEV_EMAIL} (id: {user_id})")

    # ── Session ───────────────────────────────────────────────────────
    session_factory = create_session_factory()

    with session_factory() as db:
        # ── Nexus user + default library ──────────────────────────────
        default_library_id = ensure_user_and_default_library(db, user_id, email=DEV_EMAIL)

        # ── Research library ──────────────────────────────────────────
        research_lib_id = _sid("library:research")
        if not _exists(db, Library, research_lib_id):
            db.add(
                Library(
                    id=research_lib_id,
                    owner_user_id=user_id,
                    name="Research",
                    is_default=False,
                )
            )
            db.flush()
            db.add(
                Membership(
                    library_id=research_lib_id,
                    user_id=user_id,
                    role="admin",
                )
            )
            db.flush()
            track("library: Research", True)
        else:
            track("library: Research", False)

        # ── LLM models ───────────────────────────────────────────────
        model_count = db.execute(select(Model)).scalars().first()
        if model_count is None:
            for provider, model_name, max_tokens in [
                ("openai", "gpt-4o-mini", 128000),
                ("openai", "gpt-4o", 128000),
                ("anthropic", "claude-sonnet-4-20250514", 200000),
                ("anthropic", "claude-haiku-4-20250514", 200000),
                ("gemini", "gemini-2.0-flash", 1000000),
            ]:
                db.add(
                    Model(
                        provider=provider,
                        model_name=model_name,
                        max_context_tokens=max_tokens,
                        is_available=True,
                    )
                )
            db.flush()
            track("LLM models (5)", True)
        else:
            track("LLM models", False)

        # ── Web articles ──────────────────────────────────────────────
        # Article 1: Paul Graham — Beating the Averages
        pg_media_id = _sid("media:paul-graham")
        pg_frag0_id = _sid("frag:paul-graham:0")
        pg_frag1_id = _sid("frag:paul-graham:1")
        pg_frag2_id = _sid("frag:paul-graham:2")
        pg_frag0_text = (
            "In 1995, Robert Morris and I started a startup called Viaweb. Our plan was to "
            "write software that would let end users build online stores. What was novel about "
            "this software, at the time, was that it ran on our server, using ordinary Web pages "
            "as the interface."
        )
        if not _exists(db, Media, pg_media_id):
            db.add(
                Media(
                    id=pg_media_id,
                    kind=MediaKind.web_article.value,
                    title="Beating the Averages",
                    canonical_source_url="https://www.paulgraham.com/avg.html",
                    requested_url="https://www.paulgraham.com/avg.html",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    publisher="Paul Graham",
                    published_date="2003-04",
                    language="en",
                )
            )
            db.flush()
            db.add(
                Fragment(
                    id=pg_frag0_id,
                    media_id=pg_media_id,
                    idx=0,
                    canonical_text=pg_frag0_text,
                    html_sanitized=f"<p>{pg_frag0_text}</p>",
                )
            )
            db.add(
                Fragment(
                    id=pg_frag1_id,
                    media_id=pg_media_id,
                    idx=1,
                    canonical_text=(
                        "Our secret weapon was similar. We wrote our software in Lisp. It was a bold "
                        "choice—hardly anyone else was using Lisp for web applications in the late 1990s. "
                        "But Lisp gave us a genuine technical advantage over competitors. We could develop "
                        "and deploy features faster than anyone else."
                    ),
                    html_sanitized=(
                        "<p>Our secret weapon was similar. We wrote our software in Lisp. It was a bold "
                        "choice—hardly anyone else was using Lisp for web applications in the late 1990s. "
                        "But Lisp gave us a genuine technical advantage over competitors. We could develop "
                        "and deploy features faster than anyone else.</p>"
                    ),
                )
            )
            db.add(
                Fragment(
                    id=pg_frag2_id,
                    media_id=pg_media_id,
                    idx=2,
                    canonical_text=(
                        "If you ever do find yourself working on a startup, here's a handy tip for "
                        "evaluating competitors. Read their job listings. Everything else on their site "
                        "may be stock photos or the prose equivalent, but the job listings have to be "
                        "specific about what they want, or they'll get the wrong candidates."
                    ),
                    html_sanitized=(
                        "<p>If you ever do find yourself working on a startup, here's a handy tip for "
                        "evaluating competitors. Read their job listings. Everything else on their site "
                        "may be stock photos or the prose equivalent, but the job listings have to be "
                        "specific about what they want, or they'll get the wrong candidates.</p>"
                    ),
                )
            )
            db.flush()
            track("media: Beating the Averages (3 fragments)", True)
        else:
            track("media: Beating the Averages", False)

        # Article 2: Tennyson — In Memoriam A.H.H.
        tennyson_media_id = _sid("media:tennyson")
        tennyson_frag0_id = _sid("frag:tennyson:0")
        if not _exists(db, Media, tennyson_media_id):
            db.add(
                Media(
                    id=tennyson_media_id,
                    kind=MediaKind.web_article.value,
                    title="In Memoriam A.H.H.",
                    canonical_source_url="https://poets.org/poem/memoriam-h-h",
                    requested_url="https://poets.org/poem/memoriam-h-h",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    publisher="Poetry Foundation",
                    published_date="1850",
                    language="en",
                )
            )
            db.flush()
            db.add(
                Fragment(
                    id=tennyson_frag0_id,
                    media_id=tennyson_media_id,
                    idx=0,
                    canonical_text=(
                        "Strong Son of God, immortal Love, Whom we, that have not seen thy face, "
                        "By faith, and faith alone, embrace, Believing where we cannot prove; "
                        "Thine are these orbs of light and shade; Thou madest Life in man and brute; "
                        "Thou madest Death; and lo, thy foot Is on the skull which thou hast made."
                    ),
                    html_sanitized=(
                        "<p>Strong Son of God, immortal Love,<br/>Whom we, that have not seen thy face,"
                        "<br/>By faith, and faith alone, embrace,<br/>Believing where we cannot prove;</p>"
                        "<p>Thine are these orbs of light and shade;<br/>Thou madest Life in man and brute;"
                        "<br/>Thou madest Death; and lo, thy foot<br/>Is on the skull which thou hast made.</p>"
                    ),
                )
            )
            db.add(
                Fragment(
                    id=_sid("frag:tennyson:1"),
                    media_id=tennyson_media_id,
                    idx=1,
                    canonical_text=(
                        "I held it truth, with him who sings To one clear harp in divers tones, "
                        "That men may rise on stepping-stones Of their dead selves to higher things. "
                        "But who shall so forecast the years And find in loss a gain to match? "
                        "Or reach a hand thro' time to catch The far-off interest of tears?"
                    ),
                    html_sanitized=(
                        "<p>I held it truth, with him who sings<br/>To one clear harp in divers tones,"
                        "<br/>That men may rise on stepping-stones<br/>Of their dead selves to higher things.</p>"
                        "<p>But who shall so forecast the years<br/>And find in loss a gain to match?"
                        "<br/>Or reach a hand thro' time to catch<br/>The far-off interest of tears?</p>"
                    ),
                )
            )
            db.flush()
            track("media: In Memoriam A.H.H. (2 fragments)", True)
        else:
            track("media: In Memoriam A.H.H.", False)

        # Article 3: Charles Stross — A Colder War
        colder_media_id = _sid("media:colder-war")
        if not _exists(db, Media, colder_media_id):
            db.add(
                Media(
                    id=colder_media_id,
                    kind=MediaKind.web_article.value,
                    title="A Colder War",
                    canonical_source_url="https://www.infinityplus.co.uk/stories/colderwar.htm",
                    requested_url="https://www.infinityplus.co.uk/stories/colderwar.htm",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    publisher="Infinity Plus",
                    published_date="2000",
                    language="en",
                )
            )
            db.flush()
            db.add(
                Fragment(
                    id=_sid("frag:colder-war:0"),
                    media_id=colder_media_id,
                    idx=0,
                    canonical_text=(
                        "Roger Jourgensen tilts back in his chair, reading. He is a middle-aged "
                        "white male with receding hair and a beer belly, and could pass for a senior "
                        "programmer or an academic at a second-rate university. He is, in fact, a "
                        "senior analyst with the Central Intelligence Agency."
                    ),
                    html_sanitized=(
                        "<p>Roger Jourgensen tilts back in his chair, reading. He is a middle-aged "
                        "white male with receding hair and a beer belly, and could pass for a senior "
                        "programmer or an academic at a second-rate university. He is, in fact, a "
                        "senior analyst with the Central Intelligence Agency.</p>"
                    ),
                )
            )
            db.add(
                Fragment(
                    id=_sid("frag:colder-war:1"),
                    media_id=colder_media_id,
                    idx=1,
                    canonical_text=(
                        "The nightmare stacks of paperwork in his office are testament to the scale "
                        "of what the Agency calls the NIGHTMARE GREEN file. Somewhere in the frozen "
                        "wastes of Siberia, something was sleeping beneath the permafrost. Something "
                        "that the Soviets found in 1942 and decided to keep."
                    ),
                    html_sanitized=(
                        "<p>The nightmare stacks of paperwork in his office are testament to the scale "
                        "of what the Agency calls the NIGHTMARE GREEN file. Somewhere in the frozen "
                        "wastes of Siberia, something was sleeping beneath the permafrost. Something "
                        "that the Soviets found in 1942 and decided to keep.</p>"
                    ),
                )
            )
            db.flush()
            track("media: A Colder War (2 fragments)", True)
        else:
            track("media: A Colder War", False)

        # ── PDF ───────────────────────────────────────────────────────
        pdf_media_id = _sid("media:attention-paper")
        pdf_plain_text = (
            "Attention Is All You Need\n\n"
            "Abstract. The dominant sequence transduction models are based on complex recurrent "
            "or convolutional neural networks that include an encoder and a decoder. The best "
            "performing models also connect the encoder and decoder through an attention mechanism. "
            "We propose a new simple network architecture, the Transformer, based solely on "
            "attention mechanisms, dispensing with recurrence and convolutions entirely.\n\n"
            "1 Introduction\n\n"
            "Recurrent neural networks, long short-term memory and gated recurrent neural networks "
            "in particular, have been firmly established as state of the art approaches in sequence "
            "modeling and transduction problems such as language modeling and machine translation."
        )
        if not _exists(db, Media, pdf_media_id):
            db.add(
                Media(
                    id=pdf_media_id,
                    kind=MediaKind.pdf.value,
                    title="Attention Is All You Need",
                    canonical_source_url="https://arxiv.org/abs/1706.03762",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    plain_text=pdf_plain_text,
                    page_count=15,
                    publisher="arXiv",
                    published_date="2017-06",
                    language="en",
                    description="Vaswani et al. — the paper that introduced the Transformer architecture.",
                )
            )
            db.flush()
            # Page text spans: title page, abstract, introduction
            db.add(
                PdfPageTextSpan(
                    media_id=pdf_media_id,
                    page_number=1,
                    start_offset=0,
                    end_offset=25,
                    text_extract_version=1,
                )
            )
            db.add(
                PdfPageTextSpan(
                    media_id=pdf_media_id,
                    page_number=2,
                    start_offset=27,
                    end_offset=423,
                    text_extract_version=1,
                )
            )
            db.add(
                PdfPageTextSpan(
                    media_id=pdf_media_id,
                    page_number=3,
                    start_offset=425,
                    end_offset=len(pdf_plain_text),
                    text_extract_version=1,
                )
            )
            db.flush()
            track("media: Attention Is All You Need (PDF, 3 page spans)", True)
        else:
            track("media: Attention Is All You Need (PDF)", False)

        # ── EPUB ──────────────────────────────────────────────────────
        epub_media_id = _sid("media:zarathustra")
        chapters = [
            (
                "Zarathustra's Prologue",
                "When Zarathustra was thirty years old, he left his home and the lake of his home, "
                "and went into the mountains. There he enjoyed his spirit and his solitude, and for "
                "ten years did not weary of it. But at last his heart changed, and rising one morning "
                "with the rosy dawn, he went before the sun and spake thus unto it.",
            ),
            (
                "Zarathustra's Speeches: On the Three Metamorphoses",
                "Of three metamorphoses of the spirit I tell you: how the spirit becomes a camel; "
                "and the camel, a lion; and the lion, finally, a child. Many heavy things are there "
                "for the spirit, the strong reverent spirit that would bear much: for the heavy and "
                "the heaviest longeth its strength.",
            ),
            (
                "Zarathustra's Speeches: On the Despisers of the Body",
                "To the despisers of the body will I speak my word. I wish them neither to learn "
                "afresh, nor teach anew, but merely to bid farewell to their own bodies—and thus "
                "be dumb. Body am I, and soul—thus speaks the child. And why should one not speak "
                "like children?",
            ),
            (
                "Zarathustra's Speeches: On Reading and Writing",
                "Of all that is written, I love only what a person has written with his blood. Write "
                "with blood, and you will find that blood is spirit. It is no easy task to understand "
                "unfamiliar blood; I hate the reading idlers.",
            ),
            (
                "Zarathustra's Speeches: On the Tree on the Hill",
                "Zarathustra had noticed that a certain youth avoided him. And as he walked alone one "
                "evening over the hills surrounding the town called The Motley Cow, he found the youth "
                "sitting there leaning against a tree and looking wearily into the valley.",
            ),
        ]
        if not _exists(db, Media, epub_media_id):
            db.add(
                Media(
                    id=epub_media_id,
                    kind=MediaKind.epub.value,
                    title="Thus Spake Zarathustra",
                    canonical_source_url="https://www.gutenberg.org/ebooks/1998",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    publisher="Project Gutenberg",
                    published_date="1885",
                    language="en",
                    description="Friedrich Nietzsche — a philosophical novel.",
                )
            )
            db.flush()
            for idx, (title, body) in enumerate(chapters):
                db.add(
                    Fragment(
                        id=_sid(f"frag:zarathustra:{idx}"),
                        media_id=epub_media_id,
                        idx=idx,
                        canonical_text=body,
                        html_sanitized=f"<h1>{title}</h1>\n<p>{body}</p>",
                    )
                )
                db.add(
                    EpubTocNode(
                        media_id=epub_media_id,
                        node_id=f"ch{idx + 1}",
                        parent_node_id=None,
                        label=title,
                        href=f"chapter{idx + 1}.xhtml",
                        fragment_idx=idx,
                        depth=0,
                        order_key=f"{idx + 1:04d}",
                    )
                )
            db.flush()
            track("media: Thus Spake Zarathustra (EPUB, 5 chapters)", True)
        else:
            track("media: Thus Spake Zarathustra (EPUB)", False)

        # ── YouTube videos ────────────────────────────────────────────
        # Video 1: Karpathy — with transcript
        karpathy_media_id = _sid("media:karpathy-micrograd")
        if not _exists(db, Media, karpathy_media_id):
            db.add(
                Media(
                    id=karpathy_media_id,
                    kind=MediaKind.video.value,
                    title="The spelled-out intro to neural networks and backpropagation",
                    canonical_source_url="https://www.youtube.com/watch?v=VMj-3S1tku0",
                    requested_url="https://www.youtube.com/watch?v=VMj-3S1tku0",
                    canonical_url="https://www.youtube.com/watch?v=VMj-3S1tku0",
                    external_playback_url="https://www.youtube.com/embed/VMj-3S1tku0",
                    provider="youtube",
                    provider_id="VMj-3S1tku0",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    published_date="2022-08",
                    language="en",
                )
            )
            db.flush()
            # Transcript fragments
            for idx, (text, speaker, t_start, t_end) in enumerate(
                [
                    (
                        "Hi everyone, today we are going to build micrograd. Micrograd is basically "
                        "an autograd engine. It implements backpropagation over a dynamically built "
                        "directed acyclic graph.",
                        "Andrej Karpathy",
                        0,
                        12000,
                    ),
                    (
                        "So let me show you what the API looks like. We are going to build out a "
                        "Value object that wraps a scalar value and tracks all the operations we "
                        "do on it.",
                        "Andrej Karpathy",
                        12000,
                        24000,
                    ),
                    (
                        "And then we can call backward on the final output and it will compute the "
                        "gradients of all the intermediate values with respect to that output. This "
                        "is the core of what neural network training looks like.",
                        "Andrej Karpathy",
                        24000,
                        38000,
                    ),
                ]
            ):
                db.add(
                    Fragment(
                        id=_sid(f"frag:karpathy:{idx}"),
                        media_id=karpathy_media_id,
                        idx=idx,
                        canonical_text=text,
                        html_sanitized=f"<p>{text}</p>",
                        speaker_label=speaker,
                        t_start_ms=t_start,
                        t_end_ms=t_end,
                    )
                )
            db.flush()
            track("media: Karpathy micrograd (video, 3 transcript fragments)", True)
        else:
            track("media: Karpathy micrograd (video)", False)

        # Video 2: Aidan Gomez — no transcript
        gomez_media_id = _sid("media:gomez-podcast")
        if not _exists(db, Media, gomez_media_id):
            db.add(
                Media(
                    id=gomez_media_id,
                    kind=MediaKind.video.value,
                    title="Aidan Gomez — Cohere and the Future of Language Models",
                    canonical_source_url="https://www.youtube.com/watch?v=pdN-BjDx1_0",
                    requested_url="https://www.youtube.com/watch?v=pdN-BjDx1_0",
                    canonical_url="https://www.youtube.com/watch?v=pdN-BjDx1_0",
                    external_playback_url="https://www.youtube.com/embed/pdN-BjDx1_0",
                    provider="youtube",
                    provider_id="pdN-BjDx1_0",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                    published_date="2023-03",
                    language="en",
                )
            )
            db.flush()
            track("media: Gomez interview (video, no transcript)", True)
        else:
            track("media: Gomez interview (video)", False)

        # ── Podcast + episodes ────────────────────────────────────────
        podcast_id = _sid("podcast:hardcore-history")
        if not _exists(db, Podcast, podcast_id):
            db.add(
                Podcast(
                    id=podcast_id,
                    provider="manual",
                    provider_podcast_id="hardcore-history",
                    title="Hardcore History",
                    author="Dan Carlin",
                    feed_url="https://feeds.feedburner.com/dancarloinhardcorehistory",
                    website_url="https://www.dancarlin.com",
                    description=(
                        "In Hardcore History, journalist and broadcaster Dan Carlin takes his "
                        "unorthodox approach and applies it to the past."
                    ),
                )
            )
            db.flush()
            track("podcast: Hardcore History", True)
        else:
            track("podcast: Hardcore History", False)

        episode_media_ids = []
        for ep_idx, (ep_title, ep_dur) in enumerate(
            [
                ("Blueprint for Armageddon I", 5580),
                ("Blueprint for Armageddon II", 5340),
                ("Blueprint for Armageddon III", 5100),
            ]
        ):
            ep_media_id = _sid(f"media:hh-ep:{ep_idx}")
            episode_media_ids.append(ep_media_id)
            if not _exists(db, Media, ep_media_id):
                db.add(
                    Media(
                        id=ep_media_id,
                        kind=MediaKind.podcast_episode.value,
                        title=ep_title,
                        processing_status=ProcessingStatus.ready_for_reading,
                        created_by_user_id=user_id,
                        language="en",
                    )
                )
                db.flush()
                db.add(
                    PodcastEpisode(
                        media_id=ep_media_id,
                        podcast_id=podcast_id,
                        provider_episode_id=f"hh-bfa-{ep_idx + 1}",
                        fallback_identity=f"hh-bfa-{ep_idx + 1}",
                        duration_seconds=ep_dur,
                        published_at=datetime(2013, 10 + ep_idx, 15, tzinfo=UTC),
                        description_text=f"Part {ep_idx + 1} of Dan Carlin's epic series on World War I.",
                    )
                )
                db.flush()
                # Two transcript fragments per episode
                db.add(
                    Fragment(
                        id=_sid(f"frag:hh-ep:{ep_idx}:0"),
                        media_id=ep_media_id,
                        idx=0,
                        canonical_text=(
                            f"This is Dan Carlin. Welcome to part {ep_idx + 1} of Blueprint for "
                            "Armageddon, our series on the First World War."
                        ),
                        html_sanitized=(
                            f"<p>This is Dan Carlin. Welcome to part {ep_idx + 1} of Blueprint for "
                            "Armageddon, our series on the First World War.</p>"
                        ),
                        speaker_label="Dan Carlin",
                        t_start_ms=0,
                        t_end_ms=15000,
                    )
                )
                db.add(
                    Fragment(
                        id=_sid(f"frag:hh-ep:{ep_idx}:1"),
                        media_id=ep_media_id,
                        idx=1,
                        canonical_text=(
                            "The assassination of Archduke Franz Ferdinand was the spark, but the powder "
                            "keg had been building for decades. Alliances, rivalries, colonial ambitions—"
                            "all converging toward catastrophe."
                        ),
                        html_sanitized=(
                            "<p>The assassination of Archduke Franz Ferdinand was the spark, but the powder "
                            "keg had been building for decades. Alliances, rivalries, colonial ambitions—"
                            "all converging toward catastrophe.</p>"
                        ),
                        speaker_label="Dan Carlin",
                        t_start_ms=15000,
                        t_end_ms=35000,
                    )
                )
                db.flush()
                track(f"media: {ep_title} (episode, 2 fragments)", True)
            else:
                track(f"media: {ep_title} (episode)", False)

        # ── Podcast subscription + category ───────────────────────────
        category_id = _sid("podcast-cat:history")
        if not db.get(PodcastSubscriptionCategory, category_id):
            db.add(
                PodcastSubscriptionCategory(
                    id=category_id,
                    user_id=user_id,
                    name="History",
                    position=0,
                    color="#8B4513",
                )
            )
            db.flush()
            track("podcast category: History", True)
        else:
            track("podcast category: History", False)

        existing_sub = db.execute(
            select(PodcastSubscription).where(
                PodcastSubscription.user_id == user_id,
                PodcastSubscription.podcast_id == podcast_id,
            )
        ).scalar_one_or_none()
        if not existing_sub:
            db.add(
                PodcastSubscription(
                    user_id=user_id,
                    podcast_id=podcast_id,
                    status="active",
                    auto_queue=True,
                    category_id=category_id,
                    sync_status="complete",
                )
            )
            db.flush()
            track("subscription: Hardcore History", True)
        else:
            track("subscription: Hardcore History", False)

        # ── Assign media to libraries ─────────────────────────────────
        default_lib_media = [
            pg_media_id,
            tennyson_media_id,
            colder_media_id,
            pdf_media_id,
        ] + episode_media_ids
        for pos, media_id in enumerate(default_lib_media):
            existing_lm = db.execute(
                select(LibraryMedia).where(
                    LibraryMedia.library_id == default_library_id,
                    LibraryMedia.media_id == media_id,
                )
            ).scalar_one_or_none()
            if not existing_lm:
                db.add(
                    LibraryMedia(
                        library_id=default_library_id,
                        media_id=media_id,
                        position=pos,
                    )
                )
                db.add(
                    DefaultLibraryIntrinsic(
                        default_library_id=default_library_id,
                        media_id=media_id,
                    )
                )
        db.flush()

        research_lib_media = [epub_media_id, karpathy_media_id, gomez_media_id]
        for pos, media_id in enumerate(research_lib_media):
            existing_lm = db.execute(
                select(LibraryMedia).where(
                    LibraryMedia.library_id == research_lib_id,
                    LibraryMedia.media_id == media_id,
                )
            ).scalar_one_or_none()
            if not existing_lm:
                db.add(
                    LibraryMedia(
                        library_id=research_lib_id,
                        media_id=media_id,
                        position=pos,
                    )
                )
        db.flush()

        # ── Highlights + annotations ──────────────────────────────────
        # Yellow highlight on Paul Graham article, fragment 0
        hl1_id = _sid("highlight:pg:yellow")
        if not _exists(db, Highlight, hl1_id):
            db.add(
                Highlight(
                    id=hl1_id,
                    user_id=user_id,
                    fragment_id=pg_frag0_id,
                    start_offset=0,
                    end_offset=46,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=pg_media_id,
                    color="yellow",
                    exact=pg_frag0_text[:46],
                    prefix="",
                    suffix=pg_frag0_text[46:96],
                )
            )
            db.flush()
            db.add(
                HighlightFragmentAnchor(
                    highlight_id=hl1_id,
                    fragment_id=pg_frag0_id,
                    start_offset=0,
                    end_offset=46,
                )
            )
            db.add(
                Annotation(
                    id=_sid("annotation:pg:yellow"),
                    highlight_id=hl1_id,
                    body="Key insight — the origin story of Viaweb and the decision to use Lisp.",
                )
            )
            db.flush()
            track("highlight: PG yellow + annotation", True)
        else:
            track("highlight: PG yellow + annotation", False)

        # Blue highlight on Paul Graham article, fragment 1
        hl2_id = _sid("highlight:pg:blue")
        pg_frag1_text = (
            "Our secret weapon was similar. We wrote our software in Lisp. It was a bold "
            "choice—hardly anyone else was using Lisp for web applications in the late 1990s. "
            "But Lisp gave us a genuine technical advantage over competitors. We could develop "
            "and deploy features faster than anyone else."
        )
        if not _exists(db, Highlight, hl2_id):
            db.add(
                Highlight(
                    id=hl2_id,
                    user_id=user_id,
                    fragment_id=pg_frag1_id,
                    start_offset=0,
                    end_offset=82,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=pg_media_id,
                    color="blue",
                    exact=pg_frag1_text[:82],
                    prefix="",
                    suffix=pg_frag1_text[82:132],
                )
            )
            db.flush()
            db.add(
                HighlightFragmentAnchor(
                    highlight_id=hl2_id,
                    fragment_id=pg_frag1_id,
                    start_offset=0,
                    end_offset=82,
                )
            )
            db.flush()
            track("highlight: PG blue", True)
        else:
            track("highlight: PG blue", False)

        # Green highlight on Zarathustra EPUB, fragment 0
        hl3_id = _sid("highlight:zarathustra:green")
        z_frag0_text = chapters[0][1]
        if not _exists(db, Highlight, hl3_id):
            db.add(
                Highlight(
                    id=hl3_id,
                    user_id=user_id,
                    fragment_id=_sid("frag:zarathustra:0"),
                    start_offset=0,
                    end_offset=60,
                    anchor_kind="fragment_offsets",
                    anchor_media_id=epub_media_id,
                    color="green",
                    exact=z_frag0_text[:60],
                    prefix="",
                    suffix=z_frag0_text[60:110],
                )
            )
            db.flush()
            db.add(
                HighlightFragmentAnchor(
                    highlight_id=hl3_id,
                    fragment_id=_sid("frag:zarathustra:0"),
                    start_offset=0,
                    end_offset=60,
                )
            )
            db.add(
                Annotation(
                    id=_sid("annotation:zarathustra:green"),
                    highlight_id=hl3_id,
                    body="The beginning of Zarathustra's journey—leaving solitude to share his wisdom.",
                )
            )
            db.flush()
            track("highlight: Zarathustra green + annotation", True)
        else:
            track("highlight: Zarathustra green + annotation", False)

        # ── Conversations + messages ──────────────────────────────────
        conv1_id = _sid("conv:paul-graham")
        if not _exists(db, Conversation, conv1_id):
            now = datetime.now(UTC)
            db.add(
                Conversation(
                    id=conv1_id,
                    owner_user_id=user_id,
                    title="Notes on Beating the Averages",
                    sharing="private",
                    next_seq=5,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.flush()
            for seq, role, content in [
                (1, "user", "What's the main argument in this essay?"),
                (
                    2,
                    "assistant",
                    "Graham argues that using Lisp gave his startup Viaweb a genuine competitive "
                    "advantage. The key claim is that programming languages vary in power, and most "
                    "people underestimate how much this matters — a team using a more powerful language "
                    "can develop features faster, which in a startup context translates directly to "
                    "beating competitors to market.",
                ),
                (3, "user", "How does this apply to modern language choices?"),
                (
                    4,
                    "assistant",
                    "The core insight isn't really about Lisp specifically — it's that technology "
                    "choices compound. If a language lets you express ideas more concisely, iterate "
                    "faster, or handle abstraction more naturally, those advantages accumulate over "
                    "months of development. Today you might see this play out with choices like "
                    "TypeScript vs plain JavaScript, or Rust vs C++ for systems work.",
                ),
            ]:
                db.add(
                    Message(
                        id=_sid(f"msg:pg:{seq}"),
                        conversation_id=conv1_id,
                        seq=seq,
                        role=role,
                        content=content,
                        status="complete",
                    )
                )
            db.add(
                ConversationMedia(
                    conversation_id=conv1_id,
                    media_id=pg_media_id,
                )
            )
            db.flush()
            track("conversation: Notes on Beating the Averages (4 messages)", True)
        else:
            track("conversation: Notes on Beating the Averages", False)

        conv2_id = _sid("conv:attention")
        if not _exists(db, Conversation, conv2_id):
            now = datetime.now(UTC)
            db.add(
                Conversation(
                    id=conv2_id,
                    owner_user_id=user_id,
                    title="Research ideas",
                    sharing="private",
                    next_seq=3,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.flush()
            for seq, role, content in [
                (1, "user", "Summarize the key innovation in the Attention paper."),
                (
                    2,
                    "assistant",
                    "The Transformer replaces recurrence entirely with multi-head self-attention. "
                    "Previous sequence models like LSTMs processed tokens one at a time, creating a "
                    "bottleneck for long sequences. Self-attention lets the model attend to all positions "
                    "simultaneously, making it inherently more parallelizable and better at capturing "
                    "long-range dependencies. The 'multi-head' aspect lets different heads learn different "
                    "types of relationships — positional, syntactic, semantic — from the same input.",
                ),
            ]:
                db.add(
                    Message(
                        id=_sid(f"msg:attn:{seq}"),
                        conversation_id=conv2_id,
                        seq=seq,
                        role=role,
                        content=content,
                        status="complete",
                    )
                )
            db.add(
                ConversationMedia(
                    conversation_id=conv2_id,
                    media_id=pdf_media_id,
                )
            )
            db.flush()
            track("conversation: Research ideas (2 messages)", True)
        else:
            track("conversation: Research ideas", False)

        # ── Commit ────────────────────────────────────────────────────
        db.commit()

    # ── Report ────────────────────────────────────────────────────────
    db_url = os.getenv("DATABASE_URL", "")
    db_display = db_url.split("@")[1] if "@" in db_url else db_url
    print(f"\nDatabase: {db_display}")
    print(f"NEXUS_ENV: {nexus_env}")
    print()
    if created:
        print(f"Created ({len(created)}):")
        for item in created:
            print(f"  ✓ {item}")
    if skipped:
        print(f"Already existed ({len(skipped)}):")
        for item in skipped:
            print(f"  • {item}")
    print()
    print(f"Login: {DEV_EMAIL} / {DEV_PASSWORD}")
    print(f"Supabase Studio: {settings.supabase_url.replace(':54321', ':54323')}")


if __name__ == "__main__":
    main()
