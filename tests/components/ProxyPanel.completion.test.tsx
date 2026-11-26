import { render, screen, within } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyPanel } from "@/components/proxy/ProxyPanel";
import type { ProxyStatus } from "@/types/proxy";
import zh from "@/i18n/locales/zh.json";

const { statusQuery } = vi.hoisted(() => ({ statusQuery: vi.fn() }));
vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: statusQuery,
  useProxyTakeoverStatus: () => ({ data: {} }),
  useSetProxyTakeoverForApp: () => ({ mutateAsync: vi.fn() }),
  useGlobalProxyConfig: () => ({ data: undefined }),
  useUpdateGlobalProxyConfig: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/components/proxy/ResilienceSummaryBar", () => ({
  ResilienceSummaryBar: () => null,
}));
vi.mock("@/components/proxy/RoutingGroupsPanel", () => ({
  RoutingGroupsPanel: () => null,
}));
vi.mock("@/components/proxy/ModelAliasPanel", () => ({
  ModelAliasPanel: () => null,
}));

const status: ProxyStatus = {
  running: true,
  address: "127.0.0.1",
  port: 15731,
  active_connections: 0,
  total_requests: 0,
  success_requests: 0,
  failed_requests: 0,
  pending_requests: 0,
  cancelled_requests: 0,
  timed_out_requests: 0,
  unconfirmed_requests: 0,
  success_rate: 0,
  uptime_seconds: 10,
  current_provider: null,
  current_provider_id: null,
  last_request_at: null,
  last_error: null,
  failover_count: 0,
};

function renderPanel(value: ProxyStatus) {
  statusQuery.mockReturnValue({ data: value });
  return render(
    <ProxyPanel
      enableLocalProxy
      onEnableLocalProxyChange={vi.fn()}
      onToggleProxy={vi.fn().mockResolvedValue(undefined)}
      isProxyPending={false}
    />,
  );
}

describe("proxy completion results", () => {
  beforeEach(() => {
    i18n.addResourceBundle("zh", "translation", zh, true, true);
  });

  it("does not present pending, cancelled or unconfirmed requests as a zero success rate", () => {
    renderPanel({
      ...status,
      total_requests: 9,
      pending_requests: 4,
      cancelled_requests: 2,
      unconfirmed_requests: 3,
    });
    expect(screen.getByText("暂无结果")).toBeVisible();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
    expect(
      screen.getByText(zh.proxy.panel.stats.successRateScope),
    ).toBeVisible();
  });

  it("shows the final outcome counts separately and the backend's completed-request success rate", () => {
    renderPanel({
      ...status,
      total_requests: 22,
      success_requests: 5,
      failed_requests: 2,
      timed_out_requests: 1,
      cancelled_requests: 3,
      unconfirmed_requests: 4,
      pending_requests: 7,
      success_rate: 62.5,
    });
    expect(screen.getByText("62.5%")).toBeVisible();
    const outcomes = within(
      screen.getByRole("heading", { name: "请求结果" }).parentElement!,
    );
    for (const [label, count] of [
      ["已成功", "5"],
      ["已失败", "2"],
      ["已超时", "1"],
      ["已取消", "3"],
      ["结果未确认", "4"],
      ["进行中", "7"],
    ]) {
      expect(
        within(outcomes.getByText(label).parentElement!).getByText(count),
      ).toBeVisible();
    }
  });
});
