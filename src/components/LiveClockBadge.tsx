import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

interface LiveClockBadgeProps {
  variant?: 'header' | 'player';
  sizeMode?: 'tv' | 'mobile' | 'default';
  remainingSeconds?: number | null;
  className?: string;
}

export const LiveClockBadge: React.FC<LiveClockBadgeProps> = React.memo(({
  variant = 'header',
  sizeMode = 'default',
  remainingSeconds = null,
  className = '',
}) => {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const tickMs = variant === 'player' && sizeMode === 'mobile' ? 15000 : 1000;
    let intervalId: number | null = null;

    const startClock = () => {
      if (intervalId !== null || document.visibilityState === 'hidden') return;
      setNow(new Date());
      intervalId = window.setInterval(() => {
        setNow(new Date());
      }, tickMs);
    };

    const stopClock = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopClock();
      } else {
        startClock();
      }
    };

    startClock();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopClock();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [variant, sizeMode]);

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const fullDateLabel = now.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeText = `${hours}:${minutes}:${seconds}`;

  const endTimeText =
    typeof remainingSeconds === 'number' && Number.isFinite(remainingSeconds) && remainingSeconds >= 0
      ? (() => {
          const endDate = new Date(now.getTime() + remainingSeconds * 1000);
          return `${String(endDate.getHours()).padStart(2, '0')}:${String(
            endDate.getMinutes()
          ).padStart(2, '0')}`;
        })()
      : null;

  if (variant === 'player') {
    const sizeClasses =
      sizeMode === 'tv'
        ? 'min-h-[52px] px-4 py-2 text-sm gap-2'
        : sizeMode === 'mobile'
          ? 'min-h-[44px] px-2.5 py-2 text-xs gap-1.5'
          : 'min-h-[40px] px-3 py-2 text-xs gap-1.5';

    const iconSize =
      sizeMode === 'tv' ? 'w-5 h-5' : sizeMode === 'mobile' ? 'w-3.5 h-3.5' : 'w-4 h-4';

    return (
      <time
        dateTime={now.toISOString()}
        title={
          endTimeText
            ? `${fullDateLabel} · ${timeText} Uhr · Ende ca. ${endTimeText} Uhr`
            : `${fullDateLabel} · ${timeText} Uhr`
        }
        aria-label={
          endTimeText
            ? `Aktuelle Uhrzeit: ${hours}:${minutes} Uhr, Ende voraussichtlich um ${endTimeText} Uhr`
            : `Aktuelle Uhrzeit: ${hours}:${minutes} Uhr`
        }
        className={`${sizeClasses} rounded-xl bg-black/70 border border-slate-700/90 text-slate-100 font-medium flex items-center justify-center whitespace-nowrap shrink-0 ${className}`}
      >
        <Clock className={`${iconSize} text-amber-400 shrink-0`} />
        <span className="font-mono tabular-nums font-semibold tracking-tight">
          {hours}:{minutes}
          {sizeMode !== 'mobile' && (
            <span className="text-slate-400 font-normal">:{seconds}</span>
          )}
        </span>
        {sizeMode === 'tv' ? (
          <span className="text-slate-300 text-xs">Uhr</span>
        ) : sizeMode !== 'mobile' ? (
          <span className="hidden sm:inline text-slate-400">Uhr</span>
        ) : null}
        {endTimeText && (
          <span className="font-mono tabular-nums text-amber-300 font-semibold border-l border-slate-700 pl-2 ml-0.5">
            bis {endTimeText}
            {sizeMode !== 'mobile' && (
              <span className="hidden sm:inline font-sans font-normal text-amber-200/80"> Uhr</span>
            )}
          </span>
        )}
      </time>
    );
  }

  return (
    <time
      dateTime={now.toISOString()}
      title={`${fullDateLabel} · ${timeText} Uhr`}
      aria-label={`Aktuelle Uhrzeit: ${hours}:${minutes} Uhr`}
      className={`px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs font-medium text-slate-200 flex items-center gap-2 whitespace-nowrap shrink-0 ${className}`}
    >
      <Clock className="w-4 h-4 text-amber-400 shrink-0" />
      <span className="font-mono tabular-nums font-semibold tracking-tight">
        {hours}:{minutes}
        <span className="hidden sm:inline text-slate-400 font-normal">:{seconds}</span>
      </span>
      <span className="hidden md:inline text-slate-400">Uhr</span>
    </time>
  );
});
