-- Throwaway sample data for the Docker PostgreSQL tests (test-postgres.sh). Not for production use.
-- psql variable :ro_password is passed by the script (random, per run).
CREATE SCHEMA sales;
CREATE SCHEMA hidden;

CREATE TABLE public.customers (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  email text
);
CREATE TABLE public.orders (
  id          serial PRIMARY KEY,
  customer_id integer REFERENCES public.customers (id),
  total       numeric(10, 2) NOT NULL DEFAULT 0,
  note        text,
  blob        bytea
);
CREATE VIEW public.order_totals AS
  SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id;

CREATE TABLE public.numbers AS SELECT g AS n FROM generate_series(1, 250) AS g;
CREATE TABLE public.write_probe (id serial PRIMARY KEY, v text);
CREATE TABLE sales.regions (code text PRIMARY KEY, label text NOT NULL);
CREATE TABLE hidden.internal_notes (id integer PRIMARY KEY, body text);

-- A volatile function that writes: used to prove the read-only transaction (not the SQL guard) blocks it.
CREATE FUNCTION public.dw_write_probe() RETURNS integer LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.write_probe (v) VALUES ('written');
  RETURN 1;
END
$fn$;

INSERT INTO public.customers (name, email) VALUES ('Ada', 'ada@example.test'), ('Grace', 'grace@example.test'), ('Linus', NULL);
INSERT INTO public.orders (customer_id, total, note, blob) VALUES
  (1, 10.50, 'first', '\x0102030405'),
  (1, 20.00, repeat('long note ', 100), NULL),
  (2, 5.25, NULL, NULL);
INSERT INTO sales.regions VALUES ('eu', 'Europe'), ('us', 'United States');
INSERT INTO hidden.internal_notes VALUES (1, 'not in configured schemas');

-- Read-only role: SELECT only. Roles are recommended in the README; the tests use it as a second layer.
CREATE ROLE dw_ro LOGIN PASSWORD :'ro_password';
GRANT USAGE ON SCHEMA public, sales, hidden TO dw_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, sales, hidden TO dw_ro;
