package de.entencenter.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecureVaultHelper {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "entencenter_nas_vault_key_v1"
    private const val PREFS_VAULT = "entencenter_secure_vault"
    private const val KEY_MULTI_NAS_VAULT = "multi_nas_vault_v1"
    private const val PREFIX_V1 = "enc:v1:"
    private const val GCM_TAG_BITS = 128

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing?.secretKey != null) {
            return existing.secretKey
        }
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Software/TEE fallback automatically handled if StrongBox is unavailable
            builder.setUnlockedDeviceRequired(false)
        }
        keyGen.init(builder.build())
        return keyGen.generateKey()
    }

    fun isKeystoreAvailable(): Boolean {
        return try {
            getOrCreateKey()
            true
        } catch (_: Exception) {
            false
        }
    }

    fun encryptString(plaintext: String): String {
        if (plaintext.isEmpty()) return ""
        return try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)
            val ctB64 = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
            "$PREFIX_V1$ivB64:$ctB64"
        } catch (_: Exception) {
            ""
        }
    }

    fun decryptString(storedValue: String?): String {
        if (storedValue.isNullOrBlank()) return ""
        val trimmed = storedValue.trim()
        if (!trimmed.startsWith(PREFIX_V1)) {
            // Legacy unencrypted migration compatibility
            return trimmed
        }
        return try {
            val rest = trimmed.removePrefix(PREFIX_V1)
            val sep = rest.indexOf(':')
            if (sep <= 0) return ""
            val iv = Base64.decode(rest.substring(0, sep), Base64.NO_WRAP)
            val ciphertext = Base64.decode(rest.substring(sep + 1), Base64.NO_WRAP)
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }

    fun saveMultiNasVault(context: Context, jsonPayload: String?): Boolean {
        val clean = jsonPayload?.trim() ?: ""
        val prefs = context.getSharedPreferences(PREFS_VAULT, Context.MODE_PRIVATE)
        if (clean.isEmpty()) {
            prefs.edit().remove(KEY_MULTI_NAS_VAULT).apply()
            return true
        }
        val encrypted = encryptString(clean)
        if (encrypted.isEmpty()) return false
        prefs.edit().putString(KEY_MULTI_NAS_VAULT, encrypted).apply()
        return true
    }

    fun loadMultiNasVault(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_VAULT, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_MULTI_NAS_VAULT, "") ?: ""
        return decryptString(raw)
    }

    fun clearMultiNasVault(context: Context): Boolean {
        context.getSharedPreferences(PREFS_VAULT, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_MULTI_NAS_VAULT)
            .apply()
        return true
    }
}
