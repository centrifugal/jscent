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

const VALUE = /^[a-z][a-z0-9_]*$/;

/**
 * The values a field's comment lists in the sentence "One of: add, remove,
 * set." - after "One of:", up to the period, separated by commas - or
 * undefined without one. A malformed sentence throws, rather than leaving the
 * field without its constants.
 */
export function listedValues(doc: string[]): string[] | undefined {
  const text = doc.join(' ');
  const at = text.indexOf('One of:');
  if (at < 0) {
    return undefined;
  }
  const rest = text.slice(at + 'One of:'.length);
  const end = rest.indexOf('.');
  if (end < 0) {
    throw new Error('the values after "One of:" must end with a period');
  }
  const values: string[] = [];
  for (const raw of rest.slice(0, end).split(',')) {
    const v = raw.trim();
    if (!VALUE.test(v)) {
      throw new Error(`"${v}" is not a value: lowercase letters, digits and underscores`);
    }
    if (values.includes(v)) {
      throw new Error(`value "${v}" listed twice`);
    }
    values.push(v);
  }
  return values;
}

/**
 * The constants of a string field with listed values: the values, and the
 * messages whose field of that name lists exactly them. prefix is the message
 * name, when the field's name alone would be ambiguous.
 */
export interface ConstGroup {
  field: string;
  values: string[];
  messages: string[];
  prefix: string;
}

/** SCREAMING_SNAKE_CASE of a snake_case or PascalCase name: FilterNode -> FILTER_NODE. */
function screaming(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The constant of one value of a group: OP_ADD, FILTER_NODE_OP_AND. */
export function constName(g: ConstGroup, value: string): string {
  return [g.prefix, g.field, value].filter(Boolean).map(screaming).join('_');
}

/**
 * The fields with listed values of the messages include accepts, as groups, in
 * the order of the proto. Where fields of one name list different values in
 * different messages, the set listed in the most messages keeps the short name
 * and the others are named by their message too - OP_ADD for the topic
 * updates, FILTER_NODE_OP_AND for FilterNode - and a tie names all of them so.
 * The rule runs over one proto: the API's and the proxy's constants live
 * apart.
 */
export function constGroups(messages: Message[], include: (name: string) => boolean): ConstGroup[] {
  const byField = new Map<string, ConstGroup[]>();
  for (const m of messages) {
    if (!include(m.name)) {
      continue;
    }
    for (const f of m.fields) {
      let values: string[] | undefined;
      try {
        values = listedValues(f.doc);
      } catch (e) {
        throw new Error(`${m.name}.${f.name}: ${(e as Error).message}`);
      }
      if (values === undefined) {
        continue;
      }
      if (f.type !== 'string') {
        throw new Error(`${m.name}.${f.name}: only string fields list values, not ${f.type}`);
      }
      const groups = byField.get(f.name) ?? [];
      byField.set(f.name, groups);
      let g = groups.find((o) => o.values.join() === values.join());
      if (g === undefined) {
        g = { field: f.name, values, messages: [], prefix: '' };
        groups.push(g);
      }
      g.messages.push(m.name);
    }
  }
  const out: ConstGroup[] = [];
  for (const [name, groups] of byField) {
    if (groups.length > 1) {
      const most = Math.max(...groups.map((g) => g.messages.length));
      const tie = groups.filter((g) => g.messages.length === most).length > 1;
      for (const g of groups) {
        if (tie || g.messages.length < most) {
          if (g.messages.length > 1) {
            throw new Error(
              `field ${name} lists ${g.values.join(', ')} in ${g.messages.join(', ')} and other values elsewhere: cannot name its constants`,
            );
          }
          g.prefix = g.messages[0]!;
        }
      }
    }
    out.push(...groups);
  }
  const seen = new Set<string>();
  for (const g of out) {
    for (const v of g.values) {
      const c = constName(g, v);
      if (seen.has(c)) {
        throw new Error(`two constants named ${c}`);
      }
      seen.add(c);
    }
  }
  return out;
}
