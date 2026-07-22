"""Every LLM-facing structured-output Pydantic model emits the canonical schema
subset (docs/cutovers/llm-provider-runtime-hard-cutover.md §5).

The structural checker for that subset (object nodes carry ``required`` ==
exactly all properties and ``additionalProperties: false``; the only union is
the required-nullable ``anyOf: [non-null, null]``; no value
constraints/defaults/format/const/oneOf/allOf; ``$ref`` only a sibling-free
``#/$defs/<name>`` with acyclic definitions living at the document root) now
lives in ``provider_runtime.parse_canonical_schema`` — the exact function
every intent builder (``structured_synthesis``, ``metadata_enrichment``) calls
on these models' ``model_json_schema()`` at call time. Re-implementing the
structural check here would duplicate provider_runtime's own (more
thoroughly tested) parser; this file's remaining job is the genuine
nexus-side fact: each of nexus's LLM-facing models' emitted schema parses.
"""

import pytest
from provider_runtime import StrictJsonOutput, parse_canonical_schema
from pydantic import BaseModel

from nexus.services.artifacts.reducers.conversation_distillate import _DistillateSynthesis
from nexus.services.artifacts.reducers.library_dossier import _LiSynthesis
from nexus.services.media_intelligence import MediaUnitSynthesis
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    build_metadata_enrichment_intent,
)
from nexus.services.oracle import _OracleSynthesisOutput
from nexus.services.synapse import SynapseSynthesis

pytestmark = pytest.mark.unit

LLM_FACING_MODELS: list[type[BaseModel]] = [
    MetadataEnrichmentOutput,  # native structured output (metadata_enrichment)
    _OracleSynthesisOutput,  # structured_synthesis (oracle)
    SynapseSynthesis,  # structured_synthesis (synapse)
    MediaUnitSynthesis,  # structured_synthesis (media_intelligence)
    _LiSynthesis,  # structured_synthesis (library_dossier reducer)
    _DistillateSynthesis,  # structured_synthesis (conversation_distillate reducer)
]


@pytest.mark.parametrize("model", LLM_FACING_MODELS, ids=lambda m: m.__name__)
def test_llm_facing_model_schema_is_canonical(model: type[BaseModel]) -> None:
    parse_canonical_schema(model.model_json_schema())  # raises SchemaViolation if not canonical


def test_metadata_enrichment_intent_output_schema_is_the_model_schema() -> None:
    """The one native structured-output wire spec is exactly the model's schema."""
    intent = build_metadata_enrichment_intent(
        user_content="known metadata: {}", max_output_tokens=800
    )

    assert isinstance(intent.output, StrictJsonOutput)
    assert intent.output.schema == parse_canonical_schema(
        MetadataEnrichmentOutput.model_json_schema()
    )
