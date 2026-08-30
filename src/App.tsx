import { useState } from "react";
import { AuthProvider, useAuthOptional } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { ReauthOverlay } from "./auth/ReauthOverlay";
import { AppChrome } from "./app/AppChrome";
import { ShellProvider, useShell } from "./app/ShellProvider";
import { DirectorLayout } from "./layouts/director/DirectorLayout";
import { EditorLayout } from "./layouts/editor/EditorLayout";
import { HookLayout } from "./layouts/hook/HookLayout";
import { LabLayout } from "./layouts/lab/LabLayout";
import { LibraryView } from "./library/LibraryView";
import { ProjectWelcome } from "./project/ProjectWelcome";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import { Wordmark } from "./ui/Wordmark";
import "./styles.css";

function LayoutRouter() {
  const { primaryTab, mode, openProjectId } = useShell();
  // Lab mounts media/waveform UIs (esp. MV Scenes). Fully unmounting that tree
  // when switching tabs beachballs WebKit — keep it alive once opened.
  const [labMountedForProject, setLabMountedForProject] = useState<
    string | null
  >(null);
  if (openProjectId && mode === "lab" && labMountedForProject !== openProjectId) {
    setLabMountedForProject(openProjectId);
  }
  if (!openProjectId && labMountedForProject !== null) {
    setLabMountedForProject(null);
  }

  const labActive =
    primaryTab === "project" && Boolean(openProjectId) && mode === "lab";
  const keepLab =
    Boolean(openProjectId) && labMountedForProject === openProjectId;

  let main: React.ReactNode = null;
  if (primaryTab === "library") {
    main = <LibraryView />;
  } else if (!openProjectId) {
    main = <ProjectWelcome />;
  } else if (mode === "editor") {
    main = <EditorLayout />;
  } else if (mode === "hook") {
    main = <HookLayout />;
  } else if (mode === "lab") {
    main = null;
  } else {
    main = <DirectorLayout />;
  }

  return (
    <>
      {main}
      {keepLab ? (
        <div
          className="layout-keep-alive"
          hidden={!labActive}
          aria-hidden={!labActive}
        >
          <LabLayout active={labActive} />
        </div>
      ) : null}
    </>
  );
}

function Root() {
  const auth = useAuthOptional();
  const status = auth?.status ?? "reconnecting";
  const session = auth?.session ?? null;

  if (status === "reconnecting") {
    return (
      <div className="login-screen">
        <div className="login-card">
          <Wordmark />
          <p className="login-copy">Starting Parascene…</p>
        </div>
      </div>
    );
  }

  if (!session || status === "signed_out" || status === "connecting") {
    return <LoginScreen />;
  }

  return (
    <ShellProvider>
      <ReauthOverlay />
      <AppChrome>
        <LayoutRouter />
      </AppChrome>
    </ShellProvider>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
