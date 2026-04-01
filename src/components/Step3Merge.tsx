import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { AppState, MergeOptions, PageThumbnail, TocEntry } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onBack: () => void;
  onStartNewTask: () => void;
}

interface MergeLogEvent {
  session_id: string;
  line: string;
  done: boolean;
  success: boolean;
}

export function Step3Merge({ state, updateState, onBack, onStartNewTask }: Props) {
  const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
  const [tocError, setTocError] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [mergeOriginal, setMergeOriginal] = useState(false);
  const [deleteOriginal, setDeleteOriginal] = useState(true);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<string[]>([]);
  const runGuardRef = useRef(false);
  const runStartedAtRef = useRef<number>(0);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [previewImage, setPreviewImage] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  // Auto-generate default output path
  useEffect(() => {
    if (state.filePath) {
      const base = state.filePath.replace(/\.[^/.]+$/, "");
      const ext = state.fileType === "djvu" ? ".djvu" : ".pdf";
      setOutputPath(`${base}_ocr${ext}`);
    }
  }, [state.filePath, state.fileType]);

  // Load TOC preview
  useEffect(() => {
    if (!state.sessionId) return;
    invoke<TocEntry[]>("preview_toc", { sessionId: state.sessionId })
      .then((entries) => {
        setTocEntries(entries);
        setTocError("");
      })
      .catch((err) => setTocError(String(err)));
  }, [state.sessionId]);

  // Listen for merge logs
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    listen<MergeLogEvent>("merge-log", (event) => {
      const { line, done, success, session_id } = event.payload;
      if (session_id !== state.sessionId) return;
      setLogs((prev) => (prev[prev.length - 1] === line ? prev : [...prev, line]));
      if (done) {
        setRunning(false);
        runGuardRef.current = false;
        setDone(success);
      }
    }).then((off) => {
      if (!active) {
        off();
        return;
      }
      unlisten = off;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [state.sessionId]);

  useEffect(() => {
    logsRef.current = logs;
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (previewPage === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreviewPage(null);
        setPreviewImage("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewPage]);

  const pickOutputPath = async () => {
    const selected = await save({
      defaultPath: outputPath,
      filters: [
        state.fileType === "djvu"
          ? { name: "DjVu", extensions: ["djvu"] }
          : { name: "PDF", extensions: ["pdf"] },
      ],
    });
    if (selected) setOutputPath(selected);
  };

  const runMerge = async () => {
    if (!state.sessionId || !state.filePath || !state.fileType || !outputPath || runGuardRef.current) return;
    runGuardRef.current = true;
    runStartedAtRef.current = Date.now();
    setRunning(true);
    setDone(false);
    setLogs([]);
    setFinalOutput(null);

    const opts: MergeOptions = {
      session_id: state.sessionId,
      input_file: state.filePath,
      output_file: outputPath,
      merge_original: mergeOriginal,
    };

    try {
      const result = await invoke<string>("run_merge", { opts });
      setFinalOutput(result);
      updateState({ outputFile: result });

      // Delete original if requested
      if (deleteOriginal && state.filePath && result !== state.filePath) {
        try {
          await invoke("delete_file", { path: state.filePath });
          setLogs((prev) => [...prev, `✓ Original file deleted`]);
        } catch (e) {
          setLogs((prev) => [...prev, `Warning: could not delete original: ${String(e)}`]);
        }
      }

      await invoke("append_task_history", {
        record: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
          fileType: state.fileType,
          inputFile: state.filePath,
          outputFile: result,
          selectedPages: state.selectedPages,
          offset: state.metadata.offset,
          ifCover: state.metadata.if_cover,
          model: state.aiRunInfo?.model ?? null,
          promptTokens: state.aiRunInfo?.usage.promptTokens ?? null,
          completionTokens: state.aiRunInfo?.usage.completionTokens ?? null,
          totalTokens: state.aiRunInfo?.usage.totalTokens ?? null,
          costUsd: state.aiRunInfo?.usage.costUsd ?? null,
          tocCount: tocEntries.length,
          tocEntries: state.tocEntries,
          durationMs: Date.now() - runStartedAtRef.current,
          success: true,
          error: null,
          logs: logsRef.current,
        },
      });
    } catch (err) {
      const msg = String(err);
      setLogs((prev) => [...prev, `Error: ${msg}`]);
      setRunning(false);
      runGuardRef.current = false;

      await invoke("append_task_history", {
        record: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
          fileType: state.fileType,
          inputFile: state.filePath,
          outputFile: outputPath,
          selectedPages: state.selectedPages,
          offset: state.metadata.offset,
          ifCover: state.metadata.if_cover,
          model: state.aiRunInfo?.model ?? null,
          promptTokens: state.aiRunInfo?.usage.promptTokens ?? null,
          completionTokens: state.aiRunInfo?.usage.completionTokens ?? null,
          totalTokens: state.aiRunInfo?.usage.totalTokens ?? null,
          costUsd: state.aiRunInfo?.usage.costUsd ?? null,
          tocCount: tocEntries.length,
          tocEntries: state.tocEntries,
          durationMs: Date.now() - runStartedAtRef.current,
          success: false,
          error: msg,
          logs: [...logsRef.current, `Error: ${msg}`],
        },
      }).catch(() => undefined);
    }
  };

  const openEntryPreview = async (page: number) => {
    if (!state.sessionId || !state.filePath || !state.fileType || !page || page < 1) return;

    setPreviewPage(page);
    setPreviewImage("");
    setPreviewLoading(true);

    try {
      const [result] = await invoke<PageThumbnail[]>("render_pages_for_ai", {
        sessionId: state.sessionId,
        filePath: state.filePath,
        fileType: state.fileType,
        pages: [page],
      });
      if (result) {
        setPreviewImage(`data:${result.mime};base64,${result.data}`);
      }
    } catch (e) {
      setLogs((prev) => [...prev, `Preview error (page ${page}): ${String(e)}`]);
    } finally {
      setPreviewLoading(false);
    }
  };

  const openFile = async () => {
    if (!finalOutput) return;
    try {
      await invoke("open_output_file", { path: finalOutput });
    } catch (err) {
      setLogs((prev) => [...prev, `Error opening file: ${err}`]);
    }
  };

  const revealFile = async () => {
    if (!finalOutput) return;
    try {
      await invoke("reveal_output_file", { path: finalOutput });
    } catch (err) {
      setLogs((prev) => [...prev, `Error revealing file: ${err}`]);
    }
  };

  // Indent based on level
  const levelIndent = (level: number) => (level - 1) * 16;
  const fileLabel = state.fileType === "djvu" ? "DjVu" : "PDF";
  // Hide the "Printed" column when all entries have no meaningful raw_page
  // (e.g. loaded from existing bookmarks where raw_page === String(page))
  const showPrintedCol = tocEntries.some((e) => e.raw_page && e.raw_page !== String(e.page));

  return (
    <div className="flex h-full">
      {/* Left: TOC preview */}
      <div className="flex-1 flex flex-col border-r border-zinc-800">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
          <span className="text-xs font-medium text-zinc-500">
            TOC Preview (click an entry to open that page)
          </span>
          {tocEntries.length > 0 && (
            <span className="text-xs text-zinc-600">
              {tocEntries.length} entries
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-zinc-950">
          {tocError ? (
            <div className="p-4 text-sm text-red-400">{tocError}</div>
          ) : tocEntries.length === 0 ? (
            <div className="text-center text-zinc-700 mt-12 text-sm">
              <div className="text-3xl mb-3">📑</div>
              <div>Loading TOC preview...</div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr className="text-zinc-500">
                  <th className="text-left px-4 py-2">Title</th>
                  <th className="text-right px-4 py-2 w-20">{fileLabel} Page</th>
                  {showPrintedCol && <th className="text-right px-4 py-2 w-16">Printed</th>}
                </tr>
              </thead>
              <tbody>
                {tocEntries.map((entry, i) => (
                  <tr
                    key={i}
                    onClick={() => openEntryPreview(entry.page)}
                    className={`border-t border-zinc-800/50 hover:bg-zinc-800/20 cursor-pointer ${
                      entry.level === 1 ? "" : ""
                    }`}
                    title={`Open page ${entry.page} for quick verification`}
                  >
                    <td
                      className="px-4 py-1.5 text-zinc-300"
                      style={{ paddingLeft: `${16 + levelIndent(entry.level)}px` }}
                    >
                      {entry.level > 1 && (
                        <span className="text-zinc-700 mr-1">└</span>
                      )}
                      <span
                        className={
                          entry.level === 1
                            ? "text-zinc-200 font-medium"
                            : "text-zinc-400"
                        }
                      >
                        {entry.title}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-indigo-400">
                      {entry.page}
                    </td>
                    {showPrintedCol && (
                      <td className="px-4 py-1.5 text-right font-mono text-zinc-600">
                        {entry.raw_page}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right: Controls + log */}
      <div className="w-80 flex-shrink-0 flex flex-col bg-zinc-900">
        <div className="px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Step 3 — Merge
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Output path */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              Output File
            </label>
            <div className="flex gap-1">
              <input
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <button
                onClick={pickOutputPath}
                className="px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 flex-shrink-0"
              >
                …
              </button>
            </div>
          </div>

          {/* Options */}
          <div className="space-y-3">
            <div>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <div
                  onClick={() => setDeleteOriginal(!deleteOriginal)}
                  className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${
                    deleteOriginal ? "bg-red-700" : "bg-zinc-700"
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      deleteOriginal ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </div>
                <span className="text-xs text-zinc-300">
                  Delete original file
                </span>
              </label>
              <p className="text-xs text-zinc-600 mt-1 ml-11">
                Remove source file after successful merge
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <div
                  onClick={() => setMergeOriginal(!mergeOriginal)}
                  className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${
                    mergeOriginal ? "bg-indigo-600" : "bg-zinc-700"
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      mergeOriginal ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </div>
                <span className="text-xs text-zinc-300">
                  Keep existing bookmarks
                </span>
              </label>
              <p className="text-xs text-zinc-600 mt-1 ml-11">
                Prepend original {fileLabel} bookmarks before new TOC
              </p>
            </div>
          </div>

          {/* Summary */}
          {tocEntries.length > 0 && (
            <div className="bg-zinc-800 rounded-lg p-3 space-y-1 text-xs">
              <div className="flex justify-between text-zinc-400">
                <span>TOC entries</span>
                <span className="text-zinc-200">{tocEntries.length}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>Page offset</span>
                <span className="text-zinc-200">{state.metadata.offset}</span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>Cover pages</span>
                <span className="text-zinc-200">
                  {state.metadata.if_cover || "0"}
                </span>
              </div>
              <div className="flex justify-between text-zinc-400">
                <span>Active rules</span>
                <span className="text-zinc-200">{state.rules.length}</span>
              </div>
            </div>
          )}

          {/* Log output */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              Output
            </label>
            <div
              ref={logRef}
              className="bg-zinc-950 rounded-lg p-2 h-36 overflow-y-auto terminal text-xs"
            >
              {logs.length === 0 ? (
                <span className="text-zinc-700">Log output will appear here</span>
              ) : (
                logs.map((line, i) => (
                  <div
                    key={i}
                    className={`leading-relaxed ${
                      line.startsWith("✓")
                        ? "text-green-400"
                        : line.startsWith("Error")
                        ? "text-red-400"
                        : "text-zinc-400"
                    }`}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Success actions */}
          {done && finalOutput && (
            <div className="space-y-2">
              <div className="bg-green-950 border border-green-800 rounded-lg p-3">
                <p className="text-xs text-green-400 font-medium mb-1">
                  ✓ {fileLabel} generated successfully
                </p>
                <p className="text-xs text-green-700 break-all font-mono">
                  {finalOutput.split("/").pop()}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={openFile}
                  className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs text-white transition-colors"
                >
                  Open {fileLabel}
                </button>
                <button
                  onClick={revealFile}
                  className="flex-1 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 transition-colors"
                >
                  Show in Finder
                </button>
              </div>
              <button
                onClick={onStartNewTask}
                className="w-full py-2 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-medium text-white transition-colors"
              >
                Start New Task
              </button>
            </div>
          )}
        </div>

        {/* Bottom buttons */}
        <div className="p-4 border-t border-zinc-800 flex gap-2">
          <button
            onClick={onBack}
            disabled={running}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded-lg text-xs text-zinc-300 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={runMerge}
            disabled={running || tocEntries.length === 0 || !outputPath}
            className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-xs font-medium text-white transition-colors flex items-center justify-center gap-2"
          >
            {running ? (
              <>
                <span className="animate-spin">⟳</span> Merging...
              </>
            ) : (
              `⚡ Generate ${fileLabel}`
            )}
          </button>
        </div>
      </div>

      {/* TOC entry page preview modal */}
      {previewPage !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => {
            setPreviewPage(null);
            setPreviewImage("");
          }}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh] bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
              <span className="text-xs text-zinc-300">Page {previewPage} preview</span>
              <button
                onClick={() => {
                  setPreviewPage(null);
                  setPreviewImage("");
                }}
                className="text-zinc-400 hover:text-zinc-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="w-[80vw] h-[80vh] bg-zinc-950 flex items-center justify-center">
              {previewLoading && (
                <div className="absolute text-xs text-zinc-400 bg-zinc-900/90 px-2 py-1 rounded">
                  Loading page image...
                </div>
              )}
              {previewImage ? (
                <img
                  src={previewImage}
                  alt={`Entry preview page ${previewPage}`}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                !previewLoading && <div className="text-zinc-600 text-sm">No preview available</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
