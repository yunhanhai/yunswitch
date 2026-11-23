import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Timer } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  requestBudgetFields,
  type RequestBudgetDraft,
} from "@/utils/providerRequestBudget";

export function ProviderRequestBudgetFields({
  value,
  onChange,
}: {
  value: RequestBudgetDraft;
  onChange: (value: RequestBudgetDraft) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(
    requestBudgetFields.some((key) => value[key] !== ""),
  );
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-fields`}
        className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/30"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-3 font-medium">
          <Timer className="h-4 w-4 text-muted-foreground" />
          {t("providerBudget.title")}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          id={`${id}-fields`}
          className="space-y-4 border-t border-border/50 p-4"
        >
          <p className="text-sm text-muted-foreground">
            {t("providerBudget.description")}
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {requestBudgetFields.map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`${id}-${key}`}>
                  {t(`providerBudget.${key}`)}
                </Label>
                <Input
                  id={`${id}-${key}`}
                  data-request-budget={key}
                  type="number"
                  min="1"
                  max="3600"
                  step="1"
                  value={value[key]}
                  placeholder={t("providerBudget.inherit")}
                  aria-describedby={`${id}-${key}-hint`}
                  onChange={(event) =>
                    onChange({ ...value, [key]: event.target.value })
                  }
                />
                <p
                  id={`${id}-${key}-hint`}
                  className="text-xs text-muted-foreground"
                >
                  {t(`providerBudget.${key}Hint`)}
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("providerBudget.range")}
          </p>
        </div>
      )}
    </div>
  );
}
