# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Battleground: type two fighters, an AI "judge" names who'd win. Plain HTML/CSS/vanilla JS frontend plus a single Vercel serverless function that calls an LLM API (Gemini by default, Claude optional). No framework, no bundler, no test suite or linter configured.

`project-brief.md` is the spec and `project-build.md` is the staged build plan (Stages 0-7, then future work). Read the relevant stage before building; the plan marks which things are intentionally deferred (image art, rate limiting, BattleDex sync).

## Commands

- Run locally: `vercel dev --yes` (serves the static files and `api/` on http://localhost:3000). Needs `vercel login` once and `GOOGLE_API_KEY_2` in `.env.local` or the shell environment (or `ANTHROPIC_API_KEY` with `VERDICT_PROVIDER=claude`).
- Do **not** add a `dev` script to `package.json` that runs `vercel dev`: it makes `vercel dev` recursively invoke itself and fail.
- Syntax-check without a server: `node --check app.js` and `node --check api/verdict.js`.
- Exercise the endpoint: `curl -X POST http://localhost:3000/api/verdict -H 'content-type: application/json' -d '{"fighterA":"T-Rex","fighterB":"10 cows"}'`

Env var note: the Gemini key is read from `GOOGLE_API_KEY_2` (the original `GOOGLE_API_KEY` stopped working). A Windows user env var set after a terminal/session started is not visible to it; open a new terminal (or pass the value explicitly when launching `vercel dev`) before debugging "Server is not configured".

Windows note: `vercel dev` fails with `EPERM ... symlink` unless Developer Mode is enabled (Settings > System > For developers) or the terminal runs as Administrator.

## Architecture

Two files carry almost all the logic, and they share an implicit contract:

- **`api/verdict.js`** (CommonJS, Vercel Node function): `POST /api/verdict` takes `{ fighterA, fighterB }` and returns `{ fighterA, fighterB, winner, reasoning }`. It sanitizes and validates the names, calls the LLM with a JSON-schema structured output, and maps the result back to a real name. Provider is chosen by `VERDICT_PROVIDER` (`gemini` default, or `claude`): Gemini goes through plain `fetch` to the REST `generateContent` endpoint, Claude through `@anthropic-ai/sdk`. Each provider function returns raw JSON text, and one shared `parseVerdict` validates it.
  - The model returns `winner: "A" | "B"`, never a name; the server maps it to the input name, so the winner is always one of the two fighters and a tie can't be represented.
  - `SYSTEM_PROMPT` is the "Battleground Judge" with the Judge's Rules: always exactly one winner (no ties/refusals), the winner must be the realistic one (humor only in the explanation), 2-3 playful sentences. The schema has a hidden `analysis` field generated before `winner` (`propertyOrdering` for Gemini) so the small model reasons before picking; the handler never returns it. Tune realism by testing repeated runs of lopsided matchups (e.g. "10 boys" vs "2 girls"), since output varies. The 2-3 sentence rule is prompt-only, not enforced in code. There is deliberately no `declined` flag.
  - Fighter names go to the model as a JSON string inside the user message, and the prompt tells the model they are data, not instructions (prompt-injection guard).
  - Error shape is always `{ error: "<user-safe message>" }`: 400 bad input, 422 API safety refusal (`stop_reason: "refusal"`), 502 model/upstream failure, 500 other. Upstream details are logged server-side only. Malformed model output is retried once before a 502.
  - Model defaults to `gemini-flash-lite-latest` (Gemini) or `claude-haiku-5-5` (Claude), overridable with `VERDICT_MODEL`. Gemini model availability is volatile: `gemini-2.5-flash` returned 404 ("no longer available to new users") and the larger Flash models returned 503/timeouts under load, so list models with the key (`GET /v1beta/models`) before changing the default. `MAX_TOKENS` is 3000 because thinking tokens count toward it.
- **`app.js`** (single IIFE, no modules): drives the UI. `index.html` holds three stacked screens (`#screen-input`, `#screen-loading`, `#screen-result`); `showScreen(name)` shows exactly one by toggling the `hidden` attribute and `data-screen` on `#app`. The result screen is `position: fixed` and covers the viewport.
  - Fight flow: validate -> loading screen -> `fetch('/api/verdict')` (30s abort timeout, minimum 1.5s on the loading screen) -> result screen. Every failure returns to the input screen and shows a native `<dialog id="error-dialog">` with the reason.
  - Name validation rules (trim, strip control chars, 1-50 chars, not equal case-insensitively) are duplicated in `app.js` and `api/verdict.js`. Change both together.
  - All user/model text is rendered via `textContent`, never `innerHTML`. The BattleDex list follows this too.

## Current state (see `project-build.md` for detail)

Stages 0-3 are built. Code for Stage 4 and Stage 5 is also in place, but only syntax-checked (`node --check app.js`) and not exercised in a browser by me; treat both as untested until run.

- Stage 4 (found already present in `app.js`/`style.css`, not re-verified): loading-screen clash animation, result reveal, typewriter reasoning with a Skip button, `prefers-reduced-motion` fallback.
- Stage 5 (BattleDex, written this session, untested): "Save to BattleDex" saves `{ id, fighterA, fighterB, winner, reasoning, date }` to localStorage key `battleground.battledex.v1` (per browser and origin, newest first). The storage helper (`store.load/save/remove/clear`) is inside `app.js`, with try/catch, quota handling and an in-memory fallback when localStorage is blocked. The list has an empty state, per-entry Delete, and an inline "Clear all" confirm. Not yet checked: persistence across reload, quota/blocked-storage paths, mobile layout.
- Stages 6-7 are not started. Real Claude calls were not verified end-to-end (`.env.local` had no key when last checked).

## Gotchas

- `package.json` has no `scripts` and no build step; the Anthropic SDK is the only dependency.
