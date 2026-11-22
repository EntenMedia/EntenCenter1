package de.entencenter.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.ConnectException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.SocketChannel
import java.nio.charset.Charset
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var rootContainer: FrameLayout

    private val scanInProgress = AtomicBoolean(false)
    @Volatile
    private var lastScanResultJson: String = "{\"scanning\":false,\"devices\":[]}"
    private val scanExecutor = Executors.newSingleThreadExecutor()

    private val deepDiagInProgress = AtomicBoolean(false)
    @Volatile
    private var lastDeepDiagResultJson: String = "{\"running\":false,\"result\":null}"
    private val deepDiagExecutor = Executors.newSingleThreadExecutor()

    private val chromecastHelper by lazy { ChromecastBridgeHelper(applicationContext) }

    private val localProxyToken: String = run {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        bytes.joinToString("") { "%02x".format(it) }
    }
    private val localProxySources = ConcurrentHashMap<String, JSONObject>()
    private val localProxyExecutor = Executors.newCachedThreadPool()
    @Volatile
    private var localProxySocket: ServerSocket? = null
    @Volatile
    private var localProxyPort: Int = 0
    private val localProxyRunning = AtomicBoolean(false)

    @Volatile
    private var lastInsetTopDp: Float = 0f
    @Volatile
    private var lastInsetBottomDp: Float = 0f
    @Volatile
    private var lastInsetLeftDp: Float = 0f
    @Volatile
    private var lastInsetRightDp: Float = 0f
    @Volatile
    private var pageLoadedForInsets: Boolean = false

    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val granted =
            (grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true) ||
            (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true)
        val origin = pendingGeoOrigin
        val callback = pendingGeoCallback
        pendingGeoOrigin = null
        pendingGeoCallback = null
        if (origin != null && callback != null) {
            callback.invoke(origin, granted, false)
        }
    }

    private fun isTabletDevice(): Boolean {
        val cfg = resources.configuration
        return cfg.smallestScreenWidthDp >= 600 ||
            (cfg.screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK) >= Configuration.SCREENLAYOUT_SIZE_LARGE
    }

    private fun buildDisplayInsetsJson(): String {
        return JSONObject()
            .put("isNativeApp", true)
            .put("isTablet", isTabletDevice())
            .put("isTouch", true)
            .put("nativeContainerPadded", true)
            .put("topInsetDp", lastInsetTopDp.toDouble())
            .put("bottomInsetDp", lastInsetBottomDp.toDouble())
            .put("leftInsetDp", lastInsetLeftDp.toDouble())
            .put("rightInsetDp", lastInsetRightDp.toDouble())
            .toString()
    }

    private fun dispatchDisplayInsetsToWebView() {
        if (!pageLoadedForInsets || !::webView.isInitialized) return
        val json = buildDisplayInsetsJson()
        val js = "window.__entencenterNativeInsets = $json; window.dispatchEvent(new CustomEvent('entencenter-native-insets', { detail: $json }));"
        webView.post {
            webView.evaluateJavascript(js, null)
        }
    }

    companion object {
        private const val PREFS_NAME = "entencenter_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_PREFERRED_ALT_PORT = "preferred_alt_port"
        private const val KEY_ONBOARDING_BUFFER = "onboarding_buffer_json"
        private const val KEY_SHARED_NAS_CERT_PEM = "shared_nas_cert_pem"
        private const val KEY_ALLOW_LOCAL_SELF_SIGNED_TLS = "allow_local_self_signed_tls"
        private const val LOCAL_APP_HOST = "app.entencenter.local"
        private const val LOCAL_APP_ENTRY = "https://$LOCAL_APP_HOST/index.html"
        private const val DEFAULT_SERVER_URL = ""
        private val ALTERNATIVE_ENTENCENTER_PORTS = listOf(3001, 3002, 3005, 3010, 8000, 8080, 8081, 8443, 8888, 9000, 9090)
    }

    private fun isAllowLocalSelfSignedTlsEnabled(): Boolean {
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getBoolean(KEY_ALLOW_LOCAL_SELF_SIGNED_TLS, true)
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun getPlatform(): String = "android"

        @JavascriptInterface
        fun getDefaultServerUrl(): String = DEFAULT_SERVER_URL

        @JavascriptInterface
        fun getSavedServerUrl(): String {
            return getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_SERVER_URL, "") ?: ""
        }

        @JavascriptInterface
        fun setSavedServerUrl(url: String?): Boolean {
            val clean = url?.trim()?.trimEnd('/') ?: ""
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .apply {
                    if (clean.isEmpty()) remove(KEY_SERVER_URL) else putString(KEY_SERVER_URL, clean)
                }
                .apply()
            return true
        }

        @JavascriptInterface
        fun getLocalOnboardingBuffer(): String {
            val stored = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_ONBOARDING_BUFFER, "") ?: ""
            return SecureVaultHelper.decryptString(stored)
        }

        @JavascriptInterface
        fun setLocalOnboardingBuffer(jsonPayload: String?): Boolean {
            val clean = jsonPayload?.trim() ?: ""
            val valueToStore = if (clean.isEmpty()) "" else SecureVaultHelper.encryptString(clean)
            if (clean.isNotEmpty() && valueToStore.isEmpty()) return false
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .apply {
                    if (valueToStore.isEmpty()) remove(KEY_ONBOARDING_BUFFER) else putString(KEY_ONBOARDING_BUFFER, valueToStore)
                }
                .apply()
            return true
        }

        @JavascriptInterface
        fun clearLocalOnboardingBuffer(): Boolean {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .remove(KEY_ONBOARDING_BUFFER)
                .apply()
            return true
        }

        @JavascriptInterface
        fun isKeystoreProtected(): Boolean = SecureVaultHelper.isKeystoreAvailable()

        @JavascriptInterface
        fun saveEncryptedNasVault(jsonPayload: String?): Boolean {
            return SecureVaultHelper.saveMultiNasVault(applicationContext, jsonPayload)
        }

        @JavascriptInterface
        fun loadEncryptedNasVault(): String {
            return SecureVaultHelper.loadMultiNasVault(applicationContext)
        }

        @JavascriptInterface
        fun clearEncryptedNasVault(): Boolean {
            return SecureVaultHelper.clearMultiNasVault(applicationContext)
        }

        @JavascriptInterface
        fun diagnoseServerConnection(rawUrl: String?): String {
            return performServerDiagnosis(rawUrl ?: "")
        }

        @JavascriptInterface
        fun nativeHttpRequest(requestJson: String?): String {
            return executeNativeHttpRequest(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun startLocalNetworkScan(): Boolean {
            if (scanInProgress.compareAndSet(false, true)) {
                lastScanResultJson = JSONObject()
                    .put("scanning", true)
                    .put("devices", JSONArray())
                    .toString()
                scanExecutor.execute {
                    try {
                        val devices = performNativeNetworkDiscovery()
                        lastScanResultJson = JSONObject()
                            .put("scanning", false)
                            .put("devices", devices)
                            .toString()
                    } catch (_: Exception) {
                        lastScanResultJson = JSONObject()
                            .put("scanning", false)
                            .put("devices", JSONArray())
                            .toString()
                    } finally {
                        scanInProgress.set(false)
                    }
                }
            }
            return true
        }

        @JavascriptInterface
        fun getLocalNetworkScanResult(): String = lastScanResultJson

        @JavascriptInterface
        fun getPreferredAlternativePort(): Int {
            val saved = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getInt(KEY_PREFERRED_ALT_PORT, 3001)
            return if (saved in 1..65535 && saved != 3000) saved else 3001
        }

        @JavascriptInterface
        fun setPreferredAlternativePort(port: Int): Boolean {
            val safePort = if (port in 1..65535 && port != 3000) port else 3001
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putInt(KEY_PREFERRED_ALT_PORT, safePort)
                .apply()
            return true
        }

        @JavascriptInterface
        fun scanAlternativePorts(rawTarget: String?): String {
            return performAlternativePortScan(rawTarget ?: "", getPreferredAlternativePort())
        }

        @JavascriptInterface
        fun scanAlternativePortsWithPref(rawTarget: String?, preferredAltPort: Int): String {
            val safeAlt = if (preferredAltPort in 1..65535 && preferredAltPort != 3000) {
                preferredAltPort
            } else {
                getPreferredAlternativePort()
            }
            return performAlternativePortScan(rawTarget ?: "", safeAlt)
        }

        @JavascriptInterface
        fun runDeepNetworkDiagnostics(rawTarget: String?): String {
            return performDeepNetworkDiagnostics(rawTarget ?: "")
        }

        @JavascriptInterface
        fun startDeepNetworkDiagnostics(rawTarget: String?): Boolean {
            if (deepDiagInProgress.compareAndSet(false, true)) {
                lastDeepDiagResultJson = JSONObject()
                    .put("running", true)
                    .put("result", JSONObject.NULL)
                    .toString()
                val targetCopy = rawTarget ?: ""
                deepDiagExecutor.execute {
                    try {
                        val diagJsonStr = performDeepNetworkDiagnostics(targetCopy)
                        lastDeepDiagResultJson = JSONObject()
                            .put("running", false)
                            .put("result", JSONObject(diagJsonStr))
                            .toString()
                    } catch (e: Exception) {
                        lastDeepDiagResultJson = JSONObject()
                            .put("running", false)
                            .put("error", e.message ?: "Netzwerkanalyse fehlgeschlagen")
                            .put("result", JSONObject.NULL)
                            .toString()
                    } finally {
                        deepDiagInProgress.set(false)
                    }
                }
            }
            return true
        }

        @JavascriptInterface
        fun getDeepNetworkDiagnosticsResult(): String = lastDeepDiagResultJson

        @JavascriptInterface
        fun setSharedNasCertificate(pem: String?): Boolean {
            val clean = pem?.trim() ?: ""
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .apply {
                    if (clean.isEmpty()) remove(KEY_SHARED_NAS_CERT_PEM)
                    else putString(KEY_SHARED_NAS_CERT_PEM, clean)
                }
                .apply()
            return true
        }

        @JavascriptInterface
        fun getSharedNasCertificate(): String {
            return getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_SHARED_NAS_CERT_PEM, "") ?: ""
        }

        @JavascriptInterface
        fun getDisplayInsetsInfo(): String = buildDisplayInsetsJson()

        @JavascriptInterface
        fun getAllowLocalSelfSignedTls(): Boolean = isAllowLocalSelfSignedTlsEnabled()

        @JavascriptInterface
        fun setAllowLocalSelfSignedTls(enabled: Boolean): Boolean {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ALLOW_LOCAL_SELF_SIGNED_TLS, enabled)
                .apply()
            return true
        }

        @JavascriptInterface
        fun fritzBoxChallengeLogin(requestJson: String?): String {
            return FritzBoxSessionHelper.authenticateAndReuseSid(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun browseFritzNasDirectories(requestJson: String?): String {
            return FritzBoxSessionHelper.browseFritzNasDirectories(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun provisionFritzNasBackend(requestJson: String?): String {
            return FritzBoxSessionHelper.provisionFritzNasBackend(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun browseNasDirectories(requestJson: String?): String {
            return performGenericNasBrowse(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun provisionNasBackend(requestJson: String?): String {
            return performGenericNasProvision(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun scanFritzUpnp(): String {
            return performQuickFritzTr064Probe().toString()
        }

        @JavascriptInterface
        fun probeUniversalNas(requestJson: String?): String {
            return NasProtocolProbeHelper.probeUniversalNasJson(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun testNasProtocolConnection(requestJson: String?): String {
            return NasProtocolProbeHelper.testSingleProtocolJson(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun probeBridgeNasHealth(requestJson: String?): String {
            return NasProtocolProbeHelper.probeBridgeNasHealthJson(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun wakeNasDevice(requestJson: String?): String {
            return NasProtocolProbeHelper.wakeNasDeviceJson(
                requestJson = requestJson ?: "{}",
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        }

        @JavascriptInterface
        fun writeNasFile(requestJson: String?): String {
            return performGenericNasWriteFile(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun readNasFile(requestJson: String?): String {
            return performGenericNasReadFile(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun scanNasMediaFolders(requestJson: String?): String {
            return performGenericNasScanMediaFolders(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun getLocalNasStreamUrl(requestJson: String?): String {
            return registerLocalNasStreamSource(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun getNasStorageStats(requestJson: String?): String {
            return performGenericNasStorageStats(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun openExternalMediaPlayer(url: String?, mimeType: String?, title: String?): Boolean {
            val cleanUrl = (url ?: "").trim()
            if (!cleanUrl.startsWith("http://", ignoreCase = true) &&
                !cleanUrl.startsWith("https://", ignoreCase = true)
            ) {
                return false
            }
            val cleanMime = (mimeType ?: "").split(';').firstOrNull()?.trim()
                ?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
                ?: inferStreamMimeType(cleanUrl.substringBefore('?')).takeIf { it != "application/octet-stream" }
                ?: "video/*"
            return try {
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(Uri.parse(cleanUrl), cleanMime)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    if (!title.isNullOrBlank()) {
                        putExtra("title", title.trim())
                    }
                }
                val chooser = Intent.createChooser(
                    intent,
                    title?.takeIf { it.isNotBlank() }?.let { "Abspielen mit… ($it)" } ?: "Medienplayer wählen"
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(chooser)
                true
            } catch (_: Exception) {
                try {
                    val fallback = Intent(Intent.ACTION_VIEW, Uri.parse(cleanUrl)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(fallback)
                    true
                } catch (_: Exception) {
                    false
                }
            }
        }

        @JavascriptInterface
        fun startChromecastDiscovery(): Boolean {
            return chromecastHelper.startDiscovery()
        }

        @JavascriptInterface
        fun getChromecastDiscoveryResult(): String {
            return chromecastHelper.getDiscoveryResultJson()
        }

        @JavascriptInterface
        fun connectAndCastMedia(requestJson: String?): String {
            return handleConnectAndCastMedia(requestJson ?: "{}", async = false)
        }

        @JavascriptInterface
        fun startConnectAndCastMedia(requestJson: String?): Boolean {
            return handleConnectAndCastMedia(requestJson ?: "{}", async = true) == "true"
        }

        @JavascriptInterface
        fun getChromecastConnectResult(): String {
            return chromecastHelper.getCastConnectResultJson()
        }

        @JavascriptInterface
        fun controlChromecastMedia(requestJson: String?): String {
            return chromecastHelper.controlMedia(requestJson ?: "{}")
        }

        @JavascriptInterface
        fun getChromecastSessionState(): String {
            return chromecastHelper.getSessionStateJson()
        }
    }

    private fun pickLanIpForTarget(targetHost: String): String? {
        val ifaces = getLocalLanIpv4Interfaces()
        if (ifaces.isEmpty()) return null
        val targetParts = targetHost.trim().split('.')
        if (targetParts.size == 4) {
            val prefix3 = "${targetParts[0]}.${targetParts[1]}.${targetParts[2]}."
            ifaces.firstOrNull { it.first.startsWith(prefix3) }?.let { return it.first }
            val prefix2 = "${targetParts[0]}.${targetParts[1]}."
            ifaces.firstOrNull { it.first.startsWith(prefix2) }?.let { return it.first }
        }
        return ifaces.firstOrNull()?.first
    }

    private fun rewriteLoopbackUrlForLan(rawUrl: String, castTargetHost: String): String {
        val trimmed = rawUrl.trim()
        if (!trimmed.startsWith("http://", true) && !trimmed.startsWith("https://", true)) {
            return trimmed
        }
        return try {
            val parsed = URL(trimmed)
            val urlHost = parsed.host?.lowercase(Locale.US) ?: ""
            if (urlHost == "127.0.0.1" || urlHost == "localhost") {
                val lanIp = pickLanIpForTarget(castTargetHost) ?: return trimmed
                val portPart = if (parsed.port > 0) ":${parsed.port}" else ""
                val filePart = parsed.file.ifEmpty { "/" }
                "${parsed.protocol}://$lanIp$portPart$filePart"
            } else {
                trimmed
            }
        } catch (_: Exception) {
            trimmed
        }
    }

    private fun handleConnectAndCastMedia(requestJson: String, async: Boolean = false): String {
        return try {
            val req = JSONObject(requestJson)
            val targetHost = req.optString("host", "").trim()
            val rawContentUrl = req.optString("contentUrl", "").trim()
            if (rawContentUrl.isNotEmpty()) {
                req.put("contentUrl", rewriteLoopbackUrlForLan(rawContentUrl, targetHost))
            }
            val rawPosterUrl = req.optString("posterUrl", "").trim()
            if (rawPosterUrl.isNotEmpty()) {
                req.put("posterUrl", rewriteLoopbackUrlForLan(rawPosterUrl, targetHost))
            }
            if (async) {
                if (chromecastHelper.startConnectAndCastMedia(req.toString())) "true" else "false"
            } else {
                chromecastHelper.connectAndCastMedia(req.toString())
            }
        } catch (e: Exception) {
            if (async) {
                "false"
            } else {
                JSONObject()
                    .put("ok", false)
                    .put("message", e.message ?: "Chromecast-Start fehlgeschlagen.")
                    .toString()
            }
        }
    }

    private fun sanitizeSmbRequestJson(requestJson: String): String {
        val obj = JSONObject(requestJson)
        val rawPort = if (obj.has("port") && !obj.isNull("port")) obj.optInt("port", 445) else 445
        obj.put("port", NasProtocolProbeHelper.sanitizeSmbPort(rawPort))
        return obj.toString()
    }

    private fun performGenericNasBrowse(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase()
            when (proto) {
                "smb", "cifs" -> {
                    val smbJson = sanitizeSmbRequestJson(requestJson)
                    val smbRaw = NasProtocolProbeHelper.browseSmbDirectoriesJson(
                        requestJson = smbJson,
                        allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                        configureTrust = { applySharedNasTrustIfHttps(it) }
                    )
                    val smbObj = JSONObject(smbRaw)
                    val host = req.optString("host", "").lowercase()
                    if (smbObj.optString("source") != "smb_live" &&
                        (host.contains("fritz") || req.optBoolean("isFritzBox", false) || req.optString("fritzPassword").isNotEmpty())
                    ) {
                        val fritzRaw = FritzBoxSessionHelper.browseFritzNasDirectories(
                            requestJson = requestJson,
                            allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                            configureTrust = { applySharedNasTrustIfHttps(it) }
                        )
                        val fritzObj = JSONObject(fritzRaw)
                        if (fritzObj.optString("source") != "nas_template") {
                            return fritzRaw
                        }
                    }
                    smbRaw
                }
                else -> FritzBoxSessionHelper.browseFritzNasDirectories(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", true)
                .put("currentPath", "/")
                .put("entries", JSONArray())
                .put("source", "nas_template")
                .put("writable", false)
                .put("warning", e.message ?: "Verzeichnis-Abfrage fehlgeschlagen")
                .toString()
        }
    }

    private fun performGenericNasProvision(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase()
            when (proto) {
                "smb", "cifs" -> {
                    val smbRaw = NasProtocolProbeHelper.provisionSmbBackendJson(
                        requestJson = sanitizeSmbRequestJson(requestJson),
                        allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                        configureTrust = { applySharedNasTrustIfHttps(it) }
                    )
                    val smbObj = JSONObject(smbRaw)
                    val host = req.optString("host", "").lowercase()
                    if (!smbObj.optBoolean("remoteWriteOk", false) &&
                        (host.contains("fritz") || req.optBoolean("isFritzBox", false) || req.optString("fritzPassword").isNotEmpty())
                    ) {
                        val fritzRaw = FritzBoxSessionHelper.provisionFritzNasBackend(
                            requestJson = requestJson,
                            allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                            configureTrust = { applySharedNasTrustIfHttps(it) }
                        )
                        val fritzObj = JSONObject(fritzRaw)
                        if (fritzObj.optBoolean("remoteWriteOk", false)) {
                            return fritzRaw
                        }
                    }
                    smbRaw
                }
                else -> FritzBoxSessionHelper.provisionFritzNasBackend(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", true)
                .put("backendPath", "/EntenCenter-Backend")
                .put("remoteWriteOk", false)
                .put("localBridgeReady", true)
                .put("connectionKeptAlive", true)
                .put("warning", e.message ?: "Provisionierung fehlgeschlagen")
                .toString()
        }
    }

    private fun performWebDavWriteFile(req: JSONObject): String {
        val rawHost = req.optString("host", "").trim()
            .removePrefix("http://").removePrefix("https://").substringBefore("/").substringBefore(":")
        val useTls = req.optBoolean("useTls", false) || req.optString("protocol", "").contains("https", true)
        val port = req.optInt("port", if (useTls) 443 else 80)
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val basePath = req.optString("shareOrPath", "").trim().trimEnd('/')
        val targetPath = "/" + req.optString("targetPath", "").trim().replace('\\', '/').trimStart('/')
        val fullPath = if (basePath.isNotBlank() && !targetPath.startsWith(basePath)) {
            "${if (basePath.startsWith("/")) basePath else "/$basePath"}$targetPath"
        } else targetPath
        val scheme = if (useTls) "https" else "http"
        val portSuffix = if ((useTls && port == 443) || (!useTls && port == 80)) "" else ":$port"
        val contentBase64 = req.optString("contentBase64", "")
        val bytes = if (contentBase64.isNotEmpty()) {
            android.util.Base64.decode(contentBase64, android.util.Base64.DEFAULT)
        } else {
            req.optString("content", "").toByteArray(Charsets.UTF_8)
        }
        val basicAuth = if (username.isNotEmpty() || password.isNotEmpty()) {
            "Basic " + android.util.Base64.encodeToString("$username:$password".toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        } else null

        val parentDir = fullPath.substringBeforeLast('/', "")
        if (parentDir.isNotBlank()) {
            val segments = parentDir.split('/').filter { it.isNotBlank() }
            var acc = ""
            for (seg in segments) {
                acc += "/$seg"
                try {
                    val mkConn = (URL("$scheme://$rawHost$portSuffix$acc").openConnection() as HttpURLConnection).apply {
                        applySharedNasTrustIfHttps(this)
                        requestMethod = "MKCOL"
                        connectTimeout = 4000
                        readTimeout = 4000
                        if (basicAuth != null) setRequestProperty("Authorization", basicAuth)
                    }
                    try { mkConn.responseCode } finally { mkConn.disconnect() }
                } catch (_: Exception) {}
            }
        }

        val url = "$scheme://$rawHost$portSuffix$fullPath"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            applySharedNasTrustIfHttps(this)
            requestMethod = "PUT"
            connectTimeout = 5000
            readTimeout = 20000
            doOutput = true
            if (basicAuth != null) setRequestProperty("Authorization", basicAuth)
            setRequestProperty("Content-Type", req.optString("contentType", "application/octet-stream"))
        }
        return try {
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            if (code in 200..299) {
                JSONObject()
                    .put("ok", true)
                    .put("transport", "webdav")
                    .put("filePath", targetPath)
                    .put("bytesWritten", bytes.size)
                    .put("verified", true)
                    .put("message", "Datei „$targetPath“ per WebDAV gespeichert.")
                    .toString()
            } else {
                JSONObject().put("ok", false).put("filePath", targetPath)
                    .put("error", "WebDAV PUT HTTP $code ($url)").toString()
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun performWebDavReadFile(req: JSONObject): String {
        val rawHost = req.optString("host", "").trim()
            .removePrefix("http://").removePrefix("https://").substringBefore("/").substringBefore(":")
        val useTls = req.optBoolean("useTls", false) || req.optString("protocol", "").contains("https", true)
        val port = req.optInt("port", if (useTls) 443 else 80)
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val basePath = req.optString("shareOrPath", "").trim().trimEnd('/')
        val targetPath = "/" + req.optString("targetPath", "").trim().replace('\\', '/').trimStart('/')
        val fullPath = if (basePath.isNotBlank() && !targetPath.startsWith(basePath)) {
            "${if (basePath.startsWith("/")) basePath else "/$basePath"}$targetPath"
        } else targetPath
        val scheme = if (useTls) "https" else "http"
        val portSuffix = if ((useTls && port == 443) || (!useTls && port == 80)) "" else ":$port"
        val url = "$scheme://$rawHost$portSuffix$fullPath"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            applySharedNasTrustIfHttps(this)
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = 10000
            if (username.isNotEmpty() || password.isNotEmpty()) {
                val auth = android.util.Base64.encodeToString("$username:$password".toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
                setRequestProperty("Authorization", "Basic $auth")
            }
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val content = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            if (code in 200..299) {
                JSONObject()
                    .put("ok", true)
                    .put("filePath", targetPath)
                    .put("bytesRead", content.toByteArray(Charsets.UTF_8).size)
                    .put("content", content)
                    .toString()
            } else {
                JSONObject().put("ok", false).put("error", "WebDAV GET HTTP $code").toString()
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun performGenericNasWriteFile(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase()
            when (proto) {
                "smb", "cifs" -> {
                    val smbRaw = NasProtocolProbeHelper.writeSmbFileJson(
                        requestJson = sanitizeSmbRequestJson(requestJson),
                        allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                        configureTrust = { applySharedNasTrustIfHttps(it) }
                    )
                    val smbObj = JSONObject(smbRaw)
                    if (smbObj.optBoolean("ok", false)) return smbRaw
                    val host = req.optString("host", "").trim()
                    val looksLikeFritz = host.contains("fritz", true) ||
                        req.optBoolean("isFritzBox", false) ||
                        req.optString("fritzPassword").isNotEmpty() ||
                        FritzBoxSessionHelper.isLocalLanHost(host)
                    if (looksLikeFritz) {
                        val fritzRaw = FritzBoxSessionHelper.writeFritzNasFileJson(
                            requestJson = requestJson,
                            allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                            configureTrust = { applySharedNasTrustIfHttps(it) }
                        )
                        val fritzObj = JSONObject(fritzRaw)
                        if (fritzObj.optBoolean("ok", false)) return fritzRaw
                    }
                    smbRaw
                }
                "webdav_http", "webdav_https", "webdav" -> performWebDavWriteFile(req)
                else -> FritzBoxSessionHelper.writeFritzNasFileJson(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Datei konnte nicht auf das NAS geschrieben werden")
                .toString()
        }
    }

    private fun performGenericNasReadFile(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase()
            when (proto) {
                "smb", "cifs" -> NasProtocolProbeHelper.readSmbFileJson(
                    requestJson = sanitizeSmbRequestJson(requestJson),
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
                "webdav_http", "webdav_https", "webdav" -> performWebDavReadFile(req)
                else -> FritzBoxSessionHelper.readFritzNasFileJson(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Datei konnte nicht vom NAS gelesen werden")
                .toString()
        }
    }

    private fun performWebDavStorageStats(req: JSONObject): String? {
        val rawHost = req.optString("host", "").trim()
            .removePrefix("http://").removePrefix("https://").substringBefore("/").substringBefore(":")
        if (rawHost.isEmpty()) return null
        val useTls = req.optBoolean("useTls", false) || req.optString("protocol", "").contains("https", true)
        val port = req.optInt("port", if (useTls) 443 else 80)
        val username = req.optString("username", "").trim()
        val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
        val basePath = req.optString("shareOrPath", "/").trim().let { if (it.startsWith("/")) it else "/$it" }
        val scheme = if (useTls) "https" else "http"
        val portSuffix = if ((useTls && port == 443) || (!useTls && port == 80)) "" else ":$port"
        val url = "$scheme://$rawHost$portSuffix$basePath"
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                applySharedNasTrustIfHttps(this)
                requestMethod = "PROPFIND"
                connectTimeout = 4500
                readTimeout = 4500
                doOutput = true
                setRequestProperty("Depth", "0")
                setRequestProperty("Content-Type", "application/xml; charset=utf-8")
                if (username.isNotEmpty() || password.isNotEmpty()) {
                    val auth = android.util.Base64.encodeToString("$username:$password".toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
                    setRequestProperty("Authorization", "Basic $auth")
                }
            }
            conn.outputStream.use {
                it.write(
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>"
                        .toByteArray(Charsets.UTF_8)
                )
            }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            conn.disconnect()
            val availMatch = Regex("<(?:[a-zA-Z0-9_-]+:)?quota-available-bytes[^>]*>(\\d+)<", RegexOption.IGNORE_CASE).find(body)
            val usedMatch = Regex("<(?:[a-zA-Z0-9_-]+:)?quota-used-bytes[^>]*>(\\d+)<", RegexOption.IGNORE_CASE).find(body)
            val avail = availMatch?.groupValues?.getOrNull(1)?.toLongOrNull() ?: -1L
            val used = usedMatch?.groupValues?.getOrNull(1)?.toLongOrNull() ?: -1L
            if (avail > 0L || used > 0L) {
                val safeAvail = avail.coerceAtLeast(0L)
                val safeUsed = used.coerceAtLeast(0L)
                val total = safeAvail + safeUsed
                if (total > 0L) {
                    val usedPct = ((safeUsed.toDouble() / total.toDouble()) * 1000.0).toLong() / 10.0
                    val freePct = (100.0 - usedPct).coerceAtLeast(0.0)
                    return JSONObject()
                        .put("ok", true)
                        .put("host", rawHost)
                        .put("shareName", basePath)
                        .put("source", "webdav_quota")
                        .put("totalBytes", total)
                        .put("freeBytes", safeAvail)
                        .put("usedBytes", safeUsed)
                        .put("usedPercent", usedPct)
                        .put("freePercent", freePct)
                        .toString()
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun performGenericNasStorageStats(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase()
            val host = req.optString("host", "").trim()
            val isFritzLike = proto.contains("fritz") ||
                host.contains("fritz", true) ||
                req.optBoolean("isFritzBox", false) ||
                FritzBoxSessionHelper.isLocalLanHost(host)
            when (proto) {
                "smb", "cifs" -> {
                    val smbRaw = NasProtocolProbeHelper.getSmbStorageVolumeStatsJson(
                        requestJson = sanitizeSmbRequestJson(requestJson),
                        allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                        configureTrust = { applySharedNasTrustIfHttps(it) }
                    )
                    val smbObj = try { JSONObject(smbRaw) } catch (_: Exception) { null }
                    if (smbObj?.optBoolean("ok", false) == true && smbObj.optLong("totalBytes", 0L) >= 512L * 1024L * 1024L) {
                        return smbRaw
                    }
                    if (isFritzLike) {
                        val fritzRaw = FritzBoxSessionHelper.getFritzNasStorageStatsJson(
                            requestJson = requestJson,
                            allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                            configureTrust = { applySharedNasTrustIfHttps(it) }
                        )
                        val fritzObj = try { JSONObject(fritzRaw) } catch (_: Exception) { null }
                        if (fritzObj?.optBoolean("ok", false) == true &&
                            fritzObj.optLong("totalBytes", 0L) > (smbObj?.optLong("totalBytes", 0L) ?: 0L)
                        ) {
                            return fritzRaw
                        }
                    }
                    smbRaw
                }
                "webdav", "webdav_http", "webdav_https" -> {
                    performWebDavStorageStats(req)
                        ?: JSONObject().put("ok", false).put("error", "WebDAV-Speicherquota nicht verfügbar.").toString()
                }
                else -> FritzBoxSessionHelper.getFritzNasStorageStatsJson(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
            }
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "NAS-Speicherabfrage fehlgeschlagen")
                .toString()
        }
    }

    private fun performGenericNasScanMediaFolders(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val smbReq = JSONObject(requestJson)
            val sanitizedPort = NasProtocolProbeHelper.sanitizeSmbPort(
                if (smbReq.has("port") && !smbReq.isNull("port")) smbReq.optInt("port", 445) else 445
            )
            smbReq.put("port", sanitizedPort)
            val host = req.optString("host", "")
            val proto = req.optString("protocol", "").lowercase()
            val isFritzLike = host.contains("fritz", true) ||
                proto.contains("fritz", true) ||
                FritzBoxSessionHelper.isLocalLanHost(host)
            if (!smbReq.has("shareOrPath") || smbReq.optString("shareOrPath").isBlank()) {
                if (isFritzLike) {
                    smbReq.put("shareOrPath", "FRITZ.NAS")
                    smbReq.put("isFritzBox", true)
                }
            }
            val smbRaw = NasProtocolProbeHelper.scanSmbFoldersForMediaJson(
                requestJson = smbReq.toString(),
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
            val smbObj = try { JSONObject(smbRaw) } catch (_: Exception) { null }
            val smbOk = smbObj?.optBoolean("ok", false) == true
            val smbFiles = smbObj?.optJSONArray("files")?.length() ?: 0
            val smbTotalBytes = smbObj?.optLong("scannedTotalBytes", 0L) ?: 0L
            val smbVolBytes = smbObj?.optLong("volumeTotalBytes", 0L) ?: 0L
            if (smbOk && smbFiles > 0) {
                return smbRaw
            }
            if (isFritzLike) {
                val fritzRaw = FritzBoxSessionHelper.scanFritzNasFoldersForMediaJson(
                    requestJson = requestJson,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
                val fritzObj = try { JSONObject(fritzRaw) } catch (_: Exception) { null }
                val fritzOk = fritzObj?.optBoolean("ok", false) == true
                val fritzFiles = fritzObj?.optJSONArray("files")?.length() ?: 0
                val fritzTotalBytes = fritzObj?.optLong("scannedTotalBytes", 0L) ?: 0L
                val fritzVolBytes = fritzObj?.optLong("volumeTotalBytes", 0L) ?: 0L
                if (fritzOk && (!smbOk || fritzFiles > smbFiles || fritzTotalBytes > smbTotalBytes || fritzVolBytes > smbVolBytes)) {
                    return fritzRaw
                }
            }
            smbRaw
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("files", JSONArray())
                .put("error", e.message ?: "Ordnerscan auf dem NAS fehlgeschlagen")
                .toString()
        }
    }

    private fun ensureLocalMediaProxyStarted(): Int {
        if (localProxyRunning.get() && localProxyPort > 0) {
            return localProxyPort
        }
        synchronized(this) {
            if (localProxyRunning.get() && localProxyPort > 0) {
                return localProxyPort
            }
            try {
                val ss = ServerSocket(0, 32, InetAddress.getByName("0.0.0.0"))
                localProxySocket = ss
                localProxyPort = ss.localPort
                localProxyRunning.set(true)
                localProxyExecutor.execute {
                    while (localProxyRunning.get() && !ss.isClosed) {
                        try {
                            val client = ss.accept()
                            localProxyExecutor.execute { handleLocalProxyClient(client) }
                        } catch (_: Exception) {
                            if (!localProxyRunning.get() || ss.isClosed) break
                        }
                    }
                }
            } catch (_: Exception) {
                localProxyPort = 0
            }
            return localProxyPort
        }
    }

    private fun stopLocalMediaProxy() {
        localProxyRunning.set(false)
        try { localProxySocket?.close() } catch (_: Exception) {}
        localProxySocket = null
        localProxyPort = 0
        localProxyExecutor.shutdownNow()
    }

    private fun registerLocalNasStreamSource(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val host = req.optString("host", "").trim()
            val targetPath = req.optString("targetPath", "").trim()
            val pass = req.optString("password", "").ifEmpty { req.optString("secret", "") }
            if (host.isEmpty() || targetPath.isEmpty() || pass.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "NAS-Streaming erfordert Host, Pfad und Zugangsdaten.").toString()
            }
            val port = ensureLocalMediaProxyStarted()
            if (port <= 0) {
                return JSONObject().put("ok", false).put("error", "Lokaler Streaming-Proxy konnte nicht gestartet werden.").toString()
            }
            val keyRaw = "${host.lowercase()}|$targetPath|${req.optString("protocol", "fritz_upnp")}"
            val idBytes = MessageDigest.getInstance("SHA-256").digest(keyRaw.toByteArray(Charsets.UTF_8))
            val id = idBytes.take(12).joinToString("") { "%02x".format(it) }
            localProxySources[id] = req
            val ext = targetPath.substringAfterLast('/', "").substringAfterLast('.', "").lowercase().take(8)
            val fileSuffix = if (ext.isNotEmpty() && ext.all { it.isLetterOrDigit() }) "/media.$ext" else "/stream"
            val streamUrl = "http://127.0.0.1:$port$fileSuffix?id=$id&token=$localProxyToken"
            JSONObject()
                .put("ok", true)
                .put("url", streamUrl)
                .put("port", port)
                .toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "Streaming-URL Fehler").toString()
        }
    }

    private fun inferStreamMimeType(targetPath: String): String {
        val lower = targetPath.lowercase(Locale.US)
        return when {
            lower.endsWith(".mp4") || lower.endsWith(".m4v") -> "video/mp4"
            lower.endsWith(".webm") -> "video/webm"
            lower.endsWith(".mov") -> "video/quicktime"
            lower.endsWith(".mkv") -> "video/x-matroska"
            lower.endsWith(".avi") -> "video/x-msvideo"
            lower.endsWith(".ts") || lower.endsWith(".m2ts") || lower.endsWith(".mts") -> "video/mp2t"
            lower.endsWith(".mpg") || lower.endsWith(".mpeg") -> "video/mpeg"
            lower.endsWith(".wmv") || lower.endsWith(".asf") -> "video/x-ms-wmv"
            lower.endsWith(".flv") || lower.endsWith(".f4v") -> "video/x-flv"
            lower.endsWith(".3gp") || lower.endsWith(".3g2") -> "video/3gpp"
            lower.endsWith(".ogv") -> "video/ogg"
            lower.endsWith(".vob") -> "video/dvd"
            lower.endsWith(".divx") || lower.endsWith(".rmvb") -> "video/x-msvideo"
            lower.endsWith(".m3u8") || lower.endsWith(".m3u") -> "application/vnd.apple.mpegurl"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".m4a") || lower.endsWith(".m4b") || lower.endsWith(".alac") -> "audio/mp4"
            lower.endsWith(".aac") -> "audio/aac"
            lower.endsWith(".flac") -> "audio/flac"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".ogg") || lower.endsWith(".oga") || lower.endsWith(".opus") -> "audio/ogg"
            lower.endsWith(".wma") -> "audio/x-ms-wma"
            lower.endsWith(".aiff") || lower.endsWith(".aif") -> "audio/aiff"
            lower.endsWith(".mka") -> "audio/x-matroska"
            lower.endsWith(".amr") -> "audio/amr"
            lower.endsWith(".mid") || lower.endsWith(".midi") -> "audio/midi"
            lower.endsWith(".ac3") -> "audio/ac3"
            lower.endsWith(".dts") -> "audio/vnd.dts"
            lower.endsWith(".ape") || lower.endsWith(".wv") -> "audio/x-ape"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".bmp") -> "image/bmp"
            lower.endsWith(".heic") || lower.endsWith(".heif") -> "image/heic"
            lower.endsWith(".avif") -> "image/avif"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".tiff") || lower.endsWith(".tif") -> "image/tiff"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".epub") -> "application/epub+zip"
            lower.endsWith(".srt") || lower.endsWith(".txt") -> "text/plain; charset=utf-8"
            lower.endsWith(".vtt") -> "text/vtt; charset=utf-8"
            else -> "application/octet-stream"
        }
    }

    private fun handleLocalProxyClient(client: Socket) {
        try {
            client.soTimeout = 30000
            val input = client.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            val requestLine = input.readLine() ?: return
            val parts = requestLine.split(" ")
            val method = parts.getOrNull(0)?.uppercase(Locale.US) ?: "GET"
            val rawUri = parts.getOrNull(1) ?: "/"
            val headers = HashMap<String, String>()
            while (true) {
                val line = input.readLine() ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    headers[line.substring(0, colon).trim().lowercase(Locale.US)] =
                        line.substring(colon + 1).trim()
                }
            }

            val out = client.getOutputStream()
            fun sendError(statusCode: Int, statusText: String, msg: String) {
                val body = msg.toByteArray(Charsets.UTF_8)
                val hdr = "HTTP/1.1 $statusCode $statusText\r\n" +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "Content-Length: ${body.size}\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(hdr.toByteArray(Charsets.ISO_8859_1))
                if (method != "HEAD") out.write(body)
                out.flush()
            }

            if (method == "OPTIONS") {
                val hdr = "HTTP/1.1 204 No Content\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Headers: Range, Content-Type\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(hdr.toByteArray(Charsets.ISO_8859_1))
                out.flush()
                return
            }

            if (method != "GET" && method != "HEAD") {
                sendError(405, "Method Not Allowed", "Method not allowed")
                return
            }

            val query = rawUri.substringAfter('?', "")
            val params = HashMap<String, String>()
            for (pair in query.split('&')) {
                val eq = pair.indexOf('=')
                if (eq > 0) {
                    val k = URLDecoder.decode(pair.substring(0, eq), "UTF-8")
                    val v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
                    params[k] = v
                }
            }

            if (params["token"] != localProxyToken) {
                sendError(403, "Forbidden", "Ungültiges Proxy-Token.")
                return
            }
            val srcId = params["id"] ?: ""
            val req = localProxySources[srcId]
            if (req == null) {
                sendError(404, "Not Found", "Stream-Quelle nicht gefunden.")
                return
            }

            val isDownload = params["download"] == "1"
            val targetPath = req.optString("targetPath", "")
            val mimeType = inferStreamMimeType(targetPath)
            val fileName = targetPath.substringAfterLast('/', "media.bin").ifBlank { "media.bin" }
            val rangeHdr = if (isDownload) null else headers["range"]
            var reqRangeStart: Long? = null
            var reqRangeEnd: Long? = null
            if (!rangeHdr.isNullOrBlank() && rangeHdr.startsWith("bytes=", true)) {
                val spec = rangeHdr.substring(6).substringBefore(',').trim()
                val dash = spec.indexOf('-')
                if (dash >= 0) {
                    val sPart = spec.substring(0, dash).trim()
                    val ePart = spec.substring(dash + 1).trim()
                    reqRangeStart = sPart.toLongOrNull()
                    reqRangeEnd = ePart.toLongOrNull()
                }
            }

            val proto = req.optString("protocol", "fritz_upnp").trim().lowercase(Locale.US)
            val host = req.optString("host", "").trim()
            val isFritzLike = proto.contains("fritz", true) || host.contains("fritz", true)

            if (proto == "webdav" || proto == "webdav_http" || proto == "webdav_https") {
                val rawHost = host.removePrefix("http://").removePrefix("https://").substringBefore("/").substringBefore(":")
                val useTls = req.optBoolean("useTls", false) || proto.contains("https", true)
                val port = req.optInt("port", if (useTls) 443 else 80)
                val username = req.optString("username", "").trim()
                val password = req.optString("password", "").ifEmpty { req.optString("secret", "") }
                val basePath = req.optString("shareOrPath", "").trim().trimEnd('/')
                val cleanTarget = "/" + targetPath.replace('\\', '/').trimStart('/')
                val fullPath = if (basePath.isNotBlank() && !cleanTarget.startsWith(basePath)) {
                    "${if (basePath.startsWith("/")) basePath else "/$basePath"}$cleanTarget"
                } else cleanTarget
                val scheme = if (useTls) "https" else "http"
                val portSuffix = if ((useTls && port == 443) || (!useTls && port == 80)) "" else ":$port"
                val conn = (URL("$scheme://$rawHost$portSuffix$fullPath").openConnection() as HttpURLConnection).apply {
                    applySharedNasTrustIfHttps(this)
                    requestMethod = method
                    connectTimeout = 7000
                    readTimeout = 30000
                    if (username.isNotEmpty() || password.isNotEmpty()) {
                        val auth = android.util.Base64.encodeToString("$username:$password".toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
                        setRequestProperty("Authorization", "Basic $auth")
                    }
                    if (!rangeHdr.isNullOrBlank()) setRequestProperty("Range", rangeHdr)
                }
                try {
                    val code = conn.responseCode
                    val statusLine = if (code == 206) "HTTP/1.1 206 Partial Content" else "HTTP/1.1 $code OK"
                    val lenHdr = conn.getHeaderField("Content-Length")
                    val crHdr = conn.getHeaderField("Content-Range")
                    val hdrSb = StringBuilder("$statusLine\r\n")
                        .append("Content-Type: $mimeType\r\n")
                        .append("Accept-Ranges: bytes\r\n")
                        .append("Access-Control-Allow-Origin: *\r\n")
                        .append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                        .append("Connection: close\r\n")
                    if (!lenHdr.isNullOrBlank()) hdrSb.append("Content-Length: $lenHdr\r\n")
                    if (!crHdr.isNullOrBlank()) hdrSb.append("Content-Range: $crHdr\r\n")
                    if (isDownload) hdrSb.append("Content-Disposition: attachment; filename=\"${URLEncoder.encode(fileName, "UTF-8")}\"\r\n")
                    hdrSb.append("\r\n")
                    out.write(hdrSb.toString().toByteArray(Charsets.ISO_8859_1))
                    if (method != "HEAD" && code in 200..299) {
                        val buf = ByteArray(32768)
                        conn.inputStream.use { ins ->
                            while (true) {
                                val r = ins.read(buf)
                                if (r <= 0) break
                                out.write(buf, 0, r)
                            }
                        }
                    }
                    out.flush()
                } finally {
                    conn.disconnect()
                }
                return
            }

            // SMB2 Streaming (primär für SMB und FRITZ!Box LAN mit SMB :445)
            val smbReq = JSONObject(req.toString()).apply {
                put("port", NasProtocolProbeHelper.sanitizeSmbPort(if (has("port") && !isNull("port")) optInt("port", 445) else 445))
                if (isFritzLike) {
                    put("isFritzBox", true)
                    if (optString("shareOrPath", "").isBlank()) put("shareOrPath", "FRITZ.NAS")
                }
            }.toString()

            var headersSent = false
            val smbErr = NasProtocolProbeHelper.statAndStreamSmbFileRange(
                requestJson = smbReq,
                rangeStart = reqRangeStart,
                rangeEnd = reqRangeEnd,
                isHeadOnly = (method == "HEAD"),
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) },
                onMetadata = { totalSize, startByte, endByte ->
                    val hasRange = reqRangeStart != null || reqRangeEnd != null
                    if (hasRange && totalSize > 0L && startByte >= totalSize) {
                        val hdr = "HTTP/1.1 416 Range Not Satisfiable\r\n" +
                            "Content-Range: bytes */$totalSize\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Connection: close\r\n\r\n"
                        out.write(hdr.toByteArray(Charsets.ISO_8859_1))
                        out.flush()
                        headersSent = true
                        return@statAndStreamSmbFileRange false
                    }
                    val contentLen = if (totalSize <= 0L) 0L else (endByte - startByte + 1L).coerceAtLeast(0L)
                    val hdrSb = StringBuilder()
                    if (hasRange && totalSize > 0L) {
                        hdrSb.append("HTTP/1.1 206 Partial Content\r\n")
                        hdrSb.append("Content-Range: bytes $startByte-$endByte/$totalSize\r\n")
                    } else {
                        hdrSb.append("HTTP/1.1 200 OK\r\n")
                    }
                    hdrSb.append("Content-Type: $mimeType\r\n")
                    hdrSb.append("Accept-Ranges: bytes\r\n")
                    hdrSb.append("Content-Length: $contentLen\r\n")
                    hdrSb.append("Access-Control-Allow-Origin: *\r\n")
                    hdrSb.append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                    hdrSb.append("Cache-Control: private, max-age=60\r\n")
                    if (isDownload) {
                        hdrSb.append("Content-Disposition: attachment; filename=\"${URLEncoder.encode(fileName, "UTF-8")}\"\r\n")
                    }
                    hdrSb.append("Connection: close\r\n\r\n")
                    out.write(hdrSb.toString().toByteArray(Charsets.ISO_8859_1))
                    out.flush()
                    headersSent = true
                    method != "HEAD"
                },
                onChunk = { buffer, length ->
                    try {
                        out.write(buffer, 0, length)
                        true
                    } catch (_: Exception) {
                        false
                    }
                }
            )

            if (smbErr == null) {
                try { out.flush() } catch (_: Exception) {}
                return
            }

            // FRITZ!NAS Web-API Streaming Fallback wenn SMB2 nicht verfügbar oder fehlgeschlagen (solange noch keine Header gesendet wurden)
            if (!headersSent && isFritzLike) {
                val fritzConn = FritzBoxSessionHelper.openFritzNasFileStream(
                    requestJson = req.toString(),
                    rangeHeader = rangeHdr,
                    isHeadOnly = (method == "HEAD"),
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
                if (fritzConn != null) {
                    try {
                        val code = fritzConn.responseCode
                        if (code in 200..299) {
                            val statusLine = if (code == 206) "HTTP/1.1 206 Partial Content" else "HTTP/1.1 200 OK"
                            val lenHdr = fritzConn.getHeaderField("Content-Length")
                            val crHdr = fritzConn.getHeaderField("Content-Range")
                            val hdrSb = StringBuilder("$statusLine\r\n")
                                .append("Content-Type: $mimeType\r\n")
                                .append("Accept-Ranges: bytes\r\n")
                                .append("Access-Control-Allow-Origin: *\r\n")
                                .append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                                .append("Connection: close\r\n")
                            if (!lenHdr.isNullOrBlank()) hdrSb.append("Content-Length: $lenHdr\r\n")
                            if (!crHdr.isNullOrBlank()) hdrSb.append("Content-Range: $crHdr\r\n")
                            if (isDownload) hdrSb.append("Content-Disposition: attachment; filename=\"${URLEncoder.encode(fileName, "UTF-8")}\"\r\n")
                            hdrSb.append("\r\n")
                            out.write(hdrSb.toString().toByteArray(Charsets.ISO_8859_1))
                            if (method != "HEAD") {
                                val buf = ByteArray(32768)
                                fritzConn.inputStream.use { ins ->
                                    while (true) {
                                        val r = ins.read(buf)
                                        if (r <= 0) break
                                        out.write(buf, 0, r)
                                    }
                                }
                            }
                            out.flush()
                            return
                        }
                    } finally {
                        fritzConn.disconnect()
                    }
                }
            }

            if (!headersSent) {
                sendError(502, "Bad Gateway", smbErr)
            }
        } catch (_: Exception) {
        } finally {
            try { client.close() } catch (_: Exception) {}
        }
    }

    private fun parseUploadedNasCertificates(pem: String): List<X509Certificate> {
        if (pem.isBlank()) return emptyList()
        return try {
            val cf = CertificateFactory.getInstance("X.509")
            cf.generateCertificates(ByteArrayInputStream(pem.toByteArray(Charsets.UTF_8)))
                .filterIsInstance<X509Certificate>()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun sha256HexOfCert(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        return digest.joinToString(":") { "%02X".format(it) }
    }

    private fun isCertificateTrustedBySharedNasPem(peerCert: X509Certificate, uploadedCerts: List<X509Certificate>): Boolean {
        if (uploadedCerts.isEmpty()) return false
        val peerFp = sha256HexOfCert(peerCert)
        for (uploaded in uploadedCerts) {
            if (sha256HexOfCert(uploaded) == peerFp) {
                return true
            }
            try {
                peerCert.verify(uploaded.publicKey)
                return true
            } catch (_: Exception) {
                // Kein CA-Match, nächstes Zertifikat prüfen
            }
        }
        return false
    }

    private fun applySharedNasTrustIfHttps(conn: HttpURLConnection) {
        if (conn !is HttpsURLConnection) return
        val targetHost = conn.url?.host ?: ""
        val allowLocalSelfSigned =
            isAllowLocalSelfSignedTlsEnabled() && FritzBoxSessionHelper.isLocalLanHost(targetHost)
        val pem = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString(KEY_SHARED_NAS_CERT_PEM, "") ?: ""
        val uploadedCerts = parseUploadedNasCertificates(pem)
        if (uploadedCerts.isEmpty() && !allowLocalSelfSigned) return

        try {
            val defaultTmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            defaultTmf.init(null as KeyStore?)
            val systemTm = defaultTmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()

            var customTm: X509TrustManager? = null
            if (uploadedCerts.isNotEmpty()) {
                val customKs = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                    load(null, null)
                    uploadedCerts.forEachIndexed { idx, cert ->
                        setCertificateEntry("nas_cert_$idx", cert)
                    }
                }
                val customTmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                customTmf.init(customKs)
                customTm = customTmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
            }

            val compositeTm = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    systemTm?.checkClientTrusted(chain, authType)
                }

                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    if (chain.isNullOrEmpty()) throw CertificateException("Leere Zertifikatskette")
                    try {
                        systemTm?.checkServerTrusted(chain, authType)
                        return
                    } catch (_: Exception) {
                        // System-CA nicht erfolgreich -> hochgeladenes NAS-Zertifikat oder LAN-Ausnahme prüfen
                    }
                    if (customTm != null) {
                        try {
                            customTm.checkServerTrusted(chain, authType)
                            return
                        } catch (_: Exception) {
                        }
                    }
                    if (uploadedCerts.isNotEmpty() && isCertificateTrustedBySharedNasPem(chain[0], uploadedCerts)) {
                        return
                    }
                    if (allowLocalSelfSigned) {
                        return
                    }
                    throw CertificateException("Server-Zertifikat stimmt nicht mit dem NAS-Sicherheitszertifikat überein.")
                }

                override fun getAcceptedIssuers(): Array<X509Certificate> {
                    val combined = mutableListOf<X509Certificate>()
                    systemTm?.acceptedIssuers?.let { combined.addAll(it) }
                    combined.addAll(uploadedCerts)
                    return combined.toTypedArray()
                }
            }

            val sslCtx = SSLContext.getInstance("TLS")
            sslCtx.init(null, arrayOf(compositeTm), null)
            conn.sslSocketFactory = sslCtx.socketFactory

            val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
            conn.hostnameVerifier = HostnameVerifier { hostname, session ->
                if (defaultVerifier.verify(hostname, session)) return@HostnameVerifier true
                if (isAllowLocalSelfSignedTlsEnabled() && FritzBoxSessionHelper.isLocalLanHost(hostname)) {
                    return@HostnameVerifier true
                }
                try {
                    val peerCert = session.peerCertificates.firstOrNull() as? X509Certificate
                    peerCert != null && uploadedCerts.isNotEmpty() && isCertificateTrustedBySharedNasPem(peerCert, uploadedCerts)
                } catch (_: Exception) {
                    false
                }
            }
        } catch (_: Exception) {
            // Standard-TLS-Verhalten beibehalten
        }
    }

    private fun executeNativeHttpRequest(requestJson: String): String {
        val result = JSONObject()
        return try {
            val req = JSONObject(requestJson)
            val method = req.optString("method", "GET").trim().uppercase().ifBlank { "GET" }
            val urlStr = req.optString("url", "").trim()
            if (!urlStr.startsWith("http://", ignoreCase = true) &&
                !urlStr.startsWith("https://", ignoreCase = true)
            ) {
                return result
                    .put("ok", false)
                    .put("status", 0)
                    .put("errorKind", "invalid_url")
                    .put("error", "Ungültige HTTP/HTTPS-URL.")
                    .toString()
            }

            val timeoutMs = req.optInt("timeoutMs", 8000).coerceIn(1000, 20000)
            val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                applySharedNasTrustIfHttps(this)
                requestMethod = method
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                setRequestProperty("Accept", "application/json, text/html, text/plain, */*")
                setRequestProperty("Accept-Language", "de-DE,de;q=0.9,en;q=0.8")
                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                setRequestProperty("Connection", "close")
            }

            val headersObj = req.optJSONObject("headers")
            if (headersObj != null) {
                val keys = headersObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = headersObj.optString(key, "")
                    if (key.isNotBlank() && value.isNotBlank()) {
                        conn.setRequestProperty(key, value)
                    }
                }
            }

            val bodyStr = if (req.has("body") && !req.isNull("body")) req.optString("body", "") else ""
            if (bodyStr.isNotEmpty() && (method == "POST" || method == "PUT" || method == "PATCH")) {
                conn.doOutput = true
                if (headersObj?.has("Content-Type") != true && headersObj?.has("content-type") != true) {
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
                conn.outputStream.use { out ->
                    out.write(bodyStr.toByteArray(Charsets.UTF_8))
                }
            }

            try {
                val code = conn.responseCode
                val statusText = conn.responseMessage ?: ""
                val stream = if (code in 200..399) conn.inputStream else conn.errorStream
                val cType = conn.contentType ?: ""
                val charsetMatch = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE).find(cType)
                val charsetName = charsetMatch?.groupValues?.getOrNull(1)?.trim('"', '\'', ' ')
                val respCharset: Charset = try {
                    if (!charsetName.isNullOrBlank()) Charset.forName(charsetName) else Charsets.UTF_8
                } catch (_: Exception) {
                    Charsets.UTF_8
                }
                val respBody = stream?.bufferedReader(respCharset)?.use { reader ->
                    val sb = StringBuilder()
                    val buf = CharArray(8192)
                    var total = 0
                    while (total < 6 * 1024 * 1024) {
                        val read = reader.read(buf)
                        if (read <= 0) break
                        sb.append(buf, 0, read)
                        total += read
                    }
                    sb.toString()
                } ?: ""

                val respHeaders = JSONObject()
                conn.contentType?.let { respHeaders.put("content-type", it) }

                result
                    .put("ok", code in 200..299)
                    .put("status", code)
                    .put("statusText", statusText)
                    .put("headers", respHeaders)
                    .put("body", respBody)
                    .toString()
            } finally {
                conn.disconnect()
            }
        } catch (ssl: SSLException) {
            result
                .put("ok", false)
                .put("status", 0)
                .put("errorKind", "tls_error")
                .put("error", ssl.message ?: "TLS/SSL-Fehler")
                .toString()
        } catch (e: Exception) {
            result
                .put("ok", false)
                .put("status", 0)
                .put("errorKind", "network_error")
                .put("error", e.message ?: "Netzwerkfehler")
                .toString()
        }
    }

    private fun isValidEntenCenterBootstrapJson(body: String): Boolean {
        val trimmed = body.trim()
        if (!trimmed.startsWith("{")) return false
        return try {
            val json = JSONObject(trimmed)
            json.has("hasUsers") && json.opt("hasUsers") is Boolean
        } catch (_: Exception) {
            false
        }
    }

    private fun probeBootstrapAtBase(baseUrl: String, timeoutMs: Int = 1200): Pair<Boolean, Int> {
        return try {
            val cleanBase = baseUrl.trimEnd('/')
            val conn = (URL("$cleanBase/api/nas/auth/bootstrap").openConnection() as HttpURLConnection).apply {
                applySharedNasTrustIfHttps(this)
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                setRequestProperty("Connection", "close")
            }
            try {
                val code = conn.responseCode
                if (code !in 200..299) {
                    return false to code
                }
                val body = conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                isValidEntenCenterBootstrapJson(body) to code
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            false to 0
        }
    }

    private fun isPortOpenOnAddr(addr: InetAddress, port: Int, timeoutMs: Int = 350): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(addr, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun performServerDiagnosis(rawUrl: String): String {
        val result = JSONObject()
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) {
            return result
                .put("ok", false)
                .put("errorKind", "empty_url")
                .put("detail", "Keine Server-Adresse angegeben.")
                .toString()
        }

        val withScheme =
            if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) {
                trimmed
            } else {
                "http://$trimmed"
            }

        return try {
            val parsed = URL(withScheme)
            val host = parsed.host?.trim() ?: ""
            if (host.isBlank()) {
                return result
                    .put("ok", false)
                    .put("dnsOk", false)
                    .put("errorKind", "invalid_url")
                    .put("detail", "Ungültige Server-Adresse: Hostname fehlt.")
                    .toString()
            }
            val hasExplicitPort = parsed.port > 0
            val port = when {
                parsed.port > 0 -> parsed.port
                parsed.protocol.equals("https", ignoreCase = true) -> 443
                else -> 80
            }
            result.put("host", host).put("port", port).put("protocol", parsed.protocol)

            val resolvedAddr = try {
                InetAddress.getByName(host)
            } catch (e: Exception) {
                return result
                    .put("ok", false)
                    .put("dnsOk", false)
                    .put("errorKind", "dns_failed")
                    .put("detail", "Hostname \"$host\" konnte nicht aufgelöst werden (${e.message ?: "DNS"}).")
                    .toString()
            }

            val resolvedIp = resolvedAddr.hostAddress ?: host
            result.put("dnsOk", true).put("resolvedIp", resolvedIp)

            // Multi-Port-Kandidaten & NAS-Speicherports parallel prüfen (inkl. automatischem Ausweichport-Fallback für :3000)
            val basePath = parsed.path?.trimEnd('/') ?: ""
            val preferredAlt = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getInt(KEY_PREFERRED_ALT_PORT, 3001)
                .let { if (it in 1..65535 && it != 3000) it else 3001 }
            val fallbackPortOrder = (listOf(preferredAlt) + ALTERNATIVE_ENTENCENTER_PORTS).distinct()

            val primaryCandidates = LinkedHashSet<String>()
            val fallbackCandidates = LinkedHashSet<String>()
            if (hasExplicitPort) {
                primaryCandidates.add("${parsed.protocol}://$host:$port$basePath".trimEnd('/'))
                primaryCandidates.add("${parsed.protocol}://$host:$port")
                val altProto = if (parsed.protocol.equals("https", ignoreCase = true)) "http" else "https"
                primaryCandidates.add("$altProto://$host:$port")
                if (basePath.isEmpty()) {
                    primaryCandidates.add("${parsed.protocol}://$host:$port/entencenter")
                }
                for (altPort in fallbackPortOrder) {
                    if (altPort == port) continue
                    val altScheme = if (altPort == 8443 || altPort == 443) "https" else "http"
                    fallbackCandidates.add("$altScheme://$host:$altPort")
                    if (altScheme == "http" && altPort != 80) {
                        fallbackCandidates.add("https://$host:$altPort")
                    }
                }
            } else {
                primaryCandidates.add("http://$host:3000")
                primaryCandidates.add("https://$host:3000")
                if (basePath.isNotEmpty()) {
                    primaryCandidates.add("${parsed.protocol}://$host$basePath")
                }
                primaryCandidates.add("http://$host")
                primaryCandidates.add("https://$host")
                primaryCandidates.add("http://$host/entencenter")
                primaryCandidates.add("https://$host/entencenter")
                for (altPort in fallbackPortOrder) {
                    val altScheme = if (altPort == 8443 || altPort == 443) "https" else "http"
                    fallbackCandidates.add("$altScheme://$host:$altPort")
                }
            }
            val candidateBases = LinkedHashSet<String>().apply {
                addAll(primaryCandidates)
                addAll(fallbackCandidates)
            }

            val pool = Executors.newFixedThreadPool(10)
            var matchedBaseUrl: String? = null
            var fallbackPortUsed = false
            var port3000Reachable = false
            var port80Open = false
            var port443Open = false
            var port445Open = false
            val openNasServices = JSONArray()

            try {
                data class NasPortSpec(
                    val port: Int,
                    val protocol: String,
                    val label: String,
                    val scheme: String?,
                    val path: String
                )

                val nasSpecs = listOf(
                    NasPortSpec(445, "smb", "SMB / CIFS", null, "/Medien"),
                    NasPortSpec(5000, "api_token", "Synology DSM (HTTP)", "http", "/api/v3"),
                    NasPortSpec(5001, "api_token", "Synology DSM (HTTPS)", "https", "/api/v3"),
                    NasPortSpec(5005, "webdav", "WebDAV (HTTP)", "http", "/Medien"),
                    NasPortSpec(5006, "webdav", "WebDAV (HTTPS)", "https", "/Medien"),
                    NasPortSpec(8080, "api_token", "NAS Web / QNAP (HTTP)", "http", "/"),
                    NasPortSpec(2049, "nfs", "NFS", null, "/volume1/video"),
                    NasPortSpec(22, "sftp", "SFTP / SSH", null, "/mnt/nas/medien"),
                    NasPortSpec(21, "ftps", "FTP / FTPS", null, "/"),
                    NasPortSpec(49000, "fritz_upnp", "FRITZ!Box UPnP/DLNA", "http", "/MediaServer")
                )

                val tcpCheckPorts = (nasSpecs.map { it.port } + fallbackPortOrder + listOf(3000, 80, 443, port)).distinct()
                val portOpenMap = ConcurrentHashMap<Int, Boolean>()
                val portFutures = tcpCheckPorts.map { p ->
                    pool.submit {
                        portOpenMap[p] = isPortOpenOnAddr(resolvedAddr, p, 450)
                    }
                }
                for (f in portFutures) {
                    try {
                        f.get(1100, TimeUnit.MILLISECONDS)
                    } catch (_: Exception) {
                    }
                }

                port3000Reachable = portOpenMap[3000] == true
                port80Open = portOpenMap[80] == true
                port443Open = portOpenMap[443] == true
                port445Open = portOpenMap[445] == true

                for (spec in nasSpecs) {
                    if (portOpenMap[spec.port] == true) {
                        val obj = JSONObject()
                            .put("protocol", spec.protocol)
                            .put("port", spec.port.toString())
                            .put("label", spec.label)
                            .put("path", spec.path)
                        if (spec.scheme != null) {
                            obj.put("scheme", spec.scheme)
                        }
                        openNasServices.put(obj)
                    }
                }

                // Nur Kandidaten mit offenem TCP-Port per HTTP /api/nas/auth/bootstrap testen
                val openCandidates = candidateBases.filter { cand ->
                    try {
                        val u = URL(cand)
                        val cp = when {
                            u.port > 0 -> u.port
                            u.protocol.equals("https", ignoreCase = true) -> 443
                            else -> 80
                        }
                        portOpenMap[cp] == true
                    } catch (_: Exception) {
                        false
                    }
                }

                if (openCandidates.isNotEmpty()) {
                    val probeFutures = openCandidates.map { cand ->
                        cand to pool.submit<Pair<Boolean, Int>> { probeBootstrapAtBase(cand, 1500) }
                    }
                    val okCandidates = mutableListOf<String>()
                    for ((cand, fut) in probeFutures) {
                        try {
                            val (ok, _) = fut.get(1900, TimeUnit.MILLISECONDS)
                            if (ok) okCandidates.add(cand)
                        } catch (_: Exception) {
                        }
                    }
                    // Primären Kandidaten bevorzugen; nur auf Ausweichport wechseln, wenn primär nicht antwortet
                    matchedBaseUrl =
                        okCandidates.firstOrNull { primaryCandidates.contains(it) }
                            ?: okCandidates.firstOrNull()
                    if (matchedBaseUrl != null && !primaryCandidates.contains(matchedBaseUrl)) {
                        fallbackPortUsed = true
                    }
                }
            } finally {
                pool.shutdownNow()
            }

            var fritzProbeInfo: JSONObject? = null
            val portOpenMapForFritz = port445Open || port80Open || port443Open
            if (matchedBaseUrl == null && (port3000Reachable || openNasServices.length() > 0 || host.contains("fritz", true) || portOpenMapForFritz || port == 80 || port == 443 || isPortOpen(resolvedIp, 80, 350) || isPortOpen(resolvedIp, 443, 350))) {
                fritzProbeInfo = FritzBoxSessionHelper.probeLoginSid(
                    host = resolvedIp,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
                if (fritzProbeInfo != null && fritzProbeInfo.optBoolean("detected", false)) {
                    var hasFritzSvc = false
                    for (i in 0 until openNasServices.length()) {
                        if (openNasServices.optJSONObject(i)?.optString("protocol") == "fritz_upnp") {
                            hasFritzSvc = true
                            break
                        }
                    }
                    if (!hasFritzSvc) {
                        val httpOk = fritzProbeInfo.optBoolean("httpAvailable", false)
                        openNasServices.put(
                            JSONObject()
                                .put("protocol", "fritz_upnp")
                                .put("port", if (httpOk) "80" else "49000")
                                .put("label", if (httpOk) "FRITZ!Box / FRITZ!NAS (Login)" else "FRITZ!Box TR-064 / NAS")
                                .put("scheme", if (httpOk) "http" else "https")
                                .put("path", if (httpOk) "/login_sid.lua" else "/MediaServer")
                        )
                    }
                }
            }

            result.put("port3000Reachable", port3000Reachable)
            result.put("openNasServices", openNasServices)
            result.put("detectedFritzBox", fritzProbeInfo != null && fritzProbeInfo.optBoolean("detected", false))
            if (fritzProbeInfo != null) {
                result.put("fritzBoxInfo", fritzProbeInfo)
            }

            if (matchedBaseUrl != null) {
                val matchedPort = try {
                    val mu = URL(matchedBaseUrl)
                    if (mu.port > 0) mu.port else if (mu.protocol.equals("https", true)) 443 else 80
                } catch (_: Exception) {
                    port
                }
                return result
                    .put("ok", true)
                    .put("tcpOk", true)
                    .put("bootstrapOk", true)
                    .put("detectedPureNas", false)
                    .put("matchedBaseUrl", matchedBaseUrl)
                    .put("fallbackPortUsed", fallbackPortUsed)
                    .put("matchedPort", matchedPort)
                    .put(
                        "detail",
                        if (fallbackPortUsed) {
                            "Port $port nicht nutzbar — automatisch auf Ausweichport :$matchedPort ($matchedBaseUrl) ausgewichen."
                        } else {
                            "EntenCenter-NAS-Backend unter $matchedBaseUrl ($resolvedIp) gefunden."
                        }
                    )
                    .toString()
            }

            val detectedPureNas = openNasServices.length() > 0 || (fritzProbeInfo?.optBoolean("detected", false) == true)
            result.put("detectedPureNas", detectedPureNas)

            val inspectPort = if (!hasExplicitPort && port3000Reachable) 3000 else port
            val inspectBase =
                if (!hasExplicitPort && port3000Reachable) "http://$host:3000" else withScheme.trimEnd('/')

            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(resolvedAddr, inspectPort), 2500)
                }
                result.put("tcpOk", true)
            } catch (e: Exception) {
                val fritzDetected = fritzProbeInfo?.optBoolean("detected", false) == true
                val nasHint = if (fritzDetected) {
                    val httpsErr = fritzProbeInfo?.optString("httpsError", "")?.takeIf { it.isNotBlank() && it != "null" }
                    val httpsNote = if (httpsErr != null) " (HTTPS liefert „$httpsErr“ — lokaler HTTP-Fallback auf :80 aktiv)" else ""
                    "FRITZ!Box / FRITZ!NAS unter $host ($resolvedIp) erkannt$httpsNote. Gib deine FRITZ!Box-Zugangsdaten (Benutzername/Kennwort) ein, um per Challenge-Response oder SMB (:445) zuzugreifen."
                } else if (detectedPureNas) {
                    val labels = (0 until openNasServices.length()).mapNotNull { idx ->
                        val o = openNasServices.optJSONObject(idx) ?: return@mapNotNull null
                        "${o.optString("label")} :${o.optString("port")}"
                    }.take(3).joinToString(", ")
                    "Auf $host ($resolvedIp) wurde ein NAS-Speichergerät erkannt ($labels), aber kein EntenCenter-Backend auf Port $inspectPort. Du kannst $host als NAS-Speicherfreigabe übernehmen oder den EntenCenter-Server starten."
                } else {
                    "Port $inspectPort auf $host ($resolvedIp) ist nicht erreichbar (${e.message ?: "Timeout/Verbindung abgelehnt"})."
                }
                return result
                    .put("ok", false)
                    .put("tcpOk", false)
                    .put("errorKind", if (fritzDetected) "fritzbox_nas_detected" else if (detectedPureNas) "pure_nas_no_backend" else "tcp_unreachable")
                    .put("detail", nasHint)
                    .toString()
            }

            val conn = (URL("$inspectBase/api/nas/auth/bootstrap").openConnection() as HttpURLConnection).apply {
                applySharedNasTrustIfHttps(this)
                requestMethod = "GET"
                connectTimeout = 3500
                readTimeout = 3500
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
            }
            try {
                val code = conn.responseCode
                result.put("httpStatus", code)
                val body = try {
                    (if (code in 200..399) conn.inputStream else conn.errorStream)
                        ?.bufferedReader(Charsets.UTF_8)
                        ?.use { it.readText() }
                        ?: ""
                } catch (_: Exception) {
                    ""
                }
                val isBootstrap = code in 200..299 && isValidEntenCenterBootstrapJson(body)
                result.put("bootstrapOk", isBootstrap)
                result.put("ok", isBootstrap)
                if (!isBootstrap) {
                    val fritzDetected = fritzProbeInfo?.optBoolean("detected", false) == true
                    val kind = when {
                        fritzDetected -> "fritzbox_nas_detected"
                        detectedPureNas -> "pure_nas_no_backend"
                        code in 300..399 || code == 401 || code == 403 -> "auth_redirect"
                        else -> "not_entencenter"
                    }
                    result.put("errorKind", kind)
                    val nasLabels = (0 until openNasServices.length()).mapNotNull { idx ->
                        val o = openNasServices.optJSONObject(idx) ?: return@mapNotNull null
                        "${o.optString("label")} :${o.optString("port")}"
                    }.take(3).joinToString(", ")

                    val httpsErr = fritzProbeInfo?.optString("httpsError", "")?.takeIf { it.isNotBlank() && it != "null" }
                    val httpsNote = if (httpsErr != null) " HTTPS-Fehler („$httpsErr“) wird im LAN automatisch über HTTP (:80) umgangen." else ""

                    result.put(
                        "detail",
                        when (kind) {
                            "fritzbox_nas_detected" ->
                                "FRITZ!Box / FRITZ!NAS unter $host ($resolvedIp) erkannt (Port $inspectPort liefert HTTP $code auf /api/nas/auth/bootstrap, da hier AVM FRITZ!OS statt des EntenCenter-Backends läuft).$httpsNote Bitte FRITZ!Box-Zugangsdaten eingeben oder SMB (:445) / FRITZ!NAS übernehmen."
                            "pure_nas_no_backend" ->
                                "Auf $host ($resolvedIp) läuft ein NAS-Speichergerät ($nasLabels), aber kein EntenCenter-Backend (Port $inspectPort liefert HTTP $code${if (!hasExplicitPort && !port3000Reachable) ", Port 3000 nicht aktiv" else ""}). Übernimm $host unten als NAS-Speicherfreigabe oder installiere/starte den EntenCenter-Server."
                            "auth_redirect" ->
                                "Der Server unter $inspectBase verlangt eine vorgeschaltete Proxy-Anmeldung (HTTP $code) und ist kein direkter EntenCenter-Endpunkt."
                            else ->
                                if (!hasExplicitPort && !port3000Reachable) {
                                    "Standard-Port 3000 auf $host ist nicht erreichbar und Port $inspectPort antwortet mit HTTP $code (kein EntenCenter-NAS-Backend)."
                                } else {
                                    "Port $inspectPort antwortet (HTTP $code), aber dort läuft kein EntenCenter-NAS-Backend."
                                }
                        }
                    )
                }
            } finally {
                conn.disconnect()
            }

            result.toString()
        } catch (ssl: SSLException) {
            result
                .put("ok", false)
                .put("tlsError", true)
                .put("errorKind", "tls_error")
                .put(
                    "detail",
                    "HTTPS-Zertifikat nicht vertrauenswürdig oder TLS-Fehler (${ssl.message ?: "SSL"}). Nutze ein gültiges Zertifikat, aktiviere „Selbstsignierte LAN-Zertifikate akzeptieren“ oder verbinde im LAN per http://."
                )
                .toString()
        } catch (e: Exception) {
            result
                .put("ok", false)
                .put("errorKind", "network_error")
                .put("detail", e.message ?: "Verbindung fehlgeschlagen.")
                .toString()
        }
    }

    private fun isoNowUtc(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    private fun intToIpv4String(ipInt: Int): String? {
        if (ipInt == 0) return null
        val b0 = ipInt and 0xFF
        val b1 = (ipInt ushr 8) and 0xFF
        val b2 = (ipInt ushr 16) and 0xFF
        val b3 = (ipInt ushr 24) and 0xFF
        val candidate = "$b0.$b1.$b2.$b3"
        return if (candidate == "0.0.0.0") null else candidate
    }

    @Suppress("DEPRECATION")
    private fun getWifiGatewayIpv4(): String? {
        return try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
            intToIpv4String(wm.dhcpInfo?.gateway ?: 0)
        } catch (_: Exception) {
            null
        }
    }

    private fun runAndroidIcmpPing(ip: String): JSONObject {
        val out = JSONObject()
            .put("method", "icmp")
            .put("reachable", false)
            .put("sent", 3)
            .put("received", 0)
            .put("packetLossPercent", 100)
            .put("minMs", JSONObject.NULL)
            .put("avgMs", JSONObject.NULL)
            .put("maxMs", JSONObject.NULL)

        if (!Regex("^[a-zA-Z0-9.:-]{1,253}$").matches(ip)) {
            return out.put("sent", 0).put("error", "Ungültige Ziel-IP für ICMP-Ping.")
        }

        return try {
            val proc = ProcessBuilder("/system/bin/ping", "-c", "3", "-W", "2", ip)
                .redirectErrorStream(true)
                .start()
            val finished = proc.waitFor(6500, TimeUnit.MILLISECONDS)
            val stdout = proc.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            if (!finished) {
                proc.destroyForcibly()
            }
            val pktMatch = Regex("(\\d+)\\s+packets transmitted,\\s+(\\d+)\\s+received", RegexOption.IGNORE_CASE).find(stdout)
            val sent = pktMatch?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 3
            val received = pktMatch?.groupValues?.getOrNull(2)?.toIntOrNull() ?: 0
            val lossMatch = Regex("(\\d+(?:\\.\\d+)?)%\\s+packet loss", RegexOption.IGNORE_CASE).find(stdout)
            val lossPct = lossMatch?.groupValues?.getOrNull(1)?.toDoubleOrNull()?.let { Math.round(it).toInt() }
                ?: if (sent > 0) Math.round(((sent - received).toDouble() / sent.toDouble()) * 100.0).toInt() else 100

            val rttMatch = Regex("(?:rtt|round-trip)\\s+min/avg/max(?:/mdev|/stddev)?\\s*=\\s*([0-9.]+)/([0-9.]+)/([0-9.]+)", RegexOption.IGNORE_CASE)
                .find(stdout)
            out.put("reachable", received > 0)
            out.put("sent", sent)
            out.put("received", received)
            out.put("packetLossPercent", lossPct)
            if (rttMatch != null) {
                val minV = Math.round((rttMatch.groupValues[1].toDoubleOrNull() ?: 0.0) * 10.0) / 10.0
                val avgV = Math.round((rttMatch.groupValues[2].toDoubleOrNull() ?: 0.0) * 10.0) / 10.0
                val maxV = Math.round((rttMatch.groupValues[3].toDoubleOrNull() ?: 0.0) * 10.0) / 10.0
                out.put("minMs", minV).put("avgMs", avgV).put("maxMs", maxV)
            }
            if (received == 0) {
                out.put("error", "100% Paketverlust (ICMP blockiert oder Host nicht erreichbar)")
            }
            out
        } catch (e: Exception) {
            out.put("error", e.message ?: "ICMP-Ping nicht verfügbar")
        }
    }

    private fun probeTcpWithLatency(addr: InetAddress, port: Int, timeoutMs: Int = 1400): Triple<Boolean, Double?, String?> {
        val startedNs = System.nanoTime()
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(addr, port), timeoutMs)
            }
            val elapsedMs = Math.round(((System.nanoTime() - startedNs) / 1_000_000.0) * 10.0) / 10.0
            Triple(true, elapsedMs.coerceAtLeast(0.1), null)
        } catch (_: SocketTimeoutException) {
            Triple(false, null, "ETIMEDOUT")
        } catch (ce: ConnectException) {
            val msg = (ce.message ?: "").lowercase()
            val code = if (msg.contains("refused")) "ECONNREFUSED" else "ECONNFAILED"
            Triple(false, null, code)
        } catch (e: Exception) {
            Triple(false, null, e.javaClass.simpleName.uppercase())
        }
    }

    private fun runAndroidTracerouteEquivalent(
        resolvedAddr: InetAddress,
        resolvedIp: String,
        targetPort: Int,
        pingAvgMs: Double?
    ): JSONObject {
        val gatewayIp = getWifiGatewayIpv4()
        val localIp = getLocalLanIpv4Interfaces().firstOrNull()?.first
        val ttlHops = JSONArray()
        var reachedTargetInTtl = false

        if (Regex("^[a-zA-Z0-9.:-]{1,253}$").matches(resolvedIp)) {
            for (ttl in 1..6) {
                try {
                    val proc = ProcessBuilder("/system/bin/ping", "-t", ttl.toString(), "-c", "1", "-W", "1", resolvedIp)
                        .redirectErrorStream(true)
                        .start()
                    val finished = proc.waitFor(1700, TimeUnit.MILLISECONDS)
                    val stdout = proc.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                    if (!finished) proc.destroyForcibly()

                    val rttMatch = Regex("time=([0-9.]+)\\s*ms", RegexOption.IGNORE_CASE).find(stdout)
                    val ttlExceededMatch = Regex("From\\s+([0-9a-fA-F.:]+).*Time to live exceeded", RegexOption.IGNORE_CASE).find(stdout)

                    if (ttlExceededMatch != null) {
                        val hopIp = ttlExceededMatch.groupValues[1]
                        ttlHops.put(
                            JSONObject()
                                .put("hop", ttl)
                                .put("host", hopIp)
                                .put("ip", hopIp)
                                .put("rttMs", JSONObject.NULL)
                                .put("status", if (ttl == 1 && hopIp == gatewayIp) "gateway" else "reached")
                                .put("note", if (ttl == 1) "Router / Gateway-Hop" else "Zwischen-Hop")
                        )
                    } else if (rttMatch != null) {
                        val rttVal = Math.round((rttMatch.groupValues[1].toDoubleOrNull() ?: 0.0) * 10.0) / 10.0
                        ttlHops.put(
                            JSONObject()
                                .put("hop", ttl)
                                .put("host", resolvedIp)
                                .put("ip", resolvedIp)
                                .put("rttMs", rttVal)
                                .put("status", "reached")
                                .put("note", "Ziel-Host erreicht")
                        )
                        reachedTargetInTtl = true
                        break
                    } else {
                        break
                    }
                } catch (_: Exception) {
                    break
                }
            }
        }

        if (reachedTargetInTtl && ttlHops.length() > 0) {
            val count = ttlHops.length()
            return JSONObject()
                .put("method", "ttl_ping_probe")
                .put("gatewayIp", gatewayIp ?: JSONObject.NULL)
                .put("hops", ttlHops)
                .put("summary", "$count Hop${if (count == 1) "" else "s"} per TTL-Ping bis $resolvedIp ermittelt.")
        }

        val fallbackHops = JSONArray()
        fallbackHops.put(
            JSONObject()
                .put("hop", 1)
                .put("host", localIp ?: "Android WLAN-Interface")
                .put("ip", localIp ?: JSONObject.NULL)
                .put("rttMs", 0.2)
                .put("status", "local")
                .put("note", "Tablet / Quell-Schnittstelle")
        )
        if (!gatewayIp.isNullOrBlank()) {
            val gwProbe = try {
                probeTcpWithLatency(InetAddress.getByName(gatewayIp), 80, 750)
            } catch (_: Exception) {
                Triple(false, null, null)
            }
            fallbackHops.put(
                JSONObject()
                    .put("hop", 2)
                    .put("host", gatewayIp)
                    .put("ip", gatewayIp)
                    .put("rttMs", gwProbe.second ?: JSONObject.NULL)
                    .put("status", "gateway")
                    .put("note", "Standard-Gateway / Router")
            )
        }
        val targetTcp = probeTcpWithLatency(resolvedAddr, targetPort, 1300)
        fallbackHops.put(
            JSONObject()
                .put("hop", fallbackHops.length() + 1)
                .put("host", "$resolvedIp:$targetPort")
                .put("ip", resolvedIp)
                .put("rttMs", pingAvgMs ?: targetTcp.second ?: JSONObject.NULL)
                .put("status", if (targetTcp.first) "reached" else "timeout")
                .put(
                    "note",
                    if (targetTcp.first) "Zielport $targetPort antwortet"
                    else "Zielport $targetPort: ${targetTcp.third ?: "nicht erreichbar"}"
                )
        )

        return JSONObject()
            .put("method", "route_equivalent")
            .put("gatewayIp", gatewayIp ?: JSONObject.NULL)
            .put("hops", fallbackHops)
            .put(
                "summary",
                if (!gatewayIp.isNullOrBlank()) "Pfad über Gateway $gatewayIp nach $resolvedIp:$targetPort geprüft."
                else "Direkte Netzwerk-Route nach $resolvedIp:$targetPort geprüft."
            )
    }

    private fun performDeepNetworkDiagnostics(rawTarget: String): String {
        val startedMs = System.currentTimeMillis()
        val savedFallback = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_SERVER_URL, "") ?: ""
        val candidateInput = rawTarget.trim().ifBlank { savedFallback }.ifBlank { "127.0.0.1:3000" }
        val withScheme =
            if (candidateInput.startsWith("http://", ignoreCase = true) ||
                candidateInput.startsWith("https://", ignoreCase = true)
            ) {
                candidateInput
            } else if (candidateInput.contains(":443") || candidateInput.contains(":8443")) {
                "https://$candidateInput"
            } else {
                "http://$candidateInput"
            }

        val parsed = try {
            URL(withScheme)
        } catch (_: Exception) {
            null
        }
        val hostname = parsed?.host?.trim()?.ifBlank { "127.0.0.1" } ?: "127.0.0.1"
        val scheme = if (parsed?.protocol.equals("https", ignoreCase = true)) "https" else "http"
        val targetPort = when {
            (parsed?.port ?: -1) > 0 -> parsed!!.port
            scheme == "https" -> 443
            else -> 80
        }

        val dnsStart = System.currentTimeMillis()
        var resolvedAddr: InetAddress? = null
        var dnsError: String? = null
        try {
            resolvedAddr = InetAddress.getByName(hostname)
        } catch (e: Exception) {
            dnsError = e.message ?: "DNS-Auflösung fehlgeschlagen"
        }
        val dnsLatencyMs = (System.currentTimeMillis() - dnsStart).coerceAtLeast(0L)
        val resolvedIp = resolvedAddr?.hostAddress

        val isLan = if (resolvedAddr != null) {
            resolvedAddr.isSiteLocalAddress ||
                resolvedAddr.isLoopbackAddress ||
                resolvedAddr.isLinkLocalAddress ||
                hostname.endsWith(".local", ignoreCase = true) ||
                hostname.endsWith(".box", ignoreCase = true)
        } else {
            hostname == "localhost" ||
                hostname.endsWith(".local", ignoreCase = true) ||
                hostname.endsWith(".box", ignoreCase = true) ||
                hostname.startsWith("192.168.") ||
                hostname.startsWith("10.")
        }
        val scope = if (isLan) "lan" else "remote"

        if (resolvedAddr == null || resolvedIp == null) {
            val findings = JSONArray().put(
                JSONObject()
                    .put("severity", "error")
                    .put("code", "DNS_FAILED")
                    .put("title", "Hostname nicht auflösbar")
                    .put("detail", dnsError ?: "Hostname \"$hostname\" liefert keine IP-Adresse.")
                    .put("recommendation", "Prüfe Schreibweise, WLAN-Verbindung, lokales mDNS (.local) oder DynDNS-Eintrag.")
            )
            return JSONObject()
                .put("targetInput", candidateInput)
                .put("hostname", hostname)
                .put("resolvedIp", JSONObject.NULL)
                .put("targetPort", targetPort)
                .put("scheme", scheme)
                .put("scope", scope)
                .put(
                    "dns",
                    JSONObject()
                        .put("ok", false)
                        .put("latencyMs", dnsLatencyMs)
                        .put("resolvedIp", JSONObject.NULL)
                        .put("error", dnsError ?: "DNS-Fehler")
                )
                .put(
                    "ping",
                    JSONObject()
                        .put("method", "icmp")
                        .put("reachable", false)
                        .put("sent", 0)
                        .put("received", 0)
                        .put("packetLossPercent", 100)
                        .put("minMs", JSONObject.NULL)
                        .put("avgMs", JSONObject.NULL)
                        .put("maxMs", JSONObject.NULL)
                        .put("error", "DNS-Auflösung fehlgeschlagen")
                )
                .put(
                    "traceroute",
                    JSONObject()
                        .put("method", "route_equivalent")
                        .put("gatewayIp", JSONObject.NULL)
                        .put("hops", JSONArray())
                        .put("summary", "Kein Routen-Check möglich, da DNS-Name nicht aufgelöst wurde.")
                )
                .put("portMatrix", JSONArray())
                .put("http400Analysis", JSONObject.NULL)
                .put("findings", findings)
                .put("executedOn", "android_native")
                .put("measuredAt", isoNowUtc())
                .put("durationMs", (System.currentTimeMillis() - startedMs).coerceAtLeast(1L))
                .toString()
        }

        // 1. ICMP Ping
        val pingObj = runAndroidIcmpPing(resolvedIp)

        // 2. Port Matrix & HTTP 400 Inspection
        data class PortSpec(val port: Int, val label: String, val protocolHint: String)
        val rawSpecs = listOf(
            PortSpec(targetPort, "Ziel-Port ($targetPort)", scheme),
            PortSpec(3000, "EntenCenter Standard", "http"),
            PortSpec(3001, "EntenCenter Ausweichport 1", "http"),
            PortSpec(3002, "EntenCenter Ausweichport 2", "http"),
            PortSpec(3005, "EntenCenter Ausweichport 3", "http"),
            PortSpec(8000, "HTTP-Alt / Dev-Backend", "http"),
            PortSpec(8080, "HTTP-Alt / QNAP / Proxy", "http"),
            PortSpec(8081, "HTTP-Alt 8081", "http"),
            PortSpec(8443, "HTTPS-Alt / Proxy", "https"),
            PortSpec(8888, "EntenCenter Ausweichport 8888", "http"),
            PortSpec(9000, "NAS Service / Ausweichport", "http"),
            PortSpec(80, "HTTP / Reverse-Proxy", "http"),
            PortSpec(443, "HTTPS / Reverse-Proxy", "https"),
            PortSpec(445, "SMB / CIFS", "tcp"),
            PortSpec(5000, "Synology DSM (HTTP)", "http"),
            PortSpec(5001, "Synology DSM (HTTPS)", "https"),
            PortSpec(5005, "WebDAV (HTTP)", "http"),
            PortSpec(5006, "WebDAV (HTTPS)", "https"),
            PortSpec(22, "SFTP / SSH", "tcp")
        )
        val seenPorts = HashSet<Int>()
        val uniqueSpecs = rawSpecs.filter { seenPorts.add(it.port) }

        val portResults = ConcurrentHashMap<Int, JSONObject>()
        val matrixPool = Executors.newFixedThreadPool(10)
        try {
            val futures = uniqueSpecs.map { spec ->
                matrixPool.submit {
                    val (tcpOpen, tcpMs, errCode) = probeTcpWithLatency(resolvedAddr, spec.port, 1400)
                    val entry = JSONObject()
                        .put("port", spec.port)
                        .put("label", spec.label)
                        .put("protocolHint", spec.protocolHint)
                        .put("tcpOpen", tcpOpen)
                        .put("latencyMs", tcpMs ?: JSONObject.NULL)
                        .put("errorCode", if (tcpOpen) JSONObject.NULL else (errCode ?: "UNREACHABLE"))

                    if (tcpOpen && (spec.protocolHint == "http" || spec.protocolHint == "https")) {
                        val probeScheme = when (spec.port) {
                            443, 8443, 5001, 5006 -> "https"
                            80, 3000, 3001, 3002, 3005, 8000, 8081, 8888, 9000, 5000, 5005 -> "http"
                            else -> spec.protocolHint
                        }
                        try {
                            val conn = (URL("$probeScheme://$resolvedIp:${spec.port}/api/nas/auth/bootstrap").openConnection() as HttpURLConnection).apply {
                                applySharedNasTrustIfHttps(this)
                                requestMethod = "GET"
                                connectTimeout = 2400
                                readTimeout = 2400
                                instanceFollowRedirects = false
                                setRequestProperty("Accept", "application/json")
                                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                                setRequestProperty("Connection", "close")
                            }
                            try {
                                val code = conn.responseCode
                                val serverHdr = conn.getHeaderField("Server")
                                entry.put("httpStatus", code)
                                if (!serverHdr.isNullOrBlank()) {
                                    entry.put("serverHeader", serverHdr)
                                } else {
                                    entry.put("serverHeader", JSONObject.NULL)
                                }
                                if (code in 200..299) {
                                    val body = conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                                    entry.put("isEntenCenter", isValidEntenCenterBootstrapJson(body))
                                } else {
                                    entry.put("isEntenCenter", false)
                                }
                            } finally {
                                conn.disconnect()
                            }
                        } catch (_: Exception) {
                            // HTTP/TLS Probe fehlgeschlagen
                        }
                    }
                    portResults[spec.port] = entry
                }
            }
            for (f in futures) {
                try {
                    f.get(4800, TimeUnit.MILLISECONDS)
                } catch (_: Exception) {
                }
            }
        } finally {
            matrixPool.shutdownNow()
        }

        val portMatrix = JSONArray()
        val orderedEntries = mutableListOf<JSONObject>()
        for (spec in uniqueSpecs) {
            val e = portResults[spec.port] ?: JSONObject()
                .put("port", spec.port)
                .put("label", spec.label)
                .put("protocolHint", spec.protocolHint)
                .put("tcpOpen", false)
                .put("latencyMs", JSONObject.NULL)
                .put("errorCode", "ETIMEDOUT")
            portMatrix.put(e)
            orderedEntries.add(e)
        }
        val entenCenterEntry = orderedEntries.firstOrNull { it.optBoolean("isEntenCenter", false) }

        // TCP-SYN-Fallback, wenn ICMP blockiert ist
        if (!pingObj.optBoolean("reachable", false)) {
            val openFallbackPort = orderedEntries.firstOrNull { it.optBoolean("tcpOpen", false) }?.optInt("port", targetPort)
                ?: targetPort
            val samples = mutableListOf<Double>()
            for (i in 0 until 3) {
                val (ok, ms, _) = probeTcpWithLatency(resolvedAddr, openFallbackPort, 1100)
                if (ok && ms != null) samples.add(ms)
            }
            if (samples.isNotEmpty()) {
                val minMs = samples.minOrNull() ?: samples.first()
                val maxMs = samples.maxOrNull() ?: samples.first()
                val avgMs = Math.round((samples.sum() / samples.size.toDouble()) * 10.0) / 10.0
                val lossPct = Math.round(((3 - samples.size).toDouble() / 3.0) * 100.0).toInt()
                pingObj
                    .put("method", "tcp_syn_fallback")
                    .put("reachable", true)
                    .put("sent", 3)
                    .put("received", samples.size)
                    .put("packetLossPercent", lossPct)
                    .put("minMs", minMs)
                    .put("avgMs", avgMs)
                    .put("maxMs", maxMs)
                    .put("error", "ICMP-Echo blockiert/verworfen — Latenz über TCP-SYN-Handshake (Port $openFallbackPort) gemessen.")
            }
        }

        val avgLatencyOrNull = if (pingObj.isNull("avgMs")) null else pingObj.optDouble("avgMs")
        val tracerouteObj = runAndroidTracerouteEquivalent(resolvedAddr, resolvedIp, targetPort, avgLatencyOrNull)

        // FRITZ!Box / FRITZ!NAS Erkennung über /login_sid.lua (:80/:443) & TR-064
        val shouldCheckFritz = entenCenterEntry == null && (
            orderedEntries.any { it.optBoolean("tcpOpen", false) && it.optInt("port") in listOf(80, 443, 445) } ||
                hostname.contains("fritz", ignoreCase = true)
            )
        val fritzBoxInfo: JSONObject? = if (shouldCheckFritz) {
            FritzBoxSessionHelper.probeLoginSid(
                host = resolvedIp,
                allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                configureTrust = { applySharedNasTrustIfHttps(it) }
            )
        } else null
        val isFritzDetected = fritzBoxInfo?.optBoolean("detected", false) == true

        // 400er-, Firewall- & Port-Konflikt-Analyse
        val targetEntry = orderedEntries.firstOrNull { it.optInt("port") == targetPort }
        val port3000Entry = orderedEntries.firstOrNull { it.optInt("port") == 3000 }
        val http400Entry =
            orderedEntries.firstOrNull {
                it.optInt("port") == targetPort &&
                    it.has("httpStatus") &&
                    !it.isNull("httpStatus") &&
                    it.optInt("httpStatus") in 400..499
            } ?: orderedEntries.firstOrNull {
                it.has("httpStatus") && !it.isNull("httpStatus") && it.optInt("httpStatus") == 400
            }

        var http400Obj: JSONObject? = null
        if (http400Entry != null) {
            val ePort = http400Entry.optInt("port")
            val eStatus = http400Entry.optInt("httpStatus")
            val srvHdr = if (http400Entry.isNull("serverHeader")) "" else http400Entry.optString("serverHeader", "")
            val causes = JSONArray()
            val hints = JSONArray()

            if (isFritzDetected && (ePort == 80 || ePort == 443)) {
                causes.put("port_conflict")
                hints.put(
                    "AVM FRITZ!OS erkannt: Das FRITZ!Box/FRITZ!NAS-Webinterface auf Port $ePort weist /api/nas/auth/bootstrap normal mit HTTP $eStatus ab — dort läuft die FRITZ!Box selbst und kein EntenCenter-Server."
                )
                if (fritzBoxInfo?.optBoolean("httpsAvailable", false) == false) {
                    val httpsErr = fritzBoxInfo.optString("httpsError", "")
                    hints.put(
                        "FRITZ!Box HTTPS-Hinweis${if (httpsErr.isNotBlank() && httpsErr != "null") " ($httpsErr)" else ""}: Lokales HTTP (:80 /login_sid.lua) und Challenge-Response funktionieren automatisch als Fallback."
                    )
                }
                if (fritzBoxInfo?.optBoolean("requiresAuth", true) == true) {
                    hints.put(
                        "Anmeldepflicht vor FRITZ!NAS-Zugriff: Bitte FRITZ!Box-Benutzername (optional) und Kennwort eingeben."
                    )
                }
            } else {
                if (ePort == 80 || ePort == 443 || ePort == 8080) {
                    causes.put("port_conflict")
                    val srvNote = if (srvHdr.isNotBlank()) " ($srvHdr)" else ""
                    hints.put(
                        "Port-Konflikt wahrscheinlich: Auf Port $ePort antwortet bereits ein anderer Dienst$srvNote mit HTTP $eStatus — dort läuft kein direktes EntenCenter-Backend."
                    )
                }
                if (ePort == 443 || ePort == 8443 || ePort == 5001 || ePort == 80) {
                    causes.put("tls_on_http_port")
                    hints.put(
                        "Protokoll-Mismatch (HTTP vs. HTTPS): Prüfe, ob der Port HTTPS/TLS erwartet oder ein HTTP-Redirect auf HTTPS fehlt."
                    )
                }
                causes.put("proxy_header_filter")
                hints.put(
                    "Reverse-Proxy / Header-Filter: Nginx, Apache, Synology Reverse Proxy oder Traefik weisen Anfragen ohne passenden Host-Header, CORS-/Private-Network-Header oder WebSocket-Upgrade oft mit HTTP 400 ab."
                )
            }

            if (port3000Entry != null && !port3000Entry.optBoolean("tcpOpen", false)) {
                causes.put("firewall_or_wrong_service")
                val errCode3000 = port3000Entry.optString("errorCode", "")
                hints.put(
                    if (errCode3000 == "ETIMEDOUT") {
                        "Firewall-Blockade auf Port 3000: Pakete werden verworfen (ETIMEDOUT). Gib Port 3000/TCP in NAS-Firewall und Router frei."
                    } else {
                        "Port 3000 lehnt Verbindungen ab (ECONNREFUSED): EntenCenter-Server ist nicht gestartet oder lauscht nur auf 127.0.0.1 statt 0.0.0.0."
                    }
                )
            } else if (entenCenterEntry != null && entenCenterEntry.optInt("port") != ePort) {
                hints.put(
                    "EntenCenter-Backend läuft stattdessen auf Port ${entenCenterEntry.optInt("port")}! Ändere die Ziel-URL auf Port :${entenCenterEntry.optInt("port")}."
                )
            }

            http400Obj = JSONObject()
                .put("detected", true)
                .put("port", ePort)
                .put("statusCode", eStatus)
                .put("serverHeader", if (srvHdr.isNotBlank()) srvHdr else JSONObject.NULL)
                .put("probableCauses", causes)
                .put(
                    "summary",
                    if (isFritzDetected && (ePort == 80 || ePort == 443)) {
                        "AVM FRITZ!OS auf $resolvedIp belegt Port $ePort (FRITZ!Box/FRITZ!NAS liefert HTTP $eStatus auf /api/nas/auth/bootstrap). Die Verbindung zur FRITZ!Box läuft per Challenge-Response über /login_sid.lua oder SMB (:445)."
                    } else {
                        "HTTP $eStatus auf Port $ePort deutet auf einen Port-Konflikt, fehlende HTTPS/Proxy-Header oder einen fremden NAS-/Webdienst hin."
                    }
                )
                .put("hints", hints)
        }

        val findings = JSONArray()
        if (isFritzDetected && fritzBoxInfo != null) {
            val friendly = fritzBoxInfo.optString("friendlyName", "FRITZ!Box / FRITZ!NAS ($resolvedIp)")
            val httpOk = fritzBoxInfo.optBoolean("httpAvailable", false)
            val httpsOk = fritzBoxInfo.optBoolean("httpsAvailable", false)
            val reqAuth = fritzBoxInfo.optBoolean("requiresAuth", true)
            val httpsErr = fritzBoxInfo.optString("httpsError", "").takeIf { it.isNotBlank() && it != "null" }
            findings.put(
                JSONObject()
                    .put("severity", if (httpOk) "ok" else "info")
                    .put("code", "FRITZBOX_DETECTED")
                    .put("title", "$friendly erkannt (${if (reqAuth) "Anmeldung mit Zugangsdaten erforderlich" else "Bereit"})")
                    .put(
                        "detail",
                        buildString {
                            append("FRITZ!Box Login-Schnittstelle unter $resolvedIp antwortet: ")
                            append(if (httpOk) "HTTP (:80 /login_sid.lua) OK" else "HTTP (:80) nicht aktiv")
                            append(" · ")
                            append(
                                if (httpsOk) "HTTPS (:443) OK"
                                else "HTTPS (:443) Fehler (${httpsErr ?: "nicht vertrauenswürdig/aus"}) -> automatischer HTTP-Fallback"
                            )
                            append(".")
                        }
                    )
                    .put(
                        "recommendation",
                        if (reqAuth)
                            "FRITZ!Box-Benutzername (optional) und Kennwort vor dem NAS-Zugriff eingeben (Challenge-Response-Login wird unterstützt)."
                        else
                            "FRITZ!Box als FRITZ!NAS-Quelle (http://$resolvedIp) mit SMB/Challenge-Response übernehmen."
                    )
            )
        }

        if (entenCenterEntry != null) {
            val ecPort = entenCenterEntry.optInt("port")
            val ecLat = entenCenterEntry.optDouble("latencyMs", 1.0)
            findings.put(
                JSONObject()
                    .put("severity", "ok")
                    .put("code", "ENTENCENTER_REACHABLE")
                    .put("title", "EntenCenter-Backend aktiv auf Port $ecPort")
                    .put("detail", "Der Endpunkt $resolvedIp:$ecPort liefert gültiges EntenCenter-Bootstrap JSON ($ecLat ms).")
                    .put(
                        "recommendation",
                        if (ecPort != targetPort) "Verwende Port $ecPort statt $targetPort in deiner Server-URL."
                        else "Verbindung betriebsbereit."
                    )
            )
        }

        if (http400Obj != null) {
            val firstHint = http400Obj.optJSONArray("hints")?.optString(0) ?: "Prüfe Port-Belegung und Reverse-Proxy-Regeln."
            val conflictPort = http400Obj.optInt("port")
            findings.put(
                JSONObject()
                    .put("severity", if (isFritzDetected && (conflictPort == 80 || conflictPort == 443)) "info" else "error")
                    .put("code", "HTTP_${http400Obj.optInt("statusCode")}_CONFLICT")
                    .put(
                        "title",
                        if (isFritzDetected && (conflictPort == 80 || conflictPort == 443))
                            "FRITZ!Box Web/NAS belegt Port $conflictPort (HTTP ${http400Obj.optInt("statusCode")})"
                        else
                            "HTTP ${http400Obj.optInt("statusCode")} auf Port $conflictPort (Port-Konflikt / Proxy)"
                    )
                    .put("detail", http400Obj.optString("summary"))
                    .put("recommendation", firstHint)
            )
        }

        if (targetEntry != null && !targetEntry.optBoolean("tcpOpen", false)) {
            val errCode = targetEntry.optString("errorCode", "ECONNREFUSED")
            val isTimeout = errCode == "ETIMEDOUT"
            findings.put(
                JSONObject()
                    .put("severity", "error")
                    .put("code", if (isTimeout) "FIREWALL_DROP" else "PORT_CLOSED")
                    .put(
                        "title",
                        if (isTimeout) "Firewall-Blockade vermutet auf Port $targetPort"
                        else "Port $targetPort geschlossen ($errCode)"
                    )
                    .put(
                        "detail",
                        if (isTimeout)
                            "Verbindung zu $resolvedIp:$targetPort lief ins Timeout — typisch für eine blockierende Firewall (Host-Firewall oder fehlende Router-Portfreigabe)."
                        else
                            "$resolvedIp:$targetPort weist Verbindungen sofort ab. Auf diesem Port lauscht aktuell kein Prozess."
                    )
                    .put(
                        "recommendation",
                        if (isTimeout)
                            "Port $targetPort/TCP in der NAS-/System-Firewall (z. B. ufw, Synology DSM Firewall) sowie bei Fernzugriff im Router freigeben."
                        else
                            "EntenCenter-Server starten bzw. Bind-Adresse auf 0.0.0.0 prüfen oder auf Port 3000 umschalten."
                    )
            )
        }

        val allClosed = orderedEntries.none { it.optBoolean("tcpOpen", false) }
        if (!pingObj.optBoolean("reachable", false) && allClosed) {
            findings.put(
                JSONObject()
                    .put("severity", "error")
                    .put("code", "HOST_UNREACHABLE")
                    .put("title", "Ziel-Host $resolvedIp nicht erreichbar")
                    .put("detail", "Weder ICMP-Ping noch bekannte TCP-Ports antworten auf diesem Ziel.")
                    .put("recommendation", "Prüfe WLAN-/LAN-Zugehörigkeit, IP-Adresse, Stromversorgung des NAS oder aktive VPN-Verbindung.")
            )
        } else if (pingObj.optString("method") == "tcp_syn_fallback") {
            findings.put(
                JSONObject()
                    .put("severity", "info")
                    .put("code", "ICMP_BLOCKED_TCP_OK")
                    .put("title", "ICMP-Ping blockiert, TCP-Verbindung jedoch möglich")
                    .put("detail", "Die Firewall verwirft ICMP-Echo-Pakete, lässt aber TCP-Verkehr durch.")
                    .put("recommendation", "Verbindungstests per TCP/HTTP funktionieren weiterhin normal.")
            )
        }

        val pureNasList = orderedEntries.filter {
            it.optBoolean("tcpOpen", false) && it.optInt("port") in listOf(445, 5000, 5001, 5005, 5006, 22)
        }
        if (entenCenterEntry == null && pureNasList.isNotEmpty()) {
            val desc = pureNasList.joinToString(", ") { "${it.optString("label")} (${it.optInt("port")})" }
            findings.put(
                JSONObject()
                    .put("severity", if (isFritzDetected) "info" else "warn")
                    .put("code", "PURE_NAS_STORAGE_ONLY")
                    .put(
                        "title",
                        if (isFritzDetected) "FRITZ!NAS SMB-Freigabe & Login erkannt (kein EntenCenter-Backend auf :3000)"
                        else "NAS-Speicherdienste erkannt, aber kein EntenCenter-Backend"
                    )
                    .put("detail", "Offene NAS-Ports: $desc.")
                    .put(
                        "recommendation",
                        if (isFritzDetected)
                            "FRITZ!Box-Zugangsdaten eingeben und als FRITZ!NAS / SMB (:445) einbinden."
                        else
                            "Trage diese IP als NAS-Speicherfreigabe (SMB/WebDAV/DSM) ein oder starte dort den EntenCenter-Server auf Port 3000."
                    )
            )
        }

        return JSONObject()
            .put("targetInput", candidateInput)
            .put("hostname", hostname)
            .put("resolvedIp", resolvedIp)
            .put("targetPort", targetPort)
            .put("scheme", scheme)
            .put("scope", scope)
            .put(
                "dns",
                JSONObject()
                    .put("ok", true)
                    .put("latencyMs", dnsLatencyMs)
                    .put("resolvedIp", resolvedIp)
            )
            .put("ping", pingObj)
            .put("traceroute", tracerouteObj)
            .put("portMatrix", portMatrix)
            .put("http400Analysis", http400Obj ?: JSONObject.NULL)
            .put("fritzBoxInfo", fritzBoxInfo ?: JSONObject.NULL)
            .put("findings", findings)
            .put("executedOn", "android_native")
            .put("measuredAt", isoNowUtc())
            .put("durationMs", (System.currentTimeMillis() - startedMs).coerceAtLeast(1L))
            .toString()
    }

    private fun mapServiceProtocol(serviceType: String, port: Int): Triple<String, String, String> {
        val lower = serviceType.lowercase()
        return when {
            lower.contains("_entencenter._tcp") -> Triple("entencenter", "EntenCenter Server", "/")
            lower.contains("_smb._tcp") -> Triple("smb", "SMB / CIFS", "/Medien")
            lower.contains("_nfs._tcp") -> Triple("nfs", "NFS", "/volume1/video")
            lower.contains("_webdavs._tcp") || port == 5006 -> Triple("webdav", "WebDAV (HTTPS)", "/Medien")
            lower.contains("_webdav._tcp") || port == 5005 -> Triple("webdav", "WebDAV (HTTP)", "/Medien")
            lower.contains("_sftp-ssh._tcp") || port == 22 -> Triple("sftp", "SFTP / SSH", "/mnt/nas/medien")
            lower.contains("_ftp._tcp") || port == 21 -> Triple("ftps", "FTP / FTPS", "/")
            lower.contains("_https._tcp") || port == 5001 || port == 443 ->
                Triple("api_token", "NAS Web / API (HTTPS)", "/api/v3")
            port == 3000 -> Triple("entencenter", "EntenCenter Server", "/")
            else -> Triple("api_token", "NAS Web / HTTP", "/")
        }
    }

    private fun getLocalLanIpv4Interfaces(): List<Pair<String, ByteArray>> {
        val list = mutableListOf<Pair<String, ByteArray>>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return list
            val candidates = mutableListOf<Triple<Int, String, ByteArray>>()
            while (ifaces.hasMoreElements()) {
                val nif = ifaces.nextElement()
                if (!nif.isUp || nif.isLoopback) continue
                val ifName = (nif.name ?: "").lowercase()
                val addrs = nif.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        val ip = addr.hostAddress ?: continue
                        val priority = when {
                            ifName.startsWith("wlan") || ifName.startsWith("eth") -> 0
                            ip.startsWith("192.168.") -> 1
                            else -> 2
                        }
                        candidates.add(Triple(priority, ip, addr.address))
                    }
                }
            }
            candidates.sortBy { it.first }
            for (c in candidates) {
                list.add(c.second to c.third)
            }
        } catch (_: Exception) {
            // Ignorieren
        }
        return list
    }

    private fun isPortOpen(ip: String, port: Int, timeoutMs: Int = 220): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(ip, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun checkEntenCenterBootstrap(baseUrl: String): Boolean {
        return probeBootstrapAtBase(baseUrl, 500).first
    }

    private fun readArpLanNeighbors(): List<String> {
        val ips = LinkedHashSet<String>()
        try {
            val arpFile = File("/proc/net/arp")
            if (arpFile.exists() && arpFile.canRead()) {
                arpFile.forEachLine { line ->
                    val cols = line.trim().split(Regex("\\s+"))
                    val ip = cols.firstOrNull() ?: return@forEachLine
                    val mac = cols.getOrNull(3) ?: ""
                    if (ip.contains('.') && mac != "00:00:00:00:00:00" && FritzBoxSessionHelper.isLocalLanHost(ip)) {
                        ips.add(ip)
                    }
                }
            }
        } catch (_: Exception) {
        }
        return ips.toList()
    }

    /**
     * Nicht-blockierender Java-NIO TCP-Sweep: prüft hunderte (IP, Port)-Paare parallel in ~450-650 ms
     * statt serieller Socket.connect()-Timeouts von >6 Sekunden.
     */
    private fun nioSweepOpenPorts(
        ips: Collection<String>,
        ports: List<Int>,
        totalBudgetMs: Long = 650L
    ): Map<String, MutableSet<Int>> {
        val openMap = HashMap<String, MutableSet<Int>>()
        if (ips.isEmpty() || ports.isEmpty()) return openMap

        val targets = ArrayList<Pair<String, Int>>(ips.size * ports.size)
        for (ip in ips) {
            for (p in ports) {
                targets.add(ip to p)
            }
        }

        val chunkSize = 240
        var idx = 0
        val overallDeadline = System.currentTimeMillis() + totalBudgetMs
        while (idx < targets.size && System.currentTimeMillis() < overallDeadline) {
            val end = (idx + chunkSize).coerceAtMost(targets.size)
            val batch = targets.subList(idx, end)
            idx = end

            var selector: Selector? = null
            val channels = ArrayList<SocketChannel>(batch.size)
            try {
                selector = Selector.open()
                for ((ip, port) in batch) {
                    try {
                        val ch = SocketChannel.open()
                        ch.configureBlocking(false)
                        if (ch.connect(InetSocketAddress(ip, port))) {
                            openMap.getOrPut(ip) { HashSet() }.add(port)
                            ch.close()
                        } else {
                            ch.register(selector, SelectionKey.OP_CONNECT, ip to port)
                            channels.add(ch)
                        }
                    } catch (_: Exception) {
                    }
                }

                val batchDeadline = minOf(overallDeadline, System.currentTimeMillis() + 260L)
                while (channels.isNotEmpty() && System.currentTimeMillis() < batchDeadline) {
                    val waitMs = (batchDeadline - System.currentTimeMillis()).coerceAtLeast(10L)
                    val ready = selector.select(waitMs)
                    if (ready <= 0) continue
                    val iter = selector.selectedKeys().iterator()
                    while (iter.hasNext()) {
                        val key = iter.next()
                        iter.remove()
                        val ch = key.channel() as? SocketChannel ?: continue
                        @Suppress("UNCHECKED_CAST")
                        val pair = key.attachment() as? Pair<String, Int>
                        try {
                            if (key.isConnectable && ch.finishConnect() && pair != null) {
                                openMap.getOrPut(pair.first) { HashSet() }.add(pair.second)
                            }
                        } catch (_: Exception) {
                        } finally {
                            try { ch.close() } catch (_: Exception) {}
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                for (ch in channels) {
                    try { ch.close() } catch (_: Exception) {}
                }
                try { selector?.close() } catch (_: Exception) {}
            }
        }
        return openMap
    }

    @Suppress("DEPRECATION")
    private fun performNativeNetworkDiscovery(): JSONArray {
        val byIp = ConcurrentHashMap<String, JSONObject>()

        fun addServiceToDevice(
            ip: String,
            hostname: String,
            displayName: String,
            protocol: String,
            serviceType: String,
            port: Int,
            label: String,
            method: String,
            scheme: String? = null,
            path: String = "/Medien"
        ) {
            val dev = byIp.computeIfAbsent(ip) {
                JSONObject()
                    .put("id", "nas-$ip")
                    .put("name", displayName.ifBlank { hostname.ifBlank { "NAS ($ip)" } })
                    .put("hostname", hostname.ifBlank { ip })
                    .put("ip", ip)
                    .put("port", port.toString())
                    .put("isEntenCenterServer", protocol == "entencenter")
                    .put("services", JSONArray())
                    .put("discoveryMethods", JSONArray().put(method))
                    .put("sameSubnet", true)
            }

            if (hostname.isNotBlank() && hostname != ip) {
                dev.put("hostname", hostname)
            }
            if (displayName.isNotBlank() && !displayName.startsWith("Heim-NAS (")) {
                dev.put("name", displayName)
            }
            if (protocol == "entencenter") {
                dev.put("isEntenCenterServer", true)
                dev.put("baseUrl", "${scheme ?: "http"}://$ip:$port")
                dev.put("port", port.toString())
            }

            val methods = dev.getJSONArray("discoveryMethods")
            var hasMethod = false
            for (i in 0 until methods.length()) {
                if (methods.optString(i) == method) {
                    hasMethod = true
                    break
                }
            }
            if (!hasMethod) methods.put(method)

            val services = dev.getJSONArray("services")
            for (i in 0 until services.length()) {
                val existing = services.optJSONObject(i) ?: continue
                if (existing.optString("protocol") == protocol && existing.optString("port") == port.toString()) {
                    return
                }
            }

            val svcObj = JSONObject()
                .put("protocol", protocol)
                .put("serviceType", serviceType)
                .put("port", port.toString())
                .put("label", label)
                .put("path", path)
            if (scheme != null) {
                svcObj.put("scheme", scheme)
            }
            services.put(svcObj)
        }

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val multicastLock = wifiManager?.createMulticastLock("entencenter_mdns_scan")?.apply {
            setReferenceCounted(false)
        }
        try {
            multicastLock?.acquire()
        } catch (_: Exception) {
        }

        val nsdManager = getSystemService(Context.NSD_SERVICE) as? NsdManager
        val activeListeners = mutableListOf<NsdManager.DiscoveryListener>()
        val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
        val resolveWorkerStop = AtomicBoolean(false)

        val resolveThread = Thread {
            while (!resolveWorkerStop.get() || resolveQueue.isNotEmpty()) {
                val pending = resolveQueue.poll()
                if (pending == null) {
                    try {
                        Thread.sleep(40)
                    } catch (_: InterruptedException) {
                        break
                    }
                    continue
                }
                val mgr = nsdManager ?: continue
                val latch = CountDownLatch(1)
                try {
                    mgr.resolveService(
                        pending,
                        object : NsdManager.ResolveListener {
                            override fun onResolveFailed(serviceInfo: NsdServiceInfo?, errorCode: Int) {
                                latch.countDown()
                            }

                            override fun onServiceResolved(resolved: NsdServiceInfo?) {
                                try {
                                    if (resolved != null) {
                                        val hostAddr = resolved.host?.hostAddress
                                        val hostName = resolved.host?.hostName ?: ""
                                        val port = resolved.port
                                        if (!hostAddr.isNullOrBlank() && port > 0) {
                                            val (protocol, label, path) = mapServiceProtocol(
                                                resolved.serviceType ?: "",
                                                port
                                            )
                                            val isEnten =
                                                protocol == "entencenter" ||
                                                    (port == 3000 && checkEntenCenterBootstrap("http://$hostAddr:$port"))
                                            val effectiveProto = if (isEnten) "entencenter" else protocol
                                            val effectiveLabel = if (isEnten) "EntenCenter Server" else label
                                            val scheme =
                                                if (effectiveProto == "entencenter" || port == 80 || port == 5000 || port == 5005) "http"
                                                else if (port == 443 || port == 5001 || port == 5006) "https"
                                                else null
                                            addServiceToDevice(
                                                ip = hostAddr,
                                                hostname = hostName,
                                                displayName = resolved.serviceName ?: hostName,
                                                protocol = effectiveProto,
                                                serviceType = resolved.serviceType ?: "_http._tcp.",
                                                port = port,
                                                label = effectiveLabel,
                                                method = "android_nsd",
                                                scheme = scheme,
                                                path = path
                                            )
                                        }
                                    }
                                } finally {
                                    latch.countDown()
                                }
                            }
                        }
                    )
                    latch.await(650, TimeUnit.MILLISECONDS)
                } catch (_: Exception) {
                    latch.countDown()
                }
            }
        }.apply { start() }

        // 1. NsdManager (Android Bonjour / mDNS)
        if (nsdManager != null) {
            val nsdTypes = listOf(
                "_entencenter._tcp.",
                "_smb._tcp.",
                "_nfs._tcp.",
                "_webdav._tcp.",
                "_webdavs._tcp.",
                "_sftp-ssh._tcp.",
                "_ftp._tcp.",
                "_http._tcp.",
                "_https._tcp."
            )
            for (svcType in nsdTypes) {
                val listener = object : NsdManager.DiscoveryListener {
                    override fun onDiscoveryStarted(regType: String?) {}
                    override fun onServiceFound(serviceInfo: NsdServiceInfo?) {
                        if (serviceInfo != null) {
                            resolveQueue.offer(serviceInfo)
                        }
                    }
                    override fun onServiceLost(serviceInfo: NsdServiceInfo?) {}
                    override fun onDiscoveryStopped(serviceType: String?) {}
                    override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                        try { nsdManager.stopServiceDiscovery(this) } catch (_: Exception) {}
                    }
                    override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {
                        try { nsdManager.stopServiceDiscovery(this) } catch (_: Exception) {}
                    }
                }
                try {
                    nsdManager.discoverServices(svcType, NsdManager.PROTOCOL_DNS_SD, listener)
                    activeListeners.add(listener)
                } catch (_: Exception) {
                }
            }
        }

        val workerPool = Executors.newFixedThreadPool(32)

        // 2. Multi-ST SSDP (MediaServer + InternetGatewayDevice + ssdp:all)
        val ssdpFuture = workerPool.submit {
            var socket: DatagramSocket? = null
            try {
                socket = DatagramSocket().apply { soTimeout = 1300 }
                val dest = InetAddress.getByName("239.255.255.250")
                val searchTargets = listOf(
                    "urn:schemas-upnp-org:device:MediaServer:1",
                    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                    "ssdp:all"
                )
                for (st in searchTargets) {
                    val payload = (
                        "M-SEARCH * HTTP/1.1\r\n" +
                            "HOST: 239.255.255.250:1900\r\n" +
                            "MAN: \"ssdp:discover\"\r\n" +
                            "MX: 1\r\n" +
                            "ST: $st\r\n\r\n"
                        ).toByteArray(Charsets.UTF_8)
                    socket.send(DatagramPacket(payload, payload.size, dest, 1900))
                }
                val buf = ByteArray(2048)
                val deadline = System.currentTimeMillis() + 1400
                while (System.currentTimeMillis() < deadline) {
                    val pkt = DatagramPacket(buf, buf.size)
                    socket.receive(pkt)
                    val resp = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                    val location = Regex("^LOCATION:\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
                        .find(resp)?.groupValues?.getOrNull(1)?.trim() ?: ""
                    val remoteIp = pkt.address?.hostAddress ?: continue
                    val parsed = try {
                        if (location.isNotEmpty()) URL(location) else null
                    } catch (_: Exception) {
                        null
                    }
                    val port = if ((parsed?.port ?: -1) > 0) parsed!!.port else 49000
                    val isFritz = resp.lowercase().contains("fritz") || resp.lowercase().contains("avm")
                    addServiceToDevice(
                        ip = remoteIp,
                        hostname = remoteIp,
                        displayName = if (isFritz) "FRITZ!Box / FRITZ!NAS ($remoteIp)" else "DLNA/UPnP NAS ($remoteIp)",
                        protocol = if (isFritz) "fritz_upnp" else "api_token",
                        serviceType = "ssdp:mediaserver",
                        port = port,
                        label = if (isFritz) "FRITZ!Box UPnP/DLNA" else "UPnP MediaServer",
                        method = "ssdp",
                        scheme = "http",
                        path = if (isFritz) "/MediaServer" else "/"
                    )
                }
            } catch (_: Exception) {
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }

        // 3. Ziel-IPs aus DHCP (Gateway, DNS1/2), ARP-Tabelle & ALLEN aktiven LAN-Subnets sammeln
        val dhcpInfo = wifiManager?.dhcpInfo
        val wifiGatewayIp = intToIpv4String(dhcpInfo?.gateway ?: 0)
        val dns1Ip = intToIpv4String(dhcpInfo?.dns1 ?: 0)
        val dns2Ip = intToIpv4String(dhcpInfo?.dns2 ?: 0)

        val fritzHostCandidates = linkedSetOf("fritz.box", "fritz.nas", "192.168.178.1", "192.168.179.1")
        if (!wifiGatewayIp.isNullOrBlank()) fritzHostCandidates.add(wifiGatewayIp)
        if (!dns1Ip.isNullOrBlank() && FritzBoxSessionHelper.isLocalLanHost(dns1Ip)) fritzHostCandidates.add(dns1Ip)
        if (!dns2Ip.isNullOrBlank() && FritzBoxSessionHelper.isLocalLanHost(dns2Ip)) fritzHostCandidates.add(dns2Ip)

        val lanIfaces = getLocalLanIpv4Interfaces()
        val localIps = lanIfaces.map { it.first }.toSet()
        val allCandidateIps = LinkedHashSet<String>()
        allCandidateIps.addAll(readArpLanNeighbors())
        if (!wifiGatewayIp.isNullOrBlank()) allCandidateIps.add(wifiGatewayIp)
        if (!dns1Ip.isNullOrBlank() && FritzBoxSessionHelper.isLocalLanHost(dns1Ip)) allCandidateIps.add(dns1Ip)
        if (!dns2Ip.isNullOrBlank() && FritzBoxSessionHelper.isLocalLanHost(dns2Ip)) allCandidateIps.add(dns2Ip)

        for ((_, addrBytes) in lanIfaces) {
            val prefix = "${addrBytes[0].toInt() and 0xFF}.${addrBytes[1].toInt() and 0xFF}.${addrBytes[2].toInt() and 0xFF}"
            fritzHostCandidates.add("$prefix.1")
            for (octet in 1..254) {
                val ip = "$prefix.$octet"
                if (!localIps.contains(ip)) {
                    allCandidateIps.add(ip)
                }
            }
        }
        for (h in fritzHostCandidates) {
            try {
                val resolved = InetAddress.getByName(h).hostAddress
                if (!resolved.isNullOrBlank() && !localIps.contains(resolved)) {
                    allCandidateIps.add(resolved)
                }
            } catch (_: Exception) {
            }
        }

        // Schneller NIO-Port-Sweep über alle IPs (<750 ms!)
        val sweepPorts = listOf(445, 80, 443, 49000, 3000, 3001, 5000, 5001, 5005, 5006, 8080, 22, 21)
        val openByIp = nioSweepOpenPorts(allCandidateIps, sweepPorts, totalBudgetMs = 1100L)

        // Nur IPs mit mindestens einem offenen Port (plus bekannte FRITZ-Kandidaten) tiefenprüfen
        val activeIps = LinkedHashSet<String>(openByIp.keys)
        for (h in fritzHostCandidates) {
            try {
                val resolved = InetAddress.getByName(h).hostAddress
                if (!resolved.isNullOrBlank()) activeIps.add(resolved)
            } catch (_: Exception) {
            }
        }

        val probeTasks = activeIps.map { targetIp ->
            workerPool.submit {
                val ports = openByIp[targetIp] ?: HashSet()
                val p3000 = ports.contains(3000) || isPortOpen(targetIp, 3000, 180)
                val p3001 = ports.contains(3001)
                val p445 = ports.contains(445) || isPortOpen(targetIp, 445, 220)
                val p80 = ports.contains(80) || isPortOpen(targetIp, 80, 200)
                val p443 = ports.contains(443) || isPortOpen(targetIp, 443, 200)
                val p49000 = ports.contains(49000) || isPortOpen(targetIp, 49000, 220)

                for (ecPort in listOf(3000, 3001, 8080)) {
                    if ((ecPort == 3000 && p3000) || (ecPort == 3001 && p3001) || (ecPort == 8080 && ports.contains(8080))) {
                        if (checkEntenCenterBootstrap("http://$targetIp:$ecPort")) {
                            addServiceToDevice(
                                ip = targetIp,
                                hostname = targetIp,
                                displayName = "EntenCenter Server ($targetIp:$ecPort)",
                                protocol = "entencenter",
                                serviceType = "_entencenter._tcp.",
                                port = ecPort,
                                label = if (ecPort == 3000) "EntenCenter Server" else "EntenCenter (Ausweichport :$ecPort)",
                                method = "port_probe",
                                scheme = "http",
                                path = "/"
                            )
                        }
                    }
                }

                var isFritzDevice = false
                if (p80 || p443 || p49000 || p445) {
                    val fritzLogin = FritzBoxSessionHelper.probeLoginSid(
                        host = targetIp,
                        allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                        configureTrust = { applySharedNasTrustIfHttps(it) }
                    )
                    if (fritzLogin != null && fritzLogin.optBoolean("detected", false)) {
                        isFritzDevice = true
                        val fName = fritzLogin.optString("friendlyName").ifBlank { null }
                            ?: "FRITZ!Box / FRITZ!NAS ($targetIp)"
                        if (fritzLogin.optBoolean("httpAvailable", false)) {
                            addServiceToDevice(
                                ip = targetIp,
                                hostname = targetIp,
                                displayName = fName,
                                protocol = "fritz_upnp",
                                serviceType = "fritz:login_sid:http",
                                port = 80,
                                label = "FRITZ!Box / FRITZ!NAS (HTTP Login)",
                                method = "port_probe",
                                scheme = "http",
                                path = "/login_sid.lua"
                            )
                        }
                        if (fritzLogin.optBoolean("httpsAvailable", false)) {
                            addServiceToDevice(
                                ip = targetIp,
                                hostname = targetIp,
                                displayName = fName,
                                protocol = "fritz_upnp",
                                serviceType = "fritz:login_sid:https",
                                port = 443,
                                label = "FRITZ!Box / FRITZ!NAS (HTTPS)",
                                method = "port_probe",
                                scheme = "https",
                                path = "/login_sid.lua"
                            )
                        }
                        if (p49000 || fritzLogin.optBoolean("tr064Available", false)) {
                            addServiceToDevice(
                                ip = targetIp,
                                hostname = targetIp,
                                displayName = fName,
                                protocol = "fritz_upnp",
                                serviceType = "tr064:http",
                                port = 49000,
                                label = "FRITZ!Box TR-064 / UPnP",
                                method = "port_probe",
                                scheme = "http",
                                path = "/MediaServer"
                            )
                        }
                    }
                }

                if (p445) {
                    val smbCheck = NasProtocolProbeHelper.probeSmb23(
                        hostname = targetIp,
                        resolvedIp = targetIp,
                        port = 445,
                        isLan = true,
                        scope = "lan",
                        timeoutMs = 800
                    )
                    if (smbCheck.optBoolean("protocolVerified", false)) {
                        val dialectStr = smbCheck.optString("smbDialect", "SMB 2/3")
                        val fritzByNeg = targetIp == wifiGatewayIp || isFritzDevice
                        addServiceToDevice(
                            ip = targetIp,
                            hostname = targetIp,
                            displayName = if (fritzByNeg) "FRITZ!NAS ($targetIp)" else "Heim-NAS ($targetIp)",
                            protocol = "smb",
                            serviceType = "_smb._tcp.",
                            port = 445,
                            label = if (fritzByNeg) "FRITZ!NAS $dialectStr" else "$dialectStr (Dateizugriff)",
                            method = "port_probe",
                            path = if (fritzByNeg) "/FRITZ.NAS" else "/Medien"
                        )
                    }
                }

                if (ports.contains(5000)) {
                    addServiceToDevice(targetIp, targetIp, "Synology NAS ($targetIp)", "api_token", "_http._tcp.", 5000, "Synology DSM (HTTP)", "port_probe", "http", "/api/v3")
                }
                if (ports.contains(5001)) {
                    addServiceToDevice(targetIp, targetIp, "Synology NAS ($targetIp)", "api_token", "_https._tcp.", 5001, "Synology DSM (HTTPS)", "port_probe", "https", "/api/v3")
                }
                if (ports.contains(5005)) {
                    addServiceToDevice(targetIp, targetIp, "WebDAV NAS ($targetIp)", "webdav", "_webdav._tcp.", 5005, "WebDAV (HTTP)", "port_probe", "http", "/Medien")
                }
                if (ports.contains(5006)) {
                    addServiceToDevice(targetIp, targetIp, "WebDAV NAS ($targetIp)", "webdav", "_webdavs._tcp.", 5006, "WebDAV (HTTPS)", "port_probe", "https", "/Medien")
                }
                if (ports.contains(8080)) {
                    try {
                        val qnapConn = (URL("http://$targetIp:8080/cgi-bin/authLogin.cgi").openConnection() as HttpURLConnection).apply {
                            connectTimeout = 500; readTimeout = 500
                        }
                        val body = qnapConn.inputStream?.bufferedReader()?.use { it.readText() } ?: ""
                        qnapConn.disconnect()
                        if (body.contains("<QDocRoot>", true) || body.contains("qnap", true)) {
                            addServiceToDevice(targetIp, targetIp, "QNAP NAS ($targetIp)", "api_token", "_http._tcp.", 8080, "QNAP QTS (HTTP)", "port_probe", "http", "/cgi-bin/authLogin.cgi")
                        }
                    } catch (_: Exception) {}
                }
                if (p80 && !isFritzDevice) {
                    try {
                        val wdConn = (URL("http://$targetIp/api/2.1/rest/device_info").openConnection() as HttpURLConnection).apply {
                            connectTimeout = 450; readTimeout = 450
                        }
                        val code = wdConn.responseCode
                        val body = (if (code in 200..399) wdConn.inputStream else wdConn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                        wdConn.disconnect()
                        if (body.contains("mycloud", true) || body.contains("western digital", true) || body.contains("wdc", true)) {
                            addServiceToDevice(targetIp, targetIp, "WD My Cloud ($targetIp)", "api_token", "_http._tcp.", 80, "Western Digital My Cloud", "port_probe", "http", "/api/2.1/rest/device_info")
                        }
                    } catch (_: Exception) {}
                }
            }
        }

        val scanDeadline = System.currentTimeMillis() + 4500L
        resolveWorkerStop.set(true)
        for (task in probeTasks) {
            val remaining = (scanDeadline - System.currentTimeMillis()).coerceAtLeast(25L)
            try {
                task.get(remaining, TimeUnit.MILLISECONDS)
            } catch (_: Exception) {
            }
        }
        for (listener in activeListeners) {
            try { nsdManager?.stopServiceDiscovery(listener) } catch (_: Exception) {}
        }
        try { ssdpFuture.get(400, TimeUnit.MILLISECONDS) } catch (_: Exception) {}
        workerPool.shutdownNow()
        try { resolveThread.join(400) } catch (_: InterruptedException) {}
        try {
            if (multicastLock?.isHeld == true) multicastLock.release()
        } catch (_: Exception) {}

        val result = JSONArray()
        for (dev in byIp.values) {
            val services = dev.optJSONArray("services") ?: JSONArray()
            if (services.length() > 0) {
                result.put(dev)
            }
        }
        return result
    }

    @Suppress("DEPRECATION")
    private fun performQuickFritzTr064Probe(): JSONArray {
        val found = JSONArray()
        val seen = HashSet<String>()
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val dhcp = wifiManager?.dhcpInfo
        val wifiGatewayIp = intToIpv4String(dhcp?.gateway ?: 0)
        val dns1Ip = intToIpv4String(dhcp?.dns1 ?: 0)

        val probeHosts = linkedSetOf("fritz.box", "fritz.nas", "192.168.178.1", "192.168.179.1")
        if (!wifiGatewayIp.isNullOrBlank()) probeHosts.add(wifiGatewayIp)
        if (!dns1Ip.isNullOrBlank() && FritzBoxSessionHelper.isLocalLanHost(dns1Ip)) probeHosts.add(dns1Ip)
        probeHosts.addAll(readArpLanNeighbors())

        val lanIfaces = getLocalLanIpv4Interfaces()
        val subnetIps = LinkedHashSet<String>(probeHosts)
        for ((localIp, addrBytes) in lanIfaces) {
            val prefix = "${addrBytes[0].toInt() and 0xFF}.${addrBytes[1].toInt() and 0xFF}.${addrBytes[2].toInt() and 0xFF}"
            for (octet in 1..254) {
                val ip = "$prefix.$octet"
                if (ip != localIp) subnetIps.add(ip)
            }
        }

        val sweepMap = nioSweepOpenPorts(subnetIps, listOf(80, 443, 445, 49000, 49443), totalBudgetMs = 900L)
        val candidateHosts = LinkedHashSet<String>()
        candidateHosts.addAll(sweepMap.keys)
        candidateHosts.addAll(listOf("fritz.box", "fritz.nas"))
        if (!wifiGatewayIp.isNullOrBlank()) candidateHosts.add(wifiGatewayIp)

        val checkPool = Executors.newFixedThreadPool(16)
        val hitQueue = ConcurrentLinkedQueue<JSONObject>()
        val checkFutures = candidateHosts.map { host ->
            checkPool.submit {
                val resolvedIp = try {
                    InetAddress.getByName(host).hostAddress ?: host
                } catch (_: Exception) {
                    host
                }
                val openPorts = sweepMap[resolvedIp] ?: emptySet()
                val sidInfo = FritzBoxSessionHelper.probeLoginSid(
                    host = resolvedIp,
                    allowLocalSelfSignedTls = isAllowLocalSelfSignedTlsEnabled(),
                    configureTrust = { applySharedNasTrustIfHttps(it) }
                )
                val smbOpen = openPorts.contains(445) || isPortOpen(resolvedIp, 445, 220)
                val smbVerified = if (smbOpen && (sidInfo == null || !sidInfo.optBoolean("detected", false))) {
                    val smbRes = NasProtocolProbeHelper.probeSmb23(
                        hostname = resolvedIp,
                        resolvedIp = resolvedIp,
                        port = 445,
                        isLan = true,
                        scope = "lan",
                        timeoutMs = 700
                    )
                    smbRes.optBoolean("protocolVerified", false)
                } else {
                    false
                }

                if (sidInfo != null && sidInfo.optBoolean("detected", false)) {
                    val httpOk = sidInfo.optBoolean("httpAvailable", false)
                    val httpsOk = sidInfo.optBoolean("httpsAvailable", false)
                    val trOk = sidInfo.optBoolean("tr064Available", false)
                    val port = when {
                        httpOk -> "80"
                        smbOpen -> "445"
                        trOk -> "49000"
                        httpsOk -> "443"
                        else -> "49000"
                    }
                    val locationUrl = when {
                        httpOk -> "http://$resolvedIp/login_sid.lua"
                        httpsOk -> "https://$resolvedIp/login_sid.lua"
                        else -> "http://$resolvedIp:49000/tr64desc.xml"
                    }
                    hitQueue.offer(
                        JSONObject()
                            .put("id", "$resolvedIp:$port")
                            .put("friendlyName", sidInfo.optString("friendlyName").ifBlank { "FRITZ!Box / FRITZ!NAS ($resolvedIp)" })
                            .put("host", host)
                            .put("ip", resolvedIp)
                            .put("port", port)
                            .put("smbOpen", smbOpen)
                            .put("locationUrl", locationUrl)
                            .put("manufacturer", "AVM Berlin")
                            .put("modelName", sidInfo.optString("modelName", ""))
                            .put("deviceType", "urn:schemas-upnp-org:device:MediaServer:1")
                            .put("source", "http_upnp")
                            .put("sameSubnet", true)
                            .put("subnetCidr", JSONObject.NULL)
                            .put("requiresAuth", sidInfo.optBoolean("requiresAuth", true))
                            .put("lastUser", sidInfo.opt("lastUser") ?: JSONObject.NULL)
                            .put("loginSidUrl", sidInfo.opt("loginSidUrl") ?: JSONObject.NULL)
                            .put("httpAvailable", httpOk)
                            .put("httpsAvailable", httpsOk)
                            .put("httpsError", sidInfo.opt("httpsError") ?: JSONObject.NULL)
                            .put("discoveredAt", isoNowUtc())
                    )
                } else if (smbVerified) {
                    hitQueue.offer(
                        JSONObject()
                            .put("id", "$resolvedIp:445")
                            .put("friendlyName", "FRITZ!NAS / SMB-Speicher ($resolvedIp)")
                            .put("host", host)
                            .put("ip", resolvedIp)
                            .put("port", "445")
                            .put("smbOpen", true)
                            .put("locationUrl", "smb://$resolvedIp/FRITZ.NAS")
                            .put("manufacturer", "NAS / SMB 2/3")
                            .put("modelName", "SMB/CIFS")
                            .put("deviceType", "urn:schemas-upnp-org:device:MediaServer:1")
                            .put("source", "smb_probe")
                            .put("sameSubnet", true)
                            .put("subnetCidr", JSONObject.NULL)
                            .put("requiresAuth", true)
                            .put("httpAvailable", false)
                            .put("httpsAvailable", false)
                            .put("discoveredAt", isoNowUtc())
                    )
                }
            }
        }
        val cDeadline = System.currentTimeMillis() + 3400L
        for (f in checkFutures) {
            val rem = (cDeadline - System.currentTimeMillis()).coerceAtLeast(15L)
            try {
                f.get(rem, TimeUnit.MILLISECONDS)
            } catch (_: Exception) {
            }
        }
        checkPool.shutdownNow()

        for (item in hitQueue) {
            val dedupeKey = item.optString("ip").ifBlank { item.optString("id") }
            if (seen.add(dedupeKey)) {
                found.put(item)
            }
        }
        return found
    }

    private fun hasBundledWebAssets(): Boolean {
        return try {
            assets.list("www")?.contains("index.html") == true
        } catch (_: Exception) {
            false
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#0B0E14")
        window.navigationBarColor = Color.parseColor("#0B0E14")
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(this)
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(LOCAL_APP_HOST)
            .addPathHandler(
                "/",
                WebViewAssetLoader.PathHandler { path ->
                    val normalized = path.trimStart('/')
                    if (normalized.startsWith("api/") || normalized.startsWith("uploads/")) {
                        return@PathHandler null
                    }
                    val target = if (normalized.isEmpty()) "index.html" else normalized
                    assetsHandler.handle("www/$target") ?: assetsHandler.handle("www/index.html")
                }
            )
            .build()

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                setGeolocationEnabled(true)
            }

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            addJavascriptInterface(AndroidBridge(), "EntenCenterAndroid")

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    if (uri.host == LOCAL_APP_HOST) {
                        return assetLoader.shouldInterceptRequest(uri)
                    }
                    return null
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean = false

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageLoadedForInsets = true
                    dispatchDisplayInsetsToWebView()
                }

                override fun onReceivedSslError(
                    view: WebView?,
                    handler: SslErrorHandler?,
                    error: SslError?
                ) {
                    val pem = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .getString(KEY_SHARED_NAS_CERT_PEM, "") ?: ""
                    val uploadedCerts = parseUploadedNasCertificates(pem)
                    val sslCert = error?.certificate
                    if (uploadedCerts.isNotEmpty() && sslCert != null) {
                        try {
                            val certBytes = SslCertificate.saveState(sslCert)?.getByteArray("x509-certificate")
                            if (certBytes != null) {
                                val cf = CertificateFactory.getInstance("X.509")
                                val peerX509 = cf.generateCertificate(ByteArrayInputStream(certBytes)) as? X509Certificate
                                if (peerX509 != null && isCertificateTrustedBySharedNasPem(peerX509, uploadedCerts)) {
                                    handler?.proceed()
                                    return
                                }
                            }
                        } catch (_: Exception) {
                            // Zertifikatsprüfung fehlgeschlagen -> sicherheitshalber abbrechen
                        }
                    }

                    val errorHost = try {
                        error?.url?.let { URL(it).host } ?: ""
                    } catch (_: Exception) {
                        ""
                    }
                    if (isAllowLocalSelfSignedTlsEnabled() && FritzBoxSessionHelper.isLocalLanHost(errorHost)) {
                        handler?.proceed()
                        return
                    }
                    handler?.cancel()
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    if (customView != null) {
                        callback?.onCustomViewHidden()
                        return
                    }
                    customView = view
                    customViewCallback = callback
                    webView.visibility = View.GONE
                    rootContainer.addView(
                        view,
                        FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    )
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        hide(WindowInsetsCompat.Type.systemBars())
                    }
                }

                override fun onHideCustomView() {
                    hideCustomView()
                }

                override fun onGeolocationPermissionsShowPrompt(
                    origin: String?,
                    callback: GeolocationPermissions.Callback?
                ) {
                    if (origin == null || callback == null) return
                    val hasCoarse = ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                    val hasFine = ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                    if (hasCoarse || hasFine) {
                        callback.invoke(origin, true, false)
                    } else {
                        pendingGeoCallback?.invoke(pendingGeoOrigin, false, false)
                        pendingGeoOrigin = origin
                        pendingGeoCallback = callback
                        locationPermissionLauncher.launch(
                            arrayOf(
                                Manifest.permission.ACCESS_COARSE_LOCATION,
                                Manifest.permission.ACCESS_FINE_LOCATION
                            )
                        )
                    }
                }
            }

            setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
                if (url.isNullOrBlank()) return@setDownloadListener
                try {
                    if (url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)) {
                        val fileName = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimetype)
                        val dmReq = DownloadManager.Request(Uri.parse(url)).apply {
                            if (!userAgent.isNullOrBlank()) addRequestHeader("User-Agent", userAgent)
                            if (!mimetype.isNullOrBlank()) setMimeType(mimetype)
                            setTitle(fileName)
                            setDescription("EntenCenter Download")
                            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                            setAllowedOverMetered(true)
                            setAllowedOverRoaming(true)
                        }
                        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
                        if (dm != null) {
                            dm.enqueue(dmReq)
                            return@setDownloadListener
                        }
                    }
                } catch (_: Exception) {
                }
                try {
                    val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(viewIntent)
                } catch (_: Exception) {
                }
            }
        }

        rootContainer.addView(webView)
        setContentView(rootContainer)

        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { _, windowInsets ->
            val systemAndCutout = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    or WindowInsetsCompat.Type.displayCutout()
                    or WindowInsetsCompat.Type.captionBar()
            )
            val navBarsIgnoring = windowInsets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.navigationBars())
            val statusBarsIgnoring = windowInsets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.statusBars())
            val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            val isInFullscreen = customView != null
            val statusBarVisible = !isInFullscreen && windowInsets.isVisible(WindowInsetsCompat.Type.statusBars())
            val navBarVisible = !isInFullscreen && windowInsets.isVisible(WindowInsetsCompat.Type.navigationBars())

            val minStatusPx = if (statusBarVisible) (24f * density).toInt() else 0
            val minNavPx = if (navBarVisible) {
                if (isTabletDevice()) (48f * density).toInt() else (40f * density).toInt()
            } else {
                0
            }

            val topPx = maxOf(
                systemAndCutout.top,
                if (statusBarVisible) statusBarsIgnoring.top else 0,
                minStatusPx
            )
            val bottomPx = maxOf(
                systemAndCutout.bottom,
                if (navBarVisible) navBarsIgnoring.bottom else 0,
                minNavPx,
                imeInsets.bottom
            )
            val leftPx = systemAndCutout.left
            val rightPx = systemAndCutout.right

            lastInsetTopDp = Math.round((topPx / density) * 10f) / 10f
            lastInsetBottomDp = Math.round((bottomPx / density) * 10f) / 10f
            lastInsetLeftDp = Math.round((leftPx / density) * 10f) / 10f
            lastInsetRightDp = Math.round((rightPx / density) * 10f) / 10f

            val lp = webView.layoutParams as? FrameLayout.LayoutParams
            if (lp != null && (
                lp.topMargin != topPx ||
                lp.bottomMargin != bottomPx ||
                lp.leftMargin != leftPx ||
                lp.rightMargin != rightPx
            )) {
                lp.setMargins(leftPx, topPx, rightPx, bottomPx)
                webView.layoutParams = lp
            }

            dispatchDisplayInsetsToWebView()
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(rootContainer)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) {
                    hideCustomView()
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        ensureLocalMediaProxyStarted()
        val savedUrl = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString(KEY_SERVER_URL, null)
        val startUrl = when {
            hasBundledWebAssets() -> LOCAL_APP_ENTRY
            !savedUrl.isNullOrBlank() -> savedUrl
            else -> LOCAL_APP_ENTRY
        }
        webView.loadUrl(startUrl)
    }

    private fun hideCustomView() {
        val activeCustomView = customView ?: return
        rootContainer.removeView(activeCustomView)
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        webView.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(rootContainer)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        chromecastHelper.destroy()
        stopLocalMediaProxy()
        scanExecutor.shutdownNow()
        deepDiagExecutor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    private fun performAlternativePortScan(rawTarget: String, preferredAltPort: Int): String {
        val startedMs = System.currentTimeMillis()
        val trimmed = rawTarget.trim()
        val withScheme = if (trimmed.isEmpty()) {
            "http://192.168.178.1:3000"
        } else if (trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true)) {
            trimmed
        } else {
            "http://$trimmed"
        }

        val parsed = try {
            URL(withScheme)
        } catch (_: Exception) {
            null
        }
        val hostname = parsed?.host?.trim()?.takeIf { it.isNotBlank() } ?: trimmed.split("/")[0].split(":")[0]
        val primaryPort = if (parsed != null && parsed.port > 0) parsed.port else 3000

        val resolvedAddr = try {
            if (hostname.isNotBlank()) InetAddress.getByName(hostname) else null
        } catch (_: Exception) {
            null
        }

        if (resolvedAddr == null || hostname.isBlank()) {
            return JSONObject()
                .put("targetInput", trimmed)
                .put("hostname", hostname)
                .put("resolvedIp", JSONObject.NULL)
                .put("primaryPort", primaryPort)
                .put("preferredAlternativePort", preferredAltPort)
                .put("recommendedPort", JSONObject.NULL)
                .put("recommendedBaseUrl", JSONObject.NULL)
                .put("openEntenCenterPorts", JSONArray())
                .put("openAlternativePorts", JSONArray())
                .put("openStoragePorts", JSONArray())
                .put("ports", JSONArray())
                .put("summary", "Hostname \"$hostname\" konnte per DNS nicht aufgelöst werden.")
                .put("executedOn", "android_native")
                .put("measuredAt", isoNowUtc())
                .put("durationMs", (System.currentTimeMillis() - startedMs).coerceAtLeast(1L))
                .toString()
        }

        val resolvedIp = resolvedAddr.hostAddress ?: hostname

        data class AltSpec(val port: Int, val scheme: String, val label: String, val category: String)
        val rawSpecs = listOf(
            AltSpec(3000, "http", "EntenCenter Standard", "entencenter"),
            AltSpec(preferredAltPort, if (preferredAltPort == 8443 || preferredAltPort == 443) "https" else "http", "Bevorzugter Ausweichport :$preferredAltPort", "alternative"),
            AltSpec(3001, "http", "EntenCenter Alt. 1", "alternative"),
            AltSpec(3002, "http", "EntenCenter Alt. 2", "alternative"),
            AltSpec(3003, "http", "EntenCenter Alt. 3", "alternative"),
            AltSpec(3005, "http", "EntenCenter Alt. 5", "alternative"),
            AltSpec(3010, "http", "EntenCenter Alt. 10", "alternative"),
            AltSpec(3080, "http", "HTTP-Alt 3080", "alternative"),
            AltSpec(8000, "http", "HTTP-Alt 8000", "alternative"),
            AltSpec(8008, "http", "HTTP-Alt 8008", "alternative"),
            AltSpec(8080, "http", "HTTP-Proxy / QNAP", "proxy"),
            AltSpec(8081, "http", "HTTP-Alt 8081", "alternative"),
            AltSpec(8443, "https", "HTTPS-Alt 8443", "proxy"),
            AltSpec(8888, "http", "HTTP-Alt 8888", "alternative"),
            AltSpec(9000, "http", "NAS Service / Alt. 9000", "alternative"),
            AltSpec(9090, "http", "Web-Alt 9090", "alternative"),
            AltSpec(80, "http", "HTTP / Router-UI", "router"),
            AltSpec(443, "https", "HTTPS / SSL-Proxy", "router"),
            AltSpec(445, "tcp", "SMB / CIFS Dateifreigabe", "storage"),
            AltSpec(5000, "http", "Synology DSM (HTTP)", "storage"),
            AltSpec(5001, "https", "Synology DSM (HTTPS)", "storage"),
            AltSpec(5005, "http", "WebDAV (HTTP)", "storage"),
            AltSpec(5006, "https", "WebDAV (HTTPS)", "storage"),
            AltSpec(22, "tcp", "SFTP / SSH", "storage"),
            AltSpec(21, "tcp", "FTP / FTPS", "storage"),
            AltSpec(2049, "tcp", "NFS", "storage"),
            AltSpec(49000, "http", "FRITZ!Box TR-064", "router")
        )
        val seen = HashSet<Int>()
        val uniqueSpecs = rawSpecs.filter { seen.add(it.port) }

        val entryMap = ConcurrentHashMap<Int, JSONObject>()
        val scanPool = Executors.newFixedThreadPool(12)
        try {
            val futures = uniqueSpecs.map { spec ->
                scanPool.submit {
                    val (tcpOpen, tcpMs, errCode) = probeTcpWithLatency(resolvedAddr, spec.port, 950)
                    var httpStatus: Int? = null
                    var serverHeader: String? = null
                    var isEntenCenter = false

                    if (tcpOpen && (spec.scheme == "http" || spec.scheme == "https")) {
                        try {
                            val conn = (URL("${spec.scheme}://$resolvedIp:${spec.port}/api/nas/auth/bootstrap").openConnection() as HttpURLConnection).apply {
                                applySharedNasTrustIfHttps(this)
                                requestMethod = "GET"
                                connectTimeout = 1200
                                readTimeout = 1200
                                instanceFollowRedirects = false
                                setRequestProperty("Accept", "application/json")
                                setRequestProperty("User-Agent", "EntenCenter-Android/1.0")
                                setRequestProperty("Connection", "close")
                            }
                            try {
                                httpStatus = conn.responseCode
                                serverHeader = conn.getHeaderField("Server")
                                if (httpStatus in 200..299) {
                                    val body = conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                                    isEntenCenter = isValidEntenCenterBootstrapJson(body)
                                }
                            } finally {
                                conn.disconnect()
                            }
                        } catch (_: Exception) {
                        }
                    }

                    val usableAsAlternative = isEntenCenter || (
                        tcpOpen &&
                        (spec.category == "alternative" || spec.category == "proxy") &&
                        spec.port != 3000 &&
                        (httpStatus == null || httpStatus in 200..499)
                    )

                    val obj = JSONObject()
                        .put("port", spec.port)
                        .put("scheme", spec.scheme)
                        .put("label", spec.label)
                        .put("category", spec.category)
                        .put("tcpOpen", tcpOpen)
                        .put("latencyMs", tcpMs ?: JSONObject.NULL)
                        .put("httpStatus", httpStatus ?: JSONObject.NULL)
                        .put("serverHeader", if (!serverHeader.isNullOrBlank()) serverHeader else JSONObject.NULL)
                        .put("isEntenCenter", isEntenCenter)
                        .put("usableAsAlternative", usableAsAlternative)
                        .put("recommended", false)
                        .put("errorCode", if (tcpOpen) JSONObject.NULL else (errCode ?: "UNREACHABLE"))
                    entryMap[spec.port] = obj
                }
            }
            for (f in futures) {
                try {
                    f.get(2500, TimeUnit.MILLISECONDS)
                } catch (_: Exception) {
                }
            }
        } finally {
            scanPool.shutdownNow()
        }

        val ordered = uniqueSpecs.mapNotNull { entryMap[it.port] }
        val openEntenCenterPorts = JSONArray()
        val openAlternativePorts = JSONArray()
        val openStoragePorts = JSONArray()

        for (e in ordered) {
            val p = e.optInt("port")
            val isOpen = e.optBoolean("tcpOpen", false)
            val isEc = e.optBoolean("isEntenCenter", false)
            val cat = e.optString("category")
            if (isEc) openEntenCenterPorts.put(p)
            if (isOpen && p != 3000 && (isEc || cat == "alternative" || cat == "proxy")) openAlternativePorts.put(p)
            if (isOpen && (cat == "storage" || p == 80 || p == 443 || p == 49000)) openStoragePorts.put(p)
        }

        val recEntry =
            ordered.firstOrNull { it.optBoolean("isEntenCenter", false) && it.optInt("port") != 3000 }
                ?: ordered.firstOrNull { it.optBoolean("isEntenCenter", false) }
                ?: ordered.firstOrNull { it.optBoolean("usableAsAlternative", false) }

        if (recEntry != null) {
            recEntry.put("recommended", true)
        }

        val portsArr = JSONArray()
        for (e in ordered) portsArr.put(e)

        val recommendedPort = recEntry?.optInt("port")
        val recommendedBaseUrl = if (recEntry != null && recommendedPort != null) {
            val sc = if (recEntry.optString("scheme") == "https") "https" else "http"
            "$sc://$hostname:$recommendedPort"
        } else null

        val ecListText = (0 until openEntenCenterPorts.length()).map { ":${openEntenCenterPorts.optInt(it)}" }.joinToString(", ")
        val altListText = (0 until openAlternativePorts.length()).map { ":${openAlternativePorts.optInt(it)}" }.joinToString(", ")
        val stoListText = (0 until openStoragePorts.length()).map { ":${openStoragePorts.optInt(it)}" }.joinToString(", ")

        val summary = when {
            openEntenCenterPorts.length() > 0 -> "EntenCenter-Backend gefunden auf Port $ecListText."
            openAlternativePorts.length() > 0 -> "Kein EntenCenter auf :3000 — offene Ausweichports gefunden: $altListText."
            openStoragePorts.length() > 0 -> "Kein App-Backend-Port offen; NAS-Speicherports erreichbar: $stoListText."
            else -> "Keine offenen EntenCenter- oder Ausweichports unter $hostname ($resolvedIp) gefunden."
        }

        return JSONObject()
            .put("targetInput", trimmed.ifBlank { hostname })
            .put("hostname", hostname)
            .put("resolvedIp", resolvedIp)
            .put("primaryPort", primaryPort)
            .put("preferredAlternativePort", preferredAltPort)
            .put("recommendedPort", recommendedPort ?: JSONObject.NULL)
            .put("recommendedBaseUrl", recommendedBaseUrl ?: JSONObject.NULL)
            .put("openEntenCenterPorts", openEntenCenterPorts)
            .put("openAlternativePorts", openAlternativePorts)
            .put("openStoragePorts", openStoragePorts)
            .put("ports", portsArr)
            .put("summary", summary)
            .put("executedOn", "android_native")
            .put("measuredAt", isoNowUtc())
            .put("durationMs", (System.currentTimeMillis() - startedMs).coerceAtLeast(1L))
            .toString()
    }
}
