import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Lock,
  User,
  ArrowRight,
  ShieldCheck,
  HardDrive,
  UserPlus,
  LogIn,
  Globe,
  KeyRound,
  Eye,
  EyeOff,
  Server,
  RefreshCw,
  CheckCircle2,
  WifiOff,
  Wifi,
  Radar,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  HardDriveDownload,
  RotateCcw,
  FolderTree,
} from 'lucide-react';
import { MARCENTE_ASSETS } from '../data/coverAssets';
import {
  NasBackendProvisionDialog,
  type NasBackendProvisionTarget,
} from './NasBackendProvisionDialog';
import { UniversalNasManagerPanel } from './UniversalNasManagerPanel';
import {
  clearLocalOnboardingBuffer,
  createLocalOnboardingBuffer,
  hydrateLocalOnboardingBufferFromIndexedDb,
  isConfirmedStorageBridge,
  isLocalFallbackToken,
  readLocalOnboardingBuffer,
  testAndTransferLocalBufferToNas,
  toNasUserFromBuffer,
  writeLocalOnboardingBuffer,
} from '../lib/localBufferStore';
import {
  buildNasProbeCandidates,
  cleanHostOnly,
  DEFAULT_ALTERNATIVE_PORTS,
  diagnoseNativeServerConnection,
  discoverAndHydrateBackendFromNasBridge,
  discoverFritzboxNas,
  discoverLocalNasDevices,
  FritzboxNasDiscoveryResult,
  fritzBoxDirectLoginWithSession,
  getAndroidDefaultServerUrl,
  getAutoPortFallbackEnabled,
  getNasBaseUrl,
  getPreferredAlternativePort,
  hasSavedNasBaseUrl,
  isAiStudioPreviewUrl,
  isLocalOrLanHost,
  isMixedContentBlocked,
  isNativeAndroidShell,
  nasFetch,
  nativeAndroidFetch,
  type NativeServerDiagnosis,
  normalizeNasBaseUrl,
  readLocalBridgeCatalog,
  readLocalBridgePathSettings,
  readLocalBridgeScanSettings,
  readLocalProvisionedBackendForHost,
  resolveNasUrl,
  sanitizeNasPortForProtocol,
  saveLocalBridgePathSettings,
  saveLocalBridgeScanSettings,
  saveLocalProvisionedBackendFolder,
  scanAlternativeNasPorts,
  setAutoPortFallbackEnabled,
  setNasBaseUrl,
  setPreferredAlternativePort,
  syncEntenCenterDataToNasBridge,
  syncSharedNasCertificate,
  upsertLocalBridgeCatalogItems,
} from '../lib/nasClient';
import {
  ALL_NAS_PROTOCOLS,
  AlternativePortScanResult,
  AuthBootstrapResponse,
  DiscoveredNasDevice,
  DiscoveredNasService,
  FritzUpnpProbeResult,
  LocalOnboardingBuffer,
  NAS_PROTOCOL_CATALOG,
  NasProtocolId,
  NasProvisionBackendResult,
  NasRegistrationConnectionPayload,
  NasUser,
} from '../types/marcente';

interface LoginScreenProps {
  onAuthenticated: (token: string, user: NasUser) => void;
}

const INITIAL_NAS_FORM: NasRegistrationConnectionPayload = {
  protocol: 'smb',
  host: '',
  port: '',
  shareOrPath: '',
  username: '',
  secret: '',
  domainOrWorkgroup: '',
  nfsVersion: 'NFSv4.1',
  nfsAuthMode: 'AUTH_SYS',
  sftpAuthMode: 'password',
  ftpsTlsMode: 'explicit',
  apiVendor: 'Synology DSM',
  useTls: true,
};

export const LoginScreen: React.FC<LoginScreenProps> = ({ onAuthenticated }) => {
  const nativeShell = useMemo(() => isNativeAndroidShell(), []);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [bootstrap, setBootstrap] = useState<AuthBootstrapResponse | null>(null);

  const [useCustomHomeNas, setUseCustomHomeNas] = useState<boolean>(
    () => isNativeAndroidShell() || hasSavedNasBaseUrl()
  );
  const [connectionScope, setConnectionScope] = useState<'lan' | 'internet'>(() => {
    const saved = hasSavedNasBaseUrl() ? getNasBaseUrl() : '';
    if (saved && !isLocalOrLanHost(saved)) return 'internet';
    return 'lan';
  });
  const [homeNasInput, setHomeNasInput] = useState<string>(() => {
    const saved = hasSavedNasBaseUrl() ? getNasBaseUrl() : '';
    return isNativeAndroidShell() && isAiStudioPreviewUrl(saved) ? '' : saved;
  });
  const [nasStatus, setNasStatus] = useState<'idle' | 'checking' | 'online' | 'unreachable'>('idle');
  const [mixedContentDirectUrl, setMixedContentDirectUrl] = useState<string | null>(null);
  const [nativeDiagnosisText, setNativeDiagnosisText] = useState<string | null>(null);
  const [nativeDiagnosis, setNativeDiagnosis] = useState<NativeServerDiagnosis | null>(null);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const [showOptionalNasSetup, setShowOptionalNasSetup] = useState(false);
  const [nasConn, setNasConn] = useState<NasRegistrationConnectionPayload>(INITIAL_NAS_FORM);
  const [showNasSecret, setShowNasSecret] = useState(false);
  const [showExtraFritzPassWizard, setShowExtraFritzPassWizard] = useState(false);
  const [showExtraFritzFieldInWizard, setShowExtraFritzFieldInWizard] = useState(false);

  const [fritzUpnpHost, setFritzUpnpHost] = useState('fritz.box');
  const [fritzUsername, setFritzUsername] = useState('');
  const [fritzPassword, setFritzPassword] = useState('');
  const [showFritzPassword, setShowFritzPassword] = useState(false);
  const [fritzUseTls, setFritzUseTls] = useState(false);
  const [fritzChallengeTestMsg, setFritzChallengeTestMsg] = useState<string | null>(null);
  const [fritzLoading, setFritzLoading] = useState(false);
  const [discoveryProbe, setDiscoveryProbe] = useState<FritzUpnpProbeResult | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<FritzboxNasDiscoveryResult | null>(null);
  const [discoveryScanning, setDiscoveryScanning] = useState(false);
  const autoTokenlessAttemptedRef = React.useRef(false);
  const initialBootstrapRanRef = React.useRef(false);
  const autoOpenedProvisionHostsRef = React.useRef<Set<string>>(new Set());

  const [networkScanDevices, setNetworkScanDevices] = useState<DiscoveredNasDevice[]>([]);
  const [networkScanning, setNetworkScanning] = useState(false);
  const [networkScanSummary, setNetworkScanSummary] = useState<string | null>(null);
  const [networkScanExpanded, setNetworkScanExpanded] = useState(false);

  const [preferredAltPort, setPreferredAltPort] = useState<number>(() =>
    getPreferredAlternativePort()
  );
  const [autoPortFallback, setAutoPortFallback] = useState<boolean>(() =>
    getAutoPortFallbackEnabled()
  );
  const [portScanBusy, setPortScanBusy] = useState(false);
  const [portScanResult, setPortScanResult] = useState<AlternativePortScanResult | null>(null);

  const [provisionDialogOpen, setProvisionDialogOpen] = useState(false);
  const [provisionDialogTarget, setProvisionDialogTarget] =
    useState<NasBackendProvisionTarget | null>(null);
  const [lastProvisionResult, setLastProvisionResult] =
    useState<NasProvisionBackendResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Setup-Assistent (Wizard) & lokaler On-Device-Puffer
  const [localBuffer, setLocalBuffer] = useState<LocalOnboardingBuffer | null>(() =>
    readLocalOnboardingBuffer()
  );
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(() =>
    readLocalOnboardingBuffer() ? 2 : 1
  );
  const [wizardSyncing, setWizardSyncing] = useState(false);
  const [wizardStatusMsg, setWizardStatusMsg] = useState<string | null>(null);
  const [wizardAutoCheck, setWizardAutoCheck] = useState<boolean>(
    () => readLocalOnboardingBuffer()?.autoBackgroundCheck ?? true
  );

  useEffect(() => {
    if (localBuffer) return;
    let active = true;
    void hydrateLocalOnboardingBufferFromIndexedDb().then((recovered) => {
      if (!active || !recovered) return;
      setLocalBuffer(recovered);
      setWizardAutoCheck(recovered.autoBackgroundCheck);
      if (recovered.serverUrl) {
        setUseCustomHomeNas(true);
        setHomeNasInput(recovered.serverUrl);
        setConnectionScope(recovered.connectionScope);
      }
      if (recovered.nasConnection) {
        setNasConn(recovered.nasConnection);
        setShowOptionalNasSetup(true);
      }
    });
    return () => {
      active = false;
    };
  }, [localBuffer]);

  const runTokenlessFritzLogin = useCallback(
    async (
      explicitBaseUrl?: string,
      customHost?: string,
      discoveredSummary?: FritzboxNasDiscoveryResult | null
    ): Promise<boolean> => {
      const targetBase =
        explicitBaseUrl !== undefined
          ? normalizeNasBaseUrl(explicitBaseUrl)
          : useCustomHomeNas
            ? normalizeNasBaseUrl(homeNasInput)
            : '';
      if (nativeShell && !targetBase) {
        return false;
      }
      const endpoint = targetBase
        ? `${targetBase}/api/nas/auth/fritz-tokenless`
        : resolveNasUrl('/api/nas/auth/fritz-tokenless');

      const matchedDevice =
        discoveredSummary?.matchedProfileDevice ??
        discoveryResult?.matchedProfileDevice ??
        null;

      setFritzLoading(true);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: customHost?.trim() || matchedDevice?.ip || undefined,
            port: matchedDevice?.port || undefined,
            clientDiscoveredDevice: matchedDevice
              ? {
                  host: matchedDevice.host,
                  ip: matchedDevice.ip,
                  friendlyName: matchedDevice.friendlyName,
                }
              : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.probe) {
            setDiscoveryProbe(data.probe as FritzUpnpProbeResult);
          }
          if (explicitBaseUrl === undefined) {
            setError(
              data.error ||
                'Tokenlose FRITZ!Box UPnP/DLNA-Anmeldung im selben Subnetz nicht möglich.'
            );
          }
          return false;
        }
        setNasStatus('online');
        onAuthenticated(data.token, data.user);
        return true;
      } catch {
        return false;
      } finally {
        setFritzLoading(false);
      }
    },
    [discoveryResult?.matchedProfileDevice, homeNasInput, nativeShell, onAuthenticated, useCustomHomeNas]
  );

  const runFritzDiscoveryCheck = useCallback(
    async (
      explicitBaseUrl?: string,
      allowAutoLogin = true
    ): Promise<FritzUpnpProbeResult | null> => {
      const targetBase =
        explicitBaseUrl !== undefined
          ? normalizeNasBaseUrl(explicitBaseUrl)
          : useCustomHomeNas
            ? normalizeNasBaseUrl(homeNasInput)
            : '';

      setDiscoveryScanning(true);
      try {
        const result = await discoverFritzboxNas({
          nasBaseUrl: targetBase,
          candidateHosts: bootstrap?.fritzDiscovery?.probeHosts,
          upnpPort: bootstrap?.fritzDiscovery?.probePort,
        });
        setDiscoveryResult(result);
        const probe = result.probeResult;
        setDiscoveryProbe(probe);

        if (result.recommendedHost) {
          setFritzUpnpHost(result.recommendedHost);
        }

        let manualLogout = false;
        try {
          manualLogout = window.sessionStorage.getItem('entencenter_manual_logout') === '1';
        } catch {
          manualLogout = false;
        }
        if (
          allowAutoLogin &&
          !manualLogout &&
          !autoTokenlessAttemptedRef.current &&
          result.tokenlessReady &&
          probe?.autoTokenlessLogin
        ) {
          autoTokenlessAttemptedRef.current = true;
          await runTokenlessFritzLogin(targetBase, result.recommendedHost ?? undefined, result);
        }
        return probe;
      } catch {
        return null;
      } finally {
        setDiscoveryScanning(false);
      }
    },
    [
      bootstrap?.fritzDiscovery?.probeHosts,
      bootstrap?.fritzDiscovery?.probePort,
      homeNasInput,
      runTokenlessFritzLogin,
      useCustomHomeNas,
    ]
  );

  const probeSingleBootstrap = useCallback(
    async (baseTarget: string): Promise<{ ok: boolean; data?: AuthBootstrapResponse }> => {
      const endpoint = baseTarget
        ? `${baseTarget}/api/nas/auth/bootstrap`
        : resolveNasUrl('/api/nas/auth/bootstrap');
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 5500);
      try {
        const res = await nasFetch(
          endpoint,
          {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          },
          4500
        );
        if (res.ok) {
          const data = (await res.json()) as AuthBootstrapResponse;
          if (typeof data?.hasUsers === 'boolean') {
            return { ok: true, data };
          }
        }
      } catch {
        // Native Fallback unten prüfen
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (nativeShell && /^https?:\/\//i.test(endpoint)) {
        const nativeRes = await nativeAndroidFetch(
          endpoint,
          { method: 'GET', headers: { Accept: 'application/json' } },
          3500
        );
        if (nativeRes && nativeRes.ok) {
          const data = (await nativeRes.json().catch(() => null)) as AuthBootstrapResponse | null;
          if (data && typeof data.hasUsers === 'boolean') {
            return { ok: true, data };
          }
        }
      }
      return { ok: false };
    },
    [nativeShell]
  );

  const fetchBootstrap = useCallback(
    async (explicitBaseUrl?: string): Promise<string | null> => {
      setMixedContentDirectUrl(null);
      setNativeDiagnosisText(null);
      setNativeDiagnosis(null);
      const useExplicit = explicitBaseUrl !== undefined;
      const rawTarget = useExplicit
        ? explicitBaseUrl.trim()
        : useCustomHomeNas
          ? homeNasInput.trim()
          : '';

      if (nativeShell && !rawTarget) {
        const defaultUrl = getAndroidDefaultServerUrl();
        if (!defaultUrl) {
          setBootstrap(null);
          setNasStatus('idle');
          return null;
        }
      }

      const candidates = rawTarget
        ? buildNasProbeCandidates(rawTarget)
        : [nativeShell ? getAndroidDefaultServerUrl() : ''];

      const usableCandidates = candidates.filter((c) => !(nativeShell && !c));
      if (usableCandidates.length === 0 && nativeShell) {
        setBootstrap(null);
        setNasStatus('idle');
        return null;
      }

      setNasStatus('checking');
      const results = await Promise.all(
        usableCandidates.map(async (candidate) => ({
          candidate,
          ...(await probeSingleBootstrap(candidate)),
        }))
      );
      let winner = results.find((r) => r.ok && r.data);

      let diag: NativeServerDiagnosis | null = null;
      if (!winner && nativeShell && (rawTarget || candidates[0])) {
        diag = diagnoseNativeServerConnection(rawTarget || candidates[0]);
        if (diag?.ok && diag.matchedBaseUrl) {
          const matchedProbe = await probeSingleBootstrap(diag.matchedBaseUrl);
          if (matchedProbe.ok && matchedProbe.data) {
            winner = { candidate: diag.matchedBaseUrl, ...matchedProbe };
          }
        }
      }

      if (winner && winner.data) {
        if (rawTarget && winner.candidate) {
          setHomeNasInput(winner.candidate);
          setNasBaseUrl(winner.candidate);
          setConnectionScope(isLocalOrLanHost(winner.candidate) ? 'lan' : 'internet');
        }
        setBootstrap(winner.data);
        setNasStatus('online');
        syncSharedNasCertificate(winner.data.securityCertificate ?? null, winner.candidate);
        if (!winner.data.hasUsers) {
          setMode('register');
        }
        if (winner.data.fritzDiscovery?.enabled) {
          void runFritzDiscoveryCheck(winner.candidate, true);
        } else {
          setDiscoveryProbe(null);
        }
        return winner.candidate;
      }

      const mixedCandidate = candidates.find((c) => isMixedContentBlocked(c)) ?? null;
      setMixedContentDirectUrl(mixedCandidate);
      if (diag) {
        setNativeDiagnosis(diag);
        if (diag.detail) {
          setNativeDiagnosisText(diag.detail);
        }
        if (diag.detectedPureNas || diag.detectedFritzBox) {
          const diagHost = diag.resolvedIp || diag.host || rawTarget;
          const primarySvc =
            diag.openNasServices?.find((s) => s.protocol === 'fritz_upnp') ??
            diag.openNasServices?.[0];
          const detectedProtocol: NasProtocolId =
            diag.detectedFritzBox ? 'fritz_upnp' : primarySvc?.protocol ?? 'smb';
          const detectedPort =
            primarySvc?.port || (diag.detectedFritzBox ? '80' : '445');
          const detectedPath =
            primarySvc?.path || (diag.detectedFritzBox ? '/FRITZ' : '/Medien');
          const detectedTls =
            primarySvc?.scheme === 'https' && !diag.fritzBoxInfo?.httpAvailable;

          if (diag.detectedFritzBox && diagHost) {
            setFritzUpnpHost(diagHost);
          }

          setNasConn((prev) => ({
            ...prev,
            protocol: detectedProtocol,
            host: diagHost || prev.host,
            port: detectedPort || prev.port,
            shareOrPath: prev.backendPath || detectedPath,
            useTls: detectedTls,
            storageBridgeMode: true,
          }));
          setShowOptionalNasSetup(true);
          // Verbindung bleibt im Storage-Bridge-Modus aktiv — kein Abbruch!
          setNasStatus('online');
          setBootstrap(null);
          setError(null);

          const hostKey = (diagHost || '').toLowerCase();
          const alreadyProvisioned = Boolean(
            readLocalProvisionedBackendForHost(diagHost) ||
              localBuffer?.nasConnection?.backendProvisioned ||
              localBuffer?.syncedBackendPath
          );
          if (hostKey && !alreadyProvisioned && !autoOpenedProvisionHostsRef.current.has(hostKey)) {
            autoOpenedProvisionHostsRef.current.add(hostKey);
            setProvisionDialogTarget({
              host: diagHost,
              port: detectedPort,
              protocol: detectedProtocol,
              shareOrPath: detectedPath,
              username: diag.detectedFritzBox ? fritzUsername : nasConn.username,
              secret: diag.detectedFritzBox ? fritzPassword : nasConn.secret,
              fritzPassword: fritzPassword || nasConn.fritzPassword || undefined,
              useTls: detectedTls,
              friendlyName: diag.fritzBoxInfo?.friendlyName || undefined,
              requiresAuth: Boolean(diag.fritzBoxInfo?.requiresAuth),
              ownerUsername: username.trim() || localBuffer?.user.username || 'admin',
            });
            setProvisionDialogOpen(true);
          }
          return null;
        }
      }
      setBootstrap(null);
      setNasStatus('unreachable');
      return null;
    },
    [
      fritzPassword,
      fritzUsername,
      homeNasInput,
      localBuffer?.nasConnection?.backendProvisioned,
      localBuffer?.syncedBackendPath,
      localBuffer?.user.username,
      nasConn.secret,
      nasConn.username,
      nativeShell,
      probeSingleBootstrap,
      runFritzDiscoveryCheck,
      useCustomHomeNas,
      username,
    ]
  );

  useEffect(() => {
    if (initialBootstrapRanRef.current) return;
    initialBootstrapRanRef.current = true;

    const initialTarget = getNasBaseUrl();
    if (!nativeShell || initialTarget) {
      void fetchBootstrap(initialTarget);
      return;
    }

    // In der Android-APK ohne gespeicherte Server-Adresse automatisch per mDNS / WLAN suchen
    setNetworkScanning(true);
    setNetworkScanExpanded(true);
    void discoverLocalNasDevices({ baseUrl: '', includeSubnetProbe: true })
      .then((res) => {
        setNetworkScanDevices(res.devices);
        setNetworkScanSummary(res.summary);
        const firstServer = res.devices.find((d) => d.isEntenCenterServer && d.baseUrl);
        if (firstServer?.baseUrl) {
          setUseCustomHomeNas(true);
          setHomeNasInput(firstServer.baseUrl);
          setNasBaseUrl(firstServer.baseUrl);
          void fetchBootstrap(firstServer.baseUrl);
        }
      })
      .catch(() => {
        setNetworkScanSummary(
          'Automatische WLAN-Suche abgeschlossen. Verbinde dich per Heimnetz-Adresse oder über das Internet.'
        );
      })
      .finally(() => {
        setNetworkScanning(false);
      });
  }, [fetchBootstrap, nativeShell]);

  const applyHomeNasTarget = useCallback((): string => {
    if (!useCustomHomeNas || !homeNasInput.trim()) {
      setNasBaseUrl('');
      return nativeShell ? getAndroidDefaultServerUrl() : '';
    }
    const normalized = normalizeNasBaseUrl(homeNasInput);
    if (!normalized) {
      setNasBaseUrl('');
      return nativeShell ? getAndroidDefaultServerUrl() : '';
    }
    setHomeNasInput(normalized);
    setNasBaseUrl(normalized);
    return normalized;
  }, [homeNasInput, nativeShell, useCustomHomeNas]);

  const formatUnreachableError = useCallback(
    (target: string): string => {
      if (target && isMixedContentBlocked(target)) {
        return `Dein Browser blockiert direkte http://-Verbindungen (wie ${target}) von einer HTTPS-Seite aus (Mixed-Content-Schutz). Öffne die Adresse direkt unten im neuen Tab oder verwende die Android-APK.`;
      }
      if (!target && nativeShell) {
        return 'Noch kein NAS-Server ausgewählt. Nutze "Im Netzwerk suchen (mDNS)" für dein lokales WLAN oder gib unter "Über das Internet (Fernzugriff)" deine NAS-Adresse (z. B. DynDNS / MyFRITZ / Port) ein.';
      }
      if (/^:?\d{1,5}$/.test(homeNasInput.trim()) && nativeShell) {
        return 'Bitte gib zusammen mit dem Port noch die IP-Adresse oder Domain deines Servers ein (z. B. 192.168.178.50:3000 oder mein-nas.dyndns.org:3000).';
      }
      const shownTarget = target || (typeof window !== 'undefined' ? window.location.origin : '');
      if (nativeShell) {
        const diag = shownTarget ? diagnoseNativeServerConnection(homeNasInput.trim() || shownTarget) : null;
        if (diag) {
          setNativeDiagnosis(diag);
        }
        if (diag?.detail) {
          return `${diag.detail} (Geprüft: ${shownTarget})`;
        }
      }
      if (nativeShell && !isLocalOrLanHost(shownTarget)) {
        return `Externer NAS-Server unter "${shownTarget}" nicht erreichbar. Prüfe Internetverbindung, DynDNS/Domain, Port-Freigabe im Router (z. B. Port 3000 / 443) oder HTTPS-Zertifikat.`;
      }
      return `Server unter "${shownTarget}" nicht erreichbar. Prüfe Adresse, WLAN-Verbindung sowie Firewall/Port-Freigabe (z. B. Port 3000).`;
    },
    [homeNasInput, nativeShell]
  );

  const handleTestHomeNas = async () => {
    setError(null);
    if (useCustomHomeNas && homeNasInput.trim()) {
      const normalized = normalizeNasBaseUrl(homeNasInput);
      if (!normalized) {
        setError(formatUnreachableError(homeNasInput.trim()));
        return;
      }
      const reachable = await fetchBootstrap(homeNasInput);
      if (reachable === null) {
        const latestDiag = nativeShell
          ? diagnoseNativeServerConnection(homeNasInput.trim() || normalized)
          : nativeDiagnosis;
        if (latestDiag?.detectedPureNas || latestDiag?.detectedFritzBox) {
          setNativeDiagnosis(latestDiag);
          if (latestDiag.detail) setNativeDiagnosisText(latestDiag.detail);
          setNasStatus('online');
          return;
        }
        setError(formatUnreachableError(normalized));
      }
      return;
    }

    if (nativeShell) {
      await runNetworkNasScan();
      return;
    }

    const activeTarget = applyHomeNasTarget();
    const reachable = await fetchBootstrap('');
    if (reachable === null) {
      setError(formatUnreachableError(activeTarget));
    }
  };

  const mapVendorToApiVendor = (
    vendor: DiscoveredNasDevice['vendor']
  ): NonNullable<NasRegistrationConnectionPayload['apiVendor']> => {
    switch (vendor) {
      case 'Synology':
        return 'Synology DSM';
      case 'QNAP':
        return 'QNAP QTS';
      case 'TrueNAS':
        return 'TrueNAS Scale';
      case 'Unraid':
        return 'Unraid';
      case 'OpenMediaVault':
        return 'OpenMediaVault';
      default:
        return 'Synology DSM';
    }
  };

  const openProvisionDialogForNas = useCallback(
    (overrides?: Partial<NasBackendProvisionTarget>) => {
      const host =
        overrides?.host?.trim() ||
        nativeDiagnosis?.resolvedIp ||
        nativeDiagnosis?.host ||
        nasConn.host.trim() ||
        fritzUpnpHost.trim() ||
        homeNasInput.trim() ||
        'fritz.box';
      const protocol: NasProtocolId =
        overrides?.protocol ??
        (nativeDiagnosis?.detectedFritzBox
          ? 'fritz_upnp'
          : nasConn.protocol || 'fritz_upnp');
      setProvisionDialogTarget({
        host,
        port: overrides?.port || nasConn.port || (protocol === 'fritz_upnp' ? '80' : '445'),
        protocol,
        shareOrPath: overrides?.shareOrPath || nasConn.backendPath || nasConn.shareOrPath || '/',
        username: overrides?.username ?? (protocol === 'fritz_upnp' ? fritzUsername || nasConn.username : nasConn.username),
        secret: overrides?.secret ?? (protocol === 'fritz_upnp' ? fritzPassword || nasConn.secret : nasConn.secret),
        fritzPassword: overrides?.fritzPassword ?? (fritzPassword || nasConn.fritzPassword || undefined),
        useTls: overrides?.useTls ?? (protocol === 'fritz_upnp' ? fritzUseTls : Boolean(nasConn.useTls)),
        friendlyName: overrides?.friendlyName || nativeDiagnosis?.fritzBoxInfo?.friendlyName,
        requiresAuth: overrides?.requiresAuth ?? Boolean(nativeDiagnosis?.fritzBoxInfo?.requiresAuth),
        ownerUsername: username.trim() || localBuffer?.user.username || 'admin',
      });
      setProvisionDialogOpen(true);
    },
    [
      fritzPassword,
      fritzUpnpHost,
      fritzUseTls,
      fritzUsername,
      homeNasInput,
      localBuffer?.user.username,
      nasConn.backendPath,
      nasConn.fritzPassword,
      nasConn.host,
      nasConn.port,
      nasConn.protocol,
      nasConn.secret,
      nasConn.shareOrPath,
      nasConn.useTls,
      nasConn.username,
      nativeDiagnosis,
      username,
    ]
  );

  const handleBackendProvisioned = useCallback(
    async (
      result: NasProvisionBackendResult,
      updatedCredentials: {
        username: string;
        secret: string;
        useTls: boolean;
        fritzPassword?: string;
      }
    ) => {
      setLastProvisionResult(result);
      setNasStatus('online');
      setError(null);
      const effectivePort = String(
        sanitizeNasPortForProtocol(
          result.protocol,
          nasConn.port || (result.protocol === 'fritz_upnp' ? (updatedCredentials.useTls ? '443' : '80') : '445'),
          updatedCredentials.useTls
        )
      );
      const nextConn: NasRegistrationConnectionPayload = {
        ...nasConn,
        protocol: result.protocol,
        host: result.host,
        port: effectivePort,
        shareOrPath: result.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : result.backendPath,
        username: updatedCredentials.username || nasConn.username,
        secret: updatedCredentials.secret || nasConn.secret,
        fritzUsername: updatedCredentials.username || nasConn.username,
        fritzPassword:
          updatedCredentials.fritzPassword ??
          (result.protocol === 'fritz_upnp' ? updatedCredentials.secret : nasConn.fritzPassword),
        useTls: result.protocol === 'smb' ? false : updatedCredentials.useTls,
        backendPath: result.backendPath,
        backendProvisioned: true,
        storageBridgeMode: true,
      };
      setNasConn(nextConn);
      setShowOptionalNasSetup(true);
      saveLocalProvisionedBackendFolder(result.host, result.protocol, result.backendPath);

      if (result.protocol === 'fritz_upnp') {
        setFritzUpnpHost(result.host);
        if (updatedCredentials.username) setFritzUsername(updatedCredentials.username);
        if (updatedCredentials.secret) setFritzPassword(updatedCredentials.secret);
        setFritzUseTls(updatedCredentials.useTls);
      } else if (updatedCredentials.fritzPassword) {
        setFritzPassword(updatedCredentials.fritzPassword);
      }

      const existingBuf = localBuffer ?? readLocalOnboardingBuffer();
      const baseBuf: LocalOnboardingBuffer = existingBuf
        ? {
            ...existingBuf,
            serverUrl:
              existingBuf.serverUrl ||
              (useCustomHomeNas ? normalizeNasBaseUrl(homeNasInput) || result.host : result.host),
            nasConnection: nextConn,
            updatedAt: new Date().toISOString(),
          }
        : createLocalOnboardingBuffer({
            username: username.trim() || 'admin',
            displayName: displayName.trim() || username.trim() || 'admin',
            password: password.length >= 4 ? password : updatedCredentials.secret || 'entencenter-bridge',
            serverUrl: normalizeNasBaseUrl(homeNasInput) || `http://${result.host}`,
            connectionScope,
            nasConnection: nextConn,
            autoBackgroundCheck: wizardAutoCheck,
          });

      const bridgePass =
        updatedCredentials.fritzPassword ||
        updatedCredentials.secret ||
        nextConn.fritzPassword ||
        nextConn.secret ||
        '';
      let verifiedSync = Boolean(result.remoteWriteOk);
      let finalBackendPath = result.backendPath;
      let syncWarning: string | null = null;

      if (bridgePass) {
        const bridgeTarget = {
          protocol: result.protocol,
          host: result.host,
          port: effectivePort,
          shareOrPath: result.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : result.backendPath,
          username: (updatedCredentials.username || nextConn.username || '').trim(),
          password: bridgePass,
          secret: bridgePass,
          fritzPassword: bridgePass,
          domainOrWorkgroup: nextConn.domainOrWorkgroup,
          useTls: nextConn.useTls,
          backendPath: result.backendPath,
        };
        const discovered = await discoverAndHydrateBackendFromNasBridge({
          target: bridgeTarget,
          username: baseBuf.user.username,
          preferredBackendPath: result.backendPath,
        }).catch(() => null);
        if (discovered?.found) {
          finalBackendPath = discovered.backendPath;
          if (discovered.catalog?.length) {
            upsertLocalBridgeCatalogItems(discovered.catalog);
          }
          if (discovered.scanFolderSettings) {
            saveLocalBridgeScanSettings(discovered.scanFolderSettings);
          }
          if (discovered.pathSettings) {
            saveLocalBridgePathSettings(discovered.pathSettings);
          }
        }
        const syncRes = await syncEntenCenterDataToNasBridge({
          target: bridgeTarget,
          backendPath: finalBackendPath,
          username: baseBuf.user.username,
          displayName: baseBuf.user.displayName,
          role: baseBuf.user.role,
          fskLimit: baseBuf.user.fskLimit,
          connectionScope,
          catalog: readLocalBridgeCatalog(),
          scanFolderSettings: readLocalBridgeScanSettings(),
          pathSettings: readLocalBridgePathSettings(),
        }).catch(() => null);
        if (syncRes?.ok && syncRes.verified) {
          verifiedSync = true;
          finalBackendPath = syncRes.backendPath || finalBackendPath;
        } else if (syncRes && !syncRes.ok) {
          syncWarning = syncRes.error || null;
        }
      }

      const canAutoFinish = Boolean(
        verifiedSync && result.host && bridgePass && baseBuf.user.username.trim()
      );
      const nowIso = new Date().toISOString();
      const finalBuf: LocalOnboardingBuffer = {
        ...baseBuf,
        mode: verifiedSync ? 'storage_bridge_active' : 'pending_nas_sync',
        setupCompleted: canAutoFinish ? true : baseBuf.setupCompleted,
        setupCompletedAt: canAutoFinish ? (baseBuf.setupCompletedAt || nowIso) : baseBuf.setupCompletedAt,
        autoBackgroundCheck: canAutoFinish ? false : baseBuf.autoBackgroundCheck,
        nasConnection: {
          ...nextConn,
          backendPath: finalBackendPath,
          backendProvisioned: true,
          storageBridgeMode: true,
        },
        nasSyncedAt: verifiedSync ? baseBuf.nasSyncedAt || nowIso : baseBuf.nasSyncedAt ?? null,
        syncedBackendPath: verifiedSync ? finalBackendPath : baseBuf.syncedBackendPath ?? null,
        lastTestError: verifiedSync ? null : syncWarning,
        lastTestedAt: nowIso,
        updatedAt: nowIso,
      };
      writeLocalOnboardingBuffer(finalBuf);
      setLocalBuffer(finalBuf);

      if (verifiedSync) {
        setWizardStatusMsg(
          `EntenCenter-Backend unter ${finalBackendPath} auf ${result.host} verifiziert & Registrierung abgeschlossen.`
        );
        setProvisionDialogOpen(false);
        onAuthenticated(finalBuf.localToken, toNasUserFromBuffer(finalBuf));
      } else {
        setWizardStatusMsg(result.message);
      }
    },
    [
      connectionScope,
      displayName,
      homeNasInput,
      localBuffer,
      nasConn,
      onAuthenticated,
      password,
      useCustomHomeNas,
      username,
      wizardAutoCheck,
    ]
  );

  const runNetworkNasScan = useCallback(async () => {
    setNetworkScanning(true);
    setNetworkScanExpanded(true);
    setError(null);
    try {
      const targetBase = useCustomHomeNas ? homeNasInput : '';
      const result = await discoverLocalNasDevices({
        baseUrl: targetBase,
        includeSubnetProbe: true,
      });
      setNetworkScanDevices(result.devices);
      setNetworkScanSummary(result.summary);
    } catch {
      setNetworkScanSummary('Netzwerk-Suche konnte nicht ausgeführt werden.');
    } finally {
      setNetworkScanning(false);
    }
  }, [homeNasInput, useCustomHomeNas]);

  const handleRunPortScan = useCallback(
    async (targetOverride?: string) => {
      const candidateTarget = (
        targetOverride ??
        (useCustomHomeNas ? homeNasInput.trim() : '') ??
        localBuffer?.serverUrl ??
        nativeDiagnosis?.resolvedIp ??
        nativeDiagnosis?.host ??
        ''
      ).trim();
      setPortScanBusy(true);
      setError(null);
      try {
        const res = await scanAlternativeNasPorts(
          candidateTarget || (nativeShell ? '192.168.178.1' : window.location.origin),
          { preferredAltPort: preferredAltPort }
        );
        setPortScanResult(res);
        if (res.recommendedBaseUrl && res.recommendedPort && res.recommendedPort !== 3000) {
          setPreferredAltPort(res.recommendedPort);
          setPreferredAlternativePort(res.recommendedPort);
        }
      } catch {
        setError('Automatischer Port-Scan konnte nicht ausgeführt werden.');
      } finally {
        setPortScanBusy(false);
      }
    },
    [
      homeNasInput,
      localBuffer?.serverUrl,
      nativeDiagnosis?.host,
      nativeDiagnosis?.resolvedIp,
      nativeShell,
      preferredAltPort,
      useCustomHomeNas,
    ]
  );

  const handleAdoptPortUrl = useCallback(
    async (url: string, portNum?: number) => {
      const normalized = normalizeNasBaseUrl(url) || url;
      setError(null);
      setUseCustomHomeNas(true);
      setHomeNasInput(normalized);
      setNasBaseUrl(normalized);
      setConnectionScope(isLocalOrLanHost(normalized) ? 'lan' : 'internet');
      if (portNum && portNum !== 3000) {
        setPreferredAltPort(portNum);
        setPreferredAlternativePort(portNum);
      }
      if (localBuffer) {
        const updated: LocalOnboardingBuffer = {
          ...localBuffer,
          serverUrl: normalized,
          connectionScope: isLocalOrLanHost(normalized) ? 'lan' : 'internet',
          updatedAt: new Date().toISOString(),
        };
        writeLocalOnboardingBuffer(updated);
        setLocalBuffer(updated);
      }
      await fetchBootstrap(normalized);
    },
    [fetchBootstrap, localBuffer]
  );

  const handleSelectDiscoveredServer = async (device: DiscoveredNasDevice) => {
    const entenSvc = device.services.find((s) => s.protocol === 'entencenter');
    const targetUrl =
      device.baseUrl || `http://${device.ip}:${entenSvc?.port || device.port || '3000'}`;
    setError(null);
    setUseCustomHomeNas(true);
    setHomeNasInput(targetUrl);
    setNasBaseUrl(targetUrl);
    if (isMixedContentBlocked(targetUrl)) {
      setMixedContentDirectUrl(targetUrl);
      setNasStatus('unreachable');
      setError(formatUnreachableError(targetUrl));
      return;
    }
    const reachable = await fetchBootstrap(targetUrl);
    if (reachable === null && !nativeDiagnosis?.detectedPureNas && !nativeDiagnosis?.detectedFritzBox) {
      setError(formatUnreachableError(targetUrl));
    }
  };

  const handleSelectDiscoveredNasStorage = (
    device: DiscoveredNasDevice,
    chosenService?: DiscoveredNasService
  ) => {
    const fallbackService =
      chosenService ??
      device.services.find((s) => s.protocol !== 'entencenter') ??
      device.services[0];
    const nextProtocol: NasProtocolId =
      fallbackService && fallbackService.protocol !== 'entencenter'
        ? fallbackService.protocol
        : device.suggestedProtocol;
    const protoMeta = NAS_PROTOCOL_CATALOG.find((p) => p.id === nextProtocol);
    const chosenHost = device.ip || device.hostname;
    const chosenPort = fallbackService?.port || protoMeta?.defaultPort || device.port || '';
    const chosenPath = fallbackService?.path || device.suggestedShareOrPath || protoMeta?.defaultPath || '/Medien';
    const nextTls = fallbackService?.scheme ? fallbackService.scheme === 'https' : false;

    setError(null);
    setNasStatus('online');
    setMode('register');
    setShowOptionalNasSetup(true);
    setNasConn((prev) => ({
      ...prev,
      protocol: nextProtocol,
      host: chosenHost,
      port: chosenPort,
      shareOrPath: chosenPath,
      useTls: nextTls,
      apiVendor: mapVendorToApiVendor(device.vendor),
      storageBridgeMode: true,
    }));

    if (!device.isEntenCenterServer) {
      openProvisionDialogForNas({
        host: chosenHost,
        port: chosenPort,
        protocol: nextProtocol,
        shareOrPath: chosenPath,
        useTls: nextTls,
        friendlyName: device.name,
        requiresAuth: device.vendor === 'FRITZ!Box',
      });
    }
  };

  const isFirstUser = Boolean(
    bootstrap && (bootstrap.isFirstUserRegistration || !bootstrap.hasUsers)
  );

  const availableProtocols = useMemo(() => {
    if (!bootstrap) {
      return NAS_PROTOCOL_CATALOG;
    }
    if (isFirstUser) {
      return NAS_PROTOCOL_CATALOG;
    }
    const allowedSet = new Set<NasProtocolId>(
      Array.isArray(bootstrap.allowedNasProtocols) && bootstrap.allowedNasProtocols.length > 0
        ? bootstrap.allowedNasProtocols
        : ALL_NAS_PROTOCOLS
    );
    const filtered = NAS_PROTOCOL_CATALOG.filter((p) => allowedSet.has(p.id));
    return filtered.length > 0 ? filtered : NAS_PROTOCOL_CATALOG;
  }, [bootstrap, isFirstUser]);

  useEffect(() => {
    if (availableProtocols.length === 0) return;
    const isCurrentAvailable = availableProtocols.some((p) => p.id === nasConn.protocol);
    if (!isCurrentAvailable) {
      const nextProto = availableProtocols[0];
      setNasConn((prev) => ({
        ...prev,
        protocol: nextProto.id,
        port: nextProto.defaultPort,
        shareOrPath: nextProto.defaultPath,
      }));
    }
  }, [availableProtocols, nasConn.protocol]);

  const fritzUpnpAvailable = useMemo(() => {
    if (!bootstrap) return true;
    if (isFirstUser) return true;
    return (
      bootstrap.fritzUpnpEnabled ??
      availableProtocols.some((p) => p.id === 'fritz_upnp')
    );
  }, [availableProtocols, bootstrap, isFirstUser]);

  const handleSelectNasProtocol = (nextProtocol: NasProtocolId) => {
    const prevMeta = NAS_PROTOCOL_CATALOG.find((p) => p.id === nasConn.protocol);
    const nextMeta = NAS_PROTOCOL_CATALOG.find((p) => p.id === nextProtocol);
    if (!nextMeta) return;
    setError(null);
    setNasConn((prev) => {
      const nextHost =
        nextProtocol === 'fritz_upnp'
          ? prev.host.trim() || 'fritz.box'
          : prev.protocol === 'fritz_upnp' && prev.host.trim() === 'fritz.box'
            ? ''
            : prev.host;
      return {
        ...prev,
        protocol: nextProtocol,
        host: nextHost,
        port:
          nextProtocol === 'fritz_upnp' || !prev.port || (prevMeta && prev.port === prevMeta.defaultPort)
            ? nextMeta.defaultPort
            : prev.port,
        shareOrPath:
          nextProtocol === 'fritz_upnp' ||
          !prev.shareOrPath ||
          (prevMeta && prev.shareOrPath === prevMeta.defaultPath)
            ? nextMeta.defaultPath
            : prev.shareOrPath,
        useTls: nextProtocol === 'fritz_upnp' ? false : prev.useTls,
      };
    });
  };

  const handleTestFritzChallengeLogin = async (customHost?: string) => {
    setError(null);
    setFritzChallengeTestMsg(null);
    const effectiveHost =
      (customHost ?? (fritzUpnpHost.trim() || homeNasInput.trim() || 'fritz.box'))
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0] || 'fritz.box';
    setFritzLoading(true);
    try {
      const targetNas = bootstrap ? applyHomeNasTarget() : '';
      const directRes = await fritzBoxDirectLoginWithSession({
        host: effectiveHost,
        port: fritzUseTls ? 443 : 80,
        useTls: fritzUseTls,
        username: fritzUsername.trim(),
        password: fritzPassword,
        allowLocalSelfSignedTls: true,
        forceRefresh: true,
        serverBaseUrl: targetNas || undefined,
        verifyBrowseTree: true,
      });
      if (directRes.ok) {
        const entryCount = directRes.browseTree?.entries?.length ?? 0;
        setFritzUseTls(directRes.effectiveScheme === 'https');
        setFritzChallengeTestMsg(
          `FRITZ!Box Login erfolgreich (SID ${directRes.sidPreview || 'aktiv'} · ${
            directRes.httpsFallbackToHttp
              ? 'HTTPS fehlgeschlagen -> automatischer LAN-HTTP-Fallback (:80)'
              : `${(directRes.effectiveScheme || 'http').toUpperCase()}:${directRes.effectivePort || 80}`
          }${entryCount > 0 ? ` · ${entryCount} NAS-Ordner gefunden` : ''}).`
        );
        return;
      }
      if (directRes.requiresAuth && !fritzPassword) {
        setError(
          `Deine FRITZ!Box (${effectiveHost}) erfordert eine Anmeldung vor dem NAS-Zugriff. Bitte gib dein „Passwort für die FRITZ!Box“ (und ggf. Benutzername) ein.`
        );
        return;
      }
      setError(
        directRes.error ||
          'FRITZ!Box Anmeldung fehlgeschlagen. Bitte überprüfe FRITZ!Box-Benutzername und Passwort.'
      );
    } catch {
      setError('FRITZ!Box Challenge-Response Test konnte nicht durchgeführt werden.');
    } finally {
      setFritzLoading(false);
    }
  };

  const handleFritzUpnpAccess = async (customHost?: string) => {
    const effectiveHost =
      (customHost ?? (fritzUpnpHost.trim() || homeNasInput.trim() || 'fritz.box'))
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0] || 'fritz.box';
    setFritzUpnpHost(effectiveHost);
    const targetNas = bootstrap ? applyHomeNasTarget() : '';
    setError(null);
    setFritzChallengeTestMsg(null);
    setFritzLoading(true);
    try {
      // 1. Falls ein laufendes EntenCenter-:3000-Backend bestätigt ist, dort direkt anmelden
      if (bootstrap && (targetNas || !nativeShell)) {
        const endpoint = targetNas
          ? `${targetNas}/api/nas/auth/fritz-upnp`
          : '/api/nas/auth/fritz-upnp';
        try {
          const res = await nasFetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              host: effectiveHost,
              port: fritzUseTls ? '443' : '49000',
              shareOrPath: '/MediaServer',
              username: fritzUsername.trim(),
              password: fritzPassword,
              useTls: fritzUseTls,
            }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            token?: string;
            user?: NasUser;
            error?: string;
          };
          if (res.ok && data.token && data.user) {
            setNasStatus('online');
            onAuthenticated(data.token, data.user);
            return;
          }
          if (res.status === 401) {
            setError(
              data.error ||
                'FRITZ!Box-Zugangsdaten abgelehnt. Bitte überprüfe Benutzername und „Passwort für die FRITZ!Box“.'
            );
            return;
          }
        } catch {
          // Falls EntenCenter-API doch nicht erreichbar -> direkter FRITZ!Box Login unten
        }
      }

      // 2. Direkter FRITZ!Box Challenge-Response Login & FRITZ!NAS Storage-Bridge (ohne :3000-Abbruch!)
      const directRes = await fritzBoxDirectLoginWithSession({
        host: effectiveHost,
        port: fritzUseTls ? 443 : 80,
        useTls: fritzUseTls,
        username: fritzUsername.trim(),
        password: fritzPassword,
        allowLocalSelfSignedTls: true,
        forceRefresh: true,
        verifyBrowseTree: true,
      });

      if (!directRes.ok) {
        if (directRes.requiresAuth && !fritzPassword) {
          setError(
            `Die FRITZ!Box (${effectiveHost}) verlangt vor dem FRITZ!NAS-Zugriff Zugangsdaten. Bitte fülle das Feld „Passwort für die FRITZ!Box“ aus.`
          );
        } else {
          setError(
            directRes.error ||
              `Anmeldung an FRITZ!Box (${effectiveHost}) fehlgeschlagen. Prüfe WLAN-Verbindung und FRITZ!Box-Passwort.`
          );
        }
        return;
      }

      const effectiveScheme = directRes.effectiveScheme === 'https' ? 'https' : 'http';
      const effectivePort = String(directRes.effectivePort || (effectiveScheme === 'https' ? 443 : 80));
      let backendPath =
        readLocalProvisionedBackendForHost(effectiveHost)?.backendPath ||
        localBuffer?.syncedBackendPath ||
        '/EntenCenter-Backend';

      const existingBuf = localBuffer ?? readLocalOnboardingBuffer();
      const targetUser = username.trim() || existingBuf?.user.username || 'fritz-nas';
      const targetDisplay = displayName.trim() || existingBuf?.user.displayName || 'FRITZ!NAS';
      const targetAccountPass =
        existingBuf?.user.password ||
        (password.length >= 4 ? password : fritzPassword.length >= 4 ? fritzPassword : 'fritz-bridge');

      const discoveryTarget = {
        protocol: 'fritz_upnp' as const,
        host: effectiveHost,
        port: effectivePort,
        shareOrPath: 'FRITZ.NAS',
        username: fritzUsername.trim(),
        password: fritzPassword,
        secret: fritzPassword,
        fritzPassword: fritzPassword || undefined,
        useTls: effectiveScheme === 'https',
        backendPath,
      };
      const discovered = await discoverAndHydrateBackendFromNasBridge({
        target: discoveryTarget,
        username: targetUser,
        preferredBackendPath: backendPath,
      }).catch(() => null);
      if (discovered?.found) {
        backendPath = discovered.backendPath;
        if (discovered.catalog?.length) {
          upsertLocalBridgeCatalogItems(discovered.catalog);
        }
        if (discovered.scanFolderSettings) {
          saveLocalBridgeScanSettings(discovered.scanFolderSettings);
        }
        if (discovered.pathSettings) {
          saveLocalBridgePathSettings(discovered.pathSettings);
        }
      }

      const syncRes = await syncEntenCenterDataToNasBridge({
        target: { ...discoveryTarget, backendPath },
        backendPath,
        username: targetUser,
        displayName: targetDisplay,
        role: 'admin',
        fskLimit: existingBuf?.user.fskLimit ?? 18,
        connectionScope: 'lan',
        catalog: readLocalBridgeCatalog(),
        scanFolderSettings: readLocalBridgeScanSettings(),
        pathSettings: readLocalBridgePathSettings(),
      }).catch(() => null);
      if (syncRes?.backendPath) {
        backendPath = syncRes.backendPath;
      }
      const isBridgeSyncedNow = Boolean(
        (syncRes && syncRes.ok && syncRes.verified) ||
          (discovered?.found && (discovered.hasProfile || discovered.hasManifest || discovered.hasConfig))
      );

      saveLocalProvisionedBackendFolder(effectiveHost, 'fritz_upnp', backendPath);

      const bridgeConn: NasRegistrationConnectionPayload = {
        protocol: 'fritz_upnp',
        host: effectiveHost,
        port: effectivePort,
        shareOrPath: 'FRITZ.NAS',
        username: fritzUsername.trim(),
        secret: fritzPassword,
        fritzUsername: fritzUsername.trim(),
        fritzPassword: fritzPassword || undefined,
        useTls: effectiveScheme === 'https',
        backendPath,
        backendProvisioned: true,
        storageBridgeMode: true,
        fritzSidVerifiedAt: new Date().toISOString(),
      };

      const canAutoCompleteFritz = Boolean(isBridgeSyncedNow && effectiveHost && fritzPassword);
      const nowIso = new Date().toISOString();
      const activeBuf: LocalOnboardingBuffer = existingBuf
        ? {
            ...existingBuf,
            mode: isBridgeSyncedNow ? 'storage_bridge_active' : 'pending_nas_sync',
            setupCompleted: canAutoCompleteFritz ? true : existingBuf.setupCompleted,
            setupCompletedAt: canAutoCompleteFritz
              ? (existingBuf.setupCompletedAt || nowIso)
              : existingBuf.setupCompletedAt,
            autoBackgroundCheck: canAutoCompleteFritz ? false : existingBuf.autoBackgroundCheck,
            serverUrl: normalizeNasBaseUrl(homeNasInput) || `${effectiveScheme}://${effectiveHost}`,
            connectionScope: 'lan',
            nasConnection: bridgeConn,
            nasSyncedAt: isBridgeSyncedNow ? existingBuf.nasSyncedAt || nowIso : existingBuf.nasSyncedAt ?? null,
            syncedBackendPath: isBridgeSyncedNow ? backendPath : existingBuf.syncedBackendPath ?? null,
            lastTestError: null,
            lastTestedAt: nowIso,
            updatedAt: nowIso,
          }
        : {
            ...createLocalOnboardingBuffer({
              username: targetUser,
              displayName: targetDisplay,
              password: targetAccountPass,
              serverUrl: normalizeNasBaseUrl(homeNasInput) || `${effectiveScheme}://${effectiveHost}`,
              connectionScope: 'lan',
              nasConnection: bridgeConn,
              autoBackgroundCheck: !canAutoCompleteFritz && wizardAutoCheck,
            }),
            mode: isBridgeSyncedNow ? 'storage_bridge_active' : 'pending_nas_sync',
            setupCompleted: canAutoCompleteFritz,
            setupCompletedAt: canAutoCompleteFritz ? nowIso : null,
            nasSyncedAt: isBridgeSyncedNow ? nowIso : null,
            syncedBackendPath: isBridgeSyncedNow ? backendPath : null,
          };
      writeLocalOnboardingBuffer(activeBuf);
      setLocalBuffer(activeBuf);
      setNasStatus('online');
      setFritzChallengeTestMsg(
        `FRITZ!NAS Storage-Bridge verbunden (${backendPath} · ${effectiveScheme.toUpperCase()}:${effectivePort}).`
      );
      onAuthenticated(activeBuf.localToken, toNasUserFromBuffer(activeBuf));
    } catch {
      setNasStatus('unreachable');
      setError(
        `Verbindung zur FRITZ!Box (${effectiveHost}) fehlgeschlagen. Prüfe WLAN-Zugehörigkeit und Zugangsdaten.`
      );
    } finally {
      setFritzLoading(false);
    }
  };

  const resolveSubmissionTarget = async (): Promise<string | null> => {
    if (!useCustomHomeNas || !homeNasInput.trim()) {
      const base = applyHomeNasTarget();
      if (nativeShell && !base) {
        return null;
      }
      return base;
    }
    const normalized = normalizeNasBaseUrl(homeNasInput);
    if (!normalized) {
      return null;
    }
    if (nasStatus === 'online') {
      return applyHomeNasTarget();
    }
    const reachable = await fetchBootstrap(homeNasInput);
    if (reachable !== null) {
      return reachable;
    }
    return applyHomeNasTarget();
  };

  const tryStorageBridgeLoginFallback = useCallback(
    async (rawUser: string, rawPass: string): Promise<boolean> => {
      const cleanUser = rawUser.trim().toLowerCase();
      const existingBuf = localBuffer ?? readLocalOnboardingBuffer();
      if (existingBuf) {
        const bufUser = existingBuf.user.username.trim().toLowerCase();
        const matchesUser = bufUser === cleanUser;
        const matchesPass = !existingBuf.user.password || existingBuf.user.password === rawPass;
        if (matchesUser && matchesPass) {
          const updatedBuf: LocalOnboardingBuffer = {
            ...existingBuf,
            mode: isConfirmedStorageBridge(existingBuf) ? 'storage_bridge_active' : existingBuf.mode,
            updatedAt: new Date().toISOString(),
          };
          writeLocalOnboardingBuffer(updatedBuf);
          setLocalBuffer(updatedBuf);
          setNasStatus('online');
          onAuthenticated(updatedBuf.localToken, toNasUserFromBuffer(updatedBuf));
          return true;
        }
      }
      const bridgeHost =
        cleanHostOnly(nasConn.host) ||
        cleanHostOnly(fritzUpnpHost) ||
        cleanHostOnly(homeNasInput) ||
        cleanHostOnly(existingBuf?.nasConnection?.host);
      const bridgePass =
        fritzPassword || nasConn.fritzPassword || nasConn.secret || existingBuf?.nasConnection?.secret || '';
      if (bridgeHost && bridgePass) {
        const discovered = await discoverAndHydrateBackendFromNasBridge({
          target: {
            protocol: nasConn.protocol || 'fritz_upnp',
            host: bridgeHost,
            port: String(sanitizeNasPortForProtocol(nasConn.protocol || 'fritz_upnp', nasConn.port || '80', Boolean(nasConn.useTls))),
            shareOrPath: (nasConn.protocol || 'fritz_upnp') === 'fritz_upnp' ? 'FRITZ.NAS' : nasConn.shareOrPath || '/',
            username: (fritzUsername || nasConn.username || '').trim(),
            password: bridgePass,
            secret: bridgePass,
            fritzPassword: bridgePass,
            useTls: Boolean(nasConn.useTls),
          },
          username: cleanUser,
          preferredBackendPath: existingBuf?.syncedBackendPath || nasConn.backendPath || '/EntenCenter-Backend',
        }).catch(() => null);
        if (discovered?.found && discovered.hasProfile) {
          if (discovered.catalog?.length) upsertLocalBridgeCatalogItems(discovered.catalog);
          const nowIso = new Date().toISOString();
          const newBuf: LocalOnboardingBuffer = {
            ...(existingBuf ??
              createLocalOnboardingBuffer({
                username: cleanUser,
                displayName: cleanUser,
                password: rawPass,
                serverUrl: homeNasInput.trim() || `http://${bridgeHost}`,
                connectionScope,
                nasConnection: {
                  protocol: nasConn.protocol || 'fritz_upnp',
                  host: bridgeHost,
                  port: nasConn.port || '80',
                  shareOrPath: 'FRITZ.NAS',
                  username: (fritzUsername || nasConn.username || '').trim(),
                  secret: bridgePass,
                  fritzPassword: bridgePass,
                  useTls: Boolean(nasConn.useTls),
                  backendPath: discovered.backendPath,
                  backendProvisioned: true,
                  storageBridgeMode: true,
                },
              })),
            mode: 'storage_bridge_active',
            setupCompleted: true,
            setupCompletedAt: nowIso,
            autoBackgroundCheck: false,
            nasSyncedAt: nowIso,
            syncedBackendPath: discovered.backendPath,
          };
          writeLocalOnboardingBuffer(newBuf);
          setLocalBuffer(newBuf);
          setNasStatus('online');
          onAuthenticated(newBuf.localToken, toNasUserFromBuffer(newBuf));
          return true;
        }
      }
      return false;
    },
    [
      connectionScope,
      fritzPassword,
      fritzUpnpHost,
      fritzUsername,
      homeNasInput,
      localBuffer,
      nasConn,
      onAuthenticated,
    ]
  );

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setError(null);
    setLoading(true);
    let targetNas = '';
    try {
      const resolved = await resolveSubmissionTarget();
      if (resolved === null || (nativeShell && !resolved)) {
        if (await tryStorageBridgeLoginFallback(username, password)) {
          return;
        }
        setNasStatus(homeNasInput.trim() ? 'unreachable' : 'idle');
        setError(formatUnreachableError(homeNasInput.trim()));
        return;
      }
      targetNas = resolved;
      const loginEndpoint = targetNas ? `${targetNas}/api/nas/login` : '/api/nas/login';
      const res = await nasFetch(loginEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const rawText = await res.text().catch(() => '');
      let data: { error?: string; token?: string; user?: NasUser } | null = null;
      try {
        data = rawText ? (JSON.parse(rawText) as { error?: string; token?: string; user?: NasUser }) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        if ((res.status === 400 || res.status === 404) && (await tryStorageBridgeLoginFallback(username, password))) {
          return;
        }
        if (res.status === 400) {
          setError(
            data?.error ||
              'HTTP 400: Der Endpunkt lehnt die Anfrage ab (kein EntenCenter-:3000-Server). Nutze oben die universelle NAS-Anmeldung oder FRITZ!Box-Bridge.'
          );
        } else if (res.status === 404) {
          setError(
            data?.error ||
              'HTTP 404: EntenCenter-Backend-Endpunkt (/api/nas/login) auf diesem Ziel nicht vorhanden. Nutze oben die universelle NAS-Anmeldung.'
          );
        } else {
          setError(data?.error || `Anmeldung am NAS fehlgeschlagen (HTTP ${res.status}).`);
        }
        return;
      }
      if (!data?.token || !data?.user) {
        setError('Unerwartete Server-Antwort beim Login. Bitte nutze die universelle NAS-Anmeldung.');
        return;
      }
      setNasStatus('online');
      onAuthenticated(data.token, data.user);
    } catch {
      if (await tryStorageBridgeLoginFallback(username, password)) {
        return;
      }
      setNasStatus('unreachable');
      setError(formatUnreachableError(targetNas));
    } finally {
      setLoading(false);
    }
  };

  const buildCleanedNasConnPayload = useCallback((): NasRegistrationConnectionPayload | null => {
    const isFritzUpnp = nasConn.protocol === 'fritz_upnp';
    const trimmedHost =
      nasConn.host.trim() || (showOptionalNasSetup && isFritzUpnp ? 'fritz.box' : '');
    const trimmedNasUser = nasConn.username.trim();
    const hasNasSecret = Boolean(nasConn.secret && nasConn.secret.length > 0);
    const hasAnyNasDetails =
      showOptionalNasSetup && Boolean(trimmedHost || trimmedNasUser || hasNasSecret);
    if (!hasAnyNasDetails || !trimmedHost) {
      return null;
    }
    return {
      ...nasConn,
      host: trimmedHost,
      port: nasConn.port.trim() || (isFritzUpnp ? '49000' : ''),
      shareOrPath: nasConn.shareOrPath.trim() || (isFritzUpnp ? '/MediaServer' : '/'),
      username: trimmedNasUser,
      secret: nasConn.secret ?? '',
    };
  }, [nasConn, showOptionalNasSetup]);

  const handleWizardStep1Submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setWizardStatusMsg(null);
    const cleanUser = username.trim();
    if (!cleanUser) {
      setError('Bitte gib einen Benutzernamen ein.');
      return;
    }
    if (password.length < 4) {
      setError('Das Passwort muss mindestens 4 Zeichen lang sein.');
      return;
    }
    const created = createLocalOnboardingBuffer({
      username: cleanUser,
      displayName: displayName.trim() || cleanUser,
      password,
      serverUrl: useCustomHomeNas ? homeNasInput.trim() : '',
      connectionScope,
      nasConnection: buildCleanedNasConnPayload(),
      autoBackgroundCheck: wizardAutoCheck,
    });
    setLocalBuffer(created);
    setWizardStep(2);
  };

  const persistWizardStep2ToBuffer = useCallback(
    (overrideMode?: LocalOnboardingBuffer['mode']): LocalOnboardingBuffer | null => {
      const base = localBuffer;
      if (!base) return null;
      const effectiveServerUrl = useCustomHomeNas
        ? normalizeNasBaseUrl(homeNasInput) || homeNasInput.trim()
        : '';
      const cleanedConn = buildCleanedNasConnPayload();
      const updated: LocalOnboardingBuffer = {
        ...base,
        mode: overrideMode ?? (effectiveServerUrl || cleanedConn ? 'pending_nas_sync' : 'local_fallback'),
        serverUrl: effectiveServerUrl,
        connectionScope,
        nasConnection: cleanedConn,
        autoBackgroundCheck: wizardAutoCheck,
        updatedAt: new Date().toISOString(),
      };
      writeLocalOnboardingBuffer(updated);
      setLocalBuffer(updated);
      return updated;
    },
    [buildCleanedNasConnPayload, connectionScope, homeNasInput, localBuffer, useCustomHomeNas, wizardAutoCheck]
  );

  const handleWizardStep2Next = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setWizardStatusMsg(null);
    const trimmedHost = nasConn.host.trim();
    const trimmedNasUser = nasConn.username.trim();
    const hasNasSecret = Boolean(nasConn.secret && nasConn.secret.length > 0);
    if (showOptionalNasSetup && (trimmedNasUser || hasNasSecret) && !trimmedHost) {
      setError(
        'Bitte gib für die eingetragenen NAS-Zugangsdaten noch Hostname/IP an — oder klappe die NAS-Freigabe aus.'
      );
      return;
    }
    persistWizardStep2ToBuffer('pending_nas_sync');
    setWizardStep(3);
  };

  const handleWizardEnterFallbackMode = (targetBuffer?: LocalOnboardingBuffer | null) => {
    setError(null);
    const updated =
      targetBuffer ??
      persistWizardStep2ToBuffer('local_fallback') ??
      localBuffer;
    if (!updated) return;
    const isBridgeSynced =
      isConfirmedStorageBridge(updated) ||
      Boolean(updated.nasConnection?.backendProvisioned && updated.nasSyncedAt);
    const nextBuf: LocalOnboardingBuffer = {
      ...updated,
      mode: isBridgeSynced ? 'storage_bridge_active' : 'local_fallback',
      setupCompleted: isBridgeSynced ? true : updated.setupCompleted,
      setupCompletedAt: isBridgeSynced
        ? (updated.setupCompletedAt || new Date().toISOString())
        : updated.setupCompletedAt,
      autoBackgroundCheck: isBridgeSynced ? false : wizardAutoCheck,
      updatedAt: new Date().toISOString(),
    };
    writeLocalOnboardingBuffer(nextBuf);
    setLocalBuffer(nextBuf);
    onAuthenticated(nextBuf.localToken, toNasUserFromBuffer(nextBuf));
  };

  const handleWizardResetBuffer = async () => {
    await clearLocalOnboardingBuffer();
    setLocalBuffer(null);
    setWizardStep(1);
    setWizardStatusMsg(null);
    setError(null);
  };

  const handleAdoptDetectedPureNas = useCallback(
    (
      diag: NativeServerDiagnosis,
      chosenService?: NonNullable<NativeServerDiagnosis['openNasServices']>[number]
    ) => {
      const service = chosenService ?? diag.openNasServices?.[0];
      if (!service) return;
      const host = diag.resolvedIp || diag.host || homeNasInput.trim();
      const nextConn: NasRegistrationConnectionPayload = {
        ...nasConn,
        protocol: service.protocol,
        host,
        port: service.port || nasConn.port,
        shareOrPath: service.path || nasConn.shareOrPath || '/Medien',
        useTls: service.scheme ? service.scheme === 'https' : nasConn.useTls,
      };
      setNasConn(nextConn);
      setShowOptionalNasSetup(true);
      setMode('register');
      if (localBuffer) {
        const updated: LocalOnboardingBuffer = {
          ...localBuffer,
          nasConnection: nextConn,
          updatedAt: new Date().toISOString(),
        };
        writeLocalOnboardingBuffer(updated);
        setLocalBuffer(updated);
        setWizardStep(2);
      }
      setError(null);
      setWizardStatusMsg(
        `NAS-Freigabe (${service.label} auf ${host}:${service.port}) übernommen. Prüfe ggf. Zugangsdaten oder suche nach einem EntenCenter-Backend (:3000).`
      );
    },
    [homeNasInput, localBuffer, nasConn]
  );

  const handleWizardTestAndTransfer = useCallback(
    async (silent = false) => {
      const current = localBuffer ?? readLocalOnboardingBuffer();
      if (!current) return;
      if (!silent) {
        setError(null);
        setNativeDiagnosis(null);
        setWizardStatusMsg('Prüfe NAS-Erreichbarkeit und übertrage Daten direkt aufs NAS…');
      }
      setWizardSyncing(true);
      try {
        const result = await testAndTransferLocalBufferToNas({
          buffer: current,
          overrideServerUrl: useCustomHomeNas ? homeNasInput.trim() : current.serverUrl,
          overrideNasConnection: buildCleanedNasConnPayload() ?? current.nasConnection,
          overrideFritzCreds:
            fritzPassword || nasConn.fritzPassword || nasConn.secret
              ? {
                  username: fritzUsername.trim() || nasConn.username.trim() || undefined,
                  password: fritzPassword || nasConn.fritzPassword || nasConn.secret || undefined,
                }
              : undefined,
        });
        if (result.ok && result.token && result.user) {
          const isFallback = isLocalFallbackToken(result.token);
          if (!isFallback) {
            setNasStatus('online');
            setLocalBuffer(null);
            setNativeDiagnosis(null);
            setWizardStatusMsg(
              'NAS erfolgreich verbunden! Daten übertragen & lokaler Puffer automatisch gelöscht.'
            );
            onAuthenticated(result.token, result.user);
            return;
          }
          const refreshed = readLocalOnboardingBuffer();
          if (refreshed) {
            setLocalBuffer(refreshed);
          }
          if (result.remoteWriteVerified) {
            setNasStatus('online');
            setNativeDiagnosis(null);
            setError(null);
            setProvisionDialogOpen(false);
            setWizardStatusMsg(
              `Registrierung abgeschlossen! Daten unter ${
                result.syncedBackendPath || refreshed?.syncedBackendPath || '/EntenCenter-Backend'
              } auf dem NAS verifiziert.`
            );
            onAuthenticated(result.token, result.user);
            return;
          }
          if (!silent) {
            setNasStatus('online');
            setWizardStatusMsg(null);
            setError(
              result.remoteWriteWarning ||
                'NAS erreichbar, aber Schreibzugriff wurde noch nicht verifiziert. Öffne die NAS-Dateistruktur, um den Backend-Ordner und die Zugangsdaten zu prüfen.'
            );
            openProvisionDialogForNas({
              host: current.nasConnection?.host || cleanHostOnly(homeNasInput) || 'fritz.box',
              protocol: current.nasConnection?.protocol ?? 'fritz_upnp',
              friendlyName: nativeDiagnosis?.fritzBoxInfo?.friendlyName,
              requiresAuth: Boolean(nativeDiagnosis?.fritzBoxInfo?.requiresAuth),
            });
          }
          return;
        }
        if (result.mixedContentUrl) {
          setMixedContentDirectUrl(result.mixedContentUrl);
        }
        if (result.diagnosis) {
          setNativeDiagnosis(result.diagnosis);
          if (result.diagnosis.detail) {
            setNativeDiagnosisText(result.diagnosis.detail);
          }
        }
        const refreshed = readLocalOnboardingBuffer();
        if (refreshed) {
          setLocalBuffer(refreshed);
        }
        if (!silent) {
          if (result.diagnosis?.detectedPureNas || result.diagnosis?.detectedFritzBox) {
            // Kein Verbindungsabbruch! Direkter Übergang zur NAS-Dateistruktur & Backend-Anlage
            setNasStatus('online');
            setError(null);
            setWizardStatusMsg(
              'NAS erkannt (ohne laufendes :3000 Backend). Verbindung bleibt aktiv — lege jetzt den EntenCenter-Backend-Pfad an.'
            );
            openProvisionDialogForNas({
              host: result.diagnosis.resolvedIp || result.diagnosis.host || current.nasConnection?.host || '',
              protocol: result.diagnosis.detectedFritzBox ? 'fritz_upnp' : current.nasConnection?.protocol ?? 'smb',
              friendlyName: result.diagnosis.fritzBoxInfo?.friendlyName,
              requiresAuth: Boolean(result.diagnosis.fritzBoxInfo?.requiresAuth),
            });
          } else {
            setNasStatus('unreachable');
            setWizardStatusMsg(null);
            setError(
              result.error ||
                'NAS derzeit noch nicht erreichbar. Du kannst jederzeit lokal starten und das NAS später verbinden.'
            );
          }
        }
      } finally {
        setWizardSyncing(false);
      }
    },
    [
      buildCleanedNasConnPayload,
      fritzPassword,
      fritzUsername,
      homeNasInput,
      localBuffer,
      nasConn.fritzPassword,
      nasConn.secret,
      nasConn.username,
      nativeDiagnosis?.fritzBoxInfo?.friendlyName,
      nativeDiagnosis?.fritzBoxInfo?.requiresAuth,
      onAuthenticated,
      openProvisionDialogForNas,
      useCustomHomeNas,
    ]
  );

  // Automatisierter Background-Check auf Schritt 3 des Setup-Assistenten
  useEffect(() => {
    if (mode !== 'register' || wizardStep !== 3 || !wizardAutoCheck || !localBuffer) {
      return;
    }
    const targetUrl = (useCustomHomeNas ? homeNasInput.trim() : localBuffer.serverUrl).trim();
    if (nativeShell && !targetUrl) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !wizardSyncing) {
        void handleWizardTestAndTransfer(true);
      }
    }, 8000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    handleWizardTestAndTransfer,
    homeNasInput,
    localBuffer,
    mode,
    nativeShell,
    useCustomHomeNas,
    wizardAutoCheck,
    wizardStep,
    wizardSyncing,
  ]);

  const switchMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode);
    setError(null);
    setWizardStatusMsg(null);
    if (nextMode === 'register') {
      const existingBuf = localBuffer ?? readLocalOnboardingBuffer();
      if (existingBuf && wizardStep === 1) {
        setWizardStep(2);
      }
      if (!bootstrap && !(nativeShell && !homeNasInput.trim())) {
        void fetchBootstrap();
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 flex items-center justify-center px-4 sm:px-6 pt-[max(1rem,calc(1rem+var(--app-top-clearance,0px)))] pb-[max(1rem,calc(1rem+var(--app-safe-bottom,0px)+var(--app-bottom-clearance,0px)))]">
      <div
        className={`w-full ${
          mode === 'register' ? 'max-w-5xl' : 'max-w-4xl'
        } grid grid-cols-1 lg:grid-cols-12 border border-slate-800/80 bg-[#121722] rounded-2xl overflow-hidden shadow-2xl transition-all`}
      >
        {/* Linke Brand- & Architektur-Seite */}
        <div
          className={`${
            mode === 'register' ? 'lg:col-span-4' : 'lg:col-span-5'
          } bg-[#0F141E] p-7 sm:p-8 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-800/80`}
        >
          <div>
            <div className="flex items-center gap-4 mb-6">
              <img
                src={MARCENTE_ASSETS.duckMascot}
                alt="EntenCenter Gummi-Ente Maskottchen"
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-xl object-cover border border-slate-700/70 shrink-0"
              />
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight text-white">
                  EntenCenter
                </h1>
                <p className="text-xs text-slate-400 mt-0.5">
                  Android TV · Tablet · Smartphone
                </p>
              </div>
            </div>

            <h2 className="font-display text-xl font-semibold text-slate-100 leading-snug mb-3 text-balance">
              Lokales Heim-NAS direkt in der App anmelden
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Alle Watch-States, Benutzerkonten, Altersfreigaben und Statistiken liegen direkt und
              geschützt auf deinem lokalen Heim-NAS — die Anmeldung erfolgt erst hier in der App.
            </p>
          </div>

          <div className="mt-8 space-y-3 pt-6 border-t border-slate-800/80">
            <div className="flex items-start gap-3">
              <HardDrive className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-slate-300 leading-relaxed">
                <span className="font-medium text-white">Privatsphäre &amp; Rollen:</span> Die erste
                angemeldete Person ist automatisch Administrator. Andere Nutzer sehen keine
                fremden Profile.
              </div>
            </div>
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-slate-300 leading-relaxed">
                <span className="font-medium text-white">Lokaler Tresor &amp; Ledger:</span>{' '}
                Zentrale FSK-Steuerung &amp; Write-Ahead-Log auf{' '}
                <code className="font-mono text-amber-300">/mnt/nas/.entencenter/</code>
              </div>
            </div>
          </div>
        </div>

        {/* Rechte Seite: Lokales Heim-NAS + Direkte Anmeldung / Registrierung */}
        <div
          className={`${
            mode === 'register' ? 'lg:col-span-8' : 'lg:col-span-7'
          } p-6 sm:p-8 lg:p-10 flex flex-col justify-center space-y-5`}
        >
          {/* Server-Verbindung (bei Erstanmeldung ohne IP/Port-Vorgabe direkt nutzbar) */}
          <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-xs font-semibold text-white">App- &amp; NAS-Verbindung</span>
              </div>
              <div className="flex items-center gap-2">
                {nasStatus === 'online' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Server verbunden
                  </span>
                ) : nasStatus === 'checking' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Prüfe Verbindung…
                  </span>
                ) : nasStatus === 'unreachable' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                    <WifiOff className="w-3 h-3" />
                    Verbindung prüfen
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400">
                    Bereit zur Anmeldung
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {!nativeShell && (
                <button
                  type="button"
                  onClick={() => {
                    setUseCustomHomeNas(false);
                    setHomeNasInput('');
                    setNasBaseUrl('');
                    setMixedContentDirectUrl(null);
                    setNativeDiagnosisText(null);
                    setError(null);
                    void fetchBootstrap('');
                  }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    !useCustomHomeNas
                      ? 'bg-amber-400/15 text-amber-300 border border-amber-400/50'
                      : 'bg-[#121722] text-slate-400 border border-slate-800 hover:text-slate-200'
                  }`}
                >
                  Standard-Server (Ohne Vorgabe)
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setUseCustomHomeNas(true);
                  setConnectionScope('lan');
                  setError(null);
                }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  useCustomHomeNas && connectionScope === 'lan'
                    ? 'bg-amber-400/15 text-amber-300 border border-amber-400/50'
                    : 'bg-[#121722] text-slate-400 border border-slate-800 hover:text-slate-200'
                }`}
              >
                Lokal (Heimnetz / WLAN)
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseCustomHomeNas(true);
                  setConnectionScope('internet');
                  setError(null);
                }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  useCustomHomeNas && connectionScope === 'internet'
                    ? 'bg-amber-400/15 text-amber-300 border border-amber-400/50'
                    : 'bg-[#121722] text-slate-400 border border-slate-800 hover:text-slate-200'
                }`}
              >
                Über das Internet (Fernzugriff)
              </button>
              <button
                type="button"
                onClick={() => void runNetworkNasScan()}
                disabled={networkScanning}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Radar className={`w-3.5 h-3.5 ${networkScanning ? 'animate-spin' : ''}`} />
                <span>
                  {networkScanning ? 'Scanne mDNS / Heimnetz...' : 'Im Netzwerk suchen (mDNS)'}
                </span>
              </button>
            </div>

            {networkScanExpanded && (
              <div className="rounded-lg bg-[#121722] border border-slate-800 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Radar
                      className={`w-3.5 h-3.5 text-emerald-400 ${networkScanning ? 'animate-spin' : ''}`}
                    />
                    <span className="text-[11px] font-semibold text-white">
                      Automatische NAS-Erkennung (mDNS / Bonjour &amp; SSDP)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setNetworkScanExpanded(false)}
                    className="text-[11px] text-slate-400 hover:text-white"
                  >
                    Schließen
                  </button>
                </div>

                {networkScanning ? (
                  <p className="text-[11px] text-slate-400">
                    Durchsuche lokales Netzwerk per mDNS/Bonjour, SSDP und NAS-Ports…
                  </p>
                ) : (
                  <>
                    {networkScanSummary && (
                      <p className="text-[11px] text-slate-300">{networkScanSummary}</p>
                    )}
                    {networkScanDevices.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
                        {networkScanDevices.map((dev) => {
                          const storageServices = dev.services.filter(
                            (s) => s.protocol !== 'entencenter'
                          );
                          return (
                            <div
                              key={dev.id}
                              className="rounded-lg bg-[#0B0E14] border border-slate-800 p-2.5 flex flex-col gap-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs font-semibold text-white truncate">
                                      {dev.name}
                                    </span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                      {dev.vendor}
                                    </span>
                                    <span className="text-[10px] font-mono text-emerald-300">
                                      {dev.discoveryMethods.join(' · ').toUpperCase()}
                                    </span>
                                  </div>
                                  <p className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
                                    {dev.hostname !== dev.ip ? `${dev.hostname} · ${dev.ip}` : dev.ip}
                                  </p>
                                </div>

                                {dev.isEntenCenterServer && (
                                  <button
                                    type="button"
                                    onClick={() => void handleSelectDiscoveredServer(dev)}
                                    className="px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold transition-colors whitespace-nowrap"
                                  >
                                    Als Server verbinden ({dev.port || '3000'})
                                  </button>
                                )}
                              </div>

                              {storageServices.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[10px] text-slate-500">NAS-Dienste:</span>
                                  {storageServices.map((svc) => (
                                    <button
                                      key={`${dev.id}-${svc.protocol}-${svc.port}`}
                                      type="button"
                                      onClick={() => handleSelectDiscoveredNasStorage(dev, svc)}
                                      className="px-2 py-0.5 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-200 transition-colors"
                                    >
                                      {svc.label} :{svc.port}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {useCustomHomeNas ? (
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Globe className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-home-nas-url"
                      type="text"
                      value={homeNasInput}
                      onChange={(e) => {
                        setHomeNasInput(e.target.value);
                        setNasStatus('idle');
                        setMixedContentDirectUrl(null);
                        setNativeDiagnosisText(null);
                      }}
                      placeholder={
                        connectionScope === 'internet'
                          ? 'Externes NAS: https://mein-nas.myfritz.net oder https://domain.de:3000'
                          : 'Lokales NAS: http://192.168.178.50:3000 oder entencenter.local'
                      }
                      autoComplete="url"
                      aria-label="NAS- oder Server-Adresse"
                      className="w-full pl-8 pr-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs sm:text-sm font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleTestHomeNas()}
                    disabled={nasStatus === 'checking'}
                    className="px-3 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 text-amber-400 ${nasStatus === 'checking' ? 'animate-spin' : ''}`}
                    />
                    <span>Verbinden &amp; testen</span>
                  </button>
                </div>

                {(bootstrap?.networkConfig?.lanAddress || bootstrap?.networkConfig?.remoteAddress) && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="text-[10px] text-slate-500">Admin-Profile:</span>
                    {bootstrap.networkConfig.lanAddress && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = bootstrap.networkConfig!.lanAddress;
                          setUseCustomHomeNas(true);
                          setConnectionScope('lan');
                          setHomeNasInput(target);
                          setError(null);
                          void fetchBootstrap(target);
                        }}
                        className="px-2 py-0.5 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-emerald-300 transition-colors"
                      >
                        Lokal (LAN): {bootstrap.networkConfig.lanAddress}
                      </button>
                    )}
                    {bootstrap.networkConfig.remoteAddress && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = bootstrap.networkConfig!.remoteAddress;
                          setUseCustomHomeNas(true);
                          setConnectionScope('internet');
                          setHomeNasInput(target);
                          setError(null);
                          void fetchBootstrap(target);
                        }}
                        className="px-2 py-0.5 rounded bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-sky-300 transition-colors"
                      >
                        Remote (WAN/VPN): {bootstrap.networkConfig.remoteAddress}
                      </button>
                    )}
                  </div>
                )}

                <p className="text-[11px] text-slate-400">
                  {connectionScope === 'internet' ? (
                    <>
                      Für NAS-Geräte außerhalb deines Netzwerks: Gib deine öffentliche Domain, DynDNS/MyFRITZ-Adresse, Reverse-Proxy-URL (inkl. Unterpfad) oder VPN-IP mit Port ein.
                    </>
                  ) : (
                    <>
                      Für lokales WLAN/LAN: Nutze oben <strong className="text-slate-300">„Im Netzwerk suchen (mDNS)“</strong> oder gib IP, Hostname (z. B. <code className="font-mono text-slate-300">.local</code>) bzw. Port (z. B. <code className="font-mono text-slate-300">:3000</code> oder Ausweichport) ein.
                    </>
                  )}
                </p>

                {/* Ausweichport zu Port 3000 & Automatischer Port-Scan */}
                <div className="rounded-lg bg-[#121722] border border-slate-800/90 p-2.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor="login-alt-port"
                        className="text-[11px] font-medium text-slate-300"
                      >
                        Alternative zu :3000
                      </label>
                      <select
                        id="login-alt-port"
                        value={preferredAltPort}
                        onChange={(e) => {
                          const next = Number(e.target.value) || 3001;
                          setPreferredAltPort(next);
                          setPreferredAlternativePort(next);
                        }}
                        className="px-2 py-1 rounded bg-[#0B0E14] border border-slate-700 text-[11px] font-mono text-amber-300 focus:outline-none focus:border-amber-400"
                      >
                        {DEFAULT_ALTERNATIVE_PORTS.map((portNum) => (
                          <option key={portNum} value={portNum}>
                            Port {portNum}
                          </option>
                        ))}
                      </select>
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoPortFallback}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setAutoPortFallback(next);
                            setAutoPortFallbackEnabled(next);
                          }}
                          className="accent-amber-400 rounded"
                        />
                        <span>Auto-Fallback aktiv</span>
                      </label>
                    </div>
                    <button
                      type="button"
                      disabled={portScanBusy}
                      onClick={() => void handleRunPortScan()}
                      className="px-2.5 py-1 rounded-md bg-amber-400/15 hover:bg-amber-400/25 disabled:opacity-60 border border-amber-400/45 text-[11px] font-semibold text-amber-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Radar className={`w-3 h-3 ${portScanBusy ? 'animate-spin' : ''}`} />
                      <span>{portScanBusy ? 'Scanne Ports…' : 'Port-Scan (Alt. zu :3000)'}</span>
                    </button>
                  </div>

                  {portScanResult && (
                    <div className="space-y-1.5 pt-1 border-t border-slate-800/80 text-[11px]">
                      <p className="text-slate-300 leading-snug">{portScanResult.summary}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {portScanResult.recommendedBaseUrl && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleAdoptPortUrl(
                                portScanResult.recommendedBaseUrl!,
                                portScanResult.recommendedPort ?? undefined
                              )
                            }
                            className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-200 font-mono text-[10px] font-semibold transition-colors"
                          >
                            Empfohlen übernehmen: {portScanResult.recommendedBaseUrl}
                          </button>
                        )}
                        {portScanResult.ports
                          .filter((p) => p.isEntenCenter || p.tcpOpen)
                          .map((p) => {
                            const entryUrl = `${p.scheme === 'https' ? 'https' : 'http'}://${portScanResult.hostname}:${p.port}`;
                            return (
                              <button
                                key={`login-scan-${p.scheme}-${p.port}`}
                                type="button"
                                onClick={() => void handleAdoptPortUrl(entryUrl, p.port)}
                                className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                                  p.isEntenCenter
                                    ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200 hover:bg-emerald-500/25'
                                    : 'bg-[#0B0E14] border-slate-700 text-amber-200 hover:bg-slate-800'
                                }`}
                                title={p.label}
                              >
                                {p.scheme}:{p.port}{' '}
                                {p.isEntenCenter
                                  ? '✓ EntenCenter'
                                  : p.httpStatus
                                    ? `HTTP ${p.httpStatus}`
                                    : 'offen'}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>

                {nativeDiagnosisText && (
                  <div className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/35 rounded-lg p-2.5 space-y-2">
                    <p>{nativeDiagnosisText}</p>
                    {(nativeDiagnosis?.detectedPureNas || nativeDiagnosis?.detectedFritzBox) && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => openProvisionDialogForNas()}
                          className="px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 text-[10px] font-semibold flex items-center gap-1 transition-colors"
                        >
                          <FolderTree className="w-3 h-3" />
                          <span>NAS-Dateistruktur öffnen &amp; Backend anlegen</span>
                        </button>
                        {nativeDiagnosis.openNasServices?.map((svc) => (
                          <button
                            key={`adopt-top-${svc.protocol}-${svc.port}`}
                            type="button"
                            onClick={() => handleAdoptDetectedPureNas(nativeDiagnosis, svc)}
                            className="px-2 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[10px] font-semibold transition-colors"
                          >
                            Als {svc.label} (:{svc.port}) übernehmen
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => void runNetworkNasScan()}
                          className="px-2 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/45 text-emerald-300 text-[10px] font-medium transition-colors"
                        >
                          Heimnetz nach :3000 scannen
                        </button>
                      </div>
                    )}
                    {lastProvisionResult && (
                      <div className="pt-1.5 border-t border-amber-500/25 flex flex-wrap items-center justify-between gap-2 text-emerald-200">
                        <span>
                          Backend-Pfad angelegt: <code className="font-mono">{lastProvisionResult.backendPath}</code>
                        </span>
                        {localBuffer && (
                          <button
                            type="button"
                            onClick={() => handleWizardEnterFallbackMode(localBuffer)}
                            className="px-2.5 py-1 rounded bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-[10px] font-semibold"
                          >
                            Mit NAS-Bridge starten
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {mixedContentDirectUrl && (
                  <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/35 text-[11px] text-amber-200 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      HTTPS-Browser blockieren direkte HTTP-Zugriffe auf{' '}
                      <code className="font-mono">{mixedContentDirectUrl}</code>.
                    </span>
                    <a
                      href={mixedContentDirectUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 transition-colors"
                    >
                      <span>Direkt öffnen</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                Direkte Anmeldung &amp; Erstregistrierung ohne feste IP- oder Port-Eingabe
                {nativeShell ? '.' : ` (${window.location.origin}).`}{' '}
                Bei Bedarf kannst du oben optional eine eigene Server-Adresse angeben.
              </p>
            )}

            {lastProvisionResult && !nativeDiagnosisText && (
              <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-[11px] text-emerald-200 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Backend-Pfad angelegt:{' '}
                  <code className="font-mono text-emerald-100">{lastProvisionResult.backendPath}</code>
                  {lastProvisionResult.remoteWriteOk
                    ? ' (direkt auf NAS gespeichert)'
                    : ' (Storage-Bridge aktiv · Verbindung bleibt offen)'}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => openProvisionDialogForNas({ shareOrPath: lastProvisionResult.backendPath })}
                    className="px-2 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/40 text-emerald-200 text-[10px] font-medium"
                  >
                    Ordnerstruktur prüfen
                  </button>
                  {localBuffer && (
                    <button
                      type="button"
                      onClick={() => handleWizardEnterFallbackMode(localBuffer)}
                      className="px-2.5 py-1 rounded bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-[10px] font-semibold"
                    >
                      Mit NAS-Bridge starten
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <UniversalNasManagerPanel
            initialHost={homeNasInput}
            onAuthenticated={onAuthenticated}
            onAdoptConnectionToForm={(conn) => {
              setHomeNasInput(conn.host);
              setUseCustomHomeNas(true);
              setConnectionScope(conn.scope === 'internet' ? 'internet' : 'lan');
              setNasConn((prev) => ({
                ...prev,
                protocol: conn.protocol,
                host: conn.host,
                port: conn.port,
                shareOrPath: conn.shareOrPath,
                username: conn.username,
                secret: conn.password,
                useTls: conn.useTls,
              }));
              setShowOptionalNasSetup(true);
              if (conn.fritzTracks || conn.host.toLowerCase().includes('fritz')) {
                setFritzUpnpHost(conn.host);
                if (conn.username) setFritzUsername(conn.username);
                if (conn.password) setFritzPassword(conn.password);
              }
              setNasStatus('online');
              setError(null);
            }}
          />

          <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0B0E14] border border-slate-800 w-fit">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                mode === 'login'
                  ? 'bg-amber-400 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Anmelden</span>
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                mode === 'register'
                  ? 'bg-amber-400 text-slate-950 font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Neues Profil · Setup-Assistent</span>
            </button>
          </div>

          {/* Status-Banner für aktives Storage-Bridge-Profil oder unsynchronisierten Puffer */}
          {localBuffer && mode === 'login' && (
            isConfirmedStorageBridge(localBuffer) ? (
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-xs text-emerald-100 flex flex-wrap items-center justify-between gap-2.5">
                <div className="space-y-0.5 min-w-0">
                  <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>NAS Storage-Bridge für @{localBuffer.user.username} eingerichtet</span>
                  </p>
                  <p className="text-[11px] text-emerald-100/80 font-mono truncate">
                    {localBuffer.syncedBackendPath || localBuffer.nasConnection?.backendPath || '/EntenCenter-Backend'}
                    {localBuffer.nasConnection?.host ? ` · ${localBuffer.nasConnection.host}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleWizardEnterFallbackMode(localBuffer)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-[11px] font-semibold"
                  >
                    Mit NAS starten
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-amber-400/10 border border-amber-400/40 text-xs text-amber-100 flex flex-wrap items-center justify-between gap-2.5">
                <div className="space-y-0.5 min-w-0">
                  <p className="font-semibold text-amber-300 flex items-center gap-1.5">
                    <HardDriveDownload className="w-3.5 h-3.5 shrink-0" />
                    <span>Lokaler On-Device-Puffer für @{localBuffer.user.username} aktiv</span>
                  </p>
                  <p className="text-[11px] text-amber-100/80">
                    Noch nicht aufs NAS übertragen. Assistent fortsetzen oder lokal starten.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setWizardStep(localBuffer.serverUrl || localBuffer.nasConnection?.host ? 3 : 2);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-[#0B0E14] border border-amber-400/50 text-[11px] font-medium text-amber-200 hover:bg-slate-900"
                  >
                    Setup fortsetzen
                  </button>
                  <button
                    type="button"
                    onClick={() => handleWizardEnterFallbackMode(localBuffer)}
                    className="px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold"
                  >
                    Lokal starten
                  </button>
                </div>
              </div>
            )
          )}

          {!localBuffer && mode === 'login' && (nasStatus === 'unreachable' || (nativeShell && !homeNasInput.trim())) && (
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-700/80 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
              <span>
                Kein NAS sofort erreichbar? Starte die Ersteinrichtung lokal im On-Device-Speicher ohne feste IP/Port-Vorgabe.
              </span>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setWizardStep(1);
                  setError(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/45 text-amber-300 text-[11px] font-semibold whitespace-nowrap"
              >
                Setup-Assistent (Lokal) öffnen
              </button>
            </div>
          )}

          {bootstrap && !bootstrap.hasAdmin && (
            <div
              role="status"
              className="p-3 rounded-lg bg-amber-400/10 border border-amber-400/40 text-xs text-amber-200 flex items-start gap-2.5"
            >
              <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Noch kein Administrator eingerichtet: Die erste Person, die sich anmeldet oder ein
                Profil anlegt, erhält automatisch Administrator-Rechte.
              </span>
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <h3 className="font-display text-xl font-semibold text-white">
                  Am Heim-NAS anmelden
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Gib deinen Benutzernamen und dein Passwort ein. Fremde Profile bleiben verborgen.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Benutzername
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    autoFocus={!nativeShell}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Benutzernamen eingeben"
                    autoComplete="username"
                    className="w-full pl-10 pr-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Passwort
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="NAS-Passwort eingeben"
                    autoComplete="current-password"
                    className="w-full pl-10 pr-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || fritzLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <span>{loading ? 'Verbinde mit Heim-NAS...' : 'Mit Heim-NAS verbinden'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              {fritzUpnpAvailable && (
                <div className="pt-2">
                  <div className="rounded-xl bg-[#0B0E14] border border-emerald-500/35 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="text-xs sm:text-sm font-semibold text-white">
                          FRITZ!Box / FRITZ!NAS (UPnP / Challenge-Response)
                        </span>
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 whitespace-nowrap">
                        HTTP :80 + LAN-TLS Fallback
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Falls deine FRITZ!Box / FRITZ!NAS beim Zugriff nach Zugangsdaten fragt oder HTTPS
                      einen Zertifikats-/Protokollfehler meldet, gib hier deine FRITZ!Box-Daten ein —
                      EntenCenter weicht im Heimnetz automatisch auf lokales HTTP (Port 80) aus.
                    </p>

                    {bootstrap?.fritzDiscovery?.enabled && (
                      <div className="rounded-lg bg-[#121722] border border-slate-800 p-2.5 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <Radar
                              className={`w-3.5 h-3.5 text-emerald-400 ${
                                discoveryScanning ? 'animate-spin' : ''
                              }`}
                            />
                            <span className="text-[11px] font-semibold text-slate-200">
                              Fritzbox UPnP/DLNA- &amp; NAS-Discovery
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={discoveryScanning}
                            onClick={() => void runFritzDiscoveryCheck(undefined, false)}
                            className="text-[10px] font-medium text-amber-300 hover:text-amber-200 flex items-center gap-1"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${discoveryScanning ? 'animate-spin' : ''}`}
                            />
                            <span>{discoveryScanning ? 'Suche...' : 'Netzwerk suchen'}</span>
                          </button>
                        </div>

                        {(discoveryResult || discoveryProbe) ? (
                          <div className="space-y-1 text-[11px]">
                            <p
                              className={
                                discoveryResult?.tokenlessReady || discoveryProbe?.tokenlessEligible
                                  ? 'text-emerald-300'
                                  : 'text-slate-400'
                              }
                            >
                              {discoveryResult?.summary || discoveryProbe?.reason}
                            </p>
                            {(discoveryResult?.devices ?? discoveryProbe?.discoveredDevices ?? []).length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {(discoveryResult?.devices ?? discoveryProbe?.discoveredDevices ?? []).map((dev) => (
                                  <button
                                    key={dev.id}
                                    type="button"
                                    onClick={() => {
                                      setFritzUpnpHost(dev.ip);
                                      if (dev.httpsError || dev.port === '80') setFritzUseTls(false);
                                    }}
                                    className="px-2 py-0.5 rounded bg-[#0B0E14] border border-emerald-500/40 text-[10px] font-mono text-emerald-200"
                                  >
                                    {dev.friendlyName} ({dev.ip})
                                    {dev.requiresAuth ? ' · Login nötig' : ''}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-400">
                            Automatische Suche nach FRITZ!Box-Geräten im selben Subnetz aktiv.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {['fritz.box', 'fritz.nas', '192.168.178.1'].map((presetHost) => (
                        <button
                          key={presetHost}
                          type="button"
                          onClick={() => setFritzUpnpHost(presetHost)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                            fritzUpnpHost.trim() === presetHost
                              ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/50'
                              : 'bg-[#121722] text-slate-400 border-slate-800 hover:text-slate-200'
                          }`}
                        >
                          {presetHost}
                        </button>
                      ))}
                      <input
                        type="text"
                        value={fritzUpnpHost}
                        onChange={(e) => setFritzUpnpHost(e.target.value)}
                        placeholder="z. B. 192.168.178.69 oder fritz.box"
                        aria-label="FRITZ!Box Hostname oder IP"
                        className="flex-1 min-w-[140px] px-2.5 py-1 rounded-md bg-[#121722] border border-slate-800 text-[11px] font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label
                          htmlFor="login-fritz-username"
                          className="block text-[10px] font-medium text-slate-400 mb-1"
                        >
                          FRITZ!Box Benutzername (optional)
                        </label>
                        <input
                          id="login-fritz-username"
                          type="text"
                          value={fritzUsername}
                          onChange={(e) => setFritzUsername(e.target.value)}
                          placeholder="z. B. fritz1234 oder leer"
                          aria-label="FRITZ!Box Benutzername"
                          className="w-full px-2.5 py-1.5 rounded-md bg-[#121722] border border-slate-800 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="login-fritz-password"
                          className="block text-[10px] font-medium text-slate-400 mb-1"
                        >
                          Passwort für die FRITZ!Box
                        </label>
                        <div className="relative flex items-center">
                          <input
                            id="login-fritz-password"
                            type={showFritzPassword ? 'text' : 'password'}
                            value={fritzPassword}
                            onChange={(e) => setFritzPassword(e.target.value)}
                            placeholder="Passwort für die FRITZ!Box"
                            aria-label="Passwort für die FRITZ!Box"
                            className="w-full px-2.5 py-1.5 pr-8 rounded-md bg-[#121722] border border-slate-800 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                          />
                          <button
                            type="button"
                            onClick={() => setShowFritzPassword((v) => !v)}
                            aria-label="Passwort für die FRITZ!Box anzeigen"
                            className="absolute right-2 text-slate-400 hover:text-slate-200"
                          >
                            {showFritzPassword ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={fritzUseTls}
                          onChange={(e) => setFritzUseTls(e.target.checked)}
                          className="accent-emerald-400 rounded"
                        />
                        <span>HTTPS bevorzugen (mit autom. HTTP :80 LAN-Fallback)</span>
                      </label>
                      <button
                        type="button"
                        disabled={loading || fritzLoading}
                        onClick={() => void handleTestFritzChallengeLogin()}
                        className="text-sky-300 hover:text-sky-200 font-medium underline underline-offset-2"
                      >
                        FRITZ!Box-Login testen
                      </button>
                    </div>

                    {fritzChallengeTestMsg && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/40 px-2.5 py-1.5 text-[11px] text-emerald-200">
                        {fritzChallengeTestMsg}
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2">
                      {bootstrap?.fritzDiscovery?.enabled && !fritzPassword && (
                        <button
                          type="button"
                          disabled={loading || fritzLoading}
                          onClick={() => {
                            setError(null);
                            const targetBase = applyHomeNasTarget();
                            void runTokenlessFritzLogin(targetBase, fritzUpnpHost);
                          }}
                          className="flex-1 py-2.5 px-3 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                        >
                          <Radar className="w-3.5 h-3.5" />
                          <span>
                            {fritzLoading ? 'Prüfe Subnetz...' : 'Tokenlos per Discovery anmelden'}
                          </span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={loading || fritzLoading}
                        onClick={() => void handleFritzUpnpAccess()}
                        className="flex-1 py-2.5 px-3 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 text-emerald-200 border border-emerald-500/45 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Wifi className="w-3.5 h-3.5 text-emerald-300" />
                        <span>
                          {fritzLoading
                            ? 'Verbinde via FRITZ!Box...'
                            : fritzPassword
                              ? 'Mit FRITZ!Box-Zugangsdaten anmelden'
                              : 'Mit FRITZ!Box verbinden'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          openProvisionDialogForNas({
                            host: fritzUpnpHost.trim() || 'fritz.box',
                            port: fritzUseTls ? '443' : '80',
                            protocol: 'fritz_upnp',
                            username: fritzUsername,
                            secret: fritzPassword,
                            useTls: fritzUseTls,
                          })
                        }
                        className="py-2.5 px-3 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/45 font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <FolderTree className="w-3.5 h-3.5 text-sky-300" />
                        <span>Dateistruktur &amp; Backend</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </form>
          ) : (
            <div className="space-y-5">
              {/* Setup-Assistent Schrittanzeige */}
              <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-lg sm:text-xl font-semibold text-white">
                      Setup-Assistent · Lokales Onboarding
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Erst lokal auf dem Gerät puffern, danach NAS verbinden, testen und automatisch übertragen.
                    </p>
                  </div>
                  {localBuffer && (
                    <button
                      type="button"
                      onClick={() => void handleWizardResetBuffer()}
                      className="px-2.5 py-1 rounded-md bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Puffer zurücksetzen</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {[
                    { step: 1 as const, label: '1. Lokales Konto' },
                    { step: 2 as const, label: '2. NAS-Daten' },
                    { step: 3 as const, label: '3. Test & Übertrag' },
                  ].map((item) => {
                    const active = wizardStep === item.step;
                    const done =
                      (item.step === 1 && localBuffer !== null && wizardStep > 1) ||
                      (item.step === 2 && wizardStep > 2);
                    const disabled = item.step > 1 && !localBuffer;
                    return (
                      <button
                        key={item.step}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          if (!disabled) {
                            setError(null);
                            setWizardStep(item.step);
                          }
                        }}
                        className={`px-2.5 py-2 rounded-lg border text-[11px] font-medium text-left transition-colors disabled:opacity-45 ${
                          active
                            ? 'bg-amber-400/15 border-amber-400/70 text-amber-200'
                            : done
                              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                              : 'bg-[#121722] border-slate-800 text-slate-400'
                        }`}
                      >
                        {done ? `✓ ${item.label}` : item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {wizardStep === 1 && (
                <form onSubmit={handleWizardStep1Submit} className="space-y-4">
                  <div className="rounded-xl bg-[#0B0E14]/80 border border-slate-800 p-4 space-y-3">
                    <div className="flex items-start gap-2.5">
                      <HardDriveDownload className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-xs text-slate-300 space-y-1">
                        <p className="font-semibold text-white">
                          Schritt 1: Registrierung im lokalen On-Device-Puffer (Offline-fähig)
                        </p>
                        <p className="text-[11px] text-slate-400">
                          Benutzerdaten und lokaler Token werden zunächst sicher auf deinem Gerät (
                          {nativeShell ? 'Android SharedPreferences + WebView-Speicher' : 'LocalStorage + IndexedDB'}
                          ) abgelegt — ganz ohne sofortige NAS-Verbindung.
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 pt-1">
                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">
                          Benutzername
                        </label>
                        <div className="relative">
                          <User className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            required
                            autoFocus={!nativeShell}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="z. B. wohnzimmer"
                            autoComplete="username"
                            className="w-full pl-9 pr-3 py-2.5 bg-[#121722] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">
                          Anzeigename (optional)
                        </label>
                        <input
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="z. B. Wohnzimmer TV"
                          className="w-full px-3.5 py-2.5 bg-[#121722] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">
                          Passwort (mind. 4 Zeichen)
                        </label>
                        <div className="relative">
                          <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="password"
                            required
                            minLength={4}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Passwort festlegen"
                            autoComplete="new-password"
                            className="w-full pl-9 pr-3 py-2.5 bg-[#121722] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div
                      role="alert"
                      className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200"
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <span>Lokal registrieren &amp; weiter zu Schritt 2</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              {wizardStep === 2 && (
                <form onSubmit={handleWizardStep2Next} className="space-y-4">
                  <div className="rounded-xl bg-[#0B0E14]/80 border border-slate-800 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs sm:text-sm font-semibold text-white">
                          Schritt 2: NAS-Server-Adresse &amp; Freigabedaten (optional)
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Dein Konto <code className="font-mono text-amber-300">@{localBuffer?.user.username || username}</code> ist lokal gepuffert. Gib jetzt oder später deine NAS-Verbindung an.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void runNetworkNasScan()}
                        disabled={networkScanning}
                        className="px-2.5 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-[11px] font-medium text-emerald-300 flex items-center gap-1.5"
                      >
                        <Radar className={`w-3.5 h-3.5 ${networkScanning ? 'animate-spin' : ''}`} />
                        <span>{networkScanning ? 'Suche…' : 'NAS im Netz suchen'}</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] font-medium text-slate-300 block mb-1">
                          EntenCenter NAS-Server-URL (LAN oder Internet)
                        </label>
                        <input
                          type="text"
                          value={useCustomHomeNas ? homeNasInput : ''}
                          onChange={(e) => {
                            setUseCustomHomeNas(true);
                            setHomeNasInput(e.target.value);
                            setError(null);
                          }}
                          placeholder="z. B. http://192.168.178.50:3000 oder https://mein-nas.myfritz.net"
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-slate-300 block mb-1">
                          Verbindungsbereich
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setConnectionScope('lan')}
                            className={`flex-1 py-2 px-2.5 rounded-lg border text-xs font-medium ${
                              connectionScope === 'lan'
                                ? 'bg-amber-400/15 border-amber-400/60 text-amber-200'
                                : 'bg-[#121722] border-slate-800 text-slate-400'
                            }`}
                          >
                            Lokal (LAN / WLAN)
                          </button>
                          <button
                            type="button"
                            onClick={() => setConnectionScope('internet')}
                            className={`flex-1 py-2 px-2.5 rounded-lg border text-xs font-medium ${
                              connectionScope === 'internet'
                                ? 'bg-amber-400/15 border-amber-400/60 text-amber-200'
                                : 'bg-[#121722] border-slate-800 text-slate-400'
                            }`}
                          >
                            Internet / VPN
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Teil 2: Optionale NAS-Freigabe (IP, Pfad, Protokoll, Credentials) */}
                  <div className="rounded-xl bg-[#0B0E14]/80 border border-slate-800 p-4 space-y-4">
                    <button
                      type="button"
                      onClick={() => setShowOptionalNasSetup((open) => !open)}
                      aria-expanded={showOptionalNasSetup}
                      className="w-full flex flex-wrap items-center justify-between gap-2 text-left"
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <h4 className="text-xs sm:text-sm font-semibold text-white">
                            Optional: NAS-Speicherpfad &amp; Protokoll-Zugangsdaten (SMB/NFS/WebDAV/FRITZ!Box)
                          </h4>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Werden lokal mitgepuffert und nach erfolgreichem Verbindungstest auf dem NAS hinterlegt.
                          </p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded bg-slate-800/90 text-slate-200 border border-slate-700/80 whitespace-nowrap">
                        <span>{showOptionalNasSetup ? 'Ausblenden' : 'Protokoll & Pfad angeben'}</span>
                        {showOptionalNasSetup ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </span>
                    </button>

                    {showOptionalNasSetup && (
                  <>
                    <div className="pt-2 border-t border-slate-800/80 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-400">
                          NAS-Gerät automatisch per mDNS / Bonjour übernehmen statt manuell einzutippen:
                        </span>
                        <button
                          type="button"
                          onClick={() => void runNetworkNasScan()}
                          disabled={networkScanning}
                          className="px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-[11px] font-medium text-emerald-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                        >
                          <Radar className={`w-3.5 h-3.5 ${networkScanning ? 'animate-spin' : ''}`} />
                          <span>{networkScanning ? 'Suche läuft...' : 'NAS automatisch erkennen'}</span>
                        </button>
                      </div>
                      {networkScanExpanded && (networkScanning || networkScanDevices.length > 0 || networkScanSummary) && (
                        <div className="rounded-lg bg-[#121722] border border-slate-800 p-2.5 space-y-1.5">
                          {networkScanning ? (
                            <p className="text-[11px] text-slate-400">Scanne lokales Netz nach NAS-Geräten…</p>
                          ) : (
                            <>
                              {networkScanSummary && (
                                <p className="text-[11px] text-slate-300">{networkScanSummary}</p>
                              )}
                              {networkScanDevices.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {networkScanDevices.map((dev) => (
                                    <button
                                      key={`reg-pick-${dev.id}`}
                                      type="button"
                                      onClick={() => handleSelectDiscoveredNasStorage(dev)}
                                      className="px-2.5 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/40 text-[11px] font-mono text-emerald-200 transition-colors"
                                    >
                                      {dev.name} · {dev.ip}:{dev.port || '445'} ({dev.suggestedProtocol.toUpperCase()})
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Auswahl des Anmeldewegs */}
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[11px] font-medium text-slate-300 block">
                        Anmeldeweg / NAS-Protokoll
                      </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                    {availableProtocols.map((proto) => {
                      const selected = nasConn.protocol === proto.id;
                      return (
                        <button
                          key={proto.id}
                          type="button"
                          onClick={() => handleSelectNasProtocol(proto.id)}
                          aria-pressed={selected}
                          className={`text-left p-2.5 rounded-lg border transition-colors flex flex-col justify-between gap-1 ${
                            selected
                              ? 'bg-amber-400/10 border-amber-400/75 text-white'
                              : 'bg-[#121722] border-slate-800 text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-white">{proto.label}</span>
                            <span className="text-[10px] font-mono text-slate-400 tabular-nums">
                              :{proto.defaultPort}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-400 leading-snug line-clamp-2">
                            {proto.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* NAS Host, Port, Pfad & Zugangsdaten */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="reg-nas-host"
                      className="text-[11px] font-medium text-slate-300 flex items-center gap-1.5 mb-1"
                    >
                      <Globe className="w-3.5 h-3.5 text-amber-400" />
                      <span>
                        {nasConn.protocol === 'webdav' || nasConn.protocol === 'api_token'
                          ? 'NAS-Server-URL / Host'
                          : 'NAS Host / IP-Adresse'}
                      </span>
                    </label>
                    <input
                      id="reg-nas-host"
                      type="text"
                      value={nasConn.host}
                      onChange={(e) => setNasConn({ ...nasConn, host: e.target.value })}
                        placeholder={
                          nasConn.protocol === 'fritz_upnp'
                            ? 'Optional (z. B. fritz.box)'
                            : nasConn.protocol === 'webdav'
                              ? 'https://...'
                              : 'IP-Adresse oder Hostname (optional)'
                        }
                        autoComplete="off"
                        className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label
                          htmlFor="reg-nas-port"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          Port (optional)
                        </label>
                        <input
                          id="reg-nas-port"
                          type="text"
                          value={nasConn.port}
                          onChange={(e) => setNasConn({ ...nasConn, port: e.target.value })}
                          placeholder="frei wählbar (z. B. 3000)"
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400 tabular-nums"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="reg-nas-path"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          {nasConn.protocol === 'smb'
                            ? 'Freigabe (optional)'
                            : nasConn.protocol === 'nfs'
                              ? 'Export-Pfad (optional)'
                              : 'Medien-Pfad (optional)'}
                        </label>
                        <input
                          id="reg-nas-path"
                          type="text"
                          value={nasConn.shareOrPath}
                          onChange={(e) => setNasConn({ ...nasConn, shareOrPath: e.target.value })}
                          placeholder="/Medien"
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                        />
                      </div>
                    </div>

                  {/* Protokoll-spezifische Optionen */}
                  {nasConn.protocol === 'smb' && (
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="reg-nas-domain"
                        className="text-[11px] font-medium text-slate-300 block mb-1"
                      >
                        Arbeitsgruppe / Domäne
                      </label>
                      <input
                        id="reg-nas-domain"
                        type="text"
                        value={nasConn.domainOrWorkgroup ?? 'WORKGROUP'}
                        onChange={(e) =>
                          setNasConn({ ...nasConn, domainOrWorkgroup: e.target.value })
                        }
                        placeholder="WORKGROUP"
                        className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                      />
                    </div>
                  )}

                  {nasConn.protocol === 'nfs' && (
                    <>
                      <div>
                        <label
                          htmlFor="reg-nas-nfs-ver"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          NFS-Version
                        </label>
                        <select
                          id="reg-nas-nfs-ver"
                          value={nasConn.nfsVersion ?? 'NFSv4.1'}
                          onChange={(e) =>
                            setNasConn({
                              ...nasConn,
                              nfsVersion: e.target.value as NasRegistrationConnectionPayload['nfsVersion'],
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-amber-400"
                        >
                          <option value="NFSv4.1">NFSv4.1 (Empfohlen)</option>
                          <option value="NFSv4">NFSv4</option>
                          <option value="NFSv3">NFSv3</option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="reg-nas-nfs-auth"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          NFS-Authentifizierung
                        </label>
                        <select
                          id="reg-nas-nfs-auth"
                          value={nasConn.nfsAuthMode ?? 'AUTH_SYS'}
                          onChange={(e) =>
                            setNasConn({
                              ...nasConn,
                              nfsAuthMode: e.target.value as NasRegistrationConnectionPayload['nfsAuthMode'],
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-amber-400"
                        >
                          <option value="AUTH_SYS">AUTH_SYS (UID/GID im LAN)</option>
                          <option value="Kerberos (krb5p)">Kerberos (krb5p verschlüsselt)</option>
                        </select>
                      </div>
                    </>
                  )}

                  {nasConn.protocol === 'webdav' && (
                    <div className="sm:col-span-2">
                      <label className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs text-slate-200 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={nasConn.useTls ?? true}
                          onChange={(e) => setNasConn({ ...nasConn, useTls: e.target.checked })}
                          className="accent-amber-400 rounded"
                        />
                        <span>HTTPS / TLS-Zertifikat für WebDAV erzwingen</span>
                      </label>
                    </div>
                  )}

                  {nasConn.protocol === 'sftp' && (
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="reg-nas-sftp-mode"
                        className="text-[11px] font-medium text-slate-300 block mb-1"
                      >
                        SFTP-Anmeldeart
                      </label>
                      <select
                        id="reg-nas-sftp-mode"
                        value={nasConn.sftpAuthMode ?? 'password'}
                        onChange={(e) =>
                          setNasConn({
                            ...nasConn,
                            sftpAuthMode: e.target.value as NasRegistrationConnectionPayload['sftpAuthMode'],
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-amber-400"
                      >
                        <option value="password">Benutzername &amp; Passwort</option>
                        <option value="ssh_key">SSH-Schlüssel (Ed25519 / RSA)</option>
                      </select>
                    </div>
                  )}

                  {nasConn.protocol === 'ftps' && (
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="reg-nas-ftps-mode"
                        className="text-[11px] font-medium text-slate-300 block mb-1"
                      >
                        FTPS-Verschlüsselung
                      </label>
                      <select
                        id="reg-nas-ftps-mode"
                        value={nasConn.ftpsTlsMode ?? 'explicit'}
                        onChange={(e) =>
                          setNasConn({
                            ...nasConn,
                            ftpsTlsMode: e.target.value as NasRegistrationConnectionPayload['ftpsTlsMode'],
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-amber-400"
                      >
                        <option value="explicit">Explizites TLS (FTPES · Port 21)</option>
                        <option value="implicit">Implizites TLS (FTPS · Port 990)</option>
                      </select>
                    </div>
                  )}

                  {nasConn.protocol === 'api_token' && (
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="reg-nas-api-vendor"
                        className="text-[11px] font-medium text-slate-300 block mb-1"
                      >
                        NAS-Betriebssystem
                      </label>
                      <select
                        id="reg-nas-api-vendor"
                        value={nasConn.apiVendor ?? 'Synology DSM'}
                        onChange={(e) =>
                          setNasConn({
                            ...nasConn,
                            apiVendor: e.target.value as NasRegistrationConnectionPayload['apiVendor'],
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white focus:outline-none focus:border-amber-400"
                      >
                        <option value="Synology DSM">Synology DSM</option>
                        <option value="QNAP QTS">QNAP QTS / QuTS hero</option>
                        <option value="TrueNAS Scale">TrueNAS Scale / Core</option>
                        <option value="Unraid">Unraid OS</option>
                        <option value="OpenMediaVault">OpenMediaVault</option>
                      </select>
                    </div>
                  )}

                  {nasConn.protocol === 'fritz_upnp' ? (
                    <div className="sm:col-span-2 rounded-lg bg-emerald-500/10 border border-emerald-500/35 p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span className="text-xs font-semibold text-white">
                            FRITZ!Box / FRITZ!NAS (UPnP / Challenge-Response)
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {['fritz.box', 'fritz.nas', '192.168.178.1'].map((presetHost) => (
                            <button
                              key={presetHost}
                              type="button"
                              onClick={() => setNasConn({ ...nasConn, host: presetHost })}
                              className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                                nasConn.host.trim() === presetHost
                                  ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/50'
                                  : 'bg-[#121722] text-slate-400 border-slate-800 hover:text-slate-200'
                              }`}
                            >
                              {presetHost}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Wenn deine FRITZ!Box einen Login vor dem FRITZ!NAS-Zugriff verlangt, trage hier
                        optional deinen FRITZ!Box-Benutzer und dein Kennwort ein (bei HTTPS-Fehlern im LAN
                        weicht EntenCenter automatisch auf HTTP Port 80 aus). Inklusive{' '}
                        <span className="font-semibold text-emerald-300">
                          NAS-Schreibrechten &amp; automatischem Profilordner
                        </span>
                        :
                      </p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label
                            htmlFor="reg-fritz-user"
                            className="text-[11px] font-medium text-slate-300 block mb-1"
                          >
                            FRITZ!Box-Benutzer (optional)
                          </label>
                          <input
                            id="reg-fritz-user"
                            type="text"
                            value={nasConn.username}
                            onChange={(e) => setNasConn({ ...nasConn, username: e.target.value })}
                            placeholder="z. B. fritz1234 oder leer"
                            className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="reg-fritz-secret"
                            className="text-[11px] font-medium text-slate-300 block mb-1"
                          >
                            Passwort für die FRITZ!Box
                          </label>
                          <div className="relative flex items-center">
                            <input
                              id="reg-fritz-secret"
                              type={showNasSecret ? 'text' : 'password'}
                              value={nasConn.secret}
                              onChange={(e) => setNasConn({ ...nasConn, secret: e.target.value })}
                              placeholder="Passwort für die FRITZ!Box"
                              className="w-full px-3 py-2 pr-9 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
                            />
                            <button
                              type="button"
                              onClick={() => setShowNasSecret((v) => !v)}
                              aria-label="Passwort für die FRITZ!Box anzeigen"
                              className="absolute right-2.5 text-slate-400 hover:text-slate-200"
                            >
                              {showNasSecret ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={nasConn.useTls}
                            onChange={(e) => setNasConn({ ...nasConn, useTls: e.target.checked })}
                            className="accent-emerald-400 rounded"
                          />
                          <span>HTTPS nutzen (automatischer HTTP-Fallback im LAN aktiv)</span>
                        </label>
                        <button
                          type="button"
                          disabled={loading || fritzLoading}
                          onClick={() => {
                            setFritzUpnpHost(nasConn.host || 'fritz.box');
                            setFritzUsername(nasConn.username);
                            setFritzPassword(nasConn.secret ?? '');
                            setFritzUseTls(Boolean(nasConn.useTls));
                            void handleFritzUpnpAccess(nasConn.host || 'fritz.box');
                          }}
                          className="px-3.5 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/45 text-xs font-semibold text-emerald-200 flex items-center gap-2 transition-colors whitespace-nowrap"
                        >
                          <Wifi className="w-3.5 h-3.5 text-emerald-300" />
                          <span>
                            {fritzLoading
                              ? 'Verbinde via FRITZ!Box...'
                              : nasConn.secret
                                ? 'Direkt mit FRITZ!Box-Daten verbinden'
                                : 'Direkt via FRITZ!Box verbinden'}
                          </span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label
                          htmlFor="reg-nas-user"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          {nasConn.protocol === 'api_token'
                            ? 'NAS-Benutzer / Client-ID'
                            : nasConn.protocol === 'nfs' && nasConn.nfsAuthMode === 'AUTH_SYS'
                              ? 'Benutzer / UID:GID (optional bei AUTH_SYS)'
                              : 'NAS-Benutzername'}
                        </label>
                        <input
                          id="reg-nas-user"
                          type="text"
                          value={nasConn.username}
                          onChange={(e) => setNasConn({ ...nasConn, username: e.target.value })}
                          placeholder={
                            nasConn.protocol === 'nfs' && nasConn.nfsAuthMode === 'AUTH_SYS'
                              ? '1000:1000'
                              : 'z. B. entencenter_nas'
                          }
                          autoComplete="off"
                          className="w-full px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="reg-nas-secret"
                          className="text-[11px] font-medium text-slate-300 block mb-1"
                        >
                          {nasConn.protocol === 'api_token'
                            ? 'API-Token / App-Schlüssel'
                            : nasConn.protocol === 'sftp' && nasConn.sftpAuthMode === 'ssh_key'
                              ? 'SSH-Private-Key / Passphrase'
                              : 'NAS-Passwort'}
                        </label>
                        <div className="relative">
                          <input
                            id="reg-nas-secret"
                            type={showNasSecret ? 'text' : 'password'}
                            value={nasConn.secret ?? ''}
                            onChange={(e) => setNasConn({ ...nasConn, secret: e.target.value })}
                            placeholder="NAS-Passwort oder Token"
                            autoComplete="new-password"
                            className="w-full px-3 py-2 pr-9 rounded-lg bg-[#121722] border border-slate-800 text-xs sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNasSecret((s) => !s)}
                            aria-label={showNasSecret ? 'Passwort verbergen' : 'Passwort anzeigen'}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                          >
                            {showNasSecret ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>

                      {(Boolean(nativeDiagnosis?.detectedFritzBox) ||
                        Boolean(nativeDiagnosis?.fritzBoxInfo?.requiresAuth) ||
                        nasConn.host.toLowerCase().includes('fritz') ||
                        nasConn.host.startsWith('192.168.178.') ||
                        Boolean(nasConn.fritzPassword) ||
                        showExtraFritzFieldInWizard) ? (
                        <div className="sm:col-span-2 rounded-lg bg-sky-500/10 border border-sky-500/35 p-3 space-y-1.5">
                          <label
                            htmlFor="reg-fritz-extra-secret"
                            className="text-[11px] font-semibold text-sky-200 flex items-center gap-1.5"
                          >
                            <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                            <span>Passwort für die FRITZ!Box (falls zusätzlich benötigt)</span>
                          </label>
                          <div className="relative">
                            <input
                              id="reg-fritz-extra-secret"
                              type={showExtraFritzPassWizard ? 'text' : 'password'}
                              value={nasConn.fritzPassword ?? ''}
                              onChange={(e) =>
                                setNasConn({ ...nasConn, fritzPassword: e.target.value })
                              }
                              placeholder="Separates FRITZ!Box-Passwort (falls Router extra Login verlangt)"
                              autoComplete="new-password"
                              className="w-full px-3 py-2 pr-9 rounded-lg bg-[#121722] border border-sky-500/40 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                            />
                            <button
                              type="button"
                              onClick={() => setShowExtraFritzPassWizard((s) => !s)}
                              aria-label="Passwort für die FRITZ!Box anzeigen"
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                            >
                              {showExtraFritzPassWizard ? (
                                <EyeOff className="w-3.5 h-3.5" />
                              ) : (
                                <Eye className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="sm:col-span-2 flex justify-end">
                          <button
                            type="button"
                            onClick={() => setShowExtraFritzFieldInWizard(true)}
                            className="text-[11px] text-sky-300 hover:text-sky-200 underline underline-offset-2"
                          >
                            + Zusätzliches Passwort für die FRITZ!Box eingeben
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                  </>
                )}
              </div>

              {error && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200"
                >
                  {error}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setWizardStep(1);
                  }}
                  className="px-4 py-2.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200"
                >
                  Zurück
                </button>
                <button
                  type="button"
                  onClick={() => handleWizardEnterFallbackMode()}
                  className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-amber-300"
                >
                  Ohne NAS im Fallback-Modus starten
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 px-4 bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  <span>Lokal puffern &amp; zum Verbindungstest</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
              )}

              {wizardStep === 3 && localBuffer && (
                <div className="space-y-4">
                  <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs sm:text-sm font-semibold text-white">
                        Schritt 3: Verbindungstest nachschieben &amp; aufs NAS übertragen
                      </h4>
                      <span className="px-2 py-0.5 rounded bg-amber-400/15 border border-amber-400/40 text-[10px] font-semibold text-amber-300">
                        On-Device-Puffer aktiv
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                      <div className="p-2.5 rounded-lg bg-[#121722] border border-slate-800 space-y-0.5">
                        <span className="text-[10px] text-slate-400">Lokales Profil</span>
                        <p className="font-mono text-white">
                          @{localBuffer.user.username} ({localBuffer.user.displayName})
                        </p>
                      </div>
                      <div className="p-2.5 rounded-lg bg-[#121722] border border-slate-800 space-y-0.5">
                        <span className="text-[10px] text-slate-400">Ziel-Server</span>
                        <p className="font-mono text-amber-300 truncate">
                          {(useCustomHomeNas ? homeNasInput.trim() : localBuffer.serverUrl) ||
                            (nativeShell ? 'Noch nicht angegeben' : window.location.origin)}
                        </p>
                      </div>
                    </div>

                    {localBuffer.nasConnection?.host && (
                      <div className="p-2.5 rounded-lg bg-[#121722] border border-slate-800 text-[11px] text-slate-300 font-mono">
                        NAS-Freigabe: {localBuffer.nasConnection.protocol.toUpperCase()} ·{' '}
                        {localBuffer.nasConnection.host}
                        {localBuffer.nasConnection.port ? `:${localBuffer.nasConnection.port}` : ''}{' '}
                        {localBuffer.nasConnection.shareOrPath}
                      </div>
                    )}

                    <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={wizardAutoCheck}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setWizardAutoCheck(next);
                          if (localBuffer) {
                            const updated = { ...localBuffer, autoBackgroundCheck: next };
                            writeLocalOnboardingBuffer(updated);
                            setLocalBuffer(updated);
                          }
                        }}
                        className="accent-amber-400 rounded"
                      />
                      <span>
                        Automatischer Background-Check (prüft alle 8 Sek. und löscht den lokalen Puffer nach erfolgreichem Übertrag automatisch)
                      </span>
                    </label>
                  </div>

                  {wizardStatusMsg && (
                    <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/35 text-xs text-emerald-200 flex items-center gap-2">
                      <RefreshCw className={`w-3.5 h-3.5 ${wizardSyncing ? 'animate-spin' : ''}`} />
                      <span>{wizardStatusMsg}</span>
                    </div>
                  )}

                  {error && (
                    <div
                      role="alert"
                      className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 space-y-2"
                    >
                      <p>{error}</p>
                      {(nativeDiagnosis?.detectedPureNas || nativeDiagnosis?.detectedFritzBox) && (
                          <div className="pt-2 border-t border-red-800/50 space-y-2">
                            <p className="text-[11px] text-amber-200">
                              Erkanntes NAS-Gerät ({nativeDiagnosis.resolvedIp || nativeDiagnosis.host}): Lege über die NAS-Dateistruktur ein EntenCenter-Backend an (Verbindung bleibt aktiv) oder übernimm den Dienst:
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => openProvisionDialogForNas()}
                                className="px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 text-[11px] font-semibold flex items-center gap-1 transition-colors"
                              >
                                <FolderTree className="w-3 h-3" />
                                <span>NAS-Dateistruktur öffnen &amp; Backend anlegen</span>
                              </button>
                              {nativeDiagnosis.openNasServices?.map((svc) => (
                                <button
                                  key={`adopt-wiz-${svc.protocol}-${svc.port}`}
                                  type="button"
                                  onClick={() => handleAdoptDetectedPureNas(nativeDiagnosis, svc)}
                                  className="px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold transition-colors"
                                >
                                  Als {svc.label} (:{svc.port}) übernehmen
                                </button>
                              ))}
                              <button
                                type="button"
                                onClick={() => void runNetworkNasScan()}
                                className="px-2.5 py-1 rounded bg-[#0B0E14] hover:bg-slate-800 border border-emerald-500/45 text-emerald-300 text-[11px] font-medium transition-colors"
                              >
                                Heimnetz nach :3000 scannen
                              </button>
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setWizardStep(2);
                      }}
                      className="px-4 py-2.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200"
                    >
                      Adresse anpassen
                    </button>
                    <button
                      type="button"
                      disabled={portScanBusy}
                      onClick={() => void handleRunPortScan()}
                      className="px-3.5 py-2.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-amber-400/45 text-xs font-medium text-amber-200 flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <Radar className={`w-3.5 h-3.5 ${portScanBusy ? 'animate-spin' : ''}`} />
                      <span>{portScanBusy ? 'Scanne Ports…' : 'Port-Scan (Alt. zu :3000)'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={wizardSyncing}
                      onClick={() => void handleWizardTestAndTransfer(false)}
                      className="flex-1 py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                      <RefreshCw className={`w-4 h-4 ${wizardSyncing ? 'animate-spin' : ''}`} />
                      <span>
                        {wizardSyncing
                          ? 'Teste & übertrage auf NAS…'
                          : 'Verbindung testen & aufs NAS übertragen'}
                      </span>
                    </button>
                  </div>

                  {portScanResult && (
                    <div className="rounded-lg bg-[#0B0E14] border border-slate-800 p-2.5 space-y-1.5 text-[11px]">
                      <p className="text-slate-300">{portScanResult.summary}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {portScanResult.ports
                          .filter((p) => p.isEntenCenter || p.tcpOpen)
                          .map((p) => {
                            const entryUrl = `${p.scheme === 'https' ? 'https' : 'http'}://${portScanResult.hostname}:${p.port}`;
                            return (
                              <button
                                key={`wiz-scan-${p.scheme}-${p.port}`}
                                type="button"
                                onClick={() => void handleAdoptPortUrl(entryUrl, p.port)}
                                className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                                  p.isEntenCenter
                                    ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200 hover:bg-emerald-500/25'
                                    : 'bg-[#121722] border-slate-700 text-amber-200 hover:bg-slate-800'
                                }`}
                              >
                                {p.scheme}:{p.port}{' '}
                                {p.isEntenCenter
                                  ? '✓ EntenCenter übernehmen'
                                  : p.httpStatus
                                    ? `HTTP ${p.httpStatus}`
                                    : 'offen'}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => handleWizardEnterFallbackMode(localBuffer)}
                    className={`w-full py-2.5 px-4 rounded-lg border text-xs font-semibold transition-colors ${
                      isConfirmedStorageBridge(localBuffer)
                        ? 'bg-emerald-400 hover:bg-emerald-300 border-emerald-400 text-slate-950'
                        : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-700 text-amber-300'
                    }`}
                  >
                    {isConfirmedStorageBridge(localBuffer)
                      ? 'Profileinrichtung abschließen & Setup beenden'
                      : 'Ohne Übertragung lokal starten (Background-Sync bleibt aktiv)'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <NasBackendProvisionDialog
        open={provisionDialogOpen}
        target={provisionDialogTarget}
        onClose={() => setProvisionDialogOpen(false)}
        onProvisioned={handleBackendProvisioned}
      />
    </div>
  );
};
