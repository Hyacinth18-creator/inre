import { createApp } from '../server/api.js'
import { createPostgresDatabase } from '../server/postgresDatabase.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL must be configured for the Vercel deployment.')

export default createApp(createPostgresDatabase(connectionString))
