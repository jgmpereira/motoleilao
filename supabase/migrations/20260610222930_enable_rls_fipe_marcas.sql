-- Habilita RLS na tabela fipe_marcas (dados públicos de referência da FIPE)
alter table fipe_marcas enable row level security;

create policy "fipe_marcas_public_read"
  on fipe_marcas
  for select
  to anon, authenticated
  using (true);
