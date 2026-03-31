import { Switch, Route, Router, useLocation } from "wouter";
// useHashLocation makes all URLs /#/-prefixed, which is required for Railway
// deployments where no server-side SPA fallback is configured. Do not switch to
// the default browser-history hook without also setting up server-side fallback.
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";
import { PC_SEEN_WELCOME_KEY } from "./lib/constants";

/**
 * Redirects first-time visitors to /welcome.
 * Once they dismiss it, localStorage "pc_seen_welcome" is set
 * and they land on / from then on.
 */
function FirstVisitGuard() {
  const [location, navigate] = useLocation();

  useEffect(() => {
    try {
      const seen = localStorage.getItem(PC_SEEN_WELCOME_KEY);
      if (!seen && location === "/") {
        navigate("/welcome", { replace: true });
      }
    } catch {
      // localStorage blocked (private browsing etc.) — just show Home
    }
  }, [location, navigate]);

  return null;
}

function AppRouter() {
  return (
    <>
      <FirstVisitGuard />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/welcome" component={Welcome} />
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
