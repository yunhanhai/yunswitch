import { describe, expect, it } from "vitest";
import {
  getSharedChannelId,
  withoutSharedChannelBinding,
} from "@/utils/sharedChannel";
import {
  buildConvertedCodexProvider,
  buildConvertedCodexProviderWithMode,
  convertClaudeProviderToCodex,
} from "@/utils/claudeToCodexConvert";
import type { Provider } from "@/types";

describe("shared channel bindings", () => {
  it("recognizes legacy and explicit children without binding unrelated providers", () => {
    expect(getSharedChannelId({ id: "universal-claude-relay" }, "claude")).toBe(
      "relay",
    );
    expect(
      getSharedChannelId(
        { id: "universal-codex-relay", meta: { sharedChannelId: "relay" } },
        "codex",
      ),
    ).toBe("relay");
    expect(
      getSharedChannelId(
        { id: "universal-codex-relay", meta: { sharedChannelId: "another" } },
        "codex",
      ),
    ).toBeUndefined();
    expect(
      getSharedChannelId(
        { id: "ordinary", meta: { sharedChannelId: "relay" } },
        "claude",
      ),
    ).toBe("relay");
    expect(
      getSharedChannelId(
        { id: "ordinary", meta: { sharedChannelId: " " } },
        "codex",
      ),
    ).toBeUndefined();
    expect(
      getSharedChannelId(
        { id: "ordinary", meta: { sharedChannelId: "relay" } },
        "opencode",
      ),
    ).toBeUndefined();
    expect(
      getSharedChannelId({ id: "universal-claude-relay" }, "codex"),
    ).toBeUndefined();
    expect(
      getSharedChannelId({ id: "universal-claude-" }, "claude"),
    ).toBeUndefined();
  });

  it("keeps ordinary copies and conversions independent of their source channel", () => {
    const meta = { sharedChannelId: "relay", costMultiplier: "2" };
    expect(withoutSharedChannelBinding(meta)).toEqual({ costMultiplier: "2" });
    expect(meta.sharedChannelId).toBe("relay");
    const source: Provider = {
      id: "universal-claude-relay",
      name: "Synthetic relay",
      meta,
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: "https://example.invalid",
          ANTHROPIC_AUTH_TOKEN: "fake-key",
        },
      },
    };
    const conversion = convertClaudeProviderToCodex(source)!;
    for (const copy of [
      buildConvertedCodexProvider(source, conversion),
      buildConvertedCodexProviderWithMode(source, conversion, {
        mode: "direct",
      }),
    ]) {
      expect(copy.meta?.sharedChannelId).toBeUndefined();
      expect(copy.meta?.costMultiplier).toBe("2");
    }
  });
});
