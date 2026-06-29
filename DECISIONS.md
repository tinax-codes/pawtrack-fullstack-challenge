# Full-Stack Engineering Decisions

## Audit Findings

### Critical

#### 1. Broken multi-tenant isolation on GET /api/bookings
- **User story**: A Portland staff member opens the dashboard and sees bookings for Seattle clients — pet names, owner phone numbers, sitter schedules — data they should never have access to. A curious or malicious user could enumerate every tenant's bookings by changing a URL parameter.
- **File**: `server/src/routes/bookings.ts:21`
- **Issue**: The `tenantId` used for querying bookings can be overridden via a query parameter (`query.tenantId || auth.tenantId`). Any authenticated user can view another tenant's bookings by passing `?tenantId=tenant_seattle`.
- **Impact**: Complete tenant data isolation breach. This is the reported bug — "a customer seeing another customer's bookings."
- **Severity**: Critical
- **Fix**: Removed `query.tenantId` fallback. The route now always uses `auth.tenantId` from the authenticated context, ignoring any tenant override in query parameters. Also removed `tenantId` from the query type definition.

#### 2. Missing tenant isolation on GET /api/bookings/:id
- **User story**: A staff member bookmarks a booking detail link. They tweak the booking ID in the URL (e.g., changing `booking_001` to `booking_007`) and can now read a Seattle booking's notes, which include the pet owner's home address and key location.
- **File**: `server/src/routes/bookings.ts:42-49`
- **Issue**: No tenant check when fetching a single booking. Any authenticated user can retrieve any booking by ID, regardless of which tenant it belongs to.
- **Impact**: Cross-tenant data exposure. Part of the same reported issue as #1 — applied to individual booking lookups.
- **Severity**: Critical
- **Fix**: Added `auth.tenantId` check — the route now extracts the auth context and compares `booking.tenantId !== auth.tenantId`, returning 404 if the booking doesn't belong to the caller's tenant. Uses 404 (not 403) to avoid confirming that the booking ID exists in another tenant.

#### 3. Missing tenant isolation on PATCH /api/bookings/:id/status
- **User story**: A disgruntled employee in Portland cancels all of Seattle's confirmed bookings for the week. Seattle sitters don't show up, pet owners are stranded, and Seattle staff have no idea why bookings keep getting cancelled.
- **File**: `server/src/routes/bookings.ts:89-97`
- **Issue**: No tenant check when updating booking status. Any authenticated user can change any booking's status across tenants.
- **Impact**: Cross-tenant data modification. Extends #1 and #2 — not only can another tenant's bookings be viewed, they can be modified.
- **Severity**: Critical
- **Fix**: Same pattern as #2 — added tenant ownership check before allowing the status update. Returns 404 for cross-tenant attempts. Also returns 400 for invalid state transitions instead of 200.

#### 4. XSS via unsanitized HTML rendering
- **User story**: A pet owner submits a booking with special instructions that contain a script tag in the notes field. When a staff member opens the dashboard, the script runs silently in their browser — it could steal their session, redirect them to a phishing page, or modify bookings on their behalf without them noticing.
- **File**: `client/app.js:129` and `server/src/store/seed.ts:24,69`
- **Issue**: Booking notes are rendered directly into the DOM using `innerHTML` with no escaping. The seed data even contains proof-of-concept payloads: `<img src=x onerror="alert(1)">` in pet_005's notes and `<b>` HTML tags in booking_005's notes.
- **Impact**: Stored XSS — any user who can write booking notes can execute arbitrary JavaScript in other users' browsers.
- **Severity**: Critical
- **Fix**: Added an `escapeHtml()` helper in `client/app.js` that uses `textContent`/`innerHTML` to safely escape HTML entities. Applied it to `booking.notes` in the render template.

### High

#### 5. Double-booking race condition
- **User story**: Two staff members both try to book Maria Chen for Saturday 9-11am at the same moment. Both get a "Booking created!" confirmation. Maria shows up to one address, the other pet owner waits at home wondering where their sitter is. The company gets an angry call and a one-star review.
- **File**: `server/src/services/booking-service.ts:73-88`
- **Issue**: The overlap check (read) and booking creation (write) are not atomic. A simulated async delay (`await setTimeout`) between the check and the insert creates a window where two concurrent requests for the same sitter/timeslot both pass validation and both succeed.
- **Impact**: Double-bookings — the same sitter gets assigned to two overlapping bookings and can't be in two places at once. This matches the reported bug.
- **Severity**: High
- **Fix**: Added a per-sitter mutex using a `Map<string, Promise<void>>`. Concurrent booking requests for the same sitter are serialized — the second request waits for the first to complete (including the write) before running its overlap check. This ensures the check-then-write is atomic per sitter without blocking unrelated sitters.

#### 6. Pagination off-by-one error
- **User story**: A staff member opens the dashboard and doesn't see today's new bookings. They think the system lost them, so they re-create the bookings manually — now there are duplicates. Or they just don't notice and a pet goes unvisited.
- **File**: `server/src/services/booking-service.ts:53`
- **Issue**: Offset is calculated as `page * limit` instead of `(page - 1) * limit`. For page 1 with limit 5, this skips the first 5 results entirely, returning what should be page 2's data.
- **Impact**: Users never see the most recent bookings on page 1. Page navigation is shifted by one page throughout.
- **Severity**: High
- **Fix**: Changed offset calculation from `page * limit` to `(page - 1) * limit`.

#### 7. Error responses return HTTP 200
- **User story**: A staff member tries to confirm a booking that was already cancelled. The API returns 200, so the dashboard shows no error — the staff member believes the booking is confirmed and tells the pet owner their sitter is coming. The sitter never shows up.
- **File**: `server/src/routes/bookings.ts:46,79-81`
- **Issue**: Multiple error conditions return HTTP 200 with an error message in the body — "Booking not found" on GET, validation/overlap failures on POST, and status update failures on PATCH. This breaks REST conventions and makes client-side error handling unreliable.
- **Impact**: Frontend error handling silently treats failures as successes.
- **Severity**: High
- **Fix**: GET /api/bookings/:id now returns 404 for not-found. POST /api/bookings returns 201 on success and 409 on overlap conflict. PATCH /api/bookings/:id/status returns 404 for not-found and 400 for invalid state transitions.

### Medium

#### 8. Stale data from out-of-order responses
- **User story**: A staff member filters the dashboard to show only "requested" bookings so they can work through approvals. The filtered results appear, but a moment later the list jumps back to showing all bookings. They re-apply the filter, start reviewing, and it resets again. They give up and start using a spreadsheet instead.
- **File**: `client/app.js:72-107`
- **Issue**: There is no request cancellation. When the user changes a filter, a new fetch fires — but the previous in-flight request (from the 15-second poll or a prior filter change) is still pending. If the older response arrives after the newer one, it overwrites the DOM with stale data.
- **Impact**: UX bug — "filters seem to reset randomly." This matches the reported complaint from staff. The dashboard becomes unreliable for any workflow that depends on stable filter state.
- **Severity**: Medium
- **Fix**: Two changes: (1) Added an `AbortController` to `fetchBookings()` — each new request aborts the previous in-flight request, so stale responses are discarded and never render. Aborted fetches throw `AbortError`, which is caught and silently ignored. (2) Changed filter updates to mutate the existing `filters` object instead of reassigning, as a code quality cleanup.

#### 9. Auth middleware doesn't validate user identity or role
- **User story**: A sitter who should only see their own assignments sends a request with `X-User-Role: admin` and gains full access to manage all bookings, view all client details, and cancel other sitters' appointments.
- **File**: `server/src/middleware/auth.ts:22`
- **Issue**: The `userId` is accepted from the request header with no validation against any user store. The `role` header is also unvalidated — any caller can self-assign the `admin` role. While this is noted as a simplification for the challenge, it means there is zero access control enforcement.
- **Impact**: Any caller can impersonate any user or elevate to admin. In production this would be a critical auth bypass.
- **Severity**: Medium (acknowledged as simplified for the challenge)

#### 10. No input validation on booking creation
- **User story**: A staff member accidentally selects the wrong date format or leaves the sitter field empty. The booking is created with garbage data — it shows up in the list with "undefined" for the sitter name, and no one can figure out who's supposed to visit the pet.
- **File**: `server/src/routes/bookings.ts:56-83`
- **Issue**: The POST /api/bookings endpoint does not validate that `petId` or `sitterId` exist or belong to the authenticated tenant. No validation of date/time formats. No check that `endTime` is after `startTime`. No check for required fields.
- **Impact**: Orphaned bookings with invalid references. Potential data integrity issues.
- **Severity**: Medium

### Low

#### 11. Cross-tenant overlap check
- **User story**: As the platform grows, booking creation slows down because the overlap check scans every tenant's bookings. If conflict error messages ever included details, they could leak another franchise's schedule.
- **File**: `server/src/services/booking-service.ts:73-74`
- **Issue**: The overlap check uses `store.getAllBookings()` instead of `store.getBookingsByTenant(tenantId)`, scanning across all tenants unnecessarily.
- **Impact**: Minimal today due to unique IDs, but a latent data leakage risk and performance concern.
- **Severity**: Low
- **Fix**: Changed `store.getAllBookings()` to `store.getBookingsByTenant(tenantId)` in the overlap check, scoping it to the current tenant.

#### 12. CORS allows all origins
- **User story**: A staff member visits a malicious website while logged into PawTrack. The website silently makes API requests to the PawTrack backend using the staff member's browser session, reading booking data or modifying records without the staff member ever knowing.
- **File**: `server/src/index.ts:11`
- **Issue**: `origin: true` accepts requests from any origin. In production this should be restricted to known frontend domains.
- **Impact**: Any website can make authenticated API requests if a user's browser has valid auth context.
- **Severity**: Low (acceptable for local development)

## Root Cause Analysis: Three Customer Complaints

### "A customer reported seeing another customer's bookings"

**Data flow (before fix):**
1. Portland staff opens the dashboard → `app.js` sends `GET /api/bookings` with header `X-Tenant-Id: tenant_portland`
2. The route handler at `bookings.ts:21` had: `const tenantId = query.tenantId || auth.tenantId`
3. If `?tenantId=tenant_seattle` appears in the URL, the query param takes precedence over the authenticated tenant
4. `bookingService.listBookings({ tenantId: 'tenant_seattle' })` → `store.getBookingsByTenant('tenant_seattle')` → returns Seattle's bookings
5. Portland staff sees Seattle's pet names, owner phone numbers, and sitter schedules

The same tenant isolation gap existed on two other endpoints — `GET /api/bookings/:id` had no tenant check at all (any user could fetch any booking by ID), and `PATCH /api/bookings/:id/status` allowed any user to modify any booking's status across tenants.

**Fix:** Three changes that close the entire class of bugs:
- `GET /api/bookings`: removed `query.tenantId` override, always uses `auth.tenantId`
- `GET /api/bookings/:id`: added `booking.tenantId !== auth.tenantId` check → returns 404
- `PATCH /api/bookings/:id/status`: same tenant ownership check → returns 404

All three return 404 (not 403) to avoid confirming that a resource exists in another tenant.

### "A double-booking happened last week"

**Data flow (before fix):**
1. Staff member A creates a booking: `POST /api/bookings` with `sitterId: sitter_001`, April 10, 9:00–11:00
2. At the same moment, Staff member B creates a booking: same sitter, same date, 10:00–12:00
3. Both requests enter `createBooking()` in `booking-service.ts`
4. Request A: reads existing bookings → no overlap found → hits `await setTimeout(10ms)` (simulating a DB write)
5. Request B: reads existing bookings *at the same time* → Request A hasn't written yet → no overlap found → hits the same `await`
6. Both pass the overlap check, both write to the store
7. `sitter_001` now has two overlapping bookings

The core problem: the overlap check (read) and the booking insert (write) had an async gap between them. Both requests read the "before" state, both concluded there was no conflict.

**Fix:** Added a per-sitter mutex using a `Map<string, Promise<void>>`. When Request A enters, it acquires the lock for `sitter_001`. Request B sees the lock and waits. Request A completes its check and write, then releases the lock. Request B proceeds, runs its overlap check, and now finds Request A's booking → throws a 409 conflict. The mutex is per-sitter, so bookings for different sitters are not blocked.

### "Staff say the dashboard sometimes shows stale data — filters seem to reset randomly"

**Data flow (before fix):**
1. The dashboard polls `GET /api/bookings` every 15 seconds via `setInterval`
2. The poll fires → `fetchBookings()` sends a request with no status filter
3. While that response is in flight, staff selects "requested" filter → a new `fetchBookings()` fires with `status=requested`
4. The filtered response arrives first → dashboard shows only "requested" bookings
5. The poll's unfiltered response arrives late → overwrites the DOM with all bookings → filters appear to "reset"

The initial analysis pointed to a stale closure (the `setInterval` callback capturing an old `filters` reference). On deeper investigation, this was incorrect — JavaScript closures over `let` variables read the current value each time. The real root cause is the lack of request cancellation: there's nothing preventing a slow, outdated response from overwriting a newer one.

**Fix:** Added an `AbortController` to `fetchBookings()`. Each new call aborts the previous in-flight request before starting a new one. When a request is aborted, the browser throws an `AbortError`, which we catch and silently ignore. This guarantees only the most recent request's response ever renders.

## API Design

### Status codes
The original API returned HTTP 200 for everything, including errors. I aligned responses with REST conventions:
- **201 Created** for successful POST /api/bookings
- **404 Not Found** for missing or cross-tenant bookings (deliberately not 403, to avoid confirming that a resource exists in another tenant)
- **409 Conflict** for overlapping booking attempts
- **400 Bad Request** for invalid state transitions
- **403 Forbidden** for role-based access violations (e.g., sitter trying to create a booking)

### Conventions
- Error responses use a consistent `{ error: "message" }` shape
- Success responses use `{ data: ... }` for reads and `{ success: true, data: ... }` for writes
- For production, I would adopt RFC 7807 problem details for errors (structured `type`, `title`, `status`, `detail` fields) to give API consumers machine-readable error handling

### Production evolution
The first thing I'd change is auth — header-based tenant/user identification is the biggest gap between this codebase and production. JWT tokens validated against a user store would close bug #9 (unvalidated identity) and make the RBAC improvement meaningful beyond the honor system. After that, Fastify JSON schema validation for request bodies — it's low effort and gives you input validation plus auto-generated OpenAPI docs from the same schema definition. Rate limiting and API versioning matter but they're scaling concerns, not correctness concerns.

## Architecture Observations

### What works well
- **Service layer separation**: Business logic lives in `BookingService`, not in route handlers. Routes handle HTTP concerns (auth, status codes, request parsing); the service handles domain logic (overlap checks, state transitions).
- **Event bus**: The `eventBus` pattern decouples side effects (notifications, logging) from core operations. It's lightweight and appropriate for this scale.
- **In-memory store with reset**: The singleton store with `reset()` makes testing straightforward — no database setup, no teardown, no flaky state between tests.

### Anti-patterns found
- **Tenant isolation was enforced inconsistently**: Some endpoints checked tenant ownership (pets), others didn't (bookings). This is the kind of bug that keeps happening until you fix it structurally — a code review checklist won't catch it reliably. A `getTenantScopedBooking(id, tenantId)` method in the store would make it impossible to forget the check.
- **No separation between "not found" and "not authorized"**: The fix uses 404 for both intentionally, but a production system might want internal logging to distinguish the two.
- **Role is unused**: The `AuthContext` has a `role` field that was never checked anywhere. The RBAC improvement addresses this.

### What I would change with more time
The highest-leverage change is moving tenant scoping into the store layer so every query is tenant-scoped by default — this eliminates the entire class of bugs we found in #1-3 structurally, not just per-endpoint. Adding a `User` entity with role mappings and a status transition audit log are important but they're additive features, not fixes for a systemic risk.

## Frontend Approach

### Changes made
- **XSS fix**: Added `escapeHtml()` to sanitize booking notes before rendering via `innerHTML`. Uses the browser's own `textContent` → `innerHTML` conversion, which is reliable and doesn't require a library.
- **Stale data fix**: The root cause of "filters resetting" was out-of-order responses — a slow poll response arriving after a newer filter response would overwrite the DOM with stale data. Added an `AbortController` so each new fetch cancels the previous in-flight request. Also changed filter updates to mutate the `filters` object instead of reassigning as a code quality cleanup.

### What I would use in production
For a dashboard like this, I'd use **React** with a lightweight data-fetching library like **TanStack Query (React Query)**:
- React eliminates the `innerHTML` XSS risk entirely — JSX escapes by default
- React Query handles polling, caching, and stale data management — the exact class of bugs we found with the filter/polling interaction
- Component-based architecture makes it easier to add features (sitter view vs. staff view) without the current monolithic `app.js` growing unwieldy

That said, for a 5-page admin tool with 2-3 developers, vanilla JS with proper escaping is defensible — the complexity budget matters.

### Low-effort, high-impact quick wins
- **Display pet and sitter names instead of IDs** — the dashboard shows `pet_001` and `sitter_001`, which means nothing to staff. The pet and sitter data is already fetched in `loadPetsAndSitters()` — building a lookup map and using it in the booking cards is ~10 lines of code, and immediately makes the dashboard usable.
- **Disable action buttons while requests are in flight** — clicking "confirm" twice quickly fires two PATCH requests. Adding a `disabled` flag during the request prevents double-submits and avoids confusing toast stacking.
- **Show booking form errors inline** — errors currently appear as toast notifications that auto-dismiss after 3 seconds. If a staff member looks away, they miss it. Inline validation messages next to the form fields persist until corrected.
- **Add a "clear filters" button** — once you set a date filter, there's no obvious way to return to "all dates" without manually clearing the input field. A single reset button next to the filters improves discoverability.

## Improvement Implemented

### Test suite + Role-based access control

**Test suite** (Phase 2): I wrote failing tests for every server-side bug before fixing them. This approach proved the bugs existed, defined "fixed" unambiguously, and prevents regressions. The test suite uses Vitest with Fastify's `inject()` method — no server startup needed, fast feedback loop.

**RBAC** (Phase 3): I implemented role-based access control that enforces the real business model — sitters are external contractors who show up and do the work, staff run the office:

| Role | List bookings | View by ID | Create | Confirm/Cancel | Start/Complete |
|------|--------------|------------|--------|----------------|----------------|
| Admin | All in tenant | All in tenant | Yes | Yes | Yes |
| Staff | All in tenant | All in tenant | Yes | Yes | Yes |
| Sitter | Own assignments only | Own only | No | No | Own only |

**Why RBAC**: Sitters are external contractors with access to customer PII (addresses, phone numbers, pet care instructions). Limiting what they can see and do is a direct business risk — a sitter shouldn't be able to browse the full client list or cancel someone else's booking. The permission model enforces the real-world trust boundary between office staff and field contractors.

**Design decisions**:
- RBAC checks live in the route layer, not the service — keeps the service role-agnostic and reusable
- Sitter accessing another sitter's booking returns 404 (not 403) — same information-hiding pattern as tenant isolation
- Sitter attempting a forbidden action on their own booking returns 403 — they can see it, so hiding it is pointless; the issue is permission
- The current model assumes `userId` matches `sitterId` in booking data. In production, a user-to-sitter mapping table would decouple identity from assignment — but that requires the `User` entity mentioned in Architecture Observations

## Improvements Proposed

When inheriting a struggling scheduling system, I evaluate in roughly this order: (1) is the system **correct** — no double bookings, no data inconsistencies? (2) is it **secure** — proper tenant isolation, authorization? (3) is it **maintainable** — tested, modular, easy to extend? I deprioritized reliability, observability, performance, and scalability because this is an in-memory system designed for a code challenge — evaluating those dimensions wouldn't be meaningful here. The two improvements below follow this priority order: data correctness first, then maintainability.

### 1. Data correctness: normalized time representation + complete conflict detection
This improvement addresses two related problems in the booking creation flow.

**Problem A: Time normalization** — `scheduledDate` is stored inconsistently across bookings. Some use UTC (`2026-04-09T06:30:00Z`), others use local offsets (`2026-04-10T09:00:00-07:00`). This causes two downstream bugs:
  - The date filter uses `startsWith(date)`, which breaks for overnight or timezone-shifted bookings (e.g., 11:30 PM Pacific is stored as next-day UTC — filtering by April 8 misses it)
  - The overlap check constructs datetimes by concatenating date and time strings, which is fragile and timezone-unaware

  The fix: add a `normalizeScheduledDate()` helper that converts all dates to consistent UTC storage with the tenant timezone preserved separately. Run a backward-compatible migration to backfill existing seed data. Replace the `startsWith` filter with proper datetime range comparison.

**Problem B: Complete conflict detection** — the double-booking fix (bug #5) only addresses one dimension: sitter conflicts (one sitter can't be in two places at once). The other dimension is pet conflicts — the same pet shouldn't have two overlapping bookings with different sitters. Both are double-bookings, just from different perspectives. Additionally, the conflict check and insert should be encapsulated in a single store method (`reserveBookingSlot`) — this moves the per-sitter mutex and the overlap logic into the data layer where it belongs, rather than managing concurrency in the service layer.

- **Why**: This was my highest priority fix — ahead of RBAC and all other improvements — because a booking system that can produce incorrect bookings undermines the core value of the product. I implemented RBAC as the coded improvement instead because this refactor touches multiple layers (types, store, service, migration) and requires 3-4 hours to do well. Rushing it would risk introducing new bugs in the time model.
- **Estimated effort**: 3-4 hours. The dependency chain is: time normalization first → then the filter fix, atomic store operations, and pet conflict check can proceed in parallel.
- **Trade-offs**:
  - **Problem A**: The time normalization is the riskiest part — changing the `scheduledDate` format means every piece of code that parses it (date filter, overlap check, frontend date display) must update simultaneously. That's why it gates everything else.
  - **Problem B**: `reserveBookingSlot` encapsulates the existing per-sitter mutex inside the store layer — same concurrency guarantee, better architectural location. However, both the current mutex and the store-level approach are in-process only and wouldn't survive horizontal scaling. In production, a database `SELECT FOR UPDATE` or unique constraint on `(sitter_id, scheduled_date, start_time)` would enforce atomicity regardless of how many API instances are running.

### 2. Frontend state management refactor (maintainability)
- **What**: The frontend isn't broken anymore — we fixed the stale filters and XSS — but it's fragile. The next feature addition will likely reintroduce the same class of state bugs because `app.js` has no state management layer. The refactor is about making the codebase safe to extend. Four parts, all in vanilla JS (no framework):
  1. **State store** (~1 hour) — a small reactive store that holds `filters`, `bookings`, `page`, `loading`, and `error` in one place. All mutations go through it. Polling and user actions read from the same source of truth, eliminating shared mutable state bugs.
  2. **Request coordinator** (~1 hour) — extend the `AbortController` pattern (already implemented for the stale data fix) into a general-purpose request coordinator. Add logic so the poll skips if a user-initiated request is in flight, and add request deduplication so identical concurrent fetches are collapsed into one.
  3. **Render cycle** (~1 hour) — decouple data fetching from rendering. The store emits a change event, a single `render()` function reads current state and updates the DOM. No more scattered `innerHTML` assignments across multiple functions.
  4. **Error/loading states** (~30 min) — centralized in the store so loading indicators and error messages are always consistent with what's actually happening.
- **Why**: Without this refactor, every new feature will reintroduce the same class of state bugs. The `AbortController` fix addresses the immediate problem, but the underlying architecture remains fragile.
- **Estimated effort**: 3-4 hours (state store + request coordinator + render cycle + testing)
- **Trade-offs**: This deliberately stays in vanilla JS rather than introducing React. The refactor applies the same principles React solves (single source of truth, unidirectional data flow, request cancellation) without the build tooling overhead. If the frontend grows beyond a single dashboard (sitter portal, owner self-service), React with TanStack Query would be the right longer-term investment — but that's a different scope.

## AI Usage

I used **Claude Code (Claude Sonnet 4.6)** as a pair programming partner throughout this challenge.

### How I used it
- **Code audit**: I started by building my own hypotheses about the three customer complaints — tracing each symptom to likely code paths before touching the code. I then pair programmed with Claude to verify each hypothesis: Claude read all server and client files and surfaced the 12 bugs documented above, and I validated each finding against my initial analysis. I asked clarifying questions (e.g., "is bug 12 by design?", "explain the business model") and adjusted severity ratings through discussion. Notably, Claude initially misdiagnosed bug #8 as a stale closure issue — I pushed for a deeper data flow trace, which revealed the real root cause was out-of-order responses requiring an `AbortController` fix.
- **Test-first development**: Claude wrote failing tests for each bug, then implemented fixes. I reviewed the test logic and fix approach before approving.
- **RBAC design**: I described the business model (sitters are contractors, staff manage the office) and Claude proposed the permission matrix. I chose RBAC based on the business risk of unauthorized access to customer PII.
- **Documentation**: Claude drafted the DECISIONS.md content; I directed the structure and asked for user stories to make technical findings more concrete.

### What I validated
- Every bug finding was verified against the actual code — I traced through the logic to confirm the issue was real
- Test assertions were reviewed to ensure they test the right condition (e.g., the tenant override test needed adjustment because the pagination bug was masking it)
- RBAC design decisions were discussed: why 404 vs 403, why route-layer vs service-layer, what transitions sitters should be allowed

### What I chose not to use AI for
- **Diagnosing the three main customer problems**: I traced each customer complaint ("seeing another customer's bookings", "double-booking", "filters reset") to its root cause in the codebase, connecting user-reported symptoms to specific code paths
- **Building my hypothesis of the root cause**: For each bug, I formed my own theory of why the behavior occurred before validating it — this caught Claude's incorrect stale closure diagnosis on bug #8
- **Prioritizing the solution**: I decided the fix order, chose RBAC as the coded improvement based on the business risk of unauthorized access, and determined which bugs warranted tests vs. which were design gaps
- **Business model understanding**: I asked clarifying questions to make sure the RBAC design matched the real-world booking flow (pet owners call the office, staff manage bookings, sitters are contractors who show up), rather than accepting a generic permission scheme
