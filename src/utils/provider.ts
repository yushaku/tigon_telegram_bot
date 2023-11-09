import { BigNumber, ethers } from "ethers";
import { CurrentConfig } from "./config";
import { Provider as ZkProvider } from "zksync-web3";
import { env } from "./constants";
import { TransactionRequest } from "@ethersproject/providers";

const mainnetProvider = new ethers.providers.JsonRpcProvider(
  CurrentConfig.rpc.mainnet,
);
const wallet = createWallet();

export enum TransactionState {
  Failed = "Failed",
  New = "New",
  Rejected = "Rejected",
  Sending = "Sending",
  Sent = "Sent",
}

// Provider and Wallet Functions

export function getMainnetProvider() {
  return mainnetProvider;
}

export function getProvider() {
  switch (env.NODE_ENV) {
    case "ZKSYNC":
      return new ZkProvider("https://testnet.era.zksync.dev");

    case "TESTNET":
      return new ethers.providers.JsonRpcProvider(CurrentConfig.rpc.testnet);

    case "MAINNET":
      return mainnetProvider;

    default:
      return mainnetProvider;
  }
}

export function getWalletAddress(): string | null {
  return wallet.address;
}

export async function sendTransaction(
  transaction: ethers.providers.TransactionRequest,
): Promise<TransactionState> {
  if (transaction.value) {
    transaction.value = BigNumber.from(transaction.value);
  }
  return sendTransactionViaWallet(transaction);
}

// export async function connectBrowserExtensionWallet() {
//   if (!window.ethereum) {
//     return null;
//   }
//
//   const { ethereum } = window;
//   const provider = new ethers.providers.Web3Provider(ethereum);
//   const accounts = await provider.send("eth_requestAccounts", []);
//
//   if (accounts.length !== 1) {
//     return;
//   }
//
//   walletExtensionAddress = accounts[0];
//   return walletExtensionAddress;
// }

function createWallet(): ethers.Wallet {
  const provider = getProvider();
  return new ethers.Wallet(CurrentConfig.wallet.privateKey, provider);
}

// function createBrowserExtensionProvider(): Web3Provider | null {
//   try {
//     return new Web3Provider(window?.ethereum, "any");
//   } catch (e) {
//     console.log("No Wallet Extension Found");
//     return null;
//   }
// }

// Transacting with a wallet extension via a Web3 Provider
// async function sendTransactionViaExtension(
//   transaction: TransactionRequest,
// ): Promise<TransactionState> {
//   try {
//     const receipt = await browserExtensionProvider?.send(
//       "eth_sendTransaction",
//       [transaction],
//     );
//     if (receipt) {
//       return TransactionState.Sent;
//     } else {
//       return TransactionState.Failed;
//     }
//   } catch (e) {
//     console.log(e);
//     return TransactionState.Rejected;
//   }
// }

async function sendTransactionViaWallet(
  transaction: TransactionRequest,
): Promise<TransactionState> {
  if (transaction.value) {
    transaction.value = BigNumber.from(transaction.value);
  }
  const txRes = await wallet.sendTransaction(transaction);

  let receipt = null;
  const provider = getProvider();
  if (!provider) {
    return TransactionState.Failed;
  }

  while (receipt === null) {
    try {
      receipt = await provider.getTransactionReceipt(txRes.hash);

      if (receipt === null) {
        continue;
      }
    } catch (e) {
      console.log(`Receipt error:`, e);
      break;
    }
  }

  // Transaction was successful if status === 1
  if (receipt) {
    return TransactionState.Sent;
  } else {
    return TransactionState.Failed;
  }
}