// Money formatting for prices. What a send costs comes from the server
// (getSendQuote), so the app never guesses at fees.

export function usd2(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
