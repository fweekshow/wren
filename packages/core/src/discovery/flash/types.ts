/** Definitive Flash API types (Base / EVM subset used by Basemate). */

export type FlashChain = "base";

export type FlashOrderSide = "buy" | "sell";

/** OpenAPI OrderType — DCA is not a distinct API order type. */
export type FlashOrderType =
  | "market"
  | "limit"
  | "twap"
  | "stop"
  | "stop-loss"
  | "take-profit"
  | "bracket";

export type FlashPriceTrigger = {
  notionalPrice: string;
  triggerType: "upper" | "lower";
};

export type FlashQuoteRequest = {
  targetChain: FlashChain;
  contraChain: FlashChain;
  targetAsset: string;
  contraAsset: string;
  side: FlashOrderSide;
  qty: string;
  orderType: FlashOrderType;
  funderAddress: string;
  maxSlippage?: string;
  maxPriceImpact?: string;
  limitNotionalPrice?: string;
  flashIntegratorFeeBps?: string;
  expireTime?: string;
  durationSeconds?: number;
  twapBucketCount?: number;
  triggers?: FlashPriceTrigger[];
};

export type FlashQuoteLeg = {
  asset: "target" | "contra";
  amount: string;
  notional: string;
};

export type FlashEvmTx = {
  to: string;
  data: string;
  value?: string;
};

export type FlashQuoteEvmActions = {
  approveTx: FlashEvmTx | null;
  permitTypedData: string | null;
  orderTypedData: string | null;
};

export type FlashQuoteResponse = {
  quoteId: string;
  orderType: FlashOrderType;
  side: FlashOrderSide;
  targetAsset: string;
  contraAsset: string;
  from: FlashQuoteLeg;
  to: FlashQuoteLeg;
  fees: { estimatedFeeNotional: string };
  wrap: {
    nativeAsset: string;
    wrappedAsset: string;
    evmTx: FlashEvmTx | null;
    svmInstructions: unknown;
  } | null;
  evm: FlashQuoteEvmActions | null;
  svm: unknown;
};

export type FlashOrderRequest = FlashQuoteRequest & {
  quoteId: string;
  userSignature: string;
  evmOrderTypedData: string;
  flashIntegratorFeeBps?: string;
  erc8021AttributionCode?: string;
  evmPermitTypedData?: string;
  evmPermitSignature?: string;
};

export type FlashOrderSubmitResponse = {
  orderId: string;
};

export type FlashOrderStatus =
  | "ORDER_STATUS_UNSPECIFIED"
  | "ORDER_STATUS_PENDING"
  | "ORDER_STATUS_ACCEPTED"
  | "ORDER_STATUS_PARTIALLY_FILLED"
  | "ORDER_STATUS_FILLED"
  | "ORDER_STATUS_CANCELLED"
  | "ORDER_STATUS_REJECTED"
  | "ORDER_STATUS_TERMINATED";

export type FlashFill = {
  transactionId?: string | null;
  venues?: string[];
  status?: string;
  contraAmount?: string;
  targetAmount?: string;
  feeAmount?: string;
  filledAt?: string;
};

export type FlashOrderDetail = {
  orderId: string;
  status: FlashOrderStatus;
  closeReason?: string | null;
  side?: FlashOrderSide;
  orderType?: FlashOrderType;
  targetAsset?: string;
  contraAsset?: string;
  qty?: string;
  filled?: {
    targetAmount?: string;
    contraAmount?: string;
    averagePrice?: string;
    averageNotionalPrice?: string;
  } | null;
  fills?: FlashFill[];
};

export type FlashApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/** Snapshot stored for chat confirm + placeFlashOrder. */
export type FlashPreparedOrder = {
  quoteId: string;
  orderType: FlashOrderType;
  side: FlashOrderSide;
  targetAsset: string;
  contraAsset: string;
  targetSymbol: string;
  contraSymbol: string;
  qty: string;
  funderAddress: string;
  orderTypedData: string;
  approveTx: FlashEvmTx | null;
  /** Present when Flash chose Permit2 — sign and echo on submit. */
  permitTypedData?: string | null;
  estimatedFeeNotional: string;
  fromNotional: string;
  toNotional: string;
  fromAmount: string;
  toAmount: string;
  limitNotionalPrice?: string;
  durationSeconds?: number;
  triggers?: FlashPriceTrigger[];
  flashIntegratorFeeBps?: string;
  maxSlippage?: string;
};
