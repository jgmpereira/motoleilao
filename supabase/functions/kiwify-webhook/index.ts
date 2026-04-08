import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join('');
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
    // Tenta criar usuário; ignora erro se já existir
    const password = generatePassword();
    const { error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError && !authError.message.includes('already registered')) {
      console.error('[kiwify-webhook] erro ao criar usuário:', authError.message);
    }

    const { error: dbError } = await supabase.from('assinantes').upsert(
      {
        email,
        status: 'ativo',
        plano: plano.toLowerCase().includes('anual') ? 'anual' : 'mensal',
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
  }

  else {
    console.log(`[kiwify-webhook] evento ignorado: ${event}`);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
