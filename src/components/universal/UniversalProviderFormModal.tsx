import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { ProviderIcon } from "@/components/ProviderIcon";
import { universalProvidersApi } from "@/lib/api";
import type {
  Provider,
  SharedChannelApp,
  SharedChannelSaveResult,
  UniversalProvider,
  UniversalProviderConnections,
  UniversalProviderModels,
} from "@/types";
import {
  universalProviderPresets,
  createUniversalProviderFromPreset,
  type UniversalProviderPreset,
} from "@/config/universalProviderPresets";
import { deepClone } from "@/utils/deepClone";

interface UniversalProviderFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (provider: UniversalProvider) => Promise<SharedChannelSaveResult>;
  editingProvider?: UniversalProvider | null;
  initialPreset?: UniversalProviderPreset | null;
  initialApp?: SharedChannelApp;
}

const appDetails = {
  claude: { name: "Claude Code", icon: "claude", native: "anthropic" },
  codex: { name: "Codex", icon: "openai", native: "openai_responses" },
  gemini: { name: "Gemini CLI", icon: "gemini", native: "gemini_native" },
} as const;
const apps = Object.keys(appDetails) as SharedChannelApp[];
const protocolNames = {
  anthropic: "Anthropic Messages",
  openai_responses: "OpenAI Responses",
  openai_chat: "OpenAI Chat Completions",
  gemini_native: "Gemini Native",
} as const;

export function UniversalProviderFormModal({
  isOpen,
  onClose,
  onSave,
  editingProvider,
  initialPreset,
  initialApp,
}: UniversalProviderFormModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<UniversalProvider | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const submitting = useRef(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [failedApps, setFailedApps] = useState<SharedChannelApp[]>([]);
  const [preview, setPreview] = useState<
    Partial<Record<SharedChannelApp, Provider>> | undefined
  >();
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewGeneration = useRef(0);
  const initializedSession = useRef<string | null>(null);

  // Refreshes of the saved list must not overwrite an open draft.
  useEffect(() => {
    if (!isOpen) {
      initializedSession.current = null;
      previewGeneration.current += 1;
      setPreview(undefined);
      setDraft(null);
      return;
    }
    const session = editingProvider?.id ?? "new";
    if (initializedSession.current === session) return;
    initializedSession.current = session;
    const next = editingProvider
      ? deepClone(editingProvider)
      : createUniversalProviderFromPreset(
          initialPreset || universalProviderPresets[0],
          crypto.randomUUID(),
          "",
          "",
        );
    if (!editingProvider) {
      next.apps = {
        claude: initialApp ? initialApp === "claude" : true,
        codex: initialApp ? initialApp === "codex" : true,
        gemini: initialApp === "gemini",
      };
    }
    setDraft(next);
    setShowApiKey(false);
    setErrorKey(null);
    setFailedApps([]);
    setPreview(undefined);
  }, [isOpen, editingProvider, initialPreset, initialApp]);

  const updateDraft = useCallback((patch: Partial<UniversalProvider>) => {
    previewGeneration.current += 1;
    setPreview(undefined);
    setErrorKey(null);
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  }, []);

  const updateConnection = (
    app: SharedChannelApp,
    field: string,
    value: string,
  ) => {
    if (!draft) return;
    updateDraft({
      connections: {
        ...draft.connections,
        [app]: { ...draft.connections?.[app], [field]: value || undefined },
      } as UniversalProviderConnections,
    });
  };

  const updateModel = (app: SharedChannelApp, field: string, value: string) => {
    if (!draft) return;
    updateDraft({
      models: {
        ...draft.models,
        [app]: { ...draft.models[app], [field]: value },
      },
    });
  };

  const valid =
    !!draft?.name.trim() &&
    !!draft?.baseUrl.trim() &&
    !!draft?.apiKey.trim() &&
    apps.some((app) => draft.apps[app]);

  const buildProvider = () => {
    if (!draft) return null;
    return {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      websiteUrl: draft.websiteUrl?.trim() || undefined,
      notes: draft.notes?.trim() || undefined,
    };
  };

  const handleSave = async () => {
    const provider = buildProvider();
    if (!provider || !valid || submitting.current) return;
    submitting.current = true;
    setIsSaving(true);
    setErrorKey(null);
    try {
      const result =
        failedApps.length > 0
          ? await universalProvidersApi.resync(provider.id)
          : await onSave(provider);
      setFailedApps(result.failedApps);
      if (result.failedApps.length === 0) onClose();
    } catch {
      // IPC errors can include configuration values. Show only local, safe guidance.
      setErrorKey("universalProvider.saveErrorHint");
    } finally {
      submitting.current = false;
      setIsSaving(false);
    }
  };

  const handlePreview = async () => {
    const provider = buildProvider();
    if (!provider || !valid || isPreviewing) return;
    const generation = ++previewGeneration.current;
    setIsPreviewing(true);
    setErrorKey(null);
    try {
      const result = await universalProvidersApi.preview(provider);
      if (generation === previewGeneration.current) setPreview(result);
    } catch {
      if (generation === previewGeneration.current) {
        setErrorKey("universalProvider.previewError");
      }
    } finally {
      setIsPreviewing(false);
    }
  };

  const requestClose = () => {
    if (!submitting.current) onClose();
  };

  const modelInput = (
    app: SharedChannelApp,
    field: string,
    label: string,
    placeholder: string,
  ) => {
    const model = draft?.models[app] as Record<string, string> | undefined;
    const id = `shared-${app}-${field}`;
    return (
      <div className="space-y-1" key={field}>
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <Input
          id={id}
          data-testid={`shared-channel-${app}-${field}`}
          value={model?.[field] || ""}
          onChange={(event) => updateModel(app, field, event.target.value)}
          placeholder={placeholder}
        />
      </div>
    );
  };

  return (
    <FullScreenPanel
      isOpen={isOpen}
      title={t(
        editingProvider ? "universalProvider.edit" : "universalProvider.add",
      )}
      onClose={requestClose}
      footer={
        <>
          <Button variant="outline" onClick={requestClose} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="shared-channel-submit"
            onClick={handleSave}
            disabled={!valid || isSaving}
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            {t(
              isSaving
                ? "universalProvider.saving"
                : failedApps.length > 0
                  ? "universalProvider.link.resync"
                  : "universalProvider.saveAndSync",
            )}
          </Button>
        </>
      }
    >
      {draft && (
        <fieldset
          disabled={isSaving || failedApps.length > 0}
          className="space-y-6"
          aria-busy={isSaving}
        >
          <p className="text-sm text-muted-foreground">
            {t("universalProvider.description")}
          </p>
          {errorKey && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
            >
              {t(errorKey)}
            </p>
          )}
          {failedApps.length > 0 && (
            <div
              role="status"
              className="rounded-lg border border-amber-500/40 p-3 text-sm"
            >
              {t("universalProvider.partialSync", {
                apps: failedApps.map((app) => appDetails[app].name).join(", "),
              })}
            </div>
          )}
          {!editingProvider && (
            <div className="space-y-3">
              <Label>{t("universalProvider.selectPreset")}</Label>
              <div className="flex flex-wrap gap-2">
                {universalProviderPresets.map((preset) => (
                  <Button
                    key={preset.providerType}
                    variant={
                      draft.providerType === preset.providerType
                        ? "default"
                        : "outline"
                    }
                    aria-pressed={draft.providerType === preset.providerType}
                    onClick={() =>
                      updateDraft({
                        providerType: preset.providerType,
                        name: preset.isCustomTemplate ? "" : preset.name,
                        models: deepClone(
                          preset.defaultModels,
                        ) as UniversalProviderModels,
                        websiteUrl: preset.websiteUrl,
                        icon: preset.icon,
                        iconColor: preset.iconColor,
                      })
                    }
                  >
                    <ProviderIcon
                      icon={preset.icon}
                      name={preset.name}
                      size={16}
                    />
                    {preset.isCustomTemplate
                      ? t("universalProvider.customGateway")
                      : preset.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t("universalProvider.name")}</Label>
              <Input
                id="name"
                data-testid="shared-channel-name"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder={t("universalProvider.namePlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="baseUrl">{t("universalProvider.baseUrl")}</Label>
              <Input
                id="baseUrl"
                data-testid="shared-channel-base-url"
                type="url"
                value={draft.baseUrl}
                onChange={(event) =>
                  updateDraft({ baseUrl: event.target.value })
                }
                placeholder="https://api.example.com"
              />
              <p className="text-xs text-muted-foreground">
                {t("universalProvider.baseUrlHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">{t("universalProvider.apiKey")}</Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  data-testid="shared-channel-api-key"
                  type={showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) =>
                    updateDraft({ apiKey: event.target.value })
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-..."
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={t(
                    showApiKey
                      ? "universalProvider.hideKey"
                      : "universalProvider.showKey",
                  )}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <Label>{t("universalProvider.enabledApps")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("universalProvider.appsHint")}
            </p>
            {apps.map((app) => {
              const detail = appDetails[app];
              const protocol =
                app === "gemini"
                  ? "gemini_native"
                  : draft.connections?.[app]?.apiFormat ||
                    draft.meta?.apiFormat ||
                    detail.native;
              const needsRouting = protocol !== detail.native;
              return (
                <div key={app} className="space-y-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <Label
                      htmlFor={`shared-${app}-enabled`}
                      className="flex items-center gap-2 font-medium"
                    >
                      <ProviderIcon
                        icon={detail.icon}
                        name={detail.name}
                        size={20}
                      />
                      {detail.name}
                    </Label>
                    <Switch
                      id={`shared-${app}-enabled`}
                      data-testid={`shared-channel-app-${app}`}
                      checked={draft.apps[app]}
                      onCheckedChange={(checked) =>
                        updateDraft({ apps: { ...draft.apps, [app]: checked } })
                      }
                    />
                  </div>
                  {draft.childIds?.[app] && (
                    <p className="text-sm text-muted-foreground">
                      {t("universalProvider.link.disableHint")}
                    </p>
                  )}
                  {draft.apps[app] && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label
                          htmlFor={`shared-${app}-baseUrl`}
                          className="text-xs"
                        >
                          {t("universalProvider.appBaseUrl")}
                        </Label>
                        <Input
                          id={`shared-${app}-baseUrl`}
                          type="url"
                          value={draft.connections?.[app]?.baseUrl || ""}
                          onChange={(event) =>
                            updateConnection(app, "baseUrl", event.target.value)
                          }
                          placeholder={
                            draft.baseUrl || "https://api.example.com"
                          }
                        />
                      </div>
                      {app !== "gemini" && (
                        <div className="space-y-1">
                          <Label
                            htmlFor={`shared-${app}-apiFormat`}
                            className="text-xs"
                          >
                            {t("universalProvider.protocol")}
                          </Label>
                          <select
                            id={`shared-${app}-apiFormat`}
                            value={protocol}
                            onChange={(event) =>
                              updateConnection(
                                app,
                                "apiFormat",
                                event.target.value,
                              )
                            }
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {Object.entries(protocolNames)
                              .filter(
                                ([value]) =>
                                  app === "claude" || value !== "gemini_native",
                              )
                              .map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                      {needsRouting && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {t("universalProvider.routingRequired")}
                        </p>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {modelInput(
                          app,
                          "model",
                          t("universalProvider.model"),
                          "",
                        )}
                        {app === "claude" && (
                          <>
                            {modelInput(app, "haikuModel", "Haiku", "")}
                            {modelInput(app, "sonnetModel", "Sonnet", "")}
                            {modelInput(app, "opusModel", "Opus", "")}
                          </>
                        )}
                        {app === "codex" &&
                          modelInput(
                            app,
                            "reasoningEffort",
                            t("universalProvider.reasoningEffort"),
                            "high",
                          )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!apps.some((app) => draft.apps[app]) && (
              <p role="alert" className="text-sm text-destructive">
                {t("universalProvider.selectApp")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("universalProvider.modelHint")}
            </p>
          </div>
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t("universalProvider.optionalDetails")}
            </summary>
            <div className="mt-4 space-y-3">
              <Label htmlFor="websiteUrl">
                {t("universalProvider.websiteUrl")}
              </Label>
              <Input
                id="websiteUrl"
                type="url"
                value={draft.websiteUrl || ""}
                onChange={(event) =>
                  updateDraft({ websiteUrl: event.target.value })
                }
                placeholder="https://example.com"
              />
              <Label htmlFor="notes">{t("universalProvider.notes")}</Label>
              <Input
                id="notes"
                value={draft.notes || ""}
                onChange={(event) => updateDraft({ notes: event.target.value })}
              />
            </div>
          </details>
          <div className="space-y-3">
            <Button
              variant="outline"
              onClick={handlePreview}
              disabled={!valid || isPreviewing}
            >
              {isPreviewing && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              {t("universalProvider.configJsonPreview")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("universalProvider.configJsonPreviewHint")}
            </p>
            {preview &&
              apps
                .filter((app) => preview[app])
                .map((app) => (
                  <div key={app} className="space-y-2">
                    <h3 className="text-sm font-medium">
                      {appDetails[app].name}
                    </h3>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                      {JSON.stringify(preview[app]?.settingsConfig, null, 2)}
                    </pre>
                  </div>
                ))}
          </div>
        </fieldset>
      )}
    </FullScreenPanel>
  );
}
