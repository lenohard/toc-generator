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
  data: string; // base64 PNG
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
}
