export interface BackfillOptions {
  d1?: string;
  bucket?: string;
  persistTo: string;
  remote: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number;
  concurrency: number;
  sqlBatchSize: number;
  maxObjectBytes: number;
  maxDownloadBytes: number;
  maxPixels: number;
  rowTimeoutMs: number;
  help?: boolean;
}

export interface BackfillRow {
  id: number | string;
  r2_key: string;
  blurhash?: string | null;
}

export interface UpdateRow {
  id: number;
  r2Key?: string;
  blurhash: string;
}

export interface BackfillSummary {
  args: BackfillOptions;
  selected: number;
  decoded: number;
  wouldUpdate: number;
  updated: number;
  conflicted: number;
  failed: number;
  problems: string[];
  queryFailed: boolean;
  dryRun: boolean;
}

export interface BackfillDependencies {
  queryPage?: (context: {
    args: BackfillOptions;
    cursor: number;
    limit: number;
    force: boolean;
    sql: string;
  }) => Promise<BackfillRow[]>;
  readObject?: (key: string, context: {
    signal: AbortSignal;
    bucket?: string;
    maxObjectBytes: number;
    maxDownloadBytes: number;
  }) => Promise<Uint8Array | ArrayBuffer>;
  encode?: (bytes: Uint8Array, options: { maxPixels: number }) => Promise<string> | string;
  writeBatch?: (input: {
    args: BackfillOptions;
    rows: UpdateRow[];
    force: boolean;
    sql: string;
  }) => Promise<number | { changes: number }> | number | { changes: number };
}

export const DEFAULT_PERSIST_TO: string;
export const DEFAULT_LIMIT: number;
export const MAX_LIMIT: number;
export const DEFAULT_CONCURRENCY: number;
export const MAX_CONCURRENCY: number;
export const DEFAULT_SQL_BATCH_SIZE: number;
export const MAX_SQL_BATCH_SIZE: number;
export const DEFAULT_ROW_TIMEOUT_MS: number;
export const MAX_ROW_TIMEOUT_MS: number;
export const MAX_PAGE_SIZE: number;
export const MAX_OBJECT_BYTES: number;
export const MAX_DOWNLOAD_BYTES: number;
export const MAX_SHARP_PIXELS: number;

export function parseArgs(argv?: string[]): BackfillOptions;
export function assertR2Key(value: unknown, label?: string): string;
export function assertBlurhash(value: unknown, label?: string): string;
export function buildUpdateSql(rows: Array<{ id: unknown; blurhash: unknown }>, options?: { force?: boolean }): string;
export function selectPageSql(cursor: number, limit: number, options?: { force?: boolean }): string;
export function runBounded<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>;
export function runBackfill(
  argvOrArgs?: string[] | BackfillOptions,
  dependencies?: BackfillDependencies,
): Promise<BackfillSummary>;
export function main(argv?: string[]): Promise<BackfillSummary | { help: true; args: BackfillOptions } | null>;
