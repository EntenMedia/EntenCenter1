import React, { useMemo, useState } from 'react';
import { Calendar, Film, Play, RefreshCw, Sparkles, Tv } from 'lucide-react';
import { DuckRecommendationData, WatchStatistics } from '../types/marcente';

interface StatisticsViewProps {
  stats: WatchStatistics | null;
  loading: boolean;
  recommendations?: DuckRecommendationData | null;
  recommendationsLoading?: boolean;
  onRefreshRecommendations?: () => void;
  onPlayMediaId?: (mediaId: string) => void;
}

type TimeRange = 'week' | 'month' | 'year';
type HistoryFilter =
  | 'month_0'
  | 'month_1'
  | 'month_2'
  | 'month_3'
  | 'month_4'
  | 'month_5'
  | 'month_6'
  | 'month_7'
  | 'month_8'
  | 'month_9'
  | 'month_10'
  | 'month_11'
  | 'by_year';

const HISTORY_FILTER_OPTIONS: Array<{
  id: HistoryFilter;
  label: string;
  monthIndex?: number;
}> = [
  { id: 'month_0', label: 'Januar', monthIndex: 0 },
  { id: 'month_1', label: 'Februar', monthIndex: 1 },
  { id: 'month_2', label: 'März', monthIndex: 2 },
  { id: 'month_3', label: 'April', monthIndex: 3 },
  { id: 'month_4', label: 'Mai', monthIndex: 4 },
  { id: 'month_5', label: 'Juni', monthIndex: 5 },
  { id: 'month_6', label: 'Juli', monthIndex: 6 },
  { id: 'month_7', label: 'August', monthIndex: 7 },
  { id: 'month_8', label: 'September', monthIndex: 8 },
  { id: 'month_9', label: 'Oktober', monthIndex: 9 },
  { id: 'month_10', label: 'November', monthIndex: 10 },
  { id: 'month_11', label: 'Dezember', monthIndex: 11 },
  { id: 'by_year', label: 'Nach dem Jahr' },
];

const parseWatchTimestamp = (ts: string | null | undefined): Date | null => {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
};

export const StatisticsView: React.FC<StatisticsViewProps> = ({
  stats,
  loading,
  recommendations = null,
  recommendationsLoading = false,
  onRefreshRecommendations,
  onPlayMediaId,
}) => {
  const [range, setRange] = useState<TimeRange>('week');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('by_year');
  const [selectedYear, setSelectedYear] = useState<number | 'all'>('all');

  const availableYears = useMemo(() => {
    if (!stats) return [] as number[];
    const years = new Set<number>();
    for (const item of stats.historyItems) {
      const d = parseWatchTimestamp(item.timestamp);
      if (d) years.add(d.getFullYear());
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [stats]);

  const filterCounts = useMemo(() => {
    const counts: Record<HistoryFilter, number> = {
      month_0: 0,
      month_1: 0,
      month_2: 0,
      month_3: 0,
      month_4: 0,
      month_5: 0,
      month_6: 0,
      month_7: 0,
      month_8: 0,
      month_9: 0,
      month_10: 0,
      month_11: 0,
      by_year: 0,
    };
    if (!stats) return counts;
    for (const item of stats.historyItems) {
      const d = parseWatchTimestamp(item.timestamp);
      if (!d) {
        if (selectedYear === 'all') {
          counts.by_year += 1;
        }
        continue;
      }
      if (selectedYear !== 'all' && d.getFullYear() !== selectedYear) continue;
      counts.by_year += 1;
      const key = `month_${d.getMonth()}` as HistoryFilter;
      if (key in counts) {
        counts[key] += 1;
      }
    }
    return counts;
  }, [stats, selectedYear]);

  const filteredHistory = useMemo(() => {
    if (!stats) return [];
    const activeOption = HISTORY_FILTER_OPTIONS.find((o) => o.id === historyFilter);
    return stats.historyItems.filter((item) => {
      const d = parseWatchTimestamp(item.timestamp);
      if (!d) {
        return selectedYear === 'all' && activeOption?.monthIndex === undefined;
      }
      if (selectedYear !== 'all' && d.getFullYear() !== selectedYear) return false;
      if (activeOption?.monthIndex !== undefined) {
        return d.getMonth() === activeOption.monthIndex;
      }
      return true;
    });
  }, [stats, historyFilter, selectedYear]);

  const groupedByYear = useMemo(() => {
    const groups = new Map<number | 'undated', typeof filteredHistory>();
    for (const item of filteredHistory) {
      const d = parseWatchTimestamp(item.timestamp);
      const groupKey: number | 'undated' = d ? d.getFullYear() : 'undated';
      const existing = groups.get(groupKey) ?? [];
      existing.push(item);
      groups.set(groupKey, existing);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === 'undated') return 1;
      if (b[0] === 'undated') return -1;
      return b[0] - a[0];
    });
  }, [filteredHistory]);

  if (loading || !stats) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl bg-[#121722] border border-slate-800/80 animate-pulse"
            />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-[#121722] border border-slate-800/80 animate-pulse" />
      </div>
    );
  }

  const seriesData =
    range === 'week'
      ? stats.weeklyTrend
      : range === 'month'
        ? stats.monthlyTrend
        : stats.yearlyTrend;
  const maxHours = Math.max(...seriesData.map((d) => d.hours), 1);

  const renderHistoryRow = (entry: WatchStatistics['historyItems'][number]) => {
    const watchedDate = parseWatchTimestamp(entry.timestamp);
    const monthYearLabel = watchedDate
      ? watchedDate.toLocaleDateString('de-DE', {
          month: 'long',
          year: 'numeric',
        })
      : 'Ohne Datum als gesehen markiert';

    return (
      <div
        key={`${entry.mediaId}-${entry.timestamp ?? 'undated'}`}
        className="px-4 sm:px-6 py-4 flex items-center justify-between gap-4 hover:bg-slate-900/40 transition-colors group"
      >
        <div className="flex items-center gap-4 min-w-0">
          {/* Cover-Vorschau in der Historie */}
          <div className="relative w-14 h-20 sm:w-16 sm:h-24 rounded-lg overflow-hidden bg-slate-900 border border-slate-800/90 shrink-0">
            {entry.coverUrl ? (
              <img
                src={entry.coverUrl}
                alt={entry.title}
                referrerPolicy="no-referrer"
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-600">
                {entry.mediaType === 'series' ? (
                  <Tv className="w-5 h-5" />
                ) : (
                  <Film className="w-5 h-5" />
                )}
              </div>
            )}
            {onPlayMediaId && entry.mediaId && (
              <button
                type="button"
                onClick={() => onPlayMediaId(entry.mediaId)}
                aria-label={`${entry.title} abspielen`}
                className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
              >
                <span className="w-8 h-8 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center shadow">
                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                </span>
              </button>
            )}
          </div>

          <div className="min-w-0">
            <p className="font-display text-sm sm:text-base font-semibold text-white truncate">
              {entry.title}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400 mt-1">
              <span className="inline-flex items-center gap-1 text-slate-300">
                {entry.mediaType === 'series' ? (
                  <Tv className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Film className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>{entry.mediaType === 'series' ? 'Serie' : 'Film'}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>{entry.genre}</span>
              {entry.year && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{entry.year}</span>
                </>
              )}
              {entry.mediaType === 'series' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{entry.episodesWatched} Folgen</span>
                </>
              )}
            </div>
            <p className="text-[11px] text-amber-400/90 mt-1.5 font-medium">
              {monthYearLabel}
            </p>
          </div>
        </div>

        <div className="text-right shrink-0">
          <p className="text-xs font-mono tabular-nums text-amber-400 font-semibold">
            {entry.watchedMinutes} Min.
          </p>
          {watchedDate ? (
            <>
              <p className="text-xs font-mono tabular-nums text-slate-400 mt-1">
                {watchedDate.toLocaleDateString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
              </p>
              <p className="text-[11px] font-mono tabular-nums text-slate-500">
                {watchedDate.toLocaleTimeString('de-DE', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                Uhr
              </p>
            </>
          ) : (
            <p className="text-xs font-mono text-slate-400 mt-1">Ohne Datum</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* KPI-Zeile */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Diese Woche geschaut</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.totals.weekHours} Std.
          </p>
        </div>
        <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Aktueller Monat</p>
          <p className="font-display text-2xl font-bold text-amber-400 tabular-nums mt-1">
            {stats.totals.monthHours} Std.
          </p>
        </div>
        <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Laufendes Jahr</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.totals.yearHours} Std.
          </p>
        </div>
        <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Aktive NAS-Serien</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {stats.totals.activeSeriesCount}{' '}
            <span className="text-xs font-normal text-slate-400">
              ({stats.totals.completedTitles} Titel gesamt)
            </span>
          </p>
        </div>
      </div>

      {/* Nutzungsverhalten & Vorlieben (verschoben aus EntenTheke) */}
      {(recommendations?.analysis ||
        (recommendations?.topGenres && recommendations.topGenres.length > 0)) && (
        <section className="p-6 bg-[#121722] border border-slate-800/80 rounded-xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Nutzungsmuster &amp; erkannte Vorlieben</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Analyse deines Nutzungsverhaltens &amp; Sehverlaufs auf dem NAS
              </p>
            </div>
            {onRefreshRecommendations && (
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
            )}
          </div>

          {recommendations?.analysis ? (
            <div className="rounded-xl border border-slate-800/80 bg-[#0B0E14]/85 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div className="space-y-1 min-w-0">
                <p className="text-slate-400">
                  Nutzungsmuster:{' '}
                  <span className="text-slate-100 font-medium tabular-nums">
                    {recommendations.analysis.analysisHeadline}
                  </span>
                </p>
                <p className="text-slate-400 truncate">
                  Typische Nutzung:{' '}
                  <span className="text-slate-200">
                    {recommendations.analysis.preferredTimeWindow}
                  </span>
                  {recommendations.analysis.watchlistCount > 0 && (
                    <span className="text-slate-400 tabular-nums">
                      {' '}
                      · {recommendations.analysis.watchlistCount} auf Merkliste
                    </span>
                  )}
                </p>
              </div>

              <div className="space-y-1 min-w-0">
                {recommendations.analysis.recentWatchedTitles.length > 0 && (
                  <p className="text-slate-400 truncate">
                    Zuletzt angeschaut:{' '}
                    <span className="text-slate-200">
                      {recommendations.analysis.recentWatchedTitles.slice(0, 3).join(', ')}
                    </span>
                  </p>
                )}
                <p className="text-slate-400 truncate">
                  Erkannte Vorlieben:{' '}
                  <span className="text-amber-300 font-medium">
                    {[
                      ...(recommendations.topGenres ?? []),
                      ...(recommendations.analysis.topMoods ?? []).slice(0, 2),
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Vielseitiges NAS-Profil'}
                  </span>
                </p>
                {recommendations.analysis.recentSearchInterests.length > 0 && (
                  <p className="text-slate-400 truncate">
                    Suchinteressen:{' '}
                    <span className="text-slate-200">
                      {recommendations.analysis.recentSearchInterests.join(' · ')}
                    </span>
                  </p>
                )}
              </div>
            </div>
          ) : (
            recommendations?.topGenres &&
            recommendations.topGenres.length > 0 && (
              <p className="text-xs text-slate-400">
                Erkannte Vorlieben:{' '}
                <span className="text-slate-200 font-medium">
                  {recommendations.topGenres.join(' · ')}
                </span>
              </p>
            )
          )}
        </section>
      )}

      {/* Hauptbereich: Zeitverlauf & Genre-Auswertung */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Zeitverlauf */}
        <section className="lg:col-span-7 p-6 bg-[#121722] border border-slate-800/80 rounded-xl flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="font-display text-lg font-semibold text-white">
                Wiedergabezeit nach Zeitraum
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Zentral aus dem NAS-Watch-Ledger berechnet
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#0B0E14] border border-slate-800 rounded-lg">
              {(
                [
                  { id: 'week', label: 'Woche' },
                  { id: 'month', label: 'Monat' },
                  { id: 'year', label: 'Jahr' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setRange(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    range === tab.id
                      ? 'bg-amber-400 text-slate-950'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="grid gap-3 items-end h-56 pt-4 border-t border-slate-800/60"
            style={{
              gridTemplateColumns: `repeat(${seriesData.length}, minmax(0, 1fr))`,
            }}
          >
            {seriesData.map((bar) => {
              const heightPct = Math.max(8, Math.round((bar.hours / maxHours) * 100));
              return (
                <div
                  key={bar.label}
                  className="flex flex-col items-center justify-end h-full gap-2"
                >
                  <span className="text-xs font-mono tabular-nums text-slate-300">
                    {bar.hours}h
                  </span>
                  <div className="w-full max-w-[44px] flex-1 flex items-end bg-[#0B0E14] rounded-md overflow-hidden p-1 border border-slate-800/60">
                    <div
                      className="w-full bg-amber-400 rounded-sm transition-all duration-300"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-400 font-medium">{bar.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Genre-Auswertung */}
        <section className="lg:col-span-5 p-6 bg-[#121722] border border-slate-800/80 rounded-xl">
          <h3 className="font-display text-lg font-semibold text-white">
            Genre-Auswertung
          </h3>
          <p className="text-xs text-slate-400 mt-0.5 mb-6">
            Anteil der geschauten NAS-Stunden nach Kategorie
          </p>

          <div className="space-y-4">
            {stats.genreBreakdown.map((g) => (
              <div key={g.genre} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-200">{g.genre}</span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {g.hours} Std. · {g.percentage}%
                  </span>
                </div>
                <div className="h-2 bg-[#0B0E14] rounded-full overflow-hidden border border-slate-800/70">
                  <div
                    className="h-full bg-amber-400 rounded-full transition-all duration-300"
                    style={{ width: `${g.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Gesehen-Historie mit Cover-Anzeige & Monats-/Jahresauswahl */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800/80 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-semibold text-white">
                Gesehen-Historie mit Covern (löschresistentes NAS-Protokoll)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Unveränderlicher Verlauf aus{' '}
                <code className="font-mono text-amber-300">/mnt/nas/.entencenter/history.json</code>
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {filteredHistory.length} Einträge
            </span>
          </div>

          {/* Monats- und Jahres-Auswahl */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#0B0E14] border border-slate-800 rounded-lg">
              {HISTORY_FILTER_OPTIONS.map((opt) => {
                const active = historyFilter === opt.id;
                const count = filterCounts[opt.id];
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setHistoryFilter(opt.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-amber-400 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <span>{opt.label}</span>
                    <span
                      className={`font-mono tabular-nums text-[11px] ${
                        active ? 'text-slate-900' : 'text-slate-500'
                      }`}
                    >
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            {availableYears.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <Calendar className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Jahr:</span>
                <select
                  value={selectedYear}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedYear(val === 'all' ? 'all' : Number(val));
                  }}
                  className="bg-[#0B0E14] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  <option value="all">Alle Jahre ({stats.historyItems.length})</option>
                  {availableYears.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {filteredHistory.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-400">
            Für diesen Monat sind noch keine Wiedergaben im NAS-Protokoll hinterlegt.
          </div>
        ) : historyFilter === 'by_year' ? (
          <div className="divide-y divide-slate-800/80">
            {groupedByYear.map(([yearKey, yearItems]) => (
              <div key={String(yearKey)}>
                <div className="px-6 py-2.5 bg-[#0B0E14]/70 border-b border-slate-800/60 flex items-center justify-between">
                  <span className="font-display text-xs font-semibold text-amber-400 tabular-nums">
                    {yearKey === 'undated' ? 'Ohne Datum' : `Jahr ${yearKey}`}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-slate-400">
                    {yearItems.length} Titel
                  </span>
                </div>
                <div className="divide-y divide-slate-800/70">
                  {yearItems.map(renderHistoryRow)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {filteredHistory.map(renderHistoryRow)}
          </div>
        )}
      </section>
    </div>
  );
};
