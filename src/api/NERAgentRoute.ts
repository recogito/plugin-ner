import type { APIRoute } from 'astro';
import { createServerSDK } from '@recogito/studio-sdk';
import { stanfordCore } from '../trigger/stanfordCore';
import { configure } from '@trigger.dev/sdk/v3';

const supabaseServerUrl =
  import.meta.env.SUPABASE_SERVERCLIENT_URL || import.meta.env.PUBLIC_SUPABASE;

const supabaseAPIKey = import.meta.env.PUBLIC_SUPABASE_API_KEY;

configure({
  secretKey:
    process?.env.TRIGGER_NER_SECRET_KEY || import.meta.env.TRIGGER_NER_SECRET_KEY,
  baseURL:
    process?.env.TRIGGER_SERVER_URL || import.meta.env.TRIGGER_SERVER_URL,
});

export const PUT: APIRoute = async ({ request, params, cookies }) => {
  const projectId = params.projectId;
  const documentId = params.documentId;

  const body = await request.json();

  const sdk = await createServerSDK(request, cookies, import.meta.env);

  const { error: profileError, data: profile } =
    await sdk.profile.getMyProfile();
  if (profileError || !profile)
    return new Response(JSON.stringify({ message: 'Not authorized' }));

  const hasSelectPermissions = await sdk.project.hasSelectPermissions(
    profile,
    projectId!
  );

  if (!hasSelectPermissions)
    return new Response(JSON.stringify({ message: 'Not authorized' }));

  let handle;
  if (body.model === 'stanford-core') {
    handle = await stanfordCore.trigger({
      projectId: projectId as string,
      documentId: documentId as string,
      language: body.language,
      token: body.token,
      key: supabaseAPIKey,
      serverURL: supabaseServerUrl,
      nameOut: body.nameOut,
      outputLanguage: body.outputLanguage,
      userId: profile.id,
    });
  }

  if (handle) {
    return new Response(
      JSON.stringify({
        message: `Job is running with handle: ${handle.id}`,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } else {
    return new Response(
      JSON.stringify({
        message: `Failed to execute job`,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
};
