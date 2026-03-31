export interface PromptConfig {
  promptType: "general" | "coding" | "creative" | "analysis";
  model: "gpt-4o" | "gpt-4o-mini" | "claude-3-5-sonnet" | "gemini-2.5-flash";
  length: "short" | "medium" | "long";
}

interface Props {
  value: PromptConfig;
  onChange: (v: PromptConfig) => void;
}

const PROMPT_TYPES: { value: PromptConfig["promptType"]; label: string }[] = [
  { value: "general",  label: "General" },
  { value: "coding",   label: "Coding" },
  { value: "creative", label: "Creative" },
  { value: "analysis", label: "Analysis" },
];

const MODELS: { value: PromptConfig["model"]; label: string }[] = [
  { value: "gpt-4o",            label: "GPT-4o" },
  { value: "gpt-4o-mini",       label: "GPT-4o mini" },
  { value: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
  { value: "gemini-2.5-flash",  label: "Gemini 2.5 Flash" },
];

const LENGTHS: { value: PromptConfig["length"]; label: string }[] = [
  { value: "short",  label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long",   label: "Long" },
];

export default function PromptControls({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2 mt-2" data-testid="prompt-controls">
      <select
        value={value.promptType}
        onChange={(e) => onChange({ ...value, promptType: e.target.value as PromptConfig["promptType"] })}
        aria-label="Prompt type"
        className="flex-1 min-w-[110px] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs
          text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
      >
        {PROMPT_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      <select
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value as PromptConfig["model"] })}
        aria-label="Target model"
        className="flex-1 min-w-[140px] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs
          text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>

      <select
        value={value.length}
        onChange={(e) => onChange({ ...value, length: e.target.value as PromptConfig["length"] })}
        aria-label="Output length"
        className="flex-1 min-w-[90px] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs
          text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
      >
        {LENGTHS.map((l) => (
          <option key={l.value} value={l.value}>{l.label}</option>
        ))}
      </select>
    </div>
  );
}
