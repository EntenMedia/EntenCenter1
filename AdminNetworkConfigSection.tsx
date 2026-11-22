import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  HardDrive,
  KeyRound,
  LogOut,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Router,
  Save,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Wifi,
} from 'lucide-react';
import {
  AdminNetworkConfig,
  AdminNetworkConfigResponse,
  AdminNetworkConfigTestResult,
  AlternativePortScanResult,
  DiscoveredNasDevice,
  FritzNasBrowseItem,
  FritzSidSessionStatus,
  NasConnectionProfile,
  NasProfileScope,
  NasProtocolId,
  NasSecurityCertificateInfo,
  NetworkProfileMode,
  RemoteNasTransportType,
} from '../types/marcente';
import {
  cleanHostOnly,
  DEFAULT_ALTERNATIVE_PORTS,
  discoverLocalNasDevices,
  getAutoPortFallbackEnabled,
  getEffectiveNasOrigin,
  getNasBaseUrl,
  getPreferredAlternativePort,
  isMixedContentBlocked,
  normalizeNasBaseUrl,
  probeBridgeNasHealth,
  readAllLocalProvisionedBackends,
  readFileFromNasBridge,
  readLocalProvisionedBackendForHost,
  resolveNasUrl,
  sanitizeNasPortForProtocol,
  scanAlternativeNasPorts,
  setAutoPortFallbackEnabled,
  setNasBaseUrl,
  setPreferredAlternativePort,
  syncLocalTlsPolicyWithAndroidBridge,
  syncSharedNasCertificate,
  writeFileToNasBridge,
} from '../lib/nasClient';
import {
  isLocalFallbackToken,
  readLocalOnboardingBuffer,
} from '../lib/localBufferStore';
import {
  activateNasConnectionProfile,
  browseFritzNas,
  deleteNasConnectionProfile,
  fetchFritzSessionStatus,
  fetchNasConnectionProfiles,
  loginFritzSession,
  logoutFritzSession,
  saveNasConnectionProfile,
  testNasConnectionProfile,
} from '../lib/fritzSessionHelper';

const LOCAL_NETWORK_CONFIG_KEY = 'entencenter_local_admin_network_config_v1';

function extractHostnameSafe(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return parsed.hostname || '';
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0] || '';
  }
}

interface AdminNetworkConfigSectionProps {
  token: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const REMOTE_TRANSPORT_OPTIONS: Array<{
  id: RemoteNasTransportType;
  label: string;
  placeholder: string;
  hint: string;
}> = [
  {
    id: 'wan_dyndns',
    label: 'WAN / DynDNS / MyFRITZ',
    placeholder: 'https://mein-nas.myfritz.net:3000',
    hint: 'Öffentliche Domain oder DynDNS mit Router-Portweiterleitung.',
  },
  {
    id: 'vpn',
    label: 'VPN (WireGuard / Tailscale)',
    placeholder: 'http://100.64.0.10:3000',
    hint: 'Verschlüsselter VPN-Tunnel über WireGuard, Tailscale oder FRITZ!VPN.',
  },
  {
    id: 'reverse_proxy',
    label: 'Reverse Proxy (HTTPS)',
    placeholder: 'https://nas.meinedomain.de/entencenter',
    hint: 'NGINX, Caddy oder Synology Reverse Proxy inkl. optionalem Unterpfad.',
  },
];

const PROFILE_SCOPE_META: Record<
  NasProfileScope,
  { label: string; shortLabel: string; badgeClass: string; defaultHint: string }
> = {
  lan: {
    label: 'Heimnetz (LAN / WLAN)',
    shortLabel: 'Heimnetz LAN',
    badgeClass: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
    defaultHint: 'Direktes Subnetz (lokale selbstsignierte Zertifikate erlaubt)',
  },
  wan_dyndns: {
    label: 'Extern via DynDNS / MyFRITZ!',
    shortLabel: 'DynDNS / MyFRITZ',
    badgeClass: 'bg-sky-500/15 border-sky-500/40 text-sky-300',
    defaultHint: 'Öffentlicher DynDNS-Host mit Portweiterleitung',
  },
  domain_https: {
    label: 'Externe Domain (HTTPS / TLS)',
    shortLabel: 'Externe Domain',
    badgeClass: 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300',
    defaultHint: 'Eigene Domain mit gültigem TLS-Zertifikat',
  },
  vpn: {
    label: 'VPN-Tunnel (WireGuard / Tailscale)',
    shortLabel: 'VPN Tunnel',
    badgeClass: 'bg-violet-500/15 border-violet-500/40 text-violet-300',
    defaultHint: 'Verschlüsseltes Overlay-Netz / Heimnetz-VPN',
  },
  reverse_proxy: {
    label: 'Reverse Proxy (NGINX / Caddy / DSM)',
    shortLabel: 'Reverse Proxy',
    badgeClass: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
    defaultHint: 'HTTPS-Gateway inkl. optionalem Unterpfad',
  },
};

const PROFILE_PROTOCOL_OPTIONS: Array<{
  id: NasProtocolId;
  label: string;
  defaultPort: string;
  defaultTls: boolean;
}> = [
  { id: 'smb', label: 'SMB / CIFS (Windows / Samba)', defaultPort: '445', defaultTls: false },
  { id: 'webdav', label: 'WebDAV / WebDAVS (HTTPS)', defaultPort: '5006', defaultTls: true },
  { id: 'nfs', label: 'NFS (v3 / v4 / v4.1)', defaultPort: '2049', defaultTls: false },
  { id: 'sftp', label: 'SFTP / SSH', defaultPort: '22', defaultTls: true },
  { id: 'ftps', label: 'FTPS (Explicit / Implicit TLS)', defaultPort: '21', defaultTls: true },
  { id: 'api_token', label: 'NAS REST-API / Token (DSM / QTS / TrueNAS)', defaultPort: '5001', defaultTls: true },
  { id: 'fritz_upnp', label: 'FRITZ!Box UPnP / TR-064 / FRITZ!NAS', defaultPort: '49443', defaultTls: true },
];

export const AdminNetworkConfigSection: React.FC<AdminNetworkConfigSectionProps> = ({
  token,
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
  const [testingMode, setTestingMode] = useState<NetworkProfileMode | null>(null);
  const [applyingDevice, setApplyingDevice] = useState(false);
  const [scanningLan, setScanningLan] = useState(false);

  const initialBuf = readLocalOnboardingBuffer();
  const initialLanHost =
    initialBuf?.serverUrl ||
    (initialBuf?.nasConnection?.host ? `http://${initialBuf.nasConnection.host}` : '') ||
    getNasBaseUrl() ||
    '';

  const [savedConfig, setSavedConfig] = useState<AdminNetworkConfig | null>(null);
  const [activeModeDraft, setActiveModeDraft] = useState<NetworkProfileMode>('lan');
  const [lanAddressDraft, setLanAddressDraft] = useState(initialLanHost);
  const [remoteAddressDraft, setRemoteAddressDraft] = useState('');
  const [remoteTransportDraft, setRemoteTransportDraft] =
    useState<RemoteNasTransportType>('wan_dyndns');
  const [autoFallbackDraft, setAutoFallbackDraft] = useState(true);
  const [allowLocalSelfSignedDraft, setAllowLocalSelfSignedDraft] = useState(true);

  // Alternative zu Port 3000 & Automatischer Port-Scan
  const [preferredAltPortDraft, setPreferredAltPortDraft] = useState<number>(() =>
    getPreferredAlternativePort()
  );
  const [autoPortFallbackDraft, setAutoPortFallbackDraft] = useState<boolean>(() =>
    getAutoPortFallbackEnabled()
  );
  const [portScanTargetDraft, setPortScanTargetDraft] = useState<string>(initialLanHost);
  const [portScanBusy, setPortScanBusy] = useState(false);
  const [portScanResult, setPortScanResult] = useState<AlternativePortScanResult | null>(null);

  const [detectedLanUrls, setDetectedLanUrls] = useState<string[]>([]);
  const [localSubnets, setLocalSubnets] = useState<string[]>([]);
  const [clientIp, setClientIp] = useState<string>('');
  const [discoveredLanServers, setDiscoveredLanServers] = useState<DiscoveredNasDevice[]>([]);
  const [deviceBaseUrl, setDeviceBaseUrl] = useState<string>(() => getNasBaseUrl());

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdminNetworkConfigTestResult | null>(null);
  const [mixedContentDirectUrl, setMixedContentDirectUrl] = useState<string | null>(null);

  // Gemeinsames NAS-Sicherheitszertifikat (gilt für alle Nutzer dieses NAS)
  const [securityCertificate, setSecurityCertificate] =
    useState<NasSecurityCertificateInfo | null>(null);
  const [certUploading, setCertUploading] = useState(false);
  const [certDeleting, setCertDeleting] = useState(false);
  const [certLabelDraft, setCertLabelDraft] = useState('');
  const [certShowPaste, setCertShowPaste] = useState(false);
  const [certPemPasteDraft, setCertPemPasteDraft] = useState('');

  // FRITZ!Box Challenge-Response Session-State
  const [fritzHostDraft, setFritzHostDraft] = useState(() => {
    const hostFromBuf =
      initialBuf?.nasConnection?.host ||
      extractHostnameSafe(initialBuf?.serverUrl || '') ||
      extractHostnameSafe(getNasBaseUrl());
    return hostFromBuf && hostFromBuf !== 'localhost' && hostFromBuf !== '127.0.0.1'
      ? hostFromBuf
      : 'fritz.box';
  });
  const [fritzPortDraft, setFritzPortDraft] = useState(() =>
    initialBuf?.nasConnection?.useTls ? '443' : initialBuf?.nasConnection?.port || '80'
  );
  const [fritzUseTlsDraft, setFritzUseTlsDraft] = useState(() =>
    Boolean(initialBuf?.nasConnection?.useTls)
  );
  const [fritzUserDraft, setFritzUserDraft] = useState(
    () => initialBuf?.nasConnection?.username || ''
  );
  const [fritzPasswordDraft, setFritzPasswordDraft] = useState('');
  const [fritzBusy, setFritzBusy] = useState(false);
  const [fritzStatus, setFritzStatus] = useState<FritzSidSessionStatus | null>(null);
  const [fritzBrowsePath, setFritzBrowsePath] = useState('/');
  const [fritzBrowseItems, setFritzBrowseItems] = useState<FritzNasBrowseItem[]>([]);
  const [fritzBrowseSource, setFritzBrowseSource] = useState<string | null>(null);

  // Modulare NAS-Verbindungsprofile (LAN & Externe NAS: DynDNS, Domain, VPN)
  const [profiles, setProfiles] = useState<NasConnectionProfile[]>([]);
  const [profilesBusyId, setProfilesBusyId] = useState<string | null>(null);
  const [showNewProfileForm, setShowNewProfileForm] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileScope, setNewProfileScope] = useState<NasProfileScope>('wan_dyndns');
  const [newProfileProtocol, setNewProfileProtocol] = useState<NasProtocolId>('webdav');
  const [newProfileHost, setNewProfileHost] = useState('');
  const [newProfilePort, setNewProfilePort] = useState('5006');
  const [newProfileShareOrPath, setNewProfileShareOrPath] = useState('/');
  const [newProfileUsername, setNewProfileUsername] = useState('');
  const [newProfileSecret, setNewProfileSecret] = useState('');
  const [newProfileUseTls, setNewProfileUseTls] = useState(true);
  const [newProfileAllowSelfSignedLocalTls, setNewProfileAllowSelfSignedLocalTls] = useState(true);
  const [newProfileHint, setNewProfileHint] = useState('');
  const [savingNewProfile, setSavingNewProfile] = useState(false);

  const applyResponseToState = useCallback((data: AdminNetworkConfigResponse) => {
    setSavedConfig(data.config);
    setSecurityCertificate(data.securityCertificate ?? null);
    syncSharedNasCertificate(data.securityCertificate ?? null);
    const localTlsEnabled = data.config.allowLocalSelfSignedTls ?? true;
    setAllowLocalSelfSignedDraft(localTlsEnabled);
    syncLocalTlsPolicyWithAndroidBridge(localTlsEnabled);
    setActiveModeDraft(data.config.activeMode);
    setLanAddressDraft(data.config.lanAddress);
    setRemoteAddressDraft(data.config.remoteAddress);
    setRemoteTransportDraft(data.config.remoteTransport);
    setAutoFallbackDraft(data.config.autoFallbackToRemote);
    setDetectedLanUrls(data.detectedLanUrls ?? []);
    setLocalSubnets(data.localSubnets ?? []);
    setClientIp(data.clientIp ?? '');
    if (data.config.lanAddress) {
      setPortScanTargetDraft((prev) => prev || data.config.lanAddress);
    }
  }, []);

  const loadFritzAndProfiles = useCallback(async () => {
    try {
      const [fritzData, profileData] = await Promise.all([
        fetchFritzSessionStatus(token).catch(() => null),
        fetchNasConnectionProfiles(token).catch(() => ({ profiles: [] as NasConnectionProfile[] })),
      ]);
      if (fritzData && typeof fritzData.host === 'string') {
        setFritzStatus(fritzData);
        if (fritzData.host) setFritzHostDraft(fritzData.host);
        if (fritzData.port) setFritzPortDraft(String(fritzData.port));
        setFritzUseTlsDraft(Boolean(fritzData.useTls));
        if (fritzData.username) setFritzUserDraft(fritzData.username);
      }
      if (Array.isArray(profileData?.profiles)) {
        setProfiles(profileData.profiles);
      }
    } catch {
      // Optional enrichment
    }
  }, [token]);

  const loadNetworkConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (isLocalFallbackToken(token)) {
      try {
        const raw = window.localStorage.getItem(LOCAL_NETWORK_CONFIG_KEY);
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
        const proto = conn?.protocol ?? provisioned?.protocol ?? 'fritz_upnp';
        const useTls = proto === 'smb' ? false : Boolean(conn?.useTls);
        const port = String(
          sanitizeNasPortForProtocol(
            proto,
            conn?.port || (proto === 'smb' ? '445' : useTls ? '443' : '80'),
            useTls
          )
        );
        const backendRoot = (
          buf?.syncedBackendPath ||
          conn?.backendPath ||
          provisioned?.backendPath ||
          '/EntenCenter-Backend'
        ).replace(/\/+$/, '');
        let remoteParsed: AdminNetworkConfig | null = null;
        if (host && pass) {
          const remoteRes = await readFileFromNasBridge({
            protocol: proto,
            host,
            port,
            shareOrPath: proto === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: conn?.username || '',
            password: pass,
            fritzPassword: pass,
            useTls,
            targetPath: `${backendRoot}/config/network-config.json`,
          }).catch(() => null);
          if (remoteRes?.ok && remoteRes.content) {
            remoteParsed = JSON.parse(remoteRes.content) as AdminNetworkConfig;
          }
        }
        const defaultLan =
          buf?.serverUrl ||
          (buf?.nasConnection?.host ? `http://${buf.nasConnection.host}` : '') ||
          getNasBaseUrl() ||
          '';
        const localParsed = raw ? (JSON.parse(raw) as AdminNetworkConfig) : null;
        const parsed = remoteParsed ?? localParsed;
        const effectiveConfig: AdminNetworkConfig = parsed ?? {
          activeMode: buf?.connectionScope === 'internet' ? 'remote' : 'lan',
          lanAddress: defaultLan,
          remoteAddress: '',
          remoteTransport: 'wan_dyndns',
          autoFallbackToRemote: true,
          allowLocalSelfSignedTls: true,
          updatedAt: buf?.updatedAt ?? null,
          updatedBy: 'storage-bridge',
        };
        setSavedConfig(effectiveConfig);
        setActiveModeDraft(effectiveConfig.activeMode);
        setLanAddressDraft(effectiveConfig.lanAddress);
        setRemoteAddressDraft(effectiveConfig.remoteAddress);
        setRemoteTransportDraft(effectiveConfig.remoteTransport);
        setAutoFallbackDraft(effectiveConfig.autoFallbackToRemote);
        setAllowLocalSelfSignedDraft(effectiveConfig.allowLocalSelfSignedTls ?? true);
        if (effectiveConfig.lanAddress) {
          setPortScanTargetDraft((prev) => prev || effectiveConfig.lanAddress);
        }
        await loadFritzAndProfiles();
      } catch {
        // Fallback ignorieren
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/network-config', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        setError('Kein EntenCenter-NAS-Backend unter dem aktuellen Endpunkt aktiv.');
        return;
      }
      const data = (await res.json()) as AdminNetworkConfigResponse & { error?: string };
      if (!res.ok || !data.config) {
        setError(data.error || 'Netzwerk-Konfiguration konnte nicht vom NAS geladen werden.');
        return;
      }
      applyResponseToState(data);
      void loadFritzAndProfiles();
    } catch {
      setError('Verbindung zum NAS beim Laden der Netzwerk-Konfiguration fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }, [applyResponseToState, loadFritzAndProfiles, token]);

  useEffect(() => {
    void loadNetworkConfig();
  }, [loadNetworkConfig]);

  const isDirty = Boolean(
    savedConfig &&
      (activeModeDraft !== savedConfig.activeMode ||
        lanAddressDraft.trim() !== savedConfig.lanAddress ||
        remoteAddressDraft.trim() !== savedConfig.remoteAddress ||
        remoteTransportDraft !== savedConfig.remoteTransport ||
        autoFallbackDraft !== savedConfig.autoFallbackToRemote ||
        allowLocalSelfSignedDraft !== (savedConfig.allowLocalSelfSignedTls ?? true))
  );

  const saveNetworkConfig = async (
    overrideMode?: NetworkProfileMode
  ): Promise<AdminNetworkConfig | null> => {
    const targetMode = overrideMode ?? activeModeDraft;
    setSaving(true);
    setError(null);
    setNotice(null);
    setMixedContentDirectUrl(null);
    setPreferredAlternativePort(preferredAltPortDraft);
    setAutoPortFallbackEnabled(autoPortFallbackDraft);

    if (isLocalFallbackToken(token)) {
      try {
        const localSaved: AdminNetworkConfig = {
          activeMode: targetMode,
          lanAddress: lanAddressDraft.trim(),
          remoteAddress: remoteAddressDraft.trim(),
          remoteTransport: remoteTransportDraft,
          autoFallbackToRemote: autoFallbackDraft,
          allowLocalSelfSignedTls: allowLocalSelfSignedDraft,
          updatedAt: new Date().toISOString(),
          updatedBy: 'storage-bridge',
        };
        window.localStorage.setItem(LOCAL_NETWORK_CONFIG_KEY, JSON.stringify(localSaved));
        setSavedConfig(localSaved);
        const preferredEndpoint =
          targetMode === 'remote' ? localSaved.remoteAddress : localSaved.lanAddress;
        if (preferredEndpoint) {
          const normalized = normalizeNasBaseUrl(preferredEndpoint);
          if (normalized) {
            setNasBaseUrl(normalized);
            setDeviceBaseUrl(normalized);
          }
        }
        const buf = readLocalOnboardingBuffer();
        const conn = buf?.nasConnection;
        const pass = conn?.fritzPassword || conn?.secret || '';
        const host = cleanHostOnly(conn?.host) || cleanHostOnly(preferredEndpoint);
        const proto = conn?.protocol ?? 'fritz_upnp';
        const useTls = proto === 'smb' ? false : Boolean(conn?.useTls);
        const port = String(
          sanitizeNasPortForProtocol(
            proto,
            conn?.port || (proto === 'smb' ? '445' : useTls ? '443' : '80'),
            useTls
          )
        );
        const backendRoot = (
          buf?.syncedBackendPath ||
          conn?.backendPath ||
          '/EntenCenter-Backend'
        ).replace(/\/+$/, '');
        if (host && pass) {
          await writeFileToNasBridge({
            protocol: proto,
            host,
            port,
            shareOrPath: proto === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: conn?.username || '',
            password: pass,
            fritzPassword: pass,
            useTls,
            targetPath: `${backendRoot}/config/network-config.json`,
            content: JSON.stringify(localSaved, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        setNotice(
          `Netzwerk-Konfiguration & Ausweichport (:${preferredAltPortDraft}) in Storage-Bridge gespeichert.`
        );
        return localSaved;
      } catch {
        setError('Netzwerk-Konfiguration konnte nicht gespeichert werden.');
        return null;
      } finally {
        setSaving(false);
      }
    }

    try {
      const res = await fetch('/api/nas/admin/network-config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          activeMode: targetMode,
          lanAddress: lanAddressDraft.trim(),
          remoteAddress: remoteAddressDraft.trim(),
          remoteTransport: remoteTransportDraft,
          autoFallbackToRemote: autoFallbackDraft,
          allowLocalSelfSignedTls: allowLocalSelfSignedDraft,
        }),
      });
      const data = (await res.json()) as AdminNetworkConfigResponse & { error?: string };
      if (!res.ok || !data.config) {
        setError(data.error || 'Netzwerk-Konfiguration konnte nicht gespeichert werden.');
        return null;
      }
      applyResponseToState(data);
      setNotice(
        data.config.activeMode === 'remote'
          ? `Netzwerk-Konfiguration gespeichert. Aktives Profil: Remote-NAS (${data.config.remoteAddress || 'WAN/VPN'}) · Ausweichport :${preferredAltPortDraft}.`
          : `Netzwerk-Konfiguration gespeichert. Aktives Profil: Lokal LAN (${data.config.lanAddress || 'Standard-Heimnetz'}) · Ausweichport :${preferredAltPortDraft}.`
      );
      return data.config;
    } catch {
      setError('Verbindung zum NAS beim Speichern fehlgeschlagen.');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleTestEndpoint = async (modeToTest: NetworkProfileMode) => {
    const addressToTest =
      modeToTest === 'remote' ? remoteAddressDraft.trim() : lanAddressDraft.trim();
    setTestingMode(modeToTest);
    setError(null);
    setNotice(null);
    setTestResult(null);
    setMixedContentDirectUrl(null);
    if (isLocalFallbackToken(token)) {
      try {
        const targetCandidate = addressToTest || portScanTargetDraft;
        const scan = await scanAlternativeNasPorts(targetCandidate, {
          authToken: token,
          preferredAltPort: preferredAltPortDraft,
        });
        setPortScanResult(scan);
        if (scan.recommendedBaseUrl) {
          setTestResult({
            ok: true,
            mode: modeToTest,
            targetUrl: scan.recommendedBaseUrl,
            latencyMs: scan.ports.find((p) => p.recommended)?.latencyMs ?? undefined,
            resolvedIp: scan.hostname,
            message: `EntenCenter-Backend erreichbar unter ${scan.recommendedBaseUrl}.`,
          });
          setNotice(`Endpunkt-Check abgeschlossen: ${scan.recommendedBaseUrl} aktiv.`);
        } else {
          const bridgeProbe = await probeBridgeNasHealth({
            host: extractHostnameSafe(targetCandidate) || scan.hostname,
            serverBaseUrl: targetCandidate,
          });
          if (bridgeProbe.ok) {
            setTestResult({
              ok: true,
              mode: modeToTest,
              targetUrl: targetCandidate || bridgeProbe.host,
              latencyMs: bridgeProbe.latencyMs ?? undefined,
              resolvedIp: bridgeProbe.host,
              message: `NAS Storage-Bridge erreichbar (${bridgeProbe.transportLabel || 'FRITZ!NAS / SMB aktiv'}).`,
            });
            setNotice(
              `Storage-Bridge erreichbar (${bridgeProbe.host}${bridgeProbe.latencyMs !== null ? ` · ${bridgeProbe.latencyMs} ms` : ''}) — kein :3000-Server erforderlich.`
            );
          } else {
            setTestResult({
              ok: false,
              mode: modeToTest,
              targetUrl: addressToTest,
              resolvedIp: scan.hostname,
              error: bridgeProbe.warning || scan.summary,
            });
            setError(bridgeProbe.warning || scan.summary);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Lokaler Port- & Verbindungstest fehlgeschlagen.');
      } finally {
        setTestingMode(null);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/network-config/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: modeToTest,
          address: addressToTest,
          remoteTransport: remoteTransportDraft,
        }),
      });
      const data = (await res.json()) as AdminNetworkConfigTestResult;
      setTestResult(data);
      if (!res.ok || !data.ok) {
        setError(data.error || 'Erreichbarkeitsprüfung fehlgeschlagen.');
      }
    } catch {
      setError('Netzwerktest konnte nicht ausgeführt werden.');
    } finally {
      setTestingMode(null);
    }
  };

  const handleRunPortScan = async (overrideTarget?: string) => {
    const target = (
      overrideTarget ??
      (portScanTargetDraft.trim() || lanAddressDraft.trim() || remoteAddressDraft.trim() || getEffectiveNasOrigin())
    ).trim();
    setPortScanBusy(true);
    setError(null);
    try {
      setPreferredAlternativePort(preferredAltPortDraft);
      setAutoPortFallbackEnabled(autoPortFallbackDraft);
      const scan = await scanAlternativeNasPorts(target, {
        authToken: token,
        preferredAltPort: preferredAltPortDraft,
      });
      setPortScanResult(scan);
      if (scan.recommendedBaseUrl) {
        setNotice(scan.summary);
      } else {
        setNotice(scan.summary);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Automatischer Port-Scan konnte nicht ausgeführt werden.'
      );
    } finally {
      setPortScanBusy(false);
    }
  };

  const handleAdoptScannedPortUrl = (
    url: string,
    targetField: 'lan' | 'remote' | 'device',
    portNum?: number
  ) => {
    const normalized = normalizeNasBaseUrl(url) || url;
    if (portNum && portNum !== 3000) {
      setPreferredAltPortDraft(portNum);
      setPreferredAlternativePort(portNum);
    }
    if (targetField === 'lan') {
      setLanAddressDraft(normalized);
      setActiveModeDraft('lan');
      setNotice(`LAN-Adresse auf ${normalized} gesetzt.`);
    } else if (targetField === 'remote') {
      setRemoteAddressDraft(normalized);
      setActiveModeDraft('remote');
      setNotice(`Remote-Adresse auf ${normalized} gesetzt.`);
    } else {
      const applied = setNasBaseUrl(normalized);
      setDeviceBaseUrl(applied);
      setLanAddressDraft((prev) => prev || applied);
      setNotice(`Aktives Geräte-Ziel auf ${applied} umgeschaltet.`);
    }
  };

  const handleApplyToCurrentDevice = async (modeToApply: NetworkProfileMode) => {
    const rawTarget =
      modeToApply === 'remote' ? remoteAddressDraft.trim() : lanAddressDraft.trim();
    const normalized = normalizeNasBaseUrl(rawTarget);

    setError(null);
    setNotice(null);
    setMixedContentDirectUrl(null);

    if (!normalized) {
      setError(
        modeToApply === 'remote'
          ? 'Bitte gib zuerst eine gültige Remote-NAS-Adresse (WAN/VPN) ein.'
          : 'Bitte gib zuerst eine gültige lokale LAN-Adresse ein.'
      );
      return;
    }

    if (isMixedContentBlocked(normalized)) {
      setMixedContentDirectUrl(normalized);
      setError(
        `Dein Browser blockiert direkte http://-Verbindungen (${normalized}) von einer HTTPS-Seite aus. Öffne die Adresse direkt im neuen Tab oder wechsle in der Android-App.`
      );
      return;
    }

    setApplyingDevice(true);
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 5000);
      const probeRes = await fetch(`${normalized}/api/nas/auth/bootstrap`, {
        signal: controller.signal,
      }).finally(() => window.clearTimeout(timeoutId));

      if (!probeRes.ok) {
        setError(
          `Dieses Gerät konnte ${normalized} nicht erreichen (HTTP ${probeRes.status}). Die gespeicherte Server-Verbindung dieses Geräts wurde sicherheitshalber nicht umgestellt.`
        );
        return;
      }
      const probeJson = (await probeRes.json().catch(() => null)) as {
        hasUsers?: unknown;
      } | null;
      if (typeof probeJson?.hasUsers !== 'boolean') {
        setError(
          `Unter ${normalized} antwortet kein gültiges EntenCenter-NAS-Backend.`
        );
        return;
      }

      const applied = setNasBaseUrl(normalized);
      setDeviceBaseUrl(applied);
      setActiveModeDraft(modeToApply);
      await saveNetworkConfig(modeToApply);
      setNotice(
        `Dieses Gerät nutzt ab sofort den ${modeToApply === 'remote' ? 'Remote-NAS (WAN/VPN)' : 'lokalen LAN'}-Endpunkt ${applied}.`
      );
    } catch {
      setError(
        `Dieses Gerät konnte ${normalized} direkt nicht erreichen. Prüfe WLAN/VPN bzw. Port-Freigabe, bevor du die Geräte-Verbindung umschaltest.`
      );
    } finally {
      setApplyingDevice(false);
    }
  };

  const handleResetDeviceTarget = () => {
    setNasBaseUrl('');
    setDeviceBaseUrl('');
    setMixedContentDirectUrl(null);
    setNotice('Geräte-Override zurückgesetzt. Die App nutzt wieder den Standard-Ursprung.');
  };

  const handleScanLanServers = async () => {
    setScanningLan(true);
    setError(null);
    try {
      const res = await discoverLocalNasDevices({ includeSubnetProbe: true });
      const servers = res.devices.filter((d) => d.isEntenCenterServer && d.baseUrl);
      setDiscoveredLanServers(servers);
      if (servers.length === 1 && servers[0].baseUrl && !lanAddressDraft.trim()) {
        setLanAddressDraft(servers[0].baseUrl);
      }
    } catch {
      setError('mDNS-/Heimnetz-Suche konnte nicht ausgeführt werden.');
    } finally {
      setScanningLan(false);
    }
  };

  const uploadCertificatePayload = async (fileName: string, content: string) => {
    if (isLocalFallbackToken(token)) {
      setError(
        'Im lokalen Fallback-Modus ohne EntenCenter-:3000-Backend kann das gemeinsame Zertifikat erst nach Kopplung mit dem Backend hochgeladen werden.'
      );
      return;
    }
    setCertUploading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/nas/admin/network-config/certificate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName,
          content,
          label: certLabelDraft.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        certificate?: NasSecurityCertificateInfo;
        error?: string;
      };
      if (!res.ok || !data.certificate) {
        setError(data.error || 'Sicherheitszertifikat konnte nicht hochgeladen werden.');
        return;
      }
      setSecurityCertificate(data.certificate);
      syncSharedNasCertificate(data.certificate);
      setCertLabelDraft('');
      setCertPemPasteDraft('');
      setCertShowPaste(false);
      setNotice(
        `Sicherheitszertifikat "${data.certificate.label}" gespeichert. Es gilt ab sofort für alle Nutzer, die auf dieses NAS zugreifen.`
      );
    } catch {
      setError('Verbindung zum NAS beim Hochladen des Sicherheitszertifikats fehlgeschlagen.');
    } finally {
      setCertUploading(false);
    }
  };

  const handleCertificateFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 512 * 1024) {
      setError('Die Zertifikatsdatei darf maximal 512 KB groß sein.');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const textCandidate = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const isPemText = textCandidate.includes('-----BEGIN CERTIFICATE-----');
      let contentToSend = textCandidate;
      if (!isPemText) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        contentToSend = window.btoa(binary);
      }
      await uploadCertificatePayload(file.name, contentToSend);
    } catch {
      setError('Zertifikatsdatei konnte im Browser nicht gelesen werden.');
    }
  };

  const handleDeleteCertificate = async () => {
    if (isLocalFallbackToken(token)) return;
    setCertDeleting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/nas/admin/network-config/certificate', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errData.error || 'Sicherheitszertifikat konnte nicht entfernt werden.');
        return;
      }
      setSecurityCertificate(null);
      syncSharedNasCertificate(null);
      setNotice('Gemeinsames NAS-Sicherheitszertifikat entfernt.');
    } catch {
      setError('Verbindung zum NAS beim Entfernen des Sicherheitszertifikats fehlgeschlagen.');
    } finally {
      setCertDeleting(false);
    }
  };

  const handleFritzStatusCheck = async () => {
    setFritzBusy(true);
    setError(null);
    setNotice(null);
    try {
      const status = await fetchFritzSessionStatus(token, {
        host: fritzHostDraft.trim(),
        port: fritzPortDraft.trim(),
        useTls: fritzUseTlsDraft,
        username: fritzUserDraft.trim(),
      });
      setFritzStatus(status);
      if (status.error) {
        setError(status.error);
      } else {
        setNotice(status.message);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `FRITZ!Box Statusprüfung fehlgeschlagen: ${err.message}`
          : 'FRITZ!Box Statusprüfung fehlgeschlagen.'
      );
    } finally {
      setFritzBusy(false);
    }
  };

  const handleFritzChallengeLogin = async (forceRefresh = false) => {
    setFritzBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await loginFritzSession(token, {
        host: fritzHostDraft.trim() || 'fritz.box',
        port: fritzPortDraft.trim() || undefined,
        useTls: fritzUseTlsDraft,
        username: fritzUserDraft.trim(),
        password: fritzPasswordDraft,
        allowLocalSelfSignedTls: allowLocalSelfSignedDraft,
        forceRefresh,
      });
      setFritzStatus(res);
      if (!res.ok) {
        setError(res.error || res.message || 'FRITZ!Box Challenge-Response Login fehlgeschlagen.');
      } else {
        setNotice(
          res.reused
            ? `FRITZ!Box Session-ID wiederverwendet (${res.sidPreview}).`
            : `FRITZ!Box Challenge-Response erfolgreich — neue SID aktiv (${res.sidPreview}).`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `FRITZ!Box Challenge-Response-Login fehlgeschlagen: ${err.message}`
          : 'Verbindung zur FRITZ!Box beim Challenge-Response-Login fehlgeschlagen.'
      );
    } finally {
      setFritzBusy(false);
    }
  };

  const handleFritzBrowse = async (targetPath = '/') => {
    setFritzBusy(true);
    setError(null);
    try {
      const res = await browseFritzNas(token, {
        host: fritzHostDraft.trim() || 'fritz.box',
        port: fritzPortDraft.trim() || undefined,
        useTls: fritzUseTlsDraft,
        username: fritzUserDraft.trim(),
        password: fritzPasswordDraft || undefined,
        path: targetPath,
        allowLocalSelfSignedTls: allowLocalSelfSignedDraft,
      });
      if (!res.ok) {
        setError(res.error || 'FRITZ!NAS-Verzeichnis konnte nicht geladen werden.');
        return;
      }
      setFritzBrowsePath(res.path);
      setFritzBrowseItems(res.items ?? []);
      setFritzBrowseSource(res.source);
      setNotice(
        `${res.items?.length ?? 0} Einträge aus FRITZ!NAS (${res.path}) geladen (SID ${res.sidPreview || 'aktiv'}).`
      );
    } catch {
      setError('FRITZ!NAS-Zugriff fehlgeschlagen.');
    } finally {
      setFritzBusy(false);
    }
  };

  const handleFritzLogout = async () => {
    setFritzBusy(true);
    setError(null);
    try {
      await logoutFritzSession(token, {
        host: fritzHostDraft.trim() || 'fritz.box',
        port: fritzPortDraft.trim() || undefined,
        useTls: fritzUseTlsDraft,
        username: fritzUserDraft.trim(),
      });
      setFritzBrowseItems([]);
      setFritzBrowseSource(null);
      const status = await fetchFritzSessionStatus(token, {
        host: fritzHostDraft.trim(),
        port: fritzPortDraft.trim(),
        useTls: fritzUseTlsDraft,
        username: fritzUserDraft.trim(),
      });
      setFritzStatus(status);
      setNotice('FRITZ!Box Session-ID (SID) abgemeldet und verworfen.');
    } catch {
      setError('Abmelden der FRITZ!Box Session-ID fehlgeschlagen.');
    } finally {
      setFritzBusy(false);
    }
  };

  const handleSelectProfileProtocol = (nextProto: NasProtocolId) => {
    setNewProfileProtocol(nextProto);
    const meta = PROFILE_PROTOCOL_OPTIONS.find((item) => item.id === nextProto);
    if (meta) {
      setNewProfilePort(meta.defaultPort);
      setNewProfileUseTls(meta.defaultTls);
    }
  };

  const handleSaveNewProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim() || !newProfileHost.trim()) {
      setError('Bitte Profilname und Host/Adresse für das NAS-Profil angeben.');
      return;
    }
    setSavingNewProfile(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveNasConnectionProfile(token, {
        name: newProfileName.trim(),
        scope: newProfileScope,
        protocol: newProfileProtocol,
        host: newProfileHost.trim(),
        port: newProfilePort.trim(),
        shareOrPath: newProfileShareOrPath.trim() || '/',
        username: newProfileUsername.trim(),
        secret: newProfileSecret,
        useTls: newProfileUseTls,
        allowSelfSignedLocalTls:
          newProfileScope === 'lan' ? newProfileAllowSelfSignedLocalTls : false,
        ddnsOrVpnHint: newProfileHint.trim() || undefined,
      });
      if (!res.ok || !res.profiles) {
        setError(res.error || 'NAS-Verbindungsprofil konnte nicht gespeichert werden.');
        return;
      }
      setProfiles(res.profiles);
      setShowNewProfileForm(false);
      setNewProfileName('');
      setNewProfileHost('');
      setNewProfileUsername('');
      setNewProfileSecret('');
      setNewProfileHint('');
      setNotice(`NAS-Verbindungsprofil "${res.profile?.name ?? ''}" gespeichert.`);
    } catch {
      setError('Verbindung zum NAS beim Speichern des Profils fehlgeschlagen.');
    } finally {
      setSavingNewProfile(false);
    }
  };

  const handleTestProfile = async (profileId: string) => {
    setProfilesBusyId(profileId);
    setError(null);
    setNotice(null);
    try {
      const res = await testNasConnectionProfile(token, profileId);
      if (res.profile) {
        setProfiles((prev) =>
          prev.map((item) => (item.id === profileId ? res.profile! : item))
        );
      }
      if (!res.ok) {
        setError(res.error || res.message || 'Profil-Erreichbarkeitstest fehlgeschlagen.');
      } else {
        setNotice(res.message || 'NAS-Profil erfolgreich erreicht.');
      }
    } catch {
      setError('Profiltest konnte nicht ausgeführt werden.');
    } finally {
      setProfilesBusyId(null);
    }
  };

  const handleActivateProfile = async (profileId: string) => {
    setProfilesBusyId(profileId);
    setError(null);
    setNotice(null);
    try {
      const res = await activateNasConnectionProfile(token, profileId);
      if (!res.ok || !res.profiles) {
        setError(res.error || 'Profil konnte nicht aktiviert werden.');
        return;
      }
      setProfiles(res.profiles);
      setNotice(`Aktives NAS-Profil gewechselt zu "${res.profile?.name ?? ''}".`);
    } catch {
      setError('Profilaktivierung fehlgeschlagen.');
    } finally {
      setProfilesBusyId(null);
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    setProfilesBusyId(profileId);
    setError(null);
    try {
      const res = await deleteNasConnectionProfile(token, profileId);
      if (!res.ok || !res.profiles) {
        setError(res.error || 'Profil konnte nicht gelöscht werden.');
        return;
      }
      setProfiles(res.profiles);
      setNotice('NAS-Verbindungsprofil gelöscht.');
    } catch {
      setError('Löschen des Profils fehlgeschlagen.');
    } finally {
      setProfilesBusyId(null);
    }
  };

  const selectedTransportMeta =
    REMOTE_TRANSPORT_OPTIONS.find((opt) => opt.id === remoteTransportDraft) ??
    REMOTE_TRANSPORT_OPTIONS[0];

  return (
    <section
      aria-labelledby="admin-network-config-heading"
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
            <Network className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3
              id="admin-network-config-heading"
              className="font-display text-base font-semibold text-white"
            >
              Netzwerk-Konfiguration (LAN &amp; Remote-NAS)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Wechsle zwischen lokalem Heimnetz (LAN) und externer Remote-NAS-Adresse (WAN/VPN) und
              speichere beide Profile dauerhaft im NAS-Tresor.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <span
            className={`text-xs font-semibold px-3 py-1 rounded-lg border whitespace-nowrap flex items-center gap-1.5 ${
              activeModeDraft === 'remote'
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
            }`}
          >
            {activeModeDraft === 'remote' ? (
              <>
                <Globe className="w-3.5 h-3.5" />
                <span>Aktiv: Remote-NAS (WAN/VPN)</span>
              </>
            ) : (
              <>
                <Wifi className="w-3.5 h-3.5" />
                <span>Aktiv: Lokal (LAN)</span>
              </>
            )}
          </span>
          <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        </div>
      </button>

      {!isCollapsed && (
      <div className="p-6 space-y-5">
        {loading ? (
          <div className="py-6 text-center text-xs text-slate-400">
            Lade Netzwerk-Konfiguration vom NAS...
          </div>
        ) : (
          <>
            {/* Profil-Umschalter: Lokal (LAN) vs. Remote-NAS (WAN/VPN) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setActiveModeDraft('lan');
                  setError(null);
                  setNotice(null);
                }}
                aria-pressed={activeModeDraft === 'lan'}
                className={`p-4 rounded-xl border text-left transition-colors flex flex-col justify-between gap-2.5 ${
                  activeModeDraft === 'lan'
                    ? 'bg-emerald-500/10 border-emerald-500/60'
                    : 'bg-[#0B0E14] border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
                        activeModeDraft === 'lan'
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                          : 'bg-[#121722] border-slate-800 text-slate-400'
                      }`}
                    >
                      <Wifi className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold text-white">
                        Lokales Netzwerk (LAN)
                      </p>
                      <p className="text-[11px] text-slate-400">
                        Direkte Verbindung im Heim-WLAN / LAN
                      </p>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                      activeModeDraft === 'lan'
                        ? 'bg-emerald-400 text-slate-950 border-emerald-400'
                        : 'bg-slate-900 text-slate-400 border-slate-700'
                    }`}
                  >
                    {activeModeDraft === 'lan' ? 'Ausgewählt' : 'Wechseln'}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-slate-300 truncate">
                  {lanAddressDraft.trim() || 'Noch keine LAN-Adresse hinterlegt'}
                </p>
              </button>

              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setActiveModeDraft('remote');
                  setError(null);
                  setNotice(null);
                }}
                aria-pressed={activeModeDraft === 'remote'}
                className={`p-4 rounded-xl border text-left transition-colors flex flex-col justify-between gap-2.5 ${
                  activeModeDraft === 'remote'
                    ? 'bg-sky-500/10 border-sky-500/60'
                    : 'bg-[#0B0E14] border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
                        activeModeDraft === 'remote'
                          ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                          : 'bg-[#121722] border-slate-800 text-slate-400'
                      }`}
                    >
                      <Globe className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold text-white">
                        Remote-NAS (WAN / VPN)
                      </p>
                      <p className="text-[11px] text-slate-400">
                        Fernzugriff via DynDNS, HTTPS-Proxy oder VPN
                      </p>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                      activeModeDraft === 'remote'
                        ? 'bg-sky-400 text-slate-950 border-sky-400'
                        : 'bg-slate-900 text-slate-400 border-slate-700'
                    }`}
                  >
                    {activeModeDraft === 'remote' ? 'Ausgewählt' : 'Wechseln'}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-slate-300 truncate">
                  {remoteAddressDraft.trim() || 'Noch keine Remote-Adresse hinterlegt'}
                </p>
              </button>
            </div>

            {/* Adressfelder: LAN und Remote */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Lokale LAN-Adresse */}
              <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="admin-net-lan-url"
                    className="text-xs font-semibold text-white flex items-center gap-2"
                  >
                    <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Lokale NAS-Adresse (LAN)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleScanLanServers()}
                    disabled={scanningLan}
                    className="text-[11px] px-2.5 py-1 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-emerald-300 flex items-center gap-1 transition-colors"
                  >
                    <Radar className={`w-3 h-3 ${scanningLan ? 'animate-spin' : ''}`} />
                    <span>{scanningLan ? 'Suche...' : 'mDNS suchen'}</span>
                  </button>
                </div>

                <input
                  id="admin-net-lan-url"
                  type="text"
                  value={lanAddressDraft}
                  onChange={(e) => {
                    setLanAddressDraft(e.target.value);
                    setError(null);
                  }}
                  placeholder="http://192.168.178.50:3000 oder http://entencenter.local:3000"
                  className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400 transition-colors"
                />

                {(detectedLanUrls.length > 0 || discoveredLanServers.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-slate-500">Erkannt:</span>
                    {detectedLanUrls.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => setLanAddressDraft(url)}
                        className="px-2 py-0.5 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-emerald-300 transition-colors"
                      >
                        {url}
                      </button>
                    ))}
                    {discoveredLanServers.map(
                      (dev) =>
                        dev.baseUrl &&
                        !detectedLanUrls.includes(dev.baseUrl) && (
                          <button
                            key={dev.id}
                            type="button"
                            onClick={() => setLanAddressDraft(dev.baseUrl || '')}
                            className="px-2 py-0.5 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-200 transition-colors"
                          >
                            {dev.baseUrl}
                          </button>
                        )
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={testingMode !== null || !lanAddressDraft.trim()}
                    onClick={() => void handleTestEndpoint('lan')}
                    className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1.5 transition-colors"
                  >
                    <RefreshCw
                      className={`w-3 h-3 text-emerald-400 ${testingMode === 'lan' ? 'animate-spin' : ''}`}
                    />
                    <span>LAN testen</span>
                  </button>
                  <button
                    type="button"
                    disabled={applyingDevice || saving || !lanAddressDraft.trim()}
                    onClick={() => void handleApplyToCurrentDevice('lan')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 border border-emerald-500/40 text-[11px] font-medium text-emerald-200 flex items-center gap-1.5 transition-colors"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    <span>Gerät auf LAN umschalten</span>
                  </button>
                </div>
              </div>

              {/* Remote-NAS Adresse (WAN / VPN) */}
              <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="admin-net-remote-url"
                    className="text-xs font-semibold text-white flex items-center gap-2"
                  >
                    <Shield className="w-3.5 h-3.5 text-sky-400" />
                    <span>Remote-NAS-Adresse (WAN / VPN)</span>
                  </label>
                  <select
                    aria-label="Remote-Verbindungsart"
                    value={remoteTransportDraft}
                    onChange={(e) =>
                      setRemoteTransportDraft(e.target.value as RemoteNasTransportType)
                    }
                    className="px-2 py-1 rounded bg-[#121722] border border-slate-700 text-[11px] text-slate-200 focus:outline-none focus:border-sky-400"
                  >
                    {REMOTE_TRANSPORT_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <input
                  id="admin-net-remote-url"
                  type="text"
                  value={remoteAddressDraft}
                  onChange={(e) => {
                    setRemoteAddressDraft(e.target.value);
                    setError(null);
                  }}
                  placeholder={selectedTransportMeta.placeholder}
                  className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 transition-colors"
                />

                <p className="text-[11px] text-slate-400 leading-snug">
                  {selectedTransportMeta.hint}
                </p>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={testingMode !== null || !remoteAddressDraft.trim()}
                    onClick={() => void handleTestEndpoint('remote')}
                    className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1.5 transition-colors"
                  >
                    <RefreshCw
                      className={`w-3 h-3 text-sky-400 ${testingMode === 'remote' ? 'animate-spin' : ''}`}
                    />
                    <span>WAN/VPN testen</span>
                  </button>
                  <button
                    type="button"
                    disabled={applyingDevice || saving || !remoteAddressDraft.trim()}
                    onClick={() => void handleApplyToCurrentDevice('remote')}
                    className="px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 border border-sky-500/40 text-[11px] font-medium text-sky-200 flex items-center gap-1.5 transition-colors"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    <span>Gerät auf Remote umschalten</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Fallback-, Lokale-Zertifikats- & Geräte-Statuszeile */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <label className="flex items-start sm:items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoFallbackDraft}
                    onChange={(e) => setAutoFallbackDraft(e.target.checked)}
                    className="accent-amber-400 rounded mt-0.5 sm:mt-0"
                  />
                  <span>
                    Automatischer Remote-Fallback, wenn die lokale LAN-Adresse unterwegs nicht
                    erreichbar ist
                  </span>
                </label>

                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  <HardDrive className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>
                    Geräte-Ziel:{' '}
                    <code className="font-mono text-slate-200">
                      {deviceBaseUrl || getEffectiveNasOrigin()}
                    </code>
                  </span>
                  {deviceBaseUrl && (
                    <button
                      type="button"
                      onClick={handleResetDeviceTarget}
                      className="text-[11px] text-amber-300 hover:text-amber-200 underline"
                    >
                      Zurücksetzen
                    </button>
                  )}
                </div>
              </div>

              <div className="pt-2.5 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <label className="flex items-start sm:items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowLocalSelfSignedDraft}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setAllowLocalSelfSignedDraft(next);
                      syncLocalTlsPolicyWithAndroidBridge(next);
                    }}
                    className="accent-emerald-400 rounded mt-0.5 sm:mt-0"
                  />
                  <span>
                    Interne/selbstsignierte Zertifikate im{' '}
                    <strong className="text-emerald-300 font-semibold">lokalen Heimnetz-Modus</strong>{' '}
                    (z. B. FRITZ!Box &amp; LAN-NAS) automatisch akzeptieren
                  </span>
                </label>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded border bg-slate-900 border-slate-700 text-slate-300 whitespace-nowrap inline-flex items-center gap-1 self-start sm:self-center">
                  <ShieldAlert className="w-3 h-3 text-amber-400" />
                  <span>WAN-Hosts bleiben streng geprüft</span>
                </span>
              </div>
            </div>

            {/* Alternative zu Port 3000 & Automatischer Port-Scan */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-lg border bg-[#121722] border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                    <Radar className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      Alternative zu Port 3000 &amp; Automatischer Port-Scan
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                      Falls Port <code className="font-mono text-amber-300">:3000</code> nicht reagiert
                      oder den Zugriff verweigert, wechselt EntenCenter automatisch auf den gewählten
                      Ausweichport oder sucht per Scan einen nutzbaren Port.
                    </p>
                  </div>
                </div>
                <span className="text-[10px] font-mono px-2.5 py-1 rounded border bg-amber-400/10 border-amber-400/35 text-amber-200 whitespace-nowrap">
                  Ausweichport :{preferredAltPortDraft}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label
                    htmlFor="admin-alt-port-select"
                    className="block text-[11px] font-medium text-slate-300"
                  >
                    Bevorzugter Ausweichport (wenn :3000 blockiert ist)
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      id="admin-alt-port-select"
                      value={preferredAltPortDraft}
                      onChange={(e) => {
                        const val = setPreferredAlternativePort(Number(e.target.value));
                        setPreferredAltPortDraft(val);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white focus:outline-none focus:border-amber-400"
                    >
                      {DEFAULT_ALTERNATIVE_PORTS.map((portOption) => (
                        <option key={portOption} value={portOption}>
                          Port {portOption}
                          {portOption === 3001
                            ? ' (Empfohlen Alt. 1)'
                            : portOption === 8080
                              ? ' (HTTP-Proxy)'
                              : portOption === 8443
                                ? ' (HTTPS-Alt)'
                                : ''}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoPortFallbackDraft}
                        onChange={(e) => {
                          const enabled = setAutoPortFallbackEnabled(e.target.checked);
                          setAutoPortFallbackDraft(enabled);
                        }}
                        className="accent-amber-400 rounded"
                      />
                      <span>Automatisch ausweichen</span>
                    </label>
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="admin-port-scan-target"
                    className="block text-[11px] font-medium text-slate-300"
                  >
                    Host / IP für automatischen Port-Scan
                  </label>
                  <div className="flex flex-wrap sm:flex-nowrap gap-2">
                    <input
                      id="admin-port-scan-target"
                      type="text"
                      value={portScanTargetDraft}
                      onChange={(e) => setPortScanTargetDraft(e.target.value)}
                      placeholder={
                        lanAddressDraft.trim() ||
                        remoteAddressDraft.trim() ||
                        '192.168.178.69'
                      }
                      className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      disabled={portScanBusy}
                      onClick={() => void handleRunPortScan()}
                      className="px-3.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                    >
                      <Radar className={`w-3.5 h-3.5 ${portScanBusy ? 'animate-spin' : ''}`} />
                      <span>
                        {portScanBusy ? 'Scanne Ports...' : 'Automatischen Port-Scan starten'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              {portScanResult && (
                <div className="rounded-lg bg-[#121722] border border-slate-800 p-3 space-y-2.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-200">{portScanResult.summary}</span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {portScanResult.hostname} · {portScanResult.durationMs} ms ({portScanResult.executedOn})
                    </span>
                  </div>

                  {portScanResult.recommendedBaseUrl && (
                    <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/40 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-emerald-200 font-mono">
                        Empfohlen: <strong>{portScanResult.recommendedBaseUrl}</strong>
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            handleAdoptScannedPortUrl(
                              portScanResult.recommendedBaseUrl!,
                              'lan',
                              portScanResult.recommendedPort ?? undefined
                            )
                          }
                          className="px-2.5 py-1 rounded bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-[10px] font-semibold"
                        >
                          Als LAN-Adresse übernehmen
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleAdoptScannedPortUrl(
                              portScanResult.recommendedBaseUrl!,
                              'device',
                              portScanResult.recommendedPort ?? undefined
                            )
                          }
                          className="px-2.5 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/45 text-emerald-200 text-[10px] font-medium"
                        >
                          Auf Gerät aktivieren
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-[11px]">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-1.5 pr-3 font-medium">Port</th>
                          <th className="py-1.5 pr-3 font-medium">Dienst / Rolle</th>
                          <th className="py-1.5 pr-3 font-medium">Status</th>
                          <th className="py-1.5 pr-3 font-medium">Latenz</th>
                          <th className="py-1.5 font-medium text-right">Aktion</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {portScanResult.ports
                          .filter((entry) => entry.tcpOpen || entry.port === 3000 || entry.port === preferredAltPortDraft || entry.port === 8080)
                          .map((entry) => {
                            const portUrl = `${entry.scheme}://${portScanResult.hostname}:${entry.port}`;
                            return (
                              <tr key={`${entry.scheme}-${entry.port}`}>
                                <td className="py-1.5 pr-3 font-mono text-white whitespace-nowrap">
                                  :{entry.port} ({entry.scheme.toUpperCase()})
                                </td>
                                <td className="py-1.5 pr-3 text-slate-300">{entry.label}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">
                                  {entry.isEntenCenter ? (
                                    <span className="text-emerald-300 font-semibold">
                                      EntenCenter aktiv
                                    </span>
                                  ) : entry.tcpOpen ? (
                                    <span className="text-amber-300">
                                      Offen{entry.httpStatus ? ` (HTTP ${entry.httpStatus})` : ' (TCP)'}
                                    </span>
                                  ) : (
                                    <span className="text-slate-500">
                                      {entry.errorCode || 'Nicht erreichbar'}
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 pr-3 font-mono text-slate-300 tabular-nums">
                                  {entry.latencyMs !== null ? `${entry.latencyMs} ms` : '—'}
                                </td>
                                <td className="py-1.5 text-right whitespace-nowrap">
                                  {(entry.isEntenCenter || entry.usableAsAlternative) && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleAdoptScannedPortUrl(portUrl, 'lan', entry.port)
                                      }
                                      className="px-2 py-0.5 rounded bg-[#0B0E14] hover:bg-slate-800 border border-amber-400/45 text-amber-200 text-[10px] font-medium"
                                    >
                                      Nutzen
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Sicherheitszertifikat hochladen (gilt für alle Nutzer dieses NAS) */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
                      securityCertificate
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-[#121722] border-slate-800 text-amber-400'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      Sicherheitszertifikat hochladen
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                      Dieses Sicherheitszertifikat wird zentral auf dem NAS gespeichert und gilt
                      automatisch für alle Nutzer, die auf das gleiche NAS zugreifen.
                    </p>
                  </div>
                </div>

                <span
                  className={`text-[10px] font-semibold px-2.5 py-1 rounded-md border whitespace-nowrap ${
                    securityCertificate
                      ? securityCertificate.isExpired
                        ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                        : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}
                >
                  {securityCertificate
                    ? securityCertificate.isExpired
                      ? 'Zertifikat abgelaufen'
                      : 'Aktiv für alle NAS-Nutzer'
                    : 'Kein Zertifikat hinterlegt'}
                </span>
              </div>

              {securityCertificate && (
                <div className="rounded-lg bg-[#121722] border border-slate-800/90 p-3 space-y-2 text-[11px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-white">
                      {securityCertificate.label}{' '}
                      <span className="font-mono text-[10px] font-normal text-slate-400">
                        ({securityCertificate.fileName})
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={resolveNasUrl('/api/nas/network/certificate/download')}
                        download={securityCertificate.fileName}
                        className="px-2.5 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-amber-300 inline-flex items-center gap-1 transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        <span>.pem laden</span>
                      </a>
                      <button
                        type="button"
                        disabled={certDeleting || certUploading}
                        onClick={() => void handleDeleteCertificate()}
                        className="px-2.5 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-50 border border-rose-500/35 text-[11px] font-medium text-rose-300 inline-flex items-center gap-1 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{certDeleting ? 'Entferne...' : 'Entfernen'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                    <div className="text-slate-400 truncate" title={securityCertificate.subject}>
                      Subject:{' '}
                      <span className="font-mono text-slate-200">{securityCertificate.subject}</span>
                    </div>
                    <div className="text-slate-400 truncate" title={securityCertificate.issuer}>
                      Aussteller:{' '}
                      <span className="font-mono text-slate-200">{securityCertificate.issuer}</span>
                    </div>
                    <div className="text-slate-400">
                      Gültig:{' '}
                      <span className="font-mono text-slate-200 tabular-nums">
                        {new Date(securityCertificate.validFrom).toLocaleDateString('de-DE')} –{' '}
                        {new Date(securityCertificate.validTo).toLocaleDateString('de-DE')}
                      </span>
                    </div>
                    <div className="text-slate-400">
                      Hochgeladen:{' '}
                      <span className="text-slate-200">
                        {securityCertificate.uploadedBy} (
                        {new Date(securityCertificate.uploadedAt).toLocaleString('de-DE')})
                      </span>
                    </div>
                    {securityCertificate.subjectAltName && (
                      <div
                        className="sm:col-span-2 text-slate-400 truncate"
                        title={securityCertificate.subjectAltName}
                      >
                        SAN:{' '}
                        <span className="font-mono text-slate-300">
                          {securityCertificate.subjectAltName}
                        </span>
                      </div>
                    )}
                    <div
                      className="sm:col-span-2 text-slate-400 truncate"
                      title={securityCertificate.fingerprint256}
                    >
                      SHA-256:{' '}
                      <span className="font-mono text-[10px] text-emerald-300">
                        {securityCertificate.fingerprint256}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                <input
                  type="text"
                  value={certLabelDraft}
                  onChange={(e) => setCertLabelDraft(e.target.value)}
                  placeholder="Optional: Bezeichnung (z. B. Heim-NAS TLS-Zertifikat)"
                  aria-label="Optionale Bezeichnung für das Sicherheitszertifikat"
                  className="flex-1 px-3 py-1.5 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />

                <label className="px-3.5 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/45 text-xs font-semibold text-amber-200 inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap">
                  <Upload className="w-3.5 h-3.5 text-amber-300" />
                  <span>
                    {certUploading
                      ? 'Lade hoch...'
                      : securityCertificate
                        ? 'Zertifikat ersetzen (.crt / .pem / .cer)'
                        : 'Sicherheitszertifikat hochladen (.crt / .pem / .cer)'}
                  </span>
                  <input
                    type="file"
                    accept=".pem,.crt,.cer,.der,application/x-x509-ca-cert,application/pkix-cert"
                    disabled={certUploading || certDeleting}
                    onChange={(e) => void handleCertificateFileSelect(e)}
                    className="sr-only"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setCertShowPaste((prev) => !prev)}
                  className="px-3 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 whitespace-nowrap transition-colors"
                >
                  {certShowPaste ? 'PEM-Feld schließen' : 'PEM einfügen'}
                </button>
              </div>

              {certShowPaste && (
                <div className="space-y-2 pt-1">
                  <textarea
                    rows={4}
                    value={certPemPasteDraft}
                    onChange={(e) => setCertPemPasteDraft(e.target.value)}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                    aria-label="PEM-Zertifikatstext einfügen"
                    className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-[11px] font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-400"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={certUploading || !certPemPasteDraft.trim()}
                      onClick={() =>
                        void uploadCertificatePayload('pasted-nas-cert.pem', certPemPasteDraft)
                      }
                      className="px-3.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors"
                    >
                      PEM-Zertifikat speichern
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* FRITZ!Box Challenge-Response Login & SID-Session */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
                      fritzStatus?.connected
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-[#121722] border-slate-800 text-amber-400'
                    }`}
                  >
                    <Router className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      FRITZ!Box Challenge-Response &amp; SID-Session (TR-064 / FRITZ!NAS)
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                      Automatischer AVM Challenge-Response-Handshake (<code className="font-mono">login_sid.lua</code>{' '}
                      UTF-16LE MD5), Wiederverwendung aktiver Session-IDs (SID) und direkter
                      TR-064/FRITZ!NAS-Zugriff ohne Router-WebUI.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {fritzStatus?.tr064Available && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded border bg-sky-500/15 border-sky-500/40 text-sky-300 whitespace-nowrap">
                      TR-064 aktiv
                    </span>
                  )}
                  <span
                    className={`text-[10px] font-semibold px-2.5 py-1 rounded-md border whitespace-nowrap ${
                      fritzStatus?.connected
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-900 border-slate-700 text-slate-400'
                    }`}
                  >
                    {fritzStatus?.connected
                      ? `SID aktiv (${fritzStatus.sidPreview || 'ok'})`
                      : 'Keine aktive SID'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                <input
                  type="text"
                  value={fritzHostDraft}
                  onChange={(e) => setFritzHostDraft(e.target.value)}
                  placeholder="fritz.box oder 192.168.178.1"
                  aria-label="FRITZ!Box Hostname oder IP"
                  className="px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={fritzPortDraft}
                    onChange={(e) => setFritzPortDraft(e.target.value)}
                    placeholder="443"
                    aria-label="FRITZ!Box Port"
                    className="w-24 px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                  />
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={fritzUseTlsDraft}
                      onChange={(e) => {
                        const tls = e.target.checked;
                        setFritzUseTlsDraft(tls);
                        if (fritzPortDraft === '80' && tls) setFritzPortDraft('443');
                        if (fritzPortDraft === '443' && !tls) setFritzPortDraft('80');
                      }}
                      className="accent-amber-400 rounded"
                    />
                    <span>HTTPS</span>
                  </label>
                </div>
                <input
                  type="text"
                  value={fritzUserDraft}
                  onChange={(e) => setFritzUserDraft(e.target.value)}
                  placeholder="FRITZ!Box-Benutzer (optional)"
                  aria-label="FRITZ!Box Benutzername"
                  className="px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <input
                  type="password"
                  value={fritzPasswordDraft}
                  onChange={(e) => setFritzPasswordDraft(e.target.value)}
                  placeholder={
                    fritzStatus?.hasSecret
                      ? 'Passwort gespeichert (zum Ändern neu eingeben)'
                      : 'FRITZ!Box-Passwort'
                  }
                  aria-label="FRITZ!Box Passwort"
                  className="px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>

              {fritzStatus && (
                <div className="rounded-lg bg-[#121722] border border-slate-800/90 px-3 py-2 text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {fritzStatus.friendlyName ? (
                      <strong className="text-white">{fritzStatus.friendlyName}</strong>
                    ) : (
                      'FRITZ!Box'
                    )}
                    {fritzStatus.modelName ? ` (${fritzStatus.modelName})` : ''} · {fritzStatus.message}
                  </span>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-400">
                    {fritzStatus.challengeVersion && (
                      <span>Verfahren: {fritzStatus.challengeVersion}</span>
                    )}
                    {fritzStatus.tlsBypassedForLocalSelfSigned && (
                      <span className="text-emerald-300">Lokales Selbstsigniert-TLS akzeptiert</span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={fritzBusy}
                  onClick={() => void handleFritzStatusCheck()}
                  className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-[11px] font-medium text-slate-200 inline-flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${fritzBusy ? 'animate-spin' : ''}`} />
                  <span>Status &amp; TR-064 prüfen</span>
                </button>
                <button
                  type="button"
                  disabled={fritzBusy}
                  onClick={() => void handleFritzChallengeLogin(false)}
                  className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors"
                >
                  <KeyRound className="w-3 h-3" />
                  <span>Challenge-Response Login (SID)</span>
                </button>
                <button
                  type="button"
                  disabled={fritzBusy}
                  onClick={() => void handleFritzBrowse(fritzBrowsePath || '/')}
                  className="px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 border border-sky-500/40 text-[11px] font-medium text-sky-200 inline-flex items-center gap-1.5 transition-colors"
                >
                  <Folder className="w-3 h-3" />
                  <span>FRITZ!NAS Medien lesen</span>
                </button>
                {fritzStatus?.connected && (
                  <button
                    type="button"
                    disabled={fritzBusy}
                    onClick={() => void handleFritzLogout()}
                    className="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-50 border border-rose-500/35 text-[11px] font-medium text-rose-300 inline-flex items-center gap-1.5 transition-colors"
                  >
                    <LogOut className="w-3 h-3" />
                    <span>SID abmelden</span>
                  </button>
                )}
              </div>

              {fritzBrowseItems.length > 0 && (
                <div className="rounded-lg bg-[#121722] border border-slate-800 p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono text-slate-300">
                      FRITZ!NAS Pfad: <strong className="text-white">{fritzBrowsePath}</strong>
                      {fritzBrowseSource ? ` · Quelle: ${fritzBrowseSource}` : ''}
                    </span>
                    {fritzBrowsePath !== '/' && (
                      <button
                        type="button"
                        onClick={() => {
                          const parent =
                            fritzBrowsePath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
                          void handleFritzBrowse(parent);
                        }}
                        className="text-[11px] text-amber-300 hover:text-amber-200 underline"
                      >
                        .. Ebene hoch
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
                    {fritzBrowseItems.map((item) => (
                      <button
                        key={`${item.type}-${item.path}-${item.name}`}
                        type="button"
                        onClick={() => {
                          if (item.type === 'directory') {
                            void handleFritzBrowse(item.path);
                          }
                        }}
                        className="px-2.5 py-2 rounded-lg bg-[#0B0E14] border border-slate-800/90 hover:border-slate-700 text-left flex items-center gap-2 text-[11px] transition-colors"
                      >
                        {item.type === 'directory' ? (
                          <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        )}
                        <span className="truncate text-slate-200 font-medium">{item.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modulare NAS-Verbindungsprofile (Heimnetz & Externe NAS: DynDNS / Domain / VPN) */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-lg border bg-[#121722] border-slate-800 text-sky-400 flex items-center justify-center shrink-0">
                    <Server className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      Modulare NAS-Verbindungsprofile (Heimnetz &amp; Externe NAS)
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                      Verwalte beliebig viele Profile für lokales LAN/FRITZ!NAS sowie externe
                      NAS-Systeme via DynDNS, HTTPS-Domain, VPN oder Reverse Proxy über alle
                      gängigen Protokolle (SMB, WebDAV, NFS, SFTP, FTPS, REST-API, UPnP/TR-064).
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowNewProfileForm((prev) => !prev)}
                  className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{showNewProfileForm ? 'Formular schließen' : 'Neues Profil hinzufügen'}</span>
                </button>
              </div>

              {showNewProfileForm && (
                <form
                  onSubmit={(e) => void handleSaveNewProfile(e)}
                  className="rounded-xl bg-[#121722] border border-slate-800 p-3.5 space-y-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      required
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="Profilname (z. B. Synology via DynDNS)"
                      aria-label="Profilname"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <select
                      aria-label="Verbindungsbereich (Lokal oder Extern)"
                      value={newProfileScope}
                      onChange={(e) => setNewProfileScope(e.target.value as NasProfileScope)}
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-sky-400"
                    >
                      {(Object.keys(PROFILE_SCOPE_META) as NasProfileScope[]).map((scopeKey) => (
                        <option key={scopeKey} value={scopeKey}>
                          {PROFILE_SCOPE_META[scopeKey].label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Verbindungsprotokoll"
                      value={newProfileProtocol}
                      onChange={(e) => handleSelectProfileProtocol(e.target.value as NasProtocolId)}
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-sky-400"
                    >
                      {PROFILE_PROTOCOL_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <input
                      type="text"
                      required
                      value={newProfileHost}
                      onChange={(e) => setNewProfileHost(e.target.value)}
                      placeholder="Host / IP / URL (z. B. nas.duckdns.org)"
                      aria-label="NAS Host oder URL"
                      className="sm:col-span-2 px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <input
                      type="text"
                      value={newProfilePort}
                      onChange={(e) => setNewProfilePort(e.target.value)}
                      placeholder="Port"
                      aria-label="Port"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <input
                      type="text"
                      value={newProfileShareOrPath}
                      onChange={(e) => setNewProfileShareOrPath(e.target.value)}
                      placeholder="Freigabe / Pfad (z. B. /Media)"
                      aria-label="Freigabe oder Pfad"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      value={newProfileUsername}
                      onChange={(e) => setNewProfileUsername(e.target.value)}
                      placeholder="Benutzername (optional)"
                      aria-label="Profil Benutzername"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <input
                      type="password"
                      value={newProfileSecret}
                      onChange={(e) => setNewProfileSecret(e.target.value)}
                      placeholder="Passwort / API-Token (verschlüsselt)"
                      aria-label="Profil Passwort oder Token"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                    <input
                      type="text"
                      value={newProfileHint}
                      onChange={(e) => setNewProfileHint(e.target.value)}
                      placeholder="Notiz / DDNS- / VPN-Hinweis (optional)"
                      aria-label="Profil Hinweis"
                      className="px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-300">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newProfileUseTls}
                          onChange={(e) => setNewProfileUseTls(e.target.checked)}
                          className="accent-sky-400 rounded"
                        />
                        <span>TLS / SSL verwenden</span>
                      </label>
                      {newProfileScope === 'lan' && (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newProfileAllowSelfSignedLocalTls}
                            onChange={(e) =>
                              setNewProfileAllowSelfSignedLocalTls(e.target.checked)
                            }
                            className="accent-emerald-400 rounded"
                          />
                          <span>Lokales selbstsigniertes Zertifikat erlauben</span>
                        </label>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={savingNewProfile}
                      className="px-3.5 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors"
                    >
                      {savingNewProfile ? 'Speichere...' : 'Profil im NAS-Tresor speichern'}
                    </button>
                  </div>
                </form>
              )}

              {profiles.length === 0 ? (
                <div className="rounded-lg bg-[#121722] border border-slate-800/80 px-3.5 py-3 text-[11px] text-slate-400">
                  Noch keine modularen NAS-Profile geladen oder hinterlegt. Lege oben ein Profil
                  für Heimnetz oder externen Zugriff (DynDNS, Domain, VPN) an.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {profiles.map((prof) => {
                    const scopeMeta = PROFILE_SCOPE_META[prof.scope] ?? PROFILE_SCOPE_META.lan;
                    const busy = profilesBusyId === prof.id;
                    return (
                      <div
                        key={prof.id}
                        className={`rounded-xl border p-3.5 space-y-2.5 ${
                          prof.isActive
                            ? 'bg-emerald-500/5 border-emerald-500/50'
                            : 'bg-[#121722] border-slate-800/90'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold text-white truncate">
                                {prof.name}
                              </span>
                              {prof.isActive && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-400 text-slate-950">
                                  Aktiv
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] font-mono text-slate-300 truncate mt-0.5">
                              {prof.host}
                              {prof.port ? `:${prof.port}` : ''}
                              {prof.shareOrPath ? ` · ${prof.shareOrPath}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1 shrink-0">
                            <span
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${scopeMeta.badgeClass}`}
                            >
                              {scopeMeta.shortLabel}
                            </span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded border bg-[#0B0E14] border-slate-700 text-slate-300 uppercase">
                              {prof.protocol}
                            </span>
                          </div>
                        </div>

                        {prof.lastTestMessage && (
                          <p
                            className={`text-[10px] leading-snug ${
                              prof.lastTestOk === true
                                ? 'text-emerald-300'
                                : prof.lastTestOk === false
                                  ? 'text-rose-300'
                                  : 'text-slate-400'
                            }`}
                          >
                            {prof.lastTestMessage}
                            {typeof prof.lastLatencyMs === 'number'
                              ? ` (${prof.lastLatencyMs} ms)`
                              : ''}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleTestProfile(prof.id)}
                            className="px-2.5 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-[11px] font-medium text-slate-200 inline-flex items-center gap-1 transition-colors"
                          >
                            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
                            <span>Testen</span>
                          </button>
                          {!prof.isActive && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleActivateProfile(prof.id)}
                              className="px-2.5 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 border border-emerald-500/40 text-[11px] font-medium text-emerald-200 inline-flex items-center gap-1 transition-colors"
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Aktivieren</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDeleteProfile(prof.id)}
                            className="px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-50 border border-rose-500/35 text-[11px] font-medium text-rose-300 inline-flex items-center gap-1 ml-auto transition-colors"
                            aria-label={`Profil ${prof.name} löschen`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Live-Testergebnis */}
            {testResult && (
              <div
                className={`p-3.5 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
                  testResult.ok
                    ? 'bg-emerald-950/40 border-emerald-800/70 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-800/70 text-rose-200'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {testResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  )}
                  <span className="break-words">{testResult.message || testResult.error}</span>
                </div>
                {testResult.resolvedIp && (
                  <span className="font-mono text-[11px] text-slate-300 tabular-nums whitespace-nowrap">
                    {testResult.resolvedIp}
                    {testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : ''}
                  </span>
                )}
              </div>
            )}

            {mixedContentDirectUrl && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Direkte HTTP-Verbindungen zu{' '}
                  <code className="font-mono">{mixedContentDirectUrl}</code> werden im HTTPS-Browser
                  blockiert:
                </span>
                <a
                  href={mixedContentDirectUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 transition-colors"
                >
                  <span>Direkt öffnen</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
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

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 pb-[calc(1rem+var(--app-bottom-clearance,0px))]">
              <div className="text-[11px] text-slate-400">
                {isDirty ? (
                  'Ungespeicherte Änderungen in der Netzwerk-Konfiguration.'
                ) : savedConfig?.updatedAt ? (
                  <>
                    Zuletzt gespeichert: {new Date(savedConfig.updatedAt).toLocaleString('de-DE')}
                    {savedConfig.updatedBy ? ` (${savedConfig.updatedBy})` : ''}
                    {localSubnets.length > 0 ? ` · NAS-Subnetz: ${localSubnets.join(', ')}` : ''}
                    {clientIp ? ` · Client: ${clientIp}` : ''}
                  </>
                ) : (
                  'Lege hier feste Adressen für Heim-LAN und Remote-Zugriff (WAN/VPN) fest.'
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5 ml-auto">
                <button
                  type="button"
                  disabled={loading || saving}
                  onClick={() => void loadNetworkConfig()}
                  className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Neu laden</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveNetworkConfig()}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>
                    {saving ? 'Speichere...' : 'Netzwerk-Konfiguration speichern'}
                  </span>
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
