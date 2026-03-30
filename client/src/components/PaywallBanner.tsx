import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

interface UsageData {
  runs: number;
  limit: number;
  isPro: boolean;
  remaining: number | null;
  resetAt?: string;
  monthlyLimit?: number;
  monthlyRemaining?: number | null;
}

function daysUntil(isoDate: string): number {
  const ms = new Date(isoDate).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export default function PaywallBanner() {
  const { data, refetch } = useQuery<UsageData>({
    queryKey: ["/api/usage"],
    staleTime: 30_000,
  });

  useEffect(() => {
    const handler = () => { refetch(); };
    window.addEventListener("promptclean:usage-refresh", handler);
    return () => window.removeEventListener("promptclean:usage-refresh", handler);
  }, [refetch]);

  if (!data) return null;

  // ── Pro clock ──
  if (data.isPro) {
    const used = (data.monthlyLimit ?? 100) - (data.monthlyRemaining ?? 0);
    const pct = Math.min(100, (used / (data.monthlyLimit ?? 100)) * 100);
    const r = 14;
    const circ = 2 * Math.PI * r;
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2 mb-3"
        data-testid="paywall-banner-pro"
      >
        <svg width="36" height="36" viewBox="0 0 36 36" aria-label="Monthly usage">
          <circle cx="18" cy="18" r={r} stroke="hsl(var(--border))" strokeWidth="3" fill="none" />
          <circle
            cx="18" cy="18" r={r}
            stroke="hsl(174 100% 38%)"
            strokeWidth="3"
            fill="none"
            strokeDasharray={`${(pct / 100) * circ} ${circ}`}
            strokeLinecap="round"
            transform="rotate(-90 18 18)"
          />
        </svg>
        <div className="text-xs leading-snug">
          <span className="font-semibold text-foreground">Pro</span>
          <span className="text-muted-foreground ml-1">
            {data.monthlyRemaining ?? 0} of {data.monthlyLimit ?? 100} runs left this month
          </span>
        </div>
      </div>
    );
  }

  // ── Free pips ──
  const remaining = data.remaining ?? 0;
  const pips = Array.from({ length: data.limit }, (_, i) => i < (data.limit - remaining));
  const days = data.resetAt ? daysUntil(data.resetAt) : 7;

  return (
    <div
      className="flex items-center justify-between rounded-lg border border-border bg-card/60 px-3 py-2 mb-3"
      data-testid="paywall-banner-free"
    >
      <div className="flex items-center gap-1.5">
        {pips.map((used, i) => (
          <span
            key={i}
            className={`inline-block w-2.5 h-2.5 rounded-full transition-colors ${
              used ? "bg-primary" : "bg-muted"
            }`}
            aria-label={used ? "Used run" : "Available run"}
          />
        ))}
        <span className="ml-1.5 text-xs text-muted-foreground">
          {remaining} free run{remaining !== 1 ? "s" : ""} left
        </span>
      </div>
      {remaining === 0 && (
        <span className="text-xs text-muted-foreground/70">
          Refills in {days} day{days !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
