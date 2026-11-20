import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { Step1Select } from "./components/Step1Select";
import { Step2AI } from "./components/Step2AI";
import { Step3Merge } from "./components/Step3Merge";
import { DepsWarning } from "./components/DepsWarning";
import { TaskHistoryDrawer } from "./components/TaskHistoryDrawer";
import { Settings } from "./components/Settings";
import type { AppState, DepStatus, Step, TaskHistoryRecord, TocEntry } from "./types";

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
  aiRunInfo: null,
};

export default function App() {
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<AppState>(initialState);
  const [deps, setDeps] = useState<DepStatus[] | null>(null);
  const [showDepsWarning, setShowDepsWarning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [pendingUpdate, setPendingUpdate] = useState<
    NonNullable<Awaited<ReturnType<typeof check>>> | null
  >(null);
  const [showSettings, setShowSettings] = useState(false);
  // Bumped on Settings save so mounted steps re-sync model/protocol from localStorage
  const [settingsVersion, setSettingsVersion] = useState(0);

  const updateState = (partial: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  };

  const refreshDeps = useCallback(async (openWarningIfMissing = true) => {
    const d = await invoke<DepStatus[]>("check_deps");
    setDeps(d);
    const hasMissing = d.some((dep) => !dep.found);
    if (openWarningIfMissing && hasMissing) {
      setShowDepsWarning(true);
    }
    if (!hasMissing) {
      setShowDepsWarning(false);
    }
  }, []);

  useEffect(() => {
    // Create session
    invoke<string>("create_session").then((id) => {
      updateState({ sessionId: id });
    });

    refreshDeps(true).catch(() => undefined);

    // Auto-check for updates on startup (silent unless an update is available)
    check().then((update) => {
      if (update) {
        setPendingUpdate(update);
        setUpdateStatus(`Version ${update.version} is available`);
      }
    }).catch(() => undefined);
  }, [refreshDeps]);

  const editExistingToc = async (entries: TocEntry[]) => {
    if (!state.sessionId) return;
    await invoke("save_ai_toc", {
      sessionId: state.sessionId,
      entriesJson: JSON.stringify(entries),
    });
    updateState({ tocEntries: entries, aiDone: true });
    setStep(3);
  };

  const startNewTask = async () => {
    const newSessionId = await invoke<string>("create_session");
    setState({
      ...initialState,
      sessionId: newSessionId,
      apiKey: state.apiKey,
    });
    setStep(1);
  };

  const loadTask = async (r: TaskHistoryRecord) => {
    const newSessionId = await invoke<string>("create_session");
    const tocEntries = r.tocEntries || [];
    setState({
      ...initialState,
      sessionId: newSessionId,
      apiKey: state.apiKey,
      filePath: r.inputFile,
      fileType: r.fileType,
      selectedPages: r.selectedPages,
      metadata: { offset: r.offset, if_cover: r.ifCover || "0" },
      outputFile: r.outputFile,
      tocEntries,
      aiDone: tocEntries.length > 0,
    });
    // Persist TOC data into the new session so preview_toc / run_merge can use it
    if (tocEntries.length > 0) {
      await invoke("save_ai_toc", {
        sessionId: newSessionId,
        entriesJson: JSON.stringify(tocEntries),
      });
    }
    setStep(1);
    setShowHistory(false);
  };

  const checkUpdates = async () => {
    setUpdateBusy(true);
    setUpdateStatus("Checking updates...");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("Already on latest version");
        return;
      }

      setPendingUpdate(update);
      setUpdateStatus(`Version ${update.version} is available`);
    } catch (e) {
      setUpdateStatus(`Update check failed: ${String(e)}`);
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate || updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus(`Downloading version ${pendingUpdate.version}...`);
    try {
      await pendingUpdate.downloadAndInstall();
      setUpdateStatus("Update installed. Restart OCR Bookmarker to finish.");
      setPendingUpdate(null);
    } catch (e) {
      setUpdateStatus(`Update failed: ${String(e)}`);
    } finally {
      setUpdateBusy(false);
    }
  };

  useEffect(() => {
    if (!pendingUpdate) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !updateBusy) setPendingUpdate(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingUpdate, updateBusy]);

  const goToStep = (s: Step) => setStep(s);

  const steps = [
    { num: 1 as Step, label: "Select Pages" },
    { num: 2 as Step, label: "AI Extract" },
    { num: 3 as Step, label: "Merge" },
  ];

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header
        className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-4 select-none"
        data-tauri-drag-region
      >
        <div className="flex flex-shrink-0 items-center gap-2" data-tauri-drag-region>
          <svg
            className="h-5 w-5 text-indigo-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="hidden text-sm font-semibold tracking-tight text-zinc-100 lg:inline">
            OCR Bookmarker
          </span>
        </div>

        <nav className="flex min-w-0 flex-1 items-center justify-center" aria-label="Workflow">
          {steps.map((s, i) => {
            const available =
              s.num <= step ||
              (s.num === 2 && state.selectedPages.length > 0) ||
              (s.num === 3 && state.aiDone);
            const active = step === s.num;
            return (
              <div key={s.num} className="flex min-w-0 items-center">
                <button
                  type="button"
                  onClick={() => available && goToStep(s.num)}
                  disabled={!available}
                  aria-current={active ? "step" : undefined}
                  className={`flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-indigo-600 text-white shadow-sm"
                      : available
                        ? "text-zinc-300 hover:bg-zinc-800 hover:text-white"
                        : "cursor-default text-zinc-600"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px] ${
                      active
                        ? "bg-white/20 text-white"
                        : s.num < step
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-zinc-800 text-zinc-500"
                    }`}
                    aria-hidden="true"
                  >
                    {s.num < step ? "✓" : s.num}
                  </span>
                  <span className="whitespace-nowrap">{s.label}</span>
                </button>
                {i < steps.length - 1 && (
                  <span className="mx-1 text-zinc-700" aria-hidden="true">›</span>
                )}
              </div>
            );
          })}
        </nav>

        <div className="flex flex-shrink-0 items-center gap-1">
          {deps && deps.some((d) => !d.found) && (
            <button
              type="button"
              onClick={() => setShowDepsWarning(true)}
              className="mr-1 flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-amber-400 hover:bg-amber-950/50 hover:text-amber-300"
              title="Missing external tools"
            >
              <span aria-hidden="true">⚠</span>
              <span className="hidden xl:inline">Missing tools</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            title="Settings"
            aria-label="Settings"
          >
            <span aria-hidden="true">⚙</span>
            <span className="hidden xl:inline">Settings</span>
          </button>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            title="Task history"
            aria-label="Task history"
          >
            <span aria-hidden="true">◷</span>
            <span className="hidden xl:inline">History</span>
          </button>
          <button
            type="button"
            onClick={checkUpdates}
            disabled={updateBusy}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-50"
            title="Check for updates"
            aria-label="Check for updates"
          >
            <span className={updateBusy ? "animate-spin" : ""} aria-hidden="true">
              {updateBusy ? "⟳" : "↑"}
            </span>
            <span className="hidden xl:inline">{updateBusy ? "Checking…" : "Update"}</span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {step === 1 && (
          <Step1Select
            state={state}
            updateState={updateState}
            onNext={() => goToStep(2)}
            onEditExisting={editExistingToc}
          />
        )}
        {step === 2 && (
          <Step2AI
            state={state}
            updateState={updateState}
            onNext={() => goToStep(3)}
            onBack={() => goToStep(1)}
            settingsVersion={settingsVersion}
          />
        )}
        {step === 3 && (
          <Step3Merge
            state={state}
            updateState={updateState}
            onBack={() => goToStep(2)}
            onStartNewTask={startNewTask}
          />
        )}
      </main>

      {updateStatus && (
        <div
          className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/95 px-4 py-2.5 text-xs text-zinc-300 shadow-2xl backdrop-blur"
          role="status"
          aria-live="polite"
        >
          <span className="min-w-0 break-words">{updateStatus}</span>
          {!pendingUpdate && (
            <button
              type="button"
              onClick={() => setUpdateStatus("")}
              className="flex-shrink-0 rounded px-1 text-zinc-500 hover:text-zinc-200"
              aria-label="Dismiss update status"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {showDepsWarning && deps && (
        <DepsWarning
          deps={deps}
          onClose={() => setShowDepsWarning(false)}
          onRecheck={() => refreshDeps(false)}
        />
      )}

      <TaskHistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        onLoadTask={loadTask}
      />

      {showSettings && (
        <Settings
          active={!pendingUpdate}
          onClose={() => setShowSettings(false)}
          onSaved={() => setSettingsVersion((v) => v + 1)}
        />
      )}

      {pendingUpdate && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => !updateBusy && setPendingUpdate(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-title"
            className="flex h-[260px] w-[440px] max-w-full flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 id="update-title" className="text-sm font-semibold text-zinc-100">
                Install version {pendingUpdate.version}?
              </h2>
              <p className="mt-1 text-xs text-zinc-500">OCR Bookmarker update</p>
            </div>
            <div className="flex-1 px-5 py-4 text-xs leading-relaxed text-zinc-400">
              Download and install the update now. Restart the app after installation to use the new version.
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
              <button
                type="button"
                autoFocus
                onClick={() => setPendingUpdate(null)}
                disabled={updateBusy}
                className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={installUpdate}
                disabled={updateBusy}
                className="min-w-28 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-wait disabled:bg-zinc-700"
              >
                {updateBusy ? "Installing…" : "Download & install"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
