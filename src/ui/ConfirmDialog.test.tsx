import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

function Probe({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        void confirm({
          title: "Delete locally?",
          message: "This removes the local catalog row.",
          confirmLabel: "Delete locally",
          danger: true,
        }).then(onResult);
      }}
    >
      Ask
    </button>
  );
}

describe("ConfirmDialog", () => {
  it("resolves true on confirm and false on cancel", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Probe onResult={onResult} />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete locally?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Delete locally" }));
    expect(onResult).toHaveBeenCalledWith(true);
  }, 15_000);

  it("can show only an OK button for alerts", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();

    function AlertProbe() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            void confirm({
              title: "Asset in use",
              message: "Remove clips first.",
              confirmLabel: "OK",
              hideCancel: true,
            }).then(onResult);
          }}
        >
          Warn
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <AlertProbe />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Warn" }));
    expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("stays open and shows activity while onConfirm runs", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    let resolveWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    function BusyProbe() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            void confirm({
              title: "Delete from group?",
              message: "This will update Parascene.",
              confirmLabel: "Delete from group",
              danger: true,
              onConfirm: async ({ setMessage }) => {
                setMessage("Ungrouping…");
                await work;
              },
            }).then(onResult);
          }}
        >
          Delete
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <BusyProbe />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete from group" }));

    expect(screen.getByText("Ungrouping…")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    resolveWork?.();
    await vi.waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(true);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("stays open with the error when onConfirm throws", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();

    function FailProbe() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            void confirm({
              title: "Delete “Trip”?",
              message: "This deletes the project and its files.",
              confirmLabel: "Delete project",
              danger: true,
              errorTitle: "Could not delete project",
              onConfirm: async () => {
                throw new Error("Parascene still lists 2 files in this project.");
              },
            }).then(onResult);
          }}
        >
          Ask
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <FailProbe />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Delete project" }));
    expect(
      await screen.findByText("Could not delete project"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Parascene still lists 2 files in this project."),
    ).toBeInTheDocument();
    expect(onResult).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it("shows occupancy stats and generate/cancel", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();

    function OccupancyProbe() {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            void confirm({
              title: "This server is busy",
              message: "You'll be next. About 12 min until generating starts.",
              confirmLabel: "Generate",
              cancelLabel: "Cancel",
              dialogClassName: "occupancy-dialog",
              stats: [
                { label: "Now running", value: "Video · wan" },
                { label: "Credits", value: "1" },
              ],
            }).then(onResult);
          }}
        >
          Ask
        </button>
      );
    }

    render(
      <ConfirmProvider>
        <OccupancyProbe />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveClass("occupancy-dialog");
    expect(screen.getByText("Video · wan")).toBeInTheDocument();
    expect(screen.getByText("Credits")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
