// Single source of truth for role-based access. The API enforces these; the UI only mirrors them.
export const ROLES = ['super_admin', 'admin', 'manager', 'cashier', 'receptionist'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  receptionist: 'Receptionist',
};

export const PERMISSIONS = [
  'dashboard.view', 'dashboard.financials',
  'pos.use',
  'players.view', 'players.manage',
  'courts.view', 'courts.manage',
  'reservations.view', 'reservations.manage',
  'memberships.view', 'memberships.manage',
  'pricing.manage',
  'catalog.view',
  'inventory.manage', 'services.manage', 'rentals.manage',
  'discounts.manage', 'discounts.approve',
  'transactions.view',
  'refunds.request', 'refunds.approve',
  'shifts.own', 'shifts.view_all',
  'expenses.view', 'expenses.create', 'expenses.approve',
  'reports.view',
  'employees.manage',
  'settings.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const all = [...PERMISSIONS];
const without = (...p: Permission[]) => all.filter((x) => !p.includes(x));

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: all,
  admin: without('employees.manage', 'settings.manage', 'pricing.manage'),
  manager: [
    'dashboard.view', 'dashboard.financials', 'players.view', 'courts.view', 'reservations.view', 'memberships.view',
    'catalog.view', 'transactions.view', 'refunds.request', 'refunds.approve', 'discounts.approve', 'shifts.view_all',
    'expenses.view', 'expenses.approve', 'reports.view', 'audit.view',
  ],
  cashier: [
    'dashboard.view', 'pos.use', 'players.view', 'players.manage', 'courts.view', 'reservations.view', 'reservations.manage',
    'memberships.view', 'catalog.view', 'rentals.manage', 'transactions.view', 'refunds.request', 'shifts.own', 'expenses.create',
  ],
  receptionist: [
    'dashboard.view', 'players.view', 'players.manage', 'courts.view', 'reservations.view', 'reservations.manage',
    'memberships.view', 'catalog.view',
  ],
};

export const roleCan = (role: Role, permission: Permission) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false;

export const PAYMENT_METHODS = ['cash', 'gcash', 'maya', 'bank_transfer', 'credit_card', 'debit_card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash', gcash: 'GCash', maya: 'Maya', bank_transfer: 'Bank Transfer', credit_card: 'Credit Card', debit_card: 'Debit Card',
};
