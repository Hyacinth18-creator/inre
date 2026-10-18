import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { defaultSettings, type Invoice, type Payment } from './domain'
import { exportBackup, importBackup, issueInvoice, loadData, recordAdjustment, recordPayment, saveBooking, saveGuest, saveInvoice } from './storage'

describe('local document storage', () => {
  it('keeps independent numbers and receipt snapshots through payments and backup restore', async () => {
    const guest = { id: 'guest-test', name: 'Test Guest', phone: '+254700000000', createdAt: '2026-10-17T09:00:00.000Z' }
    const booking = { id: 'booking-test', guestId: guest.id, unitId: 'unit-test', checkIn: '2026-10-18', checkOut: '2026-10-21', reference: 'BKG-TEST-1' }
    const invoice: Invoice = {
      id: 'invoice-test', number: 'DRAFT', status: 'draft', guestId: guest.id, bookingId: booking.id,
      issueDate: '2026-10-17', dueDate: '2026-10-24', items: [{ id: 'line-test', description: 'Stay', rate: 3000, quantity: 3, quantityLabel: '3 nights', total: 9000 }],
      discount: 0, additionalCharge: 0, createdAt: '2026-10-17T09:00:00.000Z',
    }
    await saveGuest(guest)
    await saveBooking(booking)
    await saveInvoice(invoice)
    const issued = await issueInvoice(invoice.id, defaultSettings.invoicePrefix)
    expect(issued.number).toMatch(/^SHS\/INV\/00001\/\d{2}$/)

    const firstPayment: Payment = {
      id: 'payment-test-1', invoiceId: invoice.id, bookingId: booking.id, guestId: guest.id, kind: 'payment', amount: 3000,
      method: 'M-Pesa', reference: 'MPESA-TEST-1', receivedAt: '2026-10-17T10:00:00.000Z', createdAt: '2026-10-17T10:00:00.000Z',
    }
    const firstReceipt = await recordPayment(firstPayment, defaultSettings.receiptPrefix)
    expect(firstReceipt.number).toMatch(/^SHS\/00001\/\d{2}$/)
    expect(firstReceipt.paidToDate).toBe(3000)
    expect(firstReceipt.balanceAfter).toBe(6000)

    await expect(recordPayment({ ...firstPayment, id: 'payment-over', amount: 6001, reference: undefined }, defaultSettings.receiptPrefix)).rejects.toThrow('exceeds the current invoice balance')

    await expect(recordPayment({ ...firstPayment, id: 'duplicate-payment', amount: 100 }, defaultSettings.receiptPrefix)).rejects.toThrow('already been recorded')
    await expect(recordAdjustment({ ...firstPayment, id: 'refund-over', kind: 'refund', amount: 3001, reference: undefined })).rejects.toThrow('refund cannot exceed payments received')

    const secondPayment: Payment = { ...firstPayment, id: 'payment-test-2', amount: 6000, reference: undefined, receivedAt: '2026-10-18T10:00:00.000Z' }
    const secondReceipt = await recordPayment(secondPayment, defaultSettings.receiptPrefix)
    expect(secondReceipt.number).toMatch(/^SHS\/00002\/\d{2}$/)
    expect(secondReceipt.paidToDate).toBe(9000)
    expect(secondReceipt.balanceAfter).toBe(0)

    const backup = await exportBackup()
    await importBackup(new File([await backup.text()], 'shwari-backup.json', { type: 'application/json' }))
    const restored = await loadData()
    const restoredReceipts = restored.receipts.sort((first, second) => first.number.localeCompare(second.number))
    expect(restoredReceipts.map((receipt) => receipt.paymentId)).toEqual(['payment-test-1', 'payment-test-2'])
    expect(restoredReceipts[0].balanceAfter).toBe(6000)
    await saveInvoice({ ...invoice, id: 'invoice-test-2', number: 'DRAFT', status: 'draft' })
    const nextIssued = await issueInvoice('invoice-test-2', defaultSettings.invoicePrefix)
    expect(nextIssued.number).toMatch(/^SHS\/INV\/00002\/\d{2}$/)
  })
})