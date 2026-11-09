// List prices in US dollars per million tokens: Claude as published on
// https://platform.claude.com/docs/en/about-claude/pricing (copied 2026-10-27), GPT as published on
// https://developers.openai.com/api/docs/pricing (standard tier, copied 2026-11-09; GPT-5.6 Sol's price there is a
// promotion until 2026-11-30). The usage timeline (usage.ts) prices each call with them, matched on the model's name, so
// it is what the call would cost on the maker's own API: a plan's included credit, a relay with its own rates, a cloud
// platform's prices or regional processing can differ. A model that is not here has no price, and the page shows its
// tokens only. Add a row when a new model comes out.

export type Price = {
  input: number;
  /** Writing to the five-minute prompt cache. */
  write5m: number;
  /** Writing to the one-hour prompt cache. */
  write1h: number;
  /** Reading from the prompt cache (a hit, which also refreshes it). */
  read: number;
  output: number;
};

const price = (input: number, write5m: number, write1h: number, read: number, output: number): Price => ({ input, write5m, write1h, read, output });

/** GPT: one cache-write rate, the default 30-minute one (the resident never asks for 12 hours). A model with no write
 * rate charges writes as input, and one with no cached rate does not cache. */
const gpt = (input: number, read: number, write: number, output: number): Price => price(input, write, write, read, output);

const OPUS_4 = price(5, 6.25, 10, 0.5, 25);
const OPUS_4_0 = price(15, 18.75, 30, 1.5, 75);
const SONNET_4 = price(3, 3.75, 6, 0.3, 15);

/** By family and version, as priceKey() names them. Cache reads are not always a tenth of the input price. */
const PRICES: Record<string, Price> = {
  "fable-5-1": price(10, 12.5, 20, 0.25, 50),
  "mythos-5-1": price(10, 12.5, 20, 0.25, 50),
  "fable-5": price(10, 12.5, 20, 1, 50),
  "mythos-5": price(10, 12.5, 20, 1, 50),
  "opus-5-5": price(4, 5, 8, 0.2, 20),
  "opus-5": price(5, 6.25, 10, 0.5, 25),
  "opus-4-8": OPUS_4,
  "opus-4-7": OPUS_4,
  "opus-4-6": OPUS_4,
  "opus-4-5": OPUS_4,
  "opus-4-1": OPUS_4_0,
  "opus-4": OPUS_4_0,
  "sonnet-5-5": price(2, 2.5, 4, 0.1, 10),
  "sonnet-5": price(2, 2.5, 4, 0.2, 10),
  "sonnet-4-6": SONNET_4,
  "sonnet-4-5": SONNET_4,
  "sonnet-4": SONNET_4,
  "haiku-5-5": price(0.1, 0.125, 0.2, 0.01, 0.5),
  "haiku-4-5": price(1, 1.25, 2, 0.1, 5),
  "haiku-3-5": price(0.8, 1, 1.6, 0.08, 4),
  "gpt-6-astra": gpt(10, 1, 12.5, 50),
  "gpt-6.1-sol": gpt(2, 0.1, 2.5, 10),
  "gpt-6.1-terra": gpt(1, 0.05, 1.25, 5),
  "gpt-6-sol": gpt(2, 0.2, 2.5, 10),
  "gpt-6-luna": gpt(0.1, 0.01, 0.125, 0.5),
  "gpt-5.6-sol": gpt(4, 0.4, 5, 20),
  "gpt-5.6-terra": gpt(2, 0.2, 2.5, 12),
  "gpt-5.6-luna": gpt(0.2, 0.02, 0.25, 1.2),
  "gpt-5.5": gpt(5, 0.5, 5, 30),
  "gpt-5.5-pro": gpt(30, 30, 30, 180),
  "gpt-5.4": gpt(2.5, 0.25, 2.5, 15),
  "gpt-5.4-pro": gpt(30, 30, 30, 180),
  "gpt-5.4-mini": gpt(0.75, 0.075, 0.75, 4.5),
  "gpt-5.4-nano": gpt(0.2, 0.02, 0.2, 1.25),
  "gpt-5.2": gpt(1.75, 0.175, 1.75, 14),
  "gpt-5.2-pro": gpt(21, 21, 21, 168),
  "gpt-5.1": gpt(1.25, 0.125, 1.25, 10),
  "gpt-5": gpt(1.25, 0.125, 1.25, 10),
  "gpt-5-mini": gpt(0.25, 0.025, 0.25, 2),
  "gpt-5-nano": gpt(0.05, 0.005, 0.05, 0.4),
  "gpt-5-pro": gpt(15, 15, 15, 120),
  "gpt-4.1": gpt(2, 0.5, 2, 8),
  "gpt-4.1-mini": gpt(0.4, 0.1, 0.4, 1.6),
  "gpt-4o": gpt(2.5, 1.25, 2.5, 10),
  "gpt-4o-mini": gpt(0.15, 0.075, 0.15, 0.6)
};

/** Where a long prompt starts, counting every input token, cached or not: Haiku 5.5 past 100,000, GPT past 272,000. */
export const LONG_PROMPTS = [100_000, 272_000] as const;
const [HAIKU_LONG, GPT_LONG] = LONG_PROMPTS;
const LONG_PRICES: Record<string, { over: number; price: Price }> = {
  "haiku-5-5": { over: HAIKU_LONG, price: price(0.5, 0.625, 1, 0.05, 2.5) },
  "gpt-6-astra": { over: GPT_LONG, price: gpt(20, 2, 25, 75) },
  "gpt-6.1-sol": { over: GPT_LONG, price: gpt(4, 0.2, 5, 15) },
  "gpt-6.1-terra": { over: GPT_LONG, price: gpt(2, 0.1, 2.5, 7.5) },
  "gpt-6-sol": { over: GPT_LONG, price: gpt(4, 0.4, 5, 15) },
  "gpt-6-luna": { over: GPT_LONG, price: gpt(0.2, 0.02, 0.25, 0.75) },
  "gpt-5.6-sol": { over: GPT_LONG, price: gpt(8, 0.8, 10, 30) },
  "gpt-5.6-terra": { over: GPT_LONG, price: gpt(4, 0.4, 5, 18) },
  "gpt-5.6-luna": { over: GPT_LONG, price: gpt(0.4, 0.04, 0.5, 1.8) },
  "gpt-5.5": { over: GPT_LONG, price: gpt(10, 1, 10, 45) },
  "gpt-5.5-pro": { over: GPT_LONG, price: gpt(60, 60, 60, 270) },
  "gpt-5.4": { over: GPT_LONG, price: gpt(5, 0.5, 5, 22.5) },
  "gpt-5.4-pro": { over: GPT_LONG, price: gpt(60, 60, 60, 270) }
};

/** Kiro bills in credits: 1,000 credits for $20. */
export const KIRO_USD_PER_CREDIT = 20 / 1000;

/**
 * The model a name is, whatever wraps it: anthropic/claude-opus-5.5, claude-opus-5-5, a relay's
 * custom-x/anthropic/claude-opus-5.5, Vertex's claude-opus-5-5@20260101 and a dated claude-opus-4-5-20251101 are
 * all "opus-5-5" or "opus-4-5"; openai/gpt-6.1-sol is "gpt-6.1-sol" and gpt-4.1-2025-04-14 is "gpt-4.1". Null for
 * anything else.
 */
export function priceKey(model: string): string | null {
  // A GPT is named exactly, past any prefix and without its date: gpt-5-chat is not gpt-5.
  const own = model.toLowerCase().split("/").pop()!.replace(/[@[].*$/, "").replace(/-\d{4}-?\d{2}-?\d{2}$/, "");
  if (own.startsWith("gpt-")) return own in PRICES ? own : null;
  const name = model.toLowerCase().replace(/\./g, "-");
  // A version is one or two digits; a date after it (eight digits) is not part of it.
  const current = name.match(/claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/);
  if (current) return [current[1], current[2], current[3]].filter(Boolean).join("-");
  // Older names put the version first: claude-3-5-haiku-20241022.
  const older = name.match(/claude-(\d)-(\d)-(opus|sonnet|haiku)/);
  return older ? `${older[3]}-${older[1]}-${older[2]}` : null;
}

/** The price of one call to the model, given how long its prompt was; null when the model is not priced. */
export function priceFor(model: string, promptTokens = 0): Price | null {
  const key = priceKey(model);
  if (!key) return null;
  const long = LONG_PRICES[key];
  return (long && promptTokens > long.over ? long.price : PRICES[key]) ?? null;
}

export type Tokens = {
  /** Input not read from or written to the cache. */
  input: number;
  cacheRead: number;
  /** All cache writes, of which cacheWrite1h went to the one-hour cache. */
  cacheWrite: number;
  cacheWrite1h: number;
  /** Including any thinking. */
  output: number;
};

/** What the tokens cost in US dollars at that price. */
export function costAt(price: Price, tokens: Tokens): number {
  const write1h = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  return (
    (tokens.input * price.input +
      tokens.cacheRead * price.read +
      (tokens.cacheWrite - write1h) * price.write5m +
      write1h * price.write1h +
      tokens.output * price.output) /
    1_000_000
  );
}

/** What one call cost in US dollars at list price; null when the model is not priced. */
export function costOf(model: string, tokens: Tokens): number | null {
  const found = priceFor(model, tokens.input + tokens.cacheRead + tokens.cacheWrite);
  return found ? costAt(found, tokens) : null;
}
