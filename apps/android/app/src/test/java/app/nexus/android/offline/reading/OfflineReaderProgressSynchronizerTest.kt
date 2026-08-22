package app.nexus.android.offline.reading

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class OfflineReaderProgressSynchronizerTest {
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")

    @Test
    fun `equal base CAS clears pending while races and generation changes preserve device state`() {
        val acceptedRepository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            acceptedRepository,
            SequenceProgressOrigin(
                fetches = ArrayDeque(listOf(stateWithPage(4, 2))),
                writeResult = RemoteReaderWriteResult.Accepted(state(5)),
            ),
        ).synchronize()
        assertEquals(listOf("Accepted:5"), acceptedRepository.outcomes)

        val racedRepository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            racedRepository,
            SequenceProgressOrigin(
                fetches = ArrayDeque(listOf(stateWithPage(4, 2), stateWithPage(9, 3))),
                writeResult = RemoteReaderWriteResult.Conflict,
            ),
        ).synchronize()
        assertEquals(listOf("Conflict:9"), racedRepository.outcomes)

        val changedRepository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            changedRepository,
            SequenceProgressOrigin(
                fetches = ArrayDeque(listOf(state(4, generation = 8))),
                writeResult = RemoteReaderWriteResult.Accepted(state(5)),
            ),
        ).synchronize()
        assertEquals(listOf("ContentChanged"), changedRepository.outcomes)
    }

    @Test
    fun `canonical advance branches to conflict before CAS and source deletion is durable`() {
        val conflictRepository = RecordingProgressRepository(candidate())
        val conflictOrigin = SequenceProgressOrigin(
            fetches = ArrayDeque(listOf(stateWithPage(6, 2))),
            writeResult = RemoteReaderWriteResult.Accepted(state(7)),
        )
        OfflineReaderProgressSynchronizer(conflictRepository, conflictOrigin).synchronize()
        assertEquals(listOf("Conflict:6"), conflictRepository.outcomes)
        assertEquals(0, conflictOrigin.writeCount)

        val unavailableRepository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            unavailableRepository,
            object : OfflineReaderProgressOriginClient {
                override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState {
                    throw OfflineReaderProgressOriginException(
                        ReaderProgressOriginFailure.SourceUnavailable
                    )
                }

                override fun compareAndSwap(candidate: ReaderProgressSyncCandidate) =
                    error("CAS must not run after source deletion")
            },
        ).synchronize()
        assertEquals(listOf("SourceUnavailable"), unavailableRepository.outcomes)
    }

    @Test
    fun `authorization fences remote work while network and server preserve retry`() {
        val authorizationRepository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            authorizationRepository,
            object : OfflineReaderProgressOriginClient {
                override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState {
                    throw OfflineReaderProgressOriginException(
                        ReaderProgressOriginFailure.AuthorizationRequired
                    )
                }

                override fun compareAndSwap(candidate: ReaderProgressSyncCandidate) =
                    error("CAS must not run after authorization denial")
            },
        ).synchronize()
        assertEquals(listOf("AuthorizationRequired"), authorizationRepository.outcomes)

        for (reason in listOf(
            ReaderProgressOriginFailure.Network,
            ReaderProgressOriginFailure.Server,
        )) {
            val repository = RecordingProgressRepository(candidate())
            OfflineReaderProgressSynchronizer(
                repository,
                object : OfflineReaderProgressOriginClient {
                    override fun fetch(
                        mediaId: UUID,
                        expectedAccountId: UUID,
                    ): AttestedRemoteReaderState {
                        throw OfflineReaderProgressOriginException(reason)
                    }

                    override fun compareAndSwap(candidate: ReaderProgressSyncCandidate) =
                        error("CAS must not run after failed fetch")
                },
            ).synchronize()
            assertTrue("$reason must preserve pending", repository.outcomes.isEmpty())
        }
    }

    @Test
    fun `HTTP not-found mapping drives the durable source-unavailable branch`() {
        assertEquals(
            ReaderProgressOriginFailure.SourceUnavailable,
            readerProgressOriginFailure("E_MEDIA_NOT_FOUND"),
        )
        val repository = RecordingProgressRepository(candidate())
        OfflineReaderProgressSynchronizer(
            repository,
            object : OfflineReaderProgressOriginClient {
                override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState {
                    throw OfflineReaderProgressOriginException(
                        readerProgressOriginFailure("E_MEDIA_NOT_FOUND")
                    )
                }

                override fun compareAndSwap(candidate: ReaderProgressSyncCandidate) =
                    error("CAS must not run after HTTP 404")
            },
        ).synchronize()
        assertEquals(listOf("SourceUnavailable"), repository.outcomes)
    }

    @Test
    fun `same structural locator with newer canonical revision clears pending without CAS`() {
        val candidate = candidate().copy(
            locatorJson = "{\"position\":null,\"zoom\":null,\"page_progression\":null,\"page\":3,\"kind\":\"pdf\"}",
        )
        val repository = RecordingProgressRepository(candidate)
        val origin = SequenceProgressOrigin(
            fetches = ArrayDeque(
                listOf(
                    AttestedRemoteReaderState(
                        accountId,
                        7,
                        """{"state":"Positioned","revision":9,"locator":{"kind":"pdf","page":3,"page_progression":null,"zoom":null,"position":null}}""",
                    )
                )
            ),
            writeResult = RemoteReaderWriteResult.Accepted(state(10)),
        )

        OfflineReaderProgressSynchronizer(repository, origin).synchronize()

        assertEquals(listOf("Accepted:9"), repository.outcomes)
        assertEquals(0, origin.writeCount)
    }

    @Test
    fun `wrong-account attestation fails closed before local mutation`() {
        val repository = RecordingProgressRepository(candidate())
        val wrongAccount = UUID.fromString("33333333-3333-4333-8333-333333333333")
        val failure = runCatching {
            OfflineReaderProgressSynchronizer(
                repository,
                SequenceProgressOrigin(
                    fetches = ArrayDeque(
                        listOf(
                            AttestedRemoteReaderState(
                                wrongAccount,
                                7,
                                snapshot(4),
                            )
                        )
                    ),
                    writeResult = RemoteReaderWriteResult.Accepted(state(5)),
                ),
            ).synchronize()
        }
        assertTrue(failure.exceptionOrNull() is IllegalArgumentException)
        assertTrue(repository.outcomes.isEmpty())
    }

    private fun candidate() = ReaderProgressSyncCandidate(
        UUID.fromString("008f2e74-5efc-7d0d-8a3a-142857142857"),
        accountId,
        mediaId,
        readerGeneration = 7,
        baseServerRevision = 4,
        locatorJson = "{\"kind\":\"pdf\",\"page\":1,\"page_progression\":null,\"zoom\":null,\"position\":null}",
    )

    private fun state(revision: Long, generation: Long = 7) = AttestedRemoteReaderState(
        accountId,
        generation,
        snapshot(revision),
    )

    private fun stateWithPage(revision: Long, page: Int) = AttestedRemoteReaderState(
        accountId,
        7,
        "{\"state\":\"Positioned\",\"revision\":$revision,\"locator\":{\"kind\":\"pdf\",\"page\":$page,\"page_progression\":null,\"zoom\":null,\"position\":null}}",
    )

    private fun snapshot(revision: Long) =
        "{\"state\":\"Positioned\",\"revision\":$revision,\"locator\":{\"kind\":\"pdf\",\"page\":1,\"page_progression\":null,\"zoom\":null,\"position\":null}}"
}

private class SequenceProgressOrigin(
    private val fetches: ArrayDeque<AttestedRemoteReaderState>,
    private val writeResult: RemoteReaderWriteResult,
) : OfflineReaderProgressOriginClient {
    var writeCount = 0

    override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState =
        fetches.removeFirst()

    override fun compareAndSwap(candidate: ReaderProgressSyncCandidate): RemoteReaderWriteResult {
        writeCount += 1
        return writeResult
    }
}

private class RecordingProgressRepository(
    private val candidate: ReaderProgressSyncCandidate,
) : OfflineReaderProgressRepository {
    val outcomes = mutableListOf<String>()

    override fun pendingSyncCandidates(mediaId: UUID?) = listOf(candidate)

    override fun acceptCanonical(
        candidate: ReaderProgressSyncCandidate,
        state: AttestedRemoteReaderState,
    ) {
        outcomes += "Accepted:${state.revision}"
    }

    override fun recordConflict(
        candidate: ReaderProgressSyncCandidate,
        state: AttestedRemoteReaderState,
    ) {
        outcomes += "Conflict:${state.revision}"
    }

    override fun recordContentChanged(candidate: ReaderProgressSyncCandidate) {
        outcomes += "ContentChanged"
    }

    override fun recordSourceUnavailable(candidate: ReaderProgressSyncCandidate) {
        outcomes += "SourceUnavailable"
    }

    override fun recordAuthorizationRequired(candidate: ReaderProgressSyncCandidate) {
        outcomes += "AuthorizationRequired"
    }
}
