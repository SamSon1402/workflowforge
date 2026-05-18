/**
 * Bank integration activities.
 *
 * In production these would call out to Plaid AISP (Round is FRN 804718)
 * for balance aggregation and Plaid Payments / direct bank APIs for
 * payment initiation. Here we keep them as stubs with realistic shapes
 * so the workflow interpreter has something to chew on end-to-end.
 *
 * Each function is idempotent on the caller side: Temporal's retry
 * policy means activities can run more than once on transient errors,
 * so any external call must include an idempotency key.
 */

export interface BankBalance {
  accountId: string;
  bank: string;
  balance: number;
  currency: string;
  asOf: string;
}

/** Snapshot all connected accounts. */
export async function aggregateBalances(_args: Record<string, unknown>): Promise<{
  balances: BankBalance[];
  balance: number;            // alias for the largest GBP balance (decision sugar)
}> {
  // TODO: real Plaid AISP call
  //   const plaid = new PlaidApi(plaidConfig);
  //   const tokens = await loadAccessTokensForOrg(orgId);
  //   const accounts = await Promise.all(tokens.map(t => plaid.accountsBalanceGet({ access_token: t })));
  //   return accounts.flatMap(...);

  const balances: BankBalance[] = [
    { accountId: 'hsbc-001',    bank: 'HSBC',    balance: 148000, currency: 'GBP', asOf: new Date().toISOString() },
    { accountId: 'wise-001',    bank: 'Wise',    balance: 72400,  currency: 'EUR', asOf: new Date().toISOString() },
    { accountId: 'revolut-001', bank: 'Revolut', balance: 62000,  currency: 'GBP', asOf: new Date().toISOString() },
  ];

  const balance = Math.max(
    ...balances.filter(b => b.currency === 'GBP').map(b => b.balance)
  );

  return { balances, balance };
}

/** Move money between two connected accounts. */
export async function transferFunds(args: {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  reference?: string;
}): Promise<{ transactionId: string; settledAt: string }> {
  // TODO: real Plaid Payments / direct bank API call
  //   const idempotencyKey = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  //   const tx = await plaid.paymentInitiationPaymentCreate({ ..., idempotencyKey });

  return {
    transactionId: `tx_${Math.floor(Date.now() / 1000)}_${args.fromAccountId}`,
    settledAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

/** Deposit GBP into the Insignis MMF (BlackRock ICS Sterling Liquidity). */
export async function depositToMmf(args: { amount: number; source?: string }): Promise<{
  reference: string;
  yieldRate: number;
  estimatedEarnings90d: number;
}> {
  // TODO: Insignis SFTP / API integration
  return {
    reference: `INS-${Date.now()}`,
    yieldRate: 0.0485,
    estimatedEarnings90d: Math.round(args.amount * 0.0485 * (90 / 365) * 100) / 100,
  };
}

/** Withdraw GBP from MMF (T+1 settlement). */
export async function withdrawFromMmf(args: { amount: number }): Promise<{
  reference: string;
  expectedSettlement: string;
}> {
  return {
    reference: `INS-W-${Date.now()}`,
    expectedSettlement: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

/** Estimate the next payroll total from the connected HRIS. */
export async function estimatePayroll(_args: Record<string, unknown>): Promise<{
  total: number;
  employeeCount: number;
  currency: string;
}> {
  // TODO: PayFit / Deel / Pento API call
  return { total: 187420, employeeCount: 28, currency: 'GBP' };
}
