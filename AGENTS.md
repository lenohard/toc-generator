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
- AI endpoint: Vercel AI Gateway (`/v1/chat/completions`)

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

## Notes

- Current default AI model in UI: `google/gemini-3-flash`.
- API key is currently stored in `localStorage` (`ai_gateway_key`).
- Global generation task history is available from header **Task History** drawer and persisted to app data JSON (`task_history.json`) via Tauri history commands.
- Auto-update plumbing is enabled via `tauri-plugin-updater` (manual check button in header); release bundles generate updater artifacts (`bundle.createUpdaterArtifacts=true`).
- `README.md` is still template text; use this file as the practical repo guide until README is replaced.
