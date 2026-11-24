/**
 * pandoc-wasm's package `exports` map only exposes the top-level entry, whose
 * browser build fetches its own wasm (bypassing ctx.fetchAsset). We import
 * `core.js` by path instead and hand it the wasm bytes ourselves.
 */
declare module '*/pandoc-wasm/src/core.js' {
  export interface PandocWarning {
    type: string;
    verbosity?: string;
    pretty?: string;
    message?: string;
    path?: string;
    for?: string;
  }
  export interface PandocResult {
    stdout: string;
    stderr: string;
    warnings: PandocWarning[];
    files: Record<string, Blob | string>;
    mediaFiles: Record<string, Blob>;
  }
  export interface PandocInstance {
    convert(
      options: Record<string, unknown>,
      stdin: string | null,
      files: Record<string, Blob | string>,
    ): Promise<PandocResult>;
    query(options: Record<string, unknown>): unknown;
  }
  export function createPandocInstance(wasm: Uint8Array | ArrayBuffer): Promise<PandocInstance>;
}
