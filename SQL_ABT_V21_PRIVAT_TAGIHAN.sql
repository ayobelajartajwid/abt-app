-- ABT V21: kelas privat terbuka, klaim pengajar, tarif berdasarkan jumlah peserta,
-- invoice privat dari laporan, dan invoice reguler bulanan otomatis.
-- Jalankan setelah SQL_ABT_V20_INTEGRASI.sql.

begin;

do $$
begin
  if to_regclass('public.classes') is null
     or to_regclass('public.class_enrollments') is null
     or to_regclass('public.teacher_private_selections') is null
     or to_regclass('public.teacher_sessions') is null
     or to_regclass('public.teacher_monthly_reports') is null
     or to_regclass('public.participant_invoices') is null
     or to_regclass('public.abt_notifications') is null then
    raise exception 'ABT V21 membutuhkan seluruh tabel inti V20. Jalankan migrasi V19 dan V20 terlebih dahulu.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='classes' and column_name='instructor_id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='classes' and column_name='price_amount')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='class_enrollments' and column_name='payment_status')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='teacher_private_selections' and column_name='teacher_id') then
    raise exception 'ABT V21 dihentikan: kolom inti tidak cocok dengan skema V20.';
  end if;
end;
$$;

-- Tarif awal sesuai tabel biaya pada lampiran. Admin dapat mengubah nilainya di menu Keuangan.
create table if not exists public.private_class_rate_tiers (
  participant_count smallint primary key check (participant_count between 1 and 5),
  rate_per_participant numeric(12,2) not null check (rate_per_participant >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.private_class_rate_tiers(participant_count,rate_per_participant)
values (1,50000),(2,40000),(3,35000),(4,30000),(5,27500)
on conflict (participant_count) do nothing;

alter table public.private_class_rate_tiers enable row level security;
revoke all on public.private_class_rate_tiers from anon, authenticated;
grant select on public.private_class_rate_tiers to anon, authenticated;
grant update on public.private_class_rate_tiers to authenticated;
drop policy if exists abt_v21_private_rates_public_read on public.private_class_rate_tiers;
create policy abt_v21_private_rates_public_read on public.private_class_rate_tiers
  for select to anon, authenticated using (true);
drop policy if exists abt_v21_private_rates_admin_update on public.private_class_rate_tiers;
create policy abt_v21_private_rates_admin_update on public.private_class_rate_tiers
  for update to authenticated
  using (public.abt_v20_is_admin())
  with check (public.abt_v20_is_admin() and updated_by=auth.uid());

-- Keep V20 invoices intact as legacy records while adding explicit billing modes.
alter table public.participant_invoices add column if not exists billing_type text not null default 'legacy';
alter table public.participant_invoices add column if not exists due_date date;
alter table public.participant_invoices add column if not exists participant_count smallint;
alter table public.participant_invoices alter column report_id drop not null;
alter table public.participant_invoices alter column issued_by drop not null;
alter table public.participant_invoices drop constraint if exists participant_invoices_session_count_check;
alter table public.participant_invoices add constraint participant_invoices_session_count_check check (session_count >= 0);
alter table public.participant_invoices drop constraint if exists participant_invoices_billing_type_check;
alter table public.participant_invoices add constraint participant_invoices_billing_type_check check (billing_type in ('legacy','private','regular'));
alter table public.participant_invoices drop constraint if exists participant_invoices_participant_count_check;
alter table public.participant_invoices add constraint participant_invoices_participant_count_check check (participant_count is null or participant_count between 1 and 5);
create unique index if not exists participant_invoice_regular_month_unique
  on public.participant_invoices(billing_month,student_id,class_id)
  where billing_type='regular';
create index if not exists participant_invoice_due_date_idx
  on public.participant_invoices(due_date,status) where billing_type='regular';

-- Freeze the class fee at signup so a later Admin price change affects only new registrations.
alter table public.class_enrollments add column if not exists enrolled_price_amount numeric(12,2);
update public.class_enrollments ce
set enrolled_price_amount=coalesce(c.price_amount,0)
from public.classes c
where c.id=ce.class_id and ce.enrolled_price_amount is null;
alter table public.class_enrollments alter column enrolled_price_amount set default 0;
alter table public.class_enrollments alter column enrolled_price_amount set not null;
alter table public.class_enrollments drop constraint if exists class_enrollments_enrolled_price_amount_check;
alter table public.class_enrollments add constraint class_enrollments_enrolled_price_amount_check check (enrolled_price_amount>=0);

create or replace function public.abt_v21_snapshot_enrollment_price()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_price numeric(12,2);
begin
  select coalesce(c.price_amount,0) into v_price
  from public.classes c where c.id=new.class_id;
  if not found then raise exception 'Kelas pendaftaran tidak ditemukan'; end if;
  new.enrolled_price_amount:=v_price;
  return new;
end;
$$;
revoke all on function public.abt_v21_snapshot_enrollment_price() from public;
drop trigger if exists abt_v21_snapshot_enrollment_price on public.class_enrollments;
create trigger abt_v21_snapshot_enrollment_price before insert on public.class_enrollments
  for each row execute function public.abt_v21_snapshot_enrollment_price();

-- Helpers are SECURITY DEFINER to avoid recursive RLS when teacher queues are checked.
create or replace function public.abt_v21_private_class_has_open_request(p_class_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select public.abt_v19_current_role()='pengajar' and exists (
    select 1 from public.classes c
    where c.id=p_class_id and c.status='published'
      and lower(coalesce(c.category,'')) like '%privat%'
      and (c.instructor_id is null or c.instructor_id=auth.uid())
      and exists (
        select 1 from public.class_enrollments ce
        where ce.class_id=c.id and ce.payment_status<>'ditolak'
          and not exists (
            select 1 from public.teacher_private_selections s
            where s.class_id=ce.class_id and s.student_id=ce.student_id and s.status='aktif'
          )
      )
  );
$$;

create or replace function public.abt_v19_teacher_can_view_profile(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select public.abt_v19_current_role()='pengajar' and (
    p_profile_id=auth.uid()
    or exists (
      select 1 from public.class_enrollments ce
      where ce.student_id=p_profile_id
        and public.abt_v19_teacher_owns_class(ce.class_id)
    )
  );
$$;

revoke all on function public.abt_v21_private_class_has_open_request(uuid) from public;
grant execute on function public.abt_v21_private_class_has_open_request(uuid) to authenticated;
revoke all on function public.abt_v19_teacher_can_view_profile(uuid) from public;
grant execute on function public.abt_v19_teacher_can_view_profile(uuid) to authenticated;

-- Teachers see only their assigned classes, plus published private classes with open requests.
drop policy if exists abt_v19_teacher_classes_guard on public.classes;
create policy abt_v19_teacher_classes_guard on public.classes
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar'
    or instructor_id=auth.uid()
    or public.abt_v21_private_class_has_open_request(id));
drop policy if exists abt_v21_open_private_class_select on public.classes;
create policy abt_v21_open_private_class_select on public.classes
  for select to authenticated
  using (public.abt_v21_private_class_has_open_request(id));

-- Enrollment/payment rows remain hidden until a teacher owns the class. The queue RPC
-- below returns only the participant fields teachers need before they accept a class.
drop policy if exists abt_v19_teacher_enrollments_guard on public.class_enrollments;
create policy abt_v19_teacher_enrollments_guard on public.class_enrollments
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar'
    or public.abt_v19_teacher_owns_class(class_id));
drop policy if exists abt_v21_teacher_private_enrollment_select on public.class_enrollments;

drop policy if exists abt_v19_teacher_profiles_guard on public.profiles;
create policy abt_v19_teacher_profiles_guard on public.profiles
  as restrictive for select to authenticated
  using (public.abt_v19_current_role() is distinct from 'pengajar'
    or public.abt_v19_teacher_can_view_profile(id));

drop policy if exists abt_v20_private_selection_select on public.teacher_private_selections;
create policy abt_v20_private_selection_select on public.teacher_private_selections
  for select to authenticated
  using ((student_id=auth.uid() and public.abt_v19_current_role()='peserta')
    or public.abt_v20_is_admin()
    or (public.abt_v20_is_private_class(class_id) and public.abt_v19_teacher_owns_class(class_id)));
drop function if exists public.abt_v21_teacher_can_view_private_request(uuid,uuid);

-- Return the minimal queue details required for a teacher to choose a private request.
-- Direct RLS access to payment references and full student profiles stays restricted.
create or replace function public.list_teacher_private_requests()
returns table(class_id uuid,class_title text,category text,level text,schedule text,instructor_id uuid,
  student_id uuid,student_name text,student_username text,student_phone text,payment_status text,
  registered_at timestamptz,selection_status text)
language plpgsql stable security definer set search_path=public,pg_temp
as $$
begin
  if public.abt_v19_current_role()<>'pengajar' then raise exception 'Hanya Pengajar yang dapat melihat permintaan kelas privat'; end if;
  return query
  select c.id,c.title,c.category,c.level,c.schedule,c.instructor_id,ce.student_id,
    coalesce(nullif(p.full_name,''),'Peserta'),p.username,p.phone,ce.payment_status,ce.created_at,s.status
  from public.classes c
  join public.class_enrollments ce on ce.class_id=c.id
  left join public.profiles p on p.id=ce.student_id
  left join public.teacher_private_selections s on s.class_id=ce.class_id and s.student_id=ce.student_id
  where c.status='published' and lower(coalesce(c.category,'')) like '%privat%'
    and (c.instructor_id is null or c.instructor_id=auth.uid())
    and ce.payment_status<>'ditolak'
    and (c.instructor_id=auth.uid() or s.status is distinct from 'aktif')
  order by ce.created_at desc;
end;
$$;
revoke all on function public.list_teacher_private_requests() from public;
grant execute on function public.list_teacher_private_requests() to authenticated;

-- Limit private class enrollment to five people even if requests race at the same time.
create or replace function public.abt_v21_guard_private_class_capacity()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_category text; v_capacity integer; v_existing integer; v_limit integer;
begin
  if new.payment_status='ditolak' then return new; end if;
  if tg_op='UPDATE' and new.class_id=old.class_id and new.payment_status=old.payment_status then return new; end if;
  select c.category,c.capacity into v_category,v_capacity
  from public.classes c where c.id=new.class_id for update;
  if not found or lower(coalesce(v_category,'')) not like '%privat%' then return new; end if;
  v_limit:=least(greatest(coalesce(v_capacity,5),1),5);
  select count(*)::integer into v_existing from public.class_enrollments ce
  where ce.class_id=new.class_id and ce.payment_status<>'ditolak' and ce.id is distinct from new.id;
  if v_existing>=v_limit then
    raise exception 'Kuota kelas privat penuh (maksimal % peserta).',v_limit;
  end if;
  return new;
end;
$$;
revoke all on function public.abt_v21_guard_private_class_capacity() from public;
drop trigger if exists abt_v21_private_class_capacity_insert on public.class_enrollments;
create trigger abt_v21_private_class_capacity_insert before insert on public.class_enrollments
  for each row execute function public.abt_v21_guard_private_class_capacity();
drop trigger if exists abt_v21_private_class_capacity_update on public.class_enrollments;
create trigger abt_v21_private_class_capacity_update before update of class_id,payment_status on public.class_enrollments
  for each row execute function public.abt_v21_guard_private_class_capacity();

-- Notify all eligible teachers when a learner requests a published private class.
create or replace function public.abt_v21_notify_private_class_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_class public.classes%rowtype; v_student_name text;
begin
  -- A registration is announced once at insert time. Admin payment reviews must not
  -- generate a duplicate request notification for every teacher.
  if tg_op='UPDATE' then return new; end if;
  if new.payment_status='ditolak' then return new; end if;
  select * into v_class from public.classes c where c.id=new.class_id;
  if not found or v_class.status<>'published' or lower(coalesce(v_class.category,'')) not like '%privat%' then return new; end if;
  if exists(select 1 from public.teacher_private_selections s where s.class_id=new.class_id and s.student_id=new.student_id and s.status='aktif') then return new; end if;
  select coalesce(nullif(p.full_name,''),nullif(p.username,''),'Peserta') into v_student_name
  from public.profiles p where p.id=new.student_id;
  insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
  select p.id,new.student_id,new.class_id,'Permintaan kelas privat baru',
    coalesce(v_student_name,'Peserta')||' mendaftar kelas privat '||v_class.title||'. Pengajar pertama yang mengambil permintaan akan menjadi pengajar kelas tersebut.','private_request'
  from public.profiles p
  where p.role='pengajar' and (v_class.instructor_id is null or p.id=v_class.instructor_id);
  return new;
end;
$$;
revoke all on function public.abt_v21_notify_private_class_request() from public;
drop trigger if exists abt_v21_private_request_insert_notice on public.class_enrollments;
create trigger abt_v21_private_request_insert_notice after insert on public.class_enrollments
  for each row execute function public.abt_v21_notify_private_class_request();
drop trigger if exists abt_v21_private_request_status_notice on public.class_enrollments;
create trigger abt_v21_private_request_status_notice after update of payment_status on public.class_enrollments
  for each row execute function public.abt_v21_notify_private_class_request();

-- The class row lock makes the first accepted participant claim the entire private group class.
-- Every later participant in that class can only be accepted by that same instructor.
create or replace function public.decide_private_enrollment(p_class_id uuid,p_student_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_class public.classes%rowtype; v_selection public.teacher_private_selections%rowtype;
        v_student_name text; v_teacher_name text; v_claimed boolean:=false; v_status text;
begin
  if public.abt_v19_current_role()<>'pengajar' then raise exception 'Hanya Pengajar yang dapat memilih peserta privat'; end if;
  select * into v_class from public.classes c where c.id=p_class_id for update;
  if not found or v_class.status<>'published' or lower(coalesce(v_class.category,'')) not like '%privat%' then
    raise exception 'Kelas privat tidak ditemukan atau tidak tersedia';
  end if;
  if v_class.instructor_id is not null and v_class.instructor_id<>auth.uid() then
    raise exception 'Kelas ini sudah diambil pengajar lain. Peserta akan belajar dengan pengajar yang mengambilnya lebih dahulu.';
  end if;
  if not exists(select 1 from public.class_enrollments ce where ce.class_id=p_class_id and ce.student_id=p_student_id and ce.payment_status<>'ditolak') then
    raise exception 'Permintaan peserta tidak ditemukan atau pendaftarannya ditolak';
  end if;
  select * into v_selection from public.teacher_private_selections s
  where s.class_id=p_class_id and s.student_id=p_student_id for update;
  if found and v_selection.status='aktif' then
    if v_selection.teacher_id=auth.uid() then
      return jsonb_build_object('success',true,'status','aktif','message','Peserta ini sudah menjadi peserta aktif Anda.');
    end if;
    raise exception 'Peserta ini sudah diambil pengajar lain.';
  end if;

  if not p_accept then
    insert into public.teacher_private_selections(class_id,student_id,teacher_id,status,decided_at,updated_at)
    values(p_class_id,p_student_id,auth.uid(),'ditolak',now(),now())
    on conflict(class_id,student_id) do update
      set teacher_id=excluded.teacher_id,status='ditolak',decided_at=now(),updated_at=now()
      where public.teacher_private_selections.status<>'aktif';
    return jsonb_build_object('success',true,'status','ditolak','message','Permintaan ini dilewati. Pengajar lain dapat mengambilnya selama kelas belum ditetapkan.');
  end if;

  v_claimed:=v_class.instructor_id is null;
  if v_claimed then
    update public.classes set instructor_id=auth.uid(),updated_at=now() where id=p_class_id and instructor_id is null;
    if not found then raise exception 'Pengajar lain mengambil kelas ini lebih dahulu. Segarkan halaman untuk melihat status terbaru.'; end if;
  end if;
  insert into public.teacher_private_selections(class_id,student_id,teacher_id,status,decided_at,updated_at)
  values(p_class_id,p_student_id,auth.uid(),'aktif',now(),now())
  on conflict(class_id,student_id) do update
    set teacher_id=excluded.teacher_id,status='aktif',decided_at=now(),updated_at=now()
    where public.teacher_private_selections.status<>'aktif'
  returning status into v_status;
  if v_status is null then raise exception 'Peserta sudah diambil pengajar lain.'; end if;

  select coalesce(nullif(p.full_name,''),nullif(p.username,''),'Peserta') into v_student_name from public.profiles p where p.id=p_student_id;
  select coalesce(nullif(p.full_name,''),nullif(p.username,''),'Pengajar') into v_teacher_name from public.profiles p where p.id=auth.uid();
  insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
  values(p_student_id,auth.uid(),p_class_id,'Pengajar privat telah ditetapkan',
    'Permintaan Anda untuk kelas '||v_class.title||' telah diambil oleh Pengajar '||v_teacher_name||'. Anda akan belajar dengan pengajar tersebut. Jadwal dan tautan kelas tersedia di menu Kelas Saya.','private_selection');
  if v_claimed then
    insert into public.abt_notifications(recipient_id,sender_id,class_id,title,body,source)
    select p.id,auth.uid(),p_class_id,'Kelas privat sudah diambil',
      'Kelas '||v_class.title||' telah diambil oleh Pengajar '||v_teacher_name||'. Permintaan peserta pada kelas ini selanjutnya ditangani oleh pengajar tersebut.','private_class_claimed'
    from public.profiles p where p.role='pengajar' and p.id<>auth.uid();
  end if;
  return jsonb_build_object('success',true,'status','aktif','claimed_class',v_claimed,
    'message',v_student_name||' berhasil diambil. Peserta sudah diberi tahu bahwa ia akan belajar dengan Anda.');
end;
$$;
revoke all on function public.decide_private_enrollment(uuid,uuid,boolean) from public;
grant execute on function public.decide_private_enrollment(uuid,uuid,boolean) to authenticated;

-- Approving a teacher report releases private invoices using the current active group size.
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
      select distinct s.class_id,
        least((select count(*) from public.teacher_private_selections ps where ps.class_id=s.class_id and ps.status='aktif'),5)::smallint as headcount
      from public.teacher_sessions s join public.classes c on c.id=s.class_id
      where s.teacher_id=v_report.teacher_id and s.status='completed'
        and s.session_date>=v_report.report_month and s.session_date<(v_report.report_month+interval '1 month')::date
        and lower(coalesce(c.category,'')) like '%privat%'
    ) needed
    where needed.headcount<1 or not exists(select 1 from public.private_class_rate_tiers t where t.participant_count=needed.headcount);
    if v_missing>0 then raise exception 'Tarif privat belum lengkap untuk % kelas. Lengkapi tabel Tarif Tagihan Peserta.',v_missing; end if;

    update public.teacher_monthly_reports set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),admin_note=nullif(btrim(p_admin_note),'') where id=p_report_id;
    insert into public.participant_invoices(report_id,student_id,class_id,billing_month,session_count,rate_per_session,amount_due,status,issued_by,billing_type,due_date,participant_count)
    select v_report.id,s.student_id,s.class_id,v_report.report_month,count(*)::integer,t.rate_per_participant,
      count(*)*t.rate_per_participant,'issued',auth.uid(),'private',null,headcount.participant_count
    from public.teacher_sessions s
    join public.classes c on c.id=s.class_id and lower(coalesce(c.category,'')) like '%privat%'
    join lateral (
      select least(count(*)::integer,5)::smallint as participant_count
      from public.teacher_private_selections ps where ps.class_id=s.class_id and ps.status='aktif'
    ) headcount on headcount.participant_count between 1 and 5
    join public.private_class_rate_tiers t on t.participant_count=headcount.participant_count
    where s.teacher_id=v_report.teacher_id and s.status='completed'
      and s.session_date>=v_report.report_month and s.session_date<(v_report.report_month+interval '1 month')::date
    group by s.student_id,s.class_id,t.rate_per_participant,headcount.participant_count
    on conflict(report_id,student_id,class_id) do nothing;
    get diagnostics v_created=row_count;
  else
    update public.teacher_monthly_reports set status='needs_correction',reviewed_by=auth.uid(),reviewed_at=now(),admin_note=nullif(btrim(p_admin_note),'') where id=p_report_id;
  end if;
  insert into public.abt_notifications(recipient_id,sender_id,title,body,source)
  values(v_report.teacher_id,auth.uid(),case when p_approve then 'Laporan honor disetujui' else 'Laporan honor perlu diperbaiki' end,
    case when p_approve then 'Laporan '||to_char(v_report.report_month,'Month YYYY')||' disetujui. Total honor: Rp '||to_char(v_report.total_amount,'FM999G999G999G990D00')||'. Tagihan privat peserta telah diterbitkan sesuai jumlah pertemuan.'
    else 'Laporan '||to_char(v_report.report_month,'Month YYYY')||' perlu diperbaiki. Catatan Admin: '||coalesce(nullif(btrim(p_admin_note),''),'Silakan periksa kembali data pertemuan.') end,'payroll_review');
  return jsonb_build_object('success',true,'status',case when p_approve then 'approved' else 'needs_correction' end,'private_invoices_created',v_created);
end;
$$;
revoke all on function public.review_teacher_monthly_report(uuid,boolean,text) from public;
grant execute on function public.review_teacher_monthly_report(uuid,boolean,text) to authenticated;

-- Flat monthly bills for verified participants in monthly Reguler classes.
create or replace function public.issue_regular_monthly_invoices(p_billing_month date default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_month date; v_created integer:=0;
begin
  if auth.uid() is not null and not public.abt_v20_is_admin() then raise exception 'Hanya Admin yang dapat menerbitkan tagihan reguler'; end if;
  v_month:=coalesce(p_billing_month,date_trunc('month',now() at time zone 'Asia/Jakarta')::date);
  if v_month<>date_trunc('month',v_month)::date then raise exception 'Periode tagihan harus tanggal pertama bulan tersebut'; end if;
  if v_month>date_trunc('month',now() at time zone 'Asia/Jakarta')::date then raise exception 'Tagihan untuk bulan mendatang belum dapat diterbitkan'; end if;
  insert into public.participant_invoices(report_id,student_id,class_id,billing_month,session_count,rate_per_session,amount_due,status,issued_by,billing_type,due_date,participant_count)
  select null,ce.student_id,c.id,v_month,0,0,ce.enrolled_price_amount,'issued',auth.uid(),'regular',(v_month+4),null
  from public.classes c join public.class_enrollments ce on ce.class_id=c.id
  where c.status='published' and lower(coalesce(c.category,''))='reguler'
    and c.payment_type='monthly' and ce.enrolled_price_amount>0
    and ce.payment_status='terverifikasi'
  on conflict(billing_month,student_id,class_id) where billing_type='regular' do nothing;
  get diagnostics v_created=row_count;
  return jsonb_build_object('success',true,'billing_month',v_month,'due_date',v_month+4,'invoices_created',v_created);
end;
$$;
revoke all on function public.issue_regular_monthly_invoices(date) from public;
grant execute on function public.issue_regular_monthly_invoices(date) to authenticated,service_role;

create or replace function public.abt_v21_cron_issue_regular_invoices()
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if extract(day from (now() at time zone 'Asia/Jakarta'))<>1 then
    return jsonb_build_object('success',true,'skipped',true,'reason','Belum tanggal pertama bulan ini');
  end if;
  return public.issue_regular_monthly_invoices(date_trunc('month',now() at time zone 'Asia/Jakarta')::date);
end;
$$;
revoke all on function public.abt_v21_cron_issue_regular_invoices() from public;

-- The trigger writes an in-app notice containing the due date (for regular bills).
create or replace function public.abt_v20_notify_invoice()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_message text; v_title text;
begin
  if new.billing_type='regular' then
    v_title:='Tagihan kelas reguler diterbitkan';
    v_message:='Invoice '||new.invoice_no||' untuk '||to_char(new.billing_month,'Month YYYY')||' sebesar Rp '||to_char(new.amount_due,'FM999G999G999G990D00')||' telah tersedia. Jatuh tempo '||to_char(new.due_date,'DD FMMonth YYYY')||'.';
  elsif new.billing_type='private' then
    v_title:='Tagihan kelas privat diterbitkan';
    v_message:='Invoice '||new.invoice_no||' untuk '||to_char(new.billing_month,'Month YYYY')||' sebesar Rp '||to_char(new.amount_due,'FM999G999G999G990D00')||' telah diterbitkan Admin setelah laporan pengajar ditinjau.';
  else
    v_title:='Tagihan bulanan diterbitkan';
    v_message:='Invoice '||new.invoice_no||' untuk '||to_char(new.billing_month,'Month YYYY')||' sebesar Rp '||to_char(new.amount_due,'FM999G999G999G990D00')||' telah tersedia di menu Tagihan.';
  end if;
  insert into public.abt_notifications(recipient_id,class_id,title,body,source)
  values(new.student_id,new.class_id,v_title,v_message,'invoice');
  return new;
end;
$$;
revoke all on function public.abt_v20_notify_invoice() from public;

-- Supabase Cron follows UTC. 17:05 UTC is 00:05 in Jakarta; the wrapper runs only on local day 1.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname='abt-v21-regular-monthly-billing';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
  perform cron.schedule('abt-v21-regular-monthly-billing','5 17 28-31 * *','select public.abt_v21_cron_issue_regular_invoices();');
end;
$$;

commit;

