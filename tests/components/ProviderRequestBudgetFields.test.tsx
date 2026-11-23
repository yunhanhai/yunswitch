import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { ProviderRequestBudgetFields } from "@/components/providers/forms/ProviderRequestBudgetFields";
import {
  parseRequestBudget,
  requestBudgetDraft,
} from "@/utils/providerRequestBudget";
import zh from "@/i18n/locales/zh.json";

describe("provider request budgets", () => {
  it("keeps legacy settings inherited and rejects unbounded or ambiguous values", () => {
    expect(parseRequestBudget(requestBudgetDraft())).toEqual({
      invalid: false,
      value: undefined,
    });
    for (const input of [
      "0",
      "3601",
      "-1",
      "1.5",
      "Infinity",
      "1e2",
      "secret",
    ]) {
      expect(
        parseRequestBudget({
          ...requestBudgetDraft(),
          recoveryTimeoutSecs: input,
        }).invalid,
      ).toBe(true);
    }
    expect(
      parseRequestBudget({
        ...requestBudgetDraft(),
        firstByteTimeoutSecs: "120",
        recoveryTimeoutSecs: "3600",
      }).value,
    ).toEqual({ firstByteTimeoutSecs: 120, recoveryTimeoutSecs: 3600 });
  });

  it("edits and clears overrides without creating defaults for other fields", () => {
    i18n.addResourceBundle("zh", "translation", {
      providerBudget: zh.providerBudget,
    });
    function Editor() {
      const [draft, setDraft] = useState(
        requestBudgetDraft({ idleTimeoutSecs: 60 }),
      );
      return (
        <>
          <ProviderRequestBudgetFields value={draft} onChange={setDraft} />
          <output data-testid="result">
            {JSON.stringify(parseRequestBudget(draft))}
          </output>
        </>
      );
    }
    render(<Editor />);
    const idle = screen.getByLabelText(zh.providerBudget.idleTimeoutSecs);
    expect(idle).toHaveValue(60);
    expect(
      screen.getByLabelText(zh.providerBudget.firstByteTimeoutSecs),
    ).toHaveValue(null);
    fireEvent.change(
      screen.getByLabelText(zh.providerBudget.recoveryTimeoutSecs),
      { target: { value: "30" } },
    );
    expect(screen.getByTestId("result")).toHaveTextContent(
      '"recoveryTimeoutSecs":30',
    );
    fireEvent.change(idle, { target: { value: "" } });
    expect(screen.getByTestId("result")).not.toHaveTextContent(
      "idleTimeoutSecs",
    );
    fireEvent.click(
      screen.getByRole("button", { name: zh.providerBudget.title }),
    );
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });
});
