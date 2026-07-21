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
  });

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
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
