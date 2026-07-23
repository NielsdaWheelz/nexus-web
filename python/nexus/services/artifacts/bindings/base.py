"""The per-subject dossier binding contract (CP2-ENGINE, A3/A4/A11/A18/A20).

Supersedes the old ``ArtifactReducer`` (a thin 13-field record). A
:class:`DossierBinding` owns everything scheme-specific about *generating* a
dossier for one subject: the prompt/operation/profile/reasoning/token budget, the
audience-visible input collection (aggregate bindings fan out through
``MediaIntelligence.ensure_current_many`` — bounded, inline), the bounded
reduction, the citation materialization (citations come ONLY from offered
candidates), the typed input manifest + freshness comparison (no LLM), the
binding-specific coverage projection, and the typed empty-input behavior.

The generic engine (``services.artifacts.engine``) drives these methods with ZERO
scheme branches. Concrete bindings are registered in ``bindings.__init__`` (CP3);
this module is the shape they conform to.
"""

from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel
from sqlalchemy.orm import Session

from nexus.schemas.artifact import MediaAbstractOut
from nexus.schemas.presence import Presence, absent
from nexus.services.artifacts.dossier_types import AudienceScope, DossierBuildFailureCode
from nexus.services.artifacts.manifests import InputManifestV1
from nexus.services.artifacts.subject_policy import ResolvedSubject
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.schemas import CitationInput

# ``collect`` output + the pre-promotion witness are opaque to the engine — it
# threads them back into the binding's own ``build_user_content`` / ``materialize``
# / ``recheck_witness``. ``Coverage`` is binding-specific (A18: not one generic %).
CollectedInputs = Any
ValidationWitness = Any
Coverage = Any


class DossierBindingBase:
    """The one shared default for the Media-only head projection."""

    def media_abstract(
        self,
        db: Session,
        *,
        subject_id: UUID,
        requester_user_id: UUID,
    ) -> Presence[MediaAbstractOut]:
        del db, subject_id, requester_user_id
        return absent()


class DossierInputTooLarge(Exception):
    """The binding's declared deterministic input budget was exceeded."""


class DossierBinding(Protocol):
    """One subject scheme's generation pipeline (A20). Registered by scheme."""

    # --- declarative operation policy (A4) ---------------------------------
    subject_scheme: str
    llm_operation: BackgroundLlmOperation
    # The declared profile id ("balanced" | "fast"); the engine resolves the
    # concrete profile via ``operation_profile(llm_operation)``.
    profile: str
    # The reasoning override the build job applies (A4): balanced defaults to
    # medium, but Library/Podcast/Contributor run at ``high``; Page/Note at ``low``.
    reasoning: ReasoningLevel
    max_output_tokens: int
    system_prompt: str
    schema: type[BaseModel]

    def media_abstract(
        self,
        db: Session,
        *,
        subject_id: UUID,
        requester_user_id: UUID,
    ) -> Presence[MediaAbstractOut]:
        """Return the compact current Media Intelligence projection for Media."""
        ...

    # --- input collection + bounded reduction (A3/A11) ---------------------
    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,
    ) -> CollectedInputs:
        """Gather the audience-visible inputs. Aggregate bindings call
        ``MediaIntelligence.ensure_current_many`` here (bounded, inline child)."""
        ...

    def empty_failure(self, collected: CollectedInputs) -> DossierBuildFailureCode | None:
        """The pre-dispatch typed failure when there is no usable input
        (``NoSourceMaterial``, or ``DependencyProjectionFailed`` when a required
        projection failed while other sources exist), or ``None`` when usable."""
        ...

    def build_user_content(self, collected: CollectedInputs, instruction: str | None) -> str:
        """Render the single reduction step's user-turn text."""
        ...

    # --- pre-promotion validation witness (A6) -----------------------------
    def validation_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        collected: CollectedInputs,
    ) -> ValidationWitness:
        """Re-resolve every manifest input + citation candidate for the audience,
        OUTSIDE the head lock. Carries the offered candidates ``materialize`` cites
        against and the fingerprints ``recheck_witness`` rechecks under lock."""
        ...

    def recheck_witness(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        witness: ValidationWitness,
    ) -> bool:
        """Cheap authoritative recheck under the head lock (visibility/membership/
        topology/content fingerprints + citation-target existence). ``False`` means
        the inputs changed → the engine fails ``InputsChanged``."""
        ...

    # --- output + citation materialization (A10) ---------------------------
    def materialize(
        self,
        collected: CollectedInputs,
        decoded_output: BaseModel,
        witness: ValidationWitness,
    ) -> tuple[str, list[CitationInput]]:
        """Produce ``(content_md, citations)``. Citations come ONLY from the
        witness's offered candidates; narrowness is candidate construction, not a
        validator. Zero citations after dispatch → the engine fails
        ``CitationValidationFailed``."""
        ...

    # --- typed manifest + freshness + coverage (A18/A21) -------------------
    def input_manifest(self, collected: CollectedInputs) -> InputManifestV1:
        """The typed manifest stored on the successful revision (freshness +
        coverage source)."""
        ...

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        """The manifest of the subject's current live inputs (no LLM) — compared to
        the stored manifest for freshness."""
        ...

    def manifests_equal(self, stored: InputManifestV1, live: InputManifestV1) -> bool:
        """Freshness comparison (no LLM): equal ⇒ current, else stale."""
        ...

    def coverage(self, manifest: InputManifestV1) -> Coverage:
        """The binding-specific coverage projection derived from a manifest (A18)."""
        ...
