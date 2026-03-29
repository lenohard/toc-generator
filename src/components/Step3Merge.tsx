import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { AppState, MergeOptions, TocEntry } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onBack: () => void;
}

interface MergeLogEvent {
  session_id: string;
  line: string;
  done: boolean;
  success: boolean;
}

export function Step3Merge({ state, updateState, onBack }: Props) {
  const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
  const [tocError, setTocError] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [mergeOriginal, setMergeOriginal] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Auto-generate default output path
  useEffect(() => {
    if (state.filePath) {
      const base = state.filePath.replace(/\.[^/.]+$/, "");
      const ext = state.fileType === "djvu" ? ".djvu" : ".pdf";
      setOutputPath(`${base}_ocr${ext}`);
    }
  }, [state.filePath]);

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
    const setup = async () => {
      const unlisten = await listen<MergeLogEvent>("merge-log", (event) => {
        const { line, done, success, session_id } = event.payload;
        if (session_id !== state.sessionId) return;
        setLogs((prev) => [...prev, line]);
        if (done) {
          setRunning(false);
          setDone(success);
        }
      });
      unlistenRef.current = unlisten;
    };
    setup();
    return () => unlistenRef.current?.();
  }, [state.sessionId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

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
    if (!state.sessionId || !state.filePath || !outputPath) return;
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
    } catch (err) {
      setLogs((prev) => [...prev, `Error: ${err}`]);
      setRunning(false);
    }
  };

  const openFile = async () => {
    if (finalOutput) {
      await shellOpen(finalOutput);
    }
  };

  // Indent based on level
  const levelIndent = (level: number) => (level - 1) * 16;

  return (
    <div className="flex h-full">
      {/* Left: TOC preview */}
      <div className="flex-1 flex flex-col border-r border-zinc-800">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
          <span className="text-xs font-medium text-zinc-500">
            TOC Preview
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
                  <th className="text-right px-4 py-2 w-20">PDF Page</th>
                  <th className="text-right px-4 py-2 w-16">Printed</th>
                </tr>
              </thead>
              <tbody>
                {tocEntries.map((entry, i) => (
                  <tr
                    key={i}
                    className={`border-t border-zinc-800/50 hover:bg-zinc-800/20 ${
                      entry.level === 1 ? "" : ""
                    }`}
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
                    <td className="px-4 py-1.5 text-right font-mono text-zinc-600">
                      {entry.raw_page}
                    </td>
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
          <div>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <div
                onClick={() => setMergeOriginal(!mergeOriginal)}
                className={`w-9 h-5 rounded-full transition-colors relative ${
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
              Prepend original PDF bookmarks before new TOC
            </p>
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
                  ✓ PDF generated successfully
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
                  Open PDF
                </button>
                <button
                  onClick={async () => {
                    if (finalOutput) {
                      const dir = finalOutput.substring(0, finalOutput.lastIndexOf("/"));
                      await shellOpen(dir);
                    }
                  }}
                  className="flex-1 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 transition-colors"
                >
                  Show in Finder
                </button>
              </div>
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
              "⚡ Generate PDF"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
