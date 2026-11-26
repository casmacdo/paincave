# PainCave Autonomous Iteration Prompt

You are executing ONE focused iteration of the PainCave autonomous build loop.

## Mandatory Startup Sequence
1. Read `AGENTS.md` and the current target task JSON provided below.
2. Read the relevant specification sections in:
   - `docs/ARCHITECTURE.md`
   - `docs/DATA_MODEL.md`
   - `docs/MCP_SPEC.md`
   - `docs/PLAN.md`
3. Read the last 60 lines of `automation/progress.md` to inherit context from prior iterations.
4. If a previous attempt failure log is attached, diagnose the root cause FIRST before writing code.

## Execution Rules
1. Work ONLY on the single assigned task ID (`TASK_ID`). Do not jump ahead to unrelated milestones.
2. Mark the task `in_progress` before editing:
   ```bash
   node scripts/update-task.mjs "$TASK_ID" in_progress --note "Starting iteration"
   ```
3. Implement clean, minimal, well-tested code matching every item in `acceptance_criteria` and all invariants in `AGENTS.md`.
4. Never weaken assertions, skip tests, suppress clippy/TS errors with `any`/`#[allow(...)]` hacks, or bypass verification gates.
5. Run BOTH verification commands before declaring completion:
   ```bash
   ./scripts/verify-task.sh "$TASK_ID"
   ./scripts/verify.sh
   ```
6. Only when BOTH pass with exit code 0, mark the task `done`:
   ```bash
   node scripts/update-task.mjs "$TASK_ID" done --note "<concise summary of files changed and tests verified>"
   ```
7. If you hit an external blocker you genuinely cannot resolve locally (e.g., missing live Cloudflare credentials or physical KICKR hardware), mark the task `blocked` with exact details of what is needed:
   ```bash
   node scripts/update-task.mjs "$TASK_ID" blocked --note "<exact blocker and required user action>"
   ```

## Output Format at End of Iteration
End your response with a concise structured summary:
- `TASK_ID`: `<id>`
- `STATUS`: `done` | `retry_needed` | `blocked`
- `FILES_CHANGED`: list of paths
- `VERIFICATION`: commands run and pass/fail results
- `NEXT_NOTES`: any subtle context the next iteration needs
