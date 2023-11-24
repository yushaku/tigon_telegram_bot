export type EstimateTrade = {
  swaps: Swap[];
  tradeType: number;
};

export type Swap = {
  inputAmount: PutAmount;
  outputAmount: PutAmount;
  route: Route;
};

export type PutAmount = {
  numerator: number[];
  denominator: number[];
  currency: Currency;
  decimalScale: number[];
};

export type Currency = {
  chainId: number;
  decimals: number;
  symbol: string;
  name: string;
  isNative: boolean;
  isToken: boolean;
  address: string;
};

export type Route = {
  _midPrice: null;
  pools: Pool[];
  tokenPath: Currency[];
  input: Currency;
  output: Currency;
};

export type Pool = {
  token0: Currency;
  token1: Currency;
  fee: number;
  sqrtRatioX96: number[];
  liquidity: number[];
  tickCurrent: number;
  tickDataProvider: TickDataProvider;
};

export type TickDataProvider = {};