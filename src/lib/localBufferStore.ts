import type {
  LocalOnboardingBuffer,
  NasRegistrationConnectionPayload,
  NasUser,
} from '../types/marcente';
import {
  buildNasProbeCandidates,
  cleanHostOnly,
  diagnoseNativeServerConnection,
  discoverAndHydrateBackendFromNasBridge,
  isMixedContentBlocked,
  isNativeAndroidShell,
  loginUniversalNas,
  nasFetch,
  nativeAndroidFetch,
  type NativeServerDiagnosis,
  normalizeNasBaseUrl,
  notifyLocalBufferUpdated,
  probeBridgeNasHealth,
  readLocalBridgeCatalog,
  readLocalBridgePathSettings,
  readLocalBridgeScanSettings,
  readLocalProvisionedBackendForHost,
  resolveNasUrl,
  sanitizeNasPortForProtocol,
  saveLocalBridgePathSettings,
  saveLocalBridgeScanSettings,
  saveLocalProvisionedBackendFolder,
  setNasBaseUrl,
  syncEntenCenterDataToNasBridge,
  upsertLocalBridgeCatalogItems,
  wakeNasFromSleep,
  writeFileToNasBridge,
} from './nasClient';
import {
  decryptBrowserSecret,
  encryptBrowserSecret,
  redactSensitiveText,
} from './secureCredentialVault';

const BUFFER_STORAGE_KEY = 'entencenter_onboarding_buffer_v1';
const INDEXED_DB_NAME = 'entencenter_ondevice_db';
const INDEXED_DB_STORE = 'buffers';
const INDEXED_DB_KEY = 'onboarding_buffer';
export const LOCAL_FALLBACK_TOKEN_PREFIX = 'local-fallback-';

interface AndroidBufferBridgeWindow extends Window {
  EntenCenterAndroid?: {
    getLocalOnboardingBuffer?: () => string;
    setLocalOnboardingBuffer?: (jsonPayload: string) => boolean;
    clearLocalOnboardingBuffer?: () => boolean;
  };
}

export function isLocalFallbackToken(token?: string | null): boolean {
  return typeof token === 'string' && token.startsWith(LOCAL_FALLBACK_TOKEN_PREFIX);
}

export function isConfirmedStorageBridge(buffer?: LocalOnboardingBuffer | null): boolean {
  if (!buffer) return false;
  if (buffer.setupCompleted) return true;
  if (buffer.mode === 'storage_bridge_active') return true;
  return Boolean(
    buffer.nasSyncedAt &&
      (buffer.syncedBackendPath ||
        buffer.nasConnection?.backendPath ||
        buffer.nasConnection?.backendProvisioned)
  );
}

export interface NasSetupMissingItem {
  key: 'host' | 'nas_credentials' | 'profile' | 'backend_path' | 'connection';
  label: string;
  detail: string;
}

export interface NasSetupCompletenessResult {
  complete: boolean;
  hostReady: boolean;
  credentialsReady: boolean;
  profileReady: boolean;
  backendReady: boolean;
  connectionOnline: boolean;
  missing: NasSetupMissingItem[];
  resolvedHost: string;
  resolvedBackendPath: string;
}

export function evaluateNasSetupCompleteness(options: {
  buffer?: LocalOnboardingBuffer | null;
  overrideHost?: string;
  overrideUsername?: string;
  overridePassword?: string;
  overrideDisplayName?: string;
  overrideBackendPath?: string;
  connectionOnline?: boolean;
  remoteBackendVerified?: boolean;
}): NasSetupCompletenessResult {
  const buf = options.buffer ?? readLocalOnboardingBuffer();
  const conn = buf?.nasConnection;
  const resolvedHost =
    cleanHostOnly(options.overrideHost) ||
    cleanHostOnly(conn?.host) ||
    cleanHostOnly(buf?.serverUrl) ||
    '';
  const provisioned = resolvedHost ? readLocalProvisionedBackendForHost(resolvedHost) : null;
  const resolvedBackendPath = (
    options.overrideBackendPath ||
    buf?.syncedBackendPath ||
    conn?.backendPath ||
    provisioned?.backendPath ||
    ''
  ).trim();

  const effectiveNasPass =
    options.overridePassword ??
    conn?.fritzPassword ??
    conn?.secret ??
    '';
  const effectiveNasUser = (options.overrideUsername ?? conn?.username ?? '').trim();
  const proto = conn?.protocol ?? provisioned?.protocol ?? 'fritz_upnp';

  const hostReady = Boolean(resolvedHost);
  const credentialsReady =
    proto === 'smb'
      ? Boolean(effectiveNasPass.length > 0 && effectiveNasUser.length > 0)
      : Boolean(effectiveNasPass.length > 0);
  const profileReady = Boolean(buf?.user?.username?.trim());
  const backendReady = Boolean(
    options.remoteBackendVerified ||
      (resolvedBackendPath.length > 0 &&
        (buf?.nasSyncedAt || conn?.backendProvisioned || provisioned?.backendPath))
  );
  const connectionOnline = Boolean(
    options.connectionOnline ||
      options.remoteBackendVerified ||
      (buf?.mode === 'storage_bridge_active' && buf?.nasSyncedAt)
  );

  const missing: NasSetupMissingItem[] = [];
  if (!hostReady) {
    missing.push({
      key: 'host',
      label: 'NAS- / FRITZ!Box-Adresse',
      detail: 'Bitte gib die IP-Adresse oder den Hostnamen deines NAS ein (z. B. 192.168.178.1 oder fritz.box).',
    });
  }
  if (!credentialsReady) {
    missing.push({
      key: 'nas_credentials',
      label: 'FRITZ!NAS / NAS-Zugangsdaten',
      detail:
        proto === 'smb'
          ? 'Bitte gib Benutzername und Passwort für die SMB-Freigabe ein.'
          : 'Bitte gib das Passwort für die FRITZ!Box / FRITZ!NAS (und ggf. den Benutzernamen) ein.',
    });
  }
  if (!profileReady) {
    missing.push({
      key: 'profile',
      label: 'Benutzerprofil',
      detail: 'Bitte gib einen gültigen Benutzernamen / Anzeigenamen für dein EntenCenter-Profil ein.',
    });
  }
  if (!backendReady) {
    missing.push({
      key: 'backend_path',
      label: 'EntenCenter-Backend-Ordner auf dem NAS',
      detail: 'Öffne die NAS-Dateistruktur oder prüfe den Ordner „/EntenCenter-Backend“, damit die Profildaten verifiziert werden.',
    });
  }
  if (!connectionOnline) {
    missing.push({
      key: 'connection',
      label: 'Aktive Verbindung zum NAS',
      detail: 'Das NAS antwortet aktuell noch nicht — prüfe die Verbindung oder wecke das NAS kurz auf.',
    });
  }

  return {
    complete: hostReady && credentialsReady && profileReady && backendReady && connectionOnline,
    hostReady,
    credentialsReady,
    profileReady,
    backendReady,
    connectionOnline,
    missing,
    resolvedHost,
    resolvedBackendPath: resolvedBackendPath || '/EntenCenter-Backend',
  };
}

export async function markNasSetupCompleted(options?: {
  buffer?: LocalOnboardingBuffer | null;
  backendPath?: string;
  host?: string;
  username?: string;
  password?: string;
  displayName?: string;
  autoCompleted?: boolean;
}): Promise<{ ok: boolean; buffer: LocalOnboardingBuffer | null; remoteSaved: boolean }> {
  const current = options?.buffer ?? readLocalOnboardingBuffer();
  if (!current) {
    return { ok: false, buffer: null, remoteSaved: false };
  }
  const nowIso = new Date().toISOString();
  const host =
    cleanHostOnly(options?.host) ||
    cleanHostOnly(current.nasConnection?.host) ||
    cleanHostOnly(current.serverUrl);
  const provisioned = host ? readLocalProvisionedBackendForHost(host) : null;
  const backendPath = (
    options?.backendPath ||
    current.syncedBackendPath ||
    current.nasConnection?.backendPath ||
    provisioned?.backendPath ||
    '/EntenCenter-Backend'
  ).trim();
  const effectivePass =
    options?.password ??
    current.nasConnection?.fritzPassword ??
    current.nasConnection?.secret ??
    '';
  const effectiveNasUser = (options?.username ?? current.nasConnection?.username ?? '').trim();
  const effectiveDisplayName = (options?.displayName ?? current.user.displayName ?? current.user.username).trim();
  const proto = current.nasConnection?.protocol ?? provisioned?.protocol ?? 'fritz_upnp';
  const useTls = proto === 'smb' ? false : Boolean(current.nasConnection?.useTls);
  const safePort = String(
    sanitizeNasPortForProtocol(
      proto,
      current.nasConnection?.port || (proto === 'smb' ? '445' : useTls ? '443' : '80'),
      useTls
    )
  );

  if (host) {
    saveLocalProvisionedBackendFolder(host, proto, backendPath);
  }

  const nextBuf: LocalOnboardingBuffer = {
    ...current,
    mode: 'storage_bridge_active',
    setupCompleted: true,
    setupCompletedAt: current.setupCompletedAt || nowIso,
    autoBackgroundCheck: false,
    nasSyncedAt: current.nasSyncedAt || nowIso,
    syncedBackendPath: backendPath,
    lastTestError: null,
    lastTestedAt: nowIso,
    user: {
      ...current.user,
      displayName: effectiveDisplayName || current.user.username,
    },
    nasConnection: {
      ...(current.nasConnection ?? {
        protocol: proto,
        host,
        port: safePort,
        shareOrPath: proto === 'fritz_upnp' ? 'FRITZ.NAS' : backendPath,
        username: effectiveNasUser,
        secret: effectivePass,
        useTls,
      }),
      protocol: proto,
      host: host || current.nasConnection?.host || '',
      port: safePort,
      username: effectiveNasUser,
      secret: effectivePass || current.nasConnection?.secret || '',
      fritzUsername: effectiveNasUser,
      fritzPassword: effectivePass || current.nasConnection?.fritzPassword,
      backendPath,
      backendProvisioned: true,
      storageBridgeMode: true,
    },
    updatedAt: nowIso,
  };

  let remoteSaved = false;
  if (host && effectivePass) {
    try {
      const wr = await writeFileToNasBridge({
        protocol: proto,
        host,
        port: safePort,
        shareOrPath: proto === 'fritz_upnp' ? 'FRITZ.NAS' : nextBuf.nasConnection?.shareOrPath || '/',
        username: effectiveNasUser,
        password: effectivePass,
        secret: effectivePass,
        fritzPassword: effectivePass,
        domainOrWorkgroup: nextBuf.nasConnection?.domainOrWorkgroup,
        useTls,
        targetPath: `${backendPath}/config/setup-state.json`,
        content: JSON.stringify(
          {
            setupCompleted: true,
            setupCompletedAt: nextBuf.setupCompletedAt,
            completedMode: options?.autoCompleted ? 'auto' : 'manual',
            host,
            protocol: proto,
            backendPath,
            username: nextBuf.user.username,
            displayName: nextBuf.user.displayName,
            updatedAt: nowIso,
          },
          null,
          2
        ),
        contentType: 'application/json; charset=utf-8',
      });
      remoteSaved = Boolean(wr.ok);
    } catch {
      remoteSaved = false;
    }
  }

  writeLocalOnboardingBuffer(nextBuf);
  return { ok: true, buffer: nextBuf, remoteSaved };
}

function generateLocalId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // Fallback
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openBufferIndexedDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(INDEXED_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(INDEXED_DB_STORE)) {
          db.createObjectStore(INDEXED_DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeBufferToIndexedDb(jsonPayload: string): Promise<void> {
  const db = await openBufferIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(INDEXED_DB_STORE, 'readwrite');
      tx.objectStore(INDEXED_DB_STORE).put(jsonPayload, INDEXED_DB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function readBufferFromIndexedDb(): Promise<string | null> {
  const db = await openBufferIndexedDb();
  if (!db) return null;
  return new Promise<string | null>((resolve) => {
    try {
      const tx = db.transaction(INDEXED_DB_STORE, 'readonly');
      const req = tx.objectStore(INDEXED_DB_STORE).get(INDEXED_DB_KEY);
      req.onsuccess = () => {
        const val = typeof req.result === 'string' ? req.result : null;
        db.close();
        resolve(val);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function clearBufferFromIndexedDb(): Promise<void> {
  const db = await openBufferIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(INDEXED_DB_STORE, 'readwrite');
      tx.objectStore(INDEXED_DB_STORE).delete(INDEXED_DB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

function sanitizeBufferNasConnection(
  nasConn: NasRegistrationConnectionPayload | null | undefined
): NasRegistrationConnectionPayload | null {
  if (!nasConn) return null;
  const safePort = sanitizeNasPortForProtocol(nasConn.protocol, nasConn.port, nasConn.useTls);
  return {
    ...nasConn,
    port: String(safePort),
  };
}

function parseBufferJson(raw: string | null | undefined): LocalOnboardingBuffer | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalOnboardingBuffer>;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.localToken === 'string' &&
      parsed.localToken.startsWith(LOCAL_FALLBACK_TOKEN_PREFIX) &&
      parsed.user &&
      typeof parsed.user.username === 'string' &&
      typeof parsed.user.password === 'string'
    ) {
      return {
        ...(parsed as LocalOnboardingBuffer),
        nasConnection: sanitizeBufferNasConnection(parsed.nasConnection),
      };
    }
  } catch {
    // Ungültiger Puffer
  }
  return null;
}

export function readLocalOnboardingBuffer(): LocalOnboardingBuffer | null {
  if (typeof window === 'undefined') return null;

  if (isNativeAndroidShell()) {
    try {
      const nativeRaw = (
        window as AndroidBufferBridgeWindow
      ).EntenCenterAndroid?.getLocalOnboardingBuffer?.();
      const parsedNative = parseBufferJson(nativeRaw);
      if (parsedNative) return parsedNative;
    } catch {
      // Fallback zu localStorage
    }
  }

  try {
    const stored = window.localStorage.getItem(BUFFER_STORAGE_KEY);
    return parseBufferJson(stored);
  } catch {
    return null;
  }
}

export async function hydrateLocalOnboardingBufferFromIndexedDb(): Promise<LocalOnboardingBuffer | null> {
  const syncExisting = readLocalOnboardingBuffer();
  const idbRaw = await readBufferFromIndexedDb();
  if (idbRaw) {
    try {
      const parsed = JSON.parse(idbRaw) as Partial<LocalOnboardingBuffer> & {
        encryptedUserPassword?: unknown;
        encryptedNasSecret?: unknown;
        encryptedFritzPassword?: unknown;
      };
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.localToken === 'string' &&
        parsed.localToken.startsWith(LOCAL_FALLBACK_TOKEN_PREFIX) &&
        parsed.user &&
        typeof parsed.user.username === 'string'
      ) {
        const decPass = await decryptBrowserSecret(
          parsed.encryptedUserPassword as Parameters<typeof decryptBrowserSecret>[0]
        );
        const decNasSecret = await decryptBrowserSecret(
          parsed.encryptedNasSecret as Parameters<typeof decryptBrowserSecret>[0]
        );
        const decFritzSecret = await decryptBrowserSecret(
          parsed.encryptedFritzPassword as Parameters<typeof decryptBrowserSecret>[0]
        );
        const hydrated: LocalOnboardingBuffer = {
          ...(parsed as LocalOnboardingBuffer),
          user: {
            ...parsed.user,
            password: decPass || parsed.user.password || '',
          },
          nasConnection: parsed.nasConnection
            ? {
                ...parsed.nasConnection,
                secret: decNasSecret || parsed.nasConnection.secret || '',
                fritzPassword: decFritzSecret || parsed.nasConnection.fritzPassword,
              }
            : null,
        };
        if (!syncExisting || (!syncExisting.user.password && hydrated.user.password)) {
          return hydrated;
        }
      }
    } catch {
      // Fallback
    }
  }
  return syncExisting;
}

async function writeEncryptedWebIdbBuffer(buffer: LocalOnboardingBuffer): Promise<void> {
  const encUserPass = buffer.user.password ? await encryptBrowserSecret(buffer.user.password) : null;
  const encNasSecret = buffer.nasConnection?.secret
    ? await encryptBrowserSecret(buffer.nasConnection.secret)
    : null;
  const encFritzPass = buffer.nasConnection?.fritzPassword
    ? await encryptBrowserSecret(buffer.nasConnection.fritzPassword)
    : null;

  const securedPayload = {
    ...buffer,
    user: {
      ...buffer.user,
      password: encUserPass ? '' : buffer.user.password,
    },
    nasConnection: buffer.nasConnection
      ? {
          ...buffer.nasConnection,
          secret: encNasSecret ? '' : buffer.nasConnection.secret,
          fritzPassword: encFritzPass ? undefined : buffer.nasConnection.fritzPassword,
        }
      : null,
    encryptedUserPassword: encUserPass,
    encryptedNasSecret: encNasSecret,
    encryptedFritzPassword: encFritzPass,
    updatedAt: new Date().toISOString(),
  };
  await writeBufferToIndexedDb(JSON.stringify(securedPayload));
}

export function writeLocalOnboardingBuffer(buffer: LocalOnboardingBuffer): void {
  if (typeof window === 'undefined') return;
  const sanitizedNasConn = sanitizeBufferNasConnection(buffer.nasConnection);
  const sanitizedBuffer: LocalOnboardingBuffer = {
    ...buffer,
    nasConnection: sanitizedNasConn,
    lastTestError: buffer.lastTestError
      ? redactSensitiveText(buffer.lastTestError, [
          buffer.user.password,
          sanitizedNasConn?.secret,
          sanitizedNasConn?.fritzPassword,
        ])
      : null,
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(sanitizedBuffer);

  if (isNativeAndroidShell()) {
    try {
      const savedNative = (window as AndroidBufferBridgeWindow).EntenCenterAndroid?.setLocalOnboardingBuffer?.(
        serialized
      );
      if (savedNative) {
        // Auf Android ist der vollständige Puffer im AndroidKeyStore verschlüsselt — nichts Unverschlüsseltes in localStorage ablegen
        notifyLocalBufferUpdated();
        return;
      }
    } catch {
      // Optional
    }
  }

  // Im Web-Browser Klartext-Passwörter nicht im localStorage ablegen; verschlüsselt in WebCrypto+IndexedDB sichern
  const redactedForStorage: LocalOnboardingBuffer = {
    ...sanitizedBuffer,
    user: {
      ...sanitizedBuffer.user,
      password: '',
    },
    nasConnection: sanitizedBuffer.nasConnection
      ? {
          ...sanitizedBuffer.nasConnection,
          secret: '',
          fritzPassword: undefined,
        }
      : null,
  };
  try {
    window.localStorage.setItem(BUFFER_STORAGE_KEY, JSON.stringify(redactedForStorage));
  } catch {
    // Speicherfehler ignorieren
  }

  void writeEncryptedWebIdbBuffer(sanitizedBuffer);
  notifyLocalBufferUpdated();
}

export async function clearLocalOnboardingBuffer(): Promise<void> {
  if (typeof window === 'undefined') return;

  if (isNativeAndroidShell()) {
    try {
      (window as AndroidBufferBridgeWindow).EntenCenterAndroid?.clearLocalOnboardingBuffer?.();
    } catch {
      // Optional
    }
  }

  try {
    window.localStorage.removeItem(BUFFER_STORAGE_KEY);
  } catch {
    // Ignorieren
  }

  await clearBufferFromIndexedDb();
  notifyLocalBufferUpdated();
}

export function createLocalOnboardingBuffer(params: {
  username: string;
  displayName?: string;
  password: string;
  serverUrl?: string;
  connectionScope?: 'lan' | 'internet';
  nasConnection?: NasRegistrationConnectionPayload | null;
  autoBackgroundCheck?: boolean;
}): LocalOnboardingBuffer {
  const cleanUsername = params.username.trim().toLowerCase();
  const cleanDisplayName = params.displayName?.trim() || params.username.trim();
  const now = new Date().toISOString();
  const buffer: LocalOnboardingBuffer = {
    version: 1,
    mode: params.serverUrl?.trim() ? 'pending_nas_sync' : 'local_fallback',
    localToken: generateLocalId(LOCAL_FALLBACK_TOKEN_PREFIX.replace(/-$/, '')),
    user: {
      id: generateLocalId('local-user'),
      username: cleanUsername,
      displayName: cleanDisplayName,
      password: params.password,
      role: 'admin',
      fskLimit: 18,
      avatarColor: '#F59E0B',
      createdAt: now,
    },
    serverUrl: params.serverUrl?.trim() ? normalizeNasBaseUrl(params.serverUrl) : '',
    connectionScope: params.connectionScope ?? 'lan',
    nasConnection: params.nasConnection ?? null,
    autoBackgroundCheck: params.autoBackgroundCheck ?? true,
    lastTestError: null,
    lastTestedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  writeLocalOnboardingBuffer(buffer);
  return buffer;
}

export function toNasUserFromBuffer(buffer: LocalOnboardingBuffer): NasUser {
  return {
    id: buffer.user.id,
    username: buffer.user.username,
    displayName: buffer.user.displayName,
    role: buffer.user.role,
    fskLimit: buffer.user.fskLimit,
    createdAt: buffer.user.createdAt,
    avatarColor: buffer.user.avatarColor,
    avatarUrl: null,
  };
}

export interface NasBufferTransferResult {
  ok: boolean;
  token?: string;
  user?: NasUser;
  resolvedServerUrl?: string;
  purgedLocalBuffer?: boolean;
  latencyMs?: number | null;
  bridgeTransportLabel?: string | null;
  wokeUp?: boolean;
  remoteWriteVerified?: boolean;
  remoteWriteWarning?: string | null;
  transferredFilesCount?: number;
  syncedBackendPath?: string | null;
  alreadySyncedOnNas?: boolean;
  mixedContentUrl?: string | null;
  diagnosis?: NativeServerDiagnosis | null;
  error?: string;
}

async function isBootstrapJsonResponse(res: Response | null): Promise<boolean> {
  if (!res || !res.ok) return false;
  const data = (await res.json().catch(() => null)) as { hasUsers?: unknown } | null;
  return typeof data?.hasUsers === 'boolean';
}

async function probeBootstrapTarget(baseUrl: string): Promise<boolean> {
  const endpoint = baseUrl
    ? `${baseUrl}/api/nas/auth/bootstrap`
    : resolveNasUrl('/api/nas/auth/bootstrap');
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const res = await nasFetch(
      endpoint,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
      4500
    );
    if (await isBootstrapJsonResponse(res)) {
      return true;
    }
  } catch {
    // Im nativen WebView ggf. durch CORS/PNA blockiert -> expliziten nativen Bridge-Fallback prüfen
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (isNativeAndroidShell() && /^https?:\/\//i.test(endpoint)) {
    const nativeRes = await nativeAndroidFetch(
      endpoint,
      { method: 'GET', headers: { Accept: 'application/json' } },
      3500
    );
    if (await isBootstrapJsonResponse(nativeRes)) {
      return true;
    }
  }
  return false;
}

export async function testAndTransferLocalBufferToNas(options: {
  buffer: LocalOnboardingBuffer;
  overrideServerUrl?: string;
  overrideNasConnection?: NasRegistrationConnectionPayload | null;
  overrideFritzCreds?: { username?: string; password?: string };
}): Promise<NasBufferTransferResult> {
  const native = isNativeAndroidShell();
  const rawServerInput =
    options.overrideServerUrl !== undefined
      ? options.overrideServerUrl.trim()
      : options.buffer.serverUrl.trim();

  if (native && !rawServerInput) {
    return {
      ok: false,
      error:
        'Noch keine NAS-Server-Adresse hinterlegt. Suche per mDNS im Heimnetz oder gib eine LAN- bzw. Internet-Adresse ein.',
    };
  }

  const rawCandidates = rawServerInput ? buildNasProbeCandidates(rawServerInput) : [''];
  const usableCandidates = rawCandidates.filter((c) => !(native && !c));
  const mixedBlocked = rawCandidates.find((c) => isMixedContentBlocked(c)) ?? null;

  if (usableCandidates.length === 0) {
    return {
      ok: false,
      mixedContentUrl: mixedBlocked,
      error: mixedBlocked
        ? `Dein Browser blockiert direkte http://-Verbindungen (${mixedBlocked}) von einer HTTPS-Seite aus. Öffne die Adresse direkt im neuen Tab oder nutze die Android-APK.`
        : 'Keine gültige NAS-Adresse zum Testen gefunden.',
    };
  }

  const primaryProbeSet = rawServerInput
    ? Array.from(new Set([normalizeNasBaseUrl(rawServerInput), usableCandidates[0]].filter(Boolean)))
    : usableCandidates;
  const fallbackProbeSet = usableCandidates.filter((c) => !primaryProbeSet.includes(c));

  const primaryOutcomes = await Promise.all(
    primaryProbeSet.map(async (candidate) => ({
      candidate,
      reachable: await probeBootstrapTarget(candidate),
    }))
  );
  let reachableTarget = primaryOutcomes.find((o) => o.reachable)?.candidate;

  if (reachableTarget === undefined && fallbackProbeSet.length > 0) {
    const fallbackOutcomes = await Promise.all(
      fallbackProbeSet.map(async (candidate) => ({
        candidate,
        reachable: await probeBootstrapTarget(candidate),
      }))
    );
    reachableTarget = fallbackOutcomes.find((o) => o.reachable)?.candidate;
  }

  let diag: NativeServerDiagnosis | null = null;

  if (reachableTarget === undefined && native && rawServerInput) {
    diag = diagnoseNativeServerConnection(rawServerInput);
    if (diag?.ok && diag.matchedBaseUrl) {
      reachableTarget = diag.matchedBaseUrl;
    }
  }

  if (reachableTarget === undefined) {
    const effectiveNasConnForDirect =
      options.overrideNasConnection !== undefined
        ? options.overrideNasConnection
        : options.buffer.nasConnection;
    const rawHostClean = cleanHostOnly(rawServerInput);
    const provisionedEntry = readLocalProvisionedBackendForHost(
      effectiveNasConnForDirect?.host || rawHostClean
    );
    const directHost =
      cleanHostOnly(effectiveNasConnForDirect?.host) ||
      cleanHostOnly(diag?.resolvedIp || diag?.host) ||
      rawHostClean ||
      cleanHostOnly(provisionedEntry?.host);
    const inferredProtocol =
      effectiveNasConnForDirect?.protocol ||
      provisionedEntry?.protocol ||
      (diag?.detectedFritzBox
        ? 'fritz_upnp'
        : diag?.openNasServices?.[0]?.protocol ||
          (rawServerInput.includes(':445') ? 'smb' : undefined));
    const directScope = options.buffer.connectionScope === 'internet' ? 'internet' : 'lan';

    // Ohne :3000-Backend direkt über Storage-Bridge (FRITZ!NAS / SMB / WebDAV / SFTP) prüfen + ggf. aufwecken + Daten übertragen
    if (directHost) {
      const isFritzTarget =
        inferredProtocol === 'fritz_upnp' ||
        directHost.toLowerCase().includes('fritz') ||
        Boolean(diag?.detectedFritzBox);
      const bridgeEffectiveUser = isFritzTarget
        ? options.overrideFritzCreds?.username?.trim() ||
          effectiveNasConnForDirect?.fritzUsername?.trim() ||
          effectiveNasConnForDirect?.username?.trim() ||
          ''
        : options.overrideFritzCreds?.username?.trim() ||
          effectiveNasConnForDirect?.fritzUsername?.trim() ||
          effectiveNasConnForDirect?.username?.trim() ||
          options.buffer.user.username;
      const bridgeEffectivePass =
        options.overrideFritzCreds?.password ||
        effectiveNasConnForDirect?.fritzPassword ||
        effectiveNasConnForDirect?.secret ||
        options.buffer.user.password ||
        '';

      let bridgeHealth = await probeBridgeNasHealth({
        host: directHost,
        port: effectiveNasConnForDirect?.port,
        scope: directScope,
      }).catch(() => null);

      let wakeRes = null;
      if (!bridgeHealth?.ok) {
        wakeRes = await wakeNasFromSleep({
          host: directHost,
          username: bridgeEffectiveUser,
          password: bridgeEffectivePass,
          useTls: effectiveNasConnForDirect?.useTls,
          scope: directScope,
        }).catch(() => null);
        if (wakeRes?.ok) {
          bridgeHealth = {
            ok: true,
            status: 'online',
            host: directHost,
            latencyMs: wakeRes.latencyMs,
            smbOpen: wakeRes.smbReady,
            fritzDetected: wakeRes.fritzWebReady,
            transportLabel: wakeRes.transportLabel,
          };
        }
      }

      const effectiveProtoForTest =
        inferredProtocol ||
        (bridgeHealth?.fritzDetected
          ? 'fritz_upnp'
          : bridgeHealth?.smbOpen
            ? 'smb'
            : undefined);

      const safeTestPort = effectiveProtoForTest
        ? sanitizeNasPortForProtocol(
            effectiveProtoForTest,
            effectiveNasConnForDirect?.port,
            effectiveNasConnForDirect?.useTls
          )
        : undefined;

      const directRes = effectiveProtoForTest
        ? await loginUniversalNas({
            host: directHost,
            port: safeTestPort,
            protocol: effectiveProtoForTest,
            shareOrPath:
              effectiveNasConnForDirect?.backendPath ||
              effectiveNasConnForDirect?.shareOrPath ||
              provisionedEntry?.backendPath,
            username: bridgeEffectiveUser,
            password: bridgeEffectivePass,
            domainOrWorkgroup: effectiveNasConnForDirect?.domainOrWorkgroup,
            useTls: effectiveNasConnForDirect?.useTls,
            ftpsTlsMode: effectiveNasConnForDirect?.ftpsTlsMode,
            scope: directScope,
          }).catch(() => null)
        : null;

      if (
        directRes?.ok &&
        directRes.verification?.protocolVerified &&
        directRes.token &&
        directRes.user &&
        !isLocalFallbackToken(directRes.token)
      ) {
        await clearLocalOnboardingBuffer();
        return {
          ok: true,
          token: directRes.token,
          user: directRes.user,
          resolvedServerUrl: directHost,
          purgedLocalBuffer: true,
          remoteWriteVerified: true,
          latencyMs: directRes.verification.latencyMs ?? bridgeHealth?.latencyMs ?? null,
        };
      }

      const hasProvisionedOrCreds = Boolean(
        effectiveNasConnForDirect?.backendProvisioned ||
          effectiveNasConnForDirect?.storageBridgeMode ||
          provisionedEntry ||
          bridgeEffectivePass ||
          (directRes?.ok && directRes.verification?.protocolVerified)
      );

      if ((bridgeHealth?.ok || directRes?.ok) && hasProvisionedOrCreds) {
        let resolvedBackendPath =
          effectiveNasConnForDirect?.backendPath ||
          provisionedEntry?.backendPath ||
          (effectiveNasConnForDirect?.shareOrPath &&
          !['/', 'fritz.nas'].includes(effectiveNasConnForDirect.shareOrPath.trim().toLowerCase())
            ? effectiveNasConnForDirect.shareOrPath
            : '') ||
          '/EntenCenter-Backend';
        const nextProtocol = effectiveProtoForTest || (bridgeHealth?.smbOpen ? 'smb' : 'fritz_upnp');
        const sanitizedNextPort = String(
          sanitizeNasPortForProtocol(
            nextProtocol,
            effectiveNasConnForDirect?.port ||
              (nextProtocol === 'smb'
                ? '445'
                : bridgeHealth?.fritzHttpAvailable
                  ? '80'
                  : '443'),
            effectiveNasConnForDirect?.useTls ?? (nextProtocol === 'fritz_upnp' && !bridgeHealth?.fritzHttpAvailable)
          )
        );

        let remoteWriteVerified = false;
        let transferredFilesCount = 0;
        let alreadySyncedOnNas = false;
        let remoteWriteWarning: string | null = null;

        if (bridgeEffectivePass) {
          const discoveryTarget = {
            protocol: nextProtocol,
            host: directHost,
            port: sanitizedNextPort,
            shareOrPath: nextProtocol === 'fritz_upnp' ? 'FRITZ.NAS' : effectiveNasConnForDirect?.shareOrPath || '/',
            username: bridgeEffectiveUser,
            password: bridgeEffectivePass,
            secret: bridgeEffectivePass,
            fritzPassword: bridgeEffectivePass,
            domainOrWorkgroup: effectiveNasConnForDirect?.domainOrWorkgroup,
            useTls: effectiveNasConnForDirect?.useTls ?? false,
            backendPath: resolvedBackendPath,
          };

          const existingDiscovery = await discoverAndHydrateBackendFromNasBridge({
            target: discoveryTarget,
            username: options.buffer.user.username,
            preferredBackendPath: resolvedBackendPath,
          }).catch(() => null);

          if (existingDiscovery?.found) {
            resolvedBackendPath = existingDiscovery.backendPath;
            alreadySyncedOnNas = existingDiscovery.hasProfile || existingDiscovery.hasManifest;
            if (existingDiscovery.catalog && existingDiscovery.catalog.length > 0) {
              upsertLocalBridgeCatalogItems(existingDiscovery.catalog);
            }
            if (existingDiscovery.scanFolderSettings) {
              saveLocalBridgeScanSettings(existingDiscovery.scanFolderSettings);
            }
            if (existingDiscovery.pathSettings) {
              saveLocalBridgePathSettings(existingDiscovery.pathSettings);
            }
          }

          const syncRes = await syncEntenCenterDataToNasBridge({
            target: {
              ...discoveryTarget,
              backendPath: resolvedBackendPath,
            },
            backendPath: resolvedBackendPath,
            username: options.buffer.user.username,
            displayName: options.buffer.user.displayName,
            role: options.buffer.user.role,
            fskLimit: options.buffer.user.fskLimit,
            connectionScope: directScope,
            catalog: readLocalBridgeCatalog(),
            scanFolderSettings: readLocalBridgeScanSettings(),
            pathSettings: readLocalBridgePathSettings(),
          }).catch((e) => ({
            ok: false,
            backendPath: resolvedBackendPath,
            writtenFiles: [],
            verified: false,
            error: e instanceof Error ? e.message : 'Übertragung auf das NAS fehlgeschlagen.',
          }));

          resolvedBackendPath = syncRes.backendPath || resolvedBackendPath;
          remoteWriteVerified = Boolean(
            (syncRes.ok && syncRes.verified) ||
              (existingDiscovery?.found && (existingDiscovery.hasProfile || existingDiscovery.hasConfig))
          );
          transferredFilesCount = syncRes.writtenFiles.length || existingDiscovery?.verifiedFiles.length || 0;
          remoteWriteWarning = syncRes.ok
            ? null
            : remoteWriteVerified
              ? null
              : syncRes.error || 'Daten konnten nicht direkt auf das NAS geschrieben werden.';
        } else {
          remoteWriteWarning =
            'Kein FRITZ!Box-/NAS-Passwort angegeben — bitte Zugangsdaten eingeben, damit Daten direkt auf das NAS übertragen werden können.';
        }

        const nowIso = new Date().toISOString();
        if (remoteWriteVerified) {
          saveLocalProvisionedBackendFolder(directHost, nextProtocol, resolvedBackendPath);
        }
        const canAutoFinishSetup = Boolean(
          remoteWriteVerified &&
            directHost &&
            bridgeEffectivePass &&
            options.buffer.user.username.trim()
        );
        const updatedBuffer: LocalOnboardingBuffer = {
          ...options.buffer,
          mode: remoteWriteVerified
            ? 'storage_bridge_active'
            : options.buffer.mode === 'storage_bridge_active'
              ? 'storage_bridge_active'
              : 'pending_nas_sync',
          setupCompleted: canAutoFinishSetup ? true : options.buffer.setupCompleted,
          setupCompletedAt: canAutoFinishSetup
            ? (options.buffer.setupCompletedAt || nowIso)
            : options.buffer.setupCompletedAt ?? null,
          autoBackgroundCheck: canAutoFinishSetup ? false : options.buffer.autoBackgroundCheck,
          serverUrl: rawServerInput ? normalizeNasBaseUrl(rawServerInput) || directHost : options.buffer.serverUrl || directHost,
          nasConnection: {
            protocol: nextProtocol,
            host: directHost,
            port: sanitizedNextPort,
            shareOrPath: nextProtocol === 'fritz_upnp' ? 'FRITZ.NAS' : effectiveNasConnForDirect?.shareOrPath || resolvedBackendPath,
            username: bridgeEffectiveUser,
            secret: bridgeEffectivePass,
            fritzUsername: bridgeEffectiveUser,
            fritzPassword: bridgeEffectivePass,
            useTls: effectiveNasConnForDirect?.useTls ?? false,
            backendPath: resolvedBackendPath,
            backendProvisioned: Boolean(
              remoteWriteVerified || effectiveNasConnForDirect?.backendProvisioned || provisionedEntry
            ),
            storageBridgeMode: true,
          },
          nasSyncedAt: remoteWriteVerified ? (options.buffer.nasSyncedAt || nowIso) : options.buffer.nasSyncedAt ?? null,
          syncedBackendPath: remoteWriteVerified ? resolvedBackendPath : options.buffer.syncedBackendPath ?? null,
          lastTestError: remoteWriteWarning,
          lastTestedAt: nowIso,
        };
        writeLocalOnboardingBuffer(updatedBuffer);
        return {
          ok: true,
          token: updatedBuffer.localToken,
          user: toNasUserFromBuffer(updatedBuffer),
          resolvedServerUrl: directHost,
          purgedLocalBuffer: false,
          remoteWriteVerified,
          remoteWriteWarning,
          transferredFilesCount,
          syncedBackendPath: resolvedBackendPath,
          alreadySyncedOnNas,
          latencyMs:
            wakeRes?.latencyMs ??
            bridgeHealth?.latencyMs ??
            directRes?.verification?.latencyMs ??
            null,
          bridgeTransportLabel:
            wakeRes?.transportLabel ??
            bridgeHealth?.transportLabel ??
            (bridgeHealth?.fritzDetected ? 'FRITZ!NAS Direkt (Storage-Bridge)' : 'SMB 2/3 Storage-Bridge'),
          wokeUp: Boolean(wakeRes?.wokeUp),
        };
      }
    }

    const targetLabel = normalizeNasBaseUrl(rawServerInput) || usableCandidates[0] || window.location.origin;
    const errMsg = diag?.detail
      ? `${diag.detail} Die lokalen Daten bleiben sicher im geschützten On-Device-Puffer gespeichert.`
      : `NAS-Server unter "${targetLabel}" noch nicht erreichbar. Die lokalen Daten bleiben sicher im geschützten On-Device-Puffer gespeichert.`;
    writeLocalOnboardingBuffer({
      ...options.buffer,
      serverUrl: rawServerInput ? normalizeNasBaseUrl(rawServerInput) || rawServerInput : '',
      nasConnection:
        options.overrideNasConnection !== undefined
          ? options.overrideNasConnection
          : options.buffer.nasConnection,
      lastTestError: errMsg,
      lastTestedAt: new Date().toISOString(),
    });
    return {
      ok: false,
      mixedContentUrl: mixedBlocked,
      diagnosis: diag,
      error: errMsg,
    };
  }

  const effectiveNasConn =
    options.overrideNasConnection !== undefined
      ? options.overrideNasConnection
      : options.buffer.nasConnection;
  const hasNasConnHost = Boolean(effectiveNasConn?.host?.trim());
  const cleanedNasConn =
    hasNasConnHost && effectiveNasConn
      ? {
          ...effectiveNasConn,
          host: effectiveNasConn.host.trim(),
          port:
            effectiveNasConn.port.trim() ||
            (effectiveNasConn.protocol === 'fritz_upnp' ? '49000' : ''),
          shareOrPath:
            effectiveNasConn.shareOrPath.trim() ||
            (effectiveNasConn.protocol === 'fritz_upnp' ? '/MediaServer' : '/'),
          username: effectiveNasConn.username.trim(),
          secret: effectiveNasConn.secret ?? '',
        }
      : undefined;

  const registerUrl = reachableTarget
    ? `${reachableTarget}/api/nas/register`
    : '/api/nas/register';
  const loginUrl = reachableTarget ? `${reachableTarget}/api/nas/login` : '/api/nas/login';

  try {
    let authRes = await nasFetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: options.buffer.user.username,
        password: options.buffer.user.password,
        displayName: options.buffer.user.displayName,
        nasConnection: cleanedNasConn,
      }),
    });

    if (authRes.status === 409) {
      authRes = await nasFetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: options.buffer.user.username,
          password: options.buffer.user.password,
        }),
      });
    }

    const authData = (await authRes.json().catch(() => ({}))) as {
      error?: string;
      token?: string;
      user?: NasUser;
    };

    if (!authRes.ok || !authData.token || !authData.user) {
      const errMsg =
        authData.error ||
        `Übertragung an ${reachableTarget || window.location.origin} fehlgeschlagen (HTTP ${authRes.status}).`;
      writeLocalOnboardingBuffer({
        ...options.buffer,
        serverUrl: reachableTarget,
        nasConnection: cleanedNasConn ?? options.buffer.nasConnection,
        lastTestError: errMsg,
        lastTestedAt: new Date().toISOString(),
      });
      return { ok: false, error: errMsg };
    }

    // Falls Anmeldung über bestehendes Konto lief und NAS-Verbindungsdaten gepuffert waren: nachspeichern
    if (cleanedNasConn && authData.token) {
      const connUrl = reachableTarget
        ? `${reachableTarget}/api/nas/connection`
        : '/api/nas/connection';
      await nasFetch(connUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authData.token}`,
        },
        body: JSON.stringify(cleanedNasConn),
      }).catch(() => undefined);
    }

    if (reachableTarget) {
      setNasBaseUrl(reachableTarget);
    }

    // Nach erfolgreichem Übertrag auf das NAS lokalen Initial-Puffer automatisch löschen
    await clearLocalOnboardingBuffer();

    return {
      ok: true,
      token: authData.token,
      user: authData.user,
      resolvedServerUrl: reachableTarget,
      purgedLocalBuffer: true,
    };
  } catch {
    const errMsg =
      'Netzwerkfehler bei der Übertragung der lokalen Daten auf das NAS. Der lokale Puffer bleibt erhalten.';
    writeLocalOnboardingBuffer({
      ...options.buffer,
      lastTestError: errMsg,
      lastTestedAt: new Date().toISOString(),
    });
    return { ok: false, error: errMsg };
  }
}
