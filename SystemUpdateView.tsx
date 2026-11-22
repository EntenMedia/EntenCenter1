import React, { useCallback, useEffect, useState } from 'react';
import { resolveNasUrl } from '../lib/nasClient';
import { isLocalFallbackToken } from '../lib/localBufferStore';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  GitBranch,
  Info,
  KeyRound,
  PackageCheck,
  RefreshCw,
  Search,
  Settings2,
  SkipForward,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  AndroidApkArtifactCandidate,
  AndroidApkArtifactsResponse,
  AppUpdateConfig,
  AppUpdateInstallResult,
  GithubUpdateCandidate,
} from '../types/marcente';

interface SystemUpdateViewProps {
  token: string;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Noch nicht';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString('de-DE');
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1).replace('.', ',')} MB`;
  }
  const kb = Math.max(1, Math.round(bytes / 1024));
  return `${kb} KB`;
}

export const SystemUpdateView: React.FC<SystemUpdateViewProps> = ({ token }) => {
  const [config, setConfig] = useState<AppUpdateConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const [candidate, setCandidate] = useState<GithubUpdateCandidate | null>(null);
  const [installResult, setInstallResult] = useState<AppUpdateInstallResult | null>(null);
  const [declinedUpdate, setDeclinedUpdate] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [repoInput, setRepoInput] = useState('EntenMedia/EntenCenter2');
  const [branchInput, setBranchInput] = useState('main');
  const [tokenInput, setTokenInput] = useState('');

  const [apkData, setApkData] = useState<AndroidApkArtifactsResponse | null>(null);
  const [apkLoading, setApkLoading] = useState(true);
  const [apkRefreshing, setApkRefreshing] = useState(false);
  const [apkError, setApkError] = useState<string | null>(null);
  const [apkRequiresToken, setApkRequiresToken] = useState(false);
  const [downloadingProjectZip, setDownloadingProjectZip] = useState(false);
  const [projectZipError, setProjectZipError] = useState<string | null>(null);
  const apkLoadedRef = React.useRef(false);

  const handleDownloadProjectZip = useCallback(async () => {
    if (downloadingProjectZip) return;
    setDownloadingProjectZip(true);
    setProjectZipError(null);
    try {
      const resp = await fetch('/api/project-export.zip');
      if (!resp.ok) {
        throw new Error(`Download fehlgeschlagen (HTTP ${resp.status})`);
      }
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'EntenCenter-Projekt.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err) {
      setProjectZipError(
        err instanceof Error ? err.message : 'Projekt-ZIP konnte nicht heruntergeladen werden.'
      );
    } finally {
      setDownloadingProjectZip(false);
    }
  }, [downloadingProjectZip]);

  const loadLatestApkBuild = useCallback(
    async (options?: { repository?: string; silent?: boolean }) => {
      if (isLocalFallbackToken(token)) {
        setApkLoading(false);
        setApkRefreshing(false);
        setApkError(null);
        return;
      }
      const isInitial = !options?.silent && !apkLoadedRef.current;
      if (isInitial) {
        setApkLoading(true);
      } else {
        setApkRefreshing(true);
      }
      setApkError(null);
      setApkRequiresToken(false);

      try {
        const params = new URLSearchParams();
        if (options?.repository?.trim()) {
          params.set('repository', options.repository.trim());
        }
        const qs = params.toString();
        const res = await fetch(
          `/api/nas/system/update/apk/latest${qs ? `?${qs}` : ''}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        const payload = (await res.json().catch(() => ({}))) as AndroidApkArtifactsResponse & {
          error?: string;
          requiresGithubToken?: boolean;
        };

        if (!res.ok) {
          setApkData(null);
          setApkRequiresToken(Boolean(payload.requiresGithubToken));
          setApkError(
            payload.error || 'GitHub Actions Builds konnten nicht abgerufen werden.'
          );
          return;
        }

        setApkData(payload);
      } catch {
        setApkError('Verbindung zur GitHub Actions API fehlgeschlagen.');
      } finally {
        apkLoadedRef.current = true;
        setApkLoading(false);
        setApkRefreshing(false);
      }
    },
    [token]
  );

  const loadStatus = useCallback(async () => {
    if (isLocalFallbackToken(token)) {
      setLoadingConfig(false);
      setErrorMessage(null);
      return;
    }
    setLoadingConfig(true);
    try {
      const res = await fetch('/api/nas/system/update/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(err.error || 'Update-Status konnte nicht geladen werden.');
        return;
      }
      const data = (await res.json()) as AppUpdateConfig;
      setConfig(data);
      setRepoInput(data.repository);
      setBranchInput(data.branch);
    } catch {
      setErrorMessage('Verbindung zum NAS-Backend fehlgeschlagen.');
    } finally {
      setLoadingConfig(false);
    }
  }, [token]);

  useEffect(() => {
    void loadStatus();
    void loadLatestApkBuild();
  }, [loadStatus, loadLatestApkBuild]);

  const handleCheckForUpdates = async () => {
    if (checking || installing) return;
    setChecking(true);
    setErrorMessage(null);
    setInstallResult(null);
    setDeclinedUpdate(false);
    setSettingsNotice(null);

    if (isLocalFallbackToken(token)) {
      try {
        const repo = (repoInput.trim() || 'EntenMedia/EntenCenter2').replace(/^\/+|\/+$/g, '');
        const branch = branchInput.trim() || 'main';
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
        if (res.ok) {
          const rel = (await res.json()) as {
            tag_name?: string;
            name?: string;
            html_url?: string;
            published_at?: string;
            body?: string;
          };
          setCandidate({
            updateAvailable: true,
            sourceType: 'release',
            repository: repo,
            branch,
            currentVersion: config?.installedVersion ?? '0.0.0',
            latestVersion: (rel.tag_name || rel.name || 'latest').replace(/^v/, ''),
            latestTag: rel.tag_name ?? null,
            currentCommitSha: config?.installedCommitSha ?? null,
            latestCommitSha: null,
            releaseName: rel.name || rel.tag_name || 'Neuestes GitHub Release',
            changelog: rel.body ?? '',
            publishedAt: rel.published_at ?? new Date().toISOString(),
            htmlUrl: rel.html_url ?? `https://github.com/${repo}/releases`,
            downloadUrl: rel.html_url ?? null,
            checkedAt: new Date().toISOString(),
            skipped: false,
          });
          setSettingsNotice(`GitHub Release „${rel.tag_name || rel.name || 'latest'}“ direkt geprüft.`);
        } else {
          setSettingsNotice(
            `Im Storage-Bridge-Modus stehen direkte GitHub-Releases unter github.com/${repo}/releases bereit.`
          );
        }
      } catch {
        setSettingsNotice(
          'GitHub-Update-Prüfung über Storage-Bridge derzeit offline nicht erreichbar.'
        );
      } finally {
        setChecking(false);
      }
      return;
    }

    try {
      const res = await fetch('/api/nas/system/update/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repository: repoInput.trim() || undefined,
          branch: branchInput.trim() || undefined,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        requiresGithubToken?: boolean;
        candidate?: GithubUpdateCandidate;
        config?: AppUpdateConfig;
      };

      if (!res.ok || !payload.candidate) {
        setCandidate(null);
        setErrorMessage(
          payload.error || 'GitHub-Update-Suche fehlgeschlagen. Bitte prüfe die Repository-Angaben.'
        );
        if (payload.requiresGithubToken) {
          setRepoSettingsOpen(true);
        }
        return;
      }

      setCandidate(payload.candidate);
      if (payload.config) {
        setConfig(payload.config);
      }
    } catch {
      setErrorMessage('Netzwerkfehler bei der Verbindung mit GitHub.');
    } finally {
      setChecking(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!candidate || installing || checking) return;
    if (isLocalFallbackToken(token)) {
      setSettingsNotice(
        `Im Storage-Bridge-Modus ohne lokalen App-Server (:3000) bitte das Release direkt über ${candidate.htmlUrl} herunterladen.`
      );
      return;
    }
    setInstalling(true);
    setErrorMessage(null);
    setDeclinedUpdate(false);

    try {
      const res = await fetch('/api/nas/system/update/install', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repository: candidate.repository,
          branch: candidate.branch,
          targetVersion: candidate.latestVersion,
          targetTag: candidate.latestTag,
          targetCommitSha: candidate.latestCommitSha,
          downloadUrl: candidate.downloadUrl,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        result?: AppUpdateInstallResult;
        config?: AppUpdateConfig;
      };

      if (!res.ok || !payload.result) {
        setErrorMessage(payload.error || 'Update konnte nicht heruntergeladen und installiert werden.');
        return;
      }

      setInstallResult(payload.result);
      if (payload.config) {
        setConfig(payload.config);
      }
      setCandidate((prev) =>
        prev
          ? {
              ...prev,
              updateAvailable: false,
              currentVersion: payload.result!.installedVersion,
              currentCommitSha: payload.result!.installedCommitSha,
            }
          : null
      );
    } catch {
      setErrorMessage('Netzwerkfehler beim Herunterladen oder Installieren des Updates.');
    } finally {
      setInstalling(false);
    }
  };

  const handleSkipUpdate = async () => {
    if (!candidate || skipping || installing) return;
    if (isLocalFallbackToken(token)) {
      setDeclinedUpdate(true);
      return;
    }
    setSkipping(true);
    setErrorMessage(null);
    try {
      const targetKey = candidate.latestCommitSha || candidate.latestVersion;
      const res = await fetch('/api/nas/system/update/skip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ versionOrSha: targetKey }),
      });
      if (res.ok) {
        const updatedConfig = (await res.json()) as AppUpdateConfig;
        setConfig(updatedConfig);
      }
      setDeclinedUpdate(true);
    } catch {
      setErrorMessage('Auswahl konnte nicht gespeichert werden.');
    } finally {
      setSkipping(false);
    }
  };

  const handleSaveRepoConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingSettings) return;
    if (isLocalFallbackToken(token)) {
      setSettingsNotice('Repository-Einstellungen lokal übernommen.');
      return;
    }
    setSavingSettings(true);
    setErrorMessage(null);
    setSettingsNotice(null);

    try {
      const res = await fetch('/api/nas/system/update/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repository: repoInput.trim(),
          branch: branchInput.trim() || 'main',
          ...(tokenInput.trim() ? { githubToken: tokenInput.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as AppUpdateConfig & { error?: string };
      if (!res.ok) {
        setErrorMessage(data.error || 'GitHub-Einstellungen konnten nicht gespeichert werden.');
        return;
      }
      setConfig(data);
      setRepoInput(data.repository);
      setBranchInput(data.branch);
      setTokenInput('');
      setSettingsNotice('GitHub-Einstellungen gespeichert.');
      void loadLatestApkBuild({ repository: data.repository, silent: true });
    } catch {
      setErrorMessage('Verbindung zum NAS beim Speichern fehlgeschlagen.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleClearToken = async () => {
    if (savingSettings) return;
    setSavingSettings(true);
    setErrorMessage(null);
    setSettingsNotice(null);
    try {
      const res = await fetch('/api/nas/system/update/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ clearGithubToken: true }),
      });
      if (res.ok) {
        const data = (await res.json()) as AppUpdateConfig;
        setConfig(data);
        setTokenInput('');
        setSettingsNotice('GitHub-Token entfernt.');
        void loadLatestApkBuild({ repository: data.repository, silent: true });
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const buildDirectApkHref = (artifact: AndroidApkArtifactCandidate, hasGithubToken: boolean): string => {
    if (hasGithubToken) {
      return `${artifact.proxyDownloadPath}&token=${encodeURIComponent(token)}`;
    }
    return artifact.runHtmlUrl;
  };

  return (
    <div className="space-y-6">
      {/* KPI / Statusübersicht */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <PackageCheck className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Installierte Version</span>
          </div>
          <p className="font-display text-2xl font-bold text-white tabular-nums mt-1.5">
            {loadingConfig ? '—' : `v${config?.installedVersion ?? '0.0.0'}`}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5 font-mono truncate">
            {config?.installedCommitSha
              ? `Commit ${config.installedCommitSha.slice(0, 7)} · Installiert ${formatDateTime(config.installedAt)}`
              : 'Lokale EntenCenter-Installation'}
          </p>
        </div>

        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <GitBranch className="w-4 h-4 text-amber-400 shrink-0" />
            <span>GitHub-Repository</span>
          </div>
          <p className="font-display text-base font-bold text-white truncate mt-2">
            {config?.repository ?? repoInput}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-2">
            <span>Branch: {config?.branch ?? branchInput}</span>
            <span>·</span>
            <span>{config?.hasGithubToken ? 'Token hinterlegt' : 'Öffentlicher Zugriff'}</span>
          </p>
        </div>

        <div className="p-4 bg-[#121722] border border-slate-800/80 rounded-xl">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Search className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Letzte Update-Suche</span>
          </div>
          <p className="font-display text-base font-bold text-white tabular-nums mt-2">
            {formatDateTime(config?.lastCheckedAt ?? null)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Direkte Prüfung über die GitHub-API
          </p>
        </div>
      </div>

      {/* Hauptbereich: Update-Suche auf GitHub */}
      <div className="p-5 sm:p-6 bg-[#121722] border border-slate-800/80 rounded-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-amber-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-white">
                EntenCenter auf GitHub aktualisieren
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              Prüft auf GitHub nach neuen Releases oder neueren Commits für{' '}
              <span className="text-slate-200 font-mono">{config?.repository ?? repoInput}</span>.
              Deine NAS-Mediathek und Einstellungen bleiben beim Update erhalten.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleCheckForUpdates()}
            disabled={checking || installing}
            className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            <span>{checking ? 'Suche auf GitHub...' : 'Auf GitHub nach Updates suchen'}</span>
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-200 flex items-start gap-2.5"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-rose-100">{errorMessage}</p>
            </div>
          </div>
        )}

        {installResult && (
          <div
            role="status"
            className="p-4 rounded-xl bg-emerald-950/35 border border-emerald-500/40 text-xs text-emerald-100 flex items-start gap-3"
          >
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-emerald-200">{installResult.message}</p>
              <p className="text-emerald-300/80 tabular-nums">
                Version: v{installResult.installedVersion}
                {installResult.installedCommitSha
                  ? ` (${installResult.installedCommitSha.slice(0, 7)})`
                  : ''}{' '}
                · {installResult.updatedFilesCount} Dateien aktualisiert
                {installResult.dependenciesUpdated ? ' · Abhängigkeiten aktualisiert' : ''}
              </p>
            </div>
          </div>
        )}

        {candidate && !candidate.updateAvailable && !installResult && (
          <div
            role="status"
            className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/35 text-xs text-emerald-100 flex items-start gap-3"
          >
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1 min-w-0">
              <p className="font-semibold text-emerald-200">
                EntenCenter ist auf dem neuesten Stand.
              </p>
              <p className="text-emerald-300/80 tabular-nums">
                Aktuell installiert: v{candidate.currentVersion}
                {candidate.currentCommitSha
                  ? ` (${candidate.currentCommitSha.slice(0, 7)})`
                  : ''}{' '}
                · Stand auf GitHub: v{candidate.latestVersion}
                {candidate.latestCommitSha ? ` (${candidate.latestCommitSha.slice(0, 7)})` : ''}
              </p>
            </div>
            {candidate.htmlUrl && (
              <a
                href={candidate.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1.5 shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                <span>GitHub</span>
              </a>
            )}
          </div>
        )}

        {candidate && candidate.updateAvailable && (
          <div className="p-5 rounded-xl bg-[#0F141E] border border-amber-400/50 space-y-4">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-amber-400 text-slate-950 text-[11px] font-bold">
                    Neues Update verfügbar
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#121722] border border-slate-700 text-[11px] text-slate-200 font-mono">
                    {candidate.sourceType === 'release'
                      ? `Release ${candidate.latestTag ?? candidate.latestVersion}`
                      : `Commit ${candidate.latestCommitSha?.slice(0, 7) ?? candidate.latestVersion}`}
                  </span>
                  {candidate.publishedAt && (
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      Veröffentlicht: {formatDateTime(candidate.publishedAt)}
                    </span>
                  )}
                </div>
                <h3 className="font-display text-base font-bold text-white">
                  {candidate.releaseName}
                </h3>
                <p className="text-xs text-slate-400 tabular-nums">
                  Installiert: v{candidate.currentVersion}
                  {candidate.currentCommitSha
                    ? ` (${candidate.currentCommitSha.slice(0, 7)})`
                    : ''}{' '}
                  → Neu auf GitHub: v{candidate.latestVersion}
                  {candidate.latestCommitSha ? ` (${candidate.latestCommitSha.slice(0, 7)})` : ''}
                </p>
              </div>

              {candidate.htmlUrl && (
                <a
                  href={candidate.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:text-amber-300 flex items-center gap-1.5 shrink-0 w-fit"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                  <span>Auf GitHub ansehen</span>
                </a>
              )}
            </div>

            {candidate.changelog && (
              <div className="p-3.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">
                {candidate.changelog}
              </div>
            )}

            {declinedUpdate ? (
              <div className="p-3.5 rounded-lg bg-slate-900/70 border border-slate-700 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-3">
                <span>
                  Du hast ausgewählt, dieses Update vorerst <strong>nicht zu installieren</strong>.
                  Deine aktuelle Installation bleibt unverändert.
                </span>
                <button
                  type="button"
                  onClick={() => setDeclinedUpdate(false)}
                  className="px-3 py-1.5 rounded-lg bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 text-amber-300 font-medium transition-colors"
                >
                  Auswahl wieder öffnen
                </button>
              </div>
            ) : (
              <div className="pt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-800/80">
                <p className="text-xs text-slate-300">
                  Möchtest du dieses Update jetzt von GitHub herunterladen und installieren?
                </p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => void handleSkipUpdate()}
                    disabled={installing || skipping}
                    className="px-4 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors disabled:opacity-60"
                  >
                    <SkipForward className="w-3.5 h-3.5 text-slate-400" />
                    <span>{skipping ? 'Speichere...' : 'Nicht installieren'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleInstallUpdate()}
                    disabled={installing || skipping}
                    className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-2 transition-colors"
                  >
                    <Download className={`w-4 h-4 ${installing ? 'animate-bounce' : ''}`} />
                    <span>
                      {installing
                        ? 'Lade von GitHub & installiere...'
                        : 'Herunterladen & Installieren'}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Android App Update: Direkter APK-Download vom neuesten erfolgreichen GitHub Actions Build */}
      <div className="p-5 sm:p-6 bg-[#121722] border border-slate-800/80 rounded-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-amber-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-white">
                Android App Update (GitHub Actions APK)
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              Ruft über die GitHub Actions API das neueste erfolgreich erstellte APK-Artefakt für{' '}
              <span className="text-slate-200 font-mono">{config?.repository ?? repoInput}</span> ab,
              damit du die Android-App direkt manuell aktualisieren kannst.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadLatestApkBuild({ repository: repoInput.trim() || undefined, silent: true })}
            disabled={apkLoading || apkRefreshing}
            className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 disabled:opacity-60 text-slate-200 text-xs font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-amber-400 ${apkLoading || apkRefreshing ? 'animate-spin' : ''}`} />
            <span>{apkLoading || apkRefreshing ? 'Prüfe Builds...' : 'Builds aktualisieren'}</span>
          </button>
        </div>

        {apkLoading ? (
          <div className="p-5 rounded-xl bg-[#0F141E] border border-slate-800/80 space-y-3 animate-pulse">
            <div className="h-4 w-48 rounded bg-slate-800/80" />
            <div className="h-3 w-80 max-w-full rounded bg-slate-800/60" />
            <div className="h-9 w-36 rounded-lg bg-slate-800/70" />
          </div>
        ) : apkError ? (
          <div
            role="alert"
            className="p-4 rounded-xl bg-rose-950/35 border border-rose-500/40 text-xs text-rose-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium text-rose-100">{apkError}</p>
                {apkRequiresToken && (
                  <p className="text-rose-200/80">
                    Hinterlege in der GitHub-Konfiguration unten einen Personal Access Token mit Leserechten.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {apkRequiresToken && (
                <button
                  type="button"
                  onClick={() => setRepoSettingsOpen(true)}
                  className="px-3 py-1.5 rounded-lg bg-rose-900/50 hover:bg-rose-800/60 border border-rose-400/40 text-xs font-medium text-rose-100 whitespace-nowrap"
                >
                  Token konfigurieren
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadLatestApkBuild({ repository: repoInput.trim() || undefined, silent: true })}
                className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 whitespace-nowrap"
              >
                Erneut prüfen
              </button>
            </div>
          </div>
        ) : apkData?.latest ? (
          <div className="p-5 rounded-xl bg-[#0F141E] border border-amber-400/40 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 tabular-nums">
                  <span className="font-semibold text-amber-300">
                    {apkData.latest.isSignedRelease ? 'Signierte Release-APK' : 'Android APK Build'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-slate-200">
                    Build #{apkData.latest.workflowRunNumber}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">Branch {apkData.latest.headBranch}</span>
                  {apkData.latest.headSha && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{apkData.latest.headSha.slice(0, 7)}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>{formatByteSize(apkData.latest.sizeInBytes)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDateTime(apkData.latest.createdAt)}</span>
                </div>

                <h3 className="font-display text-base font-bold text-white truncate">
                  {apkData.latest.suggestedFilename}
                </h3>

                <p className="text-xs text-slate-400 truncate">
                  Workflow: <span className="text-slate-200">{apkData.latest.workflowName}</span>
                  {apkData.latest.commitMessage ? ` — ${apkData.latest.commitMessage}` : ''}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <a
                  href={apkData.latest.runHtmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 hover:text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                  <span>Build auf GitHub</span>
                </a>

                <a
                  href={buildDirectApkHref(apkData.latest, apkData.hasGithubToken)}
                  download={apkData.hasGithubToken ? apkData.latest.suggestedFilename : undefined}
                  target={apkData.hasGithubToken ? undefined : '_blank'}
                  rel={apkData.hasGithubToken ? undefined : 'noopener noreferrer'}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-4 h-4" />
                  <span>Download APK</span>
                </a>
              </div>
            </div>

            {!apkData.hasGithubToken && (
              <div className="pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>
                  Hinweis: GitHub verlangt für den direkten Artefakt-Dateidownload eine Authentifizierung.
                  Ohne hinterlegten Token öffnet „Download APK“ direkt den erfolgreichen GitHub-Build; mit Token
                  lädt EntenCenter die fertige <span className="font-mono text-slate-300">.apk</span>-Datei direkt herunter.
                </span>
                <button
                  type="button"
                  onClick={() => setRepoSettingsOpen(true)}
                  className="text-amber-300 hover:text-amber-200 font-medium underline underline-offset-2 whitespace-nowrap shrink-0 self-start sm:self-auto"
                >
                  GitHub-Token hinterlegen
                </button>
              </div>
            )}

            {apkData.recentArtifacts.length > 1 && (
              <div className="pt-3 border-t border-slate-800/80 space-y-2">
                <p className="text-[11px] font-medium text-slate-400">
                  Weitere erfolgreiche APK-Builds auf GitHub Actions
                </p>
                <div className="divide-y divide-slate-800/70">
                  {apkData.recentArtifacts.slice(1).map((item) => (
                    <div
                      key={item.artifactId}
                      className="py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium text-slate-200 truncate">
                          {item.suggestedFilename}
                        </p>
                        <p className="text-[11px] text-slate-400 tabular-nums font-mono truncate">
                          Build #{item.workflowRunNumber} · {item.workflowName} · {item.headBranch} ·{' '}
                          {formatByteSize(item.sizeInBytes)} · {formatDateTime(item.createdAt)}
                        </p>
                      </div>
                      <a
                        href={buildDirectApkHref(item, apkData.hasGithubToken)}
                        download={apkData.hasGithubToken ? item.suggestedFilename : undefined}
                        target={apkData.hasGithubToken ? undefined : '_blank'}
                        rel={apkData.hasGithubToken ? undefined : 'noopener noreferrer'}
                        className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-amber-300 hover:text-amber-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 w-fit"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download APK</span>
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-5 rounded-xl bg-[#0F141E] border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-200">
                Kein aktives APK-Build-Artefakt in den letzten erfolgreichen GitHub Actions Runs gefunden.
              </p>
              <p className="text-[11px] text-slate-400">
                Starte auf GitHub den Workflow „Auto-Generate Keystore &amp; Build Signed APK“ oder „Build EntenCenter Android APK“,
                damit hier ein direkter Download-Link erscheint.
              </p>
            </div>
            {apkData?.actionsHtmlUrl && (
              <a
                href={apkData.actionsHtmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 w-fit"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
                <span>GitHub Actions öffnen</span>
              </a>
            )}
          </div>
        )}
      </div>

      {/* Aufklappbare GitHub-Repository- & Token-Konfiguration */}
      <div className="bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden">
        <button
          type="button"
          aria-expanded={repoSettingsOpen}
          onClick={() => setRepoSettingsOpen((prev) => !prev)}
          className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-900/60 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-800/80 border border-slate-700/80 flex items-center justify-center shrink-0">
              <Settings2 className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0">
              <p className="font-display text-sm font-semibold text-white">
                GitHub-Quelle &amp; Zugangsdaten konfigurieren
              </p>
              <p className="text-xs text-slate-400 truncate">
                Repository, Branch oder optionalen GitHub-Token für private Repositories festlegen
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
            <span className="hidden sm:inline">
              {repoSettingsOpen ? 'Zuklappen' : 'Aufklappen'}
            </span>
            {repoSettingsOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-300" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-300" />
            )}
          </div>
        </button>

        {repoSettingsOpen && (
          <form
            onSubmit={handleSaveRepoConfig}
            className="px-4 pb-4 pt-3 border-t border-slate-800/80 space-y-4 bg-[#0F141E]/60"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block space-y-1.5 text-xs">
                <span className="text-slate-300 font-medium">
                  GitHub Repository (Besitzer/Name oder URL)
                </span>
                <input
                  type="text"
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="EntenMedia/EntenCenter2"
                  className="w-full bg-[#121722] border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 font-mono"
                />
              </label>

              <label className="block space-y-1.5 text-xs">
                <span className="text-slate-300 font-medium">Branch</span>
                <input
                  type="text"
                  value={branchInput}
                  onChange={(e) => setBranchInput(e.target.value)}
                  placeholder="main"
                  className="w-full bg-[#121722] border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 font-mono"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <label className="block space-y-1.5 text-xs">
                <span className="text-slate-300 font-medium flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                  <span>GitHub Personal Access Token (optional, für private Repositories)</span>
                </span>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={
                    config?.hasGithubToken
                      ? '•••••••••••• (Token bereits verschlüsselt gespeichert — leer lassen zum Beibehalten)'
                      : 'github_pat_... oder ghp_...'
                  }
                  className="w-full bg-[#121722] border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 font-mono"
                />
              </label>
              <p className="text-[11px] text-slate-500">
                Wird AES-256-GCM-verschlüsselt in den zentralen NAS-Einstellungen gespeichert und
                nie im Klartext zurückgegeben.
              </p>
            </div>

            {settingsNotice && (
              <p className="text-xs text-emerald-300 font-medium">{settingsNotice}</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {config?.hasGithubToken ? (
                <button
                  type="button"
                  onClick={() => void handleClearToken()}
                  disabled={savingSettings}
                  className="px-3 py-2 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/40 text-xs text-rose-200 flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Gespeicherten Token entfernen</span>
                </button>
              ) : (
                <span />
              )}

              <button
                type="submit"
                disabled={savingSettings}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold transition-colors"
              >
                {savingSettings ? 'Speichere...' : 'GitHub-Einstellungen speichern'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Eingebaute Android App-Icons Vorschau */}
      <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Smartphone className="w-4 h-4 text-amber-400 shrink-0" />
            <div>
              <h3 className="font-display text-sm font-semibold text-white">
                Eingebaute Android App-Icons
              </h3>
              <p className="text-[11px] text-slate-400 font-mono">
                android:icon=&quot;@mipmap/ic_launcher&quot; · android:roundIcon=&quot;@mipmap/ic_launcher&quot;
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-300 font-mono bg-[#0B0E14] border border-slate-800 px-2.5 py-1 rounded-lg">
            <span
              className="w-3 h-3 rounded-sm border border-slate-600 inline-block"
              style={{ backgroundColor: '#030818' }}
            />
            <span>Hintergrund #030818</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Launcher-Vorschau: Standard & Rund */}
          <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex items-center justify-around gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border border-slate-700/80 bg-[#030818] shadow-lg">
                <img
                  src={resolveNasUrl('/api/nas/system/android-icons/xxxhdpi')}
                  alt="EntenCenter Android Launcher Icon (Standard)"
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              </div>
              <span className="text-[11px] text-slate-400">Launcher (Standard)</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-20 h-20 rounded-full overflow-hidden border border-slate-700/80 bg-[#030818] shadow-lg">
                <img
                  src={resolveNasUrl('/api/nas/system/android-icons/xxxhdpi')}
                  alt="EntenCenter Android Launcher Icon (Rund)"
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              </div>
              <span className="text-[11px] text-slate-400">Launcher (Rund)</span>
            </div>
          </div>

          {/* Alle Mipmap-Dichten */}
          <div className="md:col-span-2 p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-3">
            <p className="text-xs font-medium text-slate-300">
              Installierte Auflösungen in <span className="font-mono text-amber-300">app/src/main/res</span>
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 items-end">
              {(
                [
                  { id: 'mdpi', label: 'mdpi', size: '48×48', cls: 'w-8 h-8' },
                  { id: 'hdpi', label: 'hdpi', size: '72×72', cls: 'w-10 h-10' },
                  { id: 'xhdpi', label: 'xhdpi', size: '96×96', cls: 'w-12 h-12' },
                  { id: 'xxhdpi', label: 'xxhdpi', size: '144×144', cls: 'w-14 h-14' },
                  { id: 'xxxhdpi', label: 'xxxhdpi', size: '192×192', cls: 'w-16 h-16' },
                  { id: 'master', label: 'Play Store', size: '1024×1024', cls: 'w-16 h-16' },
                ] as const
              ).map((icon) => (
                <div
                  key={icon.id}
                  className="flex flex-col items-center gap-1.5 text-center p-2 rounded-lg bg-[#121722]/70 border border-slate-800/70"
                >
                  <img
                    src={resolveNasUrl(`/api/nas/system/android-icons/${icon.id}`)}
                    alt={`EntenCenter Icon ${icon.label} (${icon.size})`}
                    loading="lazy"
                    decoding="async"
                    className={`${icon.cls} rounded-lg object-cover border border-slate-700/70`}
                  />
                  <span className="text-[11px] font-medium text-slate-200">{icon.label}</span>
                  <span className="text-[10px] font-mono text-slate-400 tabular-nums">
                    {icon.size}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Über das EntenCenter Infokarte */}
      <div className="p-5 bg-[#121722] border border-slate-800/80 rounded-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold text-white">Über das EntenCenter</h3>
          <button
            type="button"
            onClick={() => void handleDownloadProjectZip()}
            disabled={downloadingProjectZip}
            className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
          >
            {downloadingProjectZip ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>
              {downloadingProjectZip
                ? 'Lade Projekt-ZIP...'
                : 'Projekt als ZIP herunterladen'}
            </span>
          </button>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          EntenCenter ist dein zentrales Zero-Local-Footprint NAS-Mediacenter für Filme, Serien,
          Musik, Bilder, DE/AT-Film- &amp; Serienkalender, Smart-Home-Steuerung und automatische
          Enten-Empfehlungen. Updates werden direkt über das verbundene GitHub-Repository bezogen.
        </p>
        {projectZipError && (
          <p role="alert" className="text-xs text-rose-300">
            {projectZipError}
          </p>
        )}
      </div>
    </div>
  );
};
