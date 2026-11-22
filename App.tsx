/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Film,
  CalendarDays,
  BarChart3,
  Code2,
  MessageSquare,
  ScanSearch,
  Bell,
  LogOut,
  RefreshCw,
  Menu,
  X,
  CheckCheck,
  UserCog,
  ListVideo,
  Wifi,
  WifiOff,
  Activity,
  Headphones,
  ExternalLink,
  Copy,
  Download,
  CheckCircle2,
  ShieldCheck,
  Trash2,
  Clapperboard,
  ChevronDown,
  ChevronRight,
  Info,
  Tv,
  Layers,
  Sparkles,
  HardDrive,
  Users,
  Network,
  FolderOpen,
  KeyRound,
  Database,
  Radar,
  AlertTriangle,
  ShieldAlert,
  Terminal,
  FolderTree,
  Eye,
  EyeOff,
  Power,
} from 'lucide-react';
import {
  DEFAULT_ASSISTANT_AVATAR_URL,
  MARCENTE_ASSETS,
  resolveAssistantAvatarSrc,
} from './data/coverAssets';
import {
  AlternativePortScanResult,
  AskDuckCollectionType,
  AskDuckMode,
  AskDuckResponse,
  CalendarNotificationMode,
  CalendarRelease,
  DeepNetworkDiagnosticsResult,
  DEFAULT_AUTO_THEME_CONFIG,
  DEFAULT_CUSTOM_THEME_SETTINGS,
  DEFAULT_USER_PREFERENCES,
  DuckRecommendationData,
  FilmGroundSource,
  FilmNotificationMode,
  FilmStartRelease,
  FilmStartsResponse,
  MarkWatchedDateOptions,
  NasMediaItem,
  NasNotification,
  NasSavedCollection,
  NasSecurityCertificateInfo,
  NasSeriesEpisode,
  NasStorageStats,
  NasUser,
  PlaybackQueueItem,
  SeriesCalendarResponse,
  SeriesLookupCandidate,
  SmartHomeRemoteState,
  SyncMode,
  UserPreferences,
  WatchStatistics,
} from './types/marcente';
import { LoginScreen } from './components/LoginScreen';
import { MediaLibraryView } from './components/MediaLibraryView';
import type { ManualSeriesInput } from './components/SeriesCalendarView';
import type { AdminSectionTab } from './components/AdminView';
import { LiveClockBadge } from './components/LiveClockBadge';
import { NetworkPortComparisonTable } from './components/NetworkPortComparisonTable';
import {
  DEFAULT_ALTERNATIVE_PORTS,
  LOCAL_BUFFER_UPDATED_EVENT,
  cleanHostOnly,
  discoverAndHydrateBackendFromNasBridge,
  fetchNasStorageStatsBridge,
  fritzBoxChallengeLoginNative,
  fritzBoxDirectLoginWithSession,
  getAutoPortFallbackEnabled,
  getEffectiveNasOrigin,
  getPreferredAlternativePort,
  getStoredSharedNasCertificate,
  hydrateLocalBridgeCatalogFromIndexedDb,
  inferMimeTypeFromPath,
  isLocalOrLanHost,
  isNativeAndroidShell,
  type NativeServerDiagnosis,
  normalizeNasBaseUrl,
  openNativeExternalPlayer,
  probeBridgeNasHealth,
  readAllLocalProvisionedBackends,
  readLocalBridgeCatalog,
  readLocalBridgeScanSettings,
  readLocalBridgeVolumeStats,
  readLocalProvisionedBackendForHost,
  readSavedNasMacAddress,
  refreshSharedNasCertificateFromNas,
  resolveNasUrl,
  resolveNasWsUrl,
  resolvePlayableNasMediaUrl,
  runDeepNetworkDiagnostics,
  saveLocalBridgeCatalog,
  saveLocalBridgePathSettings,
  saveLocalBridgeScanSettings,
  saveLocalBridgeVolumeStats,
  saveLocalProvisionedBackendFolder,
  saveNasMacAddress,
  sanitizeNasPortForProtocol,
  scanAlternativeNasPorts,
  scanNasMediaFoldersBridge,
  setAutoPortFallbackEnabled,
  setNasBaseUrl,
  setPreferredAlternativePort,
  stripEphemeralMediaUrlForCatalog,
  upsertLocalBridgeCatalogItems,
  wakeNasFromSleep,
  writeFileToNasBridge,
} from './lib/nasClient';
import {
  classifyMediaKind,
  groupAndNormalizeNasCatalog,
} from './lib/mediaGrouping';
import {
  addManualSeriesBridge,
  deleteAllBridgeNotifications,
  deleteBridgeNotification,
  deleteBridgeNotificationsBatch,
  deleteManualSeriesBridge,
  enrichNasCatalogFromInternet,
  fetchLiveFilmstartsBridge,
  fetchLiveSeriesCalendarBridge,
  isPlaceholderCoverUrl,
  markBridgeNotificationsRead,
  readBridgeNotifications,
  readCachedFilmstartsBridge,
  readCachedSeriesCalendarBridge,
  searchSeriesOnlineBridge,
  simulateFilmReleaseBridge,
  simulateSeriesReleaseBridge,
  toggleFilmFavoriteBridge,
  toggleSeriesFavoriteBridge,
} from './lib/internetMediaService';
import { initDeviceDisplayListener } from './lib/deviceDisplay';
import { evaluateAutoTheme, normalizeAutoThemeConfig } from './lib/autoTheme';
import {
  clearLocalOnboardingBuffer,
  evaluateNasSetupCompleteness,
  hydrateLocalOnboardingBufferFromIndexedDb,
  isConfirmedStorageBridge,
  isLocalFallbackToken,
  markNasSetupCompleted,
  type NasSetupMissingItem,
  readLocalOnboardingBuffer,
  testAndTransferLocalBufferToNas,
  toNasUserFromBuffer,
  writeLocalOnboardingBuffer,
} from './lib/localBufferStore';
import type {
  EncryptedCloudVaultEnvelope,
  LocalOnboardingBuffer,
  NasProvisionBackendResult,
  NasRegistrationConnectionPayload,
  UserDataStorageConfig,
} from './types/marcente';
import {
  NasBackendProvisionDialog,
  type NasBackendProvisionTarget,
} from './components/NasBackendProvisionDialog';

const SeriesCalendarView = lazy(() =>
  import('./components/SeriesCalendarView').then((m) => ({ default: m.SeriesCalendarView }))
);
const FilmStartsView = lazy(() =>
  import('./components/FilmStartsView').then((m) => ({ default: m.FilmStartsView }))
);
const StatisticsView = lazy(() =>
  import('./components/StatisticsView').then((m) => ({ default: m.StatisticsView }))
);
const CodeStudioView = lazy(() =>
  import('./components/CodeStudioView').then((m) => ({ default: m.CodeStudioView }))
);
const GeminiAssistantView = lazy(() =>
  import('./components/GeminiAssistantView').then((m) => ({ default: m.GeminiAssistantView }))
);
const MediaPlayerModal = lazy(() =>
  import('./components/MediaPlayerModal').then((m) => ({ default: m.MediaPlayerModal }))
);
const ProfileView = lazy(() =>
  import('./components/ProfileView').then((m) => ({ default: m.ProfileView }))
);
const AdminView = lazy(() =>
  import('./components/AdminView').then((m) => ({ default: m.AdminView }))
);
const NotificationsView = lazy(() =>
  import('./components/NotificationsView').then((m) => ({ default: m.NotificationsView }))
);
const SystemUpdateView = lazy(() =>
  import('./components/SystemUpdateView').then((m) => ({ default: m.SystemUpdateView }))
);

const ViewLoadingFallback: React.FC = () => (
  <div className="flex items-center justify-center py-20 text-xs text-slate-400">
    <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#121722] border border-slate-800">
      <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
      <span>Ansicht wird geladen…</span>
    </div>
  </div>
);

type SectionId =
  | 'library'
  | 'calendar'
  | 'filmstarts'
  | 'statistics'
  | 'notifications'
  | 'code'
  | 'chat'
  | 'vision'
  | 'profile'
  | 'admin'
  | 'about-update';

interface ServerLibraryItem extends Omit<NasMediaItem, 'coverUrl'> {
  coverKey: keyof typeof MARCENTE_ASSETS;
}

const SECTION_META: Record<SectionId, { title: string; subtitle: string }> = {
  library: {
    title: 'EntenTheke',
    subtitle: 'Filme, Serien und zuletzt gesehene Inhalte direkt vom zentralen Vault',
  },
  calendar: {
    title: 'Serienkalender (DE-Raum)',
    subtitle: 'Neustarts inkl. Streaming-Anbieter, automatischer NAS-Abgleich & Favoriten',
  },
  filmstarts: {
    title: 'Filmstarts DE',
    subtitle:
      'Aktuelle Kinostarts & Streaming-Filme in Deutschland & Österreich aus dem Internet inkl. NAS-Abgleich',
  },
  statistics: {
    title: 'Statistiken & Verlauf',
    subtitle: 'Woche, Monat, Jahr, Genre-Auswertung und löschresistentes NAS-Protokoll',
  },
  notifications: {
    title: 'Benachrichtigungen',
    subtitle: 'Benachrichtigungen verwalten, einzeln oder mehrfach markieren und löschen',
  },
  code: {
    title: 'Kotlin & Python Code-Studio',
    subtitle: 'Produktionsreife Module für Android TV, Smartphone/Tablet & FastAPI NAS-Backend',
  },
  chat: {
    title: 'Enten Assistent',
    subtitle: 'Multi-Turn Gemini-Chat mit wählbaren Modellen für Architektur & Serienfragen',
  },
  vision: {
    title: 'Cover & Bild-Scanner',
    subtitle: 'Foto- & Poster-Analyse mit gemini-4-argon für deine NAS-Bibliothek',
  },
  profile: {
    title: 'Profil & Zugangsdaten',
    subtitle: 'Benutzername, Anzeigename und Passwort zentral auf dem NAS verwalten',
  },
  admin: {
    title: 'Admin-Bereich',
    subtitle:
      'Profile, FSK, NAS-Inhalte & Datei-Upload, Anmeldewege & Cloud-Tresor zentral verwalten',
  },
  'about-update': {
    title: 'Über das EntenCenter · Update',
    subtitle: 'Versionsstand, GitHub-Update-Suche sowie Download & Installation',
  },
};

const SESSION_STORAGE_KEY = 'entencenter_auth_session';
const LEGACY_SESSION_STORAGE_KEY = 'marcente_auth_session';
const PREFS_STORAGE_KEY = 'entencenter_user_preferences';
const LEGACY_PREFS_STORAGE_KEY = 'marcente_user_preferences';

function readStoredPreferences(): UserPreferences {
  try {
    const raw =
      window.localStorage.getItem(PREFS_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_USER_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      theme: parsed.theme ?? DEFAULT_USER_PREFERENCES.theme,
      customTheme: parsed.customTheme
        ? {
            activeFor:
              parsed.customTheme.activeFor === 'design1' ||
              parsed.customTheme.activeFor === 'design2'
                ? parsed.customTheme.activeFor
                : 'none',
            design1: {
              ...DEFAULT_CUSTOM_THEME_SETTINGS.design1,
              ...(parsed.customTheme.design1 ?? {}),
            },
            design2: {
              ...DEFAULT_CUSTOM_THEME_SETTINGS.design2,
              ...(parsed.customTheme.design2 ?? {}),
            },
          }
        : DEFAULT_CUSTOM_THEME_SETTINGS,
      autoTheme: normalizeAutoThemeConfig(
        parsed.autoTheme ?? DEFAULT_AUTO_THEME_CONFIG,
        parsed.theme ?? DEFAULT_USER_PREFERENCES.theme
      ),
      homeSectionOrder:
        Array.isArray(parsed.homeSectionOrder) && parsed.homeSectionOrder.length > 0
          ? parsed.homeSectionOrder
          : DEFAULT_USER_PREFERENCES.homeSectionOrder,
      hiddenHomeSections: Array.isArray(parsed.hiddenHomeSections)
        ? parsed.hiddenHomeSections
        : DEFAULT_USER_PREFERENCES.hiddenHomeSections,
      showHomeCategoryTabs: parsed.showHomeCategoryTabs === true,
      showHomeFilterSearch: parsed.showHomeFilterSearch === true,
      audioPlayerMode:
        parsed.audioPlayerMode === 'external' ? 'external' : DEFAULT_USER_PREFERENCES.audioPlayerMode,
      duckAssistantEnabled: parsed.duckAssistantEnabled !== false,
      playerControlsTimeoutSec:
        typeof parsed.playerControlsTimeoutSec === 'number' && parsed.playerControlsTimeoutSec >= 0
          ? parsed.playerControlsTimeoutSec
          : DEFAULT_USER_PREFERENCES.playerControlsTimeoutSec,
      playerSeekBackwardSec:
        typeof parsed.playerSeekBackwardSec === 'number' && parsed.playerSeekBackwardSec >= 5
          ? parsed.playerSeekBackwardSec
          : DEFAULT_USER_PREFERENCES.playerSeekBackwardSec,
      playerSeekForwardSec:
        typeof parsed.playerSeekForwardSec === 'number' && parsed.playerSeekForwardSec >= 5
          ? parsed.playerSeekForwardSec
          : DEFAULT_USER_PREFERENCES.playerSeekForwardSec,
      calendarNotificationMode:
        parsed.calendarNotificationMode ?? DEFAULT_USER_PREFERENCES.calendarNotificationMode,
      filmNotificationMode:
        parsed.filmNotificationMode ?? DEFAULT_USER_PREFERENCES.filmNotificationMode,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

function persistStoredPreferences(prefs: UserPreferences): void {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    window.localStorage.removeItem(LEGACY_PREFS_STORAGE_KEY);
  } catch {
    // Speicherfehler ignorieren
  }
}

const BRIDGE_SYNC_MODE_KEY = 'entencenter_bridge_sync_mode';

function readStoredBridgeSyncMode(): SyncMode {
  try {
    const val = window.localStorage.getItem(BRIDGE_SYNC_MODE_KEY);
    if (val === 'every_start' || val === 'daily_first' || val === 'manual') {
      return val;
    }
  } catch {
    // ignore
  }
  return 'manual';
}

function buildBridgeStorageStats(items: NasMediaItem[], mountPath: string): NasStorageStats {
  const cachedVol = readLocalBridgeVolumeStats();
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

  for (const item of items) {
    const itemBytes = Math.max(0, item.uploadedByteSize ?? 0);
    if (item.kind === 'series') {
      seriesCount += 1;
      episodesCount += item.episodes?.length ?? Math.max(1, item.totalEpisodes ?? 1);
      seriesBytes += itemBytes;
    } else if (item.kind === 'movie') {
      moviesCount += 1;
      moviesBytes += itemBytes;
    } else if (item.kind === 'video') {
      videosCount += 1;
      videosBytes += itemBytes;
    } else if (item.kind === 'music') {
      musicCount += 1;
      musicBytes += itemBytes;
    } else if (item.kind === 'image') {
      imagesCount += 1;
      imagesBytes += itemBytes;
    } else {
      otherFilesCount += 1;
      otherFilesBytes += itemBytes;
    }
  }

  const bd = cachedVol?.mediaBreakdown;
  if (bd) {
    moviesCount = Math.max(moviesCount, bd.moviesCount);
    moviesBytes = Math.max(moviesBytes, bd.moviesBytes);
    seriesCount = Math.max(seriesCount, bd.seriesCount);
    seriesBytes = Math.max(seriesBytes, bd.seriesBytes);
    musicCount = Math.max(musicCount, bd.musicCount);
    musicBytes = Math.max(musicBytes, bd.musicBytes);
    videosCount = Math.max(videosCount, bd.videosCount);
    videosBytes = Math.max(videosBytes, bd.videosBytes);
    imagesCount = Math.max(imagesCount, bd.imagesCount);
    imagesBytes = Math.max(imagesBytes, bd.imagesBytes);
    otherFilesCount = Math.max(otherFilesCount, bd.otherCount);
    otherFilesBytes = Math.max(otherFilesBytes, bd.otherBytes);
  }

  const vaultBytes = 64 * 1024;
  const summedCatalogBytes =
    moviesBytes + seriesBytes + musicBytes + videosBytes + imagesBytes + otherFilesBytes + vaultBytes;
  const scannedTotalBytes = Math.max(cachedVol?.scannedTotalBytes ?? 0, summedCatalogBytes);
  const scannedFilesCount = Math.max(cachedVol?.scannedFilesCount ?? 0, items.length);

  const hasPhysicalVol = Boolean(cachedVol && cachedVol.volumeTotalBytes > 0);
  const totalBytes = hasPhysicalVol ? cachedVol!.volumeTotalBytes : 0;
  const freeBytes = hasPhysicalVol
    ? Math.min(totalBytes, Math.max(0, cachedVol!.volumeFreeBytes))
    : 0;
  const usedBytes = hasPhysicalVol
    ? cachedVol!.volumeUsedBytes > 0
      ? cachedVol!.volumeUsedBytes
      : Math.max(0, totalBytes - freeBytes)
    : scannedTotalBytes;

  const usedPercent =
    totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : 0;
  const freePercent =
    totalBytes > 0 ? Math.max(0, Math.round((freeBytes / totalBytes) * 1000) / 10) : 0;

  return {
    mountPath: mountPath || '/EntenCenter-Backend',
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent,
    freePercent,
    moviesCount: moviesCount + videosCount,
    moviesBytes: moviesBytes + videosBytes,
    seriesCount,
    episodesCount,
    seriesBytes,
    musicCount,
    musicBytes,
    videosCount,
    videosBytes,
    imagesCount,
    imagesBytes,
    otherFilesCount,
    otherFilesBytes,
    vaultBytes,
    scannedTotalBytes,
    scannedFilesCount,
    volumeSource: cachedVol?.volumeSource || (hasPhysicalVol ? 'SMB2 / FRITZ!NAS' : undefined),
    isPhysicalVolumeReported: hasPhysicalVol,
    measuredAt: cachedVol?.measuredAt || new Date().toISOString(),
  };
}

function buildBridgeStatistics(items: NasMediaItem[]): WatchStatistics {
  const isItemWatched = (i: NasMediaItem): boolean =>
    Boolean(i.lastWatchedAt) ||
    Boolean(i.watchedWithoutDate) ||
    (i.watchedMinutes ?? 0) > 0 ||
    (i.episodesWatchedCount ?? 0) > 0 ||
    Boolean(i.episodes?.some((ep) => ep.watched));

  const getEffectiveMinutes = (i: NasMediaItem): number => {
    if (!isItemWatched(i)) return 0;
    if (i.kind === 'series') {
      const epCount =
        i.episodes && i.episodes.length > 0
          ? i.episodes.filter((ep) => ep.watched).length
          : i.episodesWatchedCount ?? 0;
      return Math.max(1, i.watchedMinutes || epCount * 42 || 42);
    }
    return Math.max(1, i.watchedMinutes || i.totalDurationMinutes || 60);
  };

  const watchedItems = items.filter(
    (i) => (i.kind === 'movie' || i.kind === 'series') && isItemWatched(i)
  );
  const totalMinutes = watchedItems.reduce((sum, i) => sum + getEffectiveMinutes(i), 0);
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const completedTitles = watchedItems.filter((i) => {
    if (i.kind === 'series') {
      const totalEp = i.totalEpisodes ?? i.episodes?.length ?? 0;
      const watchedEp =
        i.episodes && i.episodes.length > 0
          ? i.episodes.filter((ep) => ep.watched).length
          : i.episodesWatchedCount ?? 0;
      return totalEp > 0 && watchedEp >= totalEp;
    }
    const totalDur = Math.max(1, i.totalDurationMinutes || 60);
    return Boolean(i.watchedWithoutDate) || (i.watchedMinutes ?? 0) >= totalDur * 0.82;
  }).length;
  const activeSeriesCount = watchedItems.filter((i) => i.kind === 'series').length;

  const genreMinutes = new Map<string, number>();
  for (const i of watchedItems) {
    const mins = getEffectiveMinutes(i);
    const tokens = (i.genre || 'Allgemein')
      .split(/[&,\/]+/)
      .map((g) => g.trim())
      .filter(Boolean);
    const list = tokens.length > 0 ? tokens : ['Allgemein'];
    const share = Math.max(1, Math.round(mins / list.length));
    for (const g of list) {
      genreMinutes.set(g, (genreMinutes.get(g) ?? 0) + share);
    }
  }
  const genreTotal = Array.from(genreMinutes.values()).reduce((a, b) => a + b, 0) || 1;
  const genreBreakdown = Array.from(genreMinutes.entries())
    .map(([genre, mins]) => ({
      genre,
      hours: Math.round((mins / 60) * 10) / 10,
      percentage: Math.round((mins / genreTotal) * 100),
    }))
    .sort((a, b) => b.hours - a.hours);

  const historyItems = [...watchedItems]
    .sort((a, b) => {
      const ta = a.lastWatchedAt ? Date.parse(a.lastWatchedAt) : Number.NaN;
      const tb = b.lastWatchedAt ? Date.parse(b.lastWatchedAt) : Number.NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
      if (!Number.isNaN(tb)) return 1;
      if (!Number.isNaN(ta)) return -1;
      return a.title.localeCompare(b.title, 'de');
    })
    .slice(0, 30)
    .map((i) => {
      const isWithoutDate = Boolean(i.watchedWithoutDate) || !i.lastWatchedAt;
      const watchedEp =
        i.episodes && i.episodes.length > 0
          ? i.episodes.filter((ep) => ep.watched).length
          : i.episodesWatchedCount ?? (i.kind === 'series' ? 1 : 0);
      return {
        mediaId: i.id,
        title: i.title,
        mediaType: i.kind,
        genre: i.genre || 'Allgemein',
        year: i.year,
        coverUrl: i.coverUrl,
        watchedMinutes: getEffectiveMinutes(i),
        episodesWatched: watchedEp,
        timestamp: isWithoutDate ? null : i.lastWatchedAt,
        watchedWithoutDate: isWithoutDate,
      };
    });

  return {
    totals: {
      weekHours: totalHours,
      monthHours: totalHours,
      yearHours: totalHours,
      completedTitles,
      activeSeriesCount,
    },
    weeklyTrend: [{ label: 'Aktuell', hours: totalHours, episodes: activeSeriesCount }],
    monthlyTrend: [{ label: 'Aktuell', hours: totalHours }],
    yearlyTrend: [{ label: String(new Date().getFullYear()), hours: totalHours }],
    genreBreakdown,
    historyItems,
  };
}

function buildBridgeRecommendations(
  items: NasMediaItem[],
  collections: NasSavedCollection[] = []
): DuckRecommendationData {
  const splitGenres = (raw: string | undefined): string[] =>
    (raw || '')
      .split(/[&,\/]+/)
      .map((g) => g.trim())
      .filter((g) => Boolean(g) && g.toLowerCase() !== 'allgemein' && g.toLowerCase() !== 'medien');

  const isItemWatched = (i: NasMediaItem): boolean =>
    Boolean(i.lastWatchedAt) ||
    Boolean(i.watchedWithoutDate) ||
    (i.watchedMinutes ?? 0) > 0 ||
    (i.episodesWatchedCount ?? 0) > 0 ||
    Boolean(i.episodes?.some((ep) => ep.watched));

  const watchedItems = items
    .filter((i) => (i.kind === 'movie' || i.kind === 'series') && isItemWatched(i))
    .sort((a, b) => {
      const ta = a.lastWatchedAt ? Date.parse(a.lastWatchedAt) : Number.NaN;
      const tb = b.lastWatchedAt ? Date.parse(b.lastWatchedAt) : Number.NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
      if (!Number.isNaN(tb)) return 1;
      if (!Number.isNaN(ta)) return -1;
      return a.title.localeCompare(b.title, 'de');
    });

  const watchlistItems = items.filter((i) => Boolean(i.inWatchlist));
  const byId = new Map(items.map((i) => [i.id, i]));

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

  for (const w of watchedItems) {
    const totalEp = w.totalEpisodes ?? w.episodes?.length ?? 0;
    const watchedEp =
      w.episodes && w.episodes.length > 0
        ? w.episodes.filter((ep) => ep.watched).length
        : w.episodesWatchedCount ?? 0;
    const totalDur = Math.max(1, w.totalDurationMinutes || 90);

    const isCompletedMovie =
      w.kind !== 'series' &&
      ((w.watchedMinutes ?? 0) >= totalDur * 0.82 || Boolean(w.watchedWithoutDate));
    const isCompletedSeries =
      w.kind === 'series' && totalEp > 0 && watchedEp >= totalEp;

    if (isCompletedMovie || isCompletedSeries) {
      completedTitlesCount += 1;
    } else if (w.kind === 'series' && (watchedEp > 0 || (w.watchedMinutes ?? 0) > 0)) {
      inProgressSeriesCount += 1;
    }

    if (w.lastWatchedAt) {
      const ts = Date.parse(w.lastWatchedAt);
      if (!Number.isNaN(ts)) {
        activityHours.push(new Date(ts).getHours());
      }
    }

    const recency = (() => {
      if (!w.lastWatchedAt) return 0.95;
      const ts = Date.parse(w.lastWatchedAt);
      if (Number.isNaN(ts)) return 0.95;
      const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      if (ageDays <= 14) return 1.45;
      if (ageDays <= 45) return 1.2;
      if (ageDays <= 120) return 0.95;
      return 0.7;
    })();

    const engagementMinutes =
      w.kind === 'series'
        ? Math.max(30, w.watchedMinutes ?? 0, watchedEp * 42)
        : Math.max(20, w.watchedMinutes || totalDur);
    totalWatchMinutes += engagementMinutes;

    const completionFactor =
      w.kind === 'series'
        ? watchedEp >= 3
          ? 1.25
          : 0.95
        : isCompletedMovie
          ? 1.25
          : (w.watchedMinutes ?? 0) < 12
            ? 0.65
            : 0.95;

    const weight = Math.round(engagementMinutes * recency * completionFactor);
    if (w.kind === 'series') seriesWatchScore += weight;
    else movieWatchScore += weight;

    for (const token of splitGenres(w.genre)) {
      genreWeights.set(token, (genreWeights.get(token) ?? 0) + weight);
      if (!genreSourceTitle.has(token)) genreSourceTitle.set(token, w.title);
    }

    for (const mood of w.moodTags ?? []) {
      moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + Math.round(weight * 0.7));
      if (!moodSourceTitle.has(mood)) moodSourceTitle.set(mood, w.title);
    }

    const people = [
      ...(w.cast ?? []),
      ...(w.director ? [w.director] : []),
      ...(w.studio ? [w.studio] : []),
    ];
    for (const p of people) {
      creatorCastWeights.set(p, (creatorCastWeights.get(p) ?? 0) + Math.round(weight * 0.65));
      if (!creatorCastSourceTitle.has(p)) creatorCastSourceTitle.set(p, w.title);
    }
  }

  for (const wl of watchlistItems) {
    for (const token of splitGenres(wl.genre)) {
      genreWeights.set(token, (genreWeights.get(token) ?? 0) + 55);
      if (!genreSourceTitle.has(token)) genreSourceTitle.set(token, `${wl.title} (Merkliste)`);
    }
    for (const mood of wl.moodTags ?? []) {
      moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + 45);
      if (!moodSourceTitle.has(mood)) moodSourceTitle.set(mood, wl.title);
    }
    for (const p of [
      ...(wl.cast ?? []),
      ...(wl.director ? [wl.director] : []),
      ...(wl.studio ? [wl.studio] : []),
    ]) {
      creatorCastWeights.set(p, (creatorCastWeights.get(p) ?? 0) + 35);
      if (!creatorCastSourceTitle.has(p)) creatorCastSourceTitle.set(p, wl.title);
    }
  }

  for (const col of collections) {
    for (const mId of col.mediaIds) {
      const item = byId.get(mId);
      if (!item) continue;
      for (const token of splitGenres(item.genre)) {
        genreWeights.set(token, (genreWeights.get(token) ?? 0) + 35);
      }
      for (const mood of item.moodTags ?? []) {
        moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + 30);
      }
    }
  }

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

  const recentWatchedTitles = watchedItems.slice(0, 4).map((w) => w.title);
  const totalWatchHours = Math.round((totalWatchMinutes / 60) * 10) / 10;

  let preferredTimeWindow = 'Abend & Wochenende';
  if (activityHours.length > 0) {
    let evening = 0;
    let lateNight = 0;
    let daytime = 0;
    for (const h of activityHours) {
      if (h >= 18 && h <= 22) evening += 1;
      else if (h >= 23 || h <= 4) lateNight += 1;
      else daytime += 1;
    }
    if (evening >= lateNight && evening >= daytime) preferredTimeWindow = 'Abend & Prime-Time (18–23 Uhr)';
    else if (lateNight >= evening && lateNight >= daytime) preferredTimeWindow = 'Spätabend & Nacht';
    else preferredTimeWindow = 'Tagsüber & Nachmittag';
  } else if (watchedItems.some((w) => w.watchedWithoutDate)) {
    preferredTimeWindow = 'Individueller Sehverlauf';
  }

  let viewingPattern = 'Ausgewogener Film- & Serien-Mix';
  if (watchedItems.length === 0 && watchlistItems.length === 0) {
    viewingPattern = 'Einstiegsprofil · Katalog-Entdeckung';
  } else if (seriesWatchScore > movieWatchScore * 1.45) {
    viewingPattern =
      inProgressSeriesCount >= 2 ? 'Serien-Marathon mit aktiven Staffeln' : 'Klarer Serien-Fokus';
  } else if (movieWatchScore > seriesWatchScore * 1.35) {
    viewingPattern = 'Spielfilm- & Doku-Fokus';
  }

  const analysisHeadline =
    watchedItems.length > 0
      ? `${watchedItems.length} geschaute Titel (${totalWatchHours} Std.) · ${viewingPattern}`
      : `Merkliste (${watchlistItems.length}) & Katalog ausgewertet`;

  const watchedById = new Map(watchedItems.map((w) => [w.id, w]));
  const watchlistIdSet = new Set(watchlistItems.map((w) => w.id));

  const allScored = items
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

      const watchedEntry = watchedById.get(item.id);
      const totalEp = item.totalEpisodes ?? item.episodes?.length ?? 0;
      const watchedEp =
        item.episodes && item.episodes.length > 0
          ? item.episodes.filter((ep) => ep.watched).length
          : item.episodesWatchedCount ?? 0;
      const isCompletedMovie =
        Boolean(watchedEntry) &&
        item.kind !== 'series' &&
        ((item.watchedMinutes ?? 0) >= Math.max(1, item.totalDurationMinutes || 90) * 0.82 ||
          Boolean(item.watchedWithoutDate));
      const isCompletedSeries =
        Boolean(watchedEntry) &&
        item.kind === 'series' &&
        totalEp > 0 &&
        watchedEp >= totalEp;

      if (!watchedEntry) {
        score += 65;
      } else if (item.kind === 'series' && totalEp > watchedEp) {
        score += 28;
        matchedSignals.unshift(`Offene Folgen (${watchedEp}/${totalEp})`);
      } else if (isCompletedMovie || isCompletedSeries) {
        score -= 130;
      } else {
        score -= 15;
      }

      if (watchlistIdSet.has(item.id)) {
        score += 24;
        matchedSignals.push('Auf deiner Merkliste');
      }
      if (item.year >= 2024) {
        score += 8;
      }

      let reason = `Empfehlung aus deinem NAS-Katalog (${item.genre})`;
      if (watchedEntry && item.kind === 'series' && totalEp > watchedEp) {
        reason = `Weiterschauen: ${watchedEp} von ${totalEp} Folgen gesehen · passt zu deinem ${item.genre}-Verlauf`;
      } else if (!watchedEntry && matchedPeople.length > 0 && referenceWatchedTitle) {
        reason = `Neu für dich · Ähnliche Besetzung/Studio (${matchedPeople[0]}) wie beim gesehenen „${referenceWatchedTitle}“`;
      } else if (!watchedEntry && referenceWatchedTitle && matchedTokens.length > 0) {
        reason = `Neu für dich · Ähnlich wie dein geschautes „${referenceWatchedTitle}“ (${matchedTokens.join(' & ')})`;
      } else if (!watchedEntry && watchlistIdSet.has(item.id)) {
        reason = `Auf deiner Merkliste · Passt zu deinem ${topGenres[0] ?? item.genre}-Nutzungsprofil`;
      } else if (!watchedEntry && matchedMoodLabels.length > 0) {
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
  const topGenresText = topGenres.length > 0 ? topGenres.join(', ') : 'deinen NAS-Bestand';
  const watchedPreviewText =
    recentWatchedTitles.length > 0
      ? recentWatchedTitles
          .slice(0, 2)
          .map((t) => `„${t}“`)
          .join(' und ')
      : 'deinem Katalogprofil';

  const duckSummary =
    watchedItems.length > 0
      ? `Quak! Ich habe deine ${watchedItems.length} geschauten Titel (u. a. ${watchedPreviewText}, ${totalWatchHours} Std. Wiedergabe) und dein Nutzungsverhalten (${viewingPattern}) ausgewertet. Auf Basis deiner Vorlieben für ${topGenresText} empfehle ich dir ${scored.length} passende Titel (${seriesCount} Serien & ${movieCount} Filme).`
      : `Quak! Ich habe deinen NAS-Katalog und deine Merkliste (${watchlistItems.length} Titel) ausgewertet und empfehle dir ${scored.length} passende Titel (${seriesCount} Serien & ${movieCount} Filme).`;

  return {
    duckSummary,
    topGenres,
    source: 'nas-analyzer',
    generatedAt: new Date().toISOString(),
    analysis: {
      watchedTitlesCount: watchedItems.length,
      completedTitlesCount,
      inProgressSeriesCount,
      totalWatchHours,
      watchlistCount: watchlistItems.length,
      savedCollectionsCount: collections.length,
      recentWatchedTitles,
      topMoods,
      topCreatorsOrCast,
      recentSearchInterests: [],
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
  };
}

interface StoredSession {
  token: string;
  user: NasUser;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw =
      window.localStorage.getItem(SESSION_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed?.token === 'string' &&
      parsed.token.length > 0 &&
      parsed.user &&
      typeof parsed.user.username === 'string'
    ) {
      return { token: parsed.token, user: parsed.user };
    }
  } catch {
    // Ungültige gespeicherte Daten ignorieren
  }
  return null;
}

function persistStoredSession(token: string, user: NasUser): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token, user }));
    window.localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    // Speicherfehler ignorieren
  }
}

function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    // Speicherfehler ignorieren
  }
}

export default function App() {
  // Dauerhafte Anmeldung: Sitzung oder lokaler Fallback-On-Device-Puffer bleibt erhalten
  const [initialSession] = useState<StoredSession | null>(() => {
    const stored = readStoredSession();
    if (stored) return stored;
    const localBuf = readLocalOnboardingBuffer();
    if (localBuf) {
      return { token: localBuf.localToken, user: toNasUserFromBuffer(localBuf) };
    }
    return null;
  });
  const [token, setToken] = useState<string | null>(initialSession?.token ?? null);
  const [user, setUser] = useState<NasUser | null>(initialSession?.user ?? null);

  const isFallbackMode = isLocalFallbackToken(token);
  const [fallbackBuffer, setFallbackBuffer] = useState<LocalOnboardingBuffer | null>(() =>
    readLocalOnboardingBuffer()
  );
  const [fallbackServerInput, setFallbackServerInput] = useState<string>(
    () => readLocalOnboardingBuffer()?.serverUrl ?? ''
  );
  const [fallbackAutoCheck, setFallbackAutoCheck] = useState<boolean>(
    () => readLocalOnboardingBuffer()?.autoBackgroundCheck ?? true
  );
  const [fallbackSyncBusy, setFallbackSyncBusy] = useState(false);
  const [fallbackSyncError, setFallbackSyncError] = useState<string | null>(null);
  const [fallbackSyncNotice, setFallbackSyncNotice] = useState<string | null>(null);
  const [fallbackDiagnosis, setFallbackDiagnosis] = useState<NativeServerDiagnosis | null>(null);
  const [fallbackFritzUser, setFallbackFritzUser] = useState(
    () => readLocalOnboardingBuffer()?.nasConnection?.username ?? ''
  );
  const [fallbackFritzPass, setFallbackFritzPass] = useState(
    () =>
      readLocalOnboardingBuffer()?.nasConnection?.fritzPassword ??
      readLocalOnboardingBuffer()?.nasConnection?.secret ??
      ''
  );
  const [fallbackShowFritzPass, setFallbackShowFritzPass] = useState(false);
  const [fallbackFritzBusy, setFallbackFritzBusy] = useState(false);
  const [fallbackFritzResult, setFallbackFritzResult] = useState<string | null>(null);
  const [provisionedRevision, setProvisionedRevision] = useState(0);
  const [bridgeHealthStatus, setBridgeHealthStatus] = useState<
    'unknown' | 'online' | 'sleeping' | 'waking'
  >('unknown');
  const [bridgeTransportLabel, setBridgeTransportLabel] = useState<string | null>(null);
  const [nasMacInput, setNasMacInput] = useState<string>(() => readSavedNasMacAddress());
  const [nasWakeBusy, setNasWakeBusy] = useState(false);
  const [nasWakeFeedback, setNasWakeFeedback] = useState<string | null>(null);
  const [showWakeMacInput, setShowWakeMacInput] = useState(false);
  const autoWakeLastAttemptRef = useRef<number>(0);

  const fallbackHostCandidate =
    fallbackBuffer?.nasConnection?.host ||
    fallbackServerInput.trim() ||
    fallbackBuffer?.serverUrl ||
    fallbackDiagnosis?.resolvedIp ||
    fallbackDiagnosis?.host ||
    '';
  const matchedProvisionedEntry = useMemo(
    () =>
      readLocalProvisionedBackendForHost(fallbackHostCandidate) ??
      readAllLocalProvisionedBackends()[0] ??
      null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fallbackHostCandidate, provisionedRevision, fallbackBuffer]
  );
  const effectiveBridgeHost =
    cleanHostOnly(fallbackBuffer?.nasConnection?.host) ||
    cleanHostOnly(fallbackServerInput) ||
    cleanHostOnly(fallbackBuffer?.serverUrl) ||
    cleanHostOnly(matchedProvisionedEntry?.host) ||
    cleanHostOnly(fallbackDiagnosis?.resolvedIp || fallbackDiagnosis?.host);

  const isBridgeActive = Boolean(
    fallbackBuffer?.nasConnection?.storageBridgeMode ||
      fallbackBuffer?.nasConnection?.backendProvisioned ||
      fallbackBuffer?.nasConnection?.host ||
      matchedProvisionedEntry ||
      bridgeHealthStatus === 'online'
  );
  const [hydratedBackendPath, setHydratedBackendPath] = useState<string | null>(null);
  const [fallbackCardExpanded, setFallbackCardExpanded] = useState(false);
  const [manualSetupReopen, setManualSetupReopen] = useState(false);
  const [setupFinishBusy, setSetupFinishBusy] = useState(false);
  const [setupChecklistMissing, setSetupChecklistMissing] = useState<NasSetupMissingItem[]>([]);
  const [setupPromptDisplayName, setSetupPromptDisplayName] = useState<string>(
    () => readLocalOnboardingBuffer()?.user?.displayName ?? ''
  );
  const isSetupCompleted = Boolean(fallbackBuffer?.setupCompleted);
  const showSetupBanner = isFallbackMode && (!isSetupCompleted || manualSetupReopen);

  const activeBridgeTarget = useMemo(() => {
    const conn = fallbackBuffer?.nasConnection;
    const host = effectiveBridgeHost || cleanHostOnly(conn?.host);
    const password = fallbackFritzPass || conn?.fritzPassword || conn?.secret || '';
    if (!host || !password) return null;
    const protocol = conn?.protocol ?? matchedProvisionedEntry?.protocol ?? 'fritz_upnp';
    const useTls = protocol === 'smb' ? false : Boolean(conn?.useTls);
    const port = String(
      sanitizeNasPortForProtocol(
        protocol,
        conn?.port || (protocol === 'smb' ? '445' : useTls ? '443' : '80'),
        useTls
      )
    );
    return {
      protocol,
      host,
      port,
      shareOrPath: protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
      username: (fallbackFritzUser.trim() || conn?.username || '').trim(),
      password,
      secret: password,
      fritzPassword: password,
      domainOrWorkgroup: conn?.domainOrWorkgroup,
      useTls,
    };
  }, [
    effectiveBridgeHost,
    fallbackBuffer?.nasConnection,
    fallbackFritzPass,
    fallbackFritzUser,
    matchedProvisionedEntry?.protocol,
  ]);

  const effectiveSyncedBackendPath =
    hydratedBackendPath ||
    fallbackBuffer?.syncedBackendPath ||
    fallbackBuffer?.nasConnection?.backendPath ||
    matchedProvisionedEntry?.backendPath ||
    null;

  const isNasStorageSynced = Boolean(
    isFallbackMode &&
      (isConfirmedStorageBridge(fallbackBuffer) ||
        hydratedBackendPath ||
        fallbackBuffer?.syncedBackendPath) &&
      !fallbackSyncError
  );

  const [provisionDialogOpen, setProvisionDialogOpen] = useState(false);
  const [provisionDialogTarget, setProvisionDialogTarget] =
    useState<NasBackendProvisionTarget | null>(null);
  const autoOpenedAppProvisionRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const syncFromStorage = () => {
      const latest = readLocalOnboardingBuffer();
      setFallbackBuffer(latest);
      setProvisionedRevision((r) => r + 1);
      if (latest?.setupCompleted) {
        setManualSetupReopen(false);
        setFallbackCardExpanded(false);
        setSetupChecklistMissing([]);
      }
      if (latest?.nasConnection?.host) {
        setFallbackServerInput((prev) => prev || latest.serverUrl || latest.nasConnection?.host || '');
        setFallbackFritzUser((prev) => prev || latest.nasConnection?.username || '');
        setFallbackFritzPass(
          (prev) =>
            prev || latest.nasConnection?.fritzPassword || latest.nasConnection?.secret || ''
        );
      }
    };
    window.addEventListener(LOCAL_BUFFER_UPDATED_EVENT, syncFromStorage);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(LOCAL_BUFFER_UPDATED_EVENT, syncFromStorage);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  useEffect(() => {
    if (!fallbackSyncNotice || !isSetupCompleted) return;
    const timer = window.setTimeout(() => {
      setFallbackSyncNotice(null);
    }, 8000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [fallbackSyncNotice, isSetupCompleted]);

  useEffect(() => {
    if (!effectiveBridgeHost) return;
    const savedMac = readSavedNasMacAddress(effectiveBridgeHost);
    if (savedMac) {
      setNasMacInput((prev) => prev || savedMac);
    }
  }, [effectiveBridgeHost]);

  useEffect(() => {
    if (token) return;
    let manualLogout = false;
    try {
      manualLogout = window.sessionStorage.getItem('entencenter_manual_logout') === '1';
    } catch {
      manualLogout = false;
    }
    if (manualLogout) return;
    let active = true;
    void hydrateLocalOnboardingBufferFromIndexedDb().then((recovered) => {
      if (!active || !recovered) return;
      const fallbackUser = toNasUserFromBuffer(recovered);
      setFallbackBuffer(recovered);
      setFallbackServerInput(recovered.serverUrl);
      setFallbackAutoCheck(recovered.autoBackgroundCheck);
      persistStoredSession(recovered.localToken, fallbackUser);
      setToken(recovered.localToken);
      setUser(fallbackUser);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const [section, setSection] = useState<SectionId>('library');
  const [adminActiveTab, setAdminActiveTab] = useState<AdminSectionTab>('all');
  const [calendarMenuOpen, setCalendarMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [aboutMenuOpen, setAboutMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  useEffect(() => {
    if (section === 'calendar' || section === 'filmstarts') {
      setCalendarMenuOpen(true);
    }
    if (section === 'admin') {
      setAdminMenuOpen(true);
    }
    if (section === 'about-update') {
      setAboutMenuOpen(true);
    }
  }, [section]);

  const [libraryItems, setLibraryItems] = useState<NasMediaItem[]>([]);
  const [calendarReleases, setCalendarReleases] = useState<CalendarRelease[]>([]);
  const [calendarSources, setCalendarSources] = useState<FilmGroundSource[]>([]);
  const [calendarLastFetchedAt, setCalendarLastFetchedAt] = useState<string | null>(null);
  const [calendarFetchMethod, setCalendarFetchMethod] =
    useState<NonNullable<SeriesCalendarResponse['fetchMethod']>>('cache');
  const [calendarWarning, setCalendarWarning] = useState<string | null>(null);
  const [calendarRefreshing, setCalendarRefreshing] = useState(false);
  const [filmStarts, setFilmStarts] = useState<FilmStartRelease[]>([]);
  const [filmStartSources, setFilmStartSources] = useState<FilmGroundSource[]>([]);
  const [filmStartsLastFetchedAt, setFilmStartsLastFetchedAt] = useState<string | null>(null);
  const [filmStartsFetchMethod, setFilmStartsFetchMethod] =
    useState<FilmStartsResponse['fetchMethod']>('cache');
  const [filmStartsWarning, setFilmStartsWarning] = useState<string | null>(null);
  const [filmStartsLoading, setFilmStartsLoading] = useState(false);
  const [filmStartsRefreshing, setFilmStartsRefreshing] = useState(false);
  const [notifications, setNotifications] = useState<NasNotification[]>([]);
  const [statistics, setStatistics] = useState<WatchStatistics | null>(null);
  const [recommendations, setRecommendations] = useState<DuckRecommendationData | null>(null);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [nasStorage, setNasStorage] = useState<NasStorageStats | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  const [syncMode, setSyncMode] = useState<SyncMode>('manual');
  const [lastScanTs, setLastScanTs] = useState<string | null>(null);
  const [scanningNas, setScanningNas] = useState(false);
  const [enrichingMetadata, setEnrichingMetadata] = useState(false);
  const autoScannedSessionRef = useRef(false);
  const bridgeEnrichInFlightRef = useRef(false);

  const [activePlayerItem, setActivePlayerItem] = useState<NasMediaItem | null>(null);
  const [homeResetSignal, setHomeResetSignal] = useState(0);
  const [externalAudioItem, setExternalAudioItem] = useState<NasMediaItem | null>(null);
  const [copiedAudioPath, setCopiedAudioPath] = useState(false);
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueueItem[]>([]);
  const [savedCollections, setSavedCollections] = useState<NasSavedCollection[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences>(() => readStoredPreferences());
  const [autoThemeNowMs, setAutoThemeNowMs] = useState<number>(() => Date.now());
  const [assistantAvatarUrl, setAssistantAvatarUrl] = useState<string>(
    DEFAULT_ASSISTANT_AVATAR_URL
  );

  useEffect(() => {
    const mode = preferences.autoTheme?.mode ?? 'off';
    if (mode === 'off') return;
    setAutoThemeNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setAutoThemeNowMs(Date.now());
    }, 30000);
    const refreshNow = () => {
      if (document.visibilityState === 'visible') {
        setAutoThemeNowMs(Date.now());
      }
    };
    window.addEventListener('focus', refreshNow);
    document.addEventListener('visibilitychange', refreshNow);
    return () => {
      window.clearInterval(timerId);
      window.removeEventListener('focus', refreshNow);
      document.removeEventListener('visibilitychange', refreshNow);
    };
  }, [preferences.autoTheme?.mode]);

  const autoThemeEvaluation = useMemo(
    () =>
      evaluateAutoTheme(
        preferences.autoTheme,
        new Date(autoThemeNowMs),
        preferences.theme
      ),
    [preferences.autoTheme, preferences.theme, autoThemeNowMs]
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = autoThemeEvaluation.targetTheme;
    const custom = preferences.customTheme;
    if (
      !autoThemeEvaluation.isAutoActive &&
      custom &&
      (custom.activeFor === 'design1' || custom.activeFor === 'design2')
    ) {
      const activePalette = custom.activeFor === 'design2' ? custom.design2 : custom.design1;
      root.dataset.customTheme = custom.activeFor;
      root.style.setProperty('--mc-custom-bg', activePalette.background);
      root.style.setProperty('--mc-custom-sidebar', activePalette.sidebar);
      root.style.setProperty('--mc-custom-surface', activePalette.surface);
      root.style.setProperty('--mc-custom-accent', activePalette.accent);
      root.style.setProperty('--mc-custom-text', activePalette.text);
      root.style.setProperty('--mc-custom-border', activePalette.border);
    } else {
      delete root.dataset.customTheme;
      root.style.removeProperty('--mc-custom-bg');
      root.style.removeProperty('--mc-custom-sidebar');
      root.style.removeProperty('--mc-custom-surface');
      root.style.removeProperty('--mc-custom-accent');
      root.style.removeProperty('--mc-custom-text');
      root.style.removeProperty('--mc-custom-border');
    }
  }, [autoThemeEvaluation, preferences.customTheme]);

  useEffect(() => {
    return initDeviceDisplayListener();
  }, []);

  useEffect(() => {
    if (section === 'admin' && user?.role !== 'admin') {
      setSection('library');
    }
  }, [section, user?.role]);

  const scrollViewportToTop = useCallback(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  useEffect(() => {
    scrollViewportToTop();
    const rafId = window.requestAnimationFrame(() => {
      scrollViewportToTop();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [section, homeResetSignal, scrollViewportToTop]);

  const navigateToSection = useCallback(
    (targetSection: SectionId, closeMobile = false) => {
      setNotificationsOpen(false);
      setNasStatusMenuOpen(false);
      setSection(targetSection);
      if (targetSection === 'library') {
        setHomeResetSignal((n) => n + 1);
      }
      if (closeMobile) {
        setMobileMenuOpen(false);
      }
      scrollViewportToTop();
    },
    [scrollViewportToTop]
  );

  // Echtzeit-Verbindungsstatus zum NAS (WebSocket mit automatischem Polling-Fallback)
  const [nasConnStatus, setNasConnStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('connecting');
  const [nasTransport, setNasTransport] = useState<'websocket' | 'polling'>('websocket');
  const [nasLatencyMs, setNasLatencyMs] = useState<number | null>(null);
  const [nasCatalogCount, setNasCatalogCount] = useState<number | null>(null);
  const [nasMountPath, setNasMountPath] = useState<string>('/mnt/nas/.entencenter');
  const [nasLastHeartbeat, setNasLastHeartbeat] = useState<string | null>(null);
  const [nasStatusMenuOpen, setNasStatusMenuOpen] = useState(false);
  const [nasDeepDiagTarget, setNasDeepDiagTarget] = useState<string>('');
  const [nasDeepDiagLoading, setNasDeepDiagLoading] = useState(false);
  const [nasDeepDiagResult, setNasDeepDiagResult] = useState<DeepNetworkDiagnosticsResult | null>(
    null
  );
  const [nasDeepDiagError, setNasDeepDiagError] = useState<string | null>(null);
  const [appPreferredAltPort, setAppPreferredAltPort] = useState<number>(() =>
    getPreferredAlternativePort()
  );
  const [appAutoPortFallback, setAppAutoPortFallback] = useState<boolean>(() =>
    getAutoPortFallbackEnabled()
  );
  const [appPortScanBusy, setAppPortScanBusy] = useState(false);
  const [appPortScanResult, setAppPortScanResult] = useState<AlternativePortScanResult | null>(
    null
  );
  const [sharedNasCert, setSharedNasCert] = useState<NasSecurityCertificateInfo | null>(
    () => getStoredSharedNasCertificate()?.certificate ?? null
  );
  const wsRef = useRef<WebSocket | null>(null);
  const [smartHomeState, setSmartHomeState] = useState<SmartHomeRemoteState | null>(null);
  const lastSmartHomeSeqRef = useRef<number | null>(null);

  const authHeaders = useMemo((): Record<string, string> => {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }, [token]);

  const mapCalendarReleases = useCallback(
    (list: CalendarRelease[]): CalendarRelease[] =>
      list.map((rel) => ({
        ...rel,
        coverUrl:
          rel.coverUrl ??
          MARCENTE_ASSETS[rel.coverKey as keyof typeof MARCENTE_ASSETS] ??
          MARCENTE_ASSETS.posterDarkMatter,
      })),
    []
  );

  const applySeriesCalendarPayload = useCallback(
    (data: SeriesCalendarResponse) => {
      setCalendarReleases(mapCalendarReleases(data.releases ?? []));
      if (Array.isArray(data.alerts)) {
        setNotifications(data.alerts);
      }
      if (data.sources !== undefined) {
        setCalendarSources(data.sources);
      }
      if (data.lastFetchedAt !== undefined) {
        setCalendarLastFetchedAt(data.lastFetchedAt ?? null);
      }
      if (data.fetchMethod !== undefined) {
        setCalendarFetchMethod(data.fetchMethod ?? 'cache');
      }
      if (data.fetchWarning !== undefined) {
        setCalendarWarning(data.fetchWarning ?? null);
      }
    },
    [mapCalendarReleases]
  );

  const applyFilmStartsPayload = useCallback((data: FilmStartsResponse) => {
    setFilmStarts(
      (data.releases ?? []).map((rel) => ({
        ...rel,
        coverUrl:
          rel.coverUrl ??
          MARCENTE_ASSETS[rel.coverKey as keyof typeof MARCENTE_ASSETS] ??
          MARCENTE_ASSETS.posterDarkMatter,
      }))
    );
    setFilmStartSources(data.sources ?? []);
    setFilmStartsLastFetchedAt(data.lastFetchedAt ?? null);
    setFilmStartsFetchMethod(data.fetchMethod ?? 'cache');
    setFilmStartsWarning(data.fetchWarning ?? null);
    if (Array.isArray(data.alerts)) {
      setNotifications(data.alerts);
    }
  }, []);

  const loadFilmStarts = useCallback(
    async (activeToken: string) => {
      setFilmStartsLoading(true);
      try {
        const res = await fetch('/api/nas/filmstarts', {
          headers: { Authorization: `Bearer ${activeToken}` },
        });
        if (res.ok) {
          const data = (await res.json()) as FilmStartsResponse;
          applyFilmStartsPayload(data);
        }
      } catch {
        // Stiller Fehler beim Hintergrund-Abruf
      } finally {
        setFilmStartsLoading(false);
      }
    },
    [applyFilmStartsPayload]
  );

  const loadAllNasData = useCallback(
    async (activeToken: string) => {
      if (isLocalFallbackToken(activeToken)) {
        const buf = readLocalOnboardingBuffer();
        const conn = buf?.nasConnection;
        const pass = conn?.fritzPassword || conn?.secret || '';
        const provisionedForHost =
          readLocalProvisionedBackendForHost(conn?.host || buf?.serverUrl || '') ??
          readAllLocalProvisionedBackends()[0] ??
          null;
        const targetHost =
          cleanHostOnly(conn?.host) ||
          cleanHostOnly(buf?.serverUrl) ||
          cleanHostOnly(provisionedForHost?.host) ||
          '';
        const bridgeProto = conn?.protocol ?? provisionedForHost?.protocol ?? 'fritz_upnp';
        const bridgeUseTls = bridgeProto === 'smb' ? false : Boolean(conn?.useTls);
        const bridgePort = String(
          sanitizeNasPortForProtocol(
            bridgeProto,
            conn?.port || (bridgeProto === 'smb' ? '445' : bridgeUseTls ? '443' : '80'),
            bridgeUseTls
          )
        );
        const bridgeTargetForLoad =
          targetHost && pass
            ? {
                protocol: bridgeProto,
                host: targetHost,
                port: bridgePort,
                shareOrPath: bridgeProto === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
                username: (conn?.username || '').trim(),
                password: pass,
                secret: pass,
                fritzPassword: pass,
                domainOrWorkgroup: conn?.domainOrWorkgroup,
                useTls: bridgeUseTls,
              }
            : null;

        const decorateBridgeItems = (items: NasMediaItem[]): NasMediaItem[] =>
          items.map((item) => {
            const fallbackCover =
              item.coverUrl ||
              MARCENTE_ASSETS[
                item.kind === 'series'
                  ? 'posterCyberBerlin'
                  : item.kind === 'image'
                    ? 'coverNasBilder'
                    : item.kind === 'music'
                      ? 'coverNasMusik'
                      : item.kind === 'video'
                        ? 'coverNasVideo'
                        : item.kind === 'other'
                          ? 'coverNasSonstiges'
                          : 'posterDarkMatter'
              ];
            const resolvedUrl = resolvePlayableNasMediaUrl(item, bridgeTargetForLoad, activeToken);
            const inferredMime =
              item.uploadedMimeType ||
              (item.nasPath ? inferMimeTypeFromPath(item.nasPath) : undefined);
            return {
              ...item,
              coverUrl: fallbackCover,
              uploadedMimeType: inferredMime,
              mediaUrl: resolvedUrl ?? item.mediaUrl,
            };
          });

        const rawLocalCatalog = readLocalBridgeCatalog();
        const { items: normalizedLocalCatalog, changed: localCatalogChanged } =
          groupAndNormalizeNasCatalog(rawLocalCatalog);
        if (localCatalogChanged) {
          saveLocalBridgeCatalog(stripEphemeralMediaUrlForCatalog(normalizedLocalCatalog));
        }
        const initialBridgeItems = decorateBridgeItems(normalizedLocalCatalog);
        const initialMountPath =
          buf?.syncedBackendPath ||
          conn?.backendPath ||
          provisionedForHost?.backendPath ||
          '/EntenCenter-Backend';
        setLibraryItems(initialBridgeItems);
        setNasCatalogCount(initialBridgeItems.length);
        setNasMountPath(initialMountPath);
        setNasStorage(buildBridgeStorageStats(initialBridgeItems, initialMountPath));
        setStatistics(buildBridgeStatistics(initialBridgeItems));
        setRecommendations(buildBridgeRecommendations(initialBridgeItems));
        setSyncMode(readStoredBridgeSyncMode());
        setNotifications(readBridgeNotifications());

        const prefsNow = readStoredPreferences();
        const calMode = prefsNow.calendarNotificationMode ?? 'favorites_all';
        const filmMode = prefsNow.filmNotificationMode ?? 'favorites';
        const cachedCal = readCachedSeriesCalendarBridge(initialBridgeItems, calMode);
        if (cachedCal.releases.length > 0) {
          applySeriesCalendarPayload(cachedCal);
        }
        const cachedFilms = readCachedFilmstartsBridge(initialBridgeItems, filmMode);
        if (cachedFilms) {
          applyFilmStartsPayload(cachedFilms);
        }
        setLoadingData(false);

        // Live-Internet-Daten (Filmstarts, Serienkalender & Inhaltsanreicherung) im Hintergrund laden
        void fetchLiveSeriesCalendarBridge(initialBridgeItems, calMode)
          .then((liveCal) => {
            if (liveCal.releases.length > 0) {
              applySeriesCalendarPayload(liveCal);
            }
          })
          .catch(() => null);
        setFilmStartsLoading(true);
        void fetchLiveFilmstartsBridge(initialBridgeItems, filmMode)
          .then((liveFilms) => {
            applyFilmStartsPayload(liveFilms);
          })
          .catch(() => null)
          .finally(() => setFilmStartsLoading(false));

        const triggerBridgeCatalogEnrichment = (
          sourceItems: NasMediaItem[],
          backendRootPath: string
        ) => {
          if (bridgeEnrichInFlightRef.current) return;
          const hasUnenriched = sourceItems.some(
            (it) =>
              it.kind !== 'image' &&
              it.kind !== 'other' &&
              ((!it.customCoverUrl && isPlaceholderCoverUrl(it.coverUrl)) ||
                !it.synopsis ||
                it.synopsis.startsWith('Beim NAS-Ordnerscan'))
          );
          if (!hasUnenriched) return;
          bridgeEnrichInFlightRef.current = true;
          void (async () => {
            try {
              let workingCatalog = sourceItems;
              for (let batchIdx = 0; batchIdx < 12; batchIdx++) {
                const res = await enrichNasCatalogFromInternet(workingCatalog, 24);
                if (res.enrichedCount > 0) {
                  workingCatalog = groupAndNormalizeNasCatalog(res.items).items;
                  const cleanEnriched = stripEphemeralMediaUrlForCatalog(workingCatalog);
                  saveLocalBridgeCatalog(cleanEnriched);
                  const decorated = decorateBridgeItems(cleanEnriched);
                  setLibraryItems(decorated);
                  setNasCatalogCount(decorated.length);
                  if (bridgeTargetForLoad && (res.remainingCount === 0 || batchIdx % 2 === 1)) {
                    void writeFileToNasBridge({
                      ...bridgeTargetForLoad,
                      targetPath: `${backendRootPath.replace(/\/+$/, '')}/config/catalog.json`,
                      content: JSON.stringify(cleanEnriched, null, 2),
                      contentType: 'application/json; charset=utf-8',
                    }).catch(() => null);
                  }
                }
                if (res.enrichedCount === 0 || res.remainingCount === 0) {
                  break;
                }
                await new Promise((resolve) => window.setTimeout(resolve, 250));
              }
            } catch {
              // Fehler still tolerieren
            } finally {
              bridgeEnrichInFlightRef.current = false;
            }
          })();
        };

        // IndexedDB-Katalog nachladen, falls localStorage (5 MB Limit) bei großen NAS-Beständen beschnitten wurde
        void hydrateLocalBridgeCatalogFromIndexedDb()
          .then((idbItems) => {
            if (!idbItems || idbItems.length === 0) return;
            const groupedIdb = groupAndNormalizeNasCatalog(idbItems).items;
            if (groupedIdb.length > initialBridgeItems.length) {
              const decoratedIdb = decorateBridgeItems(groupedIdb);
              setLibraryItems(decoratedIdb);
              setNasCatalogCount(decoratedIdb.length);
              setNasStorage(buildBridgeStorageStats(decoratedIdb, initialMountPath));
              setStatistics(buildBridgeStatistics(decoratedIdb));
              setRecommendations(buildBridgeRecommendations(decoratedIdb));
              triggerBridgeCatalogEnrichment(decoratedIdb, initialMountPath);
            }
          })
          .catch(() => null);

        if (bridgeTargetForLoad) {
          // Echte Volume-Kapazität (z. B. 2 TB FRITZ!NAS) direkt per SMB2 / FRITZ!NAS abfragen
          void fetchNasStorageStatsBridge(bridgeTargetForLoad)
            .then((volStats) => {
              if (volStats) {
                setNasStorage(buildBridgeStorageStats(readLocalBridgeCatalog(), initialMountPath));
              }
            })
            .catch(() => null);

          const preferredBackend =
            buf?.syncedBackendPath ||
            conn?.backendPath ||
            provisionedForHost?.backendPath ||
            '/EntenCenter-Backend';
          const effectiveUsername = buf?.user?.username || 'admin';
          void discoverAndHydrateBackendFromNasBridge({
            target: bridgeTargetForLoad,
            username: effectiveUsername,
            preferredBackendPath: preferredBackend,
          })
            .then((discovered) => {
              if (!discovered.found) {
                triggerBridgeCatalogEnrichment(initialBridgeItems, initialMountPath);
                return;
              }
              setHydratedBackendPath(discovered.backendPath);
              setNasMountPath(discovered.backendPath);
              setBridgeHealthStatus('online');
              setNasConnStatus('connected');
              setNasLastHeartbeat(new Date().toISOString());
              saveLocalProvisionedBackendFolder(
                targetHost,
                bridgeProto,
                discovered.backendPath
              );
              if (discovered.scanFolderSettings) {
                saveLocalBridgeScanSettings(discovered.scanFolderSettings);
              }
              if (discovered.pathSettings) {
                saveLocalBridgePathSettings(discovered.pathSettings);
              }
              let latestItems = initialBridgeItems;
              if (Array.isArray(discovered.catalog) && discovered.catalog.length > 0) {
                const merged = upsertLocalBridgeCatalogItems(discovered.catalog);
                latestItems = decorateBridgeItems(merged);
                setLibraryItems(latestItems);
              }
              setNasCatalogCount(latestItems.length);
              setNasStorage(buildBridgeStorageStats(latestItems, discovered.backendPath));
              setStatistics(buildBridgeStatistics(latestItems));
              setRecommendations(buildBridgeRecommendations(latestItems));
              triggerBridgeCatalogEnrichment(latestItems, discovered.backendPath);

              const latestBuf = readLocalOnboardingBuffer();
              if (
                latestBuf &&
                (discovered.hasProfile || discovered.hasManifest || discovered.hasConfig)
              ) {
                const completeness = evaluateNasSetupCompleteness({
                  buffer: latestBuf,
                  overrideHost: targetHost,
                  overrideUsername: bridgeTargetForLoad.username,
                  overridePassword: bridgeTargetForLoad.password,
                  overrideBackendPath: discovered.backendPath,
                  connectionOnline: true,
                  remoteBackendVerified: true,
                });
                const wasAlreadyCompleted = Boolean(latestBuf.setupCompleted);
                const shouldAutoComplete = completeness.complete;
                if (
                  latestBuf.mode !== 'storage_bridge_active' ||
                  !latestBuf.nasSyncedAt ||
                  latestBuf.syncedBackendPath !== discovered.backendPath ||
                  (shouldAutoComplete && !latestBuf.setupCompleted)
                ) {
                  if (shouldAutoComplete) {
                    void markNasSetupCompleted({
                      buffer: latestBuf,
                      backendPath: discovered.backendPath,
                      host: targetHost,
                      username: bridgeTargetForLoad.username,
                      password: bridgeTargetForLoad.password,
                      autoCompleted: true,
                    }).then((done) => {
                      if (done.buffer) {
                        setFallbackBuffer(done.buffer);
                        setFallbackCardExpanded(false);
                        setManualSetupReopen(false);
                        setSetupChecklistMissing([]);
                        if (!wasAlreadyCompleted) {
                          setFallbackSyncNotice(
                            `Einrichtung automatisch abgeschlossen — ${targetHost} (${discovered.backendPath}) ist aktiv.`
                          );
                        }
                      }
                    });
                  } else {
                    const updatedBuf: LocalOnboardingBuffer = {
                      ...latestBuf,
                      mode: 'storage_bridge_active',
                      nasSyncedAt: latestBuf.nasSyncedAt || new Date().toISOString(),
                      syncedBackendPath: discovered.backendPath,
                      nasConnection: latestBuf.nasConnection
                        ? {
                            ...latestBuf.nasConnection,
                            backendPath: discovered.backendPath,
                            backendProvisioned: true,
                            storageBridgeMode: true,
                          }
                        : latestBuf.nasConnection,
                      updatedAt: new Date().toISOString(),
                    };
                    writeLocalOnboardingBuffer(updatedBuf);
                    setFallbackBuffer(updatedBuf);
                  }
                }
              }
            })
            .catch(() => null);
        } else {
          triggerBridgeCatalogEnrichment(initialBridgeItems, initialMountPath);
        }
        return;
      }
      setLoadingData(true);
      void loadFilmStarts(activeToken);
      const headers = { Authorization: `Bearer ${activeToken}` };
      try {
        const [libRes, calRes, statRes, syncRes, recRes, prefRes, storageRes, colRes] =
          await Promise.all([
            fetch('/api/nas/library', { headers }),
            fetch('/api/nas/calendar', { headers }),
            fetch('/api/nas/statistics', { headers }),
            fetch('/api/nas/sync/settings', { headers }),
            fetch('/api/nas/recommendations', { headers }),
            fetch('/api/nas/preferences', { headers }),
            fetch('/api/nas/storage', { headers }),
            fetch('/api/nas/collections', { headers }),
          ]);

        if (libRes.ok) {
          const libData = (await libRes.json()) as { items: ServerLibraryItem[] };
          const tokenSuffix = `token=${encodeURIComponent(activeToken)}`;
          const withToken = (rawUrl?: string) => {
            if (!rawUrl) return undefined;
            const resolved = resolveNasUrl(rawUrl);
            return `${resolved}${resolved.includes('?') ? '&' : '?'}${tokenSuffix}`;
          };
          setLibraryItems(
            libData.items.map((item) => {
              const fallbackCover =
                MARCENTE_ASSETS[item.coverKey] ?? MARCENTE_ASSETS.posterDarkMatter;
              const resolvedCustomCover = withToken(item.customCoverUrl);
              const resolvedCover = resolvedCustomCover ?? fallbackCover;
              return {
                ...item,
                coverUrl: resolvedCover,
                customCoverUrl: resolvedCustomCover,
                mediaUrl: withToken(item.mediaUrl),
                episodes: item.episodes?.map((ep) => ({
                  ...ep,
                  screenshotUrl: ep.screenshotKey
                    ? MARCENTE_ASSETS[ep.screenshotKey as keyof typeof MARCENTE_ASSETS] ??
                      resolvedCover
                    : resolvedCover,
                })),
              };
            })
          );
        }

        if (calRes.ok) {
          const calData = (await calRes.json()) as SeriesCalendarResponse;
          applySeriesCalendarPayload(calData);
        }

        if (statRes.ok) {
          const statData = (await statRes.json()) as WatchStatistics;
          setStatistics({
            ...statData,
            historyItems: statData.historyItems.map((entry) => ({
              ...entry,
              coverUrl:
                entry.coverUrl ??
                MARCENTE_ASSETS[entry.coverKey as keyof typeof MARCENTE_ASSETS] ??
                MARCENTE_ASSETS.posterDarkMatter,
            })),
          });
        }

        if (recRes.ok) {
          const recData = (await recRes.json()) as DuckRecommendationData;
          setRecommendations(recData);
        }

        if (prefRes.ok) {
          const prefData = (await prefRes.json()) as UserPreferences;
          setPreferences(prefData);
          persistStoredPreferences(prefData);
        }

        if (storageRes.ok) {
          const storageData = (await storageRes.json()) as NasStorageStats;
          setNasStorage(storageData);
        }

        if (colRes.ok) {
          const colData = (await colRes.json()) as { collections: NasSavedCollection[] };
          setSavedCollections(colData.collections ?? []);
        }

        if (syncRes.ok) {
          const syncData = (await syncRes.json()) as {
            syncMode: SyncMode;
            lastScanTimestamp: string | null;
            assistantAvatarUrl?: string;
          };
          setSyncMode(syncData.syncMode);
          setLastScanTs(syncData.lastScanTimestamp);
          if (syncData.assistantAvatarUrl) {
            setAssistantAvatarUrl(resolveAssistantAvatarSrc(syncData.assistantAvatarUrl));
          }

          // Automatisches Scannen beim Start ausführen, falls aktiviert
          if (!autoScannedSessionRef.current && syncData.syncMode !== 'manual') {
            const todayDate = new Date().toISOString().slice(0, 10);
            const lastDate = syncData.lastScanTimestamp
              ? syncData.lastScanTimestamp.slice(0, 10)
              : null;
            const shouldScan =
              syncData.syncMode === 'every_start' ||
              (syncData.syncMode === 'daily_first' && lastDate !== todayDate);

            autoScannedSessionRef.current = true;
            if (shouldScan) {
              const autoRunRes = await fetch('/api/nas/sync/run', {
                method: 'POST',
                headers,
              });
              if (autoRunRes.ok) {
                const autoData = (await autoRunRes.json()) as {
                  lastScanTimestamp: string;
                  alerts?: NasNotification[];
                  newlyAddedCount?: number;
                };
                setLastScanTs(autoData.lastScanTimestamp);
                if (Array.isArray(autoData.alerts)) {
                  setNotifications(autoData.alerts);
                }
              }
            }
          }
        }
      } finally {
        setLoadingData(false);
      }
    },
    [loadFilmStarts]
  );

  const refreshRecommendationsSilently = useCallback(async () => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      setRecommendations(buildBridgeRecommendations(readLocalBridgeCatalog(), savedCollections));
      return;
    }
    try {
      const res = await fetch('/api/nas/recommendations', {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as DuckRecommendationData;
        setRecommendations(data);
      }
    } catch {
      // Stiller Hintergrund-Abgleich ohne UI-Unterbrechung
    }
  }, [token, authHeaders, savedCollections]);

  const handleRefreshRecommendations = useCallback(async () => {
    if (!token || recommendationsLoading) return;
    setRecommendationsLoading(true);
    try {
      if (isLocalFallbackToken(token)) {
        setRecommendations(buildBridgeRecommendations(readLocalBridgeCatalog(), savedCollections));
        return;
      }
      const res = await fetch('/api/nas/recommendations', {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as DuckRecommendationData;
        setRecommendations(data);
      }
    } finally {
      setRecommendationsLoading(false);
    }
  }, [token, recommendationsLoading, authHeaders, savedCollections]);

  const handleAskDuck = useCallback(
    async (query: string, mode: AskDuckMode = 'auto'): Promise<AskDuckResponse> => {
      if (!token) {
        throw new Error('Bitte melde dich zuerst auf dem NAS an.');
      }
      const res = await fetch('/api/nas/ask-duck', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ query, mode }),
      });
      const data = (await res.json()) as AskDuckResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Die NAS-Suche konnte nicht ausgeführt werden.');
      }
      void refreshRecommendationsSilently();
      return data;
    },
    [token, authHeaders, refreshRecommendationsSilently]
  );

  const handleSaveCollection = useCallback(
    async (payload: {
      collectionType: AskDuckCollectionType;
      title: string;
      criteriaSummary: string;
      createdByPrompt: string;
      mediaIds: string[];
    }): Promise<NasSavedCollection> => {
      if (!token) {
        throw new Error('Bitte melde dich zuerst auf dem NAS an.');
      }
      const res = await fetch('/api/nas/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        collection?: NasSavedCollection;
        collections?: NasSavedCollection[];
        error?: string;
      };
      if (!res.ok || !data.collection) {
        throw new Error(data.error || 'Sammlung konnte nicht gespeichert werden.');
      }
      if (Array.isArray(data.collections)) {
        setSavedCollections(data.collections);
      }
      void refreshRecommendationsSilently();
      return data.collection;
    },
    [token, authHeaders, refreshRecommendationsSilently]
  );

  const handleDeleteCollection = useCallback(
    async (collectionId: string) => {
      if (!token) return;
      const res = await fetch(`/api/nas/collections/${encodeURIComponent(collectionId)}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as { collections?: NasSavedCollection[] };
        if (Array.isArray(data.collections)) {
          setSavedCollections(data.collections);
        }
      }
    },
    [token, authHeaders]
  );

  const handleRefreshStorage = async () => {
    if (!token || storageLoading) return;
    setStorageLoading(true);
    try {
      if (isLocalFallbackToken(token)) {
        const items = readLocalBridgeCatalog();
        const activeMount =
          effectiveSyncedBackendPath ||
          fallbackBuffer?.nasConnection?.backendPath ||
          matchedProvisionedEntry?.backendPath ||
          nasMountPath ||
          '/EntenCenter-Backend';
        if (activeBridgeTarget) {
          await fetchNasStorageStatsBridge(activeBridgeTarget).catch(() => null);
          const discovered = await discoverAndHydrateBackendFromNasBridge({
            target: activeBridgeTarget,
            username: fallbackBuffer?.user?.username || user?.username || 'admin',
            preferredBackendPath: activeMount,
          }).catch(() => null);
          if (discovered?.found) {
            const merged =
              Array.isArray(discovered.catalog) && discovered.catalog.length > 0
                ? upsertLocalBridgeCatalogItems(discovered.catalog)
                : items;
            setNasStorage(buildBridgeStorageStats(merged, discovered.backendPath));
            setNasCatalogCount(merged.length);
            setNasMountPath(discovered.backendPath);
            setHydratedBackendPath(discovered.backendPath);
            setStatistics(buildBridgeStatistics(merged));
            setRecommendations(buildBridgeRecommendations(merged, savedCollections));
            return;
          }
        }
        setNasStorage(buildBridgeStorageStats(items, activeMount));
        setNasCatalogCount(items.length);
        setStatistics(buildBridgeStatistics(items));
        setRecommendations(buildBridgeRecommendations(items, savedCollections));
        return;
      }
      const res = await fetch('/api/nas/storage', {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as NasStorageStats;
        setNasStorage(data);
      }
    } finally {
      setStorageLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      loadAllNasData(token);
      if (!isLocalFallbackToken(token)) {
        void refreshSharedNasCertificateFromNas().then((cert) => {
          setSharedNasCert(cert);
        });
      }
    }
  }, [token, loadAllNasData]);

  // Echtzeit-NAS-Verbindungsüberwachung (WebSocket + automatischer Polling-Fallback)
  const pollNasStatusOnce = useCallback(async (activeToken: string): Promise<boolean> => {
    const startMs = performance.now();
    try {
      const res = await fetch('/api/nas/status', {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!res.ok) {
        setNasConnStatus('offline');
        return false;
      }
      const data = (await res.json()) as {
        status?: string;
        mountPath?: string;
        catalogCount?: number;
        lastScanTimestamp?: string | null;
        assistantAvatarUrl?: string;
        smartHomeState?: SmartHomeRemoteState;
        serverTime?: string;
      };
      const rtt = Math.max(1, Math.round(performance.now() - startMs));
      setNasLatencyMs(rtt);
      setNasTransport('polling');
      setNasConnStatus(data.status === 'online' ? 'connected' : 'reconnecting');
      if (data.mountPath) setNasMountPath(data.mountPath);
      if (typeof data.catalogCount === 'number') setNasCatalogCount(data.catalogCount);
      if (data.lastScanTimestamp) setLastScanTs(data.lastScanTimestamp);
      if (data.assistantAvatarUrl) setAssistantAvatarUrl(resolveAssistantAvatarSrc(data.assistantAvatarUrl));
      if (data.smartHomeState) setSmartHomeState(data.smartHomeState);
      setNasLastHeartbeat(data.serverTime ?? new Date().toISOString());
      return true;
    } catch {
      setNasConnStatus('offline');
      return false;
    }
  }, []);

  const handleWakeNasDevice = useCallback(
    async (silent = false): Promise<boolean> => {
      const targetHost =
        effectiveBridgeHost ||
        cleanHostOnly(nasDeepDiagTarget) ||
        cleanHostOnly(getEffectiveNasOrigin()) ||
        'fritz.box';
      if (!targetHost) return false;
      if (!silent) {
        setNasWakeBusy(true);
        setNasWakeFeedback(null);
      }
      setBridgeHealthStatus('waking');
      try {
        const wakeRes = await wakeNasFromSleep({
          host: targetHost,
          username:
            fallbackFritzUser.trim() || fallbackBuffer?.nasConnection?.username || '',
          password:
            fallbackFritzPass ||
            fallbackBuffer?.nasConnection?.fritzPassword ||
            fallbackBuffer?.nasConnection?.secret ||
            fallbackBuffer?.user.password ||
            '',
          macAddress: nasMacInput.trim() || readSavedNasMacAddress(targetHost) || null,
          useTls: fallbackBuffer?.nasConnection?.useTls,
          scope: fallbackBuffer?.connectionScope === 'internet' ? 'internet' : 'lan',
        });
        if (wakeRes.discoveredMac) {
          saveNasMacAddress(targetHost, wakeRes.discoveredMac);
          setNasMacInput(wakeRes.discoveredMac);
        }
        setNasWakeFeedback(wakeRes.message);
        if (wakeRes.ok) {
          setBridgeHealthStatus('online');
          setNasConnStatus('connected');
          setNasLatencyMs(wakeRes.latencyMs ?? null);
          setBridgeTransportLabel(
            wakeRes.transportLabel ||
              (wakeRes.fritzWebReady ? 'FRITZ!NAS Direkt (Storage-Bridge)' : 'NAS Storage-Bridge')
          );
          const mount =
            fallbackBuffer?.nasConnection?.backendPath || matchedProvisionedEntry?.backendPath;
          if (mount) setNasMountPath(mount);
          setNasLastHeartbeat(new Date().toISOString());
          return true;
        }
        setBridgeHealthStatus(wakeRes.status === 'waking' ? 'waking' : 'sleeping');
        setNasConnStatus('offline');
        return false;
      } finally {
        if (!silent) {
          setNasWakeBusy(false);
        }
      }
    },
    [
      effectiveBridgeHost,
      fallbackBuffer,
      fallbackFritzPass,
      fallbackFritzUser,
      matchedProvisionedEntry?.backendPath,
      nasDeepDiagTarget,
      nasMacInput,
    ]
  );

  const probeBridgeStatusOnce = useCallback(
    async (allowAutoWake = true): Promise<boolean> => {
      const targetHost =
        effectiveBridgeHost || cleanHostOnly(nasDeepDiagTarget);
      if (!targetHost) {
        setBridgeHealthStatus('unknown');
        setNasConnStatus('offline');
        setNasLatencyMs(null);
        return false;
      }
      const health = await probeBridgeNasHealth({
        host: targetHost,
        port: fallbackBuffer?.nasConnection?.port,
        scope: fallbackBuffer?.connectionScope === 'internet' ? 'internet' : 'lan',
      }).catch(() => null);

      if (health?.discoveredMac) {
        saveNasMacAddress(targetHost, health.discoveredMac);
        setNasMacInput((prev) => prev || health.discoveredMac || '');
      }

      if (health?.ok && health.status === 'online') {
        setBridgeHealthStatus('online');
        setNasConnStatus('connected');
        setNasLatencyMs(health.latencyMs ?? null);
        setBridgeTransportLabel(
          health.transportLabel ||
            (health.fritzDetected ? 'FRITZ!NAS Direkt (SMB :445 + Web)' : 'Storage-Bridge Direkt')
        );
        const mount =
          fallbackBuffer?.nasConnection?.backendPath || matchedProvisionedEntry?.backendPath;
        if (mount) setNasMountPath(mount);
        setNasLastHeartbeat(new Date().toISOString());
        return true;
      }

      if (allowAutoWake && Date.now() - autoWakeLastAttemptRef.current > 45000) {
        autoWakeLastAttemptRef.current = Date.now();
        const woke = await handleWakeNasDevice(true);
        if (woke) return true;
      }

      setBridgeHealthStatus('sleeping');
      setNasConnStatus('offline');
      setNasLatencyMs(null);
      return false;
    },
    [
      effectiveBridgeHost,
      fallbackBuffer?.connectionScope,
      fallbackBuffer?.nasConnection?.backendPath,
      fallbackBuffer?.nasConnection?.port,
      handleWakeNasDevice,
      matchedProvisionedEntry?.backendPath,
      nasDeepDiagTarget,
    ]
  );

  useEffect(() => {
    if (!token) {
      wsRef.current?.close();
      wsRef.current = null;
      setNasConnStatus('offline');
      setNasLatencyMs(null);
      return;
    }

    if (isLocalFallbackToken(token)) {
      wsRef.current?.close();
      wsRef.current = null;
      const knownMount =
        fallbackBuffer?.nasConnection?.backendPath || matchedProvisionedEntry?.backendPath;
      if (knownMount) {
        setNasMountPath(knownMount);
      }
      if (!effectiveBridgeHost) {
        setNasConnStatus('offline');
        setNasLatencyMs(null);
        return;
      }
      let disposedBridge = false;
      const runCheck = () => {
        if (!disposedBridge && document.visibilityState !== 'hidden') {
          void probeBridgeStatusOnce(true);
        }
      };
      runCheck();
      const timer = window.setInterval(runCheck, 25000);
      document.addEventListener('visibilitychange', runCheck);
      return () => {
        disposedBridge = true;
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', runCheck);
      };
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let pollingTimer: number | null = null;
    let retryAttempt = 0;

    const clearTimers = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pollingTimer !== null) {
        window.clearInterval(pollingTimer);
        pollingTimer = null;
      }
    };

    const startPollingFallback = () => {
      if (disposed || pollingTimer !== null) return;
      if (document.visibilityState !== 'hidden') {
        void pollNasStatusOnce(token);
      }
      pollingTimer = window.setInterval(() => {
        if (!disposed && document.visibilityState !== 'hidden') {
          void pollNasStatusOnce(token);
        }
      }, 20000);
    };

    const connectWebSocket = () => {
      if (disposed) return;
      setNasConnStatus((prev) => (prev === 'connected' ? 'connected' : 'connecting'));

      const wsUrl = resolveNasWsUrl(`/ws/nas-status?token=${encodeURIComponent(token)}`);

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        startPollingFallback();
        return;
      }
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
        retryAttempt = 0;
        if (pollingTimer !== null) {
          window.clearInterval(pollingTimer);
          pollingTimer = null;
        }
        setNasTransport('websocket');
        setNasConnStatus('connected');

        const sendPing = () => {
          if (
            document.visibilityState !== 'hidden' &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));
          }
        };

        sendPing();
        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(sendPing, 25000);
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            clientTs?: number;
            status?: string;
            mountPath?: string;
            catalogCount?: number;
            lastScanTimestamp?: string | null;
            assistantAvatarUrl?: string;
            smartHomeState?: SmartHomeRemoteState;
            remoteState?: SmartHomeRemoteState;
            serverTime?: string;
          };

          if (msg.type === 'smarthome:state' && msg.remoteState) {
            setSmartHomeState(msg.remoteState);
            return;
          }
          if (msg.smartHomeState) {
            setSmartHomeState(msg.smartHomeState);
          }
          if (msg.type === 'pong' && typeof msg.clientTs === 'number') {
            setNasLatencyMs(Math.max(1, Math.round(performance.now() - msg.clientTs)));
          }
          setNasTransport('websocket');
          if (msg.status) {
            setNasConnStatus(msg.status === 'online' ? 'connected' : 'reconnecting');
          }
          if (msg.mountPath) setNasMountPath(msg.mountPath);
          if (typeof msg.catalogCount === 'number') setNasCatalogCount(msg.catalogCount);
          if (msg.lastScanTimestamp) setLastScanTs(msg.lastScanTimestamp);
          if (msg.assistantAvatarUrl) setAssistantAvatarUrl(resolveAssistantAvatarSrc(msg.assistantAvatarUrl));
          setNasLastHeartbeat(msg.serverTime ?? new Date().toISOString());

          if (
            msg.type === 'nas:notifications_updated' ||
            msg.type === 'nas:scan_completed'
          ) {
            void fetch('/api/nas/notifications', {
              headers: { Authorization: `Bearer ${token}` },
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((data: { alerts?: NasNotification[] } | null) => {
                if (data && Array.isArray(data.alerts)) {
                  setNotifications(data.alerts);
                }
              })
              .catch(() => {});
          }

          if (msg.type === 'nas:security_certificate_updated') {
            void refreshSharedNasCertificateFromNas().then((cert) => {
              setSharedNasCert(cert);
            });
          }

          if (msg.type === 'nas:cloud_vault_updated' && user?.role === 'admin') {
            void import('./lib/googleDriveBackup')
              .then(
                async ({
                  clearInMemoryDriveToken,
                  getInMemoryDriveToken,
                  GoogleDriveAuthExpiredError,
                  uploadEncryptedCloudVaultFile,
                }) => {
                  const driveToken = getInMemoryDriveToken();
                  if (!driveToken) return;
                  try {
                    const r = await fetch('/api/nas/admin/user-storage/cloud-envelope', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    const data = r.ok
                      ? ((await r.json()) as {
                          config?: UserDataStorageConfig;
                          envelope?: EncryptedCloudVaultEnvelope;
                        })
                      : null;
                    if (
                      data?.config?.mode === 'cloud' &&
                      data.config.cloudProvider === 'google_drive' &&
                      data.config.cloudRemoteFileId &&
                      data.envelope
                    ) {
                      const uploaded = await uploadEncryptedCloudVaultFile(
                        driveToken,
                        data.envelope,
                        data.config.cloudRemoteFileId
                      );
                      await fetch('/api/nas/admin/user-storage/cloud-sync-ack', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                          cloudRemoteFileId: uploaded.id,
                          encryptedAt: data.envelope.encryptedAt,
                        }),
                      });
                    }
                  } catch (err) {
                    if (err instanceof GoogleDriveAuthExpiredError) {
                      clearInMemoryDriveToken();
                    }
                  }
                }
              )
              .catch(() => {});
          }
        } catch {
          // Ungültige Nachricht ignorieren
        }
      };

      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (disposed) return;

        setNasConnStatus('reconnecting');
        startPollingFallback();

        const delayMs = Math.min(30000, 3000 * Math.pow(2, retryAttempt));
        retryAttempt += 1;
        reconnectTimer = window.setTimeout(() => {
          if (!disposed && document.visibilityState !== 'hidden') {
            connectWebSocket();
          }
        }, delayMs);
      };

      socket.onerror = () => {
        // onclose kümmert sich um Fallback und Reconnect
      };
    };

    const handleVisibilityChange = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      const activeSocket = wsRef.current;
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));
      } else {
        if (pollingTimer !== null) {
          void pollNasStatusOnce(token);
        }
        if (!activeSocket || activeSocket.readyState === WebSocket.CLOSED) {
          retryAttempt = 0;
          connectWebSocket();
        }
      }
    };

    connectWebSocket();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, pollNasStatusOnce]);

  // Eingehende Smart-Home-Befehle (Google Home / Alexa) auf aktive App-Wiedergabe anwenden
  useEffect(() => {
    if (!smartHomeState) return;
    if (lastSmartHomeSeqRef.current === null) {
      lastSmartHomeSeqRef.current = smartHomeState.commandSeq;
      return;
    }
    if (smartHomeState.commandSeq === lastSmartHomeSeqRef.current) return;
    lastSmartHomeSeqRef.current = smartHomeState.commandSeq;

    if (!smartHomeState.powerOn) {
      setActivePlayerItem(null);
      return;
    }

    if (smartHomeState.activeMediaId && smartHomeState.playbackState === 'PLAYING') {
      const target = libraryItems.find((item) => item.id === smartHomeState.activeMediaId);
      if (target) {
        setActivePlayerItem((prev) => (prev?.id === target.id ? prev : target));
      }
    }
  }, [smartHomeState, libraryItems]);

  const handleManualStatusCheck = async () => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      await probeBridgeStatusOnce(true);
      await handleSyncFallbackBufferToNas(false);
      return;
    }
    const activeSocket = wsRef.current;
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));
    } else {
      await pollNasStatusOnce(token);
    }
  };

  const handleRunDeepNetworkDiagnostics = useCallback(
    async (overrideTarget?: string) => {
      if (nasDeepDiagLoading) return;
      const effectiveTarget = (
        overrideTarget ??
        (nasDeepDiagTarget.trim() || fallbackServerInput.trim() || getEffectiveNasOrigin())
      ).trim();

      setNasDeepDiagLoading(true);
      setNasDeepDiagError(null);
      try {
        const res = await runDeepNetworkDiagnostics({
          targetUrl: effectiveTarget,
          authToken: token,
          bridgeContext:
            isBridgeActive || isNasStorageSynced
              ? {
                  active: isNasStorageSynced || isBridgeActive,
                  synced: isNasStorageSynced,
                  backendPath: effectiveSyncedBackendPath,
                  host: effectiveBridgeHost || undefined,
                  transportLabel:
                    fallbackBuffer?.nasConnection?.protocol === 'fritz_upnp'
                      ? 'FRITZ!NAS / SMB2 (:445 + Web)'
                      : fallbackBuffer?.nasConnection?.protocol
                        ? `${fallbackBuffer.nasConnection.protocol.toUpperCase()} Storage-Bridge`
                        : undefined,
                }
              : undefined,
        });
        setNasDeepDiagResult(res);
      } catch (err) {
        setNasDeepDiagError(
          err instanceof Error
            ? err.message
            : 'Tiefergehende Netzwerkanalyse konnte nicht durchgeführt werden.'
        );
      } finally {
        setNasDeepDiagLoading(false);
      }
    },
    [
      effectiveBridgeHost,
      effectiveSyncedBackendPath,
      fallbackBuffer?.nasConnection?.protocol,
      fallbackServerInput,
      isBridgeActive,
      isNasStorageSynced,
      matchedProvisionedEntry?.protocol,
      nasDeepDiagLoading,
      nasDeepDiagTarget,
      token,
    ]
  );

  const handleRunAppPortScan = useCallback(
    async (overrideTarget?: string) => {
      if (appPortScanBusy) return;
      const effectiveTarget = (
        overrideTarget ??
        (nasDeepDiagTarget.trim() || fallbackServerInput.trim() || getEffectiveNasOrigin())
      ).trim();
      setAppPortScanBusy(true);
      setNasDeepDiagError(null);
      try {
        const res = await scanAlternativeNasPorts(effectiveTarget, {
          preferredAltPort: appPreferredAltPort,
          authToken: token,
        });
        setAppPortScanResult(res);
        if (res.recommendedPort && res.recommendedPort !== 3000) {
          setAppPreferredAltPort(res.recommendedPort);
          setPreferredAlternativePort(res.recommendedPort);
        }
      } catch (err) {
        setNasDeepDiagError(
          err instanceof Error
            ? err.message
            : 'Automatischer Port-Scan konnte nicht ausgeführt werden.'
        );
      } finally {
        setAppPortScanBusy(false);
      }
    },
    [appPortScanBusy, appPreferredAltPort, fallbackServerInput, nasDeepDiagTarget, token]
  );

  const handleAdoptAppScannedUrl = useCallback(
    (url: string, portNum?: number) => {
      const normalized = normalizeNasBaseUrl(url) || url;
      setNasBaseUrl(normalized);
      setFallbackServerInput(normalized);
      setNasDeepDiagTarget(normalized);
      if (portNum && portNum !== 3000) {
        setAppPreferredAltPort(portNum);
        setPreferredAlternativePort(portNum);
      }
      const current = fallbackBuffer ?? readLocalOnboardingBuffer();
      if (current) {
        const updated: LocalOnboardingBuffer = {
          ...current,
          serverUrl: normalized,
          connectionScope: isLocalOrLanHost(normalized) ? 'lan' : 'internet',
          updatedAt: new Date().toISOString(),
        };
        writeLocalOnboardingBuffer(updated);
        setFallbackBuffer(updated);
      }
      setFallbackSyncError(null);
      setFallbackSyncNotice(`Neuer NAS-Endpunkt übernommen: ${normalized}`);
    },
    [fallbackBuffer]
  );

  useEffect(() => {
    if (!token || isLocalFallbackToken(token)) return;
    let cancelled = false;
    fetch('/api/nas/session', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { user: NasUser };
          setUser(data.user);
          persistStoredSession(token, data.user);
        } else if (res.status === 401 || res.status === 404) {
          clearStoredSession();
          setToken(null);
          setUser(null);
        }
      })
      .catch(() => {
        // Bei Netzwerk-/Server-Ausfall angemeldet bleiben (keine automatische Abmeldung)
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSyncFallbackBufferToNas = useCallback(
    async (silent = false) => {
      const current = fallbackBuffer ?? readLocalOnboardingBuffer();
      if (!current || fallbackSyncBusy) return;
      if (!silent) {
        setFallbackSyncError(null);
        setFallbackDiagnosis(null);
      }
      setFallbackSyncBusy(true);
      try {
        const res = await testAndTransferLocalBufferToNas({
          buffer: current,
          overrideServerUrl: fallbackServerInput.trim() || current.serverUrl,
          overrideFritzCreds: {
            username: fallbackFritzUser.trim() || undefined,
            password: fallbackFritzPass || undefined,
          },
        });
        if (res.ok && res.token && res.user) {
          persistStoredSession(res.token, res.user);
          setToken(res.token);
          setUser(res.user);
          setFallbackDiagnosis(null);
          if (!isLocalFallbackToken(res.token)) {
            setFallbackSyncError(null);
            setFallbackBuffer(null);
            setFallbackSyncNotice(
              'NAS-Verbindung erfolgreich! Lokale Daten wurden übertragen und der Initial-Puffer automatisch gelöscht.'
            );
          } else {
            const refreshedBuf = readLocalOnboardingBuffer();
            if (refreshedBuf) setFallbackBuffer(refreshedBuf);
            setBridgeHealthStatus('online');
            setNasConnStatus('connected');
            if (typeof res.latencyMs === 'number') {
              setNasLatencyMs(res.latencyMs);
            }
            if (res.bridgeTransportLabel) {
              setBridgeTransportLabel(res.bridgeTransportLabel);
            }
            const mount =
              res.syncedBackendPath ||
              refreshedBuf?.syncedBackendPath ||
              refreshedBuf?.nasConnection?.backendPath ||
              matchedProvisionedEntry?.backendPath ||
              '/EntenCenter-Backend';
            setNasMountPath(mount);
            setHydratedBackendPath(mount);
            setNasLastHeartbeat(new Date().toISOString());
            if (res.remoteWriteVerified) {
              setFallbackSyncError(null);
              setFallbackCardExpanded(false);
              setManualSetupReopen(false);
              setSetupChecklistMissing([]);
              setFallbackSyncNotice(
                refreshedBuf?.setupCompleted
                  ? `Einrichtung abgeschlossen & abgeglichen (${mount} · ${res.resolvedServerUrl ?? effectiveBridgeHost}).`
                  : res.alreadySyncedOnNas
                    ? `NAS-Backend unter ${mount} erkannt & abgeglichen (${res.transferredFilesCount ?? 0} Dateien verifiziert · ${res.resolvedServerUrl ?? effectiveBridgeHost}).`
                    : `${res.wokeUp ? 'NAS geweckt & ' : ''}Daten erfolgreich auf das NAS übertragen (${res.transferredFilesCount ?? 0} Dateien unter ${mount} verifiziert · ${res.resolvedServerUrl ?? effectiveBridgeHost}).`
              );
              if (refreshedBuf) {
                void loadAllNasData(res.token);
              }
            } else {
              setFallbackSyncError(
                res.remoteWriteWarning ||
                  'FRITZ!NAS ist erreichbar, aber das Schreiben der Dateien wurde abgelehnt. Bitte Schreibrechte im FRITZ!Box-Benutzer & SMB2 prüfen.'
              );
              setFallbackSyncNotice(
                `NAS erreichbar (${res.resolvedServerUrl ?? effectiveBridgeHost}${typeof res.latencyMs === 'number' ? ` · ${res.latencyMs} ms` : ''}), Dateischreiben noch ausstehend.`
              );
            }
          }
          return;
        }
        if (res.diagnosis) {
          setFallbackDiagnosis(res.diagnosis);
          const diagHost = res.diagnosis.resolvedIp || res.diagnosis.host;
          if (!silent && (res.diagnosis.detectedPureNas || res.diagnosis.detectedFritzBox)) {
            setFallbackSyncError(null);
            setFallbackSyncNotice(
              `Speicher-NAS unter ${diagHost} aktiv (kein :3000 EntenCenter-Backend gefunden). Die Verbindung bleibt erhalten — wähle oder erstelle jetzt den Backend-Pfad in der NAS-Dateistruktur.`
            );
            const alreadyProvisioned = Boolean(
              current.nasConnection?.backendProvisioned || matchedProvisionedEntry
            );
            if (diagHost && !alreadyProvisioned && !autoOpenedAppProvisionRef.current.has(diagHost)) {
              autoOpenedAppProvisionRef.current.add(diagHost);
              const firstSvc = res.diagnosis.openNasServices?.[0];
              const targetProto =
                firstSvc?.protocol ||
                (res.diagnosis.detectedFritzBox ? 'fritz_upnp' : current.nasConnection?.protocol || 'smb');
              const targetUseTls =
                targetProto === 'smb'
                  ? false
                  : firstSvc?.scheme === 'https' ||
                    (!res.diagnosis.fritzBoxInfo?.httpAvailable &&
                      (res.diagnosis.fritzBoxInfo?.httpsAvailable || Boolean(current.nasConnection?.useTls)));
              setProvisionDialogTarget({
                host: diagHost,
                protocol: targetProto,
                port: String(
                  sanitizeNasPortForProtocol(
                    targetProto,
                    firstSvc?.port ||
                      current.nasConnection?.port ||
                      (res.diagnosis.fritzBoxInfo?.httpAvailable ? '80' : '443'),
                    targetUseTls
                  )
                ),
                useTls: targetUseTls,
                username: fallbackFritzUser.trim() || current.nasConnection?.username || '',
                secret: current.nasConnection?.secret || fallbackFritzPass || '',
                fritzPassword:
                  fallbackFritzPass ||
                  current.nasConnection?.fritzPassword ||
                  current.nasConnection?.secret ||
                  undefined,
                requiresAuth: Boolean(
                  res.diagnosis.fritzBoxInfo?.requiresAuth || res.diagnosis.detectedFritzBox
                ),
                shareOrPath:
                  current.nasConnection?.backendPath ||
                  current.nasConnection?.shareOrPath ||
                  (res.diagnosis.detectedFritzBox ? '/FRITZ' : '/'),
                friendlyName:
                  res.diagnosis.fritzBoxInfo?.friendlyName ||
                  (res.diagnosis.detectedFritzBox ? `FRITZ!NAS (${diagHost})` : `NAS (${diagHost})`),
                serverBaseUrl:
                  fallbackServerInput.trim() || current.serverUrl || normalizeNasBaseUrl(diagHost) || '',
              });
              setProvisionDialogOpen(true);
            }
            return;
          }
        }
        const refreshed = readLocalOnboardingBuffer();
        if (refreshed) {
          setFallbackBuffer(refreshed);
        }
        if (!silent) {
          setFallbackSyncError(res.error || 'NAS-Server noch nicht erreichbar.');
        }
      } finally {
        setFallbackSyncBusy(false);
      }
    },
    [fallbackBuffer, fallbackFritzPass, fallbackFritzUser, fallbackServerInput, fallbackSyncBusy]
  );

  const openAppProvisionDialog = useCallback(
    (overrides?: Partial<NasBackendProvisionTarget>) => {
      const current = fallbackBuffer ?? readLocalOnboardingBuffer();
      const rawHost =
        overrides?.host ||
        fallbackDiagnosis?.resolvedIp ||
        fallbackDiagnosis?.host ||
        current?.nasConnection?.host ||
        fallbackServerInput.trim() ||
        current?.serverUrl ||
        'fritz.box';
      const cleanedHost = rawHost
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0] || 'fritz.box';
      const firstSvc = fallbackDiagnosis?.openNasServices?.[0];
      const detectedFritz = Boolean(
        fallbackDiagnosis?.detectedFritzBox ||
          fallbackDiagnosis?.fritzBoxInfo?.detected ||
          cleanedHost.toLowerCase().includes('fritz') ||
          cleanedHost.startsWith('192.168.178.')
      );
      const openProto =
        overrides?.protocol ||
        firstSvc?.protocol ||
        current?.nasConnection?.protocol ||
        (detectedFritz ? 'fritz_upnp' : 'smb');
      const openUseTls =
        openProto === 'smb'
          ? false
          : overrides?.useTls ??
            (firstSvc
              ? firstSvc.scheme === 'https'
              : fallbackDiagnosis?.fritzBoxInfo?.httpAvailable === false &&
                  fallbackDiagnosis?.fritzBoxInfo?.httpsAvailable
                ? true
                : current?.nasConnection?.useTls ?? false);
      setProvisionDialogTarget({
        host: cleanedHost,
        protocol: openProto,
        port: String(
          sanitizeNasPortForProtocol(
            openProto,
            overrides?.port ||
              firstSvc?.port ||
              current?.nasConnection?.port ||
              (detectedFritz ? (openUseTls ? '443' : '80') : '445'),
            openUseTls
          )
        ),
        useTls: openUseTls,
        username: overrides?.username ?? (fallbackFritzUser.trim() || current?.nasConnection?.username || ''),
        secret: overrides?.secret ?? (current?.nasConnection?.secret || fallbackFritzPass || ''),
        fritzPassword:
          overrides?.fritzPassword ??
          (fallbackFritzPass ||
            current?.nasConnection?.fritzPassword ||
            current?.nasConnection?.secret ||
            undefined),
        requiresAuth:
          overrides?.requiresAuth ??
          Boolean(fallbackDiagnosis?.fritzBoxInfo?.requiresAuth || detectedFritz),
        shareOrPath:
          overrides?.shareOrPath ||
          current?.nasConnection?.backendPath ||
          current?.nasConnection?.shareOrPath ||
          (detectedFritz ? '/FRITZ' : '/'),
        friendlyName:
          overrides?.friendlyName ||
          fallbackDiagnosis?.fritzBoxInfo?.friendlyName ||
          `NAS (${cleanedHost})`,
        serverBaseUrl:
          overrides?.serverBaseUrl ||
          fallbackServerInput.trim() ||
          current?.serverUrl ||
          normalizeNasBaseUrl(cleanedHost) ||
          '',
      });
      setProvisionDialogOpen(true);
    },
    [fallbackBuffer, fallbackDiagnosis, fallbackFritzPass, fallbackFritzUser, fallbackServerInput]
  );

  const handleAdoptFallbackPureNas = useCallback(
    (
      diag: NativeServerDiagnosis,
      svc: NonNullable<NativeServerDiagnosis['openNasServices']>[number]
    ) => {
      const current = fallbackBuffer ?? readLocalOnboardingBuffer();
      if (!current) return;
      const host = diag.resolvedIp || diag.host || '';
      if (!host) return;
      const adoptedUseTls =
        svc.protocol === 'smb'
          ? false
          : svc.scheme
            ? svc.scheme === 'https'
            : current.nasConnection?.useTls ?? true;
      const adoptedPort = String(
        sanitizeNasPortForProtocol(svc.protocol, svc.port, adoptedUseTls)
      );
      const nextNasConn: NasRegistrationConnectionPayload = {
        ...(current.nasConnection ?? {
          protocol: svc.protocol,
          host,
          port: adoptedPort,
          shareOrPath: svc.path || '/Medien',
          username: '',
          secret: '',
          useTls: adoptedUseTls,
        }),
        protocol: svc.protocol,
        host,
        port: adoptedPort,
        shareOrPath: svc.path || current.nasConnection?.shareOrPath || '/Medien',
        useTls: adoptedUseTls,
      };
      const updated: LocalOnboardingBuffer = {
        ...current,
        nasConnection: nextNasConn,
        updatedAt: new Date().toISOString(),
      };
      writeLocalOnboardingBuffer(updated);
      setFallbackBuffer(updated);
      setFallbackSyncError(null);
      setFallbackSyncNotice(
        `NAS-Freigabe (${svc.label} auf ${host}:${svc.port}) im Puffer gespeichert. Verbinde nun deinen EntenCenter-Server (:3000), um sie automatisch zu übertragen.`
      );
    },
    [fallbackBuffer]
  );

  const handleCompleteSetupAndExit = useCallback(
    async (forceIgnoreMissing = false) => {
      const current = fallbackBuffer ?? readLocalOnboardingBuffer();
      if (!current || setupFinishBusy) return;
      setSetupFinishBusy(true);
      setFallbackSyncError(null);
      try {
        const enteredHost =
          cleanHostOnly(fallbackServerInput) ||
          cleanHostOnly(current.nasConnection?.host) ||
          cleanHostOnly(current.serverUrl) ||
          cleanHostOnly(effectiveBridgeHost);
        const enteredUser = (fallbackFritzUser || current.nasConnection?.username || '').trim();
        const enteredPass =
          fallbackFritzPass ||
          current.nasConnection?.fritzPassword ||
          current.nasConnection?.secret ||
          '';
        const enteredDisplayName =
          (setupPromptDisplayName || current.user.displayName || current.user.username).trim();

        const patchedBuf: LocalOnboardingBuffer = {
          ...current,
          serverUrl: fallbackServerInput.trim()
            ? normalizeNasBaseUrl(fallbackServerInput) || fallbackServerInput.trim()
            : current.serverUrl,
          user: {
            ...current.user,
            displayName: enteredDisplayName || current.user.username,
          },
          nasConnection: current.nasConnection
            ? {
                ...current.nasConnection,
                host: enteredHost || current.nasConnection.host,
                username: enteredUser,
                secret: enteredPass || current.nasConnection.secret,
                fritzUsername: enteredUser,
                fritzPassword: enteredPass || current.nasConnection.fritzPassword,
              }
            : enteredHost
              ? {
                  protocol: 'fritz_upnp',
                  host: enteredHost,
                  port: '80',
                  shareOrPath: 'FRITZ.NAS',
                  username: enteredUser,
                  secret: enteredPass,
                  fritzUsername: enteredUser,
                  fritzPassword: enteredPass,
                  useTls: false,
                  storageBridgeMode: true,
                }
              : null,
          updatedAt: new Date().toISOString(),
        };
        writeLocalOnboardingBuffer(patchedBuf);
        setFallbackBuffer(patchedBuf);

        let connectionOnline =
          nasConnStatus === 'connected' || bridgeHealthStatus === 'online';
        let remoteBackendVerified = Boolean(
          hydratedBackendPath ||
            patchedBuf.nasSyncedAt ||
            patchedBuf.syncedBackendPath ||
            patchedBuf.nasConnection?.backendProvisioned
        );
        let resolvedMount =
          effectiveSyncedBackendPath ||
          patchedBuf.syncedBackendPath ||
          patchedBuf.nasConnection?.backendPath ||
          '/EntenCenter-Backend';

        if (!forceIgnoreMissing && enteredHost && enteredPass) {
          const transferRes = await testAndTransferLocalBufferToNas({
            buffer: patchedBuf,
            overrideServerUrl: fallbackServerInput.trim() || patchedBuf.serverUrl || enteredHost,
            overrideFritzCreds: {
              username: enteredUser || undefined,
              password: enteredPass,
            },
          }).catch(() => null);

          if (transferRes?.ok && transferRes.token && transferRes.user) {
            if (!isLocalFallbackToken(transferRes.token)) {
              persistStoredSession(transferRes.token, transferRes.user);
              setToken(transferRes.token);
              setUser(transferRes.user);
              setFallbackBuffer(null);
              setManualSetupReopen(false);
              setFallbackCardExpanded(false);
              setSetupChecklistMissing([]);
              setFallbackSyncNotice('Einrichtung abgeschlossen! Daten direkt aufs NAS übertragen.');
              return;
            }
            connectionOnline = true;
            if (transferRes.remoteWriteVerified) {
              remoteBackendVerified = true;
            }
            if (transferRes.syncedBackendPath) {
              resolvedMount = transferRes.syncedBackendPath;
              setHydratedBackendPath(resolvedMount);
              setNasMountPath(resolvedMount);
            }
            if (typeof transferRes.latencyMs === 'number') {
              setNasLatencyMs(transferRes.latencyMs);
            }
            setBridgeHealthStatus('online');
            setNasConnStatus('connected');
          }
        }

        const latestBuf = readLocalOnboardingBuffer() ?? patchedBuf;
        const completeness = evaluateNasSetupCompleteness({
          buffer: latestBuf,
          overrideHost: enteredHost,
          overrideUsername: enteredUser,
          overridePassword: enteredPass,
          overrideDisplayName: enteredDisplayName,
          overrideBackendPath: resolvedMount,
          connectionOnline,
          remoteBackendVerified,
        });

        if (!completeness.complete && !forceIgnoreMissing) {
          setSetupChecklistMissing(completeness.missing);
          setFallbackCardExpanded(true);
          setManualSetupReopen(true);
          setFallbackSyncError(
            `Für den Abschluss der Einrichtung fehlen noch ${completeness.missing.length} Angabe(n). Bitte unten ergänzen oder prüfen.`
          );
          return;
        }

        const done = await markNasSetupCompleted({
          buffer: latestBuf,
          backendPath: completeness.resolvedBackendPath || resolvedMount,
          host: completeness.resolvedHost || enteredHost,
          username: enteredUser,
          password: enteredPass,
          displayName: enteredDisplayName,
          autoCompleted: false,
        });
        if (done.buffer) {
          setFallbackBuffer(done.buffer);
          const nextUser = toNasUserFromBuffer(done.buffer);
          setUser(nextUser);
          persistStoredSession(done.buffer.localToken, nextUser);
        }
        setSetupChecklistMissing([]);
        setFallbackSyncError(null);
        setFallbackCardExpanded(false);
        setManualSetupReopen(false);
        setFallbackSyncNotice(
          `Einrichtung abgeschlossen & Bridge-Modus beendet (${completeness.resolvedHost || enteredHost} · ${completeness.resolvedBackendPath || resolvedMount}).`
        );
      } finally {
        setSetupFinishBusy(false);
      }
    },
    [
      bridgeHealthStatus,
      effectiveBridgeHost,
      effectiveSyncedBackendPath,
      fallbackBuffer,
      fallbackFritzPass,
      fallbackFritzUser,
      fallbackServerInput,
      hydratedBackendPath,
      nasConnStatus,
      setupFinishBusy,
      setupPromptDisplayName,
    ]
  );

  // Automatisierter Abschluss sobald FRITZ!NAS online + EntenCenter-Backend verifiziert + Zugangsdaten vorhanden sind
  useEffect(() => {
    if (!isFallbackMode || isSetupCompleted || !fallbackBuffer) return;
    const connectionOnline = nasConnStatus === 'connected' || bridgeHealthStatus === 'online';
    const backendVerified = Boolean(
      hydratedBackendPath ||
        (fallbackBuffer.nasSyncedAt &&
          (fallbackBuffer.syncedBackendPath || fallbackBuffer.nasConnection?.backendPath))
    );
    if (!connectionOnline || !backendVerified) return;
    const completeness = evaluateNasSetupCompleteness({
      buffer: fallbackBuffer,
      overrideHost: effectiveBridgeHost,
      overrideUsername: fallbackFritzUser,
      overridePassword: fallbackFritzPass,
      overrideBackendPath: effectiveSyncedBackendPath || undefined,
      connectionOnline,
      remoteBackendVerified: backendVerified,
    });
    if (!completeness.complete) return;
    let cancelled = false;
    void markNasSetupCompleted({
      buffer: fallbackBuffer,
      backendPath: completeness.resolvedBackendPath,
      host: completeness.resolvedHost,
      username: fallbackFritzUser.trim() || fallbackBuffer.nasConnection?.username,
      password:
        fallbackFritzPass ||
        fallbackBuffer.nasConnection?.fritzPassword ||
        fallbackBuffer.nasConnection?.secret,
      autoCompleted: true,
    }).then((done) => {
      if (cancelled || !done.buffer) return;
      setFallbackBuffer(done.buffer);
      setFallbackCardExpanded(false);
      setManualSetupReopen(false);
      setSetupChecklistMissing([]);
      setFallbackSyncError(null);
      setFallbackSyncNotice(
        `Einrichtung automatisch abgeschlossen & Bridge-Modus beendet (${completeness.resolvedHost} · ${completeness.resolvedBackendPath}).`
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    bridgeHealthStatus,
    effectiveBridgeHost,
    effectiveSyncedBackendPath,
    fallbackBuffer,
    fallbackFritzPass,
    fallbackFritzUser,
    hydratedBackendPath,
    isFallbackMode,
    isSetupCompleted,
    nasConnStatus,
  ]);

  // Automatisierter Background-Check im lokalen Fallback-Modus (nur solange Daten noch nicht aufs NAS übertragen wurden)
  useEffect(() => {
    if (!isFallbackMode || isSetupCompleted || !fallbackAutoCheck || !fallbackBuffer || isNasStorageSynced) return;
    const effectiveTarget = (fallbackServerInput.trim() || fallbackBuffer.serverUrl).trim();
    if (isNativeAndroidShell() && !effectiveTarget) {
      return;
    }
    const timerId = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !fallbackSyncBusy) {
        void handleSyncFallbackBufferToNas(true);
      }
    }, 10000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [
    fallbackAutoCheck,
    fallbackBuffer,
    fallbackServerInput,
    fallbackSyncBusy,
    handleSyncFallbackBufferToNas,
    isFallbackMode,
    isNasStorageSynced,
    isSetupCompleted,
  ]);

  const handleAuthenticated = (newToken: string, loggedInUser: NasUser) => {
    autoScannedSessionRef.current = false;
    try {
      window.sessionStorage.removeItem('entencenter_manual_logout');
    } catch {
      // Speicherfehler ignorieren
    }
    if (isLocalFallbackToken(newToken)) {
      const currentBuf = readLocalOnboardingBuffer();
      setFallbackBuffer(currentBuf);
      setFallbackServerInput(currentBuf?.serverUrl ?? '');
      setFallbackAutoCheck(currentBuf?.autoBackgroundCheck ?? true);
      setFallbackSyncError(null);
    } else {
      setFallbackBuffer(null);
      setFallbackSyncError(null);
    }
    persistStoredSession(newToken, loggedInUser);
    setToken(newToken);
    setUser(loggedInUser);
    setSection('library');
    setHomeResetSignal((n) => n + 1);
    scrollViewportToTop();
  };

  const handleManualLogout = () => {
    autoScannedSessionRef.current = false;
    try {
      window.sessionStorage.setItem('entencenter_manual_logout', '1');
    } catch {
      // Speicherfehler ignorieren
    }
    clearStoredSession();
    setToken(null);
    setUser(null);
    setSection('library');
    setHomeResetSignal((n) => n + 1);
    setLibraryItems([]);
    setCalendarReleases([]);
    setFilmStarts([]);
    setFilmStartSources([]);
    setFilmStartsLastFetchedAt(null);
    setFilmStartsWarning(null);
    setNotifications([]);
    setStatistics(null);
    setRecommendations(null);
    setSavedCollections([]);
    setActivePlayerItem(null);
    setNotificationsOpen(false);
    setNasStatusMenuOpen(false);
    setAssistantAvatarUrl(DEFAULT_ASSISTANT_AVATAR_URL);
  };

  const handleSyncProgress = async (
    mediaId: string,
    watchedMinutes: number,
    incrementEpisode = false
  ) => {
    if (!token) return;
    const syncedItem = activePlayerItem?.id === mediaId ? activePlayerItem : undefined;
    const activeEp = syncedItem?.currentEpisode;
    const syncedNasPath = syncedItem?.nasPath;
    if (isLocalFallbackToken(token)) {
      const nowIso = new Date().toISOString();
      const updatedCatalog = readLocalBridgeCatalog().map((item) => {
        if (item.id !== mediaId) return item;
        const nextEpCount = incrementEpisode
          ? (item.episodesWatchedCount ?? 0) + 1
          : item.episodesWatchedCount;
        return {
          ...item,
          watchedMinutes,
          episodesWatchedCount: nextEpCount,
          lastWatchedAt: nowIso,
          watchedWithoutDate: false,
          currentEpisode:
            incrementEpisode && item.currentEpisode
              ? { ...item.currentEpisode, episode: item.currentEpisode.episode + 1 }
              : item.currentEpisode,
        };
      });
      const cleanCatalog = stripEphemeralMediaUrlForCatalog(updatedCatalog);
      saveLocalBridgeCatalog(cleanCatalog);
      setLibraryItems((prev) =>
        prev.map((item) =>
          item.id === mediaId
            ? {
                ...item,
                watchedMinutes,
                episodesWatchedCount: incrementEpisode
                  ? (item.episodesWatchedCount ?? 0) + 1
                  : item.episodesWatchedCount,
                lastWatchedAt: nowIso,
                watchedWithoutDate: false,
              }
            : item
        )
      );
      setStatistics(buildBridgeStatistics(updatedCatalog));
      setRecommendations(buildBridgeRecommendations(updatedCatalog, savedCollections));
      setActivePlayerItem((prev) => {
        if (!prev || prev.id !== mediaId || (syncedNasPath && prev.nasPath !== syncedNasPath)) {
          return prev;
        }
        return {
          ...prev,
          watchedMinutes,
          currentEpisode:
            incrementEpisode && prev.currentEpisode
              ? { ...prev.currentEpisode, episode: prev.currentEpisode.episode + 1 }
              : prev.currentEpisode,
        };
      });
      if (activeBridgeTarget) {
        const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
          /\/+$/,
          ''
        );
        void writeFileToNasBridge({
          ...activeBridgeTarget,
          targetPath: `${backendRoot}/config/catalog.json`,
          content: JSON.stringify(cleanCatalog, null, 2),
          contentType: 'application/json; charset=utf-8',
        }).catch(() => null);
        void writeFileToNasBridge({
          ...activeBridgeTarget,
          targetPath: `${backendRoot}/wal/watch-state.json`,
          content: JSON.stringify(
            {
              mediaId,
              watchedMinutes,
              incrementEpisode,
              season: activeEp?.season,
              episode: activeEp?.episode,
              updatedAt: nowIso,
            },
            null,
            2
          ),
          contentType: 'application/json; charset=utf-8',
        }).catch(() => null);
      }
      return;
    }
    const res = await fetch('/api/nas/watch-state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        mediaId,
        watchedMinutes,
        incrementEpisode,
        season: activeEp?.season,
        episode: activeEp?.episode,
        episodeTitle: activeEp?.title,
      }),
    });
    if (res.ok) {
      await loadAllNasData(token);
      setActivePlayerItem((prev) => {
        if (!prev || prev.id !== mediaId || (syncedNasPath && prev.nasPath !== syncedNasPath)) {
          return prev;
        }
        return {
          ...prev,
          watchedMinutes,
          currentEpisode:
            incrementEpisode && prev.currentEpisode
              ? { ...prev.currentEpisode, episode: prev.currentEpisode.episode + 1 }
              : prev.currentEpisode,
        };
      });
    }
  };

  const handleMarkWatchedState = useCallback(
    async (
      mediaId: string,
      scope: 'item' | 'episode',
      watched: boolean,
      episode?: { season: number; episode: number },
      options?: MarkWatchedDateOptions
    ) => {
      if (!token) return;
      if (isLocalFallbackToken(token)) {
        const isWithoutDate =
          options?.dateMode === 'without_date' || options?.watchedAt === null;
        const resolvedIso = isWithoutDate
          ? null
          : options?.watchedAt && !Number.isNaN(Date.parse(options.watchedAt))
            ? new Date(options.watchedAt).toISOString()
            : new Date().toISOString();

        const applyWatchedUpdate = (item: NasMediaItem): NasMediaItem => {
          if (item.id !== mediaId) return item;
          if (scope === 'episode' && episode && item.episodes && item.episodes.length > 0) {
            const nextEpisodes = item.episodes.map((ep) =>
              ep.season === episode.season && ep.episode === episode.episode
                ? { ...ep, watched }
                : ep
            );
            const watchedCount = nextEpisodes.filter((ep) => Boolean(ep.watched)).length;
            const nextUnwatched = nextEpisodes.find((ep) => !ep.watched) ?? nextEpisodes[0];
            const totalMin = Math.max(1, item.totalDurationMinutes || nextEpisodes.length * 42);
            const nextMinutes =
              watchedCount > 0
                ? Math.max(1, Math.round((watchedCount / nextEpisodes.length) * totalMin))
                : 0;
            const nextLastWatchedAt = watched
              ? resolvedIso
              : watchedCount > 0
                ? item.lastWatchedAt
                : null;
            const nextWithoutDate = watched
              ? isWithoutDate
              : watchedCount > 0
                ? Boolean(item.watchedWithoutDate && !item.lastWatchedAt)
                : false;
            return {
              ...item,
              episodes: nextEpisodes,
              episodesWatchedCount: watchedCount,
              totalEpisodes: nextEpisodes.length,
              watchedMinutes: nextMinutes,
              lastWatchedAt: nextLastWatchedAt,
              watchedWithoutDate: nextWithoutDate,
              currentEpisode: nextUnwatched
                ? {
                    season: nextUnwatched.season,
                    episode: nextUnwatched.episode,
                    title: nextUnwatched.title,
                    durationMinutes: nextUnwatched.durationMinutes,
                  }
                : item.currentEpisode,
            };
          }
          const nextMinutes = watched ? Math.max(1, item.totalDurationMinutes || 60) : 0;
          const nextEpisodes =
            item.episodes && item.episodes.length > 0
              ? item.episodes.map((ep) => ({ ...ep, watched }))
              : item.episodes;
          return {
            ...item,
            watchedMinutes: nextMinutes,
            lastWatchedAt: watched ? resolvedIso : null,
            watchedWithoutDate: watched ? isWithoutDate : false,
            episodes: nextEpisodes,
            episodesWatchedCount:
              item.kind === 'series'
                ? watched
                  ? item.totalEpisodes ?? nextEpisodes?.length ?? 1
                  : 0
                : item.episodesWatchedCount,
          };
        };

        const updatedCatalog = readLocalBridgeCatalog().map(applyWatchedUpdate);
        const cleanCatalog = stripEphemeralMediaUrlForCatalog(updatedCatalog);
        saveLocalBridgeCatalog(cleanCatalog);
        setLibraryItems((prev) => prev.map(applyWatchedUpdate));
        setStatistics(buildBridgeStatistics(updatedCatalog));
        setRecommendations(buildBridgeRecommendations(updatedCatalog, savedCollections));
        if (activeBridgeTarget) {
          const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
            /\/+$/,
            ''
          );
          void writeFileToNasBridge({
            ...activeBridgeTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
            content: JSON.stringify(cleanCatalog, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        return;
      }
      const res = await fetch('/api/nas/watch-state/mark', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          mediaId,
          scope,
          watched,
          season: episode?.season,
          episode: episode?.episode,
          watchedAt: options?.watchedAt,
          dateMode: options?.dateMode,
        }),
      });
      if (res.ok) {
        await loadAllNasData(token);
      }
    },
    [token, activeBridgeTarget, effectiveSyncedBackendPath, authHeaders, loadAllNasData]
  );

  const buildPlayableMediaItem = (
    item: NasMediaItem,
    episode?: NasSeriesEpisode
  ): NasMediaItem => {
    if (!episode) return item;
    return {
      ...item,
      nasPath: episode.nasPath,
      watchedMinutes: 0,
      totalDurationMinutes: episode.durationMinutes,
      currentEpisode: {
        season: episode.season,
        episode: episode.episode,
        title: episode.title,
        durationMinutes: episode.durationMinutes,
      },
    };
  };

  const syncActiveMediaToSmartHome = useCallback(
    async (
      mediaId: string | null,
      title: string | null,
      playbackState: 'PLAYING' | 'PAUSED' | 'IDLE'
    ) => {
      if (!token) return;
      try {
        const res = await fetch('/api/nas/smarthome/active-media', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ mediaId, title, playbackState }),
        });
        if (res.ok) {
          const data = (await res.json()) as { remoteState?: SmartHomeRemoteState };
          if (data.remoteState) {
            lastSmartHomeSeqRef.current = data.remoteState.commandSeq;
            setSmartHomeState(data.remoteState);
          }
        }
      } catch {
        // Still tolerieren
      }
    },
    [token]
  );

  const enrichPlayableItemWithStreamUrl = useCallback(
    (rawItem: NasMediaItem): NasMediaItem => {
      const resolvedUrl = resolvePlayableNasMediaUrl(rawItem, activeBridgeTarget, token);
      const inferredMime =
        rawItem.uploadedMimeType ||
        (rawItem.nasPath ? inferMimeTypeFromPath(rawItem.nasPath) : undefined);
      return {
        ...rawItem,
        uploadedMimeType: inferredMime,
        mediaUrl: resolvedUrl ?? rawItem.mediaUrl,
      };
    },
    [activeBridgeTarget, token]
  );

  const handlePlayItem = useCallback(
    (item: NasMediaItem, episode?: NasSeriesEpisode) => {
      const playable = enrichPlayableItemWithStreamUrl(buildPlayableMediaItem(item, episode));
      if (playable.kind === 'music' && preferences.audioPlayerMode === 'external') {
        setCopiedAudioPath(false);
        setExternalAudioItem(playable);
        return;
      }
      setActivePlayerItem(playable);
      void syncActiveMediaToSmartHome(playable.id, playable.title, 'PLAYING');
    },
    [enrichPlayableItemWithStreamUrl, preferences.audioPlayerMode, syncActiveMediaToSmartHome]
  );

  const handleLaunchExternalM3u = (item: NasMediaItem) => {
    if (isNativeAndroidShell() && item.mediaUrl) {
      const mime =
        item.uploadedMimeType || inferMimeTypeFromPath(item.nasPath || item.title) || 'audio/*';
      if (openNativeExternalPlayer(item.mediaUrl, mime, item.title)) {
        return;
      }
    }
    const durationSec = Math.max(60, (item.totalDurationMinutes || 3) * 60);
    const streamOrPath = item.mediaUrl || item.nasPath;
    const playlist = `#EXTM3U\n#EXTINF:${durationSec},${item.title}\n${streamOrPath}\n`;
    const blob = new Blob([playlist], { type: 'audio/x-mpegurl;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '');
    link.href = url;
    link.download = `${safeName || 'entencenter_audio'}.m3u`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCopyExternalAudioPath = async (nasPath: string) => {
    try {
      await navigator.clipboard.writeText(nasPath);
      setCopiedAudioPath(true);
      window.setTimeout(() => setCopiedAudioPath(false), 2000);
    } catch {
      // Zwischenablage ggf. eingeschränkt
    }
  };

  const handleAddToQueue = useCallback((item: NasMediaItem, episode?: NasSeriesEpisode) => {
    const playable = buildPlayableMediaItem(item, episode);
    const queueEntry: PlaybackQueueItem = {
      queueId: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      media: playable,
    };
    setPlaybackQueue((prev) => [...prev, queueEntry]);
  }, []);

  const handleRemoveFromQueue = (queueId: string) => {
    setPlaybackQueue((prev) => prev.filter((q) => q.queueId !== queueId));
  };

  const handleClearQueue = () => {
    setPlaybackQueue([]);
  };

  const handleMoveQueueItem = (queueId: string, direction: 'up' | 'down') => {
    setPlaybackQueue((prev) => {
      const idx = prev.findIndex((q) => q.queueId === queueId);
      if (idx < 0) return prev;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(idx, 1);
      copy.splice(targetIdx, 0, moved);
      return copy;
    });
  };

  const handlePlaybackEnded = () => {
    setActivePlayerItem(null);
    setSection('library');
    setHomeResetSignal((n) => n + 1);
  };

  const handlePlayNextInQueue = () => {
    setPlaybackQueue((prev) => {
      if (prev.length === 0) {
        setActivePlayerItem(null);
        setSection('library');
        setHomeResetSignal((n) => n + 1);
        return prev;
      }
      const [next, ...rest] = prev;
      setActivePlayerItem(enrichPlayableItemWithStreamUrl(next.media));
      return rest;
    });
  };

  const handlePlayQueueIndex = (index: number) => {
    setPlaybackQueue((prev) => {
      const target = prev[index];
      if (!target) return prev;
      setActivePlayerItem(enrichPlayableItemWithStreamUrl(target.media));
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleStartPlaylist = useCallback(
    (playlistItems: NasMediaItem[]) => {
      const playable = playlistItems
        .filter(
          (it) =>
            it.kind === 'movie' ||
            it.kind === 'series' ||
            it.kind === 'music' ||
            it.kind === 'video' ||
            it.kind === 'image'
        )
        .map((it) => {
          if (it.kind === 'series' && it.episodes?.length) {
            const nextUnwatched = it.episodes.find((ep) => !ep.watched) ?? it.episodes[0];
            return enrichPlayableItemWithStreamUrl(buildPlayableMediaItem(it, nextUnwatched));
          }
          return enrichPlayableItemWithStreamUrl(it);
        });
      if (playable.length === 0) return;

      if (
        playable.length === 1 &&
        playable[0].kind === 'music' &&
        preferences.audioPlayerMode === 'external'
      ) {
        setCopiedAudioPath(false);
        setExternalAudioItem(playable[0]);
        return;
      }

      const [first, ...rest] = playable;
      const timestamp = Date.now();
      setPlaybackQueue(
        rest.map((media, idx) => ({
          queueId: `q-pl-${timestamp}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          media,
        }))
      );
      setActivePlayerItem(first);
    },
    [enrichPlayableItemWithStreamUrl, preferences.audioPlayerMode]
  );

  const handleToggleWatchlist = useCallback(
    async (mediaId: string) => {
      if (!token) return;
      if (isLocalFallbackToken(token)) {
        const updatedCatalog = readLocalBridgeCatalog().map((item) =>
          item.id === mediaId ? { ...item, inWatchlist: !item.inWatchlist } : item
        );
        const cleanCatalog = stripEphemeralMediaUrlForCatalog(updatedCatalog);
        saveLocalBridgeCatalog(cleanCatalog);
        setLibraryItems((prev) =>
          prev.map((item) =>
            item.id === mediaId ? { ...item, inWatchlist: !item.inWatchlist } : item
          )
        );
        setRecommendations(buildBridgeRecommendations(cleanCatalog, savedCollections));
        if (activeBridgeTarget) {
          const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
            /\/+$/,
            ''
          );
          void writeFileToNasBridge({
            ...activeBridgeTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
            content: JSON.stringify(cleanCatalog, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        return;
      }
      setLibraryItems((prev) =>
        prev.map((item) =>
          item.id === mediaId ? { ...item, inWatchlist: !item.inWatchlist } : item
        )
      );
      try {
        const res = await fetch('/api/nas/watchlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ mediaId }),
        });
        if (res.ok) {
          const data = (await res.json()) as { watchlistIds: string[] };
          const idSet = new Set(data.watchlistIds);
          setLibraryItems((prev) =>
            prev.map((item) => ({ ...item, inWatchlist: idSet.has(item.id) }))
          );
          void refreshRecommendationsSilently();
        } else {
          await loadAllNasData(token);
        }
      } catch {
        await loadAllNasData(token);
      }
    },
    [
      token,
      activeBridgeTarget,
      effectiveSyncedBackendPath,
      authHeaders,
      refreshRecommendationsSilently,
      loadAllNasData,
    ]
  );

  const handleBatchAddWatchlist = useCallback(
    async (mediaIds: string[]): Promise<number> => {
      if (!token || mediaIds.length === 0) return 0;
      if (isLocalFallbackToken(token)) {
        const idSet = new Set(mediaIds);
        let addedCount = 0;
        const updatedCatalog = readLocalBridgeCatalog().map((item) => {
          if (!idSet.has(item.id) || item.inWatchlist) return item;
          addedCount += 1;
          return { ...item, inWatchlist: true };
        });
        const cleanCatalog = stripEphemeralMediaUrlForCatalog(updatedCatalog);
        saveLocalBridgeCatalog(cleanCatalog);
        setLibraryItems((prev) =>
          prev.map((item) => (idSet.has(item.id) ? { ...item, inWatchlist: true } : item))
        );
        if (activeBridgeTarget) {
          const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
            /\/+$/,
            ''
          );
          void writeFileToNasBridge({
            ...activeBridgeTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
            content: JSON.stringify(cleanCatalog, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        return addedCount;
      }
      const res = await fetch('/api/nas/watchlist/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ mediaIds }),
      });
      if (!res.ok) {
        throw new Error('Watchlist-Einträge konnten nicht übernommen werden.');
      }
      const data = (await res.json()) as { addedCount: number; watchlistIds: string[] };
      const idSet = new Set(data.watchlistIds);
      setLibraryItems((prev) =>
        prev.map((item) => ({ ...item, inWatchlist: idSet.has(item.id) }))
      );
      void refreshRecommendationsSilently();
      return data.addedCount;
    },
    [
      token,
      activeBridgeTarget,
      effectiveSyncedBackendPath,
      authHeaders,
      refreshRecommendationsSilently,
    ]
  );

  const handleRefreshSeriesCalendar = async () => {
    if (!token || calendarRefreshing) return;
    setCalendarRefreshing(true);
    setCalendarWarning(null);
    try {
      if (isLocalFallbackToken(token)) {
        const data = await fetchLiveSeriesCalendarBridge(
          libraryItems,
          preferences.calendarNotificationMode ?? 'favorites_all'
        );
        applySeriesCalendarPayload(data);
        return;
      }
      const res = await fetch('/api/nas/calendar/refresh', {
        method: 'POST',
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as SeriesCalendarResponse;
        applySeriesCalendarPayload(data);
      } else {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setCalendarWarning(
          errData.error || 'Serienkalender konnte nicht aus dem Internet aktualisiert werden.'
        );
      }
    } catch {
      setCalendarWarning('Netzwerkfehler beim Aktualisieren des Serienkalenders.');
    } finally {
      setCalendarRefreshing(false);
    }
  };

  const handleToggleFavorite = async (
    seriesTitle: string,
    action: 'pin' | 'mute' | 'auto'
  ) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const next = toggleSeriesFavoriteBridge(
        seriesTitle,
        action,
        libraryItems,
        preferences.calendarNotificationMode ?? 'favorites_all'
      );
      applySeriesCalendarPayload(next);
      return;
    }
    const res = await fetch('/api/nas/calendar/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ seriesTitle, action }),
    });
    if (res.ok) {
      const data = (await res.json()) as SeriesCalendarResponse;
      applySeriesCalendarPayload(data);
    }
  };

  const handleSimulateReleaseNow = async (releaseId: string) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const next = simulateSeriesReleaseBridge(
        releaseId,
        libraryItems,
        preferences.calendarNotificationMode ?? 'favorites_all'
      );
      applySeriesCalendarPayload(next);
      setNotificationsOpen(true);
      return;
    }
    const res = await fetch('/api/nas/calendar/release-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ releaseId }),
    });
    if (res.ok) {
      const data = (await res.json()) as SeriesCalendarResponse;
      applySeriesCalendarPayload(data);
      setNotificationsOpen(true);
    }
  };

  const handleSearchSeriesOnline = async (query: string): Promise<SeriesLookupCandidate[]> => {
    if (!token) return [];
    if (isLocalFallbackToken(token)) {
      return searchSeriesOnlineBridge(query);
    }
    const res = await fetch('/api/nas/calendar/search-series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || 'Online-Seriensuche fehlgeschlagen.');
    }
    const data = (await res.json()) as { candidates?: SeriesLookupCandidate[] };
    return data.candidates ?? [];
  };

  const handleAddManualSeries = async (input: ManualSeriesInput) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const next = addManualSeriesBridge(
        input,
        libraryItems,
        preferences.calendarNotificationMode ?? 'favorites_all'
      );
      applySeriesCalendarPayload(next);
      return;
    }
    const res = await fetch('/api/nas/calendar/manual-series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = (await res.json()) as SeriesCalendarResponse;
      applySeriesCalendarPayload(data);
    }
  };

  const handleDeleteManualSeries = async (releaseId: string) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const next = deleteManualSeriesBridge(
        releaseId,
        libraryItems,
        preferences.calendarNotificationMode ?? 'favorites_all'
      );
      applySeriesCalendarPayload(next);
      return;
    }
    const res = await fetch(`/api/nas/calendar/manual-series/${encodeURIComponent(releaseId)}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (res.ok) {
      const data = (await res.json()) as SeriesCalendarResponse;
      applySeriesCalendarPayload(data);
    }
  };

  const handleUpdateCalendarNotificationMode = async (mode: CalendarNotificationMode) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const updatedPrefs = { ...preferences, calendarNotificationMode: mode };
      persistStoredPreferences(updatedPrefs);
      setPreferences(updatedPrefs);
      const next = readCachedSeriesCalendarBridge(libraryItems, mode);
      applySeriesCalendarPayload(next);
      return;
    }
    const res = await fetch('/api/nas/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ calendarNotificationMode: mode }),
    });
    if (res.ok) {
      const savedPrefs = (await res.json()) as UserPreferences;
      persistStoredPreferences(savedPrefs);
      setPreferences(savedPrefs);
      const calRes = await fetch('/api/nas/calendar', { headers: authHeaders });
      if (calRes.ok) {
        const calData = (await calRes.json()) as SeriesCalendarResponse;
        applySeriesCalendarPayload(calData);
      }
    }
  };

  const handleUpdateFilmNotificationMode = async (mode: FilmNotificationMode) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const updatedPrefs = { ...preferences, filmNotificationMode: mode };
      persistStoredPreferences(updatedPrefs);
      setPreferences(updatedPrefs);
      const next = readCachedFilmstartsBridge(libraryItems, mode);
      if (next) {
        applyFilmStartsPayload(next);
      }
      return;
    }
    const res = await fetch('/api/nas/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ filmNotificationMode: mode }),
    });
    if (res.ok) {
      const savedPrefs = (await res.json()) as UserPreferences;
      persistStoredPreferences(savedPrefs);
      setPreferences(savedPrefs);
      const filmRes = await fetch('/api/nas/filmstarts', { headers: authHeaders });
      if (filmRes.ok) {
        const filmData = (await filmRes.json()) as FilmStartsResponse;
        applyFilmStartsPayload(filmData);
      }
    }
  };

  const handleRefreshFilmStarts = async () => {
    if (!token || filmStartsRefreshing) return;
    setFilmStartsRefreshing(true);
    setFilmStartsWarning(null);
    try {
      if (isLocalFallbackToken(token)) {
        const data = await fetchLiveFilmstartsBridge(
          libraryItems,
          preferences.filmNotificationMode ?? 'favorites'
        );
        applyFilmStartsPayload(data);
        return;
      }
      const res = await fetch('/api/nas/filmstarts/refresh', {
        method: 'POST',
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as FilmStartsResponse;
        applyFilmStartsPayload(data);
      } else {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setFilmStartsWarning(
          errData.error || 'Filmstarts konnten nicht aus dem Internet aktualisiert werden.'
        );
      }
    } catch {
      setFilmStartsWarning('Netzwerkfehler beim Aktualisieren der Filmstarts.');
    } finally {
      setFilmStartsRefreshing(false);
    }
  };

  const handleToggleFilmFavorite = async (
    filmTitle: string,
    action: 'pin' | 'unpin' | 'mute'
  ) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const data = toggleFilmFavoriteBridge(
        filmTitle,
        action,
        libraryItems,
        preferences.filmNotificationMode ?? 'favorites'
      );
      applyFilmStartsPayload(data);
      return;
    }
    const res = await fetch('/api/nas/filmstarts/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ filmTitle, action }),
    });
    if (res.ok) {
      const data = (await res.json()) as FilmStartsResponse;
      applyFilmStartsPayload(data);
    }
  };

  const handleSimulateFilmReleaseNow = async (filmId: string) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const data = simulateFilmReleaseBridge(
        filmId,
        libraryItems,
        preferences.filmNotificationMode ?? 'favorites'
      );
      if (data) {
        applyFilmStartsPayload(data);
        setNotificationsOpen(true);
      }
      return;
    }
    const res = await fetch('/api/nas/filmstarts/release-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ filmId }),
    });
    if (res.ok) {
      const data = (await res.json()) as FilmStartsResponse;
      applyFilmStartsPayload(data);
      setNotificationsOpen(true);
    }
  };

  const handleMarkNotificationsRead = async (notificationId?: string) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      setNotifications(markBridgeNotificationsRead(notificationId));
      return;
    }
    const res = await fetch('/api/nas/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ notificationId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { alerts: NasNotification[] };
      setNotifications(data.alerts);
    }
  };

  const handleDeleteNotification = async (notificationId: string) => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      setNotifications(deleteBridgeNotification(notificationId));
      return;
    }
    const res = await fetch(
      `/api/nas/notifications/${encodeURIComponent(notificationId)}`,
      {
        method: 'DELETE',
        headers: authHeaders,
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { alerts: NasNotification[] };
      setNotifications(data.alerts);
    }
  };

  const handleDeleteAllNotifications = async () => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      setNotifications(deleteAllBridgeNotifications());
      return;
    }
    const res = await fetch('/api/nas/notifications', {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (res.ok) {
      const data = (await res.json()) as { alerts: NasNotification[] };
      setNotifications(data.alerts);
    }
  };

  const handleDeleteNotificationsBatch = async (notificationIds: string[]) => {
    if (!token || notificationIds.length === 0) return;
    if (isLocalFallbackToken(token)) {
      setNotifications(deleteBridgeNotificationsBatch(notificationIds));
      return;
    }
    const res = await fetch('/api/nas/notifications/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ notificationIds }),
    });
    if (res.ok) {
      const data = (await res.json()) as { alerts: NasNotification[] };
      setNotifications(data.alerts);
    }
  };

  const handleUpdateSyncMode = async (nextMode: SyncMode) => {
    if (!token) return;
    setSyncMode(nextMode);
    if (isLocalFallbackToken(token)) {
      try {
        window.localStorage.setItem(BRIDGE_SYNC_MODE_KEY, nextMode);
      } catch {
        // ignore
      }
      if (activeBridgeTarget) {
        const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
          /\/+$/,
          ''
        );
        void writeFileToNasBridge({
          ...activeBridgeTarget,
          targetPath: `${backendRoot}/config/sync-mode.json`,
          content: JSON.stringify(
            { syncMode: nextMode, updatedAt: new Date().toISOString() },
            null,
            2
          ),
          contentType: 'application/json; charset=utf-8',
        }).catch(() => null);
      }
      return;
    }
    await fetch('/api/nas/sync/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ syncMode: nextMode }),
    });
  };

  const handleRunNasScan = async () => {
    if (!token || scanningNas) return;
    setScanningNas(true);
    try {
      if (isLocalFallbackToken(token)) {
        const currentBuf = fallbackBuffer ?? readLocalOnboardingBuffer();
        const conn = currentBuf?.nasConnection;
        const scanCfg = readLocalBridgeScanSettings();
        const effectivePass = fallbackFritzPass || conn?.fritzPassword || conn?.secret || '';
        const scanHost = conn?.host || effectiveBridgeHost || '';
        if (!scanHost || !effectivePass) {
          setFallbackSyncError(
            'Für den NAS-Scan werden Hostname/IP und NAS-Zugangsdaten (Benutzername/Passwort) benötigt.'
          );
          return;
        }
        const scanProto = conn?.protocol ?? matchedProvisionedEntry?.protocol ?? 'fritz_upnp';
        const scanUseTls = scanProto === 'smb' ? false : Boolean(conn?.useTls);
        const scanPort = String(
          sanitizeNasPortForProtocol(
            scanProto,
            conn?.port || (scanProto === 'smb' ? '445' : scanUseTls ? '443' : '80'),
            scanUseTls
          )
        );
        const scanTarget = {
          protocol: scanProto,
          host: scanHost,
          port: scanPort,
          shareOrPath: scanProto === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
          username: (fallbackFritzUser.trim() || conn?.username || '').trim(),
          password: effectivePass,
          secret: effectivePass,
          fritzPassword: effectivePass,
          domainOrWorkgroup: conn?.domainOrWorkgroup,
          useTls: scanUseTls,
        };
        const scanRes = await scanNasMediaFoldersBridge({
          target: scanTarget,
          scanMode: scanCfg.scanMode,
          folders: scanCfg.selectedFolders,
        });
        if (scanRes.ok) {
          const existing = readLocalBridgeCatalog().map((it) => {
            if (!it.nasPath) return it;
            const inferredMime = it.uploadedMimeType || inferMimeTypeFromPath(it.nasPath);
            const fallbackName = it.uploadedFileName || it.nasPath.split('/').pop() || undefined;
            return {
              ...it,
              uploadedFileName: fallbackName,
              uploadedMimeType: inferredMime,
            };
          });
          const knownPaths = new Set<string>();
          for (const it of existing) {
            if (it.nasPath) knownPaths.add(it.nasPath.toLowerCase());
            if (Array.isArray(it.episodes)) {
              for (const ep of it.episodes) {
                if (ep.nasPath) knownPaths.add(ep.nasPath.toLowerCase());
              }
            }
          }
          const discoveredItems: NasMediaItem[] = [];
          for (const f of scanRes.files) {
            if (knownPaths.has(f.path.toLowerCase())) continue;
            const resolvedKind = classifyMediaKind(f.name, f.dirPath, f.inferredKind);
            const coverKey: keyof typeof MARCENTE_ASSETS =
              resolvedKind === 'series'
                ? 'posterCyberBerlin'
                : resolvedKind === 'image'
                  ? 'coverNasBilder'
                  : resolvedKind === 'music'
                    ? 'coverNasMusik'
                    : resolvedKind === 'video'
                      ? 'coverNasVideo'
                      : resolvedKind === 'other'
                        ? 'coverNasSonstiges'
                        : 'posterDarkMatter';
            const mimeType = inferMimeTypeFromPath(f.name);
            const baseItem: NasMediaItem = {
              id: `nas-scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              tmdbId: Math.floor(100000 + Math.random() * 800000),
              title: f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || f.name,
              kind: resolvedKind,
              genre:
                resolvedKind === 'series'
                  ? 'Serie'
                  : resolvedKind === 'movie'
                    ? 'Film'
                    : resolvedKind === 'video'
                      ? 'Video'
                      : 'Medien',
              year: new Date().getFullYear(),
              coverUrl: MARCENTE_ASSETS[coverKey],
              synopsis: `Beim NAS-Ordnerscan in „${f.dirPath}“ entdeckt (${f.name}).`,
              codec: resolvedKind === 'image' ? 'Bild' : resolvedKind === 'music' ? 'Audio' : 'Video-Stream',
              audioTracks: resolvedKind === 'image' || resolvedKind === 'other' ? [] : ['Deutsch'],
              subtitles: [],
              totalDurationMinutes: resolvedKind === 'movie' ? 105 : 42,
              watchedMinutes: 0,
              episodesWatchedCount: 0,
              lastWatchedAt: null,
              addedAt: new Date().toISOString(),
              nasPath: f.path,
              fileFormat: f.name.split('.').pop()?.toUpperCase() || 'FILE',
              fileSize:
                f.sizeBytes > 1024 * 1024
                  ? `${(f.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                  : `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`,
              inWatchlist: false,
              fsk: 0,
              uploadedFileName: f.name,
              uploadedMimeType: mimeType,
              uploadedByteSize: f.sizeBytes > 0 ? f.sizeBytes : undefined,
            };
            discoveredItems.push(baseItem);
          }
          const groupedMerged = groupAndNormalizeNasCatalog(
            stripEphemeralMediaUrlForCatalog(
              discoveredItems.length > 0
                ? upsertLocalBridgeCatalogItems([...existing, ...discoveredItems])
                : existing
            )
          ).items;
          const enrichedScan = await enrichNasCatalogFromInternet(groupedMerged, 36).catch(() => ({
            items: groupedMerged,
            enrichedCount: 0,
            remainingCount: 0,
          }));
          const cleanMerged = groupAndNormalizeNasCatalog(
            stripEphemeralMediaUrlForCatalog(enrichedScan.items)
          ).items;
          saveLocalBridgeCatalog(cleanMerged);
          const playableList = cleanMerged.map((it) => ({
            ...it,
            mediaUrl: resolvePlayableNasMediaUrl(it, scanTarget, token) ?? it.mediaUrl,
          }));
          setLibraryItems(playableList);

          const backendRoot = (
            hydratedBackendPath ||
            currentBuf?.syncedBackendPath ||
            matchedProvisionedEntry?.backendPath ||
            conn?.backendPath ||
            '/EntenCenter-Backend'
          ).replace(/\/+$/, '');
          saveLocalBridgeVolumeStats({
            host: scanHost,
            volumeTotalBytes: scanRes.volumeTotalBytes ?? 0,
            volumeFreeBytes: scanRes.volumeFreeBytes ?? 0,
            volumeUsedBytes: scanRes.volumeUsedBytes ?? 0,
            volumeSource: scanRes.volumeSource,
            scannedTotalBytes: scanRes.scannedTotalBytes ?? 0,
            scannedFilesCount: scanRes.scannedFilesCount ?? scanRes.files.length,
            mediaBreakdown: scanRes.mediaBreakdown,
            measuredAt: new Date().toISOString(),
          });
          await writeFileToNasBridge({
            ...scanTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
            content: JSON.stringify(cleanMerged, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
          await writeFileToNasBridge({
            ...scanTarget,
            targetPath: `${backendRoot}/wal/sync-wal.json`,
            content: JSON.stringify(
              {
                lastEvent: 'nas-media-scan',
                scannedAt: new Date().toISOString(),
                scannedFolders: scanRes.scannedFolders,
                discoveredCount: discoveredItems.length,
                totalCatalogCount: cleanMerged.length,
                scannedTotalBytes: scanRes.scannedTotalBytes ?? 0,
                volumeTotalBytes: scanRes.volumeTotalBytes ?? 0,
              },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);

          setLastScanTs(new Date().toISOString());
          setNasCatalogCount(cleanMerged.length);
          setNasStorage(buildBridgeStorageStats(cleanMerged, `/${backendRoot.replace(/^\/+/, '')}`));
          setStatistics(buildBridgeStatistics(cleanMerged));
          setRecommendations(buildBridgeRecommendations(cleanMerged, savedCollections));

          // Kalender & Filmstarts NAS-Abgleich aktualisieren
          const nextCal = readCachedSeriesCalendarBridge(
            playableList,
            preferences.calendarNotificationMode ?? 'favorites_all'
          );
          if (nextCal.releases.length > 0) applySeriesCalendarPayload(nextCal);
          const nextFilms = readCachedFilmstartsBridge(
            playableList,
            preferences.filmNotificationMode ?? 'favorites'
          );
          if (nextFilms) applyFilmStartsPayload(nextFilms);

          const totalScannedBytesLabel =
            (scanRes.scannedTotalBytes ?? 0) > 1024 * 1024 * 1024
              ? ` (${((scanRes.scannedTotalBytes ?? 0) / (1024 * 1024 * 1024)).toFixed(1)} GB gesamt erfasst)`
              : '';
          setFallbackSyncError(null);
          setFallbackSyncNotice(
            discoveredItems.length > 0
              ? `NAS gescannt (${scanRes.scannedFolders.length} Ordner): ${discoveredItems.length} neue Dateien erfasst (${cleanMerged.length} gruppierte Titel)${totalScannedBytesLabel}${enrichedScan.enrichedCount > 0 ? ` · ${enrichedScan.enrichedCount} Cover/Infos geladen` : ''}.`
              : `NAS gescannt (${scanRes.scannedFolders.length} Ordner): ${cleanMerged.length} Titel abgeglichen${totalScannedBytesLabel}.`
          );

          // Restliche Titel im Hintergrund weiter mit Covern & Serieninfos anreichern
          if (enrichedScan.remainingCount > 0 && !bridgeEnrichInFlightRef.current) {
            bridgeEnrichInFlightRef.current = true;
            void (async () => {
              try {
                let working = cleanMerged;
                for (let b = 0; b < 10; b++) {
                  const nextBatch = await enrichNasCatalogFromInternet(working, 24);
                  if (nextBatch.enrichedCount > 0) {
                    working = groupAndNormalizeNasCatalog(
                      stripEphemeralMediaUrlForCatalog(nextBatch.items)
                    ).items;
                    saveLocalBridgeCatalog(working);
                    setLibraryItems(
                      working.map((it) => ({
                        ...it,
                        mediaUrl: resolvePlayableNasMediaUrl(it, scanTarget, token) ?? it.mediaUrl,
                      }))
                    );
                    if (nextBatch.remainingCount === 0 || b % 2 === 1) {
                      void writeFileToNasBridge({
                        ...scanTarget,
                        targetPath: `${backendRoot}/config/catalog.json`,
                        content: JSON.stringify(working, null, 2),
                        contentType: 'application/json; charset=utf-8',
                      }).catch(() => null);
                    }
                  }
                  if (nextBatch.enrichedCount === 0 || nextBatch.remainingCount === 0) break;
                  await new Promise((r) => window.setTimeout(r, 250));
                }
              } finally {
                bridgeEnrichInFlightRef.current = false;
              }
            })();
          }
        } else if (scanRes.error) {
          setFallbackSyncError(scanRes.error);
        }
        return;
      }

      const res = await fetch('/api/nas/sync/run', {
        method: 'POST',
        headers: authHeaders,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          lastScanTimestamp: string;
          alerts?: NasNotification[];
        };
        setLastScanTs(data.lastScanTimestamp);
        if (Array.isArray(data.alerts)) {
          setNotifications(data.alerts);
        }
        await loadAllNasData(token);
      }
    } finally {
      setScanningNas(false);
    }
  };

  const handleEnrichLibraryMetadata = useCallback(async () => {
    if (!token || enrichingMetadata) return;
    setEnrichingMetadata(true);
    try {
      if (isLocalFallbackToken(token)) {
        const currentCatalog = groupAndNormalizeNasCatalog(readLocalBridgeCatalog()).items;
        const result = await enrichNasCatalogFromInternet(currentCatalog, 36);
        if (result.enrichedCount > 0) {
          const cleanEnriched = groupAndNormalizeNasCatalog(
            stripEphemeralMediaUrlForCatalog(result.items)
          ).items;
          saveLocalBridgeCatalog(cleanEnriched);
          setLibraryItems(
            cleanEnriched.map((it) => ({
              ...it,
              mediaUrl: resolvePlayableNasMediaUrl(it, activeBridgeTarget, token) ?? it.mediaUrl,
            }))
          );
          setNasCatalogCount(cleanEnriched.length);
          if (activeBridgeTarget) {
            const backendRoot = (effectiveSyncedBackendPath || '/EntenCenter-Backend').replace(
              /\/+$/,
              ''
            );
            void writeFileToNasBridge({
              ...activeBridgeTarget,
              targetPath: `${backendRoot}/config/catalog.json`,
              content: JSON.stringify(cleanEnriched, null, 2),
              contentType: 'application/json; charset=utf-8',
            }).catch(() => null);
          }
          setFallbackSyncNotice(
            `${result.enrichedCount} Titel erfolgreich mit Online-Covern und Inhaltsinfos ergänzt.`
          );
        } else {
          setFallbackSyncNotice(
            'Alle erkannten Filme, Serien und Musiktitel besitzen bereits Cover & Inhaltsinfos.'
          );
        }
        return;
      }

      const result = await enrichNasCatalogFromInternet(libraryItems, 36);
      if (result.enrichedCount > 0) {
        setLibraryItems(result.items);
      }
    } finally {
      setEnrichingMetadata(false);
    }
  }, [
    token,
    enrichingMetadata,
    activeBridgeTarget,
    effectiveSyncedBackendPath,
    libraryItems,
  ]);

  const handleUpdateMediaMetadata = useCallback(
    async (mediaId: string, patch: Partial<NasMediaItem>) => {
      if (!token) return;
      const mergePatchSafely = (item: NasMediaItem): NasMediaItem => {
        if (item.id !== mediaId) return item;
        const {
          episodes: _ignoreEps,
          nasPath: _ignoreNasPath,
          watchedMinutes: _ignoreWatchedMin,
          episodesWatchedCount: _ignoreEpWatched,
          uploadedByteSize: _ignoreBytes,
          inWatchlist: _ignoreWatchlist,
          ...safePatch
        } = patch;
        return {
          ...item,
          ...safePatch,
        };
      };

      if (isLocalFallbackToken(token)) {
        const updatedCatalog = readLocalBridgeCatalog().map(mergePatchSafely);
        const cleanCatalog = stripEphemeralMediaUrlForCatalog(updatedCatalog);
        saveLocalBridgeCatalog(cleanCatalog);
        setLibraryItems((prev) => prev.map(mergePatchSafely));
        const activeMount =
          effectiveSyncedBackendPath ||
          fallbackBuffer?.nasConnection?.backendPath ||
          matchedProvisionedEntry?.backendPath ||
          nasMountPath ||
          '/EntenCenter-Backend';
        setNasStorage(buildBridgeStorageStats(cleanCatalog, activeMount));
        setStatistics(buildBridgeStatistics(cleanCatalog));
        setRecommendations(buildBridgeRecommendations(cleanCatalog, savedCollections));
        if (activeBridgeTarget) {
          const backendRoot = activeMount.replace(/\/+$/, '');
          void writeFileToNasBridge({
            ...activeBridgeTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
            content: JSON.stringify(cleanCatalog, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        return;
      }

      setLibraryItems((prev) => prev.map(mergePatchSafely));
      if (patch.customCoverUrl) {
        void fetch(`/api/nas/library/items/${encodeURIComponent(mediaId)}/cover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ coverUrl: patch.customCoverUrl }),
        }).catch(() => null);
      }
    },
    [
      token,
      effectiveSyncedBackendPath,
      fallbackBuffer?.nasConnection?.backendPath,
      matchedProvisionedEntry?.backendPath,
      nasMountPath,
      activeBridgeTarget,
      authHeaders,
    ]
  );

  const handleOpenCalendarSection = useCallback(() => setSection('calendar'), []);
  const handleOpenFilmStartsSection = useCallback(() => setSection('filmstarts'), []);
  const handleOpenAssistantSection = useCallback(() => setSection('chat'), []);
  const handleOpenProfileSection = useCallback(() => setSection('profile'), []);

  if (!token || !user) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  const unreadCount = notifications.filter((n) => !n.read).length;

  type NavLeafItem = {
    id: SectionId;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    adminTab?: AdminSectionTab;
  };

  type NavGroupItem = {
    id: 'calendar-group' | 'admin-group' | 'about-group';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    children: NavLeafItem[];
  };

  const navItems: Array<NavLeafItem | NavGroupItem> = [
    { id: 'library', label: 'EntenTheke', icon: Film },
    {
      id: 'calendar-group',
      label: 'Kalender',
      icon: CalendarDays,
      children: [
        { id: 'calendar', label: 'Serienkalender', icon: Tv },
        { id: 'filmstarts', label: 'Filmstarts', icon: Clapperboard },
      ],
    },
    { id: 'statistics', label: 'Statistiken', icon: BarChart3 },
    {
      id: 'notifications',
      label: 'Benachrichtigungen',
      icon: Bell,
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    { id: 'code', label: 'Code-Studio', icon: Code2 },
    { id: 'chat', label: 'Enten-Assistent', icon: MessageSquare },
    { id: 'vision', label: 'Bild-Scanner', icon: ScanSearch },
    { id: 'profile', label: 'Profil', icon: UserCog },
    ...(user.role === 'admin'
      ? [
          {
            id: 'admin-group' as const,
            label: 'Admin',
            icon: ShieldCheck,
            children: [
              { id: 'admin' as const, adminTab: 'all' as const, label: 'Alle Bereiche', icon: Layers },
              {
                id: 'admin' as const,
                adminTab: 'notifications' as const,
                label: 'Benachrichtigungen',
                icon: Bell,
              },
              {
                id: 'admin' as const,
                adminTab: 'assistant' as const,
                label: 'Enten-Assistent',
                icon: Sparkles,
              },
              {
                id: 'admin' as const,
                adminTab: 'content' as const,
                label: 'NAS-Inhalte & Upload',
                icon: HardDrive,
              },
              {
                id: 'admin' as const,
                adminTab: 'profiles' as const,
                label: 'Profile & FSK',
                icon: Users,
              },
              {
                id: 'admin' as const,
                adminTab: 'network' as const,
                label: 'Netzwerk-Konfig',
                icon: Network,
              },
              {
                id: 'admin' as const,
                adminTab: 'paths' as const,
                label: 'Pfad-Einstellungen',
                icon: FolderOpen,
              },
              {
                id: 'admin' as const,
                adminTab: 'auth' as const,
                label: 'Anmeldewege',
                icon: KeyRound,
              },
              {
                id: 'admin' as const,
                adminTab: 'storage' as const,
                label: 'Nutzerdaten & Cloud',
                icon: Database,
              },
            ],
          },
        ]
      : []),
    {
      id: 'about-group',
      label: 'Über das EntenCenter',
      icon: Info,
      children: [{ id: 'about-update', label: 'Update', icon: Download }],
    },
  ];

  const renderNavItems = (isMobile: boolean) =>
    navItems.map((item) => {
      const Icon = item.icon;
      if ('children' in item) {
        const hasActiveChild = item.children.some((child) => child.id === section);
        const isOpen =
          item.id === 'about-group'
            ? aboutMenuOpen
            : item.id === 'admin-group'
              ? adminMenuOpen
              : calendarMenuOpen;
        const toggleOpen = () => {
          if (item.id === 'about-group') {
            setAboutMenuOpen((prev) => !prev);
          } else if (item.id === 'admin-group') {
            setAdminMenuOpen((prev) => !prev);
          } else {
            setCalendarMenuOpen((prev) => !prev);
          }
        };
        return (
          <div key={item.id} className="space-y-1">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={toggleOpen}
              className={`w-full px-3.5 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between gap-2 transition-colors whitespace-nowrap ${
                hasActiveChild
                  ? 'bg-amber-400/15 text-amber-300 border border-amber-400/30'
                  : isMobile
                    ? 'text-slate-300 hover:bg-slate-800'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </span>
              {isOpen ? (
                <ChevronDown className="w-4 h-4 shrink-0 opacity-80" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 opacity-80" />
              )}
            </button>

            {isOpen && (
              <div className="pl-3 ml-3.5 border-l border-slate-800/90 space-y-1">
                {item.children.map((child) => {
                  const ChildIcon = child.icon;
                  const childActive =
                    section === child.id &&
                    (child.adminTab === undefined || adminActiveTab === child.adminTab);
                  return (
                    <button
                      key={`${child.id}-${child.adminTab ?? child.label}`}
                      type="button"
                      onClick={() => {
                        if (child.adminTab !== undefined) {
                          setAdminActiveTab(child.adminTab);
                        }
                        navigateToSection(child.id, isMobile);
                      }}
                      className={`w-full px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                        childActive
                          ? 'bg-amber-400 text-slate-950 font-semibold'
                          : isMobile
                            ? 'text-slate-300 hover:bg-slate-800'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                      }`}
                    >
                      <ChildIcon className="w-4 h-4 shrink-0" />
                      <span>{child.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      }

      const active = section === item.id;
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => navigateToSection(item.id, isMobile)}
          className={`w-full px-3.5 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between gap-2 transition-colors whitespace-nowrap ${
            active
              ? 'bg-amber-400 text-slate-950 font-semibold'
              : isMobile
                ? 'text-slate-300 hover:bg-slate-800'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
          }`}
        >
          <span className="flex items-center gap-3 min-w-0">
            <Icon className="w-4 h-4 shrink-0" />
            <span>{item.label}</span>
          </span>
          {typeof item.badge === 'number' && item.badge > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded text-[11px] font-semibold tabular-nums ${
                active
                  ? 'bg-slate-950/20 text-slate-950'
                  : 'bg-amber-400/20 text-amber-300'
              }`}
            >
              {item.badge}
            </span>
          )}
        </button>
      );
    });

  const meta = SECTION_META[section];

  return (
    <div
      className={
        activePlayerItem
          ? 'min-h-screen bg-black text-slate-100'
          : 'min-h-screen bg-[#0B0E14] text-slate-100 flex pl-[var(--app-safe-left,0px)] pr-[var(--app-safe-right,0px)] pb-[calc(var(--app-safe-bottom,0px)+var(--app-bottom-clearance,0px))]'
      }
    >
      <div className={activePlayerItem ? 'hidden' : 'contents'}>
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0F141E] border-r border-slate-800/80 pb-[calc(var(--app-safe-bottom,0px)+var(--app-bottom-clearance,0px))]">
        <div className="min-h-16 px-5 pt-[calc(0.5rem+var(--app-top-clearance,0px))] pb-2 flex items-center border-b border-slate-800/80">
          <button
            type="button"
            onClick={() => navigateToSection('library')}
            title="Zur EntenTheke (Startseite)"
            className="flex items-center gap-3 text-left rounded-lg py-1 -mx-1 px-1 hover:bg-slate-800/50 transition-colors"
          >
            <img
              src={MARCENTE_ASSETS.duckMascot}
              alt="EntenCenter Gummi-Ente"
              referrerPolicy="no-referrer"
              decoding="async"
              className="w-9 h-9 rounded-lg object-cover border border-slate-700 shrink-0"
            />
            <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
              EntenCenter
            </span>
          </button>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto" aria-label="Hauptnavigation">
          {renderNavItems(false)}
        </nav>

        {/* Benutzer & manuelle Abmeldung */}
        <div className="p-4 border-t border-slate-800/80">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setSection('profile')}
              title="Profil & Zugangsdaten bearbeiten"
              className="min-w-0 flex items-center gap-2.5 text-left rounded-lg px-2 py-1 -mx-2 hover:bg-slate-800/60 transition-colors"
            >
              {user.avatarUrl ? (
                <img
                  src={resolveNasUrl(user.avatarUrl)}
                  alt={user.displayName}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  className="w-8 h-8 rounded-full object-cover border border-slate-700 shrink-0"
                />
              ) : (
                <span
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-950 font-display text-xs font-bold shrink-0"
                  style={{ backgroundColor: user.avatarColor || '#F59E0B' }}
                >
                  {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="text-xs font-medium text-white truncate">{user.displayName}</p>
                <p className="text-[11px] text-slate-400 truncate tabular-nums">
                  @{user.username}
                  {(user.fskLimit ?? 18) < 18 ? ` · FSK ${user.fskLimit}` : ''} · Profil
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={handleManualLogout}
              title="Selbst abmelden"
              aria-label="Abmelden"
              className="p-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-72 max-w-full bg-[#0F141E] border-r border-slate-800 flex flex-col z-10 pb-[calc(var(--app-safe-bottom,0px)+var(--app-bottom-clearance,0px))]">
            <div className="min-h-16 px-5 pt-[calc(0.5rem+var(--app-top-clearance,0px))] pb-2 flex items-center justify-between border-b border-slate-800">
              <button
                type="button"
                onClick={() => navigateToSection('library', true)}
                title="Zur EntenTheke (Startseite)"
                className="flex items-center gap-3 text-left rounded-lg py-1 -mx-1 px-1 hover:bg-slate-800/50 transition-colors"
              >
                <img
                  src={MARCENTE_ASSETS.duckMascot}
                  alt="EntenCenter Gummi-Ente"
                  referrerPolicy="no-referrer"
                  decoding="async"
                  className="w-8 h-8 rounded-lg object-cover"
                />
                <span className="font-display text-lg font-bold text-white">EntenCenter</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-400 hover:text-white"
                aria-label="Menü schließen"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Mobile Navigation">
              {renderNavItems(true)}
            </nav>
            <div className="p-4 border-t border-slate-800 space-y-3">
              <button
                type="button"
                onClick={() => {
                  setSection('profile');
                  setMobileMenuOpen(false);
                }}
                className="w-full flex items-center gap-2.5 text-left rounded-lg p-1.5 hover:bg-slate-800/60 transition-colors"
              >
                {user.avatarUrl ? (
                  <img
                    src={resolveNasUrl(user.avatarUrl)}
                    alt={user.displayName}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                    className="w-8 h-8 rounded-full object-cover border border-slate-700 shrink-0"
                  />
                ) : (
                  <span
                    className="w-8 h-8 rounded-full flex items-center justify-center text-slate-950 font-display text-xs font-bold shrink-0"
                    style={{ backgroundColor: user.avatarColor || '#F59E0B' }}
                  >
                    {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-white truncate">{user.displayName}</p>
                  <p className="text-[11px] text-slate-400 truncate">@{user.username} · Profil</p>
                </div>
              </button>
              <button
                type="button"
                onClick={handleManualLogout}
                className="w-full py-2 px-3 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-medium text-slate-200 flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span>Abmelden ({user.username})</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Hauptbereich */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar (strikt 3 Zonen) */}
        <header className="min-h-16 px-4 sm:px-8 pt-[calc(0.5rem+var(--app-top-clearance,0px))] pb-2.5 border-b border-slate-800/80 bg-[#0B0E14]/95 backdrop-blur-sm sticky top-0 z-30 flex items-center justify-between gap-3 sm:gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg bg-[#121722] border border-slate-800 text-slate-200"
              aria-label="Navigation öffnen"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                {meta.title}
              </h1>
              <p className="text-xs text-slate-400 truncate hidden sm:block">
                {meta.subtitle}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Oben rechts: Echtzeit-NAS-Verbindungsstatus */}
            <div className="relative flex items-center gap-1.5">
              {/* Echtzeit-NAS-Verbindungsstatus */}
              <div className="relative">
                <button
                  type="button"
                  role="status"
                  aria-live="polite"
                  aria-expanded={nasStatusMenuOpen}
                  aria-label="NAS-Verbindungsstatus anzeigen"
                  onClick={() => {
                    setNasStatusMenuOpen((o) => !o);
                    void handleManualStatusCheck();
                  }}
                  title={`NAS-Status: ${
                    nasWakeBusy || bridgeHealthStatus === 'waking'
                      ? 'Wecke NAS aus dem Ruhemodus…'
                      : nasConnStatus === 'connected'
                        ? isFallbackMode
                          ? isSetupCompleted
                            ? 'FRITZ!NAS Direkt Online'
                            : `${bridgeTransportLabel || 'FRITZ!NAS / Storage-Bridge Online'}`
                          : `Verbunden (${nasTransport === 'websocket' ? 'WebSocket' : 'Polling'})`
                        : bridgeHealthStatus === 'sleeping'
                          ? 'NAS möglicherweise im Ruhemodus — tippen zum Aufwecken'
                          : isFallbackMode && isBridgeActive
                            ? isSetupCompleted
                              ? 'NAS Direkt bereit'
                              : 'Storage-Bridge bereit'
                            : nasConnStatus === 'offline'
                              ? 'Offline'
                              : 'Verbinde...'
                  }`}
                  className={`px-2.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border text-xs font-medium flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                    nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                      ? 'border-emerald-500/35 text-slate-200'
                      : nasWakeBusy || bridgeHealthStatus === 'waking' || bridgeHealthStatus === 'sleeping'
                        ? 'border-amber-400/45 text-amber-200'
                        : nasConnStatus === 'offline'
                          ? 'border-rose-500/45 text-rose-200'
                          : 'border-amber-400/40 text-amber-200'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                        ? 'bg-emerald-400'
                        : nasWakeBusy || bridgeHealthStatus === 'waking' || bridgeHealthStatus === 'sleeping'
                          ? 'bg-amber-400 animate-pulse'
                          : nasConnStatus === 'offline'
                            ? 'bg-rose-400'
                            : 'bg-amber-400'
                    }`}
                  />
                  {isFallbackMode && (nasConnStatus === 'connected' || bridgeHealthStatus === 'online') ? (
                    <HardDrive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : nasWakeBusy || bridgeHealthStatus === 'waking' ? (
                    <Power className="w-3.5 h-3.5 text-amber-400 animate-pulse shrink-0" />
                  ) : nasConnStatus === 'offline' ? (
                    <WifiOff className={`w-3.5 h-3.5 ${bridgeHealthStatus === 'sleeping' ? 'text-amber-400' : 'text-rose-400'} shrink-0`} />
                  ) : nasTransport === 'polling' ? (
                    <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  )}
                  <span className="hidden xl:inline">
                    {nasWakeBusy || bridgeHealthStatus === 'waking'
                      ? 'Wecke NAS…'
                      : isFallbackMode && (nasConnStatus === 'connected' || bridgeHealthStatus === 'online')
                        ? fallbackBuffer?.nasConnection?.protocol === 'fritz_upnp' ||
                          effectiveBridgeHost.includes('fritz') ||
                          effectiveBridgeHost.startsWith('192.168.178.')
                          ? 'FRITZ!NAS Online'
                          : isSetupCompleted
                            ? 'NAS Online'
                            : 'Storage-Bridge'
                        : nasConnStatus === 'connected'
                          ? nasTransport === 'websocket'
                            ? 'NAS Live'
                            : 'NAS Polling'
                          : bridgeHealthStatus === 'sleeping'
                            ? 'NAS Ruhemodus'
                            : isFallbackMode && isBridgeActive
                              ? isSetupCompleted
                                ? 'NAS Bereit'
                                : 'Bridge Bereit'
                              : nasConnStatus === 'offline'
                                ? 'NAS Offline'
                                : 'Verbinde...'}
                  </span>
                  {nasLatencyMs !== null && (nasConnStatus === 'connected' || bridgeHealthStatus === 'online') && (
                    <span className="hidden md:inline font-mono text-[11px] text-slate-400 tabular-nums">
                      {nasLatencyMs} ms
                    </span>
                  )}
                </button>
              </div>
            </div>

            {playbackQueue.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (!activePlayerItem) {
                    handlePlayNextInQueue();
                  }
                }}
                title="Warteschlange im Enten Player abspielen"
                className="px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-amber-400/50 text-xs font-medium text-amber-300 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <ListVideo className="w-4 h-4 text-amber-400" />
                <span className="hidden sm:inline">Warteschlange</span>
                <span className="font-mono tabular-nums font-semibold">
                  ({playbackQueue.length})
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setNotificationsOpen((o) => !o)}
              className="relative px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Bell className="w-4 h-4 text-amber-400" />
              <span className="hidden sm:inline">Benachrichtigungen</span>
              {unreadCount > 0 && (
                <span className="font-mono tabular-nums text-amber-400 font-semibold">
                  ({unreadCount})
                </span>
              )}
            </button>

            <LiveClockBadge variant="header" />
          </div>
        </header>

        {/* Benachrichtigungs-Panel */}
        {notificationsOpen && (
          <div className="border-b border-slate-800 bg-[#101520] px-4 sm:px-8 py-4">
            <div className="max-w-5xl mx-auto space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-sm font-semibold text-white tabular-nums">
                  Benachrichtigungen ({notifications.length})
                </h2>
                <div className="flex flex-wrap items-center gap-3">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleMarkNotificationsRead()}
                      className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      <span>Alle als gelesen markieren</span>
                    </button>
                  )}
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteAllNotifications()}
                      className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Alle löschen</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSection('notifications');
                      setNotificationsOpen(false);
                    }}
                    className="text-xs text-amber-300 hover:text-amber-200 font-medium whitespace-nowrap shrink-0"
                  >
                    Verwalten
                  </button>
                  <button
                    type="button"
                    onClick={() => setNotificationsOpen(false)}
                    className="text-xs text-slate-400 hover:text-white whitespace-nowrap shrink-0"
                  >
                    Schließen
                  </button>
                </div>
              </div>

              {notifications.length === 0 ? (
                <p className="text-xs text-slate-400">
                  Aktuell keine Benachrichtigungen vorhanden. Sobald neue Inhalte auf dem NAS hinzugefügt werden oder favorisierte Serien starten, informiert dich der Enten-Assistent hier.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`p-3.5 rounded-lg border flex items-start justify-between gap-3 ${
                        n.read
                          ? 'bg-[#0B0E14] border-slate-800/70 opacity-80'
                          : 'bg-[#121722] border-amber-400/40'
                      }`}
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <p className="text-xs font-semibold text-white truncate">
                          {n.seriesTitle}
                        </p>
                        <p className="text-xs text-slate-300 whitespace-pre-line">{n.info}</p>

                        {n.triggerType === 'duck_nas_added' &&
                          Array.isArray(n.categoryItems) &&
                          n.categoryItems.length > 0 && (
                            <div className="pt-1.5 mt-1 border-t border-slate-800/80 space-y-2">
                              {n.categoryItems.map((group) => (
                                <div key={group.kind} className="space-y-0.5">
                                  <p className="text-[11px] font-semibold text-amber-300 tabular-nums">
                                    {group.category} ({group.titles.length})
                                  </p>
                                  <ul className="text-xs text-slate-200 space-y-0.5 pl-3 list-disc marker:text-slate-500">
                                    {group.titles.map((title, idx) => (
                                      <li key={`${group.kind}-${idx}`}>{title}</li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          )}

                        <p className="text-[11px] text-slate-400">
                          {n.senderLabel ?? n.provider} · {n.releaseDate} ·{' '}
                          {n.triggerType === 'admin_broadcast'
                            ? n.messageType === 'maintenance'
                              ? 'Admin · Wartung'
                              : n.messageType === 'new_content'
                                ? 'Admin · Neue Inhalte'
                                : 'Admin · Allgemein'
                            : n.triggerType === 'duck_nas_added'
                              ? 'Neue NAS-Inhalte'
                              : n.triggerType === 'film_favorite_start'
                                ? 'Filmstart-Favorit'
                                : n.triggerType === 'auto_favorite'
                                  ? 'Auto-Favorit'
                                  : 'Manueller Favorit'}
                        </p>
                      </div>

                      <div className="flex flex-col items-end gap-2 shrink-0">
                        {!n.read && (
                          <button
                            type="button"
                            onClick={() => void handleMarkNotificationsRead(n.id)}
                            className="text-xs text-amber-400 hover:text-amber-300 whitespace-nowrap"
                          >
                            Gelesen
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteNotification(n.id)}
                          aria-label={`Benachrichtigung „${n.seriesTitle}“ löschen`}
                          className="text-xs text-slate-400 hover:text-rose-300 flex items-center gap-1 whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Löschen</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Aktiver Inhaltsbereich */}
        <main className="flex-1 px-4 sm:px-8 pt-8 pb-[calc(3rem+var(--app-bottom-clearance,0px))] max-w-7xl w-full mx-auto space-y-6">
          {fallbackSyncNotice && (
            <div
              role="status"
              className="rounded-xl bg-emerald-500/10 border border-emerald-500/40 px-4 py-3 text-xs text-emerald-200 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{fallbackSyncNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setFallbackSyncNotice(null)}
                className="text-emerald-300 hover:text-white text-[11px] font-medium shrink-0"
              >
                Schließen
              </button>
            </div>
          )}

          {showSetupBanner && isNasStorageSynced && !fallbackCardExpanded && (
            <section
              aria-label="NAS-Einrichtung bereit zum Abschluss"
              className="rounded-2xl bg-[#121722] border border-emerald-500/40 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="font-display text-xs sm:text-sm font-semibold text-white">
                  NAS / FRITZ!NAS synchronisiert ({effectiveBridgeHost || 'Direkt-Bridge'}
                  {nasLatencyMs !== null ? ` · ${nasLatencyMs} ms` : ''})
                </span>
                {effectiveSyncedBackendPath && (
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-[10px] font-mono text-emerald-300">
                    {effectiveSyncedBackendPath}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={setupFinishBusy}
                  onClick={() => void handleCompleteSetupAndExit(false)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>
                    {setupFinishBusy
                      ? 'Prüfe & schließe ab…'
                      : isSetupCompleted
                        ? 'Einrichtungs-Panel schließen'
                        : 'Profileinrichtung abschließen & beenden'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={fallbackSyncBusy}
                  onClick={() => void handleSyncFallbackBufferToNas(false)}
                  className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/40 text-[11px] font-medium text-emerald-200 flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${fallbackSyncBusy ? 'animate-spin' : ''}`} />
                  <span>Abgleichen</span>
                </button>
                <button
                  type="button"
                  onClick={() => openAppProvisionDialog()}
                  className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-sky-200 flex items-center gap-1.5 transition-colors"
                >
                  <FolderTree className="w-3 h-3 text-sky-400" />
                  <span>Dateistruktur</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFallbackCardExpanded(true)}
                  className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 transition-colors"
                >
                  Optionen
                </button>
              </div>
            </section>
          )}

          {showSetupBanner && (!isNasStorageSynced || fallbackCardExpanded) && (
            <section
              aria-label="NAS-Einrichtung und Verbindungstest"
              className={`rounded-2xl bg-[#121722] border p-4 sm:p-5 space-y-3 ${
                nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                  ? 'border-emerald-500/40'
                  : 'border-amber-400/45'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {nasConnStatus === 'connected' || bridgeHealthStatus === 'online' ? (
                      <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    <h2 className="font-display text-sm sm:text-base font-semibold text-white">
                      {nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                        ? `NAS / FRITZ!NAS aktiv & online (${effectiveBridgeHost || 'Direkt-Bridge'}${nasLatencyMs !== null ? ` · ${nasLatencyMs} ms` : ''})`
                        : fallbackBuffer?.nasConnection?.storageBridgeMode ||
                            fallbackBuffer?.nasConnection?.backendProvisioned ||
                            matchedProvisionedEntry
                          ? 'NAS-Verbindung bereit — Einrichtung prüfen & abschließen'
                          : 'Lokaler Einrichtungs- & Fallback-Modus (On-Device-Puffer)'}
                    </h2>
                    {effectiveSyncedBackendPath && (
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-[10px] font-mono text-emerald-300">
                        Backend-Pfad: {effectiveSyncedBackendPath}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-300">
                    {nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                      ? `Direkte Verbindung über ${bridgeTransportLabel || 'FRITZ!NAS / SMB2'} aktiv — kein EntenCenter-:3000-Server erforderlich. Klicke auf „Profileinrichtung abschließen & beenden“, um den Einrichtungs- und Bridge-Modus zu schließen.`
                      : 'Wenn dein NAS im Ruhemodus ist oder noch Angaben fehlen, kannst du diese hier ergänzen und danach die Einrichtung sauber abschließen.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={setupFinishBusy}
                    onClick={() => void handleCompleteSetupAndExit(false)}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {setupFinishBusy
                        ? 'Prüfe & schließe ab…'
                        : 'Profileinrichtung abschließen & beenden'}
                    </span>
                  </button>
                  {(isNasStorageSynced || isSetupCompleted) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFallbackCardExpanded(false);
                        if (isSetupCompleted) setManualSetupReopen(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/40 text-[11px] text-emerald-200 shrink-0"
                    >
                      {isSetupCompleted ? 'Schließen' : 'Einklappen'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={nasWakeBusy}
                    onClick={() => void handleWakeNasDevice(false)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 border border-emerald-500/45 text-emerald-200 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    <Power className={`w-3.5 h-3.5 ${nasWakeBusy ? 'animate-spin' : ''}`} />
                    <span>{nasWakeBusy ? 'Wecke NAS…' : 'NAS aufwecken'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openAppProvisionDialog()}
                    className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                  >
                    <FolderTree className="w-3.5 h-3.5" />
                    <span>NAS-Dateistruktur &amp; Backend anlegen</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isNasStorageSynced || isBridgeActive) {
                        handleManualLogout();
                        return;
                      }
                      void clearLocalOnboardingBuffer().then(() => {
                        setFallbackBuffer(null);
                        handleManualLogout();
                      });
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 shrink-0"
                  >
                    {isNasStorageSynced || isBridgeActive
                      ? 'Abmelden'
                      : 'Puffer verwerfen & zurück'}
                  </button>
                </div>
              </div>
              {nasWakeFeedback && (
                <div className="rounded-lg bg-[#0B0E14] border border-emerald-500/35 px-3 py-2 text-[11px] text-emerald-200">
                  {nasWakeFeedback}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2.5">
                <input
                  type="text"
                  value={fallbackServerInput}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setFallbackServerInput(nextVal);
                    setFallbackSyncError(null);
                    if (fallbackBuffer) {
                      const updated = {
                        ...fallbackBuffer,
                        serverUrl: nextVal.trim() ? normalizeNasBaseUrl(nextVal) || nextVal.trim() : '',
                      };
                      writeLocalOnboardingBuffer(updated);
                      setFallbackBuffer(updated);
                    }
                  }}
                  placeholder="NAS-Adresse eingeben (z. B. http://192.168.178.50:3000 oder https://mein-nas.myfritz.net)"
                  aria-label="NAS-Server-Adresse für Verbindungstest"
                  className="flex-1 px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs sm:text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                />
                <button
                  type="button"
                  disabled={fallbackSyncBusy}
                  onClick={() => void handleSyncFallbackBufferToNas(false)}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${fallbackSyncBusy ? 'animate-spin' : ''}`} />
                  <span>
                    {fallbackSyncBusy
                      ? 'Teste & übertrage…'
                      : 'Verbindung testen & aufs NAS übertragen'}
                  </span>
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-0.5">
                <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={fallbackAutoCheck}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setFallbackAutoCheck(next);
                      if (fallbackBuffer) {
                        const updated = { ...fallbackBuffer, autoBackgroundCheck: next };
                        writeLocalOnboardingBuffer(updated);
                        setFallbackBuffer(updated);
                      }
                    }}
                    className="accent-amber-400 rounded"
                  />
                  <span>Automatischer Background-Check alle 10 Sek. aktiv</span>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Bevorzugter Ausweichport statt 3000"
                    value={appPreferredAltPort}
                    onChange={(e) => {
                      const next = Number(e.target.value) || 3001;
                      setAppPreferredAltPort(next);
                      setPreferredAlternativePort(next);
                    }}
                    className="px-2 py-1 rounded bg-[#0B0E14] border border-slate-700 text-[11px] font-mono text-amber-300"
                  >
                    {DEFAULT_ALTERNATIVE_PORTS.map((portNum) => (
                      <option key={portNum} value={portNum}>
                        Alt. :{portNum}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={appPortScanBusy}
                    onClick={() => void handleRunAppPortScan(fallbackServerInput.trim())}
                    className="px-2.5 py-1 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-60 border border-amber-400/45 text-[11px] font-medium text-amber-200 flex items-center gap-1.5 transition-colors"
                  >
                    <Radar className={`w-3.5 h-3.5 ${appPortScanBusy ? 'animate-spin' : ''}`} />
                    <span>{appPortScanBusy ? 'Scanne Ports…' : 'Port-Scan (Alt. zu :3000)'}</span>
                  </button>
                </div>
              </div>

              {appPortScanResult && (
                <div className="rounded-lg bg-[#0B0E14] border border-slate-800 p-2.5 space-y-1.5 text-[11px]">
                  <p className="text-slate-300">{appPortScanResult.summary}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {appPortScanResult.recommendedBaseUrl && (
                      <button
                        type="button"
                        onClick={() =>
                          handleAdoptAppScannedUrl(
                            appPortScanResult.recommendedBaseUrl!,
                            appPortScanResult.recommendedPort ?? undefined
                          )
                        }
                        className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-200 font-mono text-[10px] font-semibold"
                      >
                        Empfohlen übernehmen: {appPortScanResult.recommendedBaseUrl}
                      </button>
                    )}
                    {appPortScanResult.ports
                      .filter((p) => p.isEntenCenter || p.tcpOpen)
                      .map((p) => {
                        const entryUrl = `${p.scheme === 'https' ? 'https' : 'http'}://${appPortScanResult.hostname}:${p.port}`;
                        return (
                          <button
                            key={`fb-scan-${p.scheme}-${p.port}`}
                            type="button"
                            onClick={() => handleAdoptAppScannedUrl(entryUrl, p.port)}
                            className={`px-2 py-0.5 rounded border font-mono text-[10px] ${
                              p.isEntenCenter
                                ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
                                : 'bg-[#121722] border-slate-700 text-amber-200'
                            }`}
                          >
                            {p.scheme}:{p.port}{' '}
                            {p.isEntenCenter
                              ? '✓ EntenCenter'
                              : p.httpStatus
                                ? `HTTP ${p.httpStatus}`
                                : 'offen'}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Immer erreichbare FRITZ!Box / NAS-Zugangsdaten (Passwort für die FRITZ!Box) */}
              {(fallbackDiagnosis?.detectedFritzBox ||
                fallbackDiagnosis?.fritzBoxInfo?.detected ||
                fallbackBuffer?.nasConnection?.protocol === 'fritz_upnp' ||
                fallbackServerInput.toLowerCase().includes('fritz') ||
                fallbackServerInput.includes('192.168.178.') ||
                setupChecklistMissing.some((m) => m.key === 'nas_credentials')) && (
                <div className="rounded-xl bg-[#0B0E14]/90 border border-sky-500/40 p-3 space-y-2 text-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[11px] font-semibold text-sky-200 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                      <span>
                        {fallbackDiagnosis?.fritzBoxInfo?.friendlyName ||
                          `FRITZ!Box / FRITZ!NAS Zugangsdaten (${
                            fallbackDiagnosis?.resolvedIp ||
                            fallbackDiagnosis?.host ||
                            fallbackBuffer?.nasConnection?.host ||
                            'fritz.box'
                          })`}
                      </span>
                    </span>
                    <span className="text-[10px] font-mono text-sky-300">
                      {fallbackDiagnosis?.fritzBoxInfo?.requiresAuth
                        ? 'Zugangsdaten erforderlich'
                        : 'Challenge-Response & SMB2 (:445) bereit'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={fallbackFritzUser}
                      onChange={(e) => setFallbackFritzUser(e.target.value)}
                      placeholder="FRITZ!Box-Benutzername (leer = automatisch)"
                      aria-label="FRITZ!Box-Benutzername"
                      className="px-2.5 py-1.5 rounded bg-[#121722] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <div className="relative flex items-center">
                      <input
                        type={fallbackShowFritzPass ? 'text' : 'password'}
                        value={fallbackFritzPass}
                        onChange={(e) => setFallbackFritzPass(e.target.value)}
                        placeholder="Passwort für die FRITZ!Box"
                        aria-label="Passwort für die FRITZ!Box"
                        className="w-full pl-2.5 pr-8 py-1.5 rounded bg-[#121722] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() => setFallbackShowFritzPass((v) => !v)}
                        aria-label="FRITZ!Box-Passwort anzeigen"
                        className="absolute right-2 text-slate-400 hover:text-slate-200"
                      >
                        {fallbackShowFritzPass ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={fallbackFritzBusy}
                      onClick={async () => {
                        const rawTarget =
                          fallbackDiagnosis?.resolvedIp ||
                          fallbackDiagnosis?.host ||
                          fallbackBuffer?.nasConnection?.host ||
                          fallbackServerInput.trim() ||
                          'fritz.box';
                        const hostTarget = rawTarget
                          .replace(/^https?:\/\//i, '')
                          .split('/')[0]
                          .split(':')[0];
                        if (!hostTarget) return;
                        setFallbackFritzBusy(true);
                        setFallbackFritzResult(null);
                        try {
                          const directRes = await fritzBoxDirectLoginWithSession({
                            host: hostTarget,
                            port: fallbackDiagnosis?.fritzBoxInfo?.httpAvailable === false ? 443 : 80,
                            useTls: fallbackDiagnosis?.fritzBoxInfo?.httpAvailable === false,
                            username: fallbackFritzUser.trim(),
                            password: fallbackFritzPass,
                            allowLocalSelfSignedTls: true,
                            forceRefresh: true,
                            verifyBrowseTree: false,
                          });
                          const fallbackChallenge = !directRes.ok
                            ? await fritzBoxChallengeLoginNative({
                                host: hostTarget,
                                port: fallbackDiagnosis?.fritzBoxInfo?.httpAvailable === false ? 443 : 80,
                                useTls: fallbackDiagnosis?.fritzBoxInfo?.httpAvailable === false,
                                username: fallbackFritzUser.trim(),
                                password: fallbackFritzPass,
                                allowLocalSelfSignedTls: true,
                                forceRefresh: true,
                              })
                            : null;
                          const loginOk = Boolean(directRes.ok || fallbackChallenge?.ok);
                          const effectiveScheme =
                            directRes.effectiveScheme || fallbackChallenge?.effectiveScheme || 'http';
                          const effectivePort =
                            directRes.effectivePort || fallbackChallenge?.effectivePort || 80;
                          const sidPreview =
                            directRes.sidPreview || fallbackChallenge?.sidPreview || 'aktiv';
                          const httpFallback = Boolean(
                            directRes.httpsFallbackToHttp || fallbackChallenge?.httpsFallbackToHttp
                          );

                          if (loginOk) {
                            const current = fallbackBuffer ?? readLocalOnboardingBuffer();
                            if (current) {
                              const existingProto = current.nasConnection?.protocol ?? 'fritz_upnp';
                              const effectiveUseTls =
                                existingProto === 'smb' ? false : effectiveScheme === 'https';
                              const safePort = String(
                                sanitizeNasPortForProtocol(
                                  existingProto,
                                  existingProto === 'smb' ? '445' : effectivePort,
                                  effectiveUseTls
                                )
                              );
                              const updated: LocalOnboardingBuffer = {
                                ...current,
                                nasConnection: {
                                  ...(current.nasConnection ?? {
                                    protocol: 'fritz_upnp',
                                    host: hostTarget,
                                    port: safePort,
                                    shareOrPath: '/FRITZ',
                                    username: fallbackFritzUser.trim(),
                                    secret: fallbackFritzPass,
                                    useTls: effectiveUseTls,
                                  }),
                                  host: hostTarget,
                                  port: safePort,
                                  username: fallbackFritzUser.trim(),
                                  secret: fallbackFritzPass,
                                  fritzPassword: fallbackFritzPass,
                                  useTls: effectiveUseTls,
                                  storageBridgeMode: true,
                                },
                                updatedAt: new Date().toISOString(),
                              };
                              writeLocalOnboardingBuffer(updated);
                              setFallbackBuffer(updated);
                            }
                            setFallbackSyncError(null);
                            setFallbackFritzResult(
                              `FRITZ!Box Login OK (SID ${sidPreview}${
                                httpFallback ? ' · HTTP-Fallback :80' : ''
                              }) & Zugangsdaten im Puffer gespeichert.`
                            );
                          } else {
                            setFallbackFritzResult(
                              directRes.error ||
                                fallbackChallenge?.error ||
                                'FRITZ!Box Login fehlgeschlagen (Benutzername / Kennwort prüfen).'
                            );
                          }
                        } finally {
                          setFallbackFritzBusy(false);
                        }
                      }}
                      className="px-3 py-1.5 rounded bg-sky-500 hover:bg-sky-400 disabled:opacity-60 text-slate-950 text-[11px] font-semibold transition-colors"
                    >
                      {fallbackFritzBusy
                        ? 'Prüfe FRITZ!Box-Login…'
                        : 'FRITZ!Box-Zugangsdaten testen & puffern'}
                    </button>
                    {fallbackFritzResult && (
                      <span className="text-[11px] text-sky-200">{fallbackFritzResult}</span>
                    )}
                  </div>
                </div>
              )}

              {setupChecklistMissing.length > 0 && (
                <div className="rounded-xl bg-amber-500/10 border border-amber-400/50 p-3.5 space-y-2.5 text-xs text-amber-100">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-amber-200">
                        Noch fehlende Angaben für den Abschluss der Einrichtung
                      </p>
                      <p className="text-[11px] text-slate-300 mt-0.5">
                        Bitte ergänze die fehlenden Punkte unten und klicke erneut auf „Prüfen &amp; Einrichtung abschließen“.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSetupChecklistMissing([])}
                      className="text-[11px] text-slate-400 hover:text-white shrink-0"
                    >
                      Ausblenden
                    </button>
                  </div>

                  <ul className="space-y-1.5 text-[11px]">
                    {setupChecklistMissing.map((item) => (
                      <li
                        key={item.key}
                        className="rounded-lg bg-[#0B0E14] border border-amber-400/30 px-2.5 py-2"
                      >
                        <span className="font-semibold text-amber-300">{item.label}: </span>
                        <span className="text-slate-300">{item.detail}</span>
                      </li>
                    ))}
                  </ul>

                  {setupChecklistMissing.some((m) => m.key === 'profile') && (
                    <div className="space-y-1">
                      <label className="block text-[11px] text-slate-300">
                        Profil-Anzeigename
                      </label>
                      <input
                        type="text"
                        value={setupPromptDisplayName}
                        onChange={(e) => setSetupPromptDisplayName(e.target.value)}
                        placeholder="z. B. Marc"
                        className="w-full px-2.5 py-1.5 rounded bg-[#0B0E14] border border-slate-700 text-xs text-white"
                      />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {setupChecklistMissing.some((m) => m.key === 'backend_path') && (
                      <button
                        type="button"
                        onClick={() => openAppProvisionDialog()}
                        className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5"
                      >
                        <FolderTree className="w-3.5 h-3.5" />
                        <span>Backend-Ordner auf NAS anlegen</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={setupFinishBusy}
                      onClick={() => void handleCompleteSetupAndExit(false)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-[11px] font-semibold"
                    >
                      {setupFinishBusy ? 'Prüfe…' : 'Prüfen & Einrichtung abschließen'}
                    </button>
                    <button
                      type="button"
                      disabled={setupFinishBusy}
                      onClick={() => void handleCompleteSetupAndExit(true)}
                      className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300"
                    >
                      Trotzdem manuell abschließen &amp; beenden
                    </button>
                  </div>
                </div>
              )}

              {fallbackSyncError && (
                <div className="text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg px-3 py-2 space-y-2">
                  <p>{fallbackSyncError}</p>
                  {(fallbackDiagnosis?.detectedPureNas || fallbackDiagnosis?.detectedFritzBox) && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => openAppProvisionDialog()}
                        className="px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 text-[11px] font-semibold flex items-center gap-1 transition-colors"
                      >
                        <FolderTree className="w-3.5 h-3.5" />
                        <span>NAS-Dateistruktur öffnen &amp; Backend anlegen</span>
                      </button>
                      {fallbackDiagnosis.openNasServices?.map((svc) => (
                        <button
                          key={`adopt-fb-${svc.protocol}-${svc.port}`}
                          type="button"
                          onClick={() => handleAdoptFallbackPureNas(fallbackDiagnosis, svc)}
                          className="px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold transition-colors"
                        >
                          {svc.label} (:{svc.port}) im Puffer speichern
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {section === 'library' && (
            <MediaLibraryView
              items={libraryItems}
              loading={loadingData}
              recommendations={recommendations}
              recommendationsLoading={recommendationsLoading}
              calendarReleases={calendarReleases}
              filmStarts={filmStarts}
              calendarNotificationMode={preferences.calendarNotificationMode ?? 'favorites_all'}
              filmNotificationMode={preferences.filmNotificationMode ?? 'favorites'}
              homeSectionOrder={preferences.homeSectionOrder}
              hiddenHomeSections={preferences.hiddenHomeSections ?? []}
              showHomeCategoryTabs={preferences.showHomeCategoryTabs === true}
              showHomeFilterSearch={preferences.showHomeFilterSearch === true}
              audioPlayerMode={preferences.audioPlayerMode ?? 'internal'}
              duckAssistantEnabled={preferences.duckAssistantEnabled ?? true}
              assistantAvatarUrl={assistantAvatarUrl}
              userFskLimit={user.fskLimit ?? 18}
              homeResetSignal={homeResetSignal}
              savedCollections={savedCollections}
              onRefreshRecommendations={handleRefreshRecommendations}
              onAskDuck={handleAskDuck}
              onSaveCollection={handleSaveCollection}
              onDeleteCollection={handleDeleteCollection}
              onBatchAddWatchlist={handleBatchAddWatchlist}
              onStartPlaylist={handleStartPlaylist}
              onOpenCalendar={handleOpenCalendarSection}
              onOpenFilmStarts={handleOpenFilmStartsSection}
              onOpenAssistant={handleOpenAssistantSection}
              onOpenProfile={handleOpenProfileSection}
              onToggleWatchlist={handleToggleWatchlist}
              onAddToQueue={handleAddToQueue}
              onPlayItem={handlePlayItem}
              onMarkWatchedState={handleMarkWatchedState}
              onUpdateMediaMetadata={handleUpdateMediaMetadata}
              onEnrichMetadata={handleEnrichLibraryMetadata}
              enrichingMetadata={enrichingMetadata}
            />
          )}

          <Suspense fallback={<ViewLoadingFallback />}>
            {section === 'calendar' && (
              <SeriesCalendarView
                releases={calendarReleases}
                sources={calendarSources}
                lastFetchedAt={calendarLastFetchedAt}
                fetchMethod={calendarFetchMethod}
                fetchWarning={calendarWarning}
                refreshing={calendarRefreshing}
                userFskLimit={user.fskLimit ?? 18}
                notificationMode={preferences.calendarNotificationMode ?? 'favorites_all'}
                onUpdateNotificationMode={handleUpdateCalendarNotificationMode}
                onRefreshFromInternet={handleRefreshSeriesCalendar}
                onToggleFavorite={handleToggleFavorite}
                onSimulateReleaseNow={handleSimulateReleaseNow}
                onSearchSeriesOnline={handleSearchSeriesOnline}
                onAddManualSeries={handleAddManualSeries}
                onDeleteManualSeries={handleDeleteManualSeries}
                onPlayNasMediaId={(mediaId) => {
                  const match = libraryItems.find((item) => item.id === mediaId);
                  if (match) handlePlayItem(match);
                }}
              />
            )}

            {section === 'filmstarts' && (
              <FilmStartsView
                releases={filmStarts}
                sources={filmStartSources}
                lastFetchedAt={filmStartsLastFetchedAt}
                fetchMethod={filmStartsFetchMethod}
                fetchWarning={filmStartsWarning}
                loading={filmStartsLoading}
                refreshing={filmStartsRefreshing}
                userFskLimit={user.fskLimit ?? 18}
                notificationMode={preferences.filmNotificationMode ?? 'favorites'}
                onUpdateNotificationMode={handleUpdateFilmNotificationMode}
                onRefreshFromInternet={handleRefreshFilmStarts}
                onToggleFavorite={handleToggleFilmFavorite}
                onSimulateReleaseNow={handleSimulateFilmReleaseNow}
                onPlayNasMediaId={(mediaId) => {
                  const match = libraryItems.find((item) => item.id === mediaId);
                  if (match) handlePlayItem(match);
                }}
              />
            )}

            {section === 'statistics' && (
              <StatisticsView
                stats={statistics}
                loading={loadingData}
                recommendations={recommendations}
                recommendationsLoading={recommendationsLoading}
                onRefreshRecommendations={handleRefreshRecommendations}
                onPlayMediaId={(mediaId) => {
                  const match = libraryItems.find((item) => item.id === mediaId);
                  if (match) setActivePlayerItem(match);
                }}
              />
            )}

            {section === 'notifications' && (
              <NotificationsView
                notifications={notifications}
                onMarkRead={handleMarkNotificationsRead}
                onDeleteSingle={handleDeleteNotification}
                onDeleteBatch={handleDeleteNotificationsBatch}
                onDeleteAll={handleDeleteAllNotifications}
              />
            )}

            {section === 'code' && <CodeStudioView />}

            {section === 'chat' && (
              <GeminiAssistantView
                key="chat"
                initialTab="chat"
                assistantAvatarUrl={assistantAvatarUrl}
              />
            )}

            {section === 'vision' && (
              <GeminiAssistantView
                key="vision"
                initialTab="vision"
                assistantAvatarUrl={assistantAvatarUrl}
              />
            )}

            {section === 'profile' && (
              <ProfileView
                user={user}
                token={token}
                preferences={preferences}
                storage={nasStorage}
                storageLoading={storageLoading}
                onRefreshStorage={handleRefreshStorage}
                syncMode={syncMode}
                lastScanTs={lastScanTs}
                scanningNas={scanningNas}
                onUpdateSyncMode={handleUpdateSyncMode}
                onRunNasScan={handleRunNasScan}
                onProfileUpdated={(newToken, updatedUser) => {
                  persistStoredSession(newToken, updatedUser);
                  setToken(newToken);
                  setUser(updatedUser);
                  void loadAllNasData(newToken);
                }}
                onPreferencesUpdated={(updatedPrefs) => {
                  persistStoredPreferences(updatedPrefs);
                  setPreferences(updatedPrefs);
                }}
                libraryItems={libraryItems}
                smartHomeState={smartHomeState}
                onSmartHomeStateChange={(next) => {
                  lastSmartHomeSeqRef.current = next.commandSeq;
                  setSmartHomeState(next);
                }}
              />
            )}

            {section === 'admin' && user.role === 'admin' && (
              <AdminView
                user={user}
                token={token}
                assistantAvatarUrl={assistantAvatarUrl}
                activeTab={adminActiveTab}
                onActiveTabChange={setAdminActiveTab}
                onAssistantAvatarUpdated={(nextAvatarUrl) => {
                  setAssistantAvatarUrl(nextAvatarUrl);
                }}
                onNotificationsBroadcasted={() => {
                  if (!token || isLocalFallbackToken(token)) return;
                  void fetch('/api/nas/notifications', {
                    headers: { Authorization: `Bearer ${token}` },
                  })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data: { alerts?: NasNotification[] } | null) => {
                      if (data && Array.isArray(data.alerts)) {
                        setNotifications(data.alerts);
                      }
                    })
                    .catch(() => {});
                }}
                onProfileUpdated={(newToken, updatedUser) => {
                  persistStoredSession(newToken, updatedUser);
                  setToken(newToken);
                  setUser(updatedUser);
                  void loadAllNasData(newToken);
                }}
                onNasItemsAdded={() => {
                  if (token) void loadAllNasData(token);
                }}
                onPlayMediaId={(mediaId) => {
                  const match = libraryItems.find((item) => item.id === mediaId);
                  if (match) handlePlayItem(match);
                }}
              />
            )}

            {section === 'about-update' && <SystemUpdateView token={token} />}
          </Suspense>
        </main>
      </div>
      </div>

      {/* Integrierter Enten Player mit Warteschlange & Smart Home Sync */}
      {activePlayerItem && (
        <Suspense fallback={null}>
          <MediaPlayerModal
            item={activePlayerItem}
            queue={playbackQueue}
            libraryItems={libraryItems}
            smartHomeState={smartHomeState}
            controlsTimeoutSec={preferences.playerControlsTimeoutSec ?? 3}
            seekBackwardSec={preferences.playerSeekBackwardSec ?? 30}
            seekForwardSec={preferences.playerSeekForwardSec ?? 30}
            onClose={() => {
              setActivePlayerItem(null);
              void syncActiveMediaToSmartHome(null, null, 'IDLE');
            }}
            onPlaybackEnded={handlePlaybackEnded}
            onSyncProgress={handleSyncProgress}
            onPlayNext={handlePlayNextInQueue}
            onPlayQueueIndex={handlePlayQueueIndex}
            onAddToQueue={handleAddToQueue}
            onRemoveFromQueue={handleRemoveFromQueue}
            onMoveQueueItem={handleMoveQueueItem}
            onClearQueue={handleClearQueue}
          />
        </Suspense>
      )}

      {/* Echtzeit-NAS-Verbindungsstatus & Netzwerkanalyse (Viewport-gesichertes Modal außerhalb des sticky Headers) */}
      {nasStatusMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/65 flex items-start sm:items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-label="NAS-Verbindung in Echtzeit"
          onClick={() => setNasStatusMenuOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full ${
              nasDeepDiagResult || nasDeepDiagLoading || nasDeepDiagError
                ? 'max-w-[min(44rem,calc(100vw-1rem))]'
                : 'max-w-[min(24rem,calc(100vw-1rem))]'
            } max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/90 rounded-2xl shadow-2xl overflow-hidden flex flex-col`}
          >
            <div className="px-4 py-3 border-b border-slate-800 bg-[#0F141E] flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs sm:text-sm font-semibold text-white truncate">
                  NAS-Verbindung in Echtzeit
                </span>
                <span
                  className={`text-[11px] font-medium shrink-0 ${
                    nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                      ? 'text-emerald-400'
                      : nasWakeBusy || bridgeHealthStatus === 'waking' || bridgeHealthStatus === 'sleeping'
                        ? 'text-amber-300'
                        : nasConnStatus === 'offline'
                          ? 'text-rose-400'
                          : 'text-amber-300'
                  }`}
                >
                  {nasWakeBusy || bridgeHealthStatus === 'waking'
                    ? 'Wecke NAS…'
                    : isFallbackMode
                      ? nasConnStatus === 'connected' || bridgeHealthStatus === 'online'
                        ? isSetupCompleted
                          ? 'FRITZ!NAS Online'
                          : 'Bridge Online'
                        : bridgeHealthStatus === 'sleeping'
                          ? 'Ruhemodus'
                          : isNasStorageSynced || isBridgeActive
                            ? 'NAS Direkt'
                            : 'On-Device-Puffer'
                      : nasConnStatus === 'connected'
                        ? 'Verbunden'
                        : nasConnStatus === 'offline'
                          ? 'Offline'
                          : 'Wiederverbinden'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setNasStatusMenuOpen(false)}
                aria-label="NAS-Statusfenster schließen"
                className="p-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3.5 sm:p-4 space-y-2.5">
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2 text-slate-400">
                  <span>Kanal</span>
                  <span className="text-slate-200 font-medium text-right truncate">
                    {isFallbackMode
                      ? isSetupCompleted
                        ? 'FRITZ!NAS Direkt (SMB :445 + Web)'
                        : bridgeTransportLabel ||
                          (nasConnStatus === 'connected' || isBridgeActive
                            ? 'FRITZ!NAS / Storage-Bridge (Direkt)'
                            : 'On-Device-Puffer')
                      : nasTransport === 'websocket'
                        ? 'WebSocket (/ws/nas-status)'
                        : 'HTTP-Polling (Fallback)'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Antwortzeit</span>
                  <span className="font-mono text-slate-200 tabular-nums">
                    {nasLatencyMs !== null ? `${nasLatencyMs} ms` : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-slate-400">
                  <span>Heim-NAS</span>
                  <span
                    title={effectiveBridgeHost || getEffectiveNasOrigin()}
                    className="font-mono text-[11px] text-amber-300 truncate max-w-[185px]"
                  >
                    {(
                      effectiveBridgeHost ||
                      fallbackServerInput.trim() ||
                      getEffectiveNasOrigin()
                    ).replace(/^https?:\/\//, '')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-slate-400">
                  <span>Mount-Pfad</span>
                  <span className="font-mono text-[11px] text-slate-300 truncate max-w-[175px]">
                    {fallbackBuffer?.nasConnection?.backendPath ||
                      matchedProvisionedEntry?.backendPath ||
                      nasMountPath}
                  </span>
                </div>
                {nasCatalogCount !== null && (
                  <div className="flex items-center justify-between text-slate-400">
                    <span>NAS-Katalog</span>
                    <span className="font-mono text-slate-200 tabular-nums">
                      {nasCatalogCount} Titel
                    </span>
                  </div>
                )}
                {nasLastHeartbeat && (
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Letzter Check</span>
                    <span className="font-mono text-slate-200 tabular-nums">
                      {new Date(nasLastHeartbeat).toLocaleTimeString('de-DE')}
                    </span>
                  </div>
                )}
                {sharedNasCert && (
                  <div className="flex items-center justify-between gap-2 text-slate-400">
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Zertifikat</span>
                    </span>
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        title={`${sharedNasCert.subject} (${sharedNasCert.fingerprint256})`}
                        className="font-mono text-[11px] text-emerald-300 truncate max-w-[130px]"
                      >
                        {sharedNasCert.label || sharedNasCert.subject || 'NAS-Zertifikat'}
                      </span>
                      <a
                        href={resolveNasUrl('/api/nas/network/certificate/download')}
                        download={sharedNasCert.fileName || 'entencenter-nas-cert.pem'}
                        className="text-[10px] text-amber-300 hover:text-amber-200 underline shrink-0"
                      >
                        .pem
                      </a>
                    </span>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void handleManualStatusCheck()}
                  className="w-full py-2 px-3 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Verbindung jetzt prüfen</span>
                </button>

                <button
                  type="button"
                  disabled={nasWakeBusy}
                  onClick={() => void handleWakeNasDevice(false)}
                  className="w-full py-2 px-3 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 border border-emerald-500/45 text-xs font-semibold text-emerald-200 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Power className={`w-3.5 h-3.5 ${nasWakeBusy ? 'animate-spin' : ''}`} />
                  <span>
                    {nasWakeBusy
                      ? 'Wecke FRITZ!NAS / Speicher…'
                      : 'FRITZ!NAS aufwecken (Ruhemodus)'}
                  </span>
                </button>

                {isFallbackMode && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!isSetupCompleted) {
                        setNasStatusMenuOpen(false);
                        void handleCompleteSetupAndExit(false);
                      } else {
                        setManualSetupReopen(true);
                        setFallbackCardExpanded(true);
                        setNasStatusMenuOpen(false);
                      }
                    }}
                    className={`w-full py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                      !isSetupCompleted
                        ? 'bg-emerald-400 hover:bg-emerald-300 border-emerald-400 text-slate-950'
                        : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-700 text-slate-200'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {!isSetupCompleted
                        ? 'Profileinrichtung abschließen & beenden'
                        : 'NAS-Einrichtung & Backend-Optionen öffnen'}
                    </span>
                  </button>
                )}

                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setShowWakeMacInput((v) => !v)}
                    className="hover:text-slate-200 underline"
                  >
                    {showWakeMacInput
                      ? 'MAC-Feld ausblenden'
                      : nasMacInput
                        ? `WoL-MAC: ${nasMacInput}`
                        : 'Optionale WoL-MAC hinterlegen'}
                  </button>
                </div>

                {showWakeMacInput && (
                  <input
                    type="text"
                    value={nasMacInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNasMacInput(val);
                      if (effectiveBridgeHost) {
                        saveNasMacAddress(effectiveBridgeHost, val);
                      }
                    }}
                    placeholder="MAC-Adresse (z. B. AA:BB:CC:DD:EE:FF)"
                    aria-label="Optionale NAS MAC-Adresse für Wake-on-LAN"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700 text-[11px] font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                  />
                )}

                {nasWakeFeedback && (
                  <p className="text-[11px] rounded-lg bg-[#0B0E14] border border-slate-800 px-2.5 py-1.5 text-slate-200">
                    {nasWakeFeedback}
                  </p>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/90 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="nas-deep-diag-target"
                    className="text-[11px] font-medium text-slate-400"
                  >
                    Ziel-Adresse für Analyse (optional)
                  </label>
                  {nasDeepDiagResult && (
                    <button
                      type="button"
                      onClick={() => {
                        setNasDeepDiagResult(null);
                        setNasDeepDiagError(null);
                      }}
                      className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1"
                      title="Analyseergebnis ausblenden"
                    >
                      <X className="w-3 h-3" />
                      <span>Ausblenden</span>
                    </button>
                  )}
                </div>
                <input
                  id="nas-deep-diag-target"
                  type="text"
                  value={nasDeepDiagTarget}
                  onChange={(e) => setNasDeepDiagTarget(e.target.value)}
                  placeholder={
                    (fallbackServerInput.trim() || getEffectiveNasOrigin()).replace(
                      /^https?:\/\//,
                      ''
                    ) || 'z. B. http://192.168.178.69'
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700/90 focus:border-amber-400/70 focus:outline-none text-xs font-mono text-slate-200 placeholder:text-slate-500"
                />
                <button
                  type="button"
                  disabled={nasDeepDiagLoading}
                  onClick={() => void handleRunDeepNetworkDiagnostics()}
                  className="w-full py-2 px-3 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-60 border border-amber-400/45 text-xs font-semibold text-amber-200 flex items-center justify-center gap-1.5 transition-colors"
                >
                  {nasDeepDiagLoading ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-300" />
                  ) : (
                    <Radar className="w-3.5 h-3.5 text-amber-300" />
                  )}
                  <span>
                    {nasDeepDiagLoading
                      ? 'Analysiere ICMP-Ping, Route & Ports...'
                      : 'Tiefergehende Netzwerkanalyse'}
                  </span>
                </button>

                <div className="rounded-lg bg-[#0B0E14] border border-slate-800 p-2 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <label
                      htmlFor="app-popover-alt-port"
                      className="text-[10px] font-medium text-slate-400"
                    >
                      Alt. Port zu :3000
                    </label>
                    <select
                      id="app-popover-alt-port"
                      value={appPreferredAltPort}
                      onChange={(e) => {
                        const next = Number(e.target.value) || 3001;
                        setAppPreferredAltPort(next);
                        setPreferredAlternativePort(next);
                      }}
                      className="px-1.5 py-0.5 rounded bg-[#121722] border border-slate-700 text-[10px] font-mono text-amber-300"
                    >
                      {DEFAULT_ALTERNATIVE_PORTS.map((portNum) => (
                        <option key={portNum} value={portNum}>
                          :{portNum}
                        </option>
                      ))}
                    </select>
                    <label className="inline-flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appAutoPortFallback}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setAppAutoPortFallback(next);
                          setAutoPortFallbackEnabled(next);
                        }}
                        className="accent-amber-400 rounded"
                      />
                      <span>Auto-Fallback</span>
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={appPortScanBusy}
                    onClick={() => void handleRunAppPortScan()}
                    className="w-full py-1.5 px-2.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-60 border border-slate-700 text-[11px] font-medium text-amber-200 flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Radar className={`w-3.5 h-3.5 ${appPortScanBusy ? 'animate-spin' : ''}`} />
                    <span>
                      {appPortScanBusy ? 'Scanne Ausweichports…' : 'Port-Scan (Alt. zu :3000)'}
                    </span>
                  </button>
                  {appPortScanResult && (
                    <div className="space-y-1.5 pt-1 border-t border-slate-800/80 text-[10px]">
                      <p className="text-slate-300 leading-snug">{appPortScanResult.summary}</p>
                      <div className="flex flex-wrap gap-1">
                        {appPortScanResult.recommendedBaseUrl && (
                          <button
                            type="button"
                            onClick={() =>
                              handleAdoptAppScannedUrl(
                                appPortScanResult.recommendedBaseUrl!,
                                appPortScanResult.recommendedPort ?? undefined
                              )
                            }
                            className="px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-200 font-mono font-semibold"
                          >
                            Übernehmen: {appPortScanResult.recommendedBaseUrl}
                          </button>
                        )}
                        {appPortScanResult.ports
                          .filter((p) => p.isEntenCenter || p.tcpOpen)
                          .map((p) => {
                            const entryUrl = `${p.scheme === 'https' ? 'https' : 'http'}://${appPortScanResult.hostname}:${p.port}`;
                            return (
                              <button
                                key={`pop-scan-${p.scheme}-${p.port}`}
                                type="button"
                                onClick={() => handleAdoptAppScannedUrl(entryUrl, p.port)}
                                className={`px-1.5 py-0.5 rounded border font-mono ${
                                  p.isEntenCenter
                                    ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
                                    : 'bg-[#121722] border-slate-700 text-amber-200'
                                }`}
                                title={p.label}
                              >
                                {p.scheme}:{p.port}{' '}
                                {p.isEntenCenter
                                  ? '✓'
                                  : p.httpStatus
                                    ? `HTTP ${p.httpStatus}`
                                    : 'offen'}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>

                {nasDeepDiagError && (
                  <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/40 text-xs text-rose-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{nasDeepDiagError}</span>
                  </div>
                )}

                {nasDeepDiagResult && (
                  <div className="space-y-2.5 pt-1 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-[11px]">
                      <span className="font-mono text-slate-200 truncate">
                        {nasDeepDiagResult.hostname}
                        {nasDeepDiagResult.resolvedIp &&
                        nasDeepDiagResult.resolvedIp !== nasDeepDiagResult.hostname
                          ? ` (${nasDeepDiagResult.resolvedIp})`
                          : ''}
                        :{nasDeepDiagResult.targetPort}
                      </span>
                      <span className="font-mono text-slate-400 tabular-nums">
                        {nasDeepDiagResult.scope === 'lan' ? 'LAN' : 'Remote'} ·{' '}
                        {nasDeepDiagResult.executedOn === 'android_native'
                          ? 'Android-Nativ'
                          : nasDeepDiagResult.executedOn === 'server'
                            ? 'Server'
                            : 'Browser'}{' '}
                        · {nasDeepDiagResult.durationMs} ms
                      </span>
                    </div>

                    {nasDeepDiagResult.fritzBoxInfo?.detected && (
                      <div className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/45 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5 font-semibold text-sky-200">
                            <Wifi className="w-4 h-4 text-sky-400 shrink-0" />
                            <span>{nasDeepDiagResult.fritzBoxInfo.friendlyName}</span>
                          </div>
                          <span className="px-1.5 py-0.5 rounded bg-sky-950/80 border border-sky-500/35 font-mono text-[10px] text-sky-200">
                            /login_sid.lua aktiv
                            {nasDeepDiagResult.fritzBoxInfo.requiresAuth ? ' · Login nötig' : ''}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-200 leading-relaxed">
                          {nasDeepDiagResult.fritzBoxInfo.httpAvailable
                            ? 'HTTP (Port 80) erreichbar'
                            : 'HTTP (Port 80) nicht aktiv'}
                          {' · '}
                          {nasDeepDiagResult.fritzBoxInfo.httpsAvailable
                            ? 'HTTPS (Port 443) erreichbar'
                            : nasDeepDiagResult.fritzBoxInfo.httpsError
                              ? `HTTPS-Hinweis: ${nasDeepDiagResult.fritzBoxInfo.httpsError} (automatischer HTTP-Fallback im LAN aktiv)`
                              : 'HTTPS nicht aktiv (HTTP :80 wird automatisch genutzt)'}
                        </p>
                        {nasDeepDiagResult.fritzBoxInfo.requiresAuth && (
                          <p className="text-[11px] text-amber-200">
                            Vor dem Zugriff auf FRITZ!NAS werden die FRITZ!Box-Zugangsdaten
                            (Benutzername optional + Kennwort) benötigt.
                          </p>
                        )}
                      </div>
                    )}

                    {nasDeepDiagResult.http400Analysis?.detected && (() => {
                      const isFritzHttp400 =
                        Boolean(nasDeepDiagResult.fritzBoxInfo?.detected) &&
                        (nasDeepDiagResult.http400Analysis.port === 80 ||
                          nasDeepDiagResult.http400Analysis.port === 443);
                      return (
                        <div
                          className={`p-2.5 rounded-lg border space-y-1.5 ${
                            isFritzHttp400
                              ? 'bg-amber-500/10 border-amber-500/45'
                              : 'bg-rose-500/10 border-rose-500/50'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <ShieldAlert
                              className={`w-4 h-4 shrink-0 mt-0.5 ${
                                isFritzHttp400 ? 'text-amber-400' : 'text-rose-400'
                              }`}
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-1">
                                <span
                                  className={`font-semibold ${
                                    isFritzHttp400 ? 'text-amber-200' : 'text-rose-200'
                                  }`}
                                >
                                  {isFritzHttp400
                                    ? `FRITZ!Box Web/NAS auf Port ${nasDeepDiagResult.http400Analysis.port} (HTTP ${nasDeepDiagResult.http400Analysis.statusCode})`
                                    : `HTTP ${nasDeepDiagResult.http400Analysis.statusCode} auf Port ${nasDeepDiagResult.http400Analysis.port}`}
                                </span>
                                {nasDeepDiagResult.http400Analysis.serverHeader && (
                                  <span className="px-1.5 py-0.5 rounded bg-[#0B0E14] border border-slate-700 font-mono text-[10px] text-slate-200">
                                    Server: {nasDeepDiagResult.http400Analysis.serverHeader}
                                  </span>
                                )}
                              </div>
                              <p
                                className={`text-[11px] leading-relaxed ${
                                  isFritzHttp400 ? 'text-amber-100/90' : 'text-rose-100/90'
                                }`}
                              >
                                {nasDeepDiagResult.http400Analysis.summary}
                              </p>
                              <ul className="space-y-1 pt-0.5 text-[11px] text-slate-200">
                                {nasDeepDiagResult.http400Analysis.hints.map((hint, idx) => (
                                  <li key={idx} className="flex items-start gap-1.5">
                                    <span className="text-amber-300 font-mono shrink-0">
                                      {idx + 1}.
                                    </span>
                                    <span className="leading-relaxed">{hint}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {(() => {
                      const visibleFindings = nasDeepDiagResult.http400Analysis?.detected
                        ? nasDeepDiagResult.findings.filter(
                            (f) => !/^HTTP_\d+_CONFLICT$/i.test(f.code)
                          )
                        : nasDeepDiagResult.findings;
                      return (
                        visibleFindings.length > 0 && (
                          <div className="space-y-1.5">
                            {visibleFindings.map((finding, idx) => {
                              const tone =
                                finding.severity === 'ok'
                                  ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-200'
                                  : finding.severity === 'error'
                                    ? 'bg-rose-500/10 border-rose-500/35 text-rose-200'
                                    : finding.severity === 'warn'
                                      ? 'bg-amber-500/10 border-amber-500/35 text-amber-200'
                                      : 'bg-slate-800/70 border-slate-700 text-slate-200';
                              return (
                                <div
                                  key={`${finding.code}-${idx}`}
                                  className={`p-2 rounded-lg border text-[11px] space-y-0.5 ${tone}`}
                                >
                                  <div className="font-semibold flex items-center gap-1.5">
                                    {finding.severity === 'ok' ? (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                    ) : finding.severity === 'info' ? (
                                      <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                                    ) : (
                                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                    )}
                                    <span>{finding.title}</span>
                                  </div>
                                  <p className="text-slate-300 leading-snug">{finding.detail}</p>
                                  <p className="text-amber-200/95 leading-snug">
                                    Tipp: {finding.recommendation}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )
                      );
                    })()}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span>
                            {nasDeepDiagResult.ping.method === 'icmp'
                              ? 'ICMP-Ping'
                              : 'TCP-SYN Ping'}
                          </span>
                          <span
                            className={
                              nasDeepDiagResult.ping.reachable
                                ? 'text-emerald-400 font-medium'
                                : 'text-rose-400 font-medium'
                            }
                          >
                            {nasDeepDiagResult.ping.reachable ? 'Erreichbar' : 'Verlust'}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-200 tabular-nums">
                          {nasDeepDiagResult.ping.received}/{nasDeepDiagResult.ping.sent} Pakete (
                          {nasDeepDiagResult.ping.packetLossPercent}% Verlust)
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                          {nasDeepDiagResult.ping.avgMs !== null
                            ? `${nasDeepDiagResult.ping.minMs ?? nasDeepDiagResult.ping.avgMs} / ${nasDeepDiagResult.ping.avgMs} / ${nasDeepDiagResult.ping.maxMs ?? nasDeepDiagResult.ping.avgMs} ms`
                            : 'Keine RTT-Werte'}
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span>DNS & Gateway</span>
                          <span
                            className={
                              nasDeepDiagResult.dns.ok
                                ? 'text-emerald-400 font-medium'
                                : 'text-rose-400 font-medium'
                            }
                          >
                            {nasDeepDiagResult.dns.ok ? 'OK' : 'Fehler'}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-200 truncate">
                          IP: {nasDeepDiagResult.dns.resolvedIp || '—'}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 truncate">
                          GW: {nasDeepDiagResult.traceroute.gatewayIp || 'Direkt/Lokal'}
                        </div>
                      </div>
                    </div>

                    <div className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-medium text-slate-300 flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5 text-amber-400" />
                          <span>
                            Routen-Analyse ({nasDeepDiagResult.traceroute.method})
                          </span>
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {nasDeepDiagResult.traceroute.summary}
                      </p>
                      {nasDeepDiagResult.traceroute.hops.length > 0 && (
                        <div className="space-y-1">
                          {nasDeepDiagResult.traceroute.hops.map((hop) => (
                            <div
                              key={hop.hop}
                              className="flex items-center justify-between gap-2 text-[11px] font-mono bg-[#121722]/90 px-2 py-1 rounded border border-slate-800/80"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-slate-500 w-5 shrink-0">
                                  #{hop.hop}
                                </span>
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    hop.status === 'timeout'
                                      ? 'bg-rose-400'
                                      : hop.status === 'gateway'
                                        ? 'bg-amber-400'
                                        : 'bg-emerald-400'
                                  }`}
                                />
                                <span className="text-slate-200 truncate" title={hop.host}>
                                  {hop.host}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 text-[10px]">
                                {hop.note && (
                                  <span className="text-slate-400 hidden sm:inline">
                                    {hop.note}
                                  </span>
                                )}
                                <span className="text-amber-300 tabular-nums">
                                  {hop.rttMs !== null ? `${hop.rttMs} ms` : '*'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <NetworkPortComparisonTable
                      result={nasDeepDiagResult}
                      storageBridgeActive={isNasStorageSynced || isBridgeActive}
                      backendPath={effectiveSyncedBackendPath}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Externer Audio-Player Dialog (wenn in Profil → Audio „Externer Player“ gewählt ist) */}
      {externalAudioItem && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="external-audio-title"
          onClick={() => setExternalAudioItem(null)}
        >
          <div
            className="w-full max-w-[min(32rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/80 rounded-2xl overflow-y-auto overscroll-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-800/80 bg-[#0F141E] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-8 h-8 rounded-lg bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
                  <Headphones className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-amber-400 truncate">
                    Externer Audio-Player aktiv
                  </p>
                  <h3
                    id="external-audio-title"
                    className="font-display text-base font-semibold text-white truncate"
                  >
                    {externalAudioItem.title}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExternalAudioItem(null)}
                aria-label="Dialog schließen"
                className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-center gap-4">
                <img
                  src={externalAudioItem.coverUrl}
                  alt={externalAudioItem.title}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  className="w-16 h-20 rounded-xl object-cover border border-slate-800 shrink-0"
                />
                <div className="min-w-0 space-y-1 text-xs">
                  <p className="text-slate-200 font-medium truncate">
                    {externalAudioItem.genre} · {externalAudioItem.year}
                  </p>
                  <p className="text-slate-400 font-mono truncate tabular-nums">
                    {externalAudioItem.codec}
                    {externalAudioItem.fileSize ? ` · ${externalAudioItem.fileSize}` : ''}
                  </p>
                  <p className="text-slate-400 tabular-nums">
                    Laufzeit: {externalAudioItem.totalDurationMinutes} Min.
                  </p>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-1.5">
                <p className="text-[11px] text-slate-400">NAS-Audiodatei</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-mono text-amber-300 truncate">
                    {externalAudioItem.nasPath}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopyExternalAudioPath(externalAudioItem.nasPath)}
                    className="px-2.5 py-1 rounded-md bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1 shrink-0 whitespace-nowrap"
                  >
                    {copiedAudioPath ? (
                      <>
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-300">Kopiert</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3 text-amber-400" />
                        <span>Pfad kopieren</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                <button
                  type="button"
                  onClick={() => handleLaunchExternalM3u(externalAudioItem)}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  <span>In externem Player öffnen (.m3u)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const fallback = externalAudioItem;
                    setExternalAudioItem(null);
                    setActivePlayerItem(enrichPlayableItemWithStreamUrl(fallback));
                  }}
                  className="px-4 py-2.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                  <span>Intern abspielen</span>
                </button>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                <span>Einstellung aktiv: Profil → Audio → Externer Player</span>
                <button
                  type="button"
                  onClick={() => {
                    setExternalAudioItem(null);
                    setSection('profile');
                  }}
                  className="text-amber-400 hover:text-amber-300 font-medium whitespace-nowrap shrink-0"
                >
                  Im Profil ändern
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <NasBackendProvisionDialog
        open={provisionDialogOpen}
        target={provisionDialogTarget}
        onClose={() => setProvisionDialogOpen(false)}
        onProvisioned={(
          result: NasProvisionBackendResult,
          updatedCredentials: {
            username: string;
            secret: string;
            useTls: boolean;
            fritzPassword?: string;
          }
        ) => {
          const current = fallbackBuffer ?? readLocalOnboardingBuffer();
          const effectiveHost =
            result.host || provisionDialogTarget?.host || current?.nasConnection?.host || 'fritz.box';
          const effectiveProtocol =
            result.protocol || provisionDialogTarget?.protocol || current?.nasConnection?.protocol || 'fritz_upnp';
          saveLocalProvisionedBackendFolder(effectiveHost, effectiveProtocol, result.backendPath);
          if (updatedCredentials.username) {
            setFallbackFritzUser(updatedCredentials.username);
          }
          if (updatedCredentials.fritzPassword || updatedCredentials.secret) {
            setFallbackFritzPass(updatedCredentials.fritzPassword || updatedCredentials.secret);
          }
          if (current) {
            const safeProvisionPort = String(
              sanitizeNasPortForProtocol(
                effectiveProtocol,
                provisionDialogTarget?.port ||
                  current.nasConnection?.port ||
                  (effectiveProtocol === 'fritz_upnp'
                    ? updatedCredentials.useTls
                      ? '443'
                      : '80'
                    : '445'),
                updatedCredentials.useTls
              )
            );
            const nowIso = new Date().toISOString();
            const hasFullSetup = Boolean(
              result.remoteWriteOk &&
                effectiveHost &&
                (updatedCredentials.fritzPassword || updatedCredentials.secret) &&
                current.user.username.trim()
            );
            const updated: LocalOnboardingBuffer = {
              ...current,
              mode: result.remoteWriteOk ? 'storage_bridge_active' : current.mode,
              setupCompleted: hasFullSetup ? true : current.setupCompleted,
              setupCompletedAt: hasFullSetup ? (current.setupCompletedAt || nowIso) : current.setupCompletedAt,
              autoBackgroundCheck: hasFullSetup ? false : current.autoBackgroundCheck,
              ...(result.remoteWriteOk
                ? {
                    nasSyncedAt: current.nasSyncedAt || nowIso,
                    syncedBackendPath: result.backendPath,
                  }
                : {}),
              nasConnection: {
                protocol: effectiveProtocol,
                host: effectiveHost,
                port: safeProvisionPort,
                shareOrPath: result.backendPath,
                username: updatedCredentials.username,
                secret: updatedCredentials.secret,
                fritzPassword: updatedCredentials.fritzPassword ?? current.nasConnection?.fritzPassword,
                useTls: effectiveProtocol === 'smb' ? false : updatedCredentials.useTls,
                backendPath: result.backendPath,
                backendProvisioned: true,
                storageBridgeMode: true,
              },
              updatedAt: nowIso,
            };
            writeLocalOnboardingBuffer(updated);
            setFallbackBuffer(updated);
            if (hasFullSetup) {
              setManualSetupReopen(false);
              setFallbackCardExpanded(false);
              setSetupChecklistMissing([]);
            }
          }
          if (result.remoteWriteOk) {
            setHydratedBackendPath(result.backendPath);
            setNasMountPath(result.backendPath);
            setBridgeHealthStatus('online');
            setNasConnStatus('connected');
          }
          setFallbackSyncError(null);
          setFallbackSyncNotice(
            result.remoteWriteOk
              ? `EntenCenter-Backend unter "${result.backendPath}" eingerichtet & Einrichtung abgeschlossen.`
              : `EntenCenter-Backend unter "${result.backendPath}" vorgemerkt.`
          );
        }}
      />
    </div>
  );
}
