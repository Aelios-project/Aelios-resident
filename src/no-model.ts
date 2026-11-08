// A chat model goes through Aelios or a box (claude-code/…, kiro/…) and nowhere else. With neither set up, the
// resident says so in one line and does not fall back to anything.

import type { LanguageModelV4 } from "@ai-sdk/provider";

export const NO_MODEL = "No model is set up: connect Aelios on the settings page (Aelios), or set up a Claude box or a Kiro box.";

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
