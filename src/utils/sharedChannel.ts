import type { AppId } from "@/lib/api";
import type { Provider, ProviderMeta } from "@/types";

/** IDs remain stable for existing universal providers and their routing rules. */
export function getSharedChannelId(
  provider: Pick<Provider, "id" | "meta">,
  appId: AppId,
): string | undefined {
  if (!["claude", "codex", "gemini"].includes(appId)) return undefined;
  const prefix = `universal-${appId}-`;
  const declared = provider.meta?.sharedChannelId;
  if (!provider.id.startsWith(prefix)) {
    // This is a display hint; the backend validates both sides of the binding.
    return declared?.trim() ? declared : undefined;
  }
  const id = provider.id.slice(prefix.length);
  if (!id) return undefined;
  return declared === undefined || declared === id ? id : undefined;
}

/** Ordinary copies are independent providers, not new bindings to a channel. */
export function withoutSharedChannelBinding(
  meta: ProviderMeta | undefined,
): ProviderMeta | undefined {
  if (!meta) return undefined;
  const copied = { ...meta };
  delete copied.sharedChannelId;
  return copied;
}
