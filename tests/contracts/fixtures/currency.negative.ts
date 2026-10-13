// Negative fixture for the currency contract: correct in every respect except the ONE property the
// contract was widened to cover, so a failing run names that property rather than failing everything.
//
// WHY THIS SPECIFIC DEFECT. It is not invented. The contract's own header records an earlier run that
// signed a passing verification over an implementation returning "$-1.-5" for -5, because the command
// only ever asked about two positive values. The fixture reproduces that same shape -- the sign placed
// after the currency symbol instead of before it -- so the cases added to catch it are the cases that
// must catch this. If the contract ever loses them, this fixture stops failing and the discrimination
// gate reports the contract rather than the fixture.
export function formatCurrency(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const centsPart = abs % 100;
  const centsStr = centsPart.toString().padStart(2, "0");
  const sign = negative ? "-" : "";
  return `$${sign}${dollars}.${centsStr}`;
}
