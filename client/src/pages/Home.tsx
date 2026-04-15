import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, Sun, Moon, ChevronRight, Zap, ArrowRight, LogOut, ImageIcon, Video, X, User, Download } from "lucide-react";
import type { Cleanup, WeightedAnswer } from "@shared/schema";
import QuestionCard from "@/components/QuestionCard";
import type { OptionState, QuestionOption } from "@/components/QuestionCard";
import PromptControls, { type PromptConfig } from "@/components/PromptControls";
import PaywallBanner from "@/components/PaywallBanner";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "wouter";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Question {
  id: string;
  node: "alpha" | "beta" | "gamma";
  question: string;
  type: "choice" | "text" | "weighted-choice";
  options?: string[];
}

/** Build QuestionOption[] from the raw string array returned by the API */
function buildQuestionOptions(raw: string[]): QuestionOption[] {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const opts: QuestionOption[] = raw.map((text, i) => ({
    id: letters[i] ?? `opt${i}`,
    text,
  }));
  // append a "type your own" slot
  opts.push({ id: "custom", text: "", isCustom: true });
  return opts;
}

/** Serialise OptionState[] into a plain-text answer for the cleanup API */
function serialiseWeightedAnswer(states: OptionState[]): string {
  const selected = states.filter((o) => o.selected && o.text.trim());
  if (selected.length === 0) return "";
  return selected
    .map((o) => `${o.text} (weight: ${o.weight})`)
    .join("; ");
}

/** Build a WeightedAnswer payload from OptionState[] */
function toWeightedPayload(questionId: string, states: OptionState[]): WeightedAnswer {
  const selected = states.filter((o) => o.selected && o.text.trim());
  const custom = selected.find((o) => o.isCustom);
  return {
    questionId,
    selections: selected.map((o) => ({ optionId: o.id, text: o.text, weight: o.weight })),
    customText: custom?.customText || custom?.text,
  };
}

interface CleanupResult {
  // A — cleaned prompt + Gemini executing it
  fixedPrompt: string;
  changeLog: string[];
  foil: { first: string; outer: string; inner: string; last: string };
  pos: { nouns: string[]; verbs: string[]; adjectives: string[] };
  fullResponse: string;         // Gemini doing the actual task
  // B — alternative AI perspective
  alternativeResponse: string;
  media: { generatedImageUrl: string | null; hasImageInput: boolean; hasVideoInput: boolean };
  // C — score + evaluation
  score: { specificity: number; context: number; constraints: number; outputDef: number; total: number };
  deltaComment: string;
  didWell: string[];
  toImprove: string[];
  patternTag?: string;
  // internals
  nodeOutputs: { alpha: string; beta: string; gamma: any; delta: any };
  usage: { runsUsed: number; limit: number; isPro: boolean; runsRemaining: number };
}

interface MediaInput {
  imageFile?: File;
  imagePreview?: string; // data URL
  imageBase64?: string;
  imageMime?: string;
  videoUrl?: string;
}

type Stage = "input" | "questions" | "processing" | "done";

// ── Theme ──────────────────────────────────────────────────────────────────────
function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);
  return { isDark, toggle: () => setIsDark((d) => !d) };
}

// ── Logo ──────────────────────────────────────────────────────────────────────
function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-label="PromptClean logo" className="shrink-0">
        <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 16 C8 11, 12 8, 16 8 C20 8, 24 11, 24 16" stroke="hsl(174 100% 38%)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M8 16 C8 21, 12 24, 16 24 C20 24, 24 21, 24 16" stroke="hsl(38 85% 52%)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <circle cx="16" cy="16" r="2.5" fill="hsl(174 100% 38%)" />
      </svg>
      <span className="font-display text-lg font-bold tracking-tight">PromptClean</span>
    </div>
  );
}

// ── Node Pipeline ─────────────────────────────────────────────────────────────
const NODES = [
  { id: "alpha", label: "Alpha", desc: "Feel — signal as-is" },
  { id: "beta",  label: "Beta",  desc: "Understand — fracture" },
  { id: "gamma", label: "Gamma", desc: "Decide — lock it in" },
  { id: "delta", label: "Delta", desc: "Do — consequence" },
] as const;

const NODE_COLOR: Record<string, string> = {
  alpha: "hsl(174 100% 38%)",
  beta:  "hsl(174 80% 44%)",
  gamma: "hsl(38 85% 52%)",
  delta: "hsl(280 60% 60%)",
};

function NodePipeline({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-0 my-6" data-testid="node-pipeline">
      {NODES.map((node, i) => (
        <div key={node.id} className="flex items-center">
          <div
            data-testid={`node-${node.id}`}
            className={`
              flex flex-col items-center justify-center px-3 py-2.5 rounded-lg border
              transition-all duration-300 min-w-[90px]
              ${activeIndex === i
                ? "border-primary bg-primary/10 shadow-[0_0_20px_4px_rgba(0,196,180,0.3)]"
                : activeIndex > i
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-card"
              }
            `}
          >
            <span className="font-display text-xs font-bold uppercase tracking-wider text-primary">
              {node.label}
            </span>
            <span className="text-[10px] text-muted-foreground mt-0.5 text-center leading-tight">
              {node.desc}
            </span>
          </div>
          {i < NODES.length - 1 && (
            <ChevronRight
              className={`w-4 h-4 mx-1 transition-colors duration-300 ${
                activeIndex > i ? "text-primary" : "text-muted-foreground/40"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Score Bar ─────────────────────────────────────────────────────────────────
function ScoreBar({ label, value, max, delay }: { label: string; value: number; max: number; delay: number }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth((value / max) * 100), delay);
    return () => clearTimeout(t);
  }, [value, max, delay]);

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${width}%`, backgroundColor: "hsl(38 85% 52%)" }}
        />
      </div>
      <span className="text-xs font-mono font-semibold w-8 text-right" style={{ color: "hsl(38 85% 52%)" }}>
        {value}
      </span>
    </div>
  );
}

// ── Signal Score Panel ────────────────────────────────────────────────────────
// ── Panel A — Cleaned Prompt + Response ──────────────────────────────────────
function PanelA({ result }: { result: CleanupResult }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResponse = async () => {
    try { await navigator.clipboard.writeText(result.fullResponse); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4" data-testid="panel-a">
      <div className="flex items-center gap-3">
        <span className="font-display text-xl font-black" style={{ color: "hsl(174 100% 38%)" }}>A</span>
        <div>
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">Cleaned Prompt</h3>
          <p className="text-xs text-muted-foreground mt-0.5">The fixed prompt + Gemini executing it as the actual task</p>
        </div>
      </div>

      {/* The prompt itself */}
      <FixedPromptBlock prompt={result.fixedPrompt} />

      {/* Gemini's full response to the cleaned prompt */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Response</span>
          <button onClick={copyResponse} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {copied ? <><Check className="w-3.5 h-3.5 text-primary" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
          </button>
        </div>
        {result.media?.generatedImageUrl && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Generated image</span>
              <a href={result.media.generatedImageUrl} download="promptclean-generated.png"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Download className="w-3.5 h-3.5" />Save
              </a>
            </div>
            <img src={result.media.generatedImageUrl} alt="Generated" className="w-full rounded-md object-cover max-h-80" />
          </div>
        )}
        {result.fullResponse ? (
          <div className="rounded-md bg-muted/40 p-4 text-sm text-foreground leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
            {result.fullResponse}
          </div>
        ) : (
          <div className="rounded-md bg-muted/40 p-4 text-sm text-muted-foreground italic">
            Processing response…
          </div>
        )}
      </div>

      {/* FOIL + POS breakdown toggle */}
      <button
        onClick={() => setShowBreakdown((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        data-testid="toggle-breakdown"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showBreakdown ? "rotate-90" : ""}`} />
        Show FOIL breakdown
      </button>

      {showBreakdown && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {([
              ["F — First (subject)", result.foil?.first],
              ["O — Outer (action)", result.foil?.outer],
              ["I — Inner (modifier)", result.foil?.inner],
              ["L — Last (target)", result.foil?.last],
            ] as [string, string][]).map(([label, val]) => (
              <div key={label} className="rounded border border-border bg-muted/30 px-3 py-2">
                <div className="text-muted-foreground mb-0.5 font-medium">{label}</div>
                <div className="text-foreground">{val || <span className="italic text-muted-foreground/50">none</span>}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {result.pos?.nouns?.map((w: string) => (
              <span key={w} className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-medium">{w}</span>
            ))}
            {result.pos?.verbs?.map((w: string) => (
              <span key={w} className="px-2 py-0.5 rounded-full bg-amber-500/15 font-medium" style={{ color: "hsl(38 85% 52%)" }}>{w}</span>
            ))}
            {result.pos?.adjectives?.map((w: string) => (
              <span key={w} className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{w}</span>
            ))}
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span><span className="inline-block w-2 h-2 rounded-full bg-primary/50 mr-1" />noun</span>
            <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: "hsl(38 85% 52% / 0.5)" }} />verb</span>
            <span><span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/30 mr-1" />adjective</span>
          </div>
          {result.changeLog?.length > 0 && (
            <ul className="space-y-1.5 border-l-2 border-primary/30 pl-3">
              {result.changeLog.map((item: string, i: number) => (
                <li key={i} className="text-xs text-foreground/80 leading-relaxed">{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel B — Alternative AI Response ────────────────────────────────────────
function PanelB({ result }: { result: CleanupResult }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(result.alternativeResponse); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4" data-testid="panel-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-display text-xl font-black" style={{ color: "hsl(38 85% 52%)" }}>B</span>
          <div>
            <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">Alternative AI</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Same fixed prompt — different AI perspective (structured, direct)</p>
          </div>
        </div>
        <button onClick={copy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          {copied ? <><Check className="w-3.5 h-3.5 text-primary" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
        </button>
      </div>

      {result.alternativeResponse ? (
        <div className="rounded-md bg-muted/40 p-4 text-sm text-foreground leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
          {result.alternativeResponse}
        </div>
      ) : (
        <div className="rounded-md bg-muted/40 p-4 text-sm text-muted-foreground italic">
          Processing alternative response…
        </div>
      )}
    </div>
  );
}

// ── Panel C — Score + Evaluation ─────────────────────────────────────────────
function PanelC({ result }: { result: CleanupResult }) {
  const { score, didWell, toImprove, deltaComment } = result;
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-5" data-testid="panel-c">
      <div className="flex items-center gap-3">
        <span className="font-display text-xl font-black" style={{ color: "hsl(280 60% 60%)" }}>C</span>
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">Score + Evaluation</h3>
      </div>

      {/* Score */}
      <div className="space-y-1">
        <div className="flex items-end gap-3 mb-3">
          <span className="text-4xl font-display font-black tabular-nums" style={{ color: "hsl(38 85% 52%)" }} data-testid="total-score">
            {score.total}
          </span>
          <span className="text-base text-muted-foreground font-display mb-1">/ 100</span>
          <span className="text-xs text-muted-foreground mb-1.5">original prompt scored</span>
        </div>
        <ScoreBar label="Specificity" value={score.specificity} max={25} delay={100} />
        <ScoreBar label="Context" value={score.context} max={25} delay={220} />
        <ScoreBar label="Constraints" value={score.constraints} max={25} delay={340} />
        <ScoreBar label="Output Def." value={score.outputDef} max={25} delay={460} />
      </div>

      {/* Did well / To improve */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs font-display font-bold text-primary uppercase tracking-wider mb-2">What you got right</p>
          <ul className="space-y-1.5">
            {(didWell ?? []).map((item: string, i: number) => (
              <li key={i} className="text-xs text-foreground/90 leading-relaxed flex gap-1.5">
                <span className="text-primary shrink-0 mt-0.5">✓</span>{item}
              </li>
            ))}
            {(!didWell || didWell.length === 0) && (
              <li className="text-xs text-muted-foreground italic">Nothing specific flagged.</li>
            )}
          </ul>
        </div>
        <div className="rounded-md border border-amber-500/30 p-3" style={{ background: "hsl(38 85% 52% / 0.05)" }}>
          <p className="text-xs font-display font-bold uppercase tracking-wider mb-2" style={{ color: "hsl(38 85% 52%)" }}>What would improve it</p>
          <ul className="space-y-1.5">
            {(toImprove ?? []).map((item: string, i: number) => (
              <li key={i} className="text-xs text-foreground/90 leading-relaxed flex gap-1.5">
                <span className="shrink-0 mt-0.5" style={{ color: "hsl(38 85% 52%)" }}>→</span>{item}
              </li>
            ))}
            {(!toImprove || toImprove.length === 0) && (
              <li className="text-xs text-muted-foreground italic">No improvements flagged.</li>
            )}
          </ul>
        </div>
      </div>

      {deltaComment && (
        <p className="text-xs text-muted-foreground italic border-t border-border pt-3">{deltaComment}</p>
      )}
    </div>
  );
}

function SignalScore({ score }: { score: CleanupResult["score"] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5" data-testid="signal-score">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">
        Signal Score
      </h3>
      <div className="flex items-end gap-4 mb-5">
        <span className="text-4xl font-display font-bold tabular-nums" style={{ color: "hsl(38 85% 52%)" }} data-testid="total-score">
          {score.total}
        </span>
        <span className="text-lg text-muted-foreground font-display mb-1">/ 100</span>
        <span className="text-xs text-muted-foreground mb-1.5 ml-1">original prompt</span>
      </div>
      <div className="space-y-3">
        <ScoreBar label="Specificity"  value={score.specificity}  max={25} delay={100} />
        <ScoreBar label="Context"      value={score.context}      max={25} delay={250} />
        <ScoreBar label="Constraints"  value={score.constraints}  max={25} delay={400} />
        <ScoreBar label="Output Def."  value={score.outputDef}    max={25} delay={550} />
      </div>
    </div>
  );
}

// ── Change Log ────────────────────────────────────────────────────────────────
function ChangeLog({ items, comment }: { items: string[]; comment: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5" data-testid="change-log">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">
        Change Log
      </h3>
      <ul className="space-y-2 border-l-2 border-primary/40 pl-4">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-foreground/90 leading-relaxed">{item}</li>
        ))}
      </ul>
      {comment && (
        <p className="mt-4 text-xs text-muted-foreground italic border-t border-border pt-3">{comment}</p>
      )}
    </div>
  );
}

// ── Fixed Prompt Block ────────────────────────────────────────────────────────
function FixedPromptBlock({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prompt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 relative" data-testid="fixed-prompt">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Output Field
        </h3>
        <button
          onClick={handleCopy}
          data-testid="copy-button"
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border
            hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          {copied ? (
            <><Check className="w-3.5 h-3.5 text-primary" /><span className="text-primary">Copied!</span></>
          ) : (
            <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>
          )}
        </button>
      </div>
      <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">{prompt}</p>
    </div>
  );
}

// ── Paywall Gate ─────────────────────────────────────────────────────────────
function PaywallGate({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-6 text-center space-y-4" data-testid="paywall-gate">
      <div className="text-3xl font-display font-bold" style={{ color: "hsl(38 85% 52%)" }}>3 / 3</div>
      <p className="text-sm text-foreground font-medium">Free runs used.</p>
      <p className="text-xs text-muted-foreground leading-relaxed">
        You've run the full Feel → Understand → Decide → Do chain three times.<br />
        Upgrade to keep going — $9/month, cancel any time.
      </p>
      <button
        onClick={onUpgrade}
        data-testid="button-upgrade"
        className="px-6 py-2.5 rounded-lg font-display font-bold text-sm uppercase tracking-wider
          text-black transition-opacity hover:opacity-90"
        style={{ backgroundColor: "hsl(38 85% 52%)" }}
      >
        Upgrade to Pro — $9/month
      </button>
    </div>
  );
}

// ── Usage Bar ────────────────────────────────────────────────────────────────
function UsageBar({ runs, limit, isPro }: { runs: number; limit: number; isPro: boolean }) {
  if (isPro) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="w-2 h-2 rounded-full bg-primary inline-block" />
      Pro — unlimited runs
    </div>
  );
  const remaining = Math.max(0, limit - runs);
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground" data-testid="usage-bar">
      <span>{remaining} free run{remaining !== 1 ? "s" : ""} remaining</span>
      <div className="flex gap-1">
        {Array.from({ length: limit }).map((_, i) => (
          <div key={i} className={`w-4 h-1.5 rounded-full transition-colors ${
            i < runs ? "bg-amber-500" : "bg-muted"
          }`} />
        ))}
      </div>
    </div>
  );
}

// ── Gemini Panel ─────────────────────────────────────────────────────────────
function GeminiPanel({ fixed, original }: { fixed: string; original: string }) {
  const [tab, setTab] = useState<"fixed" | "original">("fixed");
  const [copiedFixed, setCopiedFixed] = useState(false);
  const [copiedOriginal, setCopiedOriginal] = useState(false);

  const copy = async (text: string, which: "fixed" | "original") => {
    try { await navigator.clipboard.writeText(text); } catch {}
    if (which === "fixed") { setCopiedFixed(true); setTimeout(() => setCopiedFixed(false), 1500); }
    else { setCopiedOriginal(true); setTimeout(() => setCopiedOriginal(false), 1500); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4" data-testid="gemini-panel">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Gemini Response
        </h3>
        <div className="flex gap-1 p-0.5 rounded-md bg-muted">
          <button
            onClick={() => setTab("fixed")}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              tab === "fixed" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Fixed prompt
          </button>
          <button
            onClick={() => setTab("original")}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              tab === "original" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Original prompt
          </button>
        </div>
      </div>

      {tab === "fixed" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">What Gemini returns for the <span className="text-primary">cleaned</span> prompt</p>
            <button onClick={() => copy(fixed, "fixed")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {copiedFixed ? <><Check className="w-3 h-3 text-primary" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
            </button>
          </div>
          <div className="rounded-md bg-muted/50 p-4 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">
            {fixed || <span className="text-muted-foreground italic">No response</span>}
          </div>
        </div>
      )}

      {tab === "original" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">What Gemini returns for the <span style={{ color: "hsl(38 85% 52%)" }}>original</span> prompt — see the difference</p>
            <button onClick={() => copy(original, "original")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {copiedOriginal ? <><Check className="w-3 h-3 text-primary" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
            </button>
          </div>
          <div className="rounded-md bg-muted/50 p-4 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">
            {original || <span className="text-muted-foreground italic">No response</span>}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground/60 italic">
        Switch tabs to see how much the cleanup changes what you actually get back.
      </p>
    </div>
  );
}

// ── Node Accordion ────────────────────────────────────────────────────────────
function NodeOutputs({ outputs }: { outputs: CleanupResult["nodeOutputs"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = [
    { id: "alpha", label: "Alpha Node", content: outputs.alpha },
    { id: "beta",  label: "Beta Node",  content: outputs.beta },
    { id: "gamma", label: "Gamma Node", content: typeof outputs.gamma === "string" ? outputs.gamma : JSON.stringify(outputs.gamma, null, 2) },
    { id: "delta", label: "Delta Node", content: typeof outputs.delta === "string" ? outputs.delta : JSON.stringify(outputs.delta, null, 2) },
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-5" data-testid="node-outputs">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">
        Node Breakdown
      </h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="border border-border rounded-md overflow-hidden">
            <button
              onClick={() => setOpen(open === item.id ? null : item.id)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors text-left"
              data-testid={`toggle-node-${item.id}`}
            >
              <span className="text-primary font-display font-semibold text-xs uppercase tracking-wider">{item.label}</span>
              <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${open === item.id ? "rotate-90" : ""}`} />
            </button>
            {open === item.id && (
              <div className="px-3 pb-3 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap border-t border-border pt-2">
                {item.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────
function HistoryPanel({ onSelect }: { onSelect: (c: Cleanup) => void }) {
  const { data: history, isLoading } = useQuery<Cleanup[]>({ queryKey: ["/api/history"] });
  if (isLoading || !history || history.length === 0) return null;

  return (
    <div className="mt-8" data-testid="history-panel">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">
        Recent Cleanups
      </h3>
      <div className="grid gap-2">
        {history.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item)}
            data-testid={`history-item-${item.id}`}
            className="flex items-center justify-between px-4 py-3 rounded-lg border border-border
              bg-card hover:bg-muted/50 transition-colors text-left group"
          >
            <p className="text-sm text-foreground/80 truncate flex-1 mr-3">{item.originalPrompt}</p>
            <span
              className="text-xs font-mono font-bold px-2 py-0.5 rounded-full shrink-0"
              style={{ backgroundColor: "hsla(38, 85%, 52%, 0.15)", color: "hsl(38 85% 52%)" }}
            >
              {item.totalScore}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Processing Dots ───────────────────────────────────────────────────────────
function ProcessingDots({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6">
      {NODES.map((node, i) => (
        <div key={node.id} className={`w-3 h-3 rounded-full transition-all duration-300 ${
          activeIndex === i ? "bg-primary scale-125 animate-pulse" : activeIndex > i ? "bg-primary/60" : "bg-muted"
        }`} />
      ))}
      <span className="ml-3 text-sm text-muted-foreground">Nodes processing...</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const { isDark, toggle } = useTheme();
  const { toast } = useToast();
  const { user, logout } = useAuth();

  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<Stage>("input");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [weightedState, setWeightedState] = useState<Record<string, OptionState[]>>({});
  const [questionOptions, setQuestionOptions] = useState<Record<string, QuestionOption[]>>({});
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [activeNode, setActiveNode] = useState(-1);
  const [paywalled, setPaywalled] = useState(false);
  const [usageInfo, setUsageInfo] = useState<{ runs: number; limit: number; isPro: boolean } | null>(null);
  const [media, setMedia] = useState<MediaInput>({});
  const [generateImage, setGenerateImage] = useState(false);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [config, setConfig] = useState<PromptConfig>({
    promptType: "general",
    model: "gpt-4o",
    length: "medium",
  });

  // Fetch usage on mount
  useEffect(() => {
    apiRequest("GET", "/api/usage")
      .then((r) => r.json())
      .then((d) => setUsageInfo(d))
      .catch(() => {});
  }, []);

  // ── Step 1: fetch questions ─────────────────────────────────────────────────
  const questionsMutation = useMutation({
    mutationFn: async (rawPrompt: string) => {
      // Use FormData when media is present
      if (media.imageFile || media.videoUrl) {
        const fd = new FormData();
        fd.append("prompt", rawPrompt);
        if (media.imageFile) fd.append("image", media.imageFile);
        if (media.videoUrl) fd.append("videoUrl", media.videoUrl);
        const res = await fetch(
          `${API_BASE}/api/questions`,
          { method: "POST", body: fd, credentials: "include" }
        );
        return (await res.json()) as { questions: Question[] };
      }
      const res = await apiRequest("POST", "/api/questions", { prompt: rawPrompt });
      return (await res.json()) as { questions: Question[] };
    },
    onMutate: () => {
      setResult(null);
      setActiveNode(0);
      let idx = 0;
      intervalRef.current = setInterval(() => {
        idx++;
        if (idx >= 2) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setActiveNode(1);
        } else {
          setActiveNode(idx);
        }
      }, 600);
    },
    onSuccess: (data) => {
      window.dispatchEvent(new Event("promptclean:usage-refresh"));
      if (intervalRef.current) clearInterval(intervalRef.current);
      setActiveNode(-1);
      setQuestions(data.questions);
      setAnswers({});
      // Initialise per-question option data for weighted-choice questions
      const qOpts: Record<string, QuestionOption[]> = {};
      for (const q of data.questions) {
        if (q.options) {
          qOpts[q.id] = buildQuestionOptions(q.options);
        }
      }
      setQuestionOptions(qOpts);
      setWeightedState({});
      setStage("questions");
    },
    onError: (err: any) => {
      let status: number | undefined =
        typeof err?.status === "number"
          ? err.status
          : typeof err?.response?.status === "number"
            ? err.response.status
            : undefined;

      // Fallback: derive status from error message like "402: ..."
      if (
        status === undefined &&
        err &&
        typeof err.message === "string"
      ) {
        const match = err.message.match(/^(\d{3})\b/);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (!Number.isNaN(parsed)) {
            status = parsed;
          }
        }
      }

      if (status === 402) {
        window.dispatchEvent(new Event("promptclean:usage-refresh"));
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
      setActiveNode(-1);
      setStage("input");
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Step 2: run full cleanup with answers ───────────────────────────────────
  const cleanupMutation = useMutation({
    mutationFn: async ({ rawPrompt, ans, weightedAnswers }: { rawPrompt: string; ans: Record<string, string>; weightedAnswers?: WeightedAnswer[] }) => {
      const fd = new FormData();
      fd.append("prompt", rawPrompt);
      fd.append("answers", JSON.stringify(ans));
      if (weightedAnswers) fd.append("weightedAnswers", JSON.stringify(weightedAnswers));
      if (media.imageFile) fd.append("image", media.imageFile);
      if (media.videoUrl) fd.append("videoUrl", media.videoUrl);
      if (generateImage) fd.append("generateImage", "true");
      const res = await fetch(`${API_BASE}/api/cleanup`, { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        const e: any = new Error(err.message || "Cleanup failed");
        e.status = res.status; throw e;
      }
      return (await res.json()) as CleanupResult;
    },
    onMutate: () => {
      setStage("processing");
      setActiveNode(0);
      let idx = 0;
      intervalRef.current = setInterval(() => {
        idx++;
        if (idx >= 4) {
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
        setActiveNode(idx);
      }, 700);
    },
    onSuccess: (data) => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setActiveNode(4);
      setResult(data);
      setStage("done");
      if (data.usage) setUsageInfo({ runs: data.usage.runsUsed ?? 0, limit: data.usage.limit, isPro: data.usage.isPro });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
    },
    onError: (err: Error & { status?: number }) => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setActiveNode(-1);
      // 402 = free limit reached
      if (err.message?.includes("402") || err.message?.includes("free_limit")) {
        setPaywalled(true);
        setStage("input");
      } else {
        setStage("questions");
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    },
  });

  const handleUpgrade = async () => {
    try {
      const res = await apiRequest("POST", "/api/create-checkout-session", {});
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (err: any) {
      toast({ title: "Stripe error", description: err.message, variant: "destructive" });
    }
  };

  const handleRunNodes = () => {
    if (!prompt.trim()) return;
    setStage("input"); // reset
    const enriched =
      `${prompt.trim()}\n\n` +
      `[Target model: ${config.model} | Output length: ${config.length} | Type: ${config.promptType}]`;
    questionsMutation.mutate(enriched);
  };

  const handleFinalize = () => {
    // Merge weighted multi-select answers into the flat answers record
    const merged = { ...answers };
    for (const [qid, states] of Object.entries(weightedState)) {
      const serialised = serialiseWeightedAnswer(states);
      if (serialised) merged[qid] = serialised;
    }
    // Build weighted payloads for richer backend processing
    const weightedAnswers: WeightedAnswer[] = Object.entries(weightedState)
      .map(([qid, states]) => toWeightedPayload(qid, states))
      .filter((w) => w.selections.length > 0);
    cleanupMutation.mutate({ rawPrompt: prompt.trim(), ans: merged, weightedAnswers });
  };

  /** Unified handler for the new QuestionCard onChange signature */
  const handleQuestionChange = useCallback(
    (qid: string, answer: { selected: OptionState[]; text: string }) => {
      // Always store the text answer (for choice/text, or empty string for weighted-choice)
      setAnswers((prev) => ({ ...prev, [qid]: answer.text }));
      // Store weighted state when any option is selected
      const hasSelected = answer.selected.some((o) => o.selected);
      if (hasSelected) {
        setWeightedState((prev) => ({ ...prev, [qid]: answer.selected }));
      } else {
        setWeightedState((prev) => {
          const next = { ...prev };
          delete next[qid];
          return next;
        });
      }
    },
    [],
  );

  const handleHistorySelect = (item: Cleanup) => {
    setPrompt(item.originalPrompt);
    setStage("input");
    setResult(null);
    setQuestions([]);
    setAnswers({});
    setWeightedState({});
    setQuestionOptions({});
  };

  const handleReset = () => {
    setStage("input");
    setResult(null);
    setQuestions([]);
    setAnswers({});
    setWeightedState({});
    setQuestionOptions({});
    setActiveNode(-1);
    setPaywalled(false);
    setMedia({});
    setGenerateImage(false);
    setShowVideoInput(false);
  };

  const answeredCount =
    Object.keys(answers).filter((k) => answers[k]?.trim()).length +
    Object.values(weightedState).filter((opts) => opts.some((o) => o.selected && o.text.trim())).length;
  const isPending = questionsMutation.isPending || cleanupMutation.isPending;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-[720px] mx-auto px-4 py-4 flex items-center justify-between">
          <button onClick={handleReset} className="focus:outline-none" aria-label="Reset">
            <Logo />
          </button>
          <div className="flex items-center gap-3">
            {usageInfo && (
              <UsageBar runs={usageInfo.runs} limit={usageInfo.limit} isPro={usageInfo.isPro} />
            )}
            <Link href="/profile">
              <button
                className="p-2 rounded-md hover:bg-muted transition-colors text-muted-foreground"
                aria-label="Signal profile"
                data-testid="link-profile"
              >
                <User className="w-4 h-4" />
              </button>
            </Link>
            <button
              onClick={toggle}
              data-testid="theme-toggle"
              className="p-2 rounded-md hover:bg-muted transition-colors text-muted-foreground"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[720px] mx-auto px-4 py-8">

        {/* ── Stage: Input ── */}
        {(stage === "input" || stage === "questions") && (
          <div className="mb-2">
            {/* ─ Usage gauge (free pips or pro clock) ─ */}
            <PaywallBanner />

            <label
              htmlFor="raw-signal"
              className="block font-display text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2"
            >
              Raw Signal
            </label>
            <textarea
              id="raw-signal"
              data-testid="input-raw-signal"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); if (stage === "questions") { setStage("input"); setQuestions([]); setAnswers({}); } }}
              placeholder="Paste your prompt here..."
              rows={4}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground
                placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-2
                focus:ring-primary/40 transition-shadow"
            />

            {/* ─ Prompt settings ─ */}
            <PromptControls value={config} onChange={setConfig} />

            {/* ─ Media input ─ */}
            <div className="mt-3 space-y-2">
              {/* Image input */}
              <div className="flex items-center gap-2 flex-wrap">
                <label
                  htmlFor="image-upload"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border
                    text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50
                    transition-colors cursor-pointer"
                  data-testid="button-add-image"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  {media.imagePreview ? "Change image" : "Add image"}
                </label>
                <input
                  id="image-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      const dataUrl = ev.target?.result as string;
                      setMedia((m) => ({ ...m, imageFile: file, imagePreview: dataUrl }));
                    };
                    reader.readAsDataURL(file);
                  }}
                />
                <button
                  onClick={() => setShowVideoInput((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border
                    text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  data-testid="button-add-video"
                >
                  <Video className="w-3.5 h-3.5" />
                  {media.videoUrl ? "Change video URL" : "Add video URL"}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={generateImage}
                    onChange={(e) => setGenerateImage(e.target.checked)}
                    className="rounded border-border"
                    data-testid="checkbox-generate-image"
                  />
                  Generate image from result
                </label>
              </div>

              {/* Video URL input */}
              {showVideoInput && (
                <input
                  type="url"
                  value={media.videoUrl ?? ""}
                  onChange={(e) => setMedia((m) => ({ ...m, videoUrl: e.target.value }))}
                  placeholder="Paste video URL (YouTube, etc.)..."
                  data-testid="input-video-url"
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-xs
                    text-foreground placeholder:text-muted-foreground/50 focus:outline-none
                    focus:ring-2 focus:ring-primary/40 transition-shadow"
                />
              )}

              {/* Image preview */}
              {media.imagePreview && (
                <div className="relative inline-block">
                  <img
                    src={media.imagePreview}
                    alt="Input image"
                    className="h-20 w-auto rounded-md border border-border object-cover"
                  />
                  <button
                    onClick={() => setMedia((m) => ({ ...m, imageFile: undefined, imagePreview: undefined }))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted border border-border
                      flex items-center justify-center hover:bg-card transition-colors"
                    aria-label="Remove image"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Run Nodes button — only shown in input stage */}
        {stage === "input" && (
          <button
            onClick={handleRunNodes}
            disabled={questionsMutation.isPending || !prompt.trim()}
            data-testid="button-run-nodes"
            className="w-full py-2.5 rounded-lg font-display font-bold text-sm uppercase tracking-wider
              bg-primary text-primary-foreground hover:opacity-90 transition-opacity
              disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Zap className="w-4 h-4" />
            {questionsMutation.isPending ? "Reading signal..." : "Run Nodes"}
          </button>
        )}

        {/* Node pipeline — always visible once active */}
        {(isPending || stage === "processing" || stage === "done") && (
          <NodePipeline activeIndex={isPending ? activeNode : stage === "done" ? 4 : -1} />
        )}

        {/* Processing animation */}
        {(stage === "processing") && (
          <ProcessingDots activeIndex={activeNode} />
        )}

        {/* ── Stage: Questions ── */}
        {stage === "questions" && questions.length > 0 && (
          <div className="mt-5 space-y-3" data-testid="questions-section">
            {/* Divider with label */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs font-display font-bold uppercase tracking-wider text-muted-foreground px-2">
                Node Questions
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <p className="text-xs text-muted-foreground mb-4">
              You went from Feel to Do. These are the steps you skipped.
            </p>

            {questions.map((q, i) => (
              <QuestionCard
                key={q.id}
                questionId={q.id}
                node={q.node}
                question={q.question}
                type={q.type}
                options={questionOptions[q.id] ?? buildQuestionOptions(q.options ?? [])}
                textAnswer={answers[q.id] ?? ""}
                onChange={handleQuestionChange}
                index={i}
              />
            ))}

            {/* Finalize button */}
            <button
              onClick={handleFinalize}
              disabled={cleanupMutation.isPending}
              data-testid="button-finalize"
              className="w-full mt-4 py-2.5 rounded-lg font-display font-bold text-sm uppercase tracking-wider
                bg-primary text-primary-foreground hover:opacity-90 transition-opacity
                disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <ArrowRight className="w-4 h-4" />
              Finalize — Run Delta
            </button>
          </div>
        )}

        {/* Loading dots during question fetch */}
        {questionsMutation.isPending && (
          <div className="flex items-center justify-center gap-2 py-6">
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "120ms" }} />
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: "240ms" }} />
            <span className="ml-2 text-sm text-muted-foreground">Alpha reading signal...</span>
          </div>
        )}

        {/* ── Paywall gate ── */}
        {paywalled && (
          <div className="mt-4">
            <PaywallGate onUpgrade={handleUpgrade} />
          </div>
        )}

        {/* ── Stage: Done — Results ── */}
        {stage === "done" && result && (
          <div className="space-y-4 mt-2" data-testid="results-section">
            <PanelA result={result} />
            <PanelB result={result} />
            <PanelC result={result} />
            <NodeOutputs outputs={result.nodeOutputs} />
            <button
              onClick={handleReset}
              data-testid="button-new-cleanup"
              className="w-full py-2 rounded-lg border border-border text-sm text-muted-foreground
                hover:bg-muted/50 hover:text-foreground transition-colors font-display"
            >
              New Cleanup
            </button>
          </div>
        )}

        {/* History */}
        {stage !== "processing" && <HistoryPanel onSelect={handleHistorySelect} />}
      </main>

      <footer className="border-t border-border mt-12">
        <div className="max-w-[720px] mx-auto px-4 py-6 flex flex-col items-center gap-2">
          <p className="text-xs text-muted-foreground italic">signal in, signal out — noise filtered</p>
          <span className="text-xs text-muted-foreground/60">
            Funded by Friendship
          </span>
        </div>
      </footer>
    </div>
  );
}
