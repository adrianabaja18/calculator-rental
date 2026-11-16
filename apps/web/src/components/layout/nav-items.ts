import { AdminRole } from '@calc-rental/shared';
import type { IconName } from './icons';

/**
 * Sidebar navigation — the single list of dashboard pages.
 * `minimumRole` hides links a role can't use (the page itself ALSO checks,
 * hiding a link is only a convenience, not security).
 */
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  minimumRole: AdminRole;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: 'dashboard', minimumRole: AdminRole.VIEWER }],
  },
  {
    title: 'Operations',
    items: [
      { href: '/rentals', label: 'Active Rentals', icon: 'rentals', minimumRole: AdminRole.VIEWER },
      { href: '/transactions', label: 'Transaction History', icon: 'transactions', minimumRole: AdminRole.VIEWER },
      { href: '/payments', label: 'Payments', icon: 'payments', minimumRole: AdminRole.VIEWER },
      { href: '/penalties', label: 'Penalties', icon: 'penalties', minimumRole: AdminRole.VIEWER },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { href: '/calculators', label: 'Calculators', icon: 'calculators', minimumRole: AdminRole.VIEWER },
      { href: '/lockers', label: 'Lockers', icon: 'lockers', minimumRole: AdminRole.VIEWER },
      { href: '/students', label: 'Students', icon: 'students', minimumRole: AdminRole.VIEWER },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/devices', label: 'Device Status', icon: 'devices', minimumRole: AdminRole.VIEWER },
      { href: '/events', label: 'Event Logs', icon: 'events', minimumRole: AdminRole.VIEWER },
      { href: '/audit', label: 'Audit Log', icon: 'audit', minimumRole: AdminRole.OFFICER },
      { href: '/settings', label: 'Settings', icon: 'settings', minimumRole: AdminRole.VIEWER },
    ],
  },
];
