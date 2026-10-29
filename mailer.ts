// Brevo SMTP mailer shared by the whole app (transactional email only).
// Credentials come from deployment secrets, never from source control.
import nodemailer, { type SendMailOptions, type SentMessageInfo, type Transporter } from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function readMailConfig(): MailConfig {
  const port = Number(readRequiredEnv('SMTP_PORT')) || 587;
  const secureEnv = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureEnv === undefined || secureEnv === ''
    ? port === 465 // 465 speaks implicit TLS; 587 upgrades with STARTTLS.
    : secureEnv === 'true';
  return {
    host: readRequiredEnv('SMTP_HOST'),
    port,
    secure,
    user: readRequiredEnv('SMTP_USER'),
    password: readRequiredEnv('SMTP_PASSWORD'),
    fromEmail: readRequiredEnv('SMTP_FROM_EMAIL'),
    fromName: process.env.SMTP_SENDER_NAME?.trim() || 'Countdown Studio',
  };
}

export function isMailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_PORT?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASSWORD?.trim() &&
    process.env.SMTP_FROM_EMAIL?.trim()
  );
}

const cachedTransporters = new Map<string, Transporter<SentMessageInfo>>();
let cachedConfigSignature = '';

function getTransporter(config: MailConfig): Transporter<SentMessageInfo> {
  const signature = `${config.host}:${config.port}:${config.user}`;
  if (cachedConfigSignature !== signature) {
    cachedTransporters.clear();
    cachedConfigSignature = signature;
  }
  let transporter = cachedTransporters.get(signature);
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      // SMTP relays occasionally stall; fail fast so HTTP callers are not hung.
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
    });
    cachedTransporters.set(signature, transporter);
  }
  return transporter;
}

function buildFromAddress(config: MailConfig): string {
  // Quotes are escaped so display names with quotes cannot break the header.
  const name = config.fromName.replace(/"/g, '\\"');
  return `${name} <${config.fromEmail}>`;
}

export async function sendMail(message: MailMessage): Promise<{ messageId: string; accepted: string[] }> {
  const config = readMailConfig();
  const options: SendMailOptions = {
    from: buildFromAddress(config),
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  const info = await getTransporter(config).sendMail(options);
  const accepted = info.accepted ?? [];
  return { messageId: info.messageId, accepted: accepted.map((entry: string | { address?: string }) => String(entry)) };
}
