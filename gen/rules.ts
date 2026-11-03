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
 * The constants of the fields with listed values which one pinned name
 * covers: the name, the values, and the messages whose field lists them.
 */
export interface ConstGroup {
  name: string;
  values: string[];
  messages: string[];
  field: string;
}

/** A pin of constants: `Message.field Name`, or `*.field Name` for the field in every message which has it. */
export interface Pin {
  selector: string;
  name: string;
}

/** The pins of a constants file: a selector and a name per line, # comments. */
export function parsePins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const m = line.match(/^(\*|[A-Z]\w*)\.([a-z][a-z0-9_]*)\s+([A-Z][A-Za-z0-9]*)$/);
    if (!m) {
      throw new Error(`${file}:${i + 1}: expected "Message.field Name" or "*.field Name"`);
    }
    pins.push({ selector: `${m[1]}.${m[2]}`, name: m[3]! });
  }
  return pins;
}

/** SCREAMING_SNAKE_CASE of a snake_case or PascalCase name: FilterNodeOp -> FILTER_NODE_OP. */
function screaming(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The constant of one value of a group: OP_ADD, FILTER_NODE_OP_AND. */
export function constName(g: ConstGroup, value: string): string {
  return `${screaming(g.name)}_${screaming(value)}`;
}

/**
 * The fields with listed values of the messages include accepts, grouped by
 * the names pins give them, in the order of the proto. The names are pinned,
 * as the spec's table gives them, rather than derived, so that a name never
 * changes because another message appeared: a field with a "One of:"
 * sentence no pin names, a pin no field uses, and one name over different
 * values each fail.
 */
export function constGroups(messages: Message[], include: (name: string) => boolean, pins: Pin[]): ConstGroup[] {
  const used = new Set<Pin>();
  const byName = new Map<string, ConstGroup>();
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
      const pin =
        pins.find((p) => p.selector === `${m.name}.${f.name}`) ?? pins.find((p) => p.selector === `*.${f.name}`);
      if (pin === undefined) {
        throw new Error(`${m.name}.${f.name} lists its values, but no pin names its constants: add one`);
      }
      used.add(pin);
      const g = byName.get(pin.name);
      if (g === undefined) {
        byName.set(pin.name, { name: pin.name, values, messages: [m.name], field: f.name });
      } else if (g.values.join() !== values.join()) {
        throw new Error(
          `${pin.name} names ${g.values.join(', ')} in ${g.messages.join(', ')} and ${values.join(', ')} in ${m.name}`,
        );
      } else {
        g.messages.push(m.name);
      }
    }
  }
  for (const p of pins) {
    if (!used.has(p)) {
      throw new Error(`the pin ${p.selector} ${p.name} names no field with listed values`);
    }
  }
  return [...byName.values()];
}
