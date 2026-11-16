/* ABT V21 cross-account workspace. Builds on the V18/V19/V20 schema and
   SQL_ABT_V21_PRIVAT_TAGIHAN.sql for group-private classes and billing. */
const ABT_V20_ACTIVE_ENROLLMENT = new Set(['terverifikasi', 'approved', 'active', 'aktif']);
let abtV20NotificationTimer = null;

function abtV20IsAdmin() { return ['admin', 'super_admin'].includes(currentRole); }
function abtV20Date(value, withTime = false) {
  if (!value) return 'Belum ditentukan';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Belum ditentukan' : d.toLocaleString('id-ID', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
function abtV20Money(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value) || 0);
}
function abtV20DateInput(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
function abtV20JakartaPreviousMonth() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const next = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 1));
  const start = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return { start, end };
}
function abtV21CurrentMonth() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}-01`;
}
function abtV20MonthLabel(month) {
  return new Date(`${month}T00:00:00`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}
function abtV20SafeUrl(raw) {
  try { const u = new URL(String(raw || '').trim()); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; }
  catch (_) { return ''; }
}
function abtV20PhoneUrl(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  return digits ? `https://wa.me/${digits}` : '';
}
function abtV20StatusLabel(value) {
  const labels = { menunggu_konfirmasi: 'Menunggu konfirmasi', terverifikasi: 'Terverifikasi', approved: 'Disetujui / aktif', active: 'Aktif', aktif: 'Aktif', ditolak: 'Ditolak', submitted: 'Menunggu tinjauan', needs_correction: 'Perlu perbaikan', issued: 'Belum dibayar', paid: 'Lunas', void: 'Dibatalkan', completed: 'Selesai', cancelled: 'Dibatalkan', no_show: 'Tidak hadir' };
  return labels[String(value || '').toLowerCase()] || String(value || 'Belum ditentukan').replaceAll('_', ' ');
}
function abtV20Alert(error, title = 'Data belum dapat dimuat') {
  return `<div class="app-alert"><strong>${safeText(title)}.</strong> ${safeText(error?.message || error || 'Periksa koneksi dan pastikan migrasi V20 sudah dijalankan.')}</div>`;
}
function abtV20SchemaNotice(error) {
  return `<div class="abt-v20-note"><strong>Integrasi V20 belum aktif.</strong><br>Jalankan <code>SQL_ABT_V20_INTEGRASI.sql</code> di Supabase setelah migrasi V19. Detail: ${safeText(error?.message || '')}</div>`;
}
async function abtV20GetTeacherClasses(includeOpenPrivate = false) {
  let query = supabaseClient.from('classes').select('id,title,category,level,status,schedule,instructor_id').order('title');
  query = includeOpenPrivate
    ? query.or(`instructor_id.eq.${currentUser.id},instructor_id.is.null`)
    : query.eq('instructor_id', currentUser.id);
  return await query;
}
async function abtV20GetClassMap(classIds) {
  if (!classIds?.length) return {};
  const { data } = await supabaseClient.from('classes').select('id,title,category,level,status,schedule,instructor_id').in('id', [...new Set(classIds)]);
  return Object.fromEntries((data || []).map(c => [c.id, c]));
}
async function abtV20GetProfiles(ids, fields = 'id,full_name,username,phone,contact_email,role') {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await supabaseClient.from('profiles').select(fields).in('id', unique);
  if (error) throw error;
  return Object.fromEntries((data || []).map(p => [p.id, p]));
}
async function abtV20StudentEnrollmentContext() {
  const { data: enrollments, error } = await supabaseClient.from('class_enrollments')
    .select('id,class_id,student_id,payment_status,created_at').eq('student_id', currentUser.id).order('created_at', { ascending: false });
  if (error) throw error;
  const rows = enrollments || [];
  const classMap = await abtV20GetClassMap(rows.map(e => e.class_id));
  const privateIds = rows.filter(e => String(classMap[e.class_id]?.category || '').toLowerCase().includes('privat')).map(e => e.class_id);
  let selections = {};
  if (privateIds.length) {
    const { data, error: selectionError } = await supabaseClient.from('teacher_private_selections').select('class_id,student_id,teacher_id,status')
      .eq('student_id', currentUser.id).in('class_id', [...new Set(privateIds)]);
    if (selectionError) throw selectionError;
    selections = Object.fromEntries((data || []).map(s => [s.class_id, s]));
  }
  const activeRows = rows.filter(e => {
    const isPrivate = String(classMap[e.class_id]?.category || '').toLowerCase().includes('privat');
    return isPrivate ? selections[e.class_id]?.status === 'aktif' : ABT_V20_ACTIVE_ENROLLMENT.has(String(e.payment_status || '').toLowerCase());
  });
  return { enrollments: rows, activeRows, classMap, selections };
}
async function loadStudentOverview() {
  let context;
  try { context = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20Alert(e); }
  const activeIds = [...new Set(context.activeRows.map(e => e.class_id))];
  const [{ count: unread }, { count: unpaid }, activityResult] = await Promise.all([
    supabaseClient.from('abt_notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', currentUser.id).is('read_at', null),
    supabaseClient.from('participant_invoices').select('id', { count: 'exact', head: true }).eq('student_id', currentUser.id).eq('status', 'issued'),
    activeIds.length ? supabaseClient.from('teacher_activities').select('id,class_id,title,starts_at').in('class_id', activeIds).gte('starts_at', new Date().toISOString()).order('starts_at').limit(3) : Promise.resolve({ data: [], error: null })
  ]);
  const stats = [['Kelas terdaftar', context.enrollments.length], ['Kelas aktif', context.activeRows.length], ['Jadwal mendatang', activityResult.error ? 'â€”' : (activityResult.data || []).length], ['Tagihan terbuka', unpaid ?? 'â€”'], ['Notifikasi baru', unread ?? 'â€”']];
  const cards = context.enrollments.slice(0, 4).map(e => {
    const c = context.classMap[e.class_id] || {};
    const isPrivate = String(c.category || '').toLowerCase().includes('privat');
    const active = isPrivate ? context.selections[e.class_id]?.status === 'aktif' : ABT_V20_ACTIVE_ENROLLMENT.has(String(e.payment_status || '').toLowerCase());
    return `<article class="panel-card abt-v20-class-card"><span class="status-pill">${safeText(c.category || 'Kelas')}</span><h3>${safeText(c.title || 'Kelas')}</h3><p>${safeText(c.schedule || 'Jadwal menyusul')}</p><span class="abt-v20-status ${active ? 'is-active' : ''}">${safeText(isPrivate ? active ? 'Aktif belajar' : 'Menunggu pilihan pengajar' : abtV20StatusLabel(e.payment_status))}</span></article>`;
  }).join('');
  const activityRows = (activityResult.data || []).map(a => `<tr><td>${safeText(a.title)}</td><td>${safeText(context.classMap[a.class_id]?.title || 'Kelas')}</td><td>${safeText(abtV20Date(a.starts_at, true))}</td></tr>`).join('');
  return `<section class="welcome-panel"><h2>Assalamu'alaikum, ${safeText(currentProfile?.full_name || currentUser.email || 'Peserta')}!</h2><p>Ringkasan kelas yang Anda ikuti, jadwal, tagihan, dan pemberitahuan terbaru.</p></section><div class="stats-grid">${stats.map(([label, value]) => `<article class="stat-card"><div class="stat-card-copy"><small>${safeText(label)}</small><strong>${safeText(value)}</strong><span class="stat-accent" aria-hidden="true"></span></div></article>`).join('')}</div><section class="panel-card"><div class="abt-v20-section-head"><div><h3>Kelas Saya</h3><p class="panel-subtitle">Hanya pendaftaran akun Anda yang ditampilkan.</p></div><a class="app-button secondary" href="${routePath('follow')}" data-page="follow">Ikuti kelas lain</a></div><div class="abt-v20-card-grid">${cards || '<div class="empty-state">Belum ada pendaftaran kelas.</div>'}</div></section><section class="panel-card"><h3>Jadwal Mendatang</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Kegiatan</th><th>Kelas</th><th>Waktu</th></tr></thead><tbody>${activityRows || '<tr><td colspan="3">Belum ada jadwal aktif.</td></tr>'}</tbody></table></div></section>`;
}
async function abtV20TeacherParticipants(classRows, onlyActive = false) {
  const ids = classRows.map(c => c.id);
  if (!ids.length) return { rows: [], profiles: {}, selections: {}, classMap: {} };
  const [{ data: enrollments, error }, { data: selections, error: selectionError }] = await Promise.all([
    supabaseClient.from('class_enrollments').select('id,class_id,student_id,payment_status,created_at').in('class_id', ids).order('created_at', { ascending: false }),
    supabaseClient.from('teacher_private_selections').select('class_id,student_id,teacher_id,status').in('class_id', ids)
  ]);
  if (error) throw error;
  if (selectionError) throw selectionError;
  const selectionMap = Object.fromEntries((selections || []).map(s => [`${s.class_id}:${s.student_id}`, s]));
  const classMap = Object.fromEntries(classRows.map(c => [c.id, c]));
  let rows = enrollments || [];
  if (onlyActive) rows = rows.filter(e => {
    const privateClass = String(classMap[e.class_id]?.category || '').toLowerCase().includes('privat');
    return privateClass ? selectionMap[`${e.class_id}:${e.student_id}`]?.status === 'aktif' : ABT_V20_ACTIVE_ENROLLMENT.has(String(e.payment_status || '').toLowerCase());
  });
  return { rows, profiles: await abtV20GetProfiles(rows.map(e => e.student_id)), selections: selectionMap, classMap };
}

async function loadStudentClasses() {
  let context;
  try { context = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20SchemaNotice(e); }
  const { enrollments, classMap, selections } = context;
  if (!enrollments.length) return `<section class="panel-card"><h3>Kelas Saya</h3><div class="empty-state">Anda belum mendaftar kelas. Buka menu <strong>Ikuti Kelas</strong> untuk melihat program yang tersedia.</div></section>`;
  const teacherMap = await abtV20GetProfiles(Object.values(classMap).map(c => c.instructor_id), 'id,full_name,username,phone,role').catch(() => ({}));
  const linkQuery = await supabaseClient.from('teacher_class_links').select('class_id,whatsapp_group_url,teacher_whatsapp,default_meeting_url').in('class_id', Object.keys(classMap));
  if (linkQuery.error) return abtV20SchemaNotice(linkQuery.error);
  const linkMap = Object.fromEntries((linkQuery.data || []).map(l => [l.class_id, l]));
  const cards = enrollments.map(e => {
    const c = classMap[e.class_id] || {};
    const isPrivate = String(c.category || '').toLowerCase().includes('privat');
    const choice = selections[e.class_id];
    const status = isPrivate ? (choice?.status === 'aktif' ? 'Aktif belajar' : choice?.status === 'ditolak' ? 'Belum diambil' : 'Menunggu pilihan pengajar') : abtV20StatusLabel(e.payment_status);
    const t = teacherMap[c.instructor_id] || {};
    const l = linkMap[e.class_id] || {};
    const groupUrl = abtV20SafeUrl(l.whatsapp_group_url);
    const meetingUrl = abtV20SafeUrl(l.default_meeting_url);
    const wa = abtV20PhoneUrl(l.teacher_whatsapp || t.phone);
    const active = isPrivate ? choice?.status === 'aktif' : ABT_V20_ACTIVE_ENROLLMENT.has(String(e.payment_status || '').toLowerCase());
    return `<article class="panel-card abt-v20-class-card"><div class="abt-v20-card-head"><div><span class="status-pill">${safeText(c.category || 'Kelas')}</span><h3>${safeText(c.title || 'Kelas')}</h3></div><span class="abt-v20-status ${active ? 'is-active' : ''}">${safeText(status)}</span></div><p class="panel-subtitle">${safeText(c.schedule || 'Jadwal akan diumumkan pengajar.')}</p><p>Pengajar: <strong>${safeText(t.full_name || t.username || 'Belum ditentukan')}</strong></p><div class="abt-v20-link-row">${groupUrl ? `<a class="app-button secondary" href="${safeText(groupUrl)}" target="_blank" rel="noopener noreferrer">Grup WhatsApp</a>` : ''}${wa ? `<a class="app-button secondary" href="${safeText(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp Pengajar</a>` : ''}${active && meetingUrl ? `<a class="app-button" href="${safeText(meetingUrl)}" target="_blank" rel="noopener noreferrer">Buka Meeting</a>` : ''}</div>${!groupUrl && !wa && !meetingUrl ? '<p class="abt-v20-muted">Informasi kontak dan meeting akan tampil setelah diisi pengajar.</p>' : ''}</article>`;
  }).join('');
  return `<section class="panel-card"><div class="abt-v20-section-head"><div><h3>Kelas Saya</h3><p class="panel-subtitle">Daftar ini hanya memuat pendaftaran akun Anda.</p></div><a class="app-button secondary" href="${routePath('follow')}" data-page="follow">Cari kelas</a></div><div class="abt-v20-card-grid">${cards}</div></section>`;
}

async function loadStudentFollowClasses() {
  let own;
  try { own = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20SchemaNotice(e); }
  const { data: classes, error } = await supabaseClient.from('classes').select('id,title,description,category,level,duration_text,payment_type,price_amount,thumbnail_url,schedule,status').eq('status', 'published').order('created_at', { ascending: false });
  if (error) return abtV20Alert(error, 'Kelas yang tersedia belum dapat dimuat');
  const registered = new Set(own.enrollments.map(e => e.class_id));
  const available = (classes || []).filter(c => !registered.has(c.id));
  if (!available.length) return `<section class="panel-card"><h3>Ikuti Kelas</h3><div class="empty-state">Semua kelas terbit sudah Anda daftarkan, atau belum ada kelas baru yang tersedia.</div></section>`;
  return `<section><section class="panel-card"><h3>Ikuti Kelas</h3><p class="panel-subtitle">Kelas privat menampilkan biaya pendaftaran satu kali. Tagihan pertemuan privat dihitung dari jumlah pertemuan dan jumlah peserta aktif, lalu diterbitkan Admin setelah laporan pengajar disetujui. Tarif bulanan kelas reguler bersifat tetap.</p></section><div class="abt-v20-card-grid">${available.map(c => { const isPrivate = String(c.category || '').toLowerCase().includes('privat'); return `<article class="panel-card abt-v20-class-card"><span class="status-pill">${safeText(c.category || 'Program')}</span><h3>${safeText(c.title)}</h3><p>${safeText(c.description || 'Program pembelajaran Ayo Belajar Tajwid.')}</p><div class="abt-v20-class-facts"><span>${safeText(c.level || 'Semua tingkat')}</span><span>${safeText(c.duration_text || c.schedule || 'Jadwal menyusul')}</span><strong>${safeText(formatRupiah(c.price_amount))}${isPrivate ? ' biaya pendaftaran' : c.payment_type === 'monthly' ? ' / bulan' : ''}</strong></div><button type="button" class="app-button" data-class-enroll="${safeText(c.id)}">Daftar kelas</button></article>`; }).join('')}</div></section>`;
}

async function loadStudentLearningMaterials() {
  let context;
  try { context = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20SchemaNotice(e); }
  const classIds = context.activeRows.map(e => e.class_id);
  if (!classIds.length) return `<section class="panel-card"><h3>Materi Belajar</h3><div class="empty-state">Materi akan terbuka setelah pendaftaran kelas aktif. Pendaftaran privat menunggu pilihan pengajar.</div></section>`;
  const [{ data: core, error: coreError }, { data: added, error: addedError }] = await Promise.all([
    supabaseClient.from('lessons').select('id,title,description,order_number,class_id').in('class_id', [...new Set(classIds)]).eq('is_published', true).order('order_number'),
    supabaseClient.from('teacher_materials').select('id,title,description,class_id,storage_path,external_url,created_at').in('class_id', [...new Set(classIds)]).order('created_at', { ascending: false })
  ]);
  if (coreError) return abtV20Alert(coreError, 'Materi inti belum dapat dimuat');
  if (addedError) return abtV20SchemaNotice(addedError);
  const map = context.classMap;
  const cards = [];
  for (const item of (added || [])) {
    let url = abtV20SafeUrl(item.external_url);
    if (!url && item.storage_path) url = await abtTeacherSignedUrl(ABT_TEACHER_MATERIAL_BUCKET, item.storage_path);
    cards.push(`<article class="panel-card abt-v20-record"><span class="status-pill">${safeText(map[item.class_id]?.title || 'Kelas')}</span><h3>${safeText(item.title)}</h3><p>${safeText(item.description || 'Materi tambahan dari pengajar.')}</p>${url ? `<a class="app-button secondary" href="${safeText(url)}" target="_blank" rel="noopener noreferrer">Buka materi</a>` : '<span class="abt-v20-muted">Tautan materi belum tersedia</span>'}</article>`);
  }
  for (const item of (core || [])) cards.push(`<article class="panel-card abt-v20-record"><span class="status-pill">${safeText(map[item.class_id]?.title || 'Kelas')} Â· Materi inti</span><h3>${safeText(item.title)}</h3><p>${safeText(item.description || '')}</p></article>`);
  return `<section class="panel-card"><h3>Materi Belajar</h3><p class="panel-subtitle">Materi hanya dimuat dari kelas aktif yang terdaftar pada akun Anda.</p><div class="abt-v20-card-grid">${cards.join('') || '<div class="empty-state">Belum ada materi yang diterbitkan untuk kelas aktif.</div>'}</div></section>`;
}

async function loadStudentSchedule() {
  let context;
  try { context = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20SchemaNotice(e); }
  if (!context.activeRows.length) return `<section class="panel-card"><h3>Jadwal & Pengingat</h3><div class="empty-state">Jadwal akan tersedia setelah kelas aktif.</div></section>`;
  await supabaseClient.rpc('process_due_class_reminders'); await refreshGlobalNotificationCount();
  const classIds = [...new Set(context.activeRows.map(e => e.class_id))];
  const [{ data: activities, error }, { data: reminders, error: reminderError }, { data: sessions, error: sessionError }] = await Promise.all([
    supabaseClient.from('teacher_activities').select('id,class_id,title,details,starts_at,ends_at,location,meeting_url').in('class_id', classIds).order('starts_at'),
    supabaseClient.from('participant_reminders').select('id,activity_id,minutes_before,reminder_at,sent_at').eq('student_id', currentUser.id),
    supabaseClient.from('teacher_sessions').select('activity_id,class_id,session_date,minutes,status,notes').eq('student_id', currentUser.id).order('session_date', { ascending: false }).limit(50)
  ]);
  if (error) return abtV20SchemaNotice(error);
  if (reminderError) return abtV20SchemaNotice(reminderError);
  if (sessionError) return abtV20SchemaNotice(sessionError);
  const reminderMap = Object.fromEntries((reminders || []).map(r => [r.activity_id, r]));
  const rows = (activities || []).map(a => {
    const r = reminderMap[a.id];
    const options = [['0', 'Tanpa pengingat'], ['15', '15 menit'], ['30', '30 menit'], ['60', '1 jam'], ['1440', '1 hari']].map(([val, label]) => `<option value="${val}" ${String(r?.minutes_before || 0) === val ? 'selected' : ''}>${label}</option>`).join('');
    const meeting = abtV20SafeUrl(a.meeting_url);
    return `<tr><td><strong>${safeText(a.title)}</strong><br><small>${safeText(a.details || '')}</small></td><td>${safeText(context.classMap[a.class_id]?.title || 'Kelas')}</td><td>${safeText(abtV20Date(a.starts_at, true))}</td><td>${meeting ? `<a href="${safeText(meeting)}" target="_blank" rel="noopener noreferrer">Buka meeting</a>` : safeText(a.location || 'Belum tersedia')}</td><td><form class="abt-v20-reminder-form" data-activity-id="${safeText(a.id)}"><select aria-label="Waktu pengingat">${options}</select><button class="app-button secondary" type="submit">Simpan</button></form>${r?.sent_at ? '<small>Pengingat sudah masuk ke notifikasi.</small>' : ''}</td></tr>`;
  }).join('');
  const sessionRows = (sessions || []).map(s => `<tr><td>${safeText(abtV20Date(s.session_date))}</td><td>${safeText(context.classMap[s.class_id]?.title || 'Kelas')}</td><td>${safeText(abtV20StatusLabel(s.status))}</td><td>${safeText(s.minutes)} menit</td><td>${safeText(s.notes || '')}</td></tr>`).join('');
  return `<section class="panel-card"><h3>Jadwal & Pengingat</h3><p class="panel-subtitle">Pengingat ditampilkan di pusat notifikasi saat Anda membuka aplikasi setelah waktu pengingat tiba.</p><div class="table-wrap"><table class="app-table"><thead><tr><th>Kegiatan</th><th>Kelas</th><th>Waktu</th><th>Tempat / Meeting</th><th>Pengingat</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Belum ada jadwal kelas mendatang.</td></tr>'}</tbody></table></div></section><section class="panel-card"><h3>Riwayat Pertemuan</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Tanggal</th><th>Kelas</th><th>Status</th><th>Durasi</th><th>Catatan pengajar</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="5">Belum ada pertemuan tercatat.</td></tr>'}</tbody></table></div></section>`;
}

async function loadStudentAssignments() {
  let context;
  try { context = await abtV20StudentEnrollmentContext(); } catch (e) { return abtV20SchemaNotice(e); }
  const ids = [...new Set(context.activeRows.map(e => e.class_id))];
  if (!ids.length) return `<section class="panel-card"><h3>Tugas & Latihan</h3><div class="empty-state">Tugas dan latihan tersedia setelah kelas aktif.</div></section>`;
  const { data: evaluations, error } = await supabaseClient.from('teacher_evaluations').select('id,class_id,kind,title,instructions,due_at,max_score').in('class_id', ids).eq('is_published', true).order('due_at');
  if (error) return abtV20SchemaNotice(error);
  const evals = evaluations || [];
  const evalIds = evals.map(e => e.id);
  const [submissionResult, resultResult] = evalIds.length ? await Promise.all([
    supabaseClient.from('teacher_evaluation_submissions').select('id,evaluation_id,response_text,response_url,submitted_at').eq('student_id', currentUser.id).in('evaluation_id', evalIds),
    supabaseClient.from('teacher_evaluation_results').select('evaluation_id,score,feedback,graded_at').eq('student_id', currentUser.id).in('evaluation_id', evalIds)
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (submissionResult.error) return abtV20SchemaNotice(submissionResult.error);
  if (resultResult.error) return abtV20SchemaNotice(resultResult.error);
  const submissions = Object.fromEntries((submissionResult.data || []).map(s => [s.evaluation_id, s]));
  const results = Object.fromEntries((resultResult.data || []).map(r => [r.evaluation_id, r]));
  return `<section class="abt-v20-card-grid">${evals.map(e => {
    const sub = submissions[e.id] || {};
    const grade = results[e.id];
    return `<article class="panel-card abt-v20-record"><span class="status-pill">${safeText(context.classMap[e.class_id]?.title || 'Kelas')} Â· ${safeText(e.kind)}</span><h3>${safeText(e.title)}</h3><p>${safeText(e.instructions || 'Tidak ada instruksi tambahan.')}</p><p class="abt-v20-muted">Tenggat: ${safeText(abtV20Date(e.due_at, true))} Â· Nilai maksimum ${safeText(e.max_score)}</p>${grade ? `<div class="abt-v20-grade"><strong>Nilai ${safeText(grade.score)}</strong><p>${safeText(grade.feedback || 'Belum ada umpan balik.')}</p></div>` : ''}<form class="abt-v20-submission-form" data-evaluation-id="${safeText(e.id)}"><label>Jawaban teks<textarea maxlength="5000" rows="3" name="response_text" placeholder="Tulis jawaban atau catatan">${safeText(sub.response_text || '')}</textarea></label><label>Tautan jawaban (opsional)<input name="response_url" type="url" maxlength="1000" value="${safeText(sub.response_url || '')}" placeholder="https://..."></label><button class="app-button" type="submit">${sub.id ? 'Perbarui Jawaban' : 'Kirim Jawaban'}</button><span class="abt-v20-feedback" role="status"></span></form></article>`;
  }).join('') || '<section class="panel-card empty-state">Belum ada tugas atau latihan yang diterbitkan.</section>'}</section>`;
}

async function loadStudentInvoices() {
  const { data, error } = await supabaseClient.from('participant_invoices').select('id,invoice_no,report_id,class_id,billing_month,session_count,rate_per_session,amount_due,status,billing_type,due_date,participant_count,issued_at,paid_at,admin_note').eq('student_id', currentUser.id).order('billing_month', { ascending: false });
  if (error) return abtV20SchemaNotice(error);
  const invoices = data || [];
  const classMap = await abtV20GetClassMap(invoices.map(i => i.class_id));
  window.abtV20Invoices = Object.fromEntries(invoices.map(i => [i.id, i]));
  window.abtV20InvoiceClassMap = classMap;
  return `<section class="panel-card"><h3>Tagihan</h3><p class="panel-subtitle">Tagihan reguler memakai biaya yang tercatat saat Anda mendaftar, terbit otomatis setiap awal bulan, dan jatuh tempo tanggal 5. Tagihan privat terbit setelah Admin menyetujui laporan pertemuan pengajar.</p><div class="abt-v20-card-grid">${invoices.map(i => { const kind = i.billing_type || 'legacy'; const detail = kind === 'regular' ? `Biaya tetap bulanan Â· jatuh tempo ${i.due_date ? safeText(abtV20Date(i.due_date)) : 'tanggal 5'}` : kind === 'private' ? `${safeText(i.session_count)} pertemuan Ã— ${safeText(abtV20Money(i.rate_per_session))} per peserta${i.participant_count ? ` Â· tarif untuk ${safeText(i.participant_count)} peserta aktif` : ''}` : `${safeText(i.session_count)} pertemuan Ã— ${safeText(abtV20Money(i.rate_per_session))}`; return `<article class="panel-card abt-v20-invoice-card"><div class="abt-v20-card-head"><div><span class="status-pill">${safeText(i.invoice_no)} Â· ${safeText(kind === 'regular' ? 'Reguler' : kind === 'private' ? 'Privat' : 'Tagihan lama')}</span><h3>${safeText(classMap[i.class_id]?.title || 'Kelas')}</h3></div><span class="abt-v20-status ${i.status === 'paid' ? 'is-active' : ''}">${safeText(abtV20StatusLabel(i.status))}</span></div><p>${safeText(abtV20MonthLabel(i.billing_month))}</p><div class="abt-v20-invoice-total">${safeText(abtV20Money(i.amount_due))}</div><p>${detail}</p>${i.admin_note ? `<p class="abt-v20-muted">Catatan Admin: ${safeText(i.admin_note)}</p>` : ''}<button class="app-button secondary" type="button" data-print-invoice="${safeText(i.id)}">Cetak invoice</button></article>`; }).join('') || '<div class="empty-state">Belum ada tagihan.</div>'}</div></section>`;
}
function abtV20PrintInvoice(id) {
  const i = window.abtV20Invoices?.[id]; if (!i) return;
  const className = window.abtV20InvoiceClassMap?.[i.class_id]?.title || 'Kelas';
  const kind = i.billing_type || 'legacy';
  const rows = kind === 'regular'
    ? `<div class="row"><span>Jenis</span><strong>Tagihan flat bulanan</strong></div><div class="row"><span>Jatuh tempo</span><strong>${safeText(i.due_date ? abtV20Date(i.due_date) : 'Tanggal 5')}</strong></div>`
    : `<div class="row"><span>Jumlah pertemuan</span><strong>${safeText(i.session_count)}</strong></div><div class="row"><span>Tarif / peserta / pertemuan</span><strong>${safeText(abtV20Money(i.rate_per_session))}</strong></div>${i.participant_count ? `<div class="row"><span>Jumlah peserta aktif</span><strong>${safeText(i.participant_count)}</strong></div>` : ''}`;
  const body = `<!doctype html><html lang="id"><meta charset="utf-8"><title>Invoice ${safeText(i.invoice_no)}</title><style>body{font:16px Arial,sans-serif;max-width:720px;margin:40px auto;color:#153b45}h1{color:#087f9b}.box{border:1px solid #d7e5e8;border-radius:12px;padding:24px}.row{display:flex;justify-content:space-between;gap:15px;padding:12px 0;border-bottom:1px solid #edf2f3}.total{font-size:24px;font-weight:700;margin-top:18px}@media print{button{display:none}}</style><body><div class="box"><h1>Ayo Belajar Tajwid</h1><h2>Invoice ${safeText(i.invoice_no)}</h2><div class="row"><span>Peserta</span><strong>${safeText(currentProfile?.full_name || currentProfile?.username || 'Peserta')}</strong></div><div class="row"><span>Kelas</span><strong>${safeText(className)}</strong></div><div class="row"><span>Bulan tagihan</span><strong>${safeText(abtV20MonthLabel(i.billing_month))}</strong></div>${rows}<div class="total">Total: ${safeText(abtV20Money(i.amount_due))}</div><p>Status: ${safeText(abtV20StatusLabel(i.status))}</p><p>Terbit: ${safeText(abtV20Date(i.issued_at))}</p><button onclick="window.print()">Cetak</button></div></body></html>`;
  const win = window.open('', '_blank');
  if (!win) { alert('Izinkan jendela baru untuk mencetak invoice.'); return; }
  win.opener = null;
  win.document.open(); win.document.write(body); win.document.close();
}

async function loadTeacherPrivateRequests() {
  const { data, error } = await supabaseClient.rpc('list_teacher_private_requests');
  if (error) return abtV20Alert(error, 'Permintaan kelas privat belum dapat dimuat. Pastikan SQL V21 sudah diterapkan.');
  const rows = (data || []).map(e => {
    const s = e.selection_status;
    const state = s === 'aktif' ? 'Aktif belajar' : s === 'ditolak' ? 'Pernah dilewati Â· masih terbuka' : 'Menunggu keputusan';
    const actions = s === 'aktif' ? '<span class="abt-v20-muted">Peserta aktif</span>' : `<div class="abt-v20-inline-actions"><button class="app-button" type="button" data-private-choice="accept" data-class-id="${safeText(e.class_id)}" data-student-id="${safeText(e.student_id)}">Ambil peserta</button><button class="app-button secondary" type="button" data-private-choice="decline" data-class-id="${safeText(e.class_id)}" data-student-id="${safeText(e.student_id)}">Lewati</button></div>`;
    return `<tr><td><strong>${safeText(e.student_name || e.student_username || 'Peserta')}</strong><br><small>${safeText(e.student_phone || '')}</small></td><td>${safeText(e.class_title || 'Kelas')}</td><td>${safeText(abtV20StatusLabel(e.payment_status))}</td><td><span class="abt-v20-status ${s === 'aktif' ? 'is-active' : ''}">${safeText(state)}</span></td><td>${safeText(abtV20Date(e.registered_at))}</td><td>${actions}</td></tr>`;
  }).join('');
  return `<section class="panel-card"><h3>Permintaan Kelas Privat</h3><p class="panel-subtitle">Kelas privat berkelompok diambil oleh satu pengajar. Pengajar pertama yang menerima peserta menjadi penanggung jawab kelas; peserta yang dipilih menerima pesan konfirmasi dan hanya belajar dengan pengajar tersebut.</p><div class="table-wrap"><table class="app-table"><thead><tr><th>Peserta</th><th>Kelas privat</th><th>Status pendaftaran</th><th>Status seleksi</th><th>Tanggal daftar</th><th>Aksi</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Belum ada permintaan yang menunggu keputusan.</td></tr>'}</tbody></table></div></section>`;
}

async function loadTeacherClassLinks() {
  const { data: classes, error } = await abtV20GetTeacherClasses();
  if (error) return abtV20Alert(error);
  if (!classes?.length) return `<section class="panel-card"><h3>Akses & Kontak Kelas</h3><div class="empty-state">Tautan dapat diatur setelah kelas ditugaskan kepada Anda.</div></section>`;
  const { data: links, error: linkError } = await supabaseClient.from('teacher_class_links').select('class_id,whatsapp_group_url,teacher_whatsapp,default_meeting_url').in('class_id', classes.map(c => c.id));
  if (linkError) return abtV20SchemaNotice(linkError);
  const map = Object.fromEntries((links || []).map(l => [l.class_id, l]));
  return `<div class="abt-v20-card-grid">${classes.map(c => { const l = map[c.id] || {}; return `<form class="panel-card abt-v20-link-form" data-class-id="${safeText(c.id)}"><h3>${safeText(c.title)}</h3><label>Link grup WhatsApp<input name="whatsapp_group_url" type="url" maxlength="1000" value="${safeText(l.whatsapp_group_url || '')}" placeholder="https://chat.whatsapp.com/..."></label><label>Nomor WhatsApp pengajar<input name="teacher_whatsapp" type="tel" maxlength="30" value="${safeText(l.teacher_whatsapp || currentProfile?.phone || '')}" placeholder="62812..."></label><label>Link meeting default<input name="default_meeting_url" type="url" maxlength="1000" value="${safeText(l.default_meeting_url || '')}" placeholder="https://..."></label><button class="app-button" type="submit">Simpan akses kelas</button><span class="abt-v20-feedback" role="status"></span></form>`; }).join('')}</div>`;
}

async function loadTeacherSessions() {
  const { data: classes, error } = await abtV20GetTeacherClasses();
  if (error) return abtV20Alert(error);
  if (!classes?.length) return `<section class="panel-card"><h3>Catatan Pertemuan</h3><div class="empty-state">Belum ada kelas yang ditugaskan.</div></section>`;
  let context;
  try { context = await abtV20TeacherParticipants(classes, true); } catch (e) { return abtV20SchemaNotice(e); }
  const [{ data: activities, error: activityError }, { data: sessions, error: sessionError }] = await Promise.all([
    supabaseClient.from('teacher_activities').select('id,class_id,title,starts_at').in('class_id', classes.map(c => c.id)).order('starts_at', { ascending: false }),
    supabaseClient.from('teacher_sessions').select('id,activity_id,class_id,student_id,session_date,minutes,status,notes').eq('teacher_id', currentUser.id).order('session_date', { ascending: false }).limit(100)
  ]);
  if (activityError) return abtV20SchemaNotice(activityError);
  if (sessionError) return abtV20SchemaNotice(sessionError);
  const activeParticipants = context.rows;
  const activitiesIn = activities || [];
  const options = (items, placeholder, valueKey, label) => `<option value="">${placeholder}</option>${items.map(x => `<option value="${safeText(x[valueKey])}" data-class-id="${safeText(x.class_id)}">${safeText(label(x))}</option>`).join('')}`;
  const students = activeParticipants.map(e => ({ ...e, name: context.profiles[e.student_id]?.full_name || context.profiles[e.student_id]?.username || 'Peserta', class_name: context.classMap[e.class_id]?.title || 'Kelas' }));
  const activityOptions = options(activitiesIn, 'Pilih aktivitas', 'id', a => `${a.title} Â· ${context.classMap[a.class_id]?.title || 'Kelas'}`);
  const studentOptions = options(students, 'Pilih peserta aktif', 'student_id', s => `${s.name} Â· ${s.class_name}`);
  const sessionRows = (sessions || []).map(s => `<tr><td>${safeText(abtV20Date(s.session_date))}</td><td>${safeText(context.classMap[s.class_id]?.title || 'Kelas')}</td><td>${safeText(context.profiles[s.student_id]?.full_name || 'Peserta')}</td><td>${safeText(abtV20StatusLabel(s.status))}</td><td>${safeText(s.minutes)} menit</td><td>${safeText(s.notes || '')}</td></tr>`).join('');
  return `<section class="panel-card"><h3>Catat Pertemuan Peserta</h3><p class="panel-subtitle">Hanya peserta aktif di kelas Anda yang bisa dicatat. Laporan honor menghitung pertemuan berstatus Selesai.</p><form id="abtV20SessionForm" class="abt-v20-form-grid"><label>Kelas<select name="class_id" required>${options(classes, 'Pilih kelas', 'id', c => c.title)}</select></label><label>Aktivitas / jadwal<select name="activity_id" required>${activityOptions}</select></label><label>Peserta<select name="student_id" required>${studentOptions}</select></label><label>Tanggal pertemuan<input name="session_date" type="date" value="${abtV20DateInput()}" required></label><label>Durasi (menit)<input name="minutes" type="number" min="1" max="1440" value="60" required></label><label>Status<select name="status"><option value="completed">Selesai</option><option value="cancelled">Dibatalkan</option><option value="no_show">Tidak hadir</option></select></label><label class="abt-v20-span-all">Catatan<textarea name="notes" maxlength="1000" rows="2"></textarea></label><button class="app-button" type="submit">Simpan pertemuan</button><span class="abt-v20-feedback" role="status"></span></form></section><section class="panel-card"><h3>Riwayat Pertemuan</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Tanggal</th><th>Kelas</th><th>Peserta</th><th>Status</th><th>Durasi</th><th>Catatan</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="6">Belum ada pertemuan yang dicatat.</td></tr>'}</tbody></table></div></section>`;
}

async function loadTeacherPayroll() {
  const { data: rate, error: rateError } = await supabaseClient.from('teacher_session_rates').select('rate_per_session,updated_at').eq('teacher_id', currentUser.id).maybeSingle();
  if (rateError) return abtV20SchemaNotice(rateError);
  const { start: month, end: nextMonthStart } = abtV20JakartaPreviousMonth();
  const [{ data: report, error: reportError }, { data: sessions, error: sessionError }] = await Promise.all([
    supabaseClient.from('teacher_monthly_reports').select('*').eq('teacher_id', currentUser.id).eq('report_month', month).maybeSingle(),
    supabaseClient.from('teacher_sessions').select('id,session_date,status,student_id,class_id').eq('teacher_id', currentUser.id).eq('status', 'completed').gte('session_date', month).lt('session_date', nextMonthStart)
  ]);
  if (reportError) return abtV20SchemaNotice(reportError);
  if (sessionError) return abtV20SchemaNotice(sessionError);
  const count = (sessions || []).length;
  const reportCount = report?.status === 'needs_correction' ? count : (report?.session_count ?? count);
  const total = count * Number(rate?.rate_per_session || 0);
  const locked = ['submitted', 'approved'].includes(report?.status);
  return `<section class="panel-card"><div class="abt-v20-section-head"><div><h3>Laporan Honor</h3><p class="panel-subtitle">Laporan dibuat untuk bulan sebelumnya dan dikirim ke Admin untuk ditinjau.</p></div><span class="abt-v20-status ${report?.status === 'approved' ? 'is-active' : ''}">${safeText(report ? abtV20StatusLabel(report.status) : 'Belum dikirim')}</span></div><div class="abt-v20-payroll-summary"><div><small>Periode</small><strong>${safeText(abtV20MonthLabel(month))}</strong></div><div><small>Pertemuan selesai</small><strong>${safeText(reportCount)}</strong></div><div><small>Tarif / pertemuan</small><strong>${safeText(abtV20Money(report?.status === 'needs_correction' ? rate?.rate_per_session : report?.rate_per_session ?? rate?.rate_per_session ?? 0))}</strong></div><div><small>Perkiraan honor</small><strong>${safeText(abtV20Money(report?.status === 'needs_correction' ? total : report?.total_amount ?? total))}</strong></div></div>${rate ? `<p class="abt-v20-muted">Tarif ditetapkan Admin${rate.updated_at ? ` Â· diperbarui ${safeText(abtV20Date(rate.updated_at))}` : ''}.</p>` : '<div class="abt-v20-note">Tarif per pertemuan belum ditetapkan Admin. Laporan belum dapat dikirim.</div>'}${report?.admin_note ? `<div class="abt-v20-note">Catatan Admin: ${safeText(report.admin_note)}</div>` : ''}<button type="button" class="app-button" id="abtV20SubmitPayroll" ${!rate || locked ? 'disabled' : ''}>${report?.status === 'needs_correction' ? 'Kirim ulang laporan' : 'Kirim laporan bulan sebelumnya'}</button><span id="abtV20PayrollFeedback" class="abt-v20-feedback" role="status"></span><p class="abt-v20-muted">Pengiriman dilakukan saat tombol ini ditekan. Sistem tidak mengirim laporan otomatis di latar belakang.</p></section>`;
}

async function loadAdminFinance() {
  if (!abtV20IsAdmin()) return `<div class="app-alert">Anda tidak memiliki akses ke halaman ini.</div>`;
  const [{ data: teachers, error: teacherError }, { data: classes, error: classError }, { data: reports, error: reportError }, { data: invoices, error: invoiceError }, { data: privateTiers, error: tierError }, { data: teacherRates, error: trError }] = await Promise.all([
    supabaseClient.from('profiles').select('id,full_name,username').eq('role', 'pengajar').order('full_name'),
    supabaseClient.from('classes').select('id,title,category,instructor_id,payment_type,price_amount,status').order('title'),
    supabaseClient.from('teacher_monthly_reports').select('*').order('report_month', { ascending: false }).limit(100),
    supabaseClient.from('participant_invoices').select('*').order('billing_month', { ascending: false }).limit(100),
    supabaseClient.from('private_class_rate_tiers').select('participant_count,rate_per_participant,updated_at').order('participant_count'),
    supabaseClient.from('teacher_session_rates').select('teacher_id,rate_per_session,updated_at')
  ]);
  if (teacherError || classError || reportError || invoiceError || tierError || trError) return abtV20SchemaNotice(teacherError || classError || reportError || invoiceError || tierError || trError);
  const teacherRateMap = Object.fromEntries((teacherRates || []).map(x => [x.teacher_id, x.rate_per_session]));
  const profileMap = await abtV20GetProfiles([...(reports || []).map(r => r.teacher_id), ...(invoices || []).map(i => i.student_id)], 'id,full_name,username').catch(() => ({}));
  const classMap = Object.fromEntries((classes || []).map(c => [c.id, c]));
  const regularClasses = (classes || []).filter(c => String(c.category || '').toLowerCase() === 'reguler' && c.payment_type === 'monthly');
  const reportRows = (reports || []).map(r => `<tr><td>${safeText(profileMap[r.teacher_id]?.full_name || profileMap[r.teacher_id]?.username || 'Pengajar')}</td><td>${safeText(abtV20MonthLabel(r.report_month))}</td><td>${safeText(r.session_count)}</td><td>${safeText(abtV20Money(r.rate_per_session))}</td><td><strong>${safeText(abtV20Money(r.total_amount))}</strong></td><td><span class="abt-v20-status ${r.status === 'approved' ? 'is-active' : ''}">${safeText(abtV20StatusLabel(r.status))}</span>${r.admin_note ? `<br><small>${safeText(r.admin_note)}</small>` : ''}</td><td>${r.status === 'submitted' ? `<div class="abt-v20-inline-actions"><button class="app-button" type="button" data-v20-review="approve" data-report-id="${safeText(r.id)}">Setujui & terbitkan tagihan privat</button><button class="app-button secondary" type="button" data-v20-review="return" data-report-id="${safeText(r.id)}">Minta perbaikan</button></div>` : ''}</td></tr>`).join('');
  const invoiceRows = (invoices || []).map(i => { const kind = i.billing_type || 'legacy'; return `<tr><td>${safeText(i.invoice_no)}</td><td>${safeText(kind === 'regular' ? 'Reguler' : kind === 'private' ? 'Privat' : 'Lama')}</td><td>${safeText(profileMap[i.student_id]?.full_name || 'Peserta')}</td><td>${safeText(classMap[i.class_id]?.title || 'Kelas')}</td><td>${safeText(abtV20MonthLabel(i.billing_month))}</td><td>${i.due_date ? safeText(abtV20Date(i.due_date)) : 'â€”'}</td><td>${safeText(abtV20Money(i.amount_due))}</td><td><span class="abt-v20-status ${i.status === 'paid' ? 'is-active' : ''}">${safeText(abtV20StatusLabel(i.status))}</span></td><td>${i.status === 'void' ? '' : `<button class="app-button secondary" type="button" data-v20-invoice-status="${i.status === 'paid' ? 'issued' : 'paid'}" data-invoice-id="${safeText(i.id)}">${i.status === 'paid' ? 'Tandai belum dibayar' : 'Tandai lunas'}</button>`}</td></tr>`; }).join('');
  const tierRows = (privateTiers || []).map(t => `<tr><td>${safeText(t.participant_count)} peserta</td><td><form class="abt-v20-rate-form abt-v21-inline-rate" data-kind="private-tier" data-id="${safeText(t.participant_count)}"><span class="abt-v20-input-money"><span>Rp</span><input name="rate" type="number" min="0" step="500" required value="${safeText(t.rate_per_participant)}" aria-label="Tarif per peserta untuk ${safeText(t.participant_count)} orang"></span><button class="app-button secondary" type="submit">Simpan</button><span class="abt-v20-feedback" role="status"></span></form></td><td>${safeText(abtV20Money(Number(t.rate_per_participant) * Number(t.participant_count)))}</td></tr>`).join('');
  return `<section class="panel-card"><h3>Tarif Honor Pengajar</h3><p class="panel-subtitle">Tarif ini digunakan menghitung honor pengajar. Perubahan berlaku untuk laporan berikutnya.</p><div class="abt-v20-rate-grid">${(teachers || []).map(t => `<form class="abt-v20-rate-form" data-kind="teacher" data-id="${safeText(t.id)}"><label>${safeText(t.full_name || t.username || 'Pengajar')}<span class="abt-v20-input-money"><span>Rp</span><input name="rate" type="number" min="0" step="500" required value="${safeText(teacherRateMap[t.id] ?? '')}" placeholder="Tarif / pertemuan"></span></label><button class="app-button secondary" type="submit">Simpan tarif</button><span class="abt-v20-feedback" role="status"></span></form>`).join('') || '<div class="empty-state">Belum ada akun pengajar.</div>'}</div></section>
  <section class="panel-card"><h3>Tarif Tagihan Peserta</h3><p class="panel-subtitle">Reguler: biaya per bulan dibekukan saat peserta mendaftar. Tagihan terbit otomatis setiap tanggal 1 dan jatuh tempo tanggal 5. Privat: tagihan menunggu persetujuan laporan pengajar; tarif per peserta per pertemuan mengikuti jumlah peserta aktif pada kelas.</p><h4>Biaya tetap kelas reguler</h4><div class="abt-v20-rate-grid">${regularClasses.map(c => `<form class="abt-v20-rate-form" data-kind="regular" data-id="${safeText(c.id)}"><label>${safeText(c.title)}<span class="abt-v20-input-money"><span>Rp</span><input name="rate" type="number" min="0" step="1000" required value="${safeText(c.price_amount ?? '')}" aria-label="Tagihan bulanan ${safeText(c.title)}"></span></label><button class="app-button secondary" type="submit">Simpan biaya</button><span class="abt-v20-feedback" role="status"></span></form>`).join('') || '<div class="empty-state">Belum ada kelas reguler dengan skema bulanan.</div>'}</div><h4 style="margin-top:20px">Tarif privat per peserta per pertemuan (60 menit)</h4><div class="table-wrap"><table class="app-table"><thead><tr><th>Jumlah peserta aktif</th><th>Biaya per peserta</th><th>Total kelas / pertemuan</th></tr></thead><tbody>${tierRows || '<tr><td colspan="3">Tarif belum tersedia. Jalankan SQL V21.</td></tr>'}</tbody></table></div><p class="abt-v20-muted">Biaya pendaftaran privat disetel pada detail kelas (awal Rp50.000). Nilai tagihan yang sudah terbit menyimpan snapshot tarifnya.</p><div class="abt-v20-inline-actions"><button type="button" class="app-button" id="abtV21IssueRegularInvoices">Terbitkan tagihan reguler bulan ini</button><span id="abtV21RegularInvoiceFeedback" class="abt-v20-feedback" role="status"></span></div></section>
  <section class="panel-card"><h3>Laporan Honor Masuk</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Pengajar</th><th>Periode</th><th>Pertemuan</th><th>Tarif</th><th>Total honor</th><th>Status</th><th>Tindakan</th></tr></thead><tbody>${reportRows || '<tr><td colspan="7">Belum ada laporan.</td></tr>'}</tbody></table></div></section>
  <section class="panel-card"><h3>Invoice Peserta</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Invoice</th><th>Jenis</th><th>Peserta</th><th>Kelas</th><th>Bulan</th><th>Jatuh tempo</th><th>Tagihan</th><th>Status</th><th>Tindakan</th></tr></thead><tbody>${invoiceRows || '<tr><td colspan="9">Belum ada tagihan terbit.</td></tr>'}</tbody></table></div></section>`;
}

async function loadIntegratedNotifications() {
  if (currentRole === 'peserta') { await supabaseClient.rpc('process_due_class_reminders'); await refreshGlobalNotificationCount(); }
  const { data, error } = await supabaseClient.from('abt_notifications').select('id,class_id,sender_id,title,body,source,read_at,created_at').eq('recipient_id', currentUser.id).order('created_at', { ascending: false }).limit(100);
  if (error) return abtV20SchemaNotice(error);
  const notifications = data || [];
  const classMap = await abtV20GetClassMap(notifications.map(n => n.class_id));
  let compose = '';
  if (currentRole === 'pengajar') {
    const { data: classes } = await abtV20GetTeacherClasses();
    compose = `<form id="abtV20AnnouncementForm" class="panel-card abt-v20-announcement-form"><h3>Kirim Notifikasi Kelas</h3><label>Kelas<select name="class_id" required>${(classes || []).map(c => `<option value="${safeText(c.id)}">${safeText(c.title)}</option>`).join('')}</select></label><label>Judul<input name="title" maxlength="160" required></label><label>Pesan<textarea name="body" maxlength="3000" rows="3" required></textarea></label><button class="app-button" type="submit">Kirim ke peserta aktif</button><span class="abt-v20-feedback" role="status"></span></form>`;
  } else if (abtV20IsAdmin()) {
    const { data: classes } = await supabaseClient.from('classes').select('id,title').order('title');
    compose = `<form id="abtV20AnnouncementForm" class="panel-card abt-v20-announcement-form"><h3>Terbitkan Notifikasi</h3><label>Sasaran<select name="audience"><option value="all">Semua akun</option><option value="pengajar">Pengajar</option><option value="peserta">Peserta</option><option value="kelas">Peserta pada kelas tertentu</option></select></label><label>Kelas<select name="class_id"><option value="">Pilih kelas jika sasaran kelas</option>${(classes || []).map(c => `<option value="${safeText(c.id)}">${safeText(c.title)}</option>`).join('')}</select></label><label>Judul<input name="title" maxlength="160" required></label><label>Pesan<textarea name="body" maxlength="3000" rows="3" required></textarea></label><button class="app-button" type="submit">Terbitkan</button><span class="abt-v20-feedback" role="status"></span></form>`;
  }
  const rows = notifications.map(n => `<article class="abt-v20-notification ${n.read_at ? '' : 'is-unread'}"><div class="abt-v20-notification-meta"><span class="status-pill">${safeText(classMap[n.class_id]?.title || (n.source === 'announcement' ? 'Pengumuman Admin' : 'Pemberitahuan'))}</span><time>${safeText(abtV20Date(n.created_at, true))}</time></div><h3>${safeText(n.title)}</h3><p>${safeText(n.body || '')}</p>${n.read_at ? '<span class="abt-v20-muted">Sudah dibaca</span>' : `<button class="app-button secondary" type="button" data-v20-read-notification="${safeText(n.id)}">Tandai dibaca</button>`}</article>`).join('');
  return `${compose}<section class="panel-card"><div class="abt-v20-section-head"><div><h3>Pusat Notifikasi</h3><p class="panel-subtitle">Pengumuman, perubahan kelas, tugas, pengingat, laporan honor, dan invoice.</p></div><span class="abt-v20-status">${notifications.filter(n => !n.read_at).length} belum dibaca</span></div><div class="abt-v20-notification-list">${rows || '<div class="empty-state">Belum ada notifikasi.</div>'}</div></section>`;
}

async function refreshGlobalNotificationCount() {
  const badge = document.getElementById('globalNotificationCount');
  if (!badge || !currentUser) return;
  const { count, error } = await supabaseClient.from('abt_notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', currentUser.id).is('read_at', null);
  if (error) { badge.hidden = true; return; }
  badge.textContent = count > 99 ? '99+' : String(count || 0);
  badge.hidden = !count;
  if (!abtV20NotificationTimer) abtV20NotificationTimer = window.setInterval(() => { if (currentUser) refreshGlobalNotificationCount(); }, 45000);
}

async function refreshTopbarAvatar() {
  const avatar = document.getElementById('userAvatar');
  if (!avatar || !currentUser) return;
  avatar.textContent = (currentProfile?.full_name || currentProfile?.username || 'A').trim().charAt(0).toUpperCase();
  const { data, error } = await supabaseClient.from('teacher_profile_photos').select('storage_path').eq('profile_id', currentUser.id).maybeSingle();
  if (error || !data?.storage_path) return;
  const url = await abtTeacherSignedUrl(ABT_TEACHER_AVATAR_BUCKET, data.storage_path);
  if (url) avatar.innerHTML = `<img src="${safeText(url)}" alt="Foto profil">`;
}

async function abtV20SubmitSession(form) {
  const fd = new FormData(form); const classId = fd.get('class_id');
  const activity = form.querySelector('[name="activity_id"]')?.selectedOptions[0];
  const student = form.querySelector('[name="student_id"]')?.selectedOptions[0];
  if (!classId || activity?.dataset.classId !== classId || student?.dataset.classId !== classId) { form.querySelector('.abt-v20-feedback').textContent = 'Pilih kelas, jadwal, dan peserta dari kelas yang sama.'; return; }
  const payload = { activity_id: fd.get('activity_id'), class_id: classId, teacher_id: currentUser.id, student_id: fd.get('student_id'), session_date: fd.get('session_date'), minutes: Number(fd.get('minutes')), status: fd.get('status'), notes: String(fd.get('notes') || '').trim() || null };
  const fb = form.querySelector('.abt-v20-feedback'); fb.textContent = 'Menyimpan...';
  const { error } = await supabaseClient.from('teacher_sessions').insert(payload);
  if (error) { fb.textContent = `Belum tersimpan: ${error.message}`; return; }
  await renderDashboardPage('sessions');
}
function abtV20FilterSessionSelect(select, classId) {
  if (!select) return;
  [...select.options].forEach((o, i) => { if (i) o.hidden = Boolean(classId) && o.dataset.classId !== classId; });
  if (select.selectedOptions[0]?.hidden) select.value = '';
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (form?.matches('.abt-v20-reminder-form')) {
    event.preventDefault(); const value = Number(form.querySelector('select').value);
    const { error } = await supabaseClient.rpc('set_class_reminder', { p_activity_id: form.dataset.activityId, p_minutes_before: value });
    if (error) alert(`Pengingat belum tersimpan: ${error.message}`); else await renderDashboardPage('schedule');
    return;
  }
  if (form?.matches('.abt-v20-submission-form')) {
    event.preventDefault(); const fb = form.querySelector('.abt-v20-feedback'); const payload = { evaluation_id: form.dataset.evaluationId, student_id: currentUser.id, response_text: form.elements.response_text.value.trim() || null, response_url: abtV20SafeUrl(form.elements.response_url.value) || null, updated_at: new Date().toISOString() };
    if (!payload.response_text && !payload.response_url) { fb.textContent = 'Isi jawaban atau tautan terlebih dahulu.'; return; }
    fb.textContent = 'Mengirim...'; const { error } = await supabaseClient.from('teacher_evaluation_submissions').upsert(payload, { onConflict: 'evaluation_id,student_id' });
    if (error) { fb.textContent = `Belum terkirim: ${error.message}`; return; } fb.textContent = 'Jawaban tersimpan.'; return;
  }
  if (form?.id === 'abtV20SessionForm') { event.preventDefault(); await abtV20SubmitSession(form); return; }
  if (form?.matches('.abt-v20-link-form')) {
    event.preventDefault(); const fd = new FormData(form); const fb = form.querySelector('.abt-v20-feedback');
    const group = fd.get('whatsapp_group_url') ? abtV20SafeUrl(fd.get('whatsapp_group_url')) : null;
    const meeting = fd.get('default_meeting_url') ? abtV20SafeUrl(fd.get('default_meeting_url')) : null;
    if (fd.get('whatsapp_group_url') && !group || fd.get('default_meeting_url') && !meeting) { fb.textContent = 'Tautan harus menggunakan http:// atau https://.'; return; }
    const payload = { class_id: form.dataset.classId, whatsapp_group_url: group, teacher_whatsapp: String(fd.get('teacher_whatsapp') || '').trim() || null, default_meeting_url: meeting, updated_by: currentUser.id, updated_at: new Date().toISOString() };
    fb.textContent = 'Menyimpan...'; const { error } = await supabaseClient.from('teacher_class_links').upsert(payload, { onConflict: 'class_id' });
    fb.textContent = error ? `Gagal menyimpan: ${error.message}` : 'Akses kelas tersimpan.'; return;
  }
  if (form?.matches('.abt-v20-rate-form')) {
    event.preventDefault(); const fb = form.querySelector('.abt-v20-feedback'); const rate = Number(form.elements.rate.value);
    if (!Number.isFinite(rate) || rate < 0) { fb.textContent = 'Tarif tidak valid.'; return; }
    const kind = form.dataset.kind; fb.textContent = 'Menyimpan...'; let error = null;
    if (kind === 'teacher') {
      ({ error } = await supabaseClient.from('teacher_session_rates').upsert({ teacher_id: form.dataset.id, rate_per_session: rate, updated_by: currentUser.id, updated_at: new Date().toISOString() }, { onConflict: 'teacher_id' }));
    } else if (kind === 'regular') {
      ({ error } = await supabaseClient.from('classes').update({ price_amount: rate, payment_type: 'monthly' }).eq('id', form.dataset.id));
    } else if (kind === 'private-tier') {
      ({ error } = await supabaseClient.from('private_class_rate_tiers').update({ rate_per_participant: rate, updated_by: currentUser.id, updated_at: new Date().toISOString() }).eq('participant_count', Number(form.dataset.id)));
    } else {
      ({ error } = await supabaseClient.from('class_session_rates').upsert({ class_id: form.dataset.id, rate_per_session: rate, updated_by: currentUser.id, updated_at: new Date().toISOString() }, { onConflict: 'class_id' }));
    }
    fb.textContent = error ? `Gagal: ${error.message}` : 'Tarif tersimpan.'; return;
  }
  if (form?.id === 'abtV20AnnouncementForm') {
    event.preventDefault(); const fd = new FormData(form); const fb = form.querySelector('.abt-v20-feedback');
    const audience = currentRole === 'pengajar' ? 'kelas' : fd.get('audience');
    const { error } = await supabaseClient.rpc('send_abt_notification', { p_title: String(fd.get('title')).trim(), p_body: String(fd.get('body')).trim(), p_audience: audience, p_class_id: fd.get('class_id') || null });
    fb.textContent = error ? `Gagal mengirim: ${error.message}` : 'Notifikasi sudah dikirim.';
    if (!error) { form.reset(); await refreshGlobalNotificationCount(); }
  }
});

document.addEventListener('change', event => {
  if (event.target?.name === 'class_id' && event.target.closest('#abtV20SessionForm')) {
    const form = event.target.closest('#abtV20SessionForm');
    abtV20FilterSessionSelect(form.querySelector('[name="activity_id"]'), event.target.value);
    abtV20FilterSessionSelect(form.querySelector('[name="student_id"]'), event.target.value);
  }
});

document.addEventListener('click', async event => {
  const issueRegular = event.target.closest('#abtV21IssueRegularInvoices');
  if (issueRegular) {
    const fb = document.getElementById('abtV21RegularInvoiceFeedback');
    issueRegular.disabled = true; fb.textContent = 'Menerbitkan tagihan bulan ini...';
    const { data, error } = await supabaseClient.rpc('issue_regular_monthly_invoices', { p_billing_month: abtV21CurrentMonth() });
    if (error) { fb.textContent = `Gagal menerbitkan tagihan: ${error.message}`; issueRegular.disabled = false; }
    else { fb.textContent = `${data?.invoices_created ?? 0} invoice reguler baru diterbitkan. Jatuh tempo ${abtV20Date(data?.due_date)}.`; await renderDashboardPage('finance'); }
    return;
  }
  const privateChoice = event.target.closest('[data-private-choice]');
  if (privateChoice) {
    const accept = privateChoice.dataset.privateChoice === 'accept';
    if (!accept && !confirm('Lewati pendaftaran privat peserta ini?')) return;
    privateChoice.disabled = true;
    const { data, error } = await supabaseClient.rpc('decide_private_enrollment', { p_class_id: privateChoice.dataset.classId, p_student_id: privateChoice.dataset.studentId, p_accept: accept });
    if (error) { alert(`Status peserta belum berubah: ${error.message}`); privateChoice.disabled = false; return; }
    if (data?.message) alert(data.message);
    await renderDashboardPage('private'); return;
  }
  const read = event.target.closest('[data-v20-read-notification]');
  if (read) {
    const { error } = await supabaseClient.rpc('mark_abt_notification_read', { p_notification_id: read.dataset.v20ReadNotification });
    if (error) alert(`Notifikasi belum diperbarui: ${error.message}`); else { await refreshGlobalNotificationCount(); await renderDashboardPage('notifications'); }
    return;
  }
  const payroll = event.target.closest('#abtV20SubmitPayroll');
  if (payroll) {
    const fb = document.getElementById('abtV20PayrollFeedback'); payroll.disabled = true; fb.textContent = 'Mengirim laporan...';
    const { start: reportMonth } = abtV20JakartaPreviousMonth();
    const { error } = await supabaseClient.rpc('submit_teacher_monthly_report', { p_report_month: reportMonth });
    if (error) { fb.textContent = `Belum terkirim: ${error.message}`; payroll.disabled = false; }
    else await renderDashboardPage('payroll');
    return;
  }
  const review = event.target.closest('[data-v20-review]');
  if (review) {
    const approve = review.dataset.v20Review === 'approve';
    const note = approve ? null : prompt('Catatan untuk pengajar (wajib):');
    if (!approve && !String(note || '').trim()) return;
    review.disabled = true;
    const { error } = await supabaseClient.rpc('review_teacher_monthly_report', { p_report_id: review.dataset.reportId, p_approve: approve, p_admin_note: String(note || '').trim() || null });
    if (error) { alert(`Laporan belum diperbarui: ${error.message}`); review.disabled = false; } else await renderDashboardPage('finance');
    return;
  }
  const invoice = event.target.closest('[data-v20-invoice-status]');
  if (invoice) {
    const status = invoice.dataset.v20InvoiceStatus;
    const { error } = await supabaseClient.rpc('set_participant_invoice_status', { p_invoice_id: invoice.dataset.invoiceId, p_status: status, p_admin_note: null });
    if (error) alert(`Status invoice belum diperbarui: ${error.message}`); else await renderDashboardPage('finance');
    return;
  }
  const print = event.target.closest('[data-print-invoice]');
  if (print) { abtV20PrintInvoice(print.dataset.printInvoice); return; }
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('globalNotificationBell')?.addEventListener('click', () => navigate('notifications'));
});

