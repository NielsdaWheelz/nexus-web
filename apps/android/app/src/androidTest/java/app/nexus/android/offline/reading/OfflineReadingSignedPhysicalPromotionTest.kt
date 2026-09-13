package app.nexus.android.offline.reading

import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nexus.android.BuildConfig
import app.nexus.android.MainActivity
import app.nexus.android.offline.readingweb.OFFLINE_READING_MAIN_URL
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * USB-only signed promotion owner.
 *
 * The protected device must already contain an older signed baseline with a
 * real, pre-authenticated WebView session for the dedicated synthetic account.
 * Compatible releases acquire before update. An explicitly selected
 * incompatible hard cut instead proves the complete legacy shelf empty before
 * installing the candidate, then acquires with the candidate.
 * This test deliberately accepts only fixture UUIDs as instrumentation input:
 * browser credentials never appear in a process argument, test artifact, or
 * source-controlled fixture. The hard-cut baseline census reads the frozen V1
 * storage without starting product recovery. Package operations cross the
 * production WebView message boundary into the store/job/direct-package lane.
 */
@RunWith(AndroidJUnit4::class)
@SignedPromotion
class OfflineReadingSignedPhysicalPromotionTest {
    @Test
    fun acquiresAllFormatsAndPersistsPendingProgress() {
        requirePromotionPlatform()
        val fixture = PromotionFixture.fromInstrumentation()
        PromotionBrowser.launchHosted().use { browser ->
            val hosted = browser.connectHosted()
            assertBoundToFixture(hosted, fixture)
            assertNoFixturePackages(hosted, fixture)

            fixture.media.forEach { media -> browser.enqueue(media) }
            val ready = browser.awaitSnapshot("all fixture packages to become ready") {
                fixture.media.all { media -> it.readyWithKind(media) }
            }
            assertBoundToFixture(ready, fixture)

            browser.openDownloadedCopy(fixture.article)
            val offline = browser.connectOffline()
            assertBoundToFixture(offline, fixture)
            val article = browser.open(fixture.article)
            val locator = browser.firstWebLocator(article.readerUrl)
            val saved = browser.saveProgress(fixture.article, article, locator)
            assertTrue(
                "saving progress must acknowledge the exact device locator before process death",
                saved.effectiveLocator() != null,
            )
            PromotionProgressCheckpoint.write(locator)
            browser.close(article)
        }
    }

    @Test
    fun attestsEmptyOfflineStateOnIncompatibleBaseline() {
        requirePromotionPlatform()
        val fixture = PromotionFixture.fromInstrumentation()
        attestEmptyLegacyOfflineState(fixture)
    }

    @Test
    fun opensShelfAfterForceStopRebootAndAirplaneMode() {
        requirePromotionPlatform()
        val fixture = PromotionFixture.fromInstrumentation()
        PromotionBrowser.launch().use { browser ->
            assertTrue("controller must launch the APK shelf while offline", browser.isOfflineShelf())
            val snapshot = browser.connectOffline()
            assertBoundToFixture(snapshot, fixture)
            fixture.media.forEach { media ->
                assertTrue("cold shelf must retain each fixture package", snapshot.readyWithKind(media))
                browser.open(media).also { opened ->
                    browser.assertLocalReaderDescriptor(opened)
                    if (media == fixture.article) {
                        PromotionProgressCheckpoint.assertMatches(opened.progress)
                    }
                    browser.close(opened)
                }
            }
        }
    }

    @Test
    fun reopensPersistedPackagesThenPurgesOfflineState() {
        requirePromotionPlatform()
        val fixture = PromotionFixture.fromInstrumentation()
        PromotionBrowser.launch().use { browser ->
            assertTrue("candidate must cold-launch the APK shelf while offline", browser.isOfflineShelf())
            val restored = browser.connectOffline()
            assertBoundToFixture(restored, fixture)
            fixture.media.forEach { media ->
                assertTrue("candidate must reopen every fixture package", restored.readyWithKind(media))
                browser.open(media).also { opened ->
                    browser.assertLocalReaderDescriptor(opened)
                    browser.close(opened)
                }
            }
            val article = browser.open(fixture.article)
            PromotionProgressCheckpoint.assertMatches(article.progress)
            browser.close(article)

            fixture.media.forEach(browser::remove)
            val empty = browser.awaitSnapshot("all fixture packages to be removed") { snapshot ->
                fixture.media.none { snapshot.hasItem(it.id) }
            }
            assertTrue("package removal must empty the fixture shelf", fixture.media.none { empty.hasItem(it.id) })
            browser.logoutAndPurge()
            val purged = browser.relaunchOfflineAndConnect()
            assertTrue("account purge must remove the offline-reading binding", purged.bindingAbsent())
            assertTrue("account purge must leave no fixture packages", fixture.media.none { purged.hasItem(it.id) })
        }
    }
}

private fun attestEmptyLegacyOfflineState(fixture: PromotionFixture) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val packageFiles = java.io.File(context.filesDir, "offline-reading")
        .walkTopDown()
        .drop(1)
        .filterNot { it.isDirectory }
        .map { it.absolutePath }
        .toList()
    assertTrue(
        "incompatible baseline contains offline-reading package bytes: $packageFiles",
        packageFiles.isEmpty(),
    )

    val databasePath = context.getDatabasePath("offline_reading.db")
    if (!databasePath.exists()) return
    SQLiteDatabase.openDatabase(
        databasePath.absolutePath,
        null,
        SQLiteDatabase.OPEN_READONLY,
    ).use { database ->
        assertTrue(
            "incompatible baseline has an unknown offline-reading database version",
            database.version == 1,
        )
        for (table in listOf(
            "offline_reader_packages",
            "offline_reader_transfers",
            "offline_reader_removals",
            "offline_reader_progress_baselines",
            "offline_reader_progress_pending",
            "offline_reader_purges",
            "offline_reader_account_transitions",
        )) {
            assertTrue(
                "incompatible baseline retains durable offline-reading state in $table",
                DatabaseUtils.queryNumEntries(database, table) == 0L,
            )
        }
        database.rawQuery(
            "SELECT account_id, remote_authorization_required FROM offline_reader_binding",
            null,
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                assertTrue(
                    "incompatible baseline binding belongs to another account",
                    cursor.getString(0) == fixture.accountId.toString(),
                )
                assertTrue(
                    "incompatible baseline binding requires reauthorization",
                    cursor.getInt(1) == 0,
                )
                assertTrue(
                    "incompatible baseline contains more than one account binding",
                    !cursor.moveToNext(),
                )
            }
        }
    }
}

private fun requirePromotionPlatform() {
    assertTrue("signed physical promotion requires Android API 34+", Build.VERSION.SDK_INT >= 34)
}

private data class PromotionMedia(
    val id: UUID,
    val kind: String,
    val requestedTitle: String,
)

private data class PromotionFixture(
    val accountId: UUID,
    val pdf: PromotionMedia,
    val epub: PromotionMedia,
    val article: PromotionMedia,
) {
    val media: List<PromotionMedia> get() = listOf(pdf, epub, article)

    companion object {
        fun fromInstrumentation(): PromotionFixture {
            val arguments = InstrumentationRegistry.getArguments()
            val accountId = arguments.promotionUuid("nexus_offline_reading_promotion_account_id")
            val pdf = PromotionMedia(
                arguments.promotionUuid("nexus_offline_reading_promotion_pdf_media_id"),
                "Pdf",
                "Signed promotion PDF fixture",
            )
            val epub = PromotionMedia(
                arguments.promotionUuid("nexus_offline_reading_promotion_epub_media_id"),
                "Epub",
                "Signed promotion EPUB fixture",
            )
            val article = PromotionMedia(
                arguments.promotionUuid("nexus_offline_reading_promotion_article_media_id"),
                "WebArticle",
                "Signed promotion web article fixture",
            )
            assertTrue(
                "signed promotion media fixtures must be distinct",
                setOf(pdf.id, epub.id, article.id).size == 3,
            )
            return PromotionFixture(accountId, pdf, epub, article)
        }
    }
}

private fun android.os.Bundle.promotionUuid(name: String): UUID {
    val raw = getString(name)?.trim()
    assertTrue("missing protected signed-promotion fixture input", !raw.isNullOrBlank())
    val parsed = runCatching { UUID.fromString(raw) }.getOrNull()
    assertTrue("signed-promotion fixture input must be a canonical UUID", parsed != null)
    requireNotNull(parsed)
    assertTrue(
        "signed-promotion fixture input must be a canonical UUID",
        parsed.toString() == raw && parsed.version() in 1..8 && parsed.variant() == 2,
    )
    return parsed
}

private fun assertBoundToFixture(snapshot: JSONObject, fixture: PromotionFixture) {
    val binding = snapshot.getJSONObject("binding")
    assertTrue("the pre-authenticated release baseline must bind an account", binding.optString("kind") == "Present")
    assertTrue(
        "the WebView session must attest the dedicated promotion account",
        binding.getJSONObject("value").optString("accountId") == fixture.accountId.toString(),
    )
    assertTrue(
        "the dedicated promotion account must not require reauthorization",
        !binding.getJSONObject("value").optBoolean("authorizationRequired", true),
    )
}

private fun assertNoFixturePackages(snapshot: JSONObject, fixture: PromotionFixture) {
    assertTrue(
        "promotion baseline must be reset before real package acquisition",
        fixture.media.none { snapshot.hasItem(it.id) },
    )
}

private fun JSONObject.bindingAbsent(): Boolean = getJSONObject("binding").optString("kind") == "Absent"

private fun JSONObject.hasItem(mediaId: UUID): Boolean = items().any {
    it.optString("mediaId") == mediaId.toString()
}

private fun JSONObject.readyWithKind(media: PromotionMedia): Boolean = items().any { item ->
    item.optString("mediaId") == media.id.toString() &&
        item.optString("mediaKind") == media.kind &&
        item.optJSONObject("availability")?.optString("kind") == "Ready" &&
        item.optString("title").isNotBlank()
}

private fun JSONObject.items(): List<JSONObject> {
    val items = optJSONArray("items") ?: JSONArray()
    return List(items.length()) { index -> items.getJSONObject(index) }
}

private fun JSONObject.effectiveLocator(): JSONObject? = when (optString("kind")) {
    "Canonical" -> optJSONObject("snapshot")
        ?.optJSONObject("state")
        ?.takeIf { it.optString("kind") == "Positioned" }
        ?.optJSONObject("locator")
    "Pending", "Conflict", "ContentChanged", "SourceUnavailable" -> optJSONObject("device")
    "DurablyPending" -> optJSONObject("view")?.effectiveLocator()
    else -> null
}

private object PromotionProgressCheckpoint {
    private const val PREFERENCES = "offline-reading-signed-promotion"
    private const val LOCATOR = "acknowledged-locator"

    fun write(locator: JSONObject) {
        val preferences = InstrumentationRegistry.getInstrumentation().context
            .getSharedPreferences(PREFERENCES, 0)
        assertTrue("promotion checkpoint must persist in the test APK before reboot", preferences.edit()
            .putString(LOCATOR, locator.toString())
            .commit())
    }

    fun assertMatches(progress: JSONObject) {
        val expected = InstrumentationRegistry.getInstrumentation().context
            .getSharedPreferences(PREFERENCES, 0)
            .getString(LOCATOR, null)
        assertTrue("baseline progress checkpoint is absent", !expected.isNullOrBlank())
        val actual = progress.effectiveLocator()
        assertTrue("offline reader progress did not retain an effective locator", actual != null)
        assertTrue(
            "the acknowledged reader locator must survive reboot and update exactly",
            canonicalJson(JSONObject(requireNotNull(expected))) == canonicalJson(requireNotNull(actual)),
        )
    }
}

private fun canonicalJson(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
        prefix = "{",
        postfix = "}",
    ) { key -> JSONObject.quote(key) + ":" + canonicalJson(value.get(key)) }
    is JSONArray -> List(value.length()) { index -> canonicalJson(value.get(index)) }
        .joinToString(prefix = "[", postfix = "]")
    JSONObject.NULL, null -> "null"
    is String -> JSONObject.quote(value)
    else -> value.toString()
}

private data class OpenedPromotionReading(
    val media: PromotionMedia,
    val leaseId: UUID,
    val readerGeneration: Long,
    val readerRevisionKey: String,
    val readerUrl: String,
    val progress: JSONObject,
)

private class OfflineReadingPromotionBridgeReporter {
    private val ready = LinkedBlockingQueue<Unit>()
    private val replies = LinkedBlockingQueue<String>()
    private val payloads = LinkedBlockingQueue<String>()

    @JavascriptInterface
    fun ready() {
        ready.offer(Unit)
    }

    @JavascriptInterface
    fun reply(raw: String) {
        replies.offer(raw)
    }

    @JavascriptInterface
    fun payload(raw: String) {
        payloads.offer(raw)
    }

    fun resetReady() {
        ready.clear()
    }

    fun awaitReady(timeoutSeconds: Long): Boolean = ready.poll(timeoutSeconds, TimeUnit.SECONDS) != null

    fun nextReply(timeoutNanos: Long): String? =
        replies.poll(max(1L, timeoutNanos), TimeUnit.NANOSECONDS)

    fun nextPayload(timeoutSeconds: Long): String? = payloads.poll(timeoutSeconds, TimeUnit.SECONDS)
}

private class PromotionBrowser private constructor(
    private val scenario: ActivityScenario<MainActivity>,
    private val reporter: OfflineReadingPromotionBridgeReporter = OfflineReadingPromotionBridgeReporter(),
) : AutoCloseable {
    companion object {
        private const val REPORTER_NAME = "nexusOfflineReadingPromotionReporter"
        private const val BRIDGE_REPLY_TIMEOUT_SECONDS = 30L
        // Caddy permits a 660-second package response. The transfer runner may
        // serialize the three production package assemblies, so this leaves a
        // bounded three-attempt budget inside the protected 150-minute lane.
        private const val SNAPSHOT_TIMEOUT_SECONDS = 2_100L

        fun launch(): PromotionBrowser = PromotionBrowser(ActivityScenario.launch(MainActivity::class.java))
            .also(PromotionBrowser::installReporter)

        fun launchHosted(): PromotionBrowser =
            PromotionBrowser(ActivityScenario.launch(MainActivity::class.java)).also { browser ->
                browser.loadHostedPage()
                browser.installReporter()
            }

    }

    override fun close() {
        scenario.close()
    }

    fun isOfflineShelf(): Boolean {
        var url: String? = null
        scenario.onActivity { url = it.webView.url }
        return url == OFFLINE_READING_MAIN_URL
    }

    fun connectHosted(): JSONObject {
        val initial = command("ConnectHosted")
        return when (initial.optString("kind")) {
            "Connected" -> initial.getJSONObject("snapshot")
            "Rejected" -> {
                assertTrue(
                    "hosted bridge must either connect this test or already be connecting",
                    initial.optString("code") == "Busy",
                )
                awaitSnapshot("hosted account connection") { it.getJSONObject("binding").optString("kind") == "Present" }
            }
            else -> throw AssertionError("hosted bridge returned an invalid promotion outcome")
        }
    }

    fun connectOffline(): JSONObject {
        val outcome = command("ConnectOffline")
        return when (outcome.optString("kind")) {
            "Connected" -> outcome.getJSONObject("snapshot")
            "Rejected" -> {
                assertTrue(
                    "offline bridge must either connect this test or already be connecting",
                    outcome.optString("code") == "Busy",
                )
                awaitSnapshot("offline shelf connection") { true }
            }
            else -> throw AssertionError("offline bridge returned an invalid promotion outcome")
        }
    }

    fun enqueue(media: PromotionMedia) {
        val outcome = command(
            "Enqueue",
            "mediaId" to media.id.toString(),
            "requestedTitle" to media.requestedTitle,
            "mediaKind" to media.kind,
        )
        assertTrue("real fixture enqueue must be accepted", outcome.optString("kind") == "Accepted")
    }

    fun openDownloadedCopy(media: PromotionMedia) {
        val outcome = command("OpenDownloadedCopy", "mediaId" to media.id.toString())
        assertTrue("ready fixture must open through the downloaded-copy bridge", outcome.optString("kind") == "Accepted")
        awaitOfflineShelf("downloaded-copy navigation")
        installReporter()
        assertTrue("downloaded-copy bridge must navigate to the APK shelf", isOfflineShelf())
    }

    fun open(media: PromotionMedia): OpenedPromotionReading {
        val outcome = command("OpenReading", "mediaId" to media.id.toString())
        assertTrue("fixture package must reopen through the bridge", outcome.optString("kind") == "OpenedReading")
        return OpenedPromotionReading(
            media = media,
            leaseId = UUID.fromString(outcome.getString("leaseId")),
            readerGeneration = outcome.getLong("readerGeneration"),
            readerRevisionKey = outcome.getString("readerRevisionKey"),
            readerUrl = outcome.getString("readerUrl"),
            progress = outcome.getJSONObject("progress"),
        )
    }

    fun close(opened: OpenedPromotionReading) {
        val outcome = command("CloseReading", "leaseId" to opened.leaseId.toString())
        assertTrue("opened package lease must close", outcome.optString("kind") == "Accepted")
    }

    fun saveProgress(
        media: PromotionMedia,
        opened: OpenedPromotionReading,
        locator: JSONObject,
    ): JSONObject {
        val outcome = command(
            "SaveReaderProgress",
            "mediaId" to media.id.toString(),
            "readerGeneration" to opened.readerGeneration,
            "readerRevisionKey" to opened.readerRevisionKey,
            "locator" to locator,
        )
        assertTrue("reader progress save must return its native result", outcome.optString("kind") == "ReaderProgressSaved")
        return outcome.getJSONObject("result")
    }

    fun firstWebLocator(readerUrl: String): JSONObject {
        val reader = readLocalReaderDescriptor(readerUrl)
        val fragment = reader.getJSONArray("fragments").getJSONObject(0)
        val fragmentId = fragment.getString("fragmentId")
        val quote = fragment.getString("canonicalText").take(64)
        assertTrue("web fixture must retain canonical reader text", quote.isNotBlank())
        return JSONObject()
            .put("kind", "web")
            .put("target", JSONObject().put("fragment_id", fragmentId))
            .put(
                "locations",
                JSONObject()
                    .put("text_offset", 0)
                    .put("progression", 0.0)
                    .put("total_progression", 0.0)
                    .put("position", 1),
            )
            .put(
                "text",
                JSONObject()
                    .put("quote", quote)
                    .put("quote_prefix", JSONObject.NULL)
                    .put("quote_suffix", JSONObject.NULL),
            )
    }

    fun assertLocalReaderDescriptor(opened: OpenedPromotionReading) {
        val reader = readLocalReaderDescriptor(opened.readerUrl)
        assertTrue("local reader descriptor must retain media identity", reader.optString("mediaId") == opened.media.id.toString())
        assertTrue("local reader descriptor must retain media kind", reader.optString("mediaKind") == opened.media.kind)
        when (opened.media.kind) {
            "Pdf" -> {
                assertTrue("local PDF descriptor must retain document.pdf", reader.optString("documentPath") == "document.pdf")
                val pdfUrl = opened.readerUrl.removeSuffix("reader.json") + "document.pdf"
                assertPdfRangeCapabilityAdvertised(pdfUrl)
                val script = """
                    fetch(${JSONObject.quote(pdfUrl)}, {
                      cache: 'no-store', credentials: 'omit', redirect: 'error',
                      headers: {Range: 'bytes=0-4'},
                    })
                      .then((response) => response.arrayBuffer().then((body) => ({
                        status: response.status,
                        range: response.headers.get('Content-Range'),
                        bytes: Array.from(new Uint8Array(body)),
                      })))
                      .then((result) => window.$REPORTER_NAME.payload(JSON.stringify(result)))
                      .catch(() => window.$REPORTER_NAME.payload(''));
                """.trimIndent()
                evaluate(script)
                val result = reporter.nextPayload(BRIDGE_REPLY_TIMEOUT_SECONDS)
                assertTrue("local PDF lease must serve document bytes", !result.isNullOrBlank())
                val pdf = JSONObject(requireNotNull(result))
                val bytes = pdf.optJSONArray("bytes")
                assertTrue(
                    "local PDF lease must honour the exact bounded range",
                    pdf.optInt("status") == 206 &&
                        pdf.optString("range").startsWith("bytes 0-4/") &&
                        bytes?.length() == 5,
                )
                assertTrue(
                    "local PDF lease range must begin with the PDF signature",
                    bytes != null && List(bytes.length()) { bytes.getInt(it) } == listOf(37, 80, 68, 70, 45),
                )
            }
            "Epub" -> assertTrue(
                "local EPUB descriptor must retain a section",
                reader.optJSONArray("sections")?.length()?.let { it > 0 } == true,
            )
            "WebArticle" -> assertTrue(
                "local web descriptor must retain a fragment",
                reader.optJSONArray("fragments")?.length()?.let { it > 0 } == true,
            )
            else -> throw AssertionError("promotion fixture declared an unknown media kind")
        }
    }

    /**
     * The packaged PDF.js decides whether to seek from the first, unranged
     * response: without an exact `Accept-Ranges: bytes` there the reader streams
     * the whole package PDF and never issues a range request.
     */
    private fun assertPdfRangeCapabilityAdvertised(pdfUrl: String) {
        val script = """
            fetch(${JSONObject.quote(pdfUrl)}, {cache: 'no-store', credentials: 'omit', redirect: 'error'})
              .then((response) => {
                const result = {
                  status: response.status,
                  acceptRanges: response.headers.get('Accept-Ranges'),
                };
                if (response.body) response.body.cancel();
                return result;
              })
              .then((result) => window.$REPORTER_NAME.payload(JSON.stringify(result)))
              .catch(() => window.$REPORTER_NAME.payload(''));
        """.trimIndent()
        evaluate(script)
        val raw = reporter.nextPayload(BRIDGE_REPLY_TIMEOUT_SECONDS)
        assertTrue("local PDF lease must answer an unranged request", !raw.isNullOrBlank())
        val full = JSONObject(requireNotNull(raw))
        assertTrue(
            "local PDF lease must advertise byte ranges to the packaged reader, " +
                "got status=${full.optInt("status")} Accept-Ranges=${full.optString("acceptRanges")}",
            full.optInt("status") == 200 && full.optString("acceptRanges") == "bytes",
        )
    }

    private fun readLocalReaderDescriptor(readerUrl: String): JSONObject {
        val script = """
            fetch(${JSONObject.quote(readerUrl)}, {cache: 'no-store', credentials: 'omit', redirect: 'error'})
              .then((response) => {
                if (!response.ok) throw new Error('reader package unavailable');
                return response.json();
              })
              .then((reader) => window.$REPORTER_NAME.payload(JSON.stringify(reader)))
              .catch(() => window.$REPORTER_NAME.payload(''));
        """.trimIndent()
        evaluate(script)
        val reader = reporter.nextPayload(BRIDGE_REPLY_TIMEOUT_SECONDS)
        assertTrue("opened web package must expose a local reader descriptor", !reader.isNullOrBlank())
        return JSONObject(requireNotNull(reader))
    }

    fun remove(media: PromotionMedia) {
        val outcome = command("Remove", "mediaId" to media.id.toString())
        assertTrue("fixture removal must be accepted", outcome.optString("kind") == "Accepted")
    }

    fun logoutAndPurge() {
        val outcome = command("LogoutAndPurge")
        assertTrue("production logout must accept account purge", outcome.optString("kind") == "Accepted")
    }

    fun relaunchOfflineAndConnect(): JSONObject {
        loadOfflineShelf("account-purge shelf relaunch")
        installReporter()
        return connectOffline()
    }

    private fun loadOfflineShelf(description: String) {
        scenario.onActivity { activity -> activity.webView.loadUrl(OFFLINE_READING_MAIN_URL) }
        awaitOfflineShelf(description)
        assertTrue("offline verification must remain on the APK shelf", isOfflineShelf())
    }

    private fun loadHostedPage() {
        scenario.onActivity { activity -> activity.webView.loadUrl(BuildConfig.NEXUS_BASE_URL) }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(BRIDGE_REPLY_TIMEOUT_SECONDS)
        while (System.nanoTime() < deadline) {
            var url: String? = null
            scenario.onActivity { url = it.webView.url }
            val hosted = url == BuildConfig.NEXUS_BASE_URL ||
                url?.startsWith("${BuildConfig.NEXUS_BASE_URL}/") == true
            if (hosted) {
                return
            }
            reporter.nextReply(TimeUnit.MILLISECONDS.toNanos(250))
        }
        throw AssertionError("timed out waiting for the hosted release origin")
    }

    fun awaitSnapshot(description: String, predicate: (JSONObject) -> Boolean): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(SNAPSHOT_TIMEOUT_SECONDS)
        while (System.nanoTime() < deadline) {
            val outcome = command("GetSnapshot")
            if (outcome.optString("kind") == "Snapshot") {
                val snapshot = outcome.getJSONObject("snapshot")
                if (predicate(snapshot)) return snapshot
            } else {
                assertTrue(
                    "bridge lost its connected session while awaiting $description",
                    outcome.optString("kind") == "Rejected" && outcome.optString("code") == "NotConnected",
                )
            }
            reporter.nextReply(TimeUnit.MILLISECONDS.toNanos(250))
        }
        throw AssertionError("timed out waiting for $description")
    }

    private fun installReporter() {
        reporter.resetReady()
        val script = """
            (() => {
              const port = window.nexusOfflineReading;
              if (!port) return;
              port.onmessage = (event) => window.$REPORTER_NAME.reply(String(event.data));
              window.$REPORTER_NAME.ready();
            })();
        """.trimIndent()
        repeat(6) { attempt ->
            scenario.onActivity { activity ->
                activity.webView.addJavascriptInterface(reporter, REPORTER_NAME)
                // An injected interface only reaches documents loaded after the
                // call. If the document under test committed before this
                // registration, reload it once so the reporter exists in it.
                if (attempt == 1) activity.webView.reload()
                activity.webView.evaluateJavascript(script, null)
            }
            if (reporter.awaitReady(5)) return
        }
        throw AssertionError("production offline-reading bridge was not installed in the WebView")
    }

    private fun awaitOfflineShelf(description: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(BRIDGE_REPLY_TIMEOUT_SECONDS)
        while (System.nanoTime() < deadline) {
            if (isOfflineShelf()) return
            reporter.nextReply(TimeUnit.MILLISECONDS.toNanos(250))
        }
        throw AssertionError("timed out waiting for $description")
    }

    private fun command(kind: String, vararg fields: Pair<String, Any>): JSONObject {
        val requestId = UUID.randomUUID().toString()
        val command = JSONObject()
            .put("protocolVersion", 1)
            .put("requestId", requestId)
            .put("kind", kind)
        fields.forEach { (name, value) -> command.put(name, value) }
        evaluate("window.nexusOfflineReading.postMessage(${JSONObject.quote(command.toString())});")
        return awaitReply(requestId)
    }

    private fun evaluate(script: String) {
        scenario.onActivity { activity -> activity.webView.evaluateJavascript(script, null) }
    }

    private fun awaitReply(requestId: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(BRIDGE_REPLY_TIMEOUT_SECONDS)
        while (System.nanoTime() < deadline) {
            val raw = reporter.nextReply(deadline - System.nanoTime()) ?: break
            val message = runCatching { JSONObject(raw) }.getOrNull() ?: continue
            if (message.optString("requestId") == requestId) {
                return message.getJSONObject("outcome")
            }
        }
        throw AssertionError("production offline-reading bridge did not reply")
    }
}
