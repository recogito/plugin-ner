import { task } from '@trigger.dev/sdk/v3';
import type { NERResults } from '../types';
import { parseXML } from '@recogito/standoff-converter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element as XmlElement } from '@xmldom/xmldom';
import * as uuid from 'uuid';

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

export const nerToXML = task({
  id: 'ner-to-xml',
  run: async (
    payload: { nerData: NERResults; text: string; originalXML?: string },
    { ctx }
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

    const standoff = parseXML(xml);

    const standoffId = uuid.v4();
    standoff.addStandOff(standoffId);

    for (let i = 0; i < nerData.entries.length; i++) {
      const entry = nerData.entries[i];

      standoff.addStandOffTag(standoffId, entry.startIndex, entry.endIndex, {
        label: entry.localizedTag,
        id: entry.inlineTag,
      });
      // standoff.addStandOffTag(
      //   standoffId,
      //   entry.startIndex,
      //   entry.endIndex,
      //   entry.localizedTag
      // );
    }

    const tei = hoistAnaOntoAnnotations(standoff.xmlString());
    return { tei };
  },
});
