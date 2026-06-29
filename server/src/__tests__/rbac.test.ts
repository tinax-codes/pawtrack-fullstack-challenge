import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { store } from '../store/memory-store.js';

function headers(tenantId: string, userId: string, role: string) {
  return {
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    'x-user-role': role,
    'content-type': 'application/json',
  };
}

const portlandStaff = headers('tenant_portland', 'user_staff_portland', 'staff');
const portlandAdmin = headers('tenant_portland', 'user_admin_portland', 'admin');
const portlandSitter = headers('tenant_portland', 'sitter_001', 'sitter');
const portlandSitter2 = headers('tenant_portland', 'sitter_002', 'sitter');

describe('RBAC: sitter booking visibility', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    store.reset();
    app = buildApp();
  });

  it('sitter should only see bookings assigned to them', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?limit=50',
      headers: portlandSitter,
    });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((b: any) => b.sitterId === 'sitter_001')).toBe(true);
  });

  it('sitter should not see another sitter\'s bookings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?limit=50',
      headers: portlandSitter,
    });
    const body = JSON.parse(res.body);
    const hasSitter2 = body.data.some((b: any) => b.sitterId === 'sitter_002');
    expect(hasSitter2).toBe(false);
  });

  it('sitter should not access a booking assigned to another sitter by ID', async () => {
    // booking_002 is assigned to sitter_002
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings/booking_002',
      headers: portlandSitter,
    });
    expect(res.statusCode).toBe(404);
  });

  it('staff should see all bookings in their tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?limit=50',
      headers: portlandStaff,
    });
    const body = JSON.parse(res.body);
    const sitterIds = new Set(body.data.map((b: any) => b.sitterId));
    expect(sitterIds.size).toBeGreaterThan(1);
  });

  it('admin should see all bookings in their tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?limit=50',
      headers: portlandAdmin,
    });
    const body = JSON.parse(res.body);
    const sitterIds = new Set(body.data.map((b: any) => b.sitterId));
    expect(sitterIds.size).toBeGreaterThan(1);
  });
});

describe('RBAC: sitter status transitions', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    store.reset();
    app = buildApp();
  });

  it('sitter can mark their own confirmed booking as in_progress', async () => {
    // booking_001 is sitter_001, status: confirmed
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_001/status',
      headers: portlandSitter,
      body: JSON.stringify({ status: 'in_progress' }),
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
  });

  it('sitter can mark their own in_progress booking as completed', async () => {
    // booking_003 is sitter_001, status: in_progress
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_003/status',
      headers: portlandSitter,
      body: JSON.stringify({ status: 'completed' }),
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
  });

  it('sitter cannot confirm a booking', async () => {
    // booking_002 is sitter_002, status: requested
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_002/status',
      headers: portlandSitter2,
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sitter cannot cancel a booking', async () => {
    // booking_001 is sitter_001, status: confirmed
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_001/status',
      headers: portlandSitter,
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sitter cannot update another sitter\'s booking', async () => {
    // booking_003 is sitter_001, sitter_002 should not be able to update it
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_003/status',
      headers: portlandSitter2,
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('staff can confirm a booking', async () => {
    // booking_002 is status: requested
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_002/status',
      headers: portlandStaff,
      body: JSON.stringify({ status: 'confirmed' }),
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
  });

  it('staff can cancel a booking', async () => {
    // booking_001 is status: confirmed
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_001/status',
      headers: portlandStaff,
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('RBAC: sitter cannot create bookings', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    store.reset();
    app = buildApp();
  });

  it('sitter should be rejected from creating a booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: portlandSitter,
      body: JSON.stringify({
        petId: 'pet_001',
        sitterId: 'sitter_001',
        scheduledDate: '2026-08-01',
        startTime: '09:00',
        endTime: '11:00',
        notes: 'test',
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('staff can create a booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: portlandStaff,
      body: JSON.stringify({
        petId: 'pet_001',
        sitterId: 'sitter_001',
        scheduledDate: '2026-09-01',
        startTime: '09:00',
        endTime: '11:00',
        notes: 'test',
      }),
    });
    expect(res.statusCode).toBe(201);
  });
});
