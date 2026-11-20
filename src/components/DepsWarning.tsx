import { useMemo, useState } from "react";
import type { DepStatus } from "../types";

interface Props {
  deps: DepStatus[];
  onClose: () => void;
  onRecheck: () => Promise<void>;
}

export function DepsWarning({ deps, onClose, onRecheck }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const missing = deps.filter((d) => !d.found);
  const found = deps.filter((d) => d.found);

  // The backend includes pnmtopng only on Linux, independent of WebView user-agent quirks.
  const isLinux = deps.some((d) => d.name === "pnmtopng");
  const isMac = /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
  const installCommands = useMemo(() => {
    const commandFor = (linux: boolean) => {
      const packages = missing.map((d) => {
        if (d.name === "ddjvu" || d.name === "djvused") return linux ? "djvulibre-bin" : "djvulibre";
        if (["pdftoppm", "pdfinfo", "pdftotext"].includes(d.name)) return linux ? "poppler-utils" : "poppler";
        if (d.name === "tesseract" && linux) return "tesseract-ocr";
        if (d.name === "pnmtopng") return "netpbm";
        if (d.name === "pdftk") return "pdftk-java";
        return d.name;
      });
      return `${linux ? "sudo apt install" : "brew install"} ${[...new Set(packages)].join(" ")}`;
    };
    if (isLinux) return [{ label: "Ubuntu (apt)", command: commandFor(true) }];
    if (isMac) return [{ label: "macOS (Homebrew)", command: commandFor(false) }];
    return [
      { label: "Ubuntu (apt)", command: commandFor(true) },
      { label: "macOS (Homebrew)", command: commandFor(false) },
    ];
  }, [missing, isLinux, isMac]);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      setCopied(null);
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[500px] max-w-[calc(100vw-2rem)] h-[min(650px,calc(100vh-2rem))] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-lg">⚠</span>
            <h2 className="font-semibold text-zinc-100">Dependency Check</h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
          {missing.length > 0 && (
            <div>
              <p className="text-sm text-amber-400 mb-3">
                The following tools are missing. Install them for your system:
              </p>
              {installCommands.map(({ label, command }) => (
                <div key={label} className="bg-zinc-950 rounded-lg p-3 mb-3">
                  <p className="text-xs text-zinc-500 mb-2">{label}</p>
                  <div className="font-mono text-xs text-green-400 break-all select-text">{command}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => copyCommand(command)}
                      className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300"
                    >
                      {copied === command ? "Copied" : "Copy command"}
                    </button>
                    <button
                      onClick={recheck}
                      disabled={checking}
                      className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs text-zinc-300"
                    >
                      {checking ? "Checking..." : "Recheck"}
                    </button>
                  </div>
                </div>
              ))}
              <div className="space-y-2">
                {missing.map((d) => (
                  <div
                    key={d.name}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="text-red-400">✗</span>
                    <span className="font-mono text-zinc-300 w-24">
                      {d.name}
                    </span>
                    <span className="text-zinc-500">{d.required_for}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {found.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 mb-2">Installed tools:</p>
              <div className="space-y-1">
                {found.map((d) => (
                  <div
                    key={d.name}
                    className="flex items-center gap-3 text-xs"
                  >
                    <span className="text-green-500">✓</span>
                    <span className="font-mono text-zinc-400 w-24">
                      {d.name}
                    </span>
                    <span className="text-zinc-600 truncate">{d.path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end p-5 pt-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm text-zinc-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
