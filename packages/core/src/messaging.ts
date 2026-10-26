/**
 * What sends mail or text messages, read from the dependencies a service declares: an SDK or a mail starter says *how*,
 * a configuration key or a variable says *where*. The map gets an external for each, with the variable that names its
 * server (`attrs.via`), so an env can put its own mailbox there. A provider that is reached by an HTTP API (SendGrid,
 * Mailgun, SES…) is marked, not served: the screen warns instead of offering to intercept it.
 */
export interface Messaging {
  /** the dependency name: npm package, or maven `group:artifact` */
  dep: RegExp;
  kind: 'smtp' | 'sms' | 'http';
  provider: string;
  /** a server that is fixed by the SDK: the external's name */
  host?: string;
  /** variables that name the server, in the order they are looked for in the service's code and configuration */
  vars?: string[];
}

export const MESSAGING: Messaging[] = [
  { dep: /^nodemailer$/, kind: 'smtp', provider: 'nodemailer', vars: ['SMTP_HOST', 'MAIL_HOST', 'EMAIL_HOST', 'SMTP_SERVER'] },
  { dep: /(?:^|:)spring-boot-starter-mail$/, kind: 'smtp', provider: 'Spring Mail', vars: ['SPRING_MAIL_HOST', 'MAIL_HOST', 'SMTP_HOST'] },
  { dep: /(?:^|:)(?:jakarta\.mail|javax\.mail|jakarta\.mail-api|angus-mail)(?:$|-)/, kind: 'smtp', provider: 'Jakarta Mail', vars: ['SMTP_HOST', 'MAIL_HOST'] },
  { dep: /(?:^|:)quarkus-mailer$/, kind: 'smtp', provider: 'Quarkus Mailer', vars: ['QUARKUS_MAILER_HOST', 'SMTP_HOST', 'MAIL_HOST'] },
  { dep: /^twilio$|^com\.twilio\.sdk:twilio$/, kind: 'sms', provider: 'Twilio', host: 'api.twilio.com' },
  { dep: /^@sendgrid\/mail$|^com\.sendgrid:sendgrid-java$/, kind: 'http', provider: 'SendGrid', host: 'api.sendgrid.com' },
  { dep: /^mailgun(?:\.js|-js)$|mailgun-java/, kind: 'http', provider: 'Mailgun', host: 'api.mailgun.net' },
  { dep: /^postmark$|postmark-java/, kind: 'http', provider: 'Postmark', host: 'api.postmarkapp.com' },
  { dep: /^@aws-sdk\/client-sesv?2?$|^software\.amazon\.awssdk:sesv?2?$/, kind: 'http', provider: 'Amazon SES', host: 'email.amazonaws.com' },
  { dep: /^@aws-sdk\/client-sns$|^software\.amazon\.awssdk:sns$/, kind: 'http', provider: 'Amazon SNS', host: 'sns.amazonaws.com' },
  { dep: /^vonage|^@vonage\/|^nexmo$/, kind: 'http', provider: 'Vonage', host: 'rest.nexmo.com' },
  { dep: /^messagebird$/, kind: 'http', provider: 'MessageBird', host: 'rest.messagebird.com' },
];

/** `${MAIL_HOST:smtp.gmail.com}` is the host `smtp.gmail.com` read from the variable `MAIL_HOST`; a bare `${MAIL_HOST}` knows no host. */
export function placeholder(value: string): { var: string; default?: string } | undefined {
  const m = /^\$\{([A-Za-z_][\w]*)(?::([^}]*))?\}$/.exec(value.trim());
  return m ? { var: m[1], ...(m[2] !== undefined ? { default: m[2] } : {}) } : undefined;
}
