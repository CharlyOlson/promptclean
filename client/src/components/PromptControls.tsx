/**
 * PromptControls.tsx
 *
 * Three selector strips that sit above the prompt input:
 *   1. Prompt Type  — what the user wants the AI to produce
 *   2. GPT Model    — which AI they will paste the result into
 *   3. Output Length — short / medium / long
 *
 * Usage in Home.tsx:
 *
 *   import PromptControls, { type PromptConfig } from "@/components/PromptControls";
 *
 *   const [config, setConfig] = useState<PromptConfig>({
 *     promptType: "general",
 *     model: "gpt-4o",
 *     length: "medium",
 *   });
 *
 *   // Above the textarea:
 *   <PromptControls value={config} onChange={setConfig} />
 *
 * The config is then appended to the user's raw prompt string before it's
 * sent to /api/questions, so Gemini can factor in the target model and
 * desired output length when generating cleanup questions.
 *
 * Append pattern (in Home.tsx handleRunNodes):
 *
 *   const enriched =
 *     `${prompt.trim()}\n\n` +
 *     `[Prompt type: ${config.promptType} | Target model: ${config.model} | Output length: ${config.length}]`;
 *   // send `enriched` instead of `prompt`
 */

export interface PromptConfig {
  promptType: string;
  model: string;
  length: "short" | "medium" | "long";
}

const PROMPT_TYPES = [
  { id: "general",    label: "General" },
  { id: "code",       label: "Code" },
  { id: "writing",    label: "Writing" },
  { id: "research",   label: "Research" },
  { id: "brainstorm", label: "Brainstorm" },
  { id: "summarize",  label: "Summarize" },
  { id: "email",      label: "Email" },
  { id: "image",      label: "Image" },
];

const MODELS = [
  { id: "gpt-4o",           label: "GPT-4o" },
  { id: "gpt-4-turbo",      label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo",    label: "GPT-3.5" },
  { id: "claude-3-5",       label: "Claude 3.5" },
  { id: "claude-3-opus",    label: "Claude Opus" },
  { id: "gemini-2-5-flash", label: "Gemini 2.5" },
  { id: "gemini-pro",       label: "Gemini Pro" },
  { id: "llama-3",          label: "Llama 3" },
  { id: "mistral",          label: "Mistral" },
  { id: "perplexity",       label: "Perplexity" },
];

const LENGTHS: { id: PromptConfig["length"]; label: string; desc: string }[] = [
  { id: "short",  label: "Short",  desc: "~100 words" },
  { id: "medium", label: "Medium", desc: "~300 words" },
  { id: "long",   label: "Long",   desc: "~600+ words" },
];

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function Chip({ label, active, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150
        ${active
          ? "bg-primary text-primary-foreground border-primary shadow-sm"
          : "bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
        }`}
    >
      {label}
    </button>
  );
}

interface SectionProps {
  label: string;
  children: any;
}

function ControlSection({ label, children }: SectionProps) {
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      <span className="block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

interface Props {
  value: PromptConfig;
  onChange: (next: PromptConfig) => void;
}

export default function PromptControls({ value, onChange }: Props) {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-4 py-3 space-y-3 mb-3">
      {/* Row 1 — Prompt Type */}
      <ControlSection label="Prompt Type">
        {PROMPT_TYPES.map((t) => (
          <Chip
            key={t.id}
            label={t.label}
            active={value.promptType === t.id}
            onClick={() => onChange({ ...value, promptType: t.id })}
          />
        ))}
      </ControlSection>

      {/* Row 2 — Target Model */}
      <ControlSection label="Target Model">
        {MODELS.map((m) => (
          <Chip
            key={m.id}
            label={m.label}
            active={value.model === m.id}
            onClick={() => onChange({ ...value, model: m.id })}
          />
        ))}
      </ControlSection>

      {/* Row 3 — Output Length */}
      <ControlSection label="Output Length">
        {LENGTHS.map((l) => {
          const isActive = value.length === l.id;
          // Bar heights: short = all short, medium = tall middle, long = ascending
          let bar1H = "h-1.5";
          let bar2H = "h-1.5";
          let bar3H = "h-1.5";
          if (l.id === "medium") {
            bar2H = "h-3.5";
          } else if (l.id === "long") {
            bar2H = "h-3.5";
            bar3H = "h-5";
          }
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange({ ...value, length: l.id })}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border
                transition-all duration-150
                ${isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                }`}
            >
              {/* Length bars visual */}
              <span className="flex items-end gap-0.5">
                <span className={`w-0.5 rounded-full ${bar1H} ${isActive ? "bg-primary-foreground" : "bg-muted-foreground/60"}`} />
                <span className={`w-0.5 rounded-full ${bar2H} ${isActive ? "bg-primary-foreground" : "bg-muted-foreground/40"}`} />
                <span className={`w-0.5 rounded-full ${bar3H} ${isActive ? "bg-primary-foreground" : "bg-muted-foreground/20"}`} />
              </span>
              <span>{l.label}</span>
              <span className={`text-[9px] ${isActive ? "text-primary-foreground/70" : "text-muted-foreground/50"}`}>
                {l.desc}
              </span>
            </button>
          );
        })}
      </ControlSection>
    </div>
  );
}
