import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, User, Globe, TrendingUp, Zap } from "lucide-react";

interface PatternEntry { tag: string; count: number; pct?: number; }

interface ProfileData {
  profile: {
    userId: string;
    personalPatternsJson: string;
    totalRuns: number;
    avgScore: number;
    updatedAt: string;
  } | null;
  baseline: {
    topPatternsJson: string;
    totalCleanups: number;
    avgScore: number;
    updatedAt: string;
  } | null;
}

function PatternBar({ tag, count, max, color }: { tag: string; count: number; max: number; color: string }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground font-medium capitalize">{tag}</span>
        <span className="text-muted-foreground tabular-nums">{count}x</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function CommunityBar({ tag, pct, count }: { tag: string; pct: number; count: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground font-medium capitalize">{tag}</span>
        <span className="text-muted-foreground tabular-nums">{pct}% of runs</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: "hsl(174 100% 38%)" }}
        />
      </div>
    </div>
  );
}

export default function Profile() {
  const { data, isLoading, isError } = useQuery<ProfileData>({
    queryKey: ["/api/profile"],
  });

  const personalPatterns: PatternEntry[] = data?.profile
    ? JSON.parse(data.profile.personalPatternsJson || "[]")
    : [];

  const communityPatterns: (PatternEntry & { pct: number })[] = data?.baseline
    ? JSON.parse(data.baseline.topPatternsJson || "[]")
    : [];

  const maxPersonal = personalPatterns[0]?.count ?? 1;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-[720px] mx-auto px-4 py-4 flex items-center gap-4">
          <Link href="/">
            <button className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div className="flex items-center gap-2">
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none" className="shrink-0">
              <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 16 C8 11, 12 8, 16 8 C20 8, 24 11, 24 16" stroke="hsl(174 100% 38%)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M8 16 C8 21, 12 24, 16 24 C20 24, 24 21, 24 16" stroke="hsl(38 85% 52%)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <circle cx="16" cy="16" r="2.5" fill="hsl(174 100% 38%)" />
            </svg>
            <span className="font-display text-base font-bold">Signal Profile</span>
          </div>
        </div>
      </header>

      <main className="max-w-[720px] mx-auto px-4 py-8 space-y-6">
        {isLoading && (
          <div className="space-y-4">
            {[1,2,3].map(i => (
              <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Could not load profile. Make sure the backend is running.
          </div>
        )}

        {data && (
          <>
            {/* Personal stats */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4" data-testid="personal-stats">
              <div className="flex items-center gap-2 mb-2">
                <User className="w-4 h-4 text-primary" />
                <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Your Patterns
                </h2>
              </div>

              {!data.profile || data.profile.totalRuns === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  Run at least one cleanup to start building your profile.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-4 pb-4 border-b border-border">
                    <div className="text-center">
                      <div className="text-2xl font-display font-bold tabular-nums" style={{ color: "hsl(174 100% 38%)" }}>
                        {data.profile.totalRuns}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">total runs</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-display font-bold tabular-nums" style={{ color: "hsl(38 85% 52%)" }}>
                        {data.profile.avgScore}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">avg original score</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-display font-bold tabular-nums" style={{ color: "hsl(280 60% 60%)" }}>
                        {personalPatterns.length}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">pattern types</div>
                    </div>
                  </div>

                  {personalPatterns.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Your recurring blind spots — these are what your prompts consistently skip.
                        The node questions are tuned to catch these first for you.
                      </p>
                      {personalPatterns.slice(0, 6).map((p, i) => (
                        <PatternBar
                          key={p.tag}
                          tag={p.tag}
                          count={p.count}
                          max={maxPersonal}
                          color={i === 0 ? "hsl(38 85% 52%)" : "hsl(174 100% 38%)"}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      No patterns detected yet — run a few more cleanups.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Community baseline */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4" data-testid="community-baseline">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" />
                  <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Community Baseline
                  </h2>
                </div>
                {data.baseline && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {data.baseline.totalCleanups.toLocaleString()} total cleanups
                  </span>
                )}
              </div>

              {!data.baseline || data.baseline.totalCleanups === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  Not enough data yet. Community patterns appear after more users run cleanups.
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    The most common failure patterns across all PromptClean users.
                    These form the ground floor that the nodes are tuned against.
                  </p>
                  <div className="grid grid-cols-2 gap-4 pb-4 border-b border-border">
                    <div className="text-center">
                      <div className="text-xl font-display font-bold tabular-nums text-primary">
                        {data.baseline.avgScore}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">avg original score</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xl font-display font-bold tabular-nums" style={{ color: "hsl(38 85% 52%)" }}>
                        {communityPatterns.length}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">tracked patterns</div>
                    </div>
                  </div>
                  {communityPatterns.map((p) => (
                    <CommunityBar key={p.tag} tag={p.tag} pct={p.pct ?? 0} count={p.count} />
                  ))}
                </div>
              )}
            </div>

            {/* How it works */}
            <div className="rounded-lg border border-border bg-card p-5" data-testid="how-nuance-works">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-4 h-4 text-primary" />
                <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  How Nuance Works
                </h2>
              </div>
              <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-primary shrink-0 font-bold">1.</span>
                  After each cleanup, the system logs what kind of failure your prompt had and how it scored.
                </li>
                <li className="flex gap-2">
                  <span className="text-primary shrink-0 font-bold">2.</span>
                  After 3 runs, your personal pattern history gets injected into Delta's system prompt — so future node questions are weighted toward YOUR blind spots.
                </li>
                <li className="flex gap-2">
                  <span className="text-primary shrink-0 font-bold">3.</span>
                  The community baseline aggregates patterns across all users. New users without history start from the community ground floor.
                </li>
                <li className="flex gap-2">
                  <span className="text-primary shrink-0 font-bold">4.</span>
                  Over time: your personal layer floats above the baseline, overriding where your habits differ from the crowd.
                </li>
              </ul>
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-border mt-8">
        <div className="max-w-[720px] mx-auto px-4 py-5 flex flex-col items-center gap-1.5">
          <p className="text-xs text-muted-foreground italic">signal in, signal out — noise filtered</p>
          <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer"
            className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors">
            Created with Perplexity Computer
          </a>
        </div>
      </footer>
    </div>
  );
}
