"""The closed Universal Dossier binding and subject-policy registries.

Importing this owner installs exactly the seven eligible schemes into both
registries.  The engine consumes the maps generically and contains no
subject-specific branch.
"""

from __future__ import annotations

from nexus.services.artifacts.bindings.base import DossierBinding
from nexus.services.artifacts.bindings.contributor import (
    BINDING as CONTRIBUTOR_BINDING,
)
from nexus.services.artifacts.bindings.contributor import (
    POLICY as CONTRIBUTOR_POLICY,
)
from nexus.services.artifacts.bindings.conversation import (
    BINDING as CONVERSATION_BINDING,
)
from nexus.services.artifacts.bindings.conversation import (
    POLICY as CONVERSATION_POLICY,
)
from nexus.services.artifacts.bindings.library import (
    BINDING as LIBRARY_BINDING,
)
from nexus.services.artifacts.bindings.library import (
    POLICY as LIBRARY_POLICY,
)
from nexus.services.artifacts.bindings.media import (
    BINDING as MEDIA_BINDING,
)
from nexus.services.artifacts.bindings.media import (
    POLICY as MEDIA_POLICY,
)
from nexus.services.artifacts.bindings.note_block import (
    BINDING as NOTE_BINDING,
)
from nexus.services.artifacts.bindings.note_block import (
    POLICY as NOTE_POLICY,
)
from nexus.services.artifacts.bindings.page import (
    BINDING as PAGE_BINDING,
)
from nexus.services.artifacts.bindings.page import (
    POLICY as PAGE_POLICY,
)
from nexus.services.artifacts.bindings.podcast import (
    BINDING as PODCAST_BINDING,
)
from nexus.services.artifacts.bindings.podcast import (
    POLICY as PODCAST_POLICY,
)
from nexus.services.artifacts.subject_policy import SUBJECT_POLICIES

BINDINGS: dict[str, DossierBinding] = {
    "media": MEDIA_BINDING,
    "conversation": CONVERSATION_BINDING,
    "library": LIBRARY_BINDING,
    "podcast": PODCAST_BINDING,
    "contributor": CONTRIBUTOR_BINDING,
    "page": PAGE_BINDING,
    "note_block": NOTE_BINDING,
}

SUBJECT_POLICIES.update(
    {
        "media": MEDIA_POLICY,
        "conversation": CONVERSATION_POLICY,
        "library": LIBRARY_POLICY,
        "podcast": PODCAST_POLICY,
        "contributor": CONTRIBUTOR_POLICY,
        "page": PAGE_POLICY,
        "note_block": NOTE_POLICY,
    }
)

if set(BINDINGS) != set(SUBJECT_POLICIES) or len(BINDINGS) != 7:
    raise AssertionError("Dossier binding/policy registries must contain exactly seven schemes")


__all__ = ["BINDINGS", "DossierBinding"]
