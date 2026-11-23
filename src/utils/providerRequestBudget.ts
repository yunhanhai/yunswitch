import type { ProviderRequestBudget } from "@/types";

export const requestBudgetFields = [
  "firstByteTimeoutSecs",
  "idleTimeoutSecs",
  "nonStreamingTimeoutSecs",
  "recoveryTimeoutSecs",
] as const;

export type RequestBudgetDraft = Record<
  (typeof requestBudgetFields)[number],
  string
>;

export function requestBudgetDraft(
  budget?: ProviderRequestBudget,
): RequestBudgetDraft {
  return Object.fromEntries(
    requestBudgetFields.map((key) => [
      key,
      budget?.[key] === undefined ? "" : String(budget[key]),
    ]),
  ) as RequestBudgetDraft;
}

export function parseRequestBudget(draft: RequestBudgetDraft): {
  value?: ProviderRequestBudget;
  invalid: boolean;
} {
  const value: ProviderRequestBudget = {};
  for (const key of requestBudgetFields) {
    const input = draft[key].trim();
    if (!input) continue;
    if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > 3600)
      return { invalid: true };
    value[key] = Number(input);
  }
  return {
    invalid: false,
    value: Object.keys(value).length ? value : undefined,
  };
}
