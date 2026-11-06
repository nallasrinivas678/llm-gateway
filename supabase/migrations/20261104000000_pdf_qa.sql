-- PDF Q&A (RAG) - Phase 1 schema. See PDF_QA_PLAN.md.
--
-- Embedding dimension: 1536 (OpenAI text-embedding-3-small default). It appears in two places
-- below (document_chunks.embedding and match_chunks' parameter); if the embedding model changes,
-- both must change together with the gateway's embedding config, and existing chunks re-embedded.
--
-- Access model: every table here is meant to be queried AS THE USER, never with service_role.
-- The gateway does that by running each query in a transaction with
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"<verified user id>","role":"authenticated"}', true);
-- so RLS and auth.uid() apply exactly as they would for the Supabase client SDK.

-- ============================================
-- Extension
-- ============================================
-- Supabase convention: extensions live in the "extensions" schema (already on the search_path).
create extension if not exists vector with schema extensions;

-- ============================================
-- documents
-- ============================================
create table public.documents (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    title text not null,
    storage_path text not null,     -- "{user_id}/{document_id}.pdf" in the "documents" bucket
    status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
    error text,                     -- set when status = 'failed'
    page_count int check (page_count is null or page_count >= 0),
    created_at timestamptz not null default now(),
    -- target for document_chunks/doc_messages' composite FKs, so a child row's user_id must
    -- match its document's owner (one user can't attach rows to another user's document)
    unique (id, user_id)
);

create index idx_documents_user_id on public.documents(user_id, created_at desc);

-- ============================================
-- document_chunks
-- ============================================
create table public.document_chunks (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null,
    user_id uuid not null default auth.uid(),
    chunk_index int not null check (chunk_index >= 0),
    page int not null check (page >= 1),
    content text not null,
    embedding extensions.vector(1536) not null,
    foreign key (document_id, user_id) references public.documents(id, user_id) on delete cascade,
    unique (document_id, chunk_index)   -- also serves as the document_id index
);

-- Cosine distance, matching the <=> operator used by match_chunks.
create index idx_document_chunks_embedding
    on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- ============================================
-- doc_messages (optional chat history per document)
-- ============================================
create table public.doc_messages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null,
    user_id uuid not null default auth.uid(),
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    sources jsonb,                  -- assistant turns: [{ "page": 3, "snippet": "..." }, ...]
    created_at timestamptz not null default now(),
    foreign key (document_id, user_id) references public.documents(id, user_id) on delete cascade
);

create index idx_doc_messages_document_id on public.doc_messages(document_id, created_at);

-- ============================================
-- Row Level Security
-- ============================================
-- (select auth.uid()) rather than auth.uid() so Postgres evaluates it once per statement,
-- not once per row (Supabase's documented RLS performance pattern).
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.doc_messages enable row level security;

create policy "documents_select_own" on public.documents
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "documents_insert_own" on public.documents
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "documents_update_own" on public.documents
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "documents_delete_own" on public.documents
    for delete to authenticated using ((select auth.uid()) = user_id);

create policy "document_chunks_select_own" on public.document_chunks
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "document_chunks_insert_own" on public.document_chunks
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "document_chunks_update_own" on public.document_chunks
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "document_chunks_delete_own" on public.document_chunks
    for delete to authenticated using ((select auth.uid()) = user_id);

create policy "doc_messages_select_own" on public.doc_messages
    for select to authenticated using ((select auth.uid()) = user_id);
create policy "doc_messages_insert_own" on public.doc_messages
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "doc_messages_update_own" on public.doc_messages
    for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "doc_messages_delete_own" on public.doc_messages
    for delete to authenticated using ((select auth.uid()) = user_id);

-- ============================================
-- match_chunks: top-k chunks of one document by cosine similarity
-- ============================================
-- security invoker (the default), so the caller's RLS applies; the explicit user_id filter is
-- a second guard in case this is ever called from a role that bypasses RLS.
-- For a single document (hundreds of chunks) the planner typically uses the
-- (document_id, chunk_index) index and an exact sort, which is accurate; the HNSW index helps
-- once queries span many documents.
create or replace function public.match_chunks(
    query_embedding extensions.vector(1536),
    doc_id uuid,
    match_count int default 6
)
returns table (
    id uuid,
    chunk_index int,
    page int,
    content text,
    similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
    select
        c.id,
        c.chunk_index,
        c.page,
        c.content,
        1 - (c.embedding <=> query_embedding) as similarity
    from public.document_chunks c
    where c.document_id = doc_id
      and c.user_id = (select auth.uid())
    order by c.embedding <=> query_embedding
    limit least(greatest(coalesce(match_count, 6), 1), 50);
$$;

revoke execute on function public.match_chunks(extensions.vector, uuid, int) from public, anon;
grant execute on function public.match_chunks(extensions.vector, uuid, int) to authenticated;

-- ============================================
-- Storage: private "documents" bucket, one folder per user
-- ============================================
-- Objects are stored at "{user_id}/{document_id}.pdf". The bucket itself enforces the 20 MB
-- limit and PDF-only uploads; the policies restrict every operation to the caller's own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

create policy "documents_bucket_select_own" on storage.objects
    for select to authenticated
    using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "documents_bucket_insert_own" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "documents_bucket_update_own" on storage.objects
    for update to authenticated
    using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
    with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "documents_bucket_delete_own" on storage.objects
    for delete to authenticated
    using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
