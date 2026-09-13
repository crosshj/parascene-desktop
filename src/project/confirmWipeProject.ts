import type { ConfirmOptions } from "../ui/ConfirmDialog";

export function wipeProjectConfirmOptions(opts: {
  id: string;
  title: string;
  deleteProject: (
    id: string,
    options?: { onProgress?: (message: string) => void },
  ) => Promise<boolean>;
  onBusy?: (busy: boolean) => void;
}): ConfirmOptions {
  const label = opts.title.trim() || "Untitled project";
  return {
    title: `Delete “${label}”?`,
    message:
      "This deletes the project and every still, clip, and file in it — on this computer and on Parascene. This cannot be undone.",
    confirmLabel: "Delete project",
    danger: true,
    errorTitle: "Could not delete project",
    onConfirm: async ({ setMessage }) => {
      opts.onBusy?.(true);
      try {
        setMessage("Looking up files on Parascene…");
        await opts.deleteProject(opts.id, { onProgress: setMessage });
      } finally {
        opts.onBusy?.(false);
      }
    },
  };
}
