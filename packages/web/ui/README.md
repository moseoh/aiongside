# Web View UI

React + Vite single-page app served by `aiongside view web`.

## Build

`bun run build:ui` (from `src/`) runs `vite build` and embeds the output into
`packages/web/src/assets.generated.ts`. The CLI bundle includes that module, so
the published package stays a single `bin.js`. `bun run build` runs it first.

## Develop

1. Start a server on a fixed port: `aiongside --root <workspace> view web --port 8787`.
2. Run `bun run dev:ui`. Vite serves the app with hot reload and proxies `/api`
   to `http://127.0.0.1:8787`. Set `AIONGSIDE_WEB_URL` to point elsewhere.

The dev server is for development only. The shipped server never needs it.

## Layout

- `src/lib`: API client, settings store (localStorage), i18n, works/knowledge caches, link resolution.
- `src/components`: layout, header, trees, document view, Markdown renderer, shadcn/ui copies under `ui/`.
- `src/pages`: Work list/board, Work detail, Knowledge.
