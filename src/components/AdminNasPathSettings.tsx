import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import {
  AdminNasPathSettings as AdminNasPathSettingsType,
  AdminNasPathSettingsResponse,
  MediaKind,
} from '../types/marcente';
import {
  isLocalFallbackToken,
  readLocalOnboardingBuffer,
} from '../lib/localBufferStore';
import {
  cleanHostOnly,
  readAllLocalProvisionedBackends,
  readFileFromNasBridge,
  readLocalProvisionedBackendForHost,
  sanitizeNasPortForProtocol,
  saveLocalBridgePathSettings,
  writeFileToNasBridge,
} from '../lib/nasClient';

const LOCAL_PATH_SETTINGS_KEY = 'entencenter_local_admin_path_settings_v1';

interface AdminNasPathSettingsProps {
  token: string;
  onPathsSaved?: (next: AdminNasPathSettingsType) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const DEFAULT_PATH_SETTINGS: AdminNasPathSettingsType = {
  vaultBasePath: '/EntenCenter-Backend',
  vaultFileName: 'entencenter-vault.json',
  uploadsSubdir: 'media',
  hostStorageOverrideDir: '',
  mediaFolders: {
    movie: '/FRITZ/Filme',
    series: '/FRITZ/Serien',
    image: '/FRITZ/Bilder',
    music: '/FRITZ/Musik',
    video: '/FRITZ/Videos',
    other: '/FRITZ/Dokumente',
  },
  updatedAt: null,
  updatedBy: null,
};

const MEDIA_KIND_PATH_LABELS: Array<{ kind: MediaKind; label: string }> = [
  { kind: 'movie', label: 'Filme-Ordner' },
  { kind: 'series', label: 'Serien-Ordner' },
  { kind: 'image', label: 'Bilder-Ordner' },
  { kind: 'music', label: 'Musik-Ordner' },
  { kind: 'video', label: 'Video-Ordner' },
  { kind: 'other', label: 'Dokumente / Sonstiges' },
];

export const AdminNasPathSettings: React.FC<AdminNasPathSettingsProps> = ({
  token,
  onPathsSaved,
  collapsed,
  onToggleCollapse,
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? internalCollapsed;
  const handleToggleCollapse = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed((prev) => !prev);
    }
  };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<AdminNasPathSettingsType | null>(null);
  const [draft, setDraft] = useState<AdminNasPathSettingsType>(DEFAULT_PATH_SETTINGS);
  const [meta, setMeta] = useState<{
    effectiveServerDataDir: string;
    effectiveUploadsDir: string;
    resolvedVaultFilePath: string;
    writable: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resolveBridgeForPaths = useCallback(() => {
    const buf = readLocalOnboardingBuffer();
    const conn = buf?.nasConnection;
    const provisioned =
      readLocalProvisionedBackendForHost(conn?.host || buf?.serverUrl || '') ??
      readAllLocalProvisionedBackends()[0] ??
      null;
    const host =
      cleanHostOnly(conn?.host) ||
      cleanHostOnly(buf?.serverUrl) ||
      cleanHostOnly(provisioned?.host) ||
      '';
    const pass = conn?.fritzPassword || conn?.secret || '';
    const protocol = conn?.protocol ?? provisioned?.protocol ?? 'fritz_upnp';
    const useTls = protocol === 'smb' ? false : Boolean(conn?.useTls);
    const port = String(
      sanitizeNasPortForProtocol(
        protocol,
        conn?.port || (protocol === 'smb' ? '445' : useTls ? '443' : '80'),
        useTls
      )
    );
    const backendRoot = (
      buf?.syncedBackendPath ||
      conn?.backendPath ||
      provisioned?.backendPath ||
      '/EntenCenter-Backend'
    ).replace(/\/+$/, '');
    return { conn, host, pass, protocol, useTls, port, backendRoot };
  }, []);

  const loadPathSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (isLocalFallbackToken(token)) {
      try {
        const { conn, host, pass, protocol, useTls, port, backendRoot } = resolveBridgeForPaths();
        const bridgeDefaults: AdminNasPathSettingsType = {
          ...DEFAULT_PATH_SETTINGS,
          vaultBasePath: backendRoot,
        };
        let remoteParsed: AdminNasPathSettingsType | null = null;
        if (host && pass) {
          const remoteRes = await readFileFromNasBridge({
            protocol,
            host,
            port,
            shareOrPath: protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: conn?.username || '',
            password: pass,
            fritzPassword: pass,
            useTls,
            targetPath: `${backendRoot}/config/path-settings.json`,
          }).catch(() => null);
          if (remoteRes?.ok && remoteRes.content) {
            remoteParsed = JSON.parse(remoteRes.content) as AdminNasPathSettingsType;
          }
        }
        const raw = window.localStorage.getItem(LOCAL_PATH_SETTINGS_KEY);
        const localParsed = raw ? (JSON.parse(raw) as AdminNasPathSettingsType) : null;
        const picked = remoteParsed ?? localParsed;
        const effective = picked ? { ...bridgeDefaults, ...picked } : bridgeDefaults;
        setSaved(effective);
        setDraft(effective);
        setMeta({
          effectiveServerDataDir: effective.vaultBasePath,
          effectiveUploadsDir: `${effective.vaultBasePath.replace(/\/+$/, '')}/${effective.uploadsSubdir}`,
          resolvedVaultFilePath: `${effective.vaultBasePath.replace(/\/+$/, '')}/${effective.vaultFileName}`,
          writable: true,
        });
      } catch {
        setSaved(DEFAULT_PATH_SETTINGS);
        setDraft(DEFAULT_PATH_SETTINGS);
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/path-settings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as AdminNasPathSettingsResponse & { error?: string };
      if (!res.ok || !data.settings) {
        setError(data.error || 'Pfad-Einstellungen konnten nicht geladen werden.');
        return;
      }
      setSaved(data.settings);
      setDraft(data.settings);
      setMeta({
        effectiveServerDataDir: data.effectiveServerDataDir,
        effectiveUploadsDir: data.effectiveUploadsDir,
        resolvedVaultFilePath: data.resolvedVaultFilePath,
        writable: data.writable,
      });
    } catch {
      setError('Verbindung zum NAS beim Laden der Pfad-Einstellungen fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }, [resolveBridgeForPaths, token]);

  useEffect(() => {
    void loadPathSettings();
  }, [loadPathSettings]);

  const handleSave = async (override?: AdminNasPathSettingsType) => {
    const payload = override ?? draft;
    setSaving(true);
    setError(null);
    setNotice(null);
    if (isLocalFallbackToken(token)) {
      try {
        const nextLocal: AdminNasPathSettingsType = {
          ...payload,
          updatedAt: new Date().toISOString(),
          updatedBy: 'storage-bridge',
        };
        window.localStorage.setItem(LOCAL_PATH_SETTINGS_KEY, JSON.stringify(nextLocal));
        saveLocalBridgePathSettings(nextLocal);
        setSaved(nextLocal);
        setDraft(nextLocal);
        const resolvedFile = `${nextLocal.vaultBasePath.replace(/\/+$/, '')}/${nextLocal.vaultFileName}`;
        setMeta({
          effectiveServerDataDir: nextLocal.vaultBasePath,
          effectiveUploadsDir: `${nextLocal.vaultBasePath.replace(/\/+$/, '')}/${nextLocal.uploadsSubdir}`,
          resolvedVaultFilePath: resolvedFile,
          writable: true,
        });
        onPathsSaved?.(nextLocal);

        const { conn, host, pass, protocol, useTls, port, backendRoot } = resolveBridgeForPaths();
        if (host && pass) {
          const wr = await writeFileToNasBridge({
            protocol,
            host,
            port,
            shareOrPath: protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: conn?.username || '',
            password: pass,
            fritzPassword: pass,
            useTls,
            targetPath: `${backendRoot}/config/path-settings.json`,
            content: JSON.stringify(nextLocal, null, 2),
            contentType: 'application/json; charset=utf-8',
          });
          if (wr.ok) {
            setNotice(
              `Pfad-Einstellungen direkt auf ${host} (${wr.filePath}) und in der Storage-Bridge gespeichert.`
            );
          } else {
            setNotice(`Pfad-Einstellungen lokal gespeichert (${resolvedFile}).`);
            setError(wr.error || 'Direktschreiben auf das NAS fehlgeschlagen.');
          }
        } else {
          setNotice(
            `Pfad-Einstellungen in Storage-Bridge gespeichert (${resolvedFile}).`
          );
        }
      } catch {
        setError('Pfad-Einstellungen konnten nicht gespeichert werden.');
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/path-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as AdminNasPathSettingsResponse & { error?: string };
      if (!res.ok || !data.settings) {
        setError(data.error || 'Pfad-Einstellungen konnten nicht auf dem NAS gespeichert werden.');
        return;
      }
      setSaved(data.settings);
      setDraft(data.settings);
      setMeta({
        effectiveServerDataDir: data.effectiveServerDataDir,
        effectiveUploadsDir: data.effectiveUploadsDir,
        resolvedVaultFilePath: data.resolvedVaultFilePath,
        writable: data.writable,
      });
      onPathsSaved?.(data.settings);
      setNotice(
        `Pfad-Einstellungen gespeichert. Zieldatei: ${data.resolvedVaultFilePath} (${data.settings.vaultBasePath})`
      );
    } catch {
      setError('Verbindung zum NAS beim Speichern der Pfad-Einstellungen fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  const isDirty = Boolean(
    saved &&
      (draft.vaultBasePath.trim() !== saved.vaultBasePath ||
        draft.vaultFileName.trim() !== saved.vaultFileName ||
        draft.uploadsSubdir.trim() !== saved.uploadsSubdir ||
        draft.hostStorageOverrideDir.trim() !== saved.hostStorageOverrideDir ||
        MEDIA_KIND_PATH_LABELS.some(
          ({ kind }) => draft.mediaFolders[kind].trim() !== saved.mediaFolders[kind]
        ))
  );

  return (
    <section
      aria-labelledby="admin-nas-paths-heading"
      className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden"
    >
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={handleToggleCollapse}
        className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
          !isCollapsed ? 'border-b border-slate-800/80' : ''
        }`}
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <span className="w-10 h-10 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
            <FolderOpen className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3
              id="admin-nas-paths-heading"
              className="font-display text-base font-semibold text-white"
            >
              NAS-Einstellungen · Pfad-Einstellungen
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Lege Pfad und Zieldatei fest, unter denen EntenCenter Tresor-Daten, Manifest und
              Medien-Uploads auf dem NAS ablegt.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {meta && (
            <span
              className={`text-xs font-semibold px-3 py-1 rounded-lg border whitespace-nowrap ${
                meta.writable
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
              }`}
            >
              {meta.writable ? 'Zielpfad beschreibbar' : 'Zielpfad nicht beschreibbar'}
            </span>
          )}
          <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        </div>
      </button>

      {!isCollapsed && (
      <div className="p-6 space-y-5">
        {loading ? (
          <div className="py-6 text-center text-xs text-slate-400">
            Lade Pfad-Einstellungen vom NAS...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="admin-path-vault-base"
                  className="text-xs font-medium text-slate-200 block mb-1.5"
                >
                  NAS-Speicherpfad (Mount / Zielordner)
                </label>
                <input
                  id="admin-path-vault-base"
                  type="text"
                  value={draft.vaultBasePath}
                  onChange={(e) => setDraft({ ...draft, vaultBasePath: e.target.value })}
                  placeholder="/mnt/nas/.entencenter"
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Anzeige- und Referenzpfad für den zentralen NAS-Vault im gesamten System.
                </p>
              </div>

              <div>
                <label
                  htmlFor="admin-path-vault-file"
                  className="text-xs font-medium text-slate-200 block mb-1.5"
                >
                  NAS-Zieldatei (Tresor- &amp; Manifest-Datei)
                </label>
                <input
                  id="admin-path-vault-file"
                  type="text"
                  value={draft.vaultFileName}
                  onChange={(e) => setDraft({ ...draft, vaultFileName: e.target.value })}
                  placeholder="entencenter-vault.json"
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Dateiname auf dem NAS, in den Konfigurations- und Tresor-Prüfsummen gesichert
                  werden.
                </p>
              </div>

              <div>
                <label
                  htmlFor="admin-path-uploads-subdir"
                  className="text-xs font-medium text-slate-200 block mb-1.5"
                >
                  Upload-Unterordner auf dem NAS
                </label>
                <input
                  id="admin-path-uploads-subdir"
                  type="text"
                  value={draft.uploadsSubdir}
                  onChange={(e) => setDraft({ ...draft, uploadsSubdir: e.target.value })}
                  placeholder="uploads"
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Relativer Ordner innerhalb des NAS-Datenverzeichnisses für neue Datei-Uploads.
                </p>
              </div>

              <div>
                <label
                  htmlFor="admin-path-host-override"
                  className="text-xs font-medium text-slate-200 block mb-1.5"
                >
                  Physischer Server-Speicherpfad (optional)
                </label>
                <input
                  id="admin-path-host-override"
                  type="text"
                  value={draft.hostStorageOverrideDir}
                  onChange={(e) => setDraft({ ...draft, hostStorageOverrideDir: e.target.value })}
                  placeholder="Leer lassen für Standard (./data/marcente-nas)"
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Optionaler absoluter Mount-Pfad auf dem Server-Host (z. B. gemountetes
                  NAS-Laufwerk).
                </p>
              </div>
            </div>

            {/* Standard-Medienordner pro Kategorie */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
                <p className="text-xs font-semibold text-white">
                  Standard-Speicherpfade nach Medien-Kategorie
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {MEDIA_KIND_PATH_LABELS.map(({ kind, label }) => (
                  <div key={kind}>
                    <label
                      htmlFor={`admin-media-path-${kind}`}
                      className="text-[11px] font-medium text-slate-300 block mb-1"
                    >
                      {label}
                    </label>
                    <input
                      id={`admin-media-path-${kind}`}
                      type="text"
                      value={draft.mediaFolders[kind]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mediaFolders: {
                            ...draft.mediaFolders,
                            [kind]: e.target.value,
                          },
                        })
                      }
                      className="w-full px-2.5 py-1.5 bg-[#121722] border border-slate-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-amber-400"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Aktuell aufgelöste Server-Pfade */}
            {meta && (
              <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-3.5 text-[11px] text-slate-300 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-white">
                  <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Aktuell aufgelöste NAS-Ziele auf dem Server</span>
                </div>
                <p className="font-mono break-all text-slate-400">
                  Datenverzeichnis: <span className="text-slate-200">{meta.effectiveServerDataDir}</span>
                </p>
                <p className="font-mono break-all text-slate-400">
                  Upload-Verzeichnis: <span className="text-slate-200">{meta.effectiveUploadsDir}</span>
                </p>
                <p className="font-mono break-all text-slate-400">
                  Zieldatei: <span className="text-amber-300">{meta.resolvedVaultFilePath}</span>
                </p>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {notice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="text-[11px] text-slate-400">
                {isDirty
                  ? 'Ungespeicherte Änderungen an den NAS-Pfaden.'
                  : saved?.updatedAt
                    ? `Zuletzt gespeichert: ${new Date(saved.updatedAt).toLocaleString('de-DE')}${saved.updatedBy ? ` (${saved.updatedBy})` : ''}`
                    : 'Standard-Pfade auf dem NAS aktiv.'}
              </div>

              <div className="flex flex-wrap items-center gap-2.5 ml-auto">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setDraft(DEFAULT_PATH_SETTINGS);
                    void handleSave(DEFAULT_PATH_SETTINGS);
                  }}
                  className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Standard-Pfade</span>
                </button>
                <button
                  type="button"
                  disabled={loading || saving}
                  onClick={() => void loadPathSettings()}
                  className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Neu laden</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{saving ? 'Speichere...' : 'Pfad-Einstellungen speichern'}</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}
    </section>
  );
};
