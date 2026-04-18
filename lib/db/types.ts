export type Session = {
  id: string;
  slug: string | null;
  cwd: string;
  project: string;
  git_branch: string | null;
  cc_version: string | null;
  started_at: number;
  ended_at: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  turn_count: number;
  tool_call_count: number;
  source_file: string;
  ingested_at: number;
};

export type Turn = {
  id: string;
  session_id: string;
  parent_uuid: string | null;
  sequence: number;
  timestamp: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  stop_reason: string | null;
  user_prompt: string | null;
  assistant_text: string | null;
  tool_uses_json: string;
};

export type ToolCall = {
  id: string;
  turn_id: string;
  tool_name: string;
  input_json: string;
  result_json: string | null;
  result_is_error: number;
};

export type Rating = {
  turn_id: string;
  rating: -1 | 0 | 1;
  note: string | null;
  rated_at: number;
};

export type OtelScrape = {
  id: number;
  scraped_at: number;
  metric_name: string;
  labels_json: string;
  value: number;
};

export type { Result } from '@/lib/result';
