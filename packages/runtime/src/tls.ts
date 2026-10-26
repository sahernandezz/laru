/**
 * A local certificate authority for the HTTPS hosts an app calls by name (a payment provider, a partner API): the
 * tap answers for them with a certificate this CA signed, and the env's services are told to trust it. Made with
 * the host's openssl (LibreSSL on macOS); the CA key never leaves ~/.laru/ca (0600).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { laruHome, WorkspaceError } from '@laru/core';
import { docker, LABEL } from './docker.ts';

export const caDir = () => join(laruHome(), 'ca');
const ssl = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

/** The CA, created once: ca.crt (shared with containers) and ca.key (never mounted). */
export function ensureCA(): { cert: string; key: string } {
  const dir = caDir();
  const cert = join(dir, 'ca.crt'), key = join(dir, 'ca.key');
  if (existsSync(cert) && existsSync(key)) return { cert, key };
  mkdirSync(join(dir, 'hosts'), { recursive: true });
  try {
    ssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    chmodSync(key, 0o600);
    ssl(['req', '-x509', '-new', '-key', key, '-sha256', '-days', '3650', '-subj', '/CN=Laru local CA/O=Laru', '-out', cert]);
  } catch (e) { throw new WorkspaceError(`openssl could not create the local CA: ${String((e as { stderr?: Buffer }).stderr ?? e).trim()}`); }
  return { cert, key };
}

/** A certificate for one host, signed by the CA, with the host as subjectAltName; reused while it exists. */
export function leafFor(host: string): { cert: string; key: string } {
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new WorkspaceError(`"${host}" is not a host name`, 'hosts');
  const ca = ensureCA();
  const dir = join(caDir(), 'hosts');
  const cert = join(dir, `${host}.crt`), key = join(dir, `${host}.key`);
  if (existsSync(cert) && existsSync(key)) return { cert, key };
  const ext = join(dir, `${host}.ext`), csr = join(dir, `${host}.csr`);
  writeFileSync(ext, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n`);
  ssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  chmodSync(key, 0o644); // read by the tap, which runs as the user in the container
  ssl(['req', '-new', '-key', key, '-subj', `/CN=${host}`, '-out', csr]);
  ssl(['x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-days', '825', '-sha256', '-extfile', ext, '-out', cert]);
  return { cert, key };
}

const JRE = 'eclipse-temurin:21-jre-alpine';

/**
 * A Java truststore: the JRE's own CAs plus the local one, as PKCS12 (read by any JVM since 9), made once with the
 * keytool of a stock JRE image. Only the CA's certificate is mounted into that container, never its key.
 */
export async function ensureTruststore(): Promise<string> {
  const { cert } = ensureCA();
  const out = join(caDir(), 'trust');
  const store = join(out, 'cacerts');
  if (existsSync(store)) return store;
  mkdirSync(out, { recursive: true });
  await docker(['run', '--rm', '--label', `${LABEL.tool}=truststore`, '-v', `${cert}:/in/ca.crt:ro`, '-v', `${out}:/out`, '--entrypoint', 'sh', JRE, '-c',
    'cp "$JAVA_HOME/lib/security/cacerts" /out/cacerts.tmp && keytool -importcert -noprompt -alias laru-local-ca -file /in/ca.crt -keystore /out/cacerts.tmp -storepass changeit -storetype PKCS12 >/dev/null && mv /out/cacerts.tmp /out/cacerts'], { timeoutMs: 300_000 });
  return store;
}
