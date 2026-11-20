import { config } from '../config.js';

/** USD per 1M tokens: [input, output]. Free variants cost 0. */
const TABLE: Array<[RegExp, [number, number]]> = [
  [/gemini-2\.5-flash-lite/i, [0.1, 0.4]],
  [/gemini-2\.5-flash/i, [0.3, 2.5]],
  [/gemini-2\.0-flash/i, [0.1, 0.4]],
  [/gpt-4\.1-mini/i, [0.4, 1.6]],
  [/gpt-4o-mini/i, [0.15, 0.6]],
  [/deepseek/i, [0.27, 1.1]],
  [/llama-3\.3-70b/i, [0.12, 0.3]],
];

/**
 * Estimated cost for one call. Cached prompt tokens are billed at 25% of the
 * input rate (conservative: providers vary between 10% and 50%).
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
): number {
  const free = model === 'openrouter/free' || /:free$/i.test(model) || /:free:/i.test(model);
  if (free) return 0;

  let prices: [number, number] = [config.llm.priceInPerM, config.llm.priceOutPerM];
  if (prices[0] === 0 && prices[1] === 0) {
    prices = TABLE.find(([re]) => re.test(model))?.[1] ?? [0, 0];
  }
  if (prices[0] === 0 && prices[1] === 0) return 0;

  const uncached = Math.max(0, promptTokens - cachedTokens);
  const inputCost = (uncached * prices[0] + cachedTokens * prices[0] * 0.25) / 1_000_000;
  const outputCost = (completionTokens * prices[1]) / 1_000_000;
  return Number((inputCost + outputCost).toFixed(8));
}
