-- ABT V19: ruang kerja pengajar.
-- Jalankan sekali di Supabase SQL Editor setelah V18.
-- Migrasi gagal dengan pesan jelas bila tabel/kolom/RLS dasar berbeda dari V18.

begin;

do $$
declare
  v_table text;
  v_column text;
  v_columns text[];
  v_rls boolean;
begin
  for v_table, v_columns in
    select x.table_name, x.required_columns
    from (values
      ('profiles', array['id','role','full_name','username','contact_email','phone']::text[]),
      ('classes', array['id','instructor_id','title']::text[]),
      ('class_enrollments', array['id','class_id','student_id','payment_status','created_at']::text[]),
      ('lessons', array['id','class_id','title','description','order_number','is_published']::text[])
    ) as x(table_name, required_columns)
  loop
    if to_regclass('public.' || quote_ident(v_table)) is null then
      raise exception 'ABT V19 dihentikan: tabel public.% belum ada. Pasang skema V18 terlebih dahulu.', v_table;
    end if;
    foreach v_column in array v_columns loop
      if not exists (
        select 1 from information_schema.columns
        where table_schema='public' and table_name=v_table and column_name=v_column
      ) then
        raise exception 'ABT V19 dihentikan: kolom public.%.% tidak ditemukan. Periksa skema V18.', v_table, v_column;
      end if;
    end loop;
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=v_table;
    if not coalesce(v_rls, false) then
      raise exception 'ABT V19 dihentikan: Row Level Security belum aktif pada public.%. Aktifkan dan periksa policy V18 sebelum melanjutkan.', v_table;
    end if;
  end loop;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public'
      and ((table_name='profiles' and column_name='id')
        or (table_name='classes' and column_name in ('id','instructor_id'))
        or (table_name='class_enrollments' and column_name in ('class_id','student_id')))
      and data_type <> 'uuid'
  ) then
    raise exception 'ABT V19 dihentikan: ID profil, kelas, atau pendaftaran tidak bertipe UUID seperti yang dipakai Supabase Auth.';
  end if;
end;
$$;

-- Helper SECURITY DEFINER menghindari policy profiles yang memanggil profiles kembali.
create or replace function public.abt_v19_current_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role::text from public.profiles p where p.id = auth.uid() limit 1;
$$;

create or replace function public.abt_v19_teacher_owns_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.abt_v19_current_role() = 'pengajar'
     and exists (select 1 from public.classes c where c.id = p_class_id and c.instructor_id = auth.uid());
$$;

create or replace function public.abt_v19_teacher_owns_class_path(p_class_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_class_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.abt_v19_teacher_owns_class(p_class_id::uuid);
end;
$$;

create or replace function public.abt_v19_teacher_can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.abt_v19_current_role() = 'pengajar' and (
    p_profile_id = auth.uid()
    or exists (
      select 1
      from public.class_enrollments ce
      join public.classes c on c.id = ce.class_id
      where ce.student_id = p_profile_id and c.instructor_id = auth.uid()
    )
  );
$$;

revoke all on function public.abt_v19_current_role() from public;
revoke all on function public.abt_v19_teacher_owns_class(uuid) from public;
revoke all on function public.abt_v19_teacher_owns_class_path(text) from public;
revoke all on function public.abt_v19_teacher_can_view_profile(uuid) from public;
grant execute on function public.abt_v19_current_role() to authenticated;
grant execute on function public.abt_v19_teacher_owns_class(uuid) to authenticated;
grant execute on function public.abt_v19_teacher_owns_class_path(text) to authenticated;
grant execute on function public.abt_v19_teacher_can_view_profile(uuid) to authenticated;

-- Preserve all existing access for other roles. Teachers gain read access only to
-- their assigned classes, lessons, enrollments, and related participant profiles.
drop policy if exists abt_v19_teacher_classes_select on public.classes;
create policy abt_v19_teacher_classes_select on public.classes
  as permissive for select to authenticated
  using (public.abt_v19_current_role() = 'pengajar' and instructor_id = auth.uid());
drop policy if exists abt_v19_teacher_classes_guard on public.classes;
create policy abt_v19_teacher_classes_guard on public.classes
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar' or instructor_id = auth.uid());
drop policy if exists abt_v19_teacher_classes_insert_guard on public.classes;
create policy abt_v19_teacher_classes_insert_guard on public.classes
  as restrictive for insert to authenticated
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_classes_update_guard on public.classes;
create policy abt_v19_teacher_classes_update_guard on public.classes
  as restrictive for update to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar')
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_classes_delete_guard on public.classes;
create policy abt_v19_teacher_classes_delete_guard on public.classes
  as restrictive for delete to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar');

drop policy if exists abt_v19_teacher_lessons_select on public.lessons;
create policy abt_v19_teacher_lessons_select on public.lessons
  as permissive for select to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_lessons_guard on public.lessons;
create policy abt_v19_teacher_lessons_guard on public.lessons
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar' or public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_lessons_insert_guard on public.lessons;
create policy abt_v19_teacher_lessons_insert_guard on public.lessons
  as restrictive for insert to authenticated
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_lessons_update_guard on public.lessons;
create policy abt_v19_teacher_lessons_update_guard on public.lessons
  as restrictive for update to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar')
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_lessons_delete_guard on public.lessons;
create policy abt_v19_teacher_lessons_delete_guard on public.lessons
  as restrictive for delete to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar');

drop policy if exists abt_v19_teacher_enrollments_select on public.class_enrollments;
create policy abt_v19_teacher_enrollments_select on public.class_enrollments
  as permissive for select to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_enrollments_guard on public.class_enrollments;
create policy abt_v19_teacher_enrollments_guard on public.class_enrollments
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar' or public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_enrollments_insert_guard on public.class_enrollments;
create policy abt_v19_teacher_enrollments_insert_guard on public.class_enrollments
  as restrictive for insert to authenticated
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_enrollments_update_guard on public.class_enrollments;
create policy abt_v19_teacher_enrollments_update_guard on public.class_enrollments
  as restrictive for update to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar')
  with check (public.abt_v19_current_role() is distinct from 'pengajar');
drop policy if exists abt_v19_teacher_enrollments_delete_guard on public.class_enrollments;
create policy abt_v19_teacher_enrollments_delete_guard on public.class_enrollments
  as restrictive for delete to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar');

drop policy if exists abt_v19_teacher_profiles_select on public.profiles;
create policy abt_v19_teacher_profiles_select on public.profiles
  as permissive for select to authenticated
  using (public.abt_v19_teacher_can_view_profile(id));
drop policy if exists abt_v19_teacher_profiles_guard on public.profiles;
create policy abt_v19_teacher_profiles_guard on public.profiles
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar' or public.abt_v19_teacher_can_view_profile(id));
drop policy if exists abt_v19_teacher_profile_update_guard on public.profiles;
create policy abt_v19_teacher_profile_update_guard on public.profiles
  as restrictive for update to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar' or id = auth.uid())
  with check (public.abt_v19_current_role() is distinct from 'pengajar' or (id = auth.uid() and role = 'pengajar'));

-- New V19 teacher-owned records.
create table if not exists public.teacher_materials (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  description text,
  storage_path text,
  external_url text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_materials_one_resource check ((storage_path is null) <> (external_url is null)),
  constraint teacher_materials_external_protocol check (external_url is null or external_url ~* '^https?://')
);

create table if not exists public.teacher_activities (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  details text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  meeting_url text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_activities_time_order check (ends_at is null or ends_at >= starts_at),
  constraint teacher_activities_url_protocol check (meeting_url is null or meeting_url ~* '^https?://')
);

create table if not exists public.teacher_evaluations (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  kind text not null check (kind in ('tugas','latihan')),
  title text not null check (length(btrim(title)) between 1 and 160),
  instructions text,
  due_at timestamptz,
  max_score numeric(8,2) not null default 100 check (max_score > 0 and max_score <= 1000),
  is_published boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teacher_evaluation_results (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.teacher_evaluations(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  score numeric(8,2) not null check (score >= 0),
  feedback text,
  graded_by uuid not null references public.profiles(id) on delete cascade,
  graded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint teacher_evaluation_results_unique_student unique (evaluation_id, student_id)
);

create table if not exists public.teacher_notifications (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete cascade,
  title text not null,
  body text,
  kind text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.teacher_profile_photos (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  storage_path text not null,
  updated_at timestamptz not null default now()
);

create index if not exists teacher_materials_class_created_idx on public.teacher_materials(class_id, created_at desc);
create index if not exists teacher_activities_class_start_idx on public.teacher_activities(class_id, starts_at);
create index if not exists teacher_evaluations_class_created_idx on public.teacher_evaluations(class_id, created_at desc);
create index if not exists teacher_evaluation_results_evaluation_idx on public.teacher_evaluation_results(evaluation_id);
create index if not exists teacher_notifications_teacher_created_idx on public.teacher_notifications(teacher_id, created_at desc);

create or replace function public.abt_v19_teacher_can_grade(p_evaluation_id uuid, p_student_id uuid, p_score numeric default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.abt_v19_current_role() = 'pengajar' and exists (
    select 1
    from public.teacher_evaluations e
    join public.class_enrollments ce on ce.class_id = e.class_id and ce.student_id = p_student_id
    where e.id = p_evaluation_id
      and e.class_id in (select c.id from public.classes c where c.instructor_id = auth.uid())
      and (p_score is null or p_score <= e.max_score)
  );
$$;
revoke all on function public.abt_v19_teacher_can_grade(uuid,uuid,numeric) from public;
grant execute on function public.abt_v19_teacher_can_grade(uuid,uuid,numeric) to authenticated;

alter table public.teacher_materials enable row level security;
alter table public.teacher_activities enable row level security;
alter table public.teacher_evaluations enable row level security;
alter table public.teacher_evaluation_results enable row level security;
alter table public.teacher_notifications enable row level security;
alter table public.teacher_profile_photos enable row level security;

grant select, insert, update, delete on public.teacher_materials to authenticated;
grant select, insert, update, delete on public.teacher_activities to authenticated;
grant select, insert, update, delete on public.teacher_evaluations to authenticated;
grant select, insert, update, delete on public.teacher_evaluation_results to authenticated;
grant select on public.teacher_notifications to authenticated;
grant select, insert, update, delete on public.teacher_profile_photos to authenticated;

drop policy if exists abt_v19_teacher_materials_select on public.teacher_materials;
create policy abt_v19_teacher_materials_select on public.teacher_materials for select to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_materials_insert on public.teacher_materials;
create policy abt_v19_teacher_materials_insert on public.teacher_materials for insert to authenticated
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_materials_update on public.teacher_materials;
create policy abt_v19_teacher_materials_update on public.teacher_materials for update to authenticated
  using (public.abt_v19_teacher_owns_class(class_id))
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_materials_delete on public.teacher_materials;
create policy abt_v19_teacher_materials_delete on public.teacher_materials for delete to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));

drop policy if exists abt_v19_teacher_activities_select on public.teacher_activities;
create policy abt_v19_teacher_activities_select on public.teacher_activities for select to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_activities_insert on public.teacher_activities;
create policy abt_v19_teacher_activities_insert on public.teacher_activities for insert to authenticated
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_activities_update on public.teacher_activities;
create policy abt_v19_teacher_activities_update on public.teacher_activities for update to authenticated
  using (public.abt_v19_teacher_owns_class(class_id))
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_activities_delete on public.teacher_activities;
create policy abt_v19_teacher_activities_delete on public.teacher_activities for delete to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));

drop policy if exists abt_v19_teacher_evaluations_select on public.teacher_evaluations;
create policy abt_v19_teacher_evaluations_select on public.teacher_evaluations for select to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v19_teacher_evaluations_insert on public.teacher_evaluations;
create policy abt_v19_teacher_evaluations_insert on public.teacher_evaluations for insert to authenticated
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_evaluations_update on public.teacher_evaluations;
create policy abt_v19_teacher_evaluations_update on public.teacher_evaluations for update to authenticated
  using (public.abt_v19_teacher_owns_class(class_id))
  with check (public.abt_v19_teacher_owns_class(class_id) and created_by = auth.uid());
drop policy if exists abt_v19_teacher_evaluations_delete on public.teacher_evaluations;
create policy abt_v19_teacher_evaluations_delete on public.teacher_evaluations for delete to authenticated
  using (public.abt_v19_teacher_owns_class(class_id));

drop policy if exists abt_v19_teacher_results_select on public.teacher_evaluation_results;
create policy abt_v19_teacher_results_select on public.teacher_evaluation_results for select to authenticated
  using (exists (select 1 from public.teacher_evaluations e where e.id = evaluation_id and public.abt_v19_teacher_owns_class(e.class_id)));
drop policy if exists abt_v19_teacher_results_insert on public.teacher_evaluation_results;
create policy abt_v19_teacher_results_insert on public.teacher_evaluation_results for insert to authenticated
  with check (graded_by = auth.uid() and public.abt_v19_teacher_can_grade(evaluation_id,student_id,score));
drop policy if exists abt_v19_teacher_results_update on public.teacher_evaluation_results;
create policy abt_v19_teacher_results_update on public.teacher_evaluation_results for update to authenticated
  using (exists (select 1 from public.teacher_evaluations e where e.id = evaluation_id and public.abt_v19_teacher_owns_class(e.class_id)))
  with check (graded_by = auth.uid() and public.abt_v19_teacher_can_grade(evaluation_id,student_id,score));
drop policy if exists abt_v19_teacher_results_delete on public.teacher_evaluation_results;
create policy abt_v19_teacher_results_delete on public.teacher_evaluation_results for delete to authenticated
  using (exists (select 1 from public.teacher_evaluations e where e.id = evaluation_id and public.abt_v19_teacher_owns_class(e.class_id)));

drop policy if exists abt_v19_teacher_notifications_select on public.teacher_notifications;
create policy abt_v19_teacher_notifications_select on public.teacher_notifications for select to authenticated
  using (public.abt_v19_current_role() = 'pengajar' and teacher_id = auth.uid());
drop policy if exists abt_v19_teacher_photos_select on public.teacher_profile_photos;
create policy abt_v19_teacher_photos_select on public.teacher_profile_photos for select to authenticated
  using (public.abt_v19_current_role() = 'pengajar' and profile_id = auth.uid());
drop policy if exists abt_v19_teacher_photos_insert on public.teacher_profile_photos;
create policy abt_v19_teacher_photos_insert on public.teacher_profile_photos for insert to authenticated
  with check (public.abt_v19_current_role() = 'pengajar' and profile_id = auth.uid());
drop policy if exists abt_v19_teacher_photos_update on public.teacher_profile_photos;
create policy abt_v19_teacher_photos_update on public.teacher_profile_photos for update to authenticated
  using (public.abt_v19_current_role() = 'pengajar' and profile_id = auth.uid())
  with check (public.abt_v19_current_role() = 'pengajar' and profile_id = auth.uid());
drop policy if exists abt_v19_teacher_photos_delete on public.teacher_profile_photos;
create policy abt_v19_teacher_photos_delete on public.teacher_profile_photos for delete to authenticated
  using (public.abt_v19_current_role() = 'pengajar' and profile_id = auth.uid());

create or replace function public.mark_teacher_notification_read(p_notification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if public.abt_v19_current_role() is distinct from 'pengajar' then
    raise exception 'Hanya Pengajar yang dapat memperbarui notifikasi ini';
  end if;
  update public.teacher_notifications
  set read_at = coalesce(read_at, now())
  where id = p_notification_id and teacher_id = auth.uid()
  returning id into v_id;
  if v_id is null then raise exception 'Notifikasi tidak ditemukan'; end if;
  return jsonb_build_object('success', true, 'id', v_id);
end;
$$;
revoke all on function public.mark_teacher_notification_read(uuid) from public;
grant execute on function public.mark_teacher_notification_read(uuid) to authenticated;

create or replace function public.abt_v19_notify_enrollment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid;
  v_class_title text;
  v_student_name text;
begin
  select c.instructor_id, c.title, coalesce(nullif(p.full_name,''), nullif(p.username,''), 'Peserta')
    into v_teacher_id, v_class_title, v_student_name
  from public.classes c
  left join public.profiles p on p.id = new.student_id
  where c.id = new.class_id;
  if v_teacher_id is null or not exists (select 1 from public.profiles p where p.id=v_teacher_id and p.role='pengajar') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into public.teacher_notifications(teacher_id,class_id,title,body,kind)
    values (v_teacher_id,new.class_id,'Pendaftaran peserta baru',v_student_name || ' mendaftar pada kelas ' || coalesce(v_class_title,'kelas Anda') || '.','enrollment_created');
  elsif new.payment_status is distinct from old.payment_status then
    insert into public.teacher_notifications(teacher_id,class_id,title,body,kind)
    values (v_teacher_id,new.class_id,'Status pendaftaran berubah', 'Status pendaftaran ' || v_student_name || ' pada ' || coalesce(v_class_title,'kelas Anda') || ' menjadi ' || coalesce(new.payment_status::text,'belum ditentukan') || '.','enrollment_status');
  end if;
  return new;
end;
$$;
revoke all on function public.abt_v19_notify_enrollment() from public;

drop trigger if exists abt_v19_enrollment_insert_notification on public.class_enrollments;
create trigger abt_v19_enrollment_insert_notification
  after insert on public.class_enrollments
  for each row execute function public.abt_v19_notify_enrollment();
drop trigger if exists abt_v19_enrollment_status_notification on public.class_enrollments;
create trigger abt_v19_enrollment_status_notification
  after update of payment_status on public.class_enrollments
  for each row execute function public.abt_v19_notify_enrollment();

-- Private buckets. Object paths are class UUID/name and profile UUID/name.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('abt-teacher-materials','abt-teacher-materials',false,26214400,
  array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg','image/png','audio/mpeg','video/mp4','video/webm']::text[])
on conflict (id) do update set public=false, file_size_limit=26214400;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('abt-teacher-avatars','abt-teacher-avatars',false,5242880,array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public=false, file_size_limit=5242880;

drop policy if exists abt_v19_teacher_material_objects_select on storage.objects;
create policy abt_v19_teacher_material_objects_select on storage.objects for select to authenticated
  using (bucket_id='abt-teacher-materials' and public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));
drop policy if exists abt_v19_teacher_material_objects_insert on storage.objects;
create policy abt_v19_teacher_material_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id='abt-teacher-materials' and public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));
drop policy if exists abt_v19_teacher_material_objects_delete on storage.objects;
create policy abt_v19_teacher_material_objects_delete on storage.objects for delete to authenticated
  using (bucket_id='abt-teacher-materials' and public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));
drop policy if exists abt_v19_teacher_material_objects_guard_select on storage.objects;
create policy abt_v19_teacher_material_objects_guard_select on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'abt-teacher-materials' or public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));
drop policy if exists abt_v19_teacher_material_objects_guard_insert on storage.objects;
create policy abt_v19_teacher_material_objects_guard_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'abt-teacher-materials' or public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));
drop policy if exists abt_v19_teacher_material_objects_guard_delete on storage.objects;
create policy abt_v19_teacher_material_objects_guard_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'abt-teacher-materials' or public.abt_v19_teacher_owns_class_path(split_part(name,'/',1)));

drop policy if exists abt_v19_teacher_avatar_objects_select on storage.objects;
create policy abt_v19_teacher_avatar_objects_select on storage.objects for select to authenticated
  using (bucket_id='abt-teacher-avatars' and public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v19_teacher_avatar_objects_insert on storage.objects;
create policy abt_v19_teacher_avatar_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id='abt-teacher-avatars' and public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v19_teacher_avatar_objects_delete on storage.objects;
create policy abt_v19_teacher_avatar_objects_delete on storage.objects for delete to authenticated
  using (bucket_id='abt-teacher-avatars' and public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v19_teacher_avatar_objects_guard_select on storage.objects;
create policy abt_v19_teacher_avatar_objects_guard_select on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'abt-teacher-avatars' or (public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text));
drop policy if exists abt_v19_teacher_avatar_objects_guard_insert on storage.objects;
create policy abt_v19_teacher_avatar_objects_guard_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'abt-teacher-avatars' or (public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text));
drop policy if exists abt_v19_teacher_avatar_objects_guard_delete on storage.objects;
create policy abt_v19_teacher_avatar_objects_guard_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'abt-teacher-avatars' or (public.abt_v19_current_role()='pengajar' and split_part(name,'/',1)=auth.uid()::text));

commit;
