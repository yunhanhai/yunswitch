import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";

const apiMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getLiveProviderSettings: vi.fn(),
  getOpenClawLiveProvider: vi.fn(),
}));
let mockFormReady = true;
let mockCodexManagedAccountSelected = false;
let submitReadyCallbacks: Array<(isReady: boolean) => void> = [];

vi.mock("@/lib/api", () => ({
  providersApi: {
    getCurrent: apiMocks.getCurrent,
  },
  vscodeApi: {
    getLiveProviderSettings: apiMocks.getLiveProviderSettings,
  },
  openclawApi: {
    getLiveProvider: apiMocks.getOpenClawLiveProvider,
  },
}));

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    isOpen,
    children,
    footer,
    onClose,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    footer?: React.ReactNode;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={onClose}>
          panel-back
        </button>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    initialData,
    onSubmit,
    onSubmitReadyChange,
    onManageAuthAccounts,
    onDirtyChange,
    isProxyTakeover,
  }: {
    initialData: {
      name?: string;
      websiteUrl?: string;
      notes?: string;
      settingsConfig?: Record<string, unknown>;
      meta?: Record<string, unknown>;
      icon?: string;
      iconColor?: string;
    };
    onSubmit: (values: {
      name: string;
      websiteUrl: string;
      notes?: string;
      settingsConfig: string;
      meta?: Record<string, unknown>;
      icon?: string;
      iconColor?: string;
    }) => void;
    onSubmitReadyChange?: (isReady: boolean) => void;
    onDirtyChange?: (dirty: boolean) => void;
    onManageAuthAccounts?: (target: "codex_oauth") => void;
    isProxyTakeover?: boolean;
    appId?: string;
  }) => {
    const [draftName, setDraftName] = useState(initialData.name ?? "");
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      setDraftName(initialData.name ?? "");
    }, [initialData]);
    useEffect(() => {
      if (onSubmitReadyChange) {
        submitReadyCallbacks.push(onSubmitReadyChange);
        onSubmitReadyChange(mockFormReady);
      }
    }, [onSubmitReadyChange]);
    return (
      <form
        id="provider-form"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit({
              name: draftName,
              websiteUrl: initialData.websiteUrl ?? "",
              notes: initialData.notes,
              settingsConfig: JSON.stringify(initialData.settingsConfig ?? {}),
              meta: mockCodexManagedAccountSelected
                ? {
                    ...(initialData.meta ?? {}),
                    providerType: "codex_oauth",
                    authBinding: {
                      source: "managed_account",
                      authProvider: "codex_oauth",
                      accountId: "acct-managed",
                    },
                  }
                : initialData.meta,
              icon: initialData.icon,
              iconColor: initialData.iconColor,
            });
          } catch {
            setFailed(true);
          }
        }}
      >
        <input
          aria-label="draft-name"
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
            onDirtyChange?.(true);
          }}
        />
        {failed && <output>save-failed</output>}
        <output data-testid="settings-config">
          {JSON.stringify(initialData.settingsConfig ?? {})}
        </output>
        <output data-testid="is-proxy-takeover">
          {isProxyTakeover ? "true" : "false"}
        </output>
        <button
          type="button"
          onClick={() => onManageAuthAccounts?.("codex_oauth")}
        >
          manage-auth
        </button>
      </form>
    );
  },
}));

vi.mock("@/components/providers/AuthSettingsPanel", () => ({
  AuthSettingsPanel: ({ target }: { target: string | null }) =>
    target ? <div data-testid="auth-settings-panel">{target}</div> : null,
}));

import { EditProviderDialog } from "@/components/providers/EditProviderDialog";

describe("EditProviderDialog", () => {
  beforeEach(() => {
    mockFormReady = true;
    mockCodexManagedAccountSelected = false;
    submitReadyCallbacks = [];
    apiMocks.getCurrent.mockReset();
    apiMocks.getLiveProviderSettings.mockReset();
    apiMocks.getOpenClawLiveProvider.mockReset();
  });

  it.each(["universal-codex-shared", "existing-codex-config"])(
    "edits linked Codex %s without importing live bearer fields",
    async (id) => {
      const provider: Provider = {
        id,
        name: "Shared Codex",
        meta: { sharedChannelId: "shared" },
        settingsConfig: {
          auth: { OPENAI_API_KEY: "fake-shared-key" },
          config:
            'model_provider = "custom"\nmodel = "client-model"\n[model_providers.custom]\nrequires_openai_auth = true\n',
        },
      };
      apiMocks.getCurrent.mockResolvedValue(provider.id);
      apiMocks.getLiveProviderSettings.mockResolvedValue({
        auth: { OPENAI_API_KEY: "fake-unrelated-key" },
        config:
          'model_provider = "custom"\n[model_providers.custom]\nexperimental_bearer_token = "fake-live-token"\nrequires_openai_auth = false\n',
      });
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <EditProviderDialog
          open
          provider={provider}
          appId="codex"
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(provider.settingsConfig);
      fireEvent.submit(document.getElementById("provider-form")!);
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].provider.settingsConfig).toEqual(
        provider.settingsConfig,
      );
      expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();
    },
  );

  it("保留 Codex 数据库中的 modelCatalog，避免 live 配置缺字段时清空模型映射", async () => {
    const dbModelCatalog = {
      models: [
        {
          model: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          contextWindow: 1000000,
        },
      ],
    };
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "aggregator",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "db-key",
        },
        config: 'model_provider = "custom"\nmodel = "deepseek-v4-flash"\n',
        modelCatalog: dbModelCatalog,
      },
    };
    const liveSettings = {
      auth: {
        OPENAI_API_KEY: "live-key",
      },
      config: 'model_provider = "custom"\nmodel = "deepseek-v4-pro"\n',
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue(liveSettings);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual({
        ...liveSettings,
        modelCatalog: dbModelCatalog,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.settingsConfig).toEqual({
      ...liveSettings,
      modelCatalog: dbModelCatalog,
    });
  });

  it("uses the current Codex live bearer with the stored provider auth template", async () => {
    const provider: Provider = {
      id: "provider-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "sk-db-stale",
          provider_note: "keep-me",
        },
        config:
          'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://proxy.example/v1"\n',
      },
    };
    const liveSettings = {
      // Shared auth.json belongs to another provider / official login cache.
      auth: {
        OPENAI_API_KEY: "sk-shared-other-provider",
        tokens: { account_id: "shared-account" },
      },
      config:
        'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://proxy.example/v1"\nexperimental_bearer_token = "sk-provider-a"\n',
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue(liveSettings);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    const expectedSettings = {
      ...liveSettings,
      auth: {
        OPENAI_API_KEY: "sk-provider-a",
        provider_note: "keep-me",
      },
    };

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(expectedSettings);
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.settingsConfig).toEqual(
      expectedSettings,
    );
  });

  it("does not convert an OAuth-only Codex provider into an API-key provider", async () => {
    const provider: Provider = {
      id: "oauth-provider",
      name: "OAuth Provider",
      category: "custom",
      settingsConfig: {
        auth: {
          auth_mode: "chatgpt",
          tokens: { account_id: "stored-account" },
        },
        config: 'model_provider = "custom"\n',
      },
    };
    const liveSettings = {
      auth: {
        auth_mode: "chatgpt",
        tokens: { account_id: "live-account" },
      },
      config:
        'model_provider = "custom"\nexperimental_bearer_token = "sk-route-only"\n',
    };

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue(liveSettings);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        appId="codex"
      />,
    );

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(liveSettings);
    });
  });

  it("does not let a stored bearer override a non-current Codex provider auth", async () => {
    const provider: Provider = {
      id: "provider-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-db-authoritative" },
        config:
          'model_provider = "custom"\nexperimental_bearer_token = "sk-leftover-live"\n',
      },
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    apiMocks.getCurrent.mockResolvedValue("provider-b");

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await waitFor(() => expect(apiMocks.getCurrent).toHaveBeenCalledTimes(1));
    expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
    ).toEqual(provider.settingsConfig);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.settingsConfig).toEqual(
      provider.settingsConfig,
    );
  });

  it("代理接管中编辑 Codex 供应商时展示数据库配置而不是读取 live 代理配置", async () => {
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "db-key",
        },
        config:
          'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.deepseek.com/v1"\n',
      },
    };

    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockResolvedValue({
      auth: {
        OPENAI_API_KEY: "PROXY_MANAGED",
      },
      config:
        'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\nexperimental_bearer_token = "PROXY_MANAGED"\n',
    });

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        appId="codex"
        isProxyTakeover
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-proxy-takeover").textContent).toBe("true");
    });

    expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
    ).toEqual(provider.settingsConfig);
  });

  it("clears the nested auth panel before the dialog reopens", async () => {
    const provider: Provider = {
      id: "official",
      name: "OpenAI Official",
      settingsConfig: { auth: {}, config: "" },
    };
    const props = {
      provider,
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      appId: "codex" as const,
    };
    const { rerender } = render(<EditProviderDialog open {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "manage-auth" }));
    expect(screen.getByTestId("auth-settings-panel")).toHaveTextContent(
      "codex_oauth",
    );

    rerender(<EditProviderDialog open={false} {...props} />);
    rerender(<EditProviderDialog open {...props} />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("auth-settings-panel"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps an unbound Codex Official provider ID unchanged", async () => {
    apiMocks.getCurrent.mockResolvedValue(null);
    const onSubmit = vi.fn();
    const provider: Provider = {
      id: "legacy-unbound-official",
      name: "Legacy OpenAI Official",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        appId="codex"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        originalId: "legacy-unbound-official",
        provider: expect.objectContaining({ id: "legacy-unbound-official" }),
      }),
    );
  });

  it("keeps the fixed Codex provider ID when an account is bound", async () => {
    mockCodexManagedAccountSelected = true;
    apiMocks.getCurrent.mockResolvedValue(null);
    const onSubmit = vi.fn();
    const provider: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        appId="codex"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.originalId).toBe("codex-official");
    expect(submitted.provider.id).toBe("codex-official");
    expect(submitted.provider.meta?.authBinding).toEqual({
      source: "managed_account",
      authProvider: "codex_oauth",
      accountId: "acct-managed",
    });
  });

  it("编辑 Pi 供应商时保留通用元数据", async () => {
    const provider: Provider = {
      id: "pi-provider",
      name: "Pi Provider",
      settingsConfig: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "model" }],
      },
      meta: {
        isPartner: true,
        endpointAutoSelect: true,
        custom_endpoints: {
          "https://failover.example.com/v1": {
            url: "https://failover.example.com/v1",
            addedAt: 1,
          },
        },
      },
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="pi"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.meta).toMatchObject({
      isPartner: true,
    });
    expect(handleSubmit.mock.calls[0][0]).not.toHaveProperty(
      "expectedSettingsConfig",
    );
  });

  it("重新打开 Pi 编辑表单后忽略上一轮的就绪回调", async () => {
    const provider: Provider = {
      id: "pi-provider",
      name: "Pi Provider",
      settingsConfig: { models: [{ id: "model" }] },
    };
    const props = {
      provider,
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      appId: "pi" as const,
    };
    const { rerender } = render(<EditProviderDialog open {...props} />);

    const saveButton = await screen.findByRole("button", {
      name: "common.save",
    });
    await waitFor(() => expect(saveButton).toBeEnabled());
    const staleCallback = submitReadyCallbacks.at(-1);
    expect(staleCallback).toBeDefined();

    rerender(<EditProviderDialog open={false} {...props} />);
    mockFormReady = false;
    rerender(<EditProviderDialog open {...props} />);
    const reopenedButton = await screen.findByRole("button", {
      name: "common.save",
    });
    await waitFor(() => expect(reopenedButton).toBeDisabled());

    act(() => staleCallback?.(true));
    expect(reopenedButton).toBeDisabled();
  });
  it("does not mount an editable draft until the current live snapshot settles", async () => {
    const provider: Provider = {
      id: "slow",
      name: "Stored",
      settingsConfig: { auth: { OPENAI_API_KEY: "fake-db" }, config: "stored" },
    };
    let finishLive!: (settings: Record<string, unknown>) => void;
    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockReturnValue(
      new Promise((resolve) => {
        finishLive = resolve;
      }),
    );
    render(
      <EditProviderDialog
        open
        provider={provider}
        appId="codex"
        onSubmit={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "draft-name" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.save" })).toBeDisabled();
    await waitFor(() =>
      expect(apiMocks.getLiveProviderSettings).toHaveBeenCalledOnce(),
    );
    await act(async () =>
      finishLive({ auth: { OPENAI_API_KEY: "fake-live" }, config: "live" }),
    );
    expect(
      await screen.findByRole("textbox", { name: "draft-name" }),
    ).toHaveValue("Stored");
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual({ auth: { OPENAI_API_KEY: "fake-live" }, config: "live" });
  });

  it("uses the saved snapshot on demand and ignores a later live response", async () => {
    const provider: Provider = {
      id: "slow",
      name: "Stored",
      settingsConfig: { auth: { OPENAI_API_KEY: "fake-db" }, config: "stored" },
    };
    let finishLive!: (settings: Record<string, unknown>) => void;
    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings.mockReturnValue(
      new Promise((resolve) => {
        finishLive = resolve;
      }),
    );
    render(
      <EditProviderDialog
        open
        provider={provider}
        appId="codex"
        onSubmit={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(apiMocks.getLiveProviderSettings).toHaveBeenCalledOnce(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "providerDraft.useSaved" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "draft-name" }), {
      target: { value: "Keep draft" },
    });
    await act(async () =>
      finishLive({ auth: { OPENAI_API_KEY: "fake-late" }, config: "late" }),
    );
    expect(screen.getByRole("textbox", { name: "draft-name" })).toHaveValue(
      "Keep draft",
    );
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual(provider.settingsConfig);
  });

  it.each(["current", "live"])(
    "falls back to saved data when %s lookup fails",
    async (failure) => {
      const provider: Provider = {
        id: "fallback",
        name: "Fallback",
        settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: "fake" } },
      };
      apiMocks.getCurrent.mockImplementation(() =>
        failure === "current"
          ? Promise.reject(new Error("private error"))
          : Promise.resolve(provider.id),
      );
      apiMocks.getLiveProviderSettings.mockRejectedValue(
        new Error("private error"),
      );
      render(
        <EditProviderDialog
          open
          provider={provider}
          appId="claude"
          onSubmit={vi.fn()}
          onOpenChange={vi.fn()}
        />,
      );
      expect(
        await screen.findByRole("textbox", { name: "draft-name" }),
      ).toHaveValue("Fallback");
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent!),
      ).toEqual(provider.settingsConfig);
      expect(screen.queryByText("private error")).not.toBeInTheDocument();
    },
  );

  it("freezes the whole same-ID snapshot during edits and reloads only after reopening", async () => {
    const provider: Provider = {
      id: "stable",
      name: "Original",
      settingsConfig: { config: "original" },
      meta: { requestBudget: { firstByteTimeoutSecs: 30 } },
    };
    const props = {
      appId: "codex" as const,
      isProxyTakeover: true,
      onSubmit: vi.fn(),
      onOpenChange: vi.fn(),
    };
    const { rerender } = render(
      <EditProviderDialog open provider={provider} {...props} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "draft-name" }), {
      target: { value: "User draft" },
    });
    const refreshed: Provider = {
      ...provider,
      name: "Refreshed",
      settingsConfig: { config: "refreshed" },
      meta: { requestBudget: { firstByteTimeoutSecs: 60 } },
    };
    rerender(<EditProviderDialog open provider={refreshed} {...props} />);
    expect(screen.getByRole("textbox", { name: "draft-name" })).toHaveValue(
      "User draft",
    );
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual(provider.settingsConfig);
    rerender(
      <EditProviderDialog open={false} provider={refreshed} {...props} />,
    );
    rerender(<EditProviderDialog open provider={refreshed} {...props} />);
    expect(screen.getByRole("textbox", { name: "draft-name" })).toHaveValue(
      "Refreshed",
    );
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual(refreshed.settingsConfig);
  });

  it("isolates a provider change while the old live read is still pending", async () => {
    const a: Provider = {
      id: "a",
      name: "A",
      settingsConfig: { config: "db-a" },
    };
    const b: Provider = {
      id: "b",
      name: "B",
      settingsConfig: { config: "db-b" },
    };
    let finishA!: (settings: Record<string, unknown>) => void;
    apiMocks.getCurrent.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    apiMocks.getLiveProviderSettings
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishA = resolve;
        }),
      )
      .mockResolvedValueOnce({ config: "live-b" });
    const props = {
      appId: "codex" as const,
      onSubmit: vi.fn(),
      onOpenChange: vi.fn(),
    };
    const { rerender } = render(
      <EditProviderDialog open provider={a} {...props} />,
    );
    await waitFor(() =>
      expect(apiMocks.getLiveProviderSettings).toHaveBeenCalledOnce(),
    );
    rerender(<EditProviderDialog open provider={b} {...props} />);
    expect(
      await screen.findByRole("textbox", { name: "draft-name" }),
    ).toHaveValue("B");
    await act(async () => finishA({ config: "live-a" }));
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual({ config: "live-b" });
  });

  it("loads a separate snapshot when two apps use the same provider ID", async () => {
    const provider: Provider = {
      id: "shared-id",
      name: "Codex",
      settingsConfig: { config: "db" },
    };
    apiMocks.getCurrent.mockResolvedValue(provider.id);
    apiMocks.getLiveProviderSettings
      .mockResolvedValueOnce({ config: "codex-live" })
      .mockResolvedValueOnce({ env: { ANTHROPIC_AUTH_TOKEN: "fake-claude" } });
    const props = { onSubmit: vi.fn(), onOpenChange: vi.fn() };
    const { rerender } = render(
      <EditProviderDialog open provider={provider} appId="codex" {...props} />,
    );
    await screen.findByRole("textbox", { name: "draft-name" });
    rerender(
      <EditProviderDialog
        open
        provider={{ ...provider, name: "Claude" }}
        appId="claude"
        {...props}
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "draft-name" }),
    ).toHaveValue("Claude");
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: "fake-claude" } });
    expect(apiMocks.getCurrent.mock.calls.map(([app]) => app)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("ignores late success from a closed session instead of closing a reopened editor", async () => {
    const provider: Provider = {
      id: "saving",
      name: "Saved",
      settingsConfig: {},
    };
    let finish!: () => void;
    const onSubmit = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const props = {
      provider,
      appId: "codex" as const,
      isProxyTakeover: true,
      onSubmit,
      onOpenChange,
    };
    const { rerender } = render(<EditProviderDialog open {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    fireEvent.click(screen.getByRole("button", { name: "panel-back" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    rerender(<EditProviderDialog open={false} {...props} />);
    rerender(<EditProviderDialog open {...props} />);
    await act(async () => finish());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "draft-name" }),
    ).toBeInTheDocument();
  });
  it("retains the draft after a failed save and permits retry", async () => {
    const provider: Provider = {
      id: "retry-save",
      name: "Original",
      settingsConfig: { config: "stored" },
    };
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("private-save-error"))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(
      <EditProviderDialog
        open
        provider={provider}
        appId="codex"
        isProxyTakeover
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "draft-name" }), {
      target: { value: "Keep failed draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await screen.findByText("save-failed");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "draft-name" })).toHaveValue(
      "Keep failed draft",
    );
    expect(screen.queryByText("private-save-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0].provider.name).toBe("Keep failed draft");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("uses a per-provider OpenClaw snapshot before mounting its editor", async () => {
    const provider: Provider = {
      id: "openclaw-provider",
      name: "Claw",
      settingsConfig: { baseUrl: "https://stored.example" },
    };
    apiMocks.getOpenClawLiveProvider.mockResolvedValue({
      baseUrl: "https://live.example",
      apiKey: "fake-claw",
    });
    render(
      <EditProviderDialog
        open
        provider={provider}
        appId="openclaw"
        onSubmit={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "draft-name" });
    expect(apiMocks.getOpenClawLiveProvider).toHaveBeenCalledWith(provider.id);
    expect(apiMocks.getCurrent).not.toHaveBeenCalled();
    expect(
      JSON.parse(screen.getByTestId("settings-config").textContent!),
    ).toEqual({ baseUrl: "https://live.example", apiKey: "fake-claw" });
  });
});

describe("EditProviderDialog draft navigation", () => {
  it("keeps changed linked settings until shared-channel navigation is explicitly confirmed", async () => {
    const close = vi.fn();
    const manage = vi.fn();
    const provider: Provider = {
      id: "linked-draft",
      name: "Stored",
      settingsConfig: { auth: { OPENAI_API_KEY: "fake-key" }, config: "" },
      meta: { sharedChannelId: "channel" },
    };
    render(
      <EditProviderDialog
        open
        provider={provider}
        appId="codex"
        onOpenChange={close}
        onSubmit={vi.fn()}
        onManageSharedChannel={manage}
      />,
    );
    fireEvent.change(await screen.findByLabelText("draft-name"), {
      target: { value: "unsaved name" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "universalProvider.manageShared" }),
    );
    expect(manage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "providerDraft.keep" }));
    expect(screen.getByLabelText("draft-name")).toHaveValue("unsaved name");
    fireEvent.click(screen.getByRole("button", { name: "panel-back" }));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "providerDraft.keep" }));
    fireEvent.click(
      screen.getByRole("button", { name: "universalProvider.manageShared" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "providerDraft.discard" }),
    );
    expect(manage).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
