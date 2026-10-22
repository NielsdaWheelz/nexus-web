package app.nexus.android.offline

import android.net.Uri
import android.webkit.WebView
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One user-picked recovery document. Only this worker touches its output stream. */
internal class WritingExport(private val webView: WebView) {
    private class Document {
        val cancelled = AtomicBoolean(false)
        var stream: OutputStream? = null
        var nextChunk = 0
    }

    private val io = Executors.newSingleThreadExecutor()
    private var document: Document? = null

    fun open(uri: Uri, complete: (String?) -> Unit) {
        check(document == null)
        val current = Document()
        document = current
        perform(current, complete) {
            current.stream = webView.context.contentResolver.openOutputStream(uri, "wt")
                ?: throw IOException("No recovery document stream")
        }
    }

    fun chunk(index: Int, bytes: ByteArray, complete: (String?) -> Unit) {
        val current = document ?: return complete("Cancelled")
        perform(current, complete) {
            if (index != current.nextChunk) throw IllegalArgumentException("chunk order")
            current.stream?.write(bytes) ?: throw IOException("Recovery document is closed")
            current.nextChunk += 1
        }
    }

    fun finish(chunks: Int, complete: (String?) -> Unit) {
        val current = document ?: return complete("Cancelled")
        perform(current, complete) {
            if (chunks != current.nextChunk) throw IllegalArgumentException("chunk count")
            val stream = current.stream ?: throw IOException("Recovery document is closed")
            stream.flush()
            stream.close()
            current.stream = null
        }
    }

    private fun perform(current: Document, complete: (String?) -> Unit, work: () -> Unit) {
        io.execute {
            val error = try {
                if (current.cancelled.get()) "Cancelled" else {
                    work()
                    if (current.cancelled.get()) "Cancelled" else null
                }
            } catch (_: IOException) {
                "Storage"
            } catch (_: SecurityException) {
                "Storage"
            } catch (_: IllegalArgumentException) {
                "Invalid"
            }
            webView.post { complete(error) }
        }
    }

    fun cancel() {
        val current = document ?: return
        document = null
        current.cancelled.set(true)
        io.execute {
            try {
                current.stream?.close()
            } catch (_: IOException) {
                // A failed/cancelled partial file is never a completed recovery copy.
            } finally {
                current.stream = null
            }
        }
    }

    fun close() {
        cancel()
        io.shutdown()
    }
}
