# the global atlas projection's cost is unmeasured

status: open · origin: 2026-10-04 oracle rewrite (cleanup/oracle-reauthor) · area: atlas

`services/atlas.project_all` averages every active-model embedding of every media
filed in a non-system library, then runs a pure-python PCA over all of them inside
one 300 s job lease. it replaces per-user sweeps. production holds ~708k embeddings;
neither the `avg()` scan nor the PCA has been timed there.

fix if slow: time one sweep on a restored production copy; if it nears the lease,
batch the mean or cap the dimension (the frame is a picture, not an index).
acceptance: a recorded production-scale sweep time well inside the lease.
