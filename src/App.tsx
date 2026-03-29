import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Step1Select } from "./components/Step1Select";
import { Step2AI } from "./components/Step2AI";
import { Step3Merge } from "./components/Step3Merge";
import { DepsWarning } from "./components/DepsWarning";
import type { AppState, DepStatus, Step } from "./types";

const initialState: AppState = {
  sessionId: null,
  filePath: null,
  fileType: null,
  pageCount: null,
  selectedPages: [],
  ocrDone: false,
  aiDone: false,
  rules: [],
  metadata: { offset: 0, if_cover: "0" },
  tocEntries: [],
  outputFile: null,
  apiKey: localStorage.getItem("ai_gateway_key") || "",
};

export default function App() {
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<AppState>(initialState);
  const [deps, setDeps] = useState<DepStatus[] | null>(null);
  const [showDepsWarning, setShowDepsWarning] = useState(false);

  useEffect(() => {
    // Create session
    invoke<string>("create_session").then((id) => {
      updateState({ sessionId: id });
    });
    // Check deps
    invoke<DepStatus[]>("check_deps").then((d) => {
      setDeps(d);
      const missing = d.filter((dep) => !dep.found);
      if (missing.length > 0) setShowDepsWarning(true);
    });
  }, []);

  const updateState = (partial: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  };

  const goToStep = (s: Step) => setStep(s);

  const steps = [
    { num: 1 as Step, label: "Select Pages" },
    { num: 2 as Step, label: "AI Extract" },
    { num: 3 as Step, label: "Merge" },
  ];

  return (
    <div className="flex flex-col h-screen bg-zinc-950">
      {/* Title bar / Header */}
      <div
        className="flex items-center gap-4 px-6 py-3 bg-zinc-900 border-b border-zinc-800 select-none"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <svg
            className="w-5 h-5 text-indigo-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="text-sm font-semibold text-zinc-200">
            OCR Bookmarker
          </span>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 ml-4">
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center">
              <button
                onClick={() => {
                  if (
                    s.num <= step ||
                    (s.num === 2 && state.selectedPages.length > 0) ||
                    (s.num === 3 && state.aiDone)
                  ) {
                    goToStep(s.num);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  step === s.num
                    ? "bg-indigo-600 text-white"
                    : s.num < step ||
                      (s.num === 2 && state.selectedPages.length > 0) ||
                      (s.num === 3 && state.aiDone)
                    ? "text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                    : "text-zinc-600 cursor-default"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-xs ${
                    step === s.num
                      ? "bg-white/20"
                      : s.num < step
                      ? "bg-green-500/20 text-green-400"
                      : "bg-zinc-700"
                  }`}
                >
                  {s.num < step ? "✓" : s.num}
                </span>
                {s.label}
              </button>
              {i < steps.length - 1 && (
                <span className="text-zinc-700 mx-1">›</span>
              )}
            </div>
          ))}
        </div>

        {/* Deps warning indicator */}
        {deps && deps.some((d) => !d.found) && (
          <button
            onClick={() => setShowDepsWarning(true)}
            className="ml-auto flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300"
          >
            <span>⚠</span>
            <span>Missing tools</span>
          </button>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {step === 1 && (
          <Step1Select
            state={state}
            updateState={updateState}
            onNext={() => goToStep(2)}
          />
        )}
        {step === 2 && (
          <Step2AI
            state={state}
            updateState={updateState}
            onNext={() => goToStep(3)}
            onBack={() => goToStep(1)}
          />
        )}
        {step === 3 && (
          <Step3Merge
            state={state}
            updateState={updateState}
            onBack={() => goToStep(2)}
          />
        )}
      </div>

      {/* Deps warning modal */}
      {showDepsWarning && deps && (
        <DepsWarning
          deps={deps}
          onClose={() => setShowDepsWarning(false)}
        />
      )}
    </div>
  );
}
