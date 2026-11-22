import 'dotenv/config';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, type GenerateContentResponse, ThinkingLevel, Type } from '@google/genai';
import { createNasJsonStore, type WriteJsonOptions } from './src/server/nasJsonStore.ts';
import { discoverLocalNasDevices, startMdnsResponder } from './src/server/nasDiscovery.ts';
import { FritzBoxSessionClient, normalizeFritzHostAndScheme } from './src/server/fritzBoxSessionClient.ts';
import { isLocalLanHostnameOrIp, requestWithLocalTlsPolicy } from './src/server/localTlsFetch.ts';
import {
  browseSmbDirectories,
  cleanHostInput,
  evaluateFritzSeparatedTracks,
  getSmbVolumeStats,
  isLocalLanTargetStrict,
  probeBridgeNasHealthServer,
  provisionSmbBackend,
  readSmbFile,
  runUniversalNasProbe,
  sanitizeSmbPort,
  scanSmbMediaFolders,
  statAndStreamSmbFileRange,
  testSingleUniversalProtocol,
  wakeNasDeviceServer,
  writeSmbFile,
} from './src/server/nasProtocolProber.ts';
import {
  connectAndCastOnServer,
  controlServerCastMedia,
  discoverServerChromecastDevices,
  getServerCastSessionState,
} from './src/server/chromecastBridge.ts';
import {
  GERMAN_ALL_PROVIDERS,
  mapNetworkToGermanProvider,
  type StreamingProviderDE,
} from './src/data/germanProviders.ts';
import type {
  AlternativePortScanEntry,
  AlternativePortScanResult,
  DeepNetworkDiagnosticsResult,
  Http400DiagnosticDetail,
  NasBrowseTreeResult,
  NasConnectionProfile,
  NasConnectionScope,
  NasDirectoryTreeEntry,
  NasProfileScope,
  NasProtocolVerificationResult,
  NasProvisionBackendResult,
  NasScanFolderSettings,
  NasSecurityCertificateInfo,
  NetworkDiagnosticFinding,
  NetworkHopEntry,
  NetworkPortProbeEntry,
  ProfileFolderInfo,
  UniversalNasProbeResponse,
} from './src/types/marcente.ts';

const execFileAsync = promisify(execFile);

function parseCliPortArg(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const next = Number(argv[i + 1]);
      if (Number.isInteger(next) && next > 0 && next <= 65535) return next;
    } else if (arg.startsWith('--port=')) {
      const next = Number(arg.slice('--port='.length));
      if (Number.isInteger(next) && next > 0 && next <= 65535) return next;
    }
  }
  return null;
}

const CLI_PORT = parseCliPortArg(process.argv.slice(2));
const ENV_PORT = Number(process.env.PORT);
const PORT =
  CLI_PORT ??
  (process.env.NODE_ENV !== 'production' && (!ENV_PORT || ENV_PORT === 8080)
    ? 3000
    : ENV_PORT || 3000);
const ALTERNATIVE_ENTENCENTER_PORTS = [3000, 3001, 3002, 3005, 3010, 8000, 8080, 8081, 8443, 8888, 9000, 9090];
let activeServerPort = PORT;
const NAS_DATA_DIR = path.resolve(process.cwd(), 'data', 'marcente-nas');
const NAS_UPLOADS_DIR = path.resolve(NAS_DATA_DIR, 'uploads');
const MAX_NAS_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB pro Datei
const HMAC_SECRET =
  process.env.MARCENTE_HMAC_SECRET || 'marcente-nas-central-vault-key-2026';

// --- Deletion-resistant NAS JSON storage helpers (mirrors /mnt/nas/.entencenter/) ---

type FskLevel = 0 | 6 | 12 | 16 | 18;
const VALID_FSK_LEVELS = new Set<FskLevel>([0, 6, 12, 16, 18]);

function normalizeFskLimit(raw: unknown, fallback: FskLevel = 18): FskLevel {
  const num = Number(raw);
  if (VALID_FSK_LEVELS.has(num as FskLevel)) return num as FskLevel;
  return fallback;
}

interface StoredUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'family';
  fskLimit?: FskLevel;
  salt: string;
  passwordHash: string;
  createdAt: string;
  avatarColor: string;
  avatarUrl?: string | null;
}

function serializeUser(u: StoredUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    fskLimit: normalizeFskLimit(u.fskLimit, 18),
    hasNasWriteAccess: hasNasWriteAccess(u.username),
    createdAt: u.createdAt,
    avatarColor: u.avatarColor,
    avatarUrl: u.avatarUrl ?? null,
  };
}

type MediaKind = 'movie' | 'series' | 'image' | 'music' | 'video' | 'other';

type SeriesProductionStatus = 'returning' | 'ended' | 'canceled';

interface NasLibraryRecord {
  id: string;
  tmdbId: number;
  title: string;
  kind: MediaKind;
  genre: string;
  year: number;
  coverKey: string;
  synopsis: string;
  codec: string;
  audioTracks: string[];
  subtitles: string[];
  totalDurationMinutes: number;
  nasPath: string;
  addedAt?: string;
  fileFormat?: string;
  fileSize?: string;
  fsk?: FskLevel;
  totalEpisodes?: number;
  defaultSeason?: number;
  defaultEpisode?: number;
  defaultEpisodeTitle?: string;
  seriesStatus?: SeriesProductionStatus;
  seriesStatusDetail?: string;
  cast?: string[];
  studio?: string;
  director?: string;
  moodTags?: string[];
  seasons?: string[];
  uploadedFileName?: string;
  uploadedMimeType?: string;
  uploadedByteSize?: number;
  customCoverFileName?: string;
}

interface WatchHistoryEntry {
  username: string;
  mediaId: string;
  tmdbId: number;
  title: string;
  mediaType: 'movie' | 'series' | 'image' | 'music' | 'video' | 'other';
  genre: string;
  watchedMinutes: number;
  episodesWatched: number;
  currentSeason?: number;
  currentEpisode?: number;
  currentEpisodeTitle?: string;
  watchedEpisodeKeys?: string[];
  lastWatchedAt: string | null;
  watchedWithoutDate?: boolean;
}

interface FavoritesStore {
  users: Record<
    string,
    {
      auto: string[];
      manual: string[];
      muted: string[];
      filmManual?: string[];
      filmMuted?: string[];
    }
  >;
}

interface WatchlistStore {
  users: Record<string, string[]>;
}

interface NasSavedCollectionRecord {
  id: string;
  collectionType: 'watchlist' | 'playlist';
  title: string;
  criteriaSummary: string;
  createdByPrompt: string;
  mediaIds: string[];
  createdAt: string;
}

interface CollectionsStore {
  users: Record<string, NasSavedCollectionRecord[]>;
}

interface BehaviorSearchEntry {
  query: string;
  intent: 'search' | 'watchlist' | 'playlist';
  timestamp: string;
}

interface BehaviorActionEntry {
  type: 'play' | 'progress' | 'mark_watched' | 'watchlist_add' | 'collection_save';
  mediaId?: string;
  mediaKind?: MediaKind;
  title?: string;
  genre?: string;
  hourOfDay: number;
  timestamp: string;
}

interface UserBehaviorRecord {
  recentSearches: BehaviorSearchEntry[];
  recentActions: BehaviorActionEntry[];
}

interface BehaviorStore {
  users: Record<string, UserBehaviorRecord>;
}

type ThemePresetId =
  | 'cinema-amber'
  | 'nordic-cyan'
  | 'emerald-vault'
  | 'crimson-premiere'
  | 'amethyst-studio'
  | 'silver-glass'
  | 'light'
  | 'high-contrast';

type AutoThemeMode = 'off' | 'time' | 'location';
type AutoThemeDayTarget = 'light' | 'high-contrast';
type AutoThemeNightTarget =
  | 'cinema-amber'
  | 'nordic-cyan'
  | 'emerald-vault'
  | 'crimson-premiere'
  | 'amethyst-studio'
  | 'silver-glass';

interface AutoThemeConfigRecord {
  mode: AutoThemeMode;
  dayTheme: AutoThemeDayTarget;
  nightTheme: AutoThemeNightTarget;
  dayStartTime: string;
  nightStartTime: string;
  latitude: number | null;
  longitude: number | null;
  locationLabel?: string | null;
  lastLocationUpdatedAt?: string | null;
}

type HomeRowKey =
  | 'ask_duck'
  | 'recommendations'
  | 'duck_radar'
  | 'movie'
  | 'series'
  | 'continue'
  | 'recent'
  | 'watchlist'
  | 'recently_added'
  | 'image'
  | 'music'
  | 'video'
  | 'other';

type HomeToggleKey = HomeRowKey;

type AudioPlayerMode = 'internal' | 'external';

type CalendarNotificationMode =
  | 'favorites_all'
  | 'favorites_new_series'
  | 'favorites_new_episodes'
  | 'all'
  | 'all_new_series'
  | 'all_new_episodes';

const VALID_CALENDAR_NOTIFICATION_MODES = new Set<CalendarNotificationMode>([
  'favorites_all',
  'favorites_new_series',
  'favorites_new_episodes',
  'all',
  'all_new_series',
  'all_new_episodes',
]);

type FilmNotificationMode = 'favorites' | 'all';

interface CustomThemePaletteRecord {
  background: string;
  sidebar: string;
  surface: string;
  accent: string;
  text: string;
  border: string;
}

interface CustomThemeSettingsRecord {
  activeFor: 'none' | 'design1' | 'design2';
  design1: CustomThemePaletteRecord;
  design2: CustomThemePaletteRecord;
}

interface UserPreferencesRecord {
  theme: ThemePresetId;
  customTheme?: CustomThemeSettingsRecord;
  autoTheme?: AutoThemeConfigRecord;
  homeSectionOrder: HomeRowKey[];
  hiddenHomeSections: HomeToggleKey[];
  showHomeCategoryTabs: boolean;
  showHomeFilterSearch: boolean;
  audioPlayerMode: AudioPlayerMode;
  duckAssistantEnabled: boolean;
  playerControlsTimeoutSec: number;
  playerSeekBackwardSec: number;
  playerSeekForwardSec: number;
  calendarNotificationMode: CalendarNotificationMode;
  filmNotificationMode: FilmNotificationMode;
}

const DEFAULT_DESIGN1_PALETTE: CustomThemePaletteRecord = {
  background: '#0B0E14',
  sidebar: '#0F141E',
  surface: '#121722',
  accent: '#FBBF24',
  text: '#F1F5F9',
  border: '#1E293B',
};

const DEFAULT_DESIGN2_PALETTE: CustomThemePaletteRecord = {
  background: '#1E2229',
  sidebar: '#3A404C',
  surface: '#4A5260',
  accent: '#CBD5E1',
  text: '#F8FAFC',
  border: '#94A3B8',
};

function sanitizeHexColor(val: unknown, fallback: string): string {
  if (typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val.trim())) {
    return val.trim().toUpperCase();
  }
  return fallback;
}

function sanitizePalette(
  raw: Partial<CustomThemePaletteRecord> | undefined | null,
  fallback: CustomThemePaletteRecord
): CustomThemePaletteRecord {
  return {
    background: sanitizeHexColor(raw?.background, fallback.background),
    sidebar: sanitizeHexColor(raw?.sidebar, fallback.sidebar),
    surface: sanitizeHexColor(raw?.surface, fallback.surface),
    accent: sanitizeHexColor(raw?.accent, fallback.accent),
    text: sanitizeHexColor(raw?.text, fallback.text),
    border: sanitizeHexColor(raw?.border, fallback.border),
  };
}

function sanitizeCustomTheme(
  raw: Partial<CustomThemeSettingsRecord> | undefined | null
): CustomThemeSettingsRecord {
  const activeFor =
    raw?.activeFor === 'design1' || raw?.activeFor === 'design2' ? raw.activeFor : 'none';
  return {
    activeFor,
    design1: sanitizePalette(raw?.design1, DEFAULT_DESIGN1_PALETTE),
    design2: sanitizePalette(raw?.design2, DEFAULT_DESIGN2_PALETTE),
  };
}

const VALID_NIGHT_THEMES = new Set<AutoThemeNightTarget>([
  'cinema-amber',
  'nordic-cyan',
  'emerald-vault',
  'crimson-premiere',
  'amethyst-studio',
  'silver-glass',
]);

function sanitizeTimeHHMM(val: unknown, fallback: string): string {
  if (typeof val !== 'string') return fallback;
  const match = val.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function sanitizeAutoTheme(
  raw: Partial<AutoThemeConfigRecord> | undefined | null,
  fallbackNight?: ThemePresetId
): AutoThemeConfigRecord {
  const mode: AutoThemeMode =
    raw?.mode === 'time' || raw?.mode === 'location' ? raw.mode : 'off';
  const dayTheme: AutoThemeDayTarget =
    raw?.dayTheme === 'high-contrast' ? 'high-contrast' : 'light';
  const nightCandidate = raw?.nightTheme ?? fallbackNight;
  const nightTheme: AutoThemeNightTarget =
    nightCandidate && VALID_NIGHT_THEMES.has(nightCandidate as AutoThemeNightTarget)
      ? (nightCandidate as AutoThemeNightTarget)
      : 'cinema-amber';
  const latitude =
    typeof raw?.latitude === 'number' &&
    Number.isFinite(raw.latitude) &&
    raw.latitude >= -90 &&
    raw.latitude <= 90
      ? Math.round(raw.latitude * 10000) / 10000
      : null;
  const longitude =
    typeof raw?.longitude === 'number' &&
    Number.isFinite(raw.longitude) &&
    raw.longitude >= -180 &&
    raw.longitude <= 180
      ? Math.round(raw.longitude * 10000) / 10000
      : null;
  return {
    mode,
    dayTheme,
    nightTheme,
    dayStartTime: sanitizeTimeHHMM(raw?.dayStartTime, '07:00'),
    nightStartTime: sanitizeTimeHHMM(raw?.nightStartTime, '19:00'),
    latitude,
    longitude,
    locationLabel:
      typeof raw?.locationLabel === 'string' && raw.locationLabel.trim().length > 0
        ? raw.locationLabel.trim().slice(0, 100)
        : null,
    lastLocationUpdatedAt:
      typeof raw?.lastLocationUpdatedAt === 'string' && raw.lastLocationUpdatedAt.trim().length > 0
        ? raw.lastLocationUpdatedAt.trim().slice(0, 64)
        : null,
  };
}

interface PreferencesStore {
  users: Record<string, UserPreferencesRecord>;
}

const VALID_THEMES = new Set<ThemePresetId>([
  'cinema-amber',
  'nordic-cyan',
  'emerald-vault',
  'crimson-premiere',
  'amethyst-studio',
  'silver-glass',
  'light',
  'high-contrast',
]);

const DEFAULT_HOME_ORDER: HomeRowKey[] = [
  'ask_duck',
  'recommendations',
  'duck_radar',
  'movie',
  'series',
  'continue',
  'recent',
  'watchlist',
  'recently_added',
  'image',
  'music',
  'video',
  'other',
];

const VALID_HOME_TOGGLE_KEYS = new Set<HomeToggleKey>(DEFAULT_HOME_ORDER);

function sanitizePreferences(input?: Partial<UserPreferencesRecord> | null): UserPreferencesRecord {
  const theme: ThemePresetId =
    input?.theme && VALID_THEMES.has(input.theme) ? input.theme : 'cinema-amber';
  const validSet = new Set<HomeRowKey>(DEFAULT_HOME_ORDER);
  const incoming = Array.isArray(input?.homeSectionOrder) ? input!.homeSectionOrder : [];
  const seen = new Set<HomeRowKey>();
  const ordered: HomeRowKey[] = [];
  for (const key of incoming) {
    if (validSet.has(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  const prependMissing: HomeRowKey[] = [];
  for (const fallbackKey of DEFAULT_HOME_ORDER) {
    if (!seen.has(fallbackKey)) {
      seen.add(fallbackKey);
      if (fallbackKey === 'ask_duck' || fallbackKey === 'recommendations') {
        prependMissing.push(fallbackKey);
        continue;
      }
      if (fallbackKey === 'duck_radar') {
        const recIdx = ordered.indexOf('recommendations');
        if (recIdx >= 0) {
          ordered.splice(recIdx + 1, 0, fallbackKey);
          continue;
        }
        prependMissing.push(fallbackKey);
        continue;
      }
      if (fallbackKey === 'recently_added') {
        const wlIdx = ordered.indexOf('watchlist');
        if (wlIdx >= 0) {
          ordered.splice(wlIdx + 1, 0, fallbackKey);
          continue;
        }
      }
      ordered.push(fallbackKey);
    }
  }
  if (prependMissing.length > 0) {
    ordered.unshift(...prependMissing);
  }

  const incomingHidden = Array.isArray(input?.hiddenHomeSections)
    ? input!.hiddenHomeSections
    : [];
  const hiddenSet = new Set<HomeToggleKey>();
  const hiddenHomeSections: HomeToggleKey[] = [];
  for (const key of incomingHidden) {
    if (VALID_HOME_TOGGLE_KEYS.has(key) && !hiddenSet.has(key)) {
      hiddenSet.add(key);
      hiddenHomeSections.push(key);
    }
  }

  const audioPlayerMode: AudioPlayerMode =
    input?.audioPlayerMode === 'external' ? 'external' : 'internal';
  const duckAssistantEnabled = input?.duckAssistantEnabled !== false;
  const showHomeCategoryTabs = input?.showHomeCategoryTabs === true;
  const showHomeFilterSearch = input?.showHomeFilterSearch === true;

  const rawTimeout = Number(input?.playerControlsTimeoutSec);
  const playerControlsTimeoutSec =
    Number.isFinite(rawTimeout) && rawTimeout >= 0
      ? rawTimeout === 0
        ? 0
        : Math.max(1, Math.min(120, Math.round(rawTimeout)))
      : 3;

  const rawBackward = Number(input?.playerSeekBackwardSec);
  const playerSeekBackwardSec =
    Number.isFinite(rawBackward) && rawBackward >= 5
      ? Math.max(5, Math.min(3600, Math.round(rawBackward)))
      : 30;

  const rawForward = Number(input?.playerSeekForwardSec);
  const playerSeekForwardSec =
    Number.isFinite(rawForward) && rawForward >= 5
      ? Math.max(5, Math.min(3600, Math.round(rawForward)))
      : 30;

  const calendarNotificationMode: CalendarNotificationMode =
    input?.calendarNotificationMode &&
    VALID_CALENDAR_NOTIFICATION_MODES.has(input.calendarNotificationMode)
      ? input.calendarNotificationMode
      : 'favorites_all';

  const filmNotificationMode: FilmNotificationMode =
    input?.filmNotificationMode === 'all' ? 'all' : 'favorites';

  return {
    theme,
    customTheme: sanitizeCustomTheme(input?.customTheme),
    autoTheme: sanitizeAutoTheme(input?.autoTheme, theme),
    homeSectionOrder: ordered,
    hiddenHomeSections,
    showHomeCategoryTabs,
    showHomeFilterSearch,
    audioPlayerMode,
    duckAssistantEnabled,
    playerControlsTimeoutSec,
    playerSeekBackwardSec,
    playerSeekForwardSec,
    calendarNotificationMode,
    filmNotificationMode,
  };
}

interface CalendarReleaseRecord {
  id: string;
  tmdbId: number;
  title: string;
  season: number;
  episode: number;
  episodeTitle: string;
  releaseDate: string;
  provider: StreamingProviderDE;
  genre: string;
  coverKey?: string;
  coverUrl?: string;
  synopsis?: string;
  cast?: string[];
  isSeasonPremiere: boolean;
  fsk?: FskLevel;
  seriesStatus?: SeriesProductionStatus;
  seriesStatusDetail?: string;
}

interface CalendarStore {
  releases: CalendarReleaseRecord[];
  sources?: FilmGroundSourceRecord[];
  lastFetchedAt?: string | null;
  fetchMethod?: 'gemini-search' | 'live-web' | 'mixed' | 'cache';
}

interface NasAddedCategoryGroupRecord {
  category: string;
  kind: MediaKind;
  titles: string[];
}

type AdminNotificationMessageType = 'maintenance' | 'new_content' | 'general';

interface NotificationRecord {
  id: string;
  username: string;
  seriesTitle: string;
  info: string;
  provider: CalendarReleaseRecord['provider'] | 'EntenCenter NAS' | string;
  releaseDate: string;
  releaseId: string;
  createdAt: string;
  read: boolean;
  triggerType:
    | 'auto_favorite'
    | 'manual_favorite'
    | 'duck_nas_added'
    | 'film_favorite_start'
    | 'admin_broadcast';
  messageType?: AdminNotificationMessageType;
  senderLabel?: string;
  categoryItems?: NasAddedCategoryGroupRecord[];
  totalAddedCount?: number;
}

interface NotificationsStore {
  alerts: NotificationRecord[];
  dismissedIds?: Record<string, string[]>;
}

function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, actualSalt, 32).toString('hex');
  return { salt: actualSalt, hash: derived };
}

type NasProtocolId =
  | 'smb'
  | 'nfs'
  | 'webdav'
  | 'sftp'
  | 'ftps'
  | 'api_token'
  | 'fritz_upnp';

interface StoredNasConnection {
  protocol: NasProtocolId;
  host: string;
  port: string;
  shareOrPath: string;
  username: string;
  encryptedSecret?: string | null;
  fritzUsername?: string;
  encryptedFritzSecret?: string | null;
  accessMode?: 'read_write' | 'read_only';
  writePermissions?: boolean;
  domainOrWorkgroup?: string;
  nfsVersion?: 'NFSv4.1' | 'NFSv4' | 'NFSv3';
  nfsAuthMode?: 'AUTH_SYS' | 'Kerberos (krb5p)';
  sftpAuthMode?: 'password' | 'ssh_key';
  ftpsTlsMode?: 'explicit' | 'implicit';
  apiVendor?: 'Synology DSM' | 'QNAP QTS' | 'TrueNAS Scale' | 'Unraid' | 'OpenMediaVault' | 'Western Digital';
  useTls?: boolean;
  backendPath?: string;
  backendProvisioned?: boolean;
  storageBridgeMode?: boolean;
  updatedAt: string | null;
}

interface NasConnectionsStore {
  users: Record<string, StoredNasConnection>;
}

const ALL_NAS_PROTOCOLS: NasProtocolId[] = [
  'smb',
  'nfs',
  'webdav',
  'sftp',
  'ftps',
  'api_token',
  'fritz_upnp',
];

const VALID_NAS_PROTOCOLS = new Set<NasProtocolId>(ALL_NAS_PROTOCOLS);

function sanitizeAllowedNasProtocols(raw: unknown): NasProtocolId[] {
  if (!Array.isArray(raw)) {
    return [...ALL_NAS_PROTOCOLS];
  }
  const seen = new Set<NasProtocolId>();
  const list: NasProtocolId[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && VALID_NAS_PROTOCOLS.has(item as NasProtocolId)) {
      const proto = item as NasProtocolId;
      if (!seen.has(proto)) {
        seen.add(proto);
        list.push(proto);
      }
    }
  }
  return list.length > 0 ? list : [...ALL_NAS_PROTOCOLS];
}

function readAllowedNasProtocols(): NasProtocolId[] {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
    allowedNasProtocols: [...ALL_NAS_PROTOCOLS],
  });
  return sanitizeAllowedNasProtocols(settings.allowedNasProtocols);
}

const NAS_CONN_KEY = crypto.scryptSync(HMAC_SECRET, 'marcente-nas-connection-salt', 32);

function encryptNasSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', NAS_CONN_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptNasSecret(encoded?: string | null): string | null {
  if (!encoded || typeof encoded !== 'string') return null;
  const parts = encoded.split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', NAS_CONN_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const USER_DATA_FILES = new Set<string>([
  'users.json',
  'preferences.json',
  'watchlist.json',
  'favorites.json',
  'history.json',
  'collections.json',
  'behavior.json',
  'notifications.json',
  'nas_connections.json',
]);

let cloudAutoSyncReady = false;
let cloudVaultSyncTimer: ReturnType<typeof setTimeout> | null = null;
let isUpdatingCloudVault = false;

function getDefaultNasConnection(): StoredNasConnection {
  return {
    protocol: 'smb',
    host: '',
    port: '445',
    shareOrPath: '/Medien',
    username: '',
    encryptedSecret: null,
    fritzUsername: '',
    encryptedFritzSecret: null,
    accessMode: 'read_write',
    writePermissions: true,
    domainOrWorkgroup: 'WORKGROUP',
    nfsVersion: 'NFSv4.1',
    nfsAuthMode: 'AUTH_SYS',
    sftpAuthMode: 'password',
    ftpsTlsMode: 'explicit',
    apiVendor: 'Synology DSM',
    useTls: true,
    backendPath: '',
    backendProvisioned: false,
    storageBridgeMode: false,
    updatedAt: null,
  };
}

function toPublicNasConnection(record: StoredNasConnection) {
  const isFritzUpnp = record.protocol === 'fritz_upnp';
  const writePermissions = isFritzUpnp
    ? true
    : typeof record.writePermissions === 'boolean'
      ? record.writePermissions
      : record.accessMode !== 'read_only';
  const accessMode: 'read_write' | 'read_only' = isFritzUpnp
    ? 'read_write'
    : record.accessMode === 'read_only' && !writePermissions
      ? 'read_only'
      : 'read_write';

  return {
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    shareOrPath: record.shareOrPath,
    username: record.username,
    hasSecret: Boolean(record.encryptedSecret),
    fritzUsername: record.fritzUsername ?? '',
    hasFritzSecret: Boolean(record.encryptedFritzSecret),
    accessMode,
    writePermissions,
    domainOrWorkgroup: record.domainOrWorkgroup ?? 'WORKGROUP',
    nfsVersion: record.nfsVersion ?? 'NFSv4.1',
    nfsAuthMode: record.nfsAuthMode ?? 'AUTH_SYS',
    sftpAuthMode: record.sftpAuthMode ?? 'password',
    ftpsTlsMode: record.ftpsTlsMode ?? 'explicit',
    apiVendor: record.apiVendor ?? 'Synology DSM',
    useTls: record.useTls ?? true,
    backendPath: record.backendPath ?? '',
    backendProvisioned: Boolean(record.backendProvisioned),
    storageBridgeMode: Boolean(record.storageBridgeMode),
    updatedAt: record.updatedAt,
  };
}

const nasStore = createNasJsonStore(NAS_DATA_DIR, {
  onBackupRestored: (filename, source) => {
    try {
      appendWal('NAS_AUTO_RECOVERED', 'system', { filename, source });
    } catch {
      // WAL-Fehler beim Boot/Recovery ignorieren
    }
  },
  onWriteBlocked: (filename, reason, existingCount, incomingCount) => {
    try {
      appendWal('NAS_WRITE_BLOCKED_ANTI_WIPE', 'system', {
        filename,
        reason,
        existingCount,
        incomingCount,
      });
    } catch {
      // WAL-Fehler ignorieren
    }
  },
  onAfterWrite: (filename) => {
    if (cloudAutoSyncReady && !isUpdatingCloudVault && USER_DATA_FILES.has(filename)) {
      scheduleAutoCloudVaultEncryption(filename);
    }
  },
});

function ensureNasDataDir(): void {
  nasStore.ensureDirs();
}

function readJsonFile<T>(filename: string, fallback: T): T {
  return nasStore.readJsonFile<T>(filename, fallback);
}

function writeJsonAtomic(filename: string, data: unknown, options: WriteJsonOptions = {}): void {
  nasStore.writeJsonAtomic(filename, data, options);
}

function appendWal(event: string, username: string, payload: unknown): void {
  ensureNasDataDir();
  const walPath = path.join(NAS_DATA_DIR, 'nas_wal.jsonl');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    username,
    payload,
  });
  fs.appendFileSync(walPath, line + '\n', 'utf-8');
}

function ensureNasSeedData(): void {
  ensureNasDataDir();

  if (nasStore.isStoreDefinitelyMissing('users.json')) {
    const demoPass = hashPassword('marcente123');
    const familyPass = hashPassword('ente2026');
    const initialUsers: Record<string, StoredUser> = {
      kevin: {
        id: 'usr-kevin',
        username: 'kevin',
        displayName: 'Kevin (Admin)',
        role: 'admin',
        fskLimit: 18,
        salt: demoPass.salt,
        passwordHash: demoPass.hash,
        createdAt: '2026-10-01T18:00:00Z',
        avatarColor: '#EAB308',
      },
      elena: {
        id: 'usr-elena',
        username: 'elena',
        displayName: 'Elena (Wohnzimmer TV)',
        role: 'family',
        fskLimit: 18,
        salt: familyPass.salt,
        passwordHash: familyPass.hash,
        createdAt: '2026-10-04T12:30:00Z',
        avatarColor: '#38BDF8',
      },
    };
    writeJsonAtomic('users.json', initialUsers, { allowEmptyOverwrite: true, skipBackup: true });
  } else {
    try {
      const existingUsers = readJsonFile<Record<string, StoredUser>>('users.json', {});
      const userEntries = Object.entries(existingUsers);
      let usersChanged = false;
      const hasAdmin = userEntries.some(([, u]) => u.role === 'admin');
      const earliestUsername = userEntries
        .slice()
        .sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))[0]?.[0];

      for (const [uname, u] of userEntries) {
        if (u.fskLimit === undefined) {
          u.fskLimit = 18;
          usersChanged = true;
        }
        if (!hasAdmin && uname === earliestUsername) {
          u.role = 'admin';
          usersChanged = true;
        }
      }
      if (usersChanged) {
        writeJsonAtomic('users.json', existingUsers);
      }
    } catch (err) {
      console.error('[NAS-SCHUTZ] Konnte bestehende users.json beim Start nicht prüfen — unverändert belassen:', err);
    }
  }

  const seedCatalog: NasLibraryRecord[] = [
    {
      id: 'nas-dark-01',
      tmdbId: 70523,
      title: 'Schattenwald',
      kind: 'series',
      genre: 'Sci-Fi & Mystery',
      year: 2024,
      coverKey: 'posterDarkMatter',
      synopsis:
        'Nach dem Verschwinden eines Forschungsteams im Schwarzwald stößt eine Ermittlerin auf eine versiegelte Zeitschleuse aus den 1980er-Jahren.',
      codec: 'HEVC / MKV · 4K HDR10+',
      audioTracks: ['Deutsch (DTS-HD MA 5.1)', 'Original Deutsch (Atmos)'],
      subtitles: ['Deutsch', 'Deutsch (SDH)', 'Englisch'],
      totalDurationMinutes: 54,
      nasPath: '/mnt/nas/Serien/Schattenwald/S03E04.mkv',
      totalEpisodes: 24,
      defaultSeason: 3,
      defaultEpisode: 4,
      defaultEpisodeTitle: 'Der Riss im Sektor 4',
      seriesStatus: 'returning',
      seriesStatusDetail: 'Laufende Serie · Staffel 4 angekündigt',
    },
    {
      id: 'nas-nordic-02',
      tmdbId: 91244,
      title: 'Sturmfeuer Nordsee',
      kind: 'series',
      genre: 'Krimi & Thriller',
      year: 2025,
      coverKey: 'posterNordicCrime',
      synopsis:
        'Auf einer sturmumtosten Hallig deckt Kommissar Brandt ein Netzwerk aus verschwundenen Frachtschiffen und verschlüsselten Funkfeuern auf.',
      codec: 'AV1 / MKV · 4K Dolby Vision',
      audioTracks: ['Deutsch (EAC3 5.1)', 'Dänisch (Original)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 49,
      nasPath: '/mnt/nas/Serien/Sturmfeuer_Nordsee/S02E06.mkv',
      totalEpisodes: 16,
      defaultSeason: 2,
      defaultEpisode: 6,
      defaultEpisodeTitle: 'Leuchtfeuer 19',
      seriesStatus: 'returning',
      seriesStatusDetail: 'Laufende Serie · Staffel 3 in Vorbereitung',
    },
    {
      id: 'nas-krypto-05',
      tmdbId: 99310,
      title: 'Code Null: Frankfurt',
      kind: 'series',
      genre: 'Drama & Wirtschaft',
      year: 2023,
      coverKey: 'posterCyberBerlin',
      synopsis:
        'Insider-Thriller rund um ein Rechenzentrum am Frankfurter Knotenpunkt DE-CIX während eines europaweiten Blackouts.',
      codec: 'HEVC / MKV · 1080p',
      audioTracks: ['Deutsch (AC3 5.1)', 'Englisch'],
      subtitles: ['Deutsch'],
      totalDurationMinutes: 46,
      nasPath: '/mnt/nas/Serien/Code_Null_Frankfurt/S01E08.mkv',
      totalEpisodes: 8,
      defaultSeason: 1,
      defaultEpisode: 8,
      defaultEpisodeTitle: 'Notstrom',
    },
    {
      id: 'nas-bergwacht-06',
      tmdbId: 55104,
      title: 'Grenzgrat',
      kind: 'series',
      genre: 'Abenteuer & Krimi',
      year: 2026,
      coverKey: 'posterAlpineDoc',
      synopsis:
        'Eine deutsch-österreichische Spezialeinheit der Bergrettung ermittelt in mysteriösen Vermisstenfällen rund um einen abgelegenen Gletscherpass.',
      codec: 'AV1 / MKV · 4K HDR',
      audioTracks: ['Deutsch (Atmos)', 'Österreichisch'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 52,
      nasPath: '/mnt/nas/Serien/Grenzgrat/S01E02.mkv',
      totalEpisodes: 10,
      defaultSeason: 1,
      defaultEpisode: 2,
      defaultEpisodeTitle: 'Eisspalte',
      seriesStatus: 'ended',
      seriesStatusDetail: 'Serie regulär beendet · Abgeschlossene Miniserie (10 Folgen, 2026)',
    },
    {
      id: 'nas-berlin-03',
      tmdbId: 84102,
      title: 'Nachtlinie Berlin',
      kind: 'movie',
      genre: 'Neo-Noir Thriller',
      year: 2025,
      coverKey: 'posterCyberBerlin',
      synopsis:
        'Eine nächtliche Tramfahrt durch das verregnete Berlin verbindet drei Unbekannte, die denselben verschlüsselten USB-Stick jagen.',
      codec: 'H.265 / MP4 · 4K 24fps',
      audioTracks: ['Deutsch (TrueHD 7.1)', 'Englisch (Dub)'],
      subtitles: ['Deutsch', 'Englisch', 'Französisch'],
      totalDurationMinutes: 128,
      nasPath: '/mnt/nas/Filme/Nachtlinie_Berlin_2025.mp4',
    },
    {
      id: 'nas-alpen-04',
      tmdbId: 66018,
      title: 'Gipfelstille — Die Alpen',
      kind: 'movie',
      genre: 'Dokumentation',
      year: 2026,
      coverKey: 'posterAlpineDoc',
      synopsis:
        'Vier Jahreszeiten entlang der bayerischen und österreichischen Hochgrate: Gletscherforschung, Bergrettung und unberührte Wildnis in 8K-Masterqualität.',
      codec: 'AV1 / WebM · 4K HDR',
      audioTracks: ['Deutsch (Atmos)', 'Bairisch (Original)'],
      subtitles: ['Deutsch'],
      totalDurationMinutes: 96,
      nasPath: '/mnt/nas/Filme/Gipfelstille_Alpen.webm',
    },
    {
      id: 'nas-bunker-07',
      tmdbId: 44190,
      title: 'Akte Schwarzwald',
      kind: 'movie',
      genre: 'Mystery & Thriller',
      year: 2021,
      coverKey: 'posterDarkMatter',
      synopsis:
        'Ein Journalist rekonstruiert einen unaufgeklärten Vorfall aus dem Jahr 1989 rund um einen stillgelegten Militärbunker tief im Nordschwarzwald.',
      codec: 'HEVC / MKV · 4K',
      audioTracks: ['Deutsch (DTS 5.1)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 114,
      nasPath: '/mnt/nas/Filme/Akte_Schwarzwald_2021.mkv',
    },
    {
      id: 'nas-leuchtturm-08',
      tmdbId: 39201,
      title: 'Kaltwasser',
      kind: 'movie',
      genre: 'Krimi & Drama',
      year: 2022,
      coverKey: 'posterNordicCrime',
      synopsis:
        'Während einer Jahrhundertflut auf Amrum wird ein verlassenes Rettungsboot angeschwemmt — an Bord befindet sich nur ein verschlüsseltes Logbuch.',
      codec: 'H.265 / MP4 · 1080p',
      audioTracks: ['Deutsch (EAC3 5.1)'],
      subtitles: ['Deutsch'],
      totalDurationMinutes: 108,
      nasPath: '/mnt/nas/Filme/Kaltwasser_2022.mp4',
    },
    {
      id: 'nas-elbe-09',
      tmdbId: 77412,
      title: 'Die Elbe-Akte',
      kind: 'series',
      genre: 'Krimi & Historie',
      year: 2025,
      coverKey: 'posterNordicCrime',
      synopsis:
        'Im Hamburger Hafen stoßen Wasserschutzpolizei und Archivare auf jahrzehntealte Schmuggelakten aus dem Kalten Krieg.',
      codec: 'HEVC / MKV · 4K',
      audioTracks: ['Deutsch (DTS 5.1)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 48,
      nasPath: '/mnt/nas/Serien/Die_Elbe_Akte/S01E05.mkv',
      totalEpisodes: 8,
      defaultSeason: 1,
      defaultEpisode: 5,
      defaultEpisodeTitle: 'Speicherstadt 1978',
      seriesStatus: 'canceled',
      seriesStatusDetail: 'Serie eingestellt · Nach Staffel 1 abgesetzt (keine Fortsetzung)',
    },
    {
      id: 'nas-img-nordsee-10',
      tmdbId: 880101,
      title: 'Nordsee Küstenlicht (RAW-Archiv)',
      kind: 'image',
      genre: 'Fotografie & Landschaft',
      year: 2025,
      coverKey: 'coverNasBilder',
      synopsis:
        'Hochauflösende Küsten- und Dünenaufnahmen von Sylt und Amrum im unkomprimierten DNG-RAW- und JPEG-Format direkt aus dem NAS-Fotoordner.',
      codec: 'JPG / DNG RAW · 45 MP',
      audioTracks: ['Keine Tonspur (Bilddatei)'],
      subtitles: [],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Bilder/Urlaub/Nordsee_2025/Kuestenlicht_RAW.jpg',
      fileFormat: 'JPG / RAW',
      fileSize: '4,8 GB',
    },
    {
      id: 'nas-img-architektur-11',
      tmdbId: 880102,
      title: 'Bauhaus Dessau Portfolio',
      kind: 'image',
      genre: 'Architektur & Design',
      year: 2024,
      coverKey: 'coverNasBilder',
      synopsis:
        'Architektur-Fotoserie über geometrische Fassaden, Lichtstudien und historische Meisterhäuser in verlustfreier PNG- und TIFF-Qualität.',
      codec: 'PNG / TIFF · 600 DPI',
      audioTracks: ['Keine Tonspur (Bilddatei)'],
      subtitles: [],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Bilder/Architektur/Bauhaus_Dessau_Portfolio.png',
      fileFormat: 'PNG / TIFF',
      fileSize: '1,9 GB',
    },
    {
      id: 'nas-img-alpen-12',
      tmdbId: 880103,
      title: 'Alpenwanderung Sommerbilder',
      kind: 'image',
      genre: 'Natur & Panorama',
      year: 2026,
      coverKey: 'stillGrenzgrat',
      synopsis:
        'Panoramen und Bergaufnahmen entlang des Hauptkamms im 16-Bit-Farbraum für digitale Bilderrahmen und Heimkino-Diashows.',
      codec: 'JPG / HEIC · 24 MP',
      audioTracks: ['Keine Tonspur (Bilddatei)'],
      subtitles: [],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Bilder/Familie/Alpen_2026/Panorama_01.jpg',
      fileFormat: 'JPG / HEIC',
      fileSize: '2,1 GB',
    },
    {
      id: 'nas-music-nachteulen-13',
      tmdbId: 880201,
      title: 'Mitternachts-Synthesizer (Album)',
      kind: 'music',
      genre: 'Electronic & Ambient',
      year: 2025,
      coverKey: 'coverNasMusik',
      synopsis:
        'Analoge Synthesizer-Tracks und warme Ambient-Klanglandschaften als gemasterte MP3-Dateien mit 320 kbps direkt vom NAS-Musikshare.',
      codec: 'MP3 · 320 kbps CBR Stereo',
      audioTracks: ['Stereo 44.1 kHz (MP3 320 kbps)'],
      subtitles: ['ID3v2 Songtexte'],
      totalDurationMinutes: 52,
      nasPath: '/mnt/nas/Musik/Alben/Mitternachts_Synthesizer.mp3',
      fileFormat: 'MP3',
      fileSize: '124 MB',
    },
    {
      id: 'nas-music-jazz-14',
      tmdbId: 880202,
      title: 'Hamburg Jazz Trio — Speicherstadt Vinyl',
      kind: 'music',
      genre: 'Jazz & Akustik',
      year: 2024,
      coverKey: 'coverNasMusik',
      synopsis:
        'Live-Studioaufnahme eines akustischen Jazz-Trios in verlustfreier 24-Bit/96-kHz-FLAC-Qualität aus der NAS-Musiksammlung.',
      codec: 'FLAC · 24-Bit / 96 kHz Lossless',
      audioTracks: ['FLAC 24-Bit / 96 kHz Stereo'],
      subtitles: ['Digitales Booklet'],
      totalDurationMinutes: 46,
      nasPath: '/mnt/nas/Musik/Lossless/Hamburg_Jazz_Trio.flac',
      fileFormat: 'FLAC',
      fileSize: '890 MB',
    },
    {
      id: 'nas-music-score-15',
      tmdbId: 880203,
      title: 'Nordlicht Filmscore Collection',
      kind: 'music',
      genre: 'Soundtrack & Klassik',
      year: 2026,
      coverKey: 'coverNasMusik',
      synopsis:
        'Orchestrierte Film- und Serien-Soundtracks skandinavischer Komponisten im MP3- und AAC-Format für verlustarme Heimkino-Wiedergabe.',
      codec: 'MP3 / AAC · 320 kbps',
      audioTracks: ['Stereo MP3 320 kbps', 'AAC 256 kbps'],
      subtitles: [],
      totalDurationMinutes: 64,
      nasPath: '/mnt/nas/Musik/Soundtracks/Nordlicht_Collection.mp3',
      fileFormat: 'MP3 / AAC',
      fileSize: '152 MB',
    },
    {
      id: 'nas-vid-drohne-16',
      tmdbId: 880301,
      title: 'Lofoten Drohnenflug 4K60',
      kind: 'video',
      genre: 'Reisevideo & Natur',
      year: 2025,
      coverKey: 'coverNasVideo',
      synopsis:
        'Eigenständige Drohnen- und Kameraaufnahmen über norwegischen Fjorden in 4K 60fps — kein Spielfilm und keine Serie, sondern reines Videoarchiv.',
      codec: 'H.265 / MP4 · 4K 60fps',
      audioTracks: ['Ambient Stereo (AAC)'],
      subtitles: [],
      totalDurationMinutes: 18,
      nasPath: '/mnt/nas/Videos/Drohne/Lofoten_4K60_Master.mp4',
      fileFormat: 'MP4',
      fileSize: '3,6 GB',
    },
    {
      id: 'nas-vid-konzert-17',
      tmdbId: 880302,
      title: 'Elbphilharmonie Backstage Mitschnitt',
      kind: 'video',
      genre: 'Konzert & Aufnahme',
      year: 2024,
      coverKey: 'stillElbe',
      synopsis:
        'Unkomprimierter Multi-Kamera-Videomitschnitt einer Soundcheck-Probe im Hamburger Hafen — separates Videomaterial außerhalb von Film- und Serienordnern.',
      codec: 'ProRes 422 / MOV · 4K',
      audioTracks: ['PCM Stereo 48 kHz'],
      subtitles: [],
      totalDurationMinutes: 34,
      nasPath: '/mnt/nas/Videos/Aufnahmen/Elbphilharmonie_Backstage.mov',
      fileFormat: 'MOV',
      fileSize: '6,2 GB',
    },
    {
      id: 'nas-other-handbuch-18',
      tmdbId: 880401,
      title: 'NAS-Wartungshandbuch 2026.pdf',
      kind: 'other',
      genre: 'Dokumentation & PDF',
      year: 2026,
      coverKey: 'coverNasSonstiges',
      synopsis:
        'Vollständige PDF-Dokumentation zu RAID-Pools, SMART-Diagnose, SMB/NFS-Freigaben und Backup-Strategien direkt aus dem NAS-Dokumentenordner.',
      codec: 'PDF/A · 64 Seiten · Durchsuchbar',
      audioTracks: ['Dokumentdatei'],
      subtitles: [],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Sonstiges/Dokumente/NAS_Wartungshandbuch_2026.pdf',
      fileFormat: 'PDF',
      fileSize: '18,4 MB',
    },
    {
      id: 'nas-other-kalibrierung-19',
      tmdbId: 880402,
      title: 'Heimkino Kalibrierungs-Leitfaden.pdf',
      kind: 'other',
      genre: 'Technik & PDF',
      year: 2025,
      coverKey: 'coverNasSonstiges',
      synopsis:
        'Technisches PDF-Kompendium mit HDR10+-Testpattern-Tabellen, Dolby-Atmos-Lautsprecherwinkeln und Projektionsabständen.',
      codec: 'PDF 1.7 · 38 Seiten',
      audioTracks: ['Dokumentdatei'],
      subtitles: [],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Sonstiges/Anleitungen/Heimkino_Kalibrierung.pdf',
      fileFormat: 'PDF',
      fileSize: '11,2 MB',
    },
    {
      id: 'nas-other-archiv-20',
      tmdbId: 880403,
      title: 'Mediathek Begleitmaterial (EPUB / ZIP)',
      kind: 'other',
      genre: 'Archiv & E-Books',
      year: 2025,
      coverKey: 'coverNasSonstiges',
      synopsis:
        'Komprimiertes Begleitpaket mit Episodenguides im EPUB-Format, Untertitel-Archiven (.srt) und Cover-Vorlagen.',
      codec: 'ZIP / EPUB / SRT · Archiv',
      audioTracks: ['Archivdatei'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 1,
      nasPath: '/mnt/nas/Sonstiges/Archive/Mediathek_Begleitmaterial.zip',
      fileFormat: 'ZIP / EPUB',
      fileSize: '84,5 MB',
    },
    {
      id: 'nas-scificom-21',
      tmdbId: 881021,
      title: 'Orbit-Kantine 42',
      kind: 'series',
      genre: 'Sci-Fi & Comedy',
      year: 2025,
      coverKey: 'posterDarkMatter',
      synopsis:
        'Auf einer abgelegenen Raumstation am Rande des Kuipergürtels jongliert ein chaotisches Küchenteam zwischen Wurmloch-Pannen, trockener Satire und galaktischen Bürokraten.',
      codec: 'HEVC / MKV · 4K HDR',
      audioTracks: ['Deutsch (Atmos)', 'Englisch (Original)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 32,
      nasPath: '/mnt/nas/Serien/Orbit_Kantine_42/S01E03.mkv',
      totalEpisodes: 10,
      defaultSeason: 1,
      defaultEpisode: 3,
      defaultEpisodeTitle: 'Lasagne im Null-G-Sektor',
      seriesStatus: 'returning',
      seriesStatusDetail: 'Laufende Serie · Staffel 2 bestätigt',
    },
    {
      id: 'nas-scificom-22',
      tmdbId: 881022,
      title: 'Zeitsprung im Schreibbüro',
      kind: 'movie',
      genre: 'Sci-Fi & Comedy',
      year: 2024,
      coverKey: 'posterCyberBerlin',
      synopsis:
        'Ein verschlafener Behörden-ITler entdeckt im Keller-Serverraum eine Kaffeemaschine, die Nachrichten 24 Stunden in die Vergangenheit faxt — perfekt für herrliches Chaos.',
      codec: 'H.265 / MP4 · 4K',
      audioTracks: ['Deutsch (DTS-HD 5.1)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 106,
      nasPath: '/mnt/nas/Filme/Zeitsprung_im_Schreibbuero_2024.mp4',
    },
    {
      id: 'nas-krimithrill-23',
      tmdbId: 881023,
      title: 'Nebel über dem Hafen',
      kind: 'movie',
      genre: 'Thriller & Krimi',
      year: 2025,
      coverKey: 'posterNordicCrime',
      synopsis:
        'Kommissarin Brandt gerät bei einem verdeckten Ermittlungsfall im Hamburger Containerhafen in ein tödliches Katz-und-Maus-Spiel zwischen Zoll und Kartell.',
      codec: 'AV1 / MKV · 4K Dolby Vision',
      audioTracks: ['Deutsch (Atmos)', 'Englisch (Dub)'],
      subtitles: ['Deutsch', 'Englisch'],
      totalDurationMinutes: 118,
      nasPath: '/mnt/nas/Filme/Nebel_ueber_dem_Hafen_2025.mkv',
    },
  ];

  const SEED_ADDED_DATES: Record<string, string> = {
    'nas-bergwacht-06': '2026-11-13T19:15:00Z',
    'nas-scificom-21': '2026-11-13T12:00:00Z',
    'nas-krimithrill-23': '2026-11-12T22:15:00Z',
    'nas-alpen-04': '2026-11-12T20:40:00Z',
    'nas-other-handbuch-18': '2026-11-12T11:20:00Z',
    'nas-img-alpen-12': '2026-11-11T16:10:00Z',
    'nas-scificom-22': '2026-11-11T10:30:00Z',
    'nas-music-score-15': '2026-11-10T18:45:00Z',
    'nas-nordic-02': '2026-11-09T21:00:00Z',
    'nas-vid-drohne-16': '2026-11-08T14:30:00Z',
    'nas-berlin-03': '2026-11-06T20:15:00Z',
    'nas-elbe-09': '2026-11-04T19:50:00Z',
    'nas-img-nordsee-10': '2026-11-02T13:10:00Z',
    'nas-music-nachteulen-13': '2026-10-29T22:05:00Z',
    'nas-other-kalibrierung-19': '2026-10-25T10:15:00Z',
    'nas-dark-01': '2026-10-20T18:30:00Z',
    'nas-vid-konzert-17': '2026-10-16T17:00:00Z',
    'nas-other-archiv-20': '2026-10-12T09:45:00Z',
    'nas-img-architektur-11': '2026-10-08T15:20:00Z',
    'nas-music-jazz-14': '2026-10-03T19:10:00Z',
    'nas-krypto-05': '2026-09-24T20:00:00Z',
    'nas-leuchtturm-08': '2026-09-15T18:00:00Z',
    'nas-bunker-07': '2026-09-01T18:00:00Z',
  };

  const SEED_FSK_MAP: Record<string, FskLevel> = {
    'nas-dark-01': 16,
    'nas-nordic-02': 16,
    'nas-krypto-05': 12,
    'nas-bergwacht-06': 12,
    'nas-berlin-03': 16,
    'nas-alpen-04': 0,
    'nas-bunker-07': 18,
    'nas-leuchtturm-08': 12,
    'nas-elbe-09': 12,
    'nas-scificom-21': 12,
    'nas-scificom-22': 6,
    'nas-krimithrill-23': 16,
  };

  const SEED_RICH_META: Record<
    string,
    { cast: string[]; studio: string; director: string; moodTags: string[]; seasons: string[] }
  > = {
    'nas-dark-01': {
      cast: ['Louis Hofmann', 'Lisa Vicari', 'Oliver Masucci'],
      studio: 'Dark Ways / W&B Television',
      director: 'Baran bo Odar',
      moodTags: ['Science-Fiction', 'Zeitreise', 'Mystery', 'Düster', 'Spannend', 'Nachdenklich', 'Neo-Noir'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-nordic-02': {
      cast: ['Lars Mikkelsen', 'Sandra Hüller', 'Sebastian Koch'],
      studio: 'ZDF Studios / Nordic Film',
      director: 'Christian Schwochow',
      moodTags: ['Krimi', 'Thriller', 'Nordic Noir', 'Nordsee', 'Ermittlung', 'Atmosphärisch', 'Düster', 'Spannend'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-krypto-05': {
      cast: ['Paula Beer', 'Albrecht Schuch', 'Désirée Nosbusch'],
      studio: 'UFA Fiction',
      director: 'Christian Zübert',
      moodTags: ['Wirtschaftsthriller', 'Drama', 'Cyber-Thriller', 'Blackout', 'Frankfurt', 'Spannend'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-bergwacht-06': {
      cast: ['Maximilian Brückner', 'Nora Waldstätten', 'Nicholas Ofczarek'],
      studio: 'Bavaria Fiction / ORF',
      director: 'Marvin Kren',
      moodTags: ['Abenteuer', 'Krimi', 'Alpen', 'Bergrettung', 'Spannend', 'Dramatisch'],
      seasons: ['Winter', 'Frühling'],
    },
    'nas-berlin-03': {
      cast: ['Tom Schilling', 'Franz Rogowski', 'Jella Haase'],
      studio: 'X Filme Creative Pool',
      director: 'Tom Tykwer',
      moodTags: ['Neo-Noir', 'Thriller', 'Krimi', 'Nacht', 'Berlin', 'Düster', 'Spannend'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-alpen-04': {
      cast: ['Florian Silbereisen (Erzähler)', 'Reinhold Messner'],
      studio: 'Terra Mater Studios',
      director: 'Joseph Vilsmaier',
      moodTags: ['Dokumentation', 'Natur', 'Alpen', 'Familienfreundlich', 'Entspannt', 'Ruhig', '8K'],
      seasons: ['Frühling', 'Sommer', 'Herbst', 'Winter'],
    },
    'nas-bunker-07': {
      cast: ['Heino Ferch', 'Hannah Herzsprung', 'Moritz Bleibtreu'],
      studio: 'SWR / Wüste Film',
      director: 'Dennis Gansel',
      moodTags: ['Mystery', 'Thriller', 'Krimi', 'Verschwörung', 'Kalter Krieg', 'Düster', 'Spannend'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-leuchtturm-08': {
      cast: ['Charly Hübner', 'Devid Striesow', 'Nina Hoss'],
      studio: 'NDR / Studio Hamburg',
      director: 'Andreas Dresen',
      moodTags: ['Krimi', 'Drama', 'Nordic Noir', 'Insel', 'Sturm', 'Nachdenklich'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-elbe-09': {
      cast: ['Ronald Zehrfeld', 'Karoline Herfurth', 'Benno Fürmann'],
      studio: 'Studio Hamburg / Constantin Film',
      director: 'Fatih Akin',
      moodTags: ['Krimi', 'Historie', 'Hamburg', 'Hafen', 'Spionage', 'Retro'],
      seasons: ['Herbst', 'Frühling'],
    },
    'nas-img-nordsee-10': {
      cast: ['Jan Martens'],
      studio: 'EntenCenter Fotoarchiv',
      director: 'Jan Martens',
      moodTags: ['Fotografie', 'Bilder', 'RAW', 'Nordsee', 'Landschaft', 'Entspannt', 'Ruhig', 'Maritime Kunst'],
      seasons: ['Sommer', 'Herbst'],
    },
    'nas-img-architektur-11': {
      cast: ['Clara Weber', 'Studio Bauhaus Archiv'],
      studio: 'Dessau Design Vault',
      director: 'Clara Weber',
      moodTags: ['Architektur', 'Bilder', 'Bauhaus', 'Minimalismus', 'Design', 'PNG', 'Kunst', 'Ruhig'],
      seasons: ['Frühling', 'Herbst'],
    },
    'nas-img-alpen-12': {
      cast: ['Kevin', 'Familie & Bergfotografie'],
      studio: 'EntenCenter Familienarchiv',
      director: 'Kevin',
      moodTags: ['Alpen', 'Bilder', 'Panorama', 'Urlaub', 'Fröhlich', 'Entspannt', 'Naturfotografie'],
      seasons: ['Frühling', 'Sommer'],
    },
    'nas-music-nachteulen-13': {
      cast: ['Nachteulen Collective'],
      studio: 'Klangwerk Berlin Records',
      director: 'Nachteulen',
      moodTags: ['Musik', 'Electronic', 'Ambient', 'Synthwave', 'Synthesizer', 'Entspannt', 'Ruhig', 'Gemütlich', 'MP3'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-music-jazz-14': {
      cast: ['Hamburg Jazz Trio'],
      studio: 'Speicherstadt Records',
      director: 'Hamburg Jazz Trio',
      moodTags: ['Musik', 'Jazz', 'Akustik', 'FLAC', 'Vinyl', 'Gemütlich', 'Entspannt', 'Ruhig', 'Lounge'],
      seasons: ['Herbst', 'Winter', 'Frühling'],
    },
    'nas-music-score-15': {
      cast: ['Nordlicht Philharmonie', 'Ólafur Arnalds'],
      studio: 'Nordic Score Editions',
      director: 'Nordlicht Philharmonie',
      moodTags: ['Musik', 'Soundtrack', 'Klassik', 'Orchester', 'Neoklassik', 'Filmmusik', 'Episch', 'Nachdenklich', 'Ruhig', 'MP3'],
      seasons: ['Herbst', 'Winter', 'Frühling'],
    },
    'nas-vid-drohne-16': {
      cast: ['Luftbild-Team Nord'],
      studio: 'EntenCenter Videoarchiv',
      director: 'Kevin',
      moodTags: ['Video', 'Drohne', 'Norwegen', 'Lofoten', 'Entspannt', 'Natur', '4K60'],
      seasons: ['Sommer', 'Frühling'],
    },
    'nas-vid-konzert-17': {
      cast: ['Elbphilharmonie Ensemble'],
      studio: 'Hamburg Live Productions',
      director: 'Maren Kroymann',
      moodTags: ['Video', 'Konzert', 'Backstage', 'Hamburg', 'Klassik', 'Musikaufnahme'],
      seasons: ['Herbst', 'Winter'],
    },
    'nas-other-handbuch-18': {
      cast: ['EntenCenter Technik-Team'],
      studio: 'Synology / EntenCenter Docs',
      director: 'EntenCenter Docs',
      moodTags: ['PDF', 'Handbuch', 'NAS', 'Dokumentation', 'RAID'],
      seasons: ['Frühling', 'Sommer', 'Herbst', 'Winter'],
    },
    'nas-other-kalibrierung-19': {
      cast: ['Heimkino Labor DE'],
      studio: 'AV Calibration Press',
      director: 'Heimkino Labor',
      moodTags: ['PDF', 'Heimkino', 'HDR', 'Dolby Atmos', 'Technik'],
      seasons: ['Frühling', 'Sommer', 'Herbst', 'Winter'],
    },
    'nas-other-archiv-20': {
      cast: ['EntenCenter Redaktion'],
      studio: 'EntenCenter Archiv',
      director: 'Redaktion',
      moodTags: ['Archiv', 'ZIP', 'EPUB', 'Untertitel', 'Begleitmaterial'],
      seasons: ['Frühling', 'Sommer', 'Herbst', 'Winter'],
    },
    'nas-scificom-21': {
      cast: ['Bjarne Mädel', 'Karoline Herfurth', 'Florian David Fitz'],
      studio: 'Bavaria Fiction',
      director: 'Arne Feldhusen',
      moodTags: ['Science-Fiction', 'Comedy', 'Comedy-Anteil', 'Satire', 'Weltraum', 'Humor', 'Lustig', 'Leicht'],
      seasons: ['Frühling', 'Sommer'],
    },
    'nas-scificom-22': {
      cast: ['Elyas M’Barek', 'Jella Haase', 'Matthias Schweighöfer'],
      studio: 'Constantin Film',
      director: 'Bora Dagtekin',
      moodTags: ['Science-Fiction', 'Comedy', 'Comedy-Anteil', 'Zeitreise', 'Bürohumor', 'Humor', 'Lustig', 'Leicht'],
      seasons: ['Frühling', 'Sommer'],
    },
    'nas-krimithrill-23': {
      cast: ['Moritz Bleibtreu', 'Lars Eidinger', 'Nina Hoss'],
      studio: 'UFA Fiction',
      director: 'Christian Alvart',
      moodTags: ['Thriller', 'Krimi', 'Neo-Noir', 'Hafen', 'Ermittlung', 'Spannend', 'Düster', 'Film'],
      seasons: ['Herbst', 'Winter'],
    },
  };

  for (const seedItem of seedCatalog) {
    seedItem.addedAt = SEED_ADDED_DATES[seedItem.id] ?? `${seedItem.year}-06-01T12:00:00Z`;
    seedItem.fsk = SEED_FSK_MAP[seedItem.id] ?? 0;
    const rich = SEED_RICH_META[seedItem.id];
    if (rich) {
      seedItem.cast = rich.cast;
      seedItem.studio = rich.studio;
      seedItem.director = rich.director;
      seedItem.moodTags = rich.moodTags;
      seedItem.seasons = rich.seasons;
    }
  }

  if (nasStore.isStoreDefinitelyMissing('catalog.json')) {
    writeJsonAtomic('catalog.json', seedCatalog, { allowEmptyOverwrite: true, skipBackup: true });
  } else {
    try {
      const existing = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
      const seedCatalogById = new Map(seedCatalog.map((item) => [item.id, item]));
      let changed = false;
      const enriched = existing.map((item) => {
        const seedMatch = seedCatalogById.get(item.id);
        const richMatch = SEED_RICH_META[item.id];
        const needsAddedAt = !item.addedAt;
        const needsSeriesStatus =
          item.seriesStatus === undefined && seedMatch?.seriesStatus !== undefined;
        const needsFsk = item.fsk === undefined;
        const needsSeasons = richMatch !== undefined && !item.seasons;
        const needsRichMeta =
          richMatch !== undefined &&
          (!item.cast || !item.studio || !item.director || !item.moodTags || !item.seasons);
        if (!needsAddedAt && !needsSeriesStatus && !needsFsk && !needsRichMeta && !needsSeasons) {
          return item;
        }
        changed = true;
        return {
          ...item,
          addedAt: item.addedAt ?? SEED_ADDED_DATES[item.id] ?? `${item.year}-06-01T12:00:00Z`,
          fsk: item.fsk ?? seedMatch?.fsk ?? 0,
          ...(needsSeriesStatus
            ? {
                seriesStatus: seedMatch!.seriesStatus,
                seriesStatusDetail: seedMatch!.seriesStatusDetail,
              }
            : {}),
          ...(richMatch
            ? {
                cast: item.cast ?? richMatch.cast,
                studio: item.studio ?? richMatch.studio,
                director: item.director ?? richMatch.director,
                moodTags: needsSeasons
                  ? Array.from(new Set([...(item.moodTags ?? []), ...richMatch.moodTags]))
                  : (item.moodTags ?? richMatch.moodTags),
                seasons: item.seasons ?? richMatch.seasons,
              }
            : {}),
        };
      });
      const existingIds = new Set(enriched.map((item) => item.id));
      const missing = seedCatalog.filter((item) => !existingIds.has(item.id));
      if (missing.length > 0 || changed) {
        writeJsonAtomic('catalog.json', [...enriched, ...missing]);
      }
    } catch (err) {
      console.error('[NAS-SCHUTZ] Konnte bestehende catalog.json beim Start nicht prüfen — unverändert belassen:', err);
    }
  }

  const seedWatches: WatchHistoryEntry[] = [
    {
      username: 'kevin',
      mediaId: 'nas-dark-01',
      tmdbId: 70523,
      title: 'Schattenwald',
      mediaType: 'series',
      genre: 'Sci-Fi & Mystery',
      watchedMinutes: 38,
      episodesWatched: 14,
      currentSeason: 3,
      currentEpisode: 4,
      currentEpisodeTitle: 'Der Riss im Sektor 4',
      lastWatchedAt: '2026-11-11T21:40:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-nordic-02',
      tmdbId: 91244,
      title: 'Sturmfeuer Nordsee',
      mediaType: 'series',
      genre: 'Krimi & Thriller',
      watchedMinutes: 49,
      episodesWatched: 10,
      currentSeason: 2,
      currentEpisode: 6,
      currentEpisodeTitle: 'Leuchtfeuer 19',
      lastWatchedAt: '2026-11-10T20:15:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-berlin-03',
      tmdbId: 84102,
      title: 'Nachtlinie Berlin',
      mediaType: 'movie',
      genre: 'Neo-Noir Thriller',
      watchedMinutes: 128,
      episodesWatched: 1,
      lastWatchedAt: '2026-11-08T22:10:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-alpen-04',
      tmdbId: 66018,
      title: 'Gipfelstille — Die Alpen',
      mediaType: 'movie',
      genre: 'Dokumentation',
      watchedMinutes: 64,
      episodesWatched: 1,
      lastWatchedAt: '2026-11-06T19:05:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-krypto-05',
      tmdbId: 99310,
      title: 'Code Null: Frankfurt',
      mediaType: 'series',
      genre: 'Drama & Wirtschaft',
      watchedMinutes: 46,
      episodesWatched: 8,
      currentSeason: 1,
      currentEpisode: 8,
      currentEpisodeTitle: 'Notstrom',
      lastWatchedAt: '2026-10-18T20:45:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-bergwacht-06',
      tmdbId: 55104,
      title: 'Grenzgrat',
      mediaType: 'series',
      genre: 'Abenteuer & Krimi',
      watchedMinutes: 52,
      episodesWatched: 6,
      currentSeason: 1,
      currentEpisode: 6,
      currentEpisodeTitle: 'Eisspalte',
      lastWatchedAt: '2026-09-24T21:15:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-bunker-07',
      tmdbId: 44190,
      title: 'Akte Schwarzwald',
      mediaType: 'movie',
      genre: 'Mystery & Thriller',
      watchedMinutes: 114,
      episodesWatched: 1,
      lastWatchedAt: '2026-08-14T22:00:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-leuchtturm-08',
      tmdbId: 39201,
      title: 'Kaltwasser',
      mediaType: 'movie',
      genre: 'Krimi & Drama',
      watchedMinutes: 108,
      episodesWatched: 1,
      lastWatchedAt: '2025-11-19T20:30:00Z',
    },
    {
      username: 'kevin',
      mediaId: 'nas-elbe-09',
      tmdbId: 77412,
      title: 'Die Elbe-Akte',
      mediaType: 'series',
      genre: 'Krimi & Historie',
      watchedMinutes: 48,
      episodesWatched: 5,
      currentSeason: 1,
      currentEpisode: 5,
      currentEpisodeTitle: 'Speicherstadt 1978',
      lastWatchedAt: '2026-04-16T20:30:00Z',
    },
    {
      username: 'elena',
      mediaId: 'nas-alpen-04',
      tmdbId: 66018,
      title: 'Gipfelstille — Die Alpen',
      mediaType: 'movie',
      genre: 'Dokumentation',
      watchedMinutes: 96,
      episodesWatched: 1,
      lastWatchedAt: '2026-11-09T19:30:00Z',
    },
    {
      username: 'elena',
      mediaId: 'nas-krypto-05',
      tmdbId: 99310,
      title: 'Code Null: Frankfurt',
      mediaType: 'series',
      genre: 'Drama & Wirtschaft',
      watchedMinutes: 46,
      episodesWatched: 4,
      currentSeason: 1,
      currentEpisode: 4,
      currentEpisodeTitle: 'Kaltstart',
      lastWatchedAt: '2026-10-14T20:00:00Z',
    },
    {
      username: 'elena',
      mediaId: 'nas-bergwacht-06',
      tmdbId: 55104,
      title: 'Grenzgrat',
      mediaType: 'series',
      genre: 'Abenteuer & Krimi',
      watchedMinutes: 52,
      episodesWatched: 3,
      currentSeason: 1,
      currentEpisode: 3,
      currentEpisodeTitle: 'Nebelwand',
      lastWatchedAt: '2026-09-12T21:00:00Z',
    },
    {
      username: 'elena',
      mediaId: 'nas-bunker-07',
      tmdbId: 44190,
      title: 'Akte Schwarzwald',
      mediaType: 'movie',
      genre: 'Mystery & Thriller',
      watchedMinutes: 114,
      episodesWatched: 1,
      lastWatchedAt: '2026-08-19T21:30:00Z',
    },
  ];

  if (nasStore.isStoreDefinitelyMissing('history.json')) {
    writeJsonAtomic('history.json', { watches: seedWatches }, { allowEmptyOverwrite: true, skipBackup: true });
  } else {
    try {
      const existingHistory = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', {
        watches: [],
      });
      const existingKeys = new Set(
        existingHistory.watches.map((w) => `${w.username}::${w.mediaId}`)
      );
      const missingWatches = seedWatches.filter(
        (w) => !existingKeys.has(`${w.username}::${w.mediaId}`)
      );
      if (missingWatches.length > 0) {
        writeJsonAtomic('history.json', {
          watches: [...existingHistory.watches, ...missingWatches],
        });
      }
    } catch (err) {
      console.error('[NAS-SCHUTZ] Konnte bestehende history.json beim Start nicht prüfen — unverändert belassen:', err);
    }
  }

  const seedReleases: CalendarReleaseRecord[] = [
    {
      id: 'de-70523-s4e1',
      tmdbId: 70523,
      title: 'Schattenwald',
      season: 4,
      episode: 1,
      episodeTitle: 'Rückkehr zum Ursprung',
      releaseDate: '2026-11-12',
      provider: 'Netflix',
      genre: 'Sci-Fi & Mystery',
      coverKey: 'posterDarkMatter',
      synopsis:
        'In der vierten Staffel öffnen die Forscher im Schwarzwald das letzte unkartierte Portal unter der alten Radarstation — doch jede Reise verändert die Zeitlinie in der Gegenwart.',
      cast: ['Hannah Bergmann', 'Jonas Richter', 'Katja Lorenz', 'Moritz Lindner'],
      isSeasonPremiere: true,
      seriesStatus: 'returning',
      seriesStatusDetail: 'Laufende Serie · Staffel 4 angekündigt',
    },
    {
      id: 'de-91244-s3e1',
      tmdbId: 91244,
      title: 'Sturmfeuer Nordsee',
      season: 3,
      episode: 1,
      episodeTitle: 'Winterflut',
      releaseDate: '2026-11-16',
      provider: 'ARD Mediathek',
      genre: 'Krimi & Thriller',
      coverKey: 'posterNordicCrime',
      synopsis:
        'Während einer schweren Wintersturmflut wird auf der Hallig ein verschollener Container an Land gespült. Kommissar Brandt gerät in ein gefährliches Geflecht aus Offshore-Firmen.',
      cast: ['Henrik Petersen', 'Maren Thomsen', 'Lukas Brandt', 'Svenja Koch'],
      isSeasonPremiere: true,
      seriesStatus: 'returning',
      seriesStatusDetail: 'Laufende Serie · Staffel 3 in Vorbereitung',
    },
    {
      id: 'de-99310-s2e1',
      tmdbId: 99310,
      title: 'Code Null: Frankfurt',
      season: 2,
      episode: 1,
      episodeTitle: 'Latenz Null',
      releaseDate: '2026-11-19',
      provider: 'Prime Video',
      genre: 'Drama & Wirtschaft',
      coverKey: 'posterCyberBerlin',
      synopsis:
        'Nach dem europaweiten Blackout übernimmt ein internationales Krisenteam den Glasfaser-Knoten in Frankfurt — bis ein verstecktes Protokoll eine neue Erpressung auslöst.',
      cast: ['Laura König', 'Tobias Adler', 'Nadia Yilmaz', 'Fabian Weiß'],
      isSeasonPremiere: true,
    },
    {
      id: 'de-11882-s1e1',
      tmdbId: 11882,
      title: 'Elbphilharmonie: Hinter den Kulissen',
      season: 1,
      episode: 1,
      episodeTitle: 'Klangkörper',
      releaseDate: '2026-11-14',
      provider: 'Disney+',
      genre: 'Dokumentation',
      coverKey: 'posterAlpineDoc',
      synopsis:
        'Eine exklusive Langzeitbegleitung durch den Konzertbetrieb in Hamburg: Akustik-Ingenieure, Solisten und Bühnentechnik zwischen Weltpremiere und Mitternachtsprobe.',
      cast: ['Klara von Berg', 'Stefan Weber', 'Elena Rostova'],
      isSeasonPremiere: true,
    },
    {
      id: 'de-20491-s2e4',
      tmdbId: 20491,
      title: 'Babylon Spree',
      season: 2,
      episode: 4,
      episodeTitle: 'Goldene Zwanziger',
      releaseDate: '2026-11-12',
      provider: 'WOW',
      genre: 'Historie & Drama',
      coverKey: 'posterCyberBerlin',
      synopsis:
        'Zwischen politischen Intrigen, Nachtclubs und Unterwelt-Syndikaten kämpft Kommissar Rath im Berlin der späten Zwanzigerjahre um die Aufklärung einer Mordserie.',
      cast: ['Volker Bruch', 'Liv Lisa Fries', 'Peter Kurth', 'Meret Becker'],
      isSeasonPremiere: false,
      seriesStatus: 'ended',
      seriesStatusDetail: 'Serie regulär beendet · Abgeschlossene finale Staffel',
    },
    {
      id: 'de-30914-s1e1',
      tmdbId: 30914,
      title: 'Rheinland Express',
      season: 1,
      episode: 1,
      episodeTitle: 'Gleis 9',
      releaseDate: '2026-11-22',
      provider: 'RTL+',
      genre: 'Krimi & Thriller',
      coverKey: 'posterNordicCrime',
      synopsis:
        'In einem Nachtzug entlang des Rheins verschwindet ein Kronzeuge spurlos zwischen Köln und Basel. Bis zum Morgengrauen darf niemand den Zug verlassen.',
      cast: ['Maximilian Meyer', 'Alina Schaller', 'Jörg Hartmann'],
      isSeasonPremiere: true,
    },
    {
      id: 'de-41205-s3e2',
      tmdbId: 41205,
      title: 'Silberne Spur',
      season: 3,
      episode: 2,
      episodeTitle: 'Kaltstart',
      releaseDate: '2026-11-13',
      provider: 'Apple TV+',
      genre: 'Sci-Fi & Mystery',
      coverKey: 'posterDarkMatter',
      synopsis:
        'Nach der Entdeckung eines metallischen Signals unter dem arktischen Eis reist eine europäische Crew mit einem Forschungseisbrecher in ein abgeschottetes Sperrgebiet.',
      cast: ['Leonie Benesch', 'Florian David Fitz', 'Devrim Lingnau'],
      isSeasonPremiere: false,
      seriesStatus: 'canceled',
      seriesStatusDetail: 'Serie eingestellt · Nach Staffel 3 abgesetzt (letzte Ausstrahlung)',
    },
  ];

  const SEED_CALENDAR_FSK_MAP: Record<string, FskLevel> = {
    'de-70523-s4e1': 16,
    'de-91244-s3e1': 16,
    'de-99310-s2e1': 12,
    'de-11882-s1e1': 0,
    'de-20491-s2e4': 16,
    'de-30914-s1e1': 12,
    'de-41205-s3e2': 16,
  };

  for (const rel of seedReleases) {
    rel.fsk = SEED_CALENDAR_FSK_MAP[rel.id] ?? 12;
  }

  if (nasStore.isStoreDefinitelyMissing('calendar.json')) {
    writeJsonAtomic('calendar.json', { releases: seedReleases }, { allowEmptyOverwrite: true, skipBackup: true });
  } else {
    try {
      const existingCal = readJsonFile<CalendarStore>('calendar.json', {
        releases: [],
      });
      const seedById = new Map(seedReleases.map((s) => [s.id, s]));
      let changed = false;
      const enriched = existingCal.releases.map((rel) => {
        const seed = seedById.get(rel.id);
        const needsBase = seed && (!rel.coverKey || !rel.synopsis || !rel.cast?.length);
        const needsStatus =
          seed && rel.seriesStatus === undefined && seed.seriesStatus !== undefined;
        const needsFsk = rel.fsk === undefined;
        if (needsBase || needsStatus || needsFsk) {
          changed = true;
          return {
            ...rel,
            coverKey: rel.coverKey ?? seed?.coverKey,
            synopsis: rel.synopsis ?? seed?.synopsis,
            cast: rel.cast?.length ? rel.cast : seed?.cast,
            fsk: rel.fsk ?? seed?.fsk ?? 12,
            ...(needsStatus && seed
              ? {
                  seriesStatus: seed.seriesStatus,
                  seriesStatusDetail: seed.seriesStatusDetail,
                }
              : {}),
          };
        }
        return rel;
      });
      if (changed) {
        writeJsonAtomic('calendar.json', { ...existingCal, releases: enriched });
      }
    } catch (err) {
      console.error('[NAS-SCHUTZ] Konnte bestehende calendar.json beim Start nicht prüfen — unverändert belassen:', err);
    }
  }

  if (nasStore.isStoreDefinitelyMissing('favorites.json')) {
    const initialFavs: FavoritesStore = {
      users: {
        kevin: {
          auto: ['Schattenwald', 'Sturmfeuer Nordsee'],
          manual: ['Babylon Spree'],
          muted: [],
        },
      },
    };
    writeJsonAtomic('favorites.json', initialFavs, { allowEmptyOverwrite: true, skipBackup: true });
  }

  if (nasStore.isStoreDefinitelyMissing('notifications.json')) {
    writeJsonAtomic(
      'notifications.json',
      {
        alerts: [] as NotificationRecord[],
        dismissedIds: {} as Record<string, string[]>,
      },
      { allowEmptyOverwrite: true, skipBackup: true }
    );
  }

  if (nasStore.isStoreDefinitelyMissing('settings.json')) {
    let currentCatalogIds: string[] = [];
    try {
      currentCatalogIds = readJsonFile<NasLibraryRecord[]>('catalog.json', []).map((item) => item.id);
    } catch {
      currentCatalogIds = [];
    }
    writeJsonAtomic(
      'settings.json',
      {
        syncMode: 'manual',
        lastScanTimestamp: null,
        knownCatalogIds: currentCatalogIds,
        allowedNasProtocols: [...ALL_NAS_PROTOCOLS],
        fritzUpnpMigrationApplied: true,
        userDataStorage: getDefaultUserDataStorageConfig(),
        networkConfig: getDefaultAdminNetworkConfig(),
        nasPathSettings: getDefaultNasPathSettings(),
      },
      { allowEmptyOverwrite: true, skipBackup: true }
    );
  } else {
    try {
      const existingSettings = readJsonFile<NasSyncSettings>('settings.json', {
        syncMode: 'manual',
        lastScanTimestamp: null,
      });
      let settingsChanged = false;
      if (!Array.isArray(existingSettings.knownCatalogIds)) {
        try {
          existingSettings.knownCatalogIds = readJsonFile<NasLibraryRecord[]>('catalog.json', []).map(
            (item) => item.id
          );
          settingsChanged = true;
        } catch {
          // knownCatalogIds nicht überschreiben, wenn catalog.json nicht lesbar
        }
      }
      if (!Array.isArray(existingSettings.allowedNasProtocols) || existingSettings.allowedNasProtocols.length === 0) {
        existingSettings.allowedNasProtocols = [...ALL_NAS_PROTOCOLS];
        existingSettings.fritzUpnpMigrationApplied = true;
        settingsChanged = true;
      } else if (!existingSettings.fritzUpnpMigrationApplied) {
        if (!existingSettings.allowedNasProtocols.includes('fritz_upnp')) {
          existingSettings.allowedNasProtocols = [
            ...existingSettings.allowedNasProtocols,
            'fritz_upnp',
          ];
        }
        existingSettings.fritzUpnpMigrationApplied = true;
        settingsChanged = true;
      }
      if (!existingSettings.userDataStorage) {
        existingSettings.userDataStorage = getDefaultUserDataStorageConfig();
        settingsChanged = true;
      }
      if (!existingSettings.fritzDiscovery) {
        existingSettings.fritzDiscovery = getDefaultFritzDiscoveryConfig();
        settingsChanged = true;
      }
      if (!existingSettings.networkConfig) {
        existingSettings.networkConfig = getDefaultAdminNetworkConfig();
        settingsChanged = true;
      }
      if (!existingSettings.nasPathSettings) {
        existingSettings.nasPathSettings = getDefaultNasPathSettings();
        settingsChanged = true;
      }
      if (settingsChanged) {
        writeJsonAtomic('settings.json', existingSettings);
      }
    } catch (err) {
      console.error('[NAS-SCHUTZ] Konnte bestehende settings.json beim Start nicht prüfen — unverändert belassen:', err);
    }
  }

  if (nasStore.isStoreDefinitelyMissing('watchlist.json')) {
    const initialWatchlist: WatchlistStore = {
      users: {
        kevin: ['nas-alpen-04', 'nas-bergwacht-06'],
        elena: ['nas-berlin-03'],
      },
    };
    writeJsonAtomic('watchlist.json', initialWatchlist, { allowEmptyOverwrite: true, skipBackup: true });
  }
}

ensureNasSeedData();
cloudAutoSyncReady = true;

// --- Auth Token helpers ---

function signSessionToken(username: string): string {
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(username).digest('hex');
  return `${username}.${sig}`;
}

function verifyRawToken(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return null;
  const username = trimmed.slice(0, dot);
  const sig = trimmed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(username).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return username;
}

function verifyToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return verifyRawToken(authHeader.slice(7));
}

interface AuthedRequest extends Request {
  nasUsername?: string;
}

function requireNasAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const username = verifyToken(req.headers.authorization);
  if (!username) {
    res.status(401).json({ error: 'Ungültige oder fehlende NAS-Session. Bitte neu anmelden.' });
    return;
  }
  req.nasUsername = username;
  next();
}

function getUserFskLimit(username: string): FskLevel {
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  return normalizeFskLimit(users[username]?.fskLimit, 18);
}

function hasNasWriteAccess(username: string): boolean {
  const cleanUser = username.trim().toLowerCase();
  if (!cleanUser) return false;
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = users[cleanUser];
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (cleanUser === 'fritzbox_upnp') return true;
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const conn = connStore.users[cleanUser];
  if (!conn) return false;
  if (conn.protocol === 'fritz_upnp' && conn.accessMode !== 'read_only' && conn.writePermissions !== false) {
    return true;
  }
  return false;
}

function requireNasAdmin(req: AuthedRequest, res: Response): StoredUser | null {
  const username = req.nasUsername;
  if (!username) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = users[username];
  if (!user || user.role !== 'admin') {
    res.status(403).json({
      error: 'Nur Administratoren dürfen auf Profile anderer Nutzer oder Altersfreigaben zugreifen.',
    });
    return null;
  }
  return user;
}

function requireNasWriteAccess(req: AuthedRequest, res: Response): StoredUser | null {
  const username = req.nasUsername;
  if (!username) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = users[username];
  if (!user) {
    res.status(401).json({ error: 'Benutzerkonto auf dem NAS nicht mehr vorhanden.' });
    return null;
  }
  if (!hasNasWriteAccess(user.username)) {
    res.status(403).json({
      error:
        'Keine NAS-Schreibrechte: Für Medien-Uploads oder NAS-Schreibvorgänge sind Admin-Rechte oder eine aktive FRITZ!Box UPnP/DLNA-Sitzung erforderlich.',
    });
    return null;
  }
  return user;
}

function sanitizeProfileFolderSegment(rawUsername: string): string {
  return path
    .basename((rawUsername ?? '').trim().toLowerCase())
    .replace(/[^a-z0-9_-]/g, '');
}

function resolveProfileFolderPaths(
  rawUsername: string,
  pathSettings?: StoredNasPathSettings
): {
  cleanUsername: string;
  profilesRootDir: string;
  diskPath: string;
  nasMountPath: string;
} | null {
  const cleanUsername = sanitizeProfileFolderSegment(rawUsername);
  if (!cleanUsername) return null;
  const cfg = pathSettings ?? readCurrentNasPathSettings();
  const baseDir = resolveEffectiveDataDir(cfg);
  const profilesRootDir = path.resolve(baseDir, 'profiles');
  const diskPath = path.resolve(profilesRootDir, cleanUsername);
  if (!diskPath.startsWith(profilesRootDir + path.sep)) {
    return null;
  }
  const cleanVaultBase = cfg.vaultBasePath.replace(/\/+$/, '') || '/mnt/nas/.entencenter';
  const nasMountPath = `${cleanVaultBase}/profiles/${cleanUsername}`;
  return { cleanUsername, profilesRootDir, diskPath, nasMountPath };
}

function writeJsonFileAtomicDirect(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpFile, filePath);
}

function ensureUserProfileFolder(
  rawUsername: string,
  userRecord?: StoredUser | null,
  options: { pathSettings?: StoredNasPathSettings; includeDataSync?: boolean } = {}
): ProfileFolderInfo | null {
  const resolved = resolveProfileFolderPaths(rawUsername, options.pathSettings);
  if (!resolved) return null;
  const { cleanUsername, diskPath, nasMountPath } = resolved;
  const subfolders = ['media', 'backups'];
  const profileJsonPath = path.join(diskPath, 'profile.json');
  const profileDataJsonPath = path.join(diskPath, 'profile-data.json');
  const existedBefore = fs.existsSync(profileJsonPath);

  fs.mkdirSync(diskPath, { recursive: true });
  for (const sub of subfolders) {
    fs.mkdirSync(path.join(diskPath, sub), { recursive: true });
  }

  let writable = true;
  try {
    fs.accessSync(diskPath, fs.constants.W_OK);
  } catch {
    writable = false;
  }

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = userRecord ?? users[cleanUsername] ?? null;
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const nasConn = connStore.users[cleanUsername] ?? null;

  let existingMeta: { folderCreatedAt?: string } = {};
  if (existedBefore) {
    try {
      existingMeta = JSON.parse(fs.readFileSync(profileJsonPath, 'utf8')) as {
        folderCreatedAt?: string;
      };
    } catch {
      existingMeta = {};
    }
  }

  const nowIso = new Date().toISOString();
  const folderCreatedAt = existingMeta.folderCreatedAt || user?.createdAt || nowIso;
  const publicNasConn = nasConn ? toPublicNasConnection(nasConn) : null;
  const writePermitted = hasNasWriteAccess(cleanUsername);

  writeJsonFileAtomicDirect(profileJsonPath, {
    username: cleanUsername,
    id: user?.id ?? null,
    displayName: user?.displayName ?? cleanUsername,
    role: user?.role ?? 'family',
    fskLimit: normalizeFskLimit(user?.fskLimit, 18),
    hasNasWriteAccess: writePermitted,
    nasMountPath,
    subfolders,
    nasProtocol: publicNasConn?.protocol ?? null,
    nasAccessMode: publicNasConn?.accessMode ?? (writePermitted ? 'read_write' : 'read_only'),
    nasWritePermissions: publicNasConn?.writePermissions ?? writePermitted,
    folderCreatedAt,
    updatedAt: nowIso,
  });

  if (options.includeDataSync !== false) {
    const prefsStore = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
    const watchlistStore = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
    const favStore = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
    const collectionsStore = readJsonFile<CollectionsStore>('collections.json', { users: {} });
    const historyStore = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', {
      watches: [],
    });

    writeJsonFileAtomicDirect(profileDataJsonPath, {
      version: 1,
      username: cleanUsername,
      profile: user
        ? {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            fskLimit: normalizeFskLimit(user.fskLimit, 18),
            avatarColor: user.avatarColor,
            hasAvatar: Boolean(user.avatarUrl),
            hasNasWriteAccess: writePermitted,
            createdAt: user.createdAt,
          }
        : null,
      preferences: sanitizePreferences(prefsStore.users[cleanUsername]),
      watchlistIds: watchlistStore.users[cleanUsername] ?? [],
      favorites: favStore.users[cleanUsername] ?? { auto: [], manual: [], muted: [] },
      collections: collectionsStore.users[cleanUsername] ?? [],
      watchHistory: historyStore.watches.filter((w) => w.username === cleanUsername),
      nasConnection: publicNasConn,
      syncedAt: nowIso,
    });
  }

  if (!existedBefore) {
    try {
      appendWal('NAS_PROFILE_FOLDER_CREATED', cleanUsername, {
        diskPath,
        nasMountPath,
        subfolders,
        writable,
      });
    } catch {
      // WAL-Fehler ignorieren
    }
  }

  return {
    username: cleanUsername,
    nasMountPath,
    diskPath,
    subfolders,
    exists: fs.existsSync(diskPath),
    writable,
    createdNow: !existedBefore,
    createdAt: folderCreatedAt,
    updatedAt: nowIso,
  };
}

function syncUserProfileDataSnapshot(rawUsername: string): void {
  try {
    ensureUserProfileFolder(rawUsername, undefined, { includeDataSync: true });
  } catch {
    // Synchronisationsfehler sollen aktive API-Antwort nicht blockieren
  }
}

function renameUserProfileFolder(
  oldUsername: string,
  newUsername: string,
  updatedUser?: StoredUser | null
): ProfileFolderInfo | null {
  const oldResolved = resolveProfileFolderPaths(oldUsername);
  const newResolved = resolveProfileFolderPaths(newUsername);
  if (oldResolved && newResolved && oldResolved.diskPath !== newResolved.diskPath) {
    try {
      if (fs.existsSync(oldResolved.diskPath) && !fs.existsSync(newResolved.diskPath)) {
        fs.mkdirSync(newResolved.profilesRootDir, { recursive: true });
        try {
          fs.renameSync(oldResolved.diskPath, newResolved.diskPath);
        } catch {
          fs.cpSync(oldResolved.diskPath, newResolved.diskPath, { recursive: true });
          fs.rmSync(oldResolved.diskPath, { recursive: true, force: true });
        }
      }
    } catch {
      // Bei Umbenennungsfehler neuen Ordner regulär erstellen
    }
  }
  return ensureUserProfileFolder(newUsername, updatedUser);
}

function deleteUserProfileFolder(rawUsername: string): void {
  const resolved = resolveProfileFolderPaths(rawUsername);
  if (!resolved) return;
  try {
    if (fs.existsSync(resolved.diskPath)) {
      fs.rmSync(resolved.diskPath, { recursive: true, force: true });
    }
  } catch {
    // Löschfehler ignorieren
  }
}

// --- Core Calendar + Auto-Favorite + Notification Sync Engine (matches Python EntenCenterCalendarManager) ---

function inferCoverKeyForGenre(genre: string): string {
  const g = genre.toLowerCase();
  if (g.includes('doku') || g.includes('alpen') || g.includes('abenteuer')) {
    return 'posterAlpineDoc';
  }
  if (g.includes('krimi') || g.includes('nord') || g.includes('thriller')) {
    return 'posterNordicCrime';
  }
  if (g.includes('wirtschaft') || g.includes('historie') || g.includes('drama')) {
    return 'posterCyberBerlin';
  }
  return 'posterDarkMatter';
}

function inferCoverKeyForKind(kind: MediaKind, genre: string): string {
  if (kind === 'image') return 'coverNasBilder';
  if (kind === 'music') return 'coverNasMusik';
  if (kind === 'video') return 'coverNasVideo';
  if (kind === 'other') return 'coverNasSonstiges';
  return inferCoverKeyForGenre(genre);
}

function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} GB`;
}

function sanitizeUploadedFileName(raw: string): string {
  const base = path.basename(raw || 'datei.bin').trim();
  const cleaned = base.replace(/[^a-zA-Z0-9äöüÄÖÜß._-]+/g, '_').replace(/^_+/, '');
  return cleaned || `datei_${Date.now()}.bin`;
}

function decodeHeaderParam(raw: string | string[] | undefined): string {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) return '';
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function resolveSafeUploadPath(storedFileName?: string | null): string | null {
  if (!storedFileName) return null;
  const cleanName = path.basename(storedFileName);
  if (!cleanName || cleanName === '.' || cleanName === '..') return null;

  const uploadsDir = resolveEffectiveUploadsDir();
  const customCandidate = path.resolve(uploadsDir, cleanName);
  if (customCandidate.startsWith(uploadsDir + path.sep) && fs.existsSync(customCandidate)) {
    return customCandidate;
  }

  const defaultCandidate = path.resolve(NAS_UPLOADS_DIR, cleanName);
  if (defaultCandidate.startsWith(NAS_UPLOADS_DIR + path.sep)) {
    return defaultCandidate;
  }
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.f4v': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.vob': 'video/dvd',
  '.divx': 'video/x-msvideo',
  '.rmvb': 'video/x-msvideo',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'application/vnd.apple.mpegurl',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.alac': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.mka': 'audio/x-matroska',
  '.amr': 'audio/amr',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.ac3': 'audio/ac3',
  '.dts': 'audio/vnd.dts',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-ape',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

function inferMimeType(fileName: string, providedMime?: string): string {
  const cleanProvided = (providedMime ?? '').split(';')[0].trim().toLowerCase();
  if (cleanProvided && cleanProvided !== 'application/octet-stream') {
    return cleanProvided;
  }
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function inferMediaKindFromFile(fileName: string, mimeType: string): MediaKind {
  const ext = path.extname(fileName).toLowerCase();
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tiff', '.tif', '.svg'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('audio/') || ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.m4b', '.aac', '.opus', '.wma', '.aiff', '.aif', '.alac', '.ape', '.wv', '.mka', '.amr', '.mid', '.midi', '.ac3', '.dts'].includes(ext)) {
    return 'music';
  }
  if (mime.startsWith('video/') || ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.wmv', '.asf', '.flv', '.f4v', '.3gp', '.3g2', '.ogv', '.vob', '.divx', '.rmvb', '.m3u8', '.m3u'].includes(ext)) {
    if (/s\d{1,2}e\d{1,2}|staffel|episode|folge/i.test(fileName)) return 'series';
    if (['.mkv', '.m4v', '.avi', '.iso'].includes(ext)) return 'movie';
    return 'video';
  }
  return 'other';
}

function inferCodecLabel(kind: MediaKind, fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).replace('.', '').toUpperCase();
  if (kind === 'image') return ext ? `${ext} · Originalbild` : 'Bilddatei';
  if (kind === 'music') return ext ? `${ext} Audio (${mimeType})` : 'Audio';
  if (kind === 'other') return ext ? `${ext} · Datei` : 'Dokument / Archiv';
  return ext ? `${ext} · Direkt vom NAS` : 'Video · Direkt vom NAS';
}

function buildLibraryClientPayload(item: NasLibraryRecord, watch?: WatchHistoryEntry) {
  const hasFile = Boolean(item.uploadedFileName && resolveSafeUploadPath(item.uploadedFileName));
  const hasScannedNasSource = Boolean(
    !hasFile &&
      item.nasPath &&
      (item.id.startsWith('nas-scan-') ||
        item.nasPath.startsWith('smb://') ||
        fs.existsSync(item.nasPath))
  );
  const mediaUrl = hasFile
    ? `/api/nas/media/${encodeURIComponent(item.id)}/stream`
    : hasScannedNasSource
      ? `/api/nas/storage/stream?mediaId=${encodeURIComponent(item.id)}`
      : undefined;
  const effectiveMime =
    item.uploadedMimeType ||
    (hasScannedNasSource && item.nasPath ? inferMimeType(item.nasPath) : undefined);
  let customCoverUrl: string | undefined;
  if (item.customCoverFileName && resolveSafeUploadPath(item.customCoverFileName)) {
    customCoverUrl = `/api/nas/uploads/${encodeURIComponent(item.customCoverFileName)}`;
  } else if (hasFile && item.kind === 'image' && item.uploadedFileName) {
    customCoverUrl = `/api/nas/uploads/${encodeURIComponent(item.uploadedFileName)}`;
  }

  return {
    id: item.id,
    tmdbId: item.tmdbId,
    title: item.title,
    kind: item.kind,
    genre: item.genre,
    year: item.year,
    coverKey: item.coverKey,
    customCoverUrl,
    mediaUrl,
    uploadedFileName: item.uploadedFileName,
    uploadedMimeType: effectiveMime,
    uploadedByteSize: item.uploadedByteSize,
    synopsis: item.synopsis,
    codec: item.codec,
    audioTracks: item.audioTracks,
    subtitles: item.subtitles,
    totalDurationMinutes: item.totalDurationMinutes,
    watchedMinutes: watch?.watchedMinutes ?? 0,
    episodesWatchedCount: watch?.episodesWatched ?? 0,
    totalEpisodes: item.totalEpisodes,
    currentEpisode:
      item.kind === 'series'
        ? {
            season: watch?.currentSeason ?? item.defaultSeason ?? 1,
            episode: watch?.currentEpisode ?? item.defaultEpisode ?? 1,
            title: watch?.currentEpisodeTitle ?? item.defaultEpisodeTitle ?? 'Folge 1',
            durationMinutes: item.totalDurationMinutes,
          }
        : undefined,
    episodes: buildNasEpisodesForSeries(item, watch),
    lastWatchedAt: watch?.lastWatchedAt ?? null,
    watchedWithoutDate: Boolean(watch && (watch.watchedWithoutDate || !watch.lastWatchedAt)),
    addedAt: item.addedAt ?? `${item.year}-06-01T12:00:00Z`,
    nasPath: item.nasPath,
    fileFormat: item.fileFormat,
    fileSize: item.fileSize,
    fsk: normalizeFskLimit(item.fsk, 0),
    seriesStatus: item.seriesStatus,
    seriesStatusDetail: item.seriesStatusDetail,
    cast: item.cast,
    studio: item.studio,
    director: item.director,
    moodTags: item.moodTags,
    seasons: item.seasons,
  };
}

function matchSeriesWithNasCatalog(
  rel: CalendarReleaseRecord,
  allowedCatalog: NasLibraryRecord[],
  userHistoryMap: Map<string, WatchHistoryEntry>,
  nasEntry?: WatchHistoryEntry
) {
  const normTarget = normalizeFilmTitle(rel.title);
  const seriesCatalog = allowedCatalog.filter((item) => item.kind === 'series');
  const pool = seriesCatalog.length > 0 ? seriesCatalog : allowedCatalog;

  const catalogMatch = pool.find((item) => {
    if (rel.tmdbId && item.tmdbId === rel.tmdbId && item.kind === 'series') return true;
    const normCat = normalizeFilmTitle(item.title);
    if (!normCat || !normTarget) return false;
    if (normCat === normTarget) return true;
    if (normTarget.length >= 5 && normCat.length >= 5) {
      return normCat.includes(normTarget) || normTarget.includes(normCat);
    }
    return false;
  });

  if (!catalogMatch) {
    return {
      matched: Boolean(nasEntry),
      availableOnNas: false,
      seriesOnNas: false,
      seasonOnNas: false,
      episodeOnNas: false,
      availableSeasonsOnNas: [] as number[],
      seasonEpisodesOnNasCount: 0,
      nasMediaId: nasEntry?.mediaId,
      episodesWatchedOnNas: nasEntry?.episodesWatched ?? 0,
      lastSeasonWatched: nasEntry?.currentSeason,
      statusLabel: nasEntry
        ? `NAS-Verlauf: ${nasEntry.episodesWatched} Folgen gesehen (zuletzt S${String(
            nasEntry.currentSeason ?? 1
          ).padStart(2, '0')}E${String(nasEntry.currentEpisode ?? 1).padStart(2, '0')})`
        : 'Noch nicht auf dem NAS',
    };
  }

  const watch = userHistoryMap.get(catalogMatch.id) ?? nasEntry;
  const nasEpisodes =
    catalogMatch.kind === 'series' ? buildNasEpisodesForSeries(catalogMatch, watch) ?? [] : [];
  const availableSeasonsOnNas = Array.from(
    new Set(nasEpisodes.map((ep) => ep.season))
  ).sort((a, b) => a - b);
  const seasonEpisodes = nasEpisodes.filter((ep) => ep.season === rel.season);
  const seasonOnNas = seasonEpisodes.length > 0;
  const matchedEpisode = seasonEpisodes.find((ep) => ep.episode === rel.episode);
  const episodeOnNas = Boolean(matchedEpisode);
  const sPad = String(rel.season).padStart(2, '0');
  const ePad = String(rel.episode).padStart(2, '0');
  const seasonsRange =
    availableSeasonsOnNas.length > 0
      ? availableSeasonsOnNas.length === 1
        ? `Staffel ${availableSeasonsOnNas[0]}`
        : `Staffeln ${availableSeasonsOnNas[0]}–${availableSeasonsOnNas[availableSeasonsOnNas.length - 1]}`
      : 'Serie hinterlegt';

  const statusLabel = episodeOnNas
    ? `Auf NAS verfügbar: S${sPad}E${ePad} & Staffel ${rel.season} (${seasonEpisodes.length} Folgen)`
    : seasonOnNas
      ? `Serie & Staffel ${rel.season} auf NAS (${seasonEpisodes.length} Folgen) · Neue Folge S${sPad}E${ePad} fehlt`
      : `Serie auf NAS (${seasonsRange}) · Staffel ${rel.season} & neue Folge S${sPad}E${ePad} fehlen noch`;

  return {
    matched: true,
    availableOnNas: true,
    seriesOnNas: true,
    seasonOnNas,
    episodeOnNas,
    availableSeasonsOnNas,
    seasonEpisodesOnNasCount: seasonEpisodes.length,
    nasMediaId: catalogMatch.id,
    nasTitle: catalogMatch.title,
    nasPath: matchedEpisode?.nasPath ?? seasonEpisodes[0]?.nasPath ?? catalogMatch.nasPath,
    codec: catalogMatch.codec,
    episodesWatchedOnNas: watch?.episodesWatched ?? 0,
    lastSeasonWatched: watch?.currentSeason,
    statusLabel,
  };
}

function syncCalendarAndAlerts(username: string, fetchWarning: string | null = null) {
  detectAndNotifyNewCatalogItems();
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  const calendar = readJsonFile<CalendarStore>('calendar.json', {
    releases: [],
    sources: [],
    lastFetchedAt: null,
    fetchMethod: 'cache',
  });
  const notificationsStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  const dismissedSet = new Set(notificationsStore.dismissedIds?.[username] ?? []);

  let favsChanged = false;
  if (!favs.users[username]) {
    favs.users[username] = { auto: [], manual: [], muted: [] };
    favsChanged = true;
  }
  const userFavs = favs.users[username];

  // Auto-sync series watched on NAS (>= 1 watch entry) into auto favorites unless muted
  const userWatches = history.watches.filter((w) => w.username === username);
  const userHistoryMap = new Map<string, WatchHistoryEntry>();
  const watchedSeriesMap = new Map<string, WatchHistoryEntry>();
  for (const w of userWatches) {
    userHistoryMap.set(w.mediaId, w);
    if (w.mediaType === 'series') {
      watchedSeriesMap.set(w.title.toLowerCase(), w);
      if (
        !userFavs.auto.includes(w.title) &&
        !userFavs.manual.includes(w.title) &&
        !userFavs.muted.includes(w.title)
      ) {
        userFavs.auto.push(w.title);
        favsChanged = true;
      }
    }
  }
  if (favsChanged) {
    writeJsonAtomic('favorites.json', favs);
  }
  let notificationsChanged = false;

  const userFskLimit = getUserFskLimit(username);
  const allowedCatalog = catalog.filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
  );
  const allowedReleases = calendar.releases.filter(
    (rel) => normalizeFskLimit(rel.fsk, 12) <= userFskLimit
  );

  const prefsStore = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
  const userPrefs = sanitizePreferences(prefsStore.users[username]);
  const calNotifMode = userPrefs.calendarNotificationMode;

  const todayStr = new Date().toISOString().slice(0, 10);
  const enrichedReleases = allowedReleases.map((rel) => {
    const nasEntry = watchedSeriesMap.get(rel.title.toLowerCase());
    const nasMatch = matchSeriesWithNasCatalog(rel, allowedCatalog, userHistoryMap, nasEntry);
    const isMuted = userFavs.muted.includes(rel.title);
    const isManual = userFavs.manual.includes(rel.title);
    const isAuto = userFavs.auto.includes(rel.title) && !isMuted;
    const isFavorite = !isMuted && (isManual || isAuto);
    const source: 'auto' | 'manual' | 'none' = isMuted
      ? 'none'
      : isManual
        ? 'manual'
        : isAuto
          ? 'auto'
          : 'none';

    const isAvailableNow = rel.releaseDate <= todayStr;
    const isNewSeries = rel.season === 1 && rel.episode === 1;
    const isNewEpisode = !isNewSeries;

    let shouldNotifyByRule = false;
    switch (calNotifMode) {
      case 'favorites_all':
        shouldNotifyByRule = isFavorite;
        break;
      case 'favorites_new_series':
        shouldNotifyByRule = isFavorite && isNewSeries;
        break;
      case 'favorites_new_episodes':
        shouldNotifyByRule = isFavorite && isNewEpisode;
        break;
      case 'all':
        shouldNotifyByRule = !isMuted;
        break;
      case 'all_new_series':
        shouldNotifyByRule = !isMuted && isNewSeries;
        break;
      case 'all_new_episodes':
        shouldNotifyByRule = !isMuted && isNewEpisode;
        break;
    }

    if (shouldNotifyByRule && isAvailableNow) {
      const alertId = `${username}_${rel.title}_S${rel.season}E${rel.episode}`;
      const alreadyExists = notificationsStore.alerts.some((a) => a.id === alertId);
      if (!alreadyExists && !dismissedSet.has(alertId)) {
        const newAlert: NotificationRecord = {
          id: alertId,
          username,
          seriesTitle: rel.title,
          info: isNewSeries
            ? `Neue Serie · Staffel ${rel.season}, Folge ${rel.episode} ("${rel.episodeTitle}") jetzt verfügbar`
            : `Neue Folge · Staffel ${rel.season}, Folge ${rel.episode} ("${rel.episodeTitle}") jetzt verfügbar`,
          provider: rel.provider,
          releaseDate: rel.releaseDate,
          releaseId: rel.id,
          createdAt: new Date().toISOString(),
          read: false,
          triggerType: source === 'manual' ? 'manual_favorite' : 'auto_favorite',
        };
        notificationsStore.alerts.unshift(newAlert);
        notificationsChanged = true;
        appendWal('CALENDAR_ALERT_TRIGGERED', username, newAlert);
      }
    }

    return {
      id: rel.id,
      tmdbId: rel.tmdbId,
      seriesTitle: rel.title,
      seasonNumber: rel.season,
      episodeNumber: rel.episode,
      episodeTitle: rel.episodeTitle,
      releaseDate: rel.releaseDate,
      region: 'DE' as const,
      provider: rel.provider,
      genre: rel.genre,
      coverKey: rel.coverKey ?? inferCoverKeyForGenre(rel.genre),
      ...(rel.coverUrl ? { coverUrl: rel.coverUrl } : {}),
      synopsis:
        rel.synopsis ||
        `Neue Staffel ${rel.season} von „${rel.title}“ startet im deutschsprachigen Raum exklusiv bei ${rel.provider}.`,
      cast:
        rel.cast && rel.cast.length > 0
          ? rel.cast
          : ['Hauptbesetzung laut DE-Streaming-Katalog'],
      isSeasonPremiere: rel.isSeasonPremiere,
      isAvailableNow,
      fsk: normalizeFskLimit(rel.fsk, 12),
      seriesStatus: rel.seriesStatus,
      seriesStatusDetail: rel.seriesStatusDetail,
      nasMatch,
      favorite: {
        isFavorite,
        source,
        reason: isMuted
          ? 'Manuell stummgeschaltet'
          : isManual
            ? 'Manuell favorisiert'
            : isAuto
              ? 'Automatisch über NAS-Verlauf favorisiert'
              : 'Noch nicht favorisiert',
      },
    };
  });

  if (notificationsChanged) {
    writeJsonAtomic('notifications.json', notificationsStore);
  }
  const userAlerts = notificationsStore.alerts.filter((a) => a.username === username);

  return {
    releases: enrichedReleases,
    alerts: userAlerts,
    sources: calendar.sources ?? [],
    lastFetchedAt: calendar.lastFetchedAt ?? null,
    fetchMethod: calendar.fetchMethod ?? 'cache',
    fetchWarning,
  };
}

const NAS_CATEGORY_LABELS: Record<MediaKind, string> = {
  movie: 'Filme',
  series: 'Serien',
  image: 'Bilder',
  music: 'Musik',
  video: 'Video',
  other: 'Sonstiges',
};

const NAS_CATEGORY_ORDER: MediaKind[] = [
  'movie',
  'series',
  'image',
  'music',
  'video',
  'other',
];

function buildCategoryGroupsForItems(
  items: NasLibraryRecord[]
): NasAddedCategoryGroupRecord[] {
  const byKind = new Map<MediaKind, string[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item.title);
    byKind.set(item.kind, list);
  }
  const groups: NasAddedCategoryGroupRecord[] = [];
  for (const kind of NAS_CATEGORY_ORDER) {
    const titles = byKind.get(kind);
    if (titles && titles.length > 0) {
      groups.push({
        category: NAS_CATEGORY_LABELS[kind],
        kind,
        titles,
      });
    }
  }
  return groups;
}

function notifyAllUsersNewNasItems(addedItems: NasLibraryRecord[]): number {
  if (addedItems.length === 0) return 0;

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });

  const nowIso = new Date().toISOString();
  const dateStr = nowIso.slice(0, 10);
  const batchId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let notifiedCount = 0;

  for (const u of Object.values(users)) {
    const userFskLimit = normalizeFskLimit(u.fskLimit, 18);
    const allowedItems = addedItems.filter(
      (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
    );
    if (allowedItems.length === 0) continue;

    const categoryItems = buildCategoryGroupsForItems(allowedItems);
    const summaryText =
      allowedItems.length === 1
        ? 'Der Enten-Assistent hat 1 neuen Inhalt auf dem NAS gefunden und nach Kategorie aufgelistet.'
        : `Der Enten-Assistent hat ${allowedItems.length} neue Inhalte auf dem NAS gefunden und nach Kategorien aufgelistet.`;

    const alert: NotificationRecord = {
      id: `duck_nas_${batchId}_${u.username}`,
      username: u.username,
      seriesTitle: 'Enten-Assistent · Neue NAS-Inhalte',
      info: summaryText,
      provider: 'EntenCenter NAS',
      releaseDate: dateStr,
      releaseId: `nas-batch-${batchId}`,
      createdAt: nowIso,
      read: false,
      triggerType: 'duck_nas_added',
      senderLabel: 'Enten-Assistent',
      categoryItems,
      totalAddedCount: allowedItems.length,
    };

    store.alerts.unshift(alert);
    notifiedCount += 1;
  }

  if (notifiedCount > 0) {
    writeJsonAtomic('notifications.json', store);
    appendWal('DUCK_NAS_ADDED_NOTIFIED', 'duck-assistant', {
      batchId,
      addedCount: addedItems.length,
      notifiedUsers: notifiedCount,
      titles: addedItems.map((i) => ({ title: i.title, kind: i.kind })),
    });
    broadcastNasStatus('nas:notifications_updated');
  }

  return notifiedCount;
}

function detectAndNotifyNewCatalogItems(): NasLibraryRecord[] {
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const knownSet = new Set(settings.knownCatalogIds ?? []);
  const newlyAdded = catalog.filter((item) => !knownSet.has(item.id));
  if (newlyAdded.length === 0) return [];

  settings.knownCatalogIds = catalog.map((item) => item.id);
  writeJsonAtomic('settings.json', settings);
  notifyAllUsersNewNasItems(newlyAdded);
  return newlyAdded;
}

// --- Gemini AI Client (Server-Side Only) ---

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY ist nicht gesetzt. Bitte konfiguriere den API-Schlüssel unter Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Zugriff verweigert (403). Bitte prüfe deinen API-Schlüssel in Settings > Secrets — für gemini-4-argon / gemini-4-carbon ist ein kostenpflichtiger API-Schlüssel erforderlich.',
    };
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Kontingent erreicht (429). Für bezahlte Modelle wie gemini-4-argon oder gemini-4-carbon ist ein Billing-fähiger API-Schlüssel unter Settings > Secrets nötig.',
    };
  }
  if (raw.includes('404') || raw.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: `Das angeforderte Gemini-Modell wurde nicht gefunden: ${raw}`,
    };
  }
  return { status: 500, message: raw };
}

// --- Express App ---

const app = express();
app.disable('x-powered-by');
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-File-Name, X-Upload-Type, Range'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Content-Disposition'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use((req: Request, res: Response, next: NextFunction) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('gzip') || req.method === 'HEAD') {
    return next();
  }
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.headersSent || res.getHeader('Content-Encoding')) {
      return originalJson(body);
    }
    const serialized = JSON.stringify(body ?? null);
    if (!serialized || Buffer.byteLength(serialized, 'utf-8') < 1024) {
      return originalJson(body);
    }
    try {
      const compressed = zlib.gzipSync(serialized, { level: zlib.constants.Z_BEST_SPEED });
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', compressed.length);
      return res.send(compressed);
    } catch {
      return originalJson(body);
    }
  }) as Response['json'];
  next();
});
const jsonParser = express.json({ limit: '15mb' });
app.use((req, res, next) => {
  if (
    req.path === '/api/nas/upload' ||
    req.path === '/api/nas/library/upload' ||
    (req.path.startsWith('/api/nas/library/items/') && req.path.endsWith('/cover'))
  ) {
    return next();
  }
  return jsonParser(req, res, next);
});

// NAS Auth: Public bootstrap status (never leaks user profiles or names)
app.get('/api/nas/auth/bootstrap', (req: Request, res: Response) => {
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const list = Object.values(users);
  const isFirstUserRegistration = list.length === 0;
  const allowedNasProtocols = isFirstUserRegistration
    ? [...ALL_NAS_PROTOCOLS]
    : readAllowedNasProtocols();

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const discoveryConfig = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);
  const adminNetworkConfig = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeAddress =
    adminNetworkConfig.activeMode === 'remote'
      ? adminNetworkConfig.remoteAddress || adminNetworkConfig.lanAddress
      : adminNetworkConfig.lanAddress || adminNetworkConfig.remoteAddress;
  const subnets = getNasNetworkSubnets();
  const clientIp = extractNormalizedClientIp(req);
  const clientInSameSubnet = isIpInNasSubnet(
    clientIp,
    subnets,
    discoveryConfig.subnetCidr
  );
  const sameSubnetDeviceFound = discoveryConfig.discoveredDevices.some((d) => d.sameSubnet);
  const tokenlessEligible =
    discoveryConfig.enabled &&
    allowedNasProtocols.includes('fritz_upnp') &&
    (!discoveryConfig.subnetMatchRequired || (clientInSameSubnet && sameSubnetDeviceFound));

  const securityCertificate = readCurrentSecurityCertificate(settings);
  res.json({
    hasUsers: !isFirstUserRegistration,
    hasAdmin: list.some((u) => u.role === 'admin'),
    isFirstUserRegistration,
    activePort: activeServerPort,
    alternativePorts: ALTERNATIVE_ENTENCENTER_PORTS,
    allowedNasProtocols,
    fritzUpnpEnabled: allowedNasProtocols.includes('fritz_upnp'),
    securityCertificate,
    networkConfig: {
      activeMode: adminNetworkConfig.activeMode,
      activeAddress,
      lanAddress: adminNetworkConfig.lanAddress,
      remoteAddress: adminNetworkConfig.remoteAddress,
      remoteTransport: adminNetworkConfig.remoteTransport,
      autoFallbackToRemote: adminNetworkConfig.autoFallbackToRemote,
      allowLocalSelfSignedTls: adminNetworkConfig.allowLocalSelfSignedTls,
    },
    fritzDiscovery: {
      enabled: discoveryConfig.enabled,
      autoTokenlessLogin: discoveryConfig.autoTokenlessLogin,
      subnetMatchRequired: discoveryConfig.subnetMatchRequired,
      probeHosts: discoveryConfig.probeHosts,
      probePort: discoveryConfig.probePort,
      localSubnets: subnets.map((s) => s.cidr),
      clientInSameSubnet,
      discoveredDevices: discoveryConfig.discoveredDevices,
      tokenlessEligible,
    },
  });
});

// Pre-Login Netzwerk-Discovery: Sucht FRITZ!Box UPnP/DLNA-Geräte & prüft Subnetz-Übereinstimmung
app.get('/api/nas/fritz-discovery/probe', async (req: Request, res: Response) => {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const discoveryConfig = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);
  if (!discoveryConfig.enabled) {
    const subnets = getNasNetworkSubnets();
    const clientIp = extractNormalizedClientIp(req);
    res.json({
      enabled: false,
      autoTokenlessLogin: discoveryConfig.autoTokenlessLogin,
      subnetMatchRequired: discoveryConfig.subnetMatchRequired,
      configuredSubnetCidr: discoveryConfig.subnetCidr,
      localSubnets: subnets.map((s) => s.cidr),
      nasIps: subnets.map((s) => s.ip),
      clientIp,
      clientInSameSubnet: isIpInNasSubnet(clientIp, subnets, discoveryConfig.subnetCidr),
      discoveredDevices: [],
      sameSubnetDeviceFound: false,
      tokenlessEligible: false,
      checkedAt: new Date().toISOString(),
      reason: 'Fritzbox UPnP/DLNA-Discovery ist in den Admin-Netzwerkeinstellungen deaktiviert.',
    });
    return;
  }

  const probe = await runFritzDiscoveryProbe(req, discoveryConfig, true);
  res.json(probe);
});

// Pre-Login & In-App Netzwerk-Discovery: mDNS / Bonjour + SSDP + LAN Port-Scan für NAS-Geräte
app.get('/api/nas/discovery/scan', async (req: Request, res: Response) => {
  try {
    const includeSubnetProbe = req.query.subnetProbe !== '0' && req.query.subnetProbe !== 'false';
    const result = await discoverLocalNasDevices(req, {
      includeSubnetProbe,
      serverPort: PORT,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: 'Netzwerk-Discovery konnte nicht ausgeführt werden.',
      detail: err instanceof Error ? err.message : 'Unbekannter Fehler',
      devices: [],
      localSubnets: [],
      methodsUsed: [],
      durationMs: 0,
      scannedAt: new Date().toISOString(),
      summary: 'Netzwerk-Scan fehlgeschlagen.',
    });
  }
});

// LAN-Chromecast Discovery & CastV2 Bridge für alle Browser (Desktop, Mobile, Iframe, PWA)
app.get('/api/nas/chromecast/discover', async (req: Request, res: Response) => {
  try {
    const manualHost =
      typeof req.query.host === 'string' && req.query.host.trim() ? req.query.host.trim() : null;
    const devices = await discoverServerChromecastDevices(manualHost);
    res.json({
      devices,
      session: getServerCastSessionState(),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : 'Chromecast-Suche im lokalen WLAN fehlgeschlagen.',
      devices: [],
      session: getServerCastSessionState(),
    });
  }
});

app.get('/api/nas/chromecast/status', (_req: Request, res: Response) => {
  res.json(getServerCastSessionState());
});

app.post('/api/nas/chromecast/connect', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: number;
    deviceName?: string;
    contentUrl?: string;
    contentType?: string;
    title?: string;
    subtitle?: string;
    posterUrl?: string;
    currentTimeSec?: number;
  };

  if (!body.host || !String(body.host).trim()) {
    res.status(400).json({
      ok: false,
      message: 'Bitte eine gültige Chromecast- oder Google-TV-IP-Adresse angeben.',
    });
    return;
  }

  if (!body.contentUrl || !String(body.contentUrl).trim()) {
    res.status(400).json({
      ok: false,
      message: 'Für diesen Titel liegt keine streambare Medien-URL für Chromecast vor.',
    });
    return;
  }

  try {
    const result = await connectAndCastOnServer({
      host: String(body.host).trim(),
      port: typeof body.port === 'number' ? body.port : 8009,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
      contentUrl: String(body.contentUrl).trim(),
      contentType: typeof body.contentType === 'string' ? body.contentType : 'video/mp4',
      title: typeof body.title === 'string' ? body.title : undefined,
      subtitle: typeof body.subtitle === 'string' ? body.subtitle : undefined,
      posterUrl: typeof body.posterUrl === 'string' ? body.posterUrl : undefined,
      currentTimeSec: typeof body.currentTimeSec === 'number' ? body.currentTimeSec : 0,
      serverPort: activeServerPort,
    });
    res.json({
      ...result,
      session: getServerCastSessionState(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Chromecast-Verbindung im WLAN fehlgeschlagen.';
    res.status(502).json({
      ok: false,
      message,
      error: message,
      session: getServerCastSessionState(),
    });
  }
});

app.post('/api/nas/chromecast/control', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    action?: 'play' | 'pause' | 'seek' | 'disconnect';
    currentTimeSec?: number;
  };
  if (
    !body.action ||
    !['play', 'pause', 'seek', 'disconnect'].includes(body.action)
  ) {
    res.status(400).json({
      ok: false,
      message: 'Ungültiger Chromecast-Steuerbefehl.',
    });
    return;
  }

  const result = controlServerCastMedia({
    action: body.action,
    currentTimeSec: typeof body.currentTimeSec === 'number' ? body.currentTimeSec : undefined,
  });
  res.json({
    ...result,
    session: getServerCastSessionState(),
  });
});

// Universelle NAS-Protokollprüfung (SMB 2/3 -> WebDAV HTTPS -> SFTP -> FTPS -> Hersteller-API -> UPnP nur Medien)
app.post('/api/nas/universal/probe', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    protocol?: NasProtocolId;
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
    ftpsTlsMode?: 'explicit' | 'implicit';
    scope?: NasConnectionScope;
    timeoutMs?: number;
  };

  const host = (body.host ?? '').trim();
  if (!host) {
    res.status(400).json({
      error: 'Bitte gib zuerst eine NAS-IP oder einen Hostnamen (z. B. fritz.box oder 192.168.178.10) an.',
    });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const password =
    typeof body.secret === 'string'
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';

  try {
    const probe = await runUniversalNasProbe({
      host,
      port: body.port,
      protocol: body.protocol,
      shareOrPath: body.shareOrPath,
      username: (body.username ?? '').trim(),
      password,
      domainOrWorkgroup: body.domainOrWorkgroup,
      useTls: body.useTls,
      ftpsTlsMode: body.ftpsTlsMode,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
      timeoutMs: body.timeoutMs,
    });
    res.json(probe);
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : 'Universelle NAS-Protokollprüfung fehlgeschlagen.',
    });
  }
});

// Einzelnes NAS-Protokoll funktional testen (echter Handshake + Auth, kein reiner Port-Ping)
app.post('/api/nas/universal/test', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    protocol?: NasProtocolId;
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
    ftpsTlsMode?: 'explicit' | 'implicit';
    scope?: NasConnectionScope;
    timeoutMs?: number;
  };

  const host = (body.host ?? '').trim();
  const protocol: NasProtocolId =
    body.protocol && VALID_NAS_PROTOCOLS.has(body.protocol) ? body.protocol : 'smb';
  if (!host) {
    res.status(400).json({
      ok: false,
      error: 'Bitte gib Hostname oder IP-Adresse des NAS an.',
    });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const password =
    typeof body.secret === 'string'
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';

  try {
    const verification = await testSingleUniversalProtocol({
      host,
      port: body.port,
      protocol,
      shareOrPath: body.shareOrPath,
      username: (body.username ?? '').trim(),
      password,
      domainOrWorkgroup: body.domainOrWorkgroup,
      useTls: body.useTls,
      ftpsTlsMode: body.ftpsTlsMode,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
      timeoutMs: body.timeoutMs,
    });

    const hasCreds = Boolean((body.username ?? '').trim() || password.length > 0);
    const ok =
      !verification.blockedByVpnPolicy &&
      !verification.smb1Rejected &&
      verification.protocolVerified &&
      (!hasCreds || verification.protocol === 'sftp' || verification.authVerified);

    res.json({
      ok,
      verification,
      fritzTracks: verification.fritzTracks ?? null,
      error: ok ? null : verification.message,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Verbindungstest fehlgeschlagen.',
    });
  }
});

// Schneller Storage-Bridge Live-Status (SMB :445, FRITZ!NAS Web :80/:443, TR-064, WebDAV, ARP-MAC)
app.post('/api/nas/bridge-health', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    scope?: NasConnectionScope;
  };
  const host = (body.host ?? '').trim();
  if (!host) {
    res.status(400).json({
      ok: false,
      status: 'offline',
      latencyMs: null,
      warning: 'Keine NAS-Adresse konfiguriert.',
    });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);

  try {
    const result = await probeBridgeNasHealthServer({
      host,
      port: body.port,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: 'offline',
      host,
      latencyMs: null,
      warning: err instanceof Error ? err.message : 'Bridge-Gesundheitsprüfung fehlgeschlagen.',
    });
  }
});

// NAS / FRITZ!NAS aus dem Ruhemodus wecken (Wake-on-LAN Magic Packet, TR-064 WakeOnLAN, FRITZ!NAS/SMB USB Spin-Up)
app.post('/api/nas/wake', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    username?: string;
    password?: string;
    secret?: string;
    macAddress?: string | null;
    useTls?: boolean;
    scope?: NasConnectionScope;
  };
  const host = (body.host ?? '').trim() || 'fritz.box';
  const password =
    typeof body.secret === 'string'
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);

  try {
    const wakeRes = await wakeNasDeviceServer({
      host,
      username: (body.username ?? '').trim(),
      password,
      macAddress: body.macAddress ?? null,
      useTls: body.useTls,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    res.json(wakeRes);
  } catch (err) {
    res.status(500).json({
      ok: false,
      wokeUp: false,
      status: 'offline',
      host,
      latencyMs: null,
      channelsTriggered: [],
      message: err instanceof Error ? err.message : 'NAS-Aufwecken fehlgeschlagen.',
    });
  }
});

// Universelle NAS-Anmeldung (ohne Port-3000-Voraussetzung, bindet Profil verschlüsselt ein)
app.post('/api/nas/universal/login', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    protocol?: NasProtocolId | 'auto';
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    displayName?: string;
    profileName?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
    ftpsTlsMode?: 'explicit' | 'implicit';
    scope?: NasConnectionScope;
  };

  const hostInput = (body.host ?? '').trim();
  if (!hostInput) {
    res.status(400).json({ error: 'Bitte gib die Adresse deines NAS an.' });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const nasUsername = (body.username ?? '').trim();
  const nasPassword =
    typeof body.secret === 'string'
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';

  let chosenProtocol: NasProtocolId | null = null;
  let chosenPort = body.port ? String(body.port).trim() : '';
  let verification: NasProtocolVerificationResult | null = null;
  let probeSummary: UniversalNasProbeResponse | null = null;

  if (!body.protocol || body.protocol === 'auto') {
    probeSummary = await runUniversalNasProbe({
      host: hostInput,
      port: body.port,
      shareOrPath: body.shareOrPath,
      username: nasUsername,
      password: nasPassword,
      domainOrWorkgroup: body.domainOrWorkgroup,
      useTls: body.useTls,
      ftpsTlsMode: body.ftpsTlsMode,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    if (!probeSummary.recommendedProtocol) {
      res.status(401).json({
        error: probeSummary.errors[0] || probeSummary.userFriendlySummary,
        probe: probeSummary,
      });
      return;
    }
    chosenProtocol = probeSummary.recommendedProtocol;
    if (probeSummary.recommendedPort) {
      chosenPort = String(probeSummary.recommendedPort);
    }
    verification =
      probeSummary.resultsByPriority.find((r) => r.protocol === chosenProtocol) ?? null;
  } else {
    chosenProtocol = VALID_NAS_PROTOCOLS.has(body.protocol) ? body.protocol : 'smb';
    const single = await testSingleUniversalProtocol({
      host: hostInput,
      port: body.port,
      protocol: chosenProtocol,
      shareOrPath: body.shareOrPath,
      username: nasUsername,
      password: nasPassword,
      domainOrWorkgroup: body.domainOrWorkgroup,
      useTls: body.useTls,
      ftpsTlsMode: body.ftpsTlsMode,
      scope: body.scope,
      allowLocalSelfSignedTls: networkCfg.allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    verification = single;
    if (!chosenPort) chosenPort = String(single.port);
  }

  if (verification?.blockedByVpnPolicy) {
    res.status(403).json({
      error: verification.message,
      verification,
      probe: probeSummary,
    });
    return;
  }
  if (verification?.smb1Rejected) {
    res.status(403).json({
      error: verification.message,
      verification,
      probe: probeSummary,
    });
    return;
  }

  const hasCreds = Boolean(nasUsername || nasPassword);
  const passedAuth =
    !hasCreds ||
    chosenProtocol === 'sftp' ||
    Boolean(verification?.authVerified);

  if (!verification?.protocolVerified || !passedAuth) {
    res.status(401).json({
      error:
        verification?.message ||
        'NAS-Protokollprüfung oder Anmeldung fehlgeschlagen. Bitte Zugangsdaten, Port und VPN-Verbindung prüfen.',
      verification,
      probe: probeSummary,
    });
    return;
  }

  // Konto im EntenCenter-Tresor anlegen oder aktualisieren (niemals Klartextpasswort loggen)
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const existingUsers = Object.values(users);
  const hasAnyAdmin = existingUsers.some((u) => u.role === 'admin');
  const safeHostSlug = hostInput
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
  const accountKey = (nasUsername || `nas_${safeHostSlug || 'default'}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');

  let userRecord = users[accountKey];
  if (!userRecord) {
    const initialSecret = nasPassword || crypto.randomBytes(20).toString('hex');
    const { salt, hash } = hashPassword(initialSecret);
    userRecord = {
      id: `usr-${crypto.randomUUID().slice(0, 8)}`,
      username: accountKey,
      displayName: body.displayName?.trim() || nasUsername || `NAS (${hostInput})`,
      role: !hasAnyAdmin ? 'admin' : 'family',
      fskLimit: 18,
      salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      avatarColor: '#F59E0B',
    };
    users[accountKey] = userRecord;
    writeJsonAtomic('users.json', users);
  } else if (!hasAnyAdmin) {
    userRecord.role = 'admin';
    users[accountKey] = userRecord;
    writeJsonAtomic('users.json', users);
  }

  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const defaults = getDefaultNasConnection();
  const nextConnRecord: StoredNasConnection = {
    ...defaults,
    protocol: chosenProtocol,
    host: hostInput,
    port: chosenPort || defaults.port,
    shareOrPath:
      (body.shareOrPath ?? '').trim() ||
      (chosenProtocol === 'fritz_upnp' ? '/MediaServer' : '/'),
    username: nasUsername,
    encryptedSecret: nasPassword ? encryptNasSecret(nasPassword) : null,
    domainOrWorkgroup: body.domainOrWorkgroup,
    ftpsTlsMode: body.ftpsTlsMode,
    accessMode: chosenProtocol === 'fritz_upnp' ? 'read_only' : 'read_write',
    writePermissions: chosenProtocol !== 'fritz_upnp',
    useTls: verification.useTls,
    updatedAt: new Date().toISOString(),
  };
  connStore.users[accountKey] = nextConnRecord;
  writeJsonAtomic('nas_connections.json', connStore);

  ensureUserProfileFolder(accountKey, userRecord);
  appendWal('UNIVERSAL_NAS_LOGIN', accountKey, {
    protocol: chosenProtocol,
    host: hostInput,
    port: chosenPort,
    role: verification.role,
    vendor: probeSummary?.detectedVendor ?? 'standard_nas',
  });

  res.json({
    ok: true,
    token: signSessionToken(accountKey),
    user: serializeUser(userRecord),
    nasConnection: toPublicNasConnection(nextConnRecord),
    verification,
    probe: probeSummary,
    warning:
      chosenProtocol === 'fritz_upnp'
        ? 'UPnP/DLNA dient ausschließlich der Medienwiedergabe — für direkten Dateizugriff SMB 2/3 oder WebDAV nutzen.'
        : verification.warning ?? null,
  });
});

// Tokenlose Anmeldung über Fritzbox UPnP/DLNA-Discovery im selben Subnetz
app.post('/api/nas/auth/fritz-tokenless', async (req: Request, res: Response) => {
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const existingUsers = Object.values(users);
  const isFirstUser = existingUsers.length === 0;
  const allowedProtocols = isFirstUser ? ALL_NAS_PROTOCOLS : readAllowedNasProtocols();

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const discoveryConfig = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);

  if (!discoveryConfig.enabled) {
    res.status(403).json({
      error:
        'Fritzbox UPnP/DLNA-Discovery ist in den Netzwerkeinstellungen (Adminbereich) deaktiviert.',
    });
    return;
  }

  if (!allowedProtocols.includes('fritz_upnp')) {
    res.status(403).json({
      error:
        'FRITZ!Box UPnP / DLNA ist in den unterstützten NAS-Anmeldewegen deaktiviert.',
    });
    return;
  }

  const body = (req.body ?? {}) as {
    host?: string;
    port?: string;
    shareOrPath?: string;
    clientDiscoveredDevice?: {
      host?: string;
      ip?: string;
      friendlyName?: string;
    };
  };

  const probe = await runFritzDiscoveryProbe(req, discoveryConfig, true);

  let clientConfirmedSameSubnet = false;
  if (body.clientDiscoveredDevice) {
    const rawCandidate =
      (body.clientDiscoveredDevice.ip ?? body.clientDiscoveredDevice.host ?? '').trim();
    if (rawCandidate) {
      const subnets = getNasNetworkSubnets();
      const resolvedIp = await resolveHostnameToIpv4(rawCandidate);
      if (resolvedIp && isIpInNasSubnet(resolvedIp, subnets, discoveryConfig.subnetCidr)) {
        clientConfirmedSameSubnet = true;
      }
    }
  }

  const sameSubnetOk =
    !discoveryConfig.subnetMatchRequired ||
    (probe.clientInSameSubnet && (probe.sameSubnetDeviceFound || clientConfirmedSameSubnet));

  if (!sameSubnetOk) {
    res.status(403).json({
      error: probe.reason || 'Tokenlose Anmeldung nicht möglich: Kein FRITZ!Box-Gerät im selben Subnetz gefunden.',
      probe,
    });
    return;
  }

  const matchedDevice = probe.discoveredDevices.find((d) => d.sameSubnet) ?? probe.discoveredDevices[0];
  const host =
    (body.host ?? '').trim() ||
    matchedDevice?.ip ||
    matchedDevice?.host ||
    discoveryConfig.probeHosts[0] ||
    'fritz.box';
  const port =
    (body.port ?? '').trim() ||
    matchedDevice?.port ||
    discoveryConfig.probePort ||
    '49000';
  const shareOrPath = (body.shareOrPath ?? '').trim() || '/MediaServer';

  const upnpUsername = 'fritzbox_upnp';
  const hasAnyAdmin = existingUsers.some((u) => u.role === 'admin');
  let upnpUser = users[upnpUsername];

  if (!upnpUser) {
    const randomPass = crypto.randomBytes(24).toString('hex');
    const { salt, hash } = hashPassword(randomPass);
    upnpUser = {
      id: `usr-${crypto.randomUUID().slice(0, 8)}`,
      username: upnpUsername,
      displayName: matchedDevice?.friendlyName || 'FRITZ!Box UPnP / DLNA',
      role: !hasAnyAdmin ? 'admin' : 'family',
      fskLimit: 18,
      salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      avatarColor: '#38BDF8',
    };
    users[upnpUsername] = upnpUser;
    writeJsonAtomic('users.json', users);
  } else if (!hasAnyAdmin) {
    upnpUser.role = 'admin';
    users[upnpUsername] = upnpUser;
    writeJsonAtomic('users.json', users);
  }

  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const defaults = getDefaultNasConnection();
  const nextRecord: StoredNasConnection = {
    ...defaults,
    protocol: 'fritz_upnp',
    host,
    port,
    shareOrPath,
    username: '',
    encryptedSecret: null,
    accessMode: 'read_write',
    writePermissions: true,
    useTls: false,
    updatedAt: new Date().toISOString(),
  };
  connStore.users[upnpUsername] = nextRecord;
  writeJsonAtomic('nas_connections.json', connStore);

  const profileFolder = ensureUserProfileFolder(upnpUsername, upnpUser);

  appendWal('FRITZ_UPNP_TOKENLESS_LOGIN', upnpUsername, {
    host,
    port,
    deviceName: matchedDevice?.friendlyName ?? null,
    clientIp: probe.clientIp,
    localSubnets: probe.localSubnets,
    writePermissions: true,
    profileFolder: profileFolder?.nasMountPath ?? null,
  });
  syncCalendarAndAlerts(upnpUsername);

  res.json({
    token: signSessionToken(upnpUsername),
    user: serializeUser(upnpUser),
    nasConnection: toPublicNasConnection(nextRecord),
    profileFolder,
    probe,
  });
});

// NAS Auth: Direktzugriff auf NVS über FRITZ!Box UPnP / DLNA / FRITZ!NAS im Heimnetz (optional mit FRITZ!Box Challenge-Response)
app.post('/api/nas/auth/fritz-upnp', async (req: Request, res: Response) => {
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const existingUsers = Object.values(users);
  const isFirstUser = existingUsers.length === 0;
  const allowedProtocols = isFirstUser ? ALL_NAS_PROTOCOLS : readAllowedNasProtocols();

  if (!allowedProtocols.includes('fritz_upnp')) {
    res.status(403).json({
      error:
        'FRITZ!Box UPnP / DLNA ist in den Netzwerkeinstellungen (Adminbereich) aktuell deaktiviert.',
    });
    return;
  }

  const body = (req.body ?? {}) as {
    host?: string;
    port?: string;
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    useTls?: boolean;
    skipVerify?: boolean;
  };
  const parsed = parseNasHostInput(
    (body.host ?? '').trim() || 'fritz.box',
    body.port ?? '',
    body.shareOrPath ?? ''
  );
  const host = parsed.hostname || 'fritz.box';
  const rawPort = parsed.port || '49000';
  const shareOrPath = parsed.path || '/MediaServer';
  const fritzUsername = (body.username ?? '').trim();
  const fritzPassword = (body.password ?? body.secret ?? '').trim();
  const requestedUseTls =
    typeof body.useTls === 'boolean'
      ? body.useTls
      : parsed.explicitScheme === 'https' || rawPort === '443' || rawPort === '49443';

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const allowLocalSelfSignedTls = networkCfg.allowLocalSelfSignedTls;

  let fritzProbe: Awaited<ReturnType<typeof FritzBoxSessionClient.probeLoginSid>> | null = null;
  let effectivePort = rawPort;
  let effectiveUseTls = requestedUseTls;
  let fritzAuthenticated = false;
  let httpsFallbackToHttp = false;
  let httpsError: string | null = null;

  if (!body.skipVerify) {
    fritzProbe = await FritzBoxSessionClient.probeLoginSid(
      host,
      allowLocalSelfSignedTls,
      activeCert?.pem ?? null,
      850
    ).catch(() => null);

    if (fritzPassword.length > 0) {
      const sessionClient = new FritzBoxSessionClient({
        host,
        port: rawPort === '49000' || rawPort === '49443' ? (requestedUseTls ? 443 : 80) : Number(rawPort),
        useTls: requestedUseTls,
        username: fritzUsername,
        password: fritzPassword,
        allowLocalSelfSignedTls,
        customCaPem: activeCert?.pem ?? null,
      });
      const authRes = await sessionClient.getValidSession(true).catch(() => null);
      if (authRes?.ok) {
        fritzAuthenticated = true;
        httpsFallbackToHttp = Boolean(authRes.httpsFallbackToHttp);
        httpsError = authRes.httpsError ?? null;
        if (authRes.effectiveScheme) {
          effectiveUseTls = authRes.effectiveScheme === 'https';
        }
        if (authRes.effectivePort && (rawPort === '80' || rawPort === '443')) {
          effectivePort = String(authRes.effectivePort);
        }
        const nextStoredFritz: StoredFritzSessionConfig = {
          host: sessionClient.host,
          port: authRes.effectivePort ?? sessionClient.port,
          useTls: authRes.effectiveScheme ? authRes.effectiveScheme === 'https' : sessionClient.useTls,
          username: fritzUsername,
          encryptedPassword: encryptNasSecret(fritzPassword),
          allowLocalSelfSignedTls,
          updatedAt: new Date().toISOString(),
          updatedBy: 'fritzbox_upnp',
        };
        writeJsonAtomic('fritz_session.json', nextStoredFritz);
      } else if (fritzProbe?.detected) {
        res.status(401).json({
          error:
            authRes?.error ||
            'FRITZ!Box-Anmeldung fehlgeschlagen. Bitte FRITZ!Box-Benutzername und Kennwort prüfen.',
          requiresFritzCredentials: true,
          httpsFallbackToHttp: Boolean(authRes?.httpsFallbackToHttp),
          httpsError: authRes?.httpsError ?? fritzProbe.httpsError,
          probe: fritzProbe,
        });
        return;
      }
    } else if (fritzProbe?.detected && fritzProbe.requiresAuth) {
      res.status(401).json({
        error:
          'Diese FRITZ!Box / FRITZ!NAS verlangt vor dem Zugriff eine Anmeldung (FRITZ!Box-Kennwort bzw. Benutzer + Kennwort).',
        requiresFritzCredentials: true,
        httpsFallbackToHttp: !fritzProbe.httpsAvailable && fritzProbe.httpAvailable,
        httpsError: fritzProbe.httpsError,
        probe: fritzProbe,
      });
      return;
    }
  }

  const upnpUsername = 'fritzbox_upnp';
  const hasAnyAdmin = existingUsers.some((u) => u.role === 'admin');
  let upnpUser = users[upnpUsername];

  if (!upnpUser) {
    const randomPass = crypto.randomBytes(24).toString('hex');
    const { salt, hash } = hashPassword(randomPass);
    upnpUser = {
      id: `usr-${crypto.randomUUID().slice(0, 8)}`,
      username: upnpUsername,
      displayName: 'FRITZ!Box UPnP / DLNA',
      role: !hasAnyAdmin ? 'admin' : 'family',
      fskLimit: 18,
      salt,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      avatarColor: '#38BDF8',
    };
    users[upnpUsername] = upnpUser;
    writeJsonAtomic('users.json', users);
    appendWal('FRITZ_UPNP_PROFILE_CREATED', upnpUsername, {
      role: upnpUser.role,
      host,
      port: effectivePort,
    });
  } else if (!hasAnyAdmin) {
    upnpUser.role = 'admin';
    users[upnpUsername] = upnpUser;
    writeJsonAtomic('users.json', users);
  }

  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const defaults = getDefaultNasConnection();
  const existingConn = connStore.users[upnpUsername];
  const nextRecord: StoredNasConnection = {
    ...defaults,
    protocol: 'fritz_upnp',
    host,
    port: effectivePort,
    shareOrPath,
    username: fritzUsername || (fritzPassword ? '' : (existingConn?.username ?? '')),
    encryptedSecret:
      fritzPassword.length > 0
        ? encryptNasSecret(fritzPassword)
        : (existingConn?.encryptedSecret ?? null),
    accessMode: 'read_write',
    writePermissions: true,
    useTls: effectiveUseTls,
    updatedAt: new Date().toISOString(),
  };
  connStore.users[upnpUsername] = nextRecord;
  writeJsonAtomic('nas_connections.json', connStore);

  const profileFolder = ensureUserProfileFolder(upnpUsername, upnpUser);

  appendWal('FRITZ_UPNP_AUTO_LOGIN', upnpUsername, {
    host,
    port: effectivePort,
    shareOrPath,
    zeroExtraLogin: fritzPassword.length === 0,
    fritzAuthenticated,
    httpsFallbackToHttp,
    writePermissions: true,
    profileFolder: profileFolder?.nasMountPath ?? null,
  });
  syncCalendarAndAlerts(upnpUsername);

  res.json({
    token: signSessionToken(upnpUsername),
    user: serializeUser(upnpUser),
    nasConnection: toPublicNasConnection(nextRecord),
    profileFolder,
    fritzAuth: {
      authenticated: fritzAuthenticated,
      requiresCredentials: Boolean(fritzProbe?.requiresAuth),
      httpsFallbackToHttp,
      httpsError,
    },
  });
});

// NAS Auth: Profile list (only Admin sees all profiles; non-admins only see their own profile)
app.get('/api/nas/profiles', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const requester = users[username];
  if (!requester) {
    res.status(401).json({ error: 'Benutzerkonto auf dem NAS nicht mehr vorhanden.' });
    return;
  }
  const visibleUsers = requester.role === 'admin' ? Object.values(users) : [requester];
  res.json({ profiles: visibleUsers.map(serializeUser) });
});

// NAS Auth: Validate active persistent session and return fresh user data
app.get('/api/nas/session', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = users[username];
  if (!user) {
    res.status(401).json({ error: 'Benutzerkonto auf dem NAS nicht mehr vorhanden.' });
    return;
  }
  const profileFolder = ensureUserProfileFolder(username, user);
  res.json({
    user: serializeUser(user),
    profileFolder,
  });
});

// NAS Auth: Login (if no admin exists yet on the NAS, the first logging-in user becomes Admin)
app.post('/api/nas/login', (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Bitte Name und Passwort eingeben.' });
    return;
  }
  const cleanUser = username.trim().toLowerCase();
  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const user = users[cleanUser];
  if (!user) {
    res.status(401).json({ error: `Benutzer "${username}" existiert nicht auf dem NAS.` });
    return;
  }

  const { hash } = hashPassword(password, user.salt);
  if (
    hash.length !== user.passwordHash.length ||
    !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash))
  ) {
    res.status(401).json({ error: 'Falsches Passwort für dieses NAS-Konto.' });
    return;
  }

  const hasAnyAdmin = Object.values(users).some((u) => u.role === 'admin');
  if (!hasAnyAdmin) {
    user.role = 'admin';
    users[cleanUser] = user;
    writeJsonAtomic('users.json', users);
    appendWal('FIRST_LOGIN_ADMIN_ASSIGNED', cleanUser, {});
  }

  const profileFolder = ensureUserProfileFolder(cleanUser, user);
  appendWal('USER_LOGIN', cleanUser, {
    zeroLocalFootprint: true,
    profileFolder: profileFolder?.nasMountPath ?? null,
  });
  syncCalendarAndAlerts(cleanUser);

  res.json({
    token: signSessionToken(cleanUser),
    user: serializeUser(user),
    profileFolder,
  });
});

// NAS Auth: Register new local NAS user (first user / when no admin exists is automatically Admin)
app.post('/api/nas/register', (req: Request, res: Response) => {
  const { username, password, displayName, nasConnection } = req.body as {
    username?: string;
    password?: string;
    displayName?: string;
    nasConnection?: {
      protocol?: NasProtocolId;
      host?: string;
      port?: string;
      shareOrPath?: string;
      username?: string;
      secret?: string;
      domainOrWorkgroup?: string;
      nfsVersion?: StoredNasConnection['nfsVersion'];
      nfsAuthMode?: StoredNasConnection['nfsAuthMode'];
      sftpAuthMode?: StoredNasConnection['sftpAuthMode'];
      ftpsTlsMode?: StoredNasConnection['ftpsTlsMode'];
      apiVendor?: StoredNasConnection['apiVendor'];
      useTls?: boolean;
      backendPath?: string;
      backendProvisioned?: boolean;
      storageBridgeMode?: boolean;
    };
  };
  if (!username || !password || password.length < 4) {
    res
      .status(400)
      .json({ error: 'Name und ein Passwort mit mindestens 4 Zeichen sind erforderlich.' });
    return;
  }

  const cleanUser = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanUser) {
    res.status(400).json({ error: 'Ungültiger Benutzername.' });
    return;
  }

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  if (users[cleanUser]) {
    res.status(409).json({ error: 'Dieses Benutzerkonto existiert bereits auf dem NAS.' });
    return;
  }

  const existingUsers = Object.values(users);
  const isFirstUser = existingUsers.length === 0;
  const hasAdmin = existingUsers.some((u) => u.role === 'admin');
  const assignedRole: 'admin' | 'family' = isFirstUser || !hasAdmin ? 'admin' : 'family';

  const allowedProtocolsForRegistration = isFirstUser
    ? ALL_NAS_PROTOCOLS
    : readAllowedNasProtocols();

  const isFritzUpnpSelected = nasConnection?.protocol === 'fritz_upnp';
  const rawNasHost = (nasConnection?.host ?? '').trim() || (isFritzUpnpSelected ? 'fritz.box' : '');
  const rawNasUser = (nasConnection?.username ?? '').trim();
  const rawNasSecret =
    typeof nasConnection?.secret === 'string' ? nasConnection.secret : '';
  const hasAnyNasDetails = Boolean(rawNasHost || rawNasUser || rawNasSecret);

  let nasRecordToSave: StoredNasConnection | null = null;
  if (hasAnyNasDetails) {
    const reqProto = nasConnection?.protocol ?? 'smb';
    if (!VALID_NAS_PROTOCOLS.has(reqProto)) {
      res.status(400).json({ error: 'Bitte wähle einen gültigen NAS-Anmeldeweg.' });
      return;
    }
    if (!allowedProtocolsForRegistration.includes(reqProto)) {
      res.status(403).json({
        error: 'Der gewählte NAS-Anmeldeweg ist vom Administrator nicht freigegeben.',
      });
      return;
    }
    if (!rawNasHost) {
      res.status(400).json({
        error: 'Bitte gib für deine optionalen NAS-Zugangsdaten noch einen NAS-Hostnamen oder eine IP-Adresse an (oder lasse beides leer).',
      });
      return;
    }
    const defaults = getDefaultNasConnection();
    const resolvedRegPort =
      (nasConnection?.port ?? '').trim() || (isFritzUpnpSelected ? '49000' : '');
    const resolvedRegUseTls =
      typeof nasConnection?.useTls === 'boolean'
        ? nasConnection.useTls
        : isFritzUpnpSelected
          ? resolvedRegPort === '443' || resolvedRegPort === '49443'
          : defaults.useTls;
    nasRecordToSave = {
      protocol: reqProto,
      host: rawNasHost,
      port: resolvedRegPort,
      shareOrPath:
        (nasConnection?.shareOrPath ?? '').trim() ||
        (isFritzUpnpSelected ? '/MediaServer' : '/'),
      username: rawNasUser,
      encryptedSecret: rawNasSecret.length > 0 ? encryptNasSecret(rawNasSecret) : null,
      accessMode: 'read_write',
      writePermissions: true,
      domainOrWorkgroup:
        (nasConnection?.domainOrWorkgroup ?? defaults.domainOrWorkgroup ?? 'WORKGROUP').trim() ||
        'WORKGROUP',
      nfsVersion: nasConnection?.nfsVersion ?? defaults.nfsVersion,
      nfsAuthMode: nasConnection?.nfsAuthMode ?? defaults.nfsAuthMode,
      sftpAuthMode: nasConnection?.sftpAuthMode ?? defaults.sftpAuthMode,
      ftpsTlsMode: nasConnection?.ftpsTlsMode ?? defaults.ftpsTlsMode,
      apiVendor: nasConnection?.apiVendor ?? defaults.apiVendor,
      useTls: resolvedRegUseTls,
      backendPath: (nasConnection?.backendPath ?? '').trim(),
      backendProvisioned: Boolean(nasConnection?.backendProvisioned),
      storageBridgeMode: Boolean(nasConnection?.storageBridgeMode),
      updatedAt: new Date().toISOString(),
    };
  }

  const { salt, hash } = hashPassword(password);
  const newUser: StoredUser = {
    id: `usr-${crypto.randomUUID().slice(0, 8)}`,
    username: cleanUser,
    displayName: displayName?.trim() || username.trim(),
    role: assignedRole,
    fskLimit: 18,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    avatarColor: assignedRole === 'admin' ? '#EAB308' : '#38BDF8',
  };
  users[cleanUser] = newUser;
  writeJsonAtomic('users.json', users);
  appendWal('USER_CREATED', cleanUser, {
    displayName: newUser.displayName,
    role: assignedRole,
    firstAdmin: assignedRole === 'admin',
  });

  if (nasRecordToSave) {
    const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
    connStore.users[cleanUser] = nasRecordToSave;
    writeJsonAtomic('nas_connections.json', connStore);
    appendWal('NAS_CONNECTION_CREATED_ON_REGISTER', cleanUser, {
      protocol: nasRecordToSave.protocol,
      host: nasRecordToSave.host,
      hasSecret: Boolean(nasRecordToSave.encryptedSecret),
      writePermissions: nasRecordToSave.writePermissions ?? true,
    });
  }

  const profileFolder = ensureUserProfileFolder(cleanUser, newUser);

  res.status(201).json({
    token: signSessionToken(cleanUser),
    user: serializeUser(newUser),
    nasConnectionSaved: Boolean(nasRecordToSave),
    profileFolder,
  });
});

// Admin Only: Create a new NAS profile (e.g. Kinderprofil with FSK 12)
app.post('/api/nas/admin/profiles', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const { username, displayName, password, role, fskLimit } = req.body as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: 'admin' | 'family';
    fskLimit?: FskLevel;
  };

  if (!username || !password || password.length < 4) {
    res
      .status(400)
      .json({ error: 'Benutzername und Passwort (mind. 4 Zeichen) sind erforderlich.' });
    return;
  }

  const cleanUser = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (cleanUser.length < 2) {
    res.status(400).json({ error: 'Benutzername muss mindestens 2 gültige Zeichen enthalten.' });
    return;
  }

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  if (users[cleanUser]) {
    res.status(409).json({ error: `Das Profil "@${cleanUser}" existiert bereits.` });
    return;
  }

  const assignedRole: 'admin' | 'family' = role === 'admin' ? 'admin' : 'family';
  const assignedFsk = normalizeFskLimit(fskLimit, 12);
  const { salt, hash } = hashPassword(password);
  const avatarPalette = ['#38BDF8', '#34D399', '#FB7185', '#A78BFA', '#F59E0B'];
  const avatarColor = avatarPalette[Object.keys(users).length % avatarPalette.length];

  const created: StoredUser = {
    id: `usr-${crypto.randomUUID().slice(0, 8)}`,
    username: cleanUser,
    displayName: displayName?.trim() || cleanUser,
    role: assignedRole,
    fskLimit: assignedFsk,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    avatarColor,
  };

  users[cleanUser] = created;
  writeJsonAtomic('users.json', users);
  const profileFolder = ensureUserProfileFolder(cleanUser, created);
  appendWal('ADMIN_PROFILE_CREATED', actor.username, {
    targetUsername: cleanUser,
    role: assignedRole,
    fskLimit: assignedFsk,
    profileFolder: profileFolder?.nasMountPath ?? null,
  });

  res.status(201).json({
    profile: serializeUser(created),
    profiles: Object.values(users).map(serializeUser),
    profileFolder,
  });
});

// Admin Only: Update profile role (grant/transfer admin rights) and FSK age limit
app.put(
  '/api/nas/admin/profiles/:targetUsername',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const targetUsername = req.params.targetUsername.trim().toLowerCase();
    const { fskLimit, role, transferExclusive, displayName } = req.body as {
      fskLimit?: FskLevel;
      role?: 'admin' | 'family';
      transferExclusive?: boolean;
      displayName?: string;
    };

    const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
    const targetUser = users[targetUsername];
    if (!targetUser) {
      res.status(404).json({ error: `Profil "@${targetUsername}" nicht auf dem NAS gefunden.` });
      return;
    }

    if (fskLimit !== undefined) {
      if (!VALID_FSK_LEVELS.has(Number(fskLimit) as FskLevel)) {
        res.status(400).json({ error: 'Ungültige FSK-Stufe. Erlaubt: 0, 6, 12, 16 oder 18.' });
        return;
      }
      targetUser.fskLimit = Number(fskLimit) as FskLevel;
    }

    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      targetUser.displayName = displayName.trim();
    }

    if (transferExclusive === true) {
      if (targetUsername === actor.username) {
        res.status(400).json({
          error: 'Bitte wähle ein anderes Benutzerprofil aus, um die Admin-Rolle zu übertragen.',
        });
        return;
      }
      targetUser.role = 'admin';
      users[actor.username] = {
        ...users[actor.username],
        role: 'family',
      };
      users[targetUsername] = targetUser;
      writeJsonAtomic('users.json', users);
      appendWal('ADMIN_ROLE_TRANSFERRED', actor.username, {
        newAdmin: targetUsername,
        previousAdmin: actor.username,
        exclusive: true,
      });
      res.json({
        profile: serializeUser(targetUser),
        currentUser: serializeUser(users[actor.username]),
        profiles: Object.values(users).map(serializeUser),
      });
      return;
    }

    if (role === 'admin' || role === 'family') {
      if (role === 'family' && targetUser.role === 'admin') {
        const otherAdmins = Object.values(users).filter(
          (u) => u.role === 'admin' && u.username !== targetUsername
        );
        if (otherAdmins.length === 0) {
          res.status(400).json({
            error:
              'Es muss mindestens ein Administrator auf dem NAS verbleiben. Übertrage zuerst die Admin-Rechte an ein anderes Profil.',
          });
          return;
        }
      }
      targetUser.role = role;
    }

    users[targetUsername] = targetUser;
    writeJsonAtomic('users.json', users);
    appendWal('ADMIN_PROFILE_UPDATED', actor.username, {
      targetUsername,
      role: targetUser.role,
      fskLimit: normalizeFskLimit(targetUser.fskLimit, 18),
    });

    res.json({
      profile: serializeUser(targetUser),
      currentUser: serializeUser(users[actor.username]),
      profiles: Object.values(users).map(serializeUser),
    });
  }
);

// Admin Only: Delete a non-self profile
app.delete(
  '/api/nas/admin/profiles/:targetUsername',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const targetUsername = req.params.targetUsername.trim().toLowerCase();
    if (targetUsername === actor.username) {
      res.status(400).json({ error: 'Das aktuell angemeldete Admin-Profil kann nicht gelöscht werden.' });
      return;
    }

    const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
    const targetUser = users[targetUsername];
    if (!targetUser) {
      res.status(404).json({ error: 'Profil auf dem NAS nicht gefunden.' });
      return;
    }

    if (targetUser.role === 'admin') {
      const otherAdmins = Object.values(users).filter(
        (u) => u.role === 'admin' && u.username !== targetUsername
      );
      if (otherAdmins.length === 0) {
        res.status(400).json({ error: 'Der letzte Administrator darf nicht gelöscht werden.' });
        return;
      }
    }

    delete users[targetUsername];
    writeJsonAtomic('users.json', users, { allowShrink: true });
    deleteUserProfileFolder(targetUsername);
    appendWal('ADMIN_PROFILE_DELETED', actor.username, { targetUsername });

    res.json({
      profiles: Object.values(users).map(serializeUser),
    });
  }
);

// NAS Auth: Update current user's username, displayName and/or password
app.put('/api/nas/profile', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const currentUsername = req.nasUsername!;
  const { currentPassword, newUsername, newDisplayName, newPassword } = req.body as {
    currentPassword?: string;
    newUsername?: string;
    newDisplayName?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    res.status(400).json({ error: 'Bitte gib dein aktuelles Passwort zur Bestätigung ein.' });
    return;
  }

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const existingUser = users[currentUsername];
  if (!existingUser) {
    res.status(404).json({ error: 'Aktuelles Benutzerkonto wurde auf dem NAS nicht gefunden.' });
    return;
  }

  const { hash: currentHash } = hashPassword(currentPassword, existingUser.salt);
  if (
    currentHash.length !== existingUser.passwordHash.length ||
    !crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(existingUser.passwordHash))
  ) {
    res.status(401).json({ error: 'Das aktuelle Passwort ist nicht korrekt.' });
    return;
  }

  let finalUsername = currentUsername;
  if (typeof newUsername === 'string' && newUsername.trim().length > 0) {
    const cleaned = newUsername.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (cleaned.length < 2) {
      res.status(400).json({
        error:
          'Ungültiger Benutzername. Bitte mindestens 2 Zeichen (a–z, 0–9, _ oder -) verwenden.',
      });
      return;
    }
    finalUsername = cleaned;
  }

  if (finalUsername !== currentUsername && users[finalUsername]) {
    res.status(409).json({
      error: `Der Benutzername "${finalUsername}" ist auf dem NAS bereits vergeben.`,
    });
    return;
  }

  let updatedSalt = existingUser.salt;
  let updatedPasswordHash = existingUser.passwordHash;
  const passwordChanged = typeof newPassword === 'string' && newPassword.length > 0;
  if (passwordChanged) {
    if (newPassword.length < 4) {
      res.status(400).json({
        error: 'Das neue Passwort muss mindestens 4 Zeichen lang sein.',
      });
      return;
    }
    const nextCreds = hashPassword(newPassword);
    updatedSalt = nextCreds.salt;
    updatedPasswordHash = nextCreds.hash;
  }

  const nextDisplayName =
    typeof newDisplayName === 'string' && newDisplayName.trim().length > 0
      ? newDisplayName.trim()
      : existingUser.displayName === currentUsername
        ? finalUsername
        : existingUser.displayName;

  const updatedUser: StoredUser = {
    ...existingUser,
    username: finalUsername,
    displayName: nextDisplayName,
    salt: updatedSalt,
    passwordHash: updatedPasswordHash,
  };

  if (finalUsername !== currentUsername) {
    delete users[currentUsername];
    users[finalUsername] = updatedUser;

    // Watch-Verlauf auf neuen Benutzernamen migrieren
    const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
    let historyChanged = false;
    history.watches = history.watches.map((entry) => {
      if (entry.username === currentUsername) {
        historyChanged = true;
        return { ...entry, username: finalUsername };
      }
      return entry;
    });
    if (historyChanged) {
      writeJsonAtomic('history.json', history, { allowShrink: true });
    }

    // Favoriten-Regeln auf neuen Benutzernamen migrieren
    const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
    if (favs.users[currentUsername]) {
      favs.users[finalUsername] = favs.users[currentUsername];
      delete favs.users[currentUsername];
      writeJsonAtomic('favorites.json', favs, { allowShrink: true });
    }

    // Benachrichtigungen auf neuen Benutzernamen migrieren
    const notificationsStore = readJsonFile<NotificationsStore>('notifications.json', {
      alerts: [],
      dismissedIds: {},
    });
    let alertsChanged = false;
    notificationsStore.alerts = notificationsStore.alerts.map((alert) => {
      if (alert.username === currentUsername) {
        alertsChanged = true;
        return { ...alert, username: finalUsername };
      }
      return alert;
    });
    if (notificationsStore.dismissedIds?.[currentUsername]) {
      notificationsStore.dismissedIds[finalUsername] =
        notificationsStore.dismissedIds[currentUsername];
      delete notificationsStore.dismissedIds[currentUsername];
      alertsChanged = true;
    }
    if (alertsChanged) {
      writeJsonAtomic('notifications.json', notificationsStore, { allowShrink: true });
    }

    // Watchlist auf neuen Benutzernamen migrieren
    const watchlist = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
    if (watchlist.users[currentUsername]) {
      watchlist.users[finalUsername] = watchlist.users[currentUsername];
      delete watchlist.users[currentUsername];
      writeJsonAtomic('watchlist.json', watchlist, { allowShrink: true });
    }

    // Design- & Startbildschirm-Präferenzen auf neuen Benutzernamen migrieren
    const prefs = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
    if (prefs.users[currentUsername]) {
      prefs.users[finalUsername] = prefs.users[currentUsername];
      delete prefs.users[currentUsername];
      writeJsonAtomic('preferences.json', prefs, { allowShrink: true });
    }

    // NAS-Anmeldedaten auf neuen Benutzernamen migrieren
    const nasConns = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
    if (nasConns.users[currentUsername]) {
      nasConns.users[finalUsername] = nasConns.users[currentUsername];
      delete nasConns.users[currentUsername];
      writeJsonAtomic('nas_connections.json', nasConns, { allowShrink: true });
    }

    // Gespeicherte Enten-Watchlisten & -Playlisten migrieren
    const collections = readJsonFile<CollectionsStore>('collections.json', { users: {} });
    if (collections.users[currentUsername]) {
      collections.users[finalUsername] = collections.users[currentUsername];
      delete collections.users[currentUsername];
      writeJsonAtomic('collections.json', collections, { allowShrink: true });
    }

    // Nutzungsverhalten-Analyse auf neuen Benutzernamen migrieren
    const behavior = readJsonFile<BehaviorStore>('behavior.json', { users: {} });
    if (behavior.users[currentUsername]) {
      behavior.users[finalUsername] = behavior.users[currentUsername];
      delete behavior.users[currentUsername];
      writeJsonAtomic('behavior.json', behavior, { allowShrink: true });
    }
  } else {
    users[currentUsername] = updatedUser;
  }

  writeJsonAtomic('users.json', users, { allowShrink: true });
  const profileFolder = renameUserProfileFolder(currentUsername, finalUsername, updatedUser);
  appendWal('USER_PROFILE_UPDATED', finalUsername, {
    previousUsername: currentUsername,
    usernameChanged: finalUsername !== currentUsername,
    passwordChanged,
    displayName: updatedUser.displayName,
  });

  res.json({
    token: signSessionToken(finalUsername),
    user: serializeUser(updatedUser),
    profileFolder,
  });
});

// NAS Auth: Upload or remove user profile picture (stored as compressed data URL on NAS)
app.put('/api/nas/profile/avatar', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { avatarUrl } = req.body as { avatarUrl?: string | null };

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const existingUser = users[username];
  if (!existingUser) {
    res.status(404).json({ error: 'Benutzerkonto auf dem NAS nicht gefunden.' });
    return;
  }

  let normalizedAvatar: string | null = null;
  if (typeof avatarUrl === 'string' && avatarUrl.trim().length > 0) {
    const trimmed = avatarUrl.trim();
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
      res.status(400).json({
        error: 'Ungültiges Bildformat. Erlaubt sind komprimierte PNG-, JPEG- oder WebP-Bilder.',
      });
      return;
    }
    if (trimmed.length > 750_000) {
      res.status(400).json({
        error: 'Das Profilbild ist zu groß (maximal ca. 500 KB nach Komprimierung).',
      });
      return;
    }
    normalizedAvatar = trimmed;
  }

  const updatedUser: StoredUser = {
    ...existingUser,
    avatarUrl: normalizedAvatar,
  };
  users[username] = updatedUser;
  writeJsonAtomic('users.json', users);
  syncUserProfileDataSnapshot(username);
  appendWal('USER_AVATAR_UPDATED', username, { hasAvatar: Boolean(normalizedAvatar) });

  res.json({
    user: serializeUser(updatedUser),
  });
});

// NAS Profile Folder: Inspect or ensure the automatic per-user profile folder on the NAS
app.get('/api/nas/profile-folder', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const folder = ensureUserProfileFolder(username);
  if (!folder) {
    res.status(400).json({ error: 'Profilordner auf dem NAS konnte nicht aufgelöst werden.' });
    return;
  }
  res.json({ folder });
});

app.post('/api/nas/profile-folder/ensure', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const folder = ensureUserProfileFolder(username);
  if (!folder) {
    res.status(400).json({ error: 'Profilordner konnte auf dem NAS nicht angelegt werden.' });
    return;
  }
  res.json({ folder });
});

// User Preferences: Design-Theme & Startbildschirm-Reihenfolge
app.get('/api/nas/preferences', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
  const prefs = sanitizePreferences(store.users[username]);
  res.json(prefs);
});

app.put('/api/nas/preferences', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const body = req.body as Partial<UserPreferencesRecord>;
  const store = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
  const existing = store.users[username];
  const merged = sanitizePreferences({
    theme: body.theme ?? existing?.theme,
    customTheme: body.customTheme ?? existing?.customTheme,
    autoTheme: body.autoTheme !== undefined ? body.autoTheme : existing?.autoTheme,
    homeSectionOrder: body.homeSectionOrder ?? existing?.homeSectionOrder,
    hiddenHomeSections:
      body.hiddenHomeSections !== undefined
        ? body.hiddenHomeSections
        : existing?.hiddenHomeSections,
    showHomeCategoryTabs:
      body.showHomeCategoryTabs !== undefined
        ? body.showHomeCategoryTabs
        : existing?.showHomeCategoryTabs,
    showHomeFilterSearch:
      body.showHomeFilterSearch !== undefined
        ? body.showHomeFilterSearch
        : existing?.showHomeFilterSearch,
    audioPlayerMode: body.audioPlayerMode ?? existing?.audioPlayerMode,
    duckAssistantEnabled:
      body.duckAssistantEnabled !== undefined
        ? body.duckAssistantEnabled
        : existing?.duckAssistantEnabled,
    playerControlsTimeoutSec:
      body.playerControlsTimeoutSec !== undefined
        ? body.playerControlsTimeoutSec
        : existing?.playerControlsTimeoutSec,
    playerSeekBackwardSec:
      body.playerSeekBackwardSec !== undefined
        ? body.playerSeekBackwardSec
        : existing?.playerSeekBackwardSec,
    playerSeekForwardSec:
      body.playerSeekForwardSec !== undefined
        ? body.playerSeekForwardSec
        : existing?.playerSeekForwardSec,
    calendarNotificationMode:
      body.calendarNotificationMode !== undefined
        ? body.calendarNotificationMode
        : existing?.calendarNotificationMode,
    filmNotificationMode:
      body.filmNotificationMode !== undefined
        ? body.filmNotificationMode
        : existing?.filmNotificationMode,
  });
  store.users[username] = merged;
  writeJsonAtomic('preferences.json', store);
  syncUserProfileDataSnapshot(username);
  appendWal('USER_PREFERENCES_UPDATED', username, {
    theme: merged.theme,
    autoThemeMode: merged.autoTheme?.mode ?? 'off',
    homeSectionOrder: merged.homeSectionOrder,
    hiddenHomeSections: merged.hiddenHomeSections,
    showHomeCategoryTabs: merged.showHomeCategoryTabs,
    showHomeFilterSearch: merged.showHomeFilterSearch,
    audioPlayerMode: merged.audioPlayerMode,
    duckAssistantEnabled: merged.duckAssistantEnabled,
    playerControlsTimeoutSec: merged.playerControlsTimeoutSec,
    playerSeekBackwardSec: merged.playerSeekBackwardSec,
    playerSeekForwardSec: merged.playerSeekForwardSec,
    calendarNotificationMode: merged.calendarNotificationMode,
    filmNotificationMode: merged.filmNotificationMode,
  });
  if (body.calendarNotificationMode !== undefined) {
    syncCalendarAndAlerts(username);
  }
  if (body.filmNotificationMode !== undefined) {
    syncFilmStartAlerts(username);
  }
  res.json(merged);
});

const SERIES_EPISODE_TITLES: Record<string, string[]> = {
  'nas-dark-01': [
    'Das Signal unter den Tannen',
    'Schichtwechsel 1986',
    'Die versiegelte Tür',
    'Echo im Bunker',
    'Zwischenzeit',
    'Kalter Kern',
    'Zeitschleife',
    'Rückkehr nach Sektor 1',
    'Verlorene Koordinaten',
    'Stimmen aus dem Funkgerät',
    'Nachtschicht',
    'Der Riss im Sektor 4',
    'Spiegelung',
    'Dunkle Materie',
    'Letzte Übertragung',
    'Neustart',
  ],
  'nas-nordic-02': [
    'Sturmwarnung',
    'Treibeis',
    'Das verlassene Wrack',
    'Nebel über der Hallig',
    'Geheime Fracht',
    'Leuchtfeuer 19',
    'Tiefe Strömung',
    'Gegenwind',
    'Nordkurs',
    'Ebbe und Schuld',
    'Funkstille',
    'Letzter Hafen',
  ],
  'nas-krypto-05': [
    'Ausfall um Mitternacht',
    'DE-CIX Sektor B',
    'Schattenkonto',
    'Kaltstart',
    'Datenleck',
    'Backup-Protokoll',
    'Börsenstopp',
    'Notstrom',
  ],
  'nas-bergwacht-06': [
    'Gratwanderung',
    'Eisspalte',
    'Nebelwand',
    'Funkloch',
    'Lawinenhang',
    'Gipfelkreuz',
    'Sichtweite Null',
    'Talstation',
    'Nachtabstiege',
    'Weißes Schweigen',
  ],
  'nas-elbe-09': [
    'Kai 4',
    'Alte Akten',
    'Schattenfracht',
    'Nebelhorn',
    'Speicherstadt 1978',
    'Elbbrücken',
    'Flutlinie',
    'Letzte Ausfahrt Nordsee',
  ],
};

const SERIES_STILL_KEYS: Record<string, string> = {
  'nas-dark-01': 'stillSchattenwald',
  'nas-nordic-02': 'stillNordsee',
  'nas-krypto-05': 'stillFrankfurt',
  'nas-bergwacht-06': 'stillGrenzgrat',
  'nas-elbe-09': 'stillElbe',
};

const SERIES_EPISODE_SUMMARIES: Record<string, string[]> = {
  'nas-dark-01': [
    'Ein mysteriöses Funksignal lockt das Ermittlerteam tief in ein abgesperrtes Waldstück nahe der alten Wetterstation.',
    'Archivaufnahmen von 1986 enthüllen ein geheimes Schichtprotokoll unterhalb des Schwarzwald-Reaktors.',
    'Hinter einer verschweißten Bunkertür stoßen Hannah und Jonas auf Gegenstände aus der Zukunft.',
    'Verzerrte Echos im Stollen deuten darauf hin, dass zwei Zeitlinien gleichzeitig ablaufen.',
    'Während die Uhren im Dorf stehen bleiben, verschwindet ein weiterer Zeuge spurlos.',
    'Im kalten Kern der Anlage messen die Sensoren eine plötzliche Gravitationsanomalie.',
    'Eine Zeitschleife zwingt das Team, denselben Abend mit neuen Hinweisen erneut zu durchleben.',
    'Die Rückkehr nach Sektor 1 bringt eine unerwartete Begegnung mit dem verschollenen Forschungsleiter.',
    'Verschlüsselte Koordinaten auf einer alten Lochkarte führen zu einem zweiten Eingang im Norden.',
    'Über ein analoges Funkgerät empfängt Katja eine Warnung ihrer eigenen Stimme.',
    'Während der Nachtschicht droht das Kühlsystem der Zeitschleuse auszufallen.',
    'Ein Riss im Sektor 4 öffnet einen direkten Durchgang zwischen Gegenwart und Vergangenheit.',
    'In einem verlassenen Labor entdeckt das Team spiegelverkehrte Notizen eines unbekannten Beobachters.',
    'Dunkle Materie breitet sich unkontrolliert rund um die unterirdische Messkammer aus.',
    'Die letzte Übertragung vor dem Kontrollverlust liefert den entscheidenden Code.',
    'Mit einem riskanten Neustart versuchen die Forscher, die Zeitschleuse dauerhaft zu schließen.',
  ],
  'nas-nordic-02': [
    'Eine schwere Sturmwarnung schneidet die Hallig vom Festland ab, als am Strand ein Signalfeuer entzündet wird.',
    'Zwischen Treibeis entdeckt die Küstenwache einen verlassenen Rettungsring ohne Schiffsregistrierung.',
    'Im Rumpf eines gestrandeten Wracks findet Kommissar Brandt versiegelte Seekarten.',
    'Dichter Nebel erschwert die Suche nach dem verschwundenen Hafenmeister.',
    'Eine geheimnisvolle Frachtliste verweist auf nächtliche Umladungen außerhalb der Dreimeilenzone.',
    'Das alte Leuchtfeuer 19 sendet plötzlich Morsezeichen in Richtung offener Nordsee.',
    'Starke Unterströmungen legen ein altes Seekabel frei, das nie in offiziellen Karten verzeichnet war.',
    'Bei Gegenwind gerät das Polizeiboot während einer Verfolgungsjagd in Seenot.',
    'Spuren im Logbuch weisen auf einen heimlichen Nordkurs Richtung Skagerrak.',
    'Mit der Ebbe kommt unterhalb der Pier ein vergrabener Metallkoffer zum Vorschein.',
    'Nach dem Ausfall aller Küstenfunkstellen ist die Insel komplett auf sich allein gestellt.',
    'Im letzten Hafen vor der Grenze stellt Brandt den Drahtzieher des Schmuggels.',
  ],
  'nas-krypto-05': [
    'Um Mitternacht bricht die Stromversorgung im Frankfurter Bankenviertel ohne Vorwarnung zusammen.',
    'Im Sektor B des Internetknotens DE-CIX wird ein manipuliertes Routing-Update entdeckt.',
    'Spuren eines Schattenkontos führen tief in die interne Compliance-Abteilung.',
    'Ein riskanter Kaltstart der Notfallserver soll den europäischen Zahlungsverkehr retten.',
    'Ein anonymes Datenleck bringt die Vorstände unter enormen Zeitdruck.',
    'Im alten Backup-Protokoll taucht der Name einer längst aufgelösten Sicherheitsfirma auf.',
    'Ein drohender Börsenstopp zwingt die Krisenzentrale zu einer folgenschweren Entscheidung.',
    'Mit letzten Notstromreserven gelingt es dem Team, den Angriffspfad endgültig zu isolieren.',
  ],
  'nas-bergwacht-06': [
    'Bei einer Gratwanderung verliert eine Seilschaft im dichten Schneetreiben den Kontakt zur Talwache.',
    'In einer tiefen Eisspalte macht die Bergrettung einen rätselhaften Fund aus den 1990er-Jahren.',
    'Eine plötzliche Nebelwand verhindert die geplante Hubschrauber-Evakuierung am Nordkamm.',
    'Im Funkloch des Grenztals stößt das Team auf eine verlassene Schmugglerhütte.',
    'Nach einem kontrollierten Sprengschuss löst ein versteckter Lawinenhang neue Hinweise aus.',
    'Am Gipfelkreuz entdeckt die Ermittlerin eine zurückgelassene Kamera mit verschlüsselter Speicherkarte.',
    'Bei Sichtweite Null muss der Rettungstrupp den Abstieg über die steile Westflanke wagen.',
    'In der Talstation verdichten sich die Hinweise auf ein bewusst manipuliertes Seil.',
    'Ein nächtlicher Rettungseinsatz im Schneetreiben fordert die gesamte Einsatzbereitschaft.',
    'In der Stille des Gletschers werden endlich alle offenen Fragen des Vermisstenfalls geklärt.',
  ],
  'nas-elbe-09': [
    'Am Kai 4 entdeckt die Wasserschutzpolizei eine unregistrierte Holzkiste aus der Nachkriegszeit.',
    'Vergilbte Hafenakten verknüpfen einen aktuellen Einbruch mit einem Fall aus dem Kalten Krieg.',
    'Ein ehemaliger Schauerleute-Vorarbeiter bricht nach Jahrzehnten sein Schweigen über die Schattenfracht.',
    'Im dichten Elbnebel verfolgt das Streifenboot ein verdächtiges Barkassenschiff.',
    'In den Kellern der Speicherstadt von 1978 findet das Team ein verstecktes Mikrofilm-Archiv.',
    'Unter den Elbbrücken wird ein geheimer Übergabeort für verschwundene Zollpapiere ausgemacht.',
    'Mit steigender Flutlinie drängt die Zeit, die historischen Beweise sicherzustellen.',
    'Bei der letzten Ausfahrt Richtung Nordsee klärt sich das Schicksal des verschollenen Kapitäns.',
  ],
};

function formatEpisodeKey(season: number, episode: number): string {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function getSeriesSeasonLayout(item: NasLibraryRecord) {
  const total = item.totalEpisodes ?? 8;
  const seasons = Math.max(1, item.defaultSeason ?? (total > 12 ? 3 : total > 8 ? 2 : 1));
  const perSeason = Math.ceil(total / seasons);
  return { total, seasons, perSeason };
}

function getWatchedEpisodeSet(item: NasLibraryRecord, watch?: WatchHistoryEntry): Set<string> {
  if (!watch) return new Set<string>();
  if (Array.isArray(watch.watchedEpisodeKeys)) {
    return new Set(watch.watchedEpisodeKeys);
  }
  const { total, seasons, perSeason } = getSeriesSeasonLayout(item);
  const curSeason = watch.currentSeason ?? item.defaultSeason ?? 1;
  const curEpisode = watch.currentEpisode ?? item.defaultEpisode ?? 1;
  const set = new Set<string>();

  let idx = 0;
  for (let s = 1; s <= seasons; s++) {
    for (let e = 1; e <= perSeason && idx < total; e++) {
      const isWatched =
        s < curSeason ||
        (s === curSeason && e < curEpisode) ||
        (s === curSeason &&
          e === curEpisode &&
          watch.watchedMinutes >= item.totalDurationMinutes - 5);
      if (isWatched) {
        set.add(formatEpisodeKey(s, e));
      }
      idx++;
    }
  }
  return set;
}

function buildNasEpisodesForSeries(
  item: NasLibraryRecord,
  watch?: WatchHistoryEntry
) {
  if (item.kind !== 'series') return undefined;
  const { total, seasons, perSeason } = getSeriesSeasonLayout(item);
  const folderName = item.nasPath.replace(/\/[^/]+$/, '');
  const titles = SERIES_EPISODE_TITLES[item.id] ?? [];
  const summaries = SERIES_EPISODE_SUMMARIES[item.id] ?? [];
  const screenshotKey = SERIES_STILL_KEYS[item.id] ?? 'stillSchattenwald';
  const watchedSet = getWatchedEpisodeSet(item, watch);

  const episodes: Array<{
    season: number;
    episode: number;
    title: string;
    summary: string;
    durationMinutes: number;
    nasPath: string;
    fileSize: string;
    watched: boolean;
    screenshotKey: string;
  }> = [];

  let idx = 0;
  for (let s = 1; s <= seasons; s++) {
    for (let e = 1; e <= perSeason && idx < total; e++) {
      const sPad = String(s).padStart(2, '0');
      const ePad = String(e).padStart(2, '0');
      const customTitle =
        titles[idx % Math.max(1, titles.length)] ?? `Folge ${e} (Staffel ${s})`;
      const isCurrentDefault =
        s === (item.defaultSeason ?? 1) &&
        e === (item.defaultEpisode ?? 1) &&
        item.defaultEpisodeTitle;
      const title = isCurrentDefault ? item.defaultEpisodeTitle! : customTitle;
      const summary =
        summaries[idx % Math.max(1, summaries.length)] ??
        `Staffel ${s}, Folge ${e} von „${item.title}“ direkt vom NAS.`;
      const watched = watchedSet.has(formatEpisodeKey(s, e));
      const sizeGb = (2.6 + ((idx * 7) % 19) * 0.1).toFixed(1);

      episodes.push({
        season: s,
        episode: e,
        title,
        summary,
        durationMinutes: item.totalDurationMinutes,
        nasPath: `${folderName}/S${sPad}E${ePad}.mkv`,
        fileSize: `${sizeGb} GB`,
        watched,
        screenshotKey,
      });
      idx++;
    }
  }
  return episodes;
}

// NAS Library + Watch States
app.get('/api/nas/library', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const watchlist = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
  const userWatchlistSet = new Set(watchlist.users[username] ?? []);

  const userHistoryMap = new Map<string, WatchHistoryEntry>();
  for (const w of history.watches) {
    if (w.username === username) {
      userHistoryMap.set(w.mediaId, w);
    }
  }

  const userFskLimit = getUserFskLimit(username);
  const items = catalog
    .filter((item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit)
    .map((item) => {
      const watch = userHistoryMap.get(item.id);
      return {
        ...buildLibraryClientPayload(item, watch),
        inWatchlist: userWatchlistSet.has(item.id),
      };
    });

  res.json({ items });
});

// Admin / NAS Write-Access: Get full NAS catalog (including FSK 18 items and upload metadata)
app.get('/api/nas/admin/library', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const items = catalog.map((item) => {
    const uploadPath = resolveSafeUploadPath(item.uploadedFileName);
    const hasUploadedFile = Boolean(uploadPath && fs.existsSync(uploadPath));
    const coverPath = resolveSafeUploadPath(item.customCoverFileName);
    const customCoverUrl =
      coverPath && fs.existsSync(coverPath) && item.customCoverFileName
        ? `/api/nas/uploads/${encodeURIComponent(item.customCoverFileName)}`
        : hasUploadedFile && item.kind === 'image' && item.uploadedFileName
          ? `/api/nas/uploads/${encodeURIComponent(item.uploadedFileName)}`
          : undefined;
    const hasScannedSource = Boolean(
      !hasUploadedFile &&
        item.nasPath &&
        (item.id.startsWith('nas-scan-') ||
          item.nasPath.startsWith('smb://') ||
          fs.existsSync(item.nasPath))
    );
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      genre: item.genre,
      year: item.year,
      fsk: normalizeFskLimit(item.fsk, 0),
      synopsis: item.synopsis,
      codec: item.codec,
      nasPath: item.nasPath,
      totalDurationMinutes: item.totalDurationMinutes,
      totalEpisodes: item.totalEpisodes,
      fileFormat: item.fileFormat,
      fileSize: item.fileSize,
      addedAt: item.addedAt ?? `${item.year}-06-01T12:00:00Z`,
      hasUploadedFile: hasUploadedFile || hasScannedSource,
      uploadedFileName: item.uploadedFileName,
      uploadedMimeType: item.uploadedMimeType || (hasScannedSource && item.nasPath ? inferMimeType(item.nasPath) : undefined),
      uploadedByteSize: item.uploadedByteSize,
      mediaUrl: hasUploadedFile
        ? `/api/nas/media/${encodeURIComponent(item.id)}/stream`
        : hasScannedSource
          ? `/api/nas/storage/stream?mediaId=${encodeURIComponent(item.id)}`
          : undefined,
      customCoverUrl,
      coverKey: item.coverKey,
    };
  });

  res.json({ items });
});

// Admin / NAS Write-Access: Add new NAS media items (metadata / manual NAS paths) and notify all users
app.post('/api/nas/library/items', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const body = (req.body ?? {}) as {
    items?: Array<{
      title?: string;
      kind?: MediaKind;
      genre?: string;
      year?: number;
      fsk?: FskLevel;
      synopsis?: string;
      nasPath?: string;
      totalDurationMinutes?: number;
      totalEpisodes?: number;
      fileFormat?: string;
      fileSize?: string;
    }>;
  };

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'Bitte mindestens einen neuen NAS-Inhalt angeben.' });
    return;
  }

  const validKinds = new Set<MediaKind>(['movie', 'series', 'image', 'music', 'video', 'other']);
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const nowIso = new Date().toISOString();
  const createdRecords: NasLibraryRecord[] = [];

  for (let idx = 0; idx < rawItems.length; idx++) {
    const entry = rawItems[idx];
    const title = (entry.title ?? '').trim();
    if (!title) continue;

    const kind: MediaKind = entry.kind && validKinds.has(entry.kind) ? entry.kind : 'movie';
    const genre = (entry.genre ?? '').trim() || NAS_CATEGORY_LABELS[kind];
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const id = `nas-added-${Date.now()}-${idx}-${slug || 'item'}`;
    const safeFileName = title.replace(/[^a-zA-Z0-9äöüÄÖÜß._-]+/g, '_');
    const folderByKind: Record<MediaKind, string> = {
      movie: 'Filme',
      series: 'Serien',
      image: 'Bilder',
      music: 'Musik',
      video: 'Videos',
      other: 'Dokumente',
    };
    const extByKind: Record<MediaKind, string> = {
      movie: 'mkv',
      series: 'mkv',
      image: 'jpg',
      music: 'flac',
      video: 'mp4',
      other: 'pdf',
    };

    const record: NasLibraryRecord = {
      id,
      tmdbId: Math.floor(100000 + Math.random() * 800000),
      title,
      kind,
      genre,
      year:
        typeof entry.year === 'number' && entry.year >= 1950 && entry.year <= 2035
          ? entry.year
          : 2026,
      coverKey: inferCoverKeyForKind(kind, genre),
      synopsis:
        (entry.synopsis ?? '').trim() ||
        `Neu auf dem NAS hinzugefügt in der Kategorie ${NAS_CATEGORY_LABELS[kind]}.`,
      codec:
        kind === 'image'
          ? 'JPEG / RAW'
          : kind === 'music'
            ? 'FLAC 24-Bit / 96kHz'
            : kind === 'other'
              ? 'PDF / Archiv'
              : 'HEVC / MKV · 4K HDR10',
      audioTracks: kind === 'image' || kind === 'other' ? [] : ['Deutsch', 'Original'],
      subtitles: kind === 'movie' || kind === 'series' ? ['Deutsch', 'Englisch'] : [],
      totalDurationMinutes:
        typeof entry.totalDurationMinutes === 'number' && entry.totalDurationMinutes > 0
          ? Math.round(entry.totalDurationMinutes)
          : kind === 'movie'
            ? 108
            : kind === 'series'
              ? 46
              : kind === 'music'
                ? 4
                : 12,
      nasPath:
        (entry.nasPath ?? '').trim() ||
        `/mnt/nas/${folderByKind[kind]}/${safeFileName}.${extByKind[kind]}`,
      totalEpisodes:
        kind === 'series'
          ? typeof entry.totalEpisodes === 'number' && entry.totalEpisodes > 0
            ? Math.round(entry.totalEpisodes)
            : 8
          : undefined,
      defaultSeason: kind === 'series' ? 1 : undefined,
      defaultEpisode: kind === 'series' ? 1 : undefined,
      defaultEpisodeTitle: kind === 'series' ? 'Folge 1' : undefined,
      seriesStatus: kind === 'series' ? 'returning' : undefined,
      seriesStatusDetail: kind === 'series' ? 'Neu auf dem NAS verfügbar' : undefined,
      addedAt: nowIso,
      fileFormat: (entry.fileFormat ?? '').trim() || extByKind[kind].toUpperCase(),
      fileSize: (entry.fileSize ?? '').trim() || (kind === 'image' ? '18 MB' : '4.2 GB'),
      fsk: normalizeFskLimit(entry.fsk, 0),
    };

    catalog.unshift(record);
    createdRecords.push(record);
  }

  if (createdRecords.length === 0) {
    res.status(400).json({ error: 'Bitte mindestens einen gültigen Titel angeben.' });
    return;
  }

  writeJsonAtomic('catalog.json', catalog);
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.knownCatalogIds = catalog.map((item) => item.id);
  settings.lastScanTimestamp = nowIso;
  writeJsonAtomic('settings.json', settings);

  const notifiedUsers = notifyAllUsersNewNasItems(createdRecords);
  appendWal('NAS_ITEMS_ADDED', adminUser.username, {
    count: createdRecords.length,
    titles: createdRecords.map((c) => c.title),
  });

  const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
  });
  const userAlerts = notifStore.alerts.filter((a) => a.username === adminUser.username);

  res.status(201).json({
    addedItems: createdRecords,
    notifiedUsers,
    catalogCount: catalog.length,
    alerts: userAlerts,
  });
});

// Admin / NAS Write-Access: Stream-upload a real file directly onto the NAS (/api/nas/upload & /api/nas/library/upload)
app.post(['/api/nas/upload', '/api/nas/library/upload'], requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const rawFileName =
    decodeHeaderParam(req.headers['x-nas-filename']) ||
    (typeof req.query.filename === 'string' ? req.query.filename : '') ||
    'upload.bin';
  const safeOriginalName = sanitizeUploadedFileName(rawFileName);
  const mimeType = inferMimeType(
    safeOriginalName,
    decodeHeaderParam(req.headers['x-nas-mime']) || req.headers['content-type']
  );

  const validKinds = new Set<MediaKind>(['movie', 'series', 'image', 'music', 'video', 'other']);
  const rawKind = decodeHeaderParam(req.headers['x-nas-kind']) as MediaKind;
  const kind: MediaKind = validKinds.has(rawKind)
    ? rawKind
    : inferMediaKindFromFile(safeOriginalName, mimeType);

  const baseNameNoExt = path.basename(safeOriginalName, path.extname(safeOriginalName)).replace(/[_-]+/g, ' ').trim();
  const title = decodeHeaderParam(req.headers['x-nas-title']).trim() || baseNameNoExt || safeOriginalName;
  const genre = decodeHeaderParam(req.headers['x-nas-genre']).trim() || NAS_CATEGORY_LABELS[kind];
  const rawYear = Number(decodeHeaderParam(req.headers['x-nas-year']));
  const year =
    Number.isFinite(rawYear) && rawYear >= 1950 && rawYear <= 2035
      ? Math.round(rawYear)
      : new Date().getFullYear();
  const fsk = normalizeFskLimit(decodeHeaderParam(req.headers['x-nas-fsk']), 0);
  const synopsis =
    decodeHeaderParam(req.headers['x-nas-synopsis']).trim() ||
    `Direkt auf das EntenCenter NAS hochgeladen (${NAS_CATEGORY_LABELS[kind]} · ${safeOriginalName}).`;
  const rawDuration = Number(decodeHeaderParam(req.headers['x-nas-duration']));
  const rawEpisodes = Number(decodeHeaderParam(req.headers['x-nas-episodes']));
  const deferNotify = decodeHeaderParam(req.headers['x-nas-defer-notify']) === '1';

  const pathSettings = readCurrentNasPathSettings();
  const folderByKind: Record<MediaKind, string> = pathSettings.mediaFolders;
  const customFolder = decodeHeaderParam(req.headers['x-nas-folder']).trim().replace(/\/+$/, '');
  const targetFolder = customFolder || folderByKind[kind];

  const effectiveUploadsDir = resolveEffectiveUploadsDir(pathSettings);
  fs.mkdirSync(effectiveUploadsDir, { recursive: true });
  const uniquePrefix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const storedFileName = `${uniquePrefix}-${safeOriginalName}`;
  const targetDiskPath = path.join(effectiveUploadsDir, storedFileName);

  let receivedBytes = 0;
  let aborted = false;
  let finished = false;
  const writeStream = fs.createWriteStream(targetDiskPath);

  const cleanupFile = () => {
    try {
      if (fs.existsSync(targetDiskPath)) fs.unlinkSync(targetDiskPath);
    } catch {
      // Aufräumfehler ignorieren
    }
  };

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_NAS_UPLOAD_BYTES) {
      aborted = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      cleanupFile();
      if (!res.headersSent) {
        res.status(413).json({
          error: `Die Datei „${safeOriginalName}“ überschreitet das Upload-Limit von ${formatBytesHuman(MAX_NAS_UPLOAD_BYTES)}.`,
        });
      }
      req.resume();
    }
  });

  req.on('aborted', () => {
    aborted = true;
    writeStream.destroy();
    cleanupFile();
  });

  writeStream.on('error', () => {
    aborted = true;
    cleanupFile();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Datei konnte nicht auf das NAS geschrieben werden.' });
    }
  });

  writeStream.on('finish', () => {
    if (aborted || finished) return;
    finished = true;

    if (receivedBytes <= 0) {
      cleanupFile();
      if (!res.headersSent) {
        res.status(400).json({ error: 'Die hochgeladene Datei war leer (0 Bytes).' });
      }
      return;
    }

    const nowIso = new Date().toISOString();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const id = `nas-upload-${Date.now()}-${crypto.randomBytes(2).toString('hex')}-${slug || 'file'}`;
    const extLabel = path.extname(safeOriginalName).replace('.', '').toUpperCase() || 'BIN';

    const record: NasLibraryRecord = {
      id,
      tmdbId: Math.floor(100000 + Math.random() * 800000),
      title,
      kind,
      genre,
      year,
      coverKey: inferCoverKeyForKind(kind, genre),
      synopsis,
      codec: inferCodecLabel(kind, safeOriginalName, mimeType),
      audioTracks: kind === 'image' || kind === 'other' ? [] : ['Standard'],
      subtitles: [],
      totalDurationMinutes:
        Number.isFinite(rawDuration) && rawDuration > 0
          ? Math.round(rawDuration)
          : kind === 'movie'
            ? 90
            : kind === 'series'
              ? 45
              : kind === 'music'
                ? 4
                : kind === 'video'
                  ? 5
                  : 1,
      nasPath: `${targetFolder}/${safeOriginalName}`,
      totalEpisodes:
        kind === 'series'
          ? Number.isFinite(rawEpisodes) && rawEpisodes > 0
            ? Math.round(rawEpisodes)
            : 1
          : undefined,
      defaultSeason: kind === 'series' ? 1 : undefined,
      defaultEpisode: kind === 'series' ? 1 : undefined,
      defaultEpisodeTitle: kind === 'series' ? title : undefined,
      seriesStatus: kind === 'series' ? 'returning' : undefined,
      seriesStatusDetail: kind === 'series' ? 'Hochgeladen auf dem NAS verfügbar' : undefined,
      addedAt: nowIso,
      fileFormat: extLabel,
      fileSize: formatBytesHuman(receivedBytes),
      fsk,
      uploadedFileName: storedFileName,
      uploadedMimeType: mimeType,
      uploadedByteSize: receivedBytes,
    };

    const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
    catalog.unshift(record);
    writeJsonAtomic('catalog.json', catalog);

    const settings = readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
    settings.knownCatalogIds = catalog.map((item) => item.id);
    settings.lastScanTimestamp = nowIso;
    writeJsonAtomic('settings.json', settings);

    const notifiedUsers = deferNotify ? 0 : notifyAllUsersNewNasItems([record]);
    appendWal('NAS_FILE_UPLOADED', adminUser.username, {
      id: record.id,
      title: record.title,
      kind: record.kind,
      fileName: safeOriginalName,
      bytes: receivedBytes,
      nasPath: record.nasPath,
    });
    broadcastNasStatus('nas:status');

    const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
      alerts: [],
    });
    const userAlerts = notifStore.alerts.filter((a) => a.username === adminUser.username);

    res.status(201).json({
      item: buildLibraryClientPayload(record),
      notifiedUsers,
      catalogCount: catalog.length,
      alerts: userAlerts,
    });
  });

  req.pipe(writeStream);
});

// Admin / NAS Write-Access: Upload custom cover image for an existing NAS catalog item
app.post('/api/nas/library/items/:id/cover', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const targetId = req.params.id;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const idx = catalog.findIndex((item) => item.id === targetId);
  if (idx < 0) {
    res.status(404).json({ error: 'NAS-Eintrag wurde nicht gefunden.' });
    return;
  }

  const rawFileName = decodeHeaderParam(req.headers['x-nas-filename']) || 'cover.jpg';
  const safeName = sanitizeUploadedFileName(rawFileName);
  const mimeType = inferMimeType(
    safeName,
    decodeHeaderParam(req.headers['x-nas-mime']) || req.headers['content-type']
  );
  if (!mimeType.startsWith('image/')) {
    res.status(400).json({ error: 'Cover muss eine Bilddatei (JPG, PNG, WEBP, GIF) sein.' });
    return;
  }

  const effectiveUploadsDir = resolveEffectiveUploadsDir();
  fs.mkdirSync(effectiveUploadsDir, { recursive: true });
  const storedCoverName = `cover-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName}`;
  const targetCoverPath = path.join(effectiveUploadsDir, storedCoverName);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let aborted = false;

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    totalBytes += chunk.length;
    if (totalBytes > 15 * 1024 * 1024) {
      aborted = true;
      if (!res.headersSent) {
        res.status(413).json({ error: 'Cover-Bild darf maximal 15 MB groß sein.' });
      }
      req.resume();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    if (totalBytes <= 0) {
      res.status(400).json({ error: 'Leeres Cover-Bild empfangen.' });
      return;
    }
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(targetCoverPath, buf);

    const oldCover = catalog[idx].customCoverFileName;
    if (oldCover) {
      const oldPath = resolveSafeUploadPath(oldCover);
      if (oldPath && fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // Ignorieren
        }
      }
    }

    catalog[idx].customCoverFileName = storedCoverName;
    writeJsonAtomic('catalog.json', catalog);
    appendWal('NAS_COVER_UPLOADED', adminUser.username, {
      id: targetId,
      coverFile: storedCoverName,
    });

    res.json({
      item: buildLibraryClientPayload(catalog[idx]),
    });
  });
});

// Admin / NAS Write-Access: Send one grouped notification for a batch of newly uploaded items
app.post('/api/nas/library/notify-batch', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const { itemIds } = (req.body ?? {}) as { itemIds?: string[] };
  const ids = new Set(Array.isArray(itemIds) ? itemIds : []);
  if (ids.size === 0) {
    res.status(400).json({ error: 'Keine Item-IDs für die Benachrichtigung angegeben.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const matched = catalog.filter((item) => ids.has(item.id));
  const notifiedUsers = notifyAllUsersNewNasItems(matched);

  const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
  });
  const userAlerts = notifStore.alerts.filter((a) => a.username === adminUser.username);

  res.json({
    notifiedUsers,
    itemCount: matched.length,
    alerts: userAlerts,
  });
});

// Admin / NAS Write-Access: Update an existing NAS catalog entry
app.put('/api/nas/admin/library/:id', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const targetId = req.params.id;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const idx = catalog.findIndex((item) => item.id === targetId);
  if (idx < 0) {
    res.status(404).json({ error: 'NAS-Eintrag nicht gefunden.' });
    return;
  }

  const body = (req.body ?? {}) as {
    title?: string;
    kind?: MediaKind;
    genre?: string;
    year?: number;
    fsk?: FskLevel;
    synopsis?: string;
    nasPath?: string;
    totalDurationMinutes?: number;
    totalEpisodes?: number;
  };

  const validKinds = new Set<MediaKind>(['movie', 'series', 'image', 'music', 'video', 'other']);
  const current = catalog[idx];

  const nextTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : current.title;
  const nextKind = body.kind && validKinds.has(body.kind) ? body.kind : current.kind;
  const nextGenre = typeof body.genre === 'string' && body.genre.trim() ? body.genre.trim() : current.genre;

  catalog[idx] = {
    ...current,
    title: nextTitle,
    kind: nextKind,
    genre: nextGenre,
    year:
      typeof body.year === 'number' && body.year >= 1950 && body.year <= 2035
        ? Math.round(body.year)
        : current.year,
    fsk: body.fsk !== undefined ? normalizeFskLimit(body.fsk, current.fsk ?? 0) : current.fsk,
    synopsis: typeof body.synopsis === 'string' ? body.synopsis.trim() : current.synopsis,
    nasPath: typeof body.nasPath === 'string' && body.nasPath.trim() ? body.nasPath.trim() : current.nasPath,
    totalDurationMinutes:
      typeof body.totalDurationMinutes === 'number' && body.totalDurationMinutes > 0
        ? Math.round(body.totalDurationMinutes)
        : current.totalDurationMinutes,
    totalEpisodes:
      nextKind === 'series'
        ? typeof body.totalEpisodes === 'number' && body.totalEpisodes > 0
          ? Math.round(body.totalEpisodes)
          : current.totalEpisodes ?? 8
        : undefined,
  };

  writeJsonAtomic('catalog.json', catalog);
  appendWal('NAS_ITEM_UPDATED', adminUser.username, {
    id: targetId,
    title: catalog[idx].title,
  });

  res.json({ item: buildLibraryClientPayload(catalog[idx]) });
});

// Admin / NAS Write-Access: Delete a NAS catalog entry (and its uploaded file if unreferenced)
app.delete('/api/nas/admin/library/:id', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const adminUser = requireNasWriteAccess(req, res);
  if (!adminUser) return;

  const targetId = req.params.id;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const target = catalog.find((item) => item.id === targetId);
  if (!target) {
    res.status(404).json({ error: 'NAS-Eintrag nicht gefunden.' });
    return;
  }

  const nextCatalog = catalog.filter((item) => item.id !== targetId);
  writeJsonAtomic('catalog.json', nextCatalog, { allowEmptyOverwrite: true, allowShrink: true });

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.knownCatalogIds = nextCatalog.map((item) => item.id);
  writeJsonAtomic('settings.json', settings, { allowShrink: true });

  // Hochgeladene Dateien auf dem NAS mit aufräumen, falls nicht anderweitig referenziert
  if (
    target.uploadedFileName &&
    !nextCatalog.some((other) => other.uploadedFileName === target.uploadedFileName)
  ) {
    const filePath = resolveSafeUploadPath(target.uploadedFileName);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignorieren
      }
    }
  }
  if (
    target.customCoverFileName &&
    !nextCatalog.some((other) => other.customCoverFileName === target.customCoverFileName)
  ) {
    const coverPath = resolveSafeUploadPath(target.customCoverFileName);
    if (coverPath && fs.existsSync(coverPath)) {
      try {
        fs.unlinkSync(coverPath);
      } catch {
        // Ignorieren
      }
    }
  }

  appendWal('NAS_ITEM_DELETED', adminUser.username, {
    id: targetId,
    title: target.title,
    uploadedFileName: target.uploadedFileName ?? null,
  });
  broadcastNasStatus('nas:status');

  res.json({
    deletedId: targetId,
    catalogCount: nextCatalog.length,
  });
});

function resolveTokenFromRequest(req: Request): string | null {
  const fromHeader = verifyToken(req.headers.authorization);
  if (fromHeader) return fromHeader;
  const qToken = typeof req.query.token === 'string' ? req.query.token : null;
  return verifyRawToken(qToken);
}

// Stream or download an uploaded NAS media file (supports HTTP Range requests for video/audio)
app.get('/api/nas/media/:id/stream', (req: Request, res: Response) => {
  const username = resolveTokenFromRequest(req);
  if (!username) {
    res.status(401).json({ error: 'Ungültige oder fehlende NAS-Session.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const item = catalog.find((entry) => entry.id === req.params.id);
  if (!item || !item.uploadedFileName) {
    res.status(404).json({ error: 'Keine hochgeladene Mediendatei für diesen Eintrag vorhanden.' });
    return;
  }

  const userFskLimit = getUserFskLimit(username);
  if (normalizeFskLimit(item.fsk, 0) > userFskLimit) {
    res.status(403).json({ error: 'Inhalt durch Altersfreigabe (FSK) gesperrt.' });
    return;
  }

  const filePath = resolveSafeUploadPath(item.uploadedFileName);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Mediendatei wurde auf dem NAS-Dateisystem nicht gefunden.' });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = inferMimeType(item.uploadedFileName, item.uploadedMimeType);
  const isDownload = req.query.download === '1';

  if (isDownload) {
    const cleanDownloadName = path.basename(item.nasPath || item.uploadedFileName);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cleanDownloadName)}"`);
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader && !isDownload) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < fileSize) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', String(end - start + 1));
        res.setHeader('Content-Type', mimeType);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(fileSize));
  res.setHeader('Content-Type', mimeType);
  fs.createReadStream(filePath).pipe(res);
});

// Serve uploaded images & custom cover assets with token authentication
app.get('/api/nas/uploads/:fileName', (req: Request, res: Response) => {
  const username = resolveTokenFromRequest(req);
  if (!username) {
    res.status(401).json({ error: 'Ungültige oder fehlende NAS-Session.' });
    return;
  }

  const filePath = resolveSafeUploadPath(req.params.fileName);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Datei nicht gefunden.' });
    return;
  }

  const mimeType = inferMimeType(filePath);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
});

// Toggle a movie or series in the user's NAS Watch List
app.post('/api/nas/watchlist', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { mediaId, action } = req.body as {
    mediaId?: string;
    action?: 'toggle' | 'add' | 'remove';
  };

  if (!mediaId) {
    res.status(400).json({ error: 'mediaId ist erforderlich.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const media = catalog.find((c) => c.id === mediaId);
  if (!media) {
    res.status(404).json({ error: 'Medium auf dem NAS nicht gefunden.' });
    return;
  }
  if (normalizeFskLimit(media.fsk, 0) > getUserFskLimit(username)) {
    res.status(403).json({
      error: `Altersfreigabe: Dieser Titel (FSK ${normalizeFskLimit(media.fsk, 0)}) ist für dein Profil nicht freigegeben.`,
    });
    return;
  }

  const watchlist = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
  const currentList = new Set(watchlist.users[username] ?? []);

  let inWatchlist: boolean;
  if (action === 'add') {
    currentList.add(mediaId);
    inWatchlist = true;
  } else if (action === 'remove') {
    currentList.delete(mediaId);
    inWatchlist = false;
  } else if (currentList.has(mediaId)) {
    currentList.delete(mediaId);
    inWatchlist = false;
  } else {
    currentList.add(mediaId);
    inWatchlist = true;
  }

  watchlist.users[username] = Array.from(currentList);
  writeJsonAtomic('watchlist.json', watchlist);
  syncUserProfileDataSnapshot(username);
  if (inWatchlist) {
    recordUserAction(username, {
      type: 'watchlist_add',
      mediaId: media.id,
      mediaKind: media.kind,
      title: media.title,
      genre: media.genre,
    });
  }
  appendWal('WATCHLIST_UPDATED', username, {
    mediaId,
    title: media.title,
    inWatchlist,
  });

  res.json({
    mediaId,
    inWatchlist,
    watchlistIds: watchlist.users[username],
  });
});

// Batch-Add multiple NAS items to the user's Watchlist
app.post('/api/nas/watchlist/batch', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const mediaIds = Array.isArray(req.body?.mediaIds) ? (req.body.mediaIds as string[]) : [];
  if (mediaIds.length === 0) {
    res.status(400).json({ error: 'Bitte mindestens eine mediaId übergeben.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const userFskLimit = getUserFskLimit(username);

  const watchlist = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
  const currentList = new Set(watchlist.users[username] ?? []);

  let addedCount = 0;
  for (const rawId of mediaIds) {
    if (typeof rawId !== 'string') continue;
    const media = catalogById.get(rawId);
    if (!media) continue;
    if (normalizeFskLimit(media.fsk, 0) > userFskLimit) continue;
    if (!currentList.has(rawId)) {
      currentList.add(rawId);
      addedCount += 1;
    }
  }

  watchlist.users[username] = Array.from(currentList);
  writeJsonAtomic('watchlist.json', watchlist);
  syncUserProfileDataSnapshot(username);
  appendWal('WATCHLIST_BATCH_ADDED', username, { addedCount, totalRequested: mediaIds.length });

  res.json({
    addedCount,
    watchlistIds: watchlist.users[username],
  });
});

// Saved "Frag die Ente" Watchlisten & Playlisten
function filterCollectionsForUser(
  username: string,
  list: NasSavedCollectionRecord[]
): NasSavedCollectionRecord[] {
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const allowedIds = new Set(
    catalog
      .filter((item) => normalizeFskLimit(item.fsk, 0) <= getUserFskLimit(username))
      .map((item) => item.id)
  );
  return list.map((col) => ({
    ...col,
    mediaIds: col.mediaIds.filter((id) => allowedIds.has(id)),
  }));
}

app.get('/api/nas/collections', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readJsonFile<CollectionsStore>('collections.json', { users: {} });
  const collections = filterCollectionsForUser(username, store.users[username] ?? []);
  res.json({ collections });
});

app.post('/api/nas/collections', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const {
    collectionType,
    title,
    criteriaSummary,
    createdByPrompt,
    mediaIds,
  } = req.body as {
    collectionType?: 'watchlist' | 'playlist';
    title?: string;
    criteriaSummary?: string;
    createdByPrompt?: string;
    mediaIds?: string[];
  };

  if (collectionType !== 'watchlist' && collectionType !== 'playlist') {
    res.status(400).json({ error: 'Ungültiger Sammlungstyp (watchlist oder playlist).' });
    return;
  }
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (!cleanTitle) {
    res.status(400).json({ error: 'Bitte einen Namen für die Watchlist oder Playlist angeben.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const allowedIds = new Set(
    catalog
      .filter((item) => normalizeFskLimit(item.fsk, 0) <= getUserFskLimit(username))
      .map((item) => item.id)
  );
  const cleanMediaIds = Array.from(
    new Set(
      (Array.isArray(mediaIds) ? mediaIds : []).filter(
        (id): id is string => typeof id === 'string' && allowedIds.has(id)
      )
    )
  );
  if (cleanMediaIds.length === 0) {
    res.status(400).json({ error: 'Keine zulässigen NAS-Medien für diese Sammlung gefunden.' });
    return;
  }

  const store = readJsonFile<CollectionsStore>('collections.json', { users: {} });
  const userCollections = store.users[username] ?? [];

  const newCollection: NasSavedCollectionRecord = {
    id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    collectionType,
    title: cleanTitle.slice(0, 120),
    criteriaSummary:
      typeof criteriaSummary === 'string' && criteriaSummary.trim()
        ? criteriaSummary.trim().slice(0, 220)
        : 'Von „Frag die Ente“ zusammengestellt',
    createdByPrompt:
      typeof createdByPrompt === 'string' ? createdByPrompt.trim().slice(0, 240) : '',
    mediaIds: cleanMediaIds,
    createdAt: new Date().toISOString(),
  };

  store.users[username] = [newCollection, ...userCollections].slice(0, 50);
  writeJsonAtomic('collections.json', store);
  syncUserProfileDataSnapshot(username);
  recordUserAction(username, {
    type: 'collection_save',
    title: newCollection.title,
    genre: newCollection.criteriaSummary,
  });
  appendWal('DUCK_COLLECTION_CREATED', username, {
    id: newCollection.id,
    collectionType,
    title: newCollection.title,
    count: cleanMediaIds.length,
  });

  res.json({
    collection: newCollection,
    collections: filterCollectionsForUser(username, store.users[username]),
  });
});

app.delete('/api/nas/collections/:id', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const collectionId = req.params.id;
  const store = readJsonFile<CollectionsStore>('collections.json', { users: {} });
  const existing = store.users[username] ?? [];
  const next = existing.filter((c) => c.id !== collectionId);
  if (next.length === existing.length) {
    res.status(404).json({ error: 'Sammlung nicht gefunden.' });
    return;
  }
  store.users[username] = next;
  writeJsonAtomic('collections.json', store, { allowEmptyOverwrite: true, allowShrink: true });
  syncUserProfileDataSnapshot(username);
  appendWal('DUCK_COLLECTION_DELETED', username, { id: collectionId });
  res.json({
    collections: filterCollectionsForUser(username, next),
  });
});

// Update watch state directly on NAS
app.post('/api/nas/watch-state', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { mediaId, watchedMinutes, incrementEpisode, season, episode, episodeTitle } =
    req.body as {
      mediaId: string;
      watchedMinutes: number;
      incrementEpisode?: boolean;
      season?: number;
      episode?: number;
      episodeTitle?: string;
    };

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const media = catalog.find((c) => c.id === mediaId);
  if (!media) {
    res.status(404).json({ error: 'Medium auf dem NAS nicht gefunden.' });
    return;
  }
  if (normalizeFskLimit(media.fsk, 0) > getUserFskLimit(username)) {
    res.status(403).json({
      error: `Altersfreigabe: Dieser Titel (FSK ${normalizeFskLimit(media.fsk, 0)}) ist für dein Profil gesperrt.`,
    });
    return;
  }

  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  let entry = history.watches.find((w) => w.username === username && w.mediaId === mediaId);

  if (!entry) {
    const initialSeason = season ?? media.defaultSeason ?? 1;
    const initialEpisode = episode ?? media.defaultEpisode ?? 1;
    const watchedSet = new Set<string>();
    if (
      media.kind === 'series' &&
      (incrementEpisode || watchedMinutes >= media.totalDurationMinutes - 5)
    ) {
      watchedSet.add(formatEpisodeKey(initialSeason, initialEpisode));
    }
    entry = {
      username,
      mediaId: media.id,
      tmdbId: media.tmdbId,
      title: media.title,
      mediaType: media.kind,
      genre: media.genre,
      watchedMinutes: Math.max(0, watchedMinutes),
      episodesWatched: media.kind === 'series' ? watchedSet.size : 1,
      currentSeason: initialSeason,
      currentEpisode: incrementEpisode && media.kind === 'series' ? initialEpisode + 1 : initialEpisode,
      currentEpisodeTitle: episodeTitle ?? media.defaultEpisodeTitle ?? 'Folge 1',
      watchedEpisodeKeys: media.kind === 'series' ? Array.from(watchedSet) : undefined,
      lastWatchedAt: new Date().toISOString(),
      watchedWithoutDate: false,
    };
    history.watches.push(entry);
  } else {
    const watchedSet = media.kind === 'series' ? getWatchedEpisodeSet(media, entry) : new Set<string>();
    entry.watchedMinutes = Math.min(media.totalDurationMinutes, Math.max(0, watchedMinutes));
    if (season !== undefined && media.kind === 'series') {
      entry.currentSeason = season;
    }
    if (episode !== undefined && media.kind === 'series') {
      entry.currentEpisode = episode;
    }
    if (episodeTitle !== undefined && media.kind === 'series') {
      entry.currentEpisodeTitle = episodeTitle;
    }
    if (media.kind === 'series') {
      const curS = entry.currentSeason ?? 1;
      const curE = entry.currentEpisode ?? 1;
      if (incrementEpisode || entry.watchedMinutes >= media.totalDurationMinutes - 5) {
        watchedSet.add(formatEpisodeKey(curS, curE));
      }
      if (incrementEpisode) {
        entry.currentEpisode = curE + 1;
      }
      entry.watchedEpisodeKeys = Array.from(watchedSet);
      entry.episodesWatched = watchedSet.size;
    }
    entry.lastWatchedAt = new Date().toISOString();
    entry.watchedWithoutDate = false;
  }

  writeJsonAtomic('history.json', history);
  syncUserProfileDataSnapshot(username);
  recordUserAction(username, {
    type: 'progress',
    mediaId: media.id,
    mediaKind: media.kind,
    title: media.title,
    genre: media.genre,
  });
  appendWal('WATCH_STATE_SYNC', username, {
    mediaId,
    watchedMinutes: entry.watchedMinutes,
    episodesWatched: entry.episodesWatched,
  });

  // Sync calendar & auto-favorites after watch update
  const calendarSync = syncCalendarAndAlerts(username);
  res.json({ entry, ...calendarSync });
});

// Mark a movie, whole series, or individual episode as watched / unwatched on NAS
app.post('/api/nas/watch-state/mark', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { mediaId, scope, watched, season, episode, watchedAt, dateMode } = req.body as {
    mediaId?: string;
    scope?: 'item' | 'episode';
    watched?: boolean;
    season?: number;
    episode?: number;
    watchedAt?: string | null;
    dateMode?: 'now' | 'release' | 'custom' | 'without_date';
  };

  if (!mediaId || (scope !== 'item' && scope !== 'episode') || typeof watched !== 'boolean') {
    res.status(400).json({ error: 'Ungültige Anfrage zum Markieren des Wiedergabestatus.' });
    return;
  }

  const isWithoutDate = dateMode === 'without_date' || watchedAt === null;
  let resolvedWatchedAt: string | null = null;
  if (watched && !isWithoutDate) {
    if (typeof watchedAt === 'string' && watchedAt.trim()) {
      const parsed = Date.parse(watchedAt);
      resolvedWatchedAt = Number.isNaN(parsed)
        ? new Date().toISOString()
        : new Date(parsed).toISOString();
    } else {
      resolvedWatchedAt = new Date().toISOString();
    }
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const media = catalog.find((c) => c.id === mediaId);
  if (!media) {
    res.status(404).json({ error: 'Medium auf dem NAS nicht gefunden.' });
    return;
  }
  if (normalizeFskLimit(media.fsk, 0) > getUserFskLimit(username)) {
    res.status(403).json({
      error: `Altersfreigabe: Dieser Titel (FSK ${normalizeFskLimit(media.fsk, 0)}) ist für dein Profil gesperrt.`,
    });
    return;
  }

  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const existingIdx = history.watches.findIndex(
    (w) => w.username === username && w.mediaId === mediaId
  );
  const existingEntry = existingIdx >= 0 ? history.watches[existingIdx] : undefined;

  if (scope === 'item') {
    if (!watched) {
      history.watches = history.watches.filter(
        (w) => !(w.username === username && w.mediaId === mediaId)
      );
    } else if (media.kind !== 'series') {
      const nextEntry: WatchHistoryEntry = {
        username,
        mediaId: media.id,
        tmdbId: media.tmdbId,
        title: media.title,
        mediaType: media.kind,
        genre: media.genre,
        watchedMinutes: Math.max(1, media.totalDurationMinutes || 90),
        episodesWatched: 1,
        lastWatchedAt: resolvedWatchedAt,
        watchedWithoutDate: isWithoutDate,
      };
      if (existingIdx >= 0) {
        history.watches[existingIdx] = nextEntry;
      } else {
        history.watches.push(nextEntry);
      }
    } else {
      const allEpisodes = buildNasEpisodesForSeries(media) ?? [];
      const allKeys = allEpisodes.map((ep) => formatEpisodeKey(ep.season, ep.episode));
      const lastEp = allEpisodes[allEpisodes.length - 1];
      const totalSeriesMinutes =
        allEpisodes.reduce((sum, ep) => sum + Math.max(1, ep.durationMinutes || 42), 0) ||
        Math.max(42, media.totalDurationMinutes || 42);
      const nextEntry: WatchHistoryEntry = {
        username,
        mediaId: media.id,
        tmdbId: media.tmdbId,
        title: media.title,
        mediaType: 'series',
        genre: media.genre,
        watchedMinutes: totalSeriesMinutes,
        episodesWatched: allKeys.length,
        currentSeason: lastEp?.season ?? 1,
        currentEpisode: lastEp?.episode ?? 1,
        currentEpisodeTitle: lastEp?.title ?? 'Folge 1',
        watchedEpisodeKeys: allKeys,
        lastWatchedAt: resolvedWatchedAt,
        watchedWithoutDate: isWithoutDate,
      };
      if (existingIdx >= 0) {
        history.watches[existingIdx] = nextEntry;
      } else {
        history.watches.push(nextEntry);
      }
    }
  } else {
    if (media.kind !== 'series' || typeof season !== 'number' || typeof episode !== 'number') {
      res.status(400).json({ error: 'Staffel und Folge sind erforderlich.' });
      return;
    }
    const allEpisodes = buildNasEpisodesForSeries(media, existingEntry) ?? [];
    const targetEp = allEpisodes.find((ep) => ep.season === season && ep.episode === episode);
    if (!targetEp) {
      res.status(404).json({ error: 'Angegebene Folge wurde auf dem NAS nicht gefunden.' });
      return;
    }

    const watchedSet = getWatchedEpisodeSet(media, existingEntry);
    const key = formatEpisodeKey(season, episode);
    if (watched) {
      watchedSet.add(key);
    } else {
      watchedSet.delete(key);
    }

    if (watchedSet.size === 0) {
      history.watches = history.watches.filter(
        (w) => !(w.username === username && w.mediaId === mediaId)
      );
    } else {
      const firstUnwatched = allEpisodes.find(
        (ep) => !watchedSet.has(formatEpisodeKey(ep.season, ep.episode))
      );
      const fallbackEp = firstUnwatched ?? allEpisodes[allEpisodes.length - 1];
      const nextLastWatchedAt = watched
        ? resolvedWatchedAt
        : (existingEntry?.lastWatchedAt ?? null);
      const nextWithoutDate = watched
        ? isWithoutDate
        : Boolean(existingEntry?.watchedWithoutDate && !existingEntry?.lastWatchedAt);
      const epMinutes = allEpisodes
        .filter((ep) => watchedSet.has(formatEpisodeKey(ep.season, ep.episode)))
        .reduce((sum, ep) => sum + Math.max(1, ep.durationMinutes || 42), 0);
      const nextEntry: WatchHistoryEntry = {
        username,
        mediaId: media.id,
        tmdbId: media.tmdbId,
        title: media.title,
        mediaType: 'series',
        genre: media.genre,
        watchedMinutes: watched
          ? Math.max(existingEntry?.watchedMinutes ?? 0, epMinutes)
          : !watched &&
              existingEntry?.currentSeason === season &&
              existingEntry?.currentEpisode === episode
            ? epMinutes
            : Math.min(existingEntry?.watchedMinutes ?? epMinutes, epMinutes),
        episodesWatched: watchedSet.size,
        currentSeason: fallbackEp?.season ?? season,
        currentEpisode: fallbackEp?.episode ?? episode,
        currentEpisodeTitle: fallbackEp?.title ?? targetEp.title,
        watchedEpisodeKeys: Array.from(watchedSet),
        lastWatchedAt: nextLastWatchedAt,
        watchedWithoutDate: nextWithoutDate,
      };
      if (existingIdx >= 0) {
        history.watches[existingIdx] = nextEntry;
      } else {
        history.watches.push(nextEntry);
      }
    }
  }

  writeJsonAtomic('history.json', history);
  syncUserProfileDataSnapshot(username);
  if (watched) {
    recordUserAction(username, {
      type: 'mark_watched',
      mediaId: media.id,
      mediaKind: media.kind,
      title: media.title,
      genre: media.genre,
    });
  }
  appendWal('WATCH_STATE_MARKED', username, {
    mediaId,
    scope,
    watched,
    season,
    episode,
    dateMode: dateMode ?? (watched ? 'now' : undefined),
    watchedAt: watched ? resolvedWatchedAt : undefined,
  });

  const calendarSync = syncCalendarAndAlerts(username);
  res.json({ ok: true, ...calendarSync });
});

// DE Series Calendar + Auto Match + Favorites + Alerts
app.get('/api/nas/calendar', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const result = syncCalendarAndAlerts(username, null);
  res.json(result);
});

async function fetchSeriesCalendarFromInternet(): Promise<CalendarStore> {
  const todayDate = new Date();
  const todayIso = todayDate.toISOString().slice(0, 10);
  const dateOffsets = [0, 1, 2, 3].map((offset) => {
    const d = new Date(todayDate.getTime() + offset * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });

  type TvMazeScheduleItem = {
    id?: number;
    name?: string;
    season?: number;
    number?: number;
    airdate?: string;
    summary?: string | null;
    show?: {
      id?: number;
      name?: string;
      status?: string | null;
      premiered?: string | null;
      genres?: string[];
      summary?: string | null;
      image?: { medium?: string; original?: string } | null;
      network?: { name?: string } | null;
      webChannel?: { name?: string } | null;
    };
    _embedded?: {
      show?: {
        id?: number;
        name?: string;
        status?: string | null;
        premiered?: string | null;
        genres?: string[];
        summary?: string | null;
        image?: { medium?: string; original?: string } | null;
        network?: { name?: string } | null;
        webChannel?: { name?: string } | null;
      };
    };
  };

  const fetchJsonSafe = async <T>(url: string, timeoutMs = 7500): Promise<T | null> => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  };

  const scheduleResultsPromise = Promise.all(
    dateOffsets.flatMap((isoDate) => [
      fetchJsonSafe<TvMazeScheduleItem[]>(
        `https://api.tvmaze.com/schedule?country=DE&date=${isoDate}`
      ),
      fetchJsonSafe<TvMazeScheduleItem[]>(
        `https://api.tvmaze.com/schedule/web?country=DE&date=${isoDate}`
      ),
    ])
  );

  const globalWebTodayPromise = fetchJsonSafe<TvMazeScheduleItem[]>(
    `https://api.tvmaze.com/schedule/web?date=${todayIso}`
  );

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const nasSeriesTitles = Array.from(
    new Set(
      catalog
        .filter((i) => i.kind === 'series')
        .map((i) => i.title.trim())
        .filter((t) => t.length >= 2)
    )
  ).slice(0, 8);

  const nasShowLookupPromise = Promise.allSettled(
    nasSeriesTitles.map((seriesTitle) =>
      fetchJsonSafe<{
        id: number;
        name?: string;
        premiered?: string | null;
        status?: string | null;
        genres?: string[];
        summary?: string | null;
        image?: { medium?: string; original?: string } | null;
        network?: { name?: string } | null;
        webChannel?: { name?: string } | null;
      }>(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(seriesTitle)}`, 5500)
    )
  );

  const geminiSeriesPromise = (async (): Promise<{
    items: CalendarReleaseRecord[];
    sources: FilmGroundSourceRecord[];
  }> => {
    if (!process.env.GEMINI_API_KEY) return { items: [], sources: [] };
    try {
      const ai = getGeminiClient();
      const prompt = `Recherchiere über Google aktuelle TV-Serien, neue Staffeln und Serien-Neustarts in Deutschland (DE) rund um ${todayIso}.
Berücksichtige Streaming-Anbieter (Netflix, Prime Video, Disney+, Apple TV+, Paramount+, WOW, RTL+, Joyn, Crunchyroll, MagentaTV, DAZN), Mediatheken (ARD Mediathek, ZDF Mediathek, ARTE Mediathek, 3sat Mediathek), Free-TV (Das Erste, ZDF, ARTE, RTL, VOX, ProSieben, SAT.1, Kabel Eins, SIXX, TELE 5) und Pay-TV (Sky, Sky Atlantic, Sky One, Sky Krimi, Warner TV Serie, 13th Street, SYFY, Universal TV).
Gib ausschließlich ein valides JSON-Array (8 bis 14 reale, verifizierte Serientermine) ohne Erklärtext zurück:
[
  {
    "title": "Serientitel",
    "season": 1,
    "episode": 1,
    "episodeTitle": "Folgentitel",
    "releaseDate": "YYYY-MM-DD",
    "provider": "ZDF Mediathek",
    "genre": "Genre",
    "fsk": 12,
    "cast": ["Name 1", "Name 2"],
    "synopsis": "Kurze deutsche Beschreibung (1-2 Sätze)",
    "seriesStatus": "returning" | "ended" | "canceled"
  }
]`;
      const responsePromise = ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] },
      });
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000));
      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (!response) return { items: [], sources: [] };

      const rawText = (response.text ?? '').trim();
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return { items: [], sources: [] };

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        title?: string;
        season?: number;
        episode?: number;
        episodeTitle?: string;
        releaseDate?: string;
        provider?: string;
        genre?: string;
        fsk?: number;
        cast?: string[];
        synopsis?: string;
        seriesStatus?: string;
      }>;

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const groundingSources: FilmGroundSourceRecord[] = [];
      for (const chunk of chunks) {
        const web = (chunk as { web?: { uri?: string; title?: string } }).web;
        if (web?.uri) {
          groundingSources.push({
            title: web.title?.trim() || web.uri,
            uri: web.uri,
          });
        }
      }

      const validProviders = new Set<string>(GERMAN_ALL_PROVIDERS);
      const items: CalendarReleaseRecord[] = parsed
        .filter((entry) => Boolean(entry.title?.trim()))
        .slice(0, 16)
        .map((entry, idx) => {
          const cleanTitle = entry.title!.trim();
          const season = Math.max(1, Number(entry.season) || 1);
          const episode = Math.max(1, Number(entry.episode) || 1);
          const releaseDate =
            entry.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)
              ? entry.releaseDate
              : todayIso;
          const provider =
            entry.provider && validProviders.has(entry.provider.trim())
              ? (entry.provider.trim() as StreamingProviderDE)
              : mapNetworkToGermanProvider(entry.provider, true);
          const genre = entry.genre?.trim() || 'Drama & Serie';
          const status: SeriesProductionStatus | undefined =
            entry.seriesStatus === 'ended' ||
            entry.seriesStatus === 'canceled' ||
            entry.seriesStatus === 'returning'
              ? entry.seriesStatus
              : undefined;
          return {
            id: `de-live-gemini-${makeFilmSlug(cleanTitle)}-s${season}e${episode}-${idx}`,
            tmdbId: 0,
            title: cleanTitle,
            season,
            episode,
            episodeTitle: entry.episodeTitle?.trim() || `Folge ${episode}`,
            releaseDate,
            provider,
            genre,
            coverKey: inferCoverKeyForGenre(genre),
            synopsis:
              entry.synopsis?.trim() ||
              `Aktuelle Serie „${cleanTitle}“ im deutschen TV- & Streaming-Programm (${provider}).`,
            cast: Array.isArray(entry.cast) ? entry.cast.filter(Boolean).slice(0, 4) : [],
            isSeasonPremiere: episode === 1,
            fsk: normalizeFskLimit(entry.fsk, 12),
            ...(status ? { seriesStatus: status } : {}),
          };
        });
      return { items, sources: groundingSources };
    } catch {
      return { items: [], sources: [] };
    }
  })();

  const [scheduleResults, globalWebToday, nasLookups, geminiResult] = await Promise.all([
    scheduleResultsPromise,
    globalWebTodayPromise,
    nasShowLookupPromise,
    geminiSeriesPromise,
  ]);

  const existingCalendar = readJsonFile<CalendarStore>('calendar.json', { releases: [] });
  const merged = new Map<string, CalendarReleaseRecord>();

  const registerRelease = (rel: CalendarReleaseRecord) => {
    const dedupeKey = rel.id.startsWith('de-manual-')
      ? rel.id
      : `${normalizeFilmTitle(rel.title)}::s${rel.season}e${rel.episode}`;
    const existing = merged.get(dedupeKey);
    if (!existing) {
      merged.set(dedupeKey, rel);
      return;
    }
    merged.set(dedupeKey, {
      ...existing,
      coverUrl: existing.coverUrl ?? rel.coverUrl,
      cast: existing.cast && existing.cast.length > 0 ? existing.cast : rel.cast,
      synopsis:
        rel.synopsis && rel.synopsis.length > (existing.synopsis?.length ?? 0)
          ? rel.synopsis
          : existing.synopsis,
      seriesStatus: existing.seriesStatus ?? rel.seriesStatus,
      seriesStatusDetail: existing.seriesStatusDetail ?? rel.seriesStatusDetail,
    });
  };

  for (const rel of existingCalendar.releases) {
    if (rel.id.startsWith('de-manual-')) {
      registerRelease(rel);
    }
  }

  for (const gItem of geminiResult.items) {
    registerRelease(gItem);
  }

  const deEntries = scheduleResults.flatMap((arr) => arr ?? []);
  const globalStreamingRegex =
    /netflix|amazon|prime video|disney\+|apple tv\+|paramount\+|crunchyroll|sky|hbo|max|discovery\+/i;
  const globalEntries = (globalWebToday ?? []).filter((ep) => {
    const show = ep.show ?? ep._embedded?.show;
    const wc = show?.webChannel?.name || '';
    return globalStreamingRegex.test(wc);
  });

  let tvMazeCount = 0;
  for (const ep of [...deEntries, ...globalEntries]) {
    const show = ep.show ?? ep._embedded?.show;
    const title = show?.name?.trim();
    if (!title) continue;
    const season = Math.max(1, Number(ep.season ?? 1));
    const episode = Math.max(1, Number(ep.number ?? 1));
    const releaseDate = (ep.airdate || todayIso).slice(0, 10);
    const isWeb = Boolean(show?.webChannel?.name);
    const netName = show?.webChannel?.name || show?.network?.name || '';
    const provider = mapNetworkToGermanProvider(netName, isWeb);
    const genre = translateSeriesGenresToDe(show?.genres ?? []);
    const synopsis =
      stripHtmlTags(ep.summary ?? '') ||
      stripHtmlTags(show?.summary ?? '') ||
      `${title} — Staffel ${season}, Folge ${episode} (${provider}).`;
    const statusRaw = (show?.status ?? '').toLowerCase();
    const seriesStatus: SeriesProductionStatus | undefined =
      statusRaw === 'ended'
        ? 'ended'
        : statusRaw === 'running' || statusRaw === 'to be determined'
          ? 'returning'
          : undefined;

    registerRelease({
      id: `tvmaze-${show?.id ?? makeFilmSlug(title)}-s${season}e${episode}`,
      tmdbId: Number(show?.id ?? 0),
      title,
      season,
      episode,
      episodeTitle: ep.name?.trim() || `Folge ${episode}`,
      releaseDate,
      provider,
      genre,
      coverKey: inferCoverKeyForGenre(genre),
      ...(show?.image?.original || show?.image?.medium
        ? { coverUrl: show?.image?.original || show?.image?.medium }
        : {}),
      synopsis,
      cast: [],
      isSeasonPremiere: episode === 1,
      fsk: 12,
      ...(seriesStatus ? { seriesStatus, seriesStatusDetail: show?.status ?? undefined } : {}),
    });
    tvMazeCount++;
    if (tvMazeCount >= 120) break;
  }

  for (const settled of nasLookups) {
    if (settled.status !== 'fulfilled' || !settled.value?.name) continue;
    const hit = settled.value;
    const isWeb = Boolean(hit.webChannel?.name);
    const netName = hit.webChannel?.name || hit.network?.name || '';
    const provider = mapNetworkToGermanProvider(netName, isWeb);
    const genre = translateSeriesGenresToDe(hit.genres ?? []);
    const statusRaw = (hit.status ?? '').toLowerCase();
    const seriesStatus: SeriesProductionStatus | undefined =
      statusRaw === 'ended'
        ? 'ended'
        : statusRaw === 'running' || statusRaw === 'to be determined'
          ? 'returning'
          : undefined;

    registerRelease({
      id: `tvmaze-nas-${hit.id}`,
      tmdbId: hit.id,
      title: hit.name!,
      season: 1,
      episode: 1,
      episodeTitle: 'NAS-Serie (Serien-Info)',
      releaseDate: (hit.premiered || todayIso).slice(0, 10),
      provider,
      genre,
      coverKey: inferCoverKeyForGenre(genre),
      ...(hit.image?.original || hit.image?.medium
        ? { coverUrl: hit.image?.original || hit.image?.medium }
        : {}),
      synopsis: stripHtmlTags(hit.summary ?? '') || `Serie „${hit.name}“ aus deinem NAS-Katalog.`,
      cast: [],
      isSeasonPremiere: false,
      fsk: 12,
      ...(seriesStatus ? { seriesStatus, seriesStatusDetail: hit.status ?? undefined } : {}),
    });
  }

  const fetchedLiveCount = geminiResult.items.length + tvMazeCount;
  if (fetchedLiveCount === 0) {
    throw new Error(
      'Aktuell konnten keine Serientermine aus dem Internet abgerufen werden. Bitte prüfe die Internetverbindung.'
    );
  }

  const combinedReleases = Array.from(merged.values())
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
    .slice(0, 150);

  const webSources: FilmGroundSourceRecord[] = [
    {
      title: 'TVMaze Deutschland TV-Programm (Free-TV & Pay-TV)',
      uri: `https://api.tvmaze.com/schedule?country=DE&date=${todayIso}`,
    },
    {
      title: 'TVMaze Streaming & Mediatheken (DE)',
      uri: `https://api.tvmaze.com/schedule/web?country=DE&date=${todayIso}`,
    },
  ];

  const dedupedSources: FilmGroundSourceRecord[] = [];
  const seenUris = new Set<string>();
  for (const s of [...geminiResult.sources, ...webSources]) {
    if (s.uri && !seenUris.has(s.uri)) {
      seenUris.add(s.uri);
      dedupedSources.push(s);
    }
  }

  const hasGemini = geminiResult.items.length > 0;
  const hasWeb = tvMazeCount > 0;
  const fetchMethod: CalendarStore['fetchMethod'] =
    hasGemini && hasWeb ? 'mixed' : hasGemini ? 'gemini-search' : 'live-web';

  const store: CalendarStore = {
    releases: combinedReleases,
    sources: dedupedSources,
    lastFetchedAt: new Date().toISOString(),
    fetchMethod,
  };
  writeJsonAtomic('calendar.json', store);
  return store;
}

app.post(
  '/api/nas/calendar/refresh',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    try {
      await fetchSeriesCalendarFromInternet();
      appendWal('CALENDAR_INTERNET_REFRESHED', username, { at: new Date().toISOString() });
      const result = syncCalendarAndAlerts(username, null);
      res.json(result);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Internet-Aktualisierung des Serienkalenders fehlgeschlagen.';
      const existing = readJsonFile<CalendarStore>('calendar.json', { releases: [] });
      if (existing.releases.length > 0) {
        res.json(syncCalendarAndAlerts(username, msg));
        return;
      }
      res.status(502).json({ error: msg });
    }
  }
);

// Toggle Manual/Auto/Mute Favorite
app.post('/api/nas/calendar/favorite', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { seriesTitle, action } = req.body as {
    seriesTitle: string;
    action: 'pin' | 'mute' | 'auto';
  };

  const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  if (!favs.users[username]) {
    favs.users[username] = { auto: [], manual: [], muted: [] };
  }
  const u = favs.users[username];

  u.manual = u.manual.filter((t) => t !== seriesTitle);
  u.muted = u.muted.filter((t) => t !== seriesTitle);

  if (action === 'pin') {
    u.manual.push(seriesTitle);
  } else if (action === 'mute') {
    u.muted.push(seriesTitle);
  }

  writeJsonAtomic('favorites.json', favs);
  syncUserProfileDataSnapshot(username);
  appendWal('FAVORITE_RULE_UPDATED', username, { seriesTitle, action });

  const result = syncCalendarAndAlerts(username);
  res.json(result);
});

// Simulate a DE release becoming available today (so users can test notifications live)
app.post('/api/nas/calendar/release-now', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { releaseId } = req.body as { releaseId: string };
  const calendar = readJsonFile<CalendarStore>('calendar.json', {
    releases: [],
  });
  const target = calendar.releases.find((r) => r.id === releaseId);
  if (!target) {
    res.status(404).json({ error: 'Kalendereintrag nicht gefunden.' });
    return;
  }

  target.releaseDate = new Date().toISOString().slice(0, 10);
  writeJsonAtomic('calendar.json', calendar);

  // Falls diese Benachrichtigung zuvor gelöscht wurde, bei expliziter Auslösung wieder freigeben
  const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  const reactivateId = `${username}_${target.title}_S${target.season}E${target.episode}`;
  if (notifStore.dismissedIds?.[username]?.includes(reactivateId)) {
    notifStore.dismissedIds[username] = notifStore.dismissedIds[username].filter(
      (id) => id !== reactivateId
    );
    writeJsonAtomic('notifications.json', notifStore);
  }

  appendWal('CALENDAR_RELEASE_ACTIVATED', username, { releaseId, title: target.title });

  const result = syncCalendarAndAlerts(username);
  res.json(result);
});

interface SeriesLookupCandidateRecord {
  id: string;
  title: string;
  year?: number;
  season: number;
  episode: number;
  episodeTitle: string;
  releaseDate: string;
  provider: CalendarReleaseRecord['provider'];
  networkLabel?: string;
  genre: string;
  synopsis: string;
  cast: string[];
  coverUrl?: string;
  seriesStatus?: SeriesProductionStatus;
  fsk?: FskLevel;
  sourceLabel: string;
}

function mapNetworkToDeProvider(
  networkName?: string | null,
  isWebChannel = false
): CalendarReleaseRecord['provider'] {
  return mapNetworkToGermanProvider(networkName, isWebChannel);
}

function translateSeriesGenresToDe(genres: string[]): string {
  const map: Record<string, string> = {
    'science-fiction': 'Sci-Fi',
    'sci-fi': 'Sci-Fi',
    crime: 'Krimi',
    thriller: 'Thriller',
    mystery: 'Mystery',
    drama: 'Drama',
    comedy: 'Komödie',
    action: 'Action',
    adventure: 'Abenteuer',
    horror: 'Horror',
    documentary: 'Dokumentation',
    fantasy: 'Fantasy',
    animation: 'Animation',
    anime: 'Anime',
    romance: 'Romantik',
    history: 'Historie',
    family: 'Familie',
    supernatural: 'Mystery',
    espionage: 'Spionage',
  };
  const translated = genres
    .map((g) => map[g.toLowerCase().trim()] ?? g.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(translated)).slice(0, 2);
  return unique.length > 0 ? unique.join(' & ') : 'Drama & Serie';
}

async function searchSeriesTvMaze(query: string): Promise<SeriesLookupCandidateRecord[]> {
  try {
    const searchResp = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(5500) }
    );
    if (!searchResp.ok) return [];
    const rawList = (await searchResp.json()) as Array<{
      score?: number;
      show?: {
        id: number;
        name?: string;
        premiered?: string | null;
        status?: string | null;
        genres?: string[];
        summary?: string | null;
        image?: { medium?: string; original?: string } | null;
        network?: { name?: string } | null;
        webChannel?: { name?: string } | null;
      };
    }>;

    const topShows = rawList.map((r) => r.show).filter((s): s is NonNullable<typeof s> => Boolean(s?.id && s?.name)).slice(0, 6);
    const todayIso = new Date().toISOString().slice(0, 10);

    const enriched = await Promise.all(
      topShows.map(async (show): Promise<SeriesLookupCandidateRecord | null> => {
        let episodes: Array<{
          season?: number;
          number?: number;
          name?: string;
          airdate?: string | null;
        }> = [];
        let castNames: string[] = [];

        try {
          const detailResp = await fetch(
            `https://api.tvmaze.com/shows/${show.id}?embed[]=episodes&embed[]=cast`,
            { signal: AbortSignal.timeout(4500) }
          );
          if (detailResp.ok) {
            const detail = (await detailResp.json()) as {
              _embedded?: {
                episodes?: typeof episodes;
                cast?: Array<{ person?: { name?: string } }>;
              };
            };
            episodes = detail._embedded?.episodes ?? [];
            castNames = (detail._embedded?.cast ?? [])
              .map((c) => c.person?.name?.trim())
              .filter((n): n is string => Boolean(n))
              .slice(0, 4);
          }
        } catch {
          // Basisdaten verwenden
        }

        const upcomingEp = episodes.find(
          (ep) => ep.airdate && ep.airdate >= todayIso && typeof ep.season === 'number'
        );
        const latestEp =
          upcomingEp ??
          episodes
            .slice()
            .reverse()
            .find((ep) => typeof ep.season === 'number' && typeof ep.number === 'number');

        const statusRaw = (show.status ?? '').toLowerCase();
        const seriesStatus: SeriesProductionStatus | undefined =
          statusRaw === 'ended'
            ? 'ended'
            : statusRaw === 'running' || statusRaw === 'to be determined'
              ? 'returning'
              : undefined;

        const season = Math.max(1, latestEp?.season ?? 1);
        const episode = Math.max(1, latestEp?.number ?? 1);
        const episodeTitle = latestEp?.name?.trim() || `Folge ${episode}`;
        const releaseDate =
          (latestEp?.airdate && /^\d{4}-\d{2}-\d{2}$/.test(latestEp.airdate)
            ? latestEp.airdate
            : null) ??
          (show.premiered && /^\d{4}-\d{2}-\d{2}$/.test(show.premiered) ? show.premiered : null) ??
          todayIso;

        const networkLabel = show.webChannel?.name?.trim() || show.network?.name?.trim() || undefined;
        const yearMatch = show.premiered?.match(/^(\d{4})/);
        const synopsisClean = show.summary ? stripHtmlTags(show.summary) : '';

        return {
          id: `tvmaze-${show.id}`,
          title: show.name!.trim(),
          year: yearMatch ? Number(yearMatch[1]) : undefined,
          season,
          episode,
          episodeTitle,
          releaseDate,
          provider: mapNetworkToDeProvider(networkLabel, Boolean(show.webChannel?.name)),
          networkLabel,
          genre: translateSeriesGenresToDe(show.genres ?? []),
          synopsis:
            synopsisClean ||
            `Serie „${show.name!.trim()}“${networkLabel ? ` (${networkLabel})` : ''}.`,
          cast: castNames,
          coverUrl: show.image?.original ?? show.image?.medium ?? undefined,
          seriesStatus,
          fsk: 12,
          sourceLabel: 'TVMaze',
        };
      })
    );

    return enriched.filter((c): c is SeriesLookupCandidateRecord => Boolean(c));
  } catch {
    return [];
  }
}

async function searchSeriesItunesDe(query: string): Promise<SeriesLookupCandidateRecord[]> {
  try {
    const resp = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=de&entity=tvSeason&limit=8`,
      { signal: AbortSignal.timeout(5500) }
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      results?: Array<{
        collectionId?: number;
        artistName?: string;
        collectionName?: string;
        artworkUrl100?: string;
        releaseDate?: string;
        primaryGenreName?: string;
        longDescription?: string;
        shortDescription?: string;
        contentAdvisoryRating?: string;
      }>;
    };

    const bySeries = new Map<string, SeriesLookupCandidateRecord>();
    const todayIso = new Date().toISOString().slice(0, 10);

    for (const row of data.results ?? []) {
      const rawTitle = (row.artistName || row.collectionName || '').trim();
      if (!rawTitle) continue;
      const cleanTitle = rawTitle
        .replace(/,\s*(Staffel|Season)\s*\d+.*$/i, '')
        .replace(/\s*-\s*(Staffel|Season)\s*\d+.*$/i, '')
        .trim();
      const seasonMatch = (row.collectionName ?? '').match(/(?:Staffel|Season)\s*(\d+)/i);
      const seasonNum = seasonMatch ? Math.max(1, Number(seasonMatch[1])) : 1;
      const key = normalizeFilmTitle(cleanTitle);
      if (!key) continue;

      const releaseIso =
        row.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(row.releaseDate)
          ? row.releaseDate.slice(0, 10)
          : todayIso;
      const yearMatch = releaseIso.match(/^(\d{4})/);
      const poster = row.artworkUrl100
        ? row.artworkUrl100.replace(/\/\d+x\d+bb\.jpg$/, '/400x600bb.jpg')
        : undefined;
      const synopsis = (row.longDescription || row.shortDescription || '').trim();

      const existing = bySeries.get(key);
      if (!existing || seasonNum > existing.season) {
        bySeries.set(key, {
          id: `itunes-${row.collectionId ?? makeFilmSlug(cleanTitle)}`,
          title: cleanTitle,
          year: yearMatch ? Number(yearMatch[1]) : undefined,
          season: seasonNum,
          episode: 1,
          episodeTitle: `Staffel ${seasonNum} · Auftakt`,
          releaseDate: releaseIso,
          provider: 'Apple TV+',
          networkLabel: 'Apple TV DE',
          genre: row.primaryGenreName?.trim() || 'Drama & Serie',
          synopsis: synopsis || `Serie „${cleanTitle}“ (DE-Katalog).`,
          cast: [],
          coverUrl: poster,
          fsk: 12,
          sourceLabel: 'Apple TV DE',
        });
      }
    }

    return Array.from(bySeries.values());
  } catch {
    return [];
  }
}

async function searchSeriesGemini(query: string): Promise<SeriesLookupCandidateRecord[]> {
  if (!process.env.GEMINI_API_KEY) return [];
  try {
    const ai = getGeminiClient();
    const todayIso = new Date().toISOString().slice(0, 10);
    const prompt = `Suche über Google nach TV- oder Streaming-Serien mit dem Titel "${query}" für den deutschsprachigen Raum (DE). Heutiges Datum: ${todayIso}.
Gib ausschließlich ein valides JSON-Array (max. 5 passende Serien, falls der Titel mehrdeutig ist) zurück, ohne erklärenden Text:
[
  {
    "title": "Deutscher Serientitel",
    "year": 2024,
    "season": 1,
    "episode": 1,
    "episodeTitle": "Titel der aktuellen/nächsten Folge",
    "releaseDate": "YYYY-MM-DD",
    "provider": "Netflix" | "Prime Video" | "Disney+" | "Apple TV+" | "Paramount+" | "WOW" | "RTL+" | "Joyn" | "ZDF Mediathek" | "ARD Mediathek" | "ZDF" | "Das Erste" | "RTL" | "ProSieben" | "SAT.1" | "Sky" | "Sky Atlantic" | "Warner TV Serie" | "13th Street" | "SYFY" | "Crunchyroll",
    "genre": "Deutsches Genre",
    "synopsis": "Kurze deutsche Beschreibung (1-2 Sätze)",
    "cast": ["Schauspieler 1", "Schauspieler 2"],
    "seriesStatus": "returning" | "ended" | "canceled",
    "fsk": 0 | 6 | 12 | 16 | 18
  }
]`;

    const responsePromise = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 6500)
    );
    const response = await Promise.race([responsePromise, timeoutPromise]);
    if (!response) return [];

    const rawText = (response.text ?? '').trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      title?: string;
      year?: number;
      season?: number;
      episode?: number;
      episodeTitle?: string;
      releaseDate?: string;
      provider?: string;
      genre?: string;
      synopsis?: string;
      cast?: string[];
      seriesStatus?: string;
      fsk?: number;
    }>;

    const validProviders = new Set<string>(GERMAN_ALL_PROVIDERS);

    return parsed
      .filter((entry) => Boolean(entry.title?.trim()))
      .slice(0, 5)
      .map((entry, idx) => {
        const provider =
          entry.provider && validProviders.has(entry.provider.trim())
            ? (entry.provider.trim() as CalendarReleaseRecord['provider'])
            : mapNetworkToDeProvider(entry.provider, true);
        const seriesStatus: SeriesProductionStatus | undefined =
          entry.seriesStatus === 'ended' ||
          entry.seriesStatus === 'canceled' ||
          entry.seriesStatus === 'returning'
            ? entry.seriesStatus
            : undefined;
        const releaseDate =
          entry.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate)
            ? entry.releaseDate
            : todayIso;

        return {
          id: `gemini-${idx}-${makeFilmSlug(entry.title!)}`,
          title: entry.title!.trim(),
          year: typeof entry.year === 'number' ? entry.year : undefined,
          season: Math.max(1, Number(entry.season) || 1),
          episode: Math.max(1, Number(entry.episode) || 1),
          episodeTitle: entry.episodeTitle?.trim() || `Folge ${Math.max(1, Number(entry.episode) || 1)}`,
          releaseDate,
          provider,
          networkLabel: entry.provider?.trim() || provider,
          genre: entry.genre?.trim() || 'Drama & Serie',
          synopsis: entry.synopsis?.trim() || `Serie „${entry.title!.trim()}“.`,
          cast: Array.isArray(entry.cast) ? entry.cast.filter(Boolean).slice(0, 4) : [],
          seriesStatus,
          fsk: normalizeFskLimit(entry.fsk, 12),
          sourceLabel: 'Google Suche',
        };
      });
  } catch {
    return [];
  }
}

async function searchSeriesOnline(query: string): Promise<SeriesLookupCandidateRecord[]> {
  const [geminiResults, tvMazeResults, itunesResults] = await Promise.all([
    searchSeriesGemini(query),
    searchSeriesTvMaze(query),
    searchSeriesItunesDe(query),
  ]);

  const merged = new Map<string, SeriesLookupCandidateRecord>();
  const all = [...geminiResults, ...tvMazeResults, ...itunesResults];

  for (const item of all) {
    const key = `${normalizeFilmTitle(item.title)}:${item.year ?? 'any'}`;
    const normOnly = normalizeFilmTitle(item.title);
    // Falls bereits ohne Jahr oder mit gleichem Titel vorhanden, zusammenführen
    const existingKey = merged.has(key)
      ? key
      : Array.from(merged.keys()).find((k) => k.startsWith(`${normOnly}:`));

    if (!existingKey) {
      merged.set(key, item);
      continue;
    }

    const existing = merged.get(existingKey)!;
    merged.set(existingKey, {
      ...existing,
      year: existing.year ?? item.year,
      coverUrl: existing.coverUrl ?? item.coverUrl,
      cast: existing.cast.length > 0 ? existing.cast : item.cast,
      seriesStatus: existing.seriesStatus ?? item.seriesStatus,
      networkLabel: existing.networkLabel ?? item.networkLabel,
      synopsis:
        item.sourceLabel === 'Apple TV DE' && existing.sourceLabel === 'TVMaze'
          ? item.synopsis
          : existing.synopsis.length >= item.synopsis.length
            ? existing.synopsis
            : item.synopsis,
      sourceLabel: existing.sourceLabel.includes(item.sourceLabel)
        ? existing.sourceLabel
        : `${existing.sourceLabel} + ${item.sourceLabel}`,
    });
  }

  return Array.from(merged.values()).slice(0, 8);
}

// Live online search for series by title alone (returns matching candidates for selection modal)
app.post(
  '/api/nas/calendar/search-series',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const { query } = req.body as { query?: string };
    const cleanQuery = query?.trim() ?? '';
    if (!cleanQuery) {
      res.status(400).json({ error: 'Bitte gib einen Serientitel ein.' });
      return;
    }

    const candidates = await searchSeriesOnline(cleanQuery);
    res.json({ query: cleanQuery, candidates });
  }
);

// Add manual series to DE Series Calendar (title-only minimum, with optional favorite pin)
app.post('/api/nas/calendar/manual-series', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const {
    title,
    season,
    episode,
    episodeTitle,
    releaseDate,
    provider,
    genre,
    synopsis,
    cast,
    coverUrl,
    pinAsFavorite,
    seriesStatus,
    fsk,
  } = req.body as {
    title?: string;
    season?: number;
    episode?: number;
    episodeTitle?: string;
    releaseDate?: string;
    provider?: CalendarReleaseRecord['provider'];
    genre?: string;
    synopsis?: string;
    cast?: string[];
    coverUrl?: string;
    pinAsFavorite?: boolean;
    seriesStatus?: SeriesProductionStatus;
    fsk?: FskLevel;
  };

  const cleanTitle = title?.trim();
  if (!cleanTitle) {
    res.status(400).json({ error: 'Serientitel ist erforderlich.' });
    return;
  }

  const effectiveReleaseDate =
    releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
      ? releaseDate
      : new Date().toISOString().slice(0, 10);
  const seasonNum = Math.max(1, Number(season) || 1);
  const episodeNum = Math.max(1, Number(episode) || 1);
  const cleanGenre = genre?.trim() || 'Drama & Thriller';
  const calendar = readJsonFile<CalendarStore>('calendar.json', {
    releases: [],
  });

  const validSeriesStatus: SeriesProductionStatus | undefined =
    seriesStatus === 'ended' || seriesStatus === 'canceled' || seriesStatus === 'returning'
      ? seriesStatus
      : undefined;

  const resolvedProvider: StreamingProviderDE = provider
    ? mapNetworkToGermanProvider(provider, true)
    : 'Netflix';

  const newRelease: CalendarReleaseRecord = {
    id: `de-manual-${crypto.randomUUID().slice(0, 8)}`,
    tmdbId: Math.floor(100000 + Math.random() * 899999),
    title: cleanTitle,
    season: seasonNum,
    episode: episodeNum,
    episodeTitle: episodeTitle?.trim() || `Folge ${episodeNum}`,
    releaseDate: effectiveReleaseDate,
    provider: resolvedProvider,
    genre: cleanGenre,
    coverKey: inferCoverKeyForGenre(cleanGenre),
    ...(coverUrl?.trim() ? { coverUrl: coverUrl.trim() } : {}),
    synopsis:
      synopsis?.trim() ||
      `Manuell vorgemerkter Serienstart für „${cleanTitle}“ (Staffel ${seasonNum}) auf ${resolvedProvider}.`,
    cast:
      Array.isArray(cast) && cast.length > 0
        ? cast.map((c) => c.trim()).filter(Boolean)
        : ['Besetzung wird zum DE-Start ergänzt'],
    isSeasonPremiere: episodeNum === 1,
    fsk: normalizeFskLimit(fsk, 12),
    ...(validSeriesStatus
      ? {
          seriesStatus: validSeriesStatus,
          seriesStatusDetail:
            validSeriesStatus === 'canceled'
              ? 'Serie eingestellt · Keine weiteren Staffeln geplant'
              : validSeriesStatus === 'ended'
                ? 'Serie regulär beendet · Abgeschlossene Handlung'
                : 'Laufende Serie · Weitere Folgen angekündigt',
        }
      : {}),
  };

  calendar.releases.unshift(newRelease);
  writeJsonAtomic('calendar.json', calendar);

  if (pinAsFavorite) {
    const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
    if (!favs.users[username]) {
      favs.users[username] = { auto: [], manual: [], muted: [] };
    }
    const u = favs.users[username];
    u.muted = u.muted.filter((t) => t !== cleanTitle);
    if (!u.manual.includes(cleanTitle)) {
      u.manual.push(cleanTitle);
    }
    writeJsonAtomic('favorites.json', favs);
  }

  appendWal('MANUAL_SERIES_ADDED', username, {
    title: cleanTitle,
    season: seasonNum,
    episode: episodeNum,
    releaseDate,
    provider: newRelease.provider,
    pinAsFavorite: Boolean(pinAsFavorite),
  });

  const result = syncCalendarAndAlerts(username);
  res.status(201).json(result);
});

// Delete a manually added series from calendar.json
app.delete(
  '/api/nas/calendar/manual-series/:id',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    const releaseId = req.params.id;
    if (!releaseId.startsWith('de-manual-')) {
      res.status(400).json({ error: 'Nur manuell hinzugefügte Serien können entfernt werden.' });
      return;
    }

    const calendar = readJsonFile<CalendarStore>('calendar.json', {
      releases: [],
    });
    const beforeCount = calendar.releases.length;
    calendar.releases = calendar.releases.filter((r) => r.id !== releaseId);
    if (calendar.releases.length === beforeCount) {
      res.status(404).json({ error: 'Manueller Serieneintrag nicht gefunden.' });
      return;
    }

    writeJsonAtomic('calendar.json', calendar, { allowShrink: true });
    appendWal('MANUAL_SERIES_DELETED', username, { releaseId });
    const result = syncCalendarAndAlerts(username);
    res.json(result);
  }
);

// --- Filmstarts DE & AT (Internet-Fetch + NAS-Abgleich + Favoriten & Benachrichtigungen) ---

type FilmReleaseRegion = 'DE' | 'AT' | 'DE/AT';
type FilmReleaseChannel = 'Kino' | 'Streaming' | 'Kino & Streaming';

interface FilmGroundSourceRecord {
  title: string;
  uri: string;
}

interface FilmStartStoredRecord {
  id: string;
  title: string;
  releaseDate: string;
  releaseDateDE?: string;
  releaseDateAT?: string;
  region: FilmReleaseRegion;
  channel: FilmReleaseChannel;
  providerOrDistributor: string;
  genre: string;
  fsk?: FskLevel;
  director?: string;
  cast: string[];
  synopsis: string;
  posterUrl?: string;
  coverKey?: string;
  sourceUrl?: string;
  sourceLabel?: string;
}

interface FilmStartsStore {
  releases: FilmStartStoredRecord[];
  sources: FilmGroundSourceRecord[];
  lastFetchedAt: string | null;
  fetchMethod: 'gemini-search' | 'live-web' | 'mixed' | 'cache';
}

const GERMAN_MONTHS: Record<string, string> = {
  januar: '01',
  jaenner: '01',
  jänner: '01',
  februar: '02',
  märz: '03',
  maerz: '03',
  april: '04',
  mai: '05',
  juni: '06',
  juli: '07',
  august: '08',
  september: '09',
  oktober: '10',
  november: '11',
  dezember: '12',
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&auml;/g, 'ä')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, ' '));
}

function parseGermanDateToIso(raw: string): string | null {
  const cleaned = decodeHtmlEntities(raw).replace(/^ab\s+/i, '').trim();
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const dotNumeric = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotNumeric) {
    const d = dotNumeric[1].padStart(2, '0');
    const m = dotNumeric[2].padStart(2, '0');
    return `${dotNumeric[3]}-${m}-${d}`;
  }

  const wordMatch = cleaned.match(/(\d{1,2})\.\s*([A-Za-zäöüÄÖÜß]+)\s+(\d{4})/);
  if (wordMatch) {
    const d = wordMatch[1].padStart(2, '0');
    const monthKey = wordMatch[2].toLowerCase().trim();
    const m = GERMAN_MONTHS[monthKey];
    if (m) return `${wordMatch[3]}-${m}-${d}`;
  }
  return null;
}

function normalizeFilmTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function makeFilmSlug(title: string): string {
  const slug = normalizeFilmTitle(title).replace(/\s+/g, '-').slice(0, 64);
  return slug || crypto.randomUUID().slice(0, 8);
}

async function fetchFilmstartsDeReleases(): Promise<{
  items: FilmStartStoredRecord[];
  sources: FilmGroundSourceRecord[];
}> {
  const urls = [
    {
      url: 'https://www.filmstarts.de/filme-vorschau/de/',
      label: 'FILMSTARTS.de – Demnächst im Kino (DE)',
    },
    {
      url: 'https://www.filmstarts.de/filme-imkino/kinostart/',
      label: 'FILMSTARTS.de – Aktuelle Kinostarts (DE)',
    },
  ];
  const results: FilmStartStoredRecord[] = [];
  const usedSources: FilmGroundSourceRecord[] = [];

  for (const source of urls) {
    try {
      const resp = await fetch(source.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
          'Accept-Language': 'de-DE,de;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      usedSources.push({ title: source.label, uri: source.url });

      const cards = html.split(/<li class="mdl"[^>]*>/i).slice(1);
      for (const cardRaw of cards) {
        const cardEnd = cardRaw.indexOf('</li>');
        const card = cardEnd >= 0 ? cardRaw.slice(0, cardEnd) : cardRaw.slice(0, 4500);

        const titleMatch = card.match(
          /<a[^>]*class="[^"]*meta-title-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i
        );
        if (!titleMatch) continue;
        const relHref = titleMatch[1];
        const title = stripHtmlTags(titleMatch[2]);
        if (!title) continue;

        const dateMatch = card.match(/<span[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const isoDate = dateMatch ? parseGermanDateToIso(stripHtmlTags(dateMatch[1])) : null;
        if (!isoDate) continue;

        const infoBlock =
          card.match(/<div[^>]*class="[^"]*meta-body-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
        const genreTokens = Array.from(
          infoBlock.matchAll(/<[^>]*dark-grey-link[^>]*>([\s\S]*?)<\/[^>]+>/gi)
        )
          .map((m) => stripHtmlTags(m[1]))
          .filter(Boolean);

        const dirBlock =
          card.match(/<div[^>]*class="[^"]*meta-body-direction[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
          '';
        const director = Array.from(
          dirBlock.matchAll(/<[^>]*dark-grey-link[^>]*>([\s\S]*?)<\/[^>]+>/gi)
        )
          .map((m) => stripHtmlTags(m[1]))
          .filter(Boolean)
          .join(', ');

        const actorBlock =
          card.match(/<div[^>]*class="[^"]*meta-body-actor[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ??
          '';
        const cast = Array.from(
          actorBlock.matchAll(/<[^>]*dark-grey-link[^>]*>([\s\S]*?)<\/[^>]+>/gi)
        )
          .map((m) => stripHtmlTags(m[1]))
          .filter(Boolean)
          .slice(0, 5);

        const synopsisRaw =
          card.match(/<div[^>]*class="[^"]*content-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
        const synopsis = stripHtmlTags(synopsisRaw);

        const imgDataSrc = card.match(/<img[^>]*data-src="([^"]+)"/i)?.[1];
        const imgSrc = card.match(/<img[^>]*class="[^"]*thumbnail-img[^"]*"[^>]*src="([^"]+)"/i)?.[1];
        const rawPoster = imgDataSrc || (imgSrc && !imgSrc.startsWith('data:') ? imgSrc : undefined);
        const posterUrl = rawPoster
          ? rawPoster.startsWith('//')
            ? `https:${rawPoster}`
            : rawPoster
          : undefined;

        const genreText = genreTokens.length > 0 ? genreTokens.slice(0, 3).join(' · ') : 'Spielfilm';

        results.push({
          id: `film-${makeFilmSlug(title)}`,
          title,
          releaseDate: isoDate,
          releaseDateDE: isoDate,
          region: 'DE',
          channel: 'Kino',
          providerOrDistributor: 'Kino (Deutschland)',
          genre: genreText,
          fsk: 12,
          director: director || undefined,
          cast,
          synopsis:
            synopsis ||
            `Kinostart in Deutschland ab ${isoDate.split('-').reverse().join('.')} (${genreText}).`,
          posterUrl,
          coverKey: inferCoverKeyForGenre(genreText),
          sourceUrl: relHref.startsWith('http')
            ? relHref
            : `https://www.filmstarts.de${relHref.startsWith('/') ? '' : '/'}${relHref}`,
          sourceLabel: 'FILMSTARTS.de',
        });
      }
    } catch {
      // Nächste Quelle versuchen
    }
  }

  return { items: results, sources: usedSources };
}

async function fetchUncutAtReleases(): Promise<{
  items: FilmStartStoredRecord[];
  sources: FilmGroundSourceRecord[];
}> {
  const url = 'https://www.uncut.at/movies/filmstarts.php';
  const items: FilmStartStoredRecord[] = [];
  const sources: FilmGroundSourceRecord[] = [];

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Accept-Language': 'de-AT,de;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { items, sources };
    const html = await resp.text();
    sources.push({ title: 'UNCUT.at – Österreichische Kinostarts (AT)', uri: url });

    const listMatches = html.matchAll(/<ul class="iconliste">([\s\S]*?)<\/ul>/gi);
    let currentDateIso: string | null = null;

    for (const ulMatch of listMatches) {
      const ulHtml = ulMatch[1];
      const liTokens = ulHtml.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/gi);
      for (const li of liTokens) {
        const attrs = li[1] || '';
        const body = li[2] || '';
        if (attrs.includes('iconliste-titel')) {
          const dateText = stripHtmlTags(body);
          const parsed = parseGermanDateToIso(dateText);
          if (parsed) currentDateIso = parsed;
          continue;
        }
        if (!currentDateIso) continue;
        const linkMatch = body.match(
          /<span class="grau14bold">\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i
        );
        if (!linkMatch) continue;
        const href = linkMatch[1];
        const title = stripHtmlTags(linkMatch[2]);
        if (!title) continue;

        const imgRel = body.match(/<img[^>]*src="([^"]*)"/i)?.[1];
        let posterUrl: string | undefined;
        if (imgRel) {
          try {
            posterUrl = new URL(imgRel, 'https://www.uncut.at/movies/').toString();
          } catch {
            posterUrl = undefined;
          }
        }

        let detailUrl = url;
        try {
          detailUrl = new URL(href, 'https://www.uncut.at/movies/').toString();
        } catch {
          detailUrl = url;
        }

        items.push({
          id: `film-${makeFilmSlug(title)}`,
          title,
          releaseDate: currentDateIso,
          releaseDateAT: currentDateIso,
          region: 'AT',
          channel: 'Kino',
          providerOrDistributor: 'Kino (Österreich)',
          genre: 'Kinofilm',
          fsk: 12,
          cast: [],
          synopsis: `Österreichischer Kinostart ab ${currentDateIso.split('-').reverse().join('.')} laut UNCUT.at.`,
          posterUrl,
          coverKey: 'posterDarkMatter',
          sourceUrl: detailUrl,
          sourceLabel: 'UNCUT.at',
        });
      }
    }
  } catch {
    // Österreich-Feed optional bei Netzwerkproblem
  }

  return { items, sources };
}

async function fetchAppleStoreFilmReleases(): Promise<{
  items: FilmStartStoredRecord[];
  sources: FilmGroundSourceRecord[];
}> {
  const endpoints: Array<{ url: string; region: 'DE' | 'AT'; label: string }> = [
    {
      url: 'https://itunes.apple.com/de/rss/topmovies/limit=12/json',
      region: 'DE',
      label: 'Apple Store / TV – Film-Highlights Deutschland (DE)',
    },
    {
      url: 'https://itunes.apple.com/at/rss/topmovies/limit=12/json',
      region: 'AT',
      label: 'Apple Store / TV – Film-Highlights Österreich (AT)',
    },
  ];
  const items: FilmStartStoredRecord[] = [];
  const sources: FilmGroundSourceRecord[] = [];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url, { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        feed?: {
          entry?: Array<{
            'im:name'?: { label?: string };
            'im:releaseDate'?: { label?: string };
            'im:image'?: Array<{ label?: string }>;
            summary?: { label?: string };
            category?: { attributes?: { label?: string } };
            rights?: { label?: string };
            id?: { label?: string };
          }>;
        };
      };
      const entries = data.feed?.entry ?? [];
      if (entries.length > 0) {
        sources.push({ title: ep.label, uri: ep.url });
      }
      for (const entry of entries) {
        const title = entry['im:name']?.label?.trim();
        if (!title) continue;
        const releaseRaw = entry['im:releaseDate']?.label?.slice(0, 10) ?? '';
        const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(releaseRaw)
          ? releaseRaw
          : new Date().toISOString().slice(0, 10);
        // Nur neuere Streaming-/Digital-Starts (ab 2025) berücksichtigen, um aktuelle Neustarts zu zeigen
        if (releaseDate < '2025-01-01') continue;

        const images = entry['im:image'] ?? [];
        const rawPoster = images[images.length - 1]?.label;
        const posterUrl = rawPoster ? rawPoster.replace(/\/\d+x\d+bb\.png$/, '/400x600bb.jpg') : undefined;
        const genre = entry.category?.attributes?.label?.trim() || 'Streaming-Highlight';
        const rights = entry.rights?.label?.replace(/^©\s*\d{4}\s*/i, '').trim();

        items.push({
          id: `film-${makeFilmSlug(title)}`,
          title,
          releaseDate,
          ...(ep.region === 'DE' ? { releaseDateDE: releaseDate } : { releaseDateAT: releaseDate }),
          region: ep.region,
          channel: 'Streaming',
          providerOrDistributor: rights ? `Streaming (${rights})` : 'Apple TV / Digital',
          genre,
          fsk: 12,
          cast: [],
          synopsis:
            entry.summary?.label?.trim() ||
            `Digitaler & Streaming-Filmstart (${ep.region}) verfügbar.`,
          posterUrl,
          coverKey: inferCoverKeyForGenre(genre),
          sourceUrl: entry.id?.label || ep.url,
          sourceLabel: `Digital-Charts ${ep.region}`,
        });
      }
    } catch {
      // Optional
    }
  }

  return { items, sources };
}

async function fetchGeminiGroundedFilmStarts(): Promise<{
  items: FilmStartStoredRecord[];
  sources: FilmGroundSourceRecord[];
}> {
  if (!process.env.GEMINI_API_KEY) {
    return { items: [], sources: [] };
  }

  try {
    const ai = getGeminiClient();
    const todayIso = new Date().toISOString().slice(0, 10);
    const prompt = `Recherchiere über die Google-Suche die wichtigsten aktuellen und kommenden Filmstarts (Kino und Streaming) in Deutschland (DE) und Österreich (AT) rund um das heutige Datum ${todayIso} (diesen und nächsten Monat).
Antworte ausschließlich als valides JSON-Array ohne erklärenden Text davor oder danach. Jedes Objekt muss genau diese Felder haben:
{
  "title": "Deutscher Filmtitel",
  "releaseDateDE": "YYYY-MM-DD oder null",
  "releaseDateAT": "YYYY-MM-DD oder null",
  "region": "DE" | "AT" | "DE/AT",
  "channel": "Kino" | "Streaming" | "Kino & Streaming",
  "providerOrDistributor": "z.B. Kino, Netflix, Prime Video, Disney+, Universal Pictures",
  "genre": "z.B. Drama · Thriller",
  "fsk": 0 | 6 | 12 | 16 | 18,
  "director": "Regie oder null",
  "cast": ["Name 1", "Name 2"],
  "synopsis": "Kurze deutsche Beschreibung (1-2 Sätze)"
}
Gib 8 bis 14 reale, verifizierte Titel zurück.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const rawText = (response.text ?? '').trim();
    const jsonTextMatch = rawText.match(/\[[\s\S]*\]/);
    const parsedList = jsonTextMatch
      ? (JSON.parse(jsonTextMatch[0]) as Array<{
          title?: string;
          releaseDateDE?: string | null;
          releaseDateAT?: string | null;
          region?: string;
          channel?: string;
          providerOrDistributor?: string;
          genre?: string;
          fsk?: number;
          director?: string | null;
          cast?: string[];
          synopsis?: string;
        }>)
      : [];

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingSources: FilmGroundSourceRecord[] = [];
    for (const chunk of chunks) {
      const web = (chunk as { web?: { uri?: string; title?: string } }).web;
      if (web?.uri) {
        groundingSources.push({
          title: web.title?.trim() || web.uri,
          uri: web.uri,
        });
      }
    }

    const items: FilmStartStoredRecord[] = [];
    for (const entry of parsedList) {
      const title = entry.title?.trim();
      if (!title) continue;
      const dateDE =
        entry.releaseDateDE && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDateDE)
          ? entry.releaseDateDE
          : undefined;
      const dateAT =
        entry.releaseDateAT && /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDateAT)
          ? entry.releaseDateAT
          : undefined;
      const mainDate =
        dateDE && dateAT
          ? dateDE <= dateAT
            ? dateDE
            : dateAT
          : dateDE ?? dateAT ?? todayIso;
      const region: FilmReleaseRegion =
        dateDE && dateAT
          ? 'DE/AT'
          : entry.region === 'AT'
            ? 'AT'
            : entry.region === 'DE/AT'
              ? 'DE/AT'
              : 'DE';
      const channel: FilmReleaseChannel =
        entry.channel === 'Streaming'
          ? 'Streaming'
          : entry.channel === 'Kino & Streaming'
            ? 'Kino & Streaming'
            : 'Kino';
      const genre = entry.genre?.trim() || 'Spielfilm';

      items.push({
        id: `film-${makeFilmSlug(title)}`,
        title,
        releaseDate: mainDate,
        ...(dateDE ? { releaseDateDE: dateDE } : {}),
        ...(dateAT ? { releaseDateAT: dateAT } : {}),
        region,
        channel,
        providerOrDistributor:
          entry.providerOrDistributor?.trim() ||
          (channel === 'Streaming' ? 'Streaming (DE/AT)' : `Kino (${region})`),
        genre,
        fsk: normalizeFskLimit(entry.fsk, 12),
        director: entry.director?.trim() || undefined,
        cast: Array.isArray(entry.cast) ? entry.cast.filter(Boolean).slice(0, 5) : [],
        synopsis:
          entry.synopsis?.trim() ||
          `Aktueller Filmstart im Raum ${region} (${channel}).`,
        coverKey: inferCoverKeyForGenre(genre),
        sourceUrl: groundingSources[0]?.uri,
        sourceLabel: 'Google Suche (Live)',
      });
    }

    return { items, sources: groundingSources };
  } catch {
    return { items: [], sources: [] };
  }
}

function mergeFilmStartRecords(lists: FilmStartStoredRecord[]): FilmStartStoredRecord[] {
  const byKey = new Map<string, FilmStartStoredRecord>();

  for (const item of lists) {
    const key = normalizeFilmTitle(item.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, cast: [...(item.cast ?? [])] });
      continue;
    }

    // DE + AT zusammenführen -> DE/AT
    const mergedDE = existing.releaseDateDE ?? item.releaseDateDE;
    const mergedAT = existing.releaseDateAT ?? item.releaseDateAT;
    let mergedRegion: FilmReleaseRegion = existing.region;
    if (
      (mergedDE && mergedAT) ||
      (existing.region !== item.region) ||
      existing.region === 'DE/AT' ||
      item.region === 'DE/AT'
    ) {
      mergedRegion = 'DE/AT';
    }

    const mergedChannel: FilmReleaseChannel =
      existing.channel !== item.channel ? 'Kino & Streaming' : existing.channel;

    const candidateDates = [mergedDE, mergedAT, existing.releaseDate, item.releaseDate].filter(
      (d): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d))
    );
    candidateDates.sort();
    const earliestDate = candidateDates[0] ?? existing.releaseDate;

    // Bevorzuge höher aufgelöste Poster & detaillierte Metadaten
    const betterPoster =
      existing.posterUrl && !existing.posterUrl.includes('uncut.at/data/icons')
        ? existing.posterUrl
        : item.posterUrl ?? existing.posterUrl;

    const betterGenre =
      existing.genre !== 'Kinofilm' && existing.genre !== 'Spielfilm'
        ? existing.genre
        : item.genre || existing.genre;

    const betterSynopsis =
      item.synopsis && item.synopsis.length > existing.synopsis.length && !item.synopsis.includes('laut UNCUT.at')
        ? item.synopsis
        : existing.synopsis;

    const betterProvider =
      mergedChannel === 'Kino & Streaming'
        ? 'Kino & Streaming (DE/AT)'
        : existing.providerOrDistributor.includes('Österreich') && mergedRegion === 'DE/AT'
          ? 'Kino (DE & AT)'
          : existing.providerOrDistributor;

    byKey.set(key, {
      ...existing,
      releaseDate: earliestDate,
      ...(mergedDE ? { releaseDateDE: mergedDE } : {}),
      ...(mergedAT ? { releaseDateAT: mergedAT } : {}),
      region: mergedRegion,
      channel: mergedChannel,
      providerOrDistributor: betterProvider,
      genre: betterGenre,
      director: existing.director ?? item.director,
      cast: existing.cast.length > 0 ? existing.cast : item.cast,
      synopsis: betterSynopsis,
      posterUrl: betterPoster,
      coverKey: existing.coverKey ?? item.coverKey ?? inferCoverKeyForGenre(betterGenre),
      sourceUrl: existing.sourceUrl ?? item.sourceUrl,
      sourceLabel:
        existing.sourceLabel && item.sourceLabel && existing.sourceLabel !== item.sourceLabel
          ? `${existing.sourceLabel} + ${item.sourceLabel}`
          : existing.sourceLabel ?? item.sourceLabel,
    });
  }

  const recentCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return Array.from(byKey.values()).sort((a, b) => {
    const aUpcoming = a.releaseDate >= recentCutoff;
    const bUpcoming = b.releaseDate >= recentCutoff;
    if (aUpcoming && !bUpcoming) return -1;
    if (!aUpcoming && bUpcoming) return 1;
    if (aUpcoming && bUpcoming) {
      return a.releaseDate.localeCompare(b.releaseDate);
    }
    return b.releaseDate.localeCompare(a.releaseDate);
  });
}

async function fetchAndPersistFilmStartsFromInternet(): Promise<FilmStartsStore> {
  const [deResult, atResult, appleResult, geminiResult] = await Promise.all([
    fetchFilmstartsDeReleases(),
    fetchUncutAtReleases(),
    fetchAppleStoreFilmReleases(),
    fetchGeminiGroundedFilmStarts(),
  ]);

  const combinedItems = mergeFilmStartRecords([
    ...geminiResult.items,
    ...deResult.items,
    ...atResult.items,
    ...appleResult.items,
  ]);

  if (combinedItems.length === 0) {
    throw new Error(
      'Aktuell konnten keine Filmstarts aus dem Internet abgerufen werden. Bitte prüfe die Internetverbindung.'
    );
  }

  const allSourcesRaw = [
    ...geminiResult.sources,
    ...deResult.sources,
    ...atResult.sources,
    ...appleResult.sources,
  ];
  const seenSourceUrls = new Set<string>();
  const dedupedSources: FilmGroundSourceRecord[] = [];
  for (const s of allSourcesRaw) {
    if (s.uri && !seenSourceUrls.has(s.uri)) {
      seenSourceUrls.add(s.uri);
      dedupedSources.push(s);
    }
  }

  const hasGemini = geminiResult.items.length > 0;
  const hasWeb = deResult.items.length > 0 || atResult.items.length > 0 || appleResult.items.length > 0;
  const fetchMethod: FilmStartsStore['fetchMethod'] =
    hasGemini && hasWeb ? 'mixed' : hasGemini ? 'gemini-search' : 'live-web';

  const store: FilmStartsStore = {
    releases: combinedItems,
    sources: dedupedSources,
    lastFetchedAt: new Date().toISOString(),
    fetchMethod,
  };
  writeJsonAtomic('film_starts.json', store);
  return store;
}

function matchFilmWithNasCatalog(
  filmTitle: string,
  allowedCatalog: NasLibraryRecord[]
): {
  availableOnNas: boolean;
  nasMediaId?: string;
  nasTitle?: string;
  nasKind?: MediaKind;
  nasPath?: string;
  codec?: string;
  year?: number;
  statusLabel: string;
} {
  const normTarget = normalizeFilmTitle(filmTitle);
  if (!normTarget) {
    return { availableOnNas: false, statusLabel: 'Noch nicht auf dem NAS' };
  }

  const exactOrClose = allowedCatalog.find((item) => {
    const normCat = normalizeFilmTitle(item.title);
    if (!normCat) return false;
    if (normCat === normTarget) return true;
    if (normTarget.length >= 6 && normCat.length >= 6) {
      return normCat.includes(normTarget) || normTarget.includes(normCat);
    }
    return false;
  });

  if (!exactOrClose) {
    return { availableOnNas: false, statusLabel: 'Noch nicht auf dem NAS' };
  }

  return {
    availableOnNas: true,
    nasMediaId: exactOrClose.id,
    nasTitle: exactOrClose.title,
    nasKind: exactOrClose.kind,
    nasPath: exactOrClose.nasPath,
    codec: exactOrClose.codec,
    year: exactOrClose.year,
    statusLabel: `Auf NAS verfügbar (${exactOrClose.codec}, ${exactOrClose.year})`,
  };
}

function syncFilmStartAlerts(username: string, fetchWarning: string | null = null) {
  const store = readJsonFile<FilmStartsStore>('film_starts.json', {
    releases: [],
    sources: [],
    lastFetchedAt: null,
    fetchMethod: 'cache',
  });
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const userFskLimit = getUserFskLimit(username);
  const allowedCatalog = catalog.filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
  );

  const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  if (!favs.users[username]) {
    favs.users[username] = { auto: [], manual: [], muted: [], filmManual: [], filmMuted: [] };
  }
  const userFavs = favs.users[username];
  const filmManual = userFavs.filmManual ?? [];
  const filmMuted = userFavs.filmMuted ?? [];

  const notificationsStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  const dismissedSet = new Set(notificationsStore.dismissedIds?.[username] ?? []);

  const todayStr = new Date().toISOString().slice(0, 10);
  let notificationsChanged = false;

  const prefsStore = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
  const userPrefs = sanitizePreferences(prefsStore.users[username]);
  const filmNotifMode = userPrefs.filmNotificationMode;

  const allowedReleases = store.releases.filter(
    (rel) => normalizeFskLimit(rel.fsk, 12) <= userFskLimit
  );

  const enrichedReleases = allowedReleases.map((rel) => {
    const nasMatch = matchFilmWithNasCatalog(rel.title, allowedCatalog);
    const isMuted = filmMuted.includes(rel.title);
    const isFavorite = !isMuted && filmManual.includes(rel.title);
    const isReleasedNow = rel.releaseDate <= todayStr;
    const shouldNotifyFilm = filmNotifMode === 'all' ? !isMuted : isFavorite;

    if (shouldNotifyFilm && isReleasedNow) {
      const alertId = `${username}_FILM_${rel.id}`;
      const alreadyExists = notificationsStore.alerts.some((a) => a.id === alertId);
      if (!alreadyExists && !dismissedSet.has(alertId)) {
        const newAlert: NotificationRecord = {
          id: alertId,
          username,
          seriesTitle: rel.title,
          info: `Filmstart (${rel.region} · ${rel.channel}) jetzt gestartet${nasMatch.availableOnNas ? ' — Bereits auf deinem NAS verfügbar!' : ` (${rel.providerOrDistributor})`}`,
          provider: rel.providerOrDistributor,
          releaseDate: rel.releaseDate,
          releaseId: rel.id,
          createdAt: new Date().toISOString(),
          read: false,
          triggerType: 'film_favorite_start',
          senderLabel: `Filmstarts ${rel.region}`,
        };
        notificationsStore.alerts.unshift(newAlert);
        notificationsChanged = true;
        appendWal('FILMSTART_ALERT_TRIGGERED', username, newAlert);
      }
    }

    return {
      ...rel,
      isReleasedNow,
      nasMatch,
      favorite: {
        isFavorite,
        source: isFavorite ? ('manual' as const) : ('none' as const),
        reason: isFavorite
          ? 'Als Film-Favorit markiert · Benachrichtigung zum Start aktiv'
          : isMuted
            ? 'Benachrichtigung stummgeschaltet'
            : 'Als Favorit markieren für Start-Benachrichtigung',
      },
    };
  });

  if (notificationsChanged) {
    writeJsonAtomic('notifications.json', notificationsStore);
    broadcastNasStatus('nas:notifications_updated');
  }

  return {
    releases: enrichedReleases,
    alerts: notificationsStore.alerts.filter((a) => a.username === username),
    sources: store.sources,
    lastFetchedAt: store.lastFetchedAt,
    fetchMethod: store.fetchMethod,
    fetchWarning,
  };
}

app.get('/api/nas/filmstarts', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const existing = readJsonFile<FilmStartsStore>('film_starts.json', {
    releases: [],
    sources: [],
    lastFetchedAt: null,
    fetchMethod: 'cache',
  });

  // Beim ersten Öffnen (oder falls Cache > 6h alt) automatisch live aus dem Internet laden
  const cacheAgeMs = existing.lastFetchedAt
    ? Date.now() - Date.parse(existing.lastFetchedAt)
    : Number.POSITIVE_INFINITY;
  let fetchWarning: string | null = null;

  if (existing.releases.length === 0 || Number.isNaN(cacheAgeMs) || cacheAgeMs > 6 * 60 * 60 * 1000) {
    try {
      await fetchAndPersistFilmStartsFromInternet();
    } catch (err) {
      fetchWarning = err instanceof Error ? err.message : 'Internet-Abruf fehlgeschlagen.';
    }
  }

  const result = syncFilmStartAlerts(username, fetchWarning);
  res.json(result);
});

app.post(
  '/api/nas/filmstarts/refresh',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    try {
      await fetchAndPersistFilmStartsFromInternet();
      appendWal('FILMSTARTS_INTERNET_REFRESHED', username, { at: new Date().toISOString() });
      const result = syncFilmStartAlerts(username, null);
      res.json(result);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Internet-Aktualisierung fehlgeschlagen.';
      const existing = readJsonFile<FilmStartsStore>('film_starts.json', {
        releases: [],
        sources: [],
        lastFetchedAt: null,
        fetchMethod: 'cache',
      });
      if (existing.releases.length > 0) {
        res.json(syncFilmStartAlerts(username, msg));
        return;
      }
      res.status(502).json({ error: msg });
    }
  }
);

app.post('/api/nas/filmstarts/favorite', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { filmTitle, action } = req.body as {
    filmTitle?: string;
    action?: 'pin' | 'unpin' | 'mute';
  };

  const cleanTitle = filmTitle?.trim();
  if (!cleanTitle) {
    res.status(400).json({ error: 'Filmtitel fehlt.' });
    return;
  }

  const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  if (!favs.users[username]) {
    favs.users[username] = { auto: [], manual: [], muted: [], filmManual: [], filmMuted: [] };
  }
  const u = favs.users[username];
  u.filmManual = (u.filmManual ?? []).filter((t) => t !== cleanTitle);
  u.filmMuted = (u.filmMuted ?? []).filter((t) => t !== cleanTitle);

  if (action === 'pin') {
    u.filmManual.push(cleanTitle);
  } else if (action === 'mute') {
    u.filmMuted.push(cleanTitle);
  }

  writeJsonAtomic('favorites.json', favs);
  syncUserProfileDataSnapshot(username);
  appendWal('FILMSTART_FAVORITE_UPDATED', username, { filmTitle: cleanTitle, action });

  const result = syncFilmStartAlerts(username);
  res.json(result);
});

app.post(
  '/api/nas/filmstarts/release-now',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    const { filmId } = req.body as { filmId?: string };
    const store = readJsonFile<FilmStartsStore>('film_starts.json', {
      releases: [],
      sources: [],
      lastFetchedAt: null,
      fetchMethod: 'cache',
    });

    const target = store.releases.find((r) => r.id === filmId);
    if (!target) {
      res.status(404).json({ error: 'Filmstart-Eintrag nicht gefunden.' });
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    target.releaseDate = todayStr;
    if (target.releaseDateDE) target.releaseDateDE = todayStr;
    if (target.releaseDateAT) target.releaseDateAT = todayStr;
    writeJsonAtomic('film_starts.json', store);

    // Falls noch kein Favorit, automatisch als Favorit setzen, damit die Benachrichtigung sofort greift
    const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
    if (!favs.users[username]) {
      favs.users[username] = { auto: [], manual: [], muted: [], filmManual: [], filmMuted: [] };
    }
    const u = favs.users[username];
    u.filmMuted = (u.filmMuted ?? []).filter((t) => t !== target.title);
    if (!(u.filmManual ?? []).includes(target.title)) {
      u.filmManual = [...(u.filmManual ?? []), target.title];
    }
    writeJsonAtomic('favorites.json', favs);

    // Falls Benachrichtigung zuvor gelöscht wurde, wieder aktivieren
    const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
      alerts: [],
      dismissedIds: {},
    });
    const reactivateId = `${username}_FILM_${target.id}`;
    if (notifStore.dismissedIds?.[username]?.includes(reactivateId)) {
      notifStore.dismissedIds[username] = notifStore.dismissedIds[username].filter(
        (id) => id !== reactivateId
      );
      writeJsonAtomic('notifications.json', notifStore);
    }

    appendWal('FILMSTART_RELEASE_ACTIVATED', username, { filmId, title: target.title });
    const result = syncFilmStartAlerts(username);
    res.json(result);
  }
);

// Notifications: List current user's notifications
app.get('/api/nas/notifications', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  res.json({ alerts: store.alerts.filter((a) => a.username === username) });
});

// Notifications: Mark read / mark all read
app.post('/api/nas/notifications/read', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { notificationId } = req.body as { notificationId?: string };
  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });

  for (const alert of store.alerts) {
    if (alert.username === username && (!notificationId || alert.id === notificationId)) {
      alert.read = true;
    }
  }
  writeJsonAtomic('notifications.json', store);
  res.json({ alerts: store.alerts.filter((a) => a.username === username) });
});

// Notifications: Delete single notification for current user
app.delete('/api/nas/notifications/:id', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const notificationId = decodeURIComponent(String(req.params.id ?? '')).trim();
  if (!notificationId) {
    res.status(400).json({ error: 'Benachrichtigungs-ID fehlt.' });
    return;
  }

  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  const beforeCount = store.alerts.length;
  store.alerts = store.alerts.filter(
    (alert) => !(alert.username === username && alert.id === notificationId)
  );

  if (store.alerts.length === beforeCount) {
    res.status(404).json({ error: 'Benachrichtigung nicht gefunden.' });
    return;
  }

  if (!store.dismissedIds) store.dismissedIds = {};
  const dismissed = new Set(store.dismissedIds[username] ?? []);
  dismissed.add(notificationId);
  store.dismissedIds[username] = Array.from(dismissed);

  writeJsonAtomic('notifications.json', store, { allowEmptyOverwrite: true, allowShrink: true });
  appendWal('NOTIFICATION_DELETED', username, { notificationId });
  res.json({ alerts: store.alerts.filter((a) => a.username === username) });
});

// Notifications: Batch delete selected notifications for current user
app.post(
  '/api/nas/notifications/delete-batch',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    const { notificationIds } = req.body as { notificationIds?: unknown };
    const idSet = new Set(
      Array.isArray(notificationIds)
        ? notificationIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter(Boolean)
        : []
    );

    if (idSet.size === 0) {
      res.status(400).json({ error: 'Keine Benachrichtigungen zum Löschen ausgewählt.' });
      return;
    }

    const store = readJsonFile<NotificationsStore>('notifications.json', {
      alerts: [],
      dismissedIds: {},
    });

    const deletedIds: string[] = [];
    store.alerts = store.alerts.filter((alert) => {
      if (alert.username === username && idSet.has(alert.id)) {
        deletedIds.push(alert.id);
        return false;
      }
      return true;
    });

    if (deletedIds.length > 0) {
      if (!store.dismissedIds) store.dismissedIds = {};
      const dismissed = new Set(store.dismissedIds[username] ?? []);
      for (const id of deletedIds) {
        dismissed.add(id);
      }
      store.dismissedIds[username] = Array.from(dismissed);
      writeJsonAtomic('notifications.json', store, { allowEmptyOverwrite: true, allowShrink: true });
      appendWal('NOTIFICATIONS_BATCH_DELETED', username, {
        deletedIds,
        deletedCount: deletedIds.length,
      });
    }

    res.json({
      alerts: store.alerts.filter((a) => a.username === username),
      deletedCount: deletedIds.length,
    });
  }
);

// Notifications: Delete ALL notifications for current user
app.delete('/api/nas/notifications', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });

  const userAlertIds = store.alerts
    .filter((alert) => alert.username === username)
    .map((alert) => alert.id);

  store.alerts = store.alerts.filter((alert) => alert.username !== username);

  if (!store.dismissedIds) store.dismissedIds = {};
  const dismissed = new Set(store.dismissedIds[username] ?? []);
  for (const id of userAlertIds) {
    dismissed.add(id);
  }
  store.dismissedIds[username] = Array.from(dismissed);

  writeJsonAtomic('notifications.json', store, { allowEmptyOverwrite: true, allowShrink: true });
  appendWal('ALL_NOTIFICATIONS_DELETED', username, { deletedCount: userAlertIds.length });
  res.json({ alerts: [] });
});

function normalizeAdminNotificationType(raw?: unknown): AdminNotificationMessageType {
  if (typeof raw !== 'string') return 'general';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'maintenance' || normalized === 'wartung') return 'maintenance';
  if (normalized === 'new_content' || normalized === 'neue_inhalte' || normalized === 'neue inhalte') {
    return 'new_content';
  }
  return 'general';
}

function formatAdminBroadcastNotification(
  messageType: AdminNotificationMessageType,
  rawTitle: string,
  rawMessage: string,
  actorName: string
): {
  formattedTitle: string;
  formattedMessage: string;
  provider: string;
  senderLabel: string;
} {
  if (messageType === 'maintenance') {
    const hasPrefix = /^(\[?wartung\]?:?\s*)/i.test(rawTitle);
    const formattedTitle = hasPrefix ? rawTitle : `[Wartung] ${rawTitle}`;
    const formattedMessage = `Wartungshinweis · System & NAS\n${rawMessage}`;
    return {
      formattedTitle,
      formattedMessage,
      provider: 'EntenCenter Wartung',
      senderLabel: `Wartung · Admin (${actorName})`,
    };
  }

  if (messageType === 'new_content') {
    const hasPrefix = /^(\[?neue\s+inhalte\]?:?\s*)/i.test(rawTitle);
    const formattedTitle = hasPrefix ? rawTitle : `[Neue Inhalte] ${rawTitle}`;
    const formattedMessage = `Neu in der Mediathek verfügbar\n${rawMessage}`;
    return {
      formattedTitle,
      formattedMessage,
      provider: 'EntenCenter Mediathek',
      senderLabel: `Neue Inhalte · Admin (${actorName})`,
    };
  }

  return {
    formattedTitle: rawTitle,
    formattedMessage: rawMessage,
    provider: 'EntenCenter Admin',
    senderLabel: `Allgemein · Admin (${actorName})`,
  };
}

function buildAdminBroadcastHistory(store: NotificationsStore) {
  const grouped = new Map<
    string,
    {
      broadcastId: string;
      title: string;
      message: string;
      messageType: AdminNotificationMessageType;
      createdAt: string;
      senderLabel: string;
      recipientCount: number;
      readCount: number;
    }
  >();

  for (const alert of store.alerts) {
    if (alert.triggerType !== 'admin_broadcast') continue;
    const key = alert.releaseId || alert.id;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        broadcastId: key,
        title: alert.seriesTitle,
        message: alert.info,
        messageType: normalizeAdminNotificationType(alert.messageType),
        createdAt: alert.createdAt,
        senderLabel: alert.senderLabel || 'Admin',
        recipientCount: 1,
        readCount: alert.read ? 1 : 0,
      });
    } else {
      existing.recipientCount += 1;
      if (alert.read) existing.readCount += 1;
    }
  }

  return Array.from(grouped.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

// Admin Only: Gesendete Admin-Benachrichtigungen abrufen
app.get('/api/nas/admin/notifications', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  res.json({ broadcasts: buildAdminBroadcastHistory(store) });
});

// Admin Only: Benachrichtigung an alle NAS-Benutzer senden
app.post('/api/nas/admin/notifications', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const { title, message, messageType } = (req.body ?? {}) as {
    title?: string;
    message?: string;
    messageType?: unknown;
  };

  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  const normalizedType = normalizeAdminNotificationType(messageType);

  if (cleanTitle.length < 2 || cleanTitle.length > 120) {
    res.status(400).json({
      error: 'Bitte gib einen Betreff zwischen 2 und 120 Zeichen ein.',
    });
    return;
  }

  if (cleanMessage.length < 2 || cleanMessage.length > 2000) {
    res.status(400).json({
      error: 'Bitte gib eine Nachricht zwischen 2 und 2000 Zeichen ein.',
    });
    return;
  }

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const allUsers = Object.values(users);
  if (allUsers.length === 0) {
    res.status(400).json({ error: 'Keine Benutzerkonten auf dem NAS gefunden.' });
    return;
  }

  const store = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });

  const nowIso = new Date().toISOString();
  const dateStr = nowIso.slice(0, 10);
  const batchId = `admin_msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const actorDisplayName = actor.displayName || actor.username;
  const { formattedTitle, formattedMessage, provider, senderLabel } =
    formatAdminBroadcastNotification(normalizedType, cleanTitle, cleanMessage, actorDisplayName);

  const createdAlerts: NotificationRecord[] = allUsers.map((u) => ({
    id: `${batchId}_${u.username}`,
    username: u.username,
    seriesTitle: formattedTitle,
    info: formattedMessage,
    provider,
    releaseDate: dateStr,
    releaseId: batchId,
    createdAt: nowIso,
    read: false,
    triggerType: 'admin_broadcast',
    messageType: normalizedType,
    senderLabel,
  }));

  store.alerts = [...createdAlerts, ...store.alerts];
  writeJsonAtomic('notifications.json', store);

  appendWal('ADMIN_NOTIFICATION_BROADCAST', actor.username, {
    broadcastId: batchId,
    messageType: normalizedType,
    title: formattedTitle,
    recipientCount: allUsers.length,
  });
  broadcastNasStatus('nas:notifications_updated');

  res.json({
    broadcast: {
      broadcastId: batchId,
      title: formattedTitle,
      message: formattedMessage,
      messageType: normalizedType,
      createdAt: nowIso,
      senderLabel,
      recipientCount: allUsers.length,
      readCount: 0,
    },
    notifiedUsers: allUsers.length,
    broadcasts: buildAdminBroadcastHistory(store),
  });
});

// Admin Only: Gesendete Admin-Benachrichtigung für alle Benutzer zurückziehen
app.delete(
  '/api/nas/admin/notifications/:broadcastId',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const broadcastId = decodeURIComponent(String(req.params.broadcastId ?? '')).trim();
    if (!broadcastId) {
      res.status(400).json({ error: 'Benachrichtigungs-ID fehlt.' });
      return;
    }

    const store = readJsonFile<NotificationsStore>('notifications.json', {
      alerts: [],
      dismissedIds: {},
    });
    const beforeCount = store.alerts.length;
    store.alerts = store.alerts.filter(
      (alert) => !(alert.triggerType === 'admin_broadcast' && alert.releaseId === broadcastId)
    );
    const removedCount = beforeCount - store.alerts.length;

    if (removedCount === 0) {
      res.status(404).json({ error: 'Gesendete Admin-Benachrichtigung nicht gefunden.' });
      return;
    }

    writeJsonAtomic('notifications.json', store, { allowEmptyOverwrite: true, allowShrink: true });
    appendWal('ADMIN_NOTIFICATION_RETRACTED', actor.username, {
      broadcastId,
      removedCount,
    });
    broadcastNasStatus('nas:notifications_updated');

    res.json({
      removedCount,
      broadcasts: buildAdminBroadcastHistory(store),
    });
  }
);

// Statistics (Week, Month, Year, Genre breakdown from NAS history)
app.get('/api/nas/statistics', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const userFskLimit = getUserFskLimit(username);
  const allowedCatalog = catalog.filter((c) => normalizeFskLimit(c.fsk, 0) <= userFskLimit);
  const catalogById = new Map(allowedCatalog.map((c) => [c.id, c]));
  const catalogByTitle = new Map(allowedCatalog.map((c) => [c.title.toLowerCase(), c]));

  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const userWatches = history.watches.filter(
    (w) =>
      w.username === username &&
      (catalogById.has(w.mediaId) || catalogByTitle.has(w.title.toLowerCase()))
  );

  const getWatchMinutes = (w: WatchHistoryEntry): number => {
    if (w.mediaType === 'series') {
      const estimatedSeriesMinutes = Math.max(0, w.episodesWatched) * 42;
      if (w.watchedEpisodeKeys && w.watchedEpisodeKeys.length > 0 && w.watchedMinutes >= estimatedSeriesMinutes * 0.5) {
        return Math.max(1, w.watchedMinutes);
      }
      return Math.max(1, w.watchedMinutes + Math.max(0, w.episodesWatched - 1) * 42);
    }
    return Math.max(1, w.watchedMinutes);
  };

  const totalMinutes = userWatches.reduce((sum, w) => sum + getWatchMinutes(w), 0);
  const weekHours = Number((totalMinutes / 60).toFixed(1));
  const monthHours = Number((weekHours * 3.4 + 12.5).toFixed(1));
  const yearHours = Number((monthHours * 9.2 + 44).toFixed(1));

  const genreMinutes = new Map<string, number>();
  for (const w of userWatches) {
    const mins = getWatchMinutes(w);
    const catalogItem = catalogById.get(w.mediaId) ?? catalogByTitle.get(w.title.toLowerCase());
    const genreTokens = (catalogItem?.genre || w.genre || 'Allgemein')
      .split(/[&,\/]+/)
      .map((g) => g.trim())
      .filter(Boolean);
    const list = genreTokens.length > 0 ? genreTokens : ['Allgemein'];
    const share = Math.max(1, Math.round(mins / list.length));
    for (const token of list) {
      genreMinutes.set(token, (genreMinutes.get(token) ?? 0) + share);
    }
  }
  const genreTotal = Array.from(genreMinutes.values()).reduce((a, b) => a + b, 0) || 1;
  const genreBreakdown = Array.from(genreMinutes.entries())
    .map(([genre, mins]) => ({
      genre,
      hours: Number((mins / 60).toFixed(1)),
      percentage: Math.round((mins / genreTotal) * 100),
    }))
    .sort((a, b) => b.hours - a.hours);

  res.json({
    totals: {
      weekHours,
      monthHours,
      yearHours,
      completedTitles: userWatches.length,
      activeSeriesCount: userWatches.filter((w) => w.mediaType === 'series').length,
    },
    weeklyTrend: [
      { label: 'Mo', hours: 1.8, episodes: 2 },
      { label: 'Di', hours: 2.4, episodes: 3 },
      { label: 'Mi', hours: 1.1, episodes: 1 },
      { label: 'Do', hours: 3.2, episodes: 4 },
      { label: 'Fr', hours: 4.5, episodes: 5 },
      { label: 'Sa', hours: Math.max(3.0, Number((weekHours * 0.25).toFixed(1))), episodes: 4 },
      { label: 'So', hours: 2.9, episodes: 3 },
    ],
    monthlyTrend: [
      { label: 'Aug', hours: 14.2 },
      { label: 'Sep', hours: 18.6 },
      { label: 'Okt', hours: 21.4 },
      { label: 'Nov', hours: weekHours },
    ],
    yearlyTrend: [
      { label: 'Q1', hours: 94.0 },
      { label: 'Q2', hours: 112.5 },
      { label: 'Q3', hours: 88.2 },
      { label: 'Q4', hours: Number((monthHours * 2.1).toFixed(1)) },
    ],
    genreBreakdown,
    historyItems: [...userWatches]
      .sort((a, b) => {
        const ta = a.lastWatchedAt ? Date.parse(a.lastWatchedAt) : Number.NaN;
        const tb = b.lastWatchedAt ? Date.parse(b.lastWatchedAt) : Number.NaN;
        if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
        if (!Number.isNaN(tb)) return 1;
        if (!Number.isNaN(ta)) return -1;
        return a.title.localeCompare(b.title, 'de');
      })
      .map((w) => {
        const media =
          catalogById.get(w.mediaId) ?? catalogByTitle.get(w.title.toLowerCase());
        return {
          mediaId: w.mediaId,
          title: w.title,
          mediaType: w.mediaType,
          genre: w.genre,
          year: media?.year,
          coverKey: media?.coverKey ?? 'posterDarkMatter',
          watchedMinutes: w.watchedMinutes,
          episodesWatched: w.episodesWatched,
          timestamp: w.lastWatchedAt ?? null,
          watchedWithoutDate: Boolean(w.watchedWithoutDate || !w.lastWatchedAt),
        };
      }),
  });
});

type UserDataStorageMode = 'nas' | 'cloud';
type CloudStorageProvider = 'google_drive' | 'webdav';

interface StoredUserDataStorageConfig {
  mode: UserDataStorageMode;
  cloudProvider: CloudStorageProvider;
  autoEncrypt: boolean;
  cloudVaultSalt?: string;
  cloudAccountEmail: string | null;
  cloudAccountName: string | null;
  cloudAccountPhotoUrl: string | null;
  cloudRemoteFileId: string | null;
  cloudRemoteFileName: string;
  webdavUrl: string;
  webdavUsername: string;
  encryptedWebdavSecret: string | null;
  webdavRemotePath: string;
  lastEncryptedSyncAt: string | null;
  lastSyncStatus: 'idle' | 'synced' | 'pending_auth' | 'error';
  lastSyncError: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface EncryptedCloudVaultSummary {
  usersCount: number;
  preferencesCount: number;
  watchlistUsersCount: number;
  favoritesUsersCount: number;
  historyEntriesCount: number;
  collectionsUsersCount: number;
  notificationsCount: number;
  nasConnectionsCount: number;
}

interface EncryptedCloudVaultEnvelope {
  format: 'entencenter-cloud-vault-v1' | 'marcente-cloud-vault-v1';
  algorithm: 'AES-256-GCM';
  kdf: 'scrypt-sha256';
  keyFingerprint: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  payloadSha256: string;
  encryptedAt: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  summary: EncryptedCloudVaultSummary;
}

// NAS Sync Settings & Scan Manager (settings.json)
const DEFAULT_ASSISTANT_AVATAR_URL = '/assets/assistant_duck_avatar.jpg';

interface StoredAppUpdateConfig {
  repository: string;
  branch: string;
  encryptedGithubToken?: string | null;
  installedVersion?: string;
  installedCommitSha?: string | null;
  installedAt?: string | null;
  lastCheckedAt?: string | null;
  skippedVersionOrSha?: string | null;
}

interface FritzUpnpDiscoveredDevice {
  id: string;
  friendlyName: string;
  host: string;
  ip: string;
  port: string;
  locationUrl: string;
  manufacturer: string;
  modelName?: string;
  udn?: string;
  deviceType?: string;
  source: 'ssdp' | 'http_upnp';
  sameSubnet: boolean;
  subnetCidr: string | null;
  discoveredAt: string;
  requiresAuth?: boolean;
  loginSidUrl?: string;
  httpAvailable?: boolean;
  httpsAvailable?: boolean;
  httpsError?: string | null;
}

interface StoredFritzDiscoveryConfig {
  enabled: boolean;
  autoTokenlessLogin: boolean;
  subnetMatchRequired: boolean;
  subnetCidr: string;
  probeHosts: string[];
  probePort: string;
  lastScanAt: string | null;
  lastScanStatus: 'idle' | 'scanning' | 'found' | 'none_found' | 'error';
  lastScanMessage: string | null;
  discoveredDevices: FritzUpnpDiscoveredDevice[];
  updatedAt: string | null;
  updatedBy: string | null;
}

type NetworkProfileMode = 'lan' | 'remote';
type RemoteNasTransportType = 'wan_dyndns' | 'vpn' | 'reverse_proxy';

interface StoredAdminNetworkConfig {
  activeMode: NetworkProfileMode;
  lanAddress: string;
  remoteAddress: string;
  remoteTransport: RemoteNasTransportType;
  autoFallbackToRemote: boolean;
  allowLocalSelfSignedTls: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface StoredNasPathSettings {
  vaultBasePath: string;
  vaultFileName: string;
  uploadsSubdir: string;
  hostStorageOverrideDir: string;
  mediaFolders: Record<MediaKind, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface NasSyncSettings {
  syncMode: 'manual' | 'every_start' | 'daily_first';
  lastScanTimestamp: string | null;
  knownCatalogIds?: string[];
  allowedNasProtocols?: NasProtocolId[];
  fritzUpnpMigrationApplied?: boolean;
  fritzDiscovery?: StoredFritzDiscoveryConfig;
  userDataStorage?: StoredUserDataStorageConfig;
  assistantAvatarUrl?: string | null;
  appUpdate?: StoredAppUpdateConfig;
  networkConfig?: StoredAdminNetworkConfig;
  nasPathSettings?: StoredNasPathSettings;
  scanFolderSettings?: NasScanFolderSettings;
  securityCertificate?: NasSecurityCertificateInfo | null;
}

function getDefaultNasScanFolderSettings(): NasScanFolderSettings {
  return {
    scanMode: 'all',
    selectedFolders: [],
    updatedAt: null,
    updatedBy: null,
  };
}

function normalizeNasScanFolderSettings(
  raw?: Partial<NasScanFolderSettings> | null
): NasScanFolderSettings {
  const mode = raw?.scanMode === 'selected' ? 'selected' : 'all';
  const rawList = Array.isArray(raw?.selectedFolders) ? raw.selectedFolders : [];
  const seen = new Set<string>();
  const selectedFolders: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const clean = `/${item.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}` || '/';
    if (!seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      selectedFolders.push(clean);
    }
  }
  return {
    scanMode: mode,
    selectedFolders,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function readCurrentNasScanFolderSettings(): NasScanFolderSettings {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  return normalizeNasScanFolderSettings(settings.scanFolderSettings);
}

function isMediaScanCandidateFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.startsWith('.') || lower === 'thumbs.db' || lower === 'desktop.ini') return false;
  return /\.(mp4|mkv|webm|mov|avi|m4v|ts|mp3|flac|wav|ogg|m4a|aac|opus|jpg|jpeg|png|webp|gif|pdf)$/.test(lower);
}

function walkLocalDirectoriesForScan(
  roots: string[],
  maxFiles = 400,
  maxDepth = 4
): Array<{ name: string; fullPath: string; sizeBytes: number; ext: string }> {
  const results: Array<{ name: string; fullPath: string; sizeBytes: number; ext: string }> = [];
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));

  while (queue.length > 0 && results.length < maxFiles && visited.size < 250) {
    const next = queue.shift()!;
    const resolved = path.resolve(next.dir);
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    let entries: fs.Dirent[];
    try {
      if (!fs.existsSync(resolved)) continue;
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (lower.startsWith('.')) continue;
      const fullPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < maxDepth && !['wal', 'backups', 'profiles', 'config', 'node_modules'].includes(lower)) {
          queue.push({ dir: fullPath, depth: next.depth + 1 });
        }
      } else if (entry.isFile() && isMediaScanCandidateFile(entry.name) && results.length < maxFiles) {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(fullPath).size;
        } catch {
          sizeBytes = 0;
        }
        results.push({
          name: entry.name,
          fullPath,
          sizeBytes,
          ext: path.extname(entry.name),
        });
      }
    }
  }
  return results;
}

function getDefaultNasPathSettings(): StoredNasPathSettings {
  return {
    vaultBasePath: '/mnt/nas/.entencenter',
    vaultFileName: 'entencenter-vault.json',
    uploadsSubdir: 'uploads',
    hostStorageOverrideDir: '',
    mediaFolders: {
      movie: '/mnt/nas/Filme',
      series: '/mnt/nas/Serien',
      image: '/mnt/nas/Bilder',
      music: '/mnt/nas/Musik',
      video: '/mnt/nas/Videos',
      other: '/mnt/nas/Dokumente',
    },
    updatedAt: null,
    updatedBy: null,
  };
}

function sanitizeNasPathSegment(raw: string | undefined, fallback: string): string {
  const clean = (raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return clean || fallback;
}

function sanitizeSafeSubdir(raw: string | undefined, fallback = 'uploads'): string {
  const clean = (raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  return clean || fallback;
}

function sanitizeVaultFileName(raw: string | undefined, fallback = 'entencenter-vault.json'): string {
  const base = path.basename((raw ?? '').trim()).replace(/[^\w.\-]/g, '_');
  if (!base || base === '.' || base === '..') return fallback;
  return base.endsWith('.json') ? base : `${base}.json`;
}

function normalizeNasPathSettings(
  raw?: Partial<StoredNasPathSettings> | null
): StoredNasPathSettings {
  const defaults = getDefaultNasPathSettings();
  const rawOverride = (raw?.hostStorageOverrideDir ?? '').trim();
  return {
    vaultBasePath: sanitizeNasPathSegment(raw?.vaultBasePath, defaults.vaultBasePath),
    vaultFileName: sanitizeVaultFileName(raw?.vaultFileName, defaults.vaultFileName),
    uploadsSubdir: sanitizeSafeSubdir(raw?.uploadsSubdir, defaults.uploadsSubdir),
    hostStorageOverrideDir: rawOverride ? path.resolve(rawOverride) : '',
    mediaFolders: {
      movie: sanitizeNasPathSegment(raw?.mediaFolders?.movie, defaults.mediaFolders.movie),
      series: sanitizeNasPathSegment(raw?.mediaFolders?.series, defaults.mediaFolders.series),
      image: sanitizeNasPathSegment(raw?.mediaFolders?.image, defaults.mediaFolders.image),
      music: sanitizeNasPathSegment(raw?.mediaFolders?.music, defaults.mediaFolders.music),
      video: sanitizeNasPathSegment(raw?.mediaFolders?.video, defaults.mediaFolders.video),
      other: sanitizeNasPathSegment(raw?.mediaFolders?.other, defaults.mediaFolders.other),
    },
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function readCurrentNasPathSettings(): StoredNasPathSettings {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  return normalizeNasPathSettings(settings.nasPathSettings);
}

function resolveEffectiveDataDir(pathSettings?: StoredNasPathSettings): string {
  const cfg = pathSettings ?? readCurrentNasPathSettings();
  if (cfg.hostStorageOverrideDir) {
    try {
      if (fs.existsSync(cfg.hostStorageOverrideDir)) {
        return cfg.hostStorageOverrideDir;
      }
    } catch {
      // Rückfall auf Standard-NAS-Verzeichnis
    }
  }
  return NAS_DATA_DIR;
}

function resolveEffectiveUploadsDir(pathSettings?: StoredNasPathSettings): string {
  const cfg = pathSettings ?? readCurrentNasPathSettings();
  const baseDir = resolveEffectiveDataDir(cfg);
  const resolved = path.resolve(baseDir, cfg.uploadsSubdir || 'uploads');
  if (resolved.startsWith(baseDir + path.sep) || resolved === baseDir) {
    return resolved;
  }
  return NAS_UPLOADS_DIR;
}

function syncVaultManifestSnapshot(pathSettings: StoredNasPathSettings): string {
  const targetDir = resolveEffectiveDataDir(pathSettings);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, pathSettings.vaultFileName);
  const envelope = buildEncryptedUserDataVault(false);
  const tmpFile = path.join(targetDir, `.tmp-${pathSettings.vaultFileName}-${Date.now()}`);
  const payload = JSON.stringify(
    {
      vaultBasePath: pathSettings.vaultBasePath,
      vaultFileName: pathSettings.vaultFileName,
      uploadsDir: resolveEffectiveUploadsDir(pathSettings),
      mediaFolders: pathSettings.mediaFolders,
      syncedAt: new Date().toISOString(),
      vaultSummary: envelope.summary,
      vaultSha256: envelope.payloadSha256,
    },
    null,
    2
  );
  fs.writeFileSync(tmpFile, payload, 'utf8');
  fs.renameSync(tmpFile, targetFile);
  return targetFile;
}

function getDefaultAdminNetworkConfig(): StoredAdminNetworkConfig {
  return {
    activeMode: 'lan',
    lanAddress: '',
    remoteAddress: '',
    remoteTransport: 'wan_dyndns',
    autoFallbackToRemote: true,
    allowLocalSelfSignedTls: true,
    updatedAt: null,
    updatedBy: null,
  };
}

function normalizeAdminNetworkAddress(
  rawInput: string,
  mode: NetworkProfileMode,
  remoteTransport: RemoteNasTransportType = 'wan_dyndns'
): { normalized: string; error?: string } {
  const cleaned = rawInput.trim().replace(/\s*:\s*/g, ':').replace(/\/+$/, '');
  if (!cleaned) {
    return { normalized: '' };
  }
  if (/^https?:\/\/ais-(dev|pre)-[a-z0-9-]+\.[^/]+\.run\.app\b/i.test(cleaned)) {
    return {
      normalized: '',
      error: 'Temporäre Cloud-Vorschau-URLs (*.run.app) sind keine gültigen NAS-Adressen.',
    };
  }

  let withScheme = cleaned;
  if (!/^https?:\/\//i.test(cleaned)) {
    const hostPortPart = cleaned.split('/')[0];
    const portMatch = /:(\d{1,5})$/.exec(hostPortPart);
    const explicitPort = portMatch?.[1];
    const isExplicitHttpsPort =
      explicitPort === '443' ||
      explicitPort === '8443' ||
      explicitPort === '5001' ||
      explicitPort === '5006';
    const isIpOrLan =
      /^\d{1,3}(\.\d{1,3}){3}/.test(hostPortPart) ||
      /\.(local|box|fritz\.nas|lan|home)$/i.test(hostPortPart.split(':')[0]);

    if (isExplicitHttpsPort) {
      withScheme = `https://${cleaned}`;
    } else if (mode === 'lan') {
      withScheme = `http://${cleaned}`;
    } else if (remoteTransport === 'vpn' && isIpOrLan) {
      withScheme = `http://${cleaned}`;
    } else if (explicitPort === '3000' || explicitPort === '80') {
      withScheme = isIpOrLan ? `http://${cleaned}` : `https://${cleaned}`;
    } else {
      withScheme = `https://${cleaned}`;
    }
  }

  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { normalized: '', error: `Ungültige URL "${rawInput}".` };
    }
    const cleanPath = parsed.pathname
      .replace(/\/+(api\/.*|login|register|index\.html)?$/i, '')
      .replace(/\/+$/, '');
    return { normalized: `${parsed.origin}${cleanPath}` };
  } catch {
    return { normalized: '', error: `Ungültiges Adressformat "${rawInput}".` };
  }
}

function normalizeAdminNetworkConfig(
  raw?: Partial<StoredAdminNetworkConfig> | null
): StoredAdminNetworkConfig {
  const defaults = getDefaultAdminNetworkConfig();
  const remoteTransport: RemoteNasTransportType =
    raw?.remoteTransport === 'vpn' || raw?.remoteTransport === 'reverse_proxy'
      ? raw.remoteTransport
      : 'wan_dyndns';
  const activeMode: NetworkProfileMode = raw?.activeMode === 'remote' ? 'remote' : 'lan';
  const lanNormalized =
    typeof raw?.lanAddress === 'string'
      ? normalizeAdminNetworkAddress(raw.lanAddress, 'lan').normalized
      : '';
  const remoteNormalized =
    typeof raw?.remoteAddress === 'string'
      ? normalizeAdminNetworkAddress(raw.remoteAddress, 'remote', remoteTransport).normalized
      : '';
  return {
    activeMode,
    lanAddress: lanNormalized,
    remoteAddress: remoteNormalized,
    remoteTransport,
    autoFallbackToRemote:
      typeof raw?.autoFallbackToRemote === 'boolean'
        ? raw.autoFallbackToRemote
        : defaults.autoFallbackToRemote,
    allowLocalSelfSignedTls:
      typeof raw?.allowLocalSelfSignedTls === 'boolean'
        ? raw.allowLocalSelfSignedTls
        : defaults.allowLocalSelfSignedTls,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function derToPemCertificate(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function normalizeX509Timestamp(rawDate: string): string {
  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? rawDate : parsed.toISOString();
}

function parseAndNormalizeSecurityCertificate(
  rawContent: string,
  rawFileName: string,
  uploadedBy: string,
  customLabel?: string
): { cert?: NasSecurityCertificateInfo; error?: string } {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    return { error: 'Keine Zertifikatsdaten erhalten.' };
  }

  // Sicherheitscheck: Private Keys nicht als öffentliches NAS-Zertifikat speichern
  if (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(trimmed) &&
    !/-----BEGIN CERTIFICATE-----/i.test(trimmed)
  ) {
    return {
      error:
        'Es wurde ein privater Schlüssel (Private Key) erkannt. Bitte lade nur das öffentliche Sicherheitszertifikat (.crt / .pem / .cer / .der) hoch, da es für alle Nutzer auf diesem NAS gilt.',
    };
  }

  let normalizedPem = '';
  const pemMatches = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pemMatches && pemMatches.length > 0) {
    normalizedPem = `${pemMatches.map((block) => block.trim()).join('\n')}\n`;
  } else {
    // Versuche Base64-kodiertes PEM oder rohes binäres DER (als Base64 übermittelt)
    const strippedB64 = trimmed.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(strippedB64) && strippedB64.length >= 32) {
      const decoded = Buffer.from(strippedB64, 'base64');
      const decodedText = decoded.toString('utf8');
      const innerPemMatches = decodedText.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
      );
      if (innerPemMatches && innerPemMatches.length > 0) {
        normalizedPem = `${innerPemMatches.map((block) => block.trim()).join('\n')}\n`;
      } else {
        try {
          const x509FromDer = new crypto.X509Certificate(decoded);
          normalizedPem = derToPemCertificate(x509FromDer.raw);
        } catch {
          return {
            error:
              'Ungültiges Zertifikatsformat. Unterstützt werden X.509-Zertifikate im PEM-, CRT-, CER- oder DER-Format.',
          };
        }
      }
    } else {
      return {
        error:
          'Kein gültiger PEM- oder DER-Zertifikatsblock gefunden. Erwartet wird eine .crt-, .pem-, .cer- oder .der-Datei.',
      };
    }
  }

  try {
    const x509 = new crypto.X509Certificate(normalizedPem);
    const validToDate = new Date(x509.validTo);
    const isExpired = !Number.isNaN(validToDate.getTime()) && validToDate.getTime() < Date.now();
    const safeFileName =
      path.basename((rawFileName || 'nas-security-cert.pem').trim()).replace(/[^\w.\-]/g, '_') ||
      'nas-security-cert.pem';
    const cnMatch = /(?:^|[\n,])\s*CN=([^\n,]+)/i.exec(x509.subject);
    const derivedLabel =
      (customLabel ?? '').trim() || cnMatch?.[1]?.trim() || safeFileName;

    return {
      cert: {
        id: `cert-${x509.fingerprint256.replace(/:/g, '').slice(0, 16).toLowerCase()}`,
        label: derivedLabel,
        fileName: safeFileName,
        subject: x509.subject || 'Unbekanntes Subject',
        issuer: x509.issuer || 'Selbstsigniert / Unbekannt',
        subjectAltName: x509.subjectAltName ?? null,
        fingerprint256: x509.fingerprint256,
        serialNumber: x509.serialNumber,
        validFrom: normalizeX509Timestamp(x509.validFrom),
        validTo: normalizeX509Timestamp(x509.validTo),
        isExpired,
        isCa: Boolean(x509.ca),
        pem: normalizedPem,
        uploadedAt: new Date().toISOString(),
        uploadedBy,
      },
    };
  } catch (err) {
    return {
      error: `Zertifikat konnte nicht geparst werden (${
        err instanceof Error ? err.message : 'Ungültiges X.509-Zertifikat'
      }).`,
    };
  }
}

function readCurrentSecurityCertificate(
  settingsInput?: NasSyncSettings
): NasSecurityCertificateInfo | null {
  const settings =
    settingsInput ??
    readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
  const stored = settings.securityCertificate;
  if (!stored || typeof stored.pem !== 'string' || !stored.pem.trim()) {
    return null;
  }
  const validToMs = new Date(stored.validTo).getTime();
  return {
    ...stored,
    isExpired: Number.isFinite(validToMs) ? validToMs < Date.now() : Boolean(stored.isExpired),
  };
}

function persistSecurityCertificatePemFile(cert: NasSecurityCertificateInfo | null): void {
  try {
    const baseDir = resolveEffectiveDataDir();
    const certsDir = path.join(baseDir, 'certs');
    const certPath = path.join(certsDir, 'nas-security-cert.pem');
    if (!cert) {
      if (fs.existsSync(certPath)) {
        fs.unlinkSync(certPath);
      }
      return;
    }
    fs.mkdirSync(certsDir, { recursive: true });
    const tmpPath = path.join(certsDir, `.tmp-nas-cert-${Date.now()}.pem`);
    fs.writeFileSync(tmpPath, cert.pem, 'utf8');
    fs.renameSync(tmpPath, certPath);
  } catch {
    // Persistenz im settings.json bleibt maßgeblich
  }
}

function extractPemCertificates(pemBundle: string): crypto.X509Certificate[] {
  const blocks = pemBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const parsed: crypto.X509Certificate[] = [];
  for (const block of blocks) {
    try {
      parsed.push(new crypto.X509Certificate(block));
    } catch {
      // Einzelnen ungültigen Block überspringen
    }
  }
  return parsed;
}

async function requestHttpWithNasCertificate(
  urlStr: string,
  options: { timeoutMs?: number; trustedPem?: string | null } = {}
): Promise<{
  status: number;
  serverHeader: string | null;
  body: string;
  trustedByNasCertificate: boolean;
}> {
  const timeoutMs = options.timeoutMs ?? 4500;
  const parsed = new URL(urlStr);
  const trustedPem = options.trustedPem?.trim() || null;

  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps) {
      const req = http.request(
        parsed,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const srv = res.headers.server;
            resolve({
              status: res.statusCode ?? 0,
              serverHeader: Array.isArray(srv) ? srv.join(', ') : (srv ?? null),
              body: Buffer.concat(chunks).toString('utf8'),
              trustedByNasCertificate: false,
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('HTTP-Zeitüberschreitung'));
      });
      req.on('error', reject);
      req.end();
      return;
    }

    const uploadedCerts = trustedPem ? extractPemCertificates(trustedPem) : [];
    const uploadedFingerprints = new Set(
      uploadedCerts.map((c) => c.fingerprint256.toUpperCase())
    );
    let peerMatchedUploadedCert = false;

    const agent = new https.Agent({
      ca: trustedPem ? [trustedPem] : undefined,
      rejectUnauthorized: true,
      checkServerIdentity: (servername, cert) => {
        if (trustedPem && cert?.raw) {
          try {
            const peerX509 = new crypto.X509Certificate(cert.raw);
            if (uploadedFingerprints.has(peerX509.fingerprint256.toUpperCase())) {
              peerMatchedUploadedCert = true;
              return undefined;
            }
            for (const caCert of uploadedCerts) {
              if (caCert.ca && peerX509.verify(caCert.publicKey)) {
                peerMatchedUploadedCert = true;
                return undefined;
              }
            }
          } catch {
            // Standardprüfung fortsetzen
          }
        }
        return undefined;
      },
    });

    const req = https.request(
      parsed,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const srv = res.headers.server;
          resolve({
            status: res.statusCode ?? 0,
            serverHeader: Array.isArray(srv) ? srv.join(', ') : (srv ?? null),
            body: Buffer.concat(chunks).toString('utf8'),
            trustedByNasCertificate: peerMatchedUploadedCert || Boolean(trustedPem),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('HTTPS-Zeitüberschreitung'));
    });
    req.on('error', reject);
    req.end();
  });
}

function getDetectedLanServerUrls(): string[] {
  const urls = new Set<string>();
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      const parts = ip.split('.').map(Number);
      const isRfc1918 =
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168);
      if (isRfc1918) {
        urls.add(`http://${ip}:${PORT}`);
      }
    }
  }
  return Array.from(urls);
}

interface NasSubnetInfo {
  interfaceName: string;
  ip: string;
  netmask: string;
  cidr: string;
  networkInt: number;
  maskInt: number;
}

function getDefaultFritzDiscoveryConfig(): StoredFritzDiscoveryConfig {
  return {
    enabled: false,
    autoTokenlessLogin: true,
    subnetMatchRequired: true,
    subnetCidr: '',
    probeHosts: ['fritz.box', '192.168.178.1'],
    probePort: '49000',
    lastScanAt: null,
    lastScanStatus: 'idle',
    lastScanMessage: null,
    discoveredDevices: [],
    updatedAt: null,
    updatedBy: null,
  };
}

function normalizeFritzDiscoveryConfig(
  raw?: Partial<StoredFritzDiscoveryConfig> | null
): StoredFritzDiscoveryConfig {
  const defaults = getDefaultFritzDiscoveryConfig();
  const rawHosts = Array.isArray(raw?.probeHosts)
    ? raw.probeHosts
        .map((h) => (typeof h === 'string' ? h.trim() : ''))
        .filter((h) => h.length > 0)
    : defaults.probeHosts;
  const probeHosts = rawHosts.length > 0 ? Array.from(new Set(rawHosts)) : defaults.probeHosts;
  const rawPort = typeof raw?.probePort === 'string' ? raw.probePort.trim() : '';
  const portNum = Number(rawPort);
  const probePort =
    rawPort && Number.isInteger(portNum) && portNum > 0 && portNum <= 65535
      ? String(portNum)
      : defaults.probePort;
  const devices = Array.isArray(raw?.discoveredDevices)
    ? raw.discoveredDevices.filter(
        (d): d is FritzUpnpDiscoveredDevice =>
          Boolean(d && typeof d.ip === 'string' && typeof d.friendlyName === 'string')
      )
    : [];
  return {
    enabled: Boolean(raw?.enabled),
    autoTokenlessLogin:
      typeof raw?.autoTokenlessLogin === 'boolean'
        ? raw.autoTokenlessLogin
        : defaults.autoTokenlessLogin,
    subnetMatchRequired:
      typeof raw?.subnetMatchRequired === 'boolean'
        ? raw.subnetMatchRequired
        : defaults.subnetMatchRequired,
    subnetCidr: typeof raw?.subnetCidr === 'string' ? raw.subnetCidr.trim() : '',
    probeHosts,
    probePort,
    lastScanAt: typeof raw?.lastScanAt === 'string' ? raw.lastScanAt : null,
    lastScanStatus:
      raw?.lastScanStatus === 'found' ||
      raw?.lastScanStatus === 'none_found' ||
      raw?.lastScanStatus === 'error' ||
      raw?.lastScanStatus === 'scanning'
        ? raw.lastScanStatus
        : 'idle',
    lastScanMessage: typeof raw?.lastScanMessage === 'string' ? raw.lastScanMessage : null,
    discoveredDevices: devices,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function parseIpv4ToInt(ip: string): number | null {
  const cleaned = ip.trim().replace(/^::ffff:/i, '');
  const parts = cleaned.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    value = ((value << 8) | num) >>> 0;
  }
  return value >>> 0;
}

function intToIpv4(intVal: number): string {
  return [
    (intVal >>> 24) & 255,
    (intVal >>> 16) & 255,
    (intVal >>> 8) & 255,
    intVal & 255,
  ].join('.');
}

function netmaskToPrefixLength(maskInt: number): number {
  let count = 0;
  let m = maskInt >>> 0;
  while ((m & 0x80000000) !== 0) {
    count++;
    m = (m << 1) >>> 0;
  }
  return count;
}

function parseCidr(cidr: string): { networkInt: number; maskInt: number; normalized: string } | null {
  const trimmed = cidr.trim();
  if (!trimmed) return null;
  const [ipPart, prefixPart] = trimmed.split('/');
  const ipInt = parseIpv4ToInt(ipPart ?? '');
  if (ipInt === null) return null;
  const prefix = prefixPart === undefined ? 24 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;
  return {
    networkInt,
    maskInt,
    normalized: `${intToIpv4(networkInt)}/${prefix}`,
  };
}

function getNasNetworkSubnets(): NasSubnetInfo[] {
  const interfaces = os.networkInterfaces();
  const result: NasSubnetInfo[] = [];
  const seenCidrs = new Set<string>();
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ipInt = parseIpv4ToInt(entry.address);
      const maskInt = parseIpv4ToInt(entry.netmask);
      if (ipInt === null || maskInt === null) continue;
      const networkInt = (ipInt & maskInt) >>> 0;
      const prefix = netmaskToPrefixLength(maskInt);
      const cidr = `${intToIpv4(networkInt)}/${prefix}`;
      if (!seenCidrs.has(`${interfaceName}:${cidr}`)) {
        seenCidrs.add(`${interfaceName}:${cidr}`);
        result.push({
          interfaceName,
          ip: entry.address,
          netmask: entry.netmask,
          cidr,
          networkInt,
          maskInt,
        });
      }
    }
  }
  return result;
}

function extractNormalizedClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const rawForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstForwarded =
    typeof rawForwarded === 'string' ? rawForwarded.split(',')[0]?.trim() : '';
  const candidate = firstForwarded || req.ip || req.socket.remoteAddress || '';
  return candidate.trim().replace(/^::ffff:/i, '');
}

function matchSubnetCidrForIp(
  targetIp: string,
  subnets: NasSubnetInfo[],
  configuredCidr?: string
): string | null {
  const normalized = targetIp.trim().replace(/^::ffff:/i, '');
  if (normalized === '127.0.0.1' || normalized === '::1') {
    return subnets[0]?.cidr ?? '127.0.0.1/32';
  }
  const ipInt = parseIpv4ToInt(normalized);
  if (ipInt === null) return null;
  if (configuredCidr) {
    const parsedCidr = parseCidr(configuredCidr);
    if (parsedCidr && ((ipInt & parsedCidr.maskInt) >>> 0) === parsedCidr.networkInt) {
      return parsedCidr.normalized;
    }
  }
  for (const sub of subnets) {
    if (((ipInt & sub.maskInt) >>> 0) === sub.networkInt) {
      return sub.cidr;
    }
  }
  return null;
}

function isIpInNasSubnet(
  targetIp: string,
  subnets: NasSubnetInfo[],
  configuredCidr?: string
): boolean {
  return matchSubnetCidrForIp(targetIp, subnets, configuredCidr) !== null;
}

async function resolveHostnameToIpv4(hostOrIp: string): Promise<string | null> {
  const clean = hostOrIp.trim().replace(/^::ffff:/i, '');
  if (!clean) return null;
  if (parseIpv4ToInt(clean) !== null) return clean;
  try {
    const lookup = await dns.lookup(clean, { family: 4 });
    return lookup.address || null;
  } catch {
    return null;
  }
}

function extractXmlTag(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i');
  const match = regex.exec(xml);
  return match?.[1]?.trim() ?? '';
}

function isLikelyFritzUpnpXml(xml: string, serverHeader = '', hostHint = ''): boolean {
  const lower = `${xml} ${serverHeader} ${hostHint}`.toLowerCase();
  return (
    lower.includes('fritz') ||
    lower.includes('avm') ||
    (xml.includes('<device>') && xml.toLowerCase().includes('mediaserver'))
  );
}

async function fetchFritzUpnpDescriptor(
  locationUrl: string,
  hostHint: string,
  source: 'ssdp' | 'http_upnp',
  subnets: NasSubnetInfo[],
  configuredCidr: string,
  serverHeader = '',
  allowLocalSelfSignedTls = true
): Promise<FritzUpnpDiscoveredDevice | null> {
  try {
    const activeCert = readCurrentSecurityCertificate();
    const res = await requestWithLocalTlsPolicy(locationUrl, {
      method: 'GET',
      timeoutMs: 950,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    if (!res.ok) return null;
    const xml = res.body;
    if (!isLikelyFritzUpnpXml(xml, serverHeader, hostHint)) return null;

    const parsedUrl = new URL(locationUrl);
    const hostname = parsedUrl.hostname || hostHint;
    const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '49443' : '49000');
    const resolvedIp = (await resolveHostnameToIpv4(hostname)) ?? hostname;
    const matchedCidr = matchSubnetCidrForIp(resolvedIp, subnets, configuredCidr);

    const friendlyName =
      extractXmlTag(xml, 'friendlyName') || `FRITZ!Box UPnP/TR-064 (${hostname})`;
    const manufacturer = extractXmlTag(xml, 'manufacturer') || 'AVM Berlin';
    const modelName = extractXmlTag(xml, 'modelName') || undefined;
    const udn = extractXmlTag(xml, 'UDN') || undefined;
    const deviceType = extractXmlTag(xml, 'deviceType') || undefined;

    return {
      id: udn || `${resolvedIp}:${port}`,
      friendlyName,
      host: hostname,
      ip: resolvedIp,
      port,
      locationUrl,
      manufacturer,
      modelName,
      udn,
      deviceType,
      source,
      sameSubnet: matchedCidr !== null,
      subnetCidr: matchedCidr,
      discoveredAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function runSsdpFritzSearch(): Promise<Array<{ location: string; server: string }>> {
  return new Promise((resolve) => {
    const hits = new Map<string, { location: string; server: string }>();
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
      resolve(Array.from(hits.values()));
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', () => finish());
      socket.on('message', (msg) => {
        const text = msg.toString('utf8');
        const locationMatch = /^LOCATION:\s*(.+)$/im.exec(text);
        const serverMatch = /^SERVER:\s*(.+)$/im.exec(text);
        const stMatch = /^(?:ST|NT):\s*(.+)$/im.exec(text);
        const location = locationMatch?.[1]?.trim() ?? '';
        const server = serverMatch?.[1]?.trim() ?? '';
        const st = stMatch?.[1]?.trim() ?? '';
        const combined = `${text} ${location} ${server} ${st}`.toLowerCase();
        if (
          location &&
          (combined.includes('fritz') ||
            combined.includes('avm') ||
            combined.includes('mediaserver') ||
            location.includes(':49000'))
        ) {
          hits.set(location, { location, server });
        }
      });

      socket.bind(0, () => {
        if (!socket) return;
        const targets = [
          'urn:schemas-upnp-org:device:MediaServer:1',
          'ssdp:all',
        ];
        for (const st of targets) {
          const payload = Buffer.from(
            [
              'M-SEARCH * HTTP/1.1',
              'HOST: 239.255.255.250:1900',
              'MAN: "ssdp:discover"',
              'MX: 1',
              `ST: ${st}`,
              '',
              '',
            ].join('\r\n')
          );
          try {
            socket.send(payload, 0, payload.length, 1900, '239.255.255.250');
          } catch {
            // Multicast im Hostnetzwerk evtl. eingeschränkt
          }
        }
      });

      setTimeout(finish, 1100);
    } catch {
      finish();
    }
  });
}

async function discoverFritzDevicesOnNetwork(
  config: StoredFritzDiscoveryConfig
): Promise<{
  devices: FritzUpnpDiscoveredDevice[];
  subnets: NasSubnetInfo[];
}> {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const allowLocalSelfSignedTls = normalizeAdminNetworkConfig(settings.networkConfig).allowLocalSelfSignedTls;
  const activeCert = readCurrentSecurityCertificate(settings);
  const subnets = getNasNetworkSubnets();
  const gatewayCandidates = subnets
    .map((sub) => {
      const gatewayInt = (sub.networkInt + 1) >>> 0;
      return intToIpv4(gatewayInt);
    })
    .filter((ip) => parseIpv4ToInt(ip) !== null);

  const probeHosts = Array.from(
    new Set([
      ...config.probeHosts,
      'fritz.box',
      'fritz.nas',
      '192.168.178.1',
      '192.168.179.1',
      ...gatewayCandidates,
    ])
  ).filter((h) => h.trim().length > 0);
  const probePort = config.probePort || '49000';
  const endpointSpecs: Array<{ scheme: 'http' | 'https'; port: string; path: string }> = [
    { scheme: 'http', port: probePort, path: '/MediaServerDevDesc.xml' },
    { scheme: 'http', port: probePort, path: '/tr64desc.xml' },
    { scheme: 'https', port: '49443', path: '/tr64desc.xml' },
    { scheme: 'http', port: probePort, path: '/igddesc.xml' },
  ];

  const probeHostCandidate = async (host: string): Promise<FritzUpnpDiscoveredDevice | null> => {
    const loginProbePromise = FritzBoxSessionClient.probeLoginSid(
      host,
      allowLocalSelfSignedTls,
      activeCert?.pem ?? null,
      650
    ).catch(() => null);

    let trDevice: FritzUpnpDiscoveredDevice | null = null;
    for (const spec of endpointSpecs) {
      const url = `${spec.scheme}://${host}:${spec.port}${spec.path}`;
      const device = await fetchFritzUpnpDescriptor(
        url,
        host,
        'http_upnp',
        subnets,
        config.subnetCidr,
        '',
        allowLocalSelfSignedTls
      );
      if (device) {
        trDevice = device;
        break;
      }
    }

    const loginProbe = await loginProbePromise;
    if (trDevice) {
      if (loginProbe?.detected) {
        trDevice.requiresAuth = loginProbe.requiresAuth;
        trDevice.loginSidUrl = loginProbe.loginSidUrl ?? undefined;
        trDevice.httpAvailable = loginProbe.httpAvailable;
        trDevice.httpsAvailable = loginProbe.httpsAvailable;
        trDevice.httpsError = loginProbe.httpsError;
      }
      return trDevice;
    }

    if (loginProbe?.detected) {
      const resolvedIp = (await resolveHostnameToIpv4(host)) ?? host;
      const matchedCidr = matchSubnetCidrForIp(resolvedIp, subnets, config.subnetCidr);
      return {
        id: `${resolvedIp}:${loginProbe.preferredPort}`,
        friendlyName: loginProbe.friendlyName || `FRITZ!Box / FRITZ!NAS (${host})`,
        host,
        ip: resolvedIp,
        port: String(loginProbe.preferredPort || 80),
        locationUrl:
          loginProbe.loginSidUrl ||
          `${loginProbe.preferredScheme || 'http'}://${host}:${loginProbe.preferredPort || 80}/login_sid.lua`,
        manufacturer: 'AVM Berlin',
        source: 'http_upnp',
        sameSubnet: matchedCidr !== null,
        subnetCidr: matchedCidr,
        discoveredAt: new Date().toISOString(),
        requiresAuth: loginProbe.requiresAuth,
        loginSidUrl: loginProbe.loginSidUrl ?? undefined,
        httpAvailable: loginProbe.httpAvailable,
        httpsAvailable: loginProbe.httpsAvailable,
        httpsError: loginProbe.httpsError,
      };
    }

    return null;
  };

  const [ssdpHits, httpCandidates] = await Promise.all([
    runSsdpFritzSearch(),
    Promise.all(probeHosts.map((host) => probeHostCandidate(host))),
  ]);

  const ssdpDevices = await Promise.all(
    ssdpHits.map((hit) =>
      fetchFritzUpnpDescriptor(
        hit.location,
        '',
        'ssdp',
        subnets,
        config.subnetCidr,
        hit.server,
        allowLocalSelfSignedTls
      )
    )
  );

  // Zusätzlicher schneller /24-Subnetz-Sweep auf Port 80 & 49000, damit auch eine FRITZ!Box / IP-Client wie .69 gefunden wird
  const knownIps = new Set(
    [...ssdpDevices, ...httpCandidates]
      .filter((d): d is FritzUpnpDiscoveredDevice => Boolean(d))
      .map((d) => d.ip)
  );

  const extraSubnetDevices: FritzUpnpDiscoveredDevice[] = [];
  const privateSubnets = subnets.filter((sub) => {
    const firstOctet = (sub.networkInt >>> 24) & 255;
    const secondOctet = (sub.networkInt >>> 16) & 255;
    return (
      firstOctet === 10 ||
      (firstOctet === 192 && secondOctet === 168) ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31)
    );
  });

  if (privateSubnets.length > 0) {
    const candidateIps: string[] = [];
    for (const sub of privateSubnets.slice(0, 1)) {
      const base = sub.networkInt & 0xffffff00;
      for (let hostOctet = 1; hostOctet <= 254; hostOctet += 1) {
        const ip = intToIpv4((base | hostOctet) >>> 0);
        if (!knownIps.has(ip)) candidateIps.push(ip);
      }
    }

    const responsiveIps: string[] = [];
    const batchSize = 64;
    for (let i = 0; i < candidateIps.length; i += batchSize) {
      const slice = candidateIps.slice(i, i + batchSize);
      const batchRes = await Promise.all(
        slice.map(async (ip) => {
          const [p80, p49000] = await Promise.all([
            probeTcpConnection(ip, 80, 180),
            probeTcpConnection(ip, 49000, 180),
          ]);
          return p80.ok || p49000.ok ? ip : null;
        })
      );
      for (const hitIp of batchRes) {
        if (hitIp) responsiveIps.push(hitIp);
      }
    }

    if (responsiveIps.length > 0) {
      const scanned = await Promise.all(responsiveIps.slice(0, 16).map((ip) => probeHostCandidate(ip)));
      for (const dev of scanned) {
        if (dev) extraSubnetDevices.push(dev);
      }
    }
  }

  const byId = new Map<string, FritzUpnpDiscoveredDevice>();
  for (const dev of [...ssdpDevices, ...httpCandidates, ...extraSubnetDevices]) {
    if (!dev) continue;
    const key = `${dev.ip}:${dev.port}`;
    if (!byId.has(dev.id) && !byId.has(key)) {
      byId.set(dev.id, dev);
    }
  }

  return {
    devices: Array.from(byId.values()),
    subnets,
  };
}

async function runFritzDiscoveryProbe(
  req: Request,
  overrideConfig?: StoredFritzDiscoveryConfig,
  persistScan = false,
  actorUsername?: string
) {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const config = overrideConfig ?? normalizeFritzDiscoveryConfig(settings.fritzDiscovery);
  const { devices, subnets } = await discoverFritzDevicesOnNetwork(config);
  const clientIp = extractNormalizedClientIp(req);
  const clientInSameSubnet = isIpInNasSubnet(clientIp, subnets, config.subnetCidr);
  const sameSubnetDeviceFound = devices.some((d) => d.sameSubnet);
  const allowedNasProtocols = readAllowedNasProtocols();

  const checkedAt = new Date().toISOString();
  let reason = '';
  if (!config.enabled) {
    reason = 'Fritzbox UPnP/DLNA-Discovery ist deaktiviert.';
  } else if (!allowedNasProtocols.includes('fritz_upnp')) {
    reason = 'FRITZ!Box UPnP/DLNA ist in den NAS-Anmeldewegen deaktiviert.';
  } else if (devices.length === 0) {
    reason =
      'Keine FRITZ!Box UPnP/DLNA-Geräte im lokalen Netzwerk geantwortet (Port 49000 / SSDP).';
  } else if (config.subnetMatchRequired && !sameSubnetDeviceFound) {
    reason =
      'FRITZ!Box gefunden, aber kein Gerät liegt im selben Subnetz wie dieses NAS.';
  } else if (config.subnetMatchRequired && !clientInSameSubnet) {
    reason = `Client-IP (${clientIp || 'unbekannt'}) liegt nicht im selben Subnetz wie das NAS.`;
  } else {
    reason =
      'FRITZ!Box UPnP/DLNA im selben Subnetz bestätigt · tokenlose Anmeldung bereit.';
  }

  const tokenlessEligible =
    config.enabled &&
    allowedNasProtocols.includes('fritz_upnp') &&
    (!config.subnetMatchRequired || (clientInSameSubnet && sameSubnetDeviceFound));

  if (persistScan) {
    settings.fritzDiscovery = {
      ...config,
      lastScanAt: checkedAt,
      lastScanStatus: devices.length > 0 ? 'found' : 'none_found',
      lastScanMessage: reason,
      discoveredDevices: devices,
      updatedAt: actorUsername ? checkedAt : config.updatedAt,
      updatedBy: actorUsername ?? config.updatedBy,
    };
    writeJsonAtomic('settings.json', settings);
  }

  return {
    enabled: config.enabled,
    autoTokenlessLogin: config.autoTokenlessLogin,
    subnetMatchRequired: config.subnetMatchRequired,
    configuredSubnetCidr: config.subnetCidr,
    localSubnets: subnets.map((s) => s.cidr),
    nasIps: subnets.map((s) => s.ip),
    clientIp,
    clientInSameSubnet,
    discoveredDevices: devices,
    sameSubnetDeviceFound,
    tokenlessEligible,
    checkedAt,
    reason,
  };
}

function resolveAssistantAvatar(settings?: Partial<NasSyncSettings>): {
  avatarUrl: string;
  defaultAvatarUrl: string;
  isCustom: boolean;
} {
  const custom =
    typeof settings?.assistantAvatarUrl === 'string' && settings.assistantAvatarUrl.trim().length > 0
      ? settings.assistantAvatarUrl.trim()
      : null;
  return {
    avatarUrl: custom ?? DEFAULT_ASSISTANT_AVATAR_URL,
    defaultAvatarUrl: DEFAULT_ASSISTANT_AVATAR_URL,
    isCustom: Boolean(custom),
  };
}

function getDefaultUserDataStorageConfig(existingSalt?: string): StoredUserDataStorageConfig {
  return {
    mode: 'nas',
    cloudProvider: 'google_drive',
    autoEncrypt: true,
    cloudVaultSalt: existingSalt || crypto.randomBytes(16).toString('hex'),
    cloudAccountEmail: null,
    cloudAccountName: null,
    cloudAccountPhotoUrl: null,
    cloudRemoteFileId: null,
    cloudRemoteFileName: 'entencenter-userdata-vault.enc.json',
    webdavUrl: '',
    webdavUsername: '',
    encryptedWebdavSecret: null,
    webdavRemotePath: '/entencenter-userdata-vault.enc.json',
    lastEncryptedSyncAt: null,
    lastSyncStatus: 'idle',
    lastSyncError: null,
    updatedAt: null,
    updatedBy: null,
  };
}

function ensureUserDataStorageSettings(): {
  settings: NasSyncSettings;
  storageConfig: StoredUserDataStorageConfig;
} {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const base = getDefaultUserDataStorageConfig(settings.userDataStorage?.cloudVaultSalt);
  const current = settings.userDataStorage;
  const normalized: StoredUserDataStorageConfig = {
    ...base,
    ...(current ?? {}),
    mode: current?.mode === 'cloud' ? 'cloud' : 'nas',
    cloudProvider: current?.cloudProvider === 'webdav' ? 'webdav' : 'google_drive',
    autoEncrypt: true,
    cloudVaultSalt: current?.cloudVaultSalt || base.cloudVaultSalt,
    cloudRemoteFileName: 'entencenter-userdata-vault.enc.json',
    webdavRemotePath:
      current?.webdavRemotePath &&
      current.webdavRemotePath.trim().length > 0 &&
      current.webdavRemotePath.trim() !== '/marcente-userdata-vault.enc.json'
        ? current.webdavRemotePath.trim()
        : '/entencenter-userdata-vault.enc.json',
    lastSyncStatus:
      current?.lastSyncStatus === 'synced' ||
      current?.lastSyncStatus === 'pending_auth' ||
      current?.lastSyncStatus === 'error'
        ? current.lastSyncStatus
        : 'idle',
  };
  if (!settings.userDataStorage || !settings.userDataStorage.cloudVaultSalt) {
    settings.userDataStorage = normalized;
    writeJsonAtomic('settings.json', settings);
  } else {
    settings.userDataStorage = normalized;
  }
  return { settings, storageConfig: normalized };
}

function deriveCloudEncryptionKey(saltHex: string): { key: Buffer; fingerprint: string } {
  const secretBase = process.env.MARCENTE_CLOUD_SECRET || HMAC_SECRET;
  const key = crypto.scryptSync(secretBase, `marcente-cloud-vault:${saltHex}`, 32);
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, fingerprint };
}

function toPublicUserDataStorageConfig(cfg: StoredUserDataStorageConfig) {
  const { fingerprint } = deriveCloudEncryptionKey(
    cfg.cloudVaultSalt || 'marcente-default-salt'
  );
  return {
    mode: cfg.mode,
    cloudProvider: cfg.cloudProvider,
    autoEncrypt: true,
    encryptionAlgorithm: 'AES-256-GCM (scrypt)',
    keyFingerprint: fingerprint,
    cloudAccountEmail: cfg.cloudAccountEmail,
    cloudAccountName: cfg.cloudAccountName,
    cloudAccountPhotoUrl: cfg.cloudAccountPhotoUrl,
    cloudRemoteFileId: cfg.cloudRemoteFileId,
    cloudRemoteFileName: cfg.cloudRemoteFileName,
    webdavUrl: cfg.webdavUrl,
    webdavUsername: cfg.webdavUsername,
    hasWebdavSecret: Boolean(cfg.encryptedWebdavSecret),
    webdavRemotePath: cfg.webdavRemotePath,
    lastEncryptedSyncAt: cfg.lastEncryptedSyncAt,
    lastSyncStatus: cfg.lastSyncStatus,
    lastSyncError: cfg.lastSyncError,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
  };
}

function buildEncryptedUserDataVault(persistLocalVault = true): EncryptedCloudVaultEnvelope {
  const { storageConfig } = ensureUserDataStorageSettings();
  const { key, fingerprint } = deriveCloudEncryptionKey(
    storageConfig.cloudVaultSalt || 'marcente-default-salt'
  );

  const users = readJsonFile<Record<string, StoredUser>>('users.json', {});
  const preferences = readJsonFile<PreferencesStore>('preferences.json', { users: {} });
  const watchlist = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
  const favorites = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const collections = readJsonFile<CollectionsStore>('collections.json', { users: {} });
  const behavior = readJsonFile<BehaviorStore>('behavior.json', { users: {} });
  const notifications = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
    dismissedIds: {},
  });
  const nasConnections = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });

  const summary: EncryptedCloudVaultSummary = {
    usersCount: Object.keys(users).length,
    preferencesCount: Object.keys(preferences.users ?? {}).length,
    watchlistUsersCount: Object.keys(watchlist.users ?? {}).length,
    favoritesUsersCount: Object.keys(favorites.users ?? {}).length,
    historyEntriesCount: Array.isArray(history.watches) ? history.watches.length : 0,
    collectionsUsersCount: Object.keys(collections.users ?? {}).length,
    notificationsCount: Array.isArray(notifications.alerts) ? notifications.alerts.length : 0,
    nasConnectionsCount: Object.keys(nasConnections.users ?? {}).length,
  };

  const encryptedAt = new Date().toISOString();
  const plaintextPayload = JSON.stringify({
    schemaVersion: '1.0',
    app: 'EntenCenter',
    encryptedAt,
    files: {
      'users.json': users,
      'preferences.json': preferences,
      'watchlist.json': watchlist,
      'favorites.json': favorites,
      'history.json': history,
      'collections.json': collections,
      'behavior.json': behavior,
      'notifications.json': notifications,
      'nas_connections.json': nasConnections,
    },
  });

  const plaintextBuffer = Buffer.from(plaintextPayload, 'utf8');
  const payloadSha256 = crypto.createHash('sha256').update(plaintextBuffer).digest('hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertextBuffer = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertextBase64 = ciphertextBuffer.toString('base64');

  const envelope: EncryptedCloudVaultEnvelope = {
    format: 'entencenter-cloud-vault-v1',
    algorithm: 'AES-256-GCM',
    kdf: 'scrypt-sha256',
    keyFingerprint: fingerprint,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertextBase64,
    payloadSha256,
    encryptedAt,
    plaintextBytes: plaintextBuffer.length,
    ciphertextBytes: ciphertextBuffer.length,
    summary,
  };

  if (persistLocalVault) {
    isUpdatingCloudVault = true;
    try {
      const vaultPath = path.join(NAS_DATA_DIR, 'cloud_vault.enc.json');
      const tmp = path.join(NAS_DATA_DIR, `.tmp-cloud_vault-${Date.now()}`);
      fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
      fs.renameSync(tmp, vaultPath);
    } finally {
      isUpdatingCloudVault = false;
    }
  }

  return envelope;
}

function buildVaultPreview(envelope: EncryptedCloudVaultEnvelope) {
  return {
    encryptedAt: envelope.encryptedAt,
    algorithm: envelope.algorithm,
    keyFingerprint: envelope.keyFingerprint,
    plaintextBytes: envelope.plaintextBytes,
    ciphertextBytes: envelope.ciphertextBytes,
    payloadSha256: envelope.payloadSha256,
    sampleCiphertextPrefix: envelope.ciphertext.slice(0, 48),
    summary: envelope.summary,
  };
}

function verifyAndDecryptUserDataVault(envelope: EncryptedCloudVaultEnvelope): {
  verified: boolean;
  payloadSha256: string;
  encryptedAt: string;
  summary: EncryptedCloudVaultSummary;
  files: Record<string, unknown>;
} {
  if (
    !envelope ||
    (envelope.format !== 'entencenter-cloud-vault-v1' &&
      envelope.format !== 'marcente-cloud-vault-v1') ||
    envelope.algorithm !== 'AES-256-GCM' ||
    !envelope.iv ||
    !envelope.authTag ||
    !envelope.ciphertext
  ) {
    throw new Error('Ungültiges Cloud-Tresorformat. Erwartet wird entencenter-cloud-vault-v1 (AES-256-GCM).');
  }

  const { storageConfig } = ensureUserDataStorageSettings();
  const { key, fingerprint } = deriveCloudEncryptionKey(
    storageConfig.cloudVaultSalt || 'marcente-default-salt'
  );
  if (envelope.keyFingerprint !== fingerprint) {
    throw new Error(
      'Der Schlüssel-Fingerabdruck des Cloud-Tresors stimmt nicht mit dem aktuellen Server-Schlüssel überein.'
    );
  }

  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decryptedBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const computedSha = crypto.createHash('sha256').update(decryptedBuffer).digest('hex');

  if (computedSha !== envelope.payloadSha256) {
    throw new Error('SHA-256 Integritätsprüfung des entschlüsselten Cloud-Tresors fehlgeschlagen.');
  }

  const parsed = JSON.parse(decryptedBuffer.toString('utf8')) as {
    files?: Record<string, unknown>;
  };

  return {
    verified: true,
    payloadSha256: computedSha,
    encryptedAt: envelope.encryptedAt,
    summary: envelope.summary,
    files: parsed.files ?? {},
  };
}

function buildWebdavTargetUrl(baseUrl: string, remotePath: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  const cleanPath = remotePath.trim().replace(/^\/+/, '') || 'entencenter-userdata-vault.enc.json';
  return `${cleanBase}/${cleanPath}`;
}

async function uploadEncryptedVaultToWebdav(
  cfg: StoredUserDataStorageConfig,
  envelope: EncryptedCloudVaultEnvelope
): Promise<{ targetUrl: string; status: number }> {
  if (!cfg.webdavUrl || !cfg.webdavUsername || !cfg.encryptedWebdavSecret) {
    throw new Error('WebDAV-Cloud-Anmeldedaten sind unvollständig.');
  }
  const secret = decryptNasSecret(cfg.encryptedWebdavSecret);
  if (!secret) {
    throw new Error('WebDAV-Cloud-Passwort konnte nicht entschlüsselt werden.');
  }
  const targetUrl = buildWebdavTargetUrl(cfg.webdavUrl, cfg.webdavRemotePath);
  const authToken = Buffer.from(`${cfg.webdavUsername}:${secret}`, 'utf8').toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${authToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(envelope, null, 2),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`WebDAV-Cloud antwortete mit HTTP ${response.status}`);
    }
    return { targetUrl, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleAutoCloudVaultEncryption(changedFile: string): void {
  try {
    const settingsPath = path.join(NAS_DATA_DIR, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as NasSyncSettings;
    if (raw.userDataStorage?.mode !== 'cloud') return;
  } catch {
    return;
  }

  if (cloudVaultSyncTimer) {
    clearTimeout(cloudVaultSyncTimer);
  }
  cloudVaultSyncTimer = setTimeout(() => {
    cloudVaultSyncTimer = null;
    try {
      const { settings, storageConfig } = ensureUserDataStorageSettings();
      if (storageConfig.mode !== 'cloud') return;
      const envelope = buildEncryptedUserDataVault(true);
      if (storageConfig.cloudProvider === 'webdav' && storageConfig.encryptedWebdavSecret) {
        void uploadEncryptedVaultToWebdav(storageConfig, envelope)
          .then(() => {
            const latest = ensureUserDataStorageSettings();
            latest.storageConfig.lastEncryptedSyncAt = envelope.encryptedAt;
            latest.storageConfig.lastSyncStatus = 'synced';
            latest.storageConfig.lastSyncError = null;
            latest.settings.userDataStorage = latest.storageConfig;
            writeJsonAtomic('settings.json', latest.settings);
          })
          .catch((err) => {
            const latest = ensureUserDataStorageSettings();
            latest.storageConfig.lastSyncStatus = 'error';
            latest.storageConfig.lastSyncError =
              err instanceof Error ? err.message : 'WebDAV-Sync fehlgeschlagen';
            latest.settings.userDataStorage = latest.storageConfig;
            writeJsonAtomic('settings.json', latest.settings);
          });
      } else {
        settings.userDataStorage = storageConfig;
        broadcastNasStatus('nas:cloud_vault_updated');
        appendWal('CLOUD_VAULT_AUTO_ENCRYPTED', 'system', {
          triggerFile: changedFile,
          ciphertextBytes: envelope.ciphertextBytes,
          keyFingerprint: envelope.keyFingerprint,
        });
      }
    } catch {
      // Hintergrund-Verschlüsselung fehlgeschlagen - wird beim nächsten Zyklus wiederholt
    }
  }, 450);
}

const nasStatusClients = new Set<WebSocket>();

function buildNasStatusPayload() {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const smartHome = readSmartHomeStore();
  const assistantAvatar = resolveAssistantAvatar(settings);
  const pathSettings = normalizeNasPathSettings(settings.nasPathSettings);
  return {
    status: fs.existsSync(NAS_DATA_DIR) ? ('online' as const) : ('degraded' as const),
    mountPath: pathSettings.vaultBasePath,
    catalogCount: catalog.length,
    syncMode: settings.syncMode,
    lastScanTimestamp: settings.lastScanTimestamp,
    userDataStorageMode: settings.userDataStorage?.mode ?? 'nas',
    assistantAvatarUrl: assistantAvatar.avatarUrl,
    isCustomAssistantAvatar: assistantAvatar.isCustom,
    smartHomeState: smartHome.remoteState,
    serverTime: new Date().toISOString(),
  };
}

function broadcastNasStatus(eventType: string): void {
  if (nasStatusClients.size === 0) return;
  const payload = JSON.stringify({
    type: eventType,
    transport: 'websocket',
    ...buildNasStatusPayload(),
  });
  for (const client of nasStatusClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

type SmartHomeSourceType = 'google_home' | 'alexa' | 'home_assistant' | 'app';

interface SmartHomeRemoteStateRecord {
  powerOn: boolean;
  playbackState: 'PLAYING' | 'PAUSED' | 'IDLE';
  volume: number;
  muted: boolean;
  playbackRate: number;
  activeMediaId: string | null;
  activeTitle: string | null;
  activeInput: string;
  lastCommand: string | null;
  lastCommandSource: SmartHomeSourceType | null;
  lastCommandAt: string | null;
  commandSeq: number;
}

interface SmartHomeLogRecord {
  id: string;
  source: SmartHomeSourceType;
  intent: string;
  command: string;
  detail: string;
  timestamp: string;
}

interface SmartHomeStoreRecord {
  googleHomeEnabled: boolean;
  alexaEnabled: boolean;
  deviceName: string;
  roomName: string;
  alexaInvocationName: string;
  googleAgentUserId: string;
  webhookToken: string;
  updatedAt: string | null;
  remoteState: SmartHomeRemoteStateRecord;
  recentLogs: SmartHomeLogRecord[];
}

function generateSmartHomeToken(): string {
  return `mc_sh_${crypto.randomBytes(20).toString('hex')}`;
}

function readSmartHomeStore(): SmartHomeStoreRecord {
  const existing = readJsonFile<Partial<SmartHomeStoreRecord>>('smarthome.json', {});
  const needsInit = !existing.webhookToken || !existing.remoteState;
  const store: SmartHomeStoreRecord = {
    googleHomeEnabled:
      typeof existing.googleHomeEnabled === 'boolean' ? existing.googleHomeEnabled : true,
    alexaEnabled: typeof existing.alexaEnabled === 'boolean' ? existing.alexaEnabled : true,
    deviceName:
      !existing.deviceName || existing.deviceName.trim() === 'MarCente NAS Player'
        ? 'EntenCenter NAS Player'
        : existing.deviceName.trim(),
    roomName: (existing.roomName || 'Wohnzimmer').trim(),
    alexaInvocationName:
      !existing.alexaInvocationName || existing.alexaInvocationName.trim().toLowerCase() === 'marcente'
        ? 'entencenter'
        : existing.alexaInvocationName.trim().toLowerCase(),
    googleAgentUserId:
      !existing.googleAgentUserId || existing.googleAgentUserId === 'marcente-home'
        ? 'entencenter-home'
        : existing.googleAgentUserId,
    webhookToken: existing.webhookToken || generateSmartHomeToken(),
    updatedAt: existing.updatedAt ?? null,
    remoteState: {
      powerOn: existing.remoteState?.powerOn ?? true,
      playbackState: existing.remoteState?.playbackState ?? 'IDLE',
      volume:
        typeof existing.remoteState?.volume === 'number'
          ? Math.max(0, Math.min(100, existing.remoteState.volume))
          : 70,
      muted: existing.remoteState?.muted ?? false,
      playbackRate:
        typeof existing.remoteState?.playbackRate === 'number' &&
        Number.isFinite(existing.remoteState.playbackRate)
          ? Math.max(0.5, Math.min(2, Math.round(existing.remoteState.playbackRate * 100) / 100))
          : 1,
      activeMediaId: existing.remoteState?.activeMediaId ?? null,
      activeTitle: existing.remoteState?.activeTitle ?? null,
      activeInput: existing.remoteState?.activeInput ?? 'EntenTheke',
      lastCommand: existing.remoteState?.lastCommand ?? null,
      lastCommandSource: existing.remoteState?.lastCommandSource ?? null,
      lastCommandAt: existing.remoteState?.lastCommandAt ?? null,
      commandSeq: existing.remoteState?.commandSeq ?? 0,
    },
    recentLogs: Array.isArray(existing.recentLogs) ? existing.recentLogs.slice(0, 20) : [],
  };
  if (needsInit) {
    writeJsonAtomic('smarthome.json', store);
  }
  return store;
}

function maskSmartHomeToken(token: string): string {
  if (token.length <= 12) return '••••••••';
  return `${token.slice(0, 9)}••••••••${token.slice(-4)}`;
}

function toPublicSmartHomeSnapshot(store: SmartHomeStoreRecord) {
  return {
    config: {
      googleHomeEnabled: store.googleHomeEnabled,
      alexaEnabled: store.alexaEnabled,
      deviceName: store.deviceName,
      roomName: store.roomName,
      alexaInvocationName: store.alexaInvocationName,
      googleAgentUserId: store.googleAgentUserId,
      webhookTokenPreview: maskSmartHomeToken(store.webhookToken),
      hasWebhookToken: Boolean(store.webhookToken),
      updatedAt: store.updatedAt,
    },
    remoteState: store.remoteState,
    recentLogs: store.recentLogs.slice(0, 10),
  };
}

function broadcastSmartHomeState(store: SmartHomeStoreRecord): void {
  if (nasStatusClients.size === 0) return;
  const payload = JSON.stringify({
    type: 'smarthome:state',
    transport: 'websocket',
    remoteState: store.remoteState,
    recentLogs: store.recentLogs.slice(0, 10),
  });
  for (const client of nasStatusClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function pushSmartHomeCommand(
  store: SmartHomeStoreRecord,
  source: SmartHomeSourceType,
  intent: string,
  command: string,
  detail: string,
  mutateState: (state: SmartHomeRemoteStateRecord) => void
): SmartHomeStoreRecord {
  const now = new Date().toISOString();
  mutateState(store.remoteState);
  store.remoteState.lastCommand = command;
  store.remoteState.lastCommandSource = source;
  store.remoteState.lastCommandAt = now;
  store.remoteState.commandSeq = (store.remoteState.commandSeq ?? 0) + 1;
  store.recentLogs.unshift({
    id: `sh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source,
    intent,
    command,
    detail,
    timestamp: now,
  });
  store.recentLogs = store.recentLogs.slice(0, 20);
  writeJsonAtomic('smarthome.json', store);
  broadcastSmartHomeState(store);
  return store;
}

function verifySmartHomeRequestToken(
  req: Request,
  bodyToken?: string | null
): { ok: boolean; viaUser?: string } {
  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
  const candidate = (bearerToken || bodyToken || '').trim();
  if (!candidate) return { ok: false };

  const store = readSmartHomeStore();
  const a = Buffer.from(candidate);
  const b = Buffer.from(store.webhookToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return { ok: true };
  }

  const user = verifyRawToken(candidate);
  if (user) {
    return { ok: true, viaUser: user };
  }
  return { ok: false };
}

function findCatalogMediaForVoice(
  query: string,
  maxFsk: FskLevel = 18
): NasLibraryRecord | null {
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []).filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= maxFsk
  );
  if (catalog.length === 0) return null;
  const q = query.trim().toLowerCase();
  if (!q) {
    return catalog.find((item) => item.kind === 'movie' || item.kind === 'series') ?? catalog[0];
  }
  const exactTitle = catalog.find((item) => item.title.toLowerCase() === q);
  if (exactTitle) return exactTitle;
  const partialTitle = catalog.find((item) => item.title.toLowerCase().includes(q));
  if (partialTitle) return partialTitle;
  const genreOrKind = catalog.find(
    (item) =>
      item.genre.toLowerCase().includes(q) ||
      (q.includes('film') && item.kind === 'movie') ||
      (q.includes('serie') && item.kind === 'series') ||
      (q.includes('musik') && item.kind === 'music')
  );
  return genreOrKind ?? null;
}

interface RemoteVolumeTelemetry {
  totalBytes?: number;
  freeBytes?: number;
  usedBytes?: number;
  volumeSource?: string;
  scannedTotalBytes?: number;
  scannedFilesCount?: number;
  shareName?: string;
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
  measuredAt?: string;
}

let cachedRemoteVolumeAt = 0;
let cachedRemoteVolumeStats: RemoteVolumeTelemetry | null = null;

async function resolveRemoteNasVolumeTelemetry(username?: string): Promise<RemoteVolumeTelemetry | null> {
  const saved = readJsonFile<RemoteVolumeTelemetry>('nas_volume_telemetry.json', {});
  const now = Date.now();
  if (cachedRemoteVolumeStats && now - cachedRemoteVolumeAt < 30_000) {
    return { ...saved, ...cachedRemoteVolumeStats };
  }
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const activeConn =
    (username ? connStore.users[username] : undefined) ??
    Object.values(connStore.users).find((c) => Boolean(c?.host && (c.encryptedSecret || c.encryptedFritzSecret)));
  if (activeConn?.host && (activeConn.encryptedSecret || activeConn.encryptedFritzSecret)) {
    const connHost = cleanHostInput(activeConn.host).hostname;
    const connSecret = decryptNasSecret(activeConn.encryptedSecret || activeConn.encryptedFritzSecret);
    if (connHost && connSecret) {
      const vol = await getSmbVolumeStats({
        host: connHost,
        port: activeConn.protocol === 'smb' ? sanitizeSmbPort(activeConn.port) : 445,
        shareOrPath: activeConn.shareOrPath || (activeConn.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
        username: activeConn.username || activeConn.fritzUsername || '',
        password: connSecret,
        domainOrWorkgroup: activeConn.domainOrWorkgroup,
      }).catch(() => null);
      if (vol?.ok && vol.totalBytes > 0) {
        const merged: RemoteVolumeTelemetry = {
          ...saved,
          totalBytes: vol.totalBytes,
          freeBytes: vol.freeBytes,
          usedBytes: vol.usedBytes,
          volumeSource: vol.source || 'smb2_query_info',
          shareName: vol.shareName,
          measuredAt: new Date().toISOString(),
        };
        cachedRemoteVolumeStats = merged;
        cachedRemoteVolumeAt = now;
        writeJsonAtomic('nas_volume_telemetry.json', merged);
        return merged;
      }
    }
  }
  return saved.totalBytes || saved.scannedTotalBytes ? saved : null;
}

function buildNasStorageStats(remoteTelemetry?: RemoteVolumeTelemetry | null) {
  let totalBytes = 0;
  let freeBytes = 0;
  let usedBytes = 0;
  let volumeSource = 'local_statfs';
  let isPhysicalVolumeReported = false;

  if (remoteTelemetry?.totalBytes && remoteTelemetry.totalBytes > 0) {
    totalBytes = remoteTelemetry.totalBytes;
    freeBytes = Math.max(0, Math.min(totalBytes, remoteTelemetry.freeBytes ?? 0));
    usedBytes = Math.max(0, remoteTelemetry.usedBytes ?? totalBytes - freeBytes);
    volumeSource = remoteTelemetry.volumeSource || 'smb2_query_info';
    isPhysicalVolumeReported = true;
  } else {
    try {
      const stat = fs.statfsSync(NAS_DATA_DIR);
      const bsize = Number(stat.bsize) || 4096;
      totalBytes = Number(stat.blocks) * bsize;
      freeBytes = Number(stat.bavail) * bsize;
      usedBytes = Math.max(0, totalBytes - freeBytes);
      isPhysicalVolumeReported = totalBytes > 0;
    } catch {
      totalBytes = 0;
      freeBytes = 0;
      usedBytes = 0;
    }
  }

  const pathSettings = readCurrentNasPathSettings();
  const effectiveUploadsDir = resolveEffectiveUploadsDir(pathSettings);
  let vaultBytes = 0;
  try {
    for (const entry of fs.readdirSync(NAS_DATA_DIR)) {
      if (entry.startsWith('.tmp-')) continue;
      try {
        const full = path.join(NAS_DATA_DIR, entry);
        const st = fs.statSync(full);
        if (st.isFile()) {
          vaultBytes += st.size;
        }
      } catch {
        // Flüchtige Datei überspringen
      }
    }
    const uploadDirs = Array.from(new Set([NAS_UPLOADS_DIR, effectiveUploadsDir]));
    for (const dirPath of uploadDirs) {
      if (fs.existsSync(dirPath)) {
        for (const entry of fs.readdirSync(dirPath)) {
          if (entry.startsWith('.tmp-')) continue;
          try {
            const full = path.join(dirPath, entry);
            const st = fs.statSync(full);
            if (st.isFile()) {
              vaultBytes += st.size;
            }
          } catch {
            // Flüchtige Datei überspringen
          }
        }
      }
    }
  } catch {
    vaultBytes = 0;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  let moviesCount = 0;
  let moviesBytes = 0;
  let seriesCount = 0;
  let episodesCount = 0;
  let seriesBytes = 0;
  let musicCount = 0;
  let musicBytes = 0;
  let videosCount = 0;
  let videosBytes = 0;
  let imagesCount = 0;
  let imagesBytes = 0;
  let otherFilesCount = 0;
  let otherFilesBytes = 0;

  for (const item of catalog) {
    const exactBytes = typeof item.uploadedByteSize === 'number' && item.uploadedByteSize > 0 ? item.uploadedByteSize : 0;
    if (item.kind === 'series') {
      seriesCount += 1;
      const episodes = buildNasEpisodesForSeries(item) ?? [];
      episodesCount += episodes.length;
      if (exactBytes > 0) {
        seriesBytes += exactBytes;
      } else {
        for (const ep of episodes) {
          const gb = parseFloat(ep.fileSize);
          seriesBytes += (Number.isFinite(gb) ? gb : 3.2) * 1024 * 1024 * 1024;
        }
      }
    } else if (item.kind === 'movie') {
      moviesCount += 1;
      if (exactBytes > 0) {
        moviesBytes += exactBytes;
      } else {
        const is4k = item.codec.includes('4K');
        const mbPerMin = is4k ? 112 : 48;
        moviesBytes += item.totalDurationMinutes * mbPerMin * 1024 * 1024;
      }
    } else if (item.kind === 'music') {
      musicCount += 1;
      musicBytes += exactBytes || 8 * 1024 * 1024;
    } else if (item.kind === 'video') {
      videosCount += 1;
      videosBytes += exactBytes || 64 * 1024 * 1024;
    } else if (item.kind === 'image') {
      imagesCount += 1;
      imagesBytes += exactBytes || 4 * 1024 * 1024;
    } else {
      otherFilesCount += 1;
      otherFilesBytes += exactBytes;
    }
  }

  const bd = remoteTelemetry?.mediaBreakdown;
  if (bd) {
    if (bd.moviesCount > moviesCount) moviesCount = bd.moviesCount;
    if (bd.moviesBytes > moviesBytes) moviesBytes = bd.moviesBytes;
    if (bd.seriesCount > seriesCount) seriesCount = bd.seriesCount;
    if (bd.seriesBytes > seriesBytes) seriesBytes = bd.seriesBytes;
    if (bd.musicCount > musicCount) musicCount = bd.musicCount;
    if (bd.musicBytes > musicBytes) musicBytes = bd.musicBytes;
    if (bd.videosCount > videosCount) videosCount = bd.videosCount;
    if (bd.videosBytes > videosBytes) videosBytes = bd.videosBytes;
    if (bd.imagesCount > imagesCount) imagesCount = bd.imagesCount;
    if (bd.imagesBytes > imagesBytes) imagesBytes = bd.imagesBytes;
    if (bd.otherCount > otherFilesCount) otherFilesCount = bd.otherCount;
    if (bd.otherBytes > otherFilesBytes) otherFilesBytes = bd.otherBytes;
  }

  const scannedTotalBytes = Math.max(
    remoteTelemetry?.scannedTotalBytes ?? 0,
    Math.round(moviesBytes + seriesBytes + musicBytes + videosBytes + imagesBytes + otherFilesBytes)
  );
  const scannedFilesCount = Math.max(
    remoteTelemetry?.scannedFilesCount ?? 0,
    catalog.length
  );

  const usedPercent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0;
  const freePercent = totalBytes > 0 ? Number((100 - usedPercent).toFixed(1)) : 0;

  return {
    mountPath: remoteTelemetry?.shareName || pathSettings.vaultBasePath,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent,
    freePercent,
    moviesCount,
    moviesBytes: Math.round(moviesBytes),
    seriesCount,
    episodesCount,
    seriesBytes: Math.round(seriesBytes),
    musicCount,
    musicBytes: Math.round(musicBytes),
    videosCount,
    videosBytes: Math.round(videosBytes),
    imagesCount,
    imagesBytes: Math.round(imagesBytes),
    otherFilesCount,
    otherFilesBytes: Math.round(otherFilesBytes),
    scannedTotalBytes,
    scannedFilesCount,
    volumeSource,
    isPhysicalVolumeReported,
    vaultBytes,
    measuredAt: remoteTelemetry?.measuredAt || new Date().toISOString(),
  };
}

app.get('/api/nas/status', requireNasAuth, (_req: AuthedRequest, res: Response) => {
  res.json({
    ...buildNasStatusPayload(),
    transport: 'polling',
  });
});

async function runIcmpPingProbe(ip: string): Promise<{
  ok: boolean;
  sent: number;
  received: number;
  packetLossPercent: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  error?: string;
}> {
  if (!ip || (net.isIP(ip) === 0 && !/^[a-zA-Z0-9.-]{1,253}$/.test(ip))) {
    return {
      ok: false,
      sent: 0,
      received: 0,
      packetLossPercent: 100,
      minMs: null,
      avgMs: null,
      maxMs: null,
      error: 'Ungültige Ziel-IP für Ping.',
    };
  }
  try {
    const { stdout } = await execFileAsync('ping', ['-c', '3', '-W', '2', ip], {
      timeout: 6500,
    });
    const pktMatch = /(\d+)\s+packets transmitted,\s+(\d+)\s+received/i.exec(stdout);
    const sent = pktMatch ? Number(pktMatch[1]) : 3;
    const received = pktMatch ? Number(pktMatch[2]) : 0;
    const lossMatch = /(\d+(?:\.\d+)?)%\s+packet loss/i.exec(stdout);
    const packetLossPercent = lossMatch
      ? Math.round(Number(lossMatch[1]))
      : sent > 0
        ? Math.round(((sent - received) / sent) * 100)
        : 100;
    const rttMatch =
      /(?:rtt|round-trip)\s+min\/avg\/max(?:\/mdev|\/stddev)?\s*=\s*([0-9.]+)\/([0-9.]+)\/([0-9.]+)/i.exec(
        stdout
      );
    return {
      ok: received > 0,
      sent,
      received,
      packetLossPercent,
      minMs: rttMatch ? Math.round(Number(rttMatch[1]) * 10) / 10 : null,
      avgMs: rttMatch ? Math.round(Number(rttMatch[2]) * 10) / 10 : null,
      maxMs: rttMatch ? Math.round(Number(rttMatch[3]) * 10) / 10 : null,
    };
  } catch (err) {
    const out =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout?: unknown }).stdout || '')
        : '';
    const pktMatch = /(\d+)\s+packets transmitted,\s+(\d+)\s+received/i.exec(out);
    if (pktMatch) {
      const sent = Number(pktMatch[1]);
      const received = Number(pktMatch[2]);
      return {
        ok: received > 0,
        sent,
        received,
        packetLossPercent: sent > 0 ? Math.round(((sent - received) / sent) * 100) : 100,
        minMs: null,
        avgMs: null,
        maxMs: null,
        error: received === 0 ? '100% Paketverlust (ICMP blockiert oder Host nicht erreichbar)' : undefined,
      };
    }
    return {
      ok: false,
      sent: 3,
      received: 0,
      packetLossPercent: 100,
      minMs: null,
      avgMs: null,
      maxMs: null,
      error: err instanceof Error ? err.message : 'ICMP-Ping nicht verfügbar',
    };
  }
}

async function runTracerouteEquivalent(
  ip: string,
  targetPort: number,
  pingAvgMs: number | null
): Promise<{
  method: DeepNetworkDiagnosticsResult['traceroute']['method'];
  gatewayIp: string | null;
  hops: NetworkHopEntry[];
  summary: string;
}> {
  let gatewayIp: string | null = null;
  let localSrcIp: string | null = null;
  try {
    const { stdout } = await execFileAsync('ip', ['route', 'get', ip], { timeout: 2000 });
    const viaMatch = /\bvia\s+([0-9a-fA-F.:]+)/.exec(stdout);
    const srcMatch = /\bsrc\s+([0-9a-fA-F.:]+)/.exec(stdout);
    if (viaMatch?.[1]) gatewayIp = viaMatch[1];
    if (srcMatch?.[1]) localSrcIp = srcMatch[1];
  } catch {
    // Route-Abfrage optional
  }

  // 1. Echtes traceroute testen
  try {
    const { stdout } = await execFileAsync('traceroute', ['-n', '-m', '10', '-w', '1', ip], {
      timeout: 7000,
    });
    const hops: NetworkHopEntry[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)(?:\s+([0-9.]+)\s*ms)?/.exec(line);
      if (!match) continue;
      const hopNum = Number(match[1]);
      const hopHost = match[2];
      const rtt = match[3] ? Math.round(Number(match[3]) * 10) / 10 : null;
      const isTimeout = hopHost === '*';
      hops.push({
        hop: hopNum,
        host: isTimeout ? '* (Zeitüberschreitung / ICMP gefiltert)' : hopHost,
        ip: isTimeout ? null : hopHost,
        rttMs: rtt,
        status: isTimeout ? 'timeout' : 'reached',
        note: hopNum === 1 && gatewayIp && hopHost === gatewayIp ? 'Standard-Gateway / Router' : undefined,
      });
    }
    if (hops.length > 0) {
      return {
        method: 'traceroute',
        gatewayIp,
        hops,
        summary: `${hops.length} Hop${hops.length === 1 ? '' : 's'} bis ${ip} per Traceroute ermittelt.`,
      };
    }
  } catch {
    // traceroute nicht installiert oder ohne Raw-Socket-Rechte
  }

  // 2. Fallback: tracepath
  try {
    const { stdout } = await execFileAsync('tracepath', ['-n', '-m', '10', ip], {
      timeout: 7000,
    });
    const hops: NetworkHopEntry[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+):\s+(\S+)(?:\s+([0-9.]+)ms)?/.exec(line);
      if (!match) continue;
      const hopNum = Number(match[1]);
      const hopHost = match[2];
      const isTimeout = hopHost === 'no' || hopHost === '*';
      const rtt = match[3] ? Math.round(Number(match[3]) * 10) / 10 : null;
      hops.push({
        hop: hopNum,
        host: isTimeout ? '* (Keine Antwort)' : hopHost,
        ip: isTimeout ? null : hopHost,
        rttMs: rtt,
        status: isTimeout ? 'timeout' : 'reached',
      });
    }
    if (hops.length > 0) {
      return {
        method: 'tracepath',
        gatewayIp,
        hops,
        summary: `${hops.length} Hop${hops.length === 1 ? '' : 's'} per Tracepath ermittelt.`,
      };
    }
  } catch {
    // tracepath nicht verfügbar
  }

  // 3. TTL-Ping-Probe (funktioniert auf Standard-Linux/Android ohne traceroute-Binary)
  const ttlHops: NetworkHopEntry[] = [];
  let reachedTargetInTtl = false;
  for (let ttl = 1; ttl <= 6; ttl += 1) {
    try {
      const { stdout } = await execFileAsync('ping', ['-t', String(ttl), '-c', '1', '-W', '1', ip], {
        timeout: 1800,
      });
      const rttMatch = /time=([0-9.]+)\s*ms/i.exec(stdout);
      ttlHops.push({
        hop: ttl,
        host: ip,
        ip,
        rttMs: rttMatch ? Math.round(Number(rttMatch[1]) * 10) / 10 : pingAvgMs,
        status: 'reached',
        note: 'Ziel-Host erreicht',
      });
      reachedTargetInTtl = true;
      break;
    } catch (err) {
      const out =
        err && typeof err === 'object' && 'stdout' in err
          ? String((err as { stdout?: unknown }).stdout || '')
          : '';
      const fromMatch = /From\s+([0-9a-fA-F.:]+).*Time to live exceeded/i.exec(out);
      if (fromMatch?.[1]) {
        ttlHops.push({
          hop: ttl,
          host: fromMatch[1],
          ip: fromMatch[1],
          rttMs: null,
          status: ttl === 1 && gatewayIp === fromMatch[1] ? 'gateway' : 'reached',
          note: ttl === 1 ? 'Router / Gateway-Hop' : 'Zwischen-Hop',
        });
      } else {
        break;
      }
    }
  }

  if (ttlHops.length > 0 && reachedTargetInTtl) {
    return {
      method: 'ttl_ping_probe',
      gatewayIp,
      hops: ttlHops,
      summary: `${ttlHops.length} Hop${ttlHops.length === 1 ? '' : 's'} per TTL-Ping bis ${ip} ermittelt.`,
    };
  }

  // 4. Routen-/Gateway-Äquivalent
  const fallbackHops: NetworkHopEntry[] = [
    {
      hop: 1,
      host: localSrcIp || 'Lokales Netzwerk-Interface',
      ip: localSrcIp,
      rttMs: 0.2,
      status: 'local',
      note: 'Quell-Schnittstelle',
    },
  ];
  if (gatewayIp) {
    const gwPing = await probeTcpConnection(gatewayIp, 80, 900).catch(() => null);
    fallbackHops.push({
      hop: 2,
      host: gatewayIp,
      ip: gatewayIp,
      rttMs: gwPing?.latencyMs ?? null,
      status: 'gateway',
      note: 'Standard-Gateway / Router',
    });
  }
  const targetTcp = await probeTcpConnection(ip, targetPort, 1500);
  fallbackHops.push({
    hop: fallbackHops.length + 1,
    host: `${ip}:${targetPort}`,
    ip,
    rttMs: pingAvgMs ?? (targetTcp.ok ? targetTcp.latencyMs : null),
    status: targetTcp.ok ? 'reached' : 'timeout',
    note: targetTcp.ok
      ? `Zielport ${targetPort} antwortet`
      : `Zielport ${targetPort}: ${targetTcp.errorCode || 'nicht erreichbar'}`,
  });

  return {
    method: 'route_equivalent',
    gatewayIp,
    hops: fallbackHops,
    summary: gatewayIp
      ? `Pfad über Gateway ${gatewayIp} nach ${ip}:${targetPort} geprüft.`
      : `Direkte Subnetz-Route zu ${ip}:${targetPort} geprüft.`,
  };
}

app.post('/api/nas/network/deep-diagnostics', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const startedAt = Date.now();
  const body = (req.body ?? {}) as { targetUrl?: string };
  const username = req.nasUsername!;

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkConfig = normalizeAdminNetworkConfig(settings.networkConfig);
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const savedConn = connStore.users[username];

  const rawCandidate =
    (typeof body.targetUrl === 'string' && body.targetUrl.trim()) ||
    (networkConfig.activeMode === 'remote'
      ? networkConfig.remoteAddress || networkConfig.lanAddress
      : networkConfig.lanAddress || networkConfig.remoteAddress) ||
    savedConn?.host?.trim() ||
    `http://127.0.0.1:${PORT}`;

  const parsedTarget = parseNasHostInput(rawCandidate);
  const hostname = parsedTarget.hostname || '127.0.0.1';
  const scheme: 'http' | 'https' =
    parsedTarget.explicitScheme ??
    (parsedTarget.port === '443' || parsedTarget.port === '8443' || parsedTarget.port === '5001'
      ? 'https'
      : 'http');
  const targetPort = parsedTarget.port
    ? Number(parsedTarget.port)
    : scheme === 'https'
      ? 443
      : Number(PORT) || 3000;

  // 1. DNS-Auflösung
  const dnsStart = Date.now();
  let resolvedIp: string | null = net.isIP(hostname) !== 0 ? hostname : null;
  let dnsError: string | undefined;
  let dnsLatencyMs: number | null = net.isIP(hostname) !== 0 ? 0 : null;

  if (!resolvedIp) {
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(hostname)) {
      res.status(400).json({ error: `Ungültiger Hostname "${hostname}".` });
      return;
    }
    try {
      const lookup4 = await dns.lookup(hostname, { family: 4 }).catch(() => null);
      const lookup = lookup4 ?? (await dns.lookup(hostname));
      resolvedIp = lookup.address;
      dnsLatencyMs = Math.max(1, Date.now() - dnsStart);
    } catch (err) {
      dnsError = err instanceof Error ? err.message : 'DNS-Auflösung fehlgeschlagen';
      dnsLatencyMs = Math.max(1, Date.now() - dnsStart);
    }
  }

  const scope: 'lan' | 'remote' = resolvedIp
    ? isLocalOrLanAddress(hostname, resolvedIp)
      ? 'lan'
      : 'remote'
    : isLocalOrLanAddress(hostname, hostname)
      ? 'lan'
      : 'remote';

  if (!resolvedIp) {
    const result: DeepNetworkDiagnosticsResult = {
      targetInput: rawCandidate,
      hostname,
      resolvedIp: null,
      targetPort,
      scheme,
      scope,
      dns: { ok: false, latencyMs: dnsLatencyMs, resolvedIp: null, error: dnsError },
      ping: {
        method: 'icmp',
        reachable: false,
        sent: 0,
        received: 0,
        packetLossPercent: 100,
        minMs: null,
        avgMs: null,
        maxMs: null,
        error: 'DNS-Auflösung fehlgeschlagen',
      },
      traceroute: {
        method: 'route_equivalent',
        gatewayIp: null,
        hops: [],
        summary: 'Kein Routen-Check möglich, da DNS-Name nicht aufgelöst wurde.',
      },
      portMatrix: [],
      http400Analysis: null,
      findings: [
        {
          severity: 'error',
          code: 'DNS_FAILED',
          title: 'Hostname nicht auflösbar',
          detail: dnsError || `Hostname "${hostname}" liefert keine IP-Adresse.`,
          recommendation:
            'Prüfe Schreibweise, lokales DNS/mDNS (.local) oder DynDNS/MyFRITZ-Eintrag.',
        },
      ],
      executedOn: 'server',
      measuredAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - startedAt),
    };
    res.json(result);
    return;
  }

  // 2. ICMP Ping (mit TCP SYN Fallback)
  const icmp = await runIcmpPingProbe(resolvedIp);
  let pingResult: DeepNetworkDiagnosticsResult['ping'] = {
    method: 'icmp',
    reachable: icmp.ok,
    sent: icmp.sent,
    received: icmp.received,
    packetLossPercent: icmp.packetLossPercent,
    minMs: icmp.minMs,
    avgMs: icmp.avgMs,
    maxMs: icmp.maxMs,
    error: icmp.error,
  };

  // 3. Port-Matrix & HTTP-400 Inspection parallel starten
  const portSpecs: Array<{ port: number; label: string; protocolHint: 'http' | 'https' | 'tcp' }> = [
    { port: targetPort, label: `Ziel-Port (${targetPort})`, protocolHint: scheme },
    { port: 3000, label: 'EntenCenter Standard', protocolHint: 'http' },
    { port: 3001, label: 'EntenCenter Ausweichport 1', protocolHint: 'http' },
    { port: 3002, label: 'EntenCenter Ausweichport 2', protocolHint: 'http' },
    { port: 3005, label: 'EntenCenter Ausweichport 3', protocolHint: 'http' },
    { port: 8000, label: 'HTTP-Alt / Dev-Backend', protocolHint: 'http' },
    { port: 8080, label: 'HTTP-Alt / QNAP / Proxy', protocolHint: 'http' },
    { port: 8081, label: 'HTTP-Alt 8081', protocolHint: 'http' },
    { port: 8443, label: 'HTTPS-Alt / Proxy', protocolHint: 'https' },
    { port: 8888, label: 'EntenCenter Ausweichport 8888', protocolHint: 'http' },
    { port: 9000, label: 'NAS Service / Ausweichport', protocolHint: 'http' },
    { port: 80, label: 'HTTP / Reverse-Proxy', protocolHint: 'http' },
    { port: 443, label: 'HTTPS / Reverse-Proxy', protocolHint: 'https' },
    { port: 445, label: 'SMB / CIFS', protocolHint: 'tcp' },
    { port: 5000, label: 'Synology DSM (HTTP)', protocolHint: 'http' },
    { port: 5001, label: 'Synology DSM (HTTPS)', protocolHint: 'https' },
    { port: 5005, label: 'WebDAV (HTTP)', protocolHint: 'http' },
    { port: 5006, label: 'WebDAV (HTTPS)', protocolHint: 'https' },
    { port: 22, label: 'SFTP / SSH', protocolHint: 'tcp' },
  ];
  const uniquePorts = portSpecs.filter(
    (item, idx, arr) => arr.findIndex((x) => x.port === item.port) === idx
  );

  const portMatrix: NetworkPortProbeEntry[] = await Promise.all(
    uniquePorts.map(async (spec): Promise<NetworkPortProbeEntry> => {
      const tcp = await probeTcpConnection(resolvedIp!, spec.port, 1600);
      const entry: NetworkPortProbeEntry = {
        port: spec.port,
        label: spec.label,
        protocolHint: spec.protocolHint,
        tcpOpen: tcp.ok,
        latencyMs: tcp.ok ? tcp.latencyMs : null,
        errorCode: tcp.ok ? null : tcp.errorCode || 'UNREACHABLE',
      };

      if (tcp.ok && (spec.protocolHint === 'http' || spec.protocolHint === 'https')) {
        const probeScheme =
          spec.port === 443 || spec.port === 8443 || spec.port === 5001 || spec.port === 5006
            ? 'https'
            : spec.port === 80 ||
                spec.port === 3000 ||
                spec.port === 3001 ||
                spec.port === 3002 ||
                spec.port === 3005 ||
                spec.port === 8000 ||
                spec.port === 8081 ||
                spec.port === 8888 ||
                spec.port === 9000 ||
                spec.port === 5000 ||
                spec.port === 5005
              ? 'http'
              : spec.protocolHint;
        const activeCert = readCurrentSecurityCertificate(settings);
        try {
          const httpResp = await requestHttpWithNasCertificate(
            `${probeScheme}://${resolvedIp}:${spec.port}/api/nas/auth/bootstrap`,
            { timeoutMs: 1800, trustedPem: activeCert?.pem ?? null }
          );
          entry.httpStatus = httpResp.status;
          entry.serverHeader = httpResp.serverHeader;
          if (httpResp.status >= 200 && httpResp.status < 300) {
            const payload = JSON.parse(httpResp.body) as { hasUsers?: unknown };
            entry.isEntenCenter = Boolean(payload && typeof payload.hasUsers === 'boolean');
          }
        } catch {
          // HTTP-Probe fehlgeschlagen (z. B. selbstsigniertes Zertifikat ohne passendes NAS-Zertifikat oder Non-HTTP-Dienst)
        }
      }
      return entry;
    })
  );

  // TCP-SYN-Ping-Fallback, wenn ICMP blockiert oder nicht verfügbar
  if (!pingResult.reachable) {
    const anyOpenPort = portMatrix.find((p) => p.tcpOpen)?.port ?? targetPort;
    const samples: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await probeTcpConnection(resolvedIp, anyOpenPort, 1200);
      if (s.ok) samples.push(s.latencyMs);
    }
    if (samples.length > 0) {
      const sum = samples.reduce((acc, v) => acc + v, 0);
      pingResult = {
        method: 'tcp_syn_fallback',
        reachable: true,
        sent: 3,
        received: samples.length,
        packetLossPercent: Math.round(((3 - samples.length) / 3) * 100),
        minMs: Math.min(...samples),
        avgMs: Math.round((sum / samples.length) * 10) / 10,
        maxMs: Math.max(...samples),
        error: 'ICMP-Echo wurde durch Host/Firewall verworfen — Latenz über TCP-SYN-Handshake gemessen.',
      };
    }
  }

  // 4. Traceroute / Hop-Pfad-Äquivalent
  const traceroute = await runTracerouteEquivalent(resolvedIp, targetPort, pingResult.avgMs);

  // 5. Spezifische 400er-, Firewall- & Port-Konflikt-Analyse
  const http400Entry =
    portMatrix.find((p) => p.port === targetPort && p.httpStatus !== undefined && p.httpStatus !== null && p.httpStatus >= 400 && p.httpStatus < 500) ??
    portMatrix.find((p) => p.httpStatus === 400) ??
    null;
  const targetEntry = portMatrix.find((p) => p.port === targetPort);
  const entenCenterPort = portMatrix.find((p) => p.isEntenCenter);
  const port3000Entry = portMatrix.find((p) => p.port === 3000);
  const port80Or443Open = portMatrix.some((p) => p.tcpOpen && (p.port === 80 || p.port === 443));
  const looksLikeFritzHost =
    hostname.toLowerCase().includes('fritz') ||
    port80Or443Open ||
    targetPort === 49000 ||
    targetPort === 49443;

  let fritzBoxInfo: DeepNetworkDiagnosticsResult['fritzBoxInfo'] = null;
  if (!entenCenterPort && looksLikeFritzHost) {
    const activeCert = readCurrentSecurityCertificate(settings);
    const fritzProbe = await FritzBoxSessionClient.probeLoginSid(
      resolvedIp,
      networkConfig.allowLocalSelfSignedTls,
      activeCert?.pem ?? null,
      1100
    ).catch(() => null);
    if (fritzProbe?.detected) {
      fritzBoxInfo = {
        detected: true,
        friendlyName: fritzProbe.friendlyName,
        tr064Available: fritzProbe.tr064Available,
        loginSidAvailable: true,
        requiresAuth: fritzProbe.requiresAuth,
        httpAvailable: fritzProbe.httpAvailable,
        httpsAvailable: fritzProbe.httpsAvailable,
        httpsError: fritzProbe.httpsError,
        loginSidUrl: fritzProbe.loginSidUrl,
      };
      for (const entry of portMatrix) {
        if ((entry.port === 80 || entry.port === 443) && entry.tcpOpen && !entry.serverHeader) {
          entry.serverHeader = 'FRITZ!Box / AVM WebUI';
        }
      }
    }
  }

  let http400Analysis: Http400DiagnosticDetail | null = null;
  if (http400Entry && http400Entry.httpStatus) {
    const causes: Http400DiagnosticDetail['probableCauses'] = [];
    const hints: string[] = [];

    if (fritzBoxInfo?.detected && (http400Entry.port === 80 || http400Entry.port === 443)) {
      causes.push('tls_on_http_port');
      hints.push(
        `Auf Port ${http400Entry.port} läuft das FRITZ!Box / FRITZ!NAS Web-Interface (/login_sid.lua erkannt), kein EntenCenter-Server.`
      );
      hints.push(
        fritzBoxInfo.httpsError
          ? `HTTPS/TLS-Hinweis: ${fritzBoxInfo.httpsError} — EntenCenter nutzt im LAN automatisch HTTP (Port 80).`
          : 'Verbinde dich im Login-Bereich oder NAS-Speicher-Wizard mit FRITZ!Box-Protokoll oder SMB (Port 445).'
      );
      if (fritzBoxInfo.requiresAuth) {
        hints.push(
          'FRITZ!NAS verlangt vor dem Zugriff eine Anmeldung (FRITZ!Box-Benutzername optional + Kennwort).'
        );
      }
    } else {
      if (http400Entry.port === 80 || http400Entry.port === 443 || http400Entry.port === 8080) {
        causes.push('port_conflict');
        hints.push(
          `Port-Konflikt wahrscheinlich: Auf Port ${http400Entry.port} antwortet bereits ein anderer Dienst${
            http400Entry.serverHeader ? ` (${http400Entry.serverHeader})` : ''
          } mit HTTP ${http400Entry.httpStatus} — dort läuft kein direktes EntenCenter-Backend.`
        );
      }
      if (http400Entry.port === 443 || http400Entry.port === 8443 || http400Entry.port === 5001 || http400Entry.port === 80) {
        causes.push('tls_on_http_port');
        hints.push(
          'Protokoll-Mismatch (HTTP vs. HTTPS): Prüfe, ob der Port HTTPS/TLS erwartet oder ein HTTP-Redirect auf HTTPS fehlt.'
        );
      }
      causes.push('proxy_header_filter');
      hints.push(
        'Reverse-Proxy / Header-Filter: Nginx, Apache, Synology Reverse Proxy oder Traefik weisen Anfragen ohne passenden Host-Header, CORS-/Private-Network-Header oder WebSocket-Upgrade oft mit HTTP 400 ab.'
      );
      if (port3000Entry && !port3000Entry.tcpOpen) {
        causes.push('firewall_or_wrong_service');
        hints.push(
          port3000Entry.errorCode === 'ETIMEDOUT'
            ? 'Firewall-Blockade auf Port 3000: Pakete verwerfen (ETIMEDOUT). Gib Port 3000/TCP in NAS-Firewall und Router frei.'
            : 'Port 3000 lehnt Verbindungen ab (ECONNREFUSED): EntenCenter-Server ist nicht gestartet oder lauscht nur auf 127.0.0.1 statt 0.0.0.0.'
        );
      } else if (entenCenterPort && entenCenterPort.port !== http400Entry.port) {
        hints.push(
          `EntenCenter-Backend läuft stattdessen auf Port ${entenCenterPort.port}! Ändere die Ziel-URL auf Port :${entenCenterPort.port}.`
        );
      }
    }

    http400Analysis = {
      detected: true,
      port: http400Entry.port,
      statusCode: http400Entry.httpStatus,
      serverHeader: http400Entry.serverHeader ?? null,
      probableCauses: causes,
      summary:
        fritzBoxInfo?.detected && (http400Entry.port === 80 || http400Entry.port === 443)
          ? `Port ${http400Entry.port} liefert erwartungsgemäß HTTP ${http400Entry.httpStatus} auf /api/nas/auth/bootstrap, da dort deine FRITZ!Box / FRITZ!NAS antwortet.`
          : `HTTP ${http400Entry.httpStatus} auf Port ${http400Entry.port} deutet auf einen Port-Konflikt, fehlende HTTPS/Proxy-Header oder einen fremden NAS-/Webdienst hin.`,
      hints,
    };
  }

  const findings: NetworkDiagnosticFinding[] = [];
  if (entenCenterPort) {
    findings.push({
      severity: 'ok',
      code: 'ENTENCENTER_REACHABLE',
      title: `EntenCenter-Backend aktiv auf Port ${entenCenterPort.port}`,
      detail: `Der Endpunkt ${resolvedIp}:${entenCenterPort.port} liefert gültiges EntenCenter-Bootstrap JSON (${entenCenterPort.latencyMs ?? 1} ms).`,
      recommendation:
        entenCenterPort.port !== targetPort
          ? `Verwende Port ${entenCenterPort.port} statt ${targetPort} in deiner Server-URL.`
          : 'Verbindung betriebsbereit.',
    });
  }

  if (fritzBoxInfo?.detected) {
    findings.push({
      severity: 'info',
      code: 'FRITZBOX_DETECTED',
      title: `FRITZ!Box / FRITZ!NAS erkannt (${resolvedIp})`,
      detail: `${fritzBoxInfo.friendlyName} · /login_sid.lua erreichbar (${
        fritzBoxInfo.httpAvailable ? 'HTTP:80 aktiv' : 'HTTP:80 aus'
      }${fritzBoxInfo.httpsAvailable ? ', HTTPS:443 aktiv' : fritzBoxInfo.httpsError ? `, HTTPS-Hinweis: ${fritzBoxInfo.httpsError}` : ''}).`,
      recommendation: fritzBoxInfo.requiresAuth
        ? 'FRITZ!NAS erfordert vor dem Zugriff die Eingabe der FRITZ!Box-Zugangsdaten (Benutzername optional + Kennwort). EntenCenter nutzt im LAN bei HTTPS-Fehlern automatisch HTTP (Port 80).'
        : 'Du kannst diese FRITZ!Box direkt im Anmeldebildschirm oder als FRITZ!NAS/SMB-Speicher einrichten.',
    });
  }

  if (http400Analysis) {
    const isExpectedFritzPort =
      Boolean(fritzBoxInfo?.detected) && (http400Analysis.port === 80 || http400Analysis.port === 443);
    findings.push({
      severity: isExpectedFritzPort ? 'info' : 'error',
      code: `HTTP_${http400Analysis.statusCode}_CONFLICT`,
      title: isExpectedFritzPort
        ? `FRITZ!Box Web/NAS auf Port ${http400Analysis.port} (HTTP ${http400Analysis.statusCode} auf Bootstrap-Pfad)`
        : `HTTP ${http400Analysis.statusCode} auf Port ${http400Analysis.port} (Port-Konflikt / Proxy)`,
      detail: http400Analysis.summary,
      recommendation: http400Analysis.hints[0] || 'Prüfe Port-Belegung und Reverse-Proxy-Regeln.',
    });
  }

  if (targetEntry && !targetEntry.tcpOpen) {
    const isTimeout = targetEntry.errorCode === 'ETIMEDOUT';
    findings.push({
      severity: 'error',
      code: isTimeout ? 'FIREWALL_DROP' : 'PORT_CLOSED',
      title: isTimeout
        ? `Firewall-Blockade vermutet auf Port ${targetPort}`
        : `Port ${targetPort} geschlossen (${targetEntry.errorCode || 'ECONNREFUSED'})`,
      detail: isTimeout
        ? `Verbindung zu ${resolvedIp}:${targetPort} lief ins Timeout — typisch für eine blockierende Firewall (Host-Firewall oder Router-Portfreigabe fehlt).`
        : `${resolvedIp}:${targetPort} weist Verbindungen sofort ab. Auf diesem Port lauscht aktuell kein Prozess.`,
      recommendation: isTimeout
        ? `Port ${targetPort}/TCP in der NAS-/System-Firewall (z. B. ufw, Synology DSM Firewall) sowie bei Fernzugriff im Router freigeben.`
        : 'EntenCenter-Server starten bzw. Bind-Adresse auf 0.0.0.0 prüfen oder auf Port 3000 umschalten.',
    });
  }

  if (!pingResult.reachable && portMatrix.every((p) => !p.tcpOpen)) {
    findings.push({
      severity: 'error',
      code: 'HOST_UNREACHABLE',
      title: `Ziel-Host ${resolvedIp} nicht erreichbar`,
      detail: 'Weder ICMP-Ping noch bekannte TCP-Ports antworten auf diesem Ziel.',
      recommendation:
        'Prüfe WLAN-/LAN-Zugehörigkeit, IP-Adresse, Stromversorgung des NAS oder aktive VPN-Verbindung.',
    });
  } else if (pingResult.method === 'tcp_syn_fallback') {
    findings.push({
      severity: 'info',
      code: 'ICMP_BLOCKED_TCP_OK',
      title: 'ICMP-Ping blockiert, TCP-Verbindung jedoch möglich',
      detail: 'Die Firewall verwirft ICMP-Echo-Pakete, lässt aber TCP-Verkehr durch.',
      recommendation: 'Verbindungstests per TCP/HTTP funktionieren weiterhin normal.',
    });
  }

  const pureNasPorts = portMatrix.filter(
    (p) => p.tcpOpen && [445, 5000, 5001, 5005, 5006, 22].includes(p.port)
  );
  if (!entenCenterPort && pureNasPorts.length > 0) {
    findings.push({
      severity: fritzBoxInfo?.detected ? 'info' : 'warn',
      code: 'PURE_NAS_STORAGE_ONLY',
      title: fritzBoxInfo?.detected
        ? 'FRITZ!NAS-Speicherfreigabe (SMB) erkannt'
        : 'NAS-Speicherdienste erkannt, aber kein EntenCenter-Backend',
      detail: `Offene NAS-Ports: ${pureNasPorts.map((p) => `${p.label} (${p.port})`).join(', ')}.`,
      recommendation: fritzBoxInfo?.detected
        ? 'Nutze diese IP mit FRITZ!Box Challenge-Response (/login_sid.lua) oder SMB (Port 445) als FRITZ!NAS-Speicherfreigabe.'
        : 'Trage diese IP als NAS-Speicherfreigabe (SMB/WebDAV/DSM) ein oder starte dort den EntenCenter-Server auf Port 3000.',
    });
  }

  const responsePayload: DeepNetworkDiagnosticsResult = {
    targetInput: rawCandidate,
    hostname,
    resolvedIp,
    targetPort,
    scheme,
    scope,
    dns: {
      ok: true,
      latencyMs: dnsLatencyMs,
      resolvedIp,
    },
    ping: pingResult,
    traceroute,
    portMatrix,
    http400Analysis,
    fritzBoxInfo,
    findings,
    executedOn: 'server',
    measuredAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - startedAt),
  };

  res.json(responsePayload);
});

// Automatischer Port-Scanner (findet Ausweichports wenn :3000 belegt/blockiert/kein EntenCenter liefert)
app.post('/api/nas/network/port-scan', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const body = (req.body ?? {}) as { targetUrl?: string; preferredAltPort?: number | string };

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkConfig = normalizeAdminNetworkConfig(settings.networkConfig);
  const rawTarget =
    (typeof body.targetUrl === 'string' && body.targetUrl.trim()) ||
    networkConfig.lanAddress ||
    networkConfig.remoteAddress ||
    `http://127.0.0.1:${activeServerPort}`;

  const parsedTarget = parseNasHostInput(rawTarget);
  const hostname = parsedTarget.hostname || '127.0.0.1';
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(hostname)) {
    res.status(400).json({ error: `Ungültiger Hostname "${hostname}".` });
    return;
  }

  const parsedPreferredAlt = Number(body.preferredAltPort);
  const preferredAltPort =
    Number.isInteger(parsedPreferredAlt) && parsedPreferredAlt > 0 && parsedPreferredAlt <= 65535 && parsedPreferredAlt !== 3000
      ? parsedPreferredAlt
      : 3001;
  const primaryPort = parsedTarget.port ? Number(parsedTarget.port) : 3000;

  let resolvedIp: string | null = net.isIP(hostname) !== 0 ? hostname : null;
  if (!resolvedIp) {
    try {
      const lookup4 = await dns.lookup(hostname, { family: 4 }).catch(() => null);
      const lookup = lookup4 ?? (await dns.lookup(hostname));
      resolvedIp = lookup.address;
    } catch {
      resolvedIp = null;
    }
  }

  if (!resolvedIp) {
    const emptyResult: AlternativePortScanResult = {
      targetInput: rawTarget,
      hostname,
      resolvedIp: null,
      primaryPort,
      preferredAlternativePort: preferredAltPort,
      recommendedPort: null,
      recommendedBaseUrl: null,
      openEntenCenterPorts: [],
      openAlternativePorts: [],
      openStoragePorts: [],
      ports: [],
      summary: `Hostname "${hostname}" konnte per DNS nicht aufgelöst werden.`,
      executedOn: 'server',
      measuredAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - startedAt),
    };
    res.json(emptyResult);
    return;
  }

  const scanSpecsRaw: Array<{
    port: number;
    scheme: 'http' | 'https' | 'tcp';
    label: string;
    category: AlternativePortScanEntry['category'];
  }> = [
    { port: 3000, scheme: 'http', label: 'EntenCenter Standard', category: 'entencenter' },
    { port: preferredAltPort, scheme: preferredAltPort === 8443 || preferredAltPort === 443 ? 'https' : 'http', label: `Bevorzugter Ausweichport :${preferredAltPort}`, category: 'alternative' },
    { port: 3001, scheme: 'http', label: 'EntenCenter Alt. 1', category: 'alternative' },
    { port: 3002, scheme: 'http', label: 'EntenCenter Alt. 2', category: 'alternative' },
    { port: 3003, scheme: 'http', label: 'EntenCenter Alt. 3', category: 'alternative' },
    { port: 3005, scheme: 'http', label: 'EntenCenter Alt. 5', category: 'alternative' },
    { port: 3010, scheme: 'http', label: 'EntenCenter Alt. 10', category: 'alternative' },
    { port: 3080, scheme: 'http', label: 'HTTP-Alt 3080', category: 'alternative' },
    { port: 8000, scheme: 'http', label: 'HTTP-Alt 8000', category: 'alternative' },
    { port: 8008, scheme: 'http', label: 'HTTP-Alt 8008', category: 'alternative' },
    { port: 8080, scheme: 'http', label: 'HTTP-Proxy / QNAP', category: 'proxy' },
    { port: 8081, scheme: 'http', label: 'HTTP-Alt 8081', category: 'alternative' },
    { port: 8443, scheme: 'https', label: 'HTTPS-Alt 8443', category: 'proxy' },
    { port: 8888, scheme: 'http', label: 'HTTP-Alt 8888', category: 'alternative' },
    { port: 9000, scheme: 'http', label: 'NAS Service / Alt. 9000', category: 'alternative' },
    { port: 9090, scheme: 'http', label: 'Cockpit / Web-Alt 9090', category: 'alternative' },
    { port: 80, scheme: 'http', label: 'HTTP / Router-UI', category: 'router' },
    { port: 443, scheme: 'https', label: 'HTTPS / SSL-Proxy', category: 'router' },
    { port: 445, scheme: 'tcp', label: 'SMB / CIFS Dateifreigabe', category: 'storage' },
    { port: 5000, scheme: 'http', label: 'Synology DSM (HTTP)', category: 'storage' },
    { port: 5001, scheme: 'https', label: 'Synology DSM (HTTPS)', category: 'storage' },
    { port: 5005, scheme: 'http', label: 'WebDAV (HTTP)', category: 'storage' },
    { port: 5006, scheme: 'https', label: 'WebDAV (HTTPS)', category: 'storage' },
    { port: 22, scheme: 'tcp', label: 'SFTP / SSH', category: 'storage' },
    { port: 21, scheme: 'tcp', label: 'FTP / FTPS', category: 'storage' },
    { port: 2049, scheme: 'tcp', label: 'NFS', category: 'storage' },
    { port: 49000, scheme: 'http', label: 'FRITZ!Box TR-064', category: 'router' },
  ];

  const uniqueSpecs = scanSpecsRaw.filter(
    (s, idx, arr) => arr.findIndex((x) => x.port === s.port) === idx
  );
  const activeCert = readCurrentSecurityCertificate(settings);

  const scannedEntries: AlternativePortScanEntry[] = await Promise.all(
    uniqueSpecs.map(async (spec): Promise<AlternativePortScanEntry> => {
      const tcp = await probeTcpConnection(resolvedIp!, spec.port, 1100);
      let httpStatus: number | null = null;
      let serverHeader: string | null = null;
      let isEntenCenter = false;

      if (tcp.ok && (spec.scheme === 'http' || spec.scheme === 'https')) {
        try {
          const httpResp = await requestHttpWithNasCertificate(
            `${spec.scheme}://${resolvedIp}:${spec.port}/api/nas/auth/bootstrap`,
            { timeoutMs: 1300, trustedPem: activeCert?.pem ?? null }
          );
          httpStatus = httpResp.status;
          serverHeader = httpResp.serverHeader ?? null;
          if (httpResp.status >= 200 && httpResp.status < 300) {
            const parsed = JSON.parse(httpResp.body) as { hasUsers?: unknown };
            isEntenCenter = Boolean(parsed && typeof parsed.hasUsers === 'boolean');
          }
        } catch {
          // Non-HTTP oder geschlossene TLS-Verbindung
        }
      }

      const usableAsAlternative =
        isEntenCenter ||
        (tcp.ok &&
          (spec.category === 'alternative' || spec.category === 'proxy') &&
          spec.port !== 3000 &&
          (httpStatus === null || (httpStatus >= 200 && httpStatus < 500)));

      return {
        port: spec.port,
        scheme: spec.scheme,
        label: spec.label,
        category: spec.category,
        tcpOpen: tcp.ok,
        latencyMs: tcp.ok ? tcp.latencyMs : null,
        httpStatus,
        serverHeader,
        isEntenCenter,
        usableAsAlternative,
        recommended: false,
        errorCode: tcp.ok ? null : tcp.errorCode || 'UNREACHABLE',
      };
    })
  );

  const openEntenCenterPorts = scannedEntries.filter((e) => e.isEntenCenter).map((e) => e.port);
  const openAlternativePorts = scannedEntries
    .filter((e) => e.tcpOpen && e.port !== 3000 && (e.isEntenCenter || e.category === 'alternative' || e.category === 'proxy'))
    .map((e) => e.port);
  const openStoragePorts = scannedEntries
    .filter((e) => e.tcpOpen && (e.category === 'storage' || e.port === 80 || e.port === 443 || e.port === 49000))
    .map((e) => e.port);

  const recommendedEntry =
    scannedEntries.find((e) => e.isEntenCenter && e.port !== 3000) ??
    scannedEntries.find((e) => e.isEntenCenter) ??
    scannedEntries.find((e) => e.usableAsAlternative) ??
    null;

  if (recommendedEntry) {
    recommendedEntry.recommended = true;
  }

  const recommendedPort = recommendedEntry ? recommendedEntry.port : null;
  const recommendedBaseUrl = recommendedEntry
    ? `${recommendedEntry.scheme === 'https' ? 'https' : 'http'}://${hostname}:${recommendedEntry.port}`
    : null;

  const summary = openEntenCenterPorts.length > 0
    ? `EntenCenter-Backend gefunden auf Port ${openEntenCenterPorts.map((p) => `:${p}`).join(', ')}.`
    : openAlternativePorts.length > 0
      ? `Kein EntenCenter auf :3000 — offene Ausweichports gefunden: ${openAlternativePorts.map((p) => `:${p}`).join(', ')}.`
      : openStoragePorts.length > 0
        ? `Kein App-Backend-Port offen; NAS-Speicherports erreichbar: ${openStoragePorts.map((p) => `:${p}`).join(', ')}.`
        : `Keine offenen EntenCenter- oder Ausweichports unter ${hostname} (${resolvedIp}) gefunden.`;

  const result: AlternativePortScanResult = {
    targetInput: rawTarget,
    hostname,
    resolvedIp,
    primaryPort,
    preferredAlternativePort: preferredAltPort,
    recommendedPort,
    recommendedBaseUrl,
    openEntenCenterPorts,
    openAlternativePorts,
    openStoragePorts,
    ports: scannedEntries,
    summary,
    executedOn: 'server',
    measuredAt: new Date().toISOString(),
    durationMs: Math.max(1, Date.now() - startedAt),
  };

  res.json(result);
});

app.get('/api/nas/storage', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const remoteTelemetry = await resolveRemoteNasVolumeTelemetry(req.nasUsername).catch(() => null);
  res.json(buildNasStorageStats(remoteTelemetry));
});

app.get('/api/nas/sync/settings', requireNasAuth, (_req: AuthedRequest, res: Response) => {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const assistantAvatar = resolveAssistantAvatar(settings);
  res.json({
    ...settings,
    scanFolderSettings: normalizeNasScanFolderSettings(settings.scanFolderSettings),
    assistantAvatarUrl: assistantAvatar.avatarUrl,
    defaultAssistantAvatarUrl: assistantAvatar.defaultAvatarUrl,
    isCustomAssistantAvatar: assistantAvatar.isCustom,
  });
});

app.get('/api/nas/admin/scan-folders', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  res.json(readCurrentNasScanFolderSettings());
});

app.put('/api/nas/admin/scan-folders', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;
  const body = (req.body ?? {}) as Partial<NasScanFolderSettings>;
  const normalized = normalizeNasScanFolderSettings({
    scanMode: body.scanMode,
    selectedFolders: body.selectedFolders,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.username,
  });
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.scanFolderSettings = normalized;
  writeJsonAtomic('settings.json', settings);
  appendWal('ADMIN_SCAN_FOLDERS_UPDATED', actor.username, {
    scanMode: normalized.scanMode,
    folderCount: normalized.selectedFolders.length,
    selectedFolders: normalized.selectedFolders,
  });
  broadcastNasStatus('nas:status');
  res.json(normalized);
});

app.get('/api/nas/assistant-avatar', requireNasAuth, (_req: AuthedRequest, res: Response) => {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  res.json(resolveAssistantAvatar(settings));
});

app.put('/api/nas/admin/assistant-avatar', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const { avatarUrl } = (req.body ?? {}) as { avatarUrl?: string | null };
  let normalizedAvatar: string | null = null;

  if (typeof avatarUrl === 'string' && avatarUrl.trim().length > 0) {
    const trimmed = avatarUrl.trim();
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
      res.status(400).json({
        error: 'Ungültiges Bildformat. Erlaubt sind PNG-, JPEG-, WebP- oder GIF-Bilder.',
      });
      return;
    }
    if (trimmed.length > 1_800_000) {
      res.status(400).json({
        error: 'Das Avatarbild ist zu groß (maximal ca. 1,3 MB nach Komprimierung).',
      });
      return;
    }
    normalizedAvatar = trimmed;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.assistantAvatarUrl = normalizedAvatar;
  writeJsonAtomic('settings.json', settings);

  const resolved = resolveAssistantAvatar(settings);
  appendWal('ADMIN_ASSISTANT_AVATAR_UPDATED', actor.username, {
    isCustom: resolved.isCustom,
  });
  broadcastNasStatus('nas:assistant_avatar_updated');
  res.json(resolved);
});

app.post('/api/nas/sync/mode', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { syncMode } = req.body as { syncMode?: NasSyncSettings['syncMode'] };
  if (!syncMode || !['manual', 'every_start', 'daily_first'].includes(syncMode)) {
    res.status(400).json({ error: 'Ungültiger Sync-Modus.' });
    return;
  }
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.syncMode = syncMode;
  writeJsonAtomic('settings.json', settings);
  appendWal('SYNC_MODE_UPDATED', username, { syncMode });
  broadcastNasStatus('nas:status');
  res.json(settings);
});

app.post('/api/nas/sync/run', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const scanConfig = normalizeNasScanFolderSettings(settings.scanFolderSettings);
  const pathSettings = readCurrentNasPathSettings();
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const existingPaths = new Set(catalog.map((item) => item.nasPath.trim().toLowerCase()));
  const scannedFoldersSummary: string[] = [];
  let discoveredCount = 0;

  // 1. Lokale / gemountete Ordner gemäß Scan-Konfiguration scannen
  const localRoots =
    scanConfig.scanMode === 'selected' && scanConfig.selectedFolders.length > 0
      ? scanConfig.selectedFolders
          .map((f) => {
            if (fs.existsSync(f)) return f;
            const underData = path.resolve(resolveEffectiveDataDir(pathSettings), f.replace(/^\/+/, ''));
            return underData;
          })
          .filter((p) => fs.existsSync(p))
      : Array.from(
          new Set(
            [
              resolveEffectiveUploadsDir(pathSettings),
              pathSettings.hostStorageOverrideDir,
              ...Object.values(pathSettings.mediaFolders),
            ].filter((p) => Boolean(p && fs.existsSync(p)))
          )
        );

  if (localRoots.length > 0) {
    scannedFoldersSummary.push(...localRoots);
    const foundLocal = walkLocalDirectoriesForScan(localRoots);
    for (const file of foundLocal) {
      if (existingPaths.has(file.fullPath.toLowerCase())) continue;
      const mimeType = inferMimeType(file.name);
      const kind = inferMediaKindFromFile(file.name, mimeType);
      const cleanTitle = path.basename(file.name, file.ext).replace(/[_-]+/g, ' ').trim() || file.name;
      const record: NasLibraryRecord = {
        id: `nas-scan-${crypto.randomBytes(4).toString('hex')}`,
        tmdbId: Math.floor(100000 + Math.random() * 800000),
        title: cleanTitle,
        kind,
        genre: NAS_CATEGORY_LABELS[kind],
        year: new Date().getFullYear(),
        coverKey: inferCoverKeyForKind(kind, NAS_CATEGORY_LABELS[kind]),
        synopsis: `Beim NAS-Ordnerscan entdeckt (${file.name}).`,
        codec:
          kind === 'image'
            ? 'JPEG / PNG'
            : kind === 'music'
              ? 'Audio / FLAC / MP3'
              : kind === 'other'
                ? 'Datei / Archiv'
                : 'H.264 / HEVC Stream',
        audioTracks: kind === 'image' || kind === 'other' ? [] : ['Deutsch', 'Original'],
        subtitles: kind === 'movie' || kind === 'series' ? ['Deutsch'] : [],
        totalDurationMinutes: kind === 'movie' ? 102 : kind === 'series' ? 44 : 10,
        nasPath: file.fullPath,
        uploadedMimeType: mimeType,
        addedAt: new Date().toISOString(),
        fileFormat: file.ext.replace(/^\./, '').toUpperCase() || 'FILE',
        fileSize: formatBytesHuman(file.sizeBytes),
        fsk: 0,
      };
      catalog.unshift(record);
      existingPaths.add(file.fullPath.toLowerCase());
      discoveredCount += 1;
    }
  }

  // 2. Live-NAS (SMB2 / FRITZ!NAS) gemäß Admin-Scan-Ordnerkonfiguration scannen
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const activeConn = connStore.users[username] ?? Object.values(connStore.users).find((c) => Boolean(c?.host && (c.encryptedSecret || c.encryptedFritzSecret)));
  if (activeConn?.host && (activeConn.encryptedSecret || activeConn.encryptedFritzSecret)) {
    const connHost = cleanHostInput(activeConn.host).hostname;
    const connSecret = decryptNasSecret(activeConn.encryptedSecret || activeConn.encryptedFritzSecret);
    if (connHost && connSecret) {
      const remoteScan = await scanSmbMediaFolders({
        host: connHost,
        port: activeConn.protocol === 'smb' ? sanitizeSmbPort(activeConn.port) : 445,
        shareOrPath: activeConn.shareOrPath || (activeConn.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
        username: activeConn.username || activeConn.fritzUsername || '',
        password: connSecret,
        domainOrWorkgroup: activeConn.domainOrWorkgroup,
        scanMode: scanConfig.scanMode,
        folders: scanConfig.selectedFolders,
      }).catch(() => null);
      if (remoteScan?.ok) {
        for (const sf of remoteScan.scannedFolders) {
          if (!scannedFoldersSummary.includes(sf)) scannedFoldersSummary.push(sf);
        }
        for (const f of remoteScan.files) {
          const remoteRef = `smb://${connHost}${f.path}`;
          if (existingPaths.has(remoteRef.toLowerCase()) || existingPaths.has(f.path.toLowerCase())) continue;
          const cleanTitle = path.basename(f.name, path.extname(f.name)).replace(/[_-]+/g, ' ').trim() || f.name;
          const kind = f.inferredKind;
          const record: NasLibraryRecord = {
            id: `nas-scan-${crypto.randomBytes(4).toString('hex')}`,
            tmdbId: Math.floor(100000 + Math.random() * 800000),
            title: cleanTitle,
            kind,
            genre: NAS_CATEGORY_LABELS[kind],
            year: new Date().getFullYear(),
            coverKey: inferCoverKeyForKind(kind, NAS_CATEGORY_LABELS[kind]),
            synopsis: `Beim Live-NAS-Ordnerscan in „${f.dirPath}“ entdeckt (${f.name}).`,
            codec:
              kind === 'image'
                ? 'JPEG / PNG'
                : kind === 'music'
                  ? 'Audio / FLAC / MP3'
                  : kind === 'other'
                    ? 'Datei / Archiv'
                    : 'H.264 / HEVC Stream',
            audioTracks: kind === 'image' || kind === 'other' ? [] : ['Deutsch', 'Original'],
            subtitles: kind === 'movie' || kind === 'series' ? ['Deutsch'] : [],
            totalDurationMinutes: kind === 'movie' ? 102 : kind === 'series' ? 44 : 10,
            nasPath: remoteRef,
            uploadedMimeType: inferMimeType(f.name),
            uploadedByteSize: f.sizeBytes > 0 ? f.sizeBytes : undefined,
            addedAt: new Date().toISOString(),
            fileFormat: path.extname(f.name).replace(/^\./, '').toUpperCase() || 'FILE',
            fileSize: formatBytesHuman(f.sizeBytes),
            fsk: 0,
          };
          catalog.unshift(record);
          existingPaths.add(remoteRef.toLowerCase());
          discoveredCount += 1;
        }

        const nextTelemetry: RemoteVolumeTelemetry = {
          ...(remoteScan.volumeTotalBytes
            ? {
                totalBytes: remoteScan.volumeTotalBytes,
                freeBytes: remoteScan.volumeFreeBytes ?? 0,
                usedBytes: remoteScan.volumeUsedBytes ?? 0,
                volumeSource: remoteScan.volumeSource || 'smb2_query_info',
              }
            : {}),
          shareName: remoteScan.shareName,
          scannedTotalBytes: remoteScan.scannedTotalBytes,
          scannedFilesCount: remoteScan.scannedFilesCount,
          mediaBreakdown: remoteScan.mediaBreakdown,
          measuredAt: new Date().toISOString(),
        };
        cachedRemoteVolumeStats = nextTelemetry;
        cachedRemoteVolumeAt = Date.now();
        writeJsonAtomic('nas_volume_telemetry.json', nextTelemetry);
      }
    }
  }

  if (discoveredCount > 0) {
    writeJsonAtomic('catalog.json', catalog);
  }

  const newlyAdded = detectAndNotifyNewCatalogItems();
  const updatedSettings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  updatedSettings.lastScanTimestamp = new Date().toISOString();
  writeJsonAtomic('settings.json', updatedSettings);
  appendWal('NAS_MEDIA_SCAN', username, {
    lastScanTimestamp: updatedSettings.lastScanTimestamp,
    newlyAddedCount: newlyAdded.length,
    discoveredCount,
    scanMode: scanConfig.scanMode,
    scannedFolders: scannedFoldersSummary,
  });
  broadcastNasStatus('nas:scan_completed');

  const notifStore = readJsonFile<NotificationsStore>('notifications.json', {
    alerts: [],
  });
  const userAlerts = notifStore.alerts.filter((a) => a.username === username);

  res.json({
    ...updatedSettings,
    scanFolderSettings: scanConfig,
    scannedFolders: scannedFoldersSummary,
    scanned: true,
    newlyAddedCount: newlyAdded.length,
    discoveredFilesCount: discoveredCount,
    alerts: userAlerts,
    message:
      newlyAdded.length > 0
        ? `NAS gescannt (${scanConfig.scanMode === 'selected' ? `${scanConfig.selectedFolders.length} ausgewählte Ordner` : 'alle Ordner'}): ${newlyAdded.length} neue Inhalte erkannt und alle Benutzer benachrichtigt.`
        : `NAS-Ordner gescannt (${scanConfig.scanMode === 'selected' ? `${scanConfig.selectedFolders.length} ausgewählte Ordner` : 'alle Ordner'}). Keine neuen Inhalte hinzugekommen.`,
  });
});

// Admin Only: Unterstützte NAS-Anmeldewege konfigurieren
app.get('/api/nas/admin/nas-auth-methods', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  res.json({
    allowedProtocols: readAllowedNasProtocols(),
    allProtocols: [...ALL_NAS_PROTOCOLS],
  });
});

app.put('/api/nas/admin/nas-auth-methods', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const { allowedProtocols } = (req.body ?? {}) as { allowedProtocols?: unknown };
  if (!Array.isArray(allowedProtocols)) {
    res.status(400).json({ error: 'Ungültige Liste für NAS-Anmeldewege.' });
    return;
  }

  const seen = new Set<NasProtocolId>();
  const filtered: NasProtocolId[] = [];
  for (const item of allowedProtocols) {
    if (typeof item === 'string' && VALID_NAS_PROTOCOLS.has(item as NasProtocolId)) {
      const proto = item as NasProtocolId;
      if (!seen.has(proto)) {
        seen.add(proto);
        filtered.push(proto);
      }
    }
  }

  if (filtered.length === 0) {
    res.status(400).json({ error: 'Mindestens ein NAS-Anmeldeweg muss unterstützt werden.' });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.allowedNasProtocols = filtered;
  writeJsonAtomic('settings.json', settings);
  appendWal('ADMIN_NAS_AUTH_METHODS_UPDATED', actor.username, {
    allowedProtocols: filtered,
  });

  res.json({
    allowedProtocols: filtered,
    allProtocols: [...ALL_NAS_PROTOCOLS],
  });
});

// Admin Only: Fritzbox UPnP/DLNA-Discovery Einstellungen & Subnetz-Status
app.get('/api/nas/admin/fritz-discovery', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const config = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);
  const subnets = getNasNetworkSubnets();
  res.json({
    config,
    localSubnets: subnets.map((s) => s.cidr),
    nasIps: subnets.map((s) => s.ip),
  });
});

app.put('/api/nas/admin/fritz-discovery', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const body = (req.body ?? {}) as Partial<StoredFritzDiscoveryConfig> & {
    runScanNow?: boolean;
  };
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const existing = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);

  if (typeof body.subnetCidr === 'string' && body.subnetCidr.trim().length > 0) {
    const parsed = parseCidr(body.subnetCidr);
    if (!parsed) {
      res.status(400).json({
        error: 'Ungültiges Subnetz-Format. Bitte z. B. 192.168.178.0/24 eingeben oder leer lassen.',
      });
      return;
    }
  }

  const nextConfig = normalizeFritzDiscoveryConfig({
    ...existing,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    autoTokenlessLogin:
      typeof body.autoTokenlessLogin === 'boolean'
        ? body.autoTokenlessLogin
        : existing.autoTokenlessLogin,
    subnetMatchRequired:
      typeof body.subnetMatchRequired === 'boolean'
        ? body.subnetMatchRequired
        : existing.subnetMatchRequired,
    subnetCidr:
      typeof body.subnetCidr === 'string' ? body.subnetCidr.trim() : existing.subnetCidr,
    probeHosts: Array.isArray(body.probeHosts) ? body.probeHosts : existing.probeHosts,
    probePort: typeof body.probePort === 'string' ? body.probePort : existing.probePort,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.username,
  });

  settings.fritzDiscovery = nextConfig;
  writeJsonAtomic('settings.json', settings);

  appendWal('ADMIN_FRITZ_DISCOVERY_UPDATED', actor.username, {
    enabled: nextConfig.enabled,
    autoTokenlessLogin: nextConfig.autoTokenlessLogin,
    subnetMatchRequired: nextConfig.subnetMatchRequired,
    subnetCidr: nextConfig.subnetCidr,
    probeHosts: nextConfig.probeHosts,
    probePort: nextConfig.probePort,
  });

  let probe = null;
  if (body.runScanNow && nextConfig.enabled) {
    probe = await runFritzDiscoveryProbe(req, nextConfig, true, actor.username);
  }

  const latestSettings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const subnets = getNasNetworkSubnets();

  res.json({
    config: normalizeFritzDiscoveryConfig(latestSettings.fritzDiscovery),
    localSubnets: subnets.map((s) => s.cidr),
    nasIps: subnets.map((s) => s.ip),
    probe,
  });
});

app.post('/api/nas/admin/fritz-discovery/scan', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const existing = normalizeFritzDiscoveryConfig(settings.fritzDiscovery);
  const body = (req.body ?? {}) as {
    probeHosts?: string[];
    probePort?: string;
    subnetCidr?: string;
    subnetMatchRequired?: boolean;
  };

  const scanConfig = normalizeFritzDiscoveryConfig({
    ...existing,
    enabled: true,
    probeHosts: Array.isArray(body.probeHosts) ? body.probeHosts : existing.probeHosts,
    probePort: typeof body.probePort === 'string' ? body.probePort : existing.probePort,
    subnetCidr: typeof body.subnetCidr === 'string' ? body.subnetCidr.trim() : existing.subnetCidr,
    subnetMatchRequired:
      typeof body.subnetMatchRequired === 'boolean'
        ? body.subnetMatchRequired
        : existing.subnetMatchRequired,
  });

  const probe = await runFritzDiscoveryProbe(req, scanConfig, true, actor.username);
  const latestSettings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });

  appendWal('ADMIN_FRITZ_DISCOVERY_SCANNED', actor.username, {
    foundCount: probe.discoveredDevices.length,
    sameSubnetDeviceFound: probe.sameSubnetDeviceFound,
    localSubnets: probe.localSubnets,
  });

  res.json({
    config: normalizeFritzDiscoveryConfig(latestSettings.fritzDiscovery),
    probe,
  });
});

// Admin Only: Dedizierte Netzwerk-Konfiguration (Lokal LAN vs. Remote-NAS WAN/VPN)
app.get('/api/nas/admin/network-config', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const config = normalizeAdminNetworkConfig(settings.networkConfig);
  const subnets = getNasNetworkSubnets();
  res.json({
    config,
    securityCertificate: readCurrentSecurityCertificate(settings),
    detectedLanUrls: getDetectedLanServerUrls(),
    localSubnets: subnets.map((s) => s.cidr),
    clientIp: extractNormalizedClientIp(req),
  });
});

app.put('/api/nas/admin/network-config', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const body = (req.body ?? {}) as {
    activeMode?: NetworkProfileMode;
    lanAddress?: string;
    remoteAddress?: string;
    remoteTransport?: RemoteNasTransportType;
    autoFallbackToRemote?: boolean;
    allowLocalSelfSignedTls?: boolean;
  };

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const existing = normalizeAdminNetworkConfig(settings.networkConfig);

  const nextRemoteTransport: RemoteNasTransportType =
    body.remoteTransport === 'wan_dyndns' ||
    body.remoteTransport === 'vpn' ||
    body.remoteTransport === 'reverse_proxy'
      ? body.remoteTransport
      : existing.remoteTransport;

  const lanResult =
    typeof body.lanAddress === 'string'
      ? normalizeAdminNetworkAddress(body.lanAddress, 'lan')
      : { normalized: existing.lanAddress };
  if (lanResult.error) {
    res.status(400).json({ error: `Lokale LAN-Adresse ungültig: ${lanResult.error}` });
    return;
  }

  const remoteResult =
    typeof body.remoteAddress === 'string'
      ? normalizeAdminNetworkAddress(body.remoteAddress, 'remote', nextRemoteTransport)
      : { normalized: existing.remoteAddress };
  if (remoteResult.error) {
    res.status(400).json({ error: `Remote-NAS-Adresse ungültig: ${remoteResult.error}` });
    return;
  }

  const nextActiveMode: NetworkProfileMode =
    body.activeMode === 'remote' || body.activeMode === 'lan'
      ? body.activeMode
      : existing.activeMode;

  if (nextActiveMode === 'remote' && !remoteResult.normalized) {
    res.status(400).json({
      error: 'Bitte hinterlege eine gültige Remote-NAS-Adresse (WAN/VPN), bevor du auf das Remote-Profil wechselst.',
    });
    return;
  }
  if (nextActiveMode === 'lan' && existing.activeMode === 'remote' && !lanResult.normalized) {
    res.status(400).json({
      error: 'Bitte hinterlege eine lokale LAN-Adresse (z. B. http://192.168.x.x:3000), um in den LAN-Modus zu wechseln.',
    });
    return;
  }

  const nextConfig: StoredAdminNetworkConfig = {
    activeMode: nextActiveMode,
    lanAddress: lanResult.normalized,
    remoteAddress: remoteResult.normalized,
    remoteTransport: nextRemoteTransport,
    autoFallbackToRemote:
      typeof body.autoFallbackToRemote === 'boolean'
        ? body.autoFallbackToRemote
        : existing.autoFallbackToRemote,
    allowLocalSelfSignedTls:
      typeof body.allowLocalSelfSignedTls === 'boolean'
        ? body.allowLocalSelfSignedTls
        : existing.allowLocalSelfSignedTls,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.username,
  };

  settings.networkConfig = nextConfig;
  writeJsonAtomic('settings.json', settings);
  appendWal('ADMIN_NETWORK_CONFIG_UPDATED', actor.username, {
    activeMode: nextConfig.activeMode,
    hasLanAddress: Boolean(nextConfig.lanAddress),
    hasRemoteAddress: Boolean(nextConfig.remoteAddress),
    remoteTransport: nextConfig.remoteTransport,
    autoFallbackToRemote: nextConfig.autoFallbackToRemote,
    allowLocalSelfSignedTls: nextConfig.allowLocalSelfSignedTls,
  });

  const subnets = getNasNetworkSubnets();
  res.json({
    config: nextConfig,
    securityCertificate: readCurrentSecurityCertificate(settings),
    detectedLanUrls: getDetectedLanServerUrls(),
    localSubnets: subnets.map((s) => s.cidr),
    clientIp: extractNormalizedClientIp(req),
  });
});

// Gemeinsames NAS-Sicherheitszertifikat (gilt für alle Nutzer dieses NAS)
app.get('/api/nas/network/certificate', (_req: Request, res: Response) => {
  const certificate = readCurrentSecurityCertificate();
  res.json({ certificate });
});

app.get('/api/nas/network/certificate/download', (_req: Request, res: Response) => {
  const certificate = readCurrentSecurityCertificate();
  if (!certificate) {
    res.status(404).json({ error: 'Kein Sicherheitszertifikat auf diesem NAS hinterlegt.' });
    return;
  }
  const downloadName = certificate.fileName.endsWith('.pem') || certificate.fileName.endsWith('.crt')
    ? certificate.fileName
    : 'entencenter-nas-cert.pem';
  res.setHeader('Content-Type', 'application/x-pem-file; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.send(certificate.pem);
});

app.post('/api/nas/admin/network-config/certificate', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const body = (req.body ?? {}) as {
    fileName?: string;
    content?: string;
    label?: string;
  };
  if (typeof body.content !== 'string' || !body.content.trim()) {
    res.status(400).json({ error: 'Bitte wähle eine gültige Zertifikatsdatei (.crt / .pem / .cer / .der) aus.' });
    return;
  }
  if (body.content.length > 512 * 1024) {
    res.status(400).json({ error: 'Die Zertifikatsdatei darf maximal 512 KB groß sein.' });
    return;
  }

  const parsed = parseAndNormalizeSecurityCertificate(
    body.content,
    typeof body.fileName === 'string' ? body.fileName : 'nas-security-cert.pem',
    actor.username,
    typeof body.label === 'string' ? body.label : undefined
  );
  if (parsed.error || !parsed.cert) {
    res.status(400).json({ error: parsed.error || 'Zertifikat ungültig.' });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.securityCertificate = parsed.cert;
  writeJsonAtomic('settings.json', settings);
  persistSecurityCertificatePemFile(parsed.cert);

  appendWal('ADMIN_NETWORK_CERT_UPLOADED', actor.username, {
    certId: parsed.cert.id,
    fileName: parsed.cert.fileName,
    fingerprint256: parsed.cert.fingerprint256,
    validTo: parsed.cert.validTo,
  });
  broadcastNasStatus('nas:security_certificate_updated');

  res.json({ certificate: parsed.cert });
});

app.delete('/api/nas/admin/network-config/certificate', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  settings.securityCertificate = null;
  writeJsonAtomic('settings.json', settings);
  persistSecurityCertificatePemFile(null);

  appendWal('ADMIN_NETWORK_CERT_REMOVED', actor.username, {});
  broadcastNasStatus('nas:security_certificate_updated');

  res.json({ certificate: null });
});

app.post('/api/nas/admin/network-config/test', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const startedAt = Date.now();
  const body = (req.body ?? {}) as {
    mode?: NetworkProfileMode;
    address?: string;
    remoteTransport?: RemoteNasTransportType;
  };

  const mode: NetworkProfileMode = body.mode === 'remote' ? 'remote' : 'lan';
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const saved = normalizeAdminNetworkConfig(settings.networkConfig);
  const remoteTransport =
    body.remoteTransport === 'vpn' || body.remoteTransport === 'reverse_proxy'
      ? body.remoteTransport
      : saved.remoteTransport;

  const rawAddress =
    typeof body.address === 'string' && body.address.trim()
      ? body.address.trim()
      : mode === 'remote'
        ? saved.remoteAddress
        : saved.lanAddress;

  if (!rawAddress) {
    res.status(400).json({
      ok: false,
      mode,
      targetUrl: '',
      error:
        mode === 'remote'
          ? 'Keine Remote-NAS-Adresse (WAN/VPN) angegeben.'
          : 'Keine lokale LAN-NAS-Adresse angegeben.',
    });
    return;
  }

  const normalized = normalizeAdminNetworkAddress(rawAddress, mode, remoteTransport);
  if (normalized.error || !normalized.normalized) {
    res.status(400).json({
      ok: false,
      mode,
      targetUrl: rawAddress,
      error: normalized.error || 'Ungültige Server-Adresse.',
    });
    return;
  }

  const targetUrl = normalized.normalized;
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.status(400).json({
      ok: false,
      mode,
      targetUrl,
      error: `Ungültige Ziel-URL "${targetUrl}".`,
    });
    return;
  }

  const hostname = parsed.hostname;
  const numericPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  let resolvedIp = hostname;
  if (net.isIP(hostname) === 0) {
    try {
      const lookup4 = await dns.lookup(hostname, { family: 4 }).catch(() => null);
      if (lookup4?.address) {
        resolvedIp = lookup4.address;
      } else {
        const lookupAny = await dns.lookup(hostname);
        resolvedIp = lookupAny.address;
      }
    } catch {
      res.status(502).json({
        ok: false,
        mode,
        targetUrl,
        error: `DNS-Auflösung für "${hostname}" fehlgeschlagen. Prüfe Hostname, mDNS (.local) oder DynDNS/MyFRITZ.`,
      });
      return;
    }
  }

  const isLan = isLocalOrLanAddress(hostname, resolvedIp);
  const scope: 'lan' | 'remote' = isLan ? 'lan' : 'remote';

  const tcp = await probeTcpConnection(resolvedIp, numericPort, 4000);
  if (!tcp.ok) {
    const hint =
      mode === 'remote'
        ? `Prüfe Router-Portweiterleitung (Port ${numericPort}), DynDNS/VPN-Tunnel (WireGuard/Tailscale) oder Firewall.`
        : `Prüfe lokale WLAN/LAN-Verbindung, Port ${numericPort} und Server-Firewall.`;
    res.status(502).json({
      ok: false,
      mode,
      targetUrl,
      resolvedIp,
      scope,
      latencyMs: tcp.latencyMs,
      error: `Endpunkt ${targetUrl} (${resolvedIp}:${numericPort}) ist nicht erreichbar (${tcp.errorMessage || tcp.errorCode || 'Fehler'}). ${hint}`,
    });
    return;
  }

  const bootstrapUrl = `${targetUrl}/api/nas/auth/bootstrap`;
  const activeCert = readCurrentSecurityCertificate(saved ? settings : undefined);
  const allowLocalSelfSignedTls = isLan && saved.allowLocalSelfSignedTls;
  try {
    let status = 0;
    let bodyStr = '';
    let trustedByNasCertificate = false;
    let tlsBypassedForLocalSelfSigned = false;

    try {
      const httpResp = await requestHttpWithNasCertificate(bootstrapUrl, {
        timeoutMs: 4500,
        trustedPem: activeCert?.pem ?? null,
      });
      status = httpResp.status;
      bodyStr = httpResp.body;
      trustedByNasCertificate = httpResp.trustedByNasCertificate;
    } catch (primaryErr) {
      if (!allowLocalSelfSignedTls) throw primaryErr;
      const localResp = await requestWithLocalTlsPolicy(bootstrapUrl, {
        method: 'GET',
        timeoutMs: 4500,
        allowLocalSelfSignedTls: true,
        customCaPem: activeCert?.pem ?? null,
      });
      status = localResp.status;
      bodyStr = localResp.body;
      tlsBypassedForLocalSelfSigned = localResp.tlsBypassedForLocalSelfSigned;
    }

    let bootstrapOk = false;
    if (status >= 200 && status < 300) {
      const payload = JSON.parse(bodyStr || '{}') as {
        hasUsers?: unknown;
        allowedNasProtocols?: unknown;
      } | null;
      bootstrapOk = Boolean(
        payload && typeof payload.hasUsers === 'boolean' && Array.isArray(payload.allowedNasProtocols)
      );
    }
    const latencyMs = Math.max(1, Date.now() - startedAt);
    if (!bootstrapOk) {
      res.status(502).json({
        ok: false,
        mode,
        targetUrl,
        resolvedIp,
        scope,
        latencyMs,
        httpStatus: status,
        bootstrapOk: false,
        error: `TCP-Port ${numericPort} antwortet (HTTP ${status}), aber unter ${bootstrapUrl} läuft kein direkter EntenCenter-NAS-Endpunkt.`,
      });
      return;
    }

    res.json({
      ok: true,
      mode,
      targetUrl,
      resolvedIp,
      scope,
      latencyMs,
      httpStatus: status,
      bootstrapOk: true,
      trustedByNasCertificate,
      tlsBypassedForLocalSelfSigned,
      message: `${mode === 'remote' ? 'Remote-NAS (WAN/VPN)' : 'Lokales LAN-NAS'} unter ${targetUrl} (${resolvedIp}) erfolgreich verifiziert (${latencyMs} ms${
        trustedByNasCertificate
          ? ', NAS-Sicherheitszertifikat vertraut'
          : tlsBypassedForLocalSelfSigned
            ? ', lokales selbstsigniertes Zertifikat akzeptiert'
            : ''
      }).`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code ?? '';
    const latencyMs = Math.max(1, Date.now() - startedAt);
    if (
      causeCode.includes('CERT') ||
      causeCode.includes('SSL') ||
      msg.toLowerCase().includes('certificate') ||
      msg.toLowerCase().includes('self-signed')
    ) {
      res.json({
        ok: true,
        mode,
        targetUrl,
        resolvedIp,
        scope,
        latencyMs,
        bootstrapOk: false,
        message: `TCP-Port ${numericPort} unter ${targetUrl} (${resolvedIp}) erreichbar (selbstsigniertes TLS-Zertifikat erkannt).`,
      });
      return;
    }
    res.status(502).json({
      ok: false,
      mode,
      targetUrl,
      resolvedIp,
      scope,
      latencyMs,
      error: `HTTP-Anfrage an ${bootstrapUrl} fehlgeschlagen (${msg || 'Verbindungsfehler'}).`,
    });
  }
});

// Admin Only: Pfad-Einstellungen (Speicherpfade und Zieldatei auf dem NAS konfigurieren)
app.get('/api/nas/admin/path-settings', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const pathSettings = readCurrentNasPathSettings();
  const effectiveServerDataDir = resolveEffectiveDataDir(pathSettings);
  const effectiveUploadsDir = resolveEffectiveUploadsDir(pathSettings);
  const resolvedVaultFilePath = path.join(effectiveServerDataDir, pathSettings.vaultFileName);
  let writable = true;
  try {
    fs.accessSync(effectiveServerDataDir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  res.json({
    settings: pathSettings,
    effectiveServerDataDir,
    effectiveUploadsDir,
    resolvedVaultFilePath,
    writable,
  });
});

app.put('/api/nas/admin/path-settings', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const body = (req.body ?? {}) as Partial<StoredNasPathSettings>;
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const existing = normalizeNasPathSettings(settings.nasPathSettings);

  const nextSettings = normalizeNasPathSettings({
    ...existing,
    vaultBasePath:
      typeof body.vaultBasePath === 'string' ? body.vaultBasePath : existing.vaultBasePath,
    vaultFileName:
      typeof body.vaultFileName === 'string' ? body.vaultFileName : existing.vaultFileName,
    uploadsSubdir:
      typeof body.uploadsSubdir === 'string' ? body.uploadsSubdir : existing.uploadsSubdir,
    hostStorageOverrideDir:
      typeof body.hostStorageOverrideDir === 'string'
        ? body.hostStorageOverrideDir
        : existing.hostStorageOverrideDir,
    mediaFolders: {
      movie: body.mediaFolders?.movie ?? existing.mediaFolders.movie,
      series: body.mediaFolders?.series ?? existing.mediaFolders.series,
      image: body.mediaFolders?.image ?? existing.mediaFolders.image,
      music: body.mediaFolders?.music ?? existing.mediaFolders.music,
      video: body.mediaFolders?.video ?? existing.mediaFolders.video,
      other: body.mediaFolders?.other ?? existing.mediaFolders.other,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: actor.username,
  });

  if (nextSettings.hostStorageOverrideDir) {
    try {
      fs.mkdirSync(nextSettings.hostStorageOverrideDir, { recursive: true });
      fs.accessSync(nextSettings.hostStorageOverrideDir, fs.constants.W_OK);
    } catch (err) {
      res.status(400).json({
        error: `Zielpfad "${nextSettings.hostStorageOverrideDir}" konnte nicht erstellt oder beschrieben werden (${
          err instanceof Error ? err.message : 'Zugriffsfehler'
        }).`,
      });
      return;
    }
  }

  let resolvedVaultFilePath = path.join(
    resolveEffectiveDataDir(nextSettings),
    nextSettings.vaultFileName
  );
  try {
    const effectiveUploadsDir = resolveEffectiveUploadsDir(nextSettings);
    fs.mkdirSync(effectiveUploadsDir, { recursive: true });
    resolvedVaultFilePath = syncVaultManifestSnapshot(nextSettings);
  } catch (err) {
    res.status(400).json({
      error: `Pfad oder Datei konnte auf dem NAS nicht angelegt werden (${
        err instanceof Error ? err.message : 'Schreibfehler'
      }).`,
    });
    return;
  }

  settings.nasPathSettings = nextSettings;
  writeJsonAtomic('settings.json', settings);
  appendWal('ADMIN_NAS_PATH_SETTINGS_UPDATED', actor.username, {
    vaultBasePath: nextSettings.vaultBasePath,
    vaultFileName: nextSettings.vaultFileName,
    uploadsSubdir: nextSettings.uploadsSubdir,
    hasHostOverride: Boolean(nextSettings.hostStorageOverrideDir),
  });
  broadcastNasStatus('nas:paths_updated');

  res.json({
    settings: nextSettings,
    effectiveServerDataDir: resolveEffectiveDataDir(nextSettings),
    effectiveUploadsDir: resolveEffectiveUploadsDir(nextSettings),
    resolvedVaultFilePath,
    writable: true,
  });
});

// Admin Only: Nutzerdatenspeicherung (NAS vs. automatisch verschlüsselte Cloud + Cloud-Anmeldung)
app.get('/api/nas/admin/user-storage', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const { storageConfig } = ensureUserDataStorageSettings();
  const envelope = buildEncryptedUserDataVault(storageConfig.mode === 'cloud');
  res.json({
    config: toPublicUserDataStorageConfig(storageConfig),
    vaultPreview: buildVaultPreview(envelope),
  });
});

app.put('/api/nas/admin/user-storage', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const actor = requireNasAdmin(req, res);
  if (!actor) return;

  const body = (req.body ?? {}) as {
    mode?: UserDataStorageMode;
    cloudProvider?: CloudStorageProvider;
    cloudAccountEmail?: string | null;
    cloudAccountName?: string | null;
    cloudAccountPhotoUrl?: string | null;
    cloudRemoteFileId?: string | null;
    webdavUrl?: string;
    webdavUsername?: string;
    webdavSecret?: string;
    clearWebdavSecret?: boolean;
    webdavRemotePath?: string;
  };

  const { settings, storageConfig } = ensureUserDataStorageSettings();
  const nextMode: UserDataStorageMode = body.mode === 'cloud' ? 'cloud' : 'nas';
  const nextProvider: CloudStorageProvider =
    body.cloudProvider === 'webdav' ? 'webdav' : 'google_drive';

  const nextAccountEmail =
    body.cloudAccountEmail !== undefined ? body.cloudAccountEmail : storageConfig.cloudAccountEmail;
  const nextAccountName =
    body.cloudAccountName !== undefined ? body.cloudAccountName : storageConfig.cloudAccountName;
  const nextAccountPhotoUrl =
    body.cloudAccountPhotoUrl !== undefined
      ? body.cloudAccountPhotoUrl
      : storageConfig.cloudAccountPhotoUrl;
  const nextRemoteFileId =
    body.cloudRemoteFileId !== undefined ? body.cloudRemoteFileId : storageConfig.cloudRemoteFileId;

  const nextWebdavUrl =
    typeof body.webdavUrl === 'string' ? body.webdavUrl.trim() : storageConfig.webdavUrl;
  const nextWebdavUsername =
    typeof body.webdavUsername === 'string'
      ? body.webdavUsername.trim()
      : storageConfig.webdavUsername;
  const nextWebdavRemotePath =
    typeof body.webdavRemotePath === 'string' && body.webdavRemotePath.trim().length > 0
      ? body.webdavRemotePath.trim()
      : storageConfig.webdavRemotePath;

  let nextEncryptedWebdavSecret = storageConfig.encryptedWebdavSecret;
  if (body.clearWebdavSecret) {
    nextEncryptedWebdavSecret = null;
  } else if (typeof body.webdavSecret === 'string' && body.webdavSecret.length > 0) {
    nextEncryptedWebdavSecret = encryptNasSecret(body.webdavSecret);
  }

  if (nextMode === 'cloud') {
    if (nextProvider === 'google_drive' && !nextAccountEmail) {
      res.status(400).json({
        error:
          'Bitte melde dich zuerst direkt hier im Bereich „Nutzerdatenspeicherung“ für die Google Cloud (Google Drive) an.',
      });
      return;
    }
    if (nextProvider === 'webdav') {
      if (!/^https?:\/\/.+/i.test(nextWebdavUrl)) {
        res.status(400).json({
          error: 'Bitte gib eine gültige WebDAV-/Nextcloud-Server-URL (https://...) ein.',
        });
        return;
      }
      if (!nextWebdavUsername || !nextEncryptedWebdavSecret) {
        res.status(400).json({
          error:
            'Bitte gib Cloud-Benutzername und Cloud-Passwort / App-Token für die WebDAV-Anmeldung ein.',
        });
        return;
      }
    }
  }

  const nextConfig: StoredUserDataStorageConfig = {
    ...storageConfig,
    mode: nextMode,
    cloudProvider: nextProvider,
    autoEncrypt: true,
    cloudAccountEmail: nextAccountEmail,
    cloudAccountName: nextAccountName,
    cloudAccountPhotoUrl: nextAccountPhotoUrl,
    cloudRemoteFileId: nextRemoteFileId,
    webdavUrl: nextWebdavUrl,
    webdavUsername: nextWebdavUsername,
    encryptedWebdavSecret: nextEncryptedWebdavSecret,
    webdavRemotePath: nextWebdavRemotePath,
    lastSyncStatus: nextMode === 'nas' ? 'idle' : storageConfig.lastSyncStatus,
    lastSyncError: null,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.username,
  };

  settings.userDataStorage = nextConfig;
  writeJsonAtomic('settings.json', settings);

  const envelope = buildEncryptedUserDataVault(true);

  if (nextMode === 'cloud' && nextProvider === 'webdav') {
    try {
      await uploadEncryptedVaultToWebdav(nextConfig, envelope);
      nextConfig.lastEncryptedSyncAt = envelope.encryptedAt;
      nextConfig.lastSyncStatus = 'synced';
      nextConfig.lastSyncError = null;
    } catch (err) {
      nextConfig.lastSyncStatus = 'error';
      nextConfig.lastSyncError =
        err instanceof Error ? err.message : 'WebDAV-Cloud-Upload fehlgeschlagen.';
    }
    settings.userDataStorage = nextConfig;
    writeJsonAtomic('settings.json', settings);
  }

  appendWal('ADMIN_USER_STORAGE_UPDATED', actor.username, {
    mode: nextMode,
    cloudProvider: nextProvider,
    autoEncrypt: true,
    syncStatus: nextConfig.lastSyncStatus,
  });
  broadcastNasStatus('nas:status');

  res.json({
    config: toPublicUserDataStorageConfig(nextConfig),
    vaultPreview: buildVaultPreview(envelope),
    envelope: nextMode === 'cloud' && nextProvider === 'google_drive' ? envelope : undefined,
  });
});

app.post(
  '/api/nas/admin/user-storage/cloud-envelope',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    if (!requireNasAdmin(req, res)) return;
    const { storageConfig } = ensureUserDataStorageSettings();
    const envelope = buildEncryptedUserDataVault(true);
    res.json({
      config: toPublicUserDataStorageConfig(storageConfig),
      vaultPreview: buildVaultPreview(envelope),
      envelope,
    });
  }
);

app.post(
  '/api/nas/admin/user-storage/cloud-sync-ack',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const body = (req.body ?? {}) as {
      cloudRemoteFileId?: string | null;
      cloudAccountEmail?: string | null;
      cloudAccountName?: string | null;
      cloudAccountPhotoUrl?: string | null;
      encryptedAt?: string | null;
      mode?: UserDataStorageMode;
    };

    const { settings, storageConfig } = ensureUserDataStorageSettings();
    if (body.mode === 'cloud') {
      storageConfig.mode = 'cloud';
      storageConfig.cloudProvider = 'google_drive';
    }
    if (body.cloudRemoteFileId !== undefined) {
      storageConfig.cloudRemoteFileId = body.cloudRemoteFileId;
    }
    if (body.cloudAccountEmail !== undefined) {
      storageConfig.cloudAccountEmail = body.cloudAccountEmail;
    }
    if (body.cloudAccountName !== undefined) {
      storageConfig.cloudAccountName = body.cloudAccountName;
    }
    if (body.cloudAccountPhotoUrl !== undefined) {
      storageConfig.cloudAccountPhotoUrl = body.cloudAccountPhotoUrl;
    }
    storageConfig.autoEncrypt = true;
    storageConfig.lastEncryptedSyncAt = body.encryptedAt || new Date().toISOString();
    storageConfig.lastSyncStatus = 'synced';
    storageConfig.lastSyncError = null;
    storageConfig.updatedAt = new Date().toISOString();
    storageConfig.updatedBy = actor.username;

    settings.userDataStorage = storageConfig;
    writeJsonAtomic('settings.json', settings);
    appendWal('ADMIN_CLOUD_VAULT_SYNCED', actor.username, {
      provider: storageConfig.cloudProvider,
      cloudAccountEmail: storageConfig.cloudAccountEmail,
      cloudRemoteFileId: storageConfig.cloudRemoteFileId,
      encryptedAt: storageConfig.lastEncryptedSyncAt,
    });
    broadcastNasStatus('nas:status');

    const envelope = buildEncryptedUserDataVault(true);
    res.json({
      config: toPublicUserDataStorageConfig(storageConfig),
      vaultPreview: buildVaultPreview(envelope),
    });
  }
);

app.post(
  '/api/nas/admin/user-storage/webdav-sync',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const { settings, storageConfig } = ensureUserDataStorageSettings();
    const envelope = buildEncryptedUserDataVault(true);
    try {
      const result = await uploadEncryptedVaultToWebdav(storageConfig, envelope);
      storageConfig.lastEncryptedSyncAt = envelope.encryptedAt;
      storageConfig.lastSyncStatus = 'synced';
      storageConfig.lastSyncError = null;
      storageConfig.updatedAt = new Date().toISOString();
      storageConfig.updatedBy = actor.username;
      settings.userDataStorage = storageConfig;
      writeJsonAtomic('settings.json', settings);
      appendWal('ADMIN_CLOUD_VAULT_SYNCED', actor.username, {
        provider: 'webdav',
        targetUrl: result.targetUrl,
        encryptedAt: envelope.encryptedAt,
      });
      res.json({
        config: toPublicUserDataStorageConfig(storageConfig),
        vaultPreview: buildVaultPreview(envelope),
        synced: true,
        targetUrl: result.targetUrl,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Verschlüsselter WebDAV-Cloud-Upload fehlgeschlagen.';
      storageConfig.lastSyncStatus = 'error';
      storageConfig.lastSyncError = message;
      settings.userDataStorage = storageConfig;
      writeJsonAtomic('settings.json', settings);
      res.status(502).json({
        error: message,
        config: toPublicUserDataStorageConfig(storageConfig),
        vaultPreview: buildVaultPreview(envelope),
      });
    }
  }
);

app.post(
  '/api/nas/admin/user-storage/verify-envelope',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    if (!requireNasAdmin(req, res)) return;
    const { envelope } = (req.body ?? {}) as { envelope?: EncryptedCloudVaultEnvelope };
    if (!envelope) {
      res.status(400).json({ error: 'Kein verschlüsseltes Cloud-Tresor-Paket übermittelt.' });
      return;
    }
    try {
      const decrypted = verifyAndDecryptUserDataVault(envelope);
      res.json({
        verified: true,
        algorithm: envelope.algorithm,
        payloadSha256: decrypted.payloadSha256,
        encryptedAt: decrypted.encryptedAt,
        summary: decrypted.summary,
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Entschlüsselung oder Integritätsprüfung fehlgeschlagen.',
      });
    }
  }
);

app.post(
  '/api/nas/admin/user-storage/google-disconnect',
  requireNasAuth,
  (req: AuthedRequest, res: Response) => {
    const actor = requireNasAdmin(req, res);
    if (!actor) return;

    const { settings, storageConfig } = ensureUserDataStorageSettings();
    storageConfig.cloudAccountEmail = null;
    storageConfig.cloudAccountName = null;
    storageConfig.cloudAccountPhotoUrl = null;
    storageConfig.cloudRemoteFileId = null;
    if (storageConfig.mode === 'cloud' && storageConfig.cloudProvider === 'google_drive') {
      storageConfig.lastSyncStatus = 'pending_auth';
    } else {
      storageConfig.lastSyncStatus = 'idle';
    }
    storageConfig.updatedAt = new Date().toISOString();
    storageConfig.updatedBy = actor.username;
    settings.userDataStorage = storageConfig;
    writeJsonAtomic('settings.json', settings);
    appendWal('ADMIN_CLOUD_DISCONNECTED', actor.username, { provider: 'google_drive' });

    const envelope = buildEncryptedUserDataVault(true);
    res.json({
      config: toPublicUserDataStorageConfig(storageConfig),
      vaultPreview: buildVaultPreview(envelope),
    });
  }
);

// NAS-Verbindungs- und Anmeldedaten laden / speichern / prüfen
app.get('/api/nas/connection', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const record = store.users[username] ?? getDefaultNasConnection();
  res.json({
    connection: toPublicNasConnection(record),
    allowedProtocols: readAllowedNasProtocols(),
  });
});

interface ParsedNasEndpoint {
  hostname: string;
  port: string;
  path: string;
  explicitScheme: 'http' | 'https' | null;
}

function parseNasHostInput(rawHost: string, rawPort = '', rawPath = ''): ParsedNasEndpoint {
  const trimmedHost = rawHost.trim();
  const trimmedPort = rawPort.trim();
  const trimmedPath = rawPath.trim();

  if (!trimmedHost) {
    return { hostname: '', port: trimmedPort, path: trimmedPath, explicitScheme: null };
  }

  let explicitScheme: 'http' | 'https' | null = null;
  if (/^https:\/\//i.test(trimmedHost)) explicitScheme = 'https';
  else if (/^http:\/\//i.test(trimmedHost)) explicitScheme = 'http';

  const candidate = explicitScheme ? trimmedHost : `http://${trimmedHost}`;
  try {
    const parsed = new URL(candidate);
    const parsedPath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return {
      hostname: parsed.hostname || trimmedHost,
      port: trimmedPort || parsed.port || '',
      path: trimmedPath || parsedPath,
      explicitScheme,
    };
  } catch {
    const noScheme = trimmedHost.replace(/^https?:\/\//i, '').split('/')[0];
    const colonIdx = noScheme.lastIndexOf(':');
    if (colonIdx > 0 && /^\d{1,5}$/.test(noScheme.slice(colonIdx + 1))) {
      return {
        hostname: noScheme.slice(0, colonIdx),
        port: trimmedPort || noScheme.slice(colonIdx + 1),
        path: trimmedPath,
        explicitScheme,
      };
    }
    return { hostname: noScheme, port: trimmedPort, path: trimmedPath, explicitScheme };
  }
}

function isLocalOrLanAddress(hostname: string, resolvedIp: string): boolean {
  const hostLower = hostname.trim().toLowerCase();
  if (
    hostLower === 'localhost' ||
    hostLower.endsWith('.local') ||
    hostLower.endsWith('.box') ||
    hostLower.endsWith('.fritz.nas') ||
    hostLower.endsWith('.lan') ||
    hostLower.endsWith('.home')
  ) {
    return true;
  }
  if (resolvedIp === '127.0.0.1' || resolvedIp === '::1') return true;
  if (resolvedIp.startsWith('10.') || resolvedIp.startsWith('192.168.')) return true;
  if (resolvedIp.startsWith('172.')) {
    const second = Number(resolvedIp.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (resolvedIp.startsWith('169.254.')) return true;
  const ipLower = resolvedIp.toLowerCase();
  return ipLower.startsWith('fc') || ipLower.startsWith('fd') || ipLower.startsWith('fe80:');
}

function getDefaultPortForNasProtocol(
  protocol: NasProtocolId,
  useTls: boolean,
  ftpsTlsMode: StoredNasConnection['ftpsTlsMode'] = 'explicit'
): number {
  switch (protocol) {
    case 'smb':
      return 445;
    case 'nfs':
      return 2049;
    case 'webdav':
      return useTls ? 5006 : 5005;
    case 'sftp':
      return 22;
    case 'ftps':
      return ftpsTlsMode === 'implicit' ? 990 : 21;
    case 'api_token':
      return useTls ? 5001 : 5000;
    case 'fritz_upnp':
      return 49000;
    default:
      return 445;
  }
}

function probeTcpConnection(
  ip: string,
  port: number,
  timeoutMs = 4000
): Promise<{ ok: boolean; latencyMs: number; errorCode?: string; errorMessage?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: { ok: boolean; errorCode?: string; errorMessage?: string }) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        ...result,
        latencyMs: Math.max(1, Date.now() - started),
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () =>
      finish({ ok: false, errorCode: 'ETIMEDOUT', errorMessage: `Zeitüberschreitung nach ${timeoutMs} ms` })
    );
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({ ok: false, errorCode: err.code, errorMessage: err.message })
    );

    try {
      socket.connect(port, ip);
    } catch (err) {
      finish({
        ok: false,
        errorMessage: err instanceof Error ? err.message : 'TCP-Verbindung fehlgeschlagen',
      });
    }
  });
}

app.put('/api/nas/connection', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const body = (req.body ?? {}) as {
    protocol?: NasProtocolId;
    host?: string;
    port?: string;
    shareOrPath?: string;
    username?: string;
    secret?: string;
    fritzUsername?: string;
    fritzPassword?: string;
    clearSecret?: boolean;
    clearFritzSecret?: boolean;
    domainOrWorkgroup?: string;
    nfsVersion?: StoredNasConnection['nfsVersion'];
    nfsAuthMode?: StoredNasConnection['nfsAuthMode'];
    sftpAuthMode?: StoredNasConnection['sftpAuthMode'];
    ftpsTlsMode?: StoredNasConnection['ftpsTlsMode'];
    apiVendor?: StoredNasConnection['apiVendor'];
    useTls?: boolean;
    backendPath?: string;
    backendProvisioned?: boolean;
    storageBridgeMode?: boolean;
  };

  if (!body.protocol || !VALID_NAS_PROTOCOLS.has(body.protocol)) {
    res.status(400).json({ error: 'Ungültiger NAS-Anmeldeweg ausgewählt.' });
    return;
  }

  const allowedProtocols = readAllowedNasProtocols();
  if (!allowedProtocols.includes(body.protocol)) {
    res.status(403).json({
      error: 'Dieser NAS-Anmeldeweg ist vom Administrator derzeit nicht freigegeben.',
    });
    return;
  }

  const isFritzUpnp = body.protocol === 'fritz_upnp';
  const parsedEndpoint = parseNasHostInput(
    (body.host ?? '').trim() || (isFritzUpnp ? 'fritz.box' : ''),
    body.port ?? '',
    body.shareOrPath ?? ''
  );
  const host = parsedEndpoint.hostname;
  const port = parsedEndpoint.port || (isFritzUpnp ? '49000' : '');
  const shareOrPath = parsedEndpoint.path || (isFritzUpnp ? '/MediaServer' : '');
  const nasUser = (body.username ?? '').trim();

  if (!host) {
    res.status(400).json({ error: 'Bitte gib eine NAS-IP-Adresse, einen Hostnamen oder eine URL an.' });
    return;
  }

  const store = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const existing = store.users[username] ?? getDefaultNasConnection();

  let nextEncryptedSecret = existing.encryptedSecret ?? null;
  if (body.clearSecret) {
    nextEncryptedSecret = null;
  } else if (typeof body.secret === 'string' && body.secret.length > 0) {
    nextEncryptedSecret = encryptNasSecret(body.secret);
  }

  let nextEncryptedFritzSecret = existing.encryptedFritzSecret ?? null;
  if (body.clearFritzSecret) {
    nextEncryptedFritzSecret = null;
  } else if (typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0) {
    nextEncryptedFritzSecret = encryptNasSecret(body.fritzPassword);
  }

  const resolvedUseTls =
    typeof body.useTls === 'boolean'
      ? body.useTls
      : parsedEndpoint.explicitScheme
        ? parsedEndpoint.explicitScheme === 'https'
        : isFritzUpnp
          ? port === '443' || port === '49443'
          : (existing.useTls ?? true);

  const nextRecord: StoredNasConnection = {
    protocol: body.protocol,
    host,
    port,
    shareOrPath: shareOrPath || '/',
    username: nasUser,
    encryptedSecret: nextEncryptedSecret,
    fritzUsername:
      typeof body.fritzUsername === 'string'
        ? body.fritzUsername.trim()
        : existing.fritzUsername ?? '',
    encryptedFritzSecret: nextEncryptedFritzSecret,
    accessMode: 'read_write',
    writePermissions: true,
    domainOrWorkgroup: (body.domainOrWorkgroup ?? 'WORKGROUP').trim() || 'WORKGROUP',
    nfsVersion: body.nfsVersion ?? existing.nfsVersion ?? 'NFSv4.1',
    nfsAuthMode: body.nfsAuthMode ?? existing.nfsAuthMode ?? 'AUTH_SYS',
    sftpAuthMode: body.sftpAuthMode ?? existing.sftpAuthMode ?? 'password',
    ftpsTlsMode: body.ftpsTlsMode ?? existing.ftpsTlsMode ?? 'explicit',
    apiVendor: body.apiVendor ?? existing.apiVendor ?? 'Synology DSM',
    useTls: resolvedUseTls,
    backendPath:
      typeof body.backendPath === 'string' ? body.backendPath.trim() : existing.backendPath ?? '',
    backendProvisioned:
      typeof body.backendProvisioned === 'boolean'
        ? body.backendProvisioned
        : Boolean(existing.backendProvisioned),
    storageBridgeMode:
      typeof body.storageBridgeMode === 'boolean'
        ? body.storageBridgeMode
        : Boolean(existing.storageBridgeMode),
    updatedAt: new Date().toISOString(),
  };

  store.users[username] = nextRecord;
  writeJsonAtomic('nas_connections.json', store);
  syncUserProfileDataSnapshot(username);
  appendWal('NAS_CONNECTION_UPDATED', username, {
    protocol: nextRecord.protocol,
    host: nextRecord.host,
    hasSecret: Boolean(nextRecord.encryptedSecret),
    hasFritzSecret: Boolean(nextRecord.encryptedFritzSecret),
    writePermissions: nextRecord.writePermissions,
  });

  res.json({
    connection: toPublicNasConnection(nextRecord),
    allowedProtocols,
  });
});

app.post('/api/nas/connection/test', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const startedAt = Date.now();
  const username = req.nasUsername!;
  const body = (req.body ?? {}) as {
    protocol?: NasProtocolId;
    host?: string;
    port?: string;
    username?: string;
    secret?: string;
    fritzUsername?: string;
    fritzPassword?: string;
    nfsAuthMode?: StoredNasConnection['nfsAuthMode'];
    ftpsTlsMode?: StoredNasConnection['ftpsTlsMode'];
    useTls?: boolean;
  };

  const store = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const saved = store.users[username];

  const protocol = body.protocol ?? saved?.protocol;
  const isFritzUpnp = protocol === 'fritz_upnp';
  const rawHost = (body.host ?? saved?.host ?? '').trim() || (isFritzUpnp ? 'fritz.box' : '');
  const rawPort = (body.port ?? saved?.port ?? '').trim() || (isFritzUpnp ? '49000' : '');
  const nasUser = (body.username ?? saved?.username ?? body.fritzUsername ?? saved?.fritzUsername ?? '').trim();
  const hasSecret =
    (typeof body.secret === 'string' && body.secret.length > 0) ||
    (typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0) ||
    Boolean(saved?.encryptedSecret) ||
    Boolean(saved?.encryptedFritzSecret);

  if (!protocol || !VALID_NAS_PROTOCOLS.has(protocol)) {
    res.status(400).json({ ok: false, error: 'Bitte wähle einen gültigen NAS-Anmeldeweg.' });
    return;
  }

  const allowedProtocols = readAllowedNasProtocols();
  if (!allowedProtocols.includes(protocol)) {
    res.status(403).json({
      ok: false,
      error: 'Dieser NAS-Anmeldeweg ist vom Administrator derzeit nicht freigegeben.',
    });
    return;
  }

  const parsedEndpoint = parseNasHostInput(rawHost, rawPort);
  const hostname = parsedEndpoint.hostname;
  if (!hostname) {
    res.status(400).json({ ok: false, error: 'Host / IP-Adresse für den Verbindungstest fehlt.' });
    return;
  }

  const requiresCredentials = !(
    isFritzUpnp ||
    (protocol === 'nfs' && (body.nfsAuthMode ?? saved?.nfsAuthMode) === 'AUTH_SYS')
  );

  if (requiresCredentials && !hasSecret) {
    res.status(400).json({
      ok: false,
      error:
        'Für diesen Anmeldeweg wird ein Passwort bzw. API-Token/Schlüssel benötigt.',
    });
    return;
  }

  const plainPassword =
    (typeof body.secret === 'string' && body.secret.length > 0
      ? body.secret
      : decryptNasSecret(saved?.encryptedSecret ?? null)) ||
    (typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0
      ? body.fritzPassword
      : decryptNasSecret(saved?.encryptedFritzSecret ?? null)) ||
    '';
  const plainFritzPassword =
    (typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0
      ? body.fritzPassword
      : decryptNasSecret(saved?.encryptedFritzSecret ?? null)) || plainPassword;

  const effectiveUseTls =
    typeof body.useTls === 'boolean'
      ? body.useTls
      : parsedEndpoint.explicitScheme
        ? parsedEndpoint.explicitScheme === 'https'
        : isFritzUpnp
          ? rawPort === '443' || rawPort === '49443'
          : (saved?.useTls ?? true);
  const effectiveFtpsMode = body.ftpsTlsMode ?? saved?.ftpsTlsMode ?? 'explicit';
  const defaultPort = getDefaultPortForNasProtocol(protocol, effectiveUseTls, effectiveFtpsMode);
  const numericPort = parsedEndpoint.port ? Number(parsedEndpoint.port) : defaultPort;

  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    res.status(400).json({ ok: false, error: `Ungültiger Port "${parsedEndpoint.port}".` });
    return;
  }

  let resolvedIp = hostname;
  if (net.isIP(hostname) === 0) {
    try {
      const lookup4 = await dns.lookup(hostname, { family: 4 }).catch(() => null);
      if (lookup4?.address) {
        resolvedIp = lookup4.address;
      } else {
        const lookupAny = await dns.lookup(hostname);
        resolvedIp = lookupAny.address;
      }
    } catch {
      res.status(502).json({
        ok: false,
        error: `DNS-Auflösung für "${hostname}" fehlgeschlagen. Prüfe Hostname, DynDNS/MyFRITZ-Domain oder Netzwerkverbindung.`,
      });
      return;
    }
  }

  const isLan = isLocalLanTargetStrict(hostname, resolvedIp) || isLocalOrLanAddress(hostname, resolvedIp);
  const scopeHint = (req.body as { scope?: string })?.scope;
  const effectiveScope: 'lan' | 'vpn' | 'internet' =
    scopeHint === 'vpn' ? 'vpn' : isLan ? 'lan' : 'internet';
  const scopeLabel =
    effectiveScope === 'vpn'
      ? 'VPN-Tunnel (Extern)'
      : isLan
        ? 'Lokales Netzwerk (LAN)'
        : 'Internet-Fernzugriff (Extern)';

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const adminNetworkConfig = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const allowLocalSelfSignedTls = isLan && adminNetworkConfig.allowLocalSelfSignedTls;

  // Sicherheitsrichtlinie: SMB niemals ungeschützt über öffentliches Internet ohne VPN!
  if (protocol === 'smb' && !isLan && effectiveScope !== 'vpn') {
    res.status(403).json({
      ok: false,
      blockedByVpnPolicy: true,
      scope: 'internet',
      resolvedIp,
      error:
        'SMB über das öffentliche Internet ist aus Sicherheitsgründen blockiert. Verbinde dich per VPN (WireGuard/IPsec) oder wechsle auf WebDAV (HTTPS) / SFTP.',
    });
    return;
  }

  // Echte Protokoll- und Authentifizierungs-Verifizierung (nicht nur TCP-Port-Check!)
  const realVerification = await testSingleUniversalProtocol({
    protocol,
    host: hostname,
    port: numericPort,
    shareOrPath: parsedEndpoint.path || saved?.shareOrPath || '/',
    username: nasUser,
    password: plainPassword,
    domainOrWorkgroup: saved?.domainOrWorkgroup,
    useTls: effectiveUseTls,
    ftpsTlsMode: effectiveFtpsMode,
    scope: effectiveScope,
    allowLocalSelfSignedTls,
    customCaPem: activeCert?.pem ?? null,
    timeoutMs: 4200,
  });

  if (realVerification.smb1Rejected) {
    res.status(400).json({
      ok: false,
      smb1Rejected: true,
      resolvedIp,
      verification: realVerification,
      error: realVerification.message,
    });
    return;
  }

  if (!realVerification.tcpOpen && !realVerification.protocolVerified) {
    const hint = isLan
      ? `Prüfe Firewall und ob der ${protocol.toUpperCase()}-Dienst auf Port ${numericPort} läuft.`
      : `Prüfe Router-Portweiterleitung (Port ${numericPort}), VPN-Tunnel oder Firewall.`;
    res.status(502).json({
      ok: false,
      latencyMs: realVerification.latencyMs,
      scope: effectiveScope,
      resolvedIp,
      verification: realVerification,
      error: `${realVerification.message} ${hint}`,
    });
    return;
  }

  if (!realVerification.protocolVerified) {
    res.status(502).json({
      ok: false,
      latencyMs: realVerification.latencyMs,
      scope: effectiveScope,
      resolvedIp,
      verification: realVerification,
      error: realVerification.message,
    });
    return;
  }

  if (realVerification.authAttempted && !realVerification.authVerified) {
    res.status(401).json({
      ok: false,
      latencyMs: realVerification.latencyMs,
      scope: effectiveScope,
      resolvedIp,
      requiresFritzCredentials: isFritzUpnp,
      fritzTracks: realVerification.fritzTracks ?? null,
      verification: realVerification,
      error: realVerification.message,
    });
    return;
  }

  let fritzTracks = realVerification.fritzTracks ?? null;
  if (isFritzUpnp && !fritzTracks) {
    fritzTracks = await evaluateFritzSeparatedTracks({
      hostname,
      resolvedIp,
      isLan,
      scope: effectiveScope,
      username: (body.fritzUsername ?? saved?.fritzUsername ?? nasUser).trim(),
      password: plainFritzPassword,
      shareOrPath: parsedEndpoint.path || saved?.shareOrPath,
      useTls: effectiveUseTls,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    }).catch(() => null);
  }

  const profileFolder = ensureUserProfileFolder(username);
  const nasWritable = Boolean(profileFolder?.writable);
  const totalLatencyMs = Math.max(1, Date.now() - startedAt);
  res.json({
    ok: true,
    latencyMs: realVerification.latencyMs ?? totalLatencyMs,
    scope: effectiveScope,
    resolvedIp,
    writable: nasWritable,
    writePermissions: isFritzUpnp ? Boolean(fritzTracks?.smbAccess.authVerified) : hasNasWriteAccess(username),
    smbDialect: realVerification.smbDialect ?? null,
    shareVerified: realVerification.shareVerified ?? false,
    fritzTracks,
    verification: realVerification,
    profileFolder,
    message: isFritzUpnp
      ? `${realVerification.message} (Hinweis: UPnP/DLNA nur für Medien · direkter Dateizugriff läuft getrennt über SMB 2/3 :445).`
      : `${realVerification.message} (${scopeLabel})`,
  });
});

// FRITZ!Box Challenge-Response Session-Management (login_sid.lua + TR-064)
interface StoredFritzSessionConfig {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  encryptedPassword: string | null;
  allowLocalSelfSignedTls: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

function readStoredFritzSessionConfig(): StoredFritzSessionConfig {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const raw = readJsonFile<Partial<StoredFritzSessionConfig>>('fritz_session.json', {});
  return {
    host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : 'fritz.box',
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : raw.useTls ? 443 : 80,
    useTls: typeof raw.useTls === 'boolean' ? raw.useTls : false,
    username: typeof raw.username === 'string' ? raw.username.trim() : '',
    encryptedPassword: typeof raw.encryptedPassword === 'string' ? raw.encryptedPassword : null,
    allowLocalSelfSignedTls:
      typeof raw.allowLocalSelfSignedTls === 'boolean'
        ? raw.allowLocalSelfSignedTls
        : networkCfg.allowLocalSelfSignedTls,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function buildFritzSessionClientFromInput(input?: {
  host?: string;
  port?: string | number;
  useTls?: boolean;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls?: boolean;
}): { client: FritzBoxSessionClient; stored: StoredFritzSessionConfig } {
  const stored = readStoredFritzSessionConfig();
  const activeCert = readCurrentSecurityCertificate();
  const normalized = normalizeFritzHostAndScheme(
    input?.host?.trim() || stored.host,
    input?.port ?? stored.port,
    typeof input?.useTls === 'boolean' ? input.useTls : stored.useTls
  );
  const username =
    typeof input?.username === 'string' ? input.username.trim() : stored.username;
  const plainPassword =
    typeof input?.password === 'string' && input.password.length > 0
      ? input.password
      : decryptNasSecret(stored.encryptedPassword) || '';
  const allowLocalSelfSignedTls =
    typeof input?.allowLocalSelfSignedTls === 'boolean'
      ? input.allowLocalSelfSignedTls
      : stored.allowLocalSelfSignedTls;

  const client = new FritzBoxSessionClient({
    host: normalized.host,
    port: normalized.port,
    useTls: normalized.useTls,
    username,
    password: plainPassword,
    allowLocalSelfSignedTls,
    customCaPem: activeCert?.pem ?? null,
  });
  return { client, stored };
}

app.get('/api/nas/fritz-session/status', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const queryHost = typeof req.query.host === 'string' ? req.query.host : undefined;
    const queryPort = typeof req.query.port === 'string' ? req.query.port : undefined;
    const queryUseTls =
      typeof req.query.useTls === 'string' ? req.query.useTls === 'true' : undefined;
    const queryUser = typeof req.query.username === 'string' ? req.query.username : undefined;

    const { client } = buildFritzSessionClientFromInput({
      host: queryHost,
      port: queryPort,
      useTls: queryUseTls,
      username: queryUser,
    });
    const status = await client.getStatusSnapshot();
    res.json(status);
  } catch (err) {
    res.status(502).json({
      connected: false,
      host: 'fritz.box',
      port: 80,
      useTls: false,
      username: '',
      hasSecret: false,
      sidPreview: null,
      challengeVersion: null,
      rights: [],
      obtainedAt: null,
      lastVerifiedAt: null,
      blockTimeSec: 0,
      tr064Available: false,
      allowLocalSelfSignedTls: true,
      message:
        err instanceof Error
          ? err.message
          : 'FRITZ!Box Status konnte nicht abgerufen werden.',
    });
  }
});

// Pre-Login & Client-kompatibler Challenge-Response Auth Endpunkt (behebt 404 bei fritzBoxDirectLoginWithSession)
app.post('/api/nas/fritz-session/auth', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    useTls?: boolean;
    username?: string;
    password?: string;
    allowLocalSelfSignedTls?: boolean;
    forceRefresh?: boolean;
  };
  try {
    const { client, stored } = buildFritzSessionClientFromInput(body);
    const authResult = await client.getValidSession(Boolean(body.forceRefresh));
    const snapshot = await client.getStatusSnapshot();
    if (authResult.ok) {
      const nextStored: StoredFritzSessionConfig = {
        host: client.host,
        port: client.port,
        useTls: client.useTls,
        username: client.username,
        encryptedPassword:
          typeof body.password === 'string' && body.password.length > 0
            ? encryptNasSecret(body.password)
            : stored.encryptedPassword,
        allowLocalSelfSignedTls: client.allowLocalSelfSignedTls,
        updatedAt: new Date().toISOString(),
        updatedBy: client.username || 'fritz-auth',
      };
      writeJsonAtomic('fritz_session.json', nextStored);
    }
    res.status(authResult.ok ? 200 : 401).json({
      ok: authResult.ok,
      status: snapshot,
      reused: authResult.reused,
      error: authResult.error,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'FRITZ!Box Challenge-Response Auth fehlgeschlagen.',
    });
  }
});

app.post('/api/nas/fritz-session/login', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const actor = req.nasUsername!;
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    useTls?: boolean;
    username?: string;
    password?: string;
    allowLocalSelfSignedTls?: boolean;
    forceRefresh?: boolean;
  };

  try {
    const { client, stored } = buildFritzSessionClientFromInput(body);
    const authResult = await client.getValidSession(Boolean(body.forceRefresh));
    if (authResult.ok) {
      const nextStored: StoredFritzSessionConfig = {
        host: client.host,
        port: client.port,
        useTls: client.useTls,
        username: client.username,
        encryptedPassword:
          typeof body.password === 'string' && body.password.length > 0
            ? encryptNasSecret(body.password)
            : stored.encryptedPassword,
        allowLocalSelfSignedTls: client.allowLocalSelfSignedTls,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      writeJsonAtomic('fritz_session.json', nextStored);
      appendWal('FRITZ_SESSION_AUTHENTICATED', actor, {
        host: client.host,
        port: client.port,
        useTls: client.useTls,
        reused: authResult.reused,
        challengeVersion: authResult.challengeVersion,
      });
    }

    const snapshot = await client.getStatusSnapshot();
    res.status(authResult.ok ? 200 : 401).json({
      ...snapshot,
      ok: authResult.ok,
      reused: authResult.reused,
      challenge: authResult.challenge,
      responseSignaturePreview: authResult.responseSignaturePreview,
      error: authResult.error,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      connected: false,
      error:
        err instanceof Error
          ? err.message
          : 'FRITZ!Box Challenge-Response Login fehlgeschlagen.',
    });
  }
});

app.post('/api/nas/fritz-session/browse', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    useTls?: boolean;
    username?: string;
    password?: string;
    path?: string;
    allowLocalSelfSignedTls?: boolean;
  };
  try {
    const { client } = buildFritzSessionClientFromInput(body);
    const result = await client.browseFritzNasFiles(body.path || '/');
    res.status(result.ok ? 200 : 401).json(result);
  } catch (err) {
    res.status(502).json({
      ok: false,
      sidPreview: null,
      path: body.path || '/',
      items: [],
      source: 'none',
      error:
        err instanceof Error
          ? err.message
          : 'FRITZ!NAS Verzeichnis konnte nicht geladen werden.',
    });
  }
});

app.post('/api/nas/fritz-session/logout', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const body = (req.body ?? {}) as {
    host?: string;
    port?: string | number;
    useTls?: boolean;
    username?: string;
  };
  try {
    const { client } = buildFritzSessionClientFromInput(body);
    await client.logout();
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// NAS-Verzeichnisbaum-Explorer & EntenCenter-Backend-Provisionierung (ohne Verbindungsabbruch bei fehlendem Backend)
function normalizeNasBrowserPath(rawPath?: string): string {
  const cleaned = (rawPath ?? '/').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!cleaned || cleaned === '/') return '/';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.replace(/\/+$/, '') || '/';
}

function getNasParentPath(currentPath: string): string | null {
  const normalized = normalizeNasBrowserPath(currentPath);
  if (normalized === '/') return null;
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx) || '/';
}

function getProvisionedHostStagingDir(host: string): string {
  const safeKey = (host.trim() || 'local-nas').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.resolve(NAS_DATA_DIR, 'provisioned-backends', safeKey);
}

function buildTemplateNasEntries(
  protocol: NasProtocolId,
  currentPath: string,
  host: string
): NasDirectoryTreeEntry[] {
  const norm = normalizeNasBrowserPath(currentPath);
  const stagingRoot = getProvisionedHostStagingDir(host);
  const dynamicChildren: NasDirectoryTreeEntry[] = [];

  try {
    const rel = norm === '/' ? '' : norm.replace(/^\/+/, '');
    const stagedDir = rel ? path.resolve(stagingRoot, rel) : stagingRoot;
    if (stagedDir.startsWith(stagingRoot) && fs.existsSync(stagedDir) && fs.statSync(stagedDir).isDirectory()) {
      for (const item of fs.readdirSync(stagedDir, { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        const itemPath = norm === '/' ? `/${item.name}` : `${norm}/${item.name}`;
        dynamicChildren.push({
          name: item.name,
          path: itemPath,
          type: item.isDirectory() ? 'directory' : 'file',
          writable: true,
        });
      }
    }
  } catch {
    // Staging-Abfrage optional
  }

  const presetMap: Record<string, NasDirectoryTreeEntry[]> = {
    '/':
      protocol === 'fritz_upnp'
        ? [
            { name: 'FRITZ', path: '/FRITZ', type: 'directory', writable: true, recommended: true },
            { name: 'Medien', path: '/Medien', type: 'directory', writable: true },
            { name: 'Bilder', path: '/Bilder', type: 'directory', writable: true },
            { name: 'Musik', path: '/Musik', type: 'directory', writable: true },
            { name: 'EntenCenter-Backend', path: '/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
          ]
        : protocol === 'nfs' || protocol === 'api_token'
          ? [
              { name: 'volume1', path: '/volume1', type: 'directory', writable: true, recommended: true },
              { name: 'Medien', path: '/Medien', type: 'directory', writable: true },
              { name: 'share', path: '/share', type: 'directory', writable: true },
              { name: 'EntenCenter-Backend', path: '/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
            ]
          : [
              { name: 'Medien', path: '/Medien', type: 'directory', writable: true, recommended: true },
              { name: 'Public', path: '/Public', type: 'directory', writable: true },
              { name: 'Home', path: '/Home', type: 'directory', writable: true },
              { name: 'EntenCenter-Backend', path: '/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
            ],
    '/FRITZ': [
      { name: 'mediabox', path: '/FRITZ/mediabox', type: 'directory', writable: true },
      { name: 'EntenCenter-Backend', path: '/FRITZ/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
    ],
    '/Medien': [
      { name: 'Filme', path: '/Medien/Filme', type: 'directory', writable: true },
      { name: 'Serien', path: '/Medien/Serien', type: 'directory', writable: true },
      { name: 'EntenCenter-Backend', path: '/Medien/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
    ],
    '/volume1': [
      { name: 'video', path: '/volume1/video', type: 'directory', writable: true },
      { name: 'docker', path: '/volume1/docker', type: 'directory', writable: true },
      { name: 'EntenCenter-Backend', path: '/volume1/EntenCenter-Backend', type: 'directory', writable: true, recommended: true },
    ],
  };

  const merged = new Map<string, NasDirectoryTreeEntry>();
  for (const entry of presetMap[norm] ?? []) {
    merged.set(entry.path, entry);
  }
  for (const dyn of dynamicChildren) {
    merged.set(dyn.path, dyn);
  }
  return Array.from(merged.values());
}

async function browseWebDavDirectory(params: {
  host: string;
  port: number;
  useTls: boolean;
  remotePath: string;
  username?: string;
  password?: string;
  allowLocalSelfSignedTls: boolean;
  customCaPem: string | null;
}): Promise<{ ok: boolean; entries: NasDirectoryTreeEntry[]; warning?: string | null }> {
  const scheme = params.useTls ? 'https' : 'http';
  const portSuffix =
    (params.useTls && params.port === 443) || (!params.useTls && params.port === 80)
      ? ''
      : `:${params.port}`;
  const cleanPath = normalizeNasBrowserPath(params.remotePath);
  const url = `${scheme}://${params.host}${portSuffix}${cleanPath === '/' ? '/' : cleanPath}`;
  const headers: Record<string, string> = {
    Depth: '1',
    Accept: 'application/xml, text/xml, */*',
  };
  if (params.username || params.password) {
    const token = Buffer.from(`${params.username ?? ''}:${params.password ?? ''}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  try {
    const res = await requestWithLocalTlsPolicy(url, {
      method: 'PROPFIND',
      headers,
      timeoutMs: 3500,
      allowLocalSelfSignedTls: params.allowLocalSelfSignedTls,
      customCaPem: params.customCaPem,
    });
    if (!res.ok) {
      return {
        ok: false,
        entries: [],
        warning: res.status === 401 ? 'WebDAV verlangt Benutzername und Passwort.' : `WebDAV HTTP ${res.status}`,
      };
    }
    const entries: NasDirectoryTreeEntry[] = [];
    const seen = new Set<string>();
    const responseBlocks = res.body.match(/<(?:[a-zA-Z0-9_-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?response>/gi) ?? [];
    for (const block of responseBlocks) {
      const hrefMatch = /<(?:[a-zA-Z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9_-]+:)?href>/i.exec(block);
      if (!hrefMatch?.[1]) continue;
      let decodedHref = hrefMatch[1].trim();
      try {
        decodedHref = decodeURIComponent(decodedHref.replace(/^https?:\/\/[^/]+/i, ''));
      } catch {
        // belassen
      }
      const normalizedItemPath = normalizeNasBrowserPath(decodedHref);
      if (normalizedItemPath === cleanPath || seen.has(normalizedItemPath)) continue;
      seen.add(normalizedItemPath);
      const isDir = /<(?:[a-zA-Z0-9_-]+:)?collection\b/i.test(block);
      const name = normalizedItemPath.split('/').filter(Boolean).pop() || normalizedItemPath;
      entries.push({
        name,
        path: normalizedItemPath,
        type: isDir ? 'directory' : 'file',
        writable: true,
      });
    }
    return { ok: true, entries };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      warning: err instanceof Error ? err.message : 'WebDAV-Verzeichnisabruf fehlgeschlagen',
    };
  }
}

app.post('/api/nas/storage/browse-tree', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    protocol?: NasProtocolId;
    host?: string;
    port?: string | number;
    path?: string;
    shareOrPath?: string;
    username?: string;
    secret?: string;
    password?: string;
    fritzUsername?: string;
    fritzPassword?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
  };

  const protocol: NasProtocolId =
    body.protocol && VALID_NAS_PROTOCOLS.has(body.protocol) ? body.protocol : 'fritz_upnp';
  const rawHost = (body.host ?? '').trim() || (protocol === 'fritz_upnp' ? 'fritz.box' : '192.168.178.1');
  const parsed = parseNasHostInput(rawHost, body.port ? String(body.port) : '', body.path ?? '/');
  const host = parsed.hostname || rawHost;
  const currentPath = normalizeNasBrowserPath(body.path ?? parsed.path ?? '/');
  const parentPath = getNasParentPath(currentPath);
  const password =
    typeof body.secret === 'string' && body.secret.length > 0
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';
  const fritzPassword =
    typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0
      ? body.fritzPassword
      : password;
  const username = (body.username ?? '').trim();
  const fritzUsername = (body.fritzUsername ?? username).trim();

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const allowLocalSelfSignedTls = normalizeAdminNetworkConfig(settings.networkConfig).allowLocalSelfSignedTls;
  const activeCert = readCurrentSecurityCertificate(settings);
  const recommendedBackendPath =
    protocol === 'fritz_upnp'
      ? '/FRITZ/EntenCenter-Backend'
      : currentPath === '/'
        ? '/EntenCenter-Backend'
        : `${currentPath}/EntenCenter-Backend`;

  let fritzWarning: string | null = null;
  let fritzRequiresAuth = false;
  let fritzHttpsFallback = false;

  if (protocol === 'fritz_upnp') {
    const useTls =
      typeof body.useTls === 'boolean'
        ? body.useTls
        : parsed.explicitScheme === 'https' || parsed.port === '443';
    const portNum = Number(parsed.port) || (useTls ? 443 : 80);
    const client = new FritzBoxSessionClient({
      host,
      port: portNum === 49000 || portNum === 49443 ? (useTls ? 443 : 80) : portNum,
      useTls,
      username: fritzUsername,
      password: fritzPassword,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });

    const probe = await FritzBoxSessionClient.probeLoginSid(
      host,
      allowLocalSelfSignedTls,
      activeCert?.pem ?? null,
      1400
    ).catch(() => null);
    fritzHttpsFallback = Boolean(probe && !probe.httpsAvailable && probe.httpAvailable);
    fritzRequiresAuth = Boolean(probe?.requiresAuth && fritzPassword.length === 0);

    if (fritzPassword.length > 0 || (probe?.detected && !probe.requiresAuth)) {
      const browseRes = await client.browseFritzNasFiles(currentPath).catch(() => null);
      if (browseRes?.ok && browseRes.source === 'fritz_nas_api') {
        const entries: NasDirectoryTreeEntry[] = browseRes.items.map((item) => ({
          name: item.name,
          path: normalizeNasBrowserPath(item.path),
          type: item.type,
          sizeBytes: item.sizeBytes,
          modifiedAt: item.modifiedAt,
          writable: true,
        }));
        const fritzDir = entries.find((e) => e.type === 'directory' && e.name.toLowerCase() === 'fritz');
        const resultPayload: NasBrowseTreeResult = {
          ok: true,
          host,
          protocol,
          currentPath,
          parentPath,
          entries,
          recommendedBackendPath: fritzDir
            ? `${fritzDir.path}/EntenCenter-Backend`
            : recommendedBackendPath,
          source: 'fritz_nas_api',
          liveFilesystem: true,
          requiresAuth: false,
          writable: true,
          warning: null,
        };
        res.json(resultPayload);
        return;
      }
      fritzWarning = browseRes?.error || 'FRITZ!NAS Web-API lieferte kein Verzeichnis-Listing — prüfe SMB2 (:445)…';
    } else if (probe?.requiresAuth && fritzPassword.length === 0) {
      fritzWarning =
        'FRITZ!Box verlangt Zugangsdaten zum Live-Durchsuchen. Bitte gib das FRITZ!Box-Passwort ein.';
    }
  }

  // SMB 2/3 (:445) Live-Browse für SMB oder als direkter FRITZ!NAS-Dateisystem-Fallback
  const smbPassword = password || fritzPassword;
  if (protocol === 'smb' || (protocol === 'fritz_upnp' && smbPassword.length > 0)) {
    const smbPort =
      protocol === 'smb' ? sanitizeSmbPort(parsed.port) : 445;
    const smbRes = await browseSmbDirectories({
      host,
      port: smbPort,
      path: currentPath,
      shareOrPath: body.shareOrPath || (protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
      username: username || fritzUsername,
      password: smbPassword,
      domainOrWorkgroup: body.domainOrWorkgroup,
    }).catch(() => null);

    if (smbRes?.ok) {
      const entries: NasDirectoryTreeEntry[] = smbRes.entries.map((entry) => ({
        name: entry.name,
        path: normalizeNasBrowserPath(entry.path),
        type: entry.type,
        sizeBytes: entry.sizeBytes,
        writable: smbRes.writable,
        recommended:
          entry.name.toLowerCase() === 'fritz' ||
          entry.name.toLowerCase().includes('entencenter'),
      }));
      const fritzDir = entries.find((e) => e.type === 'directory' && e.name.toLowerCase() === 'fritz');
      const resultPayload: NasBrowseTreeResult = {
        ok: true,
        host,
        protocol,
        currentPath,
        parentPath,
        entries,
        recommendedBackendPath: fritzDir
          ? `${fritzDir.path}/EntenCenter-Backend`
          : recommendedBackendPath,
        source: 'smb_live',
        liveFilesystem: true,
        smbShare: smbRes.shareName ?? null,
        requiresAuth: false,
        httpsFallbackToHttp: fritzHttpsFallback,
        writable: smbRes.writable,
        warning: smbRes.warning ?? null,
      };
      res.json(resultPayload);
      return;
    }

    const combinedWarning =
      smbRes?.warning ||
      fritzWarning ||
      (smbPassword.length === 0
        ? 'Für den Live-SMB-Dateizugriff bitte Benutzername & Passwort eingeben.'
        : 'SMB2 (:445) Verzeichnisabruf fehlgeschlagen — Vorlage wird angezeigt (Verbindung bleibt erhalten).');
    const resultPayload: NasBrowseTreeResult = {
      ok: true,
      host,
      protocol,
      currentPath,
      parentPath,
      entries: buildTemplateNasEntries(protocol, currentPath, host),
      recommendedBackendPath,
      source: 'nas_template',
      liveFilesystem: false,
      requiresAuth: smbPassword.length === 0 || fritzRequiresAuth || Boolean(smbRes?.warning?.includes('abgelehnt')),
      httpsFallbackToHttp: fritzHttpsFallback,
      writable: false,
      warning: combinedWarning,
    };
    res.json(resultPayload);
    return;
  }

  if (protocol === 'webdav') {
    const useTls = typeof body.useTls === 'boolean' ? body.useTls : parsed.explicitScheme !== 'http';
    const portNum = Number(parsed.port) || (useTls ? 5006 : 5005);
    const davRes = await browseWebDavDirectory({
      host,
      port: portNum,
      useTls,
      remotePath: currentPath,
      username,
      password,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    if (davRes.ok) {
      const resultPayload: NasBrowseTreeResult = {
        ok: true,
        host,
        protocol,
        currentPath,
        parentPath,
        entries: davRes.entries,
        recommendedBackendPath,
        source: 'webdav',
        liveFilesystem: true,
        writable: true,
      };
      res.json(resultPayload);
      return;
    }
    const resultPayload: NasBrowseTreeResult = {
      ok: true,
      host,
      protocol,
      currentPath,
      parentPath,
      entries: buildTemplateNasEntries(protocol, currentPath, host),
      recommendedBackendPath,
      source: 'nas_template',
      liveFilesystem: false,
      requiresAuth: Boolean(davRes.warning?.includes('Passwort')),
      writable: false,
      warning:
        davRes.warning ||
        'WebDAV-Verzeichnis konnte nicht live gelesen werden — Standard-Pfad-Vorlage wird als Zielauswahl angezeigt.',
    };
    res.json(resultPayload);
    return;
  }

  const resultPayload: NasBrowseTreeResult = {
    ok: true,
    host,
    protocol,
    currentPath,
    parentPath,
    entries: buildTemplateNasEntries(protocol, currentPath, host),
    recommendedBackendPath,
    source: 'nas_template',
    liveFilesystem: false,
    requiresAuth: fritzRequiresAuth || !password,
    httpsFallbackToHttp: fritzHttpsFallback,
    writable: false,
    warning:
      fritzWarning ||
      `Live-Dateibaum für ${protocol.toUpperCase()} benötigt eine aktive SMB/FRITZ!NAS/WebDAV-Anmeldung. Angezeigt werden editierbare Standard-Freigabepfade.`,
  };
  res.json(resultPayload);
});

app.post('/api/nas/storage/provision-backend', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    mode?: 'auto' | 'manual';
    createSingleFolder?: boolean;
    targetPath?: string;
    customFolderName?: string;
    shareOrPath?: string;
    protocol?: NasProtocolId;
    host?: string;
    port?: string | number;
    username?: string;
    secret?: string;
    password?: string;
    fritzUsername?: string;
    fritzPassword?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
    ownerUsername?: string;
  };

  const authHeader = req.headers.authorization;
  let authedUsername = (body.ownerUsername ?? '').trim().toLowerCase() || '';
  if (authHeader?.startsWith('Bearer ')) {
    const tokenVal = authHeader.slice(7).trim();
    const verified = verifyRawToken(tokenVal);
    if (verified) authedUsername = verified;
  }

  const mode: 'auto' | 'manual' = body.mode === 'manual' ? 'manual' : 'auto';
  const createSingleFolder = Boolean(body.createSingleFolder);
  const protocol: NasProtocolId =
    body.protocol && VALID_NAS_PROTOCOLS.has(body.protocol) ? body.protocol : 'fritz_upnp';
  const rawHost = (body.host ?? '').trim() || (protocol === 'fritz_upnp' ? 'fritz.box' : '192.168.178.1');
  const parsed = parseNasHostInput(rawHost, body.port ? String(body.port) : '', body.targetPath ?? '/');
  const host = parsed.hostname || rawHost;
  const password =
    typeof body.secret === 'string' && body.secret.length > 0
      ? body.secret
      : typeof body.password === 'string'
        ? body.password
        : '';
  const fritzPassword =
    typeof body.fritzPassword === 'string' && body.fritzPassword.length > 0
      ? body.fritzPassword
      : password;
  const username = (body.username ?? '').trim();
  const fritzUsername = (body.fritzUsername ?? username).trim();

  let chosenPath = normalizeNasBrowserPath(body.targetPath ?? (protocol === 'fritz_upnp' ? '/FRITZ' : '/'));
  const folderSuffix = (body.customFolderName ?? 'EntenCenter-Backend').trim().replace(/[\\/]+/g, '') || 'EntenCenter-Backend';
  if (!createSingleFolder) {
    if (mode === 'auto' && !body.targetPath) {
      chosenPath = protocol === 'fritz_upnp' ? `/FRITZ/${folderSuffix}` : `/${folderSuffix}`;
    } else if (!chosenPath.toLowerCase().endsWith(folderSuffix.toLowerCase()) && body.customFolderName) {
      chosenPath = chosenPath === '/' ? `/${folderSuffix}` : `${chosenPath}/${folderSuffix}`;
    } else if (chosenPath === '/') {
      chosenPath = `/${folderSuffix}`;
    }
  } else if (chosenPath === '/') {
    chosenPath = '/EntenCenter';
  }

  const relativeSubdirs = createSingleFolder
    ? []
    : ['profiles', 'media', 'media/movies', 'media/series', 'config', 'wal', 'backups'];
  const createdDirectories: string[] = [
    chosenPath,
    ...relativeSubdirs.map((sub) => `${chosenPath}/${sub}`),
  ];
  const createdFiles: string[] = createSingleFolder
    ? []
    : [
        `${chosenPath}/entencenter-backend.json`,
        `${chosenPath}/docker-compose.yml`,
        `${chosenPath}/start-entencenter.sh`,
      ];

  const manifestPayload = {
    app: 'EntenCenter NAS Backend',
    version: '1.0.0',
    host,
    protocol,
    backendPath: chosenPath,
    mode,
    ownerUsername: authedUsername || 'first-access',
    port: 3000,
    createdAt: new Date().toISOString(),
  };

  const composeContent = [
    'services:',
    '  entencenter-nas:',
    '    image: node:20-alpine',
    '    container_name: entencenter-nas',
    '    restart: unless-stopped',
    '    ports:',
    '      - "3000:3000"',
    '    volumes:',
    `      - .${chosenPath}:/app/data/marcente-nas`,
    '    command: sh -c "npm install && npm start"',
    '',
  ].join('\n');

  const startScriptContent = [
    '#!/usr/bin/env sh',
    `# EntenCenter NAS-Backend Startskript (${chosenPath})`,
    'export PORT=3000',
    'npx tsx server.ts',
    '',
  ].join('\n');

  // 1. Lokale NAS-Bridge-Ablage unter data/marcente-nas/provisioned-backends/<host> anlegen
  const stagingRoot = getProvisionedHostStagingDir(host);
  const relTarget = chosenPath.replace(/^\/+/, '');
  const localBackendDir = path.resolve(stagingRoot, relTarget);
  fs.mkdirSync(localBackendDir, { recursive: true });
  for (const sub of relativeSubdirs) {
    fs.mkdirSync(path.resolve(localBackendDir, sub), { recursive: true });
  }
  if (!createSingleFolder) {
    fs.writeFileSync(
      path.resolve(localBackendDir, 'entencenter-backend.json'),
      JSON.stringify(manifestPayload, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.resolve(localBackendDir, 'docker-compose.yml'), composeContent, 'utf8');
    fs.writeFileSync(path.resolve(localBackendDir, 'start-entencenter.sh'), startScriptContent, 'utf8');
  }

  // 2. Direkte Remote-Ordneranlage über FRITZ!NAS Web-API, SMB2 (:445) oder WebDAV
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const allowLocalSelfSignedTls = normalizeAdminNetworkConfig(settings.networkConfig).allowLocalSelfSignedTls;
  const activeCert = readCurrentSecurityCertificate(settings);
  let dirsOk = false;
  let filesOk = createSingleFolder;
  let remoteWriteOk = false;
  let warning: string | null = null;
  let fritzClient: FritzBoxSessionClient | null = null;

  if (protocol === 'fritz_upnp' && fritzPassword.length > 0) {
    const useTls =
      typeof body.useTls === 'boolean'
        ? body.useTls
        : parsed.explicitScheme === 'https' || parsed.port === '443';
    const rawPortNum = Number(parsed.port) || (useTls ? 443 : 80);
    const safeHttpPort = [445, 139, 21, 22, 5005, 5006, 49000, 49443].includes(rawPortNum)
      ? (useTls || rawPortNum === 49443 ? 443 : 80)
      : rawPortNum;
    fritzClient = new FritzBoxSessionClient({
      host,
      port: safeHttpPort,
      useTls: useTls || safeHttpPort === 443,
      username: fritzUsername,
      password: fritzPassword,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    const parentOfChosen = getNasParentPath(chosenPath) || '/';
    const baseName = chosenPath.split('/').filter(Boolean).pop() || 'EntenCenter-Backend';
    const mkdirMain = await fritzClient.createFritzNasDirectory(parentOfChosen, baseName).catch(() => null);
    if (mkdirMain?.ok) {
      let subsOk = true;
      for (const sub of relativeSubdirs) {
        const subRes = await fritzClient.createFritzNasDirectory(chosenPath, sub).catch(() => null);
        if (!subRes?.ok) subsOk = false;
      }
      if (createSingleFolder || subsOk) {
        dirsOk = true;
      }
    } else if (mkdirMain?.error) {
      warning = mkdirMain.error;
    }
  }

  // SMB2 (:445) Schreibweg für SMB oder als Haupt-/Fallback-Weg für FRITZ!NAS (schreibt echte Ordner + Dateien!)
  const smbPassword = password || fritzPassword;
  if ((protocol === 'smb' || (protocol === 'fritz_upnp' && (!dirsOk || !filesOk))) && smbPassword.length > 0) {
    const smbRes = await provisionSmbBackend({
      host,
      port: protocol === 'smb' ? sanitizeSmbPort(parsed.port) : 445,
      targetPath: chosenPath,
      shareOrPath: body.shareOrPath || (protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
      username: username || fritzUsername,
      password: smbPassword,
      domainOrWorkgroup: body.domainOrWorkgroup,
      subdirs: relativeSubdirs,
      files: createSingleFolder
        ? []
        : [
            { name: 'entencenter-backend.json', content: JSON.stringify(manifestPayload, null, 2) },
            { name: 'docker-compose.yml', content: composeContent },
            { name: 'start-entencenter.sh', content: startScriptContent },
          ],
    }).catch((e) => ({ ok: false, warning: e instanceof Error ? e.message : 'SMB-Fehler' }));

    if (smbRes.ok) {
      dirsOk = true;
      filesOk = true;
      warning = null;
    } else if (smbRes.warning) {
      warning = warning ? `${warning} · SMB: ${smbRes.warning}` : smbRes.warning;
    }
  }

  // Falls Web-API Ordner existieren, aber SMB2 Dateien nicht schreiben konnte -> Web-API Upload versuchen
  if (!createSingleFolder && dirsOk && !filesOk && fritzClient) {
    const up1 = await fritzClient
      .uploadFritzNasTextFile(chosenPath, 'entencenter-backend.json', JSON.stringify(manifestPayload, null, 2))
      .catch(() => ({ ok: false, error: 'Web-API Upload fehlgeschlagen' }));
    const up2 = await fritzClient
      .uploadFritzNasTextFile(chosenPath, 'docker-compose.yml', composeContent)
      .catch(() => ({ ok: false, error: 'Web-API Upload fehlgeschlagen' }));
    const up3 = await fritzClient
      .uploadFritzNasTextFile(chosenPath, 'start-entencenter.sh', startScriptContent)
      .catch(() => ({ ok: false, error: 'Web-API Upload fehlgeschlagen' }));
    if (up1.ok && up2.ok && up3.ok) {
      filesOk = true;
      warning = null;
    } else {
      const upErr = up1.error || up2.error || up3.error;
      if (upErr) {
        warning = warning ? `${warning} · Web-API Upload: ${upErr}` : upErr;
      }
    }
  }

  remoteWriteOk = createSingleFolder ? dirsOk : dirsOk && filesOk;

  if (protocol === 'webdav') {
    const useTls = typeof body.useTls === 'boolean' ? body.useTls : parsed.explicitScheme !== 'http';
    const portNum = Number(parsed.port) || (useTls ? 5006 : 5005);
    const scheme = useTls ? 'https' : 'http';
    const portSuffix =
      (useTls && portNum === 443) || (!useTls && portNum === 80) ? '' : `:${portNum}`;
    const authHeaders: Record<string, string> = {};
    if (username || password) {
      authHeaders.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    }
    try {
      const mkRes = await requestWithLocalTlsPolicy(`${scheme}://${host}${portSuffix}${chosenPath}`, {
        method: 'MKCOL',
        headers: authHeaders,
        timeoutMs: 3500,
        allowLocalSelfSignedTls,
        customCaPem: activeCert?.pem ?? null,
      });
      if (mkRes.ok || mkRes.status === 201 || mkRes.status === 405) {
        dirsOk = true;
        for (const sub of relativeSubdirs) {
          await requestWithLocalTlsPolicy(`${scheme}://${host}${portSuffix}${chosenPath}/${sub}`, {
            method: 'MKCOL',
            headers: authHeaders,
            timeoutMs: 2500,
            allowLocalSelfSignedTls,
            customCaPem: activeCert?.pem ?? null,
          }).catch(() => null);
        }
        if (!createSingleFolder) {
          const putRes = await requestWithLocalTlsPolicy(
            `${scheme}://${host}${portSuffix}${chosenPath}/entencenter-backend.json`,
            {
              method: 'PUT',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify(manifestPayload, null, 2),
              timeoutMs: 3000,
              allowLocalSelfSignedTls,
              customCaPem: activeCert?.pem ?? null,
            }
          ).catch(() => null);
          filesOk = Boolean(putRes?.ok);
        }
        remoteWriteOk = createSingleFolder ? dirsOk : dirsOk && filesOk;
      }
    } catch {
      warning =
        'WebDAV-Ordneranlage konnte remote nicht abgeschlossen werden — Bridge-Konfiguration lokal gesichert.';
    }
  }

  if (!remoteWriteOk && !warning) {
    warning =
      dirsOk && !filesOk
        ? `Ordnerstruktur unter "${chosenPath}" vorhanden, aber Dateien konnten nicht auf dem NAS gespeichert werden (prüfe SMB2 / Schreibrechte).`
        : 'Remote-Schreibzugriff auf dem NAS wurde nicht direkt bestätigt — bitte Schreibrechte in der FRITZ!Box aktivieren. Die Storage-Bridge bleibt ohne Verbindungsabbruch aktiv.';
  }

  // 3. Falls Benutzer angemeldet ist und kein reiner Unterordner-Click war, Verbindung direkt aktualisieren (kein Abbruch)
  if (authedUsername && !createSingleFolder) {
    const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
    const existing = connStore.users[authedUsername] ?? getDefaultNasConnection();
    connStore.users[authedUsername] = {
      ...existing,
      protocol,
      host,
      port: parsed.port || existing.port || (protocol === 'fritz_upnp' ? '80' : '445'),
      shareOrPath: chosenPath,
      username: username || existing.username,
      encryptedSecret: password ? encryptNasSecret(password) : existing.encryptedSecret,
      fritzUsername: fritzUsername || existing.fritzUsername,
      encryptedFritzSecret:
        fritzPassword && fritzPassword !== password
          ? encryptNasSecret(fritzPassword)
          : existing.encryptedFritzSecret,
      backendPath: chosenPath,
      backendProvisioned: true,
      storageBridgeMode: true,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic('nas_connections.json', connStore);
    appendWal('NAS_BACKEND_PROVISIONED', authedUsername, {
      host,
      protocol,
      mode,
      backendPath: chosenPath,
      remoteWriteOk,
    });
  }

  const responsePayload: NasProvisionBackendResult = {
    ok: true,
    mode,
    host,
    protocol,
    backendPath: chosenPath,
    createdDirectories,
    createdFiles,
    remoteWriteOk,
    localBridgeReady: true,
    connectionKeptAlive: true,
    message: createSingleFolder
      ? remoteWriteOk
        ? `Ordner "${chosenPath}" direkt auf ${host} angelegt.`
        : `Ordner "${chosenPath}" in der Storage-Bridge vorgemerkt (Remote-Schreibrechte prüfen).`
      : remoteWriteOk
        ? `EntenCenter-Backend unter "${chosenPath}" direkt auf ${host} erstellt & NAS-Bridge aktiv.`
        : dirsOk && !filesOk
          ? `Ordnerstruktur "${chosenPath}" vorhanden, aber Dateien konnten noch nicht auf ${host} geschrieben werden.`
          : `EntenCenter-Backend-Struktur für "${chosenPath}" (${host}) als Storage-Bridge eingerichtet (kein direkter Remote-Schreibzugriff bestätigt).`,
    instructions: createSingleFolder
      ? [`Zielordner: ${chosenPath}`]
      : [
          `Zielpfad auf dem NAS: ${chosenPath}`,
          'Unterordner: profiles/, media/, config/, wal/, backups/',
          'Startdateien: entencenter-backend.json, docker-compose.yml, start-entencenter.sh',
        ],
    warning,
  };

  res.json(responsePayload);
});

app.post('/api/nas/storage/write-file', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    protocol?: string;
    host?: string;
    port?: string | number;
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    fritzPassword?: string;
    domainOrWorkgroup?: string;
    useTls?: boolean;
    targetPath?: string;
    content?: string;
    contentBase64?: string;
    offset?: number;
    append?: boolean;
    createParentDirs?: boolean;
  };
  const parsed = parseNasHostInput(body.host || '', body.port ? String(body.port) : '');
  const host = parsed.hostname || cleanHostInput(body.host || '').hostname;
  const protocol = (body.protocol || 'fritz_upnp').toLowerCase();
  const targetPath = `/${(body.targetPath || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  if (!host || targetPath === '/') {
    res.status(400).json({ ok: false, error: 'Host und gültiger Ziel-Dateipfad erforderlich.' });
    return;
  }
  const password = body.password ?? body.secret ?? body.fritzPassword ?? '';
  const data = body.contentBase64
    ? Buffer.from(body.contentBase64, 'base64')
    : Buffer.from(body.content ?? '', 'utf8');

  if (protocol === 'webdav') {
    const useTls = typeof body.useTls === 'boolean' ? body.useTls : parsed.explicitScheme !== 'http';
    const portNum = Number(body.port || parsed.port) || (useTls ? 5006 : 5005);
    const scheme = useTls ? 'https' : 'http';
    const portSuffix = (useTls && portNum === 443) || (!useTls && portNum === 80) ? '' : `:${portNum}`;
    const settings = readJsonFile<NasSyncSettings>('settings.json', { syncMode: 'manual', lastScanTimestamp: null });
    const allowLocalSelfSignedTls = normalizeAdminNetworkConfig(settings.networkConfig).allowLocalSelfSignedTls;
    const activeCert = readCurrentSecurityCertificate(settings);
    const authHeaders: Record<string, string> = {};
    if (body.username || password) {
      authHeaders.Authorization = `Basic ${Buffer.from(`${body.username || ''}:${password}`, 'utf8').toString('base64')}`;
    }
    try {
      const putRes = await requestWithLocalTlsPolicy(`${scheme}://${host}${portSuffix}${targetPath}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
        body: data,
        timeoutMs: 12000,
        allowLocalSelfSignedTls,
        customCaPem: activeCert?.pem ?? null,
      });
      res.json({
        ok: putRes.ok,
        transport: 'webdav',
        filePath: targetPath,
        bytesWritten: data.length,
        verified: putRes.ok,
        error: putRes.ok ? undefined : `WebDAV PUT HTTP ${putRes.status}`,
      });
    } catch (e) {
      res.json({ ok: false, filePath: targetPath, error: e instanceof Error ? e.message : 'WebDAV-Schreibfehler' });
    }
    return;
  }

  const smbResult = await writeSmbFile({
    host,
    port: protocol === 'smb' ? sanitizeSmbPort(body.port || parsed.port) : 445,
    targetPath,
    shareOrPath: body.shareOrPath || (protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
    username: body.username || '',
    password,
    domainOrWorkgroup: body.domainOrWorkgroup,
    data,
    offset: body.offset,
    append: body.append,
    createParentDirs: body.createParentDirs,
  }).catch((e) => ({ ok: false, filePath: targetPath, error: e instanceof Error ? e.message : 'SMB-Fehler' }));

  if (smbResult.ok) {
    res.json({ ...smbResult, transport: 'smb' });
    return;
  }

  // Web-API Fallback für vollständige Dateien auf FRITZ!NAS
  if (protocol === 'fritz_upnp' && !body.append && !(body.offset && body.offset > 0) && password) {
    const useTls = typeof body.useTls === 'boolean' ? body.useTls : parsed.explicitScheme === 'https';
    const rawPortNum = Number(body.port || parsed.port) || (useTls ? 443 : 80);
    const safeHttpPort = [445, 139, 21, 22, 5005, 5006, 49000, 49443].includes(rawPortNum)
      ? (useTls || rawPortNum === 49443 ? 443 : 80)
      : rawPortNum;
    const settings = readJsonFile<NasSyncSettings>('settings.json', { syncMode: 'manual', lastScanTimestamp: null });
    const allowLocalSelfSignedTls = normalizeAdminNetworkConfig(settings.networkConfig).allowLocalSelfSignedTls;
    const activeCert = readCurrentSecurityCertificate(settings);
    const client = new FritzBoxSessionClient({
      host,
      port: safeHttpPort,
      useTls: useTls || safeHttpPort === 443,
      username: body.username || '',
      password,
      allowLocalSelfSignedTls,
      customCaPem: activeCert?.pem ?? null,
    });
    const lastSlash = targetPath.lastIndexOf('/');
    const parentDir = lastSlash <= 0 ? '/' : targetPath.slice(0, lastSlash);
    const fileName = targetPath.slice(lastSlash + 1);
    if (body.createParentDirs !== false && parentDir !== '/') {
      const parentOfParent = getNasParentPath(parentDir) || '/';
      const dirName = parentDir.split('/').filter(Boolean).pop() || '';
      if (dirName) await client.createFritzNasDirectory(parentOfParent, dirName).catch(() => null);
    }
    const up = await client.uploadFritzNasTextFile(parentDir, fileName, data).catch((e) => ({
      ok: false,
      filePath: targetPath,
      error: e instanceof Error ? e.message : 'Web-API Upload fehlgeschlagen',
    }));
    if (up.ok) {
      res.json({ ok: true, transport: 'fritz_nas_api', filePath: targetPath, bytesWritten: data.length, verified: true });
      return;
    }
    res.json({
      ok: false,
      filePath: targetPath,
      error: [smbResult.error, up.error].filter(Boolean).join(' · '),
    });
    return;
  }

  res.json(smbResult);
});

app.post('/api/nas/storage/read-file', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    protocol?: string;
    host?: string;
    port?: string | number;
    shareOrPath?: string;
    username?: string;
    password?: string;
    secret?: string;
    fritzPassword?: string;
    domainOrWorkgroup?: string;
    targetPath?: string;
  };
  const parsed = parseNasHostInput(body.host || '', body.port ? String(body.port) : '');
  const host = parsed.hostname || cleanHostInput(body.host || '').hostname;
  const protocol = (body.protocol || 'fritz_upnp').toLowerCase();
  const targetPath = `/${(body.targetPath || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  const password = body.password ?? body.secret ?? body.fritzPassword ?? '';
  if (!host || targetPath === '/' || !password) {
    res.status(400).json({ ok: false, error: 'Host, Pfad und Passwort erforderlich.' });
    return;
  }
  const result = await readSmbFile({
    host,
    port: protocol === 'smb' ? sanitizeSmbPort(body.port || parsed.port) : 445,
    targetPath,
    shareOrPath: body.shareOrPath || (protocol === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
    username: body.username || '',
    password,
    domainOrWorkgroup: body.domainOrWorkgroup,
  }).catch((e) => ({ ok: false, filePath: targetPath, error: e instanceof Error ? e.message : 'Lesefehler' }));
  res.json(result);
});

app.get('/api/nas/storage/stream', async (req: Request, res: Response) => {
  const username = resolveTokenFromRequest(req);
  if (!username) {
    res.status(401).json({ error: 'Ungültige oder fehlende NAS-Session.' });
    return;
  }

  const mediaId = typeof req.query.mediaId === 'string' ? req.query.mediaId.trim() : '';
  const rawQueryPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  let resolvedNasPath = rawQueryPath;
  let catalogItem: NasLibraryRecord | undefined;

  if (mediaId) {
    const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
    catalogItem = catalog.find((entry) => entry.id === mediaId);
    if (!catalogItem) {
      res.status(404).json({ error: 'Katalogeintrag nicht gefunden.' });
      return;
    }
    const userFskLimit = getUserFskLimit(username);
    if (normalizeFskLimit(catalogItem.fsk, 0) > userFskLimit) {
      res.status(403).json({ error: 'Inhalt durch Altersfreigabe (FSK) gesperrt.' });
      return;
    }
    resolvedNasPath = catalogItem.nasPath || resolvedNasPath;
  }

  if (!resolvedNasPath) {
    res.status(400).json({ error: 'Kein NAS-Dateipfad zum Streamen angegeben.' });
    return;
  }

  const isDownload = req.query.download === '1';
  const mimeType = inferMimeType(resolvedNasPath, catalogItem?.uploadedMimeType);
  const downloadName = path.basename(resolvedNasPath.replace(/\\/g, '/')) || 'media.bin';
  const rangeHeader = !isDownload ? req.headers.range : undefined;

  // 1. Falls lokal gemountete Datei existiert -> direkt mit Range streamen
  if (!/^smb:\/\//i.test(resolvedNasPath) && fs.existsSync(resolvedNasPath) && fs.statSync(resolvedNasPath).isFile()) {
    const stat = fs.statSync(resolvedNasPath);
    const fileSize = stat.size;
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
    }
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < fileSize) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', String(end - start + 1));
          res.setHeader('Content-Type', mimeType);
          fs.createReadStream(resolvedNasPath, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader('Content-Type', mimeType);
    fs.createReadStream(resolvedNasPath).pipe(res);
    return;
  }

  // 2. SMB2 / FRITZ!NAS Streaming anhand gespeicherter NAS-Verbindung
  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  const activeConn =
    connStore.users[username] ??
    Object.values(connStore.users).find((c) => Boolean(c?.host && (c.encryptedSecret || c.encryptedFritzSecret)));

  const smbHostMatch = /^smb:\/\/([^/]+)(\/.*)$/i.exec(resolvedNasPath);
  const connHost = cleanHostInput(smbHostMatch ? smbHostMatch[1] : activeConn?.host || '').hostname;
  const targetPath = `/${(smbHostMatch ? smbHostMatch[2] : resolvedNasPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  const secret = activeConn ? decryptNasSecret(activeConn.encryptedSecret || activeConn.encryptedFritzSecret) : '';

  if (!connHost || !secret || targetPath === '/') {
    res.status(404).json({ error: 'Keine aktive SMB-/FRITZ!NAS-Verbindung für den Direktstream hinterlegt.' });
    return;
  }

  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      rangeStart = match[1] ? Number(match[1]) : 0;
      if (match[2]) rangeEnd = Number(match[2]);
    }
  }

  let closedByClient = false;
  req.on('close', () => {
    closedByClient = true;
  });

  let headersSent = false;
  const streamRes = await statAndStreamSmbFileRange({
    host: connHost,
    port: activeConn?.protocol === 'smb' ? sanitizeSmbPort(activeConn.port) : 445,
    targetPath,
    shareOrPath: activeConn?.shareOrPath || (activeConn?.protocol === 'fritz_upnp' || connHost.includes('fritz') ? 'FRITZ.NAS' : '/'),
    username: activeConn?.username || activeConn?.fritzUsername || '',
    password: secret,
    domainOrWorkgroup: activeConn?.domainOrWorkgroup,
    rangeStart,
    rangeEnd,
    isHeadOnly: req.method === 'HEAD',
    onMetadata: (totalSize, startByte, endByte) => {
      if (closedByClient) return false;
      const hasRange = rangeStart !== undefined || rangeEnd !== undefined;
      if (hasRange && totalSize > 0 && startByte >= totalSize) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        headersSent = true;
        return false;
      }
      const contentLen = totalSize <= 0 ? 0 : Math.max(0, endByte - startByte + 1);
      if (hasRange && totalSize > 0) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalSize}`);
      } else {
        res.status(200);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(contentLen));
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=60');
      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
      }
      headersSent = true;
      return req.method !== 'HEAD';
    },
    onChunk: async (chunk) => {
      if (closedByClient || res.writableEnded) return false;
      const ok = res.write(chunk);
      if (!ok) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
      return !closedByClient;
    },
  }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : 'SMB-Streamfehler' }));

  if (!headersSent && !streamRes.ok) {
    res.status(502).json({ error: streamRes.error || 'Mediendatei konnte nicht vom NAS gestreamt werden.' });
    return;
  }
  if (!res.writableEnded) {
    res.end();
  }
});

// Modulare NAS-Verbindungsprofile (Lokal LAN + Externe NAS via DynDNS / Domain / VPN / Reverse Proxy)
interface StoredNasProfileRecord extends Omit<NasConnectionProfile, 'hasSecret'> {
  ownerUsername: string;
  encryptedSecret: string | null;
}

interface NasProfilesStore {
  profiles: StoredNasProfileRecord[];
}

const VALID_NAS_PROFILE_SCOPES = new Set<NasProfileScope>([
  'lan',
  'wan_dyndns',
  'domain_https',
  'vpn',
  'reverse_proxy',
]);

function toPublicNasProfile(record: StoredNasProfileRecord): NasConnectionProfile {
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    shareOrPath: record.shareOrPath,
    username: record.username,
    hasSecret: Boolean(record.encryptedSecret),
    useTls: record.useTls,
    allowSelfSignedLocalTls: record.allowSelfSignedLocalTls,
    ddnsOrVpnHint: record.ddnsOrVpnHint,
    domainOrWorkgroup: record.domainOrWorkgroup,
    nfsVersion: record.nfsVersion,
    nfsAuthMode: record.nfsAuthMode,
    sftpAuthMode: record.sftpAuthMode,
    ftpsTlsMode: record.ftpsTlsMode,
    apiVendor: record.apiVendor,
    priority: record.priority,
    isActive: record.isActive,
    lastTestedAt: record.lastTestedAt ?? null,
    lastTestOk: record.lastTestOk ?? null,
    lastTestMessage: record.lastTestMessage ?? null,
    lastLatencyMs: record.lastLatencyMs ?? null,
    updatedAt: record.updatedAt,
  };
}

function readAndSeedNasProfilesStore(username: string): NasProfilesStore {
  const store = readJsonFile<NasProfilesStore>('nas_profiles.json', { profiles: [] });
  if (!Array.isArray(store.profiles)) {
    store.profiles = [];
  }
  if (store.profiles.length === 0) {
    const nowIso = new Date().toISOString();
    const settings = readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
    const netCfg = normalizeAdminNetworkConfig(settings.networkConfig);
    const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
    const userConn = connStore.users[username];

    if (userConn && userConn.host) {
      const scope: NasProfileScope = isLocalOrLanAddress(userConn.host, userConn.host)
        ? 'lan'
        : 'domain_https';
      store.profiles.push({
        id: `prof-primary-${Date.now()}`,
        ownerUsername: username,
        name: userConn.protocol === 'fritz_upnp' ? 'FRITZ!Box Heimnetz (UPnP)' : 'Aktives NAS-Profil',
        scope,
        protocol: userConn.protocol,
        host: userConn.host,
        port: userConn.port || '445',
        shareOrPath: userConn.shareOrPath || '/',
        username: userConn.username || '',
        encryptedSecret: userConn.encryptedSecret ?? null,
        useTls: userConn.useTls ?? true,
        allowSelfSignedLocalTls: netCfg.allowLocalSelfSignedTls,
        domainOrWorkgroup: userConn.domainOrWorkgroup || 'WORKGROUP',
        nfsVersion: userConn.nfsVersion ?? 'NFSv4.1',
        nfsAuthMode: userConn.nfsAuthMode ?? 'AUTH_SYS',
        sftpAuthMode: userConn.sftpAuthMode ?? 'password',
        ftpsTlsMode: userConn.ftpsTlsMode ?? 'explicit',
        apiVendor: userConn.apiVendor ?? 'Synology DSM',
        priority: 1,
        isActive: true,
        updatedAt: nowIso,
      });
    }
    if (netCfg.lanAddress) {
      const parsedLan = parseNasHostInput(netCfg.lanAddress);
      if (parsedLan.hostname && !store.profiles.some((p) => p.host === parsedLan.hostname)) {
        store.profiles.push({
          id: `prof-lan-${Date.now() + 1}`,
          ownerUsername: username,
          name: 'Lokales Heim-NAS (LAN)',
          scope: 'lan',
          protocol: 'api_token',
          host: parsedLan.hostname,
          port: parsedLan.port || (parsedLan.explicitScheme === 'https' ? '443' : '3000'),
          shareOrPath: parsedLan.path || '/',
          username: '',
          encryptedSecret: null,
          useTls: parsedLan.explicitScheme === 'https',
          allowSelfSignedLocalTls: netCfg.allowLocalSelfSignedTls,
          apiVendor: 'Synology DSM',
          priority: 2,
          isActive: store.profiles.length === 0,
          updatedAt: nowIso,
        });
      }
    }
    if (netCfg.remoteAddress) {
      const parsedRem = parseNasHostInput(netCfg.remoteAddress);
      if (parsedRem.hostname) {
        const mappedScope: NasProfileScope =
          netCfg.remoteTransport === 'vpn'
            ? 'vpn'
            : netCfg.remoteTransport === 'reverse_proxy'
              ? 'reverse_proxy'
              : 'wan_dyndns';
        store.profiles.push({
          id: `prof-remote-${Date.now() + 2}`,
          ownerUsername: username,
          name: 'Externes NAS (Remote)',
          scope: mappedScope,
          protocol: 'webdav',
          host: parsedRem.hostname,
          port: parsedRem.port || (parsedRem.explicitScheme === 'http' ? '80' : '443'),
          shareOrPath: parsedRem.path || '/',
          username: '',
          encryptedSecret: null,
          useTls: parsedRem.explicitScheme !== 'http',
          allowSelfSignedLocalTls: false,
          ddnsOrVpnHint: netCfg.remoteAddress,
          priority: 3,
          isActive: false,
          updatedAt: nowIso,
        });
      }
    }
    if (store.profiles.length > 0) {
      writeJsonAtomic('nas_profiles.json', store);
    }
  }
  return store;
}

app.get('/api/nas/connection/profiles', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const store = readAndSeedNasProfilesStore(username);
  const visible = store.profiles
    .filter((p) => p.ownerUsername === username || p.scope === 'lan' || p.scope === 'wan_dyndns' || p.scope === 'domain_https' || p.scope === 'vpn' || p.scope === 'reverse_proxy')
    .sort((a, b) => (a.isActive === b.isActive ? a.priority - b.priority : a.isActive ? -1 : 1));
  res.json({ profiles: visible.map(toPublicNasProfile) });
});

app.post('/api/nas/connection/profiles', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const body = (req.body ?? {}) as Partial<NasConnectionProfile> & {
    secret?: string;
    clearSecret?: boolean;
  };

  const name = (body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'Bitte gib einen Profilnamen an.' });
    return;
  }
  if (!body.protocol || !VALID_NAS_PROTOCOLS.has(body.protocol)) {
    res.status(400).json({ error: 'Ungültiges NAS-Protokoll für dieses Profil.' });
    return;
  }
  const scope: NasProfileScope =
    body.scope && VALID_NAS_PROFILE_SCOPES.has(body.scope) ? body.scope : 'lan';

  const parsedEndpoint = parseNasHostInput(
    body.host ?? (body.protocol === 'fritz_upnp' ? 'fritz.box' : ''),
    body.port ?? '',
    body.shareOrPath ?? ''
  );
  if (!parsedEndpoint.hostname) {
    res.status(400).json({ error: 'Bitte gib Hostname, IP oder DynDNS/VPN-Adresse an.' });
    return;
  }

  const store = readAndSeedNasProfilesStore(username);
  const existingIdx = body.id ? store.profiles.findIndex((p) => p.id === body.id) : -1;
  const existing = existingIdx >= 0 ? store.profiles[existingIdx] : null;

  const isFritz = body.protocol === 'fritz_upnp';
  const useTls =
    typeof body.useTls === 'boolean'
      ? body.useTls
      : parsedEndpoint.explicitScheme
        ? parsedEndpoint.explicitScheme === 'https'
        : scope !== 'lan';
  const defaultPort = String(
    getDefaultPortForNasProtocol(
      body.protocol,
      useTls,
      body.ftpsTlsMode ?? existing?.ftpsTlsMode ?? 'explicit'
    )
  );
  const allowSelfSignedLocalTls =
    scope === 'lan'
      ? (body.allowSelfSignedLocalTls ?? existing?.allowSelfSignedLocalTls ?? true)
      : Boolean(body.allowSelfSignedLocalTls);

  let encryptedSecret = existing?.encryptedSecret ?? null;
  if (body.clearSecret) {
    encryptedSecret = null;
  } else if (typeof body.secret === 'string' && body.secret.length > 0) {
    encryptedSecret = encryptNasSecret(body.secret);
  }

  const shouldActivate =
    typeof body.isActive === 'boolean' ? body.isActive : store.profiles.length === 0;
  if (shouldActivate) {
    for (const p of store.profiles) {
      p.isActive = false;
    }
  }

  const nextRecord: StoredNasProfileRecord = {
    id: existing?.id ?? `prof-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    ownerUsername: existing?.ownerUsername ?? username,
    name: name.slice(0, 64),
    scope,
    protocol: body.protocol,
    host: parsedEndpoint.hostname,
    port: parsedEndpoint.port || defaultPort,
    shareOrPath: parsedEndpoint.path || (isFritz ? '/MediaServer' : '/'),
    username: (body.username ?? existing?.username ?? '').trim(),
    encryptedSecret,
    useTls,
    allowSelfSignedLocalTls,
    ddnsOrVpnHint: (body.ddnsOrVpnHint ?? existing?.ddnsOrVpnHint ?? '').trim() || undefined,
    domainOrWorkgroup: (body.domainOrWorkgroup ?? existing?.domainOrWorkgroup ?? 'WORKGROUP').trim(),
    nfsVersion: body.nfsVersion ?? existing?.nfsVersion ?? 'NFSv4.1',
    nfsAuthMode: body.nfsAuthMode ?? existing?.nfsAuthMode ?? 'AUTH_SYS',
    sftpAuthMode: body.sftpAuthMode ?? existing?.sftpAuthMode ?? 'password',
    ftpsTlsMode: body.ftpsTlsMode ?? existing?.ftpsTlsMode ?? 'explicit',
    apiVendor: body.apiVendor ?? existing?.apiVendor ?? 'Synology DSM',
    priority:
      typeof body.priority === 'number' && Number.isFinite(body.priority)
        ? body.priority
        : existing?.priority ?? store.profiles.length + 1,
    isActive: shouldActivate,
    lastTestedAt: existing?.lastTestedAt ?? null,
    lastTestOk: existing?.lastTestOk ?? null,
    lastTestMessage: existing?.lastTestMessage ?? null,
    lastLatencyMs: existing?.lastLatencyMs ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    store.profiles[existingIdx] = nextRecord;
  } else {
    store.profiles.push(nextRecord);
  }
  writeJsonAtomic('nas_profiles.json', store);

  if (nextRecord.isActive) {
    const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
    connStore.users[username] = {
      protocol: nextRecord.protocol,
      host: nextRecord.host,
      port: nextRecord.port,
      shareOrPath: nextRecord.shareOrPath,
      username: nextRecord.username,
      encryptedSecret: nextRecord.encryptedSecret,
      accessMode: 'read_write',
      writePermissions: true,
      domainOrWorkgroup: nextRecord.domainOrWorkgroup,
      nfsVersion: nextRecord.nfsVersion,
      nfsAuthMode: nextRecord.nfsAuthMode,
      sftpAuthMode: nextRecord.sftpAuthMode,
      ftpsTlsMode: nextRecord.ftpsTlsMode,
      apiVendor: nextRecord.apiVendor,
      useTls: nextRecord.useTls,
      updatedAt: nextRecord.updatedAt,
    };
    writeJsonAtomic('nas_connections.json', connStore);
  }

  appendWal('NAS_PROFILE_SAVED', username, {
    profileId: nextRecord.id,
    scope: nextRecord.scope,
    protocol: nextRecord.protocol,
    host: nextRecord.host,
    isActive: nextRecord.isActive,
  });

  res.json({
    ok: true,
    profile: toPublicNasProfile(nextRecord),
    profiles: store.profiles.map(toPublicNasProfile),
  });
});

app.post('/api/nas/connection/profiles/:id/activate', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const profileId = req.params.id;
  const store = readAndSeedNasProfilesStore(username);
  const target = store.profiles.find((p) => p.id === profileId);
  if (!target) {
    res.status(404).json({ error: 'Verbindungsprofil nicht gefunden.' });
    return;
  }

  for (const p of store.profiles) {
    p.isActive = p.id === profileId;
  }
  target.updatedAt = new Date().toISOString();
  writeJsonAtomic('nas_profiles.json', store);

  const connStore = readJsonFile<NasConnectionsStore>('nas_connections.json', { users: {} });
  connStore.users[username] = {
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    shareOrPath: target.shareOrPath,
    username: target.username,
    encryptedSecret: target.encryptedSecret,
    accessMode: 'read_write',
    writePermissions: true,
    domainOrWorkgroup: target.domainOrWorkgroup,
    nfsVersion: target.nfsVersion,
    nfsAuthMode: target.nfsAuthMode,
    sftpAuthMode: target.sftpAuthMode,
    ftpsTlsMode: target.ftpsTlsMode,
    apiVendor: target.apiVendor,
    useTls: target.useTls,
    updatedAt: target.updatedAt,
  };
  writeJsonAtomic('nas_connections.json', connStore);
  ensureUserProfileFolder(username);
  syncUserProfileDataSnapshot(username);

  appendWal('NAS_PROFILE_ACTIVATED', username, {
    profileId: target.id,
    scope: target.scope,
    protocol: target.protocol,
    host: target.host,
  });

  res.json({
    ok: true,
    profile: toPublicNasProfile(target),
    profiles: store.profiles.map(toPublicNasProfile),
  });
});

app.post('/api/nas/connection/profiles/:id/test', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const startedAt = Date.now();
  const username = req.nasUsername!;
  const profileId = req.params.id;
  const store = readAndSeedNasProfilesStore(username);
  const profile = store.profiles.find((p) => p.id === profileId);
  if (!profile) {
    res.status(404).json({ ok: false, error: 'Verbindungsprofil nicht gefunden.' });
    return;
  }

  const hostname = profile.host.trim();
  const numericPort =
    Number(profile.port) ||
    getDefaultPortForNasProtocol(profile.protocol, profile.useTls, profile.ftpsTlsMode);

  let resolvedIp = hostname;
  if (net.isIP(hostname) === 0) {
    try {
      const l4 = await dns.lookup(hostname, { family: 4 }).catch(() => null);
      resolvedIp = l4?.address ?? (await dns.lookup(hostname)).address;
    } catch {
      const msg = `DNS-Auflösung für "${hostname}" (${profile.scope}) fehlgeschlagen.`;
      profile.lastTestedAt = new Date().toISOString();
      profile.lastTestOk = false;
      profile.lastTestMessage = msg;
      profile.lastLatencyMs = Math.max(1, Date.now() - startedAt);
      writeJsonAtomic('nas_profiles.json', store);
      res.status(502).json({ ok: false, error: msg, profile: toPublicNasProfile(profile) });
      return;
    }
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const networkCfg = normalizeAdminNetworkConfig(settings.networkConfig);
  const activeCert = readCurrentSecurityCertificate(settings);
  const isLanTarget =
    isLocalLanTargetStrict(hostname, resolvedIp) ||
    isLocalOrLanAddress(hostname, resolvedIp) ||
    isLocalLanHostnameOrIp(hostname);
  const allowLocalSelfSigned =
    isLanTarget && networkCfg.allowLocalSelfSignedTls && profile.allowSelfSignedLocalTls;
  const effectiveScope: 'lan' | 'vpn' | 'internet' =
    profile.scope === 'vpn' ? 'vpn' : isLanTarget ? 'lan' : 'internet';
  const storedPassword = decryptNasSecret(profile.encryptedSecret ?? null) || '';

  const realRes = await testSingleUniversalProtocol({
    protocol: profile.protocol,
    host: hostname,
    port: numericPort,
    shareOrPath: profile.shareOrPath,
    username: profile.username,
    password: storedPassword,
    domainOrWorkgroup: profile.domainOrWorkgroup,
    useTls: profile.useTls,
    ftpsTlsMode: profile.ftpsTlsMode,
    scope: effectiveScope,
    allowLocalSelfSignedTls: allowLocalSelfSigned,
    customCaPem: activeCert?.pem ?? null,
    timeoutMs: 4200,
  });

  const testPassed = Boolean(
    realRes.protocolVerified &&
      !realRes.smb1Rejected &&
      !realRes.blockedByVpnPolicy &&
      (!realRes.authAttempted || realRes.authVerified)
  );
  const totalLatencyMs = realRes.latencyMs ?? Math.max(1, Date.now() - startedAt);
  const message = `${profile.name}: ${realRes.message}`;

  profile.lastTestedAt = new Date().toISOString();
  profile.lastTestOk = testPassed;
  profile.lastTestMessage = message;
  profile.lastLatencyMs = testPassed ? totalLatencyMs : null;
  writeJsonAtomic('nas_profiles.json', store);

  if (!testPassed) {
    res.status(realRes.blockedByVpnPolicy ? 403 : realRes.authAttempted ? 401 : 502).json({
      ok: false,
      latencyMs: realRes.latencyMs,
      resolvedIp,
      scope: profile.scope,
      verification: realRes,
      error: message,
      profile: toPublicNasProfile(profile),
    });
    return;
  }

  res.json({
    ok: true,
    latencyMs: totalLatencyMs,
    resolvedIp,
    scope: profile.scope,
    verification: realRes,
    message,
    profile: toPublicNasProfile(profile),
  });
});

app.delete('/api/nas/connection/profiles/:id', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const profileId = req.params.id;
  const store = readAndSeedNasProfilesStore(username);
  const nextProfiles = store.profiles.filter((p) => p.id !== profileId);
  if (nextProfiles.length === store.profiles.length) {
    res.status(404).json({ error: 'Profil nicht gefunden.' });
    return;
  }
  if (nextProfiles.length > 0 && !nextProfiles.some((p) => p.isActive)) {
    nextProfiles[0].isActive = true;
  }
  store.profiles = nextProfiles;
  writeJsonAtomic('nas_profiles.json', store, { allowShrink: true, allowEmptyOverwrite: true });
  appendWal('NAS_PROFILE_DELETED', username, { profileId });
  res.json({ ok: true, profiles: store.profiles.map(toPublicNasProfile) });
});

// Smart Home (Google Home, Amazon Alexa & Home Assistant) Verwaltung + Webhook Fulfillment
app.get('/api/nas/smarthome', requireNasAuth, (_req: AuthedRequest, res: Response) => {
  const store = readSmartHomeStore();
  res.json(toPublicSmartHomeSnapshot(store));
});

app.get('/api/nas/smarthome/token', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const store = readSmartHomeStore();
  res.json({ webhookToken: store.webhookToken });
});

app.post('/api/nas/smarthome/rotate-token', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const store = readSmartHomeStore();
  store.webhookToken = generateSmartHomeToken();
  store.updatedAt = new Date().toISOString();
  writeJsonAtomic('smarthome.json', store);
  appendWal('SMARTHOME_TOKEN_ROTATED', req.nasUsername!, {});
  res.json({
    webhookToken: store.webhookToken,
    snapshot: toPublicSmartHomeSnapshot(store),
  });
});

app.put('/api/nas/smarthome/config', requireNasAuth, (req: AuthedRequest, res: Response) => {
  if (!requireNasAdmin(req, res)) return;
  const body = (req.body ?? {}) as {
    googleHomeEnabled?: boolean;
    alexaEnabled?: boolean;
    deviceName?: string;
    roomName?: string;
    alexaInvocationName?: string;
  };
  const store = readSmartHomeStore();
  if (typeof body.googleHomeEnabled === 'boolean') {
    store.googleHomeEnabled = body.googleHomeEnabled;
  }
  if (typeof body.alexaEnabled === 'boolean') {
    store.alexaEnabled = body.alexaEnabled;
  }
  if (typeof body.deviceName === 'string' && body.deviceName.trim()) {
    store.deviceName = body.deviceName.trim().slice(0, 60);
  }
  if (typeof body.roomName === 'string' && body.roomName.trim()) {
    store.roomName = body.roomName.trim().slice(0, 40);
  }
  if (typeof body.alexaInvocationName === 'string' && body.alexaInvocationName.trim()) {
    store.alexaInvocationName = body.alexaInvocationName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9äöüß -]/gi, '')
      .slice(0, 32) || 'entencenter';
  }
  store.updatedAt = new Date().toISOString();
  writeJsonAtomic('smarthome.json', store);
  appendWal('SMARTHOME_CONFIG_UPDATED', req.nasUsername!, {
    googleHomeEnabled: store.googleHomeEnabled,
    alexaEnabled: store.alexaEnabled,
    deviceName: store.deviceName,
  });
  broadcastSmartHomeState(store);
  res.json({ snapshot: toPublicSmartHomeSnapshot(store) });
});

app.post('/api/nas/smarthome/command', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const userFskLimit = getUserFskLimit(username);
  const body = (req.body ?? {}) as {
    source?: SmartHomeSourceType;
    action?:
      | 'play'
      | 'pause'
      | 'stop'
      | 'next'
      | 'previous'
      | 'volume_set'
      | 'mute'
      | 'speed_set'
      | 'power'
      | 'search_and_play'
      | 'set_input';
    volume?: number;
    muted?: boolean;
    playbackRate?: number;
    powerOn?: boolean;
    query?: string;
    mediaId?: string;
    input?: string;
  };

  const source: SmartHomeSourceType =
    body.source && ['google_home', 'alexa', 'home_assistant', 'app'].includes(body.source)
      ? body.source
      : 'app';
  const store = readSmartHomeStore();
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []).filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
  );

  switch (body.action) {
    case 'play':
      pushSmartHomeCommand(store, source, 'PLAY', 'Wiedergabe starten', 'Player fortgesetzt', (s) => {
        s.powerOn = true;
        s.playbackState = 'PLAYING';
        if (!s.activeMediaId && catalog.length > 0) {
          const first = catalog[0];
          s.activeMediaId = first.id;
          s.activeTitle = first.title;
        }
      });
      break;
    case 'pause':
      pushSmartHomeCommand(store, source, 'PAUSE', 'Wiedergabe pausieren', 'Player pausiert', (s) => {
        s.playbackState = 'PAUSED';
      });
      break;
    case 'stop':
      pushSmartHomeCommand(store, source, 'STOP', 'Wiedergabe stoppen', 'Wiedergabe gestoppt', (s) => {
        s.playbackState = 'IDLE';
      });
      break;
    case 'next': {
      const idx = catalog.findIndex((i) => i.id === store.remoteState.activeMediaId);
      const nextItem = catalog.length > 0 ? catalog[(idx + 1 + catalog.length) % catalog.length] : null;
      pushSmartHomeCommand(
        store,
        source,
        'NEXT',
        'Nächster Titel',
        nextItem ? `Wechsel zu „${nextItem.title}“` : 'Kein weiterer Titel',
        (s) => {
          s.powerOn = true;
          if (nextItem) {
            s.activeMediaId = nextItem.id;
            s.activeTitle = nextItem.title;
            s.playbackState = 'PLAYING';
          }
        }
      );
      break;
    }
    case 'previous': {
      const idx = catalog.findIndex((i) => i.id === store.remoteState.activeMediaId);
      const prevItem =
        catalog.length > 0
          ? catalog[(idx - 1 + catalog.length) % catalog.length]
          : null;
      pushSmartHomeCommand(
        store,
        source,
        'PREVIOUS',
        'Vorheriger Titel',
        prevItem ? `Wechsel zu „${prevItem.title}“` : 'Kein vorheriger Titel',
        (s) => {
          s.powerOn = true;
          if (prevItem) {
            s.activeMediaId = prevItem.id;
            s.activeTitle = prevItem.title;
            s.playbackState = 'PLAYING';
          }
        }
      );
      break;
    }
    case 'volume_set': {
      const vol = Math.max(0, Math.min(100, Math.round(Number(body.volume ?? 70))));
      pushSmartHomeCommand(store, source, 'VOLUME', `Lautstärke ${vol}%`, `Pegel auf ${vol}% gesetzt`, (s) => {
        s.volume = vol;
        if (vol > 0) s.muted = false;
      });
      break;
    }
    case 'mute': {
      const muted = typeof body.muted === 'boolean' ? body.muted : !store.remoteState.muted;
      pushSmartHomeCommand(
        store,
        source,
        'MUTE',
        muted ? 'Stummschalten' : 'Ton aktivieren',
        muted ? 'Audio stummgeschaltet' : 'Stummschaltung aufgehoben',
        (s) => {
          s.muted = muted;
        }
      );
      break;
    }
    case 'speed_set': {
      const rawRate = Number(body.playbackRate ?? 1);
      const rate = Number.isFinite(rawRate)
        ? Math.max(0.5, Math.min(2, Math.round(rawRate * 100) / 100))
        : 1;
      const rateLabel = `${Number.isInteger(rate) ? `${rate}.0` : rate}x`;
      pushSmartHomeCommand(
        store,
        source,
        'PLAYBACK_RATE',
        `Tempo ${rateLabel}`,
        `Wiedergabegeschwindigkeit auf ${rateLabel} gesetzt`,
        (s) => {
          s.playbackRate = rate;
        }
      );
      break;
    }
    case 'power': {
      const powerOn = typeof body.powerOn === 'boolean' ? body.powerOn : !store.remoteState.powerOn;
      pushSmartHomeCommand(
        store,
        source,
        'POWER',
        powerOn ? 'Einschalten' : 'Ausschalten',
        powerOn ? 'EntenCenter Player bereit' : 'EntenCenter Player in Standby',
        (s) => {
          s.powerOn = powerOn;
          if (!powerOn) s.playbackState = 'IDLE';
        }
      );
      break;
    }
    case 'set_input': {
      const nextInput = (body.input || 'EntenTheke').trim();
      pushSmartHomeCommand(
        store,
        source,
        'INPUT',
        `Bereich: ${nextInput}`,
        `Eingang auf ${nextInput} umgeschaltet`,
        (s) => {
          s.powerOn = true;
          s.activeInput = nextInput;
        }
      );
      break;
    }
    case 'search_and_play': {
      const byId = body.mediaId ? catalog.find((i) => i.id === body.mediaId) : undefined;
      const matched = byId || findCatalogMediaForVoice(body.query ?? '', userFskLimit);
      if (!matched) {
        res.status(404).json({
          error: 'Kein passender freigegebener NAS-Titel für diese Sprachanfrage gefunden.',
        });
        return;
      }
      pushSmartHomeCommand(
        store,
        source,
        'SEARCH_AND_PLAY',
        `Spiele „${matched.title}“`,
        `Via ${source} gestartet (${matched.kind})`,
        (s) => {
          s.powerOn = true;
          s.playbackState = 'PLAYING';
          s.activeMediaId = matched.id;
          s.activeTitle = matched.title;
        }
      );
      break;
    }
    default:
      res.status(400).json({ error: 'Unbekannter Smart-Home-Befehl.' });
      return;
  }

  res.json(toPublicSmartHomeSnapshot(store));
});

// Quiet sync of currently active app media so Smart-Home UI reflects active playback without log spam
app.post('/api/nas/smarthome/active-media', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const { mediaId, title, playbackState } = (req.body ?? {}) as {
    mediaId?: string | null;
    title?: string | null;
    playbackState?: 'PLAYING' | 'PAUSED' | 'IDLE';
  };
  const store = readSmartHomeStore();
  store.remoteState.activeMediaId = mediaId ?? null;
  store.remoteState.activeTitle = title ?? null;
  if (playbackState && ['PLAYING', 'PAUSED', 'IDLE'].includes(playbackState)) {
    store.remoteState.playbackState = playbackState;
    if (playbackState === 'PLAYING') {
      store.remoteState.powerOn = true;
    }
  }
  store.remoteState.commandSeq = (store.remoteState.commandSeq ?? 0) + 1;
  writeJsonAtomic('smarthome.json', store);
  broadcastSmartHomeState(store);
  res.json({ remoteState: store.remoteState });
});

// Google Home Smart Home Action Fulfillment (SYNC, QUERY, EXECUTE, DISCONNECT)
app.post('/api/smarthome/google', (req: Request, res: Response) => {
  const auth = verifySmartHomeRequestToken(req);
  if (!auth.ok) {
    res.status(401).json({ error: 'Ungültiger oder fehlender Smart-Home Bearer-Token.' });
    return;
  }

  const store = readSmartHomeStore();
  if (!store.googleHomeEnabled) {
    res.status(403).json({ error: 'Google Home Integration ist im NAS deaktiviert.' });
    return;
  }

  const body = (req.body ?? {}) as {
    requestId?: string;
    inputs?: Array<{
      intent?: string;
      payload?: {
        commands?: Array<{
          devices?: Array<{ id?: string }>;
          execution?: Array<{
            command?: string;
            params?: Record<string, unknown>;
          }>;
        }>;
      };
    }>;
  };

  const requestId = body.requestId || `gh-${Date.now()}`;
  const input = body.inputs?.[0];
  const intent = input?.intent || '';

  if (intent === 'action.devices.SYNC') {
    pushSmartHomeCommand(
      store,
      'google_home',
      'SYNC',
      'Geräte synchronisiert',
      `${store.deviceName} an Google Home gemeldet`,
      () => {}
    );
    res.json({
      requestId,
      payload: {
        agentUserId: store.googleAgentUserId,
        devices: [
          {
            id: 'entencenter-nas-player',
            type: 'action.devices.types.TV',
            traits: [
              'action.devices.traits.OnOff',
              'action.devices.traits.TransportControl',
              'action.devices.traits.MediaState',
              'action.devices.traits.Volume',
              'action.devices.traits.InputSelector',
            ],
            name: {
              defaultNames: ['EntenCenter NAS Player'],
              name: store.deviceName,
              nicknames: ['EntenCenter', 'EntenTheke', store.deviceName],
            },
            willReportState: true,
            roomHint: store.roomName,
            attributes: {
              transportControlSupportedCommands: [
                'PAUSE',
                'RESUME',
                'STOP',
                'NEXT',
                'PREVIOUS',
                'SEEK_RELATIVE',
              ],
              supportActivityState: true,
              supportPlaybackState: true,
              volumeMaxLevel: 100,
              volumeCanMuteAndUnmute: true,
              availableInputs: [
                {
                  key: 'EntenTheke',
                  names: [{ lang: 'de', name_synonym: ['Mediathek', 'EntenTheke', 'Startseite'] }],
                },
                { key: 'Filme', names: [{ lang: 'de', name_synonym: ['Filme', 'Kino'] }] },
                { key: 'Serien', names: [{ lang: 'de', name_synonym: ['Serien', 'TV'] }] },
                { key: 'Musik', names: [{ lang: 'de', name_synonym: ['Musik', 'Audio'] }] },
              ],
            },
            deviceInfo: {
              manufacturer: 'EntenCenter',
              model: 'NAS-Zero-Footprint-Player',
              hwVersion: '1.0',
              swVersion: '2.0',
            },
          },
        ],
      },
    });
    return;
  }

  if (intent === 'action.devices.QUERY') {
    res.json({
      requestId,
      payload: {
        devices: {
          'entencenter-nas-player': {
            online: true,
            status: 'SUCCESS',
            on: store.remoteState.powerOn,
            currentVolume: store.remoteState.volume,
            isMuted: store.remoteState.muted,
            playbackState: store.remoteState.playbackState,
            activityState: store.remoteState.powerOn ? 'ACTIVE' : 'INACTIVE',
            currentInput: store.remoteState.activeInput,
          },
        },
      },
    });
    return;
  }

  if (intent === 'action.devices.EXECUTE') {
    const maxFsk: FskLevel = auth.viaUser ? getUserFskLimit(auth.viaUser) : 18;
    const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []).filter(
      (i) => normalizeFskLimit(i.fsk, 0) <= maxFsk
    );
    const executions = input?.payload?.commands?.flatMap((c) => c.execution ?? []) ?? [];
    for (const exec of executions) {
      const cmd = exec.command || '';
      const params = exec.params || {};
      if (cmd === 'action.devices.commands.OnOff') {
        const on = Boolean(params.on);
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:OnOff',
          on ? 'Einschalten' : 'Ausschalten',
          `Google Home: ${store.deviceName} ${on ? 'ein' : 'aus'}`,
          (s) => {
            s.powerOn = on;
            if (!on) s.playbackState = 'IDLE';
          }
        );
      } else if (cmd === 'action.devices.commands.mediaPause') {
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:mediaPause',
          'Wiedergabe pausieren',
          'Pausiert durch Google Home',
          (s) => {
            s.playbackState = 'PAUSED';
          }
        );
      } else if (cmd === 'action.devices.commands.mediaResume') {
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:mediaResume',
          'Wiedergabe fortsetzen',
          'Fortgesetzt durch Google Home',
          (s) => {
            s.powerOn = true;
            s.playbackState = 'PLAYING';
            if (!s.activeMediaId && catalog[0]) {
              s.activeMediaId = catalog[0].id;
              s.activeTitle = catalog[0].title;
            }
          }
        );
      } else if (cmd === 'action.devices.commands.mediaStop') {
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:mediaStop',
          'Wiedergabe stoppen',
          'Gestoppt durch Google Home',
          (s) => {
            s.playbackState = 'IDLE';
          }
        );
      } else if (
        cmd === 'action.devices.commands.mediaNext' ||
        cmd === 'action.devices.commands.mediaPrevious'
      ) {
        const delta = cmd.endsWith('mediaNext') ? 1 : -1;
        const idx = catalog.findIndex((i) => i.id === store.remoteState.activeMediaId);
        const picked =
          catalog.length > 0 ? catalog[(idx + delta + catalog.length) % catalog.length] : null;
        pushSmartHomeCommand(
          store,
          'google_home',
          `EXECUTE:${delta > 0 ? 'mediaNext' : 'mediaPrevious'}`,
          delta > 0 ? 'Nächster Titel' : 'Vorheriger Titel',
          picked ? `Wechsel zu „${picked.title}“` : 'Kein Titel verfügbar',
          (s) => {
            s.powerOn = true;
            if (picked) {
              s.activeMediaId = picked.id;
              s.activeTitle = picked.title;
              s.playbackState = 'PLAYING';
            }
          }
        );
      } else if (cmd === 'action.devices.commands.setVolume') {
        const vol = Math.max(0, Math.min(100, Math.round(Number(params.volumeLevel ?? 70))));
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:setVolume',
          `Lautstärke ${vol}%`,
          `Pegel per Google Home auf ${vol}%`,
          (s) => {
            s.volume = vol;
            if (vol > 0) s.muted = false;
          }
        );
      } else if (cmd === 'action.devices.commands.volumeRelative') {
        const rel = Number(params.relativeSteps ?? 0);
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:volumeRelative',
          `Lautstärke ${rel >= 0 ? `+${rel}` : rel}%`,
          'Lautstärke relativ angepasst',
          (s) => {
            s.volume = Math.max(0, Math.min(100, s.volume + rel));
          }
        );
      } else if (cmd === 'action.devices.commands.mute') {
        const mute = Boolean(params.mute);
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:mute',
          mute ? 'Stummschalten' : 'Ton an',
          `Google Home Mute: ${mute ? 'an' : 'aus'}`,
          (s) => {
            s.muted = mute;
          }
        );
      } else if (cmd === 'action.devices.commands.SetInput') {
        const newInput = String(params.newInput || 'EntenTheke');
        pushSmartHomeCommand(
          store,
          'google_home',
          'EXECUTE:SetInput',
          `Bereich: ${newInput}`,
          `Ansicht auf ${newInput} gewechselt`,
          (s) => {
            s.powerOn = true;
            s.activeInput = newInput;
          }
        );
      }
    }

    res.json({
      requestId,
      payload: {
        commands: [
          {
            ids: ['entencenter-nas-player'],
            status: 'SUCCESS',
            states: {
              online: true,
              on: store.remoteState.powerOn,
              currentVolume: store.remoteState.volume,
              isMuted: store.remoteState.muted,
              playbackState: store.remoteState.playbackState,
              currentInput: store.remoteState.activeInput,
            },
          },
        ],
      },
    });
    return;
  }

  if (intent === 'action.devices.DISCONNECT') {
    pushSmartHomeCommand(
      store,
      'google_home',
      'DISCONNECT',
      'Verbindung getrennt',
      'Google Home Verknüpfung gelöst',
      () => {}
    );
    res.json({});
    return;
  }

  res.status(400).json({ error: `Unbekannter Google Smart Home Intent: ${intent}` });
});

// Amazon Alexa Smart Home Skill v3 Fulfillment
app.post('/api/smarthome/alexa', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    directive?: {
      header?: {
        namespace?: string;
        name?: string;
        messageId?: string;
        correlationToken?: string;
      };
      endpoint?: {
        endpointId?: string;
        scope?: { token?: string };
      };
      payload?: {
        scope?: { token?: string };
        volume?: number;
        volumeDefault?: boolean;
        mute?: boolean;
        entities?: Array<{ type?: string; value?: string }>;
      };
    };
  };

  const directive = body.directive;
  const header = directive?.header;
  const scopeToken =
    directive?.endpoint?.scope?.token ?? directive?.payload?.scope?.token ?? null;
  const auth = verifySmartHomeRequestToken(req, scopeToken);

  if (!auth.ok) {
    res.status(401).json({
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ErrorResponse',
          messageId: `err-${Date.now()}`,
          payloadVersion: '3',
        },
        payload: {
          type: 'INVALID_AUTHORIZATION_CREDENTIAL',
          message: 'Ungültiger oder fehlender Alexa Smart-Home Bearer-Token.',
        },
      },
    });
    return;
  }

  const store = readSmartHomeStore();
  if (!store.alexaEnabled) {
    res.status(403).json({
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ErrorResponse',
          messageId: `err-${Date.now()}`,
          payloadVersion: '3',
        },
        payload: {
          type: 'ENDPOINT_UNREACHABLE',
          message: 'Amazon Alexa Integration ist im NAS deaktiviert.',
        },
      },
    });
    return;
  }

  const ns = header?.namespace || '';
  const name = header?.name || '';
  const messageId = header?.messageId || `alexa-${Date.now()}`;
  const correlationToken = header?.correlationToken;
  const maxFsk: FskLevel = auth.viaUser ? getUserFskLimit(auth.viaUser) : 18;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []).filter(
    (i) => normalizeFskLimit(i.fsk, 0) <= maxFsk
  );

  if (ns === 'Alexa.Discovery' && name === 'Discover') {
    pushSmartHomeCommand(
      store,
      'alexa',
      'Alexa.Discovery',
      'Geräteerkennung (Discover)',
      `${store.deviceName} an Alexa gemeldet`,
      () => {}
    );
    res.json({
      event: {
        header: {
          namespace: 'Alexa.Discovery',
          name: 'Discover.Response',
          payloadVersion: '3',
          messageId,
        },
        payload: {
          endpoints: [
            {
              endpointId: 'entencenter-nas-player',
              manufacturerName: 'EntenCenter',
              friendlyName: store.deviceName,
              description: `EntenCenter NAS Mediacenter (${store.roomName})`,
              displayCategories: ['TV', 'STREAMING_DEVICE'],
              capabilities: [
                { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
                {
                  type: 'AlexaInterface',
                  interface: 'Alexa.PowerController',
                  version: '3',
                  properties: {
                    supported: [{ name: 'powerState' }],
                    retrievable: true,
                  },
                },
                {
                  type: 'AlexaInterface',
                  interface: 'Alexa.PlaybackController',
                  version: '3',
                  supportedOperations: ['Play', 'Pause', 'Stop', 'Next', 'Previous'],
                },
                {
                  type: 'AlexaInterface',
                  interface: 'Alexa.PlaybackStateReporter',
                  version: '3',
                  properties: {
                    supported: [{ name: 'playbackState' }],
                    retrievable: true,
                  },
                },
                {
                  type: 'AlexaInterface',
                  interface: 'Alexa.Speaker',
                  version: '3',
                  properties: {
                    supported: [{ name: 'volume' }, { name: 'muted' }],
                    retrievable: true,
                  },
                },
                {
                  type: 'AlexaInterface',
                  interface: 'Alexa.RemoteVideoPlayer',
                  version: '3',
                },
              ],
            },
          ],
        },
      },
    });
    return;
  }

  if (ns === 'Alexa.PlaybackController') {
    if (name === 'Play') {
      pushSmartHomeCommand(store, 'alexa', 'Alexa.PlaybackController:Play', 'Abspielen', 'Via Alexa gestartet', (s) => {
        s.powerOn = true;
        s.playbackState = 'PLAYING';
        if (!s.activeMediaId && catalog[0]) {
          s.activeMediaId = catalog[0].id;
          s.activeTitle = catalog[0].title;
        }
      });
    } else if (name === 'Pause') {
      pushSmartHomeCommand(store, 'alexa', 'Alexa.PlaybackController:Pause', 'Pausieren', 'Via Alexa pausiert', (s) => {
        s.playbackState = 'PAUSED';
      });
    } else if (name === 'Stop') {
      pushSmartHomeCommand(store, 'alexa', 'Alexa.PlaybackController:Stop', 'Stoppen', 'Via Alexa gestoppt', (s) => {
        s.playbackState = 'IDLE';
      });
    } else if (name === 'Next' || name === 'Previous') {
      const delta = name === 'Next' ? 1 : -1;
      const idx = catalog.findIndex((i) => i.id === store.remoteState.activeMediaId);
      const picked =
        catalog.length > 0 ? catalog[(idx + delta + catalog.length) % catalog.length] : null;
      pushSmartHomeCommand(
        store,
        'alexa',
        `Alexa.PlaybackController:${name}`,
        delta > 0 ? 'Nächster Titel' : 'Vorheriger Titel',
        picked ? `Wechsel zu „${picked.title}“` : 'Kein Titel gefunden',
        (s) => {
          s.powerOn = true;
          if (picked) {
            s.activeMediaId = picked.id;
            s.activeTitle = picked.title;
            s.playbackState = 'PLAYING';
          }
        }
      );
    }
  } else if (ns === 'Alexa.PowerController') {
    const turnOn = name === 'TurnOn';
    pushSmartHomeCommand(
      store,
      'alexa',
      `Alexa.PowerController:${name}`,
      turnOn ? 'Einschalten' : 'Ausschalten',
      `Alexa Power ${turnOn ? 'ON' : 'OFF'}`,
      (s) => {
        s.powerOn = turnOn;
        if (!turnOn) s.playbackState = 'IDLE';
      }
    );
  } else if (ns === 'Alexa.Speaker') {
    if (name === 'SetVolume') {
      const vol = Math.max(0, Math.min(100, Math.round(Number(directive?.payload?.volume ?? 70))));
      pushSmartHomeCommand(store, 'alexa', 'Alexa.Speaker:SetVolume', `Lautstärke ${vol}%`, `Alexa Lautstärke ${vol}%`, (s) => {
        s.volume = vol;
        if (vol > 0) s.muted = false;
      });
    } else if (name === 'AdjustVolume') {
      const delta = Number(directive?.payload?.volume ?? 0);
      pushSmartHomeCommand(store, 'alexa', 'Alexa.Speaker:AdjustVolume', `Lautstärke ${delta >= 0 ? `+${delta}` : delta}%`, 'Alexa Pegel angepasst', (s) => {
        s.volume = Math.max(0, Math.min(100, s.volume + delta));
      });
    } else if (name === 'SetMute') {
      const muted = Boolean(directive?.payload?.mute);
      pushSmartHomeCommand(store, 'alexa', 'Alexa.Speaker:SetMute', muted ? 'Stumm' : 'Ton an', `Alexa Mute ${muted ? 'an' : 'aus'}`, (s) => {
        s.muted = muted;
      });
    }
  } else if (ns === 'Alexa.RemoteVideoPlayer') {
    const query =
      directive?.payload?.entities?.map((e) => e.value).filter(Boolean).join(' ') ?? '';
    const matched = findCatalogMediaForVoice(query, maxFsk);
    if (!matched) {
      res.status(404).json({
        event: {
          header: {
            namespace: 'Alexa',
            name: 'ErrorResponse',
            messageId,
            correlationToken,
            payloadVersion: '3',
          },
          payload: {
            type: 'NO_SUCH_ENDPOINT',
            message: `Kein NAS-Titel für „${query}“ gefunden.`,
          },
        },
      });
      return;
    }
    pushSmartHomeCommand(
      store,
      'alexa',
      `Alexa.RemoteVideoPlayer:${name}`,
      `Spiele „${matched.title}“`,
      `Alexa Suche „${query || matched.title}“ gestartet`,
      (s) => {
        s.powerOn = true;
        s.playbackState = 'PLAYING';
        s.activeMediaId = matched.id;
        s.activeTitle = matched.title;
      }
    );
  }

  const nowIso = new Date().toISOString();
  res.json({
    context: {
      properties: [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: store.remoteState.powerOn ? 'ON' : 'OFF',
          timeOfSample: nowIso,
          uncertaintyInMilliseconds: 50,
        },
        {
          namespace: 'Alexa.PlaybackStateReporter',
          name: 'playbackState',
          value: { state: store.remoteState.playbackState },
          timeOfSample: nowIso,
          uncertaintyInMilliseconds: 50,
        },
        {
          namespace: 'Alexa.Speaker',
          name: 'volume',
          value: store.remoteState.volume,
          timeOfSample: nowIso,
          uncertaintyInMilliseconds: 50,
        },
        {
          namespace: 'Alexa.Speaker',
          name: 'muted',
          value: store.remoteState.muted,
          timeOfSample: nowIso,
          uncertaintyInMilliseconds: 50,
        },
      ],
    },
    event: {
      header: {
        namespace: 'Alexa',
        name: ns === 'Alexa' && name === 'ReportState' ? 'StateReport' : 'Response',
        payloadVersion: '3',
        messageId,
        correlationToken,
      },
      endpoint: {
        endpointId: directive?.endpoint?.endpointId || 'entencenter-nas-player',
      },
      payload: {},
    },
  });
});

function recordUserAction(
  username: string,
  action: Omit<BehaviorActionEntry, 'hourOfDay' | 'timestamp'>
) {
  const store = readJsonFile<BehaviorStore>('behavior.json', { users: {} });
  const existing = store.users[username] ?? { recentSearches: [], recentActions: [] };
  const now = new Date();
  const nextAction: BehaviorActionEntry = {
    ...action,
    hourOfDay: now.getHours(),
    timestamp: now.toISOString(),
  };
  store.users[username] = {
    recentSearches: existing.recentSearches.slice(0, 20),
    recentActions: [nextAction, ...existing.recentActions].slice(0, 50),
  };
  writeJsonAtomic('behavior.json', store);
}

function recordUserSearchQuery(
  username: string,
  query: string,
  intent: 'search' | 'watchlist' | 'playlist'
) {
  const clean = query.trim();
  if (!clean) return;
  const store = readJsonFile<BehaviorStore>('behavior.json', { users: {} });
  const existing = store.users[username] ?? { recentSearches: [], recentActions: [] };
  const deduped = existing.recentSearches.filter(
    (s) => s.query.toLowerCase() !== clean.toLowerCase()
  );
  store.users[username] = {
    recentSearches: [{ query: clean, intent, timestamp: new Date().toISOString() }, ...deduped].slice(
      0,
      20
    ),
    recentActions: existing.recentActions.slice(0, 50),
  };
  writeJsonAtomic('behavior.json', store);
}

function computeRecencyMultiplier(
  isoDate: string | null | undefined,
  watchedWithoutDate = false
): number {
  if (!isoDate) return watchedWithoutDate ? 0.95 : 0.7;
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return watchedWithoutDate ? 0.95 : 0.7;
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (ageDays <= 14) return 1.45;
  if (ageDays <= 45) return 1.2;
  if (ageDays <= 120) return 0.95;
  return 0.65;
}

function describePreferredTimeWindow(hours: number[]): string {
  if (hours.length === 0) return 'Abend & Wochenende';
  let evening = 0;
  let lateNight = 0;
  let daytime = 0;
  for (const h of hours) {
    if (h >= 18 && h <= 22) evening += 1;
    else if (h >= 23 || h <= 4) lateNight += 1;
    else daytime += 1;
  }
  if (evening >= lateNight && evening >= daytime) return 'Abend & Prime-Time (18–23 Uhr)';
  if (lateNight >= evening && lateNight >= daytime) return 'Spätabend & Nacht';
  return 'Tagsüber & Nachmittag';
}

// Enten-Assistent AI-Empfehlungen basierend auf vollständiger Analyse von Nutzungsverhalten & Gesehenem
app.get('/api/nas/recommendations', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const history = readJsonFile<{ watches: WatchHistoryEntry[] }>('history.json', { watches: [] });
  const favs = readJsonFile<FavoritesStore>('favorites.json', { users: {} });
  const watchlistStore = readJsonFile<WatchlistStore>('watchlist.json', { users: {} });
  const collectionsStore = readJsonFile<CollectionsStore>('collections.json', { users: {} });
  const behaviorStore = readJsonFile<BehaviorStore>('behavior.json', { users: {} });

  const userFskLimit = getUserFskLimit(username);
  const allowedCatalog = catalog.filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
  );
  const allowedById = new Map(allowedCatalog.map((item) => [item.id, item]));
  const allowedByTitle = new Map(
    allowedCatalog.map((item) => [item.title.toLowerCase(), item])
  );
  const allowedIds = new Set(allowedCatalog.map((item) => item.id));
  const splitGenres = (raw: string | undefined): string[] =>
    (raw || '')
      .split(/[&,\/]+/)
      .map((g) => g.trim())
      .filter((g) => Boolean(g) && g.toLowerCase() !== 'allgemein' && g.toLowerCase() !== 'medien');

  const userWatches = history.watches
    .filter(
      (w) =>
        w.username === username &&
        (allowedIds.has(w.mediaId) || allowedByTitle.has(w.title.toLowerCase()))
    )
    .sort((a, b) => {
      const ta = a.lastWatchedAt ? Date.parse(a.lastWatchedAt) : Number.NaN;
      const tb = b.lastWatchedAt ? Date.parse(b.lastWatchedAt) : Number.NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
      if (!Number.isNaN(tb)) return 1;
      if (!Number.isNaN(ta)) return -1;
      return a.title.localeCompare(b.title, 'de');
    });

  const userWatchById = new Map<string, WatchHistoryEntry>();
  for (const w of userWatches) {
    const matchedItem = allowedById.get(w.mediaId) ?? allowedByTitle.get(w.title.toLowerCase());
    if (matchedItem && !userWatchById.has(matchedItem.id)) {
      userWatchById.set(matchedItem.id, w);
    }
  }
  const userWatchlistIds = new Set((watchlistStore.users[username] ?? []).filter((id) => allowedIds.has(id)));
  const userCollections = collectionsStore.users[username] ?? [];
  const userBehavior = behaviorStore.users[username] ?? { recentSearches: [], recentActions: [] };

  const userFav = favs.users[username] ?? { auto: [], manual: [], muted: [] };
  const mutedTitles = new Set(userFav.muted.map((t) => t.toLowerCase()));
  const favTitles = new Set(
    [...userFav.auto, ...userFav.manual]
      .filter((t) => !mutedTitles.has(t.toLowerCase()))
      .map((t) => t.toLowerCase())
  );

  // Gewichtete Profilanalyse aus Gesehenem + Merkliste + Sammlungen + Suchverhalten
  const genreWeights = new Map<string, number>();
  const genreSourceTitle = new Map<string, string>();
  const moodWeights = new Map<string, number>();
  const moodSourceTitle = new Map<string, string>();
  const creatorCastWeights = new Map<string, number>();
  const creatorCastSourceTitle = new Map<string, string>();
  const activityHours: number[] = [];

  let totalWatchMinutes = 0;
  let completedTitlesCount = 0;
  let inProgressSeriesCount = 0;
  let seriesWatchScore = 0;
  let movieWatchScore = 0;

  for (const w of userWatches) {
    const catalogItem = allowedById.get(w.mediaId) ?? allowedByTitle.get(w.title.toLowerCase());
    const recency = computeRecencyMultiplier(w.lastWatchedAt, Boolean(w.watchedWithoutDate));
    const parsedTs = w.lastWatchedAt ? Date.parse(w.lastWatchedAt) : Number.NaN;
    if (!Number.isNaN(parsedTs)) {
      activityHours.push(new Date(parsedTs).getUTCHours());
    }

    const totalEp =
      catalogItem?.totalEpisodes ??
      (catalogItem?.kind === 'series' ? buildNasEpisodesForSeries(catalogItem)?.length ?? 0 : 0);
    const totalDur = Math.max(1, catalogItem?.totalDurationMinutes ?? 90);
    const isCompletedMovie =
      w.mediaType !== 'series' &&
      (w.watchedMinutes >= totalDur * 0.82 || Boolean(w.watchedWithoutDate));
    const isCompletedSeries =
      w.mediaType === 'series' && totalEp > 0 && w.episodesWatched >= totalEp;

    if (isCompletedMovie || isCompletedSeries) {
      completedTitlesCount += 1;
    } else if (w.mediaType === 'series' && w.episodesWatched > 0) {
      inProgressSeriesCount += 1;
    }

    const engagementMinutes =
      w.mediaType === 'series'
        ? Math.max(30, w.watchedMinutes || w.episodesWatched * 42)
        : Math.max(20, w.watchedMinutes || totalDur);
    totalWatchMinutes += engagementMinutes;

    const completionFactor =
      w.mediaType === 'series'
        ? w.episodesWatched >= 3
          ? 1.25
          : 0.95
        : isCompletedMovie
          ? 1.25
          : w.watchedMinutes < 12
            ? 0.45
            : 0.9;

    const weight = Math.round(engagementMinutes * recency * completionFactor);
    if (w.mediaType === 'series') seriesWatchScore += weight;
    else if (w.mediaType === 'movie') movieWatchScore += weight;

    const genreSource = catalogItem?.genre || w.genre;
    for (const token of splitGenres(genreSource)) {
      genreWeights.set(token, (genreWeights.get(token) ?? 0) + weight);
      if (!genreSourceTitle.has(token)) genreSourceTitle.set(token, w.title);
    }

    if (catalogItem) {
      for (const mood of catalogItem.moodTags ?? []) {
        moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + Math.round(weight * 0.7));
        if (!moodSourceTitle.has(mood)) moodSourceTitle.set(mood, catalogItem.title);
      }
      const peopleAndStudios = [
        ...(catalogItem.cast ?? []),
        ...(catalogItem.director ? [catalogItem.director] : []),
        ...(catalogItem.studio ? [catalogItem.studio] : []),
      ];
      for (const entry of peopleAndStudios) {
        creatorCastWeights.set(entry, (creatorCastWeights.get(entry) ?? 0) + Math.round(weight * 0.65));
        if (!creatorCastSourceTitle.has(entry)) creatorCastSourceTitle.set(entry, catalogItem.title);
      }
    }
  }

  // Merkliste & kuratierte Playlisten/Watchlisten in Analyse einbeziehen
  for (const wlId of userWatchlistIds) {
    const item = allowedById.get(wlId);
    if (!item) continue;
    for (const token of splitGenres(item.genre)) {
      genreWeights.set(token, (genreWeights.get(token) ?? 0) + 55);
      if (!genreSourceTitle.has(token)) genreSourceTitle.set(token, `${item.title} (Merkliste)`);
    }
    for (const mood of item.moodTags ?? []) {
      moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + 45);
      if (!moodSourceTitle.has(mood)) moodSourceTitle.set(mood, item.title);
    }
    for (const entry of [
      ...(item.cast ?? []),
      ...(item.director ? [item.director] : []),
      ...(item.studio ? [item.studio] : []),
    ]) {
      creatorCastWeights.set(entry, (creatorCastWeights.get(entry) ?? 0) + 35);
      if (!creatorCastSourceTitle.has(entry)) creatorCastSourceTitle.set(entry, item.title);
    }
  }

  for (const col of userCollections) {
    for (const mId of col.mediaIds) {
      const item = allowedById.get(mId);
      if (!item) continue;
      for (const token of splitGenres(item.genre)) {
        genreWeights.set(token, (genreWeights.get(token) ?? 0) + 35);
      }
      for (const mood of item.moodTags ?? []) {
        moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + 30);
      }
    }
  }

  // Such- & Nutzungsverhalten ("Frag die Ente" + Wiedergabe-Uhrzeiten)
  for (const act of userBehavior.recentActions) {
    if (typeof act.hourOfDay === 'number') {
      activityHours.push(act.hourOfDay);
    }
  }

  const recentSearchQueries = userBehavior.recentSearches.slice(0, 5).map((s) => s.query);
  const searchInterestTokens = Array.from(
    new Set(
      recentSearchQueries
        .join(' ')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}-]+/gu, ' ')
        .split(/\s+/)
        .filter((tok) => tok.length >= 3 && !ASK_DUCK_STOPWORDS.has(tok))
    )
  ).slice(0, 12);

  const topGenres = Array.from(genreWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  const topMoods = Array.from(moodWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m]) => m);

  const topCreatorsOrCast = Array.from(creatorCastWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  const recentWatchedTitles = userWatches.slice(0, 4).map((w) => w.title);
  const preferredTimeWindow =
    activityHours.length === 0 && userWatches.some((w) => w.watchedWithoutDate)
      ? 'Individueller Sehverlauf'
      : describePreferredTimeWindow(activityHours);

  let viewingPattern = 'Ausgewogener Film- & Serien-Mix';
  if (userWatches.length === 0 && userWatchlistIds.size === 0) {
    viewingPattern = 'Einstiegsprofil · Katalog-Entdeckung';
  } else if (seriesWatchScore > movieWatchScore * 1.45) {
    viewingPattern =
      inProgressSeriesCount >= 2
        ? 'Serien-Marathon mit aktiven Staffeln'
        : 'Klarer Serien-Fokus';
  } else if (movieWatchScore > seriesWatchScore * 1.35) {
    viewingPattern = 'Spielfilm- & Doku-Fokus';
  }

  const totalWatchHours = Math.round((totalWatchMinutes / 60) * 10) / 10;
  const analysisHeadline =
    userWatches.length > 0
      ? `${userWatches.length} geschaute Titel (${totalWatchHours} Std.) · ${viewingPattern}`
      : `Merkliste (${userWatchlistIds.size}) & Aktivität ausgewertet`;

  const allScored = allowedCatalog
    .filter((item) => item.kind === 'movie' || item.kind === 'series')
    .map((item) => {
      let score = 0;
      const matchedTokens: string[] = [];
      const matchedSignals: string[] = [];
      let referenceWatchedTitle: string | null = null;

      for (const token of splitGenres(item.genre)) {
        const w = genreWeights.get(token) ?? 0;
        if (w > 0) {
          score += Math.min(85, Math.round(w / 9));
          matchedTokens.push(token);
          const srcTitle = genreSourceTitle.get(token);
          if (!referenceWatchedTitle && srcTitle && srcTitle !== item.title) {
            referenceWatchedTitle = srcTitle;
          }
        }
      }
      if (matchedTokens.length > 0) {
        matchedSignals.push(`Genre: ${matchedTokens.slice(0, 2).join(' & ')}`);
      }

      // Stimmungs-/Stil-Übereinstimmung aus Gesehenem
      let moodHitCount = 0;
      const matchedMoodLabels: string[] = [];
      for (const mood of item.moodTags ?? []) {
        const mw = moodWeights.get(mood) ?? 0;
        if (mw > 0) {
          moodHitCount += 1;
          matchedMoodLabels.push(mood);
          const moodSrc = moodSourceTitle.get(mood);
          if (!referenceWatchedTitle && moodSrc && moodSrc !== item.title) {
            referenceWatchedTitle = moodSrc;
          }
        }
      }
      if (moodHitCount > 0) {
        score += Math.min(45, moodHitCount * 16);
        matchedSignals.push(`Stimmung: ${matchedMoodLabels.slice(0, 2).join(', ')}`);
      }

      // Schauspieler-, Regie- & Studio-Übereinstimmung aus Gesehenem
      const itemPeople = [
        ...(item.cast ?? []),
        ...(item.director ? [item.director] : []),
        ...(item.studio ? [item.studio] : []),
      ];
      const matchedPeople = itemPeople.filter((p) => (creatorCastWeights.get(p) ?? 0) > 0);
      if (matchedPeople.length > 0) {
        score += Math.min(45, matchedPeople.length * 22);
        const refFromPerson = creatorCastSourceTitle.get(matchedPeople[0]);
        if (refFromPerson && refFromPerson !== item.title) {
          referenceWatchedTitle = refFromPerson;
          matchedSignals.push(`Bekannt aus „${refFromPerson}“`);
        } else {
          matchedSignals.push(`Besetzung/Studio: ${matchedPeople[0]}`);
        }
      }

      // Suchverhalten ("Frag die Ente") berücksichtigen
      const searchHay = [
        item.title,
        item.genre,
        item.synopsis,
        ...(item.moodTags ?? []),
        ...(item.cast ?? []),
        item.studio ?? '',
        item.director ?? '',
      ]
        .join(' ')
        .toLowerCase();
      const matchedQueryTokens = searchInterestTokens.filter((tok) => searchHay.includes(tok));
      if (matchedQueryTokens.length > 0) {
        score += Math.min(40, matchedQueryTokens.length * 16);
        matchedSignals.push(`Suchinteresse: „${matchedQueryTokens[0]}“`);
      }

      const watchEntry = userWatchById.get(item.id);
      const itemTotalEp =
        item.totalEpisodes ??
        (item.kind === 'series' ? buildNasEpisodesForSeries(item)?.length ?? 0 : 0);
      const isCompletedMovie =
        watchEntry &&
        item.kind !== 'series' &&
        (watchEntry.watchedMinutes >= Math.max(1, item.totalDurationMinutes) * 0.82 ||
          Boolean(watchEntry.watchedWithoutDate));
      const isCompletedSeries =
        watchEntry &&
        item.kind === 'series' &&
        itemTotalEp > 0 &&
        watchEntry.episodesWatched >= itemTotalEp;

      if (!watchEntry) {
        score += 65; // Noch nicht angeschaut -> hohe Entdeckungspriorität
      } else if (
        item.kind === 'series' &&
        itemTotalEp > watchEntry.episodesWatched
      ) {
        score += 28; // Begonnene Serie mit noch offenen Folgen
        matchedSignals.unshift(
          `Offene Folgen (${watchEntry.episodesWatched}/${itemTotalEp})`
        );
      } else if (isCompletedMovie || isCompletedSeries) {
        score -= 130; // Bereits komplett angeschaute Inhalte nach hinten schieben
      } else {
        score -= 15;
      }

      if (userWatchlistIds.has(item.id)) {
        score += 24;
        matchedSignals.push('Auf deiner Merkliste');
      }
      if (favTitles.has(item.title.toLowerCase())) {
        score += 20;
      }
      if (mutedTitles.has(item.title.toLowerCase())) {
        score -= 80;
      }
      if (item.year >= 2024) {
        score += 8;
      }

      // Begründung direkt aus der konkreten Analyse formulieren
      let reason = `Empfehlung aus deinem NAS-Katalog (${item.genre})`;
      if (
        watchEntry &&
        item.kind === 'series' &&
        (item.totalEpisodes ?? 0) > watchEntry.episodesWatched
      ) {
        reason = `Weiterschauen: ${watchEntry.episodesWatched} von ${item.totalEpisodes} Folgen gesehen · passt zu deinem ${item.genre}-Verlauf`;
      } else if (!watchEntry && matchedPeople.length > 0 && referenceWatchedTitle) {
        reason = `Neu für dich · Ähnliche Besetzung/Studio (${matchedPeople[0]}) wie beim gesehenen „${referenceWatchedTitle}“`;
      } else if (!watchEntry && matchedQueryTokens.length > 0) {
        reason = `Neu für dich · Passt zu deinen Suchanfragen („${matchedQueryTokens.slice(0, 2).join(', ')}“) & ${item.genre}`;
      } else if (!watchEntry && referenceWatchedTitle && matchedTokens.length > 0) {
        reason = `Neu für dich · Ähnlich wie dein geschautes „${referenceWatchedTitle}“ (${matchedTokens.join(' & ')})`;
      } else if (!watchEntry && userWatchlistIds.has(item.id)) {
        reason = `Auf deiner Merkliste · Passt zu deinem ${topGenres[0] ?? item.genre}-Nutzungsprofil`;
      } else if (!watchEntry && matchedMoodLabels.length > 0) {
        reason = `Neu für dich · Trifft deine bevorzugte Stimmung (${matchedMoodLabels.slice(0, 2).join(' & ')})`;
      } else if (isCompletedMovie || isCompletedSeries) {
        reason = `Rewatch-Tipp · Passt stark zu deinen ${item.genre}-Favoriten`;
      }

      return {
        item,
        score,
        reason,
        matchedSignals: matchedSignals.slice(0, 3),
      };
    })
    .sort((a, b) => b.score - a.score);

  const topSeries = allScored.filter((s) => s.item.kind === 'series').slice(0, 3);
  const topMovies = allScored.filter((s) => s.item.kind === 'movie').slice(0, 3);
  const pickedIds = new Set([...topSeries, ...topMovies].map((s) => s.item.id));
  const backfill = allScored.filter((s) => !pickedIds.has(s.item.id));

  const combined: typeof allScored = [];
  for (let i = 0; i < 3; i++) {
    if (topSeries[i]) combined.push(topSeries[i]);
    if (topMovies[i]) combined.push(topMovies[i]);
  }
  while (combined.length < 6 && backfill.length > 0) {
    const next = backfill.shift();
    if (next) combined.push(next);
  }
  const scored = combined.slice(0, 6);

  const seriesCount = scored.filter((s) => s.item.kind === 'series').length;
  const movieCount = scored.filter((s) => s.item.kind === 'movie').length;
  const topGenresText = topGenres.length > 0 ? topGenres.join(', ') : 'Krimi, Thriller & Sci-Fi';
  const watchedPreviewText =
    recentWatchedTitles.length > 0
      ? recentWatchedTitles.slice(0, 2).map((t) => `„${t}“`).join(' und ')
      : 'deinem Katalogprofil';

  let duckSummary = `Quak! Ich habe deine ${userWatches.length} geschauten Titel (u. a. ${watchedPreviewText}, ${totalWatchHours} Std. Wiedergabe) und dein Nutzungsverhalten (${viewingPattern}) ausgewertet. Auf Basis deiner Vorlieben für ${topGenresText} empfehle ich dir ${scored.length} passende Titel (${seriesCount} Serien & ${movieCount} Filme).`;
  let source: 'gemini' | 'nas-analyzer' = 'nas-analyzer';

  if (process.env.GEMINI_API_KEY && scored.length > 0) {
    try {
      const ai = getGeminiClient();
      const watchedDetails = userWatches
        .slice(0, 8)
        .map((w) => `${w.title} (${w.mediaType === 'series' ? `${w.episodesWatched} Folgen` : `${w.watchedMinutes} Min.`}, ${w.genre})`)
        .join('; ');
      const candidates = scored
        .map(
          (s) =>
            `${s.item.id} | ${s.item.title} (${s.item.kind === 'series' ? 'Serie' : 'Film'}, ${s.item.genre}, Stimmungen: ${(s.item.moodTags ?? []).join('/')}, Studio: ${s.item.studio ?? '-'})`
        )
        .join('\n');

      const prompt = `Analysiere das Nutzungsverhalten und die geschauten Inhalte von "${username}" und begründe die Empfehlungen:
- Geschaute Inhalte: ${watchedDetails || 'Noch keine Wiedergaben'}
- Gesamtwiedergabe: ${totalWatchHours} Stunden (${completedTitlesCount} abgeschlossen, ${inProgressSeriesCount} Serien aktiv)
- Nutzungsmuster: ${viewingPattern} (${preferredTimeWindow})
- Top-Genres: ${topGenresText}
- Top-Stimmungen: ${topMoods.join(', ') || 'Spannend, Atmosphärisch'}
- Bevorzugte Darsteller/Studios: ${topCreatorsOrCast.join(', ') || 'Keine'}
- Letzte Suchanfragen ("Frag die Ente"): ${recentSearchQueries.join(' | ') || 'Keine'}
- Ausgewählte ${scored.length} Empfehlungen (${seriesCount} Serien & ${movieCount} Filme):
${candidates}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: {
          systemInstruction:
            'Du bist der EntenCenter Enten-Assistent. Schreibe eine prägnante, persönliche deutsche Analyse-Zusammenfassung (max. 2 Sätze), die konkret auf das Nutzungsverhalten und die geschauten Titel Bezug nimmt, sowie für jede mediaId eine 1-Satz-Begründung warum sie aufgrund der Analyse empfohlen wird. Antworte ausschließlich im vorgegebenen JSON-Schema.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              duckSummary: { type: Type.STRING },
              itemReasons: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    mediaId: { type: Type.STRING },
                    reason: { type: Type.STRING },
                  },
                  required: ['mediaId', 'reason'],
                },
              },
            },
            required: ['duckSummary', 'itemReasons'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        duckSummary?: string;
        itemReasons?: Array<{ mediaId?: string; reason?: string }>;
      };

      if (parsed.duckSummary?.trim()) {
        duckSummary = parsed.duckSummary.trim();
        source = 'gemini';
      }
      if (Array.isArray(parsed.itemReasons)) {
        const reasonMap = new Map(
          parsed.itemReasons
            .filter((r) => r.mediaId && r.reason?.trim())
            .map((r) => [r.mediaId!, r.reason!.trim()])
        );
        for (const s of scored) {
          const aiReason = reasonMap.get(s.item.id);
          if (aiReason) s.reason = aiReason;
        }
      }
    } catch {
      // Schneller Fallback auf lokale Verhaltensanalyse ohne Fehlerabbruch
    }
  }

  res.json({
    duckSummary,
    topGenres,
    source,
    generatedAt: new Date().toISOString(),
    analysis: {
      watchedTitlesCount: userWatches.length,
      completedTitlesCount,
      inProgressSeriesCount,
      totalWatchHours,
      watchlistCount: userWatchlistIds.size,
      savedCollectionsCount: userCollections.length,
      recentWatchedTitles,
      topMoods,
      topCreatorsOrCast,
      recentSearchInterests: recentSearchQueries.slice(0, 3),
      viewingPattern,
      preferredTimeWindow,
      analysisHeadline,
    },
    items: scored.map((s) => ({
      mediaId: s.item.id,
      reason: s.reason,
      score: s.score,
      matchedSignals: s.matchedSignals,
    })),
  });
});

// "Frag die Ente" — Komplexe KI- & Sprachsuche + Watchlist-/Playlist-Kuration über das gesamte NAS-Archiv
type AskDuckMediaKind = NasLibraryRecord['kind'];
type AskDuckRequestMode = 'auto' | 'search' | 'watchlist' | 'playlist';
type AskDuckResolvedIntent = 'search' | 'watchlist' | 'playlist';

function inferAskDuckIntentAndScope(
  query: string,
  requestedMode: AskDuckRequestMode = 'auto'
): {
  intent: AskDuckResolvedIntent;
  targetKinds: AskDuckMediaKind[];
  scopeLabel: string;
} {
  const q = query.toLowerCase();

  let intent: AskDuckResolvedIntent = 'search';
  if (requestedMode === 'watchlist') {
    intent = 'watchlist';
  } else if (requestedMode === 'playlist') {
    intent = 'playlist';
  } else {
    const wantsWatchlist = /\b(watchlist|merkliste|vormerken)\b/i.test(q);
    const wantsPlaylist = /\b(playlist|playliste|abspielliste|diashow|mix|zusammenstellen|erstelle|erstell|kuratiere)\b/i.test(q);
    if (wantsWatchlist && !wantsPlaylist) {
      intent = 'watchlist';
    } else if (wantsPlaylist) {
      intent = 'playlist';
    }
  }

  const wantsAllNas =
    /\b(alle\s+dateien|gesamte[sn]?\s+nas|alles\s+auf\s+dem\s+nas|alle\s+inhalte|alle\s+medien)\b/i.test(q);
  if (wantsAllNas) {
    return {
      intent,
      targetKinds: ['movie', 'series', 'image', 'music', 'video', 'other'],
      scopeLabel: 'Gesamtes NAS-Archiv',
    };
  }

  const mentionsMovie = /\b(film|filme|filmen|spielfilm|spielfilme|kinofilm|movie|movies)\b/i.test(q);
  const mentionsSeries = /\b(serie|serien|miniserie|staffel|staffeln|episode|folgen)\b/i.test(q);
  const mentionsImage = /\b(bild|bilder|foto|fotos|raw|jpg|png|fotografie|diashow)\b/i.test(q);
  const mentionsMusic = /\b(musik|mp3|flac|audio|song|songs|album|alben|soundtrack|jazz|synthesizer|synthwave|ambient|klassik|akustik|lieder)\b/i.test(q);
  const mentionsVideo = /\b(video|videos|drohne|drohnenflug|konzert|mitschnitt|clip|clips)\b/i.test(q);
  const mentionsOther = /\b(pdf|handbuch|dokument|dokumente|anleitung|epub|zip|archiv|sonstiges)\b/i.test(q);

  const explicitKinds: AskDuckMediaKind[] = [];
  if (mentionsMovie) explicitKinds.push('movie');
  if (mentionsSeries) explicitKinds.push('series');
  if (mentionsMusic) explicitKinds.push('music');
  if (mentionsImage) explicitKinds.push('image');
  if (mentionsVideo) explicitKinds.push('video');
  if (mentionsOther) explicitKinds.push('other');

  const labels: Record<AskDuckMediaKind, string> = {
    movie: 'Filme',
    series: 'Serien',
    image: 'Bilder',
    music: 'Musik',
    video: 'Videos',
    other: 'Sonstiges / PDFs',
  };

  if (explicitKinds.length > 0) {
    const unique = Array.from(new Set(explicitKinds));
    const scopeLabel =
      unique.length === 1
        ? `Nur ${labels[unique[0]]}`
        : unique.map((k) => labels[k]).join(', ');
    return { intent, targetKinds: unique, scopeLabel };
  }

  // Bei allgemeiner Playlist-Anfrage (z. B. "Herbst-Playlist nach Stimmung ruhig") alle 4 Hauptmedien einbeziehen
  if (intent === 'playlist') {
    return {
      intent,
      targetKinds: ['movie', 'series', 'music', 'image'],
      scopeLabel: 'Filme, Serien, Musik & Bilder',
    };
  }

  // Bei Watchlist oder Standard-Suche ohne explizite Eingrenzung auf Musik/Bilder: Filme & Serien
  return {
    intent,
    targetKinds: ['movie', 'series'],
    scopeLabel: 'Filme & Serien',
  };
}

const ASK_DUCK_SYNONYMS: Record<string, string[]> = {
  'science-fiction': ['sci-fi', 'scifi', 'weltraum', 'zeitreise', 'zeitschleife', 'zukunft', 'orbit'],
  'sci-fi': ['science-fiction', 'scifi', 'weltraum', 'zeitreise', 'zeitschleife'],
  comedy: ['komödie', 'humor', 'satire', 'witzig', 'lustig', 'comedy-anteil', 'schmunzeln', 'leicht'],
  komödie: ['comedy', 'humor', 'satire', 'witzig', 'lustig', 'comedy-anteil', 'leicht'],
  krimi: ['kriminal', 'ermittlung', 'kommissar', 'polizei', 'mord', 'ermittler'],
  thriller: ['spannung', 'spannend', 'psychothriller', 'verdeckt', 'kartell', 'noir', 'neo-noir'],
  doku: ['dokumentation', 'reportage', 'natur', 'gletscher'],
  dokumentation: ['doku', 'reportage', 'natur'],
  schauspieler: ['cast', 'darsteller'],
  künstler: ['cast', 'darsteller', 'komponist', 'fotograf', 'interpret'],
  studio: ['produktionsstudio', 'produktion', 'label', 'records'],
  produktionsstudio: ['studio', 'produktion'],
  // Stimmungen
  entspannt: ['ruhig', 'gemütlich', 'ambient', 'leicht', 'lounge', 'familienfreundlich'],
  ruhig: ['entspannt', 'gemütlich', 'ambient', 'minimalismus', 'nachdenklich'],
  gemütlich: ['entspannt', 'ruhig', 'jazz', 'akustik', 'ambient'],
  spannend: ['spannung', 'thriller', 'krimi', 'ermittlung', 'noir'],
  düster: ['noir', 'neo-noir', 'nordic noir', 'mystery', 'schwarzwald', 'nacht'],
  lustig: ['humor', 'comedy', 'satire', 'fröhlich', 'leicht'],
  fröhlich: ['lustig', 'humor', 'urlaub', 'sommer', 'comedy'],
  nachdenklich: ['drama', 'klassik', 'neoklassik', 'historie', 'ambient'],
  // Stilrichtungen
  noir: ['neo-noir', 'nordic noir', 'düster', 'ermittlung'],
  'neo-noir': ['noir', 'thriller', 'krimi', 'nacht'],
  'nordic-noir': ['nordic noir', 'nordsee', 'krimi', 'sturm'],
  synthwave: ['synthesizer', 'electronic', 'ambient'],
  ambient: ['electronic', 'synthesizer', 'ruhig', 'entspannt'],
  jazz: ['akustik', 'vinyl', 'flac', 'lounge'],
  klassik: ['soundtrack', 'orchester', 'neoklassik', 'filmmusik'],
  bauhaus: ['architektur', 'minimalismus', 'design'],
  minimalismus: ['bauhaus', 'ruhig', 'design'],
  // Jahreszeiten
  frühling: ['frühling', 'natur', 'leicht', 'panorama', 'wandern'],
  sommer: ['sommer', 'urlaub', 'nordsee', 'alpen', 'panorama', 'sonne'],
  herbst: ['herbst', 'sturm', 'nebel', 'gemütlich', 'düster', 'regen', 'nordsee'],
  winter: ['winter', 'eis', 'schnee', 'gletscher', 'gemütlich', 'kalt', 'nacht'],
};

const ASK_DUCK_STOPWORDS = new Set([
  'ich', 'möchte', 'suche', 'einen', 'eine', 'ein', 'der', 'die', 'das', 'den', 'dem', 'des',
  'mit', 'etwas', 'anteil', 'und', 'oder', 'aber', 'bitte', 'zeig', 'zeige', 'mir', 'was',
  'auf', 'vom', 'nas', 'gibt', 'es', 'beinhaltet', 'enthält', 'über', 'von', 'für', 'nach',
  'alles', 'nur', 'film', 'filme', 'serie', 'serien', 'musik', 'bild', 'bilder', 'fotos',
  'schauspieler', 'künstler', 'produktionsstudio', 'studio', 'darsteller', 'regisseur',
  'genre', 'genres', 'stilrichtung', 'stilrichtungen', 'stimmung', 'stimmungen', 'jahreszeit',
  'jahreszeiten', 'wo', 'wie', 'hat', 'haben', 'ist', 'sind', 'soll', 'kann', 'gerne', 'mal',
  'etwa', 'einem', 'einer', 'als', 'erstelle', 'erstell', 'mach', 'mache', 'baue', 'zusammenstellen',
  'kuratiere', 'watchlist', 'playlist', 'playliste', 'abspielliste', 'merkliste', 'sich', 'thema',
]);

function buildFallbackCollectionTitle(
  query: string,
  intent: AskDuckResolvedIntent,
  scopeLabel: string
): { collectionType: 'watchlist' | 'playlist'; title: string; criteriaSummary: string } | null {
  if (intent === 'search') return null;
  const collectionType = intent === 'watchlist' ? 'watchlist' : 'playlist';
  const cleaned = query
    .replace(/^(bitte\s+)?(erstelle|erstell|mach|baue|kuratiere)\s+(mir\s+)?(eine|einen)?\s*/i, '')
    .replace(/\b(watchlist|playlist|playliste|abspielliste|merkliste)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const baseLabel = cleaned.length > 2 ? cleaned.slice(0, 55) : scopeLabel;
  const formatted = baseLabel.charAt(0).toUpperCase() + baseLabel.slice(1);
  return {
    collectionType,
    title:
      collectionType === 'watchlist'
        ? `Watchlist: ${formatted}`
        : `Playlist: ${formatted}`,
    criteriaSummary: `Kuratierte Auswahl (${scopeLabel}) passend zu „${query}“`,
  };
}

function runLocalAskDuckSearch(
  query: string,
  eligibleItems: NasLibraryRecord[],
  intent: AskDuckResolvedIntent,
  targetKinds: AskDuckMediaKind[],
  scopeLabel: string
) {
  const kindSet = new Set(targetKinds);
  const candidates = eligibleItems.filter((item) => kindSet.has(item.kind));

  const rawTokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !ASK_DUCK_STOPWORDS.has(t));

  const expandedGroups: string[][] = rawTokens.map((tok) => {
    const syns = ASK_DUCK_SYNONYMS[tok] ?? [];
    return Array.from(new Set([tok, ...syns]));
  });

  const maxResults = intent === 'search' ? 8 : 10;

  const scored = candidates
    .map((item) => {
      const hayParts = [
        item.title,
        item.genre,
        item.synopsis,
        item.studio ?? '',
        item.director ?? '',
        ...(item.cast ?? []),
        ...(item.moodTags ?? []),
        ...(item.seasons ?? []),
        item.fileFormat ?? '',
        item.nasPath,
        String(item.year),
      ];
      const hay = hayParts.join(' ').toLowerCase();

      let matchedGroups = 0;
      let weightedScore = 0;
      const matchedLabels: string[] = [];

      for (const group of expandedGroups) {
        const hitTerm = group.find((term) => hay.includes(term));
        if (hitTerm) {
          matchedGroups += 1;
          let bonus = 10;
          if ((item.seasons ?? []).some((s) => s.toLowerCase().includes(hitTerm))) {
            bonus += 16;
            const seasonHit = item.seasons?.find((s) => s.toLowerCase().includes(hitTerm));
            if (seasonHit) matchedLabels.push(`Jahreszeit: ${seasonHit}`);
          } else if ((item.cast ?? []).some((c) => c.toLowerCase().includes(hitTerm))) {
            bonus += 16;
            matchedLabels.push(
              `Künstler/Besetzung (${item.cast?.find((c) => c.toLowerCase().includes(hitTerm))})`
            );
          } else if ((item.studio ?? '').toLowerCase().includes(hitTerm)) {
            bonus += 15;
            matchedLabels.push(`Studio/Label (${item.studio})`);
          } else if (item.genre.toLowerCase().includes(hitTerm)) {
            bonus += 13;
            matchedLabels.push(`Genre: ${item.genre}`);
          } else if ((item.moodTags ?? []).some((t) => t.toLowerCase().includes(hitTerm))) {
            bonus += 12;
            const tag = item.moodTags?.find((t) => t.toLowerCase().includes(hitTerm));
            if (tag) matchedLabels.push(tag);
          } else {
            matchedLabels.push(hitTerm);
          }
          weightedScore += bonus;
        }
      }

      if (matchedGroups > 1) {
        weightedScore += matchedGroups * 14;
      }

      const reasonParts = Array.from(new Set(matchedLabels)).slice(0, 3);
      const seasonHint = item.seasons?.length ? ` · ${item.seasons.slice(0, 2).join('/')}` : '';
      const reason =
        reasonParts.length > 0
          ? `Passt durch ${reasonParts.join(' · ')}${item.studio ? ` (${item.studio})` : ''}.`
          : `${item.genre} (${item.year}${seasonHint}) auf dem NAS verfügbar.`;

      return { item, matchedGroups, weightedScore, reason };
    })
    .filter((entry) => (expandedGroups.length === 0 ? true : entry.matchedGroups > 0))
    .sort((a, b) => b.weightedScore - a.weightedScore || b.item.year - a.item.year)
    .slice(0, maxResults);

  const actionNoun =
    intent === 'watchlist'
      ? 'Watchlist'
      : intent === 'playlist'
        ? 'Playlist'
        : 'Suchanfrage';

  const duckAnswer =
    scored.length > 0
      ? intent === 'search'
        ? `Quak! Ich habe im Bereich „${scopeLabel}“ ${scored.length} passende Treffer auf deinem NAS gefunden.`
        : `Quak! Ich habe eine ${actionNoun} im Bereich „${scopeLabel}“ mit ${scored.length} passenden NAS-Einträgen für dich zusammengestellt.`
      : `Quak! Für deine ${actionNoun} im Bereich „${scopeLabel}“ habe ich leider keinen genauen Treffer gefunden — probiere ein Genre, eine Stimmung, einen Künstler oder eine Jahreszeit.`;

  return {
    query,
    intent,
    duckAnswer,
    appliedScopeLabel: scopeLabel,
    targetKinds,
    source: 'nas-analyzer' as const,
    collectionSuggestion:
      scored.length > 0 ? buildFallbackCollectionTitle(query, intent, scopeLabel) : null,
    matches: scored.map((s) => ({
      mediaId: s.item.id,
      reason: s.reason,
    })),
  };
}

app.post('/api/nas/ask-duck', requireNasAuth, async (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const rawQuery = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const requestedMode: AskDuckRequestMode =
    req.body?.mode === 'search' ||
    req.body?.mode === 'watchlist' ||
    req.body?.mode === 'playlist'
      ? req.body.mode
      : 'auto';

  if (!rawQuery) {
    res.status(400).json({ error: 'Bitte gib eine Suchanfrage oder Sprachsuche für die Ente ein.' });
    return;
  }

  const catalog = readJsonFile<NasLibraryRecord[]>('catalog.json', []);
  const userFskLimit = getUserFskLimit(username);
  const eligibleItems = catalog.filter(
    (item) => normalizeFskLimit(item.fsk, 0) <= userFskLimit
  );

  const { intent, targetKinds, scopeLabel } = inferAskDuckIntentAndScope(rawQuery, requestedMode);
  recordUserSearchQuery(username, rawQuery, intent);
  const kindSet = new Set(targetKinds);
  const scopedItems = eligibleItems.filter((item) => kindSet.has(item.kind));
  const scopedById = new Map(scopedItems.map((item) => [item.id, item]));
  const maxMatches = intent === 'search' ? 8 : 10;

  if (process.env.GEMINI_API_KEY && scopedItems.length > 0) {
    try {
      const ai = getGeminiClient();
      const compactCatalog = scopedItems.map((item) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        genre: item.genre,
        year: item.year,
        fsk: normalizeFskLimit(item.fsk, 0),
        castOrArtists: item.cast ?? [],
        studioOrLabel: item.studio ?? '',
        director: item.director ?? '',
        moodTags: item.moodTags ?? [],
        seasons: item.seasons ?? [],
        synopsis: item.synopsis,
        fileFormat: item.fileFormat ?? item.codec,
      }));

      const modeInstruction =
        intent === 'watchlist'
          ? 'MODUS: WATCHLIST ERSTELLEN. Stelle eine zusammenhängende Watchlist (max. 10 Titel) passend zu Genre, Stilrichtung, Künstler/Schauspieler, Stimmung oder Jahreszeit zusammen und gib ihr einen passenden deutschen collectionTitle sowie eine kurze criteriaSummary.'
          : intent === 'playlist'
            ? 'MODUS: PLAYLIST ERSTELLEN. Stelle eine stimmige Playlist (max. 10 Einträge über die erlaubten Medientypen Filme, Serien, Musik und Bilder hinweg, falls gewünscht) nach Genre, Stilrichtung, Künstler, Stimmung oder Jahreszeit zusammen und gib ihr einen passenden deutschen collectionTitle sowie eine kurze criteriaSummary.'
            : 'MODUS: KOMPLEXE NAS-SUCHE. Finde die bis zu 8 passendsten Treffer für die Suchanfrage.';

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `${modeInstruction}\n\nAnfrage des Nutzers: "${rawQuery}"\n\nAktiver Medienbereich: ${scopeLabel} (erlaubte Typen: ${targetKinds.join(
          ', '
        )})\n\nNAS-Katalog (JSON):\n${JSON.stringify(compactCatalog)}`,
        config: {
          systemInstruction:
            'Du bist „Frag die Ente“, die intelligente NAS-Mediensuche und Kuratorin von EntenCenter. Analysiere komplexe Anfragen nach Genres, Stilrichtungen (z. B. Neo-Noir, Nordic Noir, Synthwave, Bauhaus, Satire), Künstlern/Schauspielern, Produktionsstudios, Stimmungen (z. B. entspannt, gemütlich, spannend, düster, lustig), Jahreszeiten (Frühling, Sommer, Herbst, Winter) und Dateiformaten ausschließlich auf Basis der bereitgestellten NAS-Katalogdaten. Erfinde NIEMALS Titel oder IDs, die nicht im Katalog stehen. Erkläre für jeden Treffer in 1 knappen deutschen Satz, warum er passt. Antworte als valides JSON gemäß Schema.',
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              duckAnswer: {
                type: Type.STRING,
                description:
                  'Freundliche, präzise deutsche Antwort der Ente in 1-2 Sätzen zu den gefundenen bzw. kuratierten NAS-Inhalten.',
              },
              collectionTitle: {
                type: Type.STRING,
                description:
                  'Kurzer, klangvoller deutscher Titel für die Watchlist oder Playlist (leer lassen bei einfacher Suche).',
              },
              criteriaSummary: {
                type: Type.STRING,
                description:
                  'Kompakte Zusammenfassung der Kriterien (z. B. „Herbst · Ruhig & Gemütlich · Musik & Bilder“).',
              },
              matches: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    mediaId: { type: Type.STRING },
                    reason: {
                      type: Type.STRING,
                      description: 'Kurze Begründung auf Deutsch, warum dieser NAS-Eintrag passt.',
                    },
                  },
                  required: ['mediaId', 'reason'],
                },
              },
            },
            required: ['duckAnswer', 'matches'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        duckAnswer?: string;
        collectionTitle?: string;
        criteriaSummary?: string;
        matches?: Array<{ mediaId?: string; reason?: string }>;
      };

      const validMatches: Array<{ mediaId: string; reason: string }> = [];
      const seenMatchIds = new Set<string>();
      for (const m of parsed.matches ?? []) {
        if (m.mediaId && scopedById.has(m.mediaId) && !seenMatchIds.has(m.mediaId)) {
          seenMatchIds.add(m.mediaId);
          validMatches.push({
            mediaId: m.mediaId,
            reason:
              m.reason?.trim() ||
              `Passend zur Anfrage im Bereich ${scopeLabel}.`,
          });
        }
      }

      if (validMatches.length > 0 || (parsed.duckAnswer && parsed.duckAnswer.trim().length > 0)) {
        const fallbackSuggestion = buildFallbackCollectionTitle(rawQuery, intent, scopeLabel);
        const collectionSuggestion =
          intent !== 'search' && validMatches.length > 0
            ? {
                collectionType: intent === 'watchlist' ? ('watchlist' as const) : ('playlist' as const),
                title:
                  parsed.collectionTitle?.trim() ||
                  fallbackSuggestion?.title ||
                  'Enten-Auswahl',
                criteriaSummary:
                  parsed.criteriaSummary?.trim() ||
                  fallbackSuggestion?.criteriaSummary ||
                  scopeLabel,
              }
            : null;

        res.json({
          query: rawQuery,
          intent,
          duckAnswer:
            parsed.duckAnswer?.trim() ||
            `Quak! Ich habe ${validMatches.length} passende Inhalte auf deinem NAS gefunden.`,
          appliedScopeLabel: scopeLabel,
          targetKinds,
          source: 'gemini',
          collectionSuggestion,
          matches: validMatches.slice(0, maxMatches),
        });
        return;
      }
    } catch {
      // Schneller Fallback auf die lokale komplexe NAS-Suche & Kuration
    }
  }

  const localResult = runLocalAskDuckSearch(
    rawQuery,
    eligibleItems,
    intent,
    targetKinds,
    scopeLabel
  );
  res.json(localResult);
});

// Gemini Multi-Turn Chat Endpoint
const ALLOWED_CHAT_MODELS = new Set([
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-4-carbon',
  'gemini-3.1-flash-lite',
]);

app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  try {
    const { model, messages } = req.body as {
      model?: string;
      messages?: Array<{ role: 'user' | 'model'; text: string }>;
    };

    const selectedModel =
      model && ALLOWED_CHAT_MODELS.has(model) ? model : 'gemini-4-hydrogen';

    if (!messages || messages.length === 0) {
      res.status(400).json({ error: 'Keine Chat-Nachrichten übermittelt.' });
      return;
    }

    const ai = getGeminiClient();
    const systemInstruction =
      'Du bist die EntenCenter Gummi-Ente — der sympathische, hochkompetente Medien- & NAS-Architektur-Assistent für die Android/Android-TV-App EntenCenter. Du kennst dich bestens mit Python (FastAPI, löschresistente NAS-Speicherung), Kotlin (Jetpack Compose, Android TV Leanback, Zero-Local-Footprint), sowie Serien- und Film-Neustarts im deutschsprachigen Raum (DE/AT/CH) aus. Antworte präzise, klar strukturiert und auf Deutsch.';

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    }));

    const lastMessage = messages[messages.length - 1];
    const chat = ai.chats.create({
      model: selectedModel,
      history,
      config: {
        systemInstruction,
      },
    });

    const response: GenerateContentResponse = await chat.sendMessage({
      message: lastMessage.text,
    });

    res.json({
      text: response.text ?? 'Keine Antwort vom Modell erhalten.',
      model: selectedModel,
    });
  } catch (err) {
    const { status, message } = extractGeminiError(err);
    res.status(status).json({ error: message });
  }
});

// Gemini Image Analysis Endpoint (uses gemini-4-argon)
app.post('/api/gemini/analyze-image', async (req: Request, res: Response) => {
  try {
    const { base64Data, mimeType, prompt } = req.body as {
      base64Data?: string;
      mimeType?: string;
      prompt?: string;
    };

    if (!base64Data || !mimeType) {
      res.status(400).json({ error: 'Bitte lade zuerst ein Bild zur Analyse hoch.' });
      return;
    }

    const ai = getGeminiClient();
    const analysisPrompt =
      prompt?.trim() ||
      'Analysiere dieses Bild für EntenCenter: Erkenne ggf. Film-/Serienposter, TV-Szenen, NAS-Hardware oder UI-Screenshots und gib strukturierte Metadaten (Titel, Genre, Stimmung, technische Hinweise) auf Deutsch aus.';

    const response: GenerateContentResponse = await ai.models.generateContent({
      model: 'gemini-4-argon',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          {
            text: analysisPrompt,
          },
        ],
      },
    });

    res.json({
      text: response.text ?? 'Keine Bildanalyse erhalten.',
      model: 'gemini-4-argon',
    });
  } catch (err) {
    const { status, message } = extractGeminiError(err);
    res.status(status).json({ error: message });
  }
});

// --- EntenCenter GitHub Update Check, Skip & Download/Install ---

const DEFAULT_GITHUB_REPOSITORY = 'EntenMedia/EntenCenter2';
const DEFAULT_GITHUB_BRANCH = 'main';

function readPackageVersion(): string {
  try {
    const pkgRaw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normalizeGithubRepoInput(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return null;
  }
  return `${owner}/${repo}`;
}

function getNormalizedAppUpdateState(settings: NasSyncSettings): StoredAppUpdateConfig {
  const raw = settings.appUpdate;
  return {
    repository: normalizeGithubRepoInput(raw?.repository) ?? DEFAULT_GITHUB_REPOSITORY,
    branch:
      typeof raw?.branch === 'string' && raw.branch.trim()
        ? raw.branch.trim()
        : DEFAULT_GITHUB_BRANCH,
    encryptedGithubToken: raw?.encryptedGithubToken ?? null,
    installedVersion:
      typeof raw?.installedVersion === 'string' && raw.installedVersion.trim()
        ? raw.installedVersion.trim()
        : readPackageVersion(),
    installedCommitSha: raw?.installedCommitSha ?? null,
    installedAt: raw?.installedAt ?? null,
    lastCheckedAt: raw?.lastCheckedAt ?? null,
    skippedVersionOrSha: raw?.skippedVersionOrSha ?? null,
  };
}

function serializeAppUpdateConfig(state: StoredAppUpdateConfig) {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  return {
    repository: state.repository,
    branch: state.branch,
    hasGithubToken: Boolean(state.encryptedGithubToken || envToken),
    installedVersion: state.installedVersion ?? readPackageVersion(),
    installedCommitSha: state.installedCommitSha ?? null,
    installedAt: state.installedAt ?? null,
    lastCheckedAt: state.lastCheckedAt ?? null,
    skippedVersionOrSha: state.skippedVersionOrSha ?? null,
  };
}

function resolveGithubToken(state: StoredAppUpdateConfig): string | null {
  const decrypted = decryptNasSecret(state.encryptedGithubToken);
  if (decrypted && decrypted.trim()) return decrypted.trim();
  const envToken = process.env.GITHUB_TOKEN?.trim();
  return envToken || null;
}

function compareSemverStrings(aRaw: string, bRaw: string): number {
  const clean = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const a = clean(aRaw);
  const b = clean(bRaw);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function githubApiRequest(url: string, token: string | null): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'EntenCenter-Updater/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { headers });
}

app.get('/api/nas/system/update/status', requireNasAuth, (_req: AuthedRequest, res: Response) => {
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const state = getNormalizedAppUpdateState(settings);
  res.json(serializeAppUpdateConfig(state));
});

app.put('/api/nas/system/update/config', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const body = req.body as {
    repository?: string;
    branch?: string;
    githubToken?: string;
    clearGithubToken?: boolean;
  };

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const current = getNormalizedAppUpdateState(settings);

  let nextRepo = current.repository;
  if (body.repository !== undefined) {
    const normalized = normalizeGithubRepoInput(body.repository);
    if (!normalized) {
      res.status(400).json({
        error: 'Bitte gib ein gültiges GitHub-Repository im Format „Besitzer/Repository“ an.',
      });
      return;
    }
    nextRepo = normalized;
  }

  let nextBranch = current.branch;
  if (body.branch !== undefined) {
    const cleanBranch = body.branch.trim();
    if (!cleanBranch || !/^[a-zA-Z0-9._/-]+$/.test(cleanBranch)) {
      res.status(400).json({ error: 'Ungültiger Branch-Name.' });
      return;
    }
    nextBranch = cleanBranch;
  }

  let nextEncryptedToken = current.encryptedGithubToken ?? null;
  if (body.clearGithubToken) {
    nextEncryptedToken = null;
  } else if (typeof body.githubToken === 'string' && body.githubToken.trim().length > 0) {
    nextEncryptedToken = encryptNasSecret(body.githubToken.trim());
  }

  const nextState: StoredAppUpdateConfig = {
    ...current,
    repository: nextRepo,
    branch: nextBranch,
    encryptedGithubToken: nextEncryptedToken,
  };
  settings.appUpdate = nextState;
  writeJsonAtomic('settings.json', settings);
  appendWal('APP_UPDATE_CONFIG_UPDATED', username, {
    repository: nextRepo,
    branch: nextBranch,
    hasToken: Boolean(nextEncryptedToken),
  });

  res.json(serializeAppUpdateConfig(nextState));
});

app.post(
  '/api/nas/system/update/check',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    const body = (req.body ?? {}) as { repository?: string; branch?: string };

    const settings = readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
    const current = getNormalizedAppUpdateState(settings);

    const targetRepo =
      body.repository !== undefined
        ? normalizeGithubRepoInput(body.repository)
        : current.repository;

    if (!targetRepo) {
      res.status(400).json({
        error: 'Bitte gib ein gültiges GitHub-Repository im Format „Besitzer/Repository“ an.',
      });
      return;
    }

    const token = resolveGithubToken(current);

    try {
      const repoRes = await githubApiRequest(`https://api.github.com/repos/${targetRepo}`, token);
      if (repoRes.status === 404) {
        res.status(404).json({
          requiresGithubToken: !token,
          error: token
            ? `GitHub-Repository „${targetRepo}“ wurde nicht gefunden oder der hinterlegte Token hat keine Leserechte.`
            : `GitHub-Repository „${targetRepo}“ wurde nicht gefunden oder ist privat. Bitte hinterlege bei einem privaten Repository einen GitHub Personal Access Token.`,
        });
        return;
      }
      if (repoRes.status === 401 || repoRes.status === 403) {
        const errBody = (await repoRes.json().catch(() => ({}))) as { message?: string };
        res.status(repoRes.status).json({
          requiresGithubToken: true,
          error: `GitHub-Zugriff verweigert (${repoRes.status}): ${errBody.message ?? 'Bitte GitHub-Token oder Rate-Limit prüfen.'}`,
        });
        return;
      }
      if (!repoRes.ok) {
        res.status(502).json({
          error: `GitHub-API antwortete mit Status ${repoRes.status}.`,
        });
        return;
      }

      const repoJson = (await repoRes.json()) as {
        default_branch?: string;
        html_url?: string;
      };
      const targetBranch =
        (typeof body.branch === 'string' && body.branch.trim()) ||
        current.branch ||
        repoJson.default_branch ||
        'main';

      // 1. Check latest GitHub Release
      interface GithubLatestReleaseRecord {
        tag_name?: string;
        name?: string;
        body?: string;
        published_at?: string;
        html_url?: string;
        tarball_url?: string;
      }
      let releaseData: GithubLatestReleaseRecord | null = null;
      const releaseRes = await githubApiRequest(
        `https://api.github.com/repos/${targetRepo}/releases/latest`,
        token
      );
      if (releaseRes.ok) {
        releaseData = (await releaseRes.json()) as GithubLatestReleaseRecord;
      }

      // 2. Check latest Commit on targetBranch
      let latestCommitSha: string | null = null;
      let latestCommitMessage = '';
      let latestCommitDate: string | null = null;
      let latestCommitHtmlUrl = `${repoJson.html_url || `https://github.com/${targetRepo}`}/tree/${encodeURIComponent(targetBranch)}`;

      const commitRes = await githubApiRequest(
        `https://api.github.com/repos/${targetRepo}/commits/${encodeURIComponent(targetBranch)}`,
        token
      );
      if (commitRes.ok) {
        const commitJson = (await commitRes.json()) as {
          sha?: string;
          html_url?: string;
          commit?: { message?: string; author?: { date?: string } };
        };
        latestCommitSha = commitJson.sha ?? null;
        latestCommitMessage = commitJson.commit?.message ?? '';
        latestCommitDate = commitJson.commit?.author?.date ?? null;
        if (commitJson.html_url) latestCommitHtmlUrl = commitJson.html_url;
      }

      // 3. Check remote package.json version when no Release exists
      let remotePackageVersion: string | null = null;
      const pkgRes = await githubApiRequest(
        `https://api.github.com/repos/${targetRepo}/contents/package.json?ref=${encodeURIComponent(targetBranch)}`,
        token
      );
      if (pkgRes.ok) {
        const pkgFile = (await pkgRes.json()) as { content?: string; encoding?: string };
        if (pkgFile.content && pkgFile.encoding === 'base64') {
          try {
            const decoded = Buffer.from(pkgFile.content, 'base64').toString('utf8');
            const parsedPkg = JSON.parse(decoded) as { version?: string };
            if (typeof parsedPkg.version === 'string' && parsedPkg.version.trim()) {
              remotePackageVersion = parsedPkg.version.trim();
            }
          } catch {
            // Ignorieren falls package.json auf GitHub nicht parsebar
          }
        }
      }

      const checkedAt = new Date().toISOString();
      const installedVersion = current.installedVersion ?? readPackageVersion();
      const installedSha = current.installedCommitSha ?? null;

      let candidate;
      if (releaseData && releaseData.tag_name) {
        const cleanTagVersion = releaseData.tag_name.replace(/^v/i, '');
        const semverCmp = compareSemverStrings(cleanTagVersion, installedVersion);
        const updateAvailable =
          semverCmp > 0 ||
          (semverCmp === 0 && Boolean(latestCommitSha && installedSha !== latestCommitSha));

        const targetKey = latestCommitSha || cleanTagVersion;
        candidate = {
          updateAvailable,
          sourceType: 'release' as const,
          repository: targetRepo,
          branch: targetBranch,
          currentVersion: installedVersion,
          currentCommitSha: installedSha,
          latestVersion: cleanTagVersion,
          latestTag: releaseData.tag_name,
          latestCommitSha,
          releaseName: releaseData.name?.trim() || `Release ${releaseData.tag_name}`,
          changelog: releaseData.body?.trim() || 'Keine Release-Notizen auf GitHub hinterlegt.',
          publishedAt: releaseData.published_at ?? latestCommitDate,
          htmlUrl: releaseData.html_url ?? latestCommitHtmlUrl,
          downloadUrl:
            releaseData.tarball_url ??
            `https://api.github.com/repos/${targetRepo}/tarball/${encodeURIComponent(releaseData.tag_name)}`,
          checkedAt,
          skipped: Boolean(current.skippedVersionOrSha && current.skippedVersionOrSha === targetKey),
        };
      } else {
        const latestVersion = remotePackageVersion ?? installedVersion;
        const semverCmp = compareSemverStrings(latestVersion, installedVersion);
        const updateAvailable =
          semverCmp > 0 || Boolean(latestCommitSha && installedSha !== latestCommitSha);
        const shortSha = latestCommitSha ? latestCommitSha.slice(0, 7) : targetBranch;
        const targetKey = latestCommitSha || latestVersion;

        candidate = {
          updateAvailable,
          sourceType: 'commit' as const,
          repository: targetRepo,
          branch: targetBranch,
          currentVersion: installedVersion,
          currentCommitSha: installedSha,
          latestVersion,
          latestTag: null,
          latestCommitSha,
          releaseName: `EntenCenter (${targetBranch} · ${shortSha})`,
          changelog:
            latestCommitMessage.trim() ||
            `Aktueller Stand auf Branch „${targetBranch}“ (${shortSha}).`,
          publishedAt: latestCommitDate,
          htmlUrl: latestCommitHtmlUrl,
          downloadUrl: `https://api.github.com/repos/${targetRepo}/tarball/${encodeURIComponent(latestCommitSha || targetBranch)}`,
          checkedAt,
          skipped: Boolean(current.skippedVersionOrSha && current.skippedVersionOrSha === targetKey),
        };
      }

      const nextState: StoredAppUpdateConfig = {
        ...current,
        repository: targetRepo,
        branch: targetBranch,
        lastCheckedAt: checkedAt,
      };
      settings.appUpdate = nextState;
      writeJsonAtomic('settings.json', settings);
      appendWal('APP_UPDATE_CHECKED', username, {
        repository: targetRepo,
        branch: targetBranch,
        updateAvailable: candidate.updateAvailable,
        latestVersion: candidate.latestVersion,
        latestCommitSha: candidate.latestCommitSha,
      });

      res.json({
        candidate,
        config: serializeAppUpdateConfig(nextState),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub-Verbindungsfehler.';
      res.status(502).json({ error: `GitHub-Update-Suche fehlgeschlagen: ${message}` });
    }
  }
);

app.post('/api/nas/system/update/skip', requireNasAuth, (req: AuthedRequest, res: Response) => {
  const username = req.nasUsername!;
  const { versionOrSha } = req.body as { versionOrSha?: string };
  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const current = getNormalizedAppUpdateState(settings);
  const nextState: StoredAppUpdateConfig = {
    ...current,
    skippedVersionOrSha: versionOrSha?.trim() || null,
  };
  settings.appUpdate = nextState;
  writeJsonAtomic('settings.json', settings);
  appendWal('APP_UPDATE_SKIPPED', username, {
    skippedVersionOrSha: nextState.skippedVersionOrSha,
  });
  res.json(serializeAppUpdateConfig(nextState));
});

const PROTECTED_UPDATE_TOP_LEVEL_ENTRIES = new Set([
  'data',
  '.backups',
  'uploads',
  'node_modules',
  '.env',
  '.env.local',
  'firebase-applet-config.json',
  '.git',
  'dist',
]);

app.post(
  '/api/nas/system/update/install',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const username = req.nasUsername!;
    const body = req.body as {
      repository?: string;
      branch?: string;
      targetVersion?: string;
      targetTag?: string | null;
      targetCommitSha?: string | null;
      downloadUrl?: string | null;
    };

    const settings = readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
    const current = getNormalizedAppUpdateState(settings);
    const repo = normalizeGithubRepoInput(body.repository) ?? current.repository;
    const branch = body.branch?.trim() || current.branch;
    const ref = body.targetTag?.trim() || body.targetCommitSha?.trim() || branch;
    const rawDownloadUrl =
      body.downloadUrl?.trim() ||
      `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}`;

    let parsedDownloadUrl: URL;
    try {
      parsedDownloadUrl = new URL(rawDownloadUrl);
    } catch {
      res.status(400).json({ error: 'Ungültige GitHub-Download-URL.' });
      return;
    }

    if (
      parsedDownloadUrl.protocol !== 'https:' ||
      !['api.github.com', 'github.com', 'codeload.github.com'].includes(parsedDownloadUrl.hostname)
    ) {
      res.status(400).json({ error: 'Download ist ausschließlich von GitHub-Domains erlaubt.' });
      return;
    }

    const token = resolveGithubToken(current);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'entencenter-update-'));
    const archivePath = path.join(tmpRoot, 'update.tar.gz');
    const extractDir = path.join(tmpRoot, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'EntenCenter-Updater/1.0',
      };
      if (token && parsedDownloadUrl.hostname === 'api.github.com') {
        headers.Authorization = `Bearer ${token}`;
      }

      const archiveRes = await fetch(parsedDownloadUrl.toString(), {
        headers,
        redirect: 'follow',
      });
      if (!archiveRes.ok) {
        res.status(502).json({
          error: `GitHub-Archiv konnte nicht heruntergeladen werden (Status ${archiveRes.status}).`,
        });
        return;
      }

      const arrayBuf = await archiveRes.arrayBuffer();
      fs.writeFileSync(archivePath, Buffer.from(arrayBuf));

      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir]);

      const extractedEntries = fs
        .readdirSync(extractDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      if (extractedEntries.length === 0) {
        res.status(500).json({ error: 'Heruntergeladenes Update-Archiv enthält keinen Ordner.' });
        return;
      }

      const sourceRoot = path.join(extractDir, extractedEntries[0].name);
      const workspaceRoot = path.resolve(process.cwd());

      const oldPkgPath = path.join(workspaceRoot, 'package.json');
      const newPkgPath = path.join(sourceRoot, 'package.json');
      const oldPkgRaw = fs.existsSync(oldPkgPath) ? fs.readFileSync(oldPkgPath, 'utf8') : '';

      let updatedFilesCount = 0;
      const copyRecursive = (srcDir: string, destDir: string, isTopLevel: boolean) => {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            continue;
          }
          const lowerName = entry.name.toLowerCase();
          if (
            isTopLevel &&
            (PROTECTED_UPDATE_TOP_LEVEL_ENTRIES.has(lowerName) || lowerName.startsWith('.env'))
          ) {
            continue;
          }
          const srcEntry = path.join(srcDir, entry.name);
          const destEntry = path.resolve(destDir, entry.name);
          if (
            !destEntry.startsWith(workspaceRoot + path.sep) ||
            destEntry === NAS_DATA_DIR ||
            destEntry.startsWith(NAS_DATA_DIR + path.sep) ||
            destEntry === NAS_UPLOADS_DIR ||
            destEntry.startsWith(NAS_UPLOADS_DIR + path.sep)
          ) {
            continue;
          }
          if (entry.isDirectory()) {
            fs.mkdirSync(destEntry, { recursive: true });
            copyRecursive(srcEntry, destEntry, false);
          } else if (entry.isFile()) {
            fs.mkdirSync(path.dirname(destEntry), { recursive: true });
            fs.copyFileSync(srcEntry, destEntry);
            updatedFilesCount += 1;
          }
        }
      };

      copyRecursive(sourceRoot, workspaceRoot, true);

      let dependenciesUpdated = false;
      if (fs.existsSync(newPkgPath)) {
        try {
          const oldDeps = oldPkgRaw
            ? JSON.stringify((JSON.parse(oldPkgRaw) as { dependencies?: unknown }).dependencies ?? {})
            : '';
          const newPkgParsed = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')) as {
            dependencies?: unknown;
            version?: string;
          };
          const newDeps = JSON.stringify(newPkgParsed.dependencies ?? {});
          if (oldDeps !== newDeps) {
            await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
              cwd: workspaceRoot,
            });
            dependenciesUpdated = true;
          }
        } catch {
          // Falls npm install nicht nötig oder fehlgeschlagen, weiter mit Update-Abschluss
        }
      }

      const installedAt = new Date().toISOString();
      const installedVersion =
        body.targetVersion?.replace(/^v/i, '').trim() || readPackageVersion();
      const installedCommitSha = body.targetCommitSha?.trim() || null;

      const latestSettings = readJsonFile<NasSyncSettings>('settings.json', {
        syncMode: 'manual',
        lastScanTimestamp: null,
      });
      const nextState: StoredAppUpdateConfig = {
        ...getNormalizedAppUpdateState(latestSettings),
        repository: repo,
        branch,
        installedVersion,
        installedCommitSha,
        installedAt,
        skippedVersionOrSha: null,
      };
      latestSettings.appUpdate = nextState;
      writeJsonAtomic('settings.json', latestSettings);

      appendWal('APP_UPDATE_INSTALLED', username, {
        repository: repo,
        branch,
        installedVersion,
        installedCommitSha,
        updatedFilesCount,
        dependenciesUpdated,
      });

      res.json({
        result: {
          ok: true,
          installedVersion,
          installedCommitSha,
          installedAt,
          updatedFilesCount,
          dependenciesUpdated,
          message:
            'Update erfolgreich von GitHub heruntergeladen und installiert. Bitte starte die Anwendung bei Bedarf neu, um geänderte Server-Module zu aktivieren.',
        },
        config: serializeAppUpdateConfig(nextState),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unbekannter Installationsfehler.';
      res.status(500).json({ error: `Installation fehlgeschlagen: ${msg}` });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
);

function isApkArtifactName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('apk') || lower.includes('android-release') || lower.includes('android-debug');
}

function isSignedReleaseArtifactName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('release') || lower.includes('signed');
}

function sanitizeApkFilename(artifactName: string, rawFileName?: string): string {
  const candidate = (rawFileName || '').trim();
  if (candidate && candidate.toLowerCase().endsWith('.apk')) {
    return candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
  }
  const lower = artifactName.toLowerCase();
  if (lower === 'signed-release-apk') return 'EntenCenter-release-signed.apk';
  if (lower === 'entencenter-debug-apk') return 'EntenCenter-debug.apk';
  const cleaned = artifactName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'EntenCenter';
  return cleaned.toLowerCase().endsWith('.apk') ? cleaned : `${cleaned}.apk`;
}

function findExtractedApkFiles(dir: string): string[] {
  const matches: string[] = [];
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.apk')) {
        matches.push(fullPath);
      }
    }
  };
  walk(dir);
  matches.sort((a, b) => {
    const aLower = path.basename(a).toLowerCase();
    const bLower = path.basename(b).toLowerCase();
    const aScore = (aLower.includes('release') ? 2 : 0) + (aLower.includes('signed') ? 1 : 0);
    const bScore = (bLower.includes('release') ? 2 : 0) + (bLower.includes('signed') ? 1 : 0);
    return bScore - aScore;
  });
  return matches;
}

interface GithubWorkflowRunRecord {
  id: number;
  name?: string;
  path?: string;
  run_number?: number;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  head_sha?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  actor?: { login?: string | null } | null;
  head_commit?: { message?: string | null } | null;
}

interface GithubArtifactRecord {
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
  expired: boolean;
  created_at: string;
  expires_at?: string | null;
  workflow_run?: {
    id?: number;
    head_branch?: string;
    head_sha?: string;
  } | null;
}

app.get(
  '/api/nas/system/update/apk/latest',
  requireNasAuth,
  async (req: AuthedRequest, res: Response) => {
    const settings = readJsonFile<NasSyncSettings>('settings.json', {
      syncMode: 'manual',
      lastScanTimestamp: null,
    });
    const current = getNormalizedAppUpdateState(settings);

    const queryRepo = typeof req.query.repository === 'string' ? req.query.repository : undefined;
    const targetRepo = queryRepo ? normalizeGithubRepoInput(queryRepo) : current.repository;
    if (!targetRepo) {
      res.status(400).json({
        error: 'Bitte gib ein gültiges GitHub-Repository im Format „Besitzer/Repository“ an.',
      });
      return;
    }

    const branchFilter =
      typeof req.query.branch === 'string' && req.query.branch.trim()
        ? req.query.branch.trim()
        : null;
    const token = resolveGithubToken(current);

    try {
      const runsRes = await githubApiRequest(
        `https://api.github.com/repos/${targetRepo}/actions/runs?status=success&per_page=30`,
        token
      );

      if (runsRes.status === 404) {
        res.status(404).json({
          requiresGithubToken: !token,
          error: token
            ? `GitHub Actions für „${targetRepo}“ wurden nicht gefunden oder der Token hat keine Actions-Leserechte.`
            : `GitHub-Repository „${targetRepo}“ wurde nicht gefunden oder ist privat. Bitte hinterlege einen GitHub Personal Access Token.`,
        });
        return;
      }

      if (runsRes.status === 401 || runsRes.status === 403) {
        const errBody = (await runsRes.json().catch(() => ({}))) as { message?: string };
        res.status(runsRes.status).json({
          requiresGithubToken: true,
          error: `GitHub Actions API verweigert den Zugriff (${runsRes.status}): ${errBody.message ?? 'Bitte GitHub-Token oder Rate-Limit prüfen.'}`,
        });
        return;
      }

      if (!runsRes.ok) {
        res.status(502).json({
          error: `GitHub Actions API antwortete mit Status ${runsRes.status}.`,
        });
        return;
      }

      const runsPayload = (await runsRes.json()) as {
        workflow_runs?: GithubWorkflowRunRecord[];
      };

      const successfulRuns = (runsPayload.workflow_runs ?? []).filter(
        (run) =>
          (run.conclusion === 'success' || (!run.conclusion && run.status === 'completed')) &&
          (!branchFilter || run.head_branch === branchFilter)
      );

      const runById = new Map<number, GithubWorkflowRunRecord>();
      for (const run of successfulRuns) {
        runById.set(run.id, run);
      }

      const collected: Array<{ artifact: GithubArtifactRecord; run: GithubWorkflowRunRecord }> = [];
      const seenArtifactIds = new Set<number>();

      // 1. Repo-wide artifacts endpoint (fast single call)
      const artifactsRes = await githubApiRequest(
        `https://api.github.com/repos/${targetRepo}/actions/artifacts?per_page=60`,
        token
      );
      if (artifactsRes.ok) {
        const artifactsPayload = (await artifactsRes.json()) as {
          artifacts?: GithubArtifactRecord[];
        };
        for (const artifact of artifactsPayload.artifacts ?? []) {
          if (artifact.expired || !isApkArtifactName(artifact.name)) continue;
          const runId = artifact.workflow_run?.id;
          if (!runId) continue;
          const matchedRun = runById.get(runId);
          if (!matchedRun) continue;
          if (!seenArtifactIds.has(artifact.id)) {
            seenArtifactIds.add(artifact.id);
            collected.push({ artifact, run: matchedRun });
          }
        }
      }

      // 2. Fallback: inspect top successful Android/APK runs directly if needed
      if (collected.length === 0 && successfulRuns.length > 0) {
        const prioritizedRuns = [...successfulRuns]
          .sort((a, b) => {
            const aLikely = /apk|android|keystore/i.test(`${a.name ?? ''} ${a.path ?? ''}`) ? 1 : 0;
            const bLikely = /apk|android|keystore/i.test(`${b.name ?? ''} ${b.path ?? ''}`) ? 1 : 0;
            return bLikely - aLikely;
          })
          .slice(0, 6);

        const perRunResults = await Promise.all(
          prioritizedRuns.map(async (run) => {
            const r = await githubApiRequest(
              `https://api.github.com/repos/${targetRepo}/actions/runs/${run.id}/artifacts?per_page=20`,
              token
            );
            if (!r.ok) return [] as Array<{ artifact: GithubArtifactRecord; run: GithubWorkflowRunRecord }>;
            const data = (await r.json()) as { artifacts?: GithubArtifactRecord[] };
            return (data.artifacts ?? [])
              .filter((a) => !a.expired && isApkArtifactName(a.name))
              .map((artifact) => ({ artifact, run }));
          })
        );

        for (const batch of perRunResults) {
          for (const entry of batch) {
            if (!seenArtifactIds.has(entry.artifact.id)) {
              seenArtifactIds.add(entry.artifact.id);
              collected.push(entry);
            }
          }
        }
      }

      collected.sort((a, b) => {
        const tsDiff = Date.parse(b.artifact.created_at) - Date.parse(a.artifact.created_at);
        if (Math.abs(tsDiff) > 60_000) return tsDiff;
        const aSigned = isSignedReleaseArtifactName(a.artifact.name) ? 1 : 0;
        const bSigned = isSignedReleaseArtifactName(b.artifact.name) ? 1 : 0;
        if (bSigned !== aSigned) return bSigned - aSigned;
        return tsDiff;
      });

      const candidates = collected.slice(0, 6).map(({ artifact, run }) => {
        const commitFirstLine = (run.head_commit?.message || '').split(/\r?\n/)[0]?.trim() || '';
        return {
          artifactId: artifact.id,
          artifactName: artifact.name,
          suggestedFilename: sanitizeApkFilename(artifact.name),
          sizeInBytes: artifact.size_in_bytes,
          createdAt: artifact.created_at,
          expiresAt: artifact.expires_at ?? null,
          expired: artifact.expired,
          isSignedRelease: isSignedReleaseArtifactName(artifact.name),
          archiveDownloadUrl: artifact.archive_download_url,
          workflowRunId: run.id,
          workflowRunNumber: run.run_number ?? run.id,
          workflowName: run.name?.trim() || 'Android APK Build',
          workflowEvent: run.event ?? 'workflow_dispatch',
          headBranch: run.head_branch ?? artifact.workflow_run?.head_branch ?? current.branch,
          headSha: run.head_sha ?? artifact.workflow_run?.head_sha ?? '',
          commitMessage: commitFirstLine,
          actorLogin: run.actor?.login ?? null,
          runHtmlUrl:
            run.html_url ??
            `https://github.com/${targetRepo}/actions/runs/${run.id}`,
          proxyDownloadPath: `/api/nas/system/update/apk/download?artifactId=${artifact.id}&repository=${encodeURIComponent(targetRepo)}`,
        };
      });

      res.json({
        repository: targetRepo,
        checkedAt: new Date().toISOString(),
        hasGithubToken: Boolean(token),
        actionsHtmlUrl: `https://github.com/${targetRepo}/actions`,
        latest: candidates[0] ?? null,
        recentArtifacts: candidates,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'GitHub Actions API Verbindungsfehler.';
      res.status(502).json({ error: `GitHub Actions Abfrage fehlgeschlagen: ${msg}` });
    }
  }
);

app.get('/api/nas/system/update/apk/download', async (req: Request, res: Response) => {
  const username = resolveTokenFromRequest(req);
  if (!username) {
    res.status(401).json({ error: 'Ungültige oder fehlende NAS-Session.' });
    return;
  }

  const rawArtifactId = typeof req.query.artifactId === 'string' ? req.query.artifactId.trim() : '';
  if (!/^\d+$/.test(rawArtifactId)) {
    res.status(400).json({ error: 'Ungültige GitHub Artifact-ID.' });
    return;
  }

  const settings = readJsonFile<NasSyncSettings>('settings.json', {
    syncMode: 'manual',
    lastScanTimestamp: null,
  });
  const current = getNormalizedAppUpdateState(settings);
  const queryRepo = typeof req.query.repository === 'string' ? req.query.repository : undefined;
  const repo = queryRepo ? normalizeGithubRepoInput(queryRepo) : current.repository;
  if (!repo) {
    res.status(400).json({ error: 'Ungültiges GitHub-Repository.' });
    return;
  }

  const token = resolveGithubToken(current);
  if (!token) {
    res.status(401).json({
      requiresGithubToken: true,
      error:
        'Für den direkten APK-Download über GitHub Actions ist ein GitHub Personal Access Token (mit actions:read / repo) erforderlich.',
    });
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'entencenter-apk-'));
  let cleanupDone = false;
  const cleanupTemp = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignorieren falls bereits bereinigt
    }
  };

  try {
    const metaRes = await githubApiRequest(
      `https://api.github.com/repos/${repo}/actions/artifacts/${rawArtifactId}`,
      token
    );
    if (!metaRes.ok) {
      cleanupTemp();
      res.status(metaRes.status === 404 ? 404 : 502).json({
        error: `GitHub Actions Artefakt #${rawArtifactId} konnte nicht abgerufen werden (Status ${metaRes.status}).`,
      });
      return;
    }

    const meta = (await metaRes.json()) as GithubArtifactRecord;
    if (meta.expired) {
      cleanupTemp();
      res.status(410).json({
        error: 'Dieses GitHub Actions Build-Artefakt ist abgelaufen. Bitte starte einen neuen Build auf GitHub.',
      });
      return;
    }

    const zipRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/artifacts/${rawArtifactId}/zip`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'EntenCenter-Updater/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
      }
    );

    if (!zipRes.ok) {
      cleanupTemp();
      res.status(zipRes.status === 401 || zipRes.status === 403 ? zipRes.status : 502).json({
        requiresGithubToken: zipRes.status === 401 || zipRes.status === 403,
        error: `GitHub-Artefakt-Download fehlgeschlagen (Status ${zipRes.status}).`,
      });
      return;
    }

    const zipPath = path.join(tmpRoot, 'artifact.zip');
    const extractDir = path.join(tmpRoot, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    const arrayBuf = await zipRes.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(arrayBuf));

    let sendPath = zipPath;
    let downloadName = `${meta.name.replace(/[^a-zA-Z0-9._-]/g, '-')}.zip`;
    let contentType = 'application/zip';

    try {
      await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);
      const apkFiles = findExtractedApkFiles(extractDir);
      if (apkFiles.length > 0) {
        sendPath = apkFiles[0];
        downloadName = sanitizeApkFilename(meta.name, path.basename(sendPath));
        contentType = 'application/vnd.android.package-archive';
      }
    } catch {
      // Fallback: ZIP-Archiv unverändert ausliefern, falls unzip scheitert
    }

    const stat = fs.statSync(sendPath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-store');

    appendWal('ANDROID_APK_DOWNLOADED', username, {
      repository: repo,
      artifactId: meta.id,
      artifactName: meta.name,
      filename: downloadName,
    });

    const stream = fs.createReadStream(sendPath);
    res.on('finish', cleanupTemp);
    res.on('close', cleanupTemp);
    stream.on('error', (streamErr) => {
      console.error('Fehler beim Senden der APK:', streamErr);
      cleanupTemp();
      if (!res.headersSent) {
        res.status(500).json({ error: 'Fehler beim Streamen der APK-Datei.' });
      }
    });
    stream.pipe(res);
  } catch (err) {
    cleanupTemp();
    const msg = err instanceof Error ? err.message : 'Unbekannter Downloadfehler.';
    if (!res.headersSent) {
      res.status(500).json({ error: `APK-Download fehlgeschlagen: ${msg}` });
    }
  }
});

const ANDROID_ICON_FILES: Record<string, string> = {
  mdpi: path.resolve(process.cwd(), 'app/src/main/res/mipmap-mdpi/ic_launcher.png'),
  hdpi: path.resolve(process.cwd(), 'app/src/main/res/mipmap-hdpi/ic_launcher.png'),
  xhdpi: path.resolve(process.cwd(), 'app/src/main/res/mipmap-xhdpi/ic_launcher.png'),
  xxhdpi: path.resolve(process.cwd(), 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png'),
  xxxhdpi: path.resolve(process.cwd(), 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'),
  master: path.resolve(process.cwd(), 'app/src/main/ic_launcher-playstore.png'),
};

app.get('/api/nas/system/android-icons/:variant', (req: Request, res: Response) => {
  const variant = String(req.params.variant || '').toLowerCase();
  const targetPath = ANDROID_ICON_FILES[variant];
  if (!targetPath || !fs.existsSync(targetPath)) {
    res.status(404).json({ error: 'App-Icon nicht gefunden.' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(targetPath);
});

app.get(['/EntenCenter-Projekt.zip', '/api/project-export.zip'], (_req: Request, res: Response) => {
  const zipPath = path.resolve(process.cwd(), 'EntenCenter-Projekt.zip');
  if (!fs.existsSync(zipPath)) {
    res.status(404).json({ error: 'Projekt-ZIP-Datei wurde nicht gefunden.' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.download(zipPath, 'EntenCenter-Projekt.zip');
});

async function startServer() {
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error('Unbehandelter Express-Fehler:', err);
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'Interner Serverfehler bei der Verarbeitung.' });
      return;
    }
    res.status(500).send('Interner Serverfehler');
  });

  let viteMiddlewareHandler: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
  let viteReadyPromise: Promise<void> | null = null;

  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    viteReadyPromise = (async () => {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          ...(disableHmr ? { hmr: false, ws: false } : {}),
        },
        appType: 'spa',
      });
      viteMiddlewareHandler = vite.middlewares;
    })().catch((err) => {
      console.error('Vite Dev-Middleware konnte nicht initialisiert werden:', err);
      process.exit(1);
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (viteMiddlewareHandler) {
        return viteMiddlewareHandler(req, res, next);
      }
      if (!viteReadyPromise) {
        return next();
      }
      viteReadyPromise
        .then(() => {
          if (viteMiddlewareHandler) {
            viteMiddlewareHandler(req, res, next);
          } else {
            next();
          }
        })
        .catch(next);
    });
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath, { maxAge: '7d', etag: true }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Gemeinsamer Heartbeat-Timer für alle aktiven Clients (O(1) statt N Timer)
  const sharedHeartbeatTimer = setInterval(() => {
    if (nasStatusClients.size === 0) return;
    const payload = JSON.stringify({
      type: 'nas:heartbeat',
      transport: 'websocket',
      ...buildNasStatusPayload(),
    });
    for (const client of nasStatusClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      } else if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
        nasStatusClients.delete(client);
      }
    }
  }, 30000);
  sharedHeartbeatTimer.unref?.();

  wss.on('connection', (ws: WebSocket) => {
    nasStatusClients.add(ws);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'nas:status',
          transport: 'websocket',
          ...buildNasStatusPayload(),
        })
      );
    }

    ws.on('message', (rawMsg) => {
      try {
        const parsed = JSON.parse(rawMsg.toString()) as { type?: string; clientTs?: number };
        if (parsed.type === 'ping' && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'pong',
              clientTs: parsed.clientTs,
              transport: 'websocket',
              ...buildNasStatusPayload(),
            })
          );
        }
      } catch {
        // Ungültige Client-Nachrichten ignorieren
      }
    });

    const cleanup = () => {
      nasStatusClients.delete(ws);
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(request.url ?? '/', `http://${request.headers.host || 'localhost'}`);
    if (parsedUrl.pathname !== '/ws/nas-status') {
      return;
    }

    const tokenParam = parsedUrl.searchParams.get('token');
    const username = verifyRawToken(tokenParam);
    if (!username) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  const preferredFallbackPort = Number(process.env.PORT_FALLBACK);
  const candidateListenPorts = Array.from(
    new Set([
      PORT,
      ...(Number.isInteger(preferredFallbackPort) && preferredFallbackPort > 0 && preferredFallbackPort <= 65535
        ? [preferredFallbackPort]
        : []),
      ...ALTERNATIVE_ENTENCENTER_PORTS,
    ])
  );
  const autoPortFallbackEnabled = process.env.PORT_AUTO_FALLBACK !== '0';
  let portCandidateIndex = 0;
  let primaryPortRetries = 0;
  const MAX_PRIMARY_PORT_RETRIES = 6;

  const listenOnNextPort = () => {
    const targetPort = candidateListenPorts[portCandidateIndex];
    activeServerPort = targetPort;
    httpServer.listen(targetPort, '0.0.0.0');
  };

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    const isPortIssue = err?.code === 'EADDRINUSE' || err?.code === 'EACCES';
    if (
      err?.code === 'EADDRINUSE' &&
      portCandidateIndex === 0 &&
      primaryPortRetries < MAX_PRIMARY_PORT_RETRIES
    ) {
      primaryPortRetries += 1;
      setTimeout(listenOnNextPort, 250);
      return;
    }
    if (isPortIssue && autoPortFallbackEnabled && portCandidateIndex + 1 < candidateListenPorts.length) {
      const failedPort = candidateListenPorts[portCandidateIndex];
      portCandidateIndex += 1;
      const nextPort = candidateListenPorts[portCandidateIndex];
      console.warn(
        `Port ${failedPort} nicht verfügbar (${err.code}). Weiche automatisch auf Ausweichport :${nextPort} aus...`
      );
      setTimeout(listenOnNextPort, 80);
      return;
    }
    console.error(`EntenCenter-Server konnte nicht gestartet werden (${err?.code || 'ERR'}):`, err);
    process.exit(1);
  });

  httpServer.on('listening', () => {
    console.log(`EntenCenter NAS & Web Server läuft auf http://0.0.0.0:${activeServerPort}`);
    startMdnsResponder({ port: activeServerPort });
  });

  listenOnNextPort();
}

process.on('unhandledRejection', (reason) => {
  console.error('Unbehandelte Promise-Rejection abgefangen:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Unbehandelte Exception abgefangen:', err);
});

startServer();
