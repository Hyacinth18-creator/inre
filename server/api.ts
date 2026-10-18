import express, { type ErrorRequestHandler } from 'express'
import { DatabaseError } from './databaseErrors.js'
import type { ShwariDatabase } from './databaseTypes.js'

export function createApp(database: ShwariDatabase) {
  const app = express()
  app.disable('x-powered-by')
  app.use((request, _response, next) => {
    const forwardedPath = request.query.path
    if (request.path === '/api/index' && typeof forwardedPath === 'string') request.url = `/api/${forwardedPath}`
    next()
  })
  app.use(express.json({ limit: '5mb' }))

  app.get('/api/health', (_request, response) => response.json({ ok: true }))
  app.get('/api/data', async (_request, response) => response.json(await database.readData()))
  app.get('/api/backup', async (_request, response) => response.json(await database.exportBackup()))
  app.post('/api/backup/restore', async (request, response) => {
    await database.importBackup(request.body)
    response.status(204).end()
  })
  app.post('/api/migrate', async (request, response) => {
    await database.importBackup(request.body, true)
    response.json({ migrated: await database.hasRecords() })
  })
  app.post('/api/guests', async (request, response) => {
    await database.saveGuest(request.body)
    response.status(201).end()
  })
  app.post('/api/units', async (request, response) => {
    await database.saveUnit(request.body)
    response.status(201).end()
  })
  app.post('/api/bookings', async (request, response) => {
    await database.saveBooking(request.body)
    response.status(201).end()
  })
  app.post('/api/invoices', async (request, response) => {
    await database.saveInvoice(request.body)
    response.status(201).end()
  })
  app.post('/api/invoices/:id/issue', async (request, response) => {
    response.json(await database.issueInvoice(request.params.id, String(request.body.prefix ?? 'SHS/INV')))
  })
  app.post('/api/payments', async (request, response) => {
    const { payment, receiptPrefix } = request.body as { payment: unknown; receiptPrefix: string }
    response.status(201).json(await database.recordPayment(payment as never, receiptPrefix))
  })
  app.post('/api/adjustments', async (request, response) => {
    await database.recordAdjustment(request.body)
    response.status(201).end()
  })
  app.put('/api/settings', async (request, response) => {
    await database.saveSettings(request.body)
    response.status(204).end()
  })

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const known = error instanceof DatabaseError
    const status = known ? error.status : 500
    response.status(status).json({ error: error instanceof Error ? error.message : 'The request could not be completed.' })
  }
  app.use(errorHandler)
  return app
}