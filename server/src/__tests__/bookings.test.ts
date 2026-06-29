import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { store } from '../store/memory-store.js';

function headers(tenantId: string, userId: string) {
  return {
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    'content-type': 'application/json',
  };
}

const portland = headers('tenant_portland', 'user_staff_portland');
const seattle = headers('tenant_seattle', 'user_staff_seattle');

describe('tenant isolation', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    store.reset();
    app = buildApp();
  });

  // Bug #1: tenantId query param override
  it('GET /api/bookings should ignore tenantId query param override', async () => {
    // A Portland user should NOT be able to see Seattle bookings via query param
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?tenantId=tenant_seattle&limit=50',
      headers: portland,
    });
    const body = JSON.parse(res.body);
    // The total count should reflect Portland bookings (10), not Seattle (5)
    expect(body.total).toBe(10);
  });

  // Bug #2: GET /api/bookings/:id has no tenant check
  it('GET /api/bookings/:id should not return bookings from another tenant', async () => {
    // booking_007 belongs to tenant_seattle
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings/booking_007',
      headers: portland,
    });
    expect(res.statusCode).toBe(404);
  });

  // Bug #3: PATCH /api/bookings/:id/status has no tenant check
  it('PATCH /api/bookings/:id/status should reject cross-tenant updates', async () => {
    // booking_007 belongs to tenant_seattle, portland user should not be able to update it
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/bookings/booking_007/status',
      headers: portland,
      body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('HTTP status codes', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    store.reset();
    app = buildApp();
  });

  // Bug #8: errors return 200 instead of proper status codes
  it('GET /api/bookings/:id should return 404 for non-existent booking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings/booking_nonexistent',
      headers: portland,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/bookings should return 400 or 409 on validation failure', async () => {
    // Create a booking, then create an overlapping one
    await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: portland,
      body: JSON.stringify({
        petId: 'pet_001',
        sitterId: 'sitter_001',
        scheduledDate: '2026-06-01',
        startTime: '09:00',
        endTime: '11:00',
        notes: 'test',
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/bookings',
      headers: portland,
      body: JSON.stringify({
        petId: 'pet_002',
        sitterId: 'sitter_001',
        scheduledDate: '2026-06-01',
        startTime: '10:00',
        endTime: '12:00',
        notes: 'overlapping',
      }),
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('pagination', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    store.reset();
    app = buildApp();
  });

  // Bug #7: offset = page * limit instead of (page - 1) * limit
  it('page 1 should return the first set of results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/bookings?page=1&limit=5',
      headers: portland,
    });
    const body = JSON.parse(res.body);
    // Portland has 10 bookings. Page 1 with limit 5 should return 5 items.
    expect(body.data.length).toBe(5);
    expect(body.total).toBe(10);

    // Page 2 should return different bookings
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/bookings?page=2&limit=5',
      headers: portland,
    });
    const body2 = JSON.parse(res2.body);
    expect(body2.data.length).toBe(5);

    // No overlap between pages
    const page1Ids = body.data.map((b: any) => b.id);
    const page2Ids = body2.data.map((b: any) => b.id);
    const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
    expect(overlap).toHaveLength(0);
  });
});

describe('double-booking race condition', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    store.reset();
    app = buildApp();
  });

  // Bug #5: concurrent requests can both pass overlap check
  it('concurrent identical bookings should not both succeed', async () => {
    const bookingData = {
      petId: 'pet_001',
      sitterId: 'sitter_001',
      scheduledDate: '2026-07-01',
      startTime: '09:00',
      endTime: '11:00',
      notes: 'race test',
    };

    const results = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: portland,
        body: JSON.stringify(bookingData),
      }),
      app.inject({
        method: 'POST',
        url: '/api/bookings',
        headers: portland,
        body: JSON.stringify(bookingData),
      }),
    ]);

    const bodies = results.map(r => JSON.parse(r.body));
    const successes = bodies.filter(b => b.success === true);
    expect(successes).toHaveLength(1);
  });
});
