import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Layers, Link2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { UniversalProviderCard } from "./UniversalProviderCard";
import { UniversalProviderFormModal } from "./UniversalProviderFormModal";
import { SharedChannelLinkModal } from "./SharedChannelLinkModal";
import { universalProvidersApi } from "@/lib/api";
import type {
  SharedChannelApp,
  UniversalProvider,
  UniversalProvidersMap,
} from "@/types";
import { deepClone } from "@/utils/deepClone";

interface UniversalProviderPanelProps {
  initialEditId?: string;
  onEditConsumed?: () => void;
  initialApp?: SharedChannelApp;
  onFormOpenChange?: (open: boolean) => void;
}

export function UniversalProviderPanel({
  initialEditId,
  onEditConsumed,
  initialApp,
  onFormOpenChange,
}: UniversalProviderPanelProps) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<UniversalProvidersMap>({});
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isLinkOpen, setIsLinkOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<UniversalProvider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: string;
    name: string;
  }>({ open: false, id: "", name: "" });

  const loadProviders = useCallback(async () => {
    try {
      const data = await universalProvidersApi.getAll();
      setProviders(data);
    } catch {
      toast.error(t("universalProvider.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    onFormOpenChange?.(isFormOpen || isLinkOpen);
    return () => onFormOpenChange?.(false);
  }, [isFormOpen, isLinkOpen, onFormOpenChange]);

  useEffect(() => {
    if (!initialEditId || loading) return;
    const provider = providers[initialEditId];
    if (provider) {
      setEditingProvider(provider);
      setIsFormOpen(true);
    } else {
      toast.error(t("universalProvider.channelMissing"));
    }
    onEditConsumed?.();
  }, [initialEditId, loading, providers, onEditConsumed, t]);

  const handleSave = useCallback(
    async (provider: UniversalProvider) => {
      const result = await universalProvidersApi.save(provider);
      if (result.failedApps.length === 0)
        toast.success(t("universalProvider.savedAndSynced"));
      await loadProviders();
      return result;
    },
    [loadProviders, t],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteConfirm.id || busyId) return;
    setBusyId(deleteConfirm.id);
    try {
      await universalProvidersApi.delete(deleteConfirm.id);
      toast.success(t("universalProvider.deleted"));
      await loadProviders();
    } catch {
      toast.error(t("universalProvider.deleteErrorHint"));
    } finally {
      setBusyId(null);
      setDeleteConfirm({ open: false, id: "", name: "" });
    }
  }, [deleteConfirm.id, busyId, loadProviders, t]);

  const handleSync = useCallback(
    async (id: string) => {
      if (busyId || !providers[id]) return;
      setBusyId(id);
      try {
        const result = await universalProvidersApi.resync(id);
        if (result.failedApps.length > 0) {
          toast.warning(
            t("universalProvider.partialSync", {
              apps: result.failedApps.map((app) => t(`apps.${app}`)).join(", "),
            }),
          );
        } else {
          toast.success(t("universalProvider.savedAndSynced"));
        }
        await loadProviders();
      } catch {
        toast.error(t("universalProvider.saveErrorHint"));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, providers, loadProviders, t],
  );

  const handleDuplicate = useCallback(
    (provider: UniversalProvider) => {
      const copy = deepClone(provider);
      delete copy.childIds;
      setEditingProvider({
        ...copy,
        id: crypto.randomUUID(),
        name: t("universalProvider.copyName", { name: provider.name }),
        createdAt: Date.now(),
      });
      setIsFormOpen(true);
    },
    [t],
  );

  const providerList = Object.values(providers);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">
          {t("universalProvider.title")}
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {providerList.length}
        </span>
        <Button
          className="ml-auto"
          data-testid="shared-channel-link-open"
          size="sm"
          variant="outline"
          onClick={() => setIsLinkOpen(true)}
        >
          <Link2 className="mr-1.5 h-4 w-4" />
          {t("universalProvider.link.open")}
        </Button>
        <Button
          data-testid="shared-channel-add"
          size="sm"
          onClick={() => {
            setEditingProvider(null);
            setIsFormOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t("universalProvider.add")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("universalProvider.description")}
      </p>
      {loading ? (
        <div
          className="flex items-center justify-center py-12"
          role="status"
          aria-label={t("common.loading")}
        >
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : providerList.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
          <Layers className="mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {t("universalProvider.empty")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("universalProvider.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {providerList.map((provider) => (
            <UniversalProviderCard
              key={provider.id}
              provider={provider}
              busy={busyId !== null}
              onEdit={(selected) => {
                setEditingProvider(selected);
                setIsFormOpen(true);
              }}
              onDelete={(id) =>
                setDeleteConfirm({ open: true, id, name: providers[id].name })
              }
              onSync={handleSync}
              onDuplicate={handleDuplicate}
            />
          ))}
        </div>
      )}
      <UniversalProviderFormModal
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingProvider(null);
        }}
        onSave={handleSave}
        editingProvider={editingProvider}
        initialApp={initialApp}
      />
      {isLinkOpen && (
        <SharedChannelLinkModal
          onClose={() => {
            setIsLinkOpen(false);
            void loadProviders();
          }}
          onLinked={loadProviders}
        />
      )}
      <ConfirmDialog
        isOpen={deleteConfirm.open}
        title={t("universalProvider.deleteConfirmTitle")}
        message={t(
          Object.values(providers[deleteConfirm.id]?.childIds ?? {}).some(
            Boolean,
          )
            ? "universalProvider.link.deleteDescription"
            : "universalProvider.deleteConfirmDescription",
          {
            name: deleteConfirm.name,
          },
        )}
        confirmText={t("common.delete")}
        pending={busyId === deleteConfirm.id}
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm({ open: false, id: "", name: "" })}
      />
    </div>
  );
}
