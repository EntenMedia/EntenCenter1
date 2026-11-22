import type {
  FritzNasBrowseItem,
  FritzSidSessionStatus,
  NasConnectionProfile,
  NasProtocolId,
} from '../types/marcente';

/**
 * Pure TypeScript UTF-16LE MD5 Berechnung gemäß offizieller AVM FRITZ!Box Spezifikation
 * für Challenge-Response (`login_sid.lua`).
 */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

export function md5Bytes(inputBytes: Uint8Array): string {
  const origLenBits = inputBytes.length * 8;
  const withOneLen = inputBytes.length + 1;
  const padZeroLen = (56 - (withOneLen % 64) + 64) % 64;
  const totalLen = withOneLen + padZeroLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(inputBytes, 0);
  padded[inputBytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, origLenBits >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(origLenBits / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < totalLen; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j += 1) {
      M[j] = view.getUint32(offset + j * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      const sum = (A + F + MD5_K[i] + M[g]) >>> 0;
      const shift = MD5_SHIFTS[i];
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotated) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);

  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function encodeUtf16Le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return bytes;
}

export function computeFritzChallengeResponse(challenge: string, password: string): {
  response: string;
  md5Hex: string;
} {
  let sanitizedPassword = '';
  for (let i = 0; i < password.length; i += 1) {
    const code = password.charCodeAt(i);
    sanitizedPassword += code > 255 ? '.' : password[i];
  }
  const combined = `${challenge.trim()}-${sanitizedPassword}`;
  const md5Hex = md5Bytes(encodeUtf16Le(combined));
  return {
    response: `${challenge.trim()}-${md5Hex}`,
    md5Hex,
  };
}

import {
  browseNasDirectoryTree,
  diagnoseNativeServerConnection,
  fritzBoxDirectLoginWithSession,
  getNasBaseUrl,
  isNativeAndroidShell,
  nasFetch,
  normalizeNasBaseUrl,
  resolveNasUrl,
  sanitizeNasPortForProtocol,
  testUniversalNasConnection,
} from './nasClient';

const LOCAL_NAS_PROFILES_STORAGE_KEY = 'entencenter_local_nas_profiles_v1';
const LOCAL_FRITZ_SESSION_STATUS_KEY = 'entencenter_local_fritz_status_v1';

function isFallbackToken(token?: string | null): boolean {
  return Boolean(token && token.startsWith('local-fallback-'));
}

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text();
    if (!raw || raw.trim().startsWith('<')) {
      return null;
    }
    if (!contentType.includes('application/json') && !raw.trim().startsWith('{') && !raw.trim().startsWith('[')) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readLocalProfiles(): NasConnectionProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_NAS_PROFILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as NasConnectionProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalProfiles(profiles: NasConnectionProfile[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_NAS_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Storage optional
  }
}

function readLocalFritzStatusCache(): FritzSidSessionStatus | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_FRITZ_SESSION_STATUS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FritzSidSessionStatus;
  } catch {
    return null;
  }
}

function writeLocalFritzStatusCache(status: FritzSidSessionStatus): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_FRITZ_SESSION_STATUS_KEY, JSON.stringify(status));
  } catch {
    // Storage optional
  }
}

function cleanFritzHostInput(rawHost?: string): string {
  const cleaned = (rawHost || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
  if (cleaned) return cleaned;

  const base = getNasBaseUrl();
  if (base) {
    try {
      const parsed = new URL(base);
      if (parsed.hostname) return parsed.hostname;
    } catch {
      // ignore
    }
  }
  return 'fritz.box';
}

function buildFallbackFritzStatus(
  params?: { host?: string; port?: string; useTls?: boolean; username?: string },
  overrides?: Partial<FritzSidSessionStatus>
): FritzSidSessionStatus {
  const cached = readLocalFritzStatusCache();
  const host = cleanFritzHostInput(params?.host || cached?.host);
  const useTls = params?.useTls ?? cached?.useTls ?? false;
  const port = Number(params?.port) || (useTls ? 443 : 80);
  return {
    connected: false,
    host,
    port,
    useTls,
    username: params?.username ?? cached?.username ?? '',
    hasSecret: cached?.hasSecret ?? false,
    sidPreview: null,
    challengeVersion: cached?.challengeVersion ?? null,
    rights: cached?.rights ?? [],
    obtainedAt: cached?.obtainedAt ?? null,
    lastVerifiedAt: new Date().toISOString(),
    blockTimeSec: 0,
    tr064Available: cached?.tr064Available ?? false,
    allowLocalSelfSignedTls: true,
    tlsBypassedForLocalSelfSigned: false,
    message: 'Bereit für direkte FRITZ!Box Status- & Challenge-Response-Prüfung.',
    ...overrides,
  };
}

function hasConfiguredBackendApi(token?: string | null): boolean {
  if (isFallbackToken(token)) return false;
  if (!isNativeAndroidShell()) return true;
  return Boolean(getNasBaseUrl());
}

export async function fetchFritzSessionStatus(
  token: string,
  params?: { host?: string; port?: string; useTls?: boolean; username?: string }
): Promise<FritzSidSessionStatus> {
  const targetHost = cleanFritzHostInput(params?.host);
  const targetPortNum = Number(params?.port) || (params?.useTls ? 443 : 80);

  if (hasConfiguredBackendApi(token)) {
    const qs = new URLSearchParams();
    if (params?.host) qs.set('host', params.host);
    if (params?.port) qs.set('port', params.port);
    if (typeof params?.useTls === 'boolean') qs.set('useTls', String(params.useTls));
    if (params?.username) qs.set('username', params.username);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    try {
      const res = await nasFetch(`/api/nas/fritz-session/status${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 400 && res.status !== 404) {
        const data = await parseJsonSafe<FritzSidSessionStatus>(res);
        if (data && typeof data.host === 'string') {
          writeLocalFritzStatusCache(data);
          return data;
        }
      }
    } catch {
      // Weiter zu nativem/direktem FRITZ!Box-Check
    }
  }

  // Fallback / Storage-Bridge / Android Native: direkt gegen Ziel-Host prüfen (ohne /api/nas/ zu crashen)
  if (isNativeAndroidShell()) {
    const nativeDiag = diagnoseNativeServerConnection(
      `${params?.useTls ? 'https' : 'http'}://${targetHost}:${targetPortNum}`
    );
    const fritz = nativeDiag?.fritzBoxInfo;
    if (nativeDiag?.detectedFritzBox || fritz?.detected) {
      const effectiveTls = Boolean(params?.useTls && fritz?.httpsAvailable);
      const effectivePort = effectiveTls ? 443 : fritz?.httpAvailable ? 80 : targetPortNum;
      const status = buildFallbackFritzStatus(params, {
        connected: false,
        host: nativeDiag?.resolvedIp || targetHost,
        port: effectivePort,
        useTls: effectiveTls,
        tr064Available: Boolean(fritz?.tr064Available),
        blockTimeSec: 0,
        message: `${fritz?.friendlyName || 'FRITZ!Box / FRITZ!NAS'} erkannt (${
          fritz?.httpsAvailable ? 'HTTPS:443 aktiv' : 'HTTPS:443 nicht aktiv'
        }${fritz?.httpAvailable ? ', HTTP:80 aktiv' : ', HTTP:80 aus'}). ${
          fritz?.requiresAuth
            ? 'Zugangsdaten eingeben und per Challenge-Response (SID) anmelden.'
            : 'Direktzugriff verfügbar.'
        }`,
      });
      writeLocalFritzStatusCache(status);
      return status;
    }
    if (nativeDiag?.dnsOk === false || nativeDiag?.errorKind === 'dns_failed') {
      const status = buildFallbackFritzStatus(params, {
        connected: false,
        host: targetHost,
        message:
          nativeDiag.detail ||
          `Hostname "${targetHost}" nicht per DNS auflösbar — gib ggf. die IP-Adresse (z. B. 192.168.178.1 oder 192.168.178.69) an.`,
      });
      writeLocalFritzStatusCache(status);
      return status;
    }
    if (nativeDiag && nativeDiag.tcpOk === false && !nativeDiag.port3000Reachable) {
      const status = buildFallbackFritzStatus(params, {
        connected: false,
        host: nativeDiag.resolvedIp || targetHost,
        message:
          nativeDiag.detail ||
          `FRITZ!Box unter ${targetHost} antwortet weder auf TR-064 (/tr64desc.xml) noch auf /login_sid.lua. Prüfe Host/IP oder wechsle zwischen HTTP (:80) und HTTPS (:443).`,
      });
      writeLocalFritzStatusCache(status);
      return status;
    }
  }

  const cached = readLocalFritzStatusCache();
  if (cached && cached.host === targetHost && cached.connected) {
    return cached;
  }

  return buildFallbackFritzStatus(params, {
    host: targetHost,
    message: `Lokaler Storage-Bridge-Modus aktiv. Nutze „Challenge-Response Login (SID)“, um ${targetHost} direkt auf Port ${targetPortNum} (HTTP/HTTPS-Auto-Fallback) zu prüfen.`,
  });
}

export async function loginFritzSession(
  token: string,
  payload: {
    host: string;
    port?: string;
    useTls?: boolean;
    username?: string;
    password?: string;
    allowLocalSelfSignedTls?: boolean;
    forceRefresh?: boolean;
  }
): Promise<FritzSidSessionStatus & { ok: boolean; reused?: boolean; error?: string }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch('/api/nas/fritz-session/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.status !== 400 && res.status !== 404) {
        const parsed = await parseJsonSafe<
          FritzSidSessionStatus & { ok: boolean; reused?: boolean; error?: string }
        >(res);
        if (parsed && typeof parsed.host === 'string') {
          writeLocalFritzStatusCache(parsed);
          return parsed;
        }
      }
    } catch {
      // Direkter Fallback unten
    }
  }

  const direct = await fritzBoxDirectLoginWithSession({
    host: cleanFritzHostInput(payload.host),
    port: payload.port,
    useTls: payload.useTls,
    username: payload.username,
    password: payload.password,
    allowLocalSelfSignedTls: payload.allowLocalSelfSignedTls ?? true,
    forceRefresh: payload.forceRefresh ?? true,
    verifyBrowseTree: false,
  });

  const status = buildFallbackFritzStatus(
    {
      host: direct.host || payload.host,
      port: String(direct.effectivePort || payload.port || (payload.useTls ? 443 : 80)),
      useTls: direct.effectiveScheme ? direct.effectiveScheme === 'https' : payload.useTls,
      username: payload.username,
    },
    {
      connected: Boolean(direct.ok),
      sidPreview: direct.sidPreview ?? null,
      tr064Available: Boolean(direct.tr064Available),
      blockTimeSec: direct.blockTimeSec ?? 0,
      hasSecret: Boolean(payload.password),
      obtainedAt: direct.ok ? new Date().toISOString() : null,
      tlsBypassedForLocalSelfSigned: Boolean(direct.httpsFallbackToHttp),
      message: direct.ok
        ? `FRITZ!Box Challenge-Response Login erfolgreich (${direct.sidPreview || 'SID aktiv'}).`
        : direct.error || 'FRITZ!Box Challenge-Response Login fehlgeschlagen.',
    }
  );
  writeLocalFritzStatusCache(status);

  return {
    ...status,
    ok: Boolean(direct.ok),
    reused: direct.reused,
    error: direct.error ?? undefined,
  };
}

export async function browseFritzNas(
  token: string,
  payload: {
    host: string;
    port?: string;
    useTls?: boolean;
    username?: string;
    password?: string;
    path?: string;
    allowLocalSelfSignedTls?: boolean;
  }
): Promise<{
  ok: boolean;
  sidPreview: string | null;
  path: string;
  items: FritzNasBrowseItem[];
  source: string;
  error?: string;
}> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch('/api/nas/fritz-session/browse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (res.status !== 400 && res.status !== 404) {
        const parsed = await parseJsonSafe<{
          ok: boolean;
          sidPreview: string | null;
          path: string;
          items: FritzNasBrowseItem[];
          source: string;
          error?: string;
        }>(res);
        if (parsed && typeof parsed.path === 'string') {
          return parsed;
        }
      }
    } catch {
      // Weiter zu nativem Browse-Fallback
    }
  }

  const tree = await browseNasDirectoryTree({
    protocol: 'fritz_upnp',
    host: cleanFritzHostInput(payload.host),
    port: payload.port,
    path: payload.path || '/',
    username: payload.username,
    secret: payload.password,
    useTls: payload.useTls,
  });

  const cached = readLocalFritzStatusCache();
  return {
    ok: tree.ok,
    sidPreview: cached?.sidPreview ?? null,
    path: tree.currentPath || payload.path || '/',
    items: (tree.entries ?? []).map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.sizeBytes,
    })),
    source: tree.source || 'fritz_nas_api',
    error: tree.error ?? undefined,
  };
}

export async function logoutFritzSession(
  token: string,
  payload: { host: string; port?: string; useTls?: boolean; username?: string }
): Promise<{ ok: boolean }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch('/api/nas/fritz-session/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const parsed = await parseJsonSafe<{ ok: boolean }>(res);
      if (parsed) return parsed;
    } catch {
      // Lokalen Status zurücksetzen
    }
  }

  const cleared = buildFallbackFritzStatus(payload, {
    connected: false,
    sidPreview: null,
    message: 'FRITZ!Box Session-ID (SID) verworfen.',
  });
  writeLocalFritzStatusCache(cleared);
  return { ok: true };
}

export async function fetchNasConnectionProfiles(
  token: string
): Promise<{ profiles: NasConnectionProfile[]; error?: string }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch('/api/nas/connection/profiles', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = await parseJsonSafe<{ profiles: NasConnectionProfile[]; error?: string }>(res);
      if (parsed && Array.isArray(parsed.profiles)) {
        writeLocalProfiles(parsed.profiles);
        return parsed;
      }
    } catch {
      // Auf lokalen Puffer ausweichen
    }
  }
  return { profiles: readLocalProfiles() };
}

export async function saveNasConnectionProfile(
  token: string,
  payload: Partial<NasConnectionProfile> & {
    name: string;
    scope: NasConnectionProfile['scope'];
    protocol: NasProtocolId;
    host: string;
    secret?: string;
  }
): Promise<{ ok?: boolean; profile?: NasConnectionProfile; profiles?: NasConnectionProfile[]; error?: string }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch('/api/nas/connection/profiles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const parsed = await parseJsonSafe<{
        ok?: boolean;
        profile?: NasConnectionProfile;
        profiles?: NasConnectionProfile[];
        error?: string;
      }>(res);
      if (parsed) {
        if (Array.isArray(parsed.profiles)) {
          writeLocalProfiles(parsed.profiles);
        }
        return parsed;
      }
    } catch {
      // Im lokalen Profil-Puffer sichern
    }
  }

  const existing = readLocalProfiles();
  const id = payload.id || `prof-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const cleanHost = payload.host.trim();
  const effectiveUseTls = payload.protocol === 'smb' ? false : Boolean(payload.useTls);
  const nextProfile: NasConnectionProfile = {
    id,
    name: payload.name.trim(),
    scope: payload.scope,
    protocol: payload.protocol,
    host: cleanHost,
    port: String(
      sanitizeNasPortForProtocol(
        payload.protocol,
        payload.port?.trim() || (effectiveUseTls ? '443' : '80'),
        effectiveUseTls
      )
    ),
    shareOrPath: payload.shareOrPath?.trim() || '/',
    username: payload.username?.trim() || '',
    hasSecret: Boolean(payload.secret && payload.secret.length > 0),
    useTls: effectiveUseTls,
    allowSelfSignedLocalTls: payload.allowSelfSignedLocalTls ?? true,
    ddnsOrVpnHint: payload.ddnsOrVpnHint?.trim() || undefined,
    priority: payload.priority ?? existing.length + 1,
    isActive: existing.length === 0 ? true : Boolean(payload.isActive),
    lastTestedAt: payload.lastTestedAt ?? null,
    lastTestOk: payload.lastTestOk ?? null,
    lastTestMessage: payload.lastTestMessage ?? 'Lokal im Geräte-Puffer gespeichert (wird beim nächsten NAS-Sync übertragen).',
    lastLatencyMs: payload.lastLatencyMs ?? null,
    updatedAt: now,
  };
  const updated = [nextProfile, ...existing.filter((p) => p.id !== id)];
  writeLocalProfiles(updated);
  return { ok: true, profile: nextProfile, profiles: updated };
}

export async function activateNasConnectionProfile(
  token: string,
  profileId: string
): Promise<{ ok?: boolean; profile?: NasConnectionProfile; profiles?: NasConnectionProfile[]; error?: string }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch(`/api/nas/connection/profiles/${encodeURIComponent(profileId)}/activate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = await parseJsonSafe<{
        ok?: boolean;
        profile?: NasConnectionProfile;
        profiles?: NasConnectionProfile[];
        error?: string;
      }>(res);
      if (parsed) {
        if (Array.isArray(parsed.profiles)) {
          writeLocalProfiles(parsed.profiles);
        }
        return parsed;
      }
    } catch {
      // Lokalen Puffer aktivieren
    }
  }

  const list = readLocalProfiles();
  const target = list.find((p) => p.id === profileId);
  if (!target) {
    return { ok: false, error: 'Verbindungsprofil nicht gefunden.' };
  }
  const updated = list.map((p) => ({
    ...p,
    isActive: p.id === profileId,
    updatedAt: p.id === profileId ? new Date().toISOString() : p.updatedAt,
  }));
  writeLocalProfiles(updated);
  return { ok: true, profile: { ...target, isActive: true }, profiles: updated };
}

export async function testNasConnectionProfile(
  token: string,
  profileId: string
): Promise<{
  ok: boolean;
  latencyMs?: number;
  resolvedIp?: string;
  scope?: string;
  tlsBypassedForLocalSelfSigned?: boolean;
  message?: string;
  error?: string;
  profile?: NasConnectionProfile;
}> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch(`/api/nas/connection/profiles/${encodeURIComponent(profileId)}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 400 && res.status !== 404) {
        const parsed = await parseJsonSafe<{
          ok: boolean;
          latencyMs?: number;
          resolvedIp?: string;
          scope?: string;
          tlsBypassedForLocalSelfSigned?: boolean;
          message?: string;
          error?: string;
          profile?: NasConnectionProfile;
        }>(res);
        if (parsed) return parsed;
      }
    } catch {
      // Direkter Test unten
    }
  }

  const list = readLocalProfiles();
  const target = list.find((p) => p.id === profileId);
  if (!target) {
    return { ok: false, error: 'Verbindungsprofil nicht gefunden.' };
  }

  const startedAt = Date.now();
  const mappedScope = target.scope === 'lan' ? 'lan' : target.scope === 'vpn' ? 'vpn' : 'internet';
  const universalTest = await testUniversalNasConnection({
    host: target.host,
    port: String(sanitizeNasPortForProtocol(target.protocol, target.port, target.useTls)),
    protocol: target.protocol,
    shareOrPath: target.shareOrPath,
    username: target.username,
    useTls: target.protocol === 'smb' ? false : target.useTls,
    ftpsTlsMode: target.ftpsTlsMode,
    scope: mappedScope,
  });

  let ok = universalTest.ok;
  let resolvedIp: string | undefined;
  let message = universalTest.verification?.message || universalTest.error || '';

  if (!ok && isNativeAndroidShell()) {
    const testUrl = `${target.useTls ? 'https' : 'http'}://${target.host}${target.port ? `:${target.port}` : ''}`;
    const diag = diagnoseNativeServerConnection(testUrl);
    if (diag) {
      resolvedIp = diag.resolvedIp;
      if (diag.detectedFritzBox && target.protocol === 'fritz_upnp') {
        ok = true;
        message = `FRITZ!Box / FRITZ!NAS unter ${target.host} erreichbar (${diag.detail || 'SID/TR-064 bereit'}).`;
      } else if (!message) {
        message = diag.detail || `Ziel ${target.host}:${target.port} noch nicht erreichbar.`;
      }
    }
  }

  const latencyMs = universalTest.verification?.latencyMs ?? Math.max(1, Date.now() - startedAt);
  const updatedProfile: NasConnectionProfile = {
    ...target,
    lastTestedAt: new Date().toISOString(),
    lastTestOk: ok,
    lastTestMessage: message || (ok ? 'Protokoll verifiziert' : 'Nicht erreichbar'),
    lastLatencyMs: ok ? latencyMs : null,
    updatedAt: new Date().toISOString(),
  };
  writeLocalProfiles(list.map((p) => (p.id === profileId ? updatedProfile : p)));
  return {
    ok,
    latencyMs: ok ? latencyMs : undefined,
    resolvedIp,
    scope: target.scope,
    message: updatedProfile.lastTestMessage ?? undefined,
    error: ok ? undefined : updatedProfile.lastTestMessage ?? undefined,
    profile: updatedProfile,
  };
}

export async function deleteNasConnectionProfile(
  token: string,
  profileId: string
): Promise<{ ok?: boolean; profiles?: NasConnectionProfile[]; error?: string }> {
  if (hasConfiguredBackendApi(token)) {
    try {
      const res = await nasFetch(`/api/nas/connection/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = await parseJsonSafe<{
        ok?: boolean;
        profiles?: NasConnectionProfile[];
        error?: string;
      }>(res);
      if (parsed) {
        if (Array.isArray(parsed.profiles)) {
          writeLocalProfiles(parsed.profiles);
        }
        return parsed;
      }
    } catch {
      // Lokal löschen
    }
  }

  const updated = readLocalProfiles().filter((p) => p.id !== profileId);
  writeLocalProfiles(updated);
  return { ok: true, profiles: updated };
}

export { resolveNasUrl };

