#!/usr/bin/env node
/**
 * Atomically updates a task's status in automation/tasks.json and logs to automation/progress.md.
 * Usage:
 *   node scripts/update-task.mjs <TASK_ID> <pending|in_progress|done|blocked> [--note "..."] [--skip-verify]
 *
 * Guardrail: transitioning to 'done' executes the task's verify_cmd first and refuses
 * to mark 'done' if verification fails (unless --skip-verify is explicitly passed).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tasksPath = path.join(repoRoot, "automation", "tasks.json");
const progressPath = path.join(repoRoot, "automation", "progress.md");

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);

function parseArgs(argv) {
  const [taskId, newStatus, ...rest] = argv;
  if (!taskId || !newStatus) {
    throw new Error(
      "Usage: node scripts/update-task.mjs <TASK_ID> <pending|in_progress|done|blocked> [--note \"...\"] [--skip-verify]"
    );
  }
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status '${newStatus}'. Must be one of: ${[...VALID_STATUSES].join(", ")}`);
  }
  let note = "";
  let skipVerify = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--note" && i + 1 < rest.length) {
      note = rest[++i];
    } else if (rest[i] === "--skip-verify") {
      skipVerify = true;
    } else {
      throw new Error(`Unknown argument: ${rest[i]}`);
    }
  }
  return { taskId, newStatus, note, skipVerify };
}

function main() {
  const { taskId, newStatus, note, skipVerify } = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Enforce dependencies when starting or completing a task
  if (newStatus === "in_progress" || newStatus === "done") {
    const unmet = task.depends_on.filter((depId) => {
      const dep = data.tasks.find((t) => t.id === depId);
      return !dep || dep.status !== "done";
    });
    if (unmet.length > 0) {
      throw new Error(`Cannot set ${taskId} to '${newStatus}'; unmet dependencies: ${unmet.join(", ")}`);
    }
  }

  // Enforce verify_cmd before marking done
  if (newStatus === "done" && !skipVerify) {
    console.log(`Running verify_cmd for ${taskId}: ${task.verify_cmd}`);
    const res = spawnSync("bash", ["-euo", "pipefail", "-c", task.verify_cmd], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      throw new Error(`Verification failed for ${taskId} (exit ${res.status ?? 1}). Task NOT marked done.`);
    }
  }

  const prevStatus = task.status;
  task.status = newStatus;
  if (note) {
    task.notes = note;
  }
  task.updated_at = new Date().toISOString();

  // Atomic write via temp file + rename
  const tmpPath = `${tasksPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, tasksPath);

  // Append structured progress entry on meaningful transitions
  if (newStatus === "done" || newStatus === "blocked") {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const entry = `\n## ${stamp} UTC — ${taskId} (\`${prevStatus}\` -> \`${newStatus}\`)\n- ${note || task.title}\n`;
    fs.appendFileSync(progressPath, entry, "utf8");
  }

  console.log(`Updated ${taskId}: ${prevStatus} -> ${newStatus}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
