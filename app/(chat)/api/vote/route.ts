import { auth } from '@/app/(auth)/auth';
import { getChatById, getVotesByChatId, voteMessage } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors'; // ChatSDKError が適切に Response オブジェクトを生成すると仮定
import { NextResponse } from 'next/server'; // Next.js App Router の標準的なレスポンスオブジェクトをインポート

/**
 * GET リクエストを処理します (/api/vote)。
 * 特定のチャットの投票情報を取得し、ユーザーが認証されており、そのチャットの所有者であることを確認します。
 *
 * @param request 受信した Next.js の Request オブジェクト。
 * @returns 投票情報を含む JSON レスポンス、またはエラーレスポンス。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get('chatId');

    // 1. 必須パラメータの検証
    if (!chatId) {
      // chatId がない場合、不正なリクエストエラーを返す。
      return new ChatSDKError(
        'bad_request:api',
        'Parameter chatId is required.',
      ).toResponse();
    }

    // 2. ユーザーセッションの認証
    const session = await auth();
    if (!session?.user) {
      // ユーザーが認証されていない場合、認証されていないエラーを返す。
      return new ChatSDKError('unauthorized:vote').toResponse();
    }

    // 3. チャットを取得し、その存在を検証
    const chat = await getChatById({ id: chatId });
    if (!chat) {
      // チャットが見つからない場合、見つからないエラーを返す。
      return new ChatSDKError('not_found:chat').toResponse();
    }

    // 4. ユーザーの認可 (認証されたユーザーがチャットの所有者であるかを確認)
    if (chat.userId !== session.user.id) {
      // ユーザーがチャットの所有者でない場合、アクセス禁止エラーを返す。
      return new ChatSDKError('forbidden:vote').toResponse();
    }

    // 5. 指定されたチャットの投票情報を取得
    const votes = await getVotesByChatId({ id: chatId });

    // 6. 投票情報を JSON レスポンスとして返す
    return NextResponse.json(votes, { status: 200 }); // NextResponse.json を使用して一貫性を保つ
  } catch (error) {
    // GET リクエスト処理中に予期せぬエラーが発生した場合をキャッチ。
    console.error('Error in GET /api/vote:', error);
    // 汎用的な内部サーバーエラーを返す。
    return new ChatSDKError('internal_server_error:api', 'An unexpected error occurred.').toResponse();
  }
}

/**
 * PATCH リクエストを処理します (/api/vote)。
 * 認証されたユーザーが、自分が所有するチャット内のメッセージを評価（アップボートまたはダウンボート）できるようにします。
 *
 * @param request 受信した Next.js の Request オブジェクト。
 * @returns 成功メッセージ、またはエラーレスポンス。
 */
export async function PATCH(request: Request) {
  try {
    // 1. リクエストボディから必須パラメータを解析
    const {
      chatId,
      messageId,
      type,
    }: { chatId: string; messageId: string; type: 'up' | 'down' } =
      await request.json();

    // 2. リクエストボディからの必須パラメータを検証
    if (!chatId || !messageId || !type) {
      // 必須パラメータのいずれかが不足している場合、不正なリクエストエラーを返す。
      return new ChatSDKError(
        'bad_request:api',
        'Parameters chatId, messageId, and type are required.',
      ).toResponse();
    }

    // 3. ユーザーセッションの認証
    const session = await auth();
    if (!session?.user) {
      // ユーザーが認証されていない場合、認証されていないエラーを返す。
      return new ChatSDKError('unauthorized:vote').toResponse();
    }

    // 4. チャットを取得し、その存在を検証
    const chat = await getChatById({ id: chatId });
    if (!chat) {
      // チャットが見つからない場合、見つからないエラーを返す。
      return new ChatSDKError('not_found:chat').toResponse(); // 'not_found:vote' から 'not_found:chat' に変更し、より明確に
    }

    // 5. ユーザーの認可 (認証されたユーザーがチャットの所有者であるかを確認)
    if (chat.userId !== session.user.id) {
      // ユーザーがチャットの所有者でない場合、アクセス禁止エラーを返す。
      return new ChatSDKError('forbidden:vote').toResponse();
    }

    // 6. 投票操作を実行
    await voteMessage({
      chatId,
      messageId,
      type: type,
    });

    // 7. 成功レスポンスを返す
    return new Response('Message voted successfully', { status: 200 }); // より分かりやすい成功メッセージ
  } catch (error) {
    // PATCH リクエスト処理中に予期せぬエラーが発生した場合をキャッチ。
    console.error('Error in PATCH /api/vote:', error);
    // 汎用的な内部サーバーエラーを返す。
    return new ChatSDKError('internal_server_error:api', 'An unexpected error occurred.').toResponse();
  }
}
