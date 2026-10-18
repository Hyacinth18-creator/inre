# Shwari Home Stays

## Run locally

Install dependencies with `npm install`, then run `npm run dev`. The app and its local SQLite API start together.

## Deploy to Vercel with Supabase

1. Create a Supabase project and open **SQL Editor**.
2. Run the contents of [`supabase/schema.sql`](./supabase/schema.sql).
3. In Supabase, copy the **Transaction pooler** connection string from **Project Settings → Database → Connection string**.
4. In Vercel, add that connection string as the `DATABASE_URL` environment variable for Production (and Preview if needed). Keep it server-side; do not use a `VITE_` prefix or expose it to the browser.
5. Import the repository into Vercel and deploy with the project root as the root directory. The Vercel build configuration is included in `vercel.json`.

The first browser load attempts to migrate records from this browser's existing IndexedDB storage. Records in a local SQLite file are not uploaded by deployment; export a backup from the existing installation and restore it in the deployed app after the API is configured.
