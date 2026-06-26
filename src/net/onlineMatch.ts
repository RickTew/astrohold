// Online 2-player match API for AstroHold.
//
// Thin, typed wrapper over the schema-scoped Supabase client. Every call
// here maps to an operation already PROVEN end-to-end against the live hub
// (anonymous sign-in -> profile -> create/join match -> realtime). The
// eventual lobby UI calls these functions; it should not touch the client
// directly.
//
// Not yet imported by gameplay - this is the net layer the lobby + sync
// will build on.

import { getSupabase } from './supabaseClient'

export type MatchSide = 'attacker' | 'defender'
export type MatchStatus = 'waiting' | 'active' | 'complete' | 'abandoned'
export type MatchPhase = 'build' | 'reveal' | 'complete'

export interface OnlineMatch {
  id: string
  attacker_id: string | null
  defender_id: string | null
  status: MatchStatus
  invite_token: string | null
  current_turn: number
  current_phase: MatchPhase
  winner_side: MatchSide | null
  attacker_credits: number
  defender_credits: number
  state: unknown | null
}

/**
 * Sign in as an anonymous guest. Idempotent: reuses an existing persisted
 * session if there is one, otherwise mints a new anonymous user. Returns
 * the player's auth user id (= their profile id).
 */
export async function ensureSignedIn(): Promise<string> {
  const sb = getSupabase()
  const { data: { session } } = await sb.auth.getSession()
  if (session?.user) return session.user.id
  const { data, error } = await sb.auth.signInAnonymously()
  if (error) throw error
  if (!data.user) throw new Error('anonymous sign-in returned no user')
  return data.user.id
}

/**
 * Ensure the signed-in player has a profile row. RLS lets a player write
 * only their own (`auth.uid() = id`), so this is safe to call on boot.
 */
export async function ensureProfile(username?: string): Promise<void> {
  const sb = getSupabase()
  const uid = await ensureSignedIn()
  const { error } = await sb.from('profiles').upsert(
    { id: uid, username: username ?? `guest_${uid.slice(0, 8)}`, is_guest: true },
    { onConflict: 'id', ignoreDuplicates: true },
  )
  if (error) throw error
}

// 6-char invite code from an unambiguous alphabet (no 0/O/1/I/L).
function randomInviteToken(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return s
}

/**
 * Create a new match seating the creator on `side`. Returns the match,
 * including the `invite_token` to share with the opponent.
 */
export async function createMatch(side: MatchSide): Promise<OnlineMatch> {
  const sb = getSupabase()
  const uid = await ensureSignedIn()
  await ensureProfile()
  const seat = side === 'attacker' ? { attacker_id: uid } : { defender_id: uid }
  const { data, error } = await sb.from('matches')
    .insert({ ...seat, status: 'waiting', invite_token: randomInviteToken() })
    .select()
    .single()
  if (error) throw error
  return data as OnlineMatch
}

/**
 * Join an open match by its invite code. Routes through the SECURITY
 * DEFINER `join_match` RPC, which validates + seats the joiner into the
 * open slot and flips the match to `active`.
 */
export async function joinMatch(inviteToken: string): Promise<OnlineMatch> {
  const sb = getSupabase()
  await ensureSignedIn()
  const { data, error } = await sb.rpc('join_match', { p_invite_token: inviteToken })
  if (error) throw error
  return (Array.isArray(data) ? data[0] : data) as OnlineMatch
}

/** Fetch a single match by id (or null if not visible / not found). */
export async function getMatch(matchId: string): Promise<OnlineMatch | null> {
  const sb = getSupabase()
  const { data, error } = await sb.from('matches')
    .select('*').eq('id', matchId).maybeSingle()
  if (error) throw error
  return (data as OnlineMatch | null) ?? null
}

/** The signed-in player's side in a match, or null if they're not in it. */
export async function mySideIn(match: OnlineMatch): Promise<MatchSide | null> {
  const uid = await ensureSignedIn()
  if (match.attacker_id === uid) return 'attacker'
  if (match.defender_id === uid) return 'defender'
  return null
}

/**
 * Subscribe to live UPDATEs on a single match row (status flips, phase /
 * turn changes, state snapshots). Returns an unsubscribe function.
 */
export function subscribeToMatch(
  matchId: string,
  onChange: (match: OnlineMatch) => void,
): () => void {
  const sb = getSupabase()
  const channel = sb
    .channel(`match:${matchId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'astro_hold', table: 'matches', filter: `id=eq.${matchId}` },
      (payload) => onChange(payload.new as OnlineMatch),
    )
    .subscribe()
  return () => { sb.removeChannel(channel) }
}
