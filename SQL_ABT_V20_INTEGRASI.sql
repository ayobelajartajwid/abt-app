-- ABT V20: alur terpadu Pengajar, Admin, dan Peserta.
-- Jalankan setelah SQL_ABT_V19_PENGAJAR.sql.

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
      ('profiles', array['id','role','full_name','username','phone']::text[]),
      ('classes', array['id','instructor_id','title','category','status']::text[]),
      ('class_enrollments', array['id','class_id','student_id','payment_status','created_at']::text[]),
      ('teacher_activities', array['id','class_id','title','details','starts_at','ends_at','location','meeting_url','created_by']::text[]),
      ('teacher_materials', array['id','class_id','title','description','storage_path','external_url','created_by']::text[]),
      ('teacher_evaluations', array['id','class_id','title','kind','instructions','due_at','max_score','is_published','created_by']::text[]),
      ('teacher_evaluation_results', array['id','evaluation_id','student_id','score','feedback','graded_by','graded_at']::text[]),
      ('teacher_notifications', array['id','teacher_id','class_id','title','body','kind','read_at','created_at']::text[]),
      ('teacher_profile_photos', array['profile_id','storage_path']::text[])
    ) as x(table_name, required_columns)
  loop
    if to_regclass('public.' || quote_ident(v_table)) is null then
      raise exception 'ABT V20 dihentikan: tabel public.% belum ada. Jalankan migrasi V19 terlebih dahulu.', v_table;
    end if;
    foreach v_column in array v_columns loop
      if not exists (select 1 from information_schema.columns where table_schema='public' and table_name=v_table and column_name=v_column) then
        raise exception 'ABT V20 dihentikan: kolom public.%.% tidak ditemukan. Periksa migrasi V18/V19.', v_table, v_column;
      end if;
    end loop;
    select c.relrowsecurity into v_rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=v_table;
    if not coalesce(v_rls,false) then
      raise exception 'ABT V20 dihentikan: RLS belum aktif pada public.%. Jangan lanjut sebelum policy ditinjau.', v_table;
    end if;
  end loop;
end;
$$;

create table if not exists public.abt_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  class_id uuid references public.classes(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  body text not null check (length(btrim(body)) between 1 and 3000),
  source text not null default 'announcement',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.teacher_private_selections (
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('aktif','ditolak')),
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (class_id,student_id)
);

create table if not exists public.teacher_class_links (
  class_id uuid primary key references public.classes(id) on delete cascade,
  whatsapp_group_url text,
  teacher_whatsapp text,
  default_meeting_url text,
  updated_by uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now(),
  constraint teacher_class_links_urls check (
    (whatsapp_group_url is null or whatsapp_group_url ~* '^https?://') and
    (default_meeting_url is null or default_meeting_url ~* '^https?://')
  )
);

create table if not exists public.teacher_session_rates (
  teacher_id uuid primary key references public.profiles(id) on delete cascade,
  rate_per_session numeric(12,2) not null check (rate_per_session >= 0),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table if not exists public.class_session_rates (
  class_id uuid primary key references public.classes(id) on delete cascade,
  rate_per_session numeric(12,2) not null check (rate_per_session >= 0),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table if not exists public.teacher_sessions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.teacher_activities(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  session_date date not null,
  minutes integer not null default 60 check (minutes between 1 and 1440),
  status text not null default 'completed' check (status in ('completed','cancelled','no_show')),
  notes text,
  created_at timestamptz not null default now(),
  constraint teacher_sessions_activity_student_unique unique (activity_id,student_id)
);

create table if not exists public.teacher_monthly_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  report_month date not null check (report_month = date_trunc('month',report_month)::date),
  session_count integer not null default 0 check (session_count >= 0),
  rate_per_session numeric(12,2) not null check (rate_per_session >= 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  status text not null default 'submitted' check (status in ('submitted','approved','needs_correction')),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  admin_note text,
  constraint teacher_monthly_reports_unique unique (teacher_id,report_month)
);

create table if not exists public.participant_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_no text not null unique default ('ABT-' || to_char(now(),'YYYYMM') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  report_id uuid not null references public.teacher_monthly_reports(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  billing_month date not null,
  session_count integer not null check (session_count > 0),
  rate_per_session numeric(12,2) not null check (rate_per_session >= 0),
  amount_due numeric(14,2) not null check (amount_due >= 0),
  status text not null default 'issued' check (status in ('issued','paid','void')),
  issued_by uuid not null references public.profiles(id) on delete restrict,
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  admin_note text,
  constraint participant_invoice_per_report unique (report_id,student_id,class_id)
);

create table if not exists public.participant_reminders (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  activity_id uuid not null references public.teacher_activities(id) on delete cascade,
  minutes_before integer not null check (minutes_before in (15,30,60,1440)),
  reminder_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint participant_reminders_unique unique (student_id,activity_id)
);

create table if not exists public.teacher_evaluation_submissions (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.teacher_evaluations(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  response_text text,
  response_url text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evaluation_submission_unique unique (evaluation_id,student_id),
  constraint evaluation_submission_has_response check (nullif(btrim(coalesce(response_text,'')),'') is not null or nullif(btrim(coalesce(response_url,'')),'') is not null),
  constraint evaluation_submission_url check (response_url is null or response_url ~* '^https?://')
);

create index if not exists abt_notifications_recipient_idx on public.abt_notifications(recipient_id,created_at desc);
create index if not exists teacher_sessions_teacher_date_idx on public.teacher_sessions(teacher_id,session_date,status);
create index if not exists teacher_sessions_student_date_idx on public.teacher_sessions(student_id,session_date,status);
create index if not exists teacher_reports_month_status_idx on public.teacher_monthly_reports(report_month,status);
create index if not exists participant_invoices_student_month_idx on public.participant_invoices(student_id,billing_month desc);
create index if not exists participant_reminders_due_idx on public.participant_reminders(student_id,reminder_at,sent_at);

alter table public.abt_notifications enable row level security;
alter table public.teacher_private_selections enable row level security;
alter table public.teacher_class_links enable row level security;
alter table public.teacher_session_rates enable row level security;
alter table public.class_session_rates enable row level security;
alter table public.teacher_sessions enable row level security;
alter table public.teacher_monthly_reports enable row level security;
alter table public.participant_invoices enable row level security;
alter table public.participant_reminders enable row level security;
alter table public.teacher_evaluation_submissions enable row level security;

grant select on public.abt_notifications to authenticated;
grant select on public.teacher_private_selections to authenticated;
grant select,insert,update,delete on public.teacher_class_links to authenticated;
grant select,insert,update,delete on public.teacher_session_rates to authenticated;
grant select,insert,update,delete on public.class_session_rates to authenticated;
grant select,insert,update,delete on public.teacher_sessions to authenticated;
grant select on public.teacher_monthly_reports to authenticated;
grant select on public.participant_invoices to authenticated;
grant select on public.participant_reminders to authenticated;
grant select,insert,update on public.teacher_evaluation_submissions to authenticated;

create or replace function public.abt_v20_is_admin()
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$ select public.abt_v19_current_role() in ('admin','super_admin'); $$;

create or replace function public.abt_v20_is_private_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$ select exists(select 1 from public.classes c where c.id=p_class_id and lower(coalesce(c.category::text,'')) like '%privat%'); $$;

create or replace function public.abt_v20_student_has_class(p_class_id uuid,p_student_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select case
    when p_student_id is distinct from auth.uid()
      and not public.abt_v20_is_admin()
      and not public.abt_v19_teacher_owns_class(p_class_id) then false
    else exists (
      select 1 from public.class_enrollments ce join public.classes c on c.id=ce.class_id
      where ce.class_id=p_class_id and ce.student_id=p_student_id
        and (
          (lower(coalesce(c.category::text,'')) like '%privat%' and exists (
            select 1 from public.teacher_private_selections s
            where s.class_id=p_class_id and s.student_id=p_student_id and s.status='aktif'
          ))
          or (lower(coalesce(c.category::text,'')) not like '%privat%' and lower(coalesce(ce.payment_status::text,'')) in ('terverifikasi','approved','active','aktif'))
        )
    )
  end;
$$;

create or replace function public.abt_v20_teacher_can_manage_session(p_class_id uuid,p_session_date date)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select public.abt_v19_teacher_owns_class(p_class_id)
    and p_session_date <= (now() at time zone 'Asia/Jakarta')::date
    and not exists (
    select 1 from public.teacher_monthly_reports r
    where r.teacher_id=auth.uid() and r.report_month=date_trunc('month',p_session_date)::date
      and r.status in ('submitted','approved')
  );
$$;

create or replace function public.abt_v20_user_can_read_class_path(p_class_id text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare v_class_id uuid;
begin
  if p_class_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  v_class_id:=p_class_id::uuid;
  return public.abt_v19_teacher_owns_class(v_class_id)
    or public.abt_v20_is_admin()
    or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(v_class_id,auth.uid()));
end;
$$;

revoke all on function public.abt_v20_is_admin() from public;
revoke all on function public.abt_v20_is_private_class(uuid) from public;
revoke all on function public.abt_v20_student_has_class(uuid,uuid) from public;
revoke all on function public.abt_v20_teacher_can_manage_session(uuid,date) from public;
revoke all on function public.abt_v20_user_can_read_class_path(text) from public;
grant execute on function public.abt_v20_is_admin() to authenticated;
grant execute on function public.abt_v20_is_private_class(uuid) to authenticated;
grant execute on function public.abt_v20_student_has_class(uuid,uuid) to authenticated;
grant execute on function public.abt_v20_teacher_can_manage_session(uuid,date) to authenticated;
grant execute on function public.abt_v20_user_can_read_class_path(text) to authenticated;

-- Any signed-in account may manage only its own profile photo.
drop policy if exists abt_v19_teacher_photos_select on public.teacher_profile_photos;
drop policy if exists abt_v19_teacher_photos_insert on public.teacher_profile_photos;
drop policy if exists abt_v19_teacher_photos_update on public.teacher_profile_photos;
drop policy if exists abt_v19_teacher_photos_delete on public.teacher_profile_photos;
drop policy if exists abt_v20_profile_photos_select on public.teacher_profile_photos;
create policy abt_v20_profile_photos_select on public.teacher_profile_photos for select to authenticated using (profile_id=auth.uid());
drop policy if exists abt_v20_profile_photos_insert on public.teacher_profile_photos;
create policy abt_v20_profile_photos_insert on public.teacher_profile_photos for insert to authenticated with check (profile_id=auth.uid());
drop policy if exists abt_v20_profile_photos_update on public.teacher_profile_photos;
create policy abt_v20_profile_photos_update on public.teacher_profile_photos for update to authenticated using (profile_id=auth.uid()) with check (profile_id=auth.uid());
drop policy if exists abt_v20_profile_photos_delete on public.teacher_profile_photos;
create policy abt_v20_profile_photos_delete on public.teacher_profile_photos for delete to authenticated using (profile_id=auth.uid());

-- Teacher content becomes visible only to the current instructor, Admin, and enrolled learners.
drop policy if exists abt_v20_materials_select_student on public.teacher_materials;
create policy abt_v20_materials_select_student on public.teacher_materials for select to authenticated
  using (public.abt_v20_is_admin() or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_activities_select_student on public.teacher_activities;
create policy abt_v20_activities_select_student on public.teacher_activities for select to authenticated
  using (public.abt_v20_is_admin() or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_evaluations_select_student on public.teacher_evaluations;
create policy abt_v20_evaluations_select_student on public.teacher_evaluations for select to authenticated
  using (public.abt_v20_is_admin() or (public.abt_v19_current_role()='peserta' and is_published and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_evaluations_select_guard on public.teacher_evaluations;
create policy abt_v20_evaluations_select_guard on public.teacher_evaluations as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and is_published and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_results_select_student on public.teacher_evaluation_results;
create policy abt_v20_results_select_student on public.teacher_evaluation_results for select to authenticated
  using (public.abt_v20_is_admin() or (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid()))));
drop policy if exists abt_v20_results_select_guard on public.teacher_evaluation_results;
create policy abt_v20_results_select_guard on public.teacher_evaluation_results as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and public.abt_v19_teacher_owns_class(e.class_id)) or (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid()))));

-- Published lesson rows are visible only to the enrolled learner, their teacher, or Admin.
drop policy if exists abt_v20_lessons_select_student on public.lessons;
create policy abt_v20_lessons_select_student on public.lessons for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and is_published and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_lessons_select_guard on public.lessons;
create policy abt_v20_lessons_select_guard on public.lessons as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and is_published and public.abt_v20_student_has_class(class_id,auth.uid())));

-- Private class requests and teacher decisions.
drop policy if exists abt_v20_private_selection_select on public.teacher_private_selections;
create policy abt_v20_private_selection_select on public.teacher_private_selections for select to authenticated
  using ((student_id=auth.uid() and public.abt_v19_current_role()='peserta') or public.abt_v20_is_admin() or public.abt_v20_is_private_class(class_id) and public.abt_v19_teacher_owns_class(class_id));

create or replace function public.decide_private_enrollment(p_class_id uuid,p_student_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_status text;
begin
  if not public.abt_v20_is_private_class(p_class_id) or not public.abt_v19_teacher_owns_class(p_class_id) then
    raise exception 'Anda hanya dapat memilih peserta pada kelas privat yang ditugaskan kepada Anda';
  end if;
  if not exists(select 1 from public.class_enrollments ce where ce.class_id=p_class_id and ce.student_id=p_student_id) then
    raise exception 'Pendaftaran peserta tidak ditemukan';
  end if;
  v_status:=case when p_accept then 'aktif' else 'ditolak' end;
  insert into public.teacher_private_selections(class_id,student_id,teacher_id,status,decided_at,updated_at)
  values(p_class_id,p_student_id,auth.uid(),v_status,now(),now())
  on conflict(class_id,student_id) do update set teacher_id=excluded.teacher_id,status=excluded.status,decided_at=now(),updated_at=now();
  insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
  values(p_student_id,auth.uid(),p_class_id,
    case when p_accept then 'Pengajar menerima pendaftaran privat' else 'Status pendaftaran privat diperbarui' end,
    case when p_accept then 'Pendaftaran Anda telah diterima. Jadwal dan informasi kelas tersedia di menu Kelas Saya.' else 'Pengajar belum dapat mengambil pendaftaran ini. Hubungi Admin untuk pilihan kelas lain.' end,
    'private_selection');
  return jsonb_build_object('success',true,'status',v_status);
end;
$$;
revoke all on function public.decide_private_enrollment(uuid,uuid,boolean) from public;
grant execute on function public.decide_private_enrollment(uuid,uuid,boolean) to authenticated;

-- Secure teacher-class links and per-session rates.
drop policy if exists abt_v20_class_links_select on public.teacher_class_links;
create policy abt_v20_class_links_select on public.teacher_class_links for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_class_links_insert on public.teacher_class_links;
create policy abt_v20_class_links_insert on public.teacher_class_links for insert to authenticated
  with check (public.abt_v19_teacher_owns_class(class_id) and updated_by=auth.uid());
drop policy if exists abt_v20_class_links_update on public.teacher_class_links;
create policy abt_v20_class_links_update on public.teacher_class_links for update to authenticated
  using (public.abt_v19_teacher_owns_class(class_id)) with check (public.abt_v19_teacher_owns_class(class_id) and updated_by=auth.uid());
drop policy if exists abt_v20_class_links_delete on public.teacher_class_links;
create policy abt_v20_class_links_delete on public.teacher_class_links for delete to authenticated using (public.abt_v19_teacher_owns_class(class_id));

drop policy if exists abt_v20_teacher_rate_select on public.teacher_session_rates;
create policy abt_v20_teacher_rate_select on public.teacher_session_rates for select to authenticated
  using (public.abt_v20_is_admin() or teacher_id=auth.uid() and public.abt_v19_current_role()='pengajar');
drop policy if exists abt_v20_teacher_rate_admin_insert on public.teacher_session_rates;
create policy abt_v20_teacher_rate_admin_insert on public.teacher_session_rates for insert to authenticated
  with check (public.abt_v20_is_admin() and updated_by=auth.uid() and exists(select 1 from public.profiles p where p.id=teacher_id and p.role::text='pengajar'));
drop policy if exists abt_v20_teacher_rate_admin_update on public.teacher_session_rates;
create policy abt_v20_teacher_rate_admin_update on public.teacher_session_rates for update to authenticated
  using (public.abt_v20_is_admin()) with check (public.abt_v20_is_admin() and updated_by=auth.uid() and exists(select 1 from public.profiles p where p.id=teacher_id and p.role::text='pengajar'));
drop policy if exists abt_v20_teacher_rate_admin_delete on public.teacher_session_rates;
create policy abt_v20_teacher_rate_admin_delete on public.teacher_session_rates for delete to authenticated using (public.abt_v20_is_admin());

drop policy if exists abt_v20_class_rate_admin_select on public.class_session_rates;
create policy abt_v20_class_rate_admin_select on public.class_session_rates for select to authenticated using (public.abt_v20_is_admin());
drop policy if exists abt_v20_class_rate_admin_insert on public.class_session_rates;
create policy abt_v20_class_rate_admin_insert on public.class_session_rates for insert to authenticated with check (public.abt_v20_is_admin() and updated_by=auth.uid());
drop policy if exists abt_v20_class_rate_admin_update on public.class_session_rates;
create policy abt_v20_class_rate_admin_update on public.class_session_rates for update to authenticated using (public.abt_v20_is_admin()) with check (public.abt_v20_is_admin() and updated_by=auth.uid());
drop policy if exists abt_v20_class_rate_admin_delete on public.class_session_rates;
create policy abt_v20_class_rate_admin_delete on public.class_session_rates for delete to authenticated using (public.abt_v20_is_admin());

-- Session log. Submitted or approved monthly reports lock their source sessions.
drop policy if exists abt_v20_sessions_select on public.teacher_sessions;
create policy abt_v20_sessions_select on public.teacher_sessions for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (student_id=auth.uid() and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_sessions_insert on public.teacher_sessions;
create policy abt_v20_sessions_insert on public.teacher_sessions for insert to authenticated
  with check (
    teacher_id=auth.uid() and public.abt_v20_teacher_can_manage_session(class_id,session_date)
    and exists(select 1 from public.teacher_activities a where a.id=teacher_sessions.activity_id and a.class_id=teacher_sessions.class_id)
    and public.abt_v20_student_has_class(class_id,student_id)
  );
drop policy if exists abt_v20_sessions_update on public.teacher_sessions;
create policy abt_v20_sessions_update on public.teacher_sessions for update to authenticated
  using (teacher_id=auth.uid() and public.abt_v20_teacher_can_manage_session(class_id,session_date))
  with check (teacher_id=auth.uid() and public.abt_v20_teacher_can_manage_session(class_id,session_date) and public.abt_v20_student_has_class(class_id,student_id) and exists(select 1 from public.teacher_activities a where a.id=teacher_sessions.activity_id and a.class_id=teacher_sessions.class_id));
drop policy if exists abt_v20_sessions_delete on public.teacher_sessions;
create policy abt_v20_sessions_delete on public.teacher_sessions for delete to authenticated
  using (teacher_id=auth.uid() and public.abt_v20_teacher_can_manage_session(class_id,session_date));

drop policy if exists abt_v20_reports_select on public.teacher_monthly_reports;
create policy abt_v20_reports_select on public.teacher_monthly_reports for select to authenticated
  using (public.abt_v20_is_admin() or (teacher_id=auth.uid() and public.abt_v19_current_role()='pengajar'));

drop policy if exists abt_v20_invoices_select on public.participant_invoices;
create policy abt_v20_invoices_select on public.participant_invoices for select to authenticated
  using (public.abt_v20_is_admin() or (student_id=auth.uid() and public.abt_v19_current_role()='peserta'));

drop policy if exists abt_v20_reminders_select on public.participant_reminders;
create policy abt_v20_reminders_select on public.participant_reminders for select to authenticated
  using (student_id=auth.uid() and public.abt_v19_current_role()='peserta');

drop policy if exists abt_v20_submissions_select on public.teacher_evaluation_submissions;
create policy abt_v20_submissions_select on public.teacher_evaluation_submissions for select to authenticated
  using (
    (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid())))
    or exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and public.abt_v19_teacher_owns_class(e.class_id))
    or public.abt_v20_is_admin()
  );
drop policy if exists abt_v20_submissions_insert on public.teacher_evaluation_submissions;
create policy abt_v20_submissions_insert on public.teacher_evaluation_submissions for insert to authenticated
  with check (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(
    select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid())
  ));
drop policy if exists abt_v20_submissions_update on public.teacher_evaluation_submissions;
create policy abt_v20_submissions_update on public.teacher_evaluation_submissions for update to authenticated
  using (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid())))
  with check (student_id=auth.uid() and public.abt_v19_current_role()='peserta' and exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and e.is_published and public.abt_v20_student_has_class(e.class_id,auth.uid())));

drop policy if exists abt_v20_notifications_select on public.abt_notifications;
create policy abt_v20_notifications_select on public.abt_notifications for select to authenticated using (recipient_id=auth.uid());

create or replace function public.send_abt_notification(p_title text,p_body text,p_audience text,p_class_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_role text; v_count integer:=0;
begin
  v_role:=public.abt_v19_current_role();
  if coalesce(length(btrim(p_title)),0) not between 1 and 160 or coalesce(length(btrim(p_body)),0) not between 1 and 3000 then
    raise exception 'Judul dan isi notifikasi wajib diisi (judul maks. 160, isi maks. 3000 karakter)';
  end if;
  if v_role in ('admin','super_admin') then
    if p_audience='all' then
      insert into public.abt_notifications(recipient_id,sender_id,title,body,source)
      select p.id,auth.uid(),btrim(p_title),btrim(p_body),'announcement' from public.profiles p;
    elsif p_audience in ('pengajar','peserta') then
      insert into public.abt_notifications(recipient_id,sender_id,title,body,source)
      select p.id,auth.uid(),btrim(p_title),btrim(p_body),'announcement' from public.profiles p where p.role::text=p_audience;
    elsif p_audience='kelas' and p_class_id is not null then
      insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
      select distinct ce.student_id,auth.uid(),p_class_id,btrim(p_title),btrim(p_body),'announcement'
      from public.class_enrollments ce where ce.class_id=p_class_id;
    else raise exception 'Sasaran notifikasi Admin tidak valid';
    end if;
  elsif v_role='pengajar' then
    if p_audience<>'kelas' or p_class_id is null or not public.abt_v19_teacher_owns_class(p_class_id) then
      raise exception 'Pengajar hanya dapat mengirim notifikasi ke peserta kelas yang ditugaskan';
    end if;
    insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
    select distinct ce.student_id,auth.uid(),p_class_id,btrim(p_title),btrim(p_body),'teacher_announcement'
    from public.class_enrollments ce where ce.class_id=p_class_id and public.abt_v20_student_has_class(p_class_id,ce.student_id);
  else raise exception 'Peran akun ini tidak dapat mengirim notifikasi';
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('success',true,'sent',v_count);
end;
$$;
revoke all on function public.send_abt_notification(text,text,text,uuid) from public;
grant execute on function public.send_abt_notification(text,text,text,uuid) to authenticated;

create or replace function public.mark_abt_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_id uuid;
begin
  update public.abt_notifications set read_at=coalesce(read_at,now()) where id=p_notification_id and recipient_id=auth.uid() returning id into v_id;
  if v_id is null then raise exception 'Notifikasi tidak ditemukan'; end if;
  if public.abt_v19_current_role()='pengajar' then
    update public.teacher_notifications set read_at=coalesce(read_at,now()) where id=p_notification_id and teacher_id=auth.uid();
  end if;
  return jsonb_build_object('success',true,'id',v_id);
end;
$$;
revoke all on function public.mark_abt_notification_read(uuid) from public;
grant execute on function public.mark_abt_notification_read(uuid) to authenticated;

create or replace function public.set_class_reminder(p_activity_id uuid,p_minutes_before integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_activity public.teacher_activities%rowtype;
begin
  if public.abt_v19_current_role()<>'peserta' then raise exception 'Pengingat hanya dapat dibuat oleh akun Peserta'; end if;
  if p_minutes_before=0 then
    delete from public.participant_reminders where student_id=auth.uid() and activity_id=p_activity_id;
    return jsonb_build_object('success',true,'enabled',false);
  end if;
  if p_minutes_before not in (15,30,60,1440) then raise exception 'Pilihan waktu pengingat tidak valid'; end if;
  select * into v_activity from public.teacher_activities where id=p_activity_id;
  if not found or not public.abt_v20_student_has_class(v_activity.class_id,auth.uid()) or v_activity.starts_at<=now() then
    raise exception 'Jadwal tidak tersedia untuk akun Anda';
  end if;
  insert into public.participant_reminders(student_id,activity_id,minutes_before,reminder_at,sent_at)
  values(auth.uid(),p_activity_id,p_minutes_before,v_activity.starts_at-(p_minutes_before||' minutes')::interval,null)
  on conflict(student_id,activity_id) do update set minutes_before=excluded.minutes_before,reminder_at=excluded.reminder_at,sent_at=null;
  return jsonb_build_object('success',true,'enabled',true,'reminder_at',v_activity.starts_at-(p_minutes_before||' minutes')::interval);
end;
$$;
revoke all on function public.set_class_reminder(uuid,integer) from public;
grant execute on function public.set_class_reminder(uuid,integer) to authenticated;

create or replace function public.process_due_class_reminders()
returns integer language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_item record; v_count integer:=0;
begin
  if public.abt_v19_current_role()<>'peserta' then return 0; end if;
  for v_item in
    select r.id,r.activity_id,a.class_id,a.title,a.starts_at,c.title as class_title
    from public.participant_reminders r join public.teacher_activities a on a.id=r.activity_id
    join public.classes c on c.id=a.class_id
    where r.student_id=auth.uid() and r.sent_at is null and r.reminder_at<=now()
      and public.abt_v20_student_has_class(a.class_id,auth.uid())
    for update of r
  loop
    insert into public.abt_notifications(recipient_id,class_id,title,body,source)
    values(auth.uid(),v_item.class_id,'Pengingat jadwal kelas',v_item.title||' pada kelas '||v_item.class_title||' dimulai '||to_char(v_item.starts_at,'DD Mon YYYY HH24:MI')||'.','class_reminder');
    update public.participant_reminders set sent_at=now() where id=v_item.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.process_due_class_reminders() from public;
grant execute on function public.process_due_class_reminders() to authenticated;

create or replace function public.submit_teacher_monthly_report(p_report_month date default (date_trunc('month',(now() at time zone 'Asia/Jakarta')-interval '1 month'))::date)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_rate numeric(12,2); v_count integer; v_id uuid; v_status text;
begin
  if public.abt_v19_current_role()<>'pengajar' then raise exception 'Laporan hanya dapat dikirim oleh Pengajar'; end if;
  if p_report_month<>(date_trunc('month',(now() at time zone 'Asia/Jakarta')-interval '1 month'))::date then raise exception 'Laporan hanya dapat dikirim untuk bulan sebelumnya'; end if;
  select rate_per_session into v_rate from public.teacher_session_rates where teacher_id=auth.uid();
  if v_rate is null then raise exception 'Tarif per pertemuan belum ditetapkan Admin'; end if;
  select count(*)::integer into v_count from public.teacher_sessions
    where teacher_id=auth.uid() and status='completed' and session_date>=p_report_month and session_date<(p_report_month+interval '1 month')::date;
  select status into v_status from public.teacher_monthly_reports where teacher_id=auth.uid() and report_month=p_report_month;
  if v_status in ('submitted','approved') then raise exception 'Laporan bulan ini sudah dikirim'; end if;
  insert into public.teacher_monthly_reports(teacher_id,report_month,session_count,rate_per_session,total_amount,status,submitted_at,admin_note)
  values(auth.uid(),p_report_month,v_count,v_rate,v_count*v_rate,'submitted',now(),null)
  on conflict(teacher_id,report_month) do update set session_count=excluded.session_count,rate_per_session=excluded.rate_per_session,total_amount=excluded.total_amount,status='submitted',submitted_at=now(),reviewed_by=null,reviewed_at=null,admin_note=null
  returning id into v_id;
  insert into public.abt_notifications(recipient_id,sender_id,title,body,source)
  select p.id,auth.uid(),'Laporan honor pengajar masuk',
    'Laporan '||to_char(p_report_month,'Month YYYY')||' berisi '||v_count||' pertemuan dengan nilai honor '||'Rp '||to_char(v_count*v_rate,'FM999G999G999G990D00')||' menunggu tinjauan.','payroll_submission'
  from public.profiles p where p.role::text in ('admin','super_admin');
  return jsonb_build_object('success',true,'id',v_id,'session_count',v_count,'rate_per_session',v_rate,'total_amount',v_count*v_rate);
end;
$$;
revoke all on function public.submit_teacher_monthly_report(date) from public;
grant execute on function public.submit_teacher_monthly_report(date) to authenticated;

create or replace function public.review_teacher_monthly_report(p_report_id uuid,p_approve boolean,p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_report public.teacher_monthly_reports%rowtype; v_missing integer; v_created integer:=0;
begin
  if not public.abt_v20_is_admin() then raise exception 'Hanya Admin yang dapat meninjau laporan pengajar'; end if;
  select * into v_report from public.teacher_monthly_reports where id=p_report_id for update;
  if not found or v_report.status<>'submitted' then raise exception 'Laporan tidak tersedia untuk ditinjau'; end if;
  if p_approve then
    select count(*) into v_missing from (
      select distinct s.class_id from public.teacher_sessions s
      where s.teacher_id=v_report.teacher_id and s.status='completed'
        and s.session_date>=v_report.report_month and s.session_date<(v_report.report_month+interval '1 month')::date
        and not exists(select 1 from public.class_session_rates cr where cr.class_id=s.class_id)
    ) missing_rates;
    if v_missing>0 then raise exception 'Tarif peserta per pertemuan belum diatur untuk % kelas pada bulan laporan',v_missing; end if;
    update public.teacher_monthly_reports set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),admin_note=nullif(btrim(p_admin_note),'') where id=p_report_id;
    insert into public.participant_invoices(report_id,student_id,class_id,billing_month,session_count,rate_per_session,amount_due,status,issued_by)
    select v_report.id,s.student_id,s.class_id,v_report.report_month,count(*)::integer,cr.rate_per_session,count(*)*cr.rate_per_session,'issued',auth.uid()
    from public.teacher_sessions s join public.class_session_rates cr on cr.class_id=s.class_id
    where s.teacher_id=v_report.teacher_id and s.status='completed'
      and s.session_date>=v_report.report_month and s.session_date<(v_report.report_month+interval '1 month')::date
    group by s.student_id,s.class_id,cr.rate_per_session
    on conflict(report_id,student_id,class_id) do nothing;
    get diagnostics v_created=row_count;
  else
    update public.teacher_monthly_reports set status='needs_correction',reviewed_by=auth.uid(),reviewed_at=now(),admin_note=nullif(btrim(p_admin_note),'') where id=p_report_id;
  end if;
  insert into public.abt_notifications(recipient_id,sender_id,title,body,source)
  values(v_report.teacher_id,auth.uid(),case when p_approve then 'Laporan honor disetujui' else 'Laporan honor perlu diperbaiki' end,
    case when p_approve then 'Laporan '||to_char(v_report.report_month,'Month YYYY')||' disetujui. Total honor: Rp '||to_char(v_report.total_amount,'FM999G999G999G990D00')||'.' else 'Laporan '||to_char(v_report.report_month,'Month YYYY')||' perlu diperbaiki. Catatan Admin: '||coalesce(nullif(btrim(p_admin_note),''),'Silakan periksa kembali data pertemuan.') end,'payroll_review');
  return jsonb_build_object('success',true,'status',case when p_approve then 'approved' else 'needs_correction' end,'invoices_created',v_created);
end;
$$;
revoke all on function public.review_teacher_monthly_report(uuid,boolean,text) from public;
grant execute on function public.review_teacher_monthly_report(uuid,boolean,text) to authenticated;

create or replace function public.set_participant_invoice_status(p_invoice_id uuid,p_status text,p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_id uuid;
begin
  if not public.abt_v20_is_admin() then raise exception 'Hanya Admin yang dapat mengubah status tagihan'; end if;
  if p_status not in ('issued','paid','void') then raise exception 'Status tagihan tidak valid'; end if;
  update public.participant_invoices set status=p_status,paid_at=case when p_status='paid' then coalesce(paid_at,now()) else null end,
    admin_note=nullif(btrim(p_admin_note),'') where id=p_invoice_id returning id into v_id;
  if v_id is null then raise exception 'Invoice tidak ditemukan'; end if;
  return jsonb_build_object('success',true,'id',v_id,'status',p_status);
end;
$$;
revoke all on function public.set_participant_invoice_status(uuid,text,text) from public;
grant execute on function public.set_participant_invoice_status(uuid,text,text) to authenticated;

-- Notification events from class schedules and newly issued invoices.
create or replace function public.abt_v20_notify_class_activity()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if tg_op='UPDATE' and new.title is not distinct from old.title and new.starts_at is not distinct from old.starts_at and new.ends_at is not distinct from old.ends_at then
    return new;
  end if;
  insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
  select distinct ce.student_id,new.created_by,new.class_id,case when tg_op='INSERT' then 'Jadwal kelas baru' else 'Jadwal kelas diperbarui' end,new.title||' dijadwalkan pada '||to_char(new.starts_at,'DD Mon YYYY HH24:MI')||'.','class_activity'
  from public.class_enrollments ce where ce.class_id=new.class_id and public.abt_v20_student_has_class(new.class_id,ce.student_id);
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_class_activity() from public;
drop trigger if exists abt_v20_teacher_activity_notice on public.teacher_activities;
create trigger abt_v20_teacher_activity_notice after insert or update of title,starts_at,ends_at on public.teacher_activities for each row execute function public.abt_v20_notify_class_activity();

create or replace function public.abt_v20_notify_published_evaluation()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if not new.is_published or (tg_op='UPDATE' and old.is_published and new.due_at is not distinct from old.due_at) then return new; end if;
  insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
  select distinct ce.student_id,new.created_by,new.class_id,'Tugas atau latihan baru',new.title||case when new.due_at is null then ' telah tersedia.' else ' · tenggat '||to_char(new.due_at,'DD Mon YYYY HH24:MI')||'.' end,'evaluation'
  from public.class_enrollments ce where ce.class_id=new.class_id and public.abt_v20_student_has_class(new.class_id,ce.student_id);
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_published_evaluation() from public;
drop trigger if exists abt_v20_evaluation_notice on public.teacher_evaluations;
create trigger abt_v20_evaluation_notice after insert or update of is_published,due_at on public.teacher_evaluations for each row execute function public.abt_v20_notify_published_evaluation();

create or replace function public.abt_v20_copy_teacher_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  insert into public.abt_notifications(id,recipient_id,class_id,title,body,source,read_at,created_at)
  values(new.id,new.teacher_id,new.class_id,new.title,coalesce(new.body,''),'teacher_'||new.kind,new.read_at,new.created_at)
  on conflict(id) do nothing;
  return new;
end;
$$;
revoke all on function public.abt_v20_copy_teacher_notification() from public;
drop trigger if exists abt_v20_copy_teacher_notification on public.teacher_notifications;
create trigger abt_v20_copy_teacher_notification after insert on public.teacher_notifications for each row execute function public.abt_v20_copy_teacher_notification();

create or replace function public.abt_v20_notify_enrollment_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_class_title text;
begin
  if new.payment_status is not distinct from old.payment_status then return new; end if;
  select c.title into v_class_title from public.classes c where c.id=new.class_id;
  insert into public.abt_notifications(recipient_id,class_id,title,body,source)
  values(new.student_id,new.class_id,'Status pendaftaran diperbarui',
    'Pendaftaran kelas '||coalesce(v_class_title,'Anda')||' sekarang berstatus '||coalesce(new.payment_status::text,'belum ditentukan')||'.','enrollment_status');
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_enrollment_status() from public;
drop trigger if exists abt_v20_enrollment_status_notice on public.class_enrollments;
create trigger abt_v20_enrollment_status_notice after update of payment_status on public.class_enrollments for each row execute function public.abt_v20_notify_enrollment_status();

create or replace function public.abt_v20_notify_invoice()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  insert into public.abt_notifications(recipient_id,class_id,title,body,source)
  values(new.student_id,new.class_id,'Tagihan bulanan diterbitkan','Invoice '||new.invoice_no||' untuk '||to_char(new.billing_month,'Month YYYY')||' sebesar Rp '||to_char(new.amount_due,'FM999G999G999G990D00')||' telah tersedia di menu Tagihan.','invoice');
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_invoice() from public;
drop trigger if exists abt_v20_invoice_notice on public.participant_invoices;
create trigger abt_v20_invoice_notice after insert on public.participant_invoices for each row execute function public.abt_v20_notify_invoice();

create or replace function public.abt_v20_notify_invoice_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  insert into public.abt_notifications(recipient_id,class_id,title,body,source)
  values(new.student_id,new.class_id,case when new.status='paid' then 'Pembayaran tagihan dikonfirmasi' else 'Status tagihan diperbarui' end,
    'Invoice '||new.invoice_no||' kini berstatus '||new.status||'.','invoice_status');
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_invoice_status() from public;
drop trigger if exists abt_v20_invoice_status_notice on public.participant_invoices;
create trigger abt_v20_invoice_status_notice after update of status on public.participant_invoices for each row execute function public.abt_v20_notify_invoice_status();

-- All-role read and write access is narrowly scoped by the policies above.
drop policy if exists abt_v20_materials_select_guard on public.teacher_materials;
create policy abt_v20_materials_select_guard on public.teacher_materials as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_activities_select_guard on public.teacher_activities;
create policy abt_v20_activities_select_guard on public.teacher_activities as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or public.abt_v19_teacher_owns_class(class_id) or (public.abt_v19_current_role()='peserta' and public.abt_v20_student_has_class(class_id,auth.uid())));
drop policy if exists abt_v20_results_select_guard_v2 on public.teacher_evaluation_results;
create policy abt_v20_results_select_guard_v2 on public.teacher_evaluation_results as restrictive for select to authenticated
  using (public.abt_v20_is_admin() or exists(select 1 from public.teacher_evaluations e where e.id=evaluation_id and public.abt_v19_teacher_owns_class(e.class_id)) or (student_id=auth.uid() and public.abt_v19_current_role()='peserta'));

-- Let enrolled participants open private teacher materials. Writes remain teacher-only.
drop policy if exists abt_v19_teacher_material_objects_guard_select on storage.objects;
drop policy if exists abt_v20_material_objects_select_student on storage.objects;
drop policy if exists abt_v20_material_objects_select_admin on storage.objects;
create policy abt_v20_material_objects_select_admin on storage.objects for select to authenticated
  using (bucket_id='abt-teacher-materials' and public.abt_v20_is_admin());
create policy abt_v20_material_objects_select_student on storage.objects for select to authenticated
  using (bucket_id='abt-teacher-materials' and public.abt_v19_current_role()='peserta' and public.abt_v20_user_can_read_class_path(split_part(name,'/',1)));
drop policy if exists abt_v20_material_objects_select_guard on storage.objects;
create policy abt_v20_material_objects_select_guard on storage.objects as restrictive for select to authenticated
  using (bucket_id<>'abt-teacher-materials' or public.abt_v20_user_can_read_class_path(split_part(name,'/',1)));

-- Any role can read/write only its own private profile photo in the private bucket.
drop policy if exists abt_v19_teacher_avatar_objects_select on storage.objects;
drop policy if exists abt_v19_teacher_avatar_objects_insert on storage.objects;
drop policy if exists abt_v19_teacher_avatar_objects_delete on storage.objects;
drop policy if exists abt_v19_teacher_avatar_objects_guard_select on storage.objects;
drop policy if exists abt_v19_teacher_avatar_objects_guard_insert on storage.objects;
drop policy if exists abt_v19_teacher_avatar_objects_guard_delete on storage.objects;
drop policy if exists abt_v20_profile_avatar_select on storage.objects;
create policy abt_v20_profile_avatar_select on storage.objects for select to authenticated
  using (bucket_id='abt-teacher-avatars' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v20_profile_avatar_insert on storage.objects;
create policy abt_v20_profile_avatar_insert on storage.objects for insert to authenticated
  with check (bucket_id='abt-teacher-avatars' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v20_profile_avatar_delete on storage.objects;
create policy abt_v20_profile_avatar_delete on storage.objects for delete to authenticated
  using (bucket_id='abt-teacher-avatars' and split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v20_profile_avatar_guard_select on storage.objects;
create policy abt_v20_profile_avatar_guard_select on storage.objects as restrictive for select to authenticated
  using (bucket_id<>'abt-teacher-avatars' or split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v20_profile_avatar_guard_insert on storage.objects;
create policy abt_v20_profile_avatar_guard_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id<>'abt-teacher-avatars' or split_part(name,'/',1)=auth.uid()::text);
drop policy if exists abt_v20_profile_avatar_guard_delete on storage.objects;
create policy abt_v20_profile_avatar_guard_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id<>'abt-teacher-avatars' or split_part(name,'/',1)=auth.uid()::text);

-- Import V19 teacher-only notifications into the shared inbox without duplication.
insert into public.abt_notifications(id,recipient_id,class_id,title,body,source,created_at)
select tn.id,tn.teacher_id,tn.class_id,tn.title,coalesce(tn.body,''),'teacher_legacy',tn.created_at
from public.teacher_notifications tn
on conflict(id) do nothing;

commit;
