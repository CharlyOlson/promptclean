import { Switch, Route, Router, useLocation } from "wouter";
// useHashLocation: required for Railway (no server-side SPA fallback).
// Switching to browser routing would need a catch-all redirect on the server.
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";
import Login from "@/pages/Login";
import { useAuth } from "@/hooks/use-auth";
import { PC_SEEN_WELCOME_KEY } from "./lib/constants";

/**
 * Guards the root route: unauthenticated visitors go to /login.
 * First-time authenticated visitors go to /welcome.
 * After Welcome sets PC_SEEN_WELCOME_KEY in localStorage, / renders Home directly.
 */
function FirstVisitGuard() {
  const [location, navigate] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();

  let shouldRedirectToWelcome = false;
  try {
    shouldRedirectToWelcome =
      location === "/" && !localStorage.getItem(PC_SEEN_WELCOME_KEY);
  } catch {
    shouldRedirectToWelcome = false;
  }

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
    } else if (shouldRedirectToWelcome) {
      navigate("/welcome", { replace: true });
    }
  }, [isLoading, isAuthenticated, shouldRedirectToWelcome, navigate]);

  if (isLoading || !isAuthenticated || shouldRedirectToWelcome) return null;

  return <Home />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {/*
          Hash routing is intentional.
          This deploy target does not guarantee server-side SPA fallback
          for deep links, so useHashLocation avoids refresh/direct-link 404s.
        */}
        <Router hook={useHashLocation}>
          <Switch>
            <Route path="/" component={FirstVisitGuard} />
            <Route path="/login" component={Login} />
            <Route path="/welcome" component={Welcome} />
            <Route component={NotFound} />
          </Switch>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;