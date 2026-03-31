import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";
import { PC_SEEN_WELCOME_KEY } from "./constants";

/**
 * Guards the root route: first-time visitors go to /welcome.
 * After Welcome sets PC_SEEN_WELCOME_KEY in localStorage, / renders Home directly.
 */
function RootGate() {
  const [location, navigate] = useLocation();

  let shouldRedirect = false;
  try {
    shouldRedirect =
      location === "/" && !localStorage.getItem(PC_SEEN_WELCOME_KEY);
  } catch {
    // If storage is blocked, don't force welcome.
    shouldRedirect = false;
  }

  useEffect(() => {
    if (shouldRedirect) {
      // true = replace; avoids back-button loop into welcome
      navigate("/welcome", true);
    }
  }, [shouldRedirect, navigate]);

  if (shouldRedirect) return null;

  return <Home />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={RootGate} />
      <Route path="/welcome" component={Welcome} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {/*
          Hash routing is intentional.
          This deploy target doesn’t guarantee server-side SPA fallback
          for deep links, so useHashLocation avoids refresh/direct-link 404s.
        */}
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
