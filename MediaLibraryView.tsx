import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Search,
  Film,
  Tv,
  Clock,
  ArrowUpDown,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  Pause,
  X,
  HardDrive,
  CheckCircle2,
  FolderOpen,
  Bookmark,
  Filter,
  ListPlus,
  Check,
  Sparkles,
  RefreshCw,
  CalendarDays,
  Bell,
  PlayCircle,
  MessageSquare,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Music,
  Video,
  FileText,
  SlidersHorizontal,
  PlusCircle,
  Ban,
  ShieldCheck,
  Mic,
  MicOff,
  Loader2,
  Building2,
  Users,
  Save,
  Trash2,
  ListVideo,
  Info,
  Clapperboard,
  Globe,
  Images,
  Calendar,
} from 'lucide-react';
import { DEFAULT_ASSISTANT_AVATAR_URL } from '../data/coverAssets';
import { AssistantAvatarImage } from './AssistantAvatarImage';
import {
  AskDuckCollectionType,
  AskDuckMode,
  AskDuckResponse,
  AudioPlayerMode,
  CalendarNotificationMode,
  CalendarRelease,
  DEFAULT_HOME_ROW_ORDER,
  DuckRecommendationData,
  FilmNotificationMode,
  FilmStartRelease,
  FskLevel,
  HomeRowKey,
  HomeToggleKey,
  MarkWatchedDateOptions,
  MediaKind,
  MediaOnlineSearchCandidate,
  NasMediaItem,
  NasSavedCollection,
  NasSeriesEpisode,
} from '../types/marcente';
import { useDeviceDisplay } from '../lib/deviceDisplay';
import { parseSeriesEpisodeInfo } from '../lib/mediaGrouping';
import {
  cleanMediaTitleForLookup,
  fetchExtraCoverCandidatesForMedia,
  searchMediaMetadataOnline,
} from '../lib/internetMediaService';

interface MediaLibraryViewProps {
  items: NasMediaItem[];
  loading: boolean;
  recommendations: DuckRecommendationData | null;
  recommendationsLoading: boolean;
  calendarReleases: CalendarRelease[];
  filmStarts?: FilmStartRelease[];
  calendarNotificationMode?: CalendarNotificationMode;
  filmNotificationMode?: FilmNotificationMode;
  homeSectionOrder?: HomeRowKey[];
  hiddenHomeSections?: HomeToggleKey[];
  showHomeCategoryTabs?: boolean;
  showHomeFilterSearch?: boolean;
  audioPlayerMode?: AudioPlayerMode;
  duckAssistantEnabled?: boolean;
  assistantAvatarUrl?: string;
  userFskLimit?: FskLevel;
  homeResetSignal?: number;
  savedCollections?: NasSavedCollection[];
  onRefreshRecommendations: () => void;
  onAskDuck: (query: string, mode?: AskDuckMode) => Promise<AskDuckResponse>;
  onSaveCollection?: (payload: {
    collectionType: AskDuckCollectionType;
    title: string;
    criteriaSummary: string;
    createdByPrompt: string;
    mediaIds: string[];
  }) => Promise<NasSavedCollection>;
  onDeleteCollection?: (collectionId: string) => Promise<void> | void;
  onBatchAddWatchlist?: (mediaIds: string[]) => Promise<number>;
  onStartPlaylist?: (playlistItems: NasMediaItem[]) => void;
  onOpenCalendar: () => void;
  onOpenFilmStarts?: () => void;
  onOpenAssistant: () => void;
  onOpenProfile?: () => void;
  onPlayItem: (item: NasMediaItem, episode?: NasSeriesEpisode) => void;
  onToggleWatchlist: (mediaId: string) => void;
  onAddToQueue: (item: NasMediaItem, episode?: NasSeriesEpisode) => void;
  onMarkWatchedState: (
    mediaId: string,
    scope: 'item' | 'episode',
    watched: boolean,
    episode?: { season: number; episode: number },
    options?: MarkWatchedDateOptions
  ) => void;
  onUpdateMediaMetadata?: (mediaId: string, patch: Partial<NasMediaItem>) => Promise<void> | void;
  onEnrichMetadata?: () => void;
  enrichingMetadata?: boolean;
}

type MediaRowKey = Exclude<HomeRowKey, 'ask_duck' | 'recommendations' | 'duck_radar'>;
type CategoryKey = 'all' | MediaRowKey;
type SortOption =
  | 'alpha_asc'
  | 'alpha_desc'
  | 'year_desc'
  | 'year_asc'
  | 'recent_desc'
  | 'added_desc'
  | 'duration_desc';

const SORT_LABELS: Record<SortOption, string> = {
  alpha_asc: 'Alphabetisch (A–Z)',
  alpha_desc: 'Alphabetisch (Z–A)',
  year_desc: 'Erscheinungsjahr (Neueste zuerst)',
  year_asc: 'Erscheinungsjahr (Älteste zuerst)',
  recent_desc: 'Zuletzt angesehen',
  added_desc: 'Zuletzt hinzugefügt',
  duration_desc: 'Laufzeit (Längste zuerst)',
};

const getCardKindLabel = (kind: MediaKind): string => {
  switch (kind) {
    case 'movie':
      return 'Film';
    case 'series':
      return 'Serie';
    case 'image':
      return 'Bild';
    case 'music':
      return 'Musik';
    case 'video':
      return 'Video';
    case 'other':
      return 'Sonstiges';
  }
};

interface MediaPosterCardProps {
  item: NasMediaItem;
  compactWidth: boolean;
  mode: 'default' | 'continue';
  nextUnwatched?: NasSeriesEpisode;
  isRecentlyQueued: boolean;
  audioPlayerMode: AudioPlayerMode;
  onOpenDetail: (mediaId: string) => void;
  onPlayItem: (item: NasMediaItem, episode?: NasSeriesEpisode) => void;
  onToggleWatchlist: (mediaId: string) => void;
  onQueueAdd: (item: NasMediaItem, episode?: NasSeriesEpisode) => void;
  onMarkWatchedState: (
    mediaId: string,
    scope: 'item' | 'episode',
    watched: boolean,
    episode?: { season: number; episode: number },
    options?: MarkWatchedDateOptions
  ) => void;
}

const MediaPosterCard = React.memo<MediaPosterCardProps>(
  ({
    item,
    compactWidth,
    mode,
    nextUnwatched,
    isRecentlyQueued,
    audioPlayerMode,
    onOpenDetail,
    onPlayItem,
    onToggleWatchlist,
    onQueueAdd,
    onMarkWatchedState,
  }) => {
    const isStreamable =
      item.kind === 'movie' ||
      item.kind === 'series' ||
      item.kind === 'music' ||
      item.kind === 'video';
    const pct = Math.min(
      100,
      Math.round((item.watchedMinutes / Math.max(1, item.totalDurationMinutes)) * 100)
    );
    const seasonCount = item.episodes
      ? new Set(item.episodes.map((e) => e.season)).size
      : 1;
    const episodeCount = item.episodes?.length ?? item.totalEpisodes ?? 0;

    const handleCardOpen = () => {
      if (mode === 'continue' && nextUnwatched) {
        onPlayItem(item, nextUnwatched);
      } else {
        onOpenDetail(item.id);
      }
    };

    return (
      <article
        className={`mc-card-perf group bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden flex flex-col justify-between hover:border-amber-400/60 transition-colors ${
          compactWidth ? 'w-48 sm:w-56 shrink-0 snap-start' : 'w-full'
        }`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={handleCardOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCardOpen();
            }
          }}
          className="cursor-pointer focus:outline-none"
        >
          <div
            data-preserve-dark="true"
            className="relative aspect-[3/4] overflow-hidden bg-slate-900"
          >
            <img
              src={item.customCoverUrl || item.coverUrl}
              alt={item.title}
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />

            {isStreamable && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onQueueAdd(item, nextUnwatched);
                }}
                aria-label={`${item.title} zur Warteschlange hinzufügen`}
                title="Zur Warteschlange hinzufügen"
                className={`absolute top-3 left-3 w-9 h-9 rounded-full flex items-center justify-center border transition-colors shadow-md ${
                  isRecentlyQueued
                    ? 'bg-emerald-500 border-emerald-400 text-slate-950'
                    : 'bg-black/75 border-white/15 text-slate-200 hover:text-amber-300 hover:border-amber-400/60'
                }`}
              >
                {isRecentlyQueued ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <ListPlus className="w-4 h-4" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleWatchlist(item.id);
              }}
              aria-pressed={Boolean(item.inWatchlist)}
              aria-label={
                item.inWatchlist
                  ? `${item.title} von der Watchlist entfernen`
                  : `${item.title} zur Watchlist hinzufügen`
              }
              title={
                item.inWatchlist
                  ? 'Von Watchlist entfernen'
                  : 'Auf Watchlist setzen (später ansehen)'
              }
              className={`absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center border transition-colors shadow-md ${
                item.inWatchlist
                  ? 'bg-amber-400 border-amber-300 text-slate-950 hover:bg-amber-300'
                  : 'bg-black/75 border-white/15 text-slate-200 hover:text-amber-300 hover:border-amber-400/60'
              }`}
            >
              <Bookmark className={`w-4 h-4 ${item.inWatchlist ? 'fill-current' : ''}`} />
            </button>

            {isStreamable &&
            (Boolean(item.lastWatchedAt) ||
              Boolean(item.watchedWithoutDate) ||
              item.watchedMinutes > 0 ||
              item.episodesWatchedCount > 0) ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkWatchedState(item.id, 'item', false);
                }}
                aria-label={`${item.title} als ungesehen markieren`}
                title={
                  item.kind === 'series'
                    ? 'Ganze Serie als ungesehen markieren'
                    : 'Als ungesehen markieren'
                }
                className="absolute bottom-3.5 left-3 w-9 h-9 rounded-full bg-black/75 border border-white/15 text-slate-200 hover:text-amber-300 hover:border-amber-400/60 flex items-center justify-center shadow-md transition-colors"
              >
                <EyeOff className="w-4 h-4" />
              </button>
            ) : (
              (item.kind === 'movie' || item.kind === 'series') && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkWatchedState(item.id, 'item', true);
                  }}
                  aria-label={`${item.title} als gesehen markieren`}
                  title={
                    item.kind === 'series'
                      ? 'Ganze Serie als gesehen markieren'
                      : 'Als gesehen markieren'
                  }
                  className="absolute bottom-3.5 left-3 w-9 h-9 rounded-full bg-black/75 border border-white/15 text-slate-200 hover:text-emerald-300 hover:border-emerald-400/60 flex items-center justify-center shadow-md transition-colors"
                >
                  <Eye className="w-4 h-4" />
                </button>
              )
            )}

            {isStreamable ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlayItem(item, nextUnwatched);
                }}
                aria-label={
                  nextUnwatched
                    ? `${item.title} S${String(nextUnwatched.season).padStart(2, '0')}E${String(
                        nextUnwatched.episode
                      ).padStart(2, '0')} abspielen`
                    : item.kind === 'music' && audioPlayerMode === 'external'
                      ? `${item.title} im externen Player öffnen`
                      : `${item.title} abspielen`
                }
                title={
                  item.kind === 'music' && audioPlayerMode === 'external'
                    ? 'Im externen Audio-Player öffnen'
                    : 'Abspielen'
                }
                className="absolute bottom-3.5 right-3.5 w-10 h-10 rounded-full bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center justify-center shadow-lg transition-transform duration-200 group-hover:scale-105"
              >
                <Play className="w-4 h-4 fill-current ml-0.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDetail(item.id);
                }}
                aria-label={`${item.title} öffnen`}
                title="Datei auf dem NAS ansehen"
                className="absolute bottom-3.5 right-3.5 w-10 h-10 rounded-full bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center justify-center shadow-lg transition-transform duration-200 group-hover:scale-105"
              >
                <Eye className="w-4 h-4" />
              </button>
            )}

            {isStreamable && item.watchedMinutes > 0 && (
              <div className="absolute bottom-0 inset-x-0 h-1 bg-slate-800">
                <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>

          <div className="p-3.5">
            <h3 className="font-display text-sm font-semibold text-white group-hover:text-amber-300 transition-colors truncate">
              {item.title}
            </h3>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
              <span>{getCardKindLabel(item.kind)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{item.year}</span>
              {(item.kind === 'movie' || item.kind === 'series') && item.fsk !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums text-slate-300">FSK {item.fsk}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="truncate">{item.genre}</span>
            </div>

            {mode === 'continue' && nextUnwatched ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs text-amber-300 font-medium truncate tabular-nums">
                  Folge S{String(nextUnwatched.season).padStart(2, '0')}E
                  {String(nextUnwatched.episode).padStart(2, '0')} · {nextUnwatched.title}
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDetail(item.id);
                  }}
                  className="text-[11px] text-slate-400 hover:text-white underline shrink-0"
                >
                  Details
                </button>
              </div>
            ) : item.kind === 'series' ? (
              <p className="text-xs text-amber-300 mt-2 font-medium truncate tabular-nums">
                {seasonCount} {seasonCount === 1 ? 'Staffel' : 'Staffeln'} · {episodeCount}{' '}
                Folgen auf NAS
                {item.seriesStatus === 'canceled' && (
                  <span className="text-rose-400 font-semibold"> · Eingestellt</span>
                )}
                {item.seriesStatus === 'ended' && (
                  <span className="text-sky-300 font-semibold"> · Beendet</span>
                )}
              </p>
            ) : item.kind === 'image' || item.kind === 'other' ? (
              <p className="text-xs text-slate-400 mt-2 truncate tabular-nums">
                {item.fileFormat ?? (item.kind === 'image' ? 'Bilddatei' : 'Datei')}
                {item.fileSize ? ` · ${item.fileSize}` : ''}
              </p>
            ) : (
              <p className="text-xs text-slate-400 mt-2 truncate tabular-nums">
                {item.totalDurationMinutes} Min.
                {item.fileFormat ? ` · ${item.fileFormat}` : ''}
              </p>
            )}
          </div>
        </div>
      </article>
    );
  }
);
MediaPosterCard.displayName = 'MediaPosterCard';

export const MediaLibraryView: React.FC<MediaLibraryViewProps> = ({
  items,
  loading,
  recommendations,
  recommendationsLoading,
  calendarReleases,
  filmStarts = [],
  calendarNotificationMode = 'favorites_all',
  filmNotificationMode = 'favorites',
  homeSectionOrder = DEFAULT_HOME_ROW_ORDER,
  hiddenHomeSections = [],
  showHomeCategoryTabs = false,
  showHomeFilterSearch = false,
  audioPlayerMode = 'internal',
  duckAssistantEnabled = true,
  assistantAvatarUrl = DEFAULT_ASSISTANT_AVATAR_URL,
  userFskLimit = 18,
  homeResetSignal = 0,
  savedCollections = [],
  onRefreshRecommendations,
  onAskDuck,
  onSaveCollection,
  onDeleteCollection,
  onBatchAddWatchlist,
  onStartPlaylist,
  onOpenCalendar,
  onOpenFilmStarts,
  onOpenAssistant,
  onOpenProfile,
  onPlayItem,
  onToggleWatchlist,
  onAddToQueue,
  onMarkWatchedState,
  onUpdateMediaMetadata,
  onEnrichMetadata,
  enrichingMetadata = false,
}) => {
  const displayInfo = useDeviceDisplay();
  const duckRadarTrackRef = useRef<HTMLDivElement | null>(null);
  const [duckRadarIndex, setDuckRadarIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey>('all');
  const [selectedGenre, setSelectedGenre] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('alpha_asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [activeSeason, setActiveSeason] = useState<number>(1);
  const [recentlyQueuedKey, setRecentlyQueuedKey] = useState<string | null>(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState<number>(0);
  const [isSliderPaused, setIsSliderPaused] = useState<boolean>(false);

  const [askDuckQuery, setAskDuckQuery] = useState('');
  const [askDuckMode, setAskDuckMode] = useState<AskDuckMode>('auto');
  const [askDuckLoading, setAskDuckLoading] = useState(false);
  const [askDuckError, setAskDuckError] = useState<string | null>(null);
  const [askDuckResult, setAskDuckResult] = useState<AskDuckResponse | null>(null);
  const [askDuckActionFeedback, setAskDuckActionFeedback] = useState<string | null>(null);
  const [showAskDuckInfo, setShowAskDuckInfo] = useState(false);
  const [savingCollection, setSavingCollection] = useState(false);
  const [batchAddingWatchlist, setBatchAddingWatchlist] = useState(false);
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [gridVisibleLimit, setGridVisibleLimit] = useState(48);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverLoadingMore, setCoverLoadingMore] = useState(false);
  const [customCoverUrlInput, setCustomCoverUrlInput] = useState('');
  const [manualSearchOpen, setManualSearchOpen] = useState(false);
  const [manualSearchQuery, setManualSearchQuery] = useState('');
  const [manualSearchKind, setManualSearchKind] = useState<'movie' | 'series'>('movie');
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [manualSearchResults, setManualSearchResults] = useState<MediaOnlineSearchCandidate[]>([]);
  const [manualSearchFeedback, setManualSearchFeedback] = useState<string | null>(null);
  const [watchDateTarget, setWatchDateTarget] = useState<{
    item: NasMediaItem;
    scope: 'item' | 'episode';
    episode?: { season: number; episode: number; title?: string };
    step: 'choose' | 'custom';
  } | null>(null);
  const [customWatchDate, setCustomWatchDate] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
  });
  const [customWatchTime, setCustomWatchTime] = useState<string>(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
      2,
      '0'
    )}`;
  });
  const [customWatchError, setCustomWatchError] = useState<string | null>(null);
  const speechRecRef = React.useRef<{
    stop: () => void;
    abort?: () => void;
  } | null>(null);

  useEffect(() => {
    setGridVisibleLimit(48);
  }, [selectedCategory, selectedGenre, searchQuery, sortOption]);

  useEffect(() => {
    if (homeResetSignal > 0) {
      setSelectedCategory('all');
      setSelectedMediaId(null);
      setSearchQuery('');
      setSelectedGenre('all');
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      });
    }
  }, [homeResetSignal]);

  useEffect(() => {
    if (!showHomeFilterSearch) {
      setSelectedGenre('all');
      setSearchQuery('');
    }
  }, [showHomeFilterSearch]);

  useEffect(() => {
    return () => {
      try {
        speechRecRef.current?.abort?.();
      } catch {
        // Ignorieren
      }
    };
  }, []);

  const executeAskDuck = async (rawText: string, modeOverride?: AskDuckMode) => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setAskDuckError('Bitte gib eine Frage oder ein Suchkriterium für die Ente ein.');
      return;
    }
    setAskDuckError(null);
    setAskDuckActionFeedback(null);
    setVoiceError(null);
    setAskDuckLoading(true);
    try {
      const response = await onAskDuck(trimmed, modeOverride ?? askDuckMode);
      setAskDuckResult(response);
    } catch (err) {
      setAskDuckError(
        err instanceof Error
          ? err.message
          : 'Die Suche über „Frag die Ente“ ist fehlgeschlagen.'
      );
    } finally {
      setAskDuckLoading(false);
    }
  };

  const handleAskDuckSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeAskDuck(askDuckQuery);
  };

  const handleToggleVoiceSearch = () => {
    setVoiceError(null);
    if (isVoiceListening && speechRecRef.current) {
      speechRecRef.current.stop();
      setIsVoiceListening(false);
      return;
    }

    type SpeechRecognitionCtor = new () => {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onresult: ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
      }) => void) | null;
      onerror: ((event: { error?: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
      abort: () => void;
    };

    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!Recognition) {
      setVoiceError(
        'Spracherkennung wird in diesem Browser leider nicht unterstützt. Nutze bitte die Texteingabe.'
      );
      return;
    }

    try {
      const rec = new Recognition();
      rec.lang = 'de-DE';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let latestTranscript = '';

      rec.onresult = (event) => {
        let combined = '';
        for (let i = 0; i < event.results.length; i += 1) {
          const item = event.results[i];
          if (item && item[0]?.transcript) {
            combined += item[0].transcript;
          }
        }
        latestTranscript = combined.trim();
        if (latestTranscript) {
          setAskDuckQuery(latestTranscript);
        }
      };

      rec.onerror = (event) => {
        setIsVoiceListening(false);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setVoiceError('Mikrofonzugriff wurde blockiert. Bitte erlaube das Mikrofon im Browser.');
        } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
          setVoiceError('Spracherkennung unterbrochen. Bitte versuche es erneut.');
        }
      };

      rec.onend = () => {
        setIsVoiceListening(false);
        if (latestTranscript.trim().length > 0) {
          void executeAskDuck(latestTranscript.trim());
        }
      };

      speechRecRef.current = rec;
      setIsVoiceListening(true);
      rec.start();
    } catch {
      setIsVoiceListening(false);
      setVoiceError('Mikrofon konnte nicht gestartet werden.');
    }
  };

  const getNextUnwatchedEpisode = useCallback((item: NasMediaItem): NasSeriesEpisode | undefined => {
    if (item.kind !== 'series' || !item.episodes?.length) return undefined;
    return item.episodes.find((ep) => !ep.watched);
  }, []);

  const triggerQueueAdd = useCallback(
    (item: NasMediaItem, episode?: NasSeriesEpisode) => {
      onAddToQueue(item, episode);
      const key = episode ? `${item.id}-S${episode.season}E${episode.episode}` : item.id;
      setRecentlyQueuedKey(key);
      window.setTimeout(() => {
        setRecentlyQueuedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    },
    [onAddToQueue]
  );

  const selectedMedia = useMemo(
    () => items.find((i) => i.id === selectedMediaId) ?? null,
    [items, selectedMediaId]
  );

  const availableSeasons = useMemo(() => {
    if (!selectedMedia?.episodes?.length) return [] as number[];
    return Array.from(new Set(selectedMedia.episodes.map((e) => e.season))).sort(
      (a, b) => a - b
    );
  }, [selectedMedia]);

  const availableCoverOptions = useMemo(() => {
    if (!selectedMedia) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    const pushUrl = (raw?: string | null) => {
      if (!raw || !raw.trim()) return;
      const u = raw.trim();
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };
    pushUrl(selectedMedia.customCoverUrl);
    pushUrl(selectedMedia.coverUrl);
    for (const c of selectedMedia.coverCandidates ?? []) {
      pushUrl(c);
    }
    return out;
  }, [selectedMedia]);

  useEffect(() => {
    if (!selectedMedia) return;
    if (selectedMedia.currentEpisode) {
      setActiveSeason(selectedMedia.currentEpisode.season);
    } else if (availableSeasons.length > 0) {
      setActiveSeason(availableSeasons[0]);
    }
  }, [selectedMedia, availableSeasons]);

  useEffect(() => {
    if (!selectedMediaId) {
      setCoverPickerOpen(false);
      setManualSearchOpen(false);
      setManualSearchResults([]);
      setManualSearchFeedback(null);
      return;
    }
    if (!selectedMedia) return;
    setCoverPickerOpen(false);
    setManualSearchOpen(false);
    setManualSearchResults([]);
    setManualSearchFeedback(null);
    setCustomCoverUrlInput(selectedMedia.customCoverUrl ?? '');
    const defaultKind: 'movie' | 'series' = selectedMedia.kind === 'series' ? 'series' : 'movie';
    setManualSearchKind(defaultKind);
    const defaultQuery =
      selectedMedia.kind === 'series'
        ? parseSeriesEpisodeInfo(selectedMedia.title, selectedMedia.nasPath).seriesTitle || selectedMedia.title
        : cleanMediaTitleForLookup(selectedMedia.title).query || selectedMedia.title;
    setManualSearchQuery(defaultQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMediaId]);

  useEffect(() => {
    if (!selectedMedia && !watchDateTarget) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (watchDateTarget) {
        setWatchDateTarget(null);
      } else {
        setSelectedMediaId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selectedMedia, watchDateTarget]);

  const normalizeWatchTitle = useCallback((raw: string): string => {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, ' ')
      .trim();
  }, []);

  const resolveReleaseWatchInfo = useCallback(
    (
      item: NasMediaItem,
      episode?: { season: number; episode: number }
    ): { iso: string; displayDate: string; sourceHint: string } => {
      const normTitle = normalizeWatchTitle(item.title);
      let rawDate: string | undefined;
      let isExactDate = false;

      if (episode && item.kind === 'series') {
        const epMatch = calendarReleases.find(
          (rel) =>
            normalizeWatchTitle(rel.seriesTitle) === normTitle &&
            rel.seasonNumber === episode.season &&
            rel.episodeNumber === episode.episode &&
            Boolean(rel.releaseDate)
        );
        if (epMatch?.releaseDate) {
          rawDate = epMatch.releaseDate;
          isExactDate = true;
        }
      }

      if (!rawDate && item.kind === 'movie') {
        if (item.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(item.releaseDate)) {
          rawDate = item.releaseDate.slice(0, 10);
          isExactDate = true;
        } else {
          const filmMatch = filmStarts.find(
            (rel) => normalizeWatchTitle(rel.title) === normTitle
          );
          const candidateDate =
            filmMatch?.releaseDateDE || filmMatch?.releaseDate || filmMatch?.releaseDateAT;
          if (candidateDate && /^\d{4}-\d{2}-\d{2}/.test(candidateDate)) {
            rawDate = candidateDate.slice(0, 10);
            isExactDate = true;
          }
        }
      }

      if (!rawDate && item.kind === 'series') {
        if (item.releaseDate && /^\d{4}-\d{2}-\d{2}/.test(item.releaseDate)) {
          rawDate = item.releaseDate.slice(0, 10);
          isExactDate = true;
        } else {
          const seriesMatches = calendarReleases
            .filter(
              (rel) =>
                normalizeWatchTitle(rel.seriesTitle) === normTitle && Boolean(rel.releaseDate)
            )
            .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
          const premiere =
            seriesMatches.find((r) => r.seasonNumber === 1 && r.episodeNumber === 1) ??
            seriesMatches[0];
          if (premiere?.releaseDate) {
            rawDate = premiere.releaseDate.slice(0, 10);
            isExactDate = true;
          }
        }
      }

      if (!rawDate) {
        const fallbackYear =
          item.year && item.year >= 1900 && item.year <= new Date().getFullYear() + 5
            ? item.year
            : new Date().getFullYear();
        rawDate = `${fallbackYear}-01-01`;
        isExactDate = false;
      }

      const [yStr, mStr, dStr] = rawDate.slice(0, 10).split('-');
      const y = Number(yStr) || new Date().getFullYear();
      const m = Number(mStr) || 1;
      const d = Number(dStr) || 1;
      const releaseDt = new Date(y, Math.max(0, m - 1), Math.max(1, d), 20, 0, 0);
      const formattedDate = releaseDt.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });

      return {
        iso: releaseDt.toISOString(),
        displayDate: `${formattedDate} · 20:00 Uhr`,
        sourceHint: isExactDate
          ? 'Hinterlegtes Release-Datum'
          : `Aus Erscheinungsjahr ${y} abgeleitet`,
      };
    },
    [calendarReleases, filmStarts, normalizeWatchTitle]
  );

  const requestMarkWatchedState = useCallback(
    (
      mediaId: string,
      scope: 'item' | 'episode',
      watched: boolean,
      episode?: { season: number; episode: number }
    ) => {
      if (!watched) {
        onMarkWatchedState(mediaId, scope, false, episode);
        return;
      }
      const targetItem = items.find((i) => i.id === mediaId);
      if (
        targetItem &&
        (targetItem.kind === 'movie' ||
          targetItem.kind === 'series' ||
          scope === 'episode')
      ) {
        const now = new Date();
        setCustomWatchDate(
          `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
            now.getDate()
          ).padStart(2, '0')}`
        );
        setCustomWatchTime(
          `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
            2,
            '0'
          )}`
        );
        setCustomWatchError(null);
        const epMatch =
          scope === 'episode' && episode
            ? targetItem.episodes?.find(
                (ep) => ep.season === episode.season && ep.episode === episode.episode
              )
            : undefined;
        setWatchDateTarget({
          item: targetItem,
          scope,
          episode: episode
            ? {
                season: episode.season,
                episode: episode.episode,
                title: epMatch?.title,
              }
            : undefined,
          step: 'choose',
        });
        return;
      }
      onMarkWatchedState(mediaId, scope, true, episode, {
        watchedAt: new Date().toISOString(),
        dateMode: 'now',
      });
    },
    [items, onMarkWatchedState]
  );

  const handleConfirmWatchNow = () => {
    if (!watchDateTarget) return;
    const epCoords = watchDateTarget.episode
      ? { season: watchDateTarget.episode.season, episode: watchDateTarget.episode.episode }
      : undefined;
    onMarkWatchedState(watchDateTarget.item.id, watchDateTarget.scope, true, epCoords, {
      watchedAt: new Date().toISOString(),
      dateMode: 'now',
    });
    setWatchDateTarget(null);
  };

  const handleConfirmWatchAtRelease = () => {
    if (!watchDateTarget) return;
    const epCoords = watchDateTarget.episode
      ? { season: watchDateTarget.episode.season, episode: watchDateTarget.episode.episode }
      : undefined;
    const releaseInfo = resolveReleaseWatchInfo(watchDateTarget.item, epCoords);
    onMarkWatchedState(watchDateTarget.item.id, watchDateTarget.scope, true, epCoords, {
      watchedAt: releaseInfo.iso,
      dateMode: 'release',
    });
    setWatchDateTarget(null);
  };

  const handleConfirmWatchCustomDate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!watchDateTarget) return;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customWatchDate.trim());
    if (!dateMatch) {
      setCustomWatchError('Bitte wähle ein gültiges Datum aus.');
      return;
    }
    const timeStr = customWatchTime.trim() || '20:00';
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeStr);
    if (!timeMatch) {
      setCustomWatchError('Bitte gib eine gültige Uhrzeit ein (HH:MM).');
      return;
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const localDt = new Date(year, month - 1, day, hours, minutes, 0);
    if (Number.isNaN(localDt.getTime())) {
      setCustomWatchError('Das angegebene Datum konnte nicht verarbeitet werden.');
      return;
    }
    const epCoords = watchDateTarget.episode
      ? { season: watchDateTarget.episode.season, episode: watchDateTarget.episode.episode }
      : undefined;
    onMarkWatchedState(watchDateTarget.item.id, watchDateTarget.scope, true, epCoords, {
      watchedAt: localDt.toISOString(),
      dateMode: 'custom',
    });
    setCustomWatchError(null);
    setWatchDateTarget(null);
  };

  const handleConfirmWatchWithoutDate = () => {
    if (!watchDateTarget) return;
    const epCoords = watchDateTarget.episode
      ? { season: watchDateTarget.episode.season, episode: watchDateTarget.episode.episode }
      : undefined;
    onMarkWatchedState(watchDateTarget.item.id, watchDateTarget.scope, true, epCoords, {
      watchedAt: null,
      dateMode: 'without_date',
    });
    setCustomWatchError(null);
    setWatchDateTarget(null);
  };

  const handleLoadMoreCoversForSelected = async () => {
    if (!selectedMedia || coverLoadingMore) return;
    setCoverLoadingMore(true);
    try {
      const titleForLookup =
        selectedMedia.kind === 'series'
          ? parseSeriesEpisodeInfo(selectedMedia.title, selectedMedia.nasPath).seriesTitle || selectedMedia.title
          : selectedMedia.title;
      const fetched = await fetchExtraCoverCandidatesForMedia(titleForLookup, selectedMedia.kind);
      const merged = Array.from(new Set([...availableCoverOptions, ...fetched]));
      if (merged.length > 0 && onUpdateMediaMetadata) {
        await onUpdateMediaMetadata(selectedMedia.id, {
          coverCandidates: merged,
        });
      }
    } finally {
      setCoverLoadingMore(false);
    }
  };

  const handleSelectCoverForSelected = async (coverUrl: string) => {
    if (!selectedMedia || !onUpdateMediaMetadata) return;
    const mergedCandidates = Array.from(new Set([coverUrl, ...availableCoverOptions]));
    await onUpdateMediaMetadata(selectedMedia.id, {
      coverUrl,
      customCoverUrl: coverUrl,
      coverCandidates: mergedCandidates,
    });
    setCustomCoverUrlInput(coverUrl);
  };

  const handleChangeKindForSelected = async (nextKind: MediaKind) => {
    if (!selectedMedia || !onUpdateMediaMetadata || selectedMedia.kind === nextKind) return;
    await onUpdateMediaMetadata(selectedMedia.id, {
      kind: nextKind,
      manualKindLock: true,
      genre:
        selectedMedia.genre === 'Medien' || selectedMedia.genre === 'Video' || selectedMedia.genre === 'Film' || selectedMedia.genre === 'Serie'
          ? nextKind === 'series'
            ? 'Serie'
            : nextKind === 'movie'
              ? 'Film'
              : 'Video'
          : selectedMedia.genre,
    });
    if (nextKind === 'series' || nextKind === 'movie') {
      setManualSearchKind(nextKind);
    }
  };

  const handleRunManualOnlineSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedMedia || manualSearchLoading) return;
    const raw = manualSearchQuery.trim();
    if (raw.length < 2) {
      setManualSearchFeedback('Bitte mindestens 2 Zeichen für die Suche eingeben.');
      return;
    }
    const cleanQuery =
      manualSearchKind === 'series'
        ? parseSeriesEpisodeInfo(raw).seriesTitle || cleanMediaTitleForLookup(raw).query || raw
        : cleanMediaTitleForLookup(raw).query || raw;

    setManualSearchLoading(true);
    setManualSearchFeedback(null);
    try {
      const hits = await searchMediaMetadataOnline(cleanQuery, manualSearchKind);
      setManualSearchResults(hits);
      if (hits.length === 0) {
        setManualSearchFeedback(`Keine passenden Online-Treffer für „${cleanQuery}“ gefunden.`);
      }
    } finally {
      setManualSearchLoading(false);
    }
  };

  const handleApplyManualOnlineCandidate = async (cand: MediaOnlineSearchCandidate) => {
    if (!selectedMedia || !onUpdateMediaMetadata) return;
    const nextCover = cand.coverUrl || cand.coverCandidates[0] || selectedMedia.coverUrl;
    const mergedCovers = Array.from(
      new Set([
        ...(nextCover ? [nextCover] : []),
        ...cand.coverCandidates,
        ...availableCoverOptions,
      ])
    );
    await onUpdateMediaMetadata(selectedMedia.id, {
      title: cand.title,
      kind: cand.kind,
      manualKindLock: true,
      year: cand.year ?? selectedMedia.year,
      releaseDate: cand.releaseDate ?? selectedMedia.releaseDate,
      genre: cand.genre || selectedMedia.genre,
      synopsis: cand.synopsis || selectedMedia.synopsis,
      coverUrl: nextCover,
      customCoverUrl: nextCover,
      coverCandidates: mergedCovers,
      director: cand.director ?? selectedMedia.director,
      studio: cand.studio ?? selectedMedia.studio,
      cast: cand.cast && cand.cast.length > 0 ? cand.cast : selectedMedia.cast,
      seriesStatus: cand.kind === 'series' ? cand.seriesStatus ?? selectedMedia.seriesStatus : selectedMedia.seriesStatus,
      fsk: cand.fsk ?? selectedMedia.fsk,
      totalDurationMinutes:
        cand.kind === 'movie' && cand.durationMinutes
          ? cand.durationMinutes
          : selectedMedia.totalDurationMinutes,
    });
    setManualSearchOpen(false);
    setManualSearchFeedback(null);
  };

  const recommendedEntries = useMemo(() => {
    if (!recommendations?.items?.length) {
      const candidates = items.filter((i) => i.kind === 'movie' || i.kind === 'series');
      const isWatched = (i: NasMediaItem) =>
        Boolean(i.lastWatchedAt) ||
        Boolean(i.watchedWithoutDate) ||
        i.watchedMinutes > 0 ||
        i.episodesWatchedCount > 0;
      const ordered = [
        ...candidates.filter((i) => !isWatched(i)),
        ...candidates.filter((i) => isWatched(i)),
      ];
      const topSeries = ordered.filter((i) => i.kind === 'series').slice(0, 3);
      const topMovies = ordered.filter((i) => i.kind === 'movie').slice(0, 3);
      const pickedIds = new Set([...topSeries, ...topMovies].map((i) => i.id));
      const backfill = ordered.filter((i) => !pickedIds.has(i.id));

      const combined: NasMediaItem[] = [];
      for (let idx = 0; idx < 3; idx++) {
        if (topSeries[idx]) combined.push(topSeries[idx]);
        if (topMovies[idx]) combined.push(topMovies[idx]);
      }
      while (combined.length < 6 && backfill.length > 0) {
        const next = backfill.shift();
        if (next) combined.push(next);
      }

      return combined.slice(0, 6).map((item) => ({
        item,
        reason: `Empfohlen anhand deines NAS-Katalogs (${item.genre})`,
        matchedSignals: [] as string[],
      }));
    }
    return recommendations.items
      .map((rec) => {
        const match = items.find((i) => i.id === rec.mediaId);
        return match
          ? {
              item: match,
              reason: rec.reason,
              matchedSignals: rec.matchedSignals ?? [],
            }
          : null;
      })
      .filter(
        (
          entry
        ): entry is { item: NasMediaItem; reason: string; matchedSignals: string[] } =>
          entry !== null
      );
  }, [recommendations, items]);

  useEffect(() => {
    if (recommendedEntries.length === 0) {
      setActiveSlideIndex(0);
      return;
    }
    setActiveSlideIndex((prev) => prev % recommendedEntries.length);
  }, [recommendedEntries.length]);

  useEffect(() => {
    if (isSliderPaused || recommendedEntries.length <= 1) return;
    let timer: number | null = null;

    const startSlider = () => {
      if (timer !== null || document.visibilityState === 'hidden') return;
      timer = window.setInterval(() => {
        setActiveSlideIndex((prev) => (prev + 1) % recommendedEntries.length);
      }, 5500);
    };

    const stopSlider = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopSlider();
      } else {
        startSlider();
      }
    };

    startSlider();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopSlider();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isSliderPaused, recommendedEntries.length]);

  const safeSlideIndex =
    recommendedEntries.length > 0 ? activeSlideIndex % recommendedEntries.length : 0;
  const currentRecommendedEntry = recommendedEntries[safeSlideIndex] ?? null;

  const handlePrevSlide = () => {
    if (recommendedEntries.length <= 1) return;
    setActiveSlideIndex(
      (prev) => (prev - 1 + recommendedEntries.length) % recommendedEntries.length
    );
  };

  const handleNextSlide = () => {
    if (recommendedEntries.length <= 1) return;
    setActiveSlideIndex((prev) => (prev + 1) % recommendedEntries.length);
  };

  const seriesFavoritesOnly =
    calendarNotificationMode === 'favorites_all' ||
    calendarNotificationMode === 'favorites_new_series' ||
    calendarNotificationMode === 'favorites_new_episodes';
  const seriesOnlyNewSeries =
    calendarNotificationMode === 'favorites_new_series' ||
    calendarNotificationMode === 'all_new_series';
  const seriesOnlyNewEpisodes =
    calendarNotificationMode === 'favorites_new_episodes' ||
    calendarNotificationMode === 'all_new_episodes';
  const filmFavoritesOnly = filmNotificationMode === 'favorites';

  const duckRadarSeriesStarts = useMemo(() => {
    if (seriesOnlyNewEpisodes) return [];
    return calendarReleases
      .filter((rel) => {
        if ((rel.fsk ?? 0) > userFskLimit) return false;
        if (seriesFavoritesOnly && !rel.favorite.isFavorite) return false;
        if (seriesOnlyNewSeries) {
          return rel.seasonNumber === 1 && rel.episodeNumber === 1;
        }
        return rel.isSeasonPremiere || !rel.isAvailableNow;
      })
      .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  }, [calendarReleases, userFskLimit, seriesFavoritesOnly, seriesOnlyNewSeries, seriesOnlyNewEpisodes]);

  const duckRadarNewEpisodes = useMemo(() => {
    if (seriesOnlyNewSeries) return [];
    return calendarReleases
      .filter((rel) => {
        if ((rel.fsk ?? 0) > userFskLimit) return false;
        if (seriesFavoritesOnly && !rel.favorite.isFavorite) return false;
        if (seriesOnlyNewEpisodes) {
          return !(rel.seasonNumber === 1 && rel.episodeNumber === 1) && rel.isAvailableNow;
        }
        return rel.isAvailableNow;
      })
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  }, [calendarReleases, userFskLimit, seriesFavoritesOnly, seriesOnlyNewSeries, seriesOnlyNewEpisodes]);

  const duckRadarFilmStarts = useMemo(
    () =>
      filmStarts
        .filter((rel) => {
          if ((rel.fsk ?? 0) > userFskLimit) return false;
          if (filmFavoritesOnly && !rel.favorite.isFavorite) return false;
          return true;
        })
        .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate)),
    [filmStarts, userFskLimit, filmFavoritesOnly]
  );

  const scrollDuckRadarToCard = (targetIndex: number) => {
    const clamped = Math.max(0, Math.min(2, targetIndex));
    setDuckRadarIndex(clamped);
    const track = duckRadarTrackRef.current;
    if (!track) return;
    const cardEl = track.children.item(clamped) as HTMLElement | null;
    if (cardEl) {
      track.scrollTo({
        left: Math.max(0, cardEl.offsetLeft - track.offsetLeft),
        behavior: 'smooth',
      });
    }
  };

  const sortItems = (list: NasMediaItem[], mode: SortOption): NasMediaItem[] => {
    return [...list].sort((a, b) => {
      switch (mode) {
        case 'alpha_asc':
          return a.title.localeCompare(b.title, 'de');
        case 'alpha_desc':
          return b.title.localeCompare(a.title, 'de');
        case 'year_desc':
          return b.year - a.year || a.title.localeCompare(b.title, 'de');
        case 'year_asc':
          return a.year - b.year || a.title.localeCompare(b.title, 'de');
        case 'duration_desc':
          return b.totalDurationMinutes - a.totalDurationMinutes;
        case 'recent_desc': {
          if (!a.lastWatchedAt && !b.lastWatchedAt) {
            return a.title.localeCompare(b.title, 'de');
          }
          if (!a.lastWatchedAt) return 1;
          if (!b.lastWatchedAt) return -1;
          return b.lastWatchedAt.localeCompare(a.lastWatchedAt);
        }
        case 'added_desc': {
          const aTime = a.addedAt ?? '';
          const bTime = b.addedAt ?? '';
          if (!aTime && !bTime) {
            return b.year - a.year || a.title.localeCompare(b.title, 'de');
          }
          if (!aTime) return 1;
          if (!bTime) return -1;
          return bTime.localeCompare(aTime) || a.title.localeCompare(b.title, 'de');
        }
      }
    });
  };

  const availableGenres = useMemo(() => {
    const genreSet = new Set<string>();
    items.forEach((item) => {
      item.genre
        .split('&')
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => genreSet.add(part));
    });
    return Array.from(genreSet).sort((a, b) => a.localeCompare(b, 'de'));
  }, [items]);

  const searchedItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      const matchesGenre =
        selectedGenre === 'all' ||
        item.genre
          .split('&')
          .map((part) => part.trim().toLowerCase())
          .includes(selectedGenre.toLowerCase());
      if (!matchesGenre) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.genre.toLowerCase().includes(q) ||
        item.synopsis.toLowerCase().includes(q)
      );
    });
  }, [items, searchQuery, selectedGenre]);

  const movies = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'movie'), sortOption),
    [searchedItems, sortOption]
  );

  const series = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'series'), sortOption),
    [searchedItems, sortOption]
  );

  const continueSeries = useMemo(
    () =>
      sortItems(
        searchedItems.filter((i) => {
          if (i.kind !== 'series') return false;
          const started =
            Boolean(i.lastWatchedAt) ||
            Boolean(i.watchedWithoutDate) ||
            i.episodesWatchedCount > 0 ||
            i.watchedMinutes > 0;
          if (!started) return false;
          return Boolean(i.episodes?.some((ep) => !ep.watched));
        }),
        sortOption === 'alpha_asc' ? 'recent_desc' : sortOption
      ),
    [searchedItems, sortOption]
  );

  const recentlyWatched = useMemo(
    () =>
      sortItems(
        searchedItems.filter((i) => Boolean(i.lastWatchedAt)),
        sortOption === 'alpha_asc' ? 'recent_desc' : sortOption
      ),
    [searchedItems, sortOption]
  );

  const watchlistItems = useMemo(
    () => sortItems(searchedItems.filter((i) => Boolean(i.inWatchlist)), sortOption),
    [searchedItems, sortOption]
  );

  const recentlyAdded = useMemo(() => {
    const newest = [...searchedItems]
      .sort(
        (a, b) =>
          (b.addedAt ?? '').localeCompare(a.addedAt ?? '') ||
          b.year - a.year ||
          a.title.localeCompare(b.title, 'de')
      )
      .slice(0, 10);
    return sortItems(newest, sortOption === 'alpha_asc' ? 'added_desc' : sortOption);
  }, [searchedItems, sortOption]);

  const images = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'image'), sortOption),
    [searchedItems, sortOption]
  );

  const musicItems = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'music'), sortOption),
    [searchedItems, sortOption]
  );

  const standaloneVideos = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'video'), sortOption),
    [searchedItems, sortOption]
  );

  const otherFiles = useMemo(
    () => sortItems(searchedItems.filter((i) => i.kind === 'other'), sortOption),
    [searchedItems, sortOption]
  );

  const focusedItems = useMemo(() => {
    if (selectedCategory === 'movie') return movies;
    if (selectedCategory === 'series') return series;
    if (selectedCategory === 'continue') return continueSeries;
    if (selectedCategory === 'recent') return recentlyWatched;
    if (selectedCategory === 'watchlist') return watchlistItems;
    if (selectedCategory === 'recently_added') return recentlyAdded;
    if (selectedCategory === 'image') return images;
    if (selectedCategory === 'music') return musicItems;
    if (selectedCategory === 'video') return standaloneVideos;
    if (selectedCategory === 'other') return otherFiles;
    return [];
  }, [
    selectedCategory,
    movies,
    series,
    continueSeries,
    recentlyWatched,
    watchlistItems,
    recentlyAdded,
    images,
    musicItems,
    standaloneVideos,
    otherFiles,
  ]);

  const hiddenSet = useMemo(
    () => new Set<HomeToggleKey>(hiddenHomeSections),
    [hiddenHomeSections]
  );

  useEffect(() => {
    if (selectedCategory !== 'all' && hiddenSet.has(selectedCategory)) {
      setSelectedCategory('all');
    }
  }, [selectedCategory, hiddenSet]);

  const normalizedOrder = useMemo(() => {
    const validKeys = new Set<HomeRowKey>(DEFAULT_HOME_ROW_ORDER);
    const seen = new Set<HomeRowKey>();
    const list: HomeRowKey[] = [];
    for (const key of homeSectionOrder) {
      if (validKeys.has(key) && !seen.has(key)) {
        seen.add(key);
        list.push(key);
      }
    }
    const prependMissing: HomeRowKey[] = [];
    for (const key of DEFAULT_HOME_ROW_ORDER) {
      if (!seen.has(key)) {
        seen.add(key);
        if (key === 'ask_duck' || key === 'recommendations') {
          prependMissing.push(key);
          continue;
        }
        if (key === 'duck_radar') {
          const recIdx = list.indexOf('recommendations');
          if (recIdx >= 0) {
            list.splice(recIdx + 1, 0, key);
            continue;
          }
          prependMissing.push(key);
          continue;
        }
        if (key === 'recently_added') {
          const wlIdx = list.indexOf('watchlist');
          if (wlIdx >= 0) {
            list.splice(wlIdx + 1, 0, key);
            continue;
          }
        }
        list.push(key);
      }
    }
    if (prependMissing.length > 0) {
      list.unshift(...prependMissing);
    }
    return list;
  }, [homeSectionOrder]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-72 rounded-2xl bg-[#121722] border border-slate-800/80 animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[1, 2, 3, 4].map((idx) => (
            <div
              key={idx}
              className="h-80 rounded-xl bg-[#121722] border border-slate-800/80 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  const getMediaKindLabel = (kind: MediaKind): string => {
    switch (kind) {
      case 'movie':
        return 'Film';
      case 'series':
        return 'Serie';
      case 'image':
        return 'Bild';
      case 'music':
        return 'Musik';
      case 'video':
        return 'Video';
      case 'other':
        return 'Sonstiges';
    }
  };

  const getMediaDetailBadge = (kind: MediaKind): string => {
    switch (kind) {
      case 'movie':
        return 'NAS-Film';
      case 'series':
        return 'NAS-Serie';
      case 'image':
        return 'NAS-Bilddatei';
      case 'music':
        return 'NAS-Musikdatei';
      case 'video':
        return 'NAS-Videodatei';
      case 'other':
        return 'NAS-Dokument / Sonstiges';
    }
  };

  const renderPosterCard = (
    item: NasMediaItem,
    compactWidth = false,
    mode: 'default' | 'continue' = 'default'
  ) => {
    const nextUnwatched = mode === 'continue' ? getNextUnwatchedEpisode(item) : undefined;
    const queuedKey = nextUnwatched
      ? `${item.id}-S${nextUnwatched.season}E${nextUnwatched.episode}`
      : item.id;
    return (
      <MediaPosterCard
        key={`${mode}-${item.id}`}
        item={item}
        compactWidth={compactWidth}
        mode={mode}
        nextUnwatched={nextUnwatched}
        isRecentlyQueued={recentlyQueuedKey === queuedKey}
        audioPlayerMode={audioPlayerMode}
        onOpenDetail={setSelectedMediaId}
        onPlayItem={onPlayItem}
        onToggleWatchlist={onToggleWatchlist}
        onQueueAdd={triggerQueueAdd}
        onMarkWatchedState={requestMarkWatchedState}
      />
    );
  };

  const rowMap: Record<
    MediaRowKey,
    {
      key: MediaRowKey;
      label: string;
      shortLabel: string;
      subtitle: string;
      icon: React.ComponentType<{ className?: string }>;
      rowItems: NasMediaItem[];
    }
  > = {
    movie: {
      key: 'movie',
      label: 'Filme',
      shortLabel: 'Filme',
      subtitle: 'Kino & Dokus vom NAS',
      icon: Film,
      rowItems: movies,
    },
    series: {
      key: 'series',
      label: 'Serien',
      shortLabel: 'Serien',
      subtitle: 'Staffeln & Episoden',
      icon: Tv,
      rowItems: series,
    },
    continue: {
      key: 'continue',
      label: 'Serie fortsetzen',
      shortLabel: 'Serie fortsetzen',
      subtitle: 'Direkt zur nächsten ungesehenen Folge',
      icon: PlayCircle,
      rowItems: continueSeries,
    },
    recent: {
      key: 'recent',
      label: 'Zuletzt angesehen',
      shortLabel: 'Zuletzt',
      subtitle: 'Verlauf vom NAS',
      icon: Clock,
      rowItems: recentlyWatched,
    },
    watchlist: {
      key: 'watchlist',
      label: 'Watchlist',
      shortLabel: 'Watchlist',
      subtitle: 'Für später vorgemerkt',
      icon: Bookmark,
      rowItems: watchlistItems,
    },
    recently_added: {
      key: 'recently_added',
      label: 'Zuletzt hinzugefügt',
      shortLabel: 'Hinzugefügt',
      subtitle: 'Neu auf dem NAS eingelesen',
      icon: PlusCircle,
      rowItems: recentlyAdded,
    },
    image: {
      key: 'image',
      label: 'Bilder',
      shortLabel: 'Bilder',
      subtitle: 'Alle Bilddateien vom NAS',
      icon: ImageIcon,
      rowItems: images,
    },
    music: {
      key: 'music',
      label: 'Musik',
      shortLabel: 'Musik',
      subtitle: 'MP3, FLAC & Audiodateien',
      icon: Music,
      rowItems: musicItems,
    },
    video: {
      key: 'video',
      label: 'Video',
      shortLabel: 'Video',
      subtitle: 'Clips & Aufnahmen (ohne Filme/Serien)',
      icon: Video,
      rowItems: standaloneVideos,
    },
    other: {
      key: 'other',
      label: 'Sonstiges',
      shortLabel: 'Sonstiges',
      subtitle: 'PDFs, Dokumente & Archive',
      icon: FileText,
      rowItems: otherFiles,
    },
  };

  const categoryRows = normalizedOrder
    .filter(
      (key): key is MediaRowKey =>
        key !== 'ask_duck' && key !== 'recommendations' && key !== 'duck_radar'
    )
    .map((key) => rowMap[key])
    .filter((row) => !hiddenSet.has(row.key));

  const visibleHomeSections = normalizedOrder.filter(
    (key) =>
      !hiddenSet.has(key) &&
      (duckAssistantEnabled || (key !== 'ask_duck' && key !== 'recommendations'))
  );

  const renderAskDuckSection = () => {
    const resolvedMatches = (askDuckResult?.matches ?? [])
      .map((match) => {
        const mediaItem = items.find((it) => it.id === match.mediaId);
        if (!mediaItem) return null;
        return { mediaItem, reason: match.reason };
      })
      .filter((entry): entry is { mediaItem: NasMediaItem; reason: string } => entry !== null);

    const resolvedMediaItems = resolvedMatches.map((m) => m.mediaItem);
    const playableMatchItems = resolvedMediaItems.filter(
      (it) =>
        it.kind === 'movie' ||
        it.kind === 'series' ||
        it.kind === 'music' ||
        it.kind === 'video' ||
        it.kind === 'image'
    );

    const handleSaveCuratedCollection = async (targetType: AskDuckCollectionType) => {
      if (!onSaveCollection || !askDuckResult || resolvedMediaItems.length === 0) return;
      setSavingCollection(true);
      setAskDuckActionFeedback(null);
      try {
        const suggestion = askDuckResult.collectionSuggestion;
        const fallbackPrefix = targetType === 'watchlist' ? 'Watchlist' : 'Playlist';
        const created = await onSaveCollection({
          collectionType: targetType,
          title:
            suggestion && suggestion.collectionType === targetType
              ? suggestion.title
              : `${fallbackPrefix}: ${askDuckResult.query.slice(0, 48)}`,
          criteriaSummary:
            suggestion?.criteriaSummary ??
            `${askDuckResult.appliedScopeLabel} · ${resolvedMediaItems.length} Einträge`,
          createdByPrompt: askDuckResult.query,
          mediaIds: resolvedMediaItems.map((m) => m.id),
        });
        setAskDuckActionFeedback(
          `„${created.title}“ auf dem NAS gespeichert (${created.mediaIds.length} Einträge).`
        );
      } catch (err) {
        setAskDuckError(
          err instanceof Error ? err.message : 'Sammlung konnte nicht gespeichert werden.'
        );
      } finally {
        setSavingCollection(false);
      }
    };

    const handleAddAllToNasWatchlist = async (mediaIds: string[]) => {
      if (!onBatchAddWatchlist || mediaIds.length === 0) return;
      setBatchAddingWatchlist(true);
      setAskDuckActionFeedback(null);
      try {
        const added = await onBatchAddWatchlist(mediaIds);
        setAskDuckActionFeedback(
          added > 0
            ? `${added} neue ${added === 1 ? 'Eintrag' : 'Einträge'} direkt in deine NAS-Watchlist übernommen.`
            : 'Alle ausgewählten Einträge befinden sich bereits auf deiner NAS-Watchlist.'
        );
      } catch (err) {
        setAskDuckError(
          err instanceof Error ? err.message : 'Watchlist konnte nicht aktualisiert werden.'
        );
      } finally {
        setBatchAddingWatchlist(false);
      }
    };

    const handleQueueAllPlayable = (list: NasMediaItem[]) => {
      let queued = 0;
      for (const it of list) {
        if (
          it.kind === 'movie' ||
          it.kind === 'series' ||
          it.kind === 'music' ||
          it.kind === 'video' ||
          it.kind === 'image'
        ) {
          onAddToQueue(it, getNextUnwatchedEpisode(it));
          queued += 1;
        }
      }
      if (queued > 0) {
        setAskDuckActionFeedback(`${queued} Einträge zur Wiedergabe-Warteschlange hinzugefügt.`);
      }
    };

    const modeTabs: Array<{ id: AskDuckMode; label: string }> = [
      { id: 'auto', label: 'Suche & Smart-KI' },
      { id: 'watchlist', label: 'Watchlist erstellen' },
      { id: 'playlist', label: 'Playlist erstellen' },
    ];

    const quickExamples: Array<{ text: string; mode: AskDuckMode }> = [
      { text: 'Science-Fiction mit etwas Comedy-Anteil', mode: 'auto' },
      { text: 'Ich suche den Film, der Thriller und Krimi beinhaltet', mode: 'auto' },
      {
        text: 'Herbst-Playlist für Musik und Bilder nach Stimmung ruhig',
        mode: 'playlist',
      },
      {
        text: 'Watchlist für Filme und Serien im Stil Neo-Noir oder Nordic Noir',
        mode: 'watchlist',
      },
      {
        text: 'Künstler Bjarne Mädel, Nordlicht Philharmonie oder Jan Martens',
        mode: 'playlist',
      },
    ];

    return (
      <section
        key="ask_duck"
        aria-label="Frag die Ente"
        className="rounded-2xl border border-slate-800/80 bg-[#121722] p-6 sm:p-8 space-y-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <AssistantAvatarImage
              src={assistantAvatarUrl}
              alt="Frag die Ente"
              sizePx={48}
              className="w-12 h-12 rounded-xl object-cover border border-amber-400/40 shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>Suche, Watchlisten &amp; Playlisten per Sprache oder Text</span>
              </div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight truncate">
                Frag die Ente
              </h2>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Frag die Ente Modus"
            className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B0E14] border border-slate-800"
          >
            {modeTabs.map((tab) => {
              const active = askDuckMode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setAskDuckMode(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-amber-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={handleAskDuckSubmit} className="space-y-3">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={askDuckQuery}
                onChange={(e) => setAskDuckQuery(e.target.value)}
                placeholder={
                  askDuckMode === 'watchlist'
                    ? 'z. B. Watchlist für Filme & Serien: Nordic Noir, Herbst oder Bjarne Mädel...'
                    : askDuckMode === 'playlist'
                      ? 'z. B. Herbst-Playlist für Musik & Bilder nach Stimmung ruhig oder Jazz...'
                      : 'z. B. Science-Fiction mit Comedy-Anteil, Künstler, Stimmung oder Herbst-Playlist...'
                }
                aria-label="Frag die Ente Suchfeld"
                className="w-full pl-10 pr-10 py-3 bg-[#0B0E14] border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
              />
              {askDuckQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setAskDuckQuery('');
                    setAskDuckResult(null);
                    setAskDuckError(null);
                    setAskDuckActionFeedback(null);
                  }}
                  aria-label="Suchfeld leeren"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleToggleVoiceSearch}
                aria-pressed={isVoiceListening}
                title={
                  isVoiceListening
                    ? 'Spracheingabe stoppen'
                    : 'Per Mikrofon suchen (Deutsch)'
                }
                className={`px-4 py-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  isVoiceListening
                    ? 'bg-rose-500/20 border-rose-400 text-rose-200'
                    : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-700/80 text-slate-200 hover:border-amber-400/60'
                }`}
              >
                {isVoiceListening ? (
                  <>
                    <MicOff className="w-4 h-4 text-rose-300" />
                    <span>Höre zu… (Stopp)</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4 text-amber-400" />
                    <span>Voice</span>
                  </>
                )}
              </button>

              <button
                type="submit"
                disabled={askDuckLoading}
                className="px-5 py-3 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {askDuckLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Kuratiere auf NAS…</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>
                      {askDuckMode === 'watchlist'
                        ? 'Watchlist erstellen'
                        : askDuckMode === 'playlist'
                          ? 'Playlist erstellen'
                          : 'Ente fragen'}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowAskDuckInfo((prev) => !prev)}
              aria-expanded={showAskDuckInfo}
              aria-controls="ask-duck-info-panel"
              title="Hinweise & Beispiele ein- oder ausblenden"
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                showAskDuckInfo
                  ? 'bg-amber-400/15 border-amber-400/60 text-amber-300'
                  : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-800 text-slate-300 hover:text-white'
              }`}
            >
              <Info className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Info</span>
            </button>
          </div>

          {showAskDuckInfo && (
            <div
              id="ask-duck-info-panel"
              className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-3"
            >
              <p className="text-xs text-slate-400 leading-relaxed">
                Finde Titel oder lass dir komplette{' '}
                <strong className="text-slate-200">Watchlisten &amp; Playlisten</strong> für{' '}
                <span className="text-slate-200">Filme, Serien, Musik &amp; Bilder</span> erstellen
                — nach{' '}
                <span className="text-slate-200">
                  Genres, Stilrichtungen, Künstlern/Schauspielern, Stimmungen oder Jahreszeiten
                </span>{' '}
                (z. B. Frühling, Sommer, Herbst, Winter).
              </p>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Beispiele:</span>
                {quickExamples.map((example) => (
                  <button
                    key={example.text}
                    type="button"
                    onClick={() => {
                      setAskDuckMode(example.mode);
                      setAskDuckQuery(example.text);
                      void executeAskDuck(example.text, example.mode);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-amber-300 transition-colors whitespace-nowrap shrink-0"
                  >
                    {example.text}
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>

        {voiceError && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/40 text-xs text-amber-200">
            {voiceError}
          </div>
        )}

        {askDuckError && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/40 text-xs text-rose-200">
            {askDuckError}
          </div>
        )}

        {askDuckActionFeedback && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-400/40 text-xs text-emerald-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{askDuckActionFeedback}</span>
          </div>
        )}

        {askDuckLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[1, 2].map((n) => (
              <div
                key={n}
                className="h-28 rounded-xl bg-[#0B0E14] border border-slate-800/80 animate-pulse"
              />
            ))}
          </div>
        )}

        {!askDuckLoading && askDuckResult && (
          <div className="pt-4 border-t border-slate-800/80 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1.5 min-w-0 flex-1">
                {askDuckResult.collectionSuggestion && (
                  <h3 className="font-display text-base sm:text-lg font-bold text-amber-300">
                    {askDuckResult.collectionSuggestion.title}
                  </h3>
                )}
                <p className="text-sm text-slate-100 leading-relaxed">
                  {askDuckResult.duckAnswer}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
                  <span>Bereich: {askDuckResult.appliedScopeLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {resolvedMatches.length}{' '}
                    {resolvedMatches.length === 1 ? 'Eintrag' : 'Einträge'}
                  </span>
                  {askDuckResult.collectionSuggestion?.criteriaSummary && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-300">
                        {askDuckResult.collectionSuggestion.criteriaSummary}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAskDuckResult(null);
                  setAskDuckActionFeedback(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                Ergebnis schließen
              </button>
            </div>

            {resolvedMatches.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {playableMatchItems.length > 0 && onStartPlaylist && (
                  <button
                    type="button"
                    onClick={() => onStartPlaylist(playableMatchItems)}
                    className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Playlist abspielen ({playableMatchItems.length})</span>
                  </button>
                )}

                {onBatchAddWatchlist && (
                  <button
                    type="button"
                    disabled={batchAddingWatchlist}
                    onClick={() =>
                      void handleAddAllToNasWatchlist(resolvedMediaItems.map((m) => m.id))
                    }
                    className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 hover:text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
                  >
                    <Bookmark className="w-3.5 h-3.5 text-amber-400" />
                    <span>
                      {batchAddingWatchlist ? 'Übernehme…' : 'Alle auf NAS-Watchlist'}
                    </span>
                  </button>
                )}

                {onSaveCollection && (
                  <>
                    <button
                      type="button"
                      disabled={savingCollection}
                      onClick={() =>
                        void handleSaveCuratedCollection(
                          askDuckResult.collectionSuggestion?.collectionType ??
                            (askDuckResult.intent === 'watchlist' ? 'watchlist' : 'playlist')
                        )
                      }
                      className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 hover:text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
                    >
                      <Save className="w-3.5 h-3.5 text-amber-400" />
                      <span>
                        {savingCollection
                          ? 'Speichere…'
                          : askDuckResult.intent === 'watchlist'
                            ? 'Watchlist auf NAS speichern'
                            : 'Playlist auf NAS speichern'}
                      </span>
                    </button>
                  </>
                )}

                {playableMatchItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleQueueAllPlayable(playableMatchItems)}
                    className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <ListPlus className="w-3.5 h-3.5" />
                    <span>Alle in Warteschlange</span>
                  </button>
                )}
              </div>
            )}

            {resolvedMatches.length === 0 ? (
              <div className="p-5 rounded-xl bg-[#0B0E14] border border-slate-800/80 text-xs text-slate-400">
                Keine passenden Inhalte für diese Kombination auf deinem NAS gefunden. Probiere
                einen anderen Künstler, eine Jahreszeit, ein Genre oder eine Stimmung.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {resolvedMatches.map(({ mediaItem, reason }) => {
                  const canPlayInModal =
                    mediaItem.kind === 'movie' ||
                    mediaItem.kind === 'series' ||
                    mediaItem.kind === 'music' ||
                    mediaItem.kind === 'video' ||
                    mediaItem.kind === 'image';
                  return (
                    <article
                      key={`ask-duck-${mediaItem.id}`}
                      className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 hover:border-amber-400/50 transition-colors flex gap-4"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedMediaId(mediaItem.id)}
                        className="w-20 h-28 rounded-lg overflow-hidden border border-slate-800 bg-slate-900 shrink-0 focus:outline-none focus:ring-2 focus:ring-amber-400"
                        aria-label={`${mediaItem.title} Details öffnen`}
                      >
                        <img
                          src={mediaItem.coverUrl}
                          alt={mediaItem.title}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          decoding="async"
                          className="w-full h-full object-cover"
                        />
                      </button>

                      <div className="min-w-0 flex-1 flex flex-col justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                            <span className="text-amber-400 font-medium">
                              {getMediaKindLabel(mediaItem.kind)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{mediaItem.year}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{mediaItem.genre}</span>
                            {mediaItem.seasons && mediaItem.seasons.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate text-slate-300">
                                  {mediaItem.seasons.slice(0, 2).join('/')}
                                </span>
                              </>
                            )}
                          </div>

                          <h3 className="font-display text-sm font-bold text-white truncate">
                            {mediaItem.title}
                          </h3>

                          <p className="text-xs text-amber-200/95 leading-snug line-clamp-2">
                            {reason}
                          </p>

                          {(mediaItem.studio || (mediaItem.cast && mediaItem.cast.length > 0)) && (
                            <p className="text-[11px] text-slate-400 truncate">
                              {mediaItem.studio ? mediaItem.studio : ''}
                              {mediaItem.studio && mediaItem.cast?.length ? ' · ' : ''}
                              {mediaItem.cast?.length ? mediaItem.cast.slice(0, 2).join(', ') : ''}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {canPlayInModal && (
                            <button
                              type="button"
                              onClick={() =>
                                onPlayItem(mediaItem, getNextUnwatchedEpisode(mediaItem))
                              }
                              className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>
                                {mediaItem.kind === 'image' ? 'Ansehen' : 'Abspielen'}
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onToggleWatchlist(mediaItem.id)}
                            className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                              mediaItem.inWatchlist
                                ? 'bg-amber-400/15 border-amber-400/50 text-amber-300'
                                : 'bg-[#121722] hover:bg-slate-800 border-slate-800 text-slate-300'
                            }`}
                          >
                            <Bookmark
                              className={`w-3 h-3 ${mediaItem.inWatchlist ? 'fill-current' : ''}`}
                            />
                            <span>{mediaItem.inWatchlist ? 'Vorgemerkt' : 'Merken'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedMediaId(mediaItem.id)}
                            className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0"
                          >
                            Details
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {savedCollections.length > 0 && (
          <div className="pt-4 border-t border-slate-800/80 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <ListVideo className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Gespeicherte Enten-Watchlisten &amp; Playlisten</span>
              </div>
              <span className="text-xs text-slate-400 tabular-nums">
                {savedCollections.length} gespeichert
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {savedCollections.map((col) => {
                const colItems = col.mediaIds
                  .map((id) => items.find((it) => it.id === id))
                  .filter((it): it is NasMediaItem => Boolean(it));
                const kindCounts = Array.from(
                  new Set(colItems.map((it) => getMediaKindLabel(it.kind)))
                );

                return (
                  <div
                    key={col.id}
                    className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-col justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                        <span className="text-amber-400 font-semibold">
                          {col.collectionType === 'watchlist' ? 'Watchlist' : 'Playlist'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{colItems.length} Einträge</span>
                        {kindCounts.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{kindCounts.join(', ')}</span>
                          </>
                        )}
                      </div>
                      <h4 className="font-display text-sm font-bold text-white truncate">
                        {col.title}
                      </h4>
                      <p className="text-xs text-slate-400 line-clamp-1">
                        {col.criteriaSummary}
                      </p>
                      {colItems.length > 0 && (
                        <p className="text-[11px] text-slate-500 truncate">
                          {colItems.map((i) => i.title).join(' · ')}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {colItems.length > 0 && onStartPlaylist && (
                        <button
                          type="button"
                          onClick={() => onStartPlaylist(colItems)}
                          className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>Abspielen</span>
                        </button>
                      )}
                      {colItems.length > 0 && onBatchAddWatchlist && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleAddAllToNasWatchlist(colItems.map((it) => it.id))
                          }
                          className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 hover:text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Bookmark className="w-3 h-3 text-amber-400" />
                          <span>Auf NAS-Watchlist</span>
                        </button>
                      )}
                      {onDeleteCollection && (
                        <button
                          type="button"
                          onClick={() => void onDeleteCollection(col.id)}
                          aria-label={`${col.title} löschen`}
                          className="px-2.5 py-1.5 rounded-lg bg-[#121722] hover:bg-rose-500/15 border border-slate-800 hover:border-rose-500/40 text-xs font-medium text-slate-400 hover:text-rose-300 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ml-auto"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Löschen</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    );
  };

  const renderRecommendationsSection = () => (
    <section
      key="recommendations"
      className="rounded-2xl border border-slate-800/80 bg-[#121722] p-6 sm:p-8 flex flex-col justify-between gap-5"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3.5 min-w-0">
            <AssistantAvatarImage
              src={assistantAvatarUrl}
              alt="EntenCenter Enten-Assistent"
              sizePx={48}
              className="w-12 h-12 rounded-xl object-cover border border-amber-400/40 shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>Analyse deines Nutzungsverhaltens &amp; Sehverlaufs</span>
              </div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight truncate">
                Dein Enten Assistent empfiehlt
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRefreshRecommendations}
              disabled={recommendationsLoading}
              className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-amber-400 ${
                  recommendationsLoading ? 'animate-spin' : ''
                }`}
              />
              <span>{recommendationsLoading ? 'Analysiere...' : 'Neu analysieren'}</span>
            </button>
            <button
              type="button"
              onClick={onOpenAssistant}
              className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Assistent</span>
            </button>
          </div>
        </div>

        <p className="text-sm text-slate-200 leading-relaxed">
          {recommendations?.duckSummary ??
            'Der Enten-Assistent wertet dein bisheriges NAS-Nutzungsverhalten sowie deine angeschauten Inhalte aus und empfiehlt dir darauf basierend passende Filme und Serien.'}
        </p>
      </div>

      {currentRecommendedEntry ? (
          <div
            data-preserve-dark="true"
            onMouseEnter={() => setIsSliderPaused(true)}
            onMouseLeave={() => setIsSliderPaused(false)}
            onFocusCapture={() => setIsSliderPaused(true)}
            onBlurCapture={() => setIsSliderPaused(false)}
            className="relative rounded-2xl overflow-hidden border border-slate-800 bg-[#0B0E14] min-h-[260px] sm:min-h-[280px] flex flex-col justify-between group"
            aria-roledescription="carousel"
            aria-label="Dein Enten Assistent empfiehlt"
          >
          <img
            key={currentRecommendedEntry.item.id}
            src={currentRecommendedEntry.item.coverUrl}
            alt={currentRecommendedEntry.item.title}
            referrerPolicy="no-referrer"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover object-center opacity-55 group-hover:scale-[1.02] transition-all duration-700"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0B0E14] via-[#0B0E14]/90 to-[#0B0E14]/25" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0B0E14] via-transparent to-[#0B0E14]/40" />

          {/* Top Meta & Slider Controls */}
          <div className="relative z-10 px-4 sm:px-5 pt-4 flex items-center justify-between gap-3">
            <p className="text-[11px] font-medium text-slate-300 truncate tabular-nums">
              <span className="text-amber-400 font-semibold">
                Empfehlung {safeSlideIndex + 1} von {recommendedEntries.length}
              </span>{' '}
              · {currentRecommendedEntry.item.kind === 'series' ? 'Serie' : 'Film'} ·{' '}
              {currentRecommendedEntry.item.year} · {currentRecommendedEntry.item.genre}
            </p>

            {recommendedEntries.length > 1 && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsSliderPaused((prev) => !prev)}
                  title={isSliderPaused ? 'Auto-Slide fortsetzen' : 'Auto-Slide pausieren'}
                  aria-label={isSliderPaused ? 'Auto-Slide fortsetzen' : 'Auto-Slide pausieren'}
                  className="w-7 h-7 rounded-lg bg-[#0B0E14]/80 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white flex items-center justify-center transition-colors shrink-0"
                >
                  {isSliderPaused ? (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  ) : (
                    <Pause className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handlePrevSlide}
                  title="Vorherige Empfehlung"
                  aria-label="Vorherige Empfehlung"
                  className="w-7 h-7 rounded-lg bg-[#0B0E14]/80 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleNextSlide}
                  title="Nächste Empfehlung"
                  aria-label="Nächste Empfehlung"
                  className="w-7 h-7 rounded-lg bg-[#0B0E14]/80 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Spotlight Content */}
          <div className="relative z-10 px-4 sm:px-5 py-4 flex items-end gap-4">
            <button
              type="button"
              onClick={() => setSelectedMediaId(currentRecommendedEntry.item.id)}
              className="hidden sm:block shrink-0 rounded-lg overflow-hidden border border-slate-700/80 shadow-xl focus:outline-none focus:ring-2 focus:ring-amber-400"
              aria-label={`${currentRecommendedEntry.item.title} Details öffnen`}
            >
              <img
                src={currentRecommendedEntry.item.coverUrl}
                alt={currentRecommendedEntry.item.title}
                referrerPolicy="no-referrer"
                decoding="async"
                className="w-20 h-28 object-cover"
              />
            </button>

            <div className="min-w-0 flex-1 space-y-2">
              <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight truncate">
                {currentRecommendedEntry.item.title}
              </h3>
              <p className="text-xs sm:text-sm font-medium text-amber-300 line-clamp-2 leading-snug">
                {currentRecommendedEntry.reason}
              </p>
              {currentRecommendedEntry.matchedSignals.length > 0 && (
                <p className="text-[11px] text-slate-300/90 truncate">
                  Analyse-Basis: {currentRecommendedEntry.matchedSignals.join(' · ')}
                </p>
              )}
              <p className="text-xs text-slate-300/90 line-clamp-2 leading-relaxed max-w-xl">
                {currentRecommendedEntry.item.synopsis}
              </p>

              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <button
                  type="button"
                  onClick={() =>
                    onPlayItem(
                      currentRecommendedEntry.item,
                      getNextUnwatchedEpisode(currentRecommendedEntry.item)
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Abspielen</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMediaId(currentRecommendedEntry.item.id)}
                  className="px-3.5 py-2 rounded-lg bg-[#161B26]/90 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0"
                >
                  Details
                </button>
                {(() => {
                  const targetEpisode = getNextUnwatchedEpisode(currentRecommendedEntry.item);
                  const qKey = targetEpisode
                    ? `${currentRecommendedEntry.item.id}-S${targetEpisode.season}E${targetEpisode.episode}`
                    : currentRecommendedEntry.item.id;
                  const isJustQueued = recentlyQueuedKey === qKey;
                  return (
                    <button
                      type="button"
                      onClick={() => triggerQueueAdd(currentRecommendedEntry.item, targetEpisode)}
                      className="px-3 py-2 rounded-lg bg-[#161B26]/90 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                    >
                      {isJustQueued ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-300">In Warteschlange</span>
                        </>
                      ) : (
                        <>
                          <ListPlus className="w-3.5 h-3.5 text-amber-400" />
                          <span>Zur Warteschlange</span>
                        </>
                      )}
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Google TV / Android TV Slide Indicator Bar */}
          <div className="relative z-10 px-4 sm:px-5 pb-3.5 pt-2 border-t border-slate-800/70 bg-[#0B0E14]/75 backdrop-blur-sm flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {recommendedEntries.map((entry, idx) => {
                const isActive = idx === safeSlideIndex;
                return (
                  <button
                    key={`slide-dot-${entry.item.id}`}
                    type="button"
                    onClick={() => setActiveSlideIndex(idx)}
                    aria-label={`Empfehlung ${idx + 1}: ${entry.item.title}`}
                    title={entry.item.title}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      isActive ? 'w-8 bg-amber-400' : 'w-4 bg-slate-600/80 hover:bg-slate-400'
                    }`}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-2.5 text-[11px] text-slate-400 shrink-0 tabular-nums">
              {isSliderPaused && (
                <span className="text-amber-300/90 hidden sm:inline">Pausiert</span>
              )}
              <span className="font-mono text-slate-200">
                {safeSlideIndex + 1} / {recommendedEntries.length}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-6 rounded-xl bg-[#0B0E14] border border-slate-800/80 text-xs text-slate-400">
          Keine passenden Empfehlungen verfügbar.
        </div>
      )}
    </section>
  );

  const renderDuckRadarSection = () => {
    const seriesNotifLabelMap: Record<CalendarNotificationMode, string> = {
      favorites_all: 'Nur für Favoriten',
      favorites_new_series: 'Nur für Favoriten neue Serien',
      favorites_new_episodes: 'Nur für Favoriten neue Folgen',
      all: 'Alle',
      all_new_series: 'Alle nur neue Serien',
      all_new_episodes: 'Alle nur neue Folgen',
    };
    const seriesNotifLabel = seriesNotifLabelMap[calendarNotificationMode];
    const filmNotifLabel = filmFavoritesOnly ? 'Nur für Favoriten' : 'Alle';

    const radarCardTabs = [
      { idx: 0, label: 'Serienstarts', count: duckRadarSeriesStarts.length },
      { idx: 1, label: 'Neue Folgen', count: duckRadarNewEpisodes.length },
      { idx: 2, label: 'Filmstarts', count: duckRadarFilmStarts.length },
    ];

    return (
      <section
        key="duck_radar"
        aria-label="Enten-Radar Slider"
        className="rounded-2xl border border-slate-800/80 bg-[#0F141E] p-6 sm:p-8 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-amber-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Serienkalender &amp; Filmstarts im Überblick</span>
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-0.5">
              <h2 className="font-display text-lg sm:text-xl font-bold text-white">
                Enten-Radar
              </h2>
              <span className="px-2 py-0.5 rounded bg-[#121722] border border-slate-800 text-[11px] text-slate-300">
                Serien: <strong className="text-amber-300 font-medium">{seriesNotifLabel}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-[#121722] border border-slate-800 text-[11px] text-slate-300">
                Filmstarts: <strong className="text-amber-300 font-medium">{filmNotifLabel}</strong>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden sm:flex items-center gap-1 bg-[#121722] border border-slate-800 rounded-lg p-1">
              {radarCardTabs.map((tab) => (
                <button
                  key={tab.idx}
                  type="button"
                  onClick={() => scrollDuckRadarToCard(tab.idx)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap tabular-nums ${
                    duckRadarIndex === tab.idx
                      ? 'bg-amber-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {tab.idx + 1}. {tab.label} ({tab.count})
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => scrollDuckRadarToCard((duckRadarIndex + 2) % 3)}
                aria-label="Vorherige Enten-Radar-Karte"
                className="w-8 h-8 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-200 flex items-center justify-center transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollDuckRadarToCard((duckRadarIndex + 1) % 3)}
                aria-label="Nächste Enten-Radar-Karte"
                className="w-8 h-8 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-200 flex items-center justify-center transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Horizontaler Slider mit den drei Enten-Radar-Karten */}
        <div
          ref={duckRadarTrackRef}
          onScroll={(e) => {
            const container = e.currentTarget;
            const children = Array.from(container.children) as HTMLElement[];
            if (children.length === 0) return;
            let closestIdx = 0;
            let bestDist = Number.POSITIVE_INFINITY;
            children.forEach((child, idx) => {
              const dist = Math.abs(child.offsetLeft - container.offsetLeft - container.scrollLeft);
              if (dist < bestDist) {
                bestDist = dist;
                closestIdx = idx;
              }
            });
            setDuckRadarIndex(closestIdx);
          }}
          className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory scroll-smooth"
        >
          {/* Karte 1: Serienstarts aus dem Serienkalender */}
          <article className="w-[88%] sm:w-[70%] lg:w-[46%] xl:w-[38%] shrink-0 snap-start rounded-xl bg-[#121722] border border-slate-800/90 p-5 flex flex-col justify-between gap-4">
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-xl bg-amber-400/15 border border-amber-400/35 text-amber-400 flex items-center justify-center shrink-0">
                    <Tv className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-amber-400">1 · Serienkalender</p>
                    <h3 className="font-display text-sm sm:text-base font-bold text-white truncate">
                      Serienstarts
                    </h3>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md bg-[#0B0E14] border border-slate-800 font-mono text-[11px] text-amber-300 tabular-nums shrink-0">
                  {duckRadarSeriesStarts.length}
                </span>
              </div>

              {duckRadarSeriesStarts.length === 0 ? (
                <p className="text-xs text-slate-400 py-4">
                  {seriesOnlyNewEpisodes
                    ? `Ausgeblendet durch Benachrichtigungseinstellung („${seriesNotifLabel}“).`
                    : seriesFavoritesOnly
                      ? 'Aktuell keine favorisierten Serienstarts im Serienkalender.'
                      : 'Aktuell keine Serienstarts im Serienkalender eingetragen.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {duckRadarSeriesStarts.slice(0, 3).map((rel) => {
                    const matchedNasItem = rel.nasMatch.nasMediaId
                      ? items.find((it) => it.id === rel.nasMatch.nasMediaId)
                      : undefined;
                    return (
                      <div
                        key={`dr-start-${rel.id}`}
                        className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80 hover:border-amber-400/50 transition-colors flex items-center gap-3"
                      >
                        {rel.coverUrl && (
                          <img
                            src={rel.coverUrl}
                            alt={rel.seriesTitle}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="w-9 h-12 rounded object-cover shrink-0 border border-slate-800"
                          />
                        )}
                        <button
                          type="button"
                          onClick={onOpenCalendar}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="text-xs font-semibold text-white truncate">
                            {rel.seriesTitle}
                          </p>
                          <p className="text-[11px] text-amber-300 truncate tabular-nums">
                            Start S{String(rel.seasonNumber).padStart(2, '0')}E
                            {String(rel.episodeNumber).padStart(2, '0')} · {rel.releaseDate}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {rel.provider}
                            {rel.nasMatch.availableOnNas ? ' · Auf NAS' : ''}
                          </p>
                        </button>
                        {matchedNasItem && (
                          <button
                            type="button"
                            onClick={() => onPlayItem(matchedNasItem)}
                            title={`${rel.seriesTitle} im Enten Player starten`}
                            aria-label={`${rel.seriesTitle} abspielen`}
                            className="w-8 h-8 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center justify-center shrink-0 transition-colors"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onOpenCalendar}
              className="w-full py-2 px-3 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-colors"
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Alle Serienstarts im Serienkalender</span>
            </button>
          </article>

          {/* Karte 2: Neue Folgen aus dem Serienkalender */}
          <article className="w-[88%] sm:w-[70%] lg:w-[46%] xl:w-[38%] shrink-0 snap-start rounded-xl bg-[#121722] border border-slate-800/90 p-5 flex flex-col justify-between gap-4">
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-xl bg-amber-400/15 border border-amber-400/35 text-amber-400 flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-amber-400">2 · Serienkalender</p>
                    <h3 className="font-display text-sm sm:text-base font-bold text-white truncate">
                      Neue Folgen
                    </h3>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md bg-[#0B0E14] border border-slate-800 font-mono text-[11px] text-amber-300 tabular-nums shrink-0">
                  {duckRadarNewEpisodes.length}
                </span>
              </div>

              {duckRadarNewEpisodes.length === 0 ? (
                <p className="text-xs text-slate-400 py-4">
                  {seriesOnlyNewSeries
                    ? `Ausgeblendet durch Benachrichtigungseinstellung („${seriesNotifLabel}“).`
                    : seriesFavoritesOnly
                      ? 'Aktuell keine neuen Folgen deiner favorisierten Serien verfügbar.'
                      : 'Aktuell keine neuen Folgen im Serienkalender verfügbar.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {duckRadarNewEpisodes.slice(0, 3).map((rel) => {
                    const matchedNasItem = rel.nasMatch.nasMediaId
                      ? items.find((it) => it.id === rel.nasMatch.nasMediaId)
                      : undefined;
                    return (
                      <div
                        key={`dr-ep-${rel.id}`}
                        className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80 hover:border-amber-400/50 transition-colors flex items-center gap-3"
                      >
                        {rel.coverUrl && (
                          <img
                            src={rel.coverUrl}
                            alt={rel.seriesTitle}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="w-9 h-12 rounded object-cover shrink-0 border border-slate-800"
                          />
                        )}
                        <button
                          type="button"
                          onClick={onOpenCalendar}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="text-xs font-semibold text-white truncate">
                            {rel.seriesTitle}
                          </p>
                          <p className="text-[11px] text-amber-300 truncate tabular-nums">
                            S{String(rel.seasonNumber).padStart(2, '0')}E
                            {String(rel.episodeNumber).padStart(2, '0')} — {rel.episodeTitle}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {rel.provider} · {rel.releaseDate}
                            {rel.nasMatch.availableOnNas ? ' · Auf NAS' : ''}
                          </p>
                        </button>
                        {matchedNasItem && (
                          <button
                            type="button"
                            onClick={() => onPlayItem(matchedNasItem)}
                            title={`${rel.seriesTitle} im Enten Player starten`}
                            aria-label={`${rel.seriesTitle} abspielen`}
                            className="w-8 h-8 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center justify-center shrink-0 transition-colors"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onOpenCalendar}
              className="w-full py-2 px-3 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-colors"
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Alle neuen Folgen im Serienkalender</span>
            </button>
          </article>

          {/* Karte 3: Filmstarts aus Filmstarts */}
          <article className="w-[88%] sm:w-[70%] lg:w-[46%] xl:w-[38%] shrink-0 snap-start rounded-xl bg-[#121722] border border-slate-800/90 p-5 flex flex-col justify-between gap-4">
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-xl bg-amber-400/15 border border-amber-400/35 text-amber-400 flex items-center justify-center shrink-0">
                    <Clapperboard className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-amber-400">3 · Filmstarts</p>
                    <h3 className="font-display text-sm sm:text-base font-bold text-white truncate">
                      Filmstarts
                    </h3>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md bg-[#0B0E14] border border-slate-800 font-mono text-[11px] text-amber-300 tabular-nums shrink-0">
                  {duckRadarFilmStarts.length}
                </span>
              </div>

              {duckRadarFilmStarts.length === 0 ? (
                <p className="text-xs text-slate-400 py-4">
                  {filmFavoritesOnly && filmStarts.length > 0
                    ? 'Aktuell keine favorisierten Filmstarts markiert. Markiere Titel unter Filmstarts als Favorit.'
                    : 'Aktuell noch keine Filmstarts geladen. Öffne Filmstarts, um aktuelle Kinostarts & Streaming-Filme abzurufen.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {duckRadarFilmStarts.slice(0, 3).map((film) => {
                    const matchedNasItem = film.nasMatch.nasMediaId
                      ? items.find((it) => it.id === film.nasMatch.nasMediaId)
                      : undefined;
                    const thumbUrl = film.coverUrl || film.posterUrl;
                    return (
                      <div
                        key={`dr-film-${film.id}`}
                        className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80 hover:border-amber-400/50 transition-colors flex items-center gap-3"
                      >
                        {thumbUrl && (
                          <img
                            src={thumbUrl}
                            alt={film.title}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="w-9 h-12 rounded object-cover shrink-0 border border-slate-800"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenFilmStarts?.()}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="text-xs font-semibold text-white truncate">{film.title}</p>
                          <p className="text-[11px] text-amber-300 truncate tabular-nums">
                            {film.releaseDate} · {film.channel}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {film.providerOrDistributor}
                            {film.nasMatch.availableOnNas ? ' · Auf NAS' : ''}
                          </p>
                        </button>
                        {matchedNasItem && (
                          <button
                            type="button"
                            onClick={() => onPlayItem(matchedNasItem)}
                            title={`${film.title} im Enten Player starten`}
                            aria-label={`${film.title} abspielen`}
                            className="w-8 h-8 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 flex items-center justify-center shrink-0 transition-colors"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => onOpenFilmStarts?.()}
              className="w-full py-2 px-3 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-colors"
            >
              <Clapperboard className="w-3.5 h-3.5" />
              <span>Alle Filmstarts öffnen</span>
            </button>
          </article>
        </div>

        {/* Mobile / Touch Slide-Indikator */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1.5">
            {radarCardTabs.map((tab) => (
              <button
                key={`dot-${tab.idx}`}
                type="button"
                onClick={() => scrollDuckRadarToCard(tab.idx)}
                aria-label={`${tab.label} anzeigen`}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  duckRadarIndex === tab.idx
                    ? 'w-8 bg-amber-400'
                    : 'w-4 bg-slate-700 hover:bg-slate-500'
                }`}
              />
            ))}
          </div>
          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
            {duckRadarIndex + 1} / 3 · {radarCardTabs[duckRadarIndex]?.label}
          </span>
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-8">
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
            Dieses Profil zeigt ausschließlich Inhalte von FSK 0 bis FSK {userFskLimit} an.
          </span>
        </div>
      )}

      {/* Steuerleiste: Rubrikenauswahl sowie Suche, Genre-Filter & Sortierung + Cover/Info-Abruf */}
      {(showHomeCategoryTabs || showHomeFilterSearch || (onEnrichMetadata && items.length > 0)) && (
        <div
          className={`flex flex-col md:flex-row md:items-center gap-4 pb-2 border-b border-slate-800/80 ${
            showHomeCategoryTabs ? 'justify-between' : 'md:justify-end'
          }`}
        >
          {showHomeCategoryTabs && (
            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#121722] border border-slate-800/80 rounded-lg w-fit">
              {[
                { id: 'all' as const, label: 'Startseite (Alle Reihen)', icon: LayoutGrid },
                ...categoryRows.map((row) => ({
                  id: row.key,
                  label: `${row.label} (${row.rowItems.length})`,
                  icon: row.icon,
                })),
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSelectedCategory(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                      selectedCategory === tab.id
                        ? 'bg-amber-400 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {showHomeFilterSearch && (
              <>
                <label className="flex items-center gap-2 text-xs text-slate-400">
                  <Filter className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Genre:</span>
                  <select
                    aria-label="Nach Genre filtern"
                    value={selectedGenre}
                    onChange={(e) => setSelectedGenre(e.target.value)}
                    className="bg-[#121722] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    <option value="all">Alle Genres</option>
                    {availableGenres.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-400">
                  <ArrowUpDown className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Sortierung:</span>
                  <select
                    value={sortOption}
                    onChange={(e) => setSortOption(e.target.value as SortOption)}
                    className="bg-[#121722] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                      <option key={key} value={key}>
                        {SORT_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Titel oder Genre suchen..."
                    className="w-full pl-9 pr-4 py-2 bg-[#121722] border border-slate-800/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </>
            )}

            {onEnrichMetadata && items.length > 0 && (
              <button
                type="button"
                onClick={onEnrichMetadata}
                disabled={enrichingMetadata}
                className="px-3 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800/80 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-amber-400 ${enrichingMetadata ? 'animate-spin' : ''}`}
                />
                <span>{enrichingMetadata ? 'Lade Infos & Cover…' : 'Infos & Cover laden'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Startseiten-Ansicht: Empfehlungen, Enten-Radar & Cover-Reihen in frei konfigurierbarer Reihenfolge */}
      {selectedCategory === 'all' ? (
        visibleHomeSections.length === 0 ? (
          <div className="p-10 text-center bg-[#121722] border border-slate-800/80 rounded-2xl space-y-4">
            <SlidersHorizontal className="w-8 h-8 text-amber-400 mx-auto" />
            <div className="space-y-1">
              <h3 className="font-display text-base font-semibold text-white">
                Alle Startseiten-Rubriken sind ausgeblendet
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Du hast in deinen Profileinstellungen alle Menüpunkte für die Startseite
                ausgeblendet. Blende einzelne Rubriken jederzeit wieder ein.
              </p>
            </div>
            {onOpenProfile && (
              <button
                type="button"
                onClick={onOpenProfile}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                Startseite im Profil einblenden
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {visibleHomeSections.map((sectionKey) => {
              if (sectionKey === 'ask_duck') {
                return renderAskDuckSection();
              }
              if (sectionKey === 'recommendations') {
                return renderRecommendationsSection();
              }
              if (sectionKey === 'duck_radar') {
                return renderDuckRadarSection();
              }
              const row = rowMap[sectionKey];
              const Icon = row.icon;
              return (
                <section
                  key={row.key}
                  className="flex flex-row gap-3 sm:gap-5 items-stretch pb-8 border-b border-slate-800/60 last:border-b-0"
                >
                  {/* Linker Icon-Button direkt neben den Covern */}
                  <button
                    type="button"
                    onClick={() => setSelectedCategory(row.key)}
                    aria-label={`${row.label} anzeigen (${row.rowItems.length} Titel)`}
                    title={`${row.label} — ${row.subtitle}`}
                    className="w-24 sm:w-32 shrink-0 p-3 sm:p-4 rounded-xl bg-[#121722] border border-slate-800/80 hover:border-amber-400/70 hover:bg-amber-400/5 flex flex-col items-center justify-center gap-2.5 text-center transition-colors group"
                  >
                    <span className="w-12 h-12 rounded-xl bg-amber-400/15 border border-amber-400/30 text-amber-400 group-hover:bg-amber-400 group-hover:text-slate-950 flex items-center justify-center transition-colors">
                      <Icon className="w-6 h-6" />
                    </span>
                    <div className="min-w-0 w-full">
                      <h3 className="font-display text-xs sm:text-sm font-bold text-white group-hover:text-amber-300 transition-colors leading-tight">
                        {row.label === 'Zuletzt angesehen' ? 'Zuletzt' : row.label}
                      </h3>
                      <p className="text-[11px] font-mono text-slate-400 tabular-nums mt-0.5">
                        {row.rowItems.length} {row.key === 'image' || row.key === 'other' ? 'Dateien' : 'Titel'}
                      </p>
                    </div>
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-400 whitespace-nowrap">
                      <span>Öffnen</span>
                      <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </button>

                  {/* Rechte Seite des Bildschirms: Cover-Reihe */}
                  <div className="flex-1 min-w-0">
                    {row.rowItems.length === 0 ? (
                      <div className="h-full min-h-[180px] rounded-xl bg-[#121722] border border-slate-800/80 flex items-center justify-center p-6 text-xs text-slate-400">
                        Keine Einträge in der Kategorie „{row.label}“ gefunden.
                      </div>
                    ) : (
                      <div className="flex gap-4 overflow-x-auto pb-3 snap-x">
                        {row.rowItems
                          .slice(0, 24)
                          .map((item) =>
                            renderPosterCard(
                              item,
                              true,
                              row.key === 'continue' ? 'continue' : 'default'
                            )
                          )}
                        {row.rowItems.length > 24 && (
                          <button
                            type="button"
                            onClick={() => setSelectedCategory(row.key)}
                            className="w-40 shrink-0 snap-start rounded-xl bg-[#121722] border border-slate-800/80 hover:border-amber-400/70 p-4 flex flex-col items-center justify-center gap-2 text-center transition-colors group"
                          >
                            <span className="w-11 h-11 rounded-full bg-amber-400/15 border border-amber-400/35 text-amber-400 flex items-center justify-center group-hover:bg-amber-400 group-hover:text-slate-950 transition-colors">
                              <ChevronRight className="w-5 h-5" />
                            </span>
                            <span className="text-xs font-semibold text-white">
                              Alle {row.rowItems.length} Titel
                            </span>
                            <span className="text-[11px] text-amber-400">
                              Kategorie öffnen
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        /* Fokus-Ansicht einer einzelnen Kategorie: Links Icon-Buttons + Rechts komplettes Cover-Grid */
        <div className="flex flex-row gap-3 sm:gap-6 items-start">
          <aside className="w-24 sm:w-32 shrink-0 bg-[#121722] border border-slate-800/80 rounded-xl p-2 space-y-2 sticky top-[calc(5.25rem+var(--app-top-clearance,0px))]">
            {categoryRows.map((row) => {
              const Icon = row.icon;
              const active = selectedCategory === row.key;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setSelectedCategory(row.key)}
                  className={`w-full p-2.5 rounded-lg flex flex-col items-center justify-center gap-1.5 text-center transition-colors ${
                    active
                      ? 'bg-amber-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span className="text-xs font-medium truncate w-full">{row.shortLabel}</span>
                  <span
                    className={`text-[11px] font-mono tabular-nums ${
                      active ? 'text-slate-900' : 'text-slate-400'
                    }`}
                  >
                    {row.rowItems.length}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setSelectedCategory('all')}
              className="w-full pt-2 border-t border-slate-800/80 px-2 py-2 flex flex-col items-center gap-1 text-[11px] text-amber-400 hover:text-amber-300 font-medium"
            >
              <LayoutGrid className="w-4 h-4" />
              <span>Alle Reihen</span>
            </button>
          </aside>

          <div className="flex-1 min-w-0">
            {focusedItems.length === 0 ? (
              <div className="p-12 text-center bg-[#121722] border border-slate-800/80 rounded-xl space-y-4">
                <p className="text-sm text-slate-300 font-medium">
                  {selectedCategory === 'watchlist'
                    ? 'Deine Watchlist ist aktuell leer. Markiere Filme oder Serien über das Lesezeichen-Symbol, um sie für später zu speichern.'
                    : 'Keine passenden Einträge in dieser Kategorie.'}
                </p>
                {selectedCategory === 'watchlist' && selectedGenre === 'all' && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('all')}
                    className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    EntenTheke durchsuchen
                  </button>
                )}
                {selectedGenre !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setSelectedGenre('all')}
                    className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    Genre-Filter zurücksetzen
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5 sm:gap-5">
                  {focusedItems
                    .slice(0, gridVisibleLimit)
                    .map((item) =>
                      renderPosterCard(
                        item,
                        false,
                        selectedCategory === 'continue' ? 'continue' : 'default'
                      )
                    )}
                </div>
                {focusedItems.length > gridVisibleLimit && (
                  <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setGridVisibleLimit((prev) => prev + 48)}
                      className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold transition-colors tabular-nums"
                    >
                      Weitere {Math.min(48, focusedItems.length - gridVisibleLimit)} Titel laden (
                      {gridVisibleLimit} / {focusedItems.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setGridVisibleLimit(focusedItems.length)}
                      className="px-4 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium transition-colors tabular-nums"
                    >
                      Alle {focusedItems.length} anzeigen
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Serien- / Medien-Menü: Informationen, Cover-Wahl, manuelle Suche & alle Folgen */}
      {selectedMedia && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.5rem+var(--app-top-clearance,0px))] pb-[calc(0.5rem+var(--app-bottom-clearance,0px))]"
          onClick={() => setSelectedMediaId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-detail-title"
            className="w-full max-w-[min(56rem,calc(100vw-1rem))] max-h-[calc(100dvh-1rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Feste Kopfzeile des Detailfensters (bleibt beim Scrollen erreichbar) */}
            <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-slate-800/80 bg-[#0F141E] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-amber-400 truncate tabular-nums">
                  {getMediaDetailBadge(selectedMedia.kind)} · {selectedMedia.year} ·{' '}
                  {selectedMedia.genre}
                  {(selectedMedia.kind === 'movie' || selectedMedia.kind === 'series') &&
                    selectedMedia.fsk !== undefined &&
                    ` · FSK ${selectedMedia.fsk}`}
                  {selectedMedia.kind === 'series' && selectedMedia.seriesStatus && (
                    <>
                      {' · '}
                      <span
                        className={
                          selectedMedia.seriesStatus === 'canceled'
                            ? 'text-rose-400 font-semibold'
                            : selectedMedia.seriesStatus === 'ended'
                              ? 'text-sky-300 font-semibold'
                              : 'text-emerald-400 font-semibold'
                        }
                      >
                        {selectedMedia.seriesStatus === 'canceled'
                          ? 'Serie eingestellt'
                          : selectedMedia.seriesStatus === 'ended'
                            ? 'Serie beendet'
                            : 'Laufende Serie'}
                      </span>
                    </>
                  )}
                </p>
                <h3
                  id="library-detail-title"
                  className="font-display text-base sm:text-xl font-bold text-white truncate"
                >
                  {selectedMedia.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMediaId(null)}
                aria-label="Menü schließen"
                className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Einheitlich scrollbarer Modal-Inhalt (Info-Bereich + Cover-Wahl + Manuelle Suche + alle Folgen) */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              {/* Oberer Info-Bereich mit Cover & Serien-/Filminfos */}
              <div
                className={`flex ${
                  displayInfo.isCompactHeight
                    ? 'flex-row'
                    : 'flex-col sm:flex-row'
                } border-b border-slate-800/80`}
              >
                <div
                  className={`${
                    displayInfo.isCompactHeight
                      ? 'w-28 sm:w-36 aspect-[3/4] m-3 rounded-xl'
                      : 'w-32 sm:w-44 aspect-[3/4] sm:aspect-auto sm:min-h-[230px] mx-auto sm:mx-0 mt-4 sm:mt-0 rounded-xl sm:rounded-none'
                  } overflow-hidden bg-slate-900 shrink-0`}
                >
                  <img
                    src={selectedMedia.customCoverUrl || selectedMedia.coverUrl}
                    alt={selectedMedia.title}
                    referrerPolicy="no-referrer"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                </div>

                <div className="flex-1 p-4 sm:p-6 flex flex-col justify-between gap-4 min-w-0">
                  <div className="space-y-3">
                    {selectedMedia.kind === 'series' && selectedMedia.seriesStatus && (
                      <div
                        role="status"
                        className={`p-3 rounded-lg border flex items-start gap-2.5 ${
                          selectedMedia.seriesStatus === 'canceled'
                            ? 'border-rose-500/45 bg-rose-950/35 text-rose-100'
                            : selectedMedia.seriesStatus === 'ended'
                              ? 'border-sky-500/45 bg-sky-950/35 text-sky-100'
                              : 'border-emerald-500/35 bg-emerald-950/25 text-emerald-100'
                        }`}
                      >
                        {selectedMedia.seriesStatus === 'canceled' ? (
                          <Ban className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        ) : selectedMedia.seriesStatus === 'ended' ? (
                          <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                        ) : (
                          <Tv className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <p
                            className={`text-xs font-semibold ${
                              selectedMedia.seriesStatus === 'canceled'
                                ? 'text-rose-300'
                                : selectedMedia.seriesStatus === 'ended'
                                  ? 'text-sky-300'
                                  : 'text-emerald-300'
                            }`}
                          >
                            {selectedMedia.seriesStatus === 'canceled'
                              ? 'Serienstatus: Eingestellt'
                              : selectedMedia.seriesStatus === 'ended'
                                ? 'Serienstatus: Beendet'
                                : 'Serienstatus: Laufend'}
                          </p>
                          <p className="text-xs text-slate-200/90 mt-0.5">
                            {selectedMedia.seriesStatusDetail ??
                              (selectedMedia.seriesStatus === 'canceled'
                                ? 'Diese Serie wurde abgesetzt und wird nicht fortgesetzt.'
                                : selectedMedia.seriesStatus === 'ended'
                                  ? 'Diese Serie ist regulär abgeschlossen.'
                                  : 'Weitere Staffeln oder Folgen sind angekündigt.')}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Cover-Wahl & Manuelle Online-Suche für Filme/Serien */}
                    {onUpdateMediaMetadata &&
                      (selectedMedia.kind === 'movie' ||
                        selectedMedia.kind === 'series' ||
                        selectedMedia.kind === 'video' ||
                        selectedMedia.kind === 'music') && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setCoverPickerOpen((v) => !v);
                              setManualSearchOpen(false);
                            }}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                              coverPickerOpen
                                ? 'bg-amber-400 border-amber-400 text-slate-950 font-semibold'
                                : 'bg-[#0B0E14] border-slate-700 text-slate-200 hover:border-amber-400/60 hover:text-amber-300'
                            }`}
                          >
                            <Images className="w-3.5 h-3.5" />
                            <span>
                              Cover wählen
                              {availableCoverOptions.length > 1
                                ? ` (${availableCoverOptions.length})`
                                : ''}
                            </span>
                          </button>

                          {selectedMedia.kind !== 'music' && (
                            <button
                              type="button"
                              onClick={() => {
                                setManualSearchOpen((v) => !v);
                                setCoverPickerOpen(false);
                              }}
                              className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                                manualSearchOpen
                                  ? 'bg-amber-400 border-amber-400 text-slate-950 font-semibold'
                                  : 'bg-[#0B0E14] border-slate-700 text-slate-200 hover:border-amber-400/60 hover:text-amber-300'
                              }`}
                            >
                              <Globe className="w-3.5 h-3.5" />
                              <span>
                                {selectedMedia.kind === 'series'
                                  ? 'Serien-Infos manuell suchen'
                                  : 'Infos manuell suchen'}
                              </span>
                            </button>
                          )}
                        </div>
                      )}

                    {/* Inline Cover-Wahl Panel */}
                    {coverPickerOpen && onUpdateMediaMetadata && (
                      <div className="p-3.5 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-white">
                            Cover-Auswahl ({availableCoverOptions.length} verfügbar)
                          </p>
                          <button
                            type="button"
                            disabled={coverLoadingMore}
                            onClick={() => void handleLoadMoreCoversForSelected()}
                            className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-amber-300 flex items-center gap-1.5 disabled:opacity-60"
                          >
                            {coverLoadingMore ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3 h-3" />
                            )}
                            <span>Weitere Cover laden</span>
                          </button>
                        </div>

                        {availableCoverOptions.length > 0 ? (
                          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
                            {availableCoverOptions.map((url, idx) => {
                              const isActive =
                                (selectedMedia.customCoverUrl || selectedMedia.coverUrl) === url;
                              return (
                                <button
                                  key={`${url}-${idx}`}
                                  type="button"
                                  onClick={() => void handleSelectCoverForSelected(url)}
                                  className={`relative aspect-[3/4] rounded-lg overflow-hidden border-2 transition-all ${
                                    isActive
                                      ? 'border-amber-400 ring-2 ring-amber-400/40'
                                      : 'border-slate-800 hover:border-slate-600'
                                  }`}
                                >
                                  <img
                                    src={url}
                                    alt={`Cover-Option ${idx + 1}`}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    decoding="async"
                                    className="w-full h-full object-cover"
                                  />
                                  {isActive && (
                                    <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center shadow">
                                      <Check className="w-3 h-3" />
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400">
                            Noch keine alternativen Cover geladen. Klicke auf „Weitere Cover laden“ oder nutze eine eigene Bild-URL.
                          </p>
                        )}

                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="url"
                            value={customCoverUrlInput}
                            onChange={(e) => setCustomCoverUrlInput(e.target.value)}
                            placeholder="Eigene Cover-URL (https://...)"
                            aria-label="Eigene Cover-URL"
                            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const trimmed = customCoverUrlInput.trim();
                              if (trimmed) {
                                void handleSelectCoverForSelected(trimmed);
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold whitespace-nowrap shrink-0"
                          >
                            Cover übernehmen
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Inline Manuelle Online-Suche für Filme & komplette Serientitel */}
                    {manualSearchOpen && onUpdateMediaMetadata && (
                      <div className="p-3.5 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="space-y-0.5">
                            <p className="text-xs font-semibold text-white">
                              Informationen &amp; Cover manuell online suchen
                            </p>
                            {selectedMedia.kind === 'series' && (
                              <p className="text-[11px] text-amber-300">
                                Bei Serien wird ausschließlich nach dem kompletten Serientitel gesucht — alle Folgen bleiben gruppiert erhalten.
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 bg-[#121722] border border-slate-800 rounded-lg p-0.5">
                            {(['movie', 'series', 'video'] as const).map((k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => void handleChangeKindForSelected(k)}
                                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                                  selectedMedia.kind === k
                                    ? 'bg-amber-400 text-slate-950 font-semibold'
                                    : 'text-slate-400 hover:text-white'
                                }`}
                              >
                                {k === 'movie' ? 'Film' : k === 'series' ? 'Serie' : 'Video'}
                              </button>
                            ))}
                          </div>
                        </div>

                        <form
                          onSubmit={(e) => void handleRunManualOnlineSearch(e)}
                          className="flex flex-col sm:flex-row gap-2"
                        >
                          <input
                            type="text"
                            value={manualSearchQuery}
                            onChange={(e) => setManualSearchQuery(e.target.value)}
                            placeholder={
                              manualSearchKind === 'series'
                                ? 'Kompletter Serientitel (z. B. Dark)'
                                : 'Filmtitel (optional mit Jahr, z. B. Dune 2021)'
                            }
                            aria-label="Titel für manuelle Online-Suche"
                            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                          />
                          <button
                            type="submit"
                            disabled={manualSearchLoading}
                            className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                          >
                            {manualSearchLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Search className="w-3.5 h-3.5" />
                            )}
                            <span>Online suchen</span>
                          </button>
                        </form>

                        {manualSearchFeedback && (
                          <p className="text-xs text-amber-300">{manualSearchFeedback}</p>
                        )}

                        {manualSearchResults.length > 0 && (
                          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                            {manualSearchResults.map((cand) => (
                              <div
                                key={cand.id}
                                className="p-2.5 rounded-lg bg-[#121722] border border-slate-800 flex items-start gap-3"
                              >
                                <div className="w-12 h-16 rounded bg-slate-900 overflow-hidden shrink-0">
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
                                      <Film className="w-4 h-4" />
                                    </div>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="text-xs font-semibold text-white truncate">
                                      {cand.title}
                                      {cand.year ? ` (${cand.year})` : ''}
                                    </p>
                                    <span className="text-[10px] font-mono text-slate-400">
                                      {cand.sourceLabel}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-amber-300 truncate">
                                    {cand.genre}
                                    {cand.director ? ` · ${cand.director}` : ''}
                                    {cand.studio ? ` · ${cand.studio}` : ''}
                                  </p>
                                  <p className="text-[11px] text-slate-300 line-clamp-2">
                                    {cand.synopsis}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => void handleApplyManualOnlineCandidate(cand)}
                                    className="mt-1 px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold inline-flex items-center gap-1"
                                  >
                                    <Check className="w-3 h-3" />
                                    <span>Infos &amp; Cover übernehmen</span>
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <p className="text-sm text-slate-200 leading-relaxed">
                      {selectedMedia.synopsis}
                    </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300 pt-1">
                    <div className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80">
                      <span className="text-slate-500 block">Format / Codec</span>
                      <span className="font-mono text-slate-200">{selectedMedia.codec}</span>
                    </div>
                    <div className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80">
                      <span className="text-slate-500 block">
                        {selectedMedia.kind === 'image' || selectedMedia.kind === 'other'
                          ? 'Dateigröße auf NAS'
                          : 'Tonspuren'}
                      </span>
                      <span className="truncate block">
                        {selectedMedia.kind === 'image' || selectedMedia.kind === 'other'
                          ? selectedMedia.fileSize ?? 'Auf NAS gespeichert'
                          : selectedMedia.audioTracks.join(', ')}
                      </span>
                    </div>
                    {selectedMedia.studio && (
                      <div className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80">
                        <span className="text-slate-500 flex items-center gap-1">
                          <Building2 className="w-3 h-3 text-amber-400" />
                          <span>Produktionsstudio</span>
                        </span>
                        <span className="truncate block text-slate-200">{selectedMedia.studio}</span>
                      </div>
                    )}
                    {selectedMedia.cast && selectedMedia.cast.length > 0 && (
                      <div className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800/80">
                        <span className="text-slate-500 flex items-center gap-1">
                          <Users className="w-3 h-3 text-amber-400" />
                          <span>Besetzung / Mitwirkende</span>
                        </span>
                        <span className="truncate block text-slate-200">
                          {selectedMedia.cast.join(', ')}
                        </span>
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 flex items-center gap-1.5 font-mono truncate">
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="truncate">
                      {selectedMedia.kind === 'series'
                        ? selectedMedia.nasPath.replace(/\/[^/]+$/, '/')
                        : selectedMedia.nasPath}
                    </span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/70">
                  <div className="space-y-1">
                    <span className="text-xs text-slate-400 flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                      {selectedMedia.kind === 'series'
                        ? `${selectedMedia.episodes?.length ?? 0} Folgen direkt auf dem NAS verfügbar`
                        : selectedMedia.kind === 'image' || selectedMedia.kind === 'other'
                          ? `${selectedMedia.fileFormat ?? getMediaKindLabel(selectedMedia.kind)}${
                              selectedMedia.fileSize ? ` · ${selectedMedia.fileSize}` : ''
                            }`
                          : `Laufzeit: ${selectedMedia.totalDurationMinutes} Min.`}
                    </span>
                    {(selectedMedia.lastWatchedAt || selectedMedia.watchedWithoutDate) && (
                      <p className="text-[11px] text-emerald-400 flex items-center gap-1.5 tabular-nums">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          {selectedMedia.lastWatchedAt
                            ? `Gesehen am ${new Date(selectedMedia.lastWatchedAt).toLocaleDateString(
                                'de-DE',
                                { day: '2-digit', month: '2-digit', year: 'numeric' }
                              )} um ${new Date(selectedMedia.lastWatchedAt).toLocaleTimeString(
                                'de-DE',
                                { hour: '2-digit', minute: '2-digit' }
                              )} Uhr`
                            : 'Als gesehen markiert (ohne Datum)'}
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedMedia.kind !== 'image' &&
                      selectedMedia.kind !== 'other' &&
                      (Boolean(selectedMedia.lastWatchedAt) ||
                        Boolean(selectedMedia.watchedWithoutDate) ||
                        selectedMedia.watchedMinutes > 0 ||
                        selectedMedia.episodesWatchedCount > 0) && (
                        <button
                          type="button"
                          onClick={() => requestMarkWatchedState(selectedMedia.id, 'item', false)}
                          className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 hover:border-amber-400/60 text-slate-200 hover:text-amber-300 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                          title={
                            selectedMedia.kind === 'series'
                              ? 'Alle Folgen dieser Serie als ungesehen markieren'
                              : 'Als ungesehen markieren'
                          }
                        >
                          <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                          <span>
                            {selectedMedia.kind === 'series'
                              ? 'Serie als ungesehen'
                              : 'Als ungesehen'}
                          </span>
                        </button>
                      )}

                    {selectedMedia.kind !== 'image' &&
                      selectedMedia.kind !== 'other' &&
                      (selectedMedia.kind === 'series'
                        ? selectedMedia.episodes?.some((ep) => !ep.watched) ??
                          selectedMedia.episodesWatchedCount < (selectedMedia.totalEpisodes ?? 0)
                        : !selectedMedia.watchedWithoutDate &&
                          selectedMedia.watchedMinutes <
                            Math.max(1, selectedMedia.totalDurationMinutes - 1)) && (
                        <button
                          type="button"
                          onClick={() => requestMarkWatchedState(selectedMedia.id, 'item', true)}
                          className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 hover:border-emerald-400/60 text-slate-200 hover:text-emerald-300 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                          title={
                            selectedMedia.kind === 'series'
                              ? 'Alle Folgen dieser Serie als gesehen markieren'
                              : 'Als gesehen markieren'
                          }
                        >
                          <Eye className="w-3.5 h-3.5 text-emerald-400" />
                          <span>
                            {selectedMedia.kind === 'series'
                              ? 'Serie als gesehen'
                              : 'Als gesehen'}
                          </span>
                        </button>
                      )}

                    {selectedMedia.kind !== 'image' && selectedMedia.kind !== 'other' && (
                      <button
                        type="button"
                        onClick={() => triggerQueueAdd(selectedMedia)}
                        className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 hover:border-amber-400/60 text-slate-200 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        {recentlyQueuedKey === selectedMedia.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <ListPlus className="w-3.5 h-3.5 text-amber-400" />
                        )}
                        <span>
                          {recentlyQueuedKey === selectedMedia.id
                            ? 'Hinzugefügt'
                            : 'In Warteschlange'}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onToggleWatchlist(selectedMedia.id)}
                      aria-pressed={Boolean(selectedMedia.inWatchlist)}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                        selectedMedia.inWatchlist
                          ? 'bg-amber-400/15 border-amber-400/60 text-amber-300 hover:bg-amber-400/25'
                          : 'bg-[#0B0E14] border-slate-700 text-slate-200 hover:border-amber-400/60 hover:text-white'
                      }`}
                    >
                      <Bookmark
                        className={`w-3.5 h-3.5 ${selectedMedia.inWatchlist ? 'fill-current text-amber-400' : ''}`}
                      />
                      <span>
                        {selectedMedia.inWatchlist ? 'Auf Watchlist' : 'Zur Watchlist'}
                      </span>
                    </button>

                    {selectedMedia.kind !== 'image' && selectedMedia.kind !== 'other' ? (
                      <button
                        type="button"
                        onClick={() => {
                          const target = selectedMedia;
                          setSelectedMediaId(null);
                          onPlayItem(target);
                        }}
                        className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>
                          {selectedMedia.kind === 'series'
                            ? 'Aktuelle Folge fortsetzen'
                            : selectedMedia.kind === 'music'
                              ? audioPlayerMode === 'external'
                                ? 'Im externen Player öffnen'
                                : 'Musik abspielen'
                              : selectedMedia.kind === 'video'
                                ? 'Video abspielen'
                                : 'Film abspielen'}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSelectedMediaId(null)}
                        className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Vorschau schließen</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Folgen-Liste für Serien auf dem NAS */}
            {selectedMedia.kind === 'series' && selectedMedia.episodes && (
              <div className="p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="font-display text-sm font-semibold text-white">
                    Verfügbare Folgen auf dem NAS
                  </h4>
                  {availableSeasons.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B0E14] border border-slate-800 rounded-lg">
                      {availableSeasons.map((seasonNum) => (
                        <button
                          key={seasonNum}
                          type="button"
                          onClick={() => setActiveSeason(seasonNum)}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                            activeSeason === seasonNum
                              ? 'bg-amber-400 text-slate-950 font-semibold'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Staffel {seasonNum}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800/80 bg-[#0B0E14] overflow-hidden">
                  {selectedMedia.episodes
                    .filter((ep) => ep.season === activeSeason)
                    .map((ep) => {
                      const isCurrent =
                        selectedMedia.currentEpisode?.season === ep.season &&
                        selectedMedia.currentEpisode?.episode === ep.episode;
                      const stillSrc = ep.screenshotUrl ?? selectedMedia.coverUrl;
                      return (
                        <div
                          key={`S${ep.season}E${ep.episode}`}
                          className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-900/50 transition-colors"
                        >
                          <div className="flex flex-col sm:flex-row gap-4 min-w-0 flex-1">
                            {/* 16:9 Episoden-Screenshot */}
                            <button
                              type="button"
                              onClick={() => {
                                const target = selectedMedia;
                                setSelectedMediaId(null);
                                onPlayItem(target, ep);
                              }}
                              aria-label={`S${String(ep.season).padStart(2, '0')}E${String(
                                ep.episode
                              ).padStart(2, '0')} ${ep.title} abspielen`}
                              className="group/still relative w-full sm:w-44 aspect-video rounded-lg overflow-hidden border border-slate-800 bg-slate-900 shrink-0 focus:outline-none focus:ring-2 focus:ring-amber-400/60"
                            >
                              <img
                                src={stillSrc}
                                alt={`${selectedMedia.title} – S${String(ep.season).padStart(
                                  2,
                                  '0'
                                )}E${String(ep.episode).padStart(2, '0')} ${ep.title}`}
                                referrerPolicy="no-referrer"
                                loading="lazy"
                                decoding="async"
                                className="w-full h-full object-cover group-hover/still:scale-105 transition-transform duration-300"
                              />
                              <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent flex items-center justify-center">
                                <span className="w-9 h-9 rounded-full bg-amber-400/90 text-slate-950 flex items-center justify-center opacity-0 group-hover/still:opacity-100 transition-opacity shadow-md">
                                  <Play className="w-4 h-4 fill-current ml-0.5" />
                                </span>
                              </div>
                              <span className="absolute bottom-1.5 left-2 font-mono text-[10px] font-semibold text-white bg-black/70 px-1.5 py-0.5 rounded tabular-nums">
                                S{String(ep.season).padStart(2, '0')}E
                                {String(ep.episode).padStart(2, '0')}
                              </span>
                            </button>

                            {/* Titel, Status & Kurzinformation */}
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-semibold text-amber-400 tabular-nums">
                                  S{String(ep.season).padStart(2, '0')}E
                                  {String(ep.episode).padStart(2, '0')}
                                </span>
                                <span className="text-sm font-semibold text-white">
                                  {ep.title}
                                </span>
                                {ep.watched && (
                                  <span
                                    title="Bereits auf NAS gesehen"
                                    className="inline-flex items-center gap-1 text-[11px] text-emerald-400 shrink-0"
                                  >
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span>Gesehen</span>
                                  </span>
                                )}
                                {isCurrent && !ep.watched && (
                                  <span className="text-[11px] text-amber-300 font-medium shrink-0">
                                    Aktuell
                                  </span>
                                )}
                              </div>

                              <p className="text-xs text-slate-300 leading-relaxed line-clamp-2">
                                {ep.summary}
                              </p>

                              <p className="text-[11px] font-mono text-slate-500 truncate tabular-nums">
                                {ep.durationMinutes} Min. · {ep.fileSize} · {ep.nasPath}
                              </p>
                            </div>
                          </div>

                          {/* Aktionen pro Folge */}
                          <div className="flex flex-wrap items-center gap-2 shrink-0 self-start lg:self-center">
                            <button
                              type="button"
                              onClick={() =>
                                requestMarkWatchedState(selectedMedia.id, 'episode', !ep.watched, {
                                  season: ep.season,
                                  episode: ep.episode,
                                })
                              }
                              title={
                                ep.watched
                                  ? 'Folge als ungesehen markieren'
                                  : 'Folge als gesehen markieren'
                              }
                              className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                                ep.watched
                                  ? 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-300 hover:text-amber-300'
                                  : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200 hover:text-emerald-300'
                              }`}
                            >
                              {ep.watched ? (
                                <>
                                  <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                                  <span>Als ungesehen</span>
                                </>
                              ) : (
                                <>
                                  <Eye className="w-3.5 h-3.5 text-emerald-400" />
                                  <span>Als gesehen</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => triggerQueueAdd(selectedMedia, ep)}
                              title="Folge zur Warteschlange hinzufügen"
                              className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                            >
                              {recentlyQueuedKey ===
                              `${selectedMedia.id}-S${ep.season}E${ep.episode}` ? (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <ListPlus className="w-3.5 h-3.5 text-amber-400" />
                              )}
                              <span>
                                {recentlyQueuedKey ===
                                `${selectedMedia.id}-S${ep.season}E${ep.episode}`
                                  ? 'Hinzugefügt'
                                  : '+ Warteschlange'}
                              </span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                const target = selectedMedia;
                                setSelectedMediaId(null);
                                onPlayItem(target, ep);
                              }}
                              className="px-3.5 py-1.5 rounded-lg bg-[#121722] hover:bg-amber-400 border border-slate-700 hover:border-amber-400 text-slate-200 hover:text-slate-950 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              <span>Folge abspielen</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Dialogfenster: Wann wurde Film oder Serie als gesehen markiert? */}
      {watchDateTarget && (() => {
        const releaseInfo = resolveReleaseWatchInfo(
          watchDateTarget.item,
          watchDateTarget.episode
        );
        const nowPreview = new Date().toLocaleString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const epLabel = watchDateTarget.episode
          ? `S${String(watchDateTarget.episode.season).padStart(2, '0')}E${String(
              watchDateTarget.episode.episode
            ).padStart(2, '0')}${
              watchDateTarget.episode.title ? ` · ${watchDateTarget.episode.title}` : ''
            }`
          : null;

        return (
          <div
            className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center px-3 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
            onClick={() => setWatchDateTarget(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="watch-date-dialog-title"
              className="w-full max-w-[min(28rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] bg-[#121722] border border-slate-700/85 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 px-4 sm:px-5 py-3.5 border-b border-slate-800/80 bg-[#0F141E] flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {watchDateTarget.step === 'custom' && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomWatchError(null);
                        setWatchDateTarget((prev) =>
                          prev ? { ...prev, step: 'choose' } : null
                        );
                      }}
                      aria-label="Zurück zur Auswahl"
                      className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300 hover:text-white shrink-0 transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-amber-400 truncate">
                      {watchDateTarget.step === 'choose'
                        ? 'Als gesehen markieren'
                        : 'Eigenes Datum & Uhrzeit'}
                    </p>
                    <h3
                      id="watch-date-dialog-title"
                      className="font-display text-base font-bold text-white truncate"
                    >
                      {watchDateTarget.item.title}
                    </h3>
                    {epLabel && (
                      <p className="text-[11px] font-mono text-slate-400 truncate tabular-nums">
                        {epLabel}
                      </p>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setWatchDateTarget(null)}
                  aria-label="Dialog schließen"
                  className="p-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white shrink-0 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {watchDateTarget.step === 'choose' ? (
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 space-y-3">
                  <p className="text-xs text-slate-300">
                    Wann möchtest du{' '}
                    <span className="font-semibold text-white">
                      {epLabel
                        ? 'diese Folge'
                        : watchDateTarget.item.kind === 'series'
                          ? 'diese Serie'
                          : 'diesen Film'}
                    </span>{' '}
                    als gesehen markieren?
                  </p>

                  <div className="space-y-2.5">
                    <button
                      type="button"
                      onClick={handleConfirmWatchNow}
                      className="w-full min-h-[56px] p-3.5 rounded-xl bg-[#0B0E14] hover:bg-slate-900 border border-slate-800 hover:border-emerald-400/60 text-left flex items-center justify-between gap-3 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0">
                          <Clock className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white group-hover:text-emerald-300 transition-colors">
                            Jetzt gesehen
                          </p>
                          <p className="text-xs font-mono text-slate-400 truncate tabular-nums">
                            {nowPreview} Uhr
                          </p>
                        </div>
                      </div>
                      <Check className="w-4 h-4 text-slate-500 group-hover:text-emerald-400 shrink-0 transition-colors" />
                    </button>

                    <button
                      type="button"
                      onClick={handleConfirmWatchAtRelease}
                      className="w-full min-h-[56px] p-3.5 rounded-xl bg-[#0B0E14] hover:bg-slate-900 border border-slate-800 hover:border-amber-400/60 text-left flex items-center justify-between gap-3 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-lg bg-amber-400/15 border border-amber-400/30 text-amber-400 flex items-center justify-center shrink-0">
                          <CalendarDays className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white group-hover:text-amber-300 transition-colors">
                            Als Release gesehen
                          </p>
                          <p className="text-xs font-mono text-slate-400 truncate tabular-nums">
                            {releaseInfo.displayDate} · {releaseInfo.sourceHint}
                          </p>
                        </div>
                      </div>
                      <Check className="w-4 h-4 text-slate-500 group-hover:text-amber-400 shrink-0 transition-colors" />
                    </button>

                    <button
                      type="button"
                      onClick={handleConfirmWatchWithoutDate}
                      className="w-full min-h-[56px] p-3.5 rounded-xl bg-[#0B0E14] hover:bg-slate-900 border border-slate-800 hover:border-slate-500 text-left flex items-center justify-between gap-3 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-lg bg-slate-700/35 border border-slate-600/40 text-slate-200 flex items-center justify-center shrink-0">
                          <Eye className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white group-hover:text-slate-100 transition-colors">
                            Ohne Datum gesehen
                          </p>
                          <p className="text-xs text-slate-400 truncate">
                            Als gesehen markieren ohne Datumseintrag
                          </p>
                        </div>
                      </div>
                      <Check className="w-4 h-4 text-slate-500 group-hover:text-slate-200 shrink-0 transition-colors" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setCustomWatchError(null);
                        setWatchDateTarget((prev) =>
                          prev ? { ...prev, step: 'custom' } : null
                        );
                      }}
                      className="w-full min-h-[56px] p-3.5 rounded-xl bg-[#0B0E14] hover:bg-slate-900 border border-slate-800 hover:border-sky-400/60 text-left flex items-center justify-between gap-3 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-400 flex items-center justify-center shrink-0">
                          <Calendar className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white group-hover:text-sky-300 transition-colors">
                            Eigenes Datum und Uhrzeit angeben
                          </p>
                          <p className="text-xs text-slate-400 truncate">
                            Datum &amp; Uhrzeit im Eingabefenster festlegen
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-sky-400 shrink-0 transition-colors" />
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  onSubmit={handleConfirmWatchCustomDate}
                  className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 space-y-4"
                >
                  <p className="text-xs text-slate-300">
                    Gib das gewünschte Datum und die Uhrzeit für den Sehverlauf an.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-slate-300 block">Datum</span>
                      <input
                        type="date"
                        value={customWatchDate}
                        onChange={(e) => {
                          setCustomWatchDate(e.target.value);
                          setCustomWatchError(null);
                        }}
                        required
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-amber-400 [color-scheme:dark]"
                      />
                    </label>

                    <label className="space-y-1.5 block">
                      <span className="text-xs font-medium text-slate-300 block">Uhrzeit</span>
                      <input
                        type="time"
                        value={customWatchTime}
                        onChange={(e) => {
                          setCustomWatchTime(e.target.value);
                          setCustomWatchError(null);
                        }}
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-amber-400 [color-scheme:dark]"
                      />
                    </label>
                  </div>

                  {customWatchError && (
                    <p className="text-xs text-rose-400 font-medium">{customWatchError}</p>
                  )}

                  <div className="space-y-2.5 pt-1">
                    <button
                      type="submit"
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                    >
                      <Check className="w-4 h-4 shrink-0" />
                      <span>Mit Datum &amp; Uhrzeit als gesehen markieren</span>
                    </button>

                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="h-px flex-1 bg-slate-800" />
                      <span>oder</span>
                      <span className="h-px flex-1 bg-slate-800" />
                    </div>

                    <button
                      type="button"
                      onClick={handleConfirmWatchWithoutDate}
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 hover:border-emerald-400/60 text-slate-200 hover:text-emerald-300 text-xs sm:text-sm font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                    >
                      <Eye className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Ohne Datum als gesehen markieren</span>
                    </button>
                  </div>
                </form>
              )}

              <div className="shrink-0 px-4 sm:px-5 py-3 border-t border-slate-800/80 bg-[#0F141E] flex items-center justify-end gap-2">
                {watchDateTarget.step === 'custom' && (
                  <button
                    type="button"
                    onClick={() => {
                      setCustomWatchError(null);
                      setWatchDateTarget((prev) =>
                        prev ? { ...prev, step: 'choose' } : null
                      );
                    }}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-slate-300 hover:text-white text-xs font-medium transition-colors whitespace-nowrap"
                  >
                    Zurück
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setWatchDateTarget(null)}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-slate-300 hover:text-white text-xs font-medium transition-colors whitespace-nowrap"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
