#!/usr/bin/env node
/**
 * Reads automation/tasks.json, validates the dependency DAG (no unknown refs, no cycles),
 * and prints either:
 *   - default: next unblocked task (human-readable)
 *   - --json:  next unblocked task as JSON (or {"done": true} if all tasks complete)
 *   - --all:   full milestone/task status table
 *   - --validate: validate DAG only and exit 0/1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tasksPath = path.join(repoRoot, "automation", "tasks.json");

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);

function loadTasks() {
  const raw = fs.readFileSync(tasksPath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.tasks)) {
    throw new Error("automation/tasks.json must contain a 'tasks' array");
  }
  return data;
}

function validateDag(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (!task.id || typeof task.id !== "string") {
      throw new Error("Every task must have a string 'id'");
    }
    if (byId.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    if (!VALID_STATUSES.has(task.status)) {
      throw new Error(`Invalid status '${task.status}' on task ${task.id}`);
    }
    if (!Array.isArray(task.depends_on)) {
      throw new Error(`Task ${task.id} missing array 'depends_on'`);
    }
    if (!task.verify_cmd || typeof task.verify_cmd !== "string") {
      throw new Error(`Task ${task.id} missing string 'verify_cmd'`);
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`Task ${task.id} depends on unknown task '${dep}'`);
      }
    }
  }

  // Cycle detection via 3-color DFS
  const color = new Map(); // 0=unvisited, 1=visiting, 2=visited
  function dfs(id, stack) {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      throw new Error(`Dependency cycle detected: ${[...stack, id].join(" -> ")}`);
    }
    if (state === 2) return;
    color.set(id, 1);
    const task = byId.get(id);
    for (const dep of task.depends_on) {
      dfs(dep, [...stack, id]);
    }
    color.set(id, 2);
  }

  for (const task of tasks) {
    dfs(task.id, []);
  }

  return byId;
}

function findNextTask(tasks, byId) {
  // Resume an in_progress task first if all its deps are done
  const candidates = [
    ...tasks.filter((t) => t.status === "in_progress"),
    ...tasks.filter((t) => t.status === "pending"),
  ];
  for (const task of candidates) {
    const ready = task.depends_on.every((depId) => byId.get(depId)?.status === "done");
    if (ready) return task;
  }
  return null;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const data = loadTasks();
  const byId = validateDag(data.tasks);

  if (args.has("--validate")) {
    const doneCount = data.tasks.filter((t) => t.status === "done").length;
    console.log(`DAG valid: ${data.tasks.length} tasks (${doneCount} done).`);
    return;
  }

  if (args.has("--all")) {
    const icon = { done: "✓", in_progress: "▶", pending: "○", blocked: "✕" };
    for (const t of data.tasks) {
      const ready =
        t.status === "pending" && t.depends_on.every((d) => byId.get(d)?.status === "done");
      const tag = ready ? " [READY]" : "";
      console.log(
        `${icon[t.status]} ${t.id.padEnd(6)} ${t.status.padEnd(11)} ${t.title}${tag}`
      );
    }
    return;
  }

  const next = findNextTask(data.tasks, byId);
  const allDone = data.tasks.every((t) => t.status === "done");
  const blocked = data.tasks.filter((t) => t.status === "blocked");

  if (args.has("--json")) {
    if (!next) {
      console.log(
        JSON.stringify(
          {
            done: allDone,
            blocked_ids: blocked.map((b) => b.id),
            task: null,
          },
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify({ done: false, task: next }, null, 2));
    }
    return;
  }

  if (!next) {
    if (allDone) {
      console.log("All tasks in automation/tasks.json are done!");
    } else {
      console.log("No unblocked tasks available.");
      if (blocked.length > 0) {
        console.log("Blocked tasks:", blocked.map((b) => `${b.id} (${b.notes ?? "no note"})`).join(", "));
      }
      process.exitCode = 2;
    }
    return;
  }

  console.log(`Next task: ${next.id} [${next.milestone}] (${next.status})`);
  console.log(`Title:     ${next.title}`);
  console.log(`Depends:   ${next.depends_on.length ? next.depends_on.join(", ") : "(none)"}`);
  console.log(`Verify:    ${next.verify_cmd}`);
  console.log("Acceptance criteria:");
  for (const c of next.acceptance_criteria ?? []) {
    console.log(`  - ${c}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
