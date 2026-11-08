// A chat model goes through Aelios or a box (claude-code/…, kiro/…) and nowhere else. With neither set up, the
// resident says so in one line and does not fall back to anything.

import type { LanguageModelV4 } from "@ai-sdk/provider";

// Shown to the owner in the chat, so it is in the page's language.
export const NO_MODEL = "还没有可用的模型：去设置页接上 Aelios，或者配一个 Claude 盒子、Kiro 盒子。";

/** Ids of the removed `custom/…` provider: a saved choice like this is ignored, not deleted. */
export function isRemovedModel(id: string): boolean {
  return id.startsWith("custom/");
}

/** A model whose every call fails with NO_MODEL. */
export function noModel(): LanguageModelV4 {
  const fail = async (): Promise<never> => {
    throw new Error(NO_MODEL);
  };
  return { specificationVersion: "v4", provider: "none", modelId: "none", supportedUrls: {}, doGenerate: fail, doStream: fail };
}
