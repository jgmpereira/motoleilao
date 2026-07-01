import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function generatePassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('');
}

async function enviarEmailBoasVindas(email: string, senha: string): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.warn('[kiwify-webhook] RESEND_API_KEY não configurada, email não enviado');
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:100%;">
        <!-- Header laranja -->
        <tr>
          <td style="background:#ff4d00;padding:28px 40px;text-align:center;">
            <span style="font-family:Georgia,serif;font-size:28px;font-weight:900;letter-spacing:4px;color:#ffffff;text-transform:uppercase;">MOTO<span style="color:#ffe0d0;">LEILÃO</span></span>
          </td>
        </tr>
        <!-- Corpo -->
        <tr>
          <td style="padding:36px 40px 28px;">
            <h2 style="margin:0 0 8px;font-size:22px;color:#1a1d23;">Bem-vindo ao MotoLeilão! 🏍️</h2>
            <p style="margin:0 0 24px;font-size:15px;color:#5a6070;line-height:1.6;">Seu pagamento foi confirmado. Use as credenciais abaixo para acessar o painel.</p>

            <!-- Card de credenciais -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa;border:1px solid #dde1e7;border-radius:10px;margin-bottom:28px;">
              <tr>
                <td style="padding:20px 24px;">
                  <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#8a92a0;">Seus dados de acesso</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:8px 0;border-bottom:1px solid #eef0f3;">
                        <span style="font-size:12px;color:#8a92a0;">Email</span><br>
                        <strong style="font-size:15px;color:#1a1d23;">${email}</strong>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:8px 0;">
                        <span style="font-size:12px;color:#8a92a0;">Senha temporária</span><br>
                        <strong style="font-size:20px;color:#ff4d00;font-family:'Courier New',monospace;letter-spacing:3px;">${senha}</strong>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Botão -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td align="center">
                  <a href="https://jgmpereira.github.io/motoleilao" style="display:inline-block;background:#ff4d00;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.5px;padding:14px 36px;border-radius:8px;">Acessar o MotoLeilão →</a>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;color:#8a92a0;line-height:1.6;">Ao entrar pela primeira vez você será solicitado a criar uma senha permanente.</p>
          </td>
        </tr>
        <!-- Rodapé -->
        <tr>
          <td style="padding:16px 40px;border-top:1px solid #eef0f3;text-align:center;">
            <p style="margin:0;font-size:11px;color:#b0b8c4;">Bons leilões &mdash; Equipe MotoLeilão</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'MotoLeilão <contato@motoleiloes.com.br>',
      to: [email],
      subject: 'Seu acesso ao MotoLeilão está pronto!',
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[kiwify-webhook] erro ao enviar email via Resend:', err);
  } else {
    console.log(`[kiwify-webhook] 📧 email enviado para ${email}`);
  }
}

const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') ?? 'jgmpereira123@gmail.com';

async function enviarAvisoAdmin(assunto: string, linhas: Record<string, string>): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.warn('[kiwify-webhook] RESEND_API_KEY não configurada, aviso ao admin não enviado');
    return;
  }

  const linhasHtml = Object.entries(linhas)
    .map(
      ([label, valor]) => `
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #eef0f3;">
                      <span style="font-size:12px;color:#8a92a0;">${label}</span><br>
                      <strong style="font-size:15px;color:#1a1d23;">${valor}</strong>
                    </td>
                  </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:100%;">
        <tr>
          <td style="background:#ff4d00;padding:28px 40px;text-align:center;">
            <span style="font-family:Georgia,serif;font-size:28px;font-weight:900;letter-spacing:4px;color:#ffffff;text-transform:uppercase;">MOTO<span style="color:#ffe0d0;">LEILÃO</span></span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 28px;">
            <h2 style="margin:0 0 20px;font-size:20px;color:#1a1d23;">${assunto}</h2>
            <table width="100%" cellpadding="0" cellspacing="0">${linhasHtml}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px;border-top:1px solid #eef0f3;text-align:center;">
            <p style="margin:0;font-size:11px;color:#b0b8c4;">Aviso automático &mdash; Equipe MotoLeilão</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'MotoLeilão <contato@motoleiloes.com.br>',
      to: [ADMIN_EMAIL],
      subject: assunto,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[kiwify-webhook] erro ao enviar aviso ao admin via Resend:', err);
  } else {
    console.log(`[kiwify-webhook] 📧 aviso ao admin enviado: ${assunto}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const expectedToken = Deno.env.get('KIWIFY_TOKEN');
  if (!expectedToken || token !== expectedToken) {
    console.warn('[kiwify-webhook] token inválido');
    return new Response('Unauthorized', { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const event = body.event as string | undefined;
  const data = body.data as Record<string, unknown> | undefined;
  const email = (data?.customer as Record<string, unknown>)?.email as string | undefined;
  const orderId = (data as Record<string, unknown>)?.order_id as string | undefined;
  const plano = ((data?.product as Record<string, unknown>)?.name as string | undefined) ?? 'mensal';

  console.log(`[kiwify-webhook] event=${event} email=${email} order_id=${orderId}`);

  if (!email) {
    console.warn('[kiwify-webhook] email ausente, ignorando');
    return new Response(JSON.stringify({ ok: true, skipped: 'no email' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Aprovação / ativação ──────────────────────────────────────────────────
  if (event === 'order_approved' || event === 'subscription_active') {
    const password = generatePassword();
    const { error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { senha_temporaria: true },
    });

    const isNewUser = !authError;

    if (authError && !authError.message.includes('already registered')) {
      console.error('[kiwify-webhook] erro ao criar usuário:', authError.message);
    }

    // Envia credenciais apenas para usuários recém-criados
    if (isNewUser) {
      await enviarEmailBoasVindas(email, password);
    } else {
      console.log(`[kiwify-webhook] usuário já existente, email não reenviado: ${email}`);
    }

    const planoFinal = plano.toLowerCase().includes('anual') ? 'anual' : 'mensal';

    const { error: dbError } = await supabase.from('assinantes').upsert(
      {
        email,
        status: 'ativo',
        plano: planoFinal,
        data_inicio: new Date().toISOString(),
        kiwify_order_id: orderId ?? null,
        data_cancelamento: null,
      },
      { onConflict: 'email' },
    );

    if (dbError) {
      console.error('[kiwify-webhook] erro ao salvar assinante:', dbError.message);
    }

    console.log(`[kiwify-webhook] ✅ assinante ativado: ${email}`);

    try {
      await enviarAvisoAdmin('🎉 Novo assinante no MotoLeilão', {
        'Email': email,
        'Plano': planoFinal,
        'Order ID': orderId ?? '—',
        'Novo usuário?': isNewUser ? 'Sim (primeiro acesso)' : 'Reativação',
        'Data': new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      });
    } catch (e) {
      console.error('[kiwify-webhook] erro ao enviar aviso ao admin (novo assinante):', e);
    }
  }

  // ── Cancelamento / reembolso ──────────────────────────────────────────────
  else if (event === 'order_refunded' || event === 'subscription_canceled') {
    const { error: dbError } = await supabase
      .from('assinantes')
      .update({
        status: 'cancelado',
        data_cancelamento: new Date().toISOString(),
      })
      .eq('email', email);

    if (dbError) {
      console.error('[kiwify-webhook] erro ao cancelar assinante:', dbError.message);
    }

    console.log(`[kiwify-webhook] ⛔ assinante cancelado: ${email}`);

    try {
      await enviarAvisoAdmin('⛔ Assinante cancelou — MotoLeilão', {
        'Email': email,
        'Evento': event,
        'Data': new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      });
    } catch (e) {
      console.error('[kiwify-webhook] erro ao enviar aviso ao admin (cancelamento):', e);
    }
  } else {
    console.log(`[kiwify-webhook] evento ignorado: ${event}`);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
