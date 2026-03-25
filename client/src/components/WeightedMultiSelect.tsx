import { useState, useCallback } from "react";
import type { Option, OptionId } from "@shared/schema";
import { Slider } from "@/components/ui/slider";

/** Default weight assigned when an option is first selected */
const DEFAULT_WEIGHT = 50;

// ── Props ─────────────────────────────────────────────────────────────────────
interface WeightedMultiSelectProps {
  /** Pre-built option list (from the question's `options` field) */
  options: Option[];
  /** Called whenever selection or weights change */
  onChange: (options: Option[]) => void;
  /** Accent colour for the node badge (optional) */
  accentColor?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function WeightedMultiSelect({
  options,
  onChange,
  accentColor,
}: WeightedMultiSelectProps) {
  const [customText, setCustomText] = useState("");

  const toggle = useCallback(
    (id: OptionId) => {
      const next = options.map((o) =>
        o.id === id ? { ...o, selected: !o.selected, weight: !o.selected ? DEFAULT_WEIGHT : 0 } : o,
      );
      onChange(next);
    },
    [options, onChange],
  );

  const setWeight = useCallback(
    (id: OptionId, weight: number) => {
      const next = options.map((o) => (o.id === id ? { ...o, weight } : o));
      onChange(next);
    },
    [options, onChange],
  );

  const handleCustomTextChange = useCallback(
    (text: string) => {
      setCustomText(text);
      const hasText = text.trim().length > 0;
      const next = options.map((o) =>
        o.isCustom ? { ...o, text, selected: hasText, weight: hasText ? (o.weight || DEFAULT_WEIGHT) : 0 } : o,
      );
      onChange(next);
    },
    [options, onChange],
  );

  const selectedCount = options.filter((o) => o.selected).length;
  const totalWeight = options
    .filter((o) => o.selected)
    .reduce((sum, o) => sum + o.weight, 0);

  return (
    <div className="space-y-2 pl-[52px]">
      {options.map((opt) => (
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
          {/* Top row: checkbox + label */}
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
                value={customText}
                onChange={(e) => handleCustomTextChange(e.target.value)}
                placeholder="Type your own answer…"
                data-testid="custom-option-input"
                className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/50
                  focus:outline-none border-b border-dashed border-muted-foreground/30
                  focus:border-primary/60 transition-colors py-0.5"
              />
            ) : (
              <span className="text-sm text-foreground">
                <span
                  className="font-display font-bold text-xs mr-1.5"
                  style={{ color: accentColor }}
                >
                  {opt.label}
                </span>
                {opt.text}
              </span>
            )}
          </button>

          {/* Weight slider — only visible when selected */}
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
                style={{ color: accentColor ?? "hsl(var(--primary))" }}
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
          <span>
            {selectedCount} selected
          </span>
          <span className="font-mono tabular-nums">
            Σ {totalWeight}
          </span>
        </div>
      )}
    </div>
  );
}
