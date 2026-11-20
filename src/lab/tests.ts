export const TESTS = [
  { id: 'cbc', name: 'Complete Blood Count', priceInr: 350 },
  { id: 'lipid', name: 'Lipid Profile', priceInr: 650 },
  { id: 'thyroid', name: 'Thyroid Profile (T3/T4/TSH)', priceInr: 800 },
  { id: 'vitamin_d', name: 'Vitamin D (25-OH)', priceInr: 1200 },
  { id: 'hba1c', name: 'HbA1c', priceInr: 500 },
] as const;

export type TestId = (typeof TESTS)[number]['id'];

export function isTestId(value: unknown): value is TestId {
  return typeof value === 'string' && TESTS.some((t) => t.id === value);
}

export function testName(id: string): string {
  return TESTS.find((t) => t.id === id)?.name ?? id;
}

/** Today/tomorrow in the lab's timezone, as YYYY-MM-DD. */
export function istDate(offsetDays = 0): string {
  const ms = Date.now() + 5.5 * 3600 * 1000 + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
