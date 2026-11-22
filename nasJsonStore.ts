import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WriteJsonOptions {
  allowEmptyOverwrite?: boolean;
  allowShrink?: boolean;
  skipBackup?: boolean;
  actor?: string;
}

export interface NasJsonStoreHooks {
  onBackupRestored?: (filename: string, source: 'backup' | 'cache') => void;
  onWriteBlocked?: (
    filename: string,
    reason: string,
    existingCount: number,
    incomingCount: number
  ) => void;
  onAfterWrite?: (filename: string) => void;
}

const COMPACT_JSON_FILES = new Set([
  'catalog.json',
  'film_starts.json',
  'history.json',
  'behavior.json',
  'notifications.json',
  'calendar.json',
]);

const PROTECTED_NON_EMPTY_STORES = new Set([
  'users.json',
  'catalog.json',
  'settings.json',
  'history.json',
  'calendar.json',
  'favorites.json',
  'watchlist.json',
  'collections.json',
  'nas_connections.json',
  'smarthome.json',
  'behavior.json',
  'preferences.json',
  'film_starts.json',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function tryParseJsonString<T>(raw: string): T {
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/\0+$/g, '').trim();
  if (!cleaned) {
    throw new Error('JSON-Inhalt ist leer.');
  }
  return JSON.parse(cleaned) as T;
}

export function countJsonStoreRecords(filename: string, data: unknown): number | null {
  if (data === null || data === undefined) return 0;
  switch (filename) {
    case 'catalog.json':
      return Array.isArray(data) ? data.length : null;
    case 'users.json':
      return isPlainObject(data) ? Object.keys(data).length : null;
    case 'history.json':
      return isPlainObject(data) && Array.isArray(data.watches) ? data.watches.length : null;
    case 'calendar.json':
      return isPlainObject(data) && Array.isArray(data.releases) ? data.releases.length : null;
    case 'film_starts.json':
      return isPlainObject(data) && Array.isArray(data.releases) ? data.releases.length : null;
    case 'notifications.json':
      return isPlainObject(data) && Array.isArray(data.alerts) ? data.alerts.length : null;
    case 'favorites.json':
    case 'watchlist.json':
    case 'preferences.json':
    case 'collections.json':
    case 'nas_connections.json':
    case 'behavior.json':
      return isPlainObject(data) && isPlainObject(data.users)
        ? Object.keys(data.users).length
        : null;
    case 'settings.json':
      return isPlainObject(data) ? Object.keys(data).length : null;
    case 'smarthome.json':
      return isPlainObject(data)
        ? typeof data.webhookToken === 'string' && data.webhookToken.length > 0
          ? Object.keys(data).length
          : 0
        : null;
    default:
      if (Array.isArray(data)) return data.length;
      if (isPlainObject(data)) return Object.keys(data).length;
      return null;
  }
}

function getErrCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function sanitizeStoreFilename(filename: string): string {
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..' || base !== filename) {
    throw new Error(`Ungültiger NAS-Dateiname: ${filename}`);
  }
  return base;
}

export function createNasJsonStore(dataDir: string, hooks: NasJsonStoreHooks = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const backupDir = path.join(resolvedDataDir, '.backups');
  const jsonFileCache = new Map<string, { mtimeMs: number; size: number; data: unknown }>();
  let dirReady = false;

  function ensureDirs(): void {
    if (!dirReady || !fs.existsSync(resolvedDataDir) || !fs.existsSync(backupDir)) {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
      fs.mkdirSync(backupDir, { recursive: true });
      dirReady = true;
    }
  }

  function getFilePath(filename: string): string {
    const clean = sanitizeStoreFilename(filename);
    return path.join(resolvedDataDir, clean);
  }

  function getBackupPath(filename: string): string {
    const clean = sanitizeStoreFilename(filename);
    return path.join(backupDir, `${clean}.bak`);
  }

  function readValidJsonFromPath<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return tryParseJsonString<T>(raw);
    } catch {
      return null;
    }
  }

  function hasValidBackup(filename: string): boolean {
    const backupPath = getBackupPath(filename);
    return readValidJsonFromPath(backupPath) !== null;
  }

  function isStoreDefinitelyMissing(filename: string): boolean {
    const filePath = getFilePath(filename);
    try {
      fs.statSync(filePath);
      return false;
    } catch (err) {
      const code = getErrCode(err);
      if (code !== 'ENOENT') {
        console.error(
          `[NAS-SCHUTZ] Zugriffsfehler bei statSync(${filename}) [${code ?? 'UNKNOWN'}] — behandle Datei NICHT als fehlend.`
        );
        return false;
      }
      if (hasValidBackup(filename)) {
        return false;
      }
      return true;
    }
  }

  function writeRawAtomic(targetPath: string, content: string, tempDir: string, label: string): void {
    const tmpPath = path.join(
      tempDir,
      `.tmp-${label}-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`
    );
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Temp-Aufräumen ignorieren
      }
      throw err;
    }
  }

  function saveRollingBackupFromTarget(filename: string, targetPath: string): void {
    try {
      const stat = fs.statSync(targetPath);
      if (!stat.isFile() || stat.size === 0) return;
      const raw = fs.readFileSync(targetPath, 'utf-8');
      tryParseJsonString(raw);
      ensureDirs();
      writeRawAtomic(getBackupPath(filename), raw, backupDir, `${filename}.bak`);
    } catch {
      // Bestehende Datei ist nicht valide oder nicht lesbar — vorhandenes Backup unverändert lassen
    }
  }

  function quarantineCorruptFile(filename: string, filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      ensureDirs();
      const quarantinePath = path.join(backupDir, `${filename}.corrupt-${Date.now()}`);
      fs.copyFileSync(filePath, quarantinePath);
    } catch {
      // Quarantäne-Kopie fehlgeschlagen — Original bleibt unberührt
    }
  }

  function restoreFromBackupOrCache<T>(filename: string, targetPath: string, allowOverwriteTarget: boolean): T | null {
    const backupData = readValidJsonFromPath<T>(getBackupPath(filename));
    if (backupData !== null) {
      if (allowOverwriteTarget) {
        try {
          const serialized = COMPACT_JSON_FILES.has(filename)
            ? JSON.stringify(backupData)
            : JSON.stringify(backupData, null, 2);
          writeRawAtomic(targetPath, serialized, resolvedDataDir, filename);
          const stat = fs.statSync(targetPath);
          jsonFileCache.set(filename, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            data: structuredClone(backupData),
          });
        } catch (err) {
          console.warn(`[NAS-SCHUTZ] Backup für ${filename} im Speicher wiederhergestellt, Rückschreiben fehlgeschlagen:`, err);
        }
      }
      hooks.onBackupRestored?.(filename, 'backup');
      console.warn(`[NAS-SCHUTZ] ${filename} automatisch aus Rolling-Backup wiederhergestellt.`);
      return structuredClone(backupData);
    }

    const cached = jsonFileCache.get(filename);
    if (cached) {
      hooks.onBackupRestored?.(filename, 'cache');
      console.warn(`[NAS-SCHUTZ] ${filename} vorübergehend aus Speicher-Cache bedient.`);
      return structuredClone(cached.data) as T;
    }

    return null;
  }

  function readJsonFile<T>(filename: string, fallback: T): T {
    const filePath = getFilePath(filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      const code = getErrCode(err);
      if (code !== 'ENOENT') {
        const recovered = restoreFromBackupOrCache<T>(filename, filePath, false);
        if (recovered !== null) {
          return recovered;
        }
        throw new Error(
          `NAS-Datei ${filename} nicht erreichbar (${code ?? 'IO_ERROR'}). Zum Schutz vor Datenverlust wurde kein Reset geschrieben.`
        );
      }

      // Datei fehlt auf Disk: erst prüfen, ob ein gültiges Rolling-Backup existiert
      const recovered = restoreFromBackupOrCache<T>(filename, filePath, true);
      if (recovered !== null) {
        return recovered;
      }

      // Wirklich neu anlegen (beide: Datei und Backup fehlen)
      writeJsonAtomic(filename, fallback, {
        allowEmptyOverwrite: true,
        allowShrink: true,
        skipBackup: true,
      });
      return structuredClone(fallback);
    }

    const cached = jsonFileCache.get(filename);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return structuredClone(cached.data) as T;
    }

    let lastParseErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = tryParseJsonString<T>(fs.readFileSync(filePath, 'utf-8'));
        jsonFileCache.set(filename, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          data: parsed,
        });
        return structuredClone(parsed);
      } catch (err) {
        lastParseErr = err;
      }
    }

    quarantineCorruptFile(filename, filePath);
    const recovered = restoreFromBackupOrCache<T>(filename, filePath, true);
    if (recovered !== null) {
      return recovered;
    }

    throw new Error(
      `NAS-Datei ${filename} konnte nicht geparst werden (${
        lastParseErr instanceof Error ? lastParseErr.message : String(lastParseErr)
      }) — Rückfall auf leeren Standard blockiert.`
    );
  }

  function writeJsonAtomic(
    filename: string,
    data: unknown,
    options: WriteJsonOptions = {}
  ): void {
    ensureDirs();
    const cleanFilename = sanitizeStoreFilename(filename);
    const target = getFilePath(cleanFilename);

    let targetExists = false;
    let targetSize = 0;
    try {
      const st = fs.statSync(target);
      targetExists = true;
      targetSize = st.size;
    } catch (err) {
      const code = getErrCode(err);
      if (code !== 'ENOENT') {
        throw new Error(
          `NAS-Datei ${cleanFilename} vorübergehend gesperrt (${code ?? 'IO_ERROR'}) — Schreibvorgang abgebrochen.`
        );
      }
    }

    // Anti-Wipe- / Anti-Shrink-Schutz für bestehende NAS-Stores
    if (PROTECTED_NON_EMPTY_STORES.has(cleanFilename) && (targetExists || hasValidBackup(cleanFilename))) {
      const existingData = targetExists
        ? readValidJsonFromPath<unknown>(target)
        : readValidJsonFromPath<unknown>(getBackupPath(cleanFilename));
      const incomingCount = countJsonStoreRecords(cleanFilename, data);

      if (existingData !== null) {
        const existingCount = countJsonStoreRecords(cleanFilename, existingData);

        if (
          existingCount !== null &&
          incomingCount !== null &&
          existingCount > 0 &&
          incomingCount === 0 &&
          !options.allowEmptyOverwrite
        ) {
          const reason = `Anti-Wipe-Schutz hat komplettes Leeren von ${cleanFilename} (${existingCount} -> 0 Einträge) blockiert.`;
          console.error(`[NAS-SCHUTZ] ${reason}`);
          hooks.onWriteBlocked?.(cleanFilename, reason, existingCount, incomingCount);
          throw new Error(reason);
        }

        if (
          existingCount !== null &&
          incomingCount !== null &&
          existingCount >= 4 &&
          incomingCount / existingCount <= 0.25 &&
          !options.allowShrink
        ) {
          const reason = `Anti-Shrink-Schutz hat massiven Datenverlust in ${cleanFilename} (${existingCount} -> ${incomingCount} Einträge) blockiert.`;
          console.error(`[NAS-SCHUTZ] ${reason}`);
          hooks.onWriteBlocked?.(cleanFilename, reason, existingCount, incomingCount);
          throw new Error(reason);
        }
      } else if (targetExists && targetSize > 0 && incomingCount === 0 && !options.allowEmptyOverwrite) {
        const reason = `Anti-Wipe-Schutz hat Überschreiben einer nicht-leeren Datei ${cleanFilename} (${targetSize} Bytes) mit leeren Daten blockiert.`;
        console.error(`[NAS-SCHUTZ] ${reason}`);
        hooks.onWriteBlocked?.(cleanFilename, reason, 1, 0);
        throw new Error(reason);
      }
    }

    if (!options.skipBackup && targetExists) {
      saveRollingBackupFromTarget(cleanFilename, target);
    }

    const serialized = COMPACT_JSON_FILES.has(cleanFilename)
      ? JSON.stringify(data)
      : JSON.stringify(data, null, 2);

    writeRawAtomic(target, serialized, resolvedDataDir, cleanFilename);

    try {
      const stat = fs.statSync(target);
      jsonFileCache.set(cleanFilename, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        data: structuredClone(data),
      });
    } catch {
      jsonFileCache.delete(cleanFilename);
    }

    hooks.onAfterWrite?.(cleanFilename);
  }

  return {
    ensureDirs,
    getFilePath,
    getBackupPath,
    hasValidBackup,
    isStoreDefinitelyMissing,
    readJsonFile,
    writeJsonAtomic,
  };
}
