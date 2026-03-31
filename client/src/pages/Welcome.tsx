import { useLocation } from "wouter";
import { PC_SEEN_WELCOME_KEY } from "@/lib/constants";

export default function Welcome() {
  const [, navigate] = useLocation();

  function handleDismiss() {
    try {
      localStorage.setItem(PC_SEEN_WELCOME_KEY, "1");
    } catch {
      // localStorage blocked — continue anyway
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-3xl font-bold mb-4">Welcome to PromptClean</h1>
      <p className="text-muted-foreground mb-8 max-w-md">
        Clean, refine, and optimize your prompts for any AI model.
      </p>
      <button
        onClick={handleDismiss}
        className="bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity"
      >
        Let&apos;s go →
      </button>
    </div>
  );
}
