import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, Sun, Moon, ChevronRight, Zap, ArrowRight } from "lucide-react";
import type { Cleanup, WeightedAnswer } from "@shared/schema";
import QuestionCard from "@/components/QuestionCard";
import type { OptionState, QuestionOption } from "@/components/QuestionCard";
import PromptControls, { type PromptConfig } from "@/components/PromptControls";
import PaywallBanner from "@/components/PaywallBanner";

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
  score: { specificity: number; context: number; constraints: number; outputDef: number; total: number };
  fixedPrompt: string;
  changeLog: string[];
  deltaComment: string;
  nodeOutputs: { alpha: string; beta: string; gamma: any; delta: any };
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

  const [prompt, setPrompt] = useState("");
  const [stage, setStage] = useState<Stage>("input");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [weightedState, setWeightedState] = useState<Record<string, OptionState[]>>({});
  const [questionOptions, setQuestionOptions] = useState<Record<string, QuestionOption[]>>({});
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [activeNode, setActiveNode] = useState(-1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [config, setConfig] = useState<PromptConfig>({
    promptType: "general",
    model: "gpt-4o",
    length: "medium",
  });

  // ── Step 1: fetch questions ─────────────────────────────────────────────────
  const questionsMutation = useMutation({
    mutationFn: async (rawPrompt: string) => {
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
      const res = await apiRequest("POST", "/api/cleanup", { prompt: rawPrompt, answers: ans, weightedAnswers });
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
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
    },
    onError: (err: Error) => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setActiveNode(-1);
      setStage("questions");
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleRunNodes = () => {
    if (!prompt.trim()) return;
    setStage("input"); // reset
    const enriched =
      `${prompt.trim()}\n\n` +
      `[Prompt type: ${config.promptType} | Target model: ${config.model} | Output length: ${config.length}]`;
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
          <div className="flex items-center gap-2">
            <a
              href="#/welcome"
              className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors px-2 py-1"
              aria-label="How to use PromptClean"
            >
              Help
            </a>
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

        {/* ── Stage: Done — Results ── */}
        {stage === "done" && result && (
          <div className="space-y-4 mt-2" data-testid="results-section">
            <FixedPromptBlock prompt={result.fixedPrompt} />
            <SignalScore score={result.score} />
            <ChangeLog items={result.changeLog} comment={result.deltaComment} />
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
          <a
            href="https://www.perplexity.ai/computer"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            Created with Perplexity Computer
          </a>
        </div>
      </footer>
    </div>
  );
}
