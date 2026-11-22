import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BellRing,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  ExternalLink,
  Film,
  Globe,
  HardDrive,
  Info,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Users,
  VolumeX,
  X,
} from 'lucide-react';
import {
  FilmGroundSource,
  FilmNotificationMode,
  FilmReleaseChannel,
  FilmStartRelease,
  FskLevel,
} from '../types/marcente';
import { MARCENTE_ASSETS } from '../data/coverAssets';

interface FilmStartsViewProps {
  releases: FilmStartRelease[];
  sources: FilmGroundSource[];
  lastFetchedAt: string | null;
  fetchMethod: 'gemini-search' | 'live-web' | 'mixed' | 'cache';
  fetchWarning?: string | null;
  loading: boolean;
  refreshing: boolean;
  userFskLimit?: FskLevel;
  notificationMode: FilmNotificationMode;
  onUpdateNotificationMode: (mode: FilmNotificationMode) => Promise<void>;
  onRefreshFromInternet: () => Promise<void>;
  onToggleFavorite: (filmTitle: string, action: 'pin' | 'unpin' | 'mute') => Promise<void>;
  onSimulateReleaseNow: (filmId: string) => Promise<void>;
  onPlayNasMediaId: (mediaId: string) => void;
}

const FILM_NOTIFICATION_OPTIONS: Array<{
  id: FilmNotificationMode;
  label: string;
  description: string;
}> = [
  {
    id: 'favorites',
    label: 'Nur für Favoriten',
    description: 'Benachrichtigungen nur für als Favorit markierte Filmstarts',
  },
  {
    id: 'all',
    label: 'Alle',
    description: 'Benachrichtigungen für alle aktuellen Filmstarts in DE & AT',
  },
];

type FilmTab = 'all' | 'de' | 'at' | 'nas' | 'favorites' | 'released';
type ChannelFilter = 'Alle' | FilmReleaseChannel;

function formatDeDate(isoDate?: string): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return isoDate ?? '—';
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function getRegionLabel(region: FilmStartRelease['region']): string {
  if (region === 'DE/AT') return 'DE & AT';
  if (region === 'AT') return 'Österreich (AT)';
  return 'Deutschland (DE)';
}

function getFetchMethodLabel(method: FilmStartsViewProps['fetchMethod']): string {
  switch (method) {
    case 'mixed':
      return 'Live-Internet (Google Suche & DE/AT-Filmportale)';
    case 'gemini-search':
      return 'Live-Internet (Google Search Grounding)';
    case 'live-web':
      return 'Live-Internet (DE & AT Filmportale)';
    default:
      return 'NAS-Zwischenspeicher';
  }
}

export const FilmStartsView: React.FC<FilmStartsViewProps> = ({
  releases,
  sources,
  lastFetchedAt,
  fetchMethod,
  fetchWarning,
  loading,
  refreshing,
  userFskLimit = 18,
  notificationMode,
  onUpdateNotificationMode,
  onRefreshFromInternet,
  onToggleFavorite,
  onSimulateReleaseNow,
  onPlayNasMediaId,
}) => {
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [savingNotifMode, setSavingNotifMode] = useState(false);
  const [tab, setTab] = useState<FilmTab>('all');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('Alle');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedFilmId, setSelectedFilmId] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);

  const selectedFilm = useMemo(
    () => releases.find((r) => r.id === selectedFilmId) ?? null,
    [releases, selectedFilmId]
  );

  useEffect(() => {
    if (!selectedFilm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedFilmId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedFilm]);

  const stats = useMemo(() => {
    const deCount = releases.filter((r) => r.region === 'DE' || r.region === 'DE/AT').length;
    const atCount = releases.filter((r) => r.region === 'AT' || r.region === 'DE/AT').length;
    const onNasCount = releases.filter((r) => r.nasMatch.availableOnNas).length;
    const favCount = releases.filter((r) => r.favorite.isFavorite).length;
    const releasedCount = releases.filter((r) => r.isReleasedNow).length;
    return {
      total: releases.length,
      deCount,
      atCount,
      onNasCount,
      favCount,
      releasedCount,
    };
  }, [releases]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return releases.filter((rel) => {
      if (tab === 'de' && rel.region !== 'DE' && rel.region !== 'DE/AT') return false;
      if (tab === 'at' && rel.region !== 'AT' && rel.region !== 'DE/AT') return false;
      if (tab === 'nas' && !rel.nasMatch.availableOnNas) return false;
      if (tab === 'favorites' && !rel.favorite.isFavorite) return false;
      if (tab === 'released' && !rel.isReleasedNow) return false;
      if (onlyFavorites && !rel.favorite.isFavorite) return false;

      if (channelFilter !== 'Alle') {
        if (channelFilter === 'Kino' && rel.channel === 'Streaming') return false;
        if (channelFilter === 'Streaming' && rel.channel === 'Kino') return false;
        if (channelFilter === 'Kino & Streaming' && rel.channel !== 'Kino & Streaming') return false;
      }

      if (q) {
        const hay = [
          rel.title,
          rel.genre,
          rel.providerOrDistributor,
          rel.director ?? '',
          rel.synopsis,
          ...rel.cast,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [releases, tab, onlyFavorites, channelFilter, searchQuery]);

  const handleAction = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  };

  const getFallbackCover = (rel: FilmStartRelease): string =>
    rel.coverUrl ??
    MARCENTE_ASSETS[rel.coverKey as keyof typeof MARCENTE_ASSETS] ??
    MARCENTE_ASSETS.posterDarkMatter;

  const activeNotifOption =
    FILM_NOTIFICATION_OPTIONS.find((opt) => opt.id === notificationMode) ??
    FILM_NOTIFICATION_OPTIONS[0];

  const handleSelectNotifMode = async (mode: FilmNotificationMode) => {
    if (savingNotifMode || mode === notificationMode) return;
    setSavingNotifMode(true);
    try {
      await onUpdateNotificationMode(mode);
    } finally {
      setSavingNotifMode(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Auf- und zuklappbare Benachrichtigungseinstellungen ganz oben */}
      <div className="bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden">
        <button
          type="button"
          aria-expanded={notifSettingsOpen}
          onClick={() => setNotifSettingsOpen((prev) => !prev)}
          className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-900/60 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-400/15 border border-amber-400/35 flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-sm font-semibold text-white">
                  Benachrichtigungseinstellungen
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-400/15 border border-amber-400/35 text-[11px] font-medium text-amber-300">
                  {activeNotifOption.label}
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                Festlegen, für welche Filmstarts Benachrichtigungen erstellt werden
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
            <span className="hidden sm:inline">
              {notifSettingsOpen ? 'Zuklappen' : 'Aufklappen'}
            </span>
            {notifSettingsOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-300" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-300" />
            )}
          </div>
        </button>

        {notifSettingsOpen && (
          <div className="px-4 pb-4 pt-3 border-t border-slate-800/80 space-y-3 bg-[#0F141E]/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-300 font-medium">
                Benachrichtigungen erhalten für:
              </p>
              {savingNotifMode && (
                <span className="text-[11px] text-amber-300 flex items-center gap-1.5">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  <span>Speichere Auswahl...</span>
                </span>
              )}
            </div>

            <div
              role="radiogroup"
              aria-label="Benachrichtigungseinstellungen für Filmstarts"
              className="grid grid-cols-1 md:grid-cols-2 gap-2.5"
            >
              {FILM_NOTIFICATION_OPTIONS.map((option) => {
                const isSelected = notificationMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={savingNotifMode}
                    onClick={() => void handleSelectNotifMode(option.id)}
                    className={`p-3 rounded-lg border text-left transition-colors flex items-start gap-2.5 disabled:opacity-70 ${
                      isSelected
                        ? 'bg-amber-400/15 border-amber-400/70 text-white'
                        : 'bg-[#121722] border-slate-800/90 text-slate-300 hover:border-slate-700 hover:text-white'
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'border-amber-400 bg-amber-400'
                          : 'border-slate-600 bg-[#0B0E14]'
                      }`}
                    >
                      {isSelected && <Check className="w-2.5 h-2.5 text-slate-950 stroke-[3]" />}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block text-xs font-semibold ${
                          isSelected ? 'text-amber-300' : 'text-white'
                        }`}
                      >
                        {option.label}
                      </span>
                      <span className="block text-[11px] text-slate-400 mt-0.5">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {userFskLimit < 18 && (
        <div
          role="status"
          className="px-4 py-3 rounded-xl bg-sky-950/35 border border-sky-500/40 text-xs text-sky-100 flex items-center gap-2.5"
        >
          <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="tabular-nums">
            <strong className="font-semibold text-sky-300">
              Altersfreigabe aktiv (Bis FSK {userFskLimit}):
            </strong>{' '}
            Es werden nur Filmstarts und NAS-Treffer bis einschließlich FSK {userFskLimit} angezeigt.
          </span>
        </div>
      )}

      {/* Internet-Aktualisierungsleiste */}
      <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="w-4 h-4 text-amber-400 shrink-0" />
            <h2 className="font-display text-sm font-semibold text-white">
              Live-Filmstarts für Deutschland (DE) &amp; Österreich (AT)
            </h2>
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[11px] text-emerald-300 font-medium">
              {getFetchMethodLabel(fetchMethod)}
            </span>
          </div>
          <p className="text-xs text-slate-400 tabular-nums">
            {lastFetchedAt
              ? `Zuletzt aus dem Internet aktualisiert: ${new Date(lastFetchedAt).toLocaleString('de-DE')}`
              : 'Noch keine Live-Abfrage durchgeführt.'}
            {sources.length > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowSources((s) => !s)}
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                >
                  {sources.length} Internet-Quellen {showSources ? 'ausblenden' : 'anzeigen'}
                </button>
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onRefreshFromInternet()}
          disabled={refreshing}
          className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          <span>{refreshing ? 'Lade aus dem Internet...' : 'Aus dem Internet aktualisieren'}</span>
        </button>
      </div>

      {showSources && sources.length > 0 && (
        <div className="p-4 bg-[#0F141E] border border-slate-800/80 rounded-xl space-y-2">
          <p className="text-xs font-semibold text-slate-200">
            Verwendete Internet-Quellen für Deutschland &amp; Österreich
          </p>
          <div className="flex flex-wrap gap-2">
            {sources.map((src, idx) => (
              <a
                key={`${src.uri}-${idx}`}
                href={src.uri}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700/80 text-xs text-slate-200 hover:text-amber-300 flex items-center gap-1.5 transition-colors"
              >
                <ExternalLink className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="truncate max-w-[260px]">{src.title}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {fetchWarning && (
        <div
          role="alert"
          className="px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-400/40 text-xs text-amber-200"
        >
          Hinweis beim Internet-Abruf: {fetchWarning}
        </div>
      )}

      {/* KPI-Karten */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Filmstarts (DE &amp; AT)</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.total}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
            DE: {stats.deCount} · AT: {stats.atCount}
          </p>
        </div>

        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Bereits auf deinem NAS</p>
          <p className="font-display text-2xl font-bold text-emerald-400 tabular-nums mt-1">
            {stats.onNasCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Direkt abspielbar</p>
        </div>

        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Als Favorit markiert</p>
          <p className="font-display text-2xl font-bold text-amber-400 tabular-nums mt-1">
            {stats.favCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Start-Benachrichtigung aktiv</p>
        </div>

        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Bereits gestartet</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.releasedCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Kino oder Streaming aktiv</p>
        </div>
      </div>

      {/* Filter- & Suchleiste */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#121722] border border-slate-800/80 rounded-lg w-fit">
          {(
            [
              { id: 'all', label: 'Alle (DE & AT)' },
              { id: 'de', label: 'Deutschland (DE)' },
              { id: 'at', label: 'Österreich (AT)' },
              { id: 'nas', label: 'Auf dem NAS' },
              { id: 'favorites', label: 'Favoriten' },
              { id: 'released', label: 'Jetzt gestartet' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id
                  ? 'bg-amber-400 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-pressed={onlyFavorites}
            onClick={() => setOnlyFavorites((prev) => !prev)}
            className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              onlyFavorites
                ? 'bg-amber-400/15 border-amber-400/60 text-amber-300'
                : 'bg-[#121722] border-slate-800/80 text-slate-300 hover:border-slate-700 hover:text-white'
            }`}
          >
            <Star
              className={`w-3.5 h-3.5 ${
                onlyFavorites ? 'fill-amber-400 text-amber-400' : 'text-amber-400'
              }`}
            />
            <span>Nur Favoriten</span>
            <span className="tabular-nums opacity-80">({stats.favCount})</span>
          </button>

          <div className="relative flex-1 sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Titel, Genre, Regie suchen..."
              className="w-full bg-[#121722] border border-slate-800/80 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>Format:</span>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as ChannelFilter)}
              className="bg-[#121722] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
            >
              <option value="Alle">Alle (Kino &amp; Streaming)</option>
              <option value="Kino">Kino</option>
              <option value="Streaming">Streaming</option>
              <option value="Kino & Streaming">Kino &amp; Streaming</option>
            </select>
          </label>
        </div>
      </div>

      {/* Ladezustand oder leere Ansicht */}
      {loading && releases.length === 0 ? (
        <div className="p-10 bg-[#121722] border border-slate-800/80 rounded-xl text-center space-y-2">
          <RefreshCw className="w-6 h-6 text-amber-400 animate-spin mx-auto" />
          <p className="text-sm font-medium text-white">
            Filmstarts für Deutschland und Österreich werden aus dem Internet geladen...
          </p>
          <p className="text-xs text-slate-400">
            Anschließend wird jeder Titel automatisch mit deinem NAS-Katalog abgeglichen.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-8 bg-[#121722] border border-slate-800/80 rounded-xl text-center space-y-2">
          <Clapperboard className="w-6 h-6 text-slate-400 mx-auto" />
          <p className="text-sm font-medium text-white">
            Keine Filmstarts für den gewählten Filter gefunden.
          </p>
          <p className="text-xs text-slate-400">
            Passe den Filter an oder lade aktuelle Kinostarts über „Aus dem Internet aktualisieren“.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((rel) => {
            const isBusy = busyId === rel.id;
            const poster = rel.posterUrl || getFallbackCover(rel);
            return (
              <article
                key={rel.id}
                className="bg-[#121722] border border-slate-800/80 hover:border-slate-700 rounded-xl p-4 flex gap-4 transition-colors"
              >
                {/* Poster */}
                <button
                  type="button"
                  onClick={() => setSelectedFilmId(rel.id)}
                  className="w-24 h-36 rounded-lg overflow-hidden border border-slate-800 shrink-0 bg-[#0B0E14] relative group text-left"
                  title="Details zum Filmstart öffnen"
                >
                  <img
                    src={poster}
                    alt={`Filmplakat von ${rel.title}`}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      const fallback = getFallbackCover(rel);
                      if (e.currentTarget.src !== fallback) {
                        e.currentTarget.src = fallback;
                      }
                    }}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </button>

                {/* Inhalt */}
                <div className="flex-1 min-w-0 flex flex-col justify-between gap-3">
                  <div className="space-y-1.5">
                    {/* Badges oben: Region, Startstatus & NAS-Status */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="px-2 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-[11px] font-medium text-slate-200">
                        {getRegionLabel(rel.region)}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-[#0B0E14] border border-slate-800 text-[11px] text-amber-300">
                        {rel.channel}
                      </span>
                      {rel.isReleasedNow ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[11px] text-emerald-300 font-medium">
                          Gestartet
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-amber-400/10 border border-amber-400/30 text-[11px] text-amber-300">
                          Demnächst
                        </span>
                      )}
                      {rel.nasMatch.availableOnNas ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-[11px] font-semibold text-emerald-200 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-emerald-300" />
                          <span>Auf NAS verfügbar</span>
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-slate-900/90 border border-slate-800 text-[11px] text-slate-400 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-slate-500" />
                          <span>Nicht auf dem NAS</span>
                        </span>
                      )}
                    </div>

                    {/* Titel */}
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedFilmId(rel.id)}
                        className="font-display text-base font-semibold text-white hover:text-amber-300 text-left leading-snug transition-colors"
                      >
                        {rel.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedFilmId(rel.id)}
                        aria-label={`Details zu ${rel.title}`}
                        className="p-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white shrink-0"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Startdatum DE / AT & Genre */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 tabular-nums">
                      <span className="flex items-center gap-1 text-slate-200">
                        <Calendar className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        {rel.releaseDateDE && rel.releaseDateAT ? (
                          <span>
                            DE: {formatDeDate(rel.releaseDateDE)} · AT:{' '}
                            {formatDeDate(rel.releaseDateAT)}
                          </span>
                        ) : (
                          <span>Start: {formatDeDate(rel.releaseDate)}</span>
                        )}
                      </span>
                      <span className="truncate">{rel.genre}</span>
                    </div>

                    <p className="text-xs text-slate-300 line-clamp-2">{rel.synopsis}</p>
                  </div>

                  {/* Aktionen: Favorit + Benachrichtigung + NAS-Wiedergabe */}
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/70">
                    {rel.favorite.isFavorite ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void handleAction(rel.id, () => onToggleFavorite(rel.title, 'unpin'))
                        }
                        className="px-2.5 py-1.5 rounded-lg bg-amber-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 hover:bg-amber-300 transition-colors"
                      >
                        <Star className="w-3.5 h-3.5 fill-current" />
                        <span>Favorit · Benachrichtigung an</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void handleAction(rel.id, () => onToggleFavorite(rel.title, 'pin'))
                        }
                        className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors"
                      >
                        <Star className="w-3.5 h-3.5 text-amber-400" />
                        <span>Als Favorit markieren</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        void handleAction(rel.id, () => onSimulateReleaseNow(rel.id))
                      }
                      title="Startbenachrichtigung sofort prüfen & auslösen"
                      className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-amber-300 flex items-center gap-1.5 transition-colors"
                    >
                      <BellRing className="w-3.5 h-3.5 text-amber-400" />
                      <span>Start benachrichtigen</span>
                    </button>

                    {rel.nasMatch.availableOnNas && rel.nasMatch.nasMediaId && (
                      <button
                        type="button"
                        onClick={() => onPlayNasMediaId(rel.nasMatch.nasMediaId!)}
                        className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 transition-colors ml-auto"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Auf NAS abspielen</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Detail-Modal */}
      {selectedFilm && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="filmstart-detail-title"
          onClick={() => setSelectedFilmId(null)}
        >
          <div
            className="w-full max-w-[min(42rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-slate-800/80 bg-[#0F141E] flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <Film className="w-4 h-4 text-amber-400 shrink-0" />
                <h3
                  id="filmstart-detail-title"
                  className="font-display text-base sm:text-lg font-semibold text-white truncate"
                >
                  {selectedFilm.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFilmId(null)}
                aria-label="Details schließen"
                className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-5">
              <div className="flex flex-col sm:flex-row gap-5">
                <img
                  src={selectedFilm.posterUrl || getFallbackCover(selectedFilm)}
                  alt={`Poster von ${selectedFilm.title}`}
                  referrerPolicy="no-referrer"
                  decoding="async"
                  onError={(e) => {
                    const fallback = getFallbackCover(selectedFilm);
                    if (e.currentTarget.src !== fallback) {
                      e.currentTarget.src = fallback;
                    }
                  }}
                  className="w-32 h-48 rounded-xl object-cover border border-slate-800 shrink-0 bg-[#0B0E14]"
                />

                <div className="flex-1 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2.5 py-1 rounded bg-slate-800 text-slate-200 font-medium">
                      {getRegionLabel(selectedFilm.region)}
                    </span>
                    <span className="px-2.5 py-1 rounded bg-[#0B0E14] border border-slate-800 text-amber-300">
                      {selectedFilm.channel} · {selectedFilm.providerOrDistributor}
                    </span>
                    {typeof selectedFilm.fsk === 'number' && (
                      <span className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300 tabular-nums">
                        FSK {selectedFilm.fsk}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="p-3 rounded-xl bg-[#0B0E14] border border-slate-800/80">
                      <p className="text-slate-400">Startdatum Deutschland (DE)</p>
                      <p className="text-sm font-semibold text-white tabular-nums mt-0.5">
                        {selectedFilm.releaseDateDE
                          ? formatDeDate(selectedFilm.releaseDateDE)
                          : selectedFilm.region === 'AT'
                            ? 'Nur AT-Termin gemeldet'
                            : formatDeDate(selectedFilm.releaseDate)}
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0B0E14] border border-slate-800/80">
                      <p className="text-slate-400">Startdatum Österreich (AT)</p>
                      <p className="text-sm font-semibold text-white tabular-nums mt-0.5">
                        {selectedFilm.releaseDateAT
                          ? formatDeDate(selectedFilm.releaseDateAT)
                          : selectedFilm.region === 'DE'
                            ? 'Noch kein AT-Termin gemeldet'
                            : formatDeDate(selectedFilm.releaseDate)}
                      </p>
                    </div>
                  </div>

                  {/* NAS-Verfügbarkeit Box */}
                  <div
                    className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      selectedFilm.nasMatch.availableOnNas
                        ? 'bg-emerald-500/10 border-emerald-500/40'
                        : 'bg-[#0B0E14] border-slate-800/80'
                    }`}
                  >
                    <div className="space-y-0.5 min-w-0">
                      <p
                        className={`font-semibold flex items-center gap-1.5 ${
                          selectedFilm.nasMatch.availableOnNas
                            ? 'text-emerald-300'
                            : 'text-slate-300'
                        }`}
                      >
                        {selectedFilm.nasMatch.availableOnNas ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        ) : (
                          <HardDrive className="w-4 h-4 text-slate-500 shrink-0" />
                        )}
                        <span>{selectedFilm.nasMatch.statusLabel}</span>
                      </p>
                      {selectedFilm.nasMatch.nasPath && (
                        <p className="text-[11px] font-mono text-slate-300 truncate">
                          {selectedFilm.nasMatch.nasPath}
                        </p>
                      )}
                    </div>
                    {selectedFilm.nasMatch.availableOnNas &&
                      selectedFilm.nasMatch.nasMediaId && (
                        <button
                          type="button"
                          onClick={() => {
                            const id = selectedFilm.nasMatch.nasMediaId!;
                            setSelectedFilmId(null);
                            onPlayNasMediaId(id);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold flex items-center gap-1.5 shrink-0"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Jetzt abspielen</span>
                        </button>
                      )}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-slate-300">Handlung &amp; Infos</p>
                <p className="text-sm text-slate-200 leading-relaxed">{selectedFilm.synopsis}</p>
                <p className="text-xs text-slate-400">Genre: {selectedFilm.genre}</p>
                {selectedFilm.director && (
                  <p className="text-xs text-slate-400">Regie: {selectedFilm.director}</p>
                )}
              </div>

              {selectedFilm.cast.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-amber-400" />
                    <span>Besetzung</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedFilm.cast.map((actor) => (
                      <span
                        key={actor}
                        className="px-2.5 py-1 rounded-md bg-[#0B0E14] border border-slate-800 text-xs text-slate-200"
                      >
                        {actor}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedFilm.favorite.isFavorite ? (
                    <button
                      type="button"
                      onClick={() =>
                        void handleAction(selectedFilm.id, () =>
                          onToggleFavorite(selectedFilm.title, 'unpin')
                        )
                      }
                      className="px-3.5 py-2 rounded-lg bg-amber-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Favorit entfernen</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void handleAction(selectedFilm.id, () =>
                          onToggleFavorite(selectedFilm.title, 'pin')
                        )
                      }
                      className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Star className="w-3.5 h-3.5" />
                      <span>Als Favorit markieren</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      void handleAction(selectedFilm.id, () =>
                        onToggleFavorite(selectedFilm.title, 'mute')
                      )
                    }
                    className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-slate-300 flex items-center gap-1.5"
                  >
                    <VolumeX className="w-3.5 h-3.5" />
                    <span>Stummschalten</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void handleAction(selectedFilm.id, () =>
                        onSimulateReleaseNow(selectedFilm.id)
                      )
                    }
                    className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-amber-300 flex items-center gap-1.5"
                  >
                    <BellRing className="w-3.5 h-3.5" />
                    <span>Start-Benachrichtigung auslösen</span>
                  </button>
                </div>

                {selectedFilm.sourceUrl && (
                  <a
                    href={selectedFilm.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
                  >
                    <span>Quelle ({selectedFilm.sourceLabel || 'Web'})</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
