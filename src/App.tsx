import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { AppChrome } from "./app/AppChrome";
import { ShellProvider, useShell } from "./app/ShellProvider";
import { DirectorLayout } from "./layouts/director/DirectorLayout";
import { EditorLayout } from "./layouts/editor/EditorLayout";
import { HookLayout } from "./layouts/hook/HookLayout";
import { WipOverlay } from "./ui/WipOverlay";
import "./styles.css";

function LayoutRouter() {
  const { mode } = useShell();
  if (mode === "editor") return <EditorLayout />;
  if (mode === "hook") return <HookLayout />;
  return <DirectorLayout />;
}

function Root() {
  const { status, session } = useAuth();

  if (status === "reconnecting") {
    return (
      <div className="login-screen">
        <p className="muted">Starting…</p>
      </div>
    );
  }

  if (!session || status === "signed_out" || status === "connecting") {
    return <LoginScreen />;
  }

  return (
    <ShellProvider>
      <AppChrome>
        <LayoutRouter />
      </AppChrome>
    </ShellProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WipOverlay />
      <Root />
    </AuthProvider>
  );
}
