-- Índice único parcial — necessário para upsert on_conflict=url nos scrapers
-- Alinha com a definição real do banco (índice parcial, não constraint simples)
DROP INDEX IF EXISTS motos_url_unique;
CREATE UNIQUE INDEX IF NOT EXISTS motos_url_unique ON motos (url) WHERE url IS NOT NULL AND url <> '';
