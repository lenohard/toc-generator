import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppState, ExistingTocEntry, PageThumbnail, TocEntry } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
  onEditExisting: (entries: TocEntry[]) => void;
}

const BATCH_SIZE = 6; // load thumbnails in batches

export function Step1Select({ state, updateState, onNext, onEditExisting }: Props) {
  const [loadingCount, setLoadingCount] = useState(false);
  const [existingToc, setExistingToc] = useState<ExistingTocEntry[]>([]);
  const [existingTocLoading, setExistingTocLoading] = useState(false);
  const [showExistingToc, setShowExistingToc] = useState(false);
  const [loadingThumbs, setLoadingThumbs] = useState(false);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [loadedUpTo, setLoadedUpTo] = useState(0);
  const [apiKey, setApiKey] = useState(state.apiKey || "");
  const [showApiKey, setShowApiKey] = useState(!state.apiKey);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [previewImage, setPreviewImage] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // When file changes, create session if needed, then get page count
  useEffect(() => {
    if (!state.filePath || !state.fileType) return;
    setLoadingCount(true);
    setThumbs(new Map());
    setLoadedUpTo(0);

    const ensureSession = state.sessionId
      ? Promise.resolve(state.sessionId)
      : invoke<string>("create_session").then((id) => {
          updateState({ sessionId: id });
          return id;
        });

    ensureSession
      .then(() =>
        invoke<number>("get_page_count", {
          filePath: state.filePath,
          fileType: state.fileType,
        })
      )
      .then((count) => {
        updateState({ pageCount: count });
        setLoadingCount(false);
      })
      .catch((e) => {
        console.error("get_page_count error:", e);
        setLoadingCount(false);
      });
  }, [state.filePath, state.fileType]);

  // Detect existing bookmarks when a file is loaded
  useEffect(() => {
    if (!state.filePath || !state.fileType) {
      setExistingToc([]);
      setShowExistingToc(false);
      return;
    }
    setExistingTocLoading(true);
    setExistingToc([]);
    setShowExistingToc(false);
    invoke<ExistingTocEntry[]>("read_existing_toc", {
      filePath: state.filePath,
      fileType: state.fileType,
    })
      .then((entries) => {
        setExistingToc(entries);
        if (entries.length > 0) setShowExistingToc(true);
      })
      .catch(() => { /* silent - old files may fail */ })
      .finally(() => setExistingTocLoading(false));
  }, [state.filePath, state.fileType]);

  // Load first batch when page count is known
  useEffect(() => {
    if (!state.pageCount || !state.filePath || !state.fileType) return;
    loadBatch(1, Math.min(BATCH_SIZE, state.pageCount));
  }, [state.pageCount]);

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
        for (const r of results) next.set(r.page, `data:${r.mime};base64,${r.data}`);
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

  const openPreview = async (page: number) => {
    const thumb = thumbs.get(page);
    setPreviewPage(page);
    setPreviewImage(thumb ?? "");

    if (!state.filePath || !state.fileType || !state.sessionId) return;

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
      console.error("render preview failed:", e);
    } finally {
      setPreviewLoading(false);
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

          {/* Existing bookmarks banner */}
          {existingTocLoading && (
            <div className="mb-4 text-xs text-zinc-600 animate-pulse">Checking for existing bookmarks...</div>
          )}
          {showExistingToc && existingToc.length > 0 && (
            <div className="mb-5 rounded-xl border border-amber-700/50 bg-amber-950/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-amber-400 mb-1">📑 Existing bookmarks found</div>
                  <div className="text-xs text-amber-700">{existingToc.length} entries already in this file</div>
                </div>
                <button
                  onClick={() => setShowExistingToc(false)}
                  className="text-amber-800 hover:text-amber-600 text-sm leading-none flex-shrink-0"
                >
                  ×
                </button>
              </div>
              <button
                onClick={() => {
                  const entries: TocEntry[] = existingToc.map((e, i) => ({
                    title: e.title,
                    page: e.page,
                    raw_page: String(e.page),
                    level: e.level,
                    source_line: i,
                  }));
                  onEditExisting(entries);
                }}
                className="mt-2.5 w-full py-1.5 bg-amber-700 hover:bg-amber-600 rounded-lg text-xs font-semibold text-white transition-colors"
              >
                ✎ Edit existing bookmarks directly →
              </button>
              <p className="text-xs text-amber-900 mt-1.5">
                Skips AI extraction — loads current TOC straight into merge step.
              </p>
            </div>
          )}

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

          {/* Page Adjustments */}
          {state.selectedPages.length > 0 && (
            <div className="mt-4 rounded-xl bg-zinc-900/50 border border-zinc-800 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Page Adjustments</h3>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Map printed TOC page numbers to actual file pages.<br/>
                  <span className="inline-block mt-1 font-mono text-[10px] bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800 text-zinc-400">Target Page = Printed Page + Offset</span>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Offset <span className="text-zinc-600">(File − Printed)</span>
                  </label>
                  <input
                    type="number"
                    value={state.metadata.offset}
                    onChange={(e) =>
                      saveMetadata({ ...state.metadata, offset: Number(e.target.value) })
                    }
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Cover Pages <span className="text-zinc-600">(opt)</span></label>
                  <input
                    type="text"
                    value={state.metadata.if_cover}
                    onChange={(e) =>
                      saveMetadata({ ...state.metadata, if_cover: e.target.value })
                    }
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all"
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
              ? "Page Preview — click card to enlarge, click button to select"
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
                        className="group flex flex-col gap-2"
                      >
                        {/* Thumbnail / Preview Area */}
                        <div
                          onClick={() => openPreview(page)}
                          className={`relative cursor-zoom-in rounded-lg overflow-hidden border-2 transition-all duration-200 bg-zinc-900 ${
                            isSelected
                              ? "border-indigo-500 shadow-lg shadow-indigo-900/30"
                              : "border-zinc-800 hover:border-zinc-600"
                          }`}
                          title={`Click to preview page ${page}`}
                        >
                          <div className="aspect-[3/4] flex items-center justify-center">
                            {thumb ? (
                              <img
                                src={thumb}
                                alt={`Page ${page}`}
                                className={`w-full h-full object-contain transition-all duration-200 ${
                                  isSelected ? "opacity-90" : "opacity-100 group-hover:opacity-95"
                                }`}
                              />
                            ) : (
                              <div className="text-zinc-700 text-xs text-center p-4">
                                <div className="text-2xl mb-1 animate-spin">⟳</div>
                                <div>Loading...</div>
                              </div>
                            )}
                          </div>
                          
                          {/* Hover preview hint */}
                          <div className="absolute top-2 right-2 p-1.5 rounded-md bg-black/70 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none backdrop-blur-sm">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                             </svg>
                          </div>
                        </div>

                        {/* Select Button */}
                        <button
                          onClick={() => togglePage(page)}
                          className={`w-full py-2 rounded-md text-xs font-medium transition-all duration-200 flex items-center justify-center gap-2 border ${
                            isSelected 
                              ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300 hover:bg-indigo-600/30 shadow-sm" 
                              : "bg-zinc-900/50 border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-400"
                          }`}
                        >
                          {isSelected ? (
                            <>
                              <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                              Page {page}
                            </>
                          ) : (
                            <>
                              <div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-500/80"></div>
                              Page {page}
                            </>
                          )}
                        </button>
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

      {/* Full page preview modal */}
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
                  Loading full page...
                </div>
              )}
              {previewImage ? (
                <img
                  src={previewImage}
                  alt={`Full preview page ${previewPage}`}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div className="text-zinc-600 text-sm">No preview available</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
