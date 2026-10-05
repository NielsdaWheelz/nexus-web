"""An oracle reading is one row; the corpus is a data file; plates are static assets.

Revision ID: 0262
Revises: 0261

The row materializes what the retired event log displayed (the fold of simplify-04's
`get_reading_view`, frozen below): bind, argument, delta (interpretation) and omens
replace their facts, nulls included; a plate event is captured display (`plate`); a
passage event replaces its phase's prose and saved citation target and hover facts; a
folio without an event keeps its prose and its edge's excerpt. A passage records its
phase edge's ordinal, so navigation stays current. Status is kept as stored, since it
is what the generation job owns; a pending reading's `started_at` becomes its meta
event's time (null without one), and a pending reading with it displays `streaming`.
The row's own interpretation_text, which no view displayed, is replaced by the last
delta or null. The row's plate (`image_id`) becomes `plate_key` by the frozen
source-url map below. Then the log, folios, plates and the publication marker go, and
status changes notify channel oracle_readings.

upgrade() refuses, before any write, with counts and sample reading ids, on unfinished
work the new code cannot own: a held claim (a running job with an unexpired lease), or
an unfinished job whose generation journal it cannot resume (anything but none, or a
completed failure in the current shape). Pending jobs, expired claims and their
journals are kept for the new worker. It also refuses on any fold inconsistency: an
error code on a reading that did not fail, events not numbered 1..n, a terminal event
that disagrees with the row (or one on an unfinished row), a folio edge that is not the
reading's own ordinal citation with an excerpt, an unparseable event, meta that
disagrees with the row, a passage citation that disagrees with its phase edge, a plate
missing from the map. It cancels no reading and deletes no job, journal or key.
E_RATE_LIMITED becomes capacity_unavailable. Irreversible: the release's backup is the
only copy of the event rows, folio rows, plate rows, captured activations and locators,
passage-level deep links and undisplayed parent interpretations.
"""

from collections import defaultdict
from collections.abc import Sequence
from typing import Annotated, Any, Literal
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision: str = "0262"
down_revision: str | Sequence[str] | None = "0261"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PHASES = ("descent", "ordeal", "ascent")

# oracle_plates.source_url -> static key: corpus.json's image_url (2026-10-04). The last
# record pointed at The Eye's image; corpus.json corrected it to the work it names.
_PLATE_KEYS = {
    "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gustave_Dore_Inferno1.jpg/1920px-Gustave_Dore_Inferno1.jpg": "inferno-canto-i-in-a-gloomy-wood",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/Gustave_Dor%C3%A9_-_Dante_Alighieri_-_Inferno_-_Plate_9_%28Canto_III_-_Charon%29.jpg/1920px-Gustave_Dor%C3%A9_-_Dante_Alighieri_-_Inferno_-_Plate_9_%28Canto_III_-_Charon%29.jpg": "inferno-canto-iii-charon-crossing-the-river-styx",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Gustave_Dor%C3%A9_-_Dante_Alighieri_-_Inferno_-_Plate_8_%28Canto_III_-_Abandon_all_hope_ye_who_enter_here%29.jpg/1920px-Gustave_Dor%C3%A9_-_Dante_Alighieri_-_Inferno_-_Plate_8_%28Canto_III_-_Abandon_all_hope_ye_who_enter_here%29.jpg": "inferno-canto-iii-the-inscription-over-the-gate-of-hell",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Dore_Gustave_21_Curs-d_wolf_thy_fury_inward_on_thyself_prey_and_consume_thee.jpg/1920px-Dore_Gustave_21_Curs-d_wolf_thy_fury_inward_on_thyself_prey_and_consume_thee.jpg": "inferno-canto-vii-plutus",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/DVinfernoIntoAbyssOnGeryonsBack_m.jpg/1920px-DVinfernoIntoAbyssOnGeryonsBack_m.jpg": "inferno-canto-xvii-geryon",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/DVinfernoCiampoloDemonAlichino_m.jpg/1920px-DVinfernoCiampoloDemonAlichino_m.jpg": "inferno-canto-xxii-the-demons",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Inferno_Canto_34_%28148619628%29.jpg/1920px-Inferno_Canto_34_%28148619628%29.jpg": "inferno-canto-xxxiv-lucifer-king-of-hell",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/Paradise_Lost_1.jpg/1920px-Paradise_Lost_1.jpg": "paradise-lost-satan-in-council",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Paradise_Lost_4.jpg/1920px-Paradise_Lost_4.jpg": "paradise-lost-the-fall-of-the-rebel-angels",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/Paradise_Lost_12.jpg/1920px-Paradise_Lost_12.jpg": "paradise-lost-satan-surveys-the-garden",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/Paul_Gustave_Dore_Raven5.jpg/1920px-Paul_Gustave_Dore_Raven5.jpg": "the-raven-once-upon-a-midnight-dreary",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/Gustave_Dor%C3%A9_-_Paolo_and_Francesca_da_Rimini.jpg/1920px-Gustave_Dor%C3%A9_-_Paolo_and_Francesca_da_Rimini.jpg": "paolo-and-francesca-da-rimini",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/The_Hoosier_Don_Quixote_-_J.K._after_Dor%C3%A9._LCCN2011645710.jpg/1920px-The_Hoosier_Don_Quixote_-_J.K._after_Dor%C3%A9._LCCN2011645710.jpg": "don-quixote-in-his-library",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/William_Blake_-_Songs_of_Innocence_and_of_Experience%2C_Plate_42%2C_%22The_Tyger%22_%28Bentley_42%29_-_Google_Art_Project.jpg/1920px-William_Blake_-_Songs_of_Innocence_and_of_Experience%2C_Plate_42%2C_%22The_Tyger%22_%28Bentley_42%29_-_Google_Art_Project.jpg": "the-tyger-songs-of-experience-plate-42",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/William_Blake_-_Songs_of_Innocence_and_of_Experience%2C_Plate_48%2C_%22The_Sick_Rose%22_%28Bentley_39%29_-_Google_Art_Project.jpg/1920px-William_Blake_-_Songs_of_Innocence_and_of_Experience%2C_Plate_48%2C_%22The_Sick_Rose%22_%28Bentley_39%29_-_Google_Art_Project.jpg": "the-sick-rose-songs-of-experience",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/67/William_Blake_-_The_Great_Red_Dragon_and_the_Woman_Clothed_with_the_Sun_-_Google_Art_Project.jpg/1920px-William_Blake_-_The_Great_Red_Dragon_and_the_Woman_Clothed_with_the_Sun_-_Google_Art_Project.jpg": "the-great-red-dragon-and-the-woman-clothed-with-the-sun",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Blake_Dante_Hell_V.jpg/1920px-Blake_Dante_Hell_V.jpg": "the-lovers-whirlwind-illustration-to-dante-s-inferno",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Satan_Going_Forth_fron_the_Presence_of_the_Lord%2C_from_Illustrations_of_the_Book_of_Job_MET_DP816544.jpg/1920px-Satan_Going_Forth_fron_the_Presence_of_the_Lord%2C_from_Illustrations_of_the_Book_of_Job_MET_DP816544.jpg": "satan-going-forth-from-the-presence-of-the-lord-illustrations-of-the-book-of-job",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Letters_of_William_Blake%2C_page_34_%28The_Ancient_of_Days%29.jpeg/1920px-Letters_of_William_Blake%2C_page_34_%28The_Ancient_of_Days%29.jpeg": "the-ancient-of-days",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/William_Blake_-_Nebuchadnezzar_%28Tate_Britain%29.jpg/1920px-William_Blake_-_Nebuchadnezzar_%28Tate_Britain%29.jpg": "nebuchadnezzar",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/To_Edgar_Poe_%28The_Eye%2C_Like_a_Strange_Balloon%2C_Mounts_toward_Infinity%29_%28A_Edgar_Poe_%28L%27oeil%2C_comme_un_ballon_bizarre_se_dirige_vers_l%27infini%29%29_LACMA_AC1997.14.1.1.jpg/1920px-To_Edgar_Poe_%28The_Eye%2C_Like_a_Strange_Balloon%2C_Mounts_toward_Infinity%29_%28A_Edgar_Poe_%28L%27oeil%2C_comme_un_ballon_bizarre_se_dirige_vers_l%27infini%29%29_LACMA_AC1997.14.1.1.jpg": "the-eye-like-a-strange-balloon-mounts-toward-infinity-a-edgar-poe",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Odilon_Redon_-_The_Cyclops%2C_c._1914.jpg/1920px-Odilon_Redon_-_The_Cyclops%2C_c._1914.jpg": "the-cyclops",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Redon_smiling-spider.jpg/1920px-Redon_smiling-spider.jpg": "the-smiling-spider",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Francisco_Jos%C3%A9_de_Goya_y_Lucientes_-_The_sleep_of_reason_produces_monsters_%28No._43%29%2C_from_Los_Caprichos_-_Google_Art_Project.jpg/1920px-Francisco_Jos%C3%A9_de_Goya_y_Lucientes_-_The_sleep_of_reason_produces_monsters_%28No._43%29%2C_from_Los_Caprichos_-_Google_Art_Project.jpg": "the-sleep-of-reason-produces-monsters-los-caprichos-no-43",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Francisco_de_Goya%2C_Saturno_devorando_a_su_hijo_%281819-1823%29.jpg/1920px-Francisco_de_Goya%2C_Saturno_devorando_a_su_hijo_%281819-1823%29.jpg": "saturn-devouring-his-son",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/GOYA_-_El_aquelarre_%28Museo_L%C3%A1zaro_Galdiano%2C_Madrid%2C_1797-98%29.jpg/1920px-GOYA_-_El_aquelarre_%28Museo_L%C3%A1zaro_Galdiano%2C_Madrid%2C_1797-98%29.jpg": "the-witches-sabbath",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b9/Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg/1920px-Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg": "wanderer-above-the-sea-of-fog",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/The_Abbey_in_the_Oakwood_by_Caspar_David_Friedrich.jpg/1920px-The_Abbey_in_the_Oakwood_by_Caspar_David_Friedrich.jpg": "the-abbey-in-the-oakwood",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Caspar_David_Friedrich_-_Das_Eismeer.jpg/1920px-Caspar_David_Friedrich_-_Das_Eismeer.jpg": "the-sea-of-ice-the-wreck-of-hope",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Hieronymus_Bosch_-_The_Garden_of_Earthly_Delights_-_The_exterior_%28shutters%29.jpg/1920px-Hieronymus_Bosch_-_The_Garden_of_Earthly_Delights_-_The_exterior_%28shutters%29.jpg": "the-garden-of-earthly-delights-hell-panel-detail",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Hieronymus_Bosch_-_The_Garden_of_Earthly_Delights_-_Prado_in_Google_Earth-x0-y0.jpg/1920px-Hieronymus_Bosch_-_The_Garden_of_Earthly_Delights_-_Prado_in_Google_Earth-x0-y0.jpg": "the-garden-of-earthly-delights-garden-panel-detail",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/John_Henry_Fuseli_-_The_Nightmare.JPG/1920px-John_Henry_Fuseli_-_The_Nightmare.JPG": "the-nightmare",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/John_William_Waterhouse_-_The_Lady_of_Shalott_-_Google_Art_Project.jpg/1920px-John_William_Waterhouse_-_The_Lady_of_Shalott_-_Google_Art_Project.jpg": "the-lady-of-shalott",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/Arnold_B%C3%B6cklin_-_Die_Toteninsel_III_%28Alte_Nationalgalerie%2C_Berlin%29.jpg/1920px-Arnold_B%C3%B6cklin_-_Die_Toteninsel_III_%28Alte_Nationalgalerie%2C_Berlin%29.jpg": "isle-of-the-dead",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Inferno_Canto_5_line_4_Minos.jpg/1920px-Inferno_Canto_5_line_4_Minos.jpg": "inferno-canto-v-minos",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/To_Edgar_Poe_%28The_Eye%2C_Like_a_Strange_Balloon%2C_Mounts_toward_Infinity%29_%28A_Edgar_Poe_%28L%27oeil%2C_comme_un_ballon_bizarre_se_dirige_vers_l%27infini%29%29_LACMA_AC1997.14.1.1.jpg/1920px-To_Edgar_Poe_%28The_Eye%2C_Like_a_Strange_Balloon%2C_Mounts_toward_Infinity%29_%28A_Edgar_Poe_%28L%27oeil%2C_comme_un_ballon_bizarre_se_dirige_vers_l%27infini%29%29_LACMA_AC1997.14.1.1.jpg?oracle_plate=24": "there-was-perhaps-a-first-vision-attempted-in-the-flower-les-origines",
}


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Target(_Payload):
    type: Literal[
        "evidence_span",
        "content_chunk",
        "media",
        "highlight",
        "fragment",
        "page",
        "note_block",
        "message",
        "external_snapshot",
        "oracle_passage_anchor",
        "reader_apparatus_item",
    ]
    id: UUID


class _Hover(_Payload):
    title: str | None
    excerpt: str | None
    section_label: str | None
    result_type: str | None
    summary_md: str | None


class _Citation(_Payload):
    ordinal: int
    role: Literal["context", "supports", "contradicts"]
    target_ref: _Target
    deep_link: str | None
    snapshot: _Hover | None


class _Passage(_Payload):
    phase: Literal["descent", "ordeal", "ascent"]
    source_kind: Literal["user_media", "public_domain"]
    exact_snippet: str = Field(min_length=1)
    locator_label: str = Field(min_length=1)
    attribution_text: str = Field(min_length=1)
    marginalia_text: str = Field(min_length=1)
    deep_link: str | None
    citation: _Citation | None


class _Plate(_Payload):
    url: str
    attribution_text: str = Field(min_length=1)
    artist: str = Field(min_length=1)
    work_title: str = Field(min_length=1)
    year: str | None
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class _Meta(_Payload):
    question: str = Field(min_length=1, max_length=280)
    folio_number: int = Field(gt=0)


class _Bind(_Payload):
    folio_motto: str = Field(min_length=1, max_length=80)
    folio_motto_gloss: str | None = Field(min_length=1, max_length=120)
    folio_theme: Literal[
        "Of Time",
        "Of Death",
        "Of the Threshold",
        "Of Vanity",
        "Of Solitude",
        "Of Love",
        "Of Fortune",
        "Of Memory",
        "Of the Self",
        "Of the Other",
        "Of Fear",
        "Of Courage",
        "Of Faith",
        "Of Doubt",
        "Of Power",
        "Of Wisdom",
        "Of the Body",
        "Of the Soul",
        "Of Origins",
        "Of Endings",
        "Of Silence",
        "Of the Word",
        "Of Justice",
        "Of Mercy",
    ]


class _Text(_Payload):
    text: str = Field(min_length=1)


_Line = Annotated[str, Field(min_length=1)]


class _Omens(_Payload):
    lines: tuple[_Line, _Line, _Line]


# schemas.oracle.OracleFailureCode at 0262
_FailureCode = Literal[
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
    "cancelled",
    "E_ORACLE_CORPUS_NOT_READY",
    "E_APP_SEARCH_FAILED",
    "E_GENERATION_SOURCE_CHANGED",
]


class _Done(_Payload):
    status: Literal["complete", "failed"]
    error_code: _FailureCode | Literal["E_RATE_LIMITED"] | None

    @model_validator(mode="after")
    def terminal_facts(self) -> "_Done":
        if (self.status == "failed") != (self.error_code is not None):
            raise ValueError("terminal status disagrees with error code")
        return self


_PARSERS: dict[str, TypeAdapter[_Payload]] = {
    "meta": TypeAdapter(_Meta),
    "bind": TypeAdapter(_Bind),
    "argument": TypeAdapter(_Text),
    "plate": TypeAdapter(_Plate),
    "passage": TypeAdapter(_Passage),
    "delta": TypeAdapter(_Text),
    "omens": TypeAdapter(_Omens),
    "done": TypeAdapter(_Done),
}


class _JournalFailure(_Payload):
    """synthesis.Failure at 0262: the one journaled terminal the new worker decodes
    from an old journal (a completed success differs in shape, an admitted intent in
    snapshot revision)."""

    outcome: Literal["failure"]
    error_code: _FailureCode
    error_detail: str | None


_JOURNAL_FAILURE = TypeAdapter(_JournalFailure)

_PREFLIGHT = """
SELECT 'held claim', r.id FROM oracle_readings r
JOIN background_jobs j ON j.kind = 'oracle_reading_generate'
    AND j.payload->>'reading_id' = r.id::text
    AND j.status = 'running' AND j.lease_expires_at > now()
UNION ALL
SELECT 'error code on a reading that did not fail', id FROM oracle_readings
WHERE status <> 'failed' AND error_code IS NOT NULL
UNION ALL
SELECT 'events not numbered 1..n', reading_id FROM (
    SELECT reading_id, seq, row_number() OVER (PARTITION BY reading_id ORDER BY seq) AS n
    FROM oracle_reading_events
) e WHERE seq <> n
UNION ALL
SELECT 'terminal disagreement', r.id FROM oracle_readings r
LEFT JOIN LATERAL (
    SELECT event_type, payload FROM oracle_reading_events
    WHERE reading_id = r.id ORDER BY seq DESC LIMIT 1
) e ON true
WHERE (r.status IN ('complete', 'failed') AND (
          e.event_type IS DISTINCT FROM 'done'
       OR e.payload->>'status' IS DISTINCT FROM r.status
       OR e.payload->>'error_code' IS DISTINCT FROM r.error_code))
   OR (r.status IN ('pending', 'streaming') AND EXISTS (
       SELECT 1 FROM oracle_reading_events WHERE reading_id = r.id AND event_type = 'done'))
UNION ALL
SELECT 'folio edge', f.reading_id FROM oracle_reading_folios f
JOIN oracle_readings r ON r.id = f.reading_id
JOIN resource_edges e ON e.id = f.edge_id
WHERE e.user_id <> r.user_id OR e.source_scheme <> 'oracle_reading'
   OR e.source_id <> f.reading_id OR e.origin <> 'citation' OR e.ordinal IS NULL
   OR coalesce(e.snapshot->>'excerpt', '') = ''
"""


def upgrade() -> None:
    bind = op.get_bind()
    problems: defaultdict[str, set[UUID]] = defaultdict(set)
    for what, reading_id in bind.execute(sa.text(_PREFLIGHT)):
        problems[what].add(reading_id)
    for reading_id, payload in bind.execute(
        sa.text(
            "SELECT payload->>'reading_id', payload FROM background_jobs"
            " WHERE kind = 'oracle_reading_generate' AND status IN ('pending', 'running', 'failed')"
        )
    ):
        if not _resumable(payload):
            problems["a generation journal the new worker cannot resume"].add(UUID(reading_id))
    plates = {
        plate_id: _PLATE_KEYS.get(url)
        for plate_id, url in bind.execute(sa.text("SELECT id, source_url FROM oracle_plates"))
    }
    folios: defaultdict[UUID, dict[str, sa.Row]] = defaultdict(dict)
    for folio in bind.execute(
        sa.text(
            "SELECT f.*, e.ordinal, e.target_scheme, e.target_id, e.snapshot->>'excerpt' AS excerpt"
            " FROM oracle_reading_folios f JOIN resource_edges e ON e.id = f.edge_id"
        )
    ):
        folios[folio.reading_id][folio.phase] = folio
    events: defaultdict[UUID, list[sa.Row]] = defaultdict(list)
    for event in bind.execute(
        sa.text("SELECT * FROM oracle_reading_events ORDER BY reading_id, seq")
    ):
        events[event.reading_id].append(event)
    rows = [
        _fold(reading, folios[reading.id], events[reading.id], plates, problems)
        for reading in bind.execute(sa.text("SELECT * FROM oracle_readings"))
    ]
    if problems:
        raise RuntimeError(
            "0262 refuses: "
            + "; ".join(
                f"{what}: {len(ids)} readings, sample ids " + ", ".join(sorted(map(str, ids))[:10])
                for what, ids in sorted(problems.items())
            )
        )

    bind.execute(
        sa.text(
            "ALTER TABLE oracle_readings ADD COLUMN omens text[] NOT NULL DEFAULT '{}',"
            " ADD COLUMN plate_key text, ADD COLUMN plate jsonb,"
            " ADD COLUMN passages jsonb NOT NULL DEFAULT '[]'"
        )
    )
    if rows:
        bind.execute(
            sa.text(
                "UPDATE oracle_readings SET started_at = :started_at, folio_motto = :folio_motto,"
                " folio_motto_gloss = :folio_motto_gloss, folio_theme = :folio_theme,"
                " argument_text = :argument_text, interpretation_text = :interpretation_text,"
                " omens = :omens, plate_key = :plate_key, plate = :plate, passages = :passages"
                " WHERE id = :id"
            ).bindparams(
                sa.bindparam("omens", type_=ARRAY(sa.Text())),
                sa.bindparam("plate", type_=JSONB(none_as_null=True)),
                sa.bindparam("passages", type_=JSONB()),
            ),
            rows,
        )
    # Multi-statement SQL goes straight to the DBAPI cursor, as 0236 does.
    with bind.connection.cursor() as cursor:
        cursor.execute(_SCHEMA)


def _resumable(payload: dict[str, Any]) -> bool:
    """Whether the new worker finishes this unfinished job: no journal (it prepares
    afresh), or a completed failure in the current shape (it publishes it)."""
    step = (payload.get("coordination") or {}).get("synthesis")
    if step is None:
        return not payload.get("generation_admissions")
    terminal = step.get("terminal_result") or {}
    if step.get("dispatch_phase") != "Completed" or terminal.get("kind") != "Present":
        return False
    try:
        _JOURNAL_FAILURE.validate_json(terminal["value"])
    except ValidationError:
        return False
    return True


def _fold(
    reading: sa.Row,
    folios: dict[str, sa.Row],
    events: list[sa.Row],
    plates: dict[UUID, str | None],
    problems: defaultdict[str, set[UUID]],
) -> dict[str, object]:
    """The reading as the log displayed it; any inconsistency lands in ``problems``."""
    plate_key = None
    if reading.image_id is not None:
        plate_key = plates.get(reading.image_id)
        if plate_key is None:
            problems["plate missing from the map"].add(reading.id)
    row: dict[str, object] = {
        "id": reading.id,
        # a pending reading's start is its meta event (display `streaming`); others keep theirs
        "started_at": None if reading.status == "pending" else reading.started_at,
        "folio_motto": reading.folio_motto,
        "folio_motto_gloss": reading.folio_motto_gloss,
        "folio_theme": reading.folio_theme,
        "argument_text": reading.argument_text,
        "interpretation_text": None,  # only a delta event displayed one
        "omens": [],
        "plate_key": plate_key,
        "plate": None,
    }
    passages = {
        phase: {
            "phase": phase,
            "source_kind": folio.source_kind,
            "quote": folio.excerpt,
            "attribution": folio.attribution_text,
            "locator_label": folio.locator_label,
            "marginalia": folio.marginalia_text,
            "ordinal": folio.ordinal,
            "citation": None,
        }
        for phase, folio in folios.items()
    }
    for event in events:
        raw = event.payload
        if (
            event.event_type == "passage"
            and isinstance(raw, dict)
            and isinstance(raw.get("citation"), dict)
        ):
            # navigation the log cached is not history; the phase edge owns it now
            citation = {
                k: v
                for k, v in raw["citation"].items()
                if k not in {"activation", "media_id", "locator"}
            }
            raw = {**raw, "citation": citation}
        try:
            payload = _PARSERS[event.event_type].validate_python(raw)
        except (KeyError, ValidationError):
            problems["unparseable event"].add(reading.id)
            continue
        if isinstance(payload, _Meta):
            if (payload.question, payload.folio_number) != (
                reading.question_text,
                reading.folio_number,
            ):
                problems["meta disagrees with the reading"].add(reading.id)
            if reading.status == "pending" and row["started_at"] is None:
                row["started_at"] = event.created_at
        elif isinstance(payload, _Bind):
            row["folio_motto"] = payload.folio_motto
            row["folio_motto_gloss"] = payload.folio_motto_gloss
            row["folio_theme"] = payload.folio_theme
        elif isinstance(payload, _Text):
            column = "argument_text" if event.event_type == "argument" else "interpretation_text"
            row[column] = payload.text
        elif isinstance(payload, _Plate):
            key = next(
                (k for i, k in plates.items() if payload.url == f"/api/oracle/plates/{i}"), None
            )
            if key is None:
                problems["plate missing from the map"].add(reading.id)
            row["plate"] = {
                "key": key,
                "artist": payload.artist,
                "work_title": payload.work_title,
                "year": payload.year,
                "attribution": payload.attribution_text,
                "width": payload.width,
                "height": payload.height,
            }
        elif isinstance(payload, _Passage):
            folio = folios.get(payload.phase)
            saved = payload.citation
            if (
                folio is not None
                and saved is not None
                and (saved.target_ref.type, saved.target_ref.id)
                != (folio.target_scheme, folio.target_id)
            ):
                problems["passage citation disagrees with its phase edge"].add(reading.id)
            passages[payload.phase] = {
                "phase": payload.phase,
                "source_kind": payload.source_kind,
                "quote": payload.exact_snippet,
                "attribution": payload.attribution_text,
                "locator_label": payload.locator_label,
                "marginalia": payload.marginalia_text,
                "ordinal": None if folio is None else folio.ordinal,
                "citation": None if saved is None else saved.model_dump(mode="json"),
            }
        elif isinstance(payload, _Omens):
            row["omens"] = list(payload.lines)
    row["passages"] = [passages[phase] for phase in _PHASES if phase in passages]
    return row


_SCHEMA = """
UPDATE oracle_readings SET error_code = 'capacity_unavailable' WHERE error_code = 'E_RATE_LIMITED';
DROP TABLE oracle_reading_folios;
DROP TABLE oracle_reading_events;
DROP FUNCTION notify_oracle_reading_event();
ALTER TABLE oracle_readings DROP COLUMN image_id;
DROP TABLE oracle_plates;
DROP TABLE oracle_corpus_publications;

CREATE FUNCTION notify_oracle_reading() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('oracle_readings', NEW.id::text);
    RETURN NULL;
END $$;
CREATE TRIGGER oracle_readings_notify AFTER UPDATE OF status ON oracle_readings
    FOR EACH ROW EXECUTE FUNCTION notify_oracle_reading();

ALTER TABLE oracle_passage_anchors ADD COLUMN quote text;
UPDATE oracle_passage_anchors SET quote = selector->>'exact';
ALTER TABLE oracle_passage_anchors ALTER COLUMN quote SET NOT NULL,
    DROP COLUMN selector, DROP COLUMN phase_hints, DROP COLUMN updated_at;
ALTER TABLE oracle_corpus_sources DROP CONSTRAINT uix_oracle_corpus_sources_work,
    DROP COLUMN corpus_key, DROP COLUMN library_id, DROP COLUMN source_repository,
    DROP COLUMN source_url, DROP COLUMN display_order, DROP COLUMN updated_at,
    ADD CONSTRAINT uix_oracle_corpus_sources_work UNIQUE (work_key);
COMMENT ON TABLE media_atlas_positions IS
    'One global 2-d PCA frame over active-model media embeddings; sole writer services/atlas.py.';
"""


def downgrade() -> None:
    raise NotImplementedError("0262 requires restoring the previous application and database")
