import React, { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  Network,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { DeepNetworkDiagnosticsResult, NetworkPortProbeEntry } from '../types/marcente';

export type PortBlockadeState =
  | 'ready'
  | 'conflict'
  | 'firewall'
  | 'closed'
  | 'other_service'
  | 'untested';

export interface StandardPortComparisonRow {
  port: number;
  protocol: string;
  roleTitle: string;
  roleDescription: string;
  isTargetPort: boolean;
  isPrimaryEntenCenterPort: boolean;
  tested: boolean;
  tcpOpen: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  serverHeader: string | null;
  isEntenCenter: boolean;
  errorCode: string | null;
  blockadeState: PortBlockadeState;
  statusLabel: string;
  diagnosis: string;
}

interface StandardPortBlueprint {
  port: number;
  protocol: string;
  roleTitle: string;
  roleDescription: string;
}

export const ENTENCENTER_STANDARD_PORT_BLUEPRINTS: readonly StandardPortBlueprint[] = [
  {
    port: 3000,
    protocol: 'HTTP',
    roleTitle: 'EntenCenter Standard',
    roleDescription: 'Primärer NAS-App-Port',
  },
  {
    port: 3001,
    protocol: 'HTTP',
    roleTitle: 'EntenCenter Alternativ',
    roleDescription: 'Ausweichport bei Belegung von 3000',
  },
  {
    port: 8080,
    protocol: 'HTTP',
    roleTitle: 'HTTP-Alt / NAS-Proxy',
    roleDescription: 'Häufiger Docker-, QNAP- oder Proxy-Port',
  },
  {
    port: 80,
    protocol: 'HTTP',
    roleTitle: 'HTTP-Standard',
    roleDescription: 'Oft durch Router-/NAS-Web-UI belegt',
  },
  {
    port: 443,
    protocol: 'HTTPS',
    roleTitle: 'HTTPS / SSL-Proxy',
    roleDescription: 'Verschlüsselter Reverse-Proxy / DynDNS',
  },
  {
    port: 8443,
    protocol: 'HTTPS',
    roleTitle: 'HTTPS-Alternativ',
    roleDescription: 'Alternativer TLS-Port für Fernzugriff',
  },
];

function evaluatePortRow(
  port: number,
  protocol: string,
  roleTitle: string,
  roleDescription: string,
  isTargetPort: boolean,
  probe: NetworkPortProbeEntry | undefined,
  fritzBoxInfo?: DeepNetworkDiagnosticsResult['fritzBoxInfo'],
  storageBridgeActive?: boolean,
  backendPath?: string | null
): StandardPortComparisonRow {
  if (!probe) {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: false,
      tcpOpen: false,
      latencyMs: null,
      httpStatus: null,
      serverHeader: null,
      isEntenCenter: false,
      errorCode: null,
      blockadeState: 'untested',
      statusLabel: 'Nicht geprüft',
      diagnosis: 'Wurde in diesem Modus nicht abgefragt.',
    };
  }

  const httpStatus = typeof probe.httpStatus === 'number' ? probe.httpStatus : null;
  const serverHeader = probe.serverHeader?.trim() || null;
  const errorCode = probe.errorCode?.trim() || null;

  if (probe.isEntenCenter) {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: true,
      latencyMs: probe.latencyMs,
      httpStatus,
      serverHeader,
      isEntenCenter: true,
      errorCode: null,
      blockadeState: 'ready',
      statusLabel: 'EntenCenter aktiv',
      diagnosis: 'Keine Blockade — EntenCenter-Backend antwortet gültig.',
    };
  }

  if (fritzBoxInfo?.detected && (port === 80 || port === 443) && (probe.tcpOpen || httpStatus !== null)) {
    const authText = storageBridgeActive
      ? `Storage-Bridge aktiv (${backendPath || '/EntenCenter-Backend'}). HTTP 400 auf /api/nas/... ist bei FRITZ!OS WebUI normal.`
      : fritzBoxInfo.requiresAuth
        ? 'FRITZ!NAS verlangt Login (Zugangsdaten eingeben).'
        : 'FRITZ!Box /login_sid.lua erreichbar.';
    const httpsNote =
      port === 443 && !fritzBoxInfo.httpsAvailable && fritzBoxInfo.httpAvailable
        ? ' HTTPS liefert Zertifikats-/Protokollfehler — App weicht im LAN automatisch auf HTTP (:80) aus.'
        : '';
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: false,
      tested: true,
      tcpOpen: true,
      latencyMs: probe.latencyMs,
      httpStatus,
      serverHeader: serverHeader || 'FRITZ!Box / AVM WebUI',
      isEntenCenter: false,
      errorCode,
      blockadeState: storageBridgeActive ? 'ready' : 'other_service',
      statusLabel: storageBridgeActive
        ? `FRITZ!NAS (Bridge aktiv)`
        : port === 443 && !fritzBoxInfo.httpsAvailable
          ? 'FRITZ!NAS (HTTPS -> HTTP:80)'
          : `FRITZ!NAS Web (${port})`,
      diagnosis: `${authText}${httpsNote}`.trim(),
    };
  }

  if (storageBridgeActive && port === 3000 && !probe.isEntenCenter) {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: false,
      tested: true,
      tcpOpen: probe.tcpOpen,
      latencyMs: probe.latencyMs,
      httpStatus,
      serverHeader,
      isEntenCenter: false,
      errorCode,
      blockadeState: 'other_service',
      statusLabel: 'Optional (Bridge aktiv)',
      diagnosis:
        'Node-:3000-Server wird im Storage-Bridge-Modus nicht benötigt — Daten liegen direkt auf dem NAS.',
    };
  }

  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    const isProxyConflict = httpStatus === 400 || httpStatus === 404;
    const isAuthBlock = httpStatus === 401 || httpStatus === 403;
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: true,
      latencyMs: probe.latencyMs,
      httpStatus,
      serverHeader,
      isEntenCenter: false,
      errorCode,
      blockadeState: 'conflict',
      statusLabel: isAuthBlock
        ? `Zugriffssperre (${httpStatus})`
        : `Port-Konflikt (${httpStatus})`,
      diagnosis: isProxyConflict
        ? serverHeader
          ? `Fremddienst (${serverHeader}) / Reverse-Proxy blockt mit HTTP ${httpStatus}.`
          : `Fremder Web-/NAS-Dienst oder Proxy-Header-Filter liefert HTTP ${httpStatus}.`
        : isAuthBlock
          ? `Vorgeschaltete Auth-/Proxy-Regel verweigert Zugriff (HTTP ${httpStatus}).`
          : `HTTP ${httpStatus} — Endpunkt ist kein EntenCenter-NAS.`,
    };
  }

  if (httpStatus !== null) {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: true,
      latencyMs: probe.latencyMs,
      httpStatus,
      serverHeader,
      isEntenCenter: false,
      errorCode,
      blockadeState: 'other_service',
      statusLabel: `Fremddienst (HTTP ${httpStatus})`,
      diagnosis: serverHeader
        ? `Port belegt durch "${serverHeader}", kein EntenCenter-API-Endpunkt.`
        : 'Port antwortet per HTTP, aber ohne EntenCenter-Bootstrap.',
    };
  }

  if (probe.tcpOpen) {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: true,
      latencyMs: probe.latencyMs,
      httpStatus: null,
      serverHeader,
      isEntenCenter: false,
      errorCode: null,
      blockadeState: 'other_service',
      statusLabel: 'TCP offen (kein HTTP)',
      diagnosis:
        port === 443 || port === 8443
          ? 'TCP offen, aber TLS/Zertifikat-Fehler oder kein HTTPS-Backend.'
          : 'TCP-Port ist offen, liefert aber keine EntenCenter-HTTP-Antwort.',
    };
  }

  if (errorCode === 'ETIMEDOUT') {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: false,
      latencyMs: null,
      httpStatus: null,
      serverHeader: null,
      isEntenCenter: false,
      errorCode,
      blockadeState: 'firewall',
      statusLabel: 'Firewall (Timeout)',
      diagnosis:
        'Pakete werden verworfen (ETIMEDOUT) — Firewall oder Router-Portfreigabe blockiert.',
    };
  }

  if (errorCode === 'ECONNREFUSED') {
    return {
      port,
      protocol,
      roleTitle,
      roleDescription,
      isTargetPort,
      isPrimaryEntenCenterPort: port === 3000,
      tested: true,
      tcpOpen: false,
      latencyMs: null,
      httpStatus: null,
      serverHeader: null,
      isEntenCenter: false,
      errorCode,
      blockadeState: 'closed',
      statusLabel: 'Geschlossen',
      diagnosis:
        port === 3000
          ? 'Verbindung abgelehnt (ECONNREFUSED) — EntenCenter-Server nicht gestartet oder nur an 127.0.0.1 gebunden.'
          : 'Verbindung sofort abgelehnt (ECONNREFUSED) — auf diesem Port läuft kein Dienst.',
    };
  }

  return {
    port,
    protocol,
    roleTitle,
    roleDescription,
    isTargetPort,
    isPrimaryEntenCenterPort: port === 3000,
    tested: true,
    tcpOpen: false,
    latencyMs: null,
    httpStatus: null,
    serverHeader: null,
    isEntenCenter: false,
    errorCode,
    blockadeState: 'firewall',
    statusLabel: 'Blockiert',
    diagnosis: errorCode
      ? `Nicht erreichbar (${errorCode}) — Firewall, Mixed-Content oder Netzwerkpfad prüfen.`
      : 'Port im aktuellen Netzwerk nicht erreichbar.',
  };
}

export function buildStandardPortComparisonRows(
  result: DeepNetworkDiagnosticsResult,
  options?: { storageBridgeActive?: boolean; backendPath?: string | null }
): {
  standardRows: StandardPortComparisonRow[];
  storageRows: NetworkPortProbeEntry[];
} {
  const byPort = new Map<number, NetworkPortProbeEntry>();
  for (const entry of result.portMatrix) {
    byPort.set(entry.port, entry);
  }

  const standardPortsSet = new Set<number>(
    ENTENCENTER_STANDARD_PORT_BLUEPRINTS.map((b) => b.port)
  );
  const rows: StandardPortComparisonRow[] = [];

  if (!standardPortsSet.has(result.targetPort)) {
    const customProbe = byPort.get(result.targetPort);
    rows.push(
      evaluatePortRow(
        result.targetPort,
        result.scheme.toUpperCase(),
        'Konfigurierter Zielport',
        'Aktuell gewählter Ziel-Endpunkt',
        true,
        customProbe,
        result.fritzBoxInfo,
        options?.storageBridgeActive,
        options?.backendPath
      )
    );
  }

  for (const bp of ENTENCENTER_STANDARD_PORT_BLUEPRINTS) {
    rows.push(
      evaluatePortRow(
        bp.port,
        bp.protocol,
        bp.roleTitle,
        bp.roleDescription,
        bp.port === result.targetPort,
        byPort.get(bp.port),
        result.fritzBoxInfo,
        options?.storageBridgeActive,
        options?.backendPath
      )
    );
  }

  const storageRows = result.portMatrix.filter(
    (entry) => !standardPortsSet.has(entry.port) && entry.port !== result.targetPort
  );

  return { standardRows: rows, storageRows };
}

interface NetworkPortComparisonTableProps {
  result: DeepNetworkDiagnosticsResult;
  storageBridgeActive?: boolean;
  backendPath?: string | null;
}

export const NetworkPortComparisonTable: React.FC<NetworkPortComparisonTableProps> = ({
  result,
  storageBridgeActive = false,
  backendPath = null,
}) => {
  const { standardRows, storageRows } = useMemo(
    () => buildStandardPortComparisonRows(result, { storageBridgeActive, backendPath }),
    [result, storageBridgeActive, backendPath]
  );

  const openStandardCount = standardRows.filter((r) => r.tcpOpen).length;
  const blockedCount = standardRows.filter(
    (r) => r.blockadeState === 'firewall' || r.blockadeState === 'conflict'
  ).length;
  const activeEntenRow = standardRows.find((r) => r.isEntenCenter);

  return (
    <div className="p-2.5 rounded-lg bg-[#0B0E14] border border-slate-800 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
          <Network className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>EntenCenter-NAS-Standardports im Vergleich</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono tabular-nums">
          <span className="text-slate-300">
            {openStandardCount}/{standardRows.length} TCP offen
          </span>
          {storageBridgeActive && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">
              Storage-Bridge aktiv
            </span>
          )}
          {blockedCount > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/35 text-rose-300">
              {blockedCount} Blockade{blockedCount === 1 ? '' : 'n'}/Konflikt
            </span>
          )}
          {activeEntenRow && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">
              :{activeEntenRow.port} bereit
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800/90">
        <table className="w-full text-left border-collapse text-[11px]">
          <thead>
            <tr className="bg-[#121722] border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-400">
              <th className="py-1.5 px-2 font-medium">Port</th>
              <th className="py-1.5 px-2 font-medium">Rolle / Dienst</th>
              <th className="py-1.5 px-2 font-medium whitespace-nowrap">TCP / RTT</th>
              <th className="py-1.5 px-2 font-medium">HTTP-Antwort</th>
              <th className="py-1.5 px-2 font-medium">Blockade-Diagnose</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/75 bg-[#0E131C]">
            {standardRows.map((row) => {
              const rowHighlight =
                row.blockadeState === 'ready'
                  ? 'bg-emerald-500/[0.04]'
                  : row.blockadeState === 'conflict' || row.blockadeState === 'firewall'
                    ? 'bg-rose-500/[0.04]'
                    : '';

              return (
                <tr key={row.port} className={`${rowHighlight} align-top`}>
                  <td className="py-2 px-2 font-mono whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-white tabular-nums">:{row.port}</span>
                      <span className="text-[9px] text-slate-400">{row.protocol}</span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {row.isTargetPort && (
                        <span className="px-1 py-0.2 rounded bg-amber-400/15 border border-amber-400/40 text-[9px] font-sans text-amber-300">
                          Ziel
                        </span>
                      )}
                      {row.isPrimaryEntenCenterPort && !row.isTargetPort && (
                        <span className="px-1 py-0.2 rounded bg-slate-800 border border-slate-700 text-[9px] font-sans text-slate-300">
                          Standard
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="py-2 px-2 min-w-[115px]">
                    <div className="font-medium text-slate-200 leading-tight">{row.roleTitle}</div>
                    <div className="text-[10px] text-slate-400 leading-snug mt-0.5">
                      {row.roleDescription}
                    </div>
                  </td>

                  <td className="py-2 px-2 font-mono whitespace-nowrap tabular-nums">
                    {!row.tested ? (
                      <span className="text-slate-500">—</span>
                    ) : row.tcpOpen ? (
                      <div>
                        <span className="text-emerald-400 font-medium">Offen</span>
                        {row.latencyMs !== null && (
                          <div className="text-[10px] text-slate-400">{row.latencyMs} ms</div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <span
                          className={
                            row.blockadeState === 'firewall'
                              ? 'text-rose-400 font-medium'
                              : 'text-slate-400 font-medium'
                          }
                        >
                          {row.errorCode === 'ETIMEDOUT'
                            ? 'Timeout'
                            : row.errorCode === 'ECONNREFUSED'
                              ? 'Abgelehnt'
                              : 'Zu'}
                        </span>
                        {row.errorCode && (
                          <div className="text-[9px] text-slate-500">{row.errorCode}</div>
                        )}
                      </div>
                    )}
                  </td>

                  <td className="py-2 px-2 font-mono whitespace-nowrap">
                    {row.isEntenCenter ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                        <CheckCircle2 className="w-3 h-3 shrink-0" />
                        <span>HTTP {row.httpStatus ?? 200}</span>
                      </span>
                    ) : row.httpStatus !== null ? (
                      <div>
                        <span
                          className={
                            row.blockadeState === 'ready'
                              ? 'text-emerald-300 font-medium'
                              : row.httpStatus >= 400
                                ? 'text-rose-400 font-semibold'
                                : 'text-amber-300 font-medium'
                          }
                        >
                          HTTP {row.httpStatus}
                        </span>
                        {row.serverHeader && (
                          <div
                            className="text-[9px] text-slate-400 max-w-[95px] truncate"
                            title={row.serverHeader}
                          >
                            {row.serverHeader}
                          </div>
                        )}
                      </div>
                    ) : row.tcpOpen ? (
                      <span className="text-[10px] text-amber-300 font-sans">Kein HTTP/JSON</span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>

                  <td className="py-2 px-2 min-w-[160px]">
                    <div className="flex items-center gap-1 font-semibold leading-tight">
                      {row.blockadeState === 'ready' ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      ) : row.blockadeState === 'conflict' || row.blockadeState === 'firewall' ? (
                        <ShieldAlert className="w-3 h-3 text-rose-400 shrink-0" />
                      ) : row.blockadeState === 'other_service' ? (
                        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                      ) : row.blockadeState === 'closed' ? (
                        <XCircle className="w-3 h-3 text-slate-400 shrink-0" />
                      ) : (
                        <Lock className="w-3 h-3 text-slate-500 shrink-0" />
                      )}
                      <span
                        className={
                          row.blockadeState === 'ready'
                            ? 'text-emerald-300'
                            : row.blockadeState === 'conflict' || row.blockadeState === 'firewall'
                              ? 'text-rose-300'
                              : row.blockadeState === 'other_service'
                                ? 'text-amber-200'
                                : 'text-slate-300'
                        }
                      >
                        {row.statusLabel}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-snug mt-0.5">
                      {row.diagnosis}
                    </p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {storageRows.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
            Weitere erkannte NAS-Speicher- & Systemports
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {storageRows.map((pm) => (
              <div
                key={pm.port}
                className="px-2 py-1 rounded bg-[#121722] border border-slate-800/90 flex items-center justify-between gap-1 text-[10px] font-mono"
              >
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">
                    :{pm.port}{' '}
                    <span className="text-slate-400 font-sans">{pm.label}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {pm.tcpOpen ? (
                    <span className="text-emerald-400">
                      Offen{pm.latencyMs !== null ? ` (${pm.latencyMs}ms)` : ''}
                    </span>
                  ) : (
                    <span className="text-slate-500">
                      {pm.errorCode === 'ETIMEDOUT' ? 'Timeout' : 'Zu'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
