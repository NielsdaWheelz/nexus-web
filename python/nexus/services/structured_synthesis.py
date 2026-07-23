"""Structured LLM synthesis: shared scaffold for one strict-JSON call.

A *structured synthesis* is a generation whose response is a strict JSON
object that validates into a caller-supplied pydantic schema. The generic
mechanics are owned here once:

- :func:`build_synthesis_prompt` — the shared system-prompt scaffold: persona +
  optional preamble + a numbered ``RULES.`` block closed by the strict-JSON
  output rule. The shared index-grounding wording lives in
  :data:`INDEX_GROUNDING_RULE`; call sites whose prompts ground by index pass
  it (verbatim or extended) as their first domain rule.
- :func:`build_synthesis_intent` — the shared two-block ``GenerateIntent``
  shape: a ``Stable(GlobalScope())`` system block (the assembled prompt) plus
  a ``Dynamic`` user block (the caller-rendered candidates/instruction), with
  ``output=StrictJsonOutput`` derived from the caller's schema via the
  canonical-subset parser. The caller wraps this in one ``GenerationRequest``
  and calls the appropriate ``llm_execution`` generation boundary itself
  (structured_synthesis is not a ledger caller).
- :func:`ground_indices` — THE grounding invariant: a model-emitted integer
  index must denote an offered candidate.
- :func:`decode_structured_synthesis` — validate a ``Succeeded`` outcome's
  strict-JSON payload into the schema and run the caller's semantic
  ``validate`` hook.
- :class:`StrictJsonStringFieldProjector` — incrementally expose one top-level
  JSON string field from raw strict-JSON text without ever exposing the JSON
  envelope or escape syntax.

**Domain stays with the caller**: the prompt text (persona/preamble/domain
rules/JSON shape), per-candidate rendering, the schema fields, the semantic
judgement inside ``validate``, the ``GenerationRequest``/generation-boundary
call, and mapping a non-``Succeeded`` ``CallOutcome`` to a domain failure —
this module never calls a generation boundary and never inspects anything but
a ``Succeeded`` outcome.

There is no repair round: the runtime enforces strict JSON at the provider
boundary (``StrictJsonOutput``), so a decode/schema/semantic-validate failure
here is terminal — :func:`decode_structured_synthesis` raises
:class:`StructuredSynthesisError` once, and the caller maps it to its own
domain failure code.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Literal, Never

from provider_runtime import (
    Cancelled,
    Dynamic,
    Failed,
    GenerateIntent,
    GlobalScope,
    Incomplete,
    InvalidToolArguments,
    Present,
    PromptBlock,
    Refused,
    Stable,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    SystemMessage,
    UserMessage,
    failure_code,
    parse_canonical_schema,
)
from pydantic import BaseModel, ValidationError

from nexus.services.llm_profiles import LlmProfile

# The shared index-grounding rule. Call sites pass it as their first domain
# rule (oracle verbatim; media-unit appends its no-invent sentence) so the
# bytes have one owner while every prompt stays reproducible verbatim.
INDEX_GROUNDING_RULE = "Refer to candidate passages only by their integer index."


class StructuredSynthesisError(Exception):
    """The strict-JSON payload failed ``schema.model_validate`` or the
    caller's semantic ``validate`` hook.

    Raised by :func:`decode_structured_synthesis` only — never for a
    non-``Succeeded`` outcome (Refused/Incomplete/Cancelled/Failed), which the
    caller matches on the raw ``CallOutcome`` itself (exhaustively, incl.
    ``Failed(TransientExhausted)`` requeue/skip contracts).
    """


class StrictJsonStringFieldProjector:
    """Incrementally decode one top-level string field from strict JSON.

    Provider streaming for ``StrictJsonOutput`` yields raw JSON fragments. A UI
    must never receive those fragments as prose. ``feed`` therefore performs a
    small lexical projection: it recognizes only an exact top-level object key,
    decodes that string value (including escapes and surrogate pairs), and
    returns newly visible characters. Other values are skipped, including
    misleading key-like text nested inside strings or containers.

    ``finish`` is mandatory. It parses the complete JSON and proves that the
    projected text is byte-for-byte equal to the terminal, schema-validated
    field before the caller may checkpoint a completed synthesis.
    """

    def __init__(self, *, field: str) -> None:
        if not field:
            raise ValueError("projected JSON field must be non-empty")
        self._field = field
        self._raw_parts: list[str] = []
        self._state = "start"
        self._depth = 0
        self._in_string = False
        self._string_role = "ignored"
        self._escape = False
        self._unicode_digits: str | None = None
        self._decoded_key: list[str] = []
        self._root_key: str | None = None
        self._target_seen = False
        self._target_complete = False
        self._projected: list[str] = []
        self._pending_high_surrogate: int | None = None

    def feed(self, chunk: str) -> str:
        """Consume one arbitrary raw-JSON fragment and return decoded field text."""
        self._raw_parts.append(chunk)
        visible: list[str] = []
        for char in chunk:
            if self._in_string:
                self._consume_string_char(char, visible)
            else:
                self._consume_outside_char(char)
        return "".join(visible)

    def finish(self, *, expected: str) -> None:
        """Validate the complete document and terminal projection equality."""
        raw = "".join(self._raw_parts)
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise StructuredSynthesisError(
                f"streamed response is not complete strict JSON: {exc}"
            ) from exc
        if not isinstance(payload, dict):
            raise StructuredSynthesisError("streamed response is not a JSON object")
        value = payload.get(self._field)
        if not isinstance(value, str):
            raise StructuredSynthesisError(
                f"streamed response field {self._field!r} is not a string"
            )
        projected = "".join(self._projected)
        if (
            self._state != "done"
            or self._in_string
            or not self._target_seen
            or not self._target_complete
            or projected != value
            or value != expected
        ):
            raise StructuredSynthesisError(
                f"streamed field {self._field!r} does not match the terminal projection"
            )

    def _consume_outside_char(self, char: str) -> None:
        if self._depth > 1:
            if char == '"':
                self._begin_string("ignored")
            elif char in "[{":
                self._depth += 1
            elif char in "]}":
                self._depth -= 1
                if self._depth == 1:
                    self._state = "after_value"
            return

        if char.isspace():
            return
        if self._state == "start":
            if char != "{":
                self._fail("streamed response must start with a JSON object")
            self._depth = 1
            self._state = "key_or_end"
            return
        if self._state == "key_or_end":
            if char == "}":
                self._depth = 0
                self._state = "done"
            elif char == '"':
                self._decoded_key = []
                self._begin_string("root_key")
            else:
                self._fail("expected a top-level JSON object key")
            return
        if self._state == "colon":
            if char != ":":
                self._fail("expected ':' after a top-level JSON object key")
            self._state = "value"
            return
        if self._state == "value":
            is_target = self._root_key == self._field
            if is_target:
                if self._target_seen:
                    self._fail(f"duplicate top-level field {self._field!r}")
                self._target_seen = True
            if char == '"':
                self._begin_string("root_target" if is_target else "root_other")
            elif char in "[{":
                self._depth += 1
                self._state = "nested"
            else:
                self._state = "primitive"
            return
        if self._state == "primitive":
            if char == ",":
                self._root_key = None
                self._state = "key_or_end"
            elif char == "}":
                self._depth = 0
                self._state = "done"
            return
        if self._state == "after_value":
            if char == ",":
                self._root_key = None
                self._state = "key_or_end"
            elif char == "}":
                self._depth = 0
                self._state = "done"
            else:
                self._fail("expected ',' or '}' after a top-level JSON value")
            return
        if self._state == "done":
            self._fail("unexpected text after the top-level JSON object")
        self._fail(f"invalid JSON projection state {self._state!r}")

    def _begin_string(self, role: str) -> None:
        self._in_string = True
        self._string_role = role
        self._escape = False
        self._unicode_digits = None
        self._pending_high_surrogate = None

    def _consume_string_char(self, char: str, visible: list[str]) -> None:
        if self._unicode_digits is not None:
            if char not in "0123456789abcdefABCDEF":
                self._fail("invalid unicode escape in streamed JSON")
            self._unicode_digits += char
            if len(self._unicode_digits) == 4:
                codepoint = int(self._unicode_digits, 16)
                self._unicode_digits = None
                self._accept_codepoint(codepoint, visible)
            return
        if self._escape:
            self._escape = False
            if char == "u":
                self._unicode_digits = ""
                return
            escapes = {
                '"': '"',
                "\\": "\\",
                "/": "/",
                "b": "\b",
                "f": "\f",
                "n": "\n",
                "r": "\r",
                "t": "\t",
            }
            decoded = escapes.get(char)
            if decoded is None:
                self._fail("invalid escape in streamed JSON")
            if self._pending_high_surrogate is not None:
                self._fail("high surrogate is not followed by a low surrogate")
            self._accept_decoded(decoded, visible)
            return
        if char == "\\":
            self._escape = True
            return
        if char == '"':
            if self._pending_high_surrogate is not None:
                self._fail("unterminated surrogate pair in streamed JSON")
            self._in_string = False
            if self._string_role == "root_key":
                self._root_key = "".join(self._decoded_key)
                self._state = "colon"
            elif self._string_role == "root_target":
                self._target_complete = True
                self._state = "after_value"
            elif self._string_role == "root_other":
                self._state = "after_value"
            self._string_role = "ignored"
            return
        if ord(char) < 0x20:
            self._fail("unescaped control character in streamed JSON")
        if self._pending_high_surrogate is not None:
            self._fail("high surrogate is not followed by a low surrogate")
        self._accept_decoded(char, visible)

    def _accept_codepoint(self, codepoint: int, visible: list[str]) -> None:
        if self._string_role not in {"root_key", "root_target"}:
            return
        if 0xD800 <= codepoint <= 0xDBFF:
            if self._pending_high_surrogate is not None:
                self._fail("nested high surrogate in streamed JSON")
            self._pending_high_surrogate = codepoint
            return
        if 0xDC00 <= codepoint <= 0xDFFF:
            high = self._pending_high_surrogate
            if high is None:
                self._fail("low surrogate without a high surrogate in streamed JSON")
            self._pending_high_surrogate = None
            combined = 0x10000 + ((high - 0xD800) << 10) + (codepoint - 0xDC00)
            self._accept_decoded(chr(combined), visible)
            return
        if self._pending_high_surrogate is not None:
            self._fail("high surrogate is not followed by a low surrogate")
        self._accept_decoded(chr(codepoint), visible)

    def _accept_decoded(self, decoded: str, visible: list[str]) -> None:
        if self._string_role == "root_key":
            self._decoded_key.append(decoded)
        elif self._string_role == "root_target":
            self._projected.append(decoded)
            visible.append(decoded)

    @staticmethod
    def _fail(message: str) -> Never:
        raise StructuredSynthesisError(message)


def build_synthesis_prompt(
    *,
    persona: str,
    preamble: str | None,
    domain_rules: Sequence[str],
    json_shape: str,
) -> str:
    """Assemble the shared synthesis system prompt.

    ``persona`` + optional ``preamble`` (blank-line separated) + ``RULES.`` +
    the numbered ``domain_rules`` (1..N-1, moved verbatim from the call site)
    + the final rule N demanding strict JSON of ``json_shape``.
    """
    rules = [f"{number}. {rule}" for number, rule in enumerate(domain_rules, start=1)]
    rules.append(
        f"{len(domain_rules) + 1}. Output strict JSON of the form: {json_shape}. "
        "No markdown fences, no extra keys, no commentary outside the JSON."
    )
    head = [persona] if preamble is None else [persona, preamble]
    return "\n\n".join([*head, "RULES.\n" + "\n".join(rules)])


def build_synthesis_user_content(
    *,
    candidates_header: str,
    rendered_candidates: str,
    extra_user_block: str | None,
) -> str:
    """Assemble the shared user-turn text: ``{candidates_header}:`` + the
    caller-rendered candidates + an optional extra block (e.g. oracle's
    ``QUESTION: …``) + the closing instruction."""
    user_content = f"{candidates_header}:\n{rendered_candidates}\n\n"
    if extra_user_block is not None:
        user_content += f"{extra_user_block}\n\n"
    user_content += "Respond with the strict JSON object as instructed."
    return user_content


def build_synthesis_intent(
    *,
    profile: LlmProfile,
    system_prompt: str,
    user_content: str,
    max_output_tokens: int,
    schema: type[BaseModel],
) -> GenerateIntent:
    """Assemble the shared two-block structured-synthesis intent.

    The system prompt is the sole ``Stable(GlobalScope())`` block (caching has
    no off state — the planner requires a non-empty stable prefix); the
    rendered candidates/instruction is one ``Dynamic`` user block.
    ``reasoning`` is always the profile's default (structured synthesis offers
    no reasoning choice); ``tools``/``tool_choice`` are empty — synthesis never
    calls tools.
    """
    return GenerateIntent(
        target=profile.target,
        messages=(
            SystemMessage(
                blocks=(PromptBlock(text=system_prompt, stability=Stable(GlobalScope())),)
            ),
            UserMessage(blocks=(PromptBlock(text=user_content, stability=Dynamic()),)),
        ),
        max_output_tokens=max_output_tokens,
        reasoning=profile.default_reasoning_option_id,
        tools=(),
        tool_choice="none",
        output=StrictJsonOutput(
            name=schema.__name__,
            schema=parse_canonical_schema(schema.model_json_schema()),
        ),
    )


def ground_indices[E, C](
    entries: Sequence[E],
    candidates: Sequence[C],
    *,
    index_of: Callable[[E], int],
    policy: Literal["drop", "reject"],
) -> list[tuple[E, C]] | None:
    """Pair each entry with the offered candidate its model-emitted index denotes.

    THE invariant: ``0 <= index_of(entry) < len(candidates)`` — an ungrounded
    index never reaches persistence. ``"reject"`` returns ``None`` on the first
    violation (the whole output is invalid); ``"drop"`` skips violating
    entries. Caller-side concerns (phase cover, ordinal dedupe, role coercion,
    dense reordinaling) stay out.
    """
    grounded: list[tuple[E, C]] = []
    for entry in entries:
        index = index_of(entry)
        if 0 <= index < len(candidates):
            grounded.append((entry, candidates[index]))
        elif policy == "reject":
            return None
    return grounded


def decode_structured_synthesis[T: BaseModel](
    outcome: Succeeded,
    *,
    schema: type[T],
    validate: Callable[[T], str | None] | None = None,
) -> T:
    """Validate a ``Succeeded`` strict-JSON outcome into ``schema``.

    Runs the caller's semantic ``validate`` hook (returns a rejection reason,
    or ``None`` to accept) after the schema validates. Either failure raises
    :class:`StructuredSynthesisError` — no repair round; the runtime already
    enforced strict JSON at the wire.
    """
    content = outcome.response.content
    if not isinstance(content, StructuredContent):
        # justify-defect: the intent's output=StrictJsonOutput plans
        # output_kind="strict_json", which the runtime promotes to
        # StructuredContent on every Succeeded outcome.
        raise AssertionError("strict-json outcome decoded as TextContent")
    try:
        value = schema.model_validate(content.payload)
    except ValidationError as exc:
        raise StructuredSynthesisError(f"response JSON does not match the schema: {exc}") from exc
    if validate is not None:
        reason = validate(value)
        if reason is not None:
            raise StructuredSynthesisError(reason)
    return value


def outcome_failure_facts(
    outcome: Refused | Incomplete | Cancelled | Failed,
) -> tuple[str, str | None]:
    """The ``(code, detail)`` a background owner records for any non-``Succeeded``
    terminal ``CallOutcome`` — shared across every background owner (structured-JSON
    or plain text), since the mapping from the runtime's closed outcome union to a
    domain error floor is the same everywhere. ``Failed`` (incl.
    ``TransientExhausted``) uses the runtime's own fixed failure code; an owner that
    must distinguish a transient cause for a requeue-vs-skip decision matches
    ``outcome`` itself before calling this.
    """
    if isinstance(outcome, Refused):
        return "refused", outcome.safe_detail
    if isinstance(outcome, Incomplete):
        code = "refused" if outcome.status == "refused" else "incomplete"
        detail = outcome.safe_detail.value if isinstance(outcome.safe_detail, Present) else None
        return code, detail
    if isinstance(outcome, Cancelled):
        return "cancelled", None
    if isinstance(outcome, Failed):
        return failure_code(outcome.failure), _failure_detail(outcome.failure)
    raise AssertionError(f"unhandled outcome variant: {outcome!r}")  # justify-defect: closed union


def _failure_detail(failure: object) -> str | None:
    if isinstance(failure, InvalidToolArguments):
        return failure.safe_detail
    return None
