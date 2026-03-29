import type { DepStatus } from "../types";

interface Props {
  deps: DepStatus[];
  onClose: () => void;
}

export function DepsWarning({ deps, onClose }: Props) {
  const missing = deps.filter((d) => !d.found);
  const found = deps.filter((d) => d.found);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-[500px] shadow-2xl">
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

        <div className="p-5 space-y-4">
          {missing.length > 0 && (
            <div>
              <p className="text-sm text-amber-400 mb-3">
                The following tools are missing. Install via Homebrew:
              </p>
              <div className="bg-zinc-950 rounded-lg p-3 font-mono text-xs text-green-400 mb-3">
                brew install{" "}
                {missing
                  .map((d) => {
                    if (d.name === "ddjvu" || d.name === "djvused")
                      return "djvulibre";
                    if (d.name === "pdftoppm" || d.name === "pdftotext")
                      return "poppler";
                    if (d.name === "pdftk") return "pdftk-java";
                    return d.name;
                  })
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .join(" ")}
              </div>
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
