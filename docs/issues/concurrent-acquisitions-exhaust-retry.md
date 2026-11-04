# independent acquisitions can exhaust serialization retries

independent clients for one account can exhaust acquisition retries after waiting on the viewer lock. `python/nexus/services/media_source_ingest.py:335,384` takes that lock inside six serializable attempts; `library_entries.py:419–428` advances library order in the same work. one client's serial queue does not remove cross-client contention.

resolve at the transaction/ordering owner, then qualify two independent browsers submitting twelve distinct links each for the same account: every intended acquisition must be accounted for without exhausted `db.resource_busy` failures or lost placement. a one-client batch pass does not close this race. no lock strategy is selected here.
