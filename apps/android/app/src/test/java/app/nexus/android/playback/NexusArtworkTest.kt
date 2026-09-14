package app.nexus.android.playback

import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.net.URLEncoder
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@androidx.annotation.OptIn(UnstableApi::class)
class NexusArtworkTest {
    private val account = UUID.fromString("11111111-1111-4111-8111-111111111111")
    private val session = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val cookies = object : NexusCookieStore {
        override fun cookiesFor(url: String): String? = null
        override suspend fun install(url: String, setCookie: String) = Unit
        override fun flush() = Unit
    }

    @Test
    fun `preview cover uses its owned origin and changes metadata without replacing playback identity`() = runBlocking {
        val server = MockWebServer()
        val upstream = MockWebServer()
        server.enqueue(image("rotated-jpeg"))
        upstream.enqueue(image("rotated-jpeg"))
        server.start()
        upstream.start()
        val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
        try {
            val item = MediaItem.Builder().setMediaId("current-track")
                .setUri("https://audio.example/episode.mp3")
                .setMediaMetadata(MediaMetadata.Builder().setTitle("Episode").setArtist("Author").build()).build()
            player.setMediaItem(item, 17_000)
            player.playWhenReady = true
            val playbackState = player.playbackState
            var discontinuities = 0
            player.addListener(object : Player.Listener {
                override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                    discontinuities += 1
                }
            })
            val owner = NexusCurrentArtwork(player, this,
                NexusArtworkReader(NexusOriginClient(server.url("/").toString(), cookies), maxDimension = 6))
            val source = upstream.url("/cover.jpg?x=1&y=2").toString()
            owner.install(account, session, artworkSourceFromProxyPath(
                "/api/media/image?url=${URLEncoder.encode(source, "UTF-8")}"))
            coroutineContext[Job]!!.children.toList().joinAll()
            assertEquals("preview artwork bypassed its owned origin", 1, server.requestCount)
            assertEquals(0, upstream.requestCount)
            val request = server.takeRequest()
            assertEquals("/api/media/image", request.requestUrl!!.encodedPath)
            assertEquals(source, request.requestUrl!!.queryParameter("url"))
            val current = player.currentMediaItem!!
            assertEquals(item.mediaId, current.mediaId)
            assertEquals(item.localConfiguration, current.localConfiguration)
            assertEquals(17_000L, player.currentPosition)
            assertEquals(playbackState, player.playbackState)
            assertTrue(player.playWhenReady)
            assertEquals(0, discontinuities)
            assertEquals("Episode", current.mediaMetadata.title)
            assertEquals("Author", current.mediaMetadata.artist)
            assertNull(current.mediaMetadata.artworkUri)
            val encoded = requireNotNull(current.mediaMetadata.artworkData) { "current preview omitted its ready derivative" }
            val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
            try { assertEquals(2, decoded.width); assertEquals(6, decoded.height) }
            finally { decoded.recycle() }
            owner.clear()
            assertNull(player.currentMediaItem!!.mediaMetadata.artworkData)
        } finally { player.release(); server.shutdown(); upstream.shutdown() }
    }

    @Test
    fun `ordinary cover reaches only its validated owned origin and preserves the playing item`() = runBlocking {
        val origin = MockWebServer()
        val upstream = MockWebServer()
        origin.enqueue(image("rotated-jpeg"))
        // A direct-source regression can complete, so the oracle observes which
        // external authority received the request instead of hanging on setup.
        upstream.enqueue(image("rotated-jpeg"))
        origin.start()
        upstream.start()
        val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
        try {
            val item = MediaItem.Builder().setMediaId("ordinary-track")
                .setUri("https://audio.example/ordinary.mp3").build()
            player.setMediaItem(item, 19_000)
            player.playWhenReady = true
            val url = upstream.url("/cover.jpg?x=1&y=2").toString()
            val owner = NexusCurrentArtwork(player, this,
                NexusArtworkReader(NexusOriginClient(origin.url("/").toString(), cookies), maxDimension = 6))
            owner.install(account, session, NativeArtworkSource(url))
            coroutineContext[Job]!!.children.toList().joinAll()
            assertEquals("ordinary artwork bypassed its validated owned origin", 1, origin.requestCount)
            assertEquals("ordinary artwork reached the upstream from native", 0, upstream.requestCount)
            val request = origin.takeRequest()
            assertEquals("/api/media/image", request.requestUrl!!.encodedPath)
            assertEquals(url, request.requestUrl!!.queryParameter("url"))
            val current = player.currentMediaItem!!
            assertEquals(item.mediaId, current.mediaId)
            assertEquals(item.localConfiguration, current.localConfiguration)
            assertEquals(19_000L, player.currentPosition)
            assertTrue(player.playWhenReady)
            val encoded = requireNotNull(current.mediaMetadata.artworkData) { "ordinary cover omitted its admitted derivative" }
            val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
            try { assertEquals(2, decoded.width); assertEquals(6, decoded.height) }
            finally { decoded.recycle() }
            owner.clear()
            assertNull(player.currentMediaItem!!.mediaMetadata.artworkData)
        } finally { player.release(); origin.shutdown(); upstream.shutdown() }
    }

    @Test
    fun `exhausted current cover retries on reconnect and publishes a static first frame`() = runBlocking {
        val server = MockWebServer()
        val upstream = MockWebServer()
        // The actual Retry-After cannot fit the complete 30s read deadline.
        server.enqueue(MockResponse().setResponseCode(503).addHeader("Retry-After", "31"))
        server.enqueue(image("animated-gif"))
        upstream.enqueue(MockResponse().setResponseCode(503).addHeader("Retry-After", "31"))
        upstream.enqueue(image("animated-gif"))
        server.start()
        upstream.start()
        val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
        try {
            player.setMediaItem(MediaItem.Builder().setMediaId("current-track").setUri("https://audio.example/a").build())
            val owner = NexusCurrentArtwork(player, this,
                NexusArtworkReader(NexusOriginClient(server.url("/").toString(), cookies), maxDimension = 6))
            val source = upstream.url("/a.gif").toString()
            owner.install(account, session, artworkSourceFromProxyPath("/api/media/image?url=${URLEncoder.encode(source, "UTF-8")}"))
            coroutineContext[Job]!!.children.toList().joinAll()
            assertEquals("preview retry did not reach its owned origin", 1, server.requestCount)
            assertEquals(0, upstream.requestCount)
            assertNull(player.currentMediaItem!!.mediaMetadata.artworkData)
            owner.retry(account, session)
            coroutineContext[Job]!!.children.toList().joinAll()
            assertEquals("reconnect reused the failed current-track future", 2, server.requestCount)
            val encoded = requireNotNull(player.currentMediaItem!!.mediaMetadata.artworkData) { "reconnect did not install current artwork" }
            assertEquals("PNG", String(encoded.copyOfRange(1, 4), Charsets.US_ASCII))
            val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
            try {
                assertEquals(4, decoded.width); assertEquals(2, decoded.height)
                val pixel = decoded.getPixel(0, 0)
                assertTrue("animated cover omitted its red first frame", Color.red(pixel) > 200)
                assertTrue("animated cover selected its blue later frame", Color.blue(pixel) < 30)
            } finally { decoded.recycle() }
            owner.clear()
        } finally { player.release(); server.shutdown(); upstream.shutdown() }
    }

    @Test
    fun `old account completion cannot publish over a newer current track`() = runBlocking {
        val releaseOld = CountDownLatch(1)
        val releaseNew = CountDownLatch(1)
        val server = MockWebServer()
        val upstream = MockWebServer()
        upstream.enqueue(image("rotated-jpeg"))
        upstream.enqueue(image("animated-gif"))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val old = request.requestUrl!!.queryParameter("url")!!.endsWith("old")
                check((if (old) releaseOld else releaseNew).await(5, TimeUnit.SECONDS)) { "owned artwork response barrier timed out" }
                return image(if (old) "rotated-jpeg" else "animated-gif")
            }
        }
        server.start()
        upstream.start()
        val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
        try {
            val owner = NexusCurrentArtwork(player, this,
                NexusArtworkReader(NexusOriginClient(server.url("/").toString(), cookies), maxDimension = 6))
            player.setMediaItem(MediaItem.Builder().setMediaId("old-track").setUri("https://audio.example/old").build())
            val oldSource = upstream.url("/old").toString()
            owner.install(account, session, artworkSourceFromProxyPath("/api/media/image?url=${URLEncoder.encode(oldSource, "UTF-8")}"))
            withContext(Dispatchers.IO) { assertNotNull("old cover did not reach its owned origin", server.takeRequest(5, TimeUnit.SECONDS)) }
            owner.clear()
            player.setMediaItem(MediaItem.Builder().setMediaId("new-track").setUri("https://audio.example/new").build())
            val newSource = upstream.url("/new").toString()
            owner.install(UUID.randomUUID(), UUID.randomUUID(), artworkSourceFromProxyPath("/api/media/image?url=${URLEncoder.encode(newSource, "UTF-8")}"))
            releaseOld.countDown()
            withContext(Dispatchers.IO) { assertNotNull("new cover did not reach its owned origin", server.takeRequest(5, TimeUnit.SECONDS)) }
            assertEquals("new-track", player.currentMediaItem!!.mediaId)
            assertNull("old completion replaced the new track's missing cover", player.currentMediaItem!!.mediaMetadata.artworkData)
            owner.retry(account, session)
            assertEquals(2, server.requestCount)
            assertEquals(0, upstream.requestCount)
            releaseNew.countDown()
            coroutineContext[Job]!!.children.toList().joinAll()
            val encoded = requireNotNull(player.currentMediaItem!!.mediaMetadata.artworkData)
            val decoded = requireNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
            try { assertEquals(4, decoded.width); assertEquals(2, decoded.height) }
            finally { decoded.recycle() }
            owner.clear()
        } finally { releaseOld.countDown(); releaseNew.countDown(); player.release(); server.shutdown(); upstream.shutdown() }
    }

    private fun image(name: String): MockResponse {
        val root = File(System.getProperty("nexus.testdata.offlineReadingContract") ?: error("testdata root is missing")).parentFile
        val cases = JSONObject(File(root, "capacity/artwork.json").readText()).getJSONArray("cases")
        val fixture = (0 until cases.length()).map(cases::getJSONObject).single { it.getString("name") == name }
        return MockResponse().setBody(Buffer().write(Base64.getDecoder().decode(fixture.getString("base64"))))
            .addHeader("Content-Type", fixture.getString("type"))
            .addHeader("X-Nexus-Image-Width", fixture.getInt("width"))
            .addHeader("X-Nexus-Image-Height", fixture.getInt("height"))
    }
}
