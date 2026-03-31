import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";

function FirstRunGuard({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  useEffect(() => {
    if (location === "/") {
      try {
        if (!localStorage.getItem("pc_seen_welcome")) {
          navigate("/welcome");
        }
      } catch {}
    }
  }, [location, navigate]);
  return <>{children}</>;
}

function AppRouter() {
  return (
    <FirstRunGuard>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/welcome" component={Welcome} />
        <Route component={NotFound} />
      </Switch>
    </FirstRunGuard>
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
