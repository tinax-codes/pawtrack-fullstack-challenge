import { v4 as uuid } from 'uuid';
import type { Booking, BookingStatus, PaginatedResult, AuthContext } from '../types/index.js';
import { VALID_TRANSITIONS } from '../types/index.js';
import { store } from '../store/memory-store.js';
import { eventBus } from './event-emitter.js';

interface ListBookingsParams {
  tenantId: string;
  page: number;
  limit: number;
  date?: string;
  status?: BookingStatus;
  sitterId?: string;
}

interface CreateBookingParams {
  tenantId: string;
  petId: string;
  sitterId: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  notes: string;
  createdBy: string;
}

export class BookingService {
  private sitterLocks: Map<string, Promise<void>> = new Map();
  /**
   * List bookings for a tenant with optional date and status filters.
   * Supports pagination.
   */
  public listBookings(params: ListBookingsParams): PaginatedResult<Booking> {
    const { tenantId, page, limit, date, status, sitterId } = params;

    let bookings = store.getBookingsByTenant(tenantId);

    if (sitterId) {
      bookings = bookings.filter(b => b.sitterId === sitterId);
    }

    if (date) {
      // Match bookings on the requested date
      bookings = bookings.filter(b => b.scheduledDate.startsWith(date));
    }

    // Filter by status if provided
    if (status) {
      bookings = bookings.filter(b => b.status === status);
    }

    // Sort by scheduled date descending (newest first)
    bookings.sort((a, b) => new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime());

    const total = bookings.length;
    const totalPages = Math.ceil(total / limit);

    const offset = (page - 1) * limit;
    const paginatedBookings = bookings.slice(offset, offset + limit);

    return {
      data: paginatedBookings,
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Create a new booking.
   * Checks for overlapping bookings with the same sitter.
   */
  public async createBooking(params: CreateBookingParams): Promise<Booking> {
    const { sitterId } = params;

    const existing = this.sitterLocks.get(sitterId) ?? Promise.resolve();
    let resolve!: () => void;
    const lock = new Promise<void>(r => { resolve = r; });
    this.sitterLocks.set(sitterId, lock);

    try {
      await existing;
      return await this._createBookingUnsafe(params);
    } finally {
      resolve();
      if (this.sitterLocks.get(sitterId) === lock) {
        this.sitterLocks.delete(sitterId);
      }
    }
  }

  private async _createBookingUnsafe(params: CreateBookingParams): Promise<Booking> {
    const { tenantId, petId, sitterId, scheduledDate, startTime, endTime, notes, createdBy } = params;

    const existingBookings = store.getBookingsByTenant(tenantId).filter(
      b => b.sitterId === sitterId && b.status !== 'cancelled',
    );

    const hasOverlap = existingBookings.some(b => {
      const existingStart = new Date(`${b.scheduledDate.split('T')[0]}T${b.startTime}`);
      const existingEnd = new Date(`${b.scheduledDate.split('T')[0]}T${b.endTime}`);
      const newStart = new Date(`${scheduledDate.split('T')[0]}T${startTime}`);
      const newEnd = new Date(`${scheduledDate.split('T')[0]}T${endTime}`);

      return newStart < existingEnd && newEnd > existingStart;
    });

    if (hasOverlap) {
      throw new Error('Sitter has an overlapping booking for this time slot');
    }

    await new Promise(resolve => setTimeout(resolve, 10));

    const now = new Date().toISOString();
    const booking: Booking = {
      id: `booking_${uuid().slice(0, 8)}`,
      tenantId,
      petId,
      sitterId,
      status: 'requested',
      scheduledDate,
      startTime,
      endTime,
      notes,
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
      statusChangedBy: createdBy,
    };

    store.createBooking(booking);

    eventBus.emit('booking.created', {
      bookingId: booking.id,
      tenantId: booking.tenantId,
      petId: booking.petId,
      sitterId: booking.sitterId,
    });

    return booking;
  }

  /**
   * Update booking status with transition validation.
   */
  public updateStatus(
    bookingId: string,
    newStatus: BookingStatus,
    changedBy: string,
  ): { success: boolean; booking?: Booking; error?: string } {
    const booking = store.getBooking(bookingId);

    if (!booking) {
      return { success: false, error: 'Booking not found' };
    }

    const allowedTransitions = VALID_TRANSITIONS[booking.status];
    if (!allowedTransitions.includes(newStatus)) {
      return {
        success: false,
        error: `Cannot transition from '${booking.status}' to '${newStatus}'`,
      };
    }

    // Overwrite status — no history kept
    const updatedBooking: Booking = {
      ...booking,
      status: newStatus,
      updatedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      statusChangedBy: changedBy,
    };

    store.updateBooking(updatedBooking);

    // Overwrite status and notify listeners
    eventBus.emit('booking.statusChanged', {
      bookingId: updatedBooking.id,
      previousStatus: booking.status,
      newStatus,
      changedBy,
    });

    return { success: true, booking: updatedBooking };
  }

  /**
   * Get a single booking by ID.
   */
  public getBooking(bookingId: string): Booking | undefined {
    return store.getBooking(bookingId);
  }
}

export const bookingService = new BookingService();
