/** What we know about the PERSON on the other end, beyond their name and language. */
export type RecipientGender = 'male' | 'female';

/**
 * Resolve per-person facts a customer-facing message needs to be written correctly.
 *
 * Exists because gendered languages force a choice English never does: with
 * `preferred_language='es'` and no gender, "welcome aboard" can only be written as the
 * hedge "¡Bienvenido/a a bordo!", which no native speaker would send. The name is not a
 * reliable signal (and guessing from one is exactly the failure mode to avoid), so this
 * reads the founder's own curated record instead.
 *
 * ALWAYS best-effort: `null` means "not known — write something that works for anyone",
 * never "assume". Implementations must swallow their own failures and return null rather
 * than break a draft.
 */
export interface RecipientProfilePort {
  /** `address` is the channel-native id (digits-only phone, lowercased email). */
  resolveGender(channelType: string, address: string): Promise<RecipientGender | null>;
}
