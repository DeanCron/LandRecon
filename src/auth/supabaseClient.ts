import type { SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const authConfigured = Boolean(url && key)

let clientPromise: Promise<SupabaseClient | null> | null = null

// supabase-js is loaded on demand so it stays out of the entry bundle. Returns
// null when the env vars are missing, which keeps the app fully anonymous.
export function getSupabase(): Promise<SupabaseClient | null> {
  if (!authConfigured) return Promise.resolve(null)
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url!, key!, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }),
  )
  return clientPromise
}
