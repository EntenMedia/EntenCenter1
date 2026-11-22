import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import type { Request } from 'express';
import { requestWithLocalTlsPolicy } from './localTlsFetch.ts';
import { probeSftpProtocol, probeSmb23Protocol } from './nasProtocolProber.ts';
import type {
  DiscoveredNasDevice,
  DiscoveredNasService,
  NasProtocolId,
  NetworkDiscoveryMethod,
  NetworkNasDiscoveryResponse,
} from '../types/marcente.ts';

export const MDNS_MULTICAST_ADDR = '224.0.0.251';
export const MDNS_PORT = 5353;
export const SSDP_MULTICAST_ADDR = '239.255.255.250';
export const SSDP_PORT = 1900;

export const MDNS_SERVICE_QUERIES = [
  '_services._dns-sd._udp.local',
  '_entencenter._tcp.local',
  '_smb._tcp.local',
  '_nfs._tcp.local',
  '_webdav._tcp.local',
  '_webdavs._tcp.local',
  '_sftp-ssh._tcp.local',
  '_ssh._tcp.local',
  '_ftp._tcp.local',
  '_afpovertcp._tcp.local',
  '_http._tcp.local',
  '_https._tcp.local',
  '_device-info._tcp.local',
];

const KNOWN_LOCAL_NAS_HOSTNAMES = [
  'entencenter.local',
  'diskstation.local',
  'synology.local',
  'qnap.local',
  'truenas.local',
  'freenas.local',
  'unraid.local',
  'tower.local',
  'openmediavault.local',
  'omv.local',
  'mycloud.local',
  'wdmycloud.local',
  'nas.local',
  'fritz.nas',
  'fritz.box',
];

interface DnsQuestionSpec {
  name: string;
  qtype: number;
  qclass?: number;
}

export interface ParsedDnsRecord {
  name: string;
  type: number;
  rtype: 'A' | 'PTR' | 'TXT' | 'SRV' | 'AAAA' | 'OTHER';
  ttl: number;
  data: {
    ip?: string;
    target?: string;
    port?: number;
    priority?: number;
    weight?: number;
    txt?: Record<string, string>;
    txtValues?: string[];
  };
}

export interface ParsedMdnsPacket {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: Array<{ name: string; qtype: number; qclass: number }>;
  answers: ParsedDnsRecord[];
}

export function encodeDnsName(name: string): Buffer {
  const clean = name.trim().replace(/\.+$/, '');
  if (!clean) return Buffer.from([0]);
  const parts = clean.split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const label of parts) {
    const labelBuf = Buffer.from(label, 'utf8');
    const len = Math.min(labelBuf.length, 63);
    chunks.push(Buffer.from([len]), labelBuf.subarray(0, len));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function decodeDnsName(
  buf: Buffer,
  startOffset: number
): { name: string; nextOffset: number } {
  const labels: string[] = [];
  let offset = startOffset;
  let nextOffset = -1;
  const visited = new Set<number>();
  let steps = 0;

  while (offset < buf.length && steps < 128) {
    steps += 1;
    if (visited.has(offset)) break;
    visited.add(offset);

    const len = buf[offset];
    if (len === undefined) break;

    if (len === 0) {
      if (nextOffset === -1) nextOffset = offset + 1;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) break;
      const pointer = ((len & 0x3f) << 8) | buf[offset + 1];
      if (nextOffset === -1) nextOffset = offset + 2;
      offset = pointer;
      continue;
    }

    const labelStart = offset + 1;
    const labelEnd = Math.min(labelStart + len, buf.length);
    labels.push(buf.subarray(labelStart, labelEnd).toString('utf8'));
    offset = labelEnd;
  }

  return {
    name: labels.join('.'),
    nextOffset: nextOffset === -1 ? Math.min(offset + 1, buf.length) : nextOffset,
  };
}

export function encodeMdnsQueryPacket(questions: DnsQuestionSpec[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // Transaction ID = 0 for mDNS
  header.writeUInt16BE(0x0000, 2); // Standard Query
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const qBuffers = questions.map((q) => {
    const nameBuf = encodeDnsName(q.name);
    const meta = Buffer.alloc(4);
    meta.writeUInt16BE(q.qtype, 0);
    meta.writeUInt16BE(q.qclass ?? 0x0001, 2); // IN (QU bit clear for shared multicast response)
    return Buffer.concat([nameBuf, meta]);
  });

  return Buffer.concat([header, ...qBuffers]);
}

function parseTxtRecord(buf: Buffer, start: number, rdlength: number): {
  txt: Record<string, string>;
  txtValues: string[];
} {
  const txt: Record<string, string> = {};
  const txtValues: string[] = [];
  let cursor = start;
  const end = Math.min(start + rdlength, buf.length);

  while (cursor < end) {
    const strLen = buf[cursor];
    cursor += 1;
    if (strLen === undefined || strLen === 0) continue;
    const strEnd = Math.min(cursor + strLen, end);
    const entry = buf.subarray(cursor, strEnd).toString('utf8');
    cursor = strEnd;
    if (!entry) continue;
    txtValues.push(entry);
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      const k = entry.slice(0, eqIdx).trim();
      const v = entry.slice(eqIdx + 1).trim();
      txt[k] = v;
    } else {
      txt[entry] = 'true';
    }
  }

  return { txt, txtValues };
}

export function decodeMdnsResponsePacket(buf: Buffer): ParsedMdnsPacket | null {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let offset = 12;
  const questions: Array<{ name: string; qtype: number; qclass: number }> = [];

  for (let i = 0; i < qdCount && offset < buf.length; i += 1) {
    const decoded = decodeDnsName(buf, offset);
    offset = decoded.nextOffset;
    if (offset + 4 > buf.length) break;
    const qtype = buf.readUInt16BE(offset);
    const qclass = buf.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({ name: decoded.name, qtype, qclass });
  }

  const totalRRs = anCount + nsCount + arCount;
  const answers: ParsedDnsRecord[] = [];

  for (let i = 0; i < totalRRs && offset < buf.length; i += 1) {
    const decoded = decodeDnsName(buf, offset);
    offset = decoded.nextOffset;
    if (offset + 10 > buf.length) break;

    const type = buf.readUInt16BE(offset);
    // const rclass = buf.readUInt16BE(offset + 2);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlength = buf.readUInt16BE(offset + 8);
    offset += 10;

    if (offset + rdlength > buf.length) break;
    const rdataStart = offset;

    if (type === 1 && rdlength === 4) {
      // A record
      const ip = `${buf[rdataStart]}.${buf[rdataStart + 1]}.${buf[rdataStart + 2]}.${buf[rdataStart + 3]}`;
      answers.push({
        name: decoded.name,
        type,
        rtype: 'A',
        ttl,
        data: { ip },
      });
    } else if (type === 12) {
      // PTR record
      const ptr = decodeDnsName(buf, rdataStart);
      answers.push({
        name: decoded.name,
        type,
        rtype: 'PTR',
        ttl,
        data: { target: ptr.name },
      });
    } else if (type === 16) {
      // TXT record
      const { txt, txtValues } = parseTxtRecord(buf, rdataStart, rdlength);
      answers.push({
        name: decoded.name,
        type,
        rtype: 'TXT',
        ttl,
        data: { txt, txtValues },
      });
    } else if (type === 33 && rdlength >= 6) {
      // SRV record
      const priority = buf.readUInt16BE(rdataStart);
      const weight = buf.readUInt16BE(rdataStart + 2);
      const port = buf.readUInt16BE(rdataStart + 4);
      const srvTarget = decodeDnsName(buf, rdataStart + 6);
      answers.push({
        name: decoded.name,
        type,
        rtype: 'SRV',
        ttl,
        data: { priority, weight, port, target: srvTarget.name },
      });
    } else if (type === 28 && rdlength === 16) {
      const groups: string[] = [];
      for (let g = 0; g < 16; g += 2) {
        groups.push(buf.readUInt16BE(rdataStart + g).toString(16));
      }
      answers.push({
        name: decoded.name,
        type,
        rtype: 'AAAA',
        ttl,
        data: { ip: groups.join(':') },
      });
    }

    offset += rdlength;
  }

  return {
    id,
    flags,
    isResponse: Boolean(flags & 0x8000),
    questions,
    answers,
  };
}

function encodeDnsRecordHeader(name: string, type: number, ttl: number, rdata: Buffer): Buffer {
  const nameBuf = encodeDnsName(name);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(0x8001, 2); // Class IN + cache-flush
  meta.writeUInt32BE(ttl, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, meta, rdata]);
}

function encodeTxtRdata(entries: string[]): Buffer {
  const chunks = entries.map((e) => {
    const b = Buffer.from(e, 'utf8');
    const len = Math.min(b.length, 255);
    return Buffer.concat([Buffer.from([len]), b.subarray(0, len)]);
  });
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from([0]);
}

function encodeSrvRdata(port: number, targetHost: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeDnsName(targetHost)]);
}

function encodeIpv4Rdata(ip: string): Buffer | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return Buffer.from(parts);
}

interface LocalSubnetInterface {
  ip: string;
  netmask: string;
  cidr: string;
  networkInt: number;
  maskInt: number;
  isPrivateLan: boolean;
}

function parseIpv4Int(ip: string): number | null {
  const clean = ip.trim().replace(/^::ffff:/i, '');
  const parts = clean.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    value = ((value << 8) | num) >>> 0;
  }
  return value;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function isPrivateLanIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

export function getLocalLanSubnets(): LocalSubnetInterface[] {
  const ifaces = os.networkInterfaces();
  const result: LocalSubnetInterface[] = [];
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ipInt = parseIpv4Int(entry.address);
      const maskInt = parseIpv4Int(entry.netmask);
      if (ipInt === null || maskInt === null) continue;
      let prefixLen = 0;
      let m = maskInt;
      while (m !== 0) {
        prefixLen += m & 1;
        m >>>= 1;
      }
      const networkInt = (ipInt & maskInt) >>> 0;
      result.push({
        ip: entry.address,
        netmask: entry.netmask,
        cidr: `${intToIpv4(networkInt)}/${prefixLen}`,
        networkInt,
        maskInt,
        isPrivateLan: isPrivateLanIpv4(entry.address),
      });
    }
  }
  return result;
}

function isIpInAnyLocalSubnet(ip: string, subnets: LocalSubnetInterface[]): boolean {
  if (ip === '127.0.0.1') return true;
  const ipInt = parseIpv4Int(ip);
  if (ipInt === null) return false;
  return subnets.some((sub) => ((ipInt & sub.maskInt) >>> 0) === sub.networkInt);
}

function mapServiceTypeToProtocol(
  serviceType: string,
  port: string
): { protocol: NasProtocolId | 'entencenter'; label: string; scheme?: 'http' | 'https'; defaultPath: string } {
  const lower = serviceType.toLowerCase();
  if (lower.includes('_entencenter._tcp')) {
    return { protocol: 'entencenter', label: 'EntenCenter Server', scheme: 'http', defaultPath: '/' };
  }
  if (lower.includes('_smb._tcp')) {
    return { protocol: 'smb', label: 'SMB / CIFS', defaultPath: '/Medien' };
  }
  if (lower.includes('_nfs._tcp')) {
    return { protocol: 'nfs', label: 'NFS', defaultPath: '/volume1/video' };
  }
  if (lower.includes('_webdavs._tcp') || port === '5006') {
    return { protocol: 'webdav', label: 'WebDAV (HTTPS)', scheme: 'https', defaultPath: '/Medien' };
  }
  if (lower.includes('_webdav._tcp') || port === '5005') {
    return { protocol: 'webdav', label: 'WebDAV (HTTP)', scheme: 'http', defaultPath: '/Medien' };
  }
  if (lower.includes('_sftp-ssh._tcp') || lower.includes('_ssh._tcp') || port === '22') {
    return { protocol: 'sftp', label: 'SFTP / SSH', defaultPath: '/mnt/nas/medien' };
  }
  if (lower.includes('_ftp._tcp') || port === '21') {
    return { protocol: 'ftps', label: 'FTP / FTPS', defaultPath: '/' };
  }
  if (lower.includes('_https._tcp') || port === '5001' || port === '443') {
    return { protocol: 'api_token', label: 'NAS Web / API (HTTPS)', scheme: 'https', defaultPath: '/api/v3' };
  }
  if (port === '49443') {
    return { protocol: 'fritz_upnp', label: 'FRITZ!Box TR-064 (HTTPS)', scheme: 'https', defaultPath: '/tr64desc.xml' };
  }
  if (port === '49000' || lower.includes('mediaserver') || lower.includes('fritz')) {
    return { protocol: 'fritz_upnp', label: 'UPnP / TR-064 MediaServer', scheme: 'http', defaultPath: '/MediaServer' };
  }
  if (port === '3000') {
    return { protocol: 'entencenter', label: 'EntenCenter / Web-Port', scheme: 'http', defaultPath: '/' };
  }
  return { protocol: 'api_token', label: 'NAS Web / HTTP', scheme: 'http', defaultPath: '/' };
}

function detectVendor(
  combinedHints: string,
  services: DiscoveredNasService[]
): DiscoveredNasDevice['vendor'] {
  const lower = combinedHints.toLowerCase();
  if (lower.includes('entencenter') || services.some((s) => s.protocol === 'entencenter')) {
    return 'EntenCenter';
  }
  if (lower.includes('synology') || lower.includes('diskstation') || services.some((s) => s.port === '5000' || s.port === '5001')) {
    return 'Synology';
  }
  if (lower.includes('qnap') || lower.includes('qts') || services.some((s) => s.port === '8080')) {
    return 'QNAP';
  }
  if (lower.includes('western digital') || lower.includes('mycloud') || lower.includes('wdc')) {
    return 'Western Digital';
  }
  if (lower.includes('truenas') || lower.includes('freenas') || lower.includes('ixsystems')) {
    return 'TrueNAS';
  }
  if (lower.includes('unraid') || lower.includes('tower')) {
    return 'Unraid';
  }
  if (lower.includes('openmediavault') || lower.includes('omv')) {
    return 'OpenMediaVault';
  }
  if (
    lower.includes('fritz') ||
    lower.includes('avm') ||
    services.some((s) => s.protocol === 'fritz_upnp')
  ) {
    return 'FRITZ!Box';
  }
  return 'Standard NAS';
}

function cleanInstanceDisplayName(rawName: string): string {
  const stripped = rawName
    .replace(/\._[a-z0-9-]+\._(tcp|udp)\.local\.?$/i, '')
    .replace(/\.local\.?$/i, '')
    .trim();
  return stripped || rawName;
}

interface MdnsScanRaw {
  instances: Map<
    string,
    {
      instanceName: string;
      serviceType: string;
      targetHost: string;
      port: number;
      txt: Record<string, string>;
      senderIp: string;
    }
  >;
  hostToIp: Map<string, string>;
}

async function runMdnsBonjourScan(timeoutMs = 1350): Promise<MdnsScanRaw> {
  const instances: MdnsScanRaw['instances'] = new Map();
  const hostToIp = new Map<string, string>();
  const serviceTypesFound = new Set<string>(
    MDNS_SERVICE_QUERIES.filter((q) => q !== '_services._dns-sd._udp.local')
  );

  await new Promise<void>((resolve) => {
    let finished = false;
    let socket: dgram.Socket | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket?.close();
      } catch {
        // Socket bereits geschlossen
      }
      resolve();
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', () => finish());

      socket.on('message', (msg, rinfo) => {
        const parsed = decodeMdnsResponsePacket(msg);
        if (!parsed) return;

        for (const rec of parsed.answers) {
          const recNameLower = rec.name.toLowerCase();
          if (rec.rtype === 'A' && rec.data.ip) {
            hostToIp.set(recNameLower, rec.data.ip);
          } else if (rec.rtype === 'PTR' && rec.data.target) {
            if (recNameLower === '_services._dns-sd._udp.local') {
              const discoveredType = rec.data.target.toLowerCase();
              if (!serviceTypesFound.has(discoveredType) && socket) {
                serviceTypesFound.add(discoveredType);
                try {
                  const followUp = encodeMdnsQueryPacket([{ name: rec.data.target, qtype: 12 }]);
                  socket.send(followUp, 0, followUp.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
                } catch {
                  // Ignorieren
                }
              }
            } else {
              const key = rec.data.target.toLowerCase();
              const existing = instances.get(key) ?? {
                instanceName: rec.data.target,
                serviceType: rec.name,
                targetHost: '',
                port: 0,
                txt: {},
                senderIp: rinfo.address,
              };
              if (!existing.serviceType) existing.serviceType = rec.name;
              instances.set(key, existing);
            }
          } else if (rec.rtype === 'SRV' && rec.data.target) {
            const key = rec.name.toLowerCase();
            const serviceMatch = /(\._[^.]+\._(?:tcp|udp)\.local)$/i.exec(rec.name);
            const existing = instances.get(key) ?? {
              instanceName: rec.name,
              serviceType: serviceMatch ? serviceMatch[1].slice(1) : '_http._tcp.local',
              targetHost: rec.data.target,
              port: rec.data.port ?? 0,
              txt: {},
              senderIp: rinfo.address,
            };
            existing.targetHost = rec.data.target;
            existing.port = rec.data.port ?? existing.port;
            existing.senderIp = existing.senderIp || rinfo.address;
            instances.set(key, existing);
          } else if (rec.rtype === 'TXT' && rec.data.txt) {
            const key = rec.name.toLowerCase();
            const existing = instances.get(key);
            if (existing) {
              existing.txt = { ...existing.txt, ...rec.data.txt };
            }
          }
        }
      });

      socket.bind(0, () => {
        if (!socket) return;
        try {
          socket.setMulticastTTL(255);
          socket.setMulticastLoopback(true);
        } catch {
          // Multicast-Optionen optional
        }

        // Sende gebündelte PTR-Abfragen (max. 8 pro Paket)
        const batchSize = 7;
        for (let i = 0; i < MDNS_SERVICE_QUERIES.length; i += batchSize) {
          const slice = MDNS_SERVICE_QUERIES.slice(i, i + batchSize);
          const packet = encodeMdnsQueryPacket(slice.map((name) => ({ name, qtype: 12 })));
          try {
            socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
          } catch {
            // Ignorieren
          }
        }
      });

      setTimeout(finish, timeoutMs);
    } catch {
      finish();
    }
  });

  // Fehlende .local-Hostnamen nachauflösen
  const missingHosts = new Set<string>();
  for (const inst of instances.values()) {
    if (inst.targetHost) {
      const lower = inst.targetHost.toLowerCase();
      if (!hostToIp.has(lower)) {
        missingHosts.add(inst.targetHost);
      }
    }
  }
  await Promise.all(
    Array.from(missingHosts).map(async (host) => {
      try {
        const res = await dns.lookup(host, { family: 4 });
        if (res.address) hostToIp.set(host.toLowerCase(), res.address);
      } catch {
        // Host nicht per System-Resolver auflösbar
      }
    })
  );

  return { instances, hostToIp };
}

interface SsdpNasHit {
  ip: string;
  port: string;
  name: string;
  manufacturer: string;
  modelName: string;
  locationUrl: string;
  serverHeader: string;
}

async function runGeneralSsdpScan(timeoutMs = 1100): Promise<SsdpNasHit[]> {
  const locations = new Map<string, { server: string; st: string; remoteIp: string }>();

  await new Promise<void>((resolve) => {
    let finished = false;
    let socket: dgram.Socket | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket?.close();
      } catch {
        // Ignorieren
      }
      resolve();
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', () => finish());
      socket.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8');
        const location = /^LOCATION:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
        const server = /^SERVER:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
        const st = /^(?:ST|NT):\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
        if (!location) return;
        const lower = `${text} ${server} ${st}`.toLowerCase();
        if (
          lower.includes('mediaserver') ||
          lower.includes('nas') ||
          lower.includes('synology') ||
          lower.includes('qnap') ||
          lower.includes('fritz') ||
          lower.includes('avm') ||
          lower.includes('upnp:rootdevice') ||
          lower.includes('storage') ||
          lower.includes('entencenter')
        ) {
          locations.set(location, { server, st, remoteIp: rinfo.address });
        }
      });

      socket.bind(0, () => {
        if (!socket) return;
        for (const st of ['urn:schemas-upnp-org:device:MediaServer:1', 'upnp:rootdevice']) {
          const payload = Buffer.from(
            [
              'M-SEARCH * HTTP/1.1',
              `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`,
              'MAN: "ssdp:discover"',
              'MX: 1',
              `ST: ${st}`,
              '',
              '',
            ].join('\r\n')
          );
          try {
            socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
          } catch {
            // Multicast im Container evtl. deaktiviert
          }
        }
      });

      setTimeout(finish, timeoutMs);
    } catch {
      finish();
    }
  });

  const hits: SsdpNasHit[] = [];
  await Promise.all(
    Array.from(locations.entries())
      .slice(0, 16)
      .map(async ([locationUrl, meta]) => {
        try {
          const parsed = new URL(locationUrl);
          const res = await fetch(locationUrl, { signal: AbortSignal.timeout(700) });
          const xml = res.ok ? await res.text() : '';
          const friendlyName =
            /<friendlyName[^>]*>([^<]+)<\/friendlyName>/i.exec(xml)?.[1]?.trim() ||
            meta.server ||
            `UPnP Gerät (${parsed.hostname})`;
          const manufacturer =
            /<manufacturer[^>]*>([^<]+)<\/manufacturer>/i.exec(xml)?.[1]?.trim() || '';
          const modelName =
            /<modelName[^>]*>([^<]+)<\/modelName>/i.exec(xml)?.[1]?.trim() || '';
          const combined = `${friendlyName} ${manufacturer} ${modelName} ${meta.server}`.toLowerCase();
          if (
            combined.includes('nas') ||
            combined.includes('synology') ||
            combined.includes('qnap') ||
            combined.includes('fritz') ||
            combined.includes('avm') ||
            combined.includes('truenas') ||
            combined.includes('unraid') ||
            combined.includes('openmediavault') ||
            combined.includes('mediaserver') ||
            combined.includes('media') ||
            combined.includes('dlna') ||
            combined.includes('entencenter')
          ) {
            hits.push({
              ip: parseIpv4Int(parsed.hostname) !== null ? parsed.hostname : meta.remoteIp,
              port: parsed.port || '80',
              name: friendlyName,
              manufacturer,
              modelName,
              locationUrl,
              serverHeader: meta.server,
            });
          }
        } catch {
          // XML-Abruf fehlgeschlagen
        }
      })
  );

  return hits;
}

function probeTcpPort(host: string, port: number, timeoutMs = 320): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Ignorieren
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

async function probeFritzTr064Descriptor(
  hostOrIp: string,
  preferTls = false,
  timeoutMs = 700
): Promise<{
  ok: boolean;
  port: string;
  scheme: 'http' | 'https';
  path: string;
  friendlyName: string;
  modelName: string;
  manufacturer: string;
} | null> {
  const candidates: Array<{ port: string; scheme: 'http' | 'https'; path: string }> = preferTls
    ? [
        { port: '49443', scheme: 'https', path: '/tr64desc.xml' },
        { port: '49000', scheme: 'http', path: '/tr64desc.xml' },
        { port: '49000', scheme: 'http', path: '/MediaServerDevDesc.xml' },
      ]
    : [
        { port: '49000', scheme: 'http', path: '/tr64desc.xml' },
        { port: '49000', scheme: 'http', path: '/MediaServerDevDesc.xml' },
        { port: '49443', scheme: 'https', path: '/tr64desc.xml' },
      ];

  for (const c of candidates) {
    try {
      const res = await requestWithLocalTlsPolicy(`${c.scheme}://${hostOrIp}:${c.port}${c.path}`, {
        method: 'GET',
        timeoutMs,
        allowLocalSelfSignedTls: true,
      });
      if (!res.ok) continue;
      const xml = res.body;
      const lower = xml.toLowerCase();
      if (lower.includes('fritz') || lower.includes('avm') || lower.includes('mediaserver') || lower.includes('tr-064')) {
        const friendlyName = /<friendlyName[^>]*>([^<]+)<\/friendlyName>/i.exec(xml)?.[1]?.trim() || `FRITZ!Box (${hostOrIp})`;
        const manufacturer = /<manufacturer[^>]*>([^<]+)<\/manufacturer>/i.exec(xml)?.[1]?.trim() || 'AVM Berlin';
        const modelName = /<modelName[^>]*>([^<]+)<\/modelName>/i.exec(xml)?.[1]?.trim() || '';
        return {
          ok: true,
          port: c.port,
          scheme: c.scheme,
          path: c.path,
          friendlyName,
          modelName,
          manufacturer,
        };
      }
    } catch {
      // Nächsten TR-064 Endpunkt testen
    }
  }
  return null;
}

async function probeFritzLoginSidHost(
  hostOrIp: string,
  preferHttps = false,
  timeoutMs = 550
): Promise<{
  ok: boolean;
  port: string;
  scheme: 'http' | 'https';
  friendlyName: string;
} | null> {
  const candidates: Array<{ port: string; scheme: 'http' | 'https' }> = preferHttps
    ? [
        { port: '443', scheme: 'https' },
        { port: '80', scheme: 'http' },
      ]
    : [
        { port: '80', scheme: 'http' },
        { port: '443', scheme: 'https' },
      ];

  for (const c of candidates) {
    try {
      const res = await requestWithLocalTlsPolicy(`${c.scheme}://${hostOrIp}:${c.port}/login_sid.lua`, {
        method: 'GET',
        timeoutMs,
        allowLocalSelfSignedTls: true,
      });
      if (!res.ok) continue;
      if (res.body.includes('<SessionInfo>') && res.body.includes('<Challenge>')) {
        return {
          ok: true,
          port: c.port,
          scheme: c.scheme,
          friendlyName: `FRITZ!Box / FRITZ!NAS (${hostOrIp})`,
        };
      }
    } catch {
      // Nächstes Protokoll probieren
    }
  }
  return null;
}

async function probeEntenCenterBootstrap(baseUrl: string, timeoutMs = 480): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/nas/auth/bootstrap`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { hasUsers?: unknown; allowedNasProtocols?: unknown };
    return typeof data?.hasUsers === 'boolean' && Array.isArray(data?.allowedNasProtocols);
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= tasks.length) break;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(tasks.length, 1)) }, () => worker())
  );
  return results;
}

export async function discoverLocalNasDevices(
  req?: Request,
  options: { includeSubnetProbe?: boolean; serverPort?: number } = {}
): Promise<NetworkNasDiscoveryResponse> {
  const startedAt = Date.now();
  const subnets = getLocalLanSubnets();
  const includeSubnetProbe = options.includeSubnetProbe ?? true;
  const serverPort = options.serverPort || Number(process.env.PORT) || 3000;
  const methodsUsed = new Set<NetworkDiscoveryMethod>(['mdns', 'ssdp']);

  const [mdnsRaw, ssdpHits, resolvedLocalHosts] = await Promise.all([
    runMdnsBonjourScan(1350),
    runGeneralSsdpScan(1100),
    Promise.all(
      KNOWN_LOCAL_NAS_HOSTNAMES.map(async (hostname) => {
        try {
          const res = await dns.lookup(hostname, { family: 4 });
          return res.address ? { hostname, ip: res.address } : null;
        } catch {
          return null;
        }
      })
    ),
  ]);

  const byIp = new Map<string, DiscoveredNasDevice>();
  const nowIso = new Date().toISOString();

  const ensureDevice = (
    ip: string,
    hostnameHint: string,
    nameHint: string,
    method: NetworkDiscoveryMethod
  ): DiscoveredNasDevice => {
    const existing = byIp.get(ip);
    if (existing) {
      if (!existing.discoveryMethods.includes(method)) {
        existing.discoveryMethods.push(method);
      }
      if (
        hostnameHint &&
        hostnameHint !== ip &&
        (existing.hostname === ip || !existing.hostname.endsWith('.local'))
      ) {
        existing.hostname = hostnameHint;
      }
      if (nameHint && existing.name.startsWith('NAS (')) {
        existing.name = nameHint;
      }
      return existing;
    }

    const device: DiscoveredNasDevice = {
      id: `nas-${ip}`,
      name: nameHint || hostnameHint || `NAS (${ip})`,
      hostname: hostnameHint || ip,
      ip,
      port: '',
      isEntenCenterServer: false,
      vendor: 'Standard NAS',
      suggestedProtocol: 'smb',
      suggestedShareOrPath: '/Medien',
      services: [],
      discoveryMethods: [method],
      sameSubnet: isIpInAnyLocalSubnet(ip, subnets),
      discoveredAt: nowIso,
    };
    byIp.set(ip, device);
    return device;
  };

  const addService = (dev: DiscoveredNasDevice, svc: DiscoveredNasService) => {
    if (
      !dev.services.some(
        (s) => s.protocol === svc.protocol && s.port === svc.port
      )
    ) {
      dev.services.push(svc);
    }
  };

  // 1. mDNS / Bonjour Treffer einarbeiten
  for (const inst of mdnsRaw.instances.values()) {
    const targetLower = inst.targetHost.toLowerCase();
    const resolvedIp =
      mdnsRaw.hostToIp.get(targetLower) ||
      (parseIpv4Int(inst.targetHost) !== null ? inst.targetHost : inst.senderIp);
    if (!resolvedIp || parseIpv4Int(resolvedIp) === null) continue;

    const cleanName = cleanInstanceDisplayName(inst.instanceName);
    const cleanHost = inst.targetHost.replace(/\.+$/, '') || resolvedIp;
    const portStr = inst.port > 0 ? String(inst.port) : '445';
    const dev = ensureDevice(resolvedIp, cleanHost, cleanName, 'mdns');

    if (Object.keys(inst.txt).length > 0) {
      dev.txtRecords = { ...(dev.txtRecords ?? {}), ...inst.txt };
    }

    const mapped = mapServiceTypeToProtocol(inst.serviceType, portStr);
    addService(dev, {
      protocol: mapped.protocol,
      serviceType: inst.serviceType,
      port: portStr,
      label: mapped.label,
      scheme: mapped.scheme,
      path: inst.txt.path || mapped.defaultPath,
    });

    if (mapped.protocol === 'entencenter') {
      dev.isEntenCenterServer = true;
      dev.baseUrl = `${mapped.scheme || 'http'}://${resolvedIp}:${portStr}`;
    }
  }

  // 2. SSDP UPnP/DLNA Treffer einarbeiten (streng als Medienquelle markiert, kein Ersatz für SMB)
  for (const hit of ssdpHits) {
    if (!hit.ip || parseIpv4Int(hit.ip) === null) continue;
    const dev = ensureDevice(hit.ip, hit.ip, hit.name, 'ssdp');
    const isFritz = `${hit.name} ${hit.manufacturer} ${hit.serverHeader}`.toLowerCase().includes('fritz');
    addService(dev, {
      protocol: isFritz ? 'fritz_upnp' : 'api_token',
      serviceType: 'ssdp:mediaserver',
      port: hit.port,
      label: isFritz ? 'FRITZ!Box UPnP/DLNA (Nur Medien)' : 'UPnP / DLNA MediaServer (Nur Medien)',
      scheme: 'http',
      path: isFritz ? '/MediaServer' : '/',
    });
  }

  // 3. Bekannte .local / FRITZ!Box Hostnamen auflösen & NAS/TR-064/HTTP-Ports testen
  await Promise.all(
    resolvedLocalHosts.map(async (entry) => {
      if (!entry) return;
      methodsUsed.add('port_probe');
      const [pEnten, pSmb, pWebdavTls, pTr064Http, pTr064Https, pHttp, pHttps] = await Promise.all([
        probeTcpPort(entry.ip, serverPort, 300),
        probeTcpPort(entry.ip, 445, 300),
        probeTcpPort(entry.ip, 5006, 300),
        probeTcpPort(entry.ip, 49000, 320),
        probeTcpPort(entry.ip, 49443, 320),
        probeTcpPort(entry.ip, 80, 300),
        probeTcpPort(entry.ip, 443, 300),
      ]);
      if (!pEnten && !pSmb && !pWebdavTls && !pTr064Http && !pTr064Https && !pHttp && !pHttps) {
        return;
      }
      const dev = ensureDevice(entry.ip, entry.hostname, cleanInstanceDisplayName(entry.hostname), 'mdns');
      if (pEnten && (await probeEntenCenterBootstrap(`http://${entry.ip}:${serverPort}`))) {
        dev.isEntenCenterServer = true;
        dev.baseUrl = `http://${entry.ip}:${serverPort}`;
        addService(dev, {
          protocol: 'entencenter',
          serviceType: '_entencenter._tcp.local',
          port: String(serverPort),
          label: 'EntenCenter Server',
          scheme: 'http',
          path: '/',
        });
      }
      if (pSmb) {
        addService(dev, { protocol: 'smb', serviceType: '_smb._tcp.local', port: '445', label: 'SMB / CIFS', path: '/Medien' });
      }
      if (pWebdavTls) {
        addService(dev, { protocol: 'webdav', serviceType: '_webdavs._tcp.local', port: '5006', label: 'WebDAV (HTTPS)', scheme: 'https', path: '/Medien' });
      }
      if (pTr064Http || pTr064Https) {
        const trInfo = await probeFritzTr064Descriptor(entry.ip, !pTr064Http && pTr064Https);
        if (trInfo) {
          dev.name = trInfo.friendlyName;
        }
        if (pTr064Http) {
          addService(dev, { protocol: 'fritz_upnp', serviceType: 'tr064:http', port: '49000', label: 'FRITZ!Box TR-064 / UPnP', scheme: 'http', path: '/MediaServer' });
        }
        if (pTr064Https) {
          addService(dev, { protocol: 'fritz_upnp', serviceType: 'tr064:https', port: '49443', label: 'FRITZ!Box TR-064 (HTTPS)', scheme: 'https', path: '/tr64desc.xml' });
        }
      }
      if (pHttp || pHttps) {
        const sidInfo = await probeFritzLoginSidHost(entry.ip, !pHttp && pHttps, 550);
        if (sidInfo) {
          if (dev.name.startsWith('Heim-NAS (') || dev.name.startsWith('NAS (') || dev.name === entry.hostname) {
            dev.name = sidInfo.friendlyName;
          }
          addService(dev, {
            protocol: 'fritz_upnp',
            serviceType: 'fritz:loginsid',
            port: sidInfo.port,
            label: `FRITZ!NAS (${sidInfo.scheme.toUpperCase()})`,
            scheme: sidInfo.scheme,
            path: '/MediaServer',
          });
        }
      }
    })
  );

  // 3b. Standard-Gateways & FRITZ!Box Standard-IPs direkt auf TR-064 & /login_sid.lua prüfen
  const standardGateways = new Set<string>(['192.168.178.1', '192.168.179.1', '192.168.1.1', '192.168.0.1']);
  for (const sub of subnets.filter((s) => s.isPrivateLan)) {
    standardGateways.add(intToIpv4((sub.networkInt + 1) >>> 0));
  }
  await Promise.all(
    Array.from(standardGateways).map(async (gwIp) => {
      const [open49000, open49443, open80, open443] = await Promise.all([
        probeTcpPort(gwIp, 49000, 260),
        probeTcpPort(gwIp, 49443, 260),
        probeTcpPort(gwIp, 80, 260),
        probeTcpPort(gwIp, 443, 260),
      ]);
      if (!open49000 && !open49443 && !open80 && !open443) return;
      methodsUsed.add('port_probe');
      const trInfo = (open49000 || open49443)
        ? await probeFritzTr064Descriptor(gwIp, !open49000 && open49443)
        : null;
      const sidInfo = (open80 || open443)
        ? await probeFritzLoginSidHost(gwIp, !open80 && open443, 550)
        : null;
      if (!trInfo && !sidInfo) return;
      const dev = ensureDevice(
        gwIp,
        gwIp === '192.168.178.1' ? 'fritz.box' : gwIp,
        trInfo?.friendlyName || sidInfo?.friendlyName || `FRITZ!Box (${gwIp})`,
        'port_probe'
      );
      if (open49000) {
        addService(dev, { protocol: 'fritz_upnp', serviceType: 'tr064:http', port: '49000', label: 'FRITZ!Box TR-064 / UPnP', scheme: 'http', path: '/MediaServer' });
      }
      if (open49443) {
        addService(dev, { protocol: 'fritz_upnp', serviceType: 'tr064:https', port: '49443', label: 'FRITZ!Box TR-064 (HTTPS)', scheme: 'https', path: '/tr64desc.xml' });
      }
      if (sidInfo) {
        addService(dev, {
          protocol: 'fritz_upnp',
          serviceType: 'fritz:loginsid',
          port: sidInfo.port,
          label: `FRITZ!NAS (${sidInfo.scheme.toUpperCase()})`,
          scheme: sidInfo.scheme,
          path: '/MediaServer',
        });
      }
    })
  );

  // 4. Privates /24 Subnetz nach offenen NAS-, FRITZ!Box TR-064-, /login_sid.lua- und EntenCenter-Ports durchsuchen
  if (includeSubnetProbe) {
    const privateSubnets = subnets.filter((s) => s.isPrivateLan).slice(0, 2);
    if (privateSubnets.length > 0) {
      methodsUsed.add('port_probe');
      const candidateIps = new Set<string>();
      for (const sub of privateSubnets) {
        const base = sub.networkInt & 0xffffff00;
        for (let hostOctet = 1; hostOctet <= 254; hostOctet += 1) {
          candidateIps.add(intToIpv4((base | hostOctet) >>> 0));
        }
      }

      const probePorts = [serverPort, 445, 5000, 5001, 5005, 5006, 2049, 22, 21, 80, 443, 49000, 49443];
      const probeTasks = Array.from(candidateIps).map((ip) => async () => {
        const openResults = await Promise.all(
          probePorts.map(async (p) => ({ port: p, open: await probeTcpPort(ip, p, 240) }))
        );
        const openPorts = openResults.filter((r) => r.open).map((r) => r.port);
        if (openPorts.length === 0) return;

        // Zuerst schnell prüfen, ob auf diesem Host relevante NAS-/FRITZ!Box-Dienste laufen
        let fritzSidMatch: Awaited<ReturnType<typeof probeFritzLoginSidHost>> = null;
        if (openPorts.includes(80) || openPorts.includes(443)) {
          fritzSidMatch = await probeFritzLoginSidHost(ip, !openPorts.includes(80) && openPorts.includes(443), 500);
        }

        const hasNonWebNasPort = openPorts.some((p) => p !== 80 && p !== 443);
        if (!hasNonWebNasPort && !fritzSidMatch) return;

        const dev = ensureDevice(ip, ip, fritzSidMatch?.friendlyName || `Heim-NAS (${ip})`, 'port_probe');
        if (fritzSidMatch) {
          dev.name = fritzSidMatch.friendlyName;
          addService(dev, {
            protocol: 'fritz_upnp',
            serviceType: 'fritz:loginsid',
            port: fritzSidMatch.port,
            label: `FRITZ!NAS (${fritzSidMatch.scheme.toUpperCase()})`,
            scheme: fritzSidMatch.scheme,
            path: '/MediaServer',
          });
        }

        for (const p of openPorts) {
          if (p === 80 || p === 443) continue;
          if (p === serverPort) {
            const isEnten = await probeEntenCenterBootstrap(`http://${ip}:${serverPort}`, 380);
            if (isEnten) {
              dev.isEntenCenterServer = true;
              dev.baseUrl = `http://${ip}:${serverPort}`;
              addService(dev, {
                protocol: 'entencenter',
                serviceType: '_entencenter._tcp.local',
                port: String(serverPort),
                label: 'EntenCenter Server',
                scheme: 'http',
                path: '/',
              });
            }
          } else if (p === 445) {
            const smbCheck = await probeSmb23Protocol({
              hostname: ip,
              resolvedIp: ip,
              port: 445,
              isLan: true,
              scope: 'lan',
              timeoutMs: 650,
            });
            if (smbCheck.protocolVerified && !smbCheck.smb1Rejected) {
              addService(dev, {
                protocol: 'smb',
                serviceType: '_smb._tcp.local',
                port: '445',
                label: `${smbCheck.smbDialect || 'SMB 2/3'} (Dateizugriff)`,
                path: '/Medien',
              });
            }
          } else if (p === 5000) {
            addService(dev, { protocol: 'api_token', serviceType: '_http._tcp.local', port: '5000', label: 'Synology DSM (HTTP)', scheme: 'http', path: '/api/v3' });
          } else if (p === 5001) {
            addService(dev, { protocol: 'api_token', serviceType: '_https._tcp.local', port: '5001', label: 'Synology DSM (HTTPS)', scheme: 'https', path: '/api/v3' });
          } else if (p === 5005) {
            addService(dev, { protocol: 'webdav', serviceType: '_webdav._tcp.local', port: '5005', label: 'WebDAV (HTTP)', scheme: 'http', path: '/Medien' });
          } else if (p === 5006) {
            addService(dev, { protocol: 'webdav', serviceType: '_webdavs._tcp.local', port: '5006', label: 'WebDAV (HTTPS)', scheme: 'https', path: '/Medien' });
          } else if (p === 2049) {
            addService(dev, { protocol: 'nfs', serviceType: '_nfs._tcp.local', port: '2049', label: 'NFS', path: '/volume1/video' });
          } else if (p === 22) {
            const sftpCheck = await probeSftpProtocol({
              hostname: ip,
              resolvedIp: ip,
              port: 22,
              timeoutMs: 550,
            });
            if (sftpCheck.protocolVerified) {
              addService(dev, { protocol: 'sftp', serviceType: '_sftp-ssh._tcp.local', port: '22', label: 'SFTP / SSH-2.0', path: '/mnt/nas/medien' });
            }
          } else if (p === 21) {
            addService(dev, { protocol: 'ftps', serviceType: '_ftp._tcp.local', port: '21', label: 'FTP / FTPS', path: '/' });
          } else if (p === 49000 || p === 49443) {
            const trInfo = await probeFritzTr064Descriptor(ip, p === 49443);
            if (trInfo) {
              dev.name = trInfo.friendlyName;
              addService(dev, {
                protocol: 'fritz_upnp',
                serviceType: p === 49443 ? 'tr064:https' : 'tr064:http',
                port: String(p),
                label: p === 49443 ? 'FRITZ!Box TR-064 (HTTPS)' : 'FRITZ!Box TR-064 / UPnP',
                scheme: p === 49443 ? 'https' : 'http',
                path: trInfo.path,
              });
            }
          }
        }
      });

      await runWithConcurrency(probeTasks, 64);
    }
  }

  // Aktuellen lokalen EntenCenter-Server ebenfalls als Treffer aufnehmen, falls über LAN-IP erreichbar
  const primaryLanIp = subnets.find((s) => s.isPrivateLan)?.ip;
  if (primaryLanIp && !byIp.has(primaryLanIp)) {
    const dev = ensureDevice(
      primaryLanIp,
      `${os.hostname().replace(/\.local$/i, '')}.local`,
      `EntenCenter Server (${os.hostname()})`,
      'mdns'
    );
    dev.isEntenCenterServer = true;
    dev.baseUrl = `http://${primaryLanIp}:${serverPort}`;
    addService(dev, {
      protocol: 'entencenter',
      serviceType: '_entencenter._tcp.local',
      port: String(serverPort),
      label: 'EntenCenter Server',
      scheme: 'http',
      path: '/',
    });
  } else if (!primaryLanIp && req) {
    // Auch im isolierten Container-Modus den laufenden EntenCenter-Server melden, wenn lokal geprüft
    const hostHeader = req.get('host');
    if (hostHeader) {
      const [hName, hPort] = hostHeader.split(':');
      if (hName && (hName === 'localhost' || hName === '127.0.0.1')) {
        const dev = ensureDevice('127.0.0.1', 'localhost', 'Dieser EntenCenter-Server', 'port_probe');
        dev.isEntenCenterServer = true;
        dev.baseUrl = `http://127.0.0.1:${hPort || serverPort}`;
        addService(dev, {
          protocol: 'entencenter',
          serviceType: '_entencenter._tcp.local',
          port: String(hPort || serverPort),
          label: 'EntenCenter Server',
          scheme: 'http',
          path: '/',
        });
      }
    }
  }

  // Finalisieren & sortieren
  const devices = Array.from(byIp.values())
    .filter((d) => d.services.length > 0 || d.isEntenCenterServer)
    .map((dev) => {
      const txtHint = Object.values(dev.txtRecords ?? {}).join(' ');
      const serviceLabels = dev.services.map((s) => `${s.serviceType} ${s.label}`).join(' ');
      const vendor = detectVendor(`${dev.name} ${dev.hostname} ${txtHint} ${serviceLabels}`, dev.services);
      const priorityOrder: Array<DiscoveredNasService['protocol']> = [
        'smb',
        'webdav',
        'sftp',
        'ftps',
        'api_token',
        'nfs',
        'fritz_upnp',
        'entencenter',
      ];
      dev.services.sort((a, b) => priorityOrder.indexOf(a.protocol) - priorityOrder.indexOf(b.protocol));

      const primaryNasSvc =
        dev.services.find((s) => s.protocol !== 'entencenter') ?? dev.services[0];
      const entenSvc = dev.services.find((s) => s.protocol === 'entencenter');

      const suggestedProtocol: NasProtocolId =
        primaryNasSvc && primaryNasSvc.protocol !== 'entencenter'
          ? primaryNasSvc.protocol
          : vendor === 'FRITZ!Box'
            ? 'fritz_upnp'
            : 'smb';

      const primaryPort =
        entenSvc?.port || primaryNasSvc?.port || (vendor === 'EntenCenter' ? String(serverPort) : '445');

      const displayName =
        dev.name.startsWith('Heim-NAS (') && vendor !== 'Standard NAS'
          ? `${vendor} (${dev.ip})`
          : dev.name;

      return {
        ...dev,
        name: displayName,
        vendor,
        port: primaryPort,
        suggestedProtocol,
        suggestedShareOrPath: primaryNasSvc?.path || '/Medien',
      };
    });

  devices.sort((a, b) => {
    if (a.isEntenCenterServer !== b.isEntenCenterServer) return a.isEntenCenterServer ? -1 : 1;
    if (a.sameSubnet !== b.sameSubnet) return a.sameSubnet ? -1 : 1;
    const aMdns = a.discoveryMethods.includes('mdns') || a.discoveryMethods.includes('android_nsd');
    const bMdns = b.discoveryMethods.includes('mdns') || b.discoveryMethods.includes('android_nsd');
    if (aMdns !== bMdns) return aMdns ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const durationMs = Date.now() - startedAt;
  const summary =
    devices.length === 0
      ? 'Keine weiteren NAS-Geräte per mDNS/Bonjour oder SSDP im lokalen Netz gefunden.'
      : `${devices.length} Gerät${devices.length === 1 ? '' : 'e'} im Netzwerk erkannt (${devices.filter((d) => d.isEntenCenterServer).length} EntenCenter-Server).`;

  return {
    devices,
    localSubnets: subnets.map((s) => s.cidr),
    methodsUsed: Array.from(methodsUsed),
    durationMs,
    scannedAt: new Date().toISOString(),
    summary,
  };
}

export function startMdnsResponder(options: { port: number; instanceName?: string }): () => void {
  const port = options.port || 3000;
  const rawHost = os.hostname().replace(/\.local$/i, '').replace(/[^a-zA-Z0-9-]/g, '-') || 'entencenter';
  const instanceLabel = options.instanceName || `EntenCenter NAS (${rawHost})`;
  const servicePtr = '_entencenter._tcp.local';
  const serviceInstance = `${instanceLabel}.${servicePtr}`;
  const hostLocal = `${rawHost.toLowerCase()}.local`;

  let socket: dgram.Socket | null = null;

  const buildAnnouncementPacket = (): Buffer | null => {
    const subnets = getLocalLanSubnets();
    const lanIp = subnets.find((s) => s.isPrivateLan)?.ip;
    if (!lanIp) return null;
    const ipv4Buf = encodeIpv4Rdata(lanIp);
    if (!ipv4Buf) return null;

    const answers: Buffer[] = [
      encodeDnsRecordHeader('_services._dns-sd._udp.local', 12, 120, encodeDnsName(servicePtr)),
      encodeDnsRecordHeader(servicePtr, 12, 120, encodeDnsName(serviceInstance)),
      encodeDnsRecordHeader(serviceInstance, 33, 120, encodeSrvRdata(port, hostLocal)),
      encodeDnsRecordHeader(
        serviceInstance,
        16,
        120,
        encodeTxtRdata(['app=entencenter', 'path=/', `port=${port}`])
      ),
      encodeDnsRecordHeader(hostLocal, 1, 120, ipv4Buf),
    ];

    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(0x8400, 2); // Standard query response, Authoritative
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);

    return Buffer.concat([header, ...answers]);
  };

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => {
      // mDNS-Multicast Port 5353 im aktuellen Host nicht verfügbar — unkritisch
    });

    socket.on('message', (msg) => {
      const parsed = decodeMdnsResponsePacket(msg);
      if (!parsed || parsed.isResponse) return;
      const relevant = parsed.questions.some((q) => {
        const name = q.name.toLowerCase();
        return (
          name === servicePtr ||
          name === '_services._dns-sd._udp.local' ||
          name === '_http._tcp.local' ||
          name === hostLocal ||
          name === 'entencenter.local'
        );
      });
      if (!relevant) return;
      const packet = buildAnnouncementPacket();
      if (packet && socket) {
        try {
          socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
        } catch {
          // Ignorieren
        }
      }
    });

    socket.bind(MDNS_PORT, () => {
      if (!socket) return;
      try {
        socket.addMembership(MDNS_MULTICAST_ADDR);
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
        const packet = buildAnnouncementPacket();
        if (packet) {
          socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
        }
      } catch {
        // Multicast-Mitgliedschaft im Container evtl. eingeschränkt
      }
    });
  } catch {
    // Non-fatal
  }

  return () => {
    try {
      socket?.close();
    } catch {
      // Ignorieren
    }
    socket = null;
  };
}
