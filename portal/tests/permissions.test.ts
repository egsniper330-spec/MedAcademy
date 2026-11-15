import { describe, expect, it } from 'vitest';
import {
  canAccessPath,
  canManageAccount,
  isStaffRole,
  ROUTE_RULES,
} from '../src/lib/permissions';

describe('portal role boundaries', () => {
  it('accepts only doctor, admin and super_admin as staff', () => {
    expect(isStaffRole('doctor')).toBe(true);
    expect(isStaffRole('admin')).toBe(true);
    expect(isStaffRole('super_admin')).toBe(true);
    expect(isStaffRole('student')).toBe(false);
    expect(isStaffRole('assistant')).toBe(false);
    expect(isStaffRole(null)).toBe(false);
  });

  it('rejects students from every portal route', () => {
    for (const rule of ROUTE_RULES) {
      expect(canAccessPath('student', rule.path), rule.path).toBe(false);
    }
  });

  it('keeps Super Admin routes away from doctors and admins', () => {
    for (const path of ['/branding', '/cms', '/feature-flags', '/app-updates', '/support', '/maintenance', '/security', '/system']) {
      expect(canAccessPath('doctor', path), path).toBe(false);
      expect(canAccessPath('admin', path), path).toBe(false);
      expect(canAccessPath('super_admin', path), path).toBe(true);
    }
  });

  it('gives doctors their workspace but not admin management', () => {
    expect(canAccessPath('doctor', '/courses')).toBe(true);
    expect(canAccessPath('doctor', '/students')).toBe(true);
    expect(canAccessPath('doctor', '/users')).toBe(false);
    expect(canAccessPath('doctor', '/audit')).toBe(false);
    expect(canAccessPath('doctor', '/devices')).toBe(false);
  });

  it('lets admins manage users but not administrators', () => {
    expect(canManageAccount('super_admin', 'super_admin')).toBe(true);
    expect(canManageAccount('super_admin', 'admin')).toBe(true);
    expect(canManageAccount('admin', 'doctor')).toBe(true);
    expect(canManageAccount('admin', 'student')).toBe(true);
    expect(canManageAccount('admin', 'admin')).toBe(false);
    expect(canManageAccount('admin', 'super_admin')).toBe(false);
    expect(canManageAccount('doctor', 'student')).toBe(false);
  });
});
