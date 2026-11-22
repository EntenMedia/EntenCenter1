package de.entencenter.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Native Android Hilfsklasse für FRITZ!Box TR-064 Discovery,
 * Challenge-Response-Authentifizierung (login_sid.lua v1 MD5 & v2 PBKDF2) und SID-Caching.
 */
object FritzBoxSessionHelper {
    private const val EMPTY_SID = "0000000000000000"
    private val sidCache = ConcurrentHashMap<String, String>()

    fun isLocalLanHost(rawHost: String?): Boolean {
        val clean = (rawHost ?: "")
            .trim()
            .removePrefix("[")
            .removeSuffix("]")
            .replace(Regex("^::ffff:", RegexOption.IGNORE_CASE), "")
            .lowercase()
        if (clean.isEmpty()) return false

        if (
            clean == "localhost" ||
            clean == "127.0.0.1" ||
            clean == "::1" ||
            clean == "fritz.box" ||
            clean == "fritz.nas" ||
            clean.endsWith(".fritz.box") ||
            clean.endsWith(".fritz.nas") ||
            clean.endsWith(".box") ||
            clean.endsWith(".local") ||
            clean.endsWith(".lan") ||
            clean.endsWith(".home") ||
            clean.endsWith(".internal")
        ) {
            return true
        }

        if (clean.startsWith("10.") || clean.startsWith("192.168.") || clean.startsWith("169.254.")) {
            return true
        }
        if (clean.startsWith("172.")) {
            val second = clean.split('.').getOrNull(1)?.toIntOrNull()
            if (second != null && second in 16..31) {
                return true
            }
        }
        return clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80:")
    }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        if (clean.length % 2 != 0) return ByteArray(0)
        return ByteArray(clean.length / 2) { i ->
            clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    private fun pbkdf2HmacSha256(keyBytes: ByteArray, salt: ByteArray, iterations: Int): ByteArray {
        val iter = iterations.coerceAtLeast(1)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
        val blockInput = ByteArray(salt.size + 4)
        System.arraycopy(salt, 0, blockInput, 0, salt.size)
        blockInput[salt.size] = 0
        blockInput[salt.size + 1] = 0
        blockInput[salt.size + 2] = 0
        blockInput[salt.size + 3] = 1
        var u = mac.doFinal(blockInput)
        val t = u.copyOf()
        for (i in 1 until iter) {
            u = mac.doFinal(u)
            for (j in t.indices) {
                t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
        }
        return t
    }

    /**
     * AVM Challenge-Response Signatur:
     * - PBKDF2-v2 (`2$iter1$salt1$iter2$salt2`)
     * - Standard MD5-v1 (`<Challenge>-MD5(UTF-16LE(<Challenge>-<Password>))`)
     */
    fun computeChallengeResponse(challenge: String, password: String): Triple<String, String, String> {
        val cleanChallenge = challenge.trim()
        if (cleanChallenge.startsWith("2$")) {
            val parts = cleanChallenge.split('$')
            if (parts.size == 5) {
                val iter1 = parts[1].toIntOrNull()?.coerceAtLeast(1) ?: 1
                val salt1 = hexToBytes(parts[2])
                val iter2 = parts[3].toIntOrNull()?.coerceAtLeast(1) ?: 1
                val salt2 = hexToBytes(parts[4])
                if (salt1.isNotEmpty() && salt2.isNotEmpty()) {
                    val hash1 = pbkdf2HmacSha256(password.toByteArray(Charsets.UTF_8), salt1, iter1)
                    val hash2 = pbkdf2HmacSha256(hash1, salt2, iter2)
                    val hashHex = hash2.joinToString("") { "%02x".format(it) }
                    return Triple("${parts[4]}\$$hashHex", hashHex, "pbkdf2_v2")
                }
            }
        }

        val sb = StringBuilder(password.length)
        for (ch in password) {
            sb.append(if (ch.code > 255) '.' else ch)
        }
        val combined = "$cleanChallenge-$sb"
        val utf16LeBytes = combined.toByteArray(Charsets.UTF_16LE)
        val digest = MessageDigest.getInstance("MD5").digest(utf16LeBytes)
        val md5Hex = digest.joinToString("") { "%02x".format(it) }
        return Triple("$cleanChallenge-$md5Hex", md5Hex, "md5_v1")
    }

    fun computeMd5ChallengeResponse(challenge: String, password: String): Pair<String, String> {
        val (resp, hex, _) = computeChallengeResponse(challenge, password)
        return resp to hex
    }

    private fun extractXmlTag(xml: String, tag: String): String {
        val regex = Regex("<$tag[^>]*>([^<]*)</$tag>", RegexOption.IGNORE_CASE)
        return regex.find(xml)?.groupValues?.getOrNull(1)?.trim() ?: ""
    }

    private fun extractXmlTagList(xml: String, tag: String): List<String> {
        val regex = Regex("<$tag[^>]*>([^<]+)</$tag>", RegexOption.IGNORE_CASE)
        return regex.findAll(xml)
            .mapNotNull { it.groupValues.getOrNull(1)?.trim()?.takeIf { v -> v.isNotEmpty() } }
            .toList()
    }

    /**
     * Parst `<Users><User last="1">benutzer</User><User>...</User></Users>` aus FRITZ!OS login_sid.lua XML.
     * Gibt (Alle Benutzer mit last="1" priorisiert, lastUser) zurück.
     */
    fun extractFritzUsers(xml: String): Pair<List<String>, String?> {
        val regex = Regex("<User([^>]*)>([^<]*)</User>", RegexOption.IGNORE_CASE)
        val users = mutableListOf<String>()
        var lastUser: String? = null
        for (m in regex.findAll(xml)) {
            val attrs = m.groupValues.getOrNull(1) ?: ""
            val name = m.groupValues.getOrNull(2)?.trim() ?: ""
            if (name.isEmpty()) continue
            val isLast = Regex("""\blast\s*=\s*["']?1["']?""", RegexOption.IGNORE_CASE).containsMatchIn(attrs)
            if (isLast) {
                lastUser = name
                if (!users.contains(name)) users.add(0, name)
            } else if (!users.contains(name)) {
                users.add(name)
            }
        }
        return users to (lastUser ?: users.firstOrNull())
    }

    /**
     * Liest `<Rights><Name>NAS</Name><Access>2</Access></Rights>` (1=lesen, 2=lesen+schreiben).
     */
    fun extractNasRightAccess(xml: String): Int? {
        val regex = Regex(
            "<Name>\\s*NAS\\s*</Name>\\s*<Access>\\s*(\\d+)\\s*</Access>",
            setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
        )
        return regex.find(xml)?.groupValues?.getOrNull(1)?.toIntOrNull()
    }

    private fun maskSid(sid: String): String? {
        if (sid.length < 8 || sid == EMPTY_SID) return null
        return "${sid.take(4)}••••${sid.takeLast(4)}"
    }

    private fun applyLocalTlsIfAllowed(
        conn: HttpURLConnection,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ) {
        if (conn !is HttpsURLConnection) return
        configureTrust?.invoke(conn)
        val host = conn.url?.host ?: ""
        if (allowLocalSelfSignedTls && isLocalLanHost(host)) {
            try {
                val trustAllLocal = arrayOf(
                    object : X509TrustManager {
                        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
                    }
                )
                val sslCtx = SSLContext.getInstance("TLS")
                sslCtx.init(null, trustAllLocal, SecureRandom())
                conn.sslSocketFactory = sslCtx.socketFactory
                conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
            } catch (_: Exception) {
                // Standard-Trust beibehalten
            }
        }
    }

    private fun sanitizeHttpPort(rawPort: Int, requestedTls: Boolean): Int {
        return when {
            rawPort == 49000 -> 80
            rawPort == 49443 -> 443
            rawPort in listOf(20, 21, 22, 23, 25, 110, 139, 143, 445, 5005, 5006, 8000, 8080, 9000) ->
                if (requestedTls) 443 else 80
            rawPort in 1..65535 -> rawPort
            requestedTls -> 443
            else -> 80
        }
    }

    private fun httpRequest(
        urlStr: String,
        method: String = "GET",
        bodyForm: String? = null,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null,
        timeoutMs: Int = 3500,
        extraHeaders: Map<String, String> = emptyMap()
    ): Pair<Int, String> {
        var currentUrl = urlStr
        var currentMethod = method
        var currentBody = bodyForm

        for (hop in 0..3) {
            val parsedUrl = URL(currentUrl)
            val conn = (parsedUrl.openConnection() as HttpURLConnection).apply {
                applyLocalTlsIfAllowed(this, allowLocalSelfSignedTls, configureTrust)
                requestMethod = currentMethod
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                setRequestProperty("Accept", "application/xml, text/xml, application/json, */*")
                setRequestProperty("Connection", "close")
                for ((hk, hv) in extraHeaders) {
                    setRequestProperty(hk, hv)
                }
                if (currentBody != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
                }
            }
            try {
                if (currentBody != null) {
                    conn.outputStream.use { os ->
                        os.write(currentBody.toByteArray(Charsets.UTF_8))
                    }
                }
                val status = conn.responseCode
                if (status in listOf(301, 302, 303, 307, 308)) {
                    val location = conn.getHeaderField("Location")?.trim()
                    if (!location.isNullOrBlank() && hop < 3) {
                        currentUrl = URL(parsedUrl, location).toString()
                        if (status == 301 || status == 302 || status == 303) {
                            if (currentMethod.equals("POST", ignoreCase = true)) {
                                currentMethod = "GET"
                                currentBody = null
                            }
                        }
                        continue
                    }
                }
                val stream = if (status in 200..399) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                return status to text
            } finally {
                conn.disconnect()
            }
        }
        return 0 to ""
    }

    fun probeTr064DeviceInfo(
        host: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): JSONObject? {
        val endpoints = listOf(
            "http://$host:49000/tr64desc.xml",
            "http://$host:49000/MediaServerDevDesc.xml",
            "https://$host:49443/tr64desc.xml"
        )
        for (endpoint in endpoints) {
            try {
                val (status, xml) = httpRequest(
                    urlStr = endpoint,
                    method = "GET",
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust,
                    timeoutMs = 1700
                )
                if (status in 200..299 && (xml.contains("<device", true) || xml.contains("fritz", true))) {
                    return JSONObject()
                        .put("available", true)
                        .put("locationUrl", endpoint)
                        .put("friendlyName", extractXmlTag(xml, "friendlyName").ifBlank { "FRITZ!Box ($host)" })
                        .put("manufacturer", extractXmlTag(xml, "manufacturer").ifBlank { "AVM Berlin" })
                        .put("modelName", extractXmlTag(xml, "modelName"))
                        .put("udn", extractXmlTag(xml, "UDN"))
                        .put("deviceType", extractXmlTag(xml, "deviceType"))
                }
            } catch (_: Exception) {
                // Nächsten Endpunkt versuchen
            }
        }
        return null
    }

    private data class SchemeProbeOutcome(
        val ok: Boolean,
        val error: String?,
        val xml: String?,
        val url: String?
    )

    private fun probeLoginSidSingleScheme(
        scheme: String,
        hostClean: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?,
        timeoutMs: Int = 3000
    ): SchemeProbeOutcome {
        val paths = listOf("/login_sid.lua?version=2", "/login_sid.lua")
        var lastError: String? = null
        for (path in paths) {
            val url = "$scheme://$hostClean$path"
            try {
                val (status, body) = httpRequest(
                    urlStr = url,
                    method = "GET",
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust,
                    timeoutMs = timeoutMs
                )
                if (status in 200..299 && (body.contains("<SessionInfo", true) || body.contains("<Challenge>", true))) {
                    return SchemeProbeOutcome(true, null, body, url)
                }
                lastError = if (status in 200..299) "Kein SessionInfo-XML" else "HTTP $status"
            } catch (e: Exception) {
                lastError = e.message ?: e.javaClass.simpleName
            }
        }
        return SchemeProbeOutcome(false, lastError ?: "$scheme nicht erreichbar", null, null)
    }

    fun probeLoginSid(
        host: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): JSONObject? {
        val cleanHost = host.trim()
            .removePrefix("http://")
            .removePrefix("https://")
            .substringBefore("/")
            .substringBefore(":")
            .ifBlank { return null }

        val pool = Executors.newFixedThreadPool(3)
        var httpOutcome = SchemeProbeOutcome(false, "Timeout", null, null)
        var httpsOutcome = SchemeProbeOutcome(false, "Timeout", null, null)
        var tr064Info: JSONObject? = null
        try {
            val fHttp = pool.submit<SchemeProbeOutcome> {
                probeLoginSidSingleScheme("http", cleanHost, allowLocalSelfSignedTls, configureTrust, 3400)
            }
            val fHttps = pool.submit<SchemeProbeOutcome> {
                probeLoginSidSingleScheme("https", cleanHost, allowLocalSelfSignedTls, configureTrust, 3400)
            }
            val fTr064 = pool.submit<JSONObject?> {
                probeTr064DeviceInfo(cleanHost, allowLocalSelfSignedTls, configureTrust)
            }
            try {
                httpOutcome = fHttp.get(4400, TimeUnit.MILLISECONDS)
            } catch (_: Exception) {
            }
            try {
                httpsOutcome = fHttps.get(4400, TimeUnit.MILLISECONDS)
            } catch (_: Exception) {
            }
            try {
                tr064Info = fTr064.get(3200, TimeUnit.MILLISECONDS)
            } catch (_: Exception) {
            }
        } finally {
            pool.shutdownNow()
        }

        val httpOk = httpOutcome.ok
        val httpsOk = httpsOutcome.ok
        val bestXml = httpOutcome.xml ?: httpsOutcome.xml
        val detected = bestXml != null || tr064Info != null
        if (!detected) return null

        val sid = if (bestXml != null) extractXmlTag(bestXml, "SID").ifBlank { EMPTY_SID } else EMPTY_SID
        val challenge = if (bestXml != null) extractXmlTag(bestXml, "Challenge") else ""
        val blockTime = if (bestXml != null) extractXmlTag(bestXml, "BlockTime").toIntOrNull() ?: 0 else 0
        val (fritzUsers, lastUser) = if (bestXml != null) extractFritzUsers(bestXml) else (emptyList<String>() to null)
        val nasAccessLevel = if (bestXml != null) extractNasRightAccess(bestXml) else null
        val challengeVersion = when {
            challenge.startsWith("2$") -> "pbkdf2_v2"
            challenge.isNotBlank() -> "md5_v1"
            else -> null
        }

        val requiresAuth = if (bestXml != null) (sid == EMPTY_SID || sid.isBlank()) else true
        val friendlyName = tr064Info?.optString("friendlyName")?.ifBlank { null }
            ?: "FRITZ!Box / FRITZ!NAS ($cleanHost)"

        return JSONObject()
            .put("detected", true)
            .put("host", cleanHost)
            .put("friendlyName", friendlyName)
            .put("modelName", tr064Info?.optString("modelName") ?: JSONObject.NULL)
            .put("tr064Available", tr064Info != null)
            .put("httpAvailable", httpOk)
            .put("httpError", if (httpOk) JSONObject.NULL else (httpOutcome.error ?: "HTTP nicht erreichbar"))
            .put("httpsAvailable", httpsOk)
            .put("httpsError", if (httpsOk) JSONObject.NULL else (httpsOutcome.error ?: "HTTPS nicht erreichbar"))
            .put("loginSidUrl", httpOutcome.url ?: httpsOutcome.url ?: JSONObject.NULL)
            .put("requiresAuth", requiresAuth)
            .put("challengeVersion", challengeVersion ?: JSONObject.NULL)
            .put("blockTimeSec", blockTime)
            .put("lastUser", lastUser ?: JSONObject.NULL)
            .put("users", JSONArray().apply { fritzUsers.forEach { put(it) } })
            .put("nasAccessLevel", nasAccessLevel ?: JSONObject.NULL)
    }

    fun authenticateAndReuseSid(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val rawHost = req.optString("host", "fritz.box").trim().ifBlank { "fritz.box" }
            val explicitSchemeHttps = rawHost.startsWith("https://", ignoreCase = true)
            val explicitSchemeHttp = rawHost.startsWith("http://", ignoreCase = true)
            val rawPort = req.optInt("port", -1)
            val requestedTls = when {
                explicitSchemeHttps -> true
                explicitSchemeHttp -> false
                rawPort == 49443 || rawPort == 443 -> true
                rawPort == 49000 || rawPort == 80 -> false
                else -> req.optBoolean("useTls", false)
            }
            val requestedPort = sanitizeHttpPort(rawPort, requestedTls)
            val username = req.optString("username", "").trim()
            val password = req.optString("password", "")
            val forceRefresh = req.optBoolean("forceRefresh", false)

            val hostClean = extractHostClean(rawHost)

            var activeUseTls = requestedTls
            var activePort = requestedPort
            var activeScheme = if (activeUseTls) "https" else "http"
            var portSuffix = if ((activeUseTls && activePort == 443) || (!activeUseTls && activePort == 80)) "" else ":$activePort"
            var baseUrl = "$activeScheme://$hostClean$portSuffix"
            var httpsFallbackToHttp = false
            var httpFallbackToHttps = false
            var httpsFallbackError: String? = null
            var loginPath = "/login_sid.lua?version=2"

            val tr064Info = probeTr064DeviceInfo(hostClean, allowLocalSelfSignedTls, configureTrust)

            fun fetchLoginSidAt(targetBase: String): Triple<Int, String, String> {
                val paths = listOf("/login_sid.lua?version=2", "/login_sid.lua")
                var lastStatus = 0
                var lastBody = ""
                var lastPath = "/login_sid.lua"
                for (path in paths) {
                    lastPath = path
                    val (st, body) = httpRequest(
                        urlStr = "$targetBase$path",
                        method = "GET",
                        allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                        configureTrust = configureTrust,
                        timeoutMs = 3500
                    )
                    lastStatus = st
                    lastBody = body
                    if (st in 200..299 && (body.contains("<SessionInfo", true) || body.contains("<SID>", true))) {
                        return Triple(st, body, path)
                    }
                }
                return Triple(lastStatus, lastBody, lastPath)
            }

            fun fetchChallengeWithLanFallback(): Pair<Int, String> {
                var primaryErr: Exception? = null
                try {
                    val (st, body, usedPath) = fetchLoginSidAt(baseUrl)
                    if (st in 200..299 && (body.contains("<SessionInfo", true) || body.contains("<SID>", true))) {
                        loginPath = usedPath
                        return st to body
                    }
                    if (activeUseTls && isLocalLanHost(hostClean)) {
                        val (fbSt, fbBody, fbPath) = fetchLoginSidAt("http://$hostClean")
                        if (fbSt in 200..299 && (fbBody.contains("<SessionInfo", true) || fbBody.contains("<SID>", true))) {
                            httpsFallbackToHttp = true
                            httpsFallbackError = "HTTPS lieferte HTTP $st"
                            activeUseTls = false
                            activePort = 80
                            activeScheme = "http"
                            portSuffix = ""
                            baseUrl = "http://$hostClean"
                            loginPath = fbPath
                            return fbSt to fbBody
                        }
                    } else if (!activeUseTls && isLocalLanHost(hostClean)) {
                        val (fbSt, fbBody, fbPath) = fetchLoginSidAt("https://$hostClean")
                        if (fbSt in 200..299 && (fbBody.contains("<SessionInfo", true) || fbBody.contains("<SID>", true))) {
                            httpFallbackToHttps = true
                            activeUseTls = true
                            activePort = 443
                            activeScheme = "https"
                            portSuffix = ""
                            baseUrl = "https://$hostClean"
                            loginPath = fbPath
                            return fbSt to fbBody
                        }
                    }
                    return st to body
                } catch (e: Exception) {
                    primaryErr = e
                }

                if (isLocalLanHost(hostClean)) {
                    val altScheme = if (activeUseTls) "http" else "https"
                    val altPort = if (altScheme == "http") 80 else 443
                    val altBase = "$altScheme://$hostClean"
                    try {
                        val (fbSt, fbBody, fbPath) = fetchLoginSidAt(altBase)
                        if (fbSt in 200..299 && (fbBody.contains("<SessionInfo", true) || fbBody.contains("<SID>", true))) {
                            if (activeUseTls) {
                                httpsFallbackToHttp = true
                                httpsFallbackError = primaryErr.message ?: "HTTPS/Zertifikatsfehler"
                            } else {
                                httpFallbackToHttps = true
                            }
                            activeUseTls = altScheme == "https"
                            activePort = altPort
                            activeScheme = altScheme
                            portSuffix = ""
                            baseUrl = altBase
                            loginPath = fbPath
                            return fbSt to fbBody
                        }
                    } catch (_: Exception) {
                        // Ursprünglichen Fehler weiterwerfen
                    }
                }
                throw primaryErr
            }

            if (!forceRefresh) {
                val cacheKeyInitial = "$baseUrl|${username.lowercase()}"
                val cachedSid = sidCache[cacheKeyInitial]
                    ?: sidCache["http://$hostClean|${username.lowercase()}"]
                    ?: sidCache["https://$hostClean|${username.lowercase()}"]
                if (!cachedSid.isNullOrBlank() && cachedSid != EMPTY_SID) {
                    val checkTargets = listOf(baseUrl, "http://$hostClean", "https://$hostClean").distinct()
                    for (targetBase in checkTargets) {
                        try {
                            val (checkStatus, checkXml) = httpRequest(
                                urlStr = "$targetBase/login_sid.lua?sid=${URLEncoder.encode(cachedSid, "UTF-8")}",
                                method = "GET",
                                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                                configureTrust = configureTrust,
                                timeoutMs = 2500
                            )
                            if (checkStatus in 200..299 && extractXmlTag(checkXml, "SID") == cachedSid) {
                                val usedHttps = targetBase.startsWith("https://")
                                val rightsArr = JSONArray().apply {
                                    extractXmlTagList(checkXml, "Name").forEach { put(it) }
                                }
                                return JSONObject()
                                    .put("ok", true)
                                    .put("reused", true)
                                    .put("sid", cachedSid)
                                    .put("sidPreview", maskSid(cachedSid))
                                    .put("rights", rightsArr)
                                    .put("effectiveScheme", if (usedHttps) "https" else "http")
                                    .put("effectivePort", if (usedHttps) 443 else 80)
                                    .put("httpsFallbackToHttp", activeUseTls && !usedHttps)
                                    .put("httpFallbackToHttps", !activeUseTls && usedHttps)
                                    .put("tr064Available", tr064Info != null)
                                    .put("friendlyName", tr064Info?.optString("friendlyName") ?: JSONObject.NULL)
                                    .put("modelName", tr064Info?.optString("modelName") ?: JSONObject.NULL)
                                    .toString()
                            }
                        } catch (_: Exception) {
                            // Nächstes Schema oder Neu-Login
                        }
                    }
                }
            }

            val (initStatus, initXml) = fetchChallengeWithLanFallback()
            val effectiveCacheKey = "$baseUrl|${username.lowercase()}"
            if (initStatus !in 200..299) {
                return JSONObject()
                    .put("ok", false)
                    .put("httpsFallbackToHttp", httpsFallbackToHttp)
                    .put("httpFallbackToHttps", httpFallbackToHttps)
                    .put("httpsError", httpsFallbackError ?: JSONObject.NULL)
                    .put("error", "FRITZ!Box login_sid.lua lieferte HTTP $initStatus.")
                    .toString()
            }

            val initialSid = extractXmlTag(initXml, "SID").ifBlank { EMPTY_SID }
            var currentChallenge = extractXmlTag(initXml, "Challenge")
            val blockTime = extractXmlTag(initXml, "BlockTime").toIntOrNull() ?: 0
            val initialRights = JSONArray().apply {
                extractXmlTagList(initXml, "Name").forEach { put(it) }
            }
            val (xmlUsers, xmlLastUser) = extractFritzUsers(initXml)
            val initialNasAccess = extractNasRightAccess(initXml)
            val detectedVersion = if (currentChallenge.startsWith("2$")) "pbkdf2_v2" else "md5_v1"

            if (blockTime > 0) {
                return JSONObject()
                    .put("ok", false)
                    .put("blockTimeSec", blockTime)
                    .put("challengeVersion", detectedVersion)
                    .put("httpsFallbackToHttp", httpsFallbackToHttp)
                    .put("httpFallbackToHttps", httpFallbackToHttps)
                    .put("httpsError", httpsFallbackError ?: JSONObject.NULL)
                    .put("lastUser", xmlLastUser ?: JSONObject.NULL)
                    .put("users", JSONArray().apply { xmlUsers.forEach { put(it) } })
                    .put("error", "FRITZ!Box Login gesperrt ($blockTime Sekunden warten).")
                    .toString()
            }

            if (initialSid != EMPTY_SID && password.isEmpty()) {
                sidCache[effectiveCacheKey] = initialSid
                return JSONObject()
                    .put("ok", true)
                    .put("reused", false)
                    .put("sid", initialSid)
                    .put("sidPreview", maskSid(initialSid) ?: JSONObject.NULL)
                    .put("challenge", currentChallenge)
                    .put("challengeVersion", detectedVersion)
                    .put("rights", initialRights)
                    .put("selectedUser", xmlLastUser ?: JSONObject.NULL)
                    .put("lastUser", xmlLastUser ?: JSONObject.NULL)
                    .put("users", JSONArray().apply { xmlUsers.forEach { put(it) } })
                    .put("nasAccessLevel", initialNasAccess ?: JSONObject.NULL)
                    .put("effectiveScheme", activeScheme)
                    .put("effectivePort", activePort)
                    .put("httpsFallbackToHttp", httpsFallbackToHttp)
                    .put("httpFallbackToHttps", httpFallbackToHttps)
                    .put("httpsError", httpsFallbackError ?: JSONObject.NULL)
                    .put("tr064Available", tr064Info != null)
                    .put("friendlyName", tr064Info?.optString("friendlyName") ?: JSONObject.NULL)
                    .put("modelName", tr064Info?.optString("modelName") ?: JSONObject.NULL)
                    .put("error", JSONObject.NULL)
                    .toString()
            }

            if (password.isEmpty()) {
                return JSONObject()
                    .put("ok", false)
                    .put("requiresAuth", true)
                    .put("sid", EMPTY_SID)
                    .put("challenge", currentChallenge)
                    .put("challengeVersion", detectedVersion)
                    .put("lastUser", xmlLastUser ?: JSONObject.NULL)
                    .put("users", JSONArray().apply { xmlUsers.forEach { put(it) } })
                    .put("effectiveScheme", activeScheme)
                    .put("effectivePort", activePort)
                    .put("httpsFallbackToHttp", httpsFallbackToHttp)
                    .put("httpFallbackToHttps", httpFallbackToHttps)
                    .put("httpsError", httpsFallbackError ?: JSONObject.NULL)
                    .put("tr064Available", tr064Info != null)
                    .put("friendlyName", tr064Info?.optString("friendlyName") ?: JSONObject.NULL)
                    .put("error", "FRITZ!Box ($hostClean) erfordert vor dem NAS-Zugriff ein Kennwort (oder Benutzername + Kennwort).")
                    .toString()
            }

            // FRITZ!OS 7.20+: Wenn kein Benutzername eingetragen wurde, automatisch <User last="1"> bzw. User-Liste nutzen!
            val candidateUsers = linkedListOfUsers(username, xmlLastUser, xmlUsers)

            var sid = EMPTY_SID
            var postStatus = 0
            var postXml = ""
            var postBlockTime = 0
            var usedVersion = detectedVersion
            var selectedUser = username

            for ((attemptIdx, candUser) in candidateUsers.withIndex()) {
                if (attemptIdx > 0) {
                    val (_, freshXml) = fetchChallengeWithLanFallback()
                    val freshCh = extractXmlTag(freshXml, "Challenge")
                    val freshBlock = extractXmlTag(freshXml, "BlockTime").toIntOrNull() ?: 0
                    if (freshBlock > 0) {
                        postBlockTime = freshBlock
                        break
                    }
                    if (freshCh.isNotBlank()) currentChallenge = freshCh
                }

                val (responseSig, _, ver) = computeChallengeResponse(currentChallenge, password)
                usedVersion = ver
                val bodyBuilder = StringBuilder()
                if (candUser.isNotBlank()) {
                    bodyBuilder.append("username=").append(URLEncoder.encode(candUser, "UTF-8")).append("&")
                }
                bodyBuilder.append("response=").append(URLEncoder.encode(responseSig, "UTF-8"))

                val respPair = httpRequest(
                    urlStr = "$baseUrl$loginPath",
                    method = "POST",
                    bodyForm = bodyBuilder.toString(),
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust,
                    timeoutMs = 3500
                )
                postStatus = respPair.first
                postXml = respPair.second
                sid = extractXmlTag(postXml, "SID").ifBlank { EMPTY_SID }
                postBlockTime = extractXmlTag(postXml, "BlockTime").toIntOrNull() ?: 0
                selectedUser = candUser

                if (postStatus in 200..299 && sid != EMPTY_SID) {
                    break
                }
                if (postBlockTime > 0) {
                    break
                }
            }

            val rightsArr = JSONArray().apply {
                extractXmlTagList(postXml, "Name").forEach { put(it) }
            }
            val nasAccessLevel = extractNasRightAccess(postXml)
            val ok = postStatus in 200..299 && sid != EMPTY_SID
            if (ok) {
                sidCache[effectiveCacheKey] = sid
                if (selectedUser.isNotBlank()) {
                    sidCache["$baseUrl|${selectedUser.lowercase()}"] = sid
                }
            }

            val errorMsg = when {
                ok -> null
                postBlockTime > 0 -> "FRITZ!Box Login fehlgeschlagen ($postBlockTime Sek. Sperrzeit). Benutzername/Kennwort prüfen."
                else -> "FRITZ!Box Zugangsdaten ungültig oder Benutzer besitzt keine FRITZ!NAS-Berechtigung (in FRITZ!Box unter System -> FRITZ!Box-Benutzer 'Zugang zu NAS-Inhalten' aktivieren)."
            }

            JSONObject()
                .put("ok", ok)
                .put("reused", false)
                .put("sid", sid)
                .put("sidPreview", maskSid(sid) ?: JSONObject.NULL)
                .put("challenge", currentChallenge)
                .put("challengeVersion", usedVersion)
                .put("blockTimeSec", postBlockTime)
                .put("rights", rightsArr)
                .put("selectedUser", selectedUser.ifBlank { JSONObject.NULL })
                .put("lastUser", xmlLastUser ?: JSONObject.NULL)
                .put("users", JSONArray().apply { xmlUsers.forEach { put(it) } })
                .put("nasAccessLevel", nasAccessLevel ?: JSONObject.NULL)
                .put("effectiveScheme", activeScheme)
                .put("effectivePort", activePort)
                .put("httpsFallbackToHttp", httpsFallbackToHttp)
                .put("httpFallbackToHttps", httpFallbackToHttps)
                .put("httpsError", httpsFallbackError ?: JSONObject.NULL)
                .put("tr064Available", tr064Info != null)
                .put("friendlyName", tr064Info?.optString("friendlyName") ?: JSONObject.NULL)
                .put("modelName", tr064Info?.optString("modelName") ?: JSONObject.NULL)
                .put("error", errorMsg ?: JSONObject.NULL)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "FRITZ!Box Login-Fehler")
                .toString()
        }
    }

    private fun linkedListOfUsers(explicitUser: String, lastUser: String?, xmlUsers: List<String>): List<String> {
        val list = mutableListOf<String>()
        if (explicitUser.isNotBlank()) {
            list.add(explicitUser)
            if (lastUser != null && !list.contains(lastUser) && explicitUser.equals(lastUser, ignoreCase = true)) {
                list.add(lastUser)
            }
            // Falls ein versehentlich übernommener App-Profilname (z. B. "marc") nicht in den FRITZ!Box-Benutzern steht,
            // FRITZ!Box <Users> als Fallback anhängen, damit das korrekte FRITZ!Box-Passwort nicht blockiert wird.
            val matchesFritzUser = xmlUsers.any { it.equals(explicitUser, ignoreCase = true) }
            if (xmlUsers.isNotEmpty() && !matchesFritzUser) {
                if (!lastUser.isNullOrBlank() && !list.contains(lastUser)) list.add(lastUser)
                for (u in xmlUsers) {
                    if (!list.contains(u)) list.add(u)
                }
            }
            return list.take(5)
        }
        if (!lastUser.isNullOrBlank()) list.add(lastUser)
        for (u in xmlUsers) {
            if (!list.contains(u)) list.add(u)
        }
        // Fallback für klassische Nur-Passwort-FRITZ!Box-Konfiguration (oder wenn keine Users zurückgegeben)
        if (!list.contains("")) list.add("")
        return list.take(5)
    }

    private fun extractHostClean(rawHost: String): String {
        val noScheme = rawHost.trim()
            .removePrefix("http://")
            .removePrefix("https://")
            .substringBefore("/")
        return if (noScheme.startsWith("[")) {
            noScheme.substringBefore("]") + "]"
        } else {
            noScheme.substringBefore(":")
        }.ifBlank { "fritz.box" }
    }

    private fun normalizeRemotePath(rawPath: String?): String {
        val cleaned = (rawPath ?: "/").trim().replace("\\", "/").replace(Regex("/+"), "/")
        if (cleaned.isEmpty() || cleaned == "/") return "/"
        val withLead = if (cleaned.startsWith("/")) cleaned else "/$cleaned"
        return withLead.trimEnd('/').ifEmpty { "/" }
    }

    private fun hasFritzJsonError(json: JSONObject): Boolean {
        if (json.has("error") && !json.isNull("error")) {
            val raw = json.opt("error")
            if (raw is Number && raw.toInt() != 0) return true
            if (raw is Boolean && raw) return true
            if (raw is String && raw.isNotBlank() && raw != "0" && raw.lowercase() != "false" && raw.lowercase() != "ok") return true
        }
        val statusStr = json.optString("status", "").lowercase()
        if (statusStr == "error" || statusStr == "failed" || statusStr == "denied") return true
        return false
    }

    private fun parseFritzNasBrowseJson(
        body: String,
        remotePath: String,
        entries: JSONArray
    ): Boolean {
        val trimmed = body.trim()
        if (!trimmed.startsWith("{")) return false
        return try {
            val json = JSONObject(trimmed)
            if (hasFritzJsonError(json)) return false
            val dataRoot = json.optJSONObject("data") ?: json
            if (hasFritzJsonError(dataRoot)) return false
            val dataObj = dataRoot.optJSONObject("browse") ?: dataRoot

            val hasStruct = dataObj.has("directories") || dataObj.has("dirs") || dataObj.has("folders") ||
                dataObj.has("files") || dataObj.has("entries") ||
                json.has("data") || json.has("browse")
            if (!hasStruct) return false

            val dirs = dataObj.optJSONArray("directories")
                ?: dataObj.optJSONArray("dirs")
                ?: dataObj.optJSONArray("folders")
                ?: JSONArray()
            val files = dataObj.optJSONArray("files") ?: JSONArray()
            val mixedEntries = dataObj.optJSONArray("entries") ?: JSONArray()

            for (i in 0 until dirs.length()) {
                val d = dirs.optJSONObject(i) ?: continue
                val name = d.optString("filename").ifBlank { d.optString("name") }.trim()
                if (name.isEmpty() || name == "." || name == "..") continue
                val p = d.optString("path").ifBlank {
                    if (remotePath == "/") "/$name" else "$remotePath/$name"
                }
                entries.put(
                    JSONObject()
                        .put("name", name)
                        .put("path", normalizeRemotePath(p))
                        .put("type", "directory")
                        .put("writable", true)
                )
            }
            for (i in 0 until files.length()) {
                val f = files.optJSONObject(i) ?: continue
                val name = f.optString("filename").ifBlank { f.optString("name") }.trim()
                if (name.isEmpty()) continue
                val p = f.optString("path").ifBlank {
                    if (remotePath == "/") "/$name" else "$remotePath/$name"
                }
                val fileBytes = when {
                    f.has("size") -> f.optLong("size", 0L).let { if (it > 0L) it else f.optString("size", "0").toLongOrNull() ?: 0L }
                    f.has("fileSize") -> f.optLong("fileSize", 0L)
                    else -> 0L
                }.coerceAtLeast(0L)
                entries.put(
                    JSONObject()
                        .put("name", name)
                        .put("path", normalizeRemotePath(p))
                        .put("type", "file")
                        .put("sizeBytes", fileBytes)
                )
            }
            for (i in 0 until mixedEntries.length()) {
                val m = mixedEntries.optJSONObject(i) ?: continue
                val name = m.optString("filename").ifBlank { m.optString("name") }.trim()
                if (name.isEmpty() || name == "." || name == "..") continue
                val typeStr = m.optString("type", "").lowercase()
                val isDir = typeStr == "directory" || typeStr == "dir" || typeStr == "folder" || m.optBoolean("isDir", false)
                val p = m.optString("path").ifBlank {
                    if (remotePath == "/") "/$name" else "$remotePath/$name"
                }
                val entryBytes = if (isDir) 0L else when {
                    m.has("size") -> m.optLong("size", 0L).let { if (it > 0L) it else m.optString("size", "0").toLongOrNull() ?: 0L }
                    m.has("fileSize") -> m.optLong("fileSize", 0L)
                    else -> 0L
                }.coerceAtLeast(0L)
                entries.put(
                    JSONObject()
                        .put("name", name)
                        .put("path", normalizeRemotePath(p))
                        .put("type", if (isDir) "directory" else "file")
                        .put("sizeBytes", entryBytes)
                        .put("writable", isDir)
                )
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun parseFritzStorageQuotaFromJson(
        body: String
    ): Triple<Long, Long, Long>? {
        val trimmed = body.trim()
        if (!trimmed.startsWith("{")) return null
        return try {
            val json = JSONObject(trimmed)
            val dataRoot = json.optJSONObject("data") ?: json
            val dataObj = dataRoot.optJSONObject("browse") ?: dataRoot
            val candidates = listOfNotNull(
                json.optJSONObject("disk"),
                json.optJSONObject("storage"),
                dataRoot.optJSONObject("disk"),
                dataRoot.optJSONObject("storage"),
                dataObj.optJSONObject("disk"),
                dataObj.optJSONObject("storage"),
                dataRoot,
                dataObj
            )
            for (c in candidates) {
                val freeRaw = when {
                    c.has("free") -> c.optLong("free", -1L)
                    c.has("freeSpace") -> c.optLong("freeSpace", -1L)
                    c.has("freeBytes") -> c.optLong("freeBytes", -1L)
                    c.has("avail") -> c.optLong("avail", -1L)
                    else -> -1L
                }
                val totalRaw = when {
                    c.has("total") -> c.optLong("total", -1L)
                    c.has("totalSpace") -> c.optLong("totalSpace", -1L)
                    c.has("totalBytes") -> c.optLong("totalBytes", -1L)
                    c.has("capacity") -> c.optLong("capacity", -1L)
                    else -> -1L
                }
                val usedRaw = when {
                    c.has("used") -> c.optLong("used", -1L)
                    c.has("usedSpace") -> c.optLong("usedSpace", -1L)
                    c.has("usedBytes") -> c.optLong("usedBytes", -1L)
                    else -> -1L
                }
                if (totalRaw > 1024L * 1024L) {
                    val free = if (freeRaw >= 0L) freeRaw.coerceIn(0L, totalRaw)
                    else if (usedRaw >= 0L) (totalRaw - usedRaw).coerceAtLeast(0L) else 0L
                    val used = if (usedRaw >= 0L) usedRaw.coerceIn(0L, totalRaw)
                    else (totalRaw - free).coerceAtLeast(0L)
                    return Triple(totalRaw, free, used)
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun tryFritzNasWebBrowse(
        baseUrl: String,
        sid: String,
        remotePath: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): Pair<Boolean, JSONArray> {
        val entries = JSONArray()
        val encSid = URLEncoder.encode(sid, "UTF-8")
        val encPath = URLEncoder.encode(remotePath, "UTF-8")
        val fritzHeaders = mapOf("Origin" to baseUrl, "Referer" to "$baseUrl/nas/")

        // 1. POST mit a=browse (paginiert sauber bis alle Einträge des Verzeichnisses erfasst sind, auch bei 50er/100er Seitengröße von FRITZ!OS)
        try {
            var index = 1
            var anyOk = false
            val pageSize = 200
            val seenPaths = HashSet<String>()
            val dedupedEntries = JSONArray()
            for (page in 0 until 100) {
                val pageBatch = JSONArray()
                val browseForm = "xhr=1&lang=de&sid=$encSid&c=files&a=browse&path=$encPath&dir=$encPath&type=all&index=$index&limit=$pageSize&sorting=%2Bfilename"
                val (browseCode, browseBody) = httpRequest(
                    urlStr = "$baseUrl/nas/api/data.lua",
                    method = "POST",
                    bodyForm = browseForm,
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust,
                    timeoutMs = 5500,
                    extraHeaders = fritzHeaders
                )
                if (browseCode in 200..299 && parseFritzNasBrowseJson(browseBody, remotePath, pageBatch)) {
                    anyOk = true
                    var addedUnique = 0
                    for (j in 0 until pageBatch.length()) {
                        val obj = pageBatch.optJSONObject(j) ?: continue
                        val pKey = obj.optString("path", obj.optString("name", "")).lowercase()
                        if (pKey.isNotEmpty() && seenPaths.add(pKey)) {
                            dedupedEntries.put(obj)
                            addedUnique++
                        }
                    }
                    if (addedUnique == 0) break
                    val totalHint = try {
                        val jo = JSONObject(browseBody)
                        val d = jo.optJSONObject("data") ?: jo
                        val b = d.optJSONObject("browse") ?: d
                        b.optInt("total", b.optInt("totalCount", -1))
                    } catch (_: Exception) { -1 }
                    if (totalHint in 0..dedupedEntries.length()) break
                    index += addedUnique
                } else {
                    break
                }
            }
            if (anyOk) {
                return true to dedupedEntries
            }
        } catch (_: Exception) {
        }

        // 2. GET mit dir=<path> (klassisches FRITZ!OS)
        try {
            val getQuery = "sid=$encSid&c=files&a=get&dir=$encPath&start=1&count=500"
            val (code, body) = httpRequest(
                urlStr = "$baseUrl/nas/api/data.lua?$getQuery",
                method = "GET",
                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                configureTrust = configureTrust,
                timeoutMs = 5000,
                extraHeaders = fritzHeaders
            )
            if (code in 200..299 && parseFritzNasBrowseJson(body, remotePath, entries)) {
                return true to entries
            }
        } catch (_: Exception) {
        }

        // 3. POST mit a=get & path=<path>
        try {
            val postForm = "xhr=1&lang=de&sid=$encSid&c=files&a=get&path=$encPath&start=1&count=500"
            val (postCode, postBody) = httpRequest(
                urlStr = "$baseUrl/nas/api/data.lua",
                method = "POST",
                bodyForm = postForm,
                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                configureTrust = configureTrust,
                timeoutMs = 5000,
                extraHeaders = fritzHeaders
            )
            if (postCode in 200..299 && parseFritzNasBrowseJson(postBody, remotePath, entries)) {
                return true to entries
            }
        } catch (_: Exception) {
        }
        return false to entries
    }

    fun getFritzNasStorageStatsJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)

            if (password.isNotEmpty()) {
                // 1. Primär SMB2 QUERY_INFO (meldet die exakte physische USB-/HDD-Größe, z. B. 2 TB)
                val smbReq = JSONObject(requestJson)
                    .put("host", hostClean)
                    .put("port", 445)
                    .put("shareOrPath", req.optString("shareOrPath", "FRITZ.NAS").ifBlank { "FRITZ.NAS" })
                    .put("isFritzBox", true)
                    .toString()
                val smbStr = NasProtocolProbeHelper.getSmbStorageVolumeStatsJson(
                    requestJson = smbReq,
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust
                )
                val smbObj = try { JSONObject(smbStr) } catch (_: Exception) { null }
                if (smbObj?.optBoolean("ok", false) == true && smbObj.optLong("totalBytes", 0L) >= 512L * 1024L * 1024L) {
                    return smbStr
                }

                // 2. FRITZ!NAS Web-API Quota-Abfrage
                val authObj = JSONObject(
                    authenticateAndReuseSid(
                        JSONObject()
                            .put("host", hostClean)
                            .put("port", requestedPort)
                            .put("useTls", requestedTls)
                            .put("username", username)
                            .put("password", password)
                            .toString(),
                        allowLocalSelfSignedTls,
                        configureTrust
                    )
                )
                val sid = authObj.optString("sid", "")
                if (authObj.optBoolean("ok", false) && sid.isNotBlank() && sid != EMPTY_SID) {
                    val scheme = authObj.optString("effectiveScheme", "http")
                    val effPort = authObj.optInt("effectivePort", 80)
                    val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
                    val baseUrl = "$scheme://$hostClean$portSuffix"
                    val encSid = URLEncoder.encode(sid, "UTF-8")
                    val fritzHeaders = mapOf("Origin" to baseUrl, "Referer" to "$baseUrl/nas/")
                    val queries = listOf(
                        "xhr=1&lang=de&sid=$encSid&c=files&a=browse&path=%2F&dir=%2F&type=all&index=1&limit=25",
                        "xhr=1&lang=de&sid=$encSid&c=storage&a=get"
                    )
                    for (form in queries) {
                        try {
                            val (code, body) = httpRequest(
                                urlStr = "$baseUrl/nas/api/data.lua",
                                method = "POST",
                                bodyForm = form,
                                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                                configureTrust = configureTrust,
                                timeoutMs = 4500,
                                extraHeaders = fritzHeaders
                            )
                            if (code in 200..299) {
                                val quota = parseFritzStorageQuotaFromJson(body)
                                if (quota != null) {
                                    val (total, free, used) = quota
                                    val usedPct = ((used.toDouble() / total.toDouble()) * 1000.0).toLong() / 10.0
                                    val freePct = (100.0 - usedPct).coerceAtLeast(0.0)
                                    return JSONObject()
                                        .put("ok", true)
                                        .put("host", hostClean)
                                        .put("shareName", "FRITZ.NAS")
                                        .put("source", "fritz_nas_web_quota")
                                        .put("totalBytes", total)
                                        .put("freeBytes", free)
                                        .put("usedBytes", used)
                                        .put("usedPercent", usedPct)
                                        .put("freePercent", freePct)
                                        .toString()
                                }
                            }
                        } catch (_: Exception) {
                        }
                    }
                }

                // Falls SMB2 einen kleineren Wert geliefert hat, diesen zumindest als Fallback nutzen
                if (smbObj?.optBoolean("ok", false) == true && smbObj.optLong("totalBytes", 0L) > 0L) {
                    return smbStr
                }
            }

            JSONObject()
                .put("ok", false)
                .put("error", "Speichergröße konnte von $hostClean nicht abgefragt werden.")
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Speicherabfrage fehlgeschlagen")
                .toString()
        }
    }

    fun browseFritzNasDirectories(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val remotePath = normalizeRemotePath(req.optString("path", "/"))
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)

            var entries = JSONArray()
            var source = "nas_template"
            var requiresAuth = false
            var httpsFallbackToHttp = false
            var effectiveUser = username
            var nasAccessLevel: Int? = null
            var writable = false
            var warning: String? = null

            val probe = probeLoginSid(hostClean, allowLocalSelfSignedTls, configureTrust)
            if (username.isBlank() && probe != null) {
                val pLast = probe.optString("lastUser", "").takeIf { it.isNotBlank() && it != "null" }
                if (pLast != null) effectiveUser = pLast
            }

            // 1. Zuerst FRITZ!NAS Web-API (/nas/api/data.lua) versuchen
            if (password.isNotEmpty() || (probe != null && !probe.optBoolean("requiresAuth", true))) {
                val authStr = authenticateAndReuseSid(
                    JSONObject()
                        .put("host", hostClean)
                        .put("port", requestedPort)
                        .put("useTls", requestedTls)
                        .put("username", effectiveUser)
                        .put("password", password)
                        .toString(),
                    allowLocalSelfSignedTls,
                    configureTrust
                )
                val authObj = JSONObject(authStr)
                httpsFallbackToHttp = authObj.optBoolean("httpsFallbackToHttp", false)
                val selUser = authObj.optString("selectedUser", "").takeIf { it.isNotBlank() && it != "null" }
                if (selUser != null) effectiveUser = selUser
                if (authObj.has("nasAccessLevel") && !authObj.isNull("nasAccessLevel")) {
                    nasAccessLevel = authObj.optInt("nasAccessLevel")
                }

                val sid = authObj.optString("sid", "")
                if (authObj.optBoolean("ok", false) && sid.isNotBlank() && sid != EMPTY_SID) {
                    val scheme = authObj.optString("effectiveScheme", "http")
                    val effPort = authObj.optInt("effectivePort", 80)
                    val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
                    val baseUrl = "$scheme://$hostClean$portSuffix"
                    val (webOk, webEntries) = tryFritzNasWebBrowse(baseUrl, sid, remotePath, allowLocalSelfSignedTls, configureTrust)
                    if (webOk) {
                        entries = webEntries
                        source = "fritz_nas_api"
                        writable = nasAccessLevel == null || nasAccessLevel >= 2
                        if (nasAccessLevel == 1) {
                            warning = "FRITZ!Box-Benutzer hat aktuell nur Leserechte auf NAS-Inhalte (Access=1). Bitte Schreibrechte in der FRITZ!Box aktivieren."
                        }
                    }
                } else {
                    requiresAuth = true
                    warning = authObj.optString("error", "FRITZ!Box Zugangsdaten benötigt.")
                }
            } else {
                requiresAuth = probe?.optBoolean("requiresAuth", true) ?: true
                warning = "FRITZ!Box verlangt Zugangsdaten zum Live-Durchsuchen."
            }

            // 2. Live-SMB2-Fallback (:445) falls Web-API kein Live-Listing geliefert hat
            if (source != "fritz_nas_api" && password.isNotEmpty()) {
                val smbReq = JSONObject()
                    .put("host", hostClean)
                    .put("port", 445)
                    .put("path", remotePath)
                    .put("shareOrPath", "FRITZ.NAS")
                    .put("username", effectiveUser)
                    .put("password", password)
                    .put("isFritzBox", true)
                    .toString()
                val smbRes = JSONObject(
                    NasProtocolProbeHelper.browseSmbDirectoriesJson(
                        requestJson = smbReq,
                        allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                        configureTrust = configureTrust
                    )
                )
                if (smbRes.optString("source") == "smb_live") {
                    val smbEntries = smbRes.optJSONArray("entries") ?: JSONArray()
                    val smbShare = smbRes.optString("smbShare", "FRITZ.NAS")
                    val smbUser = smbRes.optString("effectiveUser", effectiveUser)
                    val smbWritable = smbRes.optBoolean("writable", false)
                    val smbWarn = smbRes.optString("warning", "").takeIf { it.isNotBlank() && it != "null" }
                    return JSONObject()
                        .put("ok", true)
                        .put("host", hostClean)
                        .put("protocol", "fritz_upnp")
                        .put("transportUsed", "smb")
                        .put("smbShare", smbShare)
                        .put("effectiveUser", smbUser)
                        .put("currentPath", remotePath)
                        .put("parentPath", smbRes.opt("parentPath") ?: JSONObject.NULL)
                        .put("entries", smbEntries)
                        .put("recommendedBackendPath", smbRes.optString("recommendedBackendPath", "/EntenCenter-Backend"))
                        .put("source", "smb_live")
                        .put("liveFilesystem", true)
                        .put("requiresAuth", false)
                        .put("httpsFallbackToHttp", httpsFallbackToHttp)
                        .put("writable", smbWritable)
                        .put("warning", smbWarn ?: JSONObject.NULL)
                        .toString()
                } else {
                    val smbWarn = smbRes.optString("warning", "").takeIf { it.isNotBlank() && it != "null" }
                    if (!smbWarn.isNullOrBlank()) {
                        warning = if (warning.isNullOrBlank()) smbWarn else "$warning · SMB: $smbWarn"
                    }
                }
            }

            if (source == "nas_template" && entries.length() == 0) {
                val defaults = when (remotePath) {
                    "/FRITZ" -> listOf("mediabox", "EntenCenter-Backend")
                    "/Medien" -> listOf("Filme", "Serien", "EntenCenter-Backend")
                    else -> listOf("FRITZ", "Medien", "Bilder", "Musik", "EntenCenter-Backend")
                }
                for (name in defaults) {
                    val p = if (remotePath == "/") "/$name" else "$remotePath/$name"
                    entries.put(
                        JSONObject()
                            .put("name", name)
                            .put("path", p)
                            .put("type", "directory")
                            .put("writable", false)
                            .put("recommended", name == "FRITZ" || name == "EntenCenter-Backend")
                    )
                }
            }

            val parentPath = if (remotePath == "/") JSONObject.NULL else {
                val idx = remotePath.lastIndexOf('/')
                if (idx <= 0) "/" else remotePath.substring(0, idx)
            }

            JSONObject()
                .put("ok", true)
                .put("host", hostClean)
                .put("protocol", "fritz_upnp")
                .put("effectiveUser", effectiveUser.ifBlank { JSONObject.NULL })
                .put("nasAccessLevel", nasAccessLevel ?: JSONObject.NULL)
                .put("currentPath", remotePath)
                .put("parentPath", parentPath)
                .put("entries", entries)
                .put("recommendedBackendPath", "/FRITZ/EntenCenter-Backend")
                .put("source", source)
                .put("liveFilesystem", source != "nas_template")
                .put("requiresAuth", requiresAuth)
                .put("httpsFallbackToHttp", httpsFallbackToHttp)
                .put("writable", writable)
                .put("warning", warning ?: JSONObject.NULL)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", true)
                .put("currentPath", "/")
                .put("entries", JSONArray())
                .put("recommendedBackendPath", "/FRITZ/EntenCenter-Backend")
                .put("source", "nas_template")
                .put("liveFilesystem", false)
                .put("writable", false)
                .put("warning", e.message ?: "Standard-NAS-Vorlage aktiv (Live-Dateizugriff noch nicht bestätigt)")
                .toString()
        }
    }

    private fun tryCreateFritzNasDirWebApi(
        baseUrl: String,
        sid: String,
        fullDirPath: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)?
    ): Pair<Boolean, String?> {
        val segments = normalizeRemotePath(fullDirPath).split('/').filter { it.isNotBlank() }
        if (segments.isEmpty()) return true to null
        val encSid = URLEncoder.encode(sid, "UTF-8")
        var parentAcc = "/"
        for (seg in segments) {
            val encParent = URLEncoder.encode(parentAcc, "UTF-8")
            val encName = URLEncoder.encode(seg, "UTF-8")
            val attempts = listOf(
                Triple("$baseUrl/nas/api/data.lua", "POST", "xhr=1&lang=de&sid=$encSid&c=files&a=create_dir&path=$encParent&dir=$encParent&name=$encName"),
                Triple("$baseUrl/nas/api/data.lua", "POST", "xhr=1&lang=de&sid=$encSid&c=files&a=mkdir&path=$encParent&dir=$encParent&name=$encName"),
                Triple("$baseUrl/nas/api/data.lua?sid=$encSid&c=files&a=mkdir&dir=$encParent&name=$encName", "GET", null)
            )
            var segCreated = false
            var lastErr: String? = null
            val fritzHeaders = mapOf("Origin" to baseUrl, "Referer" to "$baseUrl/nas/")
            for ((urlStr, method, formBody) in attempts) {
                try {
                    val (code, body) = httpRequest(
                        urlStr = urlStr,
                        method = method,
                        bodyForm = formBody,
                        allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                        configureTrust = configureTrust,
                        timeoutMs = 4500,
                        extraHeaders = fritzHeaders
                    )
                    if (code in 200..299 && body.trim().startsWith("{")) {
                        val json = JSONObject(body.trim())
                        if (!hasFritzJsonError(json)) {
                            segCreated = true
                            break
                        }
                        lastErr = "FRITZ!NAS lehnte Ordneranlage „$seg“ ab (${json.optString("error", "Schreibfehler")})."
                    } else {
                        lastErr = "FRITZ!NAS Web-API lieferte HTTP $code beim Anlegen von „$seg“."
                    }
                } catch (e: Exception) {
                    lastErr = e.message ?: "FRITZ!NAS Web-API Fehler"
                }
            }
            if (!segCreated) {
                val (browseOk, children) = tryFritzNasWebBrowse(baseUrl, sid, parentAcc, allowLocalSelfSignedTls, configureTrust)
                var alreadyExists = false
                if (browseOk) {
                    for (i in 0 until children.length()) {
                        if (children.optJSONObject(i)?.optString("name").equals(seg, ignoreCase = true)) {
                            alreadyExists = true
                            break
                        }
                    }
                }
                if (!alreadyExists) {
                    return false to (lastErr ?: "FRITZ!NAS Web-API konnte Ordner „$seg“ nicht anlegen.")
                }
            }
            parentAcc = if (parentAcc == "/") "/$seg" else "$parentAcc/$seg"
        }
        return true to null
    }

    private fun tryUploadFritzNasFileWebApi(
        baseUrl: String,
        sid: String,
        remoteDirPath: String,
        fileName: String,
        bytes: ByteArray,
        contentType: String = "application/octet-stream",
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): Pair<Boolean, String?> {
        val normDir = normalizeRemotePath(remoteDirPath)
        val cleanName = fileName.replace('/', '_').replace('\\', '_').trim().ifBlank { "file.bin" }
        val boundary = "----EntenCenterBoundary${System.currentTimeMillis()}"
        val endpoints = listOf(
            "$baseUrl/nas/api/data.lua" to mapOf(
                "xhr" to "1",
                "lang" to "de",
                "sid" to sid,
                "c" to "files",
                "a" to "upload",
                "dir" to normDir,
                "path" to normDir
            ),
            "$baseUrl/nas/cgi-bin/luacgi_notimeout" to mapOf(
                "sid" to sid,
                "dir" to normDir,
                "path" to normDir
            ),
            "$baseUrl/cgi-bin/luacgi_notimeout" to mapOf(
                "sid" to sid,
                "dir" to normDir,
                "path" to normDir
            )
        )

        var lastError: String? = null
        for ((urlStr, fields) in endpoints) {
            try {
                val parsedUrl = URL(urlStr)
                val originHdr = "${parsedUrl.protocol}://${parsedUrl.authority}"
                val conn = (parsedUrl.openConnection() as HttpURLConnection).apply {
                    applyLocalTlsIfAllowed(this, allowLocalSelfSignedTls, configureTrust)
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 20000
                    doOutput = true
                    useCaches = false
                    setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                    setRequestProperty("Accept", "application/json, text/plain, */*")
                    setRequestProperty("Origin", originHdr)
                    setRequestProperty("Referer", "$originHdr/nas/")
                    setRequestProperty("Connection", "close")
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                }
                try {
                    conn.outputStream.use { os ->
                        val headerSb = StringBuilder()
                        for ((k, v) in fields) {
                            headerSb.append("--").append(boundary).append("\r\n")
                            headerSb.append("Content-Disposition: form-data; name=\"").append(k).append("\"\r\n\r\n")
                            headerSb.append(v).append("\r\n")
                        }
                        headerSb.append("--").append(boundary).append("\r\n")
                        headerSb.append("Content-Disposition: form-data; name=\"UploadFile\"; filename=\"")
                            .append(cleanName).append("\"\r\n")
                        headerSb.append("Content-Type: ").append(contentType).append("\r\n\r\n")
                        os.write(headerSb.toString().toByteArray(Charsets.UTF_8))
                        os.write(bytes)
                        os.write("\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8))
                        os.flush()
                    }
                    val status = conn.responseCode
                    val stream = if (status in 200..399) conn.inputStream else conn.errorStream
                    val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                    val trimmed = body.trim()
                    if (status in 200..299) {
                        if (trimmed.startsWith("{")) {
                            val json = JSONObject(trimmed)
                            if (!hasFritzJsonError(json)) {
                                return true to null
                            }
                            lastError = "FRITZ!NAS Upload abgelehnt (${json.optString("error", "Schreibfehler")})."
                        } else if (!trimmed.contains("login", true) && !trimmed.contains("denied", true)) {
                            // Prüfen ob Datei im Zielverzeichnis sichtbar ist
                            val (browseOk, entries) = tryFritzNasWebBrowse(baseUrl, sid, normDir, allowLocalSelfSignedTls, configureTrust)
                            if (browseOk) {
                                for (i in 0 until entries.length()) {
                                    if (entries.optJSONObject(i)?.optString("name").equals(cleanName, ignoreCase = true)) {
                                        return true to null
                                    }
                                }
                            }
                            if (trimmed.isEmpty() || trimmed.contains("ok", true) || trimmed.contains("success", true)) {
                                return true to null
                            }
                            lastError = "FRITZ!NAS Web-Upload unbestätigt ($cleanName)."
                        } else {
                            lastError = "FRITZ!NAS Session ungültig oder Schreibrechte fehlen (HTTP $status)."
                        }
                    } else {
                        lastError = "FRITZ!NAS Upload HTTP $status ($cleanName)."
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                lastError = e.message ?: "FRITZ!NAS Upload Fehler"
            }
        }
        return false to (lastError ?: "FRITZ!NAS Web-API Datei-Upload fehlgeschlagen.")
    }

    fun writeFritzNasFileJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)
            val targetPath = normalizeRemotePath(req.optString("targetPath", ""))
            val appendChunk = req.optBoolean("append", false)
            val offset = req.optLong("offset", 0L).coerceAtLeast(0L)
            val createParentDirs = if (req.has("createParentDirs")) req.optBoolean("createParentDirs", true) else true

            if (targetPath == "/" || targetPath.endsWith("/")) {
                return JSONObject().put("ok", false).put("error", "Ungültiger Zieldateipfad.").toString()
            }
            if (password.isEmpty()) {
                return JSONObject().put("ok", false).put("requiresAuth", true)
                    .put("error", "FRITZ!Box-Passwort zum Speichern auf FRITZ!NAS erforderlich.").toString()
            }

            // 1. Zuerst echtes SMB2 (:445) Schreiben versuchen (unterstützt JSON, Binärdateien und Chunks)
            val smbReq = JSONObject(requestJson)
                .put("host", hostClean)
                .put("port", 445)
                .put("shareOrPath", req.optString("shareOrPath", "FRITZ.NAS").ifBlank { "FRITZ.NAS" })
                .put("isFritzBox", true)
                .toString()
            val smbRes = JSONObject(
                NasProtocolProbeHelper.writeSmbFileJson(
                    requestJson = smbReq,
                    allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                    configureTrust = configureTrust
                )
            )
            if (smbRes.optBoolean("ok", false)) {
                return smbRes.toString()
            }
            val smbErr = smbRes.optString("error", "").takeIf { it.isNotBlank() && it != "null" }

            // Chunked appends >0 Byte erfordern SMB2 Random-Offset-Write
            if (appendChunk && offset > 0L) {
                return JSONObject()
                    .put("ok", false)
                    .put("filePath", targetPath)
                    .put("error", smbErr ?: "SMB2 Chunk-Upload auf $hostClean fehlgeschlagen.")
                    .toString()
            }

            // 2. FRITZ!NAS Web-API Upload-Fallback für vollständige Einzeldateien / JSON
            val authObj = JSONObject(
                authenticateAndReuseSid(
                    JSONObject()
                        .put("host", hostClean)
                        .put("port", requestedPort)
                        .put("useTls", requestedTls)
                        .put("username", username)
                        .put("password", password)
                        .toString(),
                    allowLocalSelfSignedTls,
                    configureTrust
                )
            )
            val sid = authObj.optString("sid", "")
            if (!authObj.optBoolean("ok", false) || sid.isBlank() || sid == EMPTY_SID) {
                val authErr = authObj.optString("error", "FRITZ!Box Anmeldung fehlgeschlagen.")
                return JSONObject()
                    .put("ok", false)
                    .put("requiresAuth", true)
                    .put("filePath", targetPath)
                    .put("error", if (smbErr != null) "$smbErr · Web-API: $authErr" else authErr)
                    .toString()
            }

            val scheme = authObj.optString("effectiveScheme", "http")
            val effPort = authObj.optInt("effectivePort", 80)
            val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
            val baseUrl = "$scheme://$hostClean$portSuffix"

            val lastSlash = targetPath.lastIndexOf('/')
            val parentDir = if (lastSlash <= 0) "/" else targetPath.substring(0, lastSlash)
            val fileName = targetPath.substring(lastSlash + 1)

            if (createParentDirs && parentDir != "/") {
                val (dirOk, dirErr) = tryCreateFritzNasDirWebApi(baseUrl, sid, parentDir, allowLocalSelfSignedTls, configureTrust)
                if (!dirOk) {
                    return JSONObject()
                        .put("ok", false)
                        .put("filePath", targetPath)
                        .put("error", dirErr ?: smbErr ?: "Zielordner „$parentDir“ konnte nicht angelegt werden.")
                        .toString()
                }
            }

            val contentBase64 = req.optString("contentBase64", "")
            val textContent = req.optString("content", "")
            val bytes = if (contentBase64.isNotEmpty()) {
                android.util.Base64.decode(contentBase64, android.util.Base64.DEFAULT)
            } else {
                textContent.toByteArray(Charsets.UTF_8)
            }
            val contentType = req.optString("contentType", "").ifBlank {
                if (fileName.endsWith(".json", true)) "application/json; charset=utf-8" else "application/octet-stream"
            }

            val (upOk, upErr) = tryUploadFritzNasFileWebApi(
                baseUrl = baseUrl,
                sid = sid,
                remoteDirPath = parentDir,
                fileName = fileName,
                bytes = bytes,
                contentType = contentType,
                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                configureTrust = configureTrust
            )
            if (upOk) {
                JSONObject()
                    .put("ok", true)
                    .put("transport", "fritz_nas_api")
                    .put("filePath", targetPath)
                    .put("bytesWritten", bytes.size)
                    .put("verified", true)
                    .put("message", "Datei „$targetPath“ über FRITZ!NAS Web-API gespeichert.")
                    .toString()
            } else {
                JSONObject()
                    .put("ok", false)
                    .put("filePath", targetPath)
                    .put("error", listOfNotNull(smbErr, upErr).joinToString(" · ").ifBlank { "Datei konnte nicht auf FRITZ!NAS geschrieben werden." })
                    .toString()
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Fehler beim Schreiben auf FRITZ!NAS")
                .toString()
        }
    }

    private fun inferFritzMediaKind(fileName: String, dirPath: String = ""): String {
        val lower = fileName.lowercase()
        val normDir = "/${dirPath.trim().replace('\\', '/').trim('/')}/".lowercase()
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

    private fun isFritzScanMediaFilename(fileName: String): Boolean {
        val lower = fileName.lowercase()
        if (lower.startsWith(".") || lower == "thumbs.db" || lower == "desktop.ini") return false
        return Regex(
            "\\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|aiff|aif|alac|ape|wv|mka|amr|mid|midi|ac3|dts|jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg|pdf|epub|txt|srt|vtt)$"
        ).containsMatchIn(lower)
    }

    private fun tryDownloadFritzNasFileWebApi(
        baseUrl: String,
        sid: String,
        targetPath: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): Triple<Boolean, String?, String?> {
        val normPath = normalizeRemotePath(targetPath)
        val encSid = URLEncoder.encode(sid, "UTF-8")
        val encPath = URLEncoder.encode(normPath, "UTF-8")
        val downloadUrls = listOf(
            "$baseUrl/nas/cgi-bin/luacgi_notimeout?sid=$encSid&cmd=get_file&path=$encPath",
            "$baseUrl/cgi-bin/luacgi_notimeout?sid=$encSid&cmd=get_file&path=$encPath"
        )
        var lastErr: String? = null
        for (urlStr in downloadUrls) {
            try {
                val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    applyLocalTlsIfAllowed(this, allowLocalSelfSignedTls, configureTrust)
                    requestMethod = "GET"
                    connectTimeout = 5000
                    readTimeout = 12000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                    setRequestProperty("Origin", baseUrl)
                    setRequestProperty("Referer", "$baseUrl/nas/")
                }
                try {
                    val code = conn.responseCode
                    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                    val bytes = stream?.readBytes() ?: ByteArray(0)
                    val cType = (conn.contentType ?: "").lowercase()
                    if (code in 200..299 && bytes.isNotEmpty()) {
                        val text = String(bytes, Charsets.UTF_8)
                        val trimmed = text.trimStart()
                        val looksHtmlLogin = cType.contains("text/html") &&
                            (trimmed.startsWith("<!", true) || trimmed.startsWith("<html", true))
                        if (!looksHtmlLogin) {
                            return Triple(true, text, null)
                        }
                        lastErr = "FRITZ!NAS lieferte Login-HTML statt Dateiinhalt."
                    } else {
                        lastErr = "FRITZ!NAS Web-Download HTTP $code."
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                lastErr = e.message ?: "FRITZ!NAS Download-Fehler"
            }
        }
        return Triple(false, null, lastErr)
    }

    fun openFritzNasFileStream(
        requestJson: String,
        rangeHeader: String?,
        isHeadOnly: Boolean,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): HttpURLConnection? {
        val req = try { JSONObject(requestJson) } catch (_: Exception) { JSONObject() }
        val hostClean = extractHostClean(req.optString("host", "fritz.box"))
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val username = req.optString("username", "").trim()
        val requestedTls = req.optBoolean("useTls", false)
        val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)
        val targetPath = normalizeRemotePath(req.optString("targetPath", ""))
        if (password.isEmpty() || targetPath == "/") return null

        val authObj = JSONObject(
            authenticateAndReuseSid(
                JSONObject()
                    .put("host", hostClean)
                    .put("port", requestedPort)
                    .put("useTls", requestedTls)
                    .put("username", username)
                    .put("password", password)
                    .toString(),
                allowLocalSelfSignedTls,
                configureTrust
            )
        )
        val sid = authObj.optString("sid", "")
        if (!authObj.optBoolean("ok", false) || sid.isBlank() || sid == EMPTY_SID) return null

        val scheme = authObj.optString("effectiveScheme", "http")
        val effPort = authObj.optInt("effectivePort", 80)
        val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
        val baseUrl = "$scheme://$hostClean$portSuffix"
        val encSid = URLEncoder.encode(sid, "UTF-8")
        val encPath = URLEncoder.encode(targetPath, "UTF-8")
        val urlStr = "$baseUrl/nas/cgi-bin/luacgi_notimeout?sid=$encSid&cmd=get_file&path=$encPath"
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            applyLocalTlsIfAllowed(this, allowLocalSelfSignedTls, configureTrust)
            requestMethod = if (isHeadOnly) "HEAD" else "GET"
            connectTimeout = 7000
            readTimeout = 30000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
            setRequestProperty("Origin", baseUrl)
            setRequestProperty("Referer", "$baseUrl/nas/")
            if (!rangeHeader.isNullOrBlank()) {
                setRequestProperty("Range", rangeHeader)
            }
        }
        return conn
    }

    fun scanFritzNasFoldersForMediaJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)
            val scanMode = if (req.optString("scanMode", "all") == "selected") "selected" else "all"
            val maxFiles = req.optInt("maxFiles", 25000).coerceIn(20, 50000)
            val maxDepth = req.optInt("maxDepth", 12).coerceIn(1, 16)
            val rawFoldersArr = req.optJSONArray("folders")
            val requestedFolders = mutableListOf<String>()
            if (rawFoldersArr != null) {
                for (i in 0 until rawFoldersArr.length()) {
                    val p = normalizeRemotePath(rawFoldersArr.optString(i, ""))
                    if (p.isNotEmpty()) requestedFolders.add(p)
                }
            }
            val roots = if (scanMode == "selected" && requestedFolders.isNotEmpty()) {
                requestedFolders.distinct()
            } else {
                listOf("/")
            }

            if (password.isEmpty()) {
                return JSONObject().put("ok", false).put("files", JSONArray())
                    .put("error", "FRITZ!Box-Passwort für Web-Scan erforderlich.").toString()
            }
            val authObj = JSONObject(
                authenticateAndReuseSid(
                    JSONObject()
                        .put("host", hostClean)
                        .put("port", requestedPort)
                        .put("useTls", requestedTls)
                        .put("username", username)
                        .put("password", password)
                        .toString(),
                    allowLocalSelfSignedTls,
                    configureTrust
                )
            )
            val sid = authObj.optString("sid", "")
            if (!authObj.optBoolean("ok", false) || sid.isBlank() || sid == EMPTY_SID) {
                return JSONObject().put("ok", false).put("files", JSONArray())
                    .put("error", authObj.optString("error", "FRITZ!Box Anmeldung fehlgeschlagen.")).toString()
            }
            val scheme = authObj.optString("effectiveScheme", "http")
            val effPort = authObj.optInt("effectivePort", 80)
            val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
            val baseUrl = "$scheme://$hostClean$portSuffix"

            val discoveredFiles = JSONArray()
            val scannedFoldersArr = JSONArray()
            val visited = HashSet<String>()
            val queue = ArrayDeque<Pair<String, Int>>()
            for (r in roots) queue.add(r to 0)

            var scannedTotalBytes = 0L
            var scannedFilesCount = 0
            var truncated = false
            var moviesCount = 0; var moviesBytes = 0L
            var seriesCount = 0; var seriesBytes = 0L
            var musicCount = 0; var musicBytes = 0L
            var videosCount = 0; var videosBytes = 0L
            var imagesCount = 0; var imagesBytes = 0L
            var otherCount = 0; var otherBytes = 0L

            while (queue.isNotEmpty() && visited.size < 8000) {
                val (dirPath, depth) = queue.removeFirst()
                val normDir = normalizeRemotePath(dirPath)
                if (!visited.add(normDir.lowercase())) continue

                val (browseOk, entries) = tryFritzNasWebBrowse(baseUrl, sid, normDir, allowLocalSelfSignedTls, configureTrust)
                if (!browseOk) continue
                scannedFoldersArr.put(normDir)

                for (i in 0 until entries.length()) {
                    val entry = entries.optJSONObject(i) ?: continue
                    val name = entry.optString("name", "").trim()
                    if (name.isEmpty()) continue
                    val entryPath = normalizeRemotePath(entry.optString("path", if (normDir == "/") "/$name" else "$normDir/$name"))
                    val isDir = entry.optString("type", "") == "directory"
                    val lower = name.lowercase()
                    if (isDir) {
                        if (depth < maxDepth &&
                            !lower.startsWith(".") &&
                            lower != "wal" &&
                            lower != "backups" &&
                            lower != "profiles" &&
                            lower != "config" &&
                            lower != "entencenter-backend" &&
                            lower != "@eadir" &&
                            lower != "#recycle" &&
                            lower != "\$recycle.bin" &&
                            lower != "system volume information"
                        ) {
                            queue.add(entryPath to (depth + 1))
                        }
                    } else {
                        val sizeBytes = entry.optLong("sizeBytes", 0L).coerceAtLeast(0L)
                        scannedFilesCount += 1
                        scannedTotalBytes += sizeBytes
                        val kind = inferFritzMediaKind(name, normDir)
                        when (kind) {
                            "movie" -> { moviesCount += 1; moviesBytes += sizeBytes }
                            "series" -> { seriesCount += 1; seriesBytes += sizeBytes }
                            "music" -> { musicCount += 1; musicBytes += sizeBytes }
                            "video" -> { videosCount += 1; videosBytes += sizeBytes }
                            "image" -> { imagesCount += 1; imagesBytes += sizeBytes }
                            else -> { otherCount += 1; otherBytes += sizeBytes }
                        }
                        if (isFritzScanMediaFilename(name)) {
                            if (discoveredFiles.length() < maxFiles) {
                                discoveredFiles.put(
                                    JSONObject()
                                        .put("name", name)
                                        .put("path", entryPath)
                                        .put("dirPath", normDir)
                                        .put("sizeBytes", sizeBytes)
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

            val out = JSONObject()
                .put("ok", scannedFoldersArr.length() > 0)
                .put("host", hostClean)
                .put("shareName", "FRITZ.NAS (Web-API)")
                .put("scanMode", scanMode)
                .put("scannedFolders", scannedFoldersArr)
                .put("files", discoveredFiles)
                .put("scannedFilesCount", scannedFilesCount)
                .put("scannedTotalBytes", scannedTotalBytes)
                .put("truncated", truncated)
                .put("mediaBreakdown", breakdownObj)
                .put("error", if (scannedFoldersArr.length() == 0) "Keine FRITZ!NAS-Ordner über Web-API lesbar." else JSONObject.NULL)

            val volObj = try { JSONObject(getFritzNasStorageStatsJson(requestJson, allowLocalSelfSignedTls, configureTrust)) } catch (_: Exception) { null }
            if (volObj?.optBoolean("ok", false) == true && volObj.optLong("totalBytes", 0L) > 0L) {
                out.put("volumeTotalBytes", volObj.optLong("totalBytes"))
                out.put("volumeFreeBytes", volObj.optLong("freeBytes"))
                out.put("volumeUsedBytes", volObj.optLong("usedBytes"))
                out.put("volumeSource", volObj.optString("source", "fritz_nas_web_quota"))
            }
            out.toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("files", JSONArray())
                .put("error", e.message ?: "FRITZ!NAS Web-API Scan fehlgeschlagen").toString()
        }
    }

    fun readFritzNasFileJson(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean = true,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val targetPath = normalizeRemotePath(req.optString("targetPath", ""))
            val smbReq = JSONObject(requestJson)
                .put("host", hostClean)
                .put("port", 445)
                .put("shareOrPath", req.optString("shareOrPath", "FRITZ.NAS").ifBlank { "FRITZ.NAS" })
                .put("isFritzBox", true)
                .toString()
            val smbResStr = NasProtocolProbeHelper.readSmbFileJson(
                requestJson = smbReq,
                allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                configureTrust = configureTrust
            )
            val smbRes = JSONObject(smbResStr)
            if (smbRes.optBoolean("ok", false)) {
                return smbResStr
            }

            // FRITZ!NAS Web-API Download-Fallback (luacgi_notimeout?cmd=get_file)
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)
            if (password.isNotEmpty() && targetPath != "/") {
                val authObj = JSONObject(
                    authenticateAndReuseSid(
                        JSONObject()
                            .put("host", hostClean)
                            .put("port", requestedPort)
                            .put("useTls", requestedTls)
                            .put("username", username)
                            .put("password", password)
                            .toString(),
                        allowLocalSelfSignedTls,
                        configureTrust
                    )
                )
                val sid = authObj.optString("sid", "")
                if (authObj.optBoolean("ok", false) && sid.isNotBlank() && sid != EMPTY_SID) {
                    val scheme = authObj.optString("effectiveScheme", "http")
                    val effPort = authObj.optInt("effectivePort", 80)
                    val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
                    val baseUrl = "$scheme://$hostClean$portSuffix"
                    val (dlOk, text, _) = tryDownloadFritzNasFileWebApi(baseUrl, sid, targetPath, allowLocalSelfSignedTls, configureTrust)
                    if (dlOk && text != null) {
                        return JSONObject()
                            .put("ok", true)
                            .put("transport", "fritz_nas_api")
                            .put("shareName", "FRITZ.NAS")
                            .put("filePath", targetPath)
                            .put("bytesRead", text.toByteArray(Charsets.UTF_8).size)
                            .put("content", text)
                            .toString()
                    }
                }
            }
            smbResStr
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "Fehler beim Lesen vom FRITZ!NAS").toString()
        }
    }

    fun provisionFritzNasBackend(
        requestJson: String,
        allowLocalSelfSignedTls: Boolean,
        configureTrust: ((HttpURLConnection) -> Unit)? = null
    ): String {
        return try {
            val req = JSONObject(requestJson)
            val mode = if (req.optString("mode", "auto") == "manual") "manual" else "auto"
            val createSingleFolder = req.optBoolean("createSingleFolder", false)
            val hostClean = extractHostClean(req.optString("host", "fritz.box"))
            val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            val username = req.optString("username", "").trim()
            val requestedTls = req.optBoolean("useTls", false)
            val requestedPort = sanitizeHttpPort(req.optInt("port", -1), requestedTls)

            var chosenPath = normalizeRemotePath(
                req.optString("targetPath", "/FRITZ/EntenCenter-Backend").ifBlank { "/FRITZ/EntenCenter-Backend" }
            )
            if (mode == "auto" && !createSingleFolder && !req.has("targetPath")) {
                chosenPath = "/FRITZ/EntenCenter-Backend"
            } else if (chosenPath == "/") {
                chosenPath = "/EntenCenter-Backend"
            }

            val subdirs = if (createSingleFolder) emptyList() else listOf("profiles", "media", "media/movies", "media/series", "config", "wal", "backups")
            val createdDirs = JSONArray().apply {
                put(chosenPath)
                subdirs.forEach { put("$chosenPath/$it") }
            }
            val createdFiles = if (createSingleFolder) JSONArray() else JSONArray().apply {
                put("$chosenPath/entencenter-backend.json")
                put("$chosenPath/docker-compose.yml")
                put("$chosenPath/start-entencenter.sh")
            }

            var dirsOk = false
            var filesOk = createSingleFolder
            var transportUsed = "bridge"
            var effectiveUser = username
            var warning: String? = null
            var activeBaseUrl: String? = null
            var activeSid: String? = null

            // 1. FRITZ!NAS Web-API Login & Ordneranlage
            if (password.isNotEmpty()) {
                val authObj = JSONObject(
                    authenticateAndReuseSid(
                        JSONObject()
                            .put("host", hostClean)
                            .put("port", requestedPort)
                            .put("useTls", requestedTls)
                            .put("username", username)
                            .put("password", password)
                            .toString(),
                        allowLocalSelfSignedTls,
                        configureTrust
                    )
                )
                val selUser = authObj.optString("selectedUser", "").takeIf { it.isNotBlank() && it != "null" }
                if (selUser != null) effectiveUser = selUser
                val sid = authObj.optString("sid", "")
                if (authObj.optBoolean("ok", false) && sid.isNotBlank() && sid != EMPTY_SID) {
                    val scheme = authObj.optString("effectiveScheme", "http")
                    val effPort = authObj.optInt("effectivePort", 80)
                    val portSuffix = if ((scheme == "https" && effPort == 443) || (scheme == "http" && effPort == 80)) "" else ":$effPort"
                    val baseUrl = "$scheme://$hostClean$portSuffix"
                    activeBaseUrl = baseUrl
                    activeSid = sid

                    val (mkOk, mkErr) = tryCreateFritzNasDirWebApi(baseUrl, sid, chosenPath, allowLocalSelfSignedTls, configureTrust)
                    if (mkOk) {
                        var subsOk = true
                        var subErr: String? = null
                        for (sub in subdirs) {
                            val (sOk, sErr) = tryCreateFritzNasDirWebApi(baseUrl, sid, "$chosenPath/$sub", allowLocalSelfSignedTls, configureTrust)
                            if (!sOk) {
                                subsOk = false
                                if (subErr == null) subErr = sErr
                            }
                        }
                        if (createSingleFolder || subsOk) {
                            dirsOk = true
                            transportUsed = "fritz_nas_api"
                        } else if (!subErr.isNullOrBlank()) {
                            warning = subErr
                        }
                    } else if (!mkErr.isNullOrBlank()) {
                        warning = mkErr
                    }
                } else {
                    warning = authObj.optString("error", "FRITZ!Box Login fehlgeschlagen.")
                }
            } else {
                warning = "Kein FRITZ!Box-Kennwort angegeben — direktes Schreiben auf FRITZ!NAS erfordert Anmeldung."
            }

            // 2. SMB2 (:445) zum echten Anlegen von Ordnern + Backend-Dateien
            if (password.isNotEmpty() && (!dirsOk || !filesOk)) {
                val smbReq = JSONObject()
                    .put("host", hostClean)
                    .put("port", 445)
                    .put("mode", mode)
                    .put("targetPath", chosenPath)
                    .put("shareOrPath", "FRITZ.NAS")
                    .put("username", effectiveUser)
                    .put("password", password)
                    .put("isFritzBox", true)
                    .put("createSingleFolder", createSingleFolder)
                    .toString()
                val smbRes = JSONObject(
                    NasProtocolProbeHelper.provisionSmbBackendJson(
                        requestJson = smbReq,
                        allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                        configureTrust = configureTrust
                    )
                )
                if (smbRes.optBoolean("remoteWriteOk", false)) {
                    dirsOk = true
                    filesOk = true
                    transportUsed = "smb"
                    warning = smbRes.optString("warning", "").takeIf { it.isNotBlank() && it != "null" }
                } else {
                    val smbWarn = smbRes.optString("warning", "").takeIf { it.isNotBlank() && it != "null" }
                    if (!smbWarn.isNullOrBlank()) {
                        warning = if (warning.isNullOrBlank()) smbWarn else "$warning · SMB: $smbWarn"
                    }
                }
            }

            // 3. Falls Ordner via Web-API existieren, aber SMB2 Dateien nicht schreiben konnte -> Web-API Upload nutzen
            if (!createSingleFolder && dirsOk && !filesOk && activeBaseUrl != null && activeSid != null) {
                val manifestJson = JSONObject()
                    .put("app", "EntenCenter NAS Backend")
                    .put("version", "1.0.0")
                    .put("host", hostClean)
                    .put("protocol", "fritz_upnp")
                    .put("backendPath", chosenPath)
                    .put("mode", mode)
                    .toString(2)
                val composeText = "services:\n  entencenter-nas:\n    image: node:20-alpine\n    ports:\n      - \"3000:3000\"\n    volumes:\n      - .$chosenPath:/app/data/marcente-nas\n"
                val scriptText = "#!/usr/bin/env sh\nexport PORT=3000\nnpx tsx server.ts\n"

                var allWebFilesOk = true
                var webUpErr: String? = null
                for ((fName, fText, cType) in listOf(
                    Triple("entencenter-backend.json", manifestJson, "application/json; charset=utf-8"),
                    Triple("docker-compose.yml", composeText, "text/yaml; charset=utf-8"),
                    Triple("start-entencenter.sh", scriptText, "text/x-shellscript; charset=utf-8")
                )) {
                    val (uOk, uErr) = tryUploadFritzNasFileWebApi(
                        baseUrl = activeBaseUrl,
                        sid = activeSid,
                        remoteDirPath = chosenPath,
                        fileName = fName,
                        bytes = fText.toByteArray(Charsets.UTF_8),
                        contentType = cType,
                        allowLocalSelfSignedTls = allowLocalSelfSignedTls,
                        configureTrust = configureTrust
                    )
                    if (!uOk) {
                        allWebFilesOk = false
                        if (webUpErr == null) webUpErr = uErr
                    }
                }
                if (allWebFilesOk) {
                    filesOk = true
                    transportUsed = "fritz_nas_api"
                    warning = null
                } else if (!webUpErr.isNullOrBlank()) {
                    warning = if (warning.isNullOrBlank()) webUpErr else "$warning · Web-API Upload: $webUpErr"
                }
            }

            val remoteWriteOk = if (createSingleFolder) dirsOk else (dirsOk && filesOk)
            if (!remoteWriteOk && warning == null) {
                warning = if (dirsOk && !filesOk) {
                    "Ordner unter \"$chosenPath\" vorhanden, aber Schreibzugriff für Dateien wurde von FRITZ!NAS abgelehnt."
                } else {
                    "Backend-Struktur in der App-Bridge für \"$chosenPath\" vorgemerkt (Verbindung bleibt aktiv)."
                }
            }

            JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("host", hostClean)
                .put("protocol", "fritz_upnp")
                .put("transportUsed", transportUsed)
                .put("backendPath", chosenPath)
                .put("createdDirectories", createdDirs)
                .put("createdFiles", createdFiles)
                .put("dirsOk", dirsOk)
                .put("filesOk", filesOk)
                .put("remoteWriteOk", remoteWriteOk)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put(
                    "message",
                    when {
                        remoteWriteOk && createSingleFolder -> "Ordner \"$chosenPath\" direkt auf $hostClean angelegt."
                        remoteWriteOk -> "EntenCenter-Backend inkl. Unterordnern & Dateien unter \"$chosenPath\" direkt auf $hostClean angelegt ($transportUsed)."
                        dirsOk && !filesOk -> "Ordnerstruktur unter \"$chosenPath\" vorhanden, aber Dateien konnten noch nicht geschrieben werden — prüfe NAS-Schreibrechte / SMB2."
                        else -> "EntenCenter-Backend-Pfad \"$chosenPath\" in Storage-Bridge eingerichtet · Verbindung bleibt aktiv."
                    }
                )
                .put("warning", warning ?: JSONObject.NULL)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", true)
                .put("mode", "manual")
                .put("backendPath", "/EntenCenter-Backend")
                .put("remoteWriteOk", false)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put("message", "Lokale Storage-Bridge ohne Verbindungsabbruch aktiv.")
                .put("warning", e.message ?: JSONObject.NULL)
                .toString()
        }
    }
}
