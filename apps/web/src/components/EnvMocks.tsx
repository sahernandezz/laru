/**
 * An env's mocks and mailbox on its own page: what the app's mail and messages land in (Laru's mailbox, with the last
 * few, or a catcher Laru does not see), and every dependency the interceptor stands in front of, real or mocked, with
 * its faults. Each line leads to its screen: «Correo y mensajes», or the dependency in «Mocks y fallos».
 */
import { ArrowLeftRight, Inbox, Mail as MailIcon, MessageSquare, Plug, Zap } from 'lucide-react';
import { useApi, type MocksData } from '../api.ts';
import { MOCK_MODE, plural } from '../lib/es.ts';
import { href } from '../lib/route.ts';

interface Box {
  sinks?: { hasSinks: boolean; sinks: Array<{ name: string; kind: 'smtp' | 'twilio' | 'api'; receives?: 'sms' | 'mail' }> };
  /** where a mock of the env publishes what it receives, to be seen here */
  mailbox?: string;
  counts: { all: number; mail: number; sms: number };
  messages: Array<{ id: string; kind: 'mail' | 'sms'; t: number; to: string; subject: string }>;
}

export function EnvMocks({ env }: { env: string }) {
  const m = useApi<MocksData>(`/api/mocks?env=${encodeURIComponent(env)}`);
  const box = useApi<Box>(`/api/mail?env=${encodeURIComponent(env)}&limit=4`);
  const b = box.data, routes = m.data?.routes ?? [];
  return (
    <div className="env-mocks">
      <section className="panel block" aria-labelledby="em-mail-h">
        <header><Inbox /><h3 id="em-mail-h">Correo y mensajes</h3><div className="meta"><a className="rowlink" href={href('mail', env)}>Abrir el buzón</a></div></header>
        {!b ? <div className="empty">…</div> : b.sinks?.hasSinks ? (
          <div className="em-body">
            <p className="faint">{b.sinks.sinks.map((s) => `${s.name}: ${s.kind === 'smtp' ? 'correo por SMTP' : s.kind === 'twilio' ? 'SMS por Twilio' : `${s.receives === 'mail' ? 'correo' : 'mensajes'} por API`}`).join(' · ')}</p>
            <div className="em-counts"><span><MailIcon />{plural(b.counts.mail, 'correo', 'correos')}</span><span><MessageSquare />{plural(b.counts.sms, 'mensaje', 'mensajes')}</span></div>
            {b.messages.length > 0 && <ul className="em-last">{b.messages.map((x) => (
              <li key={x.id}><a href={href('mail', env, x.id)}>{x.kind === 'mail' ? <MailIcon /> : <MessageSquare />}<span className="em-subj">{x.subject || '(sin asunto)'}</span><span className="faint mono">{x.to}</span></a></li>
            ))}</ul>}
          </div>
        ) : (
          <div className="em-body">
            <p>Todavía no ha llegado nada al buzón de {env}. Lo que la aplicación envíe se ve aquí si lo recibe un buzón de Laru, o si el mock que lo recibe lo publica en <code className="mono">{b.mailbox ?? 'http://laru-mailbox/messages'}</code>.</p>
            <p className="faint"><a className="rowlink" href={href('mail', env)}>Cómo conectarlo</a></p>
          </div>
        )}
      </section>

      <section className="panel block" aria-labelledby="em-mocks-h">
        <header><Plug /><h3 id="em-mocks-h">Mocks y dependencias</h3><div className="meta">{routes.length ? plural(routes.length, 'dependencia', 'dependencias') : ''}</div></header>
        {!m.data ? <div className="empty">{m.error && /has not been started/.test(m.error) ? `${env} no se ha levantado: el interceptor nace con su primer arranque.` : '…'}</div> : !routes.length ? <div className="empty">El interceptor no tiene ninguna dependencia delante.</div> : (
          <ul className="em-deps">{routes.map((r) => {
            const mock = m.data!.rules.mocks[r.svc], n = m.data!.rules.faults[r.svc]?.length ?? 0;
            const word = !mock ? 'real' : mock.mode === 'sink' ? 'buzón de Laru' : `mock: ${MOCK_MODE[mock.mode]?.label.toLowerCase() ?? mock.mode}`;
            return (
              <li key={r.svc}><a href={href('mocks', env, r.svc)}>
                {n ? <Zap className="ic-fault" /> : mock ? <Plug /> : <ArrowLeftRight />}
                <b className="mono">{r.svc}</b>
                <span className={`chip${mock ? ' accent' : ''}`}>{word}</span>
                {n > 0 && <span className="chip run">{plural(n, 'fallo', 'fallos')}</span>}
                <span className="faint em-proto">{r.proto.toUpperCase()}</span>
              </a></li>
            );
          })}</ul>
        )}
      </section>
    </div>
  );
}
