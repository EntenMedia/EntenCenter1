import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Play,
  Pause,
  Volume2,
  Subtitles,
  SkipForward,
  SkipBack,
  CheckCircle2,
  ListVideo,
  ListPlus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Cast,
  Tv,
  Tablet,
  Smartphone,
  Monitor,
  ExternalLink,
  AlertCircle,
  Camera,
  SlidersHorizontal,
  Download,
  FileText,
  Gauge,
  Music,
  VolumeX,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import {
  NasMediaItem,
  NasSeriesEpisode,
  PlaybackQueueItem,
  SmartHomeRemoteState,
} from '../types/marcente';
import {
  CastStateSnapshot,
  DiscoveredCastDevice,
  connectChromecastDevice,
  disconnectChromecast,
  discoverChromecastDevices,
  getSavedManualChromecastHost,
  loadItemOnChromecast,
  readCastSnapshot,
  requestChromecastSession,
  saveManualChromecastHost,
  subscribeCastState,
  syncChromecastPlayback,
} from '../lib/chromecast';
import { inferMimeTypeFromPath, openNativeExternalPlayer } from '../lib/nasClient';
import { LiveClockBadge } from './LiveClockBadge';

export type PlayerDeviceMode = 'tv' | 'tablet' | 'mobile' | 'desktop';

function detectPlayerDeviceMode(): PlayerDeviceMode {
  if (typeof window === 'undefined') return 'desktop';

  const ua = window.navigator.userAgent || '';
  const width = window.innerWidth;
  const height = window.innerHeight;
  const maxTouchPoints = window.navigator.maxTouchPoints || 0;
  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const isStandaloneApp =
    (typeof window.matchMedia === 'function' &&
      (window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches)) ||
    Boolean((window.navigator as { standalone?: boolean }).standalone);

  // 1. Smart TV / TV-Box / Spielkonsole / Big-Screen TV
  const isTvUa =
    /smart[- ]?tv|tizen|web0s|webos|android tv|googletv|bravia|appletv|aft[a-z0-9]|firetv|crkey|roku|xbox|playstation|kodi|viera|netcast|hbbtv/i.test(
      ua
    );
  if (isTvUa) return 'tv';

  // 2. Handy / Smartphone-App
  const isMobileUa =
    /iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/i.test(ua);
  if (
    isMobileUa ||
    (width < 768 && (coarsePointer || isStandaloneApp || maxTouchPoints > 0 || width < 640))
  ) {
    return 'mobile';
  }

  // 3. Tablet (inkl. iPadOS, Android-Tablets & Touch-Displays 768–1280px)
  const isIpadOs = /macintosh/i.test(ua) && maxTouchPoints > 1;
  const isAndroidTablet = /android/i.test(ua) && !/mobile/i.test(ua);
  const isTabletUa = /ipad|tablet|playbook|silk/i.test(ua) || isIpadOs || isAndroidTablet;
  if (
    isTabletUa ||
    (coarsePointer && Math.max(width, height) >= 768 && Math.min(width, height) >= 600)
  ) {
    return 'tablet';
  }

  // Großes 16:9 Vollbild ohne Touch & ohne Mauszeiger -> TV-Präsentation
  if (width >= 1920 && !coarsePointer && maxTouchPoints === 0 && Boolean(document.fullscreenElement)) {
    return 'tv';
  }

  return 'desktop';
}

const DEVICE_LABELS: Record<PlayerDeviceMode, string> = {
  tv: 'TV-Modus',
  tablet: 'Tablet-Modus',
  mobile: 'Handy-App',
  desktop: 'Kino-Modus',
};

function formatSeekBadge(seconds: number): string {
  const abs = Math.max(1, Math.round(Math.abs(seconds)));
  if (abs < 60) return `${abs}s`;
  const mins = Math.floor(abs / 60);
  const rem = abs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

function formatSeekAria(seconds: number): string {
  const abs = Math.max(1, Math.round(Math.abs(seconds)));
  if (abs < 60) return `${abs} Sekunden`;
  const mins = Math.floor(abs / 60);
  const rem = abs % 60;
  if (rem === 0) return mins === 1 ? '1 Minute' : `${mins} Minuten`;
  return `${mins} Min. ${rem} Sek.`;
}

function formatDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

interface MediaPlayerModalProps {
  item: NasMediaItem;
  queue: PlaybackQueueItem[];
  libraryItems: NasMediaItem[];
  onClose: () => void;
  onPlaybackEnded: () => void;
  onSyncProgress: (
    mediaId: string,
    watchedMinutes: number,
    incrementEpisode?: boolean
  ) => Promise<void>;
  onPlayNext: () => void;
  onPlayQueueIndex: (index: number) => void;
  onAddToQueue: (item: NasMediaItem, episode?: NasSeriesEpisode) => void;
  onRemoveFromQueue: (queueId: string) => void;
  onMoveQueueItem: (queueId: string, direction: 'up' | 'down') => void;
  onClearQueue: () => void;
  smartHomeState?: SmartHomeRemoteState | null;
  controlsTimeoutSec?: number;
  seekBackwardSec?: number;
  seekForwardSec?: number;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  item,
  queue,
  libraryItems,
  onClose,
  onPlaybackEnded,
  onSyncProgress,
  onPlayNext,
  onPlayQueueIndex,
  onAddToQueue,
  onRemoveFromQueue,
  onMoveQueueItem,
  onClearQueue,
  smartHomeState = null,
  controlsTimeoutSec = 3,
  seekBackwardSec = 30,
  seekForwardSec = 30,
}) => {
  const initialStartMin =
    item.watchedMinutes >= item.totalDurationMinutes ? 0 : item.watchedMinutes;

  const [deviceMode, setDeviceMode] = useState<PlayerDeviceMode>(() => detectPlayerDeviceMode());
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentMin, setCurrentMin] = useState(initialStartMin);
  const [simulatedSec, setSimulatedSec] = useState(initialStartMin * 60);
  const [selectedAudio, setSelectedAudio] = useState(item.audioTracks[0] ?? 'Standard');
  const [selectedSub, setSelectedSub] = useState('Aus');
  const [syncing, setSyncing] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const [activeSheet, setActiveSheet] = useState<'none' | 'queue' | 'cast' | 'tracks'>('none');
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(true);
  const [quickAddMediaId, setQuickAddMediaId] = useState<string>(
    libraryItems[0]?.id ?? ''
  );
  const [quickAddEpisodeKey, setQuickAddEpisodeKey] = useState<string>('');
  const autoFinishedPathRef = useRef<string | null>(null);

  const [castSnapshot, setCastSnapshot] = useState<CastStateSnapshot>(() => readCastSnapshot());
  const [castBusy, setCastBusy] = useState<boolean>(false);
  const [castMessage, setCastMessage] = useState<string | null>(null);
  const [manualCastHost, setManualCastHost] = useState<string>(() => getSavedManualChromecastHost());
  const castAutoScannedRef = useRef<boolean>(false);

  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [shutterFlash, setShutterFlash] = useState(false);
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  const mediaImgRef = useRef<HTMLImageElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const playPauseBtnRef = useRef<HTMLButtonElement | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const screenshotNoticeTimerRef = useRef<number | null>(null);

  const [realMediaSec, setRealMediaSec] = useState(0);
  const [realMediaDurationSec, setRealMediaDurationSec] = useState(0);
  const [realMediaFallback, setRealMediaFallback] = useState(false);
  const [mediaBuffering, setMediaBuffering] = useState(false);
  const [imageProxyFailed, setImageProxyFailed] = useState(false);

  const mediaHintText = `${item.mediaUrl || ''} ${item.nasPath || ''} ${item.uploadedFileName || ''}`;
  const isImageByExtOrMime = Boolean(
    item.uploadedMimeType?.startsWith('image/') ||
      /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|svg|tiff|tif)(\?|$)/i.test(mediaHintText)
  );
  const isAudioByExtOrMime = Boolean(
    item.uploadedMimeType?.startsWith('audio/') ||
      /\.(mp3|flac|wav|ogg|oga|opus|m4a|aac|wma|m4b|alac|aiff|aif|mka|amr|mid|midi|ac3|dts|ape|wv)(\?|$)/i.test(
        mediaHintText
      )
  );
  const isVideoByExtOrMime = Boolean(
    item.uploadedMimeType?.startsWith('video/') ||
      /\.(mp4|webm|mov|m4v|mkv|avi|ts|m2ts|mts|mpg|mpeg|wmv|asf|flv|f4v|3gp|3g2|ogv|vob|divx|rmvb|m3u8)(\?|$)/i.test(
        mediaHintText
      )
  );
  const mimeHint =
    item.uploadedMimeType && item.uploadedMimeType !== 'application/octet-stream'
      ? item.uploadedMimeType
      : inferMimeTypeFromPath(item.nasPath || item.uploadedFileName || item.mediaUrl || '');

  const isUploadedVideo = Boolean(
    item.mediaUrl &&
      !realMediaFallback &&
      !isImageByExtOrMime &&
      !isAudioByExtOrMime &&
      item.kind !== 'image' &&
      item.kind !== 'music' &&
      item.kind !== 'other' &&
      (isVideoByExtOrMime ||
        item.kind === 'video' ||
        item.kind === 'movie' ||
        item.kind === 'series')
  );
  const isUploadedAudio = Boolean(
    item.mediaUrl &&
      !realMediaFallback &&
      (isAudioByExtOrMime || item.kind === 'music')
  );
  const isUploadedOtherFile = Boolean(
    item.mediaUrl &&
      item.kind === 'other' &&
      !isImageByExtOrMime &&
      !isVideoByExtOrMime &&
      !isAudioByExtOrMime
  );
  const hasRealTimeMedia = isUploadedVideo || isUploadedAudio;

  // Aktives Bild für Episode, NAS-Bilddatei oder Film bestimmen
  const activeFrameUrl = useMemo(() => {
    if (item.kind === 'image' && item.mediaUrl && !realMediaFallback && !imageProxyFailed) {
      return item.mediaUrl;
    }
    if (item.kind === 'series' && item.currentEpisode && item.episodes?.length) {
      const matchedEp = item.episodes.find(
        (ep) =>
          ep.season === item.currentEpisode?.season &&
          ep.episode === item.currentEpisode?.episode
      );
      if (matchedEp?.screenshotUrl) return matchedEp.screenshotUrl;
    }
    return item.coverUrl;
  }, [imageProxyFailed, item, realMediaFallback]);

  // Automatische Live-Erkennung für TV, Tablet, Handy-App & Desktop
  useEffect(() => {
    const updateDevice = () => {
      setDeviceMode(detectPlayerDeviceMode());
    };
    updateDevice();
    window.addEventListener('resize', updateDevice);
    window.addEventListener('orientationchange', updateDevice);
    document.addEventListener('fullscreenchange', updateDevice);
    return () => {
      window.removeEventListener('resize', updateDevice);
      window.removeEventListener('orientationchange', updateDevice);
      document.removeEventListener('fullscreenchange', updateDevice);
    };
  }, []);

  // Body-Scroll sperren, solange der Player geöffnet ist (damit nichts aus der App durchscheint)
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    return subscribeCastState((next) => {
      setCastSnapshot(next);
    });
  }, []);

  const isCastConnected = castSnapshot.castState === 'CONNECTED';
  const shouldMuteLocalForCast =
    isCastConnected && castSnapshot.mode !== 'remote_playback';
  const lastSmartHomeSeqRef = useRef<number>(smartHomeState?.commandSeq ?? 0);

  useEffect(() => {
    if (activeSheet !== 'cast') {
      castAutoScannedRef.current = false;
      return;
    }
    if (
      !castAutoScannedRef.current &&
      !castSnapshot.scanningDevices &&
      castSnapshot.devices.length === 0
    ) {
      castAutoScannedRef.current = true;
      void discoverChromecastDevices(manualCastHost.trim() || undefined);
    }
  }, [
    activeSheet,
    castSnapshot.scanningDevices,
    castSnapshot.devices.length,
    manualCastHost,
  ]);

  // Auto-Hide Timer für die Enten Player-Steuerung anhand Profil-Einstellung
  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
    if (controlsTimeoutSec > 0 && isPlaying && activeSheet === 'none') {
      hideControlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, Math.max(1, controlsTimeoutSec) * 1000);
    }
  }, [isPlaying, activeSheet, controlsTimeoutSec]);

  useEffect(() => {
    if (controlsTimeoutSec <= 0 || !isPlaying || activeSheet !== 'none') {
      setControlsVisible(true);
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
        hideControlsTimerRef.current = null;
      }
      return;
    }
    wakeControls();
    return () => {
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
        hideControlsTimerRef.current = null;
      }
    };
  }, [isPlaying, activeSheet, controlsTimeoutSec, wakeControls]);

  useEffect(() => {
    if (deviceMode === 'tv' && controlsVisible && activeSheet === 'none') {
      playPauseBtnRef.current?.focus();
    }
  }, [deviceMode, controlsVisible, activeSheet]);

  useEffect(() => {
    return () => {
      if (screenshotNoticeTimerRef.current !== null) {
        window.clearTimeout(screenshotNoticeTimerRef.current);
      }
    };
  }, []);

  // Eingehende Google Home / Amazon Alexa Steuerbefehle direkt im Player spiegeln
  useEffect(() => {
    if (!smartHomeState || smartHomeState.commandSeq === lastSmartHomeSeqRef.current) return;
    lastSmartHomeSeqRef.current = smartHomeState.commandSeq;
    if (smartHomeState.playbackState === 'PLAYING') {
      setIsPlaying(true);
      if (isCastConnected) syncChromecastPlayback('play');
    } else if (
      smartHomeState.playbackState === 'PAUSED' ||
      smartHomeState.playbackState === 'IDLE'
    ) {
      setIsPlaying(false);
      if (isCastConnected) syncChromecastPlayback('pause');
    }
  }, [smartHomeState, isCastConnected]);

  // Wiedergabestatus sauber zurücksetzen, wenn Datei/Folge wechselt
  useEffect(() => {
    const startAt =
      item.watchedMinutes >= item.totalDurationMinutes ? 0 : item.watchedMinutes;
    setIsPlaying(true);
    setCurrentMin(startAt);
    setSimulatedSec(startAt * 60);
    setRealMediaSec(0);
    setRealMediaDurationSec(0);
    setRealMediaFallback(false);
    setMediaBuffering(false);
    setImageProxyFailed(false);
    setSelectedAudio(item.audioTracks[0] ?? 'Standard');
    setSelectedSub('Aus');
    autoFinishedPathRef.current = null;
    setControlsVisible(true);
  }, [item.id, item.nasPath, item.mediaUrl, item.watchedMinutes, item.totalDurationMinutes, item.audioTracks, item.subtitles]);

  const smartVolume = Math.max(0, Math.min(100, smartHomeState?.volume ?? 70));
  const smartMuted = smartHomeState?.muted ?? false;
  const smartPlaybackRate = Math.max(0.5, Math.min(2, smartHomeState?.playbackRate ?? 1));

  // Lautstärke, Stummschaltung und Wiedergabegeschwindigkeit aus smartHomeState anwenden
  useEffect(() => {
    const mediaEl = isUploadedVideo ? videoElRef.current : isUploadedAudio ? audioElRef.current : null;
    if (!mediaEl) return;
    mediaEl.playbackRate = smartPlaybackRate;
    mediaEl.muted = smartMuted || shouldMuteLocalForCast;
    mediaEl.volume = Math.max(0, Math.min(1, smartVolume / 100));
  }, [
    smartPlaybackRate,
    smartMuted,
    shouldMuteLocalForCast,
    smartVolume,
    isUploadedVideo,
    isUploadedAudio,
    item.mediaUrl,
  ]);

  // Play/Pause mit echtem HTML5 Video/Audio synchronisieren
  useEffect(() => {
    const mediaEl = isUploadedVideo ? videoElRef.current : isUploadedAudio ? audioElRef.current : null;
    if (!mediaEl) return;
    if (isPlaying) {
      void mediaEl.play().catch(() => {
        // Autoplay ggf. vom Browser blockiert — Nutzer kann Play drücken
      });
    } else {
      mediaEl.pause();
    }
  }, [isPlaying, isUploadedVideo, isUploadedAudio, item.mediaUrl]);

  // Wenn eine Chromecast-Sitzung aktiv ist, neuen Titel/Folge automatisch auf das Gerät laden
  useEffect(() => {
    if (!isCastConnected) return;
    void loadItemOnChromecast(item, initialStartMin).then((loaded) => {
      if (loaded) {
        setCastMessage(
          `Wird auf ${castSnapshot.deviceName ?? 'Chromecast'} wiedergegeben.`
        );
      }
    });
  }, [isCastConnected, item.id, item.nasPath, initialStartMin, castSnapshot.deviceName]);

  const quickAddMedia = useMemo(
    () => libraryItems.find((m) => m.id === quickAddMediaId) ?? libraryItems[0] ?? null,
    [libraryItems, quickAddMediaId]
  );

  useEffect(() => {
    if (!quickAddMediaId && libraryItems[0]) {
      setQuickAddMediaId(libraryItems[0].id);
    }
  }, [libraryItems, quickAddMediaId]);

  useEffect(() => {
    if (quickAddMedia?.kind === 'series' && quickAddMedia.episodes?.length) {
      const firstEp = quickAddMedia.episodes[0];
      setQuickAddEpisodeKey(`${firstEp.season}-${firstEp.episode}`);
    } else {
      setQuickAddEpisodeKey('');
    }
  }, [quickAddMedia]);

  const totalSimulatedSec = Math.max(60, item.totalDurationMinutes * 60);

  // Fortschrittstimer während Wiedergabe (nur für Katalog-Einträge ohne direkte HTML5-Zeitachse)
  useEffect(() => {
    if (!isPlaying || hasRealTimeMedia) return;
    const intervalMs = Math.max(400, Math.round(1000 / Math.max(0.5, smartPlaybackRate)));
    const timer = window.setInterval(() => {
      setSimulatedSec((prev) => {
        if (prev >= totalSimulatedSec) return totalSimulatedSec;
        const next = Math.min(totalSimulatedSec, prev + 1);
        setCurrentMin(Math.floor(next / 60));
        return next;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, hasRealTimeMedia, totalSimulatedSec, smartPlaybackRate]);

  // Bei Ende der Datei: Warteschlange fortsetzen oder automatisch zurück zur Startseite
  useEffect(() => {
    if (hasRealTimeMedia || !isPlaying || simulatedSec < totalSimulatedSec) {
      return;
    }
    if (autoFinishedPathRef.current === item.nasPath) return;
    autoFinishedPathRef.current = item.nasPath;

    const finishTimer = window.setTimeout(async () => {
      setSyncing(true);
      try {
        await onSyncProgress(
          item.id,
          item.totalDurationMinutes,
          item.kind === 'series'
        );
      } finally {
        setSyncing(false);
        if (autoPlayNext && queue.length > 0) {
          onPlayNext();
        } else {
          onPlaybackEnded();
        }
      }
    }, 700);

    return () => window.clearTimeout(finishTimer);
  }, [
    hasRealTimeMedia,
    isPlaying,
    autoPlayNext,
    queue.length,
    simulatedSec,
    totalSimulatedSec,
    item.totalDurationMinutes,
    item.id,
    item.kind,
    item.nasPath,
    onSyncProgress,
    onPlayNext,
    onPlaybackEnded,
  ]);

  const handleSaveProgress = useCallback(
    async (nextMinutes: number, nextEpisode = false) => {
      const clamped = Math.max(0, Math.min(item.totalDurationMinutes, nextMinutes));
      if (isCastConnected && !nextEpisode) {
        syncChromecastPlayback('seek', clamped);
      }
      setSyncing(true);
      try {
        await onSyncProgress(item.id, clamped, nextEpisode);
        setCurrentMin(clamped);
        if (nextEpisode) {
          if (autoPlayNext && queue.length > 0) {
            onPlayNext();
          } else {
            onPlaybackEnded();
          }
        }
      } finally {
        setSyncing(false);
      }
    },
    [
      item.id,
      item.totalDurationMinutes,
      isCastConnected,
      onSyncProgress,
      autoPlayNext,
      queue.length,
      onPlayNext,
      onPlaybackEnded,
    ]
  );

  const handleTogglePlayPause = useCallback(() => {
    setIsPlaying((prev) => {
      const next = !prev;
      if (isCastConnected) {
        syncChromecastPlayback(next ? 'play' : 'pause');
      }
      return next;
    });
    wakeControls();
  }, [isCastConnected, wakeControls]);

  const handleSeekRelative = useCallback(
    (deltaSeconds: number) => {
      if (hasRealTimeMedia) {
        const mediaEl = isUploadedVideo ? videoElRef.current : audioElRef.current;
        const maxSec = realMediaDurationSec > 0 ? realMediaDurationSec : totalSimulatedSec;
        const baseSec = mediaEl ? mediaEl.currentTime : realMediaSec;
        const nextSec = Math.max(0, Math.min(maxSec, Math.round(baseSec + deltaSeconds)));
        if (mediaEl) {
          mediaEl.currentTime = nextSec;
        }
        setRealMediaSec(nextSec);
        setCurrentMin(Math.floor(nextSec / 60));
        if (isCastConnected) {
          syncChromecastPlayback('seek', nextSec, true);
        }
        void handleSaveProgress(Math.floor(nextSec / 60));
      } else {
        const nextSec = Math.max(0, Math.min(totalSimulatedSec, simulatedSec + deltaSeconds));
        setSimulatedSec(nextSec);
        const nextMin = Math.floor(nextSec / 60);
        setCurrentMin(nextMin);
        if (isCastConnected) {
          syncChromecastPlayback('seek', nextSec, true);
        }
        void handleSaveProgress(nextMin);
      }
      wakeControls();
    },
    [
      hasRealTimeMedia,
      isUploadedVideo,
      realMediaDurationSec,
      totalSimulatedSec,
      realMediaSec,
      simulatedSec,
      handleSaveProgress,
      wakeControls,
    ]
  );

  // Lokaler Screenshot: reines Videobild ohne Player-UI auf dem Gerät speichern
  const handleTakeScreenshot = useCallback(async () => {
    if (screenshotBusy) return;
    setScreenshotBusy(true);
    setScreenshotError(null);
    setScreenshotNotice(null);
    setShutterFlash(true);
    window.setTimeout(() => setShutterFlash(false), 180);

    try {
      const canvas = document.createElement('canvas');
      const targetWidth = 1920;
      const targetHeight = 1080;
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas-Kontext für Screenshot nicht verfügbar.');
      }

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, targetWidth, targetHeight);

      const loadImageForCanvas = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Bildquelle konnte nicht geladen werden.'));
          img.src = src;
        });

      let drawn = false;
      const activeVideo = isUploadedVideo ? videoElRef.current : null;
      if (activeVideo && activeVideo.videoWidth > 0 && activeVideo.videoHeight > 0) {
        const srcW = activeVideo.videoWidth;
        const srcH = activeVideo.videoHeight;
        const scale = Math.min(targetWidth / srcW, targetHeight / srcH);
        const drawW = srcW * scale;
        const drawH = srcH * scale;
        ctx.drawImage(
          activeVideo,
          (targetWidth - drawW) / 2,
          (targetHeight - drawH) / 2,
          drawW,
          drawH
        );
        drawn = true;
      }

      if (!drawn) {
        try {
          const loadedImg = await loadImageForCanvas(activeFrameUrl);
          const srcW = loadedImg.naturalWidth || targetWidth;
          const srcH = loadedImg.naturalHeight || targetHeight;
          // Original-Seitenverhältnis sauber einpassen ohne UI-Elemente
          const scale = Math.min(targetWidth / srcW, targetHeight / srcH);
          const drawW = srcW * scale;
          const drawH = srcH * scale;
          const dx = (targetWidth - drawW) / 2;
          const dy = (targetHeight - drawH) / 2;
          ctx.drawImage(loadedImg, dx, dy, drawW, drawH);
          drawn = true;
        } catch {
          // Fallback falls vorhandenes <img>-Element geladen ist
          const existingImg = mediaImgRef.current;
          if (existingImg && existingImg.complete && existingImg.naturalWidth > 0) {
            const srcW = existingImg.naturalWidth;
            const srcH = existingImg.naturalHeight;
            const scale = Math.min(targetWidth / srcW, targetHeight / srcH);
            const drawW = srcW * scale;
            const drawH = srcH * scale;
            ctx.drawImage(
              existingImg,
              (targetWidth - drawW) / 2,
              (targetHeight - drawH) / 2,
              drawW,
              drawH
            );
            drawn = true;
          }
        }
      }

      if (!drawn) {
        throw new Error('Aktuelles Bild konnte nicht für den Screenshot erfasst werden.');
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((result) => resolve(result), 'image/png')
      );
      if (!blob) {
        throw new Error('PNG-Datei konnte nicht erstellt werden.');
      }

      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9äöüß]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
      const epTag = item.currentEpisode
        ? `_s${String(item.currentEpisode.season).padStart(2, '0')}e${String(
            item.currentEpisode.episode
          ).padStart(2, '0')}`
        : '';
      const timeTag = item.kind === 'image' ? '' : `_${currentMin}min`;
      const filename = `entencenter_${slug || 'screenshot'}${epTag}${timeTag}.png`;

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

      setScreenshotNotice(`Lokal gespeichert: ${filename}`);
      if (screenshotNoticeTimerRef.current !== null) {
        window.clearTimeout(screenshotNoticeTimerRef.current);
      }
      screenshotNoticeTimerRef.current = window.setTimeout(() => {
        setScreenshotNotice(null);
      }, 3200);
      wakeControls();
    } catch (err) {
      setScreenshotError(
        err instanceof Error
          ? err.message
          : 'Screenshot konnte nicht lokal gespeichert werden.'
      );
      wakeControls();
    } finally {
      setScreenshotBusy(false);
    }
  }, [screenshotBusy, activeFrameUrl, item, currentMin, wakeControls]);

  // Tastatur- und TV-Fernbedienungs-Steuerung (D-Pad / Enter / Space / Zurück)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (targetTag === 'select' || targetTag === 'input') {
        if (e.key === 'Escape') {
          setActiveSheet('none');
        }
        return;
      }

      wakeControls();

      if (e.key === 'Escape' || (deviceMode === 'tv' && e.key === 'Backspace')) {
        e.preventDefault();
        if (activeSheet !== 'none') {
          setActiveSheet('none');
        } else {
          onClose();
        }
        return;
      }

      if (e.key === ' ' || e.key === 'MediaPlayPause') {
        e.preventDefault();
        handleTogglePlayPause();
        return;
      }

      if (e.key === 'ArrowRight' && item.kind !== 'image') {
        e.preventDefault();
        handleSeekRelative(seekForwardSec);
        return;
      }

      if (e.key === 'ArrowLeft' && item.kind !== 'image') {
        e.preventDefault();
        handleSeekRelative(-seekBackwardSec);
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        void handleTakeScreenshot();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    deviceMode,
    activeSheet,
    item.kind,
    seekForwardSec,
    seekBackwardSec,
    wakeControls,
    onClose,
    handleTogglePlayPause,
    handleSeekRelative,
    handleTakeScreenshot,
  ]);

  const getActiveMediaElement = (): HTMLMediaElement | null =>
    isUploadedVideo ? videoElRef.current : isUploadedAudio ? audioElRef.current : null;

  const getCurrentCastPositionMinutes = (): number =>
    hasRealTimeMedia ? realMediaSec / 60 : simulatedSec / 60;

  const handleDiscoverChromecast = async (overrideHost?: string) => {
    setCastBusy(true);
    setCastMessage(null);
    try {
      const targetHost = (overrideHost ?? manualCastHost).trim();
      const devices = await discoverChromecastDevices(targetHost || undefined);
      setCastSnapshot(readCastSnapshot());
      if (devices.length === 0) {
        setCastMessage(
          'Kein Chromecast- oder Google-TV-Gerät automatisch im WLAN gefunden. Gib unten einfach die IP-Adresse deines Fernsehers oder Chromecast ein.'
        );
      }
    } finally {
      setCastBusy(false);
    }
  };

  const handleSelectCastDevice = async (device: DiscoveredCastDevice) => {
    setCastBusy(true);
    setCastMessage(null);
    try {
      const result = await connectChromecastDevice(
        device,
        item,
        getCurrentCastPositionMinutes()
      );
      setCastMessage(result.message);
      setCastSnapshot(readCastSnapshot());
    } finally {
      setCastBusy(false);
    }
  };

  const handleConnectManualCastHost = async () => {
    const cleanHost = manualCastHost.trim();
    if (!cleanHost) {
      setCastMessage('Bitte gib zuerst eine lokale IP-Adresse (z. B. 192.168.178.42) ein.');
      return;
    }
    saveManualChromecastHost(cleanHost);
    setCastBusy(true);
    setCastMessage(null);
    try {
      const devices = await discoverChromecastDevices(cleanHost);
      const matched = devices.find((d) => d.host === cleanHost);
      const targetDevice: DiscoveredCastDevice = matched ?? {
        id: `cast-${cleanHost}-8009`,
        name: `Chromecast (${cleanHost})`,
        model: 'Manuelle IP',
        host: cleanHost,
        port: 8009,
        source: 'manual',
      };
      const result = await connectChromecastDevice(
        targetDevice,
        item,
        getCurrentCastPositionMinutes()
      );
      setCastMessage(result.message);
      setCastSnapshot(readCastSnapshot());
    } finally {
      setCastBusy(false);
    }
  };

  const handleConnectChromecast = async () => {
    setCastBusy(true);
    setCastMessage(null);
    try {
      const result = await requestChromecastSession(item, getCurrentCastPositionMinutes(), {
        mediaElement: getActiveMediaElement(),
        manualHost: manualCastHost.trim() || undefined,
      });
      setCastMessage(result.message);
      setCastSnapshot(readCastSnapshot());
    } finally {
      setCastBusy(false);
    }
  };

  const handleResendToChromecast = async () => {
    setCastBusy(true);
    try {
      const loaded = await loadItemOnChromecast(item, getCurrentCastPositionMinutes());
      setCastMessage(
        loaded
          ? `Titel erneut an ${castSnapshot.deviceName ?? 'Chromecast'} gesendet.`
          : 'Titel konnte nicht an Chromecast gesendet werden.'
      );
    } finally {
      setCastBusy(false);
    }
  };

  const handleDisconnectChromecast = () => {
    disconnectChromecast();
    setCastSnapshot(readCastSnapshot());
    setCastMessage('Chromecast-Verbindung getrennt.');
  };

  const handleAdvanceToNext = async () => {
    if (queue.length === 0 || syncing) return;
    setSyncing(true);
    try {
      await onSyncProgress(item.id, currentMin, false);
    } finally {
      setSyncing(false);
      onPlayNext();
    }
  };

  const handleQuickAdd = () => {
    if (!quickAddMedia) return;
    if (quickAddMedia.kind === 'series' && quickAddMedia.episodes?.length) {
      const [sStr, eStr] = quickAddEpisodeKey.split('-');
      const ep =
        quickAddMedia.episodes.find(
          (candidate) =>
            candidate.season === Number(sStr) && candidate.episode === Number(eStr)
        ) ?? quickAddMedia.episodes[0];
      onAddToQueue(quickAddMedia, ep);
    } else {
      onAddToQueue(quickAddMedia);
    }
    setActiveSheet('queue');
  };

  const isTv = deviceMode === 'tv';
  const isMobile = deviceMode === 'mobile';
  const isTablet = deviceMode === 'tablet';
  const isTouchDevice = isMobile || isTablet;

  const DeviceIcon =
    deviceMode === 'tv'
      ? Tv
      : deviceMode === 'tablet'
        ? Tablet
        : deviceMode === 'mobile'
          ? Smartphone
          : Monitor;

  const handleStageTap = () => {
    if (activeSheet !== 'none') {
      setActiveSheet('none');
      return;
    }
    if (isTouchDevice) {
      if (controlsVisible) {
        if (hideControlsTimerRef.current !== null) {
          window.clearTimeout(hideControlsTimerRef.current);
          hideControlsTimerRef.current = null;
        }
        setControlsVisible(false);
      } else {
        wakeControls();
      }
    } else {
      wakeControls();
    }
  };

  const btnMinTouch = isTv
    ? 'min-h-[52px] min-w-[52px]'
    : isTouchDevice
      ? 'min-h-[44px] min-w-[44px]'
      : 'min-h-[40px] min-w-[40px]';

  const focusRingClass = isTv
    ? 'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-400'
    : 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400';

  const totalActiveSec =
    hasRealTimeMedia && realMediaDurationSec > 0 ? realMediaDurationSec : totalSimulatedSec;
  const elapsedActiveSec =
    hasRealTimeMedia && realMediaDurationSec > 0 ? realMediaSec : simulatedSec;
  const remainingRealSec =
    item.kind === 'image'
      ? null
      : Math.max(0, totalActiveSec - elapsedActiveSec) / Math.max(0.5, smartPlaybackRate);

  const endTimePreview =
    remainingRealSec !== null
      ? (() => {
          const endAt = new Date(Date.now() + remainingRealSec * 1000);
          return `${String(endAt.getHours()).padStart(2, '0')}:${String(
            endAt.getMinutes()
          ).padStart(2, '0')}`;
        })()
      : null;

  const progressPct = Math.min(
    100,
    Math.round((elapsedActiveSec / Math.max(1, totalActiveSec)) * 100)
  );

  return (
    <div
      data-preserve-dark="true"
      className="fixed inset-0 z-[100] bg-black text-white flex flex-col overflow-hidden select-none"
      role="dialog"
      aria-modal="true"
      aria-label={`Enten Player für ${item.title}`}
      onMouseMove={() => {
        if (!isTouchDevice) wakeControls();
      }}
    >
      {/* Vollbild-Medienfläche ohne störende App-Anzeigen oder Werbung */}
      <div
        className="relative flex-1 w-full h-full bg-black flex items-center justify-center overflow-hidden"
        onClick={handleStageTap}
      >
        {isUploadedVideo && item.mediaUrl ? (
          <video
            key={item.mediaUrl}
            ref={videoElRef}
            src={item.mediaUrl}
            poster={item.coverUrl}
            playsInline
            preload="metadata"
            onLoadStart={() => setMediaBuffering(true)}
            onWaiting={() => setMediaBuffering(true)}
            onCanPlay={() => setMediaBuffering(false)}
            onPlaying={() => setMediaBuffering(false)}
            onLoadedMetadata={(e) => {
              setMediaBuffering(false);
              const dur = e.currentTarget.duration;
              if (Number.isFinite(dur) && dur > 0) {
                setRealMediaDurationSec(Math.round(dur));
              }
              e.currentTarget.playbackRate = smartPlaybackRate;
              e.currentTarget.muted = smartMuted || shouldMuteLocalForCast;
              e.currentTarget.volume = Math.max(0, Math.min(1, smartVolume / 100));
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              if (Number.isFinite(t)) {
                setRealMediaSec(Math.floor(t));
                setCurrentMin(Math.floor(t / 60));
              }
            }}
            onEnded={() => {
              setIsPlaying(false);
              void handleSaveProgress(item.totalDurationMinutes, item.kind === 'series');
              if (autoPlayNext && queue.length > 0) {
                onPlayNext();
              } else {
                onPlaybackEnded();
              }
            }}
            onError={() => {
              setMediaBuffering(false);
              setRealMediaFallback(true);
            }}
            className="w-full h-full object-contain"
          />
        ) : isUploadedAudio && item.mediaUrl ? (
          <div className="relative w-full h-full flex items-center justify-center p-6">
            <img
              ref={mediaImgRef}
              src={activeFrameUrl}
              alt={item.title}
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover opacity-25 blur-2xl scale-110 pointer-events-none"
            />
            <div
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 w-full max-w-md rounded-2xl bg-[#121722]/90 backdrop-blur-md border border-slate-700/80 p-6 shadow-2xl flex flex-col items-center text-center gap-4"
            >
              <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-2xl overflow-hidden border border-slate-700/80 shadow-xl bg-slate-900">
                <img
                  src={activeFrameUrl}
                  alt={item.title}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="space-y-1 max-w-full">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-400/15 border border-amber-400/35 text-[11px] font-mono text-amber-300">
                  <Music className="w-3.5 h-3.5" />
                  <span>{item.fileFormat || mimeHint.replace('audio/', '').toUpperCase()} · NAS-Audio</span>
                </div>
                <h4 className="font-display text-lg font-bold text-white truncate px-2">
                  {item.title}
                </h4>
                <p className="text-xs text-slate-300 truncate">
                  {item.director || item.genre}
                  {item.studio ? ` · ${item.studio}` : ''}
                  {item.fileSize ? ` · ${item.fileSize}` : ''}
                </p>
              </div>
              <div className="flex items-end justify-center gap-1 h-5" aria-hidden="true">
                {[0.55, 0.9, 0.45, 1, 0.7, 0.85, 0.4, 0.75].map((bar, idx) => (
                  <span
                    key={idx}
                    style={{ height: isPlaying ? `${Math.round(bar * 100)}%` : '22%' }}
                    className={`w-1.5 rounded-full bg-amber-400 transition-all duration-300 ${
                      isPlaying ? 'animate-pulse' : 'opacity-45'
                    }`}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => openNativeExternalPlayer(item.mediaUrl!, mimeHint, item.title)}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                <span>In externem Player (z. B. VLC) öffnen</span>
              </button>
            </div>
          </div>
        ) : (
          <img
            ref={mediaImgRef}
            src={activeFrameUrl}
            alt={item.title}
            referrerPolicy="no-referrer"
            onError={() => {
              if (item.kind === 'image' && item.mediaUrl && !imageProxyFailed) {
                setImageProxyFailed(true);
              }
            }}
            className={`w-full h-full object-contain transition-opacity duration-300 ${
              isPlaying ? 'opacity-100' : 'opacity-80'
            }`}
          />
        )}

        {(isUploadedVideo || isUploadedAudio) && mediaBuffering && !realMediaFallback && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 px-3.5 py-1.5 rounded-xl bg-black/80 border border-amber-400/40 text-xs text-amber-200 pointer-events-none">
            NAS-Stream wird gepuffert…
          </div>
        )}

        {item.mediaUrl && realMediaFallback && !isUploadedOtherFile && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-32 inset-x-4 max-w-lg mx-auto z-20 p-4 rounded-2xl bg-[#121722]/95 border border-amber-400/50 shadow-2xl text-center space-y-3"
          >
            <p className="text-xs text-slate-200 leading-relaxed">
              Dieses Dateiformat ({item.fileFormat || mimeHint || 'NAS-Medium'}) nutzt einen Codec
              oder Container (z. B. MKV/AVI/DTS/AC3/FLAC/OGG), den der integrierte Browser-Decoder
              nicht direkt abspielt. Starte den Stream direkt in einem nativen Player (z. B. VLC /
              MX Player) oder lade die Datei herunter.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => openNativeExternalPlayer(item.mediaUrl!, mimeHint, item.title)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>In externem Player (z. B. VLC / MX) öffnen</span>
              </button>
              <a
                href={`${item.mediaUrl}${item.mediaUrl.includes('?') ? '&' : '?'}download=1`}
                download={item.uploadedFileName || undefined}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold transition-colors"
              >
                <Download className="w-4 h-4 text-amber-400" />
                <span>Herunterladen</span>
              </a>
            </div>
          </div>
        )}

        {isUploadedAudio && item.mediaUrl && (
          <audio
            key={item.mediaUrl}
            ref={audioElRef}
            src={item.mediaUrl}
            preload="metadata"
            onLoadStart={() => setMediaBuffering(true)}
            onWaiting={() => setMediaBuffering(true)}
            onCanPlay={() => setMediaBuffering(false)}
            onPlaying={() => setMediaBuffering(false)}
            onLoadedMetadata={(e) => {
              setMediaBuffering(false);
              const dur = e.currentTarget.duration;
              if (Number.isFinite(dur) && dur > 0) {
                setRealMediaDurationSec(Math.round(dur));
              }
              e.currentTarget.playbackRate = smartPlaybackRate;
              e.currentTarget.muted = smartMuted || shouldMuteLocalForCast;
              e.currentTarget.volume = Math.max(0, Math.min(1, smartVolume / 100));
            }}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              if (Number.isFinite(t)) {
                setRealMediaSec(Math.floor(t));
                setCurrentMin(Math.floor(t / 60));
              }
            }}
            onEnded={() => {
              setIsPlaying(false);
              if (autoPlayNext && queue.length > 0) {
                onPlayNext();
              } else {
                onPlaybackEnded();
              }
            }}
            onError={() => {
              setMediaBuffering(false);
              setRealMediaFallback(true);
            }}
          />
        )}

        {isUploadedOtherFile && item.mediaUrl && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-4 max-w-lg mx-auto p-6 rounded-2xl bg-[#121722]/95 border border-slate-700/90 shadow-2xl text-center space-y-4 z-10"
          >
            <div className="w-12 h-12 rounded-2xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center mx-auto">
              <FileText className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h4 className="font-display text-base font-semibold text-white">{item.title}</h4>
              <p className="text-xs text-slate-400 font-mono truncate">
                {item.nasPath} {item.fileSize ? `· ${item.fileSize}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => openNativeExternalPlayer(item.mediaUrl!, mimeHint, item.title)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>In externer App öffnen</span>
              </button>
              <a
                href={`${item.mediaUrl}${item.mediaUrl.includes('?') ? '&' : '?'}download=1`}
                download={item.uploadedFileName || undefined}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold transition-colors"
              >
                <Download className="w-4 h-4 text-amber-400" />
                <span>Datei herunterladen</span>
              </a>
            </div>
          </div>
        )}

        {/* Kurzer Kamera-Blitz beim lokalen Screenshot */}
        <div
          aria-hidden="true"
          className={`absolute inset-0 bg-white pointer-events-none transition-opacity duration-150 ${
            shutterFlash ? 'opacity-65' : 'opacity-0'
          }`}
        />

        {/* Dezente Kontrast-Scrims nur wenn Steuerung eingeblendet ist */}
        <div
          aria-hidden="true"
          className={`absolute inset-0 pointer-events-none transition-opacity duration-200 ${
            controlsVisible ? 'opacity-100' : 'opacity-0'
          } bg-gradient-to-b from-black/75 via-transparent to-black/85`}
        />

        {/* Untertitel im Bild (nur wenn explizit aktiviert) */}
        {selectedSub !== 'Aus' && (
          <div
            className={`absolute inset-x-0 flex justify-center px-4 sm:px-8 pointer-events-none transition-all duration-200 ${
              controlsVisible ? (isMobile ? 'bottom-44' : 'bottom-36') : 'bottom-8 sm:bottom-12'
            }`}
          >
            <div
              className={`px-4 py-1.5 bg-black/80 rounded-md text-white text-center max-w-3xl ${
                isTv ? 'text-xl sm:text-2xl' : isMobile ? 'text-xs' : 'text-sm sm:text-base'
              }`}
            >
              {isPlaying
                ? `[${selectedSub}] Direkte NAS-Wiedergabe · ${item.title}`
                : `[${selectedSub}] Pausiert`}
            </div>
          </div>
        )}

        {/* Obere Player-Leiste (blendet bei Wiedergabe automatisch aus) */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute top-0 inset-x-0 z-20 transition-all duration-200 ${
            controlsVisible
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 -translate-y-3 pointer-events-none'
          } ${
            isTv
              ? 'px-10 pt-8 pb-6'
              : isMobile
                ? 'px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3'
                : 'px-5 sm:px-7 pt-5 pb-4'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-slate-300 text-xs mb-0.5">
                <DeviceIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="font-semibold text-amber-300 shrink-0">Enten Player</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{DEVICE_LABELS[deviceMode]}</span>
                {item.currentEpisode && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate tabular-nums">
                      S{String(item.currentEpisode.season).padStart(2, '0')}E
                      {String(item.currentEpisode.episode).padStart(2, '0')}
                    </span>
                  </>
                )}
              </div>
              <h3
                className={`font-display font-bold text-white truncate ${
                  isTv ? 'text-2xl lg:text-3xl' : isMobile ? 'text-base' : 'text-lg sm:text-xl'
                }`}
              >
                {item.title}
              </h3>
              {item.currentEpisode && !isMobile && (
                <p className={`text-slate-300 truncate ${isTv ? 'text-base mt-1' : 'text-xs mt-0.5'}`}>
                  Staffel {item.currentEpisode.season} · Folge {item.currentEpisode.episode} —{' '}
                  {item.currentEpisode.title}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <LiveClockBadge
                variant="player"
                sizeMode={isTv ? 'tv' : isMobile ? 'mobile' : 'default'}
                remainingSeconds={remainingRealSec}
              />

              <button
                type="button"
                disabled={screenshotBusy}
                onClick={() => void handleTakeScreenshot()}
                title="Screenshot lokal auf diesem Gerät speichern"
                aria-label="Screenshot lokal speichern"
                className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl bg-black/70 hover:bg-slate-900 border border-slate-700/90 text-slate-100 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap`}
              >
                <Camera className={`${isTv ? 'w-5 h-5' : 'w-4 h-4'} text-amber-400`} />
                <span className={isMobile ? 'sr-only' : 'inline'}>Screenshot</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const nextOpen = activeSheet !== 'cast';
                  setActiveSheet(nextOpen ? 'cast' : 'none');
                  if (nextOpen && !isCastConnected) {
                    setCastMessage(null);
                    if (
                      castSnapshot.mode === 'google_cast_sdk' &&
                      !castSnapshot.isEmbeddedFrame
                    ) {
                      void handleConnectChromecast();
                    }
                  }
                }}
                aria-expanded={activeSheet === 'cast'}
                aria-label="Chromecast-Übertragung"
                className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                  isCastConnected
                    ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                    : activeSheet === 'cast'
                      ? 'bg-slate-900 border-amber-400/70 text-amber-300'
                      : 'bg-black/70 hover:bg-slate-900 border-slate-700/90 text-slate-100'
                }`}
              >
                <Cast className={isTv ? 'w-5 h-5' : 'w-4 h-4'} />
                <span className={isMobile ? 'sr-only' : 'hidden sm:inline'}>
                  {isCastConnected ? castSnapshot.deviceName || 'Cast aktiv' : 'Chromecast'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveSheet((prev) => (prev === 'queue' ? 'none' : 'queue'))}
                aria-expanded={activeSheet === 'queue'}
                aria-label={`Warteschlange (${queue.length})`}
                className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                  activeSheet === 'queue'
                    ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                    : 'bg-black/70 hover:bg-slate-900 border-slate-700/90 text-slate-100'
                }`}
              >
                <ListVideo className={isTv ? 'w-5 h-5' : 'w-4 h-4'} />
                <span className="tabular-nums">
                  {isMobile ? queue.length : `Warteschlange (${queue.length})`}
                </span>
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Player schließen"
                className={`${btnMinTouch} ${focusRingClass} px-2.5 py-2 rounded-xl bg-black/70 hover:bg-slate-900 text-slate-100 border border-slate-700/90 flex items-center justify-center transition-colors`}
              >
                <X className={isTv ? 'w-6 h-6' : 'w-5 h-5'} />
              </button>
            </div>
          </div>

          {/* Lokale Screenshot-Rückmeldung, Chromecast- oder Smart-Home-Hinweis nur im HUD */}
          {(screenshotNotice ||
            screenshotError ||
            isCastConnected ||
            smartPlaybackRate !== 1 ||
            smartMuted ||
            smartVolume !== 70) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {screenshotNotice && (
                <div
                  role="status"
                  className="px-3 py-1.5 rounded-lg bg-emerald-950/90 border border-emerald-700/70 text-xs text-emerald-200 flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{screenshotNotice}</span>
                </div>
              )}
              {screenshotError && (
                <div
                  role="alert"
                  className="px-3 py-1.5 rounded-lg bg-rose-950/90 border border-rose-700/70 text-xs text-rose-200 flex items-center gap-1.5"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  <span className="truncate">{screenshotError}</span>
                </div>
              )}
              {isCastConnected && (
                <div className="px-3 py-1.5 rounded-lg bg-black/80 border border-amber-400/50 text-xs text-amber-200 flex items-center gap-1.5">
                  <Tv className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate">
                    Cast aktiv: {castSnapshot.deviceName ?? 'Chromecast-Empfänger'}
                  </span>
                </div>
              )}
              {smartPlaybackRate !== 1 && (
                <div className="px-3 py-1.5 rounded-lg bg-black/80 border border-slate-700/90 text-xs text-slate-200 flex items-center gap-1.5 font-mono tabular-nums">
                  <Gauge className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Tempo {Number.isInteger(smartPlaybackRate) ? `${smartPlaybackRate}.0` : smartPlaybackRate}x</span>
                </div>
              )}
              {(smartMuted || smartVolume !== 70) && (
                <div className="px-3 py-1.5 rounded-lg bg-black/80 border border-slate-700/90 text-xs text-slate-200 flex items-center gap-1.5 font-mono tabular-nums">
                  {smartMuted ? (
                    <>
                      <VolumeX className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span>Stumm</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span>Lautstärke {smartVolume}%</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Untere Player-Steuerung (blendet bei Wiedergabe automatisch aus) */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute bottom-0 inset-x-0 z-20 transition-all duration-200 ${
            controlsVisible
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-3 pointer-events-none'
          } ${
            isTv
              ? 'px-10 pb-8 pt-6 space-y-4'
              : isMobile
                ? 'px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 space-y-3'
                : 'px-5 sm:px-7 pb-5 pt-4 space-y-3'
          }`}
        >
          {/* Scrubber / Fortschritt */}
          <div className="space-y-1.5">
            {hasRealTimeMedia && realMediaDurationSec > 0 ? (
              <>
                <input
                  type="range"
                  min={0}
                  max={realMediaDurationSec}
                  value={Math.min(realMediaSec, realMediaDurationSec)}
                  onChange={(e) => {
                    const nextSec = Number(e.target.value);
                    setRealMediaSec(nextSec);
                    setCurrentMin(Math.floor(nextSec / 60));
                    const mediaEl = isUploadedVideo ? videoElRef.current : audioElRef.current;
                    if (mediaEl) mediaEl.currentTime = nextSec;
                    wakeControls();
                  }}
                  onMouseUp={() => {
                    if (isCastConnected) syncChromecastPlayback('seek', realMediaSec, true);
                    void handleSaveProgress(Math.floor(realMediaSec / 60));
                  }}
                  onTouchEnd={() => {
                    if (isCastConnected) syncChromecastPlayback('seek', realMediaSec, true);
                    void handleSaveProgress(Math.floor(realMediaSec / 60));
                  }}
                  className={`w-full accent-amber-400 cursor-pointer ${isTv ? 'h-2.5' : 'h-1.5'}`}
                  aria-label="Wiedergabeposition"
                />
                <div
                  className={`flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums text-slate-300 ${
                    isTv ? 'text-sm' : 'text-xs'
                  }`}
                >
                  <span>
                    {formatDurationClock(realMediaSec)} /{' '}
                    {formatDurationClock(realMediaDurationSec)} (
                    {Math.min(100, Math.round((realMediaSec / Math.max(1, realMediaDurationSec)) * 100))}
                    %)
                  </span>
                  <div className="flex items-center gap-3">
                    {endTimePreview && (
                      <span className="text-amber-300 font-semibold">
                        Läuft bis {endTimePreview} Uhr
                      </span>
                    )}
                    {syncing && <span className="text-amber-300">Synchronisiere…</span>}
                  </div>
                </div>
              </>
            ) : (
              <>
                <input
                  type="range"
                  min={0}
                  max={totalSimulatedSec}
                  value={Math.min(simulatedSec, totalSimulatedSec)}
                  onChange={(e) => {
                    const nextSec = Number(e.target.value);
                    setSimulatedSec(nextSec);
                    setCurrentMin(Math.floor(nextSec / 60));
                    wakeControls();
                  }}
                  onMouseUp={() => {
                    if (isCastConnected) syncChromecastPlayback('seek', simulatedSec, true);
                    void handleSaveProgress(Math.floor(simulatedSec / 60));
                  }}
                  onTouchEnd={() => {
                    if (isCastConnected) syncChromecastPlayback('seek', simulatedSec, true);
                    void handleSaveProgress(Math.floor(simulatedSec / 60));
                  }}
                  className={`w-full accent-amber-400 cursor-pointer ${isTv ? 'h-2.5' : 'h-1.5'}`}
                  aria-label="Wiedergabeposition"
                />
                <div
                  className={`flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums text-slate-300 ${
                    isTv ? 'text-sm' : 'text-xs'
                  }`}
                >
                  <span>
                    {formatDurationClock(simulatedSec)} / {formatDurationClock(totalSimulatedSec)} (
                    {progressPct}%)
                  </span>
                  <div className="flex items-center gap-3">
                    {endTimePreview && (
                      <span className="text-amber-300 font-semibold">
                        Läuft bis {endTimePreview} Uhr
                      </span>
                    )}
                    {syncing && <span className="text-amber-300">Synchronisiere…</span>}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Steuerungsbuttons nach Geräteklasse */}
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                ref={playPauseBtnRef}
                type="button"
                onClick={handleTogglePlayPause}
                className={`${btnMinTouch} ${focusRingClass} ${
                  isTv ? 'px-6 text-sm' : 'px-4 text-xs'
                } py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap`}
              >
                {isPlaying ? (
                  <Pause className={isTv ? 'w-5 h-5' : 'w-4 h-4'} />
                ) : (
                  <Play className={isTv ? 'w-5 h-5' : 'w-4 h-4'} />
                )}
                <span>
                  {item.kind === 'image'
                    ? isPlaying
                      ? 'Pause'
                      : 'Diashow'
                    : isPlaying
                      ? 'Pause'
                      : 'Abspielen'}
                </span>
              </button>

              {item.kind !== 'image' && (
                <>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => handleSeekRelative(-seekBackwardSec)}
                    aria-label={`${formatSeekAria(seekBackwardSec)} zurück`}
                    title={`${formatSeekAria(seekBackwardSec)} zurückspulen`}
                    className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl bg-black/75 hover:bg-slate-900 text-slate-100 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap`}
                  >
                    <SkipBack className="w-4 h-4" />
                    <span>-{formatSeekBadge(seekBackwardSec)}</span>
                  </button>

                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => handleSeekRelative(seekForwardSec)}
                    aria-label={`${formatSeekAria(seekForwardSec)} vorspulen`}
                    title={`${formatSeekAria(seekForwardSec)} vorspulen`}
                    className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl bg-black/75 hover:bg-slate-900 text-slate-100 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap`}
                  >
                    <SkipForward className="w-4 h-4" />
                    <span>+{formatSeekBadge(seekForwardSec)}</span>
                  </button>
                </>
              )}

              {item.kind === 'series' && !isMobile && (
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleSaveProgress(0, true)}
                  className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl bg-black/75 hover:bg-slate-900 text-amber-300 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Folge abschließen</span>
                </button>
              )}

              {queue.length > 0 && (
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleAdvanceToNext()}
                  className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl bg-black/75 hover:bg-amber-400 text-amber-300 hover:text-slate-950 border border-amber-400/50 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap`}
                >
                  <SkipForward className="w-4 h-4" />
                  <span>{item.kind === 'image' ? 'Nächstes' : 'Nächster'}</span>
                </button>
              )}
            </div>

            {/* Tonspur & Untertitel: Kompakt als Drawer auf Handy/Tablet, direkt im HUD auf TV/Desktop */}
            {item.kind !== 'image' &&
              (isTouchDevice ? (
                <button
                  type="button"
                  onClick={() => setActiveSheet((prev) => (prev === 'tracks' ? 'none' : 'tracks'))}
                  aria-expanded={activeSheet === 'tracks'}
                  className={`${btnMinTouch} ${focusRingClass} px-3 py-2 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    activeSheet === 'tracks'
                      ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                      : 'bg-black/75 hover:bg-slate-900 border-slate-700 text-slate-100'
                  }`}
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  <span>Ton &amp; UT</span>
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2.5 text-xs">
                  <label className="flex items-center gap-1.5 text-slate-200">
                    <Volume2 className="w-4 h-4 text-slate-400" />
                    <select
                      value={selectedAudio}
                      onChange={(e) => setSelectedAudio(e.target.value)}
                      className={`${btnMinTouch} ${focusRingClass} bg-black/80 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-white`}
                    >
                      {item.audioTracks.map((track) => (
                        <option key={track} value={track}>
                          {track}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-1.5 text-slate-200">
                    <Subtitles className="w-4 h-4 text-slate-400" />
                    <select
                      value={selectedSub}
                      onChange={(e) => setSelectedSub(e.target.value)}
                      className={`${btnMinTouch} ${focusRingClass} bg-black/80 border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-white`}
                    >
                      <option value="Aus">Untertitel: Aus</option>
                      {item.subtitles.map((sub) => (
                        <option key={sub} value={sub}>
                          {sub}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
          </div>
        </div>

        {/* Slide-Up Sheet / Drawer für Warteschlange, Chromecast oder Ton/Untertitel */}
        {activeSheet !== 'none' && (
          <div
            onClick={(e) => e.stopPropagation()}
            className={`absolute inset-x-0 bottom-0 z-30 bg-[#0D111A]/95 backdrop-blur-md border-t border-slate-800 shadow-2xl max-h-[75dvh] overflow-y-auto ${
              isTouchDevice ? 'rounded-t-3xl p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]' : 'p-6'
            }`}
          >
            {isTouchDevice && (
              <div className="w-10 h-1.5 bg-slate-700 rounded-full mx-auto mb-3" />
            )}

            <div className="max-w-4xl mx-auto space-y-4">
              {/* Sheet Header */}
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-display text-sm sm:text-base font-semibold text-white">
                  {activeSheet === 'cast'
                    ? 'Google Chromecast / Cast-Gerät'
                    : activeSheet === 'tracks'
                      ? 'Tonspur, Untertitel & Folge'
                      : `Wiedergabe-Warteschlange (${queue.length})`}
                </h4>
                <button
                  type="button"
                  onClick={() => setActiveSheet('none')}
                  aria-label="Menü schließen"
                  className="min-h-[40px] min-w-[40px] px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-slate-200 hover:text-white flex items-center justify-center gap-1"
                >
                  <X className="w-4 h-4" />
                  <span>Schließen</span>
                </button>
              </div>

              {/* Ton & Untertitel Drawer (für Tablet & Handy-App) */}
              {activeSheet === 'tracks' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5 text-xs">
                      <span className="text-slate-300 flex items-center gap-1.5">
                        <Volume2 className="w-4 h-4 text-amber-400" />
                        <span>Tonspur</span>
                      </span>
                      <select
                        value={selectedAudio}
                        onChange={(e) => setSelectedAudio(e.target.value)}
                        className="w-full min-h-[44px] bg-[#121722] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                      >
                        {item.audioTracks.map((track) => (
                          <option key={track} value={track}>
                            {track}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1.5 text-xs">
                      <span className="text-slate-300 flex items-center gap-1.5">
                        <Subtitles className="w-4 h-4 text-amber-400" />
                        <span>Untertitel</span>
                      </span>
                      <select
                        value={selectedSub}
                        onChange={(e) => setSelectedSub(e.target.value)}
                        className="w-full min-h-[44px] bg-[#121722] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
                      >
                        <option value="Aus">Untertitel: Aus</option>
                        {item.subtitles.map((sub) => (
                          <option key={sub} value={sub}>
                            {sub}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {item.kind === 'series' && (
                    <button
                      type="button"
                      disabled={syncing}
                      onClick={() => void handleSaveProgress(0, true)}
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#121722] hover:bg-slate-800 border border-slate-700 text-amber-300 text-xs font-semibold flex items-center justify-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Aktuelle Folge abschließen</span>
                    </button>
                  )}
                </div>
              )}

              {/* Chromecast Sheet */}
              {activeSheet === 'cast' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-300">
                      {isCastConnected
                        ? `Verbunden mit ${castSnapshot.deviceName ?? 'Chromecast-Empfänger'}`
                        : castSnapshot.scanningDevices
                          ? 'Suche Chromecast- und Google-TV-Geräte im WLAN…'
                          : castSnapshot.devices.length > 0
                            ? `${castSnapshot.devices.length} Cast-Gerät${castSnapshot.devices.length === 1 ? '' : 'e'} im WLAN gefunden · Gerät antippen zum Abspielen`
                            : 'Chromecast im WLAN & Browser bereit · Gerät auswählen oder per IP verbinden'}
                    </p>

                    <button
                      type="button"
                      disabled={castBusy || castSnapshot.scanningDevices}
                      onClick={() => void handleDiscoverChromecast()}
                      className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          castSnapshot.scanningDevices ? 'animate-spin' : ''
                        }`}
                      />
                      <span>
                        {castSnapshot.scanningDevices ? 'Suche läuft…' : 'Geräte im WLAN suchen'}
                      </span>
                    </button>
                  </div>

                  <div className="space-y-2">
                    {castSnapshot.scanningDevices && castSnapshot.devices.length === 0 ? (
                      <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 text-xs text-slate-300 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
                        <span>Scanne lokales WLAN nach Chromecast / Google TV (mDNS &amp; SSDP)…</span>
                      </div>
                    ) : castSnapshot.devices.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {castSnapshot.devices.map((dev) => {
                          const isActiveDev =
                            isCastConnected && castSnapshot.activeHost === dev.host;
                          return (
                            <button
                              key={dev.id || dev.host}
                              type="button"
                              disabled={castBusy}
                              onClick={() => void handleSelectCastDevice(dev)}
                              className={`min-h-[52px] px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors ${
                                isActiveDev
                                  ? 'bg-amber-400/15 border-amber-400 text-white'
                                  : 'bg-[#121722] hover:bg-slate-800/90 border-slate-700/80 text-slate-100'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <Tv
                                  className={`w-4 h-4 shrink-0 ${
                                    isActiveDev ? 'text-amber-400' : 'text-slate-400'
                                  }`}
                                />
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold truncate">{dev.name}</p>
                                  <p className="text-[11px] text-slate-400 font-mono truncate">
                                    {dev.model ? `${dev.model} · ` : ''}
                                    {dev.host}:{dev.port}
                                  </p>
                                </div>
                              </div>
                              <span
                                className={`text-[11px] font-semibold px-2 py-0.5 rounded-md shrink-0 ${
                                  isActiveDev
                                    ? 'bg-amber-400 text-slate-950'
                                    : 'bg-slate-800 text-amber-300'
                                }`}
                              >
                                {castBusy && castSnapshot.activeHost === dev.host
                                  ? 'Verbindet…'
                                  : isActiveDev
                                    ? 'Aktiv'
                                    : 'Abspielen'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  {/* Direkte Verbindung per Chromecast / Google-TV IP (funktioniert in jedem Browser) */}
                  <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-[#121722] border border-slate-800/90">
                    <input
                      type="text"
                      value={manualCastHost}
                      onChange={(e) => setManualCastHost(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleConnectManualCastHost();
                        }
                      }}
                      placeholder="Chromecast / TV IP (z. B. 192.168.178.42)"
                      aria-label="Chromecast oder Google TV IP-Adresse"
                      className="flex-1 min-w-[200px] min-h-[40px] bg-[#0B0E14] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      disabled={castBusy || !manualCastHost.trim()}
                      onClick={() => void handleConnectManualCastHost()}
                      className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-amber-400/50 text-xs font-semibold text-amber-300 transition-colors whitespace-nowrap"
                    >
                      Per IP verbinden
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {castSnapshot.mode !== 'native_android' && (
                      <button
                        type="button"
                        disabled={castBusy}
                        onClick={() => void handleConnectChromecast()}
                        className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <Cast className="w-4 h-4" />
                        <span>
                          {castBusy
                            ? 'Verbinde Chromecast…'
                            : isCastConnected
                              ? 'Gerät wechseln'
                              : 'Browser-Cast starten'}
                        </span>
                      </button>
                    )}

                    {isCastConnected && (
                      <>
                        <button
                          type="button"
                          disabled={castBusy}
                          onClick={() => void handleResendToChromecast()}
                          className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
                        >
                          Titel neu senden
                        </button>
                        <button
                          type="button"
                          onClick={handleDisconnectChromecast}
                          className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#121722] hover:bg-rose-950/50 border border-slate-700 hover:border-rose-700/60 text-xs font-medium text-rose-300 transition-colors whitespace-nowrap"
                        >
                          Trennen
                        </button>
                      </>
                    )}
                  </div>

                  {castMessage && (
                    <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 text-xs text-slate-200 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>{castMessage}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Warteschlangen Sheet */}
              {activeSheet === 'queue' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoPlayNext}
                        onChange={(e) => setAutoPlayNext(e.target.checked)}
                        className="accent-amber-400 rounded w-4 h-4"
                      />
                      <span>Automatisch nacheinander abspielen</span>
                    </label>

                    {queue.length > 0 && (
                      <button
                        type="button"
                        onClick={onClearQueue}
                        className="text-xs text-slate-400 hover:text-red-300 transition-colors whitespace-nowrap"
                      >
                        Warteschlange leeren
                      </button>
                    )}
                  </div>

                  {queue.length === 0 ? (
                    <p className="text-xs text-slate-400 py-1">
                      Noch keine weiteren Titel eingereiht. Nach Ende dieser Datei kehrt der Player automatisch zur Startseite zurück.
                    </p>
                  ) : (
                    <div className="max-h-52 overflow-y-auto divide-y divide-slate-800/80 rounded-xl border border-slate-800/80 bg-[#121722]">
                      {queue.map((entry, idx) => (
                        <div
                          key={entry.queueId}
                          className="px-3.5 py-2.5 flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="font-mono text-xs text-amber-400 tabular-nums w-5 shrink-0">
                              {idx + 1}.
                            </span>
                            <img
                              src={entry.media.coverUrl}
                              alt={entry.media.title}
                              referrerPolicy="no-referrer"
                              className="w-8 h-11 rounded object-cover border border-slate-800 shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-white truncate">
                                {entry.media.title}
                              </p>
                              <p className="text-[11px] text-slate-400 truncate tabular-nums">
                                {entry.media.currentEpisode
                                  ? `S${String(entry.media.currentEpisode.season).padStart(
                                      2,
                                      '0'
                                    )}E${String(entry.media.currentEpisode.episode).padStart(
                                      2,
                                      '0'
                                    )} · ${entry.media.currentEpisode.title}`
                                  : `${entry.media.kind === 'series' ? 'Serie' : 'Film'} · ${
                                      entry.media.totalDurationMinutes
                                    } Min.`}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => onMoveQueueItem(entry.queueId, 'up')}
                              disabled={idx === 0}
                              aria-label="Nach oben verschieben"
                              className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white disabled:opacity-30 flex items-center justify-center"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onMoveQueueItem(entry.queueId, 'down')}
                              disabled={idx === queue.length - 1}
                              aria-label="Nach unten verschieben"
                              className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white disabled:opacity-30 flex items-center justify-center"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onPlayQueueIndex(idx);
                                setActiveSheet('none');
                              }}
                              title="Jetzt abspielen"
                              className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap ml-1"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span className="hidden sm:inline">Abspielen</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemoveFromQueue(entry.queueId)}
                              aria-label={`${entry.media.title} aus Warteschlange entfernen`}
                              className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-red-300 ml-0.5 flex items-center justify-center"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {libraryItems.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <select
                        aria-label="Film oder Serie für Warteschlange auswählen"
                        value={quickAddMedia?.id ?? ''}
                        onChange={(e) => setQuickAddMediaId(e.target.value)}
                        className="flex-1 min-w-[160px] min-h-[44px] bg-[#121722] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white"
                      >
                        {libraryItems.map((libItem) => (
                          <option key={libItem.id} value={libItem.id}>
                            {libItem.title} ({libItem.kind === 'series' ? 'Serie' : 'Film'})
                          </option>
                        ))}
                      </select>

                      {quickAddMedia?.kind === 'series' &&
                        quickAddMedia.episodes &&
                        quickAddMedia.episodes.length > 0 && (
                          <select
                            aria-label="Folge für Warteschlange auswählen"
                            value={quickAddEpisodeKey}
                            onChange={(e) => setQuickAddEpisodeKey(e.target.value)}
                            className="flex-1 min-w-[160px] min-h-[44px] bg-[#121722] border border-slate-800 rounded-xl px-3 py-2 text-xs text-white"
                          >
                            {quickAddMedia.episodes.map((ep) => (
                              <option
                                key={`S${ep.season}E${ep.episode}`}
                                value={`${ep.season}-${ep.episode}`}
                              >
                                S{String(ep.season).padStart(2, '0')}E
                                {String(ep.episode).padStart(2, '0')} — {ep.title}
                              </option>
                            ))}
                          </select>
                        )}

                      <button
                        type="button"
                        onClick={handleQuickAdd}
                        className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <ListPlus className="w-4 h-4" />
                        <span>Zur Warteschlange</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
