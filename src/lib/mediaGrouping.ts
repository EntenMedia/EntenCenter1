import { MARCENTE_ASSETS } from '../data/coverAssets';
import type { MediaKind, NasMediaItem, NasSeriesEpisode } from '../types/marcente';

const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg)$/i;
const AUDIO_EXT_REGEX =
  /\.(mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|alac|aiff|aif|mka|amr|mid|midi|ac3|dts|ape|wv)$/i;
const VIDEO_EXT_REGEX =
  /\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|iso)$/i;
const DOC_EXT_REGEX = /\.(pdf|epub|txt|srt|vtt|ass|ssa)$/i;

const SERIES_FILE_REGEX =
  /(?:^|[\s._(-])(?:s\d{1,2}\s*[._-]?\s*e\d{1,3}|ep?\s*\d{1,3}(?=\b|[\s._-])|\d{1,2}x\d{1,3})(?:$|[\s._)-])|\b(?:staffel|season)\s*\d+\b|\b(?:episode|folge)\s*\d+\b/i;

const SERIES_DIR_REGEX =
  /\/(?:serien|series|tv[\s._-]?shows?|tv[\s._-]?serien|anime|doku[\s._-]?serien|staffel[\s._-]*\d*|season[\s._-]*\d*|s\d{1,2})(?:\/|$)/i;

const SHORT_VIDEO_DIR_REGEX =
  /\/(?:clips?|shorts?|reels?|camera|kamera|dcim|whatsapp(?:\s+video)?|handy|privat|homevideo|sample|trailer|musikvideos?|music[\s._-]?videos?)(?:\/|$)/i;

const SHORT_VIDEO_FILE_REGEX =
  /(?:^|[\s._-])(?:sample|trailer|teaser|whatsapp|vid[-_]\d{8}|pxl[-_]\d{8}|img[-_]\d{4}|mov[-_]\d{4}|dsc[-_]\d{4})(?:$|[\s._-])/i;

const SEASON_FOLDER_REGEX = /^(?:staffel|season|st\.?|s)\s*0*(\d{1,2})$/i;

const GENERIC_ROOT_FOLDER_SET = new Set([
  '',
  'fritz',
  'fritz.nas',
  'fritz!nas',
  'nas',
  'usb',
  'hdd',
  'ssd',
  'disk',
  'platte',
  'medien',
  'media',
  'serien',
  'series',
  'tv',
  'tv shows',
  'tv-shows',
  'tv serien',
  'tv-serien',
  'filme',
  'movies',
  'film',
  'videos',
  'video',
  'anime',
  'downloads',
  'download',
  'share',
  'shared',
  'extras',
  'bonus',
  'specials',
]);

export function classifyMediaKind(
  fileName: string,
  dirPath = '',
  currentKind?: MediaKind,
  manualKindLock?: boolean
): MediaKind {
  if (manualKindLock && currentKind) {
    return currentKind;
  }
  const cleanName = (fileName || '').trim();
  const cleanDir = `/${(dirPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;

  if (IMAGE_EXT_REGEX.test(cleanName)) return 'image';
  if (AUDIO_EXT_REGEX.test(cleanName)) return 'music';
  if (DOC_EXT_REGEX.test(cleanName)) return 'other';

  if (VIDEO_EXT_REGEX.test(cleanName) || (!cleanName.includes('.') && (currentKind === 'movie' || currentKind === 'series' || currentKind === 'video'))) {
    if (SERIES_FILE_REGEX.test(cleanName) || SERIES_DIR_REGEX.test(cleanDir)) {
      return 'series';
    }
    if (currentKind === 'series') {
      return 'series';
    }
    if (SHORT_VIDEO_DIR_REGEX.test(cleanDir) || SHORT_VIDEO_FILE_REGEX.test(cleanName)) {
      return 'video';
    }
    return 'movie';
  }

  return currentKind ?? 'other';
}

export function cleanSeriesOrMovieName(raw: string): string {
  let s = (raw || '').trim();
  s = s.replace(
    /\.(mp4|mkv|webm|mov|avi|m4v|ts|m2ts|mts|mpg|mpeg|wmv|flv|f4v|3gp|3g2|ogv|vob|asf|divx|rmvb|m3u8|m3u|iso|mp3|flac|wav|ogg|oga|m4a|aac|opus|wma|m4b|alac|aiff|aif|mka|amr|mid|midi|ac3|dts|ape|wv|jpg|jpeg|png|webp|gif|bmp|heic|heif|avif|tiff|tif|svg|pdf|epub|txt|srt|vtt|ass|ssa)$/i,
    ''
  );
  s = s.replace(
    /\[[^\]]*\]|\([^)]*(?:1080p|720p|2160p|4k|x264|x265|hevc|bluray|web|german|dl|dubbed|subbed)[^)]*\)/gi,
    ' '
  );
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(
    /\b(2160p|1080p|720p|480p|576p|4k|uhd|hdr|hdr10|dolby|atmos|vision|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web-dl|webdl|hdtv|hdrip|remux|x264|x265|h264|h265|hevc|avc|vp9|av1|xvid|divx|aac|ac3|eac3|dts|dts-hd|truehd|flac|mp3|german|deutsch|eng|english|multi|dual|dl|subbed|dubbed|uncut|extended|directors\s*cut|proper|repack|internal)\b/gi,
    ' '
  );
  s = s.replace(/\s*[-–]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return s;
}

export function normalizeSeriesGroupKey(title: string): string {
  return (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ParsedSeriesEpisodeInfo {
  seriesTitle: string;
  seriesFolderPath: string;
  season: number;
  episode: number;
  episodeTitle: string;
}

function getSeriesFolderContext(nasPath?: string): {
  seriesTitleFromFolder: string;
  seasonFromFolder?: number;
  seriesFolderPath: string;
} {
  const clean = (nasPath || '').replace(/\\/g, '/').trim();
  const segments = clean.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return { seriesTitleFromFolder: '', seriesFolderPath: '/' };
  }
  const dirSegments = segments.slice(0, -1);
  let seasonFromFolder: number | undefined;
  let seriesIdx = dirSegments.length - 1;

  const lastDir = dirSegments[seriesIdx];
  const seasonMatch = SEASON_FOLDER_REGEX.exec(lastDir);
  if (seasonMatch) {
    seasonFromFolder = Math.max(1, Number(seasonMatch[1]));
    seriesIdx -= 1;
  }

  while (seriesIdx >= 0) {
    const cand = dirSegments[seriesIdx].trim();
    const lower = cand.toLowerCase();
    if (
      SEASON_FOLDER_REGEX.test(cand) ||
      GENERIC_ROOT_FOLDER_SET.has(lower) ||
      /^usb[-_\s]?\d*$/i.test(lower) ||
      /^sandisk|verbatim|toshiba|seagate|western|wd/i.test(lower)
    ) {
      seriesIdx -= 1;
      continue;
    }
    const cleanedFolder = cleanSeriesOrMovieName(cand);
    if (cleanedFolder.length >= 2) {
      return {
        seriesTitleFromFolder: cleanedFolder,
        seasonFromFolder,
        seriesFolderPath: `/${dirSegments.slice(0, seriesIdx + 1).join('/')}`,
      };
    }
    seriesIdx -= 1;
  }

  const fallbackDir = dirSegments[Math.max(0, dirSegments.length - (seasonFromFolder ? 2 : 1))] || '';
  return {
    seriesTitleFromFolder: cleanSeriesOrMovieName(fallbackDir),
    seasonFromFolder,
    seriesFolderPath: `/${dirSegments.join('/')}`,
  };
}

export function parseSeriesEpisodeInfo(
  fileNameOrTitle: string,
  nasPath?: string
): ParsedSeriesEpisodeInfo {
  const rawBase = (
    (nasPath ? nasPath.split('/').pop() : undefined) ||
    fileNameOrTitle ||
    'Unbekannte Serie'
  ).trim();
  const stem = rawBase.replace(/\.[a-z0-9]{2,5}$/i, '');
  const folderCtx = getSeriesFolderContext(nasPath);

  let season = folderCtx.seasonFromFolder ?? 1;
  let episode = 1;
  let rawSeriesPart = '';
  let rawEpisodePart = '';

  const seMatch = /(?:^|[\s._-])s(\d{1,2})\s*[._-]?\s*e(\d{1,3})(?:$|[\s._-])/i.exec(stem);
  const xMatch = !seMatch
    ? /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:$|[\s._-])/i.exec(stem)
    : null;
  const wordMatch =
    !seMatch && !xMatch
      ? /(?:staffel|season)\s*(\d{1,2})\D{0,12}(?:folge|episode|ep\.?)\s*(\d{1,3})/i.exec(stem)
      : null;
  const epOnlyMatch =
    !seMatch && !xMatch && !wordMatch
      ? /(?:^|[\s._-])(?:folge|episode|ep\.?)\s*0*(\d{1,3})(?:$|[\s._-])/i.exec(stem)
      : null;
  const leadNumMatch =
    !seMatch && !xMatch && !wordMatch && !epOnlyMatch
      ? /^0*(\d{1,3})\s*[-._)]\s+(.+)$/i.exec(stem)
      : null;

  if (seMatch) {
    season = Math.max(1, Number(seMatch[1]));
    episode = Math.max(1, Number(seMatch[2]));
    rawSeriesPart = stem.slice(0, seMatch.index);
    rawEpisodePart = stem.slice(seMatch.index + seMatch[0].length);
  } else if (xMatch) {
    season = Math.max(1, Number(xMatch[1]));
    episode = Math.max(1, Number(xMatch[2]));
    rawSeriesPart = stem.slice(0, xMatch.index);
    rawEpisodePart = stem.slice(xMatch.index + xMatch[0].length);
  } else if (wordMatch) {
    season = Math.max(1, Number(wordMatch[1]));
    episode = Math.max(1, Number(wordMatch[2]));
    rawSeriesPart = stem.slice(0, wordMatch.index);
    rawEpisodePart = stem.slice(wordMatch.index + wordMatch[0].length);
  } else if (epOnlyMatch) {
    episode = Math.max(1, Number(epOnlyMatch[1]));
    rawSeriesPart = stem.slice(0, epOnlyMatch.index);
    rawEpisodePart = stem.slice(epOnlyMatch.index + epOnlyMatch[0].length);
  } else if (leadNumMatch) {
    episode = Math.max(1, Number(leadNumMatch[1]));
    rawSeriesPart = '';
    rawEpisodePart = leadNumMatch[2];
  } else {
    rawSeriesPart = stem;
  }

  let cleanedSeries = cleanSeriesOrMovieName(rawSeriesPart)
    .replace(/\b(?:19|20)\d{2}$/, '')
    .trim();

  // Falls der Dateiname erst mit S01E01 / Folge 01 / Staffel 1 beginnt, nutze den übergeordneten Serien-Ordner
  if (
    !cleanedSeries ||
    cleanedSeries.length < 2 ||
    SEASON_FOLDER_REGEX.test(cleanedSeries) ||
    /^(?:folge|episode|ep)\s*\d*$/i.test(cleanedSeries) ||
    /^\d+$/.test(cleanedSeries)
  ) {
    cleanedSeries = folderCtx.seriesTitleFromFolder || cleanSeriesOrMovieName(fileNameOrTitle) || 'Unbekannte Serie';
  }

  // Falls im Seriennamen selbst "Staffel 2" am Ende steckt, abtrennen
  cleanedSeries = cleanedSeries.replace(/\s*[-–]?\s*(?:staffel|season)\s*\d+\s*$/i, '').trim() || cleanedSeries;

  const cleanedEpTitle = cleanSeriesOrMovieName(rawEpisodePart)
    .replace(/^[-–:.\s]+/, '')
    .trim();

  return {
    seriesTitle: cleanedSeries,
    seriesFolderPath: folderCtx.seriesFolderPath,
    season,
    episode,
    episodeTitle: cleanedEpTitle && cleanedEpTitle.length >= 2 ? cleanedEpTitle : `Folge ${episode}`,
  };
}

function stableSeriesId(seriesKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seriesKey.length; i += 1) {
    hash ^= seriesKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const slug = seriesKey.replace(/\s+/g, '-').slice(0, 28) || 'serie';
  return `nas-series-${slug}-${(hash >>> 0).toString(36)}`;
}

function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isCustomOrRealCover(url?: string | null): boolean {
  if (!url || !url.trim()) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('data:image/')) return true;
  if (trimmed.includes('mzstatic.com') || trimmed.includes('tvmaze.com') || trimmed.includes('wikimedia.org')) {
    return true;
  }
  const placeholderValues = new Set<string>(Object.values(MARCENTE_ASSETS));
  if (placeholderValues.has(trimmed)) return false;
  return !/\/assets\/|poster_dark_matter|poster_cyber_berlin|poster_nordic_crime|poster_alpine_doc|cover_nas_|duck_mascot/i.test(
    trimmed
  );
}

function isGenericScanSynopsis(synopsis?: string | null): boolean {
  if (!synopsis || !synopsis.trim()) return true;
  return (
    synopsis.startsWith('Beim NAS-Ordnerscan') ||
    synopsis.startsWith('Beim Live-NAS-Ordnerscan') ||
    synopsis.startsWith('Direkt auf das NAS hochgeladene')
  );
}

export function groupAndNormalizeNasCatalog(rawItems: NasMediaItem[]): {
  items: NasMediaItem[];
  changed: boolean;
} {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { items: [], changed: false };
  }

  let changed = false;

  // Map bekannte Serienordner -> kanonischer Gruppen-Key (hilft wenn User einen Serientitel manuell umbenannt hat)
  const folderToCanonicalKey = new Map<string, string>();
  const existingSeriesEntries: NasMediaItem[] = [];
  const flatSeriesEntries: NasMediaItem[] = [];
  const nonSeriesByPath = new Map<string, NasMediaItem>();

  for (const item of rawItems) {
    const fileName = item.uploadedFileName || item.nasPath?.split('/').pop() || item.title || '';
    const dirPath = item.nasPath ? item.nasPath.replace(/\/[^/]*$/, '') : '';
    const nextKind = classifyMediaKind(fileName, dirPath, item.kind, item.manualKindLock);
    const normalizedItem: NasMediaItem =
      nextKind !== item.kind
        ? (() => {
            changed = true;
            const nextCover =
              !item.customCoverUrl && !isCustomOrRealCover(item.coverUrl)
                ? nextKind === 'series'
                  ? MARCENTE_ASSETS.posterCyberBerlin
                  : nextKind === 'movie'
                    ? MARCENTE_ASSETS.posterDarkMatter
                    : item.coverUrl
                : item.coverUrl;
            const nextGenre =
              item.genre === 'Medien' || item.genre === 'Video'
                ? nextKind === 'series'
                  ? 'Serie'
                  : nextKind === 'movie'
                    ? 'Film'
                    : item.genre
                : item.genre;
            return {
              ...item,
              kind: nextKind,
              coverUrl: nextCover,
              genre: nextGenre,
            };
          })()
        : item;

    if (normalizedItem.kind === 'series') {
      if (normalizedItem.episodes && normalizedItem.episodes.length > 0) {
        existingSeriesEntries.push(normalizedItem);
        const key = normalizeSeriesGroupKey(normalizedItem.title);
        if (key) {
          for (const ep of normalizedItem.episodes) {
            const folder = getSeriesFolderContext(ep.nasPath).seriesFolderPath.toLowerCase();
            if (folder && folder !== '/' && !GENERIC_ROOT_FOLDER_SET.has(folder.replace(/\//g, ''))) {
              folderToCanonicalKey.set(folder, key);
            }
          }
          if (normalizedItem.nasPath) {
            const folder = getSeriesFolderContext(normalizedItem.nasPath).seriesFolderPath.toLowerCase();
            if (folder && folder !== '/' && !GENERIC_ROOT_FOLDER_SET.has(folder.replace(/\//g, ''))) {
              folderToCanonicalKey.set(folder, key);
            }
          }
        }
      } else {
        flatSeriesEntries.push(normalizedItem);
      }
    } else {
      const pathKey = (normalizedItem.nasPath || normalizedItem.id).toLowerCase();
      if (!nonSeriesByPath.has(pathKey)) {
        nonSeriesByPath.set(pathKey, normalizedItem);
      } else {
        changed = true;
      }
    }
  }

  interface SeriesGroupBucket {
    canonicalKey: string;
    seriesTitle: string;
    baseItem: NasMediaItem;
    episodesByKey: Map<string, NasSeriesEpisode & { _byteSize?: number }>;
    coverPool: Set<string>;
    totalBytes: number;
    hasBytesMap: Map<string, number>;
  }

  const groups = new Map<string, SeriesGroupBucket>();

  const ensureBucket = (key: string, title: string, seed: NasMediaItem): SeriesGroupBucket => {
    const existing = groups.get(key);
    if (existing) return existing;
    const coverPool = new Set<string>();
    if (seed.customCoverUrl) coverPool.add(seed.customCoverUrl);
    if (isCustomOrRealCover(seed.coverUrl)) coverPool.add(seed.coverUrl);
    for (const cand of seed.coverCandidates ?? []) {
      if (cand) coverPool.add(cand);
    }
    const bucket: SeriesGroupBucket = {
      canonicalKey: key,
      seriesTitle: title,
      baseItem: seed,
      episodesByKey: new Map(),
      coverPool,
      totalBytes: 0,
      hasBytesMap: new Map(),
    };
    groups.set(key, bucket);
    return bucket;
  };

  // Zuerst bereits gruppierte Serien-Objekte übernehmen (bewahrt manuelle Titel, Cover, Synopsis & Watch-State)
  for (const seriesItem of existingSeriesEntries) {
    const key = normalizeSeriesGroupKey(seriesItem.title) || seriesItem.id.toLowerCase();
    const bucket = ensureBucket(key, seriesItem.title, seriesItem);
    // Bevorzuge bereits angereicherte Metadaten als Base
    if (isGenericScanSynopsis(bucket.baseItem.synopsis) && !isGenericScanSynopsis(seriesItem.synopsis)) {
      bucket.baseItem = { ...bucket.baseItem, ...seriesItem };
    }
    if (seriesItem.inWatchlist) bucket.baseItem.inWatchlist = true;
    if (seriesItem.customCoverUrl && !bucket.baseItem.customCoverUrl) {
      bucket.baseItem.customCoverUrl = seriesItem.customCoverUrl;
      bucket.baseItem.coverUrl = seriesItem.customCoverUrl;
    } else if (!isCustomOrRealCover(bucket.baseItem.coverUrl) && isCustomOrRealCover(seriesItem.coverUrl)) {
      bucket.baseItem.coverUrl = seriesItem.coverUrl;
    }
    if (seriesItem.customCoverUrl) bucket.coverPool.add(seriesItem.customCoverUrl);
    if (isCustomOrRealCover(seriesItem.coverUrl)) bucket.coverPool.add(seriesItem.coverUrl);
    for (const c of seriesItem.coverCandidates ?? []) bucket.coverPool.add(c);

    for (const ep of seriesItem.episodes ?? []) {
      const epPathKey = (ep.nasPath || `s${ep.season}e${ep.episode}`).toLowerCase();
      const prev = bucket.episodesByKey.get(epPathKey);
      if (!prev) {
        bucket.episodesByKey.set(epPathKey, { ...ep });
      } else if (ep.watched && !prev.watched) {
        prev.watched = true;
      }
    }
    if (seriesItem.uploadedByteSize && seriesItem.uploadedByteSize > 0) {
      bucket.hasBytesMap.set(seriesItem.id, seriesItem.uploadedByteSize);
    }
  }

  // Danach alle einzelnen Episoden-Dateien unter dem jeweiligen Serientitel zusammenfassen
  if (flatSeriesEntries.length > 0) {
    changed = true;
  }

  for (const epItem of flatSeriesEntries) {
    const fileName = epItem.uploadedFileName || epItem.nasPath?.split('/').pop() || epItem.title;
    const parsed = parseSeriesEpisodeInfo(fileName, epItem.nasPath);
    const folderKey = parsed.seriesFolderPath.toLowerCase();
    const mappedKey = folderToCanonicalKey.get(folderKey);
    const key = mappedKey || normalizeSeriesGroupKey(parsed.seriesTitle) || epItem.id.toLowerCase();
    if (!mappedKey && folderKey && folderKey !== '/' && !GENERIC_ROOT_FOLDER_SET.has(folderKey.replace(/\//g, ''))) {
      folderToCanonicalKey.set(folderKey, key);
    }

    const bucket = ensureBucket(key, parsed.seriesTitle, {
      ...epItem,
      id: existingSeriesEntries.find((s) => normalizeSeriesGroupKey(s.title) === key)?.id || stableSeriesId(key),
      title: parsed.seriesTitle,
      genre: epItem.genre === 'Medien' ? 'Serie' : epItem.genre,
      synopsis: isGenericScanSynopsis(epItem.synopsis)
        ? `Serie „${parsed.seriesTitle}“ vom NAS (${parsed.seriesFolderPath}).`
        : epItem.synopsis,
    });

    if (epItem.inWatchlist) bucket.baseItem.inWatchlist = true;
    if (epItem.customCoverUrl && !bucket.baseItem.customCoverUrl) {
      bucket.baseItem.customCoverUrl = epItem.customCoverUrl;
      bucket.baseItem.coverUrl = epItem.customCoverUrl;
    } else if (!isCustomOrRealCover(bucket.baseItem.coverUrl) && isCustomOrRealCover(epItem.coverUrl)) {
      bucket.baseItem.coverUrl = epItem.coverUrl;
    }
    if (!isGenericScanSynopsis(epItem.synopsis) && isGenericScanSynopsis(bucket.baseItem.synopsis)) {
      bucket.baseItem.synopsis = epItem.synopsis;
    }
    if (epItem.customCoverUrl) bucket.coverPool.add(epItem.customCoverUrl);
    if (isCustomOrRealCover(epItem.coverUrl)) bucket.coverPool.add(epItem.coverUrl);
    for (const c of epItem.coverCandidates ?? []) bucket.coverPool.add(c);

    if (epItem.lastWatchedAt) {
      if (!bucket.baseItem.lastWatchedAt || epItem.lastWatchedAt > bucket.baseItem.lastWatchedAt) {
        bucket.baseItem.lastWatchedAt = epItem.lastWatchedAt;
      }
    }

    const epPathKey = (epItem.nasPath || `s${parsed.season}e${parsed.episode}:${epItem.id}`).toLowerCase();
    const byteSize = Math.max(0, epItem.uploadedByteSize ?? 0);
    if (byteSize > 0) {
      bucket.hasBytesMap.set(epPathKey, byteSize);
    }

    const epWatched = Boolean(
      epItem.lastWatchedAt ||
        (epItem.watchedMinutes > 0 && epItem.watchedMinutes >= Math.max(1, epItem.totalDurationMinutes - 2))
    );

    const existingEp = bucket.episodesByKey.get(epPathKey);
    if (!existingEp) {
      bucket.episodesByKey.set(epPathKey, {
        season: parsed.season,
        episode: parsed.episode,
        title: parsed.episodeTitle,
        summary: `Staffel ${parsed.season}, Folge ${parsed.episode} (${fileName})`,
        durationMinutes: epItem.totalDurationMinutes > 0 ? epItem.totalDurationMinutes : 42,
        nasPath: epItem.nasPath,
        fileSize: epItem.fileSize || formatBytesCompact(byteSize),
        watched: epWatched,
      });
    } else if (epWatched && !existingEp.watched) {
      existingEp.watched = true;
    }
  }

  const groupedSeriesList: NasMediaItem[] = [];
  for (const bucket of groups.values()) {
    const episodes = Array.from(bucket.episodesByKey.values()).sort(
      (a, b) => a.season - b.season || a.episode - b.episode || a.title.localeCompare(b.title, 'de')
    );

    if (episodes.length === 0) {
      groupedSeriesList.push(bucket.baseItem);
      continue;
    }

    const distinctSeasons = Array.from(new Set(episodes.map((e) => e.season))).sort((a, b) => a - b);
    const seasonsLabels = distinctSeasons.map((s) => `Staffel ${s}`);
    const watchedCount = episodes.filter((e) => e.watched).length;
    const nextUnwatched = episodes.find((e) => !e.watched) ?? episodes[0];
    const totalDuration = episodes.reduce((acc, ep) => acc + Math.max(1, ep.durationMinutes || 42), 0);
    const watchedMins = episodes
      .filter((e) => e.watched)
      .reduce((acc, ep) => acc + Math.max(1, ep.durationMinutes || 42), 0);

    let sumBytes = 0;
    for (const b of bucket.hasBytesMap.values()) {
      sumBytes += b;
    }
    const finalBytes = Math.max(sumBytes, bucket.baseItem.uploadedByteSize ?? 0);
    const coverCandidates = Array.from(bucket.coverPool);
    const effectiveCover =
      bucket.baseItem.customCoverUrl ||
      (isCustomOrRealCover(bucket.baseItem.coverUrl) ? bucket.baseItem.coverUrl : coverCandidates[0]) ||
      bucket.baseItem.coverUrl ||
      MARCENTE_ASSETS.posterCyberBerlin;

    const firstFolder = getSeriesFolderContext(episodes[0].nasPath).seriesFolderPath;
    if (existingSeriesEntries.length > 0 && !existingSeriesEntries.some((s) => s.id === bucket.baseItem.id)) {
      changed = true;
    }

    groupedSeriesList.push({
      ...bucket.baseItem,
      id: bucket.baseItem.id || stableSeriesId(bucket.canonicalKey),
      title: bucket.seriesTitle || bucket.baseItem.title,
      kind: 'series',
      coverUrl: effectiveCover,
      coverCandidates: coverCandidates.length > 0 ? coverCandidates : bucket.baseItem.coverCandidates,
      nasPath: bucket.baseItem.nasPath || (firstFolder !== '/' ? firstFolder : episodes[0].nasPath),
      totalEpisodes: episodes.length,
      episodes,
      episodesWatchedCount: watchedCount,
      seasons: seasonsLabels,
      totalDurationMinutes: totalDuration,
      watchedMinutes: Math.max(bucket.baseItem.watchedMinutes ?? 0, watchedMins),
      currentEpisode: {
        season: nextUnwatched.season,
        episode: nextUnwatched.episode,
        title: nextUnwatched.title,
        durationMinutes: nextUnwatched.durationMinutes,
      },
      uploadedByteSize: finalBytes > 0 ? finalBytes : bucket.baseItem.uploadedByteSize,
      fileSize: finalBytes > 0 ? formatBytesCompact(finalBytes) : bucket.baseItem.fileSize,
    });
  }

  const combined = [...groupedSeriesList, ...Array.from(nonSeriesByPath.values())];
  if (combined.length !== rawItems.length) {
    changed = true;
  }
  return { items: combined, changed };
}
