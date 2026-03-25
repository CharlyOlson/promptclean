import { useState, useCallback, useEffect } from "react";
import { Slider } from "@/components/ui/slider";

// ── Public types ──────────────────────────────────────────────────────────────
export type NodeType = "alpha" | "beta" | "gamma";

export interface QuestionOption {
  id: string;
  text: string;
  isCustom?: boolean;
}

export interface OptionState extends QuestionOption {
  selected: boolean;
  weight: number;
  customText: string; // populated only for isCustom options, empty string otherwise
}

interface Props {
  questionId: string;
  node: NodeType;
  question: string;
  /** Question type — determines the input mode */
  type: "choice" | "text" | "weighted-choice";
  options: QuestionOption[];
  /** Current plain-text answer (used for "choice" and "text" types) */
  textAnswer?: string;
  /** Fired for every answer change */
  onChange: (questionId: string, answer: { selected: OptionState[]; text: string }) => void;
  /** Animation stagger index */
  index?: number;
}

// ── Node colours ──────────────────────────────────────────────────────────────
const NODE_COLORS: Record<NodeType, string> = {
  alpha: "hsl(174 100% 38%)",
  beta:  "hsl(174 80% 44%)",
  gamma: "hsl(38 85% 52%)",
};

const DEFAULT_WEIGHT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────
function initState(options: QuestionOption[]): OptionState[] {
  return options.map((o) => ({
    ...o,
    selected: false,
    weight: 0,
    customText: "",
  }));
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function QuestionCard({
  questionId,
  node,
  question,
  type,
  options,
  textAnswer = "",
  onChange,
  index = 0,
}: Props) {
  const [optionStates, setOptionStates] = useState<OptionState[]>(() =>
    initState(options),
  );

  // Re-initialise when the options list identity changes (new question set)
  useEffect(() => {
    setOptionStates(initState(options));
  }, [options]);

  const color = NODE_COLORS[node];
  const nodeLabel = node.charAt(0).toUpperCase() + node.slice(1);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const emit = useCallback(
    (next: OptionState[], text?: string) => {
      onChange(questionId, { selected: next, text: text ?? textAnswer });
    },
    [onChange, questionId, textAnswer],
  );

  const toggle = useCallback(
    (id: string) => {
      setOptionStates((prev) => {
        const next = prev.map((o) =>
          o.id === id
            ? { ...o, selected: !o.selected, weight: !o.selected ? DEFAULT_WEIGHT : 0 }
            : o,
        );
        emit(next);
        return next;
      });
    },
    [emit],
  );

  const setWeight = useCallback(
    (id: string, weight: number) => {
      setOptionStates((prev) => {
        const next = prev.map((o) => (o.id === id ? { ...o, weight } : o));
        emit(next);
        return next;
      });
    },
    [emit],
  );

  const handleCustomText = useCallback(
    (id: string, text: string) => {
      setOptionStates((prev) => {
        const hasText = text.trim().length > 0;
        const next = prev.map((o) =>
          o.id === id
            ? {
                ...o,
                customText: text,
                text: text,
                selected: hasText,
                weight: hasText ? (o.weight || DEFAULT_WEIGHT) : 0,
              }
            : o,
        );
        emit(next);
        return next;
      });
    },
    [emit],
  );

  const handleTextInput = useCallback(
    (value: string) => {
      onChange(questionId, { selected: optionStates, text: value });
    },
    [onChange, questionId, optionStates],
  );

  const handleChoiceClick = useCallback(
    (optText: string) => {
      onChange(questionId, { selected: optionStates, text: optText });
    },
    [onChange, questionId, optionStates],
  );

  const selectedCount = optionStates.filter((o) => o.selected).length;
  const totalWeight = optionStates
    .filter((o) => o.selected)
    .reduce((sum, o) => sum + o.weight, 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="rounded-lg border border-border bg-card p-4 space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ animationDelay: `${index * 80}ms` }}
      data-testid={`question-card-${questionId}`}
    >
      {/* Node badge + question text */}
      <div className="flex items-start gap-3">
        <span
          className="text-[10px] font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 mt-0.5"
          style={{ color, backgroundColor: `${color}18` }}
        >
          {nodeLabel}
        </span>
        <p className="text-sm text-foreground leading-snug">{question}</p>
      </div>

      {/* ── Weighted multi-select ── */}
      {type === "weighted-choice" && (
        <div className="space-y-2 pl-[52px]">
          {optionStates.map((opt) => (
            <div
              key={opt.id}
              data-testid={`weighted-option-${opt.id}`}
              className={`
                flex flex-col gap-2 rounded-md border px-3 py-2.5 transition-all duration-150
                ${opt.selected
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary/50 hover:bg-primary/5"
                }
              `}
            >
              {/* Toggle row */}
              <button
                type="button"
                onClick={() => !opt.isCustom && toggle(opt.id)}
                className="flex items-center gap-2 w-full text-left"
                data-testid={`toggle-option-${opt.id}`}
              >
                <span
                  className={`
                    inline-flex items-center justify-center w-4 h-4 rounded-sm border text-[10px] font-bold shrink-0 transition-colors
                    ${opt.selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40 text-transparent"
                    }
                  `}
                >
                  ✓
                </span>

                {opt.isCustom ? (
                  <input
                    type="text"
                    value={opt.customText}
                    onChange={(e) => handleCustomText(opt.id, e.target.value)}
                    placeholder="Type your own answer…"
                    data-testid={`custom-option-input-${opt.id}`}
                    className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/50
                      focus:outline-none border-b border-dashed border-muted-foreground/30
                      focus:border-primary/60 transition-colors py-0.5"
                  />
                ) : (
                  <span className="text-sm text-foreground">{opt.text}</span>
                )}
              </button>

              {/* Weight slider — visible when selected */}
              {opt.selected && (
                <div className="flex items-center gap-3 pl-6 animate-in fade-in slide-in-from-top-1 duration-200">
                  <span className="text-[10px] font-display uppercase tracking-wider text-muted-foreground w-12 shrink-0">
                    Weight
                  </span>
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    value={[opt.weight]}
                    onValueChange={([v]) => setWeight(opt.id, v)}
                    className="flex-1"
                    data-testid={`slider-${opt.id}`}
                  />
                  <span
                    className="text-xs font-mono font-semibold w-8 text-right tabular-nums"
                    style={{ color }}
                    data-testid={`weight-value-${opt.id}`}
                  >
                    {opt.weight}
                  </span>
                </div>
              )}
            </div>
          ))}

          {/* Summary bar */}
          {selectedCount > 0 && (
            <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 px-1">
              <span>{selectedCount} selected</span>
              <span className="font-mono tabular-nums">Σ {totalWeight}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Single-choice buttons ── */}
      {type === "choice" && options.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-[52px]">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleChoiceClick(opt.text)}
              data-testid={`choice-${questionId}-${opt.text}`}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all duration-150 ${
                textAnswer === opt.text
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-background hover:border-primary/50 hover:bg-primary/5 text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.text}
            </button>
          ))}
        </div>
      )}

      {/* ── Free-text input ── */}
      {type === "text" && (
        <input
          type="text"
          value={textAnswer}
          onChange={(e) => handleTextInput(e.target.value)}
          placeholder="Type your answer..."
          data-testid={`input-${questionId}`}
          className="w-full ml-[52px] rounded-md border border-border bg-background px-3 py-2 text-sm
            placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40
            transition-shadow"
          style={{ width: "calc(100% - 52px)" }}
        />
      )}
    </div>
  );
}
