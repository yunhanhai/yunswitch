import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface ProviderDraftGuardProps {
  open: boolean;
  onDiscard: () => void;
  onKeep: () => void;
}

export function ProviderDraftGuard({
  open,
  onDiscard,
  onKeep,
}: ProviderDraftGuardProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      isOpen={open}
      zIndex="top"
      title={t("providerDraft.discardTitle")}
      message={t("providerDraft.discardMessage")}
      confirmText={t("providerDraft.discard")}
      cancelText={t("providerDraft.keep")}
      onConfirm={onDiscard}
      onCancel={onKeep}
    />
  );
}
