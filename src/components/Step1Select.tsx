import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppState, PageThumbnail } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
}

const BATCH_SIZE = 6; // load thumbnails in batches

export function Step1Select({ state, updateState, onNext }: Props) {
  const [loadingCount, setLoadingCount] = useState(false);
  const [loadingThumbs, setLoadingThumbs] = useState(false);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [loadedUpTo, setLoadedUpTo] = useState(0);
  const [apiKey, setApiKey] = useState(state.apiKey || "");
  const [showApiKey, setShowApiKey] = useState(!state.apiKey);
  const gridRef = useRef<HTMLDivElement>(null);

  // When file changes, get page count
  useEffect(() => {
    if (!state.filePath || !state.fileType) return;
    setLoadingCount(true);
    setThumbs(new Map());
    setLoadedUpTo(0);
    invoke<number>("get_page_count", {
      filePath: state.filePath,
      fileType: state.fileType,
    })
      .then((count) => {
        updateState({ pageCount: count });
        setLoadingCount(false);
      })
      .catch(() => setLoadingCount(false));
  }, [state.filePath, state.fileType]);

  // Load first batch when page count is known
  useEffect(() => {
    if (!state.pageCount || !state.filePath || !state.fileType) return;
    loadBatch(1, Math.min(BATCH_SIZE, state.pageCount));
  }, [state.pageCount]);

  const loadBatch = async (from: number, to: number) => {
    if (!state.filePath || !state.fileType) return;
    setLoadingThumbs(true);
    const pages: number[] = [];
    for (let i = from; i <= to; i++) pages.push(i);

    try {
      const results = await invoke<PageThumbnail[]>("render_page_thumbnails", {
        sessionId: state.sessionId,
        filePath: state.filePath,
        fileType: state.fileType,
        pages,
      });
      setThumbs((prev) => {
        const next = new Map(prev);
        for (const r of results) next.set(r.page, r.data);
        return next;
      });
      setLoadedUpTo(to);
    } catch (e) {
      console.error("render thumbnails failed:", e);
    } finally {
      setLoadingThumbs(false);
    }
  };

  const loadMore = () => {
    if (!state.pageCount) return;
    const from = loadedUpTo + 1;
    const to = Math.min(loadedUpTo + BATCH_SIZE, state.pageCount);
    if (from <= to) loadBatch(from, to);
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "PDF/DjVu", extensions: ["pdf", "djvu", "djv"] }],
    });
    if (selected) {
      const path = selected as string;
      const ext = path.split(".").pop()?.toLowerCase();
      const fileType = ext === "djvu" || ext === "djv" ? "djvu" : "pdf";
      updateState({
        filePath: path,
        fileType,
        pageCount: null,
        selectedPages: [],
        aiDone: false,
        tocEntries: [],
      });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      const path = (file as File & { path?: string }).path || file.name;
      const ext = path.split(".").pop()?.toLowerCase();
      const fileType = ext === "djvu" || ext === "djv" ? "djvu" : "pdf";
      updateState({
        filePath: path,
        fileType,
        pageCount: null,
        selectedPages: [],
        aiDone: false,
        tocEntries: [],
      });
    }
  };

  const togglePage = (page: number) => {
    const sel = state.selectedPages;
    if (sel.includes(page)) {
      updateState({ selectedPages: sel.filter((p) => p !== page) });
    } else {
      updateState({ selectedPages: [...sel, page].sort((a, b) => a - b) });
    }
  };

  const saveApiKey = () => {
    localStorage.setItem("ai_gateway_key", apiKey);
    updateState({ apiKey });
    setShowApiKey(false);
  };

  const saveMetadata = (meta: typeof state.metadata) => {
    updateState({ metadata: meta });
    if (!state.sessionId) return;
    invoke("set_metadata", { sessionId: state.sessionId, meta });
  };

  const fileName = state.filePath ? state.filePath.split("/").pop() : null;

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-72 flex-shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="p-5 flex-1 overflow-y-auto">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">
            Step 1 — Select TOC Pages
          </h2>

          {/* File picker */}
          <div className="mb-5">
            <label className="block text-xs text-zinc-400 mb-1.5">Input File</label>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={pickFile}
              className={`border-2 border-dashed rounded-lg p-4 cursor-pointer transition-colors text-center ${
                state.filePath
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
                  <div className="text-xs text-zinc-500 mt-1 uppercase">{state.fileType}</div>
                  {state.pageCount && (
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {state.pageCount} pages
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="text-zinc-500 text-2xl mb-2">+</div>
                  <div className="text-xs text-zinc-500">Drop PDF/DjVu or click to pick</div>
                </div>
              )}
            </div>
          </div>

          {/* Selected pages summary */}
          {state.selectedPages.length > 0 && (
            <div className="mb-5">
              <label className="block text-xs text-zinc-400 mb-2">
                Selected TOC Pages ({state.selectedPages.length})
              </label>
              <div className="flex flex-wrap gap-1">
                {state.selectedPages.map((p) => (
                  <span
                    key={p}
                    onClick={() => togglePage(p)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-900 text-indigo-300 rounded text-xs cursor-pointer hover:bg-indigo-800"
                  >
                    {p} <span className="text-indigo-500">×</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* API Key section */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-zinc-400">AI Gateway Key</label>
              {!showApiKey && state.apiKey && (
                <button
                  onClick={() => setShowApiKey(true)}
                  className="text-xs text-zinc-600 hover:text-zinc-400"
                >
                  Edit
                </button>
              )}
            </div>
            {showApiKey ? (
              <div className="space-y-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={saveApiKey}
                  disabled={!apiKey}
                  className="w-full py-1.5 bg-indigo-700 hover:bg-indigo-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded text-xs text-white transition-colors"
                >
                  Save Key
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                {state.apiKey ? (
                  <span className="text-green-400">✓ Key saved</span>
                ) : (
                  <span className="text-amber-400">⚠ Key not set</span>
                )}
              </div>
            )}
          </div>

          {/* Page offset */}
          {state.selectedPages.length > 0 && (
            <div className="space-y-3 border-t border-zinc-800 pt-3">
              <p className="text-xs font-semibold text-zinc-400">Page Adjustments</p>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">
                    Offset <span className="text-zinc-600">(PDF − printed)</span>
                  </label>
                  <input
                    type="number"
                    value={state.metadata.offset}
                    onChange={(e) =>
                      saveMetadata({ ...state.metadata, offset: Number(e.target.value) })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">Cover pages</label>
                  <input
                    type="text"
                    value={state.metadata.if_cover}
                    onChange={(e) =>
                      saveMetadata({ ...state.metadata, if_cover: e.target.value })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Next button */}
        <div className="p-5 border-t border-zinc-800">
          <button
            onClick={onNext}
            disabled={state.selectedPages.length === 0 || !state.apiKey}
            className="w-full py-2.5 bg-green-700 hover:bg-green-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {!state.apiKey
              ? "Set API key first"
              : state.selectedPages.length === 0
              ? "Select TOC pages"
              : `Continue with ${state.selectedPages.length} page(s) →`}
          </button>
        </div>
      </div>

      {/* Right: page grid */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500 font-medium">
            {state.pageCount
              ? `Page Preview — click to select TOC pages`
              : "Open a file to preview pages"}
          </span>
          {loadingThumbs && (
            <span className="text-xs text-zinc-600 animate-pulse">Loading...</span>
          )}
          {loadingCount && (
            <span className="text-xs text-zinc-600 animate-pulse">Detecting pages...</span>
          )}
        </div>

        <div ref={gridRef} className="flex-1 overflow-y-auto p-4">
          {!state.filePath ? (
            <div className="text-center text-zinc-700 mt-20">
              <div className="text-5xl mb-4">📄</div>
              <div className="text-sm">Open a PDF or DjVu file to preview pages</div>
              <div className="text-xs mt-2 text-zinc-800">
                Then click the pages that contain the Table of Contents
              </div>
            </div>
          ) : (
            <div>
              {/* Page grid */}
              <div className="grid grid-cols-3 gap-4 mb-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
                {state.pageCount &&
                  Array.from({ length: Math.min(loadedUpTo, state.pageCount) }, (_, i) => i + 1).map((page) => {
                    const thumb = thumbs.get(page);
                    const isSelected = state.selectedPages.includes(page);
                    return (
                      <div
                        key={page}
                        onClick={() => togglePage(page)}
                        className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                          isSelected
                            ? "border-indigo-500 shadow-lg shadow-indigo-900/50"
                            : "border-zinc-700 hover:border-zinc-500"
                        }`}
                      >
                        {/* Thumbnail */}
                        <div className="bg-zinc-800 aspect-[3/4] flex items-center justify-center">
                          {thumb ? (
                            <img
                              src={`data:image/png;base64,${thumb}`}
                              alt={`Page ${page}`}
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <div className="text-zinc-700 text-xs text-center p-4">
                              <div className="text-2xl mb-1">⟳</div>
                              <div>Loading...</div>
                            </div>
                          )}
                        </div>

                        {/* Page number label */}
                        <div
                          className={`absolute bottom-0 left-0 right-0 text-center py-1 text-xs font-medium ${
                            isSelected
                              ? "bg-indigo-600 text-white"
                              : "bg-zinc-900/80 text-zinc-400"
                          }`}
                        >
                          {isSelected && <span className="mr-1">✓</span>}
                          Page {page}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Load more button */}
              {state.pageCount && loadedUpTo < state.pageCount && (
                <div className="text-center mt-2 mb-6">
                  <button
                    onClick={loadMore}
                    disabled={loadingThumbs}
                    className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs text-zinc-300 transition-colors"
                  >
                    {loadingThumbs
                      ? "Loading..."
                      : `Load more (${loadedUpTo}/${state.pageCount} loaded)`}
                  </button>
                </div>
              )}

              {/* Empty loading state */}
              {loadedUpTo === 0 && loadingThumbs && (
                <div className="text-center text-zinc-700 mt-20">
                  <div className="text-4xl mb-3 animate-spin">⟳</div>
                  <div className="text-sm">Rendering page thumbnails...</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
