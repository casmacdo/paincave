import { useEffect, useMemo, useState } from "react";
import {
  WORKOUT_CATEGORIES,
  WorkoutSpecSchema,
  flattenWorkout,
  type FlattenedStep,
  type WorkoutCategory,
  type WorkoutSpec,
} from "@paincave/shared";
import { api, type WorkoutRecord } from "../lib/api.js";
import { WorkoutProfileSvg } from "../components/LiveWorkoutChart.js";

interface WorkoutsPageProps {
  ftpWatts: number;
  onLoadWorkout: (workoutId: string) => Promise<void>;
}

type DurationFilter = "all" | "short" | "medium" | "long";
type SortOption = "newest" | "duration_asc" | "duration_desc" | "tss_desc" | "if_desc" | "name_asc";
type ViewMode = "grouped" | "flat";

interface CategoryMeta {
  label: string;
  subtitle: string;
  dotClass: string;
  badgeClass: string;
  activePillClass: string;
}

const WORKOUT_CATEGORY_META: Record<WorkoutCategory, CategoryMeta> = {
  recovery: {
    label: "Recovery",
    subtitle: "Z1 · Active recovery & spin",
    dotClass: "bg-zinc-400",
    badgeClass: "border-zinc-700 bg-zinc-800/80 text-zinc-300",
    activePillClass: "border-zinc-400 bg-zinc-800 text-white",
  },
  endurance: {
    label: "Endurance",
    subtitle: "Z2 · Aerobic base",
    dotClass: "bg-blue-400",
    badgeClass: "border-blue-500/30 bg-blue-500/15 text-blue-300",
    activePillClass: "border-blue-400 bg-blue-500/20 text-blue-100",
  },
  tempo: {
    label: "Tempo",
    subtitle: "Z3 · Sustained aerobic pace",
    dotClass: "bg-emerald-400",
    badgeClass: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
    activePillClass: "border-emerald-400 bg-emerald-500/20 text-emerald-100",
  },
  sweet_spot: {
    label: "Sweet Spot",
    subtitle: "88–94% FTP · High aerobic load",
    dotClass: "bg-lime-400",
    badgeClass: "border-lime-500/30 bg-lime-500/15 text-lime-300",
    activePillClass: "border-lime-400 bg-lime-500/20 text-lime-100",
  },
  threshold: {
    label: "Threshold",
    subtitle: "Z4 · Lactate threshold",
    dotClass: "bg-yellow-400",
    badgeClass: "border-yellow-500/30 bg-yellow-500/15 text-yellow-200",
    activePillClass: "border-yellow-400 bg-yellow-500/20 text-yellow-100",
  },
  vo2max: {
    label: "VO2 Max",
    subtitle: "Z5 · Maximal aerobic intervals",
    dotClass: "bg-orange-400",
    badgeClass: "border-orange-500/30 bg-orange-500/15 text-orange-300",
    activePillClass: "border-orange-400 bg-orange-500/20 text-orange-100",
  },
  anaerobic: {
    label: "Anaerobic",
    subtitle: "Z6 · Short high-power repeats",
    dotClass: "bg-rose-400",
    badgeClass: "border-rose-500/30 bg-rose-500/15 text-rose-300",
    activePillClass: "border-rose-400 bg-rose-500/20 text-rose-100",
  },
  sprint: {
    label: "Sprint",
    subtitle: "Z7 · Neuromuscular bursts",
    dotClass: "bg-red-500",
    badgeClass: "border-red-500/30 bg-red-500/15 text-red-300",
    activePillClass: "border-red-400 bg-red-500/20 text-red-100",
  },
  test: {
    label: "Tests",
    subtitle: "Benchmarks & ramp assessments",
    dotClass: "bg-violet-400",
    badgeClass: "border-violet-500/30 bg-violet-500/15 text-violet-300",
    activePillClass: "border-violet-400 bg-violet-500/20 text-violet-100",
  },
  custom: {
    label: "Custom",
    subtitle: "Structured & mixed sessions",
    dotClass: "bg-zinc-500",
    badgeClass: "border-zinc-700 bg-zinc-800/80 text-zinc-300",
    activePillClass: "border-zinc-400 bg-zinc-800 text-white",
  },
};

const DURATION_OPTIONS: { id: DurationFilter; label: string }[] = [
  { id: "all", label: "Any length" },
  { id: "short", label: "≤ 45m" },
  { id: "medium", label: "45–75m" },
  { id: "long", label: "75m+" },
];

function isWorkoutCategory(value: string): value is WorkoutCategory {
  return (WORKOUT_CATEGORIES as readonly string[]).includes(value);
}

function getCategoryMeta(category: string): CategoryMeta {
  if (isWorkoutCategory(category)) {
    return WORKOUT_CATEGORY_META[category];
  }
  const readable = category
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    label: readable || "Custom",
    subtitle: "Structured sessions",
    dotClass: "bg-zinc-500",
    badgeClass: "border-zinc-700 bg-zinc-800/80 text-zinc-300",
    activePillClass: "border-zinc-400 bg-zinc-800 text-white",
  };
}

function categoryRank(category: string): number {
  const idx = (WORKOUT_CATEGORIES as readonly string[]).indexOf(category);
  return idx === -1 ? WORKOUT_CATEGORIES.length : idx;
}

function formatDurationLabel(durationS: number): string {
  const totalMin = Math.round(durationS / 60);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${totalMin}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatSourceLabel(createdBy: string): string {
  if (createdBy === "llm") return "MCP";
  if (createdBy === "import") return "Import";
  return "Manual";
}

function matchesDuration(durationS: number, filter: DurationFilter): boolean {
  const mins = durationS / 60;
  if (filter === "short") return mins <= 45;
  if (filter === "medium") return mins > 45 && mins <= 75;
  if (filter === "long") return mins > 75;
  return true;
}

interface ParsedWorkoutItem {
  record: WorkoutRecord;
  spec: WorkoutSpec | null;
  steps: FlattenedStep[];
  categoryMeta: CategoryMeta;
}

export function WorkoutsPage({ ftpWatts, onLoadWorkout }: WorkoutsPageProps) {
  const [workouts, setWorkouts] = useState<WorkoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingWorkoutId, setLoadingWorkoutId] = useState<string | null>(null);
  const [movingCategoryId, setMovingCategoryId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getWorkouts()
      .then((res) => {
        if (active) setWorkouts(res.workouts);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load workouts");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const parsedItems = useMemo<ParsedWorkoutItem[]>(() => {
    return workouts.map((record) => {
      let spec: WorkoutSpec | null = null;
      let steps: FlattenedStep[] = [];
      try {
        spec = WorkoutSpecSchema.parse(JSON.parse(record.spec_json));
        steps = flattenWorkout(spec, ftpWatts);
      } catch {
        spec = null;
        steps = [];
      }
      return {
        record,
        spec,
        steps,
        categoryMeta: getCategoryMeta(record.category),
      };
    });
  }, [workouts, ftpWatts]);

  // Compute category counts from the full library in canonical physiological order
  const categorySummaries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of parsedItems) {
      counts.set(item.record.category, (counts.get(item.record.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => {
        const diff = categoryRank(a) - categoryRank(b);
        return diff !== 0 ? diff : a.localeCompare(b);
      })
      .map(([key, count]) => ({
        key,
        count,
        meta: getCategoryMeta(key),
      }));
  }, [parsedItems]);

  // Reset selected category if its last workout was deleted or moved away
  useEffect(() => {
    if (
      selectedCategory !== "all" &&
      !categorySummaries.some((summary) => summary.key === selectedCategory)
    ) {
      setSelectedCategory("all");
    }
  }, [selectedCategory, categorySummaries]);

  const filteredAndSorted = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = parsedItems.filter(({ record, categoryMeta }) => {
      if (selectedCategory !== "all" && record.category !== selectedCategory) {
        return false;
      }
      if (!matchesDuration(record.duration_s, durationFilter)) {
        return false;
      }
      if (!query) return true;
      return (
        record.name.toLowerCase().includes(query) ||
        record.description.toLowerCase().includes(query) ||
        record.category.toLowerCase().includes(query) ||
        categoryMeta.label.toLowerCase().includes(query)
      );
    });

    const sorted = [...matches];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "duration_asc":
          return a.record.duration_s - b.record.duration_s || a.record.name.localeCompare(b.record.name);
        case "duration_desc":
          return b.record.duration_s - a.record.duration_s || a.record.name.localeCompare(b.record.name);
        case "tss_desc":
          return (
            (b.record.predicted_tss ?? -1) - (a.record.predicted_tss ?? -1) ||
            a.record.name.localeCompare(b.record.name)
          );
        case "if_desc":
          return (
            (b.record.predicted_if ?? -1) - (a.record.predicted_if ?? -1) ||
            a.record.name.localeCompare(b.record.name)
          );
        case "name_asc":
          return a.record.name.localeCompare(b.record.name);
        case "newest":
        default:
          return b.record.updated_at.localeCompare(a.record.updated_at);
      }
    });
    return sorted;
  }, [parsedItems, search, selectedCategory, durationFilter, sortBy]);

  const groupedSections = useMemo(() => {
    const groups = new Map<string, ParsedWorkoutItem[]>();
    for (const item of filteredAndSorted) {
      const existing = groups.get(item.record.category);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.record.category, [item]);
      }
    }
    return [...groups.entries()]
      .sort(([a], [b]) => {
        const diff = categoryRank(a) - categoryRank(b);
        return diff !== 0 ? diff : a.localeCompare(b);
      })
      .map(([key, items]) => ({
        key,
        meta: getCategoryMeta(key),
        items,
      }));
  }, [filteredAndSorted]);

  const hasActiveFilters =
    search.trim().length > 0 || selectedCategory !== "all" || durationFilter !== "all";
  const showGroupedSections = viewMode === "grouped" && selectedCategory === "all";

  const resetFilters = () => {
    setSearch("");
    setSelectedCategory("all");
    setDurationFilter("all");
  };

  const toggleSection = (categoryKey: string) => {
    setCollapsedCategories((prev) => ({ ...prev, [categoryKey]: !prev[categoryKey] }));
  };

  const handleLoad = async (workoutId: string) => {
    setLoadingWorkoutId(workoutId);
    setError(null);
    try {
      await onLoadWorkout(workoutId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workout on trainer");
    } finally {
      setLoadingWorkoutId(null);
    }
  };

  const handleCategoryChange = async (item: ParsedWorkoutItem, nextCategory: WorkoutCategory) => {
    if (!item.spec || item.record.category === nextCategory) return;
    setMovingCategoryId(item.record.id);
    setError(null);
    try {
      const updatedSpec: WorkoutSpec = { ...item.spec, category: nextCategory };
      const res = await api.updateWorkout(item.record.id, updatedSpec);
      setWorkouts((current) =>
        current.map((w) => (w.id === item.record.id ? res.workout : w))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update workout category");
    } finally {
      setMovingCategoryId(null);
    }
  };

  const handleDelete = async (workout: WorkoutRecord) => {
    if (
      !window.confirm(
        `Delete "${workout.name}" from your workout library?\n\nCompleted ride history and planned sessions will be preserved.`
      )
    ) {
      return;
    }

    setDeletingId(workout.id);
    setError(null);
    try {
      await api.deleteWorkout(workout.id);
      setWorkouts((current) => current.filter((item) => item.id !== workout.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete workout");
    } finally {
      setDeletingId(null);
    }
  };

  const renderCard = (item: ParsedWorkoutItem) => {
    const { record: w, steps, categoryMeta } = item;
    const currentCategoryValue: WorkoutCategory = isWorkoutCategory(w.category)
      ? w.category
      : "custom";

    return (
      <article
        key={w.id}
        data-testid={`workout-card-${w.id}`}
        className="flex flex-col justify-between space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 transition hover:border-zinc-700"
      >
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${categoryMeta.badgeClass}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${categoryMeta.dotClass}`} />
                  {categoryMeta.label}
                </span>
                <span className="text-xs font-medium tabular-nums text-zinc-400">
                  {formatDurationLabel(w.duration_s)}
                </span>
              </div>
              <h3 className="mt-1.5 truncate text-base font-bold text-white" title={w.name}>
                {w.name}
              </h3>
              {w.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-400">{w.description}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleLoad(w.id)}
              disabled={loadingWorkoutId === w.id}
              className="shrink-0 rounded-lg bg-orange-500 px-3 py-2 text-xs font-bold text-zinc-950 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingWorkoutId === w.id ? "Loading..." : "Load on Trainer"}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-xl bg-zinc-950/70 px-3 py-2 text-xs">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">NP</span>
              <div className="font-semibold tabular-nums text-zinc-100">
                {w.predicted_np !== null ? `${w.predicted_np} W` : "--"}
              </div>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">IF</span>
              <div className="font-semibold tabular-nums text-zinc-100">
                {w.predicted_if !== null ? w.predicted_if.toFixed(2) : "--"}
              </div>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">TSS</span>
              <div className="font-semibold tabular-nums text-orange-300">
                {w.predicted_tss !== null ? Math.round(w.predicted_tss) : "--"}
              </div>
            </div>
          </div>

          {steps.length > 0 && <WorkoutProfileSvg steps={steps} ftpWatts={ftpWatts} height={68} />}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/80 pt-2.5 text-xs text-zinc-400">
          <div className="flex items-center gap-2">
            {item.spec && (
              <select
                aria-label={`Category for ${w.name}`}
                value={currentCategoryValue}
                disabled={movingCategoryId === w.id}
                onChange={(e) => {
                  const next = e.target.value;
                  if (isWorkoutCategory(next)) {
                    void handleCategoryChange(item, next);
                  }
                }}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
              >
                {WORKOUT_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {WORKOUT_CATEGORY_META[cat].label}
                  </option>
                ))}
              </select>
            )}
            <span className="text-[11px] text-zinc-500">{formatSourceLabel(w.created_by)}</span>
          </div>

          <div className="flex items-center gap-3">
            <a
              href={`/api/workouts/${encodeURIComponent(w.id)}/export.zwo`}
              className="text-zinc-400 underline-offset-2 hover:text-white hover:underline"
            >
              .zwo
            </a>
            <a
              href={`/api/workouts/${encodeURIComponent(w.id)}/export.erg`}
              className="text-zinc-400 underline-offset-2 hover:text-white hover:underline"
            >
              .erg
            </a>
            <button
              type="button"
              onClick={() => void handleDelete(w)}
              disabled={deletingId === w.id}
              className="text-rose-400/80 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deletingId === w.id ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="space-y-5">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Workout Library</h1>
          <p className="mt-0.5 text-sm text-zinc-400">
            {loading
              ? "Loading library..."
              : hasActiveFilters
                ? `Showing ${filteredAndSorted.length} of ${workouts.length} workouts`
                : `${workouts.length} ${workouts.length === 1 ? "workout" : "workouts"} across ${categorySummaries.length} ${categorySummaries.length === 1 ? "category" : "categories"}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, notes, category..."
            aria-label="Search workouts"
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white placeholder:text-zinc-500 focus:border-orange-500 focus:outline-none"
          />

          <select
            aria-label="Sort workouts"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 focus:border-orange-500 focus:outline-none"
          >
            <option value="newest">Sort: Newest</option>
            <option value="duration_asc">Sort: Shortest</option>
            <option value="duration_desc">Sort: Longest</option>
            <option value="tss_desc">Sort: Highest TSS</option>
            <option value="if_desc">Sort: Highest IF</option>
            <option value="name_asc">Sort: Name A–Z</option>
          </select>

          <div
            role="group"
            aria-label="Layout view"
            className="inline-flex rounded-lg border border-zinc-700 bg-zinc-900 p-0.5 text-xs"
          >
            <button
              type="button"
              onClick={() => setViewMode("grouped")}
              aria-pressed={viewMode === "grouped"}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                viewMode === "grouped"
                  ? "bg-orange-500 font-bold text-zinc-950"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Grouped
            </button>
            <button
              type="button"
              onClick={() => setViewMode("flat")}
              aria-pressed={viewMode === "flat"}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                viewMode === "flat"
                  ? "bg-orange-500 font-bold text-zinc-950"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              All Cards
            </button>
          </div>
        </div>
      </div>

      {/* Category & Duration Filter Strip */}
      {!loading && workouts.length > 0 && (
        <div className="space-y-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3.5">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by category">
            <button
              type="button"
              onClick={() => setSelectedCategory("all")}
              aria-pressed={selectedCategory === "all"}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                selectedCategory === "all"
                  ? "border-orange-500 bg-orange-500 text-zinc-950"
                  : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:text-white"
              }`}
            >
              All
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] tabular-nums ${
                  selectedCategory === "all" ? "bg-zinc-950/20 text-zinc-950" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {workouts.length}
              </span>
            </button>

            {categorySummaries.map(({ key, count, meta }) => {
              const active = selectedCategory === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedCategory(active ? "all" : key)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                    active
                      ? meta.activePillClass
                      : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:text-white"
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full ${meta.dotClass}`} />
                  {meta.label}
                  <span className="rounded-full bg-zinc-950/50 px-1.5 text-[10px] tabular-nums text-zinc-400">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 pt-2.5">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by duration">
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Duration
              </span>
              {DURATION_OPTIONS.map((opt) => {
                const active = durationFilter === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDurationFilter(opt.id)}
                    aria-pressed={active}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? "bg-zinc-200 font-semibold text-zinc-950"
                        : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs font-medium text-orange-400 hover:text-orange-300"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="h-48 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900/60"
            />
          ))}
        </div>
      ) : workouts.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm font-medium text-zinc-300">No saved workouts yet.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Create structured workouts via Remote MCP and they will appear here grouped by training category.
          </p>
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm font-medium text-zinc-300">No workouts match your current filters.</p>
          <button
            type="button"
            onClick={resetFilters}
            className="mt-3 rounded-lg bg-zinc-800 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700"
          >
            Reset filters
          </button>
        </div>
      ) : showGroupedSections ? (
        <div className="space-y-6">
          {groupedSections.map(({ key, meta, items }) => {
            const collapsed = Boolean(collapsedCategories[key]);
            return (
              <section key={key} data-testid={`workout-category-section-${key}`} className="space-y-3">
                <button
                  type="button"
                  onClick={() => toggleSection(key)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/70 px-4 py-2.5 text-left transition hover:border-zinc-700 hover:bg-zinc-900"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className={`h-2.5 w-2.5 rounded-full ${meta.dotClass}`} />
                    <h2 className="text-base font-bold text-white">{meta.label}</h2>
                    <span className="text-xs text-zinc-500">{meta.subtitle}</span>
                  </div>
                  <div className="flex items-center gap-2.5 text-xs text-zinc-400">
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 font-semibold tabular-nums text-zinc-200">
                      {items.length}
                    </span>
                    <span aria-hidden="true" className="text-zinc-500">
                      {collapsed ? "▸" : "▾"}
                    </span>
                  </div>
                </button>

                {!collapsed && (
                  <div className="grid gap-4 md:grid-cols-2">
                    {items.map((item) => renderCard(item))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredAndSorted.map((item) => renderCard(item))}
        </div>
      )}
    </div>
  );
}
