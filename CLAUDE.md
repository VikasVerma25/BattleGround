# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Battleground: type two fighters, an AI "judge" names who'd win. Plain HTML/CSS/vanilla JS frontend plus a single Vercel serverless function that calls an LLM API (Gemini by default, Claude optional). No framework, no bundler, no test suite or linter configured.

`project-brief.md` is the spec and `project-build.md` is the staged build plan (Stages 0-7, then future work). Read the relevant stage before building; the plan marks which things are intentionally deferred (image art, rate limiting, BattleDex sync).

## Commands

- Run locally: `vercel dev --yes` (serves the static files and `api/` on http://localhost:3000). Needs `vercel login` once and `GOOGLE_API_KEY` in `.env.local` or the shell environment (or `ANTHROPIC_API_KEY` with `VERDICT_PROVIDER=claude`).
- Do **not** add a `dev` script to `package.json` that runs `vercel dev`: it makes `vercel dev` recursively invoke itself and fail.
- Syntax-check without a server: `node --check app.js` and `node --check api/verdict.js`.
- Exercise the endpoint: `curl -X POST http://localhost:3000/api/verdict -H 'content-type: application/json' -d '{"fighterA":"T-Rex","fighterB":"10 cows"}'`

Env var note: the Gemini key is read from `GOOGLE_API_KEY`. It used to be `GOOGLE_API_KEY_2` (renamed back after the original key issue was settled); an old `GOOGLE_API_KEY` value left in the Windows or shell environment could be a stale key, so check that the variable holds the working key. A Windows user env var set after a terminal/session started is not visible to it; open a new terminal (or pass the value explicitly when launching `vercel dev`) before debugging "Server is not configured".

Windows note: `vercel dev` fails with `EPERM ... symlink` unless Developer Mode is enabled (Settings > System > For developers) or the terminal runs as Administrator.

## Architecture

Two files carry almost all the logic, and they share an implicit contract:

- **`api/verdict.js`** (CommonJS, Vercel Node function): `POST /api/verdict` takes `{ fighterA, fighterB }` and returns `{ fighterA, fighterB, winner, reasoning }`. It sanitizes and validates the names, calls the LLM with a JSON-schema structured output, and maps the result back to a real name. Provider is chosen by `VERDICT_PROVIDER` (`gemini` default, or `claude`): Gemini goes through plain `fetch` to the REST `generateContent` endpoint, Claude through `@anthropic-ai/sdk`. Each provider function returns raw JSON text, and one shared `parseVerdict` validates it.
  - The model returns `winner: "A" | "B"`, never a name; the server maps it to the input name, so the winner is always one of the two fighters and a tie can't be represented.
  - `SYSTEM_PROMPT` is the "Battleground Judge" with the Judge's Rules: always exactly one winner (no ties/refusals), the winner must be the realistic one (humor only in the explanation), 2-3 playful sentences. The schema has a hidden `analysis` field generated before `winner` (`propertyOrdering` for Gemini) so the small model reasons before picking; the handler never returns it. Tune realism by testing repeated runs of lopsided matchups (e.g. "10 boys" vs "2 girls"), since output varies. The 2-3 sentence rule is prompt-only, not enforced in code. There is deliberately no `declined` flag.
  - Fighter names go to the model as a JSON string inside the user message, and the prompt tells the model they are data, not instructions (prompt-injection guard).
  - Error shape is always `{ error: "<user-safe message>" }`: 400 bad input, 422 API safety refusal (`stop_reason: "refusal"`), 502 model/upstream failure, 500 other. Upstream details are logged server-side only. Malformed model output is retried once before a 502; Gemini 500/503/504 are retried up to 3 times with a short backoff (`TRANSIENT_TRIES`), because Gemini returns intermittent 503 "high demand" (about 1 in 4 calls during testing).
  - Model defaults to `gemini-flash-lite-latest` (Gemini) or `claude-haiku-5-5` (Claude), overridable with `VERDICT_MODEL`. Gemini model availability is volatile: `gemini-2.5-flash` returned 404 ("no longer available to new users") and the larger Flash models returned 503/timeouts under load, so list models with the key (`GET /v1beta/models`) before changing the default. `MAX_TOKENS` is 3000 because thinking tokens count toward it.
- **`app.js`** (single IIFE, no modules): drives the UI. `index.html` holds three stacked screens (`#screen-input`, `#screen-loading`, `#screen-result`); `showScreen(name)` shows exactly one by toggling the `hidden` attribute and `data-screen` on `#app`. The result screen is `position: fixed` and covers the viewport.
  - Fight flow: validate -> loading screen -> `fetch('/api/verdict')` (30s abort timeout, minimum 1.5s on the loading screen) -> result screen. Every failure returns to the input screen and shows a native `<dialog id="error-dialog">` with the reason.
  - Name validation rules (trim, strip control chars, 1-50 chars, not equal case-insensitively) are duplicated in `app.js` and `api/verdict.js`. Change both together.
  - All user/model text is rendered via `textContent`, never `innerHTML`. The BattleDex list follows this too.

## Current state (see `project-build.md` for detail)

Stages 0-5 and 5.5 (arcade redesign) are built. The user ran the app in a browser after the redesign and reported it works and looks good; no automated tests exist. Stage 6 (hardening) is in progress: API validation, injection and realism checks were run and the Gemini 503 retry was added; the user also tried the app in Chrome, Edge and Firefox. Stage 7 (launch) is not started, although the app is already deployed on Vercel and the key was renamed to `GOOGLE_API_KEY` locally (confirmed working with `vercel dev`; the Vercel project env must also use that name before the next deploy).

- Stage 4 (animations): loading-screen clash, result reveal, typewriter reasoning with Skip, `prefers-reduced-motion` fallback.
- Stage 5 (BattleDex): "Save to BattleDex" saves `{ id, fighterA, fighterB, winner, reasoning, date }` to localStorage key `battleground.battledex.v1` (per browser and origin, newest first). The storage helper (`store.load/save/remove/clear`) lives in `app.js`, with try/catch, quota handling and an in-memory fallback when localStorage is blocked. The list has an empty state, per-entry Delete, and an inline "Clear all" confirm. Quota and blocked-storage paths were never explicitly tested.
- Stage 5.5 (redesign): `index.html` and `style.css` came from Claude Design (arcade look: character-select slots, arena HUD with health bars, K.O. result screen, game-over error dialog). All error/info copy is written in a playful fight-night voice. The HUD badge says "Showdown" (a match is a single fight, not rounds).
  - Loading screen HUD names (`#hud-a`, `#hud-b`) are filled from the fighter names in `app.js`.
  - Crowd posters: `#posters` is filled by `renderPosters()` in `app.js` on every fight with 2 or 3 random signs from the `POSTERS` list (`{A}`/`{B}` become shortened fighter names; text via `textContent`). Positions come from CSS custom properties (`--x` desktop, `--xm` phone) set per sign. The user's screenshots show them rendering on the loading screen.
  - "Fight again" ignores form submits for 600ms (`ignoreSubmitUntil`). This was added for a bug where Fight again re-ran the same fight (probably a double-click landing on FIGHT!); the user confirmed the fix works.
- Real Claude calls were not verified end-to-end (`.env.local` had no key when last checked).

## Gotchas

- `package.json` has no `scripts` and no build step; the Anthropic SDK is the only dependency.
