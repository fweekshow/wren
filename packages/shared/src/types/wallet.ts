/** A single call inside a wallet_sendCalls payload. */
export interface WalletCall {
  to?: `0x${string}`;
  data?: `0x${string}`;
  value?: `0x${string}`;
  metadata?: { description: string; transactionType: string } & Record<string, string>;
}
