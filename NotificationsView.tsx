import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CheckCheck,
  CheckSquare,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { NasNotification } from '../types/marcente';

interface NotificationsViewProps {
  notifications: NasNotification[];
  onMarkRead: (notificationId?: string) => Promise<void>;
  onDeleteSingle: (notificationId: string) => Promise<void>;
  onDeleteBatch: (notificationIds: string[]) => Promise<void>;
  onDeleteAll: () => Promise<void>;
}

type NotificationFilter = 'all' | 'unread' | 'read';

function getTriggerLabel(n: NasNotification): string {
  switch (n.triggerType) {
    case 'admin_broadcast':
      if (n.messageType === 'maintenance') return 'Admin · Wartung';
      if (n.messageType === 'new_content') return 'Admin · Neue Inhalte';
      if (n.messageType === 'general') return 'Admin · Allgemein';
      return 'Admin-Mitteilung';
    case 'duck_nas_added':
      return 'Neue NAS-Inhalte';
    case 'film_favorite_start':
      return 'Filmstart-Favorit';
    case 'auto_favorite':
      return 'Auto-Favorit';
    default:
      return 'Manueller Favorit';
  }
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  notifications,
  onMarkRead,
  onDeleteSingle,
  onDeleteBatch,
  onDeleteAll,
}) => {
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  // Entfernte Benachrichtigungen automatisch aus der Auswahl bereinigen
  useEffect(() => {
    const validIds = new Set(notifications.map((n) => n.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [notifications]);

  const counts = useMemo(() => {
    const unread = notifications.filter((n) => !n.read).length;
    const read = notifications.length - unread;
    return {
      total: notifications.length,
      unread,
      read,
    };
  }, [notifications]);

  const filteredNotifications = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return notifications.filter((n) => {
      if (filter === 'unread' && n.read) return false;
      if (filter === 'read' && !n.read) return false;
      if (q) {
        const hay = [
          n.seriesTitle,
          n.info,
          n.provider,
          n.senderLabel ?? '',
          n.releaseDate,
          getTriggerLabel(n),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [notifications, filter, searchQuery]);

  const allFilteredSelected =
    filteredNotifications.length > 0 &&
    filteredNotifications.every((n) => selectedIds.has(n.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const n of filteredNotifications) {
          next.delete(n.id);
        }
      } else {
        for (const n of filteredNotifications) {
          next.add(n.id);
        }
      }
      return next;
    });
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0 || busy) return;
    setBusy(true);
    try {
      const idsToDelete = Array.from(selectedIds);
      await onDeleteBatch(idsToDelete);
      setSelectedIds(new Set());
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteOne = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onDeleteSingle(id);
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDeleteAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDeleteAll();
      setSelectedIds(new Set());
      setConfirmDeleteAll(false);
    } finally {
      setBusy(false);
    }
  };

  const handleMarkAllRead = async () => {
    if (counts.unread === 0 || busy) return;
    setBusy(true);
    try {
      await onMarkRead();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI-Zusammenfassung */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Alle Benachrichtigungen</p>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1">
            {counts.total}
          </p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Ungelesen</p>
          <p className="font-display text-2xl font-bold text-amber-400 tabular-nums mt-1">
            {counts.unread}
          </p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Gelesen</p>
          <p className="font-display text-2xl font-bold text-slate-200 tabular-nums mt-1">
            {counts.read}
          </p>
        </div>
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <p className="text-xs text-slate-400">Markiert zum Löschen</p>
          <p className="font-display text-2xl font-bold text-rose-400 tabular-nums mt-1">
            {selectedIds.size}
          </p>
        </div>
      </div>

      {/* Filter- & Verwaltungsleiste */}
      <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B0E14] border border-slate-800/80 rounded-lg w-fit">
            {(
              [
                { id: 'all', label: `Alle (${counts.total})` },
                { id: 'unread', label: `Ungelesen (${counts.unread})` },
                { id: 'read', label: `Gelesen (${counts.read})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                  filter === tab.id
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Benachrichtigungen durchsuchen..."
              className="w-full bg-[#0B0E14] border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
            />
          </div>
        </div>

        {/* Sammelaktionen: Markieren & Löschen */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/80">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={filteredNotifications.length === 0 || busy}
              onClick={toggleSelectAllFiltered}
              className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              {allFilteredSelected ? (
                <CheckSquare className="w-4 h-4 text-amber-400" />
              ) : (
                <Square className="w-4 h-4 text-slate-400" />
              )}
              <span>
                {allFilteredSelected
                  ? 'Markierung aufheben'
                  : `Alle sichtbaren markieren (${filteredNotifications.length})`}
              </span>
            </button>

            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs text-slate-400 hover:text-white transition-colors whitespace-nowrap"
              >
                Auswahl leeren
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {counts.unread > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleMarkAllRead()}
                className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Alle als gelesen markieren</span>
              </button>
            )}

            <button
              type="button"
              disabled={selectedIds.size === 0 || busy}
              onClick={() => void handleDeleteSelected()}
              className="px-3.5 py-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 disabled:opacity-40 border border-rose-500/50 text-xs font-semibold text-rose-200 flex items-center gap-1.5 transition-colors whitespace-nowrap tabular-nums"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Markierte löschen ({selectedIds.size})</span>
            </button>

            {counts.total > 0 &&
              (confirmDeleteAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleConfirmDeleteAll()}
                    className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    Wirklich alle löschen
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteAll(false)}
                    className="px-2.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs text-slate-300 hover:text-white transition-colors"
                  >
                    Abbrechen
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDeleteAll(true)}
                  className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-rose-950/60 border border-slate-800 hover:border-rose-800/60 text-xs text-slate-300 hover:text-rose-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Alle löschen</span>
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* Benachrichtigungs-Liste */}
      {filteredNotifications.length === 0 ? (
        <div className="p-10 bg-[#121722] border border-slate-800/80 rounded-xl text-center space-y-2">
          <Bell className="w-7 h-7 text-slate-500 mx-auto" />
          <p className="text-sm font-medium text-white">
            {counts.total === 0
              ? 'Keine Benachrichtigungen vorhanden.'
              : 'Keine Benachrichtigungen für diesen Filter gefunden.'}
          </p>
          <p className="text-xs text-slate-400">
            Neue Hinweise erscheinen hier automatisch bei Serienstarts, Filmstarts, neuen
            NAS-Inhalten oder Admin-Mitteilungen.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredNotifications.map((n) => {
            const isSelected = selectedIds.has(n.id);
            return (
              <div
                key={n.id}
                className={`p-4 rounded-xl border transition-colors flex flex-col sm:flex-row sm:items-start justify-between gap-4 ${
                  isSelected
                    ? 'bg-amber-400/5 border-amber-400/70'
                    : n.read
                      ? 'bg-[#121722] border-slate-800/80 opacity-85'
                      : 'bg-[#121722] border-amber-400/40'
                }`}
              >
                <div className="flex items-start gap-3.5 min-w-0 flex-1">
                  {/* Auswahl-Checkbox zum Markieren mehrerer Benachrichtigungen */}
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Benachrichtigung „${n.seriesTitle}“ markieren`}
                    onClick={() => toggleSelect(n.id)}
                    className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected
                        ? 'bg-amber-400 border-amber-400 text-slate-950'
                        : 'bg-[#0B0E14] border-slate-700 hover:border-amber-400/70 text-transparent'
                    }`}
                  >
                    {isSelected && <CheckSquare className="w-4 h-4" />}
                  </button>

                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
                      {!n.read && (
                        <span className="font-semibold text-amber-300">
                          Neu ·
                        </span>
                      )}
                      <span
                        className={
                          n.triggerType === 'admin_broadcast'
                            ? n.messageType === 'maintenance'
                              ? 'font-semibold text-amber-300'
                              : n.messageType === 'new_content'
                                ? 'font-semibold text-emerald-300'
                                : 'font-semibold text-sky-300'
                            : 'font-medium text-slate-300'
                        }
                      >
                        {getTriggerLabel(n)}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">
                        {n.senderLabel ?? n.provider} · {n.releaseDate}
                      </span>
                    </div>

                    <h3 className="font-display text-base font-semibold text-white">
                      {n.seriesTitle}
                    </h3>

                    <p className="text-xs sm:text-sm text-slate-300 whitespace-pre-line">
                      {n.info}
                    </p>

                    {n.triggerType === 'duck_nas_added' &&
                      Array.isArray(n.categoryItems) &&
                      n.categoryItems.length > 0 && (
                        <div className="pt-2 mt-1 border-t border-slate-800/80 space-y-2">
                          {n.categoryItems.map((group) => (
                            <div key={group.kind} className="space-y-0.5">
                              <p className="text-[11px] font-semibold text-amber-300 tabular-nums">
                                {group.category} ({group.titles.length})
                              </p>
                              <ul className="text-xs text-slate-200 space-y-0.5 pl-4 list-disc marker:text-slate-500">
                                {group.titles.map((title, idx) => (
                                  <li key={`${group.kind}-${idx}`}>{title}</li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                </div>

                {/* Einzelaktionen */}
                <div className="flex sm:flex-col items-center sm:items-end justify-end gap-2 shrink-0">
                  {!n.read && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onMarkRead(n.id)}
                      className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 transition-colors whitespace-nowrap"
                    >
                      Als gelesen
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteOne(n.id)}
                    aria-label={`Benachrichtigung „${n.seriesTitle}“ einzeln löschen`}
                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-rose-950/60 border border-slate-800 hover:border-rose-800/60 text-xs text-slate-300 hover:text-rose-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Löschen</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
