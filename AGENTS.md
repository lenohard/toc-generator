# AGENTS.md

## Project: `ocr-bookmarker`

Desktop app (Tauri + React) for adding bookmarks to **PDF/DjVu** files from table-of-contents pages.

Primary workflow:
1. Select TOC pages from document preview
2. Use AI vision model to extract TOC entries
3. Merge entries back into PDF/DjVu bookmarks

## Tech Stack

- Frontend: React 19 + TypeScript + Vite + Tailwind v4
- Desktop shell: Tauri v2 (Rust backend)
- Backend language: Rust 2021
- AI endpoint: Vercel AI Gateway (`/v1/chat/completions`)，同时支持 OpenAI Responses（`/v1/responses`）与 Anthropic Messages（`/v1/messages`，`x-api-key` + `anthropic-version` 头）协议，协议可在 Settings 选择（localStorage `ai_protocol`: `chat` | `responses` | `anthropic`，默认 `chat`）。responses/messages 流式解析要点见 model-gateway skill 对应章节。

## Key Directories

- `src/` — React UI
  - `components/Step1Select.tsx` — file picker, page selection, API key + metadata
  - `components/Step2AI.tsx` — AI extraction + manual TOC editing
  - `components/Step3Merge.tsx` — TOC preview + merge execution
  - `components/Step2Regex.tsx` — legacy regex workflow (currently not in active step flow)
- `src-tauri/src/commands/` — Rust commands exposed to frontend
  - `deps.rs` — external CLI dependency checks
  - `pages.rs` — page count + thumbnail/full-page rendering
  - `ocr.rs` — OCR pipeline (legacy/optional path)
  - `regex_tools.rs` — regex rules + metadata + fallback parsing
  - `merge.rs` — TOC building + bookmark writing (PDF/DjVu)
  - `session.rs` — temp session lifecycle

## Runtime Requirements

External binaries used by Rust commands:
- Required for core flow:
  - `pdftoppm`, `pdfinfo` (PDF rendering/info)
  - `ddjvu`, `djvused` (DjVu rendering/merge)
  - `pdftk` (PDF bookmark merge)
- OCR/regex legacy path:
  - `tesseract`, `pdftotext`, optional `textcleaner`, `gawk`

Assume macOS/Homebrew paths are available (`/opt/homebrew/bin`).

## Local Run / Build

- Frontend dev only: `npm run dev`
- Frontend build: `npm run build`
- Lint: `npm run lint`
- Tauri dev app: `npx tauri dev`
- Tauri build: `npx tauri build`

## Data & Session Model

- Session working dir: `${TMPDIR}/ocr-bookmarker/<session_id>/`
- Important session artifacts:
  - `ai_toc.json` (preferred TOC source for merge)
  - `metadata.json` (`offset`, `if_cover`)
  - `rules.json`, `result.txt` (regex/OCR fallback path)

Important behavior:
- `merge::build_toc()` **prefers `ai_toc.json`** if present.
- Page adjustment is applied in merge using:
  - `offset`
  - `if_cover` (cover page count/rule)

## Agent Guidance

When making changes, follow these rules:

1. Keep the 3-step UX intact (`Select -> AI Extract -> Merge`).
2. Preserve API contracts between TS types (`src/types.ts`) and Rust structs.
3. If adding a new Tauri command:
   - implement in `src-tauri/src/commands/*.rs`
   - register in `src-tauri/src/lib.rs` `generate_handler!`
   - update TS invoke call sites and types
4. Prefer extending AI flow (`Step2AI`) over regex flow unless explicitly requested.
5. Do not break DjVu support while changing PDF features (and vice versa).
6. Avoid logging or exposing API keys in console/UI/errors.
7. Keep temp/session file operations scoped by `session_id`.
8. If touching merge logic, verify both:
   - TOC preview (`preview_toc`)
   - final merge output (`run_merge`)

## Manual Verification Checklist

For non-trivial changes, validate:

1. Open a PDF and a DjVu file successfully.
2. Page thumbnails load and selection works.
3. AI extraction returns editable entries.
4. Step 3 preview shows expected hierarchy + adjusted page numbers.
5. Output file is generated and can be opened.
6. Existing bookmark merge option still works for PDF.

## Credentials & Tokens

- **GitHub token**: configured in `.envrc` (auto-loaded by direnv). Use `$GITHUB_TOKEN` directly in shell/curl for GitHub repo management (releases, PRs, etc.) — no manual setup needed.

## Tauri v2 HTTP Plugin (CORS bypass)

- Browser `fetch` in Tauri webview is blocked by CORS. Use `import { fetch } from "@tauri-apps/plugin-http"` instead.
- `http:default` alone allows NO URLs. Scope must be explicit on the permission entry:
  ```json
  { "identifier": "http:default", "allow": [{ "url": "https://example.com/**" }] }
  ```
- Capability changes require `tauri dev` restart (not hot-reloadable).

## Notes

- 配置项（localStorage）：`ai_base_url`、`ai_model`、`ai_gateway_key`、`ai_protocol`。Settings 点 Save 才写入。
- Settings 保存后通过 `onSaved` 回调触发 App 的 `settingsVersion` state 自增，Step2AI 用 `useEffect([settingsVersion])` 重新同步 model/protocol state——否则已挂载的 Step2 感知不到 Settings 改动（model/protocol 是 useState，仅在挂载时读 localStorage）。
- **发版流程**：分支是 `master`（非 main）。bump 三处版本号（`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`）→ commit → `git tag vX.Y.Z` → push master + tag。GitHub Actions（`.github/workflows/release.yml`）自动构建签名并发布到 GitHub Releases（含 `latest.json`/`.app.tar.gz`/`.sig`），用户端启动时 `check()` 自动更新，无需重装。CI 未配 Apple notarization（分发给他人需先右键打开）。

- Current default AI model in UI: `google/gemini-3-flash`.
- API key is currently stored in `localStorage` (`ai_gateway_key`).
- Global generation task history is available from header **Task History** drawer and persisted to app data JSON (`task_history.json`) via Tauri history commands.
- Auto-update plumbing is enabled via `tauri-plugin-updater` (manual check button in header); release bundles generate updater artifacts (`bundle.createUpdaterArtifacts=true`).
- `README.md` is still template text; use this file as the practical repo guide until README is replaced.
- In Step 2 AI extraction, `TocEntry.raw_page` must preserve the printed TOC page label exactly as extracted (including roman numerals like `iv`, `xii`). `TocEntry.page` is used as a numeric working value: for numeric printed pages it represents the logical parsed number before offset, while for non-numeric printed pages resolved by the user it represents the final PDF page index.
- Step 2 should display both the printed page label and the actual merge target PDF page. The displayed PDF page for numeric printed pages must be computed from metadata using the same offset/cover logic as merge preview; for non-numeric printed pages, use the user-resolved final PDF page directly.
- Step 3 / merge logic must not apply offset twice to non-numeric printed pages. If `raw_page` is non-numeric, treat stored `page` as the final PDF page index.
- The Step 2 page inspector should use high-resolution rendering (`render_pages_for_ai`) rather than low-resolution thumbnails so the side panel remains sharp when resized.

- ocr-bookmarker 的 git 分支是 `master` 不是 `main`；远端 tag 可能领先本地（v0.1.7-0.1.9 曾只在远端），发布前先 `git fetch --tags`。
- ocr-bookmarker 发版流程：改 `tauri.conf.json` + `Cargo.toml` + `package.json` 三处版本号 → commit → `git tag vX.Y.Z` → push master + tag → GitHub Actions 自动发布（含 latest.json 等 updater 产物），用户端启动时自动 check + 原地更新，无需重装。
