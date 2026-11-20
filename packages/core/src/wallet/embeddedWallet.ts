/**
 * Active signer. Privy by default. Set WREN_SIGNER=cdp to use the previous
 * implementation in embeddedWallet.cdp.ts for one release.
 */
import { EmbeddedWalletAdapter as CdpAdapter } from "./embeddedWallet.cdp.js";
import { EmbeddedWalletAdapter as PrivyAdapter } from "./privySigner.js";

export {
  EmbeddedWalletError,
  type EmbeddedSendResult,
  type EmbeddedSignTypedDataResult,
  type EmbeddedTypedData,
} from "./embeddedWallet.cdp.js";

export const EmbeddedWalletAdapter = process.env.WREN_SIGNER === "cdp" ? CdpAdapter : PrivyAdapter;
