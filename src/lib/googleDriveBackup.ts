import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { EncryptedCloudVaultEnvelope, NasUser, UserPreferences } from '../types/marcente';

const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export const CLOUD_VAULT_FILE_NAME = 'entencenter-userdata-vault.enc.json';

const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// In-memory only OAuth access token cache (never stored in localStorage or sessionStorage)
let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt = 0;

export class GoogleDriveAuthExpiredError extends Error {
  constructor(message = 'Die Google-Drive-Sitzung ist abgelaufen. Bitte erneut mit Google anmelden.') {
    super(message);
    this.name = 'GoogleDriveAuthExpiredError';
  }
}

export interface DriveBackupFileInfo {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

export interface ProfileBackupPayload {
  schemaVersion: '1.0';
  app: 'EntenCenter NAS Mediacenter';
  exportedAt: string;
  profile: {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'family';
    createdAt: string;
    avatarColor: string;
    hasProfilePicture: boolean;
    avatarUrl: string | null;
  };
  preferences: UserPreferences;
  nasSummary: {
    watchlistCount: number;
    watchlistTitles: string[];
    favoriteSeries: string[];
    watchedTitlesCount: number;
  };
}

export function getInMemoryDriveToken(): string | null {
  if (!cachedAccessToken) return null;
  if (Date.now() >= cachedTokenExpiresAt) {
    cachedAccessToken = null;
    cachedTokenExpiresAt = 0;
    return null;
  }
  return cachedAccessToken;
}

export function clearInMemoryDriveToken(): void {
  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
}

export function subscribeGoogleAuth(
  callback: (user: FirebaseUser | null, accessToken: string | null) => void
): () => void {
  return onAuthStateChanged(auth, (fbUser) => {
    if (!fbUser) {
      clearInMemoryDriveToken();
    }
    callback(fbUser, fbUser ? getInMemoryDriveToken() : null);
  });
}

export async function signInWithGoogleForDrive(): Promise<{
  user: FirebaseUser;
  accessToken: string;
}> {
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_DRIVE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'select_account',
  });

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken ?? null;

  if (!accessToken) {
    throw new Error(
      'Kein Google-Drive-Zugriffstoken erhalten. Bitte erlaube bei der Anmeldung den Google-Drive-Dateizugriff.'
    );
  }

  cachedAccessToken = accessToken;
  cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000;

  return { user: result.user, accessToken };
}

export async function signOutGoogleForDrive(): Promise<void> {
  clearInMemoryDriveToken();
  await signOut(auth);
}

export function getProfileBackupFileName(username: string): string {
  const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `entencenter-profil-${safeUsername}.json`;
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function parseDriveError(res: Response): Promise<never> {
  if (res.status === 401) {
    clearInMemoryDriveToken();
    throw new GoogleDriveAuthExpiredError();
  }
  let detail = `Google Drive HTTP ${res.status}`;
  try {
    const json = (await res.json()) as { error?: { message?: string } };
    if (json?.error?.message) {
      detail = json.error.message;
    }
  } catch {
    // Fallback auf Statuscode
  }
  throw new Error(detail);
}

export async function findProfileBackupFile(
  accessToken: string,
  username: string
): Promise<DriveBackupFileInfo | null> {
  const fileName = getProfileBackupFileName(username);
  const query = `name = '${escapeDriveQueryLiteral(fileName)}' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime,size,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '5',
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    await parseDriveError(res);
  }

  const data = (await res.json()) as { files?: DriveBackupFileInfo[] };
  return data.files?.[0] ?? null;
}

export async function uploadProfileBackupFile(
  accessToken: string,
  payload: ProfileBackupPayload,
  existingFileId?: string
): Promise<DriveBackupFileInfo> {
  const fileName = getProfileBackupFileName(payload.profile.username);
  const metadata = existingFileId
    ? {
        name: fileName,
        description: `EntenCenter Profil-Backup für @${payload.profile.username}`,
      }
    : {
        name: fileName,
        mimeType: 'application/json',
        description: `EntenCenter Profil-Backup für @${payload.profile.username}`,
      };

  const boundary = `entencenter_drive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(payload, null, 2)}\r\n` +
    `--${boundary}--`;

  const uploadUrl = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`;

  const res = await fetch(uploadUrl, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    await parseDriveError(res);
  }

  return (await res.json()) as DriveBackupFileInfo;
}

export function buildProfileBackupPayload(
  user: NasUser,
  preferences: UserPreferences,
  nasSummary: ProfileBackupPayload['nasSummary']
): ProfileBackupPayload {
  return {
    schemaVersion: '1.0',
    app: 'EntenCenter NAS Mediacenter',
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      avatarColor: user.avatarColor,
      hasProfilePicture: Boolean(user.avatarUrl),
      avatarUrl: user.avatarUrl ?? null,
    },
    preferences,
    nasSummary,
  };
}

export async function findEncryptedCloudVaultFile(
  accessToken: string
): Promise<DriveBackupFileInfo | null> {
  const query = `name = '${escapeDriveQueryLiteral(CLOUD_VAULT_FILE_NAME)}' and trashed = false`;
  const params = new URLSearchParams({
    q: query,
    spaces: 'drive',
    fields: 'files(id,name,modifiedTime,size,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '5',
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    await parseDriveError(res);
  }

  const data = (await res.json()) as { files?: DriveBackupFileInfo[] };
  return data.files?.[0] ?? null;
}

export async function uploadEncryptedCloudVaultFile(
  accessToken: string,
  envelope: EncryptedCloudVaultEnvelope,
  existingFileId?: string | null
): Promise<DriveBackupFileInfo> {
  const metadata = existingFileId
    ? {
        name: CLOUD_VAULT_FILE_NAME,
        description: 'EntenCenter AES-256-GCM verschlüsselter Nutzerdaten-Tresor',
      }
    : {
        name: CLOUD_VAULT_FILE_NAME,
        mimeType: 'application/json',
        description: 'EntenCenter AES-256-GCM verschlüsselter Nutzerdaten-Tresor',
      };

  const boundary = `entencenter_vault_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(envelope, null, 2)}\r\n` +
    `--${boundary}--`;

  const uploadUrl = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size,webViewLink`;

  const res = await fetch(uploadUrl, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    await parseDriveError(res);
  }

  return (await res.json()) as DriveBackupFileInfo;
}

export async function downloadEncryptedCloudVaultFile(
  accessToken: string,
  fileId: string
): Promise<EncryptedCloudVaultEnvelope> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    await parseDriveError(res);
  }

  return (await res.json()) as EncryptedCloudVaultEnvelope;
}

