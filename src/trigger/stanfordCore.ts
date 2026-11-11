import { task, logger } from '@trigger.dev/sdk/v3';
import * as uuid from 'uuid';
import { uploadDocumentToRS } from './tasks/uploadDocumentToRS.js';
import { doStanfordNlp } from './tasks/doStandfordNlp.js';
import { nerToXML } from './tasks/nerToXML.js';
import { plainTextToXML } from './tasks/plainTextToXML.js';
import { createClient } from '@supabase/supabase-js';
import { Document } from '@recogito/studio-sdk';
import { xmlToPlainText } from './tasks/xmlToPlainText.js';

const translations = (docName: string) => ({
  success: {
    en: `Your document, ${docName}, has successfully been processed through NER and is now available in your project`,
    de: `Dein Dokument "${docName}" wurde erfolgreich per NER verarbeitet und ist nun im Projekt verfügbar.`,
  },
  failure: {
    en: `NER on "${docName}" could not be completed. Please try again, or contact your administrator if the problem continues.`,
    de: `Die NER-Verarbeitung von "${docName}" konnte nicht abgeschlossen werden. Bitte versuche es erneut oder wende Dich an Deine Administratorin bzw. Deinen Administrator.`,
  },
  goto: {
    en: 'Go to your project',
    de: 'Zu Deinem Projekt',
  },
});

export const stanfordCore = task({
  id: 'stanford-core',
  retry: { maxAttempts: 1 },
  run: async (payload: {
    serverURL: string;
    projectId: string;
    documentId: string;
    nameOut: string;
    language: 'en' | 'de';
    outputLanguage: 'en' | 'de';
    key: string;
    token: string;
    userId: string;
  }) => {
    logger.info('Creating Supabase client');
    const supabase = createClient(payload.serverURL, payload.key, {
      global: {
        headers: {
          Authorization: `Bearer ${payload.token}`,
        },
      },
    });

    if (supabase) {
      logger.info('Get Document data');
      const docResult = await supabase
        .from('documents')
        .select()
        .eq('id', payload.documentId)
        .single();

      if (docResult.error) {
        logger.error(docResult.error.message);
        throw new Error('Failed to fetch document data');
      }

      const doc: Document = docResult.data as unknown as Document;
      if (!['text/xml', 'text/plain'].includes(doc.content_type || '')) {
        logger.error('Wrong content type');
        throw new Error('Wrong content type');
      }

      logger.info('Downloading File');
      const { data, error } = await supabase.storage
        .from('documents')
        .download(payload.documentId);

      if (error) {
        logger.error(error.message);
        throw new Error('Failed to download document');
      }

      let text: string;
      let xml: string;
      if (doc.content_type === 'text/plain') {
        const initialText = await data.text();

        logger.info('Calling Plain Text to XML');
        const res = await plainTextToXML({ text: initialText });

        text = res.text;
        xml = res.xml;
      } else {
        const initialXML = await data.text();
        logger.info('Calling XML to Plain Text');
        const res = await xmlToPlainText({ xml: initialXML });

        text = res.text;
        xml = res.xml;
      }

      logger.info('Calling NLP NER');
      const { ner } = await doStanfordNlp({
        data: text,
        language: payload.language,
        outputLanguage: payload.outputLanguage,
      });

      logger.info('NLP NER completed', { entityCount: ner.entries.length });

      const { tei } = await nerToXML({
        nerData: ner,
        text,
        originalXML: xml,
      });

      logger.info('NER output prepared', {
        textBytes: Buffer.byteLength(text, 'utf8'),
        teiBytes: Buffer.byteLength(tei, 'utf8'),
        entityCount: ner.entries.length,
      });

      const id = uuid.v4();

      logger.info('Upload to Recogito Studio');
      // Upload to Recogito Studio;
      const res = await uploadDocumentToRS({
        id: id,
        documentData: tei,
        name: `${payload.nameOut}.xml`,
        type: 'text/xml',
        projectId: payload.projectId,
        documentId: payload.documentId,
        key: payload.key,
        token: payload.token,
        supabaseURL: payload.serverURL,
        userId: payload.userId,
        language: payload.outputLanguage,
        successMessage: translations(payload.nameOut).success[
          payload.outputLanguage
        ],
        gotoMessage: translations(payload.nameOut).goto[
          payload.outputLanguage
        ],
      });

      if (!res) {
        throw new Error('Failed to upload document');
      }

      return {
        documentId: res.documentId,
        entityCount: ner.entries.length,
      };
    }
  },
  onFailure: async ({ payload, error }) => {
    // notify the user on failure
    logger.error('NER run failed', { error });

    try {
      const supabase = createClient(payload.serverURL, payload.key, {
        global: {
          headers: {
            Authorization: `Bearer ${payload.token}`,
          },
        },
      });

      const { error: notifyError } = await supabase
        .from('notifications')
        .insert({
          target_user_id: payload.userId,
          message: translations(payload.nameOut).failure[
            payload.outputLanguage
          ],
          action_url: `/${payload.outputLanguage}/projects/${payload.projectId}`,
          action_message: translations(payload.nameOut).goto[
            payload.outputLanguage
          ],
          message_type: 'ERROR',
        });

      if (notifyError) {
        logger.error('Failed to send failure notification', {
          message: notifyError.message,
        });
      }
    } catch (notifyException) {
      logger.error('Failed to send failure notification', {
        error: notifyException,
      });
    }
  },
});
