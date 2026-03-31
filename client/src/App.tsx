import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";
import { useEffect } from "react";

function FirstVisitGuard() {
  const [, navigate] = useLocation();
  useEffect(() => {
    try {
      if (!localStorage.getItem("pc_seen_welcome")) {
        navigate("/welcome");
      }
    } catch {}
  }, [navigate]);
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
