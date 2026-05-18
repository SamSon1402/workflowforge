/**
 * Notification activities (Slack + email).
 *
 * Production would use @slack/web-api and a transactional email
 * provider (Resend / Postmark). Kept thin here.
 */

export async function slackDm(args: { user: string; message: string }): Promise<void> {
  // TODO: real Slack Web API
  //   await new WebClient(process.env.SLACK_BOT_TOKEN).chat.postMessage({
  //     channel: args.user,
  //     text: args.message,
  //   });
  console.log(`[slack.dm] ${args.user} :: ${args.message}`);
}

export async function slackChannel(args: { channel: string; message: string }): Promise<void> {
  console.log(`[slack.channel] ${args.channel} :: ${args.message}`);
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ messageId: string }> {
  console.log(`[email] to=${args.to} subject="${args.subject}"`);
  return { messageId: `msg_${Date.now()}` };
}

export async function notifyException(args: {
  runId: string;
  nodeId: string;
  error: string;
}): Promise<void> {
  await slackChannel({
    channel: '#treasury-ops',
    message: `🚨 Run ${args.runId} failed at ${args.nodeId} — ${args.error}`,
  });
}
