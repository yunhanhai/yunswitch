import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getAppLabel, PROXY_APP_IDS } from "@/config/appConfig";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { proxyApi } from "@/lib/api/proxy";
import type {
  RequestDetail,
  RequestPhase,
  RequestStep,
  RequestSummary,
} from "@/types/requestDiagnostics";

const key = "proxy.requestDiagnostics";
const apps = [...PROXY_APP_IDS, "claude-desktop"];
const phaseVariants: Partial<
  Record<RequestPhase, "default" | "destructive" | "outline">
> = {
  succeeded: "default",
  failed: "destructive",
  timedOut: "destructive",
  cancelled: "outline",
  unconfirmed: "outline",
};

function duration(ms: number, language: string) {
  const seconds = ms >= 1000;
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: seconds ? "second" : "millisecond",
    unitDisplay: "short",
    maximumFractionDigits: 2,
  }).format(seconds ? ms / 1000 : ms);
}

function PhaseBadge({ phase }: { phase: RequestPhase }) {
  const { t } = useTranslation();
  return (
    <span
      className={badgeVariants({
        variant: phaseVariants[phase] ?? "secondary",
      })}
    >
      {t(`${key}.phases.${phase}`)}
    </span>
  );
}

function StepFacts({ step }: { step: RequestStep }) {
  const { t, i18n } = useTranslation();
  const format = (ms: number) => duration(ms, i18n.language);
  const facts = [
    step.reason && t(`${key}.reasons.${step.reason}`),
    step.recoveryBudgetRemainingMs !== undefined &&
      t(`${key}.recoveryBudgetRemaining`, {
        time: format(step.recoveryBudgetRemainingMs),
      }),
    step.plannedWaitMs !== undefined &&
      t(`${key}.planned`, { time: format(step.plannedWaitMs) }),
    step.waitLimitMs !== undefined &&
      t(`${key}.limit`, { time: format(step.waitLimitMs) }),
    step.error &&
      [
        t(`${key}.errors.${step.error.class}`),
        step.error.httpStatus && `HTTP ${step.error.httpStatus}`,
      ]
        .filter(Boolean)
        .join(" · "),
  ].filter(Boolean);

  return facts.length > 0 ? (
    <span className="block text-xs leading-relaxed text-muted-foreground">
      {facts.join(" · ")}
    </span>
  ) : null;
}

function RequestTimeline({ detail }: { detail: RequestDetail }) {
  const { t, i18n } = useTranslation();
  const format = (ms: number) => duration(ms, i18n.language);
  const [copyResult, setCopyResult] = useState<"copied" | "copyFailed" | null>(
    null,
  );
  const [showLabels, setShowLabels] = useState(false);
  const labels = useQuery({
    queryKey: ["requestDiagnosticProviderLabels", detail.id, detail.attempts],
    queryFn: () => proxyApi.getRequestDiagnosticProviderLabels(detail.id),
    enabled: showLabels,
    gcTime: 0,
  });
  const copy = async () => {
    try {
      await copyText(JSON.stringify({ schemaVersion: 1, ...detail }, null, 2));
      setCopyResult("copied");
    } catch {
      setCopyResult("copyFailed");
    }
  };

  return (
    <div className="space-y-3 border-t border-border/60 p-3">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t(`${key}.id`)}</p>
        <code className="block break-all text-xs">{detail.id}</code>
        <p className="text-xs text-muted-foreground">
          {new Intl.DateTimeFormat(i18n.language, {
            dateStyle: "short",
            timeStyle: "medium",
          }).format(detail.startedAtMs)}
        </p>
      </div>
      {detail.omittedSteps > 0 && (
        <p className="text-xs text-muted-foreground">
          {t(`${key}.omitted`, { count: detail.omittedSteps })}
        </p>
      )}
      {detail.steps.some((step) => step.providerRef) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={showLabels}
            onClick={() => setShowLabels(!showLabels)}
          >
            {t(`${key}.localLabels`)}
          </Button>
          {showLabels && (
            <span role="status" className="text-xs text-muted-foreground">
              {t(
                `${key}.${labels.isError ? "labelsFailed" : labels.isPending ? "loading" : "labelsHint"}`,
              )}
            </span>
          )}
        </div>
      )}
      <ol className="divide-y divide-border/60 border-y border-border/60">
        {detail.steps.map((step, index) => (
          <li
            key={index}
            data-diagnostic-step={step.phase}
            className="space-y-1 py-2"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <PhaseBadge phase={step.phase} />
              <span className="text-xs tabular-nums text-muted-foreground">
                +{format(step.offsetMs)}
                {step.elapsedMs > 0 &&
                  ` · ${t(`${key}.elapsed`, { time: format(step.elapsedMs) })}`}
              </span>
              {step.attempt > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t(`${key}.attempt`, { count: step.attempt })}
                </span>
              )}
            </div>
            {(step.providerRef || step.model) && (
              <p className="break-all text-xs text-muted-foreground">
                {[
                  step.providerRef &&
                    t(`${key}.provider`, {
                      name:
                        showLabels && labels.data?.[step.providerRef]
                          ? `${labels.data[step.providerRef]} (${step.providerRef})`
                          : step.providerRef,
                    }),
                  step.model && t(`${key}.model`, { name: step.model }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <StepFacts step={step} />
          </li>
        ))}
      </ol>
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`${key}.copyScope`)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            data-diagnostic-copy
            onClick={() => void copy()}
          >
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
            {t(`${key}.copy`)}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {copyResult && t(`${key}.${copyResult}`)}
          </span>
        </div>
      </div>
    </div>
  );
}

function RequestRow({
  request,
  active,
  selected,
  onSelect,
}: {
  request: RequestSummary;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const rowId = useId();
  const detail = useQuery({
    queryKey: ["requestDiagnosticDetail", request.id, request.current.phase],
    queryFn: () => proxyApi.getRequestDiagnosticDetail(request.id),
    enabled: selected,
    refetchInterval: selected && active ? 1000 : false,
    gcTime: 0,
  });

  return (
    <li
      data-diagnostic-id={request.id}
      data-diagnostic-phase={request.current.phase}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={selected}
        aria-controls={selected ? rowId : undefined}
        onClick={onSelect}
      >
        <span className="block min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">
              {getAppLabel(request.appType)}
            </span>
            <code className="text-xs text-muted-foreground">
              {request.id.slice(0, 8)}
            </code>
            <PhaseBadge phase={request.current.phase} />
          </span>
          <span className="block break-all text-xs text-muted-foreground tabular-nums">
            {[
              request.current.providerRef,
              request.current.model,
              t(`${key}.attempts`, { count: request.attempts }),
              t(`${key}.elapsed`, {
                time: duration(request.elapsedMs, i18n.language),
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <StepFacts step={request.current} />
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-muted-foreground ${selected ? "rotate-180" : ""}`}
        />
      </button>
      {selected && (
        <div id={rowId}>
          {detail.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {t(`${key}.loadFailed`)}
            </p>
          ) : detail.isPending ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {t(`${key}.loading`)}
            </p>
          ) : detail.data ? (
            <RequestTimeline detail={detail.data} />
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t(`${key}.expired`)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function RequestDiagnosticsPanel({ running }: { running: boolean }) {
  const { t } = useTranslation();
  const [app, setApp] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const snapshot = useQuery({
    queryKey: ["requestDiagnostics"],
    queryFn: proxyApi.getRequestDiagnostics,
    refetchInterval: running ? 1000 : 5000,
    gcTime: 0,
  });

  const groups = [
    { key: "active", rows: snapshot.data?.active ?? [] },
    { key: "recent", rows: snapshot.data?.recent ?? [] },
  ] as const;

  return (
    <div className="space-y-4" data-request-diagnostics>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          {t(`${key}.filter`)}
          <select
            className="min-h-10 rounded-md border border-input bg-background px-2"
            value={app}
            onChange={(event) => {
              setApp(event.target.value);
              setSelectedId(undefined);
            }}
          >
            <option value="all">{t(`${key}.allApps`)}</option>
            {apps.map((appType) => (
              <option key={appType} value={appType}>
                {getAppLabel(appType)}
              </option>
            ))}
          </select>
        </label>
        {!running && (
          <Badge variant="outline">
            {t("settings.advanced.proxy.stopped")}
          </Badge>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(`${key}.retention`)}
      </p>
      {snapshot.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          {t(`${key}.loadFailed`)}
          <Button
            type="button"
            variant="outline"
            onClick={() => void snapshot.refetch()}
          >
            {t(`${key}.refresh`)}
          </Button>
        </div>
      ) : snapshot.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(`${key}.loading`)}
        </p>
      ) : (
        <>
          {snapshot.data.untrackedActive > 0 && (
            <p className="text-sm text-muted-foreground">
              {t(`${key}.overflow`, { count: snapshot.data.untrackedActive })}
            </p>
          )}
          {groups.map(({ key: group, rows }) => {
            const filtered = rows.filter(
              (row) => app === "all" || row.appType === app,
            );
            return (
              <section
                key={group}
                className="space-y-2"
                data-diagnostic-group={group}
              >
                <h4 className="text-sm font-semibold">
                  {t(`${key}.${group}`, { count: filtered.length })}
                </h4>
                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t(`${key}.${group}Empty`)}
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                    {filtered.map((request) => (
                      <RequestRow
                        key={request.id}
                        request={request}
                        active={group === "active"}
                        selected={selectedId === request.id}
                        onSelect={() =>
                          setSelectedId((id) =>
                            id === request.id ? undefined : request.id,
                          )
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
