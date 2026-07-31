package app.nexus.android.playback

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.lifecycle.Lifecycle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nexus.android.MainActivity
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.TimeUnit

@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class NexusPlaybackServiceTest {
    private val context: Context =
        ApplicationProvider.getApplicationContext()
    private val instrumentation =
        InstrumentationRegistry.getInstrumentation()

    @Test
    fun controllerAndActivityRecreationKeepOneServiceSessionUntilAccountSwitch() {
        resetService()
        var firstController: MediaController? = null
        var secondController: MediaController? = null
        try {
            val first = buildController()
            firstController = first
            assertConnectedAbsent(connect(first, ACCOUNT_A))
            assertAccepted(send(first, previewLoad()))

            val loaded = snapshot(first)
            assertEquals("Preview", loaded.getJSONObject("snapshot").getString("kind"))
            assertEquals(
                SESSION_A.toString(),
                loaded.getJSONObject("snapshot").getString("sessionKey"),
            )
            val previewPauseSetting = send(
                first,
                JSONObject()
                    .put("kind", "SetSessionPauseShorteningMode")
                    .put("requestId", UUID.randomUUID().toString())
                    .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
                    .put("sessionKey", SESSION_A.toString())
                    .put("mode", "Natural"),
            )
            assertEquals("Rejected", previewPauseSetting.getString("kind"))
            assertEquals(
                "InvalidRequest",
                previewPauseSetting.getString("code"),
            )
            // Command registration is exhaustively asserted by
            // NexusPlaybackServiceContractTest. Media3's runtime
            // availableCommands is timeline-dependent and an intentionally
            // unreachable fixture URL may fail before publishing a seekable
            // timeline, so this lifecycle proof exercises only commands that
            // are available at this instant.
            instrumentation.runOnMainSync {
                if (first.availableCommands.contains(Player.COMMAND_PLAY_PAUSE)) {
                    first.pause()
                }
                if (first.availableCommands.contains(Player.COMMAND_SET_VOLUME)) {
                    first.volume = 0.25f
                }
            }

            lateinit var second: MediaController
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.moveToState(Lifecycle.State.STARTED)
                assertSessionKey(snapshot(first), SESSION_A)
                scenario.moveToState(Lifecycle.State.RESUMED)
                scenario.recreate()
                assertSessionKey(snapshot(first), SESSION_A)

                second = buildController()
                secondController = second
                assertSessionKey(connect(second, ACCOUNT_A), SESSION_A)
                instrumentation.runOnMainSync {
                    assertEquals(
                        SESSION_A.toString(),
                        first.currentMediaItem?.mediaId,
                    )
                    assertEquals(
                        first.currentMediaItem?.mediaId,
                        second.currentMediaItem?.mediaId,
                    )
                }
            }

            NexusPlayerPreferences(context).setPendingNaturalEnd(
                pendingReceipt(ACCOUNT_A)
            )
            val switched = connect(second, ACCOUNT_B)
            assertConnectedAbsent(switched)
            assertEquals(
                Presence.Absent,
                NexusPlayerPreferences(context).pendingNaturalEnd(),
            )
            assertEquals(
                "Absent",
                snapshot(first).getJSONObject("snapshot").getString("kind"),
            )
        } finally {
            releaseController(secondController)
            releaseController(firstController)
            resetService()
        }
    }

    @Test
    fun stoppedServiceDoesNotRestoreAnInMemoryPlayerSession() {
        resetService()
        var controller: MediaController? = null
        var replacement: MediaController? = null
        try {
            controller = buildController()
            assertConnectedAbsent(connect(controller, ACCOUNT_A))
            assertAccepted(send(controller, previewLoad()))
            assertSessionKey(snapshot(controller), SESSION_A)
            releaseController(controller)
            controller = null

            context.stopService(Intent(context, NexusPlaybackService::class.java))
            SystemClock.sleep(300)

            replacement = buildController()
            assertConnectedAbsent(connect(replacement, ACCOUNT_A))
        } finally {
            releaseController(replacement)
            releaseController(controller)
            resetService()
        }
    }

    @Test
    fun manifestExposesTheMediaSessionContractWithoutAResumptionReceiver() {
        val packageInfo = context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.GET_PERMISSIONS or
                PackageManager.GET_SERVICES or
                PackageManager.GET_RECEIVERS,
        )
        assertTrue(
            packageInfo.requestedPermissions.orEmpty()
                .contains(Manifest.permission.POST_NOTIFICATIONS)
        )

        val serviceName = NexusPlaybackService::class.java.name
        val service = packageInfo.services.orEmpty().single { it.name == serviceName }
        assertFalse(service.exported)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            assertTrue(
                service.foregroundServiceType and
                    android.content.pm.ServiceInfo
                        .FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK != 0
            )
        }
        assertTrue(
            context.packageManager.queryBroadcastReceivers(
                Intent(Intent.ACTION_MEDIA_BUTTON).setPackage(context.packageName),
                PackageManager.MATCH_DEFAULT_ONLY,
            ).isEmpty()
        )
    }

    @Test
    fun pendingNaturalEndReplaysAcrossPreferencesOwnerRecreationUntilExactAck() {
        clearPlayerPreferences()
        try {
            val receipt = pendingReceipt(ACCOUNT_A)
            NexusPlayerPreferences(context).setPendingNaturalEnd(receipt)

            val recreatedOwner = NexusPlayerPreferences(
                context.applicationContext
            )
            assertEquals(
                Presence.Present(receipt),
                recreatedOwner.pendingNaturalEnd(),
            )
            assertFalse(
                recreatedOwner.acknowledgeNaturalEnd(
                    receipt.sessionKey,
                    UUID.fromString("00000000-0000-4000-8000-000000000006"),
                )
            )
            assertEquals(
                Presence.Present(receipt),
                recreatedOwner.pendingNaturalEnd(),
            )
            assertTrue(
                recreatedOwner.acknowledgeNaturalEnd(
                    receipt.sessionKey,
                    receipt.clientMutationId,
                )
            )
            assertEquals(Presence.Absent, recreatedOwner.pendingNaturalEnd())
        } finally {
            clearPlayerPreferences()
        }
    }

    private fun buildController(): MediaController {
        lateinit var future: ListenableFuture<MediaController>
        instrumentation.runOnMainSync {
            future = MediaController.Builder(
                context,
                SessionToken(
                    context,
                    ComponentName(context, NexusPlaybackService::class.java),
                ),
            ).buildAsync()
        }
        return future.get(5, TimeUnit.SECONDS)
    }

    private fun releaseController(controller: MediaController?) {
        if (controller == null) {
            return
        }
        instrumentation.runOnMainSync(controller::release)
    }

    private fun send(
        controller: MediaController,
        body: JSONObject,
    ): JSONObject {
        val parsed = PlayerWire.parseCommand(body.toString())
        val command = (parsed as PlayerCommandParseResult.Accepted).command
        lateinit var future: ListenableFuture<SessionResult>
        instrumentation.runOnMainSync {
            future = controller.sendCustomCommand(
                SessionCommand(
                    NexusPlaybackService.actionFor(command),
                    Bundle.EMPTY,
                ),
                Bundle().apply {
                    putString(
                        NexusPlaybackService.ARG_COMMAND_JSON,
                        body.toString(),
                    )
                },
            )
        }
        val result = future.get(5, TimeUnit.SECONDS)
        assertEquals(SessionResult.RESULT_SUCCESS, result.resultCode)
        return JSONObject(
            checkNotNull(
                result.extras.getString(NexusPlaybackService.ARG_REPLY_JSON)
            )
        )
    }

    private fun connect(
        controller: MediaController,
        accountId: UUID,
    ): JSONObject =
        send(
            controller,
            JSONObject()
                .put("kind", "Connect")
                .put("requestId", UUID.randomUUID().toString())
                .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
                .put("accountId", accountId.toString()),
        )

    private fun snapshot(controller: MediaController): JSONObject =
        send(
            controller,
            JSONObject()
                .put("kind", "GetSnapshot")
                .put("requestId", UUID.randomUUID().toString())
                .put("protocolVersion", PLAYER_PROTOCOL_VERSION),
        )

    private fun previewLoad(): JSONObject {
        val absent = JSONObject().put("kind", "Absent")
        return JSONObject()
            .put("kind", "LoadPreview")
            .put("requestId", UUID.randomUUID().toString())
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("sessionKey", SESSION_A.toString())
            .put(
                "descriptor",
                JSONObject()
                    .put("target", SESSION_A.toString())
                    .put("previewHref", "https://example.invalid/preview")
                    .put("title", "Lifecycle test preview")
                    .put("source", "Instrumentation")
                    .put("sourceHref", "https://example.invalid")
                    .put(
                        "audioUrl",
                        "https://media.invalid/nexus-player-test.mp3",
                    )
                    .put("imageUrl", absent)
                    .put("durationMs", absent),
            )
    }

    private fun pendingReceipt(accountId: UUID): PendingNaturalEnd =
        PendingNaturalEnd(
            accountId = accountId,
            sessionKey = SESSION_A,
            mediaId = MEDIA_ID,
            origin = PlayerOrigin.Direct,
            clientMutationId = MUTATION_ID,
            terminalListening = TerminalListening(
                positionMs = 10,
                durationMs = Presence.Present(10),
                episodePlaybackRate = Presence.Absent,
                expectedWriteRevision = 1,
                expectedResetEpoch = 1,
            ),
            expectedConsumptionOverrideRevision = Presence.Absent,
        )

    private fun assertAccepted(reply: JSONObject) {
        assertEquals("Accepted", reply.getString("kind"))
    }

    private fun assertConnectedAbsent(reply: JSONObject) {
        assertEquals("Connected", reply.getString("kind"))
        assertEquals("Absent", reply.getJSONObject("snapshot").getString("kind"))
        assertEquals(
            "Absent",
            reply.getJSONObject("pendingNaturalEnd").getString("kind"),
        )
    }

    private fun assertSessionKey(reply: JSONObject, expected: UUID) {
        assertEquals(
            expected.toString(),
            reply.getJSONObject("snapshot").getString("sessionKey"),
        )
    }

    private fun resetService() {
        context.stopService(Intent(context, NexusPlaybackService::class.java))
        clearPlayerPreferences()
        SystemClock.sleep(200)
    }

    private fun clearPlayerPreferences() {
        context.getSharedPreferences("nexus.player", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    private companion object {
        val ACCOUNT_A: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000001")
        val ACCOUNT_B: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000002")
        val SESSION_A: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000003")
        val MEDIA_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000004")
        val MUTATION_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000005")
    }
}
