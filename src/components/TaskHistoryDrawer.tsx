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
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [notice, setNotice] = useState("");

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

  const clearHistory = async () => {
    setClearing(true);
    setClearError("");
    setNotice("");
    try {
      await invoke("clear_task_history");
      setRows([]);
      setShowClearConfirm(false);
      setNotice("Task history cleared.");
    } catch (e) {
      setClearError(String(e));
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showClearConfirm) {
        if (!clearing) setShowClearConfirm(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, showClearConfirm, clearing, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        className="absolute right-0 top-0 flex h-dvh w-[560px] max-w-[95vw] flex-col border-l border-zinc-800 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <div id="history-title" className="text-sm font-semibold text-zinc-200">Generation Task History</div>
            <div className="text-xs text-zinc-500">PDF/DjVu merge jobs across sessions</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading || clearing}
              className="rounded px-2 py-1 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => {
                setClearError("");
                setNotice("");
                setShowClearConfirm(true);
              }}
              disabled={rows.length === 0 || loading || clearing}
              className="rounded bg-red-900/40 px-2 py-1 text-xs text-red-300 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close task history"
              className="rounded px-1.5 py-1 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {notice && (
            <div role="status" className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
              {notice}
            </div>
          )}
          {loading && rows.length === 0 && (
            <div role="status" className="px-1 py-6 text-center text-xs text-zinc-500">Loading history…</div>
          )}
          {error && (
            <div role="alert" className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-xs">
              <p className="break-words text-red-300">{error}</p>
              <button type="button" onClick={load} className="mt-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700">
                Retry
              </button>
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div className="px-1 py-6 text-center text-xs text-zinc-600">No generation task history yet.</div>
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
      </aside>

      {showClearConfirm && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-6"
          onClick={() => {
            if (!clearing) setShowClearConfirm(false);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-history-title"
            className="flex h-[220px] w-[400px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 id="clear-history-title" className="text-sm font-semibold text-zinc-100">
                Clear all task history?
              </h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-xs leading-relaxed text-zinc-400">
              <p>This permanently removes all saved merge records. Generated documents are not affected.</p>
              {clearError && <p role="alert" className="mt-2 break-words text-red-400">{clearError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
              <button
                type="button"
                autoFocus
                onClick={() => setShowClearConfirm(false)}
                disabled={clearing}
                className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={clearHistory}
                disabled={clearing}
                className="min-w-24 rounded-md bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:cursor-wait disabled:opacity-60"
              >
                {clearing ? "Clearing…" : "Clear history"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
