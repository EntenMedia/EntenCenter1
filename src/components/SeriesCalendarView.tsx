import React, { useEffect, useMemo, useState } from 'react';
import {
  Star,
  Sparkles,
  VolumeX,
  Check,
  BellRing,
  Tv,
  Calendar,
  Plus,
  X,
  Trash2,
  Users,
  Info,
  Ban,
  CheckCircle2,
  ShieldCheck,
  HardDrive,
  Search,
  Play,
  RefreshCw,
  Globe,
  Bell,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import {
  CalendarNotificationMode,
  CalendarRelease,
  FilmGroundSource,
  FskLevel,
  SeriesCalendarResponse,
  SeriesLookupCandidate,
  SeriesProductionStatus,
  StreamingProviderDE,
} from '../types/marcente';
import { GERMAN_PROVIDER_GROUPS } from '../data/germanProviders';

export interface ManualSeriesInput {
  title: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  releaseDate?: string;
  provider?: StreamingProviderDE;
  genre?: string;
  synopsis?: string;
  cast?: string[];
  coverUrl?: string;
  pinAsFavorite: boolean;
  seriesStatus?: SeriesProductionStatus;
  fsk?: FskLevel;
}

interface SeriesCalendarViewProps {
  releases: CalendarRelease[];
  sources?: FilmGroundSource[];
  lastFetchedAt?: string | null;
  fetchMethod?: SeriesCalendarResponse['fetchMethod'];
  fetchWarning?: string | null;
  refreshing?: boolean;
  userFskLimit?: FskLevel;
  notificationMode: CalendarNotificationMode;
  onUpdateNotificationMode: (mode: CalendarNotificationMode) => Promise<void>;
  onRefreshFromInternet?: () => Promise<void>;
  onToggleFavorite: (seriesTitle: string, action: 'pin' | 'mute' | 'auto') => Promise<void>;
  onSimulateReleaseNow: (releaseId: string) => Promise<void>;
  onSearchSeriesOnline: (query: string) => Promise<SeriesLookupCandidate[]>;
  onAddManualSeries: (input: ManualSeriesInput) => Promise<void>;
  onDeleteManualSeries: (releaseId: string) => Promise<void>;
  onPlayNasMediaId: (mediaId: string) => void;
}

const CALENDAR_NOTIFICATION_OPTIONS: Array<{
  id: CalendarNotificationMode;
  label: string;
  description: string;
}> = [
  {
    id: 'favorites_all',
    label: 'Nur für Favoriten',
    description: 'Neue Serien und neue Folgen deiner favorisierten Serien',
  },
  {
    id: 'favorites_new_series',
    label: 'Nur für Favoriten neue Serien',
    description: 'Nur Serien-Neustarts (Staffel 1, Folge 1) deiner Favoriten',
  },
  {
    id: 'favorites_new_episodes',
    label: 'Nur für Favoriten neue Folgen',
    description: 'Nur neue Folgen & neue Staffeln deiner Favoriten',
  },
  {
    id: 'all',
    label: 'Alle',
    description: 'Alle neuen Serien und neuen Folgen im Serienkalender',
  },
  {
    id: 'all_new_series',
    label: 'Alle nur neue Serien',
    description: 'Alle Serien-Neustarts (Staffel 1, Folge 1) im Serienkalender',
  },
  {
    id: 'all_new_episodes',
    label: 'Alle nur neue Folgen',
    description: 'Alle neuen Folgen & neuen Staffeln im Serienkalender',
  },
];

type CalendarTab = 'all' | 'nas' | 'favorites' | 'available';

function getSeriesFetchMethodLabel(method?: SeriesCalendarResponse['fetchMethod']): string {
  switch (method) {
    case 'gemini-search':
      return 'Google Live-Suche';
    case 'mixed':
      return 'Google Suche + TV & Streaming DE';
    case 'live-web':
      return 'Live-TV & Streaming DE';
    default:
      return 'NAS-Zwischenspeicher';
  }
}

export const SeriesCalendarView: React.FC<SeriesCalendarViewProps> = ({
  releases,
  sources = [],
  lastFetchedAt = null,
  fetchMethod = 'cache',
  fetchWarning = null,
  refreshing = false,
  userFskLimit = 18,
  notificationMode,
  onUpdateNotificationMode,
  onRefreshFromInternet,
  onToggleFavorite,
  onSimulateReleaseNow,
  onSearchSeriesOnline,
  onAddManualSeries,
  onDeleteManualSeries,
  onPlayNasMediaId,
}) => {
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [savingNotifMode, setSavingNotifMode] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [tab, setTab] = useState<CalendarTab>('all');
  const [providerFilter, setProviderFilter] = useState<'Alle' | StreamingProviderDE>('Alle');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [manualFallbackProvider, setManualFallbackProvider] = useState<StreamingProviderDE>('Netflix');
  const [pinAsFavorite, setPinAsFavorite] = useState(true);
  const [searchingOnline, setSearchingOnline] = useState(false);
  const [submittingManual, setSubmittingManual] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [noMatchTitle, setNoMatchTitle] = useState<string | null>(null);
  const [lookupCandidates, setLookupCandidates] = useState<SeriesLookupCandidate[]>([]);
  const [showLookupModal, setShowLookupModal] = useState(false);

  const selectedRelease = useMemo(
    () => releases.find((r) => r.id === selectedReleaseId) ?? null,
    [releases, selectedReleaseId]
  );

  useEffect(() => {
    if (!selectedRelease && !showLookupModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showLookupModal) setShowLookupModal(false);
        else if (selectedRelease) setSelectedReleaseId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedRelease, showLookupModal]);

  const filtered = useMemo(() => {
    return releases.filter((rel) => {
      if (tab === 'nas' && !rel.nasMatch.availableOnNas && !rel.nasMatch.matched) return false;
      if (tab === 'favorites' && !rel.favorite.isFavorite) return false;
      if (tab === 'available' && !rel.isAvailableNow) return false;
      if (onlyFavorites && !rel.favorite.isFavorite) return false;
      if (providerFilter !== 'Alle' && rel.provider !== providerFilter) return false;
      return true;
    });
  }, [releases, tab, onlyFavorites, providerFilter]);

  const stats = useMemo(() => {
    const matched = releases.filter((r) => r.nasMatch.availableOnNas || r.nasMatch.matched).length;
    const favorites = releases.filter((r) => r.favorite.isFavorite).length;
    const available = releases.filter((r) => r.isAvailableNow).length;
    return { total: releases.length, matched, favorites, available };
  }, [releases]);

  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rel of releases) {
      counts.set(rel.provider, (counts.get(rel.provider) ?? 0) + 1);
    }
    return counts;
  }, [releases]);

  const handleAction = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  };

  const resetManualForm = () => {
    setNewTitle('');
    setLookupError(null);
    setNoMatchTitle(null);
    setLookupCandidates([]);
    setShowLookupModal(false);
    setShowAddForm(false);
  };

  const addSeriesFromCandidate = async (candidate: SeriesLookupCandidate) => {
    setSubmittingManual(true);
    setLookupError(null);
    try {
      await onAddManualSeries({
        title: candidate.title,
        season: candidate.season,
        episode: candidate.episode,
        episodeTitle: candidate.episodeTitle,
        releaseDate: candidate.releaseDate,
        provider: candidate.provider,
        genre: candidate.genre,
        synopsis: candidate.synopsis,
        cast: candidate.cast,
        coverUrl: candidate.coverUrl,
        pinAsFavorite,
        seriesStatus: candidate.seriesStatus,
        fsk: candidate.fsk,
      });
      resetManualForm();
    } catch {
      setLookupError('Serie konnte nicht auf dem NAS gespeichert werden.');
    } finally {
      setSubmittingManual(false);
    }
  };

  const addSeriesTitleOnly = async (rawTitle: string) => {
    const clean = rawTitle.trim();
    if (!clean) return;
    setSubmittingManual(true);
    setLookupError(null);
    try {
      await onAddManualSeries({
        title: clean,
        provider: manualFallbackProvider,
        pinAsFavorite,
      });
      resetManualForm();
    } catch {
      setLookupError('Serie konnte nicht auf dem NAS gespeichert werden.');
    } finally {
      setSubmittingManual(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newTitle.trim();
    if (!clean || searchingOnline || submittingManual) return;

    setLookupError(null);
    setNoMatchTitle(null);
    setSearchingOnline(true);
    try {
      const candidates = await onSearchSeriesOnline(clean);
      if (candidates.length === 1) {
        await addSeriesFromCandidate(candidates[0]);
        return;
      }
      if (candidates.length > 1) {
        setLookupCandidates(candidates);
        setShowLookupModal(true);
        return;
      }
      setNoMatchTitle(clean);
    } catch {
      setLookupError('Online-Suche fehlgeschlagen. Du kannst den Titel trotzdem direkt hinzufügen.');
      setNoMatchTitle(clean);
    } finally {
      setSearchingOnline(false);
    }
  };

  const activeNotifOption =
    CALENDAR_NOTIFICATION_OPTIONS.find((opt) => opt.id === notificationMode) ??
    CALENDAR_NOTIFICATION_OPTIONS[0];

  const handleSelectNotifMode = async (mode: CalendarNotificationMode) => {
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
                Festlegen, für welche Serien und Folgen Benachrichtigungen erstellt werden
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
              aria-label="Benachrichtigungseinstellungen für den Serienkalender"
              className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5"
            >
              {CALENDAR_NOTIFICATION_OPTIONS.map((option) => {
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
            Der Serienkalender zeigt nur Titel von FSK 0 bis FSK {userFskLimit} an.
          </span>
        </div>
      )}

      {/* Internet-Aktualisierungsleiste */}
      <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="w-4 h-4 text-amber-400 shrink-0" />
            <h2 className="font-display text-sm font-semibold text-white">
              Live-TV- &amp; Streaming-Serienkalender (Deutschland)
            </h2>
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[11px] text-emerald-300 font-medium">
              {getSeriesFetchMethodLabel(fetchMethod)}
            </span>
          </div>
          <p className="text-xs text-slate-400 tabular-nums">
            {lastFetchedAt
              ? `Zuletzt aus dem Internet aktualisiert: ${new Date(lastFetchedAt).toLocaleString('de-DE')}`
              : 'Noch keine manuelle Internet-Aktualisierung in dieser Sitzung durchgeführt.'}
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

        {onRefreshFromInternet && (
          <button
            type="button"
            onClick={() => void onRefreshFromInternet()}
            disabled={refreshing}
            className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span>
              {refreshing
                ? 'Aktualisiere aus dem Internet...'
                : 'Informationen aus dem Internet manuell aktualisieren'}
            </span>
          </button>
        )}
      </div>

      {showSources && sources.length > 0 && (
        <div className="p-4 bg-[#0F141E] border border-slate-800/80 rounded-xl space-y-2">
          <p className="text-xs font-semibold text-slate-200">
            Verwendete Internet-Quellen für den TV-Serienkalender
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

      {/* KPI-Zusammenfassung */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">DE-Neustarts &amp; Folgen</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.total}
          </p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Bereits auf deinem NAS</p>
          <p className="font-display text-2xl font-bold text-emerald-400 tabular-nums mt-1">
            {stats.matched}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Serie, Staffel oder Folge</p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Aktive Favoriten (Auto + Manuell)</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.favorites}
          </p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Heute im DE-Raum verfügbar</p>
          <p className="font-display text-2xl font-bold text-emerald-400 tabular-nums mt-1">
            {stats.available}
          </p>
        </div>
      </div>

      {/* Filterleiste + Manuell-Hinzufügen-Button */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#121722] border border-slate-800/80 rounded-lg w-fit">
          {(
            [
              { id: 'all', label: 'Alle DE-Starts' },
              { id: 'nas', label: 'NAS-Abgleich' },
              { id: 'favorites', label: 'Favoriten' },
              { id: 'available', label: 'Jetzt verfügbar' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id
                  ? 'bg-amber-400 text-slate-950'
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
            <span className="tabular-nums opacity-80">({stats.favorites})</span>
          </button>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <span>Anbieter &amp; Sender:</span>
            <select
              value={providerFilter}
              onChange={(e) =>
                setProviderFilter(e.target.value as 'Alle' | StreamingProviderDE)
              }
              className="bg-[#121722] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400 max-w-[250px]"
            >
              <option value="Alle">Alle Anbieter &amp; Sender</option>
              {GERMAN_PROVIDER_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.providers.map((p) => {
                    const count = providerCounts.get(p) ?? 0;
                    return (
                      <option key={p} value={p}>
                        {count > 0 ? `${p} (${count})` : p}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setShowAddForm((prev) => !prev)}
            className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {showAddForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{showAddForm ? 'Schließen' : 'Serie manuell hinzufügen'}</span>
          </button>
        </div>
      </div>

      {/* Formular zum manuellen Hinzufügen einer Serie (nur Titel erforderlich + automatische Netzsuche) */}
      {showAddForm && (
        <form
          onSubmit={handleManualSubmit}
          className="p-6 bg-[#121722] border border-amber-400/40 rounded-xl space-y-4"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-white flex items-center gap-2">
                <Globe className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Serie per Titel suchen &amp; hinzufügen</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Es reicht, wenn du nur den Serientitel eingibst — EntenCenter sucht automatisch im Netz
                nach Staffel, Starttermin, Anbieter &amp; Beschreibung. Bei mehreren Treffern
                erscheint ein Auswahlfenster.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor="manual-series-title" className="block text-xs text-slate-300 mb-1.5">
                Serientitel
              </label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="manual-series-title"
                  type="text"
                  required
                  autoFocus
                  value={newTitle}
                  onChange={(e) => {
                    setNewTitle(e.target.value);
                    setNoMatchTitle(null);
                    setLookupError(null);
                  }}
                  placeholder="Nur Titel eingeben, z. B. Dark, Severance, Fallout, Der Schwarm..."
                  className="w-full pl-10 pr-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            {lookupError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-amber-500/10 border border-amber-400/40 text-xs text-amber-200"
              >
                {lookupError}
              </div>
            )}

            {noMatchTitle && (
              <div className="p-3.5 rounded-lg bg-[#0B0E14] border border-slate-700/80 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-300">
                  Keine passenden Serien im Netz für{' '}
                  <strong className="text-white">„{noMatchTitle}“</strong> gefunden. Anbieter
                  optional wählen und direkt anlegen:
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Anbieter oder TV-Sender wählen"
                    value={manualFallbackProvider}
                    onChange={(e) =>
                      setManualFallbackProvider(e.target.value as StreamingProviderDE)
                    }
                    className="bg-[#121722] border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {GERMAN_PROVIDER_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.providers.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={submittingManual}
                    onClick={() => void addSeriesTitleOnly(noMatchTitle)}
                    className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold whitespace-nowrap"
                  >
                    Trotzdem nur mit Titel hinzufügen
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-800/70">
            <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={pinAsFavorite}
                onChange={(e) => setPinAsFavorite(e.target.checked)}
                className="accent-amber-400 w-4 h-4"
              />
              <span>Direkt als manuellen Favoriten merken (löst Alert bei Start aus)</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetManualForm}
                className="px-3.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-slate-300 hover:text-white"
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={searchingOnline || submittingManual || !newTitle.trim()}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5"
              >
                {searchingOnline || submittingManual ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Search className="w-3.5 h-3.5" />
                )}
                <span>
                  {searchingOnline
                    ? 'Suche im Netz...'
                    : submittingManual
                      ? 'Speichere auf NAS...'
                      : 'Im Netz suchen & hinzufügen'}
                </span>
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Kalender-Liste mit Covern & Klick-Pop-up */}
      <div className="bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden divide-y divide-slate-800/80">
        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-300">
              Keine Einträge für diese Filterauswahl vorhanden.
            </p>
          </div>
        ) : (
          filtered.map((rel) => {
            const isBusy = busyId === rel.id;
            return (
              <div
                key={rel.id}
                className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-900/40 transition-colors"
              >
                {/* Klickbarer Serien-Bereich (Cover + Titel + Metadaten -> öffnet Info-Pop-up) */}
                <button
                  type="button"
                  onClick={() => setSelectedReleaseId(rel.id)}
                  className="flex items-start sm:items-center gap-4 min-w-0 text-left flex-1 group"
                >
                  <div className="relative w-16 h-24 sm:w-20 sm:h-28 rounded-lg overflow-hidden bg-slate-900 border border-slate-800 group-hover:border-amber-400/70 shrink-0 transition-colors">
                    {rel.coverUrl ? (
                      <img
                        src={rel.coverUrl}
                        alt={rel.seriesTitle}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-600">
                        <Tv className="w-6 h-6" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 min-w-0 flex-1">
                    {/* Badges oben inkl. NAS-Status wie bei den Filmstarts */}
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                      <span className="font-mono tabular-nums text-slate-300 flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-500" />
                        {rel.releaseDate}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-white flex items-center gap-1">
                        <Tv className="w-3.5 h-3.5 text-amber-400" />
                        {rel.provider}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{rel.genre}</span>
                      {rel.fsk !== undefined && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums text-slate-300">FSK {rel.fsk}</span>
                        </>
                      )}
                      {rel.isSeasonPremiere && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-300 font-medium">Staffelneustart</span>
                        </>
                      )}
                      {rel.isAvailableNow && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-emerald-400 font-medium">Verfügbar</span>
                        </>
                      )}
                      {rel.seriesStatus === 'canceled' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-rose-400 font-semibold">Serie eingestellt</span>
                        </>
                      )}
                      {rel.seriesStatus === 'ended' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-sky-300 font-semibold">Serie beendet</span>
                        </>
                      )}

                      {rel.nasMatch.episodeOnNas ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-[11px] font-semibold text-emerald-200 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-emerald-300" />
                          <span>Auf NAS verfügbar</span>
                        </span>
                      ) : rel.nasMatch.seasonOnNas ? (
                        <span className="px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/50 text-[11px] font-semibold text-sky-200 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-sky-300" />
                          <span>Staffel {rel.seasonNumber} auf NAS · Neue Folge fehlt</span>
                        </span>
                      ) : rel.nasMatch.seriesOnNas ? (
                        <span className="px-2 py-0.5 rounded bg-amber-400/15 border border-amber-400/45 text-[11px] font-semibold text-amber-200 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-amber-300" />
                          <span>Serie auf NAS · Staffel {rel.seasonNumber} fehlt</span>
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-slate-900/90 border border-slate-800 text-[11px] text-slate-400 flex items-center gap-1">
                          <HardDrive className="w-3 h-3 text-slate-500" />
                          <span>Nicht auf dem NAS</span>
                        </span>
                      )}
                    </div>

                    <h3 className="font-display text-lg font-semibold text-white group-hover:text-amber-300 transition-colors">
                      {rel.seriesTitle}{' '}
                      <span className="font-mono text-sm font-normal text-slate-300 tabular-nums">
                        S{String(rel.seasonNumber).padStart(2, '0')}E
                        {String(rel.episodeNumber).padStart(2, '0')}
                      </span>
                      <span className="text-sm font-normal text-slate-400">
                        {' '}
                        — {rel.episodeTitle}
                      </span>
                    </h3>

                    <p className="text-xs text-slate-400 line-clamp-1">{rel.synopsis}</p>

                    {/* Granulare NAS-Verfügbarkeit: Serie / Staffel / Neue Folge */}
                    <div className="flex flex-wrap items-center gap-2 text-[11px] pt-0.5">
                      <span
                        className={`px-2 py-0.5 rounded border inline-flex items-center gap-1 ${
                          rel.nasMatch.seriesOnNas
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300'
                            : 'bg-[#0B0E14] border-slate-800 text-slate-400'
                        }`}
                      >
                        <HardDrive className="w-3 h-3" />
                        <span>
                          Serie: {rel.nasMatch.seriesOnNas ? 'Auf NAS' : 'Nicht auf NAS'}
                        </span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded border inline-flex items-center gap-1 tabular-nums ${
                          rel.nasMatch.seasonOnNas
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300'
                            : 'bg-[#0B0E14] border-slate-800 text-slate-400'
                        }`}
                      >
                        <span>
                          Staffel {rel.seasonNumber}:{' '}
                          {rel.nasMatch.seasonOnNas
                            ? `Vorhanden (${rel.nasMatch.seasonEpisodesOnNasCount})`
                            : 'Noch nicht'}
                        </span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded border inline-flex items-center gap-1 tabular-nums ${
                          rel.nasMatch.episodeOnNas
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300'
                            : 'bg-[#0B0E14] border-slate-800 text-slate-400'
                        }`}
                      >
                        <span>
                          Folge S{String(rel.seasonNumber).padStart(2, '0')}E
                          {String(rel.episodeNumber).padStart(2, '0')}:{' '}
                          {rel.nasMatch.episodeOnNas ? 'Vorhanden' : 'Noch nicht'}
                        </span>
                      </span>
                      <span className="text-slate-400">{rel.favorite.reason}</span>
                      <span className="inline-flex items-center gap-1 text-amber-400/90 font-medium">
                        <Info className="w-3 h-3" />
                        <span>Inhalt &amp; Schauspieler</span>
                      </span>
                    </div>
                  </div>
                </button>

                {/* Favoriten, Test-Auslöser & NAS-Wiedergabe */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {rel.nasMatch.availableOnNas && rel.nasMatch.nasMediaId && (
                    <button
                      type="button"
                      onClick={() => onPlayNasMediaId(rel.nasMatch.nasMediaId!)}
                      className="px-3 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-xs font-semibold text-emerald-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Auf NAS abspielen</span>
                    </button>
                  )}

                  {rel.favorite.isFavorite ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(rel.id, () =>
                          onToggleFavorite(
                            rel.seriesTitle,
                            rel.favorite.source === 'manual' ? 'auto' : 'mute'
                          )
                        )
                      }
                      className="px-3 py-2 rounded-lg bg-amber-400/15 border border-amber-400/40 text-amber-300 hover:bg-amber-400/25 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      {rel.favorite.source === 'auto' ? (
                        <Sparkles className="w-3.5 h-3.5" />
                      ) : (
                        <Star className="w-3.5 h-3.5 fill-current" />
                      )}
                      <span>
                        {rel.favorite.source === 'auto'
                          ? 'Auto-Favorit (NAS)'
                          : 'Manueller Favorit'}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(rel.id, () => onToggleFavorite(rel.seriesTitle, 'pin'))
                      }
                      className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Star className="w-3.5 h-3.5" />
                      <span>Manuell favorisieren</span>
                    </button>
                  )}

                  {rel.favorite.isFavorite && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(rel.id, () => onToggleFavorite(rel.seriesTitle, 'mute'))
                      }
                      title="Benachrichtigungen für diese Serie stummschalten"
                      className="px-2.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-red-300 text-xs transition-colors flex items-center gap-1 whitespace-nowrap"
                    >
                      <VolumeX className="w-3.5 h-3.5" />
                      <span>Stumm</span>
                    </button>
                  )}

                  {!rel.isAvailableNow ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(rel.id, () => onSimulateReleaseNow(rel.id))
                      }
                      className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 hover:border-emerald-500/60 text-slate-200 hover:text-emerald-300 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <BellRing className="w-3.5 h-3.5" />
                      <span>Release heute simulieren</span>
                    </button>
                  ) : (
                    <span className="px-3 py-2 text-xs text-emerald-400 flex items-center gap-1 whitespace-nowrap">
                      <Check className="w-3.5 h-3.5" />
                      <span>Alert aktiv</span>
                    </span>
                  )}

                  {rel.id.startsWith('de-manual-') && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleAction(rel.id, () => onDeleteManualSeries(rel.id))}
                      title="Manuell hinzugefügte Serie entfernen"
                      aria-label={`${rel.seriesTitle} entfernen`}
                      className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-red-300 hover:border-red-900/60 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Serien-Detail Pop-up (Cover, Inhalt & Schauspieler) */}
      {selectedRelease && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          onClick={() => setSelectedReleaseId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="series-popup-title"
            className="w-full max-w-[min(42rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col sm:flex-row">
              {/* Großes Cover links im Pop-up */}
              <div className="w-28 sm:w-52 aspect-[3/4] sm:aspect-auto sm:min-h-[300px] mx-auto sm:mx-0 mt-4 sm:mt-0 rounded-xl sm:rounded-none overflow-hidden bg-slate-900 shrink-0 relative">
                {selectedRelease.coverUrl ? (
                  <img
                    src={selectedRelease.coverUrl}
                    alt={selectedRelease.seriesTitle}
                    referrerPolicy="no-referrer"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-600">
                    <Tv className="w-10 h-10" />
                  </div>
                )}
              </div>

              {/* Infos: Inhalt & Schauspieler */}
              <div className="flex-1 p-4 sm:p-6 flex flex-col justify-between gap-4 sm:gap-5 min-w-0">
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-amber-400">
                        {selectedRelease.provider} · Start {selectedRelease.releaseDate} (DE)
                      </p>
                      <h3
                        id="series-popup-title"
                        className="font-display text-2xl font-bold text-white mt-1"
                      >
                        {selectedRelease.seriesTitle}
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 tabular-nums">
                        Staffel {selectedRelease.seasonNumber}, Folge{' '}
                        {selectedRelease.episodeNumber} — {selectedRelease.episodeTitle} ·{' '}
                        {selectedRelease.genre}
                        {selectedRelease.fsk !== undefined && ` · FSK ${selectedRelease.fsk}`}
                        {selectedRelease.seriesStatus && (
                          <>
                            {' · '}
                            <span
                              className={
                                selectedRelease.seriesStatus === 'canceled'
                                  ? 'text-rose-400 font-semibold'
                                  : selectedRelease.seriesStatus === 'ended'
                                    ? 'text-sky-300 font-semibold'
                                    : 'text-emerald-400 font-semibold'
                              }
                            >
                              {selectedRelease.seriesStatus === 'canceled'
                                ? 'Serie eingestellt'
                                : selectedRelease.seriesStatus === 'ended'
                                  ? 'Serie beendet'
                                  : 'Laufende Serie'}
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedReleaseId(null)}
                      aria-label="Pop-up schließen"
                      className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {selectedRelease.seriesStatus && (
                    <div
                      role="status"
                      className={`p-3 rounded-lg border flex items-start gap-2.5 ${
                        selectedRelease.seriesStatus === 'canceled'
                          ? 'border-rose-500/45 bg-rose-950/35 text-rose-100'
                          : selectedRelease.seriesStatus === 'ended'
                            ? 'border-sky-500/45 bg-sky-950/35 text-sky-100'
                            : 'border-emerald-500/35 bg-emerald-950/25 text-emerald-100'
                      }`}
                    >
                      {selectedRelease.seriesStatus === 'canceled' ? (
                        <Ban className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      ) : selectedRelease.seriesStatus === 'ended' ? (
                        <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                      ) : (
                        <Tv className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0">
                        <p
                          className={`text-xs font-semibold ${
                            selectedRelease.seriesStatus === 'canceled'
                              ? 'text-rose-300'
                              : selectedRelease.seriesStatus === 'ended'
                                ? 'text-sky-300'
                                : 'text-emerald-300'
                          }`}
                        >
                          {selectedRelease.seriesStatus === 'canceled'
                            ? 'Serienstatus: Eingestellt'
                            : selectedRelease.seriesStatus === 'ended'
                              ? 'Serienstatus: Beendet'
                              : 'Serienstatus: Laufend'}
                        </p>
                        <p className="text-xs text-slate-200/90 mt-0.5">
                          {selectedRelease.seriesStatusDetail ??
                            (selectedRelease.seriesStatus === 'canceled'
                              ? 'Diese Serie wurde abgesetzt und wird nicht fortgesetzt.'
                              : selectedRelease.seriesStatus === 'ended'
                                ? 'Diese Serie ist regulär abgeschlossen.'
                                : 'Weitere Staffeln oder Folgen sind angekündigt.')}
                        </p>
                      </div>
                    </div>
                  )}

                  <div>
                    <h4 className="text-xs font-semibold text-slate-300 mb-1.5">Inhalt</h4>
                    <p className="text-sm text-slate-200 leading-relaxed">
                      {selectedRelease.synopsis}
                    </p>
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-amber-400" />
                      <span>Schauspieler</span>
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {selectedRelease.cast.map((actor) => (
                        <div
                          key={actor}
                          className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800/80 text-xs text-slate-200 truncate"
                        >
                          {actor}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* NAS-Verfügbarkeit Box (wie bei den Filmstarts: Serie, Staffel & neue Folge) */}
                  <div
                    className={`p-3.5 rounded-xl border space-y-3 ${
                      selectedRelease.nasMatch.episodeOnNas
                        ? 'bg-emerald-500/10 border-emerald-500/40'
                        : selectedRelease.nasMatch.seriesOnNas
                          ? 'bg-amber-400/10 border-amber-400/35'
                          : 'bg-[#0B0E14] border-slate-800/80'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="space-y-0.5 min-w-0">
                        <p
                          className={`text-xs font-semibold flex items-center gap-1.5 ${
                            selectedRelease.nasMatch.episodeOnNas
                              ? 'text-emerald-300'
                              : selectedRelease.nasMatch.seriesOnNas
                                ? 'text-amber-200'
                                : 'text-slate-300'
                          }`}
                        >
                          {selectedRelease.nasMatch.availableOnNas ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          ) : (
                            <HardDrive className="w-4 h-4 text-slate-500 shrink-0" />
                          )}
                          <span>{selectedRelease.nasMatch.statusLabel}</span>
                        </p>
                        {selectedRelease.nasMatch.nasPath && (
                          <p className="text-[11px] font-mono text-slate-300 truncate">
                            {selectedRelease.nasMatch.nasPath}
                            {selectedRelease.nasMatch.codec
                              ? ` · ${selectedRelease.nasMatch.codec}`
                              : ''}
                          </p>
                        )}
                      </div>

                      {selectedRelease.nasMatch.availableOnNas &&
                        selectedRelease.nasMatch.nasMediaId && (
                          <button
                            type="button"
                            onClick={() => {
                              const id = selectedRelease.nasMatch.nasMediaId!;
                              setSelectedReleaseId(null);
                              onPlayNasMediaId(id);
                            }}
                            className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold flex items-center gap-1.5 shrink-0"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                            <span>Jetzt abspielen</span>
                          </button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                      <div className="p-2.5 rounded-lg bg-[#0B0E14]/90 border border-slate-800/80">
                        <p className="text-[11px] text-slate-400">Serie</p>
                        <p
                          className={`font-semibold mt-0.5 ${
                            selectedRelease.nasMatch.seriesOnNas
                              ? 'text-emerald-300'
                              : 'text-slate-400'
                          }`}
                        >
                          {selectedRelease.nasMatch.seriesOnNas
                            ? 'Auf NAS verfügbar'
                            : 'Nicht auf NAS'}
                        </p>
                      </div>
                      <div className="p-2.5 rounded-lg bg-[#0B0E14]/90 border border-slate-800/80">
                        <p className="text-[11px] text-slate-400">
                          Staffel {selectedRelease.seasonNumber}
                        </p>
                        <p
                          className={`font-semibold mt-0.5 tabular-nums ${
                            selectedRelease.nasMatch.seasonOnNas
                              ? 'text-emerald-300'
                              : 'text-slate-400'
                          }`}
                        >
                          {selectedRelease.nasMatch.seasonOnNas
                            ? `Vorhanden (${selectedRelease.nasMatch.seasonEpisodesOnNasCount} Folgen)`
                            : 'Noch nicht auf NAS'}
                        </p>
                      </div>
                      <div className="p-2.5 rounded-lg bg-[#0B0E14]/90 border border-slate-800/80">
                        <p className="text-[11px] text-slate-400 tabular-nums">
                          Neue Folge S{String(selectedRelease.seasonNumber).padStart(2, '0')}E
                          {String(selectedRelease.episodeNumber).padStart(2, '0')}
                        </p>
                        <p
                          className={`font-semibold mt-0.5 ${
                            selectedRelease.nasMatch.episodeOnNas
                              ? 'text-emerald-300'
                              : 'text-slate-400'
                          }`}
                        >
                          {selectedRelease.nasMatch.episodeOnNas
                            ? 'Bereits auf NAS'
                            : 'Noch nicht auf NAS'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-800/80">
                  {selectedRelease.favorite.isFavorite ? (
                    <button
                      type="button"
                      disabled={busyId === selectedRelease.id}
                      onClick={() =>
                        handleAction(selectedRelease.id, () =>
                          onToggleFavorite(selectedRelease.seriesTitle, 'mute')
                        )
                      }
                      className="px-3.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-slate-300 hover:text-red-300 text-xs font-medium flex items-center gap-1.5"
                    >
                      <VolumeX className="w-3.5 h-3.5" />
                      <span>Benachrichtigungen stummschalten</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === selectedRelease.id}
                      onClick={() =>
                        handleAction(selectedRelease.id, () =>
                          onToggleFavorite(selectedRelease.seriesTitle, 'pin')
                        )
                      }
                      className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Star className="w-3.5 h-3.5" />
                      <span>Als Favorit merken</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setSelectedReleaseId(null)}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium"
                  >
                    Schließen
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auswahlfenster bei mehreren Online-Serientreffern */}
      {showLookupModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="series-lookup-modal-title"
          onClick={() => setShowLookupModal(false)}
        >
          <div
            className="w-full max-w-[min(48rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-800/80 bg-[#0F141E] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3
                  id="series-lookup-modal-title"
                  className="font-display text-lg font-semibold text-white flex items-center gap-2"
                >
                  <Globe className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Mehrere Serien gefunden — bitte auswählen</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 truncate">
                  Suchbegriff: „{newTitle.trim()}“ · {lookupCandidates.length} Treffer im Netz
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLookupModal(false)}
                aria-label="Auswahlfenster schließen"
                className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-3">
              {lookupCandidates.map((cand) => (
                <button
                  key={cand.id}
                  type="button"
                  disabled={submittingManual}
                  onClick={() => void addSeriesFromCandidate(cand)}
                  className="w-full text-left p-4 rounded-xl bg-[#0B0E14] hover:bg-slate-900/90 border border-slate-800 hover:border-amber-400/70 transition-colors flex flex-col sm:flex-row gap-4 group"
                >
                  <div className="w-16 h-24 rounded-lg overflow-hidden bg-slate-900 border border-slate-800 shrink-0">
                    {cand.coverUrl ? (
                      <img
                        src={cand.coverUrl}
                        alt={cand.title}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-600">
                        <Tv className="w-5 h-5" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="font-display text-base font-semibold text-white group-hover:text-amber-300 transition-colors">
                        {cand.title}
                        {cand.year ? (
                          <span className="text-xs font-normal text-slate-400 ml-1.5 tabular-nums">
                            ({cand.year})
                          </span>
                        ) : null}
                      </h4>
                      <span className="px-2.5 py-1 rounded-md bg-amber-400/15 border border-amber-400/35 text-[11px] font-semibold text-amber-300 whitespace-nowrap">
                        Auswählen
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
                      <span className="text-amber-300 font-medium">
                        {cand.networkLabel || cand.provider}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        S{String(cand.season).padStart(2, '0')}E
                        {String(cand.episode).padStart(2, '0')} ({cand.releaseDate})
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{cand.genre}</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500">{cand.sourceLabel}</span>
                    </div>

                    <p className="text-xs text-slate-300 line-clamp-2">{cand.synopsis}</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="px-6 py-3.5 border-t border-slate-800/80 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                disabled={submittingManual}
                onClick={() => void addSeriesTitleOnly(newTitle)}
                className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200"
              >
                Trotzdem nur mit Titel „{newTitle.trim()}“ anlegen
              </button>
              <button
                type="button"
                onClick={() => setShowLookupModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium"
              >
                Schließen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
