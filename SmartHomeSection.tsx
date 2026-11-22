import React, { useCallback, useEffect, useState } from 'react';
import { getEffectiveNasOrigin } from '../lib/nasClient';
import { isLocalFallbackToken } from '../lib/localBufferStore';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  Home,
  Mic,
  Minus,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  NasMediaItem,
  NasUser,
  SmartHomeRemoteState,
  SmartHomeSnapshot,
  SmartHomeSource,
} from '../types/marcente';

interface SmartHomeSectionProps {
  user: NasUser;
  token: string;
  isOpen: boolean;
  onToggleOpen: () => void;
  libraryItems: NasMediaItem[];
  liveRemoteState?: SmartHomeRemoteState | null;
  onRemoteStateChange?: (next: SmartHomeRemoteState) => void;
}

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const VOLUME_PRESETS = [25, 50, 75, 100] as const;

function formatSpeedLabel(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return `${Number.isInteger(rounded) ? `${rounded}.0` : rounded}x`;
}

const SOURCE_LABELS: Record<SmartHomeSource, string> = {
  google_home: 'Google Home',
  alexa: 'Amazon Alexa',
  home_assistant: 'Home Assistant',
  app: 'EntenCenter App',
};

export const SmartHomeSection: React.FC<SmartHomeSectionProps> = ({
  user,
  token,
  isOpen,
  onToggleOpen,
  libraryItems,
  liveRemoteState,
  onRemoteStateChange,
}) => {
  const [snapshot, setSnapshot] = useState<SmartHomeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [googleEnabled, setGoogleEnabled] = useState(true);
  const [alexaEnabled, setAlexaEnabled] = useState(true);
  const [deviceName, setDeviceName] = useState('EntenCenter NAS Player');
  const [roomName, setRoomName] = useState('Wohnzimmer');
  const [invocationName, setInvocationName] = useState('entencenter');

  const [fullWebhookToken, setFullWebhookToken] = useState<string | null>(null);
  const [showWebhookToken, setShowWebhookToken] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [voiceMediaQuery, setVoiceMediaQuery] = useState<string>(
    libraryItems[0]?.title ?? ''
  );

  const isAdmin = user.role === 'admin';
  const originUrl = getEffectiveNasOrigin();
  const googleEndpointUrl = `${originUrl}/api/smarthome/google`;
  const alexaEndpointUrl = `${originUrl}/api/smarthome/alexa`;

  const applySnapshot = useCallback((data: SmartHomeSnapshot) => {
    setSnapshot(data);
    setGoogleEnabled(data.config.googleHomeEnabled);
    setAlexaEnabled(data.config.alexaEnabled);
    setDeviceName(data.config.deviceName);
    setRoomName(data.config.roomName);
    setInvocationName(data.config.alexaInvocationName);
  }, []);

  const loadSmartHome = useCallback(async () => {
    if (isLocalFallbackToken(token)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/nas/smarthome', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as SmartHomeSnapshot;
        applySnapshot(data);
      }
    } catch {
      // Netzwerkfehler still tolerieren
    } finally {
      setLoading(false);
    }
  }, [token, applySnapshot]);

  useEffect(() => {
    void loadSmartHome();
  }, [loadSmartHome]);

  useEffect(() => {
    if (!voiceMediaQuery && libraryItems[0]?.title) {
      setVoiceMediaQuery(libraryItems[0].title);
    }
  }, [libraryItems, voiceMediaQuery]);

  // Wenn via WebSocket ein neuer Smart-Home-Befehl eintrifft, Logliste und Status synchron halten
  useEffect(() => {
    if (liveRemoteState?.commandSeq) {
      void loadSmartHome();
    }
  }, [liveRemoteState?.commandSeq, loadSmartHome]);

  const effectiveState = liveRemoteState ?? snapshot?.remoteState ?? null;
  const syncedVolume = effectiveState?.volume ?? 70;
  const syncedMuted = effectiveState?.muted ?? false;
  const syncedSpeed = effectiveState?.playbackRate ?? 1;

  const [draftVolume, setDraftVolume] = useState<number>(syncedVolume);
  const [draftSpeed, setDraftSpeed] = useState<number>(syncedSpeed);

  useEffect(() => {
    setDraftVolume(syncedVolume);
  }, [syncedVolume]);

  useEffect(() => {
    setDraftSpeed(syncedSpeed);
  }, [syncedSpeed]);

  const sendAppSmartHomeCommand = async (
    commandKey: string,
    payload: Record<string, unknown>,
    successLabel?: string
  ) => {
    if (isLocalFallbackToken(token)) {
      setNotice('Smart-Home-Steuerung im Storage-Bridge-Modus lokal vorgemerkt (erfordert optionalen :3000-Server).');
      return;
    }
    setTesting(commandKey);
    setError(null);
    if (successLabel) setNotice(null);
    try {
      const res = await fetch('/api/nas/smarthome/command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ source: 'app', ...payload }),
      });
      const data = (await res.json()) as SmartHomeSnapshot & { error?: string };
      if (!res.ok) {
        setError(data.error || 'Smart-Home-Befehl konnte nicht ausgeführt werden.');
        return;
      }
      if (data.config && data.remoteState) {
        applySnapshot(data);
        onRemoteStateChange?.(data.remoteState);
      }
      if (successLabel) {
        setNotice(successLabel);
      }
    } catch {
      setError('Smart-Home-Steuerung über das NAS fehlgeschlagen.');
    } finally {
      setTesting(null);
    }
  };

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 2000);
    } catch {
      setError('Kopieren in die Zwischenablage wurde vom Browser blockiert.');
    }
  };

  const handleRevealToken = async () => {
    if (!isAdmin) return;
    if (showWebhookToken && fullWebhookToken) {
      setShowWebhookToken(false);
      return;
    }
    if (fullWebhookToken) {
      setShowWebhookToken(true);
      return;
    }
    try {
      const res = await fetch('/api/nas/smarthome/token', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { webhookToken: string };
        setFullWebhookToken(data.webhookToken);
        setShowWebhookToken(true);
      }
    } catch {
      setError('Webhook-Token konnte nicht geladen werden.');
    }
  };

  const handleRotateToken = async () => {
    if (!isAdmin) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/nas/smarthome/rotate-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        webhookToken?: string;
        snapshot?: SmartHomeSnapshot;
        error?: string;
      };
      if (!res.ok || !data.webhookToken || !data.snapshot) {
        setError(data.error || 'Token konnte nicht erneuert werden.');
        return;
      }
      setFullWebhookToken(data.webhookToken);
      setShowWebhookToken(true);
      applySnapshot(data.snapshot);
      setNotice('Neuer Smart-Home Bearer-Token generiert. Bitte in Google Home / Alexa aktualisieren.');
    } catch {
      setError('Verbindung zum NAS beim Token-Wechsel fehlgeschlagen.');
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (isLocalFallbackToken(token)) {
      setNotice('Smart-Home-Gerätenamen für Storage-Bridge lokal übernommen.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/nas/smarthome/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          googleHomeEnabled: googleEnabled,
          alexaEnabled,
          deviceName: deviceName.trim() || 'EntenCenter NAS Player',
          roomName: roomName.trim() || 'Wohnzimmer',
          alexaInvocationName: invocationName.trim() || 'entencenter',
        }),
      });
      const data = (await res.json()) as { snapshot?: SmartHomeSnapshot; error?: string };
      if (!res.ok || !data.snapshot) {
        setError(data.error || 'Smart-Home-Einstellungen konnten nicht gespeichert werden.');
        return;
      }
      applySnapshot(data.snapshot);
      setNotice('Smart-Home-Konfiguration (Google Home & Amazon Alexa) auf dem NAS gespeichert.');
    } catch {
      setError('Verbindung zum NAS fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  const runGoogleFulfillmentTest = async (
    testId: string,
    bodyPayload: Record<string, unknown>,
    successLabel: string
  ) => {
    setTesting(testId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/smarthome/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyPayload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || 'Google Home Testbefehl fehlgeschlagen.');
        return;
      }
      setNotice(successLabel);
      await loadSmartHome();
    } catch {
      setError('Google Home Fulfillment-Endpunkt nicht erreichbar.');
    } finally {
      setTesting(null);
    }
  };

  const runAlexaDirectiveTest = async (
    testId: string,
    directive: Record<string, unknown>,
    successLabel: string
  ) => {
    setTesting(testId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/smarthome/alexa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ directive }),
      });
      const data = (await res.json()) as { event?: { payload?: { message?: string } } };
      if (!res.ok) {
        setError(
          data.event?.payload?.message || 'Amazon Alexa Test-Direktive fehlgeschlagen.'
        );
        return;
      }
      setNotice(successLabel);
      await loadSmartHome();
    } catch {
      setError('Amazon Alexa Skill-Endpunkt nicht erreichbar.');
    } finally {
      setTesting(null);
    }
  };

  const homeAssistantYaml = `rest_command:
  entencenter_google_pause:
    url: "${googleEndpointUrl}"
    method: POST
    headers:
      authorization: "Bearer ${fullWebhookToken || '<DEIN_SMARTHOME_TOKEN>'}"
      content-type: "application/json"
    payload: '{"requestId":"ha-pause","inputs":[{"intent":"action.devices.EXECUTE","payload":{"commands":[{"devices":[{"id":"entencenter-nas-player"}],"execution":[{"command":"action.devices.commands.mediaPause"}]}]}}]}'
  entencenter_alexa_play_title:
    url: "${alexaEndpointUrl}"
    method: POST
    headers:
      authorization: "Bearer ${fullWebhookToken || '<DEIN_SMARTHOME_TOKEN>'}"
      content-type: "application/json"
    payload: '{"directive":{"header":{"namespace":"Alexa.RemoteVideoPlayer","name":"SearchAndPlay","messageId":"ha-play","payloadVersion":"3"},"endpoint":{"endpointId":"entencenter-nas-player"},"payload":{"entities":[{"type":"Video","value":"${voiceMediaQuery || 'Nachtlinie Berlin'}"}]}}}'`;

  return (
    <section className="bg-[#121722] border border-slate-800/80 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className="w-full px-6 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-800/25 transition-colors"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-[#0B0E14] border border-slate-800 text-amber-400 flex items-center justify-center shrink-0">
            <Home className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="font-display text-sm sm:text-base font-semibold text-white truncate">
              Smart Home (Google Home &amp; Amazon Alexa)
            </h3>
            <p className="text-xs text-slate-400 truncate mt-0.5">
              Google Home: {googleEnabled ? 'Aktiv' : 'Aus'} · Amazon Alexa:{' '}
              {alexaEnabled ? 'Aktiv' : 'Aus'} · Gerät: {deviceName} ({roomName})
            </p>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-amber-400' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="px-6 pb-6 pt-4 border-t border-slate-800/80 space-y-5">
          {/* Live-Statusleiste */}
          <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-xs">
            <div>
              <p className="text-slate-400">Player-Status</p>
              <p className="font-semibold text-white mt-0.5 flex items-center gap-1.5">
                <Power
                  className={`w-3.5 h-3.5 ${
                    effectiveState?.powerOn ? 'text-emerald-400' : 'text-slate-500'
                  }`}
                />
                <span>
                  {effectiveState?.powerOn
                    ? effectiveState.playbackState === 'PLAYING'
                      ? 'Spielt ab'
                      : effectiveState.playbackState === 'PAUSED'
                        ? 'Pausiert'
                        : 'Bereit'
                    : 'Standby'}
                </span>
              </p>
            </div>
            <div>
              <p className="text-slate-400">Lautstärke</p>
              <p className="font-mono font-semibold text-amber-400 mt-0.5 tabular-nums flex items-center gap-1.5">
                {syncedMuted ? (
                  <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                <span>{syncedMuted ? 'Stumm' : `${syncedVolume}%`}</span>
              </p>
            </div>
            <div>
              <p className="text-slate-400">Geschwindigkeit</p>
              <p className="font-mono font-semibold text-amber-400 mt-0.5 tabular-nums flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5" />
                <span>{formatSpeedLabel(syncedSpeed)}</span>
              </p>
            </div>
            <div>
              <p className="text-slate-400">Aktiver Titel</p>
              <p className="font-medium text-slate-200 mt-0.5 truncate">
                {effectiveState?.activeTitle || 'Kein Titel aktiv'}
              </p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-slate-400">Letzter Befehl</p>
              <p className="font-medium text-slate-200 mt-0.5 truncate">
                {effectiveState?.lastCommand
                  ? `${
                      effectiveState.lastCommandSource
                        ? SOURCE_LABELS[effectiveState.lastCommandSource]
                        : 'Smart Home'
                    }: ${effectiveState.lastCommand}`
                  : 'Noch keiner'}
              </p>
            </div>
          </div>

          {/* Direkte Mediensteuerung über smartHomeState (Lautstärke & Wiedergabegeschwindigkeit) */}
          <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <SlidersHorizontal className="w-4 h-4 text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <h4 className="text-xs sm:text-sm font-semibold text-white">
                    Aktive Medien direkt steuern
                  </h4>
                  <p className="text-[11px] text-slate-400 truncate">
                    Synchronisiert Lautstärke &amp; Wiedergabegeschwindigkeit in Echtzeit über den{' '}
                    <span className="font-mono text-slate-300">smartHomeState</span>
                    {effectiveState?.activeTitle ? ` · Aktiv: ${effectiveState.activeTitle}` : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={Boolean(testing)}
                  onClick={() =>
                    void sendAppSmartHomeCommand(
                      'app_play',
                      { action: 'play' },
                      'Wiedergabe über Smart-Home-Steuerung gestartet.'
                    )
                  }
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                    effectiveState?.playbackState === 'PLAYING'
                      ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                      : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                >
                  <Play className="w-3 h-3" />
                  <span>Abspielen</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(testing)}
                  onClick={() =>
                    void sendAppSmartHomeCommand(
                      'app_pause',
                      { action: 'pause' },
                      'Wiedergabe über Smart-Home-Steuerung pausiert.'
                    )
                  }
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
                    effectiveState?.playbackState === 'PAUSED'
                      ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                      : 'bg-[#121722] hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                >
                  <Pause className="w-3 h-3" />
                  <span>Pause</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Lautstärke-Steuerung */}
              <div className="p-3.5 rounded-xl bg-[#121722] border border-slate-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {syncedMuted ? (
                      <VolumeX className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : (
                      <Volume2 className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-white">Lautstärke</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-amber-400 tabular-nums">
                      {syncedMuted ? 'Stumm' : `${draftVolume}%`}
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(testing)}
                      onClick={() =>
                        void sendAppSmartHomeCommand('app_mute', {
                          action: 'mute',
                          muted: !syncedMuted,
                        })
                      }
                      className={`px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors whitespace-nowrap ${
                        syncedMuted
                          ? 'bg-rose-500/20 border-rose-500/50 text-rose-200 hover:bg-rose-500/30'
                          : 'bg-[#0B0E14] border-slate-700 text-slate-300 hover:text-white'
                      }`}
                    >
                      {syncedMuted ? 'Ton an' : 'Stumm'}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Lautstärke um 10% verringern"
                    disabled={Boolean(testing) || draftVolume <= 0}
                    onClick={() => {
                      const nextVol = Math.max(0, draftVolume - 10);
                      setDraftVolume(nextVol);
                      void sendAppSmartHomeCommand('app_vol_minus', {
                        action: 'volume_set',
                        volume: nextVol,
                      });
                    }}
                    className="p-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-slate-200 disabled:opacity-40 transition-colors"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>

                  <input
                    type="range"
                    aria-label="Lautstärke aktiver Medien"
                    min={0}
                    max={100}
                    step={1}
                    value={draftVolume}
                    onChange={(e) => setDraftVolume(Number(e.target.value))}
                    onMouseUp={() =>
                      void sendAppSmartHomeCommand('app_vol_slider', {
                        action: 'volume_set',
                        volume: draftVolume,
                      })
                    }
                    onTouchEnd={() =>
                      void sendAppSmartHomeCommand('app_vol_slider', {
                        action: 'volume_set',
                        volume: draftVolume,
                      })
                    }
                    onKeyUp={() =>
                      void sendAppSmartHomeCommand('app_vol_slider', {
                        action: 'volume_set',
                        volume: draftVolume,
                      })
                    }
                    className="flex-1 h-1.5 accent-amber-400 cursor-pointer"
                  />

                  <button
                    type="button"
                    aria-label="Lautstärke um 10% erhöhen"
                    disabled={Boolean(testing) || draftVolume >= 100}
                    onClick={() => {
                      const nextVol = Math.min(100, draftVolume + 10);
                      setDraftVolume(nextVol);
                      void sendAppSmartHomeCommand('app_vol_plus', {
                        action: 'volume_set',
                        volume: nextVol,
                      });
                    }}
                    className="p-1.5 rounded-lg bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-slate-200 disabled:opacity-40 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {VOLUME_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={Boolean(testing)}
                      onClick={() => {
                        setDraftVolume(preset);
                        void sendAppSmartHomeCommand('app_vol_preset', {
                          action: 'volume_set',
                          volume: preset,
                        });
                      }}
                      className={`px-2.5 py-1 rounded-md border text-[11px] font-mono tabular-nums transition-colors ${
                        !syncedMuted && draftVolume === preset
                          ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                          : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-700 text-slate-300'
                      }`}
                    >
                      {preset}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Wiedergabegeschwindigkeit */}
              <div className="p-3.5 rounded-xl bg-[#121722] border border-slate-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-amber-400 shrink-0" />
                    <span className="text-xs font-semibold text-white">
                      Wiedergabegeschwindigkeit
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-amber-400 tabular-nums">
                      {formatSpeedLabel(draftSpeed)}
                    </span>
                    {draftSpeed !== 1 && (
                      <button
                        type="button"
                        disabled={Boolean(testing)}
                        onClick={() => {
                          setDraftSpeed(1);
                          void sendAppSmartHomeCommand('app_speed_reset', {
                            action: 'speed_set',
                            playbackRate: 1,
                          });
                        }}
                        className="px-2 py-1 rounded-md bg-[#0B0E14] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 flex items-center gap-1 whitespace-nowrap"
                      >
                        <RotateCcw className="w-3 h-3 text-amber-400" />
                        <span>1.0x</span>
                      </button>
                    )}
                  </div>
                </div>

                <input
                  type="range"
                  aria-label="Wiedergabegeschwindigkeit aktiver Medien"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={draftSpeed}
                  onChange={(e) => setDraftSpeed(Number(e.target.value))}
                  onMouseUp={() =>
                    void sendAppSmartHomeCommand('app_speed_slider', {
                      action: 'speed_set',
                      playbackRate: draftSpeed,
                    })
                  }
                  onTouchEnd={() =>
                    void sendAppSmartHomeCommand('app_speed_slider', {
                      action: 'speed_set',
                      playbackRate: draftSpeed,
                    })
                  }
                  onKeyUp={() =>
                    void sendAppSmartHomeCommand('app_speed_slider', {
                      action: 'speed_set',
                      playbackRate: draftSpeed,
                    })
                  }
                  className="w-full h-1.5 accent-amber-400 cursor-pointer"
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  {SPEED_PRESETS.map((rate) => {
                    const active = Math.abs(draftSpeed - rate) < 0.01;
                    return (
                      <button
                        key={rate}
                        type="button"
                        disabled={Boolean(testing)}
                        onClick={() => {
                          setDraftSpeed(rate);
                          void sendAppSmartHomeCommand('app_speed_preset', {
                            action: 'speed_set',
                            playbackRate: rate,
                          });
                        }}
                        className={`px-2.5 py-1 rounded-md border text-[11px] font-mono tabular-nums transition-colors ${
                          active
                            ? 'bg-amber-400 border-amber-300 text-slate-950 font-semibold'
                            : 'bg-[#0B0E14] hover:bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        {formatSpeedLabel(rate)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          {/* Konfiguration */}
          <form onSubmit={(e) => void handleSaveConfig(e)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">Google Home / Assistant</p>
                    <p className="text-[11px] text-slate-400">
                      Smart Home Graph (SYNC · QUERY · EXECUTE)
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => setGoogleEnabled((v) => !v)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      googleEnabled
                        ? 'bg-amber-400 border-amber-300 text-slate-950'
                        : 'bg-[#121722] border-slate-700 text-slate-400'
                    } disabled:opacity-60`}
                  >
                    {googleEnabled ? 'Aktiviert' : 'Deaktiviert'}
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Sprachbefehle: „Hey Google, pausiere {deviceName}“, „Hey Google, Lautstärke auf 50 %“,
                  „Hey Google, schalte {deviceName} ein“.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">Amazon Alexa Skill v3</p>
                    <p className="text-[11px] text-slate-400">
                      Discovery · PlaybackController · RemoteVideoPlayer
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => setAlexaEnabled((v) => !v)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      alexaEnabled
                        ? 'bg-amber-400 border-amber-300 text-slate-950'
                        : 'bg-[#121722] border-slate-700 text-slate-400'
                    } disabled:opacity-60`}
                  >
                    {alexaEnabled ? 'Aktiviert' : 'Deaktiviert'}
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Sprachbefehle: „Alexa, suche Geräte“, „Alexa, spiele Nachtlinie Berlin auf{' '}
                  {deviceName}“, „Alexa, nächster Titel auf {deviceName}“.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Smart-Home Gerätename</label>
                <input
                  type="text"
                  disabled={!isAdmin}
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white disabled:opacity-60 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Raum (Room Hint)</label>
                <input
                  type="text"
                  disabled={!isAdmin}
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white disabled:opacity-60 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Alexa Aufrufname</label>
                <input
                  type="text"
                  disabled={!isAdmin}
                  value={invocationName}
                  onChange={(e) => setInvocationName(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white disabled:opacity-60 focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            {isAdmin ? (
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{saving ? 'Speichere...' : 'Smart-Home-Daten speichern'}</span>
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                Gerätename, Plattform-Schalter und Webhook-Tokens können nur vom Administrator
                geändert werden. Du kannst unten direkt Sprachbefehle testen und den Status steuern.
              </p>
            )}
          </form>

          {/* Endpunkt-URLs & Webhook-Token (Einbindung) */}
          <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-3">
            <h4 className="text-xs font-semibold text-white">
              Endpunkte für Google Home, Amazon Alexa &amp; Home Assistant
            </h4>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-[#121722] border border-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400">Google Home Fulfillment URL</p>
                  <p className="font-mono text-amber-300 truncate">{googleEndpointUrl}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void copyText('googleUrl', googleEndpointUrl)}
                  className="px-2.5 py-1.5 rounded-md bg-[#0B0E14] border border-slate-700 text-[11px] text-slate-200 hover:text-white flex items-center gap-1 shrink-0 whitespace-nowrap"
                >
                  <Copy className="w-3 h-3 text-amber-400" />
                  <span>{copiedKey === 'googleUrl' ? 'Kopiert' : 'Kopieren'}</span>
                </button>
              </div>

              <div className="p-3 rounded-lg bg-[#121722] border border-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400">Amazon Alexa Skill Endpoint URL</p>
                  <p className="font-mono text-amber-300 truncate">{alexaEndpointUrl}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void copyText('alexaUrl', alexaEndpointUrl)}
                  className="px-2.5 py-1.5 rounded-md bg-[#0B0E14] border border-slate-700 text-[11px] text-slate-200 hover:text-white flex items-center gap-1 shrink-0 whitespace-nowrap"
                >
                  <Copy className="w-3 h-3 text-amber-400" />
                  <span>{copiedKey === 'alexaUrl' ? 'Kopiert' : 'Kopieren'}</span>
                </button>
              </div>
            </div>

            {isAdmin && (
              <div className="p-3 rounded-lg bg-[#121722] border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400">Bearer Webhook-Token (OAuth/Skill)</p>
                  <p className="font-mono text-slate-200 truncate">
                    {showWebhookToken && fullWebhookToken
                      ? fullWebhookToken
                      : snapshot?.config.webhookTokenPreview || 'mc_sh_••••••••'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleRevealToken()}
                    className="px-2.5 py-1.5 rounded-md bg-[#0B0E14] border border-slate-700 text-[11px] text-slate-200 hover:text-white flex items-center gap-1 whitespace-nowrap"
                  >
                    {showWebhookToken ? (
                      <EyeOff className="w-3 h-3 text-slate-400" />
                    ) : (
                      <Eye className="w-3 h-3 text-amber-400" />
                    )}
                    <span>{showWebhookToken ? 'Verbergen' : 'Anzeigen'}</span>
                  </button>
                  {fullWebhookToken && (
                    <button
                      type="button"
                      onClick={() => void copyText('webhookToken', fullWebhookToken)}
                      className="px-2.5 py-1.5 rounded-md bg-[#0B0E14] border border-slate-700 text-[11px] text-slate-200 hover:text-white flex items-center gap-1 whitespace-nowrap"
                    >
                      <Copy className="w-3 h-3 text-amber-400" />
                      <span>{copiedKey === 'webhookToken' ? 'Kopiert' : 'Kopieren'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleRotateToken()}
                    className="px-2.5 py-1.5 rounded-md bg-[#0B0E14] border border-amber-400/50 text-[11px] text-amber-300 hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap"
                  >
                    <RotateCw className="w-3 h-3" />
                    <span>Neu generieren</span>
                  </button>
                </div>
              </div>
            )}

            <div className="pt-1 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-400">
                  Home Assistant / Smart-Home Bridge (`configuration.yaml`)
                </p>
                <button
                  type="button"
                  onClick={() => void copyText('haYaml', homeAssistantYaml)}
                  className="text-[11px] text-amber-400 hover:text-amber-300 font-medium flex items-center gap-1 whitespace-nowrap"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedKey === 'haYaml' ? 'YAML kopiert' : 'YAML kopieren'}</span>
                </button>
              </div>
              <pre className="p-3 rounded-lg bg-[#121722] border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto">
                {homeAssistantYaml}
              </pre>
            </div>
          </div>

          {/* Live Sprachbefehl- & Schnittstellen-Tester */}
          <div className="p-4 rounded-xl bg-[#0B0E14] border border-slate-800/80 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-amber-400 shrink-0" />
                <h4 className="text-xs font-semibold text-white">
                  Sprachbefehle &amp; Smart-Home-Schnittstelle direkt testen
                </h4>
              </div>
              <button
                type="button"
                onClick={() => void loadSmartHome()}
                disabled={loading}
                className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 whitespace-nowrap"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                <span>Status aktualisieren</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Titel für Alexa Sprachbefehl wählen"
                value={voiceMediaQuery}
                onChange={(e) => setVoiceMediaQuery(e.target.value)}
                className="flex-1 min-w-[180px] px-3 py-2 rounded-lg bg-[#121722] border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
              >
                {libraryItems.map((item) => (
                  <option key={item.id} value={item.title}>
                    {item.title} ({item.kind === 'series' ? 'Serie' : item.kind === 'music' ? 'Musik' : 'Film'})
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={Boolean(testing) || !alexaEnabled || !voiceMediaQuery}
                onClick={() =>
                  void runAlexaDirectiveTest(
                    'alexa_play',
                    {
                      header: {
                        namespace: 'Alexa.RemoteVideoPlayer',
                        name: 'SearchAndPlay',
                        messageId: `msg-${Date.now()}`,
                        payloadVersion: '3',
                      },
                      endpoint: { endpointId: 'entencenter-nas-player' },
                      payload: {
                        entities: [{ type: 'Video', value: voiceMediaQuery }],
                      },
                    },
                    `Alexa Sprachbefehl ausgeführt: „Spiele ${voiceMediaQuery} auf ${deviceName}“`
                  )
                }
                className="px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>„Alexa, spiele Titel“</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={Boolean(testing) || !googleEnabled}
                onClick={() =>
                  void runGoogleFulfillmentTest(
                    'gh_sync',
                    {
                      requestId: `sync-${Date.now()}`,
                      inputs: [{ intent: 'action.devices.SYNC' }],
                    },
                    'Google Home SYNC erfolgreich: EntenCenter NAS Player an Google Assistant gemeldet.'
                  )
                }
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs text-slate-200 whitespace-nowrap"
              >
                Google Home SYNC
              </button>

              <button
                type="button"
                disabled={Boolean(testing) || !googleEnabled}
                onClick={() =>
                  void runGoogleFulfillmentTest(
                    'gh_pause',
                    {
                      requestId: `pause-${Date.now()}`,
                      inputs: [
                        {
                          intent: 'action.devices.EXECUTE',
                          payload: {
                            commands: [
                              {
                                devices: [{ id: 'entencenter-nas-player' }],
                                execution: [{ command: 'action.devices.commands.mediaPause' }],
                              },
                            ],
                          },
                        },
                      ],
                    },
                    'Google Home Befehl: Wiedergabe pausiert.'
                  )
                }
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs text-slate-200 flex items-center gap-1.5 whitespace-nowrap"
              >
                <Pause className="w-3 h-3 text-amber-400" />
                <span>„Hey Google, Pause“</span>
              </button>

              <button
                type="button"
                disabled={Boolean(testing) || !googleEnabled}
                onClick={() =>
                  void runGoogleFulfillmentTest(
                    'gh_resume',
                    {
                      requestId: `resume-${Date.now()}`,
                      inputs: [
                        {
                          intent: 'action.devices.EXECUTE',
                          payload: {
                            commands: [
                              {
                                devices: [{ id: 'entencenter-nas-player' }],
                                execution: [{ command: 'action.devices.commands.mediaResume' }],
                              },
                            ],
                          },
                        },
                      ],
                    },
                    'Google Home Befehl: Wiedergabe fortgesetzt.'
                  )
                }
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs text-slate-200 flex items-center gap-1.5 whitespace-nowrap"
              >
                <Play className="w-3 h-3 text-amber-400" />
                <span>„Hey Google, Weiter“</span>
              </button>

              <button
                type="button"
                disabled={Boolean(testing) || !alexaEnabled}
                onClick={() =>
                  void runAlexaDirectiveTest(
                    'alexa_discover',
                    {
                      header: {
                        namespace: 'Alexa.Discovery',
                        name: 'Discover',
                        messageId: `disc-${Date.now()}`,
                        payloadVersion: '3',
                      },
                      payload: {},
                    },
                    'Amazon Alexa Discover erfolgreich: EntenCenter Endpunkt gemeldet.'
                  )
                }
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs text-slate-200 whitespace-nowrap"
              >
                Alexa Geräte-Suche
              </button>

              <button
                type="button"
                disabled={Boolean(testing) || !alexaEnabled}
                onClick={() =>
                  void runAlexaDirectiveTest(
                    'alexa_vol',
                    {
                      header: {
                        namespace: 'Alexa.Speaker',
                        name: 'SetVolume',
                        messageId: `vol-${Date.now()}`,
                        payloadVersion: '3',
                      },
                      endpoint: { endpointId: 'entencenter-nas-player' },
                      payload: { volume: 50, volumeDefault: false },
                    },
                    'Alexa Befehl: Lautstärke auf 50 % gesetzt.'
                  )
                }
                className="px-3 py-1.5 rounded-lg bg-[#121722] hover:bg-slate-800 border border-slate-700 disabled:opacity-50 text-xs text-slate-200 whitespace-nowrap"
              >
                „Alexa, Lautstärke 50 %“
              </button>
            </div>
          </div>

          {/* Protokoll der letzten Smart-Home-Befehle */}
          {snapshot && snapshot.recentLogs.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400">
                Letzte Smart-Home-Ereignisse
              </p>
              <div className="divide-y divide-slate-800/70 border border-slate-800/80 rounded-xl bg-[#0B0E14] px-3">
                {snapshot.recentLogs.slice(0, 5).map((entry) => (
                  <div
                    key={entry.id}
                    className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[11px] text-amber-400 shrink-0">
                        {SOURCE_LABELS[entry.source]}
                      </span>
                      <span className="text-slate-200 font-medium truncate">
                        {entry.command}
                      </span>
                      <span className="text-slate-500 truncate hidden sm:inline">
                        · {entry.detail}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString('de-DE', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
