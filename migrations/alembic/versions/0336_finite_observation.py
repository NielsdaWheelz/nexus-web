"""Remove passive observation notification triggers after the finite-read cutover.

Application rows, revisions and job/event history are unchanged. Missing expected
objects or unexpected dependencies abort the migration. Keep chat event and worker
queue notifications. Downgrade requires the matched pre-release backup and binaries.
"""

from alembic import op

revision = "0336"
down_revision = "0335"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TRIGGER media_notify ON public.media")
    op.execute("DROP FUNCTION public.notify_media_change()")
    op.execute("DROP TRIGGER metadata_job_change ON public.background_jobs")
    op.execute("DROP FUNCTION public.notify_metadata_job_change()")
    op.execute("DROP TRIGGER oracle_readings_notify ON public.oracle_readings")
    op.execute("DROP FUNCTION public.notify_oracle_reading()")


def downgrade() -> None:
    raise RuntimeError("0336 is a hard cutover; restore the matched backup")
