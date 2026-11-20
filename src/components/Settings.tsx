import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

interface Props {
  active?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3425";
const DEFAULT_MODEL = "qwen-cn/qwen3.8-flash";

export function Settings({ active = true, onClose, onSaved }: Props) {
  const [baseUrl, setBaseUrl] = useState(
    localStorage.getItem("ai_base_url") || DEFAULT_BASE_URL
  );
  const [model, setModel] = useState(
    localStorage.getItem("ai_model") || DEFAULT_MODEL
  );
  const [apiKey, setApiKey] = useState(
    localStorage.getItem("ai_gateway_key") || ""
  );
  const [protocol, setProtocol] = useState<"chat" | "responses" | "anthropic">(
    (localStorage.getItem("ai_protocol") as "chat" | "responses" | "anthropic") || "chat"
  );
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelsRevision, setModelsRevision] = useState(0);
  const [showKey, setShowKey] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [savedValues, setSavedValues] = useState({ baseUrl, model, apiKey, protocol });
  const testAbortRef = useRef<AbortController | null>(null);
  const dirty =
    baseUrl !== savedValues.baseUrl ||
    model !== savedValues.model ||
    apiKey !== savedValues.apiKey ||
    protocol !== savedValues.protocol;

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setModelsLoading(true);
      setModelsError("");
      try {
        const nextModels = await invoke<string[]>("fetch_models", {
          baseUrl,
          apiKey: apiKey || null,
        });
        if (active) setModels(nextModels);
      } catch (e) {
        if (active) setModelsError(String(e));
      } finally {
        if (active) setModelsLoading(false);
      }
    }, 450);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [baseUrl, apiKey, modelsRevision]);

  useEffect(() => () => testAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showDiscard) {
        setShowDiscard(false);
        return;
      }
      testAbortRef.current?.abort();
      if (dirty) setShowDiscard(true);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, dirty, onClose, showDiscard]);

  const invalidateTest = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTesting(false);
    setTestResult(null);
  };

  const cancelTest = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTesting(false);
    setTestResult({ ok: false, msg: "Connection test cancelled." });
  };

  const requestClose = () => {
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTesting(false);
    if (dirty) setShowDiscard(true);
    else onClose();
  };

  const handleSave = () => {
    localStorage.setItem("ai_base_url", baseUrl);
    localStorage.setItem("ai_model", model);
    localStorage.setItem("ai_gateway_key", apiKey);
    localStorage.setItem("ai_protocol", protocol);
    onSaved?.();
    setSavedValues({ baseUrl, model, apiKey, protocol });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    invalidateTest();
    setBaseUrl(DEFAULT_BASE_URL);
    setModel(DEFAULT_MODEL);
    setApiKey("");
    setProtocol("chat");
    setTestResult(null);
  };

  const handleTest = async () => {
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    let didTimeout = false;
    const timeout = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, 20_000);
    setTesting(true);
    setTestResult(null);
    try {
      const isAnthropic = protocol === "anthropic";
      const endpoint = isAnthropic
        ? `${baseUrl}/v1/messages`
        : protocol === "responses"
          ? `${baseUrl}/v1/responses`
          : `${baseUrl}/v1/chat/completions`;
      const body = isAnthropic
        ? {
            model,
            max_tokens: 16,
            messages: [{ role: "user", content: "Say OK" }],
          }
        : protocol === "responses"
          ? {
              model,
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: "Say OK" }],
                },
              ],
              max_output_tokens: 16,
            }
          : {
              model,
              messages: [{ role: "user", content: "Say OK" }],
              max_tokens: 10,
            };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
        if (isAnthropic) headers["x-api-key"] = apiKey;
      }
      if (isAnthropic) headers["anthropic-version"] = "2023-06-01";

      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (controller.signal.aborted || testAbortRef.current !== controller) return;
      if (resp.ok) {
        const data = await resp.json();
        if (controller.signal.aborted || testAbortRef.current !== controller) return;
        let reply: unknown = null;
        if (isAnthropic) {
          const content = data.content as Array<Record<string, unknown>> | undefined;
          reply = content?.find((b) => b.type === "text")?.text;
        } else if (protocol === "responses") {
          reply = data.output_text || data.output?.[0]?.content?.[0]?.text;
        } else {
          reply = data.choices?.[0]?.message?.content;
        }
        const text = typeof reply === "string" ? reply : "(no content)";
        setTestResult({ ok: true, msg: `Success: ${text.slice(0, 50)}` });
      } else {
        const message = await resp.text();
        if (controller.signal.aborted || testAbortRef.current !== controller) return;
        setTestResult({ ok: false, msg: `HTTP ${resp.status}: ${message}` });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setTestResult({ ok: false, msg: String(e) });
      } else if (didTimeout) {
        setTestResult({ ok: false, msg: "Connection test timed out after 20 seconds." });
      }
    } finally {
      window.clearTimeout(timeout);
      if (testAbortRef.current === controller) {
        testAbortRef.current = null;
        setTesting(false);
      }
    }
  };

  const inputClass =
    "h-9 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-200 placeholder-zinc-600 transition-colors hover:border-zinc-600 focus:border-indigo-500 focus:outline-none";
  const endpoint = `${baseUrl}/${
    protocol === "responses"
      ? "v1/responses"
      : protocol === "anthropic"
        ? "v1/messages"
        : "v1/chat/completions"
  }`;
  const modelOptions = models.includes(model) ? models : [model, ...models];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={requestClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-[700px] max-h-[calc(100dvh-48px)] w-[680px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 id="settings-title" className="text-sm font-semibold text-zinc-100">Settings</h2>
            <p className="mt-0.5 text-xs text-zinc-500">AI gateway and extraction defaults</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <section aria-labelledby="connection-heading">
            <div className="mb-3">
              <h3 id="connection-heading" className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Connection</h3>
              <p className="mt-1 text-xs text-zinc-500">Local and hosted OpenAI-compatible gateways are supported.</p>
            </div>
            <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/30 p-4">
              <div>
                <label htmlFor="settings-base-url" className="mb-1.5 block text-xs font-medium text-zinc-300">API Base URL</label>
                <input
                  id="settings-base-url"
                  type="url"
                  value={baseUrl}
                  onChange={(event) => {
                    invalidateTest();
                    setBaseUrl(event.target.value);
                  }}
                  placeholder={DEFAULT_BASE_URL}
                  spellCheck={false}
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="settings-protocol" className="mb-1.5 block text-xs font-medium text-zinc-300">API Protocol</label>
                <select
                  id="settings-protocol"
                  value={protocol}
                  onChange={(event) => {
                    invalidateTest();
                    setProtocol(event.target.value as "chat" | "responses" | "anthropic");
                  }}
                  className={inputClass}
                >
                  <option value="chat">Chat Completions · /v1/chat/completions</option>
                  <option value="responses">OpenAI Responses · /v1/responses</option>
                  <option value="anthropic">Anthropic Messages · /v1/messages</option>
                </select>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                  Messages uses x-api-key when a key is provided. Some gateways require a bare model ID without a provider prefix.
                </p>
              </div>

              <div>
                <label htmlFor="settings-api-key" className="mb-1.5 block text-xs font-medium text-zinc-300">
                  API Key <span className="font-normal text-zinc-500">(optional for local gateways)</span>
                </label>
                <div className="relative">
                  <input
                    id="settings-api-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => {
                      invalidateTest();
                      setApiKey(event.target.value);
                    }}
                    placeholder="sk-..."
                    autoComplete="off"
                    spellCheck={false}
                    className={`${inputClass} pr-16`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((visible) => !visible)}
                    className="absolute inset-y-0 right-0 px-3 text-xs text-zinc-500 hover:text-zinc-200"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              <div className="rounded-md bg-zinc-950 px-3 py-2.5 text-xs">
                <div className="mb-1 text-zinc-500">Request endpoint</div>
                <div className="select-text break-all font-mono leading-relaxed text-zinc-400">{endpoint}</div>
              </div>
            </div>
          </section>

          <section aria-labelledby="model-heading">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h3 id="model-heading" className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Extraction model</h3>
                <p className="mt-1 text-xs text-zinc-500">Used for table-of-contents vision extraction.</p>
              </div>
              <button
                type="button"
                onClick={() => setModelsRevision((revision) => revision + 1)}
                disabled={modelsLoading}
                className="flex-shrink-0 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
              >
                {modelsLoading ? "Loading…" : "Refresh models"}
              </button>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-4">
              <label htmlFor="settings-model" className="mb-1.5 block text-xs font-medium text-zinc-300">Model</label>
              <select
                id="settings-model"
                value={model}
                onChange={(event) => {
                  invalidateTest();
                  setModel(event.target.value);
                }}
                className={inputClass}
              >
                {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <div className="mt-2 min-h-4 text-xs" aria-live="polite">
                {modelsLoading && <span className="text-zinc-500">Refreshing available models…</span>}
                {!modelsLoading && !modelsError && models.length > 0 && (
                  <span className="text-zinc-500">{models.length} models available</span>
                )}
                {modelsError && (
                  <div className="flex items-start gap-2 text-red-400">
                    <span className="min-w-0 flex-1 break-words">{modelsError}</span>
                    <button
                      type="button"
                      onClick={() => setModelsRevision((revision) => revision + 1)}
                      className="flex-shrink-0 text-indigo-400 hover:text-indigo-300"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="test-heading" className="pb-1">
            <h3 id="test-heading" className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-300">Connection test</h3>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !baseUrl || !model}
                  className="rounded-md bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  {testing ? "Testing…" : "Test current settings"}
                </button>
                {testing && (
                  <button
                    type="button"
                    onClick={cancelTest}
                    className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    Cancel test
                  </button>
                )}
                <span className="text-xs text-zinc-500">Tests edits before saving them.</span>
              </div>
              {testResult && (
                <div
                  className={`mt-3 max-h-24 overflow-y-auto rounded-md border px-3 py-2 text-xs leading-relaxed break-words ${
                    testResult.ok
                      ? "border-emerald-900 bg-emerald-950/50 text-emerald-400"
                      : "border-red-900 bg-red-950/50 text-red-400"
                  }`}
                  role="status"
                >
                  {testResult.msg}
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="flex flex-shrink-0 items-center justify-between border-t border-zinc-800 px-5 py-4">
          <button
            type="button"
            onClick={handleReset}
            className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <span className={`mr-1 text-xs ${saved && !dirty ? "text-emerald-400" : "text-zinc-500"}`} aria-live="polite">
              {saved && !dirty ? "Saved ✓" : dirty ? "Unsaved changes" : ""}
            </span>
            <button
              type="button"
              onClick={requestClose}
              className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || testing || !baseUrl || !model}
              className="min-w-20 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              Save
            </button>
          </div>
        </footer>
      </section>

      {showDiscard && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6" onClick={() => setShowDiscard(false)}>
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-settings-title"
            className="flex h-[220px] w-[420px] max-w-full flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex-1 px-5 py-5">
              <h3 id="discard-settings-title" className="text-sm font-semibold text-zinc-100">Discard unsaved changes?</h3>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">Your edited gateway, protocol, model, and key have not been saved.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-4">
              <button type="button" autoFocus onClick={() => setShowDiscard(false)} className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Keep editing</button>
              <button type="button" onClick={onClose} className="rounded-md bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-600">Discard changes</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// Re-export defaults for use in other components
export { DEFAULT_BASE_URL, DEFAULT_MODEL };
