// Sends one real email through the configured Resend SMTP relay.
// Purpose: verify SMTP credentials and DNS authentication (SPF/DKIM/DMARC)
// BEFORE wiring the Forgot credentials flow. Check the message lands in the
// inbox (not spam), then inspect Delivery logs in Resend Dashboard -> Logs.
import 'dotenv/config';
import { isMailConfigured, readMailConfig, sendMail } from '../mailer';

const TEST_TO = process.env.SMTP_TEST_TO?.trim();

async function main() {
  if (!TEST_TO) {
    throw new Error('SMTP_TEST_TO is not set. Point it at an inbox you can check (add it to your local .env).');
  }
  if (!isMailConfigured()) {
    throw new Error(
      'SMTP settings are incomplete. Fill SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM_EMAIL in your .env or deployment secrets.'
    );
  }
  const config = readMailConfig();
  console.log(`[test-smtp] Sending via ${config.host}:${config.port} from ${config.fromEmail}...`);
  const result = await sendMail({
    to: TEST_TO,
    subject: '[Countdown Studio] Resend SMTP smoke test',
    text:
      'This is a one-off smoke test from the Countdown Studio backend.\n\n' +
      'If this message reached your inbox (not the spam folder), the Resend SMTP setup is working.\n' +
      `Sent at ${new Date().toISOString()}.`,
    html:
      '<p>This is a one-off smoke test from the Countdown Studio backend.</p>' +
      '<p>If this message reached your <strong>inbox</strong> (not the spam folder), the Resend SMTP setup is working.</p>' +
      `<p style="color:#6b7280">Sent at ${new Date().toISOString()}</p>`,
  });
  console.log(`[test-smtp] Delivered. messageId=${result.messageId}`);
  console.log(`[test-smtp] Now check Resend Dashboard -> Logs for the delivery status.`);
}

main().catch((error) => {
  console.error('[test-smtp] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
