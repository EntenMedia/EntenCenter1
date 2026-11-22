import type { StreamingProviderDE } from '../data/germanProviders';

export type { StreamingProviderDE };

export type MediaKind = 'movie' | 'series' | 'image' | 'music' | 'video' | 'other';

export type SeriesProductionStatus = 'returning' | 'ended' | 'canceled';

export type FskLevel = 0 | 6 | 12 | 16 | 18;

export const FSK_LEVELS: FskLevel[] = [0, 6, 12, 16, 18];

export interface NasUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'family';
  fskLimit: FskLevel;
  hasNasWriteAccess?: boolean;
  createdAt: string;
  avatarColor: string;
  avatarUrl?: string | null;
}

export interface EpisodeInfo {
  season: number;
  episode: number;
  title: string;
  durationMinutes: number;
}

export interface NasSeriesEpisode {
  season: number;
  episode: number;
  title: string;
  summary: string;
  durationMinutes: number;
  nasPath: string;
  fileSize: string;
  watched: boolean;
  screenshotKey?: string;
  screenshotUrl?: string;
}

export interface NasMediaItem {
  id: string;
  tmdbId: number;
  title: string;
  kind: MediaKind;
  genre: string;
  year: number;
  coverUrl: string;
  synopsis: string;
  codec: string;
  audioTracks: string[];
  subtitles: string[];
  totalDurationMinutes: number;
  watchedMinutes: number;
  episodesWatchedCount: number;
  totalEpisodes?: number;
  currentEpisode?: EpisodeInfo;
  episodes?: NasSeriesEpisode[];
  lastWatchedAt: string | null;
  addedAt?: string;
  nasPath: string;
  inWatchlist?: boolean;
  fileFormat?: string;
  fileSize?: string;
  fsk?: FskLevel;
  seriesStatus?: SeriesProductionStatus;
  seriesStatusDetail?: string;
  cast?: string[];
  studio?: string;
  director?: string;
  moodTags?: string[];
  seasons?: string[];
  mediaUrl?: string;
  uploadedFileName?: string;
  uploadedMimeType?: string;
  uploadedByteSize?: number;
  customCoverUrl?: string;
  coverCandidates?: string[];
  manualKindLock?: boolean;
  releaseDate?: string;
  watchedWithoutDate?: boolean;
}

export type WatchDateSelectionMode = 'now' | 'release' | 'custom' | 'without_date';

export interface MarkWatchedDateOptions {
  watchedAt?: string | null;
  dateMode?: WatchDateSelectionMode;
}

export interface MediaOnlineSearchCandidate {
  id: string;
  title: string;
  kind: 'movie' | 'series';
  year?: number;
  releaseDate?: string;
  genre: string;
  synopsis: string;
  coverUrl?: string;
  coverCandidates: string[];
  director?: string;
  studio?: string;
  cast?: string[];
  durationMinutes?: number;
  seriesStatus?: SeriesProductionStatus;
  fsk?: FskLevel;
  sourceLabel: string;
}

export interface AdminNasCatalogItem {
  id: string;
  title: string;
  kind: MediaKind;
  genre: string;
  year: number;
  fsk: FskLevel;
  synopsis: string;
  codec: string;
  nasPath: string;
  totalDurationMinutes: number;
  totalEpisodes?: number;
  fileFormat?: string;
  fileSize?: string;
  addedAt?: string;
  hasUploadedFile: boolean;
  uploadedFileName?: string;
  uploadedMimeType?: string;
  uploadedByteSize?: number;
  mediaUrl?: string;
  customCoverUrl?: string;
  coverKey?: string;
}

export interface PlaybackQueueItem {
  queueId: string;
  media: NasMediaItem;
}

export interface CalendarRelease {
  id: string;
  tmdbId: number;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  releaseDate: string; // ISO YYYY-MM-DD
  region: 'DE';
  provider: StreamingProviderDE;
  genre: string;
  coverKey?: string;
  coverUrl?: string;
  synopsis: string;
  cast: string[];
  isSeasonPremiere: boolean;
  isAvailableNow: boolean;
  fsk?: FskLevel;
  seriesStatus?: SeriesProductionStatus;
  seriesStatusDetail?: string;
  nasMatch: {
    matched: boolean;
    availableOnNas: boolean;
    seriesOnNas: boolean;
    seasonOnNas: boolean;
    episodeOnNas: boolean;
    availableSeasonsOnNas: number[];
    seasonEpisodesOnNasCount: number;
    nasMediaId?: string;
    nasTitle?: string;
    nasPath?: string;
    codec?: string;
    episodesWatchedOnNas: number;
    lastSeasonWatched?: number;
    statusLabel: string;
  };
  favorite: {
    isFavorite: boolean;
    source: 'auto' | 'manual' | 'none';
    reason: string;
  };
}

export interface SeriesLookupCandidate {
  id: string;
  title: string;
  year?: number;
  season: number;
  episode: number;
  episodeTitle: string;
  releaseDate: string;
  provider: StreamingProviderDE;
  networkLabel?: string;
  genre: string;
  synopsis: string;
  cast: string[];
  coverUrl?: string;
  seriesStatus?: SeriesProductionStatus;
  fsk?: FskLevel;
  sourceLabel: string;
}

export interface NasAddedCategoryGroup {
  category: string;
  kind: MediaKind;
  titles: string[];
}

export type AdminNotificationMessageType = 'maintenance' | 'new_content' | 'general';

export const ADMIN_NOTIFICATION_TYPE_OPTIONS: Array<{
  id: AdminNotificationMessageType;
  label: string;
  description: string;
  providerLabel: string;
  titlePlaceholder: string;
  messagePlaceholder: string;
}> = [
  {
    id: 'maintenance',
    label: 'Wartung',
    description: 'Systemupdates, NAS-Neustarts oder geplante Wartungsfenster',
    providerLabel: 'EntenCenter Wartung',
    titlePlaceholder: 'z. B. Geplantes NAS-Wartungsfenster heute 23:00 Uhr',
    messagePlaceholder:
      'Beschreibe Zeitraum, betroffene Dienste und erwartete Dauer der Wartung...',
  },
  {
    id: 'new_content',
    label: 'Neue Inhalte',
    description: 'Hinweise auf neue Filme, Serien, Musik oder Bilder',
    providerLabel: 'EntenCenter Mediathek',
    titlePlaceholder: 'z. B. Neue 4K-Filme & Serienstaffeln hinzugefügt',
    messagePlaceholder:
      'Nenne neu verfügbare Titel, Staffeln oder Highlights in der Mediathek...',
  },
  {
    id: 'general',
    label: 'Allgemein',
    description: 'Allgemeine Ankündigungen und Familien-Hinweise',
    providerLabel: 'EntenCenter Admin',
    titlePlaceholder: 'z. B. Wichtiger Hinweis zur Nutzung von EntenCenter',
    messagePlaceholder:
      'Schreibe hier deine allgemeine Benachrichtigung für alle Benutzer von EntenCenter...',
  },
];

export interface NasNotification {
  id: string;
  username?: string;
  seriesTitle: string;
  info: string;
  provider: StreamingProviderDE | 'EntenCenter NAS' | 'EntenCenter Admin' | string;
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
  categoryItems?: NasAddedCategoryGroup[];
  totalAddedCount?: number;
}

export interface AdminBroadcastNotificationSummary {
  broadcastId: string;
  title: string;
  message: string;
  messageType: AdminNotificationMessageType;
  createdAt: string;
  senderLabel: string;
  recipientCount: number;
  readCount: number;
}

export type FilmReleaseRegion = 'DE' | 'AT' | 'DE/AT';

export type FilmReleaseChannel = 'Kino' | 'Streaming' | 'Kino & Streaming';

export interface FilmGroundSource {
  title: string;
  uri: string;
}

export interface FilmNasMatch {
  availableOnNas: boolean;
  nasMediaId?: string;
  nasTitle?: string;
  nasKind?: MediaKind;
  nasPath?: string;
  codec?: string;
  year?: number;
  statusLabel: string;
}

export interface FilmStartRelease {
  id: string;
  title: string;
  releaseDate: string; // ISO YYYY-MM-DD (main/earliest start date in DE or AT)
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
  coverUrl?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  isReleasedNow: boolean;
  nasMatch: FilmNasMatch;
  favorite: {
    isFavorite: boolean;
    source: 'manual' | 'none';
    reason: string;
  };
}

export interface FilmStartsResponse {
  releases: FilmStartRelease[];
  alerts: NasNotification[];
  sources: FilmGroundSource[];
  lastFetchedAt: string | null;
  fetchMethod: 'gemini-search' | 'live-web' | 'mixed' | 'cache';
  fetchWarning?: string | null;
}

export interface SeriesCalendarResponse {
  releases: CalendarRelease[];
  alerts: NasNotification[];
  sources?: FilmGroundSource[];
  lastFetchedAt?: string | null;
  fetchMethod?: 'gemini-search' | 'live-web' | 'mixed' | 'cache';
  fetchWarning?: string | null;
}

export interface WatchStatistics {
  totals: {
    weekHours: number;
    monthHours: number;
    yearHours: number;
    completedTitles: number;
    activeSeriesCount: number;
  };
  weeklyTrend: Array<{ label: string; hours: number; episodes: number }>;
  monthlyTrend: Array<{ label: string; hours: number }>;
  yearlyTrend: Array<{ label: string; hours: number }>;
  genreBreakdown: Array<{ genre: string; hours: number; percentage: number }>;
  historyItems: Array<{
    mediaId: string;
    title: string;
    mediaType: MediaKind;
    genre: string;
    year?: number;
    coverKey?: string;
    coverUrl?: string;
    watchedMinutes: number;
    episodesWatched: number;
    timestamp: string | null;
    watchedWithoutDate?: boolean;
  }>;
}

export type GeminiModelId =
  | 'gemini-4-hydrogen'
  | 'gemini-4-argon'
  | 'gemini-4-carbon'
  | 'gemini-3.1-flash-lite';

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  model?: GeminiModelId;
  timestamp: string;
}

export interface CodeModuleFile {
  id: string;
  moduleGroup: 'backend-auth' | 'calendar-sync' | 'statistics';
  filename: string;
  language: 'python' | 'kotlin';
  platform: string;
  summary: string;
  code: string;
}

export interface DuckBehaviorAnalysis {
  watchedTitlesCount: number;
  completedTitlesCount: number;
  inProgressSeriesCount: number;
  totalWatchHours: number;
  watchlistCount: number;
  savedCollectionsCount: number;
  recentWatchedTitles: string[];
  topMoods: string[];
  topCreatorsOrCast: string[];
  recentSearchInterests: string[];
  viewingPattern: string;
  preferredTimeWindow: string;
  analysisHeadline: string;
}

export interface DuckRecommendationItem {
  mediaId: string;
  reason: string;
  score: number;
  matchedSignals?: string[];
}

export interface DuckRecommendationData {
  duckSummary: string;
  topGenres: string[];
  source: 'gemini' | 'nas-analyzer';
  generatedAt: string;
  analysis?: DuckBehaviorAnalysis;
  items: DuckRecommendationItem[];
}

export type AskDuckMode = 'auto' | 'search' | 'watchlist' | 'playlist';

export type AskDuckCollectionType = 'watchlist' | 'playlist';

export interface AskDuckCollectionSuggestion {
  collectionType: AskDuckCollectionType;
  title: string;
  criteriaSummary: string;
}

export interface AskDuckMatch {
  mediaId: string;
  reason: string;
}

export interface AskDuckResponse {
  query: string;
  intent: 'search' | 'watchlist' | 'playlist';
  duckAnswer: string;
  appliedScopeLabel: string;
  targetKinds: MediaKind[];
  source: 'gemini' | 'nas-analyzer';
  collectionSuggestion?: AskDuckCollectionSuggestion | null;
  matches: AskDuckMatch[];
}

export interface NasSavedCollection {
  id: string;
  title: string;
  collectionType: AskDuckCollectionType;
  criteriaSummary: string;
  createdByPrompt: string;
  mediaIds: string[];
  createdAt: string;
}

export type ThemePresetId =
  | 'cinema-amber'
  | 'nordic-cyan'
  | 'emerald-vault'
  | 'crimson-premiere'
  | 'amethyst-studio'
  | 'silver-glass'
  | 'light'
  | 'high-contrast';

export type AutoThemeMode = 'off' | 'time' | 'location';
export type AutoThemeDayTarget = 'light' | 'high-contrast';
export type AutoThemeNightTarget =
  | 'cinema-amber'
  | 'nordic-cyan'
  | 'emerald-vault'
  | 'crimson-premiere'
  | 'amethyst-studio'
  | 'silver-glass';

export interface AutoThemeConfig {
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

export const DEFAULT_AUTO_THEME_CONFIG: AutoThemeConfig = {
  mode: 'off',
  dayTheme: 'light',
  nightTheme: 'cinema-amber',
  dayStartTime: '07:00',
  nightStartTime: '19:00',
  latitude: null,
  longitude: null,
  locationLabel: null,
  lastLocationUpdatedAt: null,
};

export interface CustomThemePalette {
  background: string;
  sidebar: string;
  surface: string;
  accent: string;
  text: string;
  border: string;
}

export interface CustomThemeSettings {
  activeFor: 'none' | 'design1' | 'design2';
  design1: CustomThemePalette;
  design2: CustomThemePalette;
}

export const DEFAULT_DESIGN1_CUSTOM_PALETTE: CustomThemePalette = {
  background: '#0B0E14',
  sidebar: '#0F141E',
  surface: '#121722',
  accent: '#FBBF24',
  text: '#F1F5F9',
  border: '#1E293B',
};

export const DEFAULT_DESIGN2_CUSTOM_PALETTE: CustomThemePalette = {
  background: '#1E2229',
  sidebar: '#3A404C',
  surface: '#4A5260',
  accent: '#CBD5E1',
  text: '#F8FAFC',
  border: '#94A3B8',
};

export const DEFAULT_CUSTOM_THEME_SETTINGS: CustomThemeSettings = {
  activeFor: 'none',
  design1: DEFAULT_DESIGN1_CUSTOM_PALETTE,
  design2: DEFAULT_DESIGN2_CUSTOM_PALETTE,
};

export type HomeRowKey =
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

export type HomeToggleKey = HomeRowKey;

export type AudioPlayerMode = 'internal' | 'external';

export type CalendarNotificationMode =
  | 'favorites_all'
  | 'favorites_new_series'
  | 'favorites_new_episodes'
  | 'all'
  | 'all_new_series'
  | 'all_new_episodes';

export type FilmNotificationMode = 'favorites' | 'all';

export interface UserPreferences {
  theme: ThemePresetId;
  customTheme?: CustomThemeSettings;
  autoTheme?: AutoThemeConfig;
  homeSectionOrder: HomeRowKey[];
  hiddenHomeSections: HomeToggleKey[];
  showHomeCategoryTabs?: boolean;
  showHomeFilterSearch?: boolean;
  audioPlayerMode: AudioPlayerMode;
  duckAssistantEnabled: boolean;
  playerControlsTimeoutSec?: number;
  playerSeekBackwardSec?: number;
  playerSeekForwardSec?: number;
  calendarNotificationMode?: CalendarNotificationMode;
  filmNotificationMode?: FilmNotificationMode;
}

export const DEFAULT_HOME_ROW_ORDER: HomeRowKey[] = [
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

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: 'cinema-amber',
  customTheme: DEFAULT_CUSTOM_THEME_SETTINGS,
  autoTheme: DEFAULT_AUTO_THEME_CONFIG,
  homeSectionOrder: DEFAULT_HOME_ROW_ORDER,
  hiddenHomeSections: [],
  showHomeCategoryTabs: false,
  showHomeFilterSearch: false,
  audioPlayerMode: 'internal',
  duckAssistantEnabled: true,
  playerControlsTimeoutSec: 3,
  playerSeekBackwardSec: 30,
  playerSeekForwardSec: 30,
  calendarNotificationMode: 'favorites_all',
  filmNotificationMode: 'favorites',
};

export interface NasStorageStats {
  mountPath: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  freePercent: number;
  moviesCount: number;
  moviesBytes: number;
  seriesCount: number;
  episodesCount: number;
  seriesBytes: number;
  musicCount?: number;
  musicBytes?: number;
  videosCount?: number;
  videosBytes?: number;
  imagesCount?: number;
  imagesBytes?: number;
  otherFilesCount?: number;
  otherFilesBytes?: number;
  scannedTotalBytes?: number;
  scannedFilesCount?: number;
  volumeSource?: string;
  isPhysicalVolumeReported?: boolean;
  vaultBytes: number;
  measuredAt: string;
}

export type SyncMode = 'manual' | 'every_start' | 'daily_first';

export type NasProtocolId =
  | 'smb'
  | 'nfs'
  | 'webdav'
  | 'sftp'
  | 'ftps'
  | 'api_token'
  | 'fritz_upnp';

export interface NasProtocolOption {
  id: NasProtocolId;
  label: string;
  shortLabel: string;
  defaultPort: string;
  defaultPath: string;
  description: string;
}

export const NAS_PROTOCOL_CATALOG: NasProtocolOption[] = [
  {
    id: 'smb',
    label: 'SMB / CIFS',
    shortLabel: 'SMB',
    defaultPort: '445',
    defaultPath: '/Medien',
    description: 'Standard für Windows, macOS, Synology, QNAP & Unraid',
  },
  {
    id: 'nfs',
    label: 'NFS',
    shortLabel: 'NFS',
    defaultPort: '2049',
    defaultPath: '/volume1/video',
    description: 'Netzwerk-Dateisystem für Linux, TrueNAS & Media-Clients',
  },
  {
    id: 'webdav',
    label: 'WebDAV (HTTPS)',
    shortLabel: 'WebDAV',
    defaultPort: '5006',
    defaultPath: '/Medien',
    description: 'Verschlüsselter Web-Dateizugriff für DSM & Nextcloud',
  },
  {
    id: 'sftp',
    label: 'SFTP / SSH',
    shortLabel: 'SFTP',
    defaultPort: '22',
    defaultPath: '/mnt/nas/medien',
    description: 'Sicherer Transfer mit Passwort oder SSH-Schlüssel',
  },
  {
    id: 'ftps',
    label: 'FTP / FTPS',
    shortLabel: 'FTPS',
    defaultPort: '21',
    defaultPath: '/',
    description: 'Klassischer FTP-Zugang mit explizitem oder implizitem TLS',
  },
  {
    id: 'api_token',
    label: 'API-Token / NAS-OS',
    shortLabel: 'API-Token',
    defaultPort: '5001',
    defaultPath: '/api/v3',
    description: 'Direktanmeldung für Synology DSM, QNAP QTS, TrueNAS & Unraid',
  },
  {
    id: 'fritz_upnp',
    label: 'FRITZ!Box UPnP / DLNA',
    shortLabel: 'FRITZ!Box UPnP',
    defaultPort: '49000',
    defaultPath: '/MediaServer',
    description: 'Heimnetz-NVS/Mediaserver ohne extra Anmeldung über FRITZ!Box UPnP/DLNA',
  },
];

export const ALL_NAS_PROTOCOLS: NasProtocolId[] = NAS_PROTOCOL_CATALOG.map((p) => p.id);

export interface NasConnectionConfig {
  protocol: NasProtocolId;
  host: string;
  port: string;
  shareOrPath: string;
  username: string;
  hasSecret: boolean;
  accessMode?: 'read_write' | 'read_only';
  writePermissions?: boolean;
  domainOrWorkgroup?: string;
  nfsVersion?: 'NFSv4.1' | 'NFSv4' | 'NFSv3';
  nfsAuthMode?: 'AUTH_SYS' | 'Kerberos (krb5p)';
  sftpAuthMode?: 'password' | 'ssh_key';
  ftpsTlsMode?: 'explicit' | 'implicit';
  apiVendor?: 'Synology DSM' | 'QNAP QTS' | 'Western Digital' | 'TrueNAS Scale' | 'Unraid' | 'OpenMediaVault';
  useTls?: boolean;
  backendPath?: string;
  backendProvisioned?: boolean;
  storageBridgeMode?: boolean;
  hasFritzSecret?: boolean;
  fritzSidVerifiedAt?: string | null;
  updatedAt: string | null;
}

export interface ProfileFolderInfo {
  username: string;
  nasMountPath: string;
  diskPath: string;
  subfolders: string[];
  exists: boolean;
  writable: boolean;
  createdNow: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NasRegistrationConnectionPayload {
  protocol: NasProtocolId;
  host: string;
  port: string;
  shareOrPath: string;
  username: string;
  secret?: string;
  accessMode?: 'read_write' | 'read_only';
  writePermissions?: boolean;
  domainOrWorkgroup?: string;
  nfsVersion?: 'NFSv4.1' | 'NFSv4' | 'NFSv3';
  nfsAuthMode?: 'AUTH_SYS' | 'Kerberos (krb5p)';
  sftpAuthMode?: 'password' | 'ssh_key';
  ftpsTlsMode?: 'explicit' | 'implicit';
  apiVendor?: 'Synology DSM' | 'QNAP QTS' | 'Western Digital' | 'TrueNAS Scale' | 'Unraid' | 'OpenMediaVault';
  useTls?: boolean;
  backendPath?: string;
  backendProvisioned?: boolean;
  storageBridgeMode?: boolean;
  fritzUsername?: string;
  fritzPassword?: string;
  fritzSidVerifiedAt?: string | null;
}

export interface FritzUpnpDiscoveredDevice {
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

export interface FritzUpnpDiscoveryConfig {
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

export interface FritzUpnpProbeResult {
  enabled: boolean;
  autoTokenlessLogin: boolean;
  subnetMatchRequired: boolean;
  configuredSubnetCidr: string;
  localSubnets: string[];
  nasIps: string[];
  clientIp: string;
  clientInSameSubnet: boolean;
  discoveredDevices: FritzUpnpDiscoveredDevice[];
  sameSubnetDeviceFound: boolean;
  tokenlessEligible: boolean;
  checkedAt: string;
  reason: string;
}

export type NetworkProfileMode = 'lan' | 'remote';

export type RemoteNasTransportType = 'wan_dyndns' | 'vpn' | 'reverse_proxy';

export interface NasSecurityCertificateInfo {
  id: string;
  label: string;
  fileName: string;
  subject: string;
  issuer: string;
  subjectAltName: string | null;
  fingerprint256: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  isExpired: boolean;
  isCa: boolean;
  pem: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface AdminNetworkConfig {
  activeMode: NetworkProfileMode;
  lanAddress: string;
  remoteAddress: string;
  remoteTransport: RemoteNasTransportType;
  autoFallbackToRemote: boolean;
  allowLocalSelfSignedTls?: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FritzSidSessionStatus {
  connected: boolean;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  hasSecret: boolean;
  sidPreview: string | null;
  challengeVersion: 'md5_v1' | 'pbkdf2_v2' | null;
  rights: string[];
  obtainedAt: string | null;
  lastVerifiedAt: string | null;
  blockTimeSec: number;
  tr064Available: boolean;
  friendlyName?: string | null;
  modelName?: string | null;
  allowLocalSelfSignedTls: boolean;
  tlsBypassedForLocalSelfSigned?: boolean;
  message: string;
  error?: string | null;
}

export interface FritzNasBrowseItem {
  name: string;
  path: string;
  type: 'directory' | 'file';
  sizeBytes?: number;
  mimeType?: string;
  url?: string;
  modifiedAt?: string;
}

export type NasProfileScope =
  | 'lan'
  | 'wan_dyndns'
  | 'domain_https'
  | 'vpn'
  | 'reverse_proxy';

export interface NasConnectionProfile {
  id: string;
  name: string;
  scope: NasProfileScope;
  protocol: NasProtocolId;
  host: string;
  port: string;
  shareOrPath: string;
  username: string;
  hasSecret: boolean;
  useTls: boolean;
  allowSelfSignedLocalTls: boolean;
  ddnsOrVpnHint?: string;
  domainOrWorkgroup?: string;
  nfsVersion?: 'NFSv4.1' | 'NFSv4' | 'NFSv3';
  nfsAuthMode?: 'AUTH_SYS' | 'Kerberos (krb5p)';
  sftpAuthMode?: 'password' | 'ssh_key';
  ftpsTlsMode?: 'explicit' | 'implicit';
  apiVendor?: 'Synology DSM' | 'QNAP QTS' | 'Western Digital' | 'TrueNAS Scale' | 'Unraid' | 'OpenMediaVault';
  priority: number;
  isActive: boolean;
  lastTestedAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string | null;
  lastLatencyMs?: number | null;
  updatedAt: string;
}

export interface AdminNetworkConfigResponse {
  config: AdminNetworkConfig;
  securityCertificate: NasSecurityCertificateInfo | null;
  detectedLanUrls: string[];
  localSubnets: string[];
  clientIp: string;
}

export interface AdminNetworkConfigTestResult {
  ok: boolean;
  mode: NetworkProfileMode;
  targetUrl: string;
  resolvedIp?: string;
  scope?: 'lan' | 'remote';
  latencyMs?: number;
  httpStatus?: number;
  bootstrapOk?: boolean;
  trustedByNasCertificate?: boolean;
  message?: string;
  error?: string;
}

export interface AdminNasPathSettings {
  vaultBasePath: string;
  vaultFileName: string;
  uploadsSubdir: string;
  hostStorageOverrideDir: string;
  mediaFolders: Record<MediaKind, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AdminNasPathSettingsResponse {
  settings: AdminNasPathSettings;
  effectiveServerDataDir: string;
  effectiveUploadsDir: string;
  resolvedVaultFilePath: string;
  writable: boolean;
}

export interface LocalOnboardingBuffer {
  version: 1;
  mode: 'local_fallback' | 'pending_nas_sync' | 'storage_bridge_active';
  localToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    password: string;
    role: 'admin';
    fskLimit: FskLevel;
    avatarColor: string;
    createdAt: string;
  };
  serverUrl: string;
  connectionScope: 'lan' | 'internet';
  nasConnection: NasRegistrationConnectionPayload | null;
  autoBackgroundCheck: boolean;
  lastTestError?: string | null;
  lastTestedAt?: string | null;
  nasSyncedAt?: string | null;
  syncedBackendPath?: string | null;
  setupCompleted?: boolean;
  setupCompletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthBootstrapResponse {
  hasUsers: boolean;
  hasAdmin: boolean;
  isFirstUserRegistration: boolean;
  allowedNasProtocols: NasProtocolId[];
  fritzUpnpEnabled?: boolean;
  securityCertificate?: NasSecurityCertificateInfo | null;
  networkConfig?: {
    activeMode: NetworkProfileMode;
    activeAddress: string;
    lanAddress: string;
    remoteAddress: string;
    remoteTransport: RemoteNasTransportType;
    autoFallbackToRemote: boolean;
    allowLocalSelfSignedTls?: boolean;
  };
  fritzDiscovery?: {
    enabled: boolean;
    autoTokenlessLogin: boolean;
    subnetMatchRequired: boolean;
    probeHosts: string[];
    probePort: string;
    localSubnets: string[];
    clientInSameSubnet: boolean;
    discoveredDevices: FritzUpnpDiscoveredDevice[];
    tokenlessEligible: boolean;
  };
}

export type NetworkDiscoveryMethod = 'mdns' | 'ssdp' | 'port_probe' | 'android_nsd';

export interface DiscoveredNasService {
  protocol: NasProtocolId | 'entencenter';
  serviceType: string;
  port: string;
  label: string;
  scheme?: 'http' | 'https';
  path?: string;
}

export interface DiscoveredNasDevice {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: string;
  baseUrl?: string;
  isEntenCenterServer: boolean;
  vendor:
    | 'EntenCenter'
    | 'Synology'
    | 'QNAP'
    | 'Western Digital'
    | 'TrueNAS'
    | 'Unraid'
    | 'OpenMediaVault'
    | 'FRITZ!Box'
    | 'Standard NAS';
  suggestedProtocol: NasProtocolId;
  suggestedShareOrPath: string;
  services: DiscoveredNasService[];
  discoveryMethods: NetworkDiscoveryMethod[];
  sameSubnet: boolean;
  txtRecords?: Record<string, string>;
  discoveredAt: string;
}

export interface NetworkNasDiscoveryResponse {
  devices: DiscoveredNasDevice[];
  localSubnets: string[];
  methodsUsed: NetworkDiscoveryMethod[];
  durationMs: number;
  scannedAt: string;
  summary: string;
}

export type SmartHomeSource = 'google_home' | 'alexa' | 'home_assistant' | 'app';

export type SmartHomePlaybackStatus = 'PLAYING' | 'PAUSED' | 'IDLE';

export interface SmartHomeRemoteState {
  powerOn: boolean;
  playbackState: SmartHomePlaybackStatus;
  volume: number;
  muted: boolean;
  playbackRate: number;
  activeMediaId: string | null;
  activeTitle: string | null;
  activeInput: string;
  lastCommand: string | null;
  lastCommandSource: SmartHomeSource | null;
  lastCommandAt: string | null;
  commandSeq: number;
}

export interface SmartHomeCommandLogEntry {
  id: string;
  source: SmartHomeSource;
  intent: string;
  command: string;
  detail: string;
  timestamp: string;
}

export interface SmartHomeConfig {
  googleHomeEnabled: boolean;
  alexaEnabled: boolean;
  deviceName: string;
  roomName: string;
  alexaInvocationName: string;
  googleAgentUserId: string;
  webhookTokenPreview: string;
  hasWebhookToken: boolean;
  updatedAt: string | null;
}

export interface SmartHomeSnapshot {
  config: SmartHomeConfig;
  remoteState: SmartHomeRemoteState;
  recentLogs: SmartHomeCommandLogEntry[];
}

export type UserDataStorageMode = 'nas' | 'cloud';

export type CloudStorageProvider = 'google_drive' | 'webdav';

export interface EncryptedCloudVaultSummary {
  usersCount: number;
  preferencesCount: number;
  watchlistUsersCount: number;
  favoritesUsersCount: number;
  historyEntriesCount: number;
  collectionsUsersCount: number;
  notificationsCount: number;
  nasConnectionsCount: number;
}

export interface EncryptedCloudVaultEnvelope {
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

export interface UserDataStorageConfig {
  mode: UserDataStorageMode;
  cloudProvider: CloudStorageProvider;
  autoEncrypt: boolean;
  encryptionAlgorithm: string;
  keyFingerprint: string;
  cloudAccountEmail: string | null;
  cloudAccountName: string | null;
  cloudAccountPhotoUrl: string | null;
  cloudRemoteFileId: string | null;
  cloudRemoteFileName: string;
  webdavUrl: string;
  webdavUsername: string;
  hasWebdavSecret: boolean;
  webdavRemotePath: string;
  lastEncryptedSyncAt: string | null;
  lastSyncStatus: 'idle' | 'synced' | 'pending_auth' | 'error';
  lastSyncError: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UserDataVaultPreview {
  encryptedAt: string;
  algorithm: 'AES-256-GCM';
  keyFingerprint: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  payloadSha256: string;
  sampleCiphertextPrefix: string;
  summary: EncryptedCloudVaultSummary;
}

export interface AppUpdateConfig {
  repository: string;
  branch: string;
  hasGithubToken: boolean;
  installedVersion: string;
  installedCommitSha: string | null;
  installedAt: string | null;
  lastCheckedAt: string | null;
  skippedVersionOrSha: string | null;
}

export interface GithubUpdateCandidate {
  updateAvailable: boolean;
  sourceType: 'release' | 'commit';
  repository: string;
  branch: string;
  currentVersion: string;
  currentCommitSha: string | null;
  latestVersion: string;
  latestTag: string | null;
  latestCommitSha: string | null;
  releaseName: string;
  changelog: string;
  publishedAt: string | null;
  htmlUrl: string;
  downloadUrl: string | null;
  checkedAt: string;
  skipped: boolean;
}

export interface AppUpdateInstallResult {
  ok: boolean;
  installedVersion: string;
  installedCommitSha: string | null;
  installedAt: string;
  updatedFilesCount: number;
  dependenciesUpdated: boolean;
  message: string;
}

export interface AndroidApkArtifactCandidate {
  artifactId: number;
  artifactName: string;
  suggestedFilename: string;
  sizeInBytes: number;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  isSignedRelease: boolean;
  archiveDownloadUrl: string;
  workflowRunId: number;
  workflowRunNumber: number;
  workflowName: string;
  workflowEvent: string;
  headBranch: string;
  headSha: string;
  commitMessage: string;
  actorLogin: string | null;
  runHtmlUrl: string;
  proxyDownloadPath: string;
}

export interface AndroidApkArtifactsResponse {
  repository: string;
  checkedAt: string;
  hasGithubToken: boolean;
  actionsHtmlUrl: string;
  latest: AndroidApkArtifactCandidate | null;
  recentArtifacts: AndroidApkArtifactCandidate[];
}

export interface NetworkHopEntry {
  hop: number;
  host: string;
  ip: string | null;
  rttMs: number | null;
  status: 'reached' | 'timeout' | 'gateway' | 'local';
  note?: string;
}

export interface NetworkPortProbeEntry {
  port: number;
  label: string;
  protocolHint: string;
  tcpOpen: boolean;
  latencyMs: number | null;
  httpStatus?: number | null;
  serverHeader?: string | null;
  isEntenCenter?: boolean;
  errorCode?: string | null;
}

export interface NetworkDiagnosticFinding {
  severity: 'ok' | 'info' | 'warn' | 'error';
  code: string;
  title: string;
  detail: string;
  recommendation: string;
}

export interface Http400DiagnosticDetail {
  detected: boolean;
  port: number;
  statusCode: number;
  serverHeader?: string | null;
  probableCauses: Array<
    'port_conflict' | 'tls_on_http_port' | 'proxy_header_filter' | 'firewall_or_wrong_service'
  >;
  summary: string;
  hints: string[];
}

export interface DeepNetworkDiagnosticsResult {
  targetInput: string;
  hostname: string;
  resolvedIp: string | null;
  targetPort: number;
  scheme: 'http' | 'https';
  scope: 'lan' | 'remote';
  dns: {
    ok: boolean;
    latencyMs: number | null;
    resolvedIp: string | null;
    error?: string;
  };
  ping: {
    method: 'icmp' | 'tcp_syn_fallback';
    reachable: boolean;
    sent: number;
    received: number;
    packetLossPercent: number;
    minMs: number | null;
    avgMs: number | null;
    maxMs: number | null;
    error?: string;
  };
  traceroute: {
    method: 'traceroute' | 'tracepath' | 'ttl_ping_probe' | 'route_equivalent';
    gatewayIp: string | null;
    hops: NetworkHopEntry[];
    summary: string;
  };
  portMatrix: NetworkPortProbeEntry[];
  http400Analysis: Http400DiagnosticDetail | null;
  fritzBoxInfo?: {
    detected: boolean;
    friendlyName: string;
    tr064Available: boolean;
    loginSidAvailable: boolean;
    requiresAuth: boolean;
    httpAvailable: boolean;
    httpsAvailable: boolean;
    httpsError: string | null;
    loginSidUrl: string | null;
  } | null;
  findings: NetworkDiagnosticFinding[];
  executedOn: 'server' | 'android_native' | 'browser_fallback';
  measuredAt: string;
  durationMs: number;
}

export interface NasDirectoryTreeEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  sizeBytes?: number;
  modifiedAt?: string;
  writable?: boolean;
  recommended?: boolean;
}

export interface NasBrowseTreeResult {
  ok: boolean;
  host: string;
  protocol: NasProtocolId;
  currentPath: string;
  parentPath: string | null;
  entries: NasDirectoryTreeEntry[];
  recommendedBackendPath: string;
  source: 'fritz_nas_api' | 'smb_live' | 'webdav' | 'local_fs' | 'nas_template';
  liveFilesystem?: boolean;
  smbShare?: string | null;
  effectiveUser?: string | null;
  requiresAuth?: boolean;
  httpsFallbackToHttp?: boolean;
  writable?: boolean;
  warning?: string | null;
  error?: string | null;
}

export interface NasProvisionBackendResult {
  ok: boolean;
  mode: 'auto' | 'manual';
  host: string;
  protocol: NasProtocolId;
  backendPath: string;
  createdDirectories: string[];
  createdFiles: string[];
  remoteWriteOk: boolean;
  localBridgeReady: boolean;
  connectionKeptAlive: true;
  message: string;
  instructions?: string[];
  warning?: string | null;
}

export interface AlternativePortScanEntry {
  port: number;
  scheme: 'http' | 'https' | 'tcp';
  label: string;
  category: 'entencenter' | 'alternative' | 'proxy' | 'storage' | 'router';
  tcpOpen: boolean;
  latencyMs: number | null;
  httpStatus?: number | null;
  serverHeader?: string | null;
  isEntenCenter: boolean;
  usableAsAlternative: boolean;
  recommended: boolean;
  errorCode?: string | null;
}

export interface AlternativePortScanResult {
  targetInput: string;
  hostname: string;
  resolvedIp: string | null;
  primaryPort: number;
  preferredAlternativePort: number;
  recommendedPort: number | null;
  recommendedBaseUrl: string | null;
  openEntenCenterPorts: number[];
  openAlternativePorts: number[];
  openStoragePorts: number[];
  ports: AlternativePortScanEntry[];
  summary: string;
  executedOn: 'android_native' | 'server' | 'browser_fallback';
  measuredAt: string;
  durationMs: number;
}

export type NasVendorId =
  | 'avm_fritzbox'
  | 'synology'
  | 'qnap'
  | 'western_digital'
  | 'truenas'
  | 'unraid'
  | 'openmediavault'
  | 'standard_nas'
  | 'entencenter';

export type NasTransportRole =
  | 'file_access'
  | 'vendor_api'
  | 'media_only'
  | 'router_control';

export type NasConnectionScope = 'lan' | 'vpn' | 'internet';

export interface NasProtocolVerificationResult {
  protocol: NasProtocolId;
  port: number;
  priority: number;
  label: string;
  role: NasTransportRole;
  useTls: boolean;
  tcpOpen: boolean;
  protocolVerified: boolean;
  authVerified: boolean;
  authAttempted: boolean;
  shareVerified?: boolean;
  smbDialect?: string | null;
  smb1Rejected?: boolean;
  blockedByVpnPolicy?: boolean;
  endpointMismatch?: boolean;
  httpStatus?: number | null;
  serverBanner?: string | null;
  latencyMs: number | null;
  errorCode?: string | null;
  message: string;
  warning?: string | null;
}

export interface FritzTrackStatus {
  detected: boolean;
  friendlyName?: string | null;
  modelName?: string | null;
  webuiSid: {
    reachable: boolean;
    authenticated: boolean;
    scheme: 'http' | 'https';
    port: number;
    challengeVersion?: 'md5_v1' | 'pbkdf2_v2' | null;
    rights?: string[];
    httpsError?: string | null;
    error?: string | null;
  };
  smbAccess: {
    reachable: boolean;
    protocolVerified: boolean;
    authVerified: boolean;
    shareVerified: boolean;
    dialect?: string | null;
    smb1Rejected?: boolean;
    shareName?: string | null;
    error?: string | null;
    permissionHint?: string | null;
  };
  tr064: {
    reachable: boolean;
    port: number;
    useTls: boolean;
    friendlyName?: string | null;
    error?: string | null;
  };
  upnpMediaOnly: {
    reachable: boolean;
    port: number;
    mediaOnlyNote: string;
  };
  mismatchWarning?: string | null;
}

export interface UniversalNasProbeResponse {
  ok: boolean;
  host: string;
  resolvedIp: string | null;
  isLan: boolean;
  scope: NasConnectionScope;
  vpnRequiredForSmb: boolean;
  detectedVendor: NasVendorId;
  vendorLabel: string;
  entenCenterDetected: boolean;
  recommendedProtocol: NasProtocolId | null;
  recommendedPort: number | null;
  resultsByPriority: NasProtocolVerificationResult[];
  fritzTracks?: FritzTrackStatus | null;
  availableShares?: string[];
  userFriendlySummary: string;
  errors: string[];
  measuredAt: string;
  durationMs: number;
  executedOn: 'server' | 'android_native' | 'browser_fallback';
}

export interface UniversalNasCredentialEntry {
  id: string;
  name: string;
  vendor: NasVendorId;
  scope: NasConnectionScope;
  protocol: NasProtocolId;
  host: string;
  port: string;
  shareOrPath: string;
  username: string;
  useTls: boolean;
  hasSecret: boolean;
  isActive: boolean;
  autoReconnect: boolean;
  capabilityTags: NasTransportRole[];
  lastVerifiedAt: string | null;
  lastStatus: 'online' | 'auth_failed' | 'smb_blocked' | 'vpn_required' | 'offline' | 'unknown';
  lastLatencyMs: number | null;
  lastMessage?: string | null;
  fritzTracks?: FritzTrackStatus | null;
  updatedAt: string;
}

export type NasScanFolderMode = 'all' | 'selected';

export interface NasScanFolderSettings {
  scanMode: NasScanFolderMode;
  selectedFolders: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface NasStorageWriteFileResult {
  ok: boolean;
  transport?: string;
  shareName?: string;
  filePath?: string;
  bytesWritten?: number;
  verified?: boolean;
  requiresAuth?: boolean;
  message?: string;
  error?: string;
}

export interface NasStorageReadFileResult {
  ok: boolean;
  shareName?: string;
  filePath?: string;
  bytesRead?: number;
  content?: string;
  error?: string;
}

export interface NasScannedMediaFile {
  name: string;
  path: string;
  dirPath: string;
  sizeBytes: number;
  inferredKind: MediaKind;
}

export interface NasMediaFolderScanBreakdown {
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
}

export interface NasMediaFolderScanResult {
  ok: boolean;
  host?: string;
  shareName?: string;
  scanMode?: NasScanFolderMode;
  scannedFolders: string[];
  files: NasScannedMediaFile[];
  volumeTotalBytes?: number;
  volumeFreeBytes?: number;
  volumeUsedBytes?: number;
  volumeSource?: string;
  scannedTotalBytes?: number;
  scannedFilesCount?: number;
  truncated?: boolean;
  mediaBreakdown?: NasMediaFolderScanBreakdown;
  error?: string;
}
