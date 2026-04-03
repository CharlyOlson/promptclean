/**
 * PaywallBanner.tsx
 *
 * Free users  → pip gauge with `usage.limit` pips (green = used, grey = remaining)
 *               When all free runs are used: pips turn amber, shows day countdown to refill.
 * Pro users   → scorecard clock dial showing uses remaining (subscription).
 *
 * Listens for: window.dispatchEvent(new Event("promptclean:usage-refresh"))
 * after any /api/questions call so the counter ticks in real time.
 */

import { useEffect, useState, useCallback } from "react";
import { Zap, Lock, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface UsageData {
  runs: number;
  limit: number;
  isPro: boolean;
  /** null for Pro users (not applicable) */
  remaining: number | null;
  /** ISO timestamp of when the free allowance resets (optional — backend may provide) */
  resetAt?: string;
  /** For Pro: total monthly uses included in plan */
  monthlyLimit?: number;
  /** null for free users (not applicable) */
  monthlyRemaining: number | null;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchUsage(): Promise<UsageData> {
  const res = await fetch("/api/usage", { credentials: "include" });
  if (!res.ok) throw new Error("usage fetch failed");
  return res.json();
}

async function startCheckout(): Promise<void> {
  const res = await fetch("/api/create-checkout-session", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("checkout failed");
  const { url } = await res.json();
  if (typeof url !== "string" || !url) {
    throw new Error("checkout URL missing from response");
  }
  window.location.href = url;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysUntil(isoTimestamp: string): number {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then) || then <= now) return 0;
  return Math.ceil((then - now) / (1000 * 60 * 60 * 24));
}

/**
 * Estimate days until free runs reset.
 * Falls back to "7 days from now" if the backend doesn't send resetAt.
 * (Replace with real backend value when you add it.)
 */
function estimateResetDays(usage: UsageData): number {
  if (usage.resetAt) return daysUntil(usage.resetAt);
  // Fallback: show 7 days as placeholder
  return 7;
}

// ── Free Pip Gauge ─────────────────────────────────────────────────────────────
function FreePipGauge({ usage, onUpgrade, loading }: {
  usage: UsageData;
  onUpgrade: () => void;
  loading: boolean;
}) {
  const remaining = usage.remaining ?? 0;
  const exhausted = remaining === 0;
  const resetDays = exhausted ? estimateResetDays(usage) : null;
  const pips = Array.from({ length: usage.limit }, (_, i) => i);

  return (
    <div
      className={`rounded-lg border px-4 py-3 flex flex-wrap items-center gap-3 text-sm mb-4
        ${exhausted
          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
          : "border-border bg-card text-muted-foreground"
        }`}
      role="status"
      aria-label={exhausted
        ? `All free runs used. Resets in ${resetDays} days.`
        : `${remaining} of ${usage.limit} free runs remaining`
      }
    >
      {/* Pip row */}
      <div className="flex items-center gap-2" title={`${remaining} free runs left`}>
        {pips.map((i) => {
          const used = i < usage.runs;
          return (
            <span
              key={i}
              className={`relative flex items-center justify-center w-7 h-7 rounded-full border-2 transition-all duration-300
                ${used
                  ? exhausted
                    ? "border-amber-500 bg-amber-500/20"
                    : "border-emerald-500 bg-emerald-500/20"
                  : "border-muted bg-muted/20"
                }`}
            >
              {/* Inner dot */}
              <span
                className={`w-2.5 h-2.5 rounded-full transition-all duration-300
                  ${used
                    ? exhausted ? "bg-amber-400" : "bg-emerald-400"
                    : "bg-muted-foreground/20"
                  }`}
              />
              {/* Checkmark on used (non-exhausted) */}
              {used && !exhausted && (
                <svg className="absolute w-3 h-3 text-emerald-300" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {/* Lock on used-exhausted */}
              {used && exhausted && (
                <Lock className="absolute w-2.5 h-2.5 text-amber-400" />
              )}
            </span>
          );
        })}
      </div>

      {/* Status text */}
      {exhausted ? (
        <>
          <div className="flex flex-col min-w-0">
            <span className="font-medium text-amber-100 text-xs">Free runs used</span>
            {resetDays !== null && (
              <span className="text-amber-300/70 text-[10px] flex items-center gap-1 mt-0.5">
                <RefreshCw className="w-2.5 h-2.5" />
                Refills in {resetDays} {resetDays === 1 ? "day" : "days"}
              </span>
            )}
          </div>
          <button
            onClick={onUpgrade}
            disabled={loading}
            className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5
              bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs
              transition-colors duration-150 disabled:opacity-60 shrink-0"
          >
            <Zap className="w-3.5 h-3.5" />
            {loading ? "Redirecting…" : "Upgrade — $9/mo"}
          </button>
        </>
      ) : (
        <>
          <span className="text-xs">
            <span className="font-medium text-foreground">{remaining}</span>
            {" "}free {remaining === 1 ? "run" : "runs"} left
          </span>
          <button
            onClick={onUpgrade}
            disabled={loading}
            className="ml-auto text-xs rounded-md px-2.5 py-1 border border-border
              hover:border-primary hover:text-primary transition-colors duration-150 disabled:opacity-60"
          >
            {loading ? "…" : "Upgrade"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Pro Clock Dial ─────────────────────────────────────────────────────────────
/**
 * SVG arc clock that shows uses remaining as a filled arc.
 * Full circle = monthlyLimit. Filled arc = monthlyRemaining.
 */
function ProClockDial({ remaining, total }: { remaining: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const R = 28;
  const cx = 36;
  const cy = 36;
  const circumference = 2 * Math.PI * R;
  const dash = pct * circumference;
  const gap = circumference - dash;

  // Color: green > 50%, amber 20-50%, red < 20%
  const color =
    pct > 0.5 ? "hsl(174 100% 38%)" :
    pct > 0.2 ? "hsl(38 85% 52%)" :
                "hsl(0 72% 51%)";

  const ariaLabel = `Pro usage: ${remaining} of ${total} uses left this month`;

  return (
    <div className="flex items-center gap-3">
      <svg
        width="72"
        height="72"
        viewBox="0 0 72 72"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Track */}
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
        {/* Filled arc — start at top (−90°) */}
        <circle
          cx={cx} cy={cy} r={R}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dasharray 0.6s ease-out, stroke 0.3s" }}
        />
        {/* Center number */}
        <text
          x={cx} y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontSize="14"
          fontWeight="700"
          fontFamily="var(--font-mono, monospace)"
        >
          {remaining}
        </text>
      </svg>
      <div className="flex flex-col">
        <span className="text-xs font-medium text-foreground">
          {remaining} / {total}
        </span>
        <span className="text-[10px] text-muted-foreground">uses this month</span>
        <span
          className="text-[10px] font-semibold mt-0.5"
          style={{ color }}
        >
          {pct > 0.5 ? "All good" : pct > 0.2 ? "Running low" : "Almost out"}
        </span>
      </div>
    </div>
  );
}

function ProScorecard({ usage }: { usage: UsageData }) {
  const monthly = usage.monthlyLimit ?? 100;
  const remaining = usage.monthlyRemaining ?? (monthly - usage.runs);

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-4 mb-4">
      <ProClockDial remaining={remaining} total={monthly} />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-bold text-foreground">PromptClean Pro</span>
        <span className="text-[10px] text-muted-foreground">{monthly} cleanups / month</span>
        <span className="text-[10px] text-emerald-400 font-medium mt-0.5 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Active subscription
        </span>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function PaywallBanner() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    fetchUsage().then(setUsage).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("promptclean:usage-refresh", refresh);
    return () => window.removeEventListener("promptclean:usage-refresh", refresh);
  }, [refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      refresh();
      window.history.replaceState({}, "", "/#/");
    }
  }, [refresh]);

  if (!usage) return null;

  const handleUpgrade = async () => {
    setLoading(true);
    try { await startCheckout(); } catch { setLoading(false); }
  };

  if (usage.isPro) {
    return <ProScorecard usage={usage} />;
  }

  return <FreePipGauge usage={usage} onUpgrade={handleUpgrade} loading={loading} />;
}
