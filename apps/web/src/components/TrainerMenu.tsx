import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n.js";
import type { TrainerSubTab } from "../pages/TrainerWorkspace.js";

interface TrainerMenuProps {
  active: boolean;
  activeSubTab: TrainerSubTab;
  bridgeConnected: boolean;
  onSelect: (subTab: TrainerSubTab) => void;
}

export function TrainerMenu({
  active,
  activeSubTab,
  bridgeConnected,
  onSelect,
}: TrainerMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const items: readonly { key: TrainerSubTab; label: string; desc: string }[] = [
    { key: "ride", label: t("nav.live_ride"), desc: t("nav.live_ride_desc") },
    { key: "routes", label: t("nav.routes"), desc: t("nav.routes_desc") },
    { key: "bridge", label: t("nav.bridge"), desc: t("nav.bridge_desc") },
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        title={t("nav.trainer_app")}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
          active
            ? "border-orange-500 bg-orange-500 text-zinc-950"
            : "border-orange-500/40 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${
            active
              ? bridgeConnected
                ? "bg-emerald-400 ring-1 ring-white/80"
                : "bg-zinc-200 opacity-75"
              : bridgeConnected
                ? "bg-emerald-400"
                : "bg-zinc-400"
          }`}
        />
        <span>{t("nav.trainer_short")}</span>
        <span
          aria-hidden="true"
          className={`text-[10px] transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("nav.trainer_app")}
          className="absolute right-0 z-40 mt-2 w-72 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-zinc-800 px-2.5 pb-2 pt-1">
            <span className="text-[11px] font-bold tracking-tight text-white">
              {t("nav.trainer_app")}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                bridgeConnected
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  bridgeConnected ? "bg-emerald-400" : "bg-zinc-500"
                }`}
              />
              {bridgeConnected ? t("nav.bridge_connected") : t("nav.bridge_offline")}
            </span>
          </div>

          <div className="space-y-0.5">
            {items.map((item) => {
              const isCurrent = active && activeSubTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(item.key);
                    setOpen(false);
                  }}
                  className={`flex w-full flex-col items-start rounded-xl px-2.5 py-2 text-left transition ${
                    isCurrent
                      ? "bg-orange-500/15 text-orange-300"
                      : "text-zinc-200 hover:bg-zinc-800"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className={`text-xs font-semibold ${isCurrent ? "text-orange-300" : "text-white"}`}>
                      {item.label}
                    </span>
                    {isCurrent && (
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-400" aria-hidden="true" />
                    )}
                  </div>
                  <span className="mt-0.5 text-[11px] font-normal text-zinc-400">{item.desc}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
