/**
 * Password hashing — scrypt (memory-hard, N=2^15) from Node's crypto module.
 * Encoding: `scrypt$N$r$p$salt$hash`, self-describing so parameters can be
 * upgraded later without invalidating existing hashes.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

type ScryptOptions = { N: number; r: number; p: number; maxmem: number }
const scryptAsync = promisify(scrypt as unknown as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>)

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLen: 64 }
export const MIN_PASSWORD_LENGTH = 10

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scryptAsync(password.normalize('NFKC'), salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 128 * PARAMS.N * PARAMS.r * 2,
  })) as Buffer
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const derived = (await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    })) as Buffer
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

export type PasswordCheck = { ok: boolean; problems: string[]; strength: number }

export function checkPasswordStrength(password: string): PasswordCheck {
  const problems: string[] = []
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`At least ${MIN_PASSWORD_LENGTH} characters`)
  if (!/[a-z]/.test(password)) problems.push('One lowercase letter')
  if (!/[A-Z]/.test(password)) problems.push('One uppercase letter')
  if (!/[0-9]/.test(password)) problems.push('One number')
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  let strength = 0
  if (password.length >= 10) strength += 25
  if (password.length >= 14) strength += 15
  if (password.length >= 18) strength += 10
  strength += classes * 12
  return { ok: problems.length === 0, problems, strength: Math.min(100, strength) }
}
