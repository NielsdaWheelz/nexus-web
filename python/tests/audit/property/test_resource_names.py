from hypothesis import given, settings
from hypothesis import strategies as st

from nexus_test_control.runtime import (
    extension_profile_identity,
    migration_database_name,
    run_bucket_name,
    run_database_name,
    supabase_user_email,
)

RUN_IDS = st.from_regex(r"[0-9a-f]{16}", fullmatch=True)
SCENARIO_IDS = st.from_regex(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?", fullmatch=True)


@settings(max_examples=100, deadline=None)
@given(run_id=RUN_IDS, scenario_id=SCENARIO_IDS)
def test_disposable_resource_names_are_injective_and_test_shaped(
    run_id: str,
    scenario_id: str,
) -> None:
    database = run_database_name(run_id)
    migration = migration_database_name(run_id)
    bucket = run_bucket_name(run_id)
    user = supabase_user_email(run_id, scenario_id)
    profile = extension_profile_identity(run_id, scenario_id)

    assert database == f"nexus_run_{run_id}"
    assert migration == f"nexus_migration_{run_id}"
    assert bucket == f"nexus-run-{run_id}"
    assert user == f"nexus+{run_id}+{scenario_id}@example.invalid"
    assert profile == f".nexus-test/runs/{run_id}/extension/{scenario_id}"
    assert len({database, migration, bucket, user, profile}) == 5
