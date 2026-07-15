import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { AppChrome } from "./app/AppChrome";
import { ShellProvider, useShell } from "./app/ShellProvider";
import { DirectorLayout } from "./layouts/director/DirectorLayout";
import { EditorLayout } from "./layouts/editor/EditorLayout";
import { HookLayout } from "./layouts/hook/HookLayout";
import { LibraryView } from "./library/LibraryView";
import { ProjectWelcome } from "./project/ProjectWelcome";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { WipOverlay } from "./ui/WipOverlay";
import "./styles.css";

function LayoutRouter() {
  const { primaryTab, mode, openProjectId } = useShell();

  if (primaryTab === "library") {
    return <LibraryView />;
  }

  if (!openProjectId) {
    return <ProjectWelcome />;
  }

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
      <ConfirmProvider>
        <WipOverlay />
        <AppChrome>
          <LayoutRouter />
        </AppChrome>
      </ConfirmProvider>
    </ShellProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
