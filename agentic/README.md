# Agentic Modularized (Minimal Change)

This refactors your monolithic CLI into:
- **adapters/openai/**: URLs, request building, tool injection, response parsing, and prompts/tools.
- **core/**: small shared helpers (types, truncation/log formatting, path sandboxing).
- **cli/main.ts**: thin wrapper that keeps your recursion & behavior intact.

## Run
```bash
cd agentic
pnpm i   # or npm i / yarn
pnpm dev # or npm run dev
# requires OPENAI_API_KEY (and optional OPENAI_BASE_URL)
```
