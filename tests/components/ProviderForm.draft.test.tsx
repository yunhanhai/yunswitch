import { ProviderPresetSelector } from "@/components/providers/forms/ProviderPresetSelector";
import {
  fireEvent,
  render,
  screen,
  act,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { ProviderDraftGuard } from "@/components/providers/ProviderDraftGuard";
import { useProviderDraftChange } from "@/components/providers/forms/hooks/useProviderDraftChange";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";
import { createTestQueryClient } from "../utils/testQueryClient";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";

const catalogState = vi.hoisted(() => ({
  publish: undefined as
    | undefined
    | ((
        snapshot: { models: Array<{ id: string; displayName: string }> } | null,
      ) => void),
}));
vi.mock("@/components/providers/forms/ModelCatalogPanel", () => ({
  ModelCatalogPicker: () => null,
  ModelCatalogPanel: ({
    onSnapshotChange,
  }: {
    onSnapshotChange?: typeof catalogState.publish;
  }) => {
    catalogState.publish = onSnapshotChange;
    return null;
  },
}));
const authState = vi.hoisted(() => ({
  codexReauthRequired: false,
}));
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastMocks.error,
    success: vi.fn(),
  },
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: ({
    onAccountSelect,
    onSelectionConfirmed,
    onSelectionInvalidated,
    allowUnboundSelection = true,
    allowUnboundSelectionWithoutStatus = false,
  }: {
    onAccountSelect?: (accountId: string | null) => void;
    onSelectionConfirmed?: () => void;
    onSelectionInvalidated?: () => void;
    allowUnboundSelection?: boolean;
    allowUnboundSelectionWithoutStatus?: boolean;
  }) => (
    <div>
      <output data-testid="allow-unbound-selection">
        {allowUnboundSelection ? "true" : "false"}
      </output>
      <output data-testid="allow-unbound-without-status">
        {allowUnboundSelectionWithoutStatus ? "true" : "false"}
      </output>
      <button
        type="button"
        onClick={() => {
          onSelectionConfirmed?.();
          onAccountSelect?.("acct-managed");
        }}
      >
        select-managed-account
      </button>
      {allowUnboundSelection && (
        <button
          type="button"
          onClick={() => {
            onSelectionConfirmed?.();
            onAccountSelect?.(null);
          }}
        >
          select-native-login
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onSelectionInvalidated?.();
          onAccountSelect?.(null);
        }}
      >
        invalidate-selected-account
      </button>
    </div>
  ),
}));

vi.mock("@/components/providers/forms/CodexConfigEditor", () => ({
  default: () => <div data-testid="codex-config-editor" />,
}));

vi.mock("@/components/providers/forms/ProviderAdvancedConfig", () => ({
  ProviderAdvancedConfig: () => <div data-testid="advanced-config" />,
}));

vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  return {
    ...actual,
    useCopilotAuth: () => ({
      isAuthenticated: false,
      isStatusSuccess: true,
      isStatusError: false,
      accounts: [],
    }),
    useCodexOauth: () => ({
      isAuthenticated: true,
      isStatusSuccess: true,
      isStatusError: false,
      defaultAccountId: "acct-managed",
      accounts: [
        {
          id: "acct-managed",
          login: "user@example.com",
          is_default: true,
          reauth_required: authState.codexReauthRequired,
          requires_reauth: false,
        },
      ],
    }),
    useXaiOauth: () => ({
      isAuthenticated: false,
      accounts: [],
    }),
    useCommonConfigSnippet: () => ({
      useCommonConfig: false,
      commonConfigSnippet: "",
      commonConfigError: null,
      isLoading: false,
      isExtracting: false,
      handleCommonConfigToggle: vi.fn(),
      handleCommonConfigSnippetChange: vi.fn(),
      handleExtract: vi.fn(),
    }),
    useCodexCommonConfig: () => ({
      useCommonConfig: false,
      commonConfigSnippet: "",
      commonConfigError: null,
      handleCommonConfigToggle: vi.fn(),
      handleCommonConfigSnippetChange: vi.fn(),
      isExtracting: false,
      handleExtract: vi.fn(),
      clearCommonConfigError: vi.fn(),
    }),
    useGeminiCommonConfig: () => ({
      useCommonConfig: false,
      commonConfigSnippet: "",
      commonConfigError: null,
      handleCommonConfigToggle: vi.fn(),
      handleCommonConfigSnippetChange: vi.fn(),
      isExtracting: false,
      handleExtract: vi.fn(),
      clearCommonConfigError: vi.fn(),
    }),
  };
});

vi.mock("@/lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query")>();
  return {
    ...actual,
    useSettingsQuery: () => ({
      data: { commonConfigConfirmed: true },
    }),
  };
});

function renderDraft(
  appId: "claude" | "codex",
  onDirtyChange = vi.fn(),
  onSubmit = vi.fn(),
) {
  const queryClient = createTestQueryClient();
  const settingsConfig =
    appId === "codex"
      ? {
          auth: { OPENAI_API_KEY: "fake-draft-key" },
          config:
            'model_provider = "synthetic"\nmodel = "first-model"\n[model_providers.synthetic]\nbase_url = "https://example.test/v1"\nwire_api = "responses"\n',
        }
      : {
          env: {
            ANTHROPIC_API_KEY: "fake-draft-key",
            ANTHROPIC_BASE_URL: "https://example.test",
          },
        };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderForm
        appId={appId}
        providerId="draft-fixture"
        submitLabel="save-provider"
        initialData={{
          name: "Draft fixture",
          category: "custom",
          settingsConfig,
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        onDirtyChange={onDirtyChange}
      />
    </QueryClientProvider>,
  );
  return { ...view, onDirtyChange };
}

describe("provider draft change protection", () => {
  beforeEach(() => {
    i18n.addResourceBundle("zh", "translation", {
      providerDraft: zh.providerDraft,
      providerBudget: zh.providerBudget,
    });
  });

  it.each(["claude", "codex"] as const)(
    "%s initialization and opening a section do not mark the draft dirty; budget edits do",
    async (appId) => {
      const { onDirtyChange } = renderDraft(appId);
      await act(async () => {});
      expect(onDirtyChange.mock.calls).toEqual([[false]]);
      fireEvent.click(
        screen.getByRole("button", { name: zh.providerBudget.title }),
      );
      expect(onDirtyChange.mock.calls).toEqual([[false]]);
      fireEvent.change(
        screen.getByLabelText(zh.providerBudget.recoveryTimeoutSecs),
        { target: { value: "75" } },
      );
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      fireEvent.change(
        screen.getByLabelText(zh.providerBudget.recoveryTimeoutSecs),
        { target: { value: "" } },
      );
      expect(onDirtyChange.mock.calls).toEqual([[false], [true]]);
    },
  );

  it("Codex model and advanced metadata edits are protected", async () => {
    const { onDirtyChange } = renderDraft("codex");
    await act(async () => {});
    fireEvent.change(document.getElementById("codexDefaultModel")!, {
      target: { value: "draft-model" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("Codex advanced user-agent metadata is protected without changing the main form fields", async () => {
    const { onDirtyChange } = renderDraft("codex");
    await act(async () => {});
    expect(onDirtyChange.mock.calls).toEqual([[false]]);
    fireEvent.change(document.getElementById("codex-custom-user-agent")!, {
      target: { value: "Synthetic Agent" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("native form changes are tracked but model search and display-only clicks are not", () => {
    const changed = vi.fn();
    function Harness() {
      const { onFieldChange, trackChange } = useProviderDraftChange(changed);
      const [shown, setShown] = useState(false);
      return (
        <form onChangeCapture={onFieldChange} onInputCapture={onFieldChange}>
          <input aria-label="model-search" type="search" />
          <input aria-label="name" />
          <button type="button" onClick={() => setShown(!shown)}>
            show-key
          </button>
          <button type="button" onClick={trackChange(() => {})}>
            change-protocol
          </button>
        </form>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    fireEvent.change(screen.getByLabelText("model-search"), {
      target: { value: "model" },
    });
    fireEvent.click(screen.getByText("show-key"));
    expect(changed.mock.calls.every(([value]) => value === false)).toBe(true);
    fireEvent.click(screen.getByText("change-protocol"));
    expect(changed).toHaveBeenLastCalledWith(true);
  });

  it("searching real provider presets does not alter a pristine draft", () => {
    const changed = vi.fn();
    function SearchForm() {
      const { onFieldChange } = useProviderDraftChange(changed);
      return (
        <form onInputCapture={onFieldChange} onChangeCapture={onFieldChange}>
          <ProviderPresetSelector
            selectedPresetId="custom"
            presetEntries={[]}
            presetCategoryLabels={{}}
            onPresetChange={() => {}}
          />
        </form>
      );
    }
    render(<SearchForm />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search provider presets" }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search provider presets" }),
      { target: { value: "search only" } },
    );
    expect(changed.mock.calls).toEqual([[false]]);
  });

  it("keeps the edit by default and discards only after the explicit action", async () => {
    const keep = vi.fn();
    const discard = vi.fn();
    render(<ProviderDraftGuard open onKeep={keep} onDiscard={discard} />);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      zh.providerDraft.discardTitle,
    );
    fireEvent.click(
      screen.getByRole("button", { name: zh.providerDraft.keep }),
    );
    expect(keep).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: zh.providerDraft.discard }),
    );
    expect(discard).toHaveBeenCalledOnce();
  });
  it("keeps rejected saves editable and freezes inputs only while retrying", async () => {
    let finish!: () => void;
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("fake-private-error"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    renderDraft("codex", vi.fn(), save);
    await act(async () => {});
    fireEvent.change(document.getElementById("codexDefaultModel")!, {
      target: { value: "retained-model" },
    });
    fireEvent.submit(document.getElementById("provider-form")!);
    await screen.findByTestId("provider-draft-save-error");
    expect(screen.queryByText("fake-private-error")).not.toBeInTheDocument();
    expect(document.getElementById("codexDefaultModel")).toHaveValue(
      "retained-model",
    );
    expect(document.getElementById("codexDefaultModel")).toBeEnabled();
    fireEvent.submit(document.getElementById("provider-form")!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(document.getElementById("codexDefaultModel")).toBeDisabled();
    await act(async () => finish());
    expect(document.getElementById("codexDefaultModel")).toBeEnabled();
    expect(document.getElementById("codexDefaultModel")).toHaveValue(
      "retained-model",
    );
  });
});

it("retains saved and edited Codex mappings when background catalogs arrive", async () => {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId="codex"
        providerId="manual"
        submitLabel="save"
        onCancel={() => {}}
        onSubmit={() => {}}
        initialData={{
          name: "Synthetic",
          category: "custom",
          settingsConfig: {
            auth: { OPENAI_API_KEY: "fake-key" },
            config:
              'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:1"\nwire_api = "responses"',
            modelCatalog: {
              models: [
                {
                  model: "stored-model",
                  displayName: "Stored",
                  contextWindow: 12345,
                },
              ],
            },
          },
        }}
      />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("实际请求模型");
  act(() =>
    catalogState.publish?.({
      models: [{ id: "background-first", displayName: "Background" }],
    }),
  );
  expect(screen.getByLabelText("实际请求模型")).toHaveValue("stored-model");
  fireEvent.change(screen.getByLabelText("实际请求模型"), {
    target: { value: "user-draft-model" },
  });
  act(() =>
    catalogState.publish?.({
      models: [{ id: "background-refresh", displayName: "Background" }],
    }),
  );
  expect(screen.getByLabelText("实际请求模型")).toHaveValue("user-draft-model");
});

it("retains native input events when dirty tracking rerenders the parent", async () => {
  function Parent() {
    const [dirty, setDirty] = useState(false);
    return (
      <>
        <output data-testid="native-dirty">{String(dirty)}</output>
        <ProviderForm
          appId="claude"
          providerId="native"
          submitLabel="save"
          onSubmit={() => {}}
          onCancel={() => {}}
          onDirtyChange={setDirty}
          initialData={initial}
        />
      </>
    );
  }
  const initial = {
    name: "Synthetic",
    category: "custom" as const,
    settingsConfig: {
      env: {
        ANTHROPIC_AUTH_TOKEN: "fake",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      },
    },
    meta: { requestBudget: { recoveryTimeoutSecs: 2 } },
  };
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Parent />
    </QueryClientProvider>,
  );
  const budget = await screen.findByLabelText(
    zh.providerBudget.recoveryTimeoutSecs,
  );
  fireEvent.input(budget, { target: { value: "3" } });
  expect(budget).toHaveValue(3);
  expect(screen.getByTestId("native-dirty")).toHaveTextContent("true");
});
