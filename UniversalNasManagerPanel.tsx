import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  KeyRound,
  Lock,
  Plus,
  Radar,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wifi,
  XCircle,
} from 'lucide-react';
import {
  discoverLocalNasDevices,
  isLocalOrLanHost,
  isNativeAndroidShell,
  loginUniversalNas,
  probeUniversalNas,
  testUniversalNasConnection,
} from '../lib/nasClient';
import {
  getVaultNasSecret,
  isAndroidKeystoreBacked,
  listVaultNasEntries,
  redactSensitiveText,
  removeVaultNasEntry,
  setActiveVaultNasEntry,
  updateVaultNasEntryStatus,
  upsertVaultNasEntry,
} from '../lib/secureCredentialVault';
import {
  DiscoveredNasDevice,
  FritzTrackStatus,
  NAS_PROTOCOL_CATALOG,
  NasConnectionScope,
  NasProtocolId,
  NasProtocolVerificationResult,
  NasTransportRole,
  NasUser,
  NasVendorId,
  UniversalNasCredentialEntry,
  UniversalNasProbeResponse,
} from '../types/marcente';

interface UniversalNasManagerPanelProps {
  initialHost?: string;
  onAuthenticated: (token: string, user: NasUser) => void;
  onAdoptConnectionToForm?: (conn: {
    host: string;
    port: string;
    protocol: NasProtocolId;
    shareOrPath: string;
    username: string;
    password: string;
    useTls: boolean;
    scope: NasConnectionScope;
    fritzTracks?: FritzTrackStatus | null;
  }) => void;
}

const MANUAL_PROTOCOLS: Array<{ id: NasProtocolId; label: string; defaultPort: string }> = [
  { id: 'smb', label: '1. SMB 2/3 (Bevorzugt, Dateizugriff)', defaultPort: '445' },
  { id: 'webdav', label: '2. WebDAV über HTTPS', defaultPort: '5006' },
  { id: 'sftp', label: '3. SFTP (SSH-2.0)', defaultPort: '22' },
  { id: 'ftps', label: '4. FTPS / FTP mit TLS', defaultPort: '21' },
  { id: 'api_token', label: '5. Hersteller-API (Synology/QNAP/WD/TrueNAS)', defaultPort: '5001' },
  { id: 'fritz_upnp', label: '6. UPnP/DLNA (Nur Medienwiedergabe)', defaultPort: '49000' },
];

export const UniversalNasManagerPanel: React.FC<UniversalNasManagerPanelProps> = ({
  initialHost = '',
  onAuthenticated,
  onAdoptConnectionToForm,
}) => {
  const nativeShell = isNativeAndroidShell();
  const keystoreProtected = isAndroidKeystoreBacked();

  const [entries, setEntries] = useState<UniversalNasCredentialEntry[]>(() => listVaultNasEntries());
  const [expanded, setExpanded] = useState<boolean>(true);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredNasDevice[]>([]);

  const [profileName, setProfileName] = useState('');
  const [host, setHost] = useState(initialHost);
  const [scope, setScope] = useState<NasConnectionScope>(() =>
    initialHost ? (isLocalOrLanHost(initialHost) ? 'lan' : 'internet') : 'lan'
  );
  const [selectionMode, setSelectionMode] = useState<'auto' | 'manual'>('auto');
  const [protocol, setProtocol] = useState<NasProtocolId>('smb');
  const [port, setPort] = useState('');
  const [shareOrPath, setShareOrPath] = useState('/Medien');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [useTls, setUseTls] = useState(true);

  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<UniversalNasProbeResponse | null>(null);
  const [singleTestResult, setSingleTestResult] = useState<NasProtocolVerificationResult | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialHost && !host) {
      setHost(initialHost);
      setScope(isLocalOrLanHost(initialHost) ? 'lan' : 'internet');
    }
  }, [host, initialHost]);

  const handleHostChange = (val: string) => {
    setHost(val);
    if (val.trim()) {
      const lan = isLocalOrLanHost(val);
      if (lan && scope !== 'lan') setScope('lan');
      else if (!lan && scope === 'lan') setScope('internet');
    }
  };

  const handleScanDevices = async () => {
    setDiscoveryBusy(true);
    setErrorMessage(null);
    try {
      const res = await discoverLocalNasDevices({ includeSubnetProbe: true });
      setDiscoveredDevices(res.devices);
      if (res.devices.length === 0) {
        setStatusMessage('Kein NAS automatisch per mDNS/SSDP gefunden — bitte IP/Hostname manuell eintragen.');
      } else {
        setStatusMessage(`${res.devices.length} NAS-Gerät(e) im Heimnetz gefunden.`);
      }
    } catch {
      setErrorMessage('Netzwerk-Suche konnte nicht abgeschlossen werden.');
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const handleAdoptDiscovered = (dev: DiscoveredNasDevice) => {
    const cleanHost = dev.ip || dev.hostname;
    const preferredSvc =
      dev.services.find((s) => s.protocol === 'smb') ??
      dev.services.find((s) => s.protocol === 'webdav') ??
      dev.services.find((s) => s.protocol !== 'entencenter') ??
      dev.services[0];
    setProfileName(dev.name);
    setHost(cleanHost);
    setScope('lan');
    if (preferredSvc && preferredSvc.protocol !== 'entencenter') {
      setProtocol(preferredSvc.protocol);
      setPort(preferredSvc.port);
      setUseTls(preferredSvc.scheme === 'https');
      if (preferredSvc.path) setShareOrPath(preferredSvc.path);
    } else {
      setProtocol('smb');
      setPort('445');
      setUseTls(false);
    }
    setErrorMessage(null);
    setStatusMessage(`„${dev.name}“ (${cleanHost}) übernommen. Jetzt Protokolle prüfen oder direkt testen.`);
  };

  const handleTestConnection = useCallback(async () => {
    const cleanHost = host.trim();
    if (!cleanHost) {
      setErrorMessage('Bitte gib zuerst IP-Adresse oder Hostname des NAS ein.');
      return;
    }

    setTesting(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setWarningMessage(null);
    setSingleTestResult(null);

    try {
      if (selectionMode === 'auto') {
        const probe = await probeUniversalNas({
          host: cleanHost,
          port: port.trim() || undefined,
          shareOrPath: shareOrPath.trim() || '/',
          username: username.trim(),
          password,
          useTls,
          scope,
        });
        setProbeResult(probe);

        if (probe.recommendedProtocol) {
          setProtocol(probe.recommendedProtocol);
          if (probe.recommendedPort) setPort(String(probe.recommendedPort));
        }

        if (probe.fritzTracks?.mismatchWarning) {
          setWarningMessage(probe.fritzTracks.mismatchWarning);
        } else if (probe.vpnRequiredForSmb) {
          setWarningMessage(
            'Externer Zugriff erkannt: SMB (:445) wird ohne VPN aus Sicherheitsgründen blockiert. Nutze WireGuard/IPSec VPN oder WebDAV über HTTPS / SFTP.'
          );
        }

        if (probe.ok) {
          setStatusMessage(redactSensitiveText(probe.userFriendlySummary, [password]));
        } else {
          setErrorMessage(
            redactSensitiveText(
              probe.errors[0] || probe.userFriendlySummary,
              [password]
            )
          );
        }
      } else {
        const test = await testUniversalNasConnection({
          host: cleanHost,
          port: port.trim() || undefined,
          protocol,
          shareOrPath: shareOrPath.trim() || '/',
          username: username.trim(),
          password,
          useTls,
          scope,
        });
        setSingleTestResult(test.verification);
        if (test.verification?.warning) {
          setWarningMessage(redactSensitiveText(test.verification.warning, [password]));
        }
        if (test.ok && test.verification) {
          setStatusMessage(redactSensitiveText(test.verification.message, [password]));
        } else {
          setErrorMessage(
            redactSensitiveText(
              test.error || test.verification?.message || 'Protokollprüfung fehlgeschlagen.',
              [password]
            )
          );
        }
      }
    } finally {
      setTesting(false);
    }
  }, [host, password, port, protocol, scope, selectionMode, shareOrPath, useTls, username]);

  const handleSaveAndConnect = async () => {
    const cleanHost = host.trim();
    if (!cleanHost) {
      setErrorMessage('Bitte gib zuerst Hostname oder IP-Adresse des NAS ein.');
      return;
    }

    setConnecting(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setWarningMessage(null);

    try {
      const loginRes = await loginUniversalNas({
        host: cleanHost,
        port: port.trim() || undefined,
        protocol: selectionMode === 'auto' ? 'auto' : protocol,
        shareOrPath: shareOrPath.trim() || '/',
        username: username.trim(),
        password,
        displayName: profileName.trim() || undefined,
        useTls,
        scope,
      });

      if (loginRes.probe) setProbeResult(loginRes.probe);
      if (loginRes.verification) setSingleTestResult(loginRes.verification);

      const effectiveProtocol =
        loginRes.verification?.protocol ??
        loginRes.probe?.recommendedProtocol ??
        protocol;
      const effectivePort = String(
        loginRes.verification?.port ??
          loginRes.probe?.recommendedPort ??
          (port.trim() || '445')
      );
      const effectiveVendor: NasVendorId =
        loginRes.probe?.detectedVendor ??
        (cleanHost.toLowerCase().includes('fritz') ? 'avm_fritzbox' : 'standard_nas');

      const caps: NasTransportRole[] = [];
      if (loginRes.probe?.resultsByPriority) {
        for (const r of loginRes.probe.resultsByPriority) {
          if (r.protocolVerified && !caps.includes(r.role)) caps.push(r.role);
        }
      }
      if (caps.length === 0) {
        caps.push(effectiveProtocol === 'fritz_upnp' ? 'media_only' : 'file_access');
      }

      const nextStatus: UniversalNasCredentialEntry['lastStatus'] = loginRes.ok
        ? 'online'
        : loginRes.verification?.blockedByVpnPolicy
          ? 'vpn_required'
          : loginRes.verification?.smb1Rejected
            ? 'smb_blocked'
            : loginRes.verification?.authAttempted && !loginRes.verification?.authVerified
              ? 'auth_failed'
              : 'offline';

      const updatedEntries = await upsertVaultNasEntry(
        {
          name: profileName.trim() || `${cleanHost} (${effectiveProtocol.toUpperCase()})`,
          vendor: effectiveVendor,
          scope,
          protocol: effectiveProtocol,
          host: cleanHost,
          port: effectivePort,
          shareOrPath: shareOrPath.trim() || '/',
          username: username.trim(),
          useTls: loginRes.verification?.useTls ?? useTls,
          autoReconnect: true,
          capabilityTags: caps,
          lastStatus: nextStatus,
          lastLatencyMs: loginRes.verification?.latencyMs ?? null,
          lastMessage: loginRes.ok
            ? loginRes.verification?.message || 'Verifiziert & verbunden'
            : loginRes.error || 'Prüfung fehlgeschlagen',
          fritzTracks: loginRes.probe?.fritzTracks ?? null,
          setActive: loginRes.ok,
        },
        password
      );
      setEntries(updatedEntries);

      if (loginRes.warning) {
        setWarningMessage(redactSensitiveText(loginRes.warning, [password]));
      }

      if (!loginRes.ok) {
        setErrorMessage(
          redactSensitiveText(
            loginRes.error || 'NAS-Anmeldung fehlgeschlagen. Zugangsdaten bleiben verschlüsselt gespeichert.',
            [password]
          )
        );
        return;
      }

      if (loginRes.token && loginRes.user) {
        onAuthenticated(loginRes.token, loginRes.user);
        return;
      }

      // Direkt-NAS ohne EntenCenter-:3000-Backend erfolgreich verifiziert -> in Formular übernehmen
      onAdoptConnectionToForm?.({
        host: cleanHost,
        port: effectivePort,
        protocol: effectiveProtocol,
        shareOrPath: shareOrPath.trim() || '/',
        username: username.trim(),
        password,
        useTls: loginRes.verification?.useTls ?? useTls,
        scope,
        fritzTracks: loginRes.probe?.fritzTracks ?? null,
      });
      setStatusMessage(
        `NAS „${cleanHost}“ über ${effectiveProtocol.toUpperCase()} (:${effectivePort}) erfolgreich verifiziert & verschlüsselt eingebunden (kein Port 3000 nötig).`
      );
    } finally {
      setConnecting(false);
    }
  };

  const handleReconnectEntry = async (entry: UniversalNasCredentialEntry) => {
    setReconnectingId(entry.id);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const secret = await getVaultNasSecret(entry.id);
      const test = await testUniversalNasConnection({
        host: entry.host,
        port: entry.port,
        protocol: entry.protocol,
        shareOrPath: entry.shareOrPath,
        username: entry.username,
        password: secret,
        useTls: entry.useTls,
        scope: entry.scope,
      });

      const status: UniversalNasCredentialEntry['lastStatus'] = test.ok
        ? 'online'
        : test.verification?.blockedByVpnPolicy
          ? 'vpn_required'
          : test.verification?.smb1Rejected
            ? 'smb_blocked'
            : test.verification?.authAttempted && !test.verification?.authVerified
              ? 'auth_failed'
              : 'offline';

      const nextList = updateVaultNasEntryStatus(entry.id, {
        lastStatus: status,
        lastLatencyMs: test.verification?.latencyMs ?? null,
        lastVerifiedAt: test.ok ? new Date().toISOString() : entry.lastVerifiedAt,
        lastMessage: test.verification?.message || test.error || 'Reconnect geprüft',
      });
      setEntries(nextList);

      if (test.ok) {
        setActiveVaultNasEntry(entry.id);
        setEntries(listVaultNasEntries());
        setStatusMessage(
          `Wiederverbindung zu „${entry.name}“ (${entry.protocol.toUpperCase()} :${entry.port}) erfolgreich (${test.verification?.latencyMs ?? '-'} ms).`
        );
        onAdoptConnectionToForm?.({
          host: entry.host,
          port: entry.port,
          protocol: entry.protocol,
          shareOrPath: entry.shareOrPath,
          username: entry.username,
          password: secret,
          useTls: entry.useTls,
          scope: entry.scope,
          fritzTracks: entry.fritzTracks ?? null,
        });
      } else {
        setErrorMessage(
          redactSensitiveText(
            test.error || test.verification?.message || `Wiederverbindung zu „${entry.name}“ fehlgeschlagen.`,
            [secret]
          )
        );
      }
    } finally {
      setReconnectingId(null);
    }
  };

  const handleRemoveEntry = (id: string) => {
    setEntries(removeVaultNasEntry(id));
  };

  const visibleProtocols: NasProtocolVerificationResult[] = probeResult?.resultsByPriority ?? (
    singleTestResult ? [singleTestResult] : []
  );

  return (
    <div className="rounded-xl bg-[#0B0E14] border border-slate-800/90 p-4 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left"
        >
          <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <span className="text-xs sm:text-sm font-semibold text-white block">
              Universelle NAS-Anmeldung &amp; Multi-NAS-Verwaltung
            </span>
            <span className="text-[10px] text-slate-400 block">
              FRITZ!NAS · Synology · QNAP · Western Digital · SMB 2/3 · WebDAV · SFTP · FTPS (ohne Port 3000)
            </span>
          </div>
        </button>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/35 text-[10px] font-medium text-emerald-300">
            <ShieldCheck className="w-3 h-3" />
            <span>
              {nativeShell && keystoreProtected ? 'Android Keystore AES-256' : 'WebCrypto AES-GCM'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-slate-400 hover:text-white px-2 py-0.5 rounded border border-slate-800"
          >
            {expanded ? 'Kompakt' : 'Öffnen'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3.5 pt-1 border-t border-slate-800/80">
          {/* NAS Suche & Schnelle Übernahme */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleScanDevices()}
                disabled={discoveryBusy}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/45 text-[11px] font-medium text-emerald-200 flex items-center gap-1.5 transition-colors"
              >
                <Radar className={`w-3.5 h-3.5 ${discoveryBusy ? 'animate-spin' : ''}`} />
                <span>{discoveryBusy ? 'Suche NAS im LAN…' : 'NAS automatisch suchen'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setProfileName('');
                  setHost('');
                  setUsername('');
                  setPassword('');
                  setProbeResult(null);
                  setSingleTestResult(null);
                  setErrorMessage(null);
                  setStatusMessage(null);
                }}
                className="px-2.5 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5 text-amber-400" />
                <span>Manuell hinzufügen</span>
              </button>
            </div>

            <div className="flex items-center gap-1 bg-[#121722] p-0.5 rounded-lg border border-slate-800 text-[10px]">
              {(['lan', 'vpn', 'internet'] as NasConnectionScope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`px-2 py-1 rounded-md font-medium uppercase ${
                    scope === s
                      ? 'bg-amber-400/20 text-amber-200 border border-amber-400/50'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s === 'lan' ? 'LAN' : s === 'vpn' ? 'VPN' : 'Internet'}
                </button>
              ))}
            </div>
          </div>

          {discoveredDevices.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {discoveredDevices.map((d) => (
                <button
                  key={`univ-disc-${d.id}`}
                  type="button"
                  onClick={() => handleAdoptDiscovered(d)}
                  className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 border border-emerald-500/40 text-[11px] text-emerald-200 font-mono"
                >
                  {d.vendor}: {d.ip}
                </button>
              ))}
            </div>
          )}

          {/* Eingabefelder Host, Name, Protokoll-Modus, Credentials */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[10px] font-medium text-slate-400 mb-1">
                NAS-Host / IP (z. B. fritz.box, 192.168.178.10)
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => handleHostChange(e.target.value)}
                placeholder="fritz.box oder 192.168.178.x"
                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-slate-400 mb-1">
                Anzeigename für Multi-NAS (optional)
              </label>
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="z. B. Wohnzimmer Synology / FRITZ!NAS"
                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
              />
            </div>
          </div>

          {/* Verbindungsmethode Auto vs Manuell */}
          <div className="rounded-lg bg-[#121722] border border-slate-800 p-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-300">
                Verbindungsmethode
              </span>
              <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded-md border border-slate-800 text-[10px]">
                <button
                  type="button"
                  onClick={() => setSelectionMode('auto')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    selectionMode === 'auto'
                      ? 'bg-amber-400 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Automatisch (Priorität 1→6)
                </button>
                <button
                  type="button"
                  onClick={() => setSelectionMode('manual')}
                  className={`px-2 py-0.5 rounded font-medium ${
                    selectionMode === 'manual'
                      ? 'bg-amber-400 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Manuell wählen
                </button>
              </div>
            </div>

            {selectionMode === 'manual' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                <div className="sm:col-span-2">
                  <select
                    value={protocol}
                    onChange={(e) => {
                      const next = e.target.value as NasProtocolId;
                      setProtocol(next);
                      const meta = MANUAL_PROTOCOLS.find((m) => m.id === next) ?? NAS_PROTOCOL_CATALOG.find((m) => m.id === next);
                      if (meta) setPort(meta.defaultPort);
                      setUseTls(next === 'webdav' || next === 'ftps' || next === 'api_token');
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {MANUAL_PROTOCOLS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="Port"
                    className="w-20 px-2 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                  />
                  <input
                    type="text"
                    value={shareOrPath}
                    onChange={(e) => setShareOrPath(e.target.value)}
                    placeholder="/Medien"
                    className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Benutzername & Passwort */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="NAS-Benutzername"
              autoComplete="username"
              className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
            <div className="relative">
              <Lock className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="NAS-Passwort (verschlüsselt)"
                autoComplete="current-password"
                className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
            </div>
            <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-[11px] text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useTls}
                onChange={(e) => setUseTls(e.target.checked)}
                className="accent-amber-400 rounded"
              />
              <span>TLS / HTTPS erzwingen</span>
            </label>
          </div>

          {/* Sicherheitswarnung SMB über Internet ohne VPN */}
          {(scope === 'internet' && (protocol === 'smb' || selectionMode === 'auto')) && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-[11px] text-amber-200 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Sicherheitsrichtlinie: SMB (Port 445) wird im Modus <strong>Internet</strong> ohne VPN automatisch gesperrt. Aktiviere oben <strong>VPN</strong> oder nutze <strong>WebDAV über HTTPS</strong> / <strong>SFTP</strong>.
              </span>
            </div>
          )}

          {/* Aktionsbuttons */}
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              disabled={testing || connecting}
              onClick={() => void handleTestConnection()}
              className="px-3 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-60 border border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-amber-400 ${testing ? 'animate-spin' : ''}`} />
              <span>{testing ? 'Prüfe Protokolle…' : 'Verbindung & Protokolle testen'}</span>
            </button>
            <button
              type="button"
              disabled={testing || connecting}
              onClick={() => void handleSaveAndConnect()}
              className="flex-1 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center justify-center gap-1.5"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>{connecting ? 'Verbinde & speichere…' : 'Verschlüsselt speichern & NAS verbinden'}</span>
            </button>
          </div>

          {/* Meldungen */}
          {warningMessage && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-[11px] text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>{warningMessage}</span>
            </div>
          )}
          {statusMessage && (
            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-[11px] text-emerald-200 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>{statusMessage}</span>
            </div>
          )}
          {errorMessage && (
            <div className="p-2.5 rounded-lg bg-red-950/50 border border-red-800/70 text-[11px] text-red-200 flex items-start gap-2">
              <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Protokoll-Ergebnisse nach Priorität */}
          {visibleProtocols.length > 0 && (
            <div className="rounded-lg bg-[#121722] border border-slate-800 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-white">
                  Protokollprüfung {probeResult ? `· ${probeResult.vendorLabel}` : ''}
                </span>
                {probeResult?.resolvedIp && (
                  <span className="font-mono text-slate-400">{probeResult.resolvedIp}</span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {visibleProtocols.map((r) => (
                  <div
                    key={`${r.protocol}-${r.port}`}
                    className={`rounded-md p-2 border text-[10px] space-y-0.5 ${
                      r.protocolVerified && !r.smb1Rejected && !r.blockedByVpnPolicy
                        ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-100'
                        : r.smb1Rejected || r.blockedByVpnPolicy
                          ? 'bg-red-950/40 border-red-800/60 text-red-200'
                          : 'bg-[#0B0E14] border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 font-mono">
                      <span className="font-semibold">
                        {r.priority}. {r.label} (:{r.port})
                      </span>
                      <span>
                        {r.smb1Rejected
                          ? 'SMB1 abgelehnt'
                          : r.blockedByVpnPolicy
                            ? 'VPN nötig'
                            : r.protocolVerified
                              ? r.role === 'media_only'
                                ? 'Nur Medien'
                                : r.authVerified
                                  ? `✓ Auth (${r.latencyMs ?? 1}ms)`
                                  : `✓ Bereit (${r.latencyMs ?? 1}ms)`
                              : 'Aus'}
                      </span>
                    </div>
                    <p className="text-[10px] opacity-85 leading-snug">{r.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Getrennte FRITZ!Box Spuren: WebUI SID vs SMB vs TR-064 vs UPnP */}
          {probeResult?.fritzTracks?.detected && (
            <div className="rounded-lg bg-[#121722] border border-sky-500/35 p-2.5 space-y-1.5 text-[10px]">
              <div className="flex items-center gap-1.5 font-semibold text-sky-200">
                <Wifi className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  FRITZ!Box Schnittstellen getrennt ({probeResult.fritzTracks.friendlyName || 'AVM FRITZ!OS'})
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                <div className="p-1.5 rounded bg-[#0B0E14] border border-slate-800">
                  <div className="text-slate-400">WebUI SID</div>
                  <div className={probeResult.fritzTracks.webuiSid.authenticated ? 'text-emerald-300 font-semibold' : 'text-slate-200'}>
                    {probeResult.fritzTracks.webuiSid.authenticated
                      ? 'SID aktiv'
                      : probeResult.fritzTracks.webuiSid.reachable
                        ? 'Login bereit'
                        : 'Nicht aktiv'}
                  </div>
                </div>
                <div className="p-1.5 rounded bg-[#0B0E14] border border-slate-800">
                  <div className="text-slate-400">SMB (:445 Datei)</div>
                  <div className={probeResult.fritzTracks.smbAccess.authVerified ? 'text-emerald-300 font-semibold' : probeResult.fritzTracks.smbAccess.protocolVerified ? 'text-amber-300' : 'text-red-300'}>
                    {probeResult.fritzTracks.smbAccess.authVerified
                      ? `${probeResult.fritzTracks.smbAccess.dialect || 'SMB'} ✓`
                      : probeResult.fritzTracks.smbAccess.protocolVerified
                        ? 'Auth prüfen'
                        : 'Blockiert'}
                  </div>
                </div>
                <div className="p-1.5 rounded bg-[#0B0E14] border border-slate-800">
                  <div className="text-slate-400">TR-064 (Steuerung)</div>
                  <div className={probeResult.fritzTracks.tr064.reachable ? 'text-emerald-300' : 'text-slate-400'}>
                    {probeResult.fritzTracks.tr064.reachable ? `Aktiv :${probeResult.fritzTracks.tr064.port}` : 'Aus'}
                  </div>
                </div>
                <div className="p-1.5 rounded bg-[#0B0E14] border border-slate-800">
                  <div className="text-slate-400">UPnP / DLNA</div>
                  <div className="text-amber-200">
                    {probeResult.fritzTracks.upnpMediaOnly.reachable ? 'Nur Medien :49000' : 'Aus'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Gespeicherte Multi-NAS-Systeme (gleichzeitig verwaltet) */}
          {entries.length > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between text-[11px] text-slate-300 font-medium">
                <span>Eingebundene NAS-Systeme ({entries.length})</span>
                <span className="text-[10px] text-slate-500">Verschlüsselte Wiederverbindung</span>
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-lg p-2 border flex flex-wrap items-center justify-between gap-2 text-[11px] ${
                      entry.isActive
                        ? 'bg-amber-400/10 border-amber-400/45'
                        : 'bg-[#121722] border-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Server className="w-3 h-3 text-amber-400 shrink-0" />
                        <span className="font-semibold text-white truncate">{entry.name}</span>
                        <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[9px] font-mono text-slate-300 uppercase">
                          {entry.protocol} :{entry.port}
                        </span>
                        <span
                          className={`text-[9px] font-semibold ${
                            entry.lastStatus === 'online'
                              ? 'text-emerald-300'
                              : entry.lastStatus === 'vpn_required' || entry.lastStatus === 'smb_blocked'
                                ? 'text-red-300'
                                : 'text-amber-300'
                          }`}
                        >
                          {entry.lastStatus === 'online'
                            ? `✓ Online${entry.lastLatencyMs ? ` (${entry.lastLatencyMs}ms)` : ''}`
                            : entry.lastStatus === 'vpn_required'
                              ? 'VPN nötig'
                              : entry.lastStatus === 'auth_failed'
                                ? 'Login prüfen'
                                : 'Prüfen'}
                        </span>
                      </div>
                      <p className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                        {entry.host} · {entry.username || 'anonym'} · {entry.scope.toUpperCase()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={reconnectingId === entry.id}
                        onClick={() => void handleReconnectEntry(entry)}
                        className="px-2 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[10px] text-amber-200 flex items-center gap-1"
                      >
                        <RefreshCw className={`w-3 h-3 ${reconnectingId === entry.id ? 'animate-spin' : ''}`} />
                        <span>Verbinden</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveEntry(entry.id)}
                        aria-label={`NAS ${entry.name} entfernen`}
                        className="p-1 rounded bg-[#0B0E14] hover:bg-red-950/60 border border-slate-800 text-slate-400 hover:text-red-300"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
