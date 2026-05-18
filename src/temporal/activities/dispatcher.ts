import * as banks from './banks';
import * as notifications from './notifications';

/**
 * Activity dispatcher.
 *
 * The DSL references activities by string ("banks.aggregate"). The
 * workflow interpreter calls a single `dispatchActivity` and we route
 * to the right implementation here. This decouples spec evolution
 * from worker redeployment for new compositions of existing primitives.
 *
 * Adding a new activity = adding it to the catalogue here AND the
 * compiler's system prompt (so Claude knows it exists).
 */

type ActivityFn = (args: Record<string, unknown>) => Promise<unknown>;

const CATALOGUE: Record<string, ActivityFn> = {
  'banks.aggregate':   banks.aggregateBalances as ActivityFn,
  'banks.transfer':    banks.transferFunds      as ActivityFn,
  'insignis.deposit':  banks.depositToMmf       as ActivityFn,
  'insignis.withdraw': banks.withdrawFromMmf    as ActivityFn,
  'payroll.estimate':  banks.estimatePayroll    as ActivityFn,
  'slack.dm':          notifications.slackDm    as ActivityFn,
  'slack.channel':     notifications.slackChannel as ActivityFn,
  'email.send':        notifications.sendEmail  as ActivityFn,
};

export class UnknownActivityError extends Error {
  constructor(name: string) {
    super(`unknown activity: ${name}`);
    this.name = 'UnknownActivityError';
  }
}

export async function dispatchActivity(args: {
  name: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  // "custom.*" activities are routed to a fallback handler so the
  // compiler can emit them when the user asks for something not in
  // the core catalogue. For now we no-op them with a log line.
  if (args.name.startsWith('custom.')) {
    console.log(`[custom-fallback] ${args.name}`, args.args);
    return { handled: false, name: args.name };
  }

  const fn = CATALOGUE[args.name];
  if (!fn) throw new UnknownActivityError(args.name);
  return fn(args.args);
}
