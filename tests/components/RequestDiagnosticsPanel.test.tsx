import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestDiagnosticsPanel } from "@/components/proxy/RequestDiagnosticsPanel";
import { proxyApi } from "@/lib/api/proxy";
import { copyText } from "@/lib/clipboard";
import zh from "@/i18n/locales/zh.json";
import type { RequestDetail, RequestSummary } from "@/types/requestDiagnostics";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

const cooling: RequestSummary = {
  id: "cooling-request-local-id",
  appType: "codex",
  startedAtMs: Date.UTC(2026, 0, 1),
  elapsedMs: 1500,
  attempts: 1,
  current: {
    phase: "coolingDown",
    providerRef: "p-ab12",
    model: "m-2345",
    offsetMs: 500,
    elapsedMs: 1000,
    plannedWaitMs: 5000,
    recoveryBudgetRemainingMs: 8000,
    reason: "sharedCooldown",
    attempt: 1,
  },
};
const queued: RequestSummary = {
  ...cooling,
  id: "queued-request-local-id",
  current: {
    ...cooling.current,
    phase: "recoveryQueued",
    reason: "recoveryPermit",
    plannedWaitMs: undefined,
    waitLimitMs: 7200,
  },
};
const completed: RequestSummary = {
  ...cooling,
  id: "completed-request-local-id",
  appType: "gemini",
  current: {
    phase: "failed",
    offsetMs: 1500,
    elapsedMs: 0,
    attempt: 1,
    error: { class: "rateLimited", httpStatus: 429 },
  },
};

describe("request diagnostics", () => {
  beforeEach(() => {
    i18n.addResourceBundle("zh", "translation", {
      proxy: { requestDiagnostics: zh.proxy.requestDiagnostics },
    });
  });

  it("keeps concurrent waits visible with distinct reasons and filters by application", async () => {
    vi.spyOn(proxyApi, "getRequestDiagnostics").mockResolvedValue({
      active: [cooling, queued],
      recent: [completed],
      untrackedActive: 0,
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <RequestDiagnosticsPanel running />
      </QueryClientProvider>,
    );

    const active = await screen.findByRole("heading", { name: "活跃请求 · 2" });
    const section = within(active.parentElement!);
    expect(section.getByText("等待 429 冷却")).toBeVisible();
    expect(section.getByText("排队等待恢复许可")).toBeVisible();
    expect(section.getByText(/计划等待/)).toBeVisible();
    expect(section.getAllByText(/输出前预算剩余/).length).toBeGreaterThan(0);
    expect(section.getByText(/排队上限/)).toBeVisible();
    expect(section.getAllByText(/实际耗时/)).toHaveLength(2);
    expect(screen.getByText(/HTTP 429/)).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox"), "gemini");
    expect(screen.getByText("该应用暂无活跃请求。")).toBeVisible();
    expect(screen.getByText("已失败")).toBeVisible();
  });

  it("shows a stopped request and copies only the redacted diagnostic record", async () => {
    const current = {
      phase: "cancelled",
      attempt: 1,
      offsetMs: 2000,
      elapsedMs: 0,
      reason: "proxyStopped",
      providerRef: "p-ab12",
      model: "m-2345",
    } as const;
    const stopped: RequestDetail = {
      ...cooling,
      current,
      steps: [cooling.current, current],
      omittedSteps: 0,
    };
    vi.spyOn(proxyApi, "getRequestDiagnostics").mockResolvedValue({
      active: [],
      recent: [stopped],
      untrackedActive: 0,
    });
    vi.spyOn(proxyApi, "getRequestDiagnosticDetail").mockResolvedValue(stopped);
    vi.spyOn(proxyApi, "getRequestDiagnosticProviderLabels").mockResolvedValue({
      "p-ab12": "Private local provider label",
    });
    vi.mocked(copyText).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <RequestDiagnosticsPanel running={false} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /已取消/ }));
    expect(await screen.findByText(stopped.id)).toBeVisible();
    expect(screen.getByText(/密钥、请求和响应正文/)).toBeVisible();
    expect(proxyApi.getRequestDiagnosticProviderLabels).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "显示本机供应商名称" }),
    );
    expect(
      (await screen.findAllByText(/Private local provider label/)).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "复制脱敏摘要" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledOnce());
    const exported = vi.mocked(copyText).mock.calls[0][0];
    expect(JSON.parse(exported)).toEqual({ schemaVersion: 1, ...stopped });
    expect(exported).not.toContain("Private local provider label");
  });
});
