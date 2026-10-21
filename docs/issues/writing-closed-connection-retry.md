# storage retry reuses a closed journal connection

lab 13 at `a599ebc88` closes the real production database connection and observes native `InvalidStateError`. the foreign drainer commits the preceding acknowledgement through its independent healthy connection; the owner retains newer prose in memory. clicking the real `try again` action never checkpoints that prose.

`journal.ts:1467` opens a connection only when `database === null`. native `IDBDatabase.close()` leaves the module's reference nonnull, so retry repeats a transaction on the closed handle. artifact: `20261021-154251-31d19f48fffd/artifacts/playwright/writing-settlement-races-f-2615d-eckpointed-successor-memory`, failed checkpoint at case line 245. independent disk inspection still contains predecessor prose at its acknowledged version while the editor retains its successor.

explicit storage retry should reopen the account connection while retaining owned memory, pending admissions and branch locks. resolved when the same editor checkpoints and delivers its retained prose through real retry, without reload or copying it into another branch.

source repair: explicit retry closes the old reference and opens a fresh account connection after pending local work/branch readiness, retaining the existing memory and ownership. account capability is checked before and after opening. live qualification remains pending.
