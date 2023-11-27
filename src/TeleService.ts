import { WrapToken } from "@/lib/WrapToken";
import { getBalance, getBlock } from "@/lib/transaction";
import { UniswapService } from "@/uniswap";
import { getProvider } from "@/utils/networks";
import {
  esstimateMsg,
  esstimateSwap,
  scanWalletmsg,
  tokenDetail,
  walletDetail,
  walletMsg,
} from "@/utils/replyMessage";
import {
  WATCH_WALLET_ADD,
  BUY_LIMIT,
  BUY_TOKEN,
  CLOSE,
  SELL_LIMIT,
  SELL_TOKEN,
  NO_CALLBACK,
  REDIS_WHALE_WALLET,
} from "@/utils/replyTopic";
import { UNI, WETH, chainId, isWETH } from "@/utils/token";
import { Account, isTransaction } from "@/utils/types";
import {
  bigintToNumber,
  createAccount,
  parseKey,
  shortenAddress,
  shortenAmount,
} from "@/utils/utils";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Token, WETH9 } from "@uniswap/sdk-core";
import { SwapRoute } from "@uniswap/smart-order-router";
import { RedisService, isOrder, isSwapRoute, isTrade } from "lib/RedisService";
import TelegramBot, { User } from "node-telegram-bot-api";
import { v4 as uuidv4 } from "uuid";
import { Erc20Token } from "./lib/Erc20token";
import { urlScan } from "./utils/contract";
import { CoinMarket } from "./market";

export class TeleService {
  private provider: JsonRpcProvider;
  private cache: RedisService;
  private uniswap: UniswapService;
  private market: CoinMarket;

  constructor() {
    this.provider = getProvider();
    this.uniswap = new UniswapService();
    this.cache = new RedisService();
    this.market = new CoinMarket();
  }

  async hi(userId: number) {
    const account = await this.getAccount(userId);
    if (!account) return;

    const tokenA = WETH;
    const tokenB = UNI;
    const amount = 0.01;

    console.log("create trade");

    const trade = await this.uniswap.generateTrade({
      tokenA,
      tokenB,
      amount,
      account,
    });

    console.log("execute trade");
    if (!trade) return "Trade failed";

    const a = await this.uniswap.executeTrade({ trade, account });

    if (!isTransaction(a)) return a;

    console.log(a.hash);
    return `Buying...\nCheckout [etherscan](https://goerli.etherscan.io/tx/${a.hash})`;
  }

  async hello(userId: number) {
    const account = await this.getAccount(userId);
    if (!account) return;

    const tokenA = WETH;
    const tokenB = UNI;
    const amount = 0.01;

    console.log("create trade");

    const route = await this.uniswap.generateRoute({
      walletAddress: account.address,
      tokenA,
      tokenB,
      amount,
      account,
    });

    if (!route) return "create route failed";

    console.log("execute trade");
    const tx = await this.uniswap.executeRoute({ route, account });
    if (!isTransaction(tx)) return "Route execute failed";

    const receive = await tx.wait();
    if (receive.status === 0) {
      return "Swap transaction failed";
    }
    return `Buy completed\ncheckout [etherscan](https://goerli.etherscan.io/${receive.transactionHash})`;
  }

  async commandStart(user: User) {
    const { id, first_name, last_name } = user;
    const userInfo = await this.cache.getUser(id);
    if (userInfo) return userInfo;

    const defalt = {
      name: `${first_name} ${last_name}`,
      accounts: [],
      watchList: [],
      mainAccount: null,
      slippage: 10,
      maxGas: 10,
    };

    this.cache.setUser(id, defalt);
    return defalt;
  }

  async setConfig(type: "slippage" | "maxGas", userId: number, num: number) {
    const user = await this.cache.getUser(userId);
    await this.cache.setUser(userId, {
      ...user,
      [type]: num,
    });

    return `Set ${type} to ${num} ${
      type === "slippage" ? "%" : "gwei"
    } successfully`;
  }

  async commandWallet(userId: number) {
    const user = await this.cache.getUser(userId);
    const [accounts, block] = await Promise.all([
      getBalance(user.accounts),
      getBlock(),
    ]);

    return walletMsg({
      block: block?.block?.number ?? 0,
      ethPrice: block.ethPrice,
      accounts: accounts,
    });
  }

  async watchList(userId: number) {
    const user = await this.cache.getUser(userId);
    const watchList = user.watchList ?? [];

    const inline_keyboard = watchList.map((acc) => {
      return [
        { text: acc.name, callback_data: `watch_wallet ${acc.address}` },
        {
          text: shortenAddress(acc.address, 8),
          callback_data: `watch_wallet ${acc.address}`,
        },
        {
          text: "❌ Remove",
          callback_data: `watch_wallet_remove ${acc.address}`,
        },
      ];
    });

    inline_keyboard.push([
      { text: "➕ Add Wallet", callback_data: WATCH_WALLET_ADD },
    ]);

    return {
      text: "📺 Your watch list:",
      buttons: { inline_keyboard },
    };
  }

  async detailWallet(address: string) {
    const data = await this.market.scanWallet(address);

    const list: { text: string; callback_data: string }[][] = [];
    data.tokens.forEach((token) => {
      const amount =
        token.balance / 10 ** Number(token.tokenInfo.decimals ?? 18);
      if (amount < 0.0001) return;
      const usd =
        typeof token.tokenInfo.price === "boolean"
          ? 0
          : token.tokenInfo.price.rate;
      const total = usd * Number(amount);
      const symbol = token.tokenInfo.symbol;

      list.push([
        { text: symbol, callback_data: token.tokenInfo.address },
        { text: usd.toFixed(4), callback_data: NO_CALLBACK },
        { text: amount.toFixed(4), callback_data: NO_CALLBACK },
        { text: total.toFixed(4), callback_data: NO_CALLBACK },
      ]);
    });

    return {
      text: scanWalletmsg(data),
      buttons: {
        inline_keyboard: [
          [
            { text: "Token", callback_data: NO_CALLBACK },
            { text: "Price", callback_data: NO_CALLBACK },
            { text: "Amount", callback_data: NO_CALLBACK },
            { text: "Total", callback_data: NO_CALLBACK },
          ],
          ...list,
          [{ text: "❎ Close", callback_data: CLOSE }],
        ],
      },
    };
  }

  async addWatchWallet({
    userId,
    address,
    name,
    channelId,
  }: {
    userId: number;
    address: string;
    name: string;
    channelId: number;
  }) {
    const [user, whaleWallet] = await Promise.all([
      this.cache.getUser(userId),
      this.cache.getWhaleWallets(),
    ]);

    const watchList = user.watchList ?? [];
    const isExist = watchList.find((acc) => acc.address === address);
    if (isExist) return "Whale wallet already exist";

    const whales = whaleWallet[address] ?? { subscribe: {} };
    whales.subscribe[channelId] = channelId;
    whaleWallet[address] = whales;

    this.cache.redis.publish(
      REDIS_WHALE_WALLET,
      JSON.stringify({
        wallet: address,
        channelId,
        type: "remove",
      }),
    );

    await Promise.all([
      this.cache.setUser(userId, {
        ...user,
        watchList: [...watchList, { address, name }],
      }),
      this.cache.setWhaleWallets(whaleWallet),
    ]);

    return "Add wallet to watch list successfully";
  }

  async removeWatchWallet({
    userId,
    address,
    channelId,
  }: {
    userId: number;
    address: string;
    channelId: number;
  }) {
    const [user, whaleWallet] = await Promise.all([
      this.cache.getUser(userId),
      this.cache.getWhaleWallets(),
    ]);
    const watchList = user.watchList ?? [];
    delete whaleWallet[address].subscribe[channelId];

    this.cache.redis.publish(
      REDIS_WHALE_WALLET,
      JSON.stringify({
        wallet: address,
        channelId,
        type: "add",
      }),
    );

    await Promise.all([
      this.cache.setUser(userId, {
        ...user,
        watchList: watchList.filter((acc) => acc.address !== address),
      }),
      this.cache.setWhaleWallets(whaleWallet),
    ]);

    return "Remove wallet to watch list successfully";
  }

  async importWallet(userId: number, key: string) {
    const acc = parseKey(key);

    const user = await this.cache.getUser(userId);
    const isExist = user.accounts.some((item) => item.address === acc.address);
    if (isExist) return "Wallet already exist";

    await this.cache.setUser(userId, {
      ...user,
      accounts: [
        ...user?.accounts,
        {
          address: acc.address,
          privateKey: acc.privateKey,
          mnemonic: null,
        },
      ],
    });
    return "Import successfully";
  }

  async createWallet(userId: number) {
    const acc = createAccount();
    const user = await this.cache.getUser(userId);
    this.cache.setUser(userId, {
      ...user,
      accounts: [
        ...user?.accounts,
        {
          address: acc.address,
          mnemonic: acc.mnemonic?.phrase,
          privateKey: acc.privateKey,
        },
      ],
    });
    return acc;
  }

  async listWallet(userId: number): Promise<TelegramBot.SendMessageOptions> {
    const user = await this.cache.getUser(userId);
    const accountList = user.accounts?.map((acc) => [
      {
        text: shortenAddress(acc.address, 8),
        callback_data: `detail_wallet ${acc.address}`,
      },
      { text: "❌ Delete", callback_data: `remove_wallet ${acc.address}` },
    ]);

    return {
      reply_markup: {
        inline_keyboard: accountList,
      },
    };
  }

  async deleteWallet(userId: number, address: string) {
    const user = await this.cache.getUser(userId);
    const accounts = user.accounts.filter((acc) => acc.address !== address);

    if (user.mainAccount?.address === address) {
      user.mainAccount = accounts.at(0) ?? null;
    }

    await this.cache.setUser(userId, { ...user, accounts });
    return "Delete successfully";
  }

  async checkToken({ address, userId }: { address: string; userId: number }) {
    const acc = await this.getAccount(userId);
    if (!acc)
      return {
        text: "Wallet not found",
        buttons: {
          reply_markup: {
            inline_keyboard: [[{ text: "❎ Close", callback_data: CLOSE }]],
          },
        },
      };

    const token = new Erc20Token(address, "token", 18, this.provider);
    const { name, symbol, decimals, balance } = await token.getInfo(
      acc.address,
    );

    // this.market.tokenInfo(address);

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "💸 Buy by 0.1ETH",
              callback_data: `buy_token ${address}`,
            },
            {
              text: "💸 Buy custom amount",
              callback_data: `buy_custom ${address}`,
            },
          ],
          [
            {
              text: "💰 Sell custom amount",
              callback_data: `sell_custom ${address}`,
            },
          ],
          [
            { text: "↪️  Buy Menu", callback_data: `sell ${address}` },
            { text: "🎛️ Menu", callback_data: "MENU" },
          ],
          [{ text: "❎ Close", callback_data: CLOSE }],
        ],
      },
    };

    return {
      buttons,
      text: tokenDetail({
        name,
        symbol,
        address,
        balance,
        decimals,
        supply: 1000,
        marketcap: 100000,
        price: 10000,
      }),
    };
  }

  async estimate({
    userId,
    amount,
    tokenAddress,
  }: {
    userId: number;
    amount: number;
    tokenAddress: string;
  }) {
    const acc = await this.getAccount(userId);
    if (!acc) return { text: "Account not found", buttons: {} };

    if (isWETH(tokenAddress)) {
      const weth = new WrapToken(tokenAddress, "WETH", 18, this.provider);
      const gas = await weth.estimateGas("deposit", amount);
      const { balance } = await getBalance(acc);

      const id = uuidv4();
      this.cache.setOrder(id, { amount, tokenAddress });
      // const res = await weth.wrap(amount, acc.privateKey);

      const buttonConfirm =
        balance >= amount
          ? { text: "👌 Confirm", callback_data: `confirm_swap ${id}` }
          : { text: "💔 Don't enough token", callback_data: CLOSE };

      return {
        text: esstimateMsg({ gas, amount, balance }),
        buttons: {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⭕ No", callback_data: CLOSE }, buttonConfirm],
            ],
          },
        },
      };
    } else {
      return this.estimateTrade({
        userId,
        amount,
        tokenAddress,
      });
    }
  }

  async estimateRoute({
    userId,
    amount,
    tokenAddress,
  }: {
    userId: number;
    amount: number;
    tokenAddress: string;
  }) {
    const tokenA = WETH9[chainId];
    const tokenB = new Token(chainId, tokenAddress, 18);

    const account = await this.getAccount(userId);
    if (!account) return { text: "User haven't got wallet" };

    const [pair, route] = await Promise.all([
      this.uniswap.checkBalance({
        walletAddress: account.address,
        tokens: { tokenA, tokenB },
      }),

      this.uniswap.generateRoute({
        walletAddress: account.address,
        tokenA,
        tokenB,
        amount,
        account,
      }),
    ]);

    if (!route) {
      return { text: "Token do not support", buttons: null };
    }

    const id = uuidv4();
    this.cache.setOrder(id, route);

    const ratio = shortenAmount(route.quote.toExact() ?? 0);
    const buttonConfirm =
      Number(pair.tokenA.balance) >= amount
        ? { text: "👌 Confirm", callback_data: `confirm_swap ${id}` }
        : { text: "💔 Don't enough token", callback_data: CLOSE };

    return {
      text: esstimateSwap({
        tokenA: pair.tokenA.symbol,
        tokenB: pair.tokenB.symbol,
        amountIn: amount,
        amountOut: shortenAmount(amount / ratio),
        amountA: shortenAmount(pair.tokenA.balance),
        amountB: shortenAmount(pair.tokenB.balance),
        gwei: shortenAmount(route.gasPriceWei.toString() ?? 0),
        dollars: shortenAmount(route.estimatedGasUsedUSD.toExact() ?? 0),
        ratio,
      }),
      buttons: {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⭕ No", callback_data: CLOSE }, buttonConfirm],
          ],
        },
      },
    };
  }

  async estimateTrade({
    userId,
    amount,
    tokenAddress,
  }: {
    userId: number;
    amount: number;
    tokenAddress: string;
  }) {
    const tokenA = WETH9[chainId];
    const tokenB = new Token(chainId, tokenAddress, 18);

    const account = await this.getAccount(userId);
    if (!account) return { text: "User haven't got wallet" };

    const [pair, trade] = await Promise.all([
      this.uniswap.checkBalance({
        walletAddress: account.address,
        tokens: { tokenA, tokenB },
      }),
      this.uniswap.generateTrade({
        tokenA,
        tokenB,
        amount,
        account,
      }),
    ]);

    if (!trade) {
      return { text: "Token do not support", buttons: null };
    }

    if (pair.tokenA.balance < amount) {
      return { text: `Not enough amount of ${tokenA.name}`, buttons: null };
    }

    const a = await this.uniswap.executeTrade({ account, trade });

    return {
      text: `✅ Buy token success \nCheck transaction: [etherscan](${urlScan()}/tx/${a?.transactionHash})`,
    };
  }

  async confirmSwap({ id, userId }: { id: string; userId: number }) {
    const [data, account] = await Promise.all([
      this.cache.getOrder(id),
      this.getAccount(userId),
    ]);

    if (!account) return "No wallet found";

    try {
      if (isSwapRoute(data)) {
        return this.swap({ data, account });
      }

      if (isOrder(data)) {
        const address = data.tokenAddress;
        const weth = new WrapToken(address, "WETH", 18, this.provider);
        return weth.wrap(data.amount, account.privateKey);
      }

      if (isTrade(data)) {
        console.log("Start confirm trade");
        const a = await this.uniswap.executeTrade({
          trade: data as any,
          account,
        });
        console.log(a);
      }
    } catch (error) {
      console.log(error);
      return "Transaction is failed";
    }
  }

  async swap({ data, account }: { data: SwapRoute; account: Account }) {
    const token = data?.route.at(0)?.route.input;
    if (!data || !token) return "Transaction is expired";

    console.log("start swappp");

    const result = await this.uniswap.executeRoute({ account, route: data });
    console.log(result);

    return result;
  }

  async getDetails({ wallet, userId }: { wallet: string; userId: number }) {
    const [balance, block, user] = await Promise.all([
      this.provider.getBalance(wallet),
      getBlock(),
      this.cache.getUser(userId),
    ]);

    const acc = user.accounts.find((a) => a.address === wallet);
    if (!acc) return { text: "Not found account" };

    this.cache.setUser(userId, {
      ...user,
      mainAccount: acc,
    });

    return {
      text: walletDetail({
        block: block.block?.number ?? 0,
        ethPrice: block.ethPrice,
        balance: bigintToNumber(balance),
      }),
      buttons: {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Buy Token", callback_data: BUY_TOKEN },
              { text: "Sell Token", callback_data: SELL_TOKEN },
            ],
            [
              { text: "Buy Limit", callback_data: BUY_LIMIT },
              { text: "Sell Limit", callback_data: SELL_LIMIT },
            ],
            [
              { text: "Token Balance", callback_data: "Token Balance" },
              { text: "Wallet Analysis", callback_data: "Wallet Analysis" },
              { text: "Flex Pnl", callback_data: "Flex Pnl" },
            ],
          ],
        },
      },
    };
  }

  // async getBalance(accounts: Account) {
  //   const amount = await this.provider
  //     .getBalance(accounts.address)
  //     .then((data) => Number(formatEther(data)));
  //
  //   return {
  //     address: accounts.address,
  //     balance: amount,
  //   };
  // }

  async getAccount(userId: number) {
    const user = await this.cache.getUser(userId);
    const acc = user.mainAccount;
    const firstAcc = user.accounts?.at(0);

    if (!firstAcc) return null;
    if (acc) return acc;

    this.cache.setUser(userId, {
      ...user,
      mainAccount: firstAcc,
    });

    return firstAcc;
  }
}
