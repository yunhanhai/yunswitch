import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Loader2, RefreshCw } from "lucide-react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { universalProvidersApi } from "@/lib/api";
import type {
  SharedChannelLinkApp,
  SharedChannelLinkCandidates,
  SharedChannelLinkPreview,
  SharedChannelLinkRequest,
  SharedChannelLinkResult,
} from "@/types";

interface SharedChannelLinkModalProps {
  onClose: () => void;
  onLinked: () => Promise<void>;
}

const apps = ["claude", "codex"] as const;
const appNames = { claude: "Claude Code", codex: "Codex" };
const protocolNames: Record<string, string> = {
  anthropic: "Anthropic Messages",
  openai_responses: "OpenAI Responses",
  openai_chat: "OpenAI Chat Completions",
};
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** This flow receives only safe candidate labels and a whitelisted preview. */
export function SharedChannelLinkModal({
  onClose,
  onLinked,
}: SharedChannelLinkModalProps) {
  const { t } = useTranslation();
  const [channelId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [selected, setSelected] = useState({ claude: "", codex: "" });
  const [keySource, setKeySource] = useState<SharedChannelLinkApp | "">("");
  const [candidates, setCandidates] =
    useState<SharedChannelLinkCandidates | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [preview, setPreview] = useState<{
    request: SharedChannelLinkRequest;
    result: SharedChannelLinkPreview;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState<SharedChannelLinkResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const previewGeneration = useRef(0);
  const listGeneration = useRef(0);
  const submitting = useRef(false);

  const invalidatePreview = useCallback(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewing(false);
    setError(null);
  }, []);

  const loadCandidates = useCallback(async () => {
    const generation = ++listGeneration.current;
    invalidatePreview();
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await universalProvidersApi.listLinkCandidates();
      if (mounted.current && generation === listGeneration.current) {
        setCandidates(result);
      }
    } catch {
      if (mounted.current && generation === listGeneration.current) {
        setCandidates(null);
        setLoadFailed(true);
      }
    } finally {
      if (mounted.current && generation === listGeneration.current) {
        setLoading(false);
      }
    }
  }, [invalidatePreview]);

  useEffect(() => {
    mounted.current = true;
    void loadCandidates();
    return () => {
      mounted.current = false;
      previewGeneration.current += 1;
      listGeneration.current += 1;
    };
  }, [loadCandidates]);

  useEffect(() => {
    if (!preview || saving) return;
    const timer = window.setTimeout(
      () => {
        setPreview(null);
        setError("expired");
      },
      Math.max(0, preview.result.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [preview, saving]);

  const valid =
    name.trim().length > 0 &&
    keySource !== "" &&
    !loading &&
    apps.every((app) =>
      candidates?.[app].some(
        (candidate) => candidate.id === selected[app] && candidate.eligible,
      ),
    );

  const requestClose = () => {
    if (submitting.current) return;
    previewGeneration.current += 1;
    onClose();
  };

  const handlePreview = async () => {
    if (!valid || !keySource || previewing || submitting.current || committed)
      return;
    const request: SharedChannelLinkRequest = {
      channelId,
      name: name.trim(),
      claudeProviderId: selected.claude,
      codexProviderId: selected.codex,
      keySource,
    };
    const generation = ++previewGeneration.current;
    setPreview(null);
    setPreviewing(true);
    setError(null);
    try {
      const result = await universalProvidersApi.previewLink(request);
      if (!mounted.current || generation !== previewGeneration.current) return;
      if (result.expiresAt <= Date.now()) {
        setError("expired");
      } else {
        setPreview({ request, result });
      }
    } catch {
      if (mounted.current && generation === previewGeneration.current) {
        setError("previewError");
      }
    } finally {
      if (mounted.current && generation === previewGeneration.current) {
        setPreviewing(false);
      }
    }
  };

  const handleConfirm = async () => {
    if (!preview || submitting.current || committed) return;
    if (preview.result.expiresAt <= Date.now()) {
      setPreview(null);
      setError("expired");
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await universalProvidersApi.linkExisting(
        preview.request,
        preview.result.token,
      );
      if (!mounted.current) return;
      setCommitted(result);
      setPreview(null);
      // Refresh failure cannot undo a committed relationship.
      await onLinked().catch(() => undefined);
      if (mounted.current && result.failedApps.length === 0) onClose();
    } catch {
      if (mounted.current) {
        // Never render an upstream/IPC message or a serialized configuration.
        setPreview(null);
        setError("confirmError");
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const handleResync = async () => {
    if (!committed || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await universalProvidersApi.resync(committed.channelId);
      if (!mounted.current) return;
      setCommitted({ ...result, channelId: committed.channelId });
      await onLinked().catch(() => undefined);
      if (mounted.current && result.failedApps.length === 0) onClose();
    } catch {
      if (mounted.current) setError("resyncError");
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <FullScreenPanel
      isOpen
      title={t("universalProvider.link.open")}
      onClose={requestClose}
      footer={
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            data-testid="link-channel-cancel"
            variant="outline"
            disabled={saving}
            onClick={requestClose}
          >
            {t(committed ? "common.close" : "common.cancel")}
          </Button>
          {committed ? (
            <Button
              data-testid="link-channel-resync"
              disabled={saving}
              onClick={handleResync}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              {t("universalProvider.link.resync")}
            </Button>
          ) : preview ? (
            <Button
              data-testid="link-channel-confirm"
              disabled={saving}
              onClick={handleConfirm}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-1.5 h-4 w-4" />
              )}
              {t("universalProvider.link.confirm")}
            </Button>
          ) : (
            <Button
              data-testid="link-channel-preview"
              disabled={!valid || previewing || saving}
              onClick={handlePreview}
            >
              {previewing && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              {t("universalProvider.link.preview")}
            </Button>
          )}
        </div>
      }
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <p className="text-sm text-muted-foreground">
          {t("universalProvider.link.description")}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t(`universalProvider.link.${error}`)}
          </p>
        )}
        {committed ? (
          <div role="status" className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">
              {t("universalProvider.link.partialTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("universalProvider.link.partialDescription", {
                apps: committed.failedApps
                  .map((app) => t(`apps.${app}`))
                  .join(", "),
              })}
            </p>
          </div>
        ) : (
          <>
            <fieldset
              disabled={saving}
              aria-busy={saving}
              className="space-y-5"
            >
              <div className="space-y-2">
                <Label htmlFor="link-channel-name">
                  {t("universalProvider.name")}
                </Label>
                <Input
                  id="link-channel-name"
                  data-testid="link-channel-name"
                  value={name}
                  autoFocus
                  onChange={(event) => {
                    invalidatePreview();
                    setName(event.target.value);
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">
                  {t("universalProvider.link.configurations")}
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loading || saving}
                  onClick={() => void loadCandidates()}
                >
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                  {t("common.refresh")}
                </Button>
              </div>
              {loading && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("common.loading")}
                </p>
              )}
              {loadFailed && (
                <p role="alert" className="text-sm text-destructive">
                  {t("universalProvider.link.loadError")}
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {apps.map((app) => (
                  <div key={app} className="min-w-0 space-y-2">
                    <Label htmlFor={`link-channel-${app}`}>
                      {appNames[app]}
                    </Label>
                    <select
                      id={`link-channel-${app}`}
                      data-testid={`link-channel-${app}`}
                      className={selectClassName}
                      value={selected[app]}
                      disabled={loading || loadFailed}
                      onChange={(event) => {
                        invalidatePreview();
                        setSelected({ ...selected, [app]: event.target.value });
                      }}
                    >
                      <option value="">
                        {t("universalProvider.link.chooseConfiguration")}
                      </option>
                      {candidates?.[app].map((candidate) => (
                        <option
                          key={candidate.id}
                          value={candidate.id}
                          disabled={!candidate.eligible}
                        >
                          {candidate.name}
                          {!candidate.eligible &&
                            ` — ${t(`universalProvider.link.reasons.${candidate.reason ?? "unsupported_config"}`)}`}
                        </option>
                      ))}
                    </select>
                    {!loading &&
                      !loadFailed &&
                      !candidates?.[app].some(
                        (candidate) => candidate.eligible,
                      ) && (
                        <p className="text-sm text-muted-foreground">
                          {t("universalProvider.link.empty", {
                            app: appNames[app],
                          })}
                        </p>
                      )}
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label htmlFor="link-channel-key-source">
                  {t("universalProvider.link.keySource")}
                </Label>
                <select
                  id="link-channel-key-source"
                  data-testid="link-channel-key-source"
                  className={selectClassName}
                  value={keySource}
                  onChange={(event) => {
                    invalidatePreview();
                    setKeySource(
                      event.target.value as SharedChannelLinkApp | "",
                    );
                  }}
                >
                  <option value="">
                    {t("universalProvider.link.chooseKeySource")}
                  </option>
                  {apps.map((app) => (
                    <option key={app} value={app}>
                      {t("universalProvider.link.useKey", {
                        app: appNames[app],
                      })}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-muted-foreground">
                  {t("universalProvider.link.keyHint")}
                </p>
              </div>
            </fieldset>
            {preview && (
              <section className="space-y-4 border-t pt-5" aria-live="polite">
                <h3 className="font-medium">
                  {t("universalProvider.link.reviewTitle")}
                </h3>
                <p className="text-sm">
                  {t(
                    preview.result.credentialsDiffer
                      ? "universalProvider.link.differentKeys"
                      : "universalProvider.link.sameKey",
                    {
                      source: appNames[preview.result.keySource],
                      target:
                        appNames[
                          preview.result.keySource === "claude"
                            ? "codex"
                            : "claude"
                        ],
                    },
                  )}
                </p>
                <div className="divide-y rounded-lg border px-4">
                  {preview.result.apps.map((app) => (
                    <div key={app.app} className="space-y-2 py-4">
                      <h4 className="break-words text-sm font-medium">
                        {appNames[app.app]} · {app.name}
                      </h4>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-muted-foreground">
                          {t("universalProvider.link.endpoint")}
                        </dt>
                        <dd className="break-all">{app.baseUrl}</dd>
                        <dt className="text-muted-foreground">
                          {t("universalProvider.protocol")}
                        </dt>
                        <dd>
                          {protocolNames[app.apiFormat] ??
                            t("universalProvider.link.protocolUnknown")}
                        </dd>
                        <dt className="text-muted-foreground">
                          {t("universalProvider.link.model")}
                        </dt>
                        <dd className="break-words">
                          {app.model ||
                            t("universalProvider.link.defaultModel")}
                        </dd>
                        <dt className="text-muted-foreground">
                          {t("universalProvider.link.selection")}
                        </dt>
                        <dd>
                          {t(
                            app.current
                              ? "universalProvider.link.keepCurrent"
                              : "universalProvider.link.keepInactive",
                          )}
                        </dd>
                      </dl>
                      {app.apiFormat !==
                        (app.app === "claude"
                          ? "anthropic"
                          : "openai_responses") && (
                        <p className="text-sm text-muted-foreground">
                          {t("universalProvider.routingRequired")}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("universalProvider.link.preservation")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("universalProvider.link.previewHint")}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </FullScreenPanel>
  );
}
