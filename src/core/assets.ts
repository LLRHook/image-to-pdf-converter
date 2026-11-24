/**
 * Same-origin engine asset loading with byte-accurate progress.
 *
 * Privacy guard: only same-origin URLs are allowed. The CSP enforces the same
 * thing in the browser; this makes the rule explicit and testable.
 *
 * Accurate totals: GitHub Pages may gzip responses, in which case
 * Content-Length is the compressed size while the stream yields decompressed
 * bytes. The build writes `asset-sizes.json` (decompressed sizes of every
 * emitted asset), which is the authoritative total when present.
 */

let sizes: Promise<Record<string, number>> | null = null;

function baseUrl(): string {
  return new URL(import.meta.env?.BASE_URL ?? '/', self.location.href).href;
}

function loadSizes(): Promise<Record<string, number>> {
  sizes ??= fetch(new URL('asset-sizes.json', baseUrl()))
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : {}))
    .catch(() => ({}));
  return sizes;
}

export function assertSameOrigin(url: string, origin = self.location.origin): URL {
  const u = new URL(url, self.location.href);
  if (u.origin !== origin) throw new Error(`Blocked non-local asset: ${u.origin}`);
  return u;
}

export async function fetchAsset(
  url: string,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const u = assertSameOrigin(url);
  const [res, manifest] = await Promise.all([fetch(u, { credentials: 'omit' }), loadSizes()]);
  if (!res.ok || !res.body) throw new Error(`Could not load ${u.pathname} (${res.status})`);

  const rel = u.pathname.startsWith(new URL(baseUrl()).pathname)
    ? u.pathname.slice(new URL(baseUrl()).pathname.length)
    : u.pathname;
  const encoded = !!res.headers.get('content-encoding');
  const header = Number(res.headers.get('content-length'));
  const total = manifest[rel] ?? (!encoded && header > 0 ? header : null);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
