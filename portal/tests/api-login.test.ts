import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearSession, getRefreshToken, login } from '../src/lib/api';

const studentUser = {
  id: 'u-student', email: 'student@example.com', full_name: 'Student',
  role: 'student', status: 'active',
};

const doctorUser = {
  id: 'u-doctor', email: 'doctor@example.com', full_name: 'Doctor',
  role: 'doctor', status: 'active',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('portal authentication', () => {
  beforeEach(() => {
    clearSession();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a student response without storing a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      user: studentUser,
      session: { access_token: 'a', refresh_token: 'r', expires_in: 900, token_type: 'bearer' },
    })));

    await expect(login('student@example.com', 'secret')).rejects.toBeInstanceOf(ApiError);
    await expect(login('student@example.com', 'secret')).rejects.toMatchObject({ code: 'portal_role_forbidden' });
    expect(getRefreshToken()).toBeNull();
  });

  it('stores a doctor session after a successful staff login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      user: doctorUser,
      session: { access_token: 'access', refresh_token: 'refresh', expires_in: 900, token_type: 'bearer' },
    })));

    const user = await login('doctor@example.com', 'secret');
    expect(user.role).toBe('doctor');
    expect(getRefreshToken()).toBe('refresh');
  });

  it.each(['admin', 'super_admin'] as const)('accepts a %s session', async (role) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      user: { ...doctorUser, id: `u-${role}`, role, email: `${role}@example.com` },
      session: { access_token: 'access', refresh_token: 'refresh', expires_in: 900, token_type: 'bearer' },
    })));
    const user = await login(`${role}@example.com`, 'secret');
    expect(user.role).toBe(role);
    expect(getRefreshToken()).toBe('refresh');
  });

  it('surfaces a server role rejection message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      message: 'This portal is for doctors, administrators and super administrators only.',
      code: 'portal_role_forbidden',
    }, 403)));

    await expect(login('student@example.com', 'secret')).rejects.toMatchObject({
      status: 403,
      message: 'This portal is for doctors, administrators and super administrators only.',
    });
  });
});
