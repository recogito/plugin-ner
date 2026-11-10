import { parseXML } from '@recogito/standoff-converter';

export const plainTextToXML = async (payload: { text: string }) => {
    const { text } = payload;

    const xml = `
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

    const standoff = parseXML(xml);

    const newXML = standoff.xmlString();
    const newText = standoff.text();

    return { xml: newXML, text: newText };
};
