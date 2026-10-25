import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

// Inisialisasi Supabase (Menggunakan Environment Variables dari Vercel / .env)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-key';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function App() {
  const [session, setSession] = useState(null);
  const [userRole, setUserRole] = useState(null); // 'admin' | 'guru' | 'peserta'
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');

  // Cek sesi login saat aplikasi dimuat
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchUserRole(session.user.id);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchUserRole(session.user.id);
      else setUserRole(null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserRole = async (userId) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();
      
      if (data) setUserRole(data.role);
      else setUserRole('peserta'); // Default role jika belum diset admin
    } catch (err) {
      setUserRole('peserta');
    }
  };

  const handleGoogleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserRole(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-[#8CB82B]">
        <div className="text-xl font-semibold animate-pulse">Memuat Aplikasi Ayo Belajar Tajwid...</div>
      </div>
    );
  }

  // JIKA BELUM LOGIN (TAMPILAN HALAMAN UTAMA & LOGIN GOOGLE)
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-slate-100 text-center">
          {/* Logo Asli */}
          <div className="flex justify-center mb-6">
            <img 
              src="/AYO BELAJAR TAJWID.jpg" 
              alt="Ayo Belajar Tajwid" 
              className="h-24 object-contain rounded-lg shadow-sm"
            />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Pusat Layanan Tajwid</h1>
          <p className="text-slate-500 text-sm mb-8">Silakan masuk menggunakan akun Google resmi Anda yang terdaftar.</p>
          
          <button
            onClick={handleGoogleLogin}
            className="w-full flex items-center justify-center gap-3 bg-white border border-slate-300 rounded-xl py-3 px-4 text-slate-700 font-medium hover:bg-slate-50 transition shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
            Masuk dengan Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans">
      {/* Navbar Atas */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img src="/AYO BELAJAR TAJWID.jpg" alt="Logo" className="h-10 object-contain rounded" />
            <span className="font-bold text-slate-800 hidden sm:inline">Ayo Belajar Tajwid</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm bg-amber-100 text-amber-800 font-semibold px-3 py-1 rounded-full uppercase">
              Role: {userRole || 'Loading...'}
            </span>
            <button 
              onClick={handleLogout}
              className="text-sm text-red-600 hover:text-red-800 font-medium border border-red-200 px-3 py-1.5 rounded-lg transition"
            >
              Keluar
            </button>
          </div>
        </div>
      </header>

      {/* Konten Berdasarkan Role */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6">
        {userRole === 'admin' && <AdminDashboard />}
        {userRole === 'guru' && <GuruDashboard />}
        {userRole === 'peserta' && <PesertaDashboard />}
      </main>
    </div>
  );
}

// --- DASHBOARD ADMIN ---
function AdminDashboard() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Dashboard Admin</h2>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Guru Aktif</p>
          <h3 className="text-3xl font-bold text-[#8CB82B] mt-1">12</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Peserta Reguler & Privat</p>
          <h3 className="text-3xl font-bold text-amber-600 mt-1">148</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Kelas Aktif</p>
          <h3 className="text-3xl font-bold text-slate-800 mt-1">18</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Total Gaji Bulan Ini</p>
          <h3 className="text-3xl font-bold text-emerald-600 mt-1">Rp 12.4jt</h3>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-4">Manajemen Kelas & Penggajian Guru</h3>
        <p className="text-slate-500 text-sm">Fitur pencetakan slip gaji bulanan, invoice tagihan peserta, serta kontrol laporan pertemuan aktif tersedia di sini.</p>
      </div>
    </div>
  );
}

// --- DASHBOARD GURU ---
function GuruDashboard() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Dashboard Guru</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Murid Aktif Binaan</p>
          <h3 className="text-3xl font-bold text-[#8CB82B] mt-1">24</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Status Pencairan Gaji</p>
          <h3 className="text-xl font-bold text-emerald-600 mt-2">Sudah Dicairkan</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Jadwal Hari Ini</p>
          <h3 className="text-xl font-bold text-slate-800 mt-2">3 Sesi Kelas</h3>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-4">Pencatatan Pertemuan & Laporan Bulanan</h3>
        <p className="text-slate-500 text-sm">Gunakan menu ini untuk mencatat capaian tajwid peserta setiap sesi dan mengirimkan laporan bulanan.</p>
      </div>
    </div>
  );
}

// --- DASHBOARD PESERTA ---
function PesertaDashboard() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Dashboard Peserta</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Kelas Diikuti</p>
          <h3 className="text-3xl font-bold text-amber-600 mt-1">Tajwid Level 2</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Guru Pembimbing</p>
          <h3 className="text-xl font-bold text-slate-800 mt-2">Ustadz Ahmad</h3>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-slate-500 text-sm">Status Pembayaran</p>
          <h3 className="text-xl font-bold text-emerald-600 mt-2">Lunas</h3>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-4">Catatan Perkembangan & Jadwal Pertemuan</h3>
        <p className="text-slate-500 text-sm">Pantau hasil koreksi bacaan tajwid langsung dari laporan guru pembimbing Anda.</p>
      </div>
    </div>
  );
}
