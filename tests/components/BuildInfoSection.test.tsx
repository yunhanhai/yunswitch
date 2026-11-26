import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuildInfoSection } from "@/components/settings/BuildInfoSection";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "sonner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { getBuildInfo: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const info = {
  version: "3.20.1-yunswitch.9",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  target: "x86_64-pc-windows-msvc",
};
const writeText = vi.fn();

describe("BuildInfoSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(settingsApi.getBuildInfo).mockResolvedValue(info);
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("displays the short source and copies only the allowed full metadata", async () => {
    vi.mocked(settingsApi.getBuildInfo).mockResolvedValue({
      ...info,
      unrelated: "must-not-be-copied",
    } as typeof info);
    render(<BuildInfoSection />);
    expect(
      await screen.findByText(info.sourceCommit.slice(0, 12)),
    ).toBeVisible();
    expect(screen.getByText(info.target)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.buildInfo.copy" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(info);
    expect(toast.success).toHaveBeenCalledWith("settings.buildInfo.copied");
  });

  it("keeps an unrecorded source explicitly unknown when displaying and copying", async () => {
    vi.mocked(settingsApi.getBuildInfo).mockResolvedValue({
      ...info,
      sourceCommit: null,
    });
    render(<BuildInfoSection />);
    expect(
      await screen.findByText("settings.buildInfo.sourceUnknown"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.buildInfo.copy" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0]).sourceCommit).toBeNull();
  });

  it("disables copy while loading and reports failure without exposing error details", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(settingsApi.getBuildInfo).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(<BuildInfoSection />);
    expect(
      screen.getByRole("button", { name: "settings.buildInfo.copy" }),
    ).toBeDisabled();
    reject(new Error("private-machine-path"));
    expect(
      await screen.findByText("settings.buildInfo.loadFailed"),
    ).toBeVisible();
    expect(screen.queryByText("private-machine-path")).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports a clipboard failure without claiming success", async () => {
    writeText.mockRejectedValue(new Error("clipboard unavailable"));
    render(<BuildInfoSection />);
    await screen.findByText(info.target);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.buildInfo.copy" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("settings.buildInfo.copyFailed"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
