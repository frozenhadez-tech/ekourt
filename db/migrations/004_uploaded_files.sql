-- Uploaded files (player photos, product images, expense receipts) live in the database,
-- so the app runs on hosts with no persistent disk (serverless) and files are covered by database backups.
create table uploaded_files (
  name        text primary key check (name ~ '^[a-f0-9]{32}\.(jpg|png|webp|pdf)$'),
  mime_type   text not null,
  size_bytes  integer not null check (size_bytes > 0),
  data        bytea not null,
  uploaded_by uuid references employees(id),
  created_at  timestamptz not null default now()
);
