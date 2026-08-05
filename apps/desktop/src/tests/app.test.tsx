import { beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";

describe("desktop workspace surface", () => {
  beforeEach(() => window.localStorage.clear());
  it("keeps six workspaces reachable and exposes the DICOM selection controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Design" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "DICOM" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "DICOM" }));
    expect(screen.getByRole("heading", { name: "DICOM" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Print orientation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create print selection" })).toBeInTheDocument();
  });

  it("changes DICOM orientation and creates a deterministic selection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "DICOM" }));
    await user.click(within(screen.getByRole("group", { name: "Print orientation" })).getByRole("button", { name: "Sagittal" }));
    expect(screen.getByRole("button", { name: "sagittal synthetic CT slice" })).toHaveClass("selected");
    await user.click(screen.getByTestId("create-print-selection"));
    expect(await screen.findByText(/Print selection created/)).toBeInTheDocument();
  });

  it("supports keyboard nudging, undo and safe transform drafts", async () => {
    const user = userEvent.setup();
    render(<App />);
    const viewport = screen.getByTestId("design-scene-viewport");
    const positionX = screen.getByLabelText("Position x") as HTMLInputElement;
    expect(positionX).toHaveValue("0");

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(positionX).toHaveValue("0.5");
    await user.click(screen.getByRole("button", { name: "Undo scene edit" }));
    expect(positionX).toHaveValue("0");
    await user.click(screen.getByRole("button", { name: "Redo scene edit" }));
    expect(positionX).toHaveValue("0.5");

    fireEvent.keyDown(viewport, { key: "e" });
    expect(screen.getByRole("button", { name: "Rotate selection" })).toHaveAttribute("aria-pressed", "true");
    const sizeX = screen.getByLabelText("Size x") as HTMLInputElement;
    await user.clear(sizeX);
    await user.type(sizeX, "-");
    await user.tab();
    expect(sizeX).toHaveValue("190");
  });

  it("locks physical DICOM geometry against scene transforms", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("scene-row-scene-lung-volume"));
    expect(screen.getByRole("button", { name: "Move selection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rotate selection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Scale selection" })).toBeDisabled();
    expect(screen.getByText("Source geometry locked")).toBeInTheDocument();
  });
});
