export interface Env {
  DB: D1Database;
  ACCOUNTS: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_KEY: string;
  API_KEY?: string;
  ENCRYPTION_KEY: string;
  DEFAULT_MODEL?: string;
  MAX_ACCOUNTS?: string;
  MAX_REQUEST_BYTES?: string;
  REQUEST_TIMEOUT_MS?: string;
  SESSION_TTL_SECONDS?: string;
  ACCOUNT_LOCATION_HINT?: string;
}
export interface AccountRow {
  id: string;
  label: string;
  enabled: number;
  last_used: number;
  health: string;
  cooldown_until: number;
}
export interface Credentials {
  cookie: string;
  userAgent?: string;
  xsrf?: string;
  bl?: string;
  pushId?: string;
  pctx?: string;
  fetchedAt?: number;
  refreshedAt?: number;
}
export interface Session {
  metadata: unknown[];
  turn: number;
  updatedAt: number;
  model: string;
}
export interface Model {
  id: string;
  hex: string;
  mode: number;
  thinking?: boolean;
  tool?: number;
}
export interface InputFile {
  data: string;
  mime: string;
  name: string;
}
export interface GenerateInput {
  model: string;
  prompt: string;
  files: InputFile[];
  stream: boolean;
  owner: string;
  session?: string;
  resume?: boolean;
  endpoint: string;
  tools?: Tool[];
  toolChoice?: unknown;
  responseFormat?: unknown;
  includeUsage?: boolean;
}
export interface Tool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}
export interface Artifact {
  id: string;
  mime: string;
  url: string;
  owner: string;
  expiresAt: number;
}
export interface Result {
  text: string;
  actualModel: string;
  metadata: unknown[];
  canvas: string;
  urls: string[];
  toolCalls?: unknown[];
  artifacts?: { id: string; mime: string }[];
}
