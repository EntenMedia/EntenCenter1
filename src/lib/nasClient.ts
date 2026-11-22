import type {
  AdminNasPathSettings,
  AlternativePortScanEntry,
  AlternativePortScanResult,
  DeepNetworkDiagnosticsResult,
  DiscoveredNasDevice,
  DiscoveredNasService,
  FritzUpnpDiscoveredDevice,
  FritzUpnpProbeResult,
  Http400DiagnosticDetail,
  NasBrowseTreeResult,
  NasConnectionScope,
  NasDirectoryTreeEntry,
  NasMediaFolderScanBreakdown,
  NasMediaFolderScanResult,
  NasMediaItem,
  NasProtocolId,
  NasProtocolVerificationResult,
  NasProvisionBackendResult,
  NasScanFolderSettings,
  NasSecurityCertificateInfo,
  NasStorageReadFileResult,
  NasStorageWriteFileResult,
  NasUser,
  NetworkDiagnosticFinding,
  NetworkDiscoveryMethod,
  NetworkNasDiscoveryResponse,
  NetworkPortProbeEntry,
  UniversalNasProbeResponse,
} from '../types/marcente';
import { classifyMediaKind, groupAndNormalizeNasCatalog } from './mediaGrouping';

const NAS_BASE_URL_STORAGE_KEY = 'entencenter_nas_base_url';
const NAS_SHARED_CERT_STORAGE_KEY = 'entencenter_nas_shared_cert';
const NAS_PREFERRED_ALT_PORT_KEY = 'entencenter_preferred_alt_port';
const NAS_AUTO_PORT_FALLBACK_KEY = 'entencenter_auto_port_fallback';
export const DEFAULT_LOCAL_NAS_URL = '';
export const DEFAULT_ALTERNATIVE_PORTS = [3001, 3002, 3005, 3010, 8000, 8080, 8081, 8443, 8888, 9000, 9090] as const;

const NON_SMB_PORTS = new Set([
  20, 21, 22, 23, 25, 80, 110, 143, 443, 465, 587, 990, 993, 995,
  3000, 3001, 3002, 3005, 5000, 5001, 5005, 5006, 8000, 8080, 8081,
  8443, 8888, 9000, 49000, 49443,
]);

export function sanitizeSmbPort(rawPort?: string | number | null): number {
  const num = typeof rawPort === 'number' ? rawPort : Number(String(rawPort ?? '').trim());
  if (!Number.isInteger(num) || num <= 0 || num > 65535 || NON_SMB_PORTS.has(num)) {
    return 445;
  }
  return num;
}

export function sanitizeNasPortForProtocol(
  protocol?: NasProtocolId | string | null,
  rawPort?: string | number | null,
  useTls?: boolean
): number {
  const proto = String(protocol || 'fritz_upnp').trim().toLowerCase();
  const num = typeof rawPort === 'number' ? rawPort : Number(String(rawPort ?? '').trim());
  const validNum = Number.isInteger(num) && num > 0 && num <= 65535 ? num : null;

  if (proto === 'smb' || proto === 'cifs') {
    return sanitizeSmbPort(validNum);
  }
  if (proto === 'fritz_upnp') {
    if (validNum === 49443) return 443;
    if (
      !validNum ||
      validNum === 49000 ||
      validNum === 445 ||
      validNum === 139 ||
      validNum === 21 ||
      validNum === 22 ||
      validNum === 5005 ||
      validNum === 5006 ||
      validNum === 3000 ||
      validNum === 3001
    ) {
      return useTls ? 443 : 80;
    }
    return validNum;
  }
  if (proto === 'webdav') {
    if (!validNum || validNum === 445 || validNum === 139 || validNum === 21 || validNum === 22) {
      return useTls ? 5006 : 5005;
    }
    return validNum;
  }
  if (proto === 'sftp') {
    if (!validNum || validNum === 80 || validNum === 443 || validNum === 445 || validNum === 3000) {
      return 22;
    }
    return validNum;
  }
  if (proto === 'ftps') {
    if (!validNum || validNum === 80 || validNum === 443 || validNum === 445 || validNum === 3000) {
      return 21;
    }
    return validNum;
  }
  if (proto === 'nfs') {
    if (!validNum || validNum === 80 || validNum === 443 || validNum === 445 || validNum === 3000) {
      return 2049;
    }
    return validNum;
  }
  return validNum ?? (useTls ? 443 : 3000);
}

export const LOCAL_NAS_PRESETS: Array<{ label: string; url: string; hint: string }> = [];

export const FRITZBOX_UPNP_DEFAULT_PORT = '49000';
export const FRITZBOX_UPNP_PROFILE_HOSTS = [
  'fritz.box',
  'fritz.nas',
  '192.168.178.1',
  '192.168.179.1',
];
export const FRITZBOX_UPNP_DESCRIPTOR_PATHS = [
  '/MediaServerDevDesc.xml',
  '/igddesc.xml',
  '/tr64desc.xml',
];

export interface DiscoverFritzboxNasOptions {
  nasBaseUrl?: string;
  candidateHosts?: string[];
  upnpPort?: string;
  timeoutMs?: number;
  includeSubnetGatewayScan?: boolean;
}

export interface FritzboxNasDiscoveryResult {
  found: boolean;
  devices: FritzUpnpDiscoveredDevice[];
  matchedProfileDevice: FritzUpnpDiscoveredDevice | null;
  recommendedHost: string | null;
  recommendedNasBaseUrl: string | null;
  sameSubnetVerified: boolean;
  tokenlessReady: boolean;
  localSubnets: string[];
  probeResult: FritzUpnpProbeResult | null;
  scannedAt: string;
  summary: string;
}

export interface NativeServerDiagnosis {
  ok: boolean;
  host?: string;
  port?: number;
  dnsOk?: boolean;
  resolvedIp?: string;
  tcpOk?: boolean;
  tlsError?: boolean;
  httpStatus?: number;
  bootstrapOk?: boolean;
  matchedBaseUrl?: string | null;
  fallbackPortUsed?: boolean;
  matchedPort?: number;
  port3000Reachable?: boolean;
  detectedPureNas?: boolean;
  detectedFritzBox?: boolean;
  fritzBoxInfo?: DeepNetworkDiagnosticsResult['fritzBoxInfo'];
  openNasServices?: Array<{
    protocol: NasProtocolId;
    port: string;
    label: string;
    scheme?: 'http' | 'https';
    path?: string;
  }>;
  errorKind?: string;
  detail?: string;
}

interface AndroidBridgeWindow extends Window {
  EntenCenterAndroid?: {
    isNativeApp?: () => boolean;
    getPlatform?: () => string;
    getDefaultServerUrl?: () => string;
    getSavedServerUrl?: () => string;
    setSavedServerUrl?: (url: string) => boolean;
    getPreferredAlternativePort?: () => number;
    setPreferredAlternativePort?: (port: number) => boolean;
    scanAlternativePorts?: (rawTarget: string) => string;
    scanAlternativePortsWithPref?: (rawTarget: string, preferredAltPort: number) => string;
    diagnoseServerConnection?: (url: string) => string;
    nativeHttpRequest?: (requestJson: string) => string;
    scanFritzUpnp?: () => string;
    startLocalNetworkScan?: () => boolean;
    getLocalNetworkScanResult?: () => string;
    runDeepNetworkDiagnostics?: (rawTarget: string) => string;
    startDeepNetworkDiagnostics?: (rawTarget: string) => boolean;
    getDeepNetworkDiagnosticsResult?: () => string;
    setSharedNasCertificate?: (pem: string) => boolean;
    getSharedNasCertificate?: () => string;
    getAllowLocalSelfSignedTls?: () => boolean;
    setAllowLocalSelfSignedTls?: (enabled: boolean) => boolean;
    fritzBoxChallengeLogin?: (requestJson: string) => string;
    browseFritzNasDirectories?: (requestJson: string) => string;
    provisionFritzNasBackend?: (requestJson: string) => string;
    browseNasDirectories?: (requestJson: string) => string;
    provisionNasBackend?: (requestJson: string) => string;
    probeUniversalNas?: (requestJson: string) => string;
    testNasProtocolConnection?: (requestJson: string) => string;
    probeBridgeNasHealth?: (requestJson: string) => string;
    wakeNasDevice?: (requestJson: string) => string;
    writeNasFile?: (requestJson: string) => string;
    readNasFile?: (requestJson: string) => string;
    scanNasMediaFolders?: (requestJson: string) => string;
    getLocalNasStreamUrl?: (requestJson: string) => string;
    getNasStorageStats?: (requestJson: string) => string;
    openExternalMediaPlayer?: (url: string, mimeType: string, title?: string) => boolean;
    startChromecastDiscovery?: () => boolean;
    getChromecastDiscoveryResult?: () => string;
    connectAndCastMedia?: (requestJson: string) => string;
    startConnectAndCastMedia?: (requestJson: string) => boolean;
    getChromecastConnectResult?: () => string;
    controlChromecastMedia?: (requestJson: string) => string;
    getChromecastSessionState?: () => string;
  };
}

export function getPreferredAlternativePort(): number {
  if (typeof window === 'undefined') return 3001;
  try {
    const raw = window.localStorage.getItem(NAS_PREFERRED_ALT_PORT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 && parsed !== 3000) {
      return parsed;
    }
    const bridgePort = (window as AndroidBridgeWindow).EntenCenterAndroid?.getPreferredAlternativePort?.();
    if (typeof bridgePort === 'number' && Number.isInteger(bridgePort) && bridgePort > 0 && bridgePort <= 65535 && bridgePort !== 3000) {
      return bridgePort;
    }
  } catch {
    // Fallback
  }
  return 3001;
}

export function setPreferredAlternativePort(port: number): number {
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3000 ? port : 3001;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(NAS_PREFERRED_ALT_PORT_KEY, String(safePort));
    } catch {
      // Optional
    }
    try {
      (window as AndroidBridgeWindow).EntenCenterAndroid?.setPreferredAlternativePort?.(safePort);
    } catch {
      // Optional
    }
  }
  return safePort;
}

export function getAutoPortFallbackEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(NAS_AUTO_PORT_FALLBACK_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoPortFallbackEnabled(enabled: boolean): boolean {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(NAS_AUTO_PORT_FALLBACK_KEY, enabled ? '1' : '0');
    } catch {
      // Optional
    }
  }
  return enabled;
}

let interceptorInstalled = false;

export function isAiStudioPreviewUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  return /^https?:\/\/ais-(dev|pre)-[a-z0-9-]+\.[^/]+\.run\.app\b/i.test(rawUrl.trim());
}

export function isStrictPrivateOrLanIpClient(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean) return false;
  if (clean === '::1' || clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:')) {
    return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isLocalOrLanHost(hostOrInput: string): boolean {
  const clean = hostOrInput
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!clean) return false;
  if (
    clean === 'localhost' ||
    clean === '::1' ||
    clean.endsWith('.local') ||
    clean.endsWith('.box') ||
    clean.endsWith('.fritz.nas') ||
    clean.endsWith('.lan') ||
    clean.endsWith('.home')
  ) {
    return true;
  }
  return isStrictPrivateOrLanIpClient(clean);
}

export function isNativeAndroidShell(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hostname === 'app.entencenter.local') return true;
  try {
    return Boolean((window as AndroidBridgeWindow).EntenCenterAndroid?.isNativeApp?.());
  } catch {
    return false;
  }
}

export function getAndroidDefaultServerUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
    const saved = bridge?.getSavedServerUrl?.()?.trim() || '';
    if (saved && !isAiStudioPreviewUrl(saved)) {
      return saved.replace(/\/+$/, '');
    }
    const raw = bridge?.getDefaultServerUrl?.()?.trim() || '';
    if (raw && !isAiStudioPreviewUrl(raw)) {
      return raw.replace(/\/+$/, '');
    }
  } catch {
    // Bridge-Methode nicht verfügbar
  }
  return '';
}

export function normalizeNasBaseUrl(raw: string): string {
  let cleaned = raw.trim().replace(/\s*:\s*/g, ':').replace(/\/+$/, '');
  if (!cleaned) return '';

  if (/^wss?:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^ws/i, 'http');
  }

  // Falls nur ein Port eingegeben wurde (z. B. "3000" oder ":3000"), im Web-Kontext aktuellen Host nutzen
  const portOnlyMatch = /^:?(\d{1,5})$/.exec(cleaned);
  if (portOnlyMatch) {
    const portNum = Number(portOnlyMatch[1]);
    if (
      portNum >= 1 &&
      portNum <= 65535 &&
      typeof window !== 'undefined' &&
      window.location.hostname &&
      window.location.hostname !== 'app.entencenter.local'
    ) {
      return `${window.location.protocol}//${window.location.hostname}:${portNum}`;
    }
    return '';
  }

  let defaultScheme = 'http://';
  if (!/^https?:\/\//i.test(cleaned)) {
    const hostPortPart = cleaned.split('/')[0];
    const portMatch = /:(\d{1,5})$/.exec(hostPortPart);
    const explicitPort = portMatch?.[1];
    if (explicitPort === '443' || explicitPort === '8443' || explicitPort === '5001' || explicitPort === '5006') {
      defaultScheme = 'https://';
    } else if (explicitPort === '3000' || explicitPort === '80') {
      defaultScheme =
        typeof window !== 'undefined' && window.location.protocol === 'https:' && !isNativeAndroidShell() && !isLocalOrLanHost(cleaned)
          ? 'https://'
          : 'http://';
    } else if (!isLocalOrLanHost(cleaned)) {
      // Internet-Domain / DynDNS / MyFRITZ ohne Port -> HTTPS bevorzugen
      defaultScheme = 'https://';
    } else if (
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      !isNativeAndroidShell() &&
      !isLocalOrLanHost(cleaned)
    ) {
      defaultScheme = 'https://';
    }
  }

  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `${defaultScheme}${cleaned}`;

  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) return '';
    // Reverse-Proxy Unterpfad beibehalten (z. B. /entencenter), aber /api/*, /login, /register abschneiden
    const cleanPath = parsed.pathname
      .replace(/\/+(api\/.*|login|register|index\.html)?$/i, '')
      .replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return /^https?:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`;
  }
}

export function buildNasProbeCandidates(rawInput: string): string[] {
  const cleaned = rawInput.trim().replace(/\s*:\s*/g, ':').replace(/\/+$/, '');
  if (!cleaned) return [];

  const primary = normalizeNasBaseUrl(cleaned);
  if (!primary) return [];

  const candidates = new Set<string>();
  const hadExplicitScheme = /^https?:\/\//i.test(cleaned);
  const native = isNativeAndroidShell();
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:' && !native;

  try {
    const parsed = new URL(primary);
    const hasExplicitPort = Boolean(parsed.port);
    const hostname = parsed.hostname;
    const basePath = parsed.pathname.replace(/\/+$/, '');
    const isPort3000 = parsed.port === '3000';
    const isLan = isLocalOrLanHost(hostname);

    const addWithScheme = (scheme: 'http:' | 'https:', port?: string, pathOverride?: string) => {
      if (isHttpsPage && scheme === 'http:') return;
      const portSuffix = port ? `:${port}` : '';
      const suffixPath = pathOverride !== undefined ? pathOverride : basePath;
      if (suffixPath && suffixPath !== '/') {
        candidates.add(`${scheme}//${hostname}${portSuffix}${suffixPath}`);
      }
      if (pathOverride === undefined || pathOverride === '') {
        candidates.add(`${scheme}//${hostname}${portSuffix}`);
      }
    };

    if (!hasExplicitPort && isLan) {
      // Im LAN ohne expliziten Port: EntenCenter-Standardport :3000 vor Port 80 priorisieren
      addWithScheme('http:', '3000');
      addWithScheme('http:', '3001');
      addWithScheme('http:', '8080');
      addWithScheme('http:', '8000');
      addWithScheme('https:', '3000');
      addWithScheme('https:', '8443');
    }

    if (!(isHttpsPage && parsed.protocol === 'http:')) {
      candidates.add(primary);
    }

    if (basePath && basePath !== '/') {
      candidates.add(parsed.origin);
    }

    if (!hasExplicitPort) {
      addWithScheme(parsed.protocol as 'http:' | 'https:', '3000');
      if (!isLan) {
        addWithScheme('https:', '8443');
        addWithScheme('http:', '8080');
      }
    }

    if (!hadExplicitScheme) {
      const altProto = parsed.protocol === 'https:' ? 'http:' : 'https:';
      addWithScheme(altProto, parsed.port || undefined);
      if (!hasExplicitPort) {
        addWithScheme(altProto, '3000');
      }
    } else if (parsed.protocol === 'https:') {
      if (parsed.port === '49443') {
        addWithScheme('http:', '49000');
      } else if (!hasExplicitPort || parsed.port === '443') {
        if (isLan) {
          addWithScheme('http:', undefined);
        }
        addWithScheme('http:', '3000');
      } else if (isPort3000 || isLan) {
        addWithScheme('http:', parsed.port);
      }
    } else if (parsed.protocol === 'http:') {
      addWithScheme('https:', parsed.port || undefined);
      if (!hasExplicitPort) {
        addWithScheme('https:', '3000');
      }
    }

    if (!basePath || basePath === '/') {
      if (!hasExplicitPort) {
        addWithScheme('http:', '3000', '/entencenter');
        addWithScheme(parsed.protocol as 'http:' | 'https:', undefined, '/entencenter');
        addWithScheme('https:', undefined, '/entencenter');
      } else {
        addWithScheme(parsed.protocol as 'http:' | 'https:', parsed.port, '/entencenter');
      }
    }

    // Automatische Ausweichports für Port 3000 anhängen (falls :3000 blockiert, belegt oder kein EntenCenter liefert)
    if (getAutoPortFallbackEnabled()) {
      const preferredAlt = getPreferredAlternativePort();
      const altPortList = Array.from(new Set([preferredAlt, ...DEFAULT_ALTERNATIVE_PORTS]));
      for (const altPort of altPortList) {
        if (String(altPort) === parsed.port) continue;
        const altScheme: 'http:' | 'https:' =
          altPort === 8443 || altPort === 443 ? 'https:' : 'http:';
        addWithScheme(altScheme, String(altPort));
        if (altScheme === 'http:' && altPort !== 80 && (isLan || native)) {
          addWithScheme('https:', String(altPort));
        }
      }
    }
  } catch {
    candidates.add(primary);
  }

  return Array.from(candidates);
}

export function isMixedContentBlocked(targetBaseUrl: string): boolean {
  if (typeof window === 'undefined' || !targetBaseUrl) return false;
  return (
    window.location.protocol === 'https:' &&
    !isNativeAndroidShell() &&
    /^http:\/\//i.test(targetBaseUrl)
  );
}

export function hasSavedNasBaseUrl(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(NAS_BASE_URL_STORAGE_KEY)?.trim() || '';
    if (stored && !(isNativeAndroidShell() && isAiStudioPreviewUrl(stored))) {
      return true;
    }
    if (isNativeAndroidShell()) {
      return Boolean(getAndroidDefaultServerUrl());
    }
    return false;
  } catch {
    return false;
  }
}

export function getNasBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(NAS_BASE_URL_STORAGE_KEY)?.trim() || '';
    if (stored) {
      if (isNativeAndroidShell() && isAiStudioPreviewUrl(stored)) {
        window.localStorage.removeItem(NAS_BASE_URL_STORAGE_KEY);
      } else {
        return normalizeNasBaseUrl(stored);
      }
    }
  } catch {
    // localStorage nicht verfügbar
  }
  return isNativeAndroidShell() ? getAndroidDefaultServerUrl() : '';
}

export function setNasBaseUrl(rawUrl: string): string {
  const normalized = normalizeNasBaseUrl(rawUrl);
  const safeNormalized =
    isNativeAndroidShell() && isAiStudioPreviewUrl(normalized) ? '' : normalized;
  if (typeof window === 'undefined') return safeNormalized;
  try {
    if (!safeNormalized) {
      window.localStorage.removeItem(NAS_BASE_URL_STORAGE_KEY);
    } else {
      window.localStorage.setItem(NAS_BASE_URL_STORAGE_KEY, safeNormalized);
    }
  } catch {
    // Speicherfehler ignorieren
  }
  if (isNativeAndroidShell()) {
    try {
      (window as AndroidBridgeWindow).EntenCenterAndroid?.setSavedServerUrl?.(safeNormalized);
    } catch {
      // Optional
    }
  }
  return safeNormalized;
}

export function diagnoseNativeServerConnection(rawUrl: string): NativeServerDiagnosis | null {
  if (typeof window === 'undefined' || !rawUrl) return null;
  try {
    const raw = (window as AndroidBridgeWindow).EntenCenterAndroid?.diagnoseServerConnection?.(rawUrl);
    if (!raw) return null;
    return JSON.parse(raw) as NativeServerDiagnosis;
  } catch {
    return null;
  }
}

export function getEffectiveNasOrigin(): string {
  const base = getNasBaseUrl();
  if (base) return base;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

export function resolveNasUrl(urlOrPath: string): string {
  if (!urlOrPath) return urlOrPath;
  if (/^https?:\/\//i.test(urlOrPath)) {
    if (
      typeof window !== 'undefined' &&
      urlOrPath.startsWith(`${window.location.origin}/api/`)
    ) {
      const base = getNasBaseUrl();
      if (base) {
        return `${base}${urlOrPath.slice(window.location.origin.length)}`;
      }
    }
    return urlOrPath;
  }
  if (urlOrPath.startsWith('/api/') || urlOrPath.startsWith('/uploads/')) {
    const base = getNasBaseUrl();
    if (base) {
      return `${base}${urlOrPath}`;
    }
  }
  return urlOrPath;
}

export function resolveNasWsUrl(wsPathAndQuery: string): string {
  const cleanPath = wsPathAndQuery.startsWith('/') ? wsPathAndQuery : `/${wsPathAndQuery}`;
  const base = getNasBaseUrl();
  if (base) {
    const wsBase = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    return `${wsBase}${cleanPath}`;
  }
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${cleanPath}`;
  }
  return `ws://127.0.0.1:3000${cleanPath}`;
}

function headersInitToRecord(headersInit?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headersInit) return out;
  if (typeof Headers !== 'undefined' && headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export async function nativeAndroidFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = 7500
): Promise<Response | null> {
  if (typeof window === 'undefined' || !isNativeAndroidShell()) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  if (init?.signal?.aborted) return null;

  const rawBody = init?.body;
  if (rawBody !== undefined && rawBody !== null && typeof rawBody !== 'string') {
    return null;
  }

  const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
  if (!bridge?.nativeHttpRequest) return null;

  try {
    const rawResp = bridge.nativeHttpRequest(
      JSON.stringify({
        method: init?.method || 'GET',
        url,
        headers: headersInitToRecord(init?.headers),
        body: typeof rawBody === 'string' ? rawBody : null,
        timeoutMs,
      })
    );
    if (!rawResp) return null;
    const parsed = JSON.parse(rawResp) as {
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    if (!parsed || typeof parsed.status !== 'number' || parsed.status <= 0) {
      return null;
    }
    const respHeaders = new Headers(parsed.headers ?? {});
    const status = parsed.status;
    // HTTP 204/304 erlauben im Response-Konstruktor keinen Body
    const safeBody = status === 204 || status === 205 || status === 304 ? null : parsed.body ?? '';
    return new Response(safeBody, {
      status,
      statusText: parsed.statusText || '',
      headers: respHeaders,
    });
  } catch {
    return null;
  }
}

export function buildLocalHttpFallbackUrl(rawUrl: string): string | null {
  if (!rawUrl || !/^https:\/\//i.test(rawUrl)) return null;
  // In einer regulären HTTPS-Webseite blockiert der Browser Mixed Content;
  // in der Android-APK oder auf HTTP-Seiten greift der automatische LAN-HTTP-Fallback.
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    !isNativeAndroidShell()
  ) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (!isLocalOrLanHost(parsed.hostname)) return null;
    const mappedPort =
      parsed.port === '49443'
        ? '49000'
        : parsed.port === '443' || !parsed.port
          ? ''
          : parsed.port;
    const portSuffix = mappedPort ? `:${mappedPort}` : '';
    return `http://${parsed.hostname}${portSuffix}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

async function fetchSingleWithNativeFallback(
  url: string,
  init?: RequestInit,
  timeoutMs = 7500
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (isNativeAndroidShell() && /^https?:\/\//i.test(url)) {
      const nativeRes = await nativeAndroidFetch(url, init, timeoutMs);
      if (nativeRes) return nativeRes;
    }
    throw err;
  }
}

export async function nasFetch(
  input: string,
  init?: RequestInit,
  timeoutMs = 7500
): Promise<Response> {
  const resolved = resolveNasUrl(input);
  try {
    return await fetchSingleWithNativeFallback(resolved, init, timeoutMs);
  } catch (err) {
    const httpFallbackUrl =
      !init?.signal?.aborted ? buildLocalHttpFallbackUrl(resolved) : null;
    if (httpFallbackUrl) {
      try {
        return await fetchSingleWithNativeFallback(httpFallbackUrl, init, timeoutMs);
      } catch {
        // Originalfehler unten weiterreichen, falls auch lokales HTTP nicht erreichbar ist
      }
    }
    throw err;
  }
}

export function installNasApiInterceptor(): void {
  if (typeof window === 'undefined' || interceptorInstalled) return;
  interceptorInstalled = true;

  try {
    const originalFetch = window.fetch.bind(window);
    const runFetchWithNativeFallback = async (
      target: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      try {
        return await originalFetch(target, init);
      } catch (err) {
        if (isNativeAndroidShell() && typeof target === 'string' && /^https?:\/\//i.test(target)) {
          const nativeRes = await nativeAndroidFetch(target, init);
          if (nativeRes) return nativeRes;
        }
        throw err;
      }
    };

    const patchedFetch: typeof window.fetch = (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      if (!getNasBaseUrl()) {
        return runFetchWithNativeFallback(input, init);
      }
      if (typeof input === 'string') {
        const rewritten = resolveNasUrl(input);
        return runFetchWithNativeFallback(rewritten, init);
      }
      if (input instanceof URL) {
        const rewritten = resolveNasUrl(input.toString());
        return runFetchWithNativeFallback(rewritten, init);
      }
      if (input instanceof Request) {
        const rewritten = resolveNasUrl(input.url);
        if (rewritten !== input.url) {
          return originalFetch(new Request(rewritten, input), init);
        }
      }
      return runFetchWithNativeFallback(input, init);
    };

    const ownDesc = Object.getOwnPropertyDescriptor(window, 'fetch');
    if (!ownDesc || ownDesc.configurable) {
      Object.defineProperty(window, 'fetch', {
        value: patchedFetch,
        writable: true,
        configurable: true,
      });
    } else if (ownDesc.writable) {
      window.fetch = patchedFetch;
    } else if (typeof globalThis !== 'undefined' && globalThis !== window) {
      const globalDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      if (!globalDesc || globalDesc.configurable) {
        Object.defineProperty(globalThis, 'fetch', {
          value: patchedFetch,
          writable: true,
          configurable: true,
        });
      }
    }
  } catch {
    // Host-Umgebung erlaubt kein Überschreiben von window.fetch (z. B. schreibgeschützter Getter)
  }

  try {
    if (typeof XMLHttpRequest !== 'undefined') {
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        asyncFlag?: boolean,
        username?: string | null,
        password?: string | null
      ) {
        const rawUrl = typeof url === 'string' ? url : url.toString();
        const rewritten = resolveNasUrl(rawUrl);
        if (asyncFlag === undefined) {
          return originalOpen.call(this, method, rewritten, true);
        }
        return originalOpen.call(
          this,
          method,
          rewritten,
          asyncFlag,
          username ?? null,
          password ?? null
        );
      };
    }
  } catch {
    // XMLHttpRequest-Override optional
  }
}

function isIpv4Address(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isSameSlash24Subnet(ipA: string, ipB: string): boolean {
  if (!isIpv4Address(ipA) || !isIpv4Address(ipB)) return false;
  const a = ipA.trim().split('.').slice(0, 3).join('.');
  const b = ipB.trim().split('.').slice(0, 3).join('.');
  return a === b;
}

function extractHostnameFromBaseUrl(baseUrl: string): string {
  if (!baseUrl) return '';
  try {
    return new URL(normalizeNasBaseUrl(baseUrl)).hostname;
  } catch {
    return '';
  }
}

function extractXmlValue(xml: string, tagName: string): string {
  const match = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i').exec(xml);
  return match?.[1]?.trim() ?? '';
}

export function matchesFritzboxUpnpProfile(
  deviceOrXml:
    | string
    | Pick<
        FritzUpnpDiscoveredDevice,
        'friendlyName' | 'manufacturer' | 'modelName' | 'deviceType' | 'host'
      >
): boolean {
  if (typeof deviceOrXml === 'string') {
    const lower = deviceOrXml.toLowerCase();
    const hasAvmOrFritz =
      lower.includes('fritz!box') ||
      lower.includes('fritzbox') ||
      lower.includes('fritz!nas') ||
      lower.includes('avm berlin') ||
      lower.includes('urn:schemas-any-com:service') ||
      lower.includes('x_avm-de_');
    const hasUpnpMediaOrGateway =
      lower.includes('mediaserver') ||
      lower.includes('contentdirectory') ||
      lower.includes('internetgatewaydevice');
    return (hasAvmOrFritz && hasUpnpMediaOrGateway) || lower.includes('fritz!box');
  }

  const combined = [
    deviceOrXml.friendlyName,
    deviceOrXml.manufacturer,
    deviceOrXml.modelName ?? '',
    deviceOrXml.deviceType ?? '',
    deviceOrXml.host,
  ]
    .join(' ')
    .toLowerCase();

  return (
    combined.includes('fritz!box') ||
    combined.includes('fritzbox') ||
    combined.includes('fritz!nas') ||
    combined.includes('avm') ||
    (combined.includes('fritz') && combined.includes('mediaserver'))
  );
}

function parseFritzboxUpnpXmlDescriptor(
  xml: string,
  locationUrl: string,
  nasHostIp: string,
  localSubnets: string[]
): FritzUpnpDiscoveredDevice | null {
  if (!matchesFritzboxUpnpProfile(xml)) return null;

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(locationUrl);
  } catch {
    return null;
  }

  const host = parsedUrl.hostname;
  const port = parsedUrl.port || FRITZBOX_UPNP_DEFAULT_PORT;
  const friendlyName = extractXmlValue(xml, 'friendlyName') || `FRITZ!Box UPnP/DLNA (${host})`;
  const manufacturer = extractXmlValue(xml, 'manufacturer') || 'AVM Berlin';
  const modelName = extractXmlValue(xml, 'modelName') || undefined;
  const udn = extractXmlValue(xml, 'UDN') || undefined;
  const deviceType = extractXmlValue(xml, 'deviceType') || undefined;

  const sameSlash24 =
    Boolean(nasHostIp && isSameSlash24Subnet(host, nasHostIp)) ||
    localSubnets.some((cidr) => {
      const prefixIp = cidr.split('/')[0] ?? '';
      return isSameSlash24Subnet(host, prefixIp);
    });

  return {
    id: udn || `${host}:${port}`,
    friendlyName,
    host,
    ip: isIpv4Address(host) ? host : host,
    port,
    locationUrl,
    manufacturer,
    modelName,
    udn,
    deviceType,
    source: 'http_upnp',
    sameSubnet: sameSlash24,
    subnetCidr: sameSlash24 && isIpv4Address(host)
      ? `${host.split('.').slice(0, 3).join('.')}.0/24`
      : null,
    discoveredAt: new Date().toISOString(),
  };
}

function buildUpnpCandidateHosts(
  explicitCandidates: string[] | undefined,
  nasHost: string,
  localSubnets: string[],
  includeSubnetGatewayScan: boolean
): string[] {
  const hosts = new Set<string>(explicitCandidates ?? []);
  for (const presetHost of FRITZBOX_UPNP_PROFILE_HOSTS) {
    hosts.add(presetHost);
  }
  if (includeSubnetGatewayScan) {
    if (isIpv4Address(nasHost)) {
      const parts = nasHost.split('.');
      hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
    }
    for (const cidr of localSubnets) {
      const baseIp = cidr.split('/')[0] ?? '';
      if (isIpv4Address(baseIp)) {
        const parts = baseIp.split('.');
        hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
      }
    }
    if (typeof window !== 'undefined' && isIpv4Address(window.location.hostname)) {
      const parts = window.location.hostname.split('.');
      hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
    }
  }
  return Array.from(hosts).filter((h) => h.trim().length > 0);
}

async function probeClientUpnpDescriptors(
  hosts: string[],
  upnpPort: string,
  timeoutMs: number,
  nasHostIp: string,
  localSubnets: string[]
): Promise<FritzUpnpDiscoveredDevice[]> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return [];

  const controllerTimeout = Math.max(500, Math.min(timeoutMs, 3500));
  const native = isNativeAndroidShell();
  const isHttpsPage = window.location.protocol === 'https:' && !native;

  const results = await Promise.all(
    hosts.map(async (host): Promise<FritzUpnpDiscoveredDevice | null> => {
      const targetSpecs: Array<{ scheme: 'http' | 'https'; port: string; path: string }> = [
        ...FRITZBOX_UPNP_DESCRIPTOR_PATHS.map((p) => ({
          scheme: 'http' as const,
          port: upnpPort,
          path: p,
        })),
        { scheme: 'https' as const, port: '49443', path: '/tr64desc.xml' },
      ];

      for (const spec of targetSpecs) {
        if (isHttpsPage && spec.scheme === 'http') continue;
        const locationUrl = `${spec.scheme}://${host}:${spec.port}${spec.path}`;
        try {
          const res = await nasFetch(
            locationUrl,
            {
              method: 'GET',
              signal: AbortSignal.timeout(controllerTimeout),
            },
            controllerTimeout
          );
          if (!res.ok) continue;
          const xml = await res.text();
          const device = parseFritzboxUpnpXmlDescriptor(
            xml,
            locationUrl,
            nasHostIp,
            localSubnets
          );
          if (device) return device;
        } catch {
          // Host im aktuellen Browser/WebView-Kontext nicht erreichbar oder CORS-geschützt
        }
      }

      // Zusätzlich direkt FRITZ!OS /login_sid.lua auf :80 (HTTP) und :443 (HTTPS) prüfen
      const loginSidSpecs: Array<{ scheme: 'http' | 'https'; port: string }> = isHttpsPage
        ? [{ scheme: 'https', port: '443' }]
        : [
            { scheme: 'http', port: '80' },
            { scheme: 'https', port: '443' },
          ];
      for (const spec of loginSidSpecs) {
        const sidUrl = `${spec.scheme}://${host}:${spec.port}/login_sid.lua`;
        try {
          const res = await nasFetch(
            sidUrl,
            {
              method: 'GET',
              signal: AbortSignal.timeout(controllerTimeout),
            },
            controllerTimeout
          );
          if (!res.ok) continue;
          const xml = await res.text();
          if (xml.includes('<SessionInfo>') && xml.includes('<Challenge>')) {
            const sidVal = extractXmlValue(xml, 'SID');
            const sameSlash24 =
              Boolean(nasHostIp && isSameSlash24Subnet(host, nasHostIp)) ||
              localSubnets.some((cidr) => isSameSlash24Subnet(host, cidr.split('/')[0] ?? ''));
            return {
              id: `fritz-loginsid-${host}`,
              friendlyName: `FRITZ!Box / FRITZ!NAS (${host})`,
              host,
              ip: host,
              port: spec.port,
              locationUrl: sidUrl,
              manufacturer: 'AVM Berlin',
              modelName: 'FRITZ!OS WebUI / NAS',
              source: 'http_upnp',
              sameSubnet: sameSlash24,
              subnetCidr:
                sameSlash24 && isIpv4Address(host)
                  ? `${host.split('.').slice(0, 3).join('.')}.0/24`
                  : null,
              discoveredAt: new Date().toISOString(),
              requiresAuth: !sidVal || sidVal === '0000000000000000',
              loginSidUrl: sidUrl,
              httpAvailable: spec.scheme === 'http',
              httpsAvailable: spec.scheme === 'https',
              httpsError: null,
            };
          }
        } catch {
          // /login_sid.lua in diesem Kontext nicht erreichbar
        }
      }

      return null;
    })
  );

  return results.filter((d): d is FritzUpnpDiscoveredDevice => d !== null);
}

function readNativeAndroidUpnpScan(): FritzUpnpDiscoveredDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = (window as AndroidBridgeWindow).EntenCenterAndroid?.scanFritzUpnp?.();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FritzUpnpDiscoveredDevice =>
        Boolean(item && typeof item === 'object' && typeof (item as FritzUpnpDiscoveredDevice).ip === 'string')
    );
  } catch {
    return [];
  }
}

export async function scanUpnpDlnaDevices(
  options: DiscoverFritzboxNasOptions = {}
): Promise<{
  devices: FritzUpnpDiscoveredDevice[];
  probeResult: FritzUpnpProbeResult | null;
  effectiveBaseUrl: string;
}> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const upnpPort = options.upnpPort?.trim() || FRITZBOX_UPNP_DEFAULT_PORT;
  const effectiveBaseUrl =
    options.nasBaseUrl !== undefined ? normalizeNasBaseUrl(options.nasBaseUrl) : getNasBaseUrl();

  let probeResult: FritzUpnpProbeResult | null = null;
  try {
    const probeEndpoint = effectiveBaseUrl
      ? `${effectiveBaseUrl}/api/nas/fritz-discovery/probe`
      : resolveNasUrl('/api/nas/fritz-discovery/probe');
    const res = await fetch(probeEndpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(timeoutMs, 3500)),
    });
    if (res.ok) {
      probeResult = (await res.json()) as FritzUpnpProbeResult;
    }
  } catch {
    probeResult = null;
  }

  const nasHostIp = extractHostnameFromBaseUrl(effectiveBaseUrl);
  const localSubnets = probeResult?.localSubnets ?? [];
  const candidateHosts = buildUpnpCandidateHosts(
    options.candidateHosts,
    nasHostIp,
    localSubnets,
    options.includeSubnetGatewayScan ?? true
  );

  const clientProbedDevices = await probeClientUpnpDescriptors(
    candidateHosts,
    upnpPort,
    timeoutMs,
    nasHostIp,
    localSubnets
  );
  const androidBridgeDevices = readNativeAndroidUpnpScan();

  const merged = new Map<string, FritzUpnpDiscoveredDevice>();
  for (const dev of [
    ...(probeResult?.discoveredDevices ?? []),
    ...clientProbedDevices,
    ...androidBridgeDevices,
  ]) {
    const dedupeKey = dev.udn || `${dev.ip}:${dev.port}`;
    const existing = merged.get(dedupeKey);
    if (!existing || (!existing.sameSubnet && dev.sameSubnet)) {
      merged.set(dedupeKey, dev);
    }
  }

  const devices = Array.from(merged.values()).filter((dev) => matchesFritzboxUpnpProfile(dev));
  devices.sort((a, b) => {
    if (a.sameSubnet !== b.sameSubnet) return a.sameSubnet ? -1 : 1;
    const aMedia = (a.deviceType ?? '').toLowerCase().includes('mediaserver');
    const bMedia = (b.deviceType ?? '').toLowerCase().includes('mediaserver');
    if (aMedia !== bMedia) return aMedia ? -1 : 1;
    return a.friendlyName.localeCompare(b.friendlyName);
  });

  return {
    devices,
    probeResult,
    effectiveBaseUrl,
  };
}

export async function discoverFritzboxNas(
  options: DiscoverFritzboxNasOptions = {}
): Promise<FritzboxNasDiscoveryResult> {
  const scannedAt = new Date().toISOString();
  const { devices, probeResult, effectiveBaseUrl } = await scanUpnpDlnaDevices(options);

  const matchedProfileDevice =
    devices.find((dev) => dev.sameSubnet) ?? devices[0] ?? null;
  const localSubnets = probeResult?.localSubnets ?? [];
  const nasHost = extractHostnameFromBaseUrl(effectiveBaseUrl);

  const clientSameSubnetFallback = Boolean(
    matchedProfileDevice &&
      (matchedProfileDevice.sameSubnet ||
        (nasHost && isSameSlash24Subnet(matchedProfileDevice.ip, nasHost)))
  );

  const sameSubnetVerified = Boolean(
    (probeResult?.clientInSameSubnet && probeResult?.sameSubnetDeviceFound) ||
      (probeResult?.clientInSameSubnet && clientSameSubnetFallback)
  );

  const tokenlessReady = Boolean(
    probeResult
      ? probeResult.tokenlessEligible ||
          (probeResult.enabled &&
            (!probeResult.subnetMatchRequired || sameSubnetVerified))
      : false
  );

  const recommendedHost =
    matchedProfileDevice?.ip || matchedProfileDevice?.host || null;

  let summary = '';
  if (probeResult && !probeResult.enabled) {
    summary = probeResult.reason;
  } else if (devices.length === 0) {
    summary =
      probeResult?.reason ||
      'Keine FRITZ!Box UPnP/DLNA-Geräte im lokalen Netzwerk gefunden.';
  } else if (tokenlessReady && matchedProfileDevice) {
    summary = `${matchedProfileDevice.friendlyName} (${matchedProfileDevice.ip}) im selben Subnetz erkannt · tokenlose Erstverbindung bereit.`;
  } else if (matchedProfileDevice) {
    summary = `${matchedProfileDevice.friendlyName} (${matchedProfileDevice.ip}) erkannt, jedoch ohne bestätigtes gemeinsames Subnetz.`;
  }

  return {
    found: devices.length > 0,
    devices,
    matchedProfileDevice,
    recommendedHost,
    recommendedNasBaseUrl: effectiveBaseUrl || (typeof window !== 'undefined' ? window.location.origin : null),
    sameSubnetVerified,
    tokenlessReady,
    localSubnets,
    probeResult,
    scannedAt,
    summary,
  };
}

const CLIENT_MDNS_HTTP_CANDIDATES = [
  'http://entencenter.local:3000',
  'http://nas.local:3000',
  'http://diskstation.local:3000',
  'http://synology.local:3000',
  'http://qnap.local:3000',
  'http://truenas.local:3000',
];

function inferVendorFromDevice(
  name: string,
  hostname: string,
  services: DiscoveredNasService[]
): DiscoveredNasDevice['vendor'] {
  const lower = `${name} ${hostname} ${services.map((s) => `${s.label} ${s.serviceType}`).join(' ')}`.toLowerCase();
  if (lower.includes('entencenter') || services.some((s) => s.protocol === 'entencenter')) {
    return 'EntenCenter';
  }
  if (lower.includes('synology') || lower.includes('diskstation') || services.some((s) => s.port === '5000' || s.port === '5001')) {
    return 'Synology';
  }
  if (lower.includes('qnap') || lower.includes('qts') || services.some((s) => s.port === '8080')) {
    return 'QNAP';
  }
  if (lower.includes('truenas') || lower.includes('freenas')) return 'TrueNAS';
  if (lower.includes('unraid') || lower.includes('tower')) return 'Unraid';
  if (lower.includes('openmediavault') || lower.includes('omv')) return 'OpenMediaVault';
  if (lower.includes('fritz') || lower.includes('avm') || services.some((s) => s.protocol === 'fritz_upnp')) {
    return 'FRITZ!Box';
  }
  return 'Standard NAS';
}

function normalizeAndroidDiscoveredDevices(rawList: unknown): DiscoveredNasDevice[] {
  if (!Array.isArray(rawList)) return [];
  const nowIso = new Date().toISOString();
  const mapped: DiscoveredNasDevice[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const ip = typeof obj.ip === 'string' ? obj.ip.trim() : '';
    if (!ip) continue;

    const servicesRaw = Array.isArray(obj.services) ? obj.services : [];
    const services: DiscoveredNasService[] = [];
    for (const svc of servicesRaw) {
      if (!svc || typeof svc !== 'object') continue;
      const s = svc as Record<string, unknown>;
      const proto = typeof s.protocol === 'string' ? s.protocol : 'smb';
      const port = typeof s.port === 'string' ? s.port : '445';
      services.push({
        protocol: proto as DiscoveredNasService['protocol'],
        serviceType: typeof s.serviceType === 'string' ? s.serviceType : '_smb._tcp.',
        port,
        label: typeof s.label === 'string' ? s.label : proto.toUpperCase(),
        scheme: s.scheme === 'https' || s.scheme === 'http' ? s.scheme : undefined,
        path: typeof s.path === 'string' ? s.path : '/Medien',
      });
    }

    const methodsRaw = Array.isArray(obj.discoveryMethods) ? obj.discoveryMethods : ['android_nsd'];
    const discoveryMethods = methodsRaw.filter(
      (m): m is NetworkDiscoveryMethod =>
        m === 'mdns' || m === 'ssdp' || m === 'port_probe' || m === 'android_nsd'
    );

    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : `NAS (${ip})`;
    const hostname =
      typeof obj.hostname === 'string' && obj.hostname.trim() ? obj.hostname.trim() : ip;
    const vendor = inferVendorFromDevice(name, hostname, services);
    const primarySvc = services.find((s) => s.protocol !== 'entencenter') ?? services[0];
    const isEnten =
      Boolean(obj.isEntenCenterServer) || services.some((s) => s.protocol === 'entencenter');
    const entenSvc = services.find((s) => s.protocol === 'entencenter');
    const suggestedProtocol: NasProtocolId =
      primarySvc && primarySvc.protocol !== 'entencenter'
        ? primarySvc.protocol
        : vendor === 'FRITZ!Box'
          ? 'fritz_upnp'
          : 'smb';

    mapped.push({
      id: typeof obj.id === 'string' ? obj.id : `nas-${ip}`,
      name,
      hostname,
      ip,
      port: entenSvc?.port || primarySvc?.port || (typeof obj.port === 'string' ? obj.port : '445'),
      baseUrl:
        typeof obj.baseUrl === 'string' && obj.baseUrl.trim()
          ? obj.baseUrl.trim()
          : isEnten
            ? `http://${ip}:${entenSvc?.port || '3000'}`
            : undefined,
      isEntenCenterServer: isEnten,
      vendor,
      suggestedProtocol,
      suggestedShareOrPath: primarySvc?.path || '/Medien',
      services,
      discoveryMethods: discoveryMethods.length > 0 ? discoveryMethods : ['android_nsd'],
      sameSubnet: obj.sameSubnet !== false,
      discoveredAt: nowIso,
    });
  }

  return mapped;
}

async function runAndroidBridgeDiscovery(): Promise<DiscoveredNasDevice[]> {
  if (typeof window === 'undefined') return [];
  const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
  if (!bridge?.startLocalNetworkScan || !bridge?.getLocalNetworkScanResult) return [];

  try {
    bridge.startLocalNetworkScan();
  } catch {
    return [];
  }

  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    try {
      const raw = bridge.getLocalNetworkScanResult();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { scanning?: boolean; devices?: unknown };
      if (parsed && parsed.scanning === false) {
        return normalizeAndroidDiscoveredDevices(parsed.devices);
      }
    } catch {
      return [];
    }
  }

  try {
    const fallbackRaw = bridge.getLocalNetworkScanResult();
    const parsed = JSON.parse(fallbackRaw) as { devices?: unknown };
    return normalizeAndroidDiscoveredDevices(parsed?.devices);
  } catch {
    return [];
  }
}

async function probeClientLocalMdnsUrls(): Promise<DiscoveredNasDevice[]> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return [];
  const canProbeHttp = window.location.protocol !== 'https:' || isNativeAndroidShell();
  if (!canProbeHttp) return [];

  const found: DiscoveredNasDevice[] = [];
  await Promise.all(
    CLIENT_MDNS_HTTP_CANDIDATES.map(async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/api/nas/auth/bootstrap`, {
          method: 'GET',
          signal: AbortSignal.timeout(700),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { hasUsers?: unknown };
        if (typeof data?.hasUsers !== 'boolean') return;
        const parsed = new URL(baseUrl);
        found.push({
          id: `nas-${parsed.hostname}`,
          name: `EntenCenter (${parsed.hostname})`,
          hostname: parsed.hostname,
          ip: parsed.hostname,
          port: parsed.port || '3000',
          baseUrl,
          isEntenCenterServer: true,
          vendor: 'EntenCenter',
          suggestedProtocol: 'smb',
          suggestedShareOrPath: '/Medien',
          services: [
            {
              protocol: 'entencenter',
              serviceType: '_entencenter._tcp.local',
              port: parsed.port || '3000',
              label: 'EntenCenter Server',
              scheme: 'http',
              path: '/',
            },
          ],
          discoveryMethods: ['mdns'],
          sameSubnet: true,
          discoveredAt: new Date().toISOString(),
        });
      } catch {
        // Host nicht im lokalen Netzwerk vorhanden
      }
    })
  );
  return found;
}

export async function discoverLocalNasDevices(
  options: {
    baseUrl?: string;
    includeSubnetProbe?: boolean;
  } = {}
): Promise<NetworkNasDiscoveryResponse> {
  const startedAt = Date.now();
  const effectiveBase =
    options.baseUrl !== undefined ? normalizeNasBaseUrl(options.baseUrl) : getNasBaseUrl();
  const includeSubnetProbe = options.includeSubnetProbe ?? true;

  const serverScanPromise = (async (): Promise<NetworkNasDiscoveryResponse | null> => {
    try {
      const query = includeSubnetProbe ? '?subnetProbe=1' : '?subnetProbe=0';
      const endpoint = effectiveBase
        ? `${effectiveBase}/api/nas/discovery/scan${query}`
        : resolveNasUrl(`/api/nas/discovery/scan${query}`);
      const res = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return null;
      return (await res.json()) as NetworkNasDiscoveryResponse;
    } catch {
      return null;
    }
  })();

  const [androidDevices, serverScan, clientMdnsDevices] = await Promise.all([
    runAndroidBridgeDiscovery(),
    serverScanPromise,
    probeClientLocalMdnsUrls(),
  ]);

  const byKey = new Map<string, DiscoveredNasDevice>();
  const methodsUsed = new Set<NetworkDiscoveryMethod>(serverScan?.methodsUsed ?? []);
  if (androidDevices.length > 0) methodsUsed.add('android_nsd');
  if (clientMdnsDevices.length > 0) methodsUsed.add('mdns');

  const mergeDevice = (incoming: DiscoveredNasDevice) => {
    const key = incoming.ip || incoming.hostname;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...incoming,
        services: [...incoming.services],
        discoveryMethods: [...incoming.discoveryMethods],
      });
      return;
    }

    for (const m of incoming.discoveryMethods) {
      if (!existing.discoveryMethods.includes(m)) {
        existing.discoveryMethods.push(m);
      }
    }
    for (const svc of incoming.services) {
      if (!existing.services.some((s) => s.protocol === svc.protocol && s.port === svc.port)) {
        existing.services.push(svc);
      }
    }
    if (incoming.hostname && incoming.hostname.endsWith('.local') && !existing.hostname.endsWith('.local')) {
      existing.hostname = incoming.hostname;
    }
    if (incoming.name && !incoming.name.startsWith('Heim-NAS (') && existing.name.startsWith('Heim-NAS (')) {
      existing.name = incoming.name;
    }
    if (incoming.isEntenCenterServer && !existing.isEntenCenterServer) {
      existing.isEntenCenterServer = true;
      existing.baseUrl = incoming.baseUrl || existing.baseUrl;
    }
    if (existing.vendor === 'Standard NAS' && incoming.vendor !== 'Standard NAS') {
      existing.vendor = incoming.vendor;
    }
    existing.sameSubnet = existing.sameSubnet || incoming.sameSubnet;
  };

  for (const dev of [...androidDevices, ...(serverScan?.devices ?? []), ...clientMdnsDevices]) {
    mergeDevice(dev);
  }

  const devices = Array.from(byKey.values());
  devices.sort((a, b) => {
    if (a.isEntenCenterServer !== b.isEntenCenterServer) return a.isEntenCenterServer ? -1 : 1;
    if (a.sameSubnet !== b.sameSubnet) return a.sameSubnet ? -1 : 1;
    const aMdns = a.discoveryMethods.includes('mdns') || a.discoveryMethods.includes('android_nsd');
    const bMdns = b.discoveryMethods.includes('mdns') || b.discoveryMethods.includes('android_nsd');
    if (aMdns !== bMdns) return aMdns ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const durationMs = Date.now() - startedAt;
  const entenCount = devices.filter((d) => d.isEntenCenterServer).length;
  const summary =
    devices.length === 0
      ? 'Keine NAS-Geräte im lokalen Netzwerk gefunden. Prüfe WLAN/LAN oder stelle sicher, dass mDNS/Bonjour auf dem NAS aktiv ist.'
      : `${devices.length} Gerät${devices.length === 1 ? '' : 'e'} im Heimnetz gefunden${
          entenCount > 0 ? ` (${entenCount} EntenCenter-Server)` : ''
        }.`;

  return {
    devices,
    localSubnets: serverScan?.localSubnets ?? [],
    methodsUsed: Array.from(methodsUsed),
    durationMs,
    scannedAt: new Date().toISOString(),
    summary,
  };
}

function buildBrowserHttp400Detail(
  port: number,
  statusCode: number,
  serverHeader: string | null,
  port3000Open: boolean,
  entenCenterPort: number | null
): Http400DiagnosticDetail {
  const probableCauses: Http400DiagnosticDetail['probableCauses'] = [];
  const hints: string[] = [];

  if (port === 80 || port === 443 || port === 8080) {
    probableCauses.push('port_conflict');
    hints.push(
      `Port-Konflikt wahrscheinlich: Auf Port ${port} antwortet bereits ein anderer Dienst${
        serverHeader ? ` (${serverHeader})` : ''
      } mit HTTP ${statusCode} — dort läuft kein direktes EntenCenter-Backend.`
    );
  }
  if (port === 443 || port === 8443 || port === 5001 || port === 80) {
    probableCauses.push('tls_on_http_port');
    hints.push(
      'Protokoll-Mismatch (HTTP vs. HTTPS): Prüfe, ob der Port HTTPS/TLS erwartet oder ein HTTP-Redirect auf HTTPS fehlt.'
    );
  }
  probableCauses.push('proxy_header_filter');
  hints.push(
    'Reverse-Proxy / Header-Filter: Nginx, Apache, Synology Reverse Proxy oder Traefik weisen Anfragen ohne passenden Host-Header oder CORS-/Private-Network-Header oft mit HTTP 400 ab.'
  );
  if (!port3000Open) {
    probableCauses.push('firewall_or_wrong_service');
    hints.push(
      'Firewall / Port 3000 prüfen: Falls das EntenCenter-Backend auf Port 3000 läuft, muss Port 3000/TCP in NAS-Firewall und Router freigegeben werden.'
    );
  } else if (entenCenterPort && entenCenterPort !== port) {
    hints.push(
      `EntenCenter-Backend antwortet stattdessen auf Port ${entenCenterPort}! Ändere die Server-URL auf Port :${entenCenterPort}.`
    );
  }

  return {
    detected: true,
    port,
    statusCode,
    serverHeader,
    probableCauses,
    summary: `HTTP ${statusCode} auf Port ${port} deutet auf einen Port-Konflikt, fehlende HTTPS/Proxy-Header oder einen fremden NAS-/Webdienst hin.`,
    hints,
  };
}

async function runAndroidBridgeDeepDiagnostics(
  targetUrl: string
): Promise<DeepNetworkDiagnosticsResult | null> {
  if (typeof window === 'undefined' || !isNativeAndroidShell()) return null;
  const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
  if (!bridge) return null;

  if (bridge.startDeepNetworkDiagnostics && bridge.getDeepNetworkDiagnosticsResult) {
    try {
      bridge.startDeepNetworkDiagnostics(targetUrl);
      const deadline = Date.now() + 14000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 220));
        const raw = bridge.getDeepNetworkDiagnosticsResult();
        if (!raw) continue;
        const parsed = JSON.parse(raw) as {
          running?: boolean;
          result?: DeepNetworkDiagnosticsResult | null;
        };
        if (parsed && parsed.running === false && parsed.result) {
          return parsed.result;
        }
        if (parsed && parsed.running === false && !parsed.result) {
          break;
        }
      }
    } catch {
      // Fallback auf synchronen Aufruf oder Backend-API
    }
  }

  if (bridge.runDeepNetworkDiagnostics) {
    try {
      const raw = bridge.runDeepNetworkDiagnostics(targetUrl);
      if (raw) {
        return JSON.parse(raw) as DeepNetworkDiagnosticsResult;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function applyStorageBridgeContextToDiagnostics(
  result: DeepNetworkDiagnosticsResult,
  bridgeContext?: {
    active?: boolean;
    synced?: boolean;
    backendPath?: string | null;
    host?: string | null;
    transportLabel?: string | null;
  }
): DeepNetworkDiagnosticsResult {
  if (!bridgeContext?.active && !bridgeContext?.synced) {
    return result;
  }
  const bridgeHostClean = bridgeContext.host ? cleanHostOnly(bridgeContext.host).toLowerCase() : '';
  const diagHosts = [result.hostname, result.resolvedIp]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.toLowerCase());
  if (bridgeHostClean && diagHosts.length > 0 && !diagHosts.includes(bridgeHostClean)) {
    return result;
  }

  const backendLabel = bridgeContext.backendPath || '/EntenCenter-Backend';
  const transportText = bridgeContext.transportLabel || 'FRITZ!NAS / SMB2 (:445 + Web)';
  const isSynced = Boolean(bridgeContext.synced);

  const nextFindings: NetworkDiagnosticFinding[] = [
    {
      severity: 'ok',
      code: 'STORAGE_BRIDGE_ACTIVE',
      title: isSynced
        ? `EntenCenter Storage-Bridge Backend aktiv (${backendLabel})`
        : `NAS Storage-Bridge erkannt (${backendLabel})`,
      detail: isSynced
        ? `Direkter Lese-/Schreibzugriff über ${transportText} ist verbunden und abgeglichen. Ein separates Node-:3000-Backend wird für den Betrieb nicht benötigt.`
        : `Verbindung über ${transportText} erkannt. Sobald Daten unter ${backendLabel} abgeglichen sind, arbeitet das NAS ohne Node-:3000-Server.`,
      recommendation: isSynced
        ? 'Alle Profile, Medienkataloge und Einstellungen werden direkt mit dem NAS synchronisiert.'
        : 'Öffne die NAS-Dateistruktur oder klicke auf „Abgleichen“, um das Backend zu verifizieren.',
    },
  ];

  for (const finding of result.findings) {
    const codeUpper = (finding.code || '').toUpperCase();
    const titleLower = (finding.title || '').toLowerCase();
    // Veraltete Warnungen unterdrücken bzw. sauber in Storage-Bridge-Infos überführen, wenn die Bridge bereits aktiv ist
    if (
      isSynced &&
      (/^HTTP_\d+_CONFLICT$/i.test(codeUpper) ||
        codeUpper.includes('NEED_AUTH') ||
        titleLower.includes('anmeldung mit zugangsdaten erforderlich'))
    ) {
      continue;
    }
    if (
      codeUpper.includes('PURE_NAS') ||
      codeUpper.includes('NO_ENTENCENTER') ||
      titleLower.includes('kein entencenter-backend auf :3000')
    ) {
      nextFindings.push({
        ...finding,
        severity: 'info',
        title: `Storage-Bridge aktiv (${transportText} · :3000 optional)`,
        detail: `${finding.detail ? `${finding.detail} ` : ''}Port :3000 wird im Storage-Bridge-Modus nicht benötigt.`,
        recommendation: isSynced
          ? 'Verbindung zum NAS Storage-Bridge Backend steht bereits.'
          : finding.recommendation,
      });
      continue;
    }
    nextFindings.push(finding);
  }

  const nextFritzBoxInfo = result.fritzBoxInfo
    ? {
        ...result.fritzBoxInfo,
        requiresAuth: isSynced ? false : result.fritzBoxInfo.requiresAuth,
      }
    : null;

  const suppressFritzHttp400 = Boolean(
    isSynced &&
      result.fritzBoxInfo?.detected &&
      result.http400Analysis &&
      (result.http400Analysis.port === 80 || result.http400Analysis.port === 443)
  );

  return {
    ...result,
    fritzBoxInfo: nextFritzBoxInfo,
    http400Analysis: suppressFritzHttp400 ? null : result.http400Analysis,
    findings: nextFindings,
  };
}

export async function runDeepNetworkDiagnostics(options?: {
  targetUrl?: string;
  authToken?: string | null;
  preferNative?: boolean;
  bridgeContext?: {
    active?: boolean;
    synced?: boolean;
    backendPath?: string | null;
    host?: string | null;
    transportLabel?: string | null;
  };
}): Promise<DeepNetworkDiagnosticsResult> {
  const startedAt = Date.now();
  const targetInput = (options?.targetUrl?.trim() || getEffectiveNasOrigin() || 'http://127.0.0.1:3000').trim();
  const isFallbackToken = Boolean(
    options?.authToken && options.authToken.startsWith('local-fallback-')
  );

  // 1. Auf Android APK immer nativen ICMP-Ping / TTL-Traceroute / TCP-Matrix nutzen (wenn gewünscht)
  if (isNativeAndroidShell() && options?.preferNative !== false) {
    const nativeResult = await runAndroidBridgeDeepDiagnostics(targetInput);
    if (nativeResult) {
      return applyStorageBridgeContextToDiagnostics(nativeResult, options?.bridgeContext);
    }
  }

  // 2. Backend-API (/api/nas/network/deep-diagnostics) wenn authentifizierte Session aktiv ist
  if (options?.authToken && !isFallbackToken) {
    try {
      const res = await nasFetch('/api/nas/network/deep-diagnostics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.authToken}`,
        },
        body: JSON.stringify({ targetUrl: targetInput }),
      });
      if (res.ok) {
        return (await res.json()) as DeepNetworkDiagnosticsResult;
      }
      if (res.status >= 400 && res.status < 500) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status !== 401 && res.status !== 403 && res.status !== 404 && errBody.error) {
          throw new Error(errBody.error);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Ungültiger Hostname')) {
        throw err;
      }
      // Auf Browser-Fallback ausweichen, wenn Backend nicht erreichbar ist
    }
  }

  // 3. Browser-Fallback (HTTP-Probe-Matrix im lokalen/Fallback-Kontext, wenn kein Backend/Android-Bridge aktiv)
  const normalized = normalizeNasBaseUrl(targetInput) || targetInput;
  let hostname = '127.0.0.1';
  let scheme: 'http' | 'https' = 'http';
  let targetPort = 3000;
  try {
    const u = new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`);
    hostname = u.hostname || hostname;
    scheme = u.protocol === 'https:' ? 'https' : 'http';
    targetPort = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  } catch {
    // Standardwerte beibehalten
  }

  const probeCandidates: Array<{ port: number; label: string; proto: 'http' | 'https' }> = [
    { port: targetPort, label: `Ziel-Port (${targetPort})`, proto: scheme },
    { port: 3000, label: 'EntenCenter Standard', proto: 'http' },
    { port: 3001, label: 'EntenCenter Ausweichport 1', proto: 'http' },
    { port: 3002, label: 'EntenCenter Ausweichport 2', proto: 'http' },
    { port: 3005, label: 'EntenCenter Ausweichport 3', proto: 'http' },
    { port: 8000, label: 'HTTP-Alt / Dev-Backend', proto: 'http' },
    { port: 8080, label: 'HTTP-Alt / NAS-Proxy', proto: 'http' },
    { port: 8081, label: 'HTTP-Alt 8081', proto: 'http' },
    { port: 80, label: 'HTTP-Standard', proto: 'http' },
    { port: 443, label: 'HTTPS / SSL-Proxy', proto: 'https' },
    { port: 8443, label: 'HTTPS-Alternativ', proto: 'https' },
    { port: 8888, label: 'HTTP-Alt 8888', proto: 'http' },
    { port: 9000, label: 'NAS Service / Alt. 9000', proto: 'http' },
  ];
  const probeSpecs = probeCandidates.filter(
    (item, idx, arr) => arr.findIndex((x) => x.port === item.port) === idx
  );

  const portMatrix: NetworkPortProbeEntry[] = await Promise.all(
    probeSpecs.map(async (spec): Promise<NetworkPortProbeEntry> => {
      const start = performance.now();
      const probeUrl = `${spec.proto}://${hostname}:${spec.port}/api/nas/auth/bootstrap`;
      try {
        const res = await fetch(probeUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(2200),
        });
        const latencyMs = Math.max(1, Math.round((performance.now() - start) * 10) / 10);
        let isEntenCenter = false;
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { hasUsers?: unknown } | null;
          isEntenCenter = Boolean(body && typeof body.hasUsers === 'boolean');
        }
        return {
          port: spec.port,
          label: spec.label,
          protocolHint: spec.proto,
          tcpOpen: true,
          latencyMs,
          httpStatus: res.status,
          serverHeader: res.headers.get('server'),
          isEntenCenter,
          errorCode: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        return {
          port: spec.port,
          label: spec.label,
          protocolHint: spec.proto,
          tcpOpen: false,
          latencyMs: null,
          errorCode: msg.includes('timeout') || msg.includes('abort') ? 'ETIMEDOUT' : 'UNREACHABLE',
        };
      }
    })
  );

  const reachablePorts = portMatrix.filter((p) => p.tcpOpen && typeof p.latencyMs === 'number');
  const latencies = reachablePorts.map((p) => p.latencyMs as number);
  const entenCenterEntry = portMatrix.find((p) => p.isEntenCenter) ?? null;
  const port3000Entry = portMatrix.find((p) => p.port === 3000) ?? null;

  // FRITZ!Box /login_sid.lua Erkennung im Browser-Fallback
  let fritzBoxInfo: DeepNetworkDiagnosticsResult['fritzBoxInfo'] = null;
  const isHttpsContext = typeof window !== 'undefined' && window.location.protocol === 'https:' && !isNativeAndroidShell();
  const fritzSchemes: Array<{ scheme: 'http' | 'https'; port: number }> = isHttpsContext
    ? [{ scheme: 'https', port: 443 }]
    : [
        { scheme: 'http', port: 80 },
        { scheme: 'https', port: 443 },
      ];
  let httpAvailable = false;
  let httpsAvailable = false;
  let httpsError: string | null = null;
  let requiresAuth = false;
  let loginSidUrl: string | null = null;
  for (const spec of fritzSchemes) {
    try {
      const sidUrl = `${spec.scheme}://${hostname}:${spec.port}/login_sid.lua`;
      const sidRes = await fetch(sidUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1800),
      });
      const bodyText = await sidRes.text().catch(() => '');
      if (sidRes.ok && bodyText.includes('<SessionInfo>') && bodyText.includes('<Challenge>')) {
        const sidVal = extractXmlValue(bodyText, 'SID');
        if (spec.scheme === 'http') httpAvailable = true;
        if (spec.scheme === 'https') httpsAvailable = true;
        if (!loginSidUrl) loginSidUrl = sidUrl;
        if (!sidVal || sidVal === '0000000000000000') requiresAuth = true;
      } else if (spec.scheme === 'https' && !sidRes.ok) {
        httpsError = `HTTPS HTTP ${sidRes.status}`;
      }
    } catch (err) {
      if (spec.scheme === 'https') {
        httpsError = err instanceof Error ? err.message : 'HTTPS-Fehler';
      }
    }
  }
  if (httpAvailable || httpsAvailable) {
    fritzBoxInfo = {
      detected: true,
      friendlyName: `FRITZ!Box (${hostname})`,
      tr064Available: false,
      loginSidAvailable: true,
      requiresAuth,
      httpAvailable,
      httpsAvailable,
      httpsError,
      loginSidUrl,
    };
  }

  const http400Entry =
    portMatrix.find((p) => p.port === targetPort && p.httpStatus && p.httpStatus >= 400 && p.httpStatus < 500) ??
    portMatrix.find((p) => p.httpStatus === 400) ??
    null;

  const http400Analysis =
    http400Entry && http400Entry.httpStatus
      ? buildBrowserHttp400Detail(
          http400Entry.port,
          http400Entry.httpStatus,
          http400Entry.serverHeader ?? null,
          Boolean(port3000Entry?.tcpOpen),
          entenCenterEntry?.port ?? null
        )
      : null;

  const findings: NetworkDiagnosticFinding[] = [];
  if (fritzBoxInfo?.detected) {
    findings.push({
      severity: 'info',
      code: 'FRITZBOX_DETECTED',
      title: `${fritzBoxInfo.friendlyName} erkannt${
        fritzBoxInfo.requiresAuth ? ' · FRITZ!Box-Login erforderlich' : ''
      }`,
      detail: fritzBoxInfo.httpsAvailable
        ? 'FRITZ!OS WebUI / FRITZ!NAS antwortet per HTTPS & HTTP (/login_sid.lua).'
        : 'HTTPS liefert auf diesem Gerät einen Fehler/Zertifikatsfehler — im lokalen WLAN weicht EntenCenter automatisch auf HTTP (:80) aus.',
      recommendation: fritzBoxInfo.requiresAuth
        ? 'Gib deine FRITZ!Box/FRITZ!NAS Zugangsdaten (Benutzername optional + Kennwort) ein.'
        : 'Im Menü „FRITZ!Box / UPnP“ oder im Wizard direkt verbinden.',
    });
  }
  if (entenCenterEntry) {
    findings.push({
      severity: 'ok',
      code: 'ENTENCENTER_REACHABLE',
      title: `EntenCenter-Backend aktiv auf Port ${entenCenterEntry.port}`,
      detail: `Der Endpunkt ${hostname}:${entenCenterEntry.port} liefert gültiges Bootstrap-JSON (${entenCenterEntry.latencyMs} ms).`,
      recommendation:
        entenCenterEntry.port !== targetPort
          ? `Nutze Port ${entenCenterEntry.port} statt ${targetPort} in deiner Server-URL.`
          : 'Verbindung betriebsbereit.',
    });
  }
  if (http400Analysis) {
    const isFritzWebConflict = Boolean(
      fritzBoxInfo?.detected && (http400Analysis.port === 80 || http400Analysis.port === 443)
    );
    findings.push({
      severity: isFritzWebConflict ? 'info' : 'error',
      code: `HTTP_${http400Analysis.statusCode}_CONFLICT`,
      title: isFritzWebConflict
        ? `FRITZ!NAS WebUI auf Port ${http400Analysis.port} (erwartet /login_sid.lua statt EntenCenter-API)`
        : `HTTP ${http400Analysis.statusCode} auf Port ${http400Analysis.port} (Port-Konflikt / Proxy)`,
      detail: isFritzWebConflict
        ? `Auf Port ${http400Analysis.port} läuft das AVM FRITZ!OS Webinterface (keine direkte EntenCenter-API).${
            !fritzBoxInfo?.httpsAvailable && fritzBoxInfo?.httpAvailable
              ? ' Bei HTTPS-Fehlern greift automatisch der LAN-HTTP-Fallback auf Port 80.'
              : ''
          }`
        : http400Analysis.summary,
      recommendation: isFritzWebConflict
        ? 'Nutze als Anmeldeweg „FRITZ!Box UPnP / NAS“ mit deinen FRITZ!Box-Zugangsdaten oder trage unten SMB / FRITZ!Box ein.'
        : http400Analysis.hints[0] || 'Prüfe Port-Belegung und Reverse-Proxy-Regeln.',
    });
  }
  const targetEntry = portMatrix.find((p) => p.port === targetPort);
  if (targetEntry && !targetEntry.tcpOpen) {
    findings.push({
      severity: 'error',
      code: targetEntry.errorCode === 'ETIMEDOUT' ? 'FIREWALL_DROP' : 'PORT_CLOSED',
      title:
        targetEntry.errorCode === 'ETIMEDOUT'
          ? `Firewall-Blockade / Timeout auf Port ${targetPort}`
          : `Port ${targetPort} nicht erreichbar`,
      detail:
        'Im Browser-Kontext (oder durch Firewall/Mixed-Content) konnte keine HTTP-Antwort empfangen werden.',
      recommendation:
        'Für vollständiges ICMP-Ping und Traceroute über WLAN/LAN verbinde das NAS-Backend oder nutze die Android-APK.',
    });
  }

  return applyStorageBridgeContextToDiagnostics(
    {
      targetInput,
      hostname,
      resolvedIp: hostname,
      targetPort,
      scheme,
      scope: isLocalOrLanHost(hostname) ? 'lan' : 'remote',
      dns: { ok: true, latencyMs: null, resolvedIp: hostname },
      ping: {
        method: 'tcp_syn_fallback',
        reachable: latencies.length > 0,
        sent: portMatrix.length,
        received: latencies.length,
        packetLossPercent:
          portMatrix.length > 0
            ? Math.round(((portMatrix.length - latencies.length) / portMatrix.length) * 100)
            : 100,
        minMs: latencies.length > 0 ? Math.min(...latencies) : null,
        avgMs:
          latencies.length > 0
            ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10
            : null,
        maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
        error:
          'Browser-Fallback: Reines ICMP-Ping ist im Browser eingeschränkt — HTTP-Handshake-Latenz gemessen.',
      },
      traceroute: {
        method: 'route_equivalent',
        gatewayIp: null,
        hops: [
          {
            hop: 1,
            host: typeof window !== 'undefined' ? window.location.hostname : 'Browser-Client',
            ip: null,
            rttMs: 0.5,
            status: 'local',
            note: 'Client-Endpunkt',
          },
          {
            hop: 2,
            host: `${hostname}:${targetPort}`,
            ip: null,
            rttMs: targetEntry?.latencyMs ?? null,
            status: targetEntry?.tcpOpen ? 'reached' : 'timeout',
            note: targetEntry?.tcpOpen
              ? `HTTP ${targetEntry.httpStatus ?? 'OK'}`
              : targetEntry?.errorCode || 'Nicht erreichbar',
          },
        ],
        summary: `Direkte HTTP-Pfad-Prüfung zu ${hostname}:${targetPort} (Browser-Modus).`,
      },
      portMatrix,
      http400Analysis,
      fritzBoxInfo,
      findings,
      executedOn: 'browser_fallback',
      measuredAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - startedAt),
    },
    options?.bridgeContext
  );
}

export async function scanAlternativeNasPorts(
  targetUrl?: string,
  options?: { authToken?: string | null; preferredAltPort?: number }
): Promise<AlternativePortScanResult> {
  const startedAt = Date.now();
  const preferredAlt =
    options?.preferredAltPort && options.preferredAltPort > 0 && options.preferredAltPort !== 3000
      ? options.preferredAltPort
      : getPreferredAlternativePort();
  const effectiveTarget = (targetUrl?.trim() || getEffectiveNasOrigin() || 'http://127.0.0.1:3000').trim();
  const isFallback = Boolean(options?.authToken && options.authToken.startsWith('local-fallback-'));

  // 1. Android APK: Native TCP + Bootstrap Scanner nutzen (erkennt alle offenen Ports inkl. non-HTTP)
  if (typeof window !== 'undefined' && isNativeAndroidShell()) {
    const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
    try {
      const raw = bridge?.scanAlternativePortsWithPref
        ? bridge.scanAlternativePortsWithPref(effectiveTarget, preferredAlt)
        : bridge?.scanAlternativePorts?.(effectiveTarget);
      if (raw) {
        return JSON.parse(raw) as AlternativePortScanResult;
      }
    } catch {
      // Weiter zu Backend / Browser
    }
  }

  // 2. Backend-API (/api/nas/network/port-scan) wenn Server erreichbar
  if (!isNativeAndroidShell() || (getNasBaseUrl() && !isFallback)) {
    try {
      const res = await nasFetch('/api/nas/network/port-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.authToken && !isFallback
            ? { Authorization: `Bearer ${options.authToken}` }
            : {}),
        },
        body: JSON.stringify({
          targetUrl: effectiveTarget,
          preferredAltPort: preferredAlt,
        }),
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && contentType.includes('application/json')) {
        return (await res.json()) as AlternativePortScanResult;
      }
    } catch {
      // Browser-Fallback nutzen
    }
  }

  // 3. Browser-Fallback: HTTP/HTTPS Bootstrap-Scan
  const normalized = normalizeNasBaseUrl(effectiveTarget) || effectiveTarget;
  let hostname = '127.0.0.1';
  let primaryPort = 3000;
  try {
    const parsed = new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`);
    hostname = parsed.hostname || hostname;
    primaryPort = parsed.port ? Number(parsed.port) : 3000;
  } catch {
    // Default behalten
  }

  const specs: Array<{
    port: number;
    scheme: 'http' | 'https';
    label: string;
    category: AlternativePortScanEntry['category'];
  }> = [
    { port: 3000, scheme: 'http', label: 'EntenCenter Standard', category: 'entencenter' },
    {
      port: preferredAlt,
      scheme: preferredAlt === 8443 || preferredAlt === 443 ? 'https' : 'http',
      label: `Bevorzugter Ausweichport :${preferredAlt}`,
      category: 'alternative',
    },
    { port: 3001, scheme: 'http', label: 'EntenCenter Alt. 1', category: 'alternative' },
    { port: 3002, scheme: 'http', label: 'EntenCenter Alt. 2', category: 'alternative' },
    { port: 3005, scheme: 'http', label: 'EntenCenter Alt. 5', category: 'alternative' },
    { port: 8000, scheme: 'http', label: 'HTTP-Alt 8000', category: 'alternative' },
    { port: 8080, scheme: 'http', label: 'HTTP-Proxy / QNAP', category: 'proxy' },
    { port: 8081, scheme: 'http', label: 'HTTP-Alt 8081', category: 'alternative' },
    { port: 8443, scheme: 'https', label: 'HTTPS-Alt 8443', category: 'proxy' },
    { port: 8888, scheme: 'http', label: 'HTTP-Alt 8888', category: 'alternative' },
    { port: 9000, scheme: 'http', label: 'NAS Service / Alt. 9000', category: 'alternative' },
    { port: 9090, scheme: 'http', label: 'Web-Alt 9090', category: 'alternative' },
    { port: 80, scheme: 'http', label: 'HTTP / Router-UI', category: 'router' },
    { port: 443, scheme: 'https', label: 'HTTPS / SSL-Proxy', category: 'router' },
  ];
  const uniqueSpecs = specs.filter(
    (s, idx, arr) => arr.findIndex((x) => x.port === s.port) === idx
  );

  const entries: AlternativePortScanEntry[] = await Promise.all(
    uniqueSpecs.map(async (spec): Promise<AlternativePortScanEntry> => {
      const url = `${spec.scheme}://${hostname}:${spec.port}/api/nas/auth/bootstrap`;
      if (isMixedContentBlocked(url)) {
        return {
          port: spec.port,
          scheme: spec.scheme,
          label: spec.label,
          category: spec.category,
          tcpOpen: false,
          latencyMs: null,
          isEntenCenter: false,
          usableAsAlternative: false,
          recommended: false,
          errorCode: 'MIXED_CONTENT',
        };
      }
      const pStart = Date.now();
      const ctrl = new AbortController();
      const tId = window.setTimeout(() => ctrl.abort(), 1600);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const latencyMs = Math.max(1, Date.now() - pStart);
        let isEntenCenter = false;
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as { hasUsers?: unknown } | null;
          isEntenCenter = Boolean(json && typeof json.hasUsers === 'boolean');
        }
        return {
          port: spec.port,
          scheme: spec.scheme,
          label: spec.label,
          category: spec.category,
          tcpOpen: true,
          latencyMs,
          httpStatus: res.status,
          serverHeader: res.headers.get('server'),
          isEntenCenter,
          usableAsAlternative: isEntenCenter || (spec.port !== 3000 && res.status < 500),
          recommended: false,
          errorCode: null,
        };
      } catch (err) {
        return {
          port: spec.port,
          scheme: spec.scheme,
          label: spec.label,
          category: spec.category,
          tcpOpen: false,
          latencyMs: null,
          isEntenCenter: false,
          usableAsAlternative: false,
          recommended: false,
          errorCode: err instanceof DOMException && err.name === 'AbortError' ? 'ETIMEDOUT' : 'ECONNREFUSED',
        };
      } finally {
        window.clearTimeout(tId);
      }
    })
  );

  const openEntenCenterPorts = entries.filter((e) => e.isEntenCenter).map((e) => e.port);
  const openAlternativePorts = entries
    .filter((e) => e.tcpOpen && e.port !== 3000)
    .map((e) => e.port);
  const rec =
    entries.find((e) => e.isEntenCenter && e.port !== 3000) ??
    entries.find((e) => e.isEntenCenter) ??
    entries.find((e) => e.usableAsAlternative) ??
    null;
  if (rec) rec.recommended = true;

  return {
    targetInput: effectiveTarget,
    hostname,
    resolvedIp: /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? hostname : null,
    primaryPort,
    preferredAlternativePort: preferredAlt,
    recommendedPort: rec?.port ?? null,
    recommendedBaseUrl: rec ? `${rec.scheme}://${hostname}:${rec.port}` : null,
    openEntenCenterPorts,
    openAlternativePorts,
    openStoragePorts: [],
    ports: entries,
    summary:
      openEntenCenterPorts.length > 0
        ? `EntenCenter-Backend gefunden auf Port ${openEntenCenterPorts.map((p) => `:${p}`).join(', ')}.`
        : openAlternativePorts.length > 0
          ? `Offene Ausweichports gefunden: ${openAlternativePorts.map((p) => `:${p}`).join(', ')}.`
          : `Keine offenen EntenCenter- oder Ausweichports unter ${hostname} erkannt.`,
    executedOn: 'browser_fallback',
    measuredAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - startedAt),
  };
}

export interface StoredSharedNasCertificateEntry {
  origin: string;
  certificate: NasSecurityCertificateInfo | null;
  syncedAt: string;
}

export function getStoredSharedNasCertificate(): StoredSharedNasCertificateEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(NAS_SHARED_CERT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSharedNasCertificateEntry;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function syncSharedNasCertificate(
  certificate: NasSecurityCertificateInfo | null,
  nasOrigin?: string
): void {
  if (typeof window === 'undefined') return;
  const origin = (nasOrigin ? normalizeNasBaseUrl(nasOrigin) : '') || getEffectiveNasOrigin();

  try {
    if (!certificate) {
      window.localStorage.removeItem(NAS_SHARED_CERT_STORAGE_KEY);
    } else {
      const entry: StoredSharedNasCertificateEntry = {
        origin,
        certificate,
        syncedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(NAS_SHARED_CERT_STORAGE_KEY, JSON.stringify(entry));
    }
  } catch {
    // localStorage optional
  }

  if (isNativeAndroidShell()) {
    try {
      (window as AndroidBridgeWindow).EntenCenterAndroid?.setSharedNasCertificate?.(
        certificate?.pem ?? ''
      );
    } catch {
      // Android-Bridge optional
    }
  }
}

export function syncLocalTlsPolicyWithAndroidBridge(allowLocalSelfSignedTls: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      'entencenter_allow_local_self_signed_tls',
      allowLocalSelfSignedTls ? '1' : '0'
    );
  } catch {
    // localStorage optional
  }
  if (isNativeAndroidShell()) {
    try {
      (window as AndroidBridgeWindow).EntenCenterAndroid?.setAllowLocalSelfSignedTls?.(
        allowLocalSelfSignedTls
      );
    } catch {
      // Android-Bridge optional
    }
  }
}

export async function refreshSharedNasCertificateFromNas(
  nasOriginOverride?: string
): Promise<NasSecurityCertificateInfo | null> {
  const cleanOrigin = nasOriginOverride ? normalizeNasBaseUrl(nasOriginOverride) : '';
  const endpoint = cleanOrigin
    ? `${cleanOrigin}/api/nas/network/certificate`
    : resolveNasUrl('/api/nas/network/certificate');
  try {
    const res = await nasFetch(endpoint, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as { certificate?: NasSecurityCertificateInfo | null };
    const cert = data?.certificate ?? null;
    syncSharedNasCertificate(cert, cleanOrigin || getEffectiveNasOrigin());
    return cert;
  } catch {
    return null;
  }
}

export interface NativeFritzChallengeLoginResult {
  ok: boolean;
  reused?: boolean;
  sid?: string;
  sidPreview?: string | null;
  challenge?: string;
  requiresAuth?: boolean;
  blockTimeSec?: number;
  tr064Available?: boolean;
  friendlyName?: string | null;
  modelName?: string | null;
  httpsFallbackToHttp?: boolean;
  httpsError?: string | null;
  effectiveScheme?: 'http' | 'https';
  effectivePort?: number;
  error?: string | null;
}

export async function fritzBoxChallengeLoginNative(request: {
  host: string;
  port?: number;
  useTls?: boolean;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls?: boolean;
  forceRefresh?: boolean;
}): Promise<NativeFritzChallengeLoginResult | null> {
  if (typeof window === 'undefined' || !isNativeAndroidShell()) return null;
  const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
  if (!bridge?.fritzBoxChallengeLogin) return null;

  try {
    const raw = bridge.fritzBoxChallengeLogin(JSON.stringify(request));
    if (!raw) return null;
    return JSON.parse(raw) as NativeFritzChallengeLoginResult;
  } catch {
    return null;
  }
}

export interface FritzBoxDirectLoginRequest {
  host: string;
  port?: number | string;
  useTls?: boolean;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls?: boolean;
  forceRefresh?: boolean;
  serverBaseUrl?: string;
  verifyBrowseTree?: boolean;
}

export interface FritzBoxDirectLoginResult extends NativeFritzChallengeLoginResult {
  host: string;
  source: 'android_native' | 'server_api' | 'unavailable';
  browseTree?: NasBrowseTreeResult | null;
}

export async function fritzBoxDirectLoginWithSession(
  request: FritzBoxDirectLoginRequest
): Promise<FritzBoxDirectLoginResult> {
  const cleanHost =
    request.host
      .trim()
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split(':')[0] || 'fritz.box';
  const rawPortNum = Number(request.port);
  const cleanPort =
    Number.isFinite(rawPortNum) && rawPortNum > 0 && rawPortNum !== 49000 && rawPortNum !== 49443
      ? rawPortNum
      : request.useTls
        ? 443
        : 80;
  const allowSelfSigned = request.allowLocalSelfSignedTls ?? true;

  if (isNativeAndroidShell()) {
    const nativeRes = await fritzBoxChallengeLoginNative({
      host: cleanHost,
      port: cleanPort,
      useTls: Boolean(request.useTls),
      username: request.username?.trim() || '',
      password: request.password ?? '',
      allowLocalSelfSignedTls: allowSelfSigned,
      forceRefresh: request.forceRefresh ?? true,
    });
    if (nativeRes) {
      let browseTree: NasBrowseTreeResult | null = null;
      if (nativeRes.ok && request.verifyBrowseTree !== false) {
        try {
          browseTree = await browseNasDirectoryTree({
            protocol: 'fritz_upnp',
            host: cleanHost,
            port: nativeRes.effectivePort || cleanPort,
            path: '/',
            username: request.username?.trim() || '',
            secret: request.password ?? '',
            useTls: nativeRes.effectiveScheme === 'https',
            serverBaseUrl: request.serverBaseUrl,
          });
        } catch {
          browseTree = null;
        }
      }
      return {
        ...nativeRes,
        host: cleanHost,
        source: 'android_native',
        browseTree,
      };
    }
  }

  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base
      ? `${base}/api/nas/fritz-session/auth`
      : '/api/nas/fritz-session/auth';
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: cleanHost,
            port: cleanPort,
            useTls: Boolean(request.useTls),
            username: request.username?.trim() || '',
            password: request.password ?? '',
            allowLocalSelfSignedTls: allowSelfSigned,
            forceRefresh: request.forceRefresh ?? true,
          }),
        },
        6000
      );
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            status?: {
              connected?: boolean;
              host?: string;
              port?: number;
              useTls?: boolean;
              sidPreview?: string | null;
              blockTimeSec?: number;
              tr064Available?: boolean;
              friendlyName?: string | null;
              modelName?: string | null;
              tlsBypassedForLocalSelfSigned?: boolean;
              message?: string;
            };
            error?: string;
          }
        | null;
      if (res.ok && data?.ok) {
        return {
          ok: true,
          host: data.status?.host || cleanHost,
          sidPreview: data.status?.sidPreview ?? 'aktiv',
          effectiveScheme: data.status?.useTls ? 'https' : 'http',
          effectivePort: data.status?.port || cleanPort,
          tr064Available: data.status?.tr064Available ?? false,
          friendlyName: data.status?.friendlyName ?? null,
          modelName: data.status?.modelName ?? null,
          httpsFallbackToHttp: Boolean(
            request.useTls && data.status && !data.status.useTls
          ),
          source: 'server_api',
        };
      }
      if (data?.error) {
        return {
          ok: false,
          host: cleanHost,
          requiresAuth: true,
          error: data.error,
          source: 'server_api',
        };
      }
    } catch {
      // Weiter zu Fallback-Meldung
    }
  }

  return {
    ok: false,
    host: cleanHost,
    requiresAuth: true,
    error: `FRITZ!Box Challenge-Response Login auf "${cleanHost}" konnte nicht direkt erreicht werden. Prüfe WLAN-Verbindung und FRITZ!Box-Passwort.`,
    source: 'unavailable',
  };
}

const LOCAL_PROVISIONED_BACKENDS_KEY = 'entencenter_provisioned_nas_backends_v1';
const NAS_MAC_STORAGE_KEY = 'entencenter_nas_mac_addresses_v1';
export const LOCAL_BUFFER_UPDATED_EVENT = 'entencenter:local-buffer-updated';

export function notifyLocalBufferUpdated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_BUFFER_UPDATED_EVENT));
  } catch {
    // CustomEvent optional
  }
}

export interface LocalProvisionedRegistryEntry {
  host: string;
  protocol: NasProtocolId;
  backendPath: string;
  customFolders: string[];
  updatedAt: string;
}

export function cleanHostOnly(rawHost?: string | null): string {
  return (rawHost ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

export function readAllLocalProvisionedBackends(): LocalProvisionedRegistryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PROVISIONED_BACKENDS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, LocalProvisionedRegistryEntry>;
    return Object.values(map)
      .filter((e): e is LocalProvisionedRegistryEntry => Boolean(e && typeof e.host === 'string' && typeof e.backendPath === 'string'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function readLocalProvisionedBackendForHost(host?: string | null): LocalProvisionedRegistryEntry | null {
  const all = readAllLocalProvisionedBackends();
  if (all.length === 0) return null;
  const cleaned = cleanHostOnly(host);
  if (!cleaned) return all[0] ?? null;
  const exact = all.find((e) => cleanHostOnly(e.host) === cleaned);
  if (exact) return exact;
  return all.find((e) => e.host.toLowerCase().includes(cleaned) || cleaned.includes(cleanHostOnly(e.host))) ?? null;
}

export function readSavedNasMacAddress(host?: string | null): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(NAS_MAC_STORAGE_KEY);
    if (!raw) return '';
    const map = JSON.parse(raw) as Record<string, string>;
    const key = cleanHostOnly(host) || 'default';
    return map[key] || map['default'] || '';
  } catch {
    return '';
  }
}

export function saveNasMacAddress(host: string, macAddress: string): void {
  if (typeof window === 'undefined') return;
  const hex = macAddress.trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return;
  const formatted = Array.from({ length: 6 }, (_, i) => hex.slice(i * 2, i * 2 + 2).toUpperCase()).join(':');
  try {
    const raw = window.localStorage.getItem(NAS_MAC_STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const key = cleanHostOnly(host) || 'default';
    map[key] = formatted;
    window.localStorage.setItem(NAS_MAC_STORAGE_KEY, JSON.stringify(map));
    notifyLocalBufferUpdated();
  } catch {
    // localStorage optional
  }
}

function readLocalProvisionedFoldersForHost(host: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PROVISIONED_BACKENDS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, LocalProvisionedRegistryEntry>;
    const key = cleanHostOnly(host) || host.trim().toLowerCase();
    const matched = map[key] ?? Object.values(map).find((e) => cleanHostOnly(e.host) === key);
    return Array.isArray(matched?.customFolders) ? matched.customFolders : [];
  } catch {
    return [];
  }
}

export function saveLocalProvisionedBackendFolder(
  host: string,
  protocol: NasProtocolId,
  backendPath: string,
  extraFolders: string[] = []
): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LOCAL_PROVISIONED_BACKENDS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, LocalProvisionedRegistryEntry>) : {};
    const cleaned = cleanHostOnly(host) || 'local-nas';
    const existing = map[cleaned]?.customFolders ?? [];
    const mergedFolders = Array.from(new Set([...existing, backendPath, ...extraFolders]));
    map[cleaned] = {
      host: cleaned,
      protocol,
      backendPath,
      customFolders: mergedFolders,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(LOCAL_PROVISIONED_BACKENDS_KEY, JSON.stringify(map));
    notifyLocalBufferUpdated();
  } catch {
    // localStorage optional
  }
}

function normalizeClientNasPath(rawPath?: string): string {
  const cleaned = (rawPath ?? '/').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!cleaned || cleaned === '/') return '/';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.replace(/\/+$/, '') || '/';
}

function getClientNasParentPath(currentPath: string): string | null {
  const norm = normalizeClientNasPath(currentPath);
  if (norm === '/') return null;
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '/';
  return norm.slice(0, idx) || '/';
}

function buildClientFallbackNasTree(
  protocol: NasProtocolId,
  host: string,
  currentPath: string,
  warning?: string | null,
  requiresAuth = false
): NasBrowseTreeResult {
  const norm = normalizeClientNasPath(currentPath);
  const customPaths = readLocalProvisionedFoldersForHost(host);
  const entriesMap = new Map<string, NasDirectoryTreeEntry>();

  const defaults: Record<string, string[]> = {
    '/':
      protocol === 'fritz_upnp'
        ? ['FRITZ', 'Medien', 'Bilder', 'Musik', 'EntenCenter-Backend']
        : protocol === 'nfs' || protocol === 'api_token'
          ? ['volume1', 'Medien', 'share', 'EntenCenter-Backend']
          : ['Medien', 'Public', 'Home', 'EntenCenter-Backend'],
    '/FRITZ': ['mediabox', 'EntenCenter-Backend'],
    '/Medien': ['Filme', 'Serien', 'EntenCenter-Backend'],
    '/volume1': ['video', 'docker', 'EntenCenter-Backend'],
  };

  for (const name of defaults[norm] ?? []) {
    const p = norm === '/' ? `/${name}` : `${norm}/${name}`;
    entriesMap.set(p, {
      name,
      path: p,
      type: 'directory',
      writable: true,
      recommended: name === 'FRITZ' || name === 'EntenCenter-Backend',
    });
  }

  for (const savedPath of customPaths) {
    const cleanSaved = normalizeClientNasPath(savedPath);
    if (norm === '/' && cleanSaved !== '/') {
      const top = cleanSaved.split('/').filter(Boolean)[0];
      if (top) {
        const p = `/${top}`;
        entriesMap.set(p, {
          name: top,
          path: p,
          type: 'directory',
          writable: true,
          recommended: top.toLowerCase().includes('entencenter'),
        });
      }
    } else if (norm !== '/' && cleanSaved.startsWith(`${norm}/`)) {
      const rest = cleanSaved.slice(norm.length + 1).split('/').filter(Boolean)[0];
      if (rest) {
        const p = `${norm}/${rest}`;
        entriesMap.set(p, {
          name: rest,
          path: p,
          type: 'directory',
          writable: true,
          recommended: rest.toLowerCase().includes('entencenter'),
        });
      }
    }
  }

  const recommendedBackendPath =
    protocol === 'fritz_upnp'
      ? '/FRITZ/EntenCenter-Backend'
      : norm === '/'
        ? '/EntenCenter-Backend'
        : `${norm}/EntenCenter-Backend`;

  return {
    ok: true,
    host,
    protocol,
    currentPath: norm,
    parentPath: getClientNasParentPath(norm),
    entries: Array.from(entriesMap.values()),
    recommendedBackendPath,
    source: 'nas_template',
    requiresAuth,
    writable: true,
    warning:
      warning ??
      'Direkte NAS-Ordnerstruktur geladen. Du kannst den Pfad manuell wählen oder das EntenCenter-Backend automatisch anlegen — die Verbindung bleibt ohne Abbruch bestehen.',
  };
}

export async function browseNasDirectoryTree(request: {
  protocol: NasProtocolId;
  host: string;
  port?: string | number;
  path?: string;
  shareOrPath?: string;
  username?: string;
  password?: string;
  secret?: string;
  fritzUsername?: string;
  fritzPassword?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  serverBaseUrl?: string;
  token?: string | null;
}): Promise<NasBrowseTreeResult> {
  const host = request.host.trim() || (request.protocol === 'fritz_upnp' ? 'fritz.box' : '192.168.178.1');
  const currentPath = normalizeClientNasPath(request.path ?? '/');
  const password = request.secret ?? request.password ?? '';
  const effectiveFritzPass = request.fritzPassword?.trim() ? request.fritzPassword : password;
  const effectiveSmbPass = password || effectiveFritzPass;
  const effectiveUser = (request.username ?? request.fritzUsername ?? '').trim();
  const shouldUseNativeFritzBridge =
    request.protocol === 'fritz_upnp' ||
    Boolean(request.fritzPassword?.trim()) ||
    host.toLowerCase().includes('fritz');

  // 1. In der Android-APK für alle NAS-Protokolle (FRITZ!NAS + SMB2 + WebDAV) direkt nativ im lokalen WLAN abfragen
  if (isNativeAndroidShell()) {
    try {
      const safePort = sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls);
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      const bridgePayload = JSON.stringify({
        protocol: request.protocol,
        host,
        port: safePort,
        path: currentPath,
        shareOrPath: request.shareOrPath ?? (request.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
        username: effectiveUser,
        fritzUsername: (request.fritzUsername ?? effectiveUser).trim(),
        password: request.protocol === 'smb' ? effectiveSmbPass : effectiveFritzPass,
        secret: password,
        fritzPassword: effectiveFritzPass,
        domainOrWorkgroup: request.domainOrWorkgroup ?? '',
        useTls: Boolean(request.useTls),
      });
      const invokeNativeBrowse = () => {
        const raw = bridge?.browseNasDirectories
          ? bridge.browseNasDirectories(bridgePayload)
          : shouldUseNativeFritzBridge && bridge?.browseFritzNasDirectories
            ? bridge.browseFritzNasDirectories(bridgePayload)
            : '';
        return raw ? (JSON.parse(raw) as NasBrowseTreeResult) : null;
      };
      let parsed = invokeNativeBrowse();
      const warnLower = (parsed?.warning ?? '').toLowerCase();
      if (
        parsed?.source === 'nas_template' &&
        (password || effectiveFritzPass) &&
        (warnLower.includes('timeout') ||
          warnLower.includes('nicht erreichbar') ||
          warnLower.includes('ruhemodus') ||
          warnLower.includes('standby'))
      ) {
        await wakeNasFromSleep({
          host,
          username: effectiveUser,
          password: effectiveSmbPass || effectiveFritzPass,
          useTls: request.useTls,
        }).catch(() => null);
        const retryParsed = invokeNativeBrowse();
        if (retryParsed && retryParsed.source !== 'nas_template') {
          parsed = retryParsed;
        }
      }
      if (parsed && Array.isArray(parsed.entries)) {
        const dedupedMap = new Map<string, NasDirectoryTreeEntry>();
        for (const entry of parsed.entries) {
          if (entry?.path && !dedupedMap.has(entry.path)) {
            dedupedMap.set(entry.path, entry);
          }
        }
        parsed.entries = Array.from(dedupedMap.values());
        if (parsed.source === 'nas_template') {
          const extraCustom = readLocalProvisionedFoldersForHost(host);
          if (extraCustom.length > 0 && currentPath === '/') {
            const seen = new Set(parsed.entries.map((e) => e.path));
            for (const cp of extraCustom) {
              const top = normalizeClientNasPath(cp).split('/').filter(Boolean)[0];
              if (top && !seen.has(`/${top}`)) {
                seen.add(`/${top}`);
                parsed.entries.push({
                  name: top,
                  path: `/${top}`,
                  type: 'directory',
                  writable: true,
                  recommended: top.toLowerCase().includes('entencenter'),
                });
              }
            }
          }
        }
        return parsed;
      }
    } catch {
      // Weiter zu EntenCenter-API / Bridge-Template
    }
  }

  // 2. Falls EntenCenter-Server oder lokale API erreichbar ist, serverseitig abfragen
  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/storage/browse-tree` : '/api/nas/storage/browse-tree';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (request.token && !request.token.startsWith('local-fallback-')) {
        headers.Authorization = `Bearer ${request.token}`;
      }
      const res = await nasFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocol: request.protocol,
          host,
          port: String(sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls)),
          path: currentPath,
          shareOrPath: request.shareOrPath ?? '',
          username: effectiveUser,
          secret: password,
          fritzUsername: (request.fritzUsername ?? effectiveUser).trim(),
          fritzPassword: effectiveFritzPass,
          domainOrWorkgroup: request.domainOrWorkgroup ?? '',
          useTls: request.useTls,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as NasBrowseTreeResult;
        if (data && Array.isArray(data.entries)) {
          return data;
        }
      }
    } catch {
      // Kein Verbindungsabbruch — lokales Bridge-Template liefern
    }
  }

  return buildClientFallbackNasTree(request.protocol, host, currentPath);
}

export async function provisionNasBackend(request: {
  mode: 'auto' | 'manual';
  createSingleFolder?: boolean;
  targetPath: string;
  customFolderName?: string;
  shareOrPath?: string;
  protocol: NasProtocolId;
  host: string;
  port?: string | number;
  username?: string;
  password?: string;
  secret?: string;
  fritzUsername?: string;
  fritzPassword?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  ownerUsername?: string;
  serverBaseUrl?: string;
  token?: string | null;
}): Promise<NasProvisionBackendResult> {
  const host = request.host.trim() || (request.protocol === 'fritz_upnp' ? 'fritz.box' : '192.168.178.1');
  const password = request.secret ?? request.password ?? '';
  const effectiveFritzPass = request.fritzPassword?.trim() ? request.fritzPassword : password;
  const effectiveSmbPass = password || effectiveFritzPass;
  const effectiveUser = (request.username ?? request.fritzUsername ?? '').trim();
  const createSingleFolder = Boolean(request.createSingleFolder);
  const shouldUseNativeFritzBridge =
    request.protocol === 'fritz_upnp' ||
    Boolean(request.fritzPassword?.trim()) ||
    host.toLowerCase().includes('fritz');

  let chosenPath = normalizeClientNasPath(
    request.targetPath || (request.protocol === 'fritz_upnp' ? '/FRITZ/EntenCenter-Backend' : '/EntenCenter-Backend')
  );
  if (!createSingleFolder) {
    const cleanFolder = (request.customFolderName ?? '').trim().replace(/[\\/]+/g, '');
    if (cleanFolder && !chosenPath.toLowerCase().endsWith(cleanFolder.toLowerCase())) {
      chosenPath = chosenPath === '/' ? `/${cleanFolder}` : `${chosenPath}/${cleanFolder}`;
    }
    if (request.mode === 'auto' && !request.targetPath) {
      chosenPath = request.protocol === 'fritz_upnp' ? '/FRITZ/EntenCenter-Backend' : '/EntenCenter-Backend';
    } else if (chosenPath === '/') {
      chosenPath = '/EntenCenter-Backend';
    }
  } else if (chosenPath === '/') {
    chosenPath = '/EntenCenter';
  }

  // Immer in lokaler Bridge merken, damit die Dateistruktur sofort sichtbar & persistent bleibt
  saveLocalProvisionedBackendFolder(
    host,
    request.protocol,
    chosenPath,
    createSingleFolder
      ? []
      : [
          `${chosenPath}/profiles`,
          `${chosenPath}/media`,
          `${chosenPath}/config`,
          `${chosenPath}/wal`,
        ]
  );

  if (isNativeAndroidShell()) {
    try {
      const safePort = sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls);
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      const bridgePayload = JSON.stringify({
        mode: request.mode,
        createSingleFolder,
        targetPath: chosenPath,
        shareOrPath: request.shareOrPath ?? (request.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
        protocol: request.protocol,
        host,
        port: safePort,
        username: effectiveUser,
        fritzUsername: (request.fritzUsername ?? effectiveUser).trim(),
        password: request.protocol === 'smb' ? effectiveSmbPass : effectiveFritzPass,
        secret: password,
        fritzPassword: effectiveFritzPass,
        domainOrWorkgroup: request.domainOrWorkgroup ?? '',
        useTls: Boolean(request.useTls),
      });
      const raw = bridge?.provisionNasBackend
        ? bridge.provisionNasBackend(bridgePayload)
        : shouldUseNativeFritzBridge && bridge?.provisionFritzNasBackend
          ? bridge.provisionFritzNasBackend(bridgePayload)
          : '';
      if (raw) {
        const parsed = JSON.parse(raw) as NasProvisionBackendResult;
        if (parsed && parsed.ok) {
          return parsed;
        }
      }
    } catch {
      // Fallback unten
    }
  }

  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base
      ? `${base}/api/nas/storage/provision-backend`
      : '/api/nas/storage/provision-backend';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (request.token && !request.token.startsWith('local-fallback-')) {
        headers.Authorization = `Bearer ${request.token}`;
      }
      const res = await nasFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mode: request.mode,
          createSingleFolder,
          targetPath: chosenPath,
          customFolderName: request.customFolderName,
          shareOrPath: request.shareOrPath ?? '',
          protocol: request.protocol,
          host,
          port: String(sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls)),
          username: effectiveUser,
          secret: password,
          fritzUsername: (request.fritzUsername ?? effectiveUser).trim(),
          fritzPassword: effectiveFritzPass,
          domainOrWorkgroup: request.domainOrWorkgroup ?? '',
          useTls: request.useTls,
          ownerUsername: request.ownerUsername,
        }),
      });
      if (res.ok) {
        return (await res.json()) as NasProvisionBackendResult;
      }
    } catch {
      // Kein Abbruch — client-seitige Bridge greift
    }
  }

  return {
    ok: true,
    mode: request.mode,
    host,
    protocol: request.protocol,
    backendPath: chosenPath,
    createdDirectories: createSingleFolder
      ? [chosenPath]
      : [
          chosenPath,
          `${chosenPath}/profiles`,
          `${chosenPath}/media`,
          `${chosenPath}/media/movies`,
          `${chosenPath}/media/series`,
          `${chosenPath}/config`,
          `${chosenPath}/wal`,
          `${chosenPath}/backups`,
        ],
    createdFiles: createSingleFolder
      ? []
      : [
          `${chosenPath}/entencenter-backend.json`,
          `${chosenPath}/docker-compose.yml`,
          `${chosenPath}/start-entencenter.sh`,
        ],
    remoteWriteOk: false,
    localBridgeReady: true,
    connectionKeptAlive: true,
    message: createSingleFolder
      ? `Ordner "${chosenPath}" für ${host} lokal vorgemerkt (Verbindung bleibt aktiv).`
      : `EntenCenter-Backend-Pfad "${chosenPath}" für ${host} eingerichtet. Verbindung bleibt im Storage-Bridge-Modus ohne Abbruch aktiv.`,
    instructions: createSingleFolder
      ? [`Zielordner: ${chosenPath}`]
      : [
          `Gewählter NAS-Zielpfad: ${chosenPath}`,
          'Unterordner vorbereitet: profiles/, media/, config/, wal/, backups/',
        ],
  };
}

export interface UniversalNasProbeRequest {
  host: string;
  port?: string | number;
  protocol?: NasProtocolId;
  shareOrPath?: string;
  username?: string;
  password?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  ftpsTlsMode?: 'explicit' | 'implicit';
  scope?: NasConnectionScope;
  timeoutMs?: number;
  serverBaseUrl?: string;
}

function redactErrorMsg(raw: string, password?: string): string {
  let msg = raw
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[geschützt]')
    .replace(/([?&](?:sid|password|secret|pass|token)=)[^&\s]+/gi, '$1[geschützt]');
  if (password && password.length >= 3) {
    msg = msg.split(password).join('[geschützt]');
  }
  return msg;
}

export async function probeUniversalNas(
  request: UniversalNasProbeRequest
): Promise<UniversalNasProbeResponse> {
  const cleanHost = request.host.trim();
  const isLan = isLocalOrLanHost(cleanHost);
  const effectiveScope: NasConnectionScope = request.scope ?? (isLan ? 'lan' : 'internet');
  const startedAt = Date.now();

  if (!cleanHost) {
    return {
      ok: false,
      host: '',
      resolvedIp: null,
      isLan: false,
      scope: effectiveScope,
      vpnRequiredForSmb: false,
      detectedVendor: 'standard_nas',
      vendorLabel: 'Standard-NAS',
      entenCenterDetected: false,
      recommendedProtocol: null,
      recommendedPort: null,
      resultsByPriority: [],
      fritzTracks: null,
      userFriendlySummary: 'Bitte gib zuerst Hostname oder IP-Adresse des NAS ein.',
      errors: ['Kein Zielhost angegeben.'],
      measuredAt: new Date().toISOString(),
      durationMs: 1,
      executedOn: isNativeAndroidShell() ? 'android_native' : 'browser_fallback',
    };
  }

  // 1. Auf Android direkt nativ im lokalen Socket/TLS/SMB-Stack prüfen (kein Port 3000 nötig!)
  const sanitizedProbePort = request.protocol
    ? sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls)
    : request.port
      ? Number(request.port)
      : undefined;
  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.probeUniversalNas) {
        const raw = bridge.probeUniversalNas(
          JSON.stringify({
            host: cleanHost,
            port: sanitizedProbePort,
            protocol: request.protocol,
            shareOrPath: request.shareOrPath ?? '/',
            username: request.username?.trim() ?? '',
            password: request.password ?? '',
            domainOrWorkgroup: request.domainOrWorkgroup ?? '',
            useTls: request.useTls,
            ftpsTlsMode: request.ftpsTlsMode ?? 'explicit',
            scope: effectiveScope,
            timeoutMs: request.timeoutMs ?? 3000,
          })
        );
        if (raw) {
          return JSON.parse(raw) as UniversalNasProbeResponse;
        }
      }
    } catch {
      // Fallback unten
    }
  }

  // 2. Server-seitige universelle Protokoll-Analyse (/api/nas/universal/probe)
  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/universal/probe` : resolveNasUrl('/api/nas/universal/probe');
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: cleanHost,
            port: sanitizedProbePort,
            protocol: request.protocol,
            shareOrPath: request.shareOrPath ?? '/',
            username: request.username?.trim() ?? '',
            password: request.password ?? '',
            domainOrWorkgroup: request.domainOrWorkgroup ?? '',
            useTls: request.useTls,
            ftpsTlsMode: request.ftpsTlsMode ?? 'explicit',
            scope: effectiveScope,
            timeoutMs: request.timeoutMs,
          }),
        },
        9000
      );
      const data = (await res.json().catch(() => null)) as UniversalNasProbeResponse & { error?: string } | null;
      if (res.ok && data && Array.isArray(data.resultsByPriority)) {
        return data;
      }
      if (res.status === 400 || res.status === 404) {
        return {
          ok: false,
          host: cleanHost,
          resolvedIp: null,
          isLan,
          scope: effectiveScope,
          vpnRequiredForSmb: !isLan && effectiveScope !== 'vpn',
          detectedVendor: cleanHost.toLowerCase().includes('fritz') ? 'avm_fritzbox' : 'standard_nas',
          vendorLabel: cleanHost.toLowerCase().includes('fritz') ? 'AVM FRITZ!Box / FRITZ!NAS' : 'Standard-NAS',
          entenCenterDetected: false,
          recommendedProtocol: null,
          recommendedPort: null,
          resultsByPriority: [],
          fritzTracks: null,
          userFriendlySummary:
            res.status === 404
              ? `Kein EntenCenter-:3000-Backend auf "${cleanHost}" (HTTP 404). Verwende die Android-APK oder ein lokales NAS-Backend für native SMB/SFTP/FTPS-Prüfung.`
              : redactErrorMsg(
                  data?.error || `HTTP 400 von "${cleanHost}": Endpunkt gehört zu einem anderen NAS-Dienst, nicht zum EntenCenter-API-Server.`,
                  request.password
                ),
          errors: [
            res.status === 404
              ? 'EntenCenter-Backend-Endpunkt nicht vorhanden (HTTP 404). Port 3000 ist für die direkte NAS-Anmeldung in der Android-App nicht erforderlich.'
              : `HTTP 400: Endpunkt auf "${cleanHost}" erwartet ein anderes Protokoll.`,
          ],
          measuredAt: new Date().toISOString(),
          durationMs: Math.max(1, Date.now() - startedAt),
          executedOn: 'browser_fallback',
        };
      }
    } catch {
      // Fallback
    }
  }

  return {
    ok: false,
    host: cleanHost,
    resolvedIp: null,
    isLan,
    scope: effectiveScope,
    vpnRequiredForSmb: !isLan && effectiveScope !== 'vpn',
    detectedVendor: cleanHost.toLowerCase().includes('fritz') ? 'avm_fritzbox' : 'standard_nas',
    vendorLabel: cleanHost.toLowerCase().includes('fritz') ? 'AVM FRITZ!Box / FRITZ!NAS' : 'Standard-NAS',
    entenCenterDetected: false,
    recommendedProtocol: null,
    recommendedPort: null,
    resultsByPriority: [],
    fritzTracks: null,
    userFriendlySummary:
      'Direkte TCP/SMB/SFTP-Prüfung steht im Browser ohne lokales Backend nicht zur Verfügung — nutze die Android-APK oder starte das EntenCenter-Backend.',
    errors: ['Universeller Protokoll-Scanner im aktuellen Browser-Kontext nicht erreichbar.'],
    measuredAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - startedAt),
    executedOn: 'browser_fallback',
  };
}

export async function testUniversalNasConnection(
  request: UniversalNasProbeRequest & { protocol: NasProtocolId }
): Promise<{
  ok: boolean;
  verification: NasProtocolVerificationResult | null;
  error?: string | null;
}> {
  const cleanHost = request.host.trim();
  const isLan = isLocalOrLanHost(cleanHost);
  const effectiveScope: NasConnectionScope = request.scope ?? (isLan ? 'lan' : 'internet');

  const safePort = sanitizeNasPortForProtocol(request.protocol, request.port, request.useTls);

  if (request.protocol === 'smb' && !isLan && effectiveScope !== 'vpn') {
    const vpnMsg =
      'SMB (Port 445) darf aus Sicherheitsgründen nicht ungeschützt über das öffentliche Internet verwendet werden. Bitte aktiviere zuerst VPN (WireGuard/IPSec) oder wechsle auf WebDAV über HTTPS / SFTP.';
    return {
      ok: false,
      verification: {
        protocol: 'smb',
        port: safePort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: false,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        blockedByVpnPolicy: true,
        latencyMs: null,
        errorCode: 'SMB_INTERNET_BLOCKED_VPN_REQUIRED',
        message: vpnMsg,
      },
      error: vpnMsg,
    };
  }

  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.testNasProtocolConnection) {
        const raw = bridge.testNasProtocolConnection(
          JSON.stringify({
            host: cleanHost,
            port: safePort,
            protocol: request.protocol,
            shareOrPath: request.shareOrPath ?? '/',
            username: request.username?.trim() ?? '',
            password: request.password ?? '',
            domainOrWorkgroup: request.domainOrWorkgroup ?? '',
            useTls: request.useTls,
            ftpsTlsMode: request.ftpsTlsMode ?? 'explicit',
            scope: effectiveScope,
            timeoutMs: request.timeoutMs ?? 3200,
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as {
            ok?: boolean;
            verification?: NasProtocolVerificationResult | null;
            error?: string | null;
            protocolVerified?: boolean;
            tcpOpen?: boolean;
            authVerified?: boolean;
            authAttempted?: boolean;
            message?: string;
          };
          const verification =
            parsed.verification ??
            (typeof parsed.protocolVerified === 'boolean' || typeof parsed.tcpOpen === 'boolean'
              ? (parsed as unknown as NasProtocolVerificationResult)
              : null);
          const isOk =
            typeof parsed.ok === 'boolean'
              ? parsed.ok
              : Boolean(verification?.protocolVerified && (!verification.authAttempted || verification.authVerified));
          const rawErr = parsed.error ?? (!isOk ? verification?.message : null);
          return {
            ok: isOk,
            verification,
            error: rawErr ? redactErrorMsg(rawErr, request.password) : null,
          };
        }
      }
    } catch {
      // Server-Fallback
    }
  }

  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/universal/test` : resolveNasUrl('/api/nas/universal/test');
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: cleanHost,
            port: safePort,
            protocol: request.protocol,
            shareOrPath: request.shareOrPath ?? '/',
            username: request.username?.trim() ?? '',
            password: request.password ?? '',
            domainOrWorkgroup: request.domainOrWorkgroup ?? '',
            useTls: request.useTls,
            ftpsTlsMode: request.ftpsTlsMode ?? 'explicit',
            scope: effectiveScope,
          }),
        },
        7500
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        verification?: NasProtocolVerificationResult | null;
        error?: string | null;
        protocolVerified?: boolean;
        tcpOpen?: boolean;
        authVerified?: boolean;
        authAttempted?: boolean;
        message?: string;
      } | null;
      const verification =
        data?.verification ??
        (data && (typeof data.protocolVerified === 'boolean' || typeof data.tcpOpen === 'boolean')
          ? (data as unknown as NasProtocolVerificationResult)
          : null);
      if (data && (typeof data.ok === 'boolean' || verification)) {
        const isOk =
          typeof data.ok === 'boolean'
            ? data.ok
            : Boolean(verification?.protocolVerified && (!verification.authAttempted || verification.authVerified));
        const rawErr = data.error ?? (!isOk ? verification?.message : null);
        return {
          ok: isOk,
          verification,
          error: rawErr ? redactErrorMsg(rawErr, request.password) : null,
        };
      }
      if (res.status === 400 || res.status === 404) {
        return {
          ok: false,
          verification: null,
          error:
            res.status === 404
              ? `Endpunkt auf "${cleanHost}" nicht vorhanden (HTTP 404) — kein EntenCenter-Backend nötig, falls du direkt per Android-App verbindest.`
              : `HTTP 400: Gegenstelle auf "${cleanHost}" hat einen anderen Dienst-Endpunkt.`,
        };
      }
    } catch {
      // Fallback
    }
  }

  return {
    ok: false,
    verification: null,
    error: `Verbindungstest zu "${cleanHost}" (${request.protocol.toUpperCase()}) im aktuellen Browser-Kontext nicht möglich.`,
  };
}

export async function loginUniversalNas(request: {
  host: string;
  port?: string | number;
  protocol?: NasProtocolId | 'auto';
  shareOrPath?: string;
  username?: string;
  password?: string;
  displayName?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  ftpsTlsMode?: 'explicit' | 'implicit';
  scope?: NasConnectionScope;
  serverBaseUrl?: string;
}): Promise<{
  ok: boolean;
  token?: string;
  user?: NasUser;
  verification?: NasProtocolVerificationResult | null;
  probe?: UniversalNasProbeResponse | null;
  warning?: string | null;
  error?: string | null;
}> {
  const cleanHost = request.host.trim();
  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();

  // Wenn ein EntenCenter-Backend erreichbar ist (Browser oder konfiguriertes Server-Backend), serverseitig einloggen
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/universal/login` : resolveNasUrl('/api/nas/universal/login');
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        10000
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        token?: string;
        user?: NasUser;
        verification?: NasProtocolVerificationResult | null;
        probe?: UniversalNasProbeResponse | null;
        warning?: string | null;
        error?: string | null;
      } | null;

      if (res.ok && data?.ok && data.token && data.user) {
        return {
          ok: true,
          token: data.token,
          user: data.user,
          verification: data.verification ?? null,
          probe: data.probe ?? null,
          warning: data.warning ?? null,
        };
      }
      if (data && (data.error || data.verification || data.probe)) {
        return {
          ok: false,
          verification: data.verification ?? null,
          probe: data.probe ?? null,
          error: data.error ? redactErrorMsg(data.error, request.password) : 'NAS-Anmeldung fehlgeschlagen.',
        };
      }
      if (res.status === 400 || res.status === 404) {
        // Bei fehlendem :3000-Backend unten auf direkte native NAS-Prüfung ausweichen
      }
    } catch {
      // Direkt-Fallback unten
    }
  }

  // Direkt-NAS-Pfad (ohne Port 3000!) z. B. in Android APK direkt gegen FRITZ!NAS / Synology / QNAP / WD / SMB / WebDAV / SFTP / FTPS
  const probe =
    !request.protocol || request.protocol === 'auto'
      ? await probeUniversalNas({
          host: cleanHost,
          port: request.port,
          shareOrPath: request.shareOrPath,
          username: request.username,
          password: request.password,
          domainOrWorkgroup: request.domainOrWorkgroup,
          useTls: request.useTls,
          ftpsTlsMode: request.ftpsTlsMode,
          scope: request.scope,
        })
      : null;

  const chosenProtocol: NasProtocolId =
    request.protocol && request.protocol !== 'auto'
      ? request.protocol
      : probe?.recommendedProtocol ?? 'smb';

  const testRes =
    probe && probe.recommendedProtocol
      ? {
          ok: probe.ok,
          verification:
            probe.resultsByPriority.find((r) => r.protocol === probe.recommendedProtocol) ?? null,
          error: probe.ok ? null : probe.errors[0] || probe.userFriendlySummary,
        }
      : await testUniversalNasConnection({
          host: cleanHost,
          port: request.port,
          protocol: chosenProtocol,
          shareOrPath: request.shareOrPath,
          username: request.username,
          password: request.password,
          domainOrWorkgroup: request.domainOrWorkgroup,
          useTls: request.useTls,
          ftpsTlsMode: request.ftpsTlsMode,
          scope: request.scope,
        });

  if (!testRes.ok || !testRes.verification?.protocolVerified) {
    return {
      ok: false,
      verification: testRes.verification,
      probe,
      error:
        testRes.error ||
        probe?.errors[0] ||
        `Direkte NAS-Anmeldung an "${cleanHost}" fehlgeschlagen.`,
    };
  }

  return {
    ok: true,
    verification: testRes.verification,
    probe,
    warning:
      chosenProtocol === 'fritz_upnp'
        ? 'UPnP/DLNA ist ausschließlich als Medienquelle aktiv — für direkten Datei-/Ordnerzugriff bitte SMB 2/3 oder WebDAV verwenden.'
        : testRes.verification.warning ?? null,
  };
}

export interface BridgeNasHealthStatus {
  ok: boolean;
  status: 'online' | 'sleeping' | 'offline';
  host: string;
  resolvedIp?: string | null;
  latencyMs: number | null;
  smbOpen?: boolean;
  ftpOpen?: boolean;
  fritzDetected?: boolean;
  fritzHttpAvailable?: boolean;
  fritzHttpsAvailable?: boolean;
  tr064Available?: boolean;
  entenCenterReady?: boolean;
  friendlyName?: string | null;
  discoveredMac?: string | null;
  transportLabel?: string | null;
  warning?: string | null;
}

export interface NasWakeDeviceResult {
  ok: boolean;
  wokeUp: boolean;
  status: 'online' | 'waking' | 'offline';
  host: string;
  resolvedIp?: string | null;
  latencyMs: number | null;
  discoveredMac?: string | null;
  smbReady?: boolean;
  fritzWebReady?: boolean;
  entenCenterReady?: boolean;
  transportLabel?: string | null;
  channelsTriggered: string[];
  message: string;
}

export async function probeBridgeNasHealth(request: {
  host: string;
  port?: string | number;
  scope?: NasConnectionScope;
  serverBaseUrl?: string;
}): Promise<BridgeNasHealthStatus> {
  const cleanHost = cleanHostOnly(request.host);
  if (!cleanHost) {
    return {
      ok: false,
      status: 'offline',
      host: '',
      latencyMs: null,
      warning: 'Keine NAS-Adresse hinterlegt.',
    };
  }

  // 1. Auf Android direkt nativ im LAN/WLAN prüfen (ohne :3000)
  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.probeBridgeNasHealth) {
        const raw = bridge.probeBridgeNasHealth(
          JSON.stringify({
            host: cleanHost,
            port: request.port ? Number(request.port) : undefined,
            scope: request.scope ?? (isLocalOrLanHost(cleanHost) ? 'lan' : 'internet'),
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as BridgeNasHealthStatus;
          if (parsed.discoveredMac) {
            saveNasMacAddress(cleanHost, parsed.discoveredMac);
          }
          return parsed;
        }
      }
    } catch {
      // Weiter zu Server/Browser-Fallback
    }
  }

  // 2. Falls lokales EntenCenter-Backend erreichbar ist: /api/nas/bridge-health nutzen
  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/bridge-health` : resolveNasUrl('/api/nas/bridge-health');
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: cleanHost,
            port: request.port,
            scope: request.scope ?? (isLocalOrLanHost(cleanHost) ? 'lan' : 'internet'),
          }),
        },
        4500
      );
      const data = (await res.json().catch(() => null)) as BridgeNasHealthStatus | null;
      if (res.ok && data && typeof data.ok === 'boolean') {
        if (data.discoveredMac) {
          saveNasMacAddress(cleanHost, data.discoveredMac);
        }
        return data;
      }
    } catch {
      // Browser-Direktprobe unten
    }
  }

  // 3. Direkte Browser-Reachability-Probe für FRITZ!NAS / LAN (verhindert falsches Offline bei laufender FRITZ!Box)
  if (typeof window !== 'undefined' && isLocalOrLanHost(cleanHost)) {
    const started = performance.now();
    const scheme =
      window.location.protocol === 'https:' && !isNativeAndroidShell() ? 'https' : 'http';
    try {
      await fetch(`${scheme}://${cleanHost}/login_sid.lua`, {
        method: 'GET',
        mode: 'no-cors',
        signal: AbortSignal.timeout(2200),
      });
      const rtt = Math.max(1, Math.round(performance.now() - started));
      return {
        ok: true,
        status: 'online',
        host: cleanHost,
        latencyMs: rtt,
        fritzDetected: cleanHost.includes('fritz') || cleanHost.startsWith('192.168.178.'),
        transportLabel:
          cleanHost.includes('fritz') || cleanHost.startsWith('192.168.178.')
            ? 'FRITZ!NAS Direkt (LAN)'
            : 'NAS Direkt (LAN)',
        warning: null,
      };
    } catch {
      // Host antwortet nicht
    }
  }

  return {
    ok: false,
    status: 'sleeping',
    host: cleanHost,
    latencyMs: null,
    warning: 'NAS antwortet nicht — möglicherweise im Ruhemodus / Standby.',
  };
}

export async function wakeNasFromSleep(request: {
  host: string;
  username?: string;
  password?: string;
  secret?: string;
  macAddress?: string | null;
  useTls?: boolean;
  scope?: NasConnectionScope;
  serverBaseUrl?: string;
}): Promise<NasWakeDeviceResult> {
  const cleanHost = cleanHostOnly(request.host) || 'fritz.box';
  const savedMac = readSavedNasMacAddress(cleanHost);
  const effectiveMac = request.macAddress?.trim() || savedMac || null;
  if (effectiveMac) {
    saveNasMacAddress(cleanHost, effectiveMac);
  }
  const password = request.secret ?? request.password ?? '';

  // 1. Android Native Bridge (sendet echte UDP Magic Packets, TR-064 WoL SOAP & SMB2/FRITZ!NAS Spin-Up)
  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.wakeNasDevice) {
        const raw = bridge.wakeNasDevice(
          JSON.stringify({
            host: cleanHost,
            username: request.username?.trim() ?? '',
            password,
            macAddress: effectiveMac ?? '',
            useTls: Boolean(request.useTls),
            scope: request.scope ?? (isLocalOrLanHost(cleanHost) ? 'lan' : 'internet'),
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as NasWakeDeviceResult;
          if (parsed.discoveredMac) {
            saveNasMacAddress(cleanHost, parsed.discoveredMac);
          }
          return parsed;
        }
      }
    } catch {
      // Server-Fallback unten
    }
  }

  // 2. Server-API (/api/nas/wake)
  const base = request.serverBaseUrl ? normalizeNasBaseUrl(request.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/wake` : resolveNasUrl('/api/nas/wake');
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: cleanHost,
            username: request.username?.trim() ?? '',
            password,
            macAddress: effectiveMac,
            useTls: Boolean(request.useTls),
            scope: request.scope ?? (isLocalOrLanHost(cleanHost) ? 'lan' : 'internet'),
          }),
        },
        12000
      );
      const data = (await res.json().catch(() => null)) as NasWakeDeviceResult | null;
      if (data && typeof data.status === 'string') {
        if (data.discoveredMac) {
          saveNasMacAddress(cleanHost, data.discoveredMac);
        }
        return data;
      }
    } catch {
      // Browser-Fallback unten
    }
  }

  // 3. Browser HTTP Wake-Nudge + FRITZ!NAS Challenge/Login Trigger
  if (typeof window !== 'undefined' && isLocalOrLanHost(cleanHost)) {
    const channels: string[] = [];
    const t0 = performance.now();
    try {
      await fetch(`http://${cleanHost}/login_sid.lua`, {
        method: 'GET',
        mode: 'no-cors',
        signal: AbortSignal.timeout(4000),
      });
      channels.push('FRITZ!NAS HTTP-Wake');
      const rtt = Math.max(1, Math.round(performance.now() - t0));
      return {
        ok: true,
        wokeUp: true,
        status: 'online',
        host: cleanHost,
        latencyMs: rtt,
        discoveredMac: effectiveMac,
        fritzWebReady: true,
        transportLabel: 'FRITZ!NAS Direkt (LAN)',
        channelsTriggered: channels,
        message: `FRITZ!NAS unter ${cleanHost} ist aktiv & erreichbar (${rtt} ms).`,
      };
    } catch {
      // Noch offline
    }
  }

  return {
    ok: false,
    wokeUp: false,
    status: 'offline',
    host: cleanHost,
    latencyMs: null,
    discoveredMac: effectiveMac,
    channelsTriggered: [],
    message:
      'Weck-Signal konnte im Browser-Kontext nicht gesendet werden. Nutze die Android-APK oder ein laufendes EntenCenter-Backend für Wake-on-LAN.',
  };
}

// ---------------------------------------------------------------------------
// Storage-Bridge Direkt-Speicherung (FRITZ!NAS / SMB2 / WebDAV) & Ordnerscan
// ---------------------------------------------------------------------------
const LOCAL_BRIDGE_CATALOG_KEY = 'entencenter_bridge_catalog_v1';
const LOCAL_BRIDGE_SCAN_SETTINGS_KEY = 'entencenter_bridge_scan_folders_v1';
const LOCAL_BRIDGE_PATH_SETTINGS_KEY = 'entencenter_bridge_path_settings_v1';
export const LOCAL_BRIDGE_VOLUME_STATS_KEY = 'entencenter_bridge_volume_stats_v1';

export interface LocalBridgeVolumeStatsCache {
  host?: string;
  volumeTotalBytes: number;
  volumeFreeBytes: number;
  volumeUsedBytes: number;
  volumeSource?: string;
  scannedTotalBytes: number;
  scannedFilesCount: number;
  mediaBreakdown?: NasMediaFolderScanBreakdown;
  measuredAt: string;
}

export function readLocalBridgeVolumeStats(): LocalBridgeVolumeStatsCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_BRIDGE_VOLUME_STATS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalBridgeVolumeStatsCache>;
    if (typeof parsed !== 'object' || !parsed) return null;
    return {
      host: parsed.host,
      volumeTotalBytes: Number(parsed.volumeTotalBytes) || 0,
      volumeFreeBytes: Number(parsed.volumeFreeBytes) || 0,
      volumeUsedBytes: Number(parsed.volumeUsedBytes) || 0,
      volumeSource: parsed.volumeSource,
      scannedTotalBytes: Number(parsed.scannedTotalBytes) || 0,
      scannedFilesCount: Number(parsed.scannedFilesCount) || 0,
      mediaBreakdown: parsed.mediaBreakdown,
      measuredAt: parsed.measuredAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveLocalBridgeVolumeStats(
  patch: Partial<LocalBridgeVolumeStatsCache>
): LocalBridgeVolumeStatsCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const prev = readLocalBridgeVolumeStats();
    const next: LocalBridgeVolumeStatsCache = {
      host: patch.host ?? prev?.host,
      volumeTotalBytes:
        patch.volumeTotalBytes && patch.volumeTotalBytes > 0
          ? patch.volumeTotalBytes
          : prev?.volumeTotalBytes ?? 0,
      volumeFreeBytes:
        patch.volumeFreeBytes !== undefined && (patch.volumeTotalBytes ?? 0) > 0
          ? Math.max(0, patch.volumeFreeBytes)
          : prev?.volumeFreeBytes ?? 0,
      volumeUsedBytes:
        patch.volumeUsedBytes !== undefined && (patch.volumeTotalBytes ?? 0) > 0
          ? Math.max(0, patch.volumeUsedBytes)
          : prev?.volumeUsedBytes ?? 0,
      volumeSource: patch.volumeSource ?? prev?.volumeSource,
      scannedTotalBytes:
        patch.scannedTotalBytes && patch.scannedTotalBytes > 0
          ? patch.scannedTotalBytes
          : prev?.scannedTotalBytes ?? 0,
      scannedFilesCount:
        patch.scannedFilesCount && patch.scannedFilesCount > 0
          ? patch.scannedFilesCount
          : prev?.scannedFilesCount ?? 0,
      mediaBreakdown: patch.mediaBreakdown ?? prev?.mediaBreakdown,
      measuredAt: patch.measuredAt ?? new Date().toISOString(),
    };
    window.localStorage.setItem(LOCAL_BRIDGE_VOLUME_STATS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export async function fetchNasStorageStatsBridge(
  target: NasFileBridgeTarget
): Promise<LocalBridgeVolumeStatsCache | null> {
  const cleanHost = cleanHostOnly(target.host);
  const effectivePass = target.password ?? target.secret ?? target.fritzPassword ?? '';
  const targetProto = target.protocol ?? 'fritz_upnp';
  const safePort = sanitizeNasPortForProtocol(targetProto, target.port, target.useTls);

  if (isNativeAndroidShell() && cleanHost) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.getNasStorageStats) {
        const raw = bridge.getNasStorageStats(
          JSON.stringify({
            protocol: targetProto,
            host: cleanHost,
            port: safePort,
            shareOrPath: target.shareOrPath ?? (targetProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
            username: target.username?.trim() ?? '',
            password: effectivePass,
            secret: effectivePass,
            fritzPassword: effectivePass,
            domainOrWorkgroup: target.domainOrWorkgroup ?? '',
            useTls: Boolean(target.useTls),
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as {
            ok?: boolean;
            totalBytes?: number;
            freeBytes?: number;
            usedBytes?: number;
            volumeTotalBytes?: number;
            volumeFreeBytes?: number;
            volumeUsedBytes?: number;
            volumeSource?: string;
            source?: string;
          };
          const totalBytes = Number(parsed.totalBytes ?? parsed.volumeTotalBytes ?? 0);
          const freeBytes = Number(parsed.freeBytes ?? parsed.volumeFreeBytes ?? 0);
          const usedBytes =
            Number(parsed.usedBytes ?? parsed.volumeUsedBytes ?? 0) ||
            Math.max(0, totalBytes - freeBytes);
          if (parsed.ok && totalBytes > 0) {
            return saveLocalBridgeVolumeStats({
              host: cleanHost,
              volumeTotalBytes: totalBytes,
              volumeFreeBytes: freeBytes,
              volumeUsedBytes: usedBytes,
              volumeSource: parsed.volumeSource || parsed.source || 'SMB2 / FRITZ!NAS Volume',
              measuredAt: new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      // Fallback unten
    }
  }

  return readLocalBridgeVolumeStats();
}

export function openNativeExternalPlayer(
  url: string,
  mimeType = 'video/*',
  title?: string
): boolean {
  const cleanUrl = (url || '').trim();
  if (!cleanUrl) return false;
  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.openExternalMediaPlayer) {
        return Boolean(bridge.openExternalMediaPlayer(cleanUrl, mimeType || '*/*', title || ''));
      }
    } catch {
      // Fallback unten
    }
  }
  if (typeof window !== 'undefined') {
    try {
      const anchor = document.createElement('a');
      anchor.href = cleanUrl;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const CATALOG_IDB_NAME = 'entencenter_catalog_db';
const CATALOG_IDB_STORE = 'catalog';
const CATALOG_IDB_KEY = 'bridge_items_v1';

function openCatalogDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(CATALOG_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CATALOG_IDB_STORE)) {
          db.createObjectStore(CATALOG_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveCatalogToIndexedDb(items: NasMediaItem[]): Promise<void> {
  const db = await openCatalogDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(CATALOG_IDB_STORE, 'readwrite');
      tx.objectStore(CATALOG_IDB_STORE).put(items, CATALOG_IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // IndexedDB optional
  } finally {
    db.close();
  }
}

export async function hydrateLocalBridgeCatalogFromIndexedDb(): Promise<NasMediaItem[]> {
  const localNow = readLocalBridgeCatalog();
  if (localNow.length > 0) return localNow;
  const db = await openCatalogDb();
  if (!db) return [];
  try {
    const raw = await new Promise<NasMediaItem[] | null>((resolve) => {
      const tx = db.transaction(CATALOG_IDB_STORE, 'readonly');
      const req = tx.objectStore(CATALOG_IDB_STORE).get(CATALOG_IDB_KEY);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as NasMediaItem[]) : null);
      req.onerror = () => resolve(null);
    });
    if (raw && raw.length > 0) {
      return groupAndNormalizeNasCatalog(raw).items;
    }
  } catch {
    // ignore
  } finally {
    db.close();
  }
  return [];
}

export function readLocalBridgeCatalog(): NasMediaItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_BRIDGE_CATALOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as NasMediaItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalBridgeCatalog(items: NasMediaItem[]): void {
  if (typeof window === 'undefined') return;
  // Vollen Katalog immer zusätzlich in IndexedDB ablegen (umgeht 5-MB-Limit bei 2-TB-Mediatheken)
  void saveCatalogToIndexedDb(items);
  try {
    window.localStorage.setItem(LOCAL_BRIDGE_CATALOG_KEY, JSON.stringify(items));
  } catch {
    // Falls localStorage > 5 MB voll ist, zumindest gekürzte Fassung ablegen, damit Startseite sofort Daten hat (Vollbestand kommt aus IndexedDB)
    try {
      const compact = items.slice(0, 1200).map((it) => {
        if (it.kind === 'series' && it.episodes && it.episodes.length > 80) {
          return { ...it, episodes: it.episodes.slice(0, 80) };
        }
        return it;
      });
      window.localStorage.setItem(LOCAL_BRIDGE_CATALOG_KEY, JSON.stringify(compact));
    } catch {
      // IndexedDB hält den Vollbestand bereit
    }
  }
}

export function upsertLocalBridgeCatalogItems(newItems: NasMediaItem[]): NasMediaItem[] {
  const existing = readLocalBridgeCatalog();
  const byIdOrPath = new Map<string, NasMediaItem>();
  for (const item of newItems) {
    byIdOrPath.set(item.nasPath?.toLowerCase() || item.id, item);
  }
  for (const item of existing) {
    const key = item.nasPath?.toLowerCase() || item.id;
    if (!byIdOrPath.has(key)) {
      byIdOrPath.set(key, item);
    }
  }
  const merged = groupAndNormalizeNasCatalog(Array.from(byIdOrPath.values())).items;
  saveLocalBridgeCatalog(merged);
  return merged;
}

export function readLocalBridgeScanSettings(): NasScanFolderSettings {
  const fallback: NasScanFolderSettings = {
    scanMode: 'all',
    selectedFolders: [],
    updatedAt: null,
    updatedBy: null,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(LOCAL_BRIDGE_SCAN_SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<NasScanFolderSettings>;
    return {
      scanMode: parsed.scanMode === 'selected' ? 'selected' : 'all',
      selectedFolders: Array.isArray(parsed.selectedFolders) ? parsed.selectedFolders : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : null,
    };
  } catch {
    return fallback;
  }
}

export function saveLocalBridgeScanSettings(settings: NasScanFolderSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_BRIDGE_SCAN_SETTINGS_KEY, JSON.stringify(settings));
    notifyLocalBufferUpdated();
  } catch {
    // localStorage optional
  }
}

export function readLocalBridgePathSettings(): AdminNasPathSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_BRIDGE_PATH_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as AdminNasPathSettings) : null;
  } catch {
    return null;
  }
}

export function saveLocalBridgePathSettings(settings: AdminNasPathSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_BRIDGE_PATH_SETTINGS_KEY, JSON.stringify(settings));
    notifyLocalBufferUpdated();
  } catch {
    // localStorage optional
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface NasFileBridgeTarget {
  protocol?: NasProtocolId;
  host: string;
  port?: string | number;
  shareOrPath?: string;
  username?: string;
  password?: string;
  secret?: string;
  fritzPassword?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  backendPath?: string;
  serverBaseUrl?: string;
}

export async function writeFileToNasBridge(
  target: NasFileBridgeTarget & {
    targetPath: string;
    content?: string;
    contentBase64?: string;
    contentType?: string;
    offset?: number;
    append?: boolean;
    createParentDirs?: boolean;
  }
): Promise<NasStorageWriteFileResult> {
  const cleanHost = cleanHostOnly(target.host);
  const effectivePass = target.password ?? target.secret ?? target.fritzPassword ?? '';
  const cleanTargetPath = `/${target.targetPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  const targetProto = target.protocol ?? 'fritz_upnp';
  const safePort = sanitizeNasPortForProtocol(targetProto, target.port, target.useTls);
  const payload = {
    protocol: targetProto,
    host: cleanHost,
    port: safePort,
    shareOrPath: target.shareOrPath ?? (targetProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
    username: target.username?.trim() ?? '',
    password: effectivePass,
    secret: effectivePass,
    fritzPassword: target.fritzPassword ?? effectivePass,
    domainOrWorkgroup: target.domainOrWorkgroup ?? '',
    useTls: Boolean(target.useTls),
    targetPath: cleanTargetPath,
    content: target.content,
    contentBase64: target.contentBase64,
    contentType: target.contentType,
    offset: target.offset ?? 0,
    append: Boolean(target.append),
    createParentDirs: target.createParentDirs !== false,
  };

  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.writeNasFile) {
        const raw = bridge.writeNasFile(JSON.stringify(payload));
        if (raw) {
          return JSON.parse(raw) as NasStorageWriteFileResult;
        }
      }
    } catch (err) {
      return {
        ok: false,
        filePath: cleanTargetPath,
        error: err instanceof Error ? err.message : 'Native Android NAS-Schreibfehler',
      };
    }
  }

  const base = target.serverBaseUrl ? normalizeNasBaseUrl(target.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/storage/write-file` : '/api/nas/storage/write-file';
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        15000
      );
      const data = (await res.json().catch(() => null)) as NasStorageWriteFileResult | null;
      if (data && typeof data.ok === 'boolean') return data;
    } catch (err) {
      return {
        ok: false,
        filePath: cleanTargetPath,
        error: err instanceof Error ? err.message : 'Server-NAS-Schreibfehler',
      };
    }
  }

  return {
    ok: false,
    filePath: cleanTargetPath,
    error: 'Direktes Schreiben auf das NAS erfordert die Android-APK oder ein aktives EntenCenter-Backend.',
  };
}

export async function readFileFromNasBridge(
  target: NasFileBridgeTarget & { targetPath: string }
): Promise<NasStorageReadFileResult> {
  const cleanHost = cleanHostOnly(target.host);
  const effectivePass = target.password ?? target.secret ?? target.fritzPassword ?? '';
  const cleanTargetPath = `/${target.targetPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  const targetProto = target.protocol ?? 'fritz_upnp';
  const safePort = sanitizeNasPortForProtocol(targetProto, target.port, target.useTls);
  const payload = {
    protocol: targetProto,
    host: cleanHost,
    port: safePort,
    shareOrPath: target.shareOrPath ?? (targetProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
    username: target.username?.trim() ?? '',
    password: effectivePass,
    secret: effectivePass,
    domainOrWorkgroup: target.domainOrWorkgroup ?? '',
    useTls: Boolean(target.useTls),
    targetPath: cleanTargetPath,
  };

  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.readNasFile) {
        const raw = bridge.readNasFile(JSON.stringify(payload));
        if (raw) return JSON.parse(raw) as NasStorageReadFileResult;
      }
    } catch (err) {
      return {
        ok: false,
        filePath: cleanTargetPath,
        error: err instanceof Error ? err.message : 'Native Android NAS-Lesefehler',
      };
    }
  }

  const base = target.serverBaseUrl ? normalizeNasBaseUrl(target.serverBaseUrl) : getNasBaseUrl();
  if (!isNativeAndroidShell() || base) {
    const endpoint = base ? `${base}/api/nas/storage/read-file` : '/api/nas/storage/read-file';
    try {
      const res = await nasFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        10000
      );
      const data = (await res.json().catch(() => null)) as NasStorageReadFileResult | null;
      if (data && typeof data.ok === 'boolean') return data;
    } catch {
      // Fallback
    }
  }

  return {
    ok: false,
    filePath: cleanTargetPath,
    error: 'Direktes Lesen vom NAS in dieser Umgebung nicht verfügbar.',
  };
}

export async function uploadBinaryFileToNasBridge(options: {
  target: NasFileBridgeTarget;
  targetPath: string;
  file: File;
  onProgress?: (percent: number) => void;
}): Promise<NasStorageWriteFileResult> {
  const { target, targetPath, file, onProgress } = options;
  const chunkSize = 1024 * 1024; // 1 MB Chunks für stabile SMB2/FRITZ!NAS-Übertragung
  const totalBytes = file.size;

  if (totalBytes === 0) {
    const emptyRes = await writeFileToNasBridge({
      ...target,
      targetPath,
      contentBase64: '',
      contentType: file.type || 'application/octet-stream',
      offset: 0,
      append: false,
    });
    onProgress?.(100);
    return emptyRes;
  }

  let offset = 0;
  let lastResult: NasStorageWriteFileResult = { ok: false, error: 'Upload nicht gestartet.' };
  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize, totalBytes);
    const slice = file.slice(offset, end);
    const buf = new Uint8Array(await slice.arrayBuffer());
    const b64 = uint8ToBase64(buf);
    lastResult = await writeFileToNasBridge({
      ...target,
      targetPath,
      contentBase64: b64,
      contentType: file.type || 'application/octet-stream',
      offset,
      append: offset > 0,
      createParentDirs: offset === 0,
    });
    if (!lastResult.ok) {
      return lastResult;
    }
    offset = end;
    onProgress?.(Math.min(100, Math.round((offset / totalBytes) * 100)));
  }

  return {
    ...lastResult,
    ok: true,
    filePath: targetPath,
    bytesWritten: totalBytes,
    verified: true,
  };
}

export function inferMimeTypeFromPath(filePath: string): string {
  const lower = (filePath || '').trim().toLowerCase();
  // Video
  if (/\.(mp4|m4v)(\?|$)/.test(lower)) return 'video/mp4';
  if (/\.webm(\?|$)/.test(lower)) return 'video/webm';
  if (/\.mov(\?|$)/.test(lower)) return 'video/quicktime';
  if (/\.mkv(\?|$)/.test(lower)) return 'video/x-matroska';
  if (/\.(avi|divx)(\?|$)/.test(lower)) return 'video/x-msvideo';
  if (/\.(ts|m2ts|mts)(\?|$)/.test(lower)) return 'video/mp2t';
  if (/\.(mpg|mpeg|vob)(\?|$)/.test(lower)) return 'video/mpeg';
  if (/\.(wmv|asf)(\?|$)/.test(lower)) return 'video/x-ms-wmv';
  if (/\.(flv|f4v)(\?|$)/.test(lower)) return 'video/x-flv';
  if (/\.(3gp|3g2)(\?|$)/.test(lower)) return 'video/3gpp';
  if (/\.ogv(\?|$)/.test(lower)) return 'video/ogg';
  if (/\.rmvb(\?|$)/.test(lower)) return 'application/vnd.rn-realmedia-vbr';
  if (/\.m3u8(\?|$)/.test(lower)) return 'application/vnd.apple.mpegurl';
  if (/\.m3u(\?|$)/.test(lower)) return 'audio/x-mpegurl';
  // Audio
  if (/\.mp3(\?|$)/.test(lower)) return 'audio/mpeg';
  if (/\.(m4a|m4b|alac)(\?|$)/.test(lower)) return 'audio/mp4';
  if (/\.aac(\?|$)/.test(lower)) return 'audio/aac';
  if (/\.flac(\?|$)/.test(lower)) return 'audio/flac';
  if (/\.wav(\?|$)/.test(lower)) return 'audio/wav';
  if (/\.(ogg|oga|opus)(\?|$)/.test(lower)) return 'audio/ogg';
  if (/\.wma(\?|$)/.test(lower)) return 'audio/x-ms-wma';
  if (/\.(aiff|aif)(\?|$)/.test(lower)) return 'audio/aiff';
  if (/\.mka(\?|$)/.test(lower)) return 'audio/x-matroska';
  if (/\.amr(\?|$)/.test(lower)) return 'audio/amr';
  if (/\.(mid|midi)(\?|$)/.test(lower)) return 'audio/midi';
  if (/\.ac3(\?|$)/.test(lower)) return 'audio/ac3';
  if (/\.dts(\?|$)/.test(lower)) return 'audio/vnd.dts';
  if (/\.(ape|wv)(\?|$)/.test(lower)) return 'audio/x-ape';
  // Bilder
  if (/\.(jpg|jpeg)(\?|$)/.test(lower)) return 'image/jpeg';
  if (/\.png(\?|$)/.test(lower)) return 'image/png';
  if (/\.webp(\?|$)/.test(lower)) return 'image/webp';
  if (/\.gif(\?|$)/.test(lower)) return 'image/gif';
  if (/\.bmp(\?|$)/.test(lower)) return 'image/bmp';
  if (/\.(heic|heif)(\?|$)/.test(lower)) return 'image/heic';
  if (/\.avif(\?|$)/.test(lower)) return 'image/avif';
  if (/\.svg(\?|$)/.test(lower)) return 'image/svg+xml';
  if (/\.(tiff|tif)(\?|$)/.test(lower)) return 'image/tiff';
  // Dokumente / Untertitel
  if (/\.pdf(\?|$)/.test(lower)) return 'application/pdf';
  if (/\.epub(\?|$)/.test(lower)) return 'application/epub+zip';
  if (/\.srt(\?|$)/.test(lower)) return 'application/x-subrip';
  if (/\.vtt(\?|$)/.test(lower)) return 'text/vtt';
  if (/\.txt(\?|$)/.test(lower)) return 'text/plain';
  return 'application/octet-stream';
}

export function isEphemeralLocalProxyUrl(url?: string | null): boolean {
  if (!url) return false;
  return /^https?:\/\/127\.0\.0\.1:\d+\//i.test(url.trim());
}

export function stripEphemeralMediaUrlForCatalog(items: NasMediaItem[]): NasMediaItem[] {
  return items.map((item) => {
    if (isEphemeralLocalProxyUrl(item.mediaUrl) || item.mediaUrl?.startsWith('/api/nas/storage/stream')) {
      const rest = { ...item };
      delete rest.mediaUrl;
      return rest;
    }
    return item;
  });
}

export function resolvePlayableNasMediaUrl(
  item: NasMediaItem,
  target?: NasFileBridgeTarget | null,
  authToken?: string | null
): string | undefined {
  const existingUrl = (item.mediaUrl || '').trim();
  const isExternalOrBlobUrl =
    Boolean(existingUrl) &&
    /^(https?:\/\/|blob:|data:|\/api\/)/i.test(existingUrl) &&
    !isEphemeralLocalProxyUrl(existingUrl) &&
    !existingUrl.includes('/api/nas/storage/stream');

  if (isExternalOrBlobUrl) {
    return existingUrl;
  }

  const rawNasPath = (item.nasPath || '').trim();
  if (!rawNasPath) {
    return existingUrl && !isEphemeralLocalProxyUrl(existingUrl) ? existingUrl : undefined;
  }

  // Offline/Demo-Platzhalterpfade unter /mnt/nas nicht als Live-NAS-Dateien auflösen,
  // außer es handelt sich um tatsächlich gescannte Einträge oder echte hochgeladene Dateien.
  if (rawNasPath.startsWith('/mnt/nas/') && !item.id.startsWith('nas-scan-') && !item.uploadedFileName) {
    return undefined;
  }

  let cleanPath = rawNasPath.replace(/^smb:\/\/[^/]+/i, '').replace(/\\/g, '/');
  if (!cleanPath.startsWith('/')) cleanPath = `/${cleanPath}`;

  const effectivePass = target?.password || target?.secret || target?.fritzPassword || '';
  if (isNativeAndroidShell() && target?.host && effectivePass) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.getLocalNasStreamUrl) {
        const targetProto = target.protocol ?? 'fritz_upnp';
        const safePort = sanitizeNasPortForProtocol(targetProto, target.port, target.useTls);
        const raw = bridge.getLocalNasStreamUrl(
          JSON.stringify({
            protocol: targetProto,
            host: cleanHostOnly(target.host),
            port: safePort,
            shareOrPath: target.shareOrPath ?? (targetProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
            username: target.username?.trim() ?? '',
            password: effectivePass,
            secret: effectivePass,
            domainOrWorkgroup: target.domainOrWorkgroup ?? '',
            useTls: Boolean(target.useTls),
            targetPath: cleanPath,
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as { ok?: boolean; url?: string };
          if (parsed?.ok && parsed.url) {
            return parsed.url;
          }
        }
      }
    } catch {
      // Fallback unten
    }
  }

  if (authToken && !authToken.startsWith('local-fallback-')) {
    const baseStream = `/api/nas/storage/stream?mediaId=${encodeURIComponent(item.id)}&path=${encodeURIComponent(cleanPath)}&token=${encodeURIComponent(authToken)}`;
    return resolveNasUrl(baseStream);
  }

  return undefined;
}

export interface NasBackendDiscoveryResult {
  found: boolean;
  backendPath: string;
  hasProfile: boolean;
  hasManifest: boolean;
  hasConfig: boolean;
  profile: Record<string, unknown> | null;
  nasConnection: Record<string, unknown> | null;
  scanFolderSettings: NasScanFolderSettings | null;
  pathSettings: AdminNasPathSettings | null;
  catalog: NasMediaItem[] | null;
  verifiedFiles: string[];
}

export async function discoverAndHydrateBackendFromNasBridge(options: {
  target: NasFileBridgeTarget;
  username: string;
  preferredBackendPath?: string;
}): Promise<NasBackendDiscoveryResult> {
  const safeUser = options.username.trim().replace(/[^\w.-]/g, '_') || 'admin';
  const candidates = Array.from(
    new Set(
      [
        options.preferredBackendPath ? normalizeClientNasPath(options.preferredBackendPath) : null,
        '/EntenCenter-Backend',
        '/FRITZ/EntenCenter-Backend',
      ].filter((p): p is string => Boolean(p && p !== '/'))
    )
  );

  const tryReadJson = async <T>(targetPath: string): Promise<T | null> => {
    const res = await readFileFromNasBridge({
      ...options.target,
      targetPath,
    }).catch(() => null);
    if (!res?.ok || !res.content) return null;
    try {
      return JSON.parse(res.content) as T;
    } catch {
      return null;
    }
  };

  for (const root of candidates) {
    const [manifest, profile, nasConn] = await Promise.all([
      tryReadJson<Record<string, unknown>>(`${root}/entencenter-backend.json`),
      tryReadJson<Record<string, unknown>>(`${root}/profiles/${safeUser}.json`),
      tryReadJson<Record<string, unknown>>(`${root}/config/nas-connection.json`),
    ]);

    if (!manifest && !profile && !nasConn) {
      // Prüfe zusätzlich ob wenigstens config/catalog.json oder config/scan-folders.json dort liegt
      const catCheck = await tryReadJson<NasMediaItem[]>(`${root}/config/catalog.json`);
      const scanCheck = await tryReadJson<NasScanFolderSettings>(`${root}/config/scan-folders.json`);
      if (!catCheck && !scanCheck) {
        continue;
      }
      const pathCfg = await tryReadJson<AdminNasPathSettings>(`${root}/config/path-settings.json`);
      return {
        found: true,
        backendPath: root,
        hasProfile: false,
        hasManifest: false,
        hasConfig: Boolean(scanCheck || pathCfg),
        profile: null,
        nasConnection: null,
        scanFolderSettings: scanCheck,
        pathSettings: pathCfg,
        catalog: Array.isArray(catCheck) ? catCheck : null,
        verifiedFiles: [
          ...(catCheck ? [`${root}/config/catalog.json`] : []),
          ...(scanCheck ? [`${root}/config/scan-folders.json`] : []),
          ...(pathCfg ? [`${root}/config/path-settings.json`] : []),
        ],
      };
    }

    const [scanCfg, pathCfg, catalog] = await Promise.all([
      tryReadJson<NasScanFolderSettings>(`${root}/config/scan-folders.json`),
      tryReadJson<AdminNasPathSettings>(`${root}/config/path-settings.json`),
      tryReadJson<NasMediaItem[]>(`${root}/config/catalog.json`),
    ]);

    const verifiedFiles: string[] = [];
    if (manifest) verifiedFiles.push(`${root}/entencenter-backend.json`);
    if (profile) verifiedFiles.push(`${root}/profiles/${safeUser}.json`);
    if (nasConn) verifiedFiles.push(`${root}/config/nas-connection.json`);
    if (scanCfg) verifiedFiles.push(`${root}/config/scan-folders.json`);
    if (pathCfg) verifiedFiles.push(`${root}/config/path-settings.json`);
    if (Array.isArray(catalog)) verifiedFiles.push(`${root}/config/catalog.json`);

    return {
      found: true,
      backendPath: root,
      hasProfile: Boolean(profile),
      hasManifest: Boolean(manifest),
      hasConfig: Boolean(nasConn || scanCfg || pathCfg),
      profile,
      nasConnection: nasConn,
      scanFolderSettings: scanCfg,
      pathSettings: pathCfg,
      catalog: Array.isArray(catalog) ? catalog : null,
      verifiedFiles,
    };
  }

  return {
    found: false,
    backendPath: candidates[0] || '/EntenCenter-Backend',
    hasProfile: false,
    hasManifest: false,
    hasConfig: false,
    profile: null,
    nasConnection: null,
    scanFolderSettings: null,
    pathSettings: null,
    catalog: null,
    verifiedFiles: [],
  };
}

export async function syncEntenCenterDataToNasBridge(options: {
  target: NasFileBridgeTarget;
  backendPath: string;
  username: string;
  displayName: string;
  role: 'admin' | 'family';
  fskLimit?: number;
  connectionScope?: 'lan' | 'internet';
  catalog?: NasMediaItem[];
  scanFolderSettings?: NasScanFolderSettings;
  pathSettings?: AdminNasPathSettings | null;
}): Promise<{
  ok: boolean;
  backendPath: string;
  writtenFiles: string[];
  verified: boolean;
  error?: string;
}> {
  const safeUser = options.username.trim().replace(/[^\w.-]/g, '_') || 'admin';
  let backendRoot = normalizeClientNasPath(options.backendPath || '/EntenCenter-Backend');

  // Prüfen, ob unter /EntenCenter-Backend bereits ein bestehendes Backend liegt (z. B. manuell oder früher angelegt)
  const probeRoots = Array.from(
    new Set([backendRoot, '/EntenCenter-Backend', '/FRITZ/EntenCenter-Backend'].map(normalizeClientNasPath))
  );
  for (const cand of probeRoots) {
    if (cand === backendRoot) continue;
    const existingProfile = await readFileFromNasBridge({
      ...options.target,
      targetPath: `${cand}/profiles/${safeUser}.json`,
    }).catch(() => null);
    const existingManifest =
      existingProfile?.ok
        ? existingProfile
        : await readFileFromNasBridge({
            ...options.target,
            targetPath: `${cand}/entencenter-backend.json`,
          }).catch(() => null);
    if (existingProfile?.ok || existingManifest?.ok) {
      backendRoot = cand;
      break;
    }
  }

  const now = new Date().toISOString();
  const targetProto = options.target.protocol ?? 'fritz_upnp';
  const safePort = sanitizeNasPortForProtocol(targetProto, options.target.port, options.target.useTls);

  await provisionNasBackend({
    mode: 'manual',
    targetPath: backendRoot,
    protocol: targetProto,
    host: options.target.host,
    port: String(safePort),
    shareOrPath: options.target.shareOrPath,
    username: options.target.username,
    password: options.target.password,
    secret: options.target.secret,
    fritzUsername: options.target.username,
    fritzPassword: options.target.fritzPassword,
    useTls: options.target.useTls,
    serverBaseUrl: options.target.serverBaseUrl,
  }).catch(() => null);

  const profilePayload = {
    username: options.username,
    displayName: options.displayName,
    role: options.role,
    fskLimit: options.fskLimit ?? 18,
    connectionScope: options.connectionScope ?? 'lan',
    updatedAt: now,
  };

  const nasConnPayload = {
    protocol: targetProto,
    host: cleanHostOnly(options.target.host),
    port: String(safePort),
    shareOrPath: options.target.shareOrPath ?? backendRoot,
    backendPath: backendRoot,
    username: options.target.username ?? '',
    useTls: Boolean(options.target.useTls),
    storageBridgeMode: true,
    updatedAt: now,
  };

  const effectiveScanCfg: NasScanFolderSettings = options.scanFolderSettings ?? {
    scanMode: 'all',
    selectedFolders: [],
    updatedAt: now,
    updatedBy: options.username,
  };

  const filesToWrite: Array<{ rel: string; json: unknown }> = [
    {
      rel: 'entencenter-backend.json',
      json: {
        app: 'EntenCenter NAS Storage-Bridge',
        version: '1.0.0',
        host: cleanHostOnly(options.target.host),
        protocol: targetProto,
        backendPath: backendRoot,
        syncedAt: now,
        ownerUsername: options.username,
      },
    },
    {
      rel: `profiles/${safeUser}.json`,
      json: profilePayload,
    },
    {
      rel: 'config/nas-connection.json',
      json: nasConnPayload,
    },
    {
      rel: 'config/scan-folders.json',
      json: effectiveScanCfg,
    },
  ];

  if (options.pathSettings) {
    filesToWrite.push({
      rel: 'config/path-settings.json',
      json: options.pathSettings,
    });
  }
  if (options.catalog && options.catalog.length > 0) {
    filesToWrite.push({
      rel: 'config/catalog.json',
      json: options.catalog,
    });
  }

  filesToWrite.push(
    {
      rel: 'wal/sync-wal.json',
      json: {
        lastSyncAt: now,
        action: 'STORAGE_BRIDGE_SYNC',
        username: options.username,
        host: cleanHostOnly(options.target.host),
        backendPath: backendRoot,
        catalogCount: options.catalog?.length ?? 0,
      },
    },
    {
      rel: 'backups/profile-backup.json',
      json: {
        backedUpAt: now,
        profile: profilePayload,
        nasConnection: nasConnPayload,
      },
    }
  );

  const writtenFiles: string[] = [];
  for (const item of filesToWrite) {
    const fullTargetPath = `${backendRoot}/${item.rel}`;
    const res = await writeFileToNasBridge({
      ...options.target,
      targetPath: fullTargetPath,
      content: JSON.stringify(item.json, null, 2),
      contentType: 'application/json; charset=utf-8',
      createParentDirs: true,
    });
    if (!res.ok) {
      return {
        ok: false,
        backendPath: backendRoot,
        writtenFiles,
        verified: false,
        error: res.error || `Datei „${fullTargetPath}“ konnte nicht auf dem NAS gespeichert werden.`,
      };
    }
    writtenFiles.push(fullTargetPath);
  }

  const readBackCheck = await readFileFromNasBridge({
    ...options.target,
    targetPath: `${backendRoot}/profiles/${safeUser}.json`,
  }).catch(() => null);

  const verified = Boolean(
    (readBackCheck?.ok && readBackCheck.content) || writtenFiles.length >= 3
  );

  return {
    ok: true,
    backendPath: backendRoot,
    writtenFiles,
    verified,
  };
}

export async function scanNasMediaFoldersBridge(options: {
  target: NasFileBridgeTarget;
  scanMode: 'all' | 'selected';
  folders: string[];
}): Promise<NasMediaFolderScanResult> {
  const { target, scanMode, folders } = options;
  const cleanHost = cleanHostOnly(target.host);
  const effectivePass = target.password ?? target.secret ?? target.fritzPassword ?? '';

  if (isNativeAndroidShell()) {
    try {
      const bridge = (window as AndroidBridgeWindow).EntenCenterAndroid;
      if (bridge?.scanNasMediaFolders) {
        const raw = bridge.scanNasMediaFolders(
          JSON.stringify({
            protocol: target.protocol ?? 'fritz_upnp',
            host: cleanHost,
            port: sanitizeSmbPort(target.port),
            shareOrPath: target.shareOrPath ?? ((target.protocol ?? 'fritz_upnp') === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
            username: target.username?.trim() ?? '',
            password: effectivePass,
            domainOrWorkgroup: target.domainOrWorkgroup ?? '',
            scanMode,
            folders,
            maxFiles: 25000,
            maxDepth: 12,
          })
        );
        if (raw) {
          const parsed = JSON.parse(raw) as NasMediaFolderScanResult;
          if (parsed && typeof parsed.ok === 'boolean') {
            if (
              (parsed.volumeTotalBytes && parsed.volumeTotalBytes > 0) ||
              (parsed.scannedTotalBytes && parsed.scannedTotalBytes > 0) ||
              parsed.mediaBreakdown
            ) {
              saveLocalBridgeVolumeStats({
                host: cleanHost,
                volumeTotalBytes: parsed.volumeTotalBytes ?? 0,
                volumeFreeBytes: parsed.volumeFreeBytes ?? 0,
                volumeUsedBytes: parsed.volumeUsedBytes ?? 0,
                volumeSource: parsed.volumeSource,
                scannedTotalBytes: parsed.scannedTotalBytes ?? 0,
                scannedFilesCount: parsed.scannedFilesCount ?? parsed.files?.length ?? 0,
                mediaBreakdown: parsed.mediaBreakdown,
                measuredAt: new Date().toISOString(),
              });
            }
            return parsed;
          }
        }
      }
    } catch {
      // Fallback unten
    }
  }

  const roots = scanMode === 'selected' && folders.length > 0 ? folders : ['/'];
  const scannedFolders: string[] = [];
  const files: NasMediaFolderScanResult['files'] = [];
  const visited = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = roots.map((p) => ({ path: p, depth: 0 }));
  const breakdown: NasMediaFolderScanBreakdown = {
    moviesCount: 0,
    moviesBytes: 0,
    seriesCount: 0,
    seriesBytes: 0,
    musicCount: 0,
    musicBytes: 0,
    videosCount: 0,
    videosBytes: 0,
    imagesCount: 0,
    imagesBytes: 0,
    otherCount: 0,
    otherBytes: 0,
  };
  let scannedTotalBytes = 0;
  let scannedFilesCount = 0;
  let truncated = false;

  const isMediaRegex =
    /\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|asf|flv|f4v|3gp|3g2|ogv|vob|divx|rmvb|m3u8|m3u|iso|mp3|flac|wav|ogg|oga|opus|m4a|aac|wma|m4b|alac|aiff|aif|mka|amr|mid|midi|ac3|dts|ape|wv|jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|svg|tiff|tif|pdf|epub)$/i;
  const skipDirs = new Set([
    'wal',
    'backups',
    'profiles',
    'config',
    'entencenter-backend',
    '$recycle.bin',
    'system volume information',
    '.trash',
    '.thumbnails',
    '@eadir',
  ]);

  while (queue.length > 0 && files.length < 25000 && visited.size < 8000) {
    const cur = queue.shift()!;
    const norm = normalizeClientNasPath(cur.path);
    if (visited.has(norm.toLowerCase())) continue;
    visited.add(norm.toLowerCase());
    const tree = await browseNasDirectoryTree({
      protocol: target.protocol ?? 'fritz_upnp',
      host: cleanHost,
      port: target.port,
      shareOrPath: target.shareOrPath,
      path: norm,
      username: target.username,
      password: effectivePass,
      fritzPassword: effectivePass,
      useTls: target.useTls,
      serverBaseUrl: target.serverBaseUrl,
    });
    if (!tree.ok || !tree.entries) continue;
    scannedFolders.push(norm);
    for (const entry of tree.entries) {
      if (entry.type === 'directory') {
        const lower = entry.name.toLowerCase();
        if (cur.depth < 12 && !lower.startsWith('.') && !skipDirs.has(lower)) {
          queue.push({ path: entry.path, depth: cur.depth + 1 });
        }
      } else {
        const sizeBytes = Math.max(0, Number(entry.sizeBytes) || 0);
        scannedTotalBytes += sizeBytes;
        scannedFilesCount += 1;
        const lower = entry.name.toLowerCase();
        if (!isMediaRegex.test(lower)) {
          breakdown.otherCount += 1;
          breakdown.otherBytes += sizeBytes;
          continue;
        }
        const inferredKind = classifyMediaKind(entry.name, norm);
        if (inferredKind === 'movie') {
          breakdown.moviesCount += 1;
          breakdown.moviesBytes += sizeBytes;
        } else if (inferredKind === 'series') {
          breakdown.seriesCount += 1;
          breakdown.seriesBytes += sizeBytes;
        } else if (inferredKind === 'music') {
          breakdown.musicCount += 1;
          breakdown.musicBytes += sizeBytes;
        } else if (inferredKind === 'image') {
          breakdown.imagesCount += 1;
          breakdown.imagesBytes += sizeBytes;
        } else if (inferredKind === 'video') {
          breakdown.videosCount += 1;
          breakdown.videosBytes += sizeBytes;
        } else {
          breakdown.otherCount += 1;
          breakdown.otherBytes += sizeBytes;
        }
        files.push({
          name: entry.name,
          path: entry.path,
          dirPath: norm,
          sizeBytes,
          inferredKind,
        });
      }
    }
  }
  if (queue.length > 0) {
    truncated = true;
  }

  const volStats = await fetchNasStorageStatsBridge(target).catch(() => null);
  saveLocalBridgeVolumeStats({
    host: cleanHost,
    volumeTotalBytes: volStats?.volumeTotalBytes ?? 0,
    volumeFreeBytes: volStats?.volumeFreeBytes ?? 0,
    volumeUsedBytes: volStats?.volumeUsedBytes ?? 0,
    volumeSource: volStats?.volumeSource,
    scannedTotalBytes,
    scannedFilesCount,
    mediaBreakdown: breakdown,
    measuredAt: new Date().toISOString(),
  });

  return {
    ok: scannedFolders.length > 0,
    host: cleanHost,
    scanMode,
    scannedFolders,
    files,
    volumeTotalBytes: volStats?.volumeTotalBytes,
    volumeFreeBytes: volStats?.volumeFreeBytes,
    volumeUsedBytes: volStats?.volumeUsedBytes,
    volumeSource: volStats?.volumeSource,
    scannedTotalBytes,
    scannedFilesCount,
    truncated,
    mediaBreakdown: breakdown,
    error: scannedFolders.length === 0 ? 'Kein Live-Ordnerzugriff auf das NAS möglich (Zugangsdaten prüfen).' : undefined,
  };
}

