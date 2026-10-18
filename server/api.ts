import express, { type ErrorRequestHandler } from 'express'
import { DatabaseError, type ShwariDatabase } from './database.js'

export function createApp(database: ShwariDatabase) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '5mb' }))

  app.get('/api/health', (_request, response) => response.json({ ok: true, database: 'sqlite' }))
  app.get('/api/data', (_request, response) => response.json(database.readData()))
  app.get('/api/backup', (_request, response) => response.json(database.exportBackup()))
  app.post('/api/backup/restore', (request, response) => {
    database.importBackup(request.body)
    response.status(204).end()
  })
  app.post('/api/migrate', (request, response) => {
    database.importBackup(request.body, true)
    response.json({ migrated: database.hasRecords() })
  })
  app.post('/api/guests', (request, response) => {
    database.saveGuest(request.body)
    response.status(201).end()
  })
  app.post('/api/units', (request, response) => {
    database.saveUnit(request.body)
    response.status(201).end()
  })
  app.post('/api/bookings', (request, response) => {
    database.saveBooking(request.body)
    response.status(201).end()
  })
  app.post('/api/invoices', (request, response) => {
    database.saveInvoice(request.body)
    response.status(201).end()
  })
  app.post('/api/invoices/:id/issue', (request, response) => {
    response.json(database.issueInvoice(request.params.id, String(request.body.prefix ?? 'SHS/INV')))
  })
  app.post('/api/payments', (request, response) => {
    const { payment, receiptPrefix } = request.body as { payment: unknown; receiptPrefix: string }
    response.status(201).json(database.recordPayment(payment as never, receiptPrefix))
  })
  app.post('/api/adjustments', (request, response) => {
    database.recordAdjustment(request.body)
    response.status(201).end()
  })
  app.put('/api/settings', (request, response) => {
    database.saveSettings(request.body)
    response.status(204).end()
  })

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const known = error instanceof DatabaseError
    const status = known ? error.status : 400
    response.status(status).json({ error: error instanceof Error ? error.message : 'The request could not be completed.' })
  }
  app.use(errorHandler)
  return app
}