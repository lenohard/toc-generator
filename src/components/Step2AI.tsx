import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import type { AppState, PageThumbnail, TocEntry } from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
  onBack: () => void;
  settingsVersion?: number;
}

interface AIUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

interface AIHistoryItem {
  id: string;
  at: string;
  model: string;
  pages: number[];
  entries: TocEntry[];
  rawResponse: string;
  usage: AIUsage;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface AIExtractCacheRecord {
  at: string;
  model: string;
  filePath: string;
  fileType: "pdf" | "djvu";
  selectedPages: number[];
  pageCount: number | null;
  entries: TocEntry[];
  rawResponse: string;
  usage: AIUsage;
}

const DEFAULT_MODEL = "google/gemini-3-flash";
const DEFAULT_PROTOCOL = "chat";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go";
const HISTORY_MAX = 20;
const EXTRACT_CACHE_PREFIX = "ai_extract_cache:v1";

const SYSTEM_PROMPT = `You are a table of contents (TOC) extractor. The user will provide images of book/document pages that contain a table of contents.

Extract ALL entries from the table of contents and return them as a JSON array.

Rules:
1. Detect the hierarchy level based on indentation, font size, numbering style (e.g., "1", "1.1", "1.1.1" = levels 1,2,3)
2. Return the printed page number exactly as shown (do NOT apply any offset)
3. Clean up OCR artifacts but preserve the original text meaning
4. For each entry output EXACTLY this JSON structure (no extra fields):
   {"title": "Chapter Title", "page": 42, "raw_page": "42", "level": 1, "source_line": 0}
5. level is an integer: 1 = top-level chapter, 2 = section, 3 = subsection, etc.
6. raw_page is the page number string exactly as it appears in the TOC — including roman numerals (e.g. "iv", "xii") if that is what is printed
7. page is the integer version of raw_page. If raw_page is a roman numeral or any non-arabic string, set page to 0
8. source_line is always 0 (not used in AI mode)

IMPORTANT: Do NOT convert roman numerals to arabic numbers. If the printed page is "iv", keep raw_page as "iv" and set page to 0.

Return ONLY a valid JSON array, no markdown fences, no explanations, no other text. Start directly with [ and end with ].`;

function parseAIResponse(text: string): TocEntry[] {
  let clean = text.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
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

function parsePartialAIResponse(text: string): TocEntry[] {
  const start = text.indexOf("[");
  if (start === -1) return [];
  const body = text.slice(start);
  const objectLike = body.match(/\{[^{}]*\}/g) ?? [];
  const parsed: TocEntry[] = [];

  objectLike.forEach((obj, idx) => {
    try {
      const item = JSON.parse(obj) as Record<string, unknown>;
      parsed.push({
        title: String(item.title ?? ""),
        page: Number(item.page ?? 0),
        raw_page: String(item.raw_page ?? item.page ?? ""),
        level: Number(item.level ?? 1),
        source_line: Number(item.source_line ?? idx),
      });
    } catch {
      // ignore incomplete object
    }
  });

  return parsed;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function mergeUsage(base: AIUsage, packet: unknown): AIUsage {
  const p = packet as Record<string, unknown>;
  const usage = (p.usage ?? {}) as Record<string, unknown>;

  const promptTokens = pickNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const completionTokens = pickNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const totalTokens = pickNumber(usage.total_tokens, usage.totalTokens);

  const costFromRoot = (p.cost ?? {}) as Record<string, unknown>;
  const costUsd = pickNumber(
    usage.total_cost,
    usage.cost,
    usage.total_cost_usd,
    costFromRoot.total,
    costFromRoot.usd,
  );

  return {
    promptTokens: promptTokens ?? base.promptTokens,
    completionTokens: completionTokens ?? base.completionTokens,
    totalTokens: totalTokens ?? base.totalTokens,
    costUsd: costUsd ?? base.costUsd,
  };
}

async function consumeSSE(
  resp: { body: ReadableStream<Uint8Array> | null },
  onPacket: (packet: unknown) => void
): Promise<void> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    const lines = sseBuf.split("\n");
    sseBuf = lines.pop() ?? "";
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      onPacket(JSON.parse(data));
    }
  }
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "N/A";
  if (costUsd < 0.0001) return `$${costUsd.toExponential(2)}`;
  return `$${costUsd.toFixed(6)}`;
}

export function Step2AI({ state, updateState, onNext, onBack, settingsVersion }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<TocEntry[]>(state.tocEntries || []);
  const [model, setModel] = useState(
    localStorage.getItem("ai_model") || DEFAULT_MODEL
  );
  const [protocol, setProtocol] = useState<"chat" | "responses">(
    localStorage.getItem("ai_protocol") === "responses" ? "responses" : DEFAULT_PROTOCOL
  );
  const baseUrl = localStorage.getItem("ai_base_url") || DEFAULT_BASE_URL;
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [pageImages, setPageImages] = useState<Map<number, string>>(new Map());
  const [loadingImages, setLoadingImages] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editEntry, setEditEntry] = useState<TocEntry | null>(null);
  const [rawResponse, setRawResponse] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [usage, setUsage] = useState<AIUsage>({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
  });
  const [histories, setHistories] = useState<AIHistoryItem[]>([]);
  const [cacheNotice, setCacheNotice] = useState("");

  // Page inspector state
  const [inspectorEntryIdx, setInspectorEntryIdx] = useState<number | null>(null);
  // Unresolved-page resolution modal (entries where page === 0)
  const [resolving, setResolving] = useState(false);
  const [resolveIdx, setResolveIdx] = useState(0);
  const [resolveInput, setResolveInput] = useState("");
  const [resolvePreviewImg, setResolvePreviewImg] = useState("");
  const [resolvePreviewLoading, setResolvePreviewLoading] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const inspectorResizing = useRef(false);
  const inspectorResizeStartX = useRef(0);
  const inspectorResizeStartW = useRef(320);
  const [inspectorPage, setInspectorPage] = useState<number>(1);
  const [inspectorJumpInput, setInspectorJumpInput] = useState<string>("1");
  const [inspectorCache, setInspectorCache] = useState<Map<number, string>>(new Map());
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const inspectorInFlightPages = useRef<Set<number>>(new Set());
  const inspectorReqSeq = useRef(0);
  const loadedCacheKeyRef = useRef<string | null>(null);

  const historyKey = `ai_extract_history:${state.sessionId ?? "default"}`;
  const selectedPagesKey = [...state.selectedPages].sort((a, b) => a - b).join(",");
  const extractionCacheKey =
    state.filePath && state.fileType && selectedPagesKey
      ? `${EXTRACT_CACHE_PREFIX}:${state.fileType}:${state.filePath}:${selectedPagesKey}`
      : null;

  const saveExtractionCache = (
    rows: TocEntry[],
    extra?: Partial<Pick<AIExtractCacheRecord, "model" | "rawResponse" | "usage">>,
  ) => {
    if (!extractionCacheKey || rows.length === 0 || !state.filePath || !state.fileType) return;
    const payload: AIExtractCacheRecord = {
      at: new Date().toISOString(),
      model: extra?.model ?? model,
      filePath: state.filePath,
      fileType: state.fileType,
      selectedPages: [...state.selectedPages],
      pageCount: state.pageCount,
      entries: rows,
      rawResponse: extra?.rawResponse ?? rawResponse,
      usage: extra?.usage ?? usage,
    };
    localStorage.setItem(extractionCacheKey, JSON.stringify(payload));
  };

  useEffect(() => {
    const raw = localStorage.getItem(historyKey);
    if (!raw) {
      setHistories([]);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as AIHistoryItem[];
      setHistories(Array.isArray(parsed) ? parsed : []);
    } catch {
      setHistories([]);
    }
  }, [historyKey]);

  useEffect(() => {
    localStorage.setItem(historyKey, JSON.stringify(histories));
  }, [historyKey, histories]);

  // Fetch available models
  useEffect(() => {
    const apiKey = localStorage.getItem("ai_gateway_key") || "";
    if (!apiKey) return;
    setModelsLoading(true);
    setModelsError("");
    invoke<string[]>("fetch_models", { baseUrl, apiKey })
      .then(setModels)
      .catch((e) => setModelsError(String(e)))
      .finally(() => setModelsLoading(false));
  }, [baseUrl]);

  const handleModelChange = (newModel: string) => {
    localStorage.setItem("ai_model", newModel);
    setModel(newModel);
  };

  // Re-sync config when Settings saves (model/protocol may have changed while mounted)
  useEffect(() => {
    const savedModel = localStorage.getItem("ai_model");
    if (savedModel) setModel(savedModel);
    setProtocol(
      localStorage.getItem("ai_protocol") === "responses" ? "responses" : DEFAULT_PROTOCOL
    );
  }, [settingsVersion]);

  // Hydrate cached extraction for the same book + selected TOC pages
  useEffect(() => {
    if (!extractionCacheKey) {
      loadedCacheKeyRef.current = null;
      setCacheNotice("");
      return;
    }
    if (loadedCacheKeyRef.current === extractionCacheKey) return;
    loadedCacheKeyRef.current = extractionCacheKey;

    // If caller already injected TOC (e.g. task history restore), trust current state.
    if (state.tocEntries.length > 0) {
      setEntries(state.tocEntries);
      return;
    }

    const raw = localStorage.getItem(extractionCacheKey);
    if (!raw) return;

    try {
      const cached = JSON.parse(raw) as AIExtractCacheRecord;
      if (!Array.isArray(cached.entries) || cached.entries.length === 0) return;

      setEntries(cached.entries);
      setRawResponse(cached.rawResponse || "");
      setUsage(cached.usage || { promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null });
      if (cached.model) setModel(cached.model);
      setCacheNotice(`Loaded cached AI extraction (${cached.entries.length} entries)`);
      updateState({ tocEntries: cached.entries, aiDone: true });

      if (state.sessionId) {
        invoke("save_ai_toc", {
          sessionId: state.sessionId,
          entriesJson: JSON.stringify(cached.entries),
        });
      }
    } catch {
      // ignore broken cache
    }
  }, [extractionCacheKey, state.sessionId, state.tocEntries, updateState]);

  // Load full-res images for AI
  useEffect(() => {
    if (!state.filePath || !state.fileType || !state.sessionId || state.selectedPages.length === 0) return;
    setLoadingImages(true);
    invoke<PageThumbnail[]>("render_pages_for_ai", {
      sessionId: state.sessionId,
      filePath: state.filePath,
      fileType: state.fileType,
      pages: state.selectedPages,
    })
      .then((results) => {
        const map = new Map<number, string>();
        for (const r of results) map.set(r.page, `data:${r.mime};base64,${r.data}`);
        setPageImages(map);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingImages(false));
  }, [state.selectedPages, state.filePath, state.fileType, state.sessionId]);

  const runAI = async () => {
    const apiKey = localStorage.getItem("ai_gateway_key") || "";
    if (!apiKey) {
      setError("API key not set. Open Settings (⚙) to configure it.");
      return;
    }
    if (pageImages.size === 0) {
      setError("No page images loaded yet.");
      return;
    }

    setLoading(true);
    setError("");
    setRawResponse("");
    setUsage({ promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null });
    setEntries([]);
    updateState({ tocEntries: [], aiDone: false });

    const startedAt = Date.now();

    const imageBlocks: unknown[] = [];
    for (const page of state.selectedPages) {
      const b64 = pageImages.get(page);
      if (!b64) continue;
      imageBlocks.push({
        type: "image_url",
        image_url: {
          url: b64,
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

    const isResponses = protocol === "responses";

    const endpoint = isResponses
      ? `${baseUrl}/v1/responses`
      : `${baseUrl}/v1/chat/completions`;

    const requestBody = isResponses
      ? {
          model,
          instructions: SYSTEM_PROMPT,
          input: [
            {
              role: "user",
              content: [
                ...imageBlocks.map((b) => ({
                  type: "input_image" as const,
                  image_url: (b as { image_url: { url: string } }).image_url.url,
                })),
                {
                  type: "input_text" as const,
                  text: `These are ${imageBlocks.length} page(s) from a document's table of contents. Extract all TOC entries as a JSON array following the system instructions.`,
                },
              ],
            },
          ],
          stream: true,
          store: false,
        }
      : {
          model,
          messages,
          stream: true,
          stream_options: {
            include_usage: true,
          },
        };

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API error ${resp.status}: ${errText}`);
      }

      if (!resp.body) {
        throw new Error("No response body from AI API");
      }

      let text = "";
      let currentUsage: AIUsage = {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        costUsd: null,
      };

      await consumeSSE(resp, (packet) => {
        const p = packet as Record<string, unknown>;
        const type = p.type;

        // ---- chat-completions chunk ----
        if (type === undefined || type === "chat.completion.chunk") {
          currentUsage = mergeUsage(currentUsage, packet);
          setUsage(currentUsage);

          const maybeError = p.error as Record<string, unknown> | undefined;
          if (maybeError) {
            throw new Error(String(maybeError.message ?? "AI streaming error"));
          }

          const choices = p.choices as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
          const content = delta?.content;

          if (typeof content === "string") {
            text += content;
            setRawResponse(text);
            const partial = parsePartialAIResponse(text);
            if (partial.length > 0) {
              setEntries(partial);
              updateState({ tocEntries: partial, aiDone: true });
            }
          } else if (Array.isArray(content)) {
            for (const part of content as Array<Record<string, unknown>>) {
              const partText = part?.text;
              if (typeof partText === "string") {
                text += partText;
              }
            }
            if (text) {
              setRawResponse(text);
              const partial = parsePartialAIResponse(text);
              if (partial.length > 0) {
                setEntries(partial);
                updateState({ tocEntries: partial, aiDone: true });
              }
            }
          }
          return;
        }

        // ---- openai-responses events ----
        if (type === "response.output_text.delta") {
          const delta = p.delta;
          if (typeof delta === "string") {
            text += delta;
            setRawResponse(text);
            const partial = parsePartialAIResponse(text);
            if (partial.length > 0) {
              setEntries(partial);
              updateState({ tocEntries: partial, aiDone: true });
            }
          }
          return;
        }

        if (type === "response.usage") {
          currentUsage = mergeUsage(currentUsage, { usage: p });
          setUsage(currentUsage);
          return;
        }

        if (type === "response.completed" || type === "response.incomplete") {
          const response = (p.response ?? {}) as Record<string, unknown>;
          const finalText = response.output_text;
          if (typeof finalText === "string" && finalText.length > text.length) {
            text = finalText;
            setRawResponse(text);
            const partial = parsePartialAIResponse(text);
            if (partial.length > 0) {
              setEntries(partial);
              updateState({ tocEntries: partial, aiDone: true });
            }
          }
          if (response.usage) {
            currentUsage = mergeUsage(currentUsage, { usage: response.usage });
            setUsage(currentUsage);
          }
          return;
        }

        if (type === "response.failed") {
          const response = (p.response ?? {}) as Record<string, unknown>;
          const err = (response.error ?? {}) as Record<string, unknown>;
          throw new Error(String(err.message ?? "AI streaming error"));
        }

        if (type === "error") {
          throw new Error(String(p.message ?? "AI streaming error"));
        }
      });

      const parsed = parseAIResponse(text);
      setEntries(parsed);
      updateState({ tocEntries: parsed, aiDone: true });

      await invoke("save_ai_toc", {
        sessionId: state.sessionId,
        entriesJson: JSON.stringify(parsed),
      });
      saveExtractionCache(parsed, { model, rawResponse: text, usage: currentUsage });

      const durationMs = Date.now() - startedAt;
      updateState({
        aiRunInfo: {
          at: new Date().toISOString(),
          model,
          usage: currentUsage,
          durationMs,
          success: true,
        },
      });

      const historyItem: AIHistoryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        model,
        pages: [...state.selectedPages],
        entries: parsed,
        rawResponse: text,
        usage: currentUsage,
        success: true,
        durationMs,
      };
      setHistories((prev) => [historyItem, ...prev].slice(0, HISTORY_MAX));
    } catch (e) {
      const errText = String(e);
      const durationMs = Date.now() - startedAt;
      setError(errText);
      updateState({
        aiRunInfo: {
          at: new Date().toISOString(),
          model,
          usage,
          durationMs,
          success: false,
        },
      });
      const historyItem: AIHistoryItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        model,
        pages: [...state.selectedPages],
        entries: [...entries],
        rawResponse,
        usage,
        success: false,
        error: errText,
        durationMs,
      };
      setHistories((prev) => [historyItem, ...prev].slice(0, HISTORY_MAX));
    } finally {
      setLoading(false);
    }
  };

  const restoreHistory = async (item: AIHistoryItem) => {
    setEntries(item.entries);
    setRawResponse(item.rawResponse);
    setUsage(item.usage);
    updateState({ tocEntries: item.entries, aiDone: item.entries.length > 0 });

    if (state.sessionId && item.entries.length > 0) {
      await invoke("save_ai_toc", {
        sessionId: state.sessionId,
        entriesJson: JSON.stringify(item.entries),
      });
      saveExtractionCache(item.entries, { model: item.model, rawResponse: item.rawResponse, usage: item.usage });
      setCacheNotice(`Loaded extraction history into cache (${item.entries.length} entries)`);
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
    persistEntries(updated);
    setEditingIdx(null);
    setEditEntry(null);
  };

  const deleteEntry = (idx: number) => {
    const updated = entries.filter((_, i) => i !== idx);
    persistEntries(updated);
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
    persistEntries(updated);
    startEdit(updated.length - 1);
  };

  const levelIndent = (level: number) => (level - 1) * 20;

  const parseRawNumericPage = (rawPage: string): number | null => {
    const s = rawPage.trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
  };

  const computeAutoPdfPageFromRaw = (rawNum: number): number => {
    const offset = state.metadata.offset ?? 0;
    const ifCover = Number.parseInt(state.metadata.if_cover || "0", 10) || 0;
    return ifCover > 0 && rawNum > 0 ? rawNum + offset + ifCover - 1 : rawNum + offset;
  };

  const fetchInspectorPages = async (pages: number[]) => {
    if (!state.filePath || !state.fileType || !state.sessionId) return;
    const unique = Array.from(new Set(pages));
    const missing = unique.filter((p) => !inspectorCache.has(p) && !inspectorInFlightPages.current.has(p));
    if (missing.length === 0) return;

    for (const p of missing) inspectorInFlightPages.current.add(p);
    try {
      const results = await invoke<PageThumbnail[]>("render_pages_for_ai", {
        sessionId: state.sessionId,
        filePath: state.filePath,
        fileType: state.fileType,
        pages: missing,
      });
      if (results.length > 0) {
        setInspectorCache((prev) => {
          const next = new Map(prev);
          for (const r of results) {
            next.set(r.page, `data:${r.mime};base64,${r.data}`);
          }
          return next;
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      for (const p of missing) inspectorInFlightPages.current.delete(p);
    }
  };

  // Load target page now and prefetch nearby pages for faster prev/next browsing.
  const loadInspectorPage = async (page: number) => {
    if (!state.filePath || !state.fileType || !state.sessionId) return;
    const total = state.pageCount ?? 9999;
    const clamped = Math.max(1, Math.min(total, page));

    setInspectorPage(clamped);
    setInspectorJumpInput(String(clamped));

    const reqId = ++inspectorReqSeq.current;
    const hasNow = inspectorCache.has(clamped);
    setInspectorLoading(!hasNow);

    const nearPages: number[] = [];
    for (let d = -2; d <= 2; d += 1) {
      const p = clamped + d;
      if (p >= 1 && p <= total) nearPages.push(p);
    }

    await fetchInspectorPages(nearPages);
    if (reqId === inspectorReqSeq.current) {
      setInspectorLoading(false);
    }
  };

  const computeDisplayedPdfPage = (entry: TocEntry): number => {
    if (entry.page <= 0) return 0;

    const rawNum = parseRawNumericPage(entry.raw_page);
    if (rawNum === null) {
      // Non-numeric printed page (roman numerals etc.): resolved page is already final PDF index
      return entry.page;
    }

    // Numeric printed page:
    // - default behavior uses metadata offset/cover
    // - if user manually changed PDF pg (entry.page differs from raw printed number), keep manual value
    if (entry.page > 0 && entry.page !== rawNum) {
      return entry.page;
    }

    return computeAutoPdfPageFromRaw(rawNum);
  };

  const openInspector = (idx: number) => {
    const entry = entries[idx];
    const targetPage = computeDisplayedPdfPage(entry) || 1;
    setInspectorEntryIdx(idx);
    loadInspectorPage(targetPage);
  };

  // ---- Pre-merge resolution of non-numeric pages ----
  const unresolvedEntries = entries.filter((e) => e.page === 0);

  const loadResolvePreview = async (page: number) => {
    if (!state.sessionId || !state.filePath || !state.fileType || page < 1) return;
    setResolvePreviewLoading(true);
    setResolvePreviewImg("");
    try {
      const [result] = await invoke<PageThumbnail[]>("render_pages_for_ai", {
        sessionId: state.sessionId,
        filePath: state.filePath,
        fileType: state.fileType,
        pages: [page],
      });
      if (result) setResolvePreviewImg(`data:${result.mime};base64,${result.data}`);
    } catch { /* ignore */ }
    setResolvePreviewLoading(false);
  };

  const openResolve = () => {
    // Find first unresolved entry index in the full entries array
    const firstIdx = entries.findIndex((e) => e.page === 0);
    if (firstIdx === -1) { onNext(); return; }
    setResolveIdx(firstIdx);
    setResolveInput("");
    setResolvePreviewImg("");
    setResolving(true);
  };

  const resolveNavEntry = (delta: number) => {
    // Move to next/prev entry that has page === 0
    const indices = entries.map((e, i) => ({ i, e })).filter(({ e }) => e.page === 0).map(({ i }) => i);
    const cur = indices.indexOf(resolveIdx);
    const next = cur + delta;
    if (next < 0 || next >= indices.length) return;
    setResolveIdx(indices[next]);
    setResolveInput("");
    setResolvePreviewImg("");
  };

  const applyResolvePage = (pageStr: string) => {
    const p = parseInt(pageStr, 10);
    if (isNaN(p) || p < 1) return;
    const updated = [...entries];
    updated[resolveIdx] = { ...updated[resolveIdx], page: p };
    persistEntries(updated);
    // Move to next unresolved
    const nextIdx = updated.findIndex((e, i) => i > resolveIdx && e.page === 0);
    if (nextIdx !== -1) {
      setResolveIdx(nextIdx);
      setResolveInput("");
      setResolvePreviewImg("");
    } else {
      // All resolved — proceed
      setResolving(false);
      onNext();
    }
  };

  const skipResolveEntry = () => {
    const nextIdx = entries.findIndex((e, i) => i > resolveIdx && e.page === 0);
    if (nextIdx !== -1) {
      setResolveIdx(nextIdx);
      setResolveInput("");
      setResolvePreviewImg("");
    } else {
      setResolving(false);
      onNext();
    }
  };

  const closeInspector = () => {
    setInspectorEntryIdx(null);
  };

  const inspectorNavPage = (page: number) => {
    const total = state.pageCount ?? 9999;
    const clamped = Math.max(1, Math.min(total, page));
    loadInspectorPage(clamped);
  };

  const persistEntries = (updated: TocEntry[]) => {
    setEntries(updated);
    updateState({ tocEntries: updated, aiDone: updated.length > 0 });
    invoke("save_ai_toc", {
      sessionId: state.sessionId,
      entriesJson: JSON.stringify(updated),
    });
    saveExtractionCache(updated);
  };

  const applyInspectorPage = () => {
    if (inspectorEntryIdx === null) return;
    const p = inspectorPage;

    if (editingIdx === inspectorEntryIdx && editEntry) {
      setEditEntry({ ...editEntry, page: p });
      return;
    }

    const updated = [...entries];
    // Set PDF target page only. Keep raw_page as the printed label from TOC.
    updated[inspectorEntryIdx] = { ...updated[inspectorEntryIdx], page: p };
    persistEntries(updated);
  };

  const applyInspectorPageAndShiftBelow = () => {
    if (inspectorEntryIdx === null) return;
    const pickedPage = inspectorPage;
    const current = entries[inspectorEntryIdx];
    if (!current) return;

    const updated = [...entries];
    updated[inspectorEntryIdx] = { ...updated[inspectorEntryIdx], page: pickedPage };

    const currentRaw = parseRawNumericPage(current.raw_page);
    if (currentRaw === null) {
      // Fallback: for non-numeric printed page, keep legacy delta based on displayed page.
      const oldDisplayed = computeDisplayedPdfPage(current);
      const delta = pickedPage - oldDisplayed;
      if (delta !== 0) {
        for (let i = inspectorEntryIdx + 1; i < updated.length; i += 1) {
          const item = updated[i];
          const shown = computeDisplayedPdfPage(item);
          if (shown <= 0) continue;
          updated[i] = { ...item, page: Math.max(1, shown + delta) };
        }
      }
      persistEntries(updated);
      return;
    }

    // New offset = (picked PDF page - current printed page).
    // For following numeric entries, apply it ON TOP OF the original metadata offset.
    const inferredOffset = pickedPage - currentRaw;

    for (let i = inspectorEntryIdx + 1; i < updated.length; i += 1) {
      const item = updated[i];
      const raw = parseRawNumericPage(item.raw_page);
      if (raw === null) continue;
      const autoWithOriginalOffset = computeAutoPdfPageFromRaw(raw);
      updated[i] = { ...item, page: Math.max(1, autoWithOriginalOffset + inferredOffset) };
    }

    persistEntries(updated);
  };

  // Resolve-overlay derived values (computed before return so no IIFE needed in JSX)
  const resolveAllUnresolved = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.page === 0);
  const resolveCurPos = resolveAllUnresolved.findIndex(({ i }) => i === resolveIdx);
  const resolvePageNum = parseInt(resolveInput, 10);
  const resolveEntry = entries[resolveIdx];

  return (
    <>
    <div className="flex h-full">
      {/* Left: control panel */}
      <div className="w-80 flex-shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Step 2 — AI Extraction
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Selected Pages</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {state.selectedPages.map((p) => {
                const loaded = pageImages.has(p);
                return (
                  <span
                    key={p}
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                      loaded ? "bg-green-900/50 text-green-400" : "bg-zinc-800 text-zinc-500"
                    }`}
                  >
                    {loaded ? "✓" : "⟳"} p.{p}
                  </span>
                );
              })}
            </div>
            {loadingImages && <p className="text-xs text-zinc-500 animate-pulse">Preparing images...</p>}
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              {models.length > 0 ? (
                models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              ) : (
                <option value={model}>{model}</option>
              )}
            </select>
            {modelsLoading && <p className="text-xs text-zinc-500 mt-1 animate-pulse">Loading models...</p>}
            {modelsError && <p className="text-xs text-red-400 mt-1">{modelsError}</p>}
          </div>

          <div className="bg-zinc-800 rounded-lg p-3 text-xs space-y-1">
            <div className="flex justify-between text-zinc-400">
              <span>Prompt tokens</span>
              <span className="text-zinc-200">{usage.promptTokens ?? "-"}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Completion tokens</span>
              <span className="text-zinc-200">{usage.completionTokens ?? "-"}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Total tokens</span>
              <span className="text-zinc-200">{usage.totalTokens ?? "-"}</span>
            </div>
            <div className="flex justify-between text-zinc-400">
              <span>Estimated cost (USD)</span>
              <span className="text-zinc-200">{formatCost(usage.costUsd)}</span>
            </div>
          </div>

          {error && (
            <div className="bg-red-950 border border-red-800 rounded-lg p-3">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {entries.length > 0 && !loading && (
            <div className="bg-green-950 border border-green-800 rounded-lg p-3">
              <p className="text-xs text-green-400 font-medium">✓ {entries.length} TOC entries extracted</p>
              <p className="text-xs text-green-700 mt-1">Review and edit the table below, then continue to merge.</p>
            </div>
          )}

          {cacheNotice && (
            <div className="bg-indigo-950 border border-indigo-800 rounded-lg p-3">
              <p className="text-xs text-indigo-300">{cacheNotice}</p>
            </div>
          )}

          {rawResponse && (
            <div>
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="text-xs text-zinc-600 hover:text-zinc-400 flex items-center gap-1"
              >
                {showRaw ? "▼" : "▶"} Raw AI response {loading ? "(streaming...)" : ""}
              </button>
              {showRaw && (
                <pre className="mt-2 text-xs text-zinc-600 bg-zinc-950 rounded p-2 overflow-auto max-h-40 font-mono whitespace-pre-wrap">
                  {rawResponse}
                </pre>
              )}
            </div>
          )}

          {entries.length > 0 && (
            <button
              onClick={addEntry}
              className="w-full py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs text-zinc-300 transition-colors"
            >
              + Add Entry
            </button>
          )}

          {histories.length > 0 && (
            <div>
              <div className="text-xs text-zinc-400 mb-1.5">Extraction History</div>
              <div className="space-y-2">
                {histories.slice(0, 8).map((h) => (
                  <button
                    key={h.id}
                    onClick={() => restoreHistory(h)}
                    className="w-full text-left bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 rounded-lg p-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className={h.success ? "text-green-400" : "text-red-400"}>
                        {h.success ? "✓ Success" : "✕ Failed"}
                      </span>
                      <span className="text-zinc-500">{new Date(h.at).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-zinc-400 mt-1 truncate">{h.model}</div>
                    <div className="text-zinc-500 mt-1">
                      p:{h.pages.join(",")} · entries:{h.entries.length} · tokens:{h.usage.totalTokens ?? "-"} · cost:{formatCost(h.usage.costUsd)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={runAI}
            disabled={loading || loadingImages || pageImages.size === 0}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin">⟳</span> Streaming...
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
              onClick={openResolve}
              disabled={entries.length === 0}
              className="flex-1 py-2 bg-green-700 hover:bg-green-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-xs font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              Continue to Merge →
              {unresolvedEntries.length > 0 && (
                <span className="bg-amber-500 text-black text-xs font-bold rounded-full px-1.5 py-0.5 leading-none">
                  {unresolvedEntries.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Right: TOC editor table + optional inspector */}
      <div className="flex-1 flex min-w-0 bg-zinc-950">
        {/* TOC table column */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-500">TOC Entries {entries.length > 0 ? `(${entries.length})` : ""}</span>
            {loading ? (
              <span className="text-xs text-indigo-400 animate-pulse">Streaming extraction...</span>
            ) : entries.length > 0 ? (
              <span className="text-xs text-zinc-600">Click row to edit · 🔍 to inspect page</span>
            ) : null}
          </div>

          <div className="flex-1 overflow-y-auto">
            {entries.length === 0 ? (
              <div className="text-center text-zinc-700 mt-20">
                <div className="text-4xl mb-3">✨</div>
                <div className="text-sm">
                  {loading
                    ? "Receiving streaming response..."
                    : loadingImages
                    ? "Preparing page images..."
                    : pageImages.size > 0
                    ? 'Click "Extract TOC with AI" to begin'
                    : "Select pages in Step 1 first"}
                </div>
                <div className="text-xs mt-2 text-zinc-800">The AI will read the TOC pages and extract all entries</div>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="text-zinc-500">
                    <th className="text-left px-3 py-2 w-8">Lvl</th>
                    <th className="text-left px-3 py-2">Title</th>
                    <th className="text-right px-3 py-2 w-16">Printed</th>
                    <th className="text-right px-3 py-2 w-16">PDF pg</th>
                    <th className="px-3 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => {
                    const isEditing = editingIdx === i;
                    const isInspecting = inspectorEntryIdx === i;
                    return (
                      <tr
                        key={i}
                        className={`border-t border-zinc-800/50 ${
                          isEditing
                            ? "bg-indigo-950/40"
                            : isInspecting
                            ? "bg-amber-950/30"
                            : "hover:bg-zinc-800/20"
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
                                onChange={(e) => setEditEntry({ ...editEntry, level: Number(e.target.value) })}
                                className="w-10 bg-zinc-800 border border-indigo-600 rounded px-1 py-0.5 text-xs text-zinc-200"
                              />
                            </td>
                            <td className="px-2 py-1">
                              <input
                                value={editEntry.title}
                                onChange={(e) => setEditEntry({ ...editEntry, title: e.target.value })}
                                className="w-full bg-zinc-800 border border-indigo-600 rounded px-2 py-1 text-xs text-zinc-200"
                                autoFocus
                              />
                            </td>
                            <td className="px-2 py-1">
                              <input
                                value={editEntry.raw_page}
                                onChange={(e) => setEditEntry({ ...editEntry, raw_page: e.target.value })}
                                className="w-14 bg-zinc-800 border border-indigo-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right font-mono"
                                title="Printed page (as shown in TOC)"
                              />
                            </td>
                            <td className="px-2 py-1">
                              <input
                                type="number"
                                value={editEntry.page === 0 ? "" : editEntry.page}
                                placeholder="PDF#"
                                onChange={(e) => setEditEntry({ ...editEntry, page: Number(e.target.value) || 0 })}
                                className="w-14 bg-zinc-800 border border-indigo-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right font-mono"
                                title="PDF page index"
                              />
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex gap-1">
                                <button onClick={saveEdit} className="px-2 py-0.5 bg-green-700 hover:bg-green-600 rounded text-xs text-white">
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
                                <button
                                  onClick={() => isInspecting ? closeInspector() : openInspector(i)}
                                  title="Inspect page"
                                  className={`px-2 py-0.5 rounded text-xs transition-colors ${
                                    isInspecting
                                      ? "bg-amber-600 hover:bg-amber-500 text-white"
                                      : "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
                                  }`}
                                >
                                  🔍
                                </button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 text-center">
                              <span className="inline-block w-5 h-5 rounded bg-zinc-800 text-zinc-500 text-center leading-5">{entry.level}</span>
                            </td>
                            <td
                              className="px-3 py-1.5 cursor-pointer"
                              style={{ paddingLeft: `${12 + levelIndent(entry.level)}px` }}
                              onClick={() => startEdit(i)}
                            >
                              <span className={entry.level === 1 ? "text-zinc-200 font-medium" : entry.level === 2 ? "text-zinc-300" : "text-zinc-400"}>
                                {entry.level > 1 && <span className="text-zinc-700 mr-1">└</span>}
                                {entry.title}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono cursor-pointer" onClick={() => startEdit(i)}>
                              <span className={entry.page === 0 ? "text-amber-500" : "text-zinc-400"}>
                                {entry.raw_page}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono cursor-pointer" onClick={() => startEdit(i)}>
                              {computeDisplayedPdfPage(entry) === 0
                                ? <span className="text-amber-500 font-bold" title="PDF page not set — needs resolution">?</span>
                                : <span className="text-indigo-400">{computeDisplayedPdfPage(entry)}</span>
                              }
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => isInspecting ? closeInspector() : openInspector(i)}
                                  title="Inspect page"
                                  className={`px-1.5 py-0.5 rounded text-xs transition-colors ${
                                    isInspecting
                                      ? "bg-amber-600 hover:bg-amber-500 text-white"
                                      : "text-zinc-600 hover:text-amber-400 hover:bg-zinc-800"
                                  }`}
                                >
                                  🔍
                                </button>
                                <button onClick={() => deleteEntry(i)} className="px-1.5 py-0.5 text-zinc-700 hover:text-red-400 text-sm">
                                  ×
                                </button>
                              </div>
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

        {/* Page Inspector panel */}
        {inspectorEntryIdx !== null && (
          <>
          {/* Drag handle */}
          <div
            onMouseDown={(e) => {
              inspectorResizing.current = true;
              inspectorResizeStartX.current = e.clientX;
              inspectorResizeStartW.current = inspectorWidth;
              const onMove = (ev: MouseEvent) => {
                if (!inspectorResizing.current) return;
                const delta = inspectorResizeStartX.current - ev.clientX;
                const next = Math.max(240, Math.min(600, inspectorResizeStartW.current + delta));
                setInspectorWidth(next);
              };
              const onUp = () => {
                inspectorResizing.current = false;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            className="w-1.5 flex-shrink-0 cursor-col-resize bg-zinc-800 hover:bg-amber-600/60 transition-colors active:bg-amber-500"
            title="Drag to resize inspector"
          />
          <div
            className="flex-shrink-0 flex flex-col border-l border-zinc-800 bg-zinc-900"
            style={{ width: inspectorWidth }}>
            {/* Inspector header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-amber-400">Page Inspector</span>
                <p className="text-xs text-zinc-500 truncate mt-0.5">
                  {entries[inspectorEntryIdx]?.title ?? ""}
                </p>
              </div>
              <button
                onClick={closeInspector}
                className="ml-2 flex-shrink-0 text-zinc-600 hover:text-zinc-300 text-lg leading-none"
              >
                ×
              </button>
            </div>

            {/* Navigation bar */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-800">
              <button
                onClick={() => inspectorNavPage(inspectorPage - 1)}
                disabled={inspectorPage <= 1 || inspectorLoading}
                className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded text-xs text-zinc-300 transition-colors"
              >
                ‹ Prev
              </button>
              <div className="flex items-center gap-1 flex-1 justify-center">
                <input
                  type="number"
                  min={1}
                  max={state.pageCount ?? 9999}
                  value={inspectorJumpInput}
                  onChange={(e) => setInspectorJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const p = parseInt(inspectorJumpInput, 10);
                      if (!isNaN(p)) inspectorNavPage(p);
                    }
                  }}
                  onBlur={() => {
                    const p = parseInt(inspectorJumpInput, 10);
                    if (!isNaN(p)) inspectorNavPage(p);
                  }}
                  className="w-14 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-xs text-zinc-200 text-center focus:outline-none focus:border-amber-500"
                />
                {state.pageCount != null && (
                  <span className="text-xs text-zinc-600">/ {state.pageCount}</span>
                )}
              </div>
              <button
                onClick={() => inspectorNavPage(inspectorPage + 1)}
                disabled={(state.pageCount != null && inspectorPage >= state.pageCount) || inspectorLoading}
                className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded text-xs text-zinc-300 transition-colors"
              >
                Next ›
              </button>
            </div>

            {/* Page image */}
            <div className="flex-1 overflow-y-auto flex flex-col items-center justify-start p-3">
              {inspectorLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-zinc-600 text-sm animate-pulse">Loading page {inspectorJumpInput}...</span>
                </div>
              ) : inspectorCache.has(inspectorPage) ? (
                <img
                  src={inspectorCache.get(inspectorPage)}
                  alt={`Page ${inspectorPage}`}
                  className="w-full rounded border border-zinc-700 shadow-lg"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-zinc-700 text-sm">
                  No image
                </div>
              )}
            </div>

            {/* Apply button */}
            <div className="px-3 py-3 border-t border-zinc-800 space-y-2">
              <button
                onClick={applyInspectorPage}
                className="w-full py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-xs font-semibold text-white transition-colors"
              >
                ✓ Use P{inspectorPage}
              </button>
              <button
                onClick={applyInspectorPageAndShiftBelow}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-semibold text-white transition-colors"
                title="Infer offset from (picked PDF page - current printed page), then add it on top of original offset for following numeric entries"
              >
                ⇣ Use P{inspectorPage} && add inferred offset
              </button>
              {editingIdx !== inspectorEntryIdx && (
                <button
                  onClick={() => startEdit(inspectorEntryIdx)}
                  className="w-full py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 transition-colors"
                >
                  ✎ Also edit this entry
                </button>
              )}
            </div>
          </div>
          </>
        )}
      </div>
    </div>

    {/* ---- Non-numeric page resolution overlay ---- */}
    {resolving && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-[560px] max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-amber-400">Resolve Non-numeric Pages</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {resolveCurPos + 1} of {resolveAllUnresolved.length} unresolved
                  {resolveAllUnresolved.length > 1 && (
                    <span className="ml-2 text-zinc-600">— use arrows to navigate</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => { setResolving(false); onNext(); }}
                className="text-xs text-zinc-600 hover:text-zinc-300 underline"
              >
                Skip all & continue
              </button>
            </div>
          </div>

          {/* Entry info */}
          <div className="px-5 py-3 bg-zinc-950/50 border-b border-zinc-800">
            <div className="flex items-baseline gap-3">
              <span
                className="text-xs text-zinc-200 font-medium truncate flex-1"
                style={{ paddingLeft: `${((resolveEntry?.level ?? 1) - 1) * 12}px` }}
              >
                {resolveEntry?.title}
              </span>
              <span className="text-xs text-amber-500 font-mono flex-shrink-0">
                printed: &ldquo;{resolveEntry?.raw_page}&rdquo;
              </span>
            </div>
          </div>

          {/* Body: input + preview side by side */}
          <div className="flex flex-1 min-h-0 overflow-hidden" style={{ height: 340 }}>
            {/* Left: input */}
            <div className="w-44 flex-shrink-0 flex flex-col gap-3 p-4 border-r border-zinc-800">
              <p className="text-xs text-zinc-400 leading-relaxed">
                Enter the actual PDF page index for this entry (physical page number, not printed).
              </p>
              <input
                type="number"
                min={1}
                max={state.pageCount ?? 9999}
                placeholder="PDF page #"
                value={resolveInput}
                onChange={(e) => setResolveInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && resolveInput) applyResolvePage(resolveInput);
                }}
                autoFocus
                className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-200 text-center focus:outline-none focus:border-amber-500 font-mono"
              />
              <button
                onClick={() => loadResolvePreview(resolvePageNum)}
                disabled={isNaN(resolvePageNum) || resolvePageNum < 1}
                className="py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 rounded-lg text-xs text-zinc-300 transition-colors"
              >
                Preview page
              </button>
            </div>

            {/* Right: page preview */}
            <div className="flex-1 overflow-y-auto flex items-start justify-center p-3 bg-zinc-950">
              {resolvePreviewLoading ? (
                <div className="flex items-center justify-center h-full">
                  <span className="text-zinc-600 text-xs animate-pulse">Loading...</span>
                </div>
              ) : resolvePreviewImg ? (
                <img
                  src={resolvePreviewImg}
                  alt="Preview"
                  className="w-full rounded border border-zinc-700 shadow"
                />
              ) : (
                <div className="text-zinc-700 text-xs mt-8 text-center">
                  Enter a page number and click Preview
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
            {resolveAllUnresolved.length > 1 && (
              <>
                <button
                  onClick={() => resolveNavEntry(-1)}
                  disabled={resolveCurPos === 0}
                  className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded-lg text-xs text-zinc-300"
                >
                  ‹ Prev
                </button>
                <button
                  onClick={skipResolveEntry}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-400"
                >
                  Skip this
                </button>
              </>
            )}
            <div className="flex-1" />
            <button
              onClick={() => applyResolvePage(resolveInput)}
              disabled={isNaN(resolvePageNum) || resolvePageNum < 1}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded-lg text-xs font-semibold text-white transition-colors"
            >
              ✓ Set page {resolveInput || "…"}{resolveCurPos + 1 < resolveAllUnresolved.length ? " & next →" : " & continue →"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
