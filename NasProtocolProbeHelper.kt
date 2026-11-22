package de.entencenter.app

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object NasProtocolProbeHelper {

    fun cleanHost(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ""
        val noScheme = trimmed.replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
        val hostPort = noScheme.substringBefore('/')
        return if (hostPort.startsWith("[")) {
            hostPort.substringAfter("[").substringBefore("]")
        } else {
            hostPort.substringBefore(":")
        }.trim()
    }

    fun isStrictPrivateOrLanIp(ip: String): Boolean {
        val clean = ip.trim().removePrefix("[").removeSuffix("]").lowercase(Locale.US)
        if (clean.isEmpty()) return false
        if (clean == "127.0.0.1" || clean == "::1" || clean.startsWith("127.")) return true
        if (clean.startsWith("10.") || clean.startsWith("192.168.") || clean.startsWith("169.254.")) return true
        if (clean.startsWith("172.")) {
            val parts = clean.split(".")
            val second = parts.getOrNull(1)?.toIntOrNull() ?: -1
            if (parts.size == 4 && second in 16..31) return true
        }
        return clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80:")
    }

    fun isLocalLanTargetStrict(hostname: String, resolvedIp: String?): Boolean {
        val lower = hostname.trim().removePrefix("[").removeSuffix("]").lowercase(Locale.US)
        if (
            lower == "localhost" ||
            lower.endsWith(".local") ||
            lower.endsWith(".box") ||
            lower.endsWith(".fritz.nas") ||
            lower.endsWith(".lan") ||
            lower.endsWith(".home")
        ) {
            return true
        }
        if (isStrictPrivateOrLanIp(lower)) return true
        if (!resolvedIp.isNullOrBlank() && isStrictPrivateOrLanIp(resolvedIp)) return true
        return false
    }

    private fun extractShareName(shareOrPath: String?): String {
        val cleaned = (shareOrPath ?: "").trim().replace('\\', '/').trimStart('/')
        if (cleaned.isEmpty()) return ""
        return cleaned.substringBefore('/').trim()
    }

    /**
     * Stellt sicher, dass SMB 2/3 niemals HTTP/HTTPS/WebUI/TR-064/WebDAV/App-Ports
     * (wie 80, 443, 3000, 8080, 49000, 49443) fälschlich als SMB-Socket nutzt.
     */
    fun sanitizeSmbPort(rawPort: Int?): Int {
        val p = rawPort ?: 445
        if (p <= 0 || p > 65535) return 445
        return when (p) {
            20, 21, 22, 23, 25, 80, 110, 143, 443, 465, 587, 990, 993, 995,
            3000, 3001, 3002, 3005, 5000, 5001, 5005, 5006, 8000, 8080, 8081,
            8443, 8888, 9000, 49000, 49443 -> 445
            else -> p
        }
    }

    private fun isoNowUtc(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    // -----------------------------------------------------------------------
    // Pure Kotlin MD4 + HMAC-MD5 + NTLMv2 for real SMB2/3 verification
    // -----------------------------------------------------------------------
    private fun md4(input: ByteArray): ByteArray {
        val bitLen = input.size.toLong() * 8L
        val padLen = (56 - ((input.size + 1) % 64) + 64) % 64
        val buf = ByteArray(input.size + 1 + padLen + 8)
        System.arraycopy(input, 0, buf, 0, input.size)
        buf[input.size] = 0x80.toByte()
        for (i in 0 until 8) {
            buf[buf.size - 8 + i] = ((bitLen ushr (i * 8)) and 0xFFL).toByte()
        }

        var a = 0x67452301
        var b = 0xEFCDAB89.toInt()
        var c = 0x98BADCFE.toInt()
        var d = 0x10325476

        fun rotl(x: Int, s: Int): Int = (x shl s) or (x ushr (32 - s))
        fun f(x: Int, y: Int, z: Int): Int = (x and y) or (x.inv() and z)
        fun g(x: Int, y: Int, z: Int): Int = (x and y) or (x and z) or (y and z)
        fun h(x: Int, y: Int, z: Int): Int = x xor y xor z

        val x = IntArray(16)
        var off = 0
        while (off < buf.size) {
            for (j in 0 until 16) {
                val idx = off + j * 4
                x[j] = (buf[idx].toInt() and 0xFF) or
                    ((buf[idx + 1].toInt() and 0xFF) shl 8) or
                    ((buf[idx + 2].toInt() and 0xFF) shl 16) or
                    ((buf[idx + 3].toInt() and 0xFF) shl 24)
            }
            val aa = a; val bb = b; val cc = c; val dd = d
            val s1 = intArrayOf(3, 7, 11, 19)
            for (k in 0 until 16) {
                val sh = s1[k % 4]
                when (k % 4) {
                    0 -> a = rotl(a + f(b, c, d) + x[k], sh)
                    1 -> d = rotl(d + f(a, b, c) + x[k], sh)
                    2 -> c = rotl(c + f(d, a, b) + x[k], sh)
                    else -> b = rotl(b + f(c, d, a) + x[k], sh)
                }
            }
            val r2 = intArrayOf(0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15)
            val s2 = intArrayOf(3, 5, 9, 13)
            for (k in 0 until 16) {
                val idx = r2[k]
                val sh = s2[k % 4]
                val k2 = 0x5A827999
                when (k % 4) {
                    0 -> a = rotl(a + g(b, c, d) + x[idx] + k2, sh)
                    1 -> d = rotl(d + g(a, b, c) + x[idx] + k2, sh)
                    2 -> c = rotl(c + g(d, a, b) + x[idx] + k2, sh)
                    else -> b = rotl(b + g(c, d, a) + x[idx] + k2, sh)
                }
            }
            val r3 = intArrayOf(0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15)
            val s3 = intArrayOf(3, 9, 11, 15)
            for (k in 0 until 16) {
                val idx = r3[k]
                val sh = s3[k % 4]
                val k3 = 0x6ED9EBA1
                when (k % 4) {
                    0 -> a = rotl(a + h(b, c, d) + x[idx] + k3, sh)
                    1 -> d = rotl(d + h(a, b, c) + x[idx] + k3, sh)
                    2 -> c = rotl(c + h(d, a, b) + x[idx] + k3, sh)
                    else -> b = rotl(b + h(c, d, a) + x[idx] + k3, sh)
                }
            }
            a += aa; b += bb; c += cc; d += dd
            off += 64
        }

        val out = ByteArray(16)
        val vals = intArrayOf(a, b, c, d)
        for (i in 0 until 4) {
            out[i * 4] = (vals[i] and 0xFF).toByte()
            out[i * 4 + 1] = ((vals[i] ushr 8) and 0xFF).toByte()
            out[i * 4 + 2] = ((vals[i] ushr 16) and 0xFF).toByte()
            out[i * 4 + 3] = ((vals[i] ushr 24) and 0xFF).toByte()
        }
        return out
    }

    private fun hmacMd5(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacMD5")
        mac.init(SecretKeySpec(key, "HmacMD5"))
        return mac.doFinal(data)
    }

    private fun writeUInt16LE(buf: ByteArray, off: Int, value: Int) {
        buf[off] = (value and 0xFF).toByte()
        buf[off + 1] = ((value ushr 8) and 0xFF).toByte()
    }

    private fun writeUInt32LE(buf: ByteArray, off: Int, value: Long) {
        buf[off] = (value and 0xFFL).toByte()
        buf[off + 1] = ((value ushr 8) and 0xFFL).toByte()
        buf[off + 2] = ((value ushr 16) and 0xFFL).toByte()
        buf[off + 3] = ((value ushr 24) and 0xFFL).toByte()
    }

    private fun writeUInt64LE(buf: ByteArray, off: Int, value: Long) {
        for (i in 0 until 8) {
            buf[off + i] = ((value ushr (i * 8)) and 0xFFL).toByte()
        }
    }

    private fun readUInt16LE(buf: ByteArray, off: Int): Int {
        return (buf[off].toInt() and 0xFF) or ((buf[off + 1].toInt() and 0xFF) shl 8)
    }

    private fun readUInt32LE(buf: ByteArray, off: Int): Long {
        return ((buf[off].toLong() and 0xFFL) or
            ((buf[off + 1].toLong() and 0xFFL) shl 8) or
            ((buf[off + 2].toLong() and 0xFFL) shl 16) or
            ((buf[off + 3].toLong() and 0xFFL) shl 24))
    }

    private fun readUInt64LE(buf: ByteArray, off: Int): Long {
        var acc = 0L
        for (i in 0 until 8) {
            acc = acc or ((buf[off + i].toLong() and 0xFFL) shl (i * 8))
        }
        return acc
    }

    private fun derLength(len: Int): ByteArray {
        return when {
            len < 128 -> byteArrayOf(len.toByte())
            len < 256 -> byteArrayOf(0x81.toByte(), len.toByte())
            else -> byteArrayOf(0x82.toByte(), ((len ushr 8) and 0xFF).toByte(), (len and 0xFF).toByte())
        }
    }

    private fun derWrap(tag: Int, content: ByteArray): ByteArray {
        val l = derLength(content.size)
        return byteArrayOf(tag.toByte()) + l + content
    }

    private fun buildNtlmType1(): ByteArray {
        val flags = 0x00000001L or 0x00000004L or 0x00000200L or 0x00008000L or 0x00080000L or 0x02000000L
        val buf = ByteArray(40)
        "NTLMSSP\u0000".toByteArray(Charsets.US_ASCII).copyInto(buf, 0)
        writeUInt32LE(buf, 8, 1L)
        writeUInt32LE(buf, 12, flags)
        buf[32] = 6; buf[33] = 1
        writeUInt16LE(buf, 34, 7601)
        writeUInt32LE(buf, 36, 0x0F000000L)
        return buf
    }

    private fun extractNbDomainFromTargetInfo(targetInfo: ByteArray): String {
        var pos = 0
        while (pos + 4 <= targetInfo.size) {
            val avId = readUInt16LE(targetInfo, pos)
            val avLen = readUInt16LE(targetInfo, pos + 2)
            pos += 4
            if (avId == 0) break
            if (pos + avLen > targetInfo.size) break
            if (avId == 2 && avLen > 0) {
                return String(targetInfo, pos, avLen, Charsets.UTF_16LE)
            }
            pos += avLen
        }
        return ""
    }

    private fun parseNtlmType2(secBuf: ByteArray): Triple<ByteArray, String, ByteArray>? {
        val sig = "NTLMSSP\u0000".toByteArray(Charsets.US_ASCII)
        var idx = -1
        for (i in 0..(secBuf.size - sig.size)) {
            var match = true
            for (j in sig.indices) {
                if (secBuf[i + j] != sig[j]) { match = false; break }
            }
            if (match) { idx = i; break }
        }
        if (idx < 0 || idx + 32 > secBuf.size) return null
        val msg = secBuf.copyOfRange(idx, secBuf.size)
        if (readUInt32LE(msg, 8) != 2L) return null
        val targetLen = readUInt16LE(msg, 12)
        val targetOff = readUInt32LE(msg, 16).toInt()
        val flags = readUInt32LE(msg, 20)
        val challenge = msg.copyOfRange(24, 32)
        var targetName = if (targetLen > 0 && targetOff + targetLen <= msg.size) {
            String(msg, targetOff, targetLen, if ((flags and 1L) != 0L) Charsets.UTF_16LE else Charsets.US_ASCII)
        } else ""
        var targetInfo = ByteArray(0)
        if (msg.size >= 48) {
            val infoLen = readUInt16LE(msg, 40)
            val infoOff = readUInt32LE(msg, 44).toInt()
            if (infoLen > 0 && infoOff + infoLen <= msg.size) {
                targetInfo = msg.copyOfRange(infoOff, infoOff + infoLen)
            }
        }
        if (targetName.isEmpty() && targetInfo.isNotEmpty()) {
            targetName = extractNbDomainFromTargetInfo(targetInfo)
        }
        return Triple(challenge, targetName, targetInfo)
    }

    private fun buildNtlmType3(
        username: String,
        password: String,
        domain: String,
        serverChallenge: ByteArray,
        targetName: String,
        targetInfo: ByteArray,
        forceEmptyDomain: Boolean = false
    ): ByteArray {
        val domStr = if (forceEmptyDomain) "" else domain.ifEmpty { targetName }
        val userBytes = username.toByteArray(Charsets.UTF_16LE)
        val domBytes = domStr.toByteArray(Charsets.UTF_16LE)
        val wsBytes = "ENTENCENTER".toByteArray(Charsets.UTF_16LE)

        val ntHash = md4(password.toByteArray(Charsets.UTF_16LE))
        val userDom = (username.uppercase(Locale.US) + domStr.uppercase(Locale.US)).toByteArray(Charsets.UTF_16LE)
        val ntlmv2Key = hmacMd5(ntHash, userDom)

        val fileTime = (System.currentTimeMillis() + 11644473600000L) * 10000L
        val clientChal = ByteArray(8).apply { SecureRandom().nextBytes(this) }

        val blobHeader = ByteArray(28)
        writeUInt32LE(blobHeader, 0, 0x00000101L)
        writeUInt64LE(blobHeader, 8, fileTime)
        clientChal.copyInto(blobHeader, 16)
        val infoBytes = if (targetInfo.isNotEmpty()) targetInfo else ByteArray(4)
        val blob = blobHeader + infoBytes + ByteArray(4)

        val ntProof = hmacMd5(ntlmv2Key, serverChallenge + blob)
        val ntResp = ntProof + blob
        val lmResp = hmacMd5(ntlmv2Key, serverChallenge + clientChal) + clientChal

        val headerLen = 72
        val oDom = headerLen
        val oUser = oDom + domBytes.size
        val oWs = oUser + userBytes.size
        val oLm = oWs + wsBytes.size
        val oNt = oLm + lmResp.size
        val total = oNt + ntResp.size

        val out = ByteArray(total)
        "NTLMSSP\u0000".toByteArray(Charsets.US_ASCII).copyInto(out, 0)
        writeUInt32LE(out, 8, 3L)
        writeUInt16LE(out, 12, lmResp.size); writeUInt16LE(out, 14, lmResp.size); writeUInt32LE(out, 16, oLm.toLong())
        writeUInt16LE(out, 20, ntResp.size); writeUInt16LE(out, 22, ntResp.size); writeUInt32LE(out, 24, oNt.toLong())
        writeUInt16LE(out, 28, domBytes.size); writeUInt16LE(out, 30, domBytes.size); writeUInt32LE(out, 32, if (domBytes.isNotEmpty()) oDom.toLong() else 0L)
        writeUInt16LE(out, 36, userBytes.size); writeUInt16LE(out, 38, userBytes.size); writeUInt32LE(out, 40, if (userBytes.isNotEmpty()) oUser.toLong() else 0L)
        writeUInt16LE(out, 44, wsBytes.size); writeUInt16LE(out, 46, wsBytes.size); writeUInt32LE(out, 48, oWs.toLong())
        writeUInt32LE(out, 56, 0L)
        // Unicode | NTLM | AlwaysSign | ExtendedSessionSecurity | NegotiateVersion
        writeUInt32LE(out, 60, 0x02088201L)
        out[64] = 6; out[65] = 1
        writeUInt16LE(out, 66, 7601)
        writeUInt32LE(out, 68, 0x0F000000L)
        domBytes.copyInto(out, oDom)
        userBytes.copyInto(out, oUser)
        wsBytes.copyInto(out, oWs)
        lmResp.copyInto(out, oLm)
        ntResp.copyInto(out, oNt)
        return out
    }

    private fun wrapNetBios(payload: ByteArray): ByteArray {
        val hdr = byteArrayOf(
            0x00,
            ((payload.size ushr 16) and 0xFF).toByte(),
            ((payload.size ushr 8) and 0xFF).toByte(),
            (payload.size and 0xFF).toByte()
        )
        return hdr + payload
    }

    private fun readNetBiosFrame(input: InputStream): ByteArray? {
        val hdr = ByteArray(4)
        var read = 0
        while (read < 4) {
            val r = input.read(hdr, read, 4 - read)
            if (r <= 0) return null
            read += r
        }
        val len = ((hdr[1].toInt() and 0xFF) shl 16) or ((hdr[2].toInt() and 0xFF) shl 8) or (hdr[3].toInt() and 0xFF)
        if (len <= 0 || len > 4 * 1024 * 1024) return null
        val body = ByteArray(len)
        var got = 0
        while (got < len) {
            val r = input.read(body, got, len - got)
            if (r <= 0) return null
            got += r
        }
        return body
    }

    private fun buildSmb2Header(
        command: Int,
        msgId: Long,
        sessionId: Long = 0L,
        treeId: Long = 0L,
        creditsRequested: Int = 32,
        creditCharge: Int = 1
    ): ByteArray {
        val h = ByteArray(64)
        h[0] = 0xFE.toByte(); h[1] = 'S'.code.toByte(); h[2] = 'M'.code.toByte(); h[3] = 'B'.code.toByte()
        writeUInt16LE(h, 4, 64)
        writeUInt16LE(h, 6, creditCharge)
        writeUInt16LE(h, 12, command)
        writeUInt16LE(h, 14, creditsRequested)
        writeUInt64LE(h, 24, msgId)
        writeUInt32LE(h, 36, treeId)
        writeUInt64LE(h, 40, sessionId)
        return h
    }

    private fun formatDialect(d: Int): String = when (d) {
        0x0202 -> "SMB 2.0.2"
        0x0210 -> "SMB 2.1"
        0x0300 -> "SMB 3.0"
        0x0302 -> "SMB 3.0.2"
        0x0311 -> "SMB 3.1.1"
        0x02FF -> "SMB 2.x"
        else -> "SMB 0x${d.toString(16)}"
    }

    private fun explainNtStatus(status: Long, shareName: String): String {
        val hex = "0x${status.toString(16).uppercase(Locale.US).padStart(8, '0')}"
        return when (status) {
            0xC000006DL, 0xC000006AL -> "SMB-Anmeldung abgelehnt ($hex): Benutzername oder Passwort falsch."
            0xC0000022L -> "SMB-Zugriff verweigert ($hex): Fehlendes NAS-Recht — in der FRITZ!Box unter System -> FRITZ!Box-Benutzer -> „Zugang zu NAS-Inhalten“ Lesen & Schreiben aktivieren und Schreibschutz/Zielordner (z. B. USB-Speicher) prüfen."
            0xC000000DL -> "SMB-Parameter vom Server abgelehnt ($hex) auf Freigabe „${shareName.ifBlank { "FRITZ.NAS" }}“."
            0xC00000CCL -> "SMB-Freigabe „$shareName“ nicht gefunden ($hex)."
            0xC0000034L -> "Pfad oder Ordner auf Freigabe „$shareName“ nicht gefunden ($hex)."
            0xC0000035L -> "Ordner existiert bereits ($hex)."
            0xC000007FL -> "Speicherplatz auf Freigabe „${shareName.ifBlank { "FRITZ.NAS" }}“ voll ($hex): Interner FRITZ!Box-Speicher ist stark begrenzt — bitte USB-Stick/Festplatte als Zielordner wählen."
            0xC00000A2L -> "Datenträger auf Freigabe „${shareName.ifBlank { "FRITZ.NAS" }}“ schreibgeschützt ($hex)."
            0xC0000072L, 0xC000006EL -> "SMB-Konto deaktiviert oder eingeschränkt ($hex)."
            0xC0000234L -> "SMB-Konto wegen Fehlversuchen vorübergehend gesperrt ($hex)."
            else -> "SMB-Fehler $hex bei Anmeldung oder Dateizugriff."
        }
    }

    private fun resolveEffectiveSmbUserCandidates(
        explicitUsername: String,
        password: String,
        resolvedIp: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): Pair<List<String>, Boolean> {
        val trimmed = explicitUsername.trim()
        if (password.isEmpty()) {
            return if (trimmed.isNotEmpty()) (listOf(trimmed) to false) else (emptyList<String>() to false)
        }
        // Auf FRITZ!Box (auch bei leerem oder ggf. von App-Profil übernommenem Namen) <User last="1"> aus login_sid.lua ermitteln
        val probe = try {
            FritzBoxSessionHelper.probeLoginSid(resolvedIp, allowLocalSelfSignedTls, configureTrust)
        } catch (_: Exception) {
            null
        }
        val fritzDetected = probe?.optBoolean("detected", false) == true
        val fritzUsers = LinkedHashSet<String>()
        if (fritzDetected && probe != null) {
            val lastUser = probe.optString("lastUser", "").trim()
            if (lastUser.isNotEmpty()) fritzUsers.add(lastUser)
            val arr = probe.optJSONArray("users")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val u = arr.optString(i, "").trim()
                    if (u.isNotEmpty()) fritzUsers.add(u)
                }
            }
        }

        if (trimmed.isNotEmpty()) {
            val ordered = LinkedHashSet<String>()
            val exactFritzMatch = fritzUsers.firstOrNull { it.equals(trimmed, ignoreCase = true) }
            if (exactFritzMatch != null) {
                ordered.add(exactFritzMatch)
            } else {
                ordered.add(trimmed)
                // Falls der explizite Name nicht in der FRITZ!Box-Benutzerliste steht (z. B. App-Profilname), FRITZ!Box-Benutzer als Fallback prüfen
                if (fritzDetected) {
                    fritzUsers.forEach { ordered.add(it) }
                }
            }
            return ordered.take(4) to fritzDetected
        }

        if (fritzDetected) {
            if (!fritzUsers.contains("ftpuser")) fritzUsers.add("ftpuser")
            return fritzUsers.take(4) to true
        }
        return (if (isStrictPrivateOrLanIp(resolvedIp)) listOf("ftpuser") else emptyList()) to false
    }

    private data class SmbSessionConn(
        val socket: Socket,
        val output: java.io.OutputStream,
        val input: BufferedInputStream,
        val sessionId: Long,
        val dialect: String,
        val dialectCode: Int,
        val maxTransactSize: Int,
        val effectiveUser: String,
        var nextMsgId: Long
    ) : java.io.Closeable {
        val cmdCreditCharge: Int get() = if (dialectCode == 0x0202) 0 else 1
        override fun close() {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun openAuthenticatedSmb2Session(
        resolvedIp: String,
        port: Int,
        username: String,
        password: String,
        domain: String,
        timeoutMs: Int,
        forceEmptyDomain: Boolean = false
    ): Triple<SmbSessionConn?, Long, String?> {
        val smbPort = sanitizeSmbPort(port)
        var sock: Socket? = null
        return try {
            sock = Socket().apply {
                soTimeout = timeoutMs
                connect(InetSocketAddress(resolvedIp, smbPort), timeoutMs)
            }
            val output = sock.getOutputStream()
            val input = BufferedInputStream(sock.getInputStream())

            // SMB 2.0.2 - 3.0.2 ohne SMB 3.1.1-Preauth-Contexts (0x0311 ohne Contexts erzeugt 0xC000000D)
            val dialects = intArrayOf(0x0202, 0x0210, 0x0300, 0x0302)
            val body = ByteArray(36 + dialects.size * 2)
            writeUInt16LE(body, 0, 36)
            writeUInt16LE(body, 2, dialects.size)
            writeUInt16LE(body, 4, 1)
            writeUInt32LE(body, 8, 0L)
            ByteArray(16).apply { SecureRandom().nextBytes(this) }.copyInto(body, 12)
            dialects.forEachIndexed { idx, d -> writeUInt16LE(body, 36 + idx * 2, d) }

            output.write(wrapNetBios(buildSmb2Header(0, 0L, creditsRequested = 1, creditCharge = 0) + body))
            output.flush()

            val resp = readNetBiosFrame(input) ?: run {
                sock.close()
                return Triple(null, 0xC0000001L, "Port $port liefert keine SMB 2/3-Antwort.")
            }
            if (resp.size >= 4 && resp[0] == 0xFF.toByte() && resp[1] == 'S'.code.toByte()) {
                sock.close()
                return Triple(null, 0xC0000001L, "Veraltetes SMB 1 erkannt — bitte SMB 2/3 aktivieren.")
            }
            if (resp.size < 70 || resp[0] != 0xFE.toByte() || resp[1] != 'S'.code.toByte()) {
                sock.close()
                return Triple(null, 0xC0000001L, "Port $port antwortet nicht als SMB 2/3-Server.")
            }
            val negStatus = readUInt32LE(resp, 8)
            if (negStatus != 0L) {
                sock.close()
                return Triple(null, negStatus, explainNtStatus(negStatus, ""))
            }
            val dialectCode = readUInt16LE(resp, 68)
            val dialect = formatDialect(dialectCode)
            val maxTransact = if (resp.size >= 96) {
                readUInt32LE(resp, 92).toInt().coerceIn(8192, 65536)
            } else 32768
            val charge = if (dialectCode == 0x0202) 0 else 1

            val spnego1 = derWrap(
                0x60,
                byteArrayOf(0x06, 0x06, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x02) +
                    derWrap(
                        0xA0,
                        derWrap(
                            0x30,
                            derWrap(0xA0, derWrap(0x30, byteArrayOf(0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0x82.toByte(), 0x37, 0x02, 0x02, 0x0A))) +
                                derWrap(0xA2, derWrap(0x04, buildNtlmType1()))
                        )
                    )
            )
            val ss1 = ByteArray(24)
            writeUInt16LE(ss1, 0, 25); ss1[3] = 1
            writeUInt16LE(ss1, 12, 88); writeUInt16LE(ss1, 14, spnego1.size)
            output.write(wrapNetBios(buildSmb2Header(1, 1L, creditCharge = charge) + ss1 + spnego1))
            output.flush()

            val resp1 = readNetBiosFrame(input) ?: run {
                sock.close()
                return Triple(null, 0xC0000001L, "Keine SMB Session-Antwort.")
            }
            val status1 = readUInt32LE(resp1, 8)
            val sessionId = readUInt64LE(resp1, 40)
            if (status1 == 0L) {
                return Triple(SmbSessionConn(sock, output, input, sessionId, dialect, dialectCode, maxTransact, username, 2L), 0L, null)
            }
            if (status1 != 0xC0000016L) {
                sock.close()
                return Triple(null, status1, explainNtStatus(status1, ""))
            }

            val off1 = readUInt16LE(resp1, 68)
            val len1 = readUInt16LE(resp1, 70)
            val sec1 = if (off1 >= 64 && off1 + len1 <= resp1.size) resp1.copyOfRange(off1, off1 + len1) else resp1.copyOfRange(64, resp1.size)
            val type2 = parseNtlmType2(sec1) ?: run {
                sock.close()
                return Triple(null, 0xC0000001L, "NTLM-Challenge fehlt.")
            }

            val type3 = buildNtlmType3(
                username = username.trim(),
                password = password,
                domain = domain.trim(),
                serverChallenge = type2.first,
                targetName = type2.second,
                targetInfo = type2.third,
                forceEmptyDomain = forceEmptyDomain
            )
            val spnego3 = derWrap(0xA1, derWrap(0x30, derWrap(0xA2, derWrap(0x04, type3))))
            val ss3 = ByteArray(24)
            writeUInt16LE(ss3, 0, 25); ss3[3] = 1
            writeUInt16LE(ss3, 12, 88); writeUInt16LE(ss3, 14, spnego3.size)
            output.write(wrapNetBios(buildSmb2Header(1, 2L, sessionId, creditCharge = charge) + ss3 + spnego3))
            output.flush()

            val resp2 = readNetBiosFrame(input) ?: run {
                sock.close()
                return Triple(null, 0xC0000001L, "Keine SMB Auth-Antwort.")
            }
            val status2 = readUInt32LE(resp2, 8)
            if (status2 != 0L) {
                sock.close()
                return Triple(null, status2, explainNtStatus(status2, ""))
            }
            Triple(SmbSessionConn(sock, output, input, sessionId, dialect, dialectCode, maxTransact, username.trim(), 3L), 0L, null)
        } catch (e: Exception) {
            try { sock?.close() } catch (_: Exception) {}
            Triple(null, 0xC0000001L, e.message ?: "SMB-Verbindungsfehler")
        }
    }

    private fun smb2TreeConnect(sess: SmbSessionConn, uncPath: String): Pair<Long?, Long> {
        val uncBytes = uncPath.toByteArray(Charsets.UTF_16LE)
        val tc = ByteArray(8)
        writeUInt16LE(tc, 0, 9)
        writeUInt16LE(tc, 4, 72)
        writeUInt16LE(tc, 6, uncBytes.size)
        val msgId = sess.nextMsgId++
        sess.output.write(wrapNetBios(buildSmb2Header(3, msgId, sess.sessionId, creditCharge = sess.cmdCreditCharge) + tc + uncBytes))
        sess.output.flush()
        val resp = readNetBiosFrame(sess.input) ?: return null to 0xC0000001L
        if (resp.size < 64) return null to 0xC0000001L
        val status = readUInt32LE(resp, 8)
        if (status != 0L) return null to status
        val treeId = readUInt32LE(resp, 36)
        return treeId to 0L
    }

    private fun smb2Create(
        sess: SmbSessionConn,
        treeId: Long,
        relWinPath: String,
        desiredAccess: Long,
        fileAttributes: Long,
        shareAccess: Long,
        createDisposition: Long,
        createOptions: Long
    ): Triple<ByteArray?, Long, Long> {
        val cleanRel = relWinPath.replace('/', '\\').trim('\\')
        val nameBytes = cleanRel.toByteArray(Charsets.UTF_16LE)
        // SMB2 CREATE fixed request = 56 bytes (StructureSize 57 -> NameOffset = 64 + 56 = 120)
        // Per MS-SMB2, Buffer must have at least 1 byte if NameLength is 0
        val bufBytes = if (nameBytes.isNotEmpty()) nameBytes else ByteArray(2)
        val body = ByteArray(56)
        writeUInt16LE(body, 0, 57) // StructureSize
        body[3] = 0x02 // RequestedOplockLevel = NONE (Wait: 0 = NONE, 2 = Level II; 0 is safest!)
        body[3] = 0x00
        writeUInt32LE(body, 4, 0x00000002L) // ImpersonationLevel = Impersonation
        writeUInt32LE(body, 24, desiredAccess)
        writeUInt32LE(body, 28, fileAttributes)
        writeUInt32LE(body, 32, shareAccess)
        writeUInt32LE(body, 36, createDisposition)
        writeUInt32LE(body, 40, createOptions)
        writeUInt16LE(body, 44, 120) // NameOffset MUST ALWAYS be 120 (64 + 56), even when NameLength == 0
        writeUInt16LE(body, 46, nameBytes.size) // NameLength

        val msgId = sess.nextMsgId++
        sess.output.write(wrapNetBios(buildSmb2Header(5, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body + bufBytes))
        sess.output.flush()
        val resp = readNetBiosFrame(sess.input) ?: return Triple(null, 0xC0000001L, 0L)
        if (resp.size < 64) return Triple(null, 0xC0000001L, 0L)
        val status = readUInt32LE(resp, 8)
        if (status != 0L || resp.size < 64 + 80) return Triple(null, status, 0L)
        val fileId = resp.copyOfRange(64 + 64, 64 + 80) // Offset 64 in CREATE response = FileId (16 bytes)
        val createAction = readUInt32LE(resp, 64 + 4)
        return Triple(fileId, 0L, createAction)
    }

    private data class SmbCreateStatResult(
        val fileId: ByteArray?,
        val status: Long,
        val createAction: Long,
        val endOfFile: Long
    )

    private fun smb2CreateStat(
        sess: SmbSessionConn,
        treeId: Long,
        relWinPath: String,
        desiredAccess: Long,
        fileAttributes: Long,
        shareAccess: Long,
        createDisposition: Long,
        createOptions: Long
    ): SmbCreateStatResult {
        val cleanRel = relWinPath.replace('/', '\\').trim('\\')
        val nameBytes = cleanRel.toByteArray(Charsets.UTF_16LE)
        val bufBytes = if (nameBytes.isNotEmpty()) nameBytes else ByteArray(2)
        val body = ByteArray(56)
        writeUInt16LE(body, 0, 57)
        body[3] = 0x00
        writeUInt32LE(body, 4, 0x00000002L)
        writeUInt32LE(body, 24, desiredAccess)
        writeUInt32LE(body, 28, fileAttributes)
        writeUInt32LE(body, 32, shareAccess)
        writeUInt32LE(body, 36, createDisposition)
        writeUInt32LE(body, 40, createOptions)
        writeUInt16LE(body, 44, 120)
        writeUInt16LE(body, 46, nameBytes.size)

        val msgId = sess.nextMsgId++
        sess.output.write(wrapNetBios(buildSmb2Header(5, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body + bufBytes))
        sess.output.flush()
        val resp = readNetBiosFrame(sess.input) ?: return SmbCreateStatResult(null, 0xC0000001L, 0L, 0L)
        if (resp.size < 64) return SmbCreateStatResult(null, 0xC0000001L, 0L, 0L)
        val status = readUInt32LE(resp, 8)
        if (status != 0L || resp.size < 64 + 80) return SmbCreateStatResult(null, status, 0L, 0L)
        val endOfFile = readUInt64LE(resp, 64 + 48).coerceAtLeast(0L)
        val fileId = resp.copyOfRange(64 + 64, 64 + 80)
        val createAction = readUInt32LE(resp, 64 + 4)
        return SmbCreateStatResult(fileId, 0L, createAction, endOfFile)
    }

    private fun smbRelWinPathForShare(cleanRemote: String, shareName: String): String {
        val norm = cleanRemote.trim().replace('\\', '/').replace(Regex("/+"), "/").ifBlank { "/" }
        val firstSeg = norm.trimStart('/').substringBefore('/').trim()
        val lowerPrefix = "/${shareName.lowercase(Locale.US)}"
        val rel = when {
            norm == "/" -> ""
            norm.lowercase(Locale.US) == lowerPrefix -> ""
            norm.lowercase(Locale.US).startsWith("$lowerPrefix/") ->
                norm.substring(lowerPrefix.length).trimStart('/')
            shareName.equals("FRITZ.NAS", ignoreCase = true) ->
                norm.trimStart('/')
            firstSeg.equals(shareName, ignoreCase = true) ->
                norm.trimStart('/').substringAfter('/', "")
            else ->
                norm.trimStart('/')
        }
        return rel.replace('/', '\\')
    }

    private fun smb2Close(sess: SmbSessionConn, treeId: Long, fileId: ByteArray) {
        try {
            val body = ByteArray(24)
            writeUInt16LE(body, 0, 24) // StructureSize
            fileId.copyInto(body, 8, 0, 16)
            val msgId = sess.nextMsgId++
            sess.output.write(wrapNetBios(buildSmb2Header(6, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body))
            sess.output.flush()
            readNetBiosFrame(sess.input)
        } catch (_: Exception) {
        }
    }

    private fun smb2WriteFile(
        sess: SmbSessionConn,
        treeId: Long,
        fileId: ByteArray,
        data: ByteArray,
        initialOffset: Long = 0L
    ): Long {
        if (data.isEmpty()) return 0L
        val maxChunk = minOf(sess.maxTransactSize, 32768).coerceIn(4096, 32768)
        var pos = 0
        while (pos < data.size) {
            val len = minOf(maxChunk, data.size - pos)
            val slice = if (pos == 0 && len == data.size) data else data.copyOfRange(pos, pos + len)
            // SMB2 WRITE fixed body = 48 bytes (StructureSize 49, DataOffset = 64 + 48 = 112)
            val body = ByteArray(48)
            writeUInt16LE(body, 0, 49)
            writeUInt16LE(body, 2, 112) // DataOffset
            writeUInt32LE(body, 4, slice.size.toLong()) // Length
            writeUInt64LE(body, 8, initialOffset + pos.toLong()) // Offset
            fileId.copyInto(body, 16, 0, 16)
            val msgId = sess.nextMsgId++
            sess.output.write(wrapNetBios(buildSmb2Header(9, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body + slice))
            sess.output.flush()
            val resp = readNetBiosFrame(sess.input) ?: return 0xC0000001L
            if (resp.size < 64) return 0xC0000001L
            val status = readUInt32LE(resp, 8)
            if (status != 0L) return status
            val written = if (resp.size >= 72) readUInt32LE(resp, 64 + 4).toInt() else slice.size
            pos += if (written > 0) written else slice.size
        }
        return 0L
    }

    private fun smb2ReadFile(
        sess: SmbSessionConn,
        treeId: Long,
        fileId: ByteArray,
        maxBytes: Int = 4 * 1024 * 1024
    ): Pair<ByteArray?, Long> {
        val out = ByteArrayOutputStream()
        val chunk = minOf(sess.maxTransactSize, 32768).coerceIn(4096, 32768)
        var offset = 0L
        while (out.size() < maxBytes) {
            val reqLen = minOf(chunk, maxBytes - out.size())
            // SMB2 READ fixed body = 48 bytes (StructureSize 49) + 1 byte buffer
            val body = ByteArray(49)
            writeUInt16LE(body, 0, 49)
            body[2] = 0x50 // Padding
            writeUInt32LE(body, 4, reqLen.toLong()) // Length
            writeUInt64LE(body, 8, offset) // Offset
            fileId.copyInto(body, 16, 0, 16)
            writeUInt32LE(body, 32, 1L) // MinimumCount
            val msgId = sess.nextMsgId++
            sess.output.write(wrapNetBios(buildSmb2Header(8, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body))
            sess.output.flush()
            val resp = readNetBiosFrame(sess.input) ?: return null to 0xC0000001L
            if (resp.size < 64) return null to 0xC0000001L
            val status = readUInt32LE(resp, 8)
            if (status == 0xC0000011L) { // STATUS_END_OF_FILE
                break
            }
            if (status != 0L || resp.size < 80) {
                return null to status
            }
            val dataOff = (resp[64 + 2].toInt() and 0xFF)
            val dataLen = readUInt32LE(resp, 64 + 4).toInt()
            if (dataLen <= 0 || dataOff < 64 || dataOff + dataLen > resp.size) {
                break
            }
            out.write(resp, dataOff, dataLen)
            offset += dataLen.toLong()
            if (dataLen < reqLen) break
        }
        return out.toByteArray() to 0L
    }

    private fun ensureSmbDirRecursiveHelper(
        sess: SmbSessionConn,
        treeId: Long,
        winRel: String
    ): Long {
        val segments = winRel.split('\\').filter { it.isNotBlank() }
        if (segments.isEmpty()) return 0L
        var acc = ""
        for (seg in segments) {
            acc = if (acc.isEmpty()) seg else "$acc\\$seg"
            val (existingFid, existSt, _) = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = acc,
                desiredAccess = 0x00100081L,
                fileAttributes = 0x00000010L,
                shareAccess = 0x00000007L,
                createDisposition = 1L,
                createOptions = 0x00000021L
            )
            if (existingFid != null) {
                smb2Close(sess, treeId, existingFid)
                if (existSt == 0L) continue
            }
            val (fid, st, _) = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = acc,
                desiredAccess = 0x00100001L,
                fileAttributes = 0x00000010L,
                shareAccess = 0x00000007L,
                createDisposition = 3L, // FILE_OPEN_IF
                createOptions = 0x00000021L
            )
            if (fid != null) smb2Close(sess, treeId, fid)
            if (st == 0L) continue
            val (fidFallback, stFallback, _) = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = acc,
                desiredAccess = 0x00120116L,
                fileAttributes = 0x00000010L,
                shareAccess = 0x00000007L,
                createDisposition = 2L, // FILE_CREATE
                createOptions = 0x00000001L
            )
            if (fidFallback != null) smb2Close(sess, treeId, fidFallback)
            if (stFallback != 0L && stFallback != 0xC0000035L) return stFallback
        }
        return 0L
    }

    private fun writeSmbFileBinary(
        sess: SmbSessionConn,
        treeId: Long,
        fileWinPath: String,
        bytes: ByteArray,
        offset: Long = 0L,
        appendChunk: Boolean = false,
        verifyReadback: Boolean = true
    ): Long {
        val disposition = if (appendChunk && offset > 0L) 3L else 5L // FILE_OPEN_IF for chunked append, FILE_OVERWRITE_IF for new/first chunk
        var (fid, cst, _) = smb2Create(
            sess = sess,
            treeId = treeId,
            relWinPath = fileWinPath,
            desiredAccess = 0x0012019FL,
            fileAttributes = 0x00000080L,
            shareAccess = 0x00000007L,
            createDisposition = disposition,
            createOptions = 0x00000060L // FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT
        )
        if (fid == null && (cst == 0xC000000DL || cst == 0xC00000BBL || cst == 0xC0000022L)) {
            val fb = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = fileWinPath,
                desiredAccess = 0x00120116L,
                fileAttributes = 0x00000080L,
                shareAccess = 0x00000007L,
                createDisposition = disposition,
                createOptions = 0x00000040L
            )
            fid = fb.first
            cst = fb.second
        }
        if (fid == null && (cst == 0xC000000DL || cst == 0xC0000022L)) {
            val fb2 = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = fileWinPath,
                desiredAccess = 0x40120080L, // GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE
                fileAttributes = 0x00000080L,
                shareAccess = 0x00000007L,
                createDisposition = disposition,
                createOptions = 0x00000040L
            )
            fid = fb2.first
            cst = fb2.second
        }
        if (fid == null || cst != 0L) {
            return if (cst != 0L) cst else 0xC0000001L
        }
        val wst = smb2WriteFile(sess, treeId, fid, bytes, offset)
        smb2Close(sess, treeId, fid)
        if (wst != 0L) return wst

        if (verifyReadback && !appendChunk && offset == 0L && bytes.isNotEmpty() && bytes.size <= 256 * 1024) {
            val (rfid, rst, _) = smb2Create(
                sess = sess,
                treeId = treeId,
                relWinPath = fileWinPath,
                desiredAccess = 0x00120089L, // FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE
                fileAttributes = 0x00000080L,
                shareAccess = 0x00000007L,
                createDisposition = 1L,
                createOptions = 0x00000060L
            )
            if (rfid != null && rst == 0L) {
                val (readBack, readSt) = smb2ReadFile(sess, treeId, rfid, bytes.size + 64)
                smb2Close(sess, treeId, rfid)
                if (readSt == 0L && readBack != null && readBack.isEmpty() && bytes.isNotEmpty()) {
                    return 0xC0000001L
                }
            }
        }
        return 0L
    }

    private fun smb2QueryDirectory(
        sess: SmbSessionConn,
        treeId: Long,
        dirFileId: ByteArray
    ): Pair<List<Triple<String, Boolean, Long>>, Long> {
        val pattern = "*".toByteArray(Charsets.UTF_16LE)
        val entries = mutableListOf<Triple<String, Boolean, Long>>()
        var first = true
        val maxBuf = minOf(sess.maxTransactSize, 32768).toLong()
        while (true) {
            // SMB2 QUERY_DIRECTORY fixed body = 32 bytes (StructureSize 33, FileNameOffset = 64 + 32 = 96)
            val body = ByteArray(32)
            writeUInt16LE(body, 0, 33)
            body[2] = 0x25 // FileIdBothDirectoryInformation
            body[3] = if (first) 0x01 else 0x00 // SMB2_RESTART_SCANS on first call
            first = false
            dirFileId.copyInto(body, 8, 0, 16)
            writeUInt16LE(body, 24, 96)
            writeUInt16LE(body, 26, pattern.size)
            writeUInt32LE(body, 28, maxBuf)

            val msgId = sess.nextMsgId++
            sess.output.write(wrapNetBios(buildSmb2Header(14, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body + pattern))
            sess.output.flush()
            val resp = readNetBiosFrame(sess.input) ?: return entries to 0xC0000001L
            if (resp.size < 64) return entries to 0xC0000001L
            val status = readUInt32LE(resp, 8)
            if (status == 0x80000006L || status == 0xC000000FL) {
                // STATUS_NO_MORE_FILES or STATUS_NO_SUCH_FILE
                break
            }
            if (status != 0L || resp.size < 72) {
                return entries to status
            }
            val outOff = readUInt16LE(resp, 64 + 2)
            val outLen = readUInt32LE(resp, 64 + 4).toInt()
            if (outOff < 64 || outOff + outLen > resp.size || outLen <= 0) break

            var pos = outOff
            val limit = outOff + outLen
            while (pos + 104 <= limit) {
                val nextOffset = readUInt32LE(resp, pos).toInt()
                val fileSize = readUInt64LE(resp, pos + 40)
                val attrs = readUInt32LE(resp, pos + 56)
                val nameLen = readUInt32LE(resp, pos + 60).toInt()
                if (nameLen > 0 && pos + 104 + nameLen <= limit) {
                    val name = String(resp, pos + 104, nameLen, Charsets.UTF_16LE).trim()
                    if (name.isNotEmpty() && name != "." && name != "..") {
                        val isDir = (attrs and 0x00000010L) != 0L
                        entries.add(Triple(name, isDir, fileSize))
                    }
                }
                if (nextOffset <= 0) break
                pos += nextOffset
            }
        }
        return entries to 0L
    }

    private data class SmbFsVolumeStats(
        val ok: Boolean,
        val totalBytes: Long,
        val freeBytes: Long,
        val usedBytes: Long
    )

    private fun smb2QueryFileSystemSize(
        sess: SmbSessionConn,
        treeId: Long,
        relWinPath: String = ""
    ): SmbFsVolumeStats? {
        val (dirFid, openSt, _) = smb2Create(
            sess = sess,
            treeId = treeId,
            relWinPath = relWinPath,
            desiredAccess = 0x00000080L, // FILE_READ_ATTRIBUTES
            fileAttributes = 0x00000010L, // FILE_ATTRIBUTE_DIRECTORY
            shareAccess = 0x00000007L,
            createDisposition = 1L, // FILE_OPEN
            createOptions = 0x00000001L // FILE_DIRECTORY_FILE
        )
        if (dirFid == null || openSt != 0L) return null
        try {
            // 7 = FileFsFullSizeInformation (32B), 3 = FileFsSizeInformation (24B)
            for (infoClass in intArrayOf(7, 3)) {
                val body = ByteArray(41) // 40 bytes fixed (StructureSize=41) + 1 byte empty InputBuffer
                writeUInt16LE(body, 0, 41)
                body[2] = 0x02 // SMB2_0_INFO_FILESYSTEM
                body[3] = infoClass.toByte()
                writeUInt32LE(body, 4, 64L) // OutputBufferLength
                dirFid.copyInto(body, 24, 0, 16)

                val msgId = sess.nextMsgId++
                sess.output.write(
                    wrapNetBios(
                        buildSmb2Header(16, msgId, sess.sessionId, treeId, creditCharge = sess.cmdCreditCharge) + body
                    )
                )
                sess.output.flush()
                val resp = readNetBiosFrame(sess.input) ?: continue
                if (resp.size < 72) continue
                val status = readUInt32LE(resp, 8)
                if (status != 0L) continue
                val outOff = readUInt16LE(resp, 64 + 2)
                val outLen = readUInt32LE(resp, 64 + 4).toInt()
                if (outOff < 64 || outOff + outLen > resp.size) continue

                if (infoClass == 7 && outLen >= 32) {
                    val totalUnits = readUInt64LE(resp, outOff)
                    val callerAvail = readUInt64LE(resp, outOff + 8)
                    val actualAvail = readUInt64LE(resp, outOff + 16)
                    val sectorsPerUnit = readUInt32LE(resp, outOff + 24)
                    val bytesPerSector = readUInt32LE(resp, outOff + 28)
                    val unitBytes = sectorsPerUnit * bytesPerSector
                    if (totalUnits > 0L && unitBytes > 0L) {
                        val availUnits = if (actualAvail > 0L) actualAvail else callerAvail
                        val totalBytes = totalUnits * unitBytes
                        val freeBytes = (availUnits * unitBytes).coerceIn(0L, totalBytes)
                        val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
                        return SmbFsVolumeStats(true, totalBytes, freeBytes, usedBytes)
                    }
                } else if (infoClass == 3 && outLen >= 24) {
                    val totalUnits = readUInt64LE(resp, outOff)
                    val availUnits = readUInt64LE(resp, outOff + 8)
                    val sectorsPerUnit = readUInt32LE(resp, outOff + 16)
                    val bytesPerSector = readUInt32LE(resp, outOff + 20)
                    val unitBytes = sectorsPerUnit * bytesPerSector
                    if (totalUnits > 0L && unitBytes > 0L) {
                        val totalBytes = totalUnits * unitBytes
                        val freeBytes = (availUnits * unitBytes).coerceIn(0L, totalBytes)
                        val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
                        return SmbFsVolumeStats(true, totalBytes, freeBytes, usedBytes)
                    }
                }
            }
            return null
        } finally {
            smb2Close(sess, treeId, dirFid)
        }
    }

    private fun queryBestSmbVolumeSize(
        sess: SmbSessionConn,
        treeId: Long,
        shareName: String,
        isFritz: Boolean
    ): SmbFsVolumeStats? {
        val rootStats = smb2QueryFileSystemSize(sess, treeId, "")
        // FRITZ!NAS liefert beim Root "/" mitunter nur den kleinen internen Flash-Speicher (< 256 MB)
        // statt des eingesteckten USB-Laufwerks -> in diesem Fall Top-Level-Unterordner abfragen!
        if (rootStats != null && (!isFritz || rootStats.totalBytes >= 512L * 1024L * 1024L)) {
            return rootStats
        }

        val (dirFid, openSt, _) = smb2Create(
            sess = sess,
            treeId = treeId,
            relWinPath = "",
            desiredAccess = 0x00100081L,
            fileAttributes = 0x00000010L,
            shareAccess = 0x00000007L,
            createDisposition = 1L,
            createOptions = 0x00000001L
        )
        if (dirFid == null || openSt != 0L) return rootStats
        val (topEntries, _) = smb2QueryDirectory(sess, treeId, dirFid)
        smb2Close(sess, treeId, dirFid)

        var bestChild: SmbFsVolumeStats? = null
        val seenSizes = HashSet<String>()
        var sumTotal = 0L
        var sumFree = 0L
        var largeUsbCount = 0

        for ((name, isDir, _) in topEntries) {
            if (!isDir) continue
            val lower = name.lowercase(Locale.US)
            if (lower.startsWith(".")) continue
            val childStats = smb2QueryFileSystemSize(sess, treeId, name)
            if (childStats != null && childStats.totalBytes > 0L) {
                if (bestChild == null || childStats.totalBytes > bestChild.totalBytes) {
                    bestChild = childStats
                }
                if (childStats.totalBytes >= 512L * 1024L * 1024L) {
                    val key = "${childStats.totalBytes}:${childStats.freeBytes}"
                    if (seenSizes.add(key)) {
                        sumTotal += childStats.totalBytes
                        sumFree += childStats.freeBytes
                        largeUsbCount++
                    }
                }
            }
        }

        // Falls auf Ebene 1 nur interner Speicher (< 512 MB) lag (z. B. USB unter Unterordner /FRITZ oder /USB), Ebene 2 prüfen
        if (largeUsbCount == 0 && topEntries.isNotEmpty()) {
            var checkedSubdirs = 0
            for ((name, isDir, _) in topEntries) {
                if (!isDir || name.startsWith(".") || checkedSubdirs >= 24) continue
                val (subFid, subOpen, _) = smb2Create(
                    sess = sess,
                    treeId = treeId,
                    relWinPath = name,
                    desiredAccess = 0x00100081L,
                    fileAttributes = 0x00000010L,
                    shareAccess = 0x00000007L,
                    createDisposition = 1L,
                    createOptions = 0x00000001L
                )
                if (subFid == null || subOpen != 0L) continue
                val (subEntries, _) = smb2QueryDirectory(sess, treeId, subFid)
                smb2Close(sess, treeId, subFid)
                for ((subName, subIsDir, _) in subEntries) {
                    if (!subIsDir || subName.startsWith(".") || checkedSubdirs >= 24) continue
                    checkedSubdirs++
                    val subPath = "$name\\$subName"
                    val subStats = smb2QueryFileSystemSize(sess, treeId, subPath) ?: continue
                    if (subStats.totalBytes <= 0L) continue
                    if (bestChild == null || subStats.totalBytes > bestChild.totalBytes) {
                        bestChild = subStats
                    }
                    if (subStats.totalBytes >= 512L * 1024L * 1024L) {
                        val key = "${subStats.totalBytes}:${subStats.freeBytes}"
                        if (seenSizes.add(key)) {
                            sumTotal += subStats.totalBytes
                            sumFree += subStats.freeBytes
                            largeUsbCount++
                        }
                    }
                }
            }
        }

        if (largeUsbCount > 1 && sumTotal > 0L) {
            val clampedFree = sumFree.coerceIn(0L, sumTotal)
            return SmbFsVolumeStats(true, sumTotal, clampedFree, (sumTotal - clampedFree).coerceAtLeast(0L))
        }
        return if (bestChild != null && (rootStats == null || bestChild.totalBytes > rootStats.totalBytes)) {
            bestChild
        } else {
            rootStats
        }
    }

    fun getSmbStorageVolumeStatsJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "FRITZ.NAS")

        if (hostname.isEmpty() || password.isEmpty()) {
            return JSONObject().put("ok", false)
                .put("error", "NAS-Host und Passwort für Speicherabfrage erforderlich.").toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject().put("ok", false)
                .put("error", "DNS fehlgeschlagen: ${e.message}").toString()
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject().put("ok", false)
                .put("error", "SMB-Speicherabfrage außerhalb des Heimnetzes erfordert VPN.").toString()
        }

        var (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 4500, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null && (authStatus == 0xC0000001L || (authErr?.contains("Timeout", true) == true))) {
            nudgeNasWakeChannels(resolvedIp, hostname, allowLocalSelfSignedTls, configureTrust)
            val retry = openBestSmbSessionWithRetries(
                hostname, resolvedIp, port, username, password, domain, 7500, allowLocalSelfSignedTls, configureTrust
            )
            sess = retry.first; authStatus = retry.second; authErr = retry.third
        }
        if (sess == null) {
            return JSONObject().put("ok", false)
                .put("error", authErr ?: explainNtStatus(authStatus, shareHint)).toString()
        }

        return sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false) ||
                FritzBoxSessionHelper.isLocalLanHost(hostname)
            val resolved = resolveSmbShareAndRelPath(s, hostname, resolvedIp, "/", shareHint, isFritz)
                ?: return@use JSONObject().put("ok", false)
                    .put("error", "SMB-Freigabe für Speicherabfrage nicht gefunden.").toString()
            val (shareName, tidRel) = resolved
            val stats = queryBestSmbVolumeSize(s, tidRel.first, shareName, isFritz)
            if (stats == null || !stats.ok || stats.totalBytes <= 0L) {
                return@use JSONObject().put("ok", false)
                    .put("shareName", shareName)
                    .put("error", "Dateisystemgröße wurde über SMB2 QUERY_INFO nicht gemeldet.").toString()
            }
            val usedPct = ((stats.usedBytes.toDouble() / stats.totalBytes.toDouble()) * 1000.0).toLong() / 10.0
            val freePct = (100.0 - usedPct).coerceAtLeast(0.0)
            JSONObject()
                .put("ok", true)
                .put("host", hostname)
                .put("shareName", shareName)
                .put("source", "smb2_query_info")
                .put("totalBytes", stats.totalBytes)
                .put("freeBytes", stats.freeBytes)
                .put("usedBytes", stats.usedBytes)
                .put("usedPercent", usedPct)
                .put("freePercent", freePct)
                .toString()
        }
    }

    private fun openBestSmbSessionWithRetries(
        hostname: String,
        resolvedIp: String,
        port: Int,
        explicitUsername: String,
        password: String,
        domain: String,
        timeoutMs: Int,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): Triple<SmbSessionConn?, Long, String?> {
        val (userCandidates, isFritz) = resolveEffectiveSmbUserCandidates(
            explicitUsername, password, resolvedIp, allowLocalSelfSignedTls, configureTrust
        )
        val usersToTry = if (userCandidates.isNotEmpty()) userCandidates else listOf(explicitUsername.trim())
        var lastStatus = 0xC000006DL
        var lastErr: String? = "SMB-Anmeldung erforderlich."

        for (u in usersToTry) {
            if (u.isBlank() || password.isEmpty()) continue
            val (sess1, st1, err1) = openAuthenticatedSmb2Session(
                resolvedIp, port, u, password, domain, timeoutMs, forceEmptyDomain = false
            )
            if (sess1 != null) return Triple(sess1, 0L, null)
            lastStatus = st1
            lastErr = err1
            // Bei 0xC000006D einmal mit leerer Domäne testen (AVM FRITZ!OS / Samba NTLMv2 Eigenheit)
            if (st1 == 0xC000006DL || st1 == 0xC000006AL) {
                val (sess2, st2, err2) = openAuthenticatedSmb2Session(
                    resolvedIp, port, u, password, "", timeoutMs, forceEmptyDomain = true
                )
                if (sess2 != null) return Triple(sess2, 0L, null)
                lastStatus = st2
                lastErr = err2
            }
        }
        if (isFritz && explicitUsername.isBlank() && password.isNotEmpty() && lastErr != null) {
            lastErr = "$lastErr (FRITZ!Box-Benutzername prüfen unter System -> FRITZ!Box-Benutzer)."
        }
        return Triple(null, lastStatus, lastErr)
    }

    private fun resolveSmbShareAndRelPath(
        sess: SmbSessionConn,
        hostname: String,
        resolvedIp: String,
        remotePath: String,
        explicitShareHint: String,
        isFritzHost: Boolean
    ): Pair<String, Pair<Long, String>>? {
        val cleanRemote = remotePath.trim().replace('\\', '/').replace(Regex("/+"), "/").ifBlank { "/" }
        val hintShare = extractShareName(explicitShareHint)
        val firstSeg = cleanRemote.trimStart('/').substringBefore('/').trim()
        val candidateShares = LinkedHashSet<String>()
        val fritzLike = isFritzHost ||
            firstSeg.equals("FRITZ", ignoreCase = true) ||
            firstSeg.equals("FRITZ.NAS", ignoreCase = true) ||
            hintShare.equals("FRITZ", ignoreCase = true) ||
            hintShare.equals("FRITZ.NAS", ignoreCase = true)
        if (fritzLike) {
            candidateShares.add("FRITZ.NAS")
        }
        if (hintShare.isNotEmpty() && !hintShare.equals("EntenCenter-Backend", ignoreCase = true) && !hintShare.equals("FRITZ", ignoreCase = true)) {
            candidateShares.add(hintShare)
        }
        if (firstSeg.isNotEmpty() && !firstSeg.equals("EntenCenter-Backend", ignoreCase = true) && !firstSeg.equals("FRITZ", ignoreCase = true)) {
            candidateShares.add(firstSeg)
        }
        listOf("FRITZ.NAS", "Medien", "Public", "NAS", "video", "data", "files", "share").forEach {
            candidateShares.add(it)
        }

        for (share in candidateShares) {
            val uncHost = if (hostname.contains('.') && !hostname.all { it.isDigit() || it == '.' }) hostname else resolvedIp
            val (tid, st) = smb2TreeConnect(sess, "\\\\$uncHost\\$share")
            if (tid != null && st == 0L) {
                val lowerPrefix = "/${share.lowercase(Locale.US)}"
                val rel = when {
                    cleanRemote == "/" -> ""
                    cleanRemote.lowercase(Locale.US) == lowerPrefix -> ""
                    cleanRemote.lowercase(Locale.US).startsWith("$lowerPrefix/") ->
                        cleanRemote.substring(lowerPrefix.length).trimStart('/')
                    share.equals("FRITZ.NAS", ignoreCase = true) ->
                        cleanRemote.trimStart('/')
                    firstSeg.equals(share, ignoreCase = true) ->
                        cleanRemote.trimStart('/').substringAfter('/', "")
                    else ->
                        cleanRemote.trimStart('/')
                }
                return share to (tid to rel.replace('/', '\\'))
            }
        }
        return null
    }

    fun browseSmbDirectoriesJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val rawPath = req.optString("path", "/").ifBlank { "/" }
        val remotePath = rawPath.trim().replace('\\', '/').replace(Regex("/+"), "/").let {
            if (it == "/") "/" else (if (it.startsWith("/")) it else "/$it").trimEnd('/')
        }
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "")

        if (hostname.isEmpty()) {
            return JSONObject().put("ok", false).put("source", "nas_template").put("entries", JSONArray())
                .put("warning", "Kein NAS-Hostname angegeben.").toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("source", "nas_template").put("entries", JSONArray())
                .put("warning", "DNS-Auflösung fehlgeschlagen: ${e.message ?: hostname}").toString()
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject().put("ok", false).put("source", "nas_template").put("entries", JSONArray())
                .put("warning", "SMB über öffentliches Internet blockiert — bitte VPN nutzen.").toString()
        }
        if (password.isEmpty()) {
            return JSONObject()
                .put("ok", true)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("currentPath", remotePath)
                .put("entries", JSONArray())
                .put("source", "nas_template")
                .put("requiresAuth", true)
                .put("writable", false)
                .put("warning", "Für den Live-SMB-Dateizugriff bitte Zugangsdaten (Benutzername & Passwort) eingeben.")
                .toString()
        }

        var (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 4500, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null && (authStatus == 0xC0000001L || (authErr?.contains("Timeout", true) == true || authErr?.contains("erreichbar", true) == true))) {
            // Bei möglichem Ruhemodus/Spin-Down: FRITZ!NAS / USB-Platte kurz anstoßen & mit Spin-Up-Timeout (8s) erneut versuchen
            nudgeNasWakeChannels(resolvedIp, hostname, allowLocalSelfSignedTls, configureTrust)
            val retry = openBestSmbSessionWithRetries(
                hostname, resolvedIp, port, username, password, domain, 8000, allowLocalSelfSignedTls, configureTrust
            )
            sess = retry.first
            authStatus = retry.second
            authErr = retry.third
        }
        if (sess == null) {
            return JSONObject()
                .put("ok", true)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("currentPath", remotePath)
                .put("entries", JSONArray())
                .put("source", "nas_template")
                .put("requiresAuth", authStatus == 0xC000006DL || authStatus == 0xC000006AL || authStatus == 0xC0000022L)
                .put("writable", false)
                .put("warning", authErr ?: explainNtStatus(authStatus, shareHint))
                .toString()
        }

        sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false) ||
                FritzBoxSessionHelper.isLocalLanHost(hostname) && shareHint.contains("FRITZ", true)
            val resolvedShare = resolveSmbShareAndRelPath(s, hostname, resolvedIp, remotePath, shareHint, isFritz)
                ?: return JSONObject()
                    .put("ok", true)
                    .put("host", hostname)
                    .put("protocol", "smb")
                    .put("currentPath", remotePath)
                    .put("entries", JSONArray())
                    .put("source", "nas_template")
                    .put("requiresAuth", false)
                    .put("writable", false)
                    .put("warning", "Keine erreichbare SMB-Freigabe (z. B. FRITZ.NAS oder Medien) gefunden.")
                    .toString()

            val (shareName, tidAndRel) = resolvedShare
            val (treeId, relWinPath) = tidAndRel

            val (dirFid, openSt, _) = smb2Create(
                sess = s,
                treeId = treeId,
                relWinPath = relWinPath,
                desiredAccess = 0x00100081L, // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
                fileAttributes = 0x00000010L, // FILE_ATTRIBUTE_DIRECTORY
                shareAccess = 0x00000007L, // READ | WRITE | DELETE
                createDisposition = 1L, // FILE_OPEN
                createOptions = 0x00000001L // FILE_DIRECTORY_FILE
            )
            if (dirFid == null || openSt != 0L) {
                return JSONObject()
                    .put("ok", true)
                    .put("host", hostname)
                    .put("protocol", "smb")
                    .put("currentPath", remotePath)
                    .put("entries", JSONArray())
                    .put("source", "nas_template")
                    .put("writable", false)
                    .put("warning", explainNtStatus(openSt, shareName))
                    .toString()
            }

            val (rawEntries, qStatus) = smb2QueryDirectory(s, treeId, dirFid)
            smb2Close(s, treeId, dirFid)

            // Schreibrechte per FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE testen
            val (writeProbeFid, writeProbeSt, _) = smb2Create(
                sess = s,
                treeId = treeId,
                relWinPath = relWinPath,
                desiredAccess = 0x00100086L,
                fileAttributes = 0x00000010L,
                shareAccess = 0x00000007L,
                createDisposition = 1L,
                createOptions = 0x00000021L
            )
            val writableConfirmed = writeProbeFid != null && writeProbeSt == 0L
            if (writeProbeFid != null) smb2Close(s, treeId, writeProbeFid)

            val entriesJson = JSONArray()
            val sorted = rawEntries.sortedWith(compareBy<Triple<String, Boolean, Long>> { !it.second }.thenBy { it.first.lowercase(Locale.US) })
            for ((name, isDir, size) in sorted) {
                val entryPath = if (remotePath == "/") "/$name" else "$remotePath/$name"
                val obj = JSONObject()
                    .put("name", name)
                    .put("path", entryPath)
                    .put("type", if (isDir) "directory" else "file")
                    .put("writable", writableConfirmed)
                    .put("recommended", name.equals("FRITZ", true) || name.equals("EntenCenter-Backend", true))
                if (!isDir && size >= 0) obj.put("sizeBytes", size)
                entriesJson.put(obj)
            }

            val parentPath = if (remotePath == "/") JSONObject.NULL else {
                val idx = remotePath.lastIndexOf('/')
                if (idx <= 0) "/" else remotePath.substring(0, idx)
            }
            val hasFritzDir = rawEntries.any { it.second && it.first.equals("FRITZ", true) }
            val recBackend = when {
                remotePath == "/" && hasFritzDir -> "/FRITZ/EntenCenter-Backend"
                remotePath == "/" -> "/EntenCenter-Backend"
                else -> "$remotePath/EntenCenter-Backend"
            }

            return JSONObject()
                .put("ok", true)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("smbShare", shareName)
                .put("effectiveUser", s.effectiveUser)
                .put("currentPath", remotePath)
                .put("parentPath", parentPath)
                .put("entries", entriesJson)
                .put("recommendedBackendPath", recBackend)
                .put("source", "smb_live")
                .put("liveFilesystem", true)
                .put("requiresAuth", false)
                .put("writable", writableConfirmed)
                .put(
                    "warning",
                    when {
                        qStatus != 0L -> explainNtStatus(qStatus, shareName)
                        !writableConfirmed -> "SMB-Freigabe „$shareName“ ist nur lesbar (NTSTATUS 0x${writeProbeSt.toString(16).uppercase(Locale.US)}). In der FRITZ!Box unter System -> FRITZ!Box-Benutzer Schreibrechte für NAS-Inhalte aktivieren."
                        else -> JSONObject.NULL
                    }
                )
                .toString()
        }
    }

    fun provisionSmbBackendJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val mode = if (req.optString("mode", "auto") == "manual") "manual" else "auto"
        val createSingleFolder = req.optBoolean("createSingleFolder", false)
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "")
        val rawTarget = req.optString("targetPath", "/EntenCenter-Backend").trim().replace('\\', '/').replace(Regex("/+"), "/")
        var chosenPath = if (rawTarget.isBlank() || rawTarget == "/") "/EntenCenter-Backend" else (if (rawTarget.startsWith("/")) rawTarget else "/$rawTarget").trimEnd('/')
        if (mode == "auto" && rawTarget.isBlank() && !createSingleFolder) {
            chosenPath = "/EntenCenter-Backend"
        }

        val subdirs = if (createSingleFolder) emptyList() else listOf("profiles", "media", "media/movies", "media/series", "config", "wal", "backups")
        val createdDirsArr = JSONArray().apply {
            put(chosenPath)
            subdirs.forEach { put("$chosenPath/$it") }
        }
        val createdFilesArr = if (createSingleFolder) JSONArray() else JSONArray().apply {
            put("$chosenPath/entencenter-backend.json")
            put("$chosenPath/docker-compose.yml")
            put("$chosenPath/start-entencenter.sh")
        }

        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("backendPath", chosenPath)
                .put("createdDirectories", createdDirsArr)
                .put("createdFiles", createdFilesArr)
                .put("remoteWriteOk", false)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put("message", "Lokale Storage-Bridge für \"$chosenPath\" aktiv.")
                .put("warning", "DNS fehlgeschlagen: ${e.message ?: hostname}")
                .toString()
        }

        if (password.isEmpty()) {
            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("backendPath", chosenPath)
                .put("createdDirectories", createdDirsArr)
                .put("createdFiles", createdFilesArr)
                .put("remoteWriteOk", false)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put("message", "Pfad \"$chosenPath\" in Storage-Bridge eingerichtet.")
                .put("warning", "Kein Passwort angegeben — zum direkten Schreiben auf SMB ($hostname) Passwort eingeben.")
                .toString()
        }

        var (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 4500, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null && (authStatus == 0xC0000001L || (authErr?.contains("Timeout", true) == true || authErr?.contains("erreichbar", true) == true))) {
            nudgeNasWakeChannels(resolvedIp, hostname, allowLocalSelfSignedTls, configureTrust)
            val retry = openBestSmbSessionWithRetries(
                hostname, resolvedIp, port, username, password, domain, 8000, allowLocalSelfSignedTls, configureTrust
            )
            sess = retry.first
            authStatus = retry.second
            authErr = retry.third
        }
        if (sess == null) {
            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("backendPath", chosenPath)
                .put("createdDirectories", createdDirsArr)
                .put("createdFiles", createdFilesArr)
                .put("remoteWriteOk", false)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put("message", "Storage-Bridge für \"$chosenPath\" aktiv.")
                .put("warning", authErr ?: explainNtStatus(authStatus, shareHint))
                .toString()
        }

        sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false)
            val resolvedShare = resolveSmbShareAndRelPath(s, hostname, resolvedIp, chosenPath, shareHint, isFritz)
                ?: return JSONObject()
                    .put("ok", true)
                    .put("mode", mode)
                    .put("host", hostname)
                    .put("protocol", "smb")
                    .put("backendPath", chosenPath)
                    .put("createdDirectories", createdDirsArr)
                    .put("createdFiles", createdFilesArr)
                    .put("remoteWriteOk", false)
                    .put("localBridgeReady", true)
                    .put("connectionKeptAlive", true)
                    .put("message", "Storage-Bridge für \"$chosenPath\" aktiv.")
                    .put("warning", "SMB-Freigabe auf $hostname nicht gefunden (prüfe Freigabe FRITZ.NAS / Schreibrechte).")
                    .toString()

            val (shareName, tidAndRel) = resolvedShare
            val (treeId, baseRelWinPath) = tidAndRel

            fun ensureSmbDirRecursive(winRel: String): Long {
                val segments = winRel.split('\\').filter { it.isNotBlank() }
                if (segments.isEmpty()) return 0L
                var acc = ""
                for (seg in segments) {
                    acc = if (acc.isEmpty()) seg else "$acc\\$seg"
                    val (existingFid, existSt, _) = smb2Create(
                        sess = s,
                        treeId = treeId,
                        relWinPath = acc,
                        desiredAccess = 0x00100081L, // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
                        fileAttributes = 0x00000010L,
                        shareAccess = 0x00000007L,
                        createDisposition = 1L, // FILE_OPEN
                        createOptions = 0x00000021L // FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT
                    )
                    if (existingFid != null) {
                        smb2Close(s, treeId, existingFid)
                        if (existSt == 0L) continue
                    }
                    val (fid, st, _) = smb2Create(
                        sess = s,
                        treeId = treeId,
                        relWinPath = acc,
                        desiredAccess = 0x00100001L, // FILE_LIST_DIRECTORY | SYNCHRONIZE (standard smbclient mkdir)
                        fileAttributes = 0x00000010L,
                        shareAccess = 0x00000007L,
                        createDisposition = 3L, // FILE_OPEN_IF
                        createOptions = 0x00000021L // FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT
                    )
                    if (fid != null) smb2Close(s, treeId, fid)
                    if (st == 0L) continue
                    val (fidFallback, stFallback, _) = smb2Create(
                        sess = s,
                        treeId = treeId,
                        relWinPath = acc,
                        desiredAccess = 0x00120116L,
                        fileAttributes = 0x00000010L,
                        shareAccess = 0x00000007L,
                        createDisposition = 2L, // FILE_CREATE
                        createOptions = 0x00000001L
                    )
                    if (fidFallback != null) smb2Close(s, treeId, fidFallback)
                    if (stFallback != 0L && stFallback != 0xC0000035L) return stFallback
                }
                return 0L
            }

            val rootMkStatus = ensureSmbDirRecursive(baseRelWinPath)
            if (rootMkStatus != 0L) {
                return JSONObject()
                    .put("ok", true)
                    .put("mode", mode)
                    .put("host", hostname)
                    .put("protocol", "smb")
                    .put("smbShare", shareName)
                    .put("backendPath", chosenPath)
                    .put("createdDirectories", createdDirsArr)
                    .put("createdFiles", createdFilesArr)
                    .put("remoteWriteOk", false)
                    .put("localBridgeReady", true)
                    .put("connectionKeptAlive", true)
                    .put("message", "Storage-Bridge für \"$chosenPath\" eingerichtet.")
                    .put("warning", "Ordner auf SMB-Freigabe „$shareName“ konnte nicht angelegt werden: ${explainNtStatus(rootMkStatus, shareName)}")
                    .toString()
            }

            if (createSingleFolder) {
                return JSONObject()
                    .put("ok", true)
                    .put("mode", mode)
                    .put("host", hostname)
                    .put("protocol", "smb")
                    .put("smbShare", shareName)
                    .put("backendPath", chosenPath)
                    .put("createdDirectories", createdDirsArr)
                    .put("createdFiles", createdFilesArr)
                    .put("remoteWriteOk", true)
                    .put("localBridgeReady", true)
                    .put("connectionKeptAlive", true)
                    .put("message", "Ordner \"$chosenPath\" direkt per SMB 2/3 auf „$shareName“ angelegt.")
                    .put("warning", JSONObject.NULL)
                    .toString()
            }

            for (sub in subdirs) {
                val subWin = if (baseRelWinPath.isEmpty()) sub.replace('/', '\\') else "$baseRelWinPath\\${sub.replace('/', '\\')}"
                ensureSmbDirRecursive(subWin)
            }

            val manifestJson = JSONObject()
                .put("app", "EntenCenter NAS Backend")
                .put("version", "1.0.0")
                .put("host", hostname)
                .put("protocol", "smb")
                .put("smbShare", shareName)
                .put("backendPath", chosenPath)
                .put("mode", mode)
                .put("createdAt", isoNowUtc())
                .toString(2)
            val composeText = "services:\n  entencenter-nas:\n    image: node:20-alpine\n    ports:\n      - \"3000:3000\"\n    volumes:\n      - .$chosenPath:/app/data/marcente-nas\n"
            val scriptText = "#!/usr/bin/env sh\nexport PORT=3000\nnpx tsx server.ts\n"

            var writeOk = true
            var writeErrStatus = 0L
            for ((fileName, content) in listOf(
                "entencenter-backend.json" to manifestJson,
                "docker-compose.yml" to composeText,
                "start-entencenter.sh" to scriptText
            )) {
                val fileWin = if (baseRelWinPath.isEmpty()) fileName else "$baseRelWinPath\\$fileName"
                val wst = writeSmbFileBinary(
                    sess = s,
                    treeId = treeId,
                    fileWinPath = fileWin,
                    bytes = content.toByteArray(Charsets.UTF_8),
                    verifyReadback = fileName == "entencenter-backend.json"
                )
                if (wst != 0L) {
                    writeOk = false
                    writeErrStatus = wst
                }
            }

            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("host", hostname)
                .put("protocol", "smb")
                .put("smbShare", shareName)
                .put("backendPath", chosenPath)
                .put("createdDirectories", createdDirsArr)
                .put("createdFiles", createdFilesArr)
                .put("remoteWriteOk", writeOk)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put(
                    "message",
                    if (writeOk) {
                        "EntenCenter-Backend inkl. Unterordnern & Dateien direkt per SMB 2/3 auf „$shareName“ ($chosenPath) geschrieben."
                    } else {
                        "Ordner angelegt, aber Dateischreiben fehlgeschlagen (${explainNtStatus(writeErrStatus, shareName)})."
                    }
                )
                .put("warning", if (writeOk) JSONObject.NULL else explainNtStatus(writeErrStatus, shareName))
                .toString()
        }
    }

    fun probeSmb23(
        hostname: String,
        resolvedIp: String,
        port: Int,
        isLan: Boolean,
        scope: String,
        username: String = "",
        password: String = "",
        domain: String = "",
        shareOrPath: String = "",
        timeoutMs: Int = 3500,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): JSONObject {
        val smbPort = sanitizeSmbPort(port)
        val t0 = System.currentTimeMillis()
        val out = JSONObject()
            .put("protocol", "smb")
            .put("port", smbPort)
            .put("priority", 1)
            .put("label", "SMB 2/3")
            .put("role", "file_access")
            .put("useTls", false)

        if (!isLan && scope != "vpn") {
            return out
                .put("tcpOpen", false)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("authAttempted", false)
                .put("blockedByVpnPolicy", true)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "SMB_INTERNET_BLOCKED")
                .put("message", "SMB über das öffentliche Internet ist blockiert. Nutze VPN oder WebDAV HTTPS / SFTP.")
                .put("warning", "Externes SMB ausschließlich über VPN erlaubt.")
        }

        val (effectiveUsers, isFritz) = resolveEffectiveSmbUserCandidates(
            username, password, resolvedIp, allowLocalSelfSignedTls, configureTrust
        )
        val hasCreds = effectiveUsers.isNotEmpty() && password.isNotEmpty()
        var socket: Socket? = null
        return try {
            if (!hasCreds) {
                socket = Socket().apply {
                    soTimeout = timeoutMs
                    connect(InetSocketAddress(resolvedIp, port), timeoutMs)
                }
                val output = socket.getOutputStream()
                val input = BufferedInputStream(socket.getInputStream())

                val dialects = intArrayOf(0x0202, 0x0210, 0x0300, 0x0302)
                val body = ByteArray(36 + dialects.size * 2)
                writeUInt16LE(body, 0, 36)
                writeUInt16LE(body, 2, dialects.size)
                writeUInt16LE(body, 4, 1)
                writeUInt32LE(body, 8, 0L)
                ByteArray(16).apply { SecureRandom().nextBytes(this) }.copyInto(body, 12)
                dialects.forEachIndexed { idx, d -> writeUInt16LE(body, 36 + idx * 2, d) }

                output.write(wrapNetBios(buildSmb2Header(0, 0L, creditsRequested = 1, creditCharge = 0) + body))
                output.flush()

                val resp = readNetBiosFrame(input) ?: return out
                    .put("tcpOpen", true)
                    .put("protocolVerified", false)
                    .put("authVerified", false)
                    .put("authAttempted", false)
                    .put("errorCode", "SMB_NO_RESPONSE")
                    .put("message", "Port $port liefert keine gültige SMB 2/3-Antwort.")

                if (resp.size >= 4 && resp[0] == 0xFF.toByte() && resp[1] == 'S'.code.toByte() && resp[2] == 'M'.code.toByte()) {
                    return out
                        .put("tcpOpen", true)
                        .put("protocolVerified", false)
                        .put("authVerified", false)
                        .put("authAttempted", false)
                        .put("smbDialect", "SMB 1.0 (Abgelehnt)")
                        .put("smb1Rejected", true)
                        .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                        .put("errorCode", "SMB1_REJECTED")
                        .put("message", "Veraltetes SMB 1 erkannt — aus Sicherheitsgründen blockiert. Bitte SMB 2/3 aktivieren.")
                }

                if (resp.size < 70 || resp[0] != 0xFE.toByte() || resp[1] != 'S'.code.toByte()) {
                    return out
                        .put("tcpOpen", true)
                        .put("protocolVerified", false)
                        .put("authVerified", false)
                        .put("authAttempted", false)
                        .put("errorCode", "NOT_SMB2_SERVER")
                        .put("message", "Port $port ist offen, antwortet aber nicht als SMB 2/3-Dienst.")
                }

                val negStatus = readUInt32LE(resp, 8)
                if (negStatus != 0L) {
                    return out
                        .put("tcpOpen", true)
                        .put("protocolVerified", false)
                        .put("authVerified", false)
                        .put("authAttempted", false)
                        .put("errorCode", "SMB_NEG_ERR")
                        .put("message", explainNtStatus(negStatus, ""))
                }

                val dialect = formatDialect(readUInt16LE(resp, 68))
                return out
                    .put("tcpOpen", true)
                    .put("protocolVerified", true)
                    .put("authVerified", false)
                    .put("authAttempted", false)
                    .put("smbDialect", dialect)
                    .put("smb1Rejected", false)
                    .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                    .put("message", "$dialect auf $hostname:$port bestätigt.")
            }

            val (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
                hostname, resolvedIp, smbPort, explicitUsername = username, password = password, domain = domain,
                timeoutMs = timeoutMs, allowLocalSelfSignedTls = allowLocalSelfSignedTls, configureTrust = configureTrust
            )
            val shareName = extractShareName(shareOrPath)
            if (sess == null) {
                return out
                    .put("tcpOpen", true)
                    .put("protocolVerified", true)
                    .put("authVerified", false)
                    .put("authAttempted", true)
                    .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                    .put("errorCode", "NTSTATUS_${authStatus.toString(16).uppercase(Locale.US)}")
                    .put("message", authErr ?: explainNtStatus(authStatus, shareName))
            }

            sess.use { s ->
                var shareVerified = false
                var shareWarn: String? = null
                val preferredShare = when {
                    shareName.isNotEmpty() && shareName != "/" && !shareName.equals("EntenCenter-Backend", true) && !shareName.equals("MediaServer", true) -> shareName
                    isFritz || hostname.contains("fritz", true) -> "FRITZ.NAS"
                    else -> ""
                }
                val uncHost = if (hostname.contains('.') && !hostname.all { it.isDigit() || it == '.' }) hostname else resolvedIp
                if (preferredShare.isNotEmpty()) {
                    val (tid, st) = smb2TreeConnect(s, "\\\\$uncHost\\$preferredShare")
                    if (tid != null && st == 0L) {
                        shareVerified = true
                    } else if (preferredShare != "FRITZ.NAS" && isFritz) {
                        val (ftid, fst) = smb2TreeConnect(s, "\\\\$uncHost\\FRITZ.NAS")
                        if (ftid != null && fst == 0L) shareVerified = true
                        else shareWarn = explainNtStatus(fst, "FRITZ.NAS")
                    } else {
                        shareWarn = explainNtStatus(st, preferredShare)
                    }
                } else {
                    val (ipcTid, ipcSt) = smb2TreeConnect(s, "\\\\$uncHost\\IPC$")
                    if (ipcTid != null && ipcSt == 0L) shareVerified = true
                }

                out
                    .put("tcpOpen", true)
                    .put("protocolVerified", true)
                    .put("authVerified", true)
                    .put("authAttempted", true)
                    .put("shareVerified", shareVerified)
                    .put("smbDialect", s.dialect)
                    .put("smb1Rejected", false)
                    .put("effectiveUser", s.effectiveUser)
                    .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                    .put("warning", shareWarn ?: JSONObject.NULL)
                    .put(
                        "message",
                        shareWarn ?: "${s.dialect} Anmeldung (${s.effectiveUser}) & ${if (preferredShare.isNotEmpty()) "Freigabe „$preferredShare“" else "Dateizugriff"} bestätigt."
                    )
            }
        } catch (e: Exception) {
            out
                .put("tcpOpen", false)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("authAttempted", hasCreds)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "SMB_UNREACHABLE")
                .put("message", "SMB-Port $port auf $hostname nicht erreichbar (${e.message ?: "Fehler"}).")
        } finally {
            try { socket?.close() } catch (_: Exception) {}
        }
    }

    fun probeSftp(hostname: String, resolvedIp: String, port: Int = 22, timeoutMs: Int = 2500): JSONObject {
        val t0 = System.currentTimeMillis()
        val out = JSONObject()
            .put("protocol", "sftp")
            .put("port", port)
            .put("priority", 3)
            .put("label", "SFTP / SSH")
            .put("role", "file_access")
            .put("useTls", true)

        var sock: Socket? = null
        return try {
            sock = Socket().apply {
                soTimeout = timeoutMs
                connect(InetSocketAddress(resolvedIp, port), timeoutMs)
            }
            val line = sock.getInputStream().bufferedReader(Charsets.UTF_8).readLine()?.trim() ?: ""
            val verified = line.startsWith("SSH-2.0-")
            out
                .put("tcpOpen", true)
                .put("protocolVerified", verified)
                .put("authVerified", false)
                .put("authAttempted", false)
                .put("serverBanner", line)
                .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                .put("errorCode", if (verified) JSONObject.NULL else "NOT_SSH2")
                .put("message", if (verified) "SFTP/SSH-2.0 bestätigt ($line)." else "Port $port liefert kein SSH-2.0 Banner.")
        } catch (e: Exception) {
            out
                .put("tcpOpen", false)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("authAttempted", false)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "SFTP_UNREACHABLE")
                .put("message", "SFTP-Port $port auf $hostname nicht erreichbar (${e.message ?: "Fehler"}). ")
        } finally {
            try { sock?.close() } catch (_: Exception) {}
        }
    }

    fun probeWebDav(
        hostname: String,
        port: Int,
        useTls: Boolean,
        path: String,
        username: String,
        password: String,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): JSONObject {
        val t0 = System.currentTimeMillis()
        val scheme = if (useTls) "https" else "http"
        val cleanPath = if (path.startsWith("/")) path else "/$path"
        val hasCreds = username.isNotBlank() && password.isNotEmpty()
        val out = JSONObject()
            .put("protocol", "webdav")
            .put("port", port)
            .put("priority", 2)
            .put("label", if (useTls) "WebDAV (HTTPS)" else "WebDAV (HTTP)")
            .put("role", "file_access")
            .put("useTls", useTls)

        return try {
            val conn = (URL("$scheme://$hostname:$port$cleanPath").openConnection() as HttpURLConnection).apply {
                configureTrust?.invoke(this)
                requestMethod = "OPTIONS"
                connectTimeout = 2800
                readTimeout = 2800
                instanceFollowRedirects = false
                if (hasCreds) {
                    val token = Base64.encodeToString("$username:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                    setRequestProperty("Authorization", "Basic $token")
                }
            }
            try {
                val code = conn.responseCode
                val davHdr = conn.getHeaderField("DAV") ?: ""
                val allowHdr = (conn.getHeaderField("Allow") ?: "").uppercase(Locale.US)
                val verified = davHdr.isNotEmpty() || allowHdr.contains("PROPFIND") || code == 207 || code == 401
                val mismatch = (code == 400 || code == 404) && !verified
                out
                    .put("tcpOpen", true)
                    .put("protocolVerified", verified)
                    .put("authVerified", hasCreds && verified && code in 200..299)
                    .put("authAttempted", hasCreds)
                    .put("endpointMismatch", mismatch)
                    .put("httpStatus", code)
                    .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                    .put("errorCode", if (code == 401) "WEBDAV_AUTH_REQUIRED" else if (!verified) "NOT_WEBDAV" else JSONObject.NULL)
                    .put(
                        "message",
                        when {
                            code == 401 -> "WebDAV ($scheme:$port) bestätigt — Zugangsdaten erforderlich."
                            verified -> "WebDAV ($scheme:$port) erfolgreich verifiziert (HTTP $code)."
                            else -> "Port $port liefert HTTP $code ohne WebDAV-Header."
                        }
                    )
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            out
                .put("tcpOpen", false)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("authAttempted", hasCreds)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "WEBDAV_UNREACHABLE")
                .put("message", "WebDAV ($scheme://$hostname:$port) nicht erreichbar (${e.message ?: "Fehler"}). ")
        }
    }

    fun probeFtps(
        hostname: String,
        resolvedIp: String,
        port: Int,
        isLan: Boolean,
        scope: String,
        username: String = "",
        password: String = ""
    ): JSONObject {
        val t0 = System.currentTimeMillis()
        val hasCreds = username.isNotBlank() && password.isNotEmpty()
        val out = JSONObject()
            .put("protocol", "ftps")
            .put("port", port)
            .put("priority", 4)
            .put("label", "FTP / FTPS")
            .put("role", "file_access")
            .put("useTls", port == 990)

        var sock: Socket? = null
        return try {
            sock = Socket().apply {
                soTimeout = 2500
                connect(InetSocketAddress(resolvedIp, port), 2500)
            }
            val reader = sock.getInputStream().bufferedReader(Charsets.UTF_8)
            val greet = reader.readLine() ?: ""
            val verified = greet.startsWith("220")
            if (!verified) {
                return out
                    .put("tcpOpen", true)
                    .put("protocolVerified", false)
                    .put("authVerified", false)
                    .put("authAttempted", false)
                    .put("errorCode", "NOT_FTP")
                    .put("message", "Port $port liefert kein FTP 220-Greeting.")
            }

            val writer = sock.getOutputStream().bufferedWriter(Charsets.UTF_8)
            writer.write("AUTH TLS\r\n"); writer.flush()
            val tlsResp = reader.readLine() ?: ""
            val hasTls = tlsResp.startsWith("234")
            if (!hasTls && !isLan && scope != "vpn" && hasCreds) {
                return out
                    .put("tcpOpen", true)
                    .put("protocolVerified", true)
                    .put("authVerified", false)
                    .put("authAttempted", false)
                    .put("blockedByVpnPolicy", true)
                    .put("errorCode", "FTP_PLAINTEXT_BLOCKED")
                    .put("message", "Unverschlüsseltes FTP über öffentliches Internet blockiert.")
            }
            writer.write("QUIT\r\n"); writer.flush()
            out
                .put("tcpOpen", true)
                .put("protocolVerified", true)
                .put("useTls", hasTls)
                .put("authVerified", false)
                .put("authAttempted", hasCreds)
                .put("serverBanner", greet)
                .put("latencyMs", (System.currentTimeMillis() - t0).coerceAtLeast(1L))
                .put("message", "${if (hasTls) "FTPS (TLS)" else "FTP"} auf Port $port bestätigt.")
        } catch (e: Exception) {
            out
                .put("tcpOpen", false)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("authAttempted", hasCreds)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "FTPS_UNREACHABLE")
                .put("message", "FTP/FTPS-Port $port nicht erreichbar (${e.message ?: "Fehler"}). ")
        } finally {
            try { sock?.close() } catch (_: Exception) {}
        }
    }

    fun probeUniversalNasJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): String {
        val started = System.currentTimeMillis()
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val rawHost = req.optString("host", "").trim()
        val hostname = cleanHost(rawHost)
        val requestedScope = req.optString("scope", "")
        val requestedProto = req.optString("protocol", "")
        val explicitPort = req.optInt("port", 0)
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val shareOrPath = req.optString("shareOrPath", "/")
        val domain = req.optString("domainOrWorkgroup", "")
        val useTls = if (req.has("useTls")) req.optBoolean("useTls", true) else true

        if (hostname.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("host", "")
                .put("userFriendlySummary", "Bitte gültige NAS-Adresse eingeben.")
                .put("resultsByPriority", JSONArray())
                .put("errors", JSONArray().put("Kein Hostname angegeben."))
                .put("executedOn", "android_native")
                .put("measuredAt", isoNowUtc())
                .put("durationMs", 1)
                .toString()
        }

        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("host", hostname)
                .put("resolvedIp", JSONObject.NULL)
                .put("isLan", isLocalLanTargetStrict(hostname, null))
                .put("scope", requestedScope.ifBlank { "lan" })
                .put("vpnRequiredForSmb", false)
                .put("detectedVendor", "standard_nas")
                .put("vendorLabel", "Standard-NAS")
                .put("entenCenterDetected", false)
                .put("resultsByPriority", JSONArray())
                .put("errors", JSONArray().put("DNS fehlgeschlagen: ${e.message ?: hostname}"))
                .put("userFriendlySummary", "DNS-Auflösung für \"$hostname\" fehlgeschlagen.")
                .put("executedOn", "android_native")
                .put("measuredAt", isoNowUtc())
                .put("durationMs", (System.currentTimeMillis() - started).coerceAtLeast(1L))
                .toString()
        }

        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        val scope = requestedScope.ifBlank { if (isLan) "lan" else "internet" }

        val pool = Executors.newFixedThreadPool(6)
        val smbPort = if (requestedProto == "smb" && explicitPort > 0) sanitizeSmbPort(explicitPort) else 445
        val davPort = if (requestedProto == "webdav" && explicitPort > 0) explicitPort else if (useTls) 5006 else 5005
        val sftpPort = if (requestedProto == "sftp" && explicitPort > 0) explicitPort else 22
        val ftpPort = if (requestedProto == "ftps" && explicitPort > 0) explicitPort else 21

        val fSmb = pool.submit<JSONObject> {
            probeSmb23(hostname, resolvedIp, smbPort, isLan, scope, username, password, domain, shareOrPath, 3500, allowLocalSelfSignedTls, configureTrust)
        }
        val fDav = pool.submit<JSONObject> {
            probeWebDav(hostname, davPort, useTls, shareOrPath, username, password, configureTrust)
        }
        val fSftp = pool.submit<JSONObject> { probeSftp(hostname, resolvedIp, sftpPort) }
        val fFtp = pool.submit<JSONObject> { probeFtps(hostname, resolvedIp, ftpPort, isLan, scope, username, password) }
        val fFritz = pool.submit<JSONObject?> {
            FritzBoxSessionHelper.probeLoginSid(resolvedIp, allowLocalSelfSignedTls, configureTrust)
        }

        val results = mutableListOf<JSONObject>()
        var smbRes = JSONObject()
        var fritzProbe: JSONObject? = null
        try {
            smbRes = fSmb.get(5200, TimeUnit.MILLISECONDS)
            results.add(smbRes)
            results.add(fDav.get(5000, TimeUnit.MILLISECONDS))
            results.add(fSftp.get(4000, TimeUnit.MILLISECONDS))
            results.add(fFtp.get(4000, TimeUnit.MILLISECONDS))
            fritzProbe = fFritz.get(3800, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
        } finally {
            pool.shutdownNow()
        }

        val isFritz = fritzProbe?.optBoolean("detected", false) == true || hostname.contains("fritz", true)
        var fritzTracks: JSONObject? = null
        if (isFritz) {
            var webAuth = false
            var webErr: String? = null
            if (fritzProbe?.optBoolean("detected", false) == true && (password.isNotEmpty() || !fritzProbe.optBoolean("requiresAuth", true))) {
                val sidRes = JSONObject(
                    FritzBoxSessionHelper.authenticateAndReuseSid(
                        JSONObject().put("host", hostname).put("username", username).put("password", password).put("useTls", useTls).toString(),
                        allowLocalSelfSignedTls,
                        configureTrust
                    )
                )
                webAuth = sidRes.optBoolean("ok", false)
                if (!webAuth) webErr = sidRes.optString("error", null)
            }
            val smbOk = smbRes.optBoolean("authVerified", false)
            val mismatchWarn = if (webAuth && !smbOk) {
                "WebUI Challenge-Response (SID) erfolgreich, aber direkter SMB-Dateizugriff (:445) fehlgeschlagen."
            } else null
            fritzTracks = JSONObject()
                .put("detected", true)
                .put("friendlyName", fritzProbe?.optString("friendlyName", "AVM FRITZ!Box") ?: "AVM FRITZ!Box")
                .put(
                    "webuiSid",
                    JSONObject()
                        .put("reachable", fritzProbe?.optBoolean("detected", false) ?: false)
                        .put("authenticated", webAuth)
                        .put("scheme", if (fritzProbe?.optBoolean("httpsAvailable", false) == true && useTls) "https" else "http")
                        .put("port", if (fritzProbe?.optBoolean("httpsAvailable", false) == true && useTls) 443 else 80)
                        .put("error", webErr ?: JSONObject.NULL)
                )
                .put(
                    "smbAccess",
                    JSONObject()
                        .put("reachable", smbRes.optBoolean("tcpOpen", false))
                        .put("protocolVerified", smbRes.optBoolean("protocolVerified", false))
                        .put("authVerified", smbOk)
                        .put("shareVerified", smbRes.optBoolean("shareVerified", false))
                        .put("dialect", smbRes.opt("smbDialect") ?: JSONObject.NULL)
                        .put("smb1Rejected", smbRes.optBoolean("smb1Rejected", false))
                        .put("shareName", extractShareName(shareOrPath).ifEmpty { "FRITZ.NAS" })
                        .put("error", if (smbOk) JSONObject.NULL else smbRes.optString("message", ""))
                        .put(
                            "permissionHint",
                            if (webAuth && !smbOk) "FRITZ!Box-Benutzer benötigt „Zugang zu NAS-Inhalten“ sowie SMBv2/3." else JSONObject.NULL
                        )
                )
                .put(
                    "tr064",
                    JSONObject()
                        .put("reachable", fritzProbe?.optBoolean("tr064Available", false) ?: false)
                        .put("port", 49000)
                        .put("useTls", false)
                        .put("friendlyName", fritzProbe?.opt("friendlyName") ?: JSONObject.NULL)
                )
                .put(
                    "upnpMediaOnly",
                    JSONObject()
                        .put("reachable", fritzProbe?.optBoolean("tr064Available", false) ?: false)
                        .put("port", 49000)
                        .put("mediaOnlyNote", "UPnP/DLNA dient ausschließlich zur Medienwiedergabe, nicht für direkten SMB-Dateizugriff.")
                )
                .put("mismatchWarning", mismatchWarn ?: JSONObject.NULL)
        }

        val sorted = results.sortedBy { it.optInt("priority", 99) }
        val arr = JSONArray().apply { sorted.forEach { put(it) } }
        val best = sorted.firstOrNull {
            it.optString("role") == "file_access" &&
                it.optBoolean("protocolVerified", false) &&
                !it.optBoolean("smb1Rejected", false) &&
                !it.optBoolean("blockedByVpnPolicy", false)
        }
        val vendor = if (isFritz) "avm_fritzbox" else "standard_nas"
        val vendorLabel = if (isFritz) "AVM FRITZ!Box / FRITZ!NAS" else "Standard-NAS"

        return JSONObject()
            .put("ok", best != null)
            .put("host", hostname)
            .put("resolvedIp", resolvedIp)
            .put("isLan", isLan)
            .put("scope", scope)
            .put("vpnRequiredForSmb", !isLan && scope != "vpn")
            .put("detectedVendor", vendor)
            .put("vendorLabel", vendorLabel)
            .put("entenCenterDetected", false)
            .put("recommendedProtocol", best?.optString("protocol") ?: JSONObject.NULL)
            .put("recommendedPort", best?.optInt("port") ?: JSONObject.NULL)
            .put("resultsByPriority", arr)
            .put("fritzTracks", fritzTracks ?: JSONObject.NULL)
            .put(
                "userFriendlySummary",
                if (best != null) {
                    "$vendorLabel ($resolvedIp): Empfohlen ${best.optString("label")} (:${best.optInt("port")})"
                } else {
                    "Kein verifiziertes NAS-Dateiprotokoll auf $hostname ($resolvedIp) gefunden."
                }
            )
            .put("errors", JSONArray())
            .put("measuredAt", isoNowUtc())
            .put("durationMs", (System.currentTimeMillis() - started).coerceAtLeast(1L))
            .put("executedOn", "android_native")
            .toString()
    }

    fun testSingleProtocolJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val protocol = req.optString("protocol", "smb").trim().lowercase(Locale.US)
        val rawHost = req.optString("host", "").trim()
        val hostname = cleanHost(rawHost)
        val port = req.optInt("port", 0)
        val scopeOverride = req.optString("scope", "")
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val shareOrPath = req.optString("shareOrPath", "/")
        val domain = req.optString("domainOrWorkgroup", "")
        val useTls = if (req.has("useTls")) req.optBoolean("useTls", true) else true

        if (hostname.isEmpty()) {
            val v = JSONObject()
                .put("protocol", protocol)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("message", "Kein NAS-Hostname angegeben.")
            return JSONObject()
                .put("ok", false)
                .put("verification", v)
                .put("error", "Kein NAS-Hostname angegeben.")
                .toString()
        }

        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            val msg = "DNS-Auflösung für \"$hostname\" fehlgeschlagen (${e.message ?: "Host unbekannt"})."
            val v = JSONObject()
                .put("protocol", protocol)
                .put("protocolVerified", false)
                .put("authVerified", false)
                .put("resolvedIp", JSONObject.NULL)
                .put("message", msg)
            return JSONObject()
                .put("ok", false)
                .put("verification", v)
                .put("error", msg)
                .toString()
        }

        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        val scope = scopeOverride.ifBlank { if (isLan) "lan" else "internet" }

        val res = when (protocol) {
            "smb" -> probeSmb23(hostname, resolvedIp, sanitizeSmbPort(port), isLan, scope, username, password, domain, shareOrPath, 3500, allowLocalSelfSignedTls, configureTrust)
            "webdav" -> probeWebDav(hostname, if (port > 0) port else if (useTls) 5006 else 5005, useTls, shareOrPath, username, password, configureTrust)
            "sftp" -> probeSftp(hostname, resolvedIp, if (port > 0) port else 22)
            "ftps" -> probeFtps(hostname, resolvedIp, if (port > 0) port else 21, isLan, scope, username, password)
            else -> {
                val full = JSONObject(probeUniversalNasJson(requestJson, allowLocalSelfSignedTls, configureTrust))
                val arr = full.optJSONArray("resultsByPriority")
                var match: JSONObject? = null
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i)
                        if (item?.optString("protocol") == protocol) {
                            match = item; break
                        }
                    }
                }
                (match ?: JSONObject()
                    .put("protocol", protocol)
                    .put("port", port)
                    .put("protocolVerified", false)
                    .put("authVerified", false)
                    .put("message", "Kein verifizierter $protocol-Endpunkt unter $hostname gefunden."))
                    .put("fritzTracks", full.opt("fritzTracks") ?: JSONObject.NULL)
            }
        }
        res.put("resolvedIp", resolvedIp).put("isLan", isLan)
        val protoOk = res.optBoolean("protocolVerified", false) &&
            !res.optBoolean("smb1Rejected", false) &&
            !res.optBoolean("blockedByVpnPolicy", false)
        val authOk = !res.optBoolean("authAttempted", false) || res.optBoolean("authVerified", false)
        val overallOk = protoOk && authOk
        val errMsg = if (overallOk) null else res.optString("message").ifBlank { "Protokollprüfung fehlgeschlagen." }
        return JSONObject()
            .put("ok", overallOk)
            .put("verification", res)
            .put("error", errMsg ?: JSONObject.NULL)
            .toString()
    }

    private fun normalizeMacAddress(raw: String?): String? {
        val hex = (raw ?: "").trim().replace(Regex("[^0-9a-fA-F]"), "")
        if (hex.length != 12) return null
        return (0 until 6).joinToString(":") { idx -> hex.substring(idx * 2, idx * 2 + 2).uppercase(Locale.US) }
    }

    private fun readArpMacForIp(ip: String): String? {
        if (ip.isBlank()) return null
        return try {
            val arp = File("/proc/net/arp")
            if (!arp.exists() || !arp.canRead()) return null
            var found: String? = null
            arp.forEachLine { line ->
                val cols = line.trim().split(Regex("\\s+"))
                if (cols.firstOrNull() == ip) {
                    val mac = cols.getOrNull(3) ?: ""
                    if (mac.isNotBlank() && mac != "00:00:00:00:00:00") {
                        found = normalizeMacAddress(mac)
                    }
                }
            }
            found
        } catch (_: Exception) {
            null
        }
    }

    private fun sendWakeOnLanMagicPackets(macAddress: String, targetIp: String?): Boolean {
        val cleanMac = normalizeMacAddress(macAddress) ?: return false
        val macBytes = cleanMac.split(":").map { it.toInt(16).toByte() }.toByteArray()
        val magic = ByteArray(6 + 16 * 6)
        for (i in 0 until 6) magic[i] = 0xFF.toByte()
        for (rep in 0 until 16) {
            macBytes.copyInto(magic, 6 + rep * 6)
        }

        val destinations = LinkedHashSet<InetAddress>()
        try { destinations.add(InetAddress.getByName("255.255.255.255")) } catch (_: Exception) {}
        if (!targetIp.isNullOrBlank()) {
            try { destinations.add(InetAddress.getByName(targetIp)) } catch (_: Exception) {}
            val parts = targetIp.split(".")
            if (parts.size == 4) {
                try { destinations.add(InetAddress.getByName("${parts[0]}.${parts[1]}.${parts[2]}.255")) } catch (_: Exception) {}
            }
        }
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces != null && ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                for (ifAddr in iface.interfaceAddresses) {
                    val bcast = ifAddr.broadcast
                    if (bcast is Inet4Address) destinations.add(bcast)
                }
            }
        } catch (_: Exception) {}

        var sentAny = false
        var sock: DatagramSocket? = null
        try {
            sock = DatagramSocket().apply { broadcast = true }
            for (burst in 0 until 3) {
                for (dest in destinations) {
                    for (port in intArrayOf(9, 7)) {
                        try {
                            sock.send(DatagramPacket(magic, magic.size, dest, port))
                            sentAny = true
                        } catch (_: Exception) {}
                    }
                }
                if (burst < 2) Thread.sleep(60)
            }
        } catch (_: Exception) {
        } finally {
            try { sock?.close() } catch (_: Exception) {}
        }
        return sentAny
    }

    private fun testTcpQuick(ip: String, port: Int, timeoutMs: Int): Pair<Boolean, Int?> {
        val t0 = System.currentTimeMillis()
        var s: Socket? = null
        return try {
            s = Socket()
            s.connect(InetSocketAddress(ip, port), timeoutMs)
            true to (System.currentTimeMillis() - t0).toInt().coerceAtLeast(1)
        } catch (_: Exception) {
            false to null
        } finally {
            try { s?.close() } catch (_: Exception) {}
        }
    }

    private fun nudgeNasWakeChannels(
        resolvedIp: String,
        hostname: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ) {
        val arpMac = readArpMacForIp(resolvedIp)
        if (!arpMac.isNullOrBlank()) {
            sendWakeOnLanMagicPackets(arpMac, resolvedIp)
        }
        try {
            FritzBoxSessionHelper.probeLoginSid(resolvedIp, allowLocalSelfSignedTls, configureTrust)
        } catch (_: Exception) {}
        testTcpQuick(resolvedIp, 80, 700)
        testTcpQuick(resolvedIp, 445, 700)
    }

    fun probeBridgeNasHealthJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val started = System.currentTimeMillis()
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val rawHost = req.optString("host", "").trim()
        val hostname = cleanHost(rawHost)
        val explicitPort = req.optInt("port", 0)
        if (hostname.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("status", "offline")
                .put("warning", "Keine NAS-Adresse konfiguriert.")
                .toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("host", hostname)
                .put("status", "offline")
                .put("warning", "DNS fehlgeschlagen: ${e.message ?: hostname}")
                .toString()
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject()
                .put("ok", false)
                .put("host", hostname)
                .put("status", "offline")
                .put("warning", "Direkt-Bridge im öffentlichen Netz nur per VPN erlaubt.")
                .toString()
        }

        val pool = Executors.newFixedThreadPool(5)
        val fSmb = pool.submit<Pair<Boolean, Int?>> { testTcpQuick(resolvedIp, 445, 1600) }
        val fFtp = pool.submit<Pair<Boolean, Int?>> { testTcpQuick(resolvedIp, 21, 1400) }
        val fDav = pool.submit<Pair<Boolean, Int?>> {
            val dPort = if (explicitPort in listOf(5005, 5006, 8080, 443, 80)) explicitPort else 5006
            testTcpQuick(resolvedIp, dPort, 1400)
        }
        val fEc = pool.submit<Boolean> {
            val checkPort = if (explicitPort in listOf(3000, 3001, 8080)) explicitPort else 3000
            val (open, _) = testTcpQuick(resolvedIp, checkPort, 900)
            if (!open) return@submit false
            try {
                val url = URL("http://$resolvedIp:$checkPort/api/nas/auth/bootstrap")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 900
                    readTimeout = 900
                    requestMethod = "GET"
                }
                val code = conn.responseCode
                val body = (if (code in 200..299) conn.inputStream else null)?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                code in 200..299 && body.contains("hasUsers")
            } catch (_: Exception) {
                false
            }
        }
        val fFritz = pool.submit<JSONObject?> {
            FritzBoxSessionHelper.probeLoginSid(resolvedIp, allowLocalSelfSignedTls, configureTrust)
        }

        var smbRes: Pair<Boolean, Int?> = false to null
        var ftpRes: Pair<Boolean, Int?> = false to null
        var davRes: Pair<Boolean, Int?> = false to null
        var ecReady = false
        var fritzProbe: JSONObject? = null
        try {
            smbRes = fSmb.get(2000, TimeUnit.MILLISECONDS)
            ftpRes = fFtp.get(1800, TimeUnit.MILLISECONDS)
            davRes = fDav.get(1800, TimeUnit.MILLISECONDS)
            ecReady = fEc.get(1800, TimeUnit.MILLISECONDS)
            fritzProbe = fFritz.get(2800, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
        } finally {
            pool.shutdownNow()
        }

        val fritzDetected = fritzProbe?.optBoolean("detected", false) == true
        val fritzHttp = fritzProbe?.optBoolean("httpAvailable", false) == true
        val fritzHttps = fritzProbe?.optBoolean("httpsAvailable", false) == true
        val tr064 = fritzProbe?.optBoolean("tr064Available", false) == true
        val discoveredMac = readArpMacForIp(resolvedIp)
        val isOnline = smbRes.first || fritzDetected || tr064 || ecReady || ftpRes.first || davRes.first
        val minLatency = listOfNotNull(smbRes.second, ftpRes.second, davRes.second).minOrNull()
            ?: if (isOnline) (System.currentTimeMillis() - started).toInt().coerceAtLeast(1) else null

        val transportLabel = when {
            ecReady -> "EntenCenter-Server (:3000)"
            fritzDetected && smbRes.first -> "FRITZ!NAS Direkt (SMB :445 + Web)"
            smbRes.first -> "SMB 2/3 Storage-Bridge (:445)"
            fritzDetected -> if (fritzHttp) "FRITZ!NAS Web (:80)" else "FRITZ!NAS Web (:443)"
            davRes.first -> "WebDAV Bridge"
            ftpRes.first -> "FTP/FTPS Bridge (:21)"
            else -> null
        }

        return JSONObject()
            .put("ok", isOnline)
            .put("status", if (isOnline) "online" else "sleeping")
            .put("host", hostname)
            .put("resolvedIp", resolvedIp)
            .put("latencyMs", minLatency ?: JSONObject.NULL)
            .put("smbOpen", smbRes.first)
            .put("ftpOpen", ftpRes.first)
            .put("fritzDetected", fritzDetected)
            .put("fritzHttpAvailable", fritzHttp)
            .put("fritzHttpsAvailable", fritzHttps)
            .put("tr064Available", tr064)
            .put("entenCenterReady", ecReady)
            .put("friendlyName", fritzProbe?.opt("friendlyName") ?: JSONObject.NULL)
            .put("discoveredMac", discoveredMac ?: JSONObject.NULL)
            .put("transportLabel", transportLabel ?: JSONObject.NULL)
            .put(
                "warning",
                if (isOnline) JSONObject.NULL else "NAS antwortet nicht — möglicherweise im Ruhemodus / Standby."
            )
            .toString()
    }

    fun wakeNasDeviceJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val started = System.currentTimeMillis()
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val rawHost = req.optString("host", "").trim()
        val hostname = cleanHost(rawHost).ifBlank { "fritz.box" }
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val explicitMac = normalizeMacAddress(req.optString("macAddress", ""))
        val useTls = req.optBoolean("useTls", false)

        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (_: Exception) {
            hostname
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject()
                .put("ok", false)
                .put("wokeUp", false)
                .put("status", "offline")
                .put("message", "Aufwecken (Wake-on-LAN / Storage-Wake) ist nur im Heimnetz (LAN) oder per VPN zulässig.")
                .toString()
        }

        val channels = JSONArray()
        val arpMac = readArpMacForIp(resolvedIp)
        val effectiveMac = explicitMac ?: arpMac
        if (!effectiveMac.isNullOrBlank()) {
            if (sendWakeOnLanMagicPackets(effectiveMac, resolvedIp)) {
                channels.put("Wake-on-LAN Magic Packet (UDP :9/:7 · $effectiveMac)")
            }
        }

        // 2. FRITZ!Box TR-064 & Web-API USB/NAS Spin-Up Wake
        val fritzProbe = try {
            FritzBoxSessionHelper.probeLoginSid(resolvedIp, allowLocalSelfSignedTls, configureTrust)
        } catch (_: Exception) {
            null
        }
        var fritzWebReady = fritzProbe?.optBoolean("detected", false) == true
        var smbSpinUpOk = false

        if (fritzWebReady) {
            channels.put("FRITZ!Box HTTP/TR-064 Signal")
            if (password.isNotEmpty()) {
                try {
                    val browseRes = JSONObject(
                        FritzBoxSessionHelper.browseFritzNasDirectories(
                            JSONObject()
                                .put("host", hostname)
                                .put("username", username)
                                .put("password", password)
                                .put("useTls", useTls)
                                .put("path", "/")
                                .toString(),
                            allowLocalSelfSignedTls,
                            configureTrust
                        )
                    )
                    if (browseRes.optString("source") == "fritz_nas_api" || browseRes.optString("source") == "smb_live") {
                        fritzWebReady = true
                        channels.put("FRITZ!NAS USB-Speicher Spin-Up")
                    }
                } catch (_: Exception) {}
            }
            // Falls MAC bekannt + FRITZ!Box TR-064 aktiv: zusätzlich TR-064 WakeOnLANByMACAddress anfragen
            if (!effectiveMac.isNullOrBlank() && fritzProbe?.optBoolean("tr064Available", false) == true) {
                try {
                    val soap = """<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_AVM-DE_WakeOnLANByMACAddress xmlns:u="urn:dslforum-org:service:Hosts:1"><NewMACAddress>$effectiveMac</NewMACAddress></u:X_AVM-DE_WakeOnLANByMACAddress></s:Body></s:Envelope>"""
                    val url = URL("http://$resolvedIp:49000/upnp/control/hosts")
                    val conn = (url.openConnection() as HttpURLConnection).apply {
                        connectTimeout = 1500
                        readTimeout = 1500
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "text/xml; charset=utf-8")
                        setRequestProperty("SOAPACTION", "\"urn:dslforum-org:service:Hosts:1#X_AVM-DE_WakeOnLANByMACAddress\"")
                    }
                    conn.outputStream.use { it.write(soap.toByteArray(Charsets.UTF_8)) }
                    conn.responseCode
                    conn.disconnect()
                    channels.put("FRITZ!Box TR-064 WakeOnLAN")
                } catch (_: Exception) {}
            }
        }

        // 3. SMB2 (:445) mit verlängertem USB-Spin-Up-Timeout (bis 8.5s) anstoßen und prüfen
        val (smbTcpOpen, _) = testTcpQuick(resolvedIp, 445, 2200)
        if (smbTcpOpen || channels.length() > 0) {
            val smbProbe = probeSmb23(
                hostname = hostname,
                resolvedIp = resolvedIp,
                port = 445,
                isLan = isLan,
                scope = "lan",
                username = username,
                password = password,
                shareOrPath = "FRITZ.NAS",
                timeoutMs = 8500,
                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                configureTrust = configureTrust
            )
            if (smbProbe.optBoolean("protocolVerified", false)) {
                smbSpinUpOk = true
                channels.put("SMB 2/3 Storage-Wake (:445)")
            }
        }

        // Kurzes Nach-Polling falls der Host gerade über WoL hochfährt
        var health = JSONObject(
            probeBridgeNasHealthJson(
                JSONObject().put("host", hostname).toString(),
                allowLocalSelfSignedTls,
                configureTrust
            )
        )
        if (!health.optBoolean("ok", false) && !effectiveMac.isNullOrBlank()) {
            for (waitStep in 0 until 2) {
                try { Thread.sleep(1500) } catch (_: Exception) {}
                health = JSONObject(
                    probeBridgeNasHealthJson(
                        JSONObject().put("host", hostname).toString(),
                        allowLocalSelfSignedTls,
                        configureTrust
                    )
                )
                if (health.optBoolean("ok", false)) break
            }
        }

        val isNowOnline = health.optBoolean("ok", false) || smbSpinUpOk || fritzWebReady
        val latencyMs = if (health.has("latencyMs") && !health.isNull("latencyMs")) {
            health.optInt("latencyMs")
        } else {
            (System.currentTimeMillis() - started).toInt().coerceAtLeast(1)
        }
        val status = when {
            isNowOnline -> "online"
            channels.length() > 0 -> "waking"
            else -> "offline"
        }

        val channelList = (0 until channels.length()).mapNotNull { channels.optString(it).takeIf { s -> s.isNotBlank() } }
        val message = when {
            isNowOnline -> "NAS / FRITZ!NAS aktiv & geweckt (${channelList.joinToString(" · ").ifEmpty { "Direktzugriff" }} · ${latencyMs} ms)."
            status == "waking" -> "Wecksignal (${channelList.joinToString(" · ")}) gesendet — Festplatte fährt hoch, bitte in wenigen Sekunden erneut prüfen."
            else -> "NAS konnte nicht automatisch geweckt werden. Für Wake-on-LAN aus komplettem Standby optional MAC-Adresse angeben."
        }

        return JSONObject()
            .put("ok", isNowOnline)
            .put("wokeUp", isNowOnline)
            .put("status", status)
            .put("host", hostname)
            .put("resolvedIp", resolvedIp)
            .put("latencyMs", if (isNowOnline) latencyMs else JSONObject.NULL)
            .put("discoveredMac", effectiveMac ?: JSONObject.NULL)
            .put("smbReady", smbSpinUpOk || health.optBoolean("smbOpen", false))
            .put("fritzWebReady", fritzWebReady)
            .put("entenCenterReady", health.optBoolean("entenCenterReady", false))
            .put("transportLabel", health.opt("transportLabel") ?: JSONObject.NULL)
            .put("channelsTriggered", channels)
            .put("message", message)
            .toString()
    }

    private fun inferMediaKindForFilename(fileName: String, dirPath: String = ""): String {
        val lower = fileName.lowercase(Locale.US)
        val normDir = "/${dirPath.trim().replace('\\', '/').trim('/')}/".lowercase(Locale.US)
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") ||
                lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".bmp") ||
                lower.endsWith(".heic") || lower.endsWith(".heif") || lower.endsWith(".avif") ||
                lower.endsWith(".tiff") || lower.endsWith(".tif") || lower.endsWith(".svg") -> "image"
            lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav") ||
                lower.endsWith(".ogg") || lower.endsWith(".oga") || lower.endsWith(".m4a") ||
                lower.endsWith(".aac") || lower.endsWith(".opus") || lower.endsWith(".wma") ||
                lower.endsWith(".m4b") || lower.endsWith(".aiff") || lower.endsWith(".aif") ||
                lower.endsWith(".alac") || lower.endsWith(".ape") || lower.endsWith(".wv") ||
                lower.endsWith(".mka") || lower.endsWith(".amr") || lower.endsWith(".mid") ||
                lower.endsWith(".midi") || lower.endsWith(".ac3") || lower.endsWith(".dts") -> "music"
            lower.endsWith(".mp4") || lower.endsWith(".mkv") || lower.endsWith(".webm") ||
                lower.endsWith(".mov") || lower.endsWith(".avi") || lower.endsWith(".m4v") ||
                lower.endsWith(".ts") || lower.endsWith(".m2ts") || lower.endsWith(".mts") ||
                lower.endsWith(".mpg") || lower.endsWith(".mpeg") || lower.endsWith(".wmv") ||
                lower.endsWith(".flv") || lower.endsWith(".f4v") || lower.endsWith(".3gp") ||
                lower.endsWith(".3g2") || lower.endsWith(".ogv") || lower.endsWith(".vob") ||
                lower.endsWith(".asf") || lower.endsWith(".divx") || lower.endsWith(".rmvb") ||
                lower.endsWith(".m3u8") || lower.endsWith(".m3u") || lower.endsWith(".iso") -> {
                val isSeriesFile = Regex("(?:^|[\\s._(-])(?:s\\d{1,2}\\s*[._-]?\\s*e\\d{1,3}|\\d{1,2}x\\d{1,3})(?:$|[\\s._)-])|\\b(?:staffel|season)\\s*\\d+\\b|\\b(?:episode|folge)\\s*\\d+\\b", RegexOption.IGNORE_CASE).containsMatchIn(lower)
                val isSeriesDir = Regex("/(?:serien|series|tv[\\s._-]?shows?|tv[\\s._-]?serien|anime|doku[\\s._-]?serien|staffel[\\s._-]*\\d*|season[\\s._-]*\\d*|s\\d{1,2})(?:/|$)", RegexOption.IGNORE_CASE).containsMatchIn(normDir)
                val isShortClipDir = Regex("/(?:clips?|shorts?|reels?|camera|kamera|dcim|whatsapp(?:\\s+video)?|handy|privat|homevideo|sample|trailer|musikvideos?|music[\\s._-]?videos?)(?:/|$)", RegexOption.IGNORE_CASE).containsMatchIn(normDir)
                val isShortClipFile = Regex("(?:^|[\\s._-])(?:sample|trailer|teaser|whatsapp|vid[-_]\\d{8}|pxl[-_]\\d{8}|img[-_]\\d{4}|mov[-_]\\d{4}|dsc[-_]\\d{4})(?:$|[\\s._-])", RegexOption.IGNORE_CASE).containsMatchIn(lower)
                when {
                    isSeriesFile || isSeriesDir -> "series"
                    isShortClipDir || isShortClipFile -> "video"
                    else -> "movie"
                }
            }
            else -> "other"
        }
    }

    private fun isScanMediaFilename(fileName: String): Boolean {
        val lower = fileName.lowercase(Locale.US)
        if (lower.startsWith(".") || lower == "thumbs.db" || lower == "desktop.ini") return false
        return Regex(
            "\\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|aiff|aif|alac|ape|wv|mka|amr|mid|midi|ac3|dts|jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg|pdf|epub|txt|srt|vtt)$"
        ).containsMatchIn(lower)
    }

    fun writeSmbFileJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "FRITZ.NAS")
        val rawTarget = req.optString("targetPath", "").trim().replace('\\', '/').replace(Regex("/+"), "/")
        val targetPath = if (rawTarget.startsWith("/")) rawTarget else "/$rawTarget"
        val offset = req.optLong("offset", 0L).coerceAtLeast(0L)
        val appendChunk = req.optBoolean("append", false)
        val createParentDirs = if (req.has("createParentDirs")) req.optBoolean("createParentDirs", true) else true
        val contentBase64 = req.optString("contentBase64", "")
        val textContent = req.optString("content", "")

        if (hostname.isEmpty() || targetPath == "/" || targetPath.endsWith("/")) {
            return JSONObject().put("ok", false).put("error", "Ungültiger Zielpfad für NAS-Datei.").toString()
        }
        val bytes: ByteArray = try {
            if (contentBase64.isNotEmpty()) {
                Base64.decode(contentBase64, Base64.DEFAULT)
            } else {
                textContent.toByteArray(Charsets.UTF_8)
            }
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("error", "Base64-Dekodierung fehlgeschlagen: ${e.message}").toString()
        }
        if (password.isEmpty()) {
            return JSONObject().put("ok", false).put("requiresAuth", true)
                .put("error", "Kein NAS-/FRITZ!Box-Passwort zum Schreiben angegeben.").toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject().put("ok", false)
                .put("error", "DNS-Auflösung für $hostname fehlgeschlagen: ${e.message}").toString()
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject().put("ok", false)
                .put("error", "Direktes SMB-Schreiben über öffentliches Internet blockiert (VPN erforderlich).").toString()
        }

        var (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 4500, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null && (authStatus == 0xC0000001L || authErr?.contains("Timeout", true) == true)) {
            nudgeNasWakeChannels(resolvedIp, hostname, allowLocalSelfSignedTls, configureTrust)
            val retry = openBestSmbSessionWithRetries(
                hostname, resolvedIp, port, username, password, domain, 8000, allowLocalSelfSignedTls, configureTrust
            )
            sess = retry.first; authStatus = retry.second; authErr = retry.third
        }
        if (sess == null) {
            return JSONObject().put("ok", false).put("requiresAuth", true)
                .put("error", authErr ?: explainNtStatus(authStatus, shareHint)).toString()
        }

        return sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false)
            val resolved = resolveSmbShareAndRelPath(s, hostname, resolvedIp, targetPath, shareHint, isFritz)
                ?: return@use JSONObject().put("ok", false)
                    .put("error", "SMB-Freigabe auf $hostname nicht erreichbar.").toString()
            val (shareName, tidAndRel) = resolved
            val (treeId, relWinPath) = tidAndRel
            if (relWinPath.isBlank()) {
                return@use JSONObject().put("ok", false).put("error", "Dateiname fehlt im Zielpfad.").toString()
            }
            if (createParentDirs && !appendChunk && relWinPath.contains('\\')) {
                val parentWin = relWinPath.substringBeforeLast('\\')
                val mkSt = ensureSmbDirRecursiveHelper(s, treeId, parentWin)
                if (mkSt != 0L) {
                    return@use JSONObject().put("ok", false)
                        .put("shareName", shareName)
                        .put("error", "Zielordner konnte nicht angelegt werden: ${explainNtStatus(mkSt, shareName)}")
                        .toString()
                }
            }
            val wst = writeSmbFileBinary(
                sess = s,
                treeId = treeId,
                fileWinPath = relWinPath,
                bytes = bytes,
                offset = offset,
                appendChunk = appendChunk,
                verifyReadback = !appendChunk && offset == 0L
            )
            if (wst != 0L) {
                return@use JSONObject().put("ok", false)
                    .put("shareName", shareName)
                    .put("filePath", targetPath)
                    .put("error", explainNtStatus(wst, shareName))
                    .toString()
            }
            JSONObject()
                .put("ok", true)
                .put("transport", "smb")
                .put("shareName", shareName)
                .put("filePath", targetPath)
                .put("bytesWritten", bytes.size)
                .put("verified", true)
                .put("message", "Datei „$targetPath“ direkt per SMB 2/3 auf „$shareName“ gespeichert.")
                .toString()
        }
    }

    fun readSmbFileJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "FRITZ.NAS")
        val rawTarget = req.optString("targetPath", "").trim().replace('\\', '/').replace(Regex("/+"), "/")
        val targetPath = if (rawTarget.startsWith("/")) rawTarget else "/$rawTarget"

        if (hostname.isEmpty() || targetPath == "/" || password.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "Host, Pfad und Passwort erforderlich.").toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("error", "DNS fehlgeschlagen: ${e.message}").toString()
        }
        val (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 4500, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null) {
            return JSONObject().put("ok", false).put("error", authErr ?: explainNtStatus(authStatus, shareHint)).toString()
        }
        return sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false)
            val resolved = resolveSmbShareAndRelPath(s, hostname, resolvedIp, targetPath, shareHint, isFritz)
                ?: return@use JSONObject().put("ok", false).put("error", "SMB-Freigabe nicht erreichbar.").toString()
            val (shareName, tidAndRel) = resolved
            val (treeId, relWinPath) = tidAndRel
            val (fid, cst, _) = smb2Create(
                sess = s,
                treeId = treeId,
                relWinPath = relWinPath,
                desiredAccess = 0x00120089L,
                fileAttributes = 0x00000080L,
                shareAccess = 0x00000007L,
                createDisposition = 1L, // FILE_OPEN
                createOptions = 0x00000060L
            )
            if (fid == null || cst != 0L) {
                return@use JSONObject().put("ok", false)
                    .put("shareName", shareName)
                    .put("error", explainNtStatus(cst, shareName))
                    .toString()
            }
            val (bytes, rst) = smb2ReadFile(s, treeId, fid)
            smb2Close(s, treeId, fid)
            if (rst != 0L || bytes == null) {
                return@use JSONObject().put("ok", false)
                    .put("shareName", shareName)
                    .put("error", explainNtStatus(rst, shareName))
                    .toString()
            }
            JSONObject()
                .put("ok", true)
                .put("shareName", shareName)
                .put("filePath", targetPath)
                .put("bytesRead", bytes.size)
                .put("content", String(bytes, Charsets.UTF_8))
                .toString()
        }
    }

    fun scanSmbFoldersForMediaJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "FRITZ.NAS")
        val scanMode = if (req.optString("scanMode", "all") == "selected") "selected" else "all"
        val maxFiles = req.optInt("maxFiles", 25000).coerceIn(50, 50000)
        val maxDepth = req.optInt("maxDepth", 12).coerceIn(1, 16)
        val rawFoldersArr = req.optJSONArray("folders")
        val requestedFolders = mutableListOf<String>()
        if (rawFoldersArr != null) {
            for (i in 0 until rawFoldersArr.length()) {
                val p = rawFoldersArr.optString(i, "").trim().replace('\\', '/').replace(Regex("/+"), "/").trimEnd('/')
                if (p.isNotEmpty()) requestedFolders.add(if (p.startsWith("/")) p else "/$p")
            }
        }
        val rootsToScan = if (scanMode == "selected" && requestedFolders.isNotEmpty()) {
            requestedFolders.distinct()
        } else {
            listOf("/")
        }

        if (hostname.isEmpty() || password.isEmpty()) {
            return JSONObject().put("ok", false).put("files", JSONArray())
                .put("error", "NAS-Host und Passwort für Live-Ordnerscan erforderlich.").toString()
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("files", JSONArray())
                .put("error", "DNS fehlgeschlagen: ${e.message}").toString()
        }
        val isLan = isLocalLanTargetStrict(hostname, resolvedIp)
        if (!isLan && req.optString("scope", "") != "vpn") {
            return JSONObject().put("ok", false).put("files", JSONArray())
                .put("error", "SMB-Ordnerscan außerhalb des Heimnetzes erfordert VPN.").toString()
        }
        val (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 6000, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null) {
            return JSONObject().put("ok", false).put("files", JSONArray())
                .put("error", authErr ?: explainNtStatus(authStatus, shareHint)).toString()
        }

        return sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false) ||
                FritzBoxSessionHelper.isLocalLanHost(hostname)
            val rootResolved = resolveSmbShareAndRelPath(s, hostname, resolvedIp, "/", shareHint, isFritz)
                ?: return@use JSONObject().put("ok", false).put("files", JSONArray())
                    .put("error", "SMB-Freigabe nicht gefunden.").toString()
            val (shareName, rootTidRel) = rootResolved
            val treeId = rootTidRel.first

            val volumeStats = queryBestSmbVolumeSize(s, treeId, shareName, isFritz)

            val discoveredFiles = JSONArray()
            val scannedFoldersArr = JSONArray()
            val visitedDirs = HashSet<String>()
            val queue = ArrayDeque<Pair<String, Int>>()
            for (r in rootsToScan) queue.add(r to 0)

            var scannedTotalBytes = 0L
            var scannedFilesCount = 0
            var truncated = false
            var moviesCount = 0; var moviesBytes = 0L
            var seriesCount = 0; var seriesBytes = 0L
            var musicCount = 0; var musicBytes = 0L
            var videosCount = 0; var videosBytes = 0L
            var imagesCount = 0; var imagesBytes = 0L
            var otherCount = 0; var otherBytes = 0L

            while (queue.isNotEmpty() && visitedDirs.size < 8000) {
                val (dirPath, depth) = queue.removeFirst()
                val normDir = dirPath.ifBlank { "/" }
                if (!visitedDirs.add(normDir.lowercase(Locale.US))) continue

                val relWin = smbRelWinPathForShare(normDir, shareName)
                var createRes = smb2Create(
                    sess = s,
                    treeId = treeId,
                    relWinPath = relWin,
                    desiredAccess = 0x00100081L,
                    fileAttributes = 0x00000010L,
                    shareAccess = 0x00000007L,
                    createDisposition = 1L,
                    createOptions = 0x00000001L
                )
                if ((createRes.first == null || createRes.second != 0L) &&
                    isFritz &&
                    (relWin.equals("FRITZ", true) || relWin.startsWith("FRITZ\\", true))
                ) {
                    val altRel = relWin.removePrefix("FRITZ").removePrefix("fritz").trimStart('\\')
                    val altRes = smb2Create(
                        sess = s,
                        treeId = treeId,
                        relWinPath = altRel,
                        desiredAccess = 0x00100081L,
                        fileAttributes = 0x00000010L,
                        shareAccess = 0x00000007L,
                        createDisposition = 1L,
                        createOptions = 0x00000001L
                    )
                    if (altRes.first != null && altRes.second == 0L) {
                        createRes = altRes
                    }
                }
                val (dirFid, openSt, _) = createRes
                if (dirFid == null || openSt != 0L) continue
                val (entries, _) = smb2QueryDirectory(s, treeId, dirFid)
                smb2Close(s, treeId, dirFid)
                scannedFoldersArr.put(normDir)

                for ((name, isDir, rawSize) in entries) {
                    val childPath = if (normDir == "/") "/$name" else "$normDir/$name"
                    val lowerName = name.lowercase(Locale.US)
                    if (isDir) {
                        if (depth < maxDepth &&
                            !lowerName.startsWith(".") &&
                            lowerName != "entencenter-backend" &&
                            lowerName != "@eadir" &&
                            lowerName != "#recycle" &&
                            lowerName != "${'$'}recycle.bin" &&
                            lowerName != "system volume information"
                        ) {
                            queue.add(childPath to (depth + 1))
                        }
                    } else {
                        val size = rawSize.coerceAtLeast(0L)
                        scannedFilesCount++
                        scannedTotalBytes += size
                        val kind = inferMediaKindForFilename(name, normDir)
                        when (kind) {
                            "movie" -> { moviesCount++; moviesBytes += size }
                            "series" -> { seriesCount++; seriesBytes += size }
                            "music" -> { musicCount++; musicBytes += size }
                            "video" -> { videosCount++; videosBytes += size }
                            "image" -> { imagesCount++; imagesBytes += size }
                            else -> { otherCount++; otherBytes += size }
                        }
                        if (isScanMediaFilename(name)) {
                            if (discoveredFiles.length() < maxFiles) {
                                discoveredFiles.put(
                                    JSONObject()
                                        .put("name", name)
                                        .put("path", childPath)
                                        .put("dirPath", normDir)
                                        .put("sizeBytes", size)
                                        .put("inferredKind", kind)
                                )
                            } else {
                                truncated = true
                            }
                        }
                    }
                }
            }

            val breakdownObj = JSONObject()
                .put("moviesCount", moviesCount).put("moviesBytes", moviesBytes)
                .put("seriesCount", seriesCount).put("seriesBytes", seriesBytes)
                .put("musicCount", musicCount).put("musicBytes", musicBytes)
                .put("videosCount", videosCount).put("videosBytes", videosBytes)
                .put("imagesCount", imagesCount).put("imagesBytes", imagesBytes)
                .put("otherCount", otherCount).put("otherBytes", otherBytes)

            val res = JSONObject()
                .put("ok", true)
                .put("host", hostname)
                .put("shareName", shareName)
                .put("scanMode", scanMode)
                .put("scannedFolders", scannedFoldersArr)
                .put("files", discoveredFiles)
                .put("scannedFilesCount", scannedFilesCount)
                .put("scannedTotalBytes", scannedTotalBytes)
                .put("truncated", truncated || queue.isNotEmpty())
                .put("mediaBreakdown", breakdownObj)

            if (volumeStats != null && volumeStats.ok && volumeStats.totalBytes > 0L) {
                res.put("volumeTotalBytes", volumeStats.totalBytes)
                res.put("volumeFreeBytes", volumeStats.freeBytes)
                res.put("volumeUsedBytes", volumeStats.usedBytes)
                res.put("volumeSource", "smb2_query_info")
            }
            res.toString()
        }
    }

    /**
     * Streamt eine beliebige Datei direkt über SMB 2/3 mit Byte-Range-Support (ohne Komplett-Pufferung im RAM).
     * Gibt `null` bei Erfolg zurück oder eine Fehlermeldung, falls SMB nicht öffnen/lesen konnte.
     */
    fun statAndStreamSmbFileRange(
        requestJson: String,
        rangeStart: Long?,
        rangeEnd: Long?,
        isHeadOnly: Boolean,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null,
        onMetadata: (totalSize: Long, startByte: Long, endByte: Long) -> Boolean,
        onChunk: (buffer: ByteArray, length: Int) -> Boolean
    ): String? {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostname = cleanHost(req.optString("host", "fritz.box"))
        val port = sanitizeSmbPort(req.optInt("port", 445))
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val domain = req.optString("domainOrWorkgroup", "")
        val shareHint = req.optString("shareOrPath", "FRITZ.NAS")
        val rawTarget = req.optString("targetPath", "").trim().replace('\\', '/').replace(Regex("/+"), "/")
        val targetPath = if (rawTarget.startsWith("/")) rawTarget else "/$rawTarget"

        if (hostname.isEmpty() || targetPath == "/" || password.isEmpty()) {
            return "SMB Host, Dateipfad und Passwort erforderlich."
        }
        val resolvedIp = try {
            InetAddress.getByName(hostname).hostAddress ?: hostname
        } catch (e: Exception) {
            return "DNS fehlgeschlagen: ${e.message}"
        }
        val (sess, authStatus, authErr) = openBestSmbSessionWithRetries(
            hostname, resolvedIp, port, username, password, domain, 6000, allowLocalSelfSignedTls, configureTrust
        )
        if (sess == null) {
            return authErr ?: explainNtStatus(authStatus, shareHint)
        }
        return sess.use { s ->
            val isFritz = hostname.contains("fritz", true) || req.optBoolean("isFritzBox", false)
            val resolved = resolveSmbShareAndRelPath(s, hostname, resolvedIp, targetPath, shareHint, isFritz)
                ?: return@use "SMB-Freigabe nicht erreichbar."
            val (shareName, tidAndRel) = resolved
            val (treeId, relWinPath) = tidAndRel

            var statRes = smb2CreateStat(
                sess = s,
                treeId = treeId,
                relWinPath = relWinPath,
                desiredAccess = 0x00120089L,
                fileAttributes = 0x00000080L,
                shareAccess = 0x00000007L,
                createDisposition = 1L,
                createOptions = 0x00000060L
            )
            if ((statRes.fileId == null || statRes.status != 0L) &&
                isFritz &&
                (relWinPath.startsWith("FRITZ\\", true))
            ) {
                val altRel = relWinPath.removePrefix("FRITZ\\").removePrefix("fritz\\").trimStart('\\')
                if (altRel.isNotEmpty()) {
                    val altStat = smb2CreateStat(
                        sess = s,
                        treeId = treeId,
                        relWinPath = altRel,
                        desiredAccess = 0x00120089L,
                        fileAttributes = 0x00000080L,
                        shareAccess = 0x00000007L,
                        createDisposition = 1L,
                        createOptions = 0x00000060L
                    )
                    if (altStat.fileId != null && altStat.status == 0L) {
                        statRes = altStat
                    }
                }
            }
            val fid = statRes.fileId
            if (fid == null || statRes.status != 0L) {
                return@use explainNtStatus(statRes.status, shareName)
            }
            try {
                val totalSize = statRes.endOfFile
                val startByte = (rangeStart ?: 0L).coerceAtLeast(0L)
                val endByte = if (totalSize <= 0L) {
                    -1L
                } else {
                    (rangeEnd ?: (totalSize - 1L)).coerceAtMost(totalSize - 1L)
                }
                val shouldStream = onMetadata(totalSize, startByte, endByte)
                if (!shouldStream || isHeadOnly || totalSize <= 0L || endByte < startByte) {
                    return@use null
                }

                val chunkMax = minOf(s.maxTransactSize, 65536).coerceIn(4096, 65536)
                var offset = startByte
                while (offset <= endByte) {
                    val remaining = (endByte - offset + 1L).coerceAtMost(chunkMax.toLong()).toInt()
                    val body = ByteArray(49)
                    writeUInt16LE(body, 0, 49)
                    body[2] = 0x50
                    writeUInt32LE(body, 4, remaining.toLong())
                    writeUInt64LE(body, 8, offset)
                    fid.copyInto(body, 16, 0, 16)
                    writeUInt32LE(body, 32, 1L)

                    val msgId = s.nextMsgId++
                    s.output.write(wrapNetBios(buildSmb2Header(8, msgId, s.sessionId, treeId, creditCharge = s.cmdCreditCharge) + body))
                    s.output.flush()

                    val resp = readNetBiosFrame(s.input) ?: return@use "SMB2 Lese-Timeout während Stream."
                    if (resp.size < 64) return@use "Ungültige SMB2 Read-Antwort."
                    val rSt = readUInt32LE(resp, 8)
                    if (rSt == 0xC0000011L) break
                    if (rSt != 0L || resp.size < 80) return@use explainNtStatus(rSt, shareName)
                    val dataOff = (resp[64 + 2].toInt() and 0xFF)
                    val dataLen = readUInt32LE(resp, 64 + 4).toInt()
                    if (dataLen <= 0 || dataOff < 64 || dataOff + dataLen > resp.size) break
                    val slice = resp.copyOfRange(dataOff, dataOff + dataLen)
                    if (!onChunk(slice, dataLen)) break
                    offset += dataLen.toLong()
                    if (dataLen < remaining) break
                }
                null
            } finally {
                smb2Close(s, treeId, fid)
            }
        }
    }
}
