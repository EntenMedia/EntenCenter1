export type StreamingProviderDE =
  | 'Netflix'
  | 'Prime Video'
  | 'Disney+'
  | 'Apple TV+'
  | 'Paramount+'
  | 'WOW'
  | 'RTL+'
  | 'Joyn'
  | 'Crunchyroll'
  | 'MagentaTV'
  | 'DAZN'
  | 'ARD Mediathek'
  | 'ZDF Mediathek'
  | 'ARTE Mediathek'
  | '3sat Mediathek'
  | 'Das Erste'
  | 'ZDF'
  | 'ARTE'
  | 'RTL'
  | 'VOX'
  | 'ProSieben'
  | 'SAT.1'
  | 'Kabel Eins'
  | 'SIXX'
  | 'TELE 5'
  | 'Sky'
  | 'Sky Atlantic'
  | 'Sky One'
  | 'Sky Krimi'
  | 'Warner TV Serie'
  | '13th Street'
  | 'SYFY'
  | 'Universal TV';

export interface GermanProviderGroup {
  label: string;
  providers: StreamingProviderDE[];
}

export const GERMAN_PROVIDER_GROUPS: GermanProviderGroup[] = [
  {
    label: 'Streaming-Dienste',
    providers: [
      'Netflix',
      'Prime Video',
      'Disney+',
      'Apple TV+',
      'Paramount+',
      'WOW',
      'RTL+',
      'Joyn',
      'Crunchyroll',
      'MagentaTV',
      'DAZN',
    ],
  },
  {
    label: 'Mediatheken',
    providers: ['ARD Mediathek', 'ZDF Mediathek', 'ARTE Mediathek', '3sat Mediathek'],
  },
  {
    label: 'Free-TV (DE)',
    providers: [
      'Das Erste',
      'ZDF',
      'ARTE',
      'RTL',
      'VOX',
      'ProSieben',
      'SAT.1',
      'Kabel Eins',
      'SIXX',
      'TELE 5',
    ],
  },
  {
    label: 'Pay-TV (DE)',
    providers: [
      'Sky',
      'Sky Atlantic',
      'Sky One',
      'Sky Krimi',
      'Warner TV Serie',
      '13th Street',
      'SYFY',
      'Universal TV',
    ],
  },
];

export const GERMAN_ALL_PROVIDERS: StreamingProviderDE[] = GERMAN_PROVIDER_GROUPS.flatMap(
  (g) => g.providers
);

export function mapNetworkToGermanProvider(
  networkName?: string | null,
  isWebChannel = false
): StreamingProviderDE {
  const raw = (networkName || '').trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return isWebChannel ? 'Netflix' : 'ZDF';
  }

  const exact = GERMAN_ALL_PROVIDERS.find((p) => p.toLowerCase() === lower);
  if (exact) return exact;

  if (lower.includes('netflix')) return 'Netflix';
  if (lower.includes('amazon') || lower.includes('prime')) return 'Prime Video';
  if (lower.includes('disney')) return 'Disney+';
  if (lower.includes('apple')) return 'Apple TV+';
  if (lower.includes('paramount')) return 'Paramount+';
  if (lower.includes('crunchyroll')) return 'Crunchyroll';
  if (lower.includes('magenta')) return 'MagentaTV';
  if (lower.includes('dazn')) return 'DAZN';
  if (lower.includes('joyn')) return 'Joyn';
  if (lower.includes('rtl+') || lower.includes('rtl plus') || lower.includes('tvnow')) return 'RTL+';
  if (lower.includes('wow') || lower.includes('sky ticket')) return 'WOW';
  if (lower.includes('sky atlantic')) return 'Sky Atlantic';
  if (lower.includes('sky one')) return 'Sky One';
  if (lower.includes('sky krimi')) return 'Sky Krimi';
  if (lower.includes('sky')) return 'Sky';
  if (lower.includes('warner')) return 'Warner TV Serie';
  if (lower.includes('13th')) return '13th Street';
  if (lower.includes('syfy')) return 'SYFY';
  if (lower.includes('universal')) return 'Universal TV';
  if (lower.includes('ard') && lower.includes('mediathek')) return 'ARD Mediathek';
  if (lower.includes('zdf') && lower.includes('mediathek')) return 'ZDF Mediathek';
  if (lower.includes('arte') && lower.includes('mediathek')) return 'ARTE Mediathek';
  if (lower.includes('3sat')) return '3sat Mediathek';
  if (lower.includes('das erste') || lower === 'ard') return 'Das Erste';
  if (lower === 'zdf' || lower.includes('zdfneo')) return 'ZDF';
  if (lower.includes('arte')) return 'ARTE';
  if (lower.includes('prosieben') || lower.includes('pro7')) return 'ProSieben';
  if (lower.includes('sat.1') || lower.includes('sat1')) return 'SAT.1';
  if (lower.includes('kabel')) return 'Kabel Eins';
  if (lower.includes('sixx')) return 'SIXX';
  if (lower.includes('tele 5') || lower.includes('tele5')) return 'TELE 5';
  if (lower.includes('vox')) return 'VOX';
  if (lower.includes('rtl')) return 'RTL';

  if (lower.includes('hbo') || lower.includes('max')) return 'WOW';
  if (lower.includes('hulu') || lower.includes('fx')) return 'Disney+';
  if (lower.includes('showtime') || lower.includes('cbs')) return 'Paramount+';

  return isWebChannel ? 'Netflix' : 'Prime Video';
}
