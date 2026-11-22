import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  User,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  HardDrive,
  Save,
  RotateCcw,
  Palette,
  LayoutList,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Sparkles,
  Film,
  Tv,
  PlayCircle,
  Clock,
  Bookmark,
  ChevronDown,
  Camera,
  Trash2,
  Cloud,
  CloudUpload,
  ExternalLink,
  LogOut,
  RefreshCw,
  KeyRound,
  Server,
  Globe,
  Image as ImageIcon,
  Music,
  Video,
  FileText,
  Headphones,
  PlusCircle,
  Mic,
  SlidersHorizontal,
  Pipette,
  LayoutGrid,
  Search,
  SkipBack,
  SkipForward,
  Wifi,
  Radar,
  FolderOpen,
  Upload,
  Sun,
  Moon,
  Contrast,
  MapPin,
  Navigation,
  Sunrise,
  Sunset,
} from 'lucide-react';
import {
  ALL_NAS_PROTOCOLS,
  AudioPlayerMode,
  AutoThemeConfig,
  AutoThemeDayTarget,
  AutoThemeMode,
  AutoThemeNightTarget,
  CustomThemePalette,
  CustomThemeSettings,
  DEFAULT_AUTO_THEME_CONFIG,
  DEFAULT_CUSTOM_THEME_SETTINGS,
  DEFAULT_DESIGN1_CUSTOM_PALETTE,
  DEFAULT_DESIGN2_CUSTOM_PALETTE,
  DEFAULT_USER_PREFERENCES,
  DiscoveredNasDevice,
  DiscoveredNasService,
  HomeRowKey,
  HomeToggleKey,
  NAS_PROTOCOL_CATALOG,
  NasConnectionConfig,
  NasMediaItem,
  NasProtocolId,
  NasStorageStats,
  NasUser,
  ProfileFolderInfo,
  SmartHomeRemoteState,
  SyncMode,
  ThemePresetId,
  UserPreferences,
} from '../types/marcente';
import {
  browseNasDirectoryTree,
  cleanHostOnly,
  discoverAndHydrateBackendFromNasBridge,
  discoverLocalNasDevices,
  fritzBoxDirectLoginWithSession,
  inferMimeTypeFromPath,
  isNativeAndroidShell,
  readAllLocalProvisionedBackends,
  readLocalBridgeCatalog,
  readLocalProvisionedBackendForHost,
  resolvePlayableNasMediaUrl,
  sanitizeNasPortForProtocol,
  saveLocalBridgeCatalog,
  stripEphemeralMediaUrlForCatalog,
  uploadBinaryFileToNasBridge,
  upsertLocalBridgeCatalogItems,
  writeFileToNasBridge,
} from '../lib/nasClient';
import {
  evaluateNasSetupCompleteness,
  isConfirmedStorageBridge,
  isLocalFallbackToken,
  markNasSetupCompleted,
  type NasSetupMissingItem,
  readLocalOnboardingBuffer,
  testAndTransferLocalBufferToNas,
  toNasUserFromBuffer,
  writeLocalOnboardingBuffer,
} from '../lib/localBufferStore';
import {
  estimateCoordinatesFromTimezone,
  evaluateAutoTheme,
  normalizeAutoThemeConfig,
  requestDeviceCoordinates,
} from '../lib/autoTheme';
import { SmartHomeSection } from './SmartHomeSection';
import {
  buildProfileBackupPayload,
  clearInMemoryDriveToken,
  DriveBackupFileInfo,
  findProfileBackupFile,
  getProfileBackupFileName,
  GoogleDriveAuthExpiredError,
  ProfileBackupPayload,
  signInWithGoogleForDrive,
  signOutGoogleForDrive,
  subscribeGoogleAuth,
  uploadProfileBackupFile,
} from '../lib/googleDriveBackup';

async function resizeImageToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Bitte wähle eine gültige Bilddatei (PNG, JPG oder WebP).');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Bilddatei konnte nicht gelesen werden.'));
      image.src = objectUrl;
    });

    const targetSize = 256;
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas-Kontext für Bildkomprimierung nicht verfügbar.');
    }

    // Quadratischer Center-Crop auf 256x256
    const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const sx = Math.max(0, ((img.naturalWidth || img.width) - side) / 2);
    const sy = Math.max(0, ((img.naturalHeight || img.height) - side) / 2);

    ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const decimals = idx >= 4 ? 2 : idx >= 2 ? 1 : 0;
  return `${value.toFixed(decimals).replace('.', ',')} ${units[idx]}`;
}

interface ProfileViewProps {
  user: NasUser;
  token: string;
  preferences: UserPreferences;
  storage: NasStorageStats | null;
  storageLoading: boolean;
  onRefreshStorage: () => void;
  syncMode: SyncMode;
  lastScanTs: string | null;
  scanningNas: boolean;
  onUpdateSyncMode: (nextMode: SyncMode) => Promise<void> | void;
  onRunNasScan: () => Promise<void> | void;
  onProfileUpdated: (newToken: string, updatedUser: NasUser) => void;
  onPreferencesUpdated: (updated: UserPreferences) => void;
  libraryItems?: NasMediaItem[];
  smartHomeState?: SmartHomeRemoteState | null;
  onSmartHomeStateChange?: (next: SmartHomeRemoteState) => void;
}

const THEME_OPTIONS: Array<{
  id: ThemePresetId;
  group: 'design1' | 'design2' | 'daylight';
  name: string;
  description: string;
  bgHex: string;
  surfaceHex: string;
  accentHex: string;
}> = [
  {
    id: 'cinema-amber',
    group: 'design1',
    name: 'Cinema Gold',
    description: 'Kino-Schwarz & warmes Gold',
    bgHex: '#0B0E14',
    surfaceHex: '#121722',
    accentHex: '#FBBF24',
  },
  {
    id: 'nordic-cyan',
    group: 'design1',
    name: 'Nordic Ice',
    description: 'Mitternachtsblau & Polar-Cyan',
    bgHex: '#060D18',
    surfaceHex: '#0F1B2E',
    accentHex: '#38BDF8',
  },
  {
    id: 'emerald-vault',
    group: 'design1',
    name: 'Emerald NAS',
    description: 'Schiefergrün & Smaragd',
    bgHex: '#06100D',
    surfaceHex: '#0E221B',
    accentHex: '#34D399',
  },
  {
    id: 'crimson-premiere',
    group: 'design1',
    name: 'Premiere Crimson',
    description: 'Kino-Anthrazit & Rubin',
    bgHex: '#11090D',
    surfaceHex: '#21131A',
    accentHex: '#FB7185',
  },
  {
    id: 'amethyst-studio',
    group: 'design1',
    name: 'Amethyst Studio',
    description: 'Obsidian & Violett',
    bgHex: '#0B0914',
    surfaceHex: '#171329',
    accentHex: '#A78BFA',
  },
  {
    id: 'silver-glass',
    group: 'design2',
    name: 'Design 2 — Silber Glass',
    description: 'Grau, Silber & Glassy (Frosted Glass)',
    bgHex: '#232832',
    surfaceHex: '#525B6B',
    accentHex: '#E2E8F0',
  },
  {
    id: 'light',
    group: 'daylight',
    name: 'Light Mode (Tageslicht)',
    description: 'Helle Oberflächen & klare Lesbarkeit bei Tag',
    bgHex: '#F1F5F9',
    surfaceHex: '#FFFFFF',
    accentHex: '#D97706',
  },
  {
    id: 'high-contrast',
    group: 'daylight',
    name: 'High Contrast (Hochkontrast)',
    description: 'Reinschwarz, scharfe Konturen & Maximal-Kontrast',
    bgHex: '#000000',
    surfaceHex: '#141414',
    accentHex: '#FACC15',
  },
];

const DESIGN_1_THEMES = THEME_OPTIONS.filter((t) => t.group === 'design1');
const DESIGN_2_THEMES = THEME_OPTIONS.filter((t) => t.group === 'design2');
const DAYLIGHT_THEMES = THEME_OPTIONS.filter((t) => t.group === 'daylight');
const NIGHT_DARK_THEMES = THEME_OPTIONS.filter(
  (t) => t.group === 'design1' || t.group === 'design2'
);

const CUSTOM_COLOR_COMPONENTS: Array<{
  key: keyof CustomThemePalette;
  label: string;
  description: string;
}> = [
  {
    key: 'background',
    label: 'Hintergrund',
    description: 'App-Hintergrund & Eingabefelder',
  },
  {
    key: 'sidebar',
    label: 'Seitenleiste & Header',
    description: 'Navigation & Kopfbereich',
  },
  {
    key: 'surface',
    label: 'Karten & Module',
    description: 'Boxen, Modals & Paneele',
  },
  {
    key: 'accent',
    label: 'Akzent & Buttons',
    description: 'Aktive Elemente, Icons & Fortschritt',
  },
  {
    key: 'text',
    label: 'Textfarbe',
    description: 'Haupttexte & Überschriften',
  },
  {
    key: 'border',
    label: 'Rahmen & Linien',
    description: 'Konturen & Trennlinien',
  },
];

const COMPLETE_COLOR_PALETTE: string[] = [
  '#0B0E14',
  '#121722',
  '#1E2229',
  '#334155',
  '#64748B',
  '#94A3B8',
  '#CBD5E1',
  '#F8FAFC',
  '#EF4444',
  '#FB7185',
  '#F97316',
  '#F59E0B',
  '#FBBF24',
  '#EAB308',
  '#84CC16',
  '#22C55E',
  '#34D399',
  '#14B8A6',
  '#06B6D4',
  '#38BDF8',
  '#3B82F6',
  '#6366F1',
  '#8B5CF6',
  '#EC4899',
];

const HOME_ROW_META: Record<
  HomeRowKey,
  {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  ask_duck: {
    label: 'Frag die Ente',
    description: 'Komplexe KI- & Sprachsuche über das gesamte NAS-Archiv',
    icon: Mic,
  },
  recommendations: {
    label: 'Dein Enten Assistent empfiehlt',
    description: 'KI-Empfehlungen & Spotlight-Slider nach deinem Sehverhalten',
    icon: Sparkles,
  },
  duck_radar: {
    label: 'Enten-Radar',
    description: 'Slider mit Serienstarts, neuen Folgen & Filmstarts',
    icon: Film,
  },
  movie: {
    label: 'Filme',
    description: 'Kino & Dokus direkt vom NAS',
    icon: Film,
  },
  series: {
    label: 'Serien',
    description: 'Serien mit Staffeln & Episoden',
    icon: Tv,
  },
  continue: {
    label: 'Serie fortsetzen',
    description: 'Begonnene Serien mit offenen Folgen',
    icon: PlayCircle,
  },
  recent: {
    label: 'Zuletzt angesehen',
    description: 'Dein aktueller NAS-Wiedergabeverlauf',
    icon: Clock,
  },
  watchlist: {
    label: 'Watchlist',
    description: 'Für später vorgemerkte Filme & Serien',
    icon: Bookmark,
  },
  recently_added: {
    label: 'Zuletzt hinzugefügt',
    description: 'Neu zum NAS-Archiv hinzugefügte Titel & Dateien',
    icon: PlusCircle,
  },
  image: {
    label: 'Bilder',
    description: 'Alle Bilddateien (JPG, PNG, RAW) auf dem NAS',
    icon: ImageIcon,
  },
  music: {
    label: 'Musik',
    description: 'MP3, FLAC & andere Audiodateien auf dem NAS',
    icon: Music,
  },
  video: {
    label: 'Video',
    description: 'Alle Videos außerhalb von Filmen & Serien',
    icon: Video,
  },
  other: {
    label: 'Sonstiges',
    description: 'PDFs, Handbücher, Archive & Dokumente',
    icon: FileText,
  },
};

const NAS_PROTOCOL_OPTIONS = NAS_PROTOCOL_CATALOG;

const DEFAULT_NAS_CONNECTION_FORM: NasConnectionConfig = {
  protocol: 'smb',
  host: '',
  port: '445',
  shareOrPath: '/Medien',
  username: '',
  hasSecret: false,
  domainOrWorkgroup: 'WORKGROUP',
  nfsVersion: 'NFSv4.1',
  nfsAuthMode: 'AUTH_SYS',
  sftpAuthMode: 'password',
  ftpsTlsMode: 'explicit',
  apiVendor: 'Synology DSM',
  useTls: true,
  updatedAt: null,
};

export const ProfileView: React.FC<ProfileViewProps> = ({
  user,
  token,
  preferences,
  storage,
  storageLoading,
  onRefreshStorage,
  syncMode,
  lastScanTs,
  scanningNas,
  onUpdateSyncMode,
  onRunNasScan,
  onProfileUpdated,
  onPreferencesUpdated,
  libraryItems = [],
  smartHomeState = null,
  onSmartHomeStateChange,
}) => {
  const [newUsername, setNewUsername] = useState(user.username);
  const [newDisplayName, setNewDisplayName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsNotice, setPrefsNotice] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<HomeRowKey | null>(null);
  const [dragOverKey, setDragOverKey] = useState<HomeRowKey | null>(null);

  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);

  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [driveAuthBusy, setDriveAuthBusy] = useState(false);
  const [driveChecking, setDriveChecking] = useState(false);
  const [driveSaving, setDriveSaving] = useState(false);
  const [driveExistingFile, setDriveExistingFile] = useState<DriveBackupFileInfo | null>(null);
  const [driveLastSavedFile, setDriveLastSavedFile] = useState<DriveBackupFileInfo | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveNotice, setDriveNotice] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    existingFile: DriveBackupFileInfo;
    payload: ProfileBackupPayload;
  } | null>(null);

  type NasSubSectionKey = 'storage' | 'scan' | 'auth' | 'security';
  const [nasSubOpen, setNasSubOpen] = useState<Record<NasSubSectionKey, boolean>>({
    storage: false,
    scan: false,
    auth: false,
    security: false,
  });
  const toggleNasSub = (key: NasSubSectionKey) => {
    setNasSubOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const [nasConn, setNasConn] = useState<NasConnectionConfig>(DEFAULT_NAS_CONNECTION_FORM);
  const [allowedNasProtocols, setAllowedNasProtocols] = useState<NasProtocolId[]>([
    ...ALL_NAS_PROTOCOLS,
  ]);
  const [nasConnSecret, setNasConnSecret] = useState('');
  const [showNasConnSecret, setShowNasConnSecret] = useState(false);
  const [nasFritzExtraSecret, setNasFritzExtraSecret] = useState('');
  const [showNasFritzExtraSecret, setShowNasFritzExtraSecret] = useState(false);
  const [showExtraFritzField, setShowExtraFritzField] = useState(false);
  const [nasConnLoading, setNasConnLoading] = useState(false);
  const [nasConnSaving, setNasConnSaving] = useState(false);
  const [nasConnTesting, setNasConnTesting] = useState(false);
  const [nasConnError, setNasConnError] = useState<string | null>(null);
  const [nasConnNotice, setNasConnNotice] = useState<string | null>(null);
  const [nasDiscoveryScanning, setNasDiscoveryScanning] = useState(false);
  const [nasDiscoveryDevices, setNasDiscoveryDevices] = useState<DiscoveredNasDevice[]>([]);
  const [nasDiscoverySummary, setNasDiscoverySummary] = useState<string | null>(null);
  const [profileFolder, setProfileFolder] = useState<ProfileFolderInfo | null>(null);
  const [profileFolderLoading, setProfileFolderLoading] = useState(false);
  const [profileFolderError, setProfileFolderError] = useState<string | null>(null);
  const [profileFolderNotice, setProfileFolderNotice] = useState<string | null>(null);
  const nasQuickUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [nasQuickUploadBusy, setNasQuickUploadBusy] = useState(false);
  const [nasQuickUploadError, setNasQuickUploadError] = useState<string | null>(null);
  const [nasQuickUploadNotice, setNasQuickUploadNotice] = useState<string | null>(null);
  const [profileSetupDone, setProfileSetupDone] = useState<boolean>(() =>
    Boolean(readLocalOnboardingBuffer()?.setupCompleted)
  );
  const [profileSetupBusy, setProfileSetupBusy] = useState(false);
  const [profileSetupMissing, setProfileSetupMissing] = useState<NasSetupMissingItem[]>([]);
  const [profileSetupNotice, setProfileSetupNotice] = useState<string | null>(null);
  const [profileSetupError, setProfileSetupError] = useState<string | null>(null);
  const [missingHostInput, setMissingHostInput] = useState<string>(
    () => readLocalOnboardingBuffer()?.nasConnection?.host || ''
  );
  const [missingUserInput, setMissingUserInput] = useState<string>(
    () => readLocalOnboardingBuffer()?.nasConnection?.username || ''
  );
  const [missingPassInput, setMissingPassInput] = useState<string>(
    () =>
      readLocalOnboardingBuffer()?.nasConnection?.fritzPassword ||
      readLocalOnboardingBuffer()?.nasConnection?.secret ||
      ''
  );
  const [missingDisplayInput, setMissingDisplayInput] = useState<string>(
    () => user.displayName || user.username
  );

  const [duckAssistantMenuOpen, setDuckAssistantMenuOpen] = useState(true);
  const [openCustomPicker, setOpenCustomPicker] = useState<{
    design1: boolean;
    design2: boolean;
  }>({
    design1: preferences.customTheme?.activeFor === 'design1',
    design2: preferences.customTheme?.activeFor === 'design2',
  });
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});
  const customSaveTimerRef = useRef<number | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoNotice, setGeoNotice] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (customSaveTimerRef.current !== null) {
        window.clearTimeout(customSaveTimerRef.current);
      }
    };
  }, []);

  type ProfileSectionKey =
    | 'settings'
    | 'credentials'
    | 'theme'
    | 'homeOrder'
    | 'entenPlayer'
    | 'audio'
    | 'smartHome'
    | 'driveBackup'
    | 'nasSettings';
  const [openSections, setOpenSections] = useState<Record<ProfileSectionKey, boolean>>({
    settings: false,
    credentials: false,
    theme: false,
    homeOrder: false,
    entenPlayer: false,
    audio: false,
    smartHome: false,
    driveBackup: false,
    nasSettings: false,
  });

  const toggleSection = (key: ProfileSectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const allExpanded = Object.values(openSections).every(Boolean);
  const toggleAllSections = () => {
    const nextState = !allExpanded;
    setOpenSections({
      settings: nextState,
      credentials: nextState,
      theme: nextState,
      homeOrder: nextState,
      entenPlayer: nextState,
      audio: nextState,
      smartHome: nextState,
      driveBackup: nextState,
      nasSettings: nextState,
    });
    setNasSubOpen({
      storage: nextState,
      scan: nextState,
      auth: nextState,
      security: nextState,
    });
  };

  const loadNasConnection = useCallback(async () => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const bufConn = readLocalOnboardingBuffer()?.nasConnection;
      if (bufConn) {
        setNasConn({
          protocol: bufConn.protocol,
          host: bufConn.host,
          port: bufConn.port,
          shareOrPath: bufConn.shareOrPath,
          username: bufConn.username,
          hasSecret: Boolean(bufConn.secret),
          domainOrWorkgroup: bufConn.domainOrWorkgroup,
          nfsVersion: bufConn.nfsVersion,
          nfsAuthMode: bufConn.nfsAuthMode,
          sftpAuthMode: bufConn.sftpAuthMode,
          ftpsTlsMode: bufConn.ftpsTlsMode,
          apiVendor: bufConn.apiVendor,
          useTls: bufConn.useTls,
          backendPath: bufConn.backendPath,
          backendProvisioned: bufConn.backendProvisioned,
          storageBridgeMode: bufConn.storageBridgeMode,
          hasFritzSecret: Boolean(bufConn.fritzPassword),
          fritzSidVerifiedAt: bufConn.fritzSidVerifiedAt ?? null,
          updatedAt: null,
        });
        if (bufConn.secret) setNasConnSecret(bufConn.secret);
        if (bufConn.fritzPassword) {
          setNasFritzExtraSecret(bufConn.fritzPassword);
          setShowExtraFritzField(true);
        }
      }
      return;
    }
    setNasConnLoading(true);
    try {
      const res = await fetch('/api/nas/connection', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          connection: NasConnectionConfig;
          allowedProtocols?: NasProtocolId[];
        };
        const allowedList =
          Array.isArray(data.allowedProtocols) && data.allowedProtocols.length > 0
            ? data.allowedProtocols
            : [...ALL_NAS_PROTOCOLS];
        setAllowedNasProtocols(allowedList);
        if (data.connection) {
          if (!data.connection.host && !allowedList.includes(data.connection.protocol)) {
            const firstMeta = NAS_PROTOCOL_OPTIONS.find((p) => p.id === allowedList[0]);
            setNasConn({
              ...data.connection,
              protocol: allowedList[0],
              port: firstMeta?.defaultPort ?? data.connection.port,
              shareOrPath: firstMeta?.defaultPath ?? data.connection.shareOrPath,
            });
          } else {
            setNasConn(data.connection);
          }
        }
      }
    } catch {
      // Netzwerkfehler beim Laden still tolerieren
    } finally {
      setNasConnLoading(false);
    }
  }, [token]);

  const resolveProfileBridgeContext = useCallback(() => {
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
    const target =
      host && pass
        ? {
            protocol,
            host,
            port,
            shareOrPath: protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn?.shareOrPath || '/',
            username: (conn?.username || '').trim(),
            password: pass,
            secret: pass,
            fritzPassword: pass,
            domainOrWorkgroup: conn?.domainOrWorkgroup,
            useTls,
          }
        : null;
    return { buf, backendRoot, target };
  }, []);

  const loadProfileFolder = useCallback(async () => {
    if (!token) return;
    if (isLocalFallbackToken(token)) {
      const { buf, backendRoot, target } = resolveProfileBridgeContext();
      const profileDir = `${backendRoot}/profiles`;
      if (!target) {
        setProfileFolder({
          username: user.username,
          nasMountPath: profileDir,
          diskPath: `${profileDir}/${user.username}.json`,
          subfolders: ['config', 'profiles', 'library', 'media', 'wal'],
          exists: Boolean(buf?.nasSyncedAt || buf?.syncedBackendPath),
          writable: Boolean(isConfirmedStorageBridge(buf)),
          createdNow: false,
          createdAt: buf?.createdAt ?? null,
          updatedAt: buf?.nasSyncedAt ?? buf?.updatedAt ?? null,
        });
        setProfileFolderError(null);
        setProfileFolderLoading(false);
        return;
      }
      setProfileFolderLoading(true);
      setProfileFolderError(null);
      try {
        const tree = await browseNasDirectoryTree({
          ...target,
          path: backendRoot,
        });
        const names = new Set((tree.entries ?? []).map((e) => e.name.toLowerCase()));
        setProfileFolder({
          username: user.username,
          nasMountPath: profileDir,
          diskPath: `${profileDir}/${user.username}.json`,
          subfolders: Array.from(names),
          exists: Boolean(tree.ok && (names.has('profiles') || buf?.nasSyncedAt)),
          writable: Boolean(tree.ok),
          createdNow: false,
          createdAt: buf?.createdAt ?? null,
          updatedAt: buf?.nasSyncedAt ?? new Date().toISOString(),
        });
      } catch {
        setProfileFolderError(null);
      } finally {
        setProfileFolderLoading(false);
      }
      return;
    }
    setProfileFolderLoading(true);
    setProfileFolderError(null);
    try {
      const res = await fetch('/api/nas/profile-folder', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { folder?: ProfileFolderInfo; error?: string };
      if (!res.ok || !data.folder) {
        setProfileFolderError(data.error || 'Profilordner auf dem NAS konnte nicht geladen werden.');
        return;
      }
      setProfileFolder(data.folder);
    } catch {
      setProfileFolderError('NAS-Profilordner konnte nicht abgefragt werden.');
    } finally {
      setProfileFolderLoading(false);
    }
  }, [resolveProfileBridgeContext, token, user.username]);

  const handleEnsureProfileFolder = async () => {
    if (!token) return;
    setProfileFolderLoading(true);
    setProfileFolderError(null);
    setProfileFolderNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const { backendRoot, target } = resolveProfileBridgeContext();
        if (!target) {
          setProfileFolderError(
            'Kein aktives NAS-Storage-Bridge-Ziel gefunden. Bitte prüfe die NAS-Zugangsdaten.'
          );
          return;
        }
        const profilePayload = {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          fskLimit: user.fskLimit ?? 18,
          avatarUrl: user.avatarUrl ?? null,
          preferences,
          updatedAt: new Date().toISOString(),
        };
        const writeRes = await writeFileToNasBridge({
          ...target,
          targetPath: `${backendRoot}/profiles/${user.username}.json`,
          content: JSON.stringify(profilePayload, null, 2),
          contentType: 'application/json; charset=utf-8',
        });
        if (!writeRes.ok) {
          setProfileFolderError(
            writeRes.error || 'Profildaten konnten nicht in der Storage-Bridge geschrieben werden.'
          );
          return;
        }
        const folderInfo: ProfileFolderInfo = {
          username: user.username,
          nasMountPath: `${backendRoot}/profiles`,
          diskPath: `${backendRoot}/profiles/${user.username}.json`,
          subfolders: ['config', 'profiles', 'library', 'media', 'wal'],
          exists: true,
          writable: true,
          createdNow: false,
          createdAt: user.createdAt ?? null,
          updatedAt: new Date().toISOString(),
        };
        setProfileFolder(folderInfo);
        setProfileFolderNotice(
          `Profilverzeichnis „${folderInfo.nasMountPath}“ über Storage-Bridge geprüft & synchronisiert.`
        );
        return;
      }
      const res = await fetch('/api/nas/profile-folder/ensure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { folder?: ProfileFolderInfo; error?: string };
      if (!res.ok || !data.folder) {
        setProfileFolderError(data.error || 'Profilordner konnte nicht erstellt werden.');
        return;
      }
      setProfileFolder(data.folder);
      setProfileFolderNotice(
        data.folder.createdNow
          ? `Profilordner „${data.folder.nasMountPath}“ wurde neu auf dem NAS angelegt.`
          : `Profilordner „${data.folder.nasMountPath}“ geprüft und Profildaten synchronisiert.`
      );
    } catch {
      setProfileFolderError('Profilordner auf dem NAS konnte nicht synchronisiert werden.');
    } finally {
      setProfileFolderLoading(false);
    }
  };

  const handleFinishProfileSetupManually = async (forceIgnoreMissing = false) => {
    if (!isLocalFallbackToken(token) || profileSetupBusy) return;
    setProfileSetupBusy(true);
    setProfileSetupError(null);
    setProfileSetupNotice(null);
    try {
      const current = readLocalOnboardingBuffer();
      const { backendRoot, target } = resolveProfileBridgeContext();
      const effectiveHost =
        cleanHostOnly(missingHostInput) ||
        cleanHostOnly(target?.host) ||
        cleanHostOnly(current?.nasConnection?.host) ||
        cleanHostOnly(current?.serverUrl);
      const effectiveUser = (
        missingUserInput ||
        target?.username ||
        current?.nasConnection?.username ||
        ''
      ).trim();
      const effectivePass =
        missingPassInput ||
        target?.fritzPassword ||
        target?.password ||
        current?.nasConnection?.fritzPassword ||
        current?.nasConnection?.secret ||
        '';
      const effectiveDisplay = (missingDisplayInput || user.displayName || user.username).trim();

      let connectionOnline = false;
      let remoteBackendVerified = Boolean(
        profileFolder?.exists ||
          current?.nasSyncedAt ||
          current?.syncedBackendPath ||
          current?.nasConnection?.backendProvisioned
      );
      let resolvedBackend = backendRoot;

      if (current && effectiveHost && effectivePass && !forceIgnoreMissing) {
        const patched = {
          ...current,
          user: {
            ...current.user,
            displayName: effectiveDisplay || current.user.username,
          },
          nasConnection: current.nasConnection
            ? {
                ...current.nasConnection,
                host: effectiveHost,
                username: effectiveUser,
                secret: effectivePass,
                fritzUsername: effectiveUser,
                fritzPassword: effectivePass,
              }
            : {
                protocol: 'fritz_upnp' as const,
                host: effectiveHost,
                port: '80',
                shareOrPath: 'FRITZ.NAS',
                username: effectiveUser,
                secret: effectivePass,
                fritzUsername: effectiveUser,
                fritzPassword: effectivePass,
                useTls: false,
                storageBridgeMode: true,
              },
        };
        const discovered = await discoverAndHydrateBackendFromNasBridge({
          target: {
            protocol: patched.nasConnection.protocol,
            host: effectiveHost,
            port: String(
              sanitizeNasPortForProtocol(
                patched.nasConnection.protocol,
                patched.nasConnection.port || '80',
                Boolean(patched.nasConnection.useTls)
              )
            ),
            shareOrPath:
              patched.nasConnection.protocol === 'fritz_upnp'
                ? 'FRITZ.NAS'
                : patched.nasConnection.shareOrPath || '/',
            username: effectiveUser,
            password: effectivePass,
            secret: effectivePass,
            fritzPassword: effectivePass,
            useTls: Boolean(patched.nasConnection.useTls),
          },
          username: user.username,
          preferredBackendPath: backendRoot,
        }).catch(() => null);

        if (discovered?.found) {
          connectionOnline = true;
          remoteBackendVerified = Boolean(
            discovered.hasProfile || discovered.hasManifest || discovered.hasConfig
          );
          resolvedBackend = discovered.backendPath || backendRoot;
        }

        if (!remoteBackendVerified) {
          const transfer = await testAndTransferLocalBufferToNas({
            buffer: patched,
            overrideServerUrl: patched.serverUrl || effectiveHost,
            overrideFritzCreds: {
              username: effectiveUser || undefined,
              password: effectivePass,
            },
          }).catch(() => null);
          if (transfer?.ok) {
            connectionOnline = true;
            remoteBackendVerified = Boolean(transfer.remoteWriteVerified);
            if (transfer.syncedBackendPath) {
              resolvedBackend = transfer.syncedBackendPath;
            }
          }
        }
      }

      const completeness = evaluateNasSetupCompleteness({
        buffer: current,
        overrideHost: effectiveHost,
        overrideUsername: effectiveUser,
        overridePassword: effectivePass,
        overrideDisplayName: effectiveDisplay,
        overrideBackendPath: resolvedBackend,
        connectionOnline,
        remoteBackendVerified,
      });

      if (!completeness.complete && !forceIgnoreMissing) {
        setProfileSetupMissing(completeness.missing);
        setProfileSetupError(
          `Für den Abschluss fehlen noch ${completeness.missing.length} Angabe(n). Bitte unten ergänzen.`
        );
        return;
      }

      const done = await markNasSetupCompleted({
        buffer: current,
        backendPath: completeness.resolvedBackendPath || resolvedBackend,
        host: completeness.resolvedHost || effectiveHost,
        username: effectiveUser,
        password: effectivePass,
        displayName: effectiveDisplay,
        autoCompleted: false,
      });
      setProfileSetupDone(true);
      setProfileSetupMissing([]);
      if (done.buffer) {
        onProfileUpdated(done.buffer.localToken, toNasUserFromBuffer(done.buffer));
      }
      setProfileSetupNotice(
        `Profileinrichtung abgeschlossen & Bridge-Modus beendet (${completeness.resolvedHost || effectiveHost} · ${completeness.resolvedBackendPath || resolvedBackend}).`
      );
      void loadProfileFolder();
    } finally {
      setProfileSetupBusy(false);
    }
  };

  const handleQuickNasFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !token) return;
    setNasQuickUploadBusy(true);
    setNasQuickUploadError(null);
    setNasQuickUploadNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const { backendRoot, target } = resolveProfileBridgeContext();
        if (!target) {
          setNasQuickUploadError(
            'Kein Storage-Bridge-Ziel konfiguriert. Bitte zuerst mit FRITZ!NAS / SMB verbinden.'
          );
          return;
        }
        const remotePath = `${backendRoot}/media/${file.name}`;
        const upRes = await uploadBinaryFileToNasBridge({
          target,
          targetPath: remotePath,
          file,
        });
        if (!upRes.ok) {
          setNasQuickUploadError(upRes.error || 'Datei konnte nicht auf das NAS übertragen werden.');
          return;
        }
        const mime = file.type || inferMimeTypeFromPath(file.name);
        const inferredKind = mime.startsWith('image/')
          ? 'image'
          : mime.startsWith('audio/')
            ? 'music'
            : mime.startsWith('video/')
              ? 'movie'
              : 'other';
        const baseItem: NasMediaItem = {
          id: `nas-quick-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tmdbId: Math.floor(100000 + Math.random() * 800000),
          title: file.name.replace(/\.[^.]+$/, '') || file.name,
          kind: inferredKind,
          genre: inferredKind === 'movie' ? 'Film' : inferredKind === 'music' ? 'Musik' : 'Medien',
          year: new Date().getFullYear(),
          coverUrl: '',
          synopsis: `Über Profil-Schnellupload in „${remotePath}“ auf dem NAS gespeichert.`,
          codec: mime.split('/')[1]?.toUpperCase() || 'FILE',
          audioTracks: inferredKind === 'image' || inferredKind === 'other' ? [] : ['Deutsch'],
          subtitles: [],
          totalDurationMinutes: inferredKind === 'movie' ? 90 : 5,
          watchedMinutes: 0,
          episodesWatchedCount: 0,
          lastWatchedAt: null,
          addedAt: new Date().toISOString(),
          nasPath: remotePath,
          fileFormat: file.name.split('.').pop()?.toUpperCase() || 'FILE',
          fileSize: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          uploadedFileName: file.name,
          uploadedMimeType: mime,
          uploadedByteSize: file.size,
        };
        const cleanCatalog = stripEphemeralMediaUrlForCatalog(
          upsertLocalBridgeCatalogItems([
            ...readLocalBridgeCatalog(),
            {
              ...baseItem,
              mediaUrl: resolvePlayableNasMediaUrl(baseItem, target, token) ?? undefined,
            },
          ])
        );
        saveLocalBridgeCatalog(cleanCatalog);
        await writeFileToNasBridge({
          ...target,
          targetPath: `${backendRoot}/config/catalog.json`,
          content: JSON.stringify(cleanCatalog, null, 2),
          contentType: 'application/json; charset=utf-8',
        }).catch(() => null);
        setNasQuickUploadNotice(
          `„${file.name}“ über Storage-Bridge direkt auf dem NAS gespeichert (${remotePath}).`
        );
        onRefreshStorage();
        return;
      }
      const res = await fetch('/api/nas/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'X-Nas-Filename': encodeURIComponent(file.name),
          'X-Nas-Mime': encodeURIComponent(file.type || 'application/octet-stream'),
          'X-Nas-Title': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')),
        },
        body: file,
      });
      const data = (await res.json()) as { item?: { title?: string; nasPath?: string }; error?: string };
      if (!res.ok || !data.item) {
        setNasQuickUploadError(data.error || 'Datei konnte nicht auf das NAS geschrieben werden.');
        return;
      }
      setNasQuickUploadNotice(
        `„${data.item.title || file.name}“ erfolgreich auf das NAS geschrieben (${data.item.nasPath || '/uploads'}).`
      );
      onRefreshStorage();
    } catch {
      setNasQuickUploadError('Verbindung zum NAS beim Schreibvorgang fehlgeschlagen.');
    } finally {
      setNasQuickUploadBusy(false);
    }
  };

  useEffect(() => {
    void loadNasConnection();
    void loadProfileFolder();
  }, [loadNasConnection, loadProfileFolder]);

  const visibleNasProtocolOptions = NAS_PROTOCOL_OPTIONS.filter((p) =>
    allowedNasProtocols.includes(p.id)
  );

  const handleSelectNasProtocol = (nextProtocol: NasProtocolId) => {
    const prevMeta = NAS_PROTOCOL_OPTIONS.find((p) => p.id === nasConn.protocol);
    const nextMeta = NAS_PROTOCOL_OPTIONS.find((p) => p.id === nextProtocol);
    if (!nextMeta) return;
    setNasConnError(null);
    setNasConnNotice(null);
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
          nextProtocol === 'fritz_upnp' ||
          !prev.port ||
          (prevMeta && prev.port === prevMeta.defaultPort)
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

  const handleSaveNasConnection = async (
    e: React.FormEvent,
    clearSecret = false
  ) => {
    e.preventDefault();
    setNasConnError(null);
    setNasConnNotice(null);
    const isFritzUpnp = nasConn.protocol === 'fritz_upnp';
    const effectiveHost = nasConn.host.trim() || (isFritzUpnp ? 'fritz.box' : '');
    if (!effectiveHost) {
      setNasConnError('Bitte gib eine NAS-IP-Adresse, einen Hostnamen oder eine Server-URL ein.');
      return;
    }

    if (isLocalFallbackToken(token)) {
      const currentBuf = readLocalOnboardingBuffer();
      if (currentBuf) {
        const nextSecret = clearSecret ? '' : nasConnSecret;
        const nextFritzExtra = clearSecret ? '' : nasFritzExtraSecret;
        const backendRoot = (nasConn.backendPath || currentBuf.nasConnection?.backendPath || '/FRITZ/EntenCenter-Backend').replace(/\/+$/, '');
        const safePort = String(
          sanitizeNasPortForProtocol(
            nasConn.protocol,
            nasConn.port.trim() || (isFritzUpnp ? (nasConn.useTls ? '443' : '80') : '445'),
            Boolean(nasConn.useTls)
          )
        );
        const nextConnPayload = {
          protocol: nasConn.protocol,
          host: effectiveHost,
          port: safePort,
          shareOrPath: nasConn.shareOrPath.trim() || (isFritzUpnp ? '/FRITZ' : '/Medien'),
          username: nasConn.username.trim(),
          secret: nextSecret,
          fritzPassword: nextFritzExtra || undefined,
          domainOrWorkgroup: nasConn.domainOrWorkgroup,
          nfsVersion: nasConn.nfsVersion,
          nfsAuthMode: nasConn.nfsAuthMode,
          sftpAuthMode: nasConn.sftpAuthMode,
          ftpsTlsMode: nasConn.ftpsTlsMode,
          apiVendor: nasConn.apiVendor,
          useTls: nasConn.protocol === 'smb' ? false : Boolean(nasConn.useTls),
          backendPath: backendRoot,
          backendProvisioned: nasConn.backendProvisioned ?? true,
          storageBridgeMode: true,
        };
        writeLocalOnboardingBuffer({
          ...currentBuf,
          nasConnection: nextConnPayload,
          updatedAt: new Date().toISOString(),
        });
        setNasConn((prev) => ({
          ...prev,
          host: effectiveHost,
          hasSecret: Boolean(nextSecret),
          hasFritzSecret: Boolean(nextFritzExtra),
          updatedAt: new Date().toISOString(),
        }));
        const effectivePass = nextFritzExtra || nextSecret;
        if (!clearSecret && effectivePass) {
          setNasConnSaving(true);
          try {
            const writeRes = await writeFileToNasBridge({
              protocol: nextConnPayload.protocol,
              host: effectiveHost,
              port: nextConnPayload.port,
              shareOrPath: nextConnPayload.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : nextConnPayload.shareOrPath,
              username: nextConnPayload.username,
              password: effectivePass,
              fritzPassword: effectivePass,
              useTls: nextConnPayload.useTls,
              targetPath: `${backendRoot}/config/nas-connection.json`,
              content: JSON.stringify(
                {
                  ...nextConnPayload,
                  secret: undefined,
                  fritzPassword: undefined,
                  updatedAt: new Date().toISOString(),
                },
                null,
                2
              ),
              contentType: 'application/json; charset=utf-8',
            });
            if (writeRes.ok) {
              setNasConnNotice(
                `NAS- & FRITZ!Box-Konfiguration direkt auf ${effectiveHost} (${writeRes.filePath}) und in der Storage-Bridge gespeichert.`
              );
            } else {
              setNasConnError(
                writeRes.error || 'Zugangsdaten lokal gepuffert, aber direktes Schreiben auf das NAS fehlgeschlagen.'
              );
            }
          } finally {
            setNasConnSaving(false);
          }
          return;
        }
        setNasConnNotice(
          clearSecret
            ? 'Gespeicherte NAS-/FRITZ!Box-Passwörter wurden aus dem Puffer entfernt.'
            : 'NAS- & FRITZ!Box-Zugangsdaten wurden lokal in der Storage-Bridge gespeichert.'
        );
        return;
      }
    }

    setNasConnSaving(true);
    try {
      const res = await fetch('/api/nas/connection', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          protocol: nasConn.protocol,
          host: effectiveHost,
          port: nasConn.port.trim() || (isFritzUpnp ? '49000' : ''),
          shareOrPath: nasConn.shareOrPath.trim() || (isFritzUpnp ? '/MediaServer' : '/'),
          username: nasConn.username.trim(),
          secret: clearSecret ? undefined : nasConnSecret,
          clearSecret,
          fritzPassword:
            clearSecret
              ? undefined
              : !isFritzUpnp && nasFritzExtraSecret
                ? nasFritzExtraSecret
                : undefined,
          domainOrWorkgroup: nasConn.domainOrWorkgroup,
          nfsVersion: nasConn.nfsVersion,
          nfsAuthMode: nasConn.nfsAuthMode,
          sftpAuthMode: nasConn.sftpAuthMode,
          ftpsTlsMode: nasConn.ftpsTlsMode,
          apiVendor: nasConn.apiVendor,
          useTls: Boolean(nasConn.useTls),
        }),
      });
      const data = (await res.json()) as {
        connection?: NasConnectionConfig;
        allowedProtocols?: NasProtocolId[];
        error?: string;
      };
      if (!res.ok || !data.connection) {
        setNasConnError(data.error || 'NAS-Anmeldedaten konnten nicht gespeichert werden.');
        return;
      }
      if (Array.isArray(data.allowedProtocols) && data.allowedProtocols.length > 0) {
        setAllowedNasProtocols(data.allowedProtocols);
      }
      setNasConn(data.connection);
      setNasConnSecret('');
      setNasFritzExtraSecret('');
      setNasConnNotice(
        clearSecret
          ? 'Gespeichertes NAS-Passwort/Token wurde entfernt.'
          : 'NAS- & FRITZ!Box-Anmeldedaten wurden verschlüsselt im NAS-Vault gespeichert.'
      );
    } catch {
      setNasConnError('Verbindung zum NAS-Server fehlgeschlagen.');
    } finally {
      setNasConnSaving(false);
    }
  };

  const handleTestNasConnection = async () => {
    setNasConnError(null);
    setNasConnNotice(null);
    setNasConnTesting(true);
    const isFritzUpnp = nasConn.protocol === 'fritz_upnp';
    const effectiveHost = nasConn.host.trim() || (isFritzUpnp ? 'fritz.box' : '');
    try {
      // Im lokalen Storage-Bridge-Modus (Android APK ohne :3000) direkt gegen die FRITZ!Box testen
      if (
        isLocalFallbackToken(token) ||
        (isNativeAndroidShell() && (isFritzUpnp || Boolean(nasFritzExtraSecret.trim())))
      ) {
        const directRes = await fritzBoxDirectLoginWithSession({
          host: effectiveHost,
          port: String(
            sanitizeNasPortForProtocol(
              'fritz_upnp',
              nasConn.port.trim() || (nasConn.useTls ? '443' : '80'),
              Boolean(nasConn.useTls)
            )
          ),
          useTls: Boolean(nasConn.useTls),
          username: nasConn.username.trim(),
          password: isFritzUpnp ? nasConnSecret : nasFritzExtraSecret || nasConnSecret,
          allowLocalSelfSignedTls: true,
          forceRefresh: true,
          verifyBrowseTree: true,
        });
        if (directRes.ok) {
          const folderCount = directRes.browseTree?.entries?.length ?? 0;
          setNasConnNotice(
            `FRITZ!Box Challenge-Response Login OK (SID ${directRes.sidPreview || 'aktiv'} · ${
              directRes.httpsFallbackToHttp
                ? 'HTTP-Fallback :80'
                : `${(directRes.effectiveScheme || 'http').toUpperCase()}:${directRes.effectivePort || 80}`
            }${folderCount > 0 ? ` · ${folderCount} NAS-Ordner erreichbar` : ''}).`
          );
          if (isLocalFallbackToken(token)) return;
        } else if (isLocalFallbackToken(token)) {
          setNasConnError(
            directRes.requiresAuth && !(isFritzUpnp ? nasConnSecret : nasFritzExtraSecret || nasConnSecret)
              ? 'Bitte gib das Feld „Passwort für die FRITZ!Box“ ein, bevor auf FRITZ!NAS zugegriffen wird.'
              : directRes.error || 'FRITZ!Box-Verbindungsprüfung fehlgeschlagen.'
          );
          return;
        }
      }

      const res = await fetch('/api/nas/connection/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          protocol: nasConn.protocol,
          host: effectiveHost,
          port: String(
            sanitizeNasPortForProtocol(
              nasConn.protocol,
              nasConn.port.trim() || (isFritzUpnp ? '49000' : ''),
              Boolean(nasConn.useTls)
            )
          ),
          username: nasConn.username.trim(),
          secret: nasConnSecret,
          fritzPassword: !isFritzUpnp && nasFritzExtraSecret ? nasFritzExtraSecret : undefined,
          nfsAuthMode: nasConn.nfsAuthMode,
          ftpsTlsMode: nasConn.ftpsTlsMode,
          useTls: Boolean(nasConn.useTls),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        latencyMs?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setNasConnError(data.error || 'Verbindungsprüfung fehlgeschlagen.');
        return;
      }
      setNasConnNotice(
        `${data.message ?? 'Verbindung erfolgreich geprüft.'}${
          data.latencyMs ? ` (${data.latencyMs} ms)` : ''
        }`
      );
    } catch {
      setNasConnError('NAS-Verbindungstest konnte nicht durchgeführt werden.');
    } finally {
      setNasConnTesting(false);
    }
  };

  const handleRunNasNetworkDiscovery = async () => {
    setNasDiscoveryScanning(true);
    setNasDiscoverySummary(null);
    setNasConnError(null);
    try {
      const result = await discoverLocalNasDevices({ includeSubnetProbe: true });
      setNasDiscoveryDevices(result.devices);
      setNasDiscoverySummary(result.summary);
    } catch {
      setNasDiscoverySummary('Netzwerk-Discovery (mDNS/Bonjour) fehlgeschlagen.');
    } finally {
      setNasDiscoveryScanning(false);
    }
  };

  const applyDiscoveredNasToForm = (
    device: DiscoveredNasDevice,
    chosenService?: DiscoveredNasService
  ) => {
    const svc =
      chosenService ??
      device.services.find((s) => s.protocol !== 'entencenter') ??
      device.services[0];
    let nextProtocol: NasProtocolId =
      svc && svc.protocol !== 'entencenter' ? svc.protocol : device.suggestedProtocol;
    if (!allowedNasProtocols.includes(nextProtocol) && allowedNasProtocols.length > 0) {
      nextProtocol = allowedNasProtocols[0];
    }
    const meta = NAS_PROTOCOL_CATALOG.find((p) => p.id === nextProtocol);
    const vendorMap: Record<DiscoveredNasDevice['vendor'], NasConnectionConfig['apiVendor']> = {
      EntenCenter: 'Synology DSM',
      Synology: 'Synology DSM',
      QNAP: 'QNAP QTS',
      TrueNAS: 'TrueNAS Scale',
      Unraid: 'Unraid',
      OpenMediaVault: 'OpenMediaVault',
      'Western Digital': 'Western Digital',
      'FRITZ!Box': 'Synology DSM',
      'Standard NAS': 'Synology DSM',
    };

    setNasConn((prev) => ({
      ...prev,
      protocol: nextProtocol,
      host: device.ip || device.hostname,
      port: svc?.port || meta?.defaultPort || device.port || '',
      shareOrPath: svc?.path || device.suggestedShareOrPath || meta?.defaultPath || '/Medien',
      useTls:
        nextProtocol === 'fritz_upnp'
          ? false
          : svc?.scheme
            ? svc.scheme === 'https'
            : prev.useTls,
      apiVendor: vendorMap[device.vendor] ?? prev.apiVendor,
    }));
    setNasConnNotice(
      `Erkanntes NAS "${device.name}" (${device.ip}:${svc?.port || device.port || meta?.defaultPort || '445'}) in das Formular übernommen.`
    );
  };

  useEffect(() => {
    setNewUsername(user.username);
    setNewDisplayName(user.displayName);
  }, [user.username, user.displayName]);

  useEffect(() => {
    return subscribeGoogleAuth((fbUser, inMemoryToken) => {
      setGoogleUser(fbUser);
      setGoogleAccessToken(inMemoryToken);
      if (!inMemoryToken) {
        setDriveExistingFile(null);
      }
    });
  }, []);

  const refreshDriveFileStatus = useCallback(
    async (accessToken: string) => {
      setDriveChecking(true);
      setDriveError(null);
      try {
        const found = await findProfileBackupFile(accessToken, user.username);
        setDriveExistingFile(found);
      } catch (err) {
        if (err instanceof GoogleDriveAuthExpiredError) {
          setGoogleAccessToken(null);
          setDriveExistingFile(null);
          setDriveError(err.message);
        } else {
          setDriveError(
            err instanceof Error
              ? err.message
              : 'Status auf Google Drive konnte nicht geprüft werden.'
          );
        }
      } finally {
        setDriveChecking(false);
      }
    },
    [user.username]
  );

  useEffect(() => {
    if (googleAccessToken) {
      void refreshDriveFileStatus(googleAccessToken);
    }
  }, [googleAccessToken, refreshDriveFileStatus]);

  const handleAvatarFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);
    try {
      const compressedDataUrl = await resizeImageToAvatarDataUrl(file);
      if (isLocalFallbackToken(token)) {
        const updatedUser: NasUser = { ...user, avatarUrl: compressedDataUrl };
        const { buf, backendRoot, target } = resolveProfileBridgeContext();
        if (buf) {
          writeLocalOnboardingBuffer({
            ...buf,
            user: {
              ...buf.user,
              ...updatedUser,
              role: 'admin',
              password: buf.user.password,
            },
            updatedAt: new Date().toISOString(),
          });
        }
        if (target) {
          await writeFileToNasBridge({
            ...target,
            targetPath: `${backendRoot}/profiles/${updatedUser.username}.json`,
            content: JSON.stringify(
              { ...updatedUser, updatedAt: new Date().toISOString() },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        onProfileUpdated(token, updatedUser);
        setAvatarNotice(
          target
            ? 'Profilbild aktualisiert und über Storage-Bridge auf dem NAS gespeichert.'
            : 'Profilbild lokal aktualisiert.'
        );
        return;
      }
      const res = await fetch('/api/nas/profile/avatar', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ avatarUrl: compressedDataUrl }),
      });
      const data = (await res.json()) as { error?: string; user?: NasUser };
      if (!res.ok || !data.user) {
        setAvatarError(data.error || 'Profilbild konnte nicht auf dem NAS gespeichert werden.');
        return;
      }
      onProfileUpdated(token, data.user);
      setAvatarNotice('Profilbild aktualisiert und zentral auf dem NAS gespeichert.');
    } catch (err) {
      setAvatarError(
        err instanceof Error ? err.message : 'Profilbild konnte nicht verarbeitet werden.'
      );
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const updatedUser: NasUser = { ...user, avatarUrl: null };
        const { buf, backendRoot, target } = resolveProfileBridgeContext();
        if (buf) {
          writeLocalOnboardingBuffer({
            ...buf,
            user: {
              ...buf.user,
              ...updatedUser,
              role: 'admin',
              password: buf.user.password,
            },
            updatedAt: new Date().toISOString(),
          });
        }
        if (target) {
          await writeFileToNasBridge({
            ...target,
            targetPath: `${backendRoot}/profiles/${updatedUser.username}.json`,
            content: JSON.stringify(
              { ...updatedUser, updatedAt: new Date().toISOString() },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        onProfileUpdated(token, updatedUser);
        setAvatarNotice('Profilbild entfernt. Es wird wieder der Initial-Avatar verwendet.');
        return;
      }
      const res = await fetch('/api/nas/profile/avatar', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ avatarUrl: null }),
      });
      const data = (await res.json()) as { error?: string; user?: NasUser };
      if (!res.ok || !data.user) {
        setAvatarError(data.error || 'Profilbild konnte nicht entfernt werden.');
        return;
      }
      onProfileUpdated(token, data.user);
      setAvatarNotice('Profilbild entfernt. Es wird wieder der Initial-Avatar verwendet.');
    } catch {
      setAvatarError('Verbindung zum NAS beim Entfernen des Profilbilds fehlgeschlagen.');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleGoogleConnect = async () => {
    setDriveAuthBusy(true);
    setDriveError(null);
    setDriveNotice(null);
    try {
      const { user: fbUser, accessToken } = await signInWithGoogleForDrive();
      setGoogleUser(fbUser);
      setGoogleAccessToken(accessToken);
      setDriveNotice(
        `Mit Google-Konto ${fbUser.email || fbUser.displayName || ''} verbunden.`
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/popup-closed-by-user') {
        setDriveError('Google-Anmeldung wurde abgebrochen.');
      } else {
        setDriveError(
          err instanceof Error ? err.message : 'Google-Anmeldung für Drive fehlgeschlagen.'
        );
      }
    } finally {
      setDriveAuthBusy(false);
    }
  };

  const handleGoogleDisconnect = async () => {
    setDriveAuthBusy(true);
    setDriveError(null);
    setDriveNotice(null);
    try {
      await signOutGoogleForDrive();
      setGoogleUser(null);
      setGoogleAccessToken(null);
      setDriveExistingFile(null);
      setDriveLastSavedFile(null);
      setPendingOverwrite(null);
    } finally {
      setDriveAuthBusy(false);
    }
  };

  const collectNasSummaryForBackup = async (): Promise<ProfileBackupPayload['nasSummary']> => {
    const headers = { Authorization: `Bearer ${token}` };
    let watchlistTitles: string[] = [];
    let watchedTitlesCount = 0;
    let favoriteSeries: string[] = [];

    if (isLocalFallbackToken(token)) {
      const items = readLocalBridgeCatalog();
      watchlistTitles = items.filter((i) => i.inWatchlist).map((i) => i.title);
      watchedTitlesCount = items.filter((i) => (i.watchedMinutes ?? 0) > 0).length;
      return {
        watchlistCount: watchlistTitles.length,
        watchlistTitles,
        favoriteSeries,
        watchedTitlesCount,
      };
    }

    try {
      const [libRes, calRes] = await Promise.all([
        fetch('/api/nas/library', { headers }),
        fetch('/api/nas/calendar', { headers }),
      ]);
      if (libRes.ok) {
        const libData = (await libRes.json()) as {
          items?: Array<{ title: string; inWatchlist?: boolean; watchedMinutes?: number }>;
        };
        const items = libData.items ?? [];
        watchlistTitles = items.filter((i) => i.inWatchlist).map((i) => i.title);
        watchedTitlesCount = items.filter((i) => (i.watchedMinutes ?? 0) > 0).length;
      }
      if (calRes.ok) {
        const calData = (await calRes.json()) as {
          releases?: Array<{ seriesTitle: string; favorite?: { isFavorite?: boolean } }>;
        };
        favoriteSeries = Array.from(
          new Set(
            (calData.releases ?? [])
              .filter((r) => r.favorite?.isFavorite)
              .map((r) => r.seriesTitle)
          )
        );
      }
    } catch {
      // Fallback mit leeren Zusammenfassungsfeldern
    }

    return {
      watchlistCount: watchlistTitles.length,
      watchlistTitles,
      favoriteSeries,
      watchedTitlesCount,
    };
  };

  const handleManualDriveBackup = async () => {
    if (!googleAccessToken) {
      setDriveError('Bitte verbinde dich zuerst mit Google, um auf Google Drive zu speichern.');
      return;
    }

    setDriveSaving(true);
    setDriveError(null);
    setDriveNotice(null);

    try {
      const [nasSummary, existingFile] = await Promise.all([
        collectNasSummaryForBackup(),
        findProfileBackupFile(googleAccessToken, user.username),
      ]);
      const payload = buildProfileBackupPayload(user, preferences, nasSummary);

      if (existingFile) {
        setDriveExistingFile(existingFile);
        setPendingOverwrite({ existingFile, payload });
        return;
      }

      const created = await uploadProfileBackupFile(googleAccessToken, payload);
      setDriveExistingFile(created);
      setDriveLastSavedFile(created);
      setDriveNotice(
        `Profilinformationen als „${created.name}“ erfolgreich auf Google Drive gespeichert.`
      );
    } catch (err) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        clearInMemoryDriveToken();
        setGoogleAccessToken(null);
        setDriveExistingFile(null);
      }
      setDriveError(
        err instanceof Error
          ? err.message
          : 'Speichern auf Google Drive fehlgeschlagen.'
      );
    } finally {
      setDriveSaving(false);
    }
  };

  const handleConfirmOverwriteDriveBackup = async () => {
    if (!pendingOverwrite || !googleAccessToken) return;
    const { existingFile, payload } = pendingOverwrite;

    setDriveSaving(true);
    setDriveError(null);
    setDriveNotice(null);

    try {
      const updated = await uploadProfileBackupFile(
        googleAccessToken,
        payload,
        existingFile.id
      );
      setPendingOverwrite(null);
      setDriveExistingFile(updated);
      setDriveLastSavedFile(updated);
      setDriveNotice(
        `Bestehende Datei „${updated.name}“ erfolgreich auf Google Drive aktualisiert.`
      );
    } catch (err) {
      setPendingOverwrite(null);
      if (err instanceof GoogleDriveAuthExpiredError) {
        clearInMemoryDriveToken();
        setGoogleAccessToken(null);
        setDriveExistingFile(null);
      }
      setDriveError(
        err instanceof Error
          ? err.message
          : 'Überschreiben auf Google Drive fehlgeschlagen.'
      );
    } finally {
      setDriveSaving(false);
    }
  };

  const handleReset = () => {
    setNewUsername(user.username);
    setNewDisplayName(user.displayName);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const cleanedUsername = newUsername
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');

    if (cleanedUsername.length < 2) {
      setError(
        'Der Benutzername muss mindestens 2 gültige Zeichen (a–z, 0–9, _ oder -) enthalten.'
      );
      return;
    }

    if (!currentPassword) {
      setError('Bitte gib zur Bestätigung dein aktuelles Passwort ein.');
      return;
    }

    if (newPassword.length > 0 && newPassword.length < 4) {
      setError('Das neue Passwort muss mindestens 4 Zeichen lang sein.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Das neue Passwort und die Bestätigung stimmen nicht überein.');
      return;
    }

    setSaving(true);
    try {
      if (isLocalFallbackToken(token)) {
        const { buf, backendRoot, target } = resolveProfileBridgeContext();
        if (buf?.user?.password && currentPassword !== buf.user.password) {
          setError('Das eingegebene aktuelle Passwort stimmt nicht.');
          return;
        }
        const updatedUser: NasUser = {
          ...user,
          username: cleanedUsername,
          displayName: newDisplayName.trim() || cleanedUsername,
        };
        if (buf) {
          writeLocalOnboardingBuffer({
            ...buf,
            user: {
              ...buf.user,
              ...updatedUser,
              role: 'admin',
              password: newPassword.length > 0 ? newPassword : buf.user.password,
            },
            updatedAt: new Date().toISOString(),
          });
        }
        let nasWritten = false;
        if (target) {
          const writeRes = await writeFileToNasBridge({
            ...target,
            targetPath: `${backendRoot}/profiles/${updatedUser.username}.json`,
            content: JSON.stringify(
              {
                ...updatedUser,
                updatedAt: new Date().toISOString(),
              },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
          nasWritten = Boolean(writeRes?.ok);
        }
        onProfileUpdated(token, updatedUser);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setSuccessMessage(
          nasWritten
            ? 'Profildaten erfolgreich aktualisiert und über Storage-Bridge auf dem NAS gesichert.'
            : 'Profildaten erfolgreich aktualisiert.'
        );
        return;
      }
      const res = await fetch('/api/nas/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword,
          newUsername: cleanedUsername,
          newDisplayName: newDisplayName.trim(),
          newPassword: newPassword.length > 0 ? newPassword : undefined,
        }),
      });

      const data = (await res.json()) as {
        error?: string;
        token?: string;
        user?: NasUser;
      };

      if (!res.ok || !data.token || !data.user) {
        setError(data.error || 'Profiländerungen konnten nicht auf dem NAS gespeichert werden.');
        return;
      }

      const changedParts: string[] = [];
      if (data.user.username !== user.username) {
        changedParts.push(`Benutzername auf „${data.user.username}“`);
      }
      if (data.user.displayName !== user.displayName) {
        changedParts.push(`Anzeigename auf „${data.user.displayName}“`);
      }
      if (newPassword.length > 0) {
        changedParts.push('Passwort');
      }

      onProfileUpdated(data.token, data.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      setSuccessMessage(
        changedParts.length > 0
          ? `Gespeichert: ${changedParts.join(', ')} erfolgreich auf dem NAS aktualisiert.`
          : 'Profildaten erfolgreich bestätigt und auf dem NAS gesichert.'
      );
    } catch {
      setError('Verbindung zum zentralen EntenCenter NAS nicht möglich.');
    } finally {
      setSaving(false);
    }
  };

  const persistPreferences = async (nextPrefs: UserPreferences, noticeText: string) => {
    // Sofort lokal anwenden für unmittelbares visuelles Feedback
    onPreferencesUpdated(nextPrefs);
    setPrefsError(null);
    if (isLocalFallbackToken(token)) {
      const { backendRoot, target } = resolveProfileBridgeContext();
      if (target) {
        void writeFileToNasBridge({
          ...target,
          targetPath: `${backendRoot}/config/preferences-${user.username}.json`,
          content: JSON.stringify(nextPrefs, null, 2),
          contentType: 'application/json; charset=utf-8',
        }).catch(() => null);
        setPrefsNotice(`${noticeText} (In Storage-Bridge auf NAS & Gerät gespeichert)`);
      } else {
        setPrefsNotice(`${noticeText} (Lokal auf diesem Gerät gespeichert)`);
      }
      return;
    }
    setSavingPrefs(true);
    try {
      const res = await fetch('/api/nas/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(nextPrefs),
      });
      if (!res.ok) {
        setPrefsError('Einstellungen konnten nicht auf dem NAS gespeichert werden.');
        return;
      }
      const saved = (await res.json()) as UserPreferences;
      onPreferencesUpdated(saved);
      setPrefsNotice(noticeText);
    } catch {
      setPrefsError('Verbindung zum NAS beim Speichern der Darstellung fehlgeschlagen.');
    } finally {
      setSavingPrefs(false);
    }
  };

  const customThemeSettings: CustomThemeSettings = {
    activeFor: preferences.customTheme?.activeFor ?? 'none',
    design1: {
      ...DEFAULT_DESIGN1_CUSTOM_PALETTE,
      ...(preferences.customTheme?.design1 ?? {}),
    },
    design2: {
      ...DEFAULT_DESIGN2_CUSTOM_PALETTE,
      ...(preferences.customTheme?.design2 ?? {}),
    },
  };

  const autoThemeConfig: AutoThemeConfig = normalizeAutoThemeConfig(
    preferences.autoTheme ?? DEFAULT_AUTO_THEME_CONFIG,
    preferences.theme
  );
  const autoThemeEval = evaluateAutoTheme(autoThemeConfig, new Date(), preferences.theme);

  const handleUpdateAutoTheme = (
    patch: Partial<AutoThemeConfig>,
    noticeText: string
  ) => {
    const nextAuto = normalizeAutoThemeConfig(
      {
        ...autoThemeConfig,
        ...patch,
      },
      preferences.theme
    );
    void persistPreferences(
      {
        ...preferences,
        autoTheme: nextAuto,
      },
      noticeText
    );
  };

  const handleSelectAutoThemeMode = async (mode: AutoThemeMode) => {
    setGeoError(null);
    setGeoNotice(null);
    const modeLabel =
      mode === 'time'
        ? 'Automatische Theme-Umschaltung nach Systemzeit aktiviert.'
        : mode === 'location'
          ? 'Automatische Theme-Umschaltung nach Gerätestandort (Sonnenauf-/-untergang) aktiviert.'
          : 'Automatische Theme-Umschaltung deaktiviert (manuelle Auswahl aktiv).';

    const baseNext: AutoThemeConfig = normalizeAutoThemeConfig(
      {
        ...autoThemeConfig,
        mode,
      },
      preferences.theme
    );

    if (mode === 'location' && (baseNext.latitude === null || baseNext.longitude === null)) {
      await persistPreferences(
        {
          ...preferences,
          autoTheme: baseNext,
        },
        modeLabel
      );
      void handleDetectDeviceLocation(baseNext);
      return;
    }

    void persistPreferences(
      {
        ...preferences,
        autoTheme: baseNext,
      },
      modeLabel
    );
  };

  const handleDetectDeviceLocation = async (overrideBase?: AutoThemeConfig) => {
    setGeoError(null);
    setGeoNotice(null);
    setGeoBusy(true);
    const activeBase = overrideBase ?? autoThemeConfig;
    try {
      const coords = await requestDeviceCoordinates();
      const updatedAuto = normalizeAutoThemeConfig(
        {
          ...activeBase,
          mode: 'location',
          latitude: coords.latitude,
          longitude: coords.longitude,
          locationLabel: coords.locationLabel,
          lastLocationUpdatedAt: new Date().toISOString(),
        },
        preferences.theme
      );
      const evalRes = evaluateAutoTheme(updatedAuto, new Date(), preferences.theme);
      setGeoNotice(
        `Position erkannt (${coords.latitude.toFixed(2)}°, ${coords.longitude.toFixed(2)}°${
          coords.accuracyMeters ? ` · ±${coords.accuracyMeters} m` : ''
        }). Sonnenaufgang: ${evalRes.sunriseLabel || '—'} · Sonnenuntergang: ${
          evalRes.sunsetLabel || '—'
        }.`
      );
      void persistPreferences(
        {
          ...preferences,
          autoTheme: updatedAuto,
        },
        'Gerätestandort für automatische Tag/Nacht-Umschaltung gespeichert.'
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Standort konnte nicht ermittelt werden. Zeitzonen-Schätzung bleibt aktiv.';
      setGeoError(msg);
    } finally {
      setGeoBusy(false);
    }
  };

  const handleApplyTimezoneFallbackCoords = () => {
    setGeoError(null);
    const fallback = estimateCoordinatesFromTimezone();
    const updatedAuto = normalizeAutoThemeConfig(
      {
        ...autoThemeConfig,
        mode: 'location',
        latitude: fallback.latitude,
        longitude: fallback.longitude,
        locationLabel: fallback.locationLabel,
        lastLocationUpdatedAt: new Date().toISOString(),
      },
      preferences.theme
    );
    const evalRes = evaluateAutoTheme(updatedAuto, new Date(), preferences.theme);
    setGeoNotice(
      `${fallback.locationLabel} übernommen. Sonnenaufgang ca. ${evalRes.sunriseLabel || '—'} · Sonnenuntergang ca. ${evalRes.sunsetLabel || '—'}.`
    );
    void persistPreferences(
      {
        ...preferences,
        autoTheme: updatedAuto,
      },
      'Zeitzonen-Standort für Sonnenstand-Automatik gespeichert.'
    );
  };

  const resolveBaseThemeForTarget = (target: 'design1' | 'design2'): ThemePresetId => {
    if (target === 'design2') return 'silver-glass';
    return DESIGN_1_THEMES.some((t) => t.id === preferences.theme)
      ? preferences.theme
      : 'cinema-amber';
  };

  const handleSelectTheme = (themeId: ThemePresetId) => {
    const label = THEME_OPTIONS.find((t) => t.id === themeId)?.name ?? themeId;
    const nextAuto =
      autoThemeConfig.mode !== 'off'
        ? { ...autoThemeConfig, mode: 'off' as const }
        : autoThemeConfig;
    void persistPreferences(
      {
        ...preferences,
        theme: themeId,
        autoTheme: nextAuto,
        customTheme: {
          ...customThemeSettings,
          activeFor: 'none',
        },
      },
      `Design „${label}“ manuell aktiviert und gespeichert.`
    );
  };

  const scheduleCustomPrefsPersist = (nextPrefs: UserPreferences, noticeText: string) => {
    onPreferencesUpdated(nextPrefs);
    setPrefsError(null);
    if (customSaveTimerRef.current !== null) {
      window.clearTimeout(customSaveTimerRef.current);
    }
    customSaveTimerRef.current = window.setTimeout(() => {
      customSaveTimerRef.current = null;
      void persistPreferences(nextPrefs, noticeText);
    }, 260);
  };

  const handleActivateCustomDesign = (target: 'design1' | 'design2') => {
    setOpenCustomPicker((prev) => ({ ...prev, [target]: true }));
    const nextTheme = resolveBaseThemeForTarget(target);
    const label = target === 'design2' ? 'Design 2 (Glassy)' : 'Design 1';
    const nextAuto =
      autoThemeConfig.mode !== 'off'
        ? { ...autoThemeConfig, mode: 'off' as const }
        : autoThemeConfig;
    void persistPreferences(
      {
        ...preferences,
        theme: nextTheme,
        autoTheme: nextAuto,
        customTheme: {
          ...customThemeSettings,
          activeFor: target,
        },
      },
      `${label} · Freie Farbauswahl aktiviert und gespeichert.`
    );
  };

  const handleUpdateCustomColor = (
    target: 'design1' | 'design2',
    key: keyof CustomThemePalette,
    rawHex: string,
    immediate = false
  ) => {
    const cleaned = rawHex.trim().toUpperCase();
    const normalized = cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
    const draftKey = `${target}_${key}`;

    if (!/^#[0-9A-F]{6}$/.test(normalized)) {
      setHexDrafts((prev) => ({ ...prev, [draftKey]: rawHex }));
      return;
    }

    setHexDrafts((prev) => {
      if (!(draftKey in prev)) return prev;
      const copy = { ...prev };
      delete copy[draftKey];
      return copy;
    });

    const nextTheme = resolveBaseThemeForTarget(target);
    const nextPrefs: UserPreferences = {
      ...preferences,
      theme: nextTheme,
      customTheme: {
        ...customThemeSettings,
        activeFor: target,
        [target]: {
          ...customThemeSettings[target],
          [key]: normalized,
        },
      },
    };

    const componentLabel =
      CUSTOM_COLOR_COMPONENTS.find((item) => item.key === key)?.label ?? 'Komponente';
    const designLabel = target === 'design2' ? 'Design 2' : 'Design 1';
    const noticeText = `${designLabel}: Farbe für „${componentLabel}“ (${normalized}) gespeichert.`;

    if (immediate) {
      if (customSaveTimerRef.current !== null) {
        window.clearTimeout(customSaveTimerRef.current);
        customSaveTimerRef.current = null;
      }
      void persistPreferences(nextPrefs, noticeText);
    } else {
      scheduleCustomPrefsPersist(nextPrefs, noticeText);
    }
  };

  const handleResetCustomColors = (target: 'design1' | 'design2') => {
    const defaultPalette =
      target === 'design2' ? DEFAULT_DESIGN2_CUSTOM_PALETTE : DEFAULT_DESIGN1_CUSTOM_PALETTE;
    setHexDrafts((prev) => {
      const next = { ...prev };
      for (const comp of CUSTOM_COLOR_COMPONENTS) {
        delete next[`${target}_${comp.key}`];
      }
      return next;
    });

    const nextTheme = resolveBaseThemeForTarget(target);
    const label = target === 'design2' ? 'Design 2' : 'Design 1';
    void persistPreferences(
      {
        ...preferences,
        theme: nextTheme,
        customTheme: {
          ...customThemeSettings,
          activeFor: target,
          [target]: { ...defaultPalette },
        },
      },
      `${label}: Standardfarben für freie Farbauswahl wiederhergestellt.`
    );
  };

  const normalizedHomeOrder: HomeRowKey[] = (() => {
    const valid = new Set<HomeRowKey>(DEFAULT_USER_PREFERENCES.homeSectionOrder);
    const seen = new Set<HomeRowKey>();
    const list: HomeRowKey[] = [];
    for (const key of preferences.homeSectionOrder ?? []) {
      if (valid.has(key) && !seen.has(key)) {
        seen.add(key);
        list.push(key);
      }
    }
    const prependMissing: HomeRowKey[] = [];
    for (const fallbackKey of DEFAULT_USER_PREFERENCES.homeSectionOrder) {
      if (!seen.has(fallbackKey)) {
        seen.add(fallbackKey);
        if (fallbackKey === 'ask_duck' || fallbackKey === 'recommendations') {
          prependMissing.push(fallbackKey);
          continue;
        }
        if (fallbackKey === 'duck_radar') {
          const recIdx = list.indexOf('recommendations');
          if (recIdx >= 0) {
            list.splice(recIdx + 1, 0, fallbackKey);
            continue;
          }
          prependMissing.push(fallbackKey);
          continue;
        }
        if (fallbackKey === 'recently_added') {
          const wlIdx = list.indexOf('watchlist');
          if (wlIdx >= 0) {
            list.splice(wlIdx + 1, 0, fallbackKey);
            continue;
          }
        }
        list.push(fallbackKey);
      }
    }
    if (prependMissing.length > 0) {
      list.unshift(...prependMissing);
    }
    return list;
  })();

  const hiddenHomeSections: HomeToggleKey[] = preferences.hiddenHomeSections ?? [];
  const hiddenHomeSet = new Set<HomeToggleKey>(hiddenHomeSections);
  const duckAssistantEnabled = preferences.duckAssistantEnabled !== false;
  const showHomeCategoryTabs = preferences.showHomeCategoryTabs === true;
  const showHomeFilterSearch = preferences.showHomeFilterSearch === true;

  const handleToggleHomeCategoryTabs = () => {
    const nextValue = !showHomeCategoryTabs;
    void persistPreferences(
      {
        ...preferences,
        showHomeCategoryTabs: nextValue,
      },
      nextValue
        ? 'Rubrikenauswahl oben auf der Startseite eingeblendet.'
        : 'Rubrikenauswahl oben auf der Startseite ausgeblendet.'
    );
  };

  const handleToggleHomeFilterSearch = () => {
    const nextValue = !showHomeFilterSearch;
    void persistPreferences(
      {
        ...preferences,
        showHomeFilterSearch: nextValue,
      },
      nextValue
        ? 'Suche, Genre-Filter & Sortierung auf der Startseite eingeblendet.'
        : 'Suche, Genre-Filter & Sortierung auf der Startseite ausgeblendet.'
    );
  };

  const handleToggleDuckAssistantEnabled = () => {
    const nextEnabled = !duckAssistantEnabled;
    void persistPreferences(
      {
        ...preferences,
        duckAssistantEnabled: nextEnabled,
      },
      nextEnabled
        ? 'Enten-Assistent eingeschaltet: „Frag die Ente“ und „Dein Enten Assistent empfiehlt“ werden auf der Startseite wieder angezeigt.'
        : 'Enten-Assistent ausgeschaltet: Alle KI-Felder und Enten-Assistent-Felder wurden auf der Startseite ausgeblendet.'
    );
  };

  const handleToggleHomeSectionVisibility = (key: HomeToggleKey, label: string) => {
    const currentlyHidden = hiddenHomeSet.has(key);
    const nextHidden = currentlyHidden
      ? hiddenHomeSections.filter((item) => item !== key)
      : [...hiddenHomeSections, key];
    void persistPreferences(
      {
        ...preferences,
        homeSectionOrder: normalizedHomeOrder,
        hiddenHomeSections: nextHidden,
      },
      currentlyHidden
        ? `„${label}“ wird wieder auf der Startseite angezeigt.`
        : `„${label}“ auf der Startseite ausgeblendet.`
    );
  };

  const handleShowAllHomeSections = () => {
    void persistPreferences(
      {
        ...preferences,
        homeSectionOrder: normalizedHomeOrder,
        hiddenHomeSections: [],
      },
      'Alle Menüpunkte werden wieder auf der Startseite angezeigt.'
    );
  };

  const handleMoveHomeRow = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= normalizedHomeOrder.length) return;
    const nextOrder = [...normalizedHomeOrder];
    const [moved] = nextOrder.splice(index, 1);
    nextOrder.splice(target, 0, moved);
    void persistPreferences(
      {
        ...preferences,
        homeSectionOrder: nextOrder,
      },
      'Reihenfolge für den Startbildschirm aktualisiert.'
    );
  };

  const handleDropHomeRow = (targetKey: HomeRowKey) => {
    if (!draggedKey || draggedKey === targetKey) {
      setDraggedKey(null);
      setDragOverKey(null);
      return;
    }
    const nextOrder = [...normalizedHomeOrder];
    const fromIndex = nextOrder.indexOf(draggedKey);
    const toIndex = nextOrder.indexOf(targetKey);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setDraggedKey(null);
    setDragOverKey(null);
    void persistPreferences(
      {
        ...preferences,
        homeSectionOrder: nextOrder,
      },
      'Startbildschirm-Reihenfolge per Drag & Drop gespeichert.'
    );
  };

  const currentAudioMode: AudioPlayerMode =
    preferences.audioPlayerMode === 'external' ? 'external' : 'internal';

  const currentControlsTimeoutSec =
    typeof preferences.playerControlsTimeoutSec === 'number' &&
    preferences.playerControlsTimeoutSec >= 0
      ? preferences.playerControlsTimeoutSec
      : 3;
  const currentSeekBackwardSec =
    typeof preferences.playerSeekBackwardSec === 'number' &&
    preferences.playerSeekBackwardSec >= 5
      ? preferences.playerSeekBackwardSec
      : 30;
  const currentSeekForwardSec =
    typeof preferences.playerSeekForwardSec === 'number' &&
    preferences.playerSeekForwardSec >= 5
      ? preferences.playerSeekForwardSec
      : 30;

  const CONTROLS_TIMEOUT_PRESETS: Array<{ seconds: number; label: string }> = [
    { seconds: 2, label: '2 Sek.' },
    { seconds: 3, label: '3 Sek.' },
    { seconds: 5, label: '5 Sek.' },
    { seconds: 8, label: '8 Sek.' },
    { seconds: 10, label: '10 Sek.' },
    { seconds: 15, label: '15 Sek.' },
    { seconds: 30, label: '30 Sek.' },
    { seconds: 0, label: 'Dauerhaft' },
  ];

  const SEEK_STEP_PRESETS: Array<{ seconds: number; label: string; shortLabel: string }> = [
    { seconds: 10, label: '10 Sekunden', shortLabel: '10 Sek.' },
    { seconds: 30, label: '30 Sekunden', shortLabel: '30 Sek.' },
    { seconds: 60, label: '1 Minute', shortLabel: '1 Min.' },
    { seconds: 120, label: '2 Minuten', shortLabel: '2 Min.' },
    { seconds: 180, label: '3 Minuten', shortLabel: '3 Min.' },
    { seconds: 300, label: '5 Minuten', shortLabel: '5 Min.' },
    { seconds: 600, label: '10 Minuten', shortLabel: '10 Min.' },
    { seconds: 900, label: '15 Minuten', shortLabel: '15 Min.' },
    { seconds: 1200, label: '20 Minuten', shortLabel: '20 Min.' },
    { seconds: 1800, label: '30 Minuten', shortLabel: '30 Min.' },
  ];

  const formatSeekDurationLabel = (seconds: number): string => {
    const matched = SEEK_STEP_PRESETS.find((p) => p.seconds === seconds);
    if (matched) return matched.shortLabel;
    if (seconds < 60) return `${seconds} Sek.`;
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return rem === 0 ? `${mins} Min.` : `${mins} Min. ${rem} Sek.`;
  };

  const handleUpdateEntenPlayerSettings = (
    patch: Partial<
      Pick<
        UserPreferences,
        'playerControlsTimeoutSec' | 'playerSeekBackwardSec' | 'playerSeekForwardSec'
      >
    >,
    message: string
  ) => {
    void persistPreferences(
      {
        ...preferences,
        ...patch,
      },
      message
    );
  };

  const handleSelectAudioPlayerMode = (mode: AudioPlayerMode) => {
    void persistPreferences(
      {
        ...preferences,
        audioPlayerMode: mode,
      },
      mode === 'external'
        ? 'MP3- und Musikwiedergabe auf externen Player umgestellt und auf dem NAS gespeichert.'
        : 'MP3- und Musikwiedergabe auf den Enten Player umgestellt und auf dem NAS gespeichert.'
    );
  };

  const handleResetAppearance = () => {
    void persistPreferences(
      DEFAULT_USER_PREFERENCES,
      'Standard-Design (Cinema Gold), Standard-Reihenfolge und Standard-Anzeige wiederhergestellt.'
    );
  };

  const formattedCreatedAt = (() => {
    const parsed = new Date(user.createdAt);
    return Number.isNaN(parsed.getTime())
      ? user.createdAt
      : parsed.toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });
  })();

  const resolvedActiveThemeLabel =
    THEME_OPTIONS.find((t) => t.id === autoThemeEval.targetTheme)?.name ??
    autoThemeEval.targetTheme;

  const activeThemeName = autoThemeEval.isAutoActive
    ? `Automatik (${autoThemeConfig.mode === 'location' ? 'Standort' : 'Zeit'}) · ${resolvedActiveThemeLabel}`
    : customThemeSettings.activeFor === 'design1'
      ? 'Design 1 · Freie Farbauswahl'
      : customThemeSettings.activeFor === 'design2'
        ? 'Design 2 · Freie Farbauswahl'
        : (THEME_OPTIONS.find((t) => t.id === preferences.theme)?.name ?? 'Cinema Gold');

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Kompakte Profil-Kopfzeile mit Profilbild-Steuerung & Alle auf-/zuklappen */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative shrink-0">
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.displayName}
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded-full object-cover border-2 border-amber-400/70"
                />
              ) : (
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-slate-950 font-display text-xl font-bold"
                  style={{ backgroundColor: user.avatarColor || '#F59E0B' }}
                >
                  {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                </div>
              )}
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarBusy}
                title="Profilbild ändern"
                aria-label="Profilbild ändern"
                className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 flex items-center justify-center border-2 border-[#121722] transition-colors"
              >
                <Camera className="w-3.5 h-3.5" />
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleAvatarFileSelected}
                className="hidden"
              />
            </div>

            <div className="min-w-0">
              <h2 className="font-display text-lg sm:text-xl font-semibold text-white truncate">
                {user.displayName}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                <span className="font-mono text-amber-400">@{user.username}</span>
                <span className="mx-1.5 text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span>{user.role === 'admin' ? 'Administrator' : 'Familien-Konto'}</span>
                {(user.role === 'admin' || user.hasNasWriteAccess) && (
                  <>
                    <span className="mx-1.5 text-slate-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-emerald-300 font-medium">NAS-Schreibrechte aktiv</span>
                  </>
                )}
                <span className="mx-1.5 text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="tabular-nums">
                  Altersfreigabe:{' '}
                  {(user.fskLimit ?? 18) >= 18
                    ? 'FSK 18 (Unbeschränkt)'
                    : `Bis FSK ${user.fskLimit} (FSK 0–${user.fskLimit})`}
                </span>
                <span className="mx-1.5 text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="tabular-nums">seit {formattedCreatedAt}</span>
              </p>

              <div className="flex flex-wrap items-center gap-2 mt-2.5">
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarBusy}
                  className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <Camera className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    {avatarBusy
                      ? 'Speichere Bild...'
                      : user.avatarUrl
                        ? 'Profilbild ändern'
                        : 'Profilbild hinzufügen'}
                  </span>
                </button>

                {user.avatarUrl && (
                  <button
                    type="button"
                    onClick={handleRemoveAvatar}
                    disabled={avatarBusy}
                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-red-950/50 border border-slate-800 hover:border-red-800/70 text-xs font-medium text-slate-300 hover:text-red-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Entfernen</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleAllSections}
            className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <ChevronDown
              className={`w-3.5 h-3.5 text-amber-400 transition-transform duration-200 ${
                allExpanded ? 'rotate-180' : ''
              }`}
            />
            <span>{allExpanded ? 'Alle zuklappen' : 'Alle aufklappen'}</span>
          </button>
        </div>

        {avatarError && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{avatarError}</span>
          </div>
        )}

        {avatarNotice && (
          <div
            role="status"
            className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{avatarNotice}</span>
          </div>
        )}

        {isLocalFallbackToken(token) && !profileSetupDone && (
          <div className="rounded-xl bg-[#0B0E14] border border-emerald-500/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <p className="text-xs sm:text-sm font-semibold text-white">
                  Profileinrichtung &amp; NAS-Abschluss prüfen
                </p>
                <p className="text-[11px] text-slate-300">
                  Beende den Einrichtungs- &amp; Bridge-Modus automatisch nach Prüfung von FRITZ!NAS &amp; Backend — oder ergänze fehlende Angaben direkt hier.
                </p>
              </div>
              <button
                type="button"
                disabled={profileSetupBusy}
                onClick={() => void handleFinishProfileSetupManually(false)}
                className="px-3.5 py-2 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>
                  {profileSetupBusy
                    ? 'Prüfe Verbindung & Backend…'
                    : 'Profileinrichtung manuell abschließen & beenden'}
                </span>
              </button>
            </div>

            {profileSetupError && (
              <p className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-400/40 rounded-lg px-3 py-2">
                {profileSetupError}
              </p>
            )}

            {profileSetupMissing.length > 0 && (
              <div className="rounded-lg bg-[#121722] border border-amber-400/40 p-3 space-y-2.5 text-xs">
                <ul className="space-y-1 text-[11px] text-slate-200">
                  {profileSetupMissing.map((item) => (
                    <li key={item.key}>
                      <span className="font-semibold text-amber-300">{item.label}: </span>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={missingHostInput}
                    onChange={(e) => setMissingHostInput(e.target.value)}
                    placeholder="NAS / FRITZ!Box IP (z. B. 192.168.178.1)"
                    className="px-2.5 py-1.5 rounded bg-[#0B0E14] border border-slate-700 text-xs text-white"
                  />
                  <input
                    type="text"
                    value={missingDisplayInput}
                    onChange={(e) => setMissingDisplayInput(e.target.value)}
                    placeholder="Profil-Anzeigename"
                    className="px-2.5 py-1.5 rounded bg-[#0B0E14] border border-slate-700 text-xs text-white"
                  />
                  <input
                    type="text"
                    value={missingUserInput}
                    onChange={(e) => setMissingUserInput(e.target.value)}
                    placeholder="FRITZ!Box / NAS-Benutzername"
                    className="px-2.5 py-1.5 rounded bg-[#0B0E14] border border-slate-700 text-xs text-white"
                  />
                  <input
                    type="password"
                    value={missingPassInput}
                    onChange={(e) => setMissingPassInput(e.target.value)}
                    placeholder="FRITZ!Box / NAS-Passwort"
                    className="px-2.5 py-1.5 rounded bg-[#0B0E14] border border-slate-700 text-xs text-white"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={profileSetupBusy}
                    onClick={() => void handleFinishProfileSetupManually(false)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-[11px] font-semibold"
                  >
                    Angaben prüfen &amp; abschließen
                  </button>
                  <button
                    type="button"
                    disabled={profileSetupBusy}
                    onClick={() => void handleFinishProfileSetupManually(true)}
                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300"
                  >
                    Trotzdem manuell abschließen &amp; beenden
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {profileSetupNotice && (
          <div
            role="status"
            className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{profileSetupNotice}</span>
          </div>
        )}
      </section>

      {/* Unterpunkt: Einstellungen */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('settings')}
          aria-expanded={openSections.settings}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Einstellungen
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                Enten-Assistent-Einstellungen · KI-Felder &amp; Startseiten-Assistent ({duckAssistantEnabled ? 'Ein' : 'Aus'})
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.settings ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.settings && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-4">
            {/* Menüpunkt: Enten-Assistent-Einstellungen */}
            <div className="rounded-xl bg-[#0B0E14] border border-slate-800/90 overflow-hidden">
              <button
                type="button"
                onClick={() => setDuckAssistantMenuOpen((prev) => !prev)}
                aria-expanded={duckAssistantMenuOpen}
                className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-xs sm:text-sm font-semibold text-white truncate">
                      Enten-Assistent-Einstellungen
                    </h4>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      Untermenü Enten-Assistent &amp; KI-Bereiche auf der Startseite steuern
                    </p>
                  </div>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                    duckAssistantMenuOpen ? 'rotate-180 text-amber-400' : ''
                  }`}
                />
              </button>

              {duckAssistantMenuOpen && (
                <div className="px-4 pb-4 pt-3 border-t border-slate-800/80 space-y-3">
                  {/* Untermenü: Enten-Assistent (Ein / Aus) */}
                  <div className="p-3.5 rounded-xl bg-[#121722] border border-slate-800/80 flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs sm:text-sm font-semibold text-white">
                        Enten-Assistent
                      </p>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Standardmäßig auf <strong className="text-slate-200">Ein</strong> gestellt. Wenn ausgeschaltet, werden alle KI-Felder und Enten-Assistent-Felder („Frag die Ente“ &amp; „Dein Enten Assistent empfiehlt“) auf der Startseite automatisch ausgeblendet.
                      </p>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={duckAssistantEnabled}
                      aria-label="Enten-Assistent ein- oder ausschalten"
                      disabled={savingPrefs}
                      onClick={handleToggleDuckAssistantEnabled}
                      className={`inline-flex items-center gap-2.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        duckAssistantEnabled
                          ? 'bg-amber-400/15 border-amber-400/60 text-amber-300 hover:bg-amber-400/25'
                          : 'bg-[#0B0E14] border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      <span
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          duckAssistantEnabled ? 'bg-amber-400' : 'bg-slate-700'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-slate-950 transition-transform ${
                            duckAssistantEnabled ? 'translate-x-4.5' : 'translate-x-1'
                          }`}
                        />
                      </span>
                      <span>{duckAssistantEnabled ? 'Ein' : 'Aus'}</span>
                    </button>
                  </div>

                  {prefsError && (
                    <div
                      role="alert"
                      className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
                    >
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      <span>{prefsError}</span>
                    </div>
                  )}

                  {prefsNotice && (
                    <div
                      role="status"
                      className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <span>{prefsNotice}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Unterpunkt 1: Benutzernamen & Passwort ändern */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('credentials')}
          aria-expanded={openSections.credentials}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <User className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Benutzernamen &amp; Passwort ändern
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                @{user.username} · {user.displayName} · Passwort auf dem NAS aktualisieren
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.credentials ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.credentials && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
            <p className="text-xs text-slate-400">
              Zur Sicherheit ist bei jeder Änderung dein aktuelles NAS-Passwort erforderlich.
            </p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="profile-username"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Benutzername (Login-Kürzel)
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="profile-username"
                      type="text"
                      required
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="z. B. kevin"
                      className="w-full pl-10 pr-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    />
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Erlaubt: Kleinbuchstaben, Ziffern, _ und -
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="profile-displayname"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Anzeigename
                  </label>
                  <input
                    id="profile-displayname"
                    type="text"
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="z. B. Kevin (Wohnzimmer)"
                    className="w-full px-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Wird bei „Wer schaut heute?“ angezeigt
                  </p>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-800/80 space-y-4">
                <div>
                  <label
                    htmlFor="profile-current-password"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Aktuelles Passwort (erforderlich)
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="profile-current-password"
                      type={showCurrentPassword ? 'text' : 'password'}
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Aktuelles Passwort eingeben"
                      className="w-full pl-10 pr-10 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      aria-label={
                        showCurrentPassword
                          ? 'Aktuelles Passwort verbergen'
                          : 'Aktuelles Passwort anzeigen'
                      }
                    >
                      {showCurrentPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="profile-new-password"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Neues Passwort (optional)
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="profile-new-password"
                        type={showNewPassword ? 'text' : 'password'}
                        minLength={4}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Mind. 4 Zeichen (leer lassen = unverändert)"
                        className="w-full pl-10 pr-10 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewPassword((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                        aria-label={
                          showNewPassword
                            ? 'Neues Passwort verbergen'
                            : 'Neues Passwort anzeigen'
                        }
                      >
                        {showNewPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="profile-confirm-password"
                      className="block text-xs font-medium text-slate-300 mb-1.5"
                    >
                      Neues Passwort bestätigen
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="profile-confirm-password"
                        type={showNewPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Neues Passwort wiederholen"
                        className="w-full pl-10 pr-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="p-3.5 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2.5"
                >
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {successMessage && (
                <div
                  role="status"
                  className="p-3.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2.5"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>{successMessage}</span>
                </div>
              )}

              <div className="pt-2 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleReset}
                  className="px-4 py-2.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Zurücksetzen</span>
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs sm:text-sm font-semibold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <Save className="w-4 h-4" />
                  <span>{saving ? 'Speichere auf NAS...' : 'Änderungen speichern'}</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </section>

      {/* Unterpunkt 2: Design & Farbthema */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('theme')}
          aria-expanded={openSections.theme}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <Palette className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Design &amp; Farbthema
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                Aktives Design: <span className="text-amber-300 font-medium">{activeThemeName}</span>{' '}
                · {THEME_OPTIONS.length} Themen verfügbar
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            {savingPrefs && (
              <span className="text-[11px] text-amber-300 whitespace-nowrap">Speichere...</span>
            )}
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${
                openSections.theme ? 'rotate-180 text-amber-400' : ''
              }`}
            />
          </div>
        </button>

        {openSections.theme && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
            <p className="text-xs text-slate-400">
              Passe Hintergrund, Kartenoberflächen und Akzentfarbe manuell an oder aktiviere die
              automatische Tag-/Nacht-Umschaltung nach Systemzeit oder Gerätestandort.
            </p>

            {/* Automatische Theme-Umschaltung (Systemzeit & Gerätestandort) */}
            <div className="rounded-xl bg-[#0B0E14]/70 border border-slate-800/80 p-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-xl bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                    {autoThemeConfig.mode === 'location' ? (
                      <MapPin className="w-4 h-4" />
                    ) : autoThemeConfig.mode === 'time' ? (
                      <Clock className="w-4 h-4" />
                    ) : (
                      <Sun className="w-4 h-4" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <h4 className="font-display text-xs sm:text-sm font-semibold text-white">
                      Automatische Theme-Umschaltung (Zeit &amp; Standort)
                    </h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Wechselt nahtlos zwischen deinem Dark Mode und dem Light- oder High-Contrast-Modus.
                    </p>
                  </div>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border whitespace-nowrap ${
                    autoThemeEval.isAutoActive
                      ? 'bg-amber-400/15 border-amber-400/50 text-amber-300'
                      : 'bg-slate-900/80 border-slate-700 text-slate-300'
                  }`}
                >
                  {autoThemeEval.isAutoActive
                    ? autoThemeEval.phase === 'day'
                      ? 'Tagphase aktiv'
                      : 'Nachtphase aktiv'
                    : 'Manuell'}
                </span>
              </div>

              {/* 3-Wege Moduswahl */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {(
                  [
                    {
                      id: 'off' as AutoThemeMode,
                      label: 'Manuell (Aus)',
                      sub: 'Fest gewähltes Theme',
                      icon: Palette,
                    },
                    {
                      id: 'time' as AutoThemeMode,
                      label: 'Systemzeit',
                      sub: `${autoThemeConfig.dayStartTime}–${autoThemeConfig.nightStartTime} Uhr`,
                      icon: Clock,
                    },
                    {
                      id: 'location' as AutoThemeMode,
                      label: 'Gerätestandort',
                      sub: 'Sonnenauf- & -untergang',
                      icon: MapPin,
                    },
                  ] as const
                ).map((item) => {
                  const Icon = item.icon;
                  const selected = autoThemeConfig.mode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void handleSelectAutoThemeMode(item.id)}
                      aria-pressed={selected}
                      className={`p-3 rounded-xl border text-left flex items-center gap-3 transition-colors ${
                        selected
                          ? 'bg-amber-400/15 border-amber-400 text-white'
                          : 'bg-[#121722] border-slate-800 hover:border-slate-700 text-slate-200'
                      }`}
                    >
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          selected
                            ? 'bg-amber-400 text-slate-950'
                            : 'bg-[#0B0E14] text-slate-400 border border-slate-800'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{item.label}</p>
                        <p className="text-[11px] text-slate-400 truncate">{item.sub}</p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {autoThemeConfig.mode !== 'off' && (
                <div className="space-y-4 pt-2 border-t border-slate-800/80">
                  {/* Live-Statusanzeige */}
                  <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      {autoThemeEval.phase === 'day' ? (
                        <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                      ) : (
                        <Moon className="w-4 h-4 text-amber-400 shrink-0" />
                      )}
                      <span className="text-slate-200">{autoThemeEval.reason}</span>
                    </div>
                    {autoThemeEval.nextSwitchLabel && (
                      <span className="text-[11px] font-mono text-amber-300 whitespace-nowrap tabular-nums">
                        Nächster Wechsel: {autoThemeEval.nextSwitchLabel}
                      </span>
                    )}
                  </div>

                  {/* Ziel-Themes für Tag & Nacht */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 space-y-2">
                      <label className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                        <Sun className="w-3.5 h-3.5 text-amber-400" />
                        <span>Tag-Modus (bei Tageslicht)</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {(
                          [
                            {
                              id: 'light' as AutoThemeDayTarget,
                              label: 'Light Mode',
                              icon: Sun,
                            },
                            {
                              id: 'high-contrast' as AutoThemeDayTarget,
                              label: 'High Contrast',
                              icon: Contrast,
                            },
                          ] as const
                        ).map((dayOpt) => {
                          const DIcon = dayOpt.icon;
                          const isSelected = autoThemeConfig.dayTheme === dayOpt.id;
                          return (
                            <button
                              key={dayOpt.id}
                              type="button"
                              onClick={() =>
                                handleUpdateAutoTheme(
                                  { dayTheme: dayOpt.id },
                                  `Tag-Modus auf „${dayOpt.label}“ umgestellt.`
                                )
                              }
                              aria-pressed={isSelected}
                              className={`px-3 py-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                                isSelected
                                  ? 'bg-amber-400 text-slate-950 border-amber-400 font-semibold'
                                  : 'bg-[#0B0E14] text-slate-200 border-slate-800 hover:border-slate-700'
                              }`}
                            >
                              <DIcon className="w-3.5 h-3.5 shrink-0" />
                              <span>{dayOpt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 space-y-2">
                      <label
                        htmlFor="auto-theme-night-select"
                        className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5"
                      >
                        <Moon className="w-3.5 h-3.5 text-amber-400" />
                        <span>Nacht-Modus (Dark Theme)</span>
                      </label>
                      <select
                        id="auto-theme-night-select"
                        value={autoThemeConfig.nightTheme}
                        onChange={(e) => {
                          const val = e.target.value as AutoThemeNightTarget;
                          const label = THEME_OPTIONS.find((t) => t.id === val)?.name ?? val;
                          handleUpdateAutoTheme(
                            { nightTheme: val },
                            `Nacht-Theme auf „${label}“ umgestellt.`
                          );
                        }}
                        className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                      >
                        {NIGHT_DARK_THEMES.map((nightOpt) => (
                          <option key={nightOpt.id} value={nightOpt.id}>
                            {nightOpt.name} — {nightOpt.description}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Zeitplan-Konfiguration */}
                  {autoThemeConfig.mode === 'time' && (
                    <div className="p-3.5 rounded-xl bg-[#121722] border border-slate-800 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label
                            htmlFor="auto-theme-day-start"
                            className="block text-[11px] font-medium text-slate-300 mb-1"
                          >
                            Wechsel zu Tag-Modus ab
                          </label>
                          <input
                            id="auto-theme-day-start"
                            type="time"
                            value={autoThemeConfig.dayStartTime}
                            onChange={(e) =>
                              handleUpdateAutoTheme(
                                { dayStartTime: e.target.value },
                                `Tag-Beginn auf ${e.target.value} Uhr gesetzt.`
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white focus:outline-none focus:border-amber-400"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="auto-theme-night-start"
                            className="block text-[11px] font-medium text-slate-300 mb-1"
                          >
                            Wechsel zu Dark-Modus ab
                          </label>
                          <input
                            id="auto-theme-night-start"
                            type="time"
                            value={autoThemeConfig.nightStartTime}
                            onChange={(e) =>
                              handleUpdateAutoTheme(
                                { nightStartTime: e.target.value },
                                `Nacht-Beginn auf ${e.target.value} Uhr gesetzt.`
                              )
                            }
                            className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white focus:outline-none focus:border-amber-400"
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-slate-400">Schnellwahl:</span>
                        {[
                          { day: '06:30', night: '18:30', label: '06:30 / 18:30' },
                          { day: '07:00', night: '19:00', label: '07:00 / 19:00' },
                          { day: '08:00', night: '20:00', label: '08:00 / 20:00' },
                        ].map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() =>
                              handleUpdateAutoTheme(
                                { dayStartTime: preset.day, nightStartTime: preset.night },
                                `Zeitplan auf ${preset.label} Uhr gesetzt.`
                              )
                            }
                            className="px-2.5 py-1 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-[11px] font-mono text-slate-200 transition-colors"
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Standort / Sonnenstand-Konfiguration */}
                  {autoThemeConfig.mode === 'location' && (
                    <div className="p-3.5 rounded-xl bg-[#121722] border border-slate-800 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-3 text-xs">
                            <span className="inline-flex items-center gap-1.5 text-amber-300 font-medium tabular-nums">
                              <Sunrise className="w-3.5 h-3.5" />
                              Sonnenaufgang: {autoThemeEval.sunriseLabel || '—'}
                            </span>
                            <span className="inline-flex items-center gap-1.5 text-slate-300 font-medium tabular-nums">
                              <Sunset className="w-3.5 h-3.5 text-amber-400" />
                              Sonnenuntergang: {autoThemeEval.sunsetLabel || '—'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 truncate">
                            {autoThemeConfig.latitude !== null && autoThemeConfig.longitude !== null
                              ? `${autoThemeConfig.locationLabel || 'Standort gespeichert'} · ${autoThemeConfig.latitude.toFixed(4)}°, ${autoThemeConfig.longitude.toFixed(4)}°`
                              : 'Noch keine GPS-Koordinaten hinterlegt — Zeitzonen-Schätzung aktiv.'}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleDetectDeviceLocation()}
                            disabled={geoBusy}
                            className="px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                          >
                            <Navigation className="w-3.5 h-3.5" />
                            <span>
                              {geoBusy ? 'Ermittle Standort...' : 'Gerätestandort ermitteln'}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={handleApplyTimezoneFallbackCoords}
                            disabled={geoBusy}
                            className="px-3 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 transition-colors"
                          >
                            Zeitzonen-Fallback
                          </button>
                        </div>
                      </div>

                      {geoError && (
                        <div
                          role="alert"
                          className="p-2.5 rounded-lg bg-red-950/50 border border-red-800/70 text-[11px] text-red-200 flex items-start gap-2"
                        >
                          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                          <span>{geoError}</span>
                        </div>
                      )}

                      {geoNotice && (
                        <div
                          role="status"
                          className="p-2.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-[11px] text-emerald-200 flex items-start gap-2"
                        >
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{geoNotice}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tageslicht & Hoher Kontrast (Direktauswahl) */}
            <div className="rounded-xl bg-[#0B0E14]/60 border border-slate-800/80 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-display text-xs sm:text-sm font-semibold text-white">
                    Tageslicht &amp; Barrierefreiheit (Light &amp; High Contrast)
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Direkt umschaltbar oder oben über Zeit/Standort automatisch gesteuert
                  </p>
                </div>
                {DAYLIGHT_THEMES.some((t) => t.id === autoThemeEval.targetTheme) && (
                  <span className="text-[11px] font-semibold text-amber-400">Aktiv</span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DAYLIGHT_THEMES.map((themeOpt) => {
                  const active =
                    preferences.theme === themeOpt.id &&
                    customThemeSettings.activeFor === 'none' &&
                    autoThemeConfig.mode === 'off';
                  const autoApplied =
                    autoThemeEval.isAutoActive && autoThemeEval.targetTheme === themeOpt.id;
                  return (
                    <button
                      key={themeOpt.id}
                      type="button"
                      onClick={() => handleSelectTheme(themeOpt.id)}
                      aria-pressed={active || autoApplied}
                      className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors ${
                        active || autoApplied
                          ? 'bg-[#0B0E14] border-amber-400 text-white'
                          : 'bg-[#0B0E14]/70 border-slate-800/80 hover:border-slate-700 text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="flex items-center gap-1 p-1.5 rounded-lg border border-slate-700/80 shrink-0"
                          style={{ backgroundColor: themeOpt.bgHex }}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-sm border border-slate-400/30"
                            style={{ backgroundColor: themeOpt.surfaceHex }}
                          />
                          <span
                            className="w-3.5 h-3.5 rounded-sm"
                            style={{ backgroundColor: themeOpt.accentHex }}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">
                            {themeOpt.name}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {themeOpt.description}
                          </p>
                        </div>
                      </div>
                      {(active || autoApplied) && (
                        <span className="text-[11px] font-semibold text-amber-400 whitespace-nowrap shrink-0">
                          {autoApplied ? 'Auto aktiv' : 'Aktiv'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Bereich Design 1: Alle bisherigen Farbthemen + Freie Farbauswahl */}
            <div className="rounded-xl bg-[#0B0E14]/60 border border-slate-800/80 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-display text-xs sm:text-sm font-semibold text-white">
                    Design 1
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Aktuelles Kino-Design mit {DESIGN_1_THEMES.length} Farbvarianten &amp; freier Farbauswahl
                  </p>
                </div>
                {((DESIGN_1_THEMES.some((t) => t.id === autoThemeEval.targetTheme) &&
                  customThemeSettings.activeFor !== 'design2') ||
                  (!autoThemeEval.isAutoActive && customThemeSettings.activeFor === 'design1')) && (
                  <span className="text-[11px] font-semibold text-amber-400">Aktiv</span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {DESIGN_1_THEMES.map((themeOpt) => {
                  const active =
                    !autoThemeEval.isAutoActive &&
                    preferences.theme === themeOpt.id &&
                    customThemeSettings.activeFor === 'none';
                  const autoApplied =
                    autoThemeEval.isAutoActive && autoThemeEval.targetTheme === themeOpt.id;
                  return (
                    <button
                      key={themeOpt.id}
                      type="button"
                      onClick={() => handleSelectTheme(themeOpt.id)}
                      aria-pressed={active || autoApplied}
                      className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors ${
                        active || autoApplied
                          ? 'bg-[#0B0E14] border-amber-400 text-white'
                          : 'bg-[#0B0E14]/70 border-slate-800/80 hover:border-slate-700 text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="flex items-center gap-1 p-1.5 rounded-lg border border-slate-700/80 shrink-0"
                          style={{ backgroundColor: themeOpt.bgHex }}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-sm"
                            style={{ backgroundColor: themeOpt.surfaceHex }}
                          />
                          <span
                            className="w-3.5 h-3.5 rounded-sm"
                            style={{ backgroundColor: themeOpt.accentHex }}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">
                            {themeOpt.name}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {themeOpt.description}
                          </p>
                        </div>
                      </div>
                      {(active || autoApplied) && (
                        <span className="text-[11px] font-semibold text-amber-400 whitespace-nowrap shrink-0">
                          {autoApplied ? 'Auto aktiv' : 'Aktiv'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Freie Farbauswahl für Design 1 */}
              {(() => {
                const target = 'design1' as const;
                const isCustomActive = customThemeSettings.activeFor === target;
                const palette = customThemeSettings.design1;
                const isExpanded = openCustomPicker.design1;
                return (
                  <div
                    className={`rounded-xl border transition-colors ${
                      isCustomActive
                        ? 'bg-[#0B0E14] border-amber-400/80'
                        : 'bg-[#0B0E14]/65 border-slate-800/80'
                    }`}
                  >
                    <div className="p-3.5 flex flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenCustomPicker((prev) => ({
                            ...prev,
                            design1: !prev.design1,
                          }))
                        }
                        aria-expanded={isExpanded}
                        className="flex items-center gap-3 text-left min-w-0 flex-1"
                      >
                        <div
                          className="flex items-center gap-1 p-1.5 rounded-lg border border-slate-700/80 shrink-0"
                          style={{ backgroundColor: palette.background }}
                        >
                          <span
                            className="w-3 h-3 rounded-sm"
                            style={{ backgroundColor: palette.sidebar }}
                          />
                          <span
                            className="w-3 h-3 rounded-sm"
                            style={{ backgroundColor: palette.surface }}
                          />
                          <span
                            className="w-3 h-3 rounded-sm"
                            style={{ backgroundColor: palette.accent }}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              Freie Farbauswahl
                            </span>
                            {isCustomActive && (
                              <span className="text-[10px] font-semibold text-amber-400">
                                Aktiv
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 truncate">
                            Alle 6 UI-Komponenten frei über die komplette Farbpalette einfärben
                          </p>
                        </div>
                        <ChevronDown
                          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                            isExpanded ? 'rotate-180 text-amber-400' : ''
                          }`}
                        />
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleActivateCustomDesign(target)}
                          className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors inline-flex items-center gap-1.5 ${
                            isCustomActive
                              ? 'bg-amber-400 text-slate-950 border-amber-400'
                              : 'bg-slate-900/90 hover:bg-slate-800 text-slate-200 border-slate-700'
                          }`}
                        >
                          <Pipette className="w-3 h-3" />
                          {isCustomActive ? 'Aktiviert' : 'Aktivieren'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResetCustomColors(target)}
                          title="Standardfarben für Design 1 wiederherstellen"
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-900/80 hover:bg-slate-800 text-slate-300 border border-slate-800 inline-flex items-center gap-1 transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Standard
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-3.5 pb-3.5 pt-3 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {CUSTOM_COLOR_COMPONENTS.map((comp) => {
                          const currentHex = palette[comp.key];
                          const draftKey = `${target}_${comp.key}`;
                          const inputVal = hexDrafts[draftKey] ?? currentHex;
                          return (
                            <div
                              key={comp.key}
                              className="p-3 rounded-xl bg-[#121722]/90 border border-slate-800/80 space-y-2.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-white truncate">
                                    {comp.label}
                                  </p>
                                  <p className="text-[10px] text-slate-400 truncate">
                                    {comp.description}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <label
                                    title={`${comp.label}: Farbpalette öffnen`}
                                    className="relative w-8 h-8 rounded-lg border border-slate-600/80 overflow-hidden cursor-pointer shadow-inner shrink-0"
                                    style={{ backgroundColor: currentHex }}
                                  >
                                    <input
                                      type="color"
                                      value={currentHex}
                                      onChange={(e) =>
                                        handleUpdateCustomColor(
                                          target,
                                          comp.key,
                                          e.target.value,
                                          false
                                        )
                                      }
                                      aria-label={`${comp.label} Farbwähler`}
                                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    />
                                  </label>
                                  <input
                                    type="text"
                                    value={inputVal}
                                    onChange={(e) =>
                                      handleUpdateCustomColor(
                                        target,
                                        comp.key,
                                        e.target.value,
                                        false
                                      )
                                    }
                                    maxLength={7}
                                    spellCheck={false}
                                    aria-label={`${comp.label} Hex-Wert`}
                                    className="w-[78px] px-2 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-700/80 text-[11px] font-mono uppercase text-slate-200 focus:outline-none focus:border-amber-400"
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-12 gap-1">
                                {COMPLETE_COLOR_PALETTE.map((swatchHex) => {
                                  const selected =
                                    currentHex.toUpperCase() === swatchHex.toUpperCase();
                                  return (
                                    <button
                                      key={swatchHex}
                                      type="button"
                                      onClick={() =>
                                        handleUpdateCustomColor(
                                          target,
                                          comp.key,
                                          swatchHex,
                                          true
                                        )
                                      }
                                      title={`${comp.label}: ${swatchHex}`}
                                      aria-label={`${comp.label} ${swatchHex}`}
                                      className={`h-5 rounded-md border transition-transform hover:scale-110 ${
                                        selected
                                          ? 'border-white ring-2 ring-amber-400/80 scale-105'
                                          : 'border-white/15'
                                      }`}
                                      style={{ backgroundColor: swatchHex }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Bereich Design 2: Grau, Silber & Glassy + Freie Farbauswahl */}
            <div className="rounded-xl bg-gradient-to-br from-slate-700/25 via-slate-800/35 to-slate-900/40 backdrop-blur-md border border-slate-400/25 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-display text-xs sm:text-sm font-semibold text-slate-100">
                    Design 2
                  </h4>
                  <p className="text-[11px] text-slate-300">
                    Grau, Silber &amp; Glassy — halbtransparente Glas-Optik mit freier Farbauswahl
                  </p>
                </div>
                {((DESIGN_2_THEMES.some((t) => t.id === autoThemeEval.targetTheme) &&
                  customThemeSettings.activeFor !== 'design1') ||
                  (!autoThemeEval.isAutoActive && customThemeSettings.activeFor === 'design2')) && (
                  <span className="text-[11px] font-semibold text-slate-200">Aktiv</span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {DESIGN_2_THEMES.map((themeOpt) => {
                  const active =
                    !autoThemeEval.isAutoActive &&
                    preferences.theme === themeOpt.id &&
                    customThemeSettings.activeFor === 'none';
                  const autoApplied =
                    autoThemeEval.isAutoActive && autoThemeEval.targetTheme === themeOpt.id;
                  return (
                    <button
                      key={themeOpt.id}
                      type="button"
                      onClick={() => handleSelectTheme(themeOpt.id)}
                      aria-pressed={active || autoApplied}
                      className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between gap-3 backdrop-blur-md transition-colors ${
                        active || autoApplied
                          ? 'bg-slate-600/40 border-slate-200/70 text-white shadow-lg'
                          : 'bg-slate-700/25 border-slate-400/25 hover:border-slate-300/50 text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="flex items-center gap-1 p-1.5 rounded-lg border border-slate-300/35 shrink-0 backdrop-blur-sm"
                          style={{
                            background:
                              'linear-gradient(135deg, rgba(148,163,184,0.35), rgba(30,41,59,0.75))',
                          }}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-sm border border-white/25"
                            style={{ backgroundColor: 'rgba(148, 163, 184, 0.45)' }}
                          />
                          <span
                            className="w-3.5 h-3.5 rounded-sm"
                            style={{ backgroundColor: themeOpt.accentHex }}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">
                            {themeOpt.name}
                          </p>
                          <p className="text-[11px] text-slate-300 truncate">
                            {themeOpt.description}
                          </p>
                        </div>
                      </div>
                      {(active || autoApplied) && (
                        <span className="text-[11px] font-semibold text-slate-100 whitespace-nowrap shrink-0">
                          {autoApplied ? 'Auto aktiv' : 'Aktiv'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Freie Farbauswahl für Design 2 (mit Glas-Effekt) */}
              {(() => {
                const target = 'design2' as const;
                const isCustomActive = customThemeSettings.activeFor === target;
                const palette = customThemeSettings.design2;
                const isExpanded = openCustomPicker.design2;
                return (
                  <div
                    className={`rounded-xl border backdrop-blur-md transition-colors ${
                      isCustomActive
                        ? 'bg-slate-600/35 border-slate-200/65 shadow-lg'
                        : 'bg-slate-800/35 border-slate-400/25'
                    }`}
                  >
                    <div className="p-3.5 flex flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenCustomPicker((prev) => ({
                            ...prev,
                            design2: !prev.design2,
                          }))
                        }
                        aria-expanded={isExpanded}
                        className="flex items-center gap-3 text-left min-w-0 flex-1"
                      >
                        <div
                          className="flex items-center gap-1 p-1.5 rounded-lg border border-slate-300/35 shrink-0 backdrop-blur-sm"
                          style={{ backgroundColor: palette.background }}
                        >
                          <span
                            className="w-3 h-3 rounded-sm border border-white/20"
                            style={{ backgroundColor: palette.sidebar }}
                          />
                          <span
                            className="w-3 h-3 rounded-sm border border-white/20"
                            style={{ backgroundColor: palette.surface }}
                          />
                          <span
                            className="w-3 h-3 rounded-sm"
                            style={{ backgroundColor: palette.accent }}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              Freie Farbauswahl
                            </span>
                            {isCustomActive && (
                              <span className="text-[10px] font-semibold text-slate-100">
                                Aktiv
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-300 truncate">
                            Alle 6 Glas-Komponenten frei über die komplette Farbpalette anpassen
                          </p>
                        </div>
                        <ChevronDown
                          className={`w-4 h-4 text-slate-300 shrink-0 transition-transform ${
                            isExpanded ? 'rotate-180 text-white' : ''
                          }`}
                        />
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleActivateCustomDesign(target)}
                          className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors inline-flex items-center gap-1.5 ${
                            isCustomActive
                              ? 'bg-slate-100 text-slate-950 border-slate-100'
                              : 'bg-slate-700/60 hover:bg-slate-600/70 text-slate-100 border-slate-300/30'
                          }`}
                        >
                          <Pipette className="w-3 h-3" />
                          {isCustomActive ? 'Aktiviert' : 'Aktivieren'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResetCustomColors(target)}
                          title="Standardfarben für Design 2 wiederherstellen"
                          className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800/65 hover:bg-slate-700/75 text-slate-200 border border-slate-400/25 inline-flex items-center gap-1 transition-colors"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Standard
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-3.5 pb-3.5 pt-3 border-t border-slate-400/20 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {CUSTOM_COLOR_COMPONENTS.map((comp) => {
                          const currentHex = palette[comp.key];
                          const draftKey = `${target}_${comp.key}`;
                          const inputVal = hexDrafts[draftKey] ?? currentHex;
                          return (
                            <div
                              key={comp.key}
                              className="p-3 rounded-xl bg-slate-800/45 backdrop-blur-md border border-slate-400/20 space-y-2.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-white truncate">
                                    {comp.label}
                                  </p>
                                  <p className="text-[10px] text-slate-300 truncate">
                                    {comp.description}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <label
                                    title={`${comp.label}: Farbpalette öffnen`}
                                    className="relative w-8 h-8 rounded-lg border border-slate-300/40 overflow-hidden cursor-pointer shadow-inner shrink-0"
                                    style={{ backgroundColor: currentHex }}
                                  >
                                    <input
                                      type="color"
                                      value={currentHex}
                                      onChange={(e) =>
                                        handleUpdateCustomColor(
                                          target,
                                          comp.key,
                                          e.target.value,
                                          false
                                        )
                                      }
                                      aria-label={`${comp.label} Farbwähler`}
                                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    />
                                  </label>
                                  <input
                                    type="text"
                                    value={inputVal}
                                    onChange={(e) =>
                                      handleUpdateCustomColor(
                                        target,
                                        comp.key,
                                        e.target.value,
                                        false
                                      )
                                    }
                                    maxLength={7}
                                    spellCheck={false}
                                    aria-label={`${comp.label} Hex-Wert`}
                                    className="w-[78px] px-2 py-1.5 rounded-lg bg-slate-900/60 border border-slate-400/30 text-[11px] font-mono uppercase text-slate-100 focus:outline-none focus:border-slate-200"
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-12 gap-1">
                                {COMPLETE_COLOR_PALETTE.map((swatchHex) => {
                                  const selected =
                                    currentHex.toUpperCase() === swatchHex.toUpperCase();
                                  return (
                                    <button
                                      key={swatchHex}
                                      type="button"
                                      onClick={() =>
                                        handleUpdateCustomColor(
                                          target,
                                          comp.key,
                                          swatchHex,
                                          true
                                        )
                                      }
                                      title={`${comp.label}: ${swatchHex}`}
                                      aria-label={`${comp.label} ${swatchHex}`}
                                      className={`h-5 rounded-md border transition-transform hover:scale-110 ${
                                        selected
                                          ? 'border-white ring-2 ring-slate-200/90 scale-105'
                                          : 'border-white/20'
                                      }`}
                                      style={{ backgroundColor: swatchHex }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </section>

      {/* Unterpunkt 3: Startbildschirm-Reihenfolge (alle Rubriken frei sortierbar & einzeln ausblendbar) */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('homeOrder')}
          aria-expanded={openSections.homeOrder}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <LayoutList className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Startbildschirm-Reihenfolge
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {hiddenHomeSections.length > 0
                  ? `${hiddenHomeSections.length} ausgeblendet · `
                  : 'Alle sichtbar · '}
                {normalizedHomeOrder
                  .filter((k) => !hiddenHomeSet.has(k))
                  .map((k) => HOME_ROW_META[k]?.label)
                  .filter(Boolean)
                  .join(' → ') || 'Alle Rubriken ausgeblendet'}
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.homeOrder ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.homeOrder && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-400">
                Sortiere alle Rubriken auf deiner Startseite per Pfeiltasten oder Drag &amp; Drop
                und blende jeden Menüpunkt bei Bedarf einzeln aus.
              </p>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {hiddenHomeSections.length > 0 && (
                  <button
                    type="button"
                    onClick={handleShowAllHomeSections}
                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-amber-300 hover:text-amber-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Alle einblenden</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleResetAppearance}
                  className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Standard</span>
                </button>
              </div>
            </div>

            <div className="space-y-2.5 p-3.5 rounded-xl bg-[#0B0E14] border border-slate-800/80">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Kopfbereich auf der Startseite
                </span>
                <span className="text-[11px] text-slate-500">Standard: Aus</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <div
                  className={`p-3 rounded-xl bg-[#121722] border flex items-center justify-between gap-3 transition-opacity ${
                    showHomeCategoryTabs
                      ? 'border-slate-700/80'
                      : 'border-slate-800/70 opacity-80'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <LayoutGrid className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">
                        Rubrikenauswahl
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {showHomeCategoryTabs
                          ? 'Leiste (Alle Reihen, Filme, Serien, …) sichtbar'
                          : 'Standardmäßig ausgeblendet'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleHomeCategoryTabs}
                    aria-pressed={showHomeCategoryTabs}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      !showHomeCategoryTabs
                        ? 'bg-amber-400/15 border-amber-400/50 text-amber-300 hover:bg-amber-400/25'
                        : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                    }`}
                  >
                    {showHomeCategoryTabs ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>Ausblenden</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" />
                        <span>Einblenden</span>
                      </>
                    )}
                  </button>
                </div>

                <div
                  className={`p-3 rounded-xl bg-[#121722] border flex items-center justify-between gap-3 transition-opacity ${
                    showHomeFilterSearch
                      ? 'border-slate-700/80'
                      : 'border-slate-800/70 opacity-80'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Search className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">
                        Suche, Genre-Filter &amp; Sortierung
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {showHomeFilterSearch
                          ? 'Suchleiste unter der Rubrikenauswahl sichtbar'
                          : 'Standardmäßig ausgeblendet'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleHomeFilterSearch}
                    aria-pressed={showHomeFilterSearch}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      !showHomeFilterSearch
                        ? 'bg-amber-400/15 border-amber-400/50 text-amber-300 hover:bg-amber-400/25'
                        : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                    }`}
                  >
                    {showHomeFilterSearch ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>Ausblenden</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" />
                        <span>Einblenden</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              {/* Frei sortierbare Startbildschirm-Reihen */}
              {normalizedHomeOrder.map((rowKey, idx) => {
                const meta = HOME_ROW_META[rowKey];
                if (!meta) return null;
                const Icon = meta.icon;
                const isDragged = draggedKey === rowKey;
                const isDragOver = dragOverKey === rowKey && draggedKey !== rowKey;
                const isHidden = hiddenHomeSet.has(rowKey);
                const disabledByDuckSettings =
                  !duckAssistantEnabled &&
                  (rowKey === 'ask_duck' || rowKey === 'recommendations');
                return (
                  <div
                    key={rowKey}
                    draggable
                    onDragStart={() => setDraggedKey(rowKey)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragOverKey !== rowKey) setDragOverKey(rowKey);
                    }}
                    onDragLeave={() => {
                      if (dragOverKey === rowKey) setDragOverKey(null);
                    }}
                    onDrop={() => handleDropHomeRow(rowKey)}
                    onDragEnd={() => {
                      setDraggedKey(null);
                      setDragOverKey(null);
                    }}
                    className={`p-3.5 rounded-xl bg-[#0B0E14] border flex items-center justify-between gap-3 transition-all cursor-grab active:cursor-grabbing ${
                      isDragOver
                        ? 'border-amber-400 bg-amber-400/5'
                        : isDragged
                          ? 'border-amber-400/50 opacity-60'
                          : isHidden || disabledByDuckSettings
                            ? 'border-slate-800/60 opacity-60 hover:opacity-90'
                            : 'border-slate-800/80 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-7 h-7 rounded-lg bg-[#121722] border border-slate-800 text-slate-300 font-mono text-xs font-semibold flex items-center justify-center shrink-0 tabular-nums">
                        {idx + 1}
                      </span>
                      <GripVertical className="w-4 h-4 text-slate-500 shrink-0" />
                      <Icon className="w-4 h-4 text-amber-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">{meta.label}</p>
                        <p className="text-[11px] text-slate-400 truncate">
                          {disabledByDuckSettings
                            ? 'Über Enten-Assistent-Einstellungen ausgeschaltet'
                            : isHidden
                              ? 'Auf der Startseite ausgeblendet'
                              : meta.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleHomeSectionVisibility(rowKey, meta.label)}
                        aria-pressed={!isHidden}
                        title={
                          isHidden
                            ? `${meta.label} auf Startseite einblenden`
                            : `${meta.label} auf Startseite ausblenden`
                        }
                        aria-label={
                          isHidden
                            ? `${meta.label} auf Startseite einblenden`
                            : `${meta.label} auf Startseite ausblenden`
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                          isHidden
                            ? 'bg-amber-400/15 border-amber-400/50 text-amber-300 hover:bg-amber-400/25'
                            : 'bg-[#121722] border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                        }`}
                      >
                        {isHidden ? (
                          <>
                            <Eye className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Einblenden</span>
                          </>
                        ) : (
                          <>
                            <EyeOff className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Ausblenden</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveHomeRow(idx, -1)}
                        disabled={idx === 0}
                        title={`${meta.label} nach oben verschieben`}
                        aria-label={`${meta.label} nach oben verschieben`}
                        className="p-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-35 disabled:pointer-events-none border border-slate-800 text-slate-300 hover:text-white transition-colors"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveHomeRow(idx, 1)}
                        disabled={idx === normalizedHomeOrder.length - 1}
                        title={`${meta.label} nach unten verschieben`}
                        aria-label={`${meta.label} nach unten verschieben`}
                        className="p-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-35 disabled:pointer-events-none border border-slate-800 text-slate-300 hover:text-white transition-colors"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {prefsError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{prefsError}</span>
              </div>
            )}

            {prefsNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{prefsNotice}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Unterpunkt: Einstellung Enten Player */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('entenPlayer')}
          aria-expanded={openSections.entenPlayer}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <PlayCircle className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Einstellung Enten Player
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5 tabular-nums">
                Bedienelemente:{' '}
                {currentControlsTimeoutSec === 0
                  ? 'Dauerhaft'
                  : `${currentControlsTimeoutSec} Sek.`}{' '}
                · Zurück: {formatSeekDurationLabel(currentSeekBackwardSec)} · Vor:{' '}
                {formatSeekDurationLabel(currentSeekForwardSec)}
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.entenPlayer ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.entenPlayer && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
            <p className="text-xs text-slate-400 leading-relaxed">
              Lege fest, wie lange die Bedienelemente im Enten Player eingeblendet bleiben und
              welche Sprungweite beim Vorspulen und Zurückspulen verwendet wird.
            </p>

            {/* Anzeigedauer der Bedienelemente */}
            <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      Anzeigedauer der Bedienelemente
                    </h4>
                    <p className="text-[11px] text-slate-400">
                      Zeitspanne, bis sich Steuerung, Uhrzeit &amp; Endzeit im Enten Player bei
                      laufender Wiedergabe automatisch ausblenden.
                    </p>
                  </div>
                </div>
                <span className="px-2.5 py-1 rounded-md bg-[#121722] border border-slate-700 font-mono text-xs font-semibold text-amber-400 tabular-nums shrink-0">
                  {currentControlsTimeoutSec === 0
                    ? 'Immer sichtbar'
                    : `${currentControlsTimeoutSec} Sek.`}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {CONTROLS_TIMEOUT_PRESETS.map((preset) => {
                  const active = currentControlsTimeoutSec === preset.seconds;
                  return (
                    <button
                      key={preset.seconds}
                      type="button"
                      disabled={savingPrefs}
                      onClick={() =>
                        handleUpdateEntenPlayerSettings(
                          { playerControlsTimeoutSec: preset.seconds },
                          preset.seconds === 0
                            ? 'Bedienelemente im Enten Player bleiben jetzt dauerhaft sichtbar.'
                            : `Anzeigedauer der Bedienelemente auf ${preset.seconds} Sekunden gesetzt.`
                        )
                      }
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                          : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sprungweite beim Vorspulen und Zurückspulen */}
            <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <h4 className="text-xs sm:text-sm font-semibold text-white">
                      Sprungweite beim Vorspulen &amp; Zurückspulen
                    </h4>
                    <p className="text-[11px] text-slate-400">
                      Bestimmt den Zeitsprung für die Player-Buttons und die Pfeiltasten (Links /
                      Rechts).
                    </p>
                  </div>
                </div>
              </div>

              {/* Schnellwahl für beide Richtungen */}
              <div className="space-y-2">
                <p className="text-[11px] font-medium text-slate-300">
                  Schnellauswahl (für Vorspulen &amp; Zurückspulen gleichzeitig)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SEEK_STEP_PRESETS.map((step) => {
                    const active =
                      currentSeekBackwardSec === step.seconds &&
                      currentSeekForwardSec === step.seconds;
                    return (
                      <button
                        key={step.seconds}
                        type="button"
                        disabled={savingPrefs}
                        onClick={() =>
                          handleUpdateEntenPlayerSettings(
                            {
                              playerSeekBackwardSec: step.seconds,
                              playerSeekForwardSec: step.seconds,
                            },
                            `Sprungweite für Vor- und Zurückspulen auf ${step.label} gesetzt.`
                          )
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                          active
                            ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                            : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200'
                        }`}
                      >
                        {step.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Individuelle Auswahl für Zurückspulen & Vorspulen */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 space-y-2">
                  <label
                    htmlFor="enten-player-seek-back"
                    className="flex items-center justify-between gap-2 text-xs font-semibold text-white"
                  >
                    <span className="flex items-center gap-1.5">
                      <SkipBack className="w-3.5 h-3.5 text-amber-400" />
                      <span>Zurückspulen-Sprung</span>
                    </span>
                    <span className="font-mono text-amber-400 tabular-nums">
                      -{formatSeekDurationLabel(currentSeekBackwardSec)}
                    </span>
                  </label>
                  <select
                    id="enten-player-seek-back"
                    disabled={savingPrefs}
                    value={currentSeekBackwardSec}
                    onChange={(e) => {
                      const nextSec = Number(e.target.value);
                      handleUpdateEntenPlayerSettings(
                        { playerSeekBackwardSec: nextSec },
                        `Zurückspulen-Sprung auf ${formatSeekDurationLabel(nextSec)} gesetzt.`
                      );
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {SEEK_STEP_PRESETS.map((step) => (
                      <option key={step.seconds} value={step.seconds}>
                        -{step.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-3 rounded-xl bg-[#121722] border border-slate-800 space-y-2">
                  <label
                    htmlFor="enten-player-seek-forward"
                    className="flex items-center justify-between gap-2 text-xs font-semibold text-white"
                  >
                    <span className="flex items-center gap-1.5">
                      <SkipForward className="w-3.5 h-3.5 text-amber-400" />
                      <span>Vorspulen-Sprung</span>
                    </span>
                    <span className="font-mono text-amber-400 tabular-nums">
                      +{formatSeekDurationLabel(currentSeekForwardSec)}
                    </span>
                  </label>
                  <select
                    id="enten-player-seek-forward"
                    disabled={savingPrefs}
                    value={currentSeekForwardSec}
                    onChange={(e) => {
                      const nextSec = Number(e.target.value);
                      handleUpdateEntenPlayerSettings(
                        { playerSeekForwardSec: nextSec },
                        `Vorspulen-Sprung auf ${formatSeekDurationLabel(nextSec)} gesetzt.`
                      );
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-700 text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {SEEK_STEP_PRESETS.map((step) => (
                      <option key={step.seconds} value={step.seconds}>
                        +{step.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {prefsError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{prefsError}</span>
              </div>
            )}

            {prefsNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{prefsNotice}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Unterpunkt 4: Audio- & MP3-Player-Einstellung */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('audio')}
          aria-expanded={openSections.audio}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <Headphones className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Audio
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                MP3- &amp; Musikwiedergabe:{' '}
                {currentAudioMode === 'external' ? 'Externer Player' : 'Enten Player'}
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.audio ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.audio && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-4">
            <p className="text-xs text-slate-400 leading-relaxed">
              Lege fest, ob MP3s und andere Musikdateien direkt im integrierten Enten Player oder
              über einen externen Audio-Player (z. B. VLC, foobar2000, AIMP oder System-Player)
              abgespielt werden sollen.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={savingPrefs}
                onClick={() => handleSelectAudioPlayerMode('internal')}
                aria-pressed={currentAudioMode === 'internal'}
                className={`p-4 rounded-xl border text-left transition-all flex items-start gap-3 ${
                  currentAudioMode === 'internal'
                    ? 'bg-amber-400/10 border-amber-400 ring-1 ring-amber-400/35'
                    : 'bg-[#0B0E14] border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <span
                  className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${
                    currentAudioMode === 'internal'
                      ? 'bg-amber-400 border-amber-300 text-slate-950'
                      : 'bg-[#121722] border-slate-800 text-amber-400'
                  }`}
                >
                  <PlayCircle className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">Enten Player</span>
                    {currentAudioMode === 'internal' && (
                      <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Spielt MP3s und Alben direkt im Enten Player ab — inklusive Warteschlange und
                    Wiedergabefortschritt auf dem NAS.
                  </p>
                </div>
              </button>

              <button
                type="button"
                disabled={savingPrefs}
                onClick={() => handleSelectAudioPlayerMode('external')}
                aria-pressed={currentAudioMode === 'external'}
                className={`p-4 rounded-xl border text-left transition-all flex items-start gap-3 ${
                  currentAudioMode === 'external'
                    ? 'bg-amber-400/10 border-amber-400 ring-1 ring-amber-400/35'
                    : 'bg-[#0B0E14] border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <span
                  className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${
                    currentAudioMode === 'external'
                      ? 'bg-amber-400 border-amber-300 text-slate-950'
                      : 'bg-[#121722] border-slate-800 text-amber-400'
                  }`}
                >
                  <ExternalLink className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">Externer Player</span>
                    {currentAudioMode === 'external' && (
                      <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Öffnet MP3-Dateien per M3U-Übergabe und NAS-Direktpfad in deinem installierten
                    externen Musik-Player.
                  </p>
                </div>
              </button>
            </div>

            {prefsError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{prefsError}</span>
              </div>
            )}

            {prefsNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{prefsNotice}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Unterpunkt 4: Google Drive Profil-Backup */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('driveBackup')}
          aria-expanded={openSections.driveBackup}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <Cloud className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                Google Drive Profil-Backup
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {googleAccessToken
                  ? `Verbunden mit ${googleUser?.email || googleUser?.displayName || 'Google'} · Manuell sichern`
                  : 'Profilinformationen manuell als JSON auf Google Drive sichern'}
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.driveBackup ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.driveBackup && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
            <p className="text-xs text-slate-400 leading-relaxed">
              Sichere deine Profilinformationen (Benutzername, Anzeigename, Rolle, Profilbild,
              Design- &amp; Startbildschirm-Reihenfolge sowie Watchlist- und Favoriten-Übersicht)
              jederzeit manuell als{' '}
              <code className="font-mono text-amber-300">
                {getProfileBackupFileName(user.username)}
              </code>{' '}
              auf deinem Google Drive. Passwörter werden niemals exportiert.
            </p>

            {!googleAccessToken ? (
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <p className="text-xs font-semibold text-white">
                    {googleUser
                      ? `Google-Konto (${googleUser.email || googleUser.displayName}) erneut autorisieren`
                      : 'Mit Google Drive verbinden'}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {googleUser
                      ? 'Aus Sicherheitsgründen wird das Drive-Token nur im Arbeitsspeicher gehalten. Bitte kurz neu anmelden.'
                      : 'Es wird ausschließlich Zugriff auf Dateien erteilt, die EntenCenter selbst auf Google Drive erstellt.'}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleConnect}
                  disabled={driveAuthBusy}
                  className="px-4 py-2.5 rounded-lg bg-white hover:bg-slate-100 disabled:opacity-60 border border-slate-300 text-slate-900 text-xs font-semibold flex items-center gap-2.5 shadow-sm transition-colors whitespace-nowrap shrink-0"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                    />
                  </svg>
                  <span>
                    {driveAuthBusy ? 'Verbinde mit Google...' : 'Sign in with Google'}
                  </span>
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {googleUser?.photoURL ? (
                      <img
                        src={googleUser.photoURL}
                        alt={googleUser.displayName || 'Google Konto'}
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0"
                      />
                    ) : (
                      <span className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 flex items-center justify-center shrink-0">
                        <Cloud className="w-4 h-4" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">
                        {googleUser?.displayName || 'Google-Konto verbunden'}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {googleUser?.email || 'Drive-Dateizugriff aktiv'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void refreshDriveFileStatus(googleAccessToken)}
                      disabled={driveChecking || driveSaving}
                      title="Google-Drive-Status aktualisieren"
                      className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${driveChecking ? 'animate-spin text-amber-400' : ''}`}
                      />
                      <span>Prüfen</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleGoogleDisconnect}
                      disabled={driveAuthBusy || driveSaving}
                      className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Trennen</span>
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <p className="text-xs font-semibold text-white">
                      {driveChecking
                        ? 'Suche vorhandene Profil-Sicherung auf Google Drive...'
                        : driveExistingFile
                          ? `Vorhandene Sicherung: ${driveExistingFile.name}`
                          : 'Noch keine Profil-Sicherung auf Google Drive vorhanden'}
                    </p>
                    <p className="text-[11px] text-slate-400 tabular-nums">
                      {driveExistingFile?.modifiedTime
                        ? `Zuletzt gesichert am ${new Date(
                            driveExistingFile.modifiedTime
                          ).toLocaleString('de-DE')}`
                        : `Ziel-Dateiname: ${getProfileBackupFileName(user.username)}`}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleManualDriveBackup()}
                    disabled={driveSaving || driveChecking}
                    className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                  >
                    <CloudUpload className="w-4 h-4" />
                    <span>
                      {driveSaving
                        ? 'Speichere auf Google Drive...'
                        : 'Profilinformationen auf Google Drive speichern'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {driveError && (
              <div
                role="alert"
                className="p-3.5 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2.5"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{driveError}</span>
              </div>
            )}

            {driveNotice && (
              <div
                role="status"
                className="p-3.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>{driveNotice}</span>
                </div>
                {driveLastSavedFile?.webViewLink && (
                  <a
                    href={driveLastSavedFile.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-emerald-900/50 hover:bg-emerald-900/80 border border-emerald-700/70 text-xs font-medium text-emerald-100 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>In Google Drive öffnen</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Einziger gebündelter NAS-Punkt: NAS-Einstellungen mit auf- & zuklappbaren Unterpunkten */}
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('nasSettings')}
          aria-expanded={openSections.nasSettings}
          className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <Server className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
                NAS-Einstellungen
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5 tabular-nums">
                {storage
                  ? storage.totalBytes > 0
                    ? `${formatStorageBytes(storage.freeBytes)} frei (${formatStorageBytes(storage.totalBytes)} gesamt)`
                    : `${formatStorageBytes(storage.scannedTotalBytes || storage.usedBytes)} erfasst`
                  : 'Speicherbelegung'}{' '}
                ·{' '}
                {syncMode === 'manual'
                  ? 'Scan: Manuell'
                  : syncMode === 'every_start'
                    ? 'Scan: Bei jedem Start'
                    : 'Scan: 1. Start/Tag'}{' '}
                · {NAS_PROTOCOL_OPTIONS.find((p) => p.id === nasConn.protocol)?.shortLabel ?? 'SMB'} · Sicherheit
              </p>
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
              openSections.nasSettings ? 'rotate-180 text-amber-400' : ''
            }`}
          />
        </button>

        {openSections.nasSettings && (
          <div className="px-6 pb-6 pt-4 border-t border-slate-800/80">
            <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800/80 bg-[#0B0E14] overflow-hidden">
              {/* NAS-Unterpunkt 1: NAS-Speicherbelegung */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleNasSub('storage')}
                  aria-expanded={nasSubOpen.storage}
                  className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                      <HardDrive className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-white truncate">
                        NAS-Speicherbelegung
                      </h4>
                      <p className="text-xs text-slate-400 truncate mt-0.5 tabular-nums">
                        {storage
                          ? storage.totalBytes > 0
                            ? `${formatStorageBytes(storage.freeBytes)} frei · ${formatStorageBytes(
                                storage.usedBytes
                              )} / ${formatStorageBytes(storage.totalBytes)} belegt`
                            : `${formatStorageBytes(storage.scannedTotalBytes || storage.usedBytes)} auf NAS erfasst (${storage.moviesCount} Filme · ${storage.seriesCount} Serien)`
                          : 'Freier vs. belegter Speicher & Mediathek-Index'}
                      </p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      nasSubOpen.storage ? 'rotate-180 text-amber-400' : ''
                    }`}
                  />
                </button>

                {nasSubOpen.storage && (
                  <div className="border-t border-slate-800/80">
                    <div className="px-4 py-3 bg-[#0F141E] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-400 truncate tabular-nums">
                <span className="font-mono text-slate-300">
                  {storage?.mountPath ??
                    resolveProfileBridgeContext().backendRoot ??
                    '/EntenCenter-Backend'}
                </span>
                {storage?.volumeSource && (
                  <>
                    <span className="mx-1.5 text-slate-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-emerald-300">{storage.volumeSource}</span>
                  </>
                )}
                {storage?.measuredAt && (
                  <>
                    <span className="mx-1.5 text-slate-600" aria-hidden="true">
                      ·
                    </span>
                    <span>
                      Stand {new Date(storage.measuredAt).toLocaleTimeString('de-DE')}
                    </span>
                  </>
                )}
              </p>

              <button
                type="button"
                onClick={onRefreshStorage}
                disabled={storageLoading}
                className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-amber-400 ${storageLoading ? 'animate-spin' : ''}`}
                />
                <span>{storageLoading ? 'Messe...' : 'Aktualisieren'}</span>
              </button>
            </div>

            {storage ? (
              <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-800/80">
                {/* Links: Physischer NAS-Speicher (Frei vs. Belegt) */}
                <div className="lg:col-span-7 p-6 space-y-4">
                  {storage.totalBytes > 0 ? (
                    <>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <p className="text-xs text-slate-400">
                            Physisches NAS-Volume
                            {storage.volumeSource ? ` (${storage.volumeSource})` : ''}
                          </p>
                          <p className="font-display text-xl sm:text-2xl font-bold text-white tabular-nums mt-0.5">
                            {formatStorageBytes(storage.freeBytes)}{' '}
                            <span className="text-sm font-normal text-emerald-400">
                              frei ({storage.freePercent.toFixed(1).replace('.', ',')} %)
                            </span>
                          </p>
                        </div>
                        <p className="text-xs font-mono text-slate-300 tabular-nums">
                          {formatStorageBytes(storage.usedBytes)} /{' '}
                          {formatStorageBytes(storage.totalBytes)} belegt
                        </p>
                      </div>

                      {/* Dual-Track Balken: Belegter vs. Freier Speicher */}
                      <div
                        className="h-3 w-full rounded-full bg-[#0B0E14] border border-slate-800/90 overflow-hidden flex"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={storage.usedPercent}
                        aria-label="NAS Speicherbelegung"
                      >
                        <div
                          className="h-full bg-amber-400 transition-all duration-300"
                          style={{
                            width:
                              storage.usedBytes > 0
                                ? `${Math.max(1.5, Math.min(100, storage.usedPercent))}%`
                                : '0%',
                          }}
                        />
                        <div className="h-full flex-1 bg-emerald-500/20" />
                      </div>

                      <div className="grid grid-cols-3 gap-4 pt-1 text-xs">
                        <div>
                          <p className="text-slate-400 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-sm bg-amber-400 shrink-0" />
                            <span>Belegter Speicher</span>
                          </p>
                          <p className="font-mono text-sm font-semibold text-white tabular-nums mt-1">
                            {formatStorageBytes(storage.usedBytes)}
                          </p>
                          <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                            {storage.usedPercent.toFixed(1).replace('.', ',')} % belegt
                          </p>
                        </div>

                        <div>
                          <p className="text-slate-400 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-sm bg-emerald-400 shrink-0" />
                            <span>Freier Speicher</span>
                          </p>
                          <p className="font-mono text-sm font-semibold text-emerald-300 tabular-nums mt-1">
                            {formatStorageBytes(storage.freeBytes)}
                          </p>
                          <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                            {storage.freePercent.toFixed(1).replace('.', ',')} % verfügbar
                          </p>
                        </div>

                        <div>
                          <p className="text-slate-400">Gesamtkapazität</p>
                          <p className="font-mono text-sm font-semibold text-slate-200 tabular-nums mt-1">
                            {formatStorageBytes(storage.totalBytes)}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {storage.scannedFilesCount
                              ? `${storage.scannedFilesCount} Dateien erfasst`
                              : 'NAS-Dateisystem'}
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <p className="text-xs text-slate-400">NAS Storage-Bridge Volume</p>
                          <p className="font-display text-lg sm:text-xl font-bold text-white tabular-nums mt-0.5">
                            {formatStorageBytes(storage.scannedTotalBytes || storage.usedBytes)}{' '}
                            <span className="text-xs font-normal text-emerald-400">
                              erfasst &amp; synchronisiert
                            </span>
                          </p>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[11px] font-mono text-emerald-300">
                          SMB / FRITZ!NAS
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Klicke auf <span className="text-amber-300 font-semibold">Aktualisieren</span> oder{' '}
                        <span className="text-amber-300 font-semibold">NAS jetzt scannen</span>, um die
                        vollständige TB/GB-Kapazität deines FRITZ!NAS-Datenträgers unter{' '}
                        <span className="font-mono text-emerald-300">{storage.mountPath}</span>{' '}
                        abzurufen.
                      </p>
                      <div className="grid grid-cols-3 gap-4 pt-1 text-xs">
                        <div>
                          <p className="text-slate-400">Erfasste Daten</p>
                          <p className="font-mono text-sm font-semibold text-white tabular-nums mt-1">
                            {formatStorageBytes(storage.scannedTotalBytes || storage.usedBytes)}
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-400">Filme / Videos</p>
                          <p className="font-mono text-sm font-semibold text-amber-300 tabular-nums mt-1">
                            {storage.moviesCount} Titel
                          </p>
                        </div>
                        <div>
                          <p className="text-slate-400">Serien / Episoden</p>
                          <p className="font-mono text-sm font-semibold text-sky-300 tabular-nums mt-1">
                            {storage.seriesCount} · {storage.episodesCount}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Rechts: Aufschlüsselung nach NAS-Medienkatalog, Musik/Bildern & Vault */}
                <div className="lg:col-span-5 p-6 bg-[#0F141E] space-y-4">
                  {(() => {
                    const musicBytes = storage.musicBytes ?? 0;
                    const imagesBytes = storage.imagesBytes ?? 0;
                    const otherFilesBytes = storage.otherFilesBytes ?? 0;
                    const catalogTotal = Math.max(
                      1,
                      storage.moviesBytes +
                        storage.seriesBytes +
                        musicBytes +
                        imagesBytes +
                        otherFilesBytes +
                        storage.vaultBytes
                    );
                    const moviePct = (storage.moviesBytes / catalogTotal) * 100;
                    const seriesPct = (storage.seriesBytes / catalogTotal) * 100;
                    const musicPct = (musicBytes / catalogTotal) * 100;
                    const imagesPct = (imagesBytes / catalogTotal) * 100;
                    const otherPct = ((otherFilesBytes + storage.vaultBytes) / catalogTotal) * 100;

                    return (
                      <>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-xs font-semibold text-white">
                            NAS-Inhalte &amp; Mediathek
                          </p>
                          <span className="text-xs font-mono text-amber-300 tabular-nums">
                            {formatStorageBytes(
                              Math.max(
                                storage.scannedTotalBytes ?? 0,
                                storage.moviesBytes +
                                  storage.seriesBytes +
                                  musicBytes +
                                  imagesBytes +
                                  otherFilesBytes +
                                  storage.vaultBytes
                              )
                            )}{' '}
                            erfasst
                          </span>
                        </div>

                        <div className="h-2.5 w-full rounded-full bg-[#0B0E14] border border-slate-800/90 overflow-hidden flex">
                          <div
                            className="h-full bg-amber-400"
                            style={{ width: `${moviePct}%` }}
                            title={`Filme & Videos: ${formatStorageBytes(storage.moviesBytes)}`}
                          />
                          <div
                            className="h-full bg-sky-400"
                            style={{ width: `${seriesPct}%` }}
                            title={`Serien: ${formatStorageBytes(storage.seriesBytes)}`}
                          />
                          {musicBytes > 0 && (
                            <div
                              className="h-full bg-fuchsia-400"
                              style={{ width: `${musicPct}%` }}
                              title={`Musik: ${formatStorageBytes(musicBytes)}`}
                            />
                          )}
                          {imagesBytes > 0 && (
                            <div
                              className="h-full bg-teal-400"
                              style={{ width: `${imagesPct}%` }}
                              title={`Bilder: ${formatStorageBytes(imagesBytes)}`}
                            />
                          )}
                          <div
                            className="h-full bg-emerald-400"
                            style={{ width: `${Math.max(1, otherPct)}%` }}
                            title={`Sonstiges & Vault: ${formatStorageBytes(otherFilesBytes + storage.vaultBytes)}`}
                          />
                        </div>

                        <div className="divide-y divide-slate-800/70 text-xs">
                          <div className="py-2 flex items-center justify-between gap-3">
                            <span className="text-slate-300 flex items-center gap-2 min-w-0 truncate">
                              <span className="w-2 h-2 rounded-sm bg-amber-400 shrink-0" />
                              <span className="truncate">
                                Filme &amp; Videos ({storage.moviesCount} Titel)
                              </span>
                            </span>
                            <span className="font-mono text-white tabular-nums shrink-0">
                              {formatStorageBytes(storage.moviesBytes)}
                            </span>
                          </div>

                          <div className="py-2 flex items-center justify-between gap-3">
                            <span className="text-slate-300 flex items-center gap-2 min-w-0 truncate">
                              <span className="w-2 h-2 rounded-sm bg-sky-400 shrink-0" />
                              <span className="truncate">
                                Serien ({storage.seriesCount} · {storage.episodesCount} Folgen)
                              </span>
                            </span>
                            <span className="font-mono text-white tabular-nums shrink-0">
                              {formatStorageBytes(storage.seriesBytes)}
                            </span>
                          </div>

                          {(storage.musicCount ?? 0) > 0 && (
                            <div className="py-2 flex items-center justify-between gap-3">
                              <span className="text-slate-300 flex items-center gap-2 min-w-0 truncate">
                                <span className="w-2 h-2 rounded-sm bg-fuchsia-400 shrink-0" />
                                <span className="truncate">
                                  Musik / Audio ({storage.musicCount} Titel)
                                </span>
                              </span>
                              <span className="font-mono text-white tabular-nums shrink-0">
                                {formatStorageBytes(musicBytes)}
                              </span>
                            </div>
                          )}

                          {(storage.imagesCount ?? 0) > 0 && (
                            <div className="py-2 flex items-center justify-between gap-3">
                              <span className="text-slate-300 flex items-center gap-2 min-w-0 truncate">
                                <span className="w-2 h-2 rounded-sm bg-teal-400 shrink-0" />
                                <span className="truncate">
                                  Fotos / Bilder ({storage.imagesCount} Dateien)
                                </span>
                              </span>
                              <span className="font-mono text-white tabular-nums shrink-0">
                                {formatStorageBytes(imagesBytes)}
                              </span>
                            </div>
                          )}

                          <div className="pt-2 flex items-center justify-between gap-3">
                            <span className="text-slate-300 flex items-center gap-2 min-w-0 truncate">
                              <span className="w-2 h-2 rounded-sm bg-emerald-400 shrink-0" />
                              <span className="truncate">
                                {(storage.otherFilesCount ?? 0) > 0
                                  ? `Sonstige (${storage.otherFilesCount}) & NAS-Vault`
                                  : 'NAS-Vault (JSON & WAL)'}
                              </span>
                            </span>
                            <span className="font-mono text-emerald-300 tabular-nums shrink-0">
                              {formatStorageBytes(otherFilesBytes + storage.vaultBytes)}
                            </span>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <div className="p-6 text-xs text-slate-400">
                Speicherdaten des NAS werden geladen...
              </div>
            )}
                  </div>
                )}
              </div>

              {/* NAS-Unterpunkt 2: Synchronisation & Scan */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleNasSub('scan')}
                  aria-expanded={nasSubOpen.scan}
                  className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                      <RefreshCw className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-white truncate">
                        Synchronisation &amp; Scan
                      </h4>
                      <p className="text-xs text-slate-400 truncate mt-0.5 tabular-nums">
                        {syncMode === 'manual'
                          ? 'Modus: Manuell'
                          : syncMode === 'every_start'
                            ? 'Modus: Bei jedem App-Start'
                            : 'Modus: Erster Start des Tages'}
                        {lastScanTs && ` · Letzter Scan ${new Date(lastScanTs).toLocaleTimeString('de-DE')}`}
                      </p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      nasSubOpen.scan ? 'rotate-180 text-amber-400' : ''
                    }`}
                  />
                </button>

                {nasSubOpen.scan && (
                  <div className="px-4 pb-5 pt-4 border-t border-slate-800/80 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-slate-400">
                        Lege fest, wann EntenCenter neue Filme und Serienfolgen automatisch auf deinem NAS einliest.
                      </p>
                      {lastScanTs && (
                        <span className="text-xs font-mono text-slate-300 tabular-nums">
                          Letzter Scan: {new Date(lastScanTs).toLocaleString('de-DE')}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(
                  [
                    {
                      id: 'manual',
                      label: 'Manuelles Scannen',
                      desc: 'Nur bei Klick auf „NAS jetzt scannen“',
                    },
                    {
                      id: 'every_start',
                      label: 'Bei jedem App-Start',
                      desc: 'Scannt das NAS automatisch bei jedem Öffnen der App',
                    },
                    {
                      id: 'daily_first',
                      label: 'Erster Start des Tages',
                      desc: 'Scannt automatisch einmal täglich beim ersten Öffnen',
                    },
                  ] as const
                ).map((opt) => {
                  const active = syncMode === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => void onUpdateSyncMode(opt.id)}
                      aria-pressed={active}
                      className={`text-left p-4 rounded-xl border transition-colors flex flex-col justify-between gap-2 ${
                        active
                          ? 'bg-amber-400/10 border-amber-400/70 text-white'
                          : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">{opt.label}</span>
                        {active && <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => void onRunNasScan()}
                          disabled={scanningNas}
                          className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${scanningNas ? 'animate-spin' : ''}`} />
                          <span>{scanningNas ? 'Scanne NAS...' : 'NAS jetzt scannen'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

              {/* NAS-Unterpunkt 3: Anmeldung (gängigste NAS-Anmeldewege & Zugangsdaten) */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleNasSub('auth')}
                  aria-expanded={nasSubOpen.auth}
                  className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                      <KeyRound className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-white truncate">Anmeldung</h4>
                      <p className="text-xs text-slate-400 truncate mt-0.5 tabular-nums">
                        {nasConnLoading
                          ? 'Lade NAS-Anmeldedaten...'
                          : nasConn.host
                            ? `${
                                NAS_PROTOCOL_OPTIONS.find((p) => p.id === nasConn.protocol)?.label ??
                                nasConn.protocol.toUpperCase()
                              } · ${nasConn.host}${nasConn.port ? `:${nasConn.port}` : ''}${
                                nasConn.hasSecret ? ' · Zugangsdaten hinterlegt' : ''
                              }`
                            : `Unterstützte NAS-Anmeldewege (${visibleNasProtocolOptions
                                .map((p) => p.shortLabel)
                                .join(', ')})`}
                      </p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      nasSubOpen.auth ? 'rotate-180 text-amber-400' : ''
                    }`}
                  />
                </button>

                {nasSubOpen.auth && (
                  <form
                    onSubmit={(e) => void handleSaveNasConnection(e, false)}
                    className="px-4 pb-5 pt-4 border-t border-slate-800/80 space-y-5"
                  >
                  {/* Automatische NAS-Erkennung im Heimnetz (mDNS / Bonjour & SSDP) */}
                  <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-3.5 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                          <Radar className={`w-3.5 h-3.5 text-emerald-400 ${nasDiscoveryScanning ? 'animate-spin' : ''}`} />
                          <span>Automatische Netzwerk-Erkennung (mDNS / Bonjour)</span>
                        </span>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Findet verfügbare NAS-Geräte (Synology, QNAP, TrueNAS, Unraid, FRITZ!Box, EntenCenter) inklusive passender Ports automatisch.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRunNasNetworkDiscovery()}
                        disabled={nasDiscoveryScanning}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 border border-emerald-500/40 text-xs font-medium text-emerald-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <Radar className={`w-3.5 h-3.5 ${nasDiscoveryScanning ? 'animate-spin' : ''}`} />
                        <span>{nasDiscoveryScanning ? 'Suche NAS...' : 'Heimnetz scannen'}</span>
                      </button>
                    </div>

                    {nasDiscoverySummary && (
                      <p className="text-[11px] text-slate-300">{nasDiscoverySummary}</p>
                    )}

                    {nasDiscoveryDevices.length > 0 && (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
                        {nasDiscoveryDevices.map((dev) => {
                          const storageServices = dev.services.filter((s) => s.protocol !== 'entencenter');
                          return (
                            <div
                              key={`profile-disc-${dev.id}`}
                              className="rounded-lg bg-[#121722] border border-slate-800 p-2.5 flex flex-col gap-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs font-semibold text-white">{dev.name}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                      {dev.vendor}
                                    </span>
                                  </div>
                                  <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                                    {dev.hostname !== dev.ip ? `${dev.hostname} · ${dev.ip}` : dev.ip}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => applyDiscoveredNasToForm(dev)}
                                  className="px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-slate-950 text-[11px] font-semibold transition-colors whitespace-nowrap"
                                >
                                  Übernehmen
                                </button>
                              </div>
                              {storageServices.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {storageServices.map((svc) => (
                                    <button
                                      key={`profile-svc-${dev.id}-${svc.protocol}-${svc.port}`}
                                      type="button"
                                      onClick={() => applyDiscoveredNasToForm(dev, svc)}
                                      className="px-2 py-0.5 rounded bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[10px] font-mono text-amber-200 transition-colors"
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
                  </div>

                  {/* Auswahl des Anmeldewegs */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-xs font-medium text-slate-300 block">
                        Anmeldeweg / NAS-Protokoll wählen
                      </label>
                      <span className="text-[11px] text-slate-400">
                        {visibleNasProtocolOptions.length} von {NAS_PROTOCOL_OPTIONS.length}{' '}
                        freigegeben
                      </span>
                    </div>

                    {!allowedNasProtocols.includes(nasConn.protocol) && (
                      <div
                        role="status"
                        className="p-2.5 rounded-lg bg-amber-400/10 border border-amber-400/40 text-xs text-amber-200 flex items-center gap-2"
                      >
                        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>
                          Dein bisher gewählter Anmeldeweg ({nasConn.protocol.toUpperCase()}) wurde
                          vom Administrator deaktiviert. Bitte wähle einen der freigegebenen Wege.
                        </span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {visibleNasProtocolOptions.map((proto) => {
                        const selected = nasConn.protocol === proto.id;
                        return (
                          <button
                            key={proto.id}
                            type="button"
                            onClick={() => handleSelectNasProtocol(proto.id)}
                            aria-pressed={selected}
                            className={`text-left p-3 rounded-xl border transition-colors flex flex-col justify-between gap-1.5 ${
                              selected
                                ? 'bg-amber-400/10 border-amber-400/70 text-white'
                                : 'bg-[#121722] border-slate-800 text-slate-300 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-white">
                                {proto.label}
                              </span>
                              <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                                :{proto.defaultPort}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-snug">
                              {proto.description}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Zugangsdaten-Formular */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="nas-conn-host"
                        className="text-xs font-medium text-slate-300 flex items-center gap-1.5"
                      >
                        <Globe className="w-3.5 h-3.5 text-amber-400" />
                        <span>
                          {nasConn.protocol === 'webdav' || nasConn.protocol === 'api_token'
                            ? 'NAS-Server-URL / Host'
                            : 'NAS Host / IP-Adresse'}
                        </span>
                      </label>
                      <input
                        id="nas-conn-host"
                        type="text"
                        value={nasConn.host}
                        onChange={(e) => setNasConn({ ...nasConn, host: e.target.value })}
                        placeholder={
                          nasConn.protocol === 'fritz_upnp'
                            ? 'fritz.box oder 192.168.178.1'
                            : nasConn.protocol === 'webdav'
                              ? 'https://nas.mein-netz.de'
                              : nasConn.protocol === 'api_token'
                                ? 'https://192.168.178.50'
                                : '192.168.178.50 oder entencenter-nas.local'
                        }
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-conn-port"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          Port
                        </label>
                        <input
                          id="nas-conn-port"
                          type="text"
                          value={nasConn.port}
                          onChange={(e) => setNasConn({ ...nasConn, port: e.target.value })}
                          placeholder="445"
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400 tabular-nums"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-conn-path"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          {nasConn.protocol === 'smb'
                            ? 'Freigabe (Share)'
                            : nasConn.protocol === 'nfs'
                              ? 'Export-Pfad'
                              : 'Medien-Pfad'}
                        </label>
                        <input
                          id="nas-conn-path"
                          type="text"
                          value={nasConn.shareOrPath}
                          onChange={(e) => setNasConn({ ...nasConn, shareOrPath: e.target.value })}
                          placeholder="/Medien"
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm font-mono text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                        />
                      </div>
                    </div>

                    {/* Protokoll-spezifische Felder */}
                    {nasConn.protocol === 'smb' && (
                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-conn-domain"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          Arbeitsgruppe / Domäne
                        </label>
                        <input
                          id="nas-conn-domain"
                          type="text"
                          value={nasConn.domainOrWorkgroup ?? 'WORKGROUP'}
                          onChange={(e) =>
                            setNasConn({ ...nasConn, domainOrWorkgroup: e.target.value })
                          }
                          placeholder="WORKGROUP"
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                        />
                      </div>
                    )}

                    {nasConn.protocol === 'nfs' && (
                      <>
                        <div className="space-y-1.5">
                          <label
                            htmlFor="nas-nfs-version"
                            className="text-xs font-medium text-slate-300 block"
                          >
                            NFS-Version
                          </label>
                          <select
                            id="nas-nfs-version"
                            value={nasConn.nfsVersion ?? 'NFSv4.1'}
                            onChange={(e) =>
                              setNasConn({
                                ...nasConn,
                                nfsVersion: e.target.value as NasConnectionConfig['nfsVersion'],
                              })
                            }
                            className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-400"
                          >
                            <option value="NFSv4.1">NFSv4.1 (Empfohlen)</option>
                            <option value="NFSv4">NFSv4</option>
                            <option value="NFSv3">NFSv3</option>
                          </select>
                        </div>

                        <div className="space-y-1.5">
                          <label
                            htmlFor="nas-nfs-auth"
                            className="text-xs font-medium text-slate-300 block"
                          >
                            NFS-Authentifizierung
                          </label>
                          <select
                            id="nas-nfs-auth"
                            value={nasConn.nfsAuthMode ?? 'AUTH_SYS'}
                            onChange={(e) =>
                              setNasConn({
                                ...nasConn,
                                nfsAuthMode: e.target.value as NasConnectionConfig['nfsAuthMode'],
                              })
                            }
                            className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-400"
                          >
                            <option value="AUTH_SYS">AUTH_SYS (UID/GID im LAN)</option>
                            <option value="Kerberos (krb5p)">Kerberos (krb5p verschlüsselt)</option>
                          </select>
                        </div>
                      </>
                    )}

                    {nasConn.protocol === 'webdav' && (
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-slate-300 block">
                          Transportverschlüsselung
                        </span>
                        <label className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-slate-200 cursor-pointer">
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
                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-sftp-mode"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          SFTP-Anmeldeart
                        </label>
                        <select
                          id="nas-sftp-mode"
                          value={nasConn.sftpAuthMode ?? 'password'}
                          onChange={(e) =>
                            setNasConn({
                              ...nasConn,
                              sftpAuthMode: e.target.value as NasConnectionConfig['sftpAuthMode'],
                            })
                          }
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-400"
                        >
                          <option value="password">Benutzername &amp; Passwort</option>
                          <option value="ssh_key">SSH-Schlüssel (Ed25519 / RSA)</option>
                        </select>
                      </div>
                    )}

                    {nasConn.protocol === 'ftps' && (
                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-ftps-mode"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          FTPS-Verschlüsselung
                        </label>
                        <select
                          id="nas-ftps-mode"
                          value={nasConn.ftpsTlsMode ?? 'explicit'}
                          onChange={(e) =>
                            setNasConn({
                              ...nasConn,
                              ftpsTlsMode: e.target.value as NasConnectionConfig['ftpsTlsMode'],
                            })
                          }
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-400"
                        >
                          <option value="explicit">Explizites TLS (FTPES · Port 21)</option>
                          <option value="implicit">Implizites TLS (FTPS · Port 990)</option>
                        </select>
                      </div>
                    )}

                    {nasConn.protocol === 'api_token' && (
                      <div className="space-y-1.5">
                        <label
                          htmlFor="nas-api-vendor"
                          className="text-xs font-medium text-slate-300 block"
                        >
                          NAS-Betriebssystem
                        </label>
                        <select
                          id="nas-api-vendor"
                          value={nasConn.apiVendor ?? 'Synology DSM'}
                          onChange={(e) =>
                            setNasConn({
                              ...nasConn,
                              apiVendor: e.target.value as NasConnectionConfig['apiVendor'],
                            })
                          }
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-400"
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
                      <div className="sm:col-span-2 rounded-xl bg-emerald-500/10 border border-emerald-500/35 p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />
                            <span className="text-xs sm:text-sm font-semibold text-white">
                              FRITZ!Box / FRITZ!NAS (UPnP / Challenge-Response)
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {['fritz.box', 'fritz.nas', '192.168.178.1'].map((presetHost) => (
                              <button
                                key={presetHost}
                                type="button"
                                onClick={() => setNasConn({ ...nasConn, host: presetHost })}
                                className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors ${
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
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Wenn deine FRITZ!Box vor dem FRITZ!NAS-Zugriff eine Anmeldung verlangt,
                          trage hier deinen FRITZ!Box-Benutzernamen (optional) und das{' '}
                          <strong className="text-white">Passwort für die FRITZ!Box</strong> ein. Bei
                          HTTPS-Zertifikatsfehlern im Heimnetz weicht die App automatisch auf lokales
                          HTTP (:80) aus.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <label
                              htmlFor="nas-fritz-user"
                              className="text-xs font-medium text-slate-300 flex items-center gap-1.5"
                            >
                              <User className="w-3.5 h-3.5 text-emerald-400" />
                              <span>FRITZ!Box Benutzername (optional)</span>
                            </label>
                            <input
                              id="nas-fritz-user"
                              type="text"
                              value={nasConn.username}
                              onChange={(e) => setNasConn({ ...nasConn, username: e.target.value })}
                              placeholder="z. B. fritz1234 oder leer lassen"
                              autoComplete="off"
                              className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label
                              htmlFor="nas-fritz-secret"
                              className="text-xs font-medium text-slate-300 flex items-center justify-between gap-2"
                            >
                              <span className="flex items-center gap-1.5">
                                <Lock className="w-3.5 h-3.5 text-emerald-400" />
                                <span>Passwort für die FRITZ!Box</span>
                              </span>
                              {nasConn.hasSecret && (
                                <span className="text-[11px] text-emerald-400">
                                  Gespeichert
                                </span>
                              )}
                            </label>
                            <div className="relative">
                              <input
                                id="nas-fritz-secret"
                                type={showNasConnSecret ? 'text' : 'password'}
                                value={nasConnSecret}
                                onChange={(e) => setNasConnSecret(e.target.value)}
                                placeholder={
                                  nasConn.hasSecret
                                    ? '•••••••••••• (leer lassen, um bestehendes zu behalten)'
                                    : 'Passwort für die FRITZ!Box eingeben'
                                }
                                autoComplete="new-password"
                                className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-400"
                              />
                              <button
                                type="button"
                                onClick={() => setShowNasConnSecret((s) => !s)}
                                aria-label={
                                  showNasConnSecret ? 'Passwort verbergen' : 'Passwort anzeigen'
                                }
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                              >
                                {showNasConnSecret ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>

                        <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            checked={Boolean(nasConn.useTls)}
                            onChange={(e) => setNasConn({ ...nasConn, useTls: e.target.checked })}
                            className="accent-emerald-400 rounded"
                          />
                          <span>
                            HTTPS bevorzugen (mit automatischem HTTP-Fallback :80 bei Zertifikatsfehlern im LAN)
                          </span>
                        </label>
                      </div>
                    ) : (
                      <>
                        {/* Benutzername */}
                        <div className="space-y-1.5">
                          <label
                            htmlFor="nas-conn-user"
                            className="text-xs font-medium text-slate-300 flex items-center gap-1.5"
                          >
                            <User className="w-3.5 h-3.5 text-amber-400" />
                            <span>
                              {nasConn.protocol === 'api_token'
                                ? 'NAS-Benutzer / Client-ID'
                                : nasConn.protocol === 'nfs' && nasConn.nfsAuthMode === 'AUTH_SYS'
                                  ? 'Benutzer / UID:GID (optional bei AUTH_SYS)'
                                  : 'NAS-Benutzername'}
                            </span>
                          </label>
                          <input
                            id="nas-conn-user"
                            type="text"
                            value={nasConn.username}
                            onChange={(e) => setNasConn({ ...nasConn, username: e.target.value })}
                            placeholder={
                              nasConn.protocol === 'nfs' && nasConn.nfsAuthMode === 'AUTH_SYS'
                                ? '1000:1000'
                                : 'z. B. entencenter_nas'
                            }
                            autoComplete="off"
                            className="w-full px-3.5 py-2.5 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                          />
                        </div>

                        {/* Passwort / API-Token / SSH-Key */}
                        <div className="space-y-1.5">
                          <label
                            htmlFor="nas-conn-secret"
                            className="text-xs font-medium text-slate-300 flex items-center justify-between gap-2"
                          >
                            <span className="flex items-center gap-1.5">
                              <Lock className="w-3.5 h-3.5 text-amber-400" />
                              <span>
                                {nasConn.protocol === 'api_token'
                                  ? 'API-Token / App-Schlüssel'
                                  : nasConn.protocol === 'sftp' && nasConn.sftpAuthMode === 'ssh_key'
                                    ? 'SSH-Private-Key / Passphrase'
                                    : 'NAS-Passwort'}
                              </span>
                            </span>
                            {nasConn.hasSecret && (
                              <span className="text-[11px] text-emerald-400">
                                Verschlüsselt gespeichert
                              </span>
                            )}
                          </label>
                          <div className="relative">
                            <input
                              id="nas-conn-secret"
                              type={showNasConnSecret ? 'text' : 'password'}
                              value={nasConnSecret}
                              onChange={(e) => setNasConnSecret(e.target.value)}
                              placeholder={
                                nasConn.hasSecret
                                  ? '•••••••••••• (leer lassen, um bestehendes zu behalten)'
                                  : 'Zugangspasswort oder Token eingeben'
                              }
                              autoComplete="new-password"
                              className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[#121722] border border-slate-800 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-400"
                            />
                            <button
                              type="button"
                              onClick={() => setShowNasConnSecret((s) => !s)}
                              aria-label={
                                showNasConnSecret ? 'Passwort verbergen' : 'Passwort anzeigen'
                              }
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                            >
                              {showNasConnSecret ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>

                        {(nasConn.host.toLowerCase().includes('fritz') ||
                          nasConn.host.startsWith('192.168.178.') ||
                          nasConn.hasFritzSecret ||
                          Boolean(nasFritzExtraSecret) ||
                          showExtraFritzField) ? (
                          <div className="sm:col-span-2 rounded-xl bg-sky-500/10 border border-sky-500/35 p-3.5 space-y-1.5">
                            <label
                              htmlFor="nas-conn-fritz-extra-secret"
                              className="text-xs font-semibold text-sky-200 flex items-center justify-between gap-2"
                            >
                              <span className="flex items-center gap-1.5">
                                <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                                <span>Passwort für die FRITZ!Box (falls zusätzlich benötigt)</span>
                              </span>
                              {nasConn.hasFritzSecret && (
                                <span className="text-[11px] text-sky-300">Gespeichert</span>
                              )}
                            </label>
                            <div className="relative">
                              <input
                                id="nas-conn-fritz-extra-secret"
                                type={showNasFritzExtraSecret ? 'text' : 'password'}
                                value={nasFritzExtraSecret}
                                onChange={(e) => setNasFritzExtraSecret(e.target.value)}
                                placeholder="Separates Passwort für die FRITZ!Box (falls vom Router verlangt)"
                                autoComplete="new-password"
                                className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[#121722] border border-sky-500/40 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
                              />
                              <button
                                type="button"
                                onClick={() => setShowNasFritzExtraSecret((s) => !s)}
                                aria-label="Passwort für die FRITZ!Box anzeigen"
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                              >
                                {showNasFritzExtraSecret ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="sm:col-span-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => setShowExtraFritzField(true)}
                              className="text-xs text-sky-300 hover:text-sky-200 underline underline-offset-2"
                            >
                              + Passwort für die FRITZ!Box zusätzlich eingeben
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {nasConnError && (
                    <div
                      role="alert"
                      className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
                    >
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{nasConnError}</span>
                    </div>
                  )}

                  {nasConnNotice && (
                    <div
                      role="status"
                      className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{nasConnNotice}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {nasConn.hasSecret && (
                        <button
                          type="button"
                          onClick={(e) => void handleSaveNasConnection(e, true)}
                          disabled={nasConnSaving}
                          className="px-3 py-2 rounded-lg bg-[#121722] hover:bg-rose-950/50 border border-slate-800 hover:border-rose-700/60 text-xs font-medium text-slate-300 hover:text-rose-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Passwort löschen</span>
                        </button>
                      )}
                      {nasConn.updatedAt && (
                        <span className="text-[11px] text-slate-500 tabular-nums">
                          Zuletzt gespeichert:{' '}
                          {new Date(nasConn.updatedAt).toLocaleString('de-DE')}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 ml-auto">
                      <button
                        type="button"
                        onClick={() => void handleTestNasConnection()}
                        disabled={nasConnTesting || nasConnSaving}
                        className="px-3.5 py-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 text-amber-400 ${
                            nasConnTesting ? 'animate-spin' : ''
                          }`}
                        />
                        <span>{nasConnTesting ? 'Prüfe...' : 'Verbindung prüfen'}</span>
                      </button>

                      <button
                        type="submit"
                        disabled={nasConnSaving}
                        className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>
                          {nasConnSaving ? 'Speichere...' : 'Anmeldedaten speichern'}
                        </span>
                      </button>
                    </div>
                  </div>
                  </form>
                )}
              </div>

              {/* NAS-Unterpunkt 4: NAS-Speicherung & Sicherheitshinweise */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleNasSub('security')}
                  aria-expanded={nasSubOpen.security}
                  className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-white truncate">
                        NAS-Speicherung &amp; Sicherheitshinweise
                      </h4>
                      <p className="text-xs text-slate-400 truncate mt-0.5">
                        Zentrale Datenmigration bei Namensänderung &amp; gesalzener scrypt-Hash
                      </p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
                      nasSubOpen.security ? 'rotate-180 text-amber-400' : ''
                    }`}
                  />
                </button>

                {nasSubOpen.security && (
                  <div className="px-4 pb-5 pt-4 border-t border-slate-800/80 space-y-4 text-xs text-slate-300 leading-relaxed">
                    {/* Automatischer NAS-Profilordner & Schreibrechte */}
                    <div className="rounded-xl bg-[#0B0E14] border border-slate-800 p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />
                          <span className="text-xs sm:text-sm font-semibold text-white">
                            Automatischer NAS-Profilordner &amp; Schreibrechte
                          </span>
                        </div>
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                            profileFolder?.writable || user.hasNasWriteAccess || user.role === 'admin'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                              : 'bg-slate-900 text-slate-400 border-slate-700'
                          }`}
                        >
                          {user.hasNasWriteAccess || user.role === 'admin'
                            ? 'Schreibrechte aktiv (Lesen & Schreiben)'
                            : 'Standard-Zugriff (Lesen)'}
                        </span>
                      </div>

                      {profileFolder ? (
                        <div className="space-y-1.5 text-[11px] text-slate-300">
                          <p>
                            <span className="text-slate-400">NAS-Pfad: </span>
                            <span className="font-mono text-white">{profileFolder.nasMountPath}</span>
                          </p>
                          <p className="break-all">
                            <span className="text-slate-400">Speicherziel: </span>
                            <span className="font-mono text-slate-200">{profileFolder.diskPath}</span>
                          </p>
                          <p>
                            <span className="text-slate-400">Unterordner: </span>
                            <span className="font-mono text-slate-200">
                              {profileFolder.subfolders.join(', ')} (inkl. profile.json &amp; profile-data.json)
                            </span>
                          </p>
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-400">
                          {profileFolderLoading
                            ? 'Lade NAS-Profilordner...'
                            : 'Der persönliche NAS-Profilordner wird beim Anmelden automatisch angelegt.'}
                        </p>
                      )}

                      {profileFolderError && (
                        <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800/80 text-[11px] text-rose-200 flex items-center gap-2">
                          <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          <span>{profileFolderError}</span>
                        </div>
                      )}
                      {profileFolderNotice && (
                        <div className="p-2.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-[11px] text-emerald-200 flex items-center gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span>{profileFolderNotice}</span>
                        </div>
                      )}
                      {nasQuickUploadError && (
                        <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800/80 text-[11px] text-rose-200 flex items-center gap-2">
                          <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          <span>{nasQuickUploadError}</span>
                        </div>
                      )}
                      {nasQuickUploadNotice && (
                        <div className="p-2.5 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-[11px] text-emerald-200 flex items-center gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span>{nasQuickUploadNotice}</span>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => void handleEnsureProfileFolder()}
                          disabled={profileFolderLoading}
                          className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 text-amber-400 ${
                              profileFolderLoading ? 'animate-spin' : ''
                            }`}
                          />
                          <span>Profilordner prüfen &amp; synchronisieren</span>
                        </button>

                        {isLocalFallbackToken(token) && !profileSetupDone && (
                          <button
                            type="button"
                            onClick={() => void handleFinishProfileSetupManually(false)}
                            disabled={profileSetupBusy}
                            className="px-3 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Profileinrichtung abschließen &amp; beenden</span>
                          </button>
                        )}

                        {(user.hasNasWriteAccess || user.role === 'admin') && (
                          <>
                            <button
                              type="button"
                              onClick={() => nasQuickUploadInputRef.current?.click()}
                              disabled={nasQuickUploadBusy}
                              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 border border-emerald-500/40 text-[11px] font-semibold text-emerald-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                            >
                              <Upload className="w-3.5 h-3.5 text-emerald-300" />
                              <span>
                                {nasQuickUploadBusy
                                  ? 'Schreibe aufs NAS...'
                                  : 'Datei direkt aufs NAS schreiben'}
                              </span>
                            </button>
                            <input
                              ref={nasQuickUploadInputRef}
                              type="file"
                              onChange={handleQuickNasFileUpload}
                              className="hidden"
                            />
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-start gap-3">
                      <HardDrive className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                      <p>
                        <span className="font-medium text-white">Zentrale NAS-Migration:</span> Bei einer
                        Änderung des Benutzernamens werden Watch-Verlauf, Serienkalender-Favoriten, Watchlist,
                        Darstellungs-Präferenzen und Benachrichtigungen automatisch auf das neue Kürzel
                        übertragen.
                      </p>
                    </div>
                    <div className="flex items-start gap-3">
                      <ShieldCheck className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                      <p>
                        <span className="font-medium text-white">Sichere NAS-Speicherung:</span> Das neue
                        Passwort wird ausschließlich als gesalzener scrypt-Hash auf dem NAS gespeichert; deine
                        aktive Anmeldung bleibt dabei mit dem neuen Token erhalten.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Unterpunkt: Smart Home (Google Home & Amazon Alexa) */}
      <SmartHomeSection
        user={user}
        token={token}
        isOpen={openSections.smartHome}
        onToggleOpen={() => toggleSection('smartHome')}
        libraryItems={libraryItems}
        liveRemoteState={smartHomeState}
        onRemoteStateChange={onSmartHomeStateChange}
      />

      {/* Bestätigungsdialog vor Überschreiben einer bestehenden Google-Drive-Sicherung */}
      {pendingOverwrite && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-overwrite-title"
        >
          <div className="w-full max-w-[min(28rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] overflow-y-auto overscroll-contain bg-[#121722] border border-slate-700 rounded-2xl p-5 sm:p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
                <CloudUpload className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                <h3
                  id="drive-overwrite-title"
                  className="font-display text-base font-semibold text-white"
                >
                  Bestehende Sicherung überschreiben?
                </h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Auf deinem Google Drive existiert bereits die Datei{' '}
                  <span className="font-mono text-slate-200">
                    {pendingOverwrite.existingFile.name}
                  </span>
                  {pendingOverwrite.existingFile.modifiedTime
                    ? ` (Stand: ${new Date(
                        pendingOverwrite.existingFile.modifiedTime
                      ).toLocaleString('de-DE')})`
                    : ''}
                  . Möchtest du sie mit deinen aktuellen Profilinformationen überschreiben?
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setPendingOverwrite(null)}
                disabled={driveSaving}
                className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmOverwriteDriveBackup()}
                disabled={driveSaving}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
              >
                {driveSaving ? 'Überschreibe...' : 'Jetzt überschreiben'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
