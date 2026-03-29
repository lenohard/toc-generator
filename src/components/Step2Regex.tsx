import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppState,
  RegexLibraryEntry,
  RegexMatch,
  Rule,
  SessionMetadata,
} from "../types";

interface Props {
  state: AppState;
  updateState: (partial: Partial<AppState>) => void;
  onNext: () => void;
  onBack: () => void;
}

let debounceTimer: ReturnType<typeof setTimeout>;

export function Step2Regex({ state, updateState, onNext, onBack }: Props) {
  const [ocrText, setOcrText] = useState<string[]>([]);
  const [pattern, setPattern] = useState("");
  const [patternError, setPatternError] = useState("");
  const [matches, setMatches] = useState<RegexMatch[]>([]);
  const [library, setLibrary] = useState<RegexLibraryEntry[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState("");
  const [rules, setRules] = useState<Rule[]>(state.rules);
  const [pendingRank, setPendingRank] = useState(1);
  const [pendingLabel, setPendingLabel] = useState("");
  const [metadata, setMetadata] = useState<SessionMetadata>(state.metadata);
  const [highlightedLines, setHighlightedLines] = useState<Set<number>>(new Set());
  const ocrRef = useRef<HTMLDivElement>(null);

  // Load OCR text and library on mount
  useEffect(() => {
    if (!state.sessionId) return;
    invoke<string>("get_ocr_result", { sessionId: state.sessionId })
      .then((text) => setOcrText(text.split("\n")))
      .catch(() => {});
    invoke<RegexLibraryEntry[]>("get_regex_library")
      .then(setLibrary)
      .catch(() => {});
    invoke<Rule[]>("get_rules", { sessionId: state.sessionId })
      .then((r) => {
        setRules(r);
        updateState({ rules: r });
      })
      .catch(() => {});
  }, [state.sessionId]);

  // Debounced regex test
  useEffect(() => {
    clearTimeout(debounceTimer);
    if (!pattern || !state.sessionId) {
      setMatches([]);
      setHighlightedLines(new Set());
      setPatternError("");
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const result = await invoke<RegexMatch[]>("test_regex", {
          sessionId: state.sessionId,
          pattern,
        });
        setMatches(result);
        setHighlightedLines(new Set(result.map((m) => m.line_number)));
        setPatternError("");
      } catch (err) {
        setPatternError(String(err));
        setMatches([]);
        setHighlightedLines(new Set());
      }
    }, 300);
  }, [pattern, state.sessionId]);

  // Scroll to first match
  useEffect(() => {
    if (matches.length > 0 && ocrRef.current) {
      const firstMatch = ocrRef.current.querySelector('[data-highlighted="true"]');
      firstMatch?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [matches]);

  const addRule = async () => {
    if (!pattern || !state.sessionId) return;
    const newRule: Rule = {
      id: crypto.randomUUID(),
      pattern,
      rank: pendingRank,
      label: pendingLabel || null,
    };
    try {
      const updated = await invoke<Rule[]>("save_rule", {
        sessionId: state.sessionId,
        rule: newRule,
      });
      setRules(updated);
      updateState({ rules: updated });
      setPattern("");
      setMatches([]);
      setPendingLabel("");
    } catch (err) {
      console.error(err);
    }
  };

  const deleteRule = async (id: string) => {
    if (!state.sessionId) return;
    const updated = await invoke<Rule[]>("delete_rule", {
      sessionId: state.sessionId,
      ruleId: id,
    });
    setRules(updated);
    updateState({ rules: updated });
  };

  const saveMetadata = async (meta: SessionMetadata) => {
    setMetadata(meta);
    updateState({ metadata: meta });
    if (!state.sessionId) return;
    await invoke("set_metadata", { sessionId: state.sessionId, meta });
  };

  const filteredLibrary = library.filter(
    (e) =>
      !libraryFilter ||
      e.label.toLowerCase().includes(libraryFilter.toLowerCase()) ||
      e.pattern.toLowerCase().includes(libraryFilter.toLowerCase())
  );

  return (
    <div className="flex h-full">
      {/* Left: OCR text viewer */}
      <div className="w-[38%] flex flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-medium text-zinc-500">
            OCR Result ({ocrText.length} lines)
          </span>
          {matches.length > 0 && (
            <span className="text-xs text-indigo-400">
              {matches.length} matches
            </span>
          )}
        </div>
        <div
          ref={ocrRef}
          className="flex-1 overflow-y-auto p-2 terminal text-xs"
        >
          {ocrText.map((line, i) => {
            const lineNum = i + 1;
            const isHighlighted = highlightedLines.has(lineNum);
            return (
              <div
                key={i}
                data-highlighted={isHighlighted}
                className={`flex gap-2 px-1 py-0.5 rounded transition-colors ${
                  isHighlighted
                    ? "bg-indigo-950 text-indigo-200"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
              >
                <span className="text-zinc-700 w-8 flex-shrink-0 text-right select-none">
                  {lineNum}
                </span>
                <span className="break-all">{line || " "}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Middle: Regex builder */}
      <div className="w-[30%] flex flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Step 2 — Build Rules
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Pattern input */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              Regex Pattern
            </label>
            <div className="relative">
              <textarea
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="^(.+?)\s+(\d+)$"
                rows={3}
                className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none resize-none ${
                  patternError
                    ? "border-red-500"
                    : pattern && matches.length > 0
                    ? "border-indigo-500"
                    : "border-zinc-700 focus:border-indigo-500"
                }`}
              />
              {pattern && (
                <button
                  onClick={() => setPattern("")}
                  className="absolute top-2 right-2 text-zinc-600 hover:text-zinc-400 text-sm"
                >
                  ×
                </button>
              )}
            </div>
            {patternError && (
              <p className="text-xs text-red-400 mt-1">{patternError}</p>
            )}
            {!patternError && matches.length > 0 && (
              <p className="text-xs text-indigo-400 mt-1">
                ✓ {matches.length} lines matched
              </p>
            )}
            {!patternError && pattern && matches.length === 0 && (
              <p className="text-xs text-zinc-600 mt-1">No matches</p>
            )}
          </div>

          {/* Library picker */}
          <div>
            <button
              onClick={() => setShowLibrary(!showLibrary)}
              className="flex items-center gap-2 text-xs text-indigo-400 hover:text-indigo-300"
            >
              <span>{showLibrary ? "▼" : "▶"}</span>
              Regex Library ({library.length})
            </button>
            {showLibrary && (
              <div className="mt-2 border border-zinc-700 rounded-lg overflow-hidden">
                <input
                  value={libraryFilter}
                  onChange={(e) => setLibraryFilter(e.target.value)}
                  placeholder="Filter..."
                  className="w-full bg-zinc-800 px-3 py-2 text-xs text-zinc-300 focus:outline-none border-b border-zinc-700"
                />
                <div className="max-h-48 overflow-y-auto">
                  {filteredLibrary.map((entry, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setPattern(entry.pattern);
                        setPendingLabel(entry.label);
                        if (entry.rank_hint) {
                          setPendingRank(parseInt(entry.rank_hint) || 1);
                        }
                        setShowLibrary(false);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-zinc-700 border-b border-zinc-800 last:border-0"
                    >
                      <div className="text-xs text-zinc-300 truncate">
                        {entry.label}
                      </div>
                      <div className="text-xs text-zinc-600 font-mono truncate mt-0.5">
                        {entry.pattern}
                      </div>
                    </button>
                  ))}
                  {filteredLibrary.length === 0 && (
                    <div className="px-3 py-3 text-xs text-zinc-600 text-center">
                      No entries found
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Rank and label for adding */}
          {pattern && matches.length > 0 && (
            <div className="space-y-3 border-t border-zinc-800 pt-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">
                    Rank (priority, 1=top)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={pendingRank}
                    onChange={(e) => setPendingRank(Number(e.target.value))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">
                    Label (optional)
                  </label>
                  <input
                    value={pendingLabel}
                    onChange={(e) => setPendingLabel(e.target.value)}
                    placeholder="e.g. Chapter"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
              <button
                onClick={addRule}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-medium text-white transition-colors"
              >
                + Add Rule
              </button>
            </div>
          )}

          {/* Metadata: offset and cover */}
          {rules.length > 0 && (
            <div className="space-y-3 border-t border-zinc-800 pt-3">
              <p className="text-xs font-semibold text-zinc-400">
                Page Adjustments
              </p>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">
                    Offset
                    <span className="text-zinc-600 ml-1">
                      (PDF page − printed page)
                    </span>
                  </label>
                  <input
                    type="number"
                    value={metadata.offset}
                    onChange={(e) =>
                      saveMetadata({ ...metadata, offset: Number(e.target.value) })
                    }
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-zinc-500 mb-1">
                    Cover pages
                    <span className="text-zinc-600 ml-1">(0 = none)</span>
                  </label>
                  <input
                    type="text"
                    value={metadata.if_cover}
                    onChange={(e) =>
                      saveMetadata({ ...metadata, if_cover: e.target.value })
                    }
                    placeholder="0"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Rules list */}
          {rules.length > 0 && (
            <div className="space-y-2 border-t border-zinc-800 pt-3">
              <p className="text-xs font-semibold text-zinc-400">
                Active Rules ({rules.length})
              </p>
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="bg-zinc-800 rounded-lg px-3 py-2 flex items-start gap-2"
                >
                  <span className="text-xs bg-indigo-900 text-indigo-300 rounded px-1.5 py-0.5 flex-shrink-0">
                    #{rule.rank}
                  </span>
                  <div className="flex-1 min-w-0">
                    {rule.label && (
                      <div className="text-xs text-zinc-400 mb-0.5">
                        {rule.label}
                      </div>
                    )}
                    <div className="text-xs font-mono text-zinc-500 break-all">
                      {rule.pattern}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="text-zinc-600 hover:text-red-400 text-sm flex-shrink-0"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="p-4 border-t border-zinc-800 flex gap-2">
          <button
            onClick={onBack}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs text-zinc-300 transition-colors"
          >
            ← Back
          </button>
          <button
            onClick={onNext}
            disabled={rules.length === 0}
            className="flex-1 py-2 bg-green-700 hover:bg-green-600 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg text-xs font-medium text-white transition-colors"
          >
            Continue to Merge →
          </button>
        </div>
      </div>

      {/* Right: Match preview */}
      <div className="flex-1 flex flex-col bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs font-medium text-zinc-500">
            Match Preview
          </span>
          {matches.length > 0 && (
            <span className="text-xs text-zinc-600">
              group 1 = title, group 2 = page
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {matches.length === 0 ? (
            <div className="text-center text-zinc-700 mt-12 text-sm">
              <div className="text-3xl mb-3">🔍</div>
              <div>Matched TOC entries will appear here</div>
              <div className="text-xs mt-2 text-zinc-800">
                Regex must have 2 capture groups: (title)(page)
              </div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr className="text-zinc-500">
                  <th className="text-left px-3 py-2 w-12">Line</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2 w-16">Page</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => (
                  <tr
                    key={i}
                    className="border-t border-zinc-800/50 hover:bg-zinc-800/30"
                  >
                    <td className="px-3 py-1.5 text-zinc-600 font-mono">
                      {m.line_number}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-300">{m.title}</td>
                    <td className="px-3 py-1.5 text-indigo-400 font-mono">
                      {m.page}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
