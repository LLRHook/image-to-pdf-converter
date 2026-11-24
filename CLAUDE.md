# CLAUDE.md

Guidance for agents working in this repository.

## Project

Static, fully client-side any-to-any file converter (Vite 8, TypeScript 7, React 19), deployed to GitHub
Pages. All conversion runs in Web Workers inside the user's browser. **Privacy is the product:** no
backend, no network access except the site's own files, no persistence of user data.

## Commands

- `npm run dev`: Vite dev server. The engine harness is at `/harness.html` (dev only).
- `npm test`: Vitest unit tests in Node (`src/**/*.test.ts`).
- `npm run test:e2e`: Playwright against real engines in Chromium/Firefox/WebKit (reuses a dev server on :5179).
- `npm run typecheck`, `npm run build`.

## Architecture

| Path | Role |
|---|---|
| `src/core/formats.ts` | Format catalog (ids, families, extensions, MIME types) |
| `src/core/types.ts` | Engine contract, stage/facts/preview types, worker protocol |
| `src/core/graph.ts`, `registry.ts` | Route planner over all engines' edges (auto-discovered) |
| `src/core/worker.ts` | Engine host: network jail, one hop per worker |
| `src/core/runner.ts` | Main-thread runner: fresh worker per hop, fallback on `EngineUnsupportedError` |
| `src/core/assets.ts` | Same-origin asset fetch with byte-accurate progress (`asset-sizes.json`) |
| `src/core/sniff.ts`, `src/core/structure/` | Format sniffing and real byte-layout parsers for the visualiser |
| `src/engines/<id>/` | `edges.ts` (pure data) + `engine.ts` (worker side) |
| `src/viz/` | Loading-screen model (reducer of runner events) and canvas scene |
| `src/App.tsx` | UI shell |

## Rules

- Engines get wasm and fonts through Vite `?url` imports and `ctx.fetchAsset`, never from a CDN.
- Report stages exactly as declared in `edges.ts`. Call `ctx.progress` only with measured values.
- Never add analytics, remote fonts, third-party scripts or any storage of user files.
- New dependencies: check the latest version, license (must be GPL-3.0-compatible) and docs first.
