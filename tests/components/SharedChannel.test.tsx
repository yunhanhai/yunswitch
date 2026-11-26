import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { UniversalProviderFormModal } from "@/components/universal/UniversalProviderFormModal";
import { UniversalProviderPanel } from "@/components/universal/UniversalProviderPanel";
import { universalProvidersApi } from "@/lib/api";
import type { SharedChannelSaveResult, UniversalProvider } from "@/types";

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    isOpen,
    title,
    children,
    footer,
    onClose,
  }: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
    footer: React.ReactNode;
    onClose: () => void;
  }) =>
    isOpen ? (
      <section>
        <h1>{title}</h1>
        <button onClick={onClose}>Back</button>
        {children}
        {footer}
      </section>
    ) : null,
}));
vi.mock("@/components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("@/lib/api", () => ({
  universalProvidersApi: {
    save: vi.fn(),
    resync: vi.fn(),
    preview: vi.fn(),
    getAll: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

const complete: SharedChannelSaveResult = {
  saved: true,
  syncedApps: ["claude", "codex"],
  failedApps: [],
};
const channel = (): UniversalProvider => ({
  id: "synthetic-channel",
  name: "Synthetic shared channel",
  providerType: "custom_gateway",
  apps: { claude: true, codex: true, gemini: false },
  baseUrl: "http://127.0.0.1:18888",
  apiKey: "synthetic-key-do-not-use",
  models: {
    claude: { model: "synthetic-claude" },
    codex: { model: "synthetic-codex" },
  },
});

beforeEach(() => {
  i18n.addResourceBundle("zh", "translation", zh, true, true);
  vi.mocked(universalProvidersApi.getAll).mockResolvedValue({});
  vi.mocked(universalProvidersApi.save).mockResolvedValue(complete);
});

describe("shared channel form", () => {
  it("preserves original child IDs and authentication transport while rotating a linked key", async () => {
    const linked = channel();
    linked.childIds = { claude: "old-claude", codex: "old-codex" };
    linked.connections = {
      claude: { apiKeyField: "ANTHROPIC_API_KEY", apiFormat: "anthropic" },
    };
    const onSave = vi.fn().mockResolvedValue(complete);
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
        editingProvider={linked}
      />,
    );
    fireEvent.change(screen.getByLabelText("共享 API Key"), {
      target: { value: "synthetic-rotated-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      childIds: linked.childIds,
      connections: linked.connections,
      apiKey: "synthetic-rotated-key",
    });
    expect(
      screen.getAllByText(zh.universalProvider.link.disableHint),
    ).toHaveLength(2);
  });

  it("shows a legacy upstream protocol and allows changing it to the native protocol", async () => {
    const legacy = channel();
    legacy.meta = { apiFormat: "openai_chat" };
    legacy.connections = { codex: { baseUrl: "http://127.0.0.1:18889" } };
    const onSave = vi.fn().mockResolvedValue(complete);
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
        editingProvider={legacy}
      />,
    );
    const protocol = document.getElementById("shared-codex-apiFormat")!;
    expect(protocol).toHaveValue("openai_chat");
    fireEvent.change(protocol, { target: { value: "openai_responses" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].connections.codex.apiFormat).toBe(
      "openai_responses",
    );
  });

  it("saves one channel for two clients with independent paths and protocols", async () => {
    const save = vi.fn().mockResolvedValue(complete);
    const close = vi.fn();
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={close}
        onSave={save}
        initialApp="claude"
      />,
    );
    expect(screen.getByRole("switch", { name: "Claude Code" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Codex" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.change(screen.getByLabelText("共享 API 地址"), {
      target: { value: "http://127.0.0.1:18888" },
    });
    fireEvent.change(screen.getByLabelText("共享 API Key"), {
      target: { value: "synthetic-key" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));
    fireEvent.change(document.getElementById("shared-codex-baseUrl")!, {
      target: { value: "http://127.0.0.1:18888/custom/v2" },
    });
    fireEvent.change(document.getElementById("shared-codex-apiFormat")!, {
      target: { value: "openai_chat" },
    });
    expect(
      screen.getByText(zh.universalProvider.routingRequired),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      apps: { claude: true, codex: true, gemini: false },
      apiKey: "synthetic-key",
      connections: {
        codex: {
          baseUrl: "http://127.0.0.1:18888/custom/v2",
          apiFormat: "openai_chat",
        },
      },
    });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("awaits saving, prevents duplicate submissions and keeps input after rejection", async () => {
    let reject!: (error: Error) => void;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const close = vi.fn();
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={close}
        onSave={save}
        editingProvider={channel()}
      />,
    );
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Retained draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(close).not.toHaveBeenCalled();
    await act(async () =>
      reject(new Error("raw-secret-error-must-not-render")),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      zh.universalProvider.saveErrorHint,
    );
    expect(screen.getByLabelText("名称")).toHaveValue("Retained draft");
    expect(screen.getByLabelText("共享 API Key")).toHaveValue(
      "synthetic-key-do-not-use",
    );
    expect(document.body).not.toHaveTextContent(
      "raw-secret-error-must-not-render",
    );
    expect(save).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("retains the same ID for a saved channel whose live sync needs retry", async () => {
    const save = vi.fn().mockResolvedValueOnce({
      saved: true,
      syncedApps: ["claude"],
      failedApps: ["codex"],
    });
    vi.mocked(universalProvidersApi.resync).mockResolvedValue(complete);
    const close = vi.fn();
    render(<UniversalProviderFormModal isOpen onClose={close} onSave={save} />);
    fireEvent.change(screen.getByLabelText("共享 API 地址"), {
      target: { value: "http://127.0.0.1:18888" },
    });
    fireEvent.change(screen.getByLabelText("共享 API Key"), {
      target: { value: "synthetic-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Codex"),
    );
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("共享 API Key")).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: zh.universalProvider.link.resync }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    expect(universalProvidersApi.resync).toHaveBeenCalledWith(
      save.mock.calls[0][0].id,
    );
  });

  it("does not replace an open draft when the saved provider list refreshes", () => {
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      onSave: vi.fn().mockResolvedValue(complete),
    };
    const { rerender } = render(
      <UniversalProviderFormModal {...props} editingProvider={channel()} />,
    );
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Unsaved draft" },
    });
    rerender(
      <UniversalProviderFormModal
        {...props}
        editingProvider={{ ...channel(), name: "Refreshed stored value" }}
      />,
    );
    expect(screen.getByLabelText("名称")).toHaveValue("Unsaved draft");
  });

  it("resyncs the saved channel after detach changes its binding map", async () => {
    const linked = {
      ...channel(),
      childIds: { claude: "existing-claude", codex: "existing-codex" },
    };
    const save = vi
      .fn()
      .mockResolvedValue({
        saved: true,
        syncedApps: [],
        failedApps: ["codex"],
      });
    vi.mocked(universalProvidersApi.resync).mockResolvedValue(complete);
    const close = vi.fn();
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={close}
        onSave={save}
        editingProvider={linked}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await screen.findByRole("status");
    fireEvent.click(
      screen.getByRole("button", { name: zh.universalProvider.link.resync }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    expect(universalProvidersApi.resync).toHaveBeenCalledWith(linked.id);
  });

  it("previews only a backend-generated masked configuration and invalidates stale preview", async () => {
    vi.mocked(universalProvidersApi.preview).mockResolvedValue({
      codex: {
        id: "child",
        name: "Codex",
        settingsConfig: {
          auth: { OPENAI_API_KEY: "[REDACTED]" },
          config: 'base_url = "http://127.0.0.1:18888/custom/v2"',
        },
      },
    });
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={vi.fn()}
        onSave={vi.fn()}
        editingProvider={channel()}
      />,
    );
    expect(universalProvidersApi.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "脱敏配置预览" }));
    await waitFor(() =>
      expect(screen.getByText(/\[REDACTED\]/)).toBeInTheDocument(),
    );
    expect(document.body).not.toHaveTextContent("synthetic-key-do-not-use");
    expect(screen.getByText(/\[REDACTED\]/)).toHaveTextContent("custom/v2");
    fireEvent.change(screen.getByLabelText("共享 API 地址"), {
      target: { value: "http://127.0.0.1:18889" },
    });
    expect(screen.queryByText(/\[REDACTED\]/)).not.toBeInTheDocument();
  });

  it("discards a preview that returns after the draft changes", async () => {
    let resolve!: (value: {}) => void;
    vi.mocked(universalProvidersApi.preview).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={vi.fn()}
        onSave={vi.fn()}
        editingProvider={channel()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "脱敏配置预览" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "New draft" },
    });
    await act(async () =>
      resolve({ codex: { settingsConfig: { stale: "old-preview" } } }),
    );
    expect(document.body).not.toHaveTextContent("old-preview");
  });

  it("requires at least one selected client", () => {
    render(
      <UniversalProviderFormModal
        isOpen
        onClose={vi.fn()}
        onSave={vi.fn()}
        editingProvider={channel()}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "保存并同步" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      zh.universalProvider.selectApp,
    );
  });
});

describe("shared channel panel", () => {
  it("duplicates a linked channel without claiming its original provider IDs", async () => {
    const original = {
      ...channel(),
      childIds: { claude: "original-claude", codex: "original-codex" },
    };
    vi.mocked(universalProvidersApi.getAll).mockResolvedValue({
      [original.id]: original,
    });
    render(<UniversalProviderPanel />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh.universalProvider.duplicate,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
    await waitFor(() => expect(universalProvidersApi.save).toHaveBeenCalled());
    const saved = vi.mocked(universalProvidersApi.save).mock.calls[0][0];
    expect(saved.childIds).toBeUndefined();
    expect(saved.id).not.toBe(original.id);
    expect(original.childIds).toEqual({
      claude: "original-claude",
      codex: "original-codex",
    });
  });

  it("retries by ID without sending a stale credential snapshot", async () => {
    const original = channel();
    vi.mocked(universalProvidersApi.getAll).mockResolvedValue({
      [original.id]: original,
    });
    vi.mocked(universalProvidersApi.resync).mockResolvedValue(complete);
    render(<UniversalProviderPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: zh.universalProvider.sync }),
    );
    await waitFor(() =>
      expect(universalProvidersApi.resync).toHaveBeenCalledWith(original.id),
    );
    expect(universalProvidersApi.save).not.toHaveBeenCalled();
  });

  it("opens a linked shared channel directly after loading", async () => {
    vi.mocked(universalProvidersApi.getAll).mockResolvedValue({
      [channel().id]: channel(),
    });
    const consumed = vi.fn();
    render(
      <UniversalProviderPanel
        initialEditId={channel().id}
        onEditConsumed={consumed}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("名称")).toHaveValue(channel().name),
    );
    expect(consumed).toHaveBeenCalledOnce();
  });
});
