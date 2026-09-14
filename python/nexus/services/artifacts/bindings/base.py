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

from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from provider_runtime import ReasoningLevel
from pydantic import BaseModel
from sqlalchemy.orm import Session

from nexus.schemas.artifact import MediaAbstractOut
from nexus.schemas.presence import Presence, absent
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.document_html import AcceptedModelArticle
from nexus.services.artifacts.dossier_types import AudienceScope, DossierBuildFailureCode
from nexus.services.artifacts.manifests import InputManifestV1
from nexus.services.artifacts.subject_policy import ResolvedResourceSubject, ResolvedSubject
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.schemas import CitationInput

# ``collect`` output + the pre-promotion witness are opaque to the engine — it
# threads them back into the binding's own ``build_user_content`` / ``materialize``
# / ``recheck_witness``. ``Coverage`` is binding-specific (A18: not one generic %).
CollectedInputs = Any
ValidationWitness = Any
Coverage = Any


@dataclass(frozen=True, slots=True)
class MaterializedDossier:
    """An accepted inert article and its exact audience-visible citations."""

    article: AcceptedModelArticle
    citations: tuple[CitationInput, ...]


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


def require_resource_subject(resolved: ResolvedSubject) -> ResolvedResourceSubject:
    """Narrow the subject at the concrete Resource-binding boundary."""
    if not isinstance(resolved, ResolvedResourceSubject):
        raise AssertionError("Resource Dossier binding received an Idea subject")
    return resolved


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
        runtime: DossierBuildRuntime,
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
    ) -> MaterializedDossier:
        """Accept one article and map every citation to an offered candidate.

        Document acceptance raises ``DocumentHtmlError``. Any citation mismatch
        raises ``CitationValidationError`` so the engine can preserve the failure
        precedence and its one document-repair attempt.
        """
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
