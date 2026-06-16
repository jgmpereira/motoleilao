import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'jgmpereira123@gmail.com';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SERVICE_ROLE_KEY')!,
);

function generatePassword(length = 10): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('');
}

async function enviarEmailVip(email: string, senha: string): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.warn('[admin-invite-vip] RESEND_API_KEY não configurada, email não enviado');
    return;
  }

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
            <h2 style="margin:0 0 8px;font-size:22px;color:#1a1d23;">Bem-vindo ao MotoLeilão VIP! 🏍️</h2>
            <p style="margin:0 0 24px;font-size:15px;color:#5a6070;line-height:1.6;">Você recebeu acesso VIP ao painel. Use as credenciais abaixo para entrar.</p>
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
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td align="center">
                  <a href="https://xn--motoleio-xza.com.br" style="display:inline-block;background:#ff4d00;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.5px;padding:14px 36px;border-radius:8px;">Acessar o MotoLeilão →</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:13px;color:#8a92a0;line-height:1.6;">Ao entrar pela primeira vez você será solicitado a criar uma senha permanente.</p>
          </td>
        </tr>
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
      from: 'MotoLeilão <contato@xn--motoleio-xza.com.br>',
      to: [email],
      subject: 'Seu acesso VIP ao MotoLeilão está pronto!',
      html,
    }),
  });

  if (!res.ok) {
    console.error('[admin-invite-vip] erro Resend:', await res.text());
  } else {
    console.log(`[admin-invite-vip] 📧 email enviado para ${email}`);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  // Verifica que o chamador é o admin
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: CORS });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || user?.email !== ADMIN_EMAIL) {
    return new Response('Forbidden', { status: 403, headers: CORS });
  }

  let body: { action?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return json({ error: 'email obrigatório' }, 400);
  }

  // ── Revogar VIP ──────────────────────────────────────────────────────────────
  if (body.action === 'revoke') {
    // Atualiza status na tabela
    const { error: dbErr } = await supabaseAdmin
      .from('assinantes')
      .update({ status: 'cancelado', data_cancelamento: new Date().toISOString() })
      .eq('email', email);

    if (dbErr) {
      console.error('[admin-invite-vip] erro ao revogar assinante:', dbErr.message);
      return json({ error: dbErr.message }, 500);
    }

    // Busca e deleta o usuário do Auth
    const { data: { users }, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) {
      console.warn('[admin-invite-vip] não foi possível listar usuários Auth:', listErr.message);
    } else {
      const authUser = users.find((u) => u.email === email);
      if (authUser) {
        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(authUser.id);
        if (delErr) {
          console.error('[admin-invite-vip] erro ao deletar usuário Auth:', delErr.message);
          return json({ error: delErr.message }, 500);
        }
        console.log(`[admin-invite-vip] 🗑 usuário Auth deletado: ${email}`);
      } else {
        console.warn(`[admin-invite-vip] usuário Auth não encontrado para ${email}`);
      }
    }

    console.log(`[admin-invite-vip] ⛔ VIP revogado: ${email}`);
    return json({ ok: true });
  }

  // ── Convidar VIP (default) ────────────────────────────────────────────────────
  const password = generatePassword();
  const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { senha_temporaria: true },
  });

  const isNew = !createErr;
  if (createErr && !createErr.message.includes('already registered')) {
    console.error('[admin-invite-vip] erro ao criar usuário:', createErr.message);
    return json({ error: createErr.message }, 500);
  }

  const { error: dbErr } = await supabaseAdmin.from('assinantes').upsert(
    {
      email,
      status: 'ativo',
      plano: 'vip',
      data_inicio: new Date().toISOString(),
      kiwify_order_id: null,
      data_cancelamento: null,
    },
    { onConflict: 'email' },
  );

  if (dbErr) {
    console.error('[admin-invite-vip] erro ao salvar assinante:', dbErr.message);
    return json({ error: dbErr.message }, 500);
  }

  if (isNew) {
    await enviarEmailVip(email, password);
  }

  console.log(`[admin-invite-vip] ✅ VIP ${isNew ? 'criado' : 'promovido'}: ${email}`);
  return json({ ok: true, isNew });
});
