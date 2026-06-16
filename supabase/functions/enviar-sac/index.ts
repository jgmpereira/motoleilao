const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Método não permitido' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'JSON inválido' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const { nome = '', email = '', assunto = '', mensagem = '', website = '' } = body;

  // Honeypot
  if (website) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Validação
  if (!nome.trim() || !email.trim() || !mensagem.trim()) {
    return new Response(JSON.stringify({ ok: false, error: 'Nome, email e mensagem são obrigatórios.' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return new Response(JSON.stringify({ ok: false, error: 'Email inválido.' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.error('[enviar-sac] RESEND_API_KEY não configurada');
    return new Response(JSON.stringify({ ok: false, error: 'Configuração de email ausente.' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const assuntoLabel = assunto.trim() || 'Contato';
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1a1a1a;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;border:1px solid #e0e0e0;">
    <h2 style="margin:0 0 20px;font-size:18px;color:#e67e22;">[SAC] ${escapeHtml(assuntoLabel)} — ${escapeHtml(nome.trim())}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#666;width:80px;">Nome:</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(nome.trim())}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Email:</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(email.trim())}" style="color:#e67e22;">${escapeHtml(email.trim())}</a></td></tr>
      <tr><td style="padding:6px 0;color:#666;">Assunto:</td><td style="padding:6px 0;">${escapeHtml(assuntoLabel)}</td></tr>
    </table>
    <hr style="border:none;border-top:1px solid #eee;margin:18px 0;">
    <p style="font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0;">${escapeHtml(mensagem.trim())}</p>
  </div>
</body>
</html>`;

  const payload = {
    from: 'MotoLeilão (Contato) <contato@motoleiloes.com.br>',
    to: ['motoleiloes@zohomail.com'],
    reply_to: email.trim(),
    subject: `[SAC] ${assuntoLabel} — ${nome.trim()}`,
    html,
  };

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resendRes.ok) {
    const err = await resendRes.text().catch(() => '');
    console.error('[enviar-sac] Resend error', resendRes.status, err);
    return new Response(JSON.stringify({ ok: false, error: 'Falha ao enviar email. Tente novamente.' }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
