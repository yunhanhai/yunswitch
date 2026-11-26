import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { SharedChannelLinkModal } from "@/components/universal/SharedChannelLinkModal";
import { universalProvidersApi } from "@/lib/api";
import type {
  SharedChannelLinkCandidates,
  SharedChannelLinkPreview,
  SharedChannelLinkResult,
} from "@/types";

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    children,
    footer,
    onClose,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
    onClose: () => void;
  }) => (
    <section>
      <button onClick={onClose}>Back</button>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("@/lib/api", () => ({
  universalProvidersApi: {
    listLinkCandidates: vi.fn(),
    previewLink: vi.fn(),
    linkExisting: vi.fn(),
    resync: vi.fn(),
  },
}));

const candidates: SharedChannelLinkCandidates = {
  claude: [
    { id: "claude-original", name: "My Claude", eligible: true },
    { id: "claude-other", name: "Other Claude", eligible: true },
    {
      id: "official",
      name: "Official",
      eligible: false,
      reason: "managed_auth",
    },
  ],
  codex: [{ id: "codex-original", name: "My Codex", eligible: true }],
};
const preview = (): SharedChannelLinkPreview => ({
  token: "opaque-synthetic-proof",
  credentialsDiffer: true,
  keySource: "claude",
  apps: [
    {
      app: "claude",
      providerId: "claude-original",
      name: "My Claude",
      baseUrl: "http://127.0.0.1:18888/claude?token=[REDACTED]",
      apiFormat: "anthropic",
      model: "synthetic-claude",
      current: true,
    },
    {
      app: "codex",
      providerId: "codex-original",
      name: "My Codex",
      baseUrl: "http://127.0.0.1:18888/codex",
      apiFormat: "openai_responses",
      current: false,
    },
  ],
  expiresAt: Date.now() + 300_000,
});
const completed: SharedChannelLinkResult = {
  channelId: "committed-channel",
  saved: true,
  syncedApps: ["claude", "codex"],
  failedApps: [],
};

const start = () => {
  const onClose = vi.fn();
  const onLinked = vi.fn().mockResolvedValue(undefined);
  const rendered = render(
    <SharedChannelLinkModal onClose={onClose} onLinked={onLinked} />,
  );
  return { ...rendered, onClose, onLinked };
};
const choose = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("link-channel-claude")).not.toBeDisabled(),
  );
  fireEvent.change(screen.getByTestId("link-channel-name"), {
    target: { value: "  My shared channel  " },
  });
  fireEvent.change(screen.getByTestId("link-channel-claude"), {
    target: { value: "claude-original" },
  });
  fireEvent.change(screen.getByTestId("link-channel-codex"), {
    target: { value: "codex-original" },
  });
  fireEvent.change(screen.getByTestId("link-channel-key-source"), {
    target: { value: "claude" },
  });
};
const review = async () => {
  await choose();
  fireEvent.click(screen.getByTestId("link-channel-preview"));
  return await screen.findByTestId("link-channel-confirm");
};

beforeEach(() => {
  vi.clearAllMocks();
  i18n.addResourceBundle("zh", "translation", zh, true, true);
  vi.mocked(universalProvidersApi.listLinkCandidates).mockResolvedValue(
    candidates,
  );
  vi.mocked(universalProvidersApi.previewLink).mockImplementation(
    async (request) => ({ ...preview(), keySource: request.keySource }),
  );
  vi.mocked(universalProvidersApi.linkExisting).mockResolvedValue(completed);
  vi.mocked(universalProvidersApi.resync).mockResolvedValue(completed);
});
afterEach(() => vi.useRealTimers());

describe("link existing configurations", () => {
  it("keeps a completed link successful when refreshing the list fails", async () => {
    const { onClose, onLinked } = start();
    onLinked.mockRejectedValueOnce(new Error("synthetic-refresh-failure"));
    fireEvent.click(await review());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(universalProvidersApi.linkExisting).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("requires two explicit selections and a key source before previewing", async () => {
    start();
    expect(screen.getByTestId("link-channel-preview")).toBeDisabled();
    await choose();
    fireEvent.change(screen.getByTestId("link-channel-key-source"), {
      target: { value: "" },
    });
    expect(screen.getByTestId("link-channel-preview")).toBeDisabled();
    expect(screen.getByRole("option", { name: /Official/ })).toBeDisabled();
    expect(document.body).toHaveTextContent(
      zh.universalProvider.link.reasons.managed_auth,
    );
    expect(universalProvidersApi.linkExisting).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("link-channel-key-source"), {
      target: { value: "codex" },
    });
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    await screen.findByTestId("link-channel-confirm");
    expect(universalProvidersApi.previewLink).toHaveBeenCalledWith({
      channelId: expect.any(String),
      name: "My shared channel",
      claudeProviderId: "claude-original",
      codexProviderId: "codex-original",
      keySource: "codex",
    });
    expect(universalProvidersApi.linkExisting).not.toHaveBeenCalled();
  });

  it("shows the key replacement and preservation before committing the exact preview", async () => {
    const { onClose, onLinked } = start();
    const confirm = await review();
    expect(document.body).toHaveTextContent("Codex 中的密钥会被替换");
    expect(document.body).toHaveTextContent("[REDACTED]");
    expect(document.body).toHaveTextContent("仍为当前使用的配置");
    expect(document.body).not.toHaveTextContent("opaque-synthetic-proof");
    fireEvent.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onLinked).toHaveBeenCalledOnce();
    expect(universalProvidersApi.linkExisting).toHaveBeenCalledWith(
      vi.mocked(universalProvidersApi.previewLink).mock.calls[0][0],
      "opaque-synthetic-proof",
    );
  });

  it("cancels a preview without writing and starts a new channel ID on reopening", async () => {
    const first = start();
    await review();
    const firstId = vi.mocked(universalProvidersApi.previewLink).mock
      .calls[0][0].channelId;
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(first.onClose).toHaveBeenCalledOnce();
    expect(universalProvidersApi.linkExisting).not.toHaveBeenCalled();
    first.unmount();
    start();
    await review();
    expect(
      vi.mocked(universalProvidersApi.previewLink).mock.calls[1][0].channelId,
    ).not.toBe(firstId);
  });

  it("discards late previews when selections change and retains the draft", async () => {
    let resolve!: (value: SharedChannelLinkPreview) => void;
    vi.mocked(universalProvidersApi.previewLink).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    start();
    await choose();
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    fireEvent.change(screen.getByTestId("link-channel-claude"), {
      target: { value: "claude-other" },
    });
    await act(async () => resolve(preview()));
    expect(
      screen.queryByTestId("link-channel-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("link-channel-claude")).toHaveValue(
      "claude-other",
    );
    expect(screen.getByTestId("link-channel-name")).toHaveValue(
      "  My shared channel  ",
    );
    expect(screen.getByTestId("link-channel-preview")).toBeEnabled();
  });

  it("invalidates reviewed data after editing or refreshing the candidate list", async () => {
    start();
    await review();
    fireEvent.change(screen.getByTestId("link-channel-key-source"), {
      target: { value: "codex" },
    });
    expect(
      screen.queryByTestId("link-channel-confirm"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    await screen.findByTestId("link-channel-confirm");
    vi.mocked(universalProvidersApi.listLinkCandidates).mockResolvedValue({
      ...candidates,
      codex: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByTestId("link-channel-preview")).toBeDisabled(),
    );
    expect(
      screen.queryByTestId("link-channel-confirm"),
    ).not.toBeInTheDocument();
    expect(universalProvidersApi.linkExisting).not.toHaveBeenCalled();
  });

  it("never renders raw preview or commit errors and keeps choices for correction", async () => {
    vi.mocked(universalProvidersApi.previewLink).mockRejectedValueOnce(
      new Error("Authorization: synthetic-secret-do-not-render"),
    );
    start();
    await choose();
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent(
      "synthetic-secret-do-not-render",
    );
    expect(screen.getByTestId("link-channel-name")).toHaveValue(
      "  My shared channel  ",
    );
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    const confirm = await screen.findByTestId("link-channel-confirm");
    vi.mocked(universalProvidersApi.linkExisting).mockRejectedValueOnce(
      "config contains synthetic-secret-do-not-render",
    );
    fireEvent.click(confirm);
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent(
      "synthetic-secret-do-not-render",
    );
    expect(
      screen.queryByTestId("link-channel-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("link-channel-key-source")).toHaveValue("claude");
  });

  it("blocks duplicate commits, edits and close while committing", async () => {
    let resolve!: (value: SharedChannelLinkResult) => void;
    vi.mocked(universalProvidersApi.linkExisting).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { onClose } = start();
    const confirm = await review();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(universalProvidersApi.linkExisting).toHaveBeenCalledOnce();
    expect(screen.getByTestId("link-channel-name")).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve(completed));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retries a partial commit only by the saved channel ID", async () => {
    vi.mocked(universalProvidersApi.linkExisting).mockResolvedValue({
      ...completed,
      syncedApps: ["claude"],
      failedApps: ["codex"],
    });
    const { onClose, onLinked } = start();
    fireEvent.click(await review());
    const retry = await screen.findByTestId("link-channel-resync");
    expect(screen.queryByTestId("link-channel-name")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Codex");
    expect(onClose).not.toHaveBeenCalled();
    vi.mocked(universalProvidersApi.resync).mockRejectedValueOnce(
      "synthetic-secret-do-not-render",
    );
    fireEvent.click(retry);
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent(
      "synthetic-secret-do-not-render",
    );
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(universalProvidersApi.resync).toHaveBeenNthCalledWith(
      1,
      "committed-channel",
    );
    expect(universalProvidersApi.resync).toHaveBeenNthCalledWith(
      2,
      "committed-channel",
    );
    expect(universalProvidersApi.linkExisting).toHaveBeenCalledOnce();
    expect(onLinked).toHaveBeenCalledTimes(2);
  });

  it("expires a preview before a delayed confirmation and permits a fresh preview", async () => {
    start();
    await choose();
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("link-channel-preview"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("link-channel-confirm")).toBeEnabled();
    await act(async () => {
      vi.advanceTimersByTime(300_001);
    });
    expect(
      screen.queryByTestId("link-channel-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      zh.universalProvider.link.expired,
    );
    expect(screen.getByTestId("link-channel-preview")).toBeEnabled();
    expect(universalProvidersApi.linkExisting).not.toHaveBeenCalled();
  });

  it("supports empty and failed candidate lists without exposing errors", async () => {
    vi.mocked(universalProvidersApi.listLinkCandidates).mockRejectedValueOnce(
      "synthetic-secret-do-not-render",
    );
    start();
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent(
      "synthetic-secret-do-not-render",
    );
    vi.mocked(universalProvidersApi.listLinkCandidates).mockResolvedValue({
      claude: [],
      codex: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(document.body).toHaveTextContent("Claude Code 暂无可关联");
    expect(document.body).toHaveTextContent("Codex 暂无可关联");
    expect(screen.getByTestId("link-channel-preview")).toBeDisabled();
  });
});
