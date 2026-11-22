package de.entencenter.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.SocketChannel
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class ChromecastBridgeHelper(private val appContext: Context) {

    companion object {
        private const val DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845"
        private const val SENDER_ID = "sender-0"
        private const val RECEIVER_ID = "receiver-0"
        private const val NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection"
        private const val NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat"
        private const val NS_RECEIVER = "urn:x-cast:com.google.cast.receiver"
        private const val NS_MEDIA = "urn:x-cast:com.google.cast.media"
    }

    private val discoveryInProgress = AtomicBoolean(false)
    private val discoveredDevices = ConcurrentHashMap<String, JSONObject>()
    @Volatile
    private var lastDiscoveryResultJson: String = JSONObject()
        .put("scanning", false)
        .put("devices", JSONArray())
        .toString()

    private val discoveryExecutor = Executors.newSingleThreadExecutor()
    private val heartbeatExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

    private val sessionLock = Any()
    private val requestCounter = AtomicInteger(1)
    @Volatile
    private var activeSocket: SSLSocket? = null
    @Volatile
    private var activeOutput: OutputStream? = null
    @Volatile
    private var activeReaderThread: Thread? = null
    @Volatile
    private var heartbeatFuture: ScheduledFuture<*>? = null
    @Volatile
    private var activeHost: String? = null
    @Volatile
    private var activePort: Int = 8009
    @Volatile
    private var activeDeviceName: String? = null
    @Volatile
    private var activeTransportId: String? = null
    @Volatile
    private var activeSessionId: String? = null
    @Volatile
    private var activeMediaSessionId: Long? = null
    @Volatile
    private var activePlayerState: String = "IDLE"
    @Volatile
    private var activeMediaLoaded: Boolean = false
    @Volatile
    private var lastSessionError: String? = null

    @Volatile
    private var pendingReceiverLatch: CountDownLatch? = null
    @Volatile
    private var pendingMediaLatch: CountDownLatch? = null

    fun startDiscovery(): Boolean {
        if (discoveryInProgress.compareAndSet(false, true)) {
            lastDiscoveryResultJson = JSONObject()
                .put("scanning", true)
                .put("devices", buildSortedDevicesArray())
                .toString()
            discoveryExecutor.execute {
                try {
                    performDiscovery()
                    lastDiscoveryResultJson = JSONObject()
                        .put("scanning", false)
                        .put("devices", buildSortedDevicesArray())
                        .toString()
                } catch (_: Exception) {
                    lastDiscoveryResultJson = JSONObject()
                        .put("scanning", false)
                        .put("devices", buildSortedDevicesArray())
                        .toString()
                } finally {
                    discoveryInProgress.set(false)
                }
            }
        }
        return true
    }

    fun getDiscoveryResultJson(): String = lastDiscoveryResultJson

    private fun buildSortedDevicesArray(): JSONArray {
        val list = discoveredDevices.values.toList().sortedBy {
            it.optString("name", it.optString("host", "")).lowercase()
        }
        return JSONArray().apply {
            list.forEach { put(it) }
        }
    }

    private fun upsertDiscoveredDevice(
        host: String,
        port: Int,
        name: String?,
        model: String?,
        id: String?,
        source: String
    ) {
        val cleanHost = host.trim()
        if (cleanHost.isEmpty()) return
        val safePort = if (port in 1..65535) port else 8009
        val existing = discoveredDevices[cleanHost]
        val resolvedName = name?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing?.optString("name")?.takeIf { it.isNotBlank() && !it.startsWith("Chromecast ($cleanHost") }
            ?: "Chromecast ($cleanHost)"
        val resolvedModel = model?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing?.optString("model")?.takeIf { it.isNotBlank() }
            ?: "Google Cast"
        val resolvedId = id?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing?.optString("id")?.takeIf { it.isNotBlank() }
            ?: "cast-$cleanHost-$safePort"

        discoveredDevices[cleanHost] = JSONObject()
            .put("id", resolvedId)
            .put("name", resolvedName)
            .put("model", resolvedModel)
            .put("host", cleanHost)
            .put("port", safePort)
            .put("source", source)
    }

    @Suppress("DEPRECATION")
    private fun performDiscovery() {
        val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val multicastLock = try {
            wifiManager?.createMulticastLock("entencenter_cast_discovery")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            null
        }

        val nsdManager = appContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
        val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
        val resolveStop = AtomicBoolean(false)
        val listeners = mutableListOf<NsdManager.DiscoveryListener>()

        val resolveWorker = Thread {
            while (!resolveStop.get() || resolveQueue.isNotEmpty()) {
                val info = resolveQueue.poll()
                if (info == null) {
                    try {
                        Thread.sleep(25)
                    } catch (_: InterruptedException) {
                        break
                    }
                    continue
                }
                val latch = CountDownLatch(1)
                try {
                    nsdManager?.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo?, errorCode: Int) {
                            latch.countDown()
                        }

                        override fun onServiceResolved(resolved: NsdServiceInfo?) {
                            try {
                                val host = resolved?.host?.hostAddress
                                val port = if ((resolved?.port ?: 0) > 0) resolved!!.port else 8009
                                if (!host.isNullOrBlank()) {
                                    val attrs = try { resolved?.attributes } catch (_: Exception) { null }
                                    val fn = attrs?.get("fn")?.let { String(it, Charsets.UTF_8).trim() }
                                    val md = attrs?.get("md")?.let { String(it, Charsets.UTF_8).trim() }
                                    val castId = attrs?.get("id")?.let { String(it, Charsets.UTF_8).trim() }
                                    val svcName = resolved?.serviceName?.trim()
                                    upsertDiscoveredDevice(
                                        host = host,
                                        port = port,
                                        name = fn?.takeIf { it.isNotEmpty() } ?: svcName,
                                        model = md,
                                        id = castId,
                                        source = "mdns"
                                    )
                                }
                            } finally {
                                latch.countDown()
                            }
                        }
                    })
                    latch.await(600, TimeUnit.MILLISECONDS)
                } catch (_: Exception) {
                    latch.countDown()
                }
            }
        }.apply { start() }

        if (nsdManager != null) {
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
                nsdManager.discoverServices("_googlecast._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
                listeners.add(listener)
            } catch (_: Exception) {
            }
        }

        val pool = Executors.newFixedThreadPool(16)
        val ssdpFuture = pool.submit {
            var socket: DatagramSocket? = null
            try {
                socket = DatagramSocket().apply { soTimeout = 1100 }
                val dest = InetAddress.getByName("239.255.255.250")
                val payload = (
                    "M-SEARCH * HTTP/1.1\r\n" +
                        "HOST: 239.255.255.250:1900\r\n" +
                        "MAN: \"ssdp:discover\"\r\n" +
                        "MX: 1\r\n" +
                        "ST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n"
                    ).toByteArray(Charsets.UTF_8)
                socket.send(DatagramPacket(payload, payload.size, dest, 1900))
                val buf = ByteArray(2048)
                val deadline = System.currentTimeMillis() + 1200L
                while (System.currentTimeMillis() < deadline) {
                    val pkt = DatagramPacket(buf, buf.size)
                    socket.receive(pkt)
                    val ip = pkt.address?.hostAddress ?: continue
                    val resp = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                    val loc = Regex("^LOCATION:\\s*(.+)$", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))
                        .find(resp)?.groupValues?.getOrNull(1)?.trim()
                    if (isTcpPortOpen(ip, 8009, 300)) {
                        val info = probeCastHttpMetadata(ip, loc)
                        upsertDiscoveredDevice(
                            host = ip,
                            port = 8009,
                            name = info.first,
                            model = info.second,
                            id = info.third,
                            source = "ssdp_dial"
                        )
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }

        // Schneller LAN-Subnet-Sweep auf Cast-Port 8009 (umgeht mDNS-Router-Filter)
        val sweepFuture = pool.submit {
            try {
                val lanIps = getLocalLanIpv4s()
                val candidates = LinkedHashSet<String>()
                for ((localIp, addrBytes) in lanIps) {
                    val prefix = "${addrBytes[0].toInt() and 0xFF}.${addrBytes[1].toInt() and 0xFF}.${addrBytes[2].toInt() and 0xFF}"
                    for (octet in 1..254) {
                        val ip = "$prefix.$octet"
                        if (ip != localIp) candidates.add(ip)
                    }
                }
                val openIps = nioSweepSinglePort(candidates, 8009, totalBudgetMs = 850L)
                val metaFutures = openIps.map { ip ->
                    pool.submit {
                        val info = probeCastHttpMetadata(ip, null)
                        if (info.first != null || info.second != null || isTcpPortOpen(ip, 8008, 250)) {
                            upsertDiscoveredDevice(
                                host = ip,
                                port = 8009,
                                name = info.first,
                                model = info.second,
                                id = info.third,
                                source = "lan_port_8009"
                            )
                        }
                    }
                }
                for (f in metaFutures) {
                    try { f.get(900, TimeUnit.MILLISECONDS) } catch (_: Exception) {}
                }
            } catch (_: Exception) {
            }
        }

        try { ssdpFuture.get(1500, TimeUnit.MILLISECONDS) } catch (_: Exception) {}
        try { sweepFuture.get(1700, TimeUnit.MILLISECONDS) } catch (_: Exception) {}
        resolveStop.set(true)
        try { resolveWorker.join(500) } catch (_: InterruptedException) {}
        for (l in listeners) {
            try { nsdManager?.stopServiceDiscovery(l) } catch (_: Exception) {}
        }
        pool.shutdownNow()
        try {
            if (multicastLock?.isHeld == true) multicastLock.release()
        } catch (_: Exception) {}
    }

    private fun probeCastHttpMetadata(ip: String, ssdpLocation: String?): Triple<String?, String?, String?> {
        try {
            val conn = (URL("http://$ip:8008/setup/eureka_info?options=detail").openConnection() as HttpURLConnection).apply {
                connectTimeout = 550
                readTimeout = 550
                requestMethod = "GET"
            }
            try {
                if (conn.responseCode in 200..299) {
                    val body = conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                    if (body.trim().startsWith("{")) {
                        val json = JSONObject(body)
                        val name = json.optString("name").trim().ifBlank { null }
                        val devInfo = json.optJSONObject("device_info")
                        val model = devInfo?.optString("model_name")?.trim()?.ifBlank { null }
                            ?: json.optString("model_name").trim().ifBlank { null }
                        val castId = json.optString("ssdp_udn").trim().ifBlank { null }
                        return Triple(name, model, castId)
                    }
                }
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
        }

        val xmlUrls = listOfNotNull(ssdpLocation, "http://$ip:8008/ssdp/device-desc.xml")
        for (xmlUrl in xmlUrls) {
            try {
                val conn = (URL(xmlUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 550
                    readTimeout = 550
                    requestMethod = "GET"
                }
                try {
                    if (conn.responseCode in 200..299) {
                        val xml = conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                        val fn = Regex("<friendlyName>([^<]+)</friendlyName>", RegexOption.IGNORE_CASE)
                            .find(xml)?.groupValues?.getOrNull(1)?.trim()
                        val mn = Regex("<modelName>([^<]+)</modelName>", RegexOption.IGNORE_CASE)
                            .find(xml)?.groupValues?.getOrNull(1)?.trim()
                        val udn = Regex("<UDN>([^<]+)</UDN>", RegexOption.IGNORE_CASE)
                            .find(xml)?.groupValues?.getOrNull(1)?.trim()
                        if (!fn.isNullOrBlank() || !mn.isNullOrBlank()) {
                            return Triple(fn, mn, udn)
                        }
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
            }
        }
        return Triple(null, null, null)
    }

    private fun isTcpPortOpen(host: String, port: Int, timeoutMs: Int): Boolean {
        return try {
            Socket().use { s ->
                s.connect(InetSocketAddress(InetAddress.getByName(host), port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun getLocalLanIpv4s(): List<Pair<String, ByteArray>> {
        val list = mutableListOf<Pair<String, ByteArray>>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return list
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        val hostAddr = addr.hostAddress ?: continue
                        list.add(hostAddr to addr.address)
                    }
                }
            }
        } catch (_: Exception) {
        }
        return list
    }

    private fun nioSweepSinglePort(ips: Collection<String>, port: Int, totalBudgetMs: Long): List<String> {
        val openIps = mutableListOf<String>()
        if (ips.isEmpty()) return openIps
        var selector: Selector? = null
        val channels = mutableListOf<SocketChannel>()
        try {
            selector = Selector.open()
            val queue = ArrayDeque(ips)
            val deadline = System.currentTimeMillis() + totalBudgetMs
            val maxBatch = 96

            fun fillBatch() {
                while (channels.size < maxBatch && queue.isNotEmpty()) {
                    val ip = queue.removeFirst()
                    try {
                        val ch = SocketChannel.open()
                        ch.configureBlocking(false)
                        val key = ch.register(selector, SelectionKey.OP_CONNECT, ip)
                        if (ch.connect(InetSocketAddress(ip, port))) {
                            openIps.add(ip)
                            key.cancel()
                            try { ch.close() } catch (_: Exception) {}
                        } else {
                            channels.add(ch)
                        }
                    } catch (_: Exception) {
                    }
                }
            }

            fillBatch()
            while (System.currentTimeMillis() < deadline && (channels.isNotEmpty() || queue.isNotEmpty())) {
                val rem = (deadline - System.currentTimeMillis()).coerceAtLeast(10L)
                selector.select(minOf(rem, 90L))
                val it = selector.selectedKeys().iterator()
                while (it.hasNext()) {
                    val key = it.next()
                    it.remove()
                    val ip = key.attachment() as? String
                    val ch = key.channel() as? SocketChannel
                    if (ch != null && key.isConnectable) {
                        try {
                            if (ch.finishConnect() && ip != null) {
                                openIps.add(ip)
                            }
                        } catch (_: Exception) {
                        } finally {
                            channels.remove(ch)
                            key.cancel()
                            try { ch.close() } catch (_: Exception) {}
                        }
                    }
                }
                fillBatch()
            }
        } catch (_: Exception) {
        } finally {
            for (ch in channels) {
                try { ch.close() } catch (_: Exception) {}
            }
            try { selector?.close() } catch (_: Exception) {}
        }
        return openIps
    }

    fun getSessionStateJson(): String {
        val connected = activeSocket != null && !(activeSocket?.isClosed ?: true) && activeTransportId != null
        return JSONObject()
            .put("connected", connected)
            .put("deviceName", if (connected) (activeDeviceName ?: JSONObject.NULL) else JSONObject.NULL)
            .put("host", if (connected) (activeHost ?: JSONObject.NULL) else JSONObject.NULL)
            .put("port", activePort)
            .put("mediaLoaded", connected && activeMediaLoaded)
            .put("playerState", if (connected) activePlayerState else "IDLE")
            .toString()
    }

    fun connectAndCastMedia(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val host = req.optString("host", "").trim()
            val port = req.optInt("port", 8009).let { if (it in 1..65535) it else 8009 }
            val deviceName = req.optString("deviceName", "").trim().ifBlank { "Chromecast ($host)" }
            val contentUrl = req.optString("contentUrl", "").trim()
            val contentType = req.optString("contentType", "video/mp4").trim().ifBlank { "video/mp4" }
            val title = req.optString("title", "EntenCenter Medien").trim()
            val subtitle = req.optString("subtitle", "").trim()
            val posterUrl = req.optString("posterUrl", "").trim()
            val currentTimeSec = req.optDouble("currentTimeSec", 0.0).coerceAtLeast(0.0)

            if (host.isEmpty()) {
                return JSONObject()
                    .put("ok", false)
                    .put("message", "Kein Chromecast-Zielgerät ausgewählt.")
                    .toString()
            }
            if (!contentUrl.startsWith("http://", true) && !contentUrl.startsWith("https://", true)) {
                return JSONObject()
                    .put("ok", false)
                    .put("message", "Für diesen Titel ist noch keine streambare HTTP-URL vorhanden.")
                    .toString()
            }

            synchronized(sessionLock) {
                val reuseExisting = activeSocket != null &&
                    !(activeSocket?.isClosed ?: true) &&
                    activeHost == host &&
                    activePort == port &&
                    !activeTransportId.isNullOrBlank()

                if (!reuseExisting) {
                    closeConnectionLocked()
                    openCastConnectionLocked(host, port, deviceName)
                    launchDefaultReceiverLocked()
                }

                loadMediaLocked(
                    contentUrl = contentUrl,
                    contentType = contentType,
                    title = title,
                    subtitle = subtitle,
                    posterUrl = posterUrl,
                    currentTimeSec = currentTimeSec
                )
            }

            JSONObject()
                .put("ok", true)
                .put("deviceName", activeDeviceName ?: deviceName)
                .put("host", host)
                .put("port", port)
                .put("mediaLoaded", activeMediaLoaded)
                .put("playerState", activePlayerState)
                .put("message", "Mit ${activeDeviceName ?: deviceName} verbunden und Wiedergabe gestartet.")
                .toString()
        } catch (e: Exception) {
            val errMsg = e.message ?: "Chromecast-Verbindung fehlgeschlagen."
            JSONObject()
                .put("ok", false)
                .put("message", errMsg)
                .toString()
        }
    }

    fun controlMedia(requestJson: String): String {
        return try {
            val req = JSONObject(requestJson)
            val action = req.optString("action", "").trim().lowercase()
            synchronized(sessionLock) {
                if (action == "disconnect" || action == "stop") {
                    val tId = activeTransportId
                    val sId = activeSessionId
                    if (action == "stop" && activeOutput != null && !sId.isNullOrBlank()) {
                        try {
                            sendCastMessageLocked(
                                RECEIVER_ID,
                                NS_RECEIVER,
                                JSONObject()
                                    .put("type", "STOP")
                                    .put("requestId", requestCounter.getAndIncrement())
                                    .put("sessionId", sId)
                                    .toString()
                            )
                        } catch (_: Exception) {}
                    } else if (!tId.isNullOrBlank() && activeOutput != null && !sId.isNullOrBlank()) {
                        try {
                            sendCastMessageLocked(
                                RECEIVER_ID,
                                NS_RECEIVER,
                                JSONObject()
                                    .put("type", "STOP")
                                    .put("requestId", requestCounter.getAndIncrement())
                                    .put("sessionId", sId)
                                    .toString()
                            )
                        } catch (_: Exception) {}
                    }
                    closeConnectionLocked()
                    return JSONObject()
                        .put("ok", true)
                        .put("connected", false)
                        .put("message", "Chromecast-Verbindung getrennt.")
                        .toString()
                }

                val tId = activeTransportId
                val mId = activeMediaSessionId
                if (activeSocket == null || activeSocket?.isClosed == true || tId.isNullOrBlank() || mId == null) {
                    return JSONObject()
                        .put("ok", false)
                        .put("message", "Keine aktive Chromecast-Wiedergabe vorhanden.")
                        .toString()
                }

                when (action) {
                    "play" -> {
                        sendCastMessageLocked(
                            tId,
                            NS_MEDIA,
                            JSONObject()
                                .put("type", "PLAY")
                                .put("requestId", requestCounter.getAndIncrement())
                                .put("mediaSessionId", mId)
                                .toString()
                        )
                        activePlayerState = "PLAYING"
                    }
                    "pause" -> {
                        sendCastMessageLocked(
                            tId,
                            NS_MEDIA,
                            JSONObject()
                                .put("type", "PAUSE")
                                .put("requestId", requestCounter.getAndIncrement())
                                .put("mediaSessionId", mId)
                                .toString()
                        )
                        activePlayerState = "PAUSED"
                    }
                    "seek" -> {
                        val sec = req.optDouble("currentTimeSec", 0.0).coerceAtLeast(0.0)
                        sendCastMessageLocked(
                            tId,
                            NS_MEDIA,
                            JSONObject()
                                .put("type", "SEEK")
                                .put("requestId", requestCounter.getAndIncrement())
                                .put("mediaSessionId", mId)
                                .put("currentTime", sec)
                                .toString()
                        )
                    }
                }
            }
            JSONObject()
                .put("ok", true)
                .put("connected", true)
                .put("playerState", activePlayerState)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("message", e.message ?: "Chromecast-Steuerung fehlgeschlagen.")
                .toString()
        }
    }

    private fun openCastConnectionLocked(host: String, port: Int, deviceName: String) {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        })
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustAll, SecureRandom())

        val rawSocket = Socket()
        rawSocket.connect(InetSocketAddress(InetAddress.getByName(host), port), 4500)
        val sslSocket = sslContext.socketFactory.createSocket(rawSocket, host, port, true) as SSLSocket
        sslSocket.soTimeout = 0
        sslSocket.startHandshake()

        activeSocket = sslSocket
        activeOutput = sslSocket.outputStream
        activeHost = host
        activePort = port
        activeDeviceName = deviceName
        activeTransportId = null
        activeSessionId = null
        activeMediaSessionId = null
        activeMediaLoaded = false
        activePlayerState = "IDLE"
        lastSessionError = null

        val input = sslSocket.inputStream
        activeReaderThread = Thread {
            readLoop(sslSocket, input)
        }.apply {
            isDaemon = true
            start()
        }

        heartbeatFuture?.cancel(true)
        heartbeatFuture = heartbeatExecutor.scheduleAtFixedRate({
            try {
                synchronized(sessionLock) {
                    if (activeSocket != null && !(activeSocket?.isClosed ?: true)) {
                        sendCastMessageLocked(RECEIVER_ID, NS_HEARTBEAT, """{"type":"PING"}""")
                    }
                }
            } catch (_: Exception) {
            }
        }, 4, 5, TimeUnit.SECONDS)

        sendCastMessageLocked(RECEIVER_ID, NS_CONNECTION, """{"type":"CONNECT"}""")
    }

    private fun launchDefaultReceiverLocked() {
        val latch = CountDownLatch(1)
        pendingReceiverLatch = latch
        lastSessionError = null

        sendCastMessageLocked(
            RECEIVER_ID,
            NS_RECEIVER,
            JSONObject()
                .put("type", "LAUNCH")
                .put("appId", DEFAULT_MEDIA_RECEIVER_APP_ID)
                .put("requestId", requestCounter.getAndIncrement())
                .toString()
        )

        val completed = latch.await(9000, TimeUnit.MILLISECONDS)
        pendingReceiverLatch = null

        if (!completed || activeTransportId.isNullOrBlank()) {
            val err = lastSessionError ?: "Chromecast-Empfänger-App konnte nicht gestartet werden."
            closeConnectionLocked()
            throw IllegalStateException(err)
        }

        val tId = activeTransportId!!
        sendCastMessageLocked(tId, NS_CONNECTION, """{"type":"CONNECT"}""")
    }

    private fun loadMediaLocked(
        contentUrl: String,
        contentType: String,
        title: String,
        subtitle: String,
        posterUrl: String,
        currentTimeSec: Double
    ) {
        val tId = activeTransportId ?: throw IllegalStateException("Keine aktive Transport-ID.")
        val sId = activeSessionId ?: ""

        val metadata = JSONObject()
            .put("metadataType", 0)
            .put("title", title)
        if (subtitle.isNotBlank()) {
            metadata.put("subtitle", subtitle)
        }
        if (posterUrl.startsWith("http://", true) || posterUrl.startsWith("https://", true)) {
            if (!posterUrl.contains("app.entencenter.local", true) &&
                !posterUrl.contains("127.0.0.1") &&
                !posterUrl.contains("localhost")
            ) {
                metadata.put("images", JSONArray().put(JSONObject().put("url", posterUrl)))
            }
        }

        val mediaObj = JSONObject()
            .put("contentId", contentUrl)
            .put("streamType", "BUFFERED")
            .put("contentType", contentType)
            .put("metadata", metadata)

        val loadPayload = JSONObject()
            .put("type", "LOAD")
            .put("requestId", requestCounter.getAndIncrement())
            .put("sessionId", sId)
            .put("autoplay", true)
            .put("currentTime", currentTimeSec)
            .put("media", mediaObj)

        val latch = CountDownLatch(1)
        pendingMediaLatch = latch
        lastSessionError = null
        activeMediaLoaded = false

        sendCastMessageLocked(tId, NS_MEDIA, loadPayload.toString())

        latch.await(7000, TimeUnit.MILLISECONDS)
        pendingMediaLatch = null

        if (!lastSessionError.isNullOrBlank()) {
            throw IllegalStateException(lastSessionError!!)
        }
        activeMediaLoaded = true
    }

    private fun readLoop(socket: SSLSocket, inputStream: InputStream) {
        val dis = DataInputStream(inputStream)
        try {
            while (!socket.isClosed) {
                val msgLen = dis.readInt()
                if (msgLen <= 0 || msgLen > 1024 * 1024) break
                val raw = ByteArray(msgLen)
                dis.readFully(raw)
                val parsed = decodeCastMessage(raw) ?: continue
                handleIncomingCastMessage(parsed)
            }
        } catch (_: Exception) {
        } finally {
            if (activeSocket === socket) {
                synchronized(sessionLock) {
                    if (activeSocket === socket) {
                        closeConnectionLocked()
                    }
                }
            }
        }
    }

    private fun handleIncomingCastMessage(msg: DecodedCastMessage) {
        val payload = msg.payloadUtf8 ?: return
        if (msg.namespace == NS_HEARTBEAT) {
            if (payload.contains("\"PING\"")) {
                try {
                    synchronized(sessionLock) {
                        if (activeOutput != null) {
                            sendCastMessageLocked(msg.sourceId, NS_HEARTBEAT, """{"type":"PONG"}""")
                        }
                    }
                } catch (_: Exception) {}
            }
            return
        }

        if (msg.namespace == NS_CONNECTION && payload.contains("\"CLOSE\"")) {
            if (msg.sourceId == activeTransportId) {
                activeTransportId = null
                activeSessionId = null
                activeMediaSessionId = null
                activeMediaLoaded = false
                activePlayerState = "IDLE"
            }
            return
        }

        try {
            val json = JSONObject(payload)
            val type = json.optString("type", "")
            when {
                type == "RECEIVER_STATUS" -> {
                    val status = json.optJSONObject("status")
                    val apps = status?.optJSONArray("applications")
                    if (apps != null) {
                        for (i in 0 until apps.length()) {
                            val app = apps.optJSONObject(i) ?: continue
                            val appId = app.optString("appId", "")
                            val tId = app.optString("transportId", "")
                            val sId = app.optString("sessionId", "")
                            if ((appId == DEFAULT_MEDIA_RECEIVER_APP_ID || tId.isNotBlank()) && tId.isNotBlank()) {
                                activeTransportId = tId
                                activeSessionId = sId
                                pendingReceiverLatch?.countDown()
                                break
                            }
                        }
                    }
                }
                type == "MEDIA_STATUS" -> {
                    val arr = json.optJSONArray("status")
                    if (arr != null && arr.length() > 0) {
                        val first = arr.optJSONObject(0)
                        if (first != null) {
                            if (first.has("mediaSessionId")) {
                                activeMediaSessionId = first.optLong("mediaSessionId")
                            }
                            activePlayerState = first.optString("playerState", activePlayerState)
                            activeMediaLoaded = true
                            pendingMediaLatch?.countDown()
                        }
                    }
                }
                type == "LOAD_FAILED" || type == "INVALID_REQUEST" || type == "LAUNCH_ERROR" -> {
                    val reason = json.optString("reason", "").trim()
                    lastSessionError = when {
                        reason.isNotBlank() -> "Chromecast-Fehler: $reason"
                        type == "LOAD_FAILED" -> "Chromecast konnte das Medienformat bzw. die URL nicht laden."
                        else -> "Chromecast hat die Anfrage abgelehnt ($type)."
                    }
                    pendingReceiverLatch?.countDown()
                    pendingMediaLatch?.countDown()
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun sendCastMessageLocked(destinationId: String, namespace: String, payloadUtf8: String) {
        val out = activeOutput ?: throw IllegalStateException("Chromecast-Socket nicht verbunden.")
        val encoded = encodeCastMessage(SENDER_ID, destinationId, namespace, payloadUtf8)
        val header = ByteBuffer.allocate(4).putInt(encoded.size).array()
        out.write(header)
        out.write(encoded)
        out.flush()
    }

    private fun closeConnectionLocked() {
        heartbeatFuture?.cancel(true)
        heartbeatFuture = null
        try { activeOutput?.close() } catch (_: Exception) {}
        try { activeSocket?.close() } catch (_: Exception) {}
        activeOutput = null
        activeSocket = null
        activeReaderThread = null
        activeTransportId = null
        activeSessionId = null
        activeMediaSessionId = null
        activeMediaLoaded = false
        activePlayerState = "IDLE"
        pendingReceiverLatch?.countDown()
        pendingMediaLatch?.countDown()
    }

    fun destroy() {
        synchronized(sessionLock) {
            closeConnectionLocked()
        }
        discoveryExecutor.shutdownNow()
        connectExecutor.shutdownNow()
        heartbeatExecutor.shutdownNow()
    }

    private data class DecodedCastMessage(
        val sourceId: String,
        val destinationId: String,
        val namespace: String,
        val payloadUtf8: String?
    )

    private fun writeVarint(out: ByteArrayOutputStream, value: Int) {
        var v = value
        while (true) {
            if ((v and 0x7F.inv()) == 0) {
                out.write(v)
                return
            }
            out.write((v and 0x7F) or 0x80)
            v = v ushr 7
        }
    }

    private fun writeLengthDelimited(out: ByteArrayOutputStream, fieldNumber: Int, text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        writeVarint(out, (fieldNumber shl 3) or 2)
        writeVarint(out, bytes.size)
        out.write(bytes)
    }

    private fun encodeCastMessage(
        sourceId: String,
        destinationId: String,
        namespace: String,
        payloadUtf8: String
    ): ByteArray {
        val out = ByteArrayOutputStream()
        // field 1: protocol_version = 0 (CASTV2_1_0)
        writeVarint(out, (1 shl 3) or 0)
        writeVarint(out, 0)
        // field 2: source_id
        writeLengthDelimited(out, 2, sourceId)
        // field 3: destination_id
        writeLengthDelimited(out, 3, destinationId)
        // field 4: namespace
        writeLengthDelimited(out, 4, namespace)
        // field 5: payload_type = 0 (STRING)
        writeVarint(out, (5 shl 3) or 0)
        writeVarint(out, 0)
        // field 6: payload_utf8
        writeLengthDelimited(out, 6, payloadUtf8)
        return out.toByteArray()
    }

    private fun decodeCastMessage(bytes: ByteArray): DecodedCastMessage? {
        var idx = 0
        fun readVarint(): Int {
            var result = 0
            var shift = 0
            while (idx < bytes.size) {
                val b = bytes[idx++].toInt() and 0xFF
                result = result or ((b and 0x7F) shl shift)
                if ((b and 0x80) == 0) break
                shift += 7
            }
            return result
        }

        var sourceId = ""
        var destinationId = ""
        var namespace = ""
        var payloadUtf8: String? = null

        while (idx < bytes.size) {
            val tag = readVarint()
            val fieldNum = tag ushr 3
            val wireType = tag and 0x07
            when (wireType) {
                0 -> readVarint()
                1 -> idx += 8
                5 -> idx += 4
                2 -> {
                    val len = readVarint()
                    if (len < 0 || idx + len > bytes.size) return null
                    when (fieldNum) {
                        2 -> sourceId = String(bytes, idx, len, Charsets.UTF_8)
                        3 -> destinationId = String(bytes, idx, len, Charsets.UTF_8)
                        4 -> namespace = String(bytes, idx, len, Charsets.UTF_8)
                        6 -> payloadUtf8 = String(bytes, idx, len, Charsets.UTF_8)
                    }
                    idx += len
                }
                else -> return null
            }
        }
        return DecodedCastMessage(sourceId, destinationId, namespace, payloadUtf8)
    }
}
