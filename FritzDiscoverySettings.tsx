import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Network,
  Radar,
  RefreshCw,
  Save,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import type {
  FritzUpnpDiscoveryConfig,
  FritzUpnpProbeResult,
} from '../types/marcente';
import { isLocalFallbackToken, readLocalOnboardingBuffer } from '../lib/localBufferStore';
import {
  cleanHostOnly,
  discoverFritzboxNas,
  readAllLocalProvisionedBackends,
  readFileFromNasBridge,
  readLocalProvisionedBackendForHost,
  sanitizeNasPortForProtocol,
  writeFileToNasBridge,
} from '../lib/nasClient';

const LOCAL_FRITZ_DISCOVERY_KEY = 'entencenter_local_admin_fritz_discovery_v1';

interface FritzDiscoverySettingsProps {
  token: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const DEFAULT_CONFIG: FritzUpnpDiscoveryConfig = {
  enabled: false,
  autoTokenlessLogin: true,
  subnetMatchRequired: true,
  subnetCidr: '',
  probeHosts: ['fritz.box', '192.168.178.1'],
  probePort: '49000',
  lastScanAt: null,
  lastScanStatus: 'idle',
  lastScanMessage: null,
  discoveredDevices: [],
  updatedAt: null,
  updatedBy: null,
};

export const FritzDiscoverySettings: React.FC<FritzDiscoverySettingsProps> = ({
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
  const [savedConfig, setSavedConfig] = useState<FritzUpnpDiscoveryConfig>(DEFAULT_CONFIG);
  const [draftConfig, setDraftConfig] = useState<FritzUpnpDiscoveryConfig>(DEFAULT_CONFIG);
  const [probeHostsInput, setProbeHostsInput] = useState('fritz.box, 192.168.178.1');
  const [localSubnets, setLocalSubnets] = useState<string[]>([]);
  const [nasIps, setNasIps] = useState<string[]>([]);
  const [lastProbe, setLastProbe] = useState<FritzUpnpProbeResult | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyServerConfig = useCallback((cfg: FritzUpnpDiscoveryConfig) => {
    setSavedConfig(cfg);
    setDraftConfig(cfg);
    setProbeHostsInput(
      Array.isArray(cfg.probeHosts) && cfg.probeHosts.length > 0
        ? cfg.probeHosts.join(', ')
        : 'fritz.box, 192.168.178.1'
    );
  }, []);

  const resolveBridgeForDiscovery = useCallback(() => {
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

  const loadConfig = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    if (isLocalFallbackToken(token)) {
      try {
        const { conn, host, pass, protocol, useTls, port, backendRoot } =
          resolveBridgeForDiscovery();
        let remoteParsed: FritzUpnpDiscoveryConfig | null = null;
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
            targetPath: `${backendRoot}/config/fritz-discovery.json`,
          }).catch(() => null);
          if (remoteRes?.ok && remoteRes.content) {
            remoteParsed = JSON.parse(remoteRes.content) as FritzUpnpDiscoveryConfig;
          }
        }
        const raw = window.localStorage.getItem(LOCAL_FRITZ_DISCOVERY_KEY);
        const localParsed = raw ? (JSON.parse(raw) as FritzUpnpDiscoveryConfig) : null;
        const parsed = remoteParsed ?? localParsed;
        applyServerConfig(parsed ? { ...DEFAULT_CONFIG, ...parsed } : DEFAULT_CONFIG);
      } catch {
        applyServerConfig(DEFAULT_CONFIG);
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/fritz-discovery', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        config?: FritzUpnpDiscoveryConfig;
        localSubnets?: string[];
        nasIps?: string[];
        error?: string;
      };
      if (!res.ok || !data.config) {
        setError(data.error || 'Discovery-Einstellungen konnten nicht geladen werden.');
        return;
      }
      applyServerConfig(data.config);
      setLocalSubnets(Array.isArray(data.localSubnets) ? data.localSubnets : []);
      setNasIps(Array.isArray(data.nasIps) ? data.nasIps : []);
    } catch {
      setError('Verbindung zum NAS beim Laden der Discovery-Einstellungen fehlgeschlagen.');
    } finally {
      setLoading(false);
    }
  }, [applyServerConfig, resolveBridgeForDiscovery, token]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const parsedProbeHosts = probeHostsInput
    .split(/[\s,;]+/)
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const isDirty =
    draftConfig.enabled !== savedConfig.enabled ||
    draftConfig.autoTokenlessLogin !== savedConfig.autoTokenlessLogin ||
    draftConfig.subnetMatchRequired !== savedConfig.subnetMatchRequired ||
    draftConfig.subnetCidr.trim() !== savedConfig.subnetCidr.trim() ||
    draftConfig.probePort.trim() !== savedConfig.probePort.trim() ||
    parsedProbeHosts.join(',') !== (savedConfig.probeHosts ?? []).join(',');

  const handleSave = async (overrideEnabled?: boolean) => {
    setError(null);
    setNotice(null);
    setSaving(true);
    const nextEnabled =
      typeof overrideEnabled === 'boolean' ? overrideEnabled : draftConfig.enabled;
    if (isLocalFallbackToken(token)) {
      try {
        const localSaved: FritzUpnpDiscoveryConfig = {
          ...draftConfig,
          enabled: nextEnabled,
          probeHosts:
            parsedProbeHosts.length > 0 ? parsedProbeHosts : ['fritz.box', '192.168.178.1'],
          probePort: draftConfig.probePort.trim() || '49000',
          updatedAt: new Date().toISOString(),
          updatedBy: 'storage-bridge',
        };
        window.localStorage.setItem(LOCAL_FRITZ_DISCOVERY_KEY, JSON.stringify(localSaved));
        const { conn, host, pass, protocol, useTls, port, backendRoot } =
          resolveBridgeForDiscovery();
        if (host && pass) {
          await writeFileToNasBridge({
            protocol,
            host,
            port,
            shareOrPath: protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: conn?.username || '',
            password: pass,
            fritzPassword: pass,
            useTls,
            targetPath: `${backendRoot}/config/fritz-discovery.json`,
            content: JSON.stringify(localSaved, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        applyServerConfig(localSaved);
        setNotice(
          localSaved.enabled
            ? 'FRITZ!Box Discovery aktiviert & in Storage-Bridge gespeichert.'
            : 'FRITZ!Box Discovery in Storage-Bridge gespeichert.'
        );
      } catch {
        setError('Discovery-Einstellungen konnten nicht gespeichert werden.');
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/nas/admin/fritz-discovery', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: nextEnabled,
          autoTokenlessLogin: draftConfig.autoTokenlessLogin,
          subnetMatchRequired: draftConfig.subnetMatchRequired,
          subnetCidr: draftConfig.subnetCidr.trim(),
          probeHosts:
            parsedProbeHosts.length > 0 ? parsedProbeHosts : ['fritz.box', '192.168.178.1'],
          probePort: draftConfig.probePort.trim() || '49000',
          runScanNow: nextEnabled && !savedConfig.enabled,
        }),
      });
      const data = (await res.json()) as {
        config?: FritzUpnpDiscoveryConfig;
        localSubnets?: string[];
        nasIps?: string[];
        probe?: FritzUpnpProbeResult | null;
        error?: string;
      };
      if (!res.ok || !data.config) {
        setError(data.error || 'Fritzbox UPnP/DLNA-Discovery konnte nicht gespeichert werden.');
        return;
      }
      applyServerConfig(data.config);
      if (Array.isArray(data.localSubnets)) setLocalSubnets(data.localSubnets);
      if (Array.isArray(data.nasIps)) setNasIps(data.nasIps);
      if (data.probe) setLastProbe(data.probe);
      setNotice(
        data.config.enabled
          ? 'Fritzbox UPnP/DLNA-Discovery aktiviert und gespeichert.'
          : 'Fritzbox UPnP/DLNA-Discovery deaktiviert und gespeichert.'
      );
    } catch {
      setError('Verbindung zum NAS beim Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  const handleScanNow = async () => {
    setError(null);
    setNotice(null);
    if (isLocalFallbackToken(token)) {
      setScanning(true);
      try {
        const discovery = await discoverFritzboxNas({
          includeSubnetGatewayScan: true,
        });
        const discoveredList = discovery.devices ?? [];
        const probeSummary: FritzUpnpProbeResult = {
          enabled: draftConfig.enabled,
          autoTokenlessLogin: draftConfig.autoTokenlessLogin,
          subnetMatchRequired: draftConfig.subnetMatchRequired,
          configuredSubnetCidr: draftConfig.subnetCidr,
          localSubnets: discovery.probeResult?.localSubnets ?? [],
          nasIps: discoveredList.map((d) => d.ip),
          clientIp: discovery.probeResult?.clientIp ?? '',
          clientInSameSubnet: Boolean(discovery.probeResult?.clientInSameSubnet),
          discoveredDevices: discoveredList,
          sameSubnetDeviceFound: discoveredList.some((d) => d.sameSubnet),
          tokenlessEligible: Boolean(discovery.probeResult?.tokenlessEligible),
          checkedAt: discovery.scannedAt,
          reason:
            discoveredList.length > 0
              ? `${discoveredList.length} FRITZ!Box- / UPnP-Gerät(e) im Heimnetz gefunden.`
              : 'Kein aktives UPnP-Gerät über Broadcast geantwortet (Direkt-Bridge weiterhin nutzbar).',
        };
        setLastProbe(probeSummary);
        setLocalSubnets(probeSummary.localSubnets);
        setNasIps(probeSummary.nasIps);
        const updated: FritzUpnpDiscoveryConfig = {
          ...draftConfig,
          lastScanAt: discovery.scannedAt,
          lastScanStatus: discoveredList.length > 0 ? 'found' : 'none_found',
          lastScanMessage: probeSummary.reason,
          discoveredDevices: discoveredList,
        };
        window.localStorage.setItem(LOCAL_FRITZ_DISCOVERY_KEY, JSON.stringify(updated));
        applyServerConfig(updated);
        setNotice(probeSummary.reason);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Lokaler FRITZ!Box-Scan fehlgeschlagen.'
        );
      } finally {
        setScanning(false);
      }
      return;
    }
    setScanning(true);
    try {
      const res = await fetch('/api/nas/admin/fritz-discovery/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          probeHosts:
            parsedProbeHosts.length > 0 ? parsedProbeHosts : ['fritz.box', '192.168.178.1'],
          probePort: draftConfig.probePort.trim() || '49000',
          subnetCidr: draftConfig.subnetCidr.trim(),
          subnetMatchRequired: draftConfig.subnetMatchRequired,
        }),
      });
      const data = (await res.json()) as {
        config?: FritzUpnpDiscoveryConfig;
        probe?: FritzUpnpProbeResult;
        error?: string;
      };
      if (!res.ok || !data.probe) {
        setError(data.error || 'Netzwerk-Scan nach FRITZ!Box-Geräten fehlgeschlagen.');
        return;
      }
      if (data.config) {
        setSavedConfig((prev) => ({
          ...prev,
          lastScanAt: data.config!.lastScanAt,
          lastScanStatus: data.config!.lastScanStatus,
          lastScanMessage: data.config!.lastScanMessage,
          discoveredDevices: data.config!.discoveredDevices,
        }));
        setDraftConfig((prev) => ({
          ...prev,
          lastScanAt: data.config!.lastScanAt,
          lastScanStatus: data.config!.lastScanStatus,
          lastScanMessage: data.config!.lastScanMessage,
          discoveredDevices: data.config!.discoveredDevices,
        }));
      }
      setLastProbe(data.probe);
      setLocalSubnets(data.probe.localSubnets);
      setNasIps(data.probe.nasIps);
      setNotice(data.probe.reason);
    } catch {
      setError('Netzwerk-Scan konnte nicht ausgeführt werden.');
    } finally {
      setScanning(false);
    }
  };

  const discoveredDevices =
    lastProbe?.discoveredDevices ?? draftConfig.discoveredDevices ?? [];

  return (
    <div className="rounded-xl bg-[#0B0E14] border border-slate-800/90 p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          onClick={handleToggleCollapse}
          className="flex items-start gap-3 min-w-0 flex-1 text-left"
        >
          <span
            className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${
              draftConfig.enabled
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-[#121722] border-slate-800 text-slate-400'
            }`}
          >
            <Radar className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-xs sm:text-sm font-semibold text-white">
                Fritzbox UPnP/DLNA-Discovery
              </h4>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                  draftConfig.enabled
                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-700'
                }`}
              >
                {draftConfig.enabled ? 'Aktiviert' : 'Deaktiviert'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              Sucht beim Start automatisch per SSDP &amp; UPnP/DLNA nach FRITZ!Box-Geräten im
              Heimnetz und ermöglicht eine tokenlose Anmeldung, sofern dieses NAS im selben Subnetz
              liegt.
            </p>
          </div>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => {
              const next = !draftConfig.enabled;
              setDraftConfig((prev) => ({ ...prev, enabled: next }));
              void handleSave(next);
            }}
            aria-pressed={draftConfig.enabled}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
              draftConfig.enabled
                ? 'bg-emerald-400 hover:bg-emerald-300 text-slate-950 border-emerald-400'
                : 'bg-[#121722] hover:bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            {draftConfig.enabled ? 'Discovery deaktivieren' : 'Discovery aktivieren'}
          </button>
          <button
            type="button"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Discovery-Einstellungen aufklappen' : 'Discovery-Einstellungen zuklappen'}
            onClick={handleToggleCollapse}
            className="p-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300"
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {!isCollapsed && (loading ? (
        <div className="py-4 text-xs text-slate-400">
          Lade Fritzbox UPnP/DLNA-Discovery Einstellungen...
        </div>
      ) : (
        <div className="space-y-4 pt-2 border-t border-slate-800/80">
          {/* Optionen */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[#121722] border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={draftConfig.autoTokenlessLogin}
                onChange={(e) =>
                  setDraftConfig((prev) => ({
                    ...prev,
                    autoTokenlessLogin: e.target.checked,
                  }))
                }
                className="accent-emerald-400 mt-0.5 rounded"
              />
              <div>
                <span className="text-xs font-semibold text-white block">
                  Automatische tokenlose Anmeldung
                </span>
                <span className="text-[11px] text-slate-400 block mt-0.5">
                  Loggt Heimnetz-Clients beim App-Start direkt ohne Passwort oder Token ein, wenn
                  FRITZ!Box &amp; NAS im selben Subnetz erkannt werden.
                </span>
              </div>
            </label>

            <label className="flex items-start gap-2.5 p-3 rounded-lg bg-[#121722] border border-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={draftConfig.subnetMatchRequired}
                onChange={(e) =>
                  setDraftConfig((prev) => ({
                    ...prev,
                    subnetMatchRequired: e.target.checked,
                  }))
                }
                className="accent-emerald-400 mt-0.5 rounded"
              />
              <div>
                <span className="text-xs font-semibold text-white block">
                  Selbes Subnetz zwingend prüfen
                </span>
                <span className="text-[11px] text-slate-400 block mt-0.5">
                  Erlaubt tokenlosen Zugriff nur, wenn NAS, Client und entdeckte FRITZ!Box im
                  selben IPv4-Subnetz liegen.
                </span>
              </div>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label
                htmlFor="fritz-discovery-hosts"
                className="text-[11px] font-medium text-slate-300 block mb-1"
              >
                Such-Hosts für UPnP/DLNA (kommagetrennt)
              </label>
              <input
                id="fritz-discovery-hosts"
                type="text"
                value={probeHostsInput}
                onChange={(e) => setProbeHostsInput(e.target.value)}
                placeholder="fritz.box, 192.168.178.1"
                className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div>
              <label
                htmlFor="fritz-discovery-port"
                className="text-[11px] font-medium text-slate-300 block mb-1"
              >
                UPnP-Port
              </label>
              <input
                id="fritz-discovery-port"
                type="text"
                value={draftConfig.probePort}
                onChange={(e) =>
                  setDraftConfig((prev) => ({ ...prev, probePort: e.target.value }))
                }
                placeholder="49000"
                className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400 tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div>
              <label
                htmlFor="fritz-discovery-cidr"
                className="text-[11px] font-medium text-slate-300 block mb-1"
              >
                Erwartetes Subnetz CIDR (optional, sonst automatisch)
              </label>
              <input
                id="fritz-discovery-cidr"
                type="text"
                value={draftConfig.subnetCidr}
                onChange={(e) =>
                  setDraftConfig((prev) => ({ ...prev, subnetCidr: e.target.value }))
                }
                placeholder={localSubnets[0] || 'z. B. 192.168.178.0/24'}
                className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div className="p-2.5 rounded-lg bg-[#121722] border border-slate-800 text-[11px] text-slate-300 flex items-center gap-2">
              <Network className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <div className="min-w-0 truncate">
                <span className="text-slate-400">NAS-Subnetz: </span>
                <span className="font-mono text-white">
                  {localSubnets.length > 0 ? localSubnets.join(', ') : 'kein LAN-Subnetz'}
                </span>
                {nasIps.length > 0 && (
                  <span className="text-slate-500 font-mono ml-1">({nasIps[0]})</span>
                )}
              </div>
            </div>
          </div>

          {/* Gefundene Geräte & Scan-Ergebnis */}
          <div className="rounded-lg bg-[#121722] border border-slate-800 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-xs font-semibold text-white">
                  Erkannte FRITZ!Box UPnP/DLNA-Geräte ({discoveredDevices.length})
                </span>
              </div>
              {draftConfig.lastScanAt && (
                <span className="text-[11px] text-slate-400 tabular-nums">
                  Letzter Scan: {new Date(draftConfig.lastScanAt).toLocaleString('de-DE')}
                </span>
              )}
            </div>

            {discoveredDevices.length > 0 ? (
              <div className="space-y-2">
                {discoveredDevices.map((dev) => (
                  <div
                    key={dev.id}
                    className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-white truncate">{dev.friendlyName}</p>
                      <p className="text-[11px] font-mono text-slate-400">
                        {dev.ip}:{dev.port} · {dev.manufacturer} · Quelle:{' '}
                        {dev.source === 'ssdp' ? 'SSDP-Multicast' : 'UPnP-HTTP'}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                        dev.sameSubnet
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                      }`}
                    >
                      {dev.sameSubnet
                        ? `Selbes Subnetz (${dev.subnetCidr ?? 'LAN'})`
                        : 'Anderes Subnetz'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                {draftConfig.lastScanMessage ||
                  'Noch kein FRITZ!Box UPnP/DLNA-Gerät im aktuellen Netzwerk erkannt.'}
              </p>
            )}
          </div>

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
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>
                {isDirty
                  ? 'Ungespeicherte Änderungen an Fritzbox UPnP/DLNA-Discovery.'
                  : 'Discovery-Konfiguration auf dem NAS gespeichert.'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <button
                type="button"
                disabled={scanning || saving}
                onClick={() => void handleScanNow()}
                className="px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-emerald-400 ${scanning ? 'animate-spin' : ''}`}
                />
                <span>{scanning ? 'Suche FRITZ!Box...' : 'Netzwerk nach FRITZ!Box scannen'}</span>
              </button>

              <button
                type="button"
                disabled={saving || !isDirty}
                onClick={() => void handleSave()}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Speichere...' : 'Discovery speichern'}</span>
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
