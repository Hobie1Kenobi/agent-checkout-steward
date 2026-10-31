export function usdCents(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  const [dollars, cents] = value.split(".");
  const amount = Number(dollars) * 100 + Number(cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return amount;
}

export function formatUsd(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}
