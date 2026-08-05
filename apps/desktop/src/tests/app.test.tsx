import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";

describe("desktop workspace surface", () => {
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
});
