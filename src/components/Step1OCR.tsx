import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppState, OcrOptions } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
}

interface LogEvent {
  session_id: string;
  line: string;
  done: boolean;
  success: boolean;
}

export function Step1OCR({ state, updateState, onNext }: Props) {
  const [filePath, setFilePath] = useState(state.filePath || "");
  const [firstPage, setFirstPage] = useState(1);
  const [lastPage, setLastPage] = useState(10);
  const [useTextcleaner, setUseTextcleaner] = useState(false);
  const [language, setLanguage] = useState("eng");
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [ocrDone, setOcrDone] = useState(state.ocrDone);
  const logRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<LogEvent>("ocr-log", (event) => {
        const { line, done, success, session_id } = event.payload;
        if (session_id !== state.sessionId) return;
        setLogs((prev) => [...prev, line]);
        if (done) {
          setRunning(false);
          if (success) {
            setOcrDone(true);
            updateState({ ocrDone: true });
          }
        }
      });
      unlistenRef.current = unlisten;
    };
    setup();
    return () => {
      unlistenRef.current?.();
    };
  }, [state.sessionId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "PDF/DjVu", extensions: ["pdf", "djvu", "djv"] },
      ],
    });
    if (selected) {
      const path = selected as string;
      setFilePath(path);
      const ext = path.split(".").pop()?.toLowerCase();
      const fileType = ext === "djvu" || ext === "djv" ? "djvu" : "pdf";
      updateState({ filePath: path, fileType });
      setLogs([]);
      setOcrDone(false);
      updateState({ ocrDone: false });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      // Tauri gives us path via the file object in desktop mode
      const path = (file as File & { path?: string }).path || file.name;
      setFilePath(path);
      const ext = path.split(".").pop()?.toLowerCase();
      const fileType = ext === "djvu" || ext === "djv" ? "djvu" : "pdf";
      updateState({ filePath: path, fileType });
      setLogs([]);
      setOcrDone(false);
      updateState({ ocrDone: false });
    }
  };

  const runOcr = async () => {
    if (!filePath || !state.sessionId) return;
    setRunning(true);
    setLogs([]);
    setOcrDone(false);
    updateState({ ocrDone: false });

    const opts: OcrOptions = {
      session_id: state.sessionId,
      file_path: filePath,
      first_page: firstPage,
      last_page: lastPage,
      use_textcleaner: useTextcleaner,
      language,
    };

    try {
      await invoke("run_ocr", { opts });
    } catch (err) {
      setLogs((prev) => [...prev, `Error: ${err}`]);
      setRunning(false);
    }
  };

  const fileName = filePath ? filePath.split("/").pop() : null;

  return (
    <div className="flex h-full">
      {/* Left panel: settings */}
      <div className="w-80 flex-shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="p-5 flex-1 overflow-y-auto">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
            Step 1 — OCR
          </h2>

          {/* File picker */}
          <div className="mb-5">
            <label className="block text-xs text-zinc-400 mb-1.5">
              Input File
            </label>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={pickFile}
              className={`border-2 border-dashed rounded-lg p-4 cursor-pointer transition-colors text-center ${
                filePath
                  ? "border-indigo-600 bg-indigo-950/30"
                  : "border-zinc-700 hover:border-zinc-600 bg-zinc-800/50"
              }`}
            >
              {fileName ? (
                <div>
                  <div className="text-indigo-400 text-lg mb-1">
                    {state.fileType === "djvu" ? "📚" : "📄"}
                  </div>
                  <div className="text-xs text-zinc-300 break-all">{fileName}</div>
                  <div className="text-xs text-zinc-500 mt-1 uppercase">
                    {state.fileType}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-zinc-500 text-2xl mb-2">+</div>
                  <div className="text-xs text-zinc-500">
                    Drop PDF/DjVu or click to pick
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Page range */}
          <div className="mb-5">
            <label className="block text-xs text-zinc-400 mb-1.5">
              TOC Page Range
            </label>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-zinc-600 mb-1">First</label>
                <input
                  type="number"
                  min={1}
                  value={firstPage}
                  onChange={(e) => setFirstPage(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-zinc-600 mb-1">Last</label>
                <input
                  type="number"
                  min={1}
                  value={lastPage}
                  onChange={(e) => setLastPage(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Language */}
          <div className="mb-5">
            <label className="block text-xs text-zinc-400 mb-1.5">
              OCR Language
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="eng">English</option>
              <option value="chi_sim">Simplified Chinese</option>
              <option value="chi_tra">Traditional Chinese</option>
              <option value="fra">French</option>
              <option value="deu">German</option>
              <option value="spa">Spanish</option>
            </select>
          </div>

          {/* Textcleaner */}
          <div className="mb-5">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <div
                onClick={() => setUseTextcleaner(!useTextcleaner)}
                className={`w-9 h-5 rounded-full transition-colors relative ${
                  useTextcleaner ? "bg-indigo-600" : "bg-zinc-700"
                }`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    useTextcleaner ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </div>
              <span className="text-sm text-zinc-300">
                Preprocess with textcleaner
              </span>
            </label>
            <p className="text-xs text-zinc-600 mt-1 ml-11">
              Improves OCR on noisy scans
            </p>
          </div>
        </div>

        {/* Run button */}
        <div className="p-5 border-t border-zinc-800">
          <button
            onClick={runOcr}
            disabled={!filePath || running}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
          >
            {running ? (
              <>
                <span className="animate-spin">⟳</span> Running OCR...
              </>
            ) : (
              "▶ Run OCR"
            )}
          </button>
        </div>
      </div>

      {/* Right panel: log output */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500 font-medium">OCR Output</span>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              className="text-xs text-zinc-600 hover:text-zinc-400"
            >
              Clear
            </button>
          )}
        </div>

        <div
          ref={logRef}
          className="flex-1 overflow-y-auto p-4 terminal text-zinc-400"
        >
          {logs.length === 0 ? (
            <div className="text-zinc-700 text-center mt-12">
              <div className="text-4xl mb-3">⟳</div>
              <div>OCR output will appear here</div>
            </div>
          ) : (
            logs.map((line, i) => (
              <div
                key={i}
                className={`leading-relaxed ${
                  line.startsWith("✓")
                    ? "text-green-400"
                    : line.startsWith("Error") || line.startsWith("error")
                    ? "text-red-400"
                    : line.startsWith("$")
                    ? "text-zinc-500"
                    : "text-zinc-300"
                }`}
              >
                {line}
              </div>
            ))
          )}
        </div>

        {/* Next button */}
        {ocrDone && (
          <div className="p-4 border-t border-zinc-800">
            <button
              onClick={onNext}
              className="w-full py-2.5 bg-green-700 hover:bg-green-600 rounded-lg text-sm font-medium text-white transition-colors"
            >
              Continue to Step 2: Build Rules →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
