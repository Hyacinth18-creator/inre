import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowUpRight, BadgeCheck, Banknote, BedDouble, CalendarDays, ChartNoAxesCombined,
  Check, ChevronDown, CircleDollarSign, ClipboardList, FilePlus2, FileText, Home, LayoutDashboard,
  Menu, MoreHorizontal, Printer, ReceiptText, Search, Settings2, Share2, ShieldCheck, SlidersHorizontal,
  Users, WalletCards, X,
} from 'lucide-react'
import {
  formatDate, invoiceTotal, money, safeBalance,
  type AppData, type AuditLog, type BusinessSettings, type Guest, type Invoice, type InvoiceLineItem,
  type Payment, type PaymentMethod, type Receipt, type Unit,
} from './domain'
import {
  exportBackup, importBackup, issueInvoice, loadData, recordAdjustment, recordPayment,
  saveBooking, saveGuest, saveInvoice, saveSettings, saveUnit,
} from './backendStorage'
import type { DocumentContext } from './pdf'
import { nairobiDateTimeInput, nairobiInputToIso, parseMpesaMessage } from './mpesa'

type View = 'dashboard' | 'invoices' | 'receipts' | 'guests' | 'reports' | 'settings'
type Modal = { type: 'invoice' } | { type: 'payment'; invoiceId: string } | { type: 'receipt' } | { type: 'adjustment'; invoiceId: string; kind: 'refund' | 'adjustment' } | { type: 'unit' } | null
type Notice = { kind: 'success' | 'error'; text: string } | null

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}
const id = () => crypto.randomUUID()

const navigation: { key: View; label: string; icon: typeof Home }[] = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { key: 'invoices', label: 'Invoices', icon: FileText },
  { key: 'receipts', label: 'Receipts', icon: ReceiptText },
  { key: 'guests', label: 'Guests & units', icon: Users },
  { key: 'reports', label: 'Reports', icon: ChartNoAxesCombined },
  { key: 'settings', label: 'Business settings', icon: Settings2 },
]

const heading: Record<View, string> = {
  dashboard: 'Overview', invoices: 'Invoices', receipts: 'Payment receipts', guests: 'Guests & units', reports: 'Reports', settings: 'Business settings',
}

function App() {
  const [data, setData] = useState<AppData | null>(null)
  const [view, setView] = useState<View>('dashboard')
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    setData(await loadData())
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not open local records.' }))
  }, [])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  const invoices = data?.invoices ?? []
  const payments = data?.payments ?? []
  const receipts = data?.receipts ?? []
  const guests = data?.guests ?? []
  const units = data?.units ?? []
  const settings = data?.settings

  const invoiceRows = useMemo(() => invoices.filter((invoice) => {
    const guest = guests.find((item) => item.id === invoice.guestId)
    const booking = data?.bookings.find((item) => item.id === invoice.bookingId)
    const match = `${invoice.number} ${guest?.name ?? ''} ${guest?.phone ?? ''} ${units.find((item) => item.id === booking?.unitId)?.name ?? ''} ${invoice.status}`.toLocaleLowerCase()
    return match.includes(query.toLocaleLowerCase())
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [invoices, guests, data?.bookings, units, query])

  const receiptRows = useMemo(() => receipts.filter((receipt) => {
    const payment = payments.find((item) => item.id === receipt.paymentId)
    const guest = guests.find((item) => item.id === payment?.guestId)
    const invoice = invoices.find((item) => item.id === receipt.invoiceId)
    return `${receipt.number} ${guest?.name ?? ''} ${guest?.phone ?? ''} ${invoice?.number ?? ''} ${payment?.reference ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  }).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)), [receipts, payments, guests, invoices, query])

  async function runAction(action: () => Promise<void>, success?: string) {
    setBusy(true)
    try {
      await action()
      await refresh()
      setModal(null)
      if (success) setNotice({ kind: 'success', text: success })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'That action could not be completed.' })
    } finally {
      setBusy(false)
    }
  }

  async function createInvoice(values: InvoiceFormValues) {
    if (!data) return
    await runAction(async () => {
      const normalizedPhone = values.phone.trim()
      let guest = data.guests.find((item) => normalizedPhone && item.phone.replaceAll(' ', '') === normalizedPhone.replaceAll(' ', ''))
      if (!guest) {
        guest = { id: id(), name: values.name.trim(), phone: normalizedPhone, email: '', createdAt: new Date().toISOString() }
        await saveGuest(guest)
      }
      let unit = data.units.find((item) => item.id === values.unitId)
      if (!unit) {
        unit = { id: id(), name: values.unitName.trim(), rate: Number(values.unitRate), active: true }
        await saveUnit(unit)
      }
      const bookingId = id()
      const booking = { id: bookingId, guestId: guest.id, unitId: unit.id, checkIn: values.checkIn, checkOut: values.checkOut, reference: values.bookingReference.trim() || `SHS-BKG-${bookingId.slice(0, 6).toUpperCase()}` }
      await saveBooking(booking)
      const invoice: Invoice = {
        id: id(), number: 'DRAFT', status: 'draft', guestId: guest.id, bookingId,
        issueDate: values.issueDate, dueDate: values.dueDate,
        items: values.items.map((item) => ({ ...item, id: id(), rate: Number(item.rate), quantity: Number(item.quantity), total: Number(item.total) })),
        discount: Number(values.discount || 0), additionalCharge: Number(values.additionalCharge || 0), notes: values.notes.trim(), createdAt: new Date().toISOString(),
      }
      await saveInvoice(invoice)
    }, 'Invoice draft created. Issue it when it is ready to send.')
  }

  async function issue(invoice: Invoice) {
    if (!settings) return
    await runAction(async () => { await issueInvoice(invoice.id, settings.invoicePrefix) }, 'Invoice issued. No payment was recorded.')
  }

  async function savePayment(values: PaymentFormValues) {
    if (!data) return
    await runAction(async () => {
      let guestId = values.guestId
      if (!guestId) {
        const phone = values.phone.trim()
        let guest = data.guests.find((item) => phone && item.phone.replaceAll(' ', '') === phone.replaceAll(' ', ''))
        if (!guest) {
          guest = { id: id(), name: values.name.trim(), phone, createdAt: new Date().toISOString() }
          await saveGuest(guest)
        }
        guestId = guest.id
      }
      let bookingId: string | undefined = values.bookingId
      if (values.standalone) {
        const booking = {
          id: id(), guestId, unitId: values.unitId || '', checkIn: values.checkIn, checkOut: values.checkOut,
          reference: values.bookingReference.trim(),
        }
        await saveBooking(booking)
        bookingId = booking.id
      }
      const invoice = invoices.find((item) => item.id === values.invoiceId)
      const payment: Payment = {
        id: id(), invoiceId: invoice?.id, bookingId: bookingId || invoice?.bookingId, guestId,
        kind: 'payment', amount: Number(values.amount), method: values.method, reference: values.reference.trim() || undefined,
        mpesaSender: values.mpesaSender.trim() || undefined, mpesaAccount: values.mpesaAccount.trim() || undefined,
        description: values.description.trim() || undefined, receivedAt: nairobiInputToIso(values.receivedAt), createdAt: new Date().toISOString(),
      }
      await recordPayment(payment, data.settings.receiptPrefix)
    }, 'Payment recorded and receipt issued.')
  }

  async function adjustInvoice(values: AdjustmentFormValues, invoice: Invoice, kind: 'refund' | 'adjustment') {
    if (!data) return
    await runAction(async () => {
      const payment: Payment = {
        id: id(), invoiceId: invoice.id, bookingId: invoice.bookingId, guestId: invoice.guestId, kind,
        amount: Number(values.amount), adjustmentDelta: kind === 'adjustment' ? Number(values.direction === 'credit' ? -values.amount : values.amount) : undefined,
        method: values.method, reference: values.reference.trim() || undefined, description: values.description.trim(),
        receivedAt: new Date(values.date).toISOString(), createdAt: new Date().toISOString(),
      }
      await recordAdjustment(payment)
    }, kind === 'refund' ? 'Refund recorded. No receipt was issued for the refund.' : 'Invoice adjustment recorded.')
  }

  async function contextForInvoice(invoice: Invoice): Promise<DocumentContext> {
    if (!data) throw new Error('Records are still loading.')
    const guest = data.guests.find((item) => item.id === invoice.guestId)
    if (!guest) throw new Error('The guest record for this invoice is missing.')
    const booking = data.bookings.find((item) => item.id === invoice.bookingId)
    return { settings: data.settings, guest, booking, unit: data.units.find((item) => item.id === booking?.unitId), invoice, payments: data.payments }
  }

  async function contextForReceipt(receipt: Receipt): Promise<DocumentContext> {
    if (!data) throw new Error('Records are still loading.')
    const payment = data.payments.find((item) => item.id === receipt.paymentId)
    const guest = payment && data.guests.find((item) => item.id === payment.guestId)
    if (!payment || !guest) throw new Error('This receipt is not linked to a valid payment and guest.')
    const invoice = data.invoices.find((item) => item.id === receipt.invoiceId)
    const booking = data.bookings.find((item) => item.id === (receipt.bookingId || payment.bookingId))
    return { settings: data.settings, guest, booking, unit: data.units.find((item) => item.id === booking?.unitId), invoice, receipt, payment, payments: data.payments }
  }

  async function documentAction(type: 'invoice' | 'receipt', item: Invoice | Receipt, action: 'preview' | 'download' | 'print' | 'share') {
    try {
      const { createInvoicePdf, createReceiptPdf, downloadPdf, pdfBlobUrl } = await import('./pdf')
      const context = type === 'invoice' ? await contextForInvoice(item as Invoice) : await contextForReceipt(item as Receipt)
      const doc = type === 'invoice' ? await createInvoicePdf(context) : await createReceiptPdf(context)
      const number = type === 'invoice' ? (item as Invoice).number : (item as Receipt).number
      const fileName = `${type === 'invoice' ? 'Invoice' : 'Receipt'}-${number.replaceAll('/', '-')}.pdf`
      if (action === 'preview') {
        const url = pdfBlobUrl(doc)
        setPreview((previous) => {
          if (previous) URL.revokeObjectURL(previous.url)
          return { url, title: `${type === 'invoice' ? 'Invoice' : 'Receipt'} ${number}` }
        })
        return
      }
      if (action === 'download') { downloadPdf(doc, fileName); return }
      if (action === 'print') {
        const url = pdfBlobUrl(doc)
        const printWindow = window.open(url, '_blank', 'noopener,noreferrer')
        if (!printWindow) setNotice({ kind: 'error', text: 'Allow pop-ups to print this PDF.' })
        return
      }
      const blob = doc.output('blob')
      const file = new File([blob], fileName, { type: 'application/pdf' })
      const shareText = `${type === 'invoice' ? 'Invoice' : 'Payment receipt'} ${number} from Shwari Home Stays.`
      if (navigator.canShare?.({ files: [file] }) && navigator.share) await navigator.share({ title: shareText, text: shareText, files: [file] })
      else {
        downloadPdf(doc, fileName)
        window.open(`https://wa.me/?text=${encodeURIComponent(`${shareText} The PDF has been downloaded for you to attach.`)}`, '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not prepare this document.' })
    }
  }

  async function backup() {
    const blob = await exportBackup()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `shwari-backup-${today()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice({ kind: 'success', text: 'Backup downloaded.' })
  }

  async function restore(file?: File) {
    if (!file) return
    if (!window.confirm('Restore this backup and replace all records on this device?')) return
    await runAction(async () => { await importBackup(file) }, 'Backup restored.')
  }

  if (!data) return <div className="loading-screen"><div className="loader-mark"><Home size={22} /></div><span>Opening local records</span></div>

  const activeModalInvoice = modal?.type === 'payment' || modal?.type === 'adjustment' ? invoices.find((item) => item.id === modal.invoiceId) : undefined

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><img src="/assets/shwari-logo.png" alt="Shwari Home Stays" /><span><b>Shwari</b><small>HOME STAYS</small></span><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} title="Close menu"><X size={18} /></button></div>
        <div className="workspace-label">MANAGEMENT</div>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-link ${view === key ? 'active' : ''}`} onClick={() => { setView(key); setMobileNav(false) }}><Icon size={18} /><span>{label}</span>{key === 'invoices' && invoices.some((invoice) => invoice.status === 'draft') && <i className="nav-count">{invoices.filter((invoice) => invoice.status === 'draft').length}</i>}</button>)}
        </nav>
        <div className="sidebar-bottom"><div className="secure-mark"><ShieldCheck size={16} /><span>Stored on this device</span></div><small>SHWARI HOME STAYS<br />NYAMATARO · KISII</small></div>
      </aside>

      {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} title="Open menu"><Menu size={20} /></button>
          <div className="crumb"><span>Shwari Home Stays</span><b>/</b><strong>{heading[view]}</strong></div>
          <div className="top-actions">
            <label className="search-field"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" aria-label="Search documents" /><kbd>⌘ K</kbd></label>
            <button className="button button-quiet" onClick={() => setModal({ type: 'receipt' })}><ReceiptText size={16} /><span>Create receipt</span></button>
            <button className="button button-primary" onClick={() => setModal({ type: 'invoice' })}><FilePlus2 size={16} /><span>Create invoice</span></button>
          </div>
        </header>

        <div className="page-content">
          {view === 'dashboard' && <Dashboard data={data} onNavigate={setView} onCreateInvoice={() => setModal({ type: 'invoice' })} onCreateReceipt={() => setModal({ type: 'receipt' })} onPreview={(invoice) => void documentAction('invoice', invoice, 'preview')} />}
          {view === 'invoices' && <InvoicesPage invoices={invoiceRows} data={data} onIssue={(invoice) => void issue(invoice)} onPay={(invoice) => setModal({ type: 'payment', invoiceId: invoice.id })} onAdjust={(invoice, kind) => setModal({ type: 'adjustment', invoiceId: invoice.id, kind })} onDoc={(invoice, action) => void documentAction('invoice', invoice, action)} />}
          {view === 'receipts' && <ReceiptsPage receipts={receiptRows} data={data} onDoc={(receipt, action) => void documentAction('receipt', receipt, action)} />}
          {view === 'guests' && <GuestsPage data={data} onAddUnit={() => setModal({ type: 'unit' })} />}
          {view === 'reports' && <ReportsPage data={data} />}
          {view === 'settings' && <SettingsPage data={data} onSave={(value) => void runAction(async () => { await saveSettings(value) }, 'Business settings saved.')} onBackup={() => void backup()} onRestore={(file) => void restore(file)} />}
        </div>
      </main>

      {modal?.type === 'invoice' && <ModalFrame title="Create invoice" subtitle="Bill for a stay or accommodation charges" onClose={() => setModal(null)}><InvoiceForm guests={guests} units={units} busy={busy} onCancel={() => setModal(null)} onSubmit={(values) => void createInvoice(values)} /></ModalFrame>}
      {modal?.type === 'payment' && activeModalInvoice && <ModalFrame title="Record payment" subtitle={`Against ${activeModalInvoice.number === 'DRAFT' ? 'draft invoice' : activeModalInvoice.number}`} onClose={() => setModal(null)}><PaymentForm data={data} invoice={activeModalInvoice} busy={busy} onCancel={() => setModal(null)} onSubmit={(values) => void savePayment(values)} /></ModalFrame>}
      {modal?.type === 'receipt' && <ModalFrame title="Create payment receipt" subtitle="Record a real payment against a booking" onClose={() => setModal(null)}><PaymentForm data={data} busy={busy} onCancel={() => setModal(null)} onSubmit={(values) => void savePayment(values)} /></ModalFrame>}
      {modal?.type === 'adjustment' && activeModalInvoice && <ModalFrame title={modal.kind === 'refund' ? 'Record refund' : 'Adjust invoice balance'} subtitle={activeModalInvoice.number} onClose={() => setModal(null)}><AdjustmentForm kind={modal.kind} busy={busy} onCancel={() => setModal(null)} onSubmit={(values) => void adjustInvoice(values, activeModalInvoice, modal.kind)} /></ModalFrame>}
      {modal?.type === 'unit' && <ModalFrame title="Add accommodation unit" subtitle="Save a unit and its default nightly rate" onClose={() => setModal(null)}><UnitForm busy={busy} onCancel={() => setModal(null)} onSubmit={(unit) => void runAction(async () => { await saveUnit(unit) }, 'Unit saved.')} /></ModalFrame>}
      {preview && <ModalFrame title={preview.title} subtitle="PDF preview" wide onClose={() => setPreview(null)}><div className="pdf-preview"><iframe title={preview.title} src={preview.url} /><div className="preview-actions"><button className="button button-quiet" onClick={() => window.open(preview.url, '_blank', 'noopener,noreferrer')}><Printer size={16} />Print</button></div></div></ModalFrame>}
      {notice && <div className={`toast ${notice.kind}`} role="status"><span className="toast-icon">{notice.kind === 'success' ? <Check size={17} /> : <X size={17} />}</span>{notice.text}<button onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={16} /></button></div>}
    </div>
  )
}

function Dashboard({ data, onNavigate, onCreateInvoice, onCreateReceipt, onPreview }: { data: AppData; onNavigate: (view: View) => void; onCreateInvoice: () => void; onCreateReceipt: () => void; onPreview: (invoice: Invoice) => void }) {
  const issued = data.invoices.filter((invoice) => invoice.status === 'issued')
  const outstanding = issued.reduce((sum, invoice) => sum + safeBalance(invoice, data.payments), 0)
  const month = today().slice(0, 7)
  const receivedThisMonth = data.payments.filter((payment) => payment.kind === 'payment' && nairobiDateTimeInput(payment.receivedAt).slice(0, 7) === month).reduce((sum, payment) => sum + payment.amount, 0)
  const recent = [...data.invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
  return <>
    <PageHeading eyebrow={new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date()).toLocaleUpperCase()} title="Good day" subtitle="Here is the latest activity across your stays." action={<button className="button button-primary" onClick={onCreateInvoice}><FilePlus2 size={16} />Create invoice</button>} />
    <section className="metric-grid" aria-label="Business summary">
      <Metric icon={<FileText size={18} />} label="Invoices issued" value={String(issued.length)} note={`${data.invoices.filter((invoice) => invoice.status === 'draft').length} drafts`} accent="green" />
      <Metric icon={<WalletCards size={18} />} label="Payments received this month" value={money(receivedThisMonth, data.settings.currency)} note={`${data.receipts.length} receipts issued`} accent="blue" />
      <Metric icon={<CircleDollarSign size={18} />} label="Outstanding balance" value={money(outstanding, data.settings.currency)} note="Across issued invoices" accent="amber" />
      <Metric icon={<Users size={18} />} label="Guest records" value={String(data.guests.length)} note={`${data.units.length} accommodation units`} accent="plum" />
    </section>
    <section className="dashboard-grid">
      <div className="panel activity-panel">
        <div className="panel-heading"><div><h2>Recent invoices</h2><p>Latest billing activity</p></div><button className="text-button" onClick={() => onNavigate('invoices')}>View all <ArrowUpRight size={15} /></button></div>
        {recent.length ? <div className="activity-list">{recent.map((invoice) => {
          const guest = data.guests.find((item) => item.id === invoice.guestId)
          return <button key={invoice.id} className="activity-row" onClick={() => onPreview(invoice)}><span className="activity-icon"><FileText size={17} /></span><span className="activity-main"><b>{invoice.number === 'DRAFT' ? 'Draft invoice' : invoice.number}</b><small>{guest?.name ?? 'Guest record missing'} · {formatDate(invoice.issueDate)}</small></span><span className="activity-amount"><b>{money(invoiceTotal(invoice), data.settings.currency)}</b><StatusPill status={invoice.status === 'draft' ? 'Draft' : safeBalance(invoice, data.payments) === 0 ? 'Paid' : 'Due'} /></span></button>
        })}</div> : <EmptyState icon={<ClipboardList size={22} />} title="No invoices yet" copy="Your issued invoices and drafts will appear here." action={<button className="button button-primary" onClick={onCreateInvoice}><FilePlus2 size={15} />Create first invoice</button>} />}
      </div>
      <div className="panel quick-panel">
        <div className="panel-heading"><div><h2>Quick actions</h2><p>Keep booking records up to date</p></div></div>
        <button className="quick-action" onClick={onCreateInvoice}><span className="quick-icon green"><FilePlus2 size={18} /></span><span><b>Create invoice</b><small>Enter charges and issue a bill</small></span><ArrowUpRight size={16} /></button>
        <button className="quick-action" onClick={onCreateReceipt}><span className="quick-icon blue"><ReceiptText size={18} /></span><span><b>Record a payment</b><small>Issue a receipt for money received</small></span><ArrowUpRight size={16} /></button>
        <button className="quick-action" onClick={() => onNavigate('reports')}><span className="quick-icon amber"><ChartNoAxesCombined size={18} /></span><span><b>Open reports</b><small>Review income and balances</small></span><ArrowUpRight size={16} /></button>
        <div className="local-note"><ShieldCheck size={16} /><span>Records are saved locally in this browser. Export a backup regularly.</span></div>
      </div>
    </section>
    <section className="dashboard-bottom"><div className="section-title"><div><span className="eyebrow">RECEIPTS</span><h2>Payments recorded</h2></div><button className="text-button" onClick={() => onNavigate('receipts')}>Browse receipts <ArrowUpRight size={15} /></button></div><div className="receipt-strip">{data.receipts.slice().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).slice(0, 4).map((receipt) => {
      const payment = data.payments.find((item) => item.id === receipt.paymentId)
      const guest = data.guests.find((item) => item.id === payment?.guestId)
      return <div className="receipt-chip" key={receipt.id}><span><ReceiptText size={16} /></span><b>{receipt.number}</b><small>{guest?.name ?? 'Guest'} · {money(payment?.amount ?? 0, data.settings.currency)}</small></div>
    })}{data.receipts.length === 0 && <p className="muted-copy">Receipts appear here after a payment is recorded.</p>}</div></section>
  </>
}

function Metric({ icon, label, value, note, accent }: { icon: ReactNode; label: string; value: string; note: string; accent: string }) {
  return <article className="metric-card"><div className={`metric-icon ${accent}`}>{icon}</div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><small className="metric-note">{note}</small></article>
}

function InvoicesPage({ invoices, data, onIssue, onPay, onAdjust, onDoc }: { invoices: Invoice[]; data: AppData; onIssue: (invoice: Invoice) => void; onPay: (invoice: Invoice) => void; onAdjust: (invoice: Invoice, kind: 'refund' | 'adjustment') => void; onDoc: (invoice: Invoice, action: 'preview' | 'download' | 'print' | 'share') => void }) {
  const [filter, setFilter] = useState('All statuses')
  const rows = invoices.filter((invoice) => filter === 'All statuses' || (filter === 'Draft' ? invoice.status === 'draft' : filter === 'Paid' ? invoice.status === 'issued' && safeBalance(invoice, data.payments) === 0 : invoice.status === 'issued' && safeBalance(invoice, data.payments) > 0))
  return <>
    <PageHeading eyebrow="BILLING" title="Invoices" subtitle="Accommodation charges, payments and outstanding balances." action={<div className="heading-tools"><label className="filter-select"><SlidersHorizontal size={15} /><select value={filter} onChange={(event) => setFilter(event.target.value)}><option>All statuses</option><option>Draft</option><option>Due</option><option>Paid</option></select><ChevronDown size={14} /></label></div>} />
    <div className="table-panel"><div className="table-meta"><div><b>{rows.length} invoices</b><span> Search by guest, number, unit or status</span></div><span className="table-meta-right"><CalendarDays size={14} /> Local records</span></div>
      <div className="table-scroll"><table><thead><tr><th>INVOICE</th><th>GUEST</th><th>STAY</th><th>ISSUED</th><th>AMOUNT</th><th>PAID</th><th>BALANCE</th><th>STATUS</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {rows.map((invoice) => {
          const guest = data.guests.find((item) => item.id === invoice.guestId)
          const booking = data.bookings.find((item) => item.id === invoice.bookingId)
          const unit = data.units.find((item) => item.id === booking?.unitId)
          const paid = data.payments.filter((payment) => payment.invoiceId === invoice.id && payment.kind === 'payment').reduce((sum, payment) => sum + payment.amount, 0)
          const balance = safeBalance(invoice, data.payments)
          const status = invoice.status === 'draft' ? 'Draft' : balance === 0 ? 'Paid' : 'Due'
          return <tr key={invoice.id}>
            <td><button className="table-link" onClick={() => onDoc(invoice, 'preview')}>{invoice.number === 'DRAFT' ? `Draft · ${invoice.id.slice(0, 6)}` : invoice.number}</button><small>{invoice.items.length} line {invoice.items.length === 1 ? 'item' : 'items'}</small></td>
            <td><b>{guest?.name ?? 'Missing guest'}</b><small>{guest?.phone}</small></td>
            <td>{unit?.name ?? 'Stay'}<small>{booking ? `${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}` : 'No booking dates'}</small></td>
            <td>{formatDate(invoice.issueDate)}<small>Due {formatDate(invoice.dueDate)}</small></td>
            <td className="numeric">{money(invoiceTotal(invoice), data.settings.currency)}</td>
            <td className="numeric">{money(paid, data.settings.currency)}</td>
            <td className={`numeric ${balance > 0 ? 'balance-open' : ''}`}>{money(balance, data.settings.currency)}</td>
            <td><StatusPill status={status} /></td>
            <td><div className="row-actions">
              {invoice.status === 'draft' ? <button className="small-action issue-action" onClick={() => onIssue(invoice)} title="Issue invoice"><BadgeCheck size={15} /><span>Issue</span></button> : balance > 0 ? <button className="small-action pay-action" onClick={() => onPay(invoice)} title="Record payment"><Banknote size={15} /><span>Pay</span></button> : null}
              <button className="icon-button row-icon" onClick={() => onDoc(invoice, 'preview')} title="Preview"><Search size={15} /></button>
              <button className="icon-button row-icon" onClick={() => onDoc(invoice, 'download')} title="Download PDF"><ArrowDownToLine size={15} /></button>
              {invoice.status === 'issued' && <details className="more-menu"><summary className="icon-button row-icon" title="More invoice actions"><MoreHorizontal size={16} /></summary><div className="menu-popover"><button onClick={() => onDoc(invoice, 'print')}><Printer size={15} />Print</button><button onClick={() => onDoc(invoice, 'share')}><Share2 size={15} />Share</button><button onClick={() => onAdjust(invoice, 'refund')}><WalletCards size={15} />Record refund</button><button onClick={() => onAdjust(invoice, 'adjustment')}><SlidersHorizontal size={15} />Adjust balance</button></div></details>}
            </div></td>
          </tr>
        })}
        {rows.length === 0 && <tr><td colSpan={9}><EmptyState icon={<FileText size={22} />} title="No matching invoices" copy="Create an invoice to begin tracking a guest's charges." /></td></tr>}
      </tbody></table></div>
    </div>
    <div className="info-band"><ShieldCheck size={17} /><span>Issuing an invoice records a bill only. A payment receipt is created only after you record money actually received.</span></div>
  </>
}

function ReceiptsPage({ receipts, data, onDoc }: { receipts: Receipt[]; data: AppData; onDoc: (receipt: Receipt, action: 'preview' | 'download' | 'print' | 'share') => void }) {
  return <>
    <PageHeading eyebrow="PAYMENTS" title="Payment receipts" subtitle="Receipts are linked to recorded payments and remain available in your history." action={<span className="readonly-badge"><ShieldCheck size={15} />Issued after payment</span>} />
    <div className="table-panel"><div className="table-meta"><div><b>{receipts.length} receipts</b><span> Each receipt acknowledges a specific transaction</span></div><span className="table-meta-right"><ReceiptText size={14} /> Official receipt layout</span></div>
      <div className="table-scroll"><table><thead><tr><th>RECEIPT</th><th>GUEST</th><th>INVOICE / BOOKING</th><th>DATE</th><th>METHOD</th><th>REFERENCE</th><th>AMOUNT RECEIVED</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {receipts.map((receipt) => {
          const payment = data.payments.find((item) => item.id === receipt.paymentId)
          const guest = data.guests.find((item) => item.id === payment?.guestId)
          const invoice = data.invoices.find((item) => item.id === receipt.invoiceId)
          const booking = data.bookings.find((item) => item.id === receipt.bookingId)
          return <tr key={receipt.id}><td><button className="table-link" onClick={() => onDoc(receipt, 'preview')}>{receipt.number}</button><small>{payment?.kind === 'refund' ? 'Refund record' : 'Payment confirmed'}</small></td><td><b>{guest?.name ?? 'Missing guest'}</b><small>{guest?.phone}</small></td><td>{invoice?.number ?? booking?.reference ?? 'Booking payment'}<small>{booking ? `${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}` : ''}</small></td><td>{formatDate(receipt.issuedAt)}</td><td><span className="method-label">{payment?.method}</span></td><td>{payment?.reference || '—'}</td><td className="numeric amount-positive">{money(payment?.amount ?? 0, data.settings.currency)}</td><td><div className="row-actions"><button className="icon-button row-icon" onClick={() => onDoc(receipt, 'preview')} title="Preview"><Search size={15} /></button><button className="icon-button row-icon" onClick={() => onDoc(receipt, 'download')} title="Download PDF"><ArrowDownToLine size={15} /></button><button className="icon-button row-icon" onClick={() => onDoc(receipt, 'share')} title="Share receipt" aria-label="Share receipt"><Share2 size={15} /></button><details className="more-menu"><summary className="icon-button row-icon" title="More receipt actions"><MoreHorizontal size={16} /></summary><div className="menu-popover"><button onClick={() => onDoc(receipt, 'print')}><Printer size={15} />Print</button></div></details></div></td></tr>
        })}
        {receipts.length === 0 && <tr><td colSpan={8}><EmptyState icon={<ReceiptText size={22} />} title="No receipts issued" copy="Record an invoice payment or a booking payment to create the first receipt." /></td></tr>}
      </tbody></table></div>
    </div>
    <div className="info-band"><ReceiptText size={17} /><span>A receipt is a record of one payment transaction. Guests can receive multiple receipts against the same invoice.</span></div>
  </>
}

function GuestsPage({ data, onAddUnit }: { data: AppData; onAddUnit: () => void }) {
  return <>
    <PageHeading eyebrow="RECORDS" title="Guests & units" subtitle="Guest contact records and configurable accommodation rates." action={<button className="button button-primary" onClick={onAddUnit}><BedDouble size={16} />Add unit</button>} />
    <div className="records-grid">
      <section className="panel records-panel"><div className="panel-heading"><div><h2>Guest directory</h2><p>{data.guests.length} saved guests</p></div><span className="counter-tag"><Users size={15} />{data.guests.length}</span></div>
        {data.guests.length ? <div className="guest-list">{data.guests.slice().sort((a, b) => a.name.localeCompare(b.name)).map((guest) => {
          const stays = data.bookings.filter((booking) => booking.guestId === guest.id).length
          return <div className="guest-row" key={guest.id}><span className="avatar">{guest.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><span className="guest-main"><b>{guest.name}</b><small>{guest.phone}{guest.email ? ` · ${guest.email}` : ''}</small></span><span className="guest-stays">{stays} {stays === 1 ? 'stay' : 'stays'}</span></div>
        })}</div> : <EmptyState icon={<Users size={22} />} title="Guest records will build here" copy="A guest is saved when you create an invoice or booking receipt." />}
      </section>
      <section className="panel records-panel"><div className="panel-heading"><div><h2>Accommodation units</h2><p>Default rate is used when preparing an invoice.</p></div><button className="icon-button outline-icon" onClick={onAddUnit} title="Add unit"><FilePlus2 size={16} /></button></div>
        {data.units.length ? <div className="unit-list">{data.units.map((unit) => <div className="unit-row" key={unit.id}><span className="unit-symbol"><BedDouble size={18} /></span><span className="unit-main"><b>{unit.name}</b><small>{unit.active ? 'Available for booking' : 'Inactive'}</small></span><strong>{money(unit.rate, data.settings.currency)}<small>per night</small></strong></div>)}</div> : <EmptyState icon={<BedDouble size={22} />} title="No units added" copy="Add your accommodation units and set a default rate." action={<button className="button button-quiet" onClick={onAddUnit}>Add first unit</button>} />}
      </section>
    </div>
    <div className="info-band"><ShieldCheck size={17} /><span>Contacts and rates are stored in this browser and can be included in a data backup.</span></div>
  </>
}

function ReportsPage({ data }: { data: AppData }) {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today())
  const [method, setMethod] = useState('All methods')
  const [unit, setUnit] = useState('All units')
  const filtered = data.payments.filter((payment) => {
    const booking = data.bookings.find((item) => item.id === payment.bookingId)
    const invoice = data.invoices.find((item) => item.id === payment.invoiceId)
    const bookingUnit = booking?.unitId ?? data.bookings.find((item) => item.id === invoice?.bookingId)?.unitId
    return payment.receivedAt.slice(0, 10) >= from && payment.receivedAt.slice(0, 10) <= to && (method === 'All methods' || payment.method === method) && (unit === 'All units' || bookingUnit === unit)
  })
  const received = filtered.filter((payment) => payment.kind === 'payment').reduce((sum, payment) => sum + payment.amount, 0)
  const refunded = filtered.filter((payment) => payment.kind === 'refund').reduce((sum, payment) => sum + payment.amount, 0)
  const adjustments = filtered.filter((payment) => payment.kind === 'adjustment').reduce((sum, payment) => sum + (payment.adjustmentDelta ?? 0), 0)
  function downloadCsv() {
    const rows = [['Date', 'Guest', 'Method', 'Reference', 'Type', 'Amount', 'Invoice']]
    for (const payment of filtered) rows.push([
      payment.receivedAt.slice(0, 10), data.guests.find((guest) => guest.id === payment.guestId)?.name ?? '', payment.method,
      payment.reference ?? '', payment.kind, String(payment.amount), data.invoices.find((invoice) => invoice.id === payment.invoiceId)?.number ?? '',
    ])
    const csv = rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `shwari-report-${from}-${to}.csv`; anchor.click(); URL.revokeObjectURL(url)
  }
  return <>
    <PageHeading eyebrow="ANALYSIS" title="Reports" subtitle="Payment activity by date range, payment method and accommodation unit." action={<button className="button button-quiet" onClick={downloadCsv}><ArrowDownToLine size={16} />Export CSV</button>} />
    <section className="report-filters panel"><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><label>Payment method<select value={method} onChange={(event) => setMethod(event.target.value)}><option>All methods</option>{['M-Pesa', 'Cash', 'Bank transfer', 'Other'].map((item) => <option key={item}>{item}</option>)}</select></label><label>Unit<select value={unit} onChange={(event) => setUnit(event.target.value)}><option>All units</option>{data.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></section>
    <div className="report-summary"><Metric icon={<WalletCards size={18} />} label="Payments received" value={money(received, data.settings.currency)} note={`${filtered.filter((item) => item.kind === 'payment').length} transactions`} accent="green" /><Metric icon={<Banknote size={18} />} label="Refunds" value={money(refunded, data.settings.currency)} note="Recorded in date range" accent="amber" /><Metric icon={<SlidersHorizontal size={18} />} label="Net adjustments" value={money(adjustments, data.settings.currency)} note="Credits reduce balance" accent="blue" /></div>
    <div className="table-panel"><div className="table-meta"><div><b>{filtered.length} records</b><span> Within selected date range and filters</span></div></div><div className="table-scroll"><table><thead><tr><th>DATE</th><th>GUEST</th><th>UNIT</th><th>METHOD</th><th>REFERENCE</th><th>TYPE</th><th>AMOUNT</th></tr></thead><tbody>{filtered.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map((payment) => {
      const booking = data.bookings.find((item) => item.id === payment.bookingId || item.id === data.invoices.find((invoice) => invoice.id === payment.invoiceId)?.bookingId)
      return <tr key={payment.id}><td>{formatDate(payment.receivedAt)}</td><td>{data.guests.find((guest) => guest.id === payment.guestId)?.name}</td><td>{data.units.find((item) => item.id === booking?.unitId)?.name ?? '—'}</td><td>{payment.method}</td><td>{payment.reference || '—'}</td><td><StatusPill status={payment.kind === 'payment' ? 'Received' : payment.kind === 'refund' ? 'Refund' : 'Adjustment'} /></td><td className="numeric">{payment.kind === 'adjustment' ? money(payment.adjustmentDelta ?? 0, data.settings.currency) : money(payment.amount, data.settings.currency)}</td></tr>
    })}{filtered.length === 0 && <tr><td colSpan={7}><EmptyState icon={<ChartNoAxesCombined size={22} />} title="No activity in this range" copy="Payments and adjustments will appear here as records are added." /></td></tr>}</tbody></table></div></div>
  </>
}

function SettingsPage({ data, onSave, onBackup, onRestore }: { data: AppData; onSave: (settings: BusinessSettings) => void; onBackup: () => void; onRestore: (file: File | undefined) => void }) {
  const [settings, setSettings] = useState(data.settings)
  const [saved, setSaved] = useState(false)
  function submit(event: FormEvent) { event.preventDefault(); onSave(settings); setSaved(true); window.setTimeout(() => setSaved(false), 2200) }
  const fields: [keyof BusinessSettings, string][] = [
    ['name', 'Business name'], ['location', 'Location'], ['email', 'Business email'], ['bookingsEmail', 'Bookings email'], ['supportEmail', 'Additional support email'],
    ['website', 'Website'], ['postalAddress', 'Postal address'], ['phone', 'Phone'], ['paybill', 'M-Pesa Paybill'], ['accountName', 'M-Pesa account name'],
    ['familyBankAccount', 'Family Bank account'], ['familyBankName', 'Family Bank account name'], ['swiftCode', 'SWIFT code'], ['vatNote', 'VAT note'], ['currency', 'Currency label'],
  ]
  return <>
    <PageHeading eyebrow="CONFIGURATION" title="Business settings" subtitle="Edit the details printed on new documents and manage local records." />
    <div className="settings-layout"><form className="panel settings-panel" onSubmit={submit}><div className="panel-heading"><div><h2>Document details</h2><p>Defaults transcribed from the supplied receipt template.</p></div><span className="template-tag"><Check size={14} />Template defaults</span></div><div className="settings-fields">{fields.map(([key, label]) => <label key={key}>{label}<input value={settings[key] as string} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} /></label>)}</div><label className="full-label">Receipt terms<textarea rows={3} value={settings.terms} onChange={(event) => setSettings({ ...settings, terms: event.target.value })} /></label><div className="form-divider" /><div className="panel-heading"><div><h2>Numbering sequences</h2><p>Each document type advances independently.</p></div></div><div className="settings-fields numbering-fields"><label>Invoice prefix<input value={settings.invoicePrefix} onChange={(event) => setSettings({ ...settings, invoicePrefix: event.target.value })} /><small>Example: {settings.invoicePrefix}/00001/26</small></label><label>Receipt prefix<input value={settings.receiptPrefix} onChange={(event) => setSettings({ ...settings, receiptPrefix: event.target.value })} /><small>Example: {settings.receiptPrefix}/00001/26</small></label></div><div className="form-actions"><button type="submit" className="button button-primary"><Check size={16} />{saved ? 'Saved' : 'Save settings'}</button></div></form>
      <aside className="settings-aside"><div className="panel backup-panel"><div className="quick-icon green"><ShieldCheck size={19} /></div><h2>Local data & backups</h2><p>Your guest and payment records are stored in this browser's IndexedDB. Backups are downloaded as JSON.</p><button className="button button-quiet" onClick={onBackup}><ArrowDownToLine size={16} />Download backup</button><label className="button button-outline upload-button"><ArrowUpRight size={16} />Restore backup<input type="file" accept="application/json,.json" onChange={(event) => { onRestore(event.target.files?.[0]); event.target.value = '' }} /></label><small>Restoring replaces all records on this device.</small></div><div className="panel audit-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Document and payment audit trail</p></div></div>{data.auditLogs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6).map((log) => <AuditEntry key={log.id} log={log} />)}{data.auditLogs.length === 0 && <p className="muted-copy">Activity appears as records are created and issued.</p>}</div></aside></div>
  </>
}

function AuditEntry({ log }: { log: AuditLog }) { return <div className="audit-entry"><span className="audit-dot" /><span><b>{log.action} · {log.entityType}</b><small>{log.detail || log.entityId}</small></span><time>{new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(log.createdAt))}</time></div> }

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action && <div className="page-heading-action">{action}</div>}</div>
}

function StatusPill({ status }: { status: string }) { return <span className={`status-pill status-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</span> }

function EmptyState({ icon, title, copy, action }: { icon: ReactNode; title: string; copy: string; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon">{icon}</span><b>{title}</b><p>{copy}</p>{action}</div> }

function ModalFrame({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal-frame ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} title="Close"><X size={19} /></button></header>{children}</section></div>
}

interface InvoiceFormValues {
  guestId: string; name: string; phone: string; unitId: string; unitName: string; unitRate: string;
  checkIn: string; checkOut: string; bookingReference: string; issueDate: string; dueDate: string;
  items: InvoiceLineItem[]; discount: string; additionalCharge: string; notes: string;
}

function InvoiceForm({ guests, units, busy, onCancel, onSubmit }: { guests: Guest[]; units: Unit[]; busy: boolean; onCancel: () => void; onSubmit: (values: InvoiceFormValues) => void }) {
  const [values, setValues] = useState<InvoiceFormValues>(() => ({
    guestId: '', name: '', phone: '', unitId: '', unitName: '', unitRate: '', checkIn: today(), checkOut: addDays(today(), 1), bookingReference: '',
    issueDate: today(), dueDate: addDays(today(), 7), items: [{ id: id(), description: 'Accommodation', rate: 0, quantity: 1, quantityLabel: '1 night', total: 0 }], discount: '0', additionalCharge: '0', notes: '',
  }))
  const selectedGuest = guests.find((guest) => guest.id === values.guestId)
  const selectedUnit = units.find((unit) => unit.id === values.unitId)
  const subtotal = values.items.reduce((sum, item) => sum + Number(item.total || 0), 0)
  const total = Math.max(0, subtotal - Number(values.discount || 0) + Number(values.additionalCharge || 0))
  const nights = Math.max(1, Math.round((new Date(`${values.checkOut}T12:00:00`).getTime() - new Date(`${values.checkIn}T12:00:00`).getTime()) / 86400000))
  function set<K extends keyof InvoiceFormValues>(key: K, value: InvoiceFormValues[K]) { setValues((previous) => ({ ...previous, [key]: value })) }
  function setUnit(unitId: string) {
    const unit = units.find((item) => item.id === unitId)
    setValues((previous) => ({ ...previous, unitId, unitName: unit?.name ?? '', unitRate: unit ? String(unit.rate) : '', items: previous.items.map((item, index) => index === 0 && unit ? { ...item, rate: unit.rate, quantity: nights, quantityLabel: `${nights} nights`, total: unit.rate * nights } : item) }))
  }
  function setLine(index: number, key: keyof InvoiceLineItem, value: string) {
    setValues((previous) => ({ ...previous, items: previous.items.map((item, current) => {
      if (index !== current) return item
      const next = { ...item, [key]: key === 'description' || key === 'quantityLabel' ? value : Number(value) }
      const wasAuto = Math.abs(item.total - item.rate * item.quantity) < 0.01
      if ((key === 'rate' || key === 'quantity') && wasAuto) next.total = Number(next.rate) * Number(next.quantity)
      if (key === 'quantity' && item.quantityLabel === `${item.quantity} nights`) next.quantityLabel = `${value} nights`
      return next
    }) }))
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (values.checkOut <= values.checkIn) return
    onSubmit({ ...values, name: selectedGuest?.name ?? values.name, phone: selectedGuest?.phone ?? values.phone, unitName: selectedUnit?.name ?? values.unitName })
  }
  return <form className="modal-form" onSubmit={submit}>
    <div className="form-section-title"><span>01</span><div><b>Guest and stay</b><small>Who is the invoice for?</small></div></div>
    <label className="full-label">Select saved guest<select value={values.guestId} onChange={(event) => { const guest = guests.find((item) => item.id === event.target.value); setValues((previous) => ({ ...previous, guestId: event.target.value, name: guest?.name ?? '', phone: guest?.phone ?? '' })) }}><option value="">New guest</option>{guests.map((guest) => <option key={guest.id} value={guest.id}>{guest.name} · {guest.phone}</option>)}</select></label>
    {!values.guestId && <div className="form-grid"><label>Guest name<input required value={values.name} onChange={(event) => set('name', event.target.value)} placeholder="Full name" /></label><label>Phone number<input required type="tel" value={values.phone} onChange={(event) => set('phone', event.target.value)} placeholder="+254 7xx xxx xxx" /></label></div>}
    <label className="full-label">Accommodation unit<select value={values.unitId} onChange={(event) => setUnit(event.target.value)}><option value="">Enter a unit</option>{units.filter((unit) => unit.active).map((unit) => <option key={unit.id} value={unit.id}>{unit.name} · {money(unit.rate)}</option>)}</select></label>
    {!values.unitId && <div className="form-grid"><label>Unit name<input required value={values.unitName} onChange={(event) => set('unitName', event.target.value)} placeholder="e.g. 1 bedroom unit" /></label><label>Default rate per night<input min="0" type="number" step="0.01" value={values.unitRate} onChange={(event) => set('unitRate', event.target.value)} placeholder="0.00" /></label></div>}
    <div className="form-grid"><label>Check-in<input required type="date" value={values.checkIn} onChange={(event) => set('checkIn', event.target.value)} /></label><label>Check-out<input required type="date" min={addDays(values.checkIn, 1)} value={values.checkOut} onChange={(event) => set('checkOut', event.target.value)} /></label></div>
    <label className="full-label">Booking reference <span className="optional">optional</span><input value={values.bookingReference} onChange={(event) => set('bookingReference', event.target.value)} placeholder="Generated if left blank" /></label>
    <div className="form-section-title"><span>02</span><div><b>Charges</b><small>Each line total is entered and preserved independently of its rate.</small></div></div>
    <div className="line-items-editor"><div className="line-editor-head"><span>Description</span><span>Rate</span><span>Qty</span><span>Line total</span><span /></div>{values.items.map((item, index) => <div className="line-editor-row" key={item.id}><input aria-label="Charge description" required value={item.description} onChange={(event) => setLine(index, 'description', event.target.value)} placeholder="Accommodation" /><input aria-label="Rate" type="number" min="0" step="0.01" required value={item.rate} onChange={(event) => setLine(index, 'rate', event.target.value)} /><div className="quantity-field"><input aria-label="Quantity" type="number" min="0.01" step="0.01" required value={item.quantity} onChange={(event) => setLine(index, 'quantity', event.target.value)} /><input aria-label="Quantity label" value={item.quantityLabel} onChange={(event) => setLine(index, 'quantityLabel', event.target.value)} /></div><input aria-label="Line total" type="number" min="0" step="0.01" required value={item.total} onChange={(event) => setLine(index, 'total', event.target.value)} /><button type="button" className="icon-button remove-line" disabled={values.items.length === 1} onClick={() => set('items', values.items.filter((_, itemIndex) => itemIndex !== index))} title="Remove line"><X size={15} /></button></div>)}<button type="button" className="add-line" onClick={() => set('items', [...values.items, { id: id(), description: '', rate: 0, quantity: 1, quantityLabel: '1 night', total: 0 }])}><FilePlus2 size={15} />Add charge line</button></div>
    <div className="form-grid"><label>Discount<input type="number" min="0" step="0.01" value={values.discount} onChange={(event) => set('discount', event.target.value)} /></label><label>Additional charge<input type="number" min="0" step="0.01" value={values.additionalCharge} onChange={(event) => set('additionalCharge', event.target.value)} /></label></div>
    <div className="invoice-total-preview"><span>Subtotal <b>{money(subtotal)}</b></span><strong>Total payable <b>{money(total)}</b></strong></div>
    <div className="form-section-title"><span>03</span><div><b>Invoice dates</b><small>Issuing a bill does not record a payment.</small></div></div>
    <div className="form-grid"><label>Issue date<input required type="date" value={values.issueDate} onChange={(event) => set('issueDate', event.target.value)} /></label><label>Due date<input required type="date" min={values.issueDate} value={values.dueDate} onChange={(event) => set('dueDate', event.target.value)} /></label></div>
    <label className="full-label">Notes <span className="optional">optional</span><textarea rows={2} value={values.notes} onChange={(event) => set('notes', event.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy || !values.items.length}><FilePlus2 size={16} />{busy ? 'Saving…' : 'Create draft invoice'}</button></div>
  </form>
}

interface PaymentFormValues {
  standalone: boolean; invoiceId: string; guestId: string; name: string; phone: string; bookingId: string; bookingReference: string;
  unitId: string; checkIn: string; checkOut: string; amount: string; method: PaymentMethod; reference: string; description: string; receivedAt: string;
  smsMessage: string; smsParseStatus: '' | 'parsed' | 'invalid'; mpesaSender: string; mpesaAccount: string; confirmed: boolean;
}

function PaymentForm({ data, invoice, busy, onCancel, onSubmit }: { data: AppData; invoice?: Invoice; busy: boolean; onCancel: () => void; onSubmit: (values: PaymentFormValues) => void }) {
  const guest = invoice ? data.guests.find((item) => item.id === invoice.guestId) : undefined
  const booking = invoice ? data.bookings.find((item) => item.id === invoice.bookingId) : undefined
  const [values, setValues] = useState<PaymentFormValues>({
    standalone: !invoice, invoiceId: invoice?.id ?? '', guestId: guest?.id ?? '', name: guest?.name ?? '', phone: guest?.phone ?? '', bookingId: booking?.id ?? '',
    bookingReference: booking?.reference ?? '', unitId: booking?.unitId ?? '', checkIn: booking?.checkIn ?? today(), checkOut: booking?.checkOut ?? addDays(today(), 1),
    amount: invoice ? String(safeBalance(invoice, data.payments)) : '', method: 'M-Pesa', reference: '', description: '', receivedAt: nairobiDateTimeInput(new Date()),
    smsMessage: '', smsParseStatus: '', mpesaSender: '', mpesaAccount: '', confirmed: false,
  })
  const balance = invoice ? safeBalance(invoice, data.payments) : undefined
  const stayNights = Math.max(1, Math.round((new Date(`${values.checkOut}T12:00:00`).getTime() - new Date(`${values.checkIn}T12:00:00`).getTime()) / 86400000))
  function set<K extends keyof PaymentFormValues>(key: K, value: PaymentFormValues[K]) { setValues((previous) => ({ ...previous, [key]: value })) }
  function parseMessage(message: string) {
    const parsed = parseMpesaMessage(message)
    setValues((previous) => {
      if (!message.trim()) return { ...previous, smsMessage: message, smsParseStatus: '', mpesaSender: '', mpesaAccount: '' }
      if (!parsed) return { ...previous, smsMessage: message, smsParseStatus: 'invalid', reference: '', mpesaSender: '', mpesaAccount: '' }
      return {
        ...previous,
        smsMessage: message,
        smsParseStatus: 'parsed',
        amount: String(parsed.amount),
        method: 'M-Pesa',
        reference: parsed.reference,
        receivedAt: nairobiDateTimeInput(parsed.receivedAt),
        mpesaSender: parsed.sender,
        mpesaAccount: parsed.account,
        name: previous.guestId ? previous.name : parsed.sender,
      }
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (invoice && invoice.status !== 'issued') return
    if (!values.confirmed || (invoice && Number(values.amount) > (balance ?? 0))) return
    onSubmit({ ...values, invoiceId: invoice?.id ?? '' })
  }
  return <form className="modal-form" onSubmit={submit}>
    {invoice ? <div className="payment-context"><span><CircleDollarSign size={18} /></span><div><small>Outstanding balance</small><b>{money(balance ?? 0, data.settings.currency)}</b></div><span className="payment-context-guest">{guest?.name}</span></div> : <>
      <label className="full-label">Guest<select value={values.guestId} onChange={(event) => { const selected = data.guests.find((item) => item.id === event.target.value); setValues((previous) => ({ ...previous, guestId: event.target.value, name: selected?.name ?? '', phone: selected?.phone ?? '' })) }}><option value="">New guest</option>{data.guests.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.phone}</option>)}</select></label>
      {!values.guestId && <div className="form-grid"><label>Guest name<input required value={values.name} onChange={(event) => set('name', event.target.value)} /></label><label>Phone number<input required type="tel" value={values.phone} onChange={(event) => set('phone', event.target.value)} /></label></div>}
      <label className="full-label">Booking reference<input required value={values.bookingReference} onChange={(event) => set('bookingReference', event.target.value)} placeholder="Existing reservation reference" /></label>
      <label className="full-label">Accommodation unit <span className="optional">optional</span><select value={values.unitId} onChange={(event) => set('unitId', event.target.value)}><option value="">Not selected</option>{data.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="form-grid"><label>Check-in<input type="date" value={values.checkIn} onChange={(event) => set('checkIn', event.target.value)} /></label><label>Check-out<input type="date" min={addDays(values.checkIn, 1)} value={values.checkOut} onChange={(event) => set('checkOut', event.target.value)} /></label></div>
      <p className="form-hint">{stayNights} {stayNights === 1 ? 'night' : 'nights'} · This receipt will not be allocated to an invoice.</p>
    </>}
    {invoice && invoice.status === 'draft' && <div className="form-warning">Issue the invoice before recording a payment against it.</div>}
    <label className="full-label">Paste M-Pesa confirmation message <span className="optional">autofills amount, sender, account, code and date/time</span><textarea rows={3} value={values.smsMessage} onChange={(event) => parseMessage(event.target.value)} placeholder="Confirmed. You have received KES 2500.00 for Account 242025 from GERALD ENDIEGO. # Mpesa Ref:UJHLP9YDVS on 17-10-2026 09:59Hrs" /></label>
    {values.smsParseStatus === 'parsed' && <div className="parsed-message"><Check size={16} /><span><b>Message details extracted</b><small>{values.mpesaSender} · Account {values.mpesaAccount} · {values.reference}</small><small>The system cannot verify this message. Compare it with the original M-Pesa confirmation.</small></span></div>}
    {values.smsParseStatus === 'invalid' && <div className="form-warning">Could not read all payment details from this message. Enter and check the payment information manually.</div>}
    <div className="form-grid"><label>Amount received<input required type="number" min="0.01" max={balance} step="0.01" value={values.amount} onChange={(event) => set('amount', event.target.value)} /></label><label>Payment method<select value={values.method} onChange={(event) => set('method', event.target.value as PaymentMethod)}>{['M-Pesa', 'Cash', 'Bank transfer', 'Other'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
    <label className="full-label">M-Pesa transaction reference <span className="optional">optional</span><input value={values.reference} onChange={(event) => set('reference', event.target.value)} placeholder="Enter only the code shown by the guest" /></label>
    <label className="full-label">Charge description <span className="optional">optional</span><input value={values.description} onChange={(event) => set('description', event.target.value)} placeholder="Accommodation payment" /></label>
    <label className="full-label">Payment date and time (Kenya time)<input required type="datetime-local" value={values.receivedAt} onChange={(event) => set('receivedAt', event.target.value)} /></label>
    {invoice && <div className="balance-after">Balance after this payment <b>{money(Math.max(0, (balance ?? 0) - Number(values.amount || 0)), data.settings.currency)}</b></div>}
    <label className="payment-confirm"><input type="checkbox" required checked={values.confirmed} onChange={(event) => set('confirmed', event.target.checked)} /><span>I confirm this payment was actually received. The system does not independently verify pasted messages.</span></label>
    <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy || !Number(values.amount) || Number(values.amount) > (balance ?? Infinity)}><ReceiptText size={16} />{busy ? 'Recording…' : 'Record payment & issue receipt'}</button></div>
  </form>
}

interface AdjustmentFormValues { amount: string; direction: 'credit' | 'charge'; method: PaymentMethod; reference: string; description: string; date: string }
function AdjustmentForm({ kind, busy, onCancel, onSubmit }: { kind: 'refund' | 'adjustment'; busy: boolean; onCancel: () => void; onSubmit: (values: AdjustmentFormValues) => void }) {
  const [values, setValues] = useState<AdjustmentFormValues>({ amount: '', direction: 'credit', method: 'M-Pesa', reference: '', description: '', date: new Date().toISOString().slice(0, 16) })
  function set<K extends keyof AdjustmentFormValues>(key: K, value: AdjustmentFormValues[K]) { setValues((previous) => ({ ...previous, [key]: value })) }
  return <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit(values) }}>
    <div className="form-warning">{kind === 'refund' ? 'Record a refund only after money has actually been returned. Refunds do not create payment receipts.' : 'Credits reduce the balance due; additional charges increase it. This adjustment is preserved in the audit trail.'}</div>
    <div className="form-grid"><label>{kind === 'refund' ? 'Refund amount' : 'Adjustment amount'}<input required type="number" min="0.01" step="0.01" value={values.amount} onChange={(event) => set('amount', event.target.value)} /></label>{kind === 'adjustment' ? <label>Adjustment type<select value={values.direction} onChange={(event) => set('direction', event.target.value as 'credit' | 'charge')}><option value="credit">Credit (reduce due)</option><option value="charge">Charge (increase due)</option></select></label> : <label>Refund method<select value={values.method} onChange={(event) => set('method', event.target.value as PaymentMethod)}>{['M-Pesa', 'Cash', 'Bank transfer', 'Other'].map((item) => <option key={item}>{item}</option>)}</select></label>}</div>
    <label className="full-label">Reason<input required value={values.description} onChange={(event) => set('description', event.target.value)} placeholder="Reason for this record" /></label>
    <label className="full-label">Reference <span className="optional">optional</span><input value={values.reference} onChange={(event) => set('reference', event.target.value)} /></label>
    <label className="full-label">Date<input required type="datetime-local" value={values.date} onChange={(event) => set('date', event.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : kind === 'refund' ? 'Record refund' : 'Save adjustment'}</button></div>
  </form>
}

function UnitForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (unit: Unit) => void }) {
  const [name, setName] = useState('')
  const [rate, setRate] = useState('')
  return <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ id: id(), name: name.trim(), rate: Number(rate), active: true }) }}><label className="full-label">Unit name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. 1 bedroom unit" /></label><label className="full-label">Default rate per night<input required type="number" min="0" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} /></label><div className="modal-actions"><button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy}><BedDouble size={16} />Save unit</button></div></form>
}

export default App