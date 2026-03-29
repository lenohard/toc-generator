import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppState, PageThumbnail, TocEntry } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
  onBack: () => void;
}

const DEFAULT_MODEL = "google/gemini-3-flash";
const AI_GATEWAY_BASE = "https://ai-gateway.vercel.sh";

const SYSTEM_PROMPT = `You are a table of contents (TOC) extractor. The user will provide images of book/document pages that contain a table of contents.

Extract ALL entries from the table of contents and return them as a JSON array. 

Rules:
1. Detect the hierarchy level based on indentation, font size, numbering style (e.g., "1", "1.1", "1.1.1" = levels 1,2,3)
2. Return the printed page number exactly as shown (do NOT apply any offset)
3. Clean up OCR artifacts but preserve the original text meaning
4. For each entry output EXACTLY this JSON structure (no extra fields):
   {"title": "Chapter Title", "page": 42, "raw_page": "42", "level": 1, "source_line": 0}
5. level is an integer: 1 = top-level chapter, 2 = section, 3 = subsection, etc.
6. raw_page is the page number string exactly as it appears in the TOC
7. page is the integer version of raw_page
8. source_line is always 0 (not used in AI mode)

Return ONLY a valid JSON array, no markdown fences, no explanations, no other text. Start directly with [ and end with ].`;

function parseAIResponse(text: string): TocEntry[] {
  // Strip markdown code fences if present
  let clean = text.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  // Find the JSON array
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array found in response");
  const json = clean.slice(start, end + 1);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  return parsed.map((item: Record<string, unknown>, i: number) => ({
    title: String(item.title ?? ""),
    page: Number(item.page ?? 0),
    raw_page: String(item.raw_page ?? item.page ?? ""),
    level: Number(item.level ?? 1),
    source_line: Number(item.source_line ?? i),
  }));
}

export function Step2AI({ state, updateState, onNext, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<TocEntry[]>(state.tocEntries || []);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [pageImages, setPageImages] = useState<Map<number, string>>(new Map());
  const [loadingImages, setLoadingImages] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState<TocEntry | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  // Load full-res images for AI
  useEffect(() => {
    if (!state.filePath || !state.fileType || state.selectedPages.length === 0) return;
    setLoadingImages(true);
    invoke<PageThumbnail[]>("render_pages_for_ai", {
      sessionId: state.sessionId,
      filePath: state.filePath,
      fileType: state.fileType,
      pages: state.selectedPages,
    })
      .then((results) => {
        const map = new Map<number, string>();
        for (const r of results) map.set(r.page, r.data);
        setPageImages(map);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingImages(false));
  }, [state.selectedPages, state.filePath]);

  const runAI = async () => {
    if (!state.apiKey) {
      setError("API key not set. Go back to Step 1 to set it.");
      return;
    }
    if (pageImages.size === 0) {
      setError("No page images loaded yet.");
      return;
    }

    setLoading(true);
    setError("");
    setRawResponse("");

    // Build image content blocks for all selected pages
    const imageBlocks: unknown[] = [];
    for (const page of state.selectedPages) {
      const b64 = pageImages.get(page);
      if (!b64) continue;
      imageBlocks.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${b64}`,
          detail: "high",
        },
      });
    }

    if (imageBlocks.length === 0) {
      setError("No images available. Please wait for images to load.");
      setLoading(false);
      return;
    }

    const messages = [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          ...imageBlocks,
          {
            type: "text",
            text: `These are ${imageBlocks.length} page(s) from a document's table of contents. Extract all TOC entries as a JSON array following the system instructions.`,
          },
        ],
      },
    ];

    try {
      const resp = await fetch(`${AI_GATEWAY_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API error ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content ?? "";
      setRawResponse(text);

      const parsed = parseAIResponse(text);
      setEntries(parsed);
      updateState({ tocEntries: parsed, aiDone: true });

      // Save to session for merge step
      await invoke("save_ai_toc", {
        sessionId: state.sessionId,
        entriesJson: JSON.stringify(parsed),
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditEntry({ ...entries[idx] });
  };

  const saveEdit = () => {
    if (editingIdx === null || !editEntry) return;
    const updated = [...entries];
    updated[editingIdx] = editEntry;
    setEntries(updated);
    updateState({ tocEntries: updated });
    invoke("save_ai_toc", {
      sessionId: state.sessionId,
      entriesJson: JSON.stringify(updated),
    });
    setEditingIdx(null);
    setEditEntry(null);
  };

  const deleteEntry = (idx: number) => {
    const updated = entries.filter((_, i) => i !== idx);
    setEntries(updated);
    updateState({ tocEntries: updated, aiDone: updated.length > 0 });
    invoke("save_ai_toc", {
      sessionId: state.sessionId,
      entriesJson: JSON.stringify(updated),
    });
  };

  const addEntry = () => {
    const newEntry: TocEntry = {
      title: "New Entry",
      page: 1,
      raw_page: "1",
      level: 1,
      source_line: entries.length,
    };
    const updated = [...entries, newEntry];
    setEntries(updated);
    updateState({ tocEntries: updated, aiDone: true });
    startEdit(updated.length - 1);
  };

  const levelIndent = (level: number) => (level - 1) * 20;

  return (
    <div className="flex h-full">
      {/* Left: control panel */}
      <div className="w-72 flex-shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Step 2 — AI Extraction
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Page images status */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Selected Pages</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {state.selectedPages.map((p) => {
                const loaded = pageImages.has(p);
                return (
                  <span
                    key={p}
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                      loaded
                        ? "bg-green-900/50 text-green-400"
                        : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {loaded ? "✓" : "⟳"} p.{p}
                  </span>
                );
              })}
            </div>
            {loadingImages && (
              <p className="text-xs text-zinc-500 animate-pulse">Preparing images...</p>
            )}
          </div>

          {/* Model selector */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="google/gemini-3-flash">google/gemini-3-flash (default)</option>
              <option value="google/gemini-3.1-pro-preview">google/gemini-3.1-pro-preview</option>
              <option value="google/gemini-2.5-pro">google/gemini-2.5-pro</option>
              <option value="anthropic/claude-haiku-4.5">anthropic/claude-haiku-4.5</option>
              <option value="anthropic/claude-sonnet-4.6">anthropic/claude-sonnet-4.6</option>
              <option value="openai/gpt-5.4">openai/gpt-5.4</option>
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-950 border border-red-800 rounded-lg p-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Success summary */}
          {entries.length > 0 && !loading && (
            <div className="bg-green-950 border border-green-800 rounded-lg p-3">
              <p className="text-xs text-green-400 font-medium">
                ✓ {entries.length} TOC entries extracted
              </p>
              <p className="text-xs text-green-700 mt-1">
                Review and edit the table below, then continue to merge.
              </p>
            </div>
          )}

          {/* Raw response toggle */}
          {rawResponse && (
            <div>
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="text-xs text-zinc-600 hover:text-zinc-400 flex items-center gap-1"
              >
                {showRaw ? "▼" : "▶"} Raw AI response
              </button>
              {showRaw && (
                <pre className="mt-2 text-xs text-zinc-600 bg-zinc-950 rounded p-2 overflow-auto max-h-40 font-mono whitespace-pre-wrap">
                  {rawResponse}
                </pre>
              )}
            </div>
          )}

          {/* Add entry button */}
          {entries.length > 0 && (
            <button
              onClick={addEntry}
              className="w-full py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs text-zinc-300 transition-colors"
            >
              + Add Entry
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={runAI}
            disabled={loading || loadingImages || pageImages.size === 0}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin">⟳</span> Extracting...
              </>
            ) : entries.length > 0 ? (
              "↺ Re-extract"
            ) : (
              "✨ Extract TOC with AI"
            )}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onBack}
              className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={onNext}
              disabled={entries.length === 0}
              className="flex-1 py-2 bg-green-700 hover:bg-green-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-xs font-medium text-white transition-colors"
            >
              Continue to Merge →
            </button>
          </div>
        </div>
      </div>

      {/* Right: TOC editor table */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-medium text-zinc-500">
            TOC Entries {entries.length > 0 ? `(${entries.length})` : ""}
          </span>
          {entries.length > 0 && (
            <span className="text-xs text-zinc-600">Click a row to edit</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center text-zinc-700 mt-20">
              <div className="text-4xl mb-3 animate-spin">⟳</div>
              <div className="text-sm">AI is extracting table of contents...</div>
              <div className="text-xs mt-2 text-zinc-800">This may take 10–30 seconds</div>
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center text-zinc-700 mt-20">
              <div className="text-4xl mb-3">✨</div>
              <div className="text-sm">
                {loadingImages
                  ? "Preparing page images..."
                  : pageImages.size > 0
                  ? 'Click "Extract TOC with AI" to begin'
                  : "Select pages in Step 1 first"}
              </div>
              <div className="text-xs mt-2 text-zinc-800">
                The AI will read the TOC pages and extract all entries
              </div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr className="text-zinc-500">
                  <th className="text-left px-3 py-2 w-8">Lvl</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-right px-3 py-2 w-16">Page</th>
                  <th className="px-3 py-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const isEditing = editingIdx === i;
                  return (
                    <tr
                      key={i}
                      className={`border-t border-zinc-800/50 ${
                        isEditing ? "bg-indigo-950/40" : "hover:bg-zinc-800/20"
                      }`}
                    >
                      {isEditing && editEntry ? (
                        <>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              min={1}
                              max={5}
                              value={editEntry.level}
                              onChange={(e) =>
                                setEditEntry({ ...editEntry, level: Number(e.target.value) })
                              }
                              className="w-10 bg-zinc-800 border border-indigo-600 rounded px-1 py-0.5 text-xs text-zinc-200"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              value={editEntry.title}
                              onChange={(e) =>
                                setEditEntry({ ...editEntry, title: e.target.value })
                              }
                              className="w-full bg-zinc-800 border border-indigo-600 rounded px-2 py-1 text-xs text-zinc-200"
                              autoFocus
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              value={editEntry.page}
                              onChange={(e) => {
                                const p = Number(e.target.value);
                                setEditEntry({
                                  ...editEntry,
                                  page: p,
                                  raw_page: String(p),
                                });
                              }}
                              className="w-16 bg-zinc-800 border border-indigo-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <div className="flex gap-1">
                              <button
                                onClick={saveEdit}
                                className="px-2 py-0.5 bg-green-700 hover:bg-green-600 rounded text-xs text-white"
                              >
                                ✓
                              </button>
                              <button
                                onClick={() => {
                                  setEditingIdx(null);
                                  setEditEntry(null);
                                }}
                                className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs text-zinc-300"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-1.5 text-center">
                            <span className="inline-block w-5 h-5 rounded bg-zinc-800 text-zinc-500 text-center leading-5">
                              {entry.level}
                            </span>
                          </td>
                          <td
                            className="px-3 py-1.5 cursor-pointer"
                            style={{ paddingLeft: `${12 + levelIndent(entry.level)}px` }}
                            onClick={() => startEdit(i)}
                          >
                            <span
                              className={
                                entry.level === 1
                                  ? "text-zinc-200 font-medium"
                                  : entry.level === 2
                                  ? "text-zinc-300"
                                  : "text-zinc-400"
                              }
                            >
                              {entry.level > 1 && (
                                <span className="text-zinc-700 mr-1">└</span>
                              )}
                              {entry.title}
                            </span>
                          </td>
                          <td
                            className="px-3 py-1.5 text-right font-mono text-indigo-400 cursor-pointer"
                            onClick={() => startEdit(i)}
                          >
                            {entry.page}
                          </td>
                          <td className="px-3 py-1.5">
                            <button
                              onClick={() => deleteEntry(i)}
                              className="text-zinc-700 hover:text-red-400 text-sm w-full text-center"
                            >
                              ×
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
