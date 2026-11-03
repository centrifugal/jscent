// What the generator reads in the protos' comments, apart from the writing of
// the code so that tests can pin it: the presence wrappers and the required
// fields.

import type { Field, Message } from './proto.ts';

/**
 * A field the proto marks "Required." without a condition: "Required unless
 * ..." and "Required when ..." are conditional, and so are not.
 */
export function isRequired(f: Field): boolean {
  return /\bRequired\./.test(f.doc.join(' '));
}

/**
 * A required field whose comment gives its empty value a meaning after
 * "Required." - `"" detaches the devices`, `An empty map clears it.` It stays
 * a required property, but is not checked before sending: empty is one of its
 * values.
 */
export function emptyHasMeaning(f: Field): boolean {
  const doc = f.doc.join(' ');
  const at = doc.search(/\bRequired\./);
  if (at < 0) {
    return false;
  }
  const after = doc.slice(at + 'Required.'.length);
  return after.includes('""') || /\bempty\b/i.test(after);
}

/**
 * A presence wrapper: a message with one field which Centrifugo reads by
 * whether it is there - a `*Value` message whose field is `value`, or one
 * whose only field's empty value has a meaning (device_update's updates). It is
 * sent whenever it is set, even empty.
 */
export function isPresence(m: Message | undefined): boolean {
  if (m === undefined || m.fields.length !== 1) {
    return false;
  }
  const f = m.fields[0]!;
  return (m.name.endsWith('Value') && f.name === 'value') || emptyHasMeaning(f);
}

/** A field checked for a value before sending: required, and empty is not one of its values. */
export function isChecked(f: Field): boolean {
  return isRequired(f) && !emptyHasMeaning(f);
}
