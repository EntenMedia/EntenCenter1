import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CornerLeftUp,
  Eye,
  EyeOff,
  FileCode2,
  Folder,
  FolderPlus,
  HardDrive,
  KeyRound,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Wifi,
  X,
} from 'lucide-react';
import {
  browseNasDirectoryTree,
  fritzBoxDirectLoginWithSession,
  provisionNasBackend,
  sanitizeNasPortForProtocol,
  saveLocalProvisionedBackendFolder,
} from '../lib/nasClient';
import {
  NAS_PROTOCOL_CATALOG,
  NasBrowseTreeResult,
  NasDirectoryTreeEntry,
  NasProtocolId,
  NasProvisionBackendResult,
} from '../types/marcente';

export interface NasBackendProvisionTarget {
  host: string;
  port?: string;
  protocol: NasProtocolId;
  shareOrPath?: string;
  username?: string;
  secret?: string;
  fritzPassword?: string;
  useTls?: boolean;
  friendlyName?: string;
  requiresAuth?: boolean;
  serverBaseUrl?: string;
  ownerUsername?: string;
  token?: string | null;
}

interface NasBackendProvisionDialogProps {
  open: boolean;
  target: NasBackendProvisionTarget | null;
  onClose: () => void;
  onProvisioned: (
    result: NasProvisionBackendResult,
    updatedCredentials: {
      username: string;
      secret: string;
      useTls: boolean;
      fritzPassword?: string;
    }
  ) => void;
}

function normalizePathInput(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!cleaned || cleaned === '/') return '/';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.replace(/\/+$/, '') || '/';
}

export const NasBackendProvisionDialog: React.FC<NasBackendProvisionDialogProps> = ({
  open,
  target,
  onClose,
  onProvisioned,
}) => {
  const [currentPath, setCurrentPath] = useState('/');
  const [manualPath, setManualPath] = useState('/FRITZ/EntenCenter-Backend');
  const [newSubfolderName, setNewSubfolderName] = useState('');
  const [nasUser, setNasUser] = useState('');
  const [nasSecret, setNasSecret] = useState('');
  const [fritzExtraPassword, setFritzExtraPassword] = useState('');
  const [showNasSecretPw, setShowNasSecretPw] = useState(false);
  const [showFritzExtraPw, setShowFritzExtraPw] = useState(false);
  const [needExtraFritzPw, setNeedExtraFritzPw] = useState(false);
  const [useTls, setUseTls] = useState(false);
  const [showCreds, setShowCreds] = useState(false);

  const [loadingTree, setLoadingTree] = useState(false);
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const [treeData, setTreeData] = useState<NasBrowseTreeResult | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [testingFritzLogin, setTestingFritzLogin] = useState(false);
  const [fritzLoginNote, setFritzLoginNote] = useState<string | null>(null);
  const [provisionResult, setProvisionResult] = useState<NasProvisionBackendResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const isFritzTarget = Boolean(
    target &&
      (target.protocol === 'fritz_upnp' ||
        target.requiresAuth ||
        (target.friendlyName ?? '').toLowerCase().includes('fritz') ||
        target.host.toLowerCase().includes('fritz') ||
        treeData?.source === 'fritz_nas_api')
  );

  const loadDirectory = useCallback(
    async (
      pathToLoad: string,
      overrideUser?: string,
      overrideSecret?: string,
      overrideTls?: boolean,
      overrideFritzPass?: string
    ) => {
      if (!target?.host) return;
      setLoadingTree(true);
      setLocalError(null);
      try {
        const effTls = overrideTls ?? useTls;
        const res = await browseNasDirectoryTree({
          protocol: target.protocol,
          host: target.host,
          port: String(sanitizeNasPortForProtocol(target.protocol, target.port, effTls)),
          path: pathToLoad,
          username: overrideUser ?? nasUser,
          secret: overrideSecret ?? nasSecret,
          fritzPassword: overrideFritzPass ?? fritzExtraPassword,
          useTls: target.protocol === 'smb' ? false : effTls,
          serverBaseUrl: target.serverBaseUrl,
          token: target.token,
        });
        setTreeData(res);
        setCurrentPath(res.currentPath || pathToLoad);
        if (res.requiresAuth) {
          setShowCreds(true);
        }
      } catch (err) {
        setLocalError(
          err instanceof Error
            ? err.message
            : 'Verzeichnisstruktur wird lokal gepuffert (Verbindung bleibt aktiv).'
        );
      } finally {
        setLoadingTree(false);
      }
    },
    [fritzExtraPassword, nasSecret, nasUser, target, useTls]
  );

  useEffect(() => {
    if (!open || !target) return;
    const initUser = target.username ?? '';
    const initSecret = target.secret ?? '';
    const initFritzExtra = target.fritzPassword ?? '';
    const initTls = Boolean(target.useTls);
    const fritzHint =
      target.protocol === 'fritz_upnp' ||
      Boolean(target.requiresAuth) ||
      (target.friendlyName ?? '').toLowerCase().includes('fritz') ||
      target.host.toLowerCase().includes('fritz') ||
      Boolean(initFritzExtra);
    const defaultManual =
      target.shareOrPath && target.shareOrPath !== '/' && target.shareOrPath !== '/MediaServer'
        ? target.shareOrPath.toLowerCase().includes('entencenter')
          ? normalizePathInput(target.shareOrPath)
          : `${normalizePathInput(target.shareOrPath)}/EntenCenter-Backend`
        : target.protocol === 'fritz_upnp'
          ? '/FRITZ/EntenCenter-Backend'
          : '/EntenCenter-Backend';

    setNasUser(initUser);
    setNasSecret(initSecret);
    setFritzExtraPassword(initFritzExtra);
    setNeedExtraFritzPw(Boolean(initFritzExtra) || (target.protocol !== 'fritz_upnp' && fritzHint));
    setUseTls(initTls);
    setManualPath(defaultManual);
    setCurrentPath('/');
    setProvisionResult(null);
    setFritzLoginNote(null);
    setLocalError(null);
    setShowCreds(Boolean(target.requiresAuth || fritzHint || !initSecret));

    void browseNasDirectoryTree({
      protocol: target.protocol,
      host: target.host,
      port: String(sanitizeNasPortForProtocol(target.protocol, target.port, initTls)),
      path: '/',
      username: initUser,
      secret: initSecret,
      fritzPassword: initFritzExtra,
      useTls: target.protocol === 'smb' ? false : initTls,
      serverBaseUrl: target.serverBaseUrl,
      token: target.token,
    }).then((res) => {
      setTreeData(res);
      if (res.requiresAuth) {
        setShowCreds(true);
        if (target.protocol !== 'fritz_upnp') {
          setNeedExtraFritzPw(true);
        }
      }
    });
  }, [open, target]);

  const protocolLabel = useMemo(() => {
    if (!target) return '';
    return (
      NAS_PROTOCOL_CATALOG.find((p) => p.id === target.protocol)?.label ??
      target.protocol.toUpperCase()
    );
  }, [target]);

  const breadcrumbs = useMemo(() => {
    const clean = normalizePathInput(currentPath);
    if (clean === '/') return [{ label: '/ (NAS-Root)', path: '/' }];
    const parts = clean.split('/').filter(Boolean);
    const items = [{ label: '/ (NAS-Root)', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [currentPath]);

  if (!open || !target) return null;

  const handleEntryClick = (entry: NasDirectoryTreeEntry) => {
    if (entry.type !== 'directory') return;
    if (entry.name.toLowerCase().includes('entencenter')) {
      setManualPath(entry.path);
    } else {
      const nextSuggested =
        entry.path === '/' ? '/EntenCenter-Backend' : `${entry.path}/EntenCenter-Backend`;
      setManualPath(nextSuggested);
    }
    void loadDirectory(entry.path);
  };

  const handleCreateSubfolderLive = async () => {
    const cleanName = newSubfolderName.trim().replace(/[\\/]+/g, '');
    if (!cleanName || creatingSubfolder) return;
    const base = normalizePathInput(currentPath);
    const createdPath = base === '/' ? `/${cleanName}` : `${base}/${cleanName}`;
    setCreatingSubfolder(true);
    setLocalError(null);
    try {
      const folderRes = await provisionNasBackend({
        mode: 'manual',
        createSingleFolder: true,
        targetPath: createdPath,
        protocol: target.protocol,
        host: target.host,
        port: String(sanitizeNasPortForProtocol(target.protocol, target.port, useTls)),
        username: nasUser.trim(),
        secret: nasSecret,
        fritzPassword: fritzExtraPassword || undefined,
        useTls: target.protocol === 'smb' ? false : useTls,
        ownerUsername: target.ownerUsername,
        serverBaseUrl: target.serverBaseUrl,
        token: target.token,
      });
      saveLocalProvisionedBackendFolder(target.host, target.protocol, createdPath, []);
      setManualPath(
        cleanName.toLowerCase().includes('entencenter')
          ? createdPath
          : `${createdPath}/EntenCenter-Backend`
      );
      setNewSubfolderName('');
      if (!folderRes.remoteWriteOk && folderRes.warning) {
        setLocalError(folderRes.warning);
      } else if (folderRes.remoteWriteOk) {
        setFritzLoginNote(`Ordner „${createdPath}“ direkt auf dem NAS angelegt.`);
      }
      await loadDirectory(base, nasUser, nasSecret, useTls, fritzExtraPassword);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : `Ordner „${createdPath}“ wurde in der Bridge vorgemerkt.`
      );
    } finally {
      setCreatingSubfolder(false);
    }
  };

  const handleVerifyFritzAndLoad = async () => {
    if (!target?.host) return;
    const effectivePass =
      target.protocol === 'fritz_upnp'
        ? nasSecret
        : fritzExtraPassword.trim()
          ? fritzExtraPassword
          : nasSecret;
    setTestingFritzLogin(true);
    setLocalError(null);
    setFritzLoginNote(null);
    try {
      const loginRes = await fritzBoxDirectLoginWithSession({
        host: target.host,
        port: String(sanitizeNasPortForProtocol('fritz_upnp', target.port, useTls)),
        useTls,
        username: nasUser.trim(),
        password: effectivePass,
        allowLocalSelfSignedTls: true,
        forceRefresh: true,
        serverBaseUrl: target.serverBaseUrl,
        verifyBrowseTree: false,
      });
      if (loginRes.ok) {
        const nextTls = loginRes.effectiveScheme === 'https';
        setUseTls(nextTls);
        setFritzLoginNote(
          `FRITZ!Box Login aktiv (SID ${loginRes.sidPreview || 'OK'}${
            loginRes.httpsFallbackToHttp ? ' · HTTP-Fallback :80' : ''
          }).`
        );
        await loadDirectory(currentPath, nasUser, nasSecret, nextTls, effectivePass);
      } else {
        setLocalError(
          loginRes.error ||
            'FRITZ!Box Anmeldung fehlgeschlagen. Bitte überprüfe das Feld „Passwort für die FRITZ!Box“.'
        );
        await loadDirectory(currentPath, nasUser, nasSecret, useTls, effectivePass);
      }
    } finally {
      setTestingFritzLogin(false);
    }
  };

  const handleProvision = async (mode: 'auto' | 'manual') => {
    setProvisioning(true);
    setLocalError(null);
    const chosenTarget =
      mode === 'auto'
        ? treeData?.recommendedBackendPath ||
          (target.protocol === 'fritz_upnp' ? '/FRITZ/EntenCenter-Backend' : '/EntenCenter-Backend')
        : normalizePathInput(manualPath || '/EntenCenter-Backend');

    try {
      const result = await provisionNasBackend({
        mode,
        targetPath: chosenTarget,
        protocol: target.protocol,
        host: target.host,
        port: String(sanitizeNasPortForProtocol(target.protocol, target.port, useTls)),
        username: nasUser.trim(),
        secret: nasSecret,
        fritzPassword: fritzExtraPassword || undefined,
        useTls: target.protocol === 'smb' ? false : useTls,
        ownerUsername: target.ownerUsername,
        serverBaseUrl: target.serverBaseUrl,
        token: target.token,
      });
      setProvisionResult(result);
      setManualPath(result.backendPath);
      onProvisioned(result, {
        username: nasUser.trim(),
        secret: nasSecret,
        useTls,
        fritzPassword: fritzExtraPassword || undefined,
      });
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : 'Backend-Pfad wird in der lokalen Storage-Bridge gespeichert (kein Verbindungsabbruch).'
      );
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="NAS-Dateistruktur & EntenCenter-Backend anlegen"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
    >
      <div className="w-full max-w-[min(48rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] rounded-2xl bg-[#121722] border border-slate-700/80 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 sm:py-4 bg-[#0F141E] border-b border-slate-800 shrink-0">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
              <h2 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                {target.friendlyName || `NAS (${target.host})`} — EntenCenter-Backend einrichten
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-medium">
                <CheckCircle2 className="w-3 h-3" />
                Verbindung bleibt aktiv (Storage-Bridge · kein Abbruch)
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-slate-300">
                {protocolLabel} · {target.host}
                {target.port ? `:${target.port}` : ''}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dialog schließen (Verbindung bleibt bestehen)"
            className="p-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {/* Erklärungsbanner: Warum kein Verbindungsabbruch */}
          <div className="rounded-xl bg-sky-500/10 border border-sky-500/35 px-3.5 py-2.5 text-xs text-sky-100 flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-semibold text-sky-200">
                NAS Storage-Bridge einrichten &amp; Backend-Pfad prüfen
              </p>
              <p className="text-[11px] text-sky-100/85">
                Die Verbindung zum NAS bleibt aktiv — ein separater EntenCenter-:3000-Server ist
                nicht nötig. Wähle in der Dateistruktur den Backend-Ordner (z. B.{' '}
                <code className="font-mono text-sky-200">/FRITZ/EntenCenter-Backend</code>), um alle
                App-Daten direkt aufs NAS zu schreiben oder ein bestehendes Backend einzubinden.
              </p>
            </div>
          </div>

          {/* Zugangsdaten (inkl. dediziertem Feld „Passwort für die FRITZ!Box“) */}
          <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setShowCreds((prev) => !prev)}
                className="text-xs font-medium text-slate-200 flex items-center gap-1.5 hover:text-amber-300 transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                <span>
                  NAS- &amp; FRITZ!Box-Zugangsdaten für Live-Dateibaum ({showCreds ? 'ausblenden' : 'einblenden'})
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-1.5">
                {(treeData?.requiresAuth || target.requiresAuth) && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-amber-400/15 border border-amber-400/40 text-amber-300 font-medium">
                    FRITZ!Box-Anmeldung erforderlich
                  </span>
                )}
                {target.protocol !== 'fritz_upnp' && !(isFritzTarget || needExtraFritzPw) && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreds(true);
                      setNeedExtraFritzPw(true);
                    }}
                    className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300 hover:bg-sky-500/25 font-medium transition-colors"
                  >
                    + FRITZ!Box-Passwort extra
                  </button>
                )}
              </div>
            </div>

            {showCreds && (
              <div className="space-y-2.5 pt-1">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                  <div className="sm:col-span-4 space-y-1">
                    <label
                      htmlFor="prov-nas-user"
                      className="text-[10px] font-medium text-slate-400 block"
                    >
                      {target.protocol === 'fritz_upnp'
                        ? 'FRITZ!Box-Benutzer (optional)'
                        : 'NAS-Benutzername'}
                    </label>
                    <input
                      id="prov-nas-user"
                      type="text"
                      value={nasUser}
                      onChange={(e) => setNasUser(e.target.value)}
                      placeholder={
                        target.protocol === 'fritz_upnp'
                          ? 'z. B. fritz1234 oder leer'
                          : 'Benutzername'
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                    />
                  </div>
                  <div className="sm:col-span-4 space-y-1">
                    <label
                      htmlFor="prov-nas-secret"
                      className="text-[10px] font-medium text-slate-400 block"
                    >
                      {target.protocol === 'fritz_upnp'
                        ? 'Passwort für die FRITZ!Box'
                        : 'NAS-Passwort / Freigabe-Kennwort'}
                    </label>
                    <div className="relative flex items-center">
                      <Lock className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="prov-nas-secret"
                        type={showNasSecretPw ? 'text' : 'password'}
                        value={nasSecret}
                        onChange={(e) => setNasSecret(e.target.value)}
                        placeholder={
                          target.protocol === 'fritz_upnp'
                            ? 'Passwort für die FRITZ!Box'
                            : 'NAS-Passwort'
                        }
                        className="w-full pl-7 pr-8 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                      />
                      <button
                        type="button"
                        onClick={() => setShowNasSecretPw((v) => !v)}
                        aria-label="Passwort anzeigen"
                        className="absolute right-2 text-slate-400 hover:text-slate-200"
                      >
                        {showNasSecretPw ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="sm:col-span-4">
                    <button
                      type="button"
                      onClick={() =>
                        isFritzTarget
                          ? void handleVerifyFritzAndLoad()
                          : void loadDirectory(currentPath, nasUser, nasSecret, useTls, fritzExtraPassword)
                      }
                      disabled={loadingTree || testingFritzLogin}
                      className="w-full px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-medium text-white flex items-center justify-center gap-1.5 transition-colors"
                    >
                      {isFritzTarget ? (
                        <Wifi className={`w-3.5 h-3.5 text-emerald-400 ${testingFritzLogin || loadingTree ? 'animate-pulse' : ''}`} />
                      ) : (
                        <RefreshCw className={`w-3.5 h-3.5 text-amber-400 ${loadingTree ? 'animate-spin' : ''}`} />
                      )}
                      <span>
                        {testingFritzLogin
                          ? 'Melde an FRITZ!Box an…'
                          : isFritzTarget
                            ? 'FRITZ!Box-Login & Baum laden'
                            : 'Dateistruktur live laden'}
                      </span>
                    </button>
                  </div>
                </div>

                {target.protocol !== 'fritz_upnp' && (isFritzTarget || treeData?.requiresAuth || needExtraFritzPw) && (
                  <div className="rounded-lg bg-sky-500/10 border border-sky-500/35 p-2.5 flex flex-col sm:flex-row sm:items-center gap-2">
                    <div className="flex-1 space-y-1">
                      <label
                        htmlFor="prov-fritz-extra-secret"
                        className="text-[11px] font-semibold text-sky-200 flex items-center gap-1.5"
                      >
                        <KeyRound className="w-3 h-3 text-sky-400" />
                        <span>Passwort für die FRITZ!Box (falls extra benötigt)</span>
                      </label>
                      <div className="relative flex items-center">
                        <Lock className="w-3 h-3 text-sky-400/70 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          id="prov-fritz-extra-secret"
                          type={showFritzExtraPw ? 'text' : 'password'}
                          value={fritzExtraPassword}
                          onChange={(e) => setFritzExtraPassword(e.target.value)}
                          placeholder="Separates FRITZ!Box-Kennwort (falls vom Router verlangt)"
                          className="w-full pl-7 pr-8 py-1.5 rounded-lg bg-[#121722] border border-sky-500/40 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                        />
                        <button
                          type="button"
                          onClick={() => setShowFritzExtraPw((v) => !v)}
                          aria-label="FRITZ!Box-Passwort anzeigen"
                          className="absolute right-2 text-slate-400 hover:text-slate-200"
                        >
                          {showFritzExtraPw ? (
                            <EyeOff className="w-3.5 h-3.5" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer w-fit">
                  <input
                    type="checkbox"
                    checked={useTls}
                    onChange={(e) => setUseTls(e.target.checked)}
                    className="accent-emerald-400 rounded"
                  />
                  <span>HTTPS bevorzugen (automatischer HTTP-Fallback :80 im LAN aktiv)</span>
                </label>

                {fritzLoginNote && (
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/40 px-2.5 py-1.5 text-[11px] text-emerald-200">
                    {fritzLoginNote}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* NAS-Verzeichnisbaum */}
          <div className="rounded-xl bg-[#0B0E14] border border-slate-800 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 bg-[#0F141E] border-b border-slate-800">
              <div className="flex flex-wrap items-center gap-1 text-xs min-w-0">
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={crumb.path}>
                    {idx > 0 && <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />}
                    <button
                      type="button"
                      onClick={() => void loadDirectory(crumb.path)}
                      className={`px-1.5 py-0.5 rounded font-mono text-[11px] transition-colors ${
                        crumb.path === currentPath
                          ? 'bg-amber-400/15 text-amber-300 font-semibold'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {crumb.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                {treeData?.parentPath && (
                  <button
                    type="button"
                    onClick={() => void loadDirectory(treeData.parentPath!)}
                    className="px-2 py-1 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center gap-1"
                  >
                    <CornerLeftUp className="w-3 h-3" />
                    <span>Hoch</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadDirectory(currentPath)}
                  className="px-2 py-1 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center gap-1"
                >
                  <RefreshCw className={`w-3 h-3 ${loadingTree ? 'animate-spin' : ''}`} />
                  <span>Aktualisieren</span>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#0F141E] border-b border-slate-800/80 text-[10px]">
              <div className="flex flex-wrap items-center gap-1.5">
                {treeData && treeData.source !== 'nas_template' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-semibold">
                    <CheckCircle2 className="w-3 h-3" />
                    Live-Dateisystem (
                    {treeData.source === 'smb_live'
                      ? `SMB2${treeData.smbShare ? ` · ${treeData.smbShare}` : ''}`
                      : treeData.source === 'fritz_nas_api'
                        ? 'FRITZ!NAS API'
                        : 'WebDAV'}
                    )
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 font-medium">
                    Vorlage (Offline/Schreibgeschützt — Login laden für Live-Baum)
                  </span>
                )}
                {treeData && (
                  <span
                    className={`px-2 py-0.5 rounded border font-medium ${
                      treeData.writable
                        ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                        : 'bg-rose-500/10 border-rose-500/35 text-rose-300'
                    }`}
                  >
                    {treeData.writable ? 'Schreibrechte OK' : 'Nur Lesen / Passwort nötig'}
                  </span>
                )}
              </div>
              {treeData?.effectiveUser && (
                <span className="font-mono text-slate-400">Benutzer: {treeData.effectiveUser}</span>
              )}
            </div>

            {treeData?.warning && (
              <div className="px-3 py-2 bg-amber-400/5 border-b border-slate-800/80 text-[11px] text-amber-200/90">
                {treeData.warning}
              </div>
            )}

            <div className="divide-y divide-slate-800/60 max-h-52 overflow-y-auto">
              {loadingTree ? (
                <div className="p-4 text-xs text-slate-400 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                  <span>Lade NAS-Dateistruktur…</span>
                </div>
              ) : (treeData?.entries ?? []).length === 0 ? (
                <div className="p-4 text-xs text-slate-400">
                  Dieser Ordner enthält noch keine sichtbaren Unterordner. Erstelle unten einen
                  neuen Ordner oder gib den Pfad direkt ein.
                </div>
              ) : (
                (treeData?.entries ?? []).map((entry) => (
                  <div
                    key={entry.path}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-[#121722] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => handleEntryClick(entry)}
                      className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                    >
                      {entry.type === 'directory' ? (
                        <Folder
                          className={`w-4 h-4 shrink-0 ${
                            entry.recommended ? 'text-amber-400' : 'text-sky-400'
                          }`}
                        />
                      ) : (
                        <FileCode2 className="w-4 h-4 shrink-0 text-slate-500" />
                      )}
                      <span className="text-xs font-mono text-white truncate">{entry.name}</span>
                      {entry.recommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/15 border border-amber-400/35 text-amber-300 shrink-0">
                          Empfohlen
                        </span>
                      )}
                    </button>
                    {entry.type === 'directory' && (
                      <button
                        type="button"
                        onClick={() =>
                          setManualPath(
                            entry.name.toLowerCase().includes('entencenter')
                              ? entry.path
                              : `${entry.path}/EntenCenter-Backend`
                          )
                        }
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-amber-400 hover:text-slate-950 border border-slate-700 text-[10px] font-medium text-slate-200 transition-colors whitespace-nowrap"
                      >
                        Als Zielpfad
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Inline neuen Ordner direkt auf dem NAS / in der Dateistruktur anlegen */}
            <div className="flex flex-col sm:flex-row gap-2 px-3 py-2.5 bg-[#0F141E] border-t border-slate-800">
              <div className="relative flex-1">
                <FolderPlus className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={newSubfolderName}
                  onChange={(e) => setNewSubfolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSubfolderName.trim() && !creatingSubfolder) {
                      e.preventDefault();
                      void handleCreateSubfolderLive();
                    }
                  }}
                  placeholder={`Neuen Unterordner in ${currentPath} erstellen (z. B. EntenCenter)`}
                  className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleCreateSubfolderLive()}
                disabled={!newSubfolderName.trim() || creatingSubfolder}
                className="px-3.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                <span>{creatingSubfolder ? 'Lege an…' : 'OK · Anlegen'}</span>
              </button>
            </div>
          </div>

          {/* Manueller Backend-Zielpfad mit explizitem OK-Button */}
          <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-3.5 space-y-2">
            <label
              htmlFor="nas-manual-backend-path"
              className="block text-xs font-semibold text-white"
            >
              Manueller Backend-Pfad auf dem NAS
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="nas-manual-backend-path"
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && manualPath.trim() && !provisioning) {
                    e.preventDefault();
                    void handleProvision('manual');
                  }
                }}
                placeholder="/FRITZ/EntenCenter-Backend oder /EntenCenter-Backend"
                className="flex-1 px-3 py-2 rounded-lg bg-[#121722] border border-slate-700 text-xs sm:text-sm font-mono text-amber-300 focus:outline-none focus:border-amber-400"
              />
              <button
                type="button"
                disabled={provisioning || !manualPath.trim()}
                onClick={() => void handleProvision('manual')}
                className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{provisioning ? 'Speichere…' : 'OK'}</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              EntenCenter legt dort automatisch <code className="font-mono text-slate-300">profiles/</code>,{' '}
              <code className="font-mono text-slate-300">media/</code>,{' '}
              <code className="font-mono text-slate-300">config/</code>,{' '}
              <code className="font-mono text-slate-300">wal/</code> sowie{' '}
              <code className="font-mono text-slate-300">entencenter-backend.json</code> &amp;{' '}
              <code className="font-mono text-slate-300">docker-compose.yml</code> an.
            </p>
          </div>

          {localError && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2 text-xs text-amber-200">
              {localError}
            </div>
          )}

          {provisionResult && (
            <div
              className={`rounded-xl border p-3.5 space-y-2 text-xs ${
                provisionResult.remoteWriteOk
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-100'
                  : 'bg-amber-500/10 border-amber-500/40 text-amber-100'
              }`}
            >
              <div
                className={`flex flex-wrap items-center justify-between gap-2 font-semibold ${
                  provisionResult.remoteWriteOk ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 shrink-0" />
                  <span>{provisionResult.message}</span>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                    provisionResult.remoteWriteOk
                      ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-200'
                      : 'bg-amber-500/20 border border-amber-500/40 text-amber-200'
                  }`}
                >
                  {provisionResult.remoteWriteOk
                    ? 'Direkt auf NAS geschrieben'
                    : 'Nur Storage-Bridge'}
                </span>
              </div>
              {provisionResult.warning && (
                <p className="text-[11px] text-amber-200">{provisionResult.warning}</p>
              )}
              <div className="text-[11px] font-mono opacity-90 space-y-0.5">
                <p>Pfad: {provisionResult.backendPath}</p>
                <p>Ordner: {provisionResult.createdDirectories.join(', ')}</p>
              </div>
            </div>
          )}

          {/* Aktions-Buttons: Automatisch vs. Manuell */}
          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              disabled={provisioning}
              onClick={() => void handleProvision('auto')}
              className="flex-1 py-2.5 px-4 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>
                {provisioning ? 'Lege Backend an…' : 'Automatisch anlegen'}
              </span>
            </button>
            <button
              type="button"
              disabled={provisioning || !manualPath.trim()}
              onClick={() => void handleProvision('manual')}
              className="flex-1 py-2.5 px-4 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-50 border border-sky-400/50 text-sky-200 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <FolderPlus className="w-4 h-4 shrink-0" />
              <span>OK — Am Pfad anlegen</span>
            </button>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 transition-colors"
            >
              {provisionResult ? 'OK · Schließen' : 'Schließen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
