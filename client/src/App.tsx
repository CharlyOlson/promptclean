import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";

/**
 * Redirects first-time visitors to /welcome.
 * Once they dismiss it, localStorage "pc_seen_welcome" is set
 * and they land on / from then on.
 */
function FirstVisitGuard() {
  const [location, navigate] = useLocation();

  useEffect(() => {
    try {
      const seen = localStorage.getItem("pc_seen_welcome");
      if (!seen && location === "/") {
        navigate("/welcome");
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
