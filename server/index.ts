import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import express from 'express'
import { createApp } from './api.js'
import { createDatabase } from './database.js'

const databasePath = resolve(process.env.SHWARI_DB_PATH ?? './data/shwari.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })
const database = createDatabase(databasePath)
const app = createApp(database)
const builtFrontend = resolve('./dist')

app.use(express.static(builtFrontend))
app.use((request, response, next) => {
  if (request.method === 'GET' && !request.path.startsWith('/api/')) {
    response.sendFile(resolve(builtFrontend, 'index.html'), (error) => { if (error) next() })
    return
  }
  next()
})

const port = Number(process.env.PORT ?? 8787)
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Shwari Home Stays API listening on http://localhost:${port}`)
  console.log(`SQLite database: ${databasePath}`)
})

function shutdown() {
  server.close(() => {
    database.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)