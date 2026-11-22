import { useEffect, useState } from 'react';

export type DeviceFormFactor = 'tablet' | 'phone' | 'desktop';
export type DisplayOrientation = 'portrait' | 'landscape';

export interface DisplayInsetsSnapshot {
  deviceForm: DeviceFormFactor;
  orientation: DisplayOrientation;
  viewportWidth: number;
  viewportHeight: number;
  isCompactHeight: boolean;
  isNarrowWidth: boolean;
  isNativeAndroid: boolean;
  isTouch: boolean;
  nativeContainerPadded: boolean;
  topInsetDp: number;
  bottomInsetDp: number;
  leftInsetDp: number;
  rightInsetDp: number;
}

interface NativeInsetsPayload {
  isNativeApp?: boolean;
  isTablet?: boolean;
  isTouch?: boolean;
  nativeContainerPadded?: boolean;
  topInsetDp?: number;
  bottomInsetDp?: number;
  leftInsetDp?: number;
  rightInsetDp?: number;
}

interface NativeBridgeWindow extends Window {
  __entencenterNativeInsets?: NativeInsetsPayload;
  EntenCenterAndroid?: {
    isNativeApp?: () => boolean;
    getDisplayInsetsInfo?: () => string;
  };
}

function readNativeInsetsPayload(): NativeInsetsPayload | null {
  if (typeof window === 'undefined') return null;
  const win = window as NativeBridgeWindow;
  if (win.__entencenterNativeInsets) {
    return win.__entencenterNativeInsets;
  }
  try {
    const raw = win.EntenCenterAndroid?.getDisplayInsetsInfo?.();
    if (raw) {
      const parsed = JSON.parse(raw) as NativeInsetsPayload;
      win.__entencenterNativeInsets = parsed;
      return parsed;
    }
  } catch {
    // Fallback to browser detection
  }
  return null;
}

export function detectDisplayInsetsSnapshot(): DisplayInsetsSnapshot {
  if (typeof window === 'undefined') {
    return {
      deviceForm: 'desktop',
      orientation: 'landscape',
      viewportWidth: 1280,
      viewportHeight: 800,
      isCompactHeight: false,
      isNarrowWidth: false,
      isNativeAndroid: false,
      isTouch: false,
      nativeContainerPadded: false,
      topInsetDp: 0,
      bottomInsetDp: 0,
      leftInsetDp: 0,
      rightInsetDp: 0,
    };
  }

  const vw = Math.max(0, Math.round(window.innerWidth || document.documentElement?.clientWidth || 0));
  const vh = Math.max(0, Math.round(window.innerHeight || document.documentElement?.clientHeight || 0));
  const orientation: DisplayOrientation = vw >= vh ? 'landscape' : 'portrait';
  const isCompactHeight = vh > 0 && vh < 620;
  const isNarrowWidth = vw > 0 && vw < 640;

  const isNativeAndroid = Boolean((window as NativeBridgeWindow).EntenCenterAndroid?.isNativeApp?.());
  const nativePayload = readNativeInsetsPayload();
  const nativeContainerPadded = Boolean(nativePayload?.nativeContainerPadded);

  const coarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
  const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const isTouch =
    Boolean(nativePayload?.isTouch) ||
    isNativeAndroid ||
    coarsePointer ||
    maxTouchPoints > 0 ||
    /android|iphone|ipad|ipod|tablet|mobile/i.test(ua);

  const shortSide = Math.min(vw, vh);
  const isTabletHint =
    Boolean(nativePayload?.isTablet) ||
    /ipad|tablet|sm-t|xiaomi\s*pad|redmi\s*pad|mi\s*pad/i.test(ua) ||
    (/android/i.test(ua) && !/mobile/i.test(ua));

  let deviceForm: DeviceFormFactor = 'desktop';
  if (isTabletHint || (isTouch && shortSide >= 600)) {
    deviceForm = 'tablet';
  } else if (isTouch || isNativeAndroid || (vw > 0 && vw < 768)) {
    deviceForm = 'phone';
  }

  return {
    deviceForm,
    orientation,
    viewportWidth: vw,
    viewportHeight: vh,
    isCompactHeight,
    isNarrowWidth,
    isNativeAndroid,
    isTouch,
    nativeContainerPadded,
    topInsetDp: Number(nativePayload?.topInsetDp ?? 0) || 0,
    bottomInsetDp: Number(nativePayload?.bottomInsetDp ?? 0) || 0,
    leftInsetDp: Number(nativePayload?.leftInsetDp ?? 0) || 0,
    rightInsetDp: Number(nativePayload?.rightInsetDp ?? 0) || 0,
  };
}

export function applyDeviceDisplayCssVars(): DisplayInsetsSnapshot {
  const snapshot = detectDisplayInsetsSnapshot();
  if (typeof document === 'undefined') return snapshot;

  const root = document.documentElement;
  root.dataset.deviceForm = snapshot.deviceForm;
  root.dataset.orientation = snapshot.orientation;
  root.dataset.compactHeight = snapshot.isCompactHeight ? 'true' : 'false';
  root.dataset.nativeShell = snapshot.isNativeAndroid ? 'android' : 'web';

  const isHandheldOrTablet = snapshot.deviceForm === 'tablet' || snapshot.deviceForm === 'phone';
  const safeEnvActive = isHandheldOrTablet && !snapshot.nativeContainerPadded;

  root.style.setProperty('--app-vw', `${snapshot.viewportWidth}px`);
  root.style.setProperty('--app-vh', `${snapshot.viewportHeight}px`);
  root.style.setProperty(
    '--app-safe-top',
    safeEnvActive ? 'env(safe-area-inset-top, 0px)' : '0px'
  );
  root.style.setProperty(
    '--app-safe-bottom',
    safeEnvActive ? 'env(safe-area-inset-bottom, 0px)' : '0px'
  );
  root.style.setProperty(
    '--app-safe-left',
    safeEnvActive ? 'env(safe-area-inset-left, 0px)' : '0px'
  );
  root.style.setProperty(
    '--app-safe-right',
    safeEnvActive ? 'env(safe-area-inset-right, 0px)' : '0px'
  );

  // Zusätzlicher Abstand oben & unten für Tablet & Smartphone, damit Header & Modals
  // in Hoch- und Querformat nie von Statusleisten oder Navigationsleisten verdeckt werden.
  const headerOffset =
    snapshot.deviceForm === 'tablet'
      ? snapshot.isCompactHeight
        ? '10px'
        : '16px'
      : snapshot.deviceForm === 'phone'
        ? snapshot.isCompactHeight
          ? '8px'
          : '12px'
        : '0px';
  const bottomClearance =
    snapshot.deviceForm === 'tablet'
      ? snapshot.isCompactHeight
        ? '14px'
        : '24px'
      : snapshot.deviceForm === 'phone'
        ? snapshot.isCompactHeight
          ? '12px'
          : '18px'
        : '0px';
  root.style.setProperty('--app-header-offset', headerOffset);
  root.style.setProperty('--app-bottom-clearance', bottomClearance);

  return snapshot;
}

export function initDeviceDisplayListener(
  onUpdate?: (snapshot: DisplayInsetsSnapshot) => void
): () => void {
  let rafId = 0;
  const sync = () => {
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      const snap = applyDeviceDisplayCssVars();
      onUpdate?.(snap);
    });
  };

  const initial = applyDeviceDisplayCssVars();
  onUpdate?.(initial);

  const onNativeInsets = () => sync();
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', sync, { passive: true });
  window.addEventListener('entencenter-native-insets', onNativeInsets);

  const mq = window.matchMedia?.('(pointer: coarse)');
  if (mq?.addEventListener) {
    mq.addEventListener('change', sync);
  }

  return () => {
    if (rafId) window.cancelAnimationFrame(rafId);
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    window.removeEventListener('entencenter-native-insets', onNativeInsets);
    if (mq?.removeEventListener) {
      mq.removeEventListener('change', sync);
    }
  };
}

export function useDeviceDisplay(): DisplayInsetsSnapshot {
  const [snapshot, setSnapshot] = useState<DisplayInsetsSnapshot>(() =>
    detectDisplayInsetsSnapshot()
  );

  useEffect(() => {
    return initDeviceDisplayListener((next) => {
      setSnapshot((prev) => {
        if (
          prev.deviceForm === next.deviceForm &&
          prev.orientation === next.orientation &&
          prev.viewportWidth === next.viewportWidth &&
          prev.viewportHeight === next.viewportHeight &&
          prev.isCompactHeight === next.isCompactHeight &&
          prev.isNarrowWidth === next.isNarrowWidth &&
          prev.isNativeAndroid === next.isNativeAndroid
        ) {
          return prev;
        }
        return next;
      });
    });
  }, []);

  return snapshot;
}
