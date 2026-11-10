import { createClient } from '@supabase/supabase-js';
import { logger } from '@trigger.dev/sdk/v3';
import * as tus from 'tus-js-client';

export const uploadDocumentToRS = async (
  payload: {
    id: string;
    documentData: string;
    name: string;
    type: string;
    projectId: string;
    documentId: string;
    key: string;
    token: string;
    supabaseURL: string;
    userId: string;
    language: string;
    successMessage: string;
    gotoMessage: string;
  }
) => {
    const {
      documentData,
      name,
      type,
      key,
      token,
      projectId,
      documentId,
      supabaseURL,
      userId,
      successMessage,
      gotoMessage,
      language,
    } = payload;

    const uploadFile = async (
      file: Buffer,
      name: string,
      type: string,
      onProgress: (progress: number) => void
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        // @ts-ignore
        const upload = new tus.Upload(file, {
          endpoint: `${supabaseURL}/storage/v1/upload/resumable`,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            authorization: `Bearer ${token}`,
            'x-upsert': 'true', // optionally set upsert to true to overwrite existing files
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true, // Important if you want to allow re-uploading the same file https://github.com/tus/tus-js-client/blob/main/docs/api.md#removefingerprintonsuccess
          metadata: {
            bucketName: 'documents',
            objectName: name,
            contentType: type,
            cacheControl: '3600',
          },
          chunkSize: 6 * 1024 * 1024, // NOTE: it must be set to 6MB (for now) do not change it
          onError: function (error: any) {
            logger.log('Failed because: ' + error);
            reject(error);
          },
          onProgress: function (bytesUploaded: number, bytesTotal: number) {
            onProgress((bytesUploaded / bytesTotal) * 100);
          },
          onSuccess: function () {
            resolve();
          },
        });

        // Check if there are any previous uploads to continue.
        return upload
          .findPreviousUploads()
          .then(function (previousUploads: any) {
            // Found previous uploads so we select the first one.
            if (previousUploads.length) {
              upload.resumeFromPreviousUpload(previousUploads[0]);
            }
            // Start the upload
            upload.start();
          });
      });
    };

    logger.info('Creating Supabase client');
    const supabase = createClient(supabaseURL, key, {
      global: {
        headers: {
          Authorization: `Bearer ${payload.token}`,
        },
      },
    });

    if (supabase) {
      logger.info('Getting document');
      const result = await supabase
        .from('documents')
        .insert({
          name: name,
          content_type: type,
          bucket_id: 'documents',
          meta_data: {},
        })
        .select()
        .single();

      if (result.error) {
        logger.error(
          `Failed to create Recogito Studio document: ${JSON.stringify(
            result.error,
            null,
            2
          )}`
        );
        return false;
      }

      const onProgress = (progress: number) => {
        logger.log(`Upload Progress: ${progress}%`);
      };

      const blob = new Blob([documentData], { type: type });
      const arrayBuffer = await blob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      logger.info('Uploading to RS');
      await uploadFile(buffer, result.data.id, type, onProgress);

      logger.info('Add document to project');
      let addResult = await supabase.rpc('add_documents_to_project_rpc', {
        _document_ids: [result.data.id],
        _project_id: projectId,
      });

      if (addResult.error) {
        logger.error(addResult.error.message);
        throw new Error(addResult.error.message);
      }

      logger.info('Sending notification');

      const notifyResp = await supabase
        .from('notifications')
        .insert({
          target_user_id: userId,
          message: successMessage,
          action_url: `/${language}/projects/${projectId}`,
          action_message: gotoMessage,
          message_type: 'INFO',
        })
        .select();

      if (notifyResp.error) {
        logger.error(notifyResp.error.message);
        throw new Error(notifyResp.error.message);
      }

      return { documentId: result.data.id as string };
    } else {
      logger.error('Failed to create Supabase client');
      throw new Error('Failed to create Supabase client');
    }
};
