/* ABT V19 teacher workspace. All teacher records are scoped by Supabase RLS. */
const ABT_TEACHER_MATERIAL_BUCKET = 'abt-teacher-materials';
const ABT_TEACHER_AVATAR_BUCKET = 'abt-teacher-avatars';

function abtTeacherAllowed() {
  return currentRole === 'pengajar' && Boolean(currentUser?.id);
}

function abtTeacherDenied() {
  return '<div class="app-alert">Halaman ini hanya tersedia untuk akun Pengajar.</div>';
}

function abtTeacherSchemaNotice(error) {
  const details = error?.message ? ` (${safeText(error.message)})` : '';
  return `<div class="app-alert"><strong>Modul belum tersambung.</strong> Jalankan <code>SQL_ABT_V19_PENGAJAR.sql</code> di Supabase, lalu muat ulang halaman${details}.</div>`;
}

async function abtTeacherAssignedClasses() {
  if (!abtTeacherAllowed()) return { data: [], error: new Error('Akses pengajar diperlukan.') };
  return await supabaseClient.from('classes')
    .select('id,title,description,category,level,status,start_date,end_date,schedule,capacity,instructor_id')
    .eq('instructor_id', currentUser.id)
    .order('created_at', { ascending: false });
}

function abtTeacherClassOptions(classes, selectedId = '') {
  return (classes || []).map(c => `<option value="${safeText(c.id)}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${safeText(c.title)}</option>`).join('');
}

function abtTeacherClassSelect(classes, selectedId = '', id = 'abtTeacherClassId') {
  return `<select id="${id}" name="class_id" required><option value="">Pilih kelas</option>${abtTeacherClassOptions(classes, selectedId)}</select>`;
}

function abtTeacherEmpty(message) {
  return `<div class="panel-card empty-state">${safeText(message)}</div>`;
}

function abtTeacherUuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abtTeacherSafeFileName(name) {
  return String(name || 'file').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'file';
}

function abtTeacherSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) { return ''; }
}

function abtTeacherIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function abtTeacherLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function abtTeacherDate(value, includeTime = false) {
  if (!value) return 'Belum ditentukan';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Belum ditentukan';
  return date.toLocaleString('id-ID', includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

async function abtTeacherSignedUrl(bucket, path) {
  if (!path) return '';
  const { data, error } = await supabaseClient.storage.from(bucket).createSignedUrl(path, 3600);
  return error ? '' : (data?.signedUrl || '');
}

async function abtTeacherLoadEnrollments(classIds) {
  if (!classIds?.length) return { data: [], error: null };
  return await supabaseClient.from('class_enrollments')
    .select('id,class_id,student_id,payment_status,created_at')
    .in('class_id', classIds)
    .order('created_at', { ascending: false });
}

async function abtTeacherProfileMap(studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  if (!ids.length) return { map: {}, error: null };
  const { data, error } = await supabaseClient.from('profiles')
    .select('id,full_name,username,contact_email,phone')
    .in('id', ids);
  const map = Object.fromEntries((data || []).map(p => [p.id, p]));
  return { map, error };
}

async function loadTeacherOverview() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: classes, error: classError } = await abtTeacherAssignedClasses();
  if (classError) return `<div class="app-alert">Kelas pengajar belum dapat dimuat: ${safeText(classError.message)}</div>`;
  const classRows = classes || [];
  const classIds = classRows.map(c => c.id);
  const [enrollmentResult, activityResult, evaluationResult, notificationResult] = await Promise.all([
    abtTeacherLoadEnrollments(classIds),
    classIds.length ? supabaseClient.from('teacher_activities').select('id,title,class_id,starts_at').in('class_id', classIds).gte('starts_at', new Date().toISOString()).order('starts_at').limit(5) : Promise.resolve({ data: [], error: null }),
    classIds.length ? supabaseClient.from('teacher_evaluations').select('id,title,class_id,due_at,kind').in('class_id', classIds).order('created_at', { ascending: false }).limit(5) : Promise.resolve({ data: [], error: null }),
    supabaseClient.from('teacher_notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
  ]);
  const enrollments = enrollmentResult.data || [];
  const activeStatuses = new Set(['terverifikasi', 'approved', 'active', 'aktif']);
  const activeStudents = new Set(enrollments.filter(e => activeStatuses.has(String(e.payment_status || '').toLowerCase())).map(e => e.student_id)).size;
  const classById = Object.fromEntries(classRows.map(c => [c.id, c]));
  const stats = [
    ['Kelas diampu', classRows.length],
    ['Peserta aktif', activeStudents],
    ['Jadwal mendatang', activityResult.error ? '—' : (activityResult.data || []).length],
    ['Notifikasi baru', notificationResult.error ? '—' : (notificationResult.count || 0)]
  ];
  const classCards = classRows.length ? `<div class="teacher-card-grid">${classRows.slice(0, 6).map(c => `<article class="panel-card teacher-class-card"><span class="status-pill">${safeText(c.status === 'published' ? 'Kelas aktif' : 'Kelas ditugaskan')}</span><h3>${safeText(c.title)}</h3><p>${safeText([c.category, c.level].filter(Boolean).join(' · ') || c.description || 'Kelas yang ditugaskan kepada Anda.')}</p><div class="teacher-class-meta">${safeText(c.schedule || 'Jadwal belum diatur')}<br>${safeText(c.start_date ? abtTeacherDate(c.start_date) : 'Tanggal mulai belum ditentukan')}</div><a href="${routePath('students')}" data-page="students">Lihat peserta →</a></article>`).join('')}</div>` : abtTeacherEmpty('Belum ada kelas yang ditugaskan kepada akun Anda. Hubungi Super Admin untuk penugasan kelas.');
  const activityRows = activityResult.error
    ? `<tr><td colspan="3">Jadwal belum dapat dimuat. Pastikan migrasi V19 sudah dijalankan.</td></tr>`
    : (activityResult.data || []).map(a => `<tr><td>${safeText(a.title)}</td><td>${safeText(classById[a.class_id]?.title || 'Kelas')}</td><td>${safeText(abtTeacherDate(a.starts_at, true))}</td></tr>`).join('') || `<tr><td colspan="3">Belum ada jadwal mendatang.</td></tr>`;
  const evaluationRows = evaluationResult.error
    ? `<tr><td colspan="3">Evaluasi belum dapat dimuat. Pastikan migrasi V19 sudah dijalankan.</td></tr>`
    : (evaluationResult.data || []).map(e => `<tr><td>${safeText(e.title)}</td><td>${safeText(classById[e.class_id]?.title || 'Kelas')}</td><td>${safeText(e.due_at ? abtTeacherDate(e.due_at, true) : 'Tanpa tenggat')}</td></tr>`).join('') || `<tr><td colspan="3">Belum ada tugas atau latihan.</td></tr>`;
  return `<section class="welcome-panel"><h2>Assalamu'alaikum, ${safeText(currentProfile?.full_name || currentUser.email || 'Pengajar')}!</h2><p>Kelola kelas yang ditugaskan, dampingi peserta, dan pantau pembelajaran dari satu tempat.</p></section>
    <div class="stats-grid teacher-stats-grid">${stats.map(([label, value]) => `<article class="stat-card"><div class="stat-card-copy"><small>${label}</small><strong>${safeText(value)}</strong><span class="stat-accent" aria-hidden="true"></span></div></article>`).join('')}</div>
    <section class="panel-card"><div class="teacher-section-heading"><div><h3>Kelas Saya</h3><p class="panel-subtitle">Hanya kelas yang ditugaskan kepada akun Anda yang ditampilkan.</p></div><a class="app-button secondary" href="${routePath('classes')}" data-page="classes">Semua kelas</a></div>${classCards}</section>
    <div class="dashboard-grid teacher-dashboard-lower"><section class="panel-card"><h3>Jadwal Mendatang</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Aktivitas</th><th>Kelas</th><th>Waktu</th></tr></thead><tbody>${activityRows}</tbody></table></div></section><section class="panel-card"><h3>Tugas & Latihan</h3><div class="table-wrap"><table class="app-table"><thead><tr><th>Evaluasi</th><th>Kelas</th><th>Tenggat</th></tr></thead><tbody>${evaluationRows}</tbody></table></div></section></div>`;
}

async function loadTeacherStudents() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: classes, error: classError } = await abtTeacherAssignedClasses();
  if (classError) return `<div class="app-alert">Kelas pengajar belum dapat dimuat: ${safeText(classError.message)}</div>`;
  const classRows = classes || [];
  if (!classRows.length) return `<section class="panel-card"><h3>Peserta Kelas</h3>${abtTeacherEmpty('Belum ada peserta karena belum ada kelas yang ditugaskan.')}</section>`;
  const { data: enrollments, error } = await abtTeacherLoadEnrollments(classRows.map(c => c.id));
  if (error) return `<div class="app-alert">Data peserta belum dapat dimuat: ${safeText(error.message)}</div>`;
  const { map: profiles, error: profileError } = await abtTeacherProfileMap((enrollments || []).map(e => e.student_id));
  if (profileError) return `<div class="app-alert">Nama peserta belum dapat dimuat: ${safeText(profileError.message)}</div>`;
  const classById = Object.fromEntries(classRows.map(c => [c.id, c]));
  const rows = (enrollments || []).map(e => {
    const p = profiles[e.student_id] || {};
    return `<tr><td><strong>${safeText(p.full_name || p.username || 'Peserta')}</strong><br><small>${safeText(p.username ? '@' + p.username : '')}</small></td><td>${safeText(classById[e.class_id]?.title || 'Kelas')}</td><td>${safeText(p.contact_email || '—')}</td><td>${safeText(p.phone || '—')}</td><td><span class="status-pill">${safeText(e.payment_status || 'Menunggu')}</span></td><td>${safeText(abtTeacherDate(e.created_at))}</td></tr>`;
  }).join('') || `<tr><td colspan="6">Belum ada pendaftaran peserta pada kelas yang ditugaskan.</td></tr>`;
  return `<section class="panel-card"><div class="teacher-section-heading"><div><h3>Peserta Kelas</h3><p class="panel-subtitle">Daftar peserta dibatasi pada kelas yang Anda ampu.</p></div><span class="teacher-count-badge">${(enrollments || []).length} pendaftaran</span></div><div class="table-wrap"><table class="app-table"><thead><tr><th>Nama</th><th>Kelas</th><th>Email</th><th>WhatsApp</th><th>Status</th><th>Terdaftar</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

async function loadTeacherMaterials() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: classes, error: classError } = await abtTeacherAssignedClasses();
  if (classError) return `<div class="app-alert">Kelas pengajar belum dapat dimuat: ${safeText(classError.message)}</div>`;
  const classRows = classes || [];
  if (!classRows.length) return `<section class="panel-card"><h3>Materi Pembelajaran</h3>${abtTeacherEmpty('Penugasan kelas diperlukan sebelum Anda dapat menambahkan materi.')}</section>`;
  const { data, error } = await supabaseClient.from('teacher_materials')
    .select('id,class_id,title,description,storage_path,external_url,created_at,classes(title)')
    .in('class_id', classRows.map(c => c.id)).order('created_at', { ascending: false });
  if (error) return abtTeacherSchemaNotice(error);
  const rows = data || [];
  window.abtTeacherMaterials = rows;
  const classOptions = abtTeacherClassOptions(classRows);
  const list = await Promise.all(rows.map(async item => {
    const downloadUrl = item.storage_path ? await abtTeacherSignedUrl(ABT_TEACHER_MATERIAL_BUCKET, item.storage_path) : abtTeacherSafeHttpUrl(item.external_url);
    const link = downloadUrl ? `<a class="teacher-file-link" href="${safeText(downloadUrl)}" target="_blank" rel="noopener noreferrer">Buka materi ↗</a>` : '<span class="teacher-muted">Tautan tidak tersedia</span>';
    return `<article class="teacher-record-card"><div><span class="status-pill">${safeText(item.classes?.title || 'Kelas')}</span><h4>${safeText(item.title)}</h4><p>${safeText(item.description || 'Tidak ada keterangan.')}</p>${link}</div><div class="teacher-record-actions"><button type="button" class="app-button secondary" data-edit-material="${safeText(item.id)}">Edit</button><button type="button" class="app-button danger" data-delete-material="${safeText(item.id)}">Hapus</button></div></article>`;
  })).then(items => items.join(''));
  return `<section class="panel-card"><h3>Materi Pembelajaran</h3><p class="panel-subtitle">Unggah berkas secara privat ke Supabase Storage atau tambahkan tautan HTTPS. Akses hanya tersedia untuk pengajar yang ditugaskan ke kelas.</p>
      <form id="abtTeacherMaterialForm" class="teacher-form-card"><input type="hidden" id="abtTeacherMaterialId"><div class="teacher-form-grid"><label>Kelas *${abtTeacherClassSelect(classRows, '', 'abtTeacherMaterialClass')}</label><label>Judul materi *<input id="abtTeacherMaterialTitle" maxlength="160" required placeholder="Contoh: Hukum Nun Sukun"></label><label class="teacher-span-all">Keterangan<textarea id="abtTeacherMaterialDescription" maxlength="1200" rows="3" placeholder="Ringkasan materi atau arahan untuk peserta"></textarea></label><label>Berkas materi<input id="abtTeacherMaterialFile" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png,.mp3,.mp4,.webm"></label><label>Tautan eksternal<input id="abtTeacherMaterialUrl" type="url" placeholder="https://..."></label></div><p class="teacher-help">Isi salah satu: berkas atau tautan. Maksimum berkas 25 MB. Materi tersimpan setelah migrasi dan Storage policy V19 dijalankan.</p><div class="teacher-form-actions"><button class="app-button" type="submit">Simpan Materi</button><button class="app-button secondary" type="button" id="abtTeacherMaterialCancel" hidden>Batal Edit</button><span class="teacher-feedback" id="abtTeacherMaterialFeedback" role="status"></span></div></form>
      <div class="teacher-record-list">${list || abtTeacherEmpty('Belum ada materi. Tambahkan materi pertama untuk kelas yang Anda ampu.')}</div></section>`;
}

function abtTeacherResetMaterialForm() {
  document.getElementById('abtTeacherMaterialForm')?.reset();
  const id = document.getElementById('abtTeacherMaterialId'); if (id) id.value = '';
  const cancel = document.getElementById('abtTeacherMaterialCancel'); if (cancel) cancel.hidden = true;
  const feedback = document.getElementById('abtTeacherMaterialFeedback'); if (feedback) feedback.textContent = '';
}

async function abtTeacherSaveMaterial(event) {
  if (!abtTeacherAllowed()) return;
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.getElementById('abtTeacherMaterialId').value;
  const classId = document.getElementById('abtTeacherMaterialClass').value;
  const title = document.getElementById('abtTeacherMaterialTitle').value.trim();
  const description = document.getElementById('abtTeacherMaterialDescription').value.trim() || null;
  const file = document.getElementById('abtTeacherMaterialFile').files[0] || null;
  const external = abtTeacherSafeHttpUrl(document.getElementById('abtTeacherMaterialUrl').value);
  const feedback = document.getElementById('abtTeacherMaterialFeedback');
  const button = form.querySelector('[type="submit"]');
  const old = (window.abtTeacherMaterials || []).find(x => String(x.id) === String(id));
  if (!classId || !title) { feedback.textContent = 'Kelas dan judul materi wajib diisi.'; return; }
  if (file && external) { feedback.textContent = 'Pilih berkas atau tautan eksternal, bukan keduanya.'; return; }
  if (!file && !external && !old) { feedback.textContent = 'Tambahkan berkas atau tautan materi.'; return; }
  if (file && file.size > 25 * 1024 * 1024) { feedback.textContent = 'Ukuran berkas melebihi batas 25 MB.'; return; }
  if (document.getElementById('abtTeacherMaterialUrl').value.trim() && !external) { feedback.textContent = 'Tautan harus menggunakan HTTP atau HTTPS.'; return; }
  button.disabled = true; button.textContent = 'Menyimpan…'; feedback.textContent = 'Menyimpan materi…';
  let storagePath = file ? null : (external ? null : old?.storage_path || null);
  let uploadedPath = null;
  if (file) {
    storagePath = `${classId}/${abtTeacherUuid()}-${abtTeacherSafeFileName(file.name)}`;
    const { error: uploadError } = await supabaseClient.storage.from(ABT_TEACHER_MATERIAL_BUCKET).upload(storagePath, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
    if (uploadError) { feedback.textContent = `Unggah gagal: ${uploadError.message}`; button.disabled = false; button.textContent = 'Simpan Materi'; return; }
    uploadedPath = storagePath;
  }
  const payload = { class_id: classId, title, description, storage_path: storagePath, external_url: external || (storagePath ? null : old?.external_url || null) };
  payload.created_by = currentUser.id;
  const query = id
    ? supabaseClient.from('teacher_materials').update(payload).eq('id', id).select('id').maybeSingle()
    : supabaseClient.from('teacher_materials').insert(payload).select('id').single();
  const { error } = await query;
  if (error) {
    if (uploadedPath) await supabaseClient.storage.from(ABT_TEACHER_MATERIAL_BUCKET).remove([uploadedPath]);
    feedback.textContent = `Gagal menyimpan materi: ${error.message}`;
  } else {
    if (old?.storage_path && old.storage_path !== storagePath) await supabaseClient.storage.from(ABT_TEACHER_MATERIAL_BUCKET).remove([old.storage_path]);
    await renderDashboardPage('materials');
  }
  button.disabled = false; button.textContent = 'Simpan Materi';
}

function abtTeacherEditMaterial(id) {
  if (!abtTeacherAllowed()) return;
  const item = (window.abtTeacherMaterials || []).find(x => String(x.id) === String(id));
  if (!item) return;
  document.getElementById('abtTeacherMaterialId').value = item.id;
  document.getElementById('abtTeacherMaterialClass').value = item.class_id;
  document.getElementById('abtTeacherMaterialTitle').value = item.title || '';
  document.getElementById('abtTeacherMaterialDescription').value = item.description || '';
  document.getElementById('abtTeacherMaterialUrl').value = item.external_url || '';
  document.getElementById('abtTeacherMaterialFile').value = '';
  document.getElementById('abtTeacherMaterialCancel').hidden = false;
  document.getElementById('abtTeacherMaterialForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function abtTeacherDeleteMaterial(id) {
  if (!abtTeacherAllowed()) return;
  const item = (window.abtTeacherMaterials || []).find(x => String(x.id) === String(id));
  if (!item || !confirm(`Hapus materi “${item.title}”?`)) return;
  const { error } = await supabaseClient.from('teacher_materials').delete().eq('id', id);
  if (error) { alert(`Gagal menghapus materi: ${error.message}`); return; }
  if (item.storage_path) await supabaseClient.storage.from(ABT_TEACHER_MATERIAL_BUCKET).remove([item.storage_path]);
  await renderDashboardPage('materials');
}

document.addEventListener('submit', event => {
  if (event.target?.id === 'abtTeacherMaterialForm') abtTeacherSaveMaterial(event);
});

document.addEventListener('click', event => {
  const edit = event.target.closest('[data-edit-material]');
  if (edit) { abtTeacherEditMaterial(edit.dataset.editMaterial); return; }
  const remove = event.target.closest('[data-delete-material]');
  if (remove) { abtTeacherDeleteMaterial(remove.dataset.deleteMaterial); return; }
  if (event.target.closest('#abtTeacherMaterialCancel')) abtTeacherResetMaterialForm();
});

async function loadTeacherActivities() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: classes, error: classError } = await abtTeacherAssignedClasses();
  if (classError) return `<div class="app-alert">Kelas pengajar belum dapat dimuat: ${safeText(classError.message)}</div>`;
  const classRows = classes || [];
  if (!classRows.length) return `<section class="panel-card"><h3>Aktivitas & Jadwal</h3>${abtTeacherEmpty('Penugasan kelas diperlukan sebelum membuat jadwal.')}</section>`;
  const { data, error } = await supabaseClient.from('teacher_activities')
    .select('id,class_id,title,details,starts_at,ends_at,location,meeting_url,created_at,classes(title)')
    .in('class_id', classRows.map(c => c.id)).order('starts_at', { ascending: true });
  if (error) return abtTeacherSchemaNotice(error);
  const activities = data || [];
  window.abtTeacherActivities = activities;
  const cards = activities.map(a => `<article class="teacher-record-card"><div><span class="status-pill">${safeText(a.classes?.title || 'Kelas')}</span><h4>${safeText(a.title)}</h4><p>${safeText(a.details || 'Tidak ada keterangan.')}</p><div class="teacher-class-meta">${safeText(abtTeacherDate(a.starts_at, true))}${a.ends_at ? ` – ${safeText(abtTeacherDate(a.ends_at, true))}` : ''}${a.location ? ` · ${safeText(a.location)}` : ''}</div>${a.meeting_url ? `<a class="teacher-file-link" href="${safeText(abtTeacherSafeHttpUrl(a.meeting_url))}" target="_blank" rel="noopener noreferrer">Buka tautan pertemuan ↗</a>` : ''}</div><div class="teacher-record-actions"><button type="button" class="app-button secondary" data-edit-activity="${safeText(a.id)}">Edit</button><button type="button" class="app-button danger" data-delete-activity="${safeText(a.id)}">Hapus</button></div></article>`).join('');
  return `<section class="panel-card"><h3>Aktivitas Pembelajaran & Jadwal</h3><p class="panel-subtitle">Buat dan kelola jadwal hanya untuk kelas yang ditugaskan kepada Anda.</p>
    <form id="abtTeacherActivityForm" class="teacher-form-card"><input type="hidden" id="abtTeacherActivityId"><div class="teacher-form-grid"><label>Kelas *${abtTeacherClassSelect(classRows, '', 'abtTeacherActivityClass')}</label><label>Nama aktivitas *<input id="abtTeacherActivityTitle" required maxlength="160" placeholder="Contoh: Pertemuan hukum Mad"></label><label>Mulai *<input id="abtTeacherActivityStart" type="datetime-local" required></label><label>Selesai<input id="abtTeacherActivityEnd" type="datetime-local"></label><label>Tempat / media<input id="abtTeacherActivityLocation" maxlength="180" placeholder="Ruang belajar / Zoom"></label><label>Tautan pertemuan<input id="abtTeacherActivityUrl" type="url" placeholder="https://..."></label><label class="teacher-span-all">Keterangan<textarea id="abtTeacherActivityDetails" maxlength="1200" rows="3"></textarea></label></div><div class="teacher-form-actions"><button class="app-button" type="submit">Simpan Jadwal</button><button class="app-button secondary" type="button" id="abtTeacherActivityCancel" hidden>Batal Edit</button><span class="teacher-feedback" id="abtTeacherActivityFeedback" role="status"></span></div></form>
    <div class="teacher-record-list">${cards || abtTeacherEmpty('Belum ada jadwal. Buat aktivitas pembelajaran pertama.')}</div></section>`;
}

function abtTeacherResetActivityForm() {
  document.getElementById('abtTeacherActivityForm')?.reset();
  const id = document.getElementById('abtTeacherActivityId'); if (id) id.value = '';
  const cancel = document.getElementById('abtTeacherActivityCancel'); if (cancel) cancel.hidden = true;
  const feedback = document.getElementById('abtTeacherActivityFeedback'); if (feedback) feedback.textContent = '';
}

async function abtTeacherSaveActivity(event) {
  if (!abtTeacherAllowed()) return;
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.getElementById('abtTeacherActivityId').value;
  const startsAt = abtTeacherIso(document.getElementById('abtTeacherActivityStart').value);
  const endsAt = abtTeacherIso(document.getElementById('abtTeacherActivityEnd').value);
  const meetingUrlRaw = document.getElementById('abtTeacherActivityUrl').value.trim();
  const meetingUrl = meetingUrlRaw ? abtTeacherSafeHttpUrl(meetingUrlRaw) : null;
  const feedback = document.getElementById('abtTeacherActivityFeedback');
  const button = form.querySelector('[type="submit"]');
  if (!startsAt || (endsAt && new Date(endsAt) < new Date(startsAt))) { feedback.textContent = 'Waktu mulai dan selesai tidak valid.'; return; }
  if (meetingUrlRaw && !meetingUrl) { feedback.textContent = 'Tautan pertemuan harus menggunakan HTTP atau HTTPS.'; return; }
  const payload = {
    class_id: document.getElementById('abtTeacherActivityClass').value,
    title: document.getElementById('abtTeacherActivityTitle').value.trim(),
    details: document.getElementById('abtTeacherActivityDetails').value.trim() || null,
    starts_at: startsAt, ends_at: endsAt,
    location: document.getElementById('abtTeacherActivityLocation').value.trim() || null,
    meeting_url: meetingUrl
  };
  if (!payload.class_id || !payload.title) { feedback.textContent = 'Kelas dan nama aktivitas wajib diisi.'; return; }
  payload.created_by = currentUser.id;
  button.disabled = true; button.textContent = 'Menyimpan…'; feedback.textContent = 'Menyimpan jadwal…';
  const query = id
    ? supabaseClient.from('teacher_activities').update(payload).eq('id', id).select('id').maybeSingle()
    : supabaseClient.from('teacher_activities').insert(payload).select('id').single();
  const { error } = await query;
  if (error) { feedback.textContent = `Gagal menyimpan jadwal: ${error.message}`; button.disabled = false; button.textContent = 'Simpan Jadwal'; return; }
  await renderDashboardPage('activities');
}

function abtTeacherEditActivity(id) {
  if (!abtTeacherAllowed()) return;
  const activity = (window.abtTeacherActivities || []).find(x => String(x.id) === String(id));
  if (!activity) return;
  document.getElementById('abtTeacherActivityId').value = activity.id;
  document.getElementById('abtTeacherActivityClass').value = activity.class_id;
  document.getElementById('abtTeacherActivityTitle').value = activity.title || '';
  document.getElementById('abtTeacherActivityDetails').value = activity.details || '';
  document.getElementById('abtTeacherActivityStart').value = abtTeacherLocalDateTime(activity.starts_at);
  document.getElementById('abtTeacherActivityEnd').value = abtTeacherLocalDateTime(activity.ends_at);
  document.getElementById('abtTeacherActivityLocation').value = activity.location || '';
  document.getElementById('abtTeacherActivityUrl').value = activity.meeting_url || '';
  document.getElementById('abtTeacherActivityCancel').hidden = false;
  document.getElementById('abtTeacherActivityForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function abtTeacherDeleteActivity(id) {
  if (!abtTeacherAllowed()) return;
  const activity = (window.abtTeacherActivities || []).find(x => String(x.id) === String(id));
  if (!activity || !confirm(`Hapus aktivitas “${activity.title}”?`)) return;
  const { error } = await supabaseClient.from('teacher_activities').delete().eq('id', id);
  if (error) { alert(`Gagal menghapus aktivitas: ${error.message}`); return; }
  await renderDashboardPage('activities');
}

async function loadTeacherEvaluations() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: classes, error: classError } = await abtTeacherAssignedClasses();
  if (classError) return `<div class="app-alert">Kelas pengajar belum dapat dimuat: ${safeText(classError.message)}</div>`;
  const classRows = classes || [];
  if (!classRows.length) return `<section class="panel-card"><h3>Evaluasi</h3>${abtTeacherEmpty('Penugasan kelas diperlukan sebelum membuat tugas atau latihan.')}</section>`;
  const { data, error } = await supabaseClient.from('teacher_evaluations')
    .select('id,class_id,kind,title,instructions,due_at,max_score,is_published,created_at,classes(title)')
    .in('class_id', classRows.map(c => c.id)).order('created_at', { ascending: false });
  if (error) return abtTeacherSchemaNotice(error);
  const evaluations = data || [];
  window.abtTeacherEvaluationRecords = evaluations;
  const cards = evaluations.map(e => `<article class="teacher-record-card"><div><span class="status-pill">${safeText(e.classes?.title || 'Kelas')} · ${safeText(e.kind === 'latihan' ? 'Latihan' : 'Tugas')}</span><h4>${safeText(e.title)}</h4><p>${safeText(e.instructions || 'Tidak ada petunjuk tambahan.')}</p><div class="teacher-class-meta">Tenggat: ${safeText(e.due_at ? abtTeacherDate(e.due_at, true) : 'Tanpa tenggat')} · Nilai maksimum ${safeText(e.max_score)}</div><span class="teacher-muted">${e.is_published ? 'Ditampilkan pada ruang kerja pengajar' : 'Draft'}</span></div><div class="teacher-record-actions teacher-record-actions-column"><button type="button" class="app-button secondary" data-evaluation-results="${safeText(e.id)}">Peserta & Hasil</button><button type="button" class="app-button secondary" data-edit-evaluation="${safeText(e.id)}">Edit</button><button type="button" class="app-button danger" data-delete-evaluation="${safeText(e.id)}">Hapus</button></div></article>`).join('');
  return `<section class="panel-card"><h3>Evaluasi: Tugas, Latihan, dan Hasil</h3><p class="panel-subtitle">Buat tugas atau latihan, lalu catat nilai dan umpan balik untuk peserta terdaftar. Pengumpulan berkas oleh peserta belum tersedia pada skema ini.</p>
    <form id="abtTeacherEvaluationForm" class="teacher-form-card"><input type="hidden" id="abtTeacherEvaluationId"><div class="teacher-form-grid"><label>Kelas *${abtTeacherClassSelect(classRows, '', 'abtTeacherEvaluationClass')}</label><label>Jenis *<select id="abtTeacherEvaluationKind" required><option value="tugas">Tugas</option><option value="latihan">Latihan</option></select></label><label class="teacher-span-all">Judul *<input id="abtTeacherEvaluationTitle" required maxlength="160" placeholder="Contoh: Latihan makharijul huruf"></label><label>Tenggat<input id="abtTeacherEvaluationDue" type="datetime-local"></label><label>Nilai maksimum<input id="abtTeacherEvaluationMax" type="number" min="1" max="1000" step="0.5" value="100" required></label><label class="teacher-span-all">Petunjuk<textarea id="abtTeacherEvaluationInstructions" maxlength="3000" rows="4" placeholder="Tuliskan instruksi dan kriteria penilaian"></textarea></label><label class="teacher-check-label"><input id="abtTeacherEvaluationPublished" type="checkbox" checked> Aktifkan</label></div><div class="teacher-form-actions"><button class="app-button" type="submit">Simpan Evaluasi</button><button class="app-button secondary" type="button" id="abtTeacherEvaluationCancel" hidden>Batal Edit</button><span class="teacher-feedback" id="abtTeacherEvaluationFeedback" role="status"></span></div></form>
    <div class="teacher-record-list">${cards || abtTeacherEmpty('Belum ada evaluasi. Buat tugas atau latihan pertama.')}</div><div id="abtTeacherResultsPanel"></div></section>`;
}

function abtTeacherResetEvaluationForm() {
  document.getElementById('abtTeacherEvaluationForm')?.reset();
  const id = document.getElementById('abtTeacherEvaluationId'); if (id) id.value = '';
  const max = document.getElementById('abtTeacherEvaluationMax'); if (max) max.value = '100';
  const published = document.getElementById('abtTeacherEvaluationPublished'); if (published) published.checked = true;
  const cancel = document.getElementById('abtTeacherEvaluationCancel'); if (cancel) cancel.hidden = true;
  const feedback = document.getElementById('abtTeacherEvaluationFeedback'); if (feedback) feedback.textContent = '';
}

async function abtTeacherSaveEvaluation(event) {
  if (!abtTeacherAllowed()) return;
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.getElementById('abtTeacherEvaluationId').value;
  const dueValue = document.getElementById('abtTeacherEvaluationDue').value;
  const maxScore = Number(document.getElementById('abtTeacherEvaluationMax').value);
  const feedback = document.getElementById('abtTeacherEvaluationFeedback');
  const button = form.querySelector('[type="submit"]');
  const payload = {
    class_id: document.getElementById('abtTeacherEvaluationClass').value,
    kind: document.getElementById('abtTeacherEvaluationKind').value,
    title: document.getElementById('abtTeacherEvaluationTitle').value.trim(),
    instructions: document.getElementById('abtTeacherEvaluationInstructions').value.trim() || null,
    due_at: dueValue ? abtTeacherIso(dueValue) : null,
    max_score: maxScore,
    is_published: document.getElementById('abtTeacherEvaluationPublished').checked
  };
  if (!payload.class_id || !payload.title || !Number.isFinite(maxScore) || maxScore <= 0) { feedback.textContent = 'Kelas, judul, dan nilai maksimum yang valid wajib diisi.'; return; }
  payload.created_by = currentUser.id;
  button.disabled = true; button.textContent = 'Menyimpan…'; feedback.textContent = 'Menyimpan evaluasi…';
  const query = id
    ? supabaseClient.from('teacher_evaluations').update(payload).eq('id', id).select('id').maybeSingle()
    : supabaseClient.from('teacher_evaluations').insert(payload).select('id').single();
  const { error } = await query;
  if (error) { feedback.textContent = `Gagal menyimpan evaluasi: ${error.message}`; button.disabled = false; button.textContent = 'Simpan Evaluasi'; return; }
  await renderDashboardPage('evaluations');
}

function abtTeacherEditEvaluation(id) {
  if (!abtTeacherAllowed()) return;
  const e = (window.abtTeacherEvaluationRecords || []).find(x => String(x.id) === String(id));
  if (!e) return;
  document.getElementById('abtTeacherEvaluationId').value = e.id;
  document.getElementById('abtTeacherEvaluationClass').value = e.class_id;
  document.getElementById('abtTeacherEvaluationKind').value = e.kind;
  document.getElementById('abtTeacherEvaluationTitle').value = e.title || '';
  document.getElementById('abtTeacherEvaluationInstructions').value = e.instructions || '';
  document.getElementById('abtTeacherEvaluationDue').value = abtTeacherLocalDateTime(e.due_at);
  document.getElementById('abtTeacherEvaluationMax').value = e.max_score || 100;
  document.getElementById('abtTeacherEvaluationPublished').checked = Boolean(e.is_published);
  document.getElementById('abtTeacherEvaluationCancel').hidden = false;
  document.getElementById('abtTeacherEvaluationForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function abtTeacherDeleteEvaluation(id) {
  if (!abtTeacherAllowed()) return;
  const e = (window.abtTeacherEvaluationRecords || []).find(x => String(x.id) === String(id));
  if (!e || !confirm(`Hapus evaluasi “${e.title}” beserta hasil penilaiannya?`)) return;
  const { error } = await supabaseClient.from('teacher_evaluations').delete().eq('id', id);
  if (error) { alert(`Gagal menghapus evaluasi: ${error.message}`); return; }
  await renderDashboardPage('evaluations');
}

async function abtTeacherShowResults(id) {
  if (!abtTeacherAllowed()) return;
  const evaluation = (window.abtTeacherEvaluationRecords || []).find(x => String(x.id) === String(id));
  if (!evaluation) return;
  const panel = document.getElementById('abtTeacherResultsPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="panel-card"><p>Memuat peserta dan nilai…</p></div>';
  const [enrollmentResult, resultQuery] = await Promise.all([
    abtTeacherLoadEnrollments([evaluation.class_id]),
    supabaseClient.from('teacher_evaluation_results').select('id,student_id,score,feedback,graded_at').eq('evaluation_id', evaluation.id)
  ]);
  if (enrollmentResult.error || resultQuery.error) {
    panel.innerHTML = `<div class="app-alert">${safeText((enrollmentResult.error || resultQuery.error).message)}</div>`;
    return;
  }
  const enrollments = enrollmentResult.data || [];
  const { map: profiles, error: profileError } = await abtTeacherProfileMap(enrollments.map(x => x.student_id));
  if (profileError) { panel.innerHTML = `<div class="app-alert">Nama peserta belum dapat dimuat: ${safeText(profileError.message)}</div>`; return; }
  const results = Object.fromEntries((resultQuery.data || []).map(x => [x.student_id, x]));
  const rows = enrollments.map(enrollment => {
    const studentId = enrollment.student_id;
    const profile = profiles[studentId] || {};
    const result = results[studentId] || {};
    return `<tr><td>${safeText(profile.full_name || profile.username || 'Peserta')}<br><small>${safeText(profile.username || '')}</small></td><td><span class="status-pill">${safeText(enrollment.payment_status || 'Terdaftar')}</span></td><td><form class="teacher-score-form" data-evaluation-id="${safeText(evaluation.id)}" data-student-id="${safeText(studentId)}"><input aria-label="Nilai ${safeText(profile.full_name || 'peserta')}" name="score" type="number" min="0" max="${safeText(evaluation.max_score)}" step="0.1" value="${result.score == null ? '' : safeText(result.score)}" placeholder="0–${safeText(evaluation.max_score)}"><textarea aria-label="Umpan balik untuk ${safeText(profile.full_name || 'peserta')}" name="feedback" maxlength="1500" rows="2" placeholder="Umpan balik">${safeText(result.feedback || '')}</textarea><button class="app-button secondary" type="submit">Simpan Nilai</button><span class="teacher-feedback" role="status"></span></form></td></tr>`;
  }).join('') || '<tr><td colspan="3">Belum ada peserta terdaftar pada kelas ini.</td></tr>';
  panel.innerHTML = `<section class="panel-card teacher-results-panel"><div class="teacher-section-heading"><div><h3>Peserta & Hasil: ${safeText(evaluation.title)}</h3><p class="panel-subtitle">Nilai maksimum ${safeText(evaluation.max_score)}. Data hanya berasal dari peserta kelas ini.</p></div><button class="app-button secondary" type="button" id="abtTeacherCloseResults">Tutup</button></div><div class="table-wrap"><table class="app-table"><thead><tr><th>Peserta</th><th>Status</th><th>Nilai & umpan balik</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function abtTeacherSaveResult(event) {
  if (!abtTeacherAllowed()) return;
  event.preventDefault();
  const form = event.currentTarget;
  const scoreValue = form.elements.score.value;
  const score = scoreValue === '' ? null : Number(scoreValue);
  const feedback = form.elements.feedback.value.trim() || null;
  const status = form.querySelector('[role="status"]');
  const button = form.querySelector('[type="submit"]');
  if (score === null || !Number.isFinite(score) || score < 0) { status.textContent = 'Masukkan nilai yang valid.'; return; }
  const evaluation = (window.abtTeacherEvaluationRecords || []).find(x => String(x.id) === form.dataset.evaluationId);
  if (!evaluation || score > Number(evaluation.max_score)) { status.textContent = 'Nilai melebihi batas maksimum.'; return; }
  button.disabled = true; status.textContent = 'Menyimpan…';
  const { error } = await supabaseClient.from('teacher_evaluation_results').upsert({
    evaluation_id: form.dataset.evaluationId,
    student_id: form.dataset.studentId,
    score,
    feedback,
    graded_by: currentUser.id,
    graded_at: new Date().toISOString()
  }, { onConflict: 'evaluation_id,student_id' });
  status.textContent = error ? `Gagal: ${error.message}` : 'Nilai tersimpan.';
  button.disabled = false;
}

document.addEventListener('submit', event => {
  if (event.target?.id === 'abtTeacherActivityForm') abtTeacherSaveActivity(event);
  if (event.target?.id === 'abtTeacherEvaluationForm') abtTeacherSaveEvaluation(event);
  if (event.target?.matches('.teacher-score-form')) abtTeacherSaveResult(event);
});

document.addEventListener('click', event => {
  const editActivity = event.target.closest('[data-edit-activity]');
  if (editActivity) { abtTeacherEditActivity(editActivity.dataset.editActivity); return; }
  const deleteActivity = event.target.closest('[data-delete-activity]');
  if (deleteActivity) { abtTeacherDeleteActivity(deleteActivity.dataset.deleteActivity); return; }
  if (event.target.closest('#abtTeacherActivityCancel')) { abtTeacherResetActivityForm(); return; }
  const editEvaluation = event.target.closest('[data-edit-evaluation]');
  if (editEvaluation) { abtTeacherEditEvaluation(editEvaluation.dataset.editEvaluation); return; }
  const deleteEvaluation = event.target.closest('[data-delete-evaluation]');
  if (deleteEvaluation) { abtTeacherDeleteEvaluation(deleteEvaluation.dataset.deleteEvaluation); return; }
  const showResults = event.target.closest('[data-evaluation-results]');
  if (showResults) { abtTeacherShowResults(showResults.dataset.evaluationResults); return; }
  if (event.target.closest('#abtTeacherEvaluationCancel')) { abtTeacherResetEvaluationForm(); return; }
  if (event.target.closest('#abtTeacherCloseResults')) document.getElementById('abtTeacherResultsPanel').innerHTML = '';
});

async function loadTeacherNotifications() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data, error } = await supabaseClient.from('teacher_notifications')
    .select('id,class_id,title,body,kind,read_at,created_at,classes(title)')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return abtTeacherSchemaNotice(error);
  const notifications = data || [];
  const rows = notifications.map(n => `<article class="teacher-notification ${n.read_at ? '' : 'is-unread'}"><div><div class="teacher-notification-meta"><span class="status-pill">${safeText(n.classes?.title || 'Akun pengajar')}</span><time>${safeText(abtTeacherDate(n.created_at, true))}</time></div><h4>${safeText(n.title)}</h4><p>${safeText(n.body || '')}</p></div>${n.read_at ? '<span class="teacher-muted">Sudah dibaca</span>' : `<button type="button" class="app-button secondary" data-read-notification="${safeText(n.id)}">Tandai dibaca</button>`}</article>`).join('');
  return `<section class="panel-card"><div class="teacher-section-heading"><div><h3>Notifikasi</h3><p class="panel-subtitle">Pemberitahuan pendaftaran dan perubahan status peserta pada kelas yang Anda ampu.</p></div><span class="teacher-count-badge">${notifications.filter(n => !n.read_at).length} belum dibaca</span></div><div class="teacher-notification-list">${rows || abtTeacherEmpty('Belum ada notifikasi. Pemberitahuan akan muncul saat ada pendaftaran baru atau perubahan status.')}</div></section>`;
}

async function abtTeacherMarkNotificationRead(id) {
  if (!abtTeacherAllowed()) return;
  const { error } = await supabaseClient.rpc('mark_teacher_notification_read', { p_notification_id: id });
  if (error) { alert(`Gagal memperbarui notifikasi: ${error.message}`); return; }
  await renderDashboardPage('notifications');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-read-notification]');
  if (button) abtTeacherMarkNotificationRead(button.dataset.readNotification);
});

async function loadTeacherProfile() {
  if (!abtTeacherAllowed()) return abtTeacherDenied();
  const { data: photo, error } = await supabaseClient.from('teacher_profile_photos')
    .select('storage_path').eq('profile_id', currentUser.id).maybeSingle();
  if (error) return loadProfile() + abtTeacherSchemaNotice(error);
  const url = photo?.storage_path ? await abtTeacherSignedUrl(ABT_TEACHER_AVATAR_BUCKET, photo.storage_path) : '';
  const avatar = url ? `<img class="teacher-avatar-preview" src="${safeText(url)}" alt="Foto profil pengajar">` : `<div class="teacher-avatar-preview teacher-avatar-fallback">${safeText((currentProfile?.full_name || 'P').trim().charAt(0).toUpperCase())}</div>`;
  return `<section class="panel-card teacher-avatar-card"><div class="teacher-avatar-layout">${avatar}<div><h3>Foto Profil</h3><p class="panel-subtitle">Unggah foto JPG, PNG, atau WebP. Maksimum 5 MB. Foto hanya dapat dikelola oleh pemilik akun.</p><form id="abtTeacherAvatarForm"><input id="abtTeacherAvatarFile" type="file" accept="image/jpeg,image/png,image/webp" required><div class="teacher-form-actions"><button class="app-button" type="submit">Simpan Foto</button><span class="teacher-feedback" id="abtTeacherAvatarFeedback" role="status"></span></div></form></div></div></section>${loadProfile()}`;
}

async function abtTeacherSaveAvatar(event) {
  if (!abtTeacherAllowed()) return;
  event.preventDefault();
  const form = event.currentTarget;
  const file = document.getElementById('abtTeacherAvatarFile').files[0];
  const feedback = document.getElementById('abtTeacherAvatarFeedback');
  const button = form.querySelector('[type="submit"]');
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { feedback.textContent = 'Pilih foto JPG, PNG, atau WebP.'; return; }
  if (file.size > 5 * 1024 * 1024) { feedback.textContent = 'Ukuran foto melebihi batas 5 MB.'; return; }
  button.disabled = true; feedback.textContent = 'Mengunggah foto…';
  const path = `${currentUser.id}/${abtTeacherUuid()}-${abtTeacherSafeFileName(file.name)}`;
  const { error: uploadError } = await supabaseClient.storage.from(ABT_TEACHER_AVATAR_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (uploadError) { feedback.textContent = `Unggah gagal: ${uploadError.message}`; button.disabled = false; return; }
  const { data: old } = await supabaseClient.from('teacher_profile_photos').select('storage_path').eq('profile_id', currentUser.id).maybeSingle();
  const { error } = await supabaseClient.from('teacher_profile_photos').upsert({ profile_id: currentUser.id, storage_path: path, updated_at: new Date().toISOString() }, { onConflict: 'profile_id' });
  if (error) {
    await supabaseClient.storage.from(ABT_TEACHER_AVATAR_BUCKET).remove([path]);
    feedback.textContent = `Gagal menyimpan foto: ${error.message}`;
    button.disabled = false;
    return;
  }
  if (old?.storage_path) await supabaseClient.storage.from(ABT_TEACHER_AVATAR_BUCKET).remove([old.storage_path]);
  await renderDashboardPage('profile');
}

document.addEventListener('submit', event => {
  if (event.target?.id === 'abtTeacherAvatarForm') abtTeacherSaveAvatar(event);
});
