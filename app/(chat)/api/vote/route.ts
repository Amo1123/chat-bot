import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { NextResponse } from 'next/server'; // NextResponse をインポート

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error('Error creating resumable stream context:', error); // より詳細なログ
      }
      // エラーが発生した場合、globalStreamContext は null のままになる
      // この関数自体は Response を返さないが、呼び出し元で null をチェックする
    }
  }
  return globalStreamContext;
}

/**
 * POST リクエストを処理します (/api/chat)。
 * ユーザーメッセージを受け取り、AIからの応答をストリーミングで返します。
 * 認証、レート制限、チャットの保存、ツール呼び出しなどを管理します。
 *
 * @param request 受信した Next.js の Request オブジェクト。
 * @returns AIからのストリーミング応答、またはエラーレスポンス。
 */
export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  // リクエストボディのパースと検証
  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    console.error('Error parsing request body:', error); // エラーログを追加
    return new ChatSDKError('bad_request:api', 'Invalid request body.').toResponse();
  }

  // メインのロジックを try-catch で囲み、すべてのパスでレスポンスを保証
  try {
    const { id, message, selectedChatModel, selectedVisibilityType } =
      requestBody;

    // ユーザーセッションの認証
    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    // メッセージレート制限のチェック
    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });
    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    // チャットの取得または新規作成
    const chat = await getChatById({ id });
    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });
      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      // 既存チャットの場合、ユーザーが所有者であるかを確認
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    // 以前のメッセージと現在のユーザーメッセージを結合
    const previousMessages = await getMessagesByChatId({ id });
    const messages = appendClientMessage({
      // @ts-expect-error: todo add type conversion from DBMessage[] to UIMessage[]
      messages: previousMessages,
      message,
    });

    // ジオロケーション情報の取得
    const { longitude, latitude, city, country } = geolocation(request);
    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    // ユーザーメッセージの保存
    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: message.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    });

    // ストリームIDの生成と保存
    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // AIストリームの作成
    const stream = createDataStream({
      execute: (dataStream) => {
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages,
          maxSteps: 5,
          experimental_activeTools:
            selectedChatModel === 'chat-model-reasoning'
              ? []
              : [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                ],
          experimental_transform: smoothStream({ chunking: 'word' }),
          experimental_generateMessageId: generateUUID,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
          },
          onFinish: async ({ response }) => {
            if (session.user?.id) {
              try {
                const assistantId = getTrailingMessageId({
                  messages: response.messages.filter(
                    (msg) => msg.role === 'assistant', // msg に変更
                  ),
                });

                if (!assistantId) {
                  throw new Error('No assistant message found!');
                }

                const [, assistantMessage] = appendResponseMessages({
                  messages: [message],
                  responseMessages: response.messages,
                });

                await saveMessages({
                  messages: [
                    {
                      id: assistantId,
                      chatId: id,
                      role: assistantMessage.role,
                      parts: assistantMessage.parts,
                      attachments:
                        assistantMessage.experimental_attachments ?? [],
                      createdAt: new Date(),
                    },
                  ],
                });
              } catch (saveError) { // エラー変数を追加
                console.error('Failed to save assistant message:', saveError); // より詳細なログ
              }
            }
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();

        result.mergeIntoDataStream(dataStream, {
          sendReasoning: true,
        });
      },
      onError: (error) => { // エラーオブジェクトを受け取る
        console.error('DataStream error:', error); // エラーログを追加
        return 'Oops, an error occurred during streaming!'; // クライアントに返すメッセージ
      },
    });

    // ストリームコンテキストの取得とレスポンスの返却
    const streamContext = getStreamContext();
    let responseStreamToReturn: ReadableStream | null = null; // 返すストリームを初期化

    if (streamContext) {
      // resumableStream が Promise を返すので await する
      const resumableStreamResult = await streamContext.resumableStream(streamId, () => stream);
      if (resumableStreamResult) {
        responseStreamToReturn = resumableStreamResult;
      } else {
        // resumableStream が null を返した場合のフォールバック
        console.warn('resumableStream returned null, falling back to direct stream.');
        responseStreamToReturn = stream;
      }
    } else {
      // resumableStream が利用できない場合、通常のストリームを返す
      responseStreamToReturn = stream;
    }

    // 最終的に有効なストリームが生成されたことを確認して返す
    if (responseStreamToReturn) {
        return new Response(responseStreamToReturn);
    } else {
        // ここに到達した場合、ストリームの生成に致命的な問題が発生したことを意味する
        console.error('Critical error: No valid stream generated for response.');
        return new ChatSDKError('internal_server_error:api', 'Failed to generate a valid streaming response.').toResponse();
    }

  } catch (error) {
    // メインのロジックで発生したエラーをキャッチ
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    // 予期せぬエラーの場合、汎用的な内部サーバーエラーを返す
    console.error('Unhandled error in POST /api/chat:', error);
    return new ChatSDKError('internal_server_error:api', 'An unexpected error occurred.').toResponse();
  }
}

/**
 * GET リクエストを処理します (/api/chat)。
 * 既存のチャットストリームを再開するか、最新のメッセージを返します。
 *
 * @param request 受信した Next.js の Request オブジェクト。
 * @returns ストリームデータ、またはエラーレスポンス。
 */
export async function GET(request: Request) {
  try {
    const streamContext = getStreamContext();
    const resumeRequestedAt = new Date();

    if (!streamContext) {
      // streamContext が利用できない場合、204 No Content を返す
      return new Response(null, { status: 204 });
    }

    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get('chatId');

    // 必須パラメータの検証
    if (!chatId) {
      return new ChatSDKError('bad_request:api', 'Parameter chatId is required.').toResponse();
    }

    // ユーザーセッションの認証
    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    let chat: Chat | null; // chat が null になる可能性があるので型を修正

    // チャットの取得とエラーハンドリング
    try {
      chat = await getChatById({ id: chatId });
    } catch (error) { // エラーをキャッチ
      console.error('Error fetching chat by ID in GET /api/chat:', error);
      return new ChatSDKError('internal_server_error:api', 'Failed to retrieve chat.').toResponse();
    }

    // チャットの存在チェック
    if (!chat) {
      return new ChatSDKError('not_found:chat').toResponse();
    }

    // ユーザーの認可 (プライベートチャットの場合)
    if (chat.visibility === 'private' && chat.userId !== session.user.id) {
      return new ChatSDKError('forbidden:chat').toResponse();
    }

    // ストリームIDの取得
    const streamIds = await getStreamIdsByChatId({ chatId });
    if (!streamIds.length) {
      return new ChatSDKError('not_found:stream').toResponse();
    }

    const recentStreamId = streamIds.at(-1);
    if (!recentStreamId) {
      // streamIds.length が > 0 なのに recentStreamId がない場合はロジックエラーだが、念のため
      return new ChatSDKError('not_found:stream', 'No recent stream ID found.').toResponse();
    }

    // 空のデータストリームを作成 (フォールバック用)
    const emptyDataStream = createDataStream({
      execute: () => {},
      onError: (error) => {
        console.error('EmptyDataStream error:', error);
        return 'An error occurred in empty data stream.';
      }
    });

    // resumableStream を試行
    const stream = await streamContext.resumableStream(
      recentStreamId,
      () => emptyDataStream,
    );

    /*
     * For when the generation is streaming during SSR
     * but the resumable stream has concluded at this point.
     */
    if (!stream) {
      const messages = await getMessagesByChatId({ id: chatId });
      const mostRecentMessage = messages.at(-1);

      if (!mostRecentMessage) {
        return new Response(emptyDataStream, { status: 200 });
      }

      if (mostRecentMessage.role !== 'assistant') {
        return new Response(emptyDataStream, { status: 200 });
      }

      const messageCreatedAt = new Date(mostRecentMessage.createdAt);

      if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > 15) {
        return new Response(emptyDataStream, { status: 200 });
      }

      const restoredStream = createDataStream({
        execute: (buffer) => {
          buffer.writeData({
            type: 'append-message',
            message: JSON.stringify(mostRecentMessage),
          });
        },
        onError: (error) => { // エラーハンドラを追加
          console.error('RestoredStream error:', error);
          return 'An error occurred in restored stream.';
        }
      });

      return new Response(restoredStream, { status: 200 });
    }

    // ストリームが正常に取得できた場合
    return new Response(stream, { status: 200 });
  } catch (error) {
    // GET リクエスト処理中に予期せぬエラーが発生した場合
    console.error('Unhandled error in GET /api/chat:', error);
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError('internal_server_error:api', 'An unexpected error occurred.').toResponse();
  }
}

/**
 * DELETE リクエストを処理します (/api/chat)。
 * 特定のチャットを削除し、ユーザーがそのチャットの所有者であることを確認します。
 *
 * @param request 受信した Next.js の Request オブジェクト。
 * @returns 削除されたチャット情報を含む JSON レスポンス、またはエラーレスポンス。
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    // 必須パラメータの検証
    if (!id) {
      return new ChatSDKError('bad_request:api', 'Parameter id is required.').toResponse();
    }

    // ユーザーセッションの認証
    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    // チャットの取得と存在チェック
    const chat = await getChatById({ id });
    if (!chat) { // chat が null の可能性があるので追加
      return new ChatSDKError('not_found:chat', 'Chat not found.').toResponse();
    }

    // ユーザーの認可
    if (chat.userId !== session.user.id) {
      return new ChatSDKError('forbidden:chat').toResponse();
    }

    // チャットの削除
    const deletedChat = await deleteChatById({ id });

    // 削除されたチャット情報を JSON レスポンスとして返す
    return NextResponse.json(deletedChat, { status: 200 }); // NextResponse.json を使用して一貫性を保つ
  } catch (error) {
    // DELETE リクエスト処理中に予期せぬエラーが発生した場合
    console.error('Unhandled error in DELETE /api/chat:', error);
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    return new ChatSDKError('internal_server_error:api', 'An unexpected error occurred.').toResponse();
  }
}
