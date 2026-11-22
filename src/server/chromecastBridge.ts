import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import {
  decodeMdnsResponsePacket,
  encodeMdnsQueryPacket,
  MDNS_MULTICAST_ADDR,
  MDNS_PORT,
  SSDP_MULTICAST_ADDR,
  SSDP_PORT,
} from './nasDiscovery.ts';
import { isLocalLanTargetStrict, resolveHostIp } from './nasProtocolProber.ts';

const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';
const SENDER_ID = 'sender-0';
const RECEIVER_ID = 'receiver-0';
const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

export interface ServerDiscoveredCastDevice {
  id: string;
  name: string;
  model?: string;
  host: string;
  port: number;
  source: 'mdns' | 'ssdp' | 'eureka' | 'manual';
}

export interface ServerCastSessionState {
  connected: boolean;
  connecting: boolean;
  host: string | null;
  port: number;
  deviceName: string | null;
  mediaLoaded: boolean;
  playerState: string;
  lastError: string | null;
}

interface DecodedCastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  payloadUtf8: string | null;
}

const discoveredDevices = new Map<string, ServerDiscoveredCastDevice>();

let activeSocket: tls.TLSSocket | null = null;
let activeHost: string | null = null;
let activePort = 8009;
let activeDeviceName: string | null = null;
let activeTransportId: string | null = null;
let activeSessionId: string | null = null;
let activeMediaSessionId: number | null = null;
let activePlayerState = 'IDLE';
let activeMediaLoaded = false;
let lastSessionError: string | null = null;
let isConnecting = false;
let requestCounter = 1;
let heartbeatTimer: NodeJS.Timeout | null = null;
let readBuffer = Buffer.alloc(0);

let receiverWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
let mediaWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      out.push(v);
      return;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

function writeLengthDelimited(out: number[], fieldNumber: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  writeVarint(out, (fieldNumber << 3) | 2);
  writeVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out.push(bytes[i]);
  }
}

function encodeCastMessage(
  sourceId: string,
  destinationId: string,
  namespace: string,
  payloadUtf8: string
): Buffer {
  const out: number[] = [];
  // field 1: protocol_version = 0 (CASTV2_1_0)
  writeVarint(out, (1 << 3) | 0);
  writeVarint(out, 0);
  // field 2: source_id
  writeLengthDelimited(out, 2, sourceId);
  // field 3: destination_id
  writeLengthDelimited(out, 3, destinationId);
  // field 4: namespace
  writeLengthDelimited(out, 4, namespace);
  // field 5: payload_type = 0 (STRING)
  writeVarint(out, (5 << 3) | 0);
  writeVarint(out, 0);
  // field 6: payload_utf8
  writeLengthDelimited(out, 6, payloadUtf8);
  return Buffer.from(out);
}

function decodeCastMessage(bytes: Buffer): DecodedCastMessage | null {
  let idx = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (idx < bytes.length) {
      const b = bytes[idx];
      idx += 1;
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };

  let sourceId = '';
  let destinationId = '';
  let namespace = '';
  let payloadUtf8: string | null = null;

  while (idx < bytes.length) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      idx += 8;
    } else if (wireType === 5) {
      idx += 4;
    } else if (wireType === 2) {
      const len = readVarint();
      if (len < 0 || idx + len > bytes.length) return null;
      if (fieldNum === 2) sourceId = bytes.subarray(idx, idx + len).toString('utf8');
      else if (fieldNum === 3) destinationId = bytes.subarray(idx, idx + len).toString('utf8');
      else if (fieldNum === 4) namespace = bytes.subarray(idx, idx + len).toString('utf8');
      else if (fieldNum === 6) payloadUtf8 = bytes.subarray(idx, idx + len).toString('utf8');
      idx += len;
    } else {
      return null;
    }
  }

  return { sourceId, destinationId, namespace, payloadUtf8 };
}

function sendCastMessage(destinationId: string, namespace: string, payloadObj: unknown): void {
  if (!activeSocket || activeSocket.destroyed) {
    throw new Error('Chromecast-Socket ist nicht verbunden.');
  }
  const jsonStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const encoded = encodeCastMessage(SENDER_ID, destinationId, namespace, jsonStr);
  const frame = Buffer.allocUnsafe(4 + encoded.length);
  frame.writeUInt32BE(encoded.length, 0);
  encoded.copy(frame, 4);
  activeSocket.write(frame);
}

function resolveAllWaiters(
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>,
  err?: Error
): void {
  const copy = waiters.splice(0, waiters.length);
  for (const w of copy) {
    if (err) w.reject(err);
    else w.resolve();
  }
}

function closeCastConnection(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (activeSocket) {
    try {
      activeSocket.removeAllListeners();
      activeSocket.destroy();
    } catch {
      // ignore
    }
    activeSocket = null;
  }
  readBuffer = Buffer.alloc(0);
  activeTransportId = null;
  activeSessionId = null;
  activeMediaSessionId = null;
  activeMediaLoaded = false;
  activePlayerState = 'IDLE';
  activeHost = null;
  activeDeviceName = null;
  resolveAllWaiters(receiverWaiters, new Error('Chromecast-Verbindung geschlossen.'));
  resolveAllWaiters(mediaWaiters, new Error('Chromecast-Verbindung geschlossen.'));
}

function handleIncomingCastMessage(msg: DecodedCastMessage): void {
  const payload = msg.payloadUtf8;
  if (!payload) return;

  if (msg.namespace === NS_HEARTBEAT) {
    if (payload.includes('"PING"') && activeSocket && !activeSocket.destroyed) {
      try {
        sendCastMessage(msg.sourceId || RECEIVER_ID, NS_HEARTBEAT, { type: 'PONG' });
      } catch {
        // ignore
      }
    }
    return;
  }

  if (msg.namespace === NS_CONNECTION && payload.includes('"CLOSE"')) {
    if (msg.sourceId === activeTransportId) {
      activeTransportId = null;
      activeSessionId = null;
      activeMediaSessionId = null;
      activeMediaLoaded = false;
      activePlayerState = 'IDLE';
    }
    return;
  }

  try {
    const json = JSON.parse(payload) as {
      type?: string;
      reason?: string;
      status?:
        | {
            applications?: Array<{
              appId?: string;
              transportId?: string;
              sessionId?: string;
            }>;
          }
        | Array<{
            mediaSessionId?: number;
            playerState?: string;
          }>;
    };

    if (json.type === 'RECEIVER_STATUS' && json.status && !Array.isArray(json.status)) {
      const apps = json.status.applications ?? [];
      for (const app of apps) {
        if (
          app.transportId &&
          (app.appId === DEFAULT_MEDIA_RECEIVER_APP_ID || app.transportId.length > 0)
        ) {
          activeTransportId = app.transportId;
          activeSessionId = app.sessionId ?? '';
          resolveAllWaiters(receiverWaiters);
          break;
        }
      }
      return;
    }

    if (json.type === 'MEDIA_STATUS' && Array.isArray(json.status) && json.status.length > 0) {
      const first = json.status[0];
      if (typeof first.mediaSessionId === 'number') {
        activeMediaSessionId = first.mediaSessionId;
      }
      if (first.playerState) {
        activePlayerState = first.playerState;
      }
      activeMediaLoaded = true;
      resolveAllWaiters(mediaWaiters);
      return;
    }

    if (
      json.type === 'LOAD_FAILED' ||
      json.type === 'INVALID_REQUEST' ||
      json.type === 'LAUNCH_ERROR'
    ) {
      const reason = (json.reason ?? '').trim();
      const errMsg = reason
        ? `Chromecast-Fehler: ${reason}`
        : json.type === 'LOAD_FAILED'
          ? 'Chromecast konnte diese Medien-URL oder dieses Format nicht direkt abspielen.'
          : `Chromecast hat die Anfrage abgelehnt (${json.type}).`;
      lastSessionError = errMsg;
      const err = new Error(errMsg);
      resolveAllWaiters(receiverWaiters, err);
      resolveAllWaiters(mediaWaiters, err);
    }
  } catch {
    // ignore malformed JSON
  }
}

function handleSocketData(chunk: Buffer): void {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  while (readBuffer.length >= 4) {
    const msgLen = readBuffer.readUInt32BE(0);
    if (msgLen <= 0 || msgLen > 1024 * 1024) {
      closeCastConnection();
      return;
    }
    if (readBuffer.length < 4 + msgLen) {
      return;
    }
    const payload = readBuffer.subarray(4, 4 + msgLen);
    readBuffer = readBuffer.subarray(4 + msgLen);
    const parsed = decodeCastMessage(payload);
    if (parsed) {
      handleIncomingCastMessage(parsed);
    }
  }
}

function getServerReachableLanIp(): string | null {
  const nets = os.networkInterfaces();
  let fallback: string | null = null;
  for (const [ifaceName, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr.address)) {
        if (!/docker|veth|br-|virbr|tun|tap/i.test(ifaceName)) {
          return addr.address;
        }
        fallback ??= addr.address;
      }
    }
  }
  return fallback;
}

export function rewriteCastUrlForLan(rawUrl: string, serverPort: number): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  const lanIp = getServerReachableLanIp();
  if (trimmed.startsWith('/')) {
    return lanIp ? `http://${lanIp}:${serverPort}${trimmed}` : trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const h = parsed.hostname.toLowerCase();
    if (
      lanIp &&
      (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === 'app.entencenter.local')
    ) {
      parsed.protocol = 'http:';
      parsed.hostname = lanIp;
      parsed.port = String(serverPort);
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function upsertCastDevice(dev: ServerDiscoveredCastDevice): void {
  const existing = discoveredDevices.get(dev.host);
  const resolvedName =
    dev.name && !dev.name.startsWith(`Chromecast (${dev.host}`)
      ? dev.name
      : existing?.name || dev.name || `Chromecast (${dev.host})`;
  discoveredDevices.set(dev.host, {
    id: dev.id || existing?.id || `cast-${dev.host}-${dev.port || 8009}`,
    name: resolvedName,
    model: dev.model || existing?.model || 'Google Cast',
    host: dev.host,
    port: dev.port || 8009,
    source: dev.source,
  });
}

function probeTcpPort(host: string, port: number, timeoutMs = 650): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function fetchEurekaInfo(
  host: string,
  timeoutMs = 950
): Promise<{ name?: string; model?: string; id?: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port: 8008,
        path: '/setup/eureka_info?options=detail',
        timeout: timeoutMs,
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              name?: string;
              device_info?: { model_name?: string; ssdp_udn?: string };
              detail?: { model_name?: string };
              ssdp_udn?: string;
            };
            resolve({
              name: parsed.name?.trim(),
              model: (parsed.device_info?.model_name || parsed.detail?.model_name)?.trim(),
              id: (parsed.device_info?.ssdp_udn || parsed.ssdp_udn)?.trim(),
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

export async function probeSingleChromecastHost(
  rawHost: string,
  port = 8009
): Promise<ServerDiscoveredCastDevice | null> {
  const cleanHost = rawHost.trim().replace(/^\[|\]$/g, '');
  if (!cleanHost) {
    return null;
  }
  const resolved = await resolveHostIp(cleanHost);
  if (!isLocalLanTargetStrict(cleanHost, resolved.ip)) {
    return null;
  }
  const targetHost = resolved.ip || cleanHost;
  const safePort = port >= 1 && port <= 65535 ? port : 8009;
  const [eureka, castOpen] = await Promise.all([
    fetchEurekaInfo(targetHost, 1100),
    probeTcpPort(targetHost, safePort, 900),
  ]);
  if (!eureka && !castOpen) {
    return null;
  }
  const device: ServerDiscoveredCastDevice = {
    id: eureka?.id || `cast-${targetHost}-${safePort}`,
    name: eureka?.name || `Chromecast (${cleanHost})`,
    model: eureka?.model || 'Google Cast',
    host: targetHost,
    port: safePort,
    source: eureka ? 'eureka' : 'manual',
  };
  upsertCastDevice(device);
  return device;
}

export async function discoverServerChromecastDevices(
  manualHost?: string | null
): Promise<ServerDiscoveredCastDevice[]> {
  if (manualHost && manualHost.trim()) {
    await probeSingleChromecastHost(manualHost.trim());
  }

  const candidateHosts = new Set<string>();

  await Promise.all([
    // 1. mDNS (_googlecast._tcp.local)
    new Promise<void>((resolve) => {
      let socket: dgram.Socket | null = null;
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // ignore
        }
        resolve();
      };
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', finish);
        socket.on('message', (msg, rinfo) => {
          const parsed = decodeMdnsResponsePacket(msg);
          if (!parsed || !parsed.isResponse) return;
          const allRecords = parsed.answers;
          let hasGoogleCast = false;
          let hostIp = rinfo.address;
          let castPort = 8009;
          let friendlyName = '';
          let modelName = '';
          let castId = '';

          for (const rec of allRecords) {
            if (rec.name.toLowerCase().includes('_googlecast._tcp')) {
              hasGoogleCast = true;
            }
            if (rec.rtype === 'A' && rec.data.ip) {
              hostIp = rec.data.ip;
            }
            if (rec.rtype === 'SRV' && rec.data.port) {
              castPort = rec.data.port;
            }
            if (rec.rtype === 'TXT' && rec.data.txt) {
              if (rec.data.txt.fn) friendlyName = rec.data.txt.fn;
              if (rec.data.txt.md) modelName = rec.data.txt.md;
              if (rec.data.txt.id) castId = rec.data.txt.id;
            }
          }

          if (hasGoogleCast && hostIp) {
            candidateHosts.add(hostIp);
            upsertCastDevice({
              id: castId || `cast-${hostIp}-${castPort}`,
              name: friendlyName || `Chromecast (${hostIp})`,
              model: modelName || 'Google Cast',
              host: hostIp,
              port: castPort,
              source: 'mdns',
            });
          }
        });

        socket.bind(0, () => {
          if (!socket) return finish();
          const query = encodeMdnsQueryPacket([
            { name: '_googlecast._tcp.local', qtype: 12 },
          ]);
          try {
            socket.send(query, 0, query.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
          } catch {
            // ignore
          }
        });
        timer = setTimeout(finish, 1400);
      } catch {
        finish();
      }
    }),

    // 2. SSDP DIAL search
    new Promise<void>((resolve) => {
      let socket: dgram.Socket | null = null;
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // ignore
        }
        resolve();
      };
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', finish);
        socket.on('message', (msg, rinfo) => {
          const text = msg.toString('utf8');
          if (
            /dial-multiscreen-org|eureka|chromecast|googlecast/i.test(text) &&
            rinfo.address
          ) {
            candidateHosts.add(rinfo.address);
          }
        });
        const ssdpReq = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`,
            'MAN: "ssdp:discover"',
            'MX: 1',
            'ST: urn:dial-multiscreen-org:service:dial:1',
            '',
            '',
          ].join('\r\n')
        );
        socket.bind(0, () => {
          if (!socket) return finish();
          try {
            socket.send(ssdpReq, 0, ssdpReq.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
          } catch {
            // ignore
          }
        });
        timer = setTimeout(finish, 1200);
      } catch {
        finish();
      }
    }),
  ]);

  if (candidateHosts.size > 0) {
    await Promise.all(
      Array.from(candidateHosts).map(async (host) => {
        const eureka = await fetchEurekaInfo(host, 800);
        if (eureka) {
          upsertCastDevice({
            id: eureka.id || `cast-${host}-8009`,
            name: eureka.name || `Chromecast (${host})`,
            model: eureka.model || 'Google Cast',
            host,
            port: 8009,
            source: 'eureka',
          });
        }
      })
    );
  }

  return Array.from(discoveredDevices.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'de')
  );
}

export function getServerCastSessionState(): ServerCastSessionState {
  return {
    connected: Boolean(activeSocket && !activeSocket.destroyed && activeHost),
    connecting: isConnecting,
    host: activeHost,
    port: activePort,
    deviceName: activeDeviceName,
    mediaLoaded: activeMediaLoaded,
    playerState: activePlayerState,
    lastError: lastSessionError,
  };
}

function waitForWaiter(
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(entry);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    };
    waiters.push(entry);
  });
}

export async function connectAndCastOnServer(params: {
  host: string;
  port?: number;
  deviceName?: string;
  contentUrl: string;
  contentType?: string;
  title?: string;
  subtitle?: string;
  posterUrl?: string;
  currentTimeSec?: number;
  serverPort: number;
}): Promise<{ ok: boolean; deviceName: string; message: string }> {
  const rawHost = (params.host || '').trim().replace(/^\[|\]$/g, '');
  if (!rawHost) {
    throw new Error('Ungültige oder nicht-lokale Chromecast-Adresse.');
  }
  const resolvedHost = await resolveHostIp(rawHost);
  if (!isLocalLanTargetStrict(rawHost, resolvedHost.ip)) {
    throw new Error('Ungültige oder nicht-lokale Chromecast-Adresse.');
  }
  const cleanHost = resolvedHost.ip || rawHost;
  const safePort =
    params.port && params.port >= 1 && params.port <= 65535 ? params.port : 8009;
  const resolvedName = (params.deviceName || '').trim() || `Chromecast (${rawHost})`;
  const playableUrl = rewriteCastUrlForLan(params.contentUrl, params.serverPort);
  if (!playableUrl) {
    throw new Error('Keine abspielbare Medien-URL für Chromecast vorhanden.');
  }

  isConnecting = true;
  lastSessionError = null;
  try {
    const alreadyConnectedSameHost =
      activeSocket && !activeSocket.destroyed && activeHost === cleanHost && activePort === safePort;

    if (!alreadyConnectedSameHost) {
      closeCastConnection();
      await new Promise<void>((resolve, reject) => {
        const sock = tls.connect(
          {
            host: cleanHost,
            port: safePort,
            rejectUnauthorized: false,
          },
          () => resolve()
        );
        sock.setTimeout(5000);
        sock.once('timeout', () => {
          sock.destroy();
          reject(new Error(`Zeitüberschreitung beim Verbinden mit ${resolvedName} (${cleanHost}:${safePort}).`));
        });
        sock.once('error', (err) => {
          reject(new Error(`Chromecast unter ${cleanHost}:${safePort} nicht erreichbar: ${err.message}`));
        });
        sock.on('data', handleSocketData);
        sock.on('close', () => {
          if (activeSocket === sock) {
            closeCastConnection();
          }
        });
        activeSocket = sock;
      });
      activeSocket?.setTimeout(0);
      activeHost = cleanHost;
      activePort = safePort;
      activeDeviceName = resolvedName;

      heartbeatTimer = setInterval(() => {
        if (activeSocket && !activeSocket.destroyed) {
          try {
            sendCastMessage(RECEIVER_ID, NS_HEARTBEAT, { type: 'PING' });
          } catch {
            // ignore
          }
        }
      }, 5000);
      heartbeatTimer.unref?.();

      sendCastMessage(RECEIVER_ID, NS_CONNECTION, { type: 'CONNECT' });
    }

    if (!activeTransportId) {
      const waitReceiver = waitForWaiter(
        receiverWaiters,
        9000,
        'Chromecast-Empfänger-App konnte nicht gestartet werden.'
      );
      requestCounter += 1;
      sendCastMessage(RECEIVER_ID, NS_RECEIVER, {
        type: 'LAUNCH',
        appId: DEFAULT_MEDIA_RECEIVER_APP_ID,
        requestId: requestCounter,
      });
      await waitReceiver;
      if (activeTransportId) {
        sendCastMessage(activeTransportId, NS_CONNECTION, { type: 'CONNECT' });
      }
    }

    if (!activeTransportId) {
      throw new Error('Keine aktive Chromecast-Transport-ID erhalten.');
    }

    const metadata: Record<string, unknown> = {
      metadataType: 0,
      title: params.title || 'EntenCenter Stream',
    };
    if (params.subtitle) {
      metadata.subtitle = params.subtitle;
    }
    const resolvedPoster = params.posterUrl
      ? rewriteCastUrlForLan(params.posterUrl, params.serverPort)
      : '';
    if (
      resolvedPoster &&
      (resolvedPoster.startsWith('http://') || resolvedPoster.startsWith('https://')) &&
      !resolvedPoster.includes('127.0.0.1') &&
      !resolvedPoster.includes('localhost') &&
      !resolvedPoster.includes('app.entencenter.local')
    ) {
      metadata.images = [{ url: resolvedPoster }];
    }

    const waitMedia = waitForWaiter(
      mediaWaiters,
      7000,
      'Chromecast hat die Medienwiedergabe nicht rechtzeitig bestätigt.'
    );
    requestCounter += 1;
    sendCastMessage(activeTransportId, NS_MEDIA, {
      type: 'LOAD',
      requestId: requestCounter,
      sessionId: activeSessionId || '',
      autoplay: true,
      currentTime: Math.max(0, Number(params.currentTimeSec) || 0),
      media: {
        contentId: playableUrl,
        streamType: 'BUFFERED',
        contentType: params.contentType || 'video/mp4',
        metadata,
      },
    });
    await waitMedia;

    return {
      ok: true,
      deviceName: resolvedName,
      message: `Mit ${resolvedName} verbunden und Wiedergabe gestartet.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Chromecast-Verbindung fehlgeschlagen.';
    lastSessionError = msg;
    closeCastConnection();
    throw new Error(msg);
  } finally {
    isConnecting = false;
  }
}

export function controlServerCastMedia(params: {
  action: 'play' | 'pause' | 'seek' | 'disconnect';
  currentTimeSec?: number;
}): { ok: boolean; message: string } {
  if (params.action === 'disconnect') {
    if (activeSocket && !activeSocket.destroyed && activeTransportId) {
      try {
        requestCounter += 1;
        sendCastMessage(activeTransportId, NS_RECEIVER, {
          type: 'STOP',
          sessionId: activeSessionId || '',
          requestId: requestCounter,
        });
      } catch {
        // ignore
      }
    }
    closeCastConnection();
    return { ok: true, message: 'Chromecast-Verbindung getrennt.' };
  }

  if (!activeSocket || activeSocket.destroyed || !activeTransportId || activeMediaSessionId === null) {
    return { ok: false, message: 'Keine aktive Chromecast-Wiedergabe vorhanden.' };
  }

  requestCounter += 1;
  if (params.action === 'play') {
    sendCastMessage(activeTransportId, NS_MEDIA, {
      type: 'PLAY',
      mediaSessionId: activeMediaSessionId,
      requestId: requestCounter,
    });
    return { ok: true, message: 'Chromecast-Wiedergabe fortgesetzt.' };
  }
  if (params.action === 'pause') {
    sendCastMessage(activeTransportId, NS_MEDIA, {
      type: 'PAUSE',
      mediaSessionId: activeMediaSessionId,
      requestId: requestCounter,
    });
    return { ok: true, message: 'Chromecast-Wiedergabe pausiert.' };
  }
  if (params.action === 'seek') {
    sendCastMessage(activeTransportId, NS_MEDIA, {
      type: 'SEEK',
      mediaSessionId: activeMediaSessionId,
      currentTime: Math.max(0, Number(params.currentTimeSec) || 0),
      requestId: requestCounter,
    });
    return { ok: true, message: 'Chromecast-Position aktualisiert.' };
  }

  return { ok: false, message: 'Unbekannte Chromecast-Aktion.' };
}
