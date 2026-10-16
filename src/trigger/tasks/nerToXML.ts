import type { NERResults } from '../types';
import { parseXML } from '@recogito/standoff-converter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element as XmlElement } from '@xmldom/xmldom';
import * as uuid from 'uuid';
import { heartbeats, logger } from '@trigger.dev/sdk/v3';
import { indexedXPointers } from '../indexedXPointers.js';

/**
 * Backward-compat shim: older `@recogito/standoff-converter` versions put tag
 * references on a nested `<rs ana="#tag"/>`, but the Recogito Studio client
 * reads `ana` directly off `<annotation>`.
 * 
 * The converter now emits `ana` on `<annotation>` itself (see its
 * annotation-to-xml crosswalk), so for current output this is a no-op. 
 * Kept as a precaution while documents produced by older converter versions
 * are still in circulation.
 * 
 * See: https://github.com/recogito/plugin-ner/pull/5#issuecomment-5263203227
 */
const hoistAnaOntoAnnotations = (tei: string): string => {
  const doc = new DOMParser().parseFromString(tei, 'text/xml');

  const annotations = doc.getElementsByTagName('annotation');
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];

    const rsElements: XmlElement[] = [];
    for (let j = 0; j < annotation.childNodes.length; j++) {
      const child = annotation.childNodes[j];
      if (child.nodeType === 1 && child.nodeName === 'rs') {
        rsElements.push(child as XmlElement);
      }
    }

    const anas = rsElements
      .map((rs) => rs.getAttribute('ana'))
      .filter((ana): ana is string => Boolean(ana));

    if (anas.length > 0) {
      const existing = annotation.getAttribute('ana');
      annotation.setAttribute(
        'ana',
        [existing, ...anas].filter(Boolean).join(' ')
      );
      rsElements.forEach((rs) => annotation.removeChild(rs));
    }
  }

  return new XMLSerializer().serializeToString(doc);
};

export const nerToXML = async (
  payload: { nerData: NERResults; text: string; originalXML?: string }
) => {
    const { nerData, text, originalXML } = payload;

    let xml: string | undefined = originalXML;
    if (!xml) {
      xml = `
    <TEI xmlns="http://www.tei-c.org/ns/1.0">
      <teiHeader>
        <fileDesc>
          <titleStmt>
            <title>Untitled Text</title>
          </titleStmt>
          <publicationStmt>
            <p>Unpublished</p>
          </publicationStmt>
          <sourceDesc>
            <p>Plain text input</p>
          </sourceDesc>
        </fileDesc>
      </teiHeader>
      <text>
        <body>
          ${text
            .split('\n\n')
            .map(
              (paragraph) =>
                `<p>${paragraph
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')}</p>`
            )
            .join('\n')}
        </body>
      </text>
    </TEI>
  `;
    }

    const startedAt = Date.now();
    logger.info('Parsing NER XML', { entityCount: nerData.entries.length });
    await heartbeats.yield();

    const standoff = parseXML(xml);

    logger.info('Indexing NER annotation targets', { entityCount: nerData.entries.length });
    const offsets: number[] = [];
    for (const entry of nerData.entries) {
      if (entry.endIndex < entry.startIndex || entry.endIndex > text.length) {
        throw new Error('Invalid NER annotation range');
      }
      offsets.push(entry.startIndex, entry.endIndex);
    }
    const targets = await indexedXPointers(standoff.tokens, offsets);

    const standoffId = uuid.v4();
    standoff.addStandOff(standoffId);
    const taxonomyId = `taxonomy-${standoffId}`;
    const categories = new Map<string, string>();
    for (const entry of nerData.entries) {
      if (entry.inlineTag && !categories.has(entry.inlineTag)) {
        categories.set(entry.inlineTag, entry.localizedTag);
      }
    }
    if (categories.size) {
      standoff.addTaxonomy(taxonomyId);
      for (const [id, label] of categories) standoff.addTaxonomyCategory(taxonomyId, id, label);
    }
    // Construct the output DOM once. Repeated addStandOffTag calls scan and
    // splice an ever-growing token array and recreate taxonomy entries.
    const root = standoff.xml();
    const doc = root.ownerDocument!;
    const ns = 'http://www.tei-c.org/ns/1.0';
    const groups = root.getElementsByTagNameNS(ns, 'standOff');
    let list: Element | undefined;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].getAttribute('xml:id') === standoffId) {
        list = groups[i].getElementsByTagNameNS(ns, 'listAnnotation')[0];
        break;
      }
    }
    if (!list) throw new Error('No NER annotation list in output XML');
    logger.info('Adding NER annotations', { entityCount: nerData.entries.length });

    for (let i = 0; i < nerData.entries.length; i++) {
      // async alone does not release the event loop. The SDK periodically
      // yields to timers so the worker can send its 30-second heartbeats.
      await heartbeats.yield();

      const entry = nerData.entries[i];

      const annotation = doc.createElementNS(ns, 'annotation');
      annotation.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', `uid-${uuid.v4()}`);
      annotation.setAttribute('target', `${targets.get(entry.startIndex)} ${targets.get(entry.endIndex)}`);
      const tag = doc.createElementNS(ns, 'rs');
      tag.setAttribute('ana', entry.inlineTag ? (entry.inlineTag.startsWith('http') ? entry.inlineTag : `#${entry.inlineTag}`) : entry.localizedTag);
      annotation.appendChild(tag);
      list.appendChild(annotation);
      if ((i + 1) % 1000 === 0 || i + 1 === nerData.entries.length) {
        logger.info('NER annotation progress', {
          completed: i + 1,
          total: nerData.entries.length,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    await heartbeats.yield();
    logger.info('Serializing NER XML', { entityCount: nerData.entries.length });
    const tei = hoistAnaOntoAnnotations(root.toString());

    logger.info('NER XML conversion completed', {
      elapsedMs: Date.now() - startedAt,
    });
    return { tei };
};
