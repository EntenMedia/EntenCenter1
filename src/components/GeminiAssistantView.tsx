import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Upload,
  Image as ImageIcon,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Mic,
  MicOff,
} from 'lucide-react';
import { DEFAULT_ASSISTANT_AVATAR_URL } from '../data/coverAssets';
import { AssistantAvatarImage } from './AssistantAvatarImage';
import { ChatMessage, GeminiModelId } from '../types/marcente';

interface GeminiAssistantViewProps {
  initialTab?: 'chat' | 'vision';
  assistantAvatarUrl?: string;
}

const MODEL_OPTIONS: Array<{
  id: GeminiModelId;
  label: string;
  description: string;
}> = [
  {
    id: 'gemini-4-hydrogen',
    label: 'gemini-4-hydrogen',
    description: 'Allgemeine Aufgaben & Serienberatung',
  },
  {
    id: 'gemini-4-argon',
    label: 'gemini-4-argon',
    description: 'Komplexe interaktive Aufgaben (Paid Key)',
  },
  {
    id: 'gemini-4-carbon',
    label: 'gemini-4-carbon',
    description: 'Tiefes Architektur- & Code-Reasoning (Paid Key)',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'gemini-3.1-flash-lite',
    description: 'Ultraschnelle Antworten',
  },
];

const STARTER_PROMPTS = [
  'Wie erweitere ich EntenCenterCalendarManager um TMDb-Abfragen für Deutschland?',
  'Wie implementiere ich D-Pad-Fokusnavigation auf Android TV für die Cover-Karten?',
  'Wie mache ich das NAS-JSON-Ledger noch ausfallsicherer gegen Stromausfälle?',
];

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export const GeminiAssistantView: React.FC<GeminiAssistantViewProps> = ({
  initialTab = 'chat',
  assistantAvatarUrl = DEFAULT_ASSISTANT_AVATAR_URL,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'vision'>(initialTab);

  // Multi-Turn Chat State
  const [selectedModel, setSelectedModel] = useState<GeminiModelId>('gemini-4-hydrogen');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-duck',
      role: 'model',
      model: 'gemini-4-hydrogen',
      text: 'Quak! Ich bin deine EntenCenter Gummi-Ente. Frag mich alles zu deinem Python-NAS-Backend, der Kotlin-Android-TV-App oder den Serienstarts im DE-Raum.',
      timestamp: new Date().toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const baseInputRef = useRef<string>('');
  const speechSupported = Boolean(getSpeechRecognitionCtor());

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignorieren
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const stopSpeechInput = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignorieren
      }
    }
    setIsListening(false);
  };

  const toggleSpeechInput = () => {
    if (isListening) {
      stopSpeechInput();
      return;
    }

    const SpeechCtor = getSpeechRecognitionCtor();
    if (!SpeechCtor) {
      setChatError(
        'Spracheingabe (Web Speech API) wird in diesem Browser leider nicht unterstützt.'
      );
      return;
    }

    setChatError(null);
    baseInputRef.current = chatInput.trimEnd();

    try {
      const recognition = new SpeechCtor();
      recognition.lang = 'de-DE';
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result && result[0]) {
            transcript += result[0].transcript;
          }
        }
        const cleaned = transcript.trim();
        if (cleaned) {
          setChatInput(
            baseInputRef.current ? `${baseInputRef.current} ${cleaned}` : cleaned
          );
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setChatError(
            'Mikrofonzugriff wurde verweigert. Bitte erlaube den Mikrofonzugriff im Browser.'
          );
        } else if (event.error === 'no-speech') {
          setChatError('Keine Sprache erkannt. Bitte erneut versuchen.');
        } else if (event.error === 'audio-capture') {
          setChatError('Kein Mikrofon gefunden.');
        } else if (event.error !== 'aborted') {
          setChatError(`Spracheingabe-Fehler: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
    } catch {
      setChatError('Mikrofon konnte nicht gestartet werden.');
      setIsListening(false);
    }
  };

  // Image Understanding State (gemini-4-argon)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string>('image/jpeg');
  const [imagePrompt, setImagePrompt] = useState(
    'Erkenne den Film oder die Serie bzw. analysiere dieses Bild für meine EntenCenter NAS-Mediathek (Titel, Genre, Stimmung und Metadaten).'
  );
  const [visionResult, setVisionResult] = useState<string | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionError, setVisionError] = useState<string | null>(null);

  const sendMessage = async (textOverride?: string) => {
    if (isListening) {
      stopSpeechInput();
    }
    const content = (textOverride ?? chatInput).trim();
    if (!content || chatLoading) return;

    const userMsg: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      text: content,
      timestamp: new Date().toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!textOverride) setChatInput('');
    setChatError(null);
    setChatLoading(true);

    try {
      const res = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: nextHistory.map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setChatError(data.error || 'Fehler bei der Kommunikation mit Gemini.');
        return;
      }

      const modelMsg: ChatMessage = {
        id: `mod-${Date.now()}`,
        role: 'model',
        model: data.model || selectedModel,
        text: data.text,
        timestamp: new Date().toLocaleTimeString('de-DE', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
      setMessages((prev) => [...prev, modelMsg]);
      window.setTimeout(
        () => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
        60
      );
    } catch {
      setChatError('Netzwerkfehler beim Aufruf des Gemini-Chat-Endpunkts.');
    } finally {
      setChatLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVisionError(null);
    setVisionResult(null);
    setImageMimeType(file.type || 'image/jpeg');

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setPreviewUrl(dataUrl);
      const commaIdx = dataUrl.indexOf(',');
      setImageBase64(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleAnalyzeImage = async () => {
    if (!imageBase64 || visionLoading) return;
    setVisionLoading(true);
    setVisionError(null);
    setVisionResult(null);

    try {
      const res = await fetch('/api/gemini/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Data: imageBase64,
          mimeType: imageMimeType,
          prompt: imagePrompt,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVisionError(data.error || 'Bildanalyse fehlgeschlagen.');
        return;
      }
      setVisionResult(data.text);
    } catch {
      setVisionError('Netzwerkfehler bei der Bildanalyse.');
    } finally {
      setVisionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Modus-Umschalter */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#121722] border border-slate-800/80 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'chat'
                ? 'bg-amber-400 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Enten-Assistent (Multi-Turn Chat)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('vision')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'vision'
                ? 'bg-amber-400 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>Cover &amp; Bild-Scanner (gemini-4-argon)</span>
          </button>
        </div>
      </div>

      {activeTab === 'chat' ? (
        <div className="bg-[#121722] border border-slate-800/80 rounded-xl overflow-hidden flex flex-col h-[640px]">
          {/* Chat Header mit Modellwahl */}
          <div className="px-5 py-3.5 bg-[#0F141E] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <AssistantAvatarImage
                src={assistantAvatarUrl}
                alt="EntenCenter Enten-Assistent"
                sizePx={36}
                className="w-9 h-9 rounded-lg object-cover border border-slate-700 shrink-0"
              />
              <div>
                <h3 className="font-display text-sm font-semibold text-white">
                  EntenCenter Enten-Assistent
                </h3>
                <p className="text-xs text-slate-400">
                  Architektur-, Kotlin/Python- &amp; DE-Serien-Berater
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <span>Modell:</span>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as GeminiModelId)}
                  className="bg-[#0B0E14] border border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-amber-400"
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={() => {
                  setMessages((prev) => prev.slice(0, 1));
                  setChatError(null);
                }}
                title="Verlauf zurücksetzen"
                className="p-2 rounded-md bg-[#0B0E14] border border-slate-800 text-slate-400 hover:text-white transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Scrollbare Nachrichtenliste */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col max-w-3xl ${
                  msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                }`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <span>{msg.role === 'user' ? 'Du' : 'Gummi-Ente'}</span>
                  {msg.model && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-500">{msg.model}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{msg.timestamp}</span>
                </div>
                <div
                  className={`px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-amber-400 text-slate-950 font-medium'
                      : 'bg-[#0B0E14] border border-slate-800 text-slate-200'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}

            {chatLoading && (
              <div className="mr-auto max-w-md px-4 py-3 rounded-xl bg-[#0B0E14] border border-slate-800 text-xs text-slate-400">
                Gummi-Ente denkt nach ({selectedModel})...
              </div>
            )}

            {chatError && (
              <div
                role="alert"
                className="p-3.5 rounded-xl bg-red-950/50 border border-red-800/70 text-xs text-red-200"
              >
                {chatError}
              </div>
            )}

            <div ref={threadEndRef} />
          </div>

          {/* Schnell-Prompts + Eingabefeld */}
          <div className="p-4 bg-[#0F141E] border-t border-slate-800/80 space-y-3">
            <div className="flex flex-wrap gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => sendMessage(prompt)}
                  className="px-3 py-1.5 text-xs bg-[#0B0E14] hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-md transition-colors text-left"
                >
                  {prompt}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={
                  isListening
                    ? 'Höre zu... jetzt sprechen'
                    : 'Frage zur EntenCenter-App, Kotlin, Python oder DE-Serien stellen...'
                }
                className="flex-1 px-4 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
              />
              <button
                type="button"
                onClick={toggleSpeechInput}
                disabled={chatLoading || !speechSupported}
                aria-pressed={isListening}
                aria-label={
                  isListening ? 'Spracheingabe stoppen' : 'Spracheingabe per Mikrofon starten'
                }
                title={
                  !speechSupported
                    ? 'Spracheingabe wird von diesem Browser nicht unterstützt'
                    : isListening
                      ? 'Spracheingabe stoppen'
                      : 'Sprache-zu-Text (Deutsch)'
                }
                className={`p-2.5 rounded-lg border transition-colors flex items-center justify-center shrink-0 ${
                  isListening
                    ? 'bg-red-500/20 border-red-400 text-red-300 hover:bg-red-500/30'
                    : 'bg-[#0B0E14] border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-400/60 disabled:opacity-40'
                }`}
              >
                {isListening ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>
              <button
                type="submit"
                disabled={chatLoading || !chatInput.trim()}
                className="px-4 py-2.5 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Send className="w-4 h-4" />
                <span>Senden</span>
              </button>
            </form>
          </div>
        </div>
      ) : (
        /* Bildanalyse-Tab (gemini-4-argon) */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 p-6 bg-[#121722] border border-slate-800/80 rounded-xl space-y-5">
            <div>
              <h3 className="font-display text-lg font-semibold text-white">
                Foto oder Cover hochladen
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Analysiert Film-/Serienposter, TV-Szenen oder NAS-Screenshots mit{' '}
                <code className="font-mono text-amber-300">gemini-4-argon</code>.
              </p>
            </div>

            <label className="block border border-dashed border-slate-700 hover:border-amber-400/70 rounded-xl p-6 text-center cursor-pointer bg-[#0B0E14] transition-colors">
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Hochgeladenes Bild zur Analyse"
                  className="max-h-64 mx-auto rounded-lg object-contain"
                />
              ) : (
                <div className="space-y-2 py-6">
                  <Upload className="w-8 h-8 text-amber-400 mx-auto" />
                  <p className="text-sm font-medium text-slate-200">
                    Bild auswählen oder hierher ziehen
                  </p>
                  <p className="text-xs text-slate-500">PNG, JPG oder WebP bis 10 MB</p>
                </div>
              )}
            </label>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Analyse-Auftrag
              </label>
              <textarea
                rows={3}
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-[#0B0E14] border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-amber-400"
              />
            </div>

            <button
              type="button"
              disabled={!imageBase64 || visionLoading}
              onClick={handleAnalyzeImage}
              className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-950 font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              <span>
                {visionLoading
                  ? 'Analysiere mit gemini-4-argon...'
                  : 'Bild mit Gemini analysieren'}
              </span>
            </button>
          </div>

          <div className="lg:col-span-7 p-6 bg-[#121722] border border-slate-800/80 rounded-xl min-h-[420px]">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 mb-4">
              <h3 className="font-display text-lg font-semibold text-white">
                Analyse-Ergebnis
              </h3>
              <span className="font-mono text-xs text-amber-400">gemini-4-argon</span>
            </div>

            {visionError && (
              <div
                role="alert"
                className="p-4 rounded-xl bg-red-950/50 border border-red-800/70 text-xs text-red-200 mb-4"
              >
                {visionError}
              </div>
            )}

            {visionResult ? (
              <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                {visionResult}
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                Lade links ein Foto (z. B. ein Serien-Cover, eine Filmszene oder ein
                NAS-Hardware-Bild) hoch und starte die Analyse, um erkannte Metadaten und
                Empfehlungen für deine EntenCenter-Bibliothek zu erhalten.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
