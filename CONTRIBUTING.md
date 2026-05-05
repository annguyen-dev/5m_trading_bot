# Contributing

Coding conventions for this repo. Match existing style; deviate only when you have a reason.

---

## Logging — use the shared logger

```ts
import { log } from '@trading-bot/core/logger';
log('info', 'message', { key: 'value', count: 42 });
```

Always pino JSON, **never** `console.log`. Levels: `debug=20, info=30, warn=40, error=50`. Production filters at `info` by default.

When adding a new warn/error log, ensure it's **actionable** — if the reader can't fix anything, demote to debug.

## Error handling — fail loud unless we have a recovery path

- **Read paths** with DB / network errors → log warn + best-effort fallback (e.g., return cached value).
- **Write paths in critical flows** (order placement) → bubble up; let the caller retry or skip.
- **Background fire-and-forget DB writes** (heartbeat, telemetry) → `void promise.catch(err => log('warn', ...))`.

## Async + race conditions

JS event loop is cooperative — synchronous regions are atomic. **Set guard flags BEFORE any `await`** to prevent re-entry. We've been bitten multiple times by `phaseTMinus3` + `phaseT0` racing on the same window (commit `92a0eba`).

## TypeScript

- Strict mode on. No `any` unless truly justified — prefer `unknown` + narrowing.
- Discriminated unions for events (see `SignalBusEvent`). Exhaustive switches caught by tsc.
- Public types live in the consuming package — don't centralize types in `shared/` unless ≥3 packages need them.

## Commit messages

```
fix(scope): one-line summary in present tense

Optional 2-3 paragraph why-not-what body. Reference symptom + root cause +
fix mechanism. Cite verified evidence (log timestamps, prod queries, repro).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Scope: `core`, `workers`, `api`, `web`, `db`, `orders`, `scripts`, `chore`.

**Never amend committed history; always new commits.** If a pre-commit hook fails, fix the underlying issue and create a NEW commit — don't `--amend`.

## File comments — write the *why*

Top-of-file block should describe **responsibility + key invariants**. The code shows the *what*; comments capture the *why* (bug background, design tradeoff, gotcha). See `packages/core/src/PolymarketService.ts:81-88` (watchdog rationale) for the bar.

## Testing & verification

For a bug fix, before declaring done:
1. `pnpm typecheck` passes.
2. Cite the prod log evidence or DB query that proves the regression is gone.
3. After deploy: pull live logs and verify the new code path is running (`grep` deployed `dist/` for the new symbol).

## When you fix a class of bug — update the docs

- Add a row to **Known gotchas** in `CLAUDE.md` with commit hash + 1-line description.
- Add a grep pattern row to `.claude/skills/analyze-prod-logs/SKILL.md` so future log analysis catches recurrence.

This keeps institutional memory in the repo, not just in heads.
