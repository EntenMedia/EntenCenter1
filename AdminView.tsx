import React, { useCallback, useEffect, useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudUpload,
  Crown,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
  HardDrive,
  Plus,
  KeyRound,
  Save,
  Upload,
  FileUp,
  Film,
  Tv,
  Image as ImageIcon,
  Music,
  Video,
  FileText,
  Play,
  Download,
  Pencil,
  Search,
  FolderOpen,
  Loader2,
  RotateCcw,
  Sparkles,
  Bell,
  Send,
  Wrench,
  Megaphone,
  Wifi,
  ChevronDown,
  ChevronRight,
  Check,
  Folder,
  ArrowUp,
} from 'lucide-react';
import {
  DEFAULT_ASSISTANT_AVATAR_URL,
  MARCENTE_ASSETS,
  resolveAssistantAvatarSrc,
} from '../data/coverAssets';
import { AssistantAvatarImage } from './AssistantAvatarImage';
import {
  ADMIN_NOTIFICATION_TYPE_OPTIONS,
  ALL_NAS_PROTOCOLS,
  AdminBroadcastNotificationSummary,
  AdminNasCatalogItem,
  AdminNotificationMessageType,
  CloudStorageProvider,
  EncryptedCloudVaultEnvelope,
  FSK_LEVELS,
  FskLevel,
  MediaKind,
  NAS_PROTOCOL_CATALOG,
  NasBrowseTreeResult,
  NasMediaItem,
  NasProtocolId,
  NasScanFolderMode,
  NasScanFolderSettings,
  NasUser,
  UserDataStorageConfig,
  UserDataStorageMode,
  UserDataVaultPreview,
} from '../types/marcente';
import {
  CLOUD_VAULT_FILE_NAME,
  clearInMemoryDriveToken,
  downloadEncryptedCloudVaultFile,
  DriveBackupFileInfo,
  findEncryptedCloudVaultFile,
  GoogleDriveAuthExpiredError,
  signInWithGoogleForDrive,
  signOutGoogleForDrive,
  subscribeGoogleAuth,
  uploadEncryptedCloudVaultFile,
} from '../lib/googleDriveBackup';
import { FritzDiscoverySettings } from './FritzDiscoverySettings';
import { AdminNetworkConfigSection } from './AdminNetworkConfigSection';
import { AdminNasPathSettings } from './AdminNasPathSettings';
import { isLocalFallbackToken, readLocalOnboardingBuffer } from '../lib/localBufferStore';
import {
  browseNasDirectoryTree,
  discoverAndHydrateBackendFromNasBridge,
  inferMimeTypeFromPath,
  readFileFromNasBridge,
  readLocalBridgeCatalog,
  readLocalBridgeScanSettings,
  resolvePlayableNasMediaUrl,
  sanitizeNasPortForProtocol,
  saveLocalBridgeCatalog,
  saveLocalBridgeScanSettings,
  stripEphemeralMediaUrlForCatalog,
  uploadBinaryFileToNasBridge,
  upsertLocalBridgeCatalogItems,
  writeFileToNasBridge,
} from '../lib/nasClient';

interface AdminProfileEntry {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'family';
  fskLimit: FskLevel;
  createdAt?: string;
  avatarColor: string;
  avatarUrl?: string | null;
}

const FSK_DESCRIPTIONS: Record<FskLevel, string> = {
  0: 'FSK 0 · Nur Inhalte ab 0 Jahren (Kleinkind)',
  6: 'FSK 6 · Inhalte von FSK 0 bis 6',
  12: 'FSK 12 · Kinderprofil (Inhalte von FSK 0 bis 12)',
  16: 'FSK 16 · Inhalte von FSK 0 bis 16',
  18: 'FSK 18 · Alle Inhalte unbeschränkt freigegeben',
};

export type AdminSectionTab =
  | 'all'
  | 'notifications'
  | 'assistant'
  | 'content'
  | 'profiles'
  | 'network'
  | 'paths'
  | 'auth'
  | 'storage';

type CollapsibleAdminSectionKey =
  | 'notifications'
  | 'assistant'
  | 'profiles'
  | 'network'
  | 'paths'
  | 'auth'
  | 'storage'
  | 'contentScanFolders'
  | 'contentUpload'
  | 'contentManual'
  | 'contentCatalog';

const DEFAULT_COLLAPSED_SECTIONS: Record<CollapsibleAdminSectionKey, boolean> = {
  notifications: false,
  assistant: false,
  profiles: false,
  network: false,
  paths: false,
  auth: false,
  storage: false,
  contentScanFolders: false,
  contentUpload: false,
  contentManual: false,
  contentCatalog: false,
};

interface StagedUploadFile {
  localId: string;
  file: File;
  title: string;
  kind: MediaKind;
  genre: string;
  year: number;
  fsk: FskLevel;
  nasFolder: string;
  durationMinutes: number;
  totalEpisodes: number;
  synopsis: string;
  coverFile: File | null;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  loadedBytes: number;
  errorMessage?: string;
  uploadedItemId?: string;
}

const DEFAULT_NAS_FOLDER_BY_KIND: Record<MediaKind, string> = {
  movie: '/mnt/nas/Filme',
  series: '/mnt/nas/Serien',
  image: '/mnt/nas/Bilder',
  music: '/mnt/nas/Musik',
  video: '/mnt/nas/Videos',
  other: '/mnt/nas/Dokumente',
};

const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  movie: 'Filme',
  series: 'Serien',
  image: 'Bilder',
  music: 'Musik',
  video: 'Video',
  other: 'Sonstiges',
};

function formatFileSizeCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} GB`;
}

function inferKindFromBrowserFile(file: File): MediaKind {
  const mime = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|heic)$/i.test(name)) {
    return 'image';
  }
  if (mime.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i.test(name)) {
    return 'music';
  }
  if (mime.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i.test(name)) {
    if (/s\d{1,2}e\d{1,2}|staffel|episode|folge/i.test(name)) return 'series';
    if (/\.(mkv|m4v)$/i.test(name)) return 'movie';
    return 'video';
  }
  return 'other';
}

function getFallbackCoverForKind(kind: MediaKind): string {
  switch (kind) {
    case 'series':
      return MARCENTE_ASSETS.posterCyberBerlin;
    case 'image':
      return MARCENTE_ASSETS.coverNasBilder;
    case 'music':
      return MARCENTE_ASSETS.coverNasMusik;
    case 'video':
      return MARCENTE_ASSETS.coverNasVideo;
    case 'other':
      return MARCENTE_ASSETS.coverNasSonstiges;
    case 'movie':
    default:
      return MARCENTE_ASSETS.posterDarkMatter;
  }
}

function mapNasMediaItemToAdminCatalogItem(item: NasMediaItem): AdminNasCatalogItem {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    genre: item.genre,
    year: item.year,
    fsk: item.fsk ?? 0,
    synopsis: item.synopsis,
    codec: item.codec,
    nasPath: item.nasPath,
    totalDurationMinutes: item.totalDurationMinutes,
    totalEpisodes: item.totalEpisodes,
    fileFormat: item.fileFormat,
    fileSize: item.fileSize,
    addedAt: item.addedAt,
    hasUploadedFile: Boolean(item.uploadedFileName || item.mediaUrl),
    uploadedFileName: item.uploadedFileName,
    uploadedMimeType: item.uploadedMimeType,
    uploadedByteSize: item.uploadedByteSize,
    mediaUrl: item.mediaUrl,
    customCoverUrl: item.customCoverUrl,
  };
}

function normalizeScanFolderPath(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!cleaned || cleaned === '/') return '/';
  const withLead = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return withLead.replace(/\/+$/, '') || '/';
}

function deriveTitleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

async function resizeAssistantAvatarToDataUrl(file: File): Promise<string> {
  const looksLikeImage =
    file.type.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || '');
  if (!looksLikeImage) {
    throw new Error('Bitte wähle eine gültige Bilddatei (PNG, JPG, WebP oder GIF).');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Bilddatei konnte nicht gelesen werden.'));
      image.src = objectUrl;
    });

    const targetSize = 512;
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas-Kontext für Bildoptimierung nicht verfügbar.');
    }

    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    const side = Math.min(naturalW, naturalH);
    const sx = Math.max(0, (naturalW - side) / 2);
    const sy = Math.max(0, (naturalH - side) / 2);

    ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);

    if (file.type === 'image/png' || file.type === 'image/webp') {
      const pngUrl = canvas.toDataURL('image/png');
      if (pngUrl.length <= 1_400_000) {
        return pngUrl;
      }
    }
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

interface AdminViewProps {
  user: NasUser;
  token: string;
  assistantAvatarUrl?: string;
  onAssistantAvatarUpdated?: (nextAvatarUrl: string) => void;
  onNotificationsBroadcasted?: () => void;
  onProfileUpdated: (newToken: string, updatedUser: NasUser) => void;
  onNasItemsAdded?: () => void;
  onPlayMediaId?: (mediaId: string) => void;
  activeTab?: AdminSectionTab;
  onActiveTabChange?: (nextTab: AdminSectionTab) => void;
}

export const AdminView: React.FC<AdminViewProps> = ({
  user,
  token,
  assistantAvatarUrl,
  onAssistantAvatarUpdated,
  onNotificationsBroadcasted,
  onProfileUpdated,
  onNasItemsAdded,
  onPlayMediaId,
  activeTab: controlledActiveTab,
  onActiveTabChange,
}) => {
  const [internalActiveTab, setInternalActiveTab] = useState<AdminSectionTab>('all');
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const [adminSubmenuBarOpen, setAdminSubmenuBarOpen] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<CollapsibleAdminSectionKey, boolean>
  >(DEFAULT_COLLAPSED_SECTIONS);

  const toggleSectionCollapse = (key: CollapsibleAdminSectionKey) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const setAllSectionsCollapsed = (collapsed: boolean) => {
    setCollapsedSections({
      notifications: collapsed,
      assistant: collapsed,
      profiles: collapsed,
      network: collapsed,
      paths: collapsed,
      auth: collapsed,
      storage: collapsed,
      contentScanFolders: collapsed,
      contentUpload: collapsed,
      contentManual: collapsed,
      contentCatalog: collapsed,
    });
  };

  const selectAdminTab = (nextTab: AdminSectionTab) => {
    if (onActiveTabChange) {
      onActiveTabChange(nextTab);
    } else {
      setInternalActiveTab(nextTab);
    }
    if (nextTab === 'notifications') {
      setCollapsedSections((prev) => ({ ...prev, notifications: false }));
    } else if (nextTab === 'assistant') {
      setCollapsedSections((prev) => ({ ...prev, assistant: false }));
    } else if (nextTab === 'profiles') {
      setCollapsedSections((prev) => ({ ...prev, profiles: false }));
    } else if (nextTab === 'network') {
      setCollapsedSections((prev) => ({ ...prev, network: false }));
    } else if (nextTab === 'paths') {
      setCollapsedSections((prev) => ({ ...prev, paths: false }));
    } else if (nextTab === 'auth') {
      setCollapsedSections((prev) => ({ ...prev, auth: false }));
    } else if (nextTab === 'storage') {
      setCollapsedSections((prev) => ({ ...prev, storage: false }));
    } else if (nextTab === 'content') {
      setCollapsedSections((prev) => ({
        ...prev,
        contentScanFolders: false,
        contentUpload: false,
        contentManual: false,
        contentCatalog: false,
      }));
    }
  };

  // Admin-Benachrichtigungen an alle Benutzer
  const [broadcastMessageType, setBroadcastMessageType] =
    useState<AdminNotificationMessageType>('general');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [broadcastNotice, setBroadcastNotice] = useState<string | null>(null);
  const [broadcastHistory, setBroadcastHistory] = useState<
    AdminBroadcastNotificationSummary[]
  >([]);
  const [loadingBroadcasts, setLoadingBroadcasts] = useState(true);
  const [deletingBroadcastId, setDeletingBroadcastId] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<AdminProfileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminBusyUser, setAdminBusyUser] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const [showCreateProfile, setShowCreateProfile] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<'family' | 'admin'>('family');
  const [createFskLimit, setCreateFskLimit] = useState<FskLevel>(12);
  const [creatingProfile, setCreatingProfile] = useState(false);

  // Datei-Upload aufs NAS (Drag-and-Drop-Zone über /api/nas/upload)
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<StagedUploadFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [defaultUploadFolder, setDefaultUploadFolder] = useState('');
  const [defaultUploadFsk, setDefaultUploadFsk] = useState<FskLevel>(0);
  const [notifyAfterUpload, setNotifyAfterUpload] = useState(true);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeUploadXhrRef = React.useRef<XMLHttpRequest | null>(null);
  const dragDepthRef = React.useRef(0);

  // Manuelle NAS-Inhalte hinzufügen
  const [nasItemTitle, setNasItemTitle] = useState('');
  const [nasItemKind, setNasItemKind] = useState<MediaKind>('movie');
  const [nasItemGenre, setNasItemGenre] = useState('');
  const [nasItemYear, setNasItemYear] = useState<number>(new Date().getFullYear());
  const [nasItemFsk, setNasItemFsk] = useState<FskLevel>(0);
  const [nasItemPath, setNasItemPath] = useState('');
  const [nasItemDuration, setNasItemDuration] = useState<number>(108);
  const [nasItemSynopsis, setNasItemSynopsis] = useState('');
  const [stagedNasItems, setStagedNasItems] = useState<
    Array<{
      title: string;
      kind: MediaKind;
      genre: string;
      year: number;
      fsk: FskLevel;
      nasPath?: string;
      totalDurationMinutes?: number;
      synopsis?: string;
    }>
  >([]);
  const [addingNasItems, setAddingNasItems] = useState(false);
  const [nasAddError, setNasAddError] = useState<string | null>(null);
  const [nasAddNotice, setNasAddNotice] = useState<string | null>(null);

  // Manueller NAS-Ordnerscan (Ordnerauswahl + klickbarer NAS-Explorer)
  const [scanFolderSettings, setScanFolderSettings] = useState<NasScanFolderSettings>({
    scanMode: 'all',
    selectedFolders: [],
    updatedAt: null,
    updatedBy: null,
  });
  const [loadingScanFolders, setLoadingScanFolders] = useState(true);
  const [savingScanFolders, setSavingScanFolders] = useState(false);
  const [scanFolderError, setScanFolderError] = useState<string | null>(null);
  const [scanFolderNotice, setScanFolderNotice] = useState<string | null>(null);
  const [scanBrowserOpen, setScanBrowserOpen] = useState(false);
  const [scanBrowserPath, setScanBrowserPath] = useState('/');
  const [scanBrowserLoading, setScanBrowserLoading] = useState(false);
  const [scanBrowserResult, setScanBrowserResult] = useState<NasBrowseTreeResult | null>(null);
  const [scanBrowserHost, setScanBrowserHost] = useState('fritz.box');
  const [scanBrowserProto, setScanBrowserProto] = useState<NasProtocolId>('fritz_upnp');
  const [scanBrowserPort, setScanBrowserPort] = useState('80');
  const [scanBrowserShare, setScanBrowserShare] = useState('FRITZ.NAS');
  const [scanBrowserUser, setScanBrowserUser] = useState('');
  const [scanBrowserPass, setScanBrowserPass] = useState('');
  const [scanBrowserShowPass, setScanBrowserShowPass] = useState(false);
  const [scanBrowserUseTls, setScanBrowserUseTls] = useState(false);
  const [scanBrowserManualPath, setScanBrowserManualPath] = useState('');

  // Vorhandener NAS-Medienbestand (Admin-Verwaltung)
  const [adminCatalog, setAdminCatalog] = useState<AdminNasCatalogItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogKindFilter, setCatalogKindFilter] = useState<'all' | MediaKind>('all');
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);
  const [catalogDeleteTarget, setCatalogDeleteTarget] = useState<string | null>(null);
  const [editingCatalogItem, setEditingCatalogItem] = useState<AdminNasCatalogItem | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);

  const [savedAllowedProtocols, setSavedAllowedProtocols] = useState<NasProtocolId[]>([
    ...ALL_NAS_PROTOCOLS,
  ]);
  const [draftAllowedProtocols, setDraftAllowedProtocols] = useState<NasProtocolId[]>([
    ...ALL_NAS_PROTOCOLS,
  ]);
  const [loadingAuthMethods, setLoadingAuthMethods] = useState(true);
  const [savingAuthMethods, setSavingAuthMethods] = useState(false);
  const [authMethodsError, setAuthMethodsError] = useState<string | null>(null);
  const [authMethodsNotice, setAuthMethodsNotice] = useState<string | null>(null);

  // Nutzerdatenspeicherung (NAS vs. automatisch verschlüsselte Cloud + Cloud-Anmeldung)
  const [userStorageConfig, setUserStorageConfig] = useState<UserDataStorageConfig | null>(null);
  const [vaultPreview, setVaultPreview] = useState<UserDataVaultPreview | null>(null);
  const [loadingUserStorage, setLoadingUserStorage] = useState(true);
  const [savingUserStorage, setSavingUserStorage] = useState(false);
  const [storageModeDraft, setStorageModeDraft] = useState<UserDataStorageMode>('nas');
  const [cloudProviderDraft, setCloudProviderDraft] =
    useState<CloudStorageProvider>('google_drive');
  const [webdavUrlDraft, setWebdavUrlDraft] = useState('');
  const [webdavUsernameDraft, setWebdavUsernameDraft] = useState('');
  const [webdavSecretDraft, setWebdavSecretDraft] = useState('');
  const [showWebdavSecret, setShowWebdavSecret] = useState(false);
  const [webdavRemotePathDraft, setWebdavRemotePathDraft] = useState(
    '/entencenter-userdata-vault.enc.json'
  );
  const [userStorageError, setUserStorageError] = useState<string | null>(null);
  const [userStorageNotice, setUserStorageNotice] = useState<string | null>(null);

  const [googleUser, setGoogleUser] = useState<FirebaseUser | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [cloudAuthBusy, setCloudAuthBusy] = useState(false);
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);
  const [cloudVerifyBusy, setCloudVerifyBusy] = useState(false);
  const [cloudDriveFile, setCloudDriveFile] = useState<DriveBackupFileInfo | null>(null);
  const [pendingDriveOverwrite, setPendingDriveOverwrite] = useState<{
    existingFile: DriveBackupFileInfo;
    envelope: EncryptedCloudVaultEnvelope;
    activateCloudMode: boolean;
  } | null>(null);

  // Enten-Assistent Avatar-Set (Standard-Avatar vs. benutzerdefinierter Upload)
  const [assistantAvatarState, setAssistantAvatarState] = useState<{
    avatarUrl: string;
    defaultAvatarUrl: string;
    isCustom: boolean;
  }>(() => {
    const resolved = resolveAssistantAvatarSrc(assistantAvatarUrl);
    return {
      avatarUrl: resolved,
      defaultAvatarUrl: DEFAULT_ASSISTANT_AVATAR_URL,
      isCustom: resolved !== DEFAULT_ASSISTANT_AVATAR_URL,
    };
  });
  const [loadingAssistantAvatar, setLoadingAssistantAvatar] = useState(true);
  const [savingAssistantAvatar, setSavingAssistantAvatar] = useState(false);
  const [assistantAvatarDragActive, setAssistantAvatarDragActive] = useState(false);
  const [assistantAvatarError, setAssistantAvatarError] = useState<string | null>(null);
  const [assistantAvatarNotice, setAssistantAvatarNotice] = useState<string | null>(null);
  const assistantAvatarInputRef = React.useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!assistantAvatarUrl) return;
    const resolved = resolveAssistantAvatarSrc(assistantAvatarUrl);
    setAssistantAvatarState((prev) => ({
      ...prev,
      avatarUrl: resolved,
      isCustom: resolved !== prev.defaultAvatarUrl,
    }));
  }, [assistantAvatarUrl]);

  const resolveBridgeTargetForAdmin = useCallback(() => {
    const buf = readLocalOnboardingBuffer();
    const conn = buf?.nasConnection;
    const host = (conn?.host || scanBrowserHost || '').trim();
    const protocol: NasProtocolId = conn?.protocol ?? scanBrowserProto ?? 'fritz_upnp';
    const useTls = protocol === 'smb' ? false : Boolean(conn?.useTls ?? scanBrowserUseTls);
    const port = String(
      sanitizeNasPortForProtocol(
        protocol,
        conn?.port || scanBrowserPort || (protocol === 'smb' ? '445' : useTls ? '443' : '80'),
        useTls
      )
    );
    const shareOrPath =
      protocol === 'fritz_upnp'
        ? 'FRITZ.NAS'
        : conn?.shareOrPath || scanBrowserShare || '/';
    const username = (conn?.username || scanBrowserUser || '').trim();
    const password = (scanBrowserPass || conn?.fritzPassword || conn?.secret || '').trim();
    const backendRoot = (
      buf?.syncedBackendPath ||
      conn?.backendPath ||
      '/EntenCenter-Backend'
    ).replace(/\/+$/, '') || '/EntenCenter-Backend';
    return {
      host,
      protocol,
      port,
      shareOrPath,
      username,
      password,
      fritzPassword: password,
      useTls,
      backendRoot,
    };
  }, [scanBrowserHost, scanBrowserPass, scanBrowserPort, scanBrowserProto, scanBrowserShare, scanBrowserUseTls, scanBrowserUser]);

  const loadProfiles = useCallback(async () => {
    if (user.role !== 'admin') {
      setProfiles([]);
      setAdminError(null);
      setLoading(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoading(true);
      setAdminError(null);
      try {
        const buf = readLocalOnboardingBuffer();
        const fallbackEntry: AdminProfileEntry = {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          fskLimit: user.fskLimit ?? 18,
          createdAt: user.createdAt ?? buf?.createdAt,
          avatarColor: user.avatarColor || '#F59E0B',
          avatarUrl: user.avatarUrl ?? null,
        };
        const bridgeTarget = resolveBridgeTargetForAdmin();
        if (bridgeTarget.host && bridgeTarget.password) {
          const listRes = await readFileFromNasBridge({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            targetPath: `${bridgeTarget.backendRoot}/config/profiles.json`,
          }).catch(() => null);
          if (listRes?.ok && listRes.content) {
            const parsed = JSON.parse(listRes.content) as AdminProfileEntry[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              setProfiles(parsed);
              return;
            }
          }
          const dirRes = await browseNasDirectoryTree({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            path: `${bridgeTarget.backendRoot}/profiles`,
          }).catch(() => null);
          if (dirRes?.ok && Array.isArray(dirRes.entries)) {
            const jsonEntries = dirRes.entries.filter((e) => e.type !== 'directory' && e.name.endsWith('.json'));
            const loadedList: AdminProfileEntry[] = [];
            for (const entry of jsonEntries.slice(0, 20)) {
              const pr = await readFileFromNasBridge({
                protocol: bridgeTarget.protocol,
                host: bridgeTarget.host,
                port: bridgeTarget.port,
                shareOrPath: bridgeTarget.shareOrPath,
                username: bridgeTarget.username,
                password: bridgeTarget.password,
                fritzPassword: bridgeTarget.fritzPassword,
                useTls: bridgeTarget.useTls,
                targetPath: entry.path,
              }).catch(() => null);
              if (pr?.ok && pr.content) {
                try {
                  const p = JSON.parse(pr.content) as Partial<AdminProfileEntry>;
                  if (p.username) {
                    loadedList.push({
                      id: p.id || `nas-${p.username}`,
                      username: p.username,
                      displayName: p.displayName || p.username,
                      role: p.role === 'admin' ? 'admin' : 'family',
                      fskLimit: (p.fskLimit ?? 18) as FskLevel,
                      createdAt: p.createdAt,
                      avatarColor: p.avatarColor || '#F59E0B',
                      avatarUrl: p.avatarUrl ?? null,
                    });
                  }
                } catch {
                  // ignore malformed profile file
                }
              }
            }
            if (loadedList.length > 0) {
              if (!loadedList.some((p) => p.username === fallbackEntry.username)) {
                loadedList.unshift(fallbackEntry);
              }
              setProfiles(loadedList);
              return;
            }
          }
        }
        setProfiles([fallbackEntry]);
      } finally {
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/nas/profiles', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { profiles: AdminProfileEntry[] };
        setProfiles(data.profiles || []);
      } else {
        setProfiles([]);
      }
    } catch {
      setAdminError('Profile konnten nicht vom NAS geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [resolveBridgeTargetForAdmin, token, user]);

  const loadAllowedAuthMethods = useCallback(async () => {
    if (user.role !== 'admin') {
      setAuthMethodsError(null);
      setLoadingAuthMethods(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoadingAuthMethods(true);
      try {
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const res = await readFileFromNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/allowed-auth-methods.json`,
          }).catch(() => null);
          if (res?.ok && res.content) {
            const parsed = JSON.parse(res.content) as { allowedProtocols?: NasProtocolId[] };
            if (Array.isArray(parsed.allowedProtocols) && parsed.allowedProtocols.length > 0) {
              setSavedAllowedProtocols(parsed.allowedProtocols);
              setDraftAllowedProtocols(parsed.allowedProtocols);
            }
          }
        }
      } catch {
        // ignore parse errors
      } finally {
        setAuthMethodsError(null);
        setLoadingAuthMethods(false);
      }
      return;
    }
    setLoadingAuthMethods(true);
    try {
      const res = await fetch('/api/nas/admin/nas-auth-methods', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { allowedProtocols?: NasProtocolId[] };
        if (Array.isArray(data.allowedProtocols) && data.allowedProtocols.length > 0) {
          setSavedAllowedProtocols(data.allowedProtocols);
          setDraftAllowedProtocols(data.allowedProtocols);
        }
      }
    } catch {
      setAuthMethodsError('Unterstützte NAS-Anmeldewege konnten nicht geladen werden.');
    } finally {
      setLoadingAuthMethods(false);
    }
  }, [resolveBridgeTargetForAdmin, token, user.role]);

  const loadUserStorageSettings = useCallback(async () => {
    if (user.role !== 'admin') {
      setUserStorageError(null);
      setLoadingUserStorage(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoadingUserStorage(true);
      try {
        const target = resolveBridgeTargetForAdmin();
        let loadedCfg: UserDataStorageConfig | null = null;
        if (target.host && target.password) {
          const res = await readFileFromNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/user-storage.json`,
          }).catch(() => null);
          if (res?.ok && res.content) {
            loadedCfg = JSON.parse(res.content) as UserDataStorageConfig;
          }
        }
        const defaultCfg: UserDataStorageConfig = loadedCfg ?? {
          mode: 'nas',
          cloudProvider: 'google_drive',
          autoEncrypt: true,
          encryptionAlgorithm: 'AES-256-GCM',
          keyFingerprint: 'STORAGE-BRIDGE-LOCAL',
          cloudAccountEmail: null,
          cloudAccountName: null,
          cloudAccountPhotoUrl: null,
          cloudRemoteFileId: null,
          cloudRemoteFileName: CLOUD_VAULT_FILE_NAME,
          webdavUrl: '',
          webdavUsername: '',
          hasWebdavSecret: false,
          webdavRemotePath: '/entencenter-userdata-vault.enc.json',
          lastEncryptedSyncAt: new Date().toISOString(),
          lastSyncStatus: 'synced',
          lastSyncError: null,
          updatedAt: new Date().toISOString(),
          updatedBy: user.username,
        };
        setUserStorageConfig(defaultCfg);
        setStorageModeDraft(defaultCfg.mode);
        setCloudProviderDraft(defaultCfg.cloudProvider);
        setWebdavUrlDraft(defaultCfg.webdavUrl || '');
        setWebdavUsernameDraft(defaultCfg.webdavUsername || '');
        setWebdavRemotePathDraft(
          defaultCfg.webdavRemotePath || '/entencenter-userdata-vault.enc.json'
        );
      } catch {
        setUserStorageError(null);
      } finally {
        setUserStorageError(null);
        setLoadingUserStorage(false);
      }
      return;
    }
    setLoadingUserStorage(true);
    try {
      const res = await fetch('/api/nas/admin/user-storage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          config: UserDataStorageConfig;
          vaultPreview: UserDataVaultPreview;
        };
        setUserStorageConfig(data.config);
        setVaultPreview(data.vaultPreview);
        setStorageModeDraft(data.config.mode);
        setCloudProviderDraft(data.config.cloudProvider);
        setWebdavUrlDraft(data.config.webdavUrl || '');
        setWebdavUsernameDraft(data.config.webdavUsername || '');
        setWebdavRemotePathDraft(
          data.config.webdavRemotePath || '/entencenter-userdata-vault.enc.json'
        );
      }
    } catch {
      setUserStorageError('Einstellungen zur Nutzerdatenspeicherung konnten nicht geladen werden.');
    } finally {
      setLoadingUserStorage(false);
    }
  }, [resolveBridgeTargetForAdmin, token, user.role, user.username]);

  useEffect(() => {
    const unsub = subscribeGoogleAuth((fbUser, accessToken) => {
      setGoogleUser(fbUser);
      setGoogleAccessToken(accessToken);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!googleAccessToken) return;
    let active = true;
    void findEncryptedCloudVaultFile(googleAccessToken)
      .then((fileInfo) => {
        if (active) setCloudDriveFile(fileInfo);
      })
      .catch(() => {
        // Ignorieren, falls Token abgelaufen ist
      });
    return () => {
      active = false;
    };
  }, [googleAccessToken]);

  const loadAdminCatalog = useCallback(async () => {
    if (user.role !== 'admin') {
      setAdminCatalog([]);
      setCatalogError(null);
      setLoadingCatalog(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoadingCatalog(true);
      try {
        const buf = readLocalOnboardingBuffer();
        const conn = buf?.nasConnection;
        const pass = conn?.fritzPassword || conn?.secret || scanBrowserPass || '';
        const bridgeProto = conn?.protocol ?? 'fritz_upnp';
        const bridgeTarget =
          conn?.host && pass
            ? {
                protocol: bridgeProto,
                host: conn.host,
                port: String(
                  sanitizeNasPortForProtocol(
                    bridgeProto,
                    conn.port,
                    bridgeProto === 'smb' ? false : conn.useTls
                  )
                ),
                shareOrPath: bridgeProto === 'fritz_upnp' ? 'FRITZ.NAS' : conn.shareOrPath || '/',
                username: conn.username || '',
                password: pass,
                secret: pass,
                fritzPassword: pass,
                useTls: bridgeProto === 'smb' ? false : Boolean(conn.useTls),
              }
            : null;
        const withResolvedUrls = (list: NasMediaItem[]): NasMediaItem[] =>
          list.map((it) => ({
            ...it,
            uploadedMimeType:
              it.uploadedMimeType || (it.nasPath ? inferMimeTypeFromPath(it.nasPath) : undefined),
            mediaUrl: resolvePlayableNasMediaUrl(it, bridgeTarget, token) ?? it.mediaUrl,
          }));

        const localItems = withResolvedUrls(readLocalBridgeCatalog());
        setAdminCatalog(localItems.map(mapNasMediaItemToAdminCatalogItem));
        setCatalogError(null);

        const backendRoot = (
          buf?.syncedBackendPath ||
          conn?.backendPath ||
          '/EntenCenter-Backend'
        ).replace(/\/+$/, '');
        if (bridgeTarget) {
          let loadedRemoteCatalog: NasMediaItem[] | null = null;
          const remoteRes = await readFileFromNasBridge({
            ...bridgeTarget,
            targetPath: `${backendRoot}/config/catalog.json`,
          });
          if (remoteRes.ok && remoteRes.content) {
            const parsed = JSON.parse(remoteRes.content) as NasMediaItem[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              loadedRemoteCatalog = parsed;
            }
          } else {
            const discovered = await discoverAndHydrateBackendFromNasBridge({
              target: bridgeTarget,
              username: buf?.user?.username || user.username,
              preferredBackendPath: backendRoot,
            }).catch(() => null);
            if (discovered?.catalog && discovered.catalog.length > 0) {
              loadedRemoteCatalog = discovered.catalog;
            }
          }
          if (loadedRemoteCatalog) {
            const merged = upsertLocalBridgeCatalogItems(loadedRemoteCatalog);
            setAdminCatalog(withResolvedUrls(merged).map(mapNasMediaItemToAdminCatalogItem));
          }
        }
      } catch {
        setCatalogError('NAS-Medienbestand konnte in der Storage-Bridge nicht geladen werden.');
      } finally {
        setLoadingCatalog(false);
      }
      return;
    }
    setLoadingCatalog(true);
    try {
      const res = await fetch('/api/nas/admin/library', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { items?: AdminNasCatalogItem[] };
        setAdminCatalog(data.items ?? []);
      }
    } catch {
      setCatalogError('NAS-Medienbestand konnte nicht geladen werden.');
    } finally {
      setLoadingCatalog(false);
    }
  }, [scanBrowserPass, token, user.role, user.username]);

  const loadScanFolderSettings = useCallback(async () => {
    if (user.role !== 'admin') {
      setLoadingScanFolders(false);
      return;
    }
    setLoadingScanFolders(true);
    if (isLocalFallbackToken(token)) {
      try {
        const localCfg = readLocalBridgeScanSettings();
        setScanFolderSettings(localCfg);
        const buf = readLocalOnboardingBuffer();
        const conn = buf?.nasConnection;
        if (conn) {
          if (conn.host) setScanBrowserHost(conn.host);
          setScanBrowserProto(conn.protocol);
          if (conn.port) setScanBrowserPort(conn.port);
          setScanBrowserShare(conn.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn.shareOrPath || '/');
          if (conn.username) setScanBrowserUser(conn.username);
          const storedPass = conn.fritzPassword || conn.secret || '';
          if (storedPass) setScanBrowserPass(storedPass);
          setScanBrowserUseTls(Boolean(conn.useTls));
          const backendRoot = (
            buf?.syncedBackendPath ||
            conn.backendPath ||
            '/EntenCenter-Backend'
          ).replace(/\/+$/, '');
          if (conn.host && storedPass) {
            const bridgeTarget = {
              protocol: conn.protocol,
              host: conn.host,
              port: String(
                sanitizeNasPortForProtocol(
                  conn.protocol,
                  conn.port,
                  conn.protocol === 'smb' ? false : conn.useTls
                )
              ),
              shareOrPath: conn.protocol === 'fritz_upnp' ? 'FRITZ.NAS' : conn.shareOrPath || '/',
              username: conn.username,
              password: storedPass,
              secret: storedPass,
              fritzPassword: storedPass,
              useTls: conn.protocol === 'smb' ? false : Boolean(conn.useTls),
            };
            let parsedScan: Partial<NasScanFolderSettings> | null = null;
            const remoteCfg = await readFileFromNasBridge({
              ...bridgeTarget,
              targetPath: `${backendRoot}/config/scan-folders.json`,
            });
            if (remoteCfg.ok && remoteCfg.content) {
              parsedScan = JSON.parse(remoteCfg.content) as Partial<NasScanFolderSettings>;
            } else {
              const discovered = await discoverAndHydrateBackendFromNasBridge({
                target: bridgeTarget,
                username: buf?.user?.username || user.username,
                preferredBackendPath: backendRoot,
              }).catch(() => null);
              if (discovered?.scanFolderSettings) {
                parsedScan = discovered.scanFolderSettings;
              }
            }
            if (parsedScan) {
              const normalized: NasScanFolderSettings = {
                scanMode: parsedScan.scanMode === 'selected' ? 'selected' : 'all',
                selectedFolders: Array.isArray(parsedScan.selectedFolders)
                  ? parsedScan.selectedFolders.map(normalizeScanFolderPath)
                  : [],
                updatedAt: typeof parsedScan.updatedAt === 'string' ? parsedScan.updatedAt : null,
                updatedBy: typeof parsedScan.updatedBy === 'string' ? parsedScan.updatedBy : null,
              };
              setScanFolderSettings(normalized);
              saveLocalBridgeScanSettings(normalized);
            }
          }
        }
      } catch {
        setScanFolderError('Scan-Ordner-Einstellungen konnten nicht geladen werden.');
      } finally {
        setLoadingScanFolders(false);
      }
      return;
    }

    try {
      const [scanRes, connRes] = await Promise.all([
        fetch('/api/nas/admin/scan-folders', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch('/api/nas/connection', {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null),
      ]);
      if (scanRes.ok) {
        const data = (await scanRes.json()) as { settings?: NasScanFolderSettings };
        if (data.settings) {
          setScanFolderSettings({
            scanMode: data.settings.scanMode === 'selected' ? 'selected' : 'all',
            selectedFolders: Array.isArray(data.settings.selectedFolders)
              ? data.settings.selectedFolders.map(normalizeScanFolderPath)
              : [],
            updatedAt: data.settings.updatedAt ?? null,
            updatedBy: data.settings.updatedBy ?? null,
          });
        }
      }
      if (connRes?.ok) {
        const connData = (await connRes.json()) as {
          config?: {
            host?: string;
            protocol?: NasProtocolId;
            port?: string;
            shareOrPath?: string;
            username?: string;
            useTls?: boolean;
          };
        };
        const cfg = connData.config;
        if (cfg) {
          if (cfg.host) setScanBrowserHost(cfg.host);
          if (cfg.protocol) setScanBrowserProto(cfg.protocol);
          if (cfg.port) setScanBrowserPort(cfg.port);
          if (cfg.shareOrPath) setScanBrowserShare(cfg.shareOrPath);
          if (cfg.username) setScanBrowserUser(cfg.username);
          setScanBrowserUseTls(Boolean(cfg.useTls));
        }
      }
    } catch {
      setScanFolderError('Scan-Ordner-Einstellungen konnten nicht geladen werden.');
    } finally {
      setLoadingScanFolders(false);
    }
  }, [token, user.role]);

  const loadAssistantAvatar = useCallback(async () => {
    if (user.role !== 'admin') {
      setAssistantAvatarError(null);
      setLoadingAssistantAvatar(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoadingAssistantAvatar(true);
      try {
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const res = await readFileFromNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/assistant-avatar.json`,
          }).catch(() => null);
          if (res?.ok && res.content) {
            const parsed = JSON.parse(res.content) as { avatarUrl?: string | null };
            const activeUrl = resolveAssistantAvatarSrc(parsed.avatarUrl);
            setAssistantAvatarState({
              avatarUrl: activeUrl,
              defaultAvatarUrl: DEFAULT_ASSISTANT_AVATAR_URL,
              isCustom: activeUrl !== DEFAULT_ASSISTANT_AVATAR_URL,
            });
          }
        }
      } catch {
        // ignore
      } finally {
        setAssistantAvatarError(null);
        setLoadingAssistantAvatar(false);
      }
      return;
    }
    setLoadingAssistantAvatar(true);
    try {
      const res = await fetch('/api/nas/assistant-avatar', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          avatarUrl?: string;
          defaultAvatarUrl?: string;
          isCustom?: boolean;
        };
        const defaultUrl = resolveAssistantAvatarSrc(data.defaultAvatarUrl);
        const activeUrl = resolveAssistantAvatarSrc(data.avatarUrl);
        setAssistantAvatarState({
          avatarUrl: activeUrl,
          defaultAvatarUrl: defaultUrl,
          isCustom: Boolean(data.isCustom && activeUrl !== defaultUrl),
        });
      }
    } catch {
      setAssistantAvatarError('Avatar des Enten-Assistenten konnte nicht geladen werden.');
    } finally {
      setLoadingAssistantAvatar(false);
    }
  }, [resolveBridgeTargetForAdmin, token, user.role]);

  const loadAdminBroadcasts = useCallback(async () => {
    if (user.role !== 'admin') {
      setBroadcastHistory([]);
      setBroadcastError(null);
      setLoadingBroadcasts(false);
      return;
    }
    if (isLocalFallbackToken(token)) {
      setLoadingBroadcasts(true);
      try {
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const res = await readFileFromNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/admin-broadcasts.json`,
          }).catch(() => null);
          if (res?.ok && res.content) {
            const parsed = JSON.parse(res.content) as AdminBroadcastNotificationSummary[];
            if (Array.isArray(parsed)) {
              setBroadcastHistory(parsed);
            }
          }
        }
      } catch {
        setBroadcastHistory([]);
      } finally {
        setBroadcastError(null);
        setLoadingBroadcasts(false);
      }
      return;
    }
    setLoadingBroadcasts(true);
    try {
      const res = await fetch('/api/nas/admin/notifications', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          broadcasts?: AdminBroadcastNotificationSummary[];
        };
        setBroadcastHistory(data.broadcasts ?? []);
      }
    } catch {
      setBroadcastError('Gesendete Admin-Benachrichtigungen konnten nicht geladen werden.');
    } finally {
      setLoadingBroadcasts(false);
    }
  }, [resolveBridgeTargetForAdmin, token, user.role]);

  useEffect(() => {
    void loadProfiles();
    void loadAllowedAuthMethods();
    void loadUserStorageSettings();
    void loadAdminCatalog();
    void loadScanFolderSettings();
    void loadAssistantAvatar();
    void loadAdminBroadcasts();
  }, [
    loadProfiles,
    loadAllowedAuthMethods,
    loadUserStorageSettings,
    loadAdminCatalog,
    loadScanFolderSettings,
    loadAssistantAvatar,
    loadAdminBroadcasts,
  ]);

  if (user.role !== 'admin') {
    return null;
  }

  const handleSendAdminBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = broadcastTitle.trim();
    const cleanMessage = broadcastMessage.trim();

    if (cleanTitle.length < 2) {
      setBroadcastError('Bitte gib einen Betreff mit mindestens 2 Zeichen ein.');
      setBroadcastNotice(null);
      return;
    }
    if (cleanMessage.length < 2) {
      setBroadcastError('Bitte gib eine Nachricht mit mindestens 2 Zeichen ein.');
      setBroadcastNotice(null);
      return;
    }

    setSendingBroadcast(true);
    setBroadcastError(null);
    setBroadcastNotice(null);
    try {
      const res = await fetch('/api/nas/admin/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: cleanTitle,
          message: cleanMessage,
          messageType: broadcastMessageType,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        notifiedUsers?: number;
        broadcast?: AdminBroadcastNotificationSummary;
        broadcasts?: AdminBroadcastNotificationSummary[];
      };
      if (!res.ok) {
        setBroadcastError(
          data.error || 'Benachrichtigung konnte nicht an alle Benutzer gesendet werden.'
        );
        return;
      }
      if (Array.isArray(data.broadcasts)) {
        setBroadcastHistory(data.broadcasts);
      }
      const selectedTypeMeta = ADMIN_NOTIFICATION_TYPE_OPTIONS.find(
        (opt) => opt.id === broadcastMessageType
      );
      setBroadcastTitle('');
      setBroadcastMessage('');
      setBroadcastNotice(
        `${selectedTypeMeta?.label ?? 'Allgemein'}-Benachrichtigung „${data.broadcast?.title ?? cleanTitle}“ erfolgreich an alle ${data.notifiedUsers ?? profiles.length} Benutzer gesendet.`
      );
      onNotificationsBroadcasted?.();
    } catch {
      setBroadcastError('Verbindung zum NAS beim Senden der Benachrichtigung fehlgeschlagen.');
    } finally {
      setSendingBroadcast(false);
    }
  };

  const handleDeleteAdminBroadcast = async (broadcastId: string) => {
    setDeletingBroadcastId(broadcastId);
    setBroadcastError(null);
    setBroadcastNotice(null);
    try {
      const res = await fetch(
        `/api/nas/admin/notifications/${encodeURIComponent(broadcastId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = (await res.json()) as {
        error?: string;
        broadcasts?: AdminBroadcastNotificationSummary[];
      };
      if (!res.ok) {
        setBroadcastError(data.error || 'Benachrichtigung konnte nicht zurückgezogen werden.');
        return;
      }
      if (Array.isArray(data.broadcasts)) {
        setBroadcastHistory(data.broadcasts);
      }
      setBroadcastNotice('Benachrichtigung wurde für alle Benutzer zurückgezogen.');
      onNotificationsBroadcasted?.();
    } catch {
      setBroadcastError('Verbindung zum NAS beim Entfernen der Benachrichtigung fehlgeschlagen.');
    } finally {
      setDeletingBroadcastId(null);
    }
  };

  const handleUploadAssistantAvatarFile = async (file: File) => {
    setSavingAssistantAvatar(true);
    setAssistantAvatarError(null);
    setAssistantAvatarNotice(null);
    try {
      const compressedDataUrl = await resizeAssistantAvatarToDataUrl(file);
      const res = await fetch('/api/nas/admin/assistant-avatar', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ avatarUrl: compressedDataUrl }),
      });
      const data = (await res.json()) as {
        error?: string;
        avatarUrl?: string;
        defaultAvatarUrl?: string;
        isCustom?: boolean;
      };
      if (!res.ok) {
        setAssistantAvatarError(
          data.error || 'Avatar des Enten-Assistenten konnte nicht gespeichert werden.'
        );
        return;
      }
      const nextUrl = resolveAssistantAvatarSrc(data.avatarUrl);
      const defaultUrl = resolveAssistantAvatarSrc(data.defaultAvatarUrl);
      setAssistantAvatarState({
        avatarUrl: nextUrl,
        defaultAvatarUrl: defaultUrl,
        isCustom: Boolean(data.isCustom),
      });
      onAssistantAvatarUpdated?.(nextUrl);
      setAssistantAvatarNotice(
        'Neues Avatarbild für den Enten-Assistenten auf dem NAS gespeichert und für alle Profile aktiviert.'
      );
    } catch (err) {
      setAssistantAvatarError(
        err instanceof Error ? err.message : 'Bilddatei konnte nicht verarbeitet werden.'
      );
    } finally {
      setSavingAssistantAvatar(false);
    }
  };

  const handleResetAssistantAvatar = async () => {
    setSavingAssistantAvatar(true);
    setAssistantAvatarError(null);
    setAssistantAvatarNotice(null);
    try {
      const res = await fetch('/api/nas/admin/assistant-avatar', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ avatarUrl: null }),
      });
      const data = (await res.json()) as {
        error?: string;
        avatarUrl?: string;
        defaultAvatarUrl?: string;
        isCustom?: boolean;
      };
      if (!res.ok) {
        setAssistantAvatarError(
          data.error || 'Standard-Avatar konnte nicht wiederhergestellt werden.'
        );
        return;
      }
      const defaultUrl = resolveAssistantAvatarSrc(data.defaultAvatarUrl);
      const nextUrl = resolveAssistantAvatarSrc(data.avatarUrl);
      setAssistantAvatarState({
        avatarUrl: nextUrl,
        defaultAvatarUrl: defaultUrl,
        isCustom: false,
      });
      onAssistantAvatarUpdated?.(nextUrl);
      setAssistantAvatarNotice('Standard-Avatar des Enten-Assistenten wurde wiederhergestellt.');
    } catch {
      setAssistantAvatarError('Verbindung zum NAS beim Zurücksetzen fehlgeschlagen.');
    } finally {
      setSavingAssistantAvatar(false);
    }
  };

  const handleAdminUpdateProfile = async (
    targetUsername: string,
    payload: { fskLimit?: FskLevel; role?: 'admin' | 'family'; transferExclusive?: boolean },
    noticeText: string
  ) => {
    setAdminBusyUser(targetUsername);
    setAdminError(null);
    setAdminNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const updatedList = profiles.map((p) =>
          p.username === targetUsername
            ? {
                ...p,
                ...(payload.fskLimit !== undefined ? { fskLimit: payload.fskLimit } : {}),
                ...(payload.role !== undefined ? { role: payload.role } : {}),
              }
            : payload.transferExclusive
              ? { ...p, role: 'family' as const }
              : p
        );
        const bridgeTarget = resolveBridgeTargetForAdmin();
        if (bridgeTarget.host && bridgeTarget.password) {
          await writeFileToNasBridge({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            targetPath: `${bridgeTarget.backendRoot}/config/profiles.json`,
            content: JSON.stringify(updatedList, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
          const edited = updatedList.find((p) => p.username === targetUsername);
          if (edited) {
            await writeFileToNasBridge({
              protocol: bridgeTarget.protocol,
              host: bridgeTarget.host,
              port: bridgeTarget.port,
              shareOrPath: bridgeTarget.shareOrPath,
              username: bridgeTarget.username,
              password: bridgeTarget.password,
              fritzPassword: bridgeTarget.fritzPassword,
              useTls: bridgeTarget.useTls,
              targetPath: `${bridgeTarget.backendRoot}/profiles/${targetUsername}.json`,
              content: JSON.stringify({ ...edited, updatedAt: new Date().toISOString() }, null, 2),
              contentType: 'application/json; charset=utf-8',
            }).catch(() => null);
          }
        }
        setProfiles(updatedList);
        if (targetUsername === user.username) {
          const selfMatch = updatedList.find((p) => p.username === user.username);
          if (selfMatch) {
            onProfileUpdated(token, {
              ...user,
              role: selfMatch.role,
              fskLimit: selfMatch.fskLimit,
            });
          }
        }
        setTransferTarget(null);
        setAdminNotice(noticeText);
        return;
      }
      const res = await fetch(`/api/nas/admin/profiles/${encodeURIComponent(targetUsername)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        error?: string;
        profiles?: AdminProfileEntry[];
        currentUser?: NasUser;
      };
      if (!res.ok) {
        setAdminError(data.error || 'Profil-Einstellung konnte nicht gespeichert werden.');
        return;
      }
      if (data.profiles) {
        setProfiles(data.profiles);
      }
      if (data.currentUser) {
        onProfileUpdated(token, data.currentUser);
      }
      setTransferTarget(null);
      setAdminNotice(noticeText);
    } catch {
      setAdminError('Verbindung zum NAS fehlgeschlagen.');
    } finally {
      setAdminBusyUser(null);
    }
  };

  const handleAdminCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingProfile) return;
    setAdminError(null);
    setAdminNotice(null);
    setCreatingProfile(true);
    try {
      if (isLocalFallbackToken(token)) {
        const cleanUser = createUsername
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '');
        if (cleanUser.length < 2) {
          setAdminError('Benutzername muss mindestens 2 gültige Zeichen enthalten.');
          return;
        }
        if (profiles.some((p) => p.username === cleanUser)) {
          setAdminError(`Profil @${cleanUser} existiert bereits.`);
          return;
        }
        const newEntry: AdminProfileEntry = {
          id: `nas-${cleanUser}-${Date.now()}`,
          username: cleanUser,
          displayName: createDisplayName.trim() || cleanUser,
          role: createRole,
          fskLimit: createFskLimit,
          createdAt: new Date().toISOString(),
          avatarColor: '#38BDF8',
          avatarUrl: null,
        };
        const updatedList = [...profiles, newEntry];
        const bridgeTarget = resolveBridgeTargetForAdmin();
        if (bridgeTarget.host && bridgeTarget.password) {
          await writeFileToNasBridge({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            targetPath: `${bridgeTarget.backendRoot}/profiles/${cleanUser}.json`,
            content: JSON.stringify(
              {
                ...newEntry,
                password: createPassword || undefined,
              },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          });
          await writeFileToNasBridge({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            targetPath: `${bridgeTarget.backendRoot}/config/profiles.json`,
            content: JSON.stringify(updatedList, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        setProfiles(updatedList);
        setAdminNotice(
          `Profil „${newEntry.displayName}“ (FSK ${createFskLimit}) wurde per Storage-Bridge auf dem NAS angelegt.`
        );
        setCreateUsername('');
        setCreateDisplayName('');
        setCreatePassword('');
        setCreateRole('family');
        setCreateFskLimit(12);
        setShowCreateProfile(false);
        return;
      }
      const res = await fetch('/api/nas/admin/profiles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: createUsername.trim(),
          displayName: createDisplayName.trim() || createUsername.trim(),
          password: createPassword,
          role: createRole,
          fskLimit: createFskLimit,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        profile?: AdminProfileEntry;
        profiles?: AdminProfileEntry[];
      };
      if (!res.ok) {
        setAdminError(data.error || 'Profil konnte nicht erstellt werden.');
        return;
      }
      if (data.profiles) {
        setProfiles(data.profiles);
      }
      setAdminNotice(
        `Profil „${data.profile?.displayName ?? createUsername}“ (FSK ${createFskLimit}) wurde auf dem NAS angelegt.`
      );
      setCreateUsername('');
      setCreateDisplayName('');
      setCreatePassword('');
      setCreateRole('family');
      setCreateFskLimit(12);
      setShowCreateProfile(false);
    } catch {
      setAdminError('Verbindung zum NAS beim Anlegen fehlgeschlagen.');
    } finally {
      setCreatingProfile(false);
    }
  };

  const handleAdminDeleteProfile = async (targetUsername: string) => {
    setAdminBusyUser(targetUsername);
    setAdminError(null);
    setAdminNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const updatedList = profiles.filter((p) => p.username !== targetUsername);
        const bridgeTarget = resolveBridgeTargetForAdmin();
        if (bridgeTarget.host && bridgeTarget.password) {
          await writeFileToNasBridge({
            protocol: bridgeTarget.protocol,
            host: bridgeTarget.host,
            port: bridgeTarget.port,
            shareOrPath: bridgeTarget.shareOrPath,
            username: bridgeTarget.username,
            password: bridgeTarget.password,
            fritzPassword: bridgeTarget.fritzPassword,
            useTls: bridgeTarget.useTls,
            targetPath: `${bridgeTarget.backendRoot}/config/profiles.json`,
            content: JSON.stringify(updatedList, null, 2),
            contentType: 'application/json; charset=utf-8',
          }).catch(() => null);
        }
        setProfiles(updatedList);
        setDeleteTarget(null);
        setAdminNotice(`Profil @${targetUsername} wurde über Storage-Bridge entfernt.`);
        return;
      }
      const res = await fetch(`/api/nas/admin/profiles/${encodeURIComponent(targetUsername)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { error?: string; profiles?: AdminProfileEntry[] };
      if (!res.ok) {
        setAdminError(data.error || 'Profil konnte nicht entfernt werden.');
        return;
      }
      if (data.profiles) {
        setProfiles(data.profiles);
      }
      setDeleteTarget(null);
      setAdminNotice(`Profil @${targetUsername} wurde vom NAS entfernt.`);
    } catch {
      setAdminError('Verbindung zum NAS beim Entfernen fehlgeschlagen.');
    } finally {
      setAdminBusyUser(null);
    }
  };

  const adminCount = profiles.filter((p) => p.role === 'admin').length;
  const protectedCount = profiles.filter((p) => (p.fskLimit ?? 18) < 18).length;

  const authMethodsDirty =
    draftAllowedProtocols.length !== savedAllowedProtocols.length ||
    draftAllowedProtocols.some((p) => !savedAllowedProtocols.includes(p));

  const handleToggleAllowedProtocol = (protoId: NasProtocolId) => {
    setAuthMethodsError(null);
    setAuthMethodsNotice(null);
    setDraftAllowedProtocols((prev) => {
      if (prev.includes(protoId)) {
        if (prev.length <= 1) {
          setAuthMethodsError('Mindestens ein NAS-Anmeldeweg muss für Benutzer aktiviert bleiben.');
          return prev;
        }
        return prev.filter((item) => item !== protoId);
      }
      return NAS_PROTOCOL_CATALOG.map((p) => p.id).filter(
        (id) => id === protoId || prev.includes(id)
      );
    });
  };

  const handleSaveAllowedAuthMethods = async (protocolsToSave?: NasProtocolId[]) => {
    const targetList = protocolsToSave ?? draftAllowedProtocols;
    if (targetList.length === 0) {
      setAuthMethodsError('Mindestens ein NAS-Anmeldeweg muss ausgewählt sein.');
      return;
    }
    setSavingAuthMethods(true);
    setAuthMethodsError(null);
    setAuthMethodsNotice(null);
    try {
      if (isLocalFallbackToken(token)) {
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const wr = await writeFileToNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/allowed-auth-methods.json`,
            content: JSON.stringify(
              { allowedProtocols: targetList, updatedAt: new Date().toISOString() },
              null,
              2
            ),
            contentType: 'application/json; charset=utf-8',
          });
          if (!wr.ok) {
            setAuthMethodsError(
              wr.error || 'NAS-Anmeldewege konnten nicht über Storage-Bridge geschrieben werden.'
            );
            return;
          }
        }
        setSavedAllowedProtocols(targetList);
        setDraftAllowedProtocols(targetList);
        setAuthMethodsNotice(
          `Gespeichert: ${targetList.length} von ${NAS_PROTOCOL_CATALOG.length} NAS-Anmeldewegen über Storage-Bridge auf dem NAS gesichert.`
        );
        return;
      }
      const res = await fetch('/api/nas/admin/nas-auth-methods', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ allowedProtocols: targetList }),
      });
      const data = (await res.json()) as {
        error?: string;
        allowedProtocols?: NasProtocolId[];
      };
      if (!res.ok || !data.allowedProtocols) {
        setAuthMethodsError(
          data.error || 'NAS-Anmeldewege konnten nicht auf dem NAS gespeichert werden.'
        );
        return;
      }
      setSavedAllowedProtocols(data.allowedProtocols);
      setDraftAllowedProtocols(data.allowedProtocols);
      setAuthMethodsNotice(
        `Gespeichert: ${data.allowedProtocols.length} von ${NAS_PROTOCOL_CATALOG.length} NAS-Anmeldewegen für Benutzer und Registrierungen freigegeben.`
      );
    } catch {
      setAuthMethodsError('Verbindung zum NAS beim Speichern fehlgeschlagen.');
    } finally {
      setSavingAuthMethods(false);
    }
  };

  const formatVaultBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
  };

  const uploadEnvelopeAndAcknowledge = async (
    accessToken: string,
    envelope: EncryptedCloudVaultEnvelope,
    existingFileId: string | null | undefined,
    fbAccount: { email: string | null; displayName: string | null; photoURL: string | null },
    activateCloudMode: boolean
  ) => {
    const uploaded = await uploadEncryptedCloudVaultFile(accessToken, envelope, existingFileId);
    setCloudDriveFile(uploaded);

    const ackRes = await fetch('/api/nas/admin/user-storage/cloud-sync-ack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cloudRemoteFileId: uploaded.id,
        cloudAccountEmail: fbAccount.email,
        cloudAccountName: fbAccount.displayName,
        cloudAccountPhotoUrl: fbAccount.photoURL,
        encryptedAt: envelope.encryptedAt,
        mode: activateCloudMode ? 'cloud' : undefined,
      }),
    });
    if (ackRes.ok) {
      const ackData = (await ackRes.json()) as {
        config: UserDataStorageConfig;
        vaultPreview: UserDataVaultPreview;
      };
      setUserStorageConfig(ackData.config);
      setVaultPreview(ackData.vaultPreview);
      if (activateCloudMode) {
        setStorageModeDraft('cloud');
      }
    }
    return uploaded;
  };

  const handleAdminCloudGoogleSignIn = async () => {
    setCloudAuthBusy(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      const { user: fbUser, accessToken } = await signInWithGoogleForDrive();
      setGoogleUser(fbUser);
      setGoogleAccessToken(accessToken);

      const existing = await findEncryptedCloudVaultFile(accessToken);
      setCloudDriveFile(existing);

      const saveRes = await fetch('/api/nas/admin/user-storage', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'cloud',
          cloudProvider: 'google_drive',
          cloudAccountEmail: fbUser.email || fbUser.displayName || 'google-account',
          cloudAccountName: fbUser.displayName || fbUser.email || 'Google Konto',
          cloudAccountPhotoUrl: fbUser.photoURL || null,
          cloudRemoteFileId: existing?.id ?? null,
        }),
      });
      const saveData = (await saveRes.json()) as {
        error?: string;
        config?: UserDataStorageConfig;
        vaultPreview?: UserDataVaultPreview;
        envelope?: EncryptedCloudVaultEnvelope;
      };
      if (!saveRes.ok || !saveData.config) {
        setUserStorageError(
          saveData.error || 'Google-Cloud-Anmeldung konnte nicht gespeichert werden.'
        );
        return;
      }

      setUserStorageConfig(saveData.config);
      if (saveData.vaultPreview) setVaultPreview(saveData.vaultPreview);
      setStorageModeDraft('cloud');
      setCloudProviderDraft('google_drive');

      if (saveData.envelope) {
        if (existing) {
          setPendingDriveOverwrite({
            existingFile: existing,
            envelope: saveData.envelope,
            activateCloudMode: true,
          });
          setUserStorageNotice(
            `Google-Konto (${fbUser.email || fbUser.displayName}) angemeldet. Auf Google Drive existiert bereits „${existing.name}“ — bitte bestätige das Aktualisieren.`
          );
        } else {
          const uploaded = await uploadEnvelopeAndAcknowledge(
            accessToken,
            saveData.envelope,
            null,
            {
              email: fbUser.email || null,
              displayName: fbUser.displayName || null,
              photoURL: fbUser.photoURL || null,
            },
            true
          );
          setUserStorageNotice(
            `Google-Cloud angemeldet (${fbUser.email || fbUser.displayName}) und Nutzerdaten automatisch AES-256-GCM verschlüsselt als „${uploaded.name}“ gespeichert.`
          );
        }
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/popup-closed-by-user') {
        setUserStorageError('Google-Cloud-Anmeldung wurde abgebrochen.');
      } else {
        setUserStorageError(
          err instanceof Error ? err.message : 'Google-Cloud-Anmeldung fehlgeschlagen.'
        );
      }
    } finally {
      setCloudAuthBusy(false);
    }
  };

  const handleAdminCloudGoogleDisconnect = async () => {
    setCloudAuthBusy(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      await signOutGoogleForDrive();
      setGoogleUser(null);
      setGoogleAccessToken(null);
      setCloudDriveFile(null);

      const res = await fetch('/api/nas/admin/user-storage/google-disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          config: UserDataStorageConfig;
          vaultPreview: UserDataVaultPreview;
        };
        setUserStorageConfig(data.config);
        setVaultPreview(data.vaultPreview);
      }
      setUserStorageNotice('Google-Cloud-Sitzung getrennt.');
    } catch {
      setUserStorageError('Trennung der Google-Cloud-Anmeldung fehlgeschlagen.');
    } finally {
      setCloudAuthBusy(false);
    }
  };

  const handleGoogleDriveEncryptedSync = async () => {
    if (!googleAccessToken) {
      setUserStorageError(
        'Bitte melde dich zuerst direkt hier über „Sign in with Google“ an, um verschlüsselt auf Google Drive zu synchronisieren.'
      );
      return;
    }
    setCloudSyncBusy(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      const envRes = await fetch('/api/nas/admin/user-storage/cloud-envelope', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const envData = (await envRes.json()) as {
        error?: string;
        envelope?: EncryptedCloudVaultEnvelope;
        vaultPreview?: UserDataVaultPreview;
      };
      if (!envRes.ok || !envData.envelope) {
        setUserStorageError(
          envData.error || 'Verschlüsselter Nutzerdaten-Tresor konnte nicht erzeugt werden.'
        );
        return;
      }
      if (envData.vaultPreview) setVaultPreview(envData.vaultPreview);

      const existing = await findEncryptedCloudVaultFile(googleAccessToken);
      setCloudDriveFile(existing);

      if (existing) {
        setPendingDriveOverwrite({
          existingFile: existing,
          envelope: envData.envelope,
          activateCloudMode: storageModeDraft === 'cloud',
        });
        return;
      }

      const uploaded = await uploadEnvelopeAndAcknowledge(
        googleAccessToken,
        envData.envelope,
        null,
        {
          email: googleUser?.email || userStorageConfig?.cloudAccountEmail || null,
          displayName: googleUser?.displayName || userStorageConfig?.cloudAccountName || null,
          photoURL: googleUser?.photoURL || userStorageConfig?.cloudAccountPhotoUrl || null,
        },
        storageModeDraft === 'cloud'
      );
      setUserStorageNotice(
        `Nutzerdaten automatisch mit AES-256-GCM verschlüsselt und als „${uploaded.name}“ auf Google Drive gespeichert.`
      );
    } catch (err) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        clearInMemoryDriveToken();
        setGoogleAccessToken(null);
      }
      setUserStorageError(
        err instanceof Error ? err.message : 'Verschlüsselte Google-Drive-Synchronisation fehlgeschlagen.'
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleConfirmPendingDriveOverwrite = async () => {
    if (!pendingDriveOverwrite || !googleAccessToken) {
      setPendingDriveOverwrite(null);
      return;
    }
    setCloudSyncBusy(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      const uploaded = await uploadEnvelopeAndAcknowledge(
        googleAccessToken,
        pendingDriveOverwrite.envelope,
        pendingDriveOverwrite.existingFile.id,
        {
          email: googleUser?.email || userStorageConfig?.cloudAccountEmail || null,
          displayName: googleUser?.displayName || userStorageConfig?.cloudAccountName || null,
          photoURL: googleUser?.photoURL || userStorageConfig?.cloudAccountPhotoUrl || null,
        },
        pendingDriveOverwrite.activateCloudMode
      );
      setPendingDriveOverwrite(null);
      setUserStorageNotice(
        `Verschlüsselter Cloud-Tresor „${uploaded.name}“ (AES-256-GCM) auf Google Drive erfolgreich aktualisiert.`
      );
    } catch (err) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        clearInMemoryDriveToken();
        setGoogleAccessToken(null);
      }
      setUserStorageError(
        err instanceof Error ? err.message : 'Aktualisierung auf Google Drive fehlgeschlagen.'
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleVerifyGoogleDriveEncryption = async () => {
    const fileId = cloudDriveFile?.id || userStorageConfig?.cloudRemoteFileId;
    if (!googleAccessToken || !fileId) {
      setUserStorageError(
        'Bitte melde dich mit Google an und speichere zuerst einen verschlüsselten Cloud-Tresor.'
      );
      return;
    }
    setCloudVerifyBusy(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      const downloaded = await downloadEncryptedCloudVaultFile(googleAccessToken, fileId);
      const verifyRes = await fetch('/api/nas/admin/user-storage/verify-envelope', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ envelope: downloaded }),
      });
      const verifyData = (await verifyRes.json()) as {
        error?: string;
        verified?: boolean;
        algorithm?: string;
        payloadSha256?: string;
        summary?: UserDataVaultPreview['summary'];
      };
      if (!verifyRes.ok || !verifyData.verified) {
        setUserStorageError(
          verifyData.error || 'Prüfung der Cloud-Verschlüsselung ist fehlgeschlagen.'
        );
        return;
      }
      setUserStorageNotice(
        `Integrität bestätigt: Cloud-Datei ist mit ${verifyData.algorithm} verschlüsselt und fehlerfrei entschlüsselbar (${verifyData.summary?.usersCount ?? 0} Profile · SHA-256 ${verifyData.payloadSha256?.slice(0, 12)}…).`
      );
    } catch (err) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        clearInMemoryDriveToken();
        setGoogleAccessToken(null);
      }
      setUserStorageError(
        err instanceof Error ? err.message : 'Cloud-Tresor konnte nicht geprüft werden.'
      );
    } finally {
      setCloudVerifyBusy(false);
    }
  };

  const handleSaveUserStorage = async () => {
    setSavingUserStorage(true);
    setUserStorageError(null);
    setUserStorageNotice(null);
    try {
      const payload: Record<string, unknown> = {
        mode: storageModeDraft,
        cloudProvider: cloudProviderDraft,
      };
      if (cloudProviderDraft === 'google_drive') {
        payload.cloudAccountEmail =
          googleUser?.email ?? userStorageConfig?.cloudAccountEmail ?? null;
        payload.cloudAccountName =
          googleUser?.displayName ?? userStorageConfig?.cloudAccountName ?? null;
        payload.cloudAccountPhotoUrl =
          googleUser?.photoURL ?? userStorageConfig?.cloudAccountPhotoUrl ?? null;
        payload.cloudRemoteFileId =
          cloudDriveFile?.id ?? userStorageConfig?.cloudRemoteFileId ?? null;
      } else {
        payload.webdavUrl = webdavUrlDraft.trim();
        payload.webdavUsername = webdavUsernameDraft.trim();
        payload.webdavRemotePath = webdavRemotePathDraft.trim() || '/entencenter-userdata-vault.enc.json';
        if (webdavSecretDraft.length > 0) {
          payload.webdavSecret = webdavSecretDraft;
        }
      }

      if (isLocalFallbackToken(token)) {
        const target = resolveBridgeTargetForAdmin();
        const nextCfg: UserDataStorageConfig = {
          mode: storageModeDraft,
          cloudProvider: cloudProviderDraft,
          autoEncrypt: true,
          encryptionAlgorithm: 'AES-256-GCM',
          keyFingerprint: userStorageConfig?.keyFingerprint || 'STORAGE-BRIDGE-LOCAL',
          cloudAccountEmail:
            storageModeDraft === 'cloud' && cloudProviderDraft === 'google_drive'
              ? googleUser?.email ?? userStorageConfig?.cloudAccountEmail ?? null
              : null,
          cloudAccountName:
            storageModeDraft === 'cloud' && cloudProviderDraft === 'google_drive'
              ? googleUser?.displayName ?? userStorageConfig?.cloudAccountName ?? null
              : null,
          cloudAccountPhotoUrl:
            storageModeDraft === 'cloud' && cloudProviderDraft === 'google_drive'
              ? googleUser?.photoURL ?? userStorageConfig?.cloudAccountPhotoUrl ?? null
              : null,
          cloudRemoteFileId:
            cloudDriveFile?.id ?? userStorageConfig?.cloudRemoteFileId ?? null,
          cloudRemoteFileName: CLOUD_VAULT_FILE_NAME,
          webdavUrl: webdavUrlDraft.trim(),
          webdavUsername: webdavUsernameDraft.trim(),
          hasWebdavSecret: Boolean(webdavSecretDraft.length > 0 || userStorageConfig?.hasWebdavSecret),
          webdavRemotePath: webdavRemotePathDraft.trim() || '/entencenter-userdata-vault.enc.json',
          lastEncryptedSyncAt: new Date().toISOString(),
          lastSyncStatus: 'synced',
          lastSyncError: null,
          updatedAt: new Date().toISOString(),
          updatedBy: user.username,
        };
        if (target.host && target.password) {
          const wr = await writeFileToNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/user-storage.json`,
            content: JSON.stringify(nextCfg, null, 2),
            contentType: 'application/json; charset=utf-8',
          });
          if (!wr.ok) {
            setUserStorageError(
              wr.error || 'Speichereinstellungen konnten nicht in Storage-Bridge gespeichert werden.'
            );
            return;
          }
        }
        setUserStorageConfig(nextCfg);
        setWebdavSecretDraft('');
        setUserStorageNotice(
          storageModeDraft === 'nas'
            ? 'Nutzerdatenspeicherung auf „NAS (Storage-Bridge)“ umgestellt und auf dem NAS gesichert.'
            : 'Cloud-Konfiguration über Storage-Bridge gesichert.'
        );
        return;
      }

      const res = await fetch('/api/nas/admin/user-storage', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        error?: string;
        config?: UserDataStorageConfig;
        vaultPreview?: UserDataVaultPreview;
        envelope?: EncryptedCloudVaultEnvelope;
      };
      if (!res.ok || !data.config) {
        setUserStorageError(
          data.error || 'Einstellungen zur Nutzerdatenspeicherung konnten nicht gespeichert werden.'
        );
        return;
      }

      setUserStorageConfig(data.config);
      if (data.vaultPreview) setVaultPreview(data.vaultPreview);
      setWebdavSecretDraft('');

      if (storageModeDraft === 'nas') {
        setUserStorageNotice(
          'Nutzerdatenspeicherung auf „NAS (Lokal)“ umgestellt und auf dem NAS gespeichert.'
        );
        return;
      }

      if (cloudProviderDraft === 'webdav') {
        if (data.config.lastSyncStatus === 'synced') {
          setUserStorageNotice(
            'Cloud-Speicherung (WebDAV / Nextcloud) aktiviert: Alle Nutzerdaten wurden automatisch mit AES-256-GCM verschlüsselt und in die Cloud übertragen.'
          );
        } else {
          setUserStorageError(
            `Cloud-Modus gespeichert, aber WebDAV-Übertragung meldete: ${data.config.lastSyncError || 'Verbindungsfehler'}`
          );
        }
        return;
      }

      if (data.envelope && googleAccessToken) {
        const existing = await findEncryptedCloudVaultFile(googleAccessToken);
        setCloudDriveFile(existing);
        if (existing) {
          setPendingDriveOverwrite({
            existingFile: existing,
            envelope: data.envelope,
            activateCloudMode: true,
          });
        } else {
          const uploaded = await uploadEnvelopeAndAcknowledge(
            googleAccessToken,
            data.envelope,
            null,
            {
              email: googleUser?.email || data.config.cloudAccountEmail,
              displayName: googleUser?.displayName || data.config.cloudAccountName,
              photoURL: googleUser?.photoURL || data.config.cloudAccountPhotoUrl,
            },
            true
          );
          setUserStorageNotice(
            `Cloud-Speicherung aktiviert: Nutzerdaten automatisch mit AES-256-GCM verschlüsselt und als „${uploaded.name}“ auf Google Drive gespeichert.`
          );
        }
      } else {
        setUserStorageNotice(
          'Cloud-Speicherung (AES-256-GCM) aktiviert. Klicke auf „Jetzt verschlüsselt synchronisieren“, falls die Google-Sitzung neu bestätigt werden muss.'
        );
      }
    } catch {
      setUserStorageError('Verbindung zum Server beim Speichern der Speicher-Einstellungen fehlgeschlagen.');
    } finally {
      setSavingUserStorage(false);
    }
  };

  const uploadedCatalogCount = adminCatalog.filter((c) => c.hasUploadedFile).length;

  const probeMediaDurationMinutes = (file: File, kind: MediaKind): Promise<number | null> =>
    new Promise((resolve) => {
      if (kind !== 'movie' && kind !== 'series' && kind !== 'video' && kind !== 'music') {
        resolve(null);
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      const el = document.createElement(kind === 'music' ? 'audio' : 'video');
      el.preload = 'metadata';
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      }, 2500);
      el.onloadedmetadata = () => {
        window.clearTimeout(timer);
        const dur = el.duration;
        URL.revokeObjectURL(objectUrl);
        if (Number.isFinite(dur) && dur > 0) {
          resolve(Math.max(1, Math.round(dur / 60)));
        } else {
          resolve(null);
        }
      };
      el.onerror = () => {
        window.clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      el.src = objectUrl;
    });

  const enqueueFilesForNasUpload = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setUploadError(null);
    setUploadNotice(null);

    const newEntries: StagedUploadFile[] = files.map((file) => {
      const detectedKind = inferKindFromBrowserFile(file);
      const defaultDur =
        detectedKind === 'movie'
          ? 90
          : detectedKind === 'series'
            ? 45
            : detectedKind === 'music'
              ? 4
              : detectedKind === 'video'
                ? 5
                : 1;
      return {
        localId: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        title: deriveTitleFromFileName(file.name),
        kind: detectedKind,
        genre: MEDIA_KIND_LABELS[detectedKind],
        year: new Date().getFullYear(),
        fsk: defaultUploadFsk,
        nasFolder: defaultUploadFolder.trim() || DEFAULT_NAS_FOLDER_BY_KIND[detectedKind],
        durationMinutes: defaultDur,
        totalEpisodes: 1,
        synopsis: '',
        coverFile: null,
        status: 'queued',
        progress: 0,
        loadedBytes: 0,
      };
    });

    setUploadQueue((prev) => [...prev, ...newEntries]);

    // Dauer im Browser aus Video-/Audio-Metadaten ermitteln
    for (const entry of newEntries) {
      void probeMediaDurationMinutes(entry.file, entry.kind).then((mins) => {
        if (mins !== null) {
          setUploadQueue((prev) =>
            prev.map((q) => (q.localId === entry.localId ? { ...q, durationMinutes: mins } : q))
          );
        }
      });
    }
  };

  const handleZoneDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragActive(true);
  };

  const handleZoneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragActive) setIsDragActive(true);
  };

  const handleZoneDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragActive(false);
    }
  };

  const handleZoneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      enqueueFilesForNasUpload(e.dataTransfer.files);
    }
  };

  const uploadSingleFileWithProgress = (
    entry: StagedUploadFile,
    deferNotify: boolean
  ): Promise<{ id: string; title: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeUploadXhrRef.current = xhr;
      xhr.open('POST', '/api/nas/upload', true);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('x-nas-filename', encodeURIComponent(entry.file.name));
      xhr.setRequestHeader('x-nas-mime', encodeURIComponent(entry.file.type || 'application/octet-stream'));
      xhr.setRequestHeader('x-nas-title', encodeURIComponent(entry.title.trim() || entry.file.name));
      xhr.setRequestHeader('x-nas-kind', encodeURIComponent(entry.kind));
      xhr.setRequestHeader('x-nas-genre', encodeURIComponent(entry.genre.trim() || MEDIA_KIND_LABELS[entry.kind]));
      xhr.setRequestHeader('x-nas-year', String(entry.year || new Date().getFullYear()));
      xhr.setRequestHeader('x-nas-fsk', String(entry.fsk));
      xhr.setRequestHeader('x-nas-folder', encodeURIComponent(entry.nasFolder.trim() || DEFAULT_NAS_FOLDER_BY_KIND[entry.kind]));
      xhr.setRequestHeader('x-nas-duration', String(entry.durationMinutes || 1));
      xhr.setRequestHeader('x-nas-episodes', String(entry.totalEpisodes || 1));
      xhr.setRequestHeader('x-nas-synopsis', encodeURIComponent(entry.synopsis.trim()));
      xhr.setRequestHeader('x-nas-defer-notify', deferNotify ? '1' : '0');

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && evt.total > 0) {
          const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
          setUploadQueue((prev) =>
            prev.map((q) =>
              q.localId === entry.localId
                ? { ...q, status: 'uploading', progress: pct, loadedBytes: evt.loaded }
                : q
            )
          );
        }
      };

      xhr.onload = () => {
        activeUploadXhrRef.current = null;
        let parsed: { error?: string; item?: { id: string; title: string } } = {};
        try {
          parsed = JSON.parse(xhr.responseText || '{}') as {
            error?: string;
            item?: { id: string; title: string };
          };
        } catch {
          // Ignorieren
        }
        if (xhr.status >= 200 && xhr.status < 300 && parsed.item) {
          resolve(parsed.item);
        } else {
          reject(new Error(parsed.error || `Upload fehlgeschlagen (HTTP ${xhr.status}).`));
        }
      };

      xhr.onerror = () => {
        activeUploadXhrRef.current = null;
        reject(new Error('Netzwerkfehler während der Dateiübertragung zum NAS.'));
      };

      xhr.onabort = () => {
        activeUploadXhrRef.current = null;
        reject(new Error('Upload abgebrochen.'));
      };

      xhr.send(entry.file);
    });

  const handleStartNasUpload = async () => {
    const pendingItems = uploadQueue.filter(
      (item) => item.status === 'queued' || item.status === 'error'
    );
    if (pendingItems.length === 0 || uploadingFiles) return;

    setUploadingFiles(true);
    setUploadError(null);
    setUploadNotice(null);

    if (isLocalFallbackToken(token)) {
      const bridgeTarget = resolveBridgeTargetForAdmin();
      if (!bridgeTarget.host || !bridgeTarget.password) {
        setUploadingFiles(false);
        setUploadError(
          'Für den direkten Datei-Upload aufs NAS werden Hostname/IP und NAS-Passwort benötigt. Öffne oben im „NAS-Ordner-Explorer“ die Zugangsdaten oder hinterlege sie unter „Profil → NAS-Verbindung“.'
        );
        return;
      }

      const uploadedMediaItems: NasMediaItem[] = [];
      let successCount = 0;
      let errorCount = 0;

      for (const entry of pendingItems) {
        setUploadQueue((prev) =>
          prev.map((q) =>
            q.localId === entry.localId
              ? { ...q, status: 'uploading', progress: 0, loadedBytes: 0, errorMessage: undefined }
              : q
          )
        );

        try {
          const safeFileName =
            entry.file.name.replace(/[/\\:*?"<>|]+/g, '_').trim() || `upload-${Date.now()}.bin`;
          const rawFolder = entry.nasFolder.trim() || DEFAULT_NAS_FOLDER_BY_KIND[entry.kind];
          const normalizedFolder = rawFolder.startsWith('/mnt/nas/')
            ? `${bridgeTarget.backendRoot}/uploads/${rawFolder.slice('/mnt/nas/'.length).replace(/^\/+/, '')}`
            : normalizeScanFolderPath(rawFolder);
          const targetPath = `${normalizedFolder === '/' ? '' : normalizedFolder}/${safeFileName}`;

          const uploadRes = await uploadBinaryFileToNasBridge({
            target: {
              protocol: bridgeTarget.protocol,
              host: bridgeTarget.host,
              port: bridgeTarget.port,
              shareOrPath: bridgeTarget.shareOrPath,
              username: bridgeTarget.username,
              password: bridgeTarget.password,
              fritzPassword: bridgeTarget.fritzPassword,
              useTls: bridgeTarget.useTls,
            },
            targetPath,
            file: entry.file,
            onProgress: (pct) => {
              const loadedApprox = Math.round((pct / 100) * entry.file.size);
              setUploadQueue((prev) =>
                prev.map((q) =>
                  q.localId === entry.localId
                    ? { ...q, status: 'uploading', progress: pct, loadedBytes: loadedApprox }
                    : q
                )
              );
            },
          });

          if (!uploadRes.ok) {
            throw new Error(
              uploadRes.error || 'Datei konnte nicht direkt auf das NAS geschrieben werden.'
            );
          }

          const newItemId = `nas-up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const newItem: NasMediaItem = {
            id: newItemId,
            tmdbId: Math.floor(100000 + Math.random() * 800000),
            title: entry.title.trim() || deriveTitleFromFileName(entry.file.name),
            kind: entry.kind,
            genre: entry.genre.trim() || MEDIA_KIND_LABELS[entry.kind],
            year: entry.year || new Date().getFullYear(),
            coverUrl: getFallbackCoverForKind(entry.kind),
            synopsis:
              entry.synopsis.trim() ||
              `Direkt über Storage-Bridge nach ${uploadRes.filePath || targetPath} hochgeladen.`,
            codec:
              entry.kind === 'image'
                ? 'Bild'
                : entry.kind === 'music'
                  ? 'Audio'
                  : entry.kind === 'other'
                    ? 'Dokument'
                    : 'Video-Stream',
            audioTracks: entry.kind === 'image' || entry.kind === 'other' ? [] : ['Deutsch'],
            subtitles: [],
            totalDurationMinutes: entry.durationMinutes || 1,
            watchedMinutes: 0,
            episodesWatchedCount: 0,
            totalEpisodes: entry.kind === 'series' ? entry.totalEpisodes || 1 : undefined,
            lastWatchedAt: null,
            addedAt: new Date().toISOString(),
            nasPath: uploadRes.filePath || targetPath,
            fileFormat: entry.file.name.split('.').pop()?.toUpperCase() || 'FILE',
            fileSize: formatFileSizeCompact(entry.file.size),
            inWatchlist: false,
            fsk: entry.fsk,
            uploadedFileName: safeFileName,
            uploadedMimeType: entry.file.type || 'application/octet-stream',
            uploadedByteSize: entry.file.size,
          };

          uploadedMediaItems.push(newItem);
          successCount += 1;
          setUploadQueue((prev) =>
            prev.map((q) =>
              q.localId === entry.localId
                ? {
                    ...q,
                    status: 'done',
                    progress: 100,
                    loadedBytes: entry.file.size,
                    uploadedItemId: newItemId,
                  }
                : q
            )
          );
        } catch (err) {
          errorCount += 1;
          const msg = err instanceof Error ? err.message : 'NAS-Upload fehlgeschlagen.';
          setUploadQueue((prev) =>
            prev.map((q) =>
              q.localId === entry.localId
                ? { ...q, status: 'error', errorMessage: msg }
                : q
            )
          );
        }
      }

      if (uploadedMediaItems.length > 0) {
        const mergedCatalog = stripEphemeralMediaUrlForCatalog(
          upsertLocalBridgeCatalogItems(uploadedMediaItems)
        );
        saveLocalBridgeCatalog(mergedCatalog);
        const catRes = await writeFileToNasBridge({
          protocol: bridgeTarget.protocol,
          host: bridgeTarget.host,
          port: bridgeTarget.port,
          shareOrPath: bridgeTarget.shareOrPath,
          username: bridgeTarget.username,
          password: bridgeTarget.password,
          fritzPassword: bridgeTarget.fritzPassword,
          useTls: bridgeTarget.useTls,
          targetPath: `${bridgeTarget.backendRoot}/config/catalog.json`,
          content: JSON.stringify(mergedCatalog, null, 2),
          contentType: 'application/json; charset=utf-8',
        });
        if (!catRes.ok) {
          setUploadError(
            catRes.error ||
              'Datei(en) hochgeladen, aber catalog.json konnte nicht auf das NAS aktualisiert werden.'
          );
        } else {
          setUploadNotice(
            `${successCount} Datei(en) direkt auf ${bridgeTarget.host} (${bridgeTarget.shareOrPath}) übertragen und im NAS-Katalog gespeichert.`
          );
        }
        await loadAdminCatalog();
        onNasItemsAdded?.();
      }
      if (errorCount > 0) {
        setUploadError(`${errorCount} Datei(en) konnten nicht auf das NAS übertragen werden.`);
      }
      setUploadingFiles(false);
      return;
    }

    const createdIds: string[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const entry of pendingItems) {
      setUploadQueue((prev) =>
        prev.map((q) =>
          q.localId === entry.localId
            ? { ...q, status: 'uploading', progress: 0, loadedBytes: 0, errorMessage: undefined }
            : q
        )
      );

      try {
        const uploadedItem = await uploadSingleFileWithProgress(entry, true);

        if (entry.coverFile) {
          await fetch(`/api/nas/library/items/${encodeURIComponent(uploadedItem.id)}/cover`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': entry.coverFile.type || 'image/jpeg',
              'x-nas-filename': encodeURIComponent(entry.coverFile.name),
              'x-nas-mime': encodeURIComponent(entry.coverFile.type || 'image/jpeg'),
            },
            body: entry.coverFile,
          });
        }

        createdIds.push(uploadedItem.id);
        successCount += 1;
        setUploadQueue((prev) =>
          prev.map((q) =>
            q.localId === entry.localId
              ? {
                  ...q,
                  status: 'done',
                  progress: 100,
                  loadedBytes: entry.file.size,
                  uploadedItemId: uploadedItem.id,
                }
              : q
          )
        );
      } catch (err) {
        errorCount += 1;
        const msg = err instanceof Error ? err.message : 'Upload fehlgeschlagen.';
        setUploadQueue((prev) =>
          prev.map((q) =>
            q.localId === entry.localId
              ? { ...q, status: 'error', errorMessage: msg }
              : q
          )
        );
      }
    }

    let notifiedCount = 0;
    if (createdIds.length > 0 && notifyAfterUpload) {
      try {
        const batchRes = await fetch('/api/nas/library/notify-batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ itemIds: createdIds }),
        });
        if (batchRes.ok) {
          const batchData = (await batchRes.json()) as { notifiedUsers?: number };
          notifiedCount = batchData.notifiedUsers ?? 0;
        }
      } catch {
        // Ignorieren
      }
    }

    setUploadingFiles(false);

    if (successCount > 0) {
      setUploadNotice(
        notifyAfterUpload
          ? `${successCount} Datei(en) erfolgreich über /api/nas/upload auf das NAS geladen. Der Enten-Assistent hat ${notifiedCount} Benutzer benachrichtigt.`
          : `${successCount} Datei(en) erfolgreich über /api/nas/upload auf das NAS geladen.`
      );
      await loadAdminCatalog();
      onNasItemsAdded?.();
    }
    if (errorCount > 0) {
      setUploadError(`${errorCount} Datei(en) konnten nicht vollständig übertragen werden.`);
    }
  };

  const handleAbortActiveUpload = () => {
    activeUploadXhrRef.current?.abort();
  };

  const handleUpdateCatalogItem = async (
    itemId: string,
    updates: Partial<AdminNasCatalogItem>,
    successMsg: string
  ) => {
    setCatalogBusyId(itemId);
    setCatalogError(null);
    setCatalogNotice(null);
    if (isLocalFallbackToken(token)) {
      try {
        const current = readLocalBridgeCatalog();
        const nextList = stripEphemeralMediaUrlForCatalog(
          current.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  title: updates.title ?? item.title,
                  kind: updates.kind ?? item.kind,
                  genre: updates.genre ?? item.genre,
                  year: updates.year ?? item.year,
                  fsk: updates.fsk ?? item.fsk,
                  nasPath: updates.nasPath ?? item.nasPath,
                  totalDurationMinutes:
                    updates.totalDurationMinutes ?? item.totalDurationMinutes,
                  synopsis: updates.synopsis ?? item.synopsis,
                }
              : item
          )
        );
        saveLocalBridgeCatalog(nextList);
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const wr = await writeFileToNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/catalog.json`,
            content: JSON.stringify(nextList, null, 2),
            contentType: 'application/json; charset=utf-8',
          });
          if (!wr.ok) {
            setCatalogError(wr.error || 'Katalog konnte nicht auf das NAS geschrieben werden.');
          }
        }
        setEditingCatalogItem(null);
        setCatalogNotice(successMsg);
        await loadAdminCatalog();
        onNasItemsAdded?.();
      } catch {
        setCatalogError('Katalog-Eintrag konnte nicht aktualisiert werden.');
      } finally {
        setCatalogBusyId(null);
      }
      return;
    }
    try {
      const res = await fetch(`/api/nas/admin/library/${encodeURIComponent(itemId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setCatalogError(data.error || 'NAS-Eintrag konnte nicht aktualisiert werden.');
        return;
      }
      setEditingCatalogItem(null);
      setCatalogNotice(successMsg);
      await loadAdminCatalog();
      onNasItemsAdded?.();
    } catch {
      setCatalogError('Verbindung zum NAS beim Speichern fehlgeschlagen.');
    } finally {
      setCatalogBusyId(null);
    }
  };

  const handleDeleteCatalogItem = async (itemId: string) => {
    setCatalogBusyId(itemId);
    setCatalogError(null);
    setCatalogNotice(null);
    if (isLocalFallbackToken(token)) {
      try {
        const nextList = stripEphemeralMediaUrlForCatalog(
          readLocalBridgeCatalog().filter((item) => item.id !== itemId)
        );
        saveLocalBridgeCatalog(nextList);
        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const wr = await writeFileToNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/catalog.json`,
            content: JSON.stringify(nextList, null, 2),
            contentType: 'application/json; charset=utf-8',
          });
          if (!wr.ok) {
            setCatalogError(wr.error || 'Gelöschter Katalog konnte nicht auf das NAS synchronisiert werden.');
          }
        }
        setCatalogDeleteTarget(null);
        setCatalogNotice('Eintrag aus dem NAS-Bestand entfernt.');
        await loadAdminCatalog();
        onNasItemsAdded?.();
      } catch {
        setCatalogError('Eintrag konnte nicht gelöscht werden.');
      } finally {
        setCatalogBusyId(null);
      }
      return;
    }
    try {
      const res = await fetch(`/api/nas/admin/library/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setCatalogError(data.error || 'Eintrag konnte nicht vom NAS entfernt werden.');
        return;
      }
      setCatalogDeleteTarget(null);
      setCatalogNotice('Inhalt und zugehörige Upload-Datei wurden vom NAS entfernt.');
      await loadAdminCatalog();
      onNasItemsAdded?.();
    } catch {
      setCatalogError('Verbindung zum NAS beim Löschen fehlgeschlagen.');
    } finally {
      setCatalogBusyId(null);
    }
  };

  const loadScanBrowserDirectory = async (targetPath: string) => {
    const cleanPath = normalizeScanFolderPath(targetPath);
    setScanBrowserPath(cleanPath);
    setScanBrowserLoading(true);
    try {
      const result = await browseNasDirectoryTree({
        protocol: scanBrowserProto,
        host: scanBrowserHost.trim() || 'fritz.box',
        port: String(
          sanitizeNasPortForProtocol(
            scanBrowserProto,
            scanBrowserPort.trim() || undefined,
            scanBrowserProto === 'smb' ? false : scanBrowserUseTls
          )
        ),
        path: cleanPath,
        shareOrPath: scanBrowserShare.trim() || (scanBrowserProto === 'fritz_upnp' ? 'FRITZ.NAS' : '/'),
        username: scanBrowserUser.trim(),
        password: scanBrowserPass,
        fritzUsername: scanBrowserUser.trim(),
        fritzPassword: scanBrowserPass,
        useTls: scanBrowserProto === 'smb' ? false : scanBrowserUseTls,
        token: isLocalFallbackToken(token) ? undefined : token,
      });
      setScanBrowserResult(result);
    } catch (err) {
      setScanBrowserResult({
        ok: false,
        host: scanBrowserHost.trim() || 'fritz.box',
        protocol: scanBrowserProto,
        currentPath: cleanPath,
        parentPath: cleanPath === '/' ? null : '/',
        entries: [],
        recommendedBackendPath: '/EntenCenter-Backend',
        source: 'nas_template',
        error: err instanceof Error ? err.message : 'NAS-Ordner konnten nicht geladen werden.',
      });
    } finally {
      setScanBrowserLoading(false);
    }
  };

  const openScanBrowserModal = () => {
    const bridgeTarget = resolveBridgeTargetForAdmin();
    if (!scanBrowserHost.trim() && bridgeTarget.host) {
      setScanBrowserHost(bridgeTarget.host);
    }
    if (!scanBrowserPass && bridgeTarget.password) {
      setScanBrowserPass(bridgeTarget.password);
    }
    if (!scanBrowserUser && bridgeTarget.username) {
      setScanBrowserUser(bridgeTarget.username);
    }
    setScanBrowserOpen(true);
    void loadScanBrowserDirectory('/');
  };

  const toggleSelectedScanFolder = (folderPath: string) => {
    const norm = normalizeScanFolderPath(folderPath);
    setScanFolderNotice(null);
    setScanFolderError(null);
    setScanFolderSettings((prev) => {
      const exists = prev.selectedFolders.some(
        (p) => p.toLowerCase() === norm.toLowerCase()
      );
      const nextFolders = exists
        ? prev.selectedFolders.filter((p) => p.toLowerCase() !== norm.toLowerCase())
        : [...prev.selectedFolders, norm];
      return {
        ...prev,
        scanMode: nextFolders.length > 0 ? 'selected' : prev.scanMode,
        selectedFolders: nextFolders,
      };
    });
  };

  const handleSaveScanFolderSettings = async (overrideSettings?: NasScanFolderSettings) => {
    const candidate = overrideSettings ?? scanFolderSettings;
    const dedupedMap = new Map<string, string>();
    for (const raw of candidate.selectedFolders) {
      const norm = normalizeScanFolderPath(raw);
      dedupedMap.set(norm.toLowerCase(), norm);
    }
    const cleanFolders = Array.from(dedupedMap.values());
    const effectiveMode: NasScanFolderMode =
      candidate.scanMode === 'selected' ? 'selected' : 'all';

    if (effectiveMode === 'selected' && cleanFolders.length === 0) {
      setScanFolderError(
        'Bitte wähle mindestens einen NAS-Ordner aus oder stelle auf „Alle Ordner auf dem NAS scannen (Standard)“.'
      );
      return;
    }

    setSavingScanFolders(true);
    setScanFolderError(null);
    setScanFolderNotice(null);

    if (isLocalFallbackToken(token)) {
      try {
        const nextLocal: NasScanFolderSettings = {
          scanMode: effectiveMode,
          selectedFolders: cleanFolders,
          updatedAt: new Date().toISOString(),
          updatedBy: user.username,
        };
        saveLocalBridgeScanSettings(nextLocal);
        setScanFolderSettings(nextLocal);

        const target = resolveBridgeTargetForAdmin();
        if (target.host && target.password) {
          const wr = await writeFileToNasBridge({
            protocol: target.protocol,
            host: target.host,
            port: target.port,
            shareOrPath: target.shareOrPath,
            username: target.username,
            password: target.password,
            fritzPassword: target.fritzPassword,
            useTls: target.useTls,
            targetPath: `${target.backendRoot}/config/scan-folders.json`,
            content: JSON.stringify(nextLocal, null, 2),
            contentType: 'application/json; charset=utf-8',
          });
          if (wr.ok) {
            setScanFolderNotice(
              effectiveMode === 'all'
                ? `Scan-Modus gespeichert: Bei „Manueller Scan“ werden alle NAS-Ordner durchsucht (gesichert auf ${target.host}).`
                : `Scan-Konfiguration gespeichert: ${cleanFolders.length} ausgewählte(r) NAS-Ordner direkt auf ${target.host} gesichert.`
            );
          } else {
            setScanFolderError(
              wr.error || 'Scan-Einstellungen lokal gespeichert, aber Schreibzugriff aufs NAS fehlgeschlagen.'
            );
          }
        } else {
          setScanFolderNotice(
            effectiveMode === 'all'
              ? 'Standard aktiviert: Beim manuellen Scan werden alle NAS-Ordner gescannt.'
              : `${cleanFolders.length} Ordner für den manuellen Scan gespeichert (Storage-Bridge).`
          );
        }
      } catch {
        setScanFolderError('Scan-Ordner konnten nicht gespeichert werden.');
      } finally {
        setSavingScanFolders(false);
      }
      return;
    }

    try {
      const res = await fetch('/api/nas/admin/scan-folders', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          scanMode: effectiveMode,
          selectedFolders: cleanFolders,
        }),
      });
      const data = (await res.json()) as { error?: string; settings?: NasScanFolderSettings };
      if (!res.ok || !data.settings) {
        setScanFolderError(data.error || 'Scan-Ordner konnten nicht gespeichert werden.');
        return;
      }
      setScanFolderSettings(data.settings);
      setScanFolderNotice(
        data.settings.scanMode === 'all'
          ? 'Scan-Modus gespeichert: Beim manuellen Scan werden standardmäßig alle NAS-Ordner durchsucht.'
          : `Scan-Konfiguration gespeichert: ${data.settings.selectedFolders.length} ausgewählte(r) NAS-Ordner.`
      );
    } catch {
      setScanFolderError('Verbindung zum Server beim Speichern der Scan-Ordner fehlgeschlagen.');
    } finally {
      setSavingScanFolders(false);
    }
  };

  const totalQueueBytes = uploadQueue.reduce((acc, q) => acc + q.file.size, 0);
  const loadedQueueBytes = uploadQueue.reduce(
    (acc, q) => acc + (q.status === 'done' ? q.file.size : q.loadedBytes),
    0
  );
  const overallUploadPercent =
    totalQueueBytes > 0 ? Math.min(100, Math.round((loadedQueueBytes / totalQueueBytes) * 100)) : 0;
  const pendingUploadCount = uploadQueue.filter(
    (q) => q.status === 'queued' || q.status === 'error'
  ).length;

  const filteredAdminCatalog = adminCatalog.filter((entry) => {
    if (catalogKindFilter !== 'all' && entry.kind !== catalogKindFilter) return false;
    const q = catalogSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.genre.toLowerCase().includes(q) ||
      entry.nasPath.toLowerCase().includes(q)
    );
  });

  const showNotificationsSection = activeTab === 'all' || activeTab === 'notifications';
  const showAssistantSection = activeTab === 'all' || activeTab === 'assistant';
  const showContentSection = activeTab === 'all' || activeTab === 'content';
  const showProfilesSection = activeTab === 'all' || activeTab === 'profiles';
  const showNetworkSection = activeTab === 'all' || activeTab === 'network';
  const showPathsSection = activeTab === 'all' || activeTab === 'paths';
  const showAuthSection = activeTab === 'all' || activeTab === 'auth';
  const showStorageSection = activeTab === 'all' || activeTab === 'storage';

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-[calc(2rem+var(--app-bottom-clearance,0px))]">
      {/* Übersichtskarten */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#121722] border border-slate-800/80 rounded-2xl p-5">
          <p className="text-xs text-slate-400">Profile auf dem NAS</p>
          <p className="font-display text-2xl font-bold text-white mt-1 tabular-nums">
            {profiles.length}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Nur für Administratoren sichtbar
          </p>
        </div>
        <div className="bg-[#121722] border border-slate-800/80 rounded-2xl p-5">
          <p className="text-xs text-slate-400">Aktive Administratoren</p>
          <p className="font-display text-2xl font-bold text-amber-400 mt-1 tabular-nums">
            {adminCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Mindestens 1 Admin bleibt immer geschützt
          </p>
        </div>
        <div className="bg-[#121722] border border-slate-800/80 rounded-2xl p-5">
          <p className="text-xs text-slate-400">Jugendschutz (&lt; FSK 18)</p>
          <p className="font-display text-2xl font-bold text-sky-300 mt-1 tabular-nums">
            {protectedCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Inhalte werden automatisch nach FSK gefiltert
          </p>
        </div>
        <button
          type="button"
          onClick={() => selectAdminTab('content')}
          className="bg-[#121722] hover:bg-slate-800/40 border border-slate-800/80 hover:border-amber-400/50 rounded-2xl p-5 text-left transition-colors"
        >
          <p className="text-xs text-slate-400">NAS-Inhalte &amp; Uploads</p>
          <p className="font-display text-2xl font-bold text-emerald-300 mt-1 tabular-nums">
            {adminCatalog.length}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            Davon {uploadedCatalogCount} direkt hochgeladene Datei(en)
          </p>
        </button>
      </section>

      {/* Admin-Untermenüs (auf- und zuklappbar + Alle auf-/zuklappen) */}
      <div className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <div
          className={`px-4 py-3 flex flex-wrap items-center justify-between gap-2 ${
            adminSubmenuBarOpen ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <button
            type="button"
            aria-expanded={adminSubmenuBarOpen}
            onClick={() => setAdminSubmenuBarOpen((open) => !open)}
            className="flex items-center gap-2 text-xs font-semibold text-white hover:text-amber-300 transition-colors"
          >
            {adminSubmenuBarOpen ? (
              <ChevronDown className="w-4 h-4 text-amber-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-amber-400" />
            )}
            <span>Admin-Untermenüs ({activeTab === 'all' ? 'Alle Bereiche' : activeTab})</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAllSectionsCollapsed(false)}
              className="px-2.5 py-1 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-300 hover:text-white transition-colors"
            >
              Alle aufklappen
            </button>
            <button
              type="button"
              onClick={() => setAllSectionsCollapsed(true)}
              className="px-2.5 py-1 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-300 hover:text-white transition-colors"
            >
              Alle zuklappen
            </button>
          </div>
        </div>

        {adminSubmenuBarOpen && (
          <nav
            aria-label="Admin-Bereiche"
            className="flex flex-wrap items-center gap-2 p-2.5"
          >
            {(
              [
                { id: 'all', label: 'Alle Bereiche' },
                { id: 'notifications', label: `Benachrichtigungen (${broadcastHistory.length})` },
                { id: 'assistant', label: 'Enten-Assistent' },
                { id: 'content', label: `NAS-Inhalte & Datei-Upload (${adminCatalog.length})` },
                { id: 'profiles', label: `Profile & FSK (${profiles.length})` },
                { id: 'network', label: 'Netzwerk-Konfiguration' },
                { id: 'paths', label: 'Pfad-Einstellungen' },
                { id: 'auth', label: 'Anmeldewege & FRITZ!Box' },
                { id: 'storage', label: 'Nutzerdaten & Cloud' },
              ] as Array<{ id: AdminSectionTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectAdminTab(tab.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {/* Benachrichtigungen an alle Benutzer */}
      {showNotificationsSection && (
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          aria-expanded={!collapsedSections.notifications}
          onClick={() => toggleSectionCollapse('notifications')}
          className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
            !collapsedSections.notifications ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
              <Bell className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                Benachrichtigungen an alle Benutzer
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Verfasse eine Mitteilung vom Administrator, die sofort in der Benachrichtigungsglocke
                aller registrierten NAS-Benutzer erscheint.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="text-[11px] font-mono text-slate-300 bg-[#0B0E14] border border-slate-800 px-3 py-1 rounded-lg whitespace-nowrap tabular-nums">
              Empfänger: {profiles.length} Benutzer
            </span>
            <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
              {collapsedSections.notifications ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </div>
        </button>

        {!collapsedSections.notifications && (
        <div className="p-6 space-y-6">
          <form onSubmit={(e) => void handleSendAdminBroadcast(e)} className="space-y-4">
            {/* Auswahl des Nachrichtentyps */}
            <div className="space-y-2">
              <span className="block text-xs font-medium text-slate-300">
                Nachrichtentyp auswählen
              </span>
              <div
                role="radiogroup"
                aria-label="Nachrichtentyp auswählen"
                className="grid grid-cols-1 md:grid-cols-3 gap-3"
              >
                {ADMIN_NOTIFICATION_TYPE_OPTIONS.map((option) => {
                  const selected = broadcastMessageType === option.id;
                  const TypeIcon =
                    option.id === 'maintenance'
                      ? Wrench
                      : option.id === 'new_content'
                        ? Film
                        : Megaphone;
                  const accentClasses =
                    option.id === 'maintenance'
                      ? selected
                        ? 'bg-amber-400/15 border-amber-400 text-amber-200'
                        : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:border-slate-700'
                      : option.id === 'new_content'
                        ? selected
                          ? 'bg-emerald-500/15 border-emerald-400 text-emerald-200'
                          : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:border-slate-700'
                        : selected
                          ? 'bg-sky-500/15 border-sky-400 text-sky-200'
                          : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:border-slate-700';

                  const iconClasses =
                    option.id === 'maintenance'
                      ? selected
                        ? 'text-amber-300'
                        : 'text-slate-400'
                      : option.id === 'new_content'
                        ? selected
                          ? 'text-emerald-300'
                          : 'text-slate-400'
                        : selected
                          ? 'text-sky-300'
                          : 'text-slate-400';

                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setBroadcastMessageType(option.id)}
                      className={`p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${accentClasses}`}
                    >
                      <TypeIcon className={`w-4 h-4 mt-0.5 shrink-0 ${iconClasses}`} />
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-xs font-semibold text-white">{option.label}</p>
                        <p className="text-[11px] text-slate-400 leading-snug">
                          {option.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {(() => {
              const selectedOption =
                ADMIN_NOTIFICATION_TYPE_OPTIONS.find(
                  (opt) => opt.id === broadcastMessageType
                ) ?? ADMIN_NOTIFICATION_TYPE_OPTIONS[2];

              const previewTitle =
                broadcastMessageType === 'maintenance'
                  ? `[Wartung] ${broadcastTitle.trim() || 'Wartungsankündigung'}`
                  : broadcastMessageType === 'new_content'
                    ? `[Neue Inhalte] ${broadcastTitle.trim() || 'Neue Mediathek-Inhalte'}`
                    : broadcastTitle.trim() || 'Allgemeiner Hinweis';

              const previewBody =
                broadcastMessageType === 'maintenance'
                  ? `Wartungshinweis · System & NAS\n${broadcastMessage.trim() || 'Deine Wartungsnachricht erscheint hier...'}`
                  : broadcastMessageType === 'new_content'
                    ? `Neu in der Mediathek verfügbar\n${broadcastMessage.trim() || 'Deine Inhalts-Ankündigung erscheint hier...'}`
                    : broadcastMessage.trim() || 'Deine allgemeine Nachricht erscheint hier...';

              return (
                <>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="admin-broadcast-title"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Betreff / Titel
                    </label>
                    <input
                      id="admin-broadcast-title"
                      type="text"
                      maxLength={120}
                      value={broadcastTitle}
                      onChange={(e) => setBroadcastTitle(e.target.value)}
                      placeholder={selectedOption.titlePlaceholder}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="admin-broadcast-message"
                        className="block text-xs font-medium text-slate-300"
                      >
                        Nachricht an alle Benutzer
                      </label>
                      <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                        {broadcastMessage.length} / 2000
                      </span>
                    </div>
                    <textarea
                      id="admin-broadcast-message"
                      rows={4}
                      maxLength={2000}
                      value={broadcastMessage}
                      onChange={(e) => setBroadcastMessage(e.target.value)}
                      placeholder={selectedOption.messagePlaceholder}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 resize-y"
                    />
                  </div>

                  {/* Formatierungs-Vorschau */}
                  <div className="p-3.5 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <span className="font-semibold text-slate-300">Vorschau bei Benutzern</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          broadcastMessageType === 'maintenance'
                            ? 'text-amber-300 font-medium'
                            : broadcastMessageType === 'new_content'
                              ? 'text-emerald-300 font-medium'
                              : 'text-sky-300 font-medium'
                        }
                      >
                        Typ: {selectedOption.label}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{selectedOption.providerLabel}</span>
                    </div>
                    <p className="text-xs font-semibold text-white">{previewTitle}</p>
                    <p className="text-xs text-slate-300 whitespace-pre-line">{previewBody}</p>
                  </div>
                </>
              );
            })()}

            {broadcastError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{broadcastError}</span>
              </div>
            )}

            {broadcastNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{broadcastNotice}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-400">
                Wird typgerecht formatiert auf dem NAS gespeichert und per Echtzeit-Sync an alle
                angemeldeten Profile zugestellt.
              </p>

              <button
                type="submit"
                disabled={sendingBroadcast}
                className="px-4 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap ml-auto"
              >
                {sendingBroadcast ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                <span>
                  {sendingBroadcast
                    ? 'Sende Benachrichtigung...'
                    : `An alle Benutzer senden (${profiles.length})`}
                </span>
              </button>
            </div>
          </form>

          {/* Verlauf gesendeter Admin-Benachrichtigungen */}
          <div className="pt-5 border-t border-slate-800/80 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Gesendete Admin-Benachrichtigungen ({broadcastHistory.length})
              </h3>
              <button
                type="button"
                onClick={() => void loadAdminBroadcasts()}
                disabled={loadingBroadcasts}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingBroadcasts ? 'animate-spin' : ''}`} />
                <span>Aktualisieren</span>
              </button>
            </div>

            {loadingBroadcasts ? (
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 text-xs text-slate-400 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Lade gesendete Benachrichtigungen...</span>
              </div>
            ) : broadcastHistory.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 text-xs text-slate-400">
                Noch keine Admin-Benachrichtigungen an alle Benutzer gesendet.
              </div>
            ) : (
              <div className="space-y-2.5">
                {broadcastHistory.map((item) => {
                  const typeLabel =
                    item.messageType === 'maintenance'
                      ? 'Wartung'
                      : item.messageType === 'new_content'
                        ? 'Neue Inhalte'
                        : 'Allgemein';
                  const typeColor =
                    item.messageType === 'maintenance'
                      ? 'text-amber-300'
                      : item.messageType === 'new_content'
                        ? 'text-emerald-300'
                        : 'text-sky-300';

                  return (
                    <div
                      key={item.broadcastId}
                      className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="text-sm font-semibold text-white">{item.title}</p>
                          <span className={`text-[11px] font-semibold ${typeColor}`}>
                            · {typeLabel}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                            · {item.readCount}/{item.recipientCount} gelesen
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 whitespace-pre-line">{item.message}</p>
                        <p className="text-[11px] text-slate-500 tabular-nums">
                          {item.senderLabel} ·{' '}
                          {new Date(item.createdAt).toLocaleString('de-DE')}
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={deletingBroadcastId === item.broadcastId}
                        onClick={() => void handleDeleteAdminBroadcast(item.broadcastId)}
                        className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-rose-950/60 border border-slate-800 hover:border-rose-700/70 text-xs text-slate-300 hover:text-rose-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Für alle entfernen</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        )}
      </section>
      )}

      {/* Enten-Assistent: Avatar-Set & Standard-Avatar */}
      {showAssistantSection && (
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          aria-expanded={!collapsedSections.assistant}
          onClick={() => toggleSectionCollapse('assistant')}
          className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
            !collapsedSections.assistant ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                Enten-Assistent · Avatar-Set verwalten
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Ändere das Avatarbild der KI („Frag die Ente“, Empfehlungen &amp; Assistent-Chat) per
                Upload oder setze es jederzeit auf den hinterlegten Standard-Avatar zurück.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span
              className={`text-[11px] font-semibold px-3 py-1 rounded-lg border whitespace-nowrap ${
                assistantAvatarState.isCustom
                  ? 'bg-sky-500/15 border-sky-400/50 text-sky-200'
                  : 'bg-amber-400/15 border-amber-400/40 text-amber-300'
              }`}
            >
              {assistantAvatarState.isCustom ? 'Benutzerdefinierter Avatar aktiv' : 'Standard-Avatar aktiv'}
            </span>
            <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
              {collapsedSections.assistant ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </div>
        </button>

        {!collapsedSections.assistant && (
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 items-start">
            {/* Vorschau: Aktiver Avatar & Standard-Avatar */}
            <div className="space-y-3">
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 flex flex-col items-center text-center gap-3">
                <div className="relative w-32 h-32 rounded-2xl overflow-hidden bg-slate-900 border-2 border-amber-400/50 shadow-lg">
                  {loadingAssistantAvatar ? (
                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                      <Loader2 className="w-6 h-6 animate-spin" />
                    </div>
                  ) : (
                    <AssistantAvatarImage
                      src={assistantAvatarState.avatarUrl}
                      alt="Aktiver Enten-Assistent Avatar"
                      sizePx={128}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-white">Aktives KI-Avatarbild</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {assistantAvatarState.isCustom
                      ? 'Eigenes Bild auf dem NAS gespeichert'
                      : 'Standard-Avatar von EntenCenter'}
                  </p>
                </div>

                {/* Kompakte runde Darstellung wie in Assistent-Widgets */}
                <div className="w-full pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2 text-left">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AssistantAvatarImage
                      src={assistantAvatarState.defaultAvatarUrl}
                      alt="Standard-Avatar Vorschau"
                      sizePx={36}
                      className="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-slate-200 truncate">
                        Standard-Avatar
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        Werksseitig hinterlegt
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Upload-Zone & Aktionen */}
            <div className="space-y-4">
              <input
                ref={assistantAvatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  e.target.value = '';
                  if (chosen) {
                    void handleUploadAssistantAvatarFile(chosen);
                  }
                }}
              />

              <div
                onDragEnter={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setAssistantAvatarDragActive(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!assistantAvatarDragActive) setAssistantAvatarDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setAssistantAvatarDragActive(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setAssistantAvatarDragActive(false);
                  const droppedFile = e.dataTransfer?.files?.[0];
                  if (droppedFile) {
                    void handleUploadAssistantAvatarFile(droppedFile);
                  }
                }}
                onClick={() => {
                  if (!savingAssistantAvatar) assistantAvatarInputRef.current?.click();
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !savingAssistantAvatar) {
                    e.preventDefault();
                    assistantAvatarInputRef.current?.click();
                  }
                }}
                aria-label="Avatarbild für Enten-Assistent hochladen oder hierher ziehen"
                className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
                  assistantAvatarDragActive
                    ? 'border-amber-400 bg-amber-400/10'
                    : 'border-slate-700/80 bg-[#0B0E14] hover:border-amber-400/60 hover:bg-slate-900/60'
                }`}
              >
                <div className="w-12 h-12 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center mx-auto mb-3">
                  {savingAssistantAvatar ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <Upload className="w-6 h-6" />
                  )}
                </div>
                <p className="text-sm font-semibold text-white">
                  {savingAssistantAvatar
                    ? 'Avatarbild wird optimiert und auf dem NAS gespeichert...'
                    : 'Neues Avatar-Set per Klick oder Drag & Drop hochladen'}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Unterstützt PNG, JPG, WebP und GIF · Wird automatisch quadratisch auf 512×512 px
                  optimiert und zentral gespeichert.
                </p>
              </div>

              {assistantAvatarError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{assistantAvatarError}</span>
                </div>
              )}

              {assistantAvatarNotice && (
                <div
                  role="status"
                  className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{assistantAvatarNotice}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={savingAssistantAvatar}
                  onClick={() => assistantAvatarInputRef.current?.click()}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>Avatar-Bild hochladen</span>
                </button>

                <button
                  type="button"
                  disabled={savingAssistantAvatar || !assistantAvatarState.isCustom}
                  onClick={() => void handleResetAssistantAvatar()}
                  className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-45 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Standard-Avatar wiederherstellen</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        )}
      </section>
      )}

      {/* Profilverwaltung, Admin-Rechte & Altersfreigabe */}
      {showProfilesSection && (
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <div
          className={`px-6 py-5 flex flex-wrap items-center justify-between gap-4 ${
            !collapsedSections.profiles ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <button
            type="button"
            aria-expanded={!collapsedSections.profiles}
            onClick={() => toggleSectionCollapse('profiles')}
            className="flex items-center gap-3.5 min-w-0 flex-1 text-left"
          >
            <span className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-semibold text-white truncate">
                Profilverwaltung, Admin-Rechte &amp; Altersfreigabe (FSK)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Lege neue Konten an, setze FSK-Grenzen (z. B. Kinderprofil bis FSK 12) oder übertrage
                Admin-Rechte.
              </p>
            </div>
          </button>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadProfiles()}
              disabled={loading}
              title="Profile neu laden"
              className="p-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => {
                setCollapsedSections((prev) => ({ ...prev, profiles: false }));
                setShowCreateProfile((prev) => !prev);
                setAdminError(null);
              }}
              className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              {showCreateProfile ? (
                <X className="w-3.5 h-3.5" />
              ) : (
                <UserPlus className="w-3.5 h-3.5" />
              )}
              <span>{showCreateProfile ? 'Formular schließen' : 'Neues Profil anlegen'}</span>
            </button>
            <button
              type="button"
              aria-expanded={!collapsedSections.profiles}
              aria-label={
                collapsedSections.profiles ? 'Profilverwaltung aufklappen' : 'Profilverwaltung zuklappen'
              }
              onClick={() => toggleSectionCollapse('profiles')}
              className="p-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors"
            >
              {collapsedSections.profiles ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {!collapsedSections.profiles && (
        <>

        <div className="p-6 space-y-4">
          {showCreateProfile && (
            <form
              onSubmit={(e) => void handleAdminCreateProfile(e)}
              className="p-4 rounded-xl bg-[#0B0E14] border border-amber-400/40 space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Benutzername</label>
                  <input
                    type="text"
                    required
                    value={createUsername}
                    onChange={(e) => setCreateUsername(e.target.value)}
                    placeholder="z. B. kinderzimmer"
                    className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Anzeigename</label>
                  <input
                    type="text"
                    value={createDisplayName}
                    onChange={(e) => setCreateDisplayName(e.target.value)}
                    placeholder="z. B. Kinderprofil"
                    className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Passwort (mind. 4 Zeichen)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={4}
                    value={createPassword}
                    onChange={(e) => setCreatePassword(e.target.value)}
                    placeholder="Passwort vergeben"
                    className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-slate-300 mb-1">
                    Altersfreigabe (FSK-Limit)
                  </label>
                  <select
                    value={createFskLimit}
                    onChange={(e) => setCreateFskLimit(Number(e.target.value) as FskLevel)}
                    className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    {FSK_LEVELS.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {FSK_DESCRIPTIONS[lvl]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Kontotyp / Rolle</label>
                  <select
                    value={createRole}
                    onChange={(e) => setCreateRole(e.target.value as 'family' | 'admin')}
                    className="w-full px-3 py-2 bg-[#121722] border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-amber-400"
                  >
                    <option value="family">Familien- / Kinderprofil</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateProfile(false)}
                  className="px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs text-slate-300 hover:text-white whitespace-nowrap"
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={creatingProfile || !createUsername.trim() || createPassword.length < 4}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold whitespace-nowrap"
                >
                  {creatingProfile ? 'Lege an...' : 'Profil auf NAS speichern'}
                </button>
              </div>
            </form>
          )}

          {adminError && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{adminError}</span>
            </div>
          )}

          {adminNotice && (
            <div
              role="status"
              className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{adminNotice}</span>
            </div>
          )}

          {loading && profiles.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
              <Users className="w-4 h-4 text-amber-400" />
              <span>Lade Profile vom NAS...</span>
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70 border border-slate-800/80 rounded-xl bg-[#0B0E14] px-4">
              {profiles.map((p) => {
                const isCurrent = p.username === user.username;
                const isBusy = adminBusyUser === p.username;
                const pFsk = p.fskLimit ?? 18;
                const showingTransfer = transferTarget === p.username;
                const showingDelete = deleteTarget === p.username;

                return (
                  <div key={p.id} className="py-4 space-y-3">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {p.avatarUrl ? (
                          <img
                            src={p.avatarUrl}
                            alt={p.displayName}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            className="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0"
                          />
                        ) : (
                          <span
                            className="w-9 h-9 rounded-full flex items-center justify-center text-slate-950 font-display text-xs font-bold shrink-0"
                            style={{ backgroundColor: p.avatarColor || '#F59E0B' }}
                          >
                            {(p.displayName || p.username).slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">
                            {p.displayName}
                            {isCurrent && (
                              <span className="ml-2 text-[11px] font-medium text-amber-400">
                                · Aktiv
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate tabular-nums">
                            <span className="font-mono">@{p.username}</span> ·{' '}
                            <span
                              className={
                                p.role === 'admin'
                                  ? 'text-amber-300 font-semibold'
                                  : 'text-slate-300'
                              }
                            >
                              {p.role === 'admin' ? 'Administrator' : 'Familien-Konto'}
                            </span>{' '}
                            ·{' '}
                            <span className={pFsk < 18 ? 'text-sky-300 font-medium' : ''}>
                              {pFsk >= 18
                                ? 'FSK 18 (Alle Inhalte)'
                                : `Kinder-/Jugendschutz: FSK 0 bis ${pFsk}`}
                            </span>
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <span className="whitespace-nowrap text-slate-400">Freigabe:</span>
                          <select
                            aria-label={`Altersfreigabe für ${p.displayName}`}
                            disabled={isBusy}
                            value={pFsk}
                            onChange={(e) => {
                              const nextFsk = Number(e.target.value) as FskLevel;
                              void handleAdminUpdateProfile(
                                p.username,
                                { fskLimit: nextFsk },
                                `Altersfreigabe für ${p.displayName} auf ${
                                  nextFsk >= 18
                                    ? 'FSK 18 (Unbeschränkt)'
                                    : `FSK ${nextFsk} (Inhalte von FSK 0 bis ${nextFsk})`
                                } gesetzt.`
                              );
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-white focus:outline-none focus:border-amber-400"
                          >
                            {FSK_LEVELS.map((lvl) => (
                              <option key={lvl} value={lvl}>
                                {lvl >= 18
                                  ? 'FSK 18 (Alle)'
                                  : lvl === 12
                                    ? 'Bis FSK 12 (Kinderprofil)'
                                    : `Bis FSK ${lvl} (0–${lvl})`}
                              </option>
                            ))}
                          </select>
                        </label>

                        {!isCurrent && p.role !== 'admin' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setTransferTarget((prev) =>
                                prev === p.username ? null : p.username
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-amber-400/50 text-xs font-medium text-amber-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Crown className="w-3.5 h-3.5" />
                            <span>Admin-Rechte übertragen</span>
                          </button>
                        )}

                        {!isCurrent && p.role === 'admin' && (
                          <button
                            type="button"
                            disabled={isBusy || adminCount <= 1}
                            onClick={() =>
                              void handleAdminUpdateProfile(
                                p.username,
                                { role: 'family' },
                                `Admin-Rechte für ${p.displayName} entzogen (Familien-Konto).`
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
                          >
                            Admin entziehen
                          </button>
                        )}

                        {!isCurrent && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setDeleteTarget((prev) =>
                                prev === p.username ? null : p.username
                              )
                            }
                            title="Profil entfernen"
                            aria-label={`${p.displayName} entfernen`}
                            className="p-2 rounded-lg bg-[#121722] border border-slate-800 text-slate-400 hover:text-rose-300 hover:border-rose-800/70 transition-colors shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {showingTransfer && !isCurrent && (
                      <div className="p-3 rounded-lg bg-[#121722] border border-amber-400/40 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-slate-200">
                          Wie sollen die Admin-Rechte an{' '}
                          <strong className="text-white">{p.displayName}</strong> übertragen werden?
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleAdminUpdateProfile(
                                p.username,
                                { role: 'admin' },
                                `${p.displayName} hat zusätzlich Administrator-Rechte erhalten.`
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold whitespace-nowrap"
                          >
                            Zusätzlich zum Admin machen
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleAdminUpdateProfile(
                                p.username,
                                { transferExclusive: true },
                                `Admin-Rolle vollständig an ${p.displayName} übertragen.`
                              )
                            }
                            className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-amber-400/60 text-amber-300 font-medium whitespace-nowrap"
                          >
                            Admin-Rolle komplett übergeben
                          </button>
                          <button
                            type="button"
                            onClick={() => setTransferTarget(null)}
                            className="px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-white whitespace-nowrap"
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    )}

                    {showingDelete && !isCurrent && (
                      <div className="p-3 rounded-lg bg-rose-950/35 border border-rose-500/45 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-rose-100">
                          Profil <strong>{p.displayName}</strong> (@{p.username}) wirklich löschen?
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(null)}
                            className="px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-slate-300 hover:text-white whitespace-nowrap"
                          >
                            Abbrechen
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleAdminDeleteProfile(p.username)}
                            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold whitespace-nowrap"
                          >
                            Ja, Profil löschen
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
      )}
      </section>
      )}

      {/* Dedizierte Netzwerk-Konfiguration: Wechsel & Speicherung zwischen Lokal (LAN) und Remote-NAS (WAN/VPN) */}
      {showNetworkSection && (
        <AdminNetworkConfigSection
          token={token}
          collapsed={collapsedSections.network}
          onToggleCollapse={() => toggleSectionCollapse('network')}
        />
      )}

      {/* NAS-Einstellungen: Pfad-Einstellungen (Speicherpfade & Zieldatei auf dem NAS) */}
      {showPathsSection && (
        <AdminNasPathSettings
          token={token}
          collapsed={collapsedSections.paths}
          onToggleCollapse={() => toggleSectionCollapse('paths')}
        />
      )}

      {/* Netzwerkeinstellungen & Unterstützte NAS-Anmeldewege für Anmeldung, Registrierung & Profil */}
      {showAuthSection && (
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          aria-expanded={!collapsedSections.auth}
          onClick={() => toggleSectionCollapse('auth')}
          className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
            !collapsedSections.auth ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold text-white">
                Netzwerkeinstellungen &amp; NAS-Anmeldewege
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Lege fest, welche Netzwerk- und Anmeldewege (inkl. FRITZ!Box UPnP/DLNA im Heimnetz)
                bei Anmeldung, Registrierung und unter Profil → NAS-Einstellungen freigegeben sind.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span className="text-xs font-medium text-amber-300 bg-amber-400/10 border border-amber-400/35 px-3 py-1 rounded-lg whitespace-nowrap tabular-nums">
              {draftAllowedProtocols.length} von {NAS_PROTOCOL_CATALOG.length} aktiv
            </span>
            <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
              {collapsedSections.auth ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </div>
        </button>

        {!collapsedSections.auth && (
        <div className="p-6 space-y-4">
          {loadingAuthMethods ? (
            <div className="py-6 text-center text-xs text-slate-400">
              Lade Netzwerkeinstellungen &amp; NAS-Anmeldewege...
            </div>
          ) : (
            <>
              {/* Hervorgehobene Heimnetz-Option: FRITZ!Box UPnP / DLNA */}
              <div
                className={`p-4 rounded-xl border transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                  draftAllowedProtocols.includes('fritz_upnp')
                    ? 'bg-emerald-500/10 border-emerald-500/40'
                    : 'bg-[#0B0E14] border-slate-800/80'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${
                      draftAllowedProtocols.includes('fritz_upnp')
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-[#121722] border-slate-800 text-slate-400'
                    }`}
                  >
                    <Wifi className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs sm:text-sm font-semibold text-white">
                        FRITZ!Box UPnP / DLNA (Heimnetz-Direktzugriff)
                      </p>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap ${
                          draftAllowedProtocols.includes('fritz_upnp')
                            ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                            : 'bg-slate-900 text-slate-400 border-slate-700'
                        }`}
                      >
                        {draftAllowedProtocols.includes('fritz_upnp')
                          ? 'Ohne extra Anmeldung aktiv'
                          : 'Deaktiviert'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-300 mt-1 leading-relaxed">
                      Wenn sich eine FRITZ!Box im Heimnetz befindet (<code className="font-mono text-amber-300">fritz.box:49000</code>), können Geräte bei Anmeldung und Registrierung direkt ohne extra Benutzername/Passwort auf den NVS zugreifen.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={savingAuthMethods}
                  onClick={() => handleToggleAllowedProtocol('fritz_upnp')}
                  aria-pressed={draftAllowedProtocols.includes('fritz_upnp')}
                  className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                    draftAllowedProtocols.includes('fritz_upnp')
                      ? 'bg-emerald-400 hover:bg-emerald-300 text-slate-950 border-emerald-400'
                      : 'bg-[#121722] hover:bg-slate-800 text-slate-200 border-slate-700'
                  }`}
                >
                  {draftAllowedProtocols.includes('fritz_upnp')
                    ? 'FRITZ!Box UPnP aktiviert'
                    : 'FRITZ!Box UPnP aktivieren'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {NAS_PROTOCOL_CATALOG.map((proto) => {
                  const enabled = draftAllowedProtocols.includes(proto.id);
                  return (
                    <button
                      key={proto.id}
                      type="button"
                      disabled={savingAuthMethods}
                      onClick={() => handleToggleAllowedProtocol(proto.id)}
                      aria-pressed={enabled}
                      className={`p-3.5 rounded-xl border text-left transition-colors flex flex-col justify-between gap-2 ${
                        enabled
                          ? 'bg-amber-400/10 border-amber-400/70 text-white'
                          : 'bg-[#0B0E14] border-slate-800/80 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs sm:text-sm font-semibold text-white truncate">
                            {proto.label}
                          </p>
                          <p className="text-[11px] font-mono text-slate-400 tabular-nums mt-0.5">
                            Standard-Port :{proto.defaultPort}
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                            enabled
                              ? 'bg-amber-400 text-slate-950 border-amber-400'
                              : 'bg-slate-900 text-slate-400 border-slate-700'
                          }`}
                        >
                          {enabled ? 'Unterstützt' : 'Ausgeblendet'}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-snug">{proto.description}</p>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {authMethodsError && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{authMethodsError}</span>
            </div>
          )}

          {authMethodsNotice && (
            <div
              role="status"
              className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{authMethodsNotice}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="text-[11px] text-slate-400">
              {authMethodsDirty
                ? 'Ungespeicherte Änderungen an den unterstützten Anmeldewegen.'
                : 'Aktuelle Freigaben sind auf dem NAS aktiv.'}
            </div>

            <div className="flex flex-wrap items-center gap-2.5 ml-auto">
              <button
                type="button"
                disabled={
                  savingAuthMethods ||
                  draftAllowedProtocols.length === NAS_PROTOCOL_CATALOG.length
                }
                onClick={() => {
                  const all = [...ALL_NAS_PROTOCOLS];
                  setDraftAllowedProtocols(all);
                  void handleSaveAllowedAuthMethods(all);
                }}
                className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
              >
                Alle aktivieren
              </button>
              <button
                type="button"
                disabled={savingAuthMethods || !authMethodsDirty}
                onClick={() => void handleSaveAllowedAuthMethods()}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingAuthMethods ? 'Speichere...' : 'Anmeldewege speichern'}</span>
              </button>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800/80">
            <FritzDiscoverySettings token={token} />
          </div>
        </div>
        )}
      </section>
      )}

      {/* Nutzerdatenspeicherung: NAS vs. automatisch verschlüsselte Cloud + integrierte Cloud-Anmeldung */}
      {showStorageSection && (
      <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
        <button
          type="button"
          aria-expanded={!collapsedSections.storage}
          onClick={() => toggleSectionCollapse('storage')}
          className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
            !collapsedSections.storage ? 'border-b border-slate-800/80' : ''
          }`}
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
              <Database className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold text-white">
                Nutzerdatenspeicherung
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Lege fest, ob die Nutzerdaten aller Benutzer (Profile, Einstellungen, Merklisten,
                Verlauf &amp; Favoriten) lokal auf dem NAS oder automatisch AES-256-GCM-verschlüsselt
                in einer Cloud gespeichert werden.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <span
              className={`text-xs font-semibold px-3 py-1 rounded-lg border whitespace-nowrap flex items-center gap-1.5 ${
                (userStorageConfig?.mode ?? storageModeDraft) === 'cloud'
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-amber-400/10 border-amber-400/35 text-amber-300'
              }`}
            >
              {(userStorageConfig?.mode ?? storageModeDraft) === 'cloud' ? (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  <span>Cloud · Automatisch verschlüsselt</span>
                </>
              ) : (
                <>
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>NAS (Standard · Lokal)</span>
                </>
              )}
            </span>
            <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
              {collapsedSections.storage ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </div>
        </button>

        {!collapsedSections.storage && (
        <div className="p-6 space-y-5">
          {loadingUserStorage && !userStorageConfig ? (
            <div className="py-6 text-center text-xs text-slate-400">
              Lade Einstellungen zur Nutzerdatenspeicherung...
            </div>
          ) : (
            <>
              {/* Speicherziel-Auswahl: NAS vs Cloud */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <button
                  type="button"
                  onClick={() => {
                    setStorageModeDraft('nas');
                    setUserStorageError(null);
                    setUserStorageNotice(null);
                  }}
                  aria-pressed={storageModeDraft === 'nas'}
                  className={`p-4 rounded-xl border text-left transition-colors space-y-2 ${
                    storageModeDraft === 'nas'
                      ? 'bg-amber-400/10 border-amber-400 text-white'
                      : 'bg-[#0B0E14] border-slate-800/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
                      <span className="text-sm font-semibold text-white">
                        Auf dem NAS speichern (Standard)
                      </span>
                    </div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${
                        storageModeDraft === 'nas'
                          ? 'bg-amber-400 text-slate-950 border-amber-400'
                          : 'bg-slate-900 text-slate-400 border-slate-700'
                      }`}
                    >
                      {storageModeDraft === 'nas' ? 'Standard · Aktiv' : 'Standard'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Alle Benutzerkonten, Design-Einstellungen, Merklisten, Favoriten und
                    Wiedergabeverläufe bleiben ausschließlich im zentralen NAS-Verzeichnis.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStorageModeDraft('cloud');
                    setUserStorageError(null);
                    setUserStorageNotice(null);
                  }}
                  aria-pressed={storageModeDraft === 'cloud'}
                  className={`p-4 rounded-xl border text-left transition-colors space-y-2 ${
                    storageModeDraft === 'cloud'
                      ? 'bg-emerald-500/10 border-emerald-400 text-white'
                      : 'bg-[#0B0E14] border-slate-800/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <Cloud className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-sm font-semibold text-white">
                        In einer Cloud speichern
                      </span>
                    </div>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded border flex items-center gap-1 ${
                        storageModeDraft === 'cloud'
                          ? 'bg-emerald-400 text-slate-950 border-emerald-400'
                          : 'bg-slate-900 text-slate-400 border-slate-700'
                      }`}
                    >
                      <Lock className="w-3 h-3" />
                      <span>AES-256-GCM</span>
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Nutzerdaten werden automatisch serverseitig mit AES-256-GCM verschlüsselt,
                    bevor sie in der verbundenen Cloud gespeichert werden. Keine Klartextdaten in der
                    Cloud.
                  </p>
                </button>
              </div>

              {/* Automatische Verschlüsselung & Integrierte Cloud-Anmeldung */}
              {storageModeDraft === 'cloud' && (
                <div className="p-4 sm:p-5 rounded-xl bg-[#0B0E14] border border-emerald-500/35 space-y-4">
                  {/* Automatischer Verschlüsselungs-Status */}
                  <div className="p-3.5 rounded-lg bg-emerald-950/30 border border-emerald-800/50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Lock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-emerald-200">
                          Automatische Cloud-Verschlüsselung aktiv (AES-256-GCM + scrypt)
                        </p>
                        <p className="text-[11px] text-emerald-300/80 mt-0.5">
                          Jede Änderung an Nutzerdaten wird automatisch mit Authentifizierungstag
                          und SHA-256-Prüfsumme verschlüsselt. Ein manuelles Passwort für die
                          Verschlüsselung ist nicht nötig.
                        </p>
                      </div>
                    </div>
                    {userStorageConfig?.keyFingerprint && (
                      <span className="text-[11px] font-mono text-emerald-200 bg-[#0B0E14] border border-emerald-700/60 px-2.5 py-1 rounded-md whitespace-nowrap">
                        Key-ID: {userStorageConfig.keyFingerprint}
                      </span>
                    )}
                  </div>

                  {/* Cloud-Anbieter & Integrierte Anmeldung */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-white">
                        Anmeldung für die Cloud
                      </p>
                      <div className="inline-flex rounded-lg bg-[#121722] border border-slate-800 p-1">
                        <button
                          type="button"
                          onClick={() => setCloudProviderDraft('google_drive')}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            cloudProviderDraft === 'google_drive'
                              ? 'bg-amber-400 text-slate-950 font-semibold'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Google Drive (Cloud)
                        </button>
                        <button
                          type="button"
                          onClick={() => setCloudProviderDraft('webdav')}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            cloudProviderDraft === 'webdav'
                              ? 'bg-amber-400 text-slate-950 font-semibold'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          Nextcloud / WebDAV-Cloud
                        </button>
                      </div>
                    </div>

                    {cloudProviderDraft === 'google_drive' ? (
                      <div className="space-y-3">
                        {!googleAccessToken ? (
                          <div className="p-4 rounded-xl bg-[#121722] border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div className="space-y-1 min-w-0">
                              <p className="text-xs font-semibold text-white">
                                {userStorageConfig?.cloudAccountEmail
                                  ? `Google-Konto hinterlegt (${userStorageConfig.cloudAccountEmail}) — Anmeldung für aktuellen Upload bestätigen`
                                  : 'Mit Google-Konto für verschlüsselte Cloud-Speicherung anmelden'}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                Nach der Anmeldung werden alle Nutzerdaten automatisch als
                                verschlüsselte Datei ({CLOUD_VAULT_FILE_NAME}) auf Google Drive
                                gespeichert.
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => void handleAdminCloudGoogleSignIn()}
                              disabled={cloudAuthBusy}
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
                                {cloudAuthBusy ? 'Verbinde Cloud...' : 'Sign in with Google'}
                              </span>
                            </button>
                          </div>
                        ) : (
                          <div className="p-4 rounded-xl bg-[#121722] border border-emerald-500/40 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                {googleUser?.photoURL ? (
                                  <img
                                    src={googleUser.photoURL}
                                    alt={googleUser.displayName || 'Google Cloud'}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    decoding="async"
                                    className="w-9 h-9 rounded-full object-cover border border-slate-700 shrink-0"
                                  />
                                ) : (
                                  <span className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 flex items-center justify-center shrink-0">
                                    <Cloud className="w-4 h-4" />
                                  </span>
                                )}
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-white truncate">
                                    {googleUser?.displayName || 'Google Drive Cloud verbunden'}
                                  </p>
                                  <p className="text-[11px] text-emerald-300 truncate">
                                    {googleUser?.email || userStorageConfig?.cloudAccountEmail} ·
                                    Cloud-Anmeldung aktiv
                                  </p>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                {cloudDriveFile?.webViewLink && (
                                  <a
                                    href={cloudDriveFile.webViewLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                                  >
                                    <span>In Drive öffnen</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void handleAdminCloudGoogleDisconnect()}
                                  disabled={cloudAuthBusy || cloudSyncBusy}
                                  className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
                                >
                                  <LogOut className="w-3.5 h-3.5" />
                                  <span>Abmelden</span>
                                </button>
                              </div>
                            </div>

                            <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2.5">
                              <div className="text-[11px] text-slate-400">
                                {cloudDriveFile ? (
                                  <span>
                                    Verschlüsselte Datei auf Drive:{' '}
                                    <strong className="text-slate-200">{cloudDriveFile.name}</strong>
                                    {cloudDriveFile.modifiedTime
                                      ? ` · Stand ${new Date(
                                          cloudDriveFile.modifiedTime
                                        ).toLocaleString('de-DE')}`
                                      : ''}
                                  </span>
                                ) : (
                                  <span>
                                    Zieldatei auf Google Drive:{' '}
                                    <span className="font-mono text-slate-300">
                                      {CLOUD_VAULT_FILE_NAME}
                                    </span>
                                  </span>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                {(cloudDriveFile?.id || userStorageConfig?.cloudRemoteFileId) && (
                                  <button
                                    type="button"
                                    disabled={cloudVerifyBusy || cloudSyncBusy}
                                    onClick={() => void handleVerifyGoogleDriveEncryption()}
                                    className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-emerald-300 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                                  >
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                    <span>
                                      {cloudVerifyBusy
                                        ? 'Prüfe Verschlüsselung...'
                                        : 'Verschlüsselung prüfen'}
                                    </span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={cloudSyncBusy || cloudVerifyBusy}
                                  onClick={() => void handleGoogleDriveEncryptedSync()}
                                  className="px-3.5 py-1.5 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                                >
                                  <CloudUpload className="w-3.5 h-3.5" />
                                  <span>
                                    {cloudSyncBusy
                                      ? 'Verschlüssele & lade hoch...'
                                      : 'Jetzt verschlüsselt in Cloud speichern'}
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-[#121722] border border-slate-800/80 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">
                              Cloud-Server-URL (Nextcloud / WebDAV)
                            </label>
                            <input
                              type="url"
                              value={webdavUrlDraft}
                              onChange={(e) => setWebdavUrlDraft(e.target.value)}
                              placeholder="https://cloud.beispiel.de/remote.php/dav/files/admin"
                              className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">
                              Cloud-Zieldateipfad (verschlüsselt)
                            </label>
                            <input
                              type="text"
                              value={webdavRemotePathDraft}
                              onChange={(e) => setWebdavRemotePathDraft(e.target.value)}
                              placeholder="/entencenter-userdata-vault.enc.json"
                              className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">
                              Cloud-Benutzername
                            </label>
                            <input
                              type="text"
                              value={webdavUsernameDraft}
                              onChange={(e) => setWebdavUsernameDraft(e.target.value)}
                              placeholder="Cloud-Benutzername"
                              className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">
                              Cloud-Passwort / App-Token
                              {userStorageConfig?.hasWebdavSecret && !webdavSecretDraft && (
                                <span className="ml-1.5 text-emerald-400">(gespeichert)</span>
                              )}
                            </label>
                            <div className="relative">
                              <input
                                type={showWebdavSecret ? 'text' : 'password'}
                                value={webdavSecretDraft}
                                onChange={(e) => setWebdavSecretDraft(e.target.value)}
                                placeholder={
                                  userStorageConfig?.hasWebdavSecret
                                    ? 'Gespeichert · zum Ändern neu eingeben'
                                    : 'Passwort oder App-Passwort eingeben'
                                }
                                className="w-full pl-3 pr-9 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                              />
                              <button
                                type="button"
                                onClick={() => setShowWebdavSecret((prev) => !prev)}
                                aria-label={
                                  showWebdavSecret ? 'Passwort verbergen' : 'Passwort anzeigen'
                                }
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                              >
                                {showWebdavSecret ? (
                                  <EyeOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          Die Cloud-Zugangsdaten werden selbst mit AES-256-GCM geschützt hinterlegt.
                          Bei jeder Nutzerdaten-Änderung lädt der Server automatisch den neu
                          verschlüsselten Tresor auf diesen WebDAV-Endpunkt hoch.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Kompakte Übersicht des automatischen AES-256-GCM-Tresors */}
              {vaultPreview && (
                <div className="p-3.5 rounded-xl bg-[#0B0E14] border border-slate-800/80 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-[11px] text-slate-400">Erfasste Nutzerkonten</p>
                    <p className="font-mono font-semibold text-white tabular-nums mt-0.5">
                      {vaultPreview.summary.usersCount} Profile · {vaultPreview.summary.historyEntriesCount}{' '}
                      Verläufe
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Verschlüsselter Tresor</p>
                    <p className="font-mono font-semibold text-emerald-300 tabular-nums mt-0.5">
                      {formatVaultBytes(vaultPreview.ciphertextBytes)} (AES-256-GCM)
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Prüfsumme (SHA-256)</p>
                    <p className="font-mono text-slate-300 truncate mt-0.5">
                      {vaultPreview.payloadSha256.slice(0, 16)}…
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Letzter Cloud-Sync</p>
                    <p className="font-mono text-slate-300 truncate mt-0.5">
                      {userStorageConfig?.lastEncryptedSyncAt
                        ? new Date(userStorageConfig.lastEncryptedSyncAt).toLocaleString('de-DE')
                        : 'Noch nicht synchronisiert'}
                    </p>
                  </div>
                </div>
              )}

              {userStorageError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{userStorageError}</span>
                </div>
              )}

              {userStorageNotice && (
                <div
                  role="status"
                  className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{userStorageNotice}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="text-[11px] text-slate-400">
                  {storageModeDraft === 'cloud'
                    ? 'Im Cloud-Modus erfolgt die AES-256-GCM-Verschlüsselung vollautomatisch.'
                    : 'Aktueller Speicherort: Lokaler NAS-Tresor.'}
                </span>

                <button
                  type="button"
                  disabled={savingUserStorage || cloudAuthBusy || cloudSyncBusy}
                  onClick={() => void handleSaveUserStorage()}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap ml-auto"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>
                    {savingUserStorage
                      ? 'Speichere...'
                      : storageModeDraft === 'cloud'
                        ? 'Cloud-Speicherung (verschlüsselt) speichern'
                        : 'NAS-Speicherung speichern'}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
        )}
      </section>
      )}

      {/* Ordner für manuellen NAS-Scan + Dateien aufs NAS laden + Neue Inhalte hinzufügen + Bestand verwalten */}
      {showContentSection && (
      <div className="space-y-6">
        {/* 0. Ordner für manuellen NAS-Scan konfigurieren (mit klickbarem NAS-Explorer) */}
        <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
          <button
            type="button"
            aria-expanded={!collapsedSections.contentScanFolders}
            onClick={() => toggleSectionCollapse('contentScanFolders')}
            className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
              !collapsedSections.contentScanFolders ? 'border-b border-slate-800/80' : ''
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
                <FolderOpen className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-white">
                  Ordner für manuellen NAS-Scan
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Standardmäßig werden bei „Manueller Scan“ alle NAS-Ordner durchsucht. Hier
                  kannst du gezielt einzelne NAS-Ordner per Klick auswählen.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <span
                className={`text-[11px] font-medium px-3 py-1 rounded-lg border whitespace-nowrap ${
                  scanFolderSettings.scanMode === 'selected'
                    ? 'bg-amber-400/15 border-amber-400/40 text-amber-300'
                    : 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300'
                }`}
              >
                {scanFolderSettings.scanMode === 'selected'
                  ? `${scanFolderSettings.selectedFolders.length} Ordner ausgewählt`
                  : 'Alle NAS-Ordner (Standard)'}
              </span>
              <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
                {collapsedSections.contentScanFolders ? (
                  <ChevronRight className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </span>
            </div>
          </button>

          {!collapsedSections.contentScanFolders && (
            <div className="p-6 space-y-5">
              {loadingScanFolders ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                  <span>Lade Scan-Ordner-Einstellungen...</span>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setScanFolderError(null);
                        setScanFolderNotice(null);
                        setScanFolderSettings((prev) => ({ ...prev, scanMode: 'all' }));
                      }}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        scanFolderSettings.scanMode === 'all'
                          ? 'bg-amber-400/10 border-amber-400/70'
                          : 'bg-[#0B0E14] border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">
                          Alle Ordner auf dem NAS scannen (Standard)
                        </span>
                        <span
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            scanFolderSettings.scanMode === 'all'
                              ? 'border-amber-400 bg-amber-400 text-slate-950'
                              : 'border-slate-600'
                          }`}
                        >
                          {scanFolderSettings.scanMode === 'all' && <Check className="w-3 h-3" />}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Alle freigegebenen Medienordner auf dem NAS werden beim manuellen Scan der
                        Benutzer automatisch berücksichtigt.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setScanFolderError(null);
                        setScanFolderNotice(null);
                        setScanFolderSettings((prev) => ({ ...prev, scanMode: 'selected' }));
                      }}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        scanFolderSettings.scanMode === 'selected'
                          ? 'bg-amber-400/10 border-amber-400/70'
                          : 'bg-[#0B0E14] border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">
                          Nur ausgewählte NAS-Ordner scannen
                        </span>
                        <span
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            scanFolderSettings.scanMode === 'selected'
                              ? 'border-amber-400 bg-amber-400 text-slate-950'
                              : 'border-slate-600'
                          }`}
                        >
                          {scanFolderSettings.scanMode === 'selected' && (
                            <Check className="w-3 h-3" />
                          )}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Durchsuche live die Ordnerstruktur auf dem NAS und klicke exakt die
                        Ordner an, die gescannt werden sollen.
                      </p>
                    </button>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-white">
                          Ausgewählte Ordner für „Manueller Scan“ ({scanFolderSettings.selectedFolders.length})
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Öffne den NAS-Ordner-Explorer, navigiere durch FRITZ!NAS / SMB2 / WebDAV
                          und markiere gewünschte Ordner per Klick.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={openScanBrowserModal}
                        className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        <span>NAS-Ordner auswählen (Explorer)</span>
                      </button>
                    </div>

                    {scanFolderSettings.selectedFolders.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {scanFolderSettings.selectedFolders.map((folderPath) => (
                          <div
                            key={folderPath}
                            className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-amber-400/40 text-xs font-mono text-amber-200 flex items-center gap-2"
                          >
                            <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span>{folderPath}</span>
                            <button
                              type="button"
                              onClick={() => toggleSelectedScanFolder(folderPath)}
                              aria-label={`${folderPath} entfernen`}
                              className="text-slate-400 hover:text-rose-300 transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">
                        Noch keine spezifischen Ordner gewählt — solange „Alle Ordner“ aktiv ist,
                        werden beim manuellen Scan alle NAS-Ordner erfasst.
                      </p>
                    )}
                  </div>

                  {scanFolderError && (
                    <div
                      role="alert"
                      className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
                    >
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{scanFolderError}</span>
                    </div>
                  )}

                  {scanFolderNotice && (
                    <div
                      role="status"
                      className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{scanFolderNotice}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[11px] text-slate-500">
                      {scanFolderSettings.updatedAt
                        ? `Zuletzt gespeichert: ${new Date(scanFolderSettings.updatedAt).toLocaleString('de-DE')}`
                        : 'Noch nicht angepasst (Standard aktiv)'}
                    </span>
                    <button
                      type="button"
                      disabled={savingScanFolders}
                      onClick={() => void handleSaveScanFolderSettings()}
                      className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{savingScanFolders ? 'Speichere...' : 'Scan-Ordner speichern'}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* 1. Drag-and-Drop Datei-Upload aufs NAS */}
        <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
          <button
            type="button"
            aria-expanded={!collapsedSections.contentUpload}
            onClick={() => toggleSectionCollapse('contentUpload')}
            className={`w-full px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
              !collapsedSections.contentUpload ? 'border-b border-slate-800/80' : ''
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
                <Upload className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-white">
                  Dateien direkt aufs NAS laden
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Ziehe Filme, Serien, Musik, Bilder oder Dokumente in die Upload-Zone — Übertragung
                  mit Fortschrittsanzeige über <span className="font-mono text-slate-300">/api/nas/upload</span>.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <span className="text-[11px] font-mono text-slate-300 bg-[#0B0E14] border border-slate-800 px-3 py-1 rounded-lg whitespace-nowrap">
                Max. 500 MB / Datei
              </span>
              <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300">
                {collapsedSections.contentUpload ? (
                  <ChevronRight className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </span>
            </div>
          </button>

          {!collapsedSections.contentUpload && (
          <div className="p-6 space-y-5">
            {/* Standard-Vorgaben für neue Uploads */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Standard-Zielordner auf dem NAS (optional)
                </label>
                <input
                  type="text"
                  value={defaultUploadFolder}
                  onChange={(e) => setDefaultUploadFolder(e.target.value)}
                  placeholder="Automatisch nach Kategorie (z. B. /mnt/nas/Filme)"
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Standard-FSK für neue Dateien
                </label>
                <select
                  value={defaultUploadFsk}
                  onChange={(e) => setDefaultUploadFsk(Number(e.target.value) as FskLevel)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  {FSK_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {FSK_DESCRIPTIONS[lvl]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={notifyAfterUpload}
                    onChange={(e) => setNotifyAfterUpload(e.target.checked)}
                    className="accent-amber-400 rounded w-4 h-4"
                  />
                  <span>Alle Benutzer per Enten-Assistent benachrichtigen</span>
                </label>
              </div>
            </div>

            {/* Drag-and-Drop-Zone */}
            <div
              role="region"
              aria-label="Drag-and-Drop-Upload-Zone für NAS-Dateien"
              onDragEnter={handleZoneDragEnter}
              onDragOver={handleZoneDragOver}
              onDragLeave={handleZoneDragLeave}
              onDrop={handleZoneDrop}
              className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
                isDragActive
                  ? 'border-amber-400 bg-amber-400/10 shadow-[0_0_0_1px_rgba(251,191,36,0.3)]'
                  : 'border-slate-700/90 bg-[#0B0E14] hover:border-amber-400/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    enqueueFilesForNasUpload(e.target.files);
                    e.target.value = '';
                  }
                }}
                className="sr-only"
                aria-label="Dateien für NAS-Upload auswählen"
              />

              <div className="max-w-md mx-auto space-y-3">
                <div
                  className={`w-12 h-12 rounded-2xl mx-auto flex items-center justify-center border transition-colors ${
                    isDragActive
                      ? 'bg-amber-400 text-slate-950 border-amber-300'
                      : 'bg-[#121722] text-amber-400 border-slate-800'
                  }`}
                >
                  <FileUp className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <p className="font-display text-sm sm:text-base font-semibold text-white">
                    {isDragActive
                      ? 'Dateien jetzt hier loslassen zum Übertragen'
                      : 'Dateien hierher ziehen & ablegen'}
                  </p>
                  <p className="text-xs text-slate-400">
                    Unterstützt Videos (MP4, MKV, WebM, MOV), Musik (MP3, FLAC, WAV), Bilder (JPG,
                    PNG, WebP) sowie PDFs &amp; Archive.
                  </p>
                </div>
                <div className="pt-1 flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    disabled={uploadingFiles}
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Dateien vom Gerät auswählen</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Gesamt-Fortschrittsanzeige während des Uploads */}
            {(uploadingFiles || (uploadQueue.length > 0 && loadedQueueBytes > 0)) && (
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-amber-400/35 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-white flex items-center gap-2">
                    {uploadingFiles ? (
                      <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    )}
                    <span>
                      {uploadingFiles
                        ? 'Übertrage Dateien auf das NAS (/api/nas/upload)...'
                        : 'Upload-Durchlauf abgeschlossen'}
                    </span>
                  </span>
                  <span className="font-mono text-amber-300 tabular-nums font-semibold">
                    {overallUploadPercent}% · {formatFileSizeCompact(loadedQueueBytes)} /{' '}
                    {formatFileSizeCompact(totalQueueBytes)}
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full transition-all duration-150 ${
                      uploadingFiles ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${overallUploadPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Warteschlange der ausgewählten Dateien */}
            {uploadQueue.length > 0 && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-white tabular-nums">
                    Ausgewählte Dateien für das NAS ({uploadQueue.length})
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {!uploadingFiles && (
                      <button
                        type="button"
                        onClick={() => setUploadQueue([])}
                        className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-white transition-colors"
                      >
                        Liste leeren
                      </button>
                    )}
                    {uploadingFiles ? (
                      <button
                        type="button"
                        onClick={handleAbortActiveUpload}
                        className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Aktiven Upload abbrechen</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={pendingUploadCount === 0}
                        onClick={() => void handleStartNasUpload()}
                        className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {pendingUploadCount > 0
                            ? `${pendingUploadCount} Datei(en) jetzt aufs NAS hochladen`
                            : 'Alle Dateien übertragen'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {uploadQueue.map((entry) => {
                    const isLocked = entry.status === 'uploading' || entry.status === 'done';
                    return (
                      <div
                        key={entry.localId}
                        className={`p-4 rounded-xl border space-y-3 ${
                          entry.status === 'done'
                            ? 'bg-emerald-950/20 border-emerald-700/50'
                            : entry.status === 'error'
                              ? 'bg-rose-950/25 border-rose-700/60'
                              : entry.status === 'uploading'
                                ? 'bg-[#0B0E14] border-amber-400/60'
                                : 'bg-[#0B0E14] border-slate-800'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="w-8 h-8 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                              {entry.kind === 'movie' ? (
                                <Film className="w-4 h-4" />
                              ) : entry.kind === 'series' ? (
                                <Tv className="w-4 h-4" />
                              ) : entry.kind === 'image' ? (
                                <ImageIcon className="w-4 h-4" />
                              ) : entry.kind === 'music' ? (
                                <Music className="w-4 h-4" />
                              ) : entry.kind === 'video' ? (
                                <Video className="w-4 h-4" />
                              ) : (
                                <FileText className="w-4 h-4" />
                              )}
                            </span>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-white truncate">
                                {entry.file.name}
                              </p>
                              <p className="text-[11px] font-mono text-slate-400 tabular-nums">
                                {formatFileSizeCompact(entry.file.size)} ·{' '}
                                {entry.file.type || 'Unbekannter Typ'}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border tabular-nums ${
                                entry.status === 'done'
                                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                  : entry.status === 'uploading'
                                    ? 'bg-amber-400/15 border-amber-400/50 text-amber-300'
                                    : entry.status === 'error'
                                      ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                                      : 'bg-slate-900 border-slate-700 text-slate-300'
                              }`}
                            >
                              {entry.status === 'done'
                                ? '100% · Auf NAS'
                                : entry.status === 'uploading'
                                  ? `Lädt hoch (${entry.progress}%)`
                                  : entry.status === 'error'
                                    ? 'Fehler'
                                    : 'Bereit'}
                            </span>
                            {entry.status !== 'uploading' && (
                              <button
                                type="button"
                                onClick={() =>
                                  setUploadQueue((prev) =>
                                    prev.filter((q) => q.localId !== entry.localId)
                                  )
                                }
                                aria-label={`${entry.file.name} aus Upload-Liste entfernen`}
                                className="p-1.5 rounded-lg bg-[#121722] border border-slate-800 text-slate-400 hover:text-rose-300 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Einzeldatei-Fortschrittsbalken */}
                        {(entry.status === 'uploading' || entry.status === 'done') && (
                          <div className="space-y-1">
                            <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden">
                              <div
                                className={`h-full transition-all duration-150 ${
                                  entry.status === 'done' ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                                style={{ width: `${entry.progress}%` }}
                              />
                            </div>
                            <p className="text-[11px] font-mono text-slate-400 tabular-nums">
                              {formatFileSizeCompact(entry.loadedBytes)} /{' '}
                              {formatFileSizeCompact(entry.file.size)} ({entry.progress}%)
                            </p>
                          </div>
                        )}

                        {entry.errorMessage && (
                          <p className="text-xs text-rose-300 flex items-center gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>{entry.errorMessage}</span>
                          </p>
                        )}

                        {/* Editierbare Metadaten vor dem Upload */}
                        {!isLocked && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1">
                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">Titel</label>
                              <input
                                type="text"
                                value={entry.title}
                                onChange={(e) =>
                                  setUploadQueue((prev) =>
                                    prev.map((q) =>
                                      q.localId === entry.localId
                                        ? { ...q, title: e.target.value }
                                        : q
                                    )
                                  )
                                }
                                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                              />
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Kategorie
                              </label>
                              <select
                                value={entry.kind}
                                onChange={(e) => {
                                  const nextKind = e.target.value as MediaKind;
                                  setUploadQueue((prev) =>
                                    prev.map((q) =>
                                      q.localId === entry.localId
                                        ? {
                                            ...q,
                                            kind: nextKind,
                                            genre: MEDIA_KIND_LABELS[nextKind],
                                            nasFolder:
                                              defaultUploadFolder.trim() ||
                                              DEFAULT_NAS_FOLDER_BY_KIND[nextKind],
                                          }
                                        : q
                                    )
                                  );
                                }}
                                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                              >
                                <option value="movie">Filme</option>
                                <option value="series">Serien</option>
                                <option value="image">Bilder</option>
                                <option value="music">Musik</option>
                                <option value="video">Video</option>
                                <option value="other">Sonstiges</option>
                              </select>
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Genre / Thema
                              </label>
                              <input
                                type="text"
                                value={entry.genre}
                                onChange={(e) =>
                                  setUploadQueue((prev) =>
                                    prev.map((q) =>
                                      q.localId === entry.localId
                                        ? { ...q, genre: e.target.value }
                                        : q
                                    )
                                  )
                                }
                                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                              />
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                FSK-Freigabe
                              </label>
                              <select
                                value={entry.fsk}
                                onChange={(e) =>
                                  setUploadQueue((prev) =>
                                    prev.map((q) =>
                                      q.localId === entry.localId
                                        ? { ...q, fsk: Number(e.target.value) as FskLevel }
                                        : q
                                    )
                                  )
                                }
                                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                              >
                                {FSK_LEVELS.map((lvl) => (
                                  <option key={lvl} value={lvl}>
                                    FSK {lvl}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="sm:col-span-2">
                              <label className="block text-[10px] text-slate-400 mb-1">
                                NAS-Zielordner
                              </label>
                              <input
                                type="text"
                                value={entry.nasFolder}
                                onChange={(e) =>
                                  setUploadQueue((prev) =>
                                    prev.map((q) =>
                                      q.localId === entry.localId
                                        ? { ...q, nasFolder: e.target.value }
                                        : q
                                    )
                                  )
                                }
                                className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white focus:outline-none focus:border-amber-400"
                              />
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Jahr / Laufzeit (Min.)
                              </label>
                              <div className="grid grid-cols-2 gap-1.5">
                                <input
                                  type="number"
                                  min={1950}
                                  max={2035}
                                  value={entry.year}
                                  onChange={(e) =>
                                    setUploadQueue((prev) =>
                                      prev.map((q) =>
                                        q.localId === entry.localId
                                          ? { ...q, year: Number(e.target.value) || 2026 }
                                          : q
                                      )
                                    )
                                  }
                                  className="w-full px-2 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white tabular-nums focus:outline-none focus:border-amber-400"
                                />
                                <input
                                  type="number"
                                  min={1}
                                  max={999}
                                  value={entry.durationMinutes}
                                  onChange={(e) =>
                                    setUploadQueue((prev) =>
                                      prev.map((q) =>
                                        q.localId === entry.localId
                                          ? {
                                              ...q,
                                              durationMinutes: Math.max(1, Number(e.target.value) || 1),
                                            }
                                          : q
                                      )
                                    )
                                  }
                                  className="w-full px-2 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white tabular-nums focus:outline-none focus:border-amber-400"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1">
                                Eigenes Cover (optional)
                              </label>
                              <label className="w-full px-2.5 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 flex items-center justify-between gap-2 cursor-pointer truncate">
                                <span className="truncate">
                                  {entry.coverFile ? entry.coverFile.name : 'Cover wählen…'}
                                </span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  className="sr-only"
                                  onChange={(e) => {
                                    const imgFile = e.target.files?.[0] ?? null;
                                    setUploadQueue((prev) =>
                                      prev.map((q) =>
                                        q.localId === entry.localId
                                          ? { ...q, coverFile: imgFile }
                                          : q
                                      )
                                    );
                                  }}
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {uploadError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            )}

            {uploadNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{uploadNotice}</span>
              </div>
            )}
          </div>
          )}
        </section>

        {/* 2. Manuelle Inhalte zum NAS-Katalog hinzufügen */}
        <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
          <button
            type="button"
            aria-expanded={!collapsedSections.contentManual}
            onClick={() => toggleSectionCollapse('contentManual')}
            className={`w-full px-6 py-5 flex items-center justify-between gap-4 text-left hover:bg-slate-800/30 transition-colors ${
              !collapsedSections.contentManual ? 'border-b border-slate-800/80' : ''
            }`}
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                <HardDrive className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-white">
                  Manuell neue Inhalte zum NAS-Katalog hinzufügen
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Registriere bereits auf dem NAS liegende Filme, Serien, Bilder, Musik oder Dokumente
                  — der Enten-Assistent benachrichtigt automatisch alle Benutzer nach Kategorien.
                </p>
              </div>
            </div>

            <span className="p-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-slate-300 shrink-0">
              {collapsedSections.contentManual ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </button>

          {!collapsedSections.contentManual && (
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="sm:col-span-2 lg:col-span-1">
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Titel / Dateiname
                </label>
                <input
                  type="text"
                  value={nasItemTitle}
                  onChange={(e) => setNasItemTitle(e.target.value)}
                  placeholder="z.B. Polarlichter 2026"
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Kategorie
                </label>
                <select
                  value={nasItemKind}
                  onChange={(e) => setNasItemKind(e.target.value as MediaKind)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  <option value="movie">Filme</option>
                  <option value="series">Serien</option>
                  <option value="image">Bilder</option>
                  <option value="music">Musik</option>
                  <option value="video">Video</option>
                  <option value="other">Sonstiges</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Genre / Thema
                </label>
                <input
                  type="text"
                  value={nasItemGenre}
                  onChange={(e) => setNasItemGenre(e.target.value)}
                  placeholder="z.B. Sci-Fi, Synthwave"
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  FSK-Freigabe
                </label>
                <select
                  value={nasItemFsk}
                  onChange={(e) => setNasItemFsk(Number(e.target.value) as FskLevel)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  {FSK_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      FSK {lvl}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  NAS-Pfad (optional)
                </label>
                <input
                  type="text"
                  value={nasItemPath}
                  onChange={(e) => setNasItemPath(e.target.value)}
                  placeholder="z.B. /mnt/nas/Filme/Polarlichter_2026.mkv"
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Jahr
                </label>
                <input
                  type="number"
                  min={1950}
                  max={2035}
                  value={nasItemYear}
                  onChange={(e) => setNasItemYear(Number(e.target.value) || 2026)}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white tabular-nums focus:outline-none focus:border-amber-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Laufzeit (Min.)
                </label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={nasItemDuration}
                  onChange={(e) => setNasItemDuration(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white tabular-nums focus:outline-none focus:border-amber-400"
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-4">
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Kurzbeschreibung (optional)
                </label>
                <input
                  type="text"
                  value={nasItemSynopsis}
                  onChange={(e) => setNasItemSynopsis(e.target.value)}
                  placeholder="Kurze Inhaltsangabe für die EntenTheke"
                  className="w-full px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  const cleaned = nasItemTitle.trim();
                  if (!cleaned) {
                    setNasAddError('Bitte gib einen Titel ein.');
                    return;
                  }
                  setNasAddError(null);
                  setNasAddNotice(null);
                  setStagedNasItems((prev) => [
                    ...prev,
                    {
                      title: cleaned,
                      kind: nasItemKind,
                      genre: nasItemGenre.trim(),
                      year: nasItemYear,
                      fsk: nasItemFsk,
                      nasPath: nasItemPath.trim() || undefined,
                      totalDurationMinutes: nasItemDuration,
                      synopsis: nasItemSynopsis.trim() || undefined,
                    },
                  ]);
                  setNasItemTitle('');
                  setNasItemGenre('');
                  setNasItemPath('');
                  setNasItemSynopsis('');
                }}
                className="px-3.5 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5 text-amber-400" />
                <span>Zur Liste hinzufügen</span>
              </button>

              <button
                type="button"
                disabled={addingNasItems}
                onClick={async () => {
                  const payloadItems = [...stagedNasItems];
                  if (nasItemTitle.trim()) {
                    payloadItems.push({
                      title: nasItemTitle.trim(),
                      kind: nasItemKind,
                      genre: nasItemGenre.trim(),
                      year: nasItemYear,
                      fsk: nasItemFsk,
                      nasPath: nasItemPath.trim() || undefined,
                      totalDurationMinutes: nasItemDuration,
                      synopsis: nasItemSynopsis.trim() || undefined,
                    });
                  }
                  if (payloadItems.length === 0) {
                    setNasAddError('Bitte mindestens einen neuen Inhalt angeben.');
                    return;
                  }
                  setAddingNasItems(true);
                  setNasAddError(null);
                  setNasAddNotice(null);

                  if (isLocalFallbackToken(token)) {
                    try {
                      const bridgeTarget = resolveBridgeTargetForAdmin();
                      const createdMediaItems: NasMediaItem[] = payloadItems.map((entry, idx) => ({
                        id: `nas-man-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
                        tmdbId: Math.floor(100000 + Math.random() * 800000),
                        title: entry.title,
                        kind: entry.kind,
                        genre: entry.genre || MEDIA_KIND_LABELS[entry.kind],
                        year: entry.year,
                        coverUrl: getFallbackCoverForKind(entry.kind),
                        synopsis:
                          entry.synopsis ||
                          `${MEDIA_KIND_LABELS[entry.kind]} im NAS-Bestand (${entry.nasPath || DEFAULT_NAS_FOLDER_BY_KIND[entry.kind]}).`,
                        codec:
                          entry.kind === 'image'
                            ? 'Bild'
                            : entry.kind === 'music'
                              ? 'Audio'
                              : entry.kind === 'other'
                                ? 'Dokument'
                                : 'H.265 / 4K',
                        audioTracks:
                          entry.kind === 'image' || entry.kind === 'other' ? [] : ['Deutsch'],
                        subtitles: [],
                        totalDurationMinutes: entry.totalDurationMinutes || 90,
                        watchedMinutes: 0,
                        episodesWatchedCount: 0,
                        lastWatchedAt: null,
                        addedAt: new Date().toISOString(),
                        nasPath: entry.nasPath || `${DEFAULT_NAS_FOLDER_BY_KIND[entry.kind]}/${entry.title}`,
                        inWatchlist: false,
                        fsk: entry.fsk,
                      }));
                      const mergedCatalog = stripEphemeralMediaUrlForCatalog(
                        upsertLocalBridgeCatalogItems(createdMediaItems)
                      );
                      saveLocalBridgeCatalog(mergedCatalog);
                      let remoteSynced = false;
                      if (bridgeTarget.host && bridgeTarget.password) {
                        const wr = await writeFileToNasBridge({
                          protocol: bridgeTarget.protocol,
                          host: bridgeTarget.host,
                          port: bridgeTarget.port,
                          shareOrPath: bridgeTarget.shareOrPath,
                          username: bridgeTarget.username,
                          password: bridgeTarget.password,
                          fritzPassword: bridgeTarget.fritzPassword,
                          useTls: bridgeTarget.useTls,
                          targetPath: `${bridgeTarget.backendRoot}/config/catalog.json`,
                          content: JSON.stringify(mergedCatalog, null, 2),
                          contentType: 'application/json; charset=utf-8',
                        });
                        if (!wr.ok) {
                          setNasAddError(
                            wr.error ||
                              'Inhalte lokal vorgemerkt, aber Katalog-Synchronisation aufs NAS fehlgeschlagen.'
                          );
                        } else {
                          remoteSynced = true;
                        }
                      }
                      setStagedNasItems([]);
                      setNasItemTitle('');
                      setNasItemGenre('');
                      setNasItemPath('');
                      setNasItemSynopsis('');
                      setNasAddNotice(
                        remoteSynced
                          ? `${createdMediaItems.length} Inhalt(e) direkt in ${bridgeTarget.backendRoot}/config/catalog.json auf ${bridgeTarget.host} gespeichert.`
                          : `${createdMediaItems.length} Inhalt(e) im Storage-Bridge-Katalog gespeichert.`
                      );
                      await loadAdminCatalog();
                      onNasItemsAdded?.();
                    } catch {
                      setNasAddError('Inhalte konnten nicht gespeichert werden.');
                    } finally {
                      setAddingNasItems(false);
                    }
                    return;
                  }

                  try {
                    const res = await fetch('/api/nas/library/items', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                      },
                      body: JSON.stringify({ items: payloadItems }),
                    });
                    const data = (await res.json()) as {
                      error?: string;
                      addedItems?: Array<{ title: string }>;
                      notifiedUsers?: number;
                    };
                    if (!res.ok) {
                      setNasAddError(
                        data.error || 'Inhalte konnten nicht zum NAS hinzugefügt werden.'
                      );
                      return;
                    }
                    setStagedNasItems([]);
                    setNasItemTitle('');
                    setNasItemGenre('');
                    setNasItemPath('');
                    setNasItemSynopsis('');
                    setNasAddNotice(
                      `${data.addedItems?.length ?? payloadItems.length} neue(r) Inhalt(e) auf dem NAS gespeichert. Der Enten-Assistent hat ${data.notifiedUsers ?? 0} Benutzer benachrichtigt.`
                    );
                    await loadAdminCatalog();
                    onNasItemsAdded?.();
                  } catch {
                    setNasAddError('Verbindung zum NAS beim Hinzufügen fehlgeschlagen.');
                  } finally {
                    setAddingNasItems(false);
                  }
                }}
                className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <HardDrive className="w-3.5 h-3.5" />
                <span>
                  {addingNasItems
                    ? 'Speichere auf NAS...'
                    : 'Auf NAS speichern & alle benachrichtigen'}
                </span>
              </button>
            </div>

            {stagedNasItems.length > 0 && (
              <div className="p-3 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-2">
                <p className="text-[11px] font-medium text-slate-400">
                  Vorgemerkte Inhalte ({stagedNasItems.length}):
                </p>
                <div className="flex flex-wrap gap-2">
                  {stagedNasItems.map((entry, idx) => (
                    <div
                      key={`${entry.title}-${idx}`}
                      className="px-2.5 py-1 rounded-lg bg-[#121722] border border-slate-800 text-xs text-slate-200 flex items-center gap-2"
                    >
                      <span>
                        {entry.title} · {MEDIA_KIND_LABELS[entry.kind]} · FSK {entry.fsk}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setStagedNasItems((prev) => prev.filter((_, i) => i !== idx))
                        }
                        aria-label={`${entry.title} entfernen`}
                        className="text-slate-400 hover:text-rose-300"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {nasAddError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{nasAddError}</span>
              </div>
            )}

            {nasAddNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{nasAddNotice}</span>
              </div>
            )}
          </div>
          )}
        </section>

        {/* 3. Vorhandener NAS-Medienbestand & hochgeladene Dateien verwalten */}
        <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
          <div
            className={`px-6 py-5 flex flex-wrap items-center justify-between gap-4 ${
              !collapsedSections.contentCatalog ? 'border-b border-slate-800/80' : ''
            }`}
          >
            <button
              type="button"
              aria-expanded={!collapsedSections.contentCatalog}
              onClick={() => toggleSectionCollapse('contentCatalog')}
              className="flex items-center gap-3.5 min-w-0 flex-1 text-left"
            >
              <span className="w-10 h-10 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
                <Database className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-white">
                  NAS-Medienbestand verwalten ({adminCatalog.length})
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Bearbeite Metadaten &amp; FSK-Freigaben, lade hochgeladene Dateien herunter oder
                  entferne Einträge vom NAS.
                </p>
              </div>
            </button>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void loadAdminCatalog()}
                disabled={loadingCatalog}
                className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingCatalog ? 'animate-spin' : ''}`} />
                <span>Aktualisieren</span>
              </button>
              <button
                type="button"
                aria-expanded={!collapsedSections.contentCatalog}
                aria-label={
                  collapsedSections.contentCatalog
                    ? 'NAS-Medienbestand aufklappen'
                    : 'NAS-Medienbestand zuklappen'
                }
                onClick={() => toggleSectionCollapse('contentCatalog')}
                className="p-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors"
              >
                {collapsedSections.contentCatalog ? (
                  <ChevronRight className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {!collapsedSections.contentCatalog && (
          <div className="p-6 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder="Suche nach Titel, Genre oder NAS-Pfad..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
              </div>

              <select
                value={catalogKindFilter}
                onChange={(e) => setCatalogKindFilter(e.target.value as 'all' | MediaKind)}
                aria-label="Nach Kategorie filtern"
                className="px-3 py-2 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
              >
                <option value="all">Alle Kategorien</option>
                <option value="movie">Filme</option>
                <option value="series">Serien</option>
                <option value="image">Bilder</option>
                <option value="music">Musik</option>
                <option value="video">Video</option>
                <option value="other">Sonstiges</option>
              </select>
            </div>

            {catalogError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{catalogError}</span>
              </div>
            )}

            {catalogNotice && (
              <div
                role="status"
                className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{catalogNotice}</span>
              </div>
            )}

            {editingCatalogItem && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleUpdateCatalogItem(
                    editingCatalogItem.id,
                    {
                      title: editingCatalogItem.title,
                      kind: editingCatalogItem.kind,
                      genre: editingCatalogItem.genre,
                      year: editingCatalogItem.year,
                      fsk: editingCatalogItem.fsk,
                      nasPath: editingCatalogItem.nasPath,
                      totalDurationMinutes: editingCatalogItem.totalDurationMinutes,
                      synopsis: editingCatalogItem.synopsis,
                    },
                    `Eintrag „${editingCatalogItem.title}“ aktualisiert.`
                  );
                }}
                className="p-4 rounded-xl bg-[#0B0E14] border border-amber-400/50 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-amber-300">
                    NAS-Eintrag bearbeiten: {editingCatalogItem.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => setEditingCatalogItem(null)}
                    className="text-slate-400 hover:text-white"
                    aria-label="Bearbeitung schließen"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Titel</label>
                    <input
                      type="text"
                      required
                      value={editingCatalogItem.title}
                      onChange={(e) =>
                        setEditingCatalogItem({ ...editingCatalogItem, title: e.target.value })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Kategorie</label>
                    <select
                      value={editingCatalogItem.kind}
                      onChange={(e) =>
                        setEditingCatalogItem({
                          ...editingCatalogItem,
                          kind: e.target.value as MediaKind,
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white"
                    >
                      <option value="movie">Filme</option>
                      <option value="series">Serien</option>
                      <option value="image">Bilder</option>
                      <option value="music">Musik</option>
                      <option value="video">Video</option>
                      <option value="other">Sonstiges</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Genre</label>
                    <input
                      type="text"
                      value={editingCatalogItem.genre}
                      onChange={(e) =>
                        setEditingCatalogItem({ ...editingCatalogItem, genre: e.target.value })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">FSK-Freigabe</label>
                    <select
                      value={editingCatalogItem.fsk}
                      onChange={(e) =>
                        setEditingCatalogItem({
                          ...editingCatalogItem,
                          fsk: Number(e.target.value) as FskLevel,
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white"
                    >
                      {FSK_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          FSK {lvl}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] text-slate-400 mb-1">NAS-Pfad</label>
                    <input
                      type="text"
                      value={editingCatalogItem.nasPath}
                      onChange={(e) =>
                        setEditingCatalogItem({ ...editingCatalogItem, nasPath: e.target.value })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Jahr</label>
                    <input
                      type="number"
                      min={1950}
                      max={2035}
                      value={editingCatalogItem.year}
                      onChange={(e) =>
                        setEditingCatalogItem({
                          ...editingCatalogItem,
                          year: Number(e.target.value) || 2026,
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Laufzeit (Min.)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      value={editingCatalogItem.totalDurationMinutes}
                      onChange={(e) =>
                        setEditingCatalogItem({
                          ...editingCatalogItem,
                          totalDurationMinutes: Math.max(1, Number(e.target.value) || 1),
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white tabular-nums"
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="block text-[11px] text-slate-400 mb-1">Beschreibung</label>
                    <input
                      type="text"
                      value={editingCatalogItem.synopsis}
                      onChange={(e) =>
                        setEditingCatalogItem({
                          ...editingCatalogItem,
                          synopsis: e.target.value,
                        })
                      }
                      className="w-full px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingCatalogItem(null)}
                    className="px-3 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-slate-300 hover:text-white"
                  >
                    Abbrechen
                  </button>
                  <button
                    type="submit"
                    disabled={catalogBusyId === editingCatalogItem.id}
                    className="px-4 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold"
                  >
                    Änderungen speichern
                  </button>
                </div>
              </form>
            )}

            {loadingCatalog && adminCatalog.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                Lade NAS-Medienbestand...
              </div>
            ) : filteredAdminCatalog.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                Keine passenden Inhalte gefunden.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/70 border border-slate-800/80 rounded-xl bg-[#0B0E14] px-4 max-h-[520px] overflow-y-auto">
                {filteredAdminCatalog.map((item) => {
                  const isBusy = catalogBusyId === item.id;
                  const showingDelete = catalogDeleteTarget === item.id;
                  return (
                    <div key={item.id} className="py-3.5 space-y-2.5">
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <span className="w-9 h-9 rounded-lg bg-[#121722] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0 mt-0.5">
                            {item.kind === 'movie' ? (
                              <Film className="w-4 h-4" />
                            ) : item.kind === 'series' ? (
                              <Tv className="w-4 h-4" />
                            ) : item.kind === 'image' ? (
                              <ImageIcon className="w-4 h-4" />
                            ) : item.kind === 'music' ? (
                              <Music className="w-4 h-4" />
                            ) : item.kind === 'video' ? (
                              <Video className="w-4 h-4" />
                            ) : (
                              <FileText className="w-4 h-4" />
                            )}
                          </span>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-xs sm:text-sm font-semibold text-white truncate">
                                {item.title}
                              </p>
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-[#121722] border border-slate-700 text-slate-300">
                                {MEDIA_KIND_LABELS[item.kind]}
                              </span>
                              {item.hasUploadedFile && (
                                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                                  Datei auf NAS
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 truncate mt-0.5">
                              {item.genre} · {item.year}
                              {item.fileFormat ? ` · ${item.fileFormat}` : ''}
                              {item.fileSize ? ` · ${item.fileSize}` : ''}
                            </p>
                            <p className="text-[11px] font-mono text-slate-500 truncate">
                              {item.nasPath}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <select
                            aria-label={`FSK-Freigabe für ${item.title}`}
                            disabled={isBusy}
                            value={item.fsk}
                            onChange={(e) => {
                              const nextFsk = Number(e.target.value) as FskLevel;
                              void handleUpdateCatalogItem(
                                item.id,
                                { fsk: nextFsk },
                                `FSK-Freigabe für „${item.title}“ auf FSK ${nextFsk} geändert.`
                              );
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-700 text-xs text-white focus:outline-none focus:border-amber-400"
                          >
                            {FSK_LEVELS.map((lvl) => (
                              <option key={lvl} value={lvl}>
                                FSK {lvl}
                              </option>
                            ))}
                          </select>

                          {onPlayMediaId && (
                            <button
                              type="button"
                              onClick={() => onPlayMediaId(item.id)}
                              title="Im Enten Player öffnen"
                              className="px-2.5 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 text-xs text-amber-300 flex items-center gap-1 transition-colors"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>Abspielen</span>
                            </button>
                          )}

                          {item.hasUploadedFile && item.mediaUrl && (
                            <a
                              href={
                                item.mediaUrl.includes('?')
                                  ? `${item.mediaUrl}&download=1`
                                  : `${item.mediaUrl}?token=${encodeURIComponent(token)}&download=1`
                              }
                              download={item.uploadedFileName || undefined}
                              title="Hochgeladene Datei herunterladen"
                              className="p-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          )}

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setEditingCatalogItem(item)}
                            title="Metadaten bearbeiten"
                            aria-label={`${item.title} bearbeiten`}
                            className="p-2 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>

                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setCatalogDeleteTarget((prev) => (prev === item.id ? null : item.id))
                            }
                            title="Vom NAS entfernen"
                            aria-label={`${item.title} löschen`}
                            className="p-2 rounded-lg bg-[#121722] border border-slate-800 text-slate-400 hover:text-rose-300 hover:border-rose-800/70 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {showingDelete && (
                        <div className="p-3 rounded-lg bg-rose-950/35 border border-rose-500/45 flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="text-rose-100">
                            Inhalt <strong>{item.title}</strong> wirklich vom NAS löschen?
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setCatalogDeleteTarget(null)}
                              className="px-3 py-1 rounded-lg bg-[#121722] border border-slate-700 text-slate-300 hover:text-white"
                            >
                              Abbrechen
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeleteCatalogItem(item.id)}
                              className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold"
                            >
                              Ja, löschen
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}
        </section>
      </div>
      )}

      {/* Bestätigungsdialog vor Überschreiben des vorhandenen verschlüsselten Cloud-Tresors auf Google Drive */}
      {pendingDriveOverwrite && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center px-4 pt-[calc(1rem+var(--app-top-clearance,0px))] pb-[calc(1rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cloud-vault-overwrite-title"
          onClick={() => {
            if (!cloudSyncBusy) setPendingDriveOverwrite(null);
          }}
        >
          <div
            className="w-full max-w-md bg-[#121722] border border-slate-700/80 rounded-2xl p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h4
                  id="cloud-vault-overwrite-title"
                  className="font-display text-base font-semibold text-white"
                >
                  Verschlüsselten Cloud-Tresor aktualisieren?
                </h4>
                <p className="text-xs text-slate-400 mt-1">
                  Auf Google Drive existiert bereits die verschlüsselte Datei{' '}
                  <strong className="text-slate-200">{pendingDriveOverwrite.existingFile.name}</strong>
                  {pendingDriveOverwrite.existingFile.modifiedTime
                    ? ` (Stand ${new Date(
                        pendingDriveOverwrite.existingFile.modifiedTime
                      ).toLocaleString('de-DE')})`
                    : ''}
                  . Möchtest du sie durch die neu mit AES-256-GCM verschlüsselten Nutzerdaten
                  ersetzen?
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={cloudSyncBusy}
                onClick={() => setPendingDriveOverwrite(null)}
                className="px-4 py-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white transition-colors"
              >
                Abbrechen
              </button>
              <button
                type="button"
                disabled={cloudSyncBusy}
                onClick={() => void handleConfirmPendingDriveOverwrite()}
                className="px-4 py-2 rounded-lg bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 text-slate-950 text-xs font-semibold transition-colors"
              >
                {cloudSyncBusy ? 'Aktualisiere...' : 'Verschlüsselt aktualisieren'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Klickbarer NAS-Ordner-Browser für manuelle Scan-Ordnerauswahl */}
      {scanBrowserOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center px-2 sm:px-4 pt-[calc(0.75rem+var(--app-top-clearance,0px))] pb-[calc(0.75rem+var(--app-bottom-clearance,0px))]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nas-scan-browser-title"
          onClick={() => setScanBrowserOpen(false)}
        >
          <div
            className="w-full max-w-[min(48rem,calc(100vw-1rem))] max-h-[calc(100dvh-1.5rem-var(--app-top-clearance,0px)-var(--app-bottom-clearance,0px))] flex flex-col bg-[#121722] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal-Header */}
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-9 h-9 rounded-xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center shrink-0">
                  <FolderOpen className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <h4
                    id="nas-scan-browser-title"
                    className="font-display text-sm sm:text-base font-semibold text-white truncate"
                  >
                    NAS-Ordner für „Manueller Scan“ auswählen
                  </h4>
                  <p className="text-[11px] text-slate-400 truncate">
                    Klicke auf einen Ordnernamen, um hineinzuwechseln, oder auf „Auswählen“, um ihn
                    in die Scan-Liste aufzunehmen.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScanBrowserOpen(false)}
                aria-label="NAS-Explorer schließen"
                className="p-2 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Verbindungs- & Zugangsdaten-Leiste (falls NAS Login verlangt) */}
            <div className="px-5 py-3 bg-[#0B0E14]/90 border-b border-slate-800 space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                <input
                  type="text"
                  value={scanBrowserHost}
                  onChange={(e) => setScanBrowserHost(e.target.value)}
                  placeholder="Host (z. B. 192.168.178.1)"
                  aria-label="NAS Hostname oder IP"
                  className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <select
                  value={scanBrowserProto}
                  onChange={(e) => setScanBrowserProto(e.target.value as NasProtocolId)}
                  aria-label="NAS-Protokoll"
                  className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  <option value="fritz_upnp">FRITZ!NAS (Web + SMB2)</option>
                  <option value="smb">SMB 2/3 (:445)</option>
                  <option value="webdav">WebDAV / HTTPS</option>
                </select>
                <input
                  type="text"
                  value={scanBrowserUser}
                  onChange={(e) => setScanBrowserUser(e.target.value)}
                  placeholder="NAS-Benutzer (optional)"
                  aria-label="NAS Benutzername"
                  className="px-2.5 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <input
                      type={scanBrowserShowPass ? 'text' : 'password'}
                      value={scanBrowserPass}
                      onChange={(e) => setScanBrowserPass(e.target.value)}
                      placeholder="NAS-Passwort"
                      aria-label="NAS Passwort"
                      className="w-full pl-2.5 pr-7 py-1.5 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={() => setScanBrowserShowPass((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      aria-label={scanBrowserShowPass ? 'Passwort verbergen' : 'Passwort anzeigen'}
                    >
                      {scanBrowserShowPass ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={scanBrowserLoading}
                    onClick={() => void loadScanBrowserDirectory(scanBrowserPath)}
                    className="px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold whitespace-nowrap transition-colors"
                  >
                    Verbinden
                  </button>
                </div>
              </div>

              {/* Pfad-Navigation */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    disabled={scanBrowserLoading || !scanBrowserResult?.parentPath}
                    onClick={() => {
                      if (scanBrowserResult?.parentPath) {
                        void loadScanBrowserDirectory(scanBrowserResult.parentPath);
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 disabled:opacity-40 border border-slate-800 text-slate-200 flex items-center gap-1 transition-colors"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                    <span>Ebene höher</span>
                  </button>
                  <button
                    type="button"
                    disabled={scanBrowserLoading}
                    onClick={() => void loadScanBrowserDirectory('/')}
                    className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors"
                  >
                    /
                  </button>
                  <span className="font-mono text-amber-300 truncate">
                    {scanBrowserPath}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {scanBrowserResult?.liveFilesystem && (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">
                      Live-NAS ({scanBrowserResult.source})
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={scanBrowserLoading}
                    onClick={() => void loadScanBrowserDirectory(scanBrowserPath)}
                    className="px-2.5 py-1 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white flex items-center gap-1 transition-colors"
                  >
                    <RefreshCw className={`w-3 h-3 ${scanBrowserLoading ? 'animate-spin' : ''}`} />
                    <span>Aktualisieren</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Verzeichnisliste */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {scanBrowserResult?.warning && (
                <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-700/60 text-xs text-amber-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>{scanBrowserResult.warning}</span>
                </div>
              )}
              {scanBrowserResult?.error && (
                <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-800/70 text-xs text-rose-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{scanBrowserResult.error}</span>
                </div>
              )}

              {scanBrowserLoading ? (
                <div className="py-10 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                  <span>Lese Ordnerstruktur vom NAS ({scanBrowserPath})...</span>
                </div>
              ) : (() => {
                  const folders = (scanBrowserResult?.entries ?? []).filter(
                    (entry) => entry.type === 'directory'
                  );
                  if (folders.length === 0) {
                    return (
                      <div className="py-8 text-center text-xs text-slate-400 space-y-2">
                        <p>In diesem Pfad wurden keine Unterordner gefunden.</p>
                        {scanBrowserPath !== '/' && (
                          <button
                            type="button"
                            onClick={() => toggleSelectedScanFolder(scanBrowserPath)}
                            className="px-3 py-1.5 rounded-lg bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 text-amber-200 text-xs font-medium"
                          >
                            Aktuellen Ordner „{scanBrowserPath}“ auswählen
                          </button>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-1.5">
                      {folders.map((entry) => {
                        const normEntry = normalizeScanFolderPath(entry.path);
                        const isSelected = scanFolderSettings.selectedFolders.some(
                          (f) => f.toLowerCase() === normEntry.toLowerCase()
                        );
                        return (
                          <div
                            key={entry.path}
                            className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                              isSelected
                                ? 'bg-amber-400/10 border-amber-400/60'
                                : 'bg-[#0B0E14] border-slate-800 hover:border-slate-700'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => void loadScanBrowserDirectory(entry.path)}
                              className="flex items-center gap-2.5 min-w-0 flex-1 text-left group"
                            >
                              <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-white group-hover:text-amber-300 truncate transition-colors">
                                  {entry.name}
                                </p>
                                <p className="text-[11px] font-mono text-slate-500 truncate">
                                  {normEntry}
                                </p>
                              </div>
                            </button>

                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => void loadScanBrowserDirectory(entry.path)}
                                className="px-2.5 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-300 hover:text-white transition-colors"
                              >
                                Öffnen
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleSelectedScanFolder(entry.path)}
                                className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 transition-colors ${
                                  isSelected
                                    ? 'bg-amber-400 border-amber-300 text-slate-950'
                                    : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200'
                                }`}
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>{isSelected ? 'Ausgewählt' : 'Auswählen'}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

              {/* Manueller Pfad-Zusatz */}
              <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={scanBrowserManualPath}
                  onChange={(e) => setScanBrowserManualPath(e.target.value)}
                  placeholder="Optional Pfad direkt hinzufügen (z. B. /FRITZ/Filme)"
                  className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg bg-[#0B0E14] border border-slate-800 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = scanBrowserManualPath.trim();
                    if (!trimmed) return;
                    const norm = normalizeScanFolderPath(trimmed);
                    setScanFolderSettings((prev) => {
                      const exists = prev.selectedFolders.some(
                        (p) => p.toLowerCase() === norm.toLowerCase()
                      );
                      return {
                        ...prev,
                        scanMode: 'selected',
                        selectedFolders: exists
                          ? prev.selectedFolders
                          : [...prev.selectedFolders, norm],
                      };
                    });
                    setScanBrowserManualPath('');
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-amber-400" />
                  <span>Pfad hinzufügen</span>
                </button>
              </div>
            </div>

            {/* Modal-Footer */}
            <div className="px-5 py-3.5 border-t border-slate-800 bg-[#0B0E14] flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-300">
                <strong className="text-amber-300 tabular-nums">
                  {scanFolderSettings.selectedFolders.length}
                </strong>{' '}
                Ordner für den manuellen Scan markiert
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {scanFolderSettings.selectedFolders.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setScanFolderSettings((prev) => ({
                        ...prev,
                        scanMode: 'all',
                        selectedFolders: [],
                      }))
                    }
                    className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-white transition-colors"
                  >
                    Auswahl zurücksetzen (Alle)
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setScanBrowserOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
                >
                  Schließen
                </button>
                <button
                  type="button"
                  disabled={savingScanFolders}
                  onClick={async () => {
                    setScanBrowserOpen(false);
                    await handleSaveScanFolderSettings();
                  }}
                  className="px-4 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Übernehmen &amp; Speichern</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
