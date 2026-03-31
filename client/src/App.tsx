import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Welcome from "@/pages/Welcome";

function RootGate() {
  const [location, navigate] = useLocation();

  let shouldRedirect = false;
  try {
    shouldRedirect =
      location === "/" && !localStorage.getItem("pc_seen_welcome");
  } catch {
    shouldRedirect = location === "/";
  }

  useEffect(() => {
    if (shouldRedirect) {
      // true = replace, avoids back-button loop
      navigate("/welcome", true);
    }
  }, [shouldRedirect, navigate]);

  if (shouldRedirect) return null;

  return <Home />;
}

function AppRouter({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <Switch>
        <Route path="/" component={RootGate} />
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
