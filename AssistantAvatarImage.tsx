import React, { useEffect, useState } from 'react';
import {
  DEFAULT_ASSISTANT_AVATAR_URL,
  MARCENTE_ASSETS,
  resolveAssistantAvatarSrc,
} from '../data/coverAssets';
import { resolveNasUrl } from '../lib/nasClient';

interface AssistantAvatarImageProps {
  src?: string | null;
  alt: string;
  className?: string;
  sizePx?: number;
}

type FallbackStep = 'primary' | 'default' | 'public' | 'mascot' | 'svg';

export const AssistantAvatarImage: React.FC<AssistantAvatarImageProps> = ({
  src,
  alt,
  className = 'w-12 h-12 rounded-xl object-cover border border-amber-400/40 shrink-0',
  sizePx = 48,
}) => {
  const resolvedNormalized = resolveAssistantAvatarSrc(src);
  const primaryUrl =
    resolvedNormalized.startsWith('/uploads/') || resolvedNormalized.startsWith('/api/')
      ? resolveNasUrl(resolvedNormalized)
      : resolvedNormalized;

  const [step, setStep] = useState<FallbackStep>('primary');

  useEffect(() => {
    setStep('primary');
  }, [primaryUrl]);

  const currentSrc =
    step === 'primary'
      ? primaryUrl
      : step === 'default'
        ? DEFAULT_ASSISTANT_AVATAR_URL
        : step === 'public'
          ? '/assets/assistant_duck_avatar.jpg'
          : step === 'mascot'
            ? MARCENTE_ASSETS.duckMascot
            : '';

  if (step === 'svg' || !currentSrc) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`${className} bg-[#0B0E14] flex items-center justify-center text-amber-400`}
      >
        <svg
          viewBox="0 0 36 36"
          className="w-7 h-7"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="18" cy="18" r="15" fill="#F59E0B" fillOpacity="0.16" />
          <path
            d="M12 19.5c0-4 2.7-7 6.5-7 3.1 0 5.5 2.1 5.5 5 0 .6-.1 1.2-.3 1.7l2.8 1.2c.5.2.5.9 0 1.2l-2.6 1.2c-.8 2.2-2.9 3.7-5.9 3.7-3.6 0-6-2.7-6-7z"
            fill="#FBBF24"
          />
          <circle cx="19.5" cy="16.5" r="1.3" fill="#0B0E14" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      width={sizePx}
      height={sizePx}
      loading="eager"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setStep((prev) => {
          if (prev === 'primary') {
            return primaryUrl === DEFAULT_ASSISTANT_AVATAR_URL ? 'public' : 'default';
          }
          if (prev === 'default') return 'public';
          if (prev === 'public') return 'mascot';
          return 'svg';
        });
      }}
      className={`${className} bg-[#0B0E14]`}
    />
  );
};
