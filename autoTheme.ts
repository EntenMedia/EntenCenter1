import {
  AutoThemeConfig,
  AutoThemeDayTarget,
  AutoThemeMode,
  AutoThemeNightTarget,
  DEFAULT_AUTO_THEME_CONFIG,
  ThemePresetId,
} from '../types/marcente';

const DARK_THEME_NIGHT_TARGETS = new Set<AutoThemeNightTarget>([
  'cinema-amber',
  'nordic-cyan',
  'emerald-vault',
  'crimson-premiere',
  'amethyst-studio',
  'silver-glass',
]);

const DAY_THEME_TARGETS = new Set<AutoThemeDayTarget>(['light', 'high-contrast']);

export function isDarkNightPreset(theme: ThemePresetId): theme is AutoThemeNightTarget {
  return DARK_THEME_NIGHT_TARGETS.has(theme as AutoThemeNightTarget);
}

export function sanitizeHHMM(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function normalizeAutoThemeConfig(
  raw?: Partial<AutoThemeConfig> | null,
  fallbackNightTheme?: ThemePresetId
): AutoThemeConfig {
  const mode: AutoThemeMode =
    raw?.mode === 'time' || raw?.mode === 'location' ? raw.mode : 'off';
  const dayTheme: AutoThemeDayTarget =
    raw?.dayTheme && DAY_THEME_TARGETS.has(raw.dayTheme) ? raw.dayTheme : 'light';
  const nightCandidate = raw?.nightTheme ?? fallbackNightTheme;
  const nightTheme: AutoThemeNightTarget =
    nightCandidate && isDarkNightPreset(nightCandidate)
      ? nightCandidate
      : DEFAULT_AUTO_THEME_CONFIG.nightTheme;

  const lat =
    typeof raw?.latitude === 'number' &&
    Number.isFinite(raw.latitude) &&
    raw.latitude >= -90 &&
    raw.latitude <= 90
      ? Math.round(raw.latitude * 10000) / 10000
      : null;
  const lon =
    typeof raw?.longitude === 'number' &&
    Number.isFinite(raw.longitude) &&
    raw.longitude >= -180 &&
    raw.longitude <= 180
      ? Math.round(raw.longitude * 10000) / 10000
      : null;

  return {
    mode,
    dayTheme,
    nightTheme,
    dayStartTime: sanitizeHHMM(raw?.dayStartTime, DEFAULT_AUTO_THEME_CONFIG.dayStartTime),
    nightStartTime: sanitizeHHMM(raw?.nightStartTime, DEFAULT_AUTO_THEME_CONFIG.nightStartTime),
    latitude: lat,
    longitude: lon,
    locationLabel:
      typeof raw?.locationLabel === 'string' && raw.locationLabel.trim().length > 0
        ? raw.locationLabel.trim().slice(0, 100)
        : null,
    lastLocationUpdatedAt:
      typeof raw?.lastLocationUpdatedAt === 'string' && raw.lastLocationUpdatedAt.trim().length > 0
        ? raw.lastLocationUpdatedAt.trim()
        : null,
  };
}

export function parseTimeToMinutes(hhmm: string, fallbackMinutes: number): number {
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallbackMinutes;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallbackMinutes;
  return hh * 60 + mm;
}

export function formatMinutesToHHMM(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(normalized / 60);
  const mm = normalized % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} Uhr`;
}

export interface SolarTimesResult {
  sunriseMinutes: number;
  sunsetMinutes: number;
  sunriseLabel: string;
  sunsetLabel: string;
  polarState: 'normal' | 'polar-day' | 'polar-night';
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Berechnet Sonnenaufgang und Sonnenuntergang nach NOAA-Solaralgorithmus (Zenit 90,833°)
 * in lokalen Minuten ab Mitternacht für das angegebene Datum.
 */
export function computeSolarTimes(
  date: Date,
  latitude: number,
  longitude: number
): SolarTimesResult {
  const year = date.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const currentDay = new Date(year, date.getMonth(), date.getDate());
  const dayOfYear = Math.floor((currentDay.getTime() - startOfYear.getTime()) / 86400000) + 1;

  const lngHour = longitude / 15;
  const calcEventUtcHours = (isSunrise: boolean): number | null => {
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const meanAnomaly = 0.9856 * t - 3.289;
    let sunTrueLong =
      meanAnomaly +
      1.916 * Math.sin(meanAnomaly * DEG_TO_RAD) +
      0.02 * Math.sin(2 * meanAnomaly * DEG_TO_RAD) +
      282.634;
    sunTrueLong = ((sunTrueLong % 360) + 360) % 360;

    let rightAscension = RAD_TO_DEG * Math.atan(0.91764 * Math.tan(sunTrueLong * DEG_TO_RAD));
    rightAscension = ((rightAscension % 360) + 360) % 360;

    const lQuadrant = Math.floor(sunTrueLong / 90) * 90;
    const raQuadrant = Math.floor(rightAscension / 90) * 90;
    rightAscension = (rightAscension + (lQuadrant - raQuadrant)) / 15;

    const sinDec = 0.39782 * Math.sin(sunTrueLong * DEG_TO_RAD);
    const cosDec = Math.cos(Math.asin(sinDec));
    const zenithCos = Math.cos(90.833 * DEG_TO_RAD);
    const cosH =
      (zenithCos - sinDec * Math.sin(latitude * DEG_TO_RAD)) /
      (cosDec * Math.cos(latitude * DEG_TO_RAD));

    if (cosH > 1) return -1; // Polarnacht (keine Sonne)
    if (cosH < -1) return -2; // Polartag (Mitternachtssonne)

    const hourAngleDeg = isSunrise
      ? 360 - RAD_TO_DEG * Math.acos(cosH)
      : RAD_TO_DEG * Math.acos(cosH);
    const hourAngle = hourAngleDeg / 15;

    const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622;
    const utcHours = (((localMeanTime - lngHour) % 24) + 24) % 24;
    return utcHours;
  };

  const riseUtc = calcEventUtcHours(true);
  const setUtc = calcEventUtcHours(false);

  if (riseUtc === -1 || setUtc === -1) {
    return {
      sunriseMinutes: 0,
      sunsetMinutes: 0,
      sunriseLabel: 'Polarnacht',
      sunsetLabel: 'Polarnacht',
      polarState: 'polar-night',
    };
  }
  if (riseUtc === -2 || setUtc === -2) {
    return {
      sunriseMinutes: 0,
      sunsetMinutes: 1440,
      sunriseLabel: 'Polartag',
      sunsetLabel: 'Polartag',
      polarState: 'polar-day',
    };
  }

  const localOffsetHours = -date.getTimezoneOffset() / 60;
  const sunriseMinutes = Math.round((((riseUtc! + localOffsetHours) % 24) + 24) % 24 * 60);
  const sunsetMinutes = Math.round((((setUtc! + localOffsetHours) % 24) + 24) % 24 * 60);

  return {
    sunriseMinutes,
    sunsetMinutes,
    sunriseLabel: formatMinutesToHHMM(sunriseMinutes),
    sunsetLabel: formatMinutesToHHMM(sunsetMinutes),
    polarState: 'normal',
  };
}

export function estimateCoordinatesFromTimezone(): {
  latitude: number;
  longitude: number;
  locationLabel: string;
} {
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  const estimatedLon = Math.max(-180, Math.min(180, Math.round(offsetHours * 15 * 100) / 100));
  const tzName =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'System-Zeitzone'
      : 'System-Zeitzone';
  return {
    latitude: 51.1,
    longitude: estimatedLon,
    locationLabel: `Zeitzonen-Schätzung (${tzName})`,
  };
}

export interface AutoThemeEvaluation {
  isAutoActive: boolean;
  mode: AutoThemeMode;
  phase: 'day' | 'night';
  targetTheme: ThemePresetId;
  source: 'manual' | 'schedule' | 'gps' | 'timezone-fallback';
  reason: string;
  sunriseLabel?: string;
  sunsetLabel?: string;
  nextSwitchLabel?: string;
}

function isWithinDayInterval(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function evaluateAutoTheme(
  rawConfig?: Partial<AutoThemeConfig> | null,
  now: Date = new Date(),
  manualFallbackTheme: ThemePresetId = 'cinema-amber'
): AutoThemeEvaluation {
  const cfg = normalizeAutoThemeConfig(rawConfig, manualFallbackTheme);
  if (cfg.mode === 'off') {
    return {
      isAutoActive: false,
      mode: 'off',
      phase: manualFallbackTheme === 'light' || manualFallbackTheme === 'high-contrast' ? 'day' : 'night',
      targetTheme: manualFallbackTheme,
      source: 'manual',
      reason: 'Manuelle Theme-Auswahl aktiv.',
    };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (cfg.mode === 'time') {
    const dayStart = parseTimeToMinutes(cfg.dayStartTime, 7 * 60);
    const nightStart = parseTimeToMinutes(cfg.nightStartTime, 19 * 60);
    const isDay = isWithinDayInterval(nowMinutes, dayStart, nightStart);
    const phase: 'day' | 'night' = isDay ? 'day' : 'night';
    const targetTheme = isDay ? cfg.dayTheme : cfg.nightTheme;
    const nextSwitchMinutes = isDay ? nightStart : dayStart;
    return {
      isAutoActive: true,
      mode: 'time',
      phase,
      targetTheme,
      source: 'schedule',
      reason: isDay
        ? `Systemzeit (${cfg.dayStartTime}–${cfg.nightStartTime} Uhr): Tagphase aktiv.`
        : `Systemzeit (${cfg.nightStartTime}–${cfg.dayStartTime} Uhr): Nachtphase aktiv.`,
      nextSwitchLabel: formatMinutesToHHMM(nextSwitchMinutes),
    };
  }

  const hasDeviceCoords =
    typeof cfg.latitude === 'number' &&
    typeof cfg.longitude === 'number' &&
    Number.isFinite(cfg.latitude) &&
    Number.isFinite(cfg.longitude);

  const fallbackCoords = estimateCoordinatesFromTimezone();
  const lat = hasDeviceCoords ? cfg.latitude! : fallbackCoords.latitude;
  const lon = hasDeviceCoords ? cfg.longitude! : fallbackCoords.longitude;
  const solar = computeSolarTimes(now, lat, lon);

  let isDay: boolean;
  if (solar.polarState === 'polar-day') {
    isDay = true;
  } else if (solar.polarState === 'polar-night') {
    isDay = false;
  } else {
    isDay = isWithinDayInterval(nowMinutes, solar.sunriseMinutes, solar.sunsetMinutes);
  }

  const phase: 'day' | 'night' = isDay ? 'day' : 'night';
  const targetTheme = isDay ? cfg.dayTheme : cfg.nightTheme;
  const nextSwitchLabel =
    solar.polarState === 'normal'
      ? isDay
        ? solar.sunsetLabel
        : solar.sunriseLabel
      : undefined;

  return {
    isAutoActive: true,
    mode: 'location',
    phase,
    targetTheme,
    source: hasDeviceCoords ? 'gps' : 'timezone-fallback',
    sunriseLabel: solar.sunriseLabel,
    sunsetLabel: solar.sunsetLabel,
    nextSwitchLabel,
    reason: hasDeviceCoords
      ? isDay
        ? `Standort (${cfg.locationLabel || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`}): Tageslicht bis ${solar.sunsetLabel}.`
        : `Standort (${cfg.locationLabel || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`}): Nach Sonnenuntergang aktiv bis ${solar.sunriseLabel}.`
      : isDay
        ? `Standort-Fallback über Zeitzone: Tageslicht bis ca. ${solar.sunsetLabel}.`
        : `Standort-Fallback über Zeitzone: Nachtphase bis ca. ${solar.sunriseLabel}.`,
  };
}

export interface DeviceLocationResult {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  locationLabel: string;
}

export async function requestDeviceCoordinates(): Promise<DeviceLocationResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error(
      'Dieses Gerät oder dieser Browser unterstützt keine Standortabfrage (Geolocation API).'
    );
  }

  return new Promise<DeviceLocationResult>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Math.round(position.coords.latitude * 10000) / 10000;
        const lon = Math.round(position.coords.longitude * 10000) / 10000;
        const accuracyMeters =
          typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy)
            ? Math.round(position.coords.accuracy)
            : null;
        resolve({
          latitude: lat,
          longitude: lon,
          accuracyMeters,
          locationLabel: `Gerätestandort (${lat.toFixed(2)}° N/S, ${lon.toFixed(2)}° O/W)`,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new Error(
              'Standortzugriff wurde verweigert. Bitte erlaube den Standort in den Geräte-/Browser-Einstellungen oder nutze den Zeitzonen-Fallback.'
            )
          );
          return;
        }
        if (err.code === err.TIMEOUT) {
          reject(
            new Error(
              'Zeitüberschreitung beim Abrufen der GPS-/Netzwerkposition. Bitte erneut versuchen.'
            )
          );
          return;
        }
        reject(
          new Error(
            'Aktueller Gerätestandort konnte nicht ermittelt werden. Zeitzonen-Fallback bleibt aktiv.'
          )
        );
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 600000,
      }
    );
  });
}
