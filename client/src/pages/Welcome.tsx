/**
 * Welcome.tsx
 *
 * Shown once when a user hits the app for the first time.
 * Dismissed by clicking "Let's go" — sets localStorage key PC_SEEN_WELCOME_KEY.
 * After dismiss, navigates to "/" (Home).
 *
 * To re-trigger in dev:
 * localStorage.removeItem("pc_seen_welcome")
 */

import { useLocation } from "wouter";
import { Zap, Target, Layers, ArrowRight } from "lucide-react";
import { PC_SEEN_WELCOME_KEY } from "../constants";

const TIPS = [
  {
    icon: Target,
    title: "Be specific about the output",
    body: "The more you tell PromptClean about what you want — length, audience, format — the sharper the cleaned prompt will be.",
  },
  {
    icon: Layers,
    title: "Use the selectors before you run",
    body: "Pick your target AI model and output length before hitting Run Nodes. Those choices change how the cleanup questions are generated.",
  },
  {
    icon: Zap,
    title: "Answer every question that appears",
    body: "The questions aren't filler — they are the steps you skipped when you wrote the original prompt. Answering them is where the real optimization happens.",
  },
];

const STEPS = [
  {
    num: "01",
    label: "Paste your raw prompt",
    desc: "Type or paste the prompt you've been struggling with.",
  },
  {
    num: "02",
    label: "Pick your settings",
    desc: "Choose the prompt type, target AI model, and output length.",
  },
  {
    num: "03",
    label: "Answer the questions",
    desc: "PromptClean surfaces exactly what you skipped. Fill those in.",
  },
  {
    num: "04",
    label: "Copy your clean prompt",
    desc: "Get a precise, ready-to-use prompt — scored and logged.",
  },
];

export default function Welcome() {
  const [, navigate] = useLocation();

  function dismiss() {
    try {
      localStorage.setItem(PC_SEEN_WELCOME_KEY, "1");
    } catch {
      // ignore storage errors
    }

    navigate("/", true);
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="flex flex-col items-center justify-center px-6 pt-16 pb-10 text-center">
        <div className="mb-6">
          <svg
            width="52"
            height="52"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="16"
              cy="16"
              r="14"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M8 16 C8 11, 12 8, 16 8 C20 8, 24 11, 24 16"
              stroke="hsl(174 100% 38%)"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M8 16 C8 21, 12 24, 16 24 C20 24, 24 21, 24 16"
              stroke="hsl(38 85% 52%)"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
            />
            <circle cx="16" cy="16" r="2.5" fill="hsl(174 100% 38%)" />
          </svg>
        </div>

        <h1 className="font-display text-3xl font-bold tracking-tight mb-3">
          PromptClean
        </h1>

        <p className="text-muted-foreground max-w-[480px] leading-relaxed text-sm">
          You wrote a prompt and it gave you garbage. PromptClean finds exactly
          what you skipped — the missing context, the undefined audience, the
          vague goal — and rebuilds the prompt with precision so your AI
          actually delivers.
        </p>
      </div>

      <div className="max-w-[600px] mx-auto w-full px-6 space-y-8 pb-16">
        <section>
          <h2 className="font-display text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">
            How it works
          </h2>

          <div className="space-y-3">
            {STEPS.map((s, i) => (
              <div key={s.num} className="flex items-start gap-4">
                <div className="flex flex-col items-center">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                    style={{
                      background: `hsl(174 100% 38% / ${0.15 + i * 0.07})`,
                      border: "1px solid hsl(174 100% 38% / 0.4)",
                      color: "hsl(174 100% 38%)",
                    }}
                  >
                    {s.num}
                  </div>

                  {i < STEPS.length - 1 && (
                    <div className="w-px h-5 bg-border mt-1" />
                  )}
                </div>

                <div className="pb-2">
                  <p className="text-sm font-semibold text-foreground">
                    {s.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {s.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="font-display text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">
            How to get the best results
          </h2>

          <div className="space-y-3">
            {TIPS.map((tip) => (
              <div
                key={tip.title}
                className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <tip.icon className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {tip.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {tip.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="rounded-lg border border-border bg-card/50 px-4 py-3 flex items-center gap-3">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-3 h-3 rounded-full bg-emerald-400/80 border border-emerald-500/50"
              />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            <span className="text-foreground font-medium">3 free cleanups</span>{" "}
            to start. Upgrade to Pro for unlimited runs at $9/month.
          </p>
        </div>

        <button
          onClick={dismiss}
          className="w-full py-3 rounded-lg font-display font-bold text-sm uppercase tracking-wider bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          Let&apos;s go
          <ArrowRight className="w-4 h-4" />
        </button>

        <p className="text-center text-[10px] text-muted-foreground/50">
          You can revisit this guide anytime from the help link in the header.
        </p>
      </div>
    </div>
  );
}
