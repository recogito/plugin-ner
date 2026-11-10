import { parseXML } from '@recogito/standoff-converter';

export const xmlToPlainText = async (payload: { xml: string }) => {
    const { xml } = payload;

    const standoff = parseXML(xml);

    const newXML = standoff.xmlString();
    const newText = standoff.text();

    return { xml: newXML, text: newText };
};
