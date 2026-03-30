export interface DepStatus {
  name: string;
  found: boolean;
  path: string | null;
  required_for: string;
}

export interface OcrOptions {
  session_id: string;
  file_path: string;
  first_page: number;
  last_page: number;
  use_textcleaner: boolean;
  language: string;
}

export interface RegexMatch {
  line_number: number;
  raw_line: string;
  title: string;
  page: string;
}

export interface RegexLibraryEntry {
  label: string;
  pattern: string;
  rank_hint: string | null;
}

export interface Rule {
  id: string;
  pattern: string;
  rank: number;
  label: string | null;
}

export interface SessionMetadata {
  offset: number;
  if_cover: string;
}

export interface TocEntry {
  title: string;
  page: number;
  raw_page: string;
  level: number;
  source_line: number;
}

export interface MergeOptions {
  session_id: string;
  input_file: string;
  output_file: string;
  merge_original: boolean;
}

export interface PageThumbnail {
  page: number;
  data: string;  // base64 image
  mime: string;  // e.g. "image/png"
}

export interface AIUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface AIRunInfo {
  at: string;
  model: string;
  usage: AIUsage;
  durationMs: number;
  success: boolean;
}

export interface TaskHistoryRecord {
  id: string;
  at: string;
  fileType: "pdf" | "djvu";
  inputFile: string;
  outputFile: string;
  selectedPages: number[];
  offset: number;
  ifCover: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  tocCount: number;
  durationMs: number;
  success: boolean;
  error: string | null;
  logs: string[];
}

export type Step = 1 | 2 | 3;

export interface AppState {
  sessionId: string | null;
  filePath: string | null;
  fileType: "pdf" | "djvu" | null;
  pageCount: number | null;
  selectedPages: number[]; // TOC pages selected by user
  ocrDone: boolean;
  aiDone: boolean; // AI extraction done
  rules: Rule[];
  metadata: SessionMetadata;
  tocEntries: TocEntry[];
  outputFile: string | null;
  apiKey: string; // Vercel AI Gateway key
  aiRunInfo: AIRunInfo | null;
}
