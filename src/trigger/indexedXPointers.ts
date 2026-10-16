import type { MarkupToken } from '@recogito/standoff-converter';
import { heartbeats } from '@trigger.dev/sdk/v3';

// Match converter.getXPointer against the immutable source token stream, but
// visit the tokens once for all offsets rather than once per annotation end.
export const indexedXPointers = async (tokens: MarkupToken[], offsets: number[]) => {
  const positions = [...new Set(offsets)].sort((a, b) => a - b);
  const result = new Map<number, string>();
  const paths = new WeakMap<Element, string>();
  const path = (el: Element): string => {
    const cached = paths.get(el);
    if (cached !== undefined) return cached;
    let prefix = '';
    let predicate: string;
    if (el.hasAttribute('xml:id')) {
      prefix = '/';
      predicate = `[@xml:id='${el.getAttribute('xml:id')}']`;
    } else {
      if (el.parentElement) prefix = path(el.parentElement);
      let index = 1;
      for (let previous = el.previousSibling; previous; previous = previous.previousSibling) {
        if (previous.nodeType === 1 && (previous as Element).tagName === el.tagName) index++;
      }
      predicate = `[${index}]`;
    }
    const value = `${prefix}/${el.getAttribute('data-origname') || el.tagName}${predicate}`;
    paths.set(el, value);
    return value;
  };
  const stack: MarkupToken[] = [];
  let cursor = 0;
  for (let i = 0; i < positions.length; i++) {
    const offset = positions[i];
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid NER character offset');
    while (cursor < tokens.length && tokens[cursor].position <= offset) {
      const token = tokens[cursor++];
      if (token.type === 'open') stack.push(token);
      else if (token.type === 'close') {
        const index = stack.findIndex(item => item.el === token.el);
        if (index !== -1) stack.splice(index, 1);
      }
    }
    const context = stack[stack.length - 1];
    if (!context?.el) throw new Error('NER character offset has no XML context');
    result.set(offset, `${path(context.el)}::${offset - context.position}`);
    if (i % 1000 === 0) await heartbeats.yield();
  }
  return result;
};
