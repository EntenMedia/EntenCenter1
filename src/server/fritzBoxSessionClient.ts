import crypto from 'node:crypto';
import type { FritzNasBrowseItem, FritzSidSessionStatus } from '../types/marcente.ts';
import { isLocalLanHostnameOrIp, requestWithLocalTlsPolicy } from './localTlsFetch.ts';

export interface FritzBoxSessionOptions {
  host: string;
  port?: number;
  useTls?: boolean;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls?: boolean;
  customCaPem?: string | null;
}

export interface FritzLoginSidXmlInfo {
  sid: string;
  challenge: string;
  blockTimeSec: number;
  rights: string[];
  users: string[];
  lastUser: string | null;
  nasAccessLevel: number | null;
}

export interface FritzCachedSessionEntry {
  key: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  sid: string;
  challengeVersion: 'md5_v1' | 'pbkdf2_v2';
  rights: string[];
  obtainedAt: string;
  lastVerifiedAt: string;
  tlsBypassedForLocalSelfSigned: boolean;
  friendlyName?: string | null;
  modelName?: string | null;
}

export interface FritzLoginSidProbeResult {
  detected: boolean;
  friendlyName: string;
  modelName: string | null;
  tr064Available: boolean;
  loginSidAvailable: boolean;
  requiresAuth: boolean;
  httpAvailable: boolean;
  httpsAvailable: boolean;
  httpsError: string | null;
  loginSidUrl: string | null;
  preferredPort: number;
  preferredScheme: 'http' | 'https';
  users: string[];
  lastUser: string | null;
  nasAccessLevel: number | null;
  tlsBypassedForLocalSelfSigned: boolean;
}

export interface FritzAuthenticateResult {
  ok: boolean;
  reused: boolean;
  sid: string;
  sidPreview: string | null;
  challenge: string;
  challengeVersion: 'md5_v1' | 'pbkdf2_v2';
  responseSignaturePreview: string;
  blockTimeSec: number;
  rights: string[];
  selectedUser?: string | null;
  lastUser?: string | null;
  nasAccessLevel?: number | null;
  tlsBypassedForLocalSelfSigned: boolean;
  friendlyName?: string | null;
  modelName?: string | null;
  tr064Available: boolean;
  requiresAuth?: boolean;
  httpsFallbackToHttp?: boolean;
  httpsError?: string | null;
  effectiveScheme?: 'http' | 'https';
  effectivePort?: number;
  error?: string;
}

const EMPTY_SID = '0000000000000000';
const sidMemoryCache = new Map<string, FritzCachedSessionEntry>();

function extractXmlTagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() ?? '';
}

function extractXmlTagList(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    const val = m[1]?.trim();
    if (val) results.push(val);
  }
  return results;
}

function extractFritzUsersFromXml(xml: string): { users: string[]; lastUser: string | null } {
  const users: string[] = [];
  let lastUser: string | null = null;
  const regex = /<User([^>]*)>([^<]*)<\/User>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const name = (m[2] || '').trim();
    if (!name) continue;
    const isLast = /\blast\s*=\s*["']?1["']?/i.test(attrs);
    if (isLast) {
      lastUser = name;
      if (!users.includes(name)) users.unshift(name);
    } else if (!users.includes(name)) {
      users.push(name);
    }
  }
  return { users, lastUser: lastUser ?? users[0] ?? null };
}

function extractNasAccessLevelFromXml(xml: string): number | null {
  const m = /<Name>\s*NAS\s*<\/Name>\s*<Access>\s*(\d+)\s*<\/Access>/is.exec(xml);
  if (!m?.[1]) return null;
  const num = Number.parseInt(m[1], 10);
  return Number.isFinite(num) ? num : null;
}

export function normalizeFritzHostAndScheme(
  rawHost: string,
  rawPort?: number | string,
  explicitUseTls?: boolean
): {
  host: string;
  port: number;
  useTls: boolean;
  webBaseUrl: string;
  tr064BaseUrl: string;
} {
  let hostInput = (rawHost ?? '').trim() || 'fritz.box';
  let inferredTls = typeof explicitUseTls === 'boolean' ? explicitUseTls : false;
  let parsedPort =
    typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string' && rawPort.trim()
        ? Number(rawPort.trim())
        : 0;

  if (/^https?:\/\//i.test(hostInput)) {
    try {
      const u = new URL(hostInput);
      inferredTls = u.protocol === 'https:';
      hostInput = u.hostname;
      if (!parsedPort && u.port) {
        parsedPort = Number(u.port);
      }
    } catch {
      hostInput = hostInput.replace(/^https?:\/\//i, '').split('/')[0] || 'fritz.box';
    }
  } else {
    hostInput = hostInput.split('/')[0];
    const colonIdx = hostInput.lastIndexOf(':');
    if (colonIdx > 0 && !hostInput.includes(']')) {
      const portCandidate = Number(hostInput.slice(colonIdx + 1));
      if (Number.isInteger(portCandidate) && portCandidate > 0) {
        if (!parsedPort) parsedPort = portCandidate;
        hostInput = hostInput.slice(0, colonIdx);
      }
    }
  }

  const NON_HTTP_PORTS = new Set([20, 21, 22, 139, 445, 990, 5005, 5006, 49000, 49443]);
  if (parsedPort === 443 || parsedPort === 49443) {
    inferredTls = true;
  }
  const effectivePort =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 && !NON_HTTP_PORTS.has(parsedPort)
      ? parsedPort
      : inferredTls
        ? 443
        : 80;
  const webScheme = inferredTls ? 'https' : 'http';
  const defaultWebPort = inferredTls ? 443 : 80;
  const webPortSuffix = effectivePort === defaultWebPort ? '' : `:${effectivePort}`;

  const tr064UseTls = inferredTls || parsedPort === 49443;
  const tr064Port = tr064UseTls ? 49443 : 49000;

  return {
    host: hostInput,
    port: effectivePort,
    useTls: inferredTls,
    webBaseUrl: `${webScheme}://${hostInput}${webPortSuffix}`,
    tr064BaseUrl: `${tr064UseTls ? 'https' : 'http'}://${hostInput}:${tr064Port}`,
  };
}

export function maskSidPreview(sid: string | null | undefined): string | null {
  if (!sid || sid === EMPTY_SID || sid.length < 8) return null;
  return `${sid.slice(0, 4)}••••${sid.slice(-4)}`;
}

/**
 * Hilfsklasse für das offizielle AVM FRITZ!Box Challenge-Response-Verfahren (`login_sid.lua`):
 * 1. Challenge abrufen bzw. vorhandene temporäre SID auf Gültigkeit prüfen & wiederverwenden
 * 2. Password-Zeichen > 255 durch '.' ersetzen, UTF-16LE codieren und MD5-Hash bilden
 * 3. `challenge-md5Hex` senden, Session-ID (SID) cachen und für TR-064 / FRITZ!NAS nutzen
 */
export class FritzBoxSessionClient {
  public readonly host: string;
  public readonly port: number;
  public readonly useTls: boolean;
  public readonly webBaseUrl: string;
  public readonly tr064BaseUrl: string;
  public readonly username: string;
  public readonly password: string;
  public readonly allowLocalSelfSignedTls: boolean;
  public readonly customCaPem: string | null;

  public effectiveUseTls: boolean;
  public effectivePort: number;
  public effectiveWebBaseUrl: string;
  public httpsFallbackToHttp = false;
  public lastHttpsError: string | null = null;

  constructor(options: FritzBoxSessionOptions) {
    const resolved = normalizeFritzHostAndScheme(options.host, options.port, options.useTls);
    this.host = resolved.host;
    this.port = resolved.port;
    this.useTls = resolved.useTls;
    this.webBaseUrl = resolved.webBaseUrl;
    this.tr064BaseUrl = resolved.tr064BaseUrl;
    this.effectiveUseTls = resolved.useTls;
    this.effectivePort = resolved.port === 49000 || resolved.port === 49443 ? (resolved.useTls ? 443 : 80) : resolved.port;
    this.effectiveWebBaseUrl = resolved.webBaseUrl;
    this.username = (options.username ?? '').trim();
    this.password = options.password ?? '';
    this.allowLocalSelfSignedTls = options.allowLocalSelfSignedTls ?? true;
    this.customCaPem = options.customCaPem ?? null;
  }

  private get cacheKey(): string {
    return `${this.effectiveUseTls ? 'https' : 'http'}://${this.host.toLowerCase()}:${this.effectivePort}|${this.username.toLowerCase()}`;
  }

  /**
   * Berechnet die AVM FRITZ!Box Challenge-Response-Signatur.
   * Standard v1: `<Challenge>-MD5(UTF-16LE(<Challenge>-<Password>))`
   * Unterstützt zudem PBKDF2-v2-Challenges (`2$iter1$salt1$iter2$salt2`).
   */
  public static computeChallengeResponse(
    challenge: string,
    password: string
  ): {
    response: string;
    version: 'md5_v1' | 'pbkdf2_v2';
    hashHex: string;
  } {
    const cleanChallenge = (challenge ?? '').trim();

    if (cleanChallenge.startsWith('2$')) {
      const parts = cleanChallenge.split('$');
      if (parts.length === 5) {
        const iter1 = Math.max(1, Number.parseInt(parts[1], 10) || 1);
        const salt1 = Buffer.from(parts[2], 'hex');
        const iter2 = Math.max(1, Number.parseInt(parts[3], 10) || 1);
        const salt2 = Buffer.from(parts[4], 'hex');
        const hash1 = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt1, iter1, 32, 'sha256');
        const hash2 = crypto.pbkdf2Sync(hash1, salt2, iter2, 32, 'sha256');
        const hashHex = hash2.toString('hex');
        return {
          response: `${parts[4]}$${hashHex}`,
          version: 'pbkdf2_v2',
          hashHex,
        };
      }
    }

    // Offizielle AVM-Spezifikation: UTF-16 Codepoints > 255 durch '.' ersetzen, danach UTF-16LE -> MD5
    let sanitizedPassword = '';
    for (let i = 0; i < password.length; i += 1) {
      const code = password.charCodeAt(i);
      sanitizedPassword += code > 255 ? '.' : password[i];
    }

    const challengeInput = `${cleanChallenge}-${sanitizedPassword}`;
    const utf16leBuf = Buffer.from(challengeInput, 'utf16le');
    const md5Hex = crypto.createHash('md5').update(utf16leBuf).digest('hex');

    return {
      response: `${cleanChallenge}-${md5Hex}`,
      version: 'md5_v1',
      hashHex: md5Hex,
    };
  }

  public static parseSessionInfoXml(xml: string): FritzLoginSidXmlInfo {
    const sid = extractXmlTagText(xml, 'SID') || EMPTY_SID;
    const challenge = extractXmlTagText(xml, 'Challenge');
    const blockTimeSec = Math.max(0, Number.parseInt(extractXmlTagText(xml, 'BlockTime') || '0', 10) || 0);
    const rights = extractXmlTagList(xml, 'Name');
    const { users, lastUser } = extractFritzUsersFromXml(xml);
    const nasAccessLevel = extractNasAccessLevelFromXml(xml);
    return { sid, challenge, blockTimeSec, rights, users, lastUser, nasAccessLevel };
  }

  public static getCachedSession(
    host: string,
    port?: number | string,
    useTls?: boolean,
    username = ''
  ): FritzCachedSessionEntry | null {
    const resolved = normalizeFritzHostAndScheme(host, port, useTls);
    const key = `${resolved.useTls ? 'https' : 'http'}://${resolved.host.toLowerCase()}:${resolved.port}|${username.trim().toLowerCase()}`;
    return sidMemoryCache.get(key) ?? null;
  }

  private isLocalSelfSignedAllowedForTarget(): boolean {
    return this.allowLocalSelfSignedTls && isLocalLanHostnameOrIp(this.host);
  }

  private tryActivateLanHttpFallback(reason: string): boolean {
    if (!this.effectiveUseTls || !isLocalLanHostnameOrIp(this.host)) {
      return false;
    }
    this.lastHttpsError = reason;
    this.httpsFallbackToHttp = true;
    this.effectiveUseTls = false;
    this.effectivePort = 80;
    this.effectiveWebBaseUrl = `http://${this.host}`;
    return true;
  }

  private tryActivateLanHttpsFallback(): boolean {
    if (this.effectiveUseTls || !isLocalLanHostnameOrIp(this.host)) {
      return false;
    }
    this.effectiveUseTls = true;
    this.effectivePort = 443;
    this.effectiveWebBaseUrl = `https://${this.host}`;
    return true;
  }

  public static async probeLoginSid(
    rawHost: string,
    allowLocalSelfSignedTls = true,
    customCaPem: string | null = null,
    timeoutMs = 1800
  ): Promise<FritzLoginSidProbeResult> {
    const normalized = normalizeFritzHostAndScheme(rawHost);
    const cleanHost = normalized.host;
    const isLan = isLocalLanHostnameOrIp(cleanHost);
    const allowSelfSigned = allowLocalSelfSignedTls && isLan;

    const clientForTr064 = new FritzBoxSessionClient({
      host: cleanHost,
      allowLocalSelfSignedTls,
      customCaPem,
    });

    const probeOne = async (
      scheme: 'http' | 'https',
      port: number
    ): Promise<{
      ok: boolean;
      info: FritzLoginSidXmlInfo | null;
      tlsBypassed: boolean;
      error: string | null;
      url: string;
    }> => {
      const portSuffix = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443) ? '' : `:${port}`;
      const urlV2 = `${scheme}://${cleanHost}${portSuffix}/login_sid.lua?version=2`;
      const urlV1 = `${scheme}://${cleanHost}${portSuffix}/login_sid.lua`;
      let url = urlV2;
      try {
        let res = await requestWithLocalTlsPolicy(urlV2, {
          method: 'GET',
          timeoutMs,
          allowLocalSelfSignedTls: allowSelfSigned,
          customCaPem,
        });
        if (!res.ok) {
          url = urlV1;
          res = await requestWithLocalTlsPolicy(urlV1, {
            method: 'GET',
            timeoutMs,
            allowLocalSelfSignedTls: allowSelfSigned,
            customCaPem,
          });
        }
        if (!res.ok) {
          return {
            ok: false,
            info: null,
            tlsBypassed: res.tlsBypassedForLocalSelfSigned,
            error: `HTTP ${res.status}`,
            url,
          };
        }
        if (!res.body.includes('<SessionInfo>') && !res.body.includes('<Challenge>')) {
          return {
            ok: false,
            info: null,
            tlsBypassed: res.tlsBypassedForLocalSelfSigned,
            error: 'Kein FRITZ!Box SessionInfo-XML',
            url,
          };
        }
        return {
          ok: true,
          info: FritzBoxSessionClient.parseSessionInfoXml(res.body),
          tlsBypassed: res.tlsBypassedForLocalSelfSigned,
          error: null,
          url,
        };
      } catch (err) {
        return {
          ok: false,
          info: null,
          tlsBypassed: false,
          error: err instanceof Error ? err.message : 'Verbindungsfehler',
          url,
        };
      }
    };

    const [httpProbe, httpsProbe, tr064] = await Promise.all([
      probeOne('http', 80),
      probeOne('https', 443),
      clientForTr064.fetchTr064DeviceInfo().catch(() => ({
        available: false,
        friendlyName: null,
        modelName: null,
        tlsBypassedForLocalSelfSigned: false,
      })),
    ]);

    const loginSidAvailable = httpProbe.ok || httpsProbe.ok;
    const detected = loginSidAvailable || tr064.available;
    const activeInfo = httpProbe.info ?? httpsProbe.info;
    const requiresAuth = activeInfo ? !activeInfo.sid || activeInfo.sid === EMPTY_SID : false;
    const preferredScheme: 'http' | 'https' = httpProbe.ok || !httpsProbe.ok ? 'http' : 'https';
    const preferredPort = httpProbe.ok
      ? 80
      : httpsProbe.ok
        ? 443
        : tr064.available
          ? 49000
          : 80;

    return {
      detected,
      friendlyName: tr064.friendlyName || `FRITZ!Box (${cleanHost})`,
      modelName: tr064.modelName,
      tr064Available: tr064.available,
      loginSidAvailable,
      requiresAuth,
      httpAvailable: httpProbe.ok,
      httpsAvailable: httpsProbe.ok,
      httpsError: httpsProbe.ok ? null : httpsProbe.error,
      loginSidUrl: httpProbe.ok ? httpProbe.url : httpsProbe.ok ? httpsProbe.url : null,
      preferredPort,
      preferredScheme,
      users: activeInfo?.users ?? [],
      lastUser: activeInfo?.lastUser ?? null,
      nasAccessLevel: activeInfo?.nasAccessLevel ?? null,
      tlsBypassedForLocalSelfSigned:
        httpProbe.tlsBypassed || httpsProbe.tlsBypassed || tr064.tlsBypassedForLocalSelfSigned,
    };
  }

  public async fetchChallenge(existingSid?: string): Promise<{
    info: FritzLoginSidXmlInfo;
    tlsBypassedForLocalSelfSigned: boolean;
  }> {
    const query = existingSid
      ? `?version=2&sid=${encodeURIComponent(existingSid)}`
      : '?version=2';
    const fallbackQuery = existingSid ? `?sid=${encodeURIComponent(existingSid)}` : '';
    const primaryUrl = `${this.effectiveWebBaseUrl}/login_sid.lua${query}`;
    try {
      let res = await requestWithLocalTlsPolicy(primaryUrl, {
        method: 'GET',
        timeoutMs: 4000,
        allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
        customCaPem: this.customCaPem,
      });
      if (!res.ok && fallbackQuery !== query) {
        res = await requestWithLocalTlsPolicy(`${this.effectiveWebBaseUrl}/login_sid.lua${fallbackQuery}`, {
          method: 'GET',
          timeoutMs: 4000,
          allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
          customCaPem: this.customCaPem,
        });
      }
      if (!res.ok) {
        throw new Error(`FRITZ!Box login_sid.lua lieferte HTTP ${res.status}.`);
      }
      return {
        info: FritzBoxSessionClient.parseSessionInfoXml(res.body),
        tlsBypassedForLocalSelfSigned: res.tlsBypassedForLocalSelfSigned,
      };
    } catch (primaryErr) {
      const errMsg = primaryErr instanceof Error ? primaryErr.message : 'Verbindungsfehler';
      if (this.tryActivateLanHttpFallback(errMsg)) {
        const fallbackRes = await requestWithLocalTlsPolicy(
          `${this.effectiveWebBaseUrl}/login_sid.lua${query}`,
          {
            method: 'GET',
            timeoutMs: 4000,
            allowLocalSelfSignedTls: false,
            customCaPem: null,
          }
        );
        if (!fallbackRes.ok) {
          throw new Error(`FRITZ!Box login_sid.lua (HTTP-Fallback :80) lieferte HTTP ${fallbackRes.status}.`);
        }
        return {
          info: FritzBoxSessionClient.parseSessionInfoXml(fallbackRes.body),
          tlsBypassedForLocalSelfSigned: false,
        };
      }
      if (this.tryActivateLanHttpsFallback()) {
        const httpsRes = await requestWithLocalTlsPolicy(
          `${this.effectiveWebBaseUrl}/login_sid.lua${query}`,
          {
            method: 'GET',
            timeoutMs: 4000,
            allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
            customCaPem: this.customCaPem,
          }
        );
        if (httpsRes.ok) {
          return {
            info: FritzBoxSessionClient.parseSessionInfoXml(httpsRes.body),
            tlsBypassedForLocalSelfSigned: httpsRes.tlsBypassedForLocalSelfSigned,
          };
        }
      }
      throw primaryErr;
    }
  }

  public async fetchTr064DeviceInfo(): Promise<{
    available: boolean;
    friendlyName: string | null;
    modelName: string | null;
    tlsBypassedForLocalSelfSigned: boolean;
  }> {
    const targets = [
      `${this.tr064BaseUrl}/tr64desc.xml`,
      `http://${this.host}:49000/tr64desc.xml`,
      `https://${this.host}:49443/tr64desc.xml`,
      `http://${this.host}:49000/MediaServerDevDesc.xml`,
    ];

    for (const url of Array.from(new Set(targets))) {
      try {
        const res = await requestWithLocalTlsPolicy(url, {
          method: 'GET',
          timeoutMs: 2200,
          allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
          customCaPem: this.customCaPem,
        });
        if (res.ok && (res.body.includes('<device') || res.body.toLowerCase().includes('fritz'))) {
          return {
            available: true,
            friendlyName: extractXmlTagText(res.body, 'friendlyName') || null,
            modelName: extractXmlTagText(res.body, 'modelName') || null,
            tlsBypassedForLocalSelfSigned: res.tlsBypassedForLocalSelfSigned,
          };
        }
      } catch {
        // Nächsten TR-064/UPnP Endpunkt probieren
      }
    }

    return {
      available: false,
      friendlyName: null,
      modelName: null,
      tlsBypassedForLocalSelfSigned: false,
    };
  }

  public async getValidSession(forceRefresh = false): Promise<FritzAuthenticateResult> {
    const cached = !forceRefresh ? sidMemoryCache.get(this.cacheKey) : undefined;
    let tlsBypassed = cached?.tlsBypassedForLocalSelfSigned ?? false;

    if (cached && cached.sid && cached.sid !== EMPTY_SID) {
      try {
        const check = await this.fetchChallenge(cached.sid);
        tlsBypassed = tlsBypassed || check.tlsBypassedForLocalSelfSigned;
        if (check.info.sid === cached.sid && check.info.sid !== EMPTY_SID) {
          cached.lastVerifiedAt = new Date().toISOString();
          cached.rights = check.info.rights.length > 0 ? check.info.rights : cached.rights;
          cached.tlsBypassedForLocalSelfSigned = tlsBypassed;
          sidMemoryCache.set(this.cacheKey, cached);
          return {
            ok: true,
            reused: true,
            sid: cached.sid,
            sidPreview: maskSidPreview(cached.sid),
            challenge: check.info.challenge,
            challengeVersion: cached.challengeVersion,
            responseSignaturePreview: '(aktive SID wiederverwendet)',
            blockTimeSec: check.info.blockTimeSec,
            rights: cached.rights,
            tlsBypassedForLocalSelfSigned: tlsBypassed,
            friendlyName: cached.friendlyName ?? null,
            modelName: cached.modelName ?? null,
            tr064Available: Boolean(cached.friendlyName),
            requiresAuth: false,
            httpsFallbackToHttp: this.httpsFallbackToHttp,
            httpsError: this.lastHttpsError,
            effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
            effectivePort: this.effectivePort,
          };
        }
      } catch {
        // Bestehende SID veraltet oder Box neu gestartet -> Challenge-Response durchführen
      }
    }

    const tr064Promise = this.fetchTr064DeviceInfo();
    const { info: challengeInfo, tlsBypassedForLocalSelfSigned: challengeTlsBypass } =
      await this.fetchChallenge();
    tlsBypassed = tlsBypassed || challengeTlsBypass;

    if (challengeInfo.blockTimeSec > 0) {
      const tr064 = await tr064Promise;
      return {
        ok: false,
        reused: false,
        sid: EMPTY_SID,
        sidPreview: null,
        challenge: challengeInfo.challenge,
        challengeVersion: challengeInfo.challenge.startsWith('2$') ? 'pbkdf2_v2' : 'md5_v1',
        responseSignaturePreview: '',
        blockTimeSec: challengeInfo.blockTimeSec,
        rights: [],
        tlsBypassedForLocalSelfSigned: tlsBypassed || tr064.tlsBypassedForLocalSelfSigned,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
        tr064Available: tr064.available,
        requiresAuth: true,
        httpsFallbackToHttp: this.httpsFallbackToHttp,
        httpsError: this.lastHttpsError,
        effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
        effectivePort: this.effectivePort,
        error: `FRITZ!Box Anmeldung vorübergehend gesperrt. Bitte ${challengeInfo.blockTimeSec} Sekunde(n) warten.`,
      };
    }

    if (challengeInfo.sid && challengeInfo.sid !== EMPTY_SID && !this.password) {
      const tr064 = await tr064Promise;
      const nowIso = new Date().toISOString();
      const entry: FritzCachedSessionEntry = {
        key: this.cacheKey,
        host: this.host,
        port: this.effectivePort,
        useTls: this.effectiveUseTls,
        username: this.username,
        sid: challengeInfo.sid,
        challengeVersion: 'md5_v1',
        rights: challengeInfo.rights,
        obtainedAt: nowIso,
        lastVerifiedAt: nowIso,
        tlsBypassedForLocalSelfSigned: tlsBypassed || tr064.tlsBypassedForLocalSelfSigned,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
      };
      sidMemoryCache.set(this.cacheKey, entry);
      return {
        ok: true,
        reused: false,
        sid: challengeInfo.sid,
        sidPreview: maskSidPreview(challengeInfo.sid),
        challenge: challengeInfo.challenge,
        challengeVersion: 'md5_v1',
        responseSignaturePreview: '(Ohne Passwort-Schutz / Heimnetz)',
        blockTimeSec: 0,
        rights: challengeInfo.rights,
        tlsBypassedForLocalSelfSigned: entry.tlsBypassedForLocalSelfSigned,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
        tr064Available: tr064.available,
        requiresAuth: false,
        httpsFallbackToHttp: this.httpsFallbackToHttp,
        httpsError: this.lastHttpsError,
        effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
        effectivePort: this.effectivePort,
      };
    }

    if (!this.password) {
      const tr064 = await tr064Promise;
      return {
        ok: false,
        reused: false,
        sid: EMPTY_SID,
        sidPreview: null,
        challenge: challengeInfo.challenge,
        challengeVersion: challengeInfo.challenge.startsWith('2$') ? 'pbkdf2_v2' : 'md5_v1',
        responseSignaturePreview: '',
        blockTimeSec: 0,
        rights: [],
        tlsBypassedForLocalSelfSigned: tlsBypassed || tr064.tlsBypassedForLocalSelfSigned,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
        tr064Available: tr064.available,
        requiresAuth: true,
        httpsFallbackToHttp: this.httpsFallbackToHttp,
        httpsError: this.lastHttpsError,
        effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
        effectivePort: this.effectivePort,
        error: 'FRITZ!Box / FRITZ!NAS verlangt vor dem Zugriff die Eingabe der FRITZ!Box-Zugangsdaten.',
      };
    }

    if (!challengeInfo.challenge) {
      throw new Error('FRITZ!Box lieferte keine gültige Login-Challenge zurück.');
    }

    const candidateUsers: string[] = [];
    if (this.username) {
      candidateUsers.push(this.username);
    }
    const matchesFritzUser =
      this.username &&
      challengeInfo.users.some((u) => u.toLowerCase() === this.username.toLowerCase());
    if (!this.username || !matchesFritzUser) {
      if (challengeInfo.lastUser && !candidateUsers.some((c) => c.toLowerCase() === challengeInfo.lastUser!.toLowerCase())) {
        candidateUsers.push(challengeInfo.lastUser);
      }
      for (const u of challengeInfo.users) {
        if (!candidateUsers.some((c) => c.toLowerCase() === u.toLowerCase())) {
          candidateUsers.push(u);
        }
      }
      if (!this.username && !candidateUsers.includes('')) {
        candidateUsers.push('');
      }
    }

    let currentChallenge = challengeInfo.challenge;
    let computed = FritzBoxSessionClient.computeChallengeResponse(currentChallenge, this.password);
    let authInfo: FritzLoginSidXmlInfo = {
      sid: EMPTY_SID,
      challenge: currentChallenge,
      blockTimeSec: 0,
      rights: [],
      users: challengeInfo.users,
      lastUser: challengeInfo.lastUser,
      nasAccessLevel: challengeInfo.nasAccessLevel,
    };
    let effectiveUser = candidateUsers[0] ?? '';

    for (let i = 0; i < Math.min(candidateUsers.length, 5); i += 1) {
      const cand = candidateUsers[i];
      if (i > 0) {
        const fresh = await this.fetchChallenge();
        tlsBypassed = tlsBypassed || fresh.tlsBypassedForLocalSelfSigned;
        if (fresh.info.blockTimeSec > 0) {
          authInfo = fresh.info;
          break;
        }
        if (fresh.info.challenge) {
          currentChallenge = fresh.info.challenge;
        }
      }

      computed = FritzBoxSessionClient.computeChallengeResponse(currentChallenge, this.password);
      const formParams = new URLSearchParams();
      if (cand) {
        formParams.set('username', cand);
      }
      formParams.set('response', computed.response);

      const loginRes = await requestWithLocalTlsPolicy(`${this.effectiveWebBaseUrl}/login_sid.lua`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formParams.toString(),
        timeoutMs: 5000,
        allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
        customCaPem: this.customCaPem,
      });

      if (!loginRes.ok) {
        throw new Error(`FRITZ!Box Challenge-Response POST fehlgeschlagen (HTTP ${loginRes.status}).`);
      }

      tlsBypassed = tlsBypassed || loginRes.tlsBypassedForLocalSelfSigned;
      authInfo = FritzBoxSessionClient.parseSessionInfoXml(loginRes.body);
      effectiveUser = cand;
      if ((authInfo.sid && authInfo.sid !== EMPTY_SID) || authInfo.blockTimeSec > 0) {
        break;
      }
    }

    const tr064 = await tr064Promise;
    tlsBypassed = tlsBypassed || tr064.tlsBypassedForLocalSelfSigned;

    if (!authInfo.sid || authInfo.sid === EMPTY_SID) {
      return {
        ok: false,
        reused: false,
        sid: EMPTY_SID,
        sidPreview: null,
        challenge: currentChallenge,
        challengeVersion: computed.version,
        responseSignaturePreview: `${currentChallenge.slice(0, 6)}…-${computed.hashHex.slice(0, 8)}…`,
        blockTimeSec: authInfo.blockTimeSec,
        rights: [],
        selectedUser: effectiveUser || null,
        lastUser: challengeInfo.lastUser,
        nasAccessLevel: authInfo.nasAccessLevel,
        tlsBypassedForLocalSelfSigned: tlsBypassed,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
        tr064Available: tr064.available,
        requiresAuth: true,
        httpsFallbackToHttp: this.httpsFallbackToHttp,
        httpsError: this.lastHttpsError,
        effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
        effectivePort: this.effectivePort,
        error:
          authInfo.blockTimeSec > 0
            ? `FRITZ!Box Zugangsdaten abgelehnt (Sperrzeit ${authInfo.blockTimeSec}s aktiv).`
            : 'FRITZ!Box Zugangsdaten ungültig oder Benutzer besitzt keine FRITZ!NAS-Berechtigung.',
      };
    }

    const nowIso = new Date().toISOString();
    const cachedEntry: FritzCachedSessionEntry = {
      key: this.cacheKey,
      host: this.host,
      port: this.effectivePort,
      useTls: this.effectiveUseTls,
      username: effectiveUser,
      sid: authInfo.sid,
      challengeVersion: computed.version,
      rights: authInfo.rights,
      obtainedAt: nowIso,
      lastVerifiedAt: nowIso,
      tlsBypassedForLocalSelfSigned: tlsBypassed,
      friendlyName: tr064.friendlyName,
      modelName: tr064.modelName,
    };
    sidMemoryCache.set(this.cacheKey, cachedEntry);

    return {
      ok: true,
      reused: false,
      sid: authInfo.sid,
      sidPreview: maskSidPreview(authInfo.sid),
      challenge: currentChallenge,
      challengeVersion: computed.version,
      responseSignaturePreview: `${currentChallenge.slice(0, 6)}…-${computed.hashHex.slice(0, 8)}…`,
      blockTimeSec: authInfo.blockTimeSec,
      rights: authInfo.rights,
      selectedUser: effectiveUser || null,
      lastUser: challengeInfo.lastUser,
      nasAccessLevel: authInfo.nasAccessLevel,
      tlsBypassedForLocalSelfSigned: tlsBypassed,
      friendlyName: tr064.friendlyName,
      modelName: tr064.modelName,
      tr064Available: tr064.available,
      requiresAuth: false,
      httpsFallbackToHttp: this.httpsFallbackToHttp,
      httpsError: this.lastHttpsError,
      effectiveScheme: this.effectiveUseTls ? 'https' : 'http',
      effectivePort: this.effectivePort,
    };
  }

  public async browseFritzNasFiles(remotePath = '/'): Promise<{
    ok: boolean;
    sidPreview: string | null;
    path: string;
    items: FritzNasBrowseItem[];
    source: 'fritz_nas_api' | 'tr064_storage' | 'none';
    error?: string;
  }> {
    const auth = await this.getValidSession(false);
    if (!auth.ok || !auth.sid || auth.sid === EMPTY_SID) {
      return {
        ok: false,
        sidPreview: null,
        path: remotePath,
        items: [],
        source: 'none',
        error: auth.error || 'Keine gültige FRITZ!Box Session-ID (SID) erhalten.',
      };
    }

    const cleanDir = remotePath.trim().startsWith('/') ? remotePath.trim() : `/${remotePath.trim()}`;
    const parseBrowseBody = (body: string): FritzNasBrowseItem[] | null => {
      const trimmed = body.trim();
      if (!trimmed.startsWith('{')) return null;
      try {
        type RawDir = { filename?: string; name?: string; path?: string; timestamp?: string };
        type RawFile = {
          filename?: string;
          name?: string;
          path?: string;
          size?: number | string;
          type?: string;
          timestamp?: string;
        };
        type RawEntry = { filename?: string; name?: string; path?: string; type?: string; isDir?: boolean; size?: number | string; timestamp?: string };
        type RawBrowseContainer = {
          error?: unknown;
          directories?: RawDir[];
          dirs?: RawDir[];
          files?: RawFile[];
          entries?: RawEntry[];
        };
        const rawParsed = JSON.parse(trimmed) as {
          error?: unknown;
          status?: string;
          directories?: RawDir[];
          dirs?: RawDir[];
          files?: RawFile[];
          entries?: RawEntry[];
          browse?: RawBrowseContainer;
          data?: RawBrowseContainer & { browse?: RawBrowseContainer };
        };
        if (
          (rawParsed.error && rawParsed.error !== 0 && rawParsed.error !== '0') ||
          (rawParsed.data?.error && rawParsed.data.error !== 0 && rawParsed.data.error !== '0')
        ) {
          return null;
        }
        const rootObj = rawParsed.data?.browse ?? rawParsed.browse ?? rawParsed.data ?? rawParsed;
        if (
          !('directories' in rootObj) &&
          !('dirs' in rootObj) &&
          !('files' in rootObj) &&
          !('entries' in rootObj) &&
          !('data' in rawParsed)
        ) {
          return null;
        }
        const directories = rootObj.directories ?? rootObj.dirs ?? [];
        const files = rootObj.files ?? [];
        const mixed = rootObj.entries ?? [];
        const items: FritzNasBrowseItem[] = [];
        for (const d of directories) {
          const name = (d.filename ?? d.name ?? '').trim();
          if (!name || name === '.' || name === '..') continue;
          const p = d.path || `${cleanDir.replace(/\/$/, '')}/${name}`;
          items.push({ name, path: p, type: 'directory', modifiedAt: d.timestamp });
        }
        for (const f of files) {
          const name = (f.filename ?? f.name ?? '').trim();
          if (!name) continue;
          const p = f.path || `${cleanDir.replace(/\/$/, '')}/${name}`;
          const sizeBytes = Number(f.size);
          items.push({
            name,
            path: p,
            type: 'file',
            sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
            mimeType: f.type || undefined,
            url: `${this.effectiveWebBaseUrl}/nas/cgi-bin/luacgi_notimeout?sid=${encodeURIComponent(auth.sid)}&cmd=get_file&path=${encodeURIComponent(p)}`,
            modifiedAt: f.timestamp,
          });
        }
        for (const m of mixed) {
          const name = (m.filename ?? m.name ?? '').trim();
          if (!name || name === '.' || name === '..') continue;
          const isDir = m.type === 'directory' || m.type === 'dir' || Boolean(m.isDir);
          const p = m.path || `${cleanDir.replace(/\/$/, '')}/${name}`;
          items.push({
            name,
            path: p,
            type: isDir ? 'directory' : 'file',
            sizeBytes: isDir ? undefined : (Number.isFinite(Number(m.size)) ? Number(m.size) : undefined),
            modifiedAt: m.timestamp,
          });
        }
        return items;
      } catch {
        return null;
      }
    };

    try {
      const browseForm = new URLSearchParams({
        xhr: '1',
        lang: 'de',
        sid: auth.sid,
        c: 'files',
        a: 'browse',
        path: cleanDir,
        dir: cleanDir,
        type: 'all',
        index: '1',
        limit: '100',
        sorting: '+filename',
      });
      const browseRes = await requestWithLocalTlsPolicy(`${this.effectiveWebBaseUrl}/nas/api/data.lua`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: browseForm.toString(),
        timeoutMs: 5000,
        allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
        customCaPem: this.customCaPem,
      });
      if (browseRes.ok) {
        const items = parseBrowseBody(browseRes.body);
        if (items !== null) {
          return {
            ok: true,
            sidPreview: auth.sidPreview,
            path: cleanDir,
            items,
            source: 'fritz_nas_api',
          };
        }
      }

      const apiParams = new URLSearchParams({
        sid: auth.sid,
        c: 'files',
        a: 'get',
        dir: cleanDir,
        start: '1',
        count: '100',
      });
      const nasRes = await requestWithLocalTlsPolicy(
        `${this.effectiveWebBaseUrl}/nas/api/data.lua?${apiParams.toString()}`,
        {
          method: 'GET',
          timeoutMs: 5000,
          allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
          customCaPem: this.customCaPem,
        }
      );
      if (nasRes.ok) {
        const items = parseBrowseBody(nasRes.body);
        if (items !== null) {
          return {
            ok: true,
            sidPreview: auth.sidPreview,
            path: cleanDir,
            items,
            source: 'fritz_nas_api',
          };
        }
      }

      const postForm = new URLSearchParams({
        xhr: '1',
        lang: 'de',
        sid: auth.sid,
        c: 'files',
        a: 'get',
        path: cleanDir,
        start: '1',
        count: '100',
      });
      const postRes = await requestWithLocalTlsPolicy(`${this.effectiveWebBaseUrl}/nas/api/data.lua`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: postForm.toString(),
        timeoutMs: 5000,
        allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
        customCaPem: this.customCaPem,
      });
      if (postRes.ok) {
        const items = parseBrowseBody(postRes.body);
        if (items !== null) {
          return {
            ok: true,
            sidPreview: auth.sidPreview,
            path: cleanDir,
            items,
            source: 'fritz_nas_api',
          };
        }
      }
    } catch {
      // Fallback auf TR-064 Storage-Info versuchen
    }

    const tr064 = await this.fetchTr064DeviceInfo();
    return {
      ok: true,
      sidPreview: auth.sidPreview,
      path: cleanDir,
      items: [],
      source: tr064.available ? 'tr064_storage' : 'none',
      error: tr064.available
        ? undefined
        : 'FRITZ!NAS Verzeichnis-API nicht aktiv (TR-064/SID bereit).',
    };
  }

  public async createFritzNasDirectory(
    remoteParentPath = '/',
    folderName: string
  ): Promise<{ ok: boolean; createdPath: string; error?: string }> {
    const folderSegments = folderName
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '.' && s !== '..');
    const cleanParent = (remoteParentPath.trim() || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    const targetPath =
      folderSegments.length === 0
        ? cleanParent
        : cleanParent === '/'
          ? `/${folderSegments.join('/')}`
          : `${cleanParent}/${folderSegments.join('/')}`;
    if (folderSegments.length === 0) {
      return { ok: false, createdPath: targetPath, error: 'Ordnername fehlt.' };
    }

    const auth = await this.getValidSession(false);
    if (!auth.ok || !auth.sid || auth.sid === EMPTY_SID) {
      return {
        ok: false,
        createdPath: targetPath,
        error: auth.error || 'Keine gültige FRITZ!Box SID vorhanden.',
      };
    }

    let parentCursor = cleanParent;
    for (const seg of folderSegments) {
      const attempts: Array<{ url: string; method: 'POST' | 'GET'; body?: string }> = [
        {
          url: `${this.effectiveWebBaseUrl}/nas/api/data.lua`,
          method: 'POST',
          body: new URLSearchParams({
            xhr: '1',
            lang: 'de',
            sid: auth.sid,
            c: 'files',
            a: 'create_dir',
            path: parentCursor,
            dir: parentCursor,
            name: seg,
          }).toString(),
        },
        {
          url: `${this.effectiveWebBaseUrl}/nas/api/data.lua`,
          method: 'POST',
          body: new URLSearchParams({
            xhr: '1',
            lang: 'de',
            sid: auth.sid,
            c: 'files',
            a: 'mkdir',
            path: parentCursor,
            dir: parentCursor,
            name: seg,
          }).toString(),
        },
        {
          url: `${this.effectiveWebBaseUrl}/nas/api/data.lua?${new URLSearchParams({
            sid: auth.sid,
            c: 'files',
            a: 'mkdir',
            dir: parentCursor,
            name: seg,
          }).toString()}`,
          method: 'GET',
        },
      ];

      let segOk = false;
      for (const attempt of attempts) {
        try {
          const res = await requestWithLocalTlsPolicy(attempt.url, {
            method: attempt.method,
            headers:
              attempt.method === 'POST'
                ? {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: this.effectiveWebBaseUrl,
                    Referer: `${this.effectiveWebBaseUrl}/nas/`,
                  }
                : {
                    Origin: this.effectiveWebBaseUrl,
                    Referer: `${this.effectiveWebBaseUrl}/nas/`,
                  },
            body: attempt.body,
            timeoutMs: 4500,
            allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
            customCaPem: this.customCaPem,
          });
          if (res.ok && res.body.trim().startsWith('{')) {
            const parsed = JSON.parse(res.body.trim()) as { error?: unknown; status?: string };
            const hasErr =
              (parsed.error && parsed.error !== 0 && parsed.error !== '0') ||
              parsed.status === 'error' ||
              parsed.status === 'denied';
            if (!hasErr) {
              segOk = true;
              break;
            }
          }
        } catch {
          // Nächsten Endpunkt testen
        }
      }
      if (!segOk) {
        const existingCheck = await this.browseFritzNasFiles(parentCursor).catch(() => null);
        const alreadyExists = Boolean(
          existingCheck?.ok &&
            existingCheck.source === 'fritz_nas_api' &&
            existingCheck.items.some((item) => item.name.toLowerCase() === seg.toLowerCase())
        );
        if (!alreadyExists) {
          return {
            ok: false,
            createdPath: targetPath,
            error: `FRITZ!NAS lehnte Ordneranlage „${seg}“ über Web-API ab.`,
          };
        }
      }
      parentCursor = parentCursor === '/' ? `/${seg}` : `${parentCursor}/${seg}`;
    }

    return { ok: true, createdPath: targetPath };
  }

  public async uploadFritzNasTextFile(
    remoteDirPath: string,
    fileName: string,
    content: string | Buffer
  ): Promise<{ ok: boolean; filePath: string; error?: string }> {
    const cleanDir = (remoteDirPath.trim() || '/').replace(/\/+$/, '') || '/';
    const cleanFile = fileName.trim().replace(/[\\/]+/g, '');
    const filePath = cleanDir === '/' ? `/${cleanFile}` : `${cleanDir}/${cleanFile}`;
    const auth = await this.getValidSession(false);
    if (!auth.ok || !auth.sid || auth.sid === EMPTY_SID) {
      return { ok: false, filePath, error: auth.error || 'Keine gültige FRITZ!Box SID vorhanden.' };
    }

    const fileBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const contentType = cleanFile.toLowerCase().endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'application/octet-stream';

    const attempts: Array<{ url: string; fields: Record<string, string> }> = [
      {
        url: `${this.effectiveWebBaseUrl}/nas/api/data.lua`,
        fields: {
          xhr: '1',
          lang: 'de',
          sid: auth.sid,
          c: 'files',
          a: 'upload',
          dir: cleanDir,
          path: cleanDir,
        },
      },
      {
        url: `${this.effectiveWebBaseUrl}/nas/cgi-bin/luacgi_notimeout`,
        fields: {
          sid: auth.sid,
          dir: cleanDir,
          path: cleanDir,
        },
      },
      {
        url: `${this.effectiveWebBaseUrl}/cgi-bin/luacgi_notimeout`,
        fields: {
          sid: auth.sid,
          dir: cleanDir,
          path: cleanDir,
        },
      },
    ];

    let lastError = 'Upload fehlgeschlagen';
    for (const attempt of attempts) {
      const boundary = `----EntenCenterBoundary${crypto.randomBytes(8).toString('hex')}`;
      const headerParts: string[] = [];
      for (const [k, v] of Object.entries(attempt.fields)) {
        headerParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      }
      headerParts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="UploadFile"; filename="${cleanFile}"\r\nContent-Type: ${contentType}\r\n\r\n`
      );
      const multipartBuf = Buffer.concat([
        Buffer.from(headerParts.join(''), 'utf8'),
        fileBuf,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]);

      try {
        const res = await requestWithLocalTlsPolicy(attempt.url, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            Origin: this.effectiveWebBaseUrl,
            Referer: `${this.effectiveWebBaseUrl}/nas/`,
          },
          body: multipartBuf,
          timeoutMs: 8000,
          allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
          customCaPem: this.customCaPem,
        });
        const trimmed = (res.body || '').trim();
        if (res.ok) {
          if (trimmed.startsWith('{')) {
            const parsed = JSON.parse(trimmed) as { error?: unknown; status?: string };
            const hasErr =
              (parsed.error && parsed.error !== 0 && parsed.error !== '0' && parsed.error !== false) ||
              parsed.status === 'error' ||
              parsed.status === 'denied';
            if (!hasErr) {
              return { ok: true, filePath };
            }
            lastError = `FRITZ!NAS lehnte Upload „${cleanFile}“ ab (${String(parsed.error || parsed.status)}).`;
          } else if (!/login|denied/i.test(trimmed)) {
            return { ok: true, filePath };
          } else {
            lastError = 'FRITZ!NAS Schreibrechte fehlen oder Session abgelaufen.';
          }
        } else {
          lastError = `HTTP ${res.status}`;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Upload fehlgeschlagen';
      }
    }

    return { ok: false, filePath, error: lastError };
  }

  public async logout(): Promise<boolean> {
    const cached = sidMemoryCache.get(this.cacheKey);
    const sid = cached?.sid;
    sidMemoryCache.delete(this.cacheKey);
    if (!sid || sid === EMPTY_SID) return true;

    try {
      const formParams = new URLSearchParams({
        logout: '1',
        sid,
      });
      await requestWithLocalTlsPolicy(`${this.effectiveWebBaseUrl}/login_sid.lua`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formParams.toString(),
        timeoutMs: 3000,
        allowLocalSelfSignedTls: this.isLocalSelfSignedAllowedForTarget(),
        customCaPem: this.customCaPem,
      });
    } catch {
      // Cache bereits lokal gelöscht
    }
    return true;
  }

  public async getStatusSnapshot(): Promise<FritzSidSessionStatus> {
    const cached = sidMemoryCache.get(this.cacheKey);
    const tr064 = await this.fetchTr064DeviceInfo();
    if (!cached) {
      return {
        connected: false,
        host: this.host,
        port: this.port,
        useTls: this.useTls,
        username: this.username,
        hasSecret: Boolean(this.password),
        sidPreview: null,
        challengeVersion: null,
        rights: [],
        obtainedAt: null,
        lastVerifiedAt: null,
        blockTimeSec: 0,
        tr064Available: tr064.available,
        friendlyName: tr064.friendlyName,
        modelName: tr064.modelName,
        allowLocalSelfSignedTls: this.allowLocalSelfSignedTls,
        tlsBypassedForLocalSelfSigned: tr064.tlsBypassedForLocalSelfSigned,
        message: tr064.available
          ? `FRITZ!Box (${tr064.friendlyName || this.host}) per TR-064 erreichbar · noch keine aktive SID-Sitzung.`
          : 'Noch keine aktive FRITZ!Box SID-Sitzung.',
      };
    }

    return {
      connected: true,
      host: cached.host,
      port: cached.port,
      useTls: cached.useTls,
      username: cached.username,
      hasSecret: Boolean(this.password),
      sidPreview: maskSidPreview(cached.sid),
      challengeVersion: cached.challengeVersion,
      rights: cached.rights,
      obtainedAt: cached.obtainedAt,
      lastVerifiedAt: cached.lastVerifiedAt,
      blockTimeSec: 0,
      tr064Available: tr064.available || Boolean(cached.friendlyName),
      friendlyName: tr064.friendlyName ?? cached.friendlyName ?? null,
      modelName: tr064.modelName ?? cached.modelName ?? null,
      allowLocalSelfSignedTls: this.allowLocalSelfSignedTls,
      tlsBypassedForLocalSelfSigned: cached.tlsBypassedForLocalSelfSigned,
      message: `Aktive FRITZ!Box SID (${maskSidPreview(cached.sid)}) wird für TR-064 & FRITZ!NAS wiederverwendet.`,
    };
  }
}
