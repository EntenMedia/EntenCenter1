import type {
  FritzTrackStatus,
  NasConnectionScope,
  NasProtocolId,
  NasTransportRole,
  NasVendorId,
  UniversalNasCredentialEntry,
} from '../types/marcente';
import { isNativeAndroidShell } from './nasClient';

const VAULT_STORAGE_KEY = 'entencenter_multi_nas_vault_v1';
const WEB_CRYPTO_IDB_NAME = 'entencenter_web_keystore_db';
const WEB_CRYPTO_IDB_STORE = 'keys';
const WEB_CRYPTO_KEY_ID = 'nas_vault_aes_gcm_v1';

interface VaultBridgeWindow extends Window {
  EntenCenterAndroid?: {
    isKeystoreProtected?: () => boolean;
    saveEncryptedNasVault?: (jsonPayload: string) => boolean;
    loadEncryptedNasVault?: () => string;
    clearEncryptedNasVault?: () => boolean;
  };
}

interface EncryptedSecretEnvelope {
  v: 1;
  alg: 'AES-GCM-256';
  iv: string;
  ct: string;
}

interface StoredVaultRecord {
  version: 1;
  entries: UniversalNasCredentialEntry[];
  secrets: Record<string, EncryptedSecretEnvelope | string>;
  updatedAt: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isAndroidKeystoreBacked(): boolean {
  if (typeof window === 'undefined' || !isNativeAndroidShell()) return false;
  try {
    return Boolean((window as VaultBridgeWindow).EntenCenterAndroid?.isKeystoreProtected?.());
  } catch {
    return false;
  }
}

export function redactSensitiveText(
  rawText: string,
  knownSecrets: Array<string | null | undefined> = []
): string {
  if (!rawText) return '';
  let clean = rawText
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[geschützt]')
    .replace(/([?&](?:sid|password|secret|pass|token)=)[^&\s]+/gi, '$1[geschützt]')
    .replace(/((?:password|passwort|secret|token|sid)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[geschützt]');

  for (const s of knownSecrets) {
    const trimmed = (s ?? '').trim();
    if (trimmed.length >= 3) {
      clean = clean.split(trimmed).join('[geschützt]');
    }
  }
  return clean;
}

async function getOrCreateWebAesKey(): Promise<CryptoKey | null> {
  if (
    typeof window === 'undefined' ||
    typeof window.crypto?.subtle === 'undefined' ||
    typeof window.indexedDB === 'undefined'
  ) {
    return null;
  }

  const db = await new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = window.indexedDB.open(WEB_CRYPTO_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(WEB_CRYPTO_IDB_STORE)) {
          req.result.createObjectStore(WEB_CRYPTO_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  if (!db) return null;

  try {
    const existing = await new Promise<CryptoKey | null>((resolve) => {
      try {
        const tx = db.transaction(WEB_CRYPTO_IDB_STORE, 'readonly');
        const req = tx.objectStore(WEB_CRYPTO_IDB_STORE).get(WEB_CRYPTO_KEY_ID);
        req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (existing) return existing;

    const created = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(WEB_CRYPTO_IDB_STORE, 'readwrite');
        tx.objectStore(WEB_CRYPTO_IDB_STORE).put(created, WEB_CRYPTO_KEY_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    return created;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function encryptBrowserSecret(plaintext: string): Promise<EncryptedSecretEnvelope | null> {
  if (!plaintext) return null;
  if (isNativeAndroidShell()) {
    // Auf Android verschlüsselt SecureVaultHelper.kt das gesamte Vault-JSON nativ über AndroidKeyStore
    return null;
  }
  const key = await getOrCreateWebAesKey();
  if (!key) return null;
  try {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    return {
      v: 1,
      alg: 'AES-GCM-256',
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(cipherBuffer)),
    };
  } catch {
    return null;
  }
}

export async function decryptBrowserSecret(
  stored: EncryptedSecretEnvelope | string | null | undefined
): Promise<string> {
  if (!stored) return '';
  if (typeof stored === 'string') {
    // Android nativer Vault wird bereits beim Laden über AndroidKeyStore entschlüsselt
    return isNativeAndroidShell() ? stored : '';
  }
  if (stored.v !== 1 || !stored.iv || !stored.ct) return '';
  const key = await getOrCreateWebAesKey();
  if (!key) return '';
  try {
    const ivBytes = base64ToBytes(stored.iv);
    const ctBytes = base64ToBytes(stored.ct);
    const ivCopy = new Uint8Array(ivBytes.length);
    ivCopy.set(ivBytes);
    const ctCopy = new Uint8Array(ctBytes.length);
    ctCopy.set(ctBytes);
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivCopy },
      key,
      ctCopy
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return '';
  }
}

function readRawVaultRecord(): StoredVaultRecord {
  const empty: StoredVaultRecord = {
    version: 1,
    entries: [],
    secrets: {},
    updatedAt: new Date().toISOString(),
  };
  if (typeof window === 'undefined') return empty;

  if (isNativeAndroidShell()) {
    try {
      const nativeRaw = (window as VaultBridgeWindow).EntenCenterAndroid?.loadEncryptedNasVault?.();
      if (nativeRaw) {
        const parsed = JSON.parse(nativeRaw) as Partial<StoredVaultRecord>;
        if (parsed && Array.isArray(parsed.entries)) {
          return {
            version: 1,
            entries: parsed.entries,
            secrets: parsed.secrets ?? {},
            updatedAt: parsed.updatedAt || new Date().toISOString(),
          };
        }
      }
    } catch {
      // Fallback prüfen
    }
  }

  try {
    const raw = window.localStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredVaultRecord>;
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries,
        secrets: parsed.secrets ?? {},
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
    }
  } catch {
    // Ungültige Daten ignorieren
  }
  return empty;
}

function writeRawVaultRecord(record: StoredVaultRecord): void {
  if (typeof window === 'undefined') return;
  const sanitizedEntries = record.entries.map((entry) => ({
    ...entry,
    lastMessage: entry.lastMessage ? redactSensitiveText(entry.lastMessage) : entry.lastMessage,
  }));
  const payload: StoredVaultRecord = {
    version: 1,
    entries: sanitizedEntries,
    secrets: record.secrets,
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload);

  if (isNativeAndroidShell()) {
    try {
      const saved = (window as VaultBridgeWindow).EntenCenterAndroid?.saveEncryptedNasVault?.(serialized);
      if (saved) {
        // Nur Metadaten (ohne Secrets) im WebView-localStorage spiegeln
        const metadataOnly: StoredVaultRecord = {
          version: 1,
          entries: sanitizedEntries,
          secrets: {},
          updatedAt: payload.updatedAt,
        };
        window.localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(metadataOnly));
        return;
      }
    } catch {
      // Fallback unten
    }
  }

  // Im Web-Browser dürfen NIEMALS Klartext-Secrets in localStorage landen:
  const safeWebSecrets: Record<string, EncryptedSecretEnvelope | string> = {};
  for (const [k, v] of Object.entries(record.secrets)) {
    if (v && typeof v === 'object' && v.v === 1) {
      safeWebSecrets[k] = v;
    }
  }
  try {
    window.localStorage.setItem(
      VAULT_STORAGE_KEY,
      JSON.stringify({
        ...payload,
        secrets: safeWebSecrets,
      })
    );
  } catch {
    // Speicher voll / gesperrt
  }
}

export function listVaultNasEntries(): UniversalNasCredentialEntry[] {
  return readRawVaultRecord().entries;
}

export async function getVaultNasSecret(entryId: string): Promise<string> {
  const rec = readRawVaultRecord();
  const stored = rec.secrets[entryId];
  return decryptBrowserSecret(stored);
}

export async function upsertVaultNasEntry(
  input: {
    id?: string;
    name: string;
    vendor: NasVendorId;
    scope: NasConnectionScope;
    protocol: NasProtocolId;
    host: string;
    port: string;
    shareOrPath: string;
    username: string;
    useTls: boolean;
    autoReconnect?: boolean;
    capabilityTags: NasTransportRole[];
    lastStatus: UniversalNasCredentialEntry['lastStatus'];
    lastLatencyMs?: number | null;
    lastMessage?: string | null;
    fritzTracks?: FritzTrackStatus | null;
    setActive?: boolean;
  },
  plaintextSecret?: string
): Promise<UniversalNasCredentialEntry[]> {
  const rec = readRawVaultRecord();
  const now = new Date().toISOString();
  const cleanHost = input.host.trim();
  const cleanPort = input.port.trim();
  const existing = rec.entries.find(
    (e) =>
      (input.id && e.id === input.id) ||
      (e.host.toLowerCase() === cleanHost.toLowerCase() &&
        e.protocol === input.protocol &&
        e.port === cleanPort)
  );
  const id =
    existing?.id ||
    input.id ||
    `nas-${input.protocol}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let nextSecretStored = existing ? rec.secrets[existing.id] : undefined;
  let hasSecret = existing?.hasSecret ?? false;

  if (typeof plaintextSecret === 'string' && plaintextSecret.length > 0) {
    if (isNativeAndroidShell()) {
      // AndroidKeyStore AES-256-GCM verschlüsselt das gesamte Payload in Native
      nextSecretStored = plaintextSecret;
      hasSecret = true;
    } else {
      const encrypted = await encryptBrowserSecret(plaintextSecret);
      if (encrypted) {
        nextSecretStored = encrypted;
        hasSecret = true;
      }
    }
  }

  const nextEntry: UniversalNasCredentialEntry = {
    id,
    name: input.name.trim() || `${cleanHost} (${input.protocol.toUpperCase()})`,
    vendor: input.vendor,
    scope: input.scope,
    protocol: input.protocol,
    host: cleanHost,
    port: cleanPort,
    shareOrPath: input.shareOrPath.trim() || '/',
    username: input.username.trim(),
    useTls: input.useTls,
    hasSecret,
    isActive: input.setActive ?? true,
    autoReconnect: input.autoReconnect ?? existing?.autoReconnect ?? true,
    capabilityTags: input.capabilityTags,
    lastVerifiedAt: input.lastStatus === 'online' ? now : existing?.lastVerifiedAt ?? null,
    lastStatus: input.lastStatus,
    lastLatencyMs: input.lastLatencyMs ?? existing?.lastLatencyMs ?? null,
    lastMessage: input.lastMessage ? redactSensitiveText(input.lastMessage, [plaintextSecret]) : null,
    fritzTracks: input.fritzTracks ?? existing?.fritzTracks ?? null,
    updatedAt: now,
  };

  const makeActive = input.setActive !== false;
  const updatedEntries = [
    nextEntry,
    ...rec.entries
      .filter((e) => e.id !== id)
      .map((e) => (makeActive ? { ...e, isActive: false } : e)),
  ];

  const nextSecrets = { ...rec.secrets };
  if (nextSecretStored !== undefined) {
    nextSecrets[id] = nextSecretStored;
  }

  writeRawVaultRecord({
    version: 1,
    entries: updatedEntries,
    secrets: nextSecrets,
    updatedAt: now,
  });

  return updatedEntries;
}

export function setActiveVaultNasEntry(entryId: string): UniversalNasCredentialEntry[] {
  const rec = readRawVaultRecord();
  const updated = rec.entries.map((e) => ({
    ...e,
    isActive: e.id === entryId,
  }));
  writeRawVaultRecord({ ...rec, entries: updated });
  return updated;
}

export function removeVaultNasEntry(entryId: string): UniversalNasCredentialEntry[] {
  const rec = readRawVaultRecord();
  const filtered = rec.entries.filter((e) => e.id !== entryId);
  if (filtered.length > 0 && !filtered.some((e) => e.isActive)) {
    filtered[0] = { ...filtered[0], isActive: true };
  }
  const nextSecrets = { ...rec.secrets };
  delete nextSecrets[entryId];
  writeRawVaultRecord({
    ...rec,
    entries: filtered,
    secrets: nextSecrets,
  });
  return filtered;
}

export function updateVaultNasEntryStatus(
  entryId: string,
  patch: Partial<
    Pick<
      UniversalNasCredentialEntry,
      'lastStatus' | 'lastLatencyMs' | 'lastMessage' | 'lastVerifiedAt' | 'fritzTracks'
    >
  >
): UniversalNasCredentialEntry[] {
  const rec = readRawVaultRecord();
  const updated = rec.entries.map((e) =>
    e.id === entryId
      ? {
          ...e,
          ...patch,
          lastMessage: patch.lastMessage ? redactSensitiveText(patch.lastMessage) : e.lastMessage,
          updatedAt: new Date().toISOString(),
        }
      : e
  );
  writeRawVaultRecord({ ...rec, entries: updated });
  return updated;
}
