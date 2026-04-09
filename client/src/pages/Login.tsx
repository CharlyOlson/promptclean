/**
 * Login.tsx
 *
 * Simple login / registration page.
 * Users can sign in with a username and password, or create a new account.
 * Once authenticated, navigates to "/".
 */

import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

export default function Login() {
  const [, navigate] = useLocation();
  const { login, register, isLoggingIn, isRegistering, loginError, registerError } = useAuth();

  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");

    if (!username.trim() || !password) {
      setLocalError("Please enter both username and password");
      return;
    }

    try {
      if (isRegisterMode) {
        await register({ username: username.trim(), password });
      } else {
        await login({ username: username.trim(), password });
      }
      navigate("/", { replace: true });
    } catch (err: any) {
      // Extract message from API error response
      const msg = err?.message ?? "Something went wrong";
      // The error message from apiRequest is "status: body"
      const match = msg.match(/^\d+:\s*(.+)/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          setLocalError(parsed.message || msg);
        } catch {
          setLocalError(match[1]);
        }
      } else {
        setLocalError(msg);
      }
    }
  };

  const isPending = isLoggingIn || isRegistering;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <svg
            width="48"
            height="48"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
            className="mb-4"
          >
            <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
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
          <h1 className="font-display text-2xl font-bold tracking-tight">PromptClean</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isRegisterMode ? "Create your account" : "Sign in to continue"}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="username"
              className="block text-xs font-bold uppercase tracking-widest text-muted-foreground/70"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground
                placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2
                focus:ring-primary/40 transition-shadow"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-xs font-bold uppercase tracking-widest text-muted-foreground/70"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={isRegisterMode ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground
                placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2
                focus:ring-primary/40 transition-shadow"
            />
          </div>

          {localError && (
            <p className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {localError}
            </p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full py-2.5 rounded-lg font-display font-bold text-sm uppercase tracking-wider
              bg-primary text-primary-foreground hover:opacity-90 transition-opacity
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending
              ? "Please wait..."
              : isRegisterMode
                ? "Create Account"
                : "Sign In"}
          </button>
        </form>

        {/* Toggle mode */}
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => {
              setIsRegisterMode((m) => !m);
              setLocalError("");
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {isRegisterMode
              ? "Already have an account? Sign in"
              : "Don't have an account? Register"}
          </button>
        </div>

        <p className="mt-8 text-center text-[10px] text-muted-foreground/50">
          Funded by Friendship
        </p>
      </div>
    </div>
  );
}
