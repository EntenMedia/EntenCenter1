import type {
  CalendarNotificationMode,
  CalendarRelease,
  FilmGroundSource,
  FilmNotificationMode,
  FilmStartRelease,
  FilmStartsResponse,
  FskLevel,
  MediaKind,
  MediaOnlineSearchCandidate,
  NasMediaItem,
  NasNotification,
  SeriesCalendarResponse,
  SeriesLookupCandidate,
  SeriesProductionStatus,
  StreamingProviderDE,
} from '../types/marcente';
import { MARCENTE_ASSETS } from '../data/coverAssets';
import { mapNetworkToGermanProvider } from '../data/germanProviders';
import { nativeAndroidFetch, isNativeAndroidShell } from './nasClient';
import { parseSeriesEpisodeInfo } from './mediaGrouping';

const BRIDGE_FILMSTARTS_CACHE_KEY = 'entencenter_bridge_filmstarts_v1';
const BRIDGE_FILM_PREFS_KEY = 'entencenter_bridge_film_prefs_v1';
const BRIDGE_SERIES_CACHE_KEY = 'entencenter_bridge_series_calendar_v1';
const BRIDGE_SERIES_MANUAL_KEY = 'entencenter_bridge_manual_series_v1';
const BRIDGE_SERIES_PREFS_KEY = 'entencenter_bridge_series_prefs_v1';
const BRIDGE_NOTIFICATIONS_KEY = 'entencenter_bridge_notifications_v1';

interface FavoritePrefsStore {
  pinned: string[];
  muted: string[];
}

function readFavoritePrefs(key: string): FavoritePrefsStore {
  if (typeof window === 'undefined') return { pinned: [], muted: [] };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { pinned: [], muted: [] };
    const parsed = JSON.parse(raw) as Partial<FavoritePrefsStore>;
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      muted: Array.isArray(parsed.muted) ? parsed.muted : [],
    };
  } catch {
    return { pinned: [], muted: [] };
  }
}

function saveFavoritePrefs(key: string, prefs: FavoritePrefsStore): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // ignore storage limits
  }
}

export async function fetchExternalText(
  url: string,
  timeoutMs = 8000,
  accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers = {
    Accept: accept,
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  };
  if (isNativeAndroidShell()) {
    try {
      const nativeRes = await nativeAndroidFetch(url, { method: 'GET', headers }, timeoutMs);
      if (nativeRes) {
        const text = await nativeRes.text().catch(() => '');
        return { ok: nativeRes.ok, status: nativeRes.status, text };
      }
    } catch {
      // Fallback below
    }
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller?.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchExternalJson<T = unknown>(
  url: string,
  timeoutMs = 7500
): Promise<T | null> {
  const res = await fetchExternalText(url, timeoutMs, 'application/json,text/plain,*/*');
  if (!res.ok || !res.text) return null;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return null;
  }
}

export function stripHtmlTags(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&uuml;/g, 'ü')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&szlig;/g, 'ß')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanMediaTitleForLookup(rawTitleOrFile: string): {
  query: string;
  yearHint?: number;
  seasonHint?: number;
  episodeHint?: number;
} {
  let s = (rawTitleOrFile || '').trim();
  s = s.replace(/\.[a-z0-9]{2,5}$/i, '');

  let seasonHint: number | undefined;
  let episodeHint: number | undefined;
  const seMatch = /(?:^|[\s._-])s(\d{1,2})e(\d{1,2})(?:$|[\s._-])/i.exec(s);
  if (seMatch) {
    seasonHint = Number(seMatch[1]);
    episodeHint = Number(seMatch[2]);
    s = s.slice(0, seMatch.index).trim() || s.replace(seMatch[0], ' ');
  } else {
    const xMatch = /(?:^|[\s._-])(\d{1,2})x(\d{1,2})(?:$|[\s._-])/i.exec(s);
    if (xMatch) {
      seasonHint = Number(xMatch[1]);
      episodeHint = Number(xMatch[2]);
      s = s.slice(0, xMatch.index).trim() || s.replace(xMatch[0], ' ');
    }
  }

  let yearHint: number | undefined;
  const yearMatches = s.match(/(?:^|[\s._([-])((?:19|20)\d{2})(?=$|[\s._)\]-])/g);
  if (yearMatches && yearMatches.length > 0) {
    const lastYr = yearMatches[yearMatches.length - 1].replace(/\D/g, '');
    const yrNum = Number(lastYr);
    if (yrNum >= 1920 && yrNum <= 2035) {
      yearHint = yrNum;
      s = s.replace(yearMatches[yearMatches.length - 1], ' ');
    }
  }

  // Track numbers like "01 - Artist - Title"
  s = s.replace(/^\d{1,3}\s*[-._)]\s+/, '');
  // Bracketed tags
  s = s.replace(/\[[^\]]*\]|\([^)]*(?:1080p|720p|2160p|4k|x264|x265|hevc|bluray|web|flac|mp3|german|dl)[^)]*\)/gi, ' ');
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(
    /\b(2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dolby|atmos|vision|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web-dl|webdl|hdtv|hdrip|remux|x264|x265|h264|h265|hevc|avc|vp9|av1|xvid|divx|aac|ac3|dts|dts-hd|truehd|flac|mp3|320kbps|vbr|german|deutsch|eng|english|multi|dual|dl|subbed|dubbed|uncut|extended|directors\s*cut|proper|repack|internal)\b/gi,
    ' '
  );
  s = s.replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { query: s || rawTitleOrFile, yearHint, seasonHint, episodeHint };
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isPlaceholderCoverUrl(url?: string | null): boolean {
  if (!url || !url.trim()) return true;
  const trimmed = url.trim();
  if (trimmed.startsWith('data:image/')) return false;
  if (trimmed.includes('mzstatic.com') || trimmed.includes('tvmaze.com') || trimmed.includes('wikimedia.org')) {
    return false;
  }
  const placeholderValues = new Set<string>(Object.values(MARCENTE_ASSETS));
  if (placeholderValues.has(trimmed)) return true;
  return /\/assets\/|poster_dark_matter|poster_cyber_berlin|poster_nordic_crime|poster_alpine_doc|cover_nas_|duck_mascot/i.test(
    trimmed
  );
}

function parseGermanDateToIso(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const dotMatch = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(trimmed);
  if (dotMatch) {
    const d = dotMatch[1].padStart(2, '0');
    const m = dotMatch[2].padStart(2, '0');
    const y = dotMatch[3];
    return `${y}-${m}-${d}`;
  }
  const monthNames: Record<string, string> = {
    januar: '01',
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
  const textMatch = /(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/.exec(trimmed);
  if (textMatch) {
    const d = textMatch[1].padStart(2, '0');
    const m = monthNames[textMatch[2].toLowerCase()];
    if (m) return `${textMatch[3]}-${m}-${d}`;
  }
  return null;
}

function upscaleArtworkUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  return url
    .replace(/\/\d+x\d+bb\.(jpg|png|webp)/i, '/600x600bb.$1')
    .replace(/^http:\/\//i, 'https://');
}

function mapNetworkToProviderDE(
  networkName?: string | null,
  isWebChannel = false
): StreamingProviderDE {
  return mapNetworkToGermanProvider(networkName, isWebChannel);
}

export function readBridgeNotifications(): NasNotification[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BRIDGE_NOTIFICATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NasNotification[]) : [];
  } catch {
    return [];
  }
}

export function saveBridgeNotifications(alerts: NasNotification[]): NasNotification[] {
  const deduped: NasNotification[] = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    if (!a?.id || seen.has(a.id)) continue;
    seen.add(a.id);
    deduped.push(a);
  }
  const sliced = deduped.slice(0, 120);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(BRIDGE_NOTIFICATIONS_KEY, JSON.stringify(sliced));
    } catch {
      // ignore
    }
  }
  return sliced;
}

export function markBridgeNotificationsRead(notificationId?: string): NasNotification[] {
  const current = readBridgeNotifications();
  const next = current.map((n) =>
    !notificationId || n.id === notificationId ? { ...n, read: true } : n
  );
  return saveBridgeNotifications(next);
}

export function deleteBridgeNotification(notificationId: string): NasNotification[] {
  return saveBridgeNotifications(
    readBridgeNotifications().filter((n) => n.id !== notificationId)
  );
}

export function deleteAllBridgeNotifications(): NasNotification[] {
  return saveBridgeNotifications([]);
}

export function deleteBridgeNotificationsBatch(notificationIds: string[]): NasNotification[] {
  const del = new Set(notificationIds);
  return saveBridgeNotifications(readBridgeNotifications().filter((n) => !del.has(n.id)));
}

function appendUniqueNotifications(incoming: NasNotification[]): NasNotification[] {
  const existing = readBridgeNotifications();
  const existingIds = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((a) => !existingIds.has(a.id));
  return saveBridgeNotifications([...fresh, ...existing]);
}

// ============================================================================
// FILMSTARTS DE / AT (Live Scraping + iTunes DE/AT RSS)
// ============================================================================

export function parseFilmstartsHtml(html: string): Array<{
  title: string;
  releaseDate: string;
  genre: string;
  director?: string;
  cast: string[];
  synopsis: string;
  posterUrl?: string;
  sourceUrl?: string;
}> {
  if (!html || typeof DOMParser === 'undefined') return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = Array.from(doc.querySelectorAll('.entity-card, .card.entity-card-list, li.mdl'));
    const results: Array<{
      title: string;
      releaseDate: string;
      genre: string;
      director?: string;
      cast: string[];
      synopsis: string;
      posterUrl?: string;
      sourceUrl?: string;
    }> = [];
    const seen = new Set<string>();
    const todayIso = new Date().toISOString().slice(0, 10);

    for (const card of cards) {
      const titleEl = card.querySelector('.meta-title-link, h2 a, a.meta-title-link');
      const title = titleEl?.textContent?.trim() || '';
      if (!title) continue;
      const key = normalizeTitleKey(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const href = titleEl?.getAttribute('href') || '';
      const sourceUrl = href.startsWith('http')
        ? href
        : href.startsWith('/')
          ? `https://www.filmstarts.de${href}`
          : undefined;

      const dateText =
        card.querySelector('.date, .meta-body-info .date')?.textContent || card.textContent || '';
      const releaseDate = parseGermanDateToIso(dateText) || todayIso;

      const genreText = Array.from(card.querySelectorAll('.meta-body-info span'))
        .map((el) => el.textContent?.trim() || '')
        .filter((t) => t && !/\d{4}|Std\.|Min\./i.test(t) && t !== '/')
        .slice(0, 3)
        .join(', ');

      const dirText =
        card.querySelector('.meta-body-direction .blue-link, .meta-body-direction a')
          ?.textContent?.trim() || undefined;
      const castList = Array.from(card.querySelectorAll('.meta-body-actor .blue-link, .meta-body-actor a'))
        .map((el) => el.textContent?.trim() || '')
        .filter(Boolean)
        .slice(0, 4);
      const synopsis =
        card.querySelector('.synopsis, .content-txt')?.textContent?.trim() ||
        'Aktueller Kinostart in Deutschland (Filmstarts.de).';

      const img = card.querySelector('img');
      let posterUrl =
        img?.getAttribute('data-src') ||
        img?.getAttribute('src') ||
        undefined;
      if (posterUrl && (posterUrl.startsWith('data:image/gif') || posterUrl.includes('empty.gif'))) {
        posterUrl = img?.getAttribute('data-src') || undefined;
      }
      if (posterUrl && posterUrl.startsWith('//')) {
        posterUrl = `https:${posterUrl}`;
      }

      results.push({
        title,
        releaseDate,
        genre: genreText || 'Kino & Spielfilm',
        director: dirText,
        cast: castList,
        synopsis,
        posterUrl,
        sourceUrl,
      });
    }
    return results.slice(0, 30);
  } catch {
    return [];
  }
}

export function parseUncutAtHtml(html: string): Array<{
  title: string;
  releaseDate: string;
  synopsis: string;
  posterUrl?: string;
  sourceUrl?: string;
}> {
  if (!html || typeof DOMParser === 'undefined') return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = Array.from(doc.querySelectorAll('a[href*="/movies/film.php"]'));
    const results: Array<{
      title: string;
      releaseDate: string;
      synopsis: string;
      posterUrl?: string;
      sourceUrl?: string;
    }> = [];
    const seen = new Set<string>();
    const todayIso = new Date().toISOString().slice(0, 10);

    for (const a of links) {
      const title = a.textContent?.trim() || '';
      if (!title || title.length < 2 || /^(mehr|details|trailer)$/i.test(title)) continue;
      const key = normalizeTitleKey(title);
      if (seen.has(key)) continue;
      seen.add(key);

      const containerText = a.closest('tr, li, div')?.textContent || '';
      const isoDate = parseGermanDateToIso(containerText) || todayIso;
      const href = a.getAttribute('href') || '';
      const sourceUrl = href.startsWith('http')
        ? href
        : href.startsWith('/')
          ? `https://www.uncut.at${href}`
          : `https://www.uncut.at/movies/${href}`;
      const img = a.closest('tr, li, div')?.querySelector('img');
      const rawPoster = img?.getAttribute('src');
      const posterUrl = rawPoster
        ? rawPoster.startsWith('http')
          ? rawPoster
          : `https://www.uncut.at${rawPoster.startsWith('/') ? rawPoster : `/${rawPoster}`}`
        : undefined;

      results.push({
        title,
        releaseDate: isoDate,
        synopsis: 'Aktueller Kinostart in Österreich (Uncut.at).',
        posterUrl,
        sourceUrl,
      });
    }
    return results.slice(0, 20);
  } catch {
    return [];
  }
}

interface ItunesRssFeed {
  feed?: {
    entry?: Array<{
      'im:name'?: { label?: string };
      'im:image'?: Array<{ label?: string }>;
      'im:releaseDate'?: { label?: string };
      'im:artist'?: { label?: string };
      category?: { attributes?: { label?: string } };
      summary?: { label?: string };
      id?: { label?: string };
    }>;
  };
}

function matchFilmOnNas(title: string, libraryItems: NasMediaItem[]): FilmStartRelease['nasMatch'] {
  const key = normalizeTitleKey(title);
  if (!key) return { availableOnNas: false, statusLabel: 'Nicht auf dem NAS' };
  const matched = libraryItems.find((item) => {
    if (item.kind !== 'movie' && item.kind !== 'video') return false;
    const itemKey = normalizeTitleKey(cleanMediaTitleForLookup(item.title).query);
    return itemKey === key || (itemKey.length >= 4 && (itemKey.includes(key) || key.includes(itemKey)));
  });
  if (!matched) {
    return { availableOnNas: false, statusLabel: 'Noch nicht auf dem NAS' };
  }
  return {
    availableOnNas: true,
    nasMediaId: matched.id,
    nasTitle: matched.title,
    nasKind: matched.kind,
    nasPath: matched.nasPath,
    codec: matched.codec,
    year: matched.year,
    statusLabel: 'Bereits auf deinem NAS verfügbar',
  };
}

function applyFilmPrefsAndAlerts(
  rawReleases: FilmStartRelease[],
  libraryItems: NasMediaItem[],
  notificationMode: FilmNotificationMode
): { releases: FilmStartRelease[]; alerts: NasNotification[] } {
  const prefs = readFavoritePrefs(BRIDGE_FILM_PREFS_KEY);
  const pinnedSet = new Set(prefs.pinned.map(normalizeTitleKey));
  const mutedSet = new Set(prefs.muted.map(normalizeTitleKey));
  const newAlerts: NasNotification[] = [];

  const updated = rawReleases.map((rel) => {
    const key = normalizeTitleKey(rel.title);
    const isMuted = mutedSet.has(key);
    const isFav = !isMuted && pinnedSet.has(key);
    const nasMatch = matchFilmOnNas(rel.title, libraryItems);

    if (rel.isReleasedNow && !isMuted && (notificationMode === 'all' || isFav)) {
      newAlerts.push({
        id: `film-alert-${rel.id}`,
        seriesTitle: rel.title,
        info: `${rel.channel} (${rel.region}) gestartet · ${rel.providerOrDistributor}`,
        provider: rel.providerOrDistributor || 'Filmstarts',
        releaseDate: rel.releaseDate,
        releaseId: rel.id,
        createdAt: new Date().toISOString(),
        read: false,
        triggerType: 'film_favorite_start',
      });
    }

    return {
      ...rel,
      nasMatch,
      favorite: {
        isFavorite: isFav,
        source: isFav ? ('manual' as const) : ('none' as const),
        reason: isFav
          ? 'Als Film-Favorit vorgemerkt'
          : isMuted
            ? 'Benachrichtigungen für diesen Titel stummgeschaltet'
            : 'Nicht favorisiert',
      },
    };
  });

  const alerts = newAlerts.length > 0 ? appendUniqueNotifications(newAlerts) : readBridgeNotifications();
  return { releases: updated, alerts };
}

export function readCachedFilmstartsBridge(
  libraryItems: NasMediaItem[],
  notificationMode: FilmNotificationMode
): FilmStartsResponse | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BRIDGE_FILMSTARTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FilmStartsResponse>;
    if (!Array.isArray(parsed.releases) || parsed.releases.length === 0) return null;
    const applied = applyFilmPrefsAndAlerts(parsed.releases, libraryItems, notificationMode);
    return {
      releases: applied.releases,
      alerts: applied.alerts,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      lastFetchedAt: parsed.lastFetchedAt ?? null,
      fetchMethod: parsed.fetchMethod ?? 'cache',
      fetchWarning: parsed.fetchWarning ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchLiveFilmstartsBridge(
  libraryItems: NasMediaItem[],
  notificationMode: FilmNotificationMode = 'favorites'
): Promise<FilmStartsResponse> {
  const [deHtmlRes, atHtmlRes, itunesDe, itunesAt] = await Promise.all([
    fetchExternalText('https://www.filmstarts.de/filme/vorschau/kinostarts/', 8000),
    fetchExternalText('https://www.uncut.at/movies/filmstarts.php', 8000),
    fetchExternalJson<ItunesRssFeed>('https://itunes.apple.com/de/rss/topmovies/limit=25/json', 7500),
    fetchExternalJson<ItunesRssFeed>('https://itunes.apple.com/at/rss/topmovies/limit=15/json', 7500),
  ]);

  const byKey = new Map<string, FilmStartRelease>();
  const todayIso = new Date().toISOString().slice(0, 10);
  const sources: FilmStartsResponse['sources'] = [];

  if (deHtmlRes.ok) {
    const deKino = parseFilmstartsHtml(deHtmlRes.text);
    if (deKino.length > 0) {
      sources.push({ title: 'Filmstarts.de Kinostarts (DE)', uri: 'https://www.filmstarts.de/filme/vorschau/kinostarts/' });
    }
    for (const item of deKino) {
      const k = normalizeTitleKey(item.title);
      byKey.set(k, {
        id: `film-de-${k.replace(/\s+/g, '-').slice(0, 32)}`,
        title: item.title,
        releaseDate: item.releaseDate,
        releaseDateDE: item.releaseDate,
        region: 'DE',
        channel: 'Kino',
        providerOrDistributor: item.director ? `Kino (Regie: ${item.director})` : 'Deutscher Kinoverleih',
        genre: item.genre,
        director: item.director,
        cast: item.cast,
        synopsis: item.synopsis,
        coverUrl: item.posterUrl,
        posterUrl: item.posterUrl,
        sourceUrl: item.sourceUrl,
        sourceLabel: 'Filmstarts.de',
        isReleasedNow: item.releaseDate <= todayIso,
        nasMatch: { availableOnNas: false, statusLabel: 'Prüfe…' },
        favorite: { isFavorite: false, source: 'none', reason: '' },
      });
    }
  }

  if (atHtmlRes.ok) {
    const atKino = parseUncutAtHtml(atHtmlRes.text);
    if (atKino.length > 0) {
      sources.push({ title: 'Uncut.at Filmstarts (AT)', uri: 'https://www.uncut.at/movies/filmstarts.php' });
    }
    for (const item of atKino) {
      const k = normalizeTitleKey(item.title);
      const existing = byKey.get(k);
      if (existing) {
        existing.region = 'DE/AT';
        existing.releaseDateAT = item.releaseDate;
        if (!existing.coverUrl && item.posterUrl) {
          existing.coverUrl = item.posterUrl;
          existing.posterUrl = item.posterUrl;
        }
      } else {
        byKey.set(k, {
          id: `film-at-${k.replace(/\s+/g, '-').slice(0, 32)}`,
          title: item.title,
          releaseDate: item.releaseDate,
          releaseDateAT: item.releaseDate,
          region: 'AT',
          channel: 'Kino',
          providerOrDistributor: 'Österreichischer Kinostart',
          genre: 'Kino & Spielfilm',
          cast: [],
          synopsis: item.synopsis,
          coverUrl: item.posterUrl,
          posterUrl: item.posterUrl,
          sourceUrl: item.sourceUrl,
          sourceLabel: 'Uncut.at',
          isReleasedNow: item.releaseDate <= todayIso,
          nasMatch: { availableOnNas: false, statusLabel: 'Prüfe…' },
          favorite: { isFavorite: false, source: 'none', reason: '' },
        });
      }
    }
  }

  const mergeItunesEntries = (feed: ItunesRssFeed | null, region: 'DE' | 'AT', label: string) => {
    const entries = feed?.feed?.entry ?? [];
    if (entries.length > 0) {
      sources.push({ title: label, uri: `https://www.apple.com/${region.toLowerCase()}/itunes/` });
    }
    for (const entry of entries) {
      const title = entry['im:name']?.label?.trim();
      if (!title) continue;
      const k = normalizeTitleKey(title);
      const rawDate = entry['im:releaseDate']?.label?.slice(0, 10) || todayIso;
      const imgs = entry['im:image'] ?? [];
      const bestImg = upscaleArtworkUrl(imgs[imgs.length - 1]?.label);
      const genre = entry.category?.attributes?.label || 'Spielfilm';
      const summary = stripHtmlTags(entry.summary?.label) || `${title} aktuell im Streaming / Store (${region}).`;
      const existing = byKey.get(k);
      if (existing) {
        if (existing.region !== region && existing.region !== 'DE/AT') {
          existing.region = 'DE/AT';
        }
        existing.channel = existing.channel === 'Kino' ? 'Kino & Streaming' : existing.channel;
        if (!existing.coverUrl && bestImg) {
          existing.coverUrl = bestImg;
          existing.posterUrl = bestImg;
        }
        if (summary.length > existing.synopsis.length) {
          existing.synopsis = summary;
        }
      } else {
        byKey.set(k, {
          id: `film-stream-${k.replace(/\s+/g, '-').slice(0, 32)}`,
          title,
          releaseDate: rawDate,
          ...(region === 'DE' ? { releaseDateDE: rawDate } : { releaseDateAT: rawDate }),
          region,
          channel: 'Streaming',
          providerOrDistributor: 'Apple TV / Digital-Premiere',
          genre,
          director: entry['im:artist']?.label?.trim(),
          cast: [],
          synopsis: summary,
          coverUrl: bestImg,
          posterUrl: bestImg,
          sourceUrl: entry.id?.label,
          sourceLabel: label,
          isReleasedNow: rawDate <= todayIso,
          nasMatch: { availableOnNas: false, statusLabel: 'Prüfe…' },
          favorite: { isFavorite: false, source: 'none', reason: '' },
        });
      }
    }
  };

  mergeItunesEntries(itunesDe, 'DE', 'iTunes Store Charts (DE)');
  mergeItunesEntries(itunesAt, 'AT', 'iTunes Store Charts (AT)');

  const list = Array.from(byKey.values()).sort((a, b) =>
    b.releaseDate.localeCompare(a.releaseDate)
  );

  if (list.length === 0) {
    const cached = readCachedFilmstartsBridge(libraryItems, notificationMode);
    if (cached) {
      return {
        ...cached,
        fetchMethod: 'cache',
        fetchWarning:
          'Keine direkte Internetverbindung zu den Filmportalen — zeige zuletzt gespeicherte Filmstarts.',
      };
    }
    return {
      releases: [],
      alerts: readBridgeNotifications(),
      sources: [],
      lastFetchedAt: null,
      fetchMethod: 'live-web',
      fetchWarning:
        'Filmstarts konnten aktuell nicht aus dem Internet geladen werden (Internetzugriff/WLAN prüfen).',
    };
  }

  const applied = applyFilmPrefsAndAlerts(list, libraryItems, notificationMode);
  const response: FilmStartsResponse = {
    releases: applied.releases,
    alerts: applied.alerts,
    sources,
    lastFetchedAt: new Date().toISOString(),
    fetchMethod: 'live-web',
    fetchWarning: null,
  };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(BRIDGE_FILMSTARTS_CACHE_KEY, JSON.stringify(response));
    } catch {
      // ignore
    }
  }
  return response;
}

export function toggleFilmFavoriteBridge(
  filmTitle: string,
  action: 'pin' | 'unpin' | 'mute',
  libraryItems: NasMediaItem[],
  notificationMode: FilmNotificationMode
): FilmStartsResponse {
  const key = normalizeTitleKey(filmTitle);
  const prefs = readFavoritePrefs(BRIDGE_FILM_PREFS_KEY);
  const pinned = new Set(prefs.pinned);
  const muted = new Set(prefs.muted);

  if (action === 'pin') {
    muted.delete(key);
    pinned.add(key);
  } else if (action === 'unpin') {
    pinned.delete(key);
  } else if (action === 'mute') {
    pinned.delete(key);
    muted.add(key);
  }
  saveFavoritePrefs(BRIDGE_FILM_PREFS_KEY, {
    pinned: Array.from(pinned),
    muted: Array.from(muted),
  });

  const cached = readCachedFilmstartsBridge(libraryItems, notificationMode);
  if (cached) {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(BRIDGE_FILMSTARTS_CACHE_KEY, JSON.stringify(cached));
      } catch {
        // ignore
      }
    }
    return cached;
  }
  return {
    releases: [],
    alerts: readBridgeNotifications(),
    sources: [],
    lastFetchedAt: null,
    fetchMethod: 'cache',
  };
}

export function simulateFilmReleaseBridge(
  filmId: string,
  libraryItems: NasMediaItem[],
  notificationMode: FilmNotificationMode
): FilmStartsResponse | null {
  const cached = readCachedFilmstartsBridge(libraryItems, notificationMode);
  if (!cached) return null;
  const target = cached.releases.find((r) => r.id === filmId);
  if (!target) return cached;

  const updatedReleases = cached.releases.map((r) =>
    r.id === filmId ? { ...r, isReleasedNow: true } : r
  );
  const alert: NasNotification = {
    id: `film-sim-${filmId}-${Date.now()}`,
    seriesTitle: target.title,
    info: `Kinostart / Release jetzt verfügbar: ${target.channel} (${target.region})`,
    provider: target.providerOrDistributor,
    releaseDate: target.releaseDate,
    releaseId: target.id,
    createdAt: new Date().toISOString(),
    read: false,
    triggerType: 'film_favorite_start',
  };
  const alerts = appendUniqueNotifications([alert]);
  const next: FilmStartsResponse = {
    ...cached,
    releases: updatedReleases,
    alerts,
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(BRIDGE_FILMSTARTS_CACHE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  return next;
}

// ============================================================================
// SERIENKALENDER & ONLINE-SERIENSUCHE (TVMaze + iTunes Store DE)
// ============================================================================

interface TvMazeShow {
  id: number;
  name?: string;
  genres?: string[];
  status?: string;
  premiered?: string;
  summary?: string;
  image?: { medium?: string; original?: string };
  network?: { name?: string };
  webChannel?: { name?: string };
  _embedded?: {
    cast?: Array<{ person?: { name?: string } }>;
  };
}

interface TvMazeEpisodeSchedule {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  summary?: string;
  show?: TvMazeShow;
  _embedded?: { show?: TvMazeShow };
}

function mapTvMazeStatus(status?: string): SeriesProductionStatus {
  const s = (status || '').toLowerCase();
  if (s === 'ended') return 'ended';
  if (s.includes('cancel')) return 'canceled';
  return 'returning';
}

function readManualSeriesBridge(): CalendarRelease[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BRIDGE_SERIES_MANUAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CalendarRelease[]) : [];
  } catch {
    return [];
  }
}

function saveManualSeriesBridge(list: CalendarRelease[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BRIDGE_SERIES_MANUAL_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

function matchSeriesOnNas(seriesTitle: string, libraryItems: NasMediaItem[]): CalendarRelease['nasMatch'] {
  const key = normalizeTitleKey(seriesTitle);
  const matches = libraryItems.filter((item) => {
    if (item.kind !== 'series') return false;
    const ik = normalizeTitleKey(cleanMediaTitleForLookup(item.title).query);
    return ik === key || (ik.length >= 4 && (ik.includes(key) || key.includes(ik)));
  });
  if (matches.length === 0) {
    return {
      matched: false,
      availableOnNas: false,
      seriesOnNas: false,
      seasonOnNas: false,
      episodeOnNas: false,
      availableSeasonsOnNas: [],
      seasonEpisodesOnNasCount: 0,
      episodesWatchedOnNas: 0,
      statusLabel: 'Nicht auf dem NAS',
    };
  }
  const first = matches[0];
  return {
    matched: true,
    availableOnNas: true,
    seriesOnNas: true,
    seasonOnNas: true,
    episodeOnNas: false,
    availableSeasonsOnNas: [1],
    seasonEpisodesOnNasCount: matches.length,
    nasMediaId: first.id,
    nasTitle: first.title,
    nasPath: first.nasPath,
    codec: first.codec,
    episodesWatchedOnNas: first.episodesWatchedCount ?? 0,
    statusLabel: `${matches.length} Datei(en) bereits auf deinem NAS`,
  };
}

function applySeriesPrefsAndAlerts(
  rawReleases: CalendarRelease[],
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode
): { releases: CalendarRelease[]; alerts: NasNotification[] } {
  const prefs = readFavoritePrefs(BRIDGE_SERIES_PREFS_KEY);
  const pinnedSet = new Set(prefs.pinned.map(normalizeTitleKey));
  const mutedSet = new Set(prefs.muted.map(normalizeTitleKey));
  const newAlerts: NasNotification[] = [];

  const updated = rawReleases.map((rel) => {
    const key = normalizeTitleKey(rel.seriesTitle);
    const nasMatch = matchSeriesOnNas(rel.seriesTitle, libraryItems);
    const isMuted = mutedSet.has(key);
    const isManualFav = pinnedSet.has(key);
    const isAutoFav = !isManualFav && nasMatch.availableOnNas;
    const isFav = !isMuted && (isManualFav || isAutoFav);

    const isNewSeries = rel.seasonNumber === 1 && rel.episodeNumber <= 1;
    const modeMatchesScope =
      mode === 'all' ||
      (mode === 'all_new_series' && isNewSeries) ||
      (mode === 'all_new_episodes' && !isNewSeries) ||
      (mode === 'favorites_all' && isFav) ||
      (mode === 'favorites_new_series' && isFav && isNewSeries) ||
      (mode === 'favorites_new_episodes' && isFav && !isNewSeries);

    if (rel.isAvailableNow && !isMuted && modeMatchesScope) {
      newAlerts.push({
        id: `series-alert-${rel.id}`,
        seriesTitle: rel.seriesTitle,
        info: `S${String(rel.seasonNumber).padStart(2, '0')}E${String(rel.episodeNumber).padStart(2, '0')} · ${rel.episodeTitle}`,
        provider: rel.provider,
        releaseDate: rel.releaseDate,
        releaseId: rel.id,
        createdAt: new Date().toISOString(),
        read: false,
        triggerType: isManualFav ? 'manual_favorite' : 'auto_favorite',
      });
    }

    return {
      ...rel,
      nasMatch,
      favorite: {
        isFavorite: isFav,
        source: isManualFav ? ('manual' as const) : isAutoFav ? ('auto' as const) : ('none' as const),
        reason: isMuted
          ? 'Benachrichtigungen deaktiviert'
          : isManualFav
            ? 'Manuell als Serien-Favorit markiert'
            : isAutoFav
              ? 'Automatisch favorisiert (Serie auf NAS vorhanden)'
              : 'Nicht favorisiert',
      },
    };
  });

  const alerts = newAlerts.length > 0 ? appendUniqueNotifications(newAlerts) : readBridgeNotifications();
  return { releases: updated, alerts };
}

export function readCachedSeriesCalendarBridge(
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode = 'favorites_all'
): SeriesCalendarResponse {
  const manual = readManualSeriesBridge();
  let cachedList: CalendarRelease[] = [];
  let lastFetchedAt: string | null = null;
  let sources: FilmGroundSource[] = [];
  let fetchMethod: SeriesCalendarResponse['fetchMethod'] = 'cache';
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(BRIDGE_SERIES_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as
          | CalendarRelease[]
          | {
              releases?: CalendarRelease[];
              lastFetchedAt?: string | null;
              sources?: FilmGroundSource[];
              fetchMethod?: SeriesCalendarResponse['fetchMethod'];
            };
        if (Array.isArray(parsed)) {
          cachedList = parsed;
        } else if (parsed && Array.isArray(parsed.releases)) {
          cachedList = parsed.releases;
          lastFetchedAt = parsed.lastFetchedAt ?? null;
          sources = Array.isArray(parsed.sources) ? parsed.sources : [];
          fetchMethod = parsed.fetchMethod ?? 'cache';
        }
      }
    } catch {
      // ignore
    }
  }
  const merged = new Map<string, CalendarRelease>();
  for (const item of [...manual, ...cachedList]) {
    if (item?.id && !merged.has(item.id)) merged.set(item.id, item);
  }
  const applied = applySeriesPrefsAndAlerts(Array.from(merged.values()), libraryItems, mode);
  return {
    ...applied,
    sources,
    lastFetchedAt,
    fetchMethod,
    fetchWarning: null,
  };
}

export async function fetchLiveSeriesCalendarBridge(
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode = 'favorites_all'
): Promise<SeriesCalendarResponse> {
  const todayDate = new Date();
  const todayIso = todayDate.toISOString().slice(0, 10);
  const dateOffsets = [0, 1, 2, 3].map((offset) => {
    const d = new Date(todayDate.getTime() + offset * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });

  const scheduleResults = await Promise.all(
    dateOffsets.flatMap((isoDate) => [
      fetchExternalJson<TvMazeEpisodeSchedule[]>(
        `https://api.tvmaze.com/schedule?country=DE&date=${isoDate}`,
        8000
      ),
      fetchExternalJson<TvMazeEpisodeSchedule[]>(
        `https://api.tvmaze.com/schedule/web?country=DE&date=${isoDate}`,
        8000
      ),
    ])
  );

  // Globale Streaming-Neustarts (Netflix, Prime Video, Disney+, Apple TV+, Paramount+, Crunchyroll) für heute prüfen
  const globalWebToday = await fetchExternalJson<TvMazeEpisodeSchedule[]>(
    `https://api.tvmaze.com/schedule/web?date=${todayIso}`,
    8000
  );

  const byKey = new Map<string, CalendarRelease>();
  for (const m of readManualSeriesBridge()) {
    byKey.set(m.id, m);
  }

  const deEntries = scheduleResults.flatMap((arr) => arr ?? []);
  const globalStreamingRegex =
    /netflix|amazon|prime video|disney\+|apple tv\+|paramount\+|crunchyroll|sky|hbo|max|discovery\+/i;
  const globalEntries = (globalWebToday ?? []).filter((ep) => {
    const show = ep.show ?? ep._embedded?.show;
    const wc = show?.webChannel?.name || '';
    return globalStreamingRegex.test(wc);
  });

  const allEntries = [...deEntries, ...globalEntries];
  for (const ep of allEntries) {
    const show = ep.show ?? ep._embedded?.show;
    const title = show?.name?.trim();
    if (!title) continue;
    const seasonNumber = Math.max(1, Number(ep.season ?? 1));
    const episodeNumber = Math.max(1, Number(ep.number ?? 1));
    const releaseDate = (ep.airdate || todayIso).slice(0, 10);
    const id = `tvmaze-${show?.id ?? normalizeTitleKey(title)}-s${seasonNumber}e${episodeNumber}`;
    if (byKey.has(id)) continue;

    const isWeb = Boolean(show?.webChannel?.name);
    const netName = show?.webChannel?.name || show?.network?.name || '';
    const provider = mapNetworkToProviderDE(netName, isWeb);
    const genre = show?.genres && show.genres.length > 0 ? show.genres.slice(0, 2).join(', ') : 'Serie';
    const synopsis =
      stripHtmlTags(ep.summary) ||
      stripHtmlTags(show?.summary) ||
      `${title} — Staffel ${seasonNumber}, Folge ${episodeNumber} (${provider}).`;

    byKey.set(id, {
      id,
      tmdbId: Number(show?.id ?? 0),
      seriesTitle: title,
      seasonNumber,
      episodeNumber,
      episodeTitle: ep.name?.trim() || `Folge ${episodeNumber}`,
      releaseDate,
      region: 'DE',
      provider,
      genre,
      coverUrl: upscaleArtworkUrl(show?.image?.original || show?.image?.medium),
      synopsis,
      cast: [],
      isSeasonPremiere: episodeNumber === 1,
      isAvailableNow: releaseDate <= todayIso,
      fsk: 12,
      seriesStatus: mapTvMazeStatus(show?.status),
      seriesStatusDetail: show?.status || undefined,
      nasMatch: {
        matched: false,
        availableOnNas: false,
        seriesOnNas: false,
        seasonOnNas: false,
        episodeOnNas: false,
        availableSeasonsOnNas: [],
        seasonEpisodesOnNasCount: 0,
        episodesWatchedOnNas: 0,
        statusLabel: 'Nicht auf dem NAS',
      },
      favorite: { isFavorite: false, source: 'none', reason: '' },
    });
    if (byKey.size >= 120) break;
  }

  // NAS-Serien zusätzlich bei TVMaze abgleichen
  const nasSeriesTitles = Array.from(
    new Set(
      libraryItems
        .filter((i) => i.kind === 'series')
        .map((i) => cleanMediaTitleForLookup(i.title).query)
        .filter((t) => t.length >= 2)
    )
  ).slice(0, 8);

  await Promise.allSettled(
    nasSeriesTitles.map(async (seriesName) => {
      const hit = await fetchExternalJson<TvMazeShow>(
        `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(seriesName)}`,
        6000
      );
      if (!hit?.name) return;
      const id = `tvmaze-nas-${hit.id}`;
      if (byKey.has(id)) return;
      const isWeb = Boolean(hit.webChannel?.name);
      const netName = hit.webChannel?.name || hit.network?.name || '';
      byKey.set(id, {
        id,
        tmdbId: hit.id,
        seriesTitle: hit.name,
        seasonNumber: 1,
        episodeNumber: 1,
        episodeTitle: 'NAS-Serie (Serien-Info)',
        releaseDate: (hit.premiered || todayIso).slice(0, 10),
        region: 'DE',
        provider: mapNetworkToProviderDE(netName, isWeb),
        genre: hit.genres?.slice(0, 2).join(', ') || 'Serie',
        coverUrl: upscaleArtworkUrl(hit.image?.original || hit.image?.medium),
        synopsis: stripHtmlTags(hit.summary) || `${hit.name} auf deinem NAS.`,
        cast: [],
        isSeasonPremiere: false,
        isAvailableNow: true,
        fsk: 12,
        seriesStatus: mapTvMazeStatus(hit.status),
        nasMatch: {
          matched: true,
          availableOnNas: true,
          seriesOnNas: true,
          seasonOnNas: true,
          episodeOnNas: false,
          availableSeasonsOnNas: [1],
          seasonEpisodesOnNasCount: 1,
          episodesWatchedOnNas: 0,
          statusLabel: 'Auf dem NAS vorhanden',
        },
        favorite: { isFavorite: true, source: 'auto', reason: 'Serie auf dem NAS' },
      });
    })
  );

  const rawList = Array.from(byKey.values()).sort((a, b) =>
    a.releaseDate.localeCompare(b.releaseDate)
  );
  const sources: FilmGroundSource[] = [
    {
      title: 'TVMaze Deutschland TV-Programm (Free-TV & Pay-TV)',
      uri: `https://api.tvmaze.com/schedule?country=DE&date=${todayIso}`,
    },
    {
      title: 'TVMaze Streaming & Mediatheken (DE)',
      uri: `https://api.tvmaze.com/schedule/web?country=DE&date=${todayIso}`,
    },
  ];
  const lastFetchedAt = new Date().toISOString();

  if (rawList.length > 0 && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        BRIDGE_SERIES_CACHE_KEY,
        JSON.stringify({
          releases: rawList,
          sources,
          lastFetchedAt,
          fetchMethod: 'live-web',
        })
      );
    } catch {
      // ignore
    }
  }
  if (rawList.length === 0) {
    const cached = readCachedSeriesCalendarBridge(libraryItems, mode);
    return {
      ...cached,
      fetchWarning:
        'Serienkalender konnte aktuell nicht aus dem Internet geladen werden (Internetzugriff prüfen).',
    };
  }
  const applied = applySeriesPrefsAndAlerts(rawList, libraryItems, mode);
  return {
    ...applied,
    sources,
    lastFetchedAt,
    fetchMethod: 'live-web',
    fetchWarning: null,
  };
}

export async function searchSeriesOnlineBridge(query: string): Promise<SeriesLookupCandidate[]> {
  const clean = query.trim();
  if (!clean) return [];

  interface TvMazeSearchHit {
    score?: number;
    show?: TvMazeShow;
  }
  interface ItunesSearchResp {
    results?: Array<{
      collectionId?: number;
      collectionName?: string;
      artistName?: string;
      primaryGenreName?: string;
      releaseDate?: string;
      artworkUrl100?: string;
      longDescription?: string;
      shortDescription?: string;
    }>;
  }

  const [tvmazeHits, itunesResp] = await Promise.all([
    fetchExternalJson<TvMazeSearchHit[]>(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(clean)}`,
      7000
    ),
    fetchExternalJson<ItunesSearchResp>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&country=de&entity=tvSeason&limit=8`,
      7000
    ),
  ]);

  const candidates: SeriesLookupCandidate[] = [];
  const seen = new Set<string>();
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const hit of tvmazeHits ?? []) {
    const show = hit.show;
    if (!show?.name) continue;
    const key = normalizeTitleKey(show.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const isWeb = Boolean(show.webChannel?.name);
    const netName = show.webChannel?.name || show.network?.name || 'Streaming / TV';
    const yearNum = show.premiered ? Number(show.premiered.slice(0, 4)) : undefined;
    candidates.push({
      id: `tvmaze-${show.id}`,
      title: show.name,
      year: Number.isFinite(yearNum) ? yearNum : undefined,
      season: 1,
      episode: 1,
      episodeTitle: 'Neue Folge / Serienstart',
      releaseDate: (show.premiered || todayIso).slice(0, 10),
      provider: mapNetworkToProviderDE(netName, isWeb),
      networkLabel: netName,
      genre: show.genres?.slice(0, 2).join(', ') || 'Serie',
      synopsis: stripHtmlTags(show.summary) || `${show.name} (${netName}).`,
      cast: [],
      coverUrl: upscaleArtworkUrl(show.image?.original || show.image?.medium),
      seriesStatus: mapTvMazeStatus(show.status),
      fsk: 12,
      sourceLabel: 'TVMaze Live',
    });
  }

  for (const item of itunesResp?.results ?? []) {
    const rawName = (item.collectionName || item.artistName || '').replace(/,\s*Staffel\s*\d+/i, '').trim();
    if (!rawName) continue;
    const key = normalizeTitleKey(rawName);
    if (seen.has(key)) continue;
    seen.add(key);
    const yearNum = item.releaseDate ? Number(item.releaseDate.slice(0, 4)) : undefined;
    candidates.push({
      id: `itunes-tv-${item.collectionId ?? key}`,
      title: rawName,
      year: Number.isFinite(yearNum) ? yearNum : undefined,
      season: 1,
      episode: 1,
      episodeTitle: item.collectionName || 'Staffel 1',
      releaseDate: (item.releaseDate || todayIso).slice(0, 10),
      provider: 'Apple TV+',
      networkLabel: 'iTunes DE',
      genre: item.primaryGenreName || 'Serie',
      synopsis: stripHtmlTags(item.longDescription || item.shortDescription) || `${rawName} im Apple TV / iTunes Katalog.`,
      cast: [],
      coverUrl: upscaleArtworkUrl(item.artworkUrl100),
      seriesStatus: 'returning',
      fsk: 12,
      sourceLabel: 'Apple TV / iTunes DE',
    });
  }

  return candidates.slice(0, 15);
}

export function addManualSeriesBridge(
  input: {
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
  },
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode
): { releases: CalendarRelease[]; alerts: NasNotification[] } {
  const cleanTitle = input.title.trim();
  const id = `manual-${Date.now()}-${normalizeTitleKey(cleanTitle).replace(/\s+/g, '-').slice(0, 20)}`;
  const todayIso = new Date().toISOString().slice(0, 10);
  const releaseDate = (input.releaseDate || todayIso).slice(0, 10);

  const entry: CalendarRelease = {
    id,
    tmdbId: Math.floor(100000 + Math.random() * 800000),
    seriesTitle: cleanTitle,
    seasonNumber: input.season ?? 1,
    episodeNumber: input.episode ?? 1,
    episodeTitle: input.episodeTitle?.trim() || 'Neue Folge',
    releaseDate,
    region: 'DE',
    provider: input.provider || 'Netflix',
    genre: input.genre || 'Serie',
    coverUrl: input.coverUrl,
    synopsis: input.synopsis || `${cleanTitle} — manuell zum Serienkalender hinzugefügt.`,
    cast: input.cast ?? [],
    isSeasonPremiere: (input.episode ?? 1) === 1,
    isAvailableNow: releaseDate <= todayIso,
    fsk: input.fsk ?? 12,
    seriesStatus: input.seriesStatus ?? 'returning',
    nasMatch: matchSeriesOnNas(cleanTitle, libraryItems),
    favorite: {
      isFavorite: input.pinAsFavorite,
      source: input.pinAsFavorite ? 'manual' : 'none',
      reason: input.pinAsFavorite ? 'Manuell favorisiert' : 'Nicht favorisiert',
    },
  };

  if (input.pinAsFavorite) {
    const prefs = readFavoritePrefs(BRIDGE_SERIES_PREFS_KEY);
    const key = normalizeTitleKey(cleanTitle);
    if (!prefs.pinned.includes(key)) {
      prefs.pinned.push(key);
    }
    prefs.muted = prefs.muted.filter((m) => m !== key);
    saveFavoritePrefs(BRIDGE_SERIES_PREFS_KEY, prefs);
  }

  const manualList = readManualSeriesBridge();
  saveManualSeriesBridge([entry, ...manualList]);
  return readCachedSeriesCalendarBridge(libraryItems, mode);
}

export function deleteManualSeriesBridge(
  releaseId: string,
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode
): { releases: CalendarRelease[]; alerts: NasNotification[] } {
  saveManualSeriesBridge(readManualSeriesBridge().filter((r) => r.id !== releaseId));
  return readCachedSeriesCalendarBridge(libraryItems, mode);
}

export function toggleSeriesFavoriteBridge(
  seriesTitle: string,
  action: 'pin' | 'mute' | 'auto',
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode
): { releases: CalendarRelease[]; alerts: NasNotification[] } {
  const key = normalizeTitleKey(seriesTitle);
  const prefs = readFavoritePrefs(BRIDGE_SERIES_PREFS_KEY);
  const pinned = new Set(prefs.pinned);
  const muted = new Set(prefs.muted);
  if (action === 'pin') {
    muted.delete(key);
    pinned.add(key);
  } else if (action === 'mute') {
    pinned.delete(key);
    muted.add(key);
  } else {
    pinned.delete(key);
    muted.delete(key);
  }
  saveFavoritePrefs(BRIDGE_SERIES_PREFS_KEY, {
    pinned: Array.from(pinned),
    muted: Array.from(muted),
  });
  return readCachedSeriesCalendarBridge(libraryItems, mode);
}

export function simulateSeriesReleaseBridge(
  releaseId: string,
  libraryItems: NasMediaItem[],
  mode: CalendarNotificationMode
): { releases: CalendarRelease[]; alerts: NasNotification[] } {
  const cur = readCachedSeriesCalendarBridge(libraryItems, mode);
  const target = cur.releases.find((r) => r.id === releaseId);
  if (!target) return cur;

  const updated = cur.releases.map((r) =>
    r.id === releaseId ? { ...r, isAvailableNow: true } : r
  );
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(BRIDGE_SERIES_CACHE_KEY, JSON.stringify(updated));
    } catch {
      // ignore
    }
  }
  const alert: NasNotification = {
    id: `series-sim-${releaseId}-${Date.now()}`,
    seriesTitle: target.seriesTitle,
    info: `Neue Folge verfügbar: S${String(target.seasonNumber).padStart(2, '0')}E${String(target.episodeNumber).padStart(2, '0')} · ${target.episodeTitle}`,
    provider: target.provider,
    releaseDate: target.releaseDate,
    releaseId: target.id,
    createdAt: new Date().toISOString(),
    read: false,
    triggerType: 'manual_favorite',
  };
  const alerts = appendUniqueNotifications([alert]);
  return { releases: updated, alerts };
}

// ============================================================================
// INHALTSINFOS & COVER-ANREICHERUNG (Movies, Series, Music/MP3, Wikipedia DE)
// ============================================================================

interface WikipediaSummaryResp {
  title?: string;
  extract?: string;
  thumbnail?: { source?: string };
  originalimage?: { source?: string };
}

interface TvMazeShowImageEntry {
  id?: number;
  type?: string;
  main?: boolean;
  resolutions?: {
    original?: { url?: string };
    medium?: { url?: string };
  };
}

interface ItunesMovieOrTvResp {
  results?: Array<{
    collectionId?: number;
    trackId?: number;
    collectionName?: string;
    trackName?: string;
    artistName?: string;
    primaryGenreName?: string;
    releaseDate?: string;
    artworkUrl100?: string;
    longDescription?: string;
    shortDescription?: string;
    trackTimeMillis?: number;
    contentAdvisoryRating?: string;
  }>;
}

function dedupeCoverUrls(urls: Array<string | undefined | null>, limit = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || isPlaceholderCoverUrl(trimmed)) continue;
    const normalized = trimmed.replace(/^http:\/\//i, 'https://');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchTvMazeShowCovers(showId: number): Promise<string[]> {
  const images = await fetchExternalJson<TvMazeShowImageEntry[]>(
    `https://api.tvmaze.com/shows/${showId}/images`,
    5000
  );
  if (!Array.isArray(images)) return [];
  const sorted = [...images].sort((a, b) => {
    const score = (img: TvMazeShowImageEntry) =>
      (img.type === 'poster' ? 4 : img.type === 'banner' ? 1 : 2) + (img.main ? 3 : 0);
    return score(b) - score(a);
  });
  return dedupeCoverUrls(
    sorted.map((img) => upscaleArtworkUrl(img.resolutions?.original?.url || img.resolutions?.medium?.url)),
    10
  );
}

async function fetchWikipediaSummaryDE(query: string): Promise<WikipediaSummaryResp | null> {
  const searchUrl = `https://de.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
    query
  )}&limit=1&namespace=0&format=json&origin=*`;
  const searchRes = await fetchExternalJson<[string, string[]]>(searchUrl, 5000);
  const pageTitle = searchRes?.[1]?.[0];
  if (!pageTitle) return null;
  const summaryUrl = `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
  return fetchExternalJson<WikipediaSummaryResp>(summaryUrl, 5000);
}

export async function fetchExtraCoverCandidatesForMedia(
  rawTitle: string,
  kind: MediaKind
): Promise<string[]> {
  const cleanTitle =
    kind === 'series'
      ? parseSeriesEpisodeInfo(rawTitle).seriesTitle
      : cleanMediaTitleForLookup(rawTitle).query;
  if (!cleanTitle || cleanTitle.length < 2) return [];

  if (kind === 'series') {
    interface TvMazeSearchHit {
      show?: TvMazeShow;
    }
    const [tvHits, itunesTv, wiki] = await Promise.all([
      fetchExternalJson<TvMazeSearchHit[]>(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(cleanTitle)}`,
        6000
      ),
      fetchExternalJson<ItunesMovieOrTvResp>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&country=de&entity=tvSeason&limit=8`,
        6000
      ),
      fetchWikipediaSummaryDE(`${cleanTitle} Fernsehserie`),
    ]);
    const topShowId = tvHits?.[0]?.show?.id;
    const showGallery = topShowId ? await fetchTvMazeShowCovers(topShowId) : [];
    return dedupeCoverUrls(
      [
        ...showGallery,
        ...(tvHits ?? []).map((h) => upscaleArtworkUrl(h.show?.image?.original || h.show?.image?.medium)),
        ...(itunesTv?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
        wiki?.originalimage?.source,
        wiki?.thumbnail?.source,
      ],
      16
    );
  }

  if (kind === 'music') {
    const itunesMusic = await fetchExternalJson<ItunesMovieOrTvResp>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&country=de&media=music&limit=10`,
      6000
    );
    return dedupeCoverUrls(
      (itunesMusic?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      12
    );
  }

  const [itunesMovie, wiki] = await Promise.all([
    fetchExternalJson<ItunesMovieOrTvResp>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTitle)}&country=de&media=movie&limit=10`,
      6000
    ),
    fetchWikipediaSummaryDE(cleanTitle),
  ]);
  return dedupeCoverUrls(
    [
      ...(itunesMovie?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      wiki?.originalimage?.source,
      wiki?.thumbnail?.source,
    ],
    14
  );
}

export async function searchMediaMetadataOnline(
  query: string,
  kind: 'movie' | 'series'
): Promise<MediaOnlineSearchCandidate[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  if (kind === 'series') {
    // Bei Serien strikt nur nach dem kompletten Serientitel suchen (keine Episodennummern mitsenden)
    const seriesQuery = parseSeriesEpisodeInfo(trimmed).seriesTitle || cleanMediaTitleForLookup(trimmed).query;
    interface TvMazeSearchHit {
      show?: TvMazeShow;
    }
    const [tvHits, itunesTv, wiki] = await Promise.all([
      fetchExternalJson<TvMazeSearchHit[]>(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(seriesQuery)}`,
        7000
      ),
      fetchExternalJson<ItunesMovieOrTvResp>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(seriesQuery)}&country=de&entity=tvSeason&limit=8`,
        7000
      ),
      fetchWikipediaSummaryDE(`${seriesQuery} Fernsehserie`),
    ]);

    const topShowImages = tvHits?.[0]?.show?.id ? await fetchTvMazeShowCovers(tvHits[0].show.id) : [];
    const itunesCovers = dedupeCoverUrls(
      (itunesTv?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      8
    );

    const results: MediaOnlineSearchCandidate[] = [];
    const seenKeys = new Set<string>();

    for (const hit of tvHits ?? []) {
      const show = hit.show;
      if (!show?.name) continue;
      const k = normalizeTitleKey(show.name);
      const yr = show.premiered ? Number(show.premiered.slice(0, 4)) : undefined;
      const dedupeKey = `${k}-${yr ?? ''}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      const mainCover = upscaleArtworkUrl(show.image?.original || show.image?.medium);
      const covers = dedupeCoverUrls([
        mainCover,
        ...(hit === tvHits?.[0] ? topShowImages : []),
        ...itunesCovers,
      ]);
      results.push({
        id: `tvmaze-${show.id}`,
        title: show.name,
        kind: 'series',
        year: Number.isFinite(yr) ? yr : undefined,
        releaseDate: show.premiered ? show.premiered.slice(0, 10) : undefined,
        genre: show.genres?.slice(0, 2).join(', ') || 'Serie',
        synopsis:
          (hit === tvHits?.[0] && wiki?.extract) ||
          stripHtmlTags(show.summary) ||
          `${show.name} (${show.network?.name || show.webChannel?.name || 'TV/Streaming'}).`,
        coverUrl: covers[0] ?? mainCover,
        coverCandidates: covers,
        studio: show.network?.name || show.webChannel?.name || undefined,
        seriesStatus: mapTvMazeStatus(show.status),
        fsk: 12,
        sourceLabel: 'TVMaze',
      });
    }

    for (const item of itunesTv?.results ?? []) {
      const cleanName = (item.collectionName || item.artistName || '')
        .replace(/[,:\s-]*staffel\s*\d+/i, '')
        .replace(/[,:\s-]*season\s*\d+/i, '')
        .trim();
      if (!cleanName) continue;
      const yr = item.releaseDate ? Number(item.releaseDate.slice(0, 4)) : undefined;
      const dedupeKey = `itunes-${normalizeTitleKey(cleanName)}-${yr ?? ''}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      const mainCover = upscaleArtworkUrl(item.artworkUrl100);
      results.push({
        id: `itunes-series-${item.collectionId ?? dedupeKey}`,
        title: cleanName,
        kind: 'series',
        year: Number.isFinite(yr) ? yr : undefined,
        releaseDate: item.releaseDate ? item.releaseDate.slice(0, 10) : undefined,
        genre: item.primaryGenreName || 'Serie',
        synopsis:
          stripHtmlTags(item.longDescription || item.shortDescription) ||
          wiki?.extract ||
          `${cleanName} (Apple TV / iTunes DE).`,
        coverUrl: mainCover,
        coverCandidates: dedupeCoverUrls([mainCover, ...itunesCovers]),
        studio: 'Apple TV / iTunes DE',
        seriesStatus: 'returning',
        fsk: 12,
        sourceLabel: 'iTunes DE',
      });
    }

    if (results.length === 0 && wiki?.extract) {
      const wCovers = dedupeCoverUrls([wiki.originalimage?.source, wiki.thumbnail?.source]);
      results.push({
        id: `wiki-series-${Date.now()}`,
        title: wiki.title || seriesQuery,
        kind: 'series',
        genre: 'Serie',
        synopsis: wiki.extract,
        coverUrl: wCovers[0],
        coverCandidates: wCovers,
        sourceLabel: 'Wikipedia DE',
      });
    }

    return results.slice(0, 14);
  }

  // Filme-Suche (iTunes DE + Wikipedia DE)
  const { query: cleanQuery, yearHint } = cleanMediaTitleForLookup(trimmed);
  const qTerm = yearHint ? `${cleanQuery} ${yearHint}` : cleanQuery || trimmed;

  const [movieResp, wiki] = await Promise.all([
    fetchExternalJson<ItunesMovieOrTvResp>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(qTerm)}&country=de&media=movie&limit=10`,
      7000
    ),
    fetchWikipediaSummaryDE(`${cleanQuery || trimmed} Film`),
  ]);

  const allMovieCovers = dedupeCoverUrls(
    [
      ...(movieResp?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      wiki?.originalimage?.source,
      wiki?.thumbnail?.source,
    ],
    14
  );

  const results: MediaOnlineSearchCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const hit of movieResp?.results ?? []) {
    const title = (hit.trackName || '').trim();
    if (!title) continue;
    const yr = hit.releaseDate ? Number(hit.releaseDate.slice(0, 4)) : undefined;
    const key = `${normalizeTitleKey(title)}-${yr ?? ''}-${hit.artistName ?? ''}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const mainCover = upscaleArtworkUrl(hit.artworkUrl100);
    const durMin = hit.trackTimeMillis ? Math.max(5, Math.round(hit.trackTimeMillis / 60000)) : undefined;
    results.push({
      id: `itunes-movie-${hit.trackId ?? results.length}`,
      title,
      kind: 'movie',
      year: Number.isFinite(yr) ? yr : undefined,
      releaseDate: hit.releaseDate ? hit.releaseDate.slice(0, 10) : undefined,
      genre: hit.primaryGenreName || 'Film',
      synopsis:
        stripHtmlTags(hit.longDescription || hit.shortDescription) ||
        (results.length === 0 ? wiki?.extract : undefined) ||
        `${title}${hit.artistName ? ` · Regie: ${hit.artistName}` : ''}.`,
      coverUrl: mainCover,
      coverCandidates: dedupeCoverUrls([mainCover, ...allMovieCovers]),
      director: hit.artistName || undefined,
      durationMinutes: durMin,
      sourceLabel: 'iTunes DE',
    });
  }

  if (wiki?.extract) {
    const wCovers = dedupeCoverUrls([wiki.originalimage?.source, wiki.thumbnail?.source, ...allMovieCovers]);
    results.push({
      id: `wiki-movie-${Date.now()}`,
      title: (wiki.title || cleanQuery).replace(/\s*\(Film\)\s*$/i, '').trim(),
      kind: 'movie',
      genre: 'Film',
      synopsis: wiki.extract,
      coverUrl: wCovers[0],
      coverCandidates: wCovers,
      sourceLabel: 'Wikipedia DE',
    });
  }

  return results.slice(0, 14);
}

export async function enrichNasItemFromInternet(item: NasMediaItem): Promise<NasMediaItem> {
  const isSeries = item.kind === 'series';
  const rawSeriesTitle = isSeries
    ? parseSeriesEpisodeInfo(item.title || item.uploadedFileName || '', item.nasPath).seriesTitle
    : '';
  const { query, yearHint } = cleanMediaTitleForLookup(
    isSeries ? rawSeriesTitle || item.title : item.title || item.uploadedFileName || item.nasPath
  );
  if (!query || query.length < 2) return item;

  const hasCustomCover = Boolean(item.customCoverUrl);
  const needsCover = !hasCustomCover && isPlaceholderCoverUrl(item.coverUrl);
  const needsSynopsis =
    !item.synopsis ||
    item.synopsis.startsWith('Beim NAS-Ordnerscan') ||
    item.synopsis.startsWith('Beim Live-NAS-Ordnerscan') ||
    item.synopsis.startsWith('Direkt auf das NAS hochgeladene') ||
    item.synopsis.startsWith('Serie „');
  const needsMoreCovers = !item.coverCandidates || item.coverCandidates.length === 0;

  if (!needsCover && !needsSynopsis && !needsMoreCovers) return item;

  if (isSeries) {
    // Bei Serien strikt nur den kompletten Serientitel suchen
    let show = await fetchExternalJson<TvMazeShow>(
      `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}&embed=cast`,
      6500
    );
    if (!show) {
      const searchHits = await fetchExternalJson<Array<{ show?: TvMazeShow }>>(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`,
        6000
      );
      show = searchHits?.[0]?.show ?? null;
    }

    const [wiki, showGallery, itunesTv] = await Promise.all([
      needsSynopsis ? fetchWikipediaSummaryDE(`${query} Fernsehserie`) : Promise.resolve(null),
      show?.id ? fetchTvMazeShowCovers(show.id) : Promise.resolve([]),
      fetchExternalJson<ItunesMovieOrTvResp>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=de&entity=tvSeason&limit=4`,
        5500
      ),
    ]);

    const candidates = dedupeCoverUrls([
      item.customCoverUrl,
      ...(item.coverCandidates ?? []),
      upscaleArtworkUrl(show?.image?.original || show?.image?.medium),
      ...showGallery,
      ...(itunesTv?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      wiki?.originalimage?.source,
      wiki?.thumbnail?.source,
    ]);

    if (show) {
      const nextCover = needsCover ? candidates[0] ?? item.coverUrl : item.coverUrl;
      const castNames =
        show._embedded?.cast
          ?.map((c) => c.person?.name?.trim())
          .filter((n): n is string => Boolean(n))
          .slice(0, 5) ?? item.cast;
      const yr = show.premiered ? Number(show.premiered.slice(0, 4)) : item.year;
      return {
        ...item,
        title: show.name || rawSeriesTitle || query,
        coverUrl: nextCover,
        coverCandidates: candidates.length > 0 ? candidates : item.coverCandidates,
        genre: show.genres && show.genres.length > 0 ? show.genres.slice(0, 2).join(', ') : item.genre,
        year: Number.isFinite(yr) && yr > 1920 ? yr : item.year,
        releaseDate: show.premiered ? show.premiered.slice(0, 10) : item.releaseDate,
        synopsis:
          wiki?.extract ||
          stripHtmlTags(show.summary) ||
          stripHtmlTags(itunesTv?.results?.[0]?.longDescription || itunesTv?.results?.[0]?.shortDescription) ||
          item.synopsis,
        cast: castNames,
        seriesStatus: mapTvMazeStatus(show.status),
        studio: show.network?.name || show.webChannel?.name || item.studio,
      };
    }

    if (wiki?.extract || candidates.length > 0 || itunesTv?.results?.[0]) {
      const firstItunes = itunesTv?.results?.[0];
      return {
        ...item,
        coverUrl: needsCover ? candidates[0] || item.coverUrl : item.coverUrl,
        coverCandidates: candidates.length > 0 ? candidates : item.coverCandidates,
        synopsis:
          wiki?.extract ||
          stripHtmlTags(firstItunes?.longDescription || firstItunes?.shortDescription) ||
          item.synopsis,
        genre: firstItunes?.primaryGenreName || item.genre,
      };
    }
    return item;
  }

  if (item.kind === 'music') {
    const music = await fetchExternalJson<ItunesMovieOrTvResp>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=de&media=music&limit=5`,
      6500
    );
    const hit = music?.results?.[0];
    if (hit) {
      const yr = hit.releaseDate ? Number(hit.releaseDate.slice(0, 4)) : item.year;
      const durMin = hit.trackTimeMillis
        ? Math.max(1, Math.round(hit.trackTimeMillis / 60000))
        : item.totalDurationMinutes;
      const titleClean =
        hit.artistName && hit.trackName
          ? `${hit.artistName} – ${hit.trackName}`
          : hit.trackName || item.title;
      const candidates = dedupeCoverUrls([
        item.customCoverUrl,
        ...(item.coverCandidates ?? []),
        ...(music?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      ]);
      return {
        ...item,
        title: titleClean,
        coverUrl: needsCover ? candidates[0] || item.coverUrl : item.coverUrl,
        coverCandidates: candidates.length > 0 ? candidates : item.coverCandidates,
        genre: hit.primaryGenreName || item.genre,
        year: Number.isFinite(yr) && yr > 1920 ? yr : item.year,
        director: hit.artistName || item.director,
        studio: hit.collectionName || item.studio,
        totalDurationMinutes: durMin,
        synopsis: needsSynopsis
          ? `${hit.trackName || query} von ${hit.artistName || 'Unbekannter Künstler'}${hit.collectionName ? ` (Album: ${hit.collectionName})` : ''}.`
          : item.synopsis,
      };
    }
    return item;
  }

  if (item.kind === 'movie' || item.kind === 'video') {
    const qTerm = yearHint ? `${query} ${yearHint}` : query;
    const [movieResp, wiki] = await Promise.all([
      fetchExternalJson<ItunesMovieOrTvResp>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(qTerm)}&country=de&media=movie&limit=6`,
        6500
      ),
      fetchWikipediaSummaryDE(query),
    ]);
    const hit = movieResp?.results?.[0];
    const candidates = dedupeCoverUrls([
      item.customCoverUrl,
      ...(item.coverCandidates ?? []),
      ...(movieResp?.results ?? []).map((r) => upscaleArtworkUrl(r.artworkUrl100)),
      wiki?.originalimage?.source,
      wiki?.thumbnail?.source,
    ]);
    if (hit || wiki?.extract || candidates.length > 0) {
      const yr = hit?.releaseDate ? Number(hit.releaseDate.slice(0, 4)) : yearHint ?? item.year;
      const durMin = hit?.trackTimeMillis
        ? Math.max(5, Math.round(hit.trackTimeMillis / 60000))
        : item.totalDurationMinutes;
      const bestCover = needsCover ? candidates[0] || item.coverUrl : item.coverUrl;
      const bestSynopsis =
        stripHtmlTags(hit?.longDescription || hit?.shortDescription) ||
        wiki?.extract ||
        item.synopsis;
      return {
        ...item,
        title: hit?.trackName || query,
        coverUrl: bestCover,
        coverCandidates: candidates.length > 0 ? candidates : item.coverCandidates,
        genre: hit?.primaryGenreName || item.genre,
        year: Number.isFinite(yr) && yr > 1920 ? yr : item.year,
        releaseDate: hit?.releaseDate ? hit.releaseDate.slice(0, 10) : item.releaseDate,
        director: hit?.artistName || item.director,
        totalDurationMinutes: durMin,
        synopsis: bestSynopsis,
      };
    }
  }

  return item;
}

export async function enrichNasCatalogFromInternet(
  items: NasMediaItem[],
  maxItems = 24
): Promise<{ items: NasMediaItem[]; enrichedCount: number; remainingCount: number }> {
  const rawCandidates = items.filter((item) => {
    if (item.kind === 'image' || item.kind === 'other') return false;
    const needsCover = !item.customCoverUrl && isPlaceholderCoverUrl(item.coverUrl);
    const needsSynopsis =
      !item.synopsis ||
      item.synopsis.startsWith('Beim NAS-Ordnerscan') ||
      item.synopsis.startsWith('Beim Live-NAS-Ordnerscan') ||
      item.synopsis.startsWith('Direkt auf das NAS hochgeladene') ||
      item.synopsis.startsWith('Serie „');
    return needsCover || needsSynopsis;
  });

  if (rawCandidates.length === 0) {
    return { items, enrichedCount: 0, remainingCount: 0 };
  }

  // Serien und Filme immer priorisieren, danach Musik/Videos
  const priorityWeight = (kind: MediaKind) =>
    kind === 'series' ? 0 : kind === 'movie' ? 1 : kind === 'music' ? 2 : 3;
  const candidates = [...rawCandidates].sort((a, b) => priorityWeight(a.kind) - priorityWeight(b.kind));

  const batch = candidates.slice(0, maxItems);
  const updatedById = new Map<string, NasMediaItem>();
  let enrichedCount = 0;

  // Begrenzte Parallelität (4 gleichzeitige Lookups)
  for (let i = 0; i < batch.length; i += 4) {
    const chunk = batch.slice(i, i + 4);
    const results = await Promise.all(chunk.map((it) => enrichNasItemFromInternet(it).catch(() => it)));
    for (let j = 0; j < chunk.length; j += 1) {
      const orig = chunk[j];
      const next = results[j];
      if (
        next.coverUrl !== orig.coverUrl ||
        next.synopsis !== orig.synopsis ||
        next.title !== orig.title ||
        (next.coverCandidates?.length ?? 0) !== (orig.coverCandidates?.length ?? 0)
      ) {
        enrichedCount += 1;
        updatedById.set(orig.id, next);
      }
    }
  }

  const remainingCount = Math.max(0, candidates.length - batch.length);
  if (enrichedCount === 0) {
    return { items, enrichedCount: 0, remainingCount };
  }

  return {
    items: items.map((it) => updatedById.get(it.id) ?? it),
    enrichedCount,
    remainingCount,
  };
}
