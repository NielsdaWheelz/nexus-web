"""The per-kind reducer registry consulted by the artifact engine (G-2)."""

from __future__ import annotations

from nexus.services.artifacts.base import ArtifactReducer
from nexus.services.artifacts.reducers.conversation_distillate import (
    CONVERSATION_DISTILLATE_REDUCER,
)
from nexus.services.artifacts.reducers.library_dossier import LIBRARY_DOSSIER_REDUCER

REDUCERS: dict[str, ArtifactReducer] = {
    LIBRARY_DOSSIER_REDUCER.kind: LIBRARY_DOSSIER_REDUCER,
    CONVERSATION_DISTILLATE_REDUCER.kind: CONVERSATION_DISTILLATE_REDUCER,
}

__all__ = ["REDUCERS", "ArtifactReducer"]
