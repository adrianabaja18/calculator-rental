'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ADMIN_ROLE_LABEL, APP_NAME, hasRole, type AdminRole } from '@calc-rental/shared';
import { signOut } from '@/lib/auth/actions';
import { ToastProvider } from '@/components/ui/toast';
import { Icon } from './icons';
import { NAV_SECTIONS } from './nav-items';

export interface ShellAdmin {
  email: string;
  fullName: string | null;
  role: AdminRole;
}

/**
 * Dashboard frame: sidebar (desktop) / slide-in drawer (mobile) + top header.
 * Rendered by app/(dashboard)/layout.tsx AFTER requireAdmin() succeeded.
 */
export function DashboardShell({ admin, children }: { admin: ShellAdmin; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer after navigating.
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Mobile backdrop */}
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Main navigation"
      >
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-700 text-sm font-bold text-white">₱</div>
          <span className="text-sm font-semibold leading-tight text-slate-900">{APP_NAME}</span>
          <button
            type="button"
            className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-100 lg:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <Icon name="close" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => {
            const items = section.items.filter((item) => hasRole(admin.role, item.minimumRole));
            if (items.length === 0) return null;
            return (
              <div key={section.title} className="mb-5">
                <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{section.title}</p>
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium ${
                            active ? 'bg-blue-50 text-blue-800' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                          }`}
                        >
                          <Icon name={item.icon} className={active ? 'text-blue-700' : 'text-slate-400'} />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
          >
            <Icon name="menu" />
          </button>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-900">{admin.fullName ?? admin.email}</p>
              <p className="text-xs text-slate-500">{ADMIN_ROLE_LABEL[admin.role]}</p>
            </div>
            <form action={signOut}>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Icon name="logout" width={16} height={16} />
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
    </div>
  );
}
