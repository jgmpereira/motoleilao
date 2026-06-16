-- Admin pode ler todos os assinantes (para listar VIPs no painel)
create policy "admin_select_assinantes"
  on assinantes
  for select
  to authenticated
  using ((auth.jwt() ->> 'email') = 'jgmpereira123@gmail.com');

-- Admin pode atualizar qualquer assinante (para revogar acesso VIP)
create policy "admin_update_assinantes"
  on assinantes
  for update
  to authenticated
  using  ((auth.jwt() ->> 'email') = 'jgmpereira123@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'jgmpereira123@gmail.com');
