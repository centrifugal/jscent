/**
 * Refuses a key of an options or claims object which is not one of known: a
 * misspelled option, or a claim in its wire name, would otherwise be dropped
 * without a word - an `expire_at` claim, say, leaving the connection to live
 * until the token's expiry. The error suggests the key meant: the one which
 * differs only in case or in snake_case, or one of renamed, the names of
 * jscent 0.x.
 *
 * @internal
 */
export function checkKeys(
  obj: object,
  known: readonly string[],
  what: string,
  fail: (message: string) => Error,
  renamed: Readonly<Record<string, string>> = {},
): void {
  for (const key of Object.keys(obj)) {
    if (known.includes(key) || (obj as Record<string, unknown>)[key] === undefined) {
      continue;
    }
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const like =
      known.find((k) => k === camel || k.toLowerCase() === key.toLowerCase()) ??
      (Object.hasOwn(renamed, key) ? renamed[key] : undefined);
    throw fail(`unknown ${what} ${key}${like ? `: did you mean ${like}?` : ''}`);
  }
}
