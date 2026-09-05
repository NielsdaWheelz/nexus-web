package app.nexus.android.offline.reading

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

internal sealed interface BindingSealStatus {
    data object Verified : BindingSealStatus
    data object Missing : BindingSealStatus
    data object Locked : BindingSealStatus
    data object Invalid : BindingSealStatus
}

internal enum class BindingReconciliationAction {
    Continue,
    DeferUntilUnlocked,
    Purge,
}

internal fun bindingReconciliationAction(status: BindingSealStatus): BindingReconciliationAction =
    when (status) {
        BindingSealStatus.Verified -> BindingReconciliationAction.Continue
        BindingSealStatus.Locked -> BindingReconciliationAction.DeferUntilUnlocked
        BindingSealStatus.Missing, BindingSealStatus.Invalid -> BindingReconciliationAction.Purge
    }

/**
 * A `setUnlockedDeviceRequired(true)` key used while the device is locked does not reliably
 * throw [UserNotAuthenticatedException]: depending on the platform version the Keystore
 * surfaces the device-locked condition as `InvalidKeyException`, `UnrecoverableKeyException`,
 * `ProviderException`, or a `KeyStoreException` cause. The seal cannot distinguish those from
 * one another on-device, so every key-use failure with the alias still present classifies as
 * `Locked` (defer, non-destructive). `Missing` remains reserved for an absent alias and
 * `Invalid` for a computed-but-mismatched seal — the only deterministic destructive-purge
 * evidence. A wrong `Locked` merely defers exposure until the next unlocked reconciliation;
 * a wrong `Invalid`/`Missing` destroys the user's offline shelf.
 */
internal fun bindingSealKeyUseStatus(error: Exception): BindingSealStatus {
    check(error !is RuntimeException || error is java.security.ProviderException) {
        "unexpected binding-seal programming error: $error"
    }
    return BindingSealStatus.Locked
}

/** The binding key exists but is unusable until the device unlocks: defer, never fail. */
internal class OfflineReadingBindingSealLockedException :
    IllegalStateException("offline reading device-binding key is locked until device unlock")

internal interface OfflineReadingBindingSealPort {
    fun create(bindingId: UUID, accountId: UUID): ByteArray
    fun verify(bindingId: UUID, accountId: UUID, expectedSeal: ByteArray): BindingSealStatus
    fun deleteKey()
}

internal class OfflineReadingBindingSeal(
    private val keyAlias: String = KEY_ALIAS,
) : OfflineReadingBindingSealPort {
    override fun create(bindingId: UUID, accountId: UUID): ByteArray =
        sign(requireKey(createIfMissing = true), bindingId, accountId)

    override fun verify(bindingId: UUID, accountId: UUID, expectedSeal: ByteArray): BindingSealStatus {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!keyStore.containsAlias(keyAlias)) return BindingSealStatus.Missing
        val key = try {
            keyStore.getKey(keyAlias, null) as? SecretKey
                ?: return BindingSealStatus.Invalid
        } catch (error: Exception) {
            return bindingSealKeyUseStatus(error)
        }
        val actual = try {
            sign(key, bindingId, accountId)
        } catch (error: Exception) {
            return bindingSealKeyUseStatus(error)
        }
        return if (MessageDigestCompat.isEqual(actual, expectedSeal)) {
            BindingSealStatus.Verified
        } else {
            BindingSealStatus.Invalid
        }
    }

    override fun deleteKey() {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(keyAlias)
    }

    private fun requireKey(createIfMissing: Boolean): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(keyAlias, null) as? SecretKey
        if (existing != null) return existing
        check(createIfMissing) { "offline reading device-binding key is missing" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                        keyAlias,
                        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
                    )
                        .apply {
                            // Offline reading requires API 34 (requireOfflineReadingSupported);
                            // the explicit check is what lint can see. The API predates 28.
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setUnlockedDeviceRequired(true)
                        }
                        .build()
                )
            }
            .generateKey()
    }

    private fun sign(key: SecretKey, bindingId: UUID, accountId: UUID): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(key)
            update("NexusOfflineReadingBinding\u0000".toByteArray(StandardCharsets.UTF_8))
            update(bindingId.toBytes())
            doFinal(accountId.toBytes())
        }

    private fun UUID.toBytes(): ByteArray = ByteBuffer.allocate(16)
        .putLong(mostSignificantBits)
        .putLong(leastSignificantBits)
        .array()

    private companion object {
        const val KEY_ALIAS = "nexus_offline_reading_binding_v1"
    }
}

private object MessageDigestCompat {
    fun isEqual(left: ByteArray, right: ByteArray): Boolean =
        java.security.MessageDigest.isEqual(left, right)
}
