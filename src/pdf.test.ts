import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Invoice, type Payment, type Receipt } from './domain'
import { createInvoicePdf, createReceiptPdf } from './pdf'

describe('receipt PDF', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prints the official receipt sections and preserves different rate and total values', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/assets/shwari-logo.png')) {
        return new Response(await readFile(new URL('../public/assets/shwari-logo.png', import.meta.url)), {
          headers: { 'Content-Type': 'image/png' },
        })
      }
      return new Response(null, { status: 404 })
    }))
    const guest = { id: 'guest-pdf', name: 'Template Test Guest', phone: '+254700000000', createdAt: '2026-10-17T09:00:00.000Z' }
    const booking = { id: 'booking-pdf', guestId: guest.id, unitId: 'unit-pdf', checkIn: '2026-10-18', checkOut: '2026-10-19', reference: 'BKG-PDF-1' }
    const invoice: Invoice = {
      id: 'invoice-pdf', number: 'SHS/INV/00001/26', status: 'issued', guestId: guest.id, bookingId: booking.id,
      issueDate: '2026-10-17', dueDate: '2026-10-20', discount: 0, additionalCharge: 0, createdAt: '2026-10-17T09:00:00.000Z',
      items: [{ id: 'line-pdf', description: 'One night stay charge (1 bedroom unit)', rate: 2000, quantity: 1, quantityLabel: '1 night', total: 2500 }],
    }
    const payment: Payment = {
      id: 'payment-pdf', invoiceId: invoice.id, bookingId: booking.id, guestId: guest.id, kind: 'payment', amount: 2500,
      method: 'M-Pesa', reference: 'GUEST-PROVIDED-REFERENCE', mpesaSender: 'GERALD ENDIEGO', mpesaAccount: '242025',
      receivedAt: '2026-10-17T06:59:00.000Z', createdAt: '2026-10-17T10:00:00.000Z',
    }
    const receipt: Receipt = {
      id: 'receipt-pdf', number: 'SHS/00001/26', paymentId: payment.id, invoiceId: invoice.id, bookingId: booking.id,
      issuedAt: '2026-10-17T10:00:00.000Z', paidToDate: 2500, balanceAfter: 0,
    }
    const pdf = await createReceiptPdf({ settings: defaultSettings, guest, booking, invoice, payment, receipt, payments: [payment] })
    const output = pdf.output()
    expect(pdf.getNumberOfPages()).toBe(1)
    expect(pdf.internal.pageSize.getWidth()).toBeCloseTo(210, 1)
    expect(output).toContain('PAYMENT RECEIPT')
    expect(output).toContain('SHS/00001/26')
    expect(output).toContain('GUEST-PROVIDED-REFERENCE')
    expect(output).toContain('Payment received: 17/10/2026, 09:59')
    expect(output).toContain('M-Pesa sender: GERALD ENDIEGO')
    expect(output).toContain('Message account: 242025')
    expect(output).toContain('One night stay charge')
    expect(output).toContain('KSh 2,000.00')
    expect(output).toContain('KSh 2,500.00')
    expect(output).toContain('Terms and conditions:')
    expect(output).toContain('Thank you for doing business with us.')
    expect(output).toContain('OFFICIAL DOCUMENT')
    expect(output).toContain('/Subtype /Image')

    const invoicePdf = await createInvoicePdf({ settings: defaultSettings, guest, booking, invoice, payment, receipt, payments: [payment] })
    const invoiceOutput = invoicePdf.output()
    expect(invoiceOutput).toContain('OFFICIAL DOCUMENT')
    expect(invoiceOutput).toContain('/Subtype /Image')
  })
})