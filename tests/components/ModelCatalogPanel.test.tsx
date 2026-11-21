import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { ModelCatalogPanel } from "@/components/providers/forms/ModelCatalogPanel";
import zh from "@/i18n/locales/zh.json";
import { getModelCatalog, refreshModelCatalog } from "@/lib/api/model-fetch";
import type { ModelCatalogSnapshot } from "@/lib/api/model-fetch";

vi.mock("@/lib/api/model-fetch", () => ({
  getModelCatalog: vi.fn(),
  refreshModelCatalog: vi.fn(),
}));

const oldModel = {
  id: "synthetic-old-model",
  displayName: "Synthetic old model",
  source: "vendor" as const,
  ownedBy: "synthetic-vendor",
};
const freshModel = {
  id: "synthetic-new-model",
  displayName: "Synthetic new model",
  source: "vendor" as const,
  ownedBy: "synthetic-vendor",
};

function snapshot(
  models: (typeof oldModel)[],
  refreshing: boolean,
  vendorError: string | null = null,
): ModelCatalogSnapshot {
  return {
    version: 2,
    fetchedAtSecs: 100,
    lastAttemptAtSecs: refreshing ? 200 : 100,
    providerKey: "v2-synthetic-hash",
    models,
    vendorError,
    refreshing,
  };
}

describe("ModelCatalogPanel stale refresh", () => {
  beforeEach(() => {
    i18n.addResourceBundle("zh", "translation", {
      provider: { modelCatalog: zh.provider.modelCatalog },
    });
    vi.mocked(refreshModelCatalog).mockReset();
    vi.mocked(getModelCatalog).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("shows stale models immediately, then swaps to the refreshed catalog", async () => {
    vi.mocked(getModelCatalog)
      .mockResolvedValueOnce(snapshot([oldModel], true))
      .mockResolvedValueOnce(snapshot([freshModel], false));
    const onSnapshotChange = vi.fn();

    render(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey="fake-model-catalog-key"
        onSnapshotChange={onSnapshotChange}
      />,
    );

    expect(
      await screen.findByText("synthetic-old-model", {}, { timeout: 4000 }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      /后台更新|Background/i,
    );
    expect(
      await screen.findByText("synthetic-new-model", {}, { timeout: 4000 }),
    ).toBeVisible();
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onSnapshotChange).toHaveBeenLastCalledWith(
      snapshot([freshModel], false),
    );
    expect(refreshModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps the old models visible when background refresh fails", async () => {
    vi.mocked(getModelCatalog)
      .mockResolvedValueOnce(snapshot([oldModel], true))
      .mockResolvedValueOnce(
        snapshot([oldModel], false, "synthetic gateway unavailable"),
      );

    render(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey="fake-model-catalog-key"
      />,
    );

    expect(
      await screen.findByText("synthetic-old-model", {}, { timeout: 4000 }),
    ).toBeVisible();
    expect(
      await screen.findByText(
        "synthetic gateway unavailable",
        {},
        { timeout: 4000 },
      ),
    ).toBeVisible();
    expect(
      screen.getByText(zh.provider.modelCatalog.errorPrivacyHint),
    ).toBeVisible();
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("provider.modelCatalog.refreshing"),
    ).not.toBeInTheDocument();
  });

  it("refetches when a rotated credential shares the same public prefix", async () => {
    vi.mocked(getModelCatalog)
      .mockResolvedValueOnce(snapshot([oldModel], false))
      .mockResolvedValueOnce(snapshot([freshModel], false));
    const firstCredential = "same-public-prefix-AAAA-private";
    const rotatedCredential = "same-public-prefix-BBBB-private";
    const { rerender } = render(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey={firstCredential}
      />,
    );
    expect(
      await screen.findByText("synthetic-old-model", {}, { timeout: 4000 }),
    ).toBeVisible();

    rerender(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey={rotatedCredential}
      />,
    );
    expect(
      await screen.findByText("synthetic-new-model", {}, { timeout: 4000 }),
    ).toBeVisible();
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getModelCatalog).mock.calls[1]?.[1]).toBe(
      rotatedCredential,
    );
  });

  it("ignores a late result from the previous credential", async () => {
    let resolvePrevious!: (value: ModelCatalogSnapshot) => void;
    const previousRequest = new Promise<ModelCatalogSnapshot>((resolve) => {
      resolvePrevious = resolve;
    });
    vi.mocked(getModelCatalog)
      .mockReturnValueOnce(previousRequest)
      .mockResolvedValueOnce(snapshot([freshModel], false));
    const onSnapshotChange = vi.fn();
    const { rerender } = render(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey="previous-synthetic-key"
        onSnapshotChange={onSnapshotChange}
      />,
    );
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(1));

    rerender(
      <ModelCatalogPanel
        baseUrl="http://127.0.0.1:1/v1"
        apiKey="current-synthetic-key"
        onSnapshotChange={onSnapshotChange}
      />,
    );
    expect(
      await screen.findByText("synthetic-new-model", {}, { timeout: 4000 }),
    ).toBeVisible();
    await waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolvePrevious(snapshot([oldModel], false));
    });
    expect(screen.queryByText("synthetic-old-model")).not.toBeInTheDocument();
    expect(screen.getByText("synthetic-new-model")).toBeVisible();
    expect(onSnapshotChange).toHaveBeenLastCalledWith(
      snapshot([freshModel], false),
    );
  });
});
