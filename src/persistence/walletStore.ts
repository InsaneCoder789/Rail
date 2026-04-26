export interface Wallet {
  walletId: string;
  balanceMinor: number;
}

export class InMemoryWalletStore {
  private wallets = new Map<string, Wallet>();

  createWallet(walletId: string, balanceMinor: number) {
    this.wallets.set(walletId, { walletId, balanceMinor });
  }

  getBalance(walletId: string): number {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error("wallet_not_found");
    return wallet.balanceMinor;
  }

  debit(walletId: string, amount: number) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error("wallet_not_found");

    if (wallet.balanceMinor < amount) {
      throw new Error("insufficient_balance");
    }

    wallet.balanceMinor -= amount;
  }

  credit(walletId: string, amount: number) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error("wallet_not_found");

    wallet.balanceMinor += amount;
  }
}