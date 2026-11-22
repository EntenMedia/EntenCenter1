import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { FritzBoxSessionClient } from './fritzBoxSessionClient.ts';
import { requestWithLocalTlsPolicy } from './localTlsFetch.ts';
import type {
  FritzTrackStatus,
  NasConnectionScope,
  NasProtocolId,
  NasProtocolVerificationResult,
  NasVendorId,
  UniversalNasProbeResponse,
} from '../types/marcente.ts';

export interface UniversalProbeOptions {
  host: string;
  port?: number | string;
  protocol?: NasProtocolId;
  shareOrPath?: string;
  username?: string;
  password?: string;
  domainOrWorkgroup?: string;
  useTls?: boolean;
  ftpsTlsMode?: 'explicit' | 'implicit';
  scope?: NasConnectionScope;
  allowLocalSelfSignedTls?: boolean;
  customCaPem?: string | null;
  timeoutMs?: number;
}

const VENDOR_LABELS: Record<NasVendorId, string> = {
  avm_fritzbox: 'AVM FRITZ!Box / FRITZ!NAS',
  synology: 'Synology DSM',
  qnap: 'QNAP QTS / QuTS hero',
  western_digital: 'Western Digital My Cloud',
  truenas: 'TrueNAS / FreeNAS',
  unraid: 'Unraid',
  openmediavault: 'OpenMediaVault',
  standard_nas: 'Standard-NAS (SMB / WebDAV / SFTP)',
  entencenter: 'EntenCenter NAS-Backend',
};

export function getVendorLabel(vendor: NasVendorId): string {
  return VENDOR_LABELS[vendor] ?? VENDOR_LABELS.standard_nas;
}

export function cleanHostInput(rawHost: string): {
  hostname: string;
  port: number | null;
  explicitScheme: 'http' | 'https' | null;
  path: string;
} {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return { hostname: '', port: null, explicitScheme: null, path: '' };
  }
  let explicitScheme: 'http' | 'https' | null = null;
  if (/^https:\/\//i.test(trimmed)) explicitScheme = 'https';
  else if (/^http:\/\//i.test(trimmed)) explicitScheme = 'http';

  const forUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(forUrl);
    const p = parsed.port ? Number(parsed.port) : null;
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, '').trim(),
      port: p && Number.isInteger(p) && p > 0 && p <= 65535 ? p : null,
      explicitScheme,
      path: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '',
    };
  } catch {
    const noScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
    const colonIdx = noScheme.lastIndexOf(':');
    if (colonIdx > 0 && /^\d{1,5}$/.test(noScheme.slice(colonIdx + 1))) {
      const p = Number(noScheme.slice(colonIdx + 1));
      return {
        hostname: noScheme.slice(0, colonIdx),
        port: p > 0 && p <= 65535 ? p : null,
        explicitScheme,
        path: '',
      };
    }
    return { hostname: noScheme, port: null, explicitScheme, path: '' };
  }
}

export function isStrictPrivateOrLanIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean) return false;
  if (clean === '127.0.0.1' || clean === '::1') return true;
  if (/^127\./.test(clean)) return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('169.254.')) {
    return true;
  }
  if (clean.startsWith('172.')) {
    const parts = clean.split('.');
    const second = Number(parts[1]);
    if (parts.length === 4 && Number.isInteger(second) && second >= 16 && second <= 31) {
      return true;
    }
  }
  // CGNAT 100.64.0.0/10 is commonly used by Tailscale/WireGuard VPNs, but not strictly LAN unless scope=vpn
  return clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:');
}

export function isLocalLanTargetStrict(hostname: string, resolvedIp: string | null): boolean {
  const lower = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.box') ||
    lower.endsWith('.fritz.nas') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.home')
  ) {
    return true;
  }
  if (net.isIP(lower) !== 0) {
    return isStrictPrivateOrLanIp(lower);
  }
  if (resolvedIp && net.isIP(resolvedIp) !== 0) {
    return isStrictPrivateOrLanIp(resolvedIp);
  }
  return false;
}

export async function resolveHostIp(hostname: string): Promise<{
  ok: boolean;
  ip: string | null;
  error?: string;
}> {
  const clean = hostname.trim().replace(/^\[|\]$/g, '');
  if (!clean) return { ok: false, ip: null, error: 'Hostname fehlt.' };
  if (net.isIP(clean) !== 0) {
    return { ok: true, ip: clean };
  }
  try {
    const v4 = await dns.lookup(clean, { family: 4 }).catch(() => null);
    if (v4?.address) return { ok: true, ip: v4.address };
    const anyAddr = await dns.lookup(clean);
    return { ok: true, ip: anyAddr.address };
  } catch (err) {
    return {
      ok: false,
      ip: null,
      error: err instanceof Error ? err.message : 'DNS-Auflösung fehlgeschlagen.',
    };
  }
}

export function extractShareName(shareOrPath?: string): string {
  const cleaned = (shareOrPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned) return '';
  const firstSegment = cleaned.split('/')[0]?.trim() || '';
  return firstSegment;
}

const NON_SMB_PORTS = new Set([
  20, 21, 22, 23, 25, 80, 110, 143, 443, 465, 587, 990, 993, 995,
  3000, 3001, 3002, 3005, 3010, 5000, 5001, 5005, 5006, 8000, 8080,
  8081, 8443, 8888, 9000, 9090, 49000, 49443,
]);

export function sanitizeSmbPort(rawPort?: number | string | null): number {
  const parsed =
    typeof rawPort === 'number'
      ? Math.trunc(rawPort)
      : typeof rawPort === 'string' && rawPort.trim()
        ? Number.parseInt(rawPort.trim(), 10)
        : 445;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535 || NON_SMB_PORTS.has(parsed)) {
    return 445;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Pure TypeScript MD4 + NTLMv2 helper (required for real SMB2 NTLMSSP auth)
// ---------------------------------------------------------------------------
function md4Bytes(input: Buffer): Buffer {
  const origBitLen = BigInt(input.length) * 8n;
  const padLen = (56 - ((input.length + 1) % 64) + 64) % 64;
  const buf = Buffer.alloc(input.length + 1 + padLen + 8);
  input.copy(buf, 0);
  buf[input.length] = 0x80;
  buf.writeUInt32LE(Number(origBitLen & 0xffffffffn), buf.length - 8);
  buf.writeUInt32LE(Number((origBitLen >> 32n) & 0xffffffffn), buf.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const rotl = (x: number, s: number) => ((x << s) | (x >>> (32 - s))) >>> 0;
  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;

  for (let i = 0; i < buf.length; i += 64) {
    const X = new Uint32Array(16);
    for (let j = 0; j < 16; j += 1) {
      X[j] = buf.readUInt32LE(i + j * 4);
    }
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    const r1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const s1 = [3, 7, 11, 19];
    for (let k = 0; k < 16; k += 1) {
      const idx = r1[k];
      const sh = s1[k % 4];
      const mod = k % 4;
      if (mod === 0) a = rotl((a + F(b, c, d) + X[idx]) >>> 0, sh);
      else if (mod === 1) d = rotl((d + F(a, b, c) + X[idx]) >>> 0, sh);
      else if (mod === 2) c = rotl((c + F(d, a, b) + X[idx]) >>> 0, sh);
      else b = rotl((b + F(c, d, a) + X[idx]) >>> 0, sh);
    }

    const r2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const s2 = [3, 5, 9, 13];
    for (let k = 0; k < 16; k += 1) {
      const idx = r2[k];
      const sh = s2[k % 4];
      const mod = k % 4;
      if (mod === 0) a = rotl((a + G(b, c, d) + X[idx] + 0x5a827999) >>> 0, sh);
      else if (mod === 1) d = rotl((d + G(a, b, c) + X[idx] + 0x5a827999) >>> 0, sh);
      else if (mod === 2) c = rotl((c + G(d, a, b) + X[idx] + 0x5a827999) >>> 0, sh);
      else b = rotl((b + G(c, d, a) + X[idx] + 0x5a827999) >>> 0, sh);
    }

    const r3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    const s3 = [3, 9, 11, 15];
    for (let k = 0; k < 16; k += 1) {
      const idx = r3[k];
      const sh = s3[k % 4];
      const mod = k % 4;
      if (mod === 0) a = rotl((a + H(b, c, d) + X[idx] + 0x6ed9eba1) >>> 0, sh);
      else if (mod === 1) d = rotl((d + H(a, b, c) + X[idx] + 0x6ed9eba1) >>> 0, sh);
      else if (mod === 2) c = rotl((c + H(d, a, b) + X[idx] + 0x6ed9eba1) >>> 0, sh);
      else b = rotl((b + H(c, d, a) + X[idx] + 0x6ed9eba1) >>> 0, sh);
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('md5', key).update(data).digest();
}

function buildNtlmType1Message(domain = ''): Buffer {
  const flags =
    0x00000001 | // Negotiate Unicode
    0x00000004 | // Request Target
    0x00000200 | // Negotiate NTLM
    0x00008000 | // Negotiate Always Sign
    0x00080000 | // Negotiate Extended Session Security
    0x02000000; // Negotiate Version

  const domainBuf = Buffer.from(domain, 'ascii');
  const buf = Buffer.alloc(40 + domainBuf.length);
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(1, 8); // Type 1
  buf.writeUInt32LE(flags >>> 0, 12);
  // Domain security buffer
  buf.writeUInt16LE(domainBuf.length, 16);
  buf.writeUInt16LE(domainBuf.length, 18);
  buf.writeUInt32LE(domainBuf.length > 0 ? 40 : 0, 20);
  // Workstation empty
  buf.writeUInt16LE(0, 24);
  buf.writeUInt16LE(0, 26);
  buf.writeUInt32LE(0, 28);
  // Version 6.1 build 7601
  buf.writeUInt8(6, 32);
  buf.writeUInt8(1, 33);
  buf.writeUInt16LE(7601, 34);
  buf.writeUInt32LE(0x0f000000, 36);
  if (domainBuf.length > 0) domainBuf.copy(buf, 40);
  return buf;
}

function parseNtlmType2Challenge(secBuf: Buffer): {
  serverChallenge: Buffer;
  flags: number;
  targetName: string;
  targetInfo: Buffer;
} | null {
  const sigIdx = secBuf.indexOf(Buffer.from('NTLMSSP\0', 'ascii'));
  if (sigIdx < 0) return null;
  const msg = secBuf.subarray(sigIdx);
  if (msg.length < 32) return null;
  if (msg.readUInt32LE(8) !== 2) return null;

  const targetLen = msg.readUInt16LE(12);
  const targetOffset = msg.readUInt32LE(16);
  const flags = msg.readUInt32LE(20);
  const serverChallenge = Buffer.from(msg.subarray(24, 32));

  let targetName = '';
  if (targetLen > 0 && targetOffset + targetLen <= msg.length) {
    targetName = msg
      .subarray(targetOffset, targetOffset + targetLen)
      .toString((flags & 1) !== 0 ? 'utf16le' : 'ascii');
  }

  let targetInfo: Buffer = Buffer.alloc(0);
  if (msg.length >= 48) {
    const infoLen = msg.readUInt16LE(40);
    const infoOffset = msg.readUInt32LE(44);
    if (infoLen > 0 && infoOffset + infoLen <= msg.length) {
      targetInfo = Buffer.from(msg.subarray(infoOffset, infoOffset + infoLen));
    }
  }
  return { serverChallenge, flags, targetName, targetInfo };
}

function extractNbDomainFromTargetInfo(targetInfo: Buffer): string {
  let pos = 0;
  while (pos + 4 <= targetInfo.length) {
    const avId = targetInfo.readUInt16LE(pos);
    const avLen = targetInfo.readUInt16LE(pos + 2);
    pos += 4;
    if (avId === 0) break;
    if (pos + avLen > targetInfo.length) break;
    if (avId === 2 && avLen > 0) {
      return targetInfo.subarray(pos, pos + avLen).toString('utf16le');
    }
    pos += avLen;
  }
  return '';
}

function buildNtlmType3Message(params: {
  username: string;
  password: string;
  domain: string;
  workstation: string;
  forceEmptyDomain?: boolean;
  type2: { serverChallenge: Buffer; flags: number; targetName: string; targetInfo: Buffer };
}): Buffer {
  const userBuf = Buffer.from(params.username, 'utf16le');
  const nbDomain = extractNbDomainFromTargetInfo(params.type2.targetInfo);
  const domainStr = params.forceEmptyDomain
    ? ''
    : params.domain || nbDomain || params.type2.targetName || '';
  const domainBuf = Buffer.from(domainStr, 'utf16le');
  const wsBuf = Buffer.from(params.workstation || 'ENTENCENTER', 'utf16le');

  const ntHash = md4Bytes(Buffer.from(params.password, 'utf16le'));
  const userDomUpper = Buffer.from(
    params.username.toUpperCase() + domainStr.toUpperCase(),
    'utf16le'
  );
  const ntlmv2Key = hmacMd5(ntHash, userDomUpper);

  // Windows FILETIME (100-ns intervals since 1601-01-01)
  const fileTime = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const clientChallenge = crypto.randomBytes(8);

  const blobHeader = Buffer.alloc(28);
  blobHeader.writeUInt32LE(0x00000101, 0); // RespType=1, HiRespType=1
  blobHeader.writeUInt32LE(0, 4);
  blobHeader.writeBigUInt64LE(fileTime, 8);
  clientChallenge.copy(blobHeader, 16);
  blobHeader.writeUInt32LE(0, 24);

  const targetInfo =
    params.type2.targetInfo.length > 0 ? params.type2.targetInfo : Buffer.from([0, 0, 0, 0]);
  const blob = Buffer.concat([blobHeader, targetInfo, Buffer.alloc(4)]);

  const ntProofStr = hmacMd5(ntlmv2Key, Buffer.concat([params.type2.serverChallenge, blob]));
  const ntResponse = Buffer.concat([ntProofStr, blob]);
  const lmResponse = Buffer.concat([
    hmacMd5(ntlmv2Key, Buffer.concat([params.type2.serverChallenge, clientChallenge])),
    clientChallenge,
  ]);

  const payloadParts = [domainBuf, userBuf, wsBuf, lmResponse, ntResponse];
  const headerLen = 72;
  const offsets: number[] = [];
  let cursor = headerLen;
  for (const part of payloadParts) {
    offsets.push(cursor);
    cursor += part.length;
  }

  const out = Buffer.alloc(cursor);
  out.write('NTLMSSP\0', 0, 'ascii');
  out.writeUInt32LE(3, 8); // Type 3

  // LmChallengeResponse
  out.writeUInt16LE(lmResponse.length, 12);
  out.writeUInt16LE(lmResponse.length, 14);
  out.writeUInt32LE(offsets[3], 16);

  // NtChallengeResponse
  out.writeUInt16LE(ntResponse.length, 20);
  out.writeUInt16LE(ntResponse.length, 22);
  out.writeUInt32LE(offsets[4], 24);

  // DomainName
  out.writeUInt16LE(domainBuf.length, 28);
  out.writeUInt16LE(domainBuf.length, 30);
  out.writeUInt32LE(domainBuf.length > 0 ? offsets[0] : 0, 32);

  // UserName
  out.writeUInt16LE(userBuf.length, 36);
  out.writeUInt16LE(userBuf.length, 38);
  out.writeUInt32LE(userBuf.length > 0 ? offsets[1] : 0, 40);

  // Workstation
  out.writeUInt16LE(wsBuf.length, 44);
  out.writeUInt16LE(wsBuf.length, 46);
  out.writeUInt32LE(offsets[2], 48);

  // EncryptedRandomSessionKey (empty)
  out.writeUInt16LE(0, 52);
  out.writeUInt16LE(0, 54);
  out.writeUInt32LE(0, 56);

  // NegotiateFlags (Unicode | NTLM | AlwaysSign | ExtendedSessionSecurity | NegotiateVersion)
  const type3Flags = 0x00000001 | 0x00000200 | 0x00008000 | 0x00080000 | 0x02000000;
  out.writeUInt32LE(type3Flags >>> 0, 60);

  // Version
  out.writeUInt8(6, 64);
  out.writeUInt8(1, 65);
  out.writeUInt16LE(7601, 66);
  out.writeUInt32LE(0x0f000000, 68);

  domainBuf.copy(out, offsets[0]);
  userBuf.copy(out, offsets[1]);
  wsBuf.copy(out, offsets[2]);
  lmResponse.copy(out, offsets[3]);
  ntResponse.copy(out, offsets[4]);
  return out;
}

// Wrap NTLMSSP raw token inside minimal SPNEGO GSS-API NegTokenInit/NegTokenResp
function wrapSpnegoNegTokenInit(ntlmType1: Buffer): Buffer {
  const derLen = (len: number): Buffer => {
    if (len < 128) return Buffer.from([len]);
    if (len < 256) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  };
  const wrapTag = (tag: number, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);

  const spnegoOid = Buffer.from([0x06, 0x06, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x02]);
  const ntlmOid = Buffer.from([
    0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a,
  ]);
  const mechTypes = wrapTag(0xa0, wrapTag(0x30, ntlmOid));
  const mechToken = wrapTag(0xa2, wrapTag(0x04, ntlmType1));
  const negTokenInit = wrapTag(0xa0, wrapTag(0x30, Buffer.concat([mechTypes, mechToken])));
  return wrapTag(0x60, Buffer.concat([spnegoOid, negTokenInit]));
}

function wrapSpnegoNegTokenResp(ntlmType3: Buffer): Buffer {
  const derLen = (len: number): Buffer => {
    if (len < 128) return Buffer.from([len]);
    if (len < 256) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  };
  const wrapTag = (tag: number, content: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);

  const responseToken = wrapTag(0xa2, wrapTag(0x04, ntlmType3));
  return wrapTag(0xa1, wrapTag(0x30, responseToken));
}

// ---------------------------------------------------------------------------
// Real SMB 2/3 Socket Client (Negotiate + NTLMv2 Session Setup + Tree Connect)
// NEVER uses SMB 1! Explicitly rejects SMB 1-only servers.
// ---------------------------------------------------------------------------
function wrapNetBiosFrame(smbPayload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0x00;
  header[1] = (smbPayload.length >> 16) & 0xff;
  header[2] = (smbPayload.length >> 8) & 0xff;
  header[3] = smbPayload.length & 0xff;
  return Buffer.concat([header, smbPayload]);
}

function buildSmb2Header(params: {
  command: number;
  messageId: bigint;
  sessionId?: bigint;
  treeId?: number;
  creditsRequested?: number;
  creditCharge?: number;
}): Buffer {
  const hdr = Buffer.alloc(64);
  hdr.write('\xfeSMB', 0, 'latin1'); // SMB2 magic 0xFE 'S' 'M' 'B'
  hdr.writeUInt16LE(64, 4); // StructureSize
  hdr.writeUInt16LE(params.creditCharge ?? 1, 6); // CreditCharge
  hdr.writeUInt32LE(0, 8); // Status
  hdr.writeUInt16LE(params.command, 12);
  hdr.writeUInt16LE(params.creditsRequested ?? 1, 14); // CreditRequest
  hdr.writeUInt32LE(0, 16); // Flags
  hdr.writeUInt32LE(0, 20); // NextCommand
  hdr.writeBigUInt64LE(params.messageId, 24);
  hdr.writeUInt32LE(0, 32); // Reserved / ProcessId
  hdr.writeUInt32LE(params.treeId ?? 0, 36);
  hdr.writeBigUInt64LE(params.sessionId ?? 0n, 40);
  // Signature (16 bytes zero)
  return hdr;
}

function buildSmb2NegotiatePacket(messageId: bigint): Buffer {
  // SMB 2.0.2 - 3.0.2 ohne 0x0311-Preauth-Contexts (0x0311 ohne Contexts erzeugt 0xC000000D)
  const dialects = [0x0202, 0x0210, 0x0300, 0x0302];
  const body = Buffer.alloc(36 + dialects.length * 2);
  body.writeUInt16LE(36, 0); // StructureSize
  body.writeUInt16LE(dialects.length, 2);
  body.writeUInt16LE(0x0001, 4); // SecurityMode: Signing enabled
  body.writeUInt16LE(0, 6); // Reserved
  body.writeUInt32LE(0, 8); // Capabilities = 0 per MS-SMB2 2.2.3
  crypto.randomBytes(16).copy(body, 12); // ClientGuid
  body.writeUInt32LE(0, 28); // NegotiateContextOffset
  body.writeUInt16LE(0, 32); // NegotiateContextCount
  body.writeUInt16LE(0, 34); // Reserved2
  dialects.forEach((d, idx) => body.writeUInt16LE(d, 36 + idx * 2));

  return wrapNetBiosFrame(
    Buffer.concat([
      buildSmb2Header({ command: 0x0000, messageId, creditsRequested: 1, creditCharge: 0 }),
      body,
    ])
  );
}

function buildSmb2SessionSetupPacket(
  messageId: bigint,
  sessionId: bigint,
  securityBuffer: Buffer,
  creditCharge = 1
): Buffer {
  const bodyFixed = Buffer.alloc(24);
  bodyFixed.writeUInt16LE(25, 0); // StructureSize
  bodyFixed.writeUInt8(0, 2); // Flags
  bodyFixed.writeUInt8(0x01, 3); // SecurityMode: Signing enabled
  bodyFixed.writeUInt32LE(0, 4); // Capabilities
  bodyFixed.writeUInt32LE(0, 8); // Channel
  bodyFixed.writeUInt16LE(64 + 24, 12); // SecurityBufferOffset
  bodyFixed.writeUInt16LE(securityBuffer.length, 14);
  bodyFixed.writeBigUInt64LE(0n, 16); // PreviousSessionId

  return wrapNetBiosFrame(
    Buffer.concat([
      buildSmb2Header({ command: 0x0001, messageId, sessionId, creditsRequested: 31, creditCharge }),
      bodyFixed,
      securityBuffer,
    ])
  );
}

function buildSmb2TreeConnectPacket(
  messageId: bigint,
  sessionId: bigint,
  uncPath: string,
  creditCharge = 1
): Buffer {
  const pathBuf = Buffer.from(uncPath, 'utf16le');
  const bodyFixed = Buffer.alloc(8);
  bodyFixed.writeUInt16LE(9, 0); // StructureSize
  bodyFixed.writeUInt16LE(0, 2); // Flags/Reserved
  bodyFixed.writeUInt16LE(64 + 8, 4); // PathOffset
  bodyFixed.writeUInt16LE(pathBuf.length, 6);

  return wrapNetBiosFrame(
    Buffer.concat([
      buildSmb2Header({ command: 0x0003, messageId, sessionId, creditsRequested: 1, creditCharge }),
      bodyFixed,
      pathBuf,
    ])
  );
}

function formatSmbDialectName(dialect: number): string {
  switch (dialect) {
    case 0x0202:
      return 'SMB 2.0.2';
    case 0x0210:
      return 'SMB 2.1';
    case 0x0300:
      return 'SMB 3.0';
    case 0x0302:
      return 'SMB 3.0.2';
    case 0x0311:
      return 'SMB 3.1.1';
    case 0x02ff:
      return 'SMB 2.x (Multi-Protocol)';
    default:
      return `SMB 0x${dialect.toString(16)}`;
  }
}

function explainNtStatusGerman(ntStatus: number, shareName: string): string {
  const hex = `0x${(ntStatus >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  switch (ntStatus >>> 0) {
    case 0xc000006d:
    case 0xc000006a:
      return `SMB-Anmeldung abgelehnt (${hex}): Benutzername oder Passwort falsch.`;
    case 0xc0000022:
      return `SMB-Zugriff verweigert (${hex}): Benutzer hat keine Leserechte / NAS-Berechtigung (z. B. fehlendes „Zugang zu NAS-Inhalten“).`;
    case 0xc000000d:
      return `SMB-Parameter vom Server abgelehnt (${hex}) auf Freigabe „${shareName || 'FRITZ.NAS'}“.`;
    case 0xc00000cc:
      return `SMB-Freigabe „${shareName}“ nicht gefunden (${hex}): Freigabenamen prüfen (z. B. FRITZ.NAS, Medien, video).`;
    case 0xc0000072:
    case 0xc000006e:
      return `SMB-Konto deaktiviert oder eingeschränkt (${hex}).`;
    case 0xc000007f:
      return `USB-Speicher / NAS-Volume ist voll (${hex}, STATUS_DISK_FULL).`;
    case 0xc00000a2:
      return `USB-Speicher / FRITZ!NAS-Medium ist schreibgeschützt (${hex}, STATUS_MEDIA_WRITE_PROTECTED).`;
    case 0xc0000234:
      return `SMB-Konto wegen Fehlversuchen vorübergehend gesperrt (${hex}).`;
    default:
      return `SMB-Fehler ${hex} bei der Sitzungs- oder Freigabeprüfung.`;
  }
}

async function readNextNetBiosFrame(
  socket: net.Socket,
  state: { buf: Buffer },
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const extractFrame = (): Buffer | null => {
      if (state.buf.length < 4) return null;
      const frameLen =
        ((state.buf[1] & 0xff) << 16) |
        ((state.buf[2] & 0xff) << 8) |
        (state.buf[3] & 0xff);
      if (frameLen > 4 * 1024 * 1024) {
        throw new Error('Ungültige SMB/NetBIOS-Paketgröße');
      }
      if (state.buf.length < 4 + frameLen) return null;
      const payload = Buffer.from(state.buf.subarray(4, 4 + frameLen));
      state.buf = Buffer.from(state.buf.subarray(4 + frameLen));
      return payload;
    };

    try {
      const immediate = extractFrame();
      if (immediate) {
        resolve(immediate);
        return;
      }
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`SMB-Zeitüberschreitung nach ${timeoutMs} ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      try {
        const frame = extractFrame();
        if (frame) {
          cleanup();
          resolve(frame);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SMB-Verbindung vom NAS vorzeitig getrennt'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export async function probeSmb23Protocol(params: {
  hostname: string;
  resolvedIp: string;
  port: number;
  isLan: boolean;
  scope: NasConnectionScope;
  username?: string;
  password?: string;
  domainOrWorkgroup?: string;
  shareOrPath?: string;
  timeoutMs?: number;
}): Promise<NasProtocolVerificationResult> {
  const started = Date.now();
  const timeoutMs = params.timeoutMs ?? 4000;
  const smbPort = sanitizeSmbPort(params.port);

  // Sicherheitsregel: SMB niemals ungeschützt über das öffentliche Internet erlauben
  if (!params.isLan && params.scope !== 'vpn') {
    return {
      protocol: 'smb',
      port: smbPort,
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
      errorCode: 'SMB_INTERNET_BLOCKED',
      message:
        'SMB über das öffentliche Internet ist aus Sicherheitsgründen blockiert. Verbinde per VPN (WireGuard/IPsec) oder nutze WebDAV HTTPS / SFTP.',
      warning: 'SMB darf extern ausschließlich über VPN genutzt werden.',
    };
  }

  const socket = new net.Socket();
  const frameState = { buf: Buffer.alloc(0) };

  const connectResult = await new Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>(
    (resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; errorCode?: string; errorMessage?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done({ ok: true }));
      socket.once('timeout', () => done({ ok: false, errorCode: 'ETIMEDOUT', errorMessage: 'Timeout' }));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        done({ ok: false, errorCode: err.code || 'ECONNFAILED', errorMessage: err.message })
      );
      try {
        socket.connect(smbPort, params.resolvedIp);
      } catch (err) {
        done({
          ok: false,
          errorCode: 'ECONNFAILED',
          errorMessage: err instanceof Error ? err.message : 'Verbindung fehlgeschlagen',
        });
      }
    }
  );

  if (!connectResult.ok) {
    socket.destroy();
    return {
      protocol: 'smb',
      port: smbPort,
      priority: 1,
      label: 'SMB 2/3',
      role: 'file_access',
      useTls: false,
      tcpOpen: false,
      protocolVerified: false,
      authVerified: false,
      authAttempted: false,
      latencyMs: null,
      errorCode: connectResult.errorCode || 'ECONNREFUSED',
      message: `SMB-Port ${smbPort} auf ${params.hostname} (${params.resolvedIp}) nicht erreichbar (${connectResult.errorCode || 'Fehler'}).`,
    };
  }

  try {
    // 1. SMB2/3 NEGOTIATE senden
    socket.write(buildSmb2NegotiatePacket(0n));
    const negResp = await readNextNetBiosFrame(socket, frameState, timeoutMs);

    // Explizite Erkennung und Ablehnung von SMB 1 (0xFF 'S' 'M' 'B')
    if (
      negResp.length >= 4 &&
      negResp[0] === 0xff &&
      negResp[1] === 0x53 &&
      negResp[2] === 0x4d &&
      negResp[3] === 0x42
    ) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        smbDialect: 'SMB 1.0 (Abgelehnt)',
        smb1Rejected: true,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'SMB1_REJECTED',
        message:
          'NAS antwortet ausschließlich mit veraltetem SMB 1 — aus Sicherheitsgründen blockiert. Bitte SMB 2/3 in den NAS-/FRITZ!Box-Einstellungen aktivieren.',
      };
    }

    if (
      negResp.length < 68 ||
      negResp[0] !== 0xfe ||
      negResp[1] !== 0x53 ||
      negResp[2] !== 0x4d ||
      negResp[3] !== 0x42
    ) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'NOT_SMB2_SERVER',
        message: `Port ${smbPort} ist zwar offen, antwortet jedoch nicht als gültiger SMB 2/3-Server.`,
      };
    }

    const negStatus = negResp.readUInt32LE(8);
    if (negStatus !== 0) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: `SMB_NEG_STATUS_${negStatus.toString(16)}`,
        message: `SMB 2/3 Aushandlung abgelehnt (${explainNtStatusGerman(negStatus, '')}).`,
      };
    }

    const dialectRev = negResp.readUInt16LE(68);
    const creditCharge = dialectRev === 0x0202 ? 0 : 1;
    const dialectLabel = formatSmbDialectName(dialectRev);
    const shareName = extractShareName(params.shareOrPath);

    let effectiveUsername = (params.username ?? '').trim();
    const hasPassword = (params.password ?? '').length > 0;
    if (!effectiveUsername && hasPassword) {
      const fritzProbe = await FritzBoxSessionClient.probeLoginSid(params.resolvedIp, true, null, 1800).catch(() => null);
      if (fritzProbe?.lastUser) effectiveUsername = fritzProbe.lastUser;
      else if (fritzProbe?.users?.[0]) effectiveUsername = fritzProbe.users[0];
    }
    const hasCreds = Boolean(effectiveUsername && hasPassword);

    // Ohne Zugangsdaten endet die Verifikation nach erfolgreichem SMB2/3 Negotiate
    if (!hasCreds) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: hasPassword,
        smbDialect: dialectLabel,
        smb1Rejected: false,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: hasPassword ? 'SMB_USERNAME_MISSING' : null,
        message: hasPassword
          ? `${dialectLabel} bestätigt — für SMB-Anmeldung bitte FRITZ!Box-Benutzernamen angeben.`
          : `${dialectLabel} auf ${params.hostname}:${smbPort} bestätigt (NTLMSSP-Anmeldung bereit).`,
      };
    }

    // 2. SMB2 SESSION_SETUP Type 1 (SPNEGO wrapped NTLMSSP Negotiate)
    const type1 = buildNtlmType1Message(params.domainOrWorkgroup || '');
    const spnego1 = wrapSpnegoNegTokenInit(type1);
    socket.write(buildSmb2SessionSetupPacket(1n, 0n, spnego1, creditCharge));
    const setupResp1 = await readNextNetBiosFrame(socket, frameState, timeoutMs);

    if (setupResp1.length < 72 || setupResp1.readUInt32LE(0) !== 0x424d53fe) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: true,
        smbDialect: dialectLabel,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'SMB_AUTH_HANDSHAKE_INVALID',
        message: `${dialectLabel} erkannt, aber SMB-Session-Handshake lieferte eine unerwartete Antwort.`,
      };
    }

    const status1 = setupResp1.readUInt32LE(8) >>> 0;
    const sessionId = setupResp1.readBigUInt64LE(40);
    // Expected: 0xC0000016 (STATUS_MORE_PROCESSING_REQUIRED)
    if (status1 !== 0xc0000016) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: status1 === 0,
        authAttempted: true,
        smbDialect: dialectLabel,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: status1 === 0 ? null : `NTSTATUS_${status1.toString(16)}`,
        message:
          status1 === 0
            ? `${dialectLabel} Anmeldung erfolgreich.`
            : explainNtStatusGerman(status1, shareName),
      };
    }

    const secBufOffset = setupResp1.readUInt16LE(68);
    const secBufLen = setupResp1.readUInt16LE(70);
    const serverSecBuf =
      secBufOffset >= 64 && secBufOffset + secBufLen <= setupResp1.length
        ? setupResp1.subarray(secBufOffset, secBufOffset + secBufLen)
        : setupResp1.subarray(64);
    const type2 = parseNtlmType2Challenge(serverSecBuf);
    if (!type2) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: true,
        smbDialect: dialectLabel,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'NTLM_CHALLENGE_MISSING',
        message: `${dialectLabel} unterstützt kein erwartetes NTLMv2 Challenge-Response.`,
      };
    }

    // 3. SMB2 SESSION_SETUP Type 3 (NTLMv2 Auth)
    const type3 = buildNtlmType3Message({
      username: effectiveUsername,
      password: params.password ?? '',
      domain: params.domainOrWorkgroup?.trim() || '',
      workstation: 'ENTENCENTER',
      type2,
    });
    const spnego3 = wrapSpnegoNegTokenResp(type3);
    socket.write(buildSmb2SessionSetupPacket(2n, sessionId, spnego3, creditCharge));
    const setupResp2 = await readNextNetBiosFrame(socket, frameState, timeoutMs);

    if (setupResp2.length < 64) {
      socket.destroy();
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: true,
        smbDialect: dialectLabel,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'SMB_SESSION_EMPTY',
        message: 'Leere Antwort bei SMB-Benutzeranmeldung.',
      };
    }

    const authStatus = setupResp2.readUInt32LE(8) >>> 0;
    if (authStatus !== 0) {
      socket.destroy();
      if (authStatus === 0xc000006d || authStatus === 0xc000006a) {
        const retrySession = await openBestSmb2SessionWithRetries({
          hostname: params.hostname,
          resolvedIp: params.resolvedIp,
          port: smbPort,
          username: effectiveUsername,
          password: params.password ?? '',
          domainOrWorkgroup: params.domainOrWorkgroup,
          timeoutMs,
        }).catch(() => null);
        if (retrySession?.session) {
          const usedName = retrySession.session.effectiveUser || effectiveUsername;
          retrySession.session.socket.destroy();
          return {
            protocol: 'smb',
            port: smbPort,
            priority: 1,
            label: 'SMB 2/3',
            role: 'file_access',
            useTls: false,
            tcpOpen: true,
            protocolVerified: true,
            authVerified: true,
            authAttempted: true,
            shareVerified: true,
            smbDialect: dialectLabel,
            smb1Rejected: false,
            latencyMs: Math.max(1, Date.now() - started),
            message: `${dialectLabel} Anmeldung erfolgreich (${usedName}).`,
          };
        }
      }
      return {
        protocol: 'smb',
        port: smbPort,
        priority: 1,
        label: 'SMB 2/3',
        role: 'file_access',
        useTls: false,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: true,
        smbDialect: dialectLabel,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: `NTSTATUS_${authStatus.toString(16).toUpperCase()}`,
        message: explainNtStatusGerman(authStatus, shareName),
      };
    }

    // 4. Optional TREE_CONNECT gegen gewünschte NAS-Freigabe (falls angegeben & keine IPC$-Dummy)
    let shareVerified = false;
    let shareWarning: string | null = null;
    if (shareName && shareName !== '/' && shareName !== 'EntenCenter-Backend') {
      const unc = `\\\\${params.hostname}\\${shareName}`;
      socket.write(buildSmb2TreeConnectPacket(3n, sessionId, unc, creditCharge));
      const treeResp = await readNextNetBiosFrame(socket, frameState, timeoutMs).catch(() => null);
      if (treeResp && treeResp.length >= 64) {
        const treeStatus = treeResp.readUInt32LE(8) >>> 0;
        if (treeStatus === 0) {
          shareVerified = true;
        } else {
          shareWarning = explainNtStatusGerman(treeStatus, shareName);
        }
      }
    } else {
      // Fallback: FRITZ.NAS (auf FRITZ!Box) oder IPC$ testen
      const uncTry = params.hostname.toLowerCase().includes('fritz')
        ? `\\\\${params.hostname}\\FRITZ.NAS`
        : `\\\\${params.hostname}\\IPC$`;
      socket.write(buildSmb2TreeConnectPacket(3n, sessionId, uncTry, creditCharge));
      const ipcResp = await readNextNetBiosFrame(socket, frameState, timeoutMs).catch(() => null);
      if (ipcResp && ipcResp.length >= 64 && (ipcResp.readUInt32LE(8) >>> 0) === 0) {
        shareVerified = true;
      }
    }

    socket.destroy();
    return {
      protocol: 'smb',
      port: smbPort,
      priority: 1,
      label: 'SMB 2/3',
      role: 'file_access',
      useTls: false,
      tcpOpen: true,
      protocolVerified: true,
      authVerified: true,
      authAttempted: true,
      shareVerified,
      smbDialect: dialectLabel,
      smb1Rejected: false,
      latencyMs: Math.max(1, Date.now() - started),
      warning: shareWarning,
      message: shareWarning
        ? `${dialectLabel}-Anmeldung OK, Hinweis zur Freigabe „${shareName}“: ${shareWarning}`
        : `${dialectLabel} Anmeldung & ${shareName ? `Freigabe „${shareName}“` : 'Dateizugriff'} erfolgreich bestätigt.`,
    };
  } catch (err) {
    socket.destroy();
    return {
      protocol: 'smb',
      port: smbPort,
      priority: 1,
      label: 'SMB 2/3',
      role: 'file_access',
      useTls: false,
      tcpOpen: true,
      protocolVerified: false,
      authVerified: false,
      authAttempted: Boolean(params.username?.trim()),
      latencyMs: Math.max(1, Date.now() - started),
      errorCode: 'SMB_PROBE_ERROR',
      message: err instanceof Error ? err.message : 'SMB 2/3 Protokollprüfung fehlgeschlagen.',
    };
  }
}

// ---------------------------------------------------------------------------
// Real SMB2 File Access Engine (Directory Browse & Backend Provisioning)
// ---------------------------------------------------------------------------
interface OpenSmb2Session {
  socket: net.Socket;
  state: { buf: Buffer };
  sessionId: bigint;
  nextMsgId: bigint;
  timeoutMs: number;
  dialectCode: number;
  creditCharge: number;
  maxTransactSize: number;
  effectiveUser: string;
}

async function openAuthenticatedSmb2Session(params: {
  hostname: string;
  resolvedIp: string;
  port: number;
  username: string;
  password: string;
  domainOrWorkgroup?: string;
  forceEmptyDomain?: boolean;
  timeoutMs?: number;
}): Promise<{ session: OpenSmb2Session | null; status?: number; error?: string }> {
  const timeoutMs = params.timeoutMs ?? 4000;
  const smbPort = sanitizeSmbPort(params.port);
  const socket = new net.Socket();
  const state = { buf: Buffer.alloc(0) };

  const connected = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(smbPort, params.resolvedIp);
    } catch {
      done(false);
    }
  });
  if (!connected) {
    socket.destroy();
    return { session: null, error: 'SMB-Port nicht erreichbar.' };
  }

  try {
    socket.write(buildSmb2NegotiatePacket(0n));
    const negResp = await readNextNetBiosFrame(socket, state, timeoutMs);
    if (negResp.length < 68 || negResp.readUInt32LE(0) !== 0x424d53fe) {
      socket.destroy();
      return { session: null, error: 'Keine gültige SMB 2/3 Negotiate-Antwort.' };
    }
    const negStatus = negResp.readUInt32LE(8) >>> 0;
    if (negStatus !== 0) {
      socket.destroy();
      return { session: null, status: negStatus, error: explainNtStatusGerman(negStatus, '') };
    }
    const dialectCode = negResp.readUInt16LE(68);
    const creditCharge = dialectCode === 0x0202 ? 0 : 1;
    const rawMaxTransact = negResp.length >= 96 ? negResp.readUInt32LE(92) : 32768;
    const maxTransactSize = Math.max(8192, Math.min(65536, rawMaxTransact || 32768));

    const spnego1 = wrapSpnegoNegTokenInit(buildNtlmType1Message(params.domainOrWorkgroup || ''));
    socket.write(buildSmb2SessionSetupPacket(1n, 0n, spnego1, creditCharge));
    const setupResp1 = await readNextNetBiosFrame(socket, state, timeoutMs);
    if (setupResp1.length < 72) {
      socket.destroy();
      return { session: null, error: 'Keine SMB SessionSetup-Antwort.' };
    }
    const status1 = setupResp1.readUInt32LE(8) >>> 0;
    const sessionId = setupResp1.readBigUInt64LE(40);
    if (status1 !== 0xc0000016) {
      if (status1 === 0) {
        return {
          session: {
            socket,
            state,
            sessionId,
            nextMsgId: 2n,
            timeoutMs,
            dialectCode,
            creditCharge,
            maxTransactSize,
            effectiveUser: params.username,
          },
        };
      }
      socket.destroy();
      return { session: null, status: status1, error: explainNtStatusGerman(status1, '') };
    }
    const secOff = setupResp1.readUInt16LE(68);
    const secLen = setupResp1.readUInt16LE(70);
    const serverSec = secOff >= 64 && secOff + secLen <= setupResp1.length
      ? setupResp1.subarray(secOff, secOff + secLen)
      : setupResp1.subarray(64);
    const type2 = parseNtlmType2Challenge(serverSec);
    if (!type2) {
      socket.destroy();
      return { session: null, error: 'NTLM-Challenge fehlt.' };
    }
    const type3 = buildNtlmType3Message({
      username: params.username,
      password: params.password,
      domain: params.domainOrWorkgroup || '',
      workstation: 'ENTENCENTER',
      forceEmptyDomain: params.forceEmptyDomain,
      type2,
    });
    socket.write(buildSmb2SessionSetupPacket(2n, sessionId, wrapSpnegoNegTokenResp(type3), creditCharge));
    const setupResp2 = await readNextNetBiosFrame(socket, state, timeoutMs);
    if (setupResp2.length < 64) {
      socket.destroy();
      return { session: null, error: 'Keine SMB Auth-Antwort.' };
    }
    const status2 = setupResp2.readUInt32LE(8) >>> 0;
    if (status2 !== 0) {
      socket.destroy();
      return { session: null, status: status2, error: explainNtStatusGerman(status2, '') };
    }
    return {
      session: {
        socket,
        state,
        sessionId,
        nextMsgId: 3n,
        timeoutMs,
        dialectCode,
        creditCharge,
        maxTransactSize,
        effectiveUser: params.username,
      },
    };
  } catch (err) {
    socket.destroy();
    return { session: null, error: err instanceof Error ? err.message : 'SMB-Verbindungsfehler' };
  }
}

async function openBestSmb2SessionWithRetries(params: {
  hostname: string;
  resolvedIp: string;
  port: number;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
  timeoutMs?: number;
}): Promise<{ session: OpenSmb2Session | null; error?: string }> {
  const smbPort = sanitizeSmbPort(params.port);
  const candidates: string[] = [];
  const explicitUser = params.username?.trim() || '';
  if (explicitUser) {
    candidates.push(explicitUser);
  }
  const fritz = await FritzBoxSessionClient.probeLoginSid(params.resolvedIp, true, null, 1600).catch(() => null);
  if (!explicitUser || (fritz?.users && fritz.users.length > 0 && !fritz.users.some((u) => u.toLowerCase() === explicitUser.toLowerCase()))) {
    if (fritz?.lastUser && !candidates.some((c) => c.toLowerCase() === fritz.lastUser!.toLowerCase())) {
      candidates.push(fritz.lastUser);
    }
    for (const u of fritz?.users ?? []) {
      if (!candidates.some((c) => c.toLowerCase() === u.toLowerCase())) candidates.push(u);
    }
    if (!candidates.includes('ftpuser')) candidates.push('ftpuser');
  }
  let lastError: string | undefined;
  for (const user of candidates.slice(0, 5)) {
    const s1 = await openAuthenticatedSmb2Session({
      hostname: params.hostname,
      resolvedIp: params.resolvedIp,
      port: smbPort,
      username: user,
      password: params.password,
      domainOrWorkgroup: params.domainOrWorkgroup,
      forceEmptyDomain: false,
      timeoutMs: params.timeoutMs,
    });
    if (s1.session) return { session: s1.session };
    lastError = s1.error;
    const s2 = await openAuthenticatedSmb2Session({
      hostname: params.hostname,
      resolvedIp: params.resolvedIp,
      port: smbPort,
      username: user,
      password: params.password,
      domainOrWorkgroup: '',
      forceEmptyDomain: true,
      timeoutMs: params.timeoutMs,
    });
    if (s2.session) return { session: s2.session };
    lastError = s2.error ?? lastError;
  }
  return { session: null, error: lastError };
}

async function smb2TreeConnect(sess: OpenSmb2Session, unc: string): Promise<number | null> {
  const msgId = sess.nextMsgId++;
  sess.socket.write(buildSmb2TreeConnectPacket(msgId, sess.sessionId, unc, sess.creditCharge));
  const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
  if (resp.length < 64 || (resp.readUInt32LE(8) >>> 0) !== 0) return null;
  return resp.readUInt32LE(36);
}

async function smb2Create(
  sess: OpenSmb2Session,
  treeId: number,
  relWinPath: string,
  desiredAccess: number,
  fileAttributes: number,
  createDisposition: number,
  createOptions: number
): Promise<{ fileId: Buffer | null; status: number }> {
  const msgId = sess.nextMsgId++;
  const nameBuf = Buffer.from(relWinPath, 'utf16le');
  const body = Buffer.alloc(56 + Math.max(2, nameBuf.length));
  body.writeUInt16LE(57, 0); // StructureSize
  body.writeUInt8(0, 2); // SecurityFlags
  body.writeUInt8(0, 3); // RequestedOplockLevel
  body.writeUInt32LE(2, 4); // ImpersonationLevel (Impersonation)
  // SmbCreateFlags (8..15) + Reserved (16..23) = 0
  body.writeUInt32LE(desiredAccess >>> 0, 24);
  body.writeUInt32LE(fileAttributes >>> 0, 28);
  body.writeUInt32LE(0x00000007, 32); // ShareAccess: R|W|D
  body.writeUInt32LE(createDisposition >>> 0, 36);
  body.writeUInt32LE(createOptions >>> 0, 40);
  body.writeUInt16LE(64 + 56, 44); // NameOffset MUST ALWAYS be 120, even when NameLength == 0
  body.writeUInt16LE(nameBuf.length, 46);
  // CreateContextsOffset/Len = 0
  if (nameBuf.length > 0) nameBuf.copy(body, 56);

  const hdr = buildSmb2Header({
    command: 0x0005,
    messageId: msgId,
    sessionId: sess.sessionId,
    treeId,
    creditCharge: sess.creditCharge,
  });
  sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
  const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
  if (resp.length < 64) return { fileId: null, status: 0xc0000001 };
  const status = resp.readUInt32LE(8) >>> 0;
  if (status !== 0 || resp.length < 144) return { fileId: null, status };
  return { fileId: Buffer.from(resp.subarray(64 + 64, 64 + 80)), status: 0 };
}

async function smb2CreateStat(
  sess: OpenSmb2Session,
  treeId: number,
  relWinPath: string,
  desiredAccess: number,
  fileAttributes: number,
  createDisposition: number,
  createOptions: number
): Promise<{ fileId: Buffer | null; status: number; endOfFile: number }> {
  const msgId = sess.nextMsgId++;
  const nameBuf = Buffer.from(relWinPath, 'utf16le');
  const body = Buffer.alloc(56 + Math.max(2, nameBuf.length));
  body.writeUInt16LE(57, 0);
  body.writeUInt8(0, 2);
  body.writeUInt8(0, 3);
  body.writeUInt32LE(2, 4);
  body.writeUInt32LE(desiredAccess >>> 0, 24);
  body.writeUInt32LE(fileAttributes >>> 0, 28);
  body.writeUInt32LE(0x00000007, 32);
  body.writeUInt32LE(createDisposition >>> 0, 36);
  body.writeUInt32LE(createOptions >>> 0, 40);
  body.writeUInt16LE(64 + 56, 44);
  body.writeUInt16LE(nameBuf.length, 46);
  if (nameBuf.length > 0) nameBuf.copy(body, 56);

  const hdr = buildSmb2Header({
    command: 0x0005,
    messageId: msgId,
    sessionId: sess.sessionId,
    treeId,
    creditCharge: sess.creditCharge,
  });
  sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
  const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
  if (resp.length < 64) return { fileId: null, status: 0xc0000001, endOfFile: 0 };
  const status = resp.readUInt32LE(8) >>> 0;
  if (status !== 0 || resp.length < 144) return { fileId: null, status, endOfFile: 0 };
  const rawSize = resp.readBigUInt64LE(64 + 48);
  const endOfFile = rawSize > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(rawSize);
  return {
    fileId: Buffer.from(resp.subarray(64 + 64, 64 + 80)),
    status: 0,
    endOfFile: Math.max(0, endOfFile),
  };
}

function smbRelWinPathForShare(cleanRemote: string, shareName: string): string {
  const norm = cleanRemote.trim().replace(/\\/g, '/').replace(/\/+/g, '/') || '/';
  const trimmed = norm.replace(/^\/+/, '');
  const firstSeg = trimmed.split('/')[0] || '';
  const lowerPrefix = `/${shareName.toLowerCase()}`;
  let rel = trimmed;
  if (norm === '/' || norm.toLowerCase() === lowerPrefix) {
    rel = '';
  } else if (norm.toLowerCase().startsWith(`${lowerPrefix}/`)) {
    rel = norm.slice(lowerPrefix.length).replace(/^\/+/, '');
  } else if (shareName.toLowerCase() === 'fritz.nas') {
    rel = trimmed;
  } else if (firstSeg.toLowerCase() === shareName.toLowerCase()) {
    rel = trimmed.slice(firstSeg.length).replace(/^\/+/, '');
  }
  return rel.replace(/\//g, '\\');
}

async function smb2Close(sess: OpenSmb2Session, treeId: number, fileId: Buffer): Promise<void> {
  const msgId = sess.nextMsgId++;
  const body = Buffer.alloc(24);
  body.writeUInt16LE(24, 0);
  fileId.copy(body, 8, 0, 16);
  const hdr = buildSmb2Header({
    command: 0x0006,
    messageId: msgId,
    sessionId: sess.sessionId,
    treeId,
    creditCharge: sess.creditCharge,
  });
  sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
  await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs).catch(() => null);
}

async function smb2WriteFile(
  sess: OpenSmb2Session,
  treeId: number,
  fileId: Buffer,
  data: Buffer,
  initialOffset = 0
): Promise<number> {
  if (data.length === 0) return 0;
  const maxChunk = Math.max(4096, Math.min(sess.maxTransactSize || 32768, 32768));
  let written = 0;
  while (written < data.length) {
    const chunkLen = Math.min(maxChunk, data.length - written);
    const slice = data.subarray(written, written + chunkLen);
    const msgId = sess.nextMsgId++;
    const bodyFixed = Buffer.alloc(48);
    bodyFixed.writeUInt16LE(49, 0); // StructureSize
    bodyFixed.writeUInt16LE(64 + 48, 2); // DataOffset
    bodyFixed.writeUInt32LE(chunkLen >>> 0, 4); // Length
    bodyFixed.writeBigUInt64LE(BigInt(initialOffset + written), 8); // Offset
    fileId.copy(bodyFixed, 16, 0, 16);
    const hdr = buildSmb2Header({
      command: 0x0009,
      messageId: msgId,
      sessionId: sess.sessionId,
      treeId,
      creditCharge: sess.creditCharge,
    });
    sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, bodyFixed, slice])));
    const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
    if (resp.length < 64) return 0xc0000001;
    const status = resp.readUInt32LE(8) >>> 0;
    if (status !== 0) return status;
    const acked = resp.length >= 72 ? resp.readUInt32LE(68) >>> 0 : chunkLen;
    written += acked > 0 ? acked : chunkLen;
  }
  return 0;
}

async function smb2ReadFile(
  sess: OpenSmb2Session,
  treeId: number,
  fileId: Buffer,
  maxBytes = 256 * 1024
): Promise<{ bytes: Buffer | null; status: number }> {
  const chunkCap = Math.max(4096, Math.min(sess.maxTransactSize || 32768, 32768));
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (total < maxBytes) {
    const reqLen = Math.min(chunkCap, maxBytes - total);
    const msgId = sess.nextMsgId++;
    const body = Buffer.alloc(48);
    body.writeUInt16LE(49, 0); // StructureSize
    body.writeUInt32LE(reqLen >>> 0, 4); // Length
    body.writeBigUInt64LE(BigInt(offset), 8); // Offset
    fileId.copy(body, 16, 0, 16);
    body.writeUInt32LE(1, 32); // MinimumCount
    const hdr = buildSmb2Header({
      command: 0x0008,
      messageId: msgId,
      sessionId: sess.sessionId,
      treeId,
      creditCharge: sess.creditCharge,
    });
    sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
    const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
    if (resp.length < 64) return { bytes: null, status: 0xc0000001 };
    const status = resp.readUInt32LE(8) >>> 0;
    if (status === 0xc0000011) break; // STATUS_END_OF_FILE
    if (status !== 0) return { bytes: null, status };
    if (resp.length < 72) break;
    const dataOff = resp.readUInt8(66);
    const dataLen = resp.readUInt32LE(68) >>> 0;
    if (dataLen === 0 || dataOff < 64 || dataOff + dataLen > resp.length) break;
    chunks.push(Buffer.from(resp.subarray(dataOff, dataOff + dataLen)));
    offset += dataLen;
    total += dataLen;
    if (dataLen < reqLen) break;
  }
  return { bytes: Buffer.concat(chunks), status: 0 };
}

async function smb2QueryDirectory(
  sess: OpenSmb2Session,
  treeId: number,
  fileId: Buffer
): Promise<Array<{ name: string; isDir: boolean; sizeBytes: number }>> {
  const results: Array<{ name: string; isDir: boolean; sizeBytes: number }> = [];
  const pat = Buffer.from('*', 'utf16le');
  let restart = true;
  const maxBuf = Math.min(sess.maxTransactSize || 32768, 32768);

  for (let loop = 0; loop < 16; loop += 1) {
    const msgId = sess.nextMsgId++;
    const body = Buffer.alloc(32 + pat.length);
    body.writeUInt16LE(33, 0);
    body.writeUInt8(0x25, 2); // FileIdBothDirectoryInformation
    body.writeUInt8(restart ? 0x01 : 0x00, 3);
    body.writeUInt32LE(0, 4);
    fileId.copy(body, 8, 0, 16);
    body.writeUInt16LE(64 + 32, 24);
    body.writeUInt16LE(pat.length, 26);
    body.writeUInt32LE(maxBuf, 28);
    pat.copy(body, 32);
    restart = false;

    const hdr = buildSmb2Header({
      command: 0x000e,
      messageId: msgId,
      sessionId: sess.sessionId,
      treeId,
      creditCharge: sess.creditCharge,
    });
    sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
    const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
    if (resp.length < 72) break;
    const status = resp.readUInt32LE(8) >>> 0;
    if (status === 0x80000006 || status !== 0) break;

    const outOff = resp.readUInt16LE(66);
    const outLen = resp.readUInt32LE(68);
    if (outOff < 64 || outLen <= 0 || outOff + outLen > resp.length) break;

    let pos = outOff;
    const endPos = outOff + outLen;
    while (pos + 104 <= endPos) {
      const nextOff = resp.readUInt32LE(pos);
      const endOfFile = Number(resp.readBigInt64LE(pos + 40));
      const attrs = resp.readUInt32LE(pos + 56);
      const nameLen = resp.readUInt32LE(pos + 60);
      const namePos = pos + 104;
      if (nameLen > 0 && namePos + nameLen <= endPos) {
        const name = resp.subarray(namePos, namePos + nameLen).toString('utf16le');
        if (name && name !== '.' && name !== '..') {
          results.push({ name, isDir: (attrs & 0x10) !== 0, sizeBytes: endOfFile });
        }
      }
      if (nextOff === 0) break;
      pos += nextOff;
    }
  }
  return results;
}

async function resolveSmbTreeAndRel(
  sess: OpenSmb2Session,
  hostname: string,
  resolvedIp: string,
  remotePath: string,
  shareHint?: string
): Promise<{ shareName: string; treeId: number; relWinPath: string } | null> {
  const cleanRemote = remotePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  const firstSeg = cleanRemote.replace(/^\/+/, '').split('/')[0] || '';
  const fritzPrefixed = cleanRemote.toLowerCase().startsWith('/fritz');
  const candidates = Array.from(
    new Set(
      [
        fritzPrefixed ? 'FRITZ.NAS' : '',
        extractShareName(shareHint),
        'FRITZ.NAS',
        firstSeg && !['fritz', 'entencenter-backend'].includes(firstSeg.toLowerCase()) ? firstSeg : '',
        'Medien',
        'NAS',
        'video',
        'Public',
      ].filter(Boolean)
    )
  );
  const uncHost = hostname.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) ? hostname : resolvedIp;
  for (const share of candidates) {
    const tid = await smb2TreeConnect(sess, `\\\\${uncHost}\\${share}`).catch(() => null);
    if (tid !== null) {
      const lowerPrefix = `/${share.toLowerCase()}`;
      let rel = '';
      if (cleanRemote === '/' || cleanRemote.toLowerCase() === lowerPrefix) {
        rel = '';
      } else if (cleanRemote.toLowerCase().startsWith(`${lowerPrefix}/`)) {
        rel = cleanRemote.slice(lowerPrefix.length).replace(/^\/+/, '');
      } else if (share.toUpperCase() === 'FRITZ.NAS') {
        rel = cleanRemote.replace(/^\/+/, '');
      } else if (firstSeg.toLowerCase() === share.toLowerCase()) {
        rel = cleanRemote.replace(/^\/+/, '').split('/').slice(1).join('/');
      } else {
        rel = cleanRemote.replace(/^\/+/, '');
      }
      return { shareName: share, treeId: tid, relWinPath: rel.replace(/\//g, '\\') };
    }
  }
  return null;
}

async function ensureSmbDirRecursive(
  sess: OpenSmb2Session,
  treeId: number,
  winRel: string
): Promise<number> {
  const segs = winRel.split('\\').filter(Boolean);
  let acc = '';
  for (const seg of segs) {
    acc = acc ? `${acc}\\${seg}` : seg;
    const exist = await smb2Create(sess, treeId, acc, 0x00100081, 0x10, 1, 0x21);
    if (exist.fileId) {
      await smb2Close(sess, treeId, exist.fileId);
      if (exist.status === 0) continue;
    }
    const r = await smb2Create(sess, treeId, acc, 0x00100001, 0x10, 3, 0x21);
    if (r.fileId) await smb2Close(sess, treeId, r.fileId);
    if (r.status === 0) continue;
    const fb = await smb2Create(sess, treeId, acc, 0x00120116, 0x10, 2, 0x01);
    if (fb.fileId) await smb2Close(sess, treeId, fb.fileId);
    if (fb.status !== 0 && fb.status !== 0xc0000035) return fb.status;
  }
  return 0;
}

async function writeSmbFileBinaryVerified(
  sess: OpenSmb2Session,
  treeId: number,
  fileWin: string,
  bytes: Buffer,
  options?: { offset?: number; appendChunk?: boolean; verifyReadback?: boolean }
): Promise<number> {
  const offset = Math.max(0, options?.offset ?? 0);
  const appendChunk = Boolean(options?.appendChunk);
  const disposition = appendChunk && offset > 0 ? 3 : 5; // FILE_OPEN_IF vs FILE_OVERWRITE_IF
  let cr = await smb2Create(sess, treeId, fileWin, 0x0012019f, 0x80, disposition, 0x60);
  if (!cr.fileId || cr.status !== 0) {
    cr = await smb2Create(sess, treeId, fileWin, 0x00120116, 0x80, disposition, 0x40);
  }
  if (!cr.fileId || cr.status !== 0) {
    cr = await smb2Create(sess, treeId, fileWin, 0x40120080, 0x80, disposition, 0x40);
  }
  if (!cr.fileId || cr.status !== 0) {
    return cr.status || 0xc0000022;
  }
  const wst = await smb2WriteFile(sess, treeId, cr.fileId, bytes, offset);
  await smb2Close(sess, treeId, cr.fileId);
  if (wst !== 0) return wst;

  if (options?.verifyReadback && !appendChunk && offset === 0 && bytes.length <= 256 * 1024) {
    const rdOpen = await smb2Create(sess, treeId, fileWin, 0x00120089, 0x80, 1, 0x60);
    if (!rdOpen.fileId || rdOpen.status !== 0) {
      return rdOpen.status || 0xc0000034;
    }
    const { bytes: readBack, status: rdSt } = await smb2ReadFile(sess, treeId, rdOpen.fileId, bytes.length + 64);
    await smb2Close(sess, treeId, rdOpen.fileId);
    if (rdSt !== 0 || !readBack || readBack.length < bytes.length) {
      return rdSt || 0xc0000001;
    }
  }
  return 0;
}

export async function browseSmbDirectories(params: {
  host: string;
  port?: number;
  path?: string;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
}): Promise<{
  ok: boolean;
  shareName?: string;
  writable: boolean;
  entries: Array<{ name: string; path: string; type: 'directory' | 'file'; sizeBytes?: number; writable?: boolean }>;
  warning?: string;
}> {
  if (!params.password) {
    return { ok: false, writable: false, entries: [], warning: 'SMB-Passwort erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, writable: false, entries: [], warning: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 4200,
  });
  if (!sessRes.session) {
    return {
      ok: false,
      writable: false,
      entries: [],
      warning: sessRes.error || 'SMB-Anmeldung abgelehnt (Benutzername/Passwort oder FRITZ!Box NAS-Zugriff prüfen).',
    };
  }
  const sess = sessRes.session;
  try {
    const cleanPath = (params.path || '/').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, cleanPath, params.shareOrPath);
    if (!resolved) {
      return { ok: false, writable: false, entries: [], warning: 'Keine SMB-Freigabe (z. B. FRITZ.NAS) erreichbar.' };
    }
    const openDir = await smb2Create(sess, resolved.treeId, resolved.relWinPath, 0x00100081, 0x10, 1, 0x01);
    if (!openDir.fileId) {
      return {
        ok: false,
        writable: false,
        entries: [],
        warning: explainNtStatusGerman(openDir.status, resolved.shareName),
      };
    }
    const raw = await smb2QueryDirectory(sess, resolved.treeId, openDir.fileId);
    await smb2Close(sess, resolved.treeId, openDir.fileId);

    const writeProbe = await smb2Create(sess, resolved.treeId, resolved.relWinPath, 0x00100086, 0x10, 1, 0x21);
    const writable = Boolean(writeProbe.fileId && writeProbe.status === 0);
    if (writeProbe.fileId) await smb2Close(sess, resolved.treeId, writeProbe.fileId);

    const sorted = raw.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return {
      ok: true,
      shareName: resolved.shareName,
      writable,
      entries: sorted.map((e) => ({
        name: e.name,
        path: cleanPath === '/' ? `/${e.name}` : `${cleanPath}/${e.name}`,
        type: e.isDir ? 'directory' : 'file',
        sizeBytes: e.isDir ? undefined : e.sizeBytes,
        writable,
      })),
      warning: writable
        ? undefined
        : `Freigabe „${resolved.shareName}“ nur lesbar — Schreibrechte im FRITZ!Box-Benutzer aktivieren.`,
    };
  } finally {
    sess.socket.destroy();
  }
}

export async function provisionSmbBackend(params: {
  host: string;
  port?: number;
  targetPath: string;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
  subdirs: string[];
  files: Array<{ name: string; content: string }>;
}): Promise<{ ok: boolean; shareName?: string; warning?: string }> {
  if (!params.password) {
    return { ok: false, warning: 'SMB-Passwort für direktes Schreiben erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, warning: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 4500,
  });
  if (!sessRes.session) {
    return { ok: false, warning: sessRes.error || 'SMB-Anmeldung für Dateischreiben abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, params.targetPath, params.shareOrPath);
    if (!resolved) {
      return { ok: false, warning: 'Keine SMB-Freigabe gefunden.' };
    }
    const mkStatus = await ensureSmbDirRecursive(sess, resolved.treeId, resolved.relWinPath);
    if (mkStatus !== 0) {
      return {
        ok: false,
        shareName: resolved.shareName,
        warning: explainNtStatusGerman(mkStatus, resolved.shareName),
      };
    }
    for (const sub of params.subdirs) {
      const subWin = resolved.relWinPath
        ? `${resolved.relWinPath}\\${sub.replace(/\//g, '\\')}`
        : sub.replace(/\//g, '\\');
      await ensureSmbDirRecursive(sess, resolved.treeId, subWin);
    }
    for (const f of params.files) {
      const fileWin = resolved.relWinPath ? `${resolved.relWinPath}\\${f.name}` : f.name;
      const wst = await writeSmbFileBinaryVerified(sess, resolved.treeId, fileWin, Buffer.from(f.content, 'utf8'), {
        verifyReadback: f.name === 'entencenter-backend.json',
      });
      if (wst !== 0) {
        return {
          ok: false,
          shareName: resolved.shareName,
          warning: explainNtStatusGerman(wst, resolved.shareName),
        };
      }
    }
    return { ok: true, shareName: resolved.shareName };
  } finally {
    sess.socket.destroy();
  }
}

export async function writeSmbFile(params: {
  host: string;
  port?: number;
  targetPath: string;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
  data: Buffer;
  offset?: number;
  append?: boolean;
  createParentDirs?: boolean;
}): Promise<{ ok: boolean; shareName?: string; filePath: string; bytesWritten?: number; verified?: boolean; error?: string }> {
  const cleanTarget = `/${params.targetPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  if (!params.password) {
    return { ok: false, filePath: cleanTarget, error: 'SMB-Passwort zum Schreiben erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, filePath: cleanTarget, error: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 5000,
  });
  if (!sessRes.session) {
    return { ok: false, filePath: cleanTarget, error: sessRes.error || 'SMB-Anmeldung abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, cleanTarget, params.shareOrPath);
    if (!resolved || !resolved.relWinPath) {
      return { ok: false, filePath: cleanTarget, error: 'Zielpfad/SMB-Freigabe ungültig.' };
    }
    if (params.createParentDirs !== false && !params.append && resolved.relWinPath.includes('\\')) {
      const parentWin = resolved.relWinPath.slice(0, resolved.relWinPath.lastIndexOf('\\'));
      const mkSt = await ensureSmbDirRecursive(sess, resolved.treeId, parentWin);
      if (mkSt !== 0) {
        return {
          ok: false,
          shareName: resolved.shareName,
          filePath: cleanTarget,
          error: explainNtStatusGerman(mkSt, resolved.shareName),
        };
      }
    }
    const wst = await writeSmbFileBinaryVerified(sess, resolved.treeId, resolved.relWinPath, params.data, {
      offset: params.offset ?? 0,
      appendChunk: Boolean(params.append),
      verifyReadback: !params.append && (params.offset ?? 0) === 0,
    });
    if (wst !== 0) {
      return {
        ok: false,
        shareName: resolved.shareName,
        filePath: cleanTarget,
        error: explainNtStatusGerman(wst, resolved.shareName),
      };
    }
    return {
      ok: true,
      shareName: resolved.shareName,
      filePath: cleanTarget,
      bytesWritten: params.data.length,
      verified: true,
    };
  } finally {
    sess.socket.destroy();
  }
}

export async function readSmbFile(params: {
  host: string;
  port?: number;
  targetPath: string;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
}): Promise<{ ok: boolean; shareName?: string; filePath: string; bytesRead?: number; content?: string; error?: string }> {
  const cleanTarget = `/${params.targetPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  if (!params.password) {
    return { ok: false, filePath: cleanTarget, error: 'SMB-Passwort erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, filePath: cleanTarget, error: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 4500,
  });
  if (!sessRes.session) {
    return { ok: false, filePath: cleanTarget, error: sessRes.error || 'SMB-Anmeldung abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, cleanTarget, params.shareOrPath);
    if (!resolved || !resolved.relWinPath) {
      return { ok: false, filePath: cleanTarget, error: 'SMB-Freigabe nicht gefunden.' };
    }
    const cr = await smb2Create(sess, resolved.treeId, resolved.relWinPath, 0x00120089, 0x80, 1, 0x60);
    if (!cr.fileId || cr.status !== 0) {
      return {
        ok: false,
        shareName: resolved.shareName,
        filePath: cleanTarget,
        error: explainNtStatusGerman(cr.status, resolved.shareName),
      };
    }
    const { bytes, status } = await smb2ReadFile(sess, resolved.treeId, cr.fileId);
    await smb2Close(sess, resolved.treeId, cr.fileId);
    if (status !== 0 || !bytes) {
      return {
        ok: false,
        shareName: resolved.shareName,
        filePath: cleanTarget,
        error: explainNtStatusGerman(status, resolved.shareName),
      };
    }
    return {
      ok: true,
      shareName: resolved.shareName,
      filePath: cleanTarget,
      bytesRead: bytes.length,
      content: bytes.toString('utf8'),
    };
  } finally {
    sess.socket.destroy();
  }
}

export interface SmbVolumeStatsResult {
  ok: boolean;
  shareName?: string;
  source?: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent?: number;
  freePercent?: number;
  error?: string;
}

export function parseSmb2FileSystemSizeBuffer(
  buf: Buffer,
  infoClass: number
): { ok: boolean; totalBytes: number; freeBytes: number; usedBytes: number } | null {
  if (infoClass === 7 && buf.length >= 32) {
    const totalUnits = buf.readBigUInt64LE(0);
    const callerAvail = buf.readBigUInt64LE(8);
    const actualAvail = buf.readBigUInt64LE(16);
    const sectorsPerUnit = BigInt(buf.readUInt32LE(24));
    const bytesPerSector = BigInt(buf.readUInt32LE(28));
    const unitBytes = sectorsPerUnit * bytesPerSector;
    if (totalUnits > 0n && unitBytes > 0n) {
      const availUnits = actualAvail > 0n ? actualAvail : callerAvail;
      const totalBig = totalUnits * unitBytes;
      const freeBigRaw = availUnits * unitBytes;
      const freeBig = freeBigRaw > totalBig ? totalBig : freeBigRaw < 0n ? 0n : freeBigRaw;
      const usedBig = totalBig > freeBig ? totalBig - freeBig : 0n;
      const totalBytes = totalBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(totalBig);
      const freeBytes = freeBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(freeBig);
      const usedBytes = usedBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(usedBig);
      return { ok: true, totalBytes, freeBytes, usedBytes };
    }
  } else if (infoClass === 3 && buf.length >= 24) {
    const totalUnits = buf.readBigUInt64LE(0);
    const availUnits = buf.readBigUInt64LE(8);
    const sectorsPerUnit = BigInt(buf.readUInt32LE(16));
    const bytesPerSector = BigInt(buf.readUInt32LE(20));
    const unitBytes = sectorsPerUnit * bytesPerSector;
    if (totalUnits > 0n && unitBytes > 0n) {
      const totalBig = totalUnits * unitBytes;
      const freeBigRaw = availUnits * unitBytes;
      const freeBig = freeBigRaw > totalBig ? totalBig : freeBigRaw < 0n ? 0n : freeBigRaw;
      const usedBig = totalBig > freeBig ? totalBig - freeBig : 0n;
      const totalBytes = totalBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(totalBig);
      const freeBytes = freeBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(freeBig);
      const usedBytes = usedBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(usedBig);
      return { ok: true, totalBytes, freeBytes, usedBytes };
    }
  }
  return null;
}

async function smb2QueryFileSystemSize(
  sess: OpenSmb2Session,
  treeId: number,
  relWinPath = ''
): Promise<{ ok: boolean; totalBytes: number; freeBytes: number; usedBytes: number } | null> {
  const dirOpen = await smb2Create(sess, treeId, relWinPath, 0x00000080, 0x10, 1, 0x01);
  if (!dirOpen.fileId || dirOpen.status !== 0) return null;
  try {
    for (const infoClass of [7, 3]) {
      const msgId = sess.nextMsgId++;
      const body = Buffer.alloc(41);
      body.writeUInt16LE(41, 0); // StructureSize
      body.writeUInt8(0x02, 2); // SMB2_0_INFO_FILESYSTEM
      body.writeUInt8(infoClass, 3);
      body.writeUInt32LE(64, 4); // OutputBufferLength
      dirOpen.fileId.copy(body, 24, 0, 16);
      const hdr = buildSmb2Header({
        command: 0x0010, // SMB2 QUERY_INFO
        messageId: msgId,
        sessionId: sess.sessionId,
        treeId,
        creditCharge: sess.creditCharge,
      });
      sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
      const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
      if (resp.length < 72) continue;
      const status = resp.readUInt32LE(8) >>> 0;
      if (status !== 0) continue;
      const outOff = resp.readUInt16LE(66);
      const outLen = resp.readUInt32LE(68);
      if (outOff < 64 || outLen <= 0 || outOff + outLen > resp.length) continue;
      const parsed = parseSmb2FileSystemSizeBuffer(resp.subarray(outOff, outOff + outLen), infoClass);
      if (parsed && parsed.totalBytes > 0) {
        return parsed;
      }
    }
    return null;
  } finally {
    await smb2Close(sess, treeId, dirOpen.fileId);
  }
}

async function queryBestSmbVolumeSize(
  sess: OpenSmb2Session,
  treeId: number,
  isFritz: boolean
): Promise<{ ok: boolean; totalBytes: number; freeBytes: number; usedBytes: number } | null> {
  const rootStats = await smb2QueryFileSystemSize(sess, treeId, '');
  if (rootStats && (!isFritz || rootStats.totalBytes >= 512 * 1024 * 1024)) {
    return rootStats;
  }

  const openDir = await smb2Create(sess, treeId, '', 0x00100081, 0x10, 1, 0x01);
  if (!openDir.fileId || openDir.status !== 0) return rootStats;
  const topEntries = await smb2QueryDirectory(sess, treeId, openDir.fileId);
  await smb2Close(sess, treeId, openDir.fileId);

  let bestChild: { ok: boolean; totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
  const seenSizes = new Set<string>();
  let sumTotal = 0;
  let sumFree = 0;
  let largeUsbCount = 0;

  for (const entry of topEntries) {
    if (!entry.isDir) continue;
    const lower = entry.name.toLowerCase();
    if (lower.startsWith('.') || lower === 'fritz') continue;
    const childStats = await smb2QueryFileSystemSize(sess, treeId, entry.name);
    if (!childStats || childStats.totalBytes <= 0) continue;
    if (!bestChild || childStats.totalBytes > bestChild.totalBytes) {
      bestChild = childStats;
    }
    if (childStats.totalBytes >= 512 * 1024 * 1024) {
      const key = `${childStats.totalBytes}:${childStats.freeBytes}`;
      if (!seenSizes.has(key)) {
        seenSizes.add(key);
        sumTotal += childStats.totalBytes;
        sumFree += childStats.freeBytes;
        largeUsbCount += 1;
      }
    }
  }

  if (largeUsbCount > 1 && sumTotal > 0) {
    const clampedFree = Math.min(Math.max(0, sumFree), sumTotal);
    return { ok: true, totalBytes: sumTotal, freeBytes: clampedFree, usedBytes: Math.max(0, sumTotal - clampedFree) };
  }
  if (bestChild && (!rootStats || bestChild.totalBytes > rootStats.totalBytes)) {
    return bestChild;
  }
  return rootStats;
}

export async function getSmbVolumeStats(params: {
  host: string;
  port?: number;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
}): Promise<SmbVolumeStatsResult> {
  if (!params.password) {
    return { ok: false, totalBytes: 0, freeBytes: 0, usedBytes: 0, error: 'SMB-Passwort erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, totalBytes: 0, freeBytes: 0, usedBytes: 0, error: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 4500,
  });
  if (!sessRes.session) {
    return { ok: false, totalBytes: 0, freeBytes: 0, usedBytes: 0, error: sessRes.error || 'SMB-Anmeldung abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const isFritz = params.host.toLowerCase().includes('fritz') || (params.shareOrPath || '').toUpperCase().includes('FRITZ');
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, '/', params.shareOrPath);
    if (!resolved) {
      return { ok: false, totalBytes: 0, freeBytes: 0, usedBytes: 0, error: 'SMB-Freigabe nicht gefunden.' };
    }
    const stats = await queryBestSmbVolumeSize(sess, resolved.treeId, isFritz);
    if (!stats || !stats.ok || stats.totalBytes <= 0) {
      return {
        ok: false,
        shareName: resolved.shareName,
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        error: 'Volume-Größe über SMB2 QUERY_INFO nicht gemeldet.',
      };
    }
    const usedPercent = Number(((stats.usedBytes / stats.totalBytes) * 100).toFixed(1));
    const freePercent = Math.max(0, Number((100 - usedPercent).toFixed(1)));
    return {
      ok: true,
      shareName: resolved.shareName,
      source: 'smb2_query_info',
      totalBytes: stats.totalBytes,
      freeBytes: stats.freeBytes,
      usedBytes: stats.usedBytes,
      usedPercent,
      freePercent,
    };
  } finally {
    sess.socket.destroy();
  }
}

function inferScanMediaKind(name: string, dirPath = ''): 'movie' | 'series' | 'image' | 'music' | 'video' | 'other' {
  const lower = name.toLowerCase();
  const normDir = `/${dirPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`.toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg)$/.test(lower)) return 'image';
  if (/\.(mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|aiff|aif|alac|ape|wv|mka|amr|mid|midi|ac3|dts)$/.test(lower)) return 'music';
  if (/\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|iso)$/.test(lower)) {
    const isSeriesFile = /(?:^|[\s._(-])(?:s\d{1,2}\s*[._-]?\s*e\d{1,3}|\d{1,2}x\d{1,3})(?:$|[\s._)-])|\b(?:staffel|season)\s*\d+\b|\b(?:episode|folge)\s*\d+\b/i.test(lower);
    const isSeriesDir = /\/(?:serien|series|tv[\s._-]?shows?|tv[\s._-]?serien|anime|doku[\s._-]?serien|staffel[\s._-]*\d*|season[\s._-]*\d*|s\d{1,2})(?:\/|$)/i.test(normDir);
    const isShortClipDir = /\/(?:clips?|shorts?|reels?|camera|kamera|dcim|whatsapp(?:\s+video)?|handy|privat|homevideo|sample|trailer|musikvideos?|music[\s._-]?videos?)(?:\/|$)/i.test(normDir);
    const isShortClipFile = /(?:^|[\s._-])(?:sample|trailer|teaser|whatsapp|vid[-_]\d{8}|pxl[-_]\d{8}|img[-_]\d{4}|mov[-_]\d{4}|dsc[-_]\d{4})(?:$|[\s._-])/i.test(lower);
    if (isSeriesFile || isSeriesDir) return 'series';
    if (isShortClipDir || isShortClipFile) return 'video';
    return 'movie';
  }
  return 'other';
}

function isMediaScanFilename(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower === 'thumbs.db' || lower === 'desktop.ini') return false;
  return /\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|aiff|aif|alac|ape|wv|mka|amr|mid|midi|ac3|dts|jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg|pdf|epub|txt|srt|vtt)$/.test(lower);
}

export async function scanSmbMediaFolders(params: {
  host: string;
  port?: number;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
  scanMode: 'all' | 'selected';
  folders?: string[];
  maxFiles?: number;
  maxDepth?: number;
}): Promise<{
  ok: boolean;
  shareName?: string;
  scannedFolders: string[];
  files: Array<{ name: string; path: string; dirPath: string; sizeBytes: number; inferredKind: 'movie' | 'series' | 'image' | 'music' | 'video' | 'other' }>;
  scannedFilesCount?: number;
  scannedTotalBytes?: number;
  truncated?: boolean;
  volumeTotalBytes?: number;
  volumeFreeBytes?: number;
  volumeUsedBytes?: number;
  volumeSource?: string;
  mediaBreakdown?: {
    moviesCount: number;
    moviesBytes: number;
    seriesCount: number;
    seriesBytes: number;
    musicCount: number;
    musicBytes: number;
    videosCount: number;
    videosBytes: number;
    imagesCount: number;
    imagesBytes: number;
    otherCount: number;
    otherBytes: number;
  };
  error?: string;
}> {
  if (!params.password) {
    return { ok: false, scannedFolders: [], files: [], error: 'SMB-Passwort erforderlich.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, scannedFolders: [], files: [], error: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 5000,
  });
  if (!sessRes.session) {
    return { ok: false, scannedFolders: [], files: [], error: sessRes.error || 'SMB-Anmeldung abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const roots =
      params.scanMode === 'selected' && params.folders && params.folders.length > 0
        ? Array.from(new Set(params.folders.map((f) => `/${f.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}` || '/')))
        : ['/'];
    const rootResolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, '/', params.shareOrPath);
    if (!rootResolved) {
      return { ok: false, scannedFolders: [], files: [], error: 'SMB-Freigabe nicht gefunden.' };
    }
    const maxFiles = Math.min(Math.max(params.maxFiles ?? 25000, 20), 50000);
    const maxDepth = Math.min(Math.max(params.maxDepth ?? 12, 1), 16);
    const scannedFolders: string[] = [];
    const files: Array<{ name: string; path: string; dirPath: string; sizeBytes: number; inferredKind: 'movie' | 'series' | 'image' | 'music' | 'video' | 'other' }> = [];
    const visited = new Set<string>();
    const queue: Array<{ dirPath: string; depth: number }> = roots.map((dirPath) => ({ dirPath, depth: 0 }));

    let scannedFilesCount = 0;
    let scannedTotalBytes = 0;
    let truncated = false;
    const mediaBreakdown = {
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

    while (queue.length > 0 && visited.size < 8000) {
      const next = queue.shift()!;
      const normDir = next.dirPath || '/';
      if (visited.has(normDir.toLowerCase())) continue;
      visited.add(normDir.toLowerCase());

      const relWin = smbRelWinPathForShare(normDir, rootResolved.shareName);
      let openDir = await smb2Create(sess, rootResolved.treeId, relWin, 0x00100081, 0x10, 1, 0x01);
      if ((!openDir.fileId || openDir.status !== 0) && /^fritz(\\|$)/i.test(relWin)) {
        const altRel = relWin.replace(/^fritz\\?/i, '');
        const altOpen = await smb2Create(sess, rootResolved.treeId, altRel, 0x00100081, 0x10, 1, 0x01);
        if (altOpen.fileId && altOpen.status === 0) {
          openDir = altOpen;
        }
      }
      if (!openDir.fileId || openDir.status !== 0) continue;
      const entries = await smb2QueryDirectory(sess, rootResolved.treeId, openDir.fileId);
      await smb2Close(sess, rootResolved.treeId, openDir.fileId);
      scannedFolders.push(normDir);

      for (const entry of entries) {
        const childPath = normDir === '/' ? `/${entry.name}` : `${normDir}/${entry.name}`;
        const lower = entry.name.toLowerCase();
        if (entry.isDir) {
          if (
            next.depth < maxDepth &&
            !lower.startsWith('.') &&
            ![
              'wal',
              'backups',
              'profiles',
              'config',
              'entencenter-backend',
              '@eadir',
              '#recycle',
              '$recycle.bin',
              'system volume information',
            ].includes(lower)
          ) {
            queue.push({ dirPath: childPath, depth: next.depth + 1 });
          }
        } else {
          const safeSize = Math.max(0, entry.sizeBytes || 0);
          scannedFilesCount += 1;
          scannedTotalBytes += safeSize;
          const kind = inferScanMediaKind(entry.name, normDir);
          if (kind === 'movie') {
            mediaBreakdown.moviesCount += 1;
            mediaBreakdown.moviesBytes += safeSize;
          } else if (kind === 'series') {
            mediaBreakdown.seriesCount += 1;
            mediaBreakdown.seriesBytes += safeSize;
          } else if (kind === 'music') {
            mediaBreakdown.musicCount += 1;
            mediaBreakdown.musicBytes += safeSize;
          } else if (kind === 'video') {
            mediaBreakdown.videosCount += 1;
            mediaBreakdown.videosBytes += safeSize;
          } else if (kind === 'image') {
            mediaBreakdown.imagesCount += 1;
            mediaBreakdown.imagesBytes += safeSize;
          } else {
            mediaBreakdown.otherCount += 1;
            mediaBreakdown.otherBytes += safeSize;
          }
          if (isMediaScanFilename(entry.name)) {
            if (files.length < maxFiles) {
              files.push({
                name: entry.name,
                path: childPath,
                dirPath: normDir,
                sizeBytes: safeSize,
                inferredKind: kind,
              });
            } else {
              truncated = true;
            }
          }
        }
      }
    }

    const isFritz = params.host.toLowerCase().includes('fritz') || rootResolved.shareName.toUpperCase() === 'FRITZ.NAS';
    const vol = await queryBestSmbVolumeSize(sess, rootResolved.treeId, isFritz).catch(() => null);

    return {
      ok: true,
      shareName: rootResolved.shareName,
      scannedFolders,
      files,
      scannedFilesCount,
      scannedTotalBytes,
      truncated,
      ...(vol && vol.ok && vol.totalBytes > 0
        ? {
            volumeTotalBytes: vol.totalBytes,
            volumeFreeBytes: vol.freeBytes,
            volumeUsedBytes: vol.usedBytes,
            volumeSource: 'smb2_query_info',
          }
        : {}),
      mediaBreakdown,
    };
  } finally {
    sess.socket.destroy();
  }
}

export async function statAndStreamSmbFileRange(params: {
  host: string;
  port?: number;
  targetPath: string;
  shareOrPath?: string;
  username?: string;
  password: string;
  domainOrWorkgroup?: string;
  rangeStart?: number;
  rangeEnd?: number;
  isHeadOnly?: boolean;
  onMetadata: (totalSize: number, startByte: number, endByte: number) => Promise<boolean> | boolean;
  onChunk: (chunk: Buffer) => Promise<boolean> | boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const cleanTarget = `/${params.targetPath.trim().replace(/^smb:\/\/[^/]+/i, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  if (!params.password || cleanTarget === '/') {
    return { ok: false, error: 'SMB-Passwort oder gültiger Pfad fehlt.' };
  }
  const dnsRes = await resolveHostIp(params.host);
  if (!dnsRes.ok || !dnsRes.ip) {
    return { ok: false, error: dnsRes.error || 'DNS fehlgeschlagen.' };
  }
  const sessRes = await openBestSmb2SessionWithRetries({
    hostname: params.host,
    resolvedIp: dnsRes.ip,
    port: sanitizeSmbPort(params.port),
    username: params.username,
    password: params.password,
    domainOrWorkgroup: params.domainOrWorkgroup,
    timeoutMs: 6000,
  });
  if (!sessRes.session) {
    return { ok: false, error: sessRes.error || 'SMB-Anmeldung abgelehnt.' };
  }
  const sess = sessRes.session;
  try {
    const resolved = await resolveSmbTreeAndRel(sess, params.host, dnsRes.ip, cleanTarget, params.shareOrPath);
    if (!resolved || !resolved.relWinPath) {
      return { ok: false, error: 'SMB-Freigabe nicht gefunden.' };
    }
    let stat = await smb2CreateStat(sess, resolved.treeId, resolved.relWinPath, 0x00120089, 0x80, 1, 0x60);
    if ((!stat.fileId || stat.status !== 0) && /^fritz\\/i.test(resolved.relWinPath)) {
      const altRel = resolved.relWinPath.replace(/^fritz\\/i, '');
      if (altRel) {
        const altStat = await smb2CreateStat(sess, resolved.treeId, altRel, 0x00120089, 0x80, 1, 0x60);
        if (altStat.fileId && altStat.status === 0) stat = altStat;
      }
    }
    if (!stat.fileId || stat.status !== 0) {
      return { ok: false, error: explainNtStatusGerman(stat.status, resolved.shareName) };
    }
    try {
      const totalSize = stat.endOfFile;
      const startByte = Math.max(0, params.rangeStart ?? 0);
      const endByte = totalSize <= 0 ? -1 : Math.min(totalSize - 1, params.rangeEnd ?? totalSize - 1);
      const proceed = await params.onMetadata(totalSize, startByte, endByte);
      if (!proceed || params.isHeadOnly || totalSize <= 0 || endByte < startByte) {
        return { ok: true };
      }

      const chunkSize = Math.max(4096, Math.min(sess.maxTransactSize || 32768, 65536));
      let offset = startByte;
      while (offset <= endByte) {
        const reqLen = Math.min(chunkSize, endByte - offset + 1);
        const msgId = sess.nextMsgId++;
        const body = Buffer.alloc(49);
        body.writeUInt16LE(49, 0);
        body.writeUInt8(0x50, 2);
        body.writeUInt32LE(reqLen >>> 0, 4);
        body.writeBigUInt64LE(BigInt(offset), 8);
        stat.fileId.copy(body, 16, 0, 16);
        body.writeUInt32LE(1, 32);
        const hdr = buildSmb2Header({
          command: 0x0008,
          messageId: msgId,
          sessionId: sess.sessionId,
          treeId: resolved.treeId,
          creditCharge: sess.creditCharge,
        });
        sess.socket.write(wrapNetBiosFrame(Buffer.concat([hdr, body])));
        const resp = await readNextNetBiosFrame(sess.socket, sess.state, sess.timeoutMs);
        if (resp.length < 64) return { ok: false, error: 'SMB2 Read Timeout.' };
        const status = resp.readUInt32LE(8) >>> 0;
        if (status === 0xc0000011) break;
        if (status !== 0 || resp.length < 80) {
          return { ok: false, error: explainNtStatusGerman(status, resolved.shareName) };
        }
        const dataOff = resp.readUInt8(64 + 2);
        const dataLen = resp.readUInt32LE(64 + 4);
        if (dataLen <= 0 || dataOff < 64 || dataOff + dataLen > resp.length) break;
        const okChunk = await params.onChunk(resp.subarray(dataOff, dataOff + dataLen));
        if (!okChunk) break;
        offset += dataLen;
        if (dataLen < reqLen) break;
      }
      return { ok: true };
    } finally {
      await smb2Close(sess, resolved.treeId, stat.fileId);
    }
  } finally {
    sess.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Real WebDAV HTTPS / HTTP Prober (OPTIONS + PROPFIND + Basic Auth check)
// ---------------------------------------------------------------------------
export async function probeWebDavProtocol(params: {
  hostname: string;
  port: number;
  useTls: boolean;
  shareOrPath?: string;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls: boolean;
  customCaPem?: string | null;
  timeoutMs?: number;
}): Promise<NasProtocolVerificationResult> {
  const started = Date.now();
  const scheme = params.useTls ? 'https' : 'http';
  const cleanPath = (params.shareOrPath || '/').trim();
  const targetPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
  const url = `${scheme}://${params.hostname}:${params.port}${targetPath}`;
  const hasCreds = Boolean(params.username?.trim() && (params.password ?? '').length > 0);
  const authHeaders: Record<string, string> = {};
  if (hasCreds) {
    authHeaders.Authorization = `Basic ${Buffer.from(
      `${params.username!.trim()}:${params.password ?? ''}`,
      'utf8'
    ).toString('base64')}`;
  }

  try {
    const optRes = await requestWithLocalTlsPolicy(url, {
      method: 'OPTIONS',
      headers: {
        ...authHeaders,
        'User-Agent': 'EntenCenter-UniversalNAS/1.0',
      },
      timeoutMs: params.timeoutMs ?? 3800,
      allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
      customCaPem: params.customCaPem,
    });

    const davHeader = (optRes.headers['dav'] || '').toLowerCase();
    const allowHeader = (optRes.headers['allow'] || '').toUpperCase();
    const wwwAuth = (optRes.headers['www-authenticate'] || '').toLowerCase();
    const looksLikeWebDav =
      davHeader.length > 0 ||
      allowHeader.includes('PROPFIND') ||
      optRes.status === 207 ||
      optRes.status === 401;

    // Einige WebDAV-Server (Synology/Nextcloud/Apache mod_dav) geben DAV-Header erst bei PROPFIND zurück
    let propStatus = optRes.status;
    let propBody = '';
    if (looksLikeWebDav || optRes.status === 405 || optRes.status === 200) {
      const propRes = await requestWithLocalTlsPolicy(url, {
        method: 'PROPFIND',
        headers: {
          ...authHeaders,
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
        timeoutMs: params.timeoutMs ?? 3800,
        allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
        customCaPem: params.customCaPem,
      }).catch(() => null);
      if (propRes) {
        propStatus = propRes.status;
        propBody = propRes.body || '';
      }
    }

    const isMultiStatus = propStatus === 207 || propBody.toLowerCase().includes('<d:multistatus') || propBody.toLowerCase().includes('<multistatus');
    const verifiedDav = isMultiStatus || davHeader.length > 0 || allowHeader.includes('PROPFIND');

    if ((optRes.status === 400 || optRes.status === 404) && !verifiedDav) {
      return {
        protocol: 'webdav',
        port: params.port,
        priority: 2,
        label: params.useTls ? 'WebDAV (HTTPS)' : 'WebDAV (HTTP)',
        role: 'file_access',
        useTls: params.useTls,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: hasCreds,
        endpointMismatch: true,
        httpStatus: propStatus,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: `HTTP_${propStatus}_NO_WEBDAV`,
        message: `Port ${params.port} antwortet mit HTTP ${propStatus}, stellt auf „${targetPath}“ jedoch kein WebDAV (PROPFIND/DAV) bereit.`,
      };
    }

    if (propStatus === 401 || optRes.status === 401) {
      return {
        protocol: 'webdav',
        port: params.port,
        priority: 2,
        label: params.useTls ? 'WebDAV (HTTPS)' : 'WebDAV (HTTP)',
        role: 'file_access',
        useTls: params.useTls,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: hasCreds,
        httpStatus: 401,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: hasCreds ? 'WEBDAV_AUTH_FAILED' : 'WEBDAV_AUTH_REQUIRED',
        message: hasCreds
          ? `WebDAV-Anmeldung auf ${scheme.toUpperCase()}:${params.port} abgelehnt (HTTP 401${wwwAuth.includes('digest') ? ' Digest' : ''}). Zugangsdaten prüfen.`
          : `WebDAV auf ${scheme.toUpperCase()}:${params.port} bestätigt — Anmeldung erforderlich (HTTP 401).`,
      };
    }

    if (!verifiedDav) {
      return {
        protocol: 'webdav',
        port: params.port,
        priority: 2,
        label: params.useTls ? 'WebDAV (HTTPS)' : 'WebDAV (HTTP)',
        role: 'file_access',
        useTls: params.useTls,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: hasCreds,
        endpointMismatch: true,
        httpStatus: propStatus,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: 'NOT_WEBDAV_ENDPOINT',
        message: `HTTP ${propStatus} auf ${scheme}://${params.hostname}:${params.port}${targetPath} — kein gültiger WebDAV-Endpunkt.`,
      };
    }

    return {
      protocol: 'webdav',
      port: params.port,
      priority: 2,
      label: params.useTls ? 'WebDAV (HTTPS)' : 'WebDAV (HTTP)',
      role: 'file_access',
      useTls: params.useTls,
      tcpOpen: true,
      protocolVerified: true,
      authVerified: hasCreds ? isMultiStatus || (propStatus >= 200 && propStatus < 300) : false,
      authAttempted: hasCreds,
      shareVerified: isMultiStatus,
      httpStatus: propStatus,
      latencyMs: Math.max(1, Date.now() - started),
      message: `${scheme.toUpperCase()} WebDAV auf Port ${params.port} verifiziert${
        isMultiStatus ? ' (PROPFIND 207 Multi-Status OK)' : ` (HTTP ${propStatus})`
      }.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'WebDAV-Verbindung fehlgeschlagen';
    const isTlsErr = /cert|ssl|tls|self[- ]signed|unable to verify/i.test(msg);
    return {
      protocol: 'webdav',
      port: params.port,
      priority: 2,
      label: params.useTls ? 'WebDAV (HTTPS)' : 'WebDAV (HTTP)',
      role: 'file_access',
      useTls: params.useTls,
      tcpOpen: isTlsErr,
      protocolVerified: false,
      authVerified: false,
      authAttempted: hasCreds,
      latencyMs: null,
      errorCode: isTlsErr ? 'TLS_CERTIFICATE_ERROR' : 'WEBDAV_UNREACHABLE',
      message: isTlsErr
        ? `WebDAV HTTPS Zertifikatsfehler auf Port ${params.port}: ${msg}`
        : `WebDAV unter ${scheme}://${params.hostname}:${params.port} nicht erreichbar (${msg}).`,
    };
  }
}

// ---------------------------------------------------------------------------
// Real SFTP / SSH Prober (SSH-2.0 Banner Check)
// ---------------------------------------------------------------------------
export async function probeSftpProtocol(params: {
  hostname: string;
  resolvedIp: string;
  port: number;
  timeoutMs?: number;
}): Promise<NasProtocolVerificationResult> {
  const started = Date.now();
  const timeoutMs = params.timeoutMs ?? 3000;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let tcpOpen = false;
    let buffer = '';

    const finish = (res: NasProtocolVerificationResult) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(res);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      tcpOpen = true;
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lineBreak = buffer.indexOf('\n');
      const firstLine = (lineBreak >= 0 ? buffer.slice(0, lineBreak) : buffer).trim();
      if (firstLine.startsWith('SSH-2.0-')) {
        socket.write('SSH-2.0-EntenCenter_1.0\r\n');
        finish({
          protocol: 'sftp',
          port: params.port,
          priority: 3,
          label: 'SFTP / SSH',
          role: 'file_access',
          useTls: true,
          tcpOpen: true,
          protocolVerified: true,
          authVerified: false,
          authAttempted: false,
          serverBanner: firstLine,
          latencyMs: Math.max(1, Date.now() - started),
          message: `SFTP/SSH-2.0 auf Port ${params.port} bestätigt (${firstLine}).`,
        });
      } else if (firstLine.startsWith('SSH-1.')) {
        finish({
          protocol: 'sftp',
          port: params.port,
          priority: 3,
          label: 'SFTP / SSH',
          role: 'file_access',
          useTls: false,
          tcpOpen: true,
          protocolVerified: false,
          authVerified: false,
          authAttempted: false,
          serverBanner: firstLine,
          latencyMs: Math.max(1, Date.now() - started),
          errorCode: 'SSH1_UNSUPPORTED',
          message: `Veraltetes SSH-1 auf Port ${params.port} abgelehnt (${firstLine}).`,
        });
      } else if (lineBreak >= 0 || buffer.length > 256) {
        finish({
          protocol: 'sftp',
          port: params.port,
          priority: 3,
          label: 'SFTP / SSH',
          role: 'file_access',
          useTls: false,
          tcpOpen: true,
          protocolVerified: false,
          authVerified: false,
          authAttempted: false,
          latencyMs: Math.max(1, Date.now() - started),
          errorCode: 'NOT_SSH_BANNER',
          message: `Port ${params.port} liefert kein SSH-2.0/SFTP-Banner.`,
        });
      }
    });
    socket.once('timeout', () =>
      finish({
        protocol: 'sftp',
        port: params.port,
        priority: 3,
        label: 'SFTP / SSH',
        role: 'file_access',
        useTls: false,
        tcpOpen,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: null,
        errorCode: 'ETIMEDOUT',
        message: tcpOpen
          ? `Port ${params.port} offen, aber kein SSH-2.0/SFTP-Banner empfangen.`
          : `SFTP-Port ${params.port} auf ${params.hostname} nicht erreichbar (Timeout).`,
      })
    );
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({
        protocol: 'sftp',
        port: params.port,
        priority: 3,
        label: 'SFTP / SSH',
        role: 'file_access',
        useTls: false,
        tcpOpen,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: null,
        errorCode: err.code || 'ECONNREFUSED',
        message: `SFTP-Port ${params.port} nicht erreichbar (${err.code || err.message}).`,
      })
    );

    try {
      socket.connect(params.port, params.resolvedIp);
    } catch {
      finish({
        protocol: 'sftp',
        port: params.port,
        priority: 3,
        label: 'SFTP / SSH',
        role: 'file_access',
        useTls: false,
        tcpOpen: false,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: null,
        errorCode: 'ECONNFAILED',
        message: `SFTP-Port ${params.port} konnte nicht geöffnet werden.`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Real FTP / FTPS Prober (220 Greeting + Explicit AUTH TLS / Implicit 990 + Auth)
// ---------------------------------------------------------------------------
function readFtpResponse(
  sock: net.Socket | tls.TLSSocket,
  timeoutMs: number
): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let acc = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('FTP-Zeitüberschreitung'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      acc += chunk.toString('utf8');
      const lines = acc.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length === 0) return;
      const last = lines[lines.length - 1];
      const match = /^(\d{3}) /.exec(last);
      if (match) {
        cleanup();
        resolve({ code: Number(match[1]), text: acc.trim() });
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onErr);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

export async function probeFtpsProtocol(params: {
  hostname: string;
  resolvedIp: string;
  port: number;
  isLan: boolean;
  scope: NasConnectionScope;
  ftpsTlsMode?: 'explicit' | 'implicit';
  username?: string;
  password?: string;
  allowLocalSelfSignedTls: boolean;
  customCaPem?: string | null;
  timeoutMs?: number;
}): Promise<NasProtocolVerificationResult> {
  const started = Date.now();
  const timeoutMs = params.timeoutMs ?? 3800;
  const implicit = params.ftpsTlsMode === 'implicit' || params.port === 990;
  const hasCreds = Boolean(params.username?.trim() && (params.password ?? '').length > 0);

  let activeSocket: net.Socket | tls.TLSSocket | null = null;
  try {
    if (implicit) {
      activeSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect(
          {
            host: params.resolvedIp,
            port: params.port,
            servername: net.isIP(params.hostname) === 0 ? params.hostname : undefined,
            rejectUnauthorized: !params.allowLocalSelfSignedTls && !params.isLan,
            ca: params.customCaPem ? [params.customCaPem] : undefined,
            timeout: timeoutMs,
          },
          () => resolve(s)
        );
        s.once('error', reject);
        s.once('timeout', () => reject(new Error('FTPS-TLS-Timeout')));
      });
    } else {
      activeSocket = await new Promise<net.Socket>((resolve, reject) => {
        const s = new net.Socket();
        s.setTimeout(timeoutMs);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
        s.once('timeout', () => reject(new Error('ETIMEDOUT')));
        s.connect(params.port, params.resolvedIp);
      });
    }

    const greet = await readFtpResponse(activeSocket, timeoutMs);
    if (greet.code !== 220) {
      activeSocket.destroy();
      return {
        protocol: 'ftps',
        port: params.port,
        priority: 4,
        label: 'FTP / FTPS',
        role: 'file_access',
        useTls: implicit,
        tcpOpen: true,
        protocolVerified: false,
        authVerified: false,
        authAttempted: false,
        latencyMs: Math.max(1, Date.now() - started),
        errorCode: `FTP_UNEXPECTED_${greet.code}`,
        message: `Port ${params.port} lieferte unerwartete FTP-Antwort (${greet.code}).`,
      };
    }

    let tlsActive = implicit;
    if (!implicit) {
      activeSocket.write('AUTH TLS\r\n');
      const authTlsResp = await readFtpResponse(activeSocket, 2200).catch(() => null);
      if (authTlsResp && authTlsResp.code === 234) {
        const plainSock = activeSocket as net.Socket;
        activeSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const upgraded = tls.connect(
            {
              socket: plainSock,
              servername: net.isIP(params.hostname) === 0 ? params.hostname : undefined,
              rejectUnauthorized: !params.allowLocalSelfSignedTls && !params.isLan,
              ca: params.customCaPem ? [params.customCaPem] : undefined,
            },
            () => resolve(upgraded)
          );
          upgraded.once('error', reject);
        });
        tlsActive = true;
      } else if (!params.isLan && params.scope !== 'vpn' && hasCreds) {
        activeSocket.destroy();
        return {
          protocol: 'ftps',
          port: params.port,
          priority: 4,
          label: 'FTP / FTPS',
          role: 'file_access',
          useTls: false,
          tcpOpen: true,
          protocolVerified: true,
          authVerified: false,
          authAttempted: false,
          blockedByVpnPolicy: true,
          latencyMs: Math.max(1, Date.now() - started),
          errorCode: 'FTP_PLAINTEXT_INTERNET_BLOCKED',
          message:
            'Unverschlüsseltes FTP über das öffentliche Internet blockiert (Server lehnte AUTH TLS ab). Nutze FTPS oder VPN.',
        };
      }
    }

    let authVerified = false;
    let authError: string | null = null;
    if (hasCreds) {
      activeSocket.write(`USER ${params.username!.trim()}\r\n`);
      const uResp = await readFtpResponse(activeSocket, timeoutMs);
      if (uResp.code === 230) {
        authVerified = true;
      } else if (uResp.code === 331) {
        activeSocket.write(`PASS ${params.password ?? ''}\r\n`);
        const pResp = await readFtpResponse(activeSocket, timeoutMs);
        if (pResp.code === 230) {
          authVerified = true;
        } else {
          authError = `FTP/FTPS-Anmeldung abgelehnt (Code ${pResp.code}). Zugangsdaten prüfen.`;
        }
      } else {
        authError = `FTP/FTPS-Benutzer abgelehnt (Code ${uResp.code}).`;
      }
    }

    try {
      activeSocket.write('QUIT\r\n');
    } catch {
      // ignore
    }
    activeSocket.destroy();

    return {
      protocol: 'ftps',
      port: params.port,
      priority: 4,
      label: tlsActive ? 'FTPS (TLS)' : 'FTP',
      role: 'file_access',
      useTls: tlsActive,
      tcpOpen: true,
      protocolVerified: true,
      authVerified,
      authAttempted: hasCreds,
      serverBanner: greet.text.slice(0, 120),
      latencyMs: Math.max(1, Date.now() - started),
      errorCode: authError ? 'FTPS_AUTH_FAILED' : null,
      message: authError
        ? authError
        : `${tlsActive ? 'FTPS (TLS)' : 'FTP'} auf Port ${params.port} verifiziert${
            authVerified ? ' & Anmeldung OK' : ''
          }.`,
    };
  } catch (err) {
    activeSocket?.destroy();
    const msg = err instanceof Error ? err.message : 'FTP/FTPS nicht erreichbar';
    return {
      protocol: 'ftps',
      port: params.port,
      priority: 4,
      label: 'FTP / FTPS',
      role: 'file_access',
      useTls: implicit,
      tcpOpen: false,
      protocolVerified: false,
      authVerified: false,
      authAttempted: hasCreds,
      latencyMs: null,
      errorCode: 'FTPS_UNREACHABLE',
      message: `FTP/FTPS-Port ${params.port} auf ${params.hostname} nicht erreichbar (${msg}).`,
    };
  }
}

// ---------------------------------------------------------------------------
// Vendor API Detection Registry (AVM, Synology, QNAP, WD, TrueNAS, OMV, Unraid)
// ---------------------------------------------------------------------------
export interface VendorDetectionResult {
  vendor: NasVendorId;
  vendorLabel: string;
  apiResult: NasProtocolVerificationResult | null;
  entenCenterDetected: boolean;
  availableShares: string[];
}

export async function probeVendorApis(params: {
  hostname: string;
  resolvedIp: string;
  customPort?: number | null;
  username?: string;
  password?: string;
  useTls?: boolean;
  allowLocalSelfSignedTls: boolean;
  customCaPem?: string | null;
}): Promise<VendorDetectionResult> {
  const started = Date.now();
  const availShares: string[] = [];

  // 1. Optional EntenCenter Backend prüfen (NIE Pflicht!)
  let entenCenterDetected = false;
  const ecPorts = Array.from(
    new Set([params.customPort || 0, 3000, 3001].filter((p) => p > 0))
  );
  await Promise.all(
    ecPorts.map(async (p) => {
      for (const sch of params.useTls === false ? ['http'] : ['http', 'https']) {
        const res = await requestWithLocalTlsPolicy(
          `${sch}://${params.hostname}:${p}/api/nas/auth/bootstrap`,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            timeoutMs: 1300,
            allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
            customCaPem: params.customCaPem,
          }
        ).catch(() => null);
        if (res && res.status >= 200 && res.status < 300) {
          try {
            const parsed = JSON.parse(res.body) as { hasUsers?: unknown };
            if (typeof parsed.hasUsers === 'boolean') {
              entenCenterDetected = true;
            }
          } catch {
            // Nicht EntenCenter
          }
        }
      }
    })
  );

  // 2. Parallele Hersteller-Signaturen (Synology, QNAP, WD, TrueNAS, OMV, Unraid)
  const checks = await Promise.all([
    // Synology DSM (:5001 HTTPS / :5000 HTTP)
    (async () => {
      for (const [sch, p] of [
        ['https', 5001],
        ['http', 5000],
      ] as const) {
        const r = await requestWithLocalTlsPolicy(
          `${sch}://${params.hostname}:${p}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`,
          {
            method: 'GET',
            timeoutMs: 1600,
            allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
            customCaPem: params.customCaPem,
          }
        ).catch(() => null);
        if (r && r.status === 200 && r.body.includes('SYNO.API.Auth')) {
          return {
            vendor: 'synology' as NasVendorId,
            port: p,
            useTls: sch === 'https',
            label: `Synology DSM (${sch.toUpperCase()})`,
            httpStatus: r.status,
          };
        }
      }
      return null;
    })(),

    // QNAP QTS / QuTS (:443 / :8080)
    (async () => {
      for (const [sch, p] of [
        ['https', 443],
        ['http', 8080],
      ] as const) {
        const r = await requestWithLocalTlsPolicy(
          `${sch}://${params.hostname}:${p}/cgi-bin/authLogin.cgi`,
          {
            method: 'GET',
            timeoutMs: 1600,
            allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
            customCaPem: params.customCaPem,
          }
        ).catch(() => null);
        if (
          r &&
          r.status === 200 &&
          (r.body.includes('<QDocRoot>') || r.body.toLowerCase().includes('qnap'))
        ) {
          return {
            vendor: 'qnap' as NasVendorId,
            port: p,
            useTls: sch === 'https',
            label: `QNAP QTS (${sch.toUpperCase()})`,
            httpStatus: r.status,
          };
        }
      }
      return null;
    })(),

    // Western Digital My Cloud (/api/2.1/rest/device_info oder /nas/v1/locale)
    (async () => {
      for (const [sch, p] of [
        ['https', 443],
        ['http', 80],
      ] as const) {
        const r = await requestWithLocalTlsPolicy(
          `${sch}://${params.hostname}:${p}/api/2.1/rest/device_info`,
          {
            method: 'GET',
            timeoutMs: 1500,
            allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
            customCaPem: params.customCaPem,
          }
        ).catch(() => null);
        if (
          r &&
          (r.status === 200 || r.status === 401) &&
          (r.body.toLowerCase().includes('mycloud') ||
            r.body.toLowerCase().includes('western digital') ||
            r.body.toLowerCase().includes('wdc'))
        ) {
          return {
            vendor: 'western_digital' as NasVendorId,
            port: p,
            useTls: sch === 'https',
            label: `WD My Cloud (${sch.toUpperCase()})`,
            httpStatus: r.status,
          };
        }
      }
      return null;
    })(),

    // TrueNAS API (/api/v2.0/system/info)
    (async () => {
      for (const [sch, p] of [
        ['https', 443],
        ['http', 80],
      ] as const) {
        const r = await requestWithLocalTlsPolicy(
          `${sch}://${params.hostname}:${p}/api/v2.0/system/info`,
          {
            method: 'GET',
            timeoutMs: 1500,
            allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
            customCaPem: params.customCaPem,
          }
        ).catch(() => null);
        if (
          r &&
          (r.status === 200 || r.status === 401) &&
          (r.body.toLowerCase().includes('truenas') ||
            (r.headers['www-authenticate'] || '').toLowerCase().includes('truenas'))
        ) {
          return {
            vendor: 'truenas' as NasVendorId,
            port: p,
            useTls: sch === 'https',
            label: `TrueNAS API (${sch.toUpperCase()})`,
            httpStatus: r.status,
          };
        }
      }
      return null;
    })(),

    // AVM FRITZ!Box (/login_sid.lua)
    (async () => {
      const probe = await FritzBoxSessionClient.probeLoginSid(
        params.hostname,
        params.allowLocalSelfSignedTls,
        params.customCaPem,
        1300
      ).catch(() => null);
      if (probe?.detected) {
        return {
          vendor: 'avm_fritzbox' as NasVendorId,
          port: probe.httpsAvailable && params.useTls !== false ? 443 : 80,
          useTls: Boolean(probe.httpsAvailable && params.useTls !== false),
          label: probe.friendlyName || 'AVM FRITZ!Box Web/SID',
          httpStatus: 200,
        };
      }
      return null;
    })(),
  ]);

  const hit = checks.find((c) => c !== null) ?? null;
  if (hit && hit.vendor === 'avm_fritzbox') {
    availShares.push('/FRITZ.NAS');
  }

  const vendor: NasVendorId = hit?.vendor ?? (entenCenterDetected ? 'entencenter' : 'standard_nas');
  const apiResult: NasProtocolVerificationResult | null = hit
    ? {
        protocol: 'api_token',
        port: hit.port,
        priority: 5,
        label: hit.label,
        role: 'vendor_api',
        useTls: hit.useTls,
        tcpOpen: true,
        protocolVerified: true,
        authVerified: false,
        authAttempted: false,
        httpStatus: hit.httpStatus,
        latencyMs: Math.max(1, Date.now() - started),
        message: `${getVendorLabel(vendor)} über Herstellerschnittstelle (: ${hit.port}) erkannt.`,
      }
    : null;

  return {
    vendor,
    vendorLabel: getVendorLabel(vendor),
    apiResult,
    entenCenterDetected,
    availableShares: availShares,
  };
}

// ---------------------------------------------------------------------------
// Separated FRITZ!Box Track Evaluator (WebUI SID != SMB != TR-064 != UPnP)
// ---------------------------------------------------------------------------
export async function evaluateFritzSeparatedTracks(params: {
  hostname: string;
  resolvedIp: string;
  isLan: boolean;
  scope: NasConnectionScope;
  username?: string;
  password?: string;
  shareOrPath?: string;
  useTls?: boolean;
  allowLocalSelfSignedTls: boolean;
  customCaPem?: string | null;
  smbResult?: NasProtocolVerificationResult;
}): Promise<FritzTrackStatus | null> {
  const probe = await FritzBoxSessionClient.probeLoginSid(
    params.hostname,
    params.allowLocalSelfSignedTls,
    params.customCaPem,
    1400
  ).catch(() => null);

  if (!probe?.detected && !params.hostname.toLowerCase().includes('fritz')) {
    return null;
  }

  const hasPassword = (params.password ?? '').length > 0;
  let webuiAuth = false;
  let webuiScheme: 'http' | 'https' =
    params.useTls && probe?.httpsAvailable ? 'https' : probe?.httpAvailable ? 'http' : 'https';
  let webuiPort = webuiScheme === 'https' ? 443 : 80;
  let challengeVersion: 'md5_v1' | 'pbkdf2_v2' | null = null;
  let rights: string[] = [];
  let webuiError: string | null = null;
  let tr064Reachable = Boolean(probe?.tr064Available);
  let tr064Name = probe?.friendlyName ?? null;

  if (probe?.detected) {
    if (hasPassword || !probe.requiresAuth) {
      const client = new FritzBoxSessionClient({
        host: params.hostname,
        port: webuiPort,
        useTls: webuiScheme === 'https',
        username: params.username?.trim() || '',
        password: params.password ?? '',
        allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
        customCaPem: params.customCaPem,
      });
      const sess = await client.getValidSession(true).catch(() => null);
      if (sess?.ok) {
        webuiAuth = true;
        challengeVersion = sess.challengeVersion ?? null;
        rights = sess.rights ?? [];
        if (sess.effectiveScheme) webuiScheme = sess.effectiveScheme;
        if (sess.effectivePort) webuiPort = sess.effectivePort;
      } else {
        webuiError = sess?.error || 'FRITZ!Box Web-Anmeldung (SID) fehlgeschlagen.';
      }
      if (!tr064Reachable) {
        const tr = await client.fetchTr064DeviceInfo().catch(() => null);
        if (tr?.friendlyName) {
          tr064Reachable = true;
          tr064Name = tr.friendlyName;
        }
      }
    }
  }

  // UPnP/DLNA MediaServer prüfen (streng als media_only!)
  const upnpCheck = await requestWithLocalTlsPolicy(
    `http://${params.hostname}:49000/MediaServerDevDesc.xml`,
    {
      method: 'GET',
      timeoutMs: 1200,
      allowLocalSelfSignedTls: true,
    }
  ).catch(() => null);
  const upnpReachable = Boolean(
    upnpCheck && upnpCheck.status >= 200 && upnpCheck.status < 300 && upnpCheck.body.includes('MediaServer')
  );

  // SMB-Track prüfen (getrennt vom WebUI-SID!)
  const smbRes =
    params.smbResult ??
    (await probeSmb23Protocol({
      hostname: params.hostname,
      resolvedIp: params.resolvedIp,
      port: 445,
      isLan: params.isLan,
      scope: params.scope,
      username: params.username,
      password: params.password,
      shareOrPath: params.shareOrPath || '/FRITZ.NAS',
      timeoutMs: 3200,
    }));

  const smbPermissionHint =
    !smbRes.authVerified && webuiAuth
      ? 'FRITZ!Box-Benutzer benötigt in der FRITZ!Box unter System -> FRITZ!Box-Benutzer das Recht „Zugang zu NAS-Inhalten“ sowie aktiviertes SMBv2/SMBv3 (FRITZ!OS >= 7.20).'
      : smbRes.smb1Rejected
        ? 'FRITZ!OS nutzt veraltetes SMB 1. Bitte FRITZ!OS aktualisieren oder SMBv2/v3 aktivieren.'
        : null;

  const mismatchWarning =
    webuiAuth && !smbRes.authVerified
      ? 'WebUI Challenge-Response (SID) erfolgreich, aber direkter SMB-Dateizugriff (:445) fehlgeschlagen. WebUI-Login ersetzt keine SMB-Dateifreigabe.'
      : null;

  return {
    detected: Boolean(probe?.detected || upnpReachable || smbRes.protocolVerified),
    friendlyName: tr064Name || probe?.friendlyName || 'AVM FRITZ!Box',
    modelName: probe?.modelName ?? null,
    webuiSid: {
      reachable: Boolean(probe?.detected),
      authenticated: webuiAuth,
      scheme: webuiScheme,
      port: webuiPort,
      challengeVersion,
      rights,
      httpsError: probe?.httpsError ?? null,
      error: webuiError,
    },
    smbAccess: {
      reachable: smbRes.tcpOpen,
      protocolVerified: smbRes.protocolVerified,
      authVerified: smbRes.authVerified,
      shareVerified: Boolean(smbRes.shareVerified),
      dialect: smbRes.smbDialect ?? null,
      smb1Rejected: smbRes.smb1Rejected,
      shareName: extractShareName(params.shareOrPath || '/FRITZ.NAS') || 'FRITZ.NAS',
      error: smbRes.authVerified ? null : smbRes.message,
      permissionHint: smbPermissionHint,
    },
    tr064: {
      reachable: tr064Reachable,
      port: 49000,
      useTls: false,
      friendlyName: tr064Name,
    },
    upnpMediaOnly: {
      reachable: upnpReachable,
      port: 49000,
      mediaOnlyNote: 'UPnP/DLNA dient ausschließlich zur Medienwiedergabe, nicht für direkten SMB-Dateizugriff.',
    },
    mismatchWarning,
  };
}

// ---------------------------------------------------------------------------
// Priority Orchestrator: 1. SMB2/3 -> 2. WebDAV -> 3. SFTP -> 4. FTP/FTPS -> 5. Vendor API -> 6. UPnP (media_only)
// ---------------------------------------------------------------------------
export async function runUniversalNasProbe(
  options: UniversalProbeOptions
): Promise<UniversalNasProbeResponse> {
  const started = Date.now();
  const parsed = cleanHostInput(options.host);
  const hostname = parsed.hostname || options.host.trim();
  const explicitPort = options.port ? Number(options.port) : parsed.port;
  const scope: NasConnectionScope =
    options.scope ??
    (isLocalLanTargetStrict(hostname, null) ? 'lan' : 'internet');
  const allowLocalSelfSignedTls = options.allowLocalSelfSignedTls ?? true;

  if (!hostname) {
    return {
      ok: false,
      host: '',
      resolvedIp: null,
      isLan: false,
      scope,
      vpnRequiredForSmb: false,
      detectedVendor: 'standard_nas',
      vendorLabel: getVendorLabel('standard_nas'),
      entenCenterDetected: false,
      recommendedProtocol: null,
      recommendedPort: null,
      resultsByPriority: [],
      userFriendlySummary: 'Bitte eine gültige NAS-Adresse (IP oder Hostname) eingeben.',
      errors: ['Kein NAS-Hostname angegeben.'],
      measuredAt: new Date().toISOString(),
      durationMs: 1,
      executedOn: 'server',
    };
  }

  const dnsRes = await resolveHostIp(hostname);
  if (!dnsRes.ok || !dnsRes.ip) {
    return {
      ok: false,
      host: hostname,
      resolvedIp: null,
      isLan: isLocalLanTargetStrict(hostname, null),
      scope,
      vpnRequiredForSmb: false,
      detectedVendor: 'standard_nas',
      vendorLabel: getVendorLabel('standard_nas'),
      entenCenterDetected: false,
      recommendedProtocol: null,
      recommendedPort: null,
      resultsByPriority: [],
      userFriendlySummary: `DNS-Auflösung für „${hostname}“ fehlgeschlagen (${dnsRes.error || 'unbekannt'}).`,
      errors: [`DNS-Fehler für ${hostname}: ${dnsRes.error || 'Host nicht gefunden'}`],
      measuredAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - started),
      executedOn: 'server',
    };
  }

  const resolvedIp = dnsRes.ip;
  const isLan = isLocalLanTargetStrict(hostname, resolvedIp);
  const effectiveScope: NasConnectionScope =
    options.scope ?? (isLan ? 'lan' : 'internet');

  // Parallele Prüfung in strikter Priorität (ohne Port 3000 als Pflicht!)
  const smbPort =
    options.protocol === 'smb' && explicitPort ? sanitizeSmbPort(explicitPort) : 445;
  const webdavPort =
    options.protocol === 'webdav' && explicitPort
      ? explicitPort
      : options.useTls === false
        ? 5005
        : 5006;
  const webdavTls =
    options.protocol === 'webdav'
      ? (options.useTls ?? (webdavPort !== 5005 && webdavPort !== 80))
      : true;
  const sftpPort =
    options.protocol === 'sftp' && explicitPort ? explicitPort : 22;
  const ftpsPort =
    options.protocol === 'ftps' && explicitPort
      ? explicitPort
      : options.ftpsTlsMode === 'implicit'
        ? 990
        : 21;

  const [smbRes, webdavHttpsRes, webdav443Res, sftpRes, ftpsRes, vendorRes, upnpMediaRes] =
    await Promise.all([
      probeSmb23Protocol({
        hostname,
        resolvedIp,
        port: smbPort,
        isLan,
        scope: effectiveScope,
        username: options.username,
        password: options.password,
        domainOrWorkgroup: options.domainOrWorkgroup,
        shareOrPath: options.shareOrPath,
      }),
      probeWebDavProtocol({
        hostname,
        port: webdavPort,
        useTls: webdavTls,
        shareOrPath: options.shareOrPath || '/',
        username: options.username,
        password: options.password,
        allowLocalSelfSignedTls,
        customCaPem: options.customCaPem,
      }),
      webdavPort !== 443
        ? probeWebDavProtocol({
            hostname,
            port: 443,
            useTls: true,
            shareOrPath: options.shareOrPath || '/remote.php/dav',
            username: options.username,
            password: options.password,
            allowLocalSelfSignedTls,
            customCaPem: options.customCaPem,
          })
        : Promise.resolve(null),
      probeSftpProtocol({ hostname, resolvedIp, port: sftpPort }),
      probeFtpsProtocol({
        hostname,
        resolvedIp,
        port: ftpsPort,
        isLan,
        scope: effectiveScope,
        ftpsTlsMode: options.ftpsTlsMode,
        username: options.username,
        password: options.password,
        allowLocalSelfSignedTls,
        customCaPem: options.customCaPem,
      }),
      probeVendorApis({
        hostname,
        resolvedIp,
        customPort: explicitPort,
        username: options.username,
        password: options.password,
        useTls: options.useTls,
        allowLocalSelfSignedTls,
        customCaPem: options.customCaPem,
      }),
      // UPnP/DLNA ausschließlich als Media-Server prüfen (Priorität 6, media_only!)
      (async (): Promise<NasProtocolVerificationResult> => {
        const t0 = Date.now();
        const r = await requestWithLocalTlsPolicy(
          `http://${hostname}:49000/MediaServerDevDesc.xml`,
          { method: 'GET', timeoutMs: 1300, allowLocalSelfSignedTls: true }
        ).catch(() => null);
        const verified = Boolean(
          r && r.status >= 200 && r.status < 300 && r.body.includes('MediaServer')
        );
        return {
          protocol: 'fritz_upnp',
          port: 49000,
          priority: 6,
          label: 'UPnP / DLNA (Nur Medien)',
          role: 'media_only',
          useTls: false,
          tcpOpen: Boolean(r),
          protocolVerified: verified,
          authVerified: false,
          authAttempted: false,
          latencyMs: verified ? Math.max(1, Date.now() - t0) : null,
          errorCode: verified ? null : 'UPNP_UNAVAILABLE',
          message: verified
            ? 'UPnP/DLNA MediaServer erkannt (ausschließlich für Medienwiedergabe, kein direkter SMB-Dateizugriff).'
            : 'Kein UPnP/DLNA MediaServer auf Port 49000 aktiv.',
        };
      })(),
    ]);

  const effectiveWebDav = webdavHttpsRes.protocolVerified
    ? webdavHttpsRes
    : webdav443Res?.protocolVerified
      ? webdav443Res
      : webdavHttpsRes;

  const fritzTracks =
    vendorRes.vendor === 'avm_fritzbox' ||
    hostname.toLowerCase().includes('fritz')
      ? await evaluateFritzSeparatedTracks({
          hostname,
          resolvedIp,
          isLan,
          scope: effectiveScope,
          username: options.username,
          password: options.password,
          shareOrPath: options.shareOrPath,
          useTls: options.useTls,
          allowLocalSelfSignedTls,
          customCaPem: options.customCaPem,
          smbResult: smbRes,
        })
      : null;

  const resultsByPriority: NasProtocolVerificationResult[] = [
    smbRes,
    effectiveWebDav,
    sftpRes,
    ftpsRes,
    ...(vendorRes.apiResult ? [vendorRes.apiResult] : []),
    upnpMediaRes,
  ].sort((a, b) => a.priority - b.priority);

  // Bestes verifiziertes Datei-Protokoll gemäß Priorität wählen (UPnP niemals als Dateiersatz bevorzugen, außer nichts anderes geht)
  const fileProtocols = resultsByPriority.filter(
    (r) => r.role === 'file_access' && r.protocolVerified && !r.smb1Rejected && !r.blockedByVpnPolicy
  );
  const authedFile = fileProtocols.find((r) => r.authVerified);
  const bestCandidate =
    authedFile ??
    fileProtocols[0] ??
    resultsByPriority.find((r) => r.protocolVerified && !r.blockedByVpnPolicy) ??
    null;

  const errors: string[] = [];
  if (smbRes.smb1Rejected) errors.push(smbRes.message);
  if (smbRes.blockedByVpnPolicy) errors.push(smbRes.message);
  if (fritzTracks?.mismatchWarning) errors.push(fritzTracks.mismatchWarning);
  for (const r of resultsByPriority) {
    if (r.authAttempted && !r.authVerified && r.protocolVerified && r.errorCode) {
      errors.push(r.message);
    }
  }

  const ok = Boolean(bestCandidate && (!options.username || bestCandidate.authVerified || bestCandidate.protocol === 'sftp'));
  const summaryParts: string[] = [];
  if (bestCandidate) {
    summaryParts.push(
      `${vendorRes.vendorLabel} unter ${hostname} (${resolvedIp}): Empfohlenes Protokoll ${bestCandidate.label} (Port ${bestCandidate.port})`
    );
  } else {
    summaryParts.push(
      `Kein verifiziertes NAS-Dateiprotokoll auf ${hostname} (${resolvedIp}) aktiv`
    );
  }
  if (!isLan && effectiveScope !== 'vpn') {
    summaryParts.push('Hinweis: Externes SMB ist ohne VPN gesperrt');
  }
  if (fritzTracks?.mismatchWarning) {
    summaryParts.push('FRITZ!Box: WebUI-SID aktiv, aber SMB (:445) prüfen');
  }

  return {
    ok: Boolean(bestCandidate),
    host: hostname,
    resolvedIp,
    isLan,
    scope: effectiveScope,
    vpnRequiredForSmb: !isLan && effectiveScope !== 'vpn',
    detectedVendor: vendorRes.vendor,
    vendorLabel: vendorRes.vendorLabel,
    entenCenterDetected: vendorRes.entenCenterDetected,
    recommendedProtocol: bestCandidate?.protocol ?? null,
    recommendedPort: bestCandidate?.port ?? null,
    resultsByPriority,
    fritzTracks,
    availableShares: vendorRes.availableShares,
    userFriendlySummary: summaryParts.join(' · '),
    errors: errors.length > 0 ? errors : ok ? [] : ['Kein unterstütztes NAS-Protokoll antwortet funktionsfähig.'],
    measuredAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - started),
    executedOn: 'server',
  };
}

export async function testSingleUniversalProtocol(
  options: UniversalProbeOptions & { protocol: NasProtocolId }
): Promise<NasProtocolVerificationResult & { resolvedIp: string | null; isLan: boolean; fritzTracks?: FritzTrackStatus | null }> {
  const parsed = cleanHostInput(options.host);
  const hostname = parsed.hostname || options.host.trim();
  const dnsRes = await resolveHostIp(hostname);
  if (!dnsRes.ok || !dnsRes.ip) {
    return {
      protocol: options.protocol,
      port: Number(options.port) || 445,
      priority: 1,
      label: options.protocol.toUpperCase(),
      role: options.protocol === 'fritz_upnp' ? 'media_only' : 'file_access',
      useTls: Boolean(options.useTls),
      tcpOpen: false,
      protocolVerified: false,
      authVerified: false,
      authAttempted: false,
      latencyMs: null,
      errorCode: 'DNS_FAILED',
      message: `DNS-Auflösung für „${hostname}“ fehlgeschlagen (${dnsRes.error || 'Host unbekannt'}).`,
      resolvedIp: null,
      isLan: isLocalLanTargetStrict(hostname, null),
    };
  }

  const resolvedIp = dnsRes.ip;
  const isLan = isLocalLanTargetStrict(hostname, resolvedIp);
  const scope: NasConnectionScope = options.scope ?? (isLan ? 'lan' : 'internet');
  const explicitPort = options.port ? Number(options.port) : parsed.port;
  const allowLocalSelfSignedTls = options.allowLocalSelfSignedTls ?? true;

  if (options.protocol === 'smb') {
    const res = await probeSmb23Protocol({
      hostname,
      resolvedIp,
      port: sanitizeSmbPort(explicitPort),
      isLan,
      scope,
      username: options.username,
      password: options.password,
      domainOrWorkgroup: options.domainOrWorkgroup,
      shareOrPath: options.shareOrPath,
      timeoutMs: options.timeoutMs,
    });
    return { ...res, resolvedIp, isLan };
  }

  if (options.protocol === 'webdav') {
    const useTls = options.useTls ?? parsed.explicitScheme !== 'http';
    const res = await probeWebDavProtocol({
      hostname,
      port: explicitPort || (useTls ? 5006 : 5005),
      useTls,
      shareOrPath: options.shareOrPath || '/',
      username: options.username,
      password: options.password,
      allowLocalSelfSignedTls,
      customCaPem: options.customCaPem,
      timeoutMs: options.timeoutMs,
    });
    return { ...res, resolvedIp, isLan };
  }

  if (options.protocol === 'sftp') {
    const res = await probeSftpProtocol({
      hostname,
      resolvedIp,
      port: explicitPort || 22,
      timeoutMs: options.timeoutMs,
    });
    return { ...res, resolvedIp, isLan };
  }

  if (options.protocol === 'ftps') {
    const res = await probeFtpsProtocol({
      hostname,
      resolvedIp,
      port: explicitPort || (options.ftpsTlsMode === 'implicit' ? 990 : 21),
      isLan,
      scope,
      ftpsTlsMode: options.ftpsTlsMode,
      username: options.username,
      password: options.password,
      allowLocalSelfSignedTls,
      customCaPem: options.customCaPem,
      timeoutMs: options.timeoutMs,
    });
    return { ...res, resolvedIp, isLan };
  }

  if (options.protocol === 'fritz_upnp') {
    const tracks = await evaluateFritzSeparatedTracks({
      hostname,
      resolvedIp,
      isLan,
      scope,
      username: options.username,
      password: options.password,
      shareOrPath: options.shareOrPath,
      useTls: options.useTls,
      allowLocalSelfSignedTls,
      customCaPem: options.customCaPem,
    });
    const mediaOk = Boolean(tracks?.upnpMediaOnly.reachable || tracks?.webuiSid.reachable);
    return {
      protocol: 'fritz_upnp',
      port: explicitPort || 49000,
      priority: 6,
      label: 'FRITZ!Box (UPnP / TR-064 / SID getrennt)',
      role: 'media_only',
      useTls: Boolean(tracks?.webuiSid.scheme === 'https'),
      tcpOpen: mediaOk,
      protocolVerified: mediaOk,
      authVerified: Boolean(tracks?.webuiSid.authenticated),
      authAttempted: Boolean((options.password ?? '').length > 0),
      latencyMs: 10,
      errorCode: mediaOk ? null : 'FRITZ_UNREACHABLE',
      warning: tracks?.mismatchWarning ?? tracks?.upnpMediaOnly.mediaOnlyNote ?? null,
      message: tracks?.mismatchWarning
        ? tracks.mismatchWarning
        : mediaOk
          ? `FRITZ!Box erkannt (${tracks?.webuiSid.authenticated ? 'WebUI SID aktiv' : 'WebUI erreichbar'} · UPnP nur für Medien${tracks?.smbAccess.authVerified ? ' · SMB Datei-Zugriff OK' : ''}).`
          : `FRITZ!Box unter ${hostname} nicht erreichbar.`,
      resolvedIp,
      isLan,
      fritzTracks: tracks,
    };
  }

  // api_token / nfs Fallback
  const vendor = await probeVendorApis({
    hostname,
    resolvedIp,
    customPort: explicitPort,
    username: options.username,
    password: options.password,
    useTls: options.useTls,
    allowLocalSelfSignedTls,
    customCaPem: options.customCaPem,
  });
  if (vendor.apiResult) {
    return { ...vendor.apiResult, resolvedIp, isLan };
  }
  return {
    protocol: options.protocol,
    port: explicitPort || (options.protocol === 'nfs' ? 2049 : 5001),
    priority: 5,
    label: options.protocol.toUpperCase(),
    role: 'vendor_api',
    useTls: Boolean(options.useTls),
    tcpOpen: false,
    protocolVerified: false,
    authVerified: false,
    authAttempted: false,
    latencyMs: null,
    errorCode: 'ENDPOINT_NOT_VERIFIED',
    message: `Kein gültiger ${options.protocol.toUpperCase()}-Endpunkt auf ${hostname}:${explicitPort || 5001} verifiziert.`,
    resolvedIp,
    isLan,
  };
}

// ---------------------------------------------------------------------------
// Storage-Bridge Health Check & Wake-on-LAN / FRITZ!NAS Sleep-Wake Engine
// ---------------------------------------------------------------------------
export interface BridgeNasHealthResult {
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

export interface NasWakeResult {
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

export function normalizeMacAddress(raw?: string | null): string | null {
  const hex = (raw ?? '').trim().replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  const parts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    parts.push(hex.slice(i * 2, i * 2 + 2).toUpperCase());
  }
  return parts.join(':');
}

export async function readArpMacForIp(ip?: string | null): Promise<string | null> {
  if (!ip) return null;
  try {
    const raw = await fs.promises.readFile('/proc/net/arp', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === ip) {
        const mac = cols[3] ?? '';
        if (mac && mac !== '00:00:00:00:00:00') {
          return normalizeMacAddress(mac);
        }
      }
    }
  } catch {
    // /proc/net/arp auf nicht-Linux-Systemen optional
  }
  return null;
}

function collectIpv4BroadcastTargets(targetIp?: string | null): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  if (targetIp && net.isIPv4(targetIp)) {
    targets.add(targetIp);
    const parts = targetIp.split('.');
    if (parts.length === 4) {
      targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
  }
  try {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.internal || addr.family !== 'IPv4' || !addr.netmask) continue;
        const ipParts = addr.address.split('.').map(Number);
        const maskParts = addr.netmask.split('.').map(Number);
        if (ipParts.length === 4 && maskParts.length === 4) {
          const bcast = ipParts.map((octet, idx) => (octet | (~maskParts[idx] & 0xff)) & 0xff);
          targets.add(bcast.join('.'));
        }
      }
    }
  } catch {
    // Netzwerk-Interfaces optional
  }
  return Array.from(targets);
}

export async function sendWakeOnLanMagicPackets(
  macAddress: string,
  targetIp?: string | null
): Promise<boolean> {
  const cleanMac = normalizeMacAddress(macAddress);
  if (!cleanMac) return false;
  const macBytes = Buffer.from(cleanMac.replace(/:/g, ''), 'hex');
  const magic = Buffer.alloc(6 + 16 * 6);
  magic.fill(0xff, 0, 6);
  for (let rep = 0; rep < 16; rep += 1) {
    macBytes.copy(magic, 6 + rep * 6);
  }

  const destinations = collectIpv4BroadcastTargets(targetIp);
  const socket = dgram.createSocket('udp4');
  let sentAny = false;

  try {
    await new Promise<void>((resolve) => {
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
        } catch {
          // Optional
        }
        resolve();
      });
      socket.once('error', () => resolve());
    });

    for (let burst = 0; burst < 3; burst += 1) {
      for (const dest of destinations) {
        for (const port of [9, 7]) {
          await new Promise<void>((resolve) => {
            try {
              socket.send(magic, 0, magic.length, port, dest, (err) => {
                if (!err) sentAny = true;
                resolve();
              });
            } catch {
              resolve();
            }
          });
        }
      }
      if (burst < 2) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  } finally {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  return sentAny;
}

async function testTcpQuickServer(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ open: boolean; latencyMs: number | null }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ open, latencyMs: open ? Math.max(1, Date.now() - started) : null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export async function probeBridgeNasHealthServer(options: {
  host: string;
  port?: number | string;
  scope?: NasConnectionScope;
  allowLocalSelfSignedTls?: boolean;
  customCaPem?: string | null;
}): Promise<BridgeNasHealthResult> {
  const started = Date.now();
  const parsed = cleanHostInput(options.host);
  const hostname = parsed.hostname || options.host.trim();
  const explicitPort = options.port ? Number(options.port) : parsed.port ?? 0;

  if (!hostname) {
    return {
      ok: false,
      status: 'offline',
      host: '',
      latencyMs: null,
      warning: 'Keine NAS-Adresse konfiguriert.',
    };
  }

  const dnsRes = await resolveHostIp(hostname);
  if (!dnsRes.ok || !dnsRes.ip) {
    return {
      ok: false,
      status: 'offline',
      host: hostname,
      latencyMs: null,
      warning: `DNS fehlgeschlagen: ${dnsRes.error || hostname}`,
    };
  }

  const resolvedIp = dnsRes.ip;
  const isLan = isLocalLanTargetStrict(hostname, resolvedIp);
  const scope: NasConnectionScope = options.scope ?? (isLan ? 'lan' : 'internet');
  if (!isLan && scope !== 'vpn') {
    return {
      ok: false,
      status: 'offline',
      host: hostname,
      resolvedIp,
      latencyMs: null,
      warning: 'Direkt-Bridge im öffentlichen Netz nur per VPN erlaubt.',
    };
  }

  const allowSelfSigned = options.allowLocalSelfSignedTls ?? true;
  const davPort = [5005, 5006, 8080, 443, 80].includes(explicitPort) ? explicitPort : 5006;
  const ecPort = [3000, 3001, 8080].includes(explicitPort) ? explicitPort : 3000;

  const [smbRes, ftpRes, davRes, ecReady, fritzProbe, discoveredMac] = await Promise.all([
    testTcpQuickServer(resolvedIp, 445, 1600),
    testTcpQuickServer(resolvedIp, 21, 1400),
    testTcpQuickServer(resolvedIp, davPort, 1400),
    (async (): Promise<boolean> => {
      const check = await testTcpQuickServer(resolvedIp, ecPort, 900);
      if (!check.open) return false;
      const r = await requestWithLocalTlsPolicy(
        `http://${resolvedIp}:${ecPort}/api/nas/auth/bootstrap`,
        { method: 'GET', timeoutMs: 1100, allowLocalSelfSignedTls: allowSelfSigned }
      ).catch(() => null);
      return Boolean(r && r.status >= 200 && r.status < 300 && r.body.includes('hasUsers'));
    })(),
    FritzBoxSessionClient.probeLoginSid(
      resolvedIp,
      allowSelfSigned,
      options.customCaPem ?? null,
      2400
    ).catch(() => null),
    readArpMacForIp(resolvedIp),
  ]);

  const fritzDetected = Boolean(fritzProbe?.detected);
  const fritzHttp = Boolean(fritzProbe?.httpAvailable);
  const fritzHttps = Boolean(fritzProbe?.httpsAvailable);
  const tr064 = Boolean(fritzProbe?.tr064Available);
  const isOnline = smbRes.open || fritzDetected || tr064 || ecReady || ftpRes.open || davRes.open;

  const latencies = [smbRes.latencyMs, ftpRes.latencyMs, davRes.latencyMs].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const latencyMs =
    latencies.length > 0
      ? Math.min(...latencies)
      : isOnline
        ? Math.max(1, Date.now() - started)
        : null;

  let transportLabel: string | null = null;
  if (ecReady) transportLabel = 'EntenCenter-Server (:3000)';
  else if (fritzDetected && smbRes.open) transportLabel = 'FRITZ!NAS Direkt (SMB :445 + Web)';
  else if (smbRes.open) transportLabel = 'SMB 2/3 Storage-Bridge (:445)';
  else if (fritzDetected) transportLabel = fritzHttp ? 'FRITZ!NAS Web (:80)' : 'FRITZ!NAS Web (:443)';
  else if (davRes.open) transportLabel = 'WebDAV Bridge';
  else if (ftpRes.open) transportLabel = 'FTP/FTPS Bridge (:21)';

  return {
    ok: isOnline,
    status: isOnline ? 'online' : 'sleeping',
    host: hostname,
    resolvedIp,
    latencyMs,
    smbOpen: smbRes.open,
    ftpOpen: ftpRes.open,
    fritzDetected,
    fritzHttpAvailable: fritzHttp,
    fritzHttpsAvailable: fritzHttps,
    tr064Available: tr064,
    entenCenterReady: ecReady,
    friendlyName: fritzProbe?.friendlyName ?? null,
    discoveredMac,
    transportLabel,
    warning: isOnline ? null : 'NAS antwortet nicht — möglicherweise im Ruhemodus / Standby.',
  };
}

export async function wakeNasDeviceServer(options: {
  host: string;
  username?: string;
  password?: string;
  macAddress?: string | null;
  useTls?: boolean;
  scope?: NasConnectionScope;
  allowLocalSelfSignedTls?: boolean;
  customCaPem?: string | null;
}): Promise<NasWakeResult> {
  const started = Date.now();
  const parsed = cleanHostInput(options.host);
  const hostname = parsed.hostname || options.host.trim() || 'fritz.box';
  const username = (options.username ?? '').trim();
  const password = options.password ?? '';
  const allowSelfSigned = options.allowLocalSelfSignedTls ?? true;

  const dnsRes = await resolveHostIp(hostname).catch(() => ({ ok: false, ip: null }));
  const resolvedIp = dnsRes.ip || hostname;
  const isLan = isLocalLanTargetStrict(hostname, resolvedIp);
  const scope: NasConnectionScope = options.scope ?? (isLan ? 'lan' : 'internet');

  if (!isLan && scope !== 'vpn') {
    return {
      ok: false,
      wokeUp: false,
      status: 'offline',
      host: hostname,
      resolvedIp,
      latencyMs: null,
      channelsTriggered: [],
      message:
        'Aufwecken (Wake-on-LAN / Storage-Wake) ist nur im Heimnetz (LAN) oder per VPN zulässig.',
    };
  }

  const channelsTriggered: string[] = [];
  const explicitMac = normalizeMacAddress(options.macAddress);
  const arpMac = await readArpMacForIp(resolvedIp);
  const effectiveMac = explicitMac ?? arpMac;

  if (effectiveMac) {
    const wolSent = await sendWakeOnLanMagicPackets(effectiveMac, resolvedIp).catch(() => false);
    if (wolSent) {
      channelsTriggered.push(`Wake-on-LAN Magic Packet (UDP :9/:7 · ${effectiveMac})`);
    }
  }

  const fritzProbe = await FritzBoxSessionClient.probeLoginSid(
    resolvedIp,
    allowSelfSigned,
    options.customCaPem ?? null,
    2400
  ).catch(() => null);

  let fritzWebReady = Boolean(fritzProbe?.detected);
  let smbSpinUpOk = false;

  if (fritzWebReady) {
    channelsTriggered.push('FRITZ!Box HTTP/TR-064 Signal');
    if (password.length > 0) {
      try {
        const fbClient = new FritzBoxSessionClient({
          host: hostname,
          port: options.useTls && fritzProbe?.httpsAvailable ? 443 : fritzProbe?.httpAvailable ? 80 : 443,
          useTls: Boolean(options.useTls && fritzProbe?.httpsAvailable) || !fritzProbe?.httpAvailable,
          username,
          password,
          allowLocalSelfSignedTls: allowSelfSigned,
          customCaPem: options.customCaPem ?? null,
        });
        const browseRes = await fbClient.browseFritzNasFiles('/');
        if (browseRes.ok) {
          fritzWebReady = true;
          channelsTriggered.push('FRITZ!NAS USB-Speicher Spin-Up');
        }
      } catch {
        // Optional
      }
    }

    if (effectiveMac && fritzProbe?.tr064Available) {
      const soap = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_AVM-DE_WakeOnLANByMACAddress xmlns:u="urn:dslforum-org:service:Hosts:1"><NewMACAddress>${effectiveMac}</NewMACAddress></u:X_AVM-DE_WakeOnLANByMACAddress></s:Body></s:Envelope>`;
      const trRes = await requestWithLocalTlsPolicy(`http://${resolvedIp}:49000/upnp/control/hosts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPACTION: '"urn:dslforum-org:service:Hosts:1#X_AVM-DE_WakeOnLANByMACAddress"',
        },
        body: soap,
        timeoutMs: 1800,
        allowLocalSelfSignedTls: true,
      }).catch(() => null);
      if (trRes && trRes.status >= 200 && trRes.status < 500) {
        channelsTriggered.push('FRITZ!Box TR-064 WakeOnLAN');
      }
    }
  }

  const smbQuick = await testTcpQuickServer(resolvedIp, 445, 2200);
  if (smbQuick.open || channelsTriggered.length > 0) {
    const smbProbe = await probeSmb23Protocol({
      hostname,
      resolvedIp,
      port: 445,
      isLan,
      scope: 'lan',
      username,
      password,
      shareOrPath: 'FRITZ.NAS',
      timeoutMs: 8500,
    }).catch(() => null);
    if (smbProbe?.protocolVerified) {
      smbSpinUpOk = true;
      channelsTriggered.push('SMB 2/3 Storage-Wake (:445)');
    }
  }

  let health = await probeBridgeNasHealthServer({
    host: hostname,
    scope,
    allowLocalSelfSignedTls: allowSelfSigned,
    customCaPem: options.customCaPem ?? null,
  });
  if (!health.ok && effectiveMac) {
    for (let i = 0; i < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await probeBridgeNasHealthServer({
        host: hostname,
        scope,
        allowLocalSelfSignedTls: allowSelfSigned,
        customCaPem: options.customCaPem ?? null,
      });
      if (health.ok) break;
    }
  }

  const isNowOnline = health.ok || smbSpinUpOk || fritzWebReady;
  const latencyMs = health.latencyMs ?? Math.max(1, Date.now() - started);
  const status: NasWakeResult['status'] = isNowOnline
    ? 'online'
    : channelsTriggered.length > 0
      ? 'waking'
      : 'offline';

  const message = isNowOnline
    ? `NAS / FRITZ!NAS aktiv & geweckt (${channelsTriggered.join(' · ') || 'Direktzugriff'} · ${latencyMs} ms).`
    : status === 'waking'
      ? `Wecksignal (${channelsTriggered.join(' · ')}) gesendet — Festplatte fährt hoch, bitte in wenigen Sekunden erneut prüfen.`
      : 'NAS konnte nicht automatisch geweckt werden. Für Wake-on-LAN aus komplettem Standby optional MAC-Adresse angeben.';

  return {
    ok: isNowOnline,
    wokeUp: isNowOnline,
    status,
    host: hostname,
    resolvedIp,
    latencyMs: isNowOnline ? latencyMs : null,
    discoveredMac: effectiveMac,
    smbReady: smbSpinUpOk || Boolean(health.smbOpen),
    fritzWebReady,
    entenCenterReady: Boolean(health.entenCenterReady),
    transportLabel: health.transportLabel ?? null,
    channelsTriggered,
    message,
  };
}
