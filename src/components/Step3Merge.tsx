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

function Toggle({
  checked,
  onChange,
  disabled,
  danger = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? (danger ? "bg-red-700" : "bg-indigo-600") : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

export function Step3Merge({ state, updateState, onBack, onStartNewTask }: Props) {
  const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
  const [tocError, setTocError] = useState("");
  const [tocLoading, setTocLoading] = useState(true);
  const [tocRevision, setTocRevision] = useState(0);
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
  const [previewError, setPreviewError] = useState("");
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);

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
    setTocLoading(true);
    setTocError("");
    invoke<TocEntry[]>("preview_toc", { sessionId: state.sessionId })
      .then((entries) => {
        setTocEntries(entries);
        setTocError("");
      })
      .catch((err) => setTocError(String(err)))
      .finally(() => setTocLoading(false));
  }, [state.sessionId, tocRevision]);

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
    if (previewPage === null && !showMergeConfirm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showMergeConfirm) {
        setShowMergeConfirm(false);
      } else {
        setPreviewPage(null);
        setPreviewImage("");
        setPreviewError("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewPage, showMergeConfirm]);

  const closePreview = () => {
    setPreviewPage(null);
    setPreviewImage("");
    setPreviewError("");
  };

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

  const requestMerge = () => {
    if (deleteOriginal) setShowMergeConfirm(true);
    else void runMerge();
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
    setPreviewError("");
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
      const message = String(e);
      setPreviewError(message);
      setLogs((prev) => [...prev, `Preview error (page ${page}): ${message}`]);
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

        <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950">
          {tocLoading ? (
            <div className="mt-12 text-center text-sm text-zinc-500" role="status">
              <span className="mr-2 inline-block animate-spin" aria-hidden="true">⟳</span>
              Loading TOC preview…
            </div>
          ) : tocError ? (
            <div className="m-4 rounded-lg border border-red-900/70 bg-red-950/30 p-4" role="alert">
              <p className="text-sm font-medium text-red-300">Could not load TOC preview</p>
              <p className="mt-1 break-words text-xs text-red-400">{tocError}</p>
              <button
                type="button"
                onClick={() => setTocRevision((revision) => revision + 1)}
                className="mt-3 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                Retry preview
              </button>
            </div>
          ) : tocEntries.length === 0 ? (
            <div className="mt-12 text-center text-sm text-zinc-500">
              <div className="mb-3 text-3xl" aria-hidden="true">📑</div>
              <div>No TOC entries are available to merge.</div>
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
                    tabIndex={0}
                    onClick={() => openEntryPreview(entry.page)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void openEntryPreview(entry.page);
                      }
                    }}
                    className="cursor-pointer border-t border-zinc-800/50 hover:bg-zinc-800/20 focus:bg-zinc-800/30 focus:outline-none"
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
          <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 px-3">
            <div className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-300">Delete original file</span>
                <Toggle
                  checked={deleteOriginal}
                  onChange={setDeleteOriginal}
                  disabled={running}
                  danger
                  label="Delete original file after merge"
                />
              </div>
              <p className="mt-1 pr-10 text-xs text-zinc-500">
                Remove the source only after a successful merge
              </p>
            </div>

            <div className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-300">Keep existing bookmarks</span>
                <Toggle
                  checked={mergeOriginal}
                  onChange={setMergeOriginal}
                  disabled={running}
                  label="Keep existing bookmarks"
                />
              </div>
              <p className="mt-1 pr-10 text-xs text-zinc-500">
                Prepend original {fileLabel} bookmarks before the new TOC
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
              role="log"
              aria-live="polite"
              className="h-36 overflow-y-auto rounded-lg bg-zinc-950 p-2 font-mono text-xs"
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
            type="button"
            onClick={requestMerge}
            disabled={running || tocLoading || tocEntries.length === 0 || !outputPath}
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

      {showMergeConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setShowMergeConfirm(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="merge-confirm-title"
            className="flex h-[250px] w-[440px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 id="merge-confirm-title" className="text-sm font-semibold text-zinc-100">
                Generate and delete the original?
              </h2>
              <p className="mt-1 text-xs text-zinc-500">This action cannot be undone</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-xs leading-relaxed text-zinc-400">
              <p>
                The merged {fileLabel} will be created first. The original source file will then be permanently deleted.
              </p>
              <p className="mt-2 break-all font-mono text-zinc-500">{state.filePath}</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
              <button
                type="button"
                autoFocus
                onClick={() => setShowMergeConfirm(false)}
                className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMergeConfirm(false);
                  void runMerge();
                }}
                className="rounded-md bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-600"
              >
                Generate & delete original
              </button>
            </div>
          </section>
        </div>
      )}

      {/* TOC entry page preview modal */}
      {previewPage !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={closePreview}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-preview-title"
            className="flex h-[80vh] max-h-[820px] w-[80vw] max-w-[1100px] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-700 px-3 py-2">
              <span id="entry-preview-title" className="text-xs text-zinc-300">
                Page {previewPage} preview
              </span>
              <button
                type="button"
                autoFocus
                onClick={closePreview}
                aria-label="Close page preview"
                className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-zinc-950 p-3">
              {previewLoading ? (
                <div className="text-xs text-zinc-400" role="status">
                  <span className="mr-2 inline-block animate-spin" aria-hidden="true">⟳</span>
                  Loading page image…
                </div>
              ) : previewError ? (
                <div className="max-w-md text-center" role="alert">
                  <p className="text-sm font-medium text-red-300">Could not render this page</p>
                  <p className="mt-2 break-words text-xs text-red-400">{previewError}</p>
                  <button
                    type="button"
                    onClick={() => void openEntryPreview(previewPage)}
                    className="mt-3 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
                  >
                    Retry preview
                  </button>
                </div>
              ) : previewImage ? (
                <img
                  src={previewImage}
                  alt={`Entry preview page ${previewPage}`}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="text-sm text-zinc-500">No preview available</div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
