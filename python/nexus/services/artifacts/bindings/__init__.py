"""The dossier binding registry (CP2-ENGINE scaffold; filled in CP3).

Exactly seven bindings keyed by subject scheme — the seven eligible subjects. The
engine dispatches every subject through this map with ZERO scheme literals; the
bindings are NOT placed behind the deleted reducer registry. Empty here so the
engine is importable and generic before CP3 lands the concrete bindings.
"""

from __future__ import annotations

from nexus.services.artifacts.bindings.base import DossierBinding

# Filled in CP3: media, conversation, library, podcast, contributor, page,
# note_block. A scheme absent here has no generation pipeline yet.
BINDINGS: dict[str, DossierBinding] = {}

__all__ = ["BINDINGS", "DossierBinding"]
