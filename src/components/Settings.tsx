import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

interface Props {
  onClose: () => void;
  onSaved?: () => void;
}

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go";
const DEFAULT_MODEL = "google/gemini-3-flash";

export function Settings({ onClose, onSaved }: Props) {
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

  useEffect(() => {
    const loadModels = async () => {
      setModelsLoading(true);
      setModelsError("");
      try {
        const models = await invoke<string[]>("fetch_models", {
          baseUrl,
          apiKey: apiKey || null,
        });
        setModels(models);
      } catch (e) {
        setModelsError(String(e));
      } finally {
        setModelsLoading(false);
      }
    };
    loadModels();
  }, [baseUrl, apiKey]);

  const handleSave = () => {
    localStorage.setItem("ai_base_url", baseUrl);
    localStorage.setItem("ai_model", model);
    localStorage.setItem("ai_gateway_key", apiKey);
    localStorage.setItem("ai_protocol", protocol);
    onSaved?.();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setBaseUrl(DEFAULT_BASE_URL);
    setModel(DEFAULT_MODEL);
    setApiKey("");
    setProtocol("chat");
  };

  const handleTest = async () => {
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
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(isAnthropic
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
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
        setTestResult({ ok: false, msg: `HTTP ${resp.status}: ${await resp.text()}` });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-200">Settings</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Base URL */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              API Base URL
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URL}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 placeholder-zinc-600"
            />
            <p className="text-xs text-zinc-500 mt-1">
              OpenAI-compatible endpoint. Default: {DEFAULT_BASE_URL}
            </p>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
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
            {modelsError && (
              <div className="mt-1">
                <p className="text-xs text-red-400">{modelsError}</p>
                <button
                  onClick={() => {
                    setModelsError("");
                    setModelsLoading(true);
                    invoke<string[]>("fetch_models", { baseUrl, apiKey: apiKey || null })
                      .then(setModels)
                      .catch((e) => setModelsError(String(e)))
                      .finally(() => setModelsLoading(false));
                  }}
                  className="text-xs text-indigo-400 hover:underline mt-0.5"
                >
                  Retry
                </button>
              </div>
            )}
            {models.length > 0 && <p className="text-xs text-zinc-500 mt-1">{models.length} models available</p>}
            <p className="text-xs text-zinc-500 mt-1">
              Model used for TOC extraction
            </p>
          </div>

          {/* Protocol */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              API Protocol
            </label>
            <select
              value={protocol}
              onChange={(e) =>
                setProtocol(e.target.value as "chat" | "responses" | "anthropic")
              }
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="chat">chat-completions (/v1/chat/completions)</option>
              <option value="responses">openai-responses (/v1/responses)</option>
              <option value="anthropic">anthropic-messages (/v1/messages)</option>
            </select>
            <p className="text-xs text-zinc-500 mt-1">
              Request protocol used for AI extraction. The messages endpoint uses
              Anthropic-style auth (x-api-key) — some gateways (e.g. opencode
              zen/go) also require a bare model ID (no provider prefix).
            </p>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 placeholder-zinc-600"
            />
            <p className="text-xs text-zinc-500 mt-1">
              API key for authentication (messages protocol uses x-api-key)
            </p>
          </div>

          {/* Test connection */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testing || !apiKey}
              className="px-4 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium"
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.msg}
              </span>
            )}
          </div>

          {/* Endpoint preview */}
          <div className="bg-zinc-800 rounded-lg p-3 text-xs">
            <span className="text-zinc-500">Requests go to: </span>
            <span className="text-zinc-300 break-all">
              {baseUrl}/{protocol === "responses" ? "v1/responses" : protocol === "anthropic" ? "v1/messages" : "v1/chat/completions"}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-zinc-800">
          <button
            onClick={handleReset}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-xs text-green-400">Saved ✓</span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Re-export defaults for use in other components
export { DEFAULT_BASE_URL, DEFAULT_MODEL };
