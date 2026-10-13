export function formatCurrency(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const centsPart = abs % 100;
  const centsStr = centsPart.toString().padStart(2, "0");
  const sign = negative ? "-" : "";
  return `${sign}$${dollars}.${centsStr}`;
}
