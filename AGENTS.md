# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `bun lint:mobile` must also pass.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Custom ACP / Pi workflow recovery

When working on Custom ACP workflow recovery, read `docs/providers/custom-acp.md` and the Pi smoke checklist at `../../agent/extensions/workflows/scripts/recovery-smoke.md`. Keep Stop mapped to standard ACP `session/cancel` for active turns, not `_pi/workflows/pause` or terminal abort. Do not reintroduce a composer-level workflow-control row/window; surface recoverable runs through Tasks/sidebar/provider controls and `/workflow-abort` fallback. Route Pi-specific Continue/Resume, Interrupt/Pause, and explicit terminal Abort through the provider workflow-control seam instead of assistant-text instructions. Recovery must come from Pi artifacts and ACP replay, not model-visible transcript injection.

Custom ACP lifecycle contract: Stop/Close is non-destructive and must preserve backing ACP history; thread Delete is the only path that may request destructive backing-session cleanup. Prefer the T3Code/pi-acp private extension (`deleteBackingSession: true` / `_pi/session/delete`, advertised via `_meta.piAcp.sessionDelete` and `sessionDeleteMethod`); treat legacy `session/delete` only as experimental backward compatibility, not stable ACP. Archive and ordinary Stop must not delete backing sessions.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
