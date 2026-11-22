export const DEFAULT_ASSISTANT_AVATAR_URL = '/assets/assistant_duck_avatar.jpg';

export const MARCENTE_ASSETS = {
  duckMascot: '/assets/marcente_duck_mascot_1794527516120.jpg',
  assistantDuckAvatar: '/assets/assistant_duck_avatar.jpg',
  posterDarkMatter: '/assets/poster_dark_matter_1794527516073.jpg',
  posterNordicCrime: '/assets/poster_nordic_crime_1794527516622.jpg',
  posterCyberBerlin: '/assets/poster_cyber_berlin_1794527516776.jpg',
  posterAlpineDoc: '/assets/poster_alpine_doc_1794527516517.jpg',
  coverNasBilder: '/assets/cover_nas_bilder_1794644219299.jpg',
  coverNasMusik: '/assets/cover_nas_musik_1794644219223.jpg',
  coverNasVideo: '/assets/cover_nas_video_1794644220724.jpg',
  coverNasSonstiges: '/assets/cover_nas_sonstiges_1794644220792.jpg',
  stillElbe: '/assets/still_elbe_harbor_1794572326134.jpg',
  stillFrankfurt: '/assets/still_frankfurt_datacenter_1794572325110.jpg',
  stillGrenzgrat: '/assets/still_grenzgrat_glacier_1794572325959.jpg',
  stillNordsee: '/assets/still_nordsee_lighthouse_1794572324833.jpg',
  stillSchattenwald: '/assets/still_schattenwald_forest_1794572323679.jpg',
} as const;

export type MarcenteAssetKey = keyof typeof MARCENTE_ASSETS;

export function resolveAssistantAvatarSrc(raw?: string | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return DEFAULT_ASSISTANT_AVATAR_URL;
  }
  return trimmed;
}

