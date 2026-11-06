-- Phase 1 "done when" check for PDF_QA_PLAN.md: a second user cannot read or change the first
-- user's documents, chunks, messages or files.
--
-- Run AFTER the migration, as the postgres role (Supabase SQL editor, or psql against the
-- project / a branch / `supabase start`). Everything runs in one transaction that is rolled back,
-- so it leaves no test users or rows behind. Any failed check aborts with "FAIL: ...";
-- success ends with the notice "PDF Q&A isolation checks passed".

begin;

-- Two throwaway users (fixed ids so the checks below can refer to them).
insert into auth.users (id, email) values
    ('11111111-1111-1111-1111-111111111111', 'pdfqa-user-a@example.test'),
    ('22222222-2222-2222-2222-222222222222', 'pdfqa-user-b@example.test');

-- ---------------------------------------------------------------
-- As user A: create a document, a chunk, a message and a file
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

insert into public.documents (id, title, storage_path, status, page_count) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A''s doc',
     '11111111-1111-1111-1111-111111111111/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf', 'ready', 1);

insert into public.document_chunks (document_id, chunk_index, page, content, embedding) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 1, 'A''s secret content',
     array_fill(0.1::real, array[1536])::extensions.vector);

insert into public.doc_messages (document_id, role, content) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user', 'What is in my doc?');

insert into storage.objects (bucket_id, name) values
    ('documents', '11111111-1111-1111-1111-111111111111/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf');

do $$
declare n int;
begin
    select count(*) into n from public.documents;       if n <> 1 then raise exception 'FAIL: A sees % documents, expected 1', n; end if;
    select count(*) into n from public.document_chunks; if n <> 1 then raise exception 'FAIL: A sees % chunks, expected 1', n; end if;
    select count(*) into n from public.doc_messages;    if n <> 1 then raise exception 'FAIL: A sees % messages, expected 1', n; end if;
    select count(*) into n from storage.objects where bucket_id = 'documents';
    if n <> 1 then raise exception 'FAIL: A sees % files, expected 1', n; end if;

    select count(*) into n from public.match_chunks(
        array_fill(0.1::real, array[1536])::extensions.vector, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5);
    if n <> 1 then raise exception 'FAIL: match_chunks returned % rows to A, expected 1', n; end if;

    -- A may not write into B's storage folder.
    begin
        insert into storage.objects (bucket_id, name)
        values ('documents', '22222222-2222-2222-2222-222222222222/planted.pdf');
        raise exception 'FAIL: A uploaded into B''s folder';
    exception when insufficient_privilege then null;
    end;
end $$;

-- ---------------------------------------------------------------
-- As user B: none of A's data is visible or changeable
-- ---------------------------------------------------------------
select set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

do $$
declare n int;
begin
    select count(*) into n from public.documents;       if n <> 0 then raise exception 'FAIL: B sees % of A''s documents', n; end if;
    select count(*) into n from public.document_chunks; if n <> 0 then raise exception 'FAIL: B sees % of A''s chunks', n; end if;
    select count(*) into n from public.doc_messages;    if n <> 0 then raise exception 'FAIL: B sees % of A''s messages', n; end if;
    select count(*) into n from storage.objects where bucket_id = 'documents';
    if n <> 0 then raise exception 'FAIL: B sees % of A''s files', n; end if;

    select count(*) into n from public.match_chunks(
        array_fill(0.1::real, array[1536])::extensions.vector, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5);
    if n <> 0 then raise exception 'FAIL: match_chunks returned % of A''s chunks to B', n; end if;

    update public.documents set title = 'hijacked' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B updated A''s document'; end if;

    delete from public.document_chunks where document_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B deleted A''s chunks'; end if;

    delete from public.documents where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B deleted A''s document'; end if;

    update storage.objects set metadata = '{}'::jsonb where bucket_id = 'documents';
    get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B updated A''s file'; end if;

    -- B may not create rows claiming to be A.
    begin
        insert into public.documents (title, storage_path, user_id)
        values ('forged', 'x.pdf', '11111111-1111-1111-1111-111111111111');
        raise exception 'FAIL: B inserted a document owned by A';
    exception when insufficient_privilege then null;
    end;

    -- B may not attach a chunk to A's document under B's own id (composite FK blocks it).
    begin
        insert into public.document_chunks (document_id, chunk_index, page, content, embedding)
        values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 99, 1, 'planted',
                array_fill(0.1::real, array[1536])::extensions.vector);
        raise exception 'FAIL: B attached a chunk to A''s document';
    exception when foreign_key_violation then null;
    end;

    -- B may not write into A's storage folder.
    begin
        insert into storage.objects (bucket_id, name)
        values ('documents', '11111111-1111-1111-1111-111111111111/planted.pdf');
        raise exception 'FAIL: B uploaded into A''s folder';
    exception when insufficient_privilege then null;
    end;
end $$;

-- ---------------------------------------------------------------
-- As anon (no signed-in user): nothing visible, match_chunks not callable
-- ---------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare n int;
begin
    select count(*) into n from public.documents;
    if n <> 0 then raise exception 'FAIL: anon sees % documents', n; end if;

    begin
        perform public.match_chunks(
            array_fill(0.1::real, array[1536])::extensions.vector, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5);
        raise exception 'FAIL: anon could call match_chunks';
    exception when insufficient_privilege then null;
    end;
end $$;

-- ---------------------------------------------------------------
-- Back as A: everything B tried left A's data intact
-- ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

do $$
declare t text; n int;
begin
    select title into t from public.documents where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if t is distinct from 'A''s doc' then raise exception 'FAIL: A''s document changed or vanished (title=%)', t; end if;
    select count(*) into n from public.document_chunks;
    if n <> 1 then raise exception 'FAIL: A now has % chunks, expected 1', n; end if;

    raise notice 'PDF Q&A isolation checks passed';
end $$;

rollback;
