"""The per-device workspace layout: the web's state, validated here on every save and read."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

DEVICE_ID_MAX_LENGTH = 200
MAX_PANES = 12
MAX_PANE_HISTORY = 12
MAX_TOTAL_HISTORY = 48

Id = Annotated[str, StringConstraints(min_length=1, max_length=64)]
# mirrors apps/web/src/lib/panes/paneSecondaryModel.ts
SURFACE_GROUP = {
    "resource-contents": "resource-inspector",
    "resource-members": "resource-inspector",
    "resource-connections": "resource-inspector",
    "resource-forks": "resource-inspector",
    "resource-dossier": "resource-inspector",
    "import-detail": "imports-inspector",
}


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid")


class PaneVisit(_Model):
    id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")]
    href: Annotated[str, StringConstraints(pattern=r"^/([^/]|$)", max_length=4096)]


class PaneHistory(_Model):
    back: list[PaneVisit]
    forward: list[PaneVisit]

    @model_validator(mode="after")
    def bounded(self) -> "PaneHistory":
        if len(self.back) + len(self.forward) > MAX_PANE_HISTORY:
            raise ValueError("pane history exceeds its cap")
        return self


class WorkspaceSecondaryPane(_Model):
    id: Id
    group_id: Literal["resource-inspector", "imports-inspector"]
    active_surface_id: Literal[
        "resource-contents",
        "resource-members",
        "resource-connections",
        "resource-forks",
        "resource-dossier",
        "import-detail",
    ]
    width_px: float = Field(gt=0)
    visibility: Literal["visible", "collapsed"]

    @model_validator(mode="after")
    def surface_in_group(self) -> "WorkspaceSecondaryPane":
        if SURFACE_GROUP[self.active_surface_id] != self.group_id:
            raise ValueError("inspector surface is outside its group")
        return self


class WorkspacePane(_Model):
    id: Id
    current_visit: PaneVisit
    primary_width_px: float | None = Field(gt=0)
    visibility: Literal["visible", "minimized"]
    history: PaneHistory
    secondary: WorkspaceSecondaryPane | None


class WorkspaceState(_Model):
    """One device's panes, in strip order, and the active one."""

    active_primary_pane_id: Id
    panes: list[WorkspacePane] = Field(min_length=1, max_length=MAX_PANES)

    @model_validator(mode="after")
    def identities(self) -> "WorkspaceState":
        visits = [
            visit.id
            for pane in self.panes
            for visit in (pane.current_visit, *pane.history.back, *pane.history.forward)
        ]
        if len({pane.id for pane in self.panes}) != len(self.panes):
            raise ValueError("pane ids repeat")
        if len(set(visits)) != len(visits):
            raise ValueError("visit ids repeat")
        if len(visits) - len(self.panes) > MAX_TOTAL_HISTORY:
            raise ValueError("history exceeds its total cap")
        if not any(
            pane.id == self.active_primary_pane_id and pane.visibility == "visible"
            for pane in self.panes
        ):
            raise ValueError("the active pane must be visible")
        return self


class WorkspaceSessionsOut(BaseModel):
    """This device's session and the newest one saved by another device."""

    own: WorkspaceState | None
    most_recent_elsewhere: WorkspaceState | None
