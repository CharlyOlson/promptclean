import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useLayoutEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";
import { PC_SEEN_WELCOME_KEY } from "@/lib/onboarding";

function needsWelcome(): boolean {
  try {
    return !localStorage.getItem(PC_SEEN_WELCOME_KEY);
  } catch {
    return false;
  }
}

function AppRouter() {
  const [location, navigate] = useLocation();

  useLayoutEffect(() => {
    if (needsWelcome() && location !== "/welcome") {
      navigate("/welcome");
    }
  }, [location, navigate]);

  if (needsWelcome() && location !== "/welcome") {
    return null;
  }

  return (
    <Switch>
      <Route path="/welcome" component={Welcome} />
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
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
