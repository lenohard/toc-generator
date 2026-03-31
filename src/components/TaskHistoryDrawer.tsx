import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TaskHistoryRecord } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onLoadTask: (r: TaskHistoryRecord) => void;
}

function formatCost(cost: number | null): string {
  if (cost === null) return "-";
  if (cost < 0.0001) return `$${cost.toExponential(2)}`;
  return `$${cost.toFixed(6)}`;
}

export function TaskHistoryDrawer({ open, onClose, onLoadTask }: Props) {
  const [rows, setRows] = useState<TaskHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await invoke<TaskHistoryRecord[]>("list_task_history", { limit: 200 });
      setRows(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-[560px] max-w-[95vw] bg-zinc-900 border-l border-zinc-800 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-zinc-200">Generation Task History</div>
            <div className="text-xs text-zinc-500">PDF/DjVu merge jobs across sessions</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
            >
              Refresh
            </button>
            <button
              onClick={async () => {
                await invoke("clear_task_history");
                setRows([]);
              }}
              className="px-2 py-1 text-xs bg-red-900/40 hover:bg-red-900/60 text-red-300 rounded"
            >
              Clear
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm">
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && <div className="text-xs text-zinc-500">Loading history...</div>}
          {error && <div className="text-xs text-red-400">{error}</div>}
          {!loading && rows.length === 0 && (
            <div className="text-xs text-zinc-600">No generation task history yet.</div>
          )}

          {rows.map((r) => (
            <div key={r.id} className="bg-zinc-800/70 border border-zinc-700 rounded-lg p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className={r.success ? "text-green-400" : "text-red-400"}>
                  {r.success ? "✓ Success" : "✕ Failed"}
                </span>
                <span className="text-zinc-500">{new Date(r.at).toLocaleString()}</span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-400">
                <div>Type: <span className="text-zinc-200 uppercase">{r.fileType}</span></div>
                <div>TOC: <span className="text-zinc-200">{r.tocCount}</span></div>
                <div>Pages: <span className="text-zinc-200">{r.selectedPages.join(",") || "-"}</span></div>
                <div>Duration: <span className="text-zinc-200">{Math.round(r.durationMs / 1000)}s</span></div>
                <div>Offset: <span className="text-zinc-200">{r.offset}</span></div>
                <div>Cover: <span className="text-zinc-200">{r.ifCover || "0"}</span></div>
                <div>Model: <span className="text-zinc-200">{r.model ?? "-"}</span></div>
                <div>Cost: <span className="text-zinc-200">{formatCost(r.costUsd)}</span></div>
                <div>Tokens: <span className="text-zinc-200">{r.totalTokens ?? "-"}</span></div>
              </div>

              <div className="mt-2 text-zinc-500 break-all">In: {r.inputFile}</div>
              <div className="text-zinc-500 break-all mb-2">Out: {r.outputFile}</div>
              
              <div className="flex items-center gap-2 pt-2 border-t border-zinc-700/50">
                <button
                  onClick={() => onLoadTask(r)}
                  className="px-3 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded text-xs font-medium transition-colors"
                >
                  Load into current session
                </button>
              </div>

              {r.error && <div className="mt-2 text-red-400 break-all">Error: {r.error}</div>}

              {r.logs?.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-zinc-400">Logs ({r.logs.length})</summary>
                  <pre className="mt-1 p-2 rounded bg-zinc-950 text-zinc-500 whitespace-pre-wrap overflow-auto max-h-28">
                    {r.logs.join("\n")}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
