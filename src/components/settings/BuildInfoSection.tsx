import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { settingsApi, type BuildInfo } from "@/lib/api/settings";

export function BuildInfoSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    settingsApi.getBuildInfo().then(
      (value) => {
        if (active) setInfo(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const copyBuildInfo = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            version: info.version,
            sourceCommit: info.sourceCommit,
            target: info.target,
          },
          null,
          2,
        ),
      );
      toast.success(t("settings.buildInfo.copied"));
    } catch {
      toast.error(t("settings.buildInfo.copyFailed"));
    }
  };

  return (
    <section
      aria-label={t("settings.buildInfo.title")}
      data-testid="build-info"
      className="space-y-2 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-medium">{t("settings.buildInfo.title")}</h5>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="copy-build-info"
          disabled={!info}
          onClick={copyBuildInfo}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.buildInfo.copy")}
        </Button>
      </div>
      {info ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">
              {t("settings.buildInfo.source")}
            </dt>
            <dd
              className="font-mono break-all"
              data-testid="build-source"
              data-source-commit={info.sourceCommit ?? ""}
            >
              {info.sourceCommit?.slice(0, 12) ??
                t("settings.buildInfo.sourceUnknown")}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">
              {t("settings.buildInfo.target")}
            </dt>
            <dd className="font-mono break-all" data-testid="build-target">
              {info.target}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {t(failed ? "settings.buildInfo.loadFailed" : "common.loading")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings.buildInfo.copyHint")}
      </p>
    </section>
  );
}
