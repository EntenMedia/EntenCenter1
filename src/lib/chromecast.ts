import { NasMediaItem } from '../types/marcente';
import { readLocalOnboardingBuffer } from './localBufferStore';
import {
  cleanHostOnly,
  getEffectiveNasOrigin,
  inferMimeTypeFromPath,
  isNativeAndroidShell,
  resolveNasUrl,
  resolvePlayableNasMediaUrl,
  sanitizeNasPortForProtocol,
} from './nasClient';

export type CastConnectionState =
  | 'UNAVAILABLE'
  | 'NO_DEVICES_AVAILABLE'
  | 'NOT_CONNECTED'
  | 'CONNECTING'
  | 'CONNECTED';

export type CastTransportMode =
  | 'native_android'
  | 'server_lan'
  | 'google_cast_sdk'
  | 'remote_playback'
  | 'browser_ready'
  | 'unavailable';

export interface DiscoveredCastDevice {
  id: string;
  name: string;
  model?: string;
  host: string;
  port: number;
  source?: string;
}

export interface CastStateSnapshot {
  sdkReady: boolean;
  mode: CastTransportMode;
  castState: CastConnectionState;
  deviceName: string | null;
  activeHost: string | null;
  mediaLoaded: boolean;
  isEmbeddedFrame: boolean;
  scanningDevices: boolean;
  devices: DiscoveredCastDevice[];
}

interface CastSessionLike {
  getCastDevice?: () => { friendlyName?: string } | null;
  getMediaSession?: () => CastMediaSessionLike | null;
  loadMedia: (request: unknown) => Promise<unknown>;
  endSession?: (stopCasting: boolean) => void;
}

interface CastMediaSessionLike {
  play?: (req: unknown, ok?: () => void, err?: (e: unknown) => void) => void;
  pause?: (req: unknown, ok?: () => void, err?: (e: unknown) => void) => void;
  seek?: (req: unknown, ok?: () => void, err?: (e: unknown) => void) => void;
}

interface CastContextLike {
  setOptions: (opts: { receiverApplicationId: string; autoJoinPolicy: string }) => void;
  getCastState: () => CastConnectionState;
  getCurrentSession: () => CastSessionLike | null;
  requestSession: () => Promise<unknown>;
  endCurrentSession: (stopCasting: boolean) => void;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

interface ChromeCastNamespace {
  AutoJoinPolicy: {
    ORIGIN_SCOPED: string;
  };
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    MediaInfo: new (contentId: string, contentType: string) => {
      metadata?: unknown;
      customData?: unknown;
      streamType?: string;
    };
    GenericMediaMetadata: new () => {
      metadataType?: number;
      title?: string;
      subtitle?: string;
      images?: Array<{ url: string }>;
    };
    MetadataType: {
      GENERIC: number;
    };
    StreamType: {
      BUFFERED: string;
    };
    LoadRequest: new (mediaInfo: unknown) => {
      autoplay?: boolean;
      currentTime?: number;
    };
    PlayRequest: new () => unknown;
    PauseRequest: new () => unknown;
    SeekRequest: new () => { currentTime: number };
  };
  Image: new (url: string) => { url: string };
}

interface CastFrameworkNamespace {
  CastContext: {
    getInstance: () => CastContextLike;
  };
  CastContextEventType: {
    CAST_STATE_CHANGED: string;
    SESSION_STATE_CHANGED: string;
  };
}

interface RemotePlaybackLike extends EventTarget {
  state: 'connecting' | 'connected' | 'disconnected';
  prompt: () => Promise<void>;
  watchAvailability?: (cb: (available: boolean) => void) => Promise<number>;
  cancelWatchAvailability?: (id?: number) => Promise<void>;
}

interface PresentationConnectionLike {
  close?: () => void;
  terminate?: () => void;
}

interface AndroidCastBridge {
  startChromecastDiscovery?: () => boolean;
  getChromecastDiscoveryResult?: () => string;
  connectAndCastMedia?: (requestJson: string) => string;
  startConnectAndCastMedia?: (requestJson: string) => boolean;
  getChromecastConnectResult?: () => string;
  controlChromecastMedia?: (requestJson: string) => string;
  getChromecastSessionState?: () => string;
}

interface ServerCastSessionPayload {
  connected?: boolean;
  connecting?: boolean;
  host?: string | null;
  port?: number;
  deviceName?: string | null;
  mediaLoaded?: boolean;
  playerState?: string;
  lastError?: string | null;
}

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    __entencenterCastApiAvailable?: boolean;
    cast?: {
      framework?: CastFrameworkNamespace;
    };
    chrome?: {
      cast?: ChromeCastNamespace;
    };
  }
}

const CAST_SENDER_SCRIPT_SRC =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const MANUAL_CHROMECAST_HOST_KEY = 'entencenter_manual_chromecast_host_v1';

const stateSubscribers = new Set<(snapshot: CastStateSnapshot) => void>();
let castInitialized = false;
let sdkHookAttached = false;
let remoteMediaEl: (HTMLMediaElement & { remote?: RemotePlaybackLike }) | null = null;
let remoteState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let presentationConnection: PresentationConnectionLike | null = null;

// Native Android CastV2 state
let cachedAndroidDevices: DiscoveredCastDevice[] = [];
let androidScanningDevices = false;
let androidConnecting = false;
let androidActiveHost: string | null = null;
let androidActivePort = 8009;
let androidActiveDeviceName: string | null = null;

// Server LAN CastV2 bridge state (works across all browsers & iframes)
let cachedServerDevices: DiscoveredCastDevice[] = [];
let serverScanningDevices = false;
let serverConnecting = false;
let serverActiveHost: string | null = null;
let serverActivePort = 8009;
let serverActiveDeviceName: string | null = null;
let serverMediaLoaded = false;

export function getSavedManualChromecastHost(): string {
  if (typeof window === 'undefined') return '';
  try {
    return (window.localStorage.getItem(MANUAL_CHROMECAST_HOST_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function saveManualChromecastHost(host: string): void {
  if (typeof window === 'undefined') return;
  try {
    const cleaned = host.trim();
    if (cleaned) {
      window.localStorage.setItem(MANUAL_CHROMECAST_HOST_KEY, cleaned);
    } else {
      window.localStorage.removeItem(MANUAL_CHROMECAST_HOST_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function getAndroidCastBridge(): AndroidCastBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { EntenCenterAndroid?: AndroidCastBridge })
    .EntenCenterAndroid;
  if (
    bridge &&
    typeof bridge.startChromecastDiscovery === 'function' &&
    typeof bridge.getChromecastDiscoveryResult === 'function'
  ) {
    return bridge;
  }
  return null;
}

export function isEmbeddedIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getCastApis(): {
  context: CastContextLike;
  framework: CastFrameworkNamespace;
  chromeCast: ChromeCastNamespace;
} | null {
  if (typeof window === 'undefined') return null;
  const framework = window.cast?.framework;
  const chromeCast = window.chrome?.cast;
  if (!framework?.CastContext || !chromeCast?.media) {
    return null;
  }
  return {
    context: framework.CastContext.getInstance(),
    framework,
    chromeCast,
  };
}

function ensureCastContextInitialized(): boolean {
  const apis = getCastApis();
  if (!apis) return false;
  if (!castInitialized) {
    try {
      apis.context.setOptions({
        receiverApplicationId: apis.chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: apis.chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castInitialized = true;
    } catch {
      return false;
    }
  }
  if (!sdkHookAttached) {
    sdkHookAttached = true;
    try {
      apis.context.addEventListener(
        apis.framework.CastContextEventType.CAST_STATE_CHANGED,
        emitSnapshotToSubscribers
      );
      apis.context.addEventListener(
        apis.framework.CastContextEventType.SESSION_STATE_CHANGED,
        emitSnapshotToSubscribers
      );
    } catch {
      // Optional listener errors ignore
    }
  }
  return true;
}

// Frühzeitiger Callback-Hook direkt beim Modul-Import, damit cast_sender.js nie ins Leere läuft
if (typeof window !== 'undefined') {
  const prevHandler = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = (isAvailable: boolean) => {
    window.__entencenterCastApiAvailable = Boolean(isAvailable);
    if (typeof prevHandler === 'function') {
      try {
        prevHandler(isAvailable);
      } catch {
        // Ignore previous callback error
      }
    }
    if (isAvailable) {
      ensureCastContextInitialized();
    }
    emitSnapshotToSubscribers();
  };
}

function supportsBrowserRemotePlayback(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const testVideo = document.createElement('video') as HTMLVideoElement & {
      remote?: RemotePlaybackLike;
    };
    return Boolean(testVideo.remote && typeof testVideo.remote.prompt === 'function');
  } catch {
    return false;
  }
}

function getPresentationRequestCtor():
  | (new (urls: string[]) => { start: () => Promise<PresentationConnectionLike> })
  | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    PresentationRequest?: new (urls: string[]) => {
      start: () => Promise<PresentationConnectionLike>;
    };
  };
  return typeof win.PresentationRequest === 'function' ? win.PresentationRequest : null;
}

function syncAndroidNativeSessionState(): {
  connected: boolean;
  deviceName: string | null;
  host: string | null;
  port: number;
  mediaLoaded: boolean;
} {
  const bridge = getAndroidCastBridge();
  if (!bridge?.getChromecastSessionState) {
    return {
      connected: false,
      deviceName: null,
      host: null,
      port: 8009,
      mediaLoaded: false,
    };
  }
  try {
    const raw = bridge.getChromecastSessionState();
    const parsed = JSON.parse(raw || '{}') as {
      connected?: boolean;
      deviceName?: string | null;
      host?: string | null;
      port?: number;
      mediaLoaded?: boolean;
    };
    if (parsed.connected) {
      androidActiveHost = parsed.host ?? androidActiveHost;
      androidActivePort = parsed.port ?? androidActivePort;
      androidActiveDeviceName = parsed.deviceName ?? androidActiveDeviceName;
    } else if (!androidConnecting) {
      androidActiveHost = null;
      androidActiveDeviceName = null;
    }
    return {
      connected: Boolean(parsed.connected),
      deviceName: parsed.deviceName ?? null,
      host: parsed.host ?? null,
      port: parsed.port ?? 8009,
      mediaLoaded: Boolean(parsed.mediaLoaded),
    };
  } catch {
    return {
      connected: false,
      deviceName: null,
      host: null,
      port: 8009,
      mediaLoaded: false,
    };
  }
}

function syncAndroidDiscoveredDevices(): {
  scanning: boolean;
  devices: DiscoveredCastDevice[];
} {
  const bridge = getAndroidCastBridge();
  if (!bridge?.getChromecastDiscoveryResult) {
    return { scanning: false, devices: cachedAndroidDevices };
  }
  try {
    const raw = bridge.getChromecastDiscoveryResult();
    const parsed = JSON.parse(raw || '{}') as {
      scanning?: boolean;
      devices?: DiscoveredCastDevice[];
    };
    if (Array.isArray(parsed.devices)) {
      cachedAndroidDevices = parsed.devices;
    }
    androidScanningDevices = Boolean(parsed.scanning);
    return {
      scanning: androidScanningDevices,
      devices: cachedAndroidDevices,
    };
  } catch {
    return { scanning: androidScanningDevices, devices: cachedAndroidDevices };
  }
}

function applyServerSessionState(sess?: ServerCastSessionPayload | null): void {
  if (!sess) return;
  if (sess.connected) {
    serverActiveHost = sess.host ?? serverActiveHost;
    serverActivePort = sess.port ?? serverActivePort;
    serverActiveDeviceName = sess.deviceName ?? serverActiveDeviceName;
    serverMediaLoaded = Boolean(sess.mediaLoaded);
  } else if (!serverConnecting) {
    serverActiveHost = null;
    serverActiveDeviceName = null;
    serverMediaLoaded = false;
  }
}

export function readCastSnapshot(): CastStateSnapshot {
  const embedded = isEmbeddedIframe();
  const androidBridge = getAndroidCastBridge();

  if (androidBridge) {
    const sess = syncAndroidNativeSessionState();
    const disc = syncAndroidDiscoveredDevices();
    const castState: CastConnectionState = sess.connected
      ? 'CONNECTED'
      : androidConnecting
        ? 'CONNECTING'
        : 'NOT_CONNECTED';
    return {
      sdkReady: true,
      mode: 'native_android',
      castState,
      deviceName: sess.connected ? sess.deviceName ?? androidActiveDeviceName : null,
      activeHost: sess.connected ? sess.host ?? androidActiveHost : null,
      mediaLoaded: sess.mediaLoaded,
      isEmbeddedFrame: embedded,
      scanningDevices: disc.scanning,
      devices: disc.devices,
    };
  }

  // Aktive Server-LAN-CastV2-Verbindung (funktioniert in jedem Browser/Iframe)
  if (serverActiveHost || serverConnecting) {
    return {
      sdkReady: true,
      mode: 'server_lan',
      castState: serverConnecting ? 'CONNECTING' : 'CONNECTED',
      deviceName: serverActiveDeviceName ?? (serverActiveHost ? `Chromecast (${serverActiveHost})` : null),
      activeHost: serverActiveHost,
      mediaLoaded: serverMediaLoaded,
      isEmbeddedFrame: embedded,
      scanningDevices: serverScanningDevices,
      devices: cachedServerDevices,
    };
  }

  const apis = getCastApis();
  if (apis) {
    ensureCastContextInitialized();
    const castState = apis.context.getCastState();
    const session = apis.context.getCurrentSession();
    const deviceName = session?.getCastDevice?.()?.friendlyName ?? null;
    const mediaLoaded = Boolean(session?.getMediaSession?.());
    return {
      sdkReady: true,
      mode: 'google_cast_sdk',
      castState: castState === 'UNAVAILABLE' ? 'NOT_CONNECTED' : castState,
      deviceName,
      activeHost: null,
      mediaLoaded,
      isEmbeddedFrame: embedded,
      scanningDevices: serverScanningDevices,
      devices: cachedServerDevices,
    };
  }

  if (remoteState === 'connected' || remoteState === 'connecting' || supportsBrowserRemotePlayback()) {
    const mappedState: CastConnectionState =
      remoteState === 'connected'
        ? 'CONNECTED'
        : remoteState === 'connecting'
          ? 'CONNECTING'
          : 'NOT_CONNECTED';
    return {
      sdkReady: true,
      mode: 'remote_playback',
      castState: mappedState,
      deviceName: remoteState === 'connected' ? 'Cast / Wireless Display' : null,
      activeHost: null,
      mediaLoaded: remoteState === 'connected',
      isEmbeddedFrame: embedded,
      scanningDevices: serverScanningDevices,
      devices: cachedServerDevices,
    };
  }

  if (presentationConnection) {
    return {
      sdkReady: true,
      mode: 'browser_ready',
      castState: 'CONNECTED',
      deviceName: 'Chromecast (Browser)',
      activeHost: null,
      mediaLoaded: true,
      isEmbeddedFrame: embedded,
      scanningDevices: serverScanningDevices,
      devices: cachedServerDevices,
    };
  }

  if (cachedServerDevices.length > 0 || serverScanningDevices) {
    return {
      sdkReady: true,
      mode: 'server_lan',
      castState: 'NOT_CONNECTED',
      deviceName: null,
      activeHost: null,
      mediaLoaded: false,
      isEmbeddedFrame: embedded,
      scanningDevices: serverScanningDevices,
      devices: cachedServerDevices,
    };
  }

  return {
    sdkReady: true,
    mode: 'browser_ready',
    castState: 'NOT_CONNECTED',
    deviceName: null,
    activeHost: null,
    mediaLoaded: false,
    isEmbeddedFrame: embedded,
    scanningDevices: serverScanningDevices,
    devices: cachedServerDevices,
  };
}

function emitSnapshotToSubscribers(): void {
  if (stateSubscribers.size === 0) return;
  const snap = readCastSnapshot();
  stateSubscribers.forEach((cb) => {
    try {
      cb(snap);
    } catch {
      // Subscriber errors ignore
    }
  });
}

function preloadCastSdkBackground(): void {
  if (typeof document === 'undefined' || getAndroidCastBridge() || isEmbeddedIframe()) {
    return;
  }
  if (getCastApis()) {
    ensureCastContextInitialized();
    return;
  }
  const existing = document.querySelector<HTMLScriptElement>(
    'script[src*="gstatic.com/cv/js/sender/v1/cast_sender.js"]'
  );
  if (!existing) {
    const script = document.createElement('script');
    script.src = CAST_SENDER_SCRIPT_SRC;
    script.async = true;
    document.head.appendChild(script);
  }
}

async function fetchServerCastStatusOnce(): Promise<void> {
  if (typeof window === 'undefined' || getAndroidCastBridge()) return;
  try {
    const resp = await fetch(resolveNasUrl('/api/nas/chromecast/status'), {
      method: 'GET',
      headers: buildOptionalAuthHeaders(),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as ServerCastSessionPayload;
    applyServerSessionState(data);
    emitSnapshotToSubscribers();
  } catch {
    // ignore transient status errors
  }
}

export function subscribeCastState(onChange: (snapshot: CastStateSnapshot) => void): () => void {
  stateSubscribers.add(onChange);
  preloadCastSdkBackground();
  if (getCastApis()) {
    ensureCastContextInitialized();
  }
  void fetchServerCastStatusOnce();
  onChange(readCastSnapshot());

  return () => {
    stateSubscribers.delete(onChange);
  };
}

function readStoredAuthTokenForStream(): string | null {
  try {
    const raw =
      window.localStorage.getItem('entencenter_nas_session_v1') ??
      window.localStorage.getItem('marcente_nas_session_v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === 'string' && !parsed.token.startsWith('local-fallback-')
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function buildOptionalAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = readStoredAuthTokenForStream();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {}),
  };
}

function appendTokenQueryIfNeeded(url: string, token: string | null): string {
  if (!token || !url.includes('/api/nas/') || /[?&]token=/.test(url)) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function inferCastMimeType(item: NasMediaItem): string {
  if (item.uploadedMimeType && item.uploadedMimeType !== 'application/octet-stream') {
    return item.uploadedMimeType;
  }
  const candidate = item.mediaUrl || item.uploadedFileName || item.nasPath || '';
  const cleanCandidate = candidate.split('?')[0];
  const inferred = inferMimeTypeFromPath(cleanCandidate);
  if (inferred && inferred !== 'application/octet-stream') {
    return inferred;
  }
  if (item.kind === 'music') return 'audio/mpeg';
  if (item.kind === 'image') return 'image/jpeg';
  return 'video/mp4';
}

function resolveCastContentUrl(item: NasMediaItem): string {
  const token = readStoredAuthTokenForStream();

  // 1. Direkte oder bereits aufgelöste Stream-URL bevorzugen
  let candidate = (item.mediaUrl || '').trim();
  if (!candidate) {
    const buf = readLocalOnboardingBuffer();
    const conn = buf?.nasConnection;
    if (conn?.host && (conn.secret || conn.fritzPassword)) {
      const targetProto = conn.protocol ?? 'fritz_upnp';
      candidate =
        resolvePlayableNasMediaUrl(
          item,
          {
            protocol: targetProto,
            host: cleanHostOnly(conn.host),
            port: String(sanitizeNasPortForProtocol(targetProto, conn.port, conn.useTls)),
            shareOrPath: conn.shareOrPath ?? (targetProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
            username: conn.username ?? '',
            password: conn.secret ?? conn.fritzPassword ?? '',
            fritzPassword: conn.fritzPassword,
            useTls: Boolean(conn.useTls),
          },
          token
        ) || '';
    }
  }

  if (candidate) {
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      return appendTokenQueryIfNeeded(candidate, token);
    }
    if (candidate.startsWith('/')) {
      return appendTokenQueryIfNeeded(resolveNasUrl(candidate), token);
    }
  }

  // 2. Direkte HTTP-URL im nasPath
  if (item.nasPath.startsWith('http://') || item.nasPath.startsWith('https://')) {
    return item.nasPath;
  }

  // 3. Reale Server-Stream-Endpunkte (/api/nas/media/:id/stream oder /api/nas/storage/stream)
  if (item.uploadedFileName) {
    return appendTokenQueryIfNeeded(
      resolveNasUrl(`/api/nas/media/${encodeURIComponent(item.id)}/stream`),
      token
    );
  }
  if (item.nasPath && !item.nasPath.startsWith('/medien/')) {
    const cleanPath = item.nasPath.replace(/^smb:\/\/[^/]+/i, '').replace(/\\/g, '/');
    const storagePath = `/api/nas/storage/stream?mediaId=${encodeURIComponent(
      item.id
    )}&path=${encodeURIComponent(cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`)}`;
    return appendTokenQueryIfNeeded(resolveNasUrl(storagePath), token);
  }

  return '';
}

function resolveCastPosterUrl(coverUrl: string): string {
  if (!coverUrl) return '';
  if (coverUrl.startsWith('data:') || coverUrl.startsWith('blob:')) return '';
  if (coverUrl.startsWith('http://') || coverUrl.startsWith('https://')) {
    if (coverUrl.includes('app.entencenter.local')) return '';
    return coverUrl;
  }
  if (coverUrl.startsWith('/api/') || coverUrl.startsWith('/uploads/')) {
    return resolveNasUrl(coverUrl);
  }
  const origin = getEffectiveNasOrigin();
  if (!origin || origin.includes('app.entencenter.local')) return '';
  return `${origin}${coverUrl.startsWith('/') ? '' : '/'}${coverUrl}`;
}

async function ensureCastSdkLoaded(timeoutMs = 2400): Promise<boolean> {
  if (getCastApis()) {
    return ensureCastContextInitialized();
  }
  if (typeof document === 'undefined' || isEmbeddedIframe()) {
    return false;
  }

  preloadCastSdkBackground();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getCastApis()) {
      return ensureCastContextInitialized();
    }
    await new Promise((r) => window.setTimeout(r, 120));
  }
  return Boolean(getCastApis() && ensureCastContextInitialized());
}

async function waitForMediaReadyForRemote(mediaEl: HTMLMediaElement): Promise<void> {
  if (mediaEl.readyState >= 1) return;
  if (!mediaEl.currentSrc && !mediaEl.getAttribute('src')) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      mediaEl.removeEventListener('loadedmetadata', finish);
      mediaEl.removeEventListener('canplay', finish);
      mediaEl.removeEventListener('error', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, 1800);
    mediaEl.addEventListener('loadedmetadata', finish, { once: true });
    mediaEl.addEventListener('canplay', finish, { once: true });
    mediaEl.addEventListener('error', finish, { once: true });
    try {
      if (mediaEl.networkState === 0) {
        mediaEl.load();
      }
    } catch {
      // ignore load() errors
    }
  });
}

function buildCastItemMetadata(item: NasMediaItem, currentMinutes: number) {
  const title = item.currentEpisode
    ? `${item.title} · S${String(item.currentEpisode.season).padStart(2, '0')}E${String(
        item.currentEpisode.episode
      ).padStart(2, '0')}`
    : item.title;
  const subtitle = item.currentEpisode
    ? item.currentEpisode.title
    : `${item.genre} · ${item.year}`;
  const posterUrl = resolveCastPosterUrl(item.coverUrl);
  return {
    contentType: inferCastMimeType(item),
    title,
    subtitle,
    posterUrl,
    currentTimeSec: Math.max(0, Math.round(currentMinutes * 60)),
  };
}

export async function discoverChromecastDevices(
  manualHost?: string | null
): Promise<DiscoveredCastDevice[]> {
  const cleanedManualHost = manualHost?.trim() || '';
  if (cleanedManualHost) {
    saveManualChromecastHost(cleanedManualHost);
  }

  const bridge = getAndroidCastBridge();
  if (bridge?.startChromecastDiscovery && bridge.getChromecastDiscoveryResult) {
    androidScanningDevices = true;
    emitSnapshotToSubscribers();
    bridge.startChromecastDiscovery();

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      await new Promise((r) => window.setTimeout(r, 220));
      const disc = syncAndroidDiscoveredDevices();
      emitSnapshotToSubscribers();
      if (!disc.scanning) {
        if (cleanedManualHost && !disc.devices.some((d) => d.host === cleanedManualHost)) {
          return [
            ...disc.devices,
            {
              id: `cast-${cleanedManualHost}-8009`,
              name: `Chromecast (${cleanedManualHost})`,
              model: 'Manuelle IP',
              host: cleanedManualHost,
              port: 8009,
              source: 'manual',
            },
          ];
        }
        return disc.devices;
      }
    }
    androidScanningDevices = false;
    emitSnapshotToSubscribers();
    return cachedAndroidDevices;
  }

  // Server-LAN-Discovery (funktioniert in allen Browsern, Mobile & Embedded Frames)
  serverScanningDevices = true;
  emitSnapshotToSubscribers();
  try {
    const effectiveManualHost = cleanedManualHost || getSavedManualChromecastHost();
    const qs = effectiveManualHost ? `?host=${encodeURIComponent(effectiveManualHost)}` : '';
    const resp = await fetch(resolveNasUrl(`/api/nas/chromecast/discover${qs}`), {
      method: 'GET',
      headers: buildOptionalAuthHeaders(),
    });
    if (!resp.ok) {
      serverScanningDevices = false;
      emitSnapshotToSubscribers();
      return cachedServerDevices;
    }
    const data = (await resp.json()) as {
      devices?: DiscoveredCastDevice[];
      session?: ServerCastSessionPayload;
    };
    if (Array.isArray(data.devices)) {
      cachedServerDevices = data.devices;
    }
    applyServerSessionState(data.session);
    return cachedServerDevices;
  } catch {
    return cachedServerDevices;
  } finally {
    serverScanningDevices = false;
    emitSnapshotToSubscribers();
  }
}

export async function connectChromecastDevice(
  device: DiscoveredCastDevice,
  item: NasMediaItem,
  currentMinutes: number
): Promise<{ ok: boolean; deviceName?: string | null; message: string }> {
  const cleanDeviceHost = (device.host || '').trim();
  if (!cleanDeviceHost) {
    return {
      ok: false,
      message: 'Bitte gib eine gültige Chromecast-IP-Adresse (z. B. 192.168.178.42) ein.',
    };
  }
  saveManualChromecastHost(cleanDeviceHost);

  const contentUrl = resolveCastContentUrl(item);
  if (!contentUrl) {
    return {
      ok: false,
      message:
        'Für diesen Katalogeintrag liegt noch keine streambare Datei-URL vor. Bitte zuerst eine NAS-Mediendatei wählen oder den Ordner-Scan aktualisieren.',
    };
  }

  const meta = buildCastItemMetadata(item, currentMinutes);
  const bridge = getAndroidCastBridge();

  if (bridge) {
    const payload = JSON.stringify({
      host: cleanDeviceHost,
      port: device.port || 8009,
      deviceName: device.name,
      contentUrl,
      contentType: meta.contentType,
      title: meta.title,
      subtitle: meta.subtitle,
      posterUrl: meta.posterUrl,
      currentTimeSec: meta.currentTimeSec,
    });

    androidConnecting = true;
    androidActiveHost = cleanDeviceHost;
    androidActivePort = device.port || 8009;
    androidActiveDeviceName = device.name;
    emitSnapshotToSubscribers();

    try {
      let result: {
        ok?: boolean;
        deviceName?: string | null;
        message?: string;
        running?: boolean;
      } = {};

      if (bridge.startConnectAndCastMedia && bridge.getChromecastConnectResult) {
        bridge.startConnectAndCastMedia(payload);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          await new Promise((r) => window.setTimeout(r, 200));
          const raw = bridge.getChromecastConnectResult();
          result = JSON.parse(raw || '{}') as typeof result;
          if (!result.running) break;
        }
      } else if (bridge.connectAndCastMedia) {
        const raw = bridge.connectAndCastMedia(payload);
        result = JSON.parse(raw || '{}') as typeof result;
      }

      androidConnecting = false;
      if (result.ok) {
        androidActiveDeviceName = result.deviceName ?? device.name;
        emitSnapshotToSubscribers();
        return {
          ok: true,
          deviceName: androidActiveDeviceName,
          message:
            result.message || `Mit ${androidActiveDeviceName} verbunden und Wiedergabe gestartet.`,
        };
      }

      androidActiveHost = null;
      androidActiveDeviceName = null;
      emitSnapshotToSubscribers();
      return {
        ok: false,
        message: result.message || 'Chromecast-Wiedergabe konnte nicht gestartet werden.',
      };
    } catch (err) {
      androidConnecting = false;
      androidActiveHost = null;
      androidActiveDeviceName = null;
      emitSnapshotToSubscribers();
      return {
        ok: false,
        message:
          err instanceof Error ? err.message : 'Chromecast-Verbindung fehlgeschlagen.',
      };
    }
  }

  // Server-LAN CastV2 Bridge für alle Browser (Chrome, Edge, Firefox, Safari, Mobile, Iframe)
  serverConnecting = true;
  serverActiveHost = cleanDeviceHost;
  serverActivePort = device.port || 8009;
  serverActiveDeviceName = device.name || `Chromecast (${cleanDeviceHost})`;
  emitSnapshotToSubscribers();

  try {
    const resp = await fetch(resolveNasUrl('/api/nas/chromecast/connect'), {
      method: 'POST',
      headers: buildOptionalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        host: cleanDeviceHost,
        port: device.port || 8009,
        deviceName: device.name,
        contentUrl,
        contentType: meta.contentType,
        title: meta.title,
        subtitle: meta.subtitle,
        posterUrl: meta.posterUrl,
        currentTimeSec: meta.currentTimeSec,
      }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      deviceName?: string;
      message?: string;
      error?: string;
      session?: ServerCastSessionPayload;
    };

    serverConnecting = false;
    if (resp.ok && data.ok) {
      serverActiveDeviceName = data.deviceName ?? device.name;
      serverMediaLoaded = true;
      applyServerSessionState(data.session);
      emitSnapshotToSubscribers();
      return {
        ok: true,
        deviceName: serverActiveDeviceName,
        message:
          data.message || `Mit ${serverActiveDeviceName} verbunden und Wiedergabe gestartet.`,
      };
    }

    serverActiveHost = null;
    serverActiveDeviceName = null;
    serverMediaLoaded = false;
    emitSnapshotToSubscribers();
    return {
      ok: false,
      message:
        data.message ||
        data.error ||
        `Chromecast unter ${cleanDeviceHost}:${device.port || 8009} konnte nicht gestartet werden.`,
    };
  } catch (err) {
    serverConnecting = false;
    serverActiveHost = null;
    serverActiveDeviceName = null;
    serverMediaLoaded = false;
    emitSnapshotToSubscribers();
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Verbindung zur Chromecast-WLAN-Bridge fehlgeschlagen.',
    };
  }
}

function attachRemotePlaybackListeners(
  mediaEl: HTMLMediaElement & { remote?: RemotePlaybackLike }
): void {
  const remote = mediaEl.remote;
  if (!remote) return;
  if (remoteMediaEl !== mediaEl) {
    remoteMediaEl = mediaEl;
    const syncState = () => {
      remoteState = remote.state;
      emitSnapshotToSubscribers();
    };
    remote.addEventListener('connecting', syncState);
    remote.addEventListener('connect', syncState);
    remote.addEventListener('disconnect', syncState);
  }
  remoteState = remote.state;
}

export async function requestChromecastSession(
  item: NasMediaItem,
  currentMinutes: number,
  options?: {
    device?: DiscoveredCastDevice | null;
    mediaElement?: HTMLMediaElement | null;
    manualHost?: string | null;
  }
): Promise<{ ok: boolean; deviceName?: string | null; message: string }> {
  // 0. Explizites Gerät gewählt (oder manuelle IP übergeben)
  if (options?.device) {
    return connectChromecastDevice(options.device, item, currentMinutes);
  }
  if (options?.manualHost?.trim()) {
    const host = options.manualHost.trim();
    return connectChromecastDevice(
      {
        id: `cast-${host}-8009`,
        name: `Chromecast (${host})`,
        host,
        port: 8009,
        source: 'manual',
      },
      item,
      currentMinutes
    );
  }

  // 1. Native Android Bridge (mDNS + SSDP + CastV2 direkt im lokalen WLAN)
  const androidBridge = getAndroidCastBridge();
  if (androidBridge) {
    const devices = await discoverChromecastDevices();
    if (devices.length === 0) {
      return {
        ok: false,
        message:
          'Kein Chromecast- oder Google-TV-Gerät im WLAN gefunden. Du kannst unten direkt die IP-Adresse deines Fernsehers eingeben.',
      };
    }

    if (devices.length === 1) {
      return connectChromecastDevice(devices[0], item, currentMinutes);
    }

    return {
      ok: false,
      message: `${devices.length} Chromecast-Geräte gefunden — bitte gewünschtes Gerät unten auswählen.`,
    };
  }

  // 2. Desktop Chrome / Edge Google Cast Sender SDK (wenn außerhalb von Iframes verfügbar)
  const sdkReady = await ensureCastSdkLoaded(2400);
  const apis = getCastApis();
  if (sdkReady && apis && ensureCastContextInitialized()) {
    try {
      await apis.context.requestSession();
      const session = apis.context.getCurrentSession();
      const deviceName = session?.getCastDevice?.()?.friendlyName ?? 'Chromecast';
      const loaded = await loadItemOnChromecast(item, currentMinutes);
      emitSnapshotToSubscribers();
      return {
        ok: loaded,
        deviceName,
        message: loaded
          ? `Mit ${deviceName} verbunden und Titel übertragen.`
          : `Mit ${deviceName} verbunden, aber für diesen Titel fehlt eine direkte Stream-URL.`,
      };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'cancel') {
        return { ok: false, message: 'Chromecast-Auswahl abgebrochen.' };
      }
      // Bei receiver_unavailable / SDK-Fehler nahtlos auf Remote Playback / LAN-Bridge weiterfallen
    }
  }

  // 3. HTML5 Remote Playback API (Chrome Android, Chrome/Edge Desktop inkl. Iframes)
  const mediaEl = options?.mediaElement as
    | (HTMLMediaElement & { remote?: RemotePlaybackLike })
    | null
    | undefined;
  if (mediaEl?.remote && typeof mediaEl.remote.prompt === 'function') {
    try {
      await waitForMediaReadyForRemote(mediaEl);
      attachRemotePlaybackListeners(mediaEl);
      remoteState = 'connecting';
      emitSnapshotToSubscribers();
      await mediaEl.remote.prompt();
      remoteState = mediaEl.remote.state;
      emitSnapshotToSubscribers();
      return {
        ok: true,
        deviceName: 'Cast / Wireless Display',
        message: 'Cast-Geräteauswahl über den Browser gestartet.',
      };
    } catch (err) {
      remoteState = mediaEl.remote.state;
      emitSnapshotToSubscribers();
      const domErr = err as { name?: string };
      if (domErr?.name === 'NotAllowedError' || domErr?.name === 'AbortError') {
        return { ok: false, message: 'Chromecast-Auswahl abgebrochen.' };
      }
      // InvalidStateError / NotSupportedError / NotFoundError -> nahtlos weiter zu Presentation API / Server-LAN-Bridge
    }
  }

  // 4. Browser Presentation API Cast Picker (Chrome / Edge Fallback ohne Cast-Extension)
  const PresentationCtor = getPresentationRequestCtor();
  if (PresentationCtor && !isEmbeddedIframe()) {
    try {
      const req = new PresentationCtor(['https://google.com/cast/#__castAppId__=CC1AD845']);
      const conn = await req.start();
      presentationConnection = conn;
      emitSnapshotToSubscribers();
      return {
        ok: true,
        deviceName: 'Chromecast (Browser)',
        message: 'Chromecast-Empfänger über den Browser verbunden.',
      };
    } catch (err) {
      const domErr = err as { name?: string };
      if (domErr?.name === 'NotAllowedError' || domErr?.name === 'AbortError') {
        return { ok: false, message: 'Chromecast-Auswahl abgebrochen.' };
      }
      // Ansonsten nahtlos weiter zur Server-LAN-Bridge
    }
  }

  // 5. Server-LAN CastV2 Bridge (funktioniert in JEDEM Browser, Tablet, Firefox, Safari & Vorschau-Iframe)
  const savedHost = getSavedManualChromecastHost();
  const lanDevices = await discoverChromecastDevices(savedHost || undefined);
  if (lanDevices.length === 1) {
    return connectChromecastDevice(lanDevices[0], item, currentMinutes);
  }
  if (lanDevices.length > 1) {
    return {
      ok: false,
      message: `${lanDevices.length} Chromecast-Geräte im WLAN gefunden — wähle unten dein Gerät zum Abspielen aus.`,
    };
  }

  return {
    ok: false,
    message:
      'Kein Chromecast automatisch im WLAN geantwortet. Gib unten die lokale IP-Adresse deines Chromecast/Google TV (z. B. 192.168.178.42) ein und klicke auf „Per IP verbinden“.',
  };
}

export async function loadItemOnChromecast(
  item: NasMediaItem,
  currentMinutes: number
): Promise<boolean> {
  const androidBridge = getAndroidCastBridge();
  if (androidBridge && androidActiveHost) {
    const res = await connectChromecastDevice(
      {
        id: `cast-${androidActiveHost}-${androidActivePort}`,
        name: androidActiveDeviceName || 'Chromecast',
        host: androidActiveHost,
        port: androidActivePort,
      },
      item,
      currentMinutes
    );
    return res.ok;
  }

  if (serverActiveHost) {
    const res = await connectChromecastDevice(
      {
        id: `cast-${serverActiveHost}-${serverActivePort}`,
        name: serverActiveDeviceName || 'Chromecast',
        host: serverActiveHost,
        port: serverActivePort,
      },
      item,
      currentMinutes
    );
    return res.ok;
  }

  const apis = getCastApis();
  if (!apis) return false;
  const session = apis.context.getCurrentSession();
  if (!session) return false;

  const contentUrl = resolveCastContentUrl(item);
  if (!contentUrl) return false;
  const meta = buildCastItemMetadata(item, currentMinutes);
  const mediaInfo = new apis.chromeCast.media.MediaInfo(contentUrl, meta.contentType);
  mediaInfo.streamType = apis.chromeCast.media.StreamType.BUFFERED;

  const metadata = new apis.chromeCast.media.GenericMediaMetadata();
  metadata.metadataType = apis.chromeCast.media.MetadataType.GENERIC;
  metadata.title = meta.title;
  metadata.subtitle = `${meta.subtitle} · ${item.nasPath}`;
  if (meta.posterUrl) {
    metadata.images = [new apis.chromeCast.Image(meta.posterUrl)];
  }
  mediaInfo.metadata = metadata;
  mediaInfo.customData = {
    mediaId: item.id,
    nasPath: item.nasPath,
  };

  const request = new apis.chromeCast.media.LoadRequest(mediaInfo);
  request.autoplay = true;
  request.currentTime = meta.currentTimeSec;

  try {
    await session.loadMedia(request);
    return true;
  } catch {
    return false;
  }
}

export function syncChromecastPlayback(
  action: 'play' | 'pause' | 'seek',
  seekMinutesOrSeconds?: number,
  isExactSeconds = false
): void {
  const seekSec =
    typeof seekMinutesOrSeconds === 'number'
      ? Math.max(0, isExactSeconds ? seekMinutesOrSeconds : Math.round(seekMinutesOrSeconds * 60))
      : undefined;

  const androidBridge = getAndroidCastBridge();
  if (androidBridge?.controlChromecastMedia && androidActiveHost) {
    try {
      androidBridge.controlChromecastMedia(
        JSON.stringify({
          action,
          ...(seekSec !== undefined ? { currentTimeSec: seekSec } : {}),
        })
      );
    } catch {
      // Ignore bridge sync error
    }
    return;
  }

  if (serverActiveHost) {
    void fetch(resolveNasUrl('/api/nas/chromecast/control'), {
      method: 'POST',
      headers: buildOptionalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        action,
        ...(seekSec !== undefined ? { currentTimeSec: seekSec } : {}),
      }),
    }).catch(() => {
      // ignore transient control errors
    });
    return;
  }

  const apis = getCastApis();
  if (!apis) return;
  const mediaSession = apis.context.getCurrentSession()?.getMediaSession?.();
  if (!mediaSession) return;

  try {
    if (action === 'play') {
      mediaSession.play?.(new apis.chromeCast.media.PlayRequest());
    } else if (action === 'pause') {
      mediaSession.pause?.(new apis.chromeCast.media.PauseRequest());
    } else if (action === 'seek' && typeof seekSec === 'number') {
      const seekReq = new apis.chromeCast.media.SeekRequest();
      seekReq.currentTime = seekSec;
      mediaSession.seek?.(seekReq);
    }
  } catch {
    // Synchronisationsfehler still abfangen
  }
}

export function disconnectChromecast(): void {
  const androidBridge = getAndroidCastBridge();
  if (androidBridge?.controlChromecastMedia) {
    try {
      androidBridge.controlChromecastMedia(JSON.stringify({ action: 'disconnect' }));
    } catch {
      // Ignore
    }
    androidActiveHost = null;
    androidActiveDeviceName = null;
    androidConnecting = false;
    emitSnapshotToSubscribers();
    return;
  }

  if (serverActiveHost || serverConnecting) {
    serverActiveHost = null;
    serverActiveDeviceName = null;
    serverMediaLoaded = false;
    serverConnecting = false;
    void fetch(resolveNasUrl('/api/nas/chromecast/control'), {
      method: 'POST',
      headers: buildOptionalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'disconnect' }),
    }).catch(() => {
      // ignore
    });
  }

  const apis = getCastApis();
  if (apis) {
    try {
      apis.context.endCurrentSession(true);
    } catch {
      // Trennungsfehler ignorieren
    }
  }

  if (presentationConnection) {
    try {
      presentationConnection.terminate?.();
      presentationConnection.close?.();
    } catch {
      // ignore
    }
    presentationConnection = null;
  }

  if (remoteState !== 'disconnected') {
    remoteState = 'disconnected';
    remoteMediaEl = null;
  }
  emitSnapshotToSubscribers();
}
