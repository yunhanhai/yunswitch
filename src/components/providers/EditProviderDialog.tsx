import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderDraftGuard } from "./ProviderDraftGuard";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import type { Provider } from "@/types";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { AuthSettingsPanel } from "@/components/providers/AuthSettingsPanel";
import {
  openclawApi,
  providersApi,
  vscodeApi,
  type AppId,
  type ManagedAuthProvider,
} from "@/lib/api";
import { extractCodexExperimentalBearerToken } from "@/utils/providerConfigUtils";
import { getSharedChannelId } from "@/utils/sharedChannel";
import { deepClone } from "@/utils/deepClone";

interface EditProviderDialogProps {
  open: boolean;
  provider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: {
    provider: Provider;
    originalId?: string;
  }) => Promise<void> | void;
  onManageSharedChannel?: (provider: Provider) => void;
  appId: AppId;
  isProxyTakeover?: boolean; // 代理接管模式下不读取 live（避免显示被接管后的代理配置）
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hasAuthMaterial = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

/**
 * Rebuild the provider auth only for a current Codex provider's live snapshot.
 *
 * In official-auth-preservation mode, live config.toml owns the active
 * provider bearer while the shared auth.json may belong to another provider or
 * contain the user's ChatGPT login. Stored provider auth remains the template:
 * this mirrors the backend switch-away backfill and avoids copying shared auth
 * material into the provider row. DB snapshots and presets must keep their
 * normal auth-first precedence.
 */
const reconcileCodexLiveAuth = (
  liveSettings: Record<string, unknown>,
  storedSettings: Record<string, unknown> | null,
  category: string | undefined,
): Record<string, unknown> => {
  if (category === "official") return liveSettings;

  const configText =
    typeof liveSettings.config === "string" ? liveSettings.config : "";
  const bearer = extractCodexExperimentalBearerToken(configText);
  if (!bearer) return liveSettings;

  const storedAuth = asRecord(storedSettings?.auth);
  const authTemplate = storedAuth ?? asRecord(liveSettings.auth) ?? {};
  const hasProviderApiKey =
    typeof authTemplate.OPENAI_API_KEY === "string" &&
    authTemplate.OPENAI_API_KEY.trim().length > 0;
  const hasOauthLogin = Object.entries(authTemplate).some(
    ([key, value]) =>
      key !== "auth_mode" && key !== "OPENAI_API_KEY" && hasAuthMaterial(value),
  );

  // Match should_restore_codex_provider_token_for_backfill: an OAuth-only
  // provider must not be silently converted into an API-key provider.
  if (hasOauthLogin && !hasProviderApiKey) return liveSettings;

  return {
    ...liveSettings,
    auth: {
      ...authTemplate,
      OPENAI_API_KEY: bearer,
    },
  };
};

export function EditProviderDialog(props: EditProviderDialogProps) {
  if (!props.open || !props.provider) return null;

  return (
    <EditProviderDialogSession
      key={JSON.stringify([props.appId, props.provider.id])}
      {...props}
      provider={props.provider}
    />
  );
}

function EditProviderDialogSession({
  open,
  provider: sourceProvider,
  onOpenChange,
  onSubmit,
  onManageSharedChannel,
  appId,
  isProxyTakeover = false,
}: Omit<EditProviderDialogProps, "provider"> & { provider: Provider }) {
  const { t } = useTranslation();
  // One immutable database snapshot belongs to this open/app/provider session.
  const [provider] = useState(() => deepClone(sourceProvider));
  const active = useRef(true);
  const submitting = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<"close" | "shared" | null>(
    null,
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [authSettingsTarget, setAuthSettingsTarget] =
    useState<ManagedAuthProvider | null>(null);

  useEffect(() => {
    setAuthSettingsTarget(null);
  }, [appId, open, provider?.id]);

  const formReadyToken = useMemo(
    () => Symbol("provider-form-ready"),
    [appId, open, provider?.id],
  );
  const currentFormReadyToken = useRef(formReadyToken);
  currentFormReadyToken.current = formReadyToken;
  const [formReadyState, setFormReadyState] = useState({
    token: formReadyToken,
    ready: appId !== "pi",
  });
  const isFormReady =
    formReadyState.token === formReadyToken
      ? formReadyState.ready
      : appId !== "pi";
  const handleSubmitReadyChange = useCallback(
    (ready: boolean) => {
      if (currentFormReadyToken.current === formReadyToken) {
        setFormReadyState({ token: formReadyToken, ready });
      }
    },
    [formReadyToken],
  );

  // Hydrate once before mounting the editable form. Never replace its draft
  // with a late live response or a refreshed same-ID database row.
  const skipLive =
    isProxyTakeover ||
    !!getSharedChannelId(provider, appId) ||
    appId === "opencode" ||
    appId === "pi";
  const [liveSettings, setLiveSettings] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [hasLoadedLive, setHasLoadedLive] = useState(skipLive);
  const liveSettled = useRef(skipLive);

  const useSavedSettings = useCallback(() => {
    liveSettled.current = true;
    setLiveSettings(null);
    setHasLoadedLive(true);
  }, []);

  const finishClose = useCallback(() => {
    setAuthSettingsTarget(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const closeDialog = useCallback(() => {
    if (submitting.current || pendingLeave) return;
    if (isDirty) setPendingLeave("close");
    else finishClose();
  }, [finishClose, isFormSubmitting, isDirty, pendingLeave]);

  const handlePanelClose = useCallback(() => {
    if (submitting.current) return;
    if (authSettingsTarget) {
      setAuthSettingsTarget(null);
      return;
    }
    closeDialog();
  }, [authSettingsTarget, closeDialog, isFormSubmitting]);

  useEffect(() => {
    if (liveSettled.current) return;
    let cancelled = false;
    if (skipLive) {
      useSavedSettings();
      return;
    }
    const load = async () => {
      let live: Record<string, unknown> | null = null;
      try {
        if (appId === "openclaw") {
          live = asRecord(await openclawApi.getLiveProvider(provider.id));
        } else {
          const currentId = await providersApi.getCurrent(appId);
          if (cancelled || liveSettled.current) return;
          if (provider.id === currentId) {
            live = asRecord(await vscodeApi.getLiveProviderSettings(appId));
          }
        }
      } catch {
        // Both current-provider lookup and live reads fall back to the stored
        // snapshot, without exposing private IPC error details.
      }
      if (cancelled || liveSettled.current) return;
      liveSettled.current = true;
      setLiveSettings(live ? deepClone(live) : null);
      setHasLoadedLive(true);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [appId, provider.id, skipLive, useSavedSettings]);

  const initialSettingsConfig = useMemo(() => {
    const storedSettings = asRecord(provider?.settingsConfig);
    const base =
      appId === "codex" && liveSettings
        ? reconcileCodexLiveAuth(
            liveSettings,
            storedSettings,
            provider?.category,
          )
        : (liveSettings ?? storedSettings ?? {});

    // Codex 的 modelCatalog 是 cc-switch 私有字段，SSOT 在数据库。Live 的 config.toml
    // 仅在写入时投影出 model_catalog_json 指针；Codex.app 改写配置、代理接管/恢复周期、
    // 来回切换供应商都可能让 Live 丢失该投影，从而 read_live_settings 反解为空。
    // 若放任 Live 覆盖，编辑界面会显示空映射表，保存后连同数据库里的映射一起清空（数据丢失）。
    // 因此始终以数据库 SSOT 的 modelCatalog 为准，仅在数据库确实没有时才回退到 Live 反解结果。
    if (
      appId === "codex" &&
      liveSettings &&
      provider?.settingsConfig &&
      typeof provider.settingsConfig === "object"
    ) {
      const dbCatalog = (provider.settingsConfig as Record<string, unknown>)
        .modelCatalog;
      if (dbCatalog !== undefined) {
        return { ...base, modelCatalog: dbCatalog };
      }
    }

    return base;
  }, [liveSettings, provider.settingsConfig, provider.category, appId]);

  const initialData = useMemo(
    () => ({
      name: provider.name,
      notes: provider.notes,
      websiteUrl: provider.websiteUrl,
      settingsConfig: initialSettingsConfig,
      category: provider.category,
      meta: provider.meta,
      icon: provider.icon,
      iconColor: provider.iconColor,
    }),
    [provider, initialSettingsConfig],
  );

  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      if (!hasLoadedLive || submitting.current) return;

      // 注意：values.settingsConfig 已经是最终的配置字符串
      // ProviderForm 已经为不同的 app 类型（Claude/Codex/Gemini）正确组装了配置
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      const nextProviderId =
        (appId === "opencode" || appId === "openclaw" || appId === "pi") &&
        values.providerKey?.trim()
          ? values.providerKey.trim()
          : provider.id;

      const updatedProvider: Provider = {
        ...provider,
        id: nextProviderId,
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        // 保留或更新 meta 字段
        ...(values.meta ? { meta: values.meta } : {}),
      };

      submitting.current = true;
      setIsSaving(true);
      try {
        await onSubmit({
          provider: updatedProvider,
          originalId: provider.id,
        });
        if (active.current) finishClose();
      } finally {
        submitting.current = false;
        if (active.current) setIsSaving(false);
      }
    },
    [appId, onSubmit, finishClose, provider, hasLoadedLive],
  );

  return (
    <FullScreenPanel
      isOpen={open}
      title={t("provider.editProvider")}
      onClose={handlePanelClose}
      contentClassName={appId === "pi" ? "pb-0" : undefined}
      footer={
        <Button
          type="submit"
          form="provider-form"
          disabled={
            !hasLoadedLive || isSaving || isFormSubmitting || !isFormReady
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Save className="h-4 w-4 mr-2" />
          {t("common.save")}
        </Button>
      }
    >
      {getSharedChannelId(provider, appId) && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t("universalProvider.linkedChildHint")}
          </p>
          {onManageSharedChannel && (
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                if (submitting.current || pendingLeave) return;
                if (isDirty) setPendingLeave("shared");
                else onManageSharedChannel(provider);
              }}
            >
              {t("universalProvider.manageShared")}
            </Button>
          )}
        </div>
      )}
      {!hasLoadedLive ? (
        <div className="space-y-3" data-testid="provider-edit-loading">
          <p className="text-sm text-muted-foreground" role="status">
            {t("providerDraft.loading")}
          </p>
          <Button variant="outline" type="button" onClick={useSavedSettings}>
            {t("providerDraft.useSaved")}
          </Button>
        </div>
      ) : (
        <ProviderForm
          appId={appId}
          providerId={provider.id}
          submitLabel={t("common.save")}
          onSubmit={handleSubmit}
          onCancel={closeDialog}
          onDirtyChange={setIsDirty}
          onManageAuthAccounts={setAuthSettingsTarget}
          onSubmittingChange={setIsFormSubmitting}
          onSubmitReadyChange={handleSubmitReadyChange}
          initialData={initialData}
          showButtons={false}
          isProxyTakeover={isProxyTakeover}
        />
      )}
      <ProviderDraftGuard
        open={pendingLeave !== null}
        onKeep={() => setPendingLeave(null)}
        onDiscard={() => {
          const target = pendingLeave;
          setPendingLeave(null);
          if (target === "shared") onManageSharedChannel?.(provider);
          else finishClose();
        }}
      />
      <AuthSettingsPanel
        target={authSettingsTarget}
        onClose={() => setAuthSettingsTarget(null)}
      />
    </FullScreenPanel>
  );
}
