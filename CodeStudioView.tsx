import React, { useMemo, useState } from 'react';
import { Copy, Check, Download, Code2 } from 'lucide-react';
import { KOTLIN_PYTHON_MODULES } from '../data/kotlinPythonModules';

export const CodeStudioView: React.FC = () => {
  const [groupFilter, setGroupFilter] = useState<'all' | 'calendar-sync' | 'backend-auth' | 'statistics'>('all');
  const [selectedId, setSelectedId] = useState<string>(KOTLIN_PYTHON_MODULES[0].id);
  const [copied, setCopied] = useState(false);

  const visibleFiles = useMemo(() => {
    return KOTLIN_PYTHON_MODULES.filter(
      (f) => groupFilter === 'all' || f.moduleGroup === groupFilter
    );
  }, [groupFilter]);

  const activeFile =
    visibleFiles.find((f) => f.id === selectedId) ?? visibleFiles[0] ?? KOTLIN_PYTHON_MODULES[0];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeFile.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback ignored cleanly
    }
  };

  const handleDownload = () => {
    const blob = new Blob([activeFile.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFile.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Modul-Auswahl */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#121722] border border-slate-800/80 rounded-lg">
          {(
            [
              { id: 'all', label: 'Alle Module' },
              { id: 'calendar-sync', label: 'Serienkalender DE' },
              { id: 'backend-auth', label: 'NAS-Backend & Auth' },
              { id: 'statistics', label: 'Statistiken' },
            ] as const
          ).map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                setGroupFilter(g.id);
                const firstMatch = KOTLIN_PYTHON_MODULES.find(
                  (m) => g.id === 'all' || m.moduleGroup === g.id
                );
                if (firstMatch) setSelectedId(firstMatch.id);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                groupFilter === g.id
                  ? 'bg-amber-400 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>

        <span className="text-xs text-slate-400">
          Direkt einsatzbereiter Quellcode für dein Python-NAS &amp; Android-TV-Projekt
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Dateiliste */}
        <div className="lg:col-span-4 space-y-2">
          {visibleFiles.map((file) => {
            const active = file.id === activeFile.id;
            return (
              <button
                key={file.id}
                type="button"
                onClick={() => setSelectedId(file.id)}
                className={`w-full text-left p-4 rounded-xl border transition-colors ${
                  active
                    ? 'bg-[#171E2C] border-amber-400/60 text-white'
                    : 'bg-[#121722] border-slate-800/80 text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold truncate">
                    {file.filename}
                  </span>
                  <span className="text-xs font-mono text-amber-400 shrink-0">
                    {file.language === 'python' ? 'Python' : 'Kotlin'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{file.platform}</p>
                <p className="text-xs text-slate-300 mt-2 leading-relaxed line-clamp-2">
                  {file.summary}
                </p>
              </button>
            );
          })}
        </div>

        {/* Code-Viewer */}
        <div className="lg:col-span-8 bg-[#0E131D] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 bg-[#121722] border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Code2 className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="font-mono text-sm font-semibold text-white truncate">
                {activeFile.filename}
              </span>
              <span className="text-xs text-slate-400 hidden sm:inline">
                · {activeFile.platform}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 text-xs font-medium bg-[#0B0E14] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copied ? 'Kopiert' : 'Kopieren'}</span>
              </button>

              <button
                type="button"
                onClick={handleDownload}
                className="px-3 py-1.5 text-xs font-medium bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Herunterladen</span>
              </button>
            </div>
          </div>

          <div className="px-5 py-3 bg-[#101520] border-b border-slate-800/60 text-xs text-slate-300 leading-relaxed">
            {activeFile.summary}
          </div>

          <pre className="p-5 overflow-x-auto text-xs font-mono leading-relaxed text-slate-200 max-h-[600px]">
            <code>{activeFile.code}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
